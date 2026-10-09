---
description: ShardingSphere 5.5 接入形态、分片规则、读写分离、分片算法、主键、不停机迁移与扩容
---

# 分库分表与中间件

> **本篇目标**：掌握 ShardingSphere 5.5 的两种接入形态，能用 JDBC 驱动 + YAML 写出分库分表、绑定表、广播表、读写分离规则，选对内置分片算法与主键生成器；掌握不停机迁移五步、预分配逻辑分片与倍数扩容，做到业务不停完成数据搬迁。
>
> **前置阅读**：[数据层扩展](/high-con/5_data_scaling)（分片键、扩容、非分片键查询等系统级策略）

分库分表要不要做、分片键怎么选、跨分片分页与聚合怎么处理，这些系统级策略统一见 [数据层扩展](/high-con/5_data_scaling)；本篇讲中间件落地与平滑迁移、扩容的具体做法，以 Apache ShardingSphere 5.5.x 为基线。

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

---

## 八、平滑迁移与扩容

分库分表最难的不是第一次拆，而是**业务不停的情况下把数据搬到新的分片布局**：单库迁到分片库、4 个库扩到 8 个库，都属于这一类。本节是迁移与扩容机制的主文档，什么时候该扩、扩容在整体数据层演进中的位置见 [数据层扩展](/high-con/5_data_scaling)。

### 1、不停机迁移五步

![分库分表不停机迁移五步](../../assets/database/sharding-online-migration.svg)

| 步骤 | 做什么 | 以哪边为准 | 回滚方式 |
|------|--------|-----------|---------|
| ① 双写 | 新库开始接收增量写入：应用双写，或用 CDC 订阅旧库 binlog 写新库 | 旧库 | 关掉双写 / 停掉同步任务 |
| ② 历史数据迁移 | 按主键分批拷贝存量数据，迁移期间的变更由第 ① 步追平 | 旧库 | 清空新库重来 |
| ③ 校验对账 | 行数 + 分段 checksum + 抽样全字段比对，差异以旧库为准修复 | 旧库 | 不涉及流量，无需回滚 |
| ④ 灰度切读 | 按用户维度从 1% 逐步放量读新库，同时比对新旧结果 | 旧库 | 读开关切回旧库 |
| ⑤ 停旧写 | 秒级停写，确认增量追平后切写到新库，开启新 → 旧反向同步 | 新库 | 写开关切回旧库，反向同步保证旧库数据不缺 |

几个容易出错的细节：

- **双写优先用 CDC，而不是在业务代码里写两遍**：应用双写在「旧库成功、新库失败」时只能靠补偿，且两个库的写入顺序在并发下可能不同；订阅 binlog 天然按提交顺序回放，业务代码零改动。工具选型见 [CDC 工具](./0_cdc_tools)
- **先记位点再拷全量**：全量拷贝开始前记下 binlog 位点（GTID），增量从这个位点开始回放，拷贝期间发生的修改就不会丢；全量与增量重叠的行，按 `update_time` 或版本号「旧值不覆盖新值」处理
- **全量要限速**：`WHERE id > ? ORDER BY id LIMIT 1000` 游标分批，批间休眠，避免把旧库主从延迟拉高
- **停写窗口要短**：停写 → 等增量延迟归零 → 最后一轮校验 → 切开关，整个过程控制在秒级到分钟级，通常放在业务低峰并提前公告

分段 checksum 的写法：按主键区间分别在新旧两边执行，比对每一段的行数与异或校验值，不一致的段再逐行比对。

```sql
-- 旧库与新库的每张物理表各执行一次，主键区间相同
SELECT COUNT(*) AS cnt,
       BIT_XOR(CRC32(CONCAT_WS('#', order_id, user_id, amount, status,
                                IFNULL(remark, '<NULL>'), update_time))) AS crc
FROM t_order
WHERE order_id >= ? AND order_id < ?;
```

- `BIT_XOR` 满足交换律和结合律，所以新库各分片的结果**再异或一次**就能和旧库的单个结果直接比较，行数则直接相加
- `CONCAT_WS` 会跳过 `NULL`，可空列要先 `IFNULL` 成占位符，否则 `('a', NULL, 'b')` 与 `('a', 'b', NULL)` 会拼出同一个串

