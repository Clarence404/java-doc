---
description: RTMP、RTSP、HTTP-FLV、HLS 与 LL-HLS、DASH、CMAF、WebRTC 与 WHIP / WHEP、SRT、延迟对比与场景选型
---

# 流媒体协议

> 前置阅读：[音视频基础](./1_basics)、[TCP 与 UDP](/protocols/1_tcp_udp)、[HTTP](/protocols/2_http)

流媒体协议决定音视频怎么推上来、怎么分发给观众，选错往往要推倒重来。本篇讲推流协议、拉流协议、实时协议、延迟对比与推拉流鉴权，基线为 FFmpeg 9.0。

---

## 一、协议全景

同一路直播，用 HLS 分发延迟十几秒，弹幕互动明显对不上；改用 WebRTC 延迟降到亚秒，但 CDN 成本和服务器复杂度完全是另一个量级。示例统一为主播推流到 `ingest.example.com`、观众从 `pull.example.com` 拉流、直播间号 `room1001`。

音视频协议按方向分成两类：

- **推流协议**（ingest / contribution）：从主播端、编码器、摄像头把流送到服务器。要求稳定、可靠、编码器普遍支持，观众看不到这一段
- **拉流协议**（delivery / playback）：从服务器或 CDN 把流送到观众。要求能大规模分发、浏览器和手机原生或通过 JS 播放器支持

| 协议 | 传输层 | 封装 | 方向 | 典型延迟 | 浏览器播放 | 主要用途 |
|------|--------|------|------|----------|------------|----------|
| RTMP | TCP（默认 1935 端口） | FLV Tag | 推流为主 | 1～3 秒 | 不支持（Flash 已退役） | OBS / 编码器推流 |
| RTSP | 控制走 TCP，媒体走 RTP（UDP 或 TCP 交织） | RTP 负载 | 拉流（摄像头作为服务端） | 0.5～2 秒 | 不支持 | 安防摄像头、NVR |
| HTTP-FLV | HTTP 长连接 | FLV | 拉流 | 1～3 秒 | 需 JS 播放器（MSE） | 国内直播网页 / App |
| HLS | HTTP | TS 或 fMP4 切片 + m3u8 | 拉流 | 常规 6～30 秒 | Safari / iOS 原生；其他浏览器用 hls.js | 直播、点播通用分发 |
| LL-HLS | HTTP | fMP4 部分切片 | 拉流 | 2～5 秒 | Safari 原生；hls.js 支持 | 低延迟直播 |
| DASH | HTTP | fMP4 + MPD | 拉流 | 常规 6～30 秒，LL-DASH 2～5 秒 | 用 dash.js / Shaka Player | 点播、跨平台 DRM |
| WebRTC | UDP（SRTP），可回退 TCP / TURN | RTP | 双向 | 0.1～0.5 秒 | 原生支持 | 连麦、会议、超低延迟直播 |
| SRT | UDP（带重传） | 多为 MPEG-TS | 推流、节点间传输 | 0.3～1 秒，可调 | 不支持 | 公网远距离推流、演播室回传 |

一个典型直播平台的组合是：**RTMP 或 SRT 推流 → 流媒体服务器转封装 → HTTP-FLV / HLS 经 CDN 分发**；需要连麦时引入 WebRTC。协议之间的转换（RTMP 转 HLS、RTSP 转 WebRTC）都由流媒体服务器完成，只要编码不变就是转封装，开销很低，见 [音视频基础](./1_basics) 第八节。

---

## 二、RTMP

### 1、协议要点

RTMP（Real-Time Messaging Protocol）是 Adobe 为 Flash 设计的协议，2012 年公开规范。Flash 播放器在 2020 年底停止支持，但 RTMP 作为**推流协议**至今仍是事实标准：OBS、各类硬件编码器、手机推流 SDK 和几乎所有直播 CDN 都支持。

