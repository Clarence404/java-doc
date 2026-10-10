---
description: SDP offer / answer、ICE 与 NAT 穿透、coturn 限时凭证、Spring WebSocket 信令、Mesh / SFU / MCU、WHIP / WHEP
---

# WebRTC 实时通信

> 前置阅读：[流媒体协议](./2_protocols)、[WebSocket](/netty/10_websocket)、[TCP 与 UDP](/protocols/1_tcp_udp)

WebRTC（Web Real-Time Communication）是浏览器和移动端内置的实时音视频能力：采集、编码、网络穿透、加密传输、抖动缓冲、回声消除都由客户端里的 WebRTC 引擎完成，端到端延迟通常在 500 ms 以内，定位是视频会议、在线课堂、直播连麦、远程问诊、云游戏这类秒级延迟都不可接受的**互动**场景。本篇聚焦 Java 后端在 WebRTC 里真正要做的事：**信令、鉴权、TURN 凭证、房间与 SFU 的编排**（SFU 以 LiveKit Server 1.13 为参照），媒体流本身不经过 Java 进程。

---

## 一、WebRTC 的组成与后端职责

WebRTC 标准只规定了"两端之间媒体怎么走"，刻意没有规定"两端怎么找到对方"。一次通话涉及四类角色：

| 角色 | 负责什么 | 由谁实现 |
|------|----------|----------|
| 客户端 WebRTC 引擎 | 采集、编解码（Opus / VP8 / VP9 / H.264 / AV1）、ICE、DTLS-SRTP 加密、拥塞控制 | 浏览器、Android / iOS SDK（libwebrtc） |
| 信令服务 | 交换 SDP 和 ICE 候选，管理房间、成员、权限 | **业务自建**，通常是 WebSocket 服务，本篇用 Spring WebSocket |
| STUN / TURN | STUN 告诉客户端自己的公网地址；TURN 在直连失败时中继媒体 | coturn 等开源实现，或云厂商托管服务 |
| 媒体服务器（可选） | 多人场景下转发或混合媒体流（SFU / MCU），录制、转推直播 | LiveKit、mediasoup、Janus、SRS 等 |

![WebRTC 建连：信令交换 SDP 与候选，STUN 探测地址，TURN 兜底中继](../assets/media/webrtc-signaling-ice.svg)

一次一对一通话的完整过程：

1. 双方客户端从业务后端拿到 ICE 服务器列表（含 TURN 限时凭证）和信令连接用的一次性 ticket
2. 双方连上信令服务，加入同一个房间
3. 主叫 `createOffer()` 生成 SDP offer，经信令转发给被叫；被叫 `createAnswer()` 生成 answer 回传
4. 双方各自收集 ICE 候选（本机地址、STUN 反射地址、TURN 中继地址），边收集边通过信令发给对方（Trickle ICE）
5. ICE 对候选对做连通性检查，选出一条可用路径；在这条路径上完成 DTLS 握手，派生 SRTP 密钥
6. 媒体以 SRTP 加密传输，优先直连，直连失败走 TURN

**Java 后端的边界**：上面第 1、2、3、4 步的"转发"是后端的事，第 5、6 步完全在客户端与 STUN / TURN / SFU 之间完成。信令服务挂了，已建立的通话不受影响，只是新呼叫和重协商（加人、切换摄像头、ICE 重启）做不了。

边界说明：RTP、RTMP、HLS 等协议本身见 [流媒体协议](./2_protocols)；SRS、ZLMediaKit 等流媒体服务器的部署见 [流媒体服务器](./4_media_server)；直播连麦在整个直播系统里的位置见 [直播系统设计](./6_live_streaming)；WebSocket 的底层实现与集群推送见 [WebSocket](/netty/10_websocket)。

---

## 二、浏览器端：采集与 PeerConnection

后端工程师不必精通前端，但要看得懂信令消息是怎么来的。浏览器端的核心只有两个 API：`navigator.mediaDevices.getUserMedia()` 采集音视频，`RTCPeerConnection` 负责协商和传输。

```javascript
// 1. 从业务后端获取 ICE 服务器（含 TURN 限时凭证）和信令 ticket
const { iceServers } = await (await fetch('/api/rtc/ice-servers', { headers: authHeader })).json();
const { ticket } = await (await fetch(`/api/rtc/rooms/${roomId}/ticket`, { method: 'POST', headers: authHeader })).json();

// 2. 采集本地音视频（需要 HTTPS 或 localhost 安全上下文）
const stream = await navigator.mediaDevices.getUserMedia({
  audio: { echoCancellation: true, noiseSuppression: true },
  video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } }
});
localVideo.srcObject = stream;

// 3. 建立 PeerConnection 并加入本地轨道
const pc = new RTCPeerConnection({ iceServers });
stream.getTracks().forEach(track => pc.addTrack(track, stream));

const ws = new WebSocket(`wss://rtc.example.com/ws/signal?ticket=${ticket}`);
const send = (type, to, data) => ws.send(JSON.stringify({ type, to, data }));

