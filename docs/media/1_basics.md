---
description: 采样与分辨率、码率与码控、H.264 / H.265 / AV1、AAC / Opus、GOP、封装格式、PTS / DTS、转码与转封装
---

# 音视频基础

> 前置阅读：[音视频总览](./0_overview)

音视频基础是视频平台后端看懂 ffprobe 输出、和音视频工程师顺畅沟通所需的概念。本篇讲压缩与码率、音视频编码、帧类型与 GOP、封装与 PTS / DTS、转码与转封装，基线为 FFmpeg 9.0。

---

## 一、从信号到数据：采样与原始数据量

做视频平台的后端不需要会写编码器，但要能讨论"这路流为什么花屏、为什么首屏慢、为什么这么费带宽"。示例来自一个直播 + 点播的视频平台：主播用 OBS 推 1080p 直播，平台出多档清晰度并生成回放，用户上传的短视频统一转码。

### 1、音频：采样率、位深、声道

声音是连续的空气振动，数字化要做两件事：每秒取多少个点（**采样率**），每个点用多少位表示（**位深**）。这样得到的未压缩数据叫 **PCM**。

| 参数 | 常见取值 | 说明 |
|------|----------|------|
| 采样率 | 8 kHz（电话、监控）、16 kHz（语音识别）、44.1 kHz（CD）、48 kHz（视频、WebRTC） | 按奈奎斯特定理，采样率要大于信号最高频率的 2 倍；人耳上限约 20 kHz，所以 44.1 / 48 kHz 足够 |
| 位深 | 16 bit（主流）、24 bit（录音制作） | 决定动态范围，16 bit 约 96 dB |
| 声道 | 单声道、立体声、5.1 | 直播与短视频以立体声为主，语音通话常用单声道 |

一路 48 kHz、16 bit、立体声 PCM 的码率是 `48000 × 16 × 2 = 1,536,000 bit/s`，约 1.5 Mbps；压成 128 kbps 的 AAC 后只有原来的 1/12。

### 2、视频：分辨率、帧率、像素格式

视频是一连串图像，原始数据量由三个参数决定：

- **分辨率**：每帧的像素数，如 1920×1080（1080p）、1280×720（720p）、3840×2160（4K）。竖屏短视频常用 1080×1920
- **帧率**：每秒多少帧（fps）。电影 24、直播常用 25 / 30、游戏和体育直播 60。帧率越高动作越流畅，码率也越高
- **像素格式**：摄像头输出和编码器输入通常是 **YUV** 而不是 RGB。Y 是亮度，U、V 是色度。人眼对亮度敏感、对色彩不敏感，所以 **YUV 4:2:0** 让每 4 个像素共享一组色度，数据量只有 RGB 的一半，这是视频编码的标准输入格式（FFmpeg 里写作 `yuv420p`）

一帧 1080p、8 bit、YUV 4:2:0 图像占 `1920 × 1080 × 1.5 = 3,110,400` 字节，约 3 MB；30 fps 时码率是 `3110400 × 8 × 30 ≈ 746 Mbps`。而 1080p 直播实际只用 3～6 Mbps，**压缩比在 100 倍以上**。这就是编码器存在的意义，也是"转码很贵"的根源：解码后要处理的正是这种体量的原始数据。

::: tip 位深与 HDR
8 bit 每个分量 256 级，平滑渐变（天空、暗场）容易出现色带；10 bit 有 1024 级，是 HDR 的前提。HDR 还涉及色域（BT.2020）和传递函数（PQ / HLG），终端支持参差不齐，一般平台先保证 SDR 8 bit 稳定，再为特定内容开 HDR 档位。
:::

---

## 二、码率与码控

### 1、码率是什么

**码率**（bitrate）是每秒的数据量，单位 kbps / Mbps。它直接决定三件事：画质（同一编码器下码率越高越清晰）、带宽成本（CDN 按流量或带宽计费，码率 × 观看时长 = 流量）、卡顿率（码率超过用户网速就会卡）。

同样的码率，画面内容不同效果差别很大：静态的课程直播 1.5 Mbps 就很清晰，快速运动的游戏、体育直播 6 Mbps 仍可能出现马赛克。这也是"码率阶梯"不能一刀切的原因。

### 2、码控方式：CBR、VBR、CRF

