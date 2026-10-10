---
description: 推模式、拉模式、推拉结合、收件箱游标分页、可靠扇出、在线推送
---

# Feed 流和消息推送

> 前置阅读：[Redis 基础](/cache/1_redis_base)、[消息队列基础](/messaging/1_basics)

Feed 流把关注对象的内容聚合给用户，核心矛盾是**写扩散**（发布时写每个粉丝的收件箱）和**读扩散**（浏览时现拉现合并）之间的取舍。本篇讲推、拉、推拉结合的选择，ZSet 收件箱 + 游标分页、本地消息表 + MQ 的可靠扇出，以及在线推送的整体链路。

---

## 一、三种模式

![推模式、拉模式与推拉结合](../assets/scenario/feed-fanout.svg)

| 维度 | 推模式（写扩散） | 拉模式（读扩散） | 推拉结合 |
|------|----------------|----------------|---------|
| 发布时 | 写所有粉丝的收件箱 | 只写自己的发件箱 | 普通作者推，大 V 只写发件箱 |
| 浏览时 | 读自己的收件箱 | 拉所有关注对象的发件箱再归并 | 收件箱 + 关注的大 V 发件箱归并 |
| 读性能 | 最快 | 关注越多越慢 | 快 |
| 写放大 | 粉丝数倍，大 V 发布压力极大 | 无 | 只对普通作者 |
| 存储 | 高（每人一个收件箱） | 低 | 中 |
| 适合 | 关系有上限的社交（公开资料常以朋友圈为例，好友数有上限） | 关注少、对实时性要求不高 | 粉丝分布极不均匀的平台（常以微博为例） |

---

## 二、推模式（写扩散）

### 1、收件箱结构

收件箱用 ZSet，member 是内容 ID，score 是一个**按时间递增、在 2^53 以内**的值（score 是双精度浮点数，64 位雪花 ID 会丢精度，不能直接当 score）。本篇约定：

- `score = 发布毫秒时间戳 × 1000 + contentId % 1000`，约 1.8 × 10^15，小于 2^53
- 每个收件箱只保留最新 1000 条，更早的内容走拉模式从内容表查

### 2、可靠扇出

发布时不要在请求线程里起线程池写收件箱：进程崩溃时扇出直接丢失。生产上的链路是：