// 4. 每收集到一个候选就发给对方（Trickle ICE）
pc.onicecandidate = ({ candidate }) => {
  if (candidate) send('candidate', peerId, candidate);
};
// 5. 收到对端媒体轨道
pc.ontrack = ({ streams }) => { remoteVideo.srcObject = streams[0]; };

// 主叫：生成并发送 offer
async function call(targetId) {
  peerId = targetId;
  await pc.setLocalDescription(await pc.createOffer());
  send('offer', peerId, pc.localDescription);
}

// 6. 处理信令消息
ws.onmessage = async ({ data }) => {
  const msg = JSON.parse(data);
  switch (msg.type) {
    case 'offer':
      peerId = msg.from;
      await pc.setRemoteDescription(msg.data);
      await pc.setLocalDescription();          // 无参调用时自动生成 answer
      send('answer', peerId, pc.localDescription);
      break;
    case 'answer':
      await pc.setRemoteDescription(msg.data);
      break;
    case 'candidate':
      await pc.addIceCandidate(msg.data);
      break;
  }
};
```

几个容易踩的点：

- **必须是安全上下文**：`getUserMedia` 只在 HTTPS 或 `localhost` 下可用，信令也要用 `wss://`
- **候选可能先于 answer 到达**：`addIceCandidate` 要求已设置远端描述，严谨的实现会先把候选缓存起来，`setRemoteDescription` 之后再统一添加
- **主机候选被 mDNS 隐藏**：现代浏览器默认把本机 IP 替换成 `xxxx.local` 形式的 mDNS 名，防止网页探测内网地址；跨网络时依赖 srflx / relay 候选
- **断线检测看 `connectionState`**：`pc.onconnectionstatechange` 中出现 `disconnected` 可能自行恢复，`failed` 则要用 `pc.restartIce()` 重新协商

---

## 三、SDP 与 offer / answer 协商

SDP（Session Description Protocol，RFC 8866）是一段文本，描述"我想收发哪些媒体、支持哪些编码、用什么密钥指纹、到哪里找我"。WebRTC 用 JSEP（JavaScript Session Establishment Protocol，RFC 9429）规定的 offer / answer 模型交换 SDP：一方提出能力清单，另一方从中选出双方都支持的子集。

下面是一段裁剪过的 offer（真实 SDP 通常有几十到上百行）：

```text
v=0
o=- 4611731400430051336 2 IN IP4 127.0.0.1
s=-
t=0 0
a=group:BUNDLE 0 1
m=audio 9 UDP/TLS/RTP/SAVPF 111
c=IN IP4 0.0.0.0
a=ice-ufrag:F7gI
a=ice-pwd:x9cml/YzichV2+XlhiMu8g
a=fingerprint:sha-256 D1:2C:BE:AD:...:5F
a=setup:actpass
a=mid:0
a=sendrecv
a=rtpmap:111 opus/48000/2
m=video 9 UDP/TLS/RTP/SAVPF 96 98
a=mid:1
a=rtpmap:96 VP8/90000
a=rtpmap:98 H264/90000
a=fmtp:98 profile-level-id=42e01f;packetization-mode=1
a=candidate:1 1 udp 2122260223 192.168.1.10 54321 typ host
```

读 SDP 时抓住这几行：

| 字段 | 含义 |
|------|------|
| `m=audio` / `m=video` | 一条媒体流，后面的数字是可用的 payload type |
| `a=rtpmap` / `a=fmtp` | payload type 对应的编码与参数，answer 里只保留双方都支持的 |
| `a=ice-ufrag` / `a=ice-pwd` | ICE 连通性检查用的短期凭证，每次 ICE 重启都会变 |
| `a=fingerprint` | DTLS 证书指纹，防止中间人替换证书；信令通道被篡改就能绕过它，所以**信令必须走 TLS 并鉴权** |
| `a=group:BUNDLE` | 音视频复用同一个传输通道，减少需要打通的端口数 |
| `a=candidate` | ICE 候选；Trickle ICE 下候选一般不放在初始 SDP 里，而是单独发送 |

对信令服务来说，**SDP 是不透明的载荷**：服务端不解析、不修改，只负责转发给正确的人。需要改编码优先级之类的需求，应在客户端用 `RTCRtpTransceiver.setCodecPreferences()` 实现，而不是在服务端改 SDP 文本。

