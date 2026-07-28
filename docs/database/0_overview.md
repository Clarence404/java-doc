# 数据库总览

数据库模块用于沉淀 Java 后端常见的数据存储知识，覆盖关系型数据库、NoSQL、搜索、备份恢复、分库分表、连接池与选型实践。

## 一、模块地图

| 方向 | 内容 | 适合关注 |
|------|------|----------|
| MySQL 专题 | 基础、版本特性、MariaDB、避坑、索引、事务与锁 | Java 后端主力 OLTP 场景 |
| PostgreSQL 专题 | 基础、版本特性、MVCC、索引、高级 SQL | 复杂 SQL、JSONB、GIS、分析型查询 |
| 关系型生态 | Oracle、达梦、人大金仓、ORM 框架 | 企业数据库迁移与持久层选型 |
| NoSQL 生态 | 列式、分布式、时序、文档、搜索数据库 | 多模型存储与特定场景优化 |
| 运维架构 | CDC、备份恢复、分库分表、连接池 | 数据可靠性、扩展性与应用接入 |
| 选型源码 | MBCJ 源码、数据库选型参考 | 原理阅读与技术方案决策 |

## 二、推荐阅读路径

1. 先读 [MySQL 概览](./1_mysql/0_overview)，建立范式、视图、存储过程、优化、复制与运维基础。
2. 再读 [MySQL 索引专项](./1_mysql/4_topic_mysql_index) 和 [事务与锁专项](./1_mysql/5_topic_mysql_transaction)，补齐高频性能与并发问题。
3. 对比 [PostgreSQL 概览](./2_postgresql/0_overview)，理解 PostgreSQL 与 MySQL 在类型系统、MVCC、索引和高级 SQL 上的差异。
4. 进入 [NoSQL 生态](./4_nosql/1_distributed_db)，按业务场景补充分布式数据库、文档数据库、时序数据库与搜索数据库。
5. 最后看 [备份恢复](./5_ops/1_backup_recovery)、[分库分表](./5_ops/2_sharding)、[连接池](./5_ops/3_connection_pool) 和 [数据库选型](./6_misc/1_db_ranking_selection)，形成工程落地能力。

## 三、选型原则

| 问题 | 优先判断 |
|------|----------|
| 是否需要强事务与复杂关联查询 | 优先 MySQL / PostgreSQL 等关系型数据库 |
| 是否读多写少且需要全文检索 | 优先 Elasticsearch / OpenSearch / Solr 等搜索引擎 |
| 是否数据量巨大且需要水平扩展 | 评估分库分表、TiDB、OceanBase 等方案 |
| 是否以时间序列指标为核心 | 评估 Prometheus、InfluxDB 或云厂商时序数据库 |
| 是否文档结构变化频繁 | 评估 MongoDB 等文档数据库 |

## 四、工程实践关注点

- 数据库不是只看功能，还要看备份恢复、观测、权限、变更流程和容量规划。
- 业务早期优先保持模型简单，避免过早引入分库分表和多种异构数据库。
- 生产环境必须明确 RPO / RTO、慢 SQL 治理、连接池上限、索引变更流程和数据回滚方案。
- 涉及跨库一致性时，优先从业务补偿、Outbox、Saga、幂等设计角度解决，谨慎依赖强一致分布式事务。
