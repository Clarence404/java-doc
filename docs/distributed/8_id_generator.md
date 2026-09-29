# 分布式 ID 生成

> 分布式系统中，多个实例无法依赖单库自增 ID，需要全局唯一、有序、高性能的 ID 生成方案。

---

## 一、核心要求

| 要求 | 说明 |
|------|------|
| 全局唯一 | 不同节点、不同时间生成的 ID 不重复 |
| 趋势递增 | 数据库 B+ 树索引友好，避免页分裂 |
| 高性能 | 单机 10w+ QPS，不成为系统瓶颈 |
| 高可用 | ID 生成服务不能成为单点 |
| 信息安全 | ID 不能暴露业务量（避免被竞争对手分析） |

---

## 二、UUID

### 2.1 原理

128 位数字，通常表示为 32 位十六进制字符串，标准格式：`550e8400-e29b-41d4-a716-446655440000`。

版本：
- **UUID v1**：基于时间戳 + MAC 地址，有序但暴露 MAC
- **UUID v4**：随机生成，最常用

```java
String id = UUID.randomUUID().toString();
```

### 2.2 优缺点

| 优点 | 缺点 |
|------|------|
| 本地生成，无网络依赖 | 无序，写入 MySQL 导致 B+ 树页分裂，性能差 |
| 实现极简 | 字符串类型，存储空间大（36字节） |
| 唯一性有保障 | 不携带业务语义 |

**结论**：不适合作为数据库主键，可用于幂等 key、链路追踪 ID 等对顺序无要求的场景。

---

## 三、数据库自增 ID

### 3.1 单库自增

MySQL `AUTO_INCREMENT`，简单可靠，但单点瓶颈。

### 3.2 多主自增（步长方案）

多个 MySQL 实例，设置不同初始值和步长：

```sql
-- 实例1
SET auto_increment_offset = 1;
SET auto_increment_increment = 3;  -- 生成：1, 4, 7, 10...

-- 实例2
SET auto_increment_offset = 2;
SET auto_increment_increment = 3;  -- 生成：2, 5, 8, 11...

-- 实例3
SET auto_increment_offset = 3;
SET auto_increment_increment = 3;  -- 生成：3, 6, 9, 12...
```

**缺点**：扩容困难，增加实例需要重新分配步长。

---

## 四、雪花算法（Snowflake）

### 4.1 结构

Twitter 开源，64 位 long 型整数：

```
┌─────────────────────────────────────────────────────────────────────┐
│  1 bit  │    41 bit       │   10 bit    │      12 bit               │
│ 符号位  │  毫秒级时间戳   │   机器 ID   │  同一毫秒内序列号（0-4095）│
│   (0)   │ (最长约 69 年)  │ (最多1024台)│                           │
└─────────────────────────────────────────────────────────────────────┘
```

- **41 bit 时间戳**：`当前时间 - 起始时间`，约可用 69 年
- **10 bit 机器 ID**：可拆分为 5 bit 数据中心 + 5 bit 机器，最多 1024 台
- **12 bit 序列号**：同一毫秒内最多生成 4096 个 ID

### 4.2 理论 QPS

单节点：4096 个/毫秒 = **4,096,000 个/秒**，远超业务需求。

### 4.3 代码实现（核心逻辑）

```java
public synchronized long nextId() {
    long currentMs = System.currentTimeMillis();
    if (currentMs < lastTimestamp) {
        throw new RuntimeException("时钟回拨，拒绝生成 ID");
    }
    if (currentMs == lastTimestamp) {
        sequence = (sequence + 1) & MAX_SEQUENCE;  // 4095 后归零
        if (sequence == 0) {
            currentMs = waitNextMillis(lastTimestamp); // 当前毫秒用完，等下一毫秒
        }
    } else {
        sequence = 0;
    }
    lastTimestamp = currentMs;
    return ((currentMs - START_TIMESTAMP) << TIMESTAMP_SHIFT)
         | (datacenterId << DATACENTER_SHIFT)
         | (machineId << MACHINE_SHIFT)
         | sequence;
}
```

### 4.4 时钟回拨问题

NTP 同步、服务器时间调整可能导致时钟回拨，生成重复 ID。

**解决方案：**
- 小范围回拨（< 5ms）：等待时钟追上来
- 大范围回拨：报警 + 切换备用机器 ID 段
- 根本方案：使用逻辑时钟（百度 UidGenerator 的做法）

---

