---
description: UUIDv7、步长自增、雪花算法与时钟回拨、号段与双 Buffer、Leaf、UidGenerator
---

# 分布式 ID 生成

> 前置阅读：[分布式架构](./1_distributed)

分布式 ID 生成要在多节点下产出全局唯一、趋势递增的标识。本篇讲 UUID（含 v7）、数据库自增、雪花算法、号段模式的原理与适用边界，以及时钟回拨、workerId 分配、前端精度丢失、分片倾斜等生产问题和 Leaf、UidGenerator 的设计。

---

## 一、核心要求

| 要求 | 说明 |
|------|------|
| 全局唯一 | 不同节点、不同时间生成的 ID 不重复，这是唯一不能妥协的要求 |
| 趋势递增 | 主键写入 B+ 树时追加在末尾，避免随机插入导致页分裂 |
| 高性能、高可用 | 发号不能成为瓶颈或单点 |
| 不泄露业务信息 | 连续 ID 能被推算出订单量，对外暴露时要考虑 |

其中「趋势递增」与「不泄露业务量」是互相冲突的：越有序越容易被推算。常见做法是内部主键用有序 ID，对外展示的订单号、短链另行编码或加入随机成分。

---

## 二、UUID

128 位，标准文本形式 36 个字符，如 `550e8400-e29b-41d4-a716-446655440000`。

| 版本 | 生成方式 | 特点 |
|------|----------|------|
| v1 | 时间戳 + MAC 地址 | 时间戳的低位放在最前面，**按字节序并不有序**；还会暴露 MAC |
| v4 | 122 位随机数 | 最常用，完全无序 |
| **v7** | 前 48 位是 Unix 毫秒时间戳，其余为随机数（RFC 9562，2024 年 5 月） | 按时间有序，适合做主键 |

v4 作主键的问题是随机插入导致 B+ 树频繁页分裂、缓存命中率低；v7 按时间递增，插入集中在索引末尾，基本消除了这个问题，又保留了 UUID「本地生成、无需协调」的优点。

JDK 21 / 25 只内置 v3 / v4（`UUID.randomUUID()`），v7 需要第三方库：

```java
// com.github.f4b6a3:uuid-creator
UUID id = UuidCreator.getTimeOrderedEpoch();

// 或 com.fasterxml.uuid:java-uuid-generator 5.x
UUID id2 = Generators.timeBasedEpochGenerator().generate();
```

存储建议：MySQL 用 `BINARY(16)` 而不是 `CHAR(36)`（`UUID_TO_BIN(uuid)`，v7 不要加交换时间位的参数，那个参数是给 v1 用的）；PostgreSQL 用原生 `uuid` 类型，PostgreSQL 18 起内置 `uuidv7()` 函数。

UUID 仍比 64 位 ID 占空间（16 字节，二级索引都要存一份主键），对存储敏感的大表优先用 64 位方案。v4 适合做幂等键、链路追踪 ID 这类不需要有序的场景。

---

## 三、数据库自增

单库 `AUTO_INCREMENT` 简单可靠，但所有写入都依赖这一个库。

多主步长方案：N 个数据库实例设置相同步长、不同起始值，各自自增：

```sql
-- 实例 1（实例 2、3 的 offset 分别为 2、3）
SET PERSIST auto_increment_increment = 3;
SET PERSIST auto_increment_offset = 1;   -- 生成 1, 4, 7, 10 ...
```

这两个变量不加 `GLOBAL` / `PERSIST` 只对当前会话生效；也可以写进 `my.cnf`。缺点是扩容时要重新规划步长，各实例之间不保证全局递增。

---

## 四、雪花算法（Snowflake）

### 1、结构

Twitter 在 2010 年开源，64 位 long：

![Snowflake ID 64 位结构](../assets/database/snowflake-id.svg)

- **1 位符号位**：固定为 0，保证是正数
- **41 位时间戳**：相对自定义起始时间的毫秒数，约可用 69 年
- **10 位机器 ID**：最多 1024 个节点，可拆成 5 位数据中心 + 5 位机器
- **12 位序列号**：同一毫秒内最多 4096 个 ID，单节点理论上每秒约 409 万个

### 2、实现

