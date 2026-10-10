---
description: 分片直传、断点续传、秒传校验、STS 与预签名、上传后处理、对象存储选型
---

# 大文件上传

> 前置阅读：[对象存储](/architecture/4_object_storage)

大文件上传通常基于 S3 分片上传协议由浏览器直传对象存储，示例用 AWS SDK for Java 2.x，OSS、COS、Ceph RGW 等兼容 S3 的服务换 `endpointOverride` 即可对接。本篇讲并发分片、断点续传、安全秒传、最小权限凭证，以及上传后的校验与处理。

---

## 一、为什么要直传

| 问题 | 经应用服务器中转 | 浏览器直传对象存储 |
|------|----------------|------------------|
| 带宽与 IO | 文件先进应用再转存，流量和磁盘 IO 翻倍 | 应用只签名，数据不经过应用 |
| 超时与失败 | 单个大请求易超时，失败从头再传 | 分片独立重试，断点续传 |
| 并发 | 受限于应用实例数 | 浏览器多路并发，由对象存储承载 |
| 安全 | 要自己处理文件名、路径、磁盘配额 | 凭证限定前缀与有效期 |

推荐架构：**后端只负责建会话、签名、校验与落库，文件数据由浏览器直接传给对象存储**。

---

## 二、S3 分片上传协议

![分片直传对象存储流程](../assets/scenario/multipart-upload.svg)

| 步骤 | API | 说明 |
|------|-----|------|
| 创建 | `CreateMultipartUpload` | 返回 `uploadId`，后续所有分片都挂在它下面 |
| 上传分片 | `UploadPart` | 分片号 1 到 10000；每片 5 MiB 到 5 GiB，最后一片不限最小值 |
| 查询已传 | `ListParts` | 断点续传的依据，每次最多返回 1000 条，需要分页 |
| 合并 | `CompleteMultipartUpload` | 按分片号提交各片的 ETag，服务端拼成一个对象 |
| 放弃 | `AbortMultipartUpload` | 释放已上传的分片，否则它们一直占用存储并计费 |

未完成的分片上传不会自动清理，要给桶配一条生命周期规则 `AbortIncompleteMultipartUpload`（如发起后 7 天自动放弃），作为应用清理任务之外的兜底。

---

## 三、后端实现

### 1、接口约定

| 接口 | 请求 | 响应 |
|------|------|------|
| `POST /uploads` | `{sha256, size, fileName, contentType}` | `CHALLENGE`（可秒传，附挑战）或 `UPLOADING`（`uploadId`、`partSize`、`uploadedParts`） |
| `POST /uploads/instant` | `{challengeId, proof}` | `DONE`（文件信息）或 `UPLOADING`（证明失败，转普通上传） |
| `POST /uploads/{uploadId}/parts/{n}/url` | 无 | `{url}`：分片 n 的预签名 PUT 地址 |
| `POST /uploads/{uploadId}/complete` | 无 | `DONE`（文件信息） |

请求体统一用 JSON + `@RequestBody`，前后端字段名一致；`sha256` 用 `@Pattern("^[0-9a-f]{64}$")` 校验。

### 2、表结构

```sql
-- 上传会话：一次分片上传
CREATE TABLE upload_session (
    upload_id    VARCHAR(255) PRIMARY KEY,
    user_id      BIGINT       NOT NULL,
    sha256       CHAR(64)     NOT NULL,
    size         BIGINT       NOT NULL,
    file_name    VARCHAR(255) NOT NULL,          -- 只用于展示
    object_key   VARCHAR(512) NOT NULL,          -- 服务端生成
    part_size    BIGINT       NOT NULL,
    total_parts  INT          NOT NULL,
    status       VARCHAR(16)  NOT NULL,          -- UPLOADING / COMPLETING / DONE / ABORTED
    expires_at   DATETIME     NOT NULL,
    KEY idx_user_hash (user_id, sha256)
);

-- 物理对象：同内容只存一份
CREATE TABLE file_object (
    id          BIGINT PRIMARY KEY,
    sha256      CHAR(64)     NOT NULL,
    size        BIGINT       NOT NULL,
    object_key  VARCHAR(512) NOT NULL UNIQUE,
    status      VARCHAR(16)  NOT NULL,           -- PENDING_VERIFY / VERIFIED / MISMATCH
    created_at  DATETIME     NOT NULL,
    KEY idx_hash (sha256, size)
);

-- 用户文件：谁拥有哪个对象，秒传只新增这一行
CREATE TABLE user_file (
    id              BIGINT PRIMARY KEY,
    user_id         BIGINT       NOT NULL,
    file_object_id  BIGINT       NOT NULL,
    file_name       VARCHAR(255) NOT NULL,
    created_at      DATETIME     NOT NULL,
    KEY idx_user (user_id)
);
```