- **连接过程**：TCP 建连后先做握手（客户端发 C0 / C1 / C2，服务端回 S0 / S1 / S2，C1 / S1 各 1536 字节），然后依次发 `connect`（连接到某个 app）、`createStream`、`publish`（推流）或 `play`（拉流）命令
- **分块传输**：音视频消息被切成 chunk 交错发送，默认 chunk 大小 128 字节，通常协商为 4096 字节以减少头部开销；大的视频帧不会长时间阻塞音频
- **负载就是 FLV Tag**：音频、视频、元数据（`onMetaData`）三类消息，与 FLV 文件的 Tag 结构一致，所以 RTMP 转 HTTP-FLV 几乎零成本
- **跑在 TCP 上**：丢包时 TCP 重传会造成队头阻塞，弱网下延迟会持续累积，这是它不适合远距离、高丢包链路的原因；加密版本 RTMPS 是 RTMP over TLS，默认端口 443

推流地址的结构是 `rtmp://主机[:端口]/应用名/流名`，OBS 把它拆成"服务器"（`rtmp://ingest.example.com/live`）和"推流码"（`room1001?expire=...&sign=...`）两部分。

```bash
# 用本地文件模拟主播推流：-re 按原始帧率读取，-c copy 不转码
ffmpeg -re -i demo.mp4 -c copy -f flv \
  "rtmp://ingest.example.com/live/room1001?expire=1791619200&sign=3f9a..."
```

### 2、Enhanced RTMP

传统 RTMP / FLV 只定义了 H.264 和 AAC 等少数编码，用 4 位的 CodecID 表示，没有空间容纳新编码。2023 年起 Veovera 联合 Adobe、YouTube、Twitch 等推出 **Enhanced RTMP**：

| 版本 | 状态（2026 年 10 月） | 主要内容 |
|------|-----------------------|----------|
| v1 | 已定稿，生态广泛支持 | 用 FourCC（如 `hvc1`、`av01`、`vp09`）标识视频编码，加入 HEVC、AV1、VP9 与 HDR 元数据 |
| v2 | alpha 规范，仍在演进 | 能力协商、单连接多轨（一路连接带多个清晰度或多语言音轨）、断线重连，音频扩展 Opus、FLAC、AC-3、E-AC-3 等 |

FFmpeg 从 6.1 起支持 Enhanced FLV / RTMP 的 HEVC、VP9、AV1，OBS 也已支持以 HEVC / AV1 推流到支持的平台。落地前要确认**整条链路**都支持：推流端、流媒体服务器、转码集群、CDN 任何一环只认传统 FLV，就会出现推流失败或只有声音没有画面。

---

## 三、RTSP

RTSP（Real Time Streaming Protocol）是安防行业的通用协议，几乎所有网络摄像头和 NVR 都内置 RTSP 服务端，默认端口 554。现行版本是 RFC 2326（RTSP 1.0），RFC 7826（RTSP 2.0）发布后设备侧采用很少。

它的特点是**控制与媒体分离**：RTSP 本身只是类似 HTTP 的文本控制协议，负责协商和播放控制；真正的音视频走 RTP，质量反馈走 RTCP。一次典型的拉流交互：

```text
C->S  DESCRIBE rtsp://camera.example.com:554/stream1 RTSP/1.0      # 获取 SDP，得知编码与轨道
S->C  RTSP/1.0 200 OK  (Content-Type: application/sdp)
C->S  SETUP rtsp://camera.example.com:554/stream1/trackID=1 RTSP/1.0
      Transport: RTP/AVP/TCP;unicast;interleaved=0-1               # 要求 RTP 走 RTSP 的 TCP 连接
S->C  RTSP/1.0 200 OK  (Session: 12345678)
C->S  PLAY rtsp://camera.example.com:554/stream1 RTSP/1.0           # 开始推送 RTP
C->S  TEARDOWN rtsp://camera.example.com:554/stream1 RTSP/1.0       # 结束会话
```

工程上要注意：

- **UDP 还是 TCP**：RTP over UDP 延迟低，但穿越 NAT 和防火墙困难，公网丢包会花屏；跨网络拉摄像头一般强制 TCP 交织模式（FFmpeg 用 `-rtsp_transport tcp`）
- **浏览器无法直接播放**：需要流媒体服务器拉取 RTSP 后转成 WebRTC、HTTP-FLV 或 HLS；摄像头输出 H.265 时，网页端还要考虑转码成 H.264
- **认证是 Digest**：摄像头 RTSP 地址中的账号密码不要写进前端或日志，由服务器侧持有；国内平台级接入更多使用 GB/T 28181，见 [监控视频接入](./8_video_surveillance)

