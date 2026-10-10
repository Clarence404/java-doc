---
description: JDBC 分层、MySQL 握手与认证、PostgreSQL 消息格式、Redis RESP2 / RESP3
---

# 数据库协议

> 前置阅读：[TCP 与 UDP](./1_tcp_udp)、[HTTPS 与 TLS](./3_https_tls)

数据库协议都是跑在 TCP 上的私有二进制协议，Java 通过 JDBC 驱动把它们屏蔽掉。本篇讲 MySQL 握手、`caching_sha2_password` 认证与 TLS 升级，PostgreSQL 消息格式与扩展查询协议，以及 Redis RESP2 与 RESP3 的区别。

---

## 一、JDBC 与驱动

### 1、分层

![Java 访问数据库的分层](../assets/protocols/jdbc-stack.svg)

- **JDBC API**：`java.sql` / `javax.sql` 里的一组接口，业务代码和 ORM 只依赖它
- **驱动**：实现这组接口，负责建连、握手、认证、TLS、把 SQL 和参数编码成数据库认识的报文、把结果集解码回 Java 对象；MySQL 用 `mysql-connector-j`，PostgreSQL 用 `pgjdbc`
- **线路协议**：各数据库自定义，MySQL 默认 3306 端口，PostgreSQL 默认 5432 端口
- **响应式驱动**：R2DBC 驱动讲的是同一套线路协议，只是把阻塞 IO 换成了非阻塞 IO

### 2、ODBC

ODBC 是面向 C 语言的跨数据库访问标准，Windows 报表工具、BI 软件常用。Java 侧的 JDBC-ODBC Bridge 已在 Java 8 移除，现在 Java 后端一律直接用各数据库的 JDBC 驱动。

---

## 二、MySQL 协议

### 1、报文格式

MySQL 客户端与服务端之间交换的每个包（Packet）都有 4 字节包头：

| 字段 | 长度 | 说明 |
|------|------|------|
| payload_length | 3 字节 | 负载长度，小端序；单包最多 16 MB − 1，更大的负载拆成多个包 |
| sequence_id | 1 字节 | 序号，每个命令从 0 开始递增，客户端和服务端交替使用；错乱时报 `Got packets out of order` |
| payload | 可变 | 具体内容，第一个字节通常表示包类型（如 `0x00` OK、`0xFF` ERR） |

协议分两个阶段：**连接阶段**（握手、可选的 TLS 升级、认证）和**命令阶段**（发 SQL、收结果）。MySQL 8 还有一套基于 Protobuf 的 X Protocol（默认 33060 端口），只给 MySQL Shell、X DevAPI 用，JDBC 走的是这里讲的经典协议。

### 2、连接与命令流程

![MySQL 连接阶段与命令阶段](../assets/protocols/mysql-handshake.svg)

1. **服务端先说话**：TCP 建连后服务端发 Initial Handshake，带上版本号、连接 ID、能力标志（capabilities）、20 字节随机 salt 和默认认证插件名
2. **要加密就先升级 TLS**：客户端只发一个简短的 SSLRequest 包（能力标志里带 `CLIENT_SSL`），随后双方直接做 TLS 握手，之后的所有包都在 TLS 内传输；这个机制叫 SSLRequest，不是 SMTP 那种 `STARTTLS` 命令
3. **认证**：客户端发 HandshakeResponse41，包含用户名、认证插件名、用 salt 计算出的 scramble、默认库；两边插件不一致时服务端回 AuthSwitchRequest 换插件重来，插件需要多轮交互时用 AuthMoreData
4. **命令阶段**：认证成功后服务端回 OK 包；客户端发 `COM_QUERY` 等命令，服务端回结果集：列数 → N 个列定义 → M 行数据 → 结束包

结束包有版本差异：客户端和服务端协商了 `CLIENT_DEPRECATE_EOF`（MySQL 5.7.5 引入）时用 OK 包结尾，否则用 EOF 包。Connector/J 8.x 会自动协商。

### 3、认证插件