灰度切读的开关按用户哈希放量，同一个用户始终读同一边，避免一次刷新看到新数据、下一次又看到旧数据：

```java
@Component
public class ReadRouter {

    /** 0–100，来自配置中心，可动态调整 */
    private volatile int newDbReadPercent = 0;

    public boolean readFromNewDb(long userId) {
        return Math.floorMod(Long.hashCode(userId), 100) < newDbReadPercent;
    }

    public void setNewDbReadPercent(int percent) {
        this.newDbReadPercent = Math.clamp(percent, 0, 100);
    }
}
```

`Math.clamp` 是 JDK 21 新增的方法；配置中心的动态刷新见 [配置中心](/spring-cloud/4_config_center)。

### 2、用 ShardingSphere 迁移作业

ShardingSphere-Proxy 内置的迁移作业把上面的 ② ③ ⑤ 三步做成了一条命令链：全量复制 + binlog 增量同步 + 一致性校验 + 切换提交，适合把单库表迁移到分片表。以下 DistSQL 在 Proxy 上执行：

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

源库需要开启 binlog（ROW 格式）并授予迁移账号 `REPLICATION SLAVE`、`REPLICATION CLIENT` 权限。迁移作业不负责灰度切读和反向同步：切读开关仍要在应用侧实现，`COMMIT` 之后若要保留回滚能力，需要另配一条新 → 旧的 CDC 同步。不用 Proxy 的团队，可以用 Canal / Debezium / Flink CDC 自建同样的「全量 + 增量 + 校验」流水线，见 [CDC 工具](./0_cdc_tools)。

### 3、预分配逻辑分片：32 × 32

降低扩容成本的关键是**把「逻辑分片数」和「物理机器数」解耦**：一开始就按最终规模切好逻辑库表，物理实例按需增加，扩容时只搬整个逻辑库，路由公式永远不变。

以订单表为例，规划 32 个逻辑库 × 每库 32 张表：

| 项目 | 计算 | 结果 |
|------|------|------|
| 逻辑表总数 | 32 × 32 | 1024 张 |
| 总容量（单表按 1000 万行控制） | 1024 × 1000 万 | 约 102 亿行 |
| 单表体积（每行含索引按 1 KB 估） | 10⁷ × 1 KB = 10¹⁰ B | 约 9.3 GiB |
| 初期 4 台实例，每台承载 | 32 ÷ 4 = 8 个逻辑库，8 × 32 = 256 张表 | 写满时约 256 × 9.3 GiB ≈ 2.3 TiB |
| 扩到 32 台实例，每台承载 | 32 ÷ 32 = 1 个逻辑库，32 张表 | 写满时约 32 × 9.3 GiB ≈ 298 GiB |

初期数据远没有写满，4 台够用；数据增长后按 4 → 8 → 16 → 32 台扩，上限是 32 台（每台一个逻辑库），再往上才需要重新分片。

路由公式要让库和表**用哈希值的不同部分**：

```text
库下标 = h % 32
表下标 = (h / 32) % 32
```

如果库和表都用 `h % 32`，库下标和表下标永远相等：h = 37 时库 5、表 5，h = 69 时库 5、表 5，每个库里只有与库下标相同的那 1 张表有数据，其余 31 张是空的。改用 `(h / 32) % 32` 后，h = 37 落到库 5、表 1，h = 69 落到库 5、表 2，数据才会均匀铺满 1024 张表。

对应的 ShardingSphere 规则：32 个数据源 `ds_0` … `ds_31` 各指向一个逻辑库（schema），初期每 8 个指向同一台实例：

```yaml
dataSources:
  ds_0:
    dataSourceClassName: com.zaxxer.hikari.HikariDataSource
    driverClassName: com.mysql.cj.jdbc.Driver
    jdbcUrl: jdbc:mysql://db-a:3306/orders_00?connectionTimeZone=Asia/Shanghai
    username: app
    password: xxx
  # ds_1 … ds_7 → db-a 上的 orders_01 … orders_07
  # ds_8 … ds_15 → db-b 上的 orders_08 … orders_15，以此类推

rules:
- !SHARDING
  tables:
    t_order:
      actualDataNodes: ds_${0..31}.t_order_${0..31}
      databaseStrategy:
        standard:
          shardingColumn: user_id
          shardingAlgorithmName: db_mod32
      tableStrategy:
        standard:
          shardingColumn: user_id
          shardingAlgorithmName: table_div32_mod32
  shardingAlgorithms:
    db_mod32:
      type: INLINE
      props:
        algorithm-expression: ds_${user_id % 32}
    table_div32_mod32:
      type: INLINE
      props:
        algorithm-expression: t_order_${user_id.intdiv(32) % 32}
```

