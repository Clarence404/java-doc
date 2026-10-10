---
description: ffprobe 探测、H.264/AAC 转码、多码率 HLS、截图、转封装、推流、硬件加速、Java 调用与异步转码任务
---

# FFmpeg 与转码

> 前置阅读：[音视频基础](./1_basics)、[流媒体协议](./2_protocols)

FFmpeg 是把解封装、编解码、滤镜和推拉流集中在一个命令行里的音视频工具。本篇讲 ffprobe、常用转码命令、硬件加速、Java 调用与异步转码任务，基线为 FFmpeg 9.0。

---

## 一、命令结构与 ffprobe

FFmpeg 是音视频领域事实上的"瑞士军刀"，很多媒体处理服务的底层也基于它。本篇版本为 FFmpeg 9.0（当前 9.0.2，2026-09 发布；8.1 系列仍在维护）。示例统一用一个直播 / 视频平台的场景：用户上传视频 → 转成多码率 HLS → 生成封面与进度条缩略图 → 在 App 和 Web 播放。

::: tip 许可证要先想清楚
FFmpeg 本体是 LGPL 2.1+；一旦编译时带 `--enable-gpl`（libx264、libx265 都需要），整个二进制就按 GPL 分发；带 `--enable-nonfree`（如 libfdk_aac）的构建不能再分发。服务端自己用一般没问题，但要把 FFmpeg 打进交付给客户的产品或客户端时，先让法务确认用的是哪种构建。
:::

### 1、命令行的基本结构

```bash
ffmpeg [全局选项] [输入选项] -i 输入 [输出选项] 输出
```

选项**作用于紧跟其后的那个文件**：写在 `-i` 前面是输入选项（如 `-ss` 定位、`-re` 按原速读），写在输出文件名前面是输出选项（如 `-c:v`、`-b:v`）。最常见的错误就是把输出选项写到了 `-i` 前面，导致它不生效或报错。

| 写法 | 含义 |
|------|------|
| `-c:v libx264` / `-c:a aac` | 指定视频 / 音频编码器；`-c copy` 表示不重新编码，直接拷贝码流 |
| `-b:v 3000k` / `-b:a 128k` | 目标码率 |
| `-map 0:v:0` | 显式选择第 0 个输入的第 0 路视频流；不写时 FFmpeg 按规则自动挑一路视频、一路音频 |
| `-vf` / `-af` / `-filter_complex` | 视频滤镜 / 音频滤镜 / 多输入多输出的复杂滤镜图 |
| `-c:v:1`、`-b:v:1` | 带流序号的写法，作用于输出中第 1 路视频，多码率输出时会用到 |
| `-y` / `-nostdin` | 覆盖已有输出 / 不读标准输入，服务端调用必加 |

### 2、ffprobe：先看清楚再转

转码前先探测源文件，拿到时长、分辨率、帧率、编码和音轨信息，用来决定输出档位、计算进度百分比，也用来拒绝不合法的输入：

```bash
ffprobe -v error -print_format json -show_format -show_streams input.mp4
```

输出（节选）：

```json
{
  "streams": [
    {
      "index": 0,
      "codec_name": "h264",
      "codec_type": "video",
      "profile": "High",
      "width": 1920,
      "height": 1080,
      "pix_fmt": "yuv420p",
      "r_frame_rate": "30/1",
      "avg_frame_rate": "30/1",
      "bit_rate": "6012345"
    },
    {
      "index": 1,
      "codec_name": "aac",
      "codec_type": "audio",
      "sample_rate": "48000",
      "channels": 2,
      "bit_rate": "128000"
    }
  ],
  "format": {
    "format_name": "mov,mp4,m4a,3gp,3g2,mj2",
    "duration": "183.533333",
    "size": "140123456",
    "bit_rate": "6107890"
  }
}
```

几个要点：

- **`format_name` 是解封装器名**，MP4 显示为 `mov,mp4,m4a,3gp,3g2,mj2`，不是文件扩展名。上传文件的扩展名不可信，要以这里为准做白名单
- **帧率看 `avg_frame_rate`**，手机拍摄的可变帧率视频 `r_frame_rate` 可能是一个很大的值；旋转信息在 `side_data_list` 的 Display Matrix 里，竖屏视频要留意
- 只要单个字段时用 `-show_entries` 精确输出，省去 JSON 解析，例如只取时长：

```bash
ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 input.mp4
# 183.533333
```

---

## 二、常用转码命令

### 1、H.264/AAC 转码：CRF 与 preset

