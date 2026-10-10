---
description: RTSP 与 ONVIF 发现、GB/T 28181 注册 / 目录 / 点播、ZLMediaKit 与 WVP-PRO、按需拉流、网页播放、录像、IoT 集成
---

# 监控视频接入

> 前置阅读：[流媒体协议](./2_protocols)、[流媒体服务器](./4_media_server)

监控视频和直播的区别在于**流的方向反过来了**：直播是主播主动推流，监控是平台按需去「要」流，摄像头数量多、单路观看人数少、大部分时间没人看，因此核心问题是**信令**（怎么找到设备、怎么让它推流）和**带宽**（几百路流不能一直开着）。本篇以视频平台为门店和仓库接入的几百路摄像头为场景（实时查看、回看录像、移动侦测告警进工单），讲 RTSP / ONVIF / GB/T 28181 接入、ZLMediaKit + WVP-PRO 国标平台、按需拉流、网页播放、录像与 IoT 集成，标准以 GB/T 28181-2022 为准，ZLMediaKit 使用主干版本。

---

## 一、三种接入方式

| 方式 | 原理 | 网络要求 | 适用场景 |
|------|------|----------|----------|
| RTSP 直连 | 平台作为 RTSP 客户端，主动拉摄像机的 RTSP 流 | 平台能访问到摄像机 IP（同一局域网或 VPN） | 少量摄像机、同一内网、快速验证 |
| ONVIF | 标准化的设备发现与管理接口（SOAP over HTTP），用来查询 RTSP 地址、控制云台 | 同上，发现依赖组播，只能在同一网段 | 多品牌摄像机统一管理 |
| GB/T 28181 | 设备主动向平台注册（SIP 信令），平台下发 INVITE 后设备把 RTP 流推给平台 | 设备能访问平台即可，可穿越 NAT | 跨网络、大规模、对接政务 / 公安平台的国内项目 |
| 厂商 SDK / 私有云 | 用海康、大华等厂商的 SDK 或开放平台接口 | 视厂商而定 | 需要厂商特有能力（智能分析、私有协议设备） |

选型的关键是**谁主动连谁**。RTSP 和 ONVIF 都是平台主动连设备，门店摄像机在路由器后面、没有公网 IP 时就连不上，要么在门店部署边缘网关，要么打 VPN。GB/T 28181 由设备主动连平台，设备只要能访问平台的 SIP 端口就能注册，媒体流也由设备推出来，天然适合「设备分散在各地、平台在云上」的结构。

分工照旧：媒体流由流媒体服务器收发和转封装，Java 后端负责设备注册、目录管理、点播信令、鉴权、录像索引和告警联动。RTSP、RTP 的协议细节见 [流媒体协议](./2_protocols)，ZLMediaKit 的部署与集群见 [流媒体服务器](./4_media_server)，本篇只讲监控接入特有的部分。

---

## 二、RTSP 与 ONVIF

### 1、RTSP 地址

摄像机普遍内置 RTSP 服务（默认端口 554），主码流用于录像和高清查看，子码流（分辨率低、码率几百 Kbps）用于多画面预览。主流品牌的地址约定：

```text
# 海康：通道号 1，01 为主码流，02 为子码流
rtsp://{user}:{password}@192.168.10.21:554/Streaming/Channels/101
rtsp://{user}:{password}@192.168.10.21:554/Streaming/Channels/102

# 大华：subtype=0 主码流，subtype=1 子码流
rtsp://{user}:{password}@192.168.10.22:554/cam/realmonitor?channel=1&subtype=0
```

RTSP 地址里带着账号密码，**不能写进日志、不能返回给前端**。平台侧把凭据加密存储，由后端调用流媒体服务器的拉流代理接口时拼接，前端只拿到转换后的 HTTP-FLV / WebRTC 播放地址。用 ZLMediaKit 拉一路 RTSP：

```bash
curl -G "http://zlm.internal:8080/index/api/addStreamProxy" \
  --data-urlencode "secret=${ZLM_SECRET}" \
  --data-urlencode "vhost=__defaultVhost__" \
  --data-urlencode "app=camera" \
  --data-urlencode "stream=store001_cam01" \
  --data-urlencode "url=rtsp://${CAM_USER}:${CAM_PASS}@192.168.10.21:554/Streaming/Channels/102"
```

成功时返回 `code: 0` 和 `data.key`（拉流代理的唯一标识，形如 `__defaultVhost__/camera/store001_cam01`），后续用 `delStreamProxy` 按这个 key 停止。

### 2、ONVIF 发现与取流地址

