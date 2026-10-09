---
description: 对象模型与一致性、块 / 文件 / 对象对比、存储类别与生命周期、安全、预签名直传、MinIO 现状与替代
---

# 对象存储

> **本篇目标**：讲清对象存储的数据模型与一致性语义，知道它和块存储、文件存储的边界；能设计「预签名 URL 直传 + 元数据入库」的接入方案，用 AWS SDK for Java v2 对接 S3 兼容存储，并了解 MinIO 社区版的现状与自建替代方案。
>
> **前置阅读**：[数据安全](/security/7_data_security)（加密与密钥管理部分，可选）

对象存储是图片、视频、附件、备份、日志归档、数据湖的默认落点。业务侧最常见的问题不是「怎么调 API」，而是文件流量压在应用服务上、对象权限误设为公开、存储费用和外网流量失控。上传业务流程（分片、断点续传、秒传）见 [大文件上传 & 对象存储](/scenario/10_file_upload)，本篇讲对象存储本身。

---

## 一、对象存储是什么

### 1、数据模型

| 概念 | 说明 |
|------|------|
| **Bucket** | 对象的容器，权限、生命周期、版本控制、加密等策略都以 Bucket 为单位配置 |
| **Object** | 一个对象 = key + 数据 + 元数据；**一个文件上传后就是一个对象** |
| **Key** | Bucket 内唯一的对象名，命名空间是扁平的：`avatar/2026/10/a.png` 里的「目录」只是前缀，按前缀加分隔符 `/` 列举时才呈现出目录效果 |
| **元数据** | 系统元数据（大小、ETag、Content-Type、最后修改时间）与用户自定义元数据（`x-amz-meta-*`） |
| **版本** | 开启版本控制后，同一 key 的每次覆盖与删除都会保留历史版本 |

几条与文件系统不同的核心语义：

- **对象不可原地修改**：没有「改第 100 字节」或追加写这类操作（个别厂商有追加写扩展），修改就是用同一个 key 整体重新上传（覆盖）
- **重命名不是元数据操作**：「移动 / 改名」等于复制成新 key 再删除旧 key，大目录重命名代价很高
- **通过 HTTP API 访问**：`PUT` / `GET` / `DELETE` / `HEAD` / `LIST`，按请求次数计费，单次请求延迟在毫秒到数十毫秒级

### 2、服务端如何存储

用户看到的是一个完整对象；服务端内部把对象数据用**多副本或纠删码**切成数据块，分布到多块盘、多个节点甚至多个可用区，元数据由独立的索引服务管理。这是服务端的冗余机制，和客户端的**分片上传（Multipart Upload）**是两回事：分片上传只是把一次大上传拆成多次请求，完成后服务端仍然合成为一个对象。

### 3、一致性

Amazon S3 从 2020 年 12 月起对所有对象的 PUT / DELETE 提供**强读后写一致性**：写入成功后，随后的 GET、LIST 都能读到最新结果。Bucket 级配置（如策略、生命周期）的变更仍可能有传播延迟。其他云厂商和自建实现的一致性语义不一定相同，依赖「写完立刻列举」的逻辑要先核对对应文档。

---

## 二、块存储、文件存储与对象存储

区别在于访问接口和修改粒度，与数据是否「结构化」无关：

| 维度 | 块存储 | 文件存储 | 对象存储 |
|------|------|------|------|
| 访问接口 | 块设备（LUN / 云盘），由操作系统挂载 | POSIX 文件系统（NFS / SMB） | HTTP API（S3 协议） |
| 修改粒度 | 任意块随机读写 | 文件内随机读写 | 整个对象覆盖 |
| 元数据 | 无，由上层文件系统管理 | 目录树、权限位 | 扁平 key + 自定义元数据 |
| 共享方式 | 通常一次挂载到一台主机 | 多台主机共享目录 | 任意客户端通过网络访问 |
| 扩展性 | 单卷容量有上限 | 中等，目录层级与元数据易成瓶颈 | 近乎无限，按量付费 |
| 典型用途 | 数据库数据盘、系统盘 | 共享目录、传统应用迁移 | 图片视频、附件、备份、数据湖 |