```bash
ffmpeg -i input.mov \
  -c:v libx264 -preset medium -crf 23 -pix_fmt yuv420p \
  -c:a aac -b:a 128k -ac 2 \
  -movflags +faststart \
  output.mp4
```

| 参数 | 作用 | 建议 |
|------|------|------|
| `-crf 23` | 恒定质量模式，0～51，数字越小质量越高、文件越大；每 ±6 文件大小约翻倍或减半 | libx264 默认 23；18 左右肉眼接近无损；点播常用 20～26 |
| `-preset medium` | 编码速度与压缩率的权衡：`ultrafast` … `medium`（默认）… `veryslow` | 同样画质下越慢文件越小；离线点播用 `medium` / `slow`，直播用 `veryfast` 及更快 |
| `-pix_fmt yuv420p` | 输出像素格式 | 源是 10bit 或 4:4:4 时不加会输出播放器不兼容的格式 |
| `-movflags +faststart` | 把 MP4 的 moov 索引挪到文件开头 | 用于网页渐进式播放，不加时浏览器要下载到文件末尾才能开播 |

CRF 只保证质量、不保证码率，遇到复杂画面码率会飙高。需要给 CDN 成本或弱网兜底时用"**限峰值的 CRF**"：

```bash
ffmpeg -i input.mov -c:v libx264 -preset medium -crf 23 \
  -maxrate 4000k -bufsize 8000k -pix_fmt yuv420p \
  -c:a aac -b:a 128k output.mp4
```

`-maxrate` 与 `-bufsize` 一起启用 VBV 码率控制，`bufsize` 通常取 `maxrate` 的 1～2 倍。直播推流则用固定目标码率（`-b:v` + `-maxrate` + `-bufsize`），因为上行带宽是硬约束。

### 2、缩放与常用滤镜

```bash
# 缩放到 720p，宽度按比例取偶数（-2 保证能被 2 整除，H.264 要求宽高为偶数）
ffmpeg -i input.mp4 -vf "scale=-2:720" -c:v libx264 -crf 23 -c:a copy out_720p.mp4

# 限制在 1280x720 以内，小视频不放大
ffmpeg -i input.mp4 -vf "scale=w=1280:h=720:force_original_aspect_ratio=decrease:force_divisible_by=2" \
  -c:v libx264 -crf 23 -c:a copy out.mp4

# 统一帧率为 30，并截取第 10～70 秒
ffmpeg -ss 10 -i input.mp4 -t 60 -vf "fps=30" -c:v libx264 -crf 23 -c:a aac clip.mp4
```

`-ss` 写在 `-i` 前面是**输入定位**，借助索引快速跳转，转码时依然精确；写在 `-i` 后面会从头解码到目标点，慢得多。`-t` 是时长，`-to` 是结束时间点。

### 3、多码率 HLS

点播要让播放器按网速自适应切换清晰度（ABR），需要同一视频的多个码率档位，切片边界必须对齐。用 `split` 一次解码、多路缩放编码，再由 HLS 封装器的 `var_stream_map` 把视频与音频配对成多个变体：

```bash
ffmpeg -i input.mp4 \
  -filter_complex "[0:v]split=3[v1][v2][v3];[v1]scale=w=1920:h=1080[v1out];[v2]scale=w=1280:h=720[v2out];[v3]scale=w=854:h=480[v3out]" \
  -map "[v1out]" -c:v:0 libx264 -b:v:0 5000k -maxrate:v:0 5350k -bufsize:v:0 7500k \
  -map "[v2out]" -c:v:1 libx264 -b:v:1 2800k -maxrate:v:1 2996k -bufsize:v:1 4200k \
  -map "[v3out]" -c:v:2 libx264 -b:v:2 1400k -maxrate:v:2 1498k -bufsize:v:2 2100k \
  -preset medium -pix_fmt yuv420p \
  -force_key_frames "expr:gte(t,n_forced*2)" -sc_threshold 0 \
  -map a:0 -c:a:0 aac -b:a:0 128k -ac 2 \
  -map a:0 -c:a:1 aac -b:a:1 128k -ac 2 \
  -map a:0 -c:a:2 aac -b:a:2 96k -ac 2 \
  -f hls -hls_time 6 -hls_playlist_type vod -hls_flags independent_segments \
  -hls_segment_type mpegts \
  -hls_segment_filename "out/%v/seg_%03d.ts" \
  -master_pl_name master.m3u8 \
  -var_stream_map "v:0,a:0,name:1080p v:1,a:1,name:720p v:2,a:2,name:480p" \
  "out/%v/index.m3u8"
```

生成的目录：

