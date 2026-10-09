---
description: 五种基础类型、Bitmap / HLL / GEO / Stream、Redis 8 内置类型、字段过期、底层编码
---

# Redis 基础

> **本篇目标**：掌握 Redis 各数据类型的命令、典型用途与底层编码，知道 Redis 8 把哪些原 Stack 模块并入了核心，能为业务数据选对结构。
>
> **前置阅读**：[缓存总览](./0_overview)

Redis 是基于内存的键值数据库，Value 有多种数据类型，每种类型按数据量自动在紧凑编码和通用编码之间切换。本篇以 Redis 8.x 为基线，Valkey 8.x 对基础类型与命令完全兼容，但不包含 Redis 8 新增的 JSON、概率结构等内置类型。

---

## 一、五种基础数据类型

### 1、String

- 最基础的类型，Value 可以是字符串、整数或浮点数，最大 512MB
- 底层编码：`int`（整数）/ `embstr`（≤ 44 字节）/ `raw`（> 44 字节）

```bash
SET key value EX 60            # 设置值并带过期时间（原子）
GET key
INCR counter                   # 原子自增，适合计数器
MSET k1 v1 k2 v2               # 批量设置
SET lock:order:1 <uuid> NX PX 30000   # 不存在才设置并带过期时间，分布式锁的加锁写法
```

`SETNX` 不能同时设置过期时间，加锁后进程崩溃会留下永不过期的锁，官方已不推荐用它做锁。加锁用 `SET ... NX PX`，值写唯一标识，解锁用 Lua 先比对值再删除，完整写法与租约续期见 [分布式锁](/distributed/3_lock)。

**应用**：缓存对象（JSON 序列化）、计数器、分布式锁、限流计数

### 2、Hash

- 字段-值集合，适合存储对象
- 底层编码：`listpack`（字段数 ≤ 128 且每个值 ≤ 64 字节）/ `hashtable`

```bash
HSET user:1 name Alice age 20
HGET user:1 name
HMGET user:1 name age
HINCRBY user:1 age 1
HSCAN user:1 0 COUNT 100       # 大 Hash 用 HSCAN 分批读，避免 HGETALL
```

**哈希字段过期**：Redis 7.4 起可以给单个字段设置 TTL，8.0 又增加了读写时顺带设置或清除过期的命令。适合「一个用户一个 Hash，里面每个验证码 / 令牌各自过期」这类场景。

```bash
HEXPIRE user:1:tokens 600 FIELDS 1 t_abc     # 字段 t_abc 10 分钟后过期（7.4+）
HTTL user:1:tokens FIELDS 1 t_abc            # 查询字段剩余秒数
HSETEX user:1:tokens EX 600 FIELDS 1 t_def v # 设置字段并带过期时间（8.0+）
HGETDEL user:1:tokens FIELDS 1 t_abc         # 读出后删除字段，适合一次性令牌（8.0+）
```

**应用**：对象存储（支持单字段更新）、购物车、按字段过期的令牌集合

### 3、List

- 双端链表语义，支持头尾操作
- 底层编码：`listpack`（元素少且小）/ `quicklist`（由多个 listpack 节点组成的双向链表）

```bash
LPUSH list a b c               # 头部插入，结果为 c b a
RPUSH list x y z               # 尾部插入
LRANGE list 0 -1               # 获取全部（-1 表示最后一个）
BLPOP list 5                   # 阻塞弹出，超时 5 秒
BLMOVE src processing LEFT RIGHT 5   # 弹出并原子放入处理中列表，可靠队列写法（6.2+）
```

**应用**：最新动态列表（时间线）、简单任务队列；需要确认与重投时用 `BLMOVE` 或改用 Stream

### 4、Set

- 无序不重复集合
- 底层编码：`intset`（全部是整数且 ≤ 512 个）/ `listpack`（非整数的小集合，≤ 128 个且每个 ≤ 64 字节，7.2+）/ `hashtable`

```bash
SADD tags java redis
SISMEMBER tags java            # 判断是否存在
SINTER s1 s2                   # 交集（共同好友）
SUNION s1 s2                   # 并集
SDIFF s1 s2                    # 差集
SRANDMEMBER tags 3             # 随机取 3 个，不移除
SPOP tags 1                    # 随机弹出 1 个（抽奖不重复中奖）
```

