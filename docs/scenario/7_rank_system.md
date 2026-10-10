---
description: ZSet 实时榜、日周月榜、同分先到先得、分片合并、积分账户与流水
---

# 排行榜和积分

> 前置阅读：[Redis 基础](/cache/1_redis_base)、[Redis 典型应用场景](/cache/4_redis_scenario)

排行榜和积分是 Redis ZSet 最典型的落地场景。本篇讲实时榜与日 / 周 / 月榜、同分排序、超大榜单与历史归档，以及余额不错、流水可对账、与榜单最终一致的积分系统，示例基于 Redis 7.x / 8.x 与 Spring Data Redis（`redis` 指 `StringRedisTemplate`）。

---

## 一、实时排行榜

ZSet 的命令与底层结构（跳表 + listpack）见 [Redis 基础](/cache/1_redis_base)。

### 1、命令速查

Redis 6.2 起 `ZRANGE` 统一了按排名、按分数、正序倒序的查询，`ZREVRANGE`、`ZREVRANGEBYSCORE` 已标记为废弃（仍可用）：

```bash
ZINCRBY rank:global 100 "1001"                  # 加分，原子操作
ZRANGE  rank:global 0 9 REV WITHSCORES          # Top 10（按排名倒序）
ZRANGE  rank:global +inf 1000 BYSCORE REV LIMIT 0 10 WITHSCORES   # 1000 分以上前 10 名
ZREVRANK rank:global "1001"                     # 我的名次（0 开始）
ZSCORE  rank:global "1001"                      # 我的分数
```

member 直接存用户 ID，不加 `user:` 前缀，省内存也省解析。

### 2、Top N 与我的排名

```java
public record RankItem(long userId, long score, long rank) {}

public List<RankItem> topN(String key, int n) {
    Set<ZSetOperations.TypedTuple<String>> tuples =
            redis.opsForZSet().reverseRangeWithScores(key, 0, n - 1);
    if (tuples == null || tuples.isEmpty()) return List.of();

    List<RankItem> result = new ArrayList<>(tuples.size());
    long rank = 1;
    for (ZSetOperations.TypedTuple<String> t : tuples) {        // 返回的 Set 保持 Redis 的顺序
        result.add(new RankItem(Long.parseLong(t.getValue()), t.getScore().longValue(), rank++));
    }
    return result;
}

public long myRank(String key, long userId) {
    Long rank = redis.opsForZSet().reverseRank(key, String.valueOf(userId));
    return rank == null ? -1 : rank + 1;                         // 未上榜返回 -1
}
```

### 3、我的前后名次

```java
public List<RankItem> neighbors(String key, long userId, int range) {
    Long myRank = redis.opsForZSet().reverseRank(key, String.valueOf(userId));
    if (myRank == null) return List.of();

    long start = Math.max(0, myRank - range);
    Set<ZSetOperations.TypedTuple<String>> tuples =
            redis.opsForZSet().reverseRangeWithScores(key, start, myRank + range);

    List<RankItem> result = new ArrayList<>();
    long rank = start + 1;
    for (ZSetOperations.TypedTuple<String> t : tuples) {
        result.add(new RankItem(Long.parseLong(t.getValue()), t.getScore().longValue(), rank++));
    }
    return result;
}
```

---

## 二、分时段榜单

### 1、key 设计与过期时间

用不同 key 隔离时段，过期时间用**绝对时间** `EXPIREAT`（周期结束 + 保留天数）。同一个绝对时间重复设置不会把 TTL 往后推，所以可以和加分放在同一个管道里：