| 插件 | 状态 | 认证方式 |
|------|------|---------|
| `mysql_native_password` | 8.0.34 废弃，8.4 默认不加载，9.0 移除 | 基于 SHA-1 的 scramble，口令不明文传输，但服务端存的哈希一旦泄露可以直接冒充登录 |
| `caching_sha2_password` | 8.0 起的默认插件 | 基于 SHA-256 的 scramble，服务端在内存里缓存认证过的账号 |

`caching_sha2_password` 分两条路径：

- **快速认证**：服务端缓存里已有该账号（之前成功认证过），客户端发的 SHA-256 scramble 校验通过即可，口令不出现在网络上
- **完整认证**：缓存未命中（服务重启后第一次、刚改过密码等）时服务端要拿到口令本身：连接已是 TLS（或 Unix socket 等本机安全通道）时客户端直接发口令明文；没有 TLS 时客户端用服务端的 RSA 公钥加密口令再发

**常见坑**：不开 TLS 时，完整认证需要驱动先拿到 RSA 公钥，Connector/J 报 `Public Key Retrieval is not allowed`。正确做法是开启 TLS（`sslMode=REQUIRED` 或更严格），或用 `serverRSAPublicKeyFile` 指定本地公钥；`allowPublicKeyRetrieval=true` 会让中间人有机会伪造公钥。`sslMode` 自 Connector/J 8.0.13 起取代了已废弃的 `useSSL`，参数细节见 [MySQL JDBC 驱动](/database/6_reference/2_jdbc_driver)。

### 4、预编译语句

| 模式 | 线上报文 | 说明 |
|------|---------|------|
| 客户端预编译（Connector/J 默认，`useServerPrepStmts=false`） | `COM_QUERY`，参数已被驱动转义后拼进 SQL 文本 | 防注入同样有效，少一次网络往返 |
| 服务端预编译（`useServerPrepStmts=true`） | `COM_STMT_PREPARE` 一次，之后 `COM_STMT_EXECUTE` 只传参数 | 结果集走二进制协议，省去重复解析 |

在 MySQL 服务端看 `Com_stmt_prepare` 计数是否增长，可以确认驱动走的是哪种模式。

---

## 三、PostgreSQL 协议

### 1、消息格式

PostgreSQL 的前后端协议（当前为 3.x 版本）以「消息」为单位：

| 字段 | 长度 | 说明 |
|------|------|------|
| 类型 | 1 字节 | ASCII 字符，如 `Q` 简单查询、`P` Parse、`T` 行描述、`D` 数据行、`Z` ReadyForQuery |
| 长度 | 4 字节 | 大端序，包含长度字段自身，不含类型字节 |
| 内容 | 可变 | 按消息类型解析 |

只有连接时的第一条 StartupMessage（以及 SSLRequest、CancelRequest）没有类型字节，开头直接是长度和协议版本号。PostgreSQL 18 引入了协议 3.2，主要变化是取消查询用的密钥从 4 字节改为变长；为了兼容老服务端和中间件，libpq 默认仍使用 3.0。

### 2、建连与认证

1. **TLS**：客户端先发 SSLRequest，服务端回一个字节 `S`（同意，接着做 TLS 握手）或 `N`（拒绝）；PostgreSQL 17 起也支持跳过这一步直接做 TLS 握手（客户端参数 `sslnegotiation=direct`）
2. **启动**：客户端发 StartupMessage，带用户名、数据库名等参数
3. **认证**：服务端按 `pg_hba.conf` 选择方式；PostgreSQL 14 起 `password_encryption` 默认是 `scram-sha-256`，走 SASL 多轮交互，口令不在网络上传输，服务端也不保存可直接复用的口令哈希
4. **就绪**：服务端发一组 ParameterStatus（时区、编码等）、BackendKeyData（取消查询用的进程号和密钥），最后发 ReadyForQuery（`Z`），连接进入空闲状态

### 3、简单查询与扩展查询

