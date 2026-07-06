# 数据库选型参考

> [!warning] 待补充
> 当前仅作为数据库选型资料入口，后续可补充不同数据库在业务场景中的选型方法。

## 参考资料

- [DB-Engines Ranking](https://db-engines.com/)

## 大纲

- 关系型数据库：MySQL、PostgreSQL、Oracle、SQL Server
- 搜索引擎：Elasticsearch、OpenSearch
- 文档数据库：MongoDB
- 时序数据库：InfluxDB、TimescaleDB
- 列式数据库：ClickHouse、Doris
- 分布式数据库：TiDB、OceanBase、CockroachDB

## 选型维度

- 数据模型：关系型、文档型、时序、列式、键值
- 查询模式：OLTP、OLAP、全文检索、聚合分析
- 一致性要求：强一致、最终一致、读写分离
- 运维成本：部署复杂度、备份恢复、扩缩容、监控
- 生态兼容：SQL 支持、驱动、ORM、云服务托管
