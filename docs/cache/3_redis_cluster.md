# Redis 集群

## 一、三种集群模式对比

| 模式 | 高可用 | 数据分片 | 自动故障转移 | 适用场景 |
|------|--------|---------|------------|---------|
| 主从复制 | 有从节点但需手动切换 | ❌ | ❌ | 读写分离，数据备份 |
| 哨兵模式 | ✅ | ❌ | ✅ | 单节点高可用 |
| Cluster 模式 | ✅ | ✅ | ✅ | 大数据量 + 高并发 |

---

## 二、主从复制

### 全量复制

```
从节点发送 PSYNC replicationid offset
主节点执行 BGSAVE 生成 RDB 快照
主节点将 RDB 发送给从节点（同时记录增量命令到 repl_backlog）
从节点加载 RDB，再应用增量命令
```

### 增量复制（断点续传）

从节点重连后，发送自己的 `replication offset`：
- 若 offset 在主节点 `repl_backlog_buffer` 范围内 → 发送增量数据
- 否则触发全量复制

`repl_backlog_buffer` 默认 1MB，写流量大时应适当调大（`repl-backlog-size 8mb`）。

### 读写分离

```bash
# 从节点只读（默认）
replica-read-only yes
```

**注意主从延迟**：从节点数据可能比主节点落后，读写分离场景下要评估业务是否能接受短暂不一致。

---

## 三、哨兵模式（Sentinel）

哨兵是独立进程，负责监控、通知、自动故障转移。

```
Sentinel1  Sentinel2  Sentinel3   ← 推荐奇数个，防止脑裂
     ↓           ↓          ↓
  [Master] ←→ [Slave1] ←→ [Slave2]
```

### 故障转移流程

```
1. 哨兵检测主节点响应超时（主观下线，sdown）
2. 超过 quorum 个哨兵都认为下线 → 客观下线（odown）
3. 哨兵之间选举出 Leader（Raft）
4. Leader 选择最优从节点（优先级 > 复制偏移量 > runid）晋升为主节点
5. 其余从节点指向新主节点
6. 原主节点恢复后作为从节点加入
```

### 关键配置

```bash
# sentinel.conf
sentinel monitor mymaster 127.0.0.1 6379 2    # quorum=2（2个哨兵同意才客观下线）
sentinel down-after-milliseconds mymaster 5000  # 超时5秒认为主观下线
sentinel failover-timeout mymaster 60000         # 故障转移超时
```

---

## 四、Cluster 模式

### 数据分片（哈希槽）

Cluster 将数据分散到 **16384 个哈希槽**（hash slot）：
```
slot = CRC16(key) % 16384
```

每个主节点负责一段槽位，例如：
```
节点A：0 - 5460
节点B：5461 - 10922
节点C：10923 - 16383
```

### 集群路由（MOVED / ASK）

```
客户端 SET foo bar
  → Redis节点A计算 slot=7638，属于节点B
  → 返回 MOVED 7638 127.0.0.1:6380
客户端重定向到节点B
```

**Gossip 协议**：节点之间通过 Gossip 协议交换节点状态，最终所有节点都知道完整的集群拓扑。

### 扩容/缩容（槽迁移）

```bash
redis-cli --cluster reshard 127.0.0.1:6379    # 交互式槽迁移
redis-cli --cluster add-node newhost:port existhost:port  # 新增节点
```

### Cluster 的限制

- 不支持跨 slot 的多 key 操作（`MGET`/`MSET` 需要 key 在同一 slot）
- 解决方案：**Hash Tag**（`{user}:order` 和 `{user}:profile` 会落在同一 slot）

```bash
MSET {user:1}:name Alice {user:1}:age 20    # {} 内的内容决定 slot
```

---

## 五、集群同步与一致性

### 主从同步延迟问题

主从复制是**异步的**，主节点写入后从节点有延迟（通常毫秒级）。

`WAIT numreplicas timeout` 命令可以等待指定数量从节点同步完成，用于需要更强一致性的场景（但不是严格强一致）。

### 脑裂问题

网络分区时，旧主节点被隔离但仍接受客户端写入，恢复后这些写入会丢失。

```bash
# 主节点配置：少于N个从节点同步成功时拒绝写入
min-replicas-to-write 1
min-replicas-max-lag 10    # 从节点延迟超过10秒视为不可用
```

---

## 六、部署建议

```bash
# 最小生产配置（哨兵）
1主 + 2从 + 3哨兵（哨兵可与Redis同机但推荐分开）

# Cluster 最小配置
3主 + 3从（每主一从，共6节点）

# Spring Boot 连接哨兵
spring:
  redis:
    sentinel:
      master: mymaster
      nodes: 127.0.0.1:26379,127.0.0.1:26380,127.0.0.1:26381

# Spring Boot 连接 Cluster
spring:
  redis:
    cluster:
      nodes: 127.0.0.1:6379,127.0.0.1:6380,127.0.0.1:6381
```

---

## 七、常见面试问题

**Q：哨兵模式的 quorum 有什么作用？**
quorum 是判断主节点客观下线所需的最少哨兵数。设置为多数（如3个哨兵设quorum=2）可以防止网络分区导致的误判（单个哨兵自身网络问题时不会触发故障转移）。

**Q：Redis Cluster 为什么是 16384 个 slot 而不是更多？**
主要是心跳包大小的权衡：节点间 Gossip 心跳包会携带 slot 信息位图，16384 个 slot 的位图大小是 2KB，节点数 < 1000 时足够用，继续增大会增加网络开销。

**Q：Cluster 模式下 Lua 脚本的限制？**
Lua 脚本中的所有 key 必须在同一个 slot，否则报错。可以用 Hash Tag 确保相关 key 在同一 slot，或在业务层保证。
