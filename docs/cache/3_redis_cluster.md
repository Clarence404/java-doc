---
description: 主从复制、哨兵与 quorum、Cluster 槽位与 MOVED / ASK、故障转移、脑裂、部署配置
---

# Redis 集群

> 前置阅读：[Redis 核心原理](./2_redis_core)

Redis 有主从、哨兵、Cluster 三种部署形态，可用性与扩展能力各不相同。本篇讲主从复制的全量 / 增量同步、哨兵故障转移、Cluster 槽位路由与重定向，以及异步复制下的丢写边界与部署建议。

---

## 一、三种部署模式对比

| 模式 | 高可用 | 数据分片 | 自动故障转移 | 适用场景 |
|------|--------|---------|------------|---------|
| 主从复制 | 有副本，需人工切换 | 不支持 | 不支持 | 读扩展、数据备份 |
| 哨兵（Sentinel） | 支持 | 不支持 | 支持 | 数据量单机放得下，要求自动切换 |
| Cluster | 支持 | 支持（16384 个槽） | 支持 | 数据量或写吞吐超过单机 |

单机内存能装下、写 QPS 单核能扛住时优先用哨兵，运维和客户端都更简单；只有容量或写吞吐不够时再上 Cluster。

---

## 二、主从复制

复制是**异步**的：主节点写完立即返回客户端，再把命令流发给从节点。

### 1、全量同步

1. 从节点首次连接时发送 `PSYNC ? -1`（不知道主节点的复制 ID 与偏移量）
2. 主节点回复 `+FULLRESYNC <replid> <offset>`，开始生成 RDB。7.0 起 `repl-diskless-sync yes` 为默认值，RDB 直接通过 socket 流式发送，不落盘
3. 传输期间的新写入缓存在该从节点的输出缓冲区，受 `client-output-buffer-limit replica 256mb 64mb 60` 限制，超限会断开连接并重新全量同步
4. 从节点清空旧数据、加载 RDB，再执行缓冲区里的增量命令，之后进入持续的命令流复制

### 2、增量同步（部分重同步）

从节点断线重连后发送 `PSYNC <replid> <offset>`：

- 复制 ID 匹配且 offset 仍在主节点的复制积压缓冲区（`repl-backlog-size`，默认 1MB）内：只补发缺失的命令
- 否则退化为全量同步

写流量大的实例应按「每秒写入字节数 × 可容忍的断线秒数」调大 `repl-backlog-size`，例如 64MB。

**PSYNC2（4.0+）**：节点保存 `replid` 与 `replid2`（上一任主节点的复制 ID）。故障转移后，其余从节点改为复制新主节点时，只要偏移量连续就能部分重同步，不必全部重新全量同步；从节点重启后也能从 RDB 中恢复复制信息。

### 3、读写分离

```bash
replica-read-only yes    # 从节点只读（默认）
```

从节点数据比主节点落后（通常毫秒级，网络抖动或大 key 时可达秒级），从从节点读要能接受短暂不一致。「写后立即读」的场景应读主节点。

---

## 三、哨兵模式（Sentinel）

哨兵是独立进程，负责监控主从、通知客户端、自动故障转移，同时作为配置中心告诉客户端当前主节点地址。

![哨兵部署：3 个 Sentinel 监控 1 主 2 从](../assets/cache/redis-sentinel.svg)

### 1、下线判定与故障转移

1. **主观下线（SDOWN）**：某个哨兵在 `down-after-milliseconds` 内没收到主节点的有效回复
2. **客观下线（ODOWN）**：认为主节点下线的哨兵数达到 `quorum`
3. **选举 Leader**：发现 ODOWN 的哨兵发起投票（基于 epoch，每个纪元每个哨兵只投一票），获得**全部哨兵的多数票**（且不少于 quorum）的哨兵才能执行故障转移
4. **挑选新主**：排除断线过久的从节点，按 `replica-priority`（越小越优先，0 表示永不提升）→ 复制偏移量（越大越新）→ run ID（字典序最小）选出
5. 对选中的从节点执行 `REPLICAOF NO ONE`，其余从节点改为复制新主，客户端通过订阅哨兵或重新查询拿到新地址
6. 原主节点恢复后被降级为新主的从节点

**quorum 与多数派的分工**：quorum 只决定「什么时候算客观下线」；能否真正切换取决于能否拿到多数哨兵的授权。网络分区时，少数派一侧的哨兵即使达到 quorum 也选不出 Leader，因此不会切换。哨兵部署奇数个（3 或 5）是为了用最少的节点获得容错的多数派，与 Redis 的脑裂是两回事。

