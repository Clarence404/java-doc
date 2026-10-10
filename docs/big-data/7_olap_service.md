---
description: OLAP 引擎选型、JdbcClient 查询 API、物化视图与预聚合、报表缓存、重查询限流、异步导出、多租户、指标层
---

# OLAP 查询与数据服务

> 前置阅读：[数仓分层与建模](./2_data_warehouse)、[任务调度](./6_scheduling)、[列式与 OLAP 数据库](/database/4_nosql/0_column_db)

数据服务层负责把数仓结果表安全、稳定地提供给后台、看板和导出等消费方。本篇讲 OLAP 选型、查询 API、物化视图与缓存、限流与异步导出、多租户，基线为 Spring Boot 4。

---

## 一、数据服务要解决什么

查询 API 使用 `JdbcClient`，此外还涉及预聚合和指标层。基线为 JDK 21 + Spring Boot 4.x，OLAP 侧以 StarRocks 4.1 / Apache Doris 4.1 为例。

数仓链路产出 `ads_trade_gmv_1d` 之后，工作只完成了一半：商家后台要按渠道、省份看最近 30 天的 GMV，运营看板每分钟刷新一次，大促期间并发查询翻十倍，还有人要导出半年的订单明细。这些请求如果直接用 BI 工具或业务代码裸连 OLAP 库，很快会遇到慢查询拖垮集群、租户之间数据串看、同一个"GMV"三个系统三个数的问题。示例延续电商订单场景，查询服务名为 `report-service`。

### 1、访问模式

| 访问模式 | 典型请求 | 延迟要求 | 并发 | 关键手段 |
|----------|----------|----------|------|----------|
| 固定报表 / 看板 | 最近 30 天每日 GMV、渠道占比 | 百毫秒级 | 高，且重复度高 | ADS 汇总表、物化视图、结果缓存 |
| 交互式分析 | 运营自由选维度下钻、筛选 | 秒级 | 中 | OLAP 实时聚合、资源隔离 |
| 明细查询 | 某商家某天的订单明细分页 | 百毫秒到秒级 | 中 | 排序键 / 前缀索引、分页上限 |
| 开放 API / 数据产品 | 给商家后台、合作方提供指标接口 | 百毫秒级，有 SLA | 高 | 接口化、配额、限流、租户隔离 |
| 导出 | 半年订单明细下载 | 分钟级可接受 | 低 | 异步任务、引擎直接卸数到对象存储 |

不同模式的成本相差几个数量级：一次看板查询扫描几千行汇总数据，一次自由下钻可能扫描上亿行明细。数据服务层的职责就是**把便宜的查询做快，把昂贵的查询关进笼子**。

### 2、整体架构

![数据服务架构](../assets/big-data/olap-serving-architecture.svg)

- **消费方不直连 OLAP**：看板、业务系统、导出都通过 `report-service` 访问。BI 工具确需直连时，使用独立账号和独立资源组
- **查询服务负责"管"**：鉴权与租户过滤、参数校验、限流、缓存、导出任务管理，都在这一层完成
- **OLAP 引擎负责"算"**：存放 ADS 汇总表和实时明细表，用物化视图加速，用资源组隔离不同来源的查询
- **写入侧两条链路**：离线由调度系统每天覆盖写 ADS 分区并发出就绪事件，实时由 Flink 或引擎自带的 Kafka 导入（Routine Load）秒级写入主键表，实时写入链路见 [Flink CDC](/flink/6_cdc) 与 [实时数仓实战](./9_realtime_dw)

---

## 二、OLAP 引擎选型

### 1、从服务视角对比

引擎原理与通用对比见 [列式与 OLAP 数据库](/database/4_nosql/0_column_db) 第四节，这里只看与"对外提供查询服务"相关的维度：

| 维度 | StarRocks | Apache Doris | ClickHouse |
|------|-----------|--------------|------------|
| 许可证与归属 | Apache 2.0，Linux 基金会项目 | Apache 2.0，Apache 顶级项目 | Apache 2.0，ClickHouse 公司主导 |
| Java 接入 | MySQL 协议，直接用 MySQL Connector/J | MySQL 协议，直接用 MySQL Connector/J | 官方 JDBC 驱动（`com.clickhouse:clickhouse-jdbc`），也提供兼容层较弱的 MySQL 协议接口 |
| 高并发点查与小聚合 | 强，支持短路点查、查询缓存 | 强，支持行存点查、SQL Cache | 单查询扫描极快，但高并发小查询不是强项 |
| 多表 JOIN | 强（CBO 优化器） | 强（Nereids 优化器） | 能做，复杂 JOIN 需要手工调优，倾向大宽表 |
| 实时更新 | 主键表，UPSERT / 部分列更新 | Unique Key（Merge-on-Write） | 轻量级更新 / ReplacingMergeTree，不适合高频更新 |
| 物化视图 | 异步物化视图，支持透明改写 | 同步 + 异步物化视图，支持透明改写 | 物化视图为插入触发器，无透明改写 |
| 资源隔离 | 资源组（Resource Group） | Workload Group | 用户级配额与设置项（settings profile、quota） |
| 运维 | FE + BE（或存算分离的 CN），无外部依赖 | FE + BE，无外部依赖 | 单二进制，副本依赖 Keeper |

