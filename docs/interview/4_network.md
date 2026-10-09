---
description: TCP 握手挥手与 TIME_WAIT、拥塞控制、HTTP 演进与缓存、TLS 1.3、DNS、输入 URL、gRPC
---

# 网络协议面试题解答

> 题目清单见 [网络协议面试题](/protocols/99_interview)；细节见 [网络协议总览](/protocols/0_overview)。WebSocket、SSE、粘包拆包、IO 模型见 [Netty 面试题解答](/interview/6_netty)，REST、gRPC、Dubbo 选型见 [微服务面试题解答](/interview/11_microservices)。
>
> 版本基线：TCP 以 RFC 9293、HTTP 以 RFC 9110 / 9113 / 9114、TLS 以 RFC 8446（TLS 1.3）为准；Linux 行为以 5.x / 6.x 内核为准，Java 示例默认 JDK 21。

## 一、TCP 与 UDP

### Q1：TCP 三次握手的过程是什么？为什么不能是两次？

**一句话**：握手的本质是双方交换并确认各自的初始序号（ISN）。三次是最少次数：服务端的「确认你」和「发出我的序号」合在一个包里，客户端再确认一次。

- 流程：客户端 `SYN, seq=x` → 服务端 `SYN+ACK, seq=y, ack=x+1` → 客户端 `ACK, ack=y+1`，双方进入 ESTABLISHED
- 防历史连接（RFC 给的首要理由）：网络里滞留的旧 SYN 到达时，两次握手会让服务端直接建一条没人要的连接；三次握手下客户端发现不对，回 RST 就结束了
- 同步序号：两次握手只确认了客户端的 ISN，服务端的 ISN 没人确认，后续数据无法可靠排序和去重
- ISN 要随机：从 0 开始的话，旧连接的残留报文容易落进新连接的序号范围，也容易被攻击者猜中伪造