- 行表达式是 Groovy，整数相除要用 `intdiv`：Groovy 里 `user_id / 32` 的结果是 `BigDecimal`，拼出来的表名会带小数
- 这里假设 `user_id` 本身分布均匀（如号段发号）；如果是雪花 ID，低位规律性强，应先哈希再取模，用 `CLASS_BASED` 自定义算法实现
- 数据源连接池按实例累计计算：同一台实例上 8 个数据源各配 10 个连接，就是 80 个连接，要留意实例的 `max_connections`

扩容 4 → 8 台时，每台旧实例把 8 个逻辑库中的 4 个搬到新实例：新实例先作为从库复制这 4 个库（MySQL 复制过滤 `replicate-do-db`，或复制整个实例后删掉多余的库），追平后对这 4 个库短暂停写，把 `ds_x` 的 `jdbcUrl` 改指新实例，最后在两边删掉不再属于自己的库。**分片规则一行不改，只改数据源地址。**

### 4、倍数扩容只迁一半

没有预分配、直接用 `h % N` 路由时，扩容也要按倍数扩（N → 2N），原因在于数据移动量：

- `h % N = i` 的数据，在 `h % 2N` 下只会落到 `i` 或 `i + N` 两个分片之一。例如 N = 4：h = 9 时 9 % 4 = 1、9 % 8 = 1，原地不动；h = 5 时 5 % 4 = 1、5 % 8 = 5，搬到新分片 5
- 每个旧分片恰好**留一半、迁一半**，迁出的数据只去一个确定的新分片
- 对比 4 → 5 的非倍数扩容：只有 `h % 4 = h % 5` 的数据不动，这等价于 `h mod 20 ∈ {0, 1, 2, 3}`，即 4 / 20 = 20%，**80% 的数据都要搬**

![倍数扩容：2 分片扩到 4 分片](../../assets/database/sharding-double-expand.svg)

倍数扩容还能借助主从复制省掉逐行迁移：新分片 `i + N` 先作为旧分片 `i` 的从库全量复制，追平后切换路由规则，此时两边都持有旧分片 `i` 的全部数据，各自异步删掉不属于自己的那一半即可（删除要分批，避免大事务和主从延迟）。

### 5、一致性哈希与槽映射的取舍

| 路由方式 | 扩容时的数据移动 | 迁移粒度 | 适合 |
|---------|----------------|---------|------|
| 取模 + 倍数扩容 | 每个旧分片迁一半 | 行（可借主从复制变成整库） | 分片数少、扩容不频繁 |
| 预分配逻辑分片（固定槽） | 只搬整个逻辑库 / 逻辑表 | 整库 / 整表 | **数据库分片的首选** |
| 一致性哈希 | 新节点只接管相邻区间，约 1 / (N + 1) | 行，且要按哈希区间筛选 | 缓存、无状态路由 |
| 映射表（key → 分片） | 按需单独搬某个 key | 单个 key | 大租户独占、热点隔离 |

一致性哈希在缓存场景好用，是因为缓存丢了可以回源；数据库不能丢数据，按哈希区间从一张表里挑出部分行搬走，需要逐行扫描、过滤、校验，比搬整张表麻烦得多。而且没有虚拟节点时分布不均，有了虚拟节点后一个物理节点的数据散落在环上很多段，迁移更碎。固定槽（逻辑分片）本质上就是「把哈希环切成固定的 1024 段，每段一张表」，扩容只改「段 → 机器」的映射，兼顾了均匀和整块迁移，Redis Cluster 的 16384 个槽也是同一思路。哈希环与虚拟节点的原理见 [一致性哈希](/distributed/9_consistent_hashing)。

