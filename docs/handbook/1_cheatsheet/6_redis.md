---
description: 连接与概况、大 Key / 热 Key、延迟、内存与淘汰、慢日志、客户端、持久化、主从哨兵与 Cluster
---

# Redis 运维命令速查

> 前置阅读：[Redis 核心原理](/cache/2_redis_core)、[Redis 集群](/cache/3_redis_cluster)、[Redis 实战](/cache/5_redis_practice)

本篇按场景列出 Redis 运维排查常用的 `redis-cli` 选项与服务端命令，覆盖大 Key / 热 Key、延迟、内存、慢日志与集群，基线为 Redis 8。

---

## 一、连接与概况

| 场景 | 命令 | 说明 |
|------|------|------|
| 安全地传密码 | `export REDISCLI_AUTH='<password>'` | 之后 `redis-cli` 自动认证；`-a` 会把密码留在 shell 历史和进程列表里 |
| 连接指定实例 | `redis-cli -h 10.0.0.1 -p 6379` | 带 ACL 用户名时加 `--user <user>` |
| 连接集群并自动跳转 | `redis-cli -c -h 10.0.0.1 -p 6379` | `-c` 自动跟随 `MOVED` / `ASK` 重定向 |
| 每秒滚动看负载 | `redis-cli --stat` | 每秒一行：key 数、内存、客户端数、请求增量 |
| 看全部运行信息 | `INFO` | 可只看某段：`INFO memory`、`INFO stats`、`INFO replication` |
| 看 key 数量 | `INFO keyspace` | 每个库的 key 总数与带过期时间的 key 数；单库也可用 `DBSIZE` |
| 看命中率 | `INFO stats` | 命中率 = `keyspace_hits` / (`keyspace_hits` + `keyspace_misses`) |
| 看各命令调用次数与耗时 | `INFO commandstats` | `usec_per_call` 高的命令优先排查 |
| 看各命令延迟分位 | `INFO latencystats` | 按命令输出 p50 / p99 / p99.9 延迟 |
| 按模式遍历 key | `SCAN 0 MATCH order:* COUNT 1000 TYPE hash` | 返回下一游标，游标回到 0 才算遍历完；**禁止**线上用 `KEYS *` |
| 命令行导出匹配的 key | `redis-cli --scan --pattern 'order:*' --count 1000 > keys.txt` | 基于 SCAN，不阻塞服务端 |

---

## 二、大 Key 与热 Key

| 场景 | 命令 | 说明 |
|------|------|------|
| 按元素个数找大 Key | `redis-cli --bigkeys -i 0.1` | 每 100 次 SCAN 休眠 0.1 秒降低影响；建议在从库执行 |
| 按内存找大 Key | `redis-cli --memkeys -i 0.1` | 按 `MEMORY USAGE` 排序，比 `--bigkeys` 更贴近实际占用 |
| 大 Key 与分布一次看全 | `redis-cli --keystats --top 20 -i 0.1` | 合并前两者，输出 Top N 与各类型大小分布；中断后可用 `--cursor <n>` 续扫 |
| 看单个 key 占用 | `MEMORY USAGE order:1001 SAMPLES 0` | 单位字节；`SAMPLES 0` 统计全部元素，大集合上较慢 |
| 看集合元素个数 | `HLEN user:profile` | 对应类型分别用 `LLEN`、`SCARD`、`ZCARD`、`XLEN`、`STRLEN` |
| 看 key 的编码 | `OBJECT ENCODING user:profile` | `listpack` 变成 `hashtable` / `skiplist` 说明元素已超阈值 |
| 非阻塞删除大 Key | `UNLINK big:key` | 在后台线程释放内存，替代 `DEL` |
| 分批删除大 Hash | `HSCAN big:hash 0 COUNT 500` | 每批取 500 个字段后 `HDEL`，直到游标回到 0；Set / ZSet 用 `SSCAN` / `ZSCAN` |
| 找热 Key | `redis-cli --hotkeys -i 0.1` | 依赖 LFU 计数，要求 `maxmemory-policy` 为 `allkeys-lfu` 或 `volatile-lfu` |
| 看单个 key 访问频率 | `OBJECT FREQ hot:item` | 同样要求 LFU 策略，返回对数计数器值 |
| 临时抓取命令流 | `redis-cli MONITOR > monitor.log` | 性能开销大，只在低峰抓几秒后立即 Ctrl+C |

---

## 三、延迟

