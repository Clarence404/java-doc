---
description: RT 的 200ms 台阶、重传率、ss -ti、nstat 与 softnet_stat、抓包、网卡中断集中
---

# 网络重传与丢包

> 前置阅读：[TCP 与 UDP](/protocols/1_tcp_udp)、[Linux 排查命令速查](/handbook/1_cheatsheet/0_linux)

库存服务的调用耗时偶尔"整齐地"多出约 210ms 或 420ms，应用、数据库、GC 都查不出问题。本篇复盘一次由节点网卡中断集中引发的丢包与 TCP 重传，基线为 Linux 6、JDK 21。

---

## 一、现象

10 月 10 日起，订单服务调用库存服务（HTTP/1.1 长连接，读超时 1s）的耗时出现规律性毛刺：

| 时间 | 告警 / 现象 |
|------|-------------|
| 10-10 晚高峰 | 订单服务 → 库存服务 P99 从 25ms 升到 230ms，P999 到 640ms |
| 10-11 11:20 | `HttpClientTimeout`：调用库存服务读超时比例 0.4% |
| 10-11 11:30 | 库存服务自身 `http_server_requests` P99 仍为 18ms，与调用方看到的差距很大 |

把调用方的耗时分布画成直方图，慢请求集中在 **210ms、420ms 附近**，像台阶一样，而不是连续分布。

---

## 二、影响

- 10-10 至 10-11 两个晚高峰，下单接口 P99 从 180ms 升到 450ms，约 0.4% 的库存预占因超时失败后重试，用户侧感知为偶发"下单稍慢"
- 超时后重试导致少量库存预占记录重复，由预占幂等键拦截，没有超卖
- 排查期间库存服务被误判为"慢服务"，扩容了 4 个实例，没有任何效果

---

## 三、排查过程

### 1、服务端快、调用方慢：问题在中间

服务端耗时 18ms、调用方 230ms，差值只能出现在网络、内核协议栈或调用方自身排队上。调用方的 HTTP 连接池没有等待（`pending=0`），GC 正常，先怀疑网络。

慢请求集中在 210ms、420ms 附近很有指向性：Linux 的 TCP 最小重传超时（RTO）是 200ms。一次丢包靠超时重传补回，就多出约一个 RTO（加上约 10ms 的 RTT ≈ 210ms）；一次请求里有两处各自独立丢包、各等一次约 200ms 的 RTO，叠起来约 420ms。要是同一个包连续两次超时，RTO 才会翻倍（200 + 400 ≈ 600ms），正对应这里 P999 的 640ms。**台阶状的延迟是超时重传的典型特征。**

### 2、看重传率

在调用方 Pod 所在节点上，用 `nstat` 采两次计数取差值：

```bash
nstat -n; sleep 10; nstat -z TcpOutSegs TcpRetransSegs TcpExtTCPLostRetransmit TcpExtTCPTimeouts
```

示例输出：

```text
#kernel
TcpOutSegs                      482113             0.0
TcpRetransSegs                  6871               0.0
TcpExtTCPLostRetransmit         412                0.0
TcpExtTCPTimeouts               1937               0.0
```

10 秒内重传率 = `TcpRetransSegs / TcpOutSegs` = 6871 / 482113 ≈ **1.4%**。同机房内网正常的重传率应在 0.1% 以下，1% 以上已经明显影响延迟。`TcpExtTCPTimeouts` 很高，说明不少重传是靠超时触发的，而不是快速重传，这正对应 200ms 台阶。

没有 `nstat` 的老系统可以用 `netstat -s | grep -iE "retrans|timeout"`，它输出的是开机以来的累计值，同样要采两次相减。

用 node_exporter 指标在所有节点上对比：

```promql
rate(node_netstat_Tcp_RetransSegs[5m]) / rate(node_netstat_Tcp_OutSegs[5m])
```

示例结果：

```text
{instance="node-07"}  0.0139
{instance="node-03"}  0.0006
{instance="node-11"}  0.0004
...
```

只有 node-07 异常，其他节点都在 0.05% 左右。把订单服务的慢请求按 Pod 拆开，慢的全部是调度在 node-07 上的两个 Pod。

### 3、看单个连接：ss -ti

在 node-07 上找到发往库存服务的连接：

```bash
ss -tin state established '( dport = :8080 and dst 10.42.3.0/24 )' | head -8
```

示例输出（节选）：

```text
Recv-Q Send-Q   Local Address:Port    Peer Address:Port
0      0          10.42.7.15:51846    10.42.3.21:8080
	 cubic wscale:7,7 rto:212 rtt:9.8/14.2 ato:40 mss:1448 pmtu:1500 rcvmss:1448 advmss:1448
	 cwnd:6 ssthresh:7 bytes_sent:18234112 bytes_retrans:291840 bytes_acked:18234112
	 segs_out:31427 segs_in:28855 data_segs_out:14873 data_segs_in:14102
	 send 7.1Mbps lastsnd:84 lastrcv:84 lastack:84 pacing_rate 14.2Mbps
	 retrans:0/203 lost:0 sacked:0 reordering:3 rcv_rtt:12.5 rcv_space:57920
```

