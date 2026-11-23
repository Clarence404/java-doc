---
description: 不丢的两档定义、设备留副本等回执、写入总线后才确认、EMQX 内存持久会话、Redis 锁选主、共享订阅
---

# 可靠上报与接入层主备

> 前置阅读：[设备接入与鉴权](./1_access)、[通信协议](../1_basics/1_protocol)、[分布式锁](/distributed/4_lock)

设备收到 PUBACK 不等于数据已经进了平台：Broker 可能在把消息交给下一跳之前崩溃。本篇讲 Conduit 怎么定义「不丢」、设备侧的回执与重发、transport 的确认顺序、EMQX 会话选择、Redis 锁单活多备与共享订阅，基线为 JDK 21、Spring Boot 3.5。

---

## 一、「不丢」指的是什么

先把话说准。Conduit 对上报数据的承诺分两档，区别只在报文顶层有没有 `id`：

| 设备 | 保证 | 哪些情况会丢 |
|------|------|-------------|
| 带 `id`（可靠上报，V0.2-R2） | 端到端：设备收到**平台业务回执**之前保留本地副本，超时原样重发 | 设备自己断电且待确认队列没有落盘 |
| 不带 `id` | 逐跳 QoS 1：每一跳收妥后才向上一跳确认 | EMQX 进程重启或崩溃、会话队列溢出（有计数） |

「逐跳」指链路上的四跳各自守住「下一跳收妥前不松手」：

| 跳 | 谁在等确认 | 确认点 |
|----|-----------|--------|
| 设备 → EMQX | 设备等 PUBACK | EMQX 收到（**不代表落盘**） |
| EMQX → transport | EMQX 等订阅端的 PUBACK | transport 把消息写进 Redis Streams 成功 |
| transport → Redis | transport 等 `XADD` 返回 | Redis 已刷盘（`appendfsync always`） |
| Redis → server | 消费组等 `XACK` | 写入 InfluxDB 与最新值都成功，见 [数据流水线](./4_pipeline) |

后三跳都在平台自己手里，e2e 验证过杀 server、杀 transport 都不丢。**唯一守不住的是第一跳**：PUBACK 由 EMQX 发出，而 EMQX 把消息交给 transport 之前如果被强杀，这条已确认的消息就没了。所以端到端的兜底只能交给设备，这是 V0.2-R2 做的事。

![可靠上报的确认链路与主备接管](../../assets/iot/conduit-reliable-uplink.svg)

MQTT QoS 与会话的通用原理见 [通信协议](../1_basics/1_protocol)，客户端侧的写法见 [MQTT 客户端](../2_access/3_mqtt_client)，这里只讲 Conduit 的取舍。

---

## 二、为什么 PUBACK 不够

