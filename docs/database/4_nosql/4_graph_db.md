# 图数据库

> NoSQL 四大类型：键值（Redis，见 [缓存模块](../../cache/0_redis_base)）、文档（MongoDB）、列族（HBase）、**图**。

## 一、为什么需要图数据库

关系型数据库处理"关系"反而是弱项——多跳关联需要层层 JOIN：

```sql
-- "我朋友的朋友的朋友"：3 张中间表 JOIN，深度每加一层性能指数级劣化
SELECT ... FROM friend f1
JOIN friend f2 ON f2.user_id = f1.friend_id
JOIN friend f3 ON f3.user_id = f2.friend_id
WHERE f1.user_id = 1;
```

图数据库把**关系存为一等公民**（免索引邻接，Index-Free Adjacency）：从任一节点出发沿边遍历是 O(1) 指针跳转，深度增加性能几乎不衰减。

**典型场景**：

| 场景 | 用法 |
|------|------|
| 社交网络 | 好友推荐（共同好友）、N 度人脉 |
| 金融风控 | 反欺诈团伙识别（设备/手机号/收货地址关联图）|
| 推荐系统 | 用户-商品-标签异构图游走 |
| 知识图谱 | 实体关系问答，RAG 的 GraphRAG 底座 |
| 依赖分析 | 微服务调用链、代码依赖、血缘分析 |

---

## 二、Neo4j

- 官网：[neo4j.com](https://neo4j.com/)，最成熟的图数据库（DB-Engines 图类常年第一）
- **属性图模型**：节点（Node）+ 关系（Relationship）+ 属性（Property）+ 标签（Label）
- 单机架构（社区版），企业版支持因果集群；ACID 事务

### Cypher 查询语言

```cypher
// 建节点和关系：(节点)-[关系]->(节点)，ASCII 艺术式语法
CREATE (alice:User {name: 'Alice'})-[:FOLLOWS {since: 2024}]->(bob:User {name: 'Bob'})

// 好友的好友（排除已关注的和自己）
MATCH (me:User {name: 'Alice'})-[:FOLLOWS]->(:User)-[:FOLLOWS]->(fof:User)
WHERE NOT (me)-[:FOLLOWS]->(fof) AND me <> fof
RETURN fof.name, COUNT(*) AS mutual
ORDER BY mutual DESC LIMIT 10

// 变长路径：1~4 跳内的所有可达用户（风控团伙扩散）
MATCH (seed:User {phone: '138xxx'})-[*1..4]-(related:User)
RETURN DISTINCT related
```

### Java 接入

```java
// 官方驱动 org.neo4j.driver:neo4j-java-driver
try (var driver = GraphDatabase.driver("bolt://localhost:7687",
        AuthTokens.basic("neo4j", "password"));
     var session = driver.session()) {
    var result = session.run(
        "MATCH (u:User {name: $name})-[:FOLLOWS]->(f) RETURN f.name AS name",
        Map.of("name", "Alice"));
    result.stream().forEach(r -> System.out.println(r.get("name").asString()));
}
// Spring 生态：spring-boot-starter-data-neo4j（@Node / @Relationship 注解映射）
```

---

## 三、NebulaGraph

- 官网：[nebula-graph.com.cn](https://www.nebula-graph.com.cn/)，国产开源**分布式**图数据库
- 存算分离：graphd（计算）/ metad（元数据）/ storaged（存储，Raft 多副本）
- 面向**千亿点边**的超大规模图，美团、快手、微众银行等生产验证
- 查询语言 nGQL（部分兼容 openCypher）

```sql
-- 建图空间（分片 + 副本）
CREATE SPACE social (partition_num = 100, replica_factor = 3, vid_type = INT64);

-- 插入点和边
INSERT VERTEX user(name) VALUES 1:('Alice'), 2:('Bob');
INSERT EDGE follows(since) VALUES 1 -> 2:(2024);

-- GO 语句：从起点向外遍历 2 步
GO 2 STEPS FROM 1 OVER follows YIELD dst(edge) AS fof;
```

---

## 四、选型对比

| 维度 | Neo4j | NebulaGraph | JanusGraph |
|------|-------|-------------|------------|
| 架构 | 单机为主（企业版集群）| 原生分布式 | 构建在 HBase/Cassandra 之上 |
| 查询语言 | Cypher（事实标准）| nGQL | Gremlin |
| 数据规模 | 十亿级边（单机上限）| 千亿级 | 百亿级 |
| 事务 | ACID | 弱（最终一致）| 部分 |
| 生态/文档 | 最成熟 | 中文社区活跃 | 依赖 Hadoop 生态 |
| 适用 | 中小规模、快速上手、算法库全 | 超大规模、国产化 | 已有大数据存储设施 |

**选型经验**：

- 图数据 < 千万级点边、且查询多为 1~2 跳 → **关系型 + 递归 CTE 或冗余表可能就够了**，先别引入新组件
- 需要图算法（PageRank、社区发现、最短路径）→ Neo4j GDS 库最全
- 点边规模十亿以上或需要水平扩展 → NebulaGraph
