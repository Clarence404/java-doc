---
description: 适用场景、属性图模型、Neo4j 与 Cypher、NebulaGraph、ISO GQL、Apache AGE、选型
---

# 图数据库

> **本篇目标**：理解图数据库在多跳关系查询上相对关系型 JOIN 的真正优势与边界，掌握 Neo4j（Cypher）和 NebulaGraph（nGQL）的基本用法，了解 ISO GQL 标准和 Apache AGE 等基于 PostgreSQL 的方案，能判断什么时候值得引入图数据库。
>
> **前置阅读**：[文档数据库](./2_document_db)、[PostgreSQL 高级 SQL](../2_postgresql/4_topic_advanced_sql)（递归 CTE）。NoSQL 通常分为键值（Redis，见 [Redis 基础](../../cache/1_redis_base)）、文档、宽列和图四大类，本篇是最后一类。

---

## 一、为什么需要图数据库

### 1、多跳关系的代价

关系型数据库表达「我关注的人关注的人」需要层层自连接：

```sql
-- 3 度关系：friend 表自连接 3 次
SELECT DISTINCT f3.friend_id
FROM friend f1
JOIN friend f2 ON f2.user_id = f1.friend_id
JOIN friend f3 ON f3.user_id = f2.friend_id
WHERE f1.user_id = 1;
```

无论用哪种数据库，N 度遍历要访问的数据量都大致按「平均出度的 N 次方」增长，这一点图数据库也无法改变。两者的差别在于**每一跳的代价**：

- 关系型：每一跳是一次 JOIN，需要在索引中查找（B+ 树查找，代价随表规模对数增长），中间结果集还要物化、去重
- 图数据库（以 Neo4j 为代表的原生图存储）：采用**免索引邻接（Index-Free Adjacency）**，节点直接持有指向相邻关系的指针，每一跳的代价只与该节点的度数相关，与全图规模无关

因此在深度 3 跳以上、需要沿路径做条件过滤或返回路径本身的场景，图数据库优势明显。但要注意：

- **超级节点**（度数百万的明星账号、公共设备）会让遍历瞬间爆炸，查询要限制关系类型、方向和深度，必要时对超级节点单独处理
- 不加关系类型和方向的变长路径（如 `-[*1..4]-`）很容易扫遍大半张图

### 2、典型场景

| 场景 | 用法 |
|------|------|
| 社交网络 | 好友推荐（共同好友）、N 度人脉 |
| 金融风控 | 反欺诈团伙识别（设备 / 手机号 / 收货地址关联图） |
| 推荐系统 | 用户-商品-标签异构图游走 |
| 知识图谱 | 实体关系问答，GraphRAG 的知识底座 |
| 依赖分析 | 微服务调用链、代码依赖、数据血缘 |

### 3、属性图模型

主流图数据库都采用**属性图（Property Graph）**模型：

| 元素 | 说明 | 示例 |
|------|------|------|
| 节点（Node / Vertex） | 实体 | 用户 Alice |
| 标签（Label / Tag） | 节点的类型，可以有多个 | `User`、`VIP` |
| 关系（Relationship / Edge） | 有方向、有类型的连接 | `(Alice)-[:FOLLOWS]->(Bob)` |
| 属性（Property） | 节点和关系上的键值对 | `name: 'Alice'`、`since: 2024` |

### 4、查询语言标准：GQL

2024 年 4 月，ISO 发布了 **ISO/IEC 39075:2024 GQL（Graph Query Language）**，这是继 SQL 之后 ISO 发布的第二个数据库查询语言标准。GQL 的模式匹配语法大量来自 Cypher，Neo4j 的 Cypher 25 与 openCypher 正在向 GQL 靠拢，NebulaGraph、TuGraph 等也在跟进。新项目优先学 Cypher 风格的语法，迁移成本最低。

---

## 二、Neo4j

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

## 三、NebulaGraph

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

---

## 四、其他方案

