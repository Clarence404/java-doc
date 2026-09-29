# Feed 流 & 消息推送系统设计

> Feed 流是社交产品的核心功能，将关注者的内容聚合推送给用户。微博、朋友圈、抖音首页均为典型 Feed 流场景。

---

## 一、Feed 流核心问题

**写扩散（推模式）**：用户发布内容时，立即推送给所有粉丝的收件箱。
**读扩散（拉模式）**：用户浏览时，实时从关注列表拉取各人的最新内容聚合。
**推拉结合**：活跃用户推，大 V 拉，兼顾性能与实时性。

---

## 二、推模式（写扩散）

### 2.1 原理

用户发布内容时，遍历所有粉丝，将内容 ID 写入每个粉丝的 Feed 收件箱（Redis List 或 DB）。

```
用户 A 发布内容
    ↓
查询 A 的粉丝列表（10w 粉丝）
    ↓
并发写入 10w 个粉丝的 Feed List（Redis）
```

### 2.2 Redis 实现

```java
// 发布内容后，异步推送给粉丝
public void pushToFollowers(Long authorId, Long contentId) {
    List<Long> followerIds = followService.getFollowers(authorId);

    // 分批异步写入，避免单次任务过重
    Lists.partition(followerIds, 100).forEach(batch ->
        executor.execute(() -> batch.forEach(followerId -> {
            String key = "feed:inbox:" + followerId;
            // LPUSH + LTRIM 保留最新 1000 条
            redisTemplate.opsForList().leftPush(key, contentId.toString());
            redisTemplate.opsForList().trim(key, 0, 999);
        }))
    );
}

// 用户拉取 Feed（直接读自己的收件箱）
public List<Long> getFeed(Long userId, int offset, int limit) {
    String key = "feed:inbox:" + userId;
    return redisTemplate.opsForList()
        .range(key, offset, offset + limit - 1)
        .stream().map(Long::parseLong).collect(Collectors.toList());
}
```

### 2.3 优缺点

| 优点 | 缺点 |
|------|------|
| 读取极快（直接读收件箱） | 写放大严重（大 V 千万粉丝，一次发布写千万次） |
| 实时性高 | 存储成本高（每人维护收件箱） |
| 适合粉丝量小的普通用户 | 大 V 发布时系统压力极大 |

---

## 三、拉模式（读扩散）

### 3.1 原理

用户浏览时，实时拉取所有关注人的最新内容，在内存中合并排序后返回。

```
用户 A 打开 Feed
    ↓
查询 A 的关注列表（关注了 200 人）
    ↓
并发查询每人的最新内容
    ↓
归并排序（按时间/权重）
    ↓
返回 Top N 条
```

### 3.2 优缺点

| 优点 | 缺点 |
|------|------|
| 写操作简单（只写发布者自己的内容表） | 读取慢（关注越多，合并越慢） |
| 存储成本低 | 关注人多时，并发查询压力大 |
| 适合大 V（粉丝多但关注少） | 实时性依赖各服务响应速度 |

---

## 四、推拉结合（主流方案）

### 4.1 策略

- **普通用户**（粉丝 < 阈值，如 5000）：发布时推送给所有粉丝（推模式）
- **大 V**（粉丝 ≥ 阈值）：只推送给**活跃粉丝**（近 7 天有登录），其余粉丝登录时再拉
- **读取时**：收件箱内容（推）+ 关注大 V 的最新内容（拉）合并

```java
public void publish(Long authorId, Long contentId) {
    long followerCount = followService.getFollowerCount(authorId);

    if (followerCount < 5000) {
        // 普通用户：全量推
        pushToFollowers(authorId, contentId);
    } else {
        // 大 V：只推活跃粉丝
        List<Long> activeFollowers = followService.getActiveFollowers(authorId);
        pushToFollowers(activeFollowers, contentId);
        // 非活跃粉丝下次登录时拉取
    }
}

public List<Content> getFeed(Long userId) {
    // 1. 从收件箱读（推的部分）
    List<Long> inboxIds = getInbox(userId);

    // 2. 拉取关注大 V 的最新内容
    List<Long> followingBigVIds = followService.getFollowingBigVs(userId);
    List<Long> bigVContentIds = contentService.getLatestByAuthors(followingBigVIds);

    // 3. 合并去重排序
    return mergeAndSort(inboxIds, bigVContentIds);
}
```