```text
out/
├── master.m3u8          # 主播放列表，列出三个变体及其带宽、分辨率
├── 1080p/index.m3u8     # 变体播放列表
├── 1080p/seg_000.ts ...
├── 720p/...
└── 480p/...
```

关键点：

- **关键帧对齐**：`-force_key_frames "expr:gte(t,n_forced*2)"` 每 2 秒强制一个关键帧，`-sc_threshold 0` 关掉 x264 的场景切换自动插关键帧，保证三个档位在同一时间点切片，播放器才能无缝切换。`hls_time` 取关键帧间隔的整数倍
- **`%v` 必须出现**：变体数 ≥ 2 时输出文件名和 `hls_segment_filename` 都要含 `%v`；`var_stream_map` 里写了 `name:` 时，`%v` 替换为名字而不是序号
- **`hls_playlist_type vod`** 让播放列表一次写完整并带 `#EXT-X-ENDLIST`；直播切片用 `event` 或不设置，并配合 `hls_list_size` 控制窗口
- **fMP4 切片**：`-hls_segment_type fmp4` 生成 `.m4s` + `init.mp4`，需要 HLS 版本 7 以上，好处是可以与 DASH 共用切片、支持 HEVC；老设备兼容性最好的仍是 TS
- 档位不要比源分辨率高：先用 ffprobe 读出源宽高，只生成不高于源的档位，参数由代码拼出来（见第四节）

档位与码率是业务决策：短视频平台通常 3～4 档，长视频会再加 4K 和音频单独分组。多码率 HLS 的播放、加密与 CDN 分发见 [点播与短视频](./7_vod)。

### 4、截图与缩略图

```bash
# 第 5 秒截一张封面（-ss 在 -i 前快速定位，-q:v 2 为高质量 JPEG）
ffmpeg -ss 5 -i input.mp4 -frames:v 1 -q:v 2 cover.jpg

# 让 FFmpeg 在开头若干帧里挑一张"最有代表性"的帧，避开黑屏
ffmpeg -i input.mp4 -vf "thumbnail=300,scale=640:-2" -frames:v 1 cover.jpg

# 每 10 秒一张、160 宽，拼成 10x10 的雪碧图，用于进度条拖动预览
ffmpeg -i input.mp4 -vf "fps=1/10,scale=160:-2,tile=10x10" -frames:v 1 -q:v 5 sprite.jpg
```

雪碧图配一个 WebVTT 文件描述"第几秒对应图里的哪个区域"，主流 Web 播放器都能直接读取。超过 1000 秒的视频一张 10x10 装不下，去掉 `-frames:v 1` 并把输出写成 `sprite_%03d.jpg` 即可输出多张。

### 5、转封装：不重新编码

编码格式已经符合要求、只是容器不对时，用 `-c copy` 只换封装，速度接近磁盘拷贝，画质零损失：

```bash
# 直播录制的 FLV 转成 MP4，供点播回放
ffmpeg -i record.flv -c copy -movflags +faststart record.mp4

# TS 切片合并为 MP4（concat 解复用器，list.txt 每行 file 'seg_000.ts'）
ffmpeg -f concat -safe 0 -i list.txt -c copy merged.mp4

# 只保留视频和第一路音频，丢弃字幕和多余音轨
ffmpeg -i input.mkv -map 0:v:0 -map 0:a:0 -c copy output.mp4
```

`-c copy` 有两个限制：一是剪辑起止点只能落在关键帧上，`-ss 10 -c copy` 实际会从 10 秒之前最近的关键帧开始；二是目标容器必须支持该编码，例如 MP4 装不了 FLV 里的 Speex 音频，这时只对音频转码（`-c:v copy -c:a aac`）。ADTS 格式的 AAC 写入 MP4 需要 `aac_adtstoasc` 位流滤镜，新版本 FFmpeg 会自动插入，老版本报错时显式加 `-bsf:a aac_adtstoasc`。

### 6、推流到 RTMP

```bash
# 本地文件循环推流，模拟一个主播（-re 按原始速率读取，否则会以最快速度推完）
ffmpeg -re -stream_loop -1 -i demo.mp4 \
  -c:v libx264 -preset veryfast -tune zerolatency \
  -b:v 2500k -maxrate 2500k -bufsize 5000k -g 60 -keyint_min 60 \
  -c:a aac -b:a 128k -ar 44100 \
  -f flv "rtmp://push.live.example.com/live/room_1001?expire=1791590400&token=3f9c..."

# 源已经是 H.264/AAC 时直接拷贝转推，例如把一路直播转推到另一个平台
ffmpeg -i "rtmp://origin.live.example.com/live/room_1001" -c copy -f flv "rtmp://relay.example.net/app/key"
```

