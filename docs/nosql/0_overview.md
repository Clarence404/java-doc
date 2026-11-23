# NoSQL 数据库总览

NoSQL 模块按数据模型讲关系库之外的存储：键值、文档、宽列与列式、时序、搜索和图，每类讲清原理、主流产品与选型边界。

**版本基线（2026 年 10 月）**：MongoDB 8、Elasticsearch 9、OpenSearch 3、InfluxDB 3、Doris / StarRocks 4.1、Neo4j 2026.x（日历版本，5.26 为最后一个 5.x LTS）

---

## 一、数据模型速览

| 数据模型 | 典型产品 | 擅长 | 不擅长 | 详见 |
|------|------|------|------|------|
| 键值 / 嵌入式 | RocksDB、TiKV、etcd、SQLite、DuckDB | 按键读写、进程内存储 | 复杂查询 | [键值存储：RocksDB、TiKV 与 etcd](./1_kv_store) |
| 文档 | MongoDB | 结构多变的业务对象、按文档整体读写 | 跨文档关联与强事务 | [MongoDB 基础](./3_mongodb_basics) |
| 宽列 / 列式 OLAP | HBase、ClickHouse、Doris / StarRocks | 海量写入、大规模聚合分析 | 高频单行更新 | [ClickHouse](./6_clickhouse) |
| 时序 | InfluxDB、TimescaleDB、TDengine、IoTDB | 按时间写入、降采样与过期 | 任意维度的随机更新 | [时序数据库概览](./8_tsdb) |
| 搜索 | Elasticsearch、OpenSearch | 全文检索、相关性排序、多条件过滤 | 作为主库保存交易数据 | [搜索数据库](./13_search_db) |
| 图 | Neo4j、NebulaGraph | 多跳关系查询 | 大批量聚合扫描 | [图数据库概览](./11_graph_db) |

Redis 也是键值存储，但定位是缓存与内存数据结构，主文档在 [Redis 与缓存](/cache/0_overview) 模块。

---

## 二、模块导航

<ModuleNav />

---

## 三、推荐阅读路径

1. 先读 [存储引擎：B+ 树与 LSM-Tree](/database/0_fundamentals/1_storage_engine)，弄清 NoSQL 普遍写得快的原因
2. 侧边栏按类别分六组，每组先读第一篇（概览或基础），再按需读具体产品：
   - **键值与嵌入式**：[键值存储：RocksDB、TiKV 与 etcd](./1_kv_store)、[嵌入式数据库：SQLite、H2 与 DuckDB](./2_embedded_db)
   - **文档数据库**：[MongoDB 基础](./3_mongodb_basics) → [MongoDB 集群与事务](./4_mongodb_cluster)
   - **列式与 OLAP**：[HBase](./5_hbase)、[ClickHouse](./6_clickhouse)、[Doris 与 StarRocks](./7_doris_starrocks)，最后一篇有三者的选型对比
   - **时序数据库**：[时序数据库概览](./8_tsdb) → [InfluxDB](./9_influxdb)、[TimescaleDB](./10_timescaledb)
   - **图数据库**：[图数据库概览](./11_graph_db) → [Neo4j 与 NebulaGraph](./12_neo4j_nebula)
   - **搜索与 Elasticsearch**：[搜索数据库](./13_search_db) → [Elasticsearch 原理](./14_search_es) → [Elasticsearch 实战](./15_search_es_practice)
3. 做技术决策时看 [数据库选型参考](/database/0_fundamentals/2_selection_guide)，它同时覆盖关系库与 NoSQL

[高频面试题](./99_interview) 只列题目，答案在 [NoSQL 数据库面试题解答](/interview/13_nosql)。

---

## 四、关联模块

- [关系数据库总览](/database/0_overview)：存储引擎与选型、MySQL 与 PostgreSQL、应用接入、CDC 与运维
- [Redis 与缓存总览](/cache/0_overview)：Redis、Caffeine 与缓存一致性
- [向量数据库](/ai/4_core_tech/1_vector_db)：Embedding 检索与 RAG 场景的专用存储
- [对象存储](/architecture/5_object_storage)：图片、视频、备份等大文件的存储与直传
- [数据湖与湖仓](/big-data/4_lakehouse)：Iceberg、Paimon 等面向分析的开放表格式
- [CDC 工具](/database/4_practice/8_cdc_tools)：把关系库变更同步到搜索、分析与缓存
