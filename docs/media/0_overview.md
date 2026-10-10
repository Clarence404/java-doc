# 音视频总览

音视频模块讲一路画面和声音从采集、编码、推流、服务器处理到 CDN 分发和播放，每一环做什么、延迟和成本花在哪里。全模块以一个直播 + 点播的视频平台为贯穿示例，讲清楚 Java 后端在其中的位置。

**版本基线（2026 年 10 月）**：FFmpeg 9.0、SRS 6.0、ZLMediaKit（主干滚动发布）、MediaMTX 1.21、LiveKit Server 1.13；WHIP 已是 RFC 9725，WHEP 仍为草案。

---

## 一、音视频全链路

![音视频全链路](../assets/media/overview-pipeline.svg)

| 环节 | 做什么 | 关键技术 | 本模块 |
|------|--------|----------|--------|
| 采集 | 从摄像头、麦克风、屏幕拿到原始画面（YUV）和声音（PCM） | 采样率、分辨率、帧率、像素格式 | [音视频基础](./1_basics) |
| 编码 | 把原始数据压缩几十到几百倍，再装进容器 | H.264 / H.265 / AV1、AAC / Opus、GOP、码控 | [音视频基础](./1_basics)、[FFmpeg 与转码](./3_ffmpeg) |
| 推流 | 把编码后的流送到服务器（上行，也叫 ingest / contribution） | RTMP、SRT、WHIP、RTSP | [流媒体协议](./2_protocols) |
| 流媒体服务器 | 收流、转封装成多种拉流协议、转码出多码率、录制、截图、回调业务 | SRS、ZLMediaKit、MediaMTX、LiveKit | [流媒体服务器](./4_media_server)、[WebRTC 实时通信](./5_webrtc) |
| 分发 | 把一路流复制给成千上万观众（下行，也叫 delivery / distribution） | CDN、边缘节点、回源、多码率自适应 | [直播系统设计](./6_live_streaming)、[点播与短视频](./7_vod) |
| 播放 | 下载、解封装、解码、音画同步、渲染 | HLS、HTTP-FLV、DASH、WebRTC、MSE | [流媒体协议](./2_protocols) |

几条贯穿全模块的结论：

- **延迟主要由协议和缓冲决定**：WebRTC 亚秒级，RTMP / HTTP-FLV 1～3 秒，HLS 常规配置 6 秒以上；想降延迟要同时缩短 GOP、切片和播放器缓冲，不是单改一个参数
- **转封装便宜，转码昂贵**：只换容器（RTMP 转 HLS）几乎不耗 CPU；改编码、分辨率、码率必须解码再编码，是音视频平台最主要的计算成本，要按需开启、尽量用硬件编码
- **编码选择受兼容性和专利约束**：H.264 + AAC 兼容性最好，H.265 / AV1 同画质码率更低但需要确认终端支持和授权情况；浏览器里的 WebRTC 默认走 Opus，转到 RTMP / HLS 时往往要转成 AAC
- **流量费是大头**：带宽成本与码率 × 观看时长成正比，码率阶梯、按需转码、CDN 调度直接影响平台成本

---

## 二、控制面与媒体面

Java 后端的具体工作：签发推流和播放地址并鉴权、接收流媒体服务器的 Hook 回调维护直播间状态、编排转码 / 截图 / 审核等异步任务、记录媒资元数据、统计观看与计费。JVM 不适合逐帧处理视频，后端代码里出现大量解码、缩放逻辑，通常意味着架构选错了位置。

一个视频平台可以拆成两个平面，Java 后端只负责其中一个：

| 平面 | 职责 | 由谁实现 | 特点 |
|------|------|----------|------|
| 媒体面 | 收发、转封装、转码、录制、分发音视频数据 | FFmpeg、流媒体服务器、CDN、WebRTC SFU | 带宽与 CPU 密集，C / C++ / Go 实现为主，按流或按节点扩容 |
| 控制面 | 谁能推流、谁能看、直播间状态、任务调度、计费统计 | Java 后端（Spring Boot 服务）、消息队列、数据库 | 请求量与直播间数、开关播事件相关，按常规 Web 服务扩容 |

