---
description: 分片直传、事件驱动转码编排、HLS AES-128 加密与密钥服务、DRM、播放鉴权与 CDN 签名、封面、审核、存储分层
---

# 点播与短视频

> 前置阅读：[FFmpeg 与转码](./3_ffmpeg)、[对象存储](/architecture/4_object_storage)

点播（VOD）的内容先落盘再播放，短视频是文件短、量极大、更看重首帧的点播变体。本篇讲分片直传、转码编排、HLS 加密与播放鉴权、审核与存储分层，基线为 FFmpeg 9.0。

---

## 一、整体链路

点播和直播最大的区别是内容先落盘再播放：有充足的时间做转码、加密、审核，播放侧追求起播快、不卡顿、防盗播和低成本；短视频单个文件短、上传量和播放量极大、用户在 Feed 里快速划走，因此更看重首帧时间和预加载。示例沿用模块的视频平台：创作者在 App 上传视频，平台转码成多码率 HLS，观众在 App 和网页上观看；DRM 也在本篇范围内。

![点播处理流水线](../assets/media/vod-pipeline.svg)

分工照旧：文件流量走对象存储和 CDN，转码在 FFmpeg 集群或云转码服务里完成，**Java 后端负责签发凭证、编排任务、管理状态和鉴权**，本篇只讲点播业务链路怎么串起来。

| 阶段 | 做什么 | 谁来做 | 关键点 |
|------|--------|--------|--------|
| 上传 | 客户端分片直传原始文件到 `source/` | 客户端 + 对象存储，后端签发预签名 URL | 文件不经过业务服务，支持续传 |
| 入库 | 上传完成后登记媒资、投递处理任务 | 对象存储事件通知 + 编排服务 | 事件可能重复，处理要幂等 |
| 转码 | 输出多码率 HLS，可选加密 | FFmpeg 集群 / 云转码服务 | 最耗算力的一环，按队列削峰 |
| 截帧 | 封面、时间轴雪碧图 | FFmpeg | 封面可以先于转码完成 |
| 审核 | 画面、音频、标题文本的合规检测 | 第三方内容安全服务（异步回调） | 结论决定能否上架 |
| 分发 | 产物写入 `hls/`，经 CDN 播放 | CDN + 密钥服务 + 播放鉴权 | 签名 URL 防盗链，密钥服务控权限 |

一个视频在系统里的状态机：

| 状态 | 含义 | 进入条件 |
|------|------|----------|
| `UPLOADING` | 已签发上传凭证，等待上传完成 | 客户端调用初始化接口 |
| `UPLOADED` | 原始文件已就绪 | 收到上传完成事件且 `HEAD` 校验通过 |
| `PROCESSING` | 转码、截帧、审核进行中 | 编排服务投递任务 |
| `PUBLISHED` | 可播放 | 转码成功且审核通过 |
| `REJECTED` | 审核不通过，不可见 | 审核结论为违规 |
| `FAILED` | 处理失败，等待重试或人工介入 | 重试次数用尽 |

转码和审核**并行**执行，二者都完成后才能进入 `PUBLISHED`。用一张任务表记录每个子任务的状态，编排服务每收到一个子任务的完成事件就检查一次「是否全部完成」：

```sql
CREATE TABLE video (
    id            BIGINT       PRIMARY KEY,
    owner_id      BIGINT       NOT NULL,
    title         VARCHAR(200) NOT NULL,
    status        VARCHAR(20)  NOT NULL,
    source_key    VARCHAR(512) NOT NULL,      -- source/2026/10/10/{id}.mp4
    duration_ms   INT,
    cover_key     VARCHAR(512),
    key_id        VARCHAR(64),                -- HLS 加密密钥 ID
    created_at    DATETIME(3)  NOT NULL,
    updated_at    DATETIME(3)  NOT NULL
);

CREATE TABLE media_task (
    id          BIGINT      PRIMARY KEY,
    video_id    BIGINT      NOT NULL,
    task_type   VARCHAR(20) NOT NULL,        -- TRANSCODE / SNAPSHOT / MODERATION
    status      VARCHAR(20) NOT NULL,        -- PENDING / RUNNING / SUCCESS / FAILED
    retry_count INT         NOT NULL DEFAULT 0,
    external_id VARCHAR(128),                -- 云转码 / 审核服务返回的 jobId
    result      JSON,
    updated_at  DATETIME(3) NOT NULL,
    UNIQUE KEY uk_video_type (video_id, task_type)
);
```

`uk_video_type` 保证同一个视频同一类任务只有一条记录，重复的上传完成事件只会命中唯一键冲突，不会重复转码。