要看的字段：

| 字段 | 含义 | 这里的值说明 |
|------|------|--------------|
| `rto` | 当前重传超时（ms） | 212，已经是下限附近 |
| `rtt` | 平滑 RTT / 抖动 | 9.8 / 14.2，同机房内网本应 1ms 以内，抖动大于均值 |
| `retrans` | 当前未确认的重传段 / 累计重传次数 | 累计 203 次 |
| `bytes_retrans` | 重传字节数 | 占发送字节约 1.6% |
| `cwnd` / `ssthresh` | 拥塞窗口 | 被重传反复压小 |

再到库存服务所在节点上看：它和 node-07 之间的连接同样有大量重传，和其他节点上调用方之间的连接重传几乎为 0。**丢的是 node-07 接收方向的包**：库存服务发出的响应在 node-07 被丢，服务端只能等超时重传；调用方的请求其实送到了，但对端回的 ACK 被丢，调用方也会误判请求丢失而重传。

### 4、抓包确认

在 node-07 上对一个慢连接抓 30 秒（限定端口和包数，避免抓包本身影响机器）：

```bash
tcpdump -i eth0 -nn -s 128 -c 50000 -w /tmp/inv.pcap 'host 10.42.3.21 and port 8080'
```

用 Wireshark 打开，过滤 `tcp.analysis.retransmission || tcp.analysis.lost_segment`，同时在库存服务节点上对同一条流抓包对比：库存服务节点上能看到响应包发出，node-07 网卡上却没有收到，约 200ms 后服务端重传，node-07 才收到。丢包发生在 node-07 的接收路径上，而不是交换机或对端。

### 5、是网卡丢还是内核丢

```bash
ip -s link show eth0
ethtool -S eth0 | grep -iE "drop|miss|no_buf|fifo" | grep -v ": 0$"
```

示例输出：

```text
2: eth0: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 qdisc mq state UP mode DEFAULT group default qlen 1000
    RX:      bytes   packets errors dropped  missed   mcast
      918236419328 712830115      0  138211  2904117       0
    TX: ...
     rx_missed_errors: 2904117
     rx_no_buffer_count: 2891820
```

`missed` 和驱动的 `rx_no_buffer_count` 持续增长：网卡接收环形缓冲区满了，内核来不及取走，包在网卡层就被丢弃。再看内核软中断处理：

```bash
cat /proc/net/softnet_stat | awk '{print NR-1, $1, $2, $3}' | head -4
mpstat -P ALL 2 1 | head -8
```

示例输出：

```text
0 c41b8f22 00021bd3 00007a1e
1 0001a33f 00000000 00000000
2 00019e07 00000000 00000000
3 0001b211 00000000 00000000

CPU    %usr   %nice    %sys %iowait    %irq   %soft  %steal  %guest  %gnice   %idle
all   22.31    0.00    6.84    0.12    0.00   11.27    0.00    0.00    0.00   59.46
  0   18.50    0.00    7.00    0.00    0.00   73.50    0.00    0.00    0.00    1.00
  1   23.12    0.00    6.53    0.00    0.00    0.50    0.00    0.00    0.00   69.85
```

`softnet_stat` 每行对应一个 CPU，第 1 列是处理的包数、第 2 列是因 backlog 满丢弃的包数、第 3 列是软中断时间片用完被迫中止的次数（time_squeeze）。**只有 CPU0 在处理收包，且软中断占用 73.5%**，其余 CPU 的收包计数不到它的千分之一。

```bash
grep eth0 /proc/interrupts | head -4
systemctl is-active irqbalance
```

示例输出：

```text
 45:  3812294012          0          0          0   PCI-MSI 524288-edge      eth0-TxRx-0
 46:          0          0          0          0   PCI-MSI 524289-edge      eth0-TxRx-1
...
inactive
```

网卡有 8 个队列，但中断全部落在 CPU0 上（上面输出为省篇幅只保留了前 4 个 CPU 列），`irqbalance` 没有运行。

---

## 四、根因

node-07 是 10 月 9 日用新版本节点镜像重建的，新镜像精简时去掉了 `irqbalance`，网卡多队列的中断全部绑在 CPU0 上：

1. 晚高峰收包量上来后，CPU0 的软中断处理不过来（softnet backlog 溢出、time_squeeze 增长）
2. 内核取包不及时，网卡接收环形缓冲区（大小取驱动默认值，本机为 512，可用 `ethtool -g eth0` 查看）被填满，后续包在网卡层被丢弃（`rx_missed_errors`）
3. 丢掉的响应和 ACK 只能靠对端超时重传补回，每次至少 200ms，这就是调用耗时出现 200ms / 400ms 台阶的原因

其他节点用的是老镜像，`irqbalance` 正常运行，所以只有调度到 node-07 的 Pod 受影响。

---

## 五、修复

### 1、止血

