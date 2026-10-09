---
description: 域名层级、递归与迭代、记录类型、TTL 与缓存、DoH / DoT、DNS 负载均衡、ndots、JVM DNS 缓存
---

# DNS

> **本篇目标**：讲清一个域名从输入到拿到 IP 经过哪些服务器、哪几层缓存，能解释「改了解析为什么迟迟不生效」，并能处理 Kubernetes ndots、JVM DNS 缓存这类后端常见问题。
>
> **前置阅读**：[TCP 与 UDP](./1_tcp_udp)

DNS 把域名翻译成 IP 等记录，是几乎所有网络请求的第一步。本篇以 RFC 1034 / 1035 为基础，传输与安全部分参考 RFC 7766、RFC 7858、RFC 8484；用 DNS 做机房级流量调度属于接入层设计，本篇只讲 DNS 本身能提供什么，架构取舍见 [接入层架构](/high-con/1_access_layer)。

---

## 一、域名层级

域名从右往左逐级细分，每一级由上一级**授权**（delegation）给下一级管理：

| 层级 | 示例 | 由谁管理 |
|------|------|----------|
| 根 | `.`（通常省略不写） | 13 组根服务器（`a.root-servers.net` 到 `m.root-servers.net`），通过任播部署了上千个实例 |
| 顶级域 TLD | `com`、`org`、`cn` | 各注册局，如 `com` 由 Verisign 运营 |
| 二级域 | `example.com` | 域名持有者，在 DNS 服务商处托管权威服务器 |
| 子域 | `www.example.com`、`api.example.com` | 二级域持有者自己添加，或再授权给其他权威服务器 |

- **区（zone）**：一台权威服务器负责的那部分命名空间，例如 `example.com` 区
- **授权**：上级区里放一条 NS 记录，指明「`example.com` 归这几台服务器管」。解析时就是顺着这条授权链一级级往下找

---

## 二、解析过程：递归与迭代

### 1、参与的角色

| 角色 | 做什么 | 例子 |
|------|--------|------|
| 存根解析器（stub resolver） | 应用和操作系统里的解析库，只会把问题丢给递归解析器 | glibc `getaddrinfo`、JVM 的 `InetAddress` |
| 递归解析器（recursive resolver） | 代客户端跑完整个查询过程，并缓存结果 | 运营商 Local DNS、公共 DNS、Kubernetes 中的 CoreDNS |
| 权威服务器（authoritative server） | 保存某个区的真实记录，只回答自己负责的部分 | 根、TLD、域名托管商的 DNS |

### 2、递归查询与迭代查询

![DNS 解析：客户端对解析器递归查询，解析器对各级权威服务器迭代查询](../assets/protocols/dns-resolution.svg)

以首次解析 `www.example.com` 为例：

1. 客户端先查本地缓存（浏览器、操作系统、`/etc/hosts`），没命中就向递归解析器发起查询
2. 解析器缓存也没有，就去问根服务器；根服务器不知道答案，只返回 `com` 的 NS 记录
3. 解析器去问 `com` 的 TLD 服务器，拿到 `example.com` 的 NS 记录
4. 解析器去问 `example.com` 的权威服务器，拿到 `www.example.com` 的 A 记录
5. 解析器按 TTL 缓存每一步的结果，再把答案返回给客户端

| 方式 | 发生在哪一段 | 特点 |
|------|--------------|------|
| 递归查询 | 客户端 → 递归解析器 | 客户端只问一次，要求对方给出最终答案或明确的失败 |
| 迭代查询 | 递归解析器 → 根 / TLD / 权威 | 每一级只回答「下一步该问谁」，由解析器自己追问 |

实际中解析器缓存了 TLD 的 NS 记录，绝大多数查询不需要从根开始，往往一跳就能拿到答案。

---

## 三、记录类型

| 类型 | 作用 | 示例 |
|------|------|------|
| A | 域名 → IPv4 地址 | `www.example.com. A 192.0.2.10` |
| AAAA | 域名 → IPv6 地址 | `www.example.com. AAAA 2001:db8::10` |
| CNAME | 别名，指向另一个域名，解析器继续解析目标 | `www.example.com. CNAME example.cdn-provider.net.` |
| NS | 指明一个区由哪些权威服务器负责 | `example.com. NS ns1.example.com.` |
| MX | 邮件服务器，数字越小优先级越高 | `example.com. MX 10 mail.example.com.` |
| TXT | 任意文本，常用于 SPF、DKIM、域名所有权验证 | `example.com. TXT "v=spf1 include:_spf.example.net ~all"` |
| SOA | 区的元信息：主服务器、序列号、刷新间隔、负缓存时间 | 每个区有且只有一条 |
| SRV | 服务发现：协议、端口、权重 | `_sip._tcp.example.com. SRV 10 60 5060 sip.example.com.` |
| PTR | 反向解析，IP → 域名 | `10.2.0.192.in-addr.arpa. PTR www.example.com.` |
| CAA | 允许哪些 CA 为该域名签发证书 | `example.com. CAA 0 issue "letsencrypt.org"` |