```java
private static final ZoneId ZONE = ZoneId.of("Asia/Shanghai");   // 榜单按业务时区切日

public void addScore(long userId, long delta) {
    LocalDate today = LocalDate.now(ZONE);
    String member = String.valueOf(userId);
    Map<String, Instant> boards = Map.of(
            "rank:daily:" + today,                         expireAt(today.plusDays(1), 3),
            "rank:weekly:" + today.with(DayOfWeek.MONDAY), expireAt(today.with(DayOfWeek.MONDAY).plusWeeks(1), 30),
            "rank:monthly:" + YearMonth.from(today),       expireAt(today.withDayOfMonth(1).plusMonths(1), 90));

    redis.executePipelined((RedisCallback<Object>) conn -> {
        byte[] m = member.getBytes(StandardCharsets.UTF_8);
        conn.zSetCommands().zIncrBy("rank:global".getBytes(StandardCharsets.UTF_8), delta, m);
        boards.forEach((key, at) -> {
            byte[] k = key.getBytes(StandardCharsets.UTF_8);
            conn.zSetCommands().zIncrBy(k, delta, m);
            conn.keyCommands().expireAt(k, at.getEpochSecond());
        });
        return null;
    });
}

private Instant expireAt(LocalDate periodEnd, int keepDays) {
    return periodEnd.plusDays(keepDays).atStartOfDay(ZONE).toInstant();
}
```

- 周榜 key 用当周周一的日期，避免 ISO 周号跨年时的歧义
- 管道不是事务，中途失败可能只加了部分榜单；榜单允许最终一致时，由下文的对账任务按流水重算兜底

### 2、历史归档

实时榜在 Redis，历史快照定时归档到 MySQL：

```java
// 由 XXL-JOB / ShedLock 等分布式调度触发，保证同一时刻只有一个实例执行
public void archiveDaily(LocalDate day) {
    Set<ZSetOperations.TypedTuple<String>> top =
            redis.opsForZSet().reverseRangeWithScores("rank:daily:" + day, 0, 99);
    rankHistoryMapper.batchUpsert(day, "DAILY", top);   // 唯一键 (rank_date, rank_type, user_id)，重跑不重复
}
```

归档发生在日榜过期之前（上面日榜保留 3 天），任务失败可以重跑。调度框架的对比见 [分布式调度](/distributed/6_job_scheduler)。

---

## 三、同分时先到先得

ZSet 同分时按 member 字典序排列，业务通常要求「先达到该分数的人排前面」，做法是把时间编码进 score。

**精度限制**：score 是 IEEE 754 双精度浮点数，只能精确表示 2^53（约 9.007 × 10^15）以内的整数。常见写法 `分数 × 10^10 + (Long.MAX_VALUE - 毫秒时间戳)` 的结果约 9.2 × 10^18，时间部分在舍入中丢失，同分排序并不生效。

**正确做法**：让组合值始终小于 2^53。以一个持续 30 天的活动为例，时间部分用「距活动开始的秒数」，7 位就够：

- `score = 积分 × 10^7 + (10^7 - 1 - 距活动开始秒数)`，越早达到，时间部分越大，排名越靠前
- 积分上限约 9 × 10^8，解码时 `积分 = floor(score / 10^7)`
- 若用 10 位的 Unix 秒做时间部分，积分上限会降到约 90 万，需按业务评估

加分时时间部分要换成「本次更新的时间」，`ZINCRBY` 做不到，用 Lua 读改写：

```lua
-- KEYS[1] 榜单  ARGV[1] userId  ARGV[2] 本次加分  ARGV[3] 距活动开始秒数
local cur = redis.call('ZSCORE', KEYS[1], ARGV[1])
local pts = 0
if cur then pts = math.floor(tonumber(cur) / 1e7) end
pts = pts + tonumber(ARGV[2])
local score = pts * 1e7 + (1e7 - 1 - tonumber(ARGV[3]))
-- Lua 数字默认按 %.14g 转字符串会丢精度，必须显式格式化为整数
redis.call('ZADD', KEYS[1], string.format('%.0f', score), ARGV[1])
return pts
```

不想改 score 时也可以只存积分，在应用层对同分的少量用户按「达到时间」二次排序（达到时间另存一个 Hash）。

---

## 四、超大榜单

### 1、单 key 的边界

一个 ZSet 可以存上亿成员，但它是一个**大 key**：

- 在 Redis Cluster 中整个 key 只能落在一个槽上，无法拆到多个节点
- 删除或过期时释放内存可能阻塞主线程，删除用 `UNLINK`，并开启 `lazyfree-lazy-expire` 等惰性释放参数
- 大 key 与热 key 的治理见 [Redis 实战](/cache/5_redis_practice) 和 [热点问题](/high-con/6_hotspot)

