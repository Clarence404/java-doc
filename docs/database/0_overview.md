# 数据库总览

数据库模块以 MySQL 为主线讲索引、事务与锁、InnoDB 与复制，再对比 PostgreSQL，覆盖国产与分布式关系库、ORM、各类 NoSQL，最后落到 CDC、备份、分库分表与连接池等工程实践。

**版本基线（2026 年 10 月）**：MySQL 8.4、PostgreSQL 18、MariaDB 12.3、Connector/J 9.x、HikariCP 7.x、ShardingSphere 5.5、Debezium 3.x

---

## 一、模块地图

缓存、系统级的分库分表策略、分布式事务和 Spring 数据访问在各自模块展开，这里只讲数据库本身。文中单独标出与 MySQL 9.7 LTS（之后改用 `YY.M` 日历版本号）及 8.0（2026 年 4 月停止维护）的差异，PostgreSQL 兼顾 17。

| 方向 | 内容 | 适合关注 |
|------|------|----------|
| **MySQL** | 基础、版本特性、MariaDB、避坑、索引、事务与锁、执行流程、EXPLAIN、InnoDB、主从与高可用 | Java 后端主力 OLTP 场景 |
| **PostgreSQL** | 基础、版本特性、MVCC、索引、高级 SQL、复制与高可用 | 复杂 SQL、JSONB、GIS、分析型查询 |
| **关系库生态** | Oracle、达梦、人大金仓、分布式数据库（TiDB / OceanBase）、ORM 框架 | 国产化迁移、水平扩展与持久层选型 |
| **NoSQL** | 列式与 OLAP、时序、文档、搜索、图数据库 | 多模型存储与特定场景优化 |
| **架构运维** | CDC、备份恢复、分库分表、连接池 | 数据可靠性、扩展性与应用接入 |
| **参考延伸** | Binlog Connector 源码、数据库选型、MySQL JDBC 驱动 | 原理阅读与技术方案决策 |

---

## 二、模块导航

<ModuleNav />

---

## 三、推荐阅读路径

1. [MySQL 基础](./1_mysql/0_overview)：范式、视图、存储过程、账号与传输安全，以及 MySQL 核心专项的导读
2. [MySQL 索引](./1_mysql/4_topic_index) 和 [MySQL 事务与锁](./1_mysql/5_topic_transaction)：补齐最高频的性能与并发问题，再按需读执行流程、EXPLAIN、InnoDB 与复制
3. [MySQL 版本特性](./1_mysql/1_feature) 与 [MySQL 避坑指南](./1_mysql/3_fallible_point)：确认生产版本的行为差异和常见雷区
4. [PostgreSQL 基础](./2_postgresql/0_overview)：对比 PostgreSQL 与 MySQL 在类型系统、MVCC、索引和高级 SQL 上的差异
5. 单机到瓶颈时读 [分布式数据库](./3_relational/1_distributed_db)（TiDB / OceanBase）；分析、时序、文档、搜索等场景从 [列式与 OLAP 数据库](./4_nosql/0_column_db) 开始按需选读
6. 工程落地读 [CDC 工具](./5_practice/0_cdc_tools)、[数据备份与恢复](./5_practice/1_backup_recovery)、[分库分表与中间件](./5_practice/2_sharding)、[数据库连接池](./5_practice/3_connection_pool) 和 [MySQL JDBC 驱动](./6_reference/2_jdbc_driver)
7. 做技术决策时看 [数据库选型参考](./6_reference/1_selection_guide)

[高频面试题](./99_interview) 只列题目，答案在 [数据库面试题解答](/interview/7_db)。

---

## 四、选型原则

| 问题 | 优先判断 |
|------|----------|
| 需要强事务与复杂关联查询 | MySQL / PostgreSQL 等关系型数据库 |
| 全文检索、多条件组合搜索 | Elasticsearch / OpenSearch，数据以关系库为准、异步同步 |
| 单机容量或写入到瓶颈 | 先读写分离与分库分表，再评估 TiDB、OceanBase；系统级扩展策略见 [数据层扩展](/high-con/5_data_scaling) |
| 以时间序列写入与聚合为核心 | InfluxDB 3、TDengine、TimescaleDB 等时序数据库；监控指标存储用 Prometheus |
| 大规模聚合分析 | ClickHouse、Apache Doris、StarRocks 等列式 OLAP |
| 文档结构变化频繁 | MongoDB 等文档数据库 |

工程上的几条底线：

- 业务早期保持模型简单，不要过早引入分库分表和多种异构数据库
- 上生产前明确 RPO / RTO、备份与恢复演练、慢 SQL 治理、连接池上限和索引变更流程
- 跨库一致性优先用本地事务 + Outbox、Saga、幂等来解决，详见 [分布式事务](/distributed/4_transaction)

---

## 五、关联模块

- [缓存总览](/cache/0_overview)：Redis / Caffeine 与数据库组合使用，缓存一致性在 [缓存一致性](/cache/10_cache_consistency) 展开
- [高并发总览](/high-con/0_overview)：读写分离、分库分表等系统级扩展策略
- [分布式总览](/distributed/0_overview)：跨库事务、分布式锁与分布式 ID
- [数据访问](/spring-boot/3_data_access)：Spring Boot 中的数据源、JPA、MyBatis-Plus 与多数据源配置
- [事务管理](/spring/4_transaction)：Spring 声明式事务、传播行为与失效场景
- [Flink CDC](/flink/6_cdc)：基于 binlog 的实时同步与入湖
- [数据访问性能](/high-perf/10_db_performance)：连接池、批量与 SQL 层面的性能优化方法
- [数据库面试题解答](/interview/7_db)：本模块高频问题的答案汇总

## 参考资料

- MySQL 8.4 参考手册：[https://dev.mysql.com/doc/refman/8.4/en/](https://dev.mysql.com/doc/refman/8.4/en/)
- MySQL 9.7 参考手册：[https://dev.mysql.com/doc/refman/9.7/en/](https://dev.mysql.com/doc/refman/9.7/en/)
- PostgreSQL 文档：[https://www.postgresql.org/docs/current/](https://www.postgresql.org/docs/current/)
- MariaDB 文档：[https://mariadb.com/docs/server](https://mariadb.com/docs/server)