数据库这类需要随机写和 fsync 的负载放块存储；需要多台主机按文件路径共享读写的放文件存储；一次写入、多次读取、按 URL 分发的内容放对象存储。

---

## 三、核心能力

### 1、存储类别与生命周期

| 类别 | 特点 | 注意 |
|------|------|------|
| 标准 | 毫秒级访问，单价最高 | 热数据、频繁访问的内容 |
| 低频访问 | 存储单价低，读取按量收取回费用 | 通常有最低存储时长与最小计费对象大小 |
| 归档 / 深度归档 | 存储单价最低 | 读取前要先**解冻**，耗时从分钟到数十小时；有最低存储时长 |

生命周期规则按前缀或标签自动执行：N 天后转低频、M 天后转归档、到期删除；同时应配置**清理未完成的分片上传**，否则失败的分片会一直计费。数据冷热分层的整体策略见 [数据冷热分离](./1_cold_hot_data)。

### 2、版本控制、对象锁与复制

- **版本控制**：防误删、误覆盖，删除只是写入删除标记；配合生命周期清理非当前版本，否则费用持续增长
- **对象锁（WORM）**：在保留期内禁止删除和覆盖，用于合规留存、防勒索的备份
- **跨区域复制**：异步复制到另一区域，用于容灾和就近访问，是最终一致的
- **事件通知**：对象创建、删除时投递到 MQ / 函数计算 / Webhook，用来触发缩略图、转码、上传完成回调

### 3、安全

| 层面 | 做法 |
|------|------|
| 访问控制 | Bucket 默认私有并开启「阻止公共访问」；应用用最小权限的 IAM / RAM 身份，只授予指定 Bucket 和前缀 |
| 临时授权 | 预签名 URL 或 STS 临时凭证，不把长期 AccessKey 下发给客户端 |
| 加密 | 传输层强制 HTTPS；服务端加密 SSE-S3（平台托管密钥）或 SSE-KMS（可审计、可轮换的 KMS 密钥） |
| 防盗链 | 私有对象用短时效签名 URL；公开资源走 CDN，配置 Referer 白名单与 URL 鉴权 |
| 审计 | 开启访问日志或云审计，记录谁在何时访问了哪个对象 |
| 上传内容 | 服务端生成 key，不使用用户文件名；扩展名白名单、大小上限，不信任客户端声明的 Content-Type；图片视频按需做内容审核 |

上传类漏洞（任意文件上传、存储型 XSS）的防护见 [常见漏洞与防护](/security/8_vulnerabilities)。

### 4、费用构成

账单通常由五部分组成：**存储容量**、**请求次数**（PUT 比 GET 贵）、**外网流出流量**、**低频与归档的取回费用**、**提前删除产生的最低存储时长费用**。实际项目里外网流量往往是大头：面向用户的下载应走 CDN 回源，小文件大量 LIST / HEAD 也会累积出可观的请求费。

---

## 四、客户端直传：预签名 URL

文件经过应用服务中转，会占满应用的带宽和内存，上传慢、扩容贵。推荐让客户端直接把文件传到对象存储，业务服务只负责**鉴权、签发凭证和记录元数据**：

![预签名 URL 直传流程](../assets/architecture/oss-presigned-upload.svg)

1. 客户端带文件名、大小、类型请求业务服务；业务服务鉴权、校验类型与大小，生成 objectKey，签发预签名 PUT URL
2. 客户端用该 URL 直接 `PUT` 到对象存储，文件流量不经过业务服务
3. 对象存储通过事件通知（或客户端回调）告知业务服务上传完成；业务服务 `HEAD` 一次核对大小与类型后，把文件记录状态改为「已上传」

设计要点：

