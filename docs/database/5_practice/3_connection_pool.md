---
description: HikariCP 参数与池大小估算、Druid 配置与监控、PgBouncer、泄漏排查、读写分离多数据源
---

# 数据库连接池

> **本篇目标**：掌握 HikariCP 的核心参数与默认值，能按数据库服务器的能力估算池大小，会配置 Druid 并规避其安全风险，理解 PostgreSQL 为什么需要 PgBouncer，能排查连接泄漏，并写出可编译的读写分离路由数据源。
>
> **前置阅读**：[池化技术](/high-perf/7_pooling)（池化的通用原理）、[MySQL JDBC 驱动](../6_reference/2_jdbc_driver)

本篇是连接池参数与配置的主文档。池化为什么能提升性能、连接数为什么不是越大越好的通用论证见 [池化技术](/high-perf/7_pooling)；Spring Boot 中 `DataSource` 自动配置的整体机制见 [数据访问](/spring-boot/3_data_access)。

---

## 一、为什么需要连接池

建立一个数据库连接要经过 TCP 握手、TLS 协商、认证与会话初始化，耗时从几毫秒到几十毫秒不等，数据库侧也要为每个连接分配线程（MySQL）或进程（PostgreSQL）与内存。连接池**预先建立并复用连接**，同时给并发访问数据库设上限：

| 问题 | 连接池的处理 |
|------|----------|
| 建连慢 | 预热连接，请求直接从池中借取 |
| 并发峰值压垮数据库 | 最大连接数限制，超出的请求排队等待 |
| 连接被中间设备静默断开 | 保活探测、定期替换连接 |
| 连接泄漏 | 借出超时告警，定位未归还的代码 |

---

## 二、HikariCP

HikariCP 是 Spring Boot 2.0 起的默认连接池，代码量小、锁竞争少。当前版本是 7.x（Java 11+），Spring Boot 3.5 管理的是 6.x，Spring Boot 4.0 管理的是 7.x。

### 1、核心参数

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `maximumPoolSize` | 10 | 池中连接总数上限（空闲 + 使用中） |
| `minimumIdle` | 等于 `maximumPoolSize` | 官方建议不设置，保持固定大小的池 |
| `connectionTimeout` | 30000 ms | 借连接的最长等待时间，超时抛 `SQLTransientConnectionException`；最小 250 ms |
| `idleTimeout` | 600000 ms | 空闲连接被回收的时间，仅在 `minimumIdle < maximumPoolSize` 时生效 |
| `maxLifetime` | 1800000 ms | 连接最长存活时间，到期后在空闲时被替换；应比数据库与网络设备的空闲超时短几十秒 |
| `keepaliveTime` | 120000 ms | 对空闲连接做保活探测的间隔，最小 30000 ms，且必须小于 `maxLifetime`；6.2.1 起默认 2 分钟，之前的版本默认 0（关闭） |
| `leakDetectionThreshold` | 0（关闭） | 连接借出超过该时间未归还就打印堆栈，最小 2000 ms |
| `connectionTestQuery` | 无 | JDBC4 驱动不要设置，默认使用 `Connection.isValid()` |

### 2、Spring Boot 配置

```yaml
spring:
  datasource:
    url: jdbc:mysql://db:3306/mydb?sslMode=REQUIRED&connectionTimeZone=Asia/Shanghai
    username: app
    password: ${DB_PASSWORD}
    hikari:
      pool-name: order-pool
      maximum-pool-size: 10
      connection-timeout: 3000
      max-lifetime: 1800000
      keepalive-time: 120000
```

- `connection-timeout` 调低到 2～5 秒：池耗尽时快速失败，比让请求线程挂 30 秒更好
- `pool-name` 会出现在日志与指标标签里，多数据源时用于区分
- `sslMode` 取代了已废弃的 `useSSL`，其他 URL 参数见 [MySQL JDBC 驱动](../6_reference/2_jdbc_driver)

### 3、监控