| 方式 | 客户端发送 | 服务端返回 | 特点 |
|------|-----------|-----------|------|
| 简单查询 | `Q`（SQL 文本） | `T` 行描述 → 若干 `D` 数据行 → `C` CommandComplete → `Z` | 一个消息可以包含多条 SQL，参数只能拼在文本里 |
| 扩展查询 | `P` Parse → `B` Bind → `D` Describe → `E` Execute → `S` Sync | 对应的确认消息、数据行，最后 `Z` | 解析与执行分离，参数单独传输，支持二进制格式和具名语句复用 |

pgjdbc 默认用扩展查询协议，同一条 `PreparedStatement` 执行达到 `prepareThreshold`（默认 5）次后切换为具名的服务端预编译语句。经过 PgBouncer 事务模式时这一点容易出问题，见 [数据库连接池](/database/5_practice/3_connection_pool)。

### 4、其他子协议

| 子协议 | 用途 |
|--------|------|
| COPY | 批量导入导出，比逐条 `INSERT` 快得多；pgjdbc 通过 `CopyManager` 使用 |
| 逻辑复制 | 基于 WAL 解码的变更流，Debezium 等 CDC 工具依赖它，见 [CDC 工具](/database/5_practice/0_cdc_tools) |
| LISTEN / NOTIFY | 服务端主动推送 `A` 消息（NotificationResponse），可用于轻量的变更通知 |
| CancelRequest | 新开一条连接，带上 BackendKeyData 里的进程号和密钥，取消正在执行的查询；`Statement.cancel()` 就是这么实现的 |

```java
// COPY 批量导入：连接需先 unwrap 成 pgjdbc 的 PGConnection
try (Connection conn = dataSource.getConnection()) {
    CopyManager copy = conn.unwrap(PGConnection.class).getCopyAPI();
    long rows = copy.copyIn(
            "COPY users(id, name, email) FROM STDIN WITH (FORMAT csv)",
            new StringReader("1,Alice,alice@example.com\n2,Bob,bob@example.com\n"));
}
```

经连接池拿到的是代理连接，必须 `unwrap`，直接强转会抛 `ClassCastException`。

---

## 四、Redis RESP

### 1、RESP2

RESP（REdis Serialization Protocol）是文本协议，每种类型用首字符区分，以 `\r\n` 结尾：

| 首字符 | 类型 | 示例 |
|--------|------|------|
| `+` | 简单字符串 | `+OK\r\n` |
| `-` | 错误 | `-ERR unknown command\r\n` |
| `:` | 整数 | `:1000\r\n` |
| `$` | 批量字符串（二进制安全） | `$6\r\nfoobar\r\n`，`$-1\r\n` 表示 nil |
| `*` | 数组 | `*2\r\n$3\r\nGET\r\n$3\r\nkey\r\n`，`*-1\r\n` 表示 nil 数组 |

客户端发的命令统一是「批量字符串组成的数组」，一次 `SET mykey myvalue` 的实际字节流：

```text
客户端 → *3\r\n$3\r\nSET\r\n$5\r\nmykey\r\n$7\r\nmyvalue\r\n
服务端 → +OK\r\n
```

请求和响应严格按顺序一一对应，所以客户端可以不等响应连续发多条命令，这就是 Pipeline 在协议层面的样子；用法见 [Redis 核心原理](/cache/2_redis_core)。

### 2、RESP3

Redis 6.0 引入 RESP3，连接默认仍是 RESP2，客户端发 `HELLO 3` 后切换。新增的类型让客户端不用再猜返回值的含义：

| 首字符 | 类型 | 解决的问题 |
|--------|------|-----------|
| `_` | Null | 统一的空值，不再区分 nil 字符串和 nil 数组 |
| `#` | 布尔 | `#t` / `#f` |
| `,` | 双精度浮点 | 如 `ZSCORE` 直接返回数字，不用从字符串转 |
| `(` | 大整数 | 超出 64 位的整数 |
| `!` | 批量错误 | 二进制安全的错误信息 |
| `=` | 带格式的字符串 | 如 `txt:` 前缀的文本 |
| `%` | Map | `HGETALL`、`CONFIG GET` 直接返回键值对，不再是扁平数组 |
| `~` | Set | `SMEMBERS` 等返回集合语义 |
| `>` | Push | 服务端主动推送，订阅消息、客户端缓存失效通知可以和普通命令共用一条连接 |

