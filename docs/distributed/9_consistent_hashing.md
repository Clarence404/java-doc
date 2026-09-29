# 一致性哈希

> 一致性哈希（Consistent Hashing）是解决分布式系统中**节点动态扩缩容**时数据迁移问题的核心算法，广泛应用于缓存集群、分布式数据库、消息队列等场景。

---

## 一、普通哈希的问题

假设有 3 个 Redis 节点，使用普通取模路由：

```
key → hash(key) % 3 → 路由到节点 0/1/2
```

**问题**：当节点数从 3 变为 4（扩容）时：

```
key A → hash(A) % 3 = 1  （路由到节点1）
key A → hash(A) % 4 = 0  （路由到节点0）→ 缓存失效！
```

**几乎所有 key 的路由结果都发生变化**，缓存大规模失效，流量全部打到数据库（缓存雪崩）。

---

## 二、一致性哈希原理

### 2.1 哈希环（Hash Ring）

将哈希值空间构建成一个 **首尾相连的环**（0 到 2³² - 1）：

```
                    0
                 ↗     ↖
          2^32-1         1
         ↑                 ↓
    Node C               Node A
         ↑                 ↓
          2^32-1/4    2^32-1/2
                   ↓
                 Node B
```

**节点映射**：对每个节点的 IP / hostname 做哈希，映射到环上某个位置。

**数据路由**：对 key 做哈希，顺时针找到第一个节点，该节点负责存储该 key。

### 2.2 节点变化的影响范围

**扩容（新增节点 D）：**
```
只有 D 与其前驱节点之间的 key 需要迁移到 D
其他 key 路由不变
```

**缩容（删除节点 B）：**
```
只有原本属于 B 的 key 迁移到 B 的后继节点 C
其他 key 路由不变
```

**结论**：节点变化只影响 `1/N` 的数据（N 为节点数），大幅减少数据迁移量。

---

## 三、虚拟节点（Virtual Node）

### 3.1 数据倾斜问题

真实节点较少时，哈希环上分布可能极不均匀：

```
Node A 负责 70% 的 key（热点）
Node B 负责 20% 的 key
Node C 负责 10% 的 key
```

### 3.2 解决方案

为每个真实节点创建多个**虚拟节点**（复制品），均匀分布在哈希环上：

```
Node A → VNode A#1, VNode A#2, ... VNode A#150
Node B → VNode B#1, VNode B#2, ... VNode B#150
Node C → VNode C#1, VNode C#2, ... VNode C#150
```

虚拟节点越多，分布越均匀，通常设置 **150～200 个虚拟节点**（Memcached 实践值）。

### 3.3 实现方式

虚拟节点 key：`Node_A#1`、`Node_A#2`，对其哈希后放入有序结构（TreeMap）：

```java
// 构建哈希环（带虚拟节点）
TreeMap<Integer, String> ring = new TreeMap<>();
int virtualNodes = 150;

for (String node : nodes) {
    for (int i = 0; i < virtualNodes; i++) {
        int hash = hash(node + "#" + i);
        ring.put(hash, node);
    }
}

// 路由
public String getNode(String key) {
    int hash = hash(key);
    Map.Entry<Integer, String> entry = ring.ceilingEntry(hash); // 顺时针第一个
    if (entry == null) {
        entry = ring.firstEntry(); // 绕环
    }
    return entry.getValue();
}
```

---

## 四、在缓存集群中的应用

### 4.1 Redis Cluster 的方案

Redis Cluster **没有使用一致性哈希**，而是将 key 空间分为 **16384 个 slot（槽）**：

```
key → CRC16(key) % 16384 → slot → 路由到对应节点
```

扩缩容时只迁移受影响的 slot，与一致性哈希思路类似，但实现上是固定槽分配。

### 4.2 Memcached / Twemproxy（使用一致性哈希）

Twemproxy（Twitter 开源的 Redis/Memcached 代理）支持一致性哈希路由：

```yaml
# twemproxy 配置示例
beta:
  distribution: ketama      # 一致性哈希（ketama 算法）
  hash: md5
  servers:
    - 127.0.0.1:11211:1
    - 127.0.0.1:11212:1
    - 127.0.0.1:11213:1
```

`ketama` 是 Last.fm 实现的一致性哈希变种，使用 MD5 + 160 个虚拟节点，是缓存场景的工业标准实现。

### 4.3 本地缓存客户端（如 Jedis / Lettuce ShardedJedis）

早期 ShardedJedis 使用一致性哈希进行客户端分片：

```java
List<JedisShardInfo> shards = Arrays.asList(
    new JedisShardInfo("host1", 6379),
    new JedisShardInfo("host2", 6379)
);
ShardedJedis jedis = new ShardedJedis(shards); // 内部使用一致性哈希
```

（现代场景已被 Redis Cluster 取代，但原理一致）

---

## 五、在消息队列中的应用

### 5.1 Kafka

Kafka 的 Partition 分配不直接用一致性哈希，但同类思路体现在：

**Producer 路由**：
- 无 key：Round-Robin 或 Sticky Partition 策略
- 有 key：`hash(key) % partitionCount` → **相同 key 的消息有序**

**Consumer 分配**：
- RangeAssignor / RoundRobinAssignor / StickyAssignor
- StickyAssignor 在 Rebalance 时尽量保持原有分配（减少迁移），与一致性哈希的思路相同

### 5.2 RocketMQ

RocketMQ 的 MessageQueue 路由：
- Producer 通过 Topic 路由信息获取 MessageQueue 列表
- 发送时通过 `SelectMessageQueueByHash` 策略对 key 取模路由，相同 key 路由到同一队列（保证顺序消息）

### 5.3 Consistent Hashing 在 MQ 分区扩容中的价值

当分区数从 `N` 扩容到 `N+1` 时，普通取模导致大量消息路由变化，影响顺序消费。使用一致性哈希可将影响范围限制在 `1/(N+1)` 的消息。

---

## 六、其他应用场景

| 场景 | 说明 |
|------|------|
| 分布式数据库（Cassandra） | 数据按一致性哈希分布到各节点，副本存储在后继节点 |
| CDN 边缘节点路由 | 将请求 URL 哈希后路由到固定边缘节点，提升缓存命中率 |
| 分布式爬虫任务分配 | URL 哈希后分配到固定爬虫实例，避免重复抓取 |
| 微服务负载均衡（会话粘连） | 相同用户路由到同一实例，保留本地缓存 |
| P2P 网络（DHT）| BitTorrent、Kademlia 等 DHT 协议的核心路由机制 |

---

## 七、一致性哈希 vs 其他路由策略

| 策略 | 原理 | 扩容影响 | 适用场景 |
|------|------|---------|---------|
| 取模哈希（`% N`） | `hash(key) % N` | 近 100% key 迁移 | 节点固定不变的场景 |
| 一致性哈希 | 哈希环 + 顺时针路由 | `1/N` key 迁移 | 节点频繁变化 |
| 槽分配（Redis Cluster） | 固定 16384 槽 | 迁移受影响槽 | Redis Cluster |
| Range 分片 | 按 key 范围分区 | 可能不均匀 | 时序数据、有序扫描场景 |
| Round-Robin | 轮询 | 不涉及数据亲和 | 无状态服务负载均衡 |

::: tip 总结
一致性哈希核心价值：**将节点变化的影响范围从 O(N) 降低到 O(1/N)**，是分布式系统"平滑扩缩容"的关键算法之一。虚拟节点解决了数据倾斜问题，是工程落地的必选项。
:::