| 场景 | 命令 | 说明 |
|------|------|------|
| 测客户端到 Redis 的延迟 | `redis-cli --latency` | 每秒 100 次 PING，单位毫秒 |
| 看延迟随时间的变化 | `redis-cli --latency-history -i 15` | 每 15 秒一个统计窗口 |
| 带分位数的延迟 | `redis-cli --latency --latency-percentiles 50,99,99.9` | 高分位需要足够样本，可调大 `-i` |
| 测宿主机固有延迟 | `redis-cli --intrinsic-latency 60` | 必须在 Redis 所在机器上执行，不连 Redis；结果是该机器延迟下限 |
| 开启延迟监控 | `CONFIG SET latency-monitor-threshold 100` | 单位毫秒，超过阈值的事件被记录；默认 0 为关闭 |
| 看最近延迟事件 | `LATENCY LATEST` | 按事件类型（`command`、`fork`、`aof-fsync-always` 等）列出最近与最大延迟 |
| 看某类事件历史 | `LATENCY HISTORY command` | 返回时间戳与延迟序列 |
| 让 Redis 给出诊断建议 | `LATENCY DOCTOR` | 根据已记录事件生成可读的分析与建议 |
| 看 fork 耗时 | `INFO stats` | `latest_fork_usec` 为最近一次 fork 微秒数，RDB / AOF 重写时的卡顿多来自这里 |

---

## 四、内存与淘汰

| 场景 | 命令 | 说明 |
|------|------|------|
| 看内存概况 | `INFO memory` | `used_memory_human` 为数据占用，`used_memory_rss_human` 为进程实际占用 |
| 看碎片率 | `INFO memory` | `mem_fragmentation_ratio` 大于 1.5 碎片较多，小于 1 说明发生了 swap |
| 让 Redis 诊断内存 | `MEMORY DOCTOR` | 输出碎片、峰值等问题的说明 |
| 看内存明细 | `MEMORY STATS` | 数据集、复制缓冲、客户端缓冲、AOF 缓冲各占多少 |
| 开启主动碎片整理 | `CONFIG SET activedefrag yes` | 需 jemalloc；整理会占用 CPU，配合 `active-defrag-*` 参数限速 |
| 看内存上限与策略 | `CONFIG GET maxmemory*` | 缓存场景 `maxmemory` 必须设置，策略常用 `allkeys-lru` 或 `allkeys-lfu` |
| 调整淘汰策略 | `CONFIG SET maxmemory-policy allkeys-lfu` | 动态生效；需持久化时再执行 `CONFIG REWRITE` |
| 看淘汰与过期数量 | `INFO stats` | `evicted_keys` 增长说明内存已满在淘汰，`expired_keys` 为过期删除数 |
| 把运行时配置写回文件 | `CONFIG REWRITE` | 否则 `CONFIG SET` 的修改重启后丢失 |

---

## 五、慢日志

| 场景 | 命令 | 说明 |
|------|------|------|
| 看最近慢命令 | `SLOWLOG GET 10` | 每条含 ID、时间戳、耗时（微秒）、命令与参数、客户端地址 |
| 看慢日志条数 | `SLOWLOG LEN` | 结合 `slowlog-max-len` 判断是否已被覆盖 |
| 清空慢日志 | `SLOWLOG RESET` | 优化上线后清空，便于观察效果 |
| 设置慢命令阈值 | `CONFIG SET slowlog-log-slower-than 10000` | 单位微秒，10000 即 10 毫秒；默认 10000 |
| 设置慢日志保留条数 | `CONFIG SET slowlog-max-len 1024` | 默认 128，高峰期容易被刷掉 |

::: tip 慢日志只统计执行耗时
慢日志不含网络往返和排队时间。客户端超时但慢日志为空时，看 `--latency`、`LATENCY LATEST` 与客户端连接池，问题多在网络、fork 或排队上。
:::

---

## 六、客户端连接

| 场景 | 命令 | 说明 |
|------|------|------|
| 看连接总数 | `INFO clients` | `connected_clients`、`blocked_clients`；对比 `CONFIG GET maxclients` |
| 列出普通客户端 | `CLIENT LIST TYPE normal` | `idle` 为空闲秒数，`omem` 为输出缓冲占用，`cmd` 为最后执行的命令 |
| 断开指定连接 | `CLIENT KILL ID 1234` | ID 来自 `CLIENT LIST`；也可按 `ADDR ip:port` 或 `USER` 断开 |
| 看输出缓冲限制 | `CONFIG GET client-output-buffer-limit` | 一次返回大量数据或订阅消费慢会触发断连 |
| 自动断开空闲连接 | `CONFIG SET timeout 300` | 单位秒，默认 0 不断开；客户端有连接池时谨慎设置 |

---

## 七、持久化

| 场景 | 命令 | 说明 |
|------|------|------|
| 看持久化状态 | `INFO persistence` | `rdb_last_bgsave_status`、`aof_last_write_status` 应为 `ok` |
| 手动触发 RDB | `BGSAVE` | 后台 fork 子进程生成快照，大实例 fork 可能卡顿数百毫秒 |
| 看最近一次 RDB 时间 | `LASTSAVE` | 返回 Unix 时间戳 |
| 手动重写 AOF | `BGREWRITEAOF` | AOF 过大时执行，同样依赖 fork |
| 远程拉取 RDB 备份 | `redis-cli --rdb /backup/dump.rdb` | 通过复制协议获取快照，脚本中要检查返回码 |