编码器怎么分配码率，叫**码率控制**（rate control）：

| 方式 | 含义 | 优点 | 缺点 | 适合场景 |
|------|------|------|------|----------|
| CBR（固定码率） | 每秒码率尽量恒定 | 带宽可预测，网络和 CDN 友好 | 简单画面浪费码率，复杂画面不够用 | 直播推流、广电传输 |
| VBR（可变码率） | 设定平均码率，复杂画面多给、简单画面少给 | 同等平均码率下画质更好 | 瞬时码率有峰值，可能超出带宽 | 点播转码 |
| CRF（恒定质量） | 设定质量系数，码率随内容自由浮动 | 质量稳定，文件最小 | 码率完全不可控 | 存档、离线转码 |
| Capped CRF | CRF 加上码率上限 `maxrate` 与缓冲 `bufsize` | 兼顾质量与峰值码率 | 需要按内容调参 | 点播、短视频转码的主流选择 |

x264 的 CRF 取值 0～51，默认 23，数值越小质量越高、文件越大，每增减 6 码率大约翻倍或减半；x265 默认 28。下面是两种典型写法：

```bash
# 直播推流：近似 CBR，码率 4 Mbps，缓冲 2 倍码率
ffmpeg -re -i input.mp4 -c:v libx264 -preset veryfast -tune zerolatency \
  -b:v 4000k -maxrate 4000k -bufsize 8000k \
  -c:a aac -b:a 128k -ar 48000 -f flv rtmp://ingest.example.com/live/room1001

# 点播转码：Capped CRF，质量优先但峰值不超过 4.5 Mbps
ffmpeg -i upload.mov -c:v libx264 -preset slow -crf 23 \
  -maxrate 4500k -bufsize 9000k -c:a aac -b:a 128k output.mp4
```

`maxrate` + `bufsize` 是 VBV（视频缓冲校验器）约束，`bufsize` 越小码率越平稳、画质波动越大。需要严格 CBR（如输出 MPEG-TS 给广电设备）时，x264 还要加 `-x264-params nal-hrd=cbr` 并让 `-b:v`、`-minrate`、`-maxrate` 相等。

### 3、码率阶梯

平台要给不同网络的观众提供多档清晰度，这组"分辨率 + 码率"的组合叫**码率阶梯**（bitrate ladder）。下表是 H.264、30 fps 的常见经验值，实际应按内容复杂度和目标终端测试调整：

| 档位 | 分辨率 | 视频码率 | 音频码率 |
|------|--------|----------|----------|
| 蓝光 | 1920×1080 | 3～6 Mbps | 128 kbps |
| 超清 | 1280×720 | 1.5～3 Mbps | 128 kbps |
| 高清 | 854×480 | 0.8～1.2 Mbps | 96 kbps |
| 流畅 | 640×360 | 0.4～0.8 Mbps | 64 kbps |

H.265 / AV1 在同等画质下码率可以再降 30%～50%（具体收益取决于编码器实现和内容）。更进一步是**按内容的码率阶梯**（per-title / per-scene encoding）：先分析片源复杂度再决定每档码率，动画、课程类内容能省下大量带宽，细节见 [点播与短视频](./7_vod)。

---

## 三、视频编码

编码器利用两类冗余压缩数据：**帧内冗余**（同一帧里相邻像素相似，用预测 + 变换 + 量化压缩）和**帧间冗余**（相邻帧大部分内容不变，只记录运动和差异）。量化是唯一有损的一步，码率控制本质上就是在调量化强度。

| 编码 | 标准化 | 相对 H.264 的压缩效率 | 授权 | 兼容性 | 典型用途 |
|------|--------|------------------------|------|--------|----------|
| H.264 / AVC | ITU-T H.264 与 ISO/IEC 14496-10，2003 年 | 基准 | 专利池授权（Via LA），面向终端用户免费的互联网视频长期不收内容使用费 | 几乎所有浏览器、手机、硬件编解码器 | 直播、点播、会议的默认选择 |
| H.265 / HEVC | ITU-T H.265 与 ISO/IEC 23008-2，2013 年 | 同画质码率约降 30%～50% | 多个专利池（Access Advance、Via LA）及独立权利人，授权复杂 | 苹果设备全面支持；Chrome / Edge 依赖硬件解码；安防摄像头普遍支持 | 4K、监控、移动端 App 内播放 |
| VP9 | Google，2013 年 | 与 HEVC 接近 | 免版税 | Chrome、Firefox、Android；苹果平台支持有限 | YouTube、WebM、WebRTC |
| AV1 | AOMedia，2018 年 | 优于 HEVC | 设计为免版税（AOMedia 专利许可） | 主流浏览器支持软解；Safari 仅在有硬件解码的设备上支持；编码计算量大 | 大型点播平台、新一代 WebRTC |
| H.266 / VVC | ITU-T H.266，2020 年 | 优于 AV1 | 专利池授权 | 终端支持仍很少 | 前瞻研究，暂不建议上生产 |

