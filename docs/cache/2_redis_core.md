# Redis 核心原理

## 一、线程模型

### 单线程命令处理

Redis 命令处理是**单线程**的（Redis 6.0 以前网络 IO 也是单线程），核心原因：
- 避免多线程的锁竞争和上下文切换开销
- 内存操作足够快，CPU 不是瓶颈（瓶颈通常在网络 IO）

```
客户端连接 → IO多路复用（epoll）→ 事件队列 → 单线程顺序执行命令 → 返回结果
```

### Redis 6.0 多线程 IO

Redis 6.0 引入多线程处理**网络 IO**（读取和解析请求、写回响应），但**命令执行仍是单线程**：

```
多线程读取请求 → 单线程执行命令 → 多线程写回响应
```

参数：`io-threads 4`（默认1，建议设为 CPU 核数 - 1）

---

## 二、持久化机制

### RDB（Redis Database）

定时将内存数据**快照**写入 `.rdb` 文件。

```bash
# redis.conf 配置（满足任一条件触发）
save 900 1      # 900秒内有1次修改
save 300 10     # 300秒内有10次修改
save 60 10000   # 60秒内有10000次修改

# 手动触发
BGSAVE          # 后台异步（fork子进程），推荐
SAVE            # 阻塞，生产环境禁用
```

**原理（写时复制 Copy-On-Write）：**
`BGSAVE` fork 出子进程，子进程遍历内存写 RDB；父进程继续处理请求，写操作触发 COW（修改的页才复制）。

**优点：** 文件紧凑，恢复速度快，适合全量备份
**缺点：** 两次快照间的数据可能丢失（默认最多丢失几分钟数据）

### AOF（Append Only File）

将每条写命令追加到 `.aof` 文件。

```bash
appendonly yes
appendfsync everysec    # always（最安全，每次写）/ everysec（推荐）/ no（最快，不可靠）
```

**AOF 重写（Rewrite）：** 日志文件过大时，Redis fork 子进程重写，将内存数据转为最小指令集（如将多次 INCR 合并为一个 SET）：
```bash
BGREWRITEAOF     # 手动触发
# 自动触发
auto-aof-rewrite-percentage 100   # 文件比上次大100%时
auto-aof-rewrite-min-size 64mb    # 且文件大于64MB
```

**优点：** 数据安全性高，最多丢失1秒数据（everysec）
**缺点：** 文件较大，恢复速度慢于 RDB

### RDB + AOF 混合持久化（推荐，Redis 4.0+）

```bash
aof-use-rdb-preamble yes   # 开启混合持久化
```

AOF 文件前半段是 RDB 格式快照，后半段是增量 AOF 命令，兼顾恢复速度和数据安全性。

### 选型建议

| 场景 | 推荐 |
|------|------|
| 可接受几分钟数据丢失 | RDB |
| 最多丢失1秒数据 | AOF（everysec）|
| 生产环境标准配置 | RDB + AOF 混合持久化 |
| 纯缓存（允许丢失）| 关闭持久化 |

---

## 三、缓存淘汰策略

当内存达到 `maxmemory` 上限时触发。

```bash
maxmemory 4gb
maxmemory-policy allkeys-lru    # 淘汰策略
```

| 策略 | 说明 | 推荐场景 |
|------|------|---------|
| `noeviction` | 不淘汰，写操作报错 | 不适合缓存 |
| `allkeys-lru` | 所有 key 中淘汰最近最少使用 | **通用缓存首选** |
| `allkeys-lfu` | 所有 key 中淘汰访问频率最低 | 热点数据差异大时更优 |
| `allkeys-random` | 随机淘汰 | 很少用 |
| `volatile-lru` | 有过期时间的 key 中淘汰 LRU | 部分 key 不希望被淘汰 |
| `volatile-lfu` | 有过期时间的 key 中淘汰 LFU | 同上 |
| `volatile-ttl` | 淘汰即将过期的 key | 同上 |
| `volatile-random` | 有过期时间的 key 中随机淘汰 | 很少用 |

**LRU vs LFU：**
- LRU：最近最少使用，容易受偶发性批量访问影响（扫描一次就把热数据替换掉）
- LFU：访问频率最低，对真正的热点数据保护更好，Redis 4.0 引入

---

## 四、过期键删除策略

Redis 对设置了 `EXPIRE` 的 key 使用两种策略组合：

**惰性删除：** 访问时检查是否过期，过期则删除并返回 nil。节省 CPU 但过期 key 可能长期占用内存。

**定期删除：** 每隔一定时间（默认100ms）随机抽取一批设置了过期时间的 key，删除其中已过期的。抽取比例超过25%时立即再次扫描。

两种策略互补：惰性删除保证读到的一定是有效数据，定期删除清理长期未访问的过期 key。

---

## 五、事务与 Pipeline

### 事务（MULTI/EXEC）

```bash
MULTI              # 开启事务
SET k1 v1
INCR counter
EXEC               # 提交执行
DISCARD            # 放弃事务
```

**注意：** Redis 事务不支持回滚——命令入队时的语法错误会导致整个事务取消；运行时错误（如对 String 执行 INCR）只跳过该命令，其他命令继续执行。

### WATCH（乐观锁）

```bash
WATCH balance          # 监视 key
MULTI
DECRBY balance 100
EXEC                   # 若 balance 在 WATCH 后被修改，EXEC 返回 nil（事务失败）
```

### Pipeline

批量发送命令，减少网络往返次数（RTT）：

```java
// Lettuce Pipeline
redisTemplate.executePipelined((RedisCallback<Object>) connection -> {
    for (int i = 0; i < 1000; i++) {
        connection.set(("key:" + i).getBytes(), ("val:" + i).getBytes());
    }
    return null;
});
```

**Pipeline vs 事务：** Pipeline 是客户端批量发送，命令不保证原子性；事务由服务端原子执行，但不支持回滚。

### Lua 脚本（原子操作首选）

```bash
# 原子扣减库存
EVAL "
  local stock = redis.call('get', KEYS[1])
  if tonumber(stock) > 0 then
    redis.call('decrby', KEYS[1], ARGV[1])
    return 1
  end
  return 0
" 1 product:stock 1
```

Lua 脚本在 Redis 中原子执行（不可被其他命令插入），是分布式场景下复合操作的最佳方案。

---

## 六、常见面试问题

**Q：Redis 持久化 RDB 和 AOF 哪个更好？**
没有绝对好坏，看场景。RDB 恢复快适合全量备份；AOF 数据更安全；生产环境推荐两者同时开启（混合持久化），重启时优先使用 AOF 恢复。

**Q：Redis 的过期 key 是如何清理的？**
两种策略配合：惰性删除（访问时检查）+ 定期删除（随机抽样扫描）。如果内存不足，还会触发淘汰策略主动驱逐。

**Q：Redis 事务和 MySQL 事务有什么区别？**
Redis 事务不支持回滚（运行时错误不回滚），不满足 ACID 中的 Atomicity（对运行时错误来说）；MySQL 事务支持完整 ACID。Redis 通常用 Lua 脚本实现真正的原子操作。
