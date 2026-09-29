# 短链接系统设计

> 短链系统将长 URL 转换为短 URL，核心是高性能的 ID 生成、快速跳转和大规模存储。

---

## 一、核心需求

| 功能 | 说明 |
|------|------|
| 短链生成 | 输入长 URL，返回唯一短链（如 `https://t.cn/AbC123`） |
| 短链跳转 | 访问短链，302/301 跳转到原始长 URL |
| 自定义短码 | 支持用户指定别名（如 `/my-link`） |
| 有效期 | 短链可设置过期时间 |
| 访问统计 | 点击量、地区、设备统计 |

**数量级估算（以 t.cn 为例）：**
- 短链生成：1000 QPS
- 短链跳转：10w QPS（读远大于写）
- 总存储：1 亿条 × 500B ≈ 50GB

---

## 二、短码生成方案

### 2.1 哈希算法（MD5/MurmurHash）

对长 URL 做哈希，取前 6~8 位字符作为短码：

```java
// MurmurHash 速度更快、冲突率更低
long hash = Hashing.murmur3_32().hashString(longUrl, UTF_8).asInt() & 0xFFFFFFFFL;
String shortCode = Base62.encode(hash); // 转 62 进制（a-z A-Z 0-9）
```

**问题**：不同长 URL 可能产生相同短码（哈希冲突）。

**解决**：冲突时在 URL 后追加随机盐重新哈希，循环直到不冲突（通常 1~2 次）。

### 2.2 发号器（推荐）

使用全局递增 ID，转 62 进制作为短码：

```
ID = 1       → "1"      （6位 62进制可表示 568 亿个短链）
ID = 62      → "10"
ID = 100000  → "q0U"
```

**发号器方案：**
- **MySQL 自增**：适合低并发，单点
- **Redis INCR**：高性能，但重启需持久化
- **号段模式**（推荐）：每次批量申请 1000 个 ID，内存消费，用完再申请

```java
// 号段模式：服务启动时申请号段
private volatile long currentId;
private volatile long maxId;
private final int step = 1000;

public synchronized long nextId() {
    if (currentId >= maxId) {
        // 从 DB 申请新号段
        long newMax = idAllocMapper.fetchAndIncrease(step);
        currentId = newMax - step;
        maxId = newMax;
    }
    return currentId++;
}
```

### 2.3 两种方案对比

| | 哈希方案 | 发号器方案 |
|--|---------|---------|
| 相同 URL | 可生成相同短码（天然去重） | 每次生成不同短码 |
| 冲突处理 | 需要处理哈希冲突 | 无冲突 |
| 短码长度 | 固定（通常 6~8 位） | 随 ID 增长而变长 |
| 实现复杂度 | 简单 | 中等（需发号器服务） |
| 推荐场景 | 需要去重的场景 | 高并发生成场景 |

---

## 三、存储设计

### 3.1 数据库表

```sql
CREATE TABLE short_url (
    id          BIGINT PRIMARY KEY,
    short_code  VARCHAR(16) NOT NULL UNIQUE,  -- 短码
    long_url    TEXT NOT NULL,                 -- 原始长 URL
    user_id     BIGINT,                        -- 创建者
    expire_at   DATETIME,                      -- 过期时间（NULL 表示永久）
    created_at  DATETIME NOT NULL,
    click_count BIGINT DEFAULT 0,              -- 点击量
    INDEX idx_short_code (short_code)
);
```

### 3.2 缓存设计（Redis）

跳转接口是读多写少，短码 → 长 URL 的映射必须缓存：

```java
// 跳转时查询流程
public String getLongUrl(String shortCode) {
    // 1. 先查 Redis
    String longUrl = redis.get("url:" + shortCode);
    if (longUrl != null) return longUrl;

    // 2. 缓存未命中，查 DB
    ShortUrl record = shortUrlMapper.selectByCode(shortCode);
    if (record == null) return null; // 短链不存在

    // 3. 过期校验
    if (record.getExpireAt() != null && record.getExpireAt().before(new Date())) {
        return null; // 已过期
    }

    // 4. 写回缓存（TTL 与短链过期时间一致）
    long ttl = record.getExpireAt() != null
        ? (record.getExpireAt().getTime() - System.currentTimeMillis()) / 1000
        : 86400 * 30; // 永久链接缓存 30 天
    redis.setex("url:" + shortCode, ttl, record.getLongUrl());

    return record.getLongUrl();
}
```

---

## 四、跳转实现

### 4.1 301 vs 302

| | 301 永久重定向 | 302 临时重定向 |
|--|---|---|
| 浏览器缓存 | 会缓存，后续直接跳转不访问短链服务 | 每次都访问短链服务 |
| 统计准确性 | ❌ 缓存后统计不到 | ✅ 每次访问都能统计 |
| 服务器压力 | 低 | 高 |
| 推荐场景 | 对统计无需求、需降低服务压力 | 需要点击统计（主流选择） |

```java
@GetMapping("/{shortCode}")
public void redirect(@PathVariable String shortCode, HttpServletResponse response) throws IOException {
    String longUrl = shortUrlService.getLongUrl(shortCode);
    if (longUrl == null) {
        response.sendError(404, "短链不存在或已过期");
        return;
    }
    // 异步记录点击（不影响跳转速度）
    asyncStatService.recordClick(shortCode, request);
    response.setStatus(HttpServletResponse.SC_MOVED_TEMPORARILY); // 302
    response.setHeader("Location", longUrl);
}
```

---

## 五、访问统计

### 5.1 实时统计

点击时异步写 Kafka，消费端聚合后写 Redis / DB：

```
用户访问 → 跳转（主流程） → 异步发 Kafka（shortCode + UA + IP + timestamp）
                                    ↓
                              Flink 实时消费
                                    ↓
                         Redis INCR（实时计数）+ ClickHouse（明细分析）
```

### 5.2 防刷统计

同一 IP 短时间内多次访问只计一次（Redis 滑动窗口）：

```java
String key = "click:dedup:" + shortCode + ":" + ip;
Long result = redis.incr(key);
if (result == 1) {
    redis.expire(key, 60); // 60 秒内同一 IP 只计一次
    statService.increment(shortCode); // 真正计数
}
```

---

## 六、高可用设计

| 模块 | 方案 |
|------|------|
| 发号器 | 号段模式 + 双 Buffer，DB 故障时靠已申请号段撑一段时间 |
| 缓存 | Redis Cluster，核心数据多副本 |
| 跳转服务 | 无状态，水平扩展，前置 Nginx 负载均衡 |
| 存储 | MySQL 主从，跳转只读从库 |
| 防穿透 | 不存在的短码用 Redis 空值缓存（TTL 60s） |