```java
public final class SnowflakeIdGenerator {

    private static final long EPOCH = 1735689600000L;           // 2025-01-01T00:00:00Z
    private static final long WORKER_BITS = 10L;
    private static final long SEQUENCE_BITS = 12L;
    private static final long MAX_WORKER_ID = ~(-1L << WORKER_BITS);     // 1023
    private static final long SEQUENCE_MASK = ~(-1L << SEQUENCE_BITS);   // 4095
    private static final long TIMESTAMP_SHIFT = WORKER_BITS + SEQUENCE_BITS;
    private static final long MAX_BACKWARD_MS = 5L;

    private final long workerId;
    private long lastTimestamp = -1L;
    private long sequence = 0L;

    public SnowflakeIdGenerator(long workerId) {
        if (workerId < 0 || workerId > MAX_WORKER_ID) {
            throw new IllegalArgumentException("workerId 超出范围: " + workerId);
        }
        this.workerId = workerId;
    }

    public synchronized long nextId() {
        long now = System.currentTimeMillis();
        if (now < lastTimestamp) {
            long offset = lastTimestamp - now;
            if (offset > MAX_BACKWARD_MS) {
                throw new IllegalStateException("时钟回拨 " + offset + "ms，拒绝生成 ID");
            }
            now = waitUntilAfter(lastTimestamp - 1);              // 小幅回拨：等时钟追上
        }
        if (now == lastTimestamp) {
            sequence = (sequence + 1) & SEQUENCE_MASK;
            if (sequence == 0) {
                now = waitUntilAfter(lastTimestamp);              // 本毫秒用完，等下一毫秒
            }
        } else {
            sequence = 0L;
        }
        lastTimestamp = now;
        return ((now - EPOCH) << TIMESTAMP_SHIFT) | (workerId << SEQUENCE_BITS) | sequence;
    }

    private static long waitUntilAfter(long timestamp) {
        long now = System.currentTimeMillis();
        while (now <= timestamp) {
            Thread.onSpinWait();
            now = System.currentTimeMillis();
        }
        return now;
    }
}
```

### 3、时钟回拨

NTP 校时、人工改时间、虚拟机迁移都可能让系统时间倒退，若不处理会生成重复 ID。应对思路：

- 小幅回拨（几毫秒）：等待时钟追上，上面的实现就是这样
- 大幅回拨：拒绝发号并告警，由调用方重试到其他节点；或切换到预留的备用 workerId
- 启动时校验：记录上次使用的时间戳，启动时发现当前时间更早就拒绝启动（Leaf 的做法）
- 不依赖实时时钟：用自增的「逻辑秒」代替系统时间（UidGenerator 的做法）

服务器侧应让 NTP 平滑调整（slew）而不是跳变（step）。

### 4、生产中的坑

- **workerId 冲突**：Hutool `IdUtil.getSnowflake()`、MyBatis-Plus 默认 `IdentifierGenerator` 在未指定时用 MAC 地址和进程号推导 workerId，容器中进程号常常都是 1、网卡信息也可能雷同，存在冲突风险。生产环境应显式分配：从配置中心、数据库表或 ZooKeeper / etcd 领取，或用 K8s StatefulSet 的序号
- **前端精度丢失**：64 位 ID 超过 JavaScript `Number.MAX_SAFE_INTEGER`（2^53 − 1），前端会把末几位变成 0。接口中把 ID 序列化为字符串（Jackson 的 `ToStringSerializer` 或全局把 `Long` 序列化为字符串）
- **分片倾斜**：低 QPS 时每毫秒往往只生成一个 ID，序列号几乎总是 0，再按 `id % 分片数` 路由会严重倾斜。分片键应先做哈希，或让序列号从随机值起步，见 [分库分表与中间件](/database/5_practice/2_sharding)

ShardingSphere 内置 `SNOWFLAKE` 主键生成器，用分库分表中间件时可以直接使用。

---

## 五、号段模式

### 1、原理

每次从数据库**批量领取**一段 ID（号段）放在内存里发放，用完再领下一段，数据库访问次数降低到原来的 1/step。

```sql
CREATE TABLE leaf_alloc (
    biz_tag     VARCHAR(128) NOT NULL PRIMARY KEY,   -- 业务标识
    max_id      BIGINT       NOT NULL,               -- 已分配出去的最大 ID
    step        INT          NOT NULL,               -- 号段长度
    update_time DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);
```

