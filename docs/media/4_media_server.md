---
description: 流媒体服务器职责、SRS / ZLMediaKit / MediaMTX 选型、HTTP 回调鉴权、DVR 录制归档、源站与边缘集群、监控 API
---

# 流媒体服务器

> 前置阅读：[流媒体协议](./2_protocols)、[FFmpeg 与转码](./3_ffmpeg)

流媒体服务器是主播推流和观众播放之间负责收流、转协议、分发和录制的中转站。本篇讲选型、HTTP 回调鉴权、录制归档、集群与监控，基线为 SRS 6.0。

---

## 一、流媒体服务器做什么

主播用 OBS 推上来的是一路 RTMP 或 SRT，观众在浏览器里看的是 HTTP-FLV、HLS 或 WebRTC。Java 后端不碰媒体数据，而是通过回调和管理 API 与流媒体服务器协作。本篇以 SRS 6.0（当前稳定版 v6.0-r2，SRS 7 处于 alpha）为主线，示例统一用一个直播平台：主播申请开播 → 拿到带签名的推流地址 → 推流时服务器回调业务鉴权 → 观众按房间号播放 → 下播后录像归档到对象存储，转成点播回放。

流媒体服务器是 C++ / Go 写的高性能网络程序，直接处理音视频包；谁能推流、谁能看、什么时候开播下播、录像存到哪里，都由业务服务决定。

| 职责 | 说明 | 业务服务在其中的角色 |
|------|------|----------------------|
| 接入（Ingest） | 接收 RTMP、SRT、WebRTC（WHIP）、RTSP、GB28181 推流或主动拉流 | 签发推流地址与 token，回调中鉴权 |
| 转协议 / 转封装 | 一路 RTMP 输入，同时输出 HTTP-FLV、HLS、WebRTC，通常不重新编码 | 决定房间开哪些输出 |
| 分发 | 源站把流推给边缘或 CDN，就近服务观众 | 调度：给观众返回哪个域名 / 节点 |
| 录制（DVR） | 把直播流写成 FLV / MP4 / HLS 文件 | 回调中拿到文件，归档到对象存储、生成回放 |
| 事件回调 | 推流、断流、播放、停止播放、录制完成时调用业务 HTTP 接口 | 维护房间状态、计数、计费 |
| 管理 API | 查询流和客户端列表、踢掉某个推流 | 封禁主播、对账在线状态 |

边界划分的原则是：**媒体面**（包的收发、协议转换、缓存 GOP 实现秒开）交给流媒体服务器，**控制面**（鉴权、状态、计费、调度）留在业务服务。不要试图用 Java 去中转音视频数据，也不要把业务逻辑写进流媒体服务器的配置里。

需要实时转码（例如主播推 1080p、给观众输出 720p / 480p 多档）时，流媒体服务器本身一般不做，而是由它触发或由业务调度一个 FFmpeg 转码进程，拉源流转码后再推回服务器，见 [FFmpeg 与转码](./3_ffmpeg)。

---

## 二、SRS、ZLMediaKit 与 MediaMTX

三者都是活跃的开源项目，许可证都以 MIT 为主，适用场景各有侧重：