直播推流要点：固定 GOP（30fps 下 `-g 60` 即 2 秒一个关键帧，影响首屏时间和 HLS 切片）、固定码率、`-tune zerolatency` 关掉 B 帧和前瞻以降低编码延迟。RTMP URL 里的 `token` 由业务服务签发，流媒体服务器在推流时回调业务鉴权，见 [流媒体服务器](./4_media_server) 第四节。

---

## 三、硬件加速

软件编码（libx264）画质稳定、参数最全，但很吃 CPU。转码量大或要做实时多路转码时，可以把解码、缩放、编码放到 GPU 上：

| 平台 | 编码器 | 典型用法 | 说明 |
|------|--------|----------|------|
| NVIDIA | `h264_nvenc` / `hevc_nvenc` / `av1_nvenc` | `-hwaccel cuda -hwaccel_output_format cuda` + `scale_cuda` | 吞吐最高，生态成熟；消费级显卡有并发编码会话数限制 |
| Intel | `h264_qsv` / `hevc_qsv` | `-hwaccel qsv` + `scale_qsv`，或走 VAAPI | 核显即可用，适合成本敏感的转码集群 |
| Linux 通用 | `h264_vaapi` | `-hwaccel vaapi -hwaccel_device /dev/dri/renderD128` | Intel / AMD 在 Linux 下的统一接口 |
| macOS | `h264_videotoolbox` | `-c:v h264_videotoolbox` | 开发机本地测试用 |

NVIDIA 全链路 GPU 处理（解码、缩放、编码都在显存里，不回拷到内存）：

```bash
ffmpeg -hwaccel cuda -hwaccel_output_format cuda -i input.mp4 \
  -vf "scale_cuda=1280:720" \
  -c:v h264_nvenc -preset p5 -tune hq -rc vbr -cq 23 -b:v 0 -maxrate 4000k -bufsize 8000k \
  -c:a copy out_720p.mp4
```

使用硬件加速前要确认三件事：

- **构建是否带了对应模块**：`ffmpeg -hide_banner -hwaccels` 列出可用的硬件加速方式，`ffmpeg -hide_banner -encoders | grep nvenc` 确认编码器存在；发行版自带的 FFmpeg 常常没有 NVENC
- **容器里能不能访问设备**：Kubernetes 中 NVIDIA 需要安装 device plugin 并在 Pod 里申请 `nvidia.com/gpu`，Intel / VAAPI 需要挂载 `/dev/dri`
- **画质是否可接受**：同码率下硬件编码画质通常略逊于 libx264 的 `medium`，NVENC 的 preset 从 `p1`（最快）到 `p7`（最好）。点播精品内容仍常用软件编码，直播转码和大批量 UGC 用硬件编码

---

## 四、在 Java 中调用 FFmpeg

### 1、用参数列表，不要拼 shell 命令

```java
// 错误：经过 shell，文件名里的 ; $( ) 会被当作命令执行
Runtime.getRuntime().exec(new String[]{"sh", "-c", "ffmpeg -i " + fileName + " out.mp4"});

// 正确：每个参数是数组的一个元素，不经过 shell，不存在命令注入
new ProcessBuilder("ffmpeg", "-i", inputPath.toString(), outputPath.toString());
```

参数列表消除了 shell 注入，但 FFmpeg 自身还有两类风险需要防：

- **以 `-` 开头的文件名会被当成选项**：输入、输出路径一律由服务端生成（如 `/data/transcode/{jobId}/source`），不使用用户提供的文件名
- **"视频"可能是一个播放列表**：攻击者上传扩展名为 `.mp4`、内容是 HLS 或 concat 列表的文件，FFmpeg 会按列表去读本地文件或请求内网地址（SSRF）。先用 ffprobe 读 `format_name`，只放行白名单里的解封装器（如 `mov,mp4,m4a,3gp,3g2,mj2`、`matroska,webm`、`flv`、`mpegts`）；转码 Worker 跑在无内网权限、只读根文件系统的容器里

### 2、进度、超时与强杀

`-progress pipe:1` 让 FFmpeg 把进度以 `key=value` 的形式周期性写到标准输出，每个块以 `progress=continue` 结尾，最后一块是 `progress=end`：

```text
frame=1450
fps=96.31
out_time_us=48300000
out_time=00:00:48.300000
speed=3.21x
progress=continue
```