→ 详见 [TCP 与 UDP](/protocols/1_tcp_udp#_2、为什么不能是两次)

### Q2：半连接队列和全连接队列是什么？SYN Flood 怎么防？

**一句话**：半连接队列放「收到 SYN、等最后一个 ACK」的连接，全连接队列放「握手完成、等应用 `accept()`」的连接；SYN Flood 就是用伪造的 SYN 塞满半连接队列。

- 全连接队列长度是 `min(backlog, somaxconn)`；Tomcat 对应 `accept-count`，Netty 对应 `SO_BACKLOG`
- 全连接队列满时，默认丢掉第三次握手的 ACK，客户端看到的是连接超时，根因往往是应用 accept 太慢（线程阻塞、Full GC）
- 排查：`ss -lnt` 看 LISTEN 行的 `Recv-Q`（积压）和 `Send-Q`（上限），`nstat` 看 `ListenOverflows` 累计次数
- syncookies：队列满时不保存连接状态，把信息编码进 SYN+ACK 的序号，客户端回 ACK 时再还原；Linux 默认开启，只是兜底，大流量攻击要靠上游清洗

→ 详见 [TCP 与 UDP](/protocols/1_tcp_udp#_3、半连接队列与全连接队列)

### Q3：四次挥手的过程是什么？为什么握手三次、挥手要四次？

**一句话**：TCP 是全双工的，两个方向要各自关闭。被动方收到 FIN 只说明「对方不发了」，自己可能还有数据要发，所以 ACK 和自己的 FIN 通常分两次发。

- 流程：主动方发 FIN（FIN_WAIT_1）→ 被动方回 ACK（被动方进入 CLOSE_WAIT，主动方进入 FIN_WAIT_2）→ 被动方发完数据后发 FIN（LAST_ACK）→ 主动方回 ACK，进入 TIME_WAIT
- CLOSE_WAIT 的时机：被动方**收到 FIN 并回 ACK 时**进入，直到应用调用 `close()` 发出自己的 FIN 才离开
- 被动方恰好没数据要发且开了延迟确认时，ACK 和 FIN 可能合并，抓包看到「三次挥手」是正常的
- 半关闭：Java 的 `shutdownOutput()` 只关写方向，还能继续读；`close()` 两个方向都关

→ 详见 [TCP 与 UDP](/protocols/1_tcp_udp#三、四次挥手)

### Q4：TIME_WAIT 为什么要等 2MSL？

**一句话**：两个目的：保证最后一个 ACK 能送到；让这条连接的旧报文在网络里全部过期，避免被之后同四元组的新连接收到。

- 最后的 ACK 丢了，被动方会重发 FIN；主动方还在 TIME_WAIT 就能再回 ACK，已关闭的话只能回 RST，对端报错
- MSL 是报文最长存活时间，RFC 9293 取 2 分钟；Linux 不按 MSL 算，TIME_WAIT 固定 60 秒（内核常量，不能用 sysctl 改）
- TIME_WAIT 出现在**主动关闭的一方**，可以是客户端也可以是服务端

**常见坑**：以为 `tcp_fin_timeout` 能缩短 TIME_WAIT。它控制的是 FIN_WAIT_2 的停留时间。

→ 详见 [TCP 与 UDP](/protocols/1_tcp_udp#_1、time-wait-为什么要等-2msl)

### Q5：TIME_WAIT 过多有什么影响？怎么处理？

**一句话**：先看是哪一端。服务端大量 TIME_WAIT 只占点内存，不会耗尽端口；真正会出事的是客户端或网关频繁向同一上游建短连接，把临时端口用光。

| 场景 | 影响 | 处理 |
|------|------|------|
| 服务端主动关短连接 | 占内存和 conntrack 表项，所有连接共用监听端口 | 改长连接；让服务端空闲超时略长于客户端，由客户端先关 |
| 客户端 / 网关调上游 | 临时端口耗尽（默认约 2.8 万个），报 `Cannot assign requested address` | 连接池 + Keep-Alive；开 `tcp_tw_reuse`；扩大 `ip_local_port_range` |

- 统计：`ss -s` 看汇总，`ss -tan state time-wait` 按目标地址聚合（`netstat` 已不推荐）
- `tcp_tw_reuse` 只对 connect 发起方生效，依赖 TCP 时间戳；`tcp_max_tw_buckets` 是总数上限的兜底

**常见坑**：`tcp_tw_recycle` 在 NAT 下会误丢 SYN，Linux 4.12 已删除；`SO_REUSEADDR` 只让监听端口能快速重启绑定，不减少 TIME_WAIT。

→ 详见 [TCP 与 UDP](/protocols/1_tcp_udp#_2、time-wait-过多)

### Q6：CLOSE_WAIT 过多说明什么？怎么排查？

**一句话**：CLOSE_WAIT 堆积几乎都是**本方应用的 bug**：对端已经关了，内核也回了 ACK，但代码一直没调 `close()`。它不会超时消失，最后耗尽文件描述符。

- 定位：`ss -tanp state close-wait` 找到进程和对端地址，确定是连哪个服务的连接
- 看线程：`jstack` 或 Arthas `thread`，常见是线程卡在业务逻辑里，走不到关闭连接的代码
- 查代码：异常分支没关连接；读到流末尾（`read()` 返回 -1）后没关；HTTP 响应体没读完也没关，连接既不归还也不释放
- 修复：Socket、流、HTTP 响应一律 try-with-resources；连接池开空闲检测，及时清理被对端关掉的连接

→ 详见 [TCP 与 UDP](/protocols/1_tcp_udp#_3、close-wait-过多)

### Q7：TCP 如何保证可靠传输？

**一句话**：在不可靠的 IP 之上，靠「序号 + 确认 + 重传」保证不丢、不乱、不重，再用流量控制和拥塞控制保证别把对方和网络冲垮。

- 序号 + 累计确认：接收方按序号重排、去重，`ack` 告诉发送方「这之前都收到了」
- 超时重传：RTO 按 RTT 动态计算（RFC 6298），每次超时翻倍
- 快速重传：连续 3 个重复 ACK 说明中间丢包，不等超时直接补发；SACK 让发送方只补缺的那几段
- 校验和：丢弃损坏的报文，由重传兜底
- 流量控制和拥塞控制见下一题

→ 详见 [TCP 与 UDP](/protocols/1_tcp_udp#五、可靠传输与流量控制)

### Q8：流量控制和拥塞控制有什么区别？慢启动、拥塞避免、快重传、快恢复分别是什么？

**一句话**：流量控制看接收方（`rwnd`，别把对方缓冲区撑爆），拥塞控制看网络（`cwnd`，别把链路堵死）；实际发送窗口取两者较小值。

- 慢启动：`cwnd` 每个 RTT 翻倍，直到到达阈值 `ssthresh`；Linux 初始窗口是 10 个 MSS
- 拥塞避免：超过 `ssthresh` 后每个 RTT 只加 1 个 MSS，线性增长
- 快重传 + 快恢复：3 个重复 ACK 时立刻重传，`ssthresh` 和 `cwnd` 减半后继续拥塞避免；超时则更严重，`cwnd` 回到初始值重新慢启动
- 现代算法：CUBIC 以丢包为信号，是 Linux 默认；BBR 测量带宽和最小 RTT，不把丢包当拥塞，适合有随机丢包的长距离链路

**常见坑**：抓包看到大量 `TCP ZeroWindow`，问题在接收方应用读得太慢，不是网络拥塞。

→ 详见 [TCP 与 UDP](/protocols/1_tcp_udp#六、拥塞控制)

### Q9：为什么有的请求会稳定多出约 40ms 延迟？

**一句话**：通常是 Nagle 算法和延迟确认撞在了一起：发送方等 ACK 再发小包，接收方等数据再回 ACK，互相等到延迟确认的定时器超时。

- Nagle：有未确认数据时，新的小数据先攒着，等 ACK 或攒满一个 MSS 再发
- 延迟确认：收到数据不立刻回 ACK，等一小段时间看能不能和响应一起发（Linux 最少约 40 ms）
- 典型触发：请求分两次写（先写头再写体），服务端没收到完整请求不回响应，ACK 又被压着
- 处理：时延敏感的 RPC 设 `TCP_NODELAY=true`（Netty、gRPC 默认已开）；应用尽量一次写出完整消息

→ 详见 [TCP 与 UDP](/protocols/1_tcp_udp#七、nagle-算法与延迟确认)

### Q10：TCP keepalive、HTTP keep-alive 和应用层心跳有什么区别？

**一句话**：三件不同的事。TCP keepalive 是内核探活，HTTP keep-alive 是连接复用，应用层心跳才能证明对端应用真的还能干活。

| 机制 | 层次 | 作用 | 局限 |
|------|------|------|------|
| TCP keepalive | 内核 | 空闲连接上发探测包，发现对端消失 | 默认 2 小时才开始探测；只能证明对端内核活着 |
| HTTP keep-alive | HTTP | 一条 TCP 连接上顺序发多个请求 | 和探活无关 |
| 应用层心跳 | 应用协议 | 定期 ping / pong，超时就重连 | 要自己实现，如 Netty `IdleStateHandler` |

- JDK 11 起可以按连接调 keepalive 参数（`TCP_KEEPIDLE` 等扩展选项）
- NAT、负载均衡的空闲超时可能比探测间隔短，长连接要靠应用层心跳保活

→ 详见 [TCP 与 UDP](/protocols/1_tcp_udp#八、keepalive-与应用层心跳)

### Q11：TCP 和 UDP 的区别？UDP 适合哪些场景？

**一句话**：TCP 是面向连接、可靠、有拥塞控制的字节流；UDP 只在 IP 上加了端口和校验和，不握手、不重传、保留消息边界，可靠性交给应用自己。

| 维度 | TCP | UDP |
|------|-----|-----|
| 连接 | 三次握手 | 无连接 |
| 可靠性 | 确认、重传、有序 | 可能丢失、乱序、重复 |
| 数据形态 | 字节流，无消息边界 | 数据报，保留边界 |
| 头部 | 20–60 字节（无选项时 20） | 8 字节 |

- UDP 适合：DNS 查询、音视频和游戏（迟到的数据没价值）、指标上报、局域网广播发现，以及 QUIC
- 「粘包」不是 TCP 的缺陷，是应用层没定义消息边界，解法见 Netty 面试题
- 单个 UDP 报文超过 MTU 会在 IP 层分片，任何一片丢了整个报文作废，所以协议通常控制在约 1200 字节以内

→ 详见 [TCP 与 UDP](/protocols/1_tcp_udp#十、udp)

## 二、HTTP

### Q12：GET 和 POST 有什么区别？哪些 HTTP 方法是幂等的？

**一句话**：本质区别是语义：GET 是安全、幂等的读取，可以被缓存和自动重试；POST 是提交动作，既不安全也不幂等。「参数在 URL 还是 body」只是用法习惯。

- 安全：只读不改服务器状态，GET、HEAD、OPTIONS
- 幂等：执行一次和多次对服务器的影响相同，GET、HEAD、OPTIONS、PUT、DELETE；POST 不幂等，PATCH 不保证
- 幂等看的是服务器状态，不是响应：第二次 DELETE 返回 404，仍然是幂等的
- URL 长度限制来自浏览器和服务器实现，不是协议规定；GET 带 body 没有定义好的语义，代理可能丢掉

**常见坑**：网关、HTTP 客户端对 POST 开自动重试。下单这类 POST 要靠业务层的幂等键兜底。

→ 详见 [HTTP](/protocols/2_http#二、方法语义-安全与幂等)

### Q13：常见 HTTP 状态码有哪些？502 和 504 有什么区别？

**一句话**：2xx 成功、3xx 重定向、4xx 客户端错误、5xx 服务端错误。502 是网关从上游拿到了「坏响应」，504 是网关等上游「等超时了」。

- 重定向：301 / 308 永久，302 / 307 临时；307、308 保证不改请求方法，303 用于表单提交后跳到结果页
- 304：协商缓存命中，没有响应体
- 401 是没认证（没带凭证或已过期），403 是认证了但没权限；429 是被限流，配 `Retry-After`
- 502 排查：上游进程挂了、连接被重置，常见是上游 keep-alive 超时比网关短，网关拿到一条已被关闭的连接
- 504 排查：上游接口耗时，以及网关的读超时配置

→ 详见 [HTTP](/protocols/2_http#三、状态码)

### Q14：HTTP 缓存是怎么工作的？强缓存和协商缓存有什么区别？

**一句话**：强缓存在有效期内直接用本地副本，连请求都不发；过期后走协商缓存，带上校验器问服务器「变了没」，没变就回 304，省掉响应体。

- 强缓存：`Cache-Control: max-age=N`，优先级高于旧的 `Expires`；`s-maxage` 只对 CDN 等共享缓存生效
- 协商缓存：`ETag` / `If-None-Match` 精确，`Last-Modified` / `If-Modified-Since` 只到秒级；两者都带时优先比 ETag
- 常用组合：带内容哈希的静态资源 `max-age=31536000, immutable`；HTML 入口页 `no-cache` + ETag；带用户数据的接口 `private, no-store`
- Spring MVC 返回带 `eTag` 的 `ResponseEntity`，命中时框架自动回 304

**常见坑**：`no-cache` 不是「不缓存」，而是「可以存，但每次用之前都要协商」；真正不存是 `no-store`。

→ 详见 [HTTP](/protocols/2_http#四、缓存)

### Q15：Cookie、Session、Token 有什么区别？

**一句话**：HTTP 无状态，登录态要么存服务端（Session，Cookie 里只放 ID），要么存在客户端的 Token 里（如 JWT，服务端只验签）；Cookie 只是浏览器自动携带数据的载体。

| 维度 | Session | 自包含 Token（JWT） |
|------|---------|---------------------|
| 状态存在哪 | 服务端（内存或 Redis） | Token 本身 |
| 水平扩展 | 需要共享存储 | 天然无状态 |
| 主动失效 | 删掉 Session 即可 | 难，靠黑名单或短有效期 + 刷新令牌 |
| CSRF | 浏览器自动带 Cookie，要防 | 手动放 `Authorization` 头，不受影响 |

- 会话 Cookie 必开 `HttpOnly`、`Secure`，`SameSite=Lax` 兼顾体验和 CSRF 防护

→ 详见 [HTTP](/protocols/2_http#五、cookie、session-与-token)

### Q16：HTTP/1.0、1.1、2、3 分别改进了什么？

**一句话**：1.1 引入持久连接，2 在一条 TCP 连接上多路复用，3 把传输层换成基于 UDP 的 QUIC，解决 TCP 层的队头阻塞。

| 版本 | 关键改进 | 遗留问题 |
|------|----------|----------|
| HTTP/1.0 | 每个请求一条连接（非标准 keep-alive 扩展） | 建连开销大 |
| HTTP/1.1 | 默认持久连接、Host 头、分块传输 | 一条连接上请求串行，HTTP 层队头阻塞 |
| HTTP/2 | 二进制分帧、多路复用、HPACK 头部压缩 | 丢一个包所有流一起等，TCP 层队头阻塞 |
| HTTP/3 | QUIC：流独立、内置 TLS 1.3、连接迁移、QPACK | 部分网络屏蔽 UDP，要能回落到 HTTP/2 |

- 现状：HTTP/2 是浏览器和 gRPC 的主力，HTTP/1.1 在服务间调用里仍很常见，HTTP/3 多在 CDN 和边缘终结

**常见坑**：别把 Server Push 当成 HTTP/2 的卖点。Chrome 106 起默认禁用，Firefox 也已移除，替代方案是 103 Early Hints。

→ 详见 [HTTP](/protocols/2_http#九、版本对比)

### Q17：HTTP/2 的多路复用是怎么实现的？还有队头阻塞吗？

**一句话**：HTTP/2 把请求和响应切成带流 ID 的二进制帧，不同流的帧交错发送、接收端按 ID 重组，所以 HTTP 层不用再排队；但所有流共用一条 TCP，丢一个包大家一起等。

- 帧：最小单位，类型有 HEADERS、DATA、SETTINGS、WINDOW_UPDATE、RST_STREAM 等
- 流：一次请求 / 响应就是一个流，客户端发起的流 ID 为奇数，可以单独用 `RST_STREAM` 取消
- HPACK：静态表 + 连接级动态表 + Huffman 编码，重复头部只发索引
- 浏览器只支持基于 TLS 的 h2（靠 ALPN 协商）；内网可以用明文 h2c
- TCP 层队头阻塞：丢包率高的移动网络下，HTTP/2 可能还不如开多条 HTTP/1.1 连接，这是 HTTP/3 的动机

→ 详见 [HTTP](/protocols/2_http#七、http-2)

### Q18：QUIC 为什么基于 UDP？它解决了什么问题？

**一句话**：TCP 在内核里，又被大量中间设备按固定格式解析，几乎无法演进；QUIC 借 UDP 穿过网络，在用户态重新实现可靠传输、拥塞控制和加密。

- 流独立：一个流丢包只阻塞这个流，其他流照常交付；但同一个流内部仍然按序
- 握手合并：传输握手和 TLS 1.3 握手合在一起，新连接 1-RTT 就能发数据
- 连接迁移：连接由 Connection ID 标识，手机从 Wi-Fi 切到 4G、IP 变了也不用重建
- 代价：用户态协议栈加全量加密，CPU 开销通常高于 TCP + TLS；部分企业网络屏蔽 UDP 443

**常见坑**：0-RTT 数据可以被重放，只能用于幂等请求。

→ 详见 [HTTP](/protocols/2_http#八、http-3-与-quic)

## 三、HTTPS 与 TLS

### Q19：HTTPS 解决了什么问题？为什么要同时用非对称和对称加密？

**一句话**：HTTPS 解决明文 HTTP 的窃听、篡改和冒充。非对称算法能在不安全的信道上协商密钥、证明身份，但慢；对称加密快但要先有共同密钥，所以握手用前者、传数据用后者。

- 加密防窃听：握手协商出对称密钥，之后数据全部加密
- 完整性防篡改：AEAD 算法（AES-GCM、ChaCha20-Poly1305）自带认证标签，被改过的数据解密失败
- 身份防冒充：服务端出示 CA 签发的证书，并用私钥签名证明证书是自己的
- 开销主要在握手的 1 个 RTT 和一次签名运算；有 AES 指令集的 CPU 上，数据加密开销很小

→ 详见 [HTTPS 与 TLS](/protocols/3_https_tls#一、为什么需要-https)

### Q20：TLS 1.3 的握手过程是什么？和 TLS 1.2 有什么区别？

**一句话**：TLS 1.3 的客户端在第一个包里就带上 ECDHE 公钥，服务端回 ServerHello 后双方立刻算出握手密钥，证书等后续消息全部加密，1 个 RTT 完成握手。

- ClientHello：支持的版本、套件、`key_share`（ECDHE 公钥）、SNI、ALPN
- ServerHello：选定套件、回自己的 `key_share`；此后加密发送 EncryptedExtensions、Certificate、CertificateVerify、Finished
- 客户端校验证书链和签名，回 Finished，随后发应用数据

| 维度 | TLS 1.2 | TLS 1.3 |
|------|---------|---------|
| 完整握手 | 2-RTT | 1-RTT |
| 密钥交换 | 允许静态 RSA | 只允许 (EC)DHE，必有前向保密 |
| 加密方式 | 允许 CBC 等 | 只允许 AEAD |
| 证书 | 明文传输 | 加密传输 |

**常见坑**：0-RTT（会话恢复时随第一个包带数据）可以被重放，只能用于幂等请求，后端对不能重放的请求返回 `425 Too Early`。

→ 详见 [HTTPS 与 TLS](/protocols/3_https_tls#二、tls-1-3-握手)

### Q21：什么是前向保密？为什么 TLS 1.3 淘汰了 RSA 密钥交换？

**一句话**：前向保密是指证书私钥日后泄露，以前录下的流量也解不开。静态 RSA 密钥交换做不到，ECDHE 每次握手用临时密钥，所以能做到。

- RSA 密钥交换：客户端用证书公钥加密预主密钥，私钥一旦泄露，录下的历史流量全部能解
- ECDHE：双方各生成一对临时密钥，交换公钥后各自算出相同的共享秘密，私钥用完即丢
- 证书私钥只用来对握手内容签名（CertificateVerify），证明「我是证书主人」，不参与生成会话密钥
- 会话密钥由 HKDF 逐级派生，握手和应用数据、两个方向各用不同的密钥

→ 详见 [HTTPS 与 TLS](/protocols/3_https_tls#三、密钥交换与前向保密)

### Q22：证书链是怎么校验的？HTTPS 如何防止中间人攻击？

**一句话**：客户端从叶子证书开始，逐级用上一级证书的公钥验签，直到一张自己信任的根证书；中间人拿不到目标域名的合法证书，链验不通，连接就失败。

- 服务端下发叶子证书和中间证书，不需要也不应该下发根证书
- 每一张都要查：签名、有效期、用途、是否被吊销；叶子证书还要查域名是否在 SAN 里（现代客户端不再看 CN）
- 中间人能成功只有两种情况：信任库里被装了它的根证书（抓包工具、企业代理），或代码关掉了证书校验
- Java 报 `PKIX path building failed`：对端是私有 CA 或自签名，或漏配中间证书；正确做法是把 CA 导入信任库

**常见坑**：为了绕过 PKIX 报错写一个「信任所有证书」的 `TrustManager`，等于把 HTTPS 退化成只防窃听不防冒充。

→ 详见 [HTTPS 与 TLS](/protocols/3_https_tls#四、证书与证书链校验)

### Q23：SNI、ALPN、HSTS、mTLS 分别解决什么问题？

**一句话**：SNI 让一个 IP 能挂多个域名的证书，ALPN 在握手时协商出 HTTP/2，HSTS 防止被降级到 HTTP，mTLS 让客户端也出示证书。

| 机制 | 解决的问题 | 要点 |
|------|-----------|------|
| SNI | 握手时还没有 Host 头，服务端不知道该出示哪张证书 | ClientHello 里明文带域名；ECH 用来加密它 |
| ALPN | 在 TLS 握手内协商应用层协议 | 浏览器只通过 ALPN 使用 HTTP/2 |
| HSTS | 用户第一次输入 `http://` 时可能被劫持停留在 HTTP | `Strict-Transport-Security` 头，配合 preload 列表 |
| mTLS | 服务端要确认调用方是谁 | 服务端发 CertificateRequest，客户端回证书和签名 |

- mTLS 只解决「对方是谁」，不解决「能做什么」，授权仍在应用层做；服务网格里由 Sidecar 自动完成

→ 详见 [HTTPS 与 TLS](/protocols/3_https_tls#五、tls-扩展-sni、alpn-与-hsts)、[HTTPS 与 TLS](/protocols/3_https_tls#六、mtls-双向认证)

## 四、DNS 与网络综合

### Q24：DNS 解析的完整流程是什么？常见记录类型有哪些？

**一句话**：客户端先查本地各级缓存，没命中就把问题交给递归解析器；解析器从根开始迭代询问 TLD 和权威服务器，拿到答案后按 TTL 缓存再返回。

- 递归查询：客户端 → 递归解析器，客户端只问一次，要最终答案
- 迭代查询：解析器 → 根 / TLD / 权威，每一级只回答「下一步该问谁」
- 常见记录：A / AAAA（IPv4 / IPv6）、CNAME（别名）、NS（权威服务器）、MX（邮件）、TXT（SPF、域名验证）、SRV、CAA
- 传输：普通查询走 UDP 53；响应太大被截断后改用 TCP 重试，区传送也用 TCP；DoT / DoH 加密客户端到解析器这一段，DNSSEC 保证答案没被篡改

**常见坑**：裸域（`example.com` 本身）不能设 CNAME，因为那里必须有 SOA 和 NS 记录。

→ 详见 [DNS](/protocols/4_dns#二、解析过程-递归与迭代)

### Q25：改了 DNS 记录为什么不能立即生效？Java 应用切换 DNS 后为什么还连着旧 IP？

**一句话**：DNS 结果会被浏览器、JVM、操作系统、递归解析器多级缓存，生效时间取决于**旧记录的 TTL**；而 Java 应用除了 JVM 自己的 DNS 缓存，长连接根本不会重新解析。

- 正确做法：变更前先把 TTL 降到 60 秒左右，等一个旧 TTL 周期再切换，稳定后再调回
- 负缓存：「域名不存在」的结果也会被缓存，先访问再配置的新域名要等一会儿才生效
- JVM 缓存：`networkaddress.cache.ttl` 在 OpenJDK 未启用 SecurityManager 时默认 30 秒，解析失败默认缓存 10 秒，且不遵守记录的 TTL
- 长连接：数据库、Redis、HTTP 连接池里的连接一直连着旧 IP，要给连接设最大存活时间

→ 详见 [DNS](/protocols/4_dns#四、ttl-与多级缓存)、[DNS](/protocols/4_dns#八、java-中的-dns-缓存)

### Q26：CDN 的原理是什么？正向代理和反向代理有什么区别？

**一句话**：CDN 把可公开、可缓存的内容放到离用户最近的边缘节点，靠 DNS 把用户导到就近节点，源站只处理未命中和动态请求；正向代理替客户端出去，反向代理替服务端接进来。

- 调度：业务域名 CNAME 到 CDN 的调度域名，由 CDN 的 DNS 按地域、运营商返回边缘节点 IP
- 缓存：边缘节点按 `Cache-Control` 缓存，未命中或过期时回源；静态资源文件名带内容哈希，可以长期缓存
- 回源保护：大量节点同时回源会冲垮源站，要开回源合并、大促前预热
- 正向代理：客户端配置它去访问外部，服务端看到的是代理，如企业上网代理
- 反向代理：部署在服务端前面，客户端以为它就是服务器，如 Nginx、API 网关，负责负载均衡、TLS 卸载、限流

→ 详见 [接入层架构](/high-con/1_access_layer#三、cdn-与动静分离)

### Q27：从浏览器输入 URL 到页面展示，中间发生了什么？

**一句话**：解析 URL → DNS 拿到 IP → TCP 握手 → TLS 握手 → 发 HTTP 请求 → 经过 CDN、负载均衡、网关到应用 → 返回响应 → 浏览器解析渲染。每一步都有缓存和复用可以省掉。

- DNS：浏览器、操作系统、解析器逐级查缓存，可能 CNAME 到 CDN 的边缘节点
- 建连：TCP 三次握手 + TLS 1.3 握手共 2 个 RTT；复用已有连接则全部省掉，HTTP/3 把两者合并
- 请求：先查浏览器强缓存，命中就不发请求；否则带上 Cookie、协商缓存头发出
- 服务端：CDN 未命中则回源，经四层 / 七层负载均衡、网关，到应用和数据库
- 渲染：解析 HTML 构建 DOM，加载 CSS / JS，布局、绘制；HTML 里引用的资源再并发走一遍上面的流程

**常见坑**：只背流程不讲优化。能补一句「HSTS 省掉 HTTP 跳转、HTTP/2 复用连接、静态资源走 CDN 长缓存」会加分。

→ 详见 [DNS](/protocols/4_dns)、[TCP 与 UDP](/protocols/1_tcp_udp)、[HTTPS 与 TLS](/protocols/3_https_tls)、[HTTP](/protocols/2_http)、[接入层架构](/high-con/1_access_layer#一、入口分层总览)

## 五、RPC 协议

### Q28：gRPC 基于什么协议？一次调用在 HTTP/2 上长什么样？

**一句话**：gRPC = HTTP/2 + Protobuf。一次调用就是一个 HTTP/2 流：请求头里带方法路径，消息放在 DATA 帧里，最后用 Trailers 返回 `grpc-status`。

- 请求头：`POST /包名.服务名/方法名`、`content-type: application/grpc`，设了截止时间时带 `grpc-timeout`
- 消息：每条前面有 5 字节前缀（1 字节压缩标志 + 4 字节长度）
- 四种调用：一元、服务端流、客户端流、双向流，都依赖 HTTP/2 流的全双工
- 每次调用都要设截止时间；Java 默认把截止时间传给下游，整条链路共享一个总预算
- 重试：`UNAVAILABLE` 是最典型的可重试错误；`DEADLINE_EXCEEDED` 时服务端可能已执行成功，只有幂等操作才能重试

**常见坑**：HTTP 状态码恒为 200，成败只看 `grpc-status`，只看状态码的网关和监控对 gRPC 是失效的。

→ 详见 [RPC 协议](/protocols/5_rpc_protocols#三、grpc-线上格式)

### Q29：为什么 gRPC 会让四层负载均衡失效？怎么解决？

**一句话**：HTTP/2 让所有调用复用少量长连接，而四层负载均衡只在建连时选一次后端，结果流量全压在最早连上的几个实例上，扩容的新实例分不到流量。

- 典型场景：Kubernetes 默认 ClusterIP Service 就是四层转发
- 方案一，客户端负载均衡：Headless Service + `dns:///` 解析出全部实例，用 `round_robin` 策略对每个实例各建连接
- 方案二，七层代理：Envoy、Nginx `grpc_pass` 或服务网格按请求分发
- 连接保活：客户端定期发 HTTP/2 PING；服务端要配置允许的 PING 频率，否则会以 GOAWAY 断开

→ 详见 [RPC 协议](/protocols/5_rpc_protocols#_6、长连接与负载均衡)

### Q30：Protobuf 怎么改字段才能向后兼容？

**一句话**：Protobuf 在线上只认字段编号，不认名字。新增字段、删除字段是兼容的，改编号和改类型不兼容。

- 新增字段：旧代码遇到不认识的编号会跳过
- 删除字段：必须用 `reserved` 保留编号和名字，防止以后被复用成别的含义
- 改字段名：二进制兼容，但会破坏 JSON 映射和按名字反射的代码
- proto3 的标量字段分不清「0」和「没设置」，需要区分时加 `optional`

**常见坑**：金额字段用 `double`。应该用 `int64` 存分，或用字符串表示的十进制数。

→ 详见 [RPC 协议](/protocols/5_rpc_protocols#_3、兼容性规则)
