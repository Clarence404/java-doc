---
description: Key/Value/TTL 规范、穿透与击穿防护、禁止事项、监控告警
---

# 缓存最佳实践

参考：[用好缓存的10条军规-苏三说技术](https://mp.weixin.qq.com/s/O4uto6IdP0rrtS2B2m3OXw)

## 一、Key 设计规范

```
业务名:模块名:唯一标识[:字段]

示例：
user:info:10001
order:detail:20240601:88888
product:stock:sku:A001
```

- **禁止使用中文**，避免编码问题
- **禁止过长的 key**（> 44字节时 String 底层从 embstr 升级为 raw，增加内存开销）
- **避免 key 过于通用**（如直接用 `id`），防止不同业务冲突
- **统一前缀**，方便按业务批量清理

---

## 二、Value 设计规范

- **拒绝 Big Key**：String > 10KB，或集合元素 > 10000 时需要拆分
- **序列化选择**：优先 JSON（可读、跨语言），数值型直接用 String；避免 Java 原生序列化
- **压缩大 Value**：超过 1KB 的 Value 考虑 Snappy/Gzip 压缩，内存换 CPU
- **不缓存整张表**：按需缓存，避免把整个列表/全量数据塞入一个 key

---

## 三、过期时间规范

- **所有缓存 key 必须设置过期时间**（`noeviction` 策略下不设TTL会 OOM）
- **避免大量 key 在同一时刻过期**（引发缓存雪崩），加随机抖动：

```java
// 不推荐
redisTemplate.expire(key, 3600, TimeUnit.SECONDS);

// 推荐：加 0-300 秒随机抖动
int jitter = ThreadLocalRandom.current().nextInt(300);
redisTemplate.expire(key, 3600 + jitter, TimeUnit.SECONDS);
```

- **热点数据用逻辑过期**（不设 TTL，存储带时间戳的数据，过期后异步刷新），防止击穿

---

## 四、缓存穿透防护

```java
// 方案1：缓存空值（短TTL，防止被利用）
public User getUser(Long id) {
    String key = "user:info:" + id;
    String cached = redisTemplate.opsForValue().get(key);

    if (cached != null) {
        return "null".equals(cached) ? null : deserialize(cached);
    }

    User user = userDao.findById(id);
    if (user == null) {
        redisTemplate.opsForValue().set(key, "null", 60, TimeUnit.SECONDS); // 缓存空值60秒
    } else {
        redisTemplate.opsForValue().set(key, serialize(user), 1800, TimeUnit.SECONDS);
    }
    return user;
}

// 方案2：布隆过滤器（适合ID规律的场景）
// 详见 3_redis_scenario.md 布隆过滤器章节
```

---

## 五、缓存击穿防护

```java
// 互斥锁重建（防止并发穿透）
public User getUser(Long id) {
    String key = "user:info:" + id;
    User user = getFromCache(key);
    if (user != null) return user;

    String lockKey = "lock:user:" + id;
    if (redisTemplate.opsForValue().setIfAbsent(lockKey, "1", 10, TimeUnit.SECONDS)) {
        try {
            // 双重检查
            user = getFromCache(key);
            if (user == null) {
                user = userDao.findById(id);
                setToCache(key, user);
            }
        } finally {
            redisTemplate.delete(lockKey);
        }
    } else {
        Thread.sleep(50);        // 等待其他线程重建完成
        user = getFromCache(key); // 再次读缓存
    }
    return user;
}
```

---

## 六、缓存与数据库一致性

1. **先更新DB，再删除缓存**（而不是更新缓存）
2. 高并发场景加**延迟双删**（删除后500ms再删一次）
3. 分布式场景发**MQ消息**广播失效
4. 详细方案见 [9_cache_consistency](./10_cache_consistency)

---

## 七、禁止事项

| 禁止 | 原因 | 替代方案 |
|------|------|---------|
| `KEYS *` | 全量扫描，阻塞线程 | `SCAN` 游标分批扫描 |
| `DEL` 大 key | 阻塞（O(n)）| `UNLINK` 异步删除 |
| 无 TTL 的缓存 key | 内存泄漏 | 必须设置过期时间 |
| 事务内执行 `WATCH` + 大量命令 | 事务期间其他客户端阻塞 | 用 Lua 脚本替代复杂事务 |
| 在循环内逐条 `GET/SET` | N次网络往返 | Pipeline 批量操作 |
| 缓存敏感信息明文 | 安全风险 | 加密后存储，或不缓存 |

---

## 八、监控告警

关键指标及告警阈值参考：

| 指标 | 说明 | 建议告警阈值 |
|------|------|------------|
| 命中率 (`hit_rate`) | 缓存有效性 | < 80% 告警 |
| 内存使用率 | 防止 OOM 或触发淘汰 | > 80% 告警 |
| 慢查询 (`slowlog`) | 命令执行超时 | > 10ms 记录，> 100ms 告警 |
| 连接数 | 连接池是否耗尽 | > 80% max 告警 |
| Full GC（客户端） | 大量反序列化导致 | 同 JVM 监控 |