```bash
# 拉取摄像头 RTSP 并转推到 RTMP（编码不变，只转封装）
ffmpeg -rtsp_transport tcp -i "rtsp://camera.example.com:554/stream1" \
  -c copy -f flv rtmp://ingest.example.com/live/store-cam-01
```

RTSP 的消息格式与 HTTP 的异同见 [网络协议总览](/protocols/0_overview)。

---

## 四、HTTP-FLV

HTTP-FLV 是把 FLV 流放在一个**永不结束的 HTTP 响应**里：客户端请求 `http://pull.example.com/live/room1001.flv`，服务器返回 FLV 文件头后持续写入音视频 Tag，通常使用分块传输编码。

- **延迟与 RTMP 相当**（1～3 秒），因为负载就是 RTMP 收到的 FLV Tag，服务器只做转发
- **走 HTTP 80 / 443 端口**，能复用 CDN 的 HTTP 基础设施，穿透防火墙没有障碍；国内直播 CDN 普遍支持，是国内网页和 App 直播的主力拉流协议
- **浏览器需要 JS 播放器**：通过 MSE（Media Source Extensions）把 FLV 转封装成 fMP4 再交给 `<video>`，常用 mpegts.js（flv.js 的后继项目）。iPhone 上的 Safari 长期不支持 MSE，iOS 17.1 起提供 ManagedMediaSource，兼容性需实测，iOS 网页通常改走 HLS
- **WebSocket-FLV** 是同一思路的变种，用 WebSocket 承载 FLV 数据，适合某些不便使用长 HTTP 响应的环境
- **国际化受限**：海外 CDN 对 HTTP-FLV 支持较少，出海业务以 HLS / LL-HLS / WebRTC 为主

---

## 五、HLS 与 LL-HLS

### 1、HLS 的工作方式

HLS（HTTP Live Streaming）由苹果提出，规范为 RFC 8216。服务器把流切成一个个小文件（切片），再用 m3u8 播放列表描述它们，播放器反复下载播放列表、按顺序下载切片播放。因为全部是普通 HTTP 文件，**CDN 缓存效率极高**，是全球通用的分发协议。

主播放列表（master playlist）列出多个清晰度，播放器按网速自适应切换：

```text
#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=4628000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2"
1080p/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2628000,RESOLUTION=1280x720,CODECS="avc1.64001f,mp4a.40.2"
720p/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=1096000,RESOLUTION=854x480,CODECS="avc1.64001e,mp4a.40.2"
480p/index.m3u8
```

媒体播放列表（media playlist）列出切片。直播时它是滑动窗口，不断追加新切片、移除旧切片：

```text
#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:4
#EXT-X-MEDIA-SEQUENCE:1520
#EXTINF:4.000,
seg1520.ts
#EXTINF:4.000,
seg1521.ts
#EXTINF:4.000,
seg1522.ts
```

点播则在末尾加 `#EXT-X-ENDLIST`，表示列表不再变化，播放器可以拖动进度。

**延迟从哪来**：规范建议播放器从距离末尾至少 3 个目标时长的位置开始播放，切片 4 秒时仅这一项就有 12 秒，再加上编码、切片生成、CDN 回源，常规 HLS 直播延迟在 10 秒以上。切片能切多短受 GOP 限制——切片必须从关键帧开始，所以缩短切片前先缩短 GOP。

### 2、LL-HLS

LL-HLS（Low-Latency HLS）是苹果在 2019 年提出、2020 年并入 HLS 规范的扩展（规范第二版以 IETF 草案 draft-pantos-hls-rfc8216bis 形式维护），目标延迟 2～5 秒，核心手段有四个：

