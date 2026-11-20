---
description: 连接风暴的成因、设备退避与抖动、负载均衡、EMQX 限速与抖动检测、内核调优、认证与会话恢复、容量规划与演练
---

# 海量连接与连接风暴

> 前置阅读：[EMQX 许可与部署](../1_basics/3_emqx_deploy)、[MQTT 客户端](./3_mqtt_client)、[设备安全](./1_security)

Broker 重启、网络割接、片区停电后来电，几十万台设备会在同一分钟里重连，认证后端、Broker、会话恢复依次被打垮。本篇沿「设备、负载均衡、Broker、认证、会话」这条链讲每一层的保护手段，再讲容量怎么估、风暴怎么演练，基线为 JDK 21、EMQX 6.x。

---

## 一、风暴是怎么形成的

| 触发 | 特点 |
|------|------|
| Broker 重启、节点宕机 | 该节点上的全部连接在几秒内断开，同时重连 |
| 网络割接、运营商故障 | 恢复的瞬间整片区域同时重连 |
| 停电后来电、批量出厂上电 | 设备同时冷启动，还要叠加首次注册 |
| 令牌或证书同时到期 | 同一批签发的凭据同一时刻失效，见 [设备安全 · 零信任措施](./1_security#_2、零信任措施) |

真正把系统压垮的是**放大**：认证服务变慢 → 设备等不到 CONNACK 超时 → 设备重试 → 认证请求更多 → 更慢。所以保护要在链上每一层做，任何一层只是「扛住」都不够，必须让请求**在越靠前的地方被摊平或拒绝**。

![连接风暴沿途的保护点](../../assets/iot/connection-storm-chain.svg)

---

## 二、设备侧：退避与抖动

这是唯一能从源头把峰值摊平的一层，主流平台都把它当成设备的必备行为：

- **AWS IoT Device Advisor** 把它做成了认证测试项：不回 CONNACK 时设备要按抖动退避重连至少五次，服务端断开后、连接不稳定时也各有一项；固定间隔或线性退避直接判失败，只有指数没有抖动的判「通过但有警告」，官方建议按 AWS 架构博客的 Exponential Backoff And Jitter 实现
- **AWS IoT Core** 对同一个 clientId 每秒只接受 1 次 CONNECT（不可调），整个账户默认每秒 3,000 次（可申请调高）：托管平台本身就限速，不退避的设备只会被一次次拒绝
- **Azure DPS** 建议不要每次重启都重新预配，失败重试用「带随机化的指数退避」，429 按 `Retry-After` 等待

退避的形状：等待时间 = 在 `[0, min(上限, 基数 × 2^失败次数)]` 里随机取，即 AWS 博客里的 Full Jitter；纯指数退避只是让所有设备整齐地一起等、一起连。HiveMQ Java 客户端的自动重连默认从 1 秒开始翻倍、上限 120 秒，再叠加正负 25% 的随机量；Paho v5 的自动重连没有随机量，两者的细节见 [MQTT 客户端 · 建连](./3_mqtt_client#_2、建连-tls、自动重连、持久会话、遗嘱)。需要全抖动时，用断开监听器自己算：

```java
/** Full Jitter：在 [0, min(cap, base × 2^n)] 中均匀取值 */
static long backoffMillis(int failedAttempts) {
    long cap = Duration.ofMinutes(5).toMillis();
    long ceiling = Math.min(cap, 1_000L << Math.min(failedAttempts, 20));
    return ThreadLocalRandom.current().nextLong(ceiling + 1);
}

Mqtt5AsyncClient client = Mqtt5Client.builder()
        .identifier(deviceId)
        .serverHost(host).serverPort(8883).sslWithDefaultConfig()
        // 不再调用 automaticReconnect()，重连完全由这个监听器决定
        .addDisconnectedListener(ctx -> ctx.getReconnector()
                .reconnect(true)
                .delay(backoffMillis(ctx.getReconnector().getAttempts()), TimeUnit.MILLISECONDS))
        .buildAsync();

// 冷启动先随机等 0～60 秒再首连，停电来电时不会整片同时连
Thread.sleep(ThreadLocalRandom.current().nextLong(60_000));
client.connect();
```

还要看 MQTT 5 CONNACK 的原因码区别对待：`0x89` 服务端忙、`0x9F` 建连速率超限、`0x97` 配额超限说明服务端在限流，退避要更长；`0x86` 用户名或密码错误、`0x87` 未授权、`0x8A` 被封禁说明凭据有问题，重试不会成功，应长时间等待并上报；`0x9C` 换用其他服务器、`0x9D` 服务器已迁移会带上 Server Reference，按它指向的地址重连。

---

## 三、负载均衡

部署样例见 [EMQX 许可与部署 · 三节点集群](../1_basics/3_emqx_deploy#五、三节点集群-需-license)，这里只说和风暴有关的几点：

- **TLS 在哪里终结**：EMQX 官方建议在负载均衡上终结 TLS，握手的 CPU 不落在 Broker 上；代价是 EMQX 拿不到客户端证书的 SAN，PROXY protocol v2 只能转发 CN、Subject 等部分字段。用证书 SAN 做身份时只能透传 TLS，让 EMQX 自己握手
- **PROXY protocol**：负载均衡开启后，EMQX 对应监听器也要设 `proxy_protocol = true`，否则限速、抖动检测、黑名单看到的都是负载均衡的 IP，按 IP 的防护全部失效
- **DNS 轮询不要用在生产**：EMQX 文档明确不建议，节点宕机后摘不掉，客户端还会按缓存的地址去连
- **长连接不会自己再均衡**：扩容后已有连接不会迁到新节点，新节点只接到之后的新连接；要主动再均衡，见第十节

---

## 四、Broker：限速与防护

### 1、建连与消息限速

EMQX 的限速分两级，速率写成 `次数/时间`，如 `"1000/s"`、`"10000/60m"`：

| 级别 | 配置 | 限什么 | 超限后 |
|------|------|--------|--------|
| 监听器 | `listeners.<类型>.<名字>.max_conn_rate` / `max_conn_burst` | 这个监听器每秒接受的新连接 | 暂停接收新连接 |
| 监听器 | `messages_rate`、`bytes_rate`（及对应 `_burst`） | 每个客户端发布的消息数、字节数 | 暂停读取这个客户端的数据 |
| 监听器 | `subscribes_rate` / `subscribes_burst` | 每个客户端的 SUBSCRIBE 报文 | 不处理，SUBACK 返回失败码，连接保留 |
| 节点 | `mqtt.limiter.max_conn_rate` / `max_conn_burst` | 整个节点每秒接受的新连接 | 暂停处理 Accept 队列，新连接被延迟或拒绝 |

```hocon
listeners.ssl.default {
  bind = "0.0.0.0:8883"
  max_connections = 1024000
  max_conn_rate = "2000/s"         # 按认证服务能扛的速率定，不是按 Broker 能扛的
  messages_rate = "100/s"
}
```

`max_conn_rate` 的取值依据是**链上最慢的一环**，通常是认证服务：它每秒能处理多少次认证，Broker 就只放进来多少。超出的连接在 TCP 层排队或失败，设备按退避再来，峰值被摊到更长的时间里。

### 2、抖动检测与黑名单

- **抖动检测（flapping detect）**：一个时间窗内连接次数超过阈值的客户端被临时封禁。6.3 起可以分别按 clientid、用户名、来源 IP 检测（`flapping_detect.by_clientid` 等，各有 `window_time`、`max_count`、`ban_time`，Dashboard 的默认值是 1 分钟、15 次、5 分钟），旧的平铺写法只作用于 clientid；默认关闭。被封禁的连接在**认证之前**就被拒，不会打到认证服务；已有的连接不受影响
- **黑名单（banned）**：按 clientid、用户名、IP 及其正则或网段手工封禁，`POST /api/v5/banned`。官方定位是只适合少量条目，大批设备的准入仍然靠认证；用法见 [设备注册与生命周期 · 禁用要做三件事](./2_provisioning#_2、禁用要做三件事)

---

## 五、内核与 Erlang VM

EMQX 官方性能调优文档给出的数值如下（另外要关闭 swap 与透明大页，取值以官方文档为准，按机器规格调整）：

| 层 | 参数 | 官方取值 |
|----|------|---------|
| 文件句柄 | `fs.file-max`、`fs.nr_open`、`ulimit -n`、systemd 的 `LimitNOFILE` | 2097152 |
| 连接队列 | `net.core.somaxconn` / `net.ipv4.tcp_max_syn_backlog` / `net.core.netdev_max_backlog` | 32768 / 16384 / 16384 |
| 端口与连接跟踪 | `net.ipv4.ip_local_port_range`、`net.netfilter.nf_conntrack_max` | `1024 65535`、1000000 |
| TIME-WAIT | `net.ipv4.tcp_max_tw_buckets`、`net.ipv4.tcp_fin_timeout` | 1048576、15；不建议开 `tcp_tw_recycle` / `tcp_tw_reuse`，NAT 后会重置连接 |
| Erlang VM | `node.max_ports` | 默认 `auto` 按 CPU 数推算，高并发时可显式设为 2097152；进程上限是它的 2 倍 |
| 监听器 | `acceptors`、`max_connections` | 示例为 64、1024000 |

容器部署时最容易漏的是文件句柄：Docker 默认软限制 1024，每条连接占一个，Conduit 实测约 1,000 台设备就让 EMQX 反复崩溃，见 [EMQX 许可与部署 · 单节点部署](../1_basics/3_emqx_deploy#三、单节点部署)。`nf_conntrack` 表满时内核直接丢新连接的 SYN，表现为设备连不上、Broker 却毫无日志，开了防火墙或 Docker 桥接网络的机器要一起调。

---

## 六、认证后端：第一个被打满的地方

风暴里每一次 CONNECT 都要认证一次，认证服务是整条链上最先饱和的：

- **连接池与超时**：EMQX HTTP 认证器默认 8 条长连接（`pool_size`）、每条最多 100 个在途请求（`enable_pipelining`），`request_timeout` 决定设备多久被判失败。Conduit 把超时从 5 秒放宽到 10 秒，起因是一次虚拟化层丢包让 TCP 重传超过了 5 秒；还遇到过 Tomcat 先关掉空闲连接、EMQX 复用到半关的连接导致偶发拒绝，修法是把 Tomcat 的 keep-alive 调长，见 [压测与瓶颈排查 · 鉴权超时](../4_practice/10_capacity#十一、鉴权超时-不是应用问题) 与 [拆分部署与设备数阶梯](../4_practice/10_capacity#十、拆分部署与设备数阶梯)
- **不查库、不用慢哈希**：身份放缓存（Conduit 是 Redis，5 分钟过期，状态变更时主动清除），密钥是高熵随机串时用 SHA-256 加盐而不是 bcrypt，见 [设备接入与鉴权 · 设备凭据](../4_practice/1_access#三、设备凭据-生成与哈希) 与 [身份缓存](../4_practice/1_access#五、身份缓存)。EMQX 自带的外部资源缓存只覆盖 MySQL、MongoDB、Redis 这类外部数据源（节点级、默认 1 分钟过期），HTTP 认证的结果它的文档没有说缓存，缓存要在认证服务自己做
- **扛不住时快速失败**：认证服务过载时尽快返回错误，而不是让请求挂到超时。EMQX 收到 4xx / 5xx 视为 `ignore`、继续走认证链，全部没有结果就拒绝连接；快速拒绝的设备进入退避，挂到超时的请求却一直占着连接池

---

## 七、会话恢复与离线消息

设备重连时，持久会话（Clean Start 为 false、会话过期时间大于 0）要恢复订阅、补投离线期间积压的消息，这是风暴里的第二个重负载：

- **持久会话的数量就是内存**：`emqx_sessions_count` 包含客户端已断开、会话还没过期的会话。会话过期时间按「最长的预期断线时长」定，只上报、不收下行的设备干脆用 Clean Start 为 true，不留会话
- **离线队列要设上限**：每个会话积压的消息在重连瞬间集中补投。Conduit 实测平台订阅者的会话队列（上限 10 万条）填满时，会话进程堆到约 513 MB 被杀；磁盘持久会话还出现过积压下投递静默停止，取舍与参数见 [可靠上报与接入层主备 · EMQX 会话怎么选](../4_practice/3_reliable_uplink#五、emqx-会话怎么选) 与 [压测与瓶颈排查](../4_practice/10_capacity)
- **订阅随会话恢复**：持久会话下设备不必重新订阅；会话过期了设备要能识别 CONNACK 里的 Session Present 为 0 并重新订阅，Device Advisor 也有这两项测试

---

## 八、观测

EMQX 官方「Broker 健康指标」里与风暴最相关的 Prometheus 指标：在线连接数 `emqx_live_connections_count`；建连速率 `rate(emqx_packets_connect[1m])`；被拒的连接 `rate(emqx_packets_connack_error[1m])`，大部分认证失败落在这里；认证 `emqx_authentication_failure`、按认证器的 `emqx_authn_failed` 与 `emqx_authn_latency`；过载保护拒绝的新连接 `emqx_overload_protection_new_conn`；调度器排队 `emqx_vm_run_queue`，持续不为 0 说明 CPU 饱和；会话数 `emqx_sessions_count`；黑名单条目 `emqx_banned_count`。

认证服务自己还要有按原因计数的拒绝指标与延迟分位数，做法见 [设备接入与鉴权 · 拒绝原因](../4_practice/1_access#六、拒绝原因-让「连不上」看得见)。6.3 起抓取这些端点默认需要 API Key 认证。

---

## 九、容量规划的口径

单节点能撑多少连接，由四样东西决定，每一样都只能按自己的负载实测：

| 因素 | 能参考的数字 |
|------|-------------|
| 每条连接的内存 | EMQX 官方 2023 年的单节点测试：5.0.21、64 核 128 GB，500 万连接、建连速率每秒 5,000，内存平均 48.7 GB（按此折算约每条 10 KB）；该测试不认证、保活 300 秒、Clean Session、不发消息 |
| 消息吞吐 | Conduit 实测：每台设备一条连接、每条消息单独一次往返时，EMQX 每条消息约 0.9 ms CPU，是少量连接批量发送时的数倍，见 [压测与瓶颈排查 · 设备数阶梯](../4_practice/10_capacity#十、拆分部署与设备数阶梯) |
| TLS 握手 | 没有通用数字：取决于算法（ECDSA 比 RSA 便宜）、会话复用率和是否在负载均衡终结 |
| 会话与离线队列 | 持久会话数 × 队列上限 × 消息大小，见第七节 |

两组数字差别很大：官方测的是只连不发，Conduit 在每台每 10 秒一条的负载下，EMQX 内存约每万台 0.6～0.7 GB，且两台 8 vCPU 虚拟机上每秒一条时 5,000 台通过、6,000 台起掉线（瓶颈是虚拟机的内核收包）。结论是：**连接数本身就是成本，不能拿消息吞吐按「条/秒 ÷ 每台频率」换算设备数**；规划时用自己的设备频率、载荷、TLS 方式做阶梯压测，在首个不合格的档位以下留足余量做水位线。

---

## 十、演练：压测与灰度重启

### 1、压测连接风暴

- **工具**：EMQX 官方的 emqtt-bench（Erlang，Apache-2.0，支持 MQTT 5），`conn` 子命令只建连不发消息：`-c` 连接总数、`-R` 每秒建连数、`-i` 建连间隔、`-k` 保活、`-S` 走 TLS、`--ifaddr` 绑定本机网卡地址。单个源 IP 能用的本地端口约 6 万，几十万连接要多台发压机或多个源地址
- **制造风暴**：连满之后执行 `emqx ctl listeners restart ssl:default`，官方文档写明重启监听器会断开它上面的全部客户端，正好模拟一次集中重连；观察建连速率、CONNACK 错误、认证延迟多久回落
- **判据**：所有设备在可接受的时间内重新连上、认证服务没有超时、没有设备被误封；Conduit 的阶梯压测判据（守恒、掉线、p99、积压）可以直接借用，见 [压测与瓶颈排查 · 压测方法](../4_practice/10_capacity#二、压测方法)

### 2、灰度重启与节点疏散

集群逐台升级时，不要直接停节点，用 EMQX 的**节点疏散**（evacuation）把连接按速率迁走：

```bash
# 被疏散的节点停止接收新连接，等负载均衡把它摘掉，再按速率断开现有客户端、迁移会话
emqx ctl rebalance start --evacuation \
  --wait-health-check 60 \
  --conn-evict-rate 500 \
  --sess-evict-rate 500 \
  --wait-takeover 60 \
  --migrate-to "emqx@node2.emqx.local emqx@node3.emqx.local"
emqx ctl rebalance status
```

上面的数值都是官方默认值：等待健康检查 60 秒、每秒断开 500 个连接、等待接管 60 秒、每秒迁移 500 个会话；MQTT 5 客户端还可以用 `--redirect-to` 告诉它去连哪台。升级完成、节点回到集群后，已有连接不会自动回流，用不带 `--evacuation` 的 `emqx ctl rebalance start --nodes …` 按阈值把连接再均衡过去。疏散与再均衡是集群功能，集群本身需要 License，见 [EMQX 许可与部署](../1_basics/3_emqx_deploy)。单节点部署做不了疏散，重启就是一次完整的风暴，只能靠设备退避和 `max_conn_rate` 摊平。

---

## 十一、各层措施速查

| 层 | 措施 | 不做的后果 |
|----|------|-----------|
| 设备 | 指数退避加全抖动、退避上限、冷启动随机延迟、按 CONNACK 原因码区别重试 | 全网设备同一时刻重连，峰值远高于平时 |
| 负载均衡 | 四层转发、PROXY protocol、空闲超时大于 1.5 倍保活、TLS 终结位置想清楚 | 按 IP 的防护失效；空闲设备被周期性断开 |
| Broker | 监听器与节点的 `max_conn_rate`、抖动检测、黑名单 | 认证服务被瞬时流量打满；坏设备无休止重连 |
| 内核与 VM | 文件句柄、连接队列、conntrack、`node.max_ports` | 连接数到某个整数就上不去，或 Broker 崩溃 |
| 认证 | 连接池与超时、身份缓存、快哈希、过载时快速失败 | 超时引发重试，重试放大流量 |
| 会话 | 会话过期时间、离线队列上限、只上报的设备不留会话 | 重连瞬间集中补投，内存打满 |
| 观测与演练 | 建连速率、CONNACK 错误、认证延迟；定期用重启监听器演练；集群逐台疏散 | 风暴来了才发现哪一层先倒 |

---

## 十二、常见坑

- **固定间隔重连**：所有设备每 5 秒连一次，风暴永远平息不了
- **只有指数没有抖动**：同一时刻掉线的设备，在同一时刻重试
- **`max_conn_rate` 按 Broker 能力定**：Broker 放进来的速率超过认证服务的处理能力，限速等于没设
- **负载均衡没开 PROXY protocol**：抖动检测按 IP 封禁时封掉的是负载均衡自己

---

## 小结

- 连接风暴的危险在放大：认证变慢 → 设备超时重试 → 认证更慢，保护要在链上每一层做，越靠前越好
- 设备侧的指数退避加随机抖动是唯一能从源头摊平峰值的手段，AWS Device Advisor 把它列为测试项，固定或线性退避直接不通过
- Broker 用 `max_conn_rate` 按认证服务的能力限建连速率，用抖动检测把反复重连的设备挡在认证之前；内核与 Erlang VM 参数照官方调优文档设
- 认证是第一个被打满的地方：连接池、合理超时、身份缓存、快哈希，过载时快速失败；会话恢复是第二个，持久会话数与离线队列都要设上限
- 容量只能按自己的负载实测，连接数本身就是成本；演练用重启监听器制造风暴，集群升级用节点疏散，回来后再均衡

## 参考资料

- AWS IoT Device Advisor · MQTT test cases：[https://docs.aws.amazon.com/iot/latest/developerguide/device-advisor-tests-mqtt.html](https://docs.aws.amazon.com/iot/latest/developerguide/device-advisor-tests-mqtt.html)
- AWS Architecture Blog · Exponential Backoff And Jitter：[https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/](https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/)
- AWS IoT Core endpoints and quotas：[https://docs.aws.amazon.com/general/latest/gr/iot-core.html](https://docs.aws.amazon.com/general/latest/gr/iot-core.html)
- Azure DPS · Device lifecycle and reprovisioning（重试建议）：[https://learn.microsoft.com/en-us/azure/iot-dps/concepts-device-reprovision](https://learn.microsoft.com/en-us/azure/iot-dps/concepts-device-reprovision)
- HiveMQ MQTT Client · MqttClientAutoReconnect 源码：[https://github.com/hivemq/hivemq-mqtt-client/blob/master/src/main/java/com/hivemq/client/mqtt/lifecycle/MqttClientAutoReconnect.java](https://github.com/hivemq/hivemq-mqtt-client/blob/master/src/main/java/com/hivemq/client/mqtt/lifecycle/MqttClientAutoReconnect.java)
- MQTT Version 5.0 · CONNACK Reason Code：[https://docs.oasis-open.org/mqtt/mqtt/v5.0/mqtt-v5.0.html](https://docs.oasis-open.org/mqtt/mqtt/v5.0/mqtt-v5.0.html)
- EMQX · Load Balancer：[https://docs.emqx.com/en/emqx/latest/guides/cluster/lb.html](https://docs.emqx.com/en/emqx/latest/guides/cluster/lb.html)
- EMQX · Rate Limit：[https://docs.emqx.com/en/emqx/latest/rate-limit/rate-limit.html](https://docs.emqx.com/en/emqx/latest/rate-limit/rate-limit.html)
- EMQX · Flapping Detect：[https://docs.emqx.com/en/emqx/latest/access-control/flapping-detect.html](https://docs.emqx.com/en/emqx/latest/access-control/flapping-detect.html)
- EMQX · Banned Clients：[https://docs.emqx.com/en/emqx/latest/access-control/blacklist.html](https://docs.emqx.com/en/emqx/latest/access-control/blacklist.html)
- EMQX · Performance Tuning（Linux）：[https://docs.emqx.com/en/emqx/latest/performance/tune.html](https://docs.emqx.com/en/emqx/latest/performance/tune.html)
- EMQX · HTTP 认证：[https://docs.emqx.com/en/emqx/latest/access-control/authn/http.html](https://docs.emqx.com/en/emqx/latest/access-control/authn/http.html)
- EMQX · Authentication（External Resource Cache）：[https://docs.emqx.com/en/emqx/latest/access-control/authn/authn.html](https://docs.emqx.com/en/emqx/latest/access-control/authn/authn.html)
- EMQX · Broker Health Indicators：[https://docs.emqx.com/en/emqx/latest/observability/broker-health-indicators.html](https://docs.emqx.com/en/emqx/latest/observability/broker-health-indicators.html)
- EMQX · Prometheus：[https://docs.emqx.com/en/emqx/latest/observability/prometheus.html](https://docs.emqx.com/en/emqx/latest/observability/prometheus.html)
- EMQX · Node Evacuation and Cluster Load Rebalancing：[https://docs.emqx.com/en/emqx/latest/guides/cluster/rebalancing.html](https://docs.emqx.com/en/emqx/latest/guides/cluster/rebalancing.html)
- EMQX · Command Line Interface：[https://docs.emqx.com/en/emqx/latest/admin/cli.html](https://docs.emqx.com/en/emqx/latest/admin/cli.html)
- EMQX Blog · EMQX single node supports 5M connections：[https://www.emqx.com/en/blog/emqx-single-node-supports-5m-connections](https://www.emqx.com/en/blog/emqx-single-node-supports-5m-connections)
- emqtt-bench：[https://github.com/emqx/emqtt-bench](https://github.com/emqx/emqtt-bench)
- EMQX · Benchmark with eMQTT-Bench：[https://docs.emqx.com/en/emqx/latest/performance/benchmark-emqtt-bench.html](https://docs.emqx.com/en/emqx/latest/performance/benchmark-emqtt-bench.html)

> 下一篇：[物模型](../3_platform/1_thing_model)