用 `out_time_us`（已输出的媒体时长，微秒）除以 ffprobe 得到的总时长就是进度百分比。日志写到 stderr，必须被消费或重定向，否则管道缓冲区写满后 FFmpeg 会阻塞，表现为"进程卡住不动"。

```java
public final class FfmpegRunner {

    private static final Logger log = LoggerFactory.getLogger(FfmpegRunner.class);

    public record Progress(long outTimeMicros, double speed, boolean finished) {}

    /** 运行 ffmpeg；超时先 SIGTERM 让它收尾，10 秒后仍未退出则强杀 */
    public void run(List<String> args, Duration timeout, Path logFile,
                    Consumer<Progress> onProgress) throws IOException, InterruptedException {
        List<String> cmd = new ArrayList<>(List.of(
                "ffmpeg", "-hide_banner", "-nostdin", "-y",
                "-loglevel", "error", "-nostats", "-progress", "pipe:1"));
        cmd.addAll(args);

        Process process = new ProcessBuilder(cmd)
                .redirectError(ProcessBuilder.Redirect.to(logFile.toFile()))  // stderr 落盘，避免管道写满
                .start();
        Thread reader = Thread.ofVirtual().start(() -> readProgress(process.getInputStream(), onProgress));
        try {
            if (!process.waitFor(timeout.toMillis(), TimeUnit.MILLISECONDS)) {
                process.destroy();                                   // Linux 上发送 SIGTERM
                if (!process.waitFor(10, TimeUnit.SECONDS)) {
                    process.destroyForcibly();                       // SIGKILL
                    process.waitFor();
                }
                throw new FfmpegException("ffmpeg timed out after " + timeout, logFile);
            }
            reader.join();
            if (process.exitValue() != 0) {
                throw new FfmpegException("ffmpeg exited with " + process.exitValue(), logFile);
            }
        } finally {
            if (process.isAlive()) {                                 // 线程被中断等异常路径
                process.destroyForcibly();
            }
        }
    }

    private static void readProgress(InputStream in, Consumer<Progress> onProgress) {
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(in, StandardCharsets.UTF_8))) {
            long outTimeUs = 0;
            double speed = 0;
            String line;
            while ((line = reader.readLine()) != null) {
                int eq = line.indexOf('=');
                if (eq < 0) {
                    continue;
                }
                String key = line.substring(0, eq);
                String value = line.substring(eq + 1).trim();
                switch (key) {
                    case "out_time_us" -> outTimeUs = parseLong(value, outTimeUs);   // 开头可能是 N/A
                    case "speed" -> speed = parseSpeed(value, speed);                // 形如 3.21x
                    case "progress" -> onProgress.accept(new Progress(outTimeUs, speed, "end".equals(value)));
                    default -> { }
                }
            }
        } catch (IOException e) {
            log.debug("progress stream closed", e);
        }
    }

    private static long parseLong(String v, long fallback) {
        try {
            return Long.parseLong(v);
        } catch (NumberFormatException e) {
            return fallback;
        }
    }

    private static double parseSpeed(String v, double fallback) {
        try {
            return Double.parseDouble(v.endsWith("x") ? v.substring(0, v.length() - 1) : v);
        } catch (NumberFormatException e) {
            return fallback;
        }
    }
}
```

`FfmpegException` 是自定义异常，带上日志文件路径，失败时读取日志最后几十行写入任务的错误信息。几个细节：

- **`-nostdin`** 防止 FFmpeg 等待键盘输入；**`-nostats`** 关掉 stderr 上的进度刷屏，进度只走 `-progress`
- **超时按源时长算**，例如"源时长 × 3 + 5 分钟"，比固定值更合理；`destroy()` 发 SIGTERM 时 FFmpeg 会尝试写完文件尾，`destroyForcibly()` 是兜底
- **一个 Worker 同时跑几路**：libx264 默认会用满所有核，并发几路就会互相抢 CPU。按"每台机器并发数 = 核数 / 每路线程数"控制，用 `-threads` 限制单路线程，或干脆一个容器一路、靠副本数扩展
- **探测时长**用上面的 `ffprobe -show_entries format=duration` 命令，同样通过 `ProcessBuilder` 调用，读取标准输出后 `Double.parseDouble`

档位参数由代码根据源分辨率拼出来，测试时直接断言生成的参数列表：