| 机制 | 标签 / 参数 | 作用 |
|------|-------------|------|
| 部分切片（Partial Segment） | `#EXT-X-PART`、`#EXT-X-PART-INF` | 把 4 秒切片再拆成约 200 ms～1 s 的小块，生成一块就发布一块，不必等整片完成 |
| 预加载提示 | `#EXT-X-PRELOAD-HINT` | 提前告诉播放器下一个部分切片的地址，播放器先发请求，服务器生成后立即返回 |
| 阻塞式播放列表刷新 | 请求参数 `_HLS_msn`、`_HLS_part`；`CAN-BLOCK-RELOAD=YES` | 播放器请求"包含某个切片的播放列表"，服务器挂起请求直到它就绪，替代固定间隔轮询 |
| 增量更新与 rendition 报告 | `#EXT-X-SKIP`、`#EXT-X-RENDITION-REPORT` | 播放列表只传变化部分；切换清晰度时直接知道其他档位的最新位置 |

```text
#EXTM3U
#EXT-X-VERSION:6
#EXT-X-TARGETDURATION:4
#EXT-X-SERVER-CONTROL:CAN-BLOCK-RELOAD=YES,PART-HOLD-BACK=1.0,CAN-SKIP-UNTIL=24.0
#EXT-X-PART-INF:PART-TARGET=0.333
#EXT-X-MEDIA-SEQUENCE:266
#EXT-X-MAP:URI="init.mp4"
#EXTINF:4.000,
seg266.mp4
#EXT-X-PART:DURATION=0.333,URI="seg267.part0.mp4",INDEPENDENT=YES
#EXT-X-PART:DURATION=0.333,URI="seg267.part1.mp4"
#EXT-X-PRELOAD-HINT:TYPE=PART,URI="seg267.part2.mp4"
```

播放器随后发起阻塞请求 `GET /live/room1001/index.m3u8?_HLS_msn=267&_HLS_part=2`，服务器在 `seg267.part2.mp4` 就绪后才返回新的播放列表。这对 CDN 提出了要求：要支持带查询参数的缓存键、请求合并（同一时刻大量相同的阻塞请求只回源一次）以及 HTTP/2，选择 CDN 前要确认它明确支持 LL-HLS。

---

## 六、DASH

DASH（Dynamic Adaptive Streaming over HTTP，标准为 ISO/IEC 23009-1）是 MPEG 制定的国际标准，原理与 HLS 相同：切片 + 描述文件，只是描述文件是 XML 格式的 **MPD**（Media Presentation Description），层级为 Period → AdaptationSet（一类媒体，如视频）→ Representation（一个清晰度）→ Segment。

和 HLS 相比：

- **编码无关、扩展性强**：MPD 能精细描述多音轨、多字幕、多视角，DRM 方面原生支持通用加密（CENC），适合需要 Widevine / PlayReady 版权保护的长视频平台
- **苹果生态不原生支持**：Safari 和 iOS 原生只播 HLS，网页端要用 dash.js 或 Shaka Player 通过 MSE 播放，iOS App 内需要额外的播放器支持。因此多数平台把 HLS 作为主协议，DASH 作为 Android / 智能电视 / 网页的补充
- **LL-DASH**：用 CMAF 分块（chunk）+ HTTP 分块传输编码，编码器每产生一个 chunk 就经 CDN 推给播放器，延迟可降到 2～5 秒

---

## 七、CMAF

CMAF（Common Media Application Format，ISO/IEC 23000-19）不是一种新协议，而是**统一的切片格式**：规定 HLS 和 DASH 都使用相同约束的 fMP4 切片。在它出现之前，同一个视频要为 HLS 存一份 TS 切片、为 DASH 存一份 fMP4 切片，存储和 CDN 缓存都要翻倍。

- **一份切片，两种描述**：同一组 fMP4 文件，同时生成 m3u8 和 MPD，HLS 播放器和 DASH 播放器各取所需
- **加密统一**：配合通用加密的 `cbcs` 模式，一份加密文件可以同时服务 FairPlay、Widevine、PlayReady 三种 DRM
- **低延迟的基础**：CMAF chunk 是 LL-HLS 部分切片和 LL-DASH 分块传输的共同载体

