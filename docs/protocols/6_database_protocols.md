# 数据库访问协议

> 参考：[MySQL Wire Protocol](https://dev.mysql.com/doc/dev/mysql-server/latest/PAGE_PROTOCOL.html) / [PostgreSQL Frontend/Backend Protocol](https://www.postgresql.org/docs/current/protocol.html) / [Redis RESP](https://redis.io/docs/reference/protocol-spec/)

---

## 一、JDBC 抽象层

JDBC（Java Database Connectivity）是 Java 与数据库之间的标准 API，屏蔽了底层各数据库私有协议的差异。

```
Java 应用
    ↓ java.sql.* (JDBC API)
JDBC Driver（如 mysql-connector-j、postgresql）
    ↓ 数据库私有 Wire Protocol（TCP）
数据库服务器
```

### HikariCP 连接池（推荐）

```yaml
spring:
  datasource:
    url: jdbc:mysql://localhost:3306/mydb?useSSL=true&serverTimezone=Asia/Shanghai
    username: user
    password: ${DB_PASSWORD}
    driver-class-name: com.mysql.cj.jdbc.Driver
    hikari:
      pool-name: HikariPool-Main
      maximum-pool-size: 20          # 最大连接数（CPU 核心数 * 2 + 磁盘数）
      minimum-idle: 5
      connection-timeout: 30000      # 获取连接超时（ms）
      idle-timeout: 600000           # 空闲连接回收时间（10 分钟）
      max-lifetime: 1800000          # 连接最大存活时间（30 分钟，小于数据库 wait_timeout）
      connection-test-query: SELECT 1
```

**连接数设置原则**：过大反而导致上下文切换开销，经验公式 `max-pool-size = CPU核数 × 2 + 有效磁盘数`。

---

## 二、MySQL Wire Protocol

MySQL 客户端与服务端之间使用私有二进制协议（TCP，默认 3306 端口）。

### 连接握手流程

```
Client                              Server
  │◄── Handshake Packet ────────────│  版本、capabilities、随机数
  │── HandshakeResponse (用户名、密码hash、db) ──►│
  │◄── OK / ERR Packet ─────────────│  认证结果
  │── COM_QUERY "SELECT ..." ───────►│
  │◄── ResultSet Packets ───────────│  列定义 + 行数据 + EOF
```

**关键特性**：
- 密码从不明文传输，客户端发送 `SHA2(password, nonce)` 的哈希值
- TLS 握手可在认证前插入（`STARTTLS`）
- Prepared Statement 使用 COM_STMT_PREPARE + COM_STMT_EXECUTE，避免 SQL 注入并减少解析开销

### 常见连接问题

| 报错 | 原因 | 解决 |
|------|------|------|
| `Communications link failure` | 网络中断 / 数据库重启 / 连接已被服务端关闭 | 配置连接检活（`connection-test-query`）|
| `Too many connections` | 超过 `max_connections` | 调大 `max_connections` 或减少 `maximum-pool-size` |
| `The last packet was received X ago` | 连接被服务端因 `wait_timeout` 关闭 | `max-lifetime` 设置小于 `wait_timeout` |

---

## 三、RESP（Redis 序列化协议）

Redis 使用 RESP（REdis Serialization Protocol），基于 TCP，简单高效，可读性好。

### RESP 2 数据类型

```
+OK\r\n                      简单字符串（Simple String）
-ERR unknown command\r\n     错误（Error）
:1000\r\n                    整数（Integer）
$6\r\nfoobar\r\n             批量字符串（Bulk String），$-1 表示 nil
*3\r\n$3\r\nSET\r\n$3\r\nkey\r\n$5\r\nvalue\r\n    数组（Array）
```

**一次 SET 命令的实际字节流**：

```
客户端发送：
*3\r\n$3\r\nSET\r\n$5\r\nmykey\r\n$7\r\nmyvalue\r\n

服务端响应：
+OK\r\n
```

### Pipeline（管道）

一次性发送多条命令，减少网络往返：

```java
// Jedis Pipeline
try (Pipeline pipeline = jedis.pipelined()) {
    pipeline.set("key1", "value1");
    pipeline.set("key2", "value2");
    pipeline.incr("counter");
    List<Object> results = pipeline.syncAndReturnAll();
}

// Lettuce（Spring Data Redis）
redisTemplate.executePipelined((RedisCallback<Object>) connection -> {
    for (int i = 0; i < 1000; i++) {
        connection.set(("key:" + i).getBytes(), "val".getBytes());
    }
    return null;
});
```

---

## 四、PostgreSQL 协议

PostgreSQL 同样使用私有二进制协议（TCP，默认 5432）。与 MySQL Wire Protocol 类似，但支持以下扩展：

| 特性 | 说明 |
|------|------|
| **Extended Query Protocol** | 分离 Parse/Bind/Execute，支持 PreparedStatement 和二进制传输 |
| **COPY Protocol** | 高速批量导入/导出，比 INSERT 快数倍 |
| **Logical Replication** | 基于 WAL 的逻辑复制协议，用于 CDC（如 Debezium）|
| **LISTEN/NOTIFY** | 应用层事件通知，类似轻量级发布订阅 |

```java
// COPY 批量导入（使用 pgJDBC）
CopyManager copyManager = ((PGConnection) connection).getCopyAPI();
String sql = "COPY users(id, name, email) FROM STDIN WITH (FORMAT CSV)";
copyManager.copyIn(sql, new StringReader("1,Alice,alice@example.com\n2,Bob,bob@example.com\n"));
```

---

## 五、ODBC

ODBC（Open Database Connectivity）是跨语言的数据库访问标准（C 语言接口），Java 通过 JDBC-ODBC Bridge 或直接 JDBC Driver 访问。现代 Java 后端直接使用 JDBC，ODBC 在 Java 生态中基本不用。