### 2、选型建议

- **对外提供报表与指标接口、需要多表 JOIN、订单状态要实时更新**：StarRocks 或 Doris。两者都兼容 MySQL 协议，Java 后端零学习成本接入，团队按已有经验和社区支持选择其一即可
- **日志、埋点、行为分析这类单表大宽表、追加写为主的场景**：ClickHouse 扫描性能突出，作为内部分析引擎很合适；对外高并发接口要做好缓存和预聚合
- **数据量在千万行以内、报表种类少**：MySQL / PostgreSQL 的只读副本加汇总表就够了，不必引入 OLAP 集群，见 [数据层扩展](/high-con/5_data_scaling)
- **不要让一个引擎包揽所有负载**：对外接口与内部自由分析混跑时，至少在资源组层面隔离；冲突严重时拆成两个集群

---

## 三、面向查询设计结果表

数据服务的性能主要由表设计决定，服务代码只能锦上添花。以 Doris 语法为例（StarRocks 写法基本一致），`ads_trade_gmv_1d` 由调度系统每天覆盖写入前一天的分区：

```sql
CREATE TABLE ads.ads_trade_gmv_1d (
    tenant_id  BIGINT         NOT NULL COMMENT '商家（租户）ID',
    dt         DATE           NOT NULL COMMENT '业务日期',
    channel    VARCHAR(32)    NOT NULL COMMENT '下单渠道',
    province   VARCHAR(32)    NOT NULL COMMENT '收货省份',
    gmv        DECIMAL(18, 2) NOT NULL COMMENT '支付金额',
    order_cnt  BIGINT         NOT NULL COMMENT '支付订单数',
    buyer_cnt  BIGINT         NOT NULL COMMENT '支付买家数（当日去重）'
)
UNIQUE KEY (tenant_id, dt, channel, province)
PARTITION BY RANGE (dt) ()
DISTRIBUTED BY HASH (tenant_id) BUCKETS 16
PROPERTIES (
    "replication_num" = "3",
    "dynamic_partition.enable" = "true",
    "dynamic_partition.time_unit" = "DAY",
    "dynamic_partition.start" = "-365",
    "dynamic_partition.end" = "3",
    "dynamic_partition.prefix" = "p",
    "dynamic_partition.buckets" = "16",
    "dynamic_partition.create_history_partition" = "true"
);
```

设计要点：

- **键列顺序贴合查询**：几乎所有查询都带 `tenant_id` 和日期范围，把它们放在键的最前面，前缀索引能直接定位数据块
- **按日期分区**：查询只扫描所选日期的分区（分区裁剪）；动态分区自动创建未来 3 天、删除 365 天前的分区，分区名形如 `p20261009`，与调度任务中的分区覆盖写对应
- **分桶键兼顾裁剪与均衡**：按 `tenant_id` 分桶，单租户查询只落到少数分桶；如果头部商家数据量远大于其他商家，会造成数据倾斜，可改为 `HASH(tenant_id, channel)` 或随机分桶
- **注意不可加指标**：`gmv`、`order_cnt` 可以跨天相加，`buyer_cnt` 是当日去重人数，**30 天的买家数不能把每天的值相加**。需要任意区间去重时，在聚合模型中改存 `BITMAP` 列（`BITMAP_UNION` 聚合），查询时用 `BITMAP_UNION_COUNT` 求去重数，或者单独产出"近 7 天 / 近 30 天"的固定区间表

---

## 四、查询 API：Spring Boot + JdbcClient

### 1、依赖与连接配置

StarRocks 和 Doris 的 FE 节点在 9030 端口提供 MySQL 协议，直接使用 MySQL 官方驱动：

```xml
<dependency>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-jdbc</artifactId>
</dependency>
<dependency>
    <groupId>com.mysql</groupId>
    <artifactId>mysql-connector-j</artifactId>
    <scope>runtime</scope>
</dependency>
```