---

## 二、上传：预签名分片直传

视频文件动辄几百 MB 到数 GB，必须让客户端直传对象存储。流程与 [对象存储](/architecture/4_object_storage) 第四节的预签名直传一致，大文件走分片：

1. 客户端调用 `POST /api/videos/uploads`，带上文件名、大小、MIME 类型和文件哈希
2. 后端校验身份、配额、格式白名单（`video/mp4`、`video/quicktime` 等）和大小上限，创建 `video` 记录（`UPLOADING`），调用 `CreateMultipartUpload` 拿到 `uploadId`，为每个分片签发 `UploadPart` 预签名 URL
3. 客户端并发上传分片，记录每片的 `ETag`；断网后用 `ListParts` 查询已传分片继续上传
4. 客户端调用 `POST /api/videos/uploads/{id}/complete`，后端调用 `CompleteMultipartUpload` 合并，`HEAD` 核对大小后把状态改为 `UPLOADED`

S3 分片的硬性限制：单片 5 MiB～5 GiB（最后一片不限下限），最多 10,000 片。按 10,000 片反推，片大小要随文件大小调整，例如 8 MiB 一片最大只能传约 78 GiB。断点续传的进度记录、秒传的防撞库设计、STS 临时凭证的权限收敛见 [大文件上传](/scenario/10_file_upload)，这里不重复。

点播场景额外要注意三点：

- **对象键不用用户文件名**：统一生成 `source/{yyyy}/{MM}/{dd}/{videoId}.{ext}`，原始文件名只存数据库；用户文件名里的中文、空格和路径符号会给后续转码命令和 CDN 签名带来麻烦
- **上传完成以服务端核验为准**：客户端的 `complete` 调用和对象存储的事件通知（S3 事件通知到 SQS / EventBridge、MinIO 的 bucket notification、云厂商 OSS 的事件通知）都可能丢或重复，编排服务两路都接，用状态机条件更新去重
- **未完成的分片要清理**：创作者中途放弃时，已传的分片会一直计费，在生命周期规则里配置 `AbortIncompleteMultipartUpload`（见第八节）

短视频 App 通常在客户端先做一次**预压缩**：手机拍摄的 4K 高码率原片压到 1080p、8 Mbps 左右再上传，上传时间和服务端转码成本都能降一个量级。原片画质对平台没有额外价值时，这是性价比最高的优化。

---

## 三、转码编排：事件驱动

转码命令本身见 [FFmpeg 与转码](./3_ffmpeg)，编排服务要解决的是：任务怎么投递、失败怎么重试、多个子任务怎么汇合。任务投递走消息队列，用队列长度做削峰，转码节点按消费速度横向扩容，消息队列选型见 [消息队列总览](/messaging/0_overview)。

```java
@Component
@RequiredArgsConstructor
public class UploadedEventListener {

    private final VideoRepository videoRepository;
    private final MediaTaskRepository taskRepository;
    private final KafkaTemplate<String, MediaTaskMessage> kafkaTemplate;

    @KafkaListener(topics = "vod.video.uploaded", groupId = "vod-orchestrator")
    @Transactional
    public void onUploaded(VideoUploadedEvent event) {
        // 条件更新：只有 UPLOADED 状态能推进到 PROCESSING，重复事件直接返回
        int updated = videoRepository.casStatus(event.videoId(), "UPLOADED", "PROCESSING");
        if (updated == 0) {
            return;
        }
        for (TaskType type : List.of(TaskType.TRANSCODE, TaskType.SNAPSHOT, TaskType.MODERATION)) {
            taskRepository.insertIgnore(event.videoId(), type);   // INSERT IGNORE，依赖唯一键
        }
        // 事务提交后再发消息，避免消息先到、数据库还没提交
        TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization() {
            @Override
            public void afterCommit() {
                for (TaskType type : TaskType.values()) {
                    kafkaTemplate.send("vod.task." + type.topicSuffix(),
                            String.valueOf(event.videoId()),
                            new MediaTaskMessage(event.videoId(), type, event.sourceKey()));
                }
            }
        });
    }
}
```

`afterCommit` 发送仍有「提交成功、发送失败」的窗口，对可靠性要求高的场景改用事务消息或本地消息表（Outbox），参见 [分布式事务](/distributed/4_transaction)。

子任务完成后汇合：

