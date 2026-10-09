---
description: ShardingSphere 5.5 接入形态、YAML 分片规则、读写分离、分片算法、主键、数据迁移
---

# 分库分表与中间件

> **本篇目标**：掌握 ShardingSphere 5.5 的两种接入形态，能用 JDBC 驱动 + YAML 写出分库分表、绑定表、广播表、读写分离规则，选对内置分片算法与主键生成器，并用 DistSQL 完成数据迁移。
>
> **前置阅读**：[数据层扩展](/high-con/5_data_scaling)（分片键、扩容、非分片键查询等系统级策略）

分库分表要不要做、分片键怎么选、跨分片分页与聚合怎么处理、如何平滑扩容，这些系统级策略统一见 [数据层扩展](/high-con/5_data_scaling)；本篇只讲中间件落地，以 Apache ShardingSphere 5.5.x 为基线。

---

## 一、ShardingSphere 概述

Apache ShardingSphere 是开源的分布式数据库增强生态，在不改变底层数据库的前提下提供：

- **数据分片**：分库分表，突破单库容量与性能瓶颈
- **读写分离**：写主库、读副本，按负载均衡算法分发读请求
- **数据加密**：字段级透明加解密
- **影子库**：按列值或 Hint 把压测流量路由到影子库
- **数据迁移**：Proxy 内置的全量 + 增量迁移与一致性校验

5.0 起原 Sharding-JDBC 更名为 **ShardingSphere-JDBC**；5.3.0 起移除了 Spring Boot / Spring Namespace starter，统一改为 **JDBC 驱动 + YAML 文件**的接入方式，网上大量 `spring.shardingsphere.*` 配置已不适用于 5.3 之后的版本。

---

## 二、两种接入形态

![ShardingSphere-JDBC 与 ShardingSphere-Proxy 部署形态](../../assets/database/shardingsphere-jdbc-proxy.svg)

| 特性 | ShardingSphere-JDBC | ShardingSphere-Proxy |
|------|------------|-------------------|
| 接入方式 | 应用内 jar，作为 JDBC 驱动 | 独立部署的数据库代理进程 |
| 协议 | Java JDBC | MySQL / PostgreSQL 协议 |
| 性能损耗 | 低，无额外网络跳转 | 多一跳网络 |
| 语言限制 | 仅 Java | 任意语言 |
| 运维复杂度 | 低，随应用部署 | 中，需独立运维与高可用 |
| DBA 管控 | 规则分散在各应用 | 统一入口，支持 DistSQL |
| 数据迁移 | 不支持 | 支持 |
| 适用场景 | Java 微服务 | 多语言团队、统一管控、运维操作 |

常见组合是应用走 JDBC，DBA 和运维工具走 Proxy，两者共享同一套治理中心（集群模式下的注册中心）里的规则。

---

## 三、ShardingSphere-JDBC 分库分表配置

### 1、引入驱动

```xml
<dependency>
  <groupId>org.apache.shardingsphere</groupId>
  <artifactId>shardingsphere-jdbc</artifactId>
  <version>5.5.3</version>
</dependency>
```

Spring Boot 中把 ShardingSphere 当作普通 JDBC 驱动，规则放在独立的 YAML 文件里：

```yaml
# application.yml
spring:
  datasource:
    driver-class-name: org.apache.shardingsphere.driver.ShardingSphereDriver
    url: jdbc:shardingsphere:classpath:sharding.yaml
```

### 2、分库分表规则

场景：2 库 × 4 表，`user_id` 分库、`order_id` 分表，物理表为 `ds_0.t_order_0` 到 `ds_1.t_order_3`。