`report-service` 只访问 OLAP，因此直接使用默认数据源，Spring Boot 会自动配置 HikariCP 连接池和 `JdbcClient`：

```yaml
spring:
  datasource:
    # loadbalance 协议在多个 FE 之间分摊连接；query_timeout 由引擎强制执行（秒）
    url: jdbc:mysql:loadbalance://fe1.olap.internal:9030,fe2.olap.internal:9030,fe3.olap.internal:9030/ads?connectTimeout=3000&socketTimeout=35000&sessionVariables=query_timeout=30
    username: report_ro
    password: ${OLAP_PASSWORD}
    hikari:
      pool-name: olap-pool
      maximum-pool-size: 20
      minimum-idle: 5
      connection-timeout: 2000
```

配置说明：

- **只读账号**：`report_ro` 只授予 `ads` 库的 `SELECT` 权限，查询服务即使有 SQL 拼接漏洞也无法写入或删表
- **超时分两层**：`sessionVariables=query_timeout=30` 让引擎在 30 秒后主动终止查询并释放资源；`socketTimeout` 设得比它略长，作为网络层兜底。只设 `socketTimeout` 的话，客户端断开了，查询仍在集群里跑
- **连接池不宜大**：OLAP 的单个查询会占用所有 BE 的 CPU，并发能力远低于 MySQL 的点查。连接池大小就是这个服务对集群的最大并发，20 个已经不少，按资源组给它的配额倒推
- **不使用 JPA / Hibernate**：OLAP 查询是只读聚合，不需要实体状态管理；`JdbcClient` 写 SQL 更直接，结果映射到 `record` 即可

### 2、Repository

```java
// 结果要放进 Redis 缓存（默认 JDK 序列化），因此实现 Serializable
public record DailyGmv(LocalDate dt, String dimValue, BigDecimal gmv, long orderCnt) implements Serializable {}

public enum GmvDimension {
    CHANNEL("channel"),
    PROVINCE("province");

    private final String column;

    GmvDimension(String column) {
        this.column = column;
    }

    public String column() {
        return column;
    }
}
```

```java
@Repository
public class GmvReportRepository {

    private final JdbcClient jdbc;

    public GmvReportRepository(JdbcClient jdbc) {
        this.jdbc = jdbc;
    }

    public List<DailyGmv> dailyGmv(long tenantId, LocalDate from, LocalDate to,
                                   GmvDimension dim, List<String> channels) {
        // 维度列来自枚举白名单，只有它允许拼进 SQL；所有取值一律走参数绑定
        String sql = """
                SELECT dt,
                       %s             AS dim_value,
                       SUM(gmv)       AS gmv,
                       SUM(order_cnt) AS order_cnt
                FROM ads_trade_gmv_1d
                WHERE tenant_id = :tenantId
                  AND dt BETWEEN :from AND :to
                  AND channel IN (:channels)
                GROUP BY dt, %s
                ORDER BY dt
                LIMIT 5000
                """.formatted(dim.column(), dim.column());

        return jdbc.sql(sql)
                .param("tenantId", tenantId)
                .param("from", from)
                .param("to", to)
                .param("channels", channels)
                .query(DailyGmv.class)
                .list();
    }
}
```

几个容易出问题的地方：

- **动态维度、排序字段只能走白名单**：前端传来的 `dim=channel` 先转成枚举，再取列名拼接；任何直接拼接请求参数的写法都是 SQL 注入
- **`IN (:channels)` 由命名参数自动展开**：`JdbcClient` 的命名参数会把集合展开成 `?, ?, ?`；集合不能为空，空集合要在服务层提前处理（不过滤或直接返回空结果）
- **结果映射**：`query(DailyGmv.class)` 对 `record` 使用构造器映射，列名 `dim_value`、`order_cnt` 会匹配到 `dimValue`、`orderCnt`
- **兜底 `LIMIT`**：聚合结果理论上很小，但维度组合异常时可能返回几十万行，`LIMIT` 防止把服务内存撑爆；明细分页要限制最大页码，深分页改用"按排序键游标"翻页
- **租户 ID 不来自请求参数**：`tenantId` 由服务层从登录态中取出后传入，见第九节

### 3、Controller 与参数约束

