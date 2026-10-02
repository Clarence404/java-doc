---
description: 驱动版本与 URL 参数、rewriteBatchedStatements、大结果集读取、超时体系、useServerPrepStmts
---

# MySQL JDBC 驱动

- 官方文档：[https://dev.mysql.com/doc/connector-j/en/](https://dev.mysql.com/doc/connector-j/en/)
- 连接池层面的配置（池大小、泄漏排查）见 [数据库连接池](../5_practice/3_connection_pool)

Connector/J 是 Java 应用与 MySQL 之间的必经组件，大量"数据库问题"其实出在驱动参数上。本篇收录生产高频的驱动层要点。

## 一、驱动版本与坐标

| | 5.1.x（旧） | 8.x（现行） |
|---|---|---|
| Maven 坐标 | `mysql:mysql-connector-java` | `com.mysql:mysql-connector-j`（8.0.31 起改名）|
| 驱动类名 | `com.mysql.jdbc.Driver` | `com.mysql.cj.jdbc.Driver` |
| SSL 默认 | 关闭 | **默认协商开启**（`sslMode=PREFERRED`）|
| 时区处理 | 依赖系统 | 必须显式指定（见下）|

> 8.x 驱动兼容 5.7 / 8.x 服务端；升级驱动不需要同步升级数据库。JDBC 4 之后 `Class.forName` 已非必需（SPI 自动加载），老代码里的手动注册可以删。

## 二、JDBC URL 关键参数

```
jdbc:mysql://host:3306/mydb?useUnicode=true&characterEncoding=utf8mb4
  &serverTimezone=Asia/Shanghai&rewriteBatchedStatements=true
  &connectTimeout=3000&socketTimeout=60000
```

| 参数 | 建议值 | 说明 |
|------|--------|------|
| `serverTimezone` | `Asia/Shanghai` | 8.x 不设可能报错或时间偏移 8 小时；8.0.23+ 新名 `connectionTimeZone` |
| `characterEncoding` | `utf8mb4` | 配合库表字符集，防 emoji 乱码（见 [避坑指南](../1_mysql/3_fallible_point)）|
| `rewriteBatchedStatements` | `true` | **不开这个，JDBC batch 是假批量**（见第三节）|
| `connectTimeout` | 3000 | 建连超时（毫秒），默认 0 = 无限等 |
| `socketTimeout` | 按业务 | 单次读超时，兜底防 SQL 挂死连接（见第五节）|
| `sslMode` | 内网 `DISABLED` / 公网 `VERIFY_CA` | 内网关掉省 5%~10% 开销 |
| `allowPublicKeyRetrieval` | 内网 `true` | 关 SSL 后 `caching_sha2_password` 认证需要它 |
| `cachePrepStmts` + `prepStmtCacheSize=250` + `prepStmtCacheSqlLimit=2048` | `true` | 预编译语句缓存，HikariCP 官方推荐三件套 |
| `autoReconnect` | **永远不要用** | 半路重连会吞掉事务状态，官方已不推荐；断线交给连接池处理 |

## 三、批量写入的真相：rewriteBatchedStatements

```java
// 代码写了 addBatch/executeBatch，不代表真的批量了
try (PreparedStatement ps = conn.prepareStatement(
        "INSERT INTO t(name, age) VALUES (?, ?)")) {
    for (User u : users) {
        ps.setString(1, u.name());
        ps.setInt(2, u.age());
        ps.addBatch();
    }
    ps.executeBatch();
}
```

- **默认（false）**：驱动把 batch 拆成 N 条独立 INSERT 逐条发送——网络往返一次没省
- **`rewriteBatchedStatements=true`**：驱动改写为 `INSERT INTO t VALUES (...),(...),(...)` 多值语句，一次往返，**实测快 10~50 倍**
- 注意：改写后单条报错定位变难（整批一起失败）；语句总长受 `max_allowed_packet` 限制，超大批量要分批

> MyBatis 的 `ExecutorType.BATCH`、JPA 的 `hibernate.jdbc.batch_size` 同样依赖这个 URL 参数才有真批量。

## 四、大结果集三种读取模式

默认模式下驱动会把**整个结果集读进内存**——百万行导出直接 OOM。三种模式：

| 模式 | 开启方式 | 特点 |
|------|---------|------|
| 全量读取（默认）| — | 快，但内存 = 结果集大小 |
| **流式读取（Streaming）** | `stmt.setFetchSize(Integer.MIN_VALUE)` | 逐行从网络流读取，内存 O(1)；**读完前该连接不能发其他 SQL** |
| 游标读取（Cursor Fetch）| URL 加 `useCursorFetch=true` + `setFetchSize(1000)` | 服务端游标分批取，行为最接近直觉；服务端有临时资源开销 |

```java
// 流式读取：大表导出的标准写法
try (PreparedStatement ps = conn.prepareStatement(sql,
        ResultSet.TYPE_FORWARD_ONLY, ResultSet.CONCUR_READ_ONLY)) {
    ps.setFetchSize(Integer.MIN_VALUE);
    try (ResultSet rs = ps.executeQuery()) {
        while (rs.next()) { export(rs); }
    }
}
```

> MyBatis 场景对应 `@Options(fetchSize = Integer.MIN_VALUE)` + `ResultHandler` 逐行处理。

## 五、超时体系：四层各管一段

超时配置分散在四层，少配任何一层都可能出现"连接挂死"或"超时不生效"：

| 层 | 参数 | 管什么 |
|----|------|--------|
| 驱动·建连 | `connectTimeout` | TCP 握手 + 认证阶段 |
| 驱动·读写 | `socketTimeout` | 单次网络读等待的兜底（服务端假死时救命）|
| JDBC 语句 | `Statement.setQueryTimeout()` / MyBatis `defaultStatementTimeout` | 单条 SQL 执行时长（驱动另起线程发 KILL QUERY）|
| 连接池 | HikariCP `connectionTimeout` / `maxLifetime` | 借连接等待 / 连接寿命 |

**两条配合规则**：

1. `socketTimeout` 必须 **大于最慢的正常 SQL**（否则慢查询被误杀），又不能不设（否则网络分区时连接永久挂死）
2. HikariCP `maxLifetime` 必须 **小于 MySQL `wait_timeout`**（默认 8 小时），否则池里躺着已被服务端断掉的死连接

## 六、预编译的冷知识：useServerPrepStmts

```
# 默认 false：所谓 PreparedStatement 其实是"客户端预编译"
# ——驱动在客户端做参数转义后拼成完整 SQL 发送（防注入依然有效）
jdbc:mysql://host:3306/db?useServerPrepStmts=true&cachePrepStmts=true
```

- 默认（客户端预编译）：每次发完整 SQL 文本，服务端每次都要硬解析
- `useServerPrepStmts=true`：真正走 MySQL 协议的 `COM_STMT_PREPARE/EXECUTE`，同语句复用服务端解析结果；**必须配合 `cachePrepStmts=true`**，否则每次 prepare/close 反而多一次往返

> 防 SQL 注入与这个参数无关——客户端预编译的参数转义同样安全；它影响的是解析开销与执行计划复用。

## 七、相关文档

- [数据库连接池（HikariCP / Druid）](../5_practice/3_connection_pool)：池大小公式、泄漏排查
- [MySQL 避坑指南](../1_mysql/3_fallible_point)：字符集、时区的服务端侧配置
- [EXPLAIN 与 SQL 优化](../1_mysql/7_topic_explain)：慢 SQL 的定位（超时只是兜底，根治靠优化）
