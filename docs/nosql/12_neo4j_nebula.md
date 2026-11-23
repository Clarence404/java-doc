---
description: Neo4j 版本与集群、Cypher 与量化路径、Java 驱动、NebulaGraph 分布式架构与 nGQL
---

# Neo4j 与 NebulaGraph

> 前置阅读：[图数据库概览](./11_graph_db)

Neo4j 是最成熟的原生图数据库，NebulaGraph 是面向千亿级点边的原生分布式图数据库。本篇讲两者的版本与架构、Cypher 与 nGQL 的基本用法和 Java 接入，基线为 Neo4j 2026.x（日历版本）、NebulaGraph 3。

---

## 一、Neo4j

### 1、产品与版本

- 最成熟的原生图数据库，ACID 事务，自带 GDS（Graph Data Science）图算法库
- **版本**：5.26 是 5.x 系列最后一个版本，也是 LTS（支持到 2028 年 6 月）；2025 年起改为日历版本号（2025.01、2025.02 ……），每月发布；2025.06 起 Cypher 语言单独版本化，可选 Cypher 5 或 Cypher 25
- **社区版**：GPLv3，单实例
- **企业版**：Neo4j 5 起用新的集群架构取代 4.x 的 Causal Clustering，服务器分为 primary（参与 Raft 写入共识）和 secondary（异步复制、扩展读），一个集群可承载多个数据库，各数据库可独立设置 primary / secondary 数量

### 2、Cypher 查询

```cypher
// 建索引（查找起点要用）
CREATE INDEX user_name IF NOT EXISTS FOR (u:User) ON (u.name);

// 建节点和关系：(节点)-[关系]->(节点)
CREATE (alice:User {name: 'Alice'})-[:FOLLOWS {since: 2024}]->(bob:User {name: 'Bob'});

// 好友的好友：排除自己和已关注的人，按共同关注数排序
MATCH (me:User {name: 'Alice'})-[:FOLLOWS]->(:User)-[:FOLLOWS]->(fof:User)
WHERE fof <> me
  AND NOT EXISTS { (me)-[:FOLLOWS]->(fof) }
RETURN fof.name AS name, count(*) AS mutual
ORDER BY mutual DESC
LIMIT 10;

// 风控团伙扩散：经「共用设备」关联 1~3 次能到达的用户（量化路径模式，5.9+）
MATCH (seed:User {phone: '13800000000'})
      ((:User)-[:USES]->(:Device)<-[:USES]-(:User)){1,3}
      (related:User)
WHERE related <> seed
RETURN DISTINCT related.name;
```

- `NOT EXISTS { ... }` 存在性子查询是 Neo4j 5 推荐的写法，取代旧的模式谓词
- 量化路径模式（Quantified Path Pattern）可以在重复的子路径上限定节点标签和关系类型，比旧的 `-[:USES*1..4]-` 更可控

### 3、Java 接入

官方驱动 `org.neo4j.driver:neo4j-java-driver`，5.7 起推荐用 `executableQuery`，自动管理会话与重试：

```java
import java.util.Map;

import org.neo4j.driver.AuthTokens;
import org.neo4j.driver.Driver;
import org.neo4j.driver.EagerResult;
import org.neo4j.driver.GraphDatabase;

public class FollowQuery {

    public static void main(String[] args) {
        try (Driver driver = GraphDatabase.driver("neo4j://localhost:7687",
                AuthTokens.basic("neo4j", "change-me-123"))) {
            driver.verifyConnectivity();

            EagerResult result = driver
                    .executableQuery("MATCH (u:User {name: $name})-[:FOLLOWS]->(f:User) RETURN f.name AS name")
                    .withParameters(Map.of("name", "Alice"))
                    .execute();

            result.records().forEach(r -> System.out.println(r.get("name").asString()));
        }
    }
}
```

Spring 生态可用 Spring Data Neo4j（`spring-boot-starter-data-neo4j`，`@Node` / `@Relationship` 注解映射）。

---

## 二、NebulaGraph

### 1、定位

- 国产开源的**原生分布式**图数据库，开源版当前为 3.8
- 存算分离：graphd（查询计算）、metad（元数据）、storaged（存储）
- 数据按点 ID 哈希到多个分区（partition），每个分区通过 Raft 多副本强一致复制
- 面向千亿级点边的超大规模图，在美团、快手、微众银行等有生产实践
- 查询语言 nGQL，同时兼容部分 openCypher 语法
- 事务：没有跨分区的 ACID 事务；一条边的正向与反向两份副本可能分布在不同分区，由 TOSS 机制保证最终一致

### 2、nGQL 示例

以下语句在 NebulaGraph Console 中依次执行：

```text
# 建图空间：单机演示用 1 副本，生产一般 replica_factor = 3
CREATE SPACE IF NOT EXISTS social (partition_num = 10, replica_factor = 1, vid_type = INT64);

# 新建的图空间要等约两个心跳周期（默认约 20 秒）后才能使用
USE social;

# 先定义点类型（Tag）和边类型（Edge Type），同样要等 schema 同步后再写入
CREATE TAG IF NOT EXISTS person(name string);
CREATE EDGE IF NOT EXISTS follows(since int);

INSERT VERTEX person(name) VALUES 1:("Alice"), 2:("Bob"), 3:("Carol");
INSERT EDGE follows(since) VALUES 1->2:(2024), 2->3:(2025);

# 从点 1 出发沿 follows 走 2 步
GO 2 STEPS FROM 1 OVER follows YIELD dst(edge) AS fof;
```

两者与 JanusGraph、Apache AGE 的横向对比见 [图数据库概览](./11_graph_db#三、选型对比)。

---

## 小结

- Neo4j 最成熟，ACID 事务、自带 GDS 图算法库；5.26 为最后一个 5.x LTS，此后按 2025.x 日历版本每月发布
- Neo4j 企业版集群为 primary / secondary 架构，社区版 GPLv3 单实例
- Cypher 用 `NOT EXISTS { ... }` 写存在性子查询，用量化路径模式代替不受控的变长路径；Java 驱动推荐 `executableQuery`
- NebulaGraph 存算分离、按点 ID 哈希分区，分区内 Raft 强一致，无跨分区 ACID
- 写 nGQL 前要先 `USE` 空间并定义 Tag / Edge，新建 schema 需等心跳同步

## 参考资料

- Neo4j 版本与支持策略：[https://neo4j.com/developer-blog/neo4j-v5-lts-evolution/](https://neo4j.com/developer-blog/neo4j-v5-lts-evolution/)
- Neo4j 集群：[https://neo4j.com/docs/operations-manual/current/clustering/introduction/](https://neo4j.com/docs/operations-manual/current/clustering/introduction/)
- Cypher 量化路径模式：[https://neo4j.com/docs/cypher-manual/current/patterns/variable-length-patterns/](https://neo4j.com/docs/cypher-manual/current/patterns/variable-length-patterns/)
- Neo4j Java 驱动：[https://neo4j.com/docs/java-manual/current/](https://neo4j.com/docs/java-manual/current/)
- NebulaGraph 文档：[https://docs.nebula-graph.io/](https://docs.nebula-graph.io/)

> 下一篇：[搜索数据库](./13_search_db) —— 搜索库定位、ES / OpenSearch / Solr / Meilisearch / 库内全文检索、向量检索、选型