| 方案 | 形态 | 特点 |
|------|------|------|
| **Apache AGE** | PostgreSQL 扩展 | 在 PG 中用 openCypher 查询图，图数据与关系数据在同一个库，可以混合 SQL 与 Cypher；已有 PG 栈时引入成本最低 |
| **TuGraph** | 蚂蚁集团开源的图数据库 | 单机高性能，支持 Cypher 与 ISO GQL，内置图分析能力 |
| **JanusGraph** | 构建在 Cassandra / HBase / ScyllaDB 之上 | Gremlin 查询，适合已有大数据存储设施的团队 |
| 关系型 + 递归 CTE | PostgreSQL、MySQL 8.0+ 的 `WITH RECURSIVE` | 不引入新组件，适合层级树、浅层关系 |

递归 CTE 的写法见 [PostgreSQL 高级 SQL](../2_postgresql/4_topic_advanced_sql)。

---

## 五、选型对比

| 维度 | Neo4j | NebulaGraph | JanusGraph | Apache AGE |
|------|-------|-------------|------------|------------|
| 架构 | 原生图；社区版单机，企业版集群 | 原生分布式 | 依赖外部存储 | PG 扩展 |
| 查询语言 | Cypher（向 GQL 靠拢） | nGQL / 部分 openCypher | Gremlin | openCypher + SQL |
| 数据规模 | 单库数十亿点边 | 千亿级点边 | 百亿级 | 受 PG 单库限制 |
| 事务 | ACID | 分区内强一致，无跨分区 ACID 事务 | 依赖存储后端 | PG 的 ACID |
| 生态 | 最成熟，GDS 算法库最全 | 中文社区活跃 | 依赖 Hadoop 生态 | PG 生态 |
| 适用 | 中等规模、需要图算法、快速上手 | 超大规模、国产化 | 已有 HBase / Cassandra | 已有 PG、图查询为辅 |

选型经验：

- 图数据在千万级点边以内、查询多为 1~2 跳 → **关系型 + 递归 CTE 或冗余关系表**通常就够了，先别引入新组件
- 已有 PostgreSQL、图查询是辅助能力 → Apache AGE
- 需要图算法（PageRank、社区发现、最短路径）→ Neo4j GDS
- 点边规模十亿以上或需要水平扩展 → NebulaGraph

---

## 小结

- 多跳遍历的数据量按「出度的 N 次方」增长，图数据库改变不了这一点；它的优势是免索引邻接让每一跳只与节点度数相关，而不是一次索引 JOIN
- 超级节点和不限类型 / 方向的变长路径是图查询的主要性能陷阱
- ISO/IEC 39075:2024 GQL 是正式的图查询语言标准，Cypher 正向其靠拢
- Neo4j：5.26 为最后一个 5.x LTS，此后按 2025.x 日历版本每月发布；企业版集群为 primary / secondary 架构，社区版 GPLv3 单实例；Java 驱动推荐 `executableQuery`
- NebulaGraph：分区内 Raft 强一致，无跨分区 ACID；写 nGQL 前要先 `USE` 空间并定义 Tag / Edge，新建 schema 需等心跳同步
- 已有 PG 栈可以先用 Apache AGE 或递归 CTE，规模与算法需求上来再引入专用图库

## 参考资料

- ISO/IEC 39075:2024 GQL：[https://www.iso.org/standard/76120.html](https://www.iso.org/standard/76120.html)
- Neo4j 版本与支持策略：[https://neo4j.com/developer-blog/neo4j-v5-lts-evolution/](https://neo4j.com/developer-blog/neo4j-v5-lts-evolution/)
- Neo4j 集群：[https://neo4j.com/docs/operations-manual/current/clustering/introduction/](https://neo4j.com/docs/operations-manual/current/clustering/introduction/)
- Cypher 量化路径模式：[https://neo4j.com/docs/cypher-manual/current/patterns/variable-length-patterns/](https://neo4j.com/docs/cypher-manual/current/patterns/variable-length-patterns/)
- Neo4j Java 驱动：[https://neo4j.com/docs/java-manual/current/](https://neo4j.com/docs/java-manual/current/)
- NebulaGraph 文档：[https://docs.nebula-graph.io/](https://docs.nebula-graph.io/)
- Apache AGE：[https://age.apache.org/](https://age.apache.org/)
- TuGraph：[https://tugraph.tech/](https://tugraph.tech/)

> 下一篇：[CDC 工具](../5_practice/0_cdc_tools) —— 从数据库变更日志实时捕获数据，同步到搜索、缓存与数仓