几点工程上的取舍：

- **H.264 仍是兜底编码**：所有档位至少保留一份 H.264，保证老设备和所有浏览器能播。常用 High Profile；面向极老设备或 WebRTC 时用 Constrained Baseline（不含 B 帧）
- **H.265 用于"终端可控"的场景**：自家 App 内置播放器、安防监控、4K 内容。网页播放前要做能力探测（`MediaSource.isTypeSupported('video/mp4; codecs="hvc1.1.6.L120.90"')`），不支持就回退 H.264。商用前请法务确认授权方案
- **AV1 适合"编一次播很多次"的点播**：编码耗时可达 H.264 的数倍到数十倍，但热门内容观看量大，带宽节省能覆盖计算成本。SVT-AV1 编码器速度已大幅改善，硬件编码也在新一代 GPU 上普及
- **编码参数字符串要写对**：HLS 主播放列表与 MSE 都靠 `CODECS` 判断能否播放，例如 `avc1.640028` 表示 H.264 High Profile Level 4.0，`hvc1` / `hev1` 是 HEVC 的两种封装方式，苹果设备要求 `hvc1`

---

## 四、音频编码

| 编码 | 标准 | 码率范围 | 延迟 | 授权 | 兼容性与用途 |
|------|------|----------|------|------|--------------|
| AAC（LC / HE-AAC） | ISO/IEC 14496-3 | LC 常用 96～192 kbps；HE-AAC 适合 64 kbps 以下 | 较高（几十毫秒级） | 专利池授权（Via LA），解码器普遍随系统授权 | RTMP、HLS、MP4 的标准音频，兼容性最好 |
| Opus | RFC 6716 | 6～510 kbps | 低，默认帧长 20 ms，最低可到 2.5 ms | 免版税 | WebRTC 强制支持的音频编码，语音与音乐兼顾 |
| G.711（PCMA / PCMU） | ITU-T G.711 | 固定 64 kbps | 极低 | 无专利负担 | 电话、对讲、监控摄像头 |
| MP3 | ISO/IEC 11172-3 | 128～320 kbps | 较高 | 专利已过期 | 音乐文件，直播很少用 |

一个经常踩的坑：**WebRTC 默认 Opus，RTMP / FLV 和传统 HLS 只认 AAC**。浏览器连麦的流要转推到 CDN 做 RTMP / HLS 分发时，服务器必须把 Opus 转码成 AAC；反过来摄像头的 G.711 或 AAC 要在网页 WebRTC 里播放，也可能需要转成 Opus。音频转码 CPU 开销远小于视频，但必须在流媒体服务器上显式开启（SRS、ZLMediaKit 都有对应开关）。Enhanced RTMP v2 规范为 RTMP 增加了 Opus，但截至 2026 年 10 月仍是 alpha，CDN 侧支持有限。

---

## 五、帧类型与 GOP

### 1、I 帧、P 帧、B 帧

![I / P / B 帧与 GOP](../assets/media/basics-gop.svg)

| 帧类型 | 参考关系 | 大小 | 说明 |
|--------|----------|------|------|
| I 帧（帧内编码帧） | 不参考其他帧 | 最大，常是 P 帧的数倍 | 可以独立解码，是播放器"进入"码流的起点 |
| P 帧（前向预测帧） | 参考前面的 I / P 帧 | 中等 | 只记录相对前面帧的变化 |
| B 帧（双向预测帧） | 参考前后两个方向的帧 | 最小 | 压缩率最高，但要等后面的帧到了才能解码 |

