---
description: Connector/J 版本、URL 参数与时区、真假批量、大结果集读取、超时体系、服务端预编译
---

# MySQL JDBC 驱动

> 前置阅读：[数据库连接池](../5_practice/3_connection_pool)

Connector/J 是 Java 应用与 MySQL 之间的必经组件，很多「数据库问题」其实出在驱动参数上。本篇讲版本选择、JDBC URL 关键参数（字符集、时区、TLS、批量、超时）、真假批量、大结果集读取模式、四层超时与服务端预编译。

---

## 一、驱动版本与坐标

| | 5.1.x | 8.0.x / 8.x | 9.x | 26.7 起 |
|---|---|---|---|---|
| 状态 | 已停止维护 | 维护期 | 2024 年 7 月起的现行版本线 | MySQL 9.7 之后改为日历版本号（年.月） |
| Maven 坐标 | `mysql:mysql-connector-java` | `com.mysql:mysql-connector-j`（8.0.31 起改名） | 同左 | 同左 |
| 驱动类 | `com.mysql.jdbc.Driver` | `com.mysql.cj.jdbc.Driver` | 同左 | 同左 |
| TLS 默认 | 不启用 | `sslMode=PREFERRED`，能协商就加密 | 同左 | 同左 |

- 连接器不再区分 LTS 与创新版，只维护一条最新版本线，版本号跟随服务器发布，且兼容所有仍在支持期内的服务器版本；26.7 的文档要求 Java 8+、服务器 MySQL 8.4 及以上，实现 JDBC 4.2
- 升级驱动不需要同步升级数据库；新项目直接用最新版本
- JDBC 4 起驱动通过 SPI 自动注册，老代码里的 `Class.forName("com.mysql.jdbc.Driver")` 可以删掉

```xml
<dependency>
  <groupId>com.mysql</groupId>
  <artifactId>mysql-connector-j</artifactId>
  <version>26.7.0</version>
</dependency>
```

---

## 二、JDBC URL 关键参数

下面是一条完整的 URL（实际是一行，这里为便于阅读折行）：

```text
jdbc:mysql://db:3306/mydb?characterEncoding=UTF-8&connectionTimeZone=Asia/Shanghai
    &sslMode=REQUIRED&rewriteBatchedStatements=true&connectTimeout=3000&socketTimeout=60000
```

| 参数 | 建议值 | 说明 |
|------|--------|------|
| `characterEncoding` | `UTF-8` | 取 Java 风格的编码名，`UTF-8` 映射到 MySQL 的 `utf8mb4`；需要指定排序规则时再加 `connectionCollation=utf8mb4_0900_ai_ci`。不要在应用里执行 `SET NAMES`，驱动感知不到 |
| `connectionTimeZone` | 与服务器会话时区一致 | 8.0.23 起的新名字，`serverTimezone` 成为它的别名，见下一小节 |
| `sslMode` | 公网或跨机房 `VERIFY_IDENTITY` / `VERIFY_CA`，内网至少 `REQUIRED` | 取代已废弃的 `useSSL` / `requireSSL` / `verifyServerCertificate` |
| `allowPublicKeyRetrieval` | 尽量不开 | 不走 TLS 时 `caching_sha2_password` 首次认证需要向服务器取 RSA 公钥，开启后中间人可以伪造公钥窃取口令；优先启用 TLS，或用 `serverRSAPublicKeyFile` 指定本地公钥 |
| `rewriteBatchedStatements` | `true` | 不开则 JDBC batch 是逐条发送，见第三节 |
| `connectTimeout` | 3000 | 建连超时（毫秒），默认 0 表示无限等待 |
| `socketTimeout` | 大于最慢的正常 SQL | 单次网络读的等待上限，见第五节 |
| `cachePrepStmts` / `prepStmtCacheSize` / `prepStmtCacheSqlLimit` | `true` / 250 / 2048 | 预编译语句缓存，HikariCP 文档推荐的组合，见第六节 |
| `autoReconnect` | 不要使用 | 中途重连会丢失事务与会话状态，断线交给连接池处理 |

### 1、时区参数

时间类型的偏移问题来自「驱动认为的会话时区」与「服务器实际的会话时区」不一致。相关的三个参数：

| 参数 | 作用 |
|------|------|
| `connectionTimeZone` | 驱动认为服务器会话处于哪个时区：`LOCAL`（与 JVM 相同）、`SERVER`（连接时向服务器查询）或具体时区名 |
| `forceConnectionTimeZoneToSession` | 为 `true` 时驱动会把会话的 `time_zone` 设为 `connectionTimeZone`，两边强制一致；副作用是 `NOW()` 等函数的结果随之改变 |
| `preserveInstants` | 为 `true` 时驱动在 JVM 时区与 `connectionTimeZone` 之间换算，保证 `Instant`、`Timestamp`、`OffsetDateTime` 表示的时间点不变 |

