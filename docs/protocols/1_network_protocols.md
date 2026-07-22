# 网络通信协议

> 官方规范：[IETF RFC Editor](https://www.rfc-editor.org/) / [HTTP RFC 9110](https://www.rfc-editor.org/rfc/rfc9110.html) / [TCP RFC 9293](https://www.rfc-editor.org/rfc/rfc9293.html) / [WebSocket RFC 6455](https://www.rfc-editor.org/rfc/rfc6455.html)

---

## 一、TCP

### 三次握手（建立连接）

```
Client                    Server
  │── SYN (seq=x) ────────►│   ① 客户端发起，进入 SYN_SENT
  │◄── SYN+ACK (seq=y, ack=x+1) ─│   ② 服务端响应，进入 SYN_RCVD
  │── ACK (ack=y+1) ───────►│   ③ 客户端确认，双方进入 ESTABLISHED
```

**为什么是三次而不是两次？** 两次握手无法确认客户端的接收能力，也无法防止历史重复连接（过期的 SYN 报文到达服务端会被误认为新连接）。

### 四次挥手（关闭连接）

```
Client                    Server
  │── FIN ────────────────►│   ① 客户端停止发送，进入 FIN_WAIT_1
  │◄── ACK ─────────────────│   ② 服务端确认，客户端进入 FIN_WAIT_2
  │◄── FIN ─────────────────│   ③ 服务端数据发完，发 FIN，进入 CLOSE_WAIT→LAST_ACK
  │── ACK ─────────────────►│   ④ 客户端确认，进入 TIME_WAIT（等 2MSL 后关闭）
```

**TIME_WAIT 为什么等 2MSL？** 确保最后一个 ACK 能到达对端（若对端未收到会重发 FIN，需要时间处理）；同时让网络中旧连接的报文消散，避免被新连接误收。

### TCP vs UDP

| 维度 | TCP | UDP |
|------|-----|-----|
| 连接 | 面向连接（握手）| 无连接 |
| 可靠性 | 确认 + 重传 + 有序 | 不保证，可能丢包/乱序 |
| 流量控制 | 滑动窗口 | 无 |
| 延迟 | 较高 | 低 |
| 适用 | HTTP、FTP、数据库 | DNS、视频流、游戏、QUIC |

---

## 二、HTTP 各版本演进

| 特性 | HTTP/1.0 | HTTP/1.1 | HTTP/2 | HTTP/3 |
|------|---------|---------|--------|--------|
| 连接 | 每次请求新建 TCP | Keep-Alive 复用 | 多路复用（一个 TCP）| 基于 QUIC（UDP）|
| 队头阻塞 | 有 | 有（请求级）| TCP 层仍有 | 彻底消除 |
| 头部压缩 | 无 | 无 | HPACK | QPACK |
| 服务端推送 | 无 | 无 | 支持 | 支持 |
| TLS | 可选 | 可选 | 实践中必须 | 强制 |
| 传输层 | TCP | TCP | TCP | QUIC（UDP）|
| 典型应用 | 早期 Web | 当前主流 | API 服务 | 现代 CDN |

### HTTP/2 多路复用

```
HTTP/1.1：同一连接上请求串行（或开多个连接）
  Req1 → Resp1 → Req2 → Resp2

HTTP/2：同一连接上多个 Stream 并行，互不阻塞
  Stream 1: Req1 ────────→ Resp1
  Stream 3: Req2 ──→ Resp2
  Stream 5: Req3 ──────────────→ Resp3
```

### HTTP/3 与 QUIC

HTTP/3 底层用 QUIC（基于 UDP）替换 TCP，解决了 TCP 层的队头阻塞：TCP 一个包丢失会阻塞后续所有 Stream，QUIC 的 Stream 是独立的，一个包丢失只影响对应 Stream。

---

## 三、WebSocket

### 握手流程

WebSocket 通过 HTTP Upgrade 建立连接，之后脱离 HTTP：

```http
# 客户端请求升级
GET /ws HTTP/1.1
Host: example.com
Upgrade: websocket
Connection: Upgrade
Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==
Sec-WebSocket-Version: 13

# 服务端响应（101 Switching Protocols）
HTTP/1.1 101 Switching Protocols
Upgrade: websocket
Connection: Upgrade
Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=
```

握手完成后，双方通过**帧（Frame）**通信，全双工，无需轮询。

### Spring Boot WebSocket

```java
@Configuration
@EnableWebSocket
public class WebSocketConfig implements WebSocketConfigurer {
    @Override
    public void registerWebSocketHandlers(WebSocketHandlerRegistry registry) {
        registry.addHandler(new ChatHandler(), "/ws/chat")
                .setAllowedOrigins("*");
    }
}

public class ChatHandler extends TextWebSocketHandler {
    private final Set<WebSocketSession> sessions = ConcurrentHashMap.newKeySet();

    @Override
    public void afterConnectionEstablished(WebSocketSession session) {
        sessions.add(session);
    }

    @Override
    protected void handleTextMessage(WebSocketSession session, TextMessage message) throws Exception {
        // 广播给所有连接
        for (WebSocketSession s : sessions) {
            if (s.isOpen()) s.sendMessage(message);
        }
    }

    @Override
    public void afterConnectionClosed(WebSocketSession session, CloseStatus status) {
        sessions.remove(session);
    }
}
```

---

## 四、DNS 域名解析

### 解析流程

```
浏览器输入 www.example.com
    ↓
① 浏览器缓存 → ② OS hosts 文件 → ③ 本地 DNS 缓存
    ↓（未命中）
④ 递归查询本地 DNS 服务器（ISP 提供）
    ↓（未命中）
⑤ 本地 DNS → 根域名服务器（返回 .com 顶级域 NS 地址）
    ↓
⑥ 本地 DNS → .com 顶级域服务器（返回 example.com 权威 NS 地址）
    ↓
⑦ 本地 DNS → example.com 权威 DNS（返回 A 记录 IP）
    ↓
⑧ 结果缓存（TTL 控制时长），返回给浏览器
```

**递归 vs 迭代**：客户端对本地 DNS 是递归查询（把活全丢给它）；本地 DNS 对上游各级服务器是迭代查询（每次只问一步）。

### 常见 DNS 记录类型

| 类型 | 作用 | 示例 |
|------|------|------|
| A | 域名 → IPv4 地址 | `www.example.com → 1.2.3.4` |
| AAAA | 域名 → IPv6 地址 | `www.example.com → ::1` |
| CNAME | 域名 → 别名（另一个域名）| `www → example.com` |
| MX | 邮件服务器地址 | `mail.example.com` |
| TXT | 任意文本（SPF/DKIM 验证）| `v=spf1 include:...` |
| NS | 权威 DNS 服务器 | `ns1.example.com` |