| 维度 | SRS | ZLMediaKit | MediaMTX |
|------|-----|-----------|----------|
| 语言 | C++（协程，基于 State Threads） | C++11 | Go |
| 许可证 | MIT（部分第三方库按各自许可证） | 项目自身代码 MIT；包含部分第三方代码，商用前需自行核查 | MIT |
| 主要协议 | RTMP、WebRTC（WHIP / WHEP）、HLS、HTTP-FLV、HTTP-TS、SRT、MPEG-DASH、GB28181 | RTSP、RTMP、HLS、HTTP-FLV、WebSocket-FLV、HTTP-TS / fMP4、GB28181、SRT、WebRTC | RTSP、RTMP、HLS、WebRTC、SRT、MPEG-TS、RTP |
| 业务回调 | `http_hooks`：`on_publish`、`on_unpublish`、`on_play`、`on_stop`、`on_dvr`、`on_hls` | `[hook]`：`on_publish`、`on_play`、`on_record_mp4`、`on_stream_none_reader` 等 | `authMethod: http` 外部鉴权；`runOnXxx` 在事件发生时执行外部命令 |
| 管理 API | HTTP API（默认 1985） | RESTful API（`/index/api/*`，带 secret） | Control API（默认 `:9997`，需开启） |
| 指标 | Prometheus exporter（默认 9972） | 统计类 API | Prometheus 指标（默认 `:9998`，需开启） |
| 录制 | DVR 写 FLV / MP4 | MP4 / HLS 录制 | fMP4 / MPEG-TS 分段录制 |
| 集群 | 边缘回源 + 源站集群 | 拉流代理、转推组网 | 无内置集群，靠拉流级联 |
| 擅长场景 | 互联网直播、WebRTC 连麦 | 安防监控、协议转换，GB28181 / RTSP 最全 | 轻量单文件部署、摄像头 RTSP 转发、边缘与 IoT |

选型建议：

- **互联网直播（秀场、电商、教育）**：SRS。RTMP / HTTP-FLV / HLS / WebRTC 都成熟，有边缘集群和完整的回调体系，中文文档和社区活跃
- **监控视频接入**：ZLMediaKit。GB28181、RTSP 拉流、按需拉流（无人观看自动断开）是它的强项，见 [监控视频接入](./8_video_surveillance)
- **少量摄像头转发、边缘盒子、开发测试**：MediaMTX。一个二进制加一个 YAML 就能跑，RTSP 转 WebRTC / HLS 给浏览器看非常方便
- 云厂商的直播服务（推流域名 + 播放域名 + CDN）适合不想运维媒体集群的团队，回调与鉴权模型和自建大同小异，本篇的 Java 侧设计同样适用

::: tip 版本线
SRS 用"大版本 + 阶段"标记成熟度：`r` 是稳定版，`a` / `b` 是 alpha / beta，`d` 是开发版。生产用最新的 `r` 版本（当前 v6.0-r2）。SRS 7 重做了源站集群（见第六节），稳定前不建议上生产。
:::

---

## 三、快速起一个 SRS

```bash
docker run -d --name srs -p 1935:1935 -p 1985:1985 -p 8080:8080 \
  -v $(pwd)/srs.conf:/usr/local/srs/conf/srs.conf \
  ossrs/srs:6 ./objs/srs -c conf/srs.conf
```

一份覆盖本篇内容的最小配置：

```nginx
listen              1935;
max_connections     1000;
daemon              off;
srs_log_tank        console;

http_api {
    enabled         on;
    listen          1985;
}

http_server {
    enabled         on;
    listen          8080;
    dir             ./objs/nginx/html;
}

exporter {
    enabled         on;
    listen          9972;
}

vhost __defaultVhost__ {
    # RTMP 转 HTTP-FLV：http://host:8080/live/room_1001.flv
    http_remux {
        enabled     on;
        mount       [vhost]/[app]/[stream].flv;
    }
    # RTMP 切 HLS：http://host:8080/live/room_1001.m3u8
    hls {
        enabled         on;
        hls_fragment    2;
        hls_window      20;
        hls_path        ./objs/nginx/html;
        hls_m3u8_file   [app]/[stream].m3u8;
        hls_ts_file     [app]/[stream]-[seq].ts;
    }
    http_hooks {
        enabled         on;
        on_publish      http://live-service.internal:8080/internal/srs/hooks/publish;
        on_unpublish    http://live-service.internal:8080/internal/srs/hooks/unpublish;
        on_play         http://live-service.internal:8080/internal/srs/hooks/play;
        on_dvr          http://live-service.internal:8080/internal/srs/hooks/dvr;
    }
    dvr {
        enabled             on;
        dvr_apply           all;
        dvr_plan            session;
        dvr_path            ./objs/dvr/[app]/[stream]/[2006][01][02]/[timestamp].flv;
    }
}
```