示例中的 `192.0.2.0/24` 和 `2001:db8::/32` 是 RFC 保留的文档专用地址。

**常见坑**：

- CNAME 不能和同名的其他记录共存，所以**区顶点（`example.com` 本身）不能设 CNAME**，因为那里必须有 SOA 和 NS。要把裸域指向 CDN，用服务商提供的 ALIAS / CNAME 拉平功能
- 末尾的点表示完整域名（FQDN）。在区文件里漏写点，`mail.example.com` 会被补成 `mail.example.com.example.com.`

---

## 四、TTL 与多级缓存

### 1、缓存在哪几层

每条记录都带 TTL（秒），表示可以缓存多久。一次解析可能命中下面任何一层：

| 层 | 说明 | 是否遵守记录 TTL |
|----|------|------------------|
| 浏览器 | 浏览器自带的 DNS 缓存 | 有自己的上限，通常较短 |
| JVM | `InetAddress` 内置缓存，见第八节 | **不遵守**，用自己的固定时长 |
| 操作系统 | systemd-resolved、nscd、Windows DNS Client；`/etc/hosts` 优先级最高 | 遵守 |
| 递归解析器 | 运营商 Local DNS、公共 DNS、CoreDNS | 原则上遵守，部分运营商会延长或改写 |
| 权威服务器 | 记录的来源，设定 TTL | — |

### 2、负缓存

「域名不存在」（NXDOMAIN）的结果同样会被缓存，时长取 SOA 记录里的负缓存时间与 SOA 自身 TTL 的较小值（RFC 2308）。所以先访问一个还没配置的域名、再去添加记录，可能要等负缓存过期才能解析到。

### 3、改记录的正确姿势

DNS 变更的生效时间取决于**旧记录的 TTL**，而不是新记录的：

1. 计划变更前，先把记录的 TTL 降到 60 秒左右，并至少等待一个**旧 TTL** 周期，让各级缓存都换成短 TTL
2. 切换记录，观察流量迁移
3. 稳定后再把 TTL 调回较长的值，降低解析压力

即使这样，仍会有少量客户端和运营商不遵守 TTL，所以旧地址要保留一段时间再下线。

---

## 五、传输：UDP、TCP 与加密

### 1、UDP 与 TCP

| 情况 | 传输方式 |
|------|----------|
| 普通查询 | UDP 53 端口，一问一答，无需建连 |
| 响应超过 UDP 报文上限 | 原始规范的上限是 512 字节；EDNS(0)（RFC 6891）允许协商更大的缓冲区，业界推荐 1232 字节以避免 IP 分片。仍放不下时，服务器在响应里置 TC（截断）标志，客户端改用 TCP 重新查询 |
| 区传送（AXFR / IXFR） | 主从权威服务器之间同步整个区，使用 TCP |

RFC 7766 要求所有 DNS 实现都支持 TCP。防火墙只放行 UDP 53 是常见的配置错误，大响应（DNSSEC、记录很多的 TXT）会因此解析失败。

### 2、DoT 与 DoH

传统 DNS 是明文的，沿途任何人都能看到、也能篡改你查询了什么。两种加密方案都只保护**客户端到递归解析器**这一段：

| 方案 | 规范 | 端口 | 特点 |
|------|------|------|------|
| DoT（DNS over TLS） | RFC 7858 | 853 | 专用端口，网络管理员容易识别和管控 |
| DoH（DNS over HTTPS） | RFC 8484 | 443 | 混在普通 HTTPS 流量里，难以单独拦截；浏览器多已内置 |

另有 DNSSEC：权威服务器对记录签名，解析器逐级验证，保证**答案没被篡改**，但不加密。它和 DoT / DoH 解决的是不同问题，可以叠加使用。

---

## 六、基于 DNS 的负载均衡

DNS 在请求真正发出之前就能决定流量去哪里，所以是成本最低的全局调度手段：