```yaml
# src/main/resources/sharding.yaml
mode:
  type: Standalone

dataSources:
  ds_0:
    dataSourceClassName: com.zaxxer.hikari.HikariDataSource
    driverClassName: com.mysql.cj.jdbc.Driver
    jdbcUrl: jdbc:mysql://db0:3306/orders?connectionTimeZone=Asia/Shanghai
    username: app
    password: xxx
  ds_1:
    dataSourceClassName: com.zaxxer.hikari.HikariDataSource
    driverClassName: com.mysql.cj.jdbc.Driver
    jdbcUrl: jdbc:mysql://db1:3306/orders?connectionTimeZone=Asia/Shanghai
    username: app
    password: xxx

rules:
- !SHARDING
  tables:
    t_order:
      actualDataNodes: ds_${0..1}.t_order_${0..3}
      databaseStrategy:
        standard:
          shardingColumn: user_id
          shardingAlgorithmName: db_inline
      tableStrategy:
        standard:
          shardingColumn: order_id
          shardingAlgorithmName: t_order_inline
      keyGenerateStrategy:
        column: order_id
        keyGeneratorName: snowflake
    t_order_item:
      actualDataNodes: ds_${0..1}.t_order_item_${0..3}
      databaseStrategy:
        standard:
          shardingColumn: user_id
          shardingAlgorithmName: db_inline
      tableStrategy:
        standard:
          shardingColumn: order_id
          shardingAlgorithmName: t_order_item_inline
  bindingTables:
    - t_order,t_order_item
  shardingAlgorithms:
    db_inline:
      type: INLINE
      props:
        algorithm-expression: ds_${user_id % 2}
    t_order_inline:
      type: HASH_MOD
      props:
        sharding-count: 4
    t_order_item_inline:
      type: HASH_MOD
      props:
        sharding-count: 4
  keyGenerators:
    snowflake:
      type: SNOWFLAKE

- !BROADCAST
  tables:
    - t_dict_status
    - t_dict_category

props:
  sql-show: true
```

要点：

- **绑定表**：`t_order` 与 `t_order_item` 的分片规则完全一致，关联查询才能在同一分片内 JOIN，不产生笛卡尔积路由；因此 `t_order_item` 必须冗余 `user_id` 列
- **广播表**：5.4.0 起是独立的 `!BROADCAST` 规则，字典表在每个库都有一份完整数据，写入时同时写所有库，可与任意分片表 JOIN
- **分表用 `HASH_MOD` 而不是 `order_id % 4`**：低并发时雪花 ID 的序列号部分常常为 0，ID 多为偶数，按 `% 4` 取模会集中落到 0 号、2 号表。也可以给 SNOWFLAKE 配置 `max-vibration-offset` 让序列起点抖动
- **`sql-show`**：打印逻辑 SQL 与路由后的真实 SQL，仅开发调试时打开

---

## 四、读写分离配置

5.4.0 起读写分离规则改为 `dataSourceGroups` 结构，不再有 `static-strategy`。分库与读写分离可以组合：分片规则的 `actualDataNodes` 引用读写分离的逻辑数据源名即可。

```yaml
rules:
- !READWRITE_SPLITTING
  dataSourceGroups:
    rw_ds:
      writeDataSourceName: primary_ds
      readDataSourceNames:
        - replica_ds_0
        - replica_ds_1
      transactionalReadQueryStrategy: PRIMARY
      loadBalancerName: round_robin
  loadBalancers:
    round_robin:
      type: ROUND_ROBIN
```

`transactionalReadQueryStrategy` 控制事务内的读：默认 `PRIMARY` 全部走主库；`FIXED` / `DYNAMIC` 允许走副本，只适合主从强同步的数据库。负载均衡内置 `ROUND_ROBIN`、`RANDOM`、`WEIGHT`。

写完立即读的场景（如下单后跳转订单详情），用 Hint 强制走主库：

```java
try (HintManager hintManager = HintManager.getInstance()) {
    hintManager.setWriteRouteOnly();
    return orderMapper.selectById(orderId);
}
```

复制延迟的系统级处理方式见 [数据层扩展](/high-con/5_data_scaling)。只需要读写分离、不需要分片时，也可以用 Spring 的 `AbstractRoutingDataSource` 自行路由，见 [数据库连接池](./3_connection_pool) 的多数据源一节。

---

## 五、内置分片算法