领取号段在一个事务里完成，`UPDATE` 持有的行锁保证多个节点并发领取时互不重叠：

```sql
BEGIN;
UPDATE leaf_alloc SET max_id = max_id + step WHERE biz_tag = 'order';
SELECT max_id, step FROM leaf_alloc WHERE biz_tag = 'order';
COMMIT;
-- 本节点可用区间：[max_id - step + 1, max_id]
```

不需要额外的版本号做乐观锁，那样在并发领取时只会产生大量重试。

### 2、双 Buffer

单 Buffer 在号段用完时才去数据库领取，这一刻的请求要等一次数据库往返；数据库抖动时还会直接失败。双 Buffer 提前预取：

![Leaf-Segment 双 Buffer](../assets/distributed/leaf-segment-double-buffer.svg)

- 当前号段消耗超过 10% 且备用号段为空时，异步线程去数据库领取下一段
- 当前号段用完后直接切换到备用号段，不等待
- 号段长度可以按领取频率动态调整（Leaf 会让两次领取间隔接近 15 分钟），数据库短暂不可用期间仍能靠内存里的号段继续发号

### 3、有序性

每个节点各自持有不同的号段，所以 ID **只在单个节点内单调递增**，多个节点交替发放时整体只是趋势递增。另外重启会丢弃内存中未发完的号段，ID 不连续，业务不能依赖「连续」。

---

## 六、美团 Leaf

Leaf 同时提供号段模式与雪花模式，以独立服务部署，业务通过 HTTP / RPC 获取 ID。

### 1、Leaf-Segment

即上面的号段模式 + 双 Buffer，**只依赖数据库**（`leaf_alloc` 表），数据库用主从或高可用集群保证可用性。

### 2、Leaf-Snowflake

雪花模式，用 ZooKeeper 解决 workerId 分配与时钟校验：

- 启动时在 ZooKeeper 的 `leaf_forever` 下创建持久顺序节点，序号即 workerId，并在本地文件缓存一份，ZooKeeper 不可用时也能用缓存的 workerId 启动（弱依赖）
- 已注册过的节点启动时，比较本机时间与自己节点上最后上报的时间，本机时间更早说明发生了大幅回拨，拒绝启动并告警
- 新节点启动时，比较本机时间与其他存活节点上报时间的平均值，差异超过阈值则拒绝启动
- 运行中每 3 秒把本机时间上报到自己的节点；发号时遇到回拨不超过 5ms 就等待后重试，超过则报错

### 3、现状

Leaf 的开源仓库自 2020 年前后基本不再更新，可以作为设计参考或在其基础上自研；需要现成组件时，也可以选择分库分表中间件内置的生成器或其他活跃的开源发号服务。

---

## 七、百度 UidGenerator

基于 Snowflake 思路，重新分配了位数，并用 RingBuffer 缓存预生成的 ID：

- **默认位分配**：1 位符号 + 28 位时间差（秒级，约 8.7 年）+ 22 位 workerId + 13 位序列号，可按部署规模和并发通过 `BitsAllocator` 调整
- **workerId**：启动时向数据库表 `WORKER_NODE` 插入一行，用自增主键作为 workerId，**每次重启都使用新的 workerId**，所以 22 位留得很宽
- **DefaultUidGenerator**：实时计算，检测到时钟回拨会抛异常
- **CachedUidGenerator**：启动时填满 RingBuffer，取 ID 直接从环上读；剩余量低于阈值（默认一半）时异步补充，也可以配置定时补充。它的「时间」是一个从启动时刻起自增的秒数计数器，序列号用完就借用下一秒，不再读取实时时钟，因此运行期间不受时钟回拨影响；加上重启换新 workerId，重启后的回拨也不会撞号

代价是时间戳部分不再精确对应真实时间，单位为秒，不适合需要从 ID 解析出精确生成时间的场景。

---

## 八、方案对比与选型