| 手段 | 做法 | 局限 |
|------|------|------|
| 多 A 记录轮询 | 一个域名返回多个 IP，解析器或客户端轮换顺序 | 没有健康检查，某个 IP 挂了仍会被返回 |
| 智能解析（GeoDNS） | 按请求来源的地域、运营商返回最近机房的 IP | 权威服务器看到的是递归解析器的地址，用公共 DNS 的用户可能被调度错；EDNS Client Subnet（RFC 7871）可以带上客户端网段改善 |
| GSLB | 智能解析 + 机房健康探测 + 权重，故障时摘除入口 IP | 受各级缓存影响，切换是分钟级 |
| CNAME 接入 CDN | 业务域名 CNAME 到 CDN 的调度域名，由 CDN 的 DNS 选边缘节点 | 多一跳解析 |

DNS 调度的共同弱点是**生效慢、不可精确控制**，适合机房级的粗粒度分流，机房内的分发交给负载均衡。分层设计与 HTTPDNS 见 [接入层架构](/high-con/1_access_layer)，跨地域故障切换见 [多活与容灾](/high-avail/9_multi_active)。

---

## 七、常见问题

### 1、DNS 劫持与污染

| 问题 | 表现 | 应对 |
|------|------|------|
| 运营商 Local DNS 劫持 | 返回广告页或错误的 IP，或者把用户调度到外地机房 | App 使用 HTTPDNS，直接向调度服务要 IP |
| 链路上篡改、缓存投毒 | 伪造的响应被解析器缓存，影响大量用户 | DoT / DoH 保护客户端到解析器这一段，DNSSEC 保证答案真实 |
| 被劫持后的兜底 | — | 全站 HTTPS：即使解析到了假 IP，对方也拿不出合法证书，连接会失败而不是被窃听 |

### 2、Kubernetes 中的 ndots

Pod 默认的 `/etc/resolv.conf` 类似：

```text
nameserver 10.96.0.10
search default.svc.cluster.local svc.cluster.local cluster.local
options ndots:5
```

`ndots:5` 的意思是：**域名里的点少于 5 个，就先依次拼接 search 列表再查询**，都失败了才查原始域名。访问外部域名 `api.example.com`（2 个点）时，实际会先查 `api.example.com.default.svc.cluster.local` 等 3 个不存在的名字，每个还要分别查 A 和 AAAA，一次解析变成 8 次查询，CoreDNS 压力和解析时延都会明显上升。

处理方法：

- 外部域名在配置里写成 FQDN，末尾加点：`api.example.com.`，直接跳过 search 列表
- 在 Pod 的 `dnsConfig` 中把 `ndots` 调小（如 2）；但集群内服务要用完整名称访问，如 `orders.default.svc`
- 部署 NodeLocal DNSCache，在每个节点上缓存，减少跨节点查询和 conntrack 竞争导致的偶发 5 秒解析超时

Kubernetes 集群网络见 [Kubernetes](/cloud-native/6_kubernetes)。

### 3、长连接不感知 DNS 变更

DNS 只在**建立连接时**生效。连接池里的长连接会一直连着旧 IP，即使 DNS 已经切换。所以数据库、Redis、HTTP 连接池都要设置连接的最大存活时间（如 HikariCP 的 `maxLifetime`），让连接定期重建、重新解析，见 [数据库连接池](/database/5_practice/3_connection_pool)。

---

## 八、Java 中的 DNS 缓存

`InetAddress` 的默认实现通过操作系统的 `getaddrinfo` 解析，拿不到记录的 TTL，所以 JVM 用自己的配置决定缓存多久。三个相关的 Java 安全属性（security property）：

| 属性 | 默认值 | 含义 |
|------|--------|------|
| `networkaddress.cache.ttl` | 由实现决定，OpenJDK 在未启用 SecurityManager 时为 30 秒；启用 SecurityManager 时永久缓存 | 解析成功的结果缓存多少秒，`-1` 表示永久 |
| `networkaddress.cache.negative.ttl` | 10 秒 | 解析失败的结果缓存多少秒，`0` 表示不缓存 |
| `networkaddress.cache.stale.ttl` | 未设置，即不使用过期记录 | 记录过期且重新解析失败时，旧结果还能继续使用多少秒，用于 DNS 短暂故障时保持可用；JDK 21 的 API 文档已包含 |

设置方式：

- 修改 `$JAVA_HOME/conf/security/java.security`，对该 JDK 上的所有应用生效
- 用 `-Djava.security.properties=<文件>` 追加一个属性文件，适合容器镜像按应用配置
- 代码中 `Security.setProperty`，**必须在第一次解析之前调用**，缓存策略只读取一次
- 历史上的系统属性 `-Dsun.net.inetaddr.ttl` 仍能起作用，但它不是标准接口，新项目用安全属性