**IDR 帧**是特殊的 I 帧：它之后的帧不再参考它之前的任何帧，解码器遇到 IDR 会清空参考帧列表。播放器起播、切换清晰度、HLS 切片都要求从 IDR 帧开始。

### 2、GOP 的长度怎么定

**GOP**（Group of Pictures）指两个关键帧之间的一组帧，长度通常用帧数或秒数表示。GOP 长度是直播调参的核心参数之一：

| 影响 | GOP 越长 | GOP 越短 |
|------|----------|----------|
| 压缩效率 | I 帧少，码率更省 | I 帧多，同画质码率更高 |
| 首屏时间 | 播放器可能要等较久才拿到 I 帧 | 很快拿到 I 帧 |
| 切片与延迟 | HLS 切片只能在关键帧处切，切片变长，延迟升高 | 切片可以更短 |
| 抗丢包 | 出错后要等下一个 I 帧才能恢复，花屏时间长 | 恢复快 |

常见取值：直播 GOP 取 1～2 秒（25 fps 下 `-g 50` 即 2 秒）；点播取 2～4 秒，并与切片时长对齐。

```bash
# 固定 2 秒 GOP：关键帧间隔恒定 50 帧，关闭场景切换插入关键帧，不用 B 帧
ffmpeg -i input.mp4 -c:v libx264 -preset veryfast -r 25 \
  -g 50 -keyint_min 50 -sc_threshold 0 -bf 0 \
  -c:a aac -b:a 128k output.mp4
```

`-sc_threshold 0` 的作用是禁止编码器在场景切换处额外插入关键帧，否则 GOP 长度不固定，多码率之间的切片边界就对不齐，播放器切换清晰度时会跳帧。

### 3、秒开与 GOP 缓存

观众进入直播间时，如果服务器从"当前时刻"开始转发，播放器拿到的第一帧大概率是 P 帧，必须等到下一个 I 帧才能出画面，GOP 为 4 秒时首屏最坏要等 4 秒。流媒体服务器普遍提供 **GOP 缓存**：始终缓存最近一个完整 GOP，新观众连上来时先把这段缓存发过去，播放器立即从 I 帧开始解码，代价是观众一开始就落后直播最多一个 GOP 的时长。这是"秒开"与"低延迟"之间的典型取舍，配置方式见 [流媒体服务器](./4_media_server)。

::: tip 低延迟为什么要关 B 帧
B 帧要等它后面的参考帧编码完成才能输出，每多一个连续 B 帧，编码端就要多缓存一帧，延迟随之增加；B 帧还让解码顺序与显示顺序不一致。x264 的 `-tune zerolatency` 会关闭 B 帧和帧级多线程前瞻，WebRTC 与 FFmpeg 的 WHIP 推流都要求 H.264 不带 B 帧。点播没有实时性要求，保留 B 帧可以节省码率。
:::

---

## 六、封装格式

编码器输出的是一个个**压缩包**（packet），要播放或传输，还需要把音频包、视频包、时间戳、编码参数装进一个**容器**（container），这一步叫封装（mux），反过来叫解封装（demux）。容器决定了能装哪些编码、能否边下边播、能否流式传输。

| 容器 | 结构特点 | 能否流式 | 常装编码 | 典型用途 |
|------|----------|----------|----------|----------|
| MP4 | ISO 基础媒体文件格式（ISOBMFF，ISO/IEC 14496-12），由 box 组成；`moov` 存索引，`mdat` 存数据 | 普通 MP4 需要先拿到 `moov` 才能播 | H.264 / H.265 / AV1 + AAC / Opus | 点播文件、短视频、录制回放 |
| fMP4（分片 MP4） | 一个初始化段（`ftyp` + `moov`）加若干 `moof` + `mdat` 分片 | 可以 | 同 MP4 | HLS（fMP4 切片）、DASH、CMAF、LL-HLS |
| FLV | Adobe 定义，文件头 + 一串 Tag（音频、视频、脚本），结构极简 | 可以 | 传统只有 H.264 + AAC；Enhanced RTMP 扩展了 HEVC / AV1 / VP9 | RTMP 推流、HTTP-FLV 直播 |
| MPEG-TS | ISO/IEC 13818-1，固定 188 字节的包，靠 PAT / PMT 表描述节目 | 可以，从任意包开始都能同步 | H.264 / H.265 + AAC | 传统 HLS 切片、广电、SRT 承载 |
| MKV / WebM | Matroska 容器，WebM 是其子集（限定 VP8 / VP9 / AV1 + Vorbis / Opus） | 可以 | 几乎任意编码 | 本地文件、浏览器录制（MediaRecorder）、WebM 点播 |