引入 Actuator 后，HikariCP 指标会自动注册到 Micrometer，常用的有：

| 指标 | 含义 | 告警建议 |
|------|------|---------|
| `hikaricp.connections.active` | 正在使用的连接数 | 长期接近上限说明池偏小或 SQL 偏慢 |
| `hikaricp.connections.pending` | 等待借连接的线程数 | 持续大于 0 需要排查 |
| `hikaricp.connections.timeout` | 借连接超时的次数 | 大于 0 即告警 |
| `hikaricp.connections.usage` | 连接被持有的时长 | 长尾说明有慢 SQL 或长事务 |

指标采集与告警规则的配置见 [可观测性总览](/observability/0_overview)。

### 4、池大小估算

HikariCP 文档 About Pool Sizing 引用的经验公式：

> 连接数 = 数据库服务器 CPU 核数 × 2 + 有效磁盘数

这里的核数是**数据库服务器**的核数，算出来的是数据库侧同时活跃的连接总数，需要分摊到所有应用实例，而不是每个应用实例各配这么多。例如数据库 16 核、SSD（有效磁盘数按 1 计）：总活跃连接约 33，部署 4 个应用实例时每个实例 8～10 个连接就够了。

落地时还要做两步校验：

1. **总量约束**：所有实例的池大小之和（含扩容后的实例数）不超过数据库 `max_connections` 的 80% 左右，给运维连接、复制、监控留余量
2. **按持有时间反推**：单实例所需连接数 ≈ 峰值 QPS × 平均持有连接时间（秒）；算出的值远大于公式时，先缩短持有时间（优化慢 SQL、事务内不做远程调用），而不是加大池

---

## 三、Druid

Druid 是阿里巴巴开源的连接池，在连接池之外提供 SQL 统计、慢 SQL 记录、SQL 防火墙（wall filter）与 Web 监控页。

### 1、Spring Boot 3 配置

Spring Boot 3 必须使用 `druid-spring-boot-3-starter`，旧的 `druid-spring-boot-starter` 没有 Boot 3 的自动配置注册文件，引入后不会生效：

```xml
<dependency>
    <groupId>com.alibaba</groupId>
    <artifactId>druid-spring-boot-3-starter</artifactId>
    <version>1.2.28</version>
</dependency>
```

```yaml
spring:
  datasource:
    type: com.alibaba.druid.pool.DruidDataSource
    url: jdbc:mysql://db:3306/mydb?sslMode=REQUIRED
    username: app
    password: ${DB_PASSWORD}
    druid:
      initial-size: 5
      min-idle: 10
      max-active: 20
      max-wait: 3000
      keep-alive: true
      time-between-eviction-runs-millis: 60000
      min-evictable-idle-time-millis: 300000
      validation-query: SELECT 1
      test-while-idle: true
      test-on-borrow: false
      filters: stat,wall,slf4j
      connection-properties: druid.stat.mergeSql=true;druid.stat.slowSqlMillis=1000
```

| 参数 | 说明 |
|------|------|
| `max-active` / `min-idle` | 最大连接数与最小空闲连接数 |
| `max-wait` | 借连接的等待超时（毫秒） |
| `keep-alive` | 对空闲连接定期做保活，防止被中间设备断开 |
| `test-while-idle` | 借出时若空闲超过检测间隔才校验，开销小；`test-on-borrow` 每次借出都校验，生产一般关闭 |
| `filters` | `stat` 统计、`wall` 防火墙、`slf4j` 日志 |
| `druid.stat.slowSqlMillis` | 慢 SQL 阈值 |

### 2、监控页的安全风险

Druid 的 StatViewServlet 能看到所有执行过的 SQL、会话与 URI 统计，一旦暴露在公网就是信息泄露，还曾有弱口令被批量扫描的事件。生产环境要么不开启，要么同时做到：

```yaml
spring:
  datasource:
    druid:
      stat-view-servlet:
        enabled: true
        url-pattern: /druid/*
        login-username: ${DRUID_USER}
        login-password: ${DRUID_PASSWORD}
        allow: 10.0.0.0/8
        reset-enable: false
```