ONVIF 是 IP 摄像机行业的接口标准，按 Profile 划分能力：Profile S（基础流媒体）、Profile T（高级流媒体，支持 H.265、HTTPS 等）、Profile G（录像存储）、Profile M（元数据与智能分析）。ONVIF 已宣布 **Profile S 于 2027 年 3 月 31 日结束一致性认证支持**，原因是它依赖的 UsernameToken 认证已不符合当前安全建议，推荐新设备与新项目以 Profile T 为准；已部署的 Profile S 设备不受影响。

接入一台 ONVIF 摄像机分三步：

1. **WS-Discovery 发现**：向组播地址 `239.255.255.250:3702`（UDP）发送 `Probe` 消息，同网段的设备回复 `ProbeMatch`，其中 `XAddrs` 是设备服务地址，如 `http://192.168.10.21/onvif/device_service`
2. **查询媒体配置**：调用 Media 服务的 `GetProfiles` 拿到 Profile 列表（主码流、子码流各一个 `ProfileToken`）
3. **取流地址**：调用 `GetStreamUri`，传入 `ProfileToken`，得到 RTSP 地址

发现设备的 Java 实现（只依赖 JDK）：

```java
public List<String> discover(Duration timeout) throws IOException {
    String probe = """
        <?xml version="1.0" encoding="UTF-8"?>
        <e:Envelope xmlns:e="http://www.w3.org/2003/05/soap-envelope"
                    xmlns:w="http://schemas.xmlsoap.org/ws/2004/08/addressing"
                    xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery"
                    xmlns:dn="http://www.onvif.org/ver10/network/wsdl">
          <e:Header>
            <w:MessageID>uuid:%s</w:MessageID>
            <w:To e:mustUnderstand="true">urn:schemas-xmlsoap-org:ws:2005:04:discovery</w:To>
            <w:Action e:mustUnderstand="true">http://schemas.xmlsoap.org/ws/2005/04/discovery/Probe</w:Action>
          </e:Header>
          <e:Body>
            <d:Probe><d:Types>dn:NetworkVideoTransmitter</d:Types></d:Probe>
          </e:Body>
        </e:Envelope>
        """.formatted(UUID.randomUUID());

    byte[] data = probe.getBytes(StandardCharsets.UTF_8);
    List<String> responses = new ArrayList<>();
    try (DatagramSocket socket = new DatagramSocket()) {
        socket.setSoTimeout((int) timeout.toMillis());
        socket.send(new DatagramPacket(data, data.length,
                InetAddress.getByName("239.255.255.250"), 3702));
        byte[] buf = new byte[65535];
        while (true) {
            DatagramPacket packet = new DatagramPacket(buf, buf.length);
            try {
                socket.receive(packet);
            } catch (SocketTimeoutException e) {
                break;                           // 超时即认为收集完毕
            }
            responses.add(new String(packet.getData(), 0, packet.getLength(), StandardCharsets.UTF_8));
        }
    }
    return responses;                            // 再用 XML 解析提取 XAddrs
}
```

`GetStreamUri` 的请求体（Media 服务 ver10）：

```xml
<trt:GetStreamUri xmlns:trt="http://www.onvif.org/ver10/media/wsdl"
                  xmlns:tt="http://www.onvif.org/ver10/schema">
  <trt:StreamSetup>
    <tt:Stream>RTP-Unicast</tt:Stream>
    <tt:Transport><tt:Protocol>RTSP</tt:Protocol></tt:Transport>
  </trt:StreamSetup>
  <trt:ProfileToken>Profile_1</trt:ProfileToken>
</trt:GetStreamUri>
```

实际项目里不必手写 SOAP：设备侧很多 ONVIF 实现与规范有出入，建议用成熟的开源库或在边缘网关里处理。WS-Discovery 依赖组播，**只能发现同一网段的设备**，云上平台发现门店设备时，要在门店部署边缘节点代为发现和拉流，边缘节点的设计参见 [边缘计算](/iot/3_edge)。

---

## 三、GB/T 28181 协议要点

GB/T 28181《公共安全视频监控联网系统信息传输、交换、控制技术要求》是国内视频监控联网的国家标准，经历了 2011、2016、2022 三个版本。**现行版本是 GB/T 28181-2022**，2022 年 12 月 30 日发布、2023 年 7 月 1 日实施，代替 2016 版。2022 版的一项明显变化是对 H.265 做了明确规定（PS 流中 H.265 的 `stream_type` 为 `0x24`，RTP 载荷格式遵循 RFC 7798）；市面上大量存量设备和开源平台仍按 2016 版实现，对接前要确认双方实现的版本。