```java
public final class HlsProfiles {

    record Rendition(String name, int height, int videoKbps, int audioKbps) {}

    private static final List<Rendition> LADDER = List.of(
            new Rendition("1080p", 1080, 5000, 128),
            new Rendition("720p", 720, 2800, 128),
            new Rendition("480p", 480, 1400, 96));

    public static List<String> abr(Path source, int sourceHeight, Path outDir) {
        List<Rendition> rs = LADDER.stream().filter(r -> r.height() <= sourceHeight).toList();
        if (rs.isEmpty()) {
            rs = List.of(LADDER.getLast());   // 源比最低档还小时只出一档
        }
        StringBuilder graph = new StringBuilder("[0:v]split=").append(rs.size());
        for (int i = 0; i < rs.size(); i++) graph.append("[v").append(i).append(']');
        for (int i = 0; i < rs.size(); i++) {
            graph.append(";[v").append(i).append("]scale=-2:").append(rs.get(i).height())
                 .append("[v").append(i).append("out]");
        }
        List<String> a = new ArrayList<>(List.of("-i", source.toString(), "-filter_complex", graph.toString()));
        StringJoiner streamMap = new StringJoiner(" ");
        for (int i = 0; i < rs.size(); i++) {
            Rendition r = rs.get(i);
            a.addAll(List.of("-map", "[v" + i + "out]",
                    "-c:v:" + i, "libx264", "-b:v:" + i, r.videoKbps() + "k",
                    "-maxrate:v:" + i, (int) (r.videoKbps() * 1.07) + "k",
                    "-bufsize:v:" + i, (int) (r.videoKbps() * 1.5) + "k",
                    "-map", "a:0", "-c:a:" + i, "aac", "-b:a:" + i, r.audioKbps() + "k"));
            streamMap.add("v:" + i + ",a:" + i + ",name:" + r.name());
        }
        a.addAll(List.of("-preset", "medium", "-pix_fmt", "yuv420p", "-ac", "2",
                "-force_key_frames", "expr:gte(t,n_forced*2)", "-sc_threshold", "0",
                "-f", "hls", "-hls_time", "6", "-hls_playlist_type", "vod",
                "-hls_flags", "independent_segments",
                "-hls_segment_filename", outDir.resolve("%v/seg_%03d.ts").toString(),
                "-master_pl_name", "master.m3u8",
                "-var_stream_map", streamMap.toString(),
                outDir.resolve("%v/index.m3u8").toString()));
        return a;
    }
}
```

注意这里 `-filter_complex` 和 `-var_stream_map` 的值作为一个数组元素传入，不需要也不能再加引号，引号是给 shell 用的。上面示例假设源一定有音轨；没有音轨的视频要去掉 `-map a:0` 并把 `var_stream_map` 改成只含 `v:`。

### 3、JavaCV：进程内调用的替代方案