---

## 八、主从与哨兵

| 场景 | 命令 | 说明 |
|------|------|------|
| 看复制状态 | `INFO replication` | 从库看 `master_link_status:up`；主库看各从库 `offset` 与 `lag` |
| 看节点角色 | `ROLE` | 返回 master / slave / sentinel 及复制偏移量 |
| 查询当前主库地址 | `redis-cli -p 26379 SENTINEL get-master-addr-by-name mymaster` | 连哨兵端口执行，`mymaster` 为配置中的主库名 |
| 看哨兵管理的从库 | `redis-cli -p 26379 SENTINEL replicas mymaster` | 查看各从库状态与延迟 |
| 手动触发故障转移 | `redis-cli -p 26379 SENTINEL failover mymaster` | 无需其他哨兵同意，直接切换，用于演练或计划内维护 |

---

## 九、Cluster

| 场景 | 命令 | 说明 |
|------|------|------|
| 看集群状态 | `CLUSTER INFO` | `cluster_state:ok`，`cluster_slots_assigned` 应为 16384，`cluster_slots_fail` 应为 0 |
| 看节点与槽分布 | `CLUSTER NODES` | 每行一个节点：ID、地址、角色、主节点 ID、连接状态、槽范围 |
| 按分片看拓扑 | `CLUSTER SHARDS` | 结构化输出每个分片的槽与主从节点，替代旧的 `CLUSTER SLOTS` |
| 全面检查集群 | `redis-cli --cluster check 10.0.0.1:6379` | 检查槽覆盖、节点一致性、迁移中的槽 |
| 看各主节点 key 与槽数 | `redis-cli --cluster info 10.0.0.1:6379` | 判断数据是否倾斜 |
| 在所有节点执行命令 | `redis-cli --cluster call 10.0.0.1:6379 INFO memory` | 一次查看所有节点的内存，排查单节点异常 |
| 修复槽异常 | `redis-cli --cluster fix 10.0.0.1:6379` | 修复未分配或卡在迁移中的槽，执行前先 `check` |
| 看 key 所在槽 | `CLUSTER KEYSLOT order:{1001}` | `{}` 内为哈希标签，同标签的 key 落在同一槽 |
| 看槽内 key 数量 | `CLUSTER COUNTKEYSINSLOT 5798` | 只能查询本节点负责的槽 |
| 列出槽内 key | `CLUSTER GETKEYSINSLOT 5798 10` | 返回最多 10 个 key，用于定位热点槽里的 key |
| 均衡槽分布 | `redis-cli --cluster rebalance 10.0.0.1:6379` | 加减节点后执行，迁移期间有额外负载 |
| 新增从节点 | `redis-cli --cluster add-node 10.0.0.7:6379 10.0.0.1:6379 --cluster-slave --cluster-master-id <master-id>` | 第一个地址为新节点，第二个为集群中任一节点 |
| 手动主从切换 | `CLUSTER FAILOVER` | 在**从节点**上执行，与主节点同步完成后切换，不丢数据 |
| 看某主节点的从节点 | `CLUSTER REPLICAS <node-id>` | 确认每个主节点都有从节点 |

---

## 小结

最常用的 5 条：

1. `redis-cli --bigkeys -i 0.1`（或 `--memkeys`）：找大 Key
2. `SLOWLOG GET 10`：看慢命令
3. `INFO memory`：看内存与碎片率
4. `redis-cli --latency`：区分是 Redis 慢还是网络慢
5. `redis-cli --cluster check <host>:<port>`：检查集群健康

大 Key / 热 Key 的治理思路见 [Redis 实战](/cache/5_redis_practice)，淘汰与持久化原理见 [Redis 核心原理](/cache/2_redis_core)。

---

## 参考资料

- redis-cli 用法：[Redis CLI](https://redis.io/docs/latest/develop/tools/cli/)
- 延迟诊断：[Diagnosing latency issues](https://redis.io/docs/latest/operate/oss_and_stack/management/optimization/latency/)
- 延迟监控：[Redis latency monitoring](https://redis.io/docs/latest/operate/oss_and_stack/management/optimization/latency-monitor/)
- 内存优化：[Memory optimization](https://redis.io/docs/latest/operate/oss_and_stack/management/optimization/memory-optimization/)
- 淘汰策略：[Key eviction](https://redis.io/docs/latest/develop/reference/eviction/)
- 慢日志：[SLOWLOG GET](https://redis.io/docs/latest/commands/slowlog-get/)
- 集群运维：[Scale with Redis Cluster](https://redis.io/docs/latest/operate/oss_and_stack/management/scaling/)

> 下一篇：[Maven 与 Gradle 命令速查](./7_build)