**应用**：标签、共同好友、抽奖、去重

### 5、ZSet（Sorted Set）

- 有序不重复集合，每个成员关联一个 `score`，按 score 升序；score 相同时按成员字典序排列
- 底层编码：`listpack`（≤ 128 个成员且每个 ≤ 64 字节）/ `skiplist + hashtable`

```bash
ZADD rank 100 Alice 200 Bob
ZRANGE rank 0 9 REV WITHSCORES     # 降序 Top10（6.2+ 统一用 ZRANGE ... REV）
ZSCORE rank Alice
ZINCRBY rank 50 Alice
ZREVRANK rank Alice                # 降序排名，从 0 开始
ZRANGE rank 0 +inf BYSCORE LIMIT 0 100   # 按分数范围分页
```

**应用**：排行榜、延迟队列（score 存执行时间）、优先级队列、滑动窗口计数

---

## 二、扩展数据类型

### 1、Bitmap

- 基于 String 的位操作，适合海量布尔标记

```bash
SETBIT sign:202610:1001 8 1        # 用户 1001 在 10 月第 9 天签到（偏移从 0 开始）
GETBIT sign:202610:1001 8
BITCOUNT sign:202610:1001          # 当月签到天数
BITFIELD sign:202610:1001 GET u31 0   # 一次取出整月签到位，在应用里算连续天数
```

**应用**：签到、在线状态、布尔类批量标记

### 2、HyperLogLog

- 基数统计（不重复元素个数），每个 key 最多约 12KB，标准误差 0.81%
- 只能计数，不能取回元素，适合 **UV 统计** 这类不需要精确值的场景

```bash
PFADD uv:20261009 user1 user2 user3
PFCOUNT uv:20261009                # 近似基数
PFMERGE uv:week uv:20261009 uv:20261010   # 合并多天
```

### 3、GEO

- 地理位置，底层就是 ZSet（score 存 52 位 geohash）

```bash
GEOADD stores 116.40 39.90 beijing 121.47 31.23 shanghai
GEODIST stores beijing shanghai km
GEOSEARCH stores FROMLONLAT 116.40 39.90 BYRADIUS 5 km ASC COUNT 20   # 附近 5km
```

附近的人 / 门店的完整设计（分片、分页、精度）见 [附近的人](/scenario/12_geo_nearby)。

### 4、Stream

- Redis 5.0 引入的追加日志结构，支持消费组、确认（ACK）和待确认列表（PEL）
- 数据随 RDB / AOF 持久化，但持久化是异步的、主从复制也是异步的，故障时可能丢最近的消息

```bash
XADD orders MAXLEN ~ 100000 * product iPhone qty 1       # 追加并近似裁剪长度
XGROUP CREATE orders group1 $ MKSTREAM                   # 创建消费组（流不存在时一并创建）
XREADGROUP GROUP group1 c1 COUNT 10 BLOCK 2000 STREAMS orders >   # 读新消息
XACK orders group1 <message-id>                          # 处理成功后确认
XAUTOCLAIM orders group1 c2 60000 0-0 COUNT 10           # 接管超过 60 秒未确认的消息
```

未 ACK 的消息留在 PEL 中，消费者崩溃后要用 `XPENDING` / `XAUTOCLAIM` 接管重试。Stream 适合轻量、可容忍少量丢失的异步任务，对可靠性要求高的业务消息用专业 MQ，对比见 [消息队列基础](/messaging/1_basics)。

---

## 三、Redis 8 内置类型

Redis 8.0 起，原来需要单独加载模块（Redis Stack）的能力并入核心发行版，无需再装 RedisJSON、RedisBloom 等模块：

| 类型 | 命令前缀 | 典型用途 |
|------|---------|---------|
| JSON | `JSON.*` | 存取嵌套文档，按路径读写单个字段 |
| Bloom / Cuckoo 过滤器 | `BF.*` / `CF.*` | 防缓存穿透、去重；Cuckoo 支持删除 |
| Count-min sketch / Top-k | `CMS.*` / `TOPK.*` | 近似频次统计、热点 Top-N |
| t-digest | `TDIGEST.*` | 近似分位数（P99 延迟等） |
| Time Series | `TS.*` | 指标、传感器时序数据，支持降采样与聚合 |
| 查询引擎 | `FT.*` | 对 Hash / JSON 建二级索引，全文、数值、向量检索 |
| Vector Set（预览） | `V*`（如 `VADD` / `VSIM`） | 向量相似度检索，结构上类似 ZSet |