推流与播放（流名 `room_1001`，token 由业务签发）：

```bash
ffmpeg -re -i demo.flv -c copy -f flv "rtmp://localhost/live/room_1001?expire=1791590400&token=3f9c..."

# 播放
# RTMP:     rtmp://localhost/live/room_1001
# HTTP-FLV: http://localhost:8080/live/room_1001.flv
# HLS:      http://localhost:8080/live/room_1001.m3u8
```

`hls_fragment` 是切片时长（秒），实际切点落在关键帧上，所以推流端 GOP 要与之匹配（2 秒 GOP 对 2 秒切片）。HLS 的延迟大约是"切片时长 × 播放器缓冲片数"，通常 6～10 秒；要秒级延迟用 HTTP-FLV，要亚秒级用 WebRTC，见 [WebRTC 实时通信](./5_webrtc)。

---

## 四、HTTP 回调：鉴权与状态

### 1、SRS 回调的约定

SRS 在事件发生时向配置的 URL 发 `POST` 请求，请求体是 JSON。以 `on_publish` 为例：

```json
{
  "server_id": "vid-0xk989d",
  "action": "on_publish",
  "client_id": "341w361a",
  "ip": "203.0.113.10",
  "vhost": "__defaultVhost__",
  "app": "live",
  "tcUrl": "rtmp://push.live.example.com/live",
  "stream": "room_1001",
  "param": "?expire=1791590400&token=3f9c...",
  "stream_url": "/live/room_1001",
  "stream_id": "vid-124q9y3"
}
```

| 回调 | 时机 | 额外字段 | 业务用途 |
|------|------|----------|----------|
| `on_publish` | 开始推流 | — | 校验推流 token，房间置为直播中 |
| `on_unpublish` | 停止推流 | — | 房间置为已下播，结算时长 |
| `on_play` | 开始播放 | `pageUrl` | 付费 / 私密直播的播放鉴权 |
| `on_stop` | 停止播放 | — | 观看时长统计 |
| `on_dvr` | 一个录制文件写完 | `cwd`、`file` | 归档到对象存储 |
| `on_hls` | 一个 HLS 切片写完 | 切片路径、时长等 | 切片上传，做直播转点播 |

**响应约定**：HTTP 状态码 200，并且响应体为整数 `0` 或 JSON `{"code": 0}` 才算允许；状态码不是 200 或 `code` 非 0 时，SRS 断开这个客户端。也就是说 `on_publish` 返回 `{"code": 403}` 就能拒绝推流。

几点必须清楚：

- **回调是同步阻塞的**：推流 / 播放要等回调返回才继续，接口必须快（几十毫秒以内），慢操作（写日志库、发通知）异步做
- **token 放在 `param` 里**：推流地址上的查询串原样出现在 `param` 字段，业务自己解析；SRS 不做签名校验
- **回调本身没有签名**：任何能访问回调地址的人都能伪造请求。回调接口只暴露在内网（单独的端口或路径前缀，网关不转发 `/internal/**`），并用网络策略限制只有流媒体服务器能访问
- **回调可能丢**：流媒体服务器崩溃或网络中断时，`on_unpublish` 可能永远不会到达，房间会一直显示"直播中"。必须配合第七节的 API 对账兜底

### 2、推流地址签名

主播点"开播"时，业务服务生成带过期时间和 HMAC 签名的推流地址；签名方案与通用接口签名一致，原理见 [API 安全](/security/6_api_security) 第三节：

