---
description: 三次握手、四次挥手、TIME_WAIT / CLOSE_WAIT、滑动窗口、拥塞控制、keepalive、UDP
---

# TCP 与 UDP

> 前置阅读：[IO 模型](/netty/1_io_model)

TCP 是绝大多数后端通信（HTTP/1.1、HTTP/2、MySQL、Redis、Kafka、gRPC）的底座，本篇以 RFC 9293 为基线、Linux 行为以 5.x / 6.x 内核为准。内容包括建连断连与状态变化、TIME_WAIT / CLOSE_WAIT 与队列溢出排查、流量控制与拥塞控制，以及何时使用 UDP。

---

## 一、TCP 报文头

TCP 头部固定 20 字节，加上选项最长 60 字节。日常排查只需记住下面这些字段：

| 字段 | 长度 | 作用 |
|------|------|------|
| 源端口 / 目的端口 | 各 16 位 | 与 IP 头里的源、目的地址组成四元组，唯一标识一条连接 |
| 序号 seq | 32 位 | 本报文第一个字节在字节流中的编号；建连时随机生成初始序号 ISN |
| 确认号 ack | 32 位 | 期望收到的下一个字节编号，表示「这之前的我都收到了」 |
| 数据偏移 | 4 位 | 头部长度（单位 4 字节），所以头部最长 15 × 4 = 60 字节 |
| 标志位 | 若干位 | `SYN` 建连、`ACK` 确认号有效、`FIN` 我写完了、`RST` 强制重置、`PSH` 尽快交给应用 |
| 窗口 | 16 位 | 接收方还能收多少字节，用于流量控制；配合窗口缩放选项可表示到 1 GiB |
| 校验和 | 16 位 | 覆盖头部和数据，检测传输错误 |
| 选项 | 0–40 字节 | MSS（最大报文段长度）、窗口缩放、SACK（选择性确认）、时间戳 |

**常见坑**：TCP 是字节流，没有「消息」的概念，`seq` 编号的是字节而不是报文。应用层要自己划分消息边界，见第九节。

---

## 二、三次握手

### 1、流程与状态

![TCP 三次握手与四次挥手的报文和状态变化](../assets/protocols/tcp-handshake-teardown.svg)

| 步骤 | 报文 | 客户端状态 | 服务端状态 |
|------|------|------------|------------|
| 0 | 服务端 `listen()` | CLOSED | LISTEN |
| 1 | 客户端发 `SYN, seq=x` | SYN_SENT | LISTEN |
| 2 | 服务端回 `SYN+ACK, seq=y, ack=x+1` | SYN_SENT | SYN_RCVD |
| 3 | 客户端发 `ACK, ack=y+1` | ESTABLISHED | 收到后进入 ESTABLISHED |

握手的本质是**双方交换并确认各自的初始序号**：客户端的 `x` 要被服务端确认（第 2 步的 `ack=x+1`），服务端的 `y` 要被客户端确认（第 3 步的 `ack=y+1`）。服务端的「确认 x」和「发出 y」合并在一个报文里，所以是三次而不是四次。

### 2、为什么不能是两次

- **防止历史连接**：RFC 9293 给出的首要原因。客户端早先发出、在网络里滞留的旧 SYN 到达服务端时，两次握手会让服务端直接建立一条没人要的连接；三次握手下，客户端收到对旧 SYN 的 SYN+ACK，发现确认号对不上，回 `RST` 把它掐掉
- **同步双方序号**：两次握手只能确认客户端的 ISN，服务端的 ISN 没人确认，后续服务端发的数据无法可靠排序和去重
- **确认双向可达**：第 3 步让服务端知道「客户端能收到我的包」

ISN 为什么要随机：如果每次都从 0 开始，旧连接残留的报文很容易落在新连接的序号范围内被误收；随机 ISN 还能防止攻击者猜中序号伪造报文。

### 3、半连接队列与全连接队列

Linux 为每个监听 Socket 维护两个队列：

| 队列 | 存放什么 | 长度上限 | 溢出表现 |
|------|----------|----------|----------|
| 半连接队列（SYN 队列） | 收到 SYN、已回 SYN+ACK、等最后一个 ACK 的连接（SYN_RCVD） | 与 `net.ipv4.tcp_max_syn_backlog`、backlog 有关 | 新 SYN 被丢弃，或在开启 syncookies 时改用 cookie |
| 全连接队列（accept 队列） | 握手完成、等应用 `accept()` 取走的连接 | `min(backlog, net.core.somaxconn)` | 默认丢弃第三次握手的 ACK，客户端看到的是连接超时或重传 |

