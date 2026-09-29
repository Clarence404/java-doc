# 排行榜 & 积分系统设计

> 排行榜是游戏、电商、直播等场景的高频功能，核心是实时性与性能的平衡。Redis ZSet 是排行榜的首选存储结构。

---

## 一、Redis ZSet 基础

ZSet（有序集合）：每个成员关联一个 score（浮点数），按 score 从小到大排序，支持范围查询。

```bash
# 写入/更新分数
ZADD leaderboard 1500 "user:1001"
ZINCRBY leaderboard 100 "user:1001"   # 加分（原子操作）

# 查询排名（从大到小，rank 从 0 开始）
ZREVRANK leaderboard "user:1001"      # 返回排名索引

# 查询 Top 10
ZREVRANGEBYSCORE leaderboard +inf -inf WITHSCORES LIMIT 0 10

# 查询分数
ZSCORE leaderboard "user:1001"
```

---

## 二、实时排行榜

### 2.1 基本实现

```java
// 加分（如用户完成订单得分）
public void addScore(Long userId, double score) {
    redisTemplate.opsForZSet()
        .incrementScore("leaderboard:global", "user:" + userId, score);
}

// 获取 Top N
public List<RankItem> getTopN(int n) {
    Set<ZSetOperations.TypedTuple<String>> tuples =
        redisTemplate.opsForZSet()
            .reverseRangeWithScores("leaderboard:global", 0, n - 1);

    return tuples.stream().map(t -> {
        long userId = Long.parseLong(t.getValue().replace("user:", ""));
        return new RankItem(userId, t.getScore().longValue(),
            // rank 需要单独查或从遍历索引获取
        );
    }).collect(Collectors.toList());
}

// 查询某用户排名
public long getUserRank(Long userId) {
    Long rank = redisTemplate.opsForZSet()
        .reverseRank("leaderboard:global", "user:" + userId);
    return rank == null ? -1 : rank + 1; // rank 从 0 开始，+1 转为人类可读
}
```

### 2.2 附近名次查询（我的排名 ± 3）

```java
public List<RankItem> getNeighbors(Long userId, int range) {
    Long myRank = redisTemplate.opsForZSet()
        .reverseRank("leaderboard:global", "user:" + userId);
    if (myRank == null) return Collections.emptyList();

    long start = Math.max(0, myRank - range);
    long end = myRank + range;

    Set<ZSetOperations.TypedTuple<String>> tuples =
        redisTemplate.opsForZSet()
            .reverseRangeWithScores("leaderboard:global", start, end);
    // 转换并标记自己
    ...
}
```

---

## 三、分时段排行榜

### 3.1 日榜 / 周榜 / 月榜

用不同 key 隔离不同时段的榜单：

```java
// key 设计
String dailyKey  = "leaderboard:daily:"  + LocalDate.now();           // 当日
String weeklyKey = "leaderboard:weekly:" + getIsoWeek();               // 本周
String monthlyKey= "leaderboard:monthly:"+ YearMonth.now();            // 本月

// 加分时同时更新多个榜单
public void addScore(Long userId, double score) {
    String member = "user:" + userId;
    redisTemplate.opsForZSet().incrementScore("leaderboard:global", member, score);
    redisTemplate.opsForZSet().incrementScore(dailyKey, member, score);
    redisTemplate.opsForZSet().incrementScore(weeklyKey, member, score);
    redisTemplate.opsForZSet().incrementScore(monthlyKey, member, score);
}
```

**过期策略**：为日榜/周榜设置 TTL，到期自动清除（节省内存）：

```java
// 日榜保留 3 天
redisTemplate.expire(dailyKey, 3, TimeUnit.DAYS);
// 周榜保留 30 天
redisTemplate.expire(weeklyKey, 30, TimeUnit.DAYS);
```

### 3.2 历史榜单

实时榜单存 Redis，历史快照（每日/每周）定时归档到 MySQL：

```java
// 每天凌晨归档昨日榜 Top 100
@Scheduled(cron = "0 5 0 * * ?")
public void archiveDailyRank() {
    String yesterdayKey = "leaderboard:daily:" + LocalDate.now().minusDays(1);
    Set<ZSetOperations.TypedTuple<String>> top100 =
        redisTemplate.opsForZSet().reverseRangeWithScores(yesterdayKey, 0, 99);
    rankHistoryMapper.batchInsert(LocalDate.now().minusDays(1), top100);
}
```

---

## 四、大规模排行榜优化

