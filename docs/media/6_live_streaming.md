---
description: 推流签名鉴权、播放防盗链、多码率转码与 CDN 分发、延迟分级、录制回放、弹幕与在线人数、连麦、流监控与切换
---

# 直播系统设计

> 前置阅读：[流媒体协议](./2_protocols)、[流媒体服务器](./4_media_server)、[WebRTC 实时通信](./5_webrtc)

直播系统的数据面是持续的大流量媒体流，控制面才是普通的请求响应。本篇讲开播到观看的完整链路、录制回放、弹幕、连麦与流监控，基线为 SRS 6.0。

---

## 一、需求与挑战

一路 1080p 直播码率约 4 Mbps，十万人同时观看就是 400 Gbps 的出口带宽，这部分只能交给流媒体服务器和 CDN；Java 后端不碰媒体字节，负责开播、鉴权、回调处理、任务编排和互动功能。示例域名统一为 `push.example.com`（推流）、`play.example.com`（播放）、`api.example.com`（业务接口），源站以 SRS 6.0 为参照。

### 1、功能范围

- **主播侧**：开播申请、获取推流地址、推流（App、OBS、硬件编码器）、连麦、下播
- **观众侧**：进房、按网速选择清晰度播放、发弹幕和礼物、看回放
- **平台侧**：推流鉴权、防盗链、多码率转码、录制、内容审核、在线人数与热门榜、流质量监控

### 2、挑战

| 挑战 | 说明 |
|------|------|
| 带宽成本 | 出口流量随观看人数线性增长，必须依赖 CDN 边缘分发，源站只服务 CDN 回源 |
| 延迟与稳定的权衡 | 延迟越低，播放端缓冲越小，越容易卡顿；不同业务要选不同档位 |
| 推流安全 | 推流地址一旦泄露，任何人都能冒用直播间推送违规内容 |
| 盗链 | 播放地址被第三方网站嵌入，平台为别人的流量买单 |
| 瞬时热点 | 头部主播开播瞬间涌入数十万观众，进房、弹幕、计数接口同时被打满 |
| 断流与故障 | 主播网络抖动、源站节点宕机、CDN 区域故障，都要能快速发现并切换 |

---

## 二、整体架构

![直播系统架构：媒体流走流媒体集群与 CDN，Java 服务负责控制面](../assets/media/live-architecture.svg)

媒体流的路径是 **推流 → 接入源站 → 转码 → CDN → 播放器**：

1. **推流**：主播端用 RTMP（最通用）、SRT（抗弱网，适合户外和专业编码器）或 WHIP（亚秒级，浏览器可直接推）推到就近的接入节点
2. **接入源站**：SRS、ZLMediaKit 等流媒体服务器接收推流，触发 `on_publish` 回调由业务服务鉴权；源站集群一般按"边缘接入 + 中心源站"两层部署
3. **转码**：转码集群从源站拉原始流，输出 1080p / 720p / 480p 等多档码率，再推回源站或直接输出 HLS 切片
4. **CDN 分发**：CDN 边缘节点按需回源拉流，观众就近从边缘拉 HTTP-FLV 或 HLS
5. **播放**：播放器根据网速在多档码率之间切换（ABR），HLS 通过主播放列表实现

Java 后端（直播业务服务）在控制面上的职责：

| 职责 | 说明 |
|------|------|
| 开播与推流地址签发 | 校验主播资质与房间状态，签发带过期时间的签名推流地址 |
| 流事件回调 | 处理 `on_publish` / `on_unpublish` / `on_dvr` / `on_hls` 等回调，维护房间的开播状态 |
| 播放地址签发 | 按 CDN 厂商规则生成带鉴权参数的播放地址 |
| 任务编排 | 录制、转点播、截图审核等异步任务通过消息队列下发给 worker |
| 互动 | 弹幕、礼物、在线人数、热门榜、连麦房间管理 |