- `backlog` 就是 `listen()` 的参数：Java `ServerSocket` 默认 50，Tomcat 对应 `server.tomcat.accept-count`（默认 100），Netty 对应 `ChannelOption.SO_BACKLOG`（见 [生产实践与调优](/netty/12_production)）
- 全连接队列满通常说明**应用 accept 太慢**（acceptor 线程被阻塞、Full GC），而不是网络问题
- 排查命令：`ss -lnt` 中 LISTEN 行的 `Recv-Q` 是当前积压数、`Send-Q` 是队列上限；`nstat -az TcpExtListenOverflows TcpExtListenDrops` 看累计溢出次数

### 4、SYN Flood 与 syncookies

SYN Flood 攻击用大量伪造源地址的 SYN 塞满半连接队列，正常用户的 SYN 就进不来了（RFC 4987）。

- **syncookies**：队列满时，服务端不再为连接保存状态，而是把连接信息编码进 SYN+ACK 的序号里；客户端回 ACK 时再从确认号还原。Linux 默认 `net.ipv4.tcp_syncookies=1`，只在队列溢出时启用
- 代价：cookie 能编码的信息有限，部分 TCP 选项会丢失，所以它是兜底手段，不是扩容手段
- 其他缓解：调大 `tcp_max_syn_backlog`、减少 `tcp_synack_retries`（SYN+ACK 重传次数），大流量攻击要靠上游清洗

---

## 三、四次挥手

### 1、流程与状态

以客户端主动关闭为例（上图下半部分）。主动关闭的一方可以是任何一端，谁先调 `close()` 谁走左边这条路径：

| 步骤 | 报文 | 主动关闭方 | 被动关闭方 |
|------|------|------------|------------|
| 1 | 主动方发 `FIN` | FIN_WAIT_1 | ESTABLISHED |
| 2 | 被动方回 `ACK` | 收到后进入 FIN_WAIT_2 | **收到 FIN 并回 ACK 时进入 CLOSE_WAIT** |
| 3 | 被动方数据发完，调 `close()` 发 `FIN` | FIN_WAIT_2 | CLOSE_WAIT → LAST_ACK |
| 4 | 主动方回 `ACK` | TIME_WAIT，等 2MSL 后 CLOSED | 收到后 CLOSED |

### 2、为什么是四次

TCP 是全双工的，两个方向要**各自关闭**。被动方收到 FIN 只代表「对方不再发了」，自己可能还有数据没发完，所以第 2 步的 ACK 和第 3 步的 FIN 通常不能合并。

如果被动方收到 FIN 时恰好也没有数据要发，且开启了延迟确认，ACK 和 FIN 可能合并成一个报文，抓包会看到「三次挥手」，这是正常的。

### 3、半关闭

发出 FIN 之后，本方向不能再写，但仍可以读，这就是半关闭（half-close）。Java 用 `shutdownOutput()` 实现：

```java
import java.io.IOException;
import java.net.Socket;
import java.nio.charset.StandardCharsets;

public class HalfCloseDemo {
    public static void main(String[] args) throws IOException {
        try (Socket socket = new Socket("example.com", 80)) {
            var request = "GET / HTTP/1.0\r\nHost: example.com\r\n\r\n";
            socket.getOutputStream().write(request.getBytes(StandardCharsets.US_ASCII));
            socket.shutdownOutput();                       // 发 FIN：我写完了，但还能读
            byte[] response = socket.getInputStream().readAllBytes(); // 读到对端 FIN（返回 -1）为止
            System.out.println(response.length + " bytes");
        }                                                  // close()：两个方向都关闭
    }
}
```

`close()` 与 `shutdownOutput()` 的区别：`close()` 释放整个 Socket，之后再收到对端的数据，内核会回 `RST`；`shutdownOutput()` 只关写方向，适合「发完请求、等对方回完再关」的协议。

---

## 四、TIME_WAIT 与 CLOSE_WAIT

### 1、TIME_WAIT 为什么要等 2MSL

MSL（Maximum Segment Lifetime）是报文在网络中的最长存活时间，RFC 9293 取 2 分钟；Linux 不按 MSL 计算，TIME_WAIT 固定为 60 秒（内核常量 `TCP_TIMEWAIT_LEN`，不能通过 sysctl 修改）。等待的理由有两个：