- **有效期**：SigV4 预签名 URL 最长 7 天，上传 URL 建议 5～15 分钟，下载分享按场景设定为分钟级到小时级
- **限制内容**：预签名 PUT 可以把 Content-Type 签入签名；需要限制文件大小区间时用 POST Policy（`content-length-range`）或带策略的 STS 临时凭证
- **大文件**：服务端调用 `CreateMultipartUpload`，为每个分片签发 `UploadPart` 的预签名 URL，客户端并发上传后由服务端 `CompleteMultipartUpload`；断点续传与秒传的业务设计见 [大文件上传 & 对象存储](/scenario/10_file_upload)
- **孤儿对象**：签发了 URL 但从未确认的上传，先放在 `tmp/` 前缀下，确认后再登记为正式文件，`tmp/` 由生命周期规则定期删除

---

## 五、Java 接入：AWS SDK for Java v2

S3 协议是事实标准，AWS S3、阿里云 OSS、腾讯云 COS、Ceph RGW、SeaweedFS 等都提供 S3 兼容接口，用 AWS SDK for Java v2 可以一套代码对接。兼容不等于完全一致：寻址风格（虚拟主机 / 路径）、region 写法和部分高级 API 各家有差异，接入前对照厂商的兼容性文档；需要厂商特有能力（如图片处理、厂商 STS）时再引入官方 SDK。

```xml
<dependencyManagement>
    <dependencies>
        <dependency>
            <groupId>software.amazon.awssdk</groupId>
            <artifactId>bom</artifactId>
            <version>2.55.13</version>  <!-- 以 Maven Central 最新 2.x 为准 -->
            <type>pom</type>
            <scope>import</scope>
        </dependency>
    </dependencies>
</dependencyManagement>

<dependencies>
    <dependency>
        <groupId>software.amazon.awssdk</groupId>
        <artifactId>s3</artifactId>
    </dependency>
</dependencies>
```

```yaml
storage:
  endpoint: https://s3.example.internal   # 云厂商或自建服务的 S3 接入点
  region: us-east-1                       # 自建服务通常可填任意合法 region
  bucket: app-files
  path-style: true                        # 自建服务多数要求路径风格；云厂商一般用虚拟主机风格（false）
  access-key: ${STORAGE_ACCESS_KEY}       # 从环境变量或密钥管理注入，不写进代码仓库
  secret-key: ${STORAGE_SECRET_KEY}
```

```java
@ConfigurationProperties("storage")
public record StorageProperties(String endpoint, String region, String bucket,
                                boolean pathStyle, String accessKey, String secretKey) {
}

@Configuration
@EnableConfigurationProperties(StorageProperties.class)
public class StorageConfig {

    @Bean
    S3Client s3Client(StorageProperties p) {
        return S3Client.builder()
                .endpointOverride(URI.create(p.endpoint()))
                .region(Region.of(p.region()))
                .credentialsProvider(credentials(p))
                .forcePathStyle(p.pathStyle())
                .build();
    }

    @Bean
    S3Presigner s3Presigner(StorageProperties p) {
        return S3Presigner.builder()
                .endpointOverride(URI.create(p.endpoint()))
                .region(Region.of(p.region()))
                .credentialsProvider(credentials(p))
                .serviceConfiguration(S3Configuration.builder()
                        .pathStyleAccessEnabled(p.pathStyle())
                        .build())
                .build();
    }

    private static AwsCredentialsProvider credentials(StorageProperties p) {
        return StaticCredentialsProvider.create(
                AwsBasicCredentials.create(p.accessKey(), p.secretKey()));
    }
}
```