协议分两层：

| 层 | 协议 | 内容 |
|----|------|------|
| 会话信令 | SIP（RFC 3261），默认 UDP / TCP 5060 | 注册、心跳、点播的建立与拆除（INVITE / ACK / BYE） |
| 控制与查询 | SIP `MESSAGE` 携带 MANSCDP（XML） | 心跳、目录查询、设备信息、云台控制、告警通知、录像检索 |
| 回放控制 | SIP `INFO` 携带 MANSRTSP | 录像回放的暂停、拖动、倍速 |
| 媒体传输 | RTP（UDP 或 TCP），载荷为 PS 封装 | H.264 / H.265 视频与 G.711 / AAC 等音频 |

### 1、20 位编码

国标里每个设备、每个通道、每个平台都有一个 20 位十进制编码，结构为：中心编码 8 位（行政区划等）+ 行业编码 2 位 + 类型编码 3 位 + 网络标识 1 位 + 序号 6 位。类型编码区分设备种类，常见的有 `118`（NVR）、`131`（摄像机）、`132`（网络摄像机 IPC）、`200`（中心信令控制服务器，即 SIP 服务器）。例如：

```text
44010200492000000001   SIP 服务器（平台），域为前 10 位 4401020049
44010200491180000001   门店 001 的 NVR（设备）
44010200491310000001   NVR 下的第 1 路摄像机（通道）
```

平台以「设备 + 通道」两级管理：NVR 注册上来的是设备编码，它下面挂的每一路摄像机是通道编码，点播时指定的是通道编码。编码规划要在项目初期统一，避免不同门店的设备编码冲突。

### 2、交互流程

![GB/T 28181 接入时序](../assets/media/surveillance-gb28181-flow.svg)

**注册**：设备上电后向平台发送 `REGISTER`，平台回 `401` 携带 Digest 挑战，设备带上 `Authorization` 再次注册，平台校验密码后回 `200 OK`。`Expires` 是注册有效期，到期前设备要刷新注册；`Expires: 0` 表示注销。

```text
REGISTER sip:44010200492000000001@4401020049 SIP/2.0
Via: SIP/2.0/UDP 192.168.10.30:5060;rport;branch=z9hG4bK1371463273
From: <sip:44010200491180000001@4401020049>;tag=2043466181
To: <sip:44010200491180000001@4401020049>
Call-ID: 1011047669
CSeq: 2 REGISTER
Contact: <sip:44010200491180000001@192.168.10.30:5060>
Authorization: Digest username="44010200491180000001", realm="4401020049", nonce="9bd055a2c4a87c1a", uri="sip:44010200492000000001@4401020049", response="1b5d5b8c7f0e4d2a9c3e6f1a2b4c8d0e", algorithm=MD5
Max-Forwards: 70
Expires: 3600
Content-Length: 0
```

注意 `Contact` 和 `Via` 里是设备的内网地址，平台要以**实际收到报文的源 IP 和端口**（`rport` / `received`）作为后续给设备发消息的地址，否则 NAT 后的设备收不到平台的 INVITE。

**心跳**：注册成功后设备周期性发送 `MESSAGE`（MANSCDP `Keepalive`），默认间隔 60 秒，连续 3 次收不到心跳判定离线。平台用 Redis 记录最近心跳时间，离线事件推给业务系统和 IoT 平台。

**目录查询**：平台向设备发送 `Query/Catalog`，设备先回 `200 OK`，再用一条或多条 `MESSAGE` 返回通道列表。通道多时会分多包返回，平台要按 `SumNum`（总数）汇总，收齐或超时后再落库：

```xml
<?xml version="1.0" encoding="GB2312"?>
<Response>
  <CmdType>Catalog</CmdType>
  <SN>17430</SN>
  <DeviceID>44010200491180000001</DeviceID>
  <SumNum>16</SumNum>
  <DeviceList Num="1">
    <Item>
      <DeviceID>44010200491310000001</DeviceID>
      <Name>仓库 A 门口</Name>
      <Manufacturer>Hikvision</Manufacturer>
      <Parental>0</Parental>
      <ParentID>44010200491180000001</ParentID>
      <RegisterWay>1</RegisterWay>
      <Secrecy>0</Secrecy>
      <Status>ON</Status>
    </Item>
  </DeviceList>
</Response>
```

很多设备的 XML 使用 GB2312 / GBK 编码，解析时要按 XML 声明里的字符集解码，直接按 UTF-8 读会出现中文乱码。