### 3、初始化、续传与签名

```java
@Service
@RequiredArgsConstructor
public class UploadService {

    private static final long MIB = 1L << 20;
    private static final long MIN_PART = 8 * MIB;

    private final S3Client s3;
    private final S3Presigner presigner;
    private final UploadSessionMapper sessionMapper;
    private final FileObjectMapper fileObjectMapper;
    private final ChallengeService challengeService;
    private final StorageProperties props;

    public InitUploadResponse init(long userId, InitUploadRequest req) {
        FileObject same = fileObjectMapper.findVerified(req.sha256(), req.size());
        if (same != null) {                                   // 可能秒传：先要求证明持有文件
            return InitUploadResponse.challenge(challengeService.issue(userId, same, req.fileName()));
        }
        UploadSession s = sessionMapper.findActive(userId, req.sha256(), req.size());
        if (s == null) {
            s = create(userId, req);
        }
        return InitUploadResponse.uploading(s.getUploadId(), s.getPartSize(), uploadedParts(s));
    }

    private UploadSession create(long userId, InitUploadRequest req) {
        long partSize = Math.max(MIN_PART, ceilDiv(ceilDiv(req.size(), 10_000), MIB) * MIB);   // 保证不超过 10000 片
        String key = "uploads/%d/%s".formatted(userId, UUID.randomUUID());                    // 不使用客户端文件名
        String uploadId = s3.createMultipartUpload(b -> b.bucket(props.bucket()).key(key)
                .contentType(req.contentType())).uploadId();
        UploadSession s = UploadSession.newSession(uploadId, userId, req, key, partSize,
                (int) ceilDiv(req.size(), partSize), LocalDateTime.now().plusDays(3));
        sessionMapper.insert(s);
        return s;
    }

    private List<Integer> uploadedParts(UploadSession s) {
        return s3.listPartsPaginator(b -> b.bucket(props.bucket()).key(s.getObjectKey()).uploadId(s.getUploadId()))
                .parts().stream().map(Part::partNumber).toList();
    }

    public String presignPart(long userId, String uploadId, int partNumber) {
        UploadSession s = sessionMapper.findOwned(uploadId, userId);           // 只能给自己的会话签名
        if (s == null || !"UPLOADING".equals(s.getStatus())
                || partNumber < 1 || partNumber > s.getTotalParts()) {
            throw new BizException("非法的上传请求");
        }
        return presigner.presignUploadPart(p -> p
                        .signatureDuration(Duration.ofMinutes(15))
                        .uploadPartRequest(u -> u.bucket(props.bucket()).key(s.getObjectKey())
                                .uploadId(uploadId).partNumber(partNumber)))
                .url().toString();
    }

    private static long ceilDiv(long a, long b) {
        return (a + b - 1) / b;
    }
}
```

- **续传的事实来源是对象存储的 `ListParts`**，不是另存一份 Redis 集合：分片是否真的上传成功，只有对象存储说了算
- 每片在上传前单独签名，签名有效期短；对象键前缀固定在 `uploads/{userId}/` 下
- 浏览器 PUT 到对象存储需要在桶上配置 CORS，允许站点域名的 `PUT`

### 4、合并

```java
public FileVO complete(long userId, String uploadId) {
    UploadSession s = sessionMapper.findOwned(uploadId, userId);
    if (s == null) throw new BizException("上传会话不存在");
    if (sessionMapper.casStatus(uploadId, "UPLOADING", "COMPLETING") == 0) {
        return fileService.resultOf(s);                       // 重复或并发调用：返回已有结果或「处理中」
    }
    try {
        List<Part> parts = s3.listPartsPaginator(b -> b.bucket(props.bucket())
                .key(s.getObjectKey()).uploadId(uploadId)).parts().stream().toList();
        long total = parts.stream().mapToLong(Part::size).sum();
        if (parts.size() != s.getTotalParts() || total != s.getSize()) {
            throw new BizException("分片不完整");
        }
        s3.completeMultipartUpload(b -> b.bucket(props.bucket()).key(s.getObjectKey()).uploadId(uploadId)
                .multipartUpload(m -> m.parts(parts.stream()
                        .map(p -> CompletedPart.builder().partNumber(p.partNumber()).eTag(p.eTag()).build())
                        .toList())));
    } catch (RuntimeException e) {
        sessionMapper.casStatus(uploadId, "COMPLETING", "UPLOADING");   // 允许客户端补传后重试
        throw e;
    }
    // 本地事务：file_object(PENDING_VERIFY) + user_file + 会话置 DONE + 本地消息「文件已上传」
    return fileService.onUploaded(s);
}
```

