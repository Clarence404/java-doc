---
description: 全景选型矩阵、按场景选型、经典组合架构、评估维度、常见误区
---

# 数据库选型参考

> 前置阅读：[MySQL 基础](../1_mysql/0_overview)、[分布式数据库](../3_relational/1_distributed_db)

本篇是数据库选型速查表，按数据模型、查询模式、一致性、规模与团队能力为场景给出首选与备选，并列出常见选型误区。

---

## 一、全景选型矩阵

每类数据库这里只给定位与取舍，原理与深入对比在各自的主文档里；国产数据库、TiDB / OceanBase 的详细对比分别见 [其他 RDBMS](../3_relational/0_other_rdbms) 与 [分布式数据库](../3_relational/1_distributed_db)。

| 数据库 | 类型 | 核心优势 | 典型场景 | 不适合 |
|-------|------|---------|---------|-----------|
| **MySQL** | 关系型 | 成熟稳定、运维简单、生态完善 | 业务核心 OLTP | 大规模分析、全文搜索、图遍历 |
| **PostgreSQL** | 关系型 | SQL 能力强、JSONB、扩展丰富（PostGIS、pgvector） | 复杂查询、GIS、混合负载 | 每连接一个进程，大量短连接需前置 PgBouncer；频繁更新的大表需关注 VACUUM 与膨胀 |
| **TiDB** | 分布式关系型 | MySQL 协议兼容、水平扩展、TiFlash 列存 HTAP | 单库容量瓶颈、实时 HTAP | 小数据量、对单次延迟极敏感 |
| **OceanBase** | 分布式关系型 | Paxos 多副本、高压缩、多租户、MySQL / Oracle 兼容模式 | 金融核心、多租户 SaaS、Oracle 迁移 | 中小规模（资源与运维门槛高） |
| **MongoDB** | 文档 | 灵活 Schema、嵌套文档、原生分片 | 内容管理、用户画像、IoT 元数据 | 大量多文档事务、复杂多表关联 |
| **Redis** | 内存 KV | 极低延迟、丰富数据结构 | 缓存、会话、排行榜、限流 | 数据量远超内存、需要复杂查询 |
| **Elasticsearch / OpenSearch** | 搜索引擎 | 倒排索引全文检索、聚合、向量检索 | 商品搜索、日志检索 | 事务、频繁单行更新、作为主数据存储 |
| **ClickHouse** | 列式 OLAP | 单表聚合极快、高压缩比 | 日志与行为分析、实时报表 | 高频点查与单行更新、事务 |
| **Apache Doris / StarRocks** | MPP 分析 | MySQL 协议、多表 Join 强、实时更新模型、湖仓查询 | 实时数仓、BI 报表 | OLTP |
| **HBase** | 宽列 | 海量数据按 RowKey 随机读写 | 用户行为、消息存储 | 二级索引查询、复杂 SQL |
| **Cassandra** | 宽列 | 无主多活、多数据中心、写入吞吐高 | 全球分布的写密集业务 | 强一致、复杂查询 |
| **InfluxDB 3** | 时序 | 列式存储（Parquet）、SQL 与 InfluxQL 查询 | 监控指标、IoT 传感器 | 非时序数据 |
| **TimescaleDB** | 时序（PG 扩展） | 完整 SQL、超表自动分区、压缩 | 需要关联业务表的时序数据 | 超大规模纯指标场景 |
| **Neo4j** | 图 | 原生图存储、Cypher | 知识图谱、社交关系、反欺诈 | 非关系遍历型查询 |
| **Milvus** | 向量 | 十亿级向量 ANN 检索、多种索引 | 大规模 RAG、语义搜索、以图搜图 | 结构化查询 |