**点播（INVITE）**：平台先向流媒体服务器申请一个 RTP 收流端口，再向设备发送 `INVITE`，SDP 里写的是**流媒体服务器的 IP 和端口**，设备回 `200 OK` 后平台发 `ACK`，设备开始把 RTP 推到流媒体服务器。平台发给设备的 SDP：

```text
v=0
o=44010200492000000001 0 0 IN IP4 10.0.1.20
s=Play
c=IN IP4 10.0.1.20
t=0 0
m=video 30012 RTP/AVP 96 98 97
a=recvonly
a=rtpmap:96 PS/90000
a=rtpmap:98 H264/90000
a=rtpmap:97 MPEG4/90000
y=0102000001
```

- `s=Play` 表示实时点播，`s=Playback` 表示录像回放（此时 `t=` 写开始和结束时间），`s=Download` 表示录像下载
- `c=` / `m=` 中的 `10.0.1.20:30012` 是 ZLMediaKit 的收流地址，不是信令服务的地址
- `y=` 是 10 位十进制 SSRC：第 1 位 `0` 表示实时、`1` 表示历史；第 2～6 位取自域编码的第 4～8 位（域 `4401020049` 取 `10200`）；后 4 位是流水号。流媒体服务器按 SSRC 区分同一端口上的多路流，平台要保证并发会话的 SSRC 不重复
- 用 TCP 传媒体时 `m=` 写 `TCP/RTP/AVP`，并加 `a=setup:passive`（平台被动等待设备连接）或 `a=setup:active`（平台主动连接设备），配合 `a=connection:new`；TCP 下的 RTP 按 RFC 4571 在每个包前加 2 字节长度

`INVITE` 请求头里还有一个国标特有的 `Subject`，格式为「媒体流发送者编码:发送端流序列号,媒体流接收者编码:接收端流序列号」，如 `Subject: 44010200491310000001:0102000001,44010200492000000001:0`。

**停止**：平台发送 `BYE`，设备停止推流，平台关闭收流端口。

---

## 四、ZLMediaKit + WVP-PRO 搭建国标平台

自己用 JAIN-SIP 从零实现 GB/T 28181 信令工作量很大（注册鉴权、多包目录、NAT、各厂商兼容性），国内开源方案的主流组合是：

| 组件 | 角色 | 技术栈 | 许可 |
|------|------|--------|------|
| ZLMediaKit | 媒体面：收 RTP / PS 流，转 RTSP / RTMP / HTTP-FLV / HLS / WebRTC，录像 | C++ | MIT（含部分第三方代码，商用前需核对） |
| WVP-PRO（wvp-GB28181-pro） | 信令面：SIP 服务、设备与通道管理、点播、级联、录像计划，自带管理前端 | Java 21、Spring Boot 3.4、JAIN-SIP，MySQL / PostgreSQL，Redis | MIT（含部分第三方代码，商用前需核对） |

WVP-PRO 开源版实现的是 GB/T 28181-2016，项目说明中标注 2022 版支持在其闭源版本中提供；需要通过 2022 版检测的项目要据此评估。两者的关系是：WVP 处理 SIP 信令，点播时调用 ZLMediaKit 的 `openRtpServer` 分配收流端口；ZLMediaKit 通过 Hook 回调告诉 WVP 流的上线、下线和无人观看事件。

### 1、部署 ZLMediaKit

```bash
docker run -id \
  -p 1935:1935 -p 8080:80 -p 8443:443 -p 8554:554 \
  -p 10000:10000 -p 10000:10000/udp \
  -p 8000:8000/udp -p 9000:9000/udp \
  -p 30000-30500:30000-30500 -p 30000-30500:30000-30500/udp \
  -v /data/zlm/conf/config.ini:/opt/media/conf/config.ini \
  zlmediakit/zlmediakit:master
```

`10000` 是 `[rtp_proxy]` 的单端口收流端口（多路国标流共用一个端口、按 SSRC 区分）；`30000-30500` 是下文 WVP 多端口模式分配给每路流的收流端口范围（每路流独占一个端口，兼容性更好），两种模式用哪种就开放哪组端口；`8000/udp` 用于 WebRTC，`9000/udp` 用于 SRT。路数多时端口映射数量大，生产环境常改用 `--network host`。`config.ini` 里与国标相关的配置：

```ini
[api]
secret=<随机生成的长字符串>

[hook]
enable=1
on_stream_none_reader=http://wvp.internal:18080/index/hook/on_stream_none_reader
on_stream_not_found=http://wvp.internal:18080/index/hook/on_stream_not_found
on_record_mp4=http://wvp.internal:18080/index/hook/on_record_mp4

[general]
mediaServerId=zlm-01
streamNoneReaderDelayMS=20000

[rtp_proxy]
port=10000
```