```java
public record GmvQuery(
        @NotNull LocalDate from,
        @NotNull LocalDate to,
        @NotNull GmvDimension dim,
        @NotEmpty @Size(max = 20) List<String> channels) {

    public String cacheKey() {
        return from + ":" + to + ":" + dim + ":" + channels.stream().sorted().toList();
    }
}

@RestController
@RequestMapping("/api/reports/gmv")
public class GmvReportController {

    private static final int MAX_DAYS = 92;

    private final GmvReportService service;

    public GmvReportController(GmvReportService service) {
        this.service = service;
    }

    @PostMapping("/daily")
    public List<DailyGmv> daily(@Valid @RequestBody GmvQuery query,
                                @AuthenticationPrincipal Jwt jwt) {
        if (query.to().isBefore(query.from())
                || ChronoUnit.DAYS.between(query.from(), query.to()) >= MAX_DAYS) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "查询区间需在 92 天以内");
        }
        long tenantId = Long.parseLong(jwt.getClaimAsString("tenant_id"));
        return service.dailyGmv(tenantId, query);
    }
}
```

**限制查询代价比优化查询更有效**：日期区间上限、必填过滤条件、维度个数上限、明细最大页数，这些约束在接口层就把"扫全表"的请求挡掉了。需要超长区间的场景，引导到异步导出或离线报表。

---

## 五、物化视图与预聚合

### 1、预聚合放在哪一层

| 方式 | 谁来维护 | 数据新鲜度 | 查询是否需要改写 | 适用 |
|------|----------|------------|------------------|------|
| 调度产出 ADS 汇总表 | 调度任务（上一篇） | T+1 或小时级 | 查询直接写汇总表 | 口径固定的核心报表，可以做复杂逻辑与质量校验 |
| 同步物化视图 / Rollup | 引擎在写入时同步维护 | 与基表一致 | 不需要，优化器自动选择 | 单表上的固定维度聚合，加速明细表的常见聚合 |
| 异步物化视图 | 引擎按计划或基表变更刷新 | 取决于刷新周期 | 不需要，透明改写；也可直接查 | 多表 JOIN + 聚合、实时明细表上的分钟 / 小时级汇总 |
| 应用层结果缓存 | 查询服务 | 取决于失效策略 | — | 高重复度的看板查询，见第六节 |

经验做法：**核心报表由调度产出 ADS 表**，口径、质量都可控；**实时看板和交互式分析用异步物化视图**，在实时明细表上做轻量汇总，省去一条 Flink 聚合链路。

### 2、异步物化视图

实时链路把订单明细秒级写入 OLAP 中的主键表 `dwd.dwd_trade_order_detail_inc`（按 `dt` 分区），看板需要"今天每个渠道的实时 GMV"。在 StarRocks 中：

```sql
CREATE MATERIALIZED VIEW ads.mv_order_channel_1d
PARTITION BY dt
DISTRIBUTED BY HASH(tenant_id)
REFRESH ASYNC EVERY (INTERVAL 5 MINUTE)
AS
SELECT tenant_id,
       dt,
       channel,
       SUM(pay_amount) AS gmv,
       COUNT(*)        AS order_cnt
FROM dwd.dwd_trade_order_detail_inc
WHERE order_status IN ('PAID', 'SHIPPED', 'FINISHED')
GROUP BY tenant_id, dt, channel;
```

Doris 中等价的写法：

```sql
CREATE MATERIALIZED VIEW ads.mv_order_channel_1d
BUILD IMMEDIATE
REFRESH AUTO ON SCHEDULE EVERY 5 MINUTE
PARTITION BY (dt)
DISTRIBUTED BY RANDOM BUCKETS 4
AS
SELECT tenant_id,
       dt,
       channel,
       SUM(pay_amount) AS gmv,
       COUNT(*)        AS order_cnt
FROM dwd.dwd_trade_order_detail_inc
WHERE order_status IN ('PAID', 'SHIPPED', 'FINISHED')
GROUP BY tenant_id, dt, channel;
```

要点：

- **按分区增量刷新**：物化视图与基表按 `dt` 分区对齐，刷新时只重算有变化的分区（Doris 的 `REFRESH AUTO` 在能增量时按分区刷新，否则全量），今天的订单不断写入，只有今天的分区被反复重算
- **透明改写**：两者默认开启（StarRocks 的 `enable_materialized_view_rewrite`、Doris 的同名变量），查询 `dwd_trade_order_detail_inc` 上能被物化视图满足的聚合会被自动改写为读物化视图，用 `EXPLAIN` 检查是否命中。透明改写让业务 SQL 不必感知物化视图，但对外接口的关键查询建议**直接查物化视图**，避免改写规则变化导致性能突然退化
- **新鲜度要写进接口语义**：5 分钟刷新意味着看板最多落后 5 分钟，返回结果时带上数据截止时间，前端展示"数据更新于 10:35"
- **物化视图不是免费的**：每个物化视图都占用刷新资源和存储，几十个物化视图同时刷新会和查询争抢资源。刷新任务放到单独的资源组，定期清理没有命中的物化视图