```java
@Transactional
public void onTaskFinished(long videoId, TaskType type, boolean success, JsonNode result) {
    taskRepository.finish(videoId, type, success ? "SUCCESS" : "FAILED", result);
    List<MediaTask> tasks = taskRepository.lockByVideoId(videoId);   // SELECT ... FOR UPDATE

    if (tasks.stream().anyMatch(t -> t.type() == TaskType.MODERATION && t.isRejected())) {
        videoRepository.casStatus(videoId, "PROCESSING", "REJECTED");
        return;
    }
    boolean allDone = tasks.stream().allMatch(t -> "SUCCESS".equals(t.status()));
    if (allDone) {
        videoRepository.casStatus(videoId, "PROCESSING", "PUBLISHED");
        // 发布领域事件：刷新推荐 Feed、通知创作者、预热 CDN 等
    }
}
```

几条编排经验：

- **转码节点只做计算**：节点从队列取任务，从对象存储下载源文件到本地盘，FFmpeg 处理完上传产物，再发完成消息；节点无状态，可以用 Kubernetes Job、Spot 实例或 GPU 节点按队列积压扩缩
- **超时与重试分开**：转码时长与视频时长相关，超时阈值按「视频时长 × 系数 + 固定值」动态设置；可重试错误（下载失败、节点被回收）退避重试，不可重试错误（文件损坏、无视频轨）直接 `FAILED` 并通知创作者
- **先探测再转码**：用 `ffprobe` 读出时长、分辨率、编码、旋转角度，据此裁剪码率阶梯，不给 720p 原片转 1080p
- **云转码同理**：使用云厂商的媒体处理服务时，编排服务调用提交接口拿到 `jobId` 写入 `media_task.external_id`，完成结果通过回调或消息通知回来，回调要验签和幂等

---

## 四、HLS 加密：AES-128 与密钥服务

HLS 切片默认是明文的 `.ts` / `.m4s` 文件，任何人拿到 m3u8 地址就能用 FFmpeg 整片下载。付费课程、会员内容至少要做 **HLS 标准加密**：每个切片用 AES-128-CBC 整段加密，播放器从 `EXT-X-KEY` 指定的地址取密钥解密。

### 1、m3u8 里的 EXT-X-KEY

RFC 8216 定义了三种 `METHOD`：`NONE`（不加密）、`AES-128`（整段 AES-128-CBC，PKCS7 填充）、`SAMPLE-AES`（只加密音视频样本，配合 FairPlay 使用）。加密后的媒体播放列表：

```text
#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:6
#EXT-X-MEDIA-SEQUENCE:0
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-KEY:METHOD=AES-128,URI="https://api.example.com/api/hls/keys/k_9f2c1a",IV=0x3b7e1f0c9a2d4e6f8a1b2c3d4e5f6071
#EXTINF:6.000000,
seg_1_00000.ts
#EXTINF:6.000000,
seg_1_00001.ts
#EXTINF:4.200000,
seg_1_00002.ts
#EXT-X-ENDLIST
```

- `URI` 是密钥地址，播放器请求它拿到 **16 字节的原始二进制密钥**（不是十六进制字符串）
- `IV` 是 128 位初始化向量，十六进制写法前缀 `0x`；省略时播放器用切片的媒体序列号作为 IV
- 一个 `EXT-X-KEY` 作用于其后的所有切片，直到出现下一个 `EXT-X-KEY`；需要中途轮换密钥时插入新的标签即可

### 2、用 FFmpeg 生成加密 HLS

先生成密钥和 key info 文件：

```bash
openssl rand 16 > /data/keys/k_9f2c1a.key
openssl rand -hex 16          # 输出 32 位十六进制，作为 IV
```

`enc.keyinfo` 三行依次是：写进 m3u8 的密钥 URI、本地密钥文件路径、IV（可选）：

```text
https://api.example.com/api/hls/keys/k_9f2c1a
/data/keys/k_9f2c1a.key
3b7e1f0c9a2d4e6f8a1b2c3d4e5f6071
```

三档码率加密输出（码率阶梯取值的依据见 [FFmpeg 与转码](./3_ffmpeg)）：

```bash
ffmpeg -i source.mp4 \
  -filter_complex "[0:v]split=3[a][b][c];[a]scale=-2:1080[v0];[b]scale=-2:720[v1];[c]scale=-2:480[v2]" \
  -map "[v0]" -map "[v1]" -map "[v2]" -map 0:a:0 -map 0:a:0 -map 0:a:0 \
  -c:v libx264 -preset medium -profile:v high \
  -b:v:0 5000k -maxrate:v:0 5350k -bufsize:v:0 7500k \
  -b:v:1 2800k -maxrate:v:1 3000k -bufsize:v:1 4200k \
  -b:v:2 1200k -maxrate:v:2 1300k -bufsize:v:2 1800k \
  -force_key_frames "expr:gte(t,n_forced*2)" -sc_threshold 0 \
  -c:a aac -b:a 128k -ac 2 \
  -f hls -hls_time 6 -hls_playlist_type vod -hls_flags independent_segments \
  -hls_key_info_file enc.keyinfo \
  -hls_segment_filename "out/seg_%v_%05d.ts" \
  -master_pl_name master.m3u8 \
  -var_stream_map "v:0,a:0 v:1,a:1 v:2,a:2" \
  "out/index_%v.m3u8"
```