---

## 四、ICE、STUN、TURN 与 NAT 穿透

### 1、为什么需要穿透

绝大多数终端都在 NAT 之后：家庭路由器、公司出口、运营商级 NAT（CGNAT）。终端只知道自己的内网地址，对方无法直接访问；NAT 只为"内部先发出去"的流量建立映射，外部主动发来的包会被丢弃。ICE（Interactive Connectivity Establishment，RFC 8445）的思路是：**把所有可能的地址都列出来，两两尝试，选出能通的那一对**。

![NAT 穿透：STUN 拿到映射地址后双向打洞，打不通再走 TURN 中继](../assets/media/webrtc-nat-traversal.svg)

### 2、三类候选

| 候选类型 | 来源 | 何时能用 |
|----------|------|----------|
| host | 本机网卡地址 | 双方在同一局域网 |
| srflx（server reflexive） | 向 STUN 服务器发 Binding 请求，服务器回报看到的公网 IP:端口 | 双方 NAT 都是"锥型"映射，打洞成功 |
| relay | 向 TURN 服务器申请（Allocate）的中继地址 | 总能用，代价是媒体全部经过 TURN，消耗服务器带宽 |

**打洞**的过程：双方拿到对方的 srflx 地址后同时向对方发包，各自的 NAT 看到"内部已经发出过"就会放行回来的包。若某一方是**对称型 NAT**（对每个目的地址分配不同的外部端口），STUN 看到的端口和对方实际要访问的端口对不上，打洞失败，只能走 relay。

### 3、STUN 与 TURN

- **STUN**（RFC 8489）：无状态、流量极小，只回答"你在公网上看起来是哪个地址"。可以用公共 STUN，但生产环境建议自建，和 TURN 部署在一起
- **TURN**（RFC 8656）：有状态的中继，客户端用长期凭证认证后获得一个中继地址，媒体经它转发。支持 UDP、TCP 以及 TLS（`turns:`，默认 5349 端口），在只放行 443 的企业网络里，TURN over TLS 往往是唯一出路

一个经验值：P2P 场景下需要走 TURN 中继的通话比例因网络环境差异很大，企业网和移动网络占比偏高，**TURN 带宽要按峰值并发的中继比例做容量规划**，不能当成可有可无的组件。

---

## 五、coturn 部署与限时凭证

coturn 是最常用的开源 STUN / TURN 服务器，一个进程同时提供两种能力。

### 1、关键配置

```ini
# /etc/turnserver.conf
listening-port=3478
tls-listening-port=5349
# 云主机在 NAT 后时，填写 公网IP/内网IP
external-ip=203.0.113.10/10.0.1.5
realm=turn.example.com

# TURN REST API 认证：与业务后端共享同一个密钥
use-auth-secret
static-auth-secret=change-me-to-a-long-random-secret

# 中继端口范围（安全组需同时放行 UDP）
min-port=49152
max-port=65535

cert=/etc/coturn/tls/fullchain.pem
pkey=/etc/coturn/tls/privkey.pem

fingerprint
no-cli
no-multicast-peers
# 禁止客户端借 TURN 访问内网，防止被当作 SSRF 跳板
denied-peer-ip=10.0.0.0-10.255.255.255
denied-peer-ip=172.16.0.0-172.31.255.255
denied-peer-ip=192.168.0.0-192.168.255.255
denied-peer-ip=127.0.0.0-127.255.255.255
```

部署要点：

- **端口**：3478（UDP / TCP）、5349（TLS / DTLS）以及整个中继端口段都要在安全组放行，漏掉中继端口段是"STUN 正常但 relay 不通"的最常见原因
- **`denied-peer-ip` 不能省**：TURN 本质上是一个按客户端指令转发流量的代理，不加限制时可以被用来访问部署所在 VPC 的内网服务
- **带宽**：TURN 是纯流量消耗型服务，单节点容量通常先受限于网卡带宽；多节点时在 `iceServers` 里按地域返回就近节点

### 2、限时凭证的原理

如果把固定的 TURN 用户名密码写进前端代码，任何人都能拿去当免费中继。coturn 支持 TURN REST API 约定的**限时凭证**：业务后端和 coturn 共享一个密钥，后端按下面的规则现算用户名和密码，coturn 收到后用同一个密钥校验，不需要任何数据库：

- `username = 过期时间戳(Unix 秒) + ":" + 用户标识`
- `credential = Base64( HMAC-SHA1(共享密钥, username) )`

coturn 校验时先比对 HMAC，再检查时间戳是否已过期。用户名里的分隔符默认是冒号，可用 `--rest-api-separator` 修改。

### 3、Java 签发 TURN 凭证

