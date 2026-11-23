---
description: SQLite 与 WAL、网关本地缓冲、H2 测试替身的利弊、DuckDB 查文件与 Appender、选型与常见坑
---

# 嵌入式数据库：SQLite、H2 与 DuckDB

> 前置阅读：[键值存储：RocksDB、TiKV 与 etcd](./1_kv_store)

嵌入式数据库以库的形式链接进进程，无需单独部署服务，没有网络开销也没有高可用。本篇讲 SQLite、H2、DuckDB 的定位、Java 用法和选型，基线为 SQLite 3、DuckDB 2。

---

## 一、SQLite

SQLite 是一个 C 库实现的完整 SQL 数据库，**整个库就是一个文件**，无需服务进程，是世界上部署量最大的数据库（每部手机、每个浏览器里都有）。

- **WAL 模式**：`PRAGMA journal_mode=WAL;` 后写入追加到 `-wal` 文件，读不阻塞写、写不阻塞读；但**同一时刻只能有一个写事务**，并发写会拿到 `SQLITE_BUSY`，需要设 `PRAGMA busy_timeout`
- **适用**：桌面 / 移动客户端本地存储、边缘网关与 IoT 设备上的缓冲库（断网时先写本地、恢复后上报）、单机小工具、只读数据分发（一个文件就是一份数据集）
- **不适用**：多台机器共享（不要把库文件放在 NFS 上）、高并发写入的 Web 后端
- **Java**：`org.xerial:sqlite-jdbc`，PRAGMA 可以直接写在连接串上，如 `jdbc:sqlite:/data/app.db?journal_mode=WAL&busy_timeout=5000`

边缘网关断网时先把上报写进本地 SQLite、恢复后按批补发，是最典型的用法。SQLite 只有一个写者，所以写操作收敛到同一个对象里串行执行：

```java
/**
 * 网关本地缓冲：断网时先落 SQLite，网络恢复后按批取出上报，上报成功再删除。
 * 所有方法加 synchronized，保证同一时刻只有一个写者，避免 SQLITE_BUSY。
 */
public class LocalBuffer implements AutoCloseable {

    private final Connection conn;

    public LocalBuffer(String path) throws SQLException {
        // WAL：读写互不阻塞；busy_timeout：拿不到写锁时最多等 5 秒，而不是立刻报错
        conn = DriverManager.getConnection("jdbc:sqlite:" + path + "?journal_mode=WAL&busy_timeout=5000");
        try (Statement st = conn.createStatement()) {
            st.execute("""
                    CREATE TABLE IF NOT EXISTS pending (
                        id         INTEGER PRIMARY KEY AUTOINCREMENT,
                        topic      TEXT    NOT NULL,
                        payload    TEXT    NOT NULL,
                        created_at INTEGER NOT NULL
                    )""");
        }
    }

    /** 上报失败时调用：先存下来 */
    public synchronized void save(String topic, String payload) throws SQLException {
        try (PreparedStatement ps = conn.prepareStatement(
                "INSERT INTO pending (topic, payload, created_at) VALUES (?, ?, ?)")) {
            ps.setString(1, topic);
            ps.setString(2, payload);
            ps.setLong(3, System.currentTimeMillis());
            ps.executeUpdate();
        }
    }

    /** 网络恢复后按 id 顺序取一批，保证补发顺序与产生顺序一致 */
    public synchronized List<Pending> peek(int limit) throws SQLException {
        try (PreparedStatement ps = conn.prepareStatement(
                "SELECT id, topic, payload FROM pending ORDER BY id LIMIT ?")) {
            ps.setInt(1, limit);
            List<Pending> rows = new ArrayList<>();
            try (ResultSet rs = ps.executeQuery()) {
                while (rs.next()) {
                    rows.add(new Pending(rs.getLong("id"), rs.getString("topic"), rs.getString("payload")));
                }
            }
            return rows;
        }
    }

    /** 这一批上报成功后删除；中途失败就不删，下次重发（平台侧按消息 id 去重） */
    public synchronized void ack(long maxId) throws SQLException {
        try (PreparedStatement ps = conn.prepareStatement("DELETE FROM pending WHERE id <= ?")) {
            ps.setLong(1, maxId);
            ps.executeUpdate();
        }
    }

    @Override
    public synchronized void close() throws SQLException {
        conn.close();
    }

    public record Pending(long id, String topic, String payload) {
    }
}
```