ETag 由服务端通过 `ListParts` 获取，不依赖客户端上报，也就不需要在 CORS 中暴露 `ETag` 头。过期仍未完成的会话由定时任务调用 `AbortMultipartUpload` 并置为 `ABORTED`。

---

## 四、前端：哈希与并发

### 1、在 Worker 中计算指纹

整文件哈希放在主线程会卡住页面。在 Web Worker 中分块增量计算 SHA-256（示例用 `hash-wasm` 库）：

```javascript
// hash.worker.js
import { createSHA256 } from 'hash-wasm';

self.onmessage = async ({ data: file }) => {
  const hasher = await createSHA256();
  hasher.init();
  const STEP = 8 * 1024 * 1024;
  for (let pos = 0; pos < file.size; pos += STEP) {
    hasher.update(new Uint8Array(await file.slice(pos, pos + STEP).arrayBuffer()));
  }
  self.postMessage(hasher.digest('hex'));
};
```

### 2、并发池与续传

`axios.post(...)` 一调用请求就发出去了，把 Promise 放进数组再 `Promise.all(tasks.slice(0, 5))` 既不能限流，也不会等待剩余分片。正确做法是固定数量的「工人」循环领取任务：

```javascript
const api = { post: (url, body) => axios.post(url, body).then(r => r.data) };   // 响应体在 r.data

async function upload(file) {
  const sha256 = await hashInWorker(file);
  let s = await api.post('/uploads', { sha256, size: file.size, fileName: file.name, contentType: file.type });

  if (s.status === 'CHALLENGE') {                         // 服务端已有同内容文件，证明自己持有它
    const { challengeId, offset, length } = s.challenge;
    const buf = await file.slice(offset, offset + length).arrayBuffer();
    s = await api.post('/uploads/instant', { challengeId, proof: await sha256Hex(buf) });
    if (s.status === 'DONE') return s.file;               // 秒传成功
  }

  const { uploadId, partSize } = s;
  const done = new Set(s.uploadedParts);                  // 断点续传：跳过已上传的分片
  const total = Math.ceil(file.size / partSize);
  const todo = [];
  for (let n = 1; n <= total; n++) if (!done.has(n)) todo.push(n);

  await runPool(todo, 4, async (n) => {
    const blob = file.slice((n - 1) * partSize, n * partSize);
    await retry(3, async () => {
      const { url } = await api.post(`/uploads/${uploadId}/parts/${n}/url`);
      const resp = await fetch(url, { method: 'PUT', body: blob });
      if (!resp.ok) throw new Error(`分片 ${n} 上传失败：${resp.status}`);
    });
  });

  return (await api.post(`/uploads/${uploadId}/complete`)).file;   // 所有分片都已完成才合并
}

async function runPool(items, limit, worker) {
  let next = 0;
  const loop = async () => {
    while (next < items.length) {
      const item = items[next++];                          // 单线程事件循环，自增不会竞争
      await worker(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, loop));
}

async function retry(times, fn) {
  for (let i = 1; ; i++) {
    try { return await fn(); } catch (e) {
      if (i >= times) throw e;
      await new Promise(r => setTimeout(r, 500 * 2 ** i));
    }
  }
}

async function sha256Hex(buf) {
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}
```

---

## 五、秒传：不能只信客户端的哈希

只凭客户端报上来的 MD5 就返回已有文件，等于**知道哈希就能拿到别人的文件**；MD5 还存在碰撞构造。安全的做法：

- **指纹用 SHA-256**，并与文件大小一起匹配
- **服务端复核**：分片上传完成后由后台任务流式读取对象、重算 SHA-256，一致才把 `file_object` 标为 `VERIFIED`；只有 `VERIFIED` 的对象参与秒传，客户端谎报的哈希不会污染去重
- **持有证明**：命中秒传时，服务端随机选一个区间（如 64 KiB），要求客户端回传该区间的 SHA-256，与对象存储中同一区间比对。挑战一次性使用、5 分钟过期，并对接口限流
- **按用户建引用**：秒传成功只新增一条 `user_file`，访问时按 `user_file` 鉴权，绝不直接返回对象 URL