边界说明：RTMP / SRT / HLS / HTTP-FLV 的协议细节见 [流媒体协议](./2_protocols)；FFmpeg 转码命令与参数见 [FFmpeg 与转码](./3_ffmpeg)；SRS 的部署、集群与回调配置见 [流媒体服务器](./4_media_server)；录制文件转点播见 [点播与短视频](./7_vod)；CDN 的通用缓存与边缘能力见 [Cloudflare 边缘服务](/cloud-native/16_cloudflare)。

---

## 三、开播与推流鉴权

![推流鉴权：业务服务签发带过期时间的签名地址，源站回调校验](../assets/media/live-push-auth.svg)

### 1、签名推流地址

推流地址的格式：

```text
rtmp://push.example.com/live/{streamKey}?expire={过期时间戳}&sign={签名}
```

- `streamKey`：每个直播间一个，与房间绑定，**不是密钥**，可以被看到
- `expire`：Unix 秒，表示这个地址最晚何时可以**开始**推流；已在推的流不会因为过期被断开
- `sign`：`HMAC-SHA256(密钥, "/live/{streamKey}:{expire}")` 的十六进制，密钥只存在业务服务中

用 HMAC 而不是 `MD5(路径 + 密钥)` 这类拼接哈希，是因为普通哈希不是为消息认证设计的（密钥放在前面时会遭受长度扩展攻击），HMAC 才是标准的带密钥认证构造；把路径和过期时间都放进签名，篡改任意一个都会校验失败。接口签名的通用设计见 [API 安全](/security/6_api_security) 第三节。

```java
@Component
public class StreamSigner {

    private static final String APP = "live";
    private final SecretKeySpec key;

    public StreamSigner(@Value("${live.push.secret}") String secret) {
        this.key = new SecretKeySpec(secret.getBytes(StandardCharsets.UTF_8), "HmacSHA256");
    }

    /** 签发推流地址，ttl 是"允许开始推流"的时间窗口 */
    public String pushUrl(String streamKey, Duration ttl) {
        long expire = Instant.now().plus(ttl).getEpochSecond();
        return "rtmp://push.example.com/" + APP + "/" + streamKey
                + "?expire=" + expire + "&sign=" + sign(APP, streamKey, expire);
    }

    /** 源站回调时校验：先看是否过期，再用常量时间比较签名 */
    public boolean verify(String app, String streamKey, long expire, String sign) {
        if (!APP.equals(app) || expire < Instant.now().getEpochSecond()) {
            return false;
        }
        byte[] expected = sign(app, streamKey, expire).getBytes(StandardCharsets.US_ASCII);
        return MessageDigest.isEqual(expected, sign.getBytes(StandardCharsets.US_ASCII));
    }

    private String sign(String app, String streamKey, long expire) {
        try {
            Mac mac = Mac.getInstance("HmacSHA256");   // Mac 非线程安全，每次新建
            mac.init(key);
            byte[] raw = mac.doFinal(("/" + app + "/" + streamKey + ":" + expire)
                    .getBytes(StandardCharsets.UTF_8));
            return HexFormat.of().formatHex(raw);
        } catch (GeneralSecurityException e) {
            throw new IllegalStateException("HMAC-SHA256 不可用", e);
        }
    }
}
```

要点：

- **常量时间比较**：`MessageDigest.isEqual` 的耗时不随第一个不同字节的位置变化，避免通过响应时间逐字节猜签名
- **TTL 不宜过长**：主播点"开播"后立即推流，窗口给 10 到 30 分钟足够；断线重连超过窗口时由 App 重新申请
- **密钥轮换**：密钥前加版本号（如 `sign=v2.xxxx`），校验时按版本选密钥，轮换期间新旧并存

### 2、源站回调鉴权

以 SRS 为例，在 vhost 的 `http_hooks` 中配置 `on_publish` 指向业务服务。SRS 在客户端开始推流时以 JSON POST 回调，请求体包含 `action`、`client_id`、`ip`、`vhost`、`app`、`stream`、`param`（推流 URL 的查询串，如 `?expire=...&sign=...`）、`server_id` 等字段；**业务服务返回 HTTP 200 且 `code` 为 0 才放行**，否则 SRS 断开推流。完整配置见 [流媒体服务器](./4_media_server)。