对后端来说，CMAF 的意义在于媒资存储和转码任务的设计：转码产物以 fMP4 切片为准，播放列表按协议生成，不再为每种协议单独转一遍，细节见 [点播与短视频](./7_vod)。

---

## 八、WebRTC 与 WHIP / WHEP

### 1、WebRTC 为什么快

WebRTC 是浏览器内置的实时音视频技术（W3C 标准与 IETF RFC 8825 等一系列 RFC），延迟能做到 100～500 ms，来自几个设计：

- **UDP 传输 + 弱网对抗**：媒体走 SRTP over UDP，丢包用 NACK 重传、FEC 前向纠错，拥塞控制（GCC 等算法）根据网络状况实时调整码率，宁可降清晰度也不累积延迟
- **抖动缓冲很小**：播放端只缓冲几十到几百毫秒，HLS 播放器往往缓冲十几秒
- **NAT 穿越**：用 ICE 收集候选地址，STUN 获取公网地址，打洞失败时通过 TURN 中继
- **强制加密**：DTLS 协商密钥，SRTP 加密媒体，没有明文模式
- **编码约束**：视频强制支持 VP8 与 H.264（Constrained Baseline），音频强制支持 Opus；现代浏览器普遍还支持 VP9 和 AV1

WebRTC **没有定义信令**——双方如何交换 SDP（媒体能力描述）和 ICE 候选由应用自己决定，这正是 Java 后端的工作之一（通常用 WebSocket 实现，见 [WebSocket](/netty/10_websocket)）。多人场景下用 SFU（选择性转发单元）转发而不是每两人之间直连。信令、ICE 与 SFU 的完整讲解见 [WebRTC 实时通信](./5_webrtc)。

### 2、WHIP 与 WHEP

过去每个 WebRTC 服务器都有自己的信令接口，OBS、FFmpeg 这类工具无法通用地"用 WebRTC 推流"。WHIP 和 WHEP 用最简单的 HTTP 交互把信令标准化：

| 协议 | 全称 | 状态（2026 年 10 月） | 作用 |
|------|------|-----------------------|------|
| WHIP | WebRTC-HTTP Ingestion Protocol | RFC 9725（2025 年 3 月，Proposed Standard） | 推流：编码器用 WebRTC 推流到服务器或 CDN |
| WHEP | WebRTC-HTTP Egress Protocol | IETF 草案 draft-ietf-wish-whep，尚未成为 RFC | 拉流：播放器用 WebRTC 从服务器或 CDN 拉流 |

WHIP 的完整交互只有一来一回加一个删除：

```text
POST /whip/room1001 HTTP/1.1
Host: ingest.example.com
Content-Type: application/sdp
Authorization: Bearer eyJhbGciOiJIUzI1NiJ9...

v=0
o=- 5228595038118931041 2 IN IP4 127.0.0.1
...（SDP offer）

HTTP/1.1 201 Created
Content-Type: application/sdp
Location: /whip/room1001/sessions/7f3a9c

v=0
...（SDP answer）
```

推流结束时客户端发送 `DELETE /whip/room1001/sessions/7f3a9c` 释放会话；ICE 候选的增量更新用 `PATCH` 发往同一个会话地址。对后端而言，WHIP 端点就是一个普通的 HTTP 接口，鉴权用标准的 Bearer Token，非常适合由 Java 网关做认证后再转发给媒体服务器。

FFmpeg 8.0 起内置实验性的 `whip` 封装器，要求视频为不带 B 帧的 H.264、音频为 Opus：

```bash
ffmpeg -re -i demo.mp4 \
  -c:v libx264 -profile:v baseline -tune zerolatency -bf 0 \
  -c:a libopus -ar 48000 -ac 2 \
  -authorization "eyJhbGciOiJIUzI1NiJ9..." \
  -f whip "https://ingest.example.com/whip/room1001"
```

OBS 30 起也支持 WHIP 输出。SRS、ZLMediaKit、MediaMTX、LiveKit 等主流服务器都已实现 WHIP，WHEP 虽未定稿，主流服务器和部分 CDN 也已提供支持。

---

## 九、SRT