先删后报会丢数据，所以顺序是「取出 → 上报成功 → 删除」，重发带来的重复交给平台侧按消息 id 去重。网关整体的断网续传与接入层主备见 [可靠上报与接入层主备](/iot/4_practice/3_reliable_uplink)。

---

## 二、H2：Java 测试替身的利弊

H2 是纯 Java 的嵌入式数据库，支持内存模式（`jdbc:h2:mem:testdb`）和文件模式，常被拿来在单元测试里代替 MySQL / PostgreSQL。

| 利 | 弊 |
|------|------|
| 不需要 Docker，毫秒级启动 | 方言、函数、锁和索引行为与生产库不同 |
| Spring Boot 自动配置，零成本接入 | 用了 `jsonb`、部分索引、`SKIP LOCKED` 等特性就测不了 |
| 适合纯 JPA 映射、简单 CRUD 的快速反馈 | 测试通过不代表生产能跑，容易「测试绿、上线红」 |

兼容模式的坑：

- `MODE=MySQL` / `MODE=PostgreSQL` 只是**部分兼容**语法，不会模拟目标库的执行计划、隔离级别、锁和错误码；PostgreSQL 模式通常还要加 `DATABASE_TO_LOWER=TRUE`，否则大小写不一致
- 从 1.4 升到 2.x 时关键字变多，`VALUE`、`USER` 等列名会直接报错，要加 `NON_KEYWORDS=VALUE,USER`；2.x 的文件格式与 1.4 不兼容，文件库需要导出再导入
- 为了让 H2 通过而在 Flyway 里维护两套 SQL，等于在测一个生产不存在的数据库