```yaml
rtc:
  turn:
    secret: ${TURN_SECRET}        # 与 coturn 的 static-auth-secret 一致，从密钥管理系统注入
    ttl: 1h
    urls:
      - stun:turn.example.com:3478
      - turn:turn.example.com:3478?transport=udp
      - turn:turn.example.com:3478?transport=tcp
      - turns:turn.example.com:5349?transport=tcp
```

```java
@ConfigurationProperties("rtc.turn")
public record TurnProperties(String secret, Duration ttl, List<String> urls) {}

/** 前端直接作为 RTCPeerConnection 的 iceServers 元素使用 */
public record IceServer(List<String> urls, String username, String credential) {}

@Service
@EnableConfigurationProperties(TurnProperties.class)
public class TurnCredentialService {

    private final TurnProperties props;
    private final SecretKeySpec key;

    public TurnCredentialService(TurnProperties props) {
        this.props = props;
        this.key = new SecretKeySpec(props.secret().getBytes(StandardCharsets.UTF_8), "HmacSHA1");
    }

    public List<IceServer> issue(String userId) {
        long expiresAt = Instant.now().plus(props.ttl()).getEpochSecond();
        String username = expiresAt + ":" + userId;
        String credential = Base64.getEncoder().encodeToString(hmacSha1(username));
        return List.of(new IceServer(props.urls(), username, credential));
    }

    private byte[] hmacSha1(String data) {
        try {
            Mac mac = Mac.getInstance("HmacSHA1");   // Mac 非线程安全，每次新建
            mac.init(key);
            return mac.doFinal(data.getBytes(StandardCharsets.UTF_8));
        } catch (GeneralSecurityException e) {
            throw new IllegalStateException("HMAC-SHA1 不可用", e);
        }
    }
}
```

几点说明：

- **为什么是 SHA-1**：这是 coturn 校验时使用的算法，属于协议约定；这里 HMAC-SHA1 的安全性不依赖 SHA-1 的抗碰撞性，可以放心使用
- **TTL 取多长**：凭证只在分配中继（Allocate）和刷新时校验，通话中途过期不会断开已建立的分配，但 ICE 重启时需要新凭证。一般取 1 到 12 小时，客户端在重新协商前重新拉取
- **用户标识**：放业务用户 ID，coturn 日志里就能按用户追查流量；不要放手机号等敏感信息，用户名会以明文出现在 TURN 报文里
- **接口本身要鉴权**：`/api/rtc/ice-servers` 必须要求登录，并按用户限流，否则等于把中继能力公开

---

## 六、Java 信令服务

### 1、信令协议设计

信令的消息格式由业务自定，JSON 最常见。本篇的约定：

| 方向 | type | 字段 | 说明 |
|------|------|------|------|
| 服务端 → 客户端 | `joined` | `peers` | 加入成功，返回房间内已有成员 ID 列表 |
| 服务端 → 客户端 | `peer-joined` / `peer-left` | `from` | 有人加入 / 离开 |
| 客户端 → 服务端 | `offer` / `answer` / `candidate` | `to`、`data` | 发给指定成员，`data` 为 SDP 或候选 |
| 服务端 → 客户端 | `offer` / `answer` / `candidate` | `from`、`data` | 转发后的消息，`from` **由服务端填写** |

约定新加入者向已有成员逐个发起 offer，避免双方同时发 offer 造成冲突（glare）。

### 2、鉴权：一次性 ticket

浏览器的 `WebSocket` 构造函数不能自定义请求头，JWT 放不进 `Authorization`。常见做法是先用正常的 HTTP 接口（带 JWT）换一个**短期、一次性**的 ticket，再把 ticket 放在 WebSocket URL 的查询参数里。即使 URL 被记录进访问日志，ticket 也早已失效。JWT 本身的校验见 [JWT](/security/1_jwt)。