SRT（Secure Reliable Transport）由 Haivision 开发，2017 年以 MPL-2.0 许可开源，目标是在**不可靠的公网上做可靠的低延迟传输**，替代昂贵的专线和卫星回传。

- **UDP + 选择性重传（ARQ）**：接收端发现丢包立即请求重传，不像 TCP 那样整体降速和队头阻塞
- **固定延迟窗口**：`latency` 参数（默认 120 ms）定义接收端的缓冲时间，在这个窗口内重传回来的包被正常播放，超时则丢弃，延迟恒定、不会累积。经验值是设为链路 RTT 的 3～4 倍以上，丢包严重的跨国链路要更大
- **内置加密**：设置 10～80 字符的 passphrase 后启用 AES 加密（默认 AES-128），两端口令不一致则拒绝连接
- **Stream ID 路由**：连接前设置最多 512 字符的 `streamid`，服务器据此区分推流 / 拉流和流名，推荐格式 `#!::r=live/room1001,m=publish`（`r` 为资源名，`m` 为模式）
- **负载通常是 MPEG-TS**：SRT 只管传输，内容多为 TS 封装的 H.264 / H.265 + AAC

```bash
# 以 SRT 推流（MPEG-TS 封装）；FFmpeg 的 latency 选项单位是微秒
ffmpeg -re -i demo.mp4 -c copy -f mpegts \
  "srt://ingest.example.com:10080?streamid=#!::r=live/room1001,m=publish"
```

SRT 适合户外直播、赛事转播、跨国推流等上行链路质量差的场景，OBS、vMix 和主流硬件编码器都支持；它不面向浏览器播放，到达服务器后照样转成 HTTP-FLV / HLS / WebRTC 分发。

---

## 十、延迟对比

![各协议典型端到端延迟](../assets/media/protocols-latency.svg)

端到端延迟由多段叠加而成，协议只决定其中一部分：

| 环节 | 典型耗时 | 降低手段 |
|------|----------|----------|
| 采集与编码 | 几十～几百毫秒 | 关闭 B 帧、`-tune zerolatency`、硬件编码 |
| 上行传输 | 几十毫秒～数秒（TCP 弱网累积） | 弱网用 SRT / WebRTC 推流，就近接入 |
| 服务器处理 | 转封装几乎为 0；转码增加数百毫秒 | 能转封装就不转码 |
| 切片与分发 | HLS 至少一个切片时长；CDN 多级回源 | 缩短 GOP 与切片、LL-HLS、CDN 边缘直推 |
| 播放器缓冲 | WebRTC 几十毫秒；FLV 1～2 秒；HLS 3 个切片 | 调整缓冲策略，落后过多时追帧或倍速 |
| GOP 缓存 | 最多一个 GOP | 缩短 GOP，或对低延迟场景关闭 GOP 缓存 |

延迟不是越低越好：WebRTC 的低延迟以更高的服务器成本、更复杂的扩展为代价；HLS 的高延迟换来的是最好的 CDN 缓存效率和最低的分发成本。**先按业务确定可接受的延迟，再选协议**。

---

## 十一、场景选型

| 场景 | 延迟要求 | 推流 | 拉流 / 分发 | 说明 |
|------|----------|------|-------------|------|
| 秀场 / 电商 / 游戏直播 | 1～5 秒 | RTMP（主流）、SRT（弱网户外）、Enhanced RTMP（HEVC） | 国内 HTTP-FLV + HLS 兜底；出海 HLS / LL-HLS | 观众规模大，CDN 成本是核心；弹幕互动可接受 2～3 秒延迟，见 [直播系统设计](./6_live_streaming) |
| 连麦 / 互动直播 / 直播带货抢购 | < 500 ms（连麦方） | WebRTC（WHIP） | 连麦方 WebRTC；普通观众合流后转 HTTP-FLV / HLS | 主播与连麦嘉宾走 SFU，合流后推给 CDN，兼顾体验与成本 |
| 点播 / 短视频 / 直播回放 | 无实时要求 | 上传文件（分片上传） | HLS / DASH（CMAF 切片）；短视频可直接用 faststart MP4 | 关注首帧时间、码率阶梯和存储成本，见 [点播与短视频](./7_vod) |
| 视频会议 / 在线课堂 | < 300 ms | WebRTC | WebRTC（SFU） | 双向实时，大班课可以"老师 WebRTC + 学生 LL-HLS"降低成本，见 [WebRTC 实时通信](./5_webrtc) |
| 监控 / 门店摄像头 | 实时预览 < 1 秒；回放无要求 | 摄像头 RTSP（被拉取）或 GB/T 28181 主动推送 | 网页预览 WebRTC / HTTP-FLV；录像回放 HLS | H.265 摄像头在网页播放可能需要转码，见 [监控视频接入](./8_video_surveillance) |