```java
@Service
public class FileStorageService {
    private static final Set<String> ALLOWED_EXT = Set.of("jpg", "jpeg", "png", "webp", "pdf");
    private static final DateTimeFormatter DAY = DateTimeFormatter.ofPattern("yyyy/MM/dd");

    private final S3Client s3;
    private final S3Presigner presigner;
    private final String bucket;

    public FileStorageService(S3Client s3, S3Presigner presigner, StorageProperties p) {
        this.s3 = s3;
        this.presigner = presigner;
        this.bucket = p.bucket();
    }

    /** 签发上传 URL：key 由服务端生成，扩展名走白名单 */
    public PresignedUpload presignUpload(String bizType, String fileName, String contentType) {
        String ext = extensionOf(fileName);
        if (!ALLOWED_EXT.contains(ext)) {
            throw new IllegalArgumentException("不支持的文件类型: " + ext);
        }
        String key = "tmp/%s/%s/%s.%s".formatted(bizType, LocalDate.now().format(DAY), UUID.randomUUID(), ext);
        PresignedPutObjectRequest req = presigner.presignPutObject(r -> r
                .signatureDuration(Duration.ofMinutes(10))
                .putObjectRequest(o -> o.bucket(bucket).key(key).contentType(contentType)));
        return new PresignedUpload(key, req.url().toString());
    }

    /** 上传完成后核对对象确实存在、大小在限制内 */
    public long verifyUploaded(String key, long maxBytes) {
        HeadObjectResponse head = s3.headObject(r -> r.bucket(bucket).key(key));
        if (head.contentLength() > maxBytes) {
            s3.deleteObject(r -> r.bucket(bucket).key(key));
            throw new IllegalArgumentException("文件超过大小限制");
        }
        return head.contentLength();
    }

    /** 私有对象的临时下载链接 */
    public String presignDownload(String key, Duration ttl) {
        return presigner.presignGetObject(r -> r
                        .signatureDuration(ttl)
                        .getObjectRequest(o -> o.bucket(bucket).key(key)))
                .url().toString();
    }

    /** 服务端生成的小文件（如导出报表）直接上传 */
    public void putSmallFile(String key, byte[] content, String contentType) {
        s3.putObject(r -> r.bucket(bucket).key(key).contentType(contentType),
                RequestBody.fromBytes(content));
    }

    private static String extensionOf(String fileName) {
        int dot = fileName == null ? -1 : fileName.lastIndexOf('.');
        return dot < 0 ? "" : fileName.substring(dot + 1).toLowerCase(Locale.ROOT);
    }

    public record PresignedUpload(String key, String url) {
    }
}
```

- `S3Client`、`S3Presigner` 线程安全，作为单例 Bean 复用；`S3Presigner` 实现了 `AutoCloseable`，交给 Spring 管理生命周期即可
- 服务端上传大文件用 S3 Transfer Manager（`s3-transfer-manager` 模块），它会自动分片并发上传
- 生产环境优先用实例角色、IRSA、工作负载身份等免密钥方式；必须用 AccessKey 时从密钥管理系统注入，并只授予该 Bucket 的最小权限

---

## 六、自建选型与 MinIO 现状

MinIO 曾是自建 S3 兼容存储的默认选择，但社区版的状态在 2021—2026 年间发生了很大变化：

| 时间 | 变化 |
|------|------|
| 2021 年 | 许可从 Apache 2.0 改为 **AGPLv3** |
| 2025 年 5 月 | 社区版 Web 控制台移除管理功能，只保留对象浏览，管理改用 `mc` 命令行 |
| 2025 年 10 月 | 社区版停止发布预编译二进制与 Docker 镜像，只提供源码 |
| 2025 年 12 月 | 社区版进入维护模式，不再接受新特性 |
| 2026 年 | GitHub 仓库 `minio/minio` 标注「不再维护」并归档为只读；官方引导到商业产品 AIStor（Free 单机版 / Enterprise 分布式版） |

对既有部署的影响：已运行的实例可以继续用，但不会再有新版本与可依赖的安全修复，暴露在公网的实例风险最高；AGPLv3 对「修改后通过网络提供服务」有开源义务，私有化交付前要做许可合规评估。新项目不建议再以 MinIO 社区版为基础，存量项目应规划迁移。

| 方案 | 许可 | 特点 | 适合 |
|------|------|------|------|
| 公有云对象存储（S3 / OSS / COS 等） | 商业服务 | 免运维、多可用区冗余、生态完整 | 绝大多数业务的首选 |
| Ceph RGW | LGPL | 成熟的分布式存储，块 / 文件 / 对象统一，运维复杂度高 | 有专职存储团队的大规模私有云 |
| SeaweedFS | Apache 2.0 | 海量小文件友好，提供 S3 网关，部署较轻 | 中小规模自建、图片与附件存储 |
| Garage | AGPLv3 | 轻量，面向跨地域的小集群，S3 API 覆盖常用子集 | 边缘、多站点的小型部署 |
| RustFS | Apache 2.0 | 较新的 S3 兼容实现，定位接替 MinIO | 可评估，上生产前需充分验证成熟度 |