```java
public record RtcPrincipal(long userId, String roomId) {}

@Service
@RequiredArgsConstructor
public class RtcTicketService {

    private static final Duration TTL = Duration.ofSeconds(30);
    private final StringRedisTemplate redis;

    public String issue(long userId, String roomId) {
        String ticket = UUID.randomUUID().toString();   // 基于 SecureRandom
        redis.opsForValue().set("rtc:ticket:" + ticket, userId + ":" + roomId, TTL);
        return ticket;
    }

    /** 取出即删除（GETDEL），同一个 ticket 只能用一次 */
    public Optional<RtcPrincipal> consume(String ticket) {
        String value = redis.opsForValue().getAndDelete("rtc:ticket:" + ticket);
        if (value == null) {
            return Optional.empty();
        }
        int i = value.indexOf(':');
        return Optional.of(new RtcPrincipal(Long.parseLong(value.substring(0, i)), value.substring(i + 1)));
    }
}

@RestController
@RequestMapping("/api/rtc")
@RequiredArgsConstructor
public class RtcController {

    private final RtcTicketService ticketService;
    private final TurnCredentialService turnService;
    private final RoomService roomService;          // 业务服务：房间是否存在、用户是否有权进入

    @PostMapping("/rooms/{roomId}/ticket")
    public Map<String, String> ticket(@PathVariable String roomId, @AuthenticationPrincipal Jwt jwt) {
        long userId = Long.parseLong(jwt.getSubject());
        roomService.checkJoinable(roomId, userId);  // 无权限时抛出业务异常，返回 403
        return Map.of("ticket", ticketService.issue(userId, roomId));
    }

    @GetMapping("/ice-servers")
    public Map<String, List<IceServer>> iceServers(@AuthenticationPrincipal Jwt jwt) {
        return Map.of("iceServers", turnService.issue(jwt.getSubject()));
    }
}
```

握手拦截器在 HTTP Upgrade 阶段校验 ticket，失败直接拒绝握手，连接根本建立不起来：

```java
@Component
@RequiredArgsConstructor
public class TicketHandshakeInterceptor implements HandshakeInterceptor {

    static final String PRINCIPAL = "rtcPrincipal";
    private final RtcTicketService ticketService;

    @Override
    public boolean beforeHandshake(ServerHttpRequest request, ServerHttpResponse response,
                                   WebSocketHandler wsHandler, Map<String, Object> attributes) {
        String ticket = UriComponentsBuilder.fromUri(request.getURI()).build()
                .getQueryParams().getFirst("ticket");
        Optional<RtcPrincipal> principal = ticket == null ? Optional.empty() : ticketService.consume(ticket);
        if (principal.isEmpty()) {
            response.setStatusCode(HttpStatus.UNAUTHORIZED);
            return false;
        }
        attributes.put(PRINCIPAL, principal.get());   // 之后可从 WebSocketSession.getAttributes() 取出
        return true;
    }

    @Override
    public void afterHandshake(ServerHttpRequest request, ServerHttpResponse response,
                               WebSocketHandler wsHandler, Exception exception) {
    }
}
```

### 3、房间管理与消息转发

```java
public record SignalMessage(String type, Long to, JsonNode data) {}
public record RelayMessage(String type, long from, JsonNode data) {}

@Slf4j
@Component
@RequiredArgsConstructor
public class SignalingHandler extends TextWebSocketHandler {

    private static final int MAX_PEERS = 4;                       // Mesh 模式的人数上限
    private static final Set<String> RELAY_TYPES = Set.of("offer", "answer", "candidate");

    private final JsonMapper jsonMapper;                          // Spring Boot 4 默认的 Jackson 3
    /** roomId -> (userId -> session) */
    private final ConcurrentHashMap<String, Map<Long, WebSocketSession>> rooms = new ConcurrentHashMap<>();

    @Override
    public void afterConnectionEstablished(WebSocketSession raw) throws IOException {
        RtcPrincipal me = principal(raw);
        // sendMessage 不支持并发调用，用装饰器串行化发送，并限制发送耗时与缓冲
        WebSocketSession session = new ConcurrentWebSocketSessionDecorator(raw, 5_000, 64 * 1024);
        AtomicBoolean full = new AtomicBoolean();
        AtomicReference<WebSocketSession> replaced = new AtomicReference<>();

        // compute 对同一 roomId 加锁，保证"检查人数 + 加入"是原子的
        Map<Long, WebSocketSession> room = rooms.compute(me.roomId(), (id, members) -> {
            Map<Long, WebSocketSession> m = members != null ? members : new ConcurrentHashMap<>();
            if (!m.containsKey(me.userId()) && m.size() >= MAX_PEERS) {
                full.set(true);
            } else {
                replaced.set(m.put(me.userId(), session));        // 同一用户重连时顶掉旧连接
            }
            return m;
        });
        if (full.get()) {
            raw.close(new CloseStatus(4001, "room full"));
            return;
        }
        WebSocketSession old = replaced.get();
        if (old != null) {
            old.close(new CloseStatus(4002, "replaced"));
        }
        List<Long> peers = room.keySet().stream().filter(uid -> uid != me.userId()).toList();
        send(session, Map.of("type", "joined", "peers", peers));
        broadcast(room, me.userId(), Map.of("type", "peer-joined", "from", me.userId()));
    }

    @Override
    protected void handleTextMessage(WebSocketSession raw, TextMessage message) {
        RtcPrincipal me = principal(raw);
        SignalMessage msg = jsonMapper.readValue(message.getPayload(), SignalMessage.class);
        if (!RELAY_TYPES.contains(msg.type()) || msg.to() == null) {
            return;                                               // 未知类型直接丢弃
        }
        Map<Long, WebSocketSession> room = rooms.get(me.roomId());
        WebSocketSession target = room == null ? null : room.get(msg.to());
        if (target == null) {
            return;                                               // 只在本房间内查找，天然防止跨房间转发
        }
        send(target, new RelayMessage(msg.type(), me.userId(), msg.data()));
    }

    @Override
    public void afterConnectionClosed(WebSocketSession raw, CloseStatus status) {
        RtcPrincipal me = principal(raw);
        AtomicBoolean removed = new AtomicBoolean();
        Map<Long, WebSocketSession> room = rooms.computeIfPresent(me.roomId(), (id, m) -> {
            WebSocketSession current = m.get(me.userId());
            // 只移除"自己这条"连接：被顶掉的旧连接关闭时，不能把新连接也删掉
            if (current != null && current.getId().equals(raw.getId())) {
                m.remove(me.userId());
                removed.set(true);
            }
            return m.isEmpty() ? null : m;                        // 返回 null 即删除空房间
        });
        if (removed.get() && room != null) {
            broadcast(room, me.userId(), Map.of("type", "peer-left", "from", me.userId()));
        }
    }

    private void broadcast(Map<Long, WebSocketSession> room, long exclude, Object payload) {
        room.forEach((uid, s) -> {
            if (uid != exclude) {
                send(s, payload);
            }
        });
    }

    private void send(WebSocketSession session, Object payload) {
        try {
            if (session.isOpen()) {
                session.sendMessage(new TextMessage(jsonMapper.writeValueAsString(payload)));
            }
        } catch (IOException e) {
            log.warn("信令发送失败 session={}", session.getId(), e);
        }
    }

    private static RtcPrincipal principal(WebSocketSession session) {
        return (RtcPrincipal) session.getAttributes().get(TicketHandshakeInterceptor.PRINCIPAL);
    }
}
```