`18080` 是 WVP 的默认 HTTP 端口，`/index/hook/*` 是 WVP 接收 ZLMediaKit 回调的路径；WVP 连接上 ZLMediaKit 后也会通过接口自动写入 Hook 配置。`[general]` 中的 `mediaServerId` 要与 WVP 的 `media.id` 一致。`api.secret` 不能使用默认值，且 ZLMediaKit 的 HTTP API 端口不应暴露到公网。

### 2、配置 WVP-PRO

WVP 的 `application.yml` 中，`sip` 段是平台自身的国标身份，`media` 段指向 ZLMediaKit：

```yaml
sip:
  ip: 10.0.1.10              # 信令服务监听地址
  port: 5060
  domain: 4401020049         # 国标域，取平台编码前 10 位
  id: 44010200492000000001   # 平台的 20 位编码
  password: ${SIP_PASSWORD}  # 设备注册的默认密码

media:
  id: zlm-01                 # 与 ZLMediaKit 配置中的 mediaServerId 一致
  ip: 10.0.1.20
  http-port: 8080
  secret: ${ZLM_SECRET}
  sdp-ip: 10.0.1.20          # 写进 INVITE SDP 的收流地址，设备必须能访问到（跨公网时填公网地址）
  stream-ip: zlm.example.com # 返回给播放器的播放地址主机名
  rtp:
    enable: true             # 多端口模式，每路流分配独立端口
    port-range: 30000,30500

user-settings:
  auto-apply-play: true
```

设备侧（摄像机或 NVR 的「平台接入 / GB28181」配置页）填写：SIP 服务器编码 `44010200492000000001`、SIP 服务器域 `4401020049`、SIP 服务器地址与端口（公网地址或门店能访问到的地址）、设备编码、注册密码、注册有效期和心跳周期。设备注册成功后，WVP 自动发起目录查询，通道出现在管理界面里。

业务系统不直接对接 SIP，而是调用 WVP 的 REST 接口，例如 `GET /api/play/start/{deviceId}/{channelId}` 发起点播并返回各协议的播放地址（接口需要 WVP 的登录令牌）。WVP 自身的管理接口和前端只给运维使用，业务系统通过服务端代理调用，不把 WVP 直接暴露给最终用户。

---

## 五、按需拉流：没人看就不推

几百路摄像头如果 7×24 小时把主码流推到云上，单路 2～4 Mbps，上行带宽和流量费都扛不住。监控平台的标准做法是**按需拉流**：有人观看时才发起点播，最后一个观众离开后延迟一段时间自动停流。

ZLMediaKit 用两个 Hook 支撑这个模式：

| Hook | 触发时机 | 业务要做的事 |
|------|----------|--------------|
| `on_stream_not_found` | 播放器请求一条不存在的流 | 根据 `app` / `stream` 找到对应的设备通道，发起 INVITE 或 `addStreamProxy`；ZLMediaKit 会等待流上线后再响应播放器 |
| `on_stream_none_reader` | 一条流在 `streamNoneReaderDelayMS` 内没有观众 | 返回 `{"code":0,"close":true}` 让 ZLMediaKit 关闭这条流，同时向设备发 `BYE` 或删除拉流代理 |

使用 WVP 时这两个 Hook 已经实现。下面是自研信令服务时的处理骨架，重点在**并发点播去重**：同一通道同时有十个人打开画面，只能向设备发一次 INVITE。

```java
@RestController
@RequestMapping("/index/hook")
@RequiredArgsConstructor
public class ZlmHookController {

    private final ChannelRepository channelRepository;
    private final GbInviteService inviteService;        // 封装 openRtpServer + SIP INVITE
    private final StringRedisTemplate redis;

    @PostMapping("/on_stream_not_found")
    public Map<String, Object> onStreamNotFound(@RequestBody ZlmStreamEvent event) {
        channelRepository.findByStreamId(event.stream()).ifPresent(channel -> {
            // 集群部署时用 Redis SET NX 做分布式去重，60 秒内只允许一次点播
            Boolean first = redis.opsForValue()
                    .setIfAbsent("gb:inviting:" + channel.channelId(), "1", Duration.ofSeconds(60));
            if (Boolean.TRUE.equals(first)) {
                inviteService.inviteAsync(channel);      // 异步发起，不阻塞 Hook 响应
            }
        });
        return Map.of("code", 0, "msg", "success");
    }

    @PostMapping("/on_stream_none_reader")
    public Map<String, Object> onStreamNoneReader(@RequestBody ZlmStreamEvent event) {
        channelRepository.findByStreamId(event.stream()).ifPresent(channel -> {
            inviteService.bye(channel);                  // 发送 BYE，关闭 RTP 端口
            redis.delete("gb:inviting:" + channel.channelId());
        });
        return Map.of("code", 0, "close", true);
    }
}

public record ZlmStreamEvent(String mediaServerId, String app, String stream,
                             String schema, String vhost, String params) {}
```

