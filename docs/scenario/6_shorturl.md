---
description: 短码生成与 Base62、哈希冲突、ID 混淆、存储与缓存、跳转状态码、点击统计、高可用
---

# 短链接系统设计

> **本篇目标**：设计一个读远多于写的短链服务：选对短码生成方式并处理好冲突与可遍历问题，跳转链路靠缓存扛住流量，统计异步化且不拖慢跳转。
>
> **前置阅读**：[分布式 ID 生成](/distributed/8_id_generator)、[缓存一致性](/cache/10_cache_consistency)

---

## 一、需求与估算

| 功能 | 说明 |
|------|------|
| 生成 | 输入长 URL，返回短链（如 `https://s.example.com/q0U`） |
| 跳转 | 访问短链，重定向到原始长 URL |
| 自定义短码 | 用户指定别名（如 `/my-link`） |
| 有效期 | 短链可设置过期时间 |
| 访问统计 | 点击量、地区、设备 |

**数量级（假设）**：生成 1000 QPS，跳转 10w QPS（读写比约 100:1）；累计 1 亿条，每条约 500B，总计约 50GB。

![短链接系统整体架构](../assets/scenario/shorturl_arch.svg)

---

## 二、短码生成

### 1、Base62 编码

短码由 62 个字符组成，全文统一使用 `0-9a-zA-Z` 的字母表顺序：

```java
public final class Base62 {

    private static final char[] ALPHABET =
            "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ".toCharArray();

    public static String encode(long value) {
        if (value < 0) {
            throw new IllegalArgumentException("value must be non-negative");
        }
        if (value == 0) {
            return "0";
        }
        StringBuilder sb = new StringBuilder();
        while (value > 0) {
            sb.append(ALPHABET[(int) (value % 62)]);
            value /= 62;
        }
        return sb.reverse().toString();
    }
}
```

| ID | 短码 |
|----|------|
| 1 | `1` |
| 62 | `10` |
| 100000 | `q0U`（26·62² + 0·62 + 56） |
| 62⁶ − 1 ≈ 568 亿 | `ZZZZZZ`，6 位能表示的上限 |

### 2、发号器 + Base62（推荐）

每条短链取一个全局唯一的递增 ID，再转成 Base62。号段模式（批量从 DB 申请一段 ID 在内存中发放，双 Buffer 预取）是常用做法，实现与 Leaf 方案见 [分布式 ID 生成](/distributed/8_id_generator)，这里不再重复代码。

**递增 ID 直接编码的问题：短码可预测、可遍历。** 别人从自己的短码 `q0U` 往前后枚举，就能访问到他人的链接。做法是先对 ID 做一次可逆的混淆再编码：

```java
private static final long SPACE = 56_800_235_584L;   // 62^6，6 位短码的取值空间
private static final long A = 100_000_007L;          // 与 62^6 互质（质数，不是 2 和 31）
private static final long B = 23_456_789_012L;       // 任意偏移，作为私密参数保存

// 在 [0, 62^6) 上的一一映射，不同 ID 一定得到不同结果；id < SPACE 时乘积不会溢出 long
static String shortCode(long id) {
    long mixed = Math.floorMod(id * A + B, SPACE);
    String code = Base62.encode(mixed);
    return "0".repeat(6 - code.length()) + code;      // 补齐为固定 6 位
}
```

- 线性混淆只是让相邻 ID 的短码看不出规律，**不是加密**；需要更强的不可预测性时用 Feistel 置换，或直接生成随机短码并依赖唯一约束重试
- ID 用完 6 位空间后换 7 位空间（`SPACE = 62^7`，同时重新选择 A），已有短码不受影响

### 3、哈希方案

对长 URL 做哈希再转 Base62，相同 URL 天然得到相同短码：

```java
// Guava 31.0 起 murmur3_32() 已弃用（非 BMP 字符处理有误），改用 murmur3_32_fixed()
long h = Hashing.murmur3_32_fixed()
        .hashString(longUrl + salt, StandardCharsets.UTF_8)
        .padToLong();                                  // 32 位无符号值，最多 6 位 Base62
String code = Base62.encode(h);
```

**冲突必须按常态处理。** 32 位哈希只有约 43 亿个取值，按生日悖论，存入 n 条时冲突对数约为 n² / (2 × 2³²)：

| 已存条数 | 预期冲突对数 |
|----------|--------------|
| 10 万 | 约 1 |
| 1000 万 | 约 1.2 万 |
| 1 亿 | 约 116 万 |

所以生成流程是：