---

## 六、热点报表缓存

### 1、引擎缓存与应用缓存

OLAP 引擎自带结果级缓存：Doris 的 SQL Cache（`enable_sql_cache`）以 SQL 文本、表和分区版本为键缓存最终结果，数据变化后自动失效；StarRocks 的 Query Cache（`enable_query_cache`）缓存各节点上的局部聚合结果，相似但不完全相同的聚合查询也能复用。它们能减轻集群压力，但请求仍要经过网络、连接池和 FE 解析。

看板这类"成千上万个用户刷新同一份数据"的场景，还需要在查询服务里加应用缓存，缓存通用设计见 [缓存总览](/cache/0_overview)，Redis 或两级缓存的做法见 [两级缓存](/cache/8_two_level_cache)。报表缓存与业务缓存最大的不同是：**数据只在 ETL 产出时变化**，因此不需要靠 TTL 猜测何时失效，可以精确地按"数据版本"失效。

### 2、按数据版本失效

上一篇的 ADS 节点成功后会写入就绪标记；在同一步骤里，把该表的数据版本号写到 Redis（例如 `dv:ads_trade_gmv_1d` 设为产出时间戳）。查询服务把版本号作为缓存键的一部分，新数据产出后旧键自然不再命中，等待 TTL 过期即可：

```java
@Service
public class GmvReportService {

    private static final String VERSION_KEY = "dv:ads_trade_gmv_1d";

    private final StringRedisTemplate redis;
    private final GmvReportCache cache;

    public GmvReportService(StringRedisTemplate redis, GmvReportCache cache) {
        this.redis = redis;
        this.cache = cache;
    }

    public List<DailyGmv> dailyGmv(long tenantId, GmvQuery query) {
        String version = Objects.requireNonNullElse(redis.opsForValue().get(VERSION_KEY), "0");
        return cache.dailyGmv(version, tenantId, query);
    }
}

@Component
public class GmvReportCache {

    private final GmvReportRepository repository;
    private final OlapQueryGuard guard;

    public GmvReportCache(GmvReportRepository repository, OlapQueryGuard guard) {
        this.repository = repository;
        this.guard = guard;
    }

    // 单独放在一个 Bean 中，避免同类内部调用绕过缓存代理
    @Cacheable(cacheNames = "report:gmv",
               key = "#version + ':' + #tenantId + ':' + #query.cacheKey()")
    public List<DailyGmv> dailyGmv(String version, long tenantId, GmvQuery query) {
        return guard.run(tenantId, () -> repository.dailyGmv(
                tenantId, query.from(), query.to(), query.dim(), query.channels()));
    }
}
```

```yaml
spring:
  cache:
    type: redis
    redis:
      time-to-live: 6h        # 版本号负责失效，TTL 只负责回收旧版本的键
```

要点：

- **缓存键必须包含租户 ID 和全部查询参数**，参数要规范化（集合排序、日期统一格式），否则同一查询会产生多个键
- **实时表不适合按版本缓存**：基于实时明细表 `dwd_trade_order_detail_inc` 或 5 分钟刷新的物化视图的查询，用 30 秒到 1 分钟的短 TTL，既能挡住瞬间并发，又不至于让数据明显滞后
- **大促零点等热点时刻提前预热**：数据产出后由调度任务调用预热接口，按热门租户和默认查询条件先算一遍，避免版本切换瞬间所有请求穿透到 OLAP；缓存击穿与一致性的通用方案见 [缓存一致性](/cache/10_cache_consistency)
- **只缓存固定报表**：自由下钻的参数组合几乎不重复，缓存命中率低还浪费内存，交给引擎的结果缓存即可

---

## 七、重查询限流与资源隔离

一个不加限制的下钻查询可能扫描几亿行、占满所有 BE 的 CPU 几十秒，同时段的看板查询全部变慢。防护要在应用层和引擎层同时做。

### 1、应用层：并发舱壁

按"全局 + 租户"两级限制同时在 OLAP 上执行的查询数，超出时快速失败而不是排队等待：