- **保证最后一个 ACK 送达**：如果第 4 步的 ACK 丢了，被动方会重发 FIN。主动方还在 TIME_WAIT，就能再回一次 ACK；如果已经关闭，只能回 `RST`，被动方会报错
- **让旧连接的报文消失**：等足 2MSL，这条连接在网络里滞留的所有报文都已过期，之后用同一个四元组建立的新连接不会收到上一条连接的旧数据

`net.ipv4.tcp_fin_timeout`（默认 60 秒）控制的是孤儿连接在 **FIN_WAIT_2** 停留多久，不是 TIME_WAIT 时长，这是常见误解。

### 2、TIME_WAIT 过多

TIME_WAIT 出现在**主动关闭的一方**。先确认是哪一端、什么方向的连接：

```bash
ss -s                                      # 各状态汇总
ss -tan state time-wait | wc -l            # TIME_WAIT 数量
ss -tan state time-wait | awk '{print $4}' | sort | uniq -c | sort -rn | head   # 按目标地址聚合
```

| 场景 | 影响 | 根因 |
|------|------|------|
| 服务端主动关闭大量短连接 | 占用少量内存和 conntrack 表项，**不会耗尽端口**（所有连接共用一个监听端口） | HTTP/1.0、`Connection: close`、服务端空闲超时比客户端短 |
| 客户端 / 网关频繁向同一上游建短连接 | **临时端口耗尽**：对同一目标 IP + 端口，可用本地端口只有 `ip_local_port_range`（默认 32768–60999，约 2.8 万个），报 `Cannot assign requested address` | HTTP 客户端没开连接池、每次请求新建连接 |

处理顺序：

1. **复用连接（根本解法）**：HTTP 客户端用连接池和 Keep-Alive，数据库、Redis 用连接池（见 [数据库连接池](/database/5_practice/3_connection_pool)），RPC 用长连接
2. **让客户端先关**：服务端的空闲超时略长于客户端，TIME_WAIT 就留在分散的客户端上
3. **`net.ipv4.tcp_tw_reuse`**：只对**主动发起的连接（connect 一方）**生效，允许复用处于 TIME_WAIT 超过 1 秒的四元组，依赖 TCP 时间戳（`tcp_timestamps`）防止旧报文混入；取值 0 关闭、1 全局开启、2 仅回环地址（当前内核默认 2）。它对服务端被动连接产生的 TIME_WAIT 无效
4. **`net.ipv4.tcp_max_tw_buckets`**：TIME_WAIT 总数上限，超过后新的 TIME_WAIT 直接销毁并打印告警，是兜底保护
5. **扩大端口范围**：调宽 `ip_local_port_range`，或让客户端连接多个上游 IP

**不要用的手段**：

- `tcp_tw_recycle`：在 NAT 后面的多台客户端时间戳不一致，会被误丢 SYN，导致间歇性连不上，Linux 4.12 已删除该参数
- `SO_REUSEADDR`：它只允许服务重启时绑定仍有 TIME_WAIT 连接的监听端口（快速重启），不会减少 TIME_WAIT 数量
- `SO_LINGER` 设为 0：`close()` 直接发 `RST` 跳过 TIME_WAIT，未发完的数据会丢失，对端看到 `Connection reset`

### 3、CLOSE_WAIT 过多

CLOSE_WAIT 出现在**被动关闭的一方**：内核已收到对端 FIN 并回了 ACK，但应用一直没调 `close()`。它不会自己超时消失，只会越积越多，最终耗尽文件描述符（`Too many open files`）。所以 CLOSE_WAIT 堆积几乎都是**应用代码的问题**。

排查步骤：

1. 找到进程与对端：`ss -tanp state close-wait`，看是哪个进程、连向哪个服务
2. 看线程在干什么：`jstack <pid>` 或 [Arthas](/engineering/4_diagnosis) 的 `thread` 命令，常见是线程卡在业务逻辑里，没走到关闭连接的代码
3. 查代码：异常路径没有关闭连接、读到流末尾（`read()` 返回 -1）后没关、连接池归还逻辑有 bug、HTTP 响应体没读完也没关闭导致连接既不归还也不释放

修复原则：所有 Socket、流、HTTP 响应都用 try-with-resources；连接池配置空闲检测，及时清理被对端关闭的连接。

---

## 五、可靠传输与流量控制

### 1、确认与重传

TCP 在不可靠的 IP 之上提供可靠、有序、不重复的字节流，靠的是这几样东西：