几个细节：

- **延迟停流**：`streamNoneReaderDelayMS` 设为 20～60 秒，用户切换画面或刷新页面时不会频繁 INVITE / BYE，设备侧也不会因为频繁建流出问题
- **超时兜底**：设备不回 `200 OK` 或回了但始终没有 RTP 到达时，ZLMediaKit 会触发 `on_rtp_server_timeout`，信令服务据此清理会话和去重标记，并把通道标记为「点播失败」
- **常开的例外**：需要 7×24 小时录像的通道（收银台、仓库出入口）保持常开，其余通道按需拉流；常开通道可以优先用设备本地录像（SD 卡 / NVR 硬盘），云端只按需回看
- **主子码流**：多画面预览用子码流，单画面放大再切主码流，带宽能省一个数量级

---

## 六、网页播放：转 HTTP-FLV、HLS 与 WebRTC

浏览器不能直接播放 RTSP 和 RTP / PS，必须由流媒体服务器转封装。ZLMediaKit 收到一路流后可以同时输出多种协议，播放地址按 `app` / `stream` 拼接（国标流默认 `app` 为 `rtp`，`stream` 是信令服务调用 `openRtpServer` 时指定的流 ID，下表示例直接用通道编码）：

| 协议 | 地址示例 | 延迟 | 网页播放方式 | 适用 |
|------|----------|------|--------------|------|
| HTTP-FLV | `http://zlm.example.com/rtp/44010200491310000001.live.flv` | 1～3 秒 | mpegts.js / flv.js（基于 MSE） | 监控实时预览的主力 |
| WS-FLV | `ws://zlm.example.com/rtp/44010200491310000001.live.flv` | 1～3 秒 | 同上，经 WebSocket | 需要穿过只放行 WebSocket 的网关时 |
| HLS | `http://zlm.example.com/rtp/44010200491310000001/hls.m3u8` | 5 秒以上 | hls.js、Safari 原生 | 移动端兼容、录像回看 |
| WebRTC | `http://zlm.example.com/index/api/webrtc?app=rtp&stream=44010200491310000001&type=play` | 亚秒级 | 浏览器原生（ZLMediaKit 的信令接口，也支持 WHEP） | 云台控制、对讲等强实时场景 |

几个常见问题：

- **H.265 摄像机**：新摄像机默认 H.265 以节省存储，但浏览器对 H.265 的支持取决于浏览器版本和硬件解码能力，WebRTC 下的 H.265 支持更有限。稳妥做法是把用于网页预览的子码流设为 H.264，主码流保留 H.265 用于录像；必须网页播放 H.265 时，要么在流媒体服务器转码（每路消耗可观的 CPU），要么用基于 WebAssembly 的软解播放器
- **音频**：摄像机音频多为 G.711A / G.711U，HTTP-FLV 和 HLS 播放器通常需要 AAC，WebRTC 需要 Opus 或 G.711，要么在设备上改为 AAC，要么关闭音频，要么让流媒体服务器转码音频
- **播放鉴权**：播放地址不能裸奔。ZLMediaKit 的 `on_play` Hook 会带上播放 URL 中的查询参数（`params` 字段），后端签发带过期时间的令牌追加在播放地址后，在 `on_play` 里校验，返回非 0 的 `code` 即拒绝播放；签名方式见 [API 安全](/security/6_api_security)
- **低延迟与 iOS**：HTTP-FLV 依赖 MSE，iOS Safari 的 MSE 支持有限，移动端常用 HLS 或 WebRTC 兜底，各协议的延迟和兼容性对比见 [流媒体协议](./2_protocols)

---

## 七、录像

监控录像有两种存法，通常组合使用：