Java 后端常做的事：

- **地址签发与鉴权**：主播开播时生成带过期时间和签名的推流地址；观众进入直播间时生成播放地址，CDN 或流媒体服务器校验签名，签名规则与防盗链参见 [API 安全](/security/6_api_security)
- **处理 Hook 回调**：流媒体服务器在推流开始、断开、录制文件生成时回调业务接口，后端据此更新直播间状态、触发回放转码；回调要做幂等，参见 [幂等设计](/architecture/5_idempotence)
- **任务编排**：上传完成后投递转码、截图、内容审核任务到消息队列，由转码集群消费，参见 [消息队列总览](/messaging/0_overview)
- **媒资管理**：记录原始文件、转码产物、封面、时长、分辨率等元数据，文件本身放对象存储，参见 [对象存储](/architecture/4_object_storage)
- **实时互动**：弹幕、礼物、在线人数走长连接，不走媒体流，参见 [即时通讯](/scenario/16_im) 与 [WebSocket](/netty/10_websocket)

::: tip Java 能不能直接处理音视频
可以但通常不划算。JavaCV（FFmpeg 的 JNI 封装）、Jaffree（调用 FFmpeg 命令行的封装）适合截图、探测元数据这类轻量场景；批量转码更稳妥的做法是 Java 生成 FFmpeg 命令、以独立进程或独立转码服务运行，用退出码和进度输出跟踪状态，进程崩溃不会拖垮业务 JVM。
:::

---

## 三、模块导航

<ModuleNav />

---

## 四、推荐阅读路径

1. **先建立概念**：读 [音视频基础](./1_basics)（采样、码率、编码、GOP、封装、时间戳），再读 [流媒体协议](./2_protocols)，弄清每种协议的延迟和适用场景。
2. **掌握工具与服务端**：读 [FFmpeg 与转码](./3_ffmpeg)（命令行、硬件编码、码率阶梯），再读 [流媒体服务器](./4_media_server)（选型、Hook 回调、集群）和 [WebRTC 实时通信](./5_webrtc)（信令、ICE、SFU）。
3. **落到业务系统**：读 [直播系统设计](./6_live_streaming)、[点播与短视频](./7_vod)，需要接入摄像头时读 [监控视频接入](./8_video_surveillance)。

网络基础薄弱时先补 [TCP 与 UDP](/protocols/1_tcp_udp) 和 [HTTP](/protocols/2_http)。复习时用 [高频面试题](./99_interview) 自测，答案在 [音视频面试题解答](/interview/27_media)。

---

## 五、关联模块

- TCP / UDP、HTTP 协议基础 → [TCP 与 UDP](/protocols/1_tcp_udp)、[HTTP](/protocols/2_http)
- 弹幕、礼物、在线人数等实时消息 → [即时通讯](/scenario/16_im)；长连接实现 → [WebSocket](/netty/10_websocket)、[SSE](/netty/11_sse)
- 视频文件的分片上传、断点续传 → [大文件上传](/scenario/10_file_upload)；存储与预签名地址 → [对象存储](/architecture/4_object_storage)
- 转码、截图、审核任务的异步投递 → [消息队列总览](/messaging/0_overview)
- 推流 / 播放地址签名与防盗链 → [API 安全](/security/6_api_security)
- CDN 与边缘加速 → [Cloudflare 边缘服务](/cloud-native/16_cloudflare)；接入层与流量调度 → [接入层架构](/high-con/1_access_layer)
- 摄像头等设备的注册与管理 → [IoT 总览](/iot/0_overview)
- 媒体服务的容器化部署 → [Kubernetes](/cloud-native/6_kubernetes)