### 2、关键配置

```bash
# sentinel.conf
sentinel monitor mymaster 10.0.0.1 6379 2          # quorum = 2
sentinel down-after-milliseconds mymaster 5000      # 5 秒无响应判主观下线
sentinel failover-timeout mymaster 60000            # 故障转移超时
sentinel parallel-syncs mymaster 1                  # 切换后同时向新主同步的从节点数
```

3 个哨兵、quorum = 2 是最常见的配置：一个哨兵自身网络故障时不会误判，任意一个哨兵宕机仍能完成切换。

---

## 四、Cluster 模式

### 1、数据分片（哈希槽）

Cluster 把键空间固定划分为 **16384 个哈希槽**，`slot = CRC16(key) mod 16384`，每个主节点负责一部分槽。它不是一致性哈希：槽与节点的映射由集群元数据显式维护，扩缩容就是迁移槽。

| 节点 | 负责的槽 |
|------|---------|
| A | 0 ~ 5460 |
| B | 5461 ~ 10922 |
| C | 10923 ~ 16383 |

选 16384 而不是 65536 的原因：节点间心跳要携带本节点负责的槽位图，16384 个槽的位图是 2KB，65536 则是 8KB；官方建议集群不超过约 1000 个主节点，16384 个槽已足够均匀分布。

### 2、客户端路由：MOVED 与 ASK

智能客户端（Lettuce、Jedis、Redisson）在本地缓存「槽 → 节点」映射，直接把命令发到目标节点。映射过期或槽正在迁移时，节点用重定向告诉客户端去哪：

![Cluster 重定向：MOVED 与 ASK](../assets/cache/redis-cluster-redirect.svg)

| | MOVED | ASK |
|--|-------|-----|
| 含义 | 槽已经稳定归属另一个节点 | 槽正在迁移，这个 key 已经迁到目标节点 |
| 客户端动作 | 更新本地槽表，重发到新节点 | 向目标节点先发 `ASKING`，再发原命令 |
| 是否更新槽表 | 是 | 否，只对本次请求生效 |

例如 `GET foo`：`CRC16("foo") mod 16384 = 12182`，属于节点 C；发给 A 会收到 `-MOVED 12182 <C 的地址>`。

### 3、扩缩容（槽迁移）

```bash
redis-cli --cluster add-node 10.0.0.4:6379 10.0.0.1:6379    # 新节点加入（尚无槽）
redis-cli --cluster reshard 10.0.0.1:6379                   # 交互式迁移槽
redis-cli --cluster rebalance 10.0.0.1:6379                 # 按权重自动均衡
```

迁移按 key 逐个 `MIGRATE`，大 key 迁移会阻塞源节点和目标节点，迁移前要先治理大 key。

### 4、故障转移

1. 节点在 `cluster-node-timeout`（常用 15 秒）内联系不上某主节点，标记为 PFAIL
2. 通过 Gossip 汇总，超过半数主节点认为它 PFAIL 时标记为 FAIL 并广播
3. 该主节点的从节点按复制偏移量排名延迟发起选举，递增 `currentEpoch` 向所有主节点拉票，获得多数主节点投票的从节点晋升
4. 新主接管原来的槽，并广播新配置

`cluster-require-full-coverage yes`（默认）时，只要有槽无节点负责，整个集群拒绝服务；可设为 `no` 让其余槽继续可用。

### 5、Cluster 的限制

- 多 key 命令（`MGET` / `MSET` / 事务 / Lua）的所有 key 必须在同一个槽，否则报 `CROSSSLOT`
- 只有 0 号数据库，不支持 `SELECT`
- 不支持跨节点的 `KEYS` / `SCAN`，要逐个主节点扫描

**Hash Tag**：key 中 `{}` 内的部分才参与槽计算，用来把相关 key 放进同一个槽。

```bash
MSET {user:1}:name Alice {user:1}:age 20    # 只按 user:1 计算槽，两个 key 同槽
```

Hash Tag 要按业务实体粒度取值：写成 `{user}:1:order` 会让所有用户的数据落进同一个槽，形成热点槽和超大分片。

---

## 五、异步复制下的一致性

### 1、复制延迟与 WAIT

主从复制是异步的，主节点确认写入后宕机，尚未同步的写入就会随故障转移丢失。

