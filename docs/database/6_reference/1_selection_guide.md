# 数据库选型参考

参考：[DB-Engines Ranking](https://db-engines.com/)

## 一、全景选型矩阵

| 数据库 | 类型 | 核心优势 | 典型场景 | 不适合场景 |
|-------|------|---------|---------|-----------|
| **MySQL** | RDBMS | 成熟稳定、运维简单、生态完善 | 业务核心 OLTP | 海量写入、全文搜索、图数据 |
| **PostgreSQL** | RDBMS | 功能全面、JSONB、扩展丰富、SQL 标准 | 复杂查询、GIS、混合数据 | 超高并发写（不如 MySQL）|
| **TiDB** | NewSQL | MySQL 兼容、水平扩展、HTAP | MySQL 容量瓶颈、实时 HTAP | 延迟 < 1ms 场景 |
| **OceanBase** | NewSQL | 金融级、极致压缩、多租户、Oracle 兼容 | 金融核心、多租户 SaaS | 中小规模（运维成本高）|
| **MongoDB** | 文档 DB | Schema 自由、嵌套文档、原生分片 | 内容管理、用户画像、IoT | 复杂 JOIN、强一致事务 |
| **Redis** | KV 缓存 | 内存极速、丰富数据结构 | 缓存、会话、排行榜、限流 | 大数据量持久化 |
| **Elasticsearch** | 搜索引擎 | 全文搜索、聚合分析、近实时 | 搜索、日志分析、APM | 强一致事务、频繁更新 |
| **ClickHouse** | 列式 OLAP | 极致聚合性能、高压缩比 | 日志分析、BI 报表、数仓 | 高频点查、事务写入 |
| **HBase** | 列族 DB | 海量随机读写、水平扩展 | 用户行为、消息存储、时序 | 复杂 SQL、小数据量 |
| **InfluxDB** | 时序 DB | 原生时序优化、Flux 查询语言 | 监控指标、IoT 传感器 | 非时序场景 |
| **Cassandra** | 宽列 DB | 多主架构、高可用、写入极快 | 消息、时序、全球分布 | 强一致、复杂查询 |
| **Neo4j** | 图数据库 | 原生图存储、Cypher 查询 | 知识图谱、社交关系、推荐 | 非图关系场景 |

---

## 二、按场景快速选型

### OLTP（在线事务处理）

```
单机可承受（< 5000万行，< 5000 QPS）
  → MySQL（首选）/ PostgreSQL（复杂查询多）

需要水平扩展
  → TiDB（MySQL 兼容，改造成本低）
  → OceanBase（金融级，Oracle 迁移）

强一致 + 分布式事务
  → TiDB 悲观事务 / OceanBase Paxos 多副本
```

### OLAP（分析查询）

```
实时大数据聚合（秒级响应）
  → ClickHouse / Apache Doris

与 OLTP 同一份数据，实时分析
  → TiDB（TiFlash 列存）

传统离线数仓
  → Hive / Spark + 对象存储（S3/OSS）
```

### 全文搜索

```
商品搜索 / 内容搜索 / 日志检索
  → Elasticsearch / OpenSearch

PostgreSQL 场景内的简单全文搜索
  → PostgreSQL 内置全文搜索（省去 ES 运维）

大规模企业搜索平台
  → Elasticsearch（生态最完善）
```

### 缓存 / 高速 KV

```
会话、热点数据缓存、排行榜、分布式锁
  → Redis

本地高性能缓存（进程内）
  → Caffeine（Java）

持久化 KV（低延迟 + 持久化）
  → RocksDB / TiKV
```

### 时序数据

```
监控指标（Prometheus 协议兼容）
  → VictoriaMetrics（高性能，兼容 PromQL）/ InfluxDB

IoT 设备传感器数据
  → TimescaleDB（PG 扩展，SQL 友好）/ InfluxDB

历史时序查询（亿级）
  → ClickHouse（BRIN 索引 + 月度分区）
```

### 文档 / 半结构化

```
Schema 灵活 + 嵌套文档 + 原生分片
  → MongoDB

需要 SQL 能力 + JSONB 扩展
  → PostgreSQL（JSONB + GIN 索引）
```

### 海量写入 + 随机点查

```
百亿行级别，RowKey 点查，写多读少
  → HBase

消息存储、Feed 流、IoT 时序
  → HBase / Cassandra（多机房需求选 Cassandra）
```

---

## 三、经典组合架构

### 互联网标准三件套

```
业务核心数据   → MySQL（OLTP，分库分表 or TiDB）
热点数据缓存   → Redis（降低 DB 压力）
全文搜索/日志  → Elasticsearch（ELK）
```

### 高并发电商系统

```
商品 / 订单 / 用户    → MySQL + ShardingSphere
商品搜索             → Elasticsearch
库存热点扣减          → Redis（Lua 脚本原子操作）
用户画像 / 行为日志    → HBase / MongoDB
订单分析报表          → ClickHouse
消息队列             → Kafka（解耦 + 削峰）
```

### 实时监控告警

```
指标时序数据   → VictoriaMetrics / InfluxDB
日志数据        → Elasticsearch（ELK 栈）
告警规则存储    → MySQL
可视化大屏      → Grafana
```

### 金融核心系统

```
账务核心       → OceanBase / TiDB（金融级一致性）
风控规则       → MySQL / PostgreSQL
实时分析报表    → ClickHouse
审计日志       → Elasticsearch
```

---

## 四、选型评估维度

| 维度 | 评估要点 |
|------|---------|
| **数据模型** | 结构化 / 半结构化 / 时序 / 图 / KV |
| **查询模式** | 点查 / 范围查询 / 聚合 / 全文搜索 / JOIN |
| **一致性要求** | 强一致（金融）/ 最终一致（互联网）|
| **数据规模** | 行数、数据量大小、增长速度 |
| **访问量** | 读 QPS、写 QPS、并发连接数 |
| **延迟要求** | P99 RT（内存 < 1ms，磁盘 1~100ms）|
| **运维能力** | 团队熟悉程度、是否有云托管选项 |
| **成本** | License 费用、云服务费用、存储成本 |
| **生态** | ORM 支持、监控接入、备份工具 |

---

## 五、常见误区

| 误区 | 正确做法 |
|------|---------|
| "数据量大了一定要分库分表" | 先优化索引、缓存、SQL；单表 5000 万行内 MySQL 完全可承受 |
| "NoSQL 比 MySQL 快" | 取决于访问模式；Redis 快是因为内存，不是因为 NoSQL |
| "用了 ES 就不需要 MySQL" | ES 不保证强一致，不适合做业务主数据存储 |
| "ClickHouse 能替代 MySQL" | 定位完全不同；ClickHouse 不适合 OLTP |
| "新项目都用 MongoDB" | Schema 自由是双刃剑；业务核心数据结构不清晰时会带来维护噩梦 |