- **客户端缓存**：开启 `CLIENT TRACKING` 后，失效通知在 RESP3 下作为 Push 消息直接发到当前连接；RESP2 下要另开一条连接订阅 `__redis__:invalidate` 频道并用 `REDIRECT` 转发
- **Java 客户端**：Lettuce 6 起建连时自动用 `HELLO` 协商 RESP3，服务端不支持时回落到 RESP2；Jedis 需要显式指定协议版本

---

## 小结

- JDBC 是接口，驱动把调用翻译成各数据库私有的线路协议，MySQL 走 3306、PostgreSQL 走 5432，都跑在 TCP 上
- MySQL 每个包有 3 字节长度 + 1 字节序号；连接阶段是服务端先发 Handshake，要加密就由客户端发 SSLRequest 再做 TLS 握手，然后认证
- `caching_sha2_password` 是 8.0 起的默认插件，`mysql_native_password` 已在 9.0 移除；完整认证要么走 TLS 发明文，要么用 RSA 公钥加密，正确做法是开 TLS 而不是 `allowPublicKeyRetrieval=true`
- Connector/J 默认客户端预编译，线上发的还是 `COM_QUERY`；结果集结尾在协商 `CLIENT_DEPRECATE_EOF` 后是 OK 包
- PostgreSQL 消息是 1 字节类型 + 4 字节长度；认证默认 SCRAM-SHA-256，pgjdbc 默认用 Parse / Bind / Execute 的扩展查询协议
- RESP2 只有五种类型，RESP3 通过 `HELLO 3` 开启，增加了 Map、Set、Double、Push 等类型，客户端缓存的失效通知依赖 Push
- 连接池参数、池大小估算、`Communications link failure` 排查见 [数据库连接池](/database/5_practice/3_connection_pool)
- Connector/J 的 URL 参数、批量写入、超时体系见 [MySQL JDBC 驱动](/database/6_reference/2_jdbc_driver)
- Redis Pipeline、事务、Lua 的用法见 [Redis 核心原理](/cache/2_redis_core)

## 参考资料

- MySQL Client/Server Protocol：[https://dev.mysql.com/doc/dev/mysql-server/latest/PAGE_PROTOCOL.html](https://dev.mysql.com/doc/dev/mysql-server/latest/PAGE_PROTOCOL.html)
- MySQL Caching SHA-2 Pluggable Authentication：[https://dev.mysql.com/doc/refman/8.4/en/caching-sha2-pluggable-authentication.html](https://dev.mysql.com/doc/refman/8.4/en/caching-sha2-pluggable-authentication.html)
- MySQL 9.0 Release Notes（移除 mysql_native_password）：[https://dev.mysql.com/doc/relnotes/mysql/9.0/en/news-9-0-0.html](https://dev.mysql.com/doc/relnotes/mysql/9.0/en/news-9-0-0.html)
- Connector/J Security 配置：[https://dev.mysql.com/doc/connector-j/en/connector-j-connp-props-security.html](https://dev.mysql.com/doc/connector-j/en/connector-j-connp-props-security.html)
- PostgreSQL Frontend/Backend Protocol：[https://www.postgresql.org/docs/current/protocol.html](https://www.postgresql.org/docs/current/protocol.html)
- pgjdbc 连接参数：[https://jdbc.postgresql.org/documentation/use/](https://jdbc.postgresql.org/documentation/use/)
- Redis serialization protocol specification：[https://redis.io/docs/latest/develop/reference/protocol-spec/](https://redis.io/docs/latest/develop/reference/protocol-spec/)
- Redis client-side caching：[https://redis.io/docs/latest/develop/reference/client-side-caching/](https://redis.io/docs/latest/develop/reference/client-side-caching/)

> 下一篇：[邮件协议](./7_email_protocols) —— SMTP / IMAP / POP3、MIME 结构、SPF / DKIM / DMARC、Spring Boot 收发邮件。