许可与功能以各项目仓库的当前说明为准。不论选哪种，业务代码只依赖 S3 协议（第五节的写法），后续更换存储只需改接入配置并迁移数据。

---

## 七、工程实践

- **key 设计**：`{bizType}/{yyyy}/{MM}/{dd}/{uuid}.{ext}`，按业务前缀配置权限与生命周期；不要把用户文件名、手机号等敏感信息放进 key
- **元数据入库**：文件表记录 `object_key`、大小、内容哈希、上传人、业务归属、状态；业务只保存文件 ID，不直接保存 URL，便于更换域名与签名策略
- **下载分发**：公开资源走 CDN 回源；私有资源由业务服务鉴权后签发短时效 URL，或由 CDN 做 URL 鉴权
- **删除策略**：业务删除先做逻辑删除，由异步任务或生命周期规则清理对象，避免删错后无法恢复；关键数据开启版本控制
- **监控**：关注 4xx / 5xx 比例、请求延迟、存储容量与外网流量趋势，为费用设置告警

---

## 小结

- 对象 = key + 数据 + 元数据，命名空间扁平，对象只能整体覆盖；服务端用多副本或纠删码冗余，与客户端分片上传无关
- S3 提供强读后写一致性，其他兼容实现需要核对
- 块、文件、对象存储的区别在访问接口与修改粒度：数据库用块存储，共享目录用文件存储，内容分发与归档用对象存储
- Bucket 默认私有，用预签名 URL / STS 临时授权；生命周期规则负责转冷、过期删除和清理未完成分片
- 上传走预签名直传：业务服务只鉴权、签发、登记元数据，文件流量不经过应用
- 用 AWS SDK for Java v2 对接 S3 兼容存储；MinIO 社区版已停止维护并归档，自建可评估 Ceph RGW、SeaweedFS、Garage 等，多数业务首选云对象存储

## 参考资料

- Amazon S3 · Consistency model：[https://docs.aws.amazon.com/AmazonS3/latest/userguide/Welcome.html#ConsistencyModel](https://docs.aws.amazon.com/AmazonS3/latest/userguide/Welcome.html#ConsistencyModel)
- Amazon S3 · Presigned URLs：[https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-presigned-url.html](https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-presigned-url.html)
- Amazon S3 · Multipart upload：[https://docs.aws.amazon.com/AmazonS3/latest/userguide/mpuoverview.html](https://docs.aws.amazon.com/AmazonS3/latest/userguide/mpuoverview.html)
- Amazon S3 · Lifecycle management：[https://docs.aws.amazon.com/AmazonS3/latest/userguide/object-lifecycle-mgmt.html](https://docs.aws.amazon.com/AmazonS3/latest/userguide/object-lifecycle-mgmt.html)
- AWS SDK for Java 2.x · Presigned URLs：[https://docs.aws.amazon.com/sdk-for-java/latest/developer-guide/examples-s3-presign.html](https://docs.aws.amazon.com/sdk-for-java/latest/developer-guide/examples-s3-presign.html)
- 阿里云对象存储 OSS 文档：[https://help.aliyun.com/zh/oss/](https://help.aliyun.com/zh/oss/)
- MinIO GitHub 仓库（已归档）：[https://github.com/minio/minio](https://github.com/minio/minio)
- Ceph Object Gateway：[https://docs.ceph.com/en/latest/radosgw/](https://docs.ceph.com/en/latest/radosgw/)
- SeaweedFS：[https://github.com/seaweedfs/seaweedfs](https://github.com/seaweedfs/seaweedfs)
- Garage：[https://garagehq.deuxfleurs.fr/](https://garagehq.deuxfleurs.fr/)
- RustFS：[https://github.com/rustfs/rustfs](https://github.com/rustfs/rustfs)

> 下一篇：[幂等设计](./5_idempotence) —— HTTP 幂等语义与 Idempotency-Key，按插入、更新、消费、提交四类操作选方案，以及下单与支付回调的幂等落地。