- 产物都在 `out/` 下：主播放列表 `master.m3u8`、三个媒体播放列表 `index_0.m3u8`～`index_2.m3u8`、切片 `seg_{码率序号}_{切片序号}.ts`，`%v` 由 FFmpeg 替换为 `var_stream_map` 中的码率序号
- `-force_key_frames "expr:gte(t,n_forced*2)"` 每 2 秒强制一个关键帧，与帧率无关，保证 6 秒切片边界都落在关键帧上，各码率切片对齐，播放器切换码率不花屏
- 所有码率共用同一个密钥文件；要按码率或按时间段用不同密钥时，需要分别执行或配合 `-hls_flags periodic_rekey`（FFmpeg 会周期性重读 key info 文件）
- 源文件没有音轨时 `-map 0:a:0` 会报错，编排服务应根据 `ffprobe` 结果拼接命令

密钥文件用完即删，不能和切片一起上传到对象存储。密钥本身用 KMS 做信封加密后存入数据库：数据库里存密文，密钥服务启动时或按需调用 KMS 解密，明文只在内存里，参见 [数据安全](/security/7_data_security)。

### 3、密钥服务与播放鉴权

AES-128 的安全性完全取决于**密钥地址能否被随意访问**。密钥服务必须校验播放令牌：令牌由播放接口签发，绑定用户、视频和过期时间，有效期以分钟计。

播放流程：

1. 客户端调用 `GET /api/videos/{id}/play`，后端校验登录态、会员权益、地区限制，签发播放令牌
2. 后端返回一个**动态生成**的 m3u8 地址：媒体播放列表由 Java 服务改写输出，把 `EXT-X-KEY` 的 `URI` 加上令牌，把切片地址替换成带 CDN 签名的绝对地址
3. 播放器拉取改写后的 m3u8，按 `URI` 请求密钥服务，按切片地址从 CDN 下载

```java
@Component
public class PlayTokenService {

    private final byte[] secret;

    public PlayTokenService(@Value("${vod.play-token-secret}") String secret) {
        this.secret = secret.getBytes(StandardCharsets.UTF_8);
    }

    /** 令牌格式：videoId.userId.expireEpochSecond.signature */
    public String issue(long videoId, long userId, Duration ttl) {
        long exp = Instant.now().plus(ttl).getEpochSecond();
        String payload = videoId + "." + userId + "." + exp;
        return payload + "." + hmac(payload);
    }

    public Optional<long[]> verify(String token) {
        String[] parts = token.split("\\.");
        if (parts.length != 4) {
            return Optional.empty();
        }
        String payload = parts[0] + "." + parts[1] + "." + parts[2];
        boolean signOk = MessageDigest.isEqual(
                hmac(payload).getBytes(StandardCharsets.US_ASCII),
                parts[3].getBytes(StandardCharsets.US_ASCII));
        if (!signOk || Long.parseLong(parts[2]) < Instant.now().getEpochSecond()) {
            return Optional.empty();
        }
        return Optional.of(new long[]{Long.parseLong(parts[0]), Long.parseLong(parts[1])});
    }

    private String hmac(String data) {
        try {
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(secret, "HmacSHA256"));
            return Base64.getUrlEncoder().withoutPadding()
                    .encodeToString(mac.doFinal(data.getBytes(StandardCharsets.UTF_8)));
        } catch (GeneralSecurityException e) {
            throw new IllegalStateException(e);
        }
    }
}
```

密钥接口：

```java
@RestController
@RequestMapping("/api/hls/keys")
@RequiredArgsConstructor
public class HlsKeyController {

    private final PlayTokenService tokenService;
    private final VideoKeyService keyService;      // 按 keyId 查密文并经 KMS 解密，带本地缓存

    @GetMapping("/{keyId}")
    public ResponseEntity<byte[]> key(@PathVariable String keyId, @RequestParam String token) {
        long[] claims = tokenService.verify(token).orElse(null);
        if (claims == null || !keyService.belongsTo(keyId, claims[0])) {
            return ResponseEntity.status(HttpStatus.FORBIDDEN).build();
        }
        byte[] key = keyService.plainKey(keyId);   // 16 字节
        return ResponseEntity.ok()
                .contentType(MediaType.APPLICATION_OCTET_STREAM)
                .cacheControl(CacheControl.noStore())
                .body(key);
    }
}
```

