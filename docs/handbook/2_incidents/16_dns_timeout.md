---
description: 偶发恰好 5 秒、ndots:5 放大查询、conntrack 冲突丢包、NodeLocal DNSCache 修复
---

# DNS 解析超时

> 前置阅读：[DNS](/protocols/4_dns)、[Kubernetes](/cloud-native/6_kubernetes)

订单服务调用外部支付网关偶发「刚好慢 5 秒」，对方接口只要几十毫秒，网络组也查不到丢包。本篇复盘这次 DNS 解析超时，基线为 Kubernetes 1.37、JDK 21。

---

## 一、现象

2026-09-24（周四）上午，`order-service` 创建支付单时调用外部支付网关 `api.pay-gateway.example.com`。

| 时间 | 现象 |
|------|------|
| 一周前起 | 支付按钮「偶尔转圈很久」的用户反馈零星出现，未定位 |
| 09:40 | 告警「调用支付网关 P99 > 3s，持续 5 分钟」触发 |
| 09:40～11:30 | 调用支付网关的 P50 为 42ms，P99 为 5.06s；约 0.4% 的调用耗时落在 5.0～5.1s，极少数在 10s 左右 |
| 同期 | 日志中每小时出现 10～20 条 `java.net.UnknownHostException: api.pay-gateway.example.com: Temporary failure in name resolution` |
| 同期 | 调用集群内的库存服务也有约 0.1% 慢 5 秒，只是没有单独的告警 |

支付网关提供的服务端日志显示，同一批请求在对方的处理耗时都在 50ms 以内。

---

## 二、影响

- **支付体验**：约 0.4% 的支付请求多等 5 秒，部分用户重复点击，产生重复的支付单（支付单号幂等，未重复扣款）
- **支付失败**：解析两次都超时的请求（约 0.02%）直接失败，用户看到「支付服务暂不可用」
- **范围**：不止订单服务，集群内所有访问外部域名、或用短域名访问其他 Namespace 服务的应用都受影响，只是订单服务的告警最先触发
- **故障等级**：P3（体验降级，无数据错误），持续约一周才被定位

---

## 三、排查过程

### 1、链路追踪：时间花在哪里

在 Tempo 中按 `duration > 4s` 筛选支付网关调用，打开一条慢 trace：

示例输出（span 摘要）：

```text
POST /api/orders/{id}/pay                       5,112 ms
└─ http post api.pay-gateway.example.com        5,071 ms
     http.response.status_code = 200
     server.address = api.pay-gateway.example.com
     （客户端 span 开始到首字节约 5,030 ms，对方服务端耗时 38 ms）
```

慢请求的耗时几乎都是 **5 秒加正常耗时**，10 秒的则是 5 秒的两倍。这个整数很关键：glibc 解析器的默认超时 `timeout:5`、重试 `attempts:2`。时间花在**建连之前**，方向转向 DNS。

### 2、在 Pod 里复现慢解析

```bash
kubectl -n order exec -it order-service-6c9d7f5b8d-q7m2x -- cat /etc/resolv.conf
kubectl -n order exec -it order-service-6c9d7f5b8d-q7m2x -- bash -c '
for i in $(seq 1 300); do
  s=$(date +%s%N); getent ahosts api.pay-gateway.example.com > /dev/null
  e=$(( ($(date +%s%N) - s) / 1000000 )); [ $e -gt 1000 ] && echo "#$i slow ${e}ms"
done'
```

示例输出：

```text
search order.svc.cluster.local svc.cluster.local cluster.local
nameserver 10.96.0.10
options ndots:5

#37 slow 5006ms
#142 slow 5011ms
#251 slow 5004ms
```

镜像基于 `eclipse-temurin:21-jre`（Ubuntu，glibc），`getent` 与 JVM 一样走 `getaddrinfo`。300 次里 3 次慢 5 秒，与线上 0.4%～1% 的比例吻合。

### 3、抓包：哪个查询没有回应

用临时调试容器共享应用容器的网络命名空间抓包：

```bash
kubectl -n order debug -it order-service-6c9d7f5b8d-q7m2x \
  --image=nicolaka/netshoot:v0.13 --target=order-service -- \
  tcpdump -i eth0 -nn udp port 53
```