- `WAIT numreplicas timeout`：阻塞当前客户端，直到至少 N 个从节点确认收到之前的写入，或超时
- `WAITAOF numlocal numreplicas timeout`（7.2+）：等待写入在本地和 / 或从节点上 fsync 到 AOF

二者只能降低丢写概率，不能让 Redis 变成强一致系统：超时后写入不会回滚，故障转移也可能选中尚未确认的从节点。

### 2、脑裂

网络分区时，旧主节点被隔离在少数派一侧，仍在接受客户端写入；另一侧选出新主。分区恢复后旧主降级为从节点并清空数据，这段时间写入旧主的数据全部丢失。

```bash
# 主节点：已连接且 ACK 延迟不超过 10 秒的从节点少于 1 个时，拒绝写入
min-replicas-to-write 1
min-replicas-max-lag 10
```

这组配置不是「从节点同步成功才写入」，而是限制旧主在失联后最多再接受约 `min-replicas-max-lag` 秒的写入。它缩小丢写窗口，但不能消除；把 Redis 用于不能丢的数据时，要以数据库为准或在业务上做对账。

---

## 六、部署建议

- **哨兵最小生产配置**：1 主 2 从 + 3 个哨兵，哨兵分布在不同主机或可用区
- **Cluster 最小配置**：3 主 3 从（每主一从，共 6 个节点），主从不要部署在同一台主机
- **客户端**：用 Lettuce 时开启 Cluster 拓扑自适应刷新，故障转移后能尽快感知新拓扑

Spring Boot 4 连接哨兵（配置前缀自 Boot 3.0 起为 `spring.data.redis`）：

```yaml
spring:
  data:
    redis:
      password: ${REDIS_PASSWORD}
      sentinel:
        master: mymaster
        nodes: 10.0.0.1:26379,10.0.0.2:26379,10.0.0.3:26379
```

连接 Cluster：

```yaml
spring:
  data:
    redis:
      password: ${REDIS_PASSWORD}
      cluster:
        nodes: 10.0.0.1:6379,10.0.0.2:6379,10.0.0.3:6379
        max-redirects: 3
      lettuce:
        cluster:
          refresh:
            adaptive: true     # 收到 MOVED / ASK、连接断开等事件时刷新拓扑
            period: 30s        # 另加周期刷新兜底
```

---

## 小结

- 复制是异步的；7.0 起全量同步默认无盘传输，增量同步依赖 `repl-backlog-size`，PSYNC2 让故障转移后也能部分重同步
- 哨兵的 quorum 只决定客观下线，真正切换要多数哨兵授权，奇数个哨兵是为了多数派
- Cluster 是 16384 个固定槽，不是一致性哈希；MOVED 更新槽表，ASK 只对单次请求生效且要先发 `ASKING`
- 多 key 操作要同槽，Hash Tag 按实体粒度取值，避免热点槽
- `WAIT` / `WAITAOF` / `min-replicas-to-write` 只缩小丢写窗口，Redis 不提供强一致
- Spring Boot 3+ 用 `spring.data.redis.*`，Cluster 下开启 Lettuce 拓扑自适应刷新

## 参考资料

- Redis replication：[https://redis.io/docs/latest/operate/oss_and_stack/management/replication/](https://redis.io/docs/latest/operate/oss_and_stack/management/replication/)
- High availability with Redis Sentinel：[https://redis.io/docs/latest/operate/oss_and_stack/management/sentinel/](https://redis.io/docs/latest/operate/oss_and_stack/management/sentinel/)
- Scale with Redis Cluster：[https://redis.io/docs/latest/operate/oss_and_stack/management/scaling/](https://redis.io/docs/latest/operate/oss_and_stack/management/scaling/)
- Redis cluster specification：[https://redis.io/docs/latest/operate/oss_and_stack/reference/cluster-spec/](https://redis.io/docs/latest/operate/oss_and_stack/reference/cluster-spec/)
- WAIT：[https://redis.io/docs/latest/commands/wait/](https://redis.io/docs/latest/commands/wait/)
- WAITAOF：[https://redis.io/docs/latest/commands/waitaof/](https://redis.io/docs/latest/commands/waitaof/)
- Spring Data Redis 参考文档：[https://docs.spring.io/spring-data/redis/reference/](https://docs.spring.io/spring-data/redis/reference/)

> 下一篇：[Redis 典型应用场景](./4_redis_scenario) —— 排行榜、布隆过滤器、签到、可靠延迟队列与 Stream 队列的 Redis 实现。