```java
@Component
public class OlapQueryGuard {

    private final Semaphore global = new Semaphore(16);   // 小于连接池大小，留出余量
    private final ConcurrentMap<Long, Semaphore> perTenant = new ConcurrentHashMap<>();

    public <T> T run(long tenantId, Supplier<T> query) {
        Semaphore tenant = perTenant.computeIfAbsent(tenantId, id -> new Semaphore(3));
        if (!tenant.tryAcquire()) {
            throw new ResponseStatusException(HttpStatus.TOO_MANY_REQUESTS, "同时进行的查询过多，请稍后重试");
        }
        try {
            if (!global.tryAcquire(200, TimeUnit.MILLISECONDS)) {
                throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE, "报表服务繁忙");
            }
            try {
                return query.get();
            } finally {
                global.release();
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE, "请求被中断");
        } finally {
            tenant.release();
        }
    }
}
```

- 单个租户最多 3 个并发查询，防止某个商家的脚本或频繁刷新挤占其他商家的配额；租户很多时用带过期淘汰的缓存（如 Caffeine）代替无界的 `ConcurrentHashMap`
- 全局并发略小于连接池大小，等待 200 毫秒拿不到就返回 503，避免请求在连接池上堆积、拖慢整个服务
- 生产中可以换成 Resilience4j 的 Bulkhead 和 RateLimiter，并按接口区分配额；限流与舱壁的通用原理见 [超时、重试与隔离](/high-avail/4_timeout_retry_bulkhead) 和 [限流与过载保护](/high-avail/7_rate_limiting)

### 2、引擎层：资源组与查询熔断

应用层只能管住自己，引擎层的隔离才能管住所有来源（查询服务、BI 直连、临时分析、物化视图刷新）。

StarRocks 用资源组按用户、角色、来源 IP 等分类器把查询归组，并限制大查询：

```sql
CREATE RESOURCE GROUP rg_report_api
TO (user = 'report_ro')
WITH (
    'cpu_weight' = '8',
    'mem_limit' = '40%',
    'concurrency_limit' = '40',
    'big_query_cpu_second_limit' = '30',
    'big_query_scan_rows_limit' = '500000000'
);
```

`big_query_*` 系列参数在查询消耗的 CPU 时间或扫描行数超过阈值时直接终止该查询；`cpu_weight` 与 `exclusive_cpu_cores` 二选一，后者为资源组独占 CPU 核，适合对延迟极敏感的对外接口。

Doris 用 Workload Group 限制 CPU、内存和并发，并配合 SQL 拦截规则：

```sql
CREATE WORKLOAD GROUP IF NOT EXISTS wg_report_api
PROPERTIES (
    "min_cpu_percent" = "30%",
    "max_cpu_percent" = "60%",
    "max_memory_percent" = "40%",
    "max_concurrency" = "40",
    "max_queue_size" = "20",
    "queue_timeout" = "3000"
);

GRANT USAGE_PRIV ON WORKLOAD GROUP 'wg_report_api' TO 'report_ro'@'%';
SET PROPERTY FOR 'report_ro' 'default_workload_group' = 'wg_report_api';

-- 拦截单表扫描超过 100 个分区的查询，防止"查两年明细"
CREATE SQL_BLOCK_RULE block_wide_scan
PROPERTIES (
    "partition_num" = "100",
    "global" = "false",
    "enable" = "true"
);
SET PROPERTY FOR 'report_ro' 'sql_block_rules' = 'block_wide_scan';
```

`max_queue_size` 与 `queue_timeout`（毫秒）控制超出并发后的排队行为，队列满或等待超时的查询直接失败。各属性的取值范围在不同小版本间有调整，上线前以所用版本的文档为准。

推荐的资源组划分：对外接口、内部 BI、临时分析、物化视图刷新各一组，对外接口组保底资源最高、大查询阈值最严。

---

## 八、异步导出

导出半年明细这类请求不适合同步接口：结果集可能有几千万行，HTTP 请求等不了那么久，把数据流经 Java 服务再写 Excel 也会耗尽内存。通用的异步任务表、流式写文件、预签名 URL 下载方案见 [海量数据导入导出](/scenario/3_sheet_export)，OLAP 场景有一个更省资源的选择：**让引擎直接把结果卸到对象存储**。

```sql
-- Doris：查询结果直接写到 S3 兼容存储
SELECT order_id, shop_id, pay_amount, pay_time
FROM dwd.dwd_trade_order_detail_inc
WHERE tenant_id = 10086 AND dt BETWEEN '2026-04-01' AND '2026-09-30'
INTO OUTFILE "s3://report-export/10086/task_8842/orders_"
FORMAT AS csv_with_names
PROPERTIES (
    "s3.endpoint" = "https://s3.example.internal",
    "s3.region" = "cn-east-1",
    "s3.access_key" = "${EXPORT_AK}",
    "s3.secret_key" = "${EXPORT_SK}"
);
```