| 类别 | type | 关键属性 | 说明 |
|------|------|---------|------|
| 行表达式 | `INLINE` | `algorithm-expression` | Groovy 表达式，只支持 `=` / `IN` 路由 |
| 取模 | `MOD` | `sharding-count` | 分片键为整数时直接取模 |
| 哈希取模 | `HASH_MOD` | `sharding-count` | 先取哈希再取模，可用于字符串或分布不均的整数 |
| 容量范围 | `VOLUME_RANGE` | `range-lower` / `range-upper` / `sharding-volume` | 按固定容量切分 |
| 边界范围 | `BOUNDARY_RANGE` | `sharding-ranges` | 按自定义边界切分 |
| 自动时间段 | `AUTO_INTERVAL` | `datetime-lower` / `datetime-upper` / `sharding-seconds` | 按固定秒数切分时间 |
| 时间范围 | `INTERVAL` | `datetime-pattern` / `datetime-lower` / `sharding-suffix-pattern` / `datetime-interval-unit` | 按月、按天分表 |
| 复合行表达式 | `COMPLEX_INLINE` | `sharding-columns` / `algorithm-expression` | 多列联合分片 |
| Hint 行表达式 | `HINT_INLINE` | `algorithm-expression` | 不依赖 SQL 中的分片列，由 `HintManager` 指定 |
| 自定义类 | `CLASS_BASED` | `strategy` / `algorithmClassName` | 实现 Standard / Complex / Hint 算法接口 |

`MOD`、`HASH_MOD`、`VOLUME_RANGE`、`BOUNDARY_RANGE`、`AUTO_INTERVAL` 属于自动分片算法，可配合 `autoTables` 让 ShardingSphere 自动计算物理表分布。

---

## 六、分布式主键

| 生成器 | type | 特点 | 适用 |
|------|------|------|------|
| 雪花算法 | `SNOWFLAKE` | 64 位，时间戳 + 工作节点 + 序列，趋势递增 | 大多数场景 |
| UUID | `UUID` | 128 位字符串，无序 | 不要求有序、不作主键索引时 |
| 自定义 | 实现 `KeyGenerateAlgorithm` SPI | 对接业务发号器 | 已有 Leaf、号段服务等 |

主键生成器需要在 `keyGenerators` 中显式声明并在表的 `keyGenerateStrategy` 中引用；也可以在应用侧生成主键后直接写入，ShardingSphere 只负责路由。

![Snowflake ID 64 位结构](../../assets/database/snowflake-id.svg)

雪花算法的时钟回拨、工作节点分配与其他发号方案对比见 [分布式 ID 生成](/distributed/8_id_generator)。

---

## 七、ShardingSphere 中的跨分片问题

### 1、跨分片查询的执行方式

ShardingSphere 把逻辑 SQL 改写为每个分片上的真实 SQL 并发执行，再做结果归并：

- **排序分页**：`ORDER BY ... LIMIT 100, 10` 会被改写为每个分片 `LIMIT 0, 110`，在内存中归并后取第 101~110 条，偏移越大、分片越多越慢；深分页应改为游标分页（`WHERE id > ? ORDER BY id LIMIT 10`）
- **聚合**：`COUNT` / `SUM` 分片各自计算后累加，`AVG` 改写为 `SUM` 与 `COUNT` 后再除
- **不带分片键的查询**：全路由到所有分片，应通过冗余表、映射表或搜索引擎避免

### 2、分布式事务

ShardingSphere 支持 LOCAL（默认）、XA（Atomikos / Narayana）与 BASE（Seata AT）三种事务类型，通过 transaction 规则的 `defaultType` 与 `providerType` 配置，业务代码只写普通的 `@Transactional`。5.x 已移除旧的 `@ShardingTransactionType` 注解。

注意它只协调**同一个 ShardingSphere 实例内**的数据源；跨服务的事务（订单服务调库存服务）属于 Seata 等分布式事务框架的范畴，原理与选型见 [分布式事务](/distributed/4_transaction)。

### 3、数据迁移

ShardingSphere-Proxy 内置迁移作业，基于全量复制 + binlog 增量同步，把单库表迁移到分片表。以下 DistSQL 在 Proxy 上执行：