```java
public InstantResult prove(long userId, String challengeId, String proofHex) {
    Challenge c = challengeService.take(challengeId, userId);    // GETDEL：一次性，过期返回 null
    if (c == null) throw new BizException("挑战已失效");

    byte[] range = s3.getObjectAsBytes(b -> b.bucket(props.bucket()).key(c.objectKey())
            .range("bytes=%d-%d".formatted(c.offset(), c.offset() + c.length() - 1))).asByteArray();
    byte[] expected = Sha256.of(range);
    if (!MessageDigest.isEqual(expected, HexFormat.of().parseHex(proofHex))) {
        return InstantResult.uploading(uploadService.startNormal(userId, c.request()));   // 证明失败，走普通上传
    }
    return InstantResult.done(fileService.link(userId, c.fileObjectId(), c.fileName()));
}
```

---

## 六、临时凭证：预签名 URL 与 STS

| 方式 | 交给浏览器的是 | 适用 |
|------|--------------|------|
| 预签名 URL（推荐） | 某个对象、某个操作、短时间有效的 URL | 本篇的分片直传、下载私有文件 |
| PostObject 签名策略 | 带条件（前缀、大小上限、类型）的表单签名 | 小文件表单直传 |
| STS 临时凭证 | 一组临时 AK / SK / Token | 客户端需要直接调用 SDK（如移动端 SDK 的断点续传） |

预签名 URL 不暴露任何密钥，粒度最细。必须下发 STS 凭证时，**一定要附带会话策略**把权限收窄到该用户的前缀，否则临时凭证拥有角色的全部权限。阿里云官方文档中的写法（`aliyun-java-sdk-core`，请求对象的 setter 返回 `void`，不能链式调用）：

```java
public AssumeRoleResponse.Credentials issueUploadToken(long userId) throws ClientException {
    DefaultProfile.addEndpoint("", "Sts", "sts.cn-hangzhou.aliyuncs.com");
    IClientProfile profile = DefaultProfile.getProfile("",
            System.getenv("ALIBABA_CLOUD_ACCESS_KEY_ID"), System.getenv("ALIBABA_CLOUD_ACCESS_KEY_SECRET"));
    DefaultAcsClient client = new DefaultAcsClient(profile);

    String policy = """
            {"Version":"1","Statement":[{"Effect":"Allow",
              "Action":["oss:PutObject","oss:ListParts","oss:AbortMultipartUpload"],
              "Resource":["acs:oss:*:*:%s/uploads/%d/*"]}]}""".formatted(bucket, userId);

    AssumeRoleRequest request = new AssumeRoleRequest();
    request.setSysMethod(MethodType.POST);
    request.setRoleArn(roleArn);
    request.setRoleSessionName("upload-" + userId);
    request.setPolicy(policy);                 // 最终权限 = 角色权限 ∩ 会话策略
    request.setDurationSeconds(900L);          // 最短 900 秒
    return client.getAcsResponse(request).getCredentials();
}
```

调用 STS 的 AccessKey 要属于只有 `AssumeRole` 权限的 RAM 用户，不要用主账号 AccessKey。

---

## 七、必须经应用服务器中转时

内网、私有化等场景不能直传时，应用自己接收分片，同样要守住几条：

```java
private static final Pattern SHA256_HEX = Pattern.compile("^[0-9a-f]{64}$");
private final Path tmpRoot = Path.of("/data/upload-tmp").toAbsolutePath().normalize();

Path chunkPath(String sha256, int index, int totalParts) {
    if (!SHA256_HEX.matcher(sha256).matches() || index < 0 || index >= totalParts) {
        throw new BizException("参数非法");
    }
    Path p = tmpRoot.resolve(sha256).resolve(Integer.toString(index)).normalize();
    if (!p.startsWith(tmpRoot)) {                         // 防 ../ 路径穿越
        throw new BizException("参数非法");
    }
    return p;
}
```

- **不用客户端文件名拼路径**：最终文件名由服务端生成（UUID），原始文件名只存数据库用于展示，下载时放进 `Content-Disposition` 并按 RFC 6266 编码
- **合并前检查**：分片数量齐全、总大小一致；合并用会话状态 CAS 防止并发合并；合并后重算 SHA-256，不一致则作废
- **清理**：临时分片目录与会话都要有过期时间，定时任务清理未完成的上传

---

## 八、上传后处理

「文件已上传」事件来自合并成功时写入的本地消息（也可以用对象存储的事件通知，如 S3 Event Notifications、OSS 事件通知），经 MQ 投递给处理服务：