[JavaCV](https://github.com/bytedeco/javacv)（当前 1.5.14，内置 FFmpeg 8.1.2，比本篇 9.0 基线低一个版本，可用参数以它自带的版本为准）通过 JNI 封装 FFmpeg 的 C 库，提供 `FFmpegFrameGrabber`（解码）和 `FFmpegFrameRecorder`（编码），也可以通过 `org.bytedeco.ffmpeg.ffmpeg` 拿到它自带的 ffmpeg 可执行文件路径，省去在镜像里单独安装。

| 维度 | 子进程调用 ffmpeg | JavaCV 进程内调用 |
|------|------------------|-------------------|
| 隔离性 | 崩溃、内存泄漏只影响子进程 | 原生代码崩溃会带走整个 JVM |
| 能力 | 命令行能做的都能做，资料最多 | 适合逐帧处理（抽帧做 AI 识别、叠加水印） |
| 部署 | 镜像里装 ffmpeg，版本可控 | 依赖带各平台原生库，`-platform` 依赖体积很大，需按平台裁剪 |
| 超时控制 | 杀进程即可 | 只能在读帧循环里自己检查 |

结论：常规转码、切片、截图用子进程；需要在 Java 里拿到解码后的帧做处理时才用 JavaCV，并把它放在独立的服务里。

---

## 五、转码作为异步任务

![转码异步任务流水线](../assets/media/ffmpeg-transcode-job.svg)

转码动辄几分钟到几十分钟，不能放在 HTTP 请求里同步做。标准做法是：上传完成后建一条任务记录，把任务 ID 投递到消息队列，转码 Worker 消费并执行，过程中回写进度，完成后登记产物并通知业务方。

Java 后端在这里的角色是**编排者**：负责建任务、调度 Worker、调用 FFmpeg 子进程、上报进度、把产物登记到业务库，而不是自己去解码像素。点播整体链路见 [点播与短视频](./7_vod)，上传本身（分片、直传）见 [对象存储](/architecture/4_object_storage) 与 [大文件上传](/scenario/10_file_upload)。

### 1、任务表与状态机

```sql
CREATE TABLE transcode_job (
    id             BIGINT        NOT NULL PRIMARY KEY,
    video_id       BIGINT        NOT NULL,
    profile        VARCHAR(32)   NOT NULL COMMENT '转码模板，如 hls_abr_v1',
    source_key     VARCHAR(512)  NOT NULL COMMENT '源文件对象存储 key',
    status         VARCHAR(16)   NOT NULL COMMENT 'PENDING / RUNNING / SUCCEEDED / FAILED',
    progress       TINYINT       NOT NULL DEFAULT 0,
    attempts       INT           NOT NULL DEFAULT 0,
    worker_id      VARCHAR(64)   NULL,
    heartbeat_at   DATETIME(3)   NULL,
    output_prefix  VARCHAR(512)  NULL,
    error_message  VARCHAR(1024) NULL,
    created_at     DATETIME(3)   NOT NULL,
    updated_at     DATETIME(3)   NOT NULL,
    UNIQUE KEY uk_video_profile (video_id, profile)
);
```

`uk_video_profile` 保证同一视频同一模板只有一个任务，上传完成的事件重复到达时插入失败即视为已建过。任务 ID 和消息同时写入时用本地消息表（Outbox）保证"建了任务就一定发出消息"，见 [消息队列基础](/messaging/1_basics) 第八节。

### 2、Worker：抢占、执行、回写

消息队列只保证"至少投递一次"，同一任务可能被两个 Worker 同时拿到，Worker 崩溃后消息也会重投。用一条条件更新做抢占，同时兼顾"处理中的任务心跳超时可以被接管"：

```java
@Component
public class TranscodeWorker {

    private static final int MAX_ATTEMPTS = 3;

    private final JdbcClient jdbc;
    private final FfmpegRunner ffmpeg;
    private final MediaProbe probe;          // 封装 ffprobe 调用
    private final MediaStorage storage;      // 封装对象存储下载与上传
    private final String workerId;

    // 构造器注入省略

    /** 由 MQ 监听器调用；抛出异常则消息按 MQ 的重试策略重投 */
    public void handle(TranscodeCommand cmd) throws Exception {
        int claimed = jdbc.sql("""
                UPDATE transcode_job
                   SET status = 'RUNNING', worker_id = :worker, attempts = attempts + 1,
                       heartbeat_at = NOW(3), updated_at = NOW(3)
                 WHERE id = :id
                   AND attempts < :max
                   AND (status = 'PENDING'
                        OR (status = 'RUNNING' AND heartbeat_at < NOW(3) - INTERVAL 2 MINUTE))
                """)
                .param("worker", workerId).param("id", cmd.jobId()).param("max", MAX_ATTEMPTS)
                .update();
        if (claimed == 0) {
            return;   // 已完成、正在被别人处理或已超过重试次数：确认消息，不再处理
        }

        Path workDir = Files.createTempDirectory("transcode-" + cmd.jobId() + "-");
        try {
            Path source = storage.download(cmd.sourceKey(), workDir.resolve("source"));
            MediaInfo info = probe.inspect(source);            // 校验 format_name 白名单，取时长与高度
            Path outDir = workDir.resolve("out");
            ProgressReporter reporter = new ProgressReporter(jdbc, cmd.jobId(), info.duration());

            ffmpeg.run(HlsProfiles.abr(source, info.height(), outDir),
                    info.duration().multipliedBy(3).plusMinutes(5),
                    workDir.resolve("ffmpeg.log"),
                    reporter::onProgress);

            String prefix = "videos/%d/%s/".formatted(cmd.videoId(), cmd.profile());
            storage.uploadDirectory(outDir, prefix, "master.m3u8");   // 最后上传 master.m3u8
            jdbc.sql("""
                    UPDATE transcode_job
                       SET status = 'SUCCEEDED', progress = 100, output_prefix = :prefix, updated_at = NOW(3)
                     WHERE id = :id AND worker_id = :worker
                    """)
                    .param("prefix", prefix).param("id", cmd.jobId()).param("worker", workerId)
                    .update();
            // 同一事务内写 Outbox：通知业务方 video_id 转码完成
        } catch (Exception e) {
            markFailedOrPending(cmd.jobId(), e);   // 未到上限置回 PENDING，到上限置 FAILED 并告警
            throw e;
        } finally {
            FileSystemUtils.deleteRecursively(workDir);
        }
    }
}
```

设计要点：

- **产物路径确定**：输出前缀只由 `video_id + profile` 决定，重跑会覆盖同一批对象，天然幂等；`master.m3u8` 最后上传，播放器拿不到半成品
- **进度节流**：`ProgressReporter` 只在百分比前进 ≥ 5 或距上次写入超过 10 秒时更新 `progress` 与 `heartbeat_at`，避免每 0.5 秒打一次数据库；心跳同时证明 Worker 还活着
- **重试分类**：网络抖动、对象存储超时可以重试；源文件损坏、格式不在白名单、超时三次的任务重试也没用，直接 `FAILED` 并记录错误日志尾部。MQ 侧配置最大重投次数和死信队列，与 `attempts` 上限保持一致，见 [消息队列基础](/messaging/1_basics) 第七节
- **通知业务方**：完成事件通过消息发出，业务服务更新视频状态并推送给前端；前端实时看进度可以轮询任务接口，或通过 [WebSocket](/netty/10_websocket) 推送
- **按队列隔离**：付费用户、短视频、长视频分不同队列和 Worker 池，避免一个两小时的长视频把短视频全堵在后面

### 3、自建还是用云服务

各家云厂商都提供托管的媒体处理服务（转码模板、截图、水印、DRM 一站式），按转码时长计费，适合转码量不稳定或团队没有音视频经验的情况。自建 FFmpeg 集群的优势是成本可控、可以做定制滤镜和精细调参，代价是要自己维护镜像、GPU 驱动、任务调度和失败处理。常见折中是：标准档位走云服务，特殊处理（AI 抽帧、定制水印）自建 Worker，两边共用同一张任务表和状态机。

---

## 小结

- 命令结构是"选项作用于紧跟其后的文件"；转码前用 `ffprobe -show_format -show_streams` 拿到格式、时长、分辨率，并以 `format_name` 做输入白名单
- 点播用 `-crf` + `-preset`，需要控制峰值时加 `-maxrate` / `-bufsize`；直播用固定码率、固定 GOP 与 `-tune zerolatency`
- 多码率 HLS 用 `split` + 多路 `scale` + `var_stream_map`，强制关键帧并关闭场景切换保证切片对齐；截图用 `-ss` 前置 + `-frames:v 1`，雪碧图用 `fps,scale,tile`；只换容器时用 `-c copy`
- 硬件加速先确认构建、设备和画质三件事，NVENC 可以把解码、缩放、编码全放在 GPU 上
- Java 调用用 `ProcessBuilder` 参数列表，stderr 必须重定向，进度读 `-progress pipe:1` 的 `out_time_us`，超时先 `destroy()` 再 `destroyForcibly()`；JavaCV 只用于逐帧处理
- 转码是异步任务：唯一键防重复建任务，条件更新抢占 + 心跳接管防重复执行，产物路径确定、master 最后上传保证幂等，重试次数与死信队列对齐

## 参考资料

- FFmpeg 命令行文档：[ffmpeg Documentation](https://ffmpeg.org/ffmpeg.html)
- ffprobe 文档：[ffprobe Documentation](https://ffmpeg.org/ffprobe.html)
- HLS 封装器选项（`var_stream_map`、`hls_segment_type` 等）：[FFmpeg Formats - hls](https://ffmpeg.org/ffmpeg-formats.html#hls-2)
- 滤镜文档（scale、split、thumbnail、tile）：[FFmpeg Filters Documentation](https://ffmpeg.org/ffmpeg-filters.html)
- H.264 编码指南（CRF、preset）：[FFmpeg Wiki - H.264 Video Encoding Guide](https://trac.ffmpeg.org/wiki/Encode/H.264)
- 硬件加速概览：[FFmpeg Wiki - HWAccelIntro](https://trac.ffmpeg.org/wiki/HWAccelIntro)
- NVIDIA 官方指南：[Using FFmpeg with NVIDIA GPU Hardware Acceleration](https://docs.nvidia.com/video-technologies/video-codec-sdk/13.0/ffmpeg-with-nvidia-gpu/index.html)
- 许可证说明：[FFmpeg License and Legal Considerations](https://ffmpeg.org/legal.html)
- 版本发布：[FFmpeg Download](https://ffmpeg.org/download.html)
- Java 进程 API：[ProcessBuilder (Java SE 21)](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/lang/ProcessBuilder.html)
- JavaCV：[bytedeco/javacv](https://github.com/bytedeco/javacv)
- HLS 规范：[RFC 8216 - HTTP Live Streaming](https://datatracker.ietf.org/doc/html/rfc8216)

> 下一篇：[流媒体服务器](./4_media_server)