要点：

- **密钥接口不能走 CDN 缓存**：返回 `Cache-Control: no-store`，CDN 上为 `/api/hls/keys/*` 配置不缓存或干脆不经 CDN
- **网页播放要配 CORS**：hls.js 用 XHR / fetch 取密钥，密钥接口要允许播放页的 Origin，配置方法见 [API 安全](/security/6_api_security) 第七节
- **令牌放查询参数是折中**：HLS 播放器很难给密钥请求加自定义请求头，只能把令牌放 URI 里；因此令牌有效期要短、绑定视频，日志里要脱敏 `token` 参数
- **按用户限频**：同一令牌在短时间内大量请求密钥，往往是脚本在批量下载，可以结合 [限流与过载保护](/high-avail/7_rate_limiting) 拦截

::: tip AES-128 防得住什么
AES-128 防的是「拿到 m3u8 地址就能直接下载」和「切片被 CDN 缓存后被他人盗链」。它防不住已登录的用户：浏览器开发者工具里能看到密钥请求和返回的 16 字节，配合 FFmpeg 就能解密整片。需要防止合法用户录制、外传的内容（影视版权、付费独家内容），必须用 DRM，把密钥锁在播放器的 CDM（内容解密模块）里，应用层拿不到明文密钥。
:::

---

## 五、DRM：Widevine、FairPlay 与 PlayReady

DRM（数字版权管理）不靠「藏好密钥地址」，而是由操作系统或浏览器内置的 CDM 向许可证服务器申请许可证，密钥在 CDM 内部使用，L1 级别的实现甚至在硬件可信执行环境里解密和解码。浏览器通过 EME（Encrypted Media Extensions）接口把加密流交给 CDM。

| DRM | 厂商 | 覆盖终端 | 常用封装 |
|-----|------|----------|----------|
| Widevine | Google | Chrome、Firefox、Edge、Android、多数智能电视 | DASH / HLS（CMAF），CENC |
| FairPlay Streaming | Apple | Safari、iOS、iPadOS、tvOS、macOS | HLS，`SAMPLE-AES` / CMAF `cbcs` |
| PlayReady | Microsoft | Edge、Windows、Xbox、部分电视 | DASH / Smooth Streaming，CENC |

要覆盖全平台通常三者都要接，即「多 DRM」。工程上的关键是 **CENC（ISO/IEC 23001-7 通用加密）**：一份用 `cbcs` 模式加密的 CMAF 切片，可以同时被三种 DRM 解密，只需在清单里分别声明各自的许可证信息（DASH 的 `ContentProtection` / PSSH、HLS 的 `EXT-X-KEY`）。FairPlay 在 HLS 里的声明形如：

```text
#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://k_9f2c1a",KEYFORMAT="com.apple.streamingkeydelivery",KEYFORMATVERSIONS="1"
```

Java 后端在 DRM 里的位置：

- **打包**：转码产物交给打包工具（如 Shaka Packager）或云厂商的 DRM 打包服务，生成 CMAF 切片和 DASH / HLS 清单；密钥由密钥管理服务生成并按 `keyId` 登记
- **许可证代理**：播放器的许可证请求先打到业务的许可证代理接口，后端完成用户鉴权、权益判断（是否购买、是否限设备数、是否允许离线下载），再把请求转发给 DRM 许可证服务（自建或第三方多 DRM 服务商）并透传响应
- **策略下发**：许可证里可以带有效期、是否允许持久化、输出保护要求（如要求 HDCP），这些策略由后端按业务规则决定

DRM 的申请流程、证书和费用都比较重：Widevine 需要与 Google 签约或通过授权服务商接入，FairPlay 需要在 Apple 开发者账号下申请 FPS 证书。大多数中小平台的选择是 **AES-128 + 短时效签名 + 水印**，只有版权方明确要求时才上 DRM。

---

## 六、播放鉴权与 CDN 签名 URL

即使内容不加密，切片也不能裸放在 CDN 上，否则播放地址会被贴到别的网站上白嫖流量。CDN 防盗链手段从弱到强：

| 手段 | 原理 | 局限 |
|------|------|------|
| Referer 白名单 | 只允许指定域名的页面引用 | App 和脚本可以伪造或不带 Referer |
| UA / IP 黑白名单 | 按请求特征拦截 | 只能挡明显的爬虫 |
| URL 签名（时间戳防盗链） | URL 带过期时间和签名，CDN 边缘校验 | 签名有效期内地址可以被转发 |
| 签名 Cookie | 一次签发，对路径通配的一批文件生效 | 跨域网页播放需要处理 Cookie 作用域 |
| 边缘计算鉴权 | 在边缘函数里校验 JWT 等自定义令牌 | 需要边缘计算能力，见 [Cloudflare 边缘服务](/cloud-native/16_cloudflare) 第五节 |