几个和后端直接相关的点：

- **MP4 的 faststart**：编码器默认在文件末尾写 `moov`（写完才知道索引），浏览器播放时要先下载到末尾才能起播。上传转码时加 `-movflags +faststart` 把 `moov` 挪到文件头，用户点开即播。短视频平台这一步必须做
- **MP4 录制怕中断**：普通 MP4 在录制进程崩溃时 `moov` 还没写，文件无法播放。长时间录制（直播回放、监控）建议录成 FLV / TS / fMP4，结束后再转封装成 MP4
- **TS 的额外开销**：188 字节包头加 PES 头，相比 fMP4 多出几个百分点的码率；新项目的 HLS 优先用 fMP4 切片，便于和 DASH 共用一套文件（见 [流媒体协议](./2_protocols) 的 CMAF 部分）
- **容器 ≠ 编码**：扩展名是 `.mp4` 不代表一定是 H.264，可能是 HEVC 甚至 AV1。上传接口应当用 ffprobe 读出真实的编码和参数，而不是只看扩展名和 MIME 类型

---

## 七、时间戳：PTS 与 DTS

### 1、两个时间戳

每个压缩包带两个时间戳：

- **DTS**（Decoding Time Stamp）：什么时候送进解码器
- **PTS**（Presentation Time Stamp）：解码出来的帧什么时候显示

没有 B 帧时两者相等；有 B 帧时，被 B 帧引用的 P 帧要先解码，于是出现 DTS 顺序与 PTS 顺序不一致（见上一节的图）。规则是：**同一路流里 DTS 必须单调递增，且每一帧 PTS ≥ DTS**。不满足时 FFmpeg 会报 `Non-monotonous DTS` 之类的警告，播放器可能卡顿或花屏。

时间戳是整数，单位由**时间基**（time base）决定：MPEG-TS 固定 1/90000 秒，FLV 固定毫秒，MP4 每条轨道自定义（视频常见 1/90000 或帧率的倍数，音频常用采样率）。用 ffprobe 可以直接看到：

```bash
# 查看前 8 个视频包的 PTS、DTS 和是否关键帧（flags 含 K 表示关键帧）
ffprobe -v error -select_streams v:0 \
  -show_entries packet=pts_time,dts_time,flags -of csv=p=0 \
  -read_intervals "%+#8" input.mp4
```

### 2、音画同步与时间戳问题

播放器通常**以音频为主时钟**：人耳对声音断续比画面掉帧更敏感，所以视频帧按 PTS 去追音频时钟，快了等、慢了丢。音画不同步、卡顿，多数要追溯到时间戳：

| 现象 | 常见原因 | 处理思路 |
|------|----------|----------|
| 推流端断网重连后播放器卡住 | 重连后时间戳从 0 重新开始，服务器或播放器以为时间倒退 | 流媒体服务器开启时间戳修正（如 SRS 的 `time_jitter`、ZLMediaKit 的时间戳修整选项），或推流端保持时间戳连续 |
| 长时间直播约 26.5 小时后出问题 | MPEG-TS 的 PTS 只有 33 位，90 kHz 下 `2^33 / 90000 ≈ 26.5` 小时回绕 | 服务器和播放器需正确处理回绕，HLS 遇到时间戳不连续要写 `#EXT-X-DISCONTINUITY` |
| FLV 时间戳超长后错乱 | FLV 时间戳为 32 位毫秒（24 位 + 8 位扩展），约 49.7 天回绕 | 超长直播定期重新推流或由服务器重写时间戳 |
| 声音和画面持续偏移 | 采集端音视频时钟不一致，或转码时音频重采样丢失样本 | 推流端用统一时钟打时间戳；转码时用 `aresample=async=1` 做音频时间戳补偿 |

---

## 八、转码与转封装

具体的 FFmpeg 用法见 [FFmpeg 与转码](./3_ffmpeg)，本篇只在需要时给出最小命令。

![转封装与转码](../assets/media/basics-transcode-remux.svg)

两者经常被混为一谈，但成本差了几个数量级：