### 2、分片与合并

按 userId 取模分到多个 ZSet（如 `rank:global:{0..99}`）后：

- **Top N**：每个分片取 Top N，在应用层归并取前 N；N 很小时开销可控
- **我的名次**：不再是单 key 的 O(log N)，而是对每个分片执行 `ZCOUNT key (myScore +inf` 再求和，再加上同分处理；分片越多越慢
- 只关心头部时，更省事的做法是只维护一个**头部榜**（比如只保留分数超过门槛的用户），其余用户显示「未上榜」或区间名次

### 3、读多写多

Top N 是典型的读热点，在应用里用 [Caffeine](/cache/7_caffeine) 缓存 1 到 5 秒即可挡掉大部分读请求；写热点（同一个榜单每秒数十万次加分）可以先在本地按用户聚合几百毫秒再批量 `ZINCRBY`。

---

## 五、积分系统

### 1、表设计

```sql
-- 积分账户：当前余额
CREATE TABLE point_account (
    user_id     BIGINT PRIMARY KEY,
    balance     BIGINT   NOT NULL DEFAULT 0,
    updated_at  DATETIME NOT NULL
);

-- 积分流水：只追加，不修改不删除
CREATE TABLE point_record (
    id            BIGINT PRIMARY KEY,
    user_id       BIGINT      NOT NULL,
    amount        BIGINT      NOT NULL,          -- 正数增加，负数扣减
    type          VARCHAR(32) NOT NULL,          -- ORDER / SIGN_IN / REDEEM / EXPIRE
    biz_id        VARCHAR(64) NOT NULL,          -- 业务单号
    balance_after BIGINT      NOT NULL,          -- 变更后余额，便于对账
    created_at    DATETIME    NOT NULL,
    UNIQUE KEY uk_biz (type, biz_id),            -- 幂等：同一笔业务只记一次
    KEY idx_user_time (user_id, created_at)
);
```

### 2、积分增减：幂等与并发

去重靠流水表的唯一键，和余额变更放在**同一个本地事务**里；余额用条件更新原子扣减，不需要先查再改，也不需要版本号重试：

```java
@Service
@RequiredArgsConstructor
public class PointService {

    private final PointTxService txService;

    public void change(PointCommand cmd) {
        try {
            txService.apply(cmd);
        } catch (DuplicateKeyException e) {
            // uk_biz 冲突：这笔业务已经处理过，整笔事务已回滚，按成功返回
        }
    }
}

@Service
@RequiredArgsConstructor
public class PointTxService {

    private final PointAccountMapper accountMapper;
    private final PointRecordMapper recordMapper;
    private final ApplicationEventPublisher publisher;

    @Transactional
    public void apply(PointCommand cmd) {
        int rows = cmd.amount() >= 0
                // INSERT INTO point_account ... ON DUPLICATE KEY UPDATE balance = balance + #{amount}：新用户也能加分
                ? accountMapper.upsertAdd(cmd.userId(), cmd.amount())
                // UPDATE point_account SET balance = balance - #{n} WHERE user_id = #{userId} AND balance >= #{n}
                : accountMapper.deduct(cmd.userId(), -cmd.amount());
        if (rows == 0) {
            throw new BizException("积分不足");
        }
        long balance = accountMapper.selectBalance(cmd.userId());   // 本事务持有行锁，读到的就是最新值
        recordMapper.insert(PointRecord.of(cmd, balance));          // 重复时抛 DuplicateKeyException，事务回滚
        publisher.publishEvent(new PointChangedEvent(cmd.userId(), cmd.amount(), cmd.type(), cmd.bizId()));
    }
}
```

为什么不是「先查流水是否存在再处理」：两个并发请求都会查到「不存在」，靠的仍是唯一键；不如直接以唯一键为准，冲突即回滚。幂等方案的完整对比见 [幂等设计](/architecture/5_idempotence)。

### 3、榜单更新放在提交之后

在事务里直接 `ZINCRBY` 的问题是：Redis 已经加分，事务却因唯一键冲突或其他异常回滚，榜单与余额就对不上。所以榜单在**提交后**更新：