- 强口令并从配置中心或环境变量注入，不写死在代码库
- `allow` 限制内网 IP 段，网关层不对外暴露 `/druid/*`
- 已有 Prometheus + Grafana 时，更推荐关闭控制台，通过指标导出做监控

---

## 四、HikariCP 与 Druid 对比

| 维度 | HikariCP | Druid |
|------|--------|-----|
| 定位 | 只做连接池，追求精简与低开销 | 连接池 + SQL 监控 + 防火墙 |
| 监控 | Micrometer 指标，外接 Prometheus | 内置 Web 控制台与统计 |
| SQL 防火墙 | 无 | wall filter |
| 慢 SQL 统计 | 无，依赖数据库慢日志或 APM | 内置 |
| Spring Boot 默认 | 是 | 否，需引入 Boot 3 专用 starter |
| 适用 | 已有统一可观测性体系的服务 | 需要应用侧 SQL 审计与可视化的团队 |

已有 Prometheus + Grafana 与 APM 时选 HikariCP；需要在应用侧直接看 SQL 统计、做 SQL 防火墙时选 Druid。

---

## 五、PgBouncer

### 1、为什么 PostgreSQL 需要它

PostgreSQL 为每个连接 fork 一个后端进程，单个连接的内存与上下文切换开销都比 MySQL 的线程大，`max_connections` 一般只配几百。微服务实例多、每个实例都带一个连接池时，总连接数很容易超限。PgBouncer 是部署在应用与 PostgreSQL 之间的轻量连接池代理，把大量客户端连接复用到少量服务端连接上。

### 2、三种池模式

| 模式 | 服务端连接何时归还 | 复用率 | 限制 |
|------|---------------|-------|------|
| `session`（默认） | 客户端断开时 | 低 | 无，行为与直连一致 |
| `transaction` | 事务结束时 | 高，生产常用 | 不能依赖会话级状态 |
| `statement` | 每条语句结束时 | 最高 | 不允许多语句事务 |

`transaction` 模式下，同一个客户端的两个事务可能落在不同的服务端连接上，因此以下用法会出问题：会话级 `SET`（改用 `SET LOCAL`）、会话级 advisory lock、`LISTEN`、跨事务使用的临时表、`WITH HOLD` 游标。

### 3、预编译语句

`transaction` 模式下，协议级的命名预编译语句（JDBC 的 server-side prepare）原先无法使用，因为语句准备在一个服务端连接上、执行可能落到另一个连接。PgBouncer **1.21 起**支持跟踪协议级预编译语句：设置 `max_prepared_statements` 为非 0 值后，PgBouncer 会在分配到的服务端连接上按需重新准备语句（新版本默认值为 200）。SQL 层的 `PREPARE` / `EXECUTE` 不在跟踪范围内。

使用更老的 PgBouncer 时，pgjdbc 需要在 URL 上加 `prepareThreshold=0` 关闭服务端预编译。

### 4、配置示例

```ini
; pgbouncer.ini
[databases]
mydb = host=10.0.0.10 port=5432 dbname=mydb

[pgbouncer]
listen_addr = 0.0.0.0
listen_port = 6432
auth_type = scram-sha-256
auth_file = /etc/pgbouncer/userlist.txt
pool_mode = transaction
default_pool_size = 20
max_client_conn = 2000
max_prepared_statements = 200
```

应用侧仍然保留 HikariCP，只是把 URL 指向 PgBouncer 的 6432 端口。此时应用池负责「线程借连接」的排队，PgBouncer 的 `default_pool_size` 才对应数据库侧的真实连接数，池大小估算公式作用在这一层。

---

## 六、连接泄漏排查

连接被借出后一直不归还，池会被逐渐耗尽，表现为借连接超时、而数据库本身很空闲。

### 1、HikariCP 泄漏检测

```yaml
spring:
  datasource:
    hikari:
      leak-detection-threshold: 5000
```