示例输出（一次慢解析）：

```text
10:21:07.112301 IP 10.244.3.27.48211 > 10.96.0.10.53: 41523+ A? api.pay-gateway.example.com.order.svc.cluster.local. (69)
10:21:07.112355 IP 10.244.3.27.48211 > 10.96.0.10.53: 18734+ AAAA? api.pay-gateway.example.com.order.svc.cluster.local. (69)
10:21:07.113012 IP 10.96.0.10.53 > 10.244.3.27.48211: 41523 NXDomain*- 0/1/0 (162)
10:21:12.117640 IP 10.244.3.27.48211 > 10.96.0.10.53: 41523+ A? api.pay-gateway.example.com.order.svc.cluster.local. (69)
10:21:12.117702 IP 10.244.3.27.48211 > 10.96.0.10.53: 18734+ AAAA? api.pay-gateway.example.com.order.svc.cluster.local. (69)
10:21:12.118391 IP 10.96.0.10.53 > 10.244.3.27.48211: 41523 NXDomain*- 0/1/0 (162)
10:21:12.118455 IP 10.96.0.10.53 > 10.244.3.27.48211: 18734 NXDomain*- 0/1/0 (162)
10:21:12.118930 IP 10.244.3.27.48211 > 10.96.0.10.53: 52206+ A? api.pay-gateway.example.com.svc.cluster.local. (63)
...
10:21:12.121877 IP 10.96.0.10.53 > 10.244.3.27.53960: 60117 1/0/0 A 203.0.113.25 (61)
```

两个信息：