常用组合：

- 服务器 `time_zone` 是明确的时区（如 `+08:00`）：`connectionTimeZone=SERVER`，由驱动查询后换算
- 服务器 `time_zone=SYSTEM` 且系统时区是 `CST` 这类有歧义的缩写：`connectionTimeZone=Asia/Shanghai&forceConnectionTimeZoneToSession=true`，避免被识别成美国中部时间
- 只改参数名、不核对服务器时区，偏移问题仍然存在

业务上更稳妥的做法是统一用 UTC 存储 `TIMESTAMP`，或用 `DATETIME` + `LocalDateTime` 存「墙上时间」。Java 侧时间类型的选择见 [日期与时间](/java/17_topic_time)。

---

## 三、批量写入：rewriteBatchedStatements

```java
try (PreparedStatement ps = conn.prepareStatement("INSERT INTO t_user(name, age) VALUES (?, ?)")) {
    for (User u : users) {
        ps.setString(1, u.name());
        ps.setInt(2, u.age());
        ps.addBatch();
    }
    ps.executeBatch();
}
```

- **默认（`false`）**：驱动把 batch 拆成 N 条独立的 INSERT 逐条发送，网络往返一次也没省
- **`true`**：驱动把 INSERT 改写为 `INSERT INTO t_user(name, age) VALUES (...),(...),(...)` 多值语句，UPDATE / DELETE 则用分号拼成多语句一次发送，往返次数大幅减少，大批量写入通常快一个数量级以上
- 改写后整批作为一条语句执行，单行出错时定位变难；语句总长受服务器 `max_allowed_packet` 限制，驱动会自动拆分，但一次 batch 仍建议控制在几百到几千行

框架层面：MyBatis 的 `ExecutorType.BATCH`、Hibernate 的 `hibernate.jdbc.batch_size` 都依赖这个参数才有真正的批量。Hibernate 还有一个前提：主键使用 `GenerationType.IDENTITY`（自增）时，插入必须立即执行才能拿到 ID，**Hibernate 会静默关闭插入批处理**；需要批量插入时改用应用侧生成的主键（如雪花 ID）。

---

## 四、大结果集的三种读取模式

默认模式下驱动会把**整个结果集读进内存**，百万行导出可能直接 OOM。

| 模式 | 开启方式 | 特点 |
|------|---------|------|
| 全量读取（默认） | 无 | 快，内存占用等于结果集大小 |
| **流式读取** | `setFetchSize(Integer.MIN_VALUE)`，语句为 `TYPE_FORWARD_ONLY` + `CONCUR_READ_ONLY` | 逐行从网络读取，内存占用恒定；读完或关闭 `ResultSet` 之前，这个连接不能执行其他 SQL |
| 游标读取 | URL 加 `useCursorFetch=true`，再 `setFetchSize(1000)` | 服务端游标分批返回，期间可以在同一连接执行其他语句；服务端要物化临时结果，有额外开销 |

```java
try (PreparedStatement ps = conn.prepareStatement(sql,
        ResultSet.TYPE_FORWARD_ONLY, ResultSet.CONCUR_READ_ONLY)) {
    ps.setFetchSize(Integer.MIN_VALUE);
    try (ResultSet rs = ps.executeQuery()) {
        while (rs.next()) {
            export(rs);
        }
    }
}
```

流式读取期间连接一直被占用，处理慢会让对应的事务和锁持续很久，导出类任务应放在副本上执行。MyBatis 中对应 `@Options(fetchSize = Integer.MIN_VALUE)` 加 `ResultHandler` 或 `Cursor` 逐行处理。

---

## 五、超时体系：四层各管一段

![一次数据库调用经过的四层超时](../../assets/database/jdbc-timeout-layers.svg)

| 层 | 参数 | 管什么 |
|----|------|--------|
| 连接池 | HikariCP `connectionTimeout` / `maxLifetime` | 借连接的等待时间 / 连接寿命 |
| 驱动建连 | `connectTimeout` | TCP 握手与认证阶段 |
| JDBC 语句 | `Statement.setQueryTimeout()`、MyBatis `defaultStatementTimeout`、Spring `@Transactional(timeout)` | 单条 SQL 的执行时长，到期后驱动另开连接发送 `KILL QUERY` |
| 驱动读写 | `socketTimeout` | 每次网络读的等待上限，服务器无响应或网络分区时的兜底 |