连接借出超过 5 秒未归还时，日志会打印借出位置的堆栈：

```text
WARN  ProxyLeakTask - Connection leak detection triggered for com.mysql.cj.jdbc.ConnectionImpl@1a2b3c on thread http-nio-8080-exec-7, stack trace follows
java.lang.Exception: Apparent connection leak detected
    at com.example.OrderService.findOrder(OrderService.java:42)
```

阈值要大于正常的最长事务时间，否则会误报；它只告警、不回收连接。

### 2、Druid 泄漏回收

```yaml
spring:
  datasource:
    druid:
      remove-abandoned: true
      remove-abandoned-timeout: 30
      log-abandoned: true
```

`remove-abandoned` 会强制回收超时连接并记录借出堆栈，开启后每次借连接都要记录调用栈，开销明显，只在排查期间临时开启。

### 3、常见泄漏原因

| 原因 | 修复方式 |
|------|---------|
| 异常路径未关闭 `Connection` / `Statement` / `ResultSet` | 使用 try-with-resources |
| 手动管理事务未提交或回滚 | 交给 Spring `@Transactional` 管理 |
| 长事务、事务中做远程调用 | 缩短事务范围，远程调用移到事务外 |
| 流式查询未读完就丢弃 `ResultSet` | 读完或显式关闭，见 [MySQL JDBC 驱动](../6_reference/2_jdbc_driver) |

---

## 七、常见问题

### 1、连接池耗尽

现象是 `Connection is not available, request timed out after 3000ms`，原因是使用中的连接数达到 `maximumPoolSize`，等待超过 `connectionTimeout`。排查顺序：

1. 看 `hikaricp.connections.pending` 是否持续大于 0、`hikaricp.connections.usage` 是否有长尾
2. 查数据库慢查询与长事务（MySQL `information_schema.innodb_trx`，PostgreSQL `pg_stat_activity`）
3. 打线程 Dump，看业务线程是否阻塞在数据库调用或持有连接时阻塞在远程调用上
4. 确认 SQL 与事务范围都已优化后，再按估算公式评估是否扩大池或拆分数据源

### 2、连接被断开（Communications link failure）

原因通常是连接空闲时被数据库的 `wait_timeout`（MySQL 默认 28800 秒）、防火墙、NAT 或负载均衡的空闲超时断开，池中连接已经失效：

- HikariCP：`maxLifetime` 小于所有中间环节的空闲超时，`keepaliveTime` 小于其中最短的那个
- Druid：开启 `keep-alive` 与 `test-while-idle`
- 查看数据库侧超时：`SHOW VARIABLES LIKE 'wait_timeout';`

### 3、读写分离多数据源

只需要读写分离、不需要分片时，可以用 Spring 的 `AbstractRoutingDataSource` 按事务是否只读路由。需要分片或多个副本负载均衡时，用 ShardingSphere 的读写分离规则，见 [分库分表与中间件](./2_sharding)。

```yaml
app:
  datasource:
    primary:
      jdbc-url: jdbc:mysql://primary:3306/mydb?sslMode=REQUIRED
      username: app
      password: ${DB_PASSWORD}
      pool-name: primary-pool
      maximum-pool-size: 10
    replica:
      jdbc-url: jdbc:mysql://replica:3306/mydb?sslMode=REQUIRED
      username: app_ro
      password: ${DB_RO_PASSWORD}
      pool-name: replica-pool
      maximum-pool-size: 10
```

```java
public class ReadWriteRoutingDataSource extends AbstractRoutingDataSource {

    @Override
    protected Object determineCurrentLookupKey() {
        return TransactionSynchronizationManager.isCurrentTransactionReadOnly() ? "replica" : "primary";
    }
}
```