- **一次解析要查 8 次**：`ndots:5` 下外部域名（3 个点，少于 5）先依次拼接 3 个 search 域，每个都查 A 和 AAAA，全部 NXDOMAIN 后才查原始域名，见 [DNS · Kubernetes 中的 ndots](/protocols/4_dns#_2、kubernetes-中的-ndots)
- **AAAA 查询的回应丢了**：glibc 用**同一个 socket（同一源端口）**几乎同时发出 A 和 AAAA，其中一个包没有回应，解析器等满 5 秒才重发

### 4、节点上的 conntrack 统计

Service IP `10.96.0.10` 要经过 kube-proxy 的 DNAT 才能到达 CoreDNS Pod，UDP 的 DNAT 依赖 conntrack。到 Pod 所在节点查看：

```bash
kubectl debug node/node-03 -it --image=nicolaka/netshoot:v0.13 -- sh -c 'uname -r; conntrack -S | head -4'
```

示例输出：

```text
5.15.0-122-generic
cpu=0   found=0 invalid=1872 insert=0 insert_failed=6114 drop=6114 early_drop=0 error=0 search_restart=29871
cpu=1   found=0 invalid=1690 insert=0 insert_failed=5893 drop=5893 early_drop=0 error=0 search_restart=27342
cpu=2   found=0 invalid=1781 insert=0 insert_failed=6027 drop=6027 early_drop=0 error=0 search_restart=28116
```

`insert_failed` 与 `drop` 持续增长。Prometheus 上看全集群的趋势：

```promql
sum by (instance) (rate(node_nf_conntrack_stat_insert_failed[5m]))
```

曲线在 9 月 17 日之后明显抬升，那天 CoreDNS 副本从 2 个扩到 6 个。原因是：同一源端口的 A、AAAA 两个包几乎同时经过 DNAT，各自创建 conntrack 条目，若被分配到**不同的 CoreDNS 副本**，后确认的条目与先确认的冲突，插入失败，这个包被丢弃。内核 5.x 修复了同一后端时的冲突，但多后端时仍可能发生；CoreDNS 副本越多，两个包被分到不同后端的概率越大。

### 5、CoreDNS 的负载构成

```promql
sum(rate(coredns_dns_requests_total[5m]))
sum(rate(coredns_dns_responses_total{rcode="NXDOMAIN"}[5m])) / sum(rate(coredns_dns_responses_total[5m]))
```

示例读数：全集群 DNS 请求约 18,000 QPS，其中 **NXDOMAIN 占 72%**，几乎都是 search 域拼接出来的无效名字。`ndots:5` 让每次外部解析的包量变成 8 倍，conntrack 冲突的机会也跟着放大 8 倍。

### 6、JVM 侧确认

```bash
kubectl -n order exec order-service-6c9d7f5b8d-q7m2x -- jcmd 1 VM.system_properties | grep -E 'java.security.properties|sun.net.inetaddr'
```

没有任何输出：既没有追加安全属性文件，也没有设置旧的系统属性，镜像里的 `java.security` 也未改动，说明用的是默认值：解析成功缓存 30 秒、失败缓存 10 秒。每个 Pod 对每个外部域名每 30 秒至少解析一次，40 个 Pod、十几个外部域名，持续给 CoreDNS 制造查询。负缓存还会把一次失败放大成 10 秒内同名请求全部 `UnknownHostException`，这就是零星报错的来源。

---

## 四、根因

| 层面 | 问题 |
|------|------|
| 内核 / kube-proxy | UDP DNS 经 Service DNAT，glibc 同 socket 并发发出 A / AAAA，多 CoreDNS 后端时触发 conntrack 插入冲突，丢包 |
| 解析器 | 丢包后等待默认 `timeout:5` 才重试，用户看到的就是「恰好慢 5 秒」 |
| 集群配置 | 默认 `ndots:5`，外部域名每次解析产生 8 个查询，NXDOMAIN 占 72%，冲突概率被放大 |
| 触发因素 | CoreDNS 由 2 副本扩到 6 副本，A / AAAA 被分到不同后端的概率升高 |

---

## 五、修复

### 1、止血：订单服务调整解析参数

```yaml
spec:
  template:
    spec:
      dnsConfig:
        options:
          - name: ndots
            value: "2"                 # 外部域名（≥ 2 个点）直接查原名，不再拼接 search
          - name: single-request-reopen # A 与 AAAA 冲突时换新 socket 重发，避开同端口冲突
          - name: timeout
            value: "2"                 # 万一丢包，最坏多等 2 秒而不是 5 秒
          - name: attempts
            value: "3"
```

- `single-request-reopen` 是 glibc 选项，Alpine（musl）镜像不支持，需要其他手段
- `ndots: 2` 后，形如 `mysql.db.svc` 的集群内名字（2 个点）会先按原名查一次再走 search，集群内服务统一使用短名或完整的 `<svc>.<ns>.svc.cluster.local`
- 11:30 发布后，支付网关调用 P99 回到 120ms，5 秒的尖峰消失

### 2、根治：部署 NodeLocal DNSCache

每个节点运行一个 DNS 缓存代理（DaemonSet），Pod 直接访问本节点的缓存地址：

- Pod → 本地缓存**不经过 DNAT 和 conntrack**，从根上消除 UDP 插入冲突
- 本地缓存 → CoreDNS 可以升级为 TCP，TCP 连接关闭即删除 conntrack 条目，不会像 UDP 那样占满表
- 缓存命中后不再跨节点访问 CoreDNS，NXDOMAIN 也被本地缓存

按官方文档部署后，`node_nf_conntrack_stat_insert_failed` 降到接近 0，CoreDNS QPS 从 18,000 降到约 4,000。

### 3、应用侧

```properties
# 镜像内 /opt/app/dns.security，启动参数加 -Djava.security.properties=/opt/app/dns.security
networkaddress.cache.ttl=60
networkaddress.cache.negative.ttl=1
```

- 正缓存从 30 秒放宽到 60 秒，支付网关的 IP 变更窗口可以接受；负缓存降到 1 秒，避免一次失败拖累后续请求
- 支付网关的 HTTP 客户端开启连接复用、保持空闲连接，新建连接（以及随之而来的解析）大幅减少；连接最大存活时间设为 5 分钟，保证 DNS 变更最终生效

---

## 六、预防

### 1、监控与告警

```yaml
- alert: ConntrackInsertFailed
  expr: sum by (instance) (rate(node_nf_conntrack_stat_insert_failed[5m])) > 1
  for: 10m
  labels: { severity: warning }
  annotations:
    summary: "{{ $labels.instance }} conntrack 插入失败持续增长，可能导致 DNS 等 UDP 丢包"

- alert: CoreDNSLatencyHigh
  expr: |
    histogram_quantile(0.99, sum by (le) (rate(coredns_dns_request_duration_seconds_bucket[5m]))) > 0.1
  for: 10m
  labels: { severity: warning }
```

- Blackbox Exporter 的 `dns` 探测从每个节点定时解析一个外部域名和一个集群内域名，P99 超过 1 秒告警
- 客户端调用耗时直方图加一个「5s 附近」的桶，出现集中落点即提示 DNS 超时

### 2、规范

- 集群级：NodeLocal DNSCache 作为基础组件默认安装；CoreDNS 扩缩容属于变更，走变更流程并观察 conntrack 指标
- 服务模板：默认 `ndots: 2` + `single-request-reopen`；基础镜像统一 glibc 系
- Java 应用统一配置 DNS 缓存 TTL；HTTPS 客户端不要用「域名末尾加点」的写法规避 search，部分客户端会把末尾的点带进 SNI 和 Host 头，导致证书校验失败

### 3、测试

- 预发环境用混沌工具给 CoreDNS 注入丢包或延迟，验证调用方的超时与降级行为，见 [混沌工程](/high-avail/10_chaos_engineering)
- 新集群验收脚本中包含「300 次解析无超过 1 秒」的检查

---

## 七、涉及知识点

| 知识点 | 文章 |
|--------|------|
| ndots 与 search 域 | [DNS · Kubernetes 中的 ndots](/protocols/4_dns#_2、kubernetes-中的-ndots) |
| Java 的 DNS 缓存与负缓存 | [DNS · Java 中的 DNS 缓存](/protocols/4_dns#八、java-中的-dns-缓存) |
| Service 转发、kube-proxy、CoreDNS | [Kubernetes · 集群网络与 DNS](/cloud-native/6_kubernetes#六、集群网络与-dns) |
| 超时设置与重试 | [超时、重试与隔离](/high-avail/4_timeout_retry_bulkhead) |
| 链路追踪定位慢请求 | [链路追踪](/observability/3_tracing) |
| Linux 网络排查命令 | [Linux 概览 · 常用排查命令](/cloud-native/1_linux#七、常用排查命令) |

---

## 小结

- 「恰好慢 5 秒 / 10 秒」是 DNS 解析超时的签名，对应 glibc 默认的 `timeout:5`
- 抓包看同一源端口的 A / AAAA 是否有一个没回应，节点上看 `conntrack -S` 的 `insert_failed`
- `ndots:5` 把外部解析放大成 8 个查询，扩大了冲突面；CoreDNS 副本增多会提高冲突概率
- 止血用 `dnsConfig`（`ndots`、`single-request-reopen`、`timeout`），根治用 NodeLocal DNSCache，应用侧配好 DNS 缓存并复用连接

## 参考资料

- Pod DNS 配置与 dnsConfig：[Kubernetes: DNS for Services and Pods](https://kubernetes.io/docs/concepts/services-networking/dns-pod-service/)
- NodeLocal DNSCache：[Kubernetes: Using NodeLocal DNSCache in Kubernetes Clusters](https://kubernetes.io/docs/tasks/administer-cluster/nodelocaldns/)
- DNS 问题排查：[Kubernetes: Debugging DNS Resolution](https://kubernetes.io/docs/tasks/administer-cluster/dns-debugging-resolution/)
- 解析器选项 ndots / timeout / single-request-reopen：[Linux man-pages: resolv.conf(5)](https://man7.org/linux/man-pages/man5/resolv.conf.5.html)
- conntrack 统计：[conntrack-tools: conntrack(8)](https://conntrack-tools.netfilter.org/conntrack.html)
- CoreDNS 指标：[CoreDNS: prometheus plugin](https://coredns.io/plugins/metrics/)
- Java DNS 缓存属性：[Oracle: Networking Properties](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/net/doc-files/net-properties.html)

> 下一篇：[时钟回拨导致 ID 重复](./17_clock_rollback)