| 方式 | 位置 | 回看方式 | 优缺点 |
|------|------|----------|--------|
| 设备录像 | 摄像机 SD 卡、NVR 硬盘 | 国标录像检索（`RecordInfo` 查询）+ `INVITE`（`s=Playback`）回放 | 不占云端带宽；设备损坏或被盗时录像丢失，回看要设备在线 |
| 云端录像 | 流媒体服务器本地盘，再转存对象存储 | 按时间轴索引直接播放 MP4 / HLS | 可靠、可长期留存；需要常开推流，占带宽和存储 |

云端录像的链路：

1. 对需要录像的流开启 MP4 录制：可以在 `on_publish` Hook 的响应中返回 `enable_mp4: true` 和 `mp4_max_second`（单个文件时长，如 3600），也可以调用 `startRecord` 接口（`type=1` 为 MP4，`type=0` 为 HLS）按需开启
2. 每个 MP4 切片写完后，ZLMediaKit 回调 `on_record_mp4`，携带 `app`、`stream`、`file_path`、`file_size`、`start_time`、`time_len` 等字段
3. 后端收到回调后把文件上传到对象存储（或由同机的上传进程处理），在数据库里登记「通道 + 开始时间 + 时长 + 对象键」，然后删除本地文件
4. 回看时按通道和时间范围查出文件列表，签发预签名 URL 播放；跨文件的连续回看由后端生成一个点播 m3u8 把多段串起来

```sql
CREATE TABLE camera_record (
    id          BIGINT       PRIMARY KEY,
    channel_id  CHAR(20)     NOT NULL,
    start_time  DATETIME(3)  NOT NULL,
    duration_s  INT          NOT NULL,
    object_key  VARCHAR(512) NOT NULL,
    file_size   BIGINT       NOT NULL,
    created_at  DATETIME(3)  NOT NULL,
    KEY idx_channel_time (channel_id, start_time)
);
```

存储量估算：单路 2 Mbps 码流每天约 21.6 GB（2 Mbps × 86400 秒 ÷ 8），100 路保留 30 天就是约 65 TB。因此要按通道重要性设置保留期，用对象存储的生命周期规则自动过期删除，冷热分层的思路与 [点播与短视频](./7_vod) 第八节相同；只在告警前后保留高清片段、其余时段只录子码流，也是常用的折中。

---

## 八、与 IoT 设备平台集成

摄像头本质上也是一种 IoT 设备：有在线状态、有属性（码流配置、存储状态）、会上报事件（移动侦测、遮挡、越界告警）。把它纳入统一的设备平台，运营后台就能在一处管理门店里的摄像头、温湿度传感器和门禁。

| 视频接入层的数据 | 映射到 IoT 平台 | 用途 |
|------------------|------------------|------|
| 设备注册 / 心跳超时 | 设备上线 / 离线事件 | 统一的在线率统计与离线告警 |
| 目录（通道列表） | 子设备 / 网关拓扑 | NVR 作为网关，摄像机作为子设备 |
| 国标告警通知（`Alarm` 类 MANSCDP 消息） | 设备事件 | 进入规则引擎，联动工单、短信、声光报警 |
| 设备信息（厂商、型号、固件版本） | 设备属性 / 影子 | 资产台账、固件升级规划 |

集成方式：信令服务把设备状态变化和告警转换成平台统一的事件格式，发到消息队列，由 IoT 平台的规则引擎消费；反方向，IoT 平台的联动动作（如「门禁异常时调取门口摄像头画面并录 30 秒」）调用视频接入层的点播和录像接口。设备模型与规则引擎见 [平台选型](/iot/2_platform)、[规则引擎](/iot/11_rule_engine)，状态同步见 [设备影子](/iot/8_device_shadow)，非 SIP 私有协议设备的长连接接入可以参考 [Netty 接入网关](/iot/9_netty_gateway)。

告警联动的一个典型流程：摄像机上报移动侦测告警 → 信令服务转成设备事件投递到消息队列 → 规则引擎判断是否在布防时段 → 触发点播并对该通道开启 60 秒录像 → 录像文件回调入库后生成带截图和视频片段的工单，推送给店长。告警推送到运营后台页面时可以用 [WebSocket](/netty/10_websocket) 长连接。

---

## 九、工程实践

