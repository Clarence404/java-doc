# Redis 典型应用场景

## 一、排行榜（ZSet）

```java
// 更新分数
redisTemplate.opsForZSet().incrementScore("rank:game", userId, score);

// Top 10（降序）
Set<ZSetOperations.TypedTuple<String>> top10 =
    redisTemplate.opsForZSet().reverseRangeWithScores("rank:game", 0, 9);

// 查询某用户排名
Long rank = redisTemplate.opsForZSet().reverseRank("rank:game", userId);
```

**注意：** 单个 ZSet 不适合超大数据量（百万级）排行榜，可以按天/周分 key，定时合并。

---

## 二、限流

### 固定窗口（简单计数）

```lua
-- 每分钟最多100次，key = "limit:userId:minute"
local count = redis.call('incr', KEYS[1])
if count == 1 then
    redis.call('expire', KEYS[1], ARGV[1])  -- 首次设置过期时间
end
if count > tonumber(ARGV[2]) then
    return 0  -- 限流
end
return 1  -- 放行
```

缺陷：窗口切换时可能有两倍流量（窗口末尾+窗口开始）。

### 滑动窗口（ZSet 实现）

```lua
-- key=limit:api:userId, 窗口=60s, 上限=100
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])

-- 移除窗口外的请求
redis.call('zremrangebyscore', KEYS[1], 0, now - window * 1000)
local count = redis.call('zcard', KEYS[1])
if count < limit then
    redis.call('zadd', KEYS[1], now, now)
    redis.call('pexpire', KEYS[1], window * 1000)
    return 1
end
return 0
```

### 令牌桶（Redisson）

```java
RRateLimiter limiter = redissonClient.getRateLimiter("api:limit");
limiter.trySetRate(RateType.OVERALL, 100, 1, RateIntervalUnit.SECONDS);

if (limiter.tryAcquire()) {
    // 处理请求
} else {
    throw new RateLimitException("请求过于频繁");
}
```

---

## 三、布隆过滤器（防缓存穿透）

布隆过滤器：用极少内存判断元素是否"可能存在"（有误判率，但不会漏判）。

### Redisson 布隆过滤器

```java
RBloomFilter<String> bloomFilter = redissonClient.getBloomFilter("product:ids");
// 预期插入量100万，误判率0.01%
bloomFilter.tryInit(1_000_000L, 0.001);

// 启动时预热（加载所有合法ID）
productIds.forEach(id -> bloomFilter.add(String.valueOf(id)));

// 查询前先过滤
public Product getProduct(Long id) {
    if (!bloomFilter.contains(String.valueOf(id))) {
        return null;  // 确定不存在，直接返回
    }
    // 查缓存 → 查DB
}
```

### Bitmap 手动实现（简单场景）

```java
// 将ID散列到多个bit位
public void addToFilter(long id) {
    for (int seed : SEEDS) {
        int position = Math.abs((int)(id * seed) % BIT_SIZE);
        redisTemplate.opsForValue().setBit("bloom:filter", position, true);
    }
}

public boolean mightContain(long id) {
    for (int seed : SEEDS) {
        int position = Math.abs((int)(id * seed) % BIT_SIZE);
        if (!redisTemplate.opsForValue().getBit("bloom:filter", position)) {
            return false;  // 确定不存在
        }
    }
    return true;  // 可能存在
}
```

---

## 四、用户签到（Bitmap）

```java
// 用户ID=1001，2024年第180天签到
String key = "sign:2024:1001";
redisTemplate.opsForValue().setBit(key, 180, true);

// 查询是否签到
Boolean signed = redisTemplate.opsForValue().getBit(key, 180);

// 统计年度签到天数
Long totalDays = redisTemplate.execute(
    (RedisCallback<Long>) conn -> conn.bitCount(key.getBytes())
);

// 连续签到天数（取最近N位，统计尾部连续1）
// 可通过 BITPOS 找第一个0的位置来计算
```

---

## 五、会话管理（Session 共享）

分布式系统中多实例需要共享 Session：

```java
// Spring Session + Redis（引入 spring-session-data-redis）
@EnableRedisHttpSession(maxInactiveIntervalInSeconds = 1800)
public class SessionConfig {}
```

```yaml
spring:
  session:
    store-type: redis
    timeout: 30m
```

Session key 格式：`spring:session:sessions:<sessionId>`

**Token 方案（更推荐）：** JWT 无状态（无需共享），或自定义 Token 存 Redis（支持主动失效、踢人下线）：

```java
// 登录时
String token = UUID.randomUUID().toString();
redisTemplate.opsForValue().set("token:" + token, userId, 30, TimeUnit.MINUTES);

// 验证时
String userId = redisTemplate.opsForValue().get("token:" + token);

// 踢人下线
redisTemplate.delete("token:" + token);
```

---

## 六、延迟队列（ZSet）

```java
// 生产：score = 执行时间戳
redisTemplate.opsForZSet().add("delay:queue", orderId, executeAt);

// 消费（定时轮询，取出到期任务）
@Scheduled(fixedDelay = 1000)
public void consume() {
    long now = System.currentTimeMillis();
    Set<String> tasks = redisTemplate.opsForZSet()
        .rangeByScore("delay:queue", 0, now);
    for (String task : tasks) {
        if (redisTemplate.opsForZSet().remove("delay:queue", task) > 0) {
            // 抢占成功，处理任务（ZSet remove 保证幂等）
            processTask(task);
        }
    }
}
```

**应用：** 订单超时关闭、定时发送消息、任务重试

---

## 七、消息队列（List vs Stream）

### List 简单队列

```java
// 生产
redisTemplate.opsForList().rightPush("queue:task", message);

// 消费（阻塞，避免空轮询）
String msg = redisTemplate.opsForList().leftPop("queue:task", 5, TimeUnit.SECONDS);
```

缺陷：无 ACK 机制，消费失败消息丢失；不支持多消费者组。

### Stream 可靠队列（推荐）

```java
// 生产
redisTemplate.opsForStream().add(
    MapRecord.create("orders", Map.of("orderId", "123", "amount", "99.9")));

// 消费（消费者组，支持 ACK）
List<MapRecord<String, Object, Object>> messages = redisTemplate.opsForStream()
    .read(Consumer.from("group1", "consumer1"),
          StreamReadOptions.empty().count(10),
          StreamOffset.create("orders", ReadOffset.lastConsumed()));
// 处理后确认
redisTemplate.opsForStream().acknowledge("orders", "group1", message.getId());
```