注册端点并调大消息缓冲：SDP 动辄几 KB，开启 simulcast 后更长，容器默认的文本消息缓冲可能不够。

```java
@Configuration
@EnableWebSocket
@RequiredArgsConstructor
public class SignalingConfig implements WebSocketConfigurer {

    private final SignalingHandler signalingHandler;
    private final TicketHandshakeInterceptor ticketInterceptor;

    @Override
    public void registerWebSocketHandlers(WebSocketHandlerRegistry registry) {
        registry.addHandler(signalingHandler, "/ws/signal")
                .addInterceptors(ticketInterceptor)
                .setAllowedOriginPatterns("https://*.example.com");   // 校验 Origin，防止跨站 WebSocket 劫持
    }

    @Bean
    public ServletServerContainerFactoryBean webSocketContainer() {
        ServletServerContainerFactoryBean factory = new ServletServerContainerFactoryBean();
        factory.setMaxTextMessageBufferSize(64 * 1024);
        factory.setMaxSessionIdleTimeout(120_000L);   // 客户端需每 30 秒左右发一次应用层心跳
        return factory;
    }
}
```

这段实现刻意保留了几条安全规则：

- **身份只来自握手**：`from` 由服务端根据握手时绑定的 `RtcPrincipal` 填写，客户端无法冒充别人发 offer
- **只在房间内转发**：目标只在发送者所在房间里查找，知道别人的用户 ID 也无法跨房间骚扰
- **解析失败即断开**：`readValue` 抛出的 Jackson 异常会被 Spring 捕获并以服务端错误关闭连接，畸形消息不会影响其他人

::: tip 集群部署
上面的 `rooms` 在单个 JVM 内存里，多实例部署时同一房间的成员可能连在不同节点上。两种做法：一是网关按 `roomId` 一致性哈希，让同一房间落在同一节点；二是节点间用 Redis Pub/Sub 或消息队列转发跨节点消息。思路与 IM 的连接路由一致，见 [WebSocket](/netty/10_websocket) 第四节与 [即时通讯](/scenario/16_im) 第二节。信令消息量很小，单节点支撑数万连接没有压力，瓶颈通常在媒体侧。
:::

---

## 七、多人通话拓扑：Mesh、SFU 与 MCU

一对一用 P2P 最省事，人一多就要考虑媒体怎么分发。