StarRocks 对应的是 `INSERT INTO FILES(...) SELECT ...`，同样支持 CSV / Parquet 格式写入对象存储。整体流程：

1. 接口收到导出请求，校验权限与配额（如每个租户每天 10 次、同时最多 2 个），写入导出任务表，立即返回任务 ID
2. 后台工作线程从任务表领取任务，在"导出专用"资源组下执行卸数 SQL，文件按大小自动拆分为多个
3. 完成后更新任务状态，生成带过期时间的预签名下载 URL，通过站内信通知用户
4. 对象存储上配置生命周期规则，导出文件 7 天后自动删除

上面 SQL 中的密钥占位符要由服务在执行前从密钥管理系统读取后填入，不能写死在代码或配置文件里；`tenant_id` 同样由服务注入，不接受用户输入。对象存储的权限与预签名 URL 设计见 [对象存储](/architecture/4_object_storage)。

---

## 九、多租户隔离

电商 SaaS 平台上，一张 ADS 表里存着所有商家的数据，隔离从三个层面考虑：

| 层面 | 手段 | 说明 |
|------|------|------|
| 数据可见性 | 每张表带 `tenant_id`，查询服务强制注入过滤条件 | 最常用；`tenant_id` 只从登录态取，Repository 方法签名里把它设为必填参数，代码评审时一眼能看出遗漏 |
| | 引擎行级策略 | Doris 的 `CREATE ROW POLICY ... TO <user> USING (tenant_id = 10086)` 在引擎层追加过滤；需要为每个租户建账号，适合少量内部角色（如"华东区运营只看华东数据"），不适合上万个商家 |
| | 按租户分库 / 分集群 | 头部大客户或有合规要求的租户独立部署，代价是运维和成本成倍增加 |
| 资源 | 应用层按租户限流 + 引擎资源组 | 防止大租户的重查询影响小租户；按套餐等级划分配额 |
| 存储布局 | 键列与分桶以 `tenant_id` 开头 | 单租户查询只扫描少量数据块，同时降低误扫其他租户数据的成本 |

强制注入过滤条件的落地方式：

- 所有 Repository 方法第一个参数是 `tenantId`，SQL 模板中写死 `WHERE tenant_id = :tenantId`，禁止提供"不带租户"的通用查询方法
- 单元测试 / 集成测试覆盖"A 租户的令牌查询 B 租户数据返回空"的用例，见 [集成测试](/testing/3_integration_test)
- 平台运营人员需要跨租户查询时，走单独的内部接口和独立账号，并记录审计日志
- 敏感字段（手机号、地址）在 ADS 层就脱敏或不进入对外表，数据安全的通用做法见 [数据安全](/security/7_data_security)

---

## 十、指标层与语义层

### 1、问题：同一个指标多个口径

报表多起来以后，"GMV"在商家后台、运营看板、财务报表里可能有三种算法：是否包含已退款订单、按下单时间还是支付时间、是否剔除测试店铺。每个接口各写一份 SQL，口径就会悄悄分叉，最后谁也说不清哪个数是对的。

### 2、指标层的思路

指标层（Metrics Layer）把"指标怎么算"从各个接口的 SQL 中抽出来，集中定义一次：

| 要素 | 示例（支付 GMV） |
|------|------------------|
| 度量 | `SUM(pay_amount)` |
| 基础表 | `dwd_trade_order_detail_inc` 或 `ads_trade_gmv_1d` |
| 过滤条件 | 已支付、非测试店铺、不扣除退款 |
| 时间口径 | 按支付时间归属业务日期 |
| 可用维度 | 租户、渠道、省份、商品类目 |
| 负责人与版本 | 交易数据组，变更需评审 |

查询方只说"按渠道看最近 30 天的支付 GMV"，由指标层生成 SQL、选择命中的汇总表或物化视图，并统一做权限控制与缓存。语义层（Semantic Layer）是更宽泛的说法，除指标外还定义实体、维度和它们之间的关联，让 BI 工具、业务接口乃至大模型问数都基于同一套业务语义查询。

### 3、落地方式

- **开源与商业工具**：dbt Semantic Layer（基于 MetricFlow）、Cube 等，提供指标定义、SQL 生成、缓存与 API；适合指标多、消费方多的平台
- **轻量做法**：在 `report-service` 中维护一张指标定义表（指标编码、SQL 片段、可用维度、口径说明），接口按指标编码查询；配合指标管理流程，把口径评审纳入数据治理，见 [数据治理](./8_governance)
- **与物化视图配合**：指标层负责"算什么"，物化视图和汇总表负责"算得快"；指标定义稳定以后，再按查询热度为其建立物化视图