---

## 五、Feed 流存储设计

### 5.1 收件箱（Redis）

```bash
# 用 ZSet 替代 List，用时间戳做 score，支持按时间范围查询
ZADD feed:inbox:{userId} {timestamp} {contentId}

# 取最新 20 条
ZREVRANGEBYSCORE feed:inbox:{userId} +inf -inf LIMIT 0 20

# 控制大小：只保留最新 1000 条（防止 Redis 内存膨胀）
ZREMRANGEBYRANK feed:inbox:{userId} 0 -1001
```

### 5.2 内容存储（MySQL + ES）

```sql
-- 内容表
CREATE TABLE content (
    id          BIGINT PRIMARY KEY,
    author_id   BIGINT NOT NULL,
    content     TEXT,
    created_at  DATETIME NOT NULL,
    INDEX idx_author_time (author_id, created_at DESC)
);
```

按 `author_id + created_at` 索引，支持"查某人最新内容"的高效查询。

---

## 六、消息推送系统

### 6.1 推送类型

| 类型 | 场景 | 方案 |
|------|------|------|
| 应用内通知 | 点赞、评论、关注 | WebSocket / SSE 长连接 |
| 系统消息 | 订单状态变更、活动通知 | MQ 异步推送 |
| App Push | 离线用户唤起 | APNs（iOS）/ FCM（Android）|
| 短信 | 验证码、重要通知 | 三方短信服务（阿里云/腾讯云）|

### 6.2 实时推送架构（WebSocket）

```
用户连接 WebSocket Server（长连接）
    ↓
用户 ID → 连接 ID 映射存 Redis
    ↓
后端有消息时，查 Redis 找到对应连接
    ↓
推送消息到该连接
```

```java
// 消息推送服务
public void pushToUser(Long userId, Notification notification) {
    // 查询用户连接在哪台 WebSocket Server
    String serverId = redis.hget("user:conn:server", userId.toString());
    if (serverId == null) {
        // 用户不在线，存入离线消息队列
        offlineMessageService.save(userId, notification);
        return;
    }

    if (serverId.equals(currentServerId)) {
        // 在当前服务器，直接推
        webSocketManager.sendToUser(userId, notification);
    } else {
        // 在其他服务器，通过 MQ 转发
        mqTemplate.send("ws-forward-topic:" + serverId,
            new ForwardMessage(userId, notification));
    }
}
```

### 6.3 离线消息处理

用户重新上线时，拉取离线期间的消息：

```java
@OnOpen
public void onOpen(Session session, Long userId) {
    // 注册连接
    webSocketManager.register(userId, session);
    redis.hset("user:conn:server", userId.toString(), currentServerId);

    // 推送离线消息
    List<Notification> offlineMsg = offlineMessageService.getAndClear(userId);
    offlineMsg.forEach(msg -> session.sendText(JSON.toJSONString(msg)));
}
```

### 6.4 消息可靠性保证

**问题**：WebSocket 连接不稳定，推送可能丢失。

**方案**：消息 ACK 机制
```
服务端推送消息，附带 msgId
客户端收到后回复 ACK(msgId)
服务端未收到 ACK，定时重推（最多 N 次）
超过重试次数，存入离线消息
```

---

## 七、方案对比总结

| 场景 | 推模式 | 拉模式 | 推拉结合 |
|------|--------|--------|---------|
| 普通用户（少量粉丝） | ✅ 最优 | 可接受 | — |
| 大 V（海量粉丝） | ❌ 写放大 | ✅ 可接受 | ✅ 最优 |
| 读取速度 | 极快 | 慢（粉丝多时） | 快 |
| 存储成本 | 高 | 低 | 中 |
| 实时性 | 高 | 高（实时拉） | 高 |
| 代表产品 | 早期微博 | RSS | 微博/微信朋友圈 |