### 6、扩容后的 ID 与路由变化

| 关注点 | 问题 | 做法 |
|--------|------|------|
| 路由规则生效 | 滚动发布期间，新旧实例按不同规则路由，同一条数据可能被写到两个分片 | 规则切换放在停写窗口内；集群模式下由注册中心统一下发规则，所有实例同时生效 |
| 基因法 ID | 订单号里嵌入了 `user_id` 的低位作为路由基因，物理分片翻倍后基因位数不够 | 基因位数按**逻辑分片数**留（1024 个逻辑表留 10 位，2¹⁰ = 1024），物理扩容不影响已发出的 ID |
| 数据库自增主键 | 用 `auto_increment_increment = N` 错开步长的方案，N 变成 2N 后步长全乱 | 分片表一律用雪花或号段等全局发号，见 [分布式 ID 生成](/distributed/8_id_generator) |
| 异构索引与缓存 | 映射表、ES 文档或缓存里如果存了物理位置（库名、表名），扩容后全部失效 | 只存业务键，物理位置由路由规则实时计算 |
| 跨分片唯一约束 | 唯一索引只在单表内生效，迁移期间新旧库各有一份数据 | 唯一性靠全局发号或独立的唯一键表保证，不依赖物理唯一索引 |

**扩容方案在第一次拆分时就决定了**：逻辑分片数、路由公式、ID 基因位数一旦上线就很难改，宁可一次规划到 3~5 年后的规模。

---

## 九、选型建议

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
- 不停机迁移五步：双写（优先 CDC）→ 历史数据迁移 → 校验对账 → 灰度切读 → 停旧写，前四步以旧库为准、随时可回退，切写后用反向同步保留回滚能力
- ShardingSphere 迁移作业只在 Proxy 上可用：注册源存储单元 → `MIGRATE TABLE` → 查看状态 → `CHECK MIGRATION` → `COMMIT MIGRATION`
- 扩容首选预分配逻辑分片（如 32 库 × 32 表），扩容只搬整个逻辑库、只改数据源地址；直接取模时按倍数扩，每个旧分片只迁一半
- 逻辑分片数、路由公式、ID 基因位数在第一次拆分时就决定了扩容难度，基因位按逻辑分片数留

## 参考资料

- ShardingSphere-JDBC YAML 配置：[https://shardingsphere.apache.org/document/current/cn/user-manual/shardingsphere-jdbc/yaml-config/](https://shardingsphere.apache.org/document/current/cn/user-manual/shardingsphere-jdbc/yaml-config/)
- Spring Boot 中使用 JDBC 驱动：[https://shardingsphere.apache.org/document/current/cn/user-manual/shardingsphere-jdbc/yaml-config/jdbc-driver/spring-boot/](https://shardingsphere.apache.org/document/current/cn/user-manual/shardingsphere-jdbc/yaml-config/jdbc-driver/spring-boot/)
- 内置分片算法：[https://shardingsphere.apache.org/document/current/cn/user-manual/common-config/builtin-algorithm/sharding/](https://shardingsphere.apache.org/document/current/cn/user-manual/common-config/builtin-algorithm/sharding/)
- 数据迁移：[https://shardingsphere.apache.org/document/current/cn/user-manual/shardingsphere-proxy/migration/usage/](https://shardingsphere.apache.org/document/current/cn/user-manual/shardingsphere-proxy/migration/usage/)
- 分布式事务：[https://shardingsphere.apache.org/document/current/cn/user-manual/shardingsphere-jdbc/yaml-config/rules/transaction/](https://shardingsphere.apache.org/document/current/cn/user-manual/shardingsphere-jdbc/yaml-config/rules/transaction/)
- MySQL 复制过滤（replicate-do-db）：[https://dev.mysql.com/doc/refman/8.4/en/replication-options-replica.html](https://dev.mysql.com/doc/refman/8.4/en/replication-options-replica.html)
- 选题参考：doocs/advanced-java：[https://github.com/doocs/advanced-java](https://github.com/doocs/advanced-java)

> 下一篇：[数据库连接池](./3_connection_pool) —— HikariCP 与 Druid 的参数、池大小估算、泄漏排查，以及 PostgreSQL 前置的 PgBouncer。