## 五、号段模式（Segment）

### 5.1 原理

从数据库**批量申请**一段 ID（号段），放入内存使用，用完再申请下一段，减少数据库访问频率。

**数据库表结构：**
```sql
CREATE TABLE id_alloc (
    biz_tag   VARCHAR(128) NOT NULL,  -- 业务标识
    max_id    BIGINT NOT NULL,        -- 当前已分配到的最大 ID
    step      INT NOT NULL,           -- 步长（号段大小）
    version   INT NOT NULL,           -- 乐观锁版本
    PRIMARY KEY (biz_tag)
);
```

**申请号段（乐观锁 CAS）：**
```sql
UPDATE id_alloc
SET max_id = max_id + step, version = version + 1
WHERE biz_tag = 'order' AND version = #{version};
-- 返回后，服务端本地使用 [max_id - step + 1, max_id] 这一段
```

### 5.2 双 Buffer 优化

单 Buffer：当前号段用完时才去数据库取，有瞬时延迟。

**双 Buffer**：当前号段使用到 10%（或某阈值）时，异步预加载下一个号段到备用 Buffer，切换时零等待。

```
Buffer A: [1001, 2000]  ← 当前使用
Buffer B: [2001, 3000]  ← 提前加载好

Buffer A 用完 → 无缝切到 Buffer B → 同时异步加载 Buffer A 的下一段
```

---

## 六、美团 Leaf

> 开源地址：[https://github.com/Meituan-Dianping/Leaf](https://github.com/Meituan-Dianping/Leaf)

美团开源的分布式 ID 生成框架，同时支持**号段模式**和**雪花模式**。

### 6.1 Leaf-Segment（号段模式增强版）

- 实现了上述双 Buffer 机制
- 使用 Leaf 服务统一管理号段分配，业务方通过 HTTP 接口获取 ID
- 通过 DB 高可用（主从）保障可用性

### 6.2 Leaf-Snowflake（雪花模式增强版）

解决原始雪花算法最大痛点——**机器 ID 手动配置问题**：

- 启动时向 ZooKeeper 注册，自动分配机器 ID（workerID）
- ZooKeeper 节点存储 workerID 与 IP/Port 的映射
- 处理时钟回拨：启动时检查本地文件中记录的时间戳，若发现回拨则等待或报错

---

## 七、百度 UidGenerator

> 开源地址：[https://github.com/baidu/uid-generator](https://github.com/baidu/uid-generator)

基于 Snowflake，对 bit 位分配做了调整，并引入**缓存环形队列（RingBuffer）**：

- **BitsAllocator**：支持自定义各段 bit 位分配，适配不同 TPS 和部署规模
- **RingBuffer（缓存型）**：预先生成大量 ID 存入环形队列，取 ID 时直接从队列读，生产者线程异步补充，**完全规避时钟回拨问题**（ID 在启动时全量生成，不依赖实时时钟）
- 使用数据库表管理 workerId，实例重启会申请新的 workerId

---

## 八、方案横向对比

| 方案 | 唯一性 | 趋势递增 | 性能 | 依赖 | 适用场景 |
|------|--------|---------|------|------|---------|
| UUID | ✅ | ❌ 无序 | 极高（本地） | 无 | 幂等 key、链路追踪 |
| DB 自增 | ✅ | ✅ | 低（DB 瓶颈） | MySQL | 小规模、低并发 |
| Snowflake | ✅ | ✅ 趋势 | 极高（本地） | 时钟 | 中大规模，可接受时钟风险 |
| 号段模式 | ✅ | ✅ 严格 | 高（内存） | MySQL | 对顺序性要求高 |
| Leaf-Segment | ✅ | ✅ 严格 | 极高（双 Buffer） | MySQL + ZK | 美团系，生产推荐 |
| Leaf-Snowflake | ✅ | ✅ 趋势 | 极高（本地） | ZooKeeper | 美团系，生产推荐 |
| UidGenerator | ✅ | ✅ 趋势 | 极高（RingBuffer） | MySQL | 百度系，对时钟回拨零容忍 |

::: tip 选型建议
- **快速落地**：Snowflake（自己实现或用 Hutool 的 IdUtil.getSnowflake()）
- **严格有序 + 高可用**：Leaf-Segment（双 Buffer）
- **时钟回拨零容忍**：UidGenerator（RingBuffer 预生成）
- **不引入新组件**：号段模式（自己实现，只依赖 MySQL）
:::