- **网络规划**：SIP 信令端口（UDP / TCP 5060）和 RTP 端口范围要在安全组和防火墙中放行；设备在 NAT 后时优先让设备用 TCP 主动推流（平台 `setup:passive`），比 UDP 更容易穿透且不怕丢包；跨公网的 UDP 媒体流丢包会直接表现为花屏
- **信令与媒体分离部署**：WVP（信令）是普通 Java 服务，可以多实例；ZLMediaKit（媒体）按带宽和路数扩容，一个信令服务可以管理多台媒体服务器，按负载为每次点播挑选节点
- **安全**：每台设备使用独立注册密码，或至少按门店区分；平台对注册来源 IP 和设备编码白名单校验；ZLMediaKit 的 API 端口和 Hook 地址只在内网可达；对接公安等有安全要求的平台时，还需要满足 GB 35114《公共安全视频监控联网信息安全技术要求》的设备认证与信令、媒体加密
- **可观测性**：监控在线设备数、点播成功率、点播首帧耗时、每台媒体服务器的路数和带宽、RTP 丢包率，点播成功率下降往往是某个门店网络或某个厂商固件的问题，指标设计参见 [指标监控](/observability/2_metrics)
- **厂商兼容性**：不同厂商甚至同厂商不同固件对国标的实现都有差异（目录分包、字符集、SDP 字段、TCP 模式），上线前用目标型号逐一联调，把兼容性问题记录成设备型号维度的配置项

---

## 小结

- 接入方式按「谁主动连谁」选：同网段少量设备用 RTSP 直连 / ONVIF，设备分散在各地、平台在云上用 GB/T 28181；ONVIF Profile S 将于 2027 年 3 月 31 日结束认证支持，新项目以 Profile T 为准
- GB/T 28181 现行版本为 2022 版（2023 年 7 月 1 日实施），信令走 SIP + MANSCDP XML，媒体走 RTP / PS；流程是 REGISTER（Digest 鉴权）→ Keepalive → Catalog → INVITE（SDP 指向流媒体服务器，`y=` 为 SSRC）→ ACK → RTP → BYE
- 开源组合 ZLMediaKit（媒体面）+ WVP-PRO（信令面，Java）可以快速搭起国标平台；WVP 开源版实现 2016 版，2022 版支持在闭源版本中
- 按需拉流靠 `on_stream_not_found` 发起点播、`on_stream_none_reader` 返回 `close: true` 并发 BYE，同一通道的并发点播必须去重
- 网页播放把流转成 HTTP-FLV（主力）、HLS（兼容）、WebRTC（强实时），H.265 与 G.711 是兼容性的主要障碍，播放地址用 `on_play` 校验令牌
- 录像分设备录像和云端录像，云端录像靠 `on_record_mp4` 回调入库转存对象存储；设备状态与告警经消息队列接入 IoT 平台的规则引擎，实现告警联动

## 参考资料

- GB/T 28181-2022 标准信息：[国家标准全文公开系统](https://openstd.samr.gov.cn/bzgk/gb/)（检索「GB/T 28181-2022」）
- SIP 协议：[RFC 3261 - SIP: Session Initiation Protocol](https://www.rfc-editor.org/rfc/rfc3261)
- SDP 协议：[RFC 8866 - SDP: Session Description Protocol](https://www.rfc-editor.org/rfc/rfc8866)
- TCP 上的 RTP 分帧：[RFC 4571 - Framing RTP and RTCP Packets over Connection-Oriented Transport](https://www.rfc-editor.org/rfc/rfc4571)
- H.265 的 RTP 载荷格式：[RFC 7798 - RTP Payload Format for HEVC](https://www.rfc-editor.org/rfc/rfc7798)
- ONVIF 规范与 Profile：[ONVIF Specifications](https://www.onvif.org/profiles/specifications/)、[ONVIF Profiles](https://www.onvif.org/profiles/)
- ONVIF Profile S 退役说明：[Profile S Deprecation Q&A](https://www.onvif.org/?p=8591)
- ZLMediaKit 项目：[ZLMediaKit GitHub](https://github.com/ZLMediaKit/ZLMediaKit)
- ZLMediaKit HTTP API：[MediaServer 支持的 HTTP API](https://github.com/ZLMediaKit/ZLMediaKit/wiki/MediaServer%E6%94%AF%E6%8C%81%E7%9A%84HTTP-API)
- ZLMediaKit Hook：[MediaServer 支持的 HTTP HOOK API](https://github.com/ZLMediaKit/ZLMediaKit/wiki/MediaServer%E6%94%AF%E6%8C%81%E7%9A%84HTTP-HOOK-API)
- ZLMediaKit 播放地址规则：[播放 url 规则](https://github.com/ZLMediaKit/ZLMediaKit/wiki/%E6%92%AD%E6%94%BEurl%E8%A7%84%E5%88%99)
- WVP-PRO 项目：[wvp-GB28181-pro GitHub](https://github.com/648540858/wvp-GB28181-pro)
- 网页 FLV 播放器：[mpegts.js](https://github.com/xqq/mpegts.js)