产品热度与趋势可参考 [DB-Engines Ranking](https://db-engines.com/en/ranking)。

---

## 二、按场景选型

### 1、OLTP

| 条件 | 首选 | 备注 |
|------|------|------|
| 单库可承受（千万级单表、几千 QPS） | MySQL；复杂查询多选 PostgreSQL | 先把索引、SQL、缓存做好 |
| 单库容量或写入成为瓶颈，愿意改造应用 | MySQL + ShardingSphere 分库分表 | 见 [分库分表与中间件](../5_practice/2_sharding) |
| 需要透明水平扩展与分布式事务 | TiDB / OceanBase | 见 [分布式数据库](../3_relational/1_distributed_db) |
| 信创或 Oracle 迁移 | 达梦、人大金仓、OceanBase Oracle 模式 | 见 [其他 RDBMS](../3_relational/0_other_rdbms) |

### 2、OLAP

| 条件 | 首选 | 备注 |
|------|------|------|
| 单大宽表聚合、日志与行为分析 | ClickHouse | 多表 Join 能力相对弱 |
| 实时数仓、多表 Join、需要主键更新 | Apache Doris / StarRocks | MySQL 协议，BI 工具直连 |
| 与 OLTP 同一份数据做实时分析 | TiDB + TiFlash | 免去同步链路 |
| 离线数仓、湖仓 | Spark / Flink + Iceberg / Paimon，查询层用 Trino、Doris、StarRocks | 存储在对象存储 |

列式与 OLAP 引擎的原理对比见 [列式与 OLAP 数据库](../4_nosql/0_column_db)。

### 3、全文搜索

| 条件 | 首选 |
|------|------|
| 商品、内容、日志检索 | Elasticsearch 9 / OpenSearch 3 |
| 已用 PostgreSQL、搜索需求简单 | PostgreSQL 内置全文检索（`tsvector` + GIN），中文需分词扩展 |
| 只需要关键词模糊匹配、数据量小 | 数据库前缀索引或 N-gram 全文索引 |

数据库到搜索引擎的同步方式见 [搜索数据库](../4_nosql/3_search_db) 与 [CDC 工具](../5_practice/0_cdc_tools)。

### 4、缓存与 KV

| 条件 | 首选 |
|------|------|
| 分布式缓存、会话、排行榜、分布式锁 | Redis（或兼容的 Valkey） |
| 进程内本地缓存 | Caffeine |
| 嵌入式持久化 KV | RocksDB |

缓存模式、一致性与两级缓存见 [缓存总览](/cache/0_overview)。

### 5、时序数据

| 条件 | 首选 | 备注 |
|------|------|------|
| Prometheus 指标长期存储 | VictoriaMetrics、Thanos、Mimir | 兼容 PromQL |
| IoT 设备数据、需要关联业务表 | TimescaleDB | 完整 SQL |
| 写入量极大的设备数据、国产化 | TDengine、Apache IoTDB | 面向物联网设计 |
| 通用时序库 | InfluxDB 3 | 查询语言为 SQL 与 InfluxQL，不再支持 Flux |
| 历史明细的大规模分析 | ClickHouse | 稀疏主键索引 + 跳数索引，`PARTITION BY toYYYYMM(ts)` 按月分区 |

时序数据库的数据模型与存储原理见 [时序数据库](../4_nosql/1_time_series_db)。

### 6、文档与半结构化

| 条件 | 首选 |
|------|------|
| Schema 多变、嵌套文档、需要原生分片 | MongoDB |
| 以关系模型为主、部分字段半结构化 | PostgreSQL JSONB + GIN 索引，或 MySQL JSON + 多值索引 |

MongoDB 自 4.0 起支持副本集多文档 ACID 事务、4.2 起支持分片集群事务，但多文档事务有时长与大小限制、开销明显，模型设计应尽量让一次业务操作落在单个文档内。详见 [文档数据库](../4_nosql/2_document_db)。

### 7、向量检索与 RAG

| 条件 | 首选 |
|------|------|
| 已有 PostgreSQL，向量在千万级以内 | pgvector（HNSW / IVFFlat 索引，过滤条件就是 SQL） |
| 已有 Elasticsearch / OpenSearch / Redis | 复用其向量检索能力 |
| MySQL 生态 | MariaDB 11.8 LTS（VECTOR 类型 + MHNSW 向量索引） |
| 专职向量场景、亿级以上、高 QPS | Milvus 或云厂商向量服务 |

MySQL 9.x 社区版只有 `VECTOR` 类型与 `STRING_TO_VECTOR`、`VECTOR_DIM` 等函数，距离计算函数 `DISTANCE()` 只在 HeatWave 等商业产品中提供，也没有向量索引，不适合做向量检索。向量数据库的原理见 [向量数据库](/ai/4_core_tech/1_vector_db)。选型原则：**先看手里有什么，能复用就不引入新组件**。

### 8、海量写入与随机点查

| 条件 | 首选 |
|------|------|
| 百亿行级、按 RowKey 点查、写多读少 | HBase |
| 多数据中心多活写入 | Cassandra |
| 希望保留 SQL 与二级索引 | TiDB、OceanBase |

---

## 三、经典组合架构

### 1、互联网通用组合

| 数据 | 存储 | 说明 |
|------|------|------|
| 业务核心数据 | MySQL（分库分表或 TiDB） | OLTP 主数据 |
| 热点数据 | Redis | 降低数据库读压力 |
| 搜索与日志 | Elasticsearch / OpenSearch | 通过 CDC 从主库同步 |

### 2、高并发电商

| 数据 | 存储 | 说明 |
|------|------|------|
| 商品、订单、用户 | MySQL + ShardingSphere | 按用户或订单分片 |
| 商品搜索 | Elasticsearch | CDC 同步商品库 |
| 库存热点扣减 | Redis Lua 原子扣减 + 数据库最终落账 | 见 [秒杀](/scenario/4_seckill) |
| 用户行为日志 | Kafka → ClickHouse / Doris | 实时分析 |
| 订单报表 | Doris / StarRocks | 多表 Join 报表 |

### 3、监控与可观测性

| 数据 | 存储 |
|------|------|
| 指标 | Prometheus + VictoriaMetrics / Mimir |
| 日志 | Elasticsearch / OpenSearch、Loki 或 ClickHouse |
| 链路 | Tempo、Jaeger、Elasticsearch |
| 可视化 | Grafana |

体系化设计见 [可观测性总览](/observability/0_overview)。

### 4、金融核心

| 数据 | 存储 | 说明 |
|------|------|------|
| 账务核心 | OceanBase / TiDB 或主备强同步的 MySQL | 多副本强一致、RPO 为 0 |
| 风控规则与配置 | MySQL / PostgreSQL | |
| 实时风控特征 | Redis、Flink 状态 | |
| 分析报表 | Doris / StarRocks / ClickHouse | |
| 审计日志 | Elasticsearch 或对象存储归档 | 按合规要求保留 |

---

## 四、选型评估维度

| 维度 | 评估要点 |
|------|---------|
| **数据模型** | 结构化 / 半结构化 / 时序 / 图 / KV / 向量 |
| **查询模式** | 点查、范围查询、聚合、全文检索、多表 Join、图遍历 |
| **一致性** | 强一致（账务）还是最终一致（互联网读多场景） |
| **数据规模** | 行数、行宽、总量与增长速度、冷热比例 |
| **访问量** | 读写 QPS、并发连接数、峰谷比 |
| **延迟** | P99 目标；内存级 1 ms 以内，磁盘型通常 1～100 ms |
| **运维能力** | 团队熟悉程度、是否有云托管、备份恢复与监控工具是否成熟 |
| **成本** | 许可证、云服务费用、存储与计算资源 |
| **生态** | 驱动与 ORM 支持、CDC 支持、与现有数据链路的集成 |

---

## 五、常见误区

| 误区 | 正确做法 |
|------|---------|
| 数据量大了一定要分库分表 | 先优化索引、SQL、缓存与历史数据归档；行宽适中、访问以索引点查为主时，MySQL 单表数千万行通常没有问题，是否拆分看实际瓶颈 |
| NoSQL 一定比 MySQL 快 | 取决于访问模式；Redis 快是因为数据在内存里 |
| 用了 ES 就不需要 MySQL | ES 是近实时的，没有事务，不适合作为业务主数据存储 |
| ClickHouse 能替代 MySQL | 定位不同，ClickHouse 不适合 OLTP 的点查与单行更新 |
| MongoDB 不支持事务 | 4.0 起支持多文档事务，问题在于代价与限制，而不是有没有 |
| 新项目都用 MongoDB | 灵活 Schema 是双刃剑，核心业务结构不清晰时会带来维护负担 |
| 做 RAG 就要上 Milvus | 千万级以内 pgvector、ES 向量检索就够了，专职向量库是规模到了之后的选项 |

---

## 小结

- 先按数据模型与查询模式定大类，再按规模、一致性、团队能力选具体产品
- OLTP 默认 MySQL / PostgreSQL；单库到瓶颈时在分库分表与分布式数据库之间权衡改造成本与运维成本
- OLAP 单表聚合选 ClickHouse，多表 Join 与实时数仓选 Doris / StarRocks；ClickHouse 用稀疏主键与跳数索引，不是 BRIN
- InfluxDB 3 使用 SQL 与 InfluxQL，Flux 只在 2.x 维护；时序选型还要考虑 TimescaleDB、TDengine、IoTDB 与 Prometheus 长期存储方案
- MySQL 社区版没有向量检索能力，MySQL 生态的向量方案看 MariaDB 11.8 LTS；pgvector 与已有搜索引擎优先复用
- 能复用现有组件就不引入新组件，任何新存储都要先确认备份、监控、CDC 与运维能力

## 参考资料

- DB-Engines Ranking：[https://db-engines.com/en/ranking](https://db-engines.com/en/ranking)
- MySQL 9.7 向量函数：[https://dev.mysql.com/doc/refman/9.7/en/vector-functions.html](https://dev.mysql.com/doc/refman/9.7/en/vector-functions.html)
- MariaDB Vector：[https://mariadb.com/docs/server/reference/sql-structure/vectors/vector-overview](https://mariadb.com/docs/server/reference/sql-structure/vectors/vector-overview)
- ClickHouse 稀疏主键索引：[https://clickhouse.com/docs/guides/best-practices/sparse-primary-indexes](https://clickhouse.com/docs/guides/best-practices/sparse-primary-indexes)
- ClickHouse 跳数索引：[https://clickhouse.com/docs/optimize/skipping-indexes](https://clickhouse.com/docs/optimize/skipping-indexes)
- InfluxDB 3 Core 查询数据：[https://docs.influxdata.com/influxdb3/core/query-data/](https://docs.influxdata.com/influxdb3/core/query-data/)
- MongoDB 事务：[https://www.mongodb.com/docs/manual/core/transactions/](https://www.mongodb.com/docs/manual/core/transactions/)

> 下一篇：[MySQL JDBC 驱动](./2_jdbc_driver) —— Connector/J 的版本、URL 关键参数、批量写入、大结果集读取与超时体系。