| 机制 | 作用 |
|------|------|
| 序号 + 累计确认 | 接收方按序号重排、去重，用 `ack` 告诉发送方「这之前都收到了」 |
| 超时重传 | 发送方为未确认数据设置重传定时器 RTO，按 RTT 动态计算（RFC 6298），每次超时 RTO 翻倍 |
| 快速重传 | 连续收到 3 个重复 ACK，说明中间有包丢了，不等超时直接重传 |
| SACK | 接收方告诉发送方「哪些不连续的块已经收到」，发送方只补发缺的部分 |
| 校验和 | 丢弃损坏的报文，由重传兜底 |

### 2、滑动窗口与流量控制

**流量控制解决的是「发送方别把接收方淹没」**。接收方在每个 ACK 里通告接收窗口 `rwnd`（自己的接收缓冲区还剩多少），发送方在途未确认的数据量不超过它：

- 发送窗口随 ACK 向前滑动：确认一部分、窗口右移、就能再发一部分
- 应用读得慢，接收缓冲区满了，`rwnd` 变为 0（零窗口），发送方暂停发送，并定期发送**窗口探测**报文，等对方窗口重新打开
- 16 位窗口字段最大 64 KB，高带宽长时延链路不够用，所以握手时协商**窗口缩放**选项，把窗口放大到最多 1 GiB

抓包看到大量 `TCP ZeroWindow` 时，问题在接收方应用读取太慢，而不是网络。

---

## 六、拥塞控制

### 1、四个经典算法

流量控制看的是接收方，**拥塞控制看的是网络**：发送方维护拥塞窗口 `cwnd`，实际发送窗口取 `min(rwnd, cwnd)`。经典算法（RFC 5681）由慢启动阈值 `ssthresh` 划分阶段：

![拥塞窗口随传输轮次的变化：慢启动、拥塞避免、快速恢复与超时](../assets/protocols/tcp-congestion-window.svg)

| 阶段 | 规则 | 触发条件 |
|------|------|----------|
| 慢启动 | 每收到一个 ACK，`cwnd` 加 1 个 MSS，效果是每个 RTT 翻倍 | 连接刚建立，或超时之后；`cwnd < ssthresh` |
| 拥塞避免 | 每个 RTT `cwnd` 只加 1 个 MSS，线性增长 | `cwnd >= ssthresh` |
| 快速重传 | 收到 3 个重复 ACK 立即重传丢失的报文 | 出现个别丢包，网络仍基本通畅 |
| 快速恢复 | `ssthresh` 设为当前 `cwnd` 的一半，`cwnd` 从这里继续拥塞避免，而不是回到 1 | 紧接快速重传 |

超时是更严重的信号（网络可能已经堵死）：`ssthresh` 减半、`cwnd` 回到初始值，重新慢启动。图中为了直观从 1 开始，实际 Linux 的初始窗口是 10 个 MSS（RFC 6928）。

### 2、CUBIC 与 BBR

| 算法 | 拥塞信号 | 特点 | 适用 |
|------|----------|------|------|
| CUBIC | 丢包 | 窗口按三次函数增长，丢包后快速回到上次的窗口附近再试探；Linux 自 2.6.19 起的默认算法（RFC 9438） | 通用默认，数据中心内部网络 |
| BBR | 估算的瓶颈带宽和最小 RTT | 不把丢包当拥塞，主动测量带宽和时延，按「带宽 × 时延」控制在途数据量；Google 开发，Linux 4.9 合入 | 有随机丢包的长距离、跨国、无线链路，能明显提高吞吐、降低排队时延 |

查看与切换：

```bash
sysctl net.ipv4.tcp_congestion_control             # 当前算法
sysctl net.ipv4.tcp_available_congestion_control   # 可用算法
sysctl -w net.core.default_qdisc=fq
sysctl -w net.ipv4.tcp_congestion_control=bbr
```

BBR 与 CUBIC 混跑时带宽分配不一定公平，切换前要在真实链路上压测对比。

---

## 七、Nagle 算法与延迟确认

两个机制都是为了减少小包，但叠在一起会互相等待：

| 机制 | 做什么 | 目的 |
|------|--------|------|
| Nagle 算法（RFC 896） | 还有未确认的数据时，新的小数据先攒着，等 ACK 回来或攒满一个 MSS 再发 | 避免大量只带几个字节的小包浪费带宽 |
| 延迟确认（RFC 1122） | 收到数据不立刻回 ACK，等一小段时间（Linux 最少约 40 ms），看能不能和响应数据一起发 | 减少纯 ACK 报文 |