国内 CDN 常见的「A 型鉴权」格式（以阿里云 CDN 为例，腾讯云等厂商的时间戳防盗链思路相同、参数名不同）：

```text
https://vod.example.com/hls/2026/10/10/88001/seg_1_00000.ts?auth_key={timestamp}-{rand}-{uid}-{md5hash}
md5hash = md5("{uri}-{timestamp}-{rand}-{uid}-{privateKey}")
```

其中 `timestamp` 是**签发时间**（10 位秒级时间戳），过期时间 = `timestamp` + CDN 控制台配置的有效时长；`uri` 是不含查询参数的路径；`uid` 一般填 `0`。Java 实现：

```java
public final class CdnSigner {

    private final String host;
    private final String privateKey;

    public CdnSigner(String host, String privateKey) {
        this.host = host;
        this.privateKey = privateKey;
    }

    public String sign(String uri) {
        long ts = Instant.now().getEpochSecond();
        String rand = UUID.randomUUID().toString().replace("-", "");
        String uid = "0";
        String raw = uri + "-" + ts + "-" + rand + "-" + uid + "-" + privateKey;
        return "https://" + host + uri + "?auth_key=" + ts + "-" + rand + "-" + uid + "-" + md5Hex(raw);
    }

    private static String md5Hex(String s) {
        try {
            byte[] digest = MessageDigest.getInstance("MD5").digest(s.getBytes(StandardCharsets.UTF_8));
            return HexFormat.of().formatHex(digest);
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }
}
```

HLS 的难点在于**一个 m3u8 引用几十上百个切片**，而播放器按 m3u8 里的相对路径请求切片时不会带上 m3u8 的签名参数。三种做法：

- **服务端改写 m3u8**（本篇采用）：媒体播放列表由 Java 服务实时输出，逐行把切片名替换成带签名的绝对地址；m3u8 文件小，可以在服务端缓存原始内容，只做字符串替换。签名有效期要覆盖「起播到看完」的时长，或让播放器在过期前重新拉取播放接口
- **签名 Cookie**：AWS CloudFront 的签名 Cookie 可以用自定义策略对 `/hls/88001/*` 这样的通配路径授权，播放器请求切片时自动带上
- **厂商的 m3u8 参数透传**：部分 CDN 支持在回源或响应时把 m3u8 的鉴权参数自动追加到切片地址上，开启后无需改写，具体能力以所用 CDN 文档为准

改写 m3u8 的核心逻辑：

```java
public String rewrite(String playlist, String baseUri, String keyUri, String token) {
    StringBuilder out = new StringBuilder(playlist.length() * 2);
    for (String line : playlist.split("\n")) {
        if (line.startsWith("#EXT-X-KEY:")) {
            line = line.replaceFirst("URI=\"[^\"]*\"",
                    "URI=\"" + keyUri + "?token=" + URLEncoder.encode(token, StandardCharsets.UTF_8) + "\"");
        } else if (!line.isBlank() && !line.startsWith("#")) {
            line = cdnSigner.sign(baseUri + line.strip());   // seg_1_00000.ts → 带 auth_key 的绝对地址
        }
        out.append(line).append('\n');
    }
    return out.toString();
}
```

改写后的 m3u8 响应同样设置 `Cache-Control: no-store`：每个用户拿到的签名和令牌都不同，不能被 CDN 缓存。主播放列表 `master.m3u8` 里的子播放列表地址也指向这个改写接口。签名算法、密钥轮换和防重放的通用做法见 [API 安全](/security/6_api_security)。

除此之外，付费内容常叠加**数字水印**：明水印（用户 ID 浮层，由播放器渲染）用于威慑，暗水印（转码时嵌入、肉眼不可见）用于泄露后溯源，后者通常需要商业方案支持。

---

## 七、封面、预览与内容审核

### 1、封面与雪碧图

截帧和转码一样交给 FFmpeg 节点，常用三种产物：