```java
@TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT)
public void onPointChanged(PointChangedEvent e) {
    rankService.addScore(e.userId(), e.amount());
}
```

- `AFTER_COMMIT` 是「至多一次」：提交后进程崩溃或 Redis 失败，这次加分会丢。榜单允许短暂偏差时，用定时对账兜底：按流水表重算当期榜单，与 Redis 对比后修正
- 榜单要求严格一致时，改用本地消息表：在同一事务里写一条消息，投递到 MQ 后由消费者加分；消费端用一个 Lua 脚本把「`SET bizKey NX EX` 去重标记 + `ZINCRBY`」原子执行（两个 key 用同一个哈希标签），避免重复消费重复加分。可靠消息的做法见 [消息队列基础](/messaging/1_basics)

### 4、积分有效期

积分按批次记录获取时间，消费时按「先到期先扣」：

```sql
CREATE TABLE point_batch (
    id          BIGINT PRIMARY KEY,
    user_id     BIGINT   NOT NULL,
    amount      BIGINT   NOT NULL,         -- 批次原始积分
    remaining   BIGINT   NOT NULL,         -- 剩余可用
    expire_at   DATETIME NOT NULL,
    created_at  DATETIME NOT NULL,
    KEY idx_user_expire (user_id, expire_at)
);
```

- **扣减**：在上面 `apply` 的同一个事务里，`SELECT ... WHERE user_id = ? AND remaining > 0 AND expire_at > NOW() ORDER BY expire_at FOR UPDATE` 逐批扣 `remaining`，扣减总额必须等于账户余额的减少量，否则抛异常回滚
- **过期**：定时任务扫描已到期且 `remaining > 0` 的批次，每批一个事务：`remaining` 置 0、账户余额减去同样的数、写一条 `type = EXPIRE`、`biz_id = 批次 ID` 的负数流水；唯一键保证任务重跑不会重复扣
- **对账**：`point_account.balance` 应等于该用户未过期批次的 `remaining` 之和，也应等于流水 `amount` 之和

---

## 小结

| 场景 | 方案 |
|------|------|
| 实时排名 | ZSet：`ZINCRBY` 加分，`ZRANGE ... REV` 取 Top N，`ZREVRANK` 查名次 |
| 日 / 周 / 月榜 | 每个时段一个 key，`EXPIREAT` 设绝对过期时间，管道一次写完 |
| 历史榜单 | 分布式调度在过期前归档到 MySQL，唯一键保证可重跑 |
| 同分先到先得 | 组合 score 必须小于 2^53，Lua 读改写更新时间部分 |
| 亿级用户 | 单 key 是大 key；分片后 Top N 归并、名次靠 `ZCOUNT` 求和，或只维护头部榜 |
| 积分余额 | 条件更新原子扣减 + 流水唯一键去重，同一个本地事务 |
| 积分与榜单 | 提交后更新榜单 + 定时对账；严格一致用本地消息表 + 消费端原子去重 |
| 积分有效期 | 按批次先到期先扣，过期写负数流水 |

## 参考资料

- ZRANGE：[https://redis.io/docs/latest/commands/zrange/](https://redis.io/docs/latest/commands/zrange/)
- ZADD：[https://redis.io/docs/latest/commands/zadd/](https://redis.io/docs/latest/commands/zadd/)
- ZINCRBY：[https://redis.io/docs/latest/commands/zincrby/](https://redis.io/docs/latest/commands/zincrby/)
- EXPIREAT：[https://redis.io/docs/latest/commands/expireat/](https://redis.io/docs/latest/commands/expireat/)
- Redis Lua API（Lua 与 Redis 类型转换）：[https://redis.io/docs/latest/develop/programmability/lua-api/](https://redis.io/docs/latest/develop/programmability/lua-api/)
- Spring Transaction-bound Events：[https://docs.spring.io/spring-framework/reference/data-access/transaction/event.html](https://docs.spring.io/spring-framework/reference/data-access/transaction/event.html)

> 下一篇：[Feed 流和消息推送](./8_feed_stream) —— 推模式、拉模式与推拉结合，收件箱存储与游标分页。