**何时改用 Testcontainers**：一旦 SQL 用到目标库的特有语法、要测锁和事务行为，或者团队开始为 H2 改写 SQL，就该换成真实数据库容器。理由与做法见 [集成测试](/testing/3_integration_test#二、依赖怎么替代-三种方式) 和 [Testcontainers](/testing/5_testcontainers#一、为什么用真实容器)。

---

## 三、DuckDB：进程内 OLAP

DuckDB 常被称为「分析版的 SQLite」：同样是嵌入式、单文件，但采用列式存储和向量化执行，面向聚合分析而非事务。

- 不用导入就能**直接查文件**：`SELECT city, count(*) FROM read_parquet('logs/*.parquet') GROUP BY city`，CSV、JSON 同理，装上 `httpfs` 扩展后还能直接读 S3
- 适用：单机数据分析、ETL 中间处理、在服务里对导出的 Parquet / CSV 做临时统计、替代「为了跑几条报表 SQL 而搭一个 ClickHouse」
- 限制：同一库文件只允许一个进程写；不是高并发 OLTP，也不替代分布式 OLAP（ClickHouse、Doris 见 [Doris 与 StarRocks](./7_doris_starrocks)）

### 1、在 Java 里打开

依赖 `org.duckdb:duckdb_jdbc`（当前为 2.x），之后就是普通 JDBC。连接串决定库在哪里：

| 连接串 | 含义 |
|------|------|
| `jdbc:duckdb:` | 内存库，只属于这一个连接，连接关闭数据就没了 |
| `jdbc:duckdb:memory:report` | 具名内存库，同一进程里的其他连接可以共用 |
| `jdbc:duckdb:/data/report.duckdb` | 文件库，持久化 |

内存和线程默认用满整机（内存上限是物理内存的 80%，线程数等于 CPU 核数），嵌在业务服务里时要压下来，通过连接属性传入；多个进程同时读同一个库文件时，用只读方式打开：

```java
Properties props = new Properties();
props.setProperty("memory_limit", "2GB"); // 和业务进程共用一台机器，别让统计查询吃光内存
props.setProperty("threads", "4");
// props.setProperty("duckdb.read_only", "true"); // 其他进程只读打开同一个库文件时
Connection conn = DriverManager.getConnection("jdbc:duckdb:", props);
```

### 2、直接统计导出文件

对导出的 Parquet 做一次性统计，不建表也不导入：

```java
/**
 * 统计某天导出的订单 Parquet：按城市汇总订单数和金额。
 * dir 来自服务配置，不要拼接用户输入的路径。
 */
public List<CityStat> statByCity(String dir) throws SQLException {
    String sql = "SELECT city, count(*) AS orders, sum(amount) AS gmv "
            + "FROM read_parquet('" + dir + "/*.parquet') "
            + "GROUP BY city ORDER BY gmv DESC";
    Properties props = new Properties();
    props.setProperty("memory_limit", "2GB");
    try (Connection conn = DriverManager.getConnection("jdbc:duckdb:", props);
         Statement st = conn.createStatement();
         ResultSet rs = st.executeQuery(sql)) {
        List<CityStat> result = new ArrayList<>();
        while (rs.next()) {
            result.add(new CityStat(rs.getString("city"), rs.getLong("orders"), rs.getBigDecimal("gmv")));
        }
        return result;
    }
}
```

### 3、批量写入用 Appender

往 DuckDB 表里批量写，逐条 `INSERT` 很慢，用 Appender 按行追加，关闭时把剩余的行一次写入：

```java
try (DuckDBConnection conn = (DuckDBConnection) DriverManager.getConnection("jdbc:duckdb:/data/report.duckdb")) {
    try (Statement st = conn.createStatement()) {
        st.execute("CREATE TABLE IF NOT EXISTS order_fact (order_id BIGINT, city VARCHAR, amount DOUBLE)");
    }
    try (var appender = conn.createAppender(DuckDBConnection.DEFAULT_SCHEMA, "order_fact")) {
        for (OrderRow o : rows) {
            appender.beginRow();
            appender.append(o.orderId());
            appender.append(o.city());
            appender.append(o.amount());
            appender.endRow();
        }
    } // close 时写入剩余的行
}
```

---

## 四、选型

| 场景 | 推荐 | 理由 |
|------|------|------|
| 客户端、边缘设备、IoT 网关的本地库 | SQLite | 单文件、零运维、SQL 能力完整 |
| 单机分析 Parquet / CSV | DuckDB | 进程内列式引擎，直接查文件 |
| 数据库相关的自动化测试 | Testcontainers 真实库 | 行为与生产一致；H2 只留给不涉及方言的极简场景 |

缓存、进程内大量 KV、分布式 KV 与元数据存储的选型见 [键值存储：RocksDB、TiKV 与 etcd](./1_kv_store#五、选型)。

---

## 五、常见坑

| 坑 | 现象 | 对策 |
|------|------|------|
| SQLite 多线程并发写 | 频繁 `SQLITE_BUSY` / `database is locked` | 开 WAL、设 `busy_timeout`，写入收敛到单线程或队列 |
| 本地缓冲先删后报 | 上报失败时数据已经删了 | 顺序固定为取出 → 上报成功 → 删除，重复交给平台去重 |
| DuckDB 嵌进业务服务后机器内存被吃满 | 一条大统计查询把业务进程挤到 OOM | 连接属性设 `memory_limit` 和 `threads` |
| H2 测试全绿、上线报错 | 方言、函数、锁行为不同 | 关键路径改用 Testcontainers 跑真实库 |

---

## 小结

- SQLite 整个库就是一个文件，适合客户端、边缘和 IoT 的本地库；WAL 模式下读写互不阻塞，但仍只有一个写者，并发写要设 `busy_timeout`
- 网关本地缓冲按「取出 → 上报成功 → 删除」的顺序，写操作串行，重复交给平台按消息 id 去重
- H2 启动快、接入零成本，但兼容模式只是部分兼容语法，只适合不涉及方言的极简测试，其余用 Testcontainers
- DuckDB 是进程内 OLAP，列式存储加向量化执行，能直接查 Parquet / CSV，适合单机分析，不替代分布式 OLAP
- DuckDB 嵌进服务时用连接属性压住 `memory_limit` 和 `threads`，批量写用 Appender，多进程同读一个库文件用只读方式打开

## 参考资料

- SQLite WAL 模式：[https://www.sqlite.org/wal.html](https://www.sqlite.org/wal.html)
- H2 兼容模式：[https://www.h2database.com/html/features.html#compatibility](https://www.h2database.com/html/features.html#compatibility)
- DuckDB Java JDBC：[https://duckdb.org/docs/stable/clients/java](https://duckdb.org/docs/stable/clients/java)
- DuckDB 配置项：[https://duckdb.org/docs/stable/configuration/overview](https://duckdb.org/docs/stable/configuration/overview)
- sqlite-jdbc 用法：[https://github.com/xerial/sqlite-jdbc/blob/master/USAGE.md](https://github.com/xerial/sqlite-jdbc/blob/master/USAGE.md)

> 下一篇：[MongoDB 基础](./3_mongodb_basics) —— MongoDB 定位与版本、文档建模内嵌与引用、CRUD 与操作符、索引与 ESR 规则、聚合 Pipeline