**冲突**：客户端分两次写一个请求（先写头、再写体），第一次的小包发出去后，Nagle 让第二次的数据等 ACK；服务端还没收到完整请求，不会回响应，ACK 又被延迟确认压着。结果每次请求多出约 40 ms 时延。

处理：对时延敏感的 RPC、交互式协议设置 `TCP_NODELAY=true` 关闭 Nagle（Netty、gRPC 默认已开启 `TCP_NODELAY`，其他客户端以文档为准、拿不准就显式设置）；同时让应用尽量一次写出完整消息，而不是依赖 Nagle 合并。

---

## 八、keepalive 与应用层心跳

TCP keepalive 在连接空闲一段时间后发送探测报文，对端无响应就断开连接。它是内核功能，默认关闭，需要 `SO_KEEPALIVE` 开启。Linux 默认参数非常保守：

| 参数 | 默认值 | 含义 |
|------|--------|------|
| `tcp_keepalive_time` | 7200 秒 | 空闲多久后开始探测 |
| `tcp_keepalive_intvl` | 75 秒 | 探测间隔 |
| `tcp_keepalive_probes` | 9 次 | 连续失败多少次判定断开 |

按默认值，一条对端已经消失的连接要两个多小时才会被发现。JDK 11 起可以按连接调整：

```java
import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.StandardSocketOptions;
import java.nio.channels.SocketChannel;
import jdk.net.ExtendedSocketOptions;

public class KeepAliveDemo {
    public static void main(String[] args) throws IOException {
        try (SocketChannel channel = SocketChannel.open()) {
            channel.setOption(StandardSocketOptions.SO_KEEPALIVE, true);
            channel.setOption(ExtendedSocketOptions.TCP_KEEPIDLE, 60);     // 空闲 60 秒开始探测
            channel.setOption(ExtendedSocketOptions.TCP_KEEPINTERVAL, 10); // 每 10 秒一次
            channel.setOption(ExtendedSocketOptions.TCP_KEEPCOUNT, 3);     // 3 次无响应断开
            channel.setOption(StandardSocketOptions.TCP_NODELAY, true);
            channel.connect(new InetSocketAddress("example.com", 80));
        }
    }
}
```

即便调小参数，keepalive 也只能证明**对端内核还活着**，证明不了对端应用能正常处理请求（进程卡死、线程池打满时内核照样回探测包）。中间的 NAT、负载均衡空闲超时也可能比探测间隔更短。所以长连接服务以**应用层心跳**为准，TCP keepalive 只做兜底，设计方法见 [心跳与连接管理](/netty/9_heartbeat)。

另外注意区分：HTTP 的 `Connection: keep-alive` 是 HTTP 层的连接复用，和 TCP keepalive 探测没有关系。

---

## 九、粘包与拆包

TCP 只保证字节按顺序到达，不保留应用写入时的边界：一次 `write` 可能被拆成多个报文，多次 `write` 也可能被合并读出。所以「粘包」不是 TCP 的缺陷，而是应用层没有定义消息边界。常见做法是长度字段、分隔符或定长消息，原理与 Netty 的帧解码器见 [粘包与拆包](/netty/7_stick_split)。

---

## 十、UDP

### 1、特点

UDP（RFC 768）几乎只在 IP 之上加了端口和校验和，头部固定 8 字节：

- **无连接**：不握手，发第一个包就是数据，没有建连时延
- **不可靠**：不确认、不重传、不排序，丢了就丢了
- **保留消息边界**：一次 `send` 对应对端一次 `receive`，没有粘包问题
- **无拥塞控制**：发送速率由应用决定，打满链路会伤害其他流量，需要应用自己限速
- **支持广播和组播**

单个 UDP 报文超过路径 MTU（以太网一般 1500 字节）会在 IP 层分片，任何一片丢失整个报文都作废，所以实际协议通常把单个报文控制在约 1200 字节以内。

### 2、适用场景

| 场景 | 为什么用 UDP |
|------|--------------|
| DNS 查询 | 一问一答、报文小，建 TCP 连接的开销比查询本身还大，见 [DNS](./4_dns) |
| 音视频通话、直播、游戏 | 迟到的数据没有价值，宁可丢帧也不要等重传 |
| 指标与日志上报（StatsD、syslog） | 允许少量丢失，换取发送端零阻塞 |
| QUIC / HTTP/3 | 在 UDP 之上的用户态实现可靠传输，绕开 TCP 的限制 |
| 局域网发现（mDNS、DHCP） | 需要广播或组播 |

### 3、TCP 与 UDP 对比

