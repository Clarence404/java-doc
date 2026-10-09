---
description: 哈希环、虚拟节点、Java 实现、Jump Hash 等变体、Redis Cluster 槽位、MQ 分区路由
---

# 一致性哈希

> **本篇目标**：理解一致性哈希为什么能让扩缩容只迁移约 1/N 的数据，会用虚拟节点解决倾斜并写出可用的实现；了解 Jump Hash、Rendezvous、Maglev、有界负载等变体，分清 Redis Cluster 槽位与 Kafka 分区路由和一致性哈希的区别。
>
> **前置阅读**：[分布式理论](./2_theorem)

---

## 一、取模路由的问题

把 key 路由到 N 个节点，最直接的做法是 `hash(key) % N`。节点数从 3 变成 4 时：

| key | `hash % 3` | `hash % 4` |
|-----|------------|------------|
| hash = 7 | 1 | 3 |
| hash = 8 | 2 | 0 |
| hash = 9 | 0 | 1 |

大约只有 1/4 的 key 还落在原节点，其余全部换了位置。用于缓存时，扩容瞬间大面积缓存未命中，请求全部打到数据库；用于存储时，几乎要迁移全部数据。

---

## 二、哈希环

### 1、原理

把哈希值空间（如 0 到 2^32 − 1）首尾相接成一个环：

- **节点上环**：对节点标识（IP:端口或名称）求哈希，落在环上某个位置
- **key 路由**：对 key 求哈希，从该位置**顺时针**找到的第一个节点负责这个 key

![一致性哈希环：新增节点 D 只接管一段弧](../assets/distributed/consistent-hash-ring.svg)

### 2、节点变化的影响

- **新增节点 D**：只有 D 与它逆时针方向上一个节点之间的那段弧上的 key，从原来的后继节点转给 D
- **删除节点 B**：只有原属于 B 的 key 转给 B 的顺时针后继节点

增删一个节点时，大约只有 K / N 个 key 需要移动（K 为 key 总数，N 为节点数），即约 1/N 的数据，而取模方式下几乎全部移动。

---

## 三、虚拟节点

### 1、数据倾斜

节点少时，几个哈希点在环上的间隔很不均匀，某个节点可能负责大半个环。删除一个节点时，它的数据全部压到唯一的后继节点上，后继节点负载翻倍。

### 2、解决方式

每个物理节点在环上放多个**虚拟节点**（对 `节点名#序号` 分别求哈希），路由到虚拟节点后再映射回物理节点。虚拟节点越多分布越均匀：

- 每个物理节点的负载接近 1/N
- 某个节点下线时，它的数据被分散到多个其他节点，而不是全压给一个
- 可以按机器性能分配不同数量的虚拟节点，实现加权

工业上常用的 ketama 算法（Last.fm 为 Memcached 客户端实现）给每台服务器 160 个点：对 `服务器#i` 做 40 次 MD5，每个 16 字节的摘要切成 4 个 32 位整数。

### 3、Java 实现

```java
public final class ConsistentHashRouter {

    private final ConcurrentSkipListMap<Long, String> ring = new ConcurrentSkipListMap<>();
    private final int replicas;                        // 每个节点的 MD5 次数，每次产生 4 个点

    public ConsistentHashRouter(Collection<String> nodes, int replicas) {
        this.replicas = replicas;                      // ketama 取 40，即 160 个虚拟节点
        nodes.forEach(this::addNode);
    }

    public void addNode(String node) {
        for (long point : points(node)) {
            ring.putIfAbsent(point, node);             // 极少数哈希冲突时保留先放入的节点
        }
    }

    public void removeNode(String node) {
        for (long point : points(node)) {
            ring.remove(point, node);
        }
    }

    public String route(String key) {
        if (ring.isEmpty()) {
            throw new IllegalStateException("没有可用节点");
        }
        Map.Entry<Long, String> e = ring.ceilingEntry(hash(md5(key), 0));
        return (e != null ? e : ring.firstEntry()).getValue();   // 超过最大值则绕回环首
    }

    private List<Long> points(String node) {
        List<Long> result = new ArrayList<>(replicas * 4);
        for (int i = 0; i < replicas; i++) {
            byte[] digest = md5(node + "#" + i);
            for (int part = 0; part < 4; part++) {
                result.add(hash(digest, part));
            }
        }
        return result;
    }

    /** 取摘要中第 part 段的 4 个字节，按小端拼成 0 ~ 2^32-1 的无符号整数 */
    private static long hash(byte[] d, int part) {
        int o = part * 4;
        return ((long) (d[o + 3] & 0xFF) << 24) | ((long) (d[o + 2] & 0xFF) << 16)
             | ((long) (d[o + 1] & 0xFF) << 8) | (d[o] & 0xFF);
    }

    private static byte[] md5(String s) {
        try {
            return MessageDigest.getInstance("MD5").digest(s.getBytes(StandardCharsets.UTF_8));
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }
}
```