- 10-11 14:10 将 node-07 标记为不可调度并驱逐其上的 Pod（`kubectl cordon node-07`、`kubectl drain node-07 --ignore-daemonsets --delete-emptydir-data`），订单服务 P99 立即回到 25ms
- 撤销此前对库存服务的无效扩容

### 2、修复节点

```bash
# 恢复中断均衡
systemctl enable --now irqbalance

# 加大网卡接收环形缓冲区（先用 ethtool -g eth0 查看硬件上限）
ethtool -G eth0 rx 4096

# 加大每个 CPU 的接收 backlog
sysctl -w net.core.netdev_max_backlog=16384
```

`ethtool -G` 和 `sysctl -w` 重启后会失效，持久化写到节点镜像的 udev / NetworkManager 配置与 `/etc/sysctl.d/` 中。修复后 node-07 重传率降到 0.03%，`rx_missed_errors` 不再增长，再 `kubectl uncordon` 恢复调度。

::: tip 网卡队列少的虚拟机
单队列或队列数少于 CPU 数的虚拟网卡，只靠中断均衡解决不了，可以开启 RPS（Receive Packet Steering）把软中断处理分散到多个 CPU，见内核文档 Scaling in the Linux Networking Stack。
:::

### 3、镜像基线

节点镜像构建流水线增加检查：`irqbalance` 已启用、网卡 ring 与 `netdev_max_backlog` 为基线值，检查失败镜像不得发布。

---

## 六、预防

**监控告警**：

```yaml
- alert: NodeTcpRetransHigh
  expr: |
    rate(node_netstat_Tcp_RetransSegs[5m]) / rate(node_netstat_Tcp_OutSegs[5m]) > 0.005
  for: 10m
  labels: {severity: warning}
- alert: NodeNetworkRxDrop
  expr: |
    rate(node_network_receive_drop_total{device!~"lo|veth.*|cali.*"}[5m]) > 50
    or rate(node_softnet_dropped_total[5m]) > 0
  for: 10m
  labels: {severity: warning}
```

**排查习惯**：

- 调用方慢、服务方快时，先按"调用方 Pod 所在节点"分组看，单节点问题比单服务问题更常见
- 延迟呈 200ms、400ms 台阶分布时，第一时间看重传率，不要先去扩容被调用服务

**变更管理**：

- 节点镜像变更按灰度发布：先替换 1–2 个节点，观察重传率、丢包和 softnet 指标一个晚高峰后再全量

---

## 七、涉及知识点

- 超时重传、快速重传与 SACK：[TCP 与 UDP](/protocols/1_tcp_udp#_1、确认与重传)
- 拥塞控制与 cwnd：[TCP 与 UDP](/protocols/1_tcp_udp#六、拥塞控制)
- 网络排查命令速查：[Linux 排查命令速查](/handbook/1_cheatsheet/0_linux#四、网络)
- 连接复用与超时设置：[IO 与网络优化](/high-perf/9_io_network)
- 超时与重试的配合：[超时、重试与隔离](/high-avail/4_timeout_retry_bulkhead)
- 同为"刚好多出几秒"的网络问题：[DNS 解析超时](./16_dns_timeout)

---

## 小结

- 延迟整齐地多出约 210ms / 420ms，优先怀疑超时重传：Linux 最小 RTO 是 200ms，一次丢包多出约一个 RTO，一次请求里两处独立丢包就叠成约两个 RTO；同一个包连续超时才会 RTO 翻倍（200 + 400 ≈ 600ms）
- 重传率 = `TcpRetransSegs` 增量 / `TcpOutSegs` 增量，内网健康值应在 0.1% 以下；先在全体节点上对比，定位到具体节点
- `ss -ti` 看单连接的 rtt、rto、retrans，`tcpdump` 两端对照确认丢包位置
- 接收侧丢包分两层：网卡 ring 满看 `ethtool -S` 与 `ip -s link` 的 missed，内核 backlog 满看 `softnet_stat` 第 2 列；中断集中在单核是常见原因

## 参考资料

- `ss` 输出字段：[ss(8) — Linux manual page](https://man7.org/linux/man-pages/man8/ss.8.html)
- `nstat` 用法：[nstat(8) — Linux manual page](https://man7.org/linux/man-pages/man8/nstat.8.html)
- RTO 计算规则：[RFC 6298: Computing TCP's Retransmission Timer](https://www.rfc-editor.org/rfc/rfc6298)
- 多队列、RSS 与 RPS：[Linux Kernel Documentation — Scaling in the Linux Networking Stack](https://docs.kernel.org/networking/scaling.html)
- `netdev_max_backlog` 等参数：[Linux Kernel Documentation — /proc/sys/net/core](https://docs.kernel.org/admin-guide/sysctl/net.html)
- 抓包过滤语法：[tcpdump(1) man page](https://www.tcpdump.org/manpages/tcpdump.1.html)

> 下一篇：[依赖冲突导致 NoSuchMethodError](./25_dependency_conflict)