```bash
# 默认封面：第 3 秒截一帧（-ss 放在 -i 前面，按关键帧快速定位）
ffmpeg -ss 3 -i source.mp4 -frames:v 1 -q:v 2 cover.jpg

# 智能封面：每 300 帧里选一帧最有代表性的画面，避开黑屏和转场
ffmpeg -i source.mp4 -vf "thumbnail=300,scale=720:-2" -frames:v 1 cover_auto.jpg

# 进度条预览雪碧图：每 10 秒一帧，缩成 160 宽，拼成 10×10 的大图
ffmpeg -i source.mp4 -vf "fps=1/10,scale=160:-2,tile=10x10" -q:v 5 sprite_%03d.jpg
```

- 封面不必等转码完成，截帧任务很快，先出封面可以让创作者在「处理中」页面就看到预览
- 智能封面之外，允许创作者上传自定义封面，自定义封面同样要过图片审核
- 雪碧图配合一个 WebVTT 文件（每个时间段对应雪碧图里的坐标），播放器拖动进度条时显示缩略图

### 2、内容审核

视频审核的数据量大、耗时长，第三方服务（各云厂商的内容安全产品、AWS Rekognition 的 `StartContentModeration` 等）几乎都是**异步接口**：提交任务拿到 `jobId`，结果通过回调或消息通知返回，或由业务轮询。

| 审核对象 | 做法 |
|----------|------|
| 画面 | 按固定间隔截帧做图片识别（涉黄、暴恐、违禁标志、二维码广告） |
| 音频 | 语音转文字后做文本审核 |
| 标题、简介、字幕 | 同步文本审核，提交时即可拦截 |
| 封面 | 同步图片审核 |

编排要点：

- **先审后发还是先发后审**：新账号、低信用账号先审后发；高信用创作者可以先发后审，但只开放给少量流量，审核通过后再进入推荐池
- **三档结论**：通过、拒绝、疑似；疑似进入人工复审队列，复审结果同样走 `onTaskFinished` 汇合
- **回调验签与幂等**：回调接口校验服务商签名，按 `jobId` 去重；同时要有超时兜底，超过阈值仍未回调就主动查询结果
- **审核结论可撤回**：已发布视频被举报或规则更新后需要重新审核，下架要同步清理 CDN 缓存（刷新 m3u8，切片可以不刷，因为没有新的签名就拿不到）

---

## 八、存储分层与生命周期

点播平台的存储量只增不减，且播放分布极度长尾：少数新视频贡献绝大部分播放，大量老视频几乎无人观看。存储类别的通用介绍见 [对象存储](/architecture/4_object_storage) 第三节，点播的分层策略：

| 数据 | 存放前缀 | 分层策略 |
|------|----------|----------|
| 原始文件 | `source/` | 用于重新转码（新编码格式、新码率），30 天后转低频，半年后转归档；创作者删除视频后按合规要求保留期删除 |
| 转码产物 | `hls/` | 新视频标准存储；长期低播放的视频转低频；极冷视频可以只保留一档码率，其余档按需重新转码 |
| 封面、雪碧图 | `image/` | 访问频繁、体积小，一直放标准存储 |
| 临时文件 | `tmp/` | 转码中间文件、未确认上传，7 天后删除 |

S3 生命周期规则示例（`aws s3api put-bucket-lifecycle-configuration --bucket vod-media --lifecycle-configuration file://lifecycle.json`）：

```json
{
  "Rules": [
    {
      "ID": "source-tiering",
      "Filter": { "Prefix": "source/" },
      "Status": "Enabled",
      "Transitions": [
        { "Days": 30, "StorageClass": "STANDARD_IA" },
        { "Days": 180, "StorageClass": "GLACIER_IR" }
      ]
    },
    {
      "ID": "tmp-cleanup",
      "Filter": { "Prefix": "tmp/" },
      "Status": "Enabled",
      "Expiration": { "Days": 7 }
    },
    {
      "ID": "abort-incomplete-multipart",
      "Filter": {},
      "Status": "Enabled",
      "AbortIncompleteMultipartUpload": { "DaysAfterInitiation": 7 }
    }
  ]
}
```

注意事项：

- **按前缀只能按年龄分层**：转码产物的冷热取决于播放量而不是上传时间，生命周期规则按天数转换会把突然翻红的老视频也放进低频层。可以用 S3 智能分层（Intelligent-Tiering）按访问自动迁移，或由后端根据播放统计给对象打标签、规则按标签过滤
- **低频和归档有隐藏成本**：低频存储有最短存储时长和取回费用，归档层取回前要先解冻；大量小切片转低频时还要注意最小计费对象大小，切片过小反而不划算
- **CDN 命中率才是大头**：热门视频的流量 90% 以上应由 CDN 边缘承担，回源流量和对象存储读请求费用都和命中率直接相关；切片地址里的签名参数要在 CDN 上配置为「忽略参数缓存」，否则每个用户的签名都不同，缓存完全失效