这里的 MD5 只用于把字符串打散到均匀的数值空间，不涉及安全性。不要用 `String.hashCode()`：它的分布很差，相近的节点名会挤在一起。追求速度时可以换成 MurmurHash3（如 Guava 的 `Hashing.murmur3_32_fixed()`）或 xxHash。

---

## 四、变体与对比

哈希环之外，还有几种解决同一问题的算法：

| 算法 | 思路 | 查找复杂度 | 内存 | 限制 | 典型应用 |
|------|------|------------|------|------|----------|
| 哈希环 + 虚拟节点 | 顺时针找最近的节点 | O(log V)，V 为虚拟节点总数 | O(V) | 均匀度依赖虚拟节点数量 | Memcached 客户端（ketama）、Nginx `hash ... consistent`、Dubbo 一致性哈希负载均衡 |
| Jump Consistent Hash（Google 2014） | 用一个简短的伪随机跳跃过程直接算出桶号 | O(log N) | 不需要额外内存 | 桶只能编号为 0..N−1，只能在末尾增删，不能任意摘除中间节点 | 存储分片数量只增不减的场景 |
| Rendezvous / HRW 哈希 | 对每个节点计算 `score(key, node)`，取最大者 | O(N) | O(N) | 节点很多时查找慢 | 节点数较少、需要加权的场景 |
| Maglev（Google 2016） | 预先生成固定大小的查找表，查表即可 | O(1) | 查找表 | 节点变化时有少量额外扰动 | Envoy、四层负载均衡 |
| 有界负载一致性哈希（Google 2017） | 在哈希环基础上给每个节点设负载上限，超限则顺延到下一个节点 | O(log V) 起 | O(V) | 牺牲少量粘性换均衡 | HAProxy `hash-balance-factor`、Envoy `hash_balance_factor` |

---

## 五、在缓存与负载均衡中的应用

### 1、Redis Cluster 用的是槽位，不是一致性哈希

Redis Cluster 把 key 空间固定分为 16384 个槽：`slot = CRC16(key) % 16384`，每个主节点负责一部分槽。

- 扩缩容时迁移的是槽，由运维用 `redis-cli --cluster reshard` 等工具或托管平台触发，**不会自动重新平衡**
- 迁移期间客户端可能收到 `MOVED`（槽已永久转移，更新本地槽表）或 `ASK`（槽正在迁移，只对这一次请求去目标节点）重定向
- 多 key 命令要求所有 key 在同一个槽，可以用哈希标签 `{user:1001}:profile`、`{user:1001}:orders` 让它们只按花括号里的部分计算槽

槽位与一致性哈希都做到了「扩容只动一部分数据」，区别是槽位的映射关系是显式维护的表，可以精确控制每个槽放在哪。详见 [Redis 集群](/cache/3_redis_cluster)。

### 2、客户端分片与代理

- **客户端分片**：早期 Jedis 的 `ShardedJedis` 用一致性哈希在客户端分片，它在 Jedis 3.x 废弃、4.0 移除，Lettuce 从未提供这种分片方式。现在应直接使用 Redis Cluster
- **Twemproxy**：Twitter 的 Redis / Memcached 代理，支持 `distribution: ketama`，项目已多年不活跃，属于历史方案
- **Memcached 客户端**：仍普遍使用 ketama 一致性哈希

### 3、负载均衡的会话亲和

希望同一用户的请求落到同一实例（利用本地缓存、WebSocket 连接）时，用一致性哈希比取模更稳：实例增减只影响一小部分用户。Nginx 的 `hash $key consistent`、Dubbo 的 `ConsistentHashLoadBalance`（默认 160 个虚拟节点）都是这一用法，见 [负载均衡](/high-avail/3_load_balancing)。

---

## 六、消息队列的分区路由

消息队列一般**不使用一致性哈希**，而是对分区数取模：

- **Kafka**：有 key 的消息用 `murmur2(keyBytes) % 分区数` 选分区，同一 key 进同一分区，从而保证分区内有序。没有 key 时，2.4 起使用粘性分区（一批消息先填满一个分区再换），3.3 起内置为均匀粘性分区（KIP-794），不是轮询
- **RocketMQ**：顺序消息常用 `SelectMessageQueueByHash`，即 `key.hashCode() % 队列数`

