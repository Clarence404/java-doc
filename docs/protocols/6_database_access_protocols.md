# 数据库访问协议

这些协议用于数据库的远程访问和数据交互。

## 官方规范入口

| 协议 / API | 官方 / 原始规范 |
|------------|----------------|
| JDBC | [Java SQL Package](https://docs.oracle.com/javase/8/docs/api/java/sql/package-summary.html) |
| ODBC | [Microsoft ODBC Programmer's Reference](https://learn.microsoft.com/en-us/sql/odbc/reference/odbc-programmer-s-reference) |
| MySQL Client/Server Protocol | [MySQL Internals Manual](https://dev.mysql.com/doc/dev/mysql-server/latest/PAGE_PROTOCOL.html) |
| PostgreSQL Frontend/Backend Protocol | [PostgreSQL Protocol](https://www.postgresql.org/docs/current/protocol.html) |
| Redis RESP | [Redis Serialization Protocol](https://redis.io/docs/latest/develop/reference/protocol-spec/) |

- **JDBC（Java Database Connectivity）**：Java 访问数据库的标准 API。
- **ODBC（Open Database Connectivity）**：基于 SQL 的数据库访问标准，支持跨平台访问。
- **MySQL 协议**：MySQL 服务器与客户端之间的通信协议，支持 TCP 和 Unix Socket 连接。
- **PostgreSQL 协议**：PostgreSQL 数据库的原生通信协议。
- **Redis RESP（Redis Serialization Protocol）**：Redis 使用的请求/响应协议，基于 TCP。