```java
@Component
public class StreamTokenService {

    private final byte[] secret;

    public StreamTokenService(@Value("${live.push-secret}") String secret) {
        this.secret = secret.getBytes(StandardCharsets.UTF_8);
    }

    /** 推流地址：rtmp://push.live.example.com/live/{stream}?expire=..&token=.. */
    public String pushUrl(String stream, Duration ttl) {
        long expire = Instant.now().plus(ttl).getEpochSecond();
        return "rtmp://push.live.example.com/live/%s?expire=%d&token=%s"
                .formatted(stream, expire, sign(stream, expire));
    }

    public boolean verify(String stream, String expire, String token) {
        if (stream == null || expire == null || token == null) {
            return false;
        }
        long exp;
        try {
            exp = Long.parseLong(expire);
        } catch (NumberFormatException e) {
            return false;
        }
        if (Instant.now().getEpochSecond() > exp) {
            return false;
        }
        byte[] expected = sign(stream, exp).getBytes(StandardCharsets.US_ASCII);
        return MessageDigest.isEqual(expected, token.getBytes(StandardCharsets.US_ASCII));   // 常量时间比较
    }

    private String sign(String stream, long expire) {
        try {
            Mac mac = Mac.getInstance("HmacSHA256");   // Mac 非线程安全，每次新建
            mac.init(new SecretKeySpec(secret, "HmacSHA256"));
            return HexFormat.of().formatHex(mac.doFinal((stream + ":" + expire).getBytes(StandardCharsets.UTF_8)));
        } catch (GeneralSecurityException e) {
            throw new IllegalStateException(e);
        }
    }
}
```

流名使用房间号而不是主播 ID，过期时间只在开始推流时校验，推流中途到期不会被断开；主播断线重连时如果 token 已过期，需要重新从 App 获取。

### 3、Spring Boot 回调控制器

```java
@JsonIgnoreProperties(ignoreUnknown = true)
public record SrsHookEvent(
        String action,
        @JsonProperty("server_id") String serverId,
        @JsonProperty("client_id") String clientId,
        String ip,
        String vhost,
        String app,
        String stream,
        String param,
        @JsonProperty("stream_url") String streamUrl,
        @JsonProperty("stream_id") String streamId,
        String tcUrl,
        String pageUrl,
        String cwd,
        String file) {
}
```

```java
@RestController
@RequestMapping("/internal/srs/hooks")
public class SrsHookController {

    private static final Map<String, Integer> ALLOW = Map.of("code", 0);
    private static final Map<String, Integer> DENY = Map.of("code", 403);

    private final StreamTokenService tokens;
    private final LiveRoomService rooms;
    private final RecordingEventPublisher recordings;

    public SrsHookController(StreamTokenService tokens, LiveRoomService rooms,
                             RecordingEventPublisher recordings) {
        this.tokens = tokens;
        this.rooms = rooms;
        this.recordings = recordings;
    }

    @PostMapping("/publish")
    public Map<String, Integer> onPublish(@RequestBody SrsHookEvent e) {
        Map<String, String> q = queryOf(e.param());
        boolean allowed = "live".equals(e.app())
                && tokens.verify(e.stream(), q.get("expire"), q.get("token"))
                && rooms.startLive(e.stream(), e.clientId(), e.serverId(), e.ip());
        return allowed ? ALLOW : DENY;
    }

    @PostMapping("/unpublish")
    public Map<String, Integer> onUnpublish(@RequestBody SrsHookEvent e) {
        rooms.endLive(e.stream(), e.clientId());   // 只结束 client_id 匹配的那次推流
        return ALLOW;
    }

    @PostMapping("/play")
    public Map<String, Integer> onPlay(@RequestBody SrsHookEvent e) {
        Map<String, String> q = queryOf(e.param());
        return rooms.canWatch(e.stream(), q.get("ticket")) ? ALLOW : DENY;
    }

    @PostMapping("/dvr")
    public Map<String, Integer> onDvr(@RequestBody SrsHookEvent e) {
        Path file = Path.of(e.cwd()).resolve(e.file()).normalize();   // file 可能是相对 cwd 的路径
        recordings.publish(new RecordingCompleted(e.serverId(), e.app(), e.stream(), file.toString()));
        return ALLOW;                                                  // 只投递消息，不在回调里上传
    }

    private static Map<String, String> queryOf(String param) {
        if (param == null || param.isBlank()) {
            return Map.of();
        }
        String query = param.startsWith("?") ? param.substring(1) : param;
        return UriComponentsBuilder.newInstance().query(query).build()
                .getQueryParams().toSingleValueMap();
    }
}
```