| 拓扑 | 工作方式 | 客户端上行 | 服务端负担 | 适用规模 |
|------|----------|------------|------------|----------|
| Mesh（全互联） | 每两人之间建一条 P2P 连接 | N−1 路，带宽与编码 CPU 随人数线性增长 | 只有信令和 TURN | 2 到 4 人 |
| SFU（选择性转发） | 每人只上行一路（或 simulcast 多层），服务器按需转发给其他人，不解码 | 1 路 | 转发带宽大，CPU 小 | 几十人互动、上千人观看 |
| MCU（多点混流） | 服务器解码所有流，合成一路画面后再编码下发 | 1 路 | 解码 + 合成 + 编码，CPU 极重 | 对接 SIP / 传统会议终端、合流录制、转推直播 |

当前主流是 **SFU**：服务端只转发不转码，扩展性好；配合 **simulcast**（客户端同时编码高 / 中 / 低三层分辨率）和 **SVC**（单路码流内分层，VP9 / AV1 支持），SFU 可以给网络差的接收者只转发低层，无需服务端转码。MCU 并没有消失，而是退到"合流"这个具体功能：录制一路合成画面、把连麦画面转推到 CDN 直播，见 [直播系统设计](./6_live_streaming) 第九节。

### 开源 SFU 选型

| 项目 | 语言 / 形态 | 许可证 | 特点 |
|------|-------------|--------|------|
| LiveKit | Go，基于 Pion，独立服务端 | Apache-2.0 | 开箱即用的房间模型，自带多语言服务端 SDK、录制与转推（Egress）、推流接入（Ingress，支持 WHIP / RTMP），支持多节点集群 |
| mediasoup | C++ 媒体 Worker + Node.js / Rust API，是**库**而不是成品服务 | ISC | 性能高、控制粒度细，房间、信令、集群全部自己写，适合有专门团队深度定制 |
| Janus | C，插件式网关 | GPLv3 | VideoRoom、Streaming、SIP 等插件覆盖面广，可桥接 SIP；GPL 许可对二次分发有约束，商用前需评估 |

Java 后端接入 SFU 的方式基本一致：**SFU 负责媒体，业务后端负责"谁能进哪个房间、以什么权限"**。以 LiveKit 为例，后端用服务端 SDK 或直接按其规范签发一个带房间名、身份、发布 / 订阅权限的 JWT（access token），客户端拿 token 直连 LiveKit；LiveKit 通过 webhook 把房间创建、成员进出、录制完成等事件回调给业务后端。此时第六节的自建信令就不再需要了。

选型建议：

- 一对一或三四人小会，自建信令 + coturn 足够
- 需要多人互动又不想自研媒体层，优先 LiveKit 这类成品 SFU
- 有专门的音视频团队、需要深度定制转发策略，考虑 mediasoup
- 需要对接 SIP 电话或传统会议终端，看 Janus 的 SIP 插件或 MCU 方案

---

## 八、WHIP 与 WHEP

WebRTC 刻意不规定信令，带来的问题是：每个媒体服务器、每家云厂商的信令都不一样，OBS 这类通用推流软件无法"用 WebRTC 推到任意服务器"。WHIP / WHEP 用最朴素的 HTTP 统一了这一步：

- **WHIP**（WebRTC-HTTP Ingestion Protocol，RFC 9725，2025 年发布）：用于**推流**。客户端 `POST` 一段 SDP offer（`Content-Type: application/sdp`）到 WHIP 端点，服务器返回 `201 Created`，响应体是 SDP answer，`Location` 头指向本次会话资源；结束推流时对该资源发 `DELETE`。认证一般用 `Authorization: Bearer` 令牌，后续候选可用 `PATCH`（`application/trickle-ice-sdpfrag`）补发
- **WHEP**（WebRTC-HTTP Egress Protocol）：用于**拉流播放**，流程与 WHIP 对称。截至 2026 年仍是 IETF wish 工作组的 Internet-Draft，尚未成为 RFC

```http
POST /whip/live/room1001 HTTP/1.1
Host: push.example.com
Content-Type: application/sdp
Authorization: Bearer eyJhbGciOi...

v=0
o=- 5228595038118931041 2 IN IP4 127.0.0.1
...

HTTP/1.1 201 Created
Content-Type: application/sdp
Location: /whip/live/room1001/session/6f1c2a

v=0
...
```

意义在于：主播用 OBS（30 版起内置 WHIP 输出）或浏览器即可以亚秒级延迟推流，SRS、LiveKit Ingress、MediaMTX 等都支持 WHIP 接入。对 Java 后端来说，**WHIP 端点的 Bearer token 就是推流鉴权的落点**：由业务后端签发，媒体服务器回调或自行校验，思路与 [直播系统设计](./6_live_streaming) 第三节的 RTMP 推流鉴权一致。

---

## 九、生产实践要点