---

## 十二、推拉流地址鉴权

无论哪种协议，推流和播放地址都不能是固定的，否则推流码泄露就能被人"盗播"，播放地址被盗链会白白消耗 CDN 流量。通用做法是**带过期时间的签名 URL**：Java 后端在主播开播、观众进房时签发地址，流媒体服务器或 CDN 校验签名与时间。

```java
public final class StreamUrlSigner {

    private final byte[] secret;

    public StreamUrlSigner(String secret) {
        this.secret = secret.getBytes(StandardCharsets.UTF_8);
    }

    /** 签发推流地址：签名覆盖 app、流名与过期时间，任一被篡改都会校验失败 */
    public String signPublishUrl(String stream, Duration ttl) {
        long expire = Instant.now().plus(ttl).getEpochSecond();
        String sign = hmacSha256Hex("/live/" + stream + ":" + expire);
        return "rtmp://ingest.example.com/live/" + stream + "?expire=" + expire + "&sign=" + sign;
    }

    /** 校验：先比较过期时间，再用常量时间比较签名，避免时序攻击 */
    public boolean verify(String app, String stream, long expire, String sign) {
        if (Instant.now().getEpochSecond() > expire) {
            return false;
        }
        String expected = hmacSha256Hex("/" + app + "/" + stream + ":" + expire);
        return MessageDigest.isEqual(
                expected.getBytes(StandardCharsets.UTF_8),
                sign.getBytes(StandardCharsets.UTF_8));
    }

    private String hmacSha256Hex(String data) {
        try {
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(secret, "HmacSHA256"));
            return HexFormat.of().formatHex(mac.doFinal(data.getBytes(StandardCharsets.UTF_8)));
        } catch (GeneralSecurityException e) {
            throw new IllegalStateException("HMAC 计算失败", e);
        }
    }
}
```

落地要点：

- **推流在服务器 Hook 里校验**：流媒体服务器收到 `publish` 时回调业务接口（如 SRS 的 `on_publish`、ZLMediaKit 的 `on_publish` Hook），Java 后端调用 `verify` 并检查该直播间是否允许开播，返回失败即拒绝推流；回调接口的设计见 [流媒体服务器](./4_media_server)
- **播放鉴权交给 CDN**：各家 CDN 都有自己的 URL 鉴权规则（参数名、签名串格式、时间格式各不相同），后端按 CDN 文档生成，CDN 边缘直接校验，不回源到业务服务
- **WebRTC / WHIP 用 Bearer Token**：WHIP / WHEP 本身是 HTTP，直接用短期 JWT 或不透明令牌放在 `Authorization` 头里
- **有效期按场景设定**：推流地址可以覆盖一场直播的时长，主播断线重连时还能使用；播放地址宜短，过期后由客户端重新向后端换取；HLS 的切片请求也要带上鉴权参数，否则只保护了 m3u8
- **签名设计的通用原则**（规范串、防重放、密钥轮换）见 [API 安全](/security/6_api_security)

---

## 小结