```java
public record SrsHook(String action,
                      @JsonProperty("client_id") String clientId,
                      String ip, String vhost, String app, String stream, String param,
                      @JsonProperty("server_id") String serverId) {}

@Slf4j
@RestController
@RequestMapping("/internal/srs")
@RequiredArgsConstructor
public class SrsCallbackController {

    private final StreamSigner signer;
    private final LiveRoomService roomService;

    @PostMapping("/on_publish")
    public Map<String, Integer> onPublish(@RequestBody SrsHook hook) {
        MultiValueMap<String, String> query = parseParam(hook.param());
        String sign = query.getFirst("sign");
        long expire = parseLong(query.getFirst("expire"));
        boolean ok = sign != null
                && signer.verify(hook.app(), hook.stream(), expire, sign)
                && roomService.markLive(hook.stream(), hook.serverId(), hook.clientId());
        if (!ok) {
            log.warn("推流鉴权失败 stream={} ip={}", hook.stream(), hook.ip());
        }
        return Map.of("code", ok ? 0 : 403);
    }

    @PostMapping("/on_unpublish")
    public Map<String, Integer> onUnpublish(@RequestBody SrsHook hook) {
        roomService.markInterrupted(hook.stream(), hook.clientId());   // 先记"中断"，宽限期后再判定下播
        return Map.of("code", 0);
    }

    private static MultiValueMap<String, String> parseParam(String param) {
        if (param == null || param.length() <= 1) {
            return new LinkedMultiValueMap<>();
        }
        String q = param.startsWith("?") ? param.substring(1) : param;
        return UriComponentsBuilder.newInstance().query(q).build().getQueryParams();
    }

    private static long parseLong(String s) {
        try {
            return s == null ? 0L : Long.parseLong(s);
        } catch (NumberFormatException e) {
            return 0L;                                                // 0 一定已过期，校验自然失败
        }
    }
}
```

`roomService.markLive` 里做业务校验：房间存在且审核通过、主播未被封禁、同一 `streamKey` 当前没有另一路在推（用 Redis `SET live:pusher:{streamKey} {clientId} NX EX 60` 占位，推流期间定时续期），全部满足才把房间置为"直播中"并发布开播事件。

几条工程约束：

- **回调接口只对内网开放**：路径放在 `/internal/` 下，网关不对外暴露，并校验来源 IP 或在回调 URL 中带上内部令牌
- **回调要快**：SRS 同步等待回调结果，业务服务内只做 Redis 级别的校验，耗时操作（发通知、写统计）发到消息队列异步处理
- **断流宽限期**：`on_unpublish` 不立刻判定下播，主播网络抖动重连很常见，宽限 30 到 60 秒内重新 `on_publish` 视为续播，观众侧播放器自动重试即可

---

## 四、播放防盗链

推流防冒用，播放防盗链。三层手段由弱到强：

| 手段 | 做法 | 局限 |
|------|------|------|
| Referer 白名单 | CDN 只放行来自本站域名的 Referer | App 和播放器可以伪造或不带 Referer，只能挡住简单的网页嵌入 |
| URL 签名鉴权 | 播放地址带过期时间和签名，CDN 边缘校验 | 地址在有效期内仍可被转发，需配合较短的有效期 |
| 业务层鉴权 | 付费直播在进房接口校验权益后才签发播放地址，并限制同一账号并发观看数 | 需要业务配合，实现成本最高 |

**URL 签名由 CDN 边缘校验，Java 后端只负责生成**，具体算法以所用 CDN 的文档为准。以阿里云 CDN 的 A 型鉴权为例：

- 地址格式：`https://play.example.com/live/room1001_720p.flv?auth_key={timestamp}-{rand}-{uid}-{md5hash}`
- `md5hash = MD5("{URI}-{timestamp}-{rand}-{uid}-{PrivateKey}")`，`rand` 一般用去掉连字符的 UUID，`uid` 不用时填 0
- CDN 以 `timestamp + 控制台配置的有效时长` 判断是否过期，过期或签名不符返回 403