- **校验**：流式读取对象重算 SHA-256，一致标记 `VERIFIED`，不一致标记 `MISMATCH` 并告警
- **缩略图**：从对象存储读取原图生成多个尺寸，写到确定性的键（如 `thumb/{fileObjectId}/300.webp`），重复消费只是覆盖，天然幂等；处理前检查像素尺寸上限，防止解压炸弹
- **内容审核**：图片、文档送审核服务，结果回写文件状态

图片场景也可以不预生成，直接用云厂商的 URL 参数实时处理，再由 CDN 缓存：

```text
https://cdn.example.com/images/photo.jpg?x-oss-process=image/resize,w_300
https://cdn.example.com/images/photo.jpg?x-oss-process=image/crop,w_200,h_200
```

---

## 九、对象存储选型

- **持久性与可用性是两回事**：Amazon S3 的设计持久性为 99.999999999%（11 个 9），指数据不丢；可用性 SLA 另行约定，指能不能访问。各云厂商的数字以其官方文档为准
- **公有云**：S3、阿里云 OSS、腾讯云 COS 等，配合 CDN 与生命周期规则（转低频、归档、过期删除）
- **私有化**：MinIO 曾是最常见的选择，但现状已变：许可证为 AGPLv3，社区版先后移除了管理控制台、停止提供预编译二进制和镜像，GitHub 仓库已于 2026 年 4 月归档并声明不再维护，官方引导到商业产品 AIStor。新项目应评估 Ceph RGW、SeaweedFS、Garage 等替代方案，或继续使用 MinIO 时自行承担源码构建与安全更新
- **应用代码不绑定厂商**：用 AWS SDK for Java 2.x 的 S3 接口，通过 `endpointOverride` 切换后端

---

## 小结

- 浏览器直传对象存储，后端只建会话、签名、校验、落库
- 分片上传遵循 S3 协议：5 MiB 到 5 GiB 每片、最多 10000 片；续传以 `ListParts` 为准；桶上配置清理未完成上传的生命周期规则
- 前端在 Worker 里算 SHA-256，用固定数量的工人循环控制并发，全部完成后才合并
- 合并由服务端 `ListParts` 校验片数与大小，会话状态 CAS 防并发
- 秒传要求服务端复核哈希 + 区间持有证明，只新增用户引用
- 优先用预签名 URL；必须用 STS 时附带会话策略限定前缀
- 中转上传时校验参数、规范化路径、不用客户端文件名
- MinIO 社区版已停止维护，私有化存储要重新评估
- 对象存储的概念、存储类型与 SDK 基本用法见 [对象存储](/architecture/4_object_storage)，本篇只讲了上传这条链路。

## 参考资料

- S3 分片上传概述：[https://docs.aws.amazon.com/AmazonS3/latest/userguide/mpuoverview.html](https://docs.aws.amazon.com/AmazonS3/latest/userguide/mpuoverview.html)
- S3 分片上传限制：[https://docs.aws.amazon.com/AmazonS3/latest/userguide/qfacts.html](https://docs.aws.amazon.com/AmazonS3/latest/userguide/qfacts.html)
- 用生命周期规则清理未完成的分片上传：[https://docs.aws.amazon.com/AmazonS3/latest/userguide/mpu-abort-incomplete-mpu-lifecycle-config.html](https://docs.aws.amazon.com/AmazonS3/latest/userguide/mpu-abort-incomplete-mpu-lifecycle-config.html)
- S3 预签名 URL：[https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-presigned-url.html](https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-presigned-url.html)
- AWS SDK for Java 2.x 预签名示例：[https://docs.aws.amazon.com/sdk-for-java/latest/developer-guide/examples-s3-presign.html](https://docs.aws.amazon.com/sdk-for-java/latest/developer-guide/examples-s3-presign.html)
- S3 数据持久性：[https://docs.aws.amazon.com/AmazonS3/latest/userguide/DataDurability.html](https://docs.aws.amazon.com/AmazonS3/latest/userguide/DataDurability.html)
- 阿里云 OSS 使用 STS 临时凭证：[https://help.aliyun.com/zh/oss/developer-reference/use-temporary-access-credentials-provided-by-sts-to-access-oss](https://help.aliyun.com/zh/oss/developer-reference/use-temporary-access-credentials-provided-by-sts-to-access-oss)
- MinIO 仓库（维护状态说明）：[https://github.com/minio/minio](https://github.com/minio/minio)

> 下一篇：[抢红包](./11_red_packet) —— 金额预分配、Lua 原子抢、可靠入账与过期退款。