| 对比项 | 转封装（Transmux / Remux） | 转码（Transcode） |
|--------|---------------------------|-------------------|
| 做了什么 | 解封装后把压缩包原样装进新容器 | 解码成原始数据，处理后重新编码 |
| CPU 开销 | 极低，一台服务器可同时处理成百上千路 | 很高，一路 1080p 实时转多档码率可能占满数个 CPU 核 |
| 画质 | 无损 | 每次编码都有损失，要避免多次转码 |
| 延迟 | 几乎不增加 | 编码器缓冲带来额外延迟 |
| 能改什么 | 只能改容器和协议 | 编码、分辨率、帧率、码率、水印都能改 |
| 典型场景 | RTMP 转 HLS / HTTP-FLV、FLV 录制转 MP4、TS 切片转 fMP4 | 多码率阶梯、HEVC 转 H.264 兼容、Opus 转 AAC、加水印 |

```bash
# 转封装：FLV 录制文件转 MP4，只拷贝不重编码，几秒完成
ffmpeg -i record.flv -c copy -movflags +faststart record.mp4

# 转码：输出 720p H.264，适配低端设备
ffmpeg -i record.flv -vf scale=-2:720 -c:v libx264 -preset veryfast -crf 23 \
  -c:a aac -b:a 128k -movflags +faststart record_720p.mp4
```

转封装时要注意**码流格式**的差异：H.264 在 MP4 / FLV 里用 AVCC 格式（长度前缀，SPS / PPS 放在容器头），在 TS 里用 Annex B 格式（起始码 `00 00 00 01`，SPS / PPS 内联在码流中）；AAC 在 TS 里带 ADTS 头，在 MP4 里用 AudioSpecificConfig。FFmpeg 通过 bitstream filter（`h264_mp4toannexb`、`aac_adtstoasc`）完成转换，新版本的封装器多数情况下会自动插入，但自研转封装或排查花屏时要知道这一层。

决策原则很简单：**能转封装就不转码**。只有当终端不支持源编码、需要多档码率、需要改画面（水印、裁剪）时才转码，并且转码尽量只做一次——用户上传的原始文件保存一份"母版"，所有档位都从母版直接转出，而不是从 1080p 转 720p 再转 480p。

---

## 九、后端视角：用 ffprobe 探测媒资信息

视频平台的上传流程里，后端最常做的"音视频操作"就是探测：校验上传文件确实是视频、读出时长和分辨率写进媒资表、决定需要转哪些档位。用 `ffprobe` 输出 JSON 再映射成 Java 对象即可：

```bash
ffprobe -v error -print_format json -show_format -show_streams upload.mp4
```

```java
// Spring Boot 4 默认使用 Jackson 3（tools.jackson 包），注解仍在 com.fasterxml.jackson.annotation
@JsonIgnoreProperties(ignoreUnknown = true)
public record ProbeResult(Format format, List<StreamInfo> streams) {

    @JsonIgnoreProperties(ignoreUnknown = true)
    public record Format(@JsonProperty("format_name") String formatName,
                         String duration,
                         @JsonProperty("bit_rate") String bitRate) {}

    @JsonIgnoreProperties(ignoreUnknown = true)
    public record StreamInfo(@JsonProperty("codec_type") String codecType,
                             @JsonProperty("codec_name") String codecName,
                             Integer width,
                             Integer height,
                             @JsonProperty("avg_frame_rate") String avgFrameRate) {}
}
```

```java
@Component
public class MediaProbe {

    private final JsonMapper jsonMapper;

    public MediaProbe(JsonMapper jsonMapper) {
        this.jsonMapper = jsonMapper;
    }

    public ProbeResult probe(Path file) throws IOException, InterruptedException {
        Process process = new ProcessBuilder(
                "ffprobe", "-v", "error", "-print_format", "json",
                "-show_format", "-show_streams", file.toString())
                .redirectError(ProcessBuilder.Redirect.DISCARD)
                .start();
        String json;
        try (InputStream in = process.getInputStream()) {
            // 先读完标准输出再等待退出，避免输出缓冲区写满导致子进程阻塞
            json = new String(in.readAllBytes(), StandardCharsets.UTF_8);
        }
        if (!process.waitFor(30, TimeUnit.SECONDS)) {
            process.destroyForcibly();
            throw new IOException("ffprobe timeout: " + file);
        }
        if (process.exitValue() != 0) {
            throw new IOException("ffprobe failed, exit=" + process.exitValue() + ", file=" + file);
        }
        return jsonMapper.readValue(json, ProbeResult.class);
    }
}
```