| 维度 | TCP | UDP |
|------|-----|-----|
| 连接 | 面向连接，三次握手 | 无连接 |
| 可靠性 | 确认、重传、有序、去重 | 不保证，可能丢失、乱序、重复 |
| 数据形态 | 字节流，无消息边界 | 数据报，保留消息边界 |
| 流量 / 拥塞控制 | 有 | 无，由应用负责 |
| 头部开销 | 20–60 字节 | 8 字节 |
| 通信方式 | 一对一 | 一对一、广播、组播 |
| 典型应用 | HTTP/1.1、HTTP/2、数据库、消息队列、RPC | DNS、音视频、游戏、QUIC |

### 4、QUIC：在 UDP 上重做传输层

TCP 实现在操作系统内核里，改进要等内核和中间网络设备一起升级，而且一个丢包会阻塞同一连接上的所有 HTTP/2 流。QUIC（RFC 9000）选择在 UDP 之上、用户态里重新实现可靠传输：每个流独立排序，一个流丢包不影响其他流；把 TLS 1.3 握手合进建连，首次连接 1-RTT、恢复连接可 0-RTT；用连接 ID 而不是四元组标识连接，手机切换网络时连接不断。HTTP/3 就跑在 QUIC 上，细节见 [HTTP](./2_http)。

---

## 小结

- 三次握手的本质是双方交换并确认初始序号，三次是为了拒绝历史连接；全连接队列溢出多半是应用 accept 慢，SYN Flood 靠 syncookies 兜底
- 四次挥手是因为两个方向各自关闭；被动方收到 FIN 就进入 CLOSE_WAIT，发出自己的 FIN 后进入 LAST_ACK
- TIME_WAIT 在主动关闭方，Linux 固定 60 秒；客户端侧会耗尽临时端口，首选连接复用，`tcp_tw_reuse` 只对主动发起的连接有效，`tcp_tw_recycle` 已在 Linux 4.12 删除
- CLOSE_WAIT 堆积是应用没调 `close()`，从线程栈和异常路径查起
- 流量控制看接收方的 `rwnd`，拥塞控制看网络的 `cwnd`；Linux 默认 CUBIC，长距离有丢包的链路可以考虑 BBR
- Nagle 与延迟确认叠加会多出约 40 ms 时延，时延敏感场景开 `TCP_NODELAY`；TCP keepalive 只能兜底，长连接以应用层心跳为准
- UDP 无连接、保留边界、无拥塞控制，适合 DNS、音视频和 QUIC
- 粘包拆包、应用层心跳等编程问题放在 [Netty](/netty/0_overview) 模块。

## 参考资料

- RFC 9293 Transmission Control Protocol：[https://www.rfc-editor.org/rfc/rfc9293.html](https://www.rfc-editor.org/rfc/rfc9293.html)
- RFC 768 User Datagram Protocol：[https://www.rfc-editor.org/rfc/rfc768.html](https://www.rfc-editor.org/rfc/rfc768.html)
- RFC 5681 TCP Congestion Control：[https://www.rfc-editor.org/rfc/rfc5681.html](https://www.rfc-editor.org/rfc/rfc5681.html)
- RFC 9438 CUBIC for Fast and Long-Distance Networks：[https://www.rfc-editor.org/rfc/rfc9438.html](https://www.rfc-editor.org/rfc/rfc9438.html)
- RFC 6298 Computing TCP's Retransmission Timer：[https://www.rfc-editor.org/rfc/rfc6298.html](https://www.rfc-editor.org/rfc/rfc6298.html)
- RFC 4987 TCP SYN Flooding Attacks and Common Mitigations：[https://www.rfc-editor.org/rfc/rfc4987.html](https://www.rfc-editor.org/rfc/rfc4987.html)
- RFC 9000 QUIC：[https://www.rfc-editor.org/rfc/rfc9000.html](https://www.rfc-editor.org/rfc/rfc9000.html)
- Linux IP Sysctl 文档：[https://docs.kernel.org/networking/ip-sysctl.html](https://docs.kernel.org/networking/ip-sysctl.html)
- JDK 21 ExtendedSocketOptions：[https://docs.oracle.com/en/java/javase/21/docs/api/jdk.net/jdk/net/ExtendedSocketOptions.html](https://docs.oracle.com/en/java/javase/21/docs/api/jdk.net/jdk/net/ExtendedSocketOptions.html)

> 下一篇：[HTTP](./2_http) —— 请求语义与状态码、缓存、Cookie，以及 HTTP/1.1 到 HTTP/3 的演进。