`@JsonProperty` / `@JsonIgnoreProperties` 来自 `com.fasterxml.jackson.annotation`，Spring Boot 4 默认的 Jackson 3 仍沿用这个注解包。`ignoreUnknown` 让 SRS 升级后新增字段不影响反序列化。

业务服务里两个容易写错的地方：

- **开播要防"一个房间两路推流"**：单台 SRS 会拒绝同名流的第二个推流者，但在多台源站时两路推流可能落到不同机器。`startLive` 用条件更新实现：`UPDATE live_room SET status='LIVE', publisher_client_id=?, origin_server_id=? WHERE stream_key=? AND status IN ('IDLE','ENDED')`，影响行数为 0 就拒绝
- **下播要校验 `client_id`**：主播网络抖动重连时，新连接的 `on_publish` 可能先于旧连接的 `on_unpublish` 到达。`endLive` 带上 `WHERE publisher_client_id = ?`，旧连接的下播事件就不会把新开的直播关掉

观众播放的 `ticket` 是业务给已登录、已付费观众签发的短期票据，思路与推流 token 相同；免费公开的直播可以不配 `on_play`，把鉴权放在 CDN 的 URL 签名上，避免每个观众都打一次业务接口。

### 4、其他服务器的回调差异

| 服务器 | 鉴权回调 | 允许的响应 | 录制完成 |
|--------|----------|------------|----------|
| SRS | `on_publish` / `on_play` | HTTP 200 且 `code` 为 0 | `on_dvr`，字段 `cwd` + `file` |
| ZLMediaKit | `on_publish` / `on_play`，字段含 `schema`、`params`、`mediaServerId` | `{"code": 0}`；`on_publish` 还能在响应里按流开关 HLS / MP4 录制 | `on_record_mp4`，字段含 `file_path`、`file_size`、`time_len` |
| MediaMTX | `authHTTPAddress` 指向的接口，每个动作（推流、播放、API 调用）都会请求 | 返回 2xx 即允许 | 无 HTTP 回调，用 `runOnRecordSegmentComplete` 执行命令 |

---

## 五、录制归档到对象存储

直播录像有两种做法：

| 方式 | 配置 | 产物 | 适用 |
|------|------|------|------|
| DVR 录制 | `dvr` 段，`dvr_plan session` 或 `segment` | 一场直播一个 FLV / MP4，或按时长分段 | 完整回放、审核留档 |
| HLS 切片上传 | `on_hls` 回调逐片上传 | `.ts` 切片 + 播放列表 | 直播结束立即可回放（直播转点播） |

`dvr_plan session` 在断流时结束一个文件，长时间直播会产生一个很大的文件；`segment` 按 `dvr_duration`（秒）切分，配合 `dvr_wait_keyframe on` 在关键帧处切，单个文件小、上传失败重传代价低，推荐 `segment` + 30 分钟左右一段。SRS 的 MP4 录制有已知问题，常用做法是录 FLV，归档时用 `ffmpeg -c copy` 转封装成 MP4。

归档流程：

1. SRS 写完一个文件，发 `on_dvr` 回调，业务服务只投递一条"录制完成"消息就返回
2. **运行在 SRS 同一台机器上的归档进程**（或 Kubernetes 中同 Pod 的 sidecar）消费消息，因为只有它能读到本地文件；也可以挂共享存储，但直播写入量大时不推荐
3. 归档进程按需转封装为 MP4，用分片上传写入对象存储，key 形如 `live-records/room_1001/20261010/1791590400.mp4`，分片上传与断点续传见 [对象存储](/architecture/4_object_storage)
4. 上传成功后回写录像记录（房间、开始时间、时长、对象 key），再删除本地文件；上传失败保留文件并重试，磁盘水位告警兜底
5. 需要多码率回放时，把对象 key 交给点播转码流水线（[FFmpeg 与转码](./3_ffmpeg) 第五节）

