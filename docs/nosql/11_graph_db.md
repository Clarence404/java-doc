---
description: 多跳关系的代价与免索引邻接、典型场景、属性图模型、ISO GQL 标准、Apache AGE 等方案、选型
---

# 图数据库概览

> 前置阅读：[PostgreSQL 高级 SQL](/database/2_postgresql/3_topic_advanced_sql)

图数据库擅长多跳关系查询。本篇讲它相对关系型 JOIN 的优势与边界、属性图模型与 ISO GQL 标准、Apache AGE 等其他方案，以及何时值得引入图数据库。

---

## 一、为什么需要图数据库

NoSQL 通常分为键值（Redis，见 [Redis 基础](/cache/1_redis_base)）、文档、宽列和图四大类，本篇是最后一类。

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

## 二、其他方案

两款主流的原生图数据库及 Cypher、nGQL 的用法见 [Neo4j 与 NebulaGraph](./12_neo4j_nebula)，除此之外还有以下几种选择：

| 方案 | 形态 | 特点 |
|------|------|------|
| **Apache AGE** | PostgreSQL 扩展 | 在 PG 中用 openCypher 查询图，图数据与关系数据在同一个库，可以混合 SQL 与 Cypher；已有 PG 栈时引入成本最低 |
| **TuGraph** | 蚂蚁集团开源的图数据库 | 单机高性能，支持 Cypher 与 ISO GQL，内置图分析能力 |
| **JanusGraph** | 构建在 Cassandra / HBase / ScyllaDB 之上 | Gremlin 查询，适合已有大数据存储设施的团队 |
| 关系型 + 递归 CTE | PostgreSQL、MySQL 8.0+ 的 `WITH RECURSIVE` | 不引入新组件，适合层级树、浅层关系 |

递归 CTE 的写法见 [PostgreSQL 高级 SQL](/database/2_postgresql/3_topic_advanced_sql)。

---

## 三、选型对比

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
- 主流图数据库采用属性图模型：节点、标签、有方向有类型的关系、属性
- ISO/IEC 39075:2024 GQL 是正式的图查询语言标准，Cypher 正向其靠拢
- 已有 PG 栈可以先用 Apache AGE 或递归 CTE，规模与算法需求上来再引入专用图库

## 参考资料

- ISO/IEC 39075:2024 GQL：[https://www.iso.org/standard/76120.html](https://www.iso.org/standard/76120.html)
- Apache AGE：[https://age.apache.org/](https://age.apache.org/)
- TuGraph：[https://tugraph.tech/](https://tugraph.tech/)

> 下一篇：[Neo4j 与 NebulaGraph](./12_neo4j_nebula) —— Neo4j 版本与集群、Cypher 与量化路径、Java 驱动、NebulaGraph 分布式架构与 nGQL