所以**增加分区或队列会改变 key 到分区的映射**，变更瞬间同一个 key 的新旧消息可能落在不同分区，顺序被打乱。需要严格有序的 topic 应一次性规划好分区数；确实要扩容时，先暂停生产或等旧分区消费完再切换。自定义一致性哈希分区器只能减少映射变化的 key 数量，不能消除这个问题。

---

## 七、其他应用

| 场景 | 说明 |
|------|------|
| Cassandra | 用 token 环分布数据，每个节点持有多个 vnode（4.0 起 `num_tokens` 默认 16）；副本位置由复制策略决定，`NetworkTopologyStrategy` 会按机架 / 数据中心挑选副本 |
| Amazon Dynamo（2007 年论文） | 一致性哈希 + 虚拟节点 + 首选列表复制，是很多 NoSQL 的设计源头 |
| Chord DHT | 基于哈希环的点对点路由；Kademlia 则使用 XOR 距离，并不是环 |
| CDN 与缓存代理 | 同一 URL 固定到同一缓存节点，提高命中率 |

---

## 八、路由策略对比

| 策略 | 原理 | 增删一个节点时迁移的数据 | 适用场景 |
|------|------|--------------------------|----------|
| 取模 `hash % N` | 直接取余 | 几乎全部 | 节点数固定不变 |
| 哈希环 + 虚拟节点 | 顺时针找最近节点 | 约 1/N | 缓存集群、会话亲和 |
| Jump Hash | 算法直接算桶号 | 约 1/N（只能在末尾增删） | 分片数只增不减 |
| 槽位（Redis Cluster） | 固定槽数，槽表映射到节点 | 只迁移被移动的槽，可精确控制 | 需要可控迁移的存储集群 |
| 范围分片 | 按 key 的区间划分 | 拆分或合并相邻区间，可在线完成 | 有序扫描、时间序列；需要防止热点区间 |

---

## 小结

- 取模路由在节点数变化时几乎所有 key 都会换位置；一致性哈希只移动约 1/N
- 虚拟节点解决分布不均与下线时负载集中，ketama 每台服务器 160 个点
- 实现时用 MD5 / Murmur / xxHash 打散，不用 `String.hashCode()`，有序结构用 `TreeMap` 或 `ConcurrentSkipListMap`
- Jump Hash 零内存但只能在末尾增删；Rendezvous 适合节点少；Maglev 查表 O(1)；有界负载在粘性与均衡之间折中
- Redis Cluster 用 CRC16 % 16384 的槽位，不是一致性哈希；`ShardedJedis` 已在 Jedis 4 移除
- Kafka / RocketMQ 按分区数取模，增加分区会打乱同一 key 的顺序

## 参考资料

- Karger et al., Consistent Hashing and Random Trees（STOC 1997）：[https://dl.acm.org/doi/10.1145/258533.258660](https://dl.acm.org/doi/10.1145/258533.258660)
- Lamping & Veach, A Fast, Minimal Memory, Consistent Hash Algorithm（Jump Hash，2014）：[https://arxiv.org/abs/1406.2294](https://arxiv.org/abs/1406.2294)
- Eisenbud et al., Maglev: A Fast and Reliable Software Network Load Balancer（NSDI 2016）：[https://www.usenix.org/conference/nsdi16/technical-sessions/presentation/eisenbud](https://www.usenix.org/conference/nsdi16/technical-sessions/presentation/eisenbud)
- Mirrokni et al., Consistent Hashing with Bounded Loads：[https://arxiv.org/abs/1608.01350](https://arxiv.org/abs/1608.01350)
- Redis Cluster Specification：[https://redis.io/docs/latest/operate/oss_and_stack/reference/cluster-spec/](https://redis.io/docs/latest/operate/oss_and_stack/reference/cluster-spec/)
- Kafka KIP-794 Strictly Uniform Sticky Partitioner：[https://cwiki.apache.org/confluence/display/KAFKA/KIP-794%3A+Strictly+Uniform+Sticky+Partitioner](https://cwiki.apache.org/confluence/display/KAFKA/KIP-794%3A+Strictly+Uniform+Sticky+Partitioner)
- Nginx upstream hash 指令：[https://nginx.org/en/docs/http/ngx_http_upstream_module.html#hash](https://nginx.org/en/docs/http/ngx_http_upstream_module.html#hash)
- Cassandra 数据分布（vnodes）：[https://cassandra.apache.org/doc/latest/cassandra/architecture/dynamo.html](https://cassandra.apache.org/doc/latest/cassandra/architecture/dynamo.html)

> 返回：[分布式总览](./0_overview)