团队规模较小、报表不多时，不必一开始就上语义层工具，但至少要做到"每个指标有一份书面口径、一个负责人"，并让所有接口复用同一段 SQL。

---

## 小结

- 数据服务层把便宜的查询做快、把昂贵的查询关进笼子；消费方经查询服务访问 OLAP，查询服务负责鉴权、租户过滤、限流、缓存和导出
- 对外报表与指标接口优先 StarRocks / Doris（MySQL 协议、强 JOIN、实时更新），单表大宽表分析选 ClickHouse，小数据量用 MySQL 只读副本即可；引擎原理见 [列式与 OLAP 数据库](/database/4_nosql/0_column_db)
- 结果表按"租户 + 日期"设计键列、分区和分桶；注意去重类指标不能跨天相加
- `JdbcClient` 查询：只读账号、引擎侧 `query_timeout` 加客户端 `socketTimeout`、小连接池；动态维度走枚举白名单，取值全部参数绑定；接口层限制日期区间和过滤条件
- 核心报表由调度产出 ADS 表，实时看板用异步物化视图按分区增量刷新；关键接口直接查物化视图，返回数据截止时间
- 固定报表按"数据版本号"缓存，实时数据用短 TTL；应用层按全局与租户两级限制并发，引擎层用资源组 / Workload Group 和大查询熔断兜底
- 大结果集走异步导出，由引擎直接卸数到对象存储；多租户以强制注入 `tenant_id` 为主，引擎行级策略适合少量内部角色；指标口径集中定义，避免同名不同数

## 参考资料

- StarRocks 异步物化视图：[Asynchronous Materialized Views](https://docs.starrocks.io/docs/using_starrocks/async_mv/Materialized_view/)
- StarRocks 资源组：[Resource Group](https://docs.starrocks.io/docs/administration/management/resource_management/resource_group/)
- StarRocks 查询缓存：[Query Cache](https://docs.starrocks.io/docs/using_starrocks/caching/query_cache/)
- StarRocks 导出到文件：[Unload data using INSERT INTO FILES](https://docs.starrocks.io/docs/unloading/unload_using_insert_into_files/)
- StarRocks 4.1 版本说明：[StarRocks 4.1 Release Notes](https://docs.starrocks.io/releasenotes/release-4.1/)
- Doris 异步物化视图：[Async Materialized View](https://doris.apache.org/docs/4.x/query-acceleration/materialized-view/async-materialized-view/functions-and-demands)
- Doris Workload Group：[Workload Group](https://doris.apache.org/docs/4.x/admin-manual/workload-management/workload-group)
- Doris SQL 拦截规则：[CREATE SQL_BLOCK_RULE](https://doris.apache.org/docs/4.x/sql-manual/sql-statements/data-governance/CREATE-SQL_BLOCK_RULE)
- Doris 行级权限策略：[CREATE ROW POLICY](https://doris.apache.org/docs/4.x/sql-manual/sql-statements/data-governance/CREATE-ROW-POLICY)
- Doris SQL Cache：[SQL Cache](https://doris.apache.org/docs/4.x/query-acceleration/sql-cache-manual/)
- Doris 查询结果导出：[SELECT INTO OUTFILE](https://doris.apache.org/docs/4.x/data-operate/export/outfile)
- Doris 版本发布：[Apache Doris Releases](https://doris.apache.org/releases/all-release/)
- Spring Framework JdbcClient：[Data Access with JDBC - JdbcClient](https://docs.spring.io/spring-framework/reference/data-access/jdbc/core.html#jdbc-JdbcClient)
- Spring Boot 数据源与缓存配置：[Spring Boot - SQL Databases](https://docs.spring.io/spring-boot/reference/data/sql.html)、[Spring Boot - Caching](https://docs.spring.io/spring-boot/reference/io/caching.html)
- MySQL Connector/J 连接参数与负载均衡：[Connector/J Configuration Properties](https://dev.mysql.com/doc/connector-j/en/connector-j-reference-configuration-properties.html)、[Connector/J Load Balancing](https://dev.mysql.com/doc/connector-j/en/connector-j-usagenotes-j2ee-concepts-managing-load-balanced-connections.html)
- 语义层：[dbt Semantic Layer](https://docs.getdbt.com/docs/use-dbt-semantic-layer/dbt-sl)、[Cube Documentation](https://cube.dev/docs)

> 下一篇：[数据治理](./8_governance)