几点注意：

- **参数用列表传，不拼接 shell 字符串**：文件名来自用户上传时，拼成 `sh -c "ffprobe ... " + name` 会引入命令注入；`ProcessBuilder` 按参数列表传递不经过 shell
- **数值字段是字符串**：ffprobe 的 `duration`、`bit_rate` 输出为字符串，`avg_frame_rate` 是 `30/1`、`30000/1001` 这样的分数，入库前自行换算
- **探测放在异步链路**：大文件或网络存储上的文件探测可能耗时数秒，应在上传完成的回调里投递任务处理，而不是在 HTTP 请求线程里同步执行；进程管理、进度解析与超时控制的完整写法见 [FFmpeg 与转码](./3_ffmpeg)

---

## 小结

- 原始音视频体量巨大：1080p30 YUV 4:2:0 约 746 Mbps，压到 3～6 Mbps 靠的是编码器；转码之所以贵，是因为要在这种体量的原始数据上工作
- 码率决定画质、带宽成本和卡顿率；直播用近似 CBR，点播用 Capped CRF；多档清晰度组成码率阶梯，最好按内容复杂度调整
- H.264 + AAC 是兜底组合；H.265 用于终端可控场景并注意授权；AV1 适合高观看量的点播；WebRTC 默认 Opus，转 RTMP / HLS 要转成 AAC
- I 帧可独立解码，GOP 决定首屏、切片和延迟；直播 GOP 1～2 秒、固定间隔、关闭 B 帧，服务器用 GOP 缓存换秒开
- MP4 要 faststart，长时间录制用 FLV / TS / fMP4；新 HLS 项目优先 fMP4 切片；容器不等于编码，以 ffprobe 结果为准
- DTS 决定解码顺序、PTS 决定显示顺序；时间戳跳变、回绕是卡顿和音画不同步的常见根源
- 能转封装就不转码，转码只从母版做一次；后端通过 ffprobe 探测媒资信息，用参数列表启动进程防注入

## 参考资料

- H.264 标准：[ITU-T H.264 Advanced video coding for generic audiovisual services](https://www.itu.int/rec/T-REC-H.264)
- H.265 标准：[ITU-T H.265 High efficiency video coding](https://www.itu.int/rec/T-REC-H.265)
- AV1 规范：[AV1 Bitstream & Decoding Process Specification](https://aomediacodec.github.io/av1-spec/)
- Opus 规范：[RFC 6716 - Definition of the Opus Audio Codec](https://www.rfc-editor.org/rfc/rfc6716)
- WebRTC 音频编码要求：[RFC 7874 - WebRTC Audio Codec and Processing Requirements](https://www.rfc-editor.org/rfc/rfc7874)
- WebRTC 视频编码要求：[RFC 7742 - WebRTC Video Processing and Codec Requirements](https://www.rfc-editor.org/rfc/rfc7742)
- FFmpeg H.264 编码指南（CRF、码控、preset）：[FFmpeg Wiki - H.264 Video Encoding Guide](https://trac.ffmpeg.org/wiki/Encode/H.264)
- FFmpeg 码率控制说明：[FFmpeg Wiki - Limiting the output bitrate](https://trac.ffmpeg.org/wiki/Limiting%20the%20output%20bitrate)
- ffprobe 文档：[ffprobe Documentation](https://ffmpeg.org/ffprobe.html)
- FFmpeg bitstream filter：[FFmpeg Bitstream Filters Documentation](https://ffmpeg.org/ffmpeg-bitstream-filters.html)
- 浏览器编码支持参考：[MDN - Web video codec guide](https://developer.mozilla.org/en-US/docs/Web/Media/Guides/Formats/Video_codecs)
- 编码参数字符串：[MDN - The "codecs" parameter in common media types](https://developer.mozilla.org/en-US/docs/Web/Media/Guides/Formats/codecs_parameter)
- FFmpeg 版本发布：[FFmpeg Download & Releases](https://ffmpeg.org/download.html)

> 下一篇：[流媒体协议](./2_protocols)