对象存储侧配置生命周期规则：录像 30 天后转低频存储、180 天后删除（按业务和合规要求定）。回放地址给观众时使用带过期时间的签名 URL 或 CDN 鉴权，不要暴露永久公开链接。

---

## 六、集群：源站、边缘与 CDN

![源站 + 边缘 + CDN 分发结构](../assets/media/media-server-origin-edge.svg)

单台流媒体服务器的瓶颈是出口带宽：一路 2Mbps 的直播有一万人看，就是 20Gbps。分发靠分层：

- **源站（Origin）**：接收主播推流，负责录制、切片和回调。源站数量取决于"同时在推的流数"
- **边缘（Edge）**：SRS 的边缘在观众第一次请求某路流时回源拉取，之后同一边缘上的所有观众共享这一路回源连接；主播也可以推到边缘，由边缘转推给源站。边缘可以配置多个源站，当前源站故障时自动切换下一个

```nginx
# 边缘节点配置
vhost __defaultVhost__ {
    cluster {
        mode            remote;
        origin          origin-1.internal:1935 origin-2.internal:1935;
    }
}
```

- **源站集群**：多个源站时，边缘需要知道某路流在哪台源站上。SRS 6 及以前用源站之间互相查询（MESH）的方式；SRS 7 改成独立的 `srs-proxy`，由代理把推流和播放负载均衡到一组互不同步状态的源站，多个代理可以通过 Redis 共享状态，源站可以作为普通的无状态 Deployment 部署在 Kubernetes 上
- **CDN**：HLS 是普通的 HTTP 文件，直接交给 CDN 缓存最省事（m3u8 设短缓存、切片设长缓存）；HTTP-FLV 需要 CDN 支持长连接流式回源，各家直播 CDN 都支持。也可以让源站用 `forward` 或 FFmpeg 把流转推到云厂商的直播 CDN，自建只做接入和录制。边缘缓存与 HTTP 缓存头见 [Cloudflare 边缘服务](/cloud-native/16_cloudflare)

调度由业务服务做：观众进房间时，业务根据地域、运营商和各节点负载返回播放地址（例如 `https://hz-edge.live.example.com/live/room_1001.flv`）；主播开播时返回就近的推流接入点。直播系统整体的调度、连麦、弹幕设计见 [直播系统设计](./6_live_streaming)，弹幕消息通道见 [即时通讯](/scenario/16_im)。

---

## 七、监控与管理 API

### 1、SRS HTTP API

| 接口 | 作用 |
|------|------|
| `GET /api/v1/summaries` | 服务器 CPU、内存、网络、负载概况 |
| `GET /api/v1/streams?start=0&count=100` | 当前流列表：推流客户端、码率、编码信息、观众数；默认只返回 10 条，要分页 |
| `GET /api/v1/streams/{id}` | 单路流详情，`publish.cid` 是推流客户端 ID |
| `GET /api/v1/clients?start=0&count=100` | 客户端列表 |
| `DELETE /api/v1/clients/{id}` | 踢掉一个客户端，传推流者 ID 即可断流 |

管理 API 能直接断流，必须只在内网开放；SRS 也支持给 HTTP API 配置认证，暴露给运维平台时开启。

业务服务用它做两件事：

- **封禁断流**：运营封禁主播时，先把房间状态改为封禁（之后的 `on_publish` 都会被拒绝），再查 `streams` 找到 `publish.cid`，调用 `DELETE /api/v1/clients/{cid}` 踢掉当前推流
- **状态对账**：定时任务（例如每分钟）拉取各源站的流列表，与数据库里"直播中"的房间对比：数据库里在播、服务器上没有的，超过宽限期就置为下播；服务器上有、数据库里不是直播中的，记录告警并踢流。这弥补回调丢失的问题，观众数也以这里的数据为准，而不是靠 `on_play` / `on_stop` 加减

### 2、Prometheus 指标