### 4.1 ZSet 成员数量限制

Redis ZSet 支持亿级成员，但 key 过大会影响内存和操作性能。

**分片策略**：当用户量极大时，按 userId 分片到多个 ZSet：

```java
// 按 userId 分 100 个分片
int shard = (int)(userId % 100);
String key = "leaderboard:shard:" + shard;
```

获取全局 Top N 时，从各分片取 Top N，再合并取最大的 N 个（归并排序）。

### 4.2 Score 相同时的排名处理

ZSet 按 score 排序，score 相同时按 member 字典序排。

**需求**：score 相同时，先达到该分数的用户排名更靠前（先到先得）。

**方案**：将时间戳编码进 score：

```java
// score = 实际分数 * 10^10 + (Long.MAX_VALUE - 当前时间戳)
// 分数高的排前面；分数相同时，时间早的（时间戳小，减法结果大）排前面
double score = actualScore * 1e10 + (Long.MAX_VALUE - System.currentTimeMillis());
```

### 4.3 缓存分页结果

Top N 频繁被查询，可缓存分页结果（注意数据新鲜度）：

```java
// 缓存 Top 100，5 分钟更新一次
@Cacheable(value = "top100", key = "'global'", cacheManager = "5minCacheManager")
public List<RankItem> getTop100() {
    return getTopN(100);
}
```

---

## 五、积分系统设计

### 5.1 积分表设计

```sql
-- 积分账户表（当前余额）
CREATE TABLE point_account (
    user_id     BIGINT PRIMARY KEY,
    balance     BIGINT NOT NULL DEFAULT 0,  -- 当前积分
    version     INT NOT NULL DEFAULT 0,     -- 乐观锁
    updated_at  DATETIME
);

-- 积分流水表（明细记录，不可修改）
CREATE TABLE point_record (
    id          BIGINT PRIMARY KEY,
    user_id     BIGINT NOT NULL,
    amount      BIGINT NOT NULL,            -- 正数=增加，负数=扣减
    type        VARCHAR(32),               -- 来源类型（ORDER/SIGN_IN/REDEEM）
    biz_id      VARCHAR(64),               -- 业务 ID（幂等）
    balance_after BIGINT,                  -- 变更后余额（方便对账）
    created_at  DATETIME,
    UNIQUE KEY uk_biz (type, biz_id)       -- 幂等唯一索引
);
```

### 5.2 积分增减（防并发 + 幂等）

```java
@Transactional
public void addPoints(Long userId, long amount, String type, String bizId) {
    // 1. 幂等校验：同一业务 ID 不重复处理
    if (pointRecordMapper.exists(type, bizId)) return;

    // 2. 乐观锁更新余额
    PointAccount account = pointAccountMapper.selectByUserId(userId);
    long newBalance = account.getBalance() + amount;
    if (newBalance < 0) throw new IllegalStateException("积分不足");

    int rows = pointAccountMapper.updateBalance(userId, newBalance, account.getVersion());
    if (rows == 0) throw new OptimisticLockException("并发更新冲突");

    // 3. 写流水
    pointRecordMapper.insert(new PointRecord(userId, amount, type, bizId, newBalance));

    // 4. 同步更新排行榜
    redisTemplate.opsForZSet().incrementScore("leaderboard:global", "user:" + userId, amount);
}
```

### 5.3 积分有效期

积分按批次记录获取时间，消费时按"先进先出"扣减最早的积分：

```sql
-- 积分批次表（每次获取记录一批）
CREATE TABLE point_batch (
    id          BIGINT PRIMARY KEY,
    user_id     BIGINT NOT NULL,
    amount      BIGINT NOT NULL,            -- 批次原始积分
    remaining   BIGINT NOT NULL,            -- 剩余可用
    expire_at   DATETIME NOT NULL,          -- 过期时间
    created_at  DATETIME NOT NULL
);
-- 消费时按 expire_at ASC 顺序扣减 remaining
```

---

## 六、选型总结

| 场景 | 推荐方案 |
|------|---------|
| 实时排名 | Redis ZSet（ZINCRBY + ZREVRANK） |
| 历史快照 | 定时归档到 MySQL |
| 亿级用户排行 | ZSet 分片 + 合并归并 |
| Score 相同排序 | Score 编码时间戳 |
| 积分余额 | MySQL（乐观锁）+ Redis 同步 |
| 积分流水 | MySQL 追加写（不更新删除） |
| 积分有效期 | 按批次管理，先进先出消费 |