```java
@Component
public class PlayUrlSigner {

    private final String privateKey;

    public PlayUrlSigner(@Value("${live.cdn.auth-key}") String privateKey) {
        this.privateKey = privateKey;
    }

    /** uri 形如 /live/room1001_720p.flv，必须以 / 开头，含非 ASCII 字符时先做 URL 编码 */
    public String sign(String uri) {
        long timestamp = Instant.now().getEpochSecond();
        String rand = UUID.randomUUID().toString().replace("-", "");
        String uid = "0";
        String md5 = md5Hex(uri + "-" + timestamp + "-" + rand + "-" + uid + "-" + privateKey);
        return "https://play.example.com" + uri
                + "?auth_key=" + timestamp + "-" + rand + "-" + uid + "-" + md5;
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

注意 HLS 的特殊性：播放器先请求 `.m3u8`，再按列表请求每个 `.ts` / `.m4s` 切片，切片 URL 是相对路径，**不会自动带上 m3u8 的鉴权参数**。需要确认 CDN 支持对 m3u8 内的切片地址做鉴权参数改写，或采用按目录、按 Cookie 鉴权的模式，否则会出现"列表能拉到、切片全部 403"。

---

## 五、转码与多码率

### 1、码率阶梯

观众网络差异很大，只提供原画会让弱网用户一直卡顿。转码集群把主播的原始流转成多档码率（码率阶梯，bitrate ladder），下表是 H.264 直播的常见参考值，实际取值要按内容复杂度调整：

| 档位 | 分辨率 | 帧率 | 视频码率参考 | 用途 |
|------|--------|------|--------------|------|
| 原画 | 主播推流原样 | 原样 | 主播决定 | 不转码，只转封装 |
| 超清 | 1920×1080 | 30 | 3 到 4.5 Mbps | Wi-Fi / 大屏 |
| 高清 | 1280×720 | 30 | 1.5 到 2.5 Mbps | 默认档 |
| 标清 | 854×480 | 25 到 30 | 0.8 到 1.2 Mbps | 4G 弱网 |
| 流畅 | 640×360 | 25 | 0.4 到 0.7 Mbps | 极弱网、省流量 |

几条规则：

- **GOP 对齐**：所有档位使用相同的关键帧间隔（通常 2 秒），播放器切换码率时才能在关键帧处无缝衔接；切片时长也应是 GOP 的整数倍
- **按需转码**：转码是 CPU / GPU 密集型操作，成本远高于转发。冷门直播间只提供原画，观看人数超过阈值后再启动多档转码，由业务服务根据在线人数下发转码任务
- **编码选择**：H.264 兼容性最好；H.265 / AV1 同画质可节省 30% 以上码率，但要确认播放端解码能力，常见做法是为支持的终端额外提供一路

FFmpeg 多码率输出、硬件编码与参数调优见 [FFmpeg 与转码](./3_ffmpeg)。

### 2、自适应码率播放

HLS 的主播放列表（master playlist）列出所有档位，播放器根据测得的带宽自动选择：

```text
#EXTM3U
#EXT-X-VERSION:3
#EXT-X-STREAM-INF:BANDWIDTH=4800000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2"
1080p/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2800000,RESOLUTION=1280x720,CODECS="avc1.64001f,mp4a.40.2"
720p/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=1400000,RESOLUTION=854x480,CODECS="avc1.64001e,mp4a.40.2"
480p/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,CODECS="avc1.42c01e,mp4a.40.2"
360p/index.m3u8
```

`BANDWIDTH` 是该档位的峰值总码率（视频 + 音频 + 封装开销），单位 bit/s。HTTP-FLV 没有主播放列表，清晰度切换由 App 根据卡顿统计主动换地址。

---

## 六、延迟分级

"直播延迟"指主播端画面发生到观众端看到的时间，由采集编码、推流、转码、分发、播放缓冲累加而成。按协议可分为几档：

| 档位 | 典型协议 | 端到端延迟（量级） | CDN 支持 | 适用场景 |
|------|----------|--------------------|----------|----------|
| 实时互动 | WebRTC（WHEP / 私有信令） | 1 秒以内 | 需要支持 WebRTC 的专门网络 | 连麦、直播带货抢购、互动课堂、竞拍 |
| 低延迟 | HTTP-FLV、RTMP 播放 | 2 到 5 秒 | 主流 CDN 支持，浏览器需 flv.js / mpegts.js 播放 | 秀场、游戏直播的默认档 |
| 低延迟 HLS | LL-HLS、低延迟 DASH | 2 到 5 秒 | 需要 CDN 支持分块传输 | 需要 iOS 原生播放、又想降低延迟 |
| 标准 | HLS、DASH | 10 到 30 秒 | 所有 CDN，缓存友好 | 赛事、发布会、大规模分发，对互动要求低 |

选型思路：

- **延迟要求决定协议，规模决定成本**：WebRTC 分发需要大量 SFU 节点承载长连接，单位观众成本显著高于 HTTP 分发，只在"必须实时互动"的场景使用
- **同一路流多协议输出**：源站同时输出 FLV 和 HLS，App 用 FLV 追求低延迟，浏览器和 iOS 用 HLS 保证兼容
- **降低 HLS 延迟的手段**：缩短切片时长（如 2 秒）、减少播放器起播缓冲的切片数、使用 LL-HLS 的部分切片（partial segment）；切片越短，CDN 请求数越多，回源压力越大
- **业务时间对齐**：抢购、竞拍类玩法不要依赖"观众看到画面的时刻"，以服务端时间为准，画面只做展示

---

## 七、录制与回放

直播结束后的回放是点播内容的主要来源，录制有两种方式：

| 方式 | 做法 | 优缺点 |
|------|------|--------|
| 源站切片录制 | 源站输出 HLS 时同时把切片和 m3u8 上传到对象存储，`on_hls` 回调通知业务 | 切片即录制，直播结束马上可回放；文件数多 |
| DVR 整段录制 | 源站把流录成 FLV / MP4 文件，`on_dvr` 回调通知文件路径 | 文件完整，便于后期剪辑；需要额外上传与转封装 |

Java 后端负责的部分：

1. **回调落库**：`on_hls` / `on_dvr` 回调里只记录"哪个流、哪个文件、时间范围"，写入录制分片表，立即返回
2. **任务下发**：下播后，业务服务把"生成回放"任务发到消息队列（如 Kafka），由转码 worker 合并切片、转封装成 MP4、生成封面与多码率点播流，完成后回调业务服务更新回放状态。任务队列的选型见 [消息队列](/messaging/0_overview)
3. **存储与生命周期**：录制文件写入对象存储，按热度设置生命周期（如 30 天后转低频存储，180 天后删除），大文件上传与分片见 [对象存储](/architecture/4_object_storage)
4. **审核与剪辑**：违规片段从回放中删除或打码，精彩片段剪辑成短视频，后续流程见 [点播与短视频](./7_vod)

直播过程中的**时移回看**（观众把进度条拖回几分钟前）依赖源站保留最近一段时间的切片，HLS 的 `EXT-X-PLAYLIST-TYPE:EVENT` 播放列表会保留从开播起的全部切片，适合较短的直播；长时间直播通常只保留滑动窗口。

---

## 八、弹幕、礼物与在线人数

### 1、弹幕与礼物

弹幕本质上是**按房间广播的群聊**，但和 IM 的群聊有几点不同：不要求可靠送达（错过一条无所谓），不需要离线消息，单房间人数可达数十万，写少读极多。复用 IM 的长连接网关与路由能力，在此基础上做三点调整（IM 的整体设计见 [即时通讯](/scenario/16_im)）：

- **只推不存**：弹幕写入后按房间广播，只保留最近 N 条供新进房的观众拉取；需要回放弹幕时，按"相对开播时间"存入时序存储，回放时按播放进度拉取
- **合并下发**：热门房间每秒数千条弹幕，逐条推送会把网关和客户端都打满。按房间每 200 到 500 毫秒合并一批推送，超过阈值时按用户等级、礼物优先进行采样丢弃
- **先审后发**：敏感词过滤同步做，图片和高风险内容异步审核；被禁言用户在发送接口直接拒绝

礼物涉及扣费，**必须走可靠链路**：先在交易服务完成扣款（幂等，见 [支付系统](/scenario/14_payment)），成功后再发礼物消息到房间广播；广播丢失只影响特效展示，不影响账目。

### 2、在线人数与热门房间

在线人数要求"大致准确、实时更新"，常见做法是心跳 + 有序集合：

```text
# 观众每 30 秒上报一次心跳，score 为毫秒时间戳
ZADD live:online:room1001 1760054400000 user:42
# 定时清理 90 秒未心跳的观众
ZREMRANGEBYSCORE live:online:room1001 0 1760054310000
# 当前在线人数
ZCARD live:online:room1001
# 热门榜：按热度分值排序，热度 = 在线人数、礼物、弹幕的加权和，由定时任务刷新
ZADD live:hot 98213 room1001
ZREVRANGE live:hot 0 49 WITHSCORES
```

- **超大房间**：单个 ZSET 承载几十万成员会成为热点 key，按用户 ID 哈希拆成多个分片 key 分别计数再求和，热点计数的分片与降级见 [计数系统](/scenario/17_counter)
- **展示值与真实值分离**：前端展示的人数由服务端每隔几秒推送一次聚合值，不要让每个观众都去 `ZCARD`
- **累计观看人次**用 HyperLogLog（`PFADD` / `PFCOUNT`）去重统计，内存固定，误差约 0.81%

---

## 九、连麦

连麦是主播与观众或主播之间的实时音视频互动，延迟要求在 1 秒以内，只能用 WebRTC。典型架构：

1. **连麦房间**：主播开启连麦时，业务服务在 SFU（如 LiveKit）创建一个与直播间对应的 RTC 房间，并为主播和被邀请的连麦者签发带发布权限的 token
2. **实时互动**：主播与连麦者通过 SFU 互相收发音视频，延迟在几百毫秒量级
3. **合流转推**：普通观众仍然看 CDN 直播。由 SFU 的合流 / 转推能力（如 LiveKit Egress、MCU 合流服务）把多路画面按布局合成一路，以 RTMP 推回源站，替换原来主播的单路流
4. **布局变化**：连麦者上下麦时，业务服务调用合流服务更新布局；观众端看到的仍是同一路直播流，无需切换地址

注意两个细节：合流转推期间，主播原始推流要停止或切换，否则源站会有两路相同 streamKey 的推流冲突；合流画面比 SFU 内的互动画面多出转码和 CDN 的延迟，观众看到的连麦比主播实际对话晚几秒，属于正常现象。WebRTC 的信令、TURN 与 SFU 选型见 [WebRTC 实时通信](./5_webrtc)。

---

## 十、流健康监控与故障切换

### 1、监控什么

| 层级 | 指标 | 数据来源 |
|------|------|----------|
| 推流端 | 推流码率、帧率、丢帧数、推流 RTT | 主播端 SDK 上报 |
| 源站 | 入流码率是否稳定、关键帧间隔、音视频时间戳是否连续、断流次数 | 流媒体服务器 HTTP API（如 SRS 的 `/api/v1/streams/`）、Prometheus 导出器 |
| 转码 | 各档位输出码率、转码延迟、转码进程存活 | 转码 worker 上报 |
| CDN | 回源带宽、边缘 4xx / 5xx 比例、首包时间 | CDN 厂商日志与监控 API |
| 播放端 | 首帧时间、卡顿率（每百秒卡顿次数）、播放失败率、端到端延迟 | 播放器 SDK 埋点上报 |

播放端的卡顿率和首帧时间最接近用户体验，是告警的首要指标；源站入流码率突降为 0 或长时间低于阈值，通常意味着主播网络出了问题。指标与告警的建设方法见 [指标监控](/observability/2_metrics)。

### 2、故障切换

| 故障 | 发现方式 | 切换方式 |
|------|----------|----------|
| 主播网络抖动 | 入流码率持续低于阈值、`on_unpublish` 后短时间内重连 | App 提示主播并自动降低推流码率；宽限期内续播 |
| 主播端彻底断流 | 宽限期内未重新推流 | 播放垫片（"主播暂时离开"画面），超时后判定下播 |
| 重要直播单路风险 | 赛事、发布会等事先识别 | 主备双推流：编码器同时推两个不同源站，源站检测主流中断后切到备流，观众无感 |
| 源站节点宕机 | 健康检查失败、推流批量中断 | 推流域名解析到多个接入节点，主播端重连到其他节点；源站集群多可用区部署 |
| CDN 区域故障 | 某区域播放失败率上升 | 业务服务签发播放地址时切换到备用 CDN 厂商（多 CDN 调度），播放器失败时按地址列表重试 |

多 CDN 调度的落点在 Java 后端：进房接口按用户地域、运营商和各 CDN 的实时质量评分返回播放地址列表，播放器按顺序尝试。冗余与切换的通用原则见 [冗余与故障转移](/high-avail/2_redundancy_failover)。

---

## 小结

- 直播的数据面（推流、转码、分发）交给流媒体集群和 CDN，Java 后端负责控制面：开播与签名、回调鉴权、播放地址签发、任务编排和互动功能
- 推流地址用 `HMAC-SHA256(密钥, 路径:过期时间)` 签名，源站 `on_publish` 回调中常量时间校验，并用 Redis 占位防止同一 streamKey 多路推流；回调接口只对内网开放且要快
- 播放防盗链以 CDN 的 URL 签名鉴权为主，后端按厂商算法生成；HLS 要确认切片地址同样带鉴权
- 转码输出 GOP 对齐的码率阶梯，按热度按需启动；HLS 用主播放列表实现自适应码率
- 延迟按场景分档：连麦和抢购用 WebRTC，常规直播用 HTTP-FLV 或 LL-HLS，大规模分发用标准 HLS
- 录制靠切片上传或 DVR 回调，回放生成通过消息队列异步编排；弹幕复用 IM 网关但只推不存、合并下发，礼物先扣费再广播；在线人数用心跳 + ZSET，超大房间分片计数
- 连麦在 SFU 内实时互动，合流后转推回源站给普通观众；监控以播放端卡顿率与首帧时间为核心，关键直播主备双推，多 CDN 由后端调度

## 参考资料

- SRS HTTP 回调：[SRS HTTP Callback](https://ossrs.net/lts/en-us/docs/v6/doc/http-callback)
- SRS HTTP API：[SRS HTTP API](https://ossrs.net/lts/en-us/docs/v6/doc/http-api)
- HLS 规范：[RFC 8216 - HTTP Live Streaming](https://www.rfc-editor.org/rfc/rfc8216)
- 低延迟 HLS：[Apple - Enabling Low-Latency HLS](https://developer.apple.com/documentation/http-live-streaming/enabling-low-latency-http-live-streaming-hls)
- HLS 码率阶梯建议：[Apple - HTTP Live Streaming (HLS) Authoring Specification](https://developer.apple.com/documentation/http-live-streaming/hls-authoring-specification-for-apple-devices)
- CDN URL 鉴权示例：[阿里云 CDN - A 型鉴权](https://help.aliyun.com/en/cdn/user-guide/type-a-signing)
- HMAC：[RFC 2104 - HMAC: Keyed-Hashing for Message Authentication](https://www.rfc-editor.org/rfc/rfc2104)
- WHIP：[RFC 9725 - WebRTC-HTTP Ingestion Protocol](https://www.rfc-editor.org/rfc/rfc9725)
- LiveKit 合流与转推：[LiveKit Egress](https://docs.livekit.io/home/egress/overview/)
- Redis 有序集合与 HyperLogLog：[Redis Sorted Sets](https://redis.io/docs/latest/develop/data-types/sorted-sets/)、[Redis HyperLogLog](https://redis.io/docs/latest/develop/data-types/probabilistic/hyperloglogs/)

> 下一篇：[点播与短视频](./7_vod)