| 方案 | 有序性 | 长度 | 性能 | 依赖 | 主要风险 |
|------|--------|------|------|------|----------|
| UUID v4 | 无序 | 128 位 | 本地生成，极高 | 无 | 作主键导致页分裂 |
| UUID v7 | 按毫秒有序 | 128 位 | 本地生成，极高 | 第三方库 | 占用空间大 |
| 数据库自增 | 单库严格递增，多主仅各自递增 | 64 位 | 受限于数据库 | 数据库 | 单点、扩容难 |
| Snowflake | 趋势递增 | 64 位 | 本地生成，极高 | 时钟、workerId 分配 | 时钟回拨、workerId 冲突 |
| 号段模式 / Leaf-Segment | 节点内递增，全局趋势递增 | 64 位 | 内存发号，极高 | 数据库 | 重启丢号段 |
| Leaf-Snowflake | 趋势递增 | 64 位 | 极高 | ZooKeeper（弱依赖） | 项目不再活跃 |
| UidGenerator（Cached） | 趋势递增 | 64 位 | 极高 | 数据库（分配 workerId） | 时间精度为秒 |

选型建议：

| 场景 | 推荐 |
|------|------|
| 新项目、不想引入发号服务，接受 128 位 | UUID v7 |
| 64 位主键、实例规模可控 | Snowflake，显式分配 workerId 并处理时钟回拨 |
| 只想依赖数据库、需要更强的递增性 | 号段模式 + 双 Buffer |
| 使用 ShardingSphere 分库分表 | 内置 `SNOWFLAKE` 或自定义 `KeyGenerateAlgorithm` 对接发号服务 |
| 幂等键、链路追踪 ID | UUID v4 |

---

## 小结

- 全局唯一是硬要求，有序与不泄露业务量要权衡
- UUID v1 并不有序；UUID v7 按时间有序，是需要 UUID 主键时的首选，MySQL 存 `BINARY(16)`
- 多主步长自增要用 `SET GLOBAL` / `SET PERSIST` 或配置文件，会话级设置无效
- Snowflake 要处理时钟回拨、显式分配 workerId，并把 ID 以字符串形式返回给前端
- 号段模式在一个事务内 `UPDATE` 后 `SELECT` 领取号段，双 Buffer 预取；ID 只在节点内递增
- Leaf-Segment 只依赖数据库，Leaf-Snowflake 用 ZooKeeper 分配 workerId 并校验时钟
- UidGenerator 的 CachedUidGenerator 用自增秒计数器借用未来时间，规避时钟回拨

## 参考资料

- RFC 9562 Universally Unique IDentifiers：[https://www.rfc-editor.org/rfc/rfc9562](https://www.rfc-editor.org/rfc/rfc9562)
- Twitter, Announcing Snowflake：[https://blog.x.com/engineering/en_us/a/2010/announcing-snowflake](https://blog.x.com/engineering/en_us/a/2010/announcing-snowflake)
- 美团技术团队，Leaf：美团分布式 ID 生成服务开源：[https://tech.meituan.com/2017/04/21/mt-leaf.html](https://tech.meituan.com/2017/04/21/mt-leaf.html)
- Meituan-Dianping/Leaf：[https://github.com/Meituan-Dianping/Leaf](https://github.com/Meituan-Dianping/Leaf)
- baidu/uid-generator：[https://github.com/baidu/uid-generator](https://github.com/baidu/uid-generator)
- uuid-creator：[https://github.com/f4b6a3/uuid-creator](https://github.com/f4b6a3/uuid-creator)
- MySQL UUID_TO_BIN()：[https://dev.mysql.com/doc/refman/8.4/en/miscellaneous-functions.html#function_uuid-to-bin](https://dev.mysql.com/doc/refman/8.4/en/miscellaneous-functions.html#function_uuid-to-bin)
- MySQL auto_increment_increment：[https://dev.mysql.com/doc/refman/8.4/en/replication-options-source.html#sysvar_auto_increment_increment](https://dev.mysql.com/doc/refman/8.4/en/replication-options-source.html#sysvar_auto_increment_increment)
- PostgreSQL UUID Functions：[https://www.postgresql.org/docs/current/functions-uuid.html](https://www.postgresql.org/docs/current/functions-uuid.html)

> 下一篇：[一致性哈希](./9_consistent_hashing) —— 哈希环、虚拟节点、Jump Hash 等变体，以及 Redis Cluster 槽位与 Kafka 分区路由的区别。