**质量监控**：客户端定期调用 `pc.getStats()`，上报往返时延（RTT）、丢包率、抖动、实际发送码率与帧率、选中的候选类型（host / srflx / relay），后端汇总成指标。中继比例、首帧时间、通话失败率是最值得做成看板的三个指标，指标体系建设见 [指标监控](/observability/2_metrics)。

**弱网与带宽**：WebRTC 自带拥塞控制（GCC 等），会根据丢包和延迟自动降码率；业务侧可通过 `RTCRtpSender.setParameters()` 设置 `maxBitrate`，SFU 场景开启 simulcast，让弱网接收者只收低层。

**安全**：媒体强制 DTLS-SRTP 加密，但加密的终点是 SFU，SFU 能看到明文媒体。对端到端加密有要求的场景，需要在客户端用 Insertable Streams（编码帧变换）再加一层，代价是服务端录制和合流不可用。信令、TURN 凭证、SFU token 三处鉴权缺一不可。

**常见故障排查顺序**：

1. 信令是否到达：offer / answer 是否都转发成功，`setRemoteDescription` 是否报错
2. 候选是否齐全：浏览器 `chrome://webrtc-internals` 里看是否收集到 srflx 和 relay 候选；没有 relay 通常是 TURN 凭证错误或端口未放行
3. 连通性检查：ICE 状态停在 `checking` 后变 `failed`，多为双方都只有 host / srflx 且 NAT 打不通，确认 TURN 可用
4. 有连接无画面：检查编码协商结果（answer 里是否有共同编码）和轨道是否正确 `addTrack`

---

## 小结

- WebRTC 把采集、编码、穿透、加密都放在客户端，标准不规定信令；Java 后端负责信令转发、房间权限、TURN 凭证和 SFU token，媒体不经过 Java 进程
- SDP offer / answer 协商编码、加密指纹和 ICE 凭证，信令服务把 SDP 当不透明载荷转发，但信令通道必须 TLS + 鉴权，否则指纹校验形同虚设
- ICE 收集 host / srflx / relay 三类候选并逐对检查；对称型 NAT 打洞失败时必须靠 TURN 中继，TURN 带宽要按中继比例做容量规划
- coturn 用 `use-auth-secret` + `static-auth-secret` 校验限时凭证：`username = 过期时间:用户ID`，`credential = Base64(HMAC-SHA1(secret, username))`；务必配置 `denied-peer-ip` 防止被当作内网跳板
- Spring WebSocket 信令：HTTP 接口换一次性 ticket，握手拦截器校验并绑定身份，服务端填写 `from`、只在房间内转发，多实例按房间路由或经 Redis 转发
- 2 到 4 人用 Mesh，多人互动用 SFU（LiveKit / mediasoup / Janus），MCU 用于合流录制和转推；WHIP（RFC 9725）统一了 WebRTC 推流的信令，WHEP 仍是草案

## 参考资料

- W3C 规范：[WebRTC: Real-Time Communication in Browsers](https://www.w3.org/TR/webrtc/)、[Media Capture and Streams](https://www.w3.org/TR/mediacapture-streams/)
- MDN 教程：[WebRTC API](https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API)、[Signaling and video calling](https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API/Signaling_and_video_calling)
- JSEP：[RFC 9429 - JavaScript Session Establishment Protocol](https://www.rfc-editor.org/rfc/rfc9429)
- SDP：[RFC 8866 - SDP: Session Description Protocol](https://www.rfc-editor.org/rfc/rfc8866)
- ICE 与 Trickle ICE：[RFC 8445 - Interactive Connectivity Establishment](https://www.rfc-editor.org/rfc/rfc8445)、[RFC 8838 - Trickle ICE](https://www.rfc-editor.org/rfc/rfc8838)
- STUN 与 TURN：[RFC 8489 - STUN](https://www.rfc-editor.org/rfc/rfc8489)、[RFC 8656 - TURN](https://www.rfc-editor.org/rfc/rfc8656)
- coturn 配置与 TURN REST API：[coturn README.turnserver](https://github.com/coturn/coturn/blob/master/README.turnserver)
- WHIP：[RFC 9725 - WebRTC-HTTP Ingestion Protocol](https://www.rfc-editor.org/rfc/rfc9725)
- WHEP：[draft-ietf-wish-whep](https://datatracker.ietf.org/doc/draft-ietf-wish-whep/)
- Spring WebSocket：[Spring Framework - WebSockets](https://docs.spring.io/spring-framework/reference/web/websocket.html)
- 开源 SFU：[LiveKit 文档](https://docs.livekit.io/)、[mediasoup 文档](https://mediasoup.org/documentation/)、[Janus 文档](https://janus.conf.meetecho.com/docs/)

> 下一篇：[直播系统设计](./6_live_streaming)