```java
@Configuration
public class DataSourceConfig {

    @Bean
    @ConfigurationProperties("app.datasource.primary")
    public HikariDataSource primaryDataSource() {
        return DataSourceBuilder.create().type(HikariDataSource.class).build();
    }

    @Bean
    @ConfigurationProperties("app.datasource.replica")
    public HikariDataSource replicaDataSource() {
        return DataSourceBuilder.create().type(HikariDataSource.class).build();
    }

    @Bean
    public ReadWriteRoutingDataSource routingDataSource(HikariDataSource primaryDataSource,
                                                        HikariDataSource replicaDataSource) {
        ReadWriteRoutingDataSource routing = new ReadWriteRoutingDataSource();
        routing.setTargetDataSources(Map.of("primary", primaryDataSource, "replica", replicaDataSource));
        routing.setDefaultTargetDataSource(primaryDataSource);
        return routing;
    }

    @Bean
    @Primary
    public DataSource dataSource(ReadWriteRoutingDataSource routingDataSource) {
        return new LazyConnectionDataSourceProxy(routingDataSource);
    }
}
```

三个容易踩的点：

- **属性名用 `jdbc-url`**：`DataSourceBuilder` 构建 `HikariDataSource` 后由 `@ConfigurationProperties` 直接绑定 Hikari 的属性，Hikari 的属性叫 `jdbcUrl`，写 `url` 会启动失败
- **必须包一层 `LazyConnectionDataSourceProxy`**：事务管理器在开启事务时就会获取连接，此时 `readOnly` 标志还没设置到线程上，路由总是落到主库；代理把真正取连接推迟到第一条 SQL 执行时
- **参数名注入**：两个 `HikariDataSource` Bean 按参数名匹配 Bean 名；自定义 `DataSource` 后 Boot 的自动配置会退出，事务管理器与 ORM 使用标了 `@Primary` 的代理

业务代码在只读方法上标注 `@Transactional(readOnly = true)` 即走副本。Spring Framework 6.1.2 起 `LazyConnectionDataSourceProxy` 自身也支持 `setReadOnlyDataSource(...)`，只有一主一从时可以省掉自定义的路由类。

---

## 小结

- HikariCP 是默认选择：固定大小的池、`connectionTimeout` 调低到几秒、`maxLifetime` 与 `keepaliveTime` 小于所有中间环节的空闲超时；`keepaliveTime` 6.2.1 起默认 2 分钟
- 池大小公式中的核数是数据库服务器的核数，结果是所有应用实例共享的总活跃连接数；先缩短连接持有时间，再考虑加大池
- Druid 在 Spring Boot 3 上要用 `druid-spring-boot-3-starter`；监控页生产环境关闭或用强口令 + IP 白名单保护，`remove-abandoned` 只在排查时开启
- PostgreSQL 每连接一个进程，实例多时前置 PgBouncer `transaction` 模式；1.21 起配置 `max_prepared_statements` 支持协议级预编译语句
- 泄漏用 `leakDetectionThreshold` 定位借出堆栈；读写分离路由要配合 `LazyConnectionDataSourceProxy`，属性名用 `jdbc-url`

## 参考资料

- HikariCP：[https://github.com/brettwooldridge/HikariCP](https://github.com/brettwooldridge/HikariCP)
- HikariCP About Pool Sizing：[https://github.com/brettwooldridge/HikariCP/wiki/About-Pool-Sizing](https://github.com/brettwooldridge/HikariCP/wiki/About-Pool-Sizing)
- HikariCP 变更记录：[https://github.com/brettwooldridge/HikariCP/blob/dev/CHANGES](https://github.com/brettwooldridge/HikariCP/blob/dev/CHANGES)
- Druid：[https://github.com/alibaba/druid](https://github.com/alibaba/druid)
- PgBouncer 配置：[https://www.pgbouncer.org/config.html](https://www.pgbouncer.org/config.html)
- PgBouncer 功能与池模式限制：[https://www.pgbouncer.org/features.html](https://www.pgbouncer.org/features.html)

> 下一篇：[mysql-binlog-connector-java 原理](../6_reference/0_binlog_connector_source) —— 从协议交互、事件反序列化、GTID 位点与保活重连理解这个嵌入式 CDC 库。