- 推流协议追求稳定与编码器兼容（RTMP、SRT、WHIP），拉流协议追求规模分发与终端兼容（HTTP-FLV、HLS、DASH、WebRTC），协议转换由流媒体服务器完成，编码不变时只是转封装
- RTMP 仍是推流事实标准，Enhanced RTMP v1 为它加入 HEVC / AV1 / VP9，v2 仍是 alpha；RTSP 是摄像头的标准接口，浏览器播放必须经服务器转换
- HTTP-FLV 延迟 1～3 秒，国内直播主力；HLS 兼容性和 CDN 效率最好但延迟高，LL-HLS 用部分切片、预加载提示和阻塞刷新降到 2～5 秒；DASH 适合 DRM 与非苹果平台；CMAF 让 HLS 与 DASH 共用 fMP4 切片
- WebRTC 靠 UDP、小缓冲和拥塞控制做到亚秒级，但需要自建信令和 SFU；WHIP 已成为 RFC 9725，WHEP 仍是草案
- SRT 用固定延迟窗口加选择性重传在公网上可靠传输，适合弱网上行
- 先定延迟目标再选协议；推拉流地址用带过期时间的 HMAC 签名，推流在服务器 Hook 中校验，播放鉴权交给 CDN

## 参考资料

- RTMP / FLV 原始规范（Adobe RTMP 1.0、FLV 10.1，由 Veovera 收录）：[Legacy RTMP and FLV Specifications](https://veovera.org/docs/legacy/)
- Enhanced RTMP 规范：[Enhanced RTMP v1](https://veovera.github.io/enhanced-rtmp/docs/enhanced/enhanced-rtmp-v1)、[Enhanced RTMP v2](https://veovera.github.io/enhanced-rtmp/docs/enhanced/enhanced-rtmp-v2)、[veovera/enhanced-rtmp](https://github.com/veovera/enhanced-rtmp)
- RTSP 规范：[RFC 2326 - Real Time Streaming Protocol (RTSP)](https://www.rfc-editor.org/rfc/rfc2326)、[RFC 7826 - RTSP 2.0](https://www.rfc-editor.org/rfc/rfc7826)
- RTP 规范：[RFC 3550 - RTP: A Transport Protocol for Real-Time Applications](https://www.rfc-editor.org/rfc/rfc3550)
- HLS 规范：[RFC 8216 - HTTP Live Streaming](https://www.rfc-editor.org/rfc/rfc8216)、[HLS 第二版草案（含 LL-HLS）](https://datatracker.ietf.org/doc/draft-pantos-hls-rfc8216bis/)
- 苹果 HLS 文档：[Apple - HTTP Live Streaming](https://developer.apple.com/streaming/)、[Enabling Low-Latency HLS](https://developer.apple.com/documentation/http-live-streaming/enabling-low-latency-http-live-streaming-hls)
- DASH 参考实现：[DASH Industry Forum - dash.js](https://github.com/Dash-Industry-Forum/dash.js)
- CMAF 标准：[ISO/IEC 23000-19 Common Media Application Format](https://www.iso.org/standard/85623.html)
- WebRTC 概览：[RFC 8825 - Overview: Real-Time Protocols for Browser-Based Applications](https://www.rfc-editor.org/rfc/rfc8825)、[W3C WebRTC 1.0](https://www.w3.org/TR/webrtc/)
- WHIP 规范：[RFC 9725 - WebRTC-HTTP Ingestion Protocol (WHIP)](https://www.rfc-editor.org/rfc/rfc9725)
- WHEP 草案：[draft-ietf-wish-whep - WebRTC-HTTP Egress Protocol](https://datatracker.ietf.org/doc/draft-ietf-wish-whep/)
- FFmpeg 封装器（含 whip）：[FFmpeg Formats Documentation](https://ffmpeg.org/ffmpeg-formats.html)
- FFmpeg 协议（含 srt、rtmp、rtsp）：[FFmpeg Protocols Documentation](https://ffmpeg.org/ffmpeg-protocols.html)
- SRT 实现与选项：[Haivision/srt](https://github.com/Haivision/srt)、[SRT Socket Options](https://github.com/Haivision/srt/blob/master/docs/API/API-socket-options.md)、[SRT Access Control (Stream ID)](https://github.com/Haivision/srt/blob/master/docs/features/access-control.md)
- HTTP-FLV / MPEG-TS 网页播放器：[xqq/mpegts.js](https://github.com/xqq/mpegts.js)

> 下一篇：[FFmpeg 与转码](./3_ffmpeg)