```java
import java.net.InetAddress;
import java.net.UnknownHostException;
import java.security.Security;
import java.util.Arrays;

public class DnsCacheDemo {
    public static void main(String[] args) throws UnknownHostException {
        // 必须在第一次域名解析之前设置
        Security.setProperty("networkaddress.cache.ttl", "60");
        Security.setProperty("networkaddress.cache.negative.ttl", "5");

        InetAddress[] addresses = InetAddress.getAllByName("example.com");
        Arrays.stream(addresses)
                .map(InetAddress::getHostAddress)
                .forEach(System.out::println);
    }
}
```

**常见坑**：

- 老应用开着 SecurityManager 时，解析结果永久缓存，域名切换后必须重启。即使没有开启，30 秒的固定缓存也意味着 JVM 不会遵守你在 DNS 上设的更短 TTL
- 负缓存会放大故障：DNS 抖动期间一次解析失败，会让后续 10 秒内的同名解析都直接失败
- JDK 18 起提供 `InetAddressResolver` SPI（JEP 418），可以替换 JVM 的解析实现，例如接入自研的服务发现或 HTTPDNS；Netty 则有自带的异步 `DnsNameResolver`，不占用 IO 线程

---

## 小结

- 域名按 根 → TLD → 二级域 逐级授权；客户端对递归解析器是递归查询，解析器对各级权威服务器是迭代查询
- 记录示例用文档专用地址；区顶点不能设 CNAME，MX 带优先级，SOA 决定负缓存时间
- 缓存分布在浏览器、JVM、操作系统、递归解析器多层；变更前先把 TTL 降下来，等一个旧 TTL 周期再切换
- 查询默认走 UDP 53，响应被截断时改用 TCP，防火墙要同时放行 TCP 53；DoT / DoH 加密客户端到解析器这一段，DNSSEC 保证答案真实
- DNS 负载均衡适合机房级粗调度，受缓存影响切换慢、无法精确控制
- Kubernetes 默认 `ndots:5` 会放大外部域名查询，用 FQDN 或调小 ndots；连接池要设最大存活时间才能感知 DNS 变更
- JVM 不遵守 DNS 记录的 TTL，用 `networkaddress.cache.*` 安全属性控制，要在首次解析前设置

## 参考资料

- RFC 1034 Domain Names - Concepts and Facilities：[https://www.rfc-editor.org/rfc/rfc1034.html](https://www.rfc-editor.org/rfc/rfc1034.html)
- RFC 1035 Domain Names - Implementation and Specification：[https://www.rfc-editor.org/rfc/rfc1035.html](https://www.rfc-editor.org/rfc/rfc1035.html)
- RFC 2308 Negative Caching of DNS Queries：[https://www.rfc-editor.org/rfc/rfc2308.html](https://www.rfc-editor.org/rfc/rfc2308.html)
- RFC 6891 Extension Mechanisms for DNS (EDNS(0))：[https://www.rfc-editor.org/rfc/rfc6891.html](https://www.rfc-editor.org/rfc/rfc6891.html)
- RFC 7766 DNS Transport over TCP：[https://www.rfc-editor.org/rfc/rfc7766.html](https://www.rfc-editor.org/rfc/rfc7766.html)
- RFC 7858 DNS over TLS：[https://www.rfc-editor.org/rfc/rfc7858.html](https://www.rfc-editor.org/rfc/rfc7858.html)
- RFC 8484 DNS Queries over HTTPS：[https://www.rfc-editor.org/rfc/rfc8484.html](https://www.rfc-editor.org/rfc/rfc8484.html)
- RFC 7871 Client Subnet in DNS Queries：[https://www.rfc-editor.org/rfc/rfc7871.html](https://www.rfc-editor.org/rfc/rfc7871.html)
- JDK 21 InetAddress（Inet Address Caching）：[https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/net/InetAddress.html](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/net/InetAddress.html)
- JEP 418 Internet-Address Resolution SPI：[https://openjdk.org/jeps/418](https://openjdk.org/jeps/418)
- Kubernetes DNS for Services and Pods：[https://kubernetes.io/docs/concepts/services-networking/dns-pod-service/](https://kubernetes.io/docs/concepts/services-networking/dns-pod-service/)
- Kubernetes NodeLocal DNSCache：[https://kubernetes.io/docs/tasks/administer-cluster/nodelocaldns/](https://kubernetes.io/docs/tasks/administer-cluster/nodelocaldns/)

> 下一篇：[RPC 协议](./5_rpc_protocols) —— Protobuf 编码、gRPC 帧格式与四种调用、截止时间与状态码、Thrift、SOAP。