---

## 九、短视频的特殊优化

短视频把点播的「起播快」推到了极致，用户在 Feed 里一秒就划走，几项优化直接影响留存：

- **首帧优化**：单文件 MP4 播放时，`moov` 索引放在文件头部（FFmpeg 的 `-movflags +faststart`），播放器下载前几十 KB 就能起播；HLS 场景缩短首个切片时长（如 2 秒）
- **预加载**：Feed 里预先下载下一、二条视频的前几百 KB，划过去时直接起播；预加载量要按网络类型调整，避免浪费用户流量和平台带宽
- **码率选择**：短视频通常不做 HLS 多码率，而是转出 2～3 档 MP4，由客户端按网络和屏幕选择一档；App 端普遍支持 H.265，可以对 App 下发 H.265、对网页下发 H.264，同画质节省可观带宽
- **播放统计**：播放次数、完播率是推荐系统的核心信号，客户端上报经消息队列异步聚合，计数实现见 [计数系统](/scenario/17_counter)，Feed 分发见 [Feed 流和消息推送](/scenario/8_feed_stream)
- **互动消息不走媒体链路**：评论、点赞、弹幕通过长连接或普通接口实现，弹幕的推送模型见 [即时通讯](/scenario/16_im)

---

## 小结

- 点播链路 = 预签名分片直传 + 上传完成事件驱动编排 + 转码 / 截帧 / 审核并行 + 签名分发；Java 后端只负责凭证、状态机、任务编排和鉴权，文件流量不经过业务服务
- 编排的核心是幂等：视频状态用条件更新推进，子任务用唯一键防重，消息在事务提交后发送，可靠性要求高时用 Outbox
- HLS AES-128 的 `EXT-X-KEY` 写明 `METHOD=AES-128`、密钥 `URI` 和可选 `IV`；密钥接口必须校验短时效令牌、禁止缓存、配置 CORS；AES-128 防盗链不防录制，版权内容上 Widevine / FairPlay / PlayReady 多 DRM，用 CENC `cbcs` 共享一份切片
- CDN 签名 URL 防止地址外传；HLS 的切片签名可以用服务端改写 m3u8、签名 Cookie 或厂商参数透传解决，签名参数要在 CDN 上忽略缓存键
- 封面先于转码产出，审核走异步回调并支持人工复审和重新审核
- 存储按原始文件、转码产物、图片、临时文件分前缀管理，生命周期规则负责转低频、归档和清理未完成分片；冷热按播放量判断时用智能分层或标签

## 参考资料

- HLS 规范：[RFC 8216 - HTTP Live Streaming](https://www.rfc-editor.org/rfc/rfc8216)
- FFmpeg HLS 封装器参数：[FFmpeg Formats Documentation - hls](https://ffmpeg.org/ffmpeg-formats.html#hls-2)
- FFmpeg 滤镜（thumbnail、tile、scale）：[FFmpeg Filters Documentation](https://ffmpeg.org/ffmpeg-filters.html)
- S3 分片上传限制：[Amazon S3 multipart upload limits](https://docs.aws.amazon.com/AmazonS3/latest/userguide/qfacts.html)
- S3 生命周期配置：[Managing the lifecycle of objects](https://docs.aws.amazon.com/AmazonS3/latest/userguide/object-lifecycle-mgmt.html)
- S3 事件通知：[Amazon S3 Event Notifications](https://docs.aws.amazon.com/AmazonS3/latest/userguide/EventNotifications.html)
- 阿里云 CDN A 型鉴权：[鉴权方式 A 说明](https://help.aliyun.com/zh/cdn/user-guide/type-a-signing)
- CloudFront 签名 URL 与签名 Cookie：[Serve private content with signed URLs and signed cookies](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/PrivateContent.html)
- hls.js 播放器：[hls.js API](https://github.com/video-dev/hls.js/blob/master/docs/API.md)
- 浏览器 EME：[W3C Encrypted Media Extensions](https://www.w3.org/TR/encrypted-media/)
- Widevine：[Widevine DRM](https://developers.google.com/widevine)
- FairPlay Streaming：[Apple FairPlay Streaming](https://developer.apple.com/streaming/fps/)
- PlayReady：[Microsoft PlayReady Documentation](https://learn.microsoft.com/en-us/playready/)
- 打包工具：[Shaka Packager Documentation](https://shaka-project.github.io/shaka-packager/html/)
- AWS 视频内容审核：[Detecting inappropriate stored videos](https://docs.aws.amazon.com/rekognition/latest/dg/procedure-moderate-videos.html)

> 下一篇：[监控视频接入](./8_video_surveillance)