这不是推理出来的，是 2026-10-19 用独立的测试容器实测出来的（[持久性验证](https://github.com/Clarence404/conduit-iot/blob/811e441/docs/durability-validation.md)）。做法：订阅端先建好持久会话后离线，发布端发 500 条 QoS 1 并逐条等到 PUBACK，然后注入故障，恢复后看订阅端能取回多少。当时 EMQX 5.10.5 还开着磁盘持久会话。

| 故障 | 轮次 | 500 条中未取回 | 会话恢复 |
|------|-----|---------------|---------|
| 强杀 EMQX 进程 | 1 | 15 | 是 |
| 强杀 EMQX 进程 | 2 | 124 | 是 |
| 强杀 EMQX 进程 | 3 | 0 | 是 |
| 客户机强制重启 | 1 | 0 | 是 |
| 客户机强制重启 | 2 | 500 | 否 |
| 客户机强制重启 | 3 | 500 | 否 |

丢的都是尾部、且都已经 PUBACK。报告里对照了 EMQX `e5.10.5` 标签的源码：持久消息以 `sync => false` 提交，经 `gen_server:cast` 异步排队，默认 100 毫秒刷新一次，底层 RocksDB 的写选项为空。也就是说 PUBACK 发出时消息还在内存缓冲里，把刷新间隔调小也消不掉「异步排队」和「底层刷盘」这两道边界。

同一轮实验还顺带定了 Redis 的刷盘策略：客户机强制重启时，`appendfsync everysec` 三轮分别丢 99、100、100 条已确认的写入，`always` 三轮都是 0。代价是单连接 `XADD` 吞吐从 27,855 条/秒降到 5,643 条/秒，Conduit 选了 `always`，因为 transport 正是拿 `XADD` 的返回当作「可以向上一跳确认」的依据。

结论只有一条路：**第一跳绕不开、调参也救不了，那就让设备在收到平台回执前不删本地副本**。此后平台内部任何一环崩溃，设备重发即可。

---

## 三、设备侧：留副本、等回执、原样重发

### 1、协议契约

上行报文不变，只是把原来「可选、仅用于追踪」的 `id` 改成了开关：

```json
{ "id": "dev01-000123", "ts": 1760400000000, "params": { "Ua": 220.1 } }
```

| 字段 | 规则 |
|------|------|
| `id` | 字符串，1～128 个字符，同一设备内唯一，建议「设备标识 + 单调序号」；带上即启用可靠上报 |
| `ts` | 带 `id` 时必填，重发时保持不变 |

`ts` 必填是重发不产生重复点的前提：时序库按「同设备、同时间戳」覆盖，缺 `ts` 时平台用接收时间，重发一次就多一个点。缺 `ts` 时平台照常回执，只记一行 WARN（同一设备每分钟最多一行），不拒绝也不进死信，因为拒绝只会让设备无限重发。

回执：

| 项 | 取值 |
|----|------|
| 主题 | `conduit/{productKey}/{deviceKey}/down/ack` |
| 内容 | `{"id": "<上行的 id>", "ts": <平台接收时间毫秒>}` |
| QoS | 0 |
| 粒度 | 一条上行一条回执，不合并 |

- **为什么是 QoS 0**：回执丢了的后果只是设备重发，而重发是安全的；用 QoS 1 的话设备离线期间 EMQX 会替它攒一堆回执，这些数据设备上线后本来就要重发
- **回执表示「平台已持久接收」，不表示「已入库」**：确认点是写入 Redis 总线成功，物模型校验在之后的流水线里做；校验不合格的测点照样被剔除并留死信记录，重发改变不了结果。等写完 InfluxDB 再回执会把链路拉长，而 Redis 之后的重试本来就由流水线保证
- **ACL 不用改**：设备已有的订阅权限 `conduit/+/{deviceKey}/down/#` 覆盖回执主题

### 2、参考实现：模拟器的待确认队列

`conduit-simulator` 既是演示设备，也是设备开发者的参考实现。核心是每台设备一个 [`PendingReportQueue`](https://github.com/Clarence404/conduit-iot/blob/811e441/conduit-simulator/src/main/java/dev/conduit/simulator/PendingReportQueue.java)：

```java
synchronized boolean offer(String id, String topic, byte[] payload, long sentAt) {
    if (reports.size() >= capacity || reports.containsKey(id)) {
        return false;                       // 满了就不收：上游暂停产生新数据，不丢旧的
    }
    reports.put(id, new PendingReport(id, topic, payload, sentAt));
    return true;
}

synchronized boolean acknowledge(String id) {
    return reports.remove(id) != null;      // 回执按 id 出队，乱序到达也对
}

synchronized List<PendingReport> claimExpired(long now, Duration timeout) {
    // 领取所有超时消息用于重发，同时把发送时间推进到 now，防止并发重复重发
}
```

- **payload 入队后只读**：重发的 `id`、`ts`、测点值与第一次完全相同
- **超时 30 秒重发**（`SIM_ACK_TIMEOUT_MS`），**队列上限 1000**（`SIM_MAX_PENDING`）
- **满了背压而不是丢弃**：暂停产生新数据，不删最旧的

::: warning 模拟器的队列只在内存
它用来验证平台侧。真实设备必须把待确认队列写进本地存储，先落盘再发送，否则设备自己断电照样丢数据。
:::

---

## 四、transport：写入总线成功后才确认

transport 用 HiveMQ MQTT Client 的手动确认。收到的消息先攒成微批（微批的参数留给 [数据流水线](./4_pipeline)），提交时的顺序是这一篇的重点，见 [`MqttProtocolAdapter#flush`](https://github.com/Clarence404/conduit-iot/blob/811e441/conduit-transport/src/main/java/dev/conduit/transport/mqtt/MqttProtocolAdapter.java)：

```java
private void flush(Session s) {
    List<Pending> batch = List.copyOf(s.pending);
    s.pending.clear();
    List<PublishResult> results = publishAllWithRetry(s, batch);   // 反复提交到全部写入总线
    if (results == null) {
        return;                                                    // 会话停止：一条都不 ACK
    }
    for (int i = 0; i < batch.size(); i++) {
        Pending p = batch.get(i);
        if (p.topic().type() == MessageType.PROPERTY) {
            sendReliableAck(s, p.topic(), p.message());            // 先发业务回执
        }
        acknowledge(p.publish());                                  // 再向 EMQX 确认
    }
}
```

- **顺序固定为「XADD 成功 → 业务回执 → PUBACK」**：任何一步之前崩溃，EMQX 那边这条消息都还是未确认，新连接上来会重投
- **失败的条目原地阻塞重试，不跳过**：EMQX 的 `mqtt.retry_interval` 默认是 `infinity`，已投递未确认的消息不会重传，只在客户端重连时才重投；一条失败后放着不管，就永久占住一个在途槽位，攒满窗口后 EMQX 不再投递，整条接入链路停摆。重试按 1 秒起翻倍、30 秒封顶
- **每轮只重新提交还没成功的条目**：Redis 管道不是原子的，一批里可以部分成功，逐条区分才不会把已写入的重复写一遍
- **回执失败只记 WARN**：不重试、不影响 PUBACK，设备收不到自然会重发
- **确认失败不当作总线失败**：消息已在总线里，重复投递交给 Broker 的至少一次语义

回执只对上行数据发（`MessageType.PROPERTY`），EMQX 的上下线事件不回执。要不要回执由 [`ReliableUplink#extract`](https://github.com/Clarence404/conduit-iot/blob/811e441/conduit-transport/src/main/java/dev/conduit/transport/mqtt/ReliableUplink.java) 决定：用流式解析只看顶层的 `id` 与 `ts`，其余字段直接跳过；不是 JSON 对象、`id` 不是 1～128 个字符的字符串、载荷超过 64 KB，都当作没带 `id`。这样 transport 不必知道产品用哪种解码器，仍然只是「搬运」。

---

## 五、EMQX 会话怎么选

transport 离线（重启、主备切换）期间，设备还在上报，这些消息要有地方排队。MQTT 的做法是订阅端用持久会话：`cleanStart=false` 加一个会话过期时间，Broker 按 clientId 替离线的订阅端攒消息。

| 配置 | 值 | 在哪 |
|------|----|------|
| `cleanStart` | `false` | transport 连接参数 |
| 会话过期 | 86400 秒（`session-expiry-seconds`） | transport 连接参数 |
| `durable_sessions.enable` | `false`（磁盘持久会话关闭） | EMQX |
| `mqtt.max_mqueue_len` | 100000（EMQX 默认 1000） | EMQX，`EMQX_MAX_MQUEUE_LEN` |
| `mqtt.max_inflight` | 512 | EMQX，`EMQX_MAX_INFLIGHT` |
| `force_shutdown.max_heap_size` | 256MB | EMQX，单个连接进程的堆上限 |

EMQX 5 的持久会话有两种，区别在离线消息放哪：

| | 内存持久会话 | 磁盘持久会话（`durable_sessions`） |
|--|-------------|----------------------------------|
| 离线消息 | 会话进程里的内存队列 mqueue | 内置的持久存储 |
| 订阅端断开重连 | 补发 | 补发 |
| EMQX 重启 | **未投递的消息丢失** | 设计上保留 |
| 积压过大时 | 溢出丢弃，计入 `mqueue_dropped`，停压后自愈 | 实测静默楔死 |

V0.2-R 最初选的是磁盘持久会话，2026-10-28 关掉了，结论先放这里：3,000 条/秒压测约 70 秒后投递永久停止，而连接、健康检查、两侧日志全是正常的；重启 transport 触发会话重放，连接进程超堆被杀，再重连再被杀，唯一的出路是丢弃会话连同里面约 29 万条积压。同样负载换成内存会话，丢弃有计数、停压后自己排空。**失败模式从「静默、整批、必须人工」变成「可见、有界、自愈」**，排查过程与数据见 [压测与瓶颈排查](./10_capacity)。

选内存会话要接受两件事：

- **mqueue 有上限，溢出就丢**：默认 1000 条太小。V0.2-R 立项前实测过，订阅端离线期间发 2000 条 QoS 1，默认配置重连后只收到 1000 条。Conduit 调到 100000，要覆盖的是主备切换窗口里的积压
- **EMQX 重启不保留未投递的消息**：这正是第一节「不带 `id` 的设备会丢」的来源，也是可靠上报存在的理由

还有一条容易忽略的约束：**mqueue 住在连接进程的堆里，和 `max_heap_size` 共用一个上限**。所以规则是调大队列前先确认堆的余量，而不是反过来上调堆上限。这条约束后来被实测撞到了，见第十节。

---

## 六、单活多备：Redis 锁选主

### 1、为什么只让一个实例连 EMQX

持久会话按 clientId 记账。如果两个 transport 各用各的 clientId 订阅同一个过滤器，每条消息会被投两份；如果想让它们分摊，就得用共享订阅。V0.2-R 立项时实测 EMQX 5.8.6 的磁盘持久会话拒绝共享订阅（SUBACK 返回 `Shared Subscriptions not supported`），于是定了「所有实例共用一组 clientId，同一时刻只有主实例连接」。后来会话换成了内存的，这个模型保留了下来：切换时新主用同一组 clientId 连上去，就接管了同一组会话和里面排着的消息。

### 2、锁：一个键、三段 Lua

锁是 Redis 里的一个键 `conduit:transport:leader`，值为实例 id（主机名-进程号-8 位随机十六进制）。抢锁、续期、释放都是先比对值再操作，见 [`RedisLeaderLock`](https://github.com/Clarence404/conduit-iot/blob/811e441/conduit-transport/src/main/java/dev/conduit/transport/leader/RedisLeaderLock.java)：

```lua
-- 抢锁：KEYS[1] = 锁键，ARGV[1] = 实例 id，ARGV[2] = ttl 毫秒
local v = redis.call('GET', KEYS[1])
if v == ARGV[1] then redis.call('PEXPIRE', KEYS[1], ARGV[2]) return 1 end   -- 已经是我：续上，算抢到
if not v then redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2]) return 1 end -- 没人持有：写入
return 0                                                                      -- 别人持有

-- 续期：值还是我才延长
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('PEXPIRE', KEYS[1], ARGV[2]) end
return 0

-- 释放：值还是我才删
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
return 0
```

- **抢锁没有直接用 `SET NX PX`**：多了「键里已经是本实例 id 就刷新过期时间」这一支。Redis 短暂抖动导致主实例续期失败、下台之后，它下一次抢锁能立刻拿回自己的锁，不必空等一个 ttl
- **续期与释放都比对 id**：锁过期并被别的实例抢到之后，旧主的续期和释放都不生效，不会误删别人的锁

比对值再操作、用 Lua 保证原子，这是 Redis 分布式锁的通用写法，原理见 [分布式锁](/distributed/4_lock)。

### 3、三个定时任务

[`LeaderElection`](https://github.com/Clarence404/conduit-iot/blob/811e441/conduit-transport/src/main/java/dev/conduit/transport/leader/LeaderElection.java) 是一个 `SmartLifecycle`，启动后在一条调度线程上跑三件事：

| 任务 | 间隔 | 做什么 |
|------|-----|--------|
| 抢锁 | 2 秒（`acquire-interval`） | 备实例尝试抢锁，抢到就成为主实例，在另一条线程上启动全部 MQTT 连接 |
| 续期 | 5 秒（`renew-interval`） | 主实例续期，失败就下台 |
| 巡检 | 1 秒 | 主实例检查有没有断开的连接，有则先续期确认仍持锁，再重连 |

锁的过期时间 `ttl` 是 15 秒，Redis 命令超时配成 2 秒（短于续期间隔，Redis 卡住时按续期失败处理）。配置启动时校验：续期间隔必须为正且短于 ttl，否则启动失败。

**续期失败立即断开**，不等、不重试：

```java
private boolean renewOrStepDown() {
    String problem;
    try {
        if (lock.renew()) {
            return true;
        }
        problem = "the lock is no longer held by this instance";
    } catch (RuntimeException e) {
        problem = "Redis error: " + e.getMessage();
    }
    term.incrementAndGet();          // 任期加一：旧任期里还在进行的启动循环据此放弃
    role = Role.STANDBY;
    stopAdapters();                  // 立即断开全部 MQTT 连接
    return false;
}
```

- **宁可没有主，也不能有两个主**：锁不属于自己、Redis 报错、Redis 超时，三种情况一律下台。Redis 不可用时所有实例都不连 EMQX，不会出现「没有锁的主实例」，消息排在 EMQX 的会话队列里等
- **任期号堵住「下台后又连上」**：启动连接可能要等几秒，这期间实例可能已经下台。`adapter.start(() -> running && term.get() == t)` 把任期校验交给连接本身，在发出 CONNECT 之前和订阅之前各查一次；启动成功后发现任期已变，立即停掉
- **不用 HiveMQ 的自动重连**：断线后由巡检任务先续期确认仍持锁，再重连。否则下台的旧主会自动连回来，用同样的 clientId 把新主踢掉，两边互踢
- **Broker 侧还有一道保险**：新主用同一个 clientId 连接时，EMQX 会踢掉旧连接（DISCONNECT 原因码 `SESSION_TAKEN_OVER`），被踢的一方只置「需要重连」标志，重不重连仍由持不持锁决定
- **`connected` 的含义从严**：SUBACK 里只要有一个订阅被拒就算启动失败；HiveMQ 只在全部被拒时才让 future 异常完成，部分被拒要自己查

### 4、接管要多久

| 情况 | 备实例多久接管 |
|------|---------------|
| 主实例正常停止 | 立即：停止时比对 id 后删锁，备实例下一次抢锁（2 秒内）就拿到 |
| 主实例崩溃（没机会删锁） | 最长 ttl 15 秒 + 抢锁间隔 2 秒，约 17 秒；之后还要连接、订阅 |
| Redis 不可用 | 不接管，全体待命 |

正常停止要给够时间。Compose 默认只等 10 秒就强杀，而主实例要先断开 MQTT（每条连接最多等 5 秒）再释放锁，所以独立部署包给两个 transport 都配了 `stop_grace_period: 20s`。

主实例崩溃那一行是上限的算法，负载下的实测是「约 25 秒后 4 条连接全部重连就绪」，见第九节。这段时间里设备的上报照常被 EMQX 确认，排在会话的 mqueue 里，新主连上后补发。

---

## 七、主实例的多条连接与共享订阅

2026-10-29 起，主实例不再只开一条连接，而是开 `conduit.transport.mqtt.connections` 条（默认 4）。为什么要多条，是压测定位出来的（EMQX 里每条连接是一个 Erlang 进程，单连接时全平台上行挤过同一个进程），数据留给 [压测与瓶颈排查](./10_capacity)，这里只讲它怎么和主备、会话配合。

**选主模型一点没动**：仍然只有主实例连 EMQX。`LeaderElection` 本来就接收一个适配器列表，启动全部、要求全部已连接才算 `connected`、哪条断了单独重启哪条，所以只是从注册 1 个适配器变成注册 K 个。

| 项 | 取值 | 原因 |
|----|------|------|
| 第 0 条的 clientId | `conduit-transport` | 沿用旧名，接管升级前的会话 |
| 第 i 条的 clientId | `conduit-transport-i` | 必须保留 `conduit-` 前缀，transport 的超级用户鉴权靠它 |
| 订阅 | `$share/conduit-transport/conduit/+/+/up/#` | 共享订阅，EMQX 在组内成员间分摊 |
| 分发策略 | `mqtt.shared_subscription_strategy = hash_clientid` | 同一设备固定走同一条连接，单设备内保序 |
| 上下线事件 `$SYS/...` | 只由第 0 条订阅，非共享 | 否则每条连接各收一份，重复 K 次 |
| `connections=1` | 旧 clientId、普通订阅、不退订 | 回退开关，行为与改动前完全一致 |

共享订阅在这个场景里最大的疑问是：**组内成员全部离线时，EMQX 会不会直接丢？** 主备切换的十几秒里，K 条连接是一起断开的，如果丢，这个方案就不成立。设计阶段先在压测机上用 4 个持久会话的探测成员测了三种情况，各发 6000 条：

| 场景 | EMQX 收到 | 丢弃 | 结果 |
|------|----------|------|------|
| 全员在线 | 6000 | 0 | 实收 6000 |
| 全员离线（保留会话）后重连 | 6000 | 0 | 重连后补收 6000 |
| 4 个中 1 个离线 | 5999 | 0 | 在线 3 个收 4518，离线者重连补收 1481 |

**落到离线成员的消息排进它的会话、重连后补发，不丢，也不改派给别的成员**，和单连接持久会话的行为一致。所以新主以同一组 clientId 接管就能补回切换窗口内的消息。副作用也在表里：如果 K 条里只有一条长时间断开，约 1/K 的流量会滞留在它的会话里（延迟而不是丢失），所以会话监控按连接分别采样，指标带 `client` 标签。

从单连接升级时有一个细节。旧部署在 EMQX 里留着 clientId 为 `conduit-transport`、挂着非共享订阅的会话。第 0 条沿用这个 clientId 接管它，会话里排队的消息照常补发；但如果不处理那条旧订阅，这条连接会继续通过它收到**全部**上行，共享订阅形同虚设。所以第 0 条在订阅成功后退订旧的非共享过滤器：退订只影响之后新消息的路由，已在队列里的照常投递；全新安装时 EMQX 回 `NO_SUBSCRIPTIONS_EXISTED`，视为成功；其他原因码视为启动失败，由协调器重试，宁可连不上也不带着一条全量的非共享订阅静默运行。

::: warning 分发策略的键在 mqtt 下
`shared_subscription_strategy` 写在 `broker` 下面（环境变量 `EMQX_BROKER__...`）会被 EMQX 5.10 静默忽略，命令照样成功。这类「命令成功但没生效」的配置，一律以回读运行中的值为准。
:::

---

## 八、健康检查里的 role

transport 的 `GET /actuator/health` 里有一个 `leader` 组件，由 [`LeaderHealthIndicator`](https://github.com/Clarence404/conduit-iot/blob/811e441/conduit-transport/src/main/java/dev/conduit/transport/leader/LeaderHealthIndicator.java) 提供：

```json
{
  "status": "UP",
  "components": {
    "leader": {
      "status": "UP",
      "details": {
        "session": { "…": "主实例各条连接的会话指标" },
        "role": "LEADER",
        "instanceId": "transport-a-1-3f9c2a1b",
        "connected": true
      }
    }
  }
}
```

| 字段 | 含义 |
|------|------|
| `role` | `LEADER` 或 `STANDBY` |
| `instanceId` | 锁里的值，日志里也用它区分实例 |
| `connected` | 是主实例，且全部连接都已连上、订阅都已被 EMQX 批准 |
| `session` | 主实例经 EMQX REST API 采到的会话指标；备实例显示「备实例，不监控本会话」 |

- **备实例是 `UP`**：待命是正常状态，不能因为没连 EMQX 就让编排工具把它重启
- **只看 `connected` 不够**：磁盘持久会话楔死那次，连接一切正常而消息不再流动。所以主实例另外按连接轮询会话（默认 30 秒一次），告警有六项：丢弃、队列水位、会话内存、投递停滞、持久会话被意外启用、批大于在途窗口，其中**只有「投递停滞」会把健康检查置为 `DOWN`**，任一条连接停滞即判
- **轮询失败不改变健康状态**：EMQX 不可达或认证失败只记 WARN 并保留上次结论，避免监控本身引起抖动
- **备实例不沿用旧结论**：下台后监控状态重置，免得一个已过期的结论挂在那里

日志的分级配合这套状态：抢锁或启动连接首次失败记 WARN，之后的重试记 DEBUG，恢复与每次角色变化记 INFO，Redis 长时间不可用时不会每 2 秒刷一行。

---

## 九、验证

端到端的验证在 `conduit-e2e` 模块，`-Pe2e` 才运行：Testcontainers 起 PostgreSQL、Redis、InfluxDB 3、EMQX 的临时环境，本地以 jar 启动 1 个 server 和 2 个 transport，测试代码扮演设备并直接杀进程。每个场景 10 台设备各 50 条，断言三件事：**InfluxDB 里恰好 500 条、没有死信、消费组里没有未确认的消息**。

| 场景 | 故障注入 | 靠什么不丢 |
|------|---------|-----------|
| 1 | 发送中途强杀 server，3 秒后重启 | 消费组未确认消息被重新认领 |
| 2 | 强杀主 transport | 备实例接管，会话队列补发 |
| 3 | 两个 transport 都结束约 20 秒再启动 | EMQX 内存会话的 mqueue |
| 4 | 重启 EMQX 容器 | 带 `id` 的设备重发 |
| 5 | SIGKILL 强杀 EMQX 再原地启动 | 带 `id` 的设备重发 |

场景 4 的预期是随会话选择一起改的：磁盘持久会话时期它用普通设备，换成内存会话后未投递消息不再保留，改用带 `id` 的设备。为了确认场景 4、5 不是「重启时恰好没有在途消息」而空过，测试设备加了重发计数：两个场景各重发 20 条，确实触发了重发（样本只有一次，没有评估波动）。

| 结论 | 证据 | 类型 |
|------|------|------|
| 五个故障场景计数恰好、无死信、无待确认 | [`ReliabilityE2EIT`](https://github.com/Clarence404/conduit-iot/blob/811e441/conduit-e2e/src/test/java/dev/conduit/e2e/ReliabilityE2EIT.java)，[V0.2-R2 测试报告](https://github.com/Clarence404/conduit-iot/blob/811e441/docs/test-reports/2026-10-20-reliable-uplink.md)、[会话修复验证报告](https://github.com/Clarence404/conduit-iot/blob/811e441/docs/test-reports/2026-10-28-session-wedge-fix-verification.md) | e2e |
| 带 `id` 的上报在写入总线后收到回执，内容与 `id` 一致 | [`MqttProtocolAdapterIT#acknowledgesAReliablePropertyAfterWritingItToTheBus`](https://github.com/Clarence404/conduit-iot/blob/811e441/conduit-transport/src/test/java/dev/conduit/transport/mqtt/MqttProtocolAdapterIT.java) | 集成 |
| 停止期间发布的消息重连后全部收到；同 clientId 的第二条连接踢掉第一条 | 同上，`#receivesEveryMessagePublishedWhileStopped`、`#aSecondConnectionWithTheSameClientIdKicksTheFirstWhichStaysDown` | 集成 |
| 顶层 `id` / `ts` 的提取，非法 JSON、非法 `id`、超大载荷不启用回执 | [`ReliableUplinkTest`](https://github.com/Clarence404/conduit-iot/blob/811e441/conduit-transport/src/test/java/dev/conduit/transport/mqtt/ReliableUplinkTest.java) | 单元 |
| 回执乱序也按 `id` 出队、超时重发内容不变、队列满时拒收 | [`PendingReportQueueTest`](https://github.com/Clarence404/conduit-iot/blob/811e441/conduit-simulator/src/test/java/dev/conduit/simulator/PendingReportQueueTest.java) | 单元 |
| 只有一个实例拿到锁；持有者可重入并刷新过期时间；过期后旧主续期与释放都不生效 | [`RedisLeaderLockIT`](https://github.com/Clarence404/conduit-iot/blob/811e441/conduit-transport/src/test/java/dev/conduit/transport/leader/RedisLeaderLockIT.java) | 集成 |
| 两个实例只有一个成为主且只有它连接；备实例在 ttl 内接管并收到积压；续期失败立即断开 | [`LeaderElectionIT`](https://github.com/Clarence404/conduit-iot/blob/811e441/conduit-transport/src/test/java/dev/conduit/transport/leader/LeaderElectionIT.java) | 集成 |
| Redis 出错时下台、恢复后回来；锁丢了不重连；停止时不释放别人的锁 | [`LeaderElectionTest`](https://github.com/Clarence404/conduit-iot/blob/811e441/conduit-transport/src/test/java/dev/conduit/transport/leader/LeaderElectionTest.java) | 单元 |
| 多连接的 clientId、共享过滤器、上下线事件只由第 0 条订阅 | [`MultiConnectionTest`](https://github.com/Clarence404/conduit-iot/blob/811e441/conduit-transport/src/test/java/dev/conduit/transport/mqtt/MultiConnectionTest.java) | 单元 |
| 投递停滞时健康检查为 DOWN，备实例不沿用旧结论 | [`LeaderHealthIndicatorTest`](https://github.com/Clarence404/conduit-iot/blob/811e441/conduit-transport/src/test/java/dev/conduit/transport/leader/LeaderHealthIndicatorTest.java) | 单元 |

### 1、负载下强杀主实例

e2e 每个场景只有 500 条，量太小。2026-10-29 在压测机（8 核、约 7.6 GB 内存的虚拟机）上按 10,000 条/秒持续发压，第 40 秒 `docker kill` 主 transport（[压测报告](https://github.com/Clarence404/conduit-iot/blob/811e441/docs/test-reports/2026-10-29-vm-max-throughput.md) 第 6 节）：

| 口径 | 条数 |
|------|------|
| 客户端实发 | 1,199,999 |
| EMQX 接收 | 1,199,999 |
| EMQX 丢弃 | 0 |
| 流水线入库（处理次数） | 1,201,741 |
| 死信 | 0 |
| **InfluxDB 行数** | **1,199,999** |

备实例约 25 秒后接管，4 条连接全部重连。流水线多处理的 1742 条是重复：主实例被杀的瞬间已经写入 Redis 但还没来得及向 EMQX 确认的消息，被 EMQX 重投给了新主。InfluxDB 按同设备同时间戳覆盖，最终行数等于实发数，零丢失。这也是「至少一次 + 下游幂等」在一次真实切换里的完整样子。

### 2、正常交接与旧版 EMQX 的补发错位

V0.2-R 做完时留过一个已知问题：主 transport **正常停止**（发了 DISCONNECT）时，停止瞬间已收到未确认的消息，在新主接管后被 EMQX 5.8.6 的磁盘持久会话以错误的内容重发，重发的是早已确认过的旧消息，导致少量丢失；强杀反而不复现。2026-10-19 把各部署包统一到 EMQX 5.10.5 之后，专项实验 9 次结果全部正确，没有再复现。

这个结论只覆盖「transport 正常交接」，和第二节「Broker 自己被强杀会丢已确认消息」是两个不同的故障边界：前者已解决，后者由可靠上报覆盖。

---

## 十、已知限制

- **Broker 被强杀、断电或重启**：不带 `id` 的设备会丢已 PUBACK 但还没投递给 transport 的消息，这是设备接入契约里明确写出来的缺口；带 `id` 的设备由本地副本覆盖。`id` 目前仍是可选，改成必填是对外契约的收紧，没有做
- **设备自己断电**：平台管不到。模拟器的队列只在内存，真实设备要自己落盘
- **回执不代表入库**：InfluxDB 的 2xx 表示数据进了操作系统页缓存而不是磁盘，断电可能丢掉内核回写窗口内的数据；补救手段是从 Redis 上行流按时间范围重放，见 [时序存储与历史查询](./5_telemetry)
- **幂等靠同设备同 `ts` 覆盖**，没有按「设备 + id」去重：设备不带 `ts` 且回执又丢了时，重发会多出一个时间不同、值相同的点
- **mqueue 默认值偏大**：容量压测里把队列填满 100000 条时，会话进程的堆涨到 513 MB，超过上限被杀（配置 256MB，实际按 1.5 倍即 384 MB 触发），整个队列随之丢失，折合每条约 5.4 KB。这只在入库彻底停摆、队列一直堆的时候才会触发，但那正是最不希望连接进程被杀的时刻；调小队列又盖不住切换窗口，这个取舍在仓库里记为待定
- **切换窗口约 17～25 秒**：期间数据不丢但会晚到，实时性要求更高时得缩短 ttl，代价是 Redis 抖动更容易触发下台
- **主备不提升吞吐**：同一时刻只有一个 transport 实例在工作，多连接分摊的是 EMQX 侧的投递；多个实例同时活跃会改变高可用模型，没有做
- **持久性验证的范围**：客户机强制重启模拟不了物理磁盘或控制器断电，结论限于那套虚拟机与存储栈

---

## 小结

- 「不丢」分两档：带 `id` 的设备端到端不丢，不带的只有逐跳 QoS 1；差别来自第一跳，EMQX 的 PUBACK 不代表落盘，实测强杀能丢掉已确认的尾部消息
- 设备带 `id` 与 `ts` 上报，本地留副本；平台在写入 Redis 总线成功后发 QoS 0 回执，含义是「已持久接收」而不是「已入库」；收不到就原样重发，靠同设备同 `ts` 覆盖吸收重复
- transport 的顺序是「XADD 成功 → 业务回执 → PUBACK」，失败条目原地阻塞重试，不留下未确认的消息占住在途窗口
- EMQX 用内存持久会话：`cleanStart=false`、会话保留 86400 秒、mqueue 100000；磁盘持久会话在积压下会静默楔死，已关闭
- transport 单活多备：Redis 键加三段 Lua，ttl 15 秒、续期 5 秒、抢锁 2 秒；续期失败立即断开，Redis 不可用时全体待命；任期号与「先确认持锁再重连」防止新旧主互踢
- 主实例开 4 条连接，用共享订阅加 `hash_clientid` 分摊投递；成员离线时消息排进各自会话，所以切换不丢
- 健康检查显示 `role`、`instanceId`、`connected`，只有投递停滞才置 `DOWN`
- 实测：e2e 五个故障场景计数恰好；10,000 条/秒下强杀主实例，约 25 秒接管，零丢失

## 参考资料

- Conduit IoT · 持久性验证：[https://github.com/Clarence404/conduit-iot/blob/811e441/docs/durability-validation.md](https://github.com/Clarence404/conduit-iot/blob/811e441/docs/durability-validation.md)
- Conduit IoT · V0.2-R 可靠性加固设计：[https://github.com/Clarence404/conduit-iot/blob/811e441/docs/superpowers/specs/2026-10-16-conduit-v0.2r-reliability-design.md](https://github.com/Clarence404/conduit-iot/blob/811e441/docs/superpowers/specs/2026-10-16-conduit-v0.2r-reliability-design.md)
- Conduit IoT · V0.2-R2 端到端可靠上报设计：[https://github.com/Clarence404/conduit-iot/blob/811e441/docs/superpowers/specs/2026-10-20-conduit-reliable-uplink-design.md](https://github.com/Clarence404/conduit-iot/blob/811e441/docs/superpowers/specs/2026-10-20-conduit-reliable-uplink-design.md)
- Conduit IoT · EMQX 会话楔死修复设计：[https://github.com/Clarence404/conduit-iot/blob/811e441/docs/superpowers/specs/2026-10-28-conduit-emqx-session-wedge-fix-design.md](https://github.com/Clarence404/conduit-iot/blob/811e441/docs/superpowers/specs/2026-10-28-conduit-emqx-session-wedge-fix-design.md)
- Conduit IoT · transport 多连接共享订阅设计：[https://github.com/Clarence404/conduit-iot/blob/811e441/docs/superpowers/specs/2026-10-29-conduit-transport-shared-subscription-design.md](https://github.com/Clarence404/conduit-iot/blob/811e441/docs/superpowers/specs/2026-10-29-conduit-transport-shared-subscription-design.md)
- Conduit IoT · 设备接入指南：[https://github.com/Clarence404/conduit-iot/blob/811e441/docs/device-integration.md](https://github.com/Clarence404/conduit-iot/blob/811e441/docs/device-integration.md)
- EMQX 文档：[https://docs.emqx.com/zh/emqx/latest/](https://docs.emqx.com/zh/emqx/latest/)
- Redis 文档 · Persistence：[https://redis.io/docs/latest/operate/oss_and_stack/management/persistence/](https://redis.io/docs/latest/operate/oss_and_stack/management/persistence/)
- MQTT Version 5.0（OASIS）：[https://docs.oasis-open.org/mqtt/mqtt/v5.0/mqtt-v5.0.html](https://docs.oasis-open.org/mqtt/mqtt/v5.0/mqtt-v5.0.html)

> 下一篇：[数据流水线](./4_pipeline)
