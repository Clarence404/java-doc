# 数据库总览

数据库模块从存储引擎与选型讲起，以 MySQL 为主线讲表设计、索引、事务与锁、InnoDB 与复制，再对比 PostgreSQL 与其他关系库，然后是水平扩展（分库分表与分布式数据库）、Java 应用接入，最后落到备份恢复与变更订阅（CDC）。

**版本基线（2026 年 10 月）**：MySQL 8.4、PostgreSQL 18、MariaDB 12.3、Connector/J 26.x、HikariCP 7.x、ShardingSphere 5.5、Debezium 3.x

---

## 一、分组与阅读顺序

NoSQL（文档、列式、时序、搜索、图、键值）是独立的 [NoSQL](/nosql/0_overview) 模块；缓存、系统级的分库分表策略、分布式事务和 Spring 数据访问也在各自模块展开，这里只讲关系数据库与通用的存储原理。版本说明：文中单独标出与 MySQL 9.7 LTS（之后改用 `YY.M` 日历版本号）及 8.0（2026 年 4 月停止维护）的差异，PostgreSQL 兼顾 17；Connector/J 同样在 9.7 之后改用日历版本号，当前为 26.x。

按分组从上往下读，组内的顺序就是侧边栏的顺序：

| 分组 | 文章（按阅读顺序） | 解决什么问题 |
|------|-------------------|-------------|
| **基础与选型** | [存储引擎：B+ 树与 LSM-Tree](./0_fundamentals/1_storage_engine) → [数据库选型参考](./0_fundamentals/2_selection_guide) | 各类数据库为什么读写特性不同，怎么选 |
| **MySQL** | [MySQL 基础](./1_mysql/0_basics) → [MySQL 表设计规范](./1_mysql/1_table_design)；核心原理：[MySQL 索引](./1_mysql/2_topic_index) → [MySQL 事务与锁](./1_mysql/3_topic_transaction) → [MySQL 执行流程](./1_mysql/4_topic_execution) → [MySQL EXPLAIN 与 SQL 优化](./1_mysql/5_topic_explain) → [InnoDB 存储结构](./1_mysql/6_topic_innodb) → [MySQL 主从与高可用](./1_mysql/7_topic_replication)；最后是 [MySQL 避坑指南](./1_mysql/8_fallible_point) 与 [MySQL 版本特性](./1_mysql/9_feature) | Java 后端主力 OLTP 库：表怎么建、SQL 为什么快或慢、锁和复制怎么工作 |
| **PostgreSQL** | [PostgreSQL 基础](./2_postgresql/0_basics) → [PostgreSQL MVCC 与 VACUUM](./2_postgresql/1_topic_mvcc) → [PostgreSQL 索引类型](./2_postgresql/2_topic_index) → [PostgreSQL 高级 SQL](./2_postgresql/3_topic_advanced_sql) → [PostgreSQL 复制与高可用](./2_postgresql/4_topic_replication) → [PostgreSQL 版本特性](./2_postgresql/5_feature) | 和 MySQL 差在哪；复杂 SQL、JSONB、GIS 场景 |
| **其他关系库** | [MariaDB](./3_relational/0_maria_db) → [商业与国产库](./3_relational/1_other_rdbms) | 用 MySQL 的分支，或做国产化迁移 |
| **水平扩展** | [分库分表与中间件](./4_scale_out/0_sharding) → [分布式数据库](./4_scale_out/1_distributed_db) | 单库放不下时的两条路：继续用 MySQL 在应用侧拆，或换成自带分片的数据库 |
| **应用接入** | [JDBC 驱动](./5_access/1_jdbc_driver) → [数据库连接池](./5_access/2_connection_pool) → [ORM 框架](./5_access/3_orm_framework) | Java 应用从下往上怎么连数据库、怎么用好连接 |
| **备份与变更订阅** | [数据备份与恢复](./6_backup_cdc/0_backup_recovery) → [CDC 工具](./6_backup_cdc/1_cdc_tools) → [binlog 订阅原理](./6_backup_cdc/2_binlog_connector_source) | 误删能找回；变更能实时送到缓存、搜索、数仓 |

几条读法：

- **第一次读**：MySQL 组读到主从与高可用，再按需要跳到别的组；避坑指南和版本特性适合读完原理再看
- **按需阅读**：其他关系库、源码级的 binlog 订阅原理，用到再读；HDFS、Ceph 这类文件级存储不是数据库，放在系统架构模块的 [分布式文件系统](/architecture/5_storage_fs)
- **复习**：[高频面试题](./99_interview) 只列题目，答案在 [数据库面试题解答](/interview/12_db)，分组和上表一一对应

---

## 二、模块导航

<ModuleNav />

---

## 三、选型原则

先按数据模型与查询模式定大类（强事务 → 关系库，全文检索 → ES，大规模聚合 → 列式 OLAP，时间序列 → 时序库），再按规模、一致性和团队能力选具体产品；业务早期保持模型简单，不要过早引入分库分表和异构数据库。全景矩阵、按场景选型与工程底线见 [数据库选型参考](./0_fundamentals/2_selection_guide)。

---

## 四、关联模块

- [NoSQL 总览](/nosql/0_overview)：键值、文档、列式与 OLAP、时序、搜索与图数据库
- [对象存储](/architecture/5_object_storage)：图片、视频、备份等大文件的存储与直传
- [向量数据库](/ai/4_core_tech/1_vector_db)：Embedding 检索与 RAG 的专用存储
- [缓存总览](/cache/0_overview)：Redis / Caffeine 与数据库组合使用，缓存一致性在 [缓存一致性](/cache/10_cache_consistency) 展开
- [高并发总览](/high-con/0_overview)：读写分离、分库分表等系统级扩展策略
- [分布式基础总览](/distributed/0_overview)：跨库事务、分布式锁与分布式 ID
- [数据访问](/spring-boot/3_data_access)：Spring Boot 中的数据源、JPA、MyBatis-Plus 与多数据源配置
- [事务管理](/spring/4_transaction)：Spring 声明式事务、传播行为与失效场景
- [Flink CDC](/flink/6_cdc)：基于 binlog 的实时同步与入湖
- [数据访问性能](/high-perf/10_db_performance)：连接池、批量与 SQL 层面的性能优化方法
- [数据库面试题解答](/interview/12_db)：本模块高频问题的答案汇总

## 参考资料

- MySQL 8.4 参考手册：[https://dev.mysql.com/doc/refman/8.4/en/](https://dev.mysql.com/doc/refman/8.4/en/)
- MySQL 9.7 参考手册：[https://dev.mysql.com/doc/refman/9.7/en/](https://dev.mysql.com/doc/refman/9.7/en/)
- PostgreSQL 文档：[https://www.postgresql.org/docs/current/](https://www.postgresql.org/docs/current/)
- MariaDB 文档：[https://mariadb.com/docs/server](https://mariadb.com/docs/server)