SRS 开启 `exporter` 后在 `http://host:9972/metrics` 暴露 Prometheus 格式指标，按 `label` / `tag` 区分集群和角色（如 `cn-hz` / `edge`）。抓取与告警配置见 [指标监控](/observability/2_metrics)。建议重点关注：

| 指标方向 | 说明 | 告警思路 |
|----------|------|----------|
| 推流数、播放连接数 | 容量与突增 | 单节点连接数逼近 `max_connections` |
| 出入口带宽 | 边缘节点的主要瓶颈 | 带宽持续高于网卡能力的 70% |
| CPU、内存 | 转封装、WebRTC 加解密消耗 CPU | CPU 持续高位时扩容或分流 |
| 回调耗时与失败率 | 在业务服务侧用 Micrometer 记录 | P99 超过 200ms 或失败率突增，开播会大面积失败 |
| 录制归档积压 | 归档进程的待上传文件数与磁盘水位 | 磁盘使用超过 80% |

还要监控"业务体验"：首屏时间、卡顿率来自播放器端埋点上报，服务端指标正常并不代表观众看得流畅。

---

## 小结

- 流媒体服务器负责媒体面（接入、转协议、分发、录制），Java 业务服务负责控制面（鉴权、状态、调度、计费），两者通过 HTTP 回调和管理 API 协作
- 互联网直播选 SRS，监控接入选 ZLMediaKit，轻量转发与边缘场景选 MediaMTX；三者都以 MIT 许可为主，ZLMediaKit 商用需核查其中的第三方代码
- SRS 回调要求 HTTP 200 且 `code` 为 0，否则断开客户端；token 从 `param` 中解析并用 HMAC + 过期时间校验；回调接口只开放内网、必须快、不做重活
- 开播用条件更新防双推，下播校验 `client_id` 防误关；回调可能丢失，用 HTTP API 定时对账兜底
- DVR 推荐 `segment` 分段录 FLV，由同机归档进程转封装、分片上传对象存储，再交给点播转码
- 分发靠源站 + 边缘 + CDN，SRS 7 用 `srs-proxy` 重做源站集群；监控看连接数、带宽、回调耗时和归档积压，体验指标靠播放器埋点

## 参考资料

- SRS 项目与版本发布：[ossrs/srs](https://github.com/ossrs/srs)、[SRS Releases](https://github.com/ossrs/srs/releases)
- SRS 快速开始：[SRS Getting Started](https://ossrs.net/lts/en-us/docs/v6/doc/getting-started)
- SRS HTTP 回调：[SRS HTTP Callback](https://ossrs.net/lts/en-us/docs/v6/doc/http-callback)
- SRS 录制：[SRS DVR](https://ossrs.net/lts/en-us/docs/v6/doc/dvr)
- SRS 边缘集群：[SRS Edge Cluster](https://ossrs.net/lts/en-us/docs/v6/doc/edge)
- SRS 7 源站集群：[SRS Origin Cluster](https://ossrs.net/lts/en-us/docs/v7/doc/origin-cluster)
- SRS 管理 API：[SRS HTTP API](https://ossrs.net/lts/en-us/docs/v6/doc/http-api)
- SRS 指标导出：[SRS Exporter](https://ossrs.net/lts/en-us/docs/v6/doc/exporter)
- ZLMediaKit 项目：[ZLMediaKit/ZLMediaKit](https://github.com/ZLMediaKit/ZLMediaKit)
- ZLMediaKit 回调说明：[MediaServer 支持的 HTTP HOOK API](https://github.com/ZLMediaKit/ZLMediaKit/wiki/MediaServer%E6%94%AF%E6%8C%81%E7%9A%84HTTP-HOOK-API)
- MediaMTX 项目与默认配置：[bluenviron/mediamtx](https://github.com/bluenviron/mediamtx)、[mediamtx.yml](https://github.com/bluenviron/mediamtx/blob/main/mediamtx.yml)
- MediaMTX 鉴权：[MediaMTX Authentication](https://mediamtx.org/docs/features/authentication)

> 下一篇：[WebRTC 实时通信](./5_webrtc)