两条配合规则：

1. `socketTimeout` 要**大于最慢的正常 SQL**，否则正常的慢查询会被误断；又不能不设，否则网络分区时线程永久挂死。`socketTimeout` 到期只是客户端关闭连接，服务器上的 SQL 可能仍在执行，需要终止 SQL 时靠 `queryTimeout`
2. HikariCP 的 `maxLifetime` 要**小于** MySQL `wait_timeout`（默认 28800 秒）以及防火墙、负载均衡的空闲超时，否则池里会留着已被断开的连接

---

## 六、服务端预编译：useServerPrepStmts

`useServerPrepStmts` 默认为 `false`：`PreparedStatement` 实际是**客户端预编译**，驱动在本地转义参数后拼出完整 SQL 文本发送，防注入同样有效。

| 模式 | 协议 | 服务器侧 |
|------|------|---------|
| 客户端预编译（默认） | 每次发送完整 SQL 文本（`COM_QUERY`） | 每次都要词法、语法解析 |
| 服务端预编译（`useServerPrepStmts=true`） | `COM_STMT_PREPARE` 一次，之后 `COM_STMT_EXECUTE` 只传参数 | 跳过重复解析，保留预处理后的语句结构 |

- MySQL **没有执行计划缓存**：服务端预编译省掉的是解析，优化器在每次执行时仍会重新优化，所以它不会带来「执行计划复用」，也不会因为复用计划导致参数敏感的问题
- 开启时**必须配合 `cachePrepStmts=true`**，否则每次 prepare 与 close 各多一次往返，反而更慢
- 服务器有 `max_prepared_stmt_count` 上限（默认 16382），连接多、语句多时要关注预编译语句数量
- 是否开启需要压测验证：短小、高频、参数化的 SQL 收益明显；SQL 形态很分散的场景收益有限

防 SQL 注入与这个参数无关，客户端预编译的参数转义同样安全。

---

## 小结

连接池层面的配置（池大小、泄漏排查）见 [数据库连接池](../5_practice/3_connection_pool)；驱动与服务器之间的握手、`COM_STMT_PREPARE` 等协议细节见 [数据库协议](/protocols/6_database_protocols)。

- 坐标是 `com.mysql:mysql-connector-j`，驱动类 `com.mysql.cj.jdbc.Driver`；连接器只有一条最新版本线，9.7 之后改为日历版本号（26.7）
- URL 用 `characterEncoding=UTF-8`（映射为 utf8mb4）、`sslMode` 取代 `useSSL`，避免 `allowPublicKeyRetrieval=true` 与 `autoReconnect`
- 时区偏移来自驱动与服务器会话时区不一致：`connectionTimeZone` 要与服务器一致，歧义时区配合 `forceConnectionTimeZoneToSession=true`
- 不开 `rewriteBatchedStatements` 的 batch 是假批量；Hibernate 在 IDENTITY 主键下不做插入批处理
- 大结果集用流式读取或游标读取，流式读取期间连接被独占
- 超时分四层：池、建连、语句、socket；`socketTimeout` 兜底网络，`queryTimeout` 才会终止服务器上的 SQL
- 服务端预编译只省解析、不复用执行计划，必须配合 `cachePrepStmts`

## 参考资料

- Connector/J 开发者指南：[https://dev.mysql.com/doc/connector-j/en/](https://dev.mysql.com/doc/connector-j/en/)
- Connector/J 配置属性：[https://dev.mysql.com/doc/connector-j/en/connector-j-reference-configuration-properties.html](https://dev.mysql.com/doc/connector-j/en/connector-j-reference-configuration-properties.html)
- 字符集与 characterEncoding：[https://dev.mysql.com/doc/connector-j/en/connector-j-reference-charsets.html](https://dev.mysql.com/doc/connector-j/en/connector-j-reference-charsets.html)
- 时间点与时区处理：[https://dev.mysql.com/doc/connector-j/en/connector-j-time-instants.html](https://dev.mysql.com/doc/connector-j/en/connector-j-time-instants.html)
- 预编译语句：[https://dev.mysql.com/doc/refman/8.4/en/sql-prepared-statements.html](https://dev.mysql.com/doc/refman/8.4/en/sql-prepared-statements.html)
- HikariCP MySQL 配置建议：[https://github.com/brettwooldridge/HikariCP/wiki/MySQL-Configuration](https://github.com/brettwooldridge/HikariCP/wiki/MySQL-Configuration)

> 返回：[数据库总览](/database/0_overview)