1. 以 `short_code` 唯一约束插入
2. 撞唯一键时查出已有记录：`long_url` 相同就直接返回它；不同则换一个盐重新哈希，回到第 1 步
3. 一旦加盐重试过，同一个长 URL 就不再固定对应一个短码；要「同 URL 返回同短码」，需要另建 `long_url_hash` 列（如 SHA-256）的索引，生成前先按它查

### 4、方案对比

| | 发号器 + 混淆 | 哈希 |
|--|---------------|------|
| 冲突 | 无（一一映射） | 必然存在，需查库重试 |
| 同 URL 去重 | 需按 `long_url_hash` 查重 | 无冲突时天然去重，冲突后同样要查重 |
| 短码长度 | 固定 6 位，用完换 7 位 | 32 位哈希最多 6 位 |
| 可遍历 | 混淆后难以枚举 | 难以枚举 |
| 依赖 | 发号器服务 | 无 |
| 适合 | 大规模生成（主流） | 规模小、希望无状态生成 |

自定义别名直接以别名作为短码插入，依赖同一个唯一约束判断是否被占用。

---

## 三、存储与缓存

### 1、表设计

```sql
CREATE TABLE short_url (
    id            BIGINT       PRIMARY KEY,
    short_code    VARCHAR(16)  NOT NULL,
    long_url      TEXT         NOT NULL,
    long_url_hash BINARY(32)   NOT NULL,              -- SHA-256，用于同 URL 去重
    user_id       BIGINT,
    expire_at     DATETIME,                           -- NULL 表示永久
    created_at    DATETIME     NOT NULL,
    UNIQUE KEY uk_short_code (short_code),
    KEY idx_long_url_hash (long_url_hash)
);
```

点击量不放在主表：每次跳转都更新同一行，热门短链会成为写热点。计数放 Redis，明细进 OLAP，按需定期汇总。

### 2、跳转查询与缓存

```java
private static final String NULL_MARK = "";

public String getLongUrl(String code) {
    String key = "url:" + code;
    String cached = redis.opsForValue().get(key);         // redis 为 StringRedisTemplate
    if (cached != null) {
        return NULL_MARK.equals(cached) ? null : cached;
    }

    ShortUrl r = shortUrlMapper.selectByCode(code);
    Instant now = Instant.now();
    // 过期时间在 1 秒内的也视为过期，保证下面的 TTL 至少 1 秒
    if (r == null || (r.getExpireAt() != null && !r.getExpireAt().isAfter(now.plusSeconds(1)))) {
        redis.opsForValue().set(key, NULL_MARK, Duration.ofSeconds(60));   // 空值缓存，防穿透
        return null;
    }

    Duration ttl = r.getExpireAt() == null
            ? Duration.ofDays(30)                         // 永久链接缓存 30 天
            : Duration.between(now, r.getExpireAt());     // 与短链过期时间一致
    redis.opsForValue().set(key, r.getLongUrl(), ttl);
    return r.getLongUrl();
}
```

