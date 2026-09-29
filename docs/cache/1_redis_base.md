# Redis 基础

官网：[https://redis.io/](https://redis.io/) | 源码：[https://github.com/redis](https://github.com/redis)

## 一、五种基础数据类型

### String

- 最基础类型，Value 可以是字符串、整数、浮点数
- 底层编码：`int`（整数）/ `embstr`（≤44字节）/ `raw`（>44字节）
- 最大存储：512MB

```bash
SET key value EX 60      # 设置并设置过期时间（原子）
GET key
INCR counter             # 原子自增，适合计数器
MSET k1 v1 k2 v2         # 批量设置
SETNX key value          # 不存在时才设置（分布式锁基础）
```

**应用：** 缓存对象（JSON序列化）、计数器、分布式锁、限流

### Hash

- 键值对集合，适合存储对象字段
- 底层编码：`listpack`（小数据，≤128个field且value≤64字节）/ `hashtable`（超出阈值）

```bash
HSET user:1 name Alice age 20
HGET user:1 name
HMGET user:1 name age
HGETALL user:1
HINCRBY user:1 age 1
```

**应用：** 对象存储（比JSON更节省内存、支持单字段更新）、购物车

### List

- 双向链表，支持头尾操作
- 底层编码：`listpack`（小数据）/ `quicklist`（分段双向链表）

```bash
LPUSH list a b c         # 头部插入（c b a）
RPUSH list x y z         # 尾部插入
LPOP / RPOP              # 弹出
LRANGE list 0 -1         # 获取全部（-1=最后一个）
BLPOP list 5             # 阻塞弹出，超时5秒（消息队列）
```

**应用：** 消息队列（BLPOP）、最新动态列表（时间线）、任务队列

### Set

- 无序不重复集合
- 底层编码：`intset`（全为整数且≤512）/ `hashtable`

```bash
SADD tags java redis      # 添加
SMEMBERS tags             # 获取所有
SISMEMBER tags java       # 判断是否存在
SINTER s1 s2              # 交集（共同好友）
SUNION s1 s2              # 并集
SDIFF s1 s2               # 差集
SRANDMEMBER tags 3        # 随机取3个（抽奖）
```

**应用：** 标签系统、共同好友、抽奖、去重

### ZSet（Sorted Set）

- 有序不重复集合，每个元素关联一个 `score`，按 score 升序
- 底层编码：`listpack`（≤128个元素且元素≤64字节）/ `skiplist + hashtable`

```bash
ZADD rank 100 Alice 200 Bob    # 添加
ZRANGE rank 0 -1 WITHSCORES   # 升序
ZREVRANGE rank 0 9            # 降序 Top10
ZSCORE rank Alice             # 查询分数
ZINCRBY rank 50 Alice         # 增加分数
ZRANK rank Alice              # 排名（从0）
```

**应用：** 排行榜、延迟队列（score=时间戳）、优先级队列

---

## 二、四种高级数据类型

### HyperLogLog

- 基数统计（不重复元素个数），内存极小（12KB），误差 0.81%
- 适合**UV 统计**（不需要精确值的场景）

```bash
PFADD uv user1 user2 user3
PFCOUNT uv               # 返回近似基数
PFMERGE result uv1 uv2   # 合并
```

### Bitmap

- 位图，适合状态标记类大数据量统计

```bash
SETBIT sign:2024:user1 180 1   # 第180天签到
GETBIT sign:2024:user1 180
BITCOUNT sign:2024:user1       # 总签到天数
```

**应用：** 用户签到、在线状态、布尔类批量标记

### GEO

- 地理位置，底层是 ZSet（score 存 geohash 编码）

```bash
GEOADD stores 116.4 39.9 "beijing"
GEODIST stores beijing shanghai km
GEOSEARCH stores FROMLONLAT 116.4 39.9 BYRADIUS 5 km ASC  # 附近5km
```

### Stream

- Redis 5.0 引入，持久化消息队列，支持消费组

```bash
XADD orders * product iPhone qty 1   # 追加消息（*=自动ID）
XREAD COUNT 10 STREAMS orders 0      # 读取
XGROUP CREATE orders group1 $         # 创建消费组
XREADGROUP GROUP group1 consumer1 COUNT 1 STREAMS orders >  # 消费
XACK orders group1 <message-id>       # 确认
```

---

## 三、底层编码总结

| 类型 | 小数据编码 | 大数据编码 |
|------|-----------|-----------|
| String | int / embstr | raw |
| Hash | listpack | hashtable |
| List | listpack | quicklist |
| Set | intset | hashtable |
| ZSet | listpack | skiplist + hashtable |

**skiplist（跳表）** 为什么比红黑树更适合 ZSet？
- 范围查询（`ZRANGE`）更高效：跳表天然有序，范围操作 O(log N + M)
- 实现更简单，锁粒度更细，并发友好
- 内存局部性好，缓存友好

---

## 四、常见面试问题

**Q：Redis 为什么快？**
1. 纯内存操作，无磁盘 IO（持久化异步）
2. 单线程命令处理，无锁竞争
3. IO 多路复用（epoll），高并发连接
4. 高效数据结构（跳表/压缩列表等）
5. C 语言实现，底层高效

**Q：String 和 Hash 存对象哪个更好？**
- Hash 更节省内存（listpack 紧凑存储），且支持单字段更新，不用反序列化整个对象
- String 更简单，适合整体读写、跨语言序列化
- 对象字段少且频繁更新单字段时选 Hash；整体读写选 String

**Q：ZSet 底层为什么同时用 skiplist 和 hashtable？**
skiplist 维护有序性，支持范围查询；hashtable 支持 O(1) 的 `ZSCORE` 查询。两者配合，使 ZSet 既支持高效排名又支持快速分数查找。