```bash
BF.RESERVE bf:product 0.001 1000000     # 误判率 0.1%，预计 100 万元素
BF.ADD bf:product 10086
BF.EXISTS bf:product 10086               # 1 表示可能存在，0 表示一定不存在

JSON.SET user:1 $ '{"name":"Alice","tags":["java"]}'
JSON.ARRAPPEND user:1 $.tags '"redis"'
JSON.GET user:1 $.name
```

这些类型在 Valkey 中需要另装模块（如 valkey-bloom、valkey-json），选型时要确认目标环境。

---

## 四、底层编码总结

| 类型 | 小数据编码 | 大数据编码 | 切换阈值（默认） |
|------|-----------|-----------|----------------|
| String | int / embstr | raw | 44 字节 |
| Hash | listpack | hashtable | `hash-max-listpack-entries 128` / `-value 64` |
| List | listpack | quicklist | `list-max-listpack-size -2`（单节点 8KB） |
| Set | intset / listpack | hashtable | `set-max-intset-entries 512`、`set-max-listpack-entries 128` |
| ZSet | listpack | skiplist + hashtable | `zset-max-listpack-entries 128` / `-value 64` |

用 `OBJECT ENCODING key` 查看实际编码。listpack 是 7.0 起替代 ziplist 的紧凑编码，消除了 ziplist 的连锁更新问题。

**ZSet 为什么用跳表而不是平衡树**：Redis 作者给出的理由是跳表实现和调试更简单、范围操作（`ZRANGE` / `ZRANGEBYSCORE`）只需找到起点后顺序遍历、内存占用可以通过层数概率调节。命令在单线程上执行，与锁粒度无关；跳表的节点分散在堆上，缓存局部性也并不比树好。另配一个 hashtable 是为了让 `ZSCORE` 做到 O(1)。

---

## 小结

- 五种基础类型覆盖绝大多数缓存需求；对象优先用 String（整体读写）或 Hash（单字段更新），大集合用 `*SCAN` 分批读
- 加锁用 `SET key uuid NX PX`，不要用 `SETNX` + `EXPIRE` 两步
- Redis 7.4 起 Hash 支持字段级 TTL，8.0 增加 `HGETEX` / `HSETEX` / `HGETDEL`
- Set 在 7.2 起对非整数小集合使用 listpack；所有类型都按阈值在紧凑编码与通用编码间切换
- Stream 有消费组和 PEL，但持久化与复制是异步的，强可靠消息用专业 MQ
- Redis 8 内置 JSON、Bloom / Cuckoo、Top-k、t-digest、Time Series、查询引擎和 Vector Set；Valkey 需要另装模块

## 参考资料

- Redis data types：[https://redis.io/docs/latest/develop/data-types/](https://redis.io/docs/latest/develop/data-types/)
- Redis Open Source 8.0 release notes：[https://redis.io/docs/latest/operate/oss_and_stack/stack-with-enterprise/release-notes/redisce/redisos-8.0-release-notes/](https://redis.io/docs/latest/operate/oss_and_stack/stack-with-enterprise/release-notes/redisce/redisos-8.0-release-notes/)
- HEXPIRE：[https://redis.io/docs/latest/commands/hexpire/](https://redis.io/docs/latest/commands/hexpire/)
- SET（含 NX / PX 与锁模式说明）：[https://redis.io/docs/latest/commands/set/](https://redis.io/docs/latest/commands/set/)
- Redis Streams：[https://redis.io/docs/latest/develop/data-types/streams/](https://redis.io/docs/latest/develop/data-types/streams/)
- Probabilistic data types：[https://redis.io/docs/latest/develop/data-types/probabilistic/](https://redis.io/docs/latest/develop/data-types/probabilistic/)
- Valkey 文档：[https://valkey.io/docs/](https://valkey.io/docs/)

> 下一篇：[Redis 核心原理](./2_redis_core) —— 线程模型、RDB / AOF 持久化、淘汰与过期、事务、Pipeline 与 Lua。