- `expireAt` 为 `Instant`；计算 TTL 前先排除已过期或即将过期的记录，否则 TTL 可能为 0 或负数，Redis 会报 `invalid expire time`
- 不存在的短码写入 60 秒空值缓存。被大量随机短码攻击时，可以在前面加布隆过滤器，见 [缓存最佳实践](/cache/11_cache_rule#_2、布隆过滤器与参数校验)
- **生成时立即写缓存（预热）**：新短链往往马上被访问，如果查询走从库，主从延迟期间会查不到，并被缓存成空值。缓存未命中时，读从库为空要再查一次主库，确认后才写空值缓存
- 短链删除或修改目标地址时，先更新数据库再删除缓存

---

## 四、跳转

### 1、状态码选择

| 状态码 | 浏览器缓存 | 请求方法 | 统计 | 适合 |
|--------|------------|----------|------|------|
| 301 永久 | 会缓存，之后不再访问短链服务 | 可能改为 GET | 缓存后统计不到 | 不需要统计、希望减少回源 |
| 302 临时 | 默认不缓存 | 可能改为 GET | 每次都能统计 | 需要点击统计（主流） |
| 307 临时 | 默认不缓存 | 保持原方法 | 每次都能统计 | 跳转目标是 POST 接口 |
| 308 永久 | 会缓存 | 保持原方法 | 缓存后统计不到 | 很少用于短链 |

需要统计时用 302，并加 `Cache-Control: no-store`（或 `private, max-age=0`），防止浏览器和中间代理缓存跳转结果。

### 2、跳转接口

```java
@GetMapping("/{code:[0-9a-zA-Z]{1,16}}")
public ResponseEntity<Void> redirect(@PathVariable String code, HttpServletRequest request) {
    String longUrl = shortUrlService.getLongUrl(code);
    if (longUrl == null) {
        return ResponseEntity.notFound().build();
    }
    // 先在请求线程里取出需要的字段，request 对象不能交给异步线程使用
    clickRecorder.record(code, request.getRemoteAddr(), request.getHeader(HttpHeaders.USER_AGENT));
    return ResponseEntity.status(HttpStatus.FOUND)
            .location(URI.create(longUrl))
            .cacheControl(CacheControl.noStore())
            .build();
}
```

- 部署在 Nginx 之后时，配置 `server.forward-headers-strategy=native`（或 `framework`），`getRemoteAddr()` 才能拿到 `X-Forwarded-For` 中的真实客户端 IP（只信任自己的代理）
- `record` 内部异步投递 Kafka，不阻塞跳转；投递失败只记日志，不影响跳转
- 生成短链时校验长 URL 的协议（只允许 http / https）并接入恶意网址检测，避免短链被用来分发钓鱼链接

---

## 五、访问统计

### 1、统计链路

跳转服务把 `shortCode、IP、UA、时间` 异步发到 Kafka，Flink 消费后做去重和聚合：实时计数写 Redis，明细写 ClickHouse 等 OLAP 供多维分析，见上方架构图的统计链路。Flink 的窗口与写出方式见 [海量数据处理](./2_big_data)。

### 2、同一 IP 短时间只计一次

```java
String key = "click:dedup:" + code + ":" + ip;
// SET key 1 NX EX 60：判断与设置过期在一条命令里，原子完成
Boolean first = redis.opsForValue().setIfAbsent(key, "1", Duration.ofSeconds(60));
if (Boolean.TRUE.equals(first)) {
    statService.increment(code);
}
```

先 `INCR` 再 `EXPIRE` 是两条命令：进程在中间崩溃，key 就永远不会过期，这个 IP 以后再也不会被计数。这里是固定窗口去重（60 秒内只计一次），不是滑动窗口。点击量很大时，这一步放在 Flink 里按 key 去重，比逐条访问 Redis 更省资源。

---

## 六、高可用

| 模块 | 方案 |
|------|------|
| 发号器 | 号段模式 + 双 Buffer，DB 短暂故障时靠已申请的号段继续发放 |
| 缓存 | Redis Cluster 多副本；热门短链再加本地缓存（Caffeine）扛热点，见 [热点问题](/high-con/6_hotspot) |
| 跳转服务 | 无状态，前置 Nginx 负载均衡，水平扩展 |
| 存储 | MySQL 主从；生成后预热缓存，从库查不到时回源主库 |
| 防穿透 | 空值缓存 60 秒，必要时加布隆过滤器 |
| 降级 | Redis 故障时限流后回源 DB，统计链路故障时丢弃统计、保证跳转 |

---

## 小结

- Base62 全文统一用 `0-9a-zA-Z` 字母表，6 位可表示约 568 亿个短码
- 推荐发号器 + Base62，并先对 ID 做可逆混淆，避免短码被顺序枚举；号段实现见分布式 ID 文档
- 32 位哈希存 1 亿条约有百万级冲突，必须靠唯一约束插入、比较 `long_url` 后加盐重试；Guava 用 `murmur3_32_fixed()`
- 点击量不放主表，计数走 Redis，明细走 OLAP
- 缓存 TTL 与短链过期时间一致，计算前排除已过期记录；空值缓存防穿透；生成时预热，避免主从延迟导致误判不存在
- 需要统计用 302 + `Cache-Control: no-store`；request 对象不能交给异步线程
- 计数去重用 `SET NX EX` 一条命令完成，不要拆成 `INCR` + `EXPIRE`

## 参考资料

- RFC 9110 HTTP Semantics（3xx 重定向）：[https://www.rfc-editor.org/rfc/rfc9110#name-redirection-3xx](https://www.rfc-editor.org/rfc/rfc9110#name-redirection-3xx)
- Guava Hashing：[https://guava.dev/releases/snapshot-jre/api/docs/com/google/common/hash/Hashing.html](https://guava.dev/releases/snapshot-jre/api/docs/com/google/common/hash/Hashing.html)
- Redis SET 命令：[https://redis.io/docs/latest/commands/set/](https://redis.io/docs/latest/commands/set/)
- Spring Boot 代理头处理：[https://docs.spring.io/spring-boot/how-to/webserver.html#howto.webserver.use-behind-a-proxy-server](https://docs.spring.io/spring-boot/how-to/webserver.html#howto.webserver.use-behind-a-proxy-server)

> 下一篇：[排行榜 & 积分系统设计](./7_rank_system) —— 基于 Redis ZSet 的实时榜、分时段榜与大规模排行优化。