1. 发布接口在**同一个本地事务**里写内容表和本地消息表（Outbox）
2. 投递任务把「内容已发布」事件发到 MQ（做法见 [消息队列基础](/messaging/1_basics#_1、本地消息表-transactional-outbox) 的本地消息表一节）
3. 扇出消费者按游标分页读取粉丝列表，每批几百人，用管道批量写收件箱；失败由 MQ 重试

```java
public void fanOut(long contentId, long publishMillis, List<Long> followerIds) {
    double score = publishMillis * 1000d + contentId % 1000;
    byte[] member = String.valueOf(contentId).getBytes(StandardCharsets.UTF_8);

    redis.executePipelined((RedisCallback<Object>) conn -> {
        for (Long followerId : followerIds) {
            byte[] key = ("feed:inbox:" + followerId).getBytes(StandardCharsets.UTF_8);
            conn.zSetCommands().zAdd(key, score, member);
            conn.zSetCommands().zRemRange(key, 0, -1001);          // 只保留最新 1000 条
        }
        return null;
    });
}
```

`ZADD` 同一个 member 和 score 重复执行结果不变，重复消费天然幂等，消费端不需要额外去重。

### 3、游标分页

收件箱头部不断插入新内容，用 `offset` 翻页会出现重复和遗漏。改用**游标**：上一页最后一条的 score 作为下一页的上界（开区间）。

```bash
# 第一页
ZRANGE feed:inbox:1001 +inf -inf BYSCORE REV LIMIT 0 20 WITHSCORES
# 下一页：cursor 为上一页最后一条的 score，"(" 表示不含
ZRANGE feed:inbox:1001 (1791234567890123 -inf BYSCORE REV LIMIT 0 20 WITHSCORES
```

```java
public record FeedPage(List<Long> contentIds, Double nextCursor) {

    /** tuples 已按 score 倒序；不足一页说明没有下一页 */
    static FeedPage of(List<ZSetOperations.TypedTuple<String>> tuples, int size) {
        if (tuples.isEmpty()) return new FeedPage(List.of(), null);
        List<Long> ids = tuples.stream().map(t -> Long.parseLong(t.getValue())).toList();
        Double next = tuples.size() < size ? null : tuples.get(tuples.size() - 1).getScore();
        return new FeedPage(ids, next);
    }
}

public FeedPage inbox(long userId, Double cursor, int size) {
    double max = cursor == null ? Double.POSITIVE_INFINITY : Math.nextDown(cursor);   // 开区间
    Set<ZSetOperations.TypedTuple<String>> tuples = redis.opsForZSet()
            .reverseRangeByScoreWithScores("feed:inbox:" + userId, Double.NEGATIVE_INFINITY, max, 0, size);
    return FeedPage.of(tuples == null ? List.of() : new ArrayList<>(tuples), size);   // 返回的 Set 保持 Redis 顺序
}
```

下拉刷新则反过来，用第一条的 score 作下界取更新的内容。两条内容 score 完全相同的概率极低，这种情况下翻页边界可能漏掉一条，Feed 场景可以接受。

---

## 三、拉模式（读扩散）

每个作者维护一个发件箱 `feed:outbox:{authorId}`（同样的 score 规则），浏览时：

1. 取关注列表（关注上千人时需要分批）
2. 用管道对每个发件箱执行 `ZRANGE ... (cursor -inf BYSCORE REV LIMIT 0 size`
3. 在内存中多路归并，取前 `size` 条

正确性的依据：全局前 `size` 条中的任意一条，一定在它所属发件箱的前 `size` 条里，所以每个源只需取 `size` 条。代价是关注数越多，单次浏览的读放大越大。

---

## 四、推拉结合

- **普通作者**（粉丝数低于阈值，如 5000）：发布时推给全部粉丝
- **大 V**：只写自己的发件箱；可以额外推给**活跃粉丝**（近 7 天登录），减少他们浏览时的拉取
- **浏览时**：收件箱 + 关注的大 V 发件箱，按同一个游标归并

```java
public void onPublished(ContentPublishedEvent e) {                // 扇出消费者
    long fans = followService.followerCount(e.authorId());
    outbox.add(e.authorId(), e.contentId(), e.publishMillis());   // 所有作者都写发件箱
    if (fans < BIG_V_THRESHOLD) {
        followService.scanFollowers(e.authorId(), 500,
                batch -> fanOut(e.contentId(), e.publishMillis(), batch));
    } else {
        followService.scanActiveFollowers(e.authorId(), 500,
                batch -> fanOut(e.contentId(), e.publishMillis(), batch));
    }
}

public FeedPage feed(long userId, Double cursor, int size) {
    List<String> sources = new ArrayList<>();
    sources.add("feed:inbox:" + userId);
    followService.followingBigVs(userId).forEach(id -> sources.add("feed:outbox:" + id));

    // 每个源取 cursor 之后的前 size 条（管道批量），归并、按 score 倒序、按 contentId 去重
    List<ZSetOperations.TypedTuple<String>> merged = feedReader.readAll(sources, cursor, size);
    return FeedPage.of(merged, size);
}
```

活跃粉丝的收件箱里可能已经有大 V 的内容，同时又从发件箱拉到一次，所以归并时必须按 contentId 去重。大 V 的发件箱和新内容详情是典型的读热点，治理见 [热点问题](/high-con/6_hotspot)。

---

## 五、内容存储

收件箱和发件箱只存 ID，内容本身在 MySQL，详情经缓存批量读取：

```sql
CREATE TABLE content (
    id          BIGINT PRIMARY KEY,
    author_id   BIGINT   NOT NULL,
    body        TEXT,
    status      TINYINT  NOT NULL DEFAULT 1,     -- 1 正常 0 删除 / 审核不通过
    created_at  DATETIME(3) NOT NULL,
    KEY idx_author_time (author_id, created_at)
);
```

- `idx_author_time` 支撑「某作者的最新内容」，也是收件箱超出 1000 条后的回源查询
- 删除和审核下线不去扫粉丝收件箱，读取详情时按 `status` 过滤即可
- 内容的全文检索见 [搜索](./9_search_system)

---

## 六、在线推送

### 1、推送类型

| 类型 | 场景 | 方案 |
|------|------|------|
| 应用内实时通知 | 点赞、评论、关注 | WebSocket / SSE 长连接 |
| 系统消息 | 订单状态、活动通知 | MQ 异步写消息中心，在线时实时推 |
| App Push | 离线唤起 | APNs（iOS）、FCM 与国内厂商通道（Android） |
| 短信 | 验证码、重要通知 | 云厂商短信服务 |

### 2、集群推送链路

长连接分散在多个网关节点上，推送要先知道用户连在哪个节点。WebSocket 的协议、Netty 与 Spring 实现、集群路由方案对比见 [WebSocket](/netty/10_websocket)，这里只给出设计要点：

- **连接注册**：连接建立后写 `ws:route:{userId} → nodeId`，带 TTL 并随心跳续期，断开时删除
- **跨节点转发**：消息发往目标节点专属的 Redis Pub/Sub 频道（如 `ws:node:{nodeId}`），或用一个 MQ Topic 广播消费、各节点只处理本机连接的用户。不要按节点建 MQ Topic：节点扩缩容时 Topic 要跟着增减，而且 Kafka Topic 名只允许字母、数字、`.`、`_`、`-`
- **离线与可靠**：消息先持久化到消息中心（带 msgId），再尝试推送；客户端收到后回 `ACK(msgId)`，服务端只在收到 ACK 后才标记已送达，不要「先取出并删除离线消息再推送」，否则推送失败就丢了

### 3、ACK 与重推

1. 服务端推送时附带 msgId，记入「待确认」集合（如 ZSet，score 为重推时间）
2. 客户端收到后回复 ACK，服务端从待确认集合移除并标记已送达
3. 定时扫描超时未确认的消息重推，最多 N 次
4. 超过次数仍未确认，保留在离线消息中，等客户端重连后按 msgId 增量拉取；客户端按 msgId 去重

---

## 小结

- 推模式读快写放大，拉模式写简单读放大，粉丝分布不均的平台用推拉结合：普通作者推、大 V 拉、浏览时归并去重
- 收件箱用 ZSet，score 必须在 2^53 以内且按时间递增；只保留最新 N 条，更早的回源内容表
- 翻页用游标（上一页最后一条的 score，开区间），不用 offset
- 扇出走「本地消息表 + MQ + 批量管道写」，`ZADD` 天然幂等；不要用进程内线程池「发后不管」
- 在线推送：路由表 + 节点频道转发，消息先持久化、收到 ACK 才算送达；协议与实现细节见 Netty 模块

## 参考资料

- ZRANGE：[https://redis.io/docs/latest/commands/zrange/](https://redis.io/docs/latest/commands/zrange/)
- ZREMRANGEBYRANK：[https://redis.io/docs/latest/commands/zremrangebyrank/](https://redis.io/docs/latest/commands/zremrangebyrank/)
- Redis pipelining：[https://redis.io/docs/latest/develop/use/pipelining/](https://redis.io/docs/latest/develop/use/pipelining/)
- Redis Pub/Sub：[https://redis.io/docs/latest/develop/interact/pubsub/](https://redis.io/docs/latest/develop/interact/pubsub/)
- Kafka Topic 命名规则（`kafka-topics.sh` 与 Topic 配置）：[https://kafka.apache.org/documentation/#basic_ops_add_topic](https://kafka.apache.org/documentation/#basic_ops_add_topic)

> 下一篇：[搜索](./9_search_system) —— 商品搜索的 Mapping、查询、MySQL → ES 同步与零停机重建。