```sql
-- 1. 注册源端存储单元（迁移源库）
REGISTER MIGRATION SOURCE STORAGE UNIT ds_src (
    URL="jdbc:mysql://old-db:3306/orders",
    USER="migrator",
    PASSWORD="xxx",
    PROPERTIES("minPoolSize"="1","maxPoolSize"="20","idleTimeout"="60000")
);

-- 2. 在已配置好分片规则的逻辑库 sharding_db 中创建迁移作业
MIGRATE TABLE ds_src.t_order INTO sharding_db.t_order;

-- 3. 查看作业列表，拿到 jobId
SHOW MIGRATION LIST;

-- 4. 查看进度
SHOW MIGRATION STATUS 'jobId';

-- 5. 数据一致性校验
CHECK MIGRATION 'jobId' BY TYPE (NAME='DATA_MATCH');
SHOW MIGRATION CHECK STATUS 'jobId';

-- 6. 业务停写后切流，提交作业
COMMIT MIGRATION 'jobId';
```

源库需要开启 binlog（ROW 格式）并授予迁移账号 `REPLICATION SLAVE`、`REPLICATION CLIENT` 权限。平滑扩容的整体步骤（双写、校验、切读、切写、回滚预案）见 [数据层扩展](/high-con/5_data_scaling)。

---

## 八、选型建议

| 场景 | 推荐方案 |
|------|---------|
| Java 应用，分片规则稳定 | ShardingSphere-JDBC |
| 多语言团队、DBA 统一管控、需要迁移工具 | ShardingSphere-Proxy（常与 JDBC 混合部署） |
| 单表数据量在千万级、单库能承受 | 先优化索引、归档历史数据、加缓存，暂不分库分表 |
| 需要强一致事务 + 透明水平扩展 | 分布式数据库，见 [分布式数据库](../3_relational/1_distributed_db) |
| 只需要读写分离 | ShardingSphere 读写分离规则，或 `AbstractRoutingDataSource` |

---

## 小结

- ShardingSphere 5.3.0 起没有 Spring Boot starter，5.5.x 用 `ShardingSphereDriver` + `jdbc:shardingsphere:classpath:xxx.yaml` 接入
- 规则写在 YAML 的 `rules:` 下：`!SHARDING`、`!BROADCAST`（5.4.0 起独立）、`!READWRITE_SPLITTING`（`dataSourceGroups` 结构）
- 内置算法是 INLINE、MOD、HASH_MOD、VOLUME_RANGE、BOUNDARY_RANGE、AUTO_INTERVAL、INTERVAL、COMPLEX_INLINE、HINT_INLINE、CLASS_BASED；雪花 ID 直接取模容易数据倾斜
- 绑定表要求分片规则完全一致；广播表适合小字典表
- 分布式事务由 transaction 规则配置，只覆盖同一实例内的数据源；跨服务事务交给 Seata
- 数据迁移只在 Proxy 上可用：注册源存储单元 → `MIGRATE TABLE` → 查看状态 → `CHECK MIGRATION` → `COMMIT MIGRATION`

## 参考资料

- ShardingSphere-JDBC YAML 配置：[https://shardingsphere.apache.org/document/current/cn/user-manual/shardingsphere-jdbc/yaml-config/](https://shardingsphere.apache.org/document/current/cn/user-manual/shardingsphere-jdbc/yaml-config/)
- Spring Boot 中使用 JDBC 驱动：[https://shardingsphere.apache.org/document/current/cn/user-manual/shardingsphere-jdbc/yaml-config/jdbc-driver/spring-boot/](https://shardingsphere.apache.org/document/current/cn/user-manual/shardingsphere-jdbc/yaml-config/jdbc-driver/spring-boot/)
- 内置分片算法：[https://shardingsphere.apache.org/document/current/cn/user-manual/common-config/builtin-algorithm/sharding/](https://shardingsphere.apache.org/document/current/cn/user-manual/common-config/builtin-algorithm/sharding/)
- 数据迁移：[https://shardingsphere.apache.org/document/current/cn/user-manual/shardingsphere-proxy/migration/usage/](https://shardingsphere.apache.org/document/current/cn/user-manual/shardingsphere-proxy/migration/usage/)
- 分布式事务：[https://shardingsphere.apache.org/document/current/cn/user-manual/shardingsphere-jdbc/yaml-config/rules/transaction/](https://shardingsphere.apache.org/document/current/cn/user-manual/shardingsphere-jdbc/yaml-config/rules/transaction/)

> 下一篇：[数据库连接池](./3_connection_pool) —— HikariCP 与 Druid 的参数、池大小估算、泄漏排查，以及 PostgreSQL 前置的 PgBouncer。
