---
description: 视图、存储过程、账号与传输安全、基础配置、本组文章导读
---

# MySQL 基础

> 前置阅读：[数据库总览](../0_overview)

MySQL 是最常用的开源关系型数据库，本篇讲视图与存储过程的边界、账号权限与 TLS 配置，并给出本组其余文章的导读；建表时的范式取舍在 [MySQL 表设计规范](./7_table_design)。以 MySQL 8.4 LTS 为基线，9.7 LTS 的行为相同时不再单独说明。

---

## 一、视图

视图是保存下来的一条查询，**不存储数据**，每次访问时执行底层 SQL。MySQL 没有物化视图，需要预计算结果时用汇总表加定时任务或 CDC 维护。

```sql
CREATE VIEW v_active_orders AS
SELECT o.id, o.user_id, u.name AS user_name, o.amount, o.status
FROM orders o
JOIN users u ON o.user_id = u.id
WHERE o.status <> 'cancelled';

SELECT * FROM v_active_orders WHERE user_id = 123;

CREATE OR REPLACE VIEW v_active_orders AS
SELECT o.id, o.user_id, o.amount, o.status
FROM orders o
WHERE o.status <> 'cancelled'
WITH CHECK OPTION;   -- 通过视图写入的行必须满足 WHERE 条件

DROP VIEW IF EXISTS v_active_orders;
```

视图的用途和限制：

| 维度 | 说明 |
|------|------|
| 用途 | 封装复杂 JOIN；只授权视图来隐藏敏感列；底层表结构调整时保持对外查询不变 |
| 执行算法 | `MERGE` 把视图展开进外层查询，能用上底层索引；含聚合、`DISTINCT`、`UNION`、`LIMIT` 等时只能用 `TEMPTABLE`，先物化成临时表再查，外层条件最多部分下推（8.0.22 起），通常比 `MERGE` 慢 |
| 可更新性 | 单表、无聚合 / `DISTINCT` / `GROUP BY` / `UNION` 的简单视图可以 `INSERT` / `UPDATE`；`WITH CHECK OPTION` 防止写出视图范围 |
| 权限 | 默认 `SQL SECURITY DEFINER`，以创建者权限执行；定义者账号被删除后视图不可用，迁移时注意 `DEFINER` |

---

## 二、存储过程

存储过程是保存在服务端、按名称调用的一段 SQL 程序。常说的「存储过程是预编译的、所以更快」并不成立：MySQL 在会话第一次调用时解析存储过程，结果只缓存在**当前会话**里，不跨会话复用，里面的语句每次执行仍要经过优化器。它真正的性能收益只有一点：多条语句在服务端一次执行完，**省掉网络往返**。

```sql
DELIMITER //
CREATE PROCEDURE batch_expire_orders(IN days_ago INT, OUT affected_rows INT)
BEGIN
  -- 出错时回滚并把原始错误抛给调用方，而不是用 CONTINUE HANDLER 吞掉
  DECLARE EXIT HANDLER FOR SQLEXCEPTION
  BEGIN
    ROLLBACK;
    RESIGNAL;
  END;

  START TRANSACTION;

  UPDATE orders
     SET status = 'expired'
   WHERE status = 'pending'
     AND created_at < NOW() - INTERVAL days_ago DAY;

  SET affected_rows = ROW_COUNT();   -- 紧跟在 UPDATE 后读取，中间不要插入其他语句

  COMMIT;
END //
DELIMITER ;

CALL batch_expire_orders(30, @cnt);
SELECT @cnt AS affected;

SHOW CREATE PROCEDURE batch_expire_orders;
DROP PROCEDURE IF EXISTS batch_expire_orders;
```

需要错误详情时，在 handler 里用 `GET DIAGNOSTICS CONDITION 1 @code = MYSQL_ERRNO, @msg = MESSAGE_TEXT;` 取出后记录。

| 维度 | 存储过程 | 应用层代码 |
|------|---------|-----------|
| 性能 | 多条语句一次往返完成 | 每条 SQL 一次往返，可用批量与多语句弥补 |
| 维护 | 难以做版本管理、Code Review 和单元测试 | 代码仓库管理，测试与灰度方便 |
| 可移植性 | 与数据库方言强绑定 | 换库成本低 |
| 扩展性 | 计算压在数据库上，数据库最难扩容 | 应用层可水平扩展 |
| 适用场景 | DBA 批量修数、数据迁移、定时清理 | 业务逻辑 |

互联网业务通常不把核心逻辑放进存储过程；数据库只负责存储和约束，逻辑留在应用层。

---

## 三、账号与安全

SQL 注入的防护靠应用层参数绑定（`PreparedStatement`、MyBatis 的 `#{}`），见 [常见漏洞与防护](/security/8_vulnerabilities)；敏感字段加密与脱敏见 [数据安全](/security/7_data_security)。本节只讲 MySQL 服务端自己的配置。

### 1、认证插件

- 8.0 起默认认证插件是 `caching_sha2_password`；8.4 默认**不加载** `mysql_native_password`，9.0 起该插件被移除
- 8.4 移除了 `default_authentication_plugin`，改用 `authentication_policy` 指定默认插件
- 使用 `caching_sha2_password` 时，客户端首次认证需要 TLS 连接，或者在非 TLS 连接上用 RSA 公钥交换密码；Connector/J 在非 TLS 下要配 `allowPublicKeyRetrieval=true`，生产环境应直接走 TLS

### 2、最小权限与角色

```sql
-- 按职责建角色，权限只授给角色
CREATE ROLE 'app_rw', 'app_ro';
GRANT SELECT, INSERT, UPDATE, DELETE ON shop.* TO 'app_rw';
GRANT SELECT ON shop.* TO 'app_ro';

-- 应用账号限定来源网段，强制 TLS，连续 5 次登录失败锁定 1 天
CREATE USER 'order_svc'@'10.0.%'
  IDENTIFIED BY 'change_me'
  REQUIRE SSL
  FAILED_LOGIN_ATTEMPTS 5 PASSWORD_LOCK_TIME 1;

GRANT 'app_rw' TO 'order_svc'@'10.0.%';
SET DEFAULT ROLE 'app_rw' TO 'order_svc'@'10.0.%';   -- 不设默认角色，登录后角色不生效
```

- 应用账号不授予 `DROP`、`ALTER`、`SUPER` 及各类动态管理权限，DDL 走变更平台
- 禁止 `root` 远程登录，DBA 使用具名账号以便审计
- 定期用 `SHOW GRANTS FOR 'order_svc'@'10.0.%' USING 'app_rw';` 核对实际权限

### 3、传输加密与密码策略

```ini
[mysqld]
require_secure_transport = ON     # 拒绝所有非 TLS 的 TCP 连接
tls_version = TLSv1.2,TLSv1.3
```

- `require_secure_transport=ON` 是服务端全局强制；`REQUIRE SSL` / `REQUIRE X509` 是按账号强制，两者可以组合
- 密码复杂度用组件实现：`INSTALL COMPONENT 'file://component_validate_password';`，再通过 `validate_password.policy`、`validate_password.length` 调整策略
- 审计日志（Audit Log）是企业版功能，社区版可以用 Percona 或 MariaDB 的审计插件替代

---

## 四、基础配置速记

| 参数 | 建议 | 详见 |
|------|------|------|
| `innodb_buffer_pool_size` | 专用数据库服务器通常设为物理内存的 50%～75%；或开启 `innodb_dedicated_server` 自动计算 | [InnoDB 存储结构](./2_topic_innodb) |
| `innodb_flush_log_at_trx_commit` + `sync_binlog` | 核心库保持「双 1」，保证提交后不丢 | [MySQL 事务与锁](./4_topic_transaction) |
| `max_connections` | 不小于所有应用实例连接池上限之和再留余量 | [数据库连接池](../4_practice/2_connection_pool) |
| `binlog_expire_logs_seconds` | 按备份周期设置保留时间（8.4 已移除 `expire_logs_days`） | [MySQL 主从与高可用](./6_topic_replication) |
| `character_set_server` / `collation_server` | 保持 8.x 默认的 `utf8mb4` / `utf8mb4_0900_ai_ci`，库表不要混用排序规则 | [MySQL 避坑指南](./8_fallible_point) |

---

## 五、本组导读

核心原理按「整体架构 → 存储 → 索引 → 事务与锁 → 优化 → 复制」的顺序读，生产实践放在读完原理之后：

| 文章 | 解决的问题 |
|------|-----------|
| [MySQL 执行流程](./1_topic_execution) | Server 层与存储引擎层的分工；连接器、分析器、优化器、执行器的链路，UPDATE 的写入路径 |
| [InnoDB 存储结构](./2_topic_innodb) | 段 / 区 / 页、行格式、Buffer Pool、Double Write、刷脏 |
| [MySQL 索引](./3_topic_index) | B+ 树、聚簇与二级索引、回表与覆盖索引、最左前缀、索引失效、索引下推、深度分页 |
| [MySQL 事务与锁](./4_topic_transaction) | ACID、隔离级别、undo / redo log、两阶段提交、MVCC、行锁与死锁、长事务 |
| [MySQL EXPLAIN 与 SQL 优化](./5_topic_explain) | EXPLAIN 字段、慢查询日志、filesort、COUNT、JOIN 优化 |
| [MySQL 主从与高可用](./6_topic_replication) | Binlog、GTID、半同步、并行复制、Group Replication / InnoDB Cluster、读写分离 |
| [MySQL 表设计规范](./7_table_design) | 命名、主键、字段类型、NULL 与默认值、范式与反范式、索引规划、建表评审 |
| [MySQL 避坑指南](./8_fallible_point) | 锁范围与死锁案例、字符集、NULL、时区、大表 DDL 与 MDL |
| [MySQL 版本特性](./9_feature) | 版本生命周期、8.0 与 8.4 的变化、升级检查 |

分库分表的中间件实现见 [分库分表与中间件](../4_practice/4_sharding)，系统层面的拆分策略见 [数据层扩展](/high-con/5_data_scaling)。

---

## 小结

- 视图不存数据；含聚合的视图走 `TEMPTABLE` 先物化再查，MySQL 没有物化视图
- 存储过程没有跨会话的预编译收益，只省网络往返；用 `EXIT HANDLER` + `RESIGNAL` 处理错误，`ROW_COUNT()` 紧跟 DML 读取
- 8.4 默认 `caching_sha2_password`，`mysql_native_password` 默认不加载；账号按角色授权，`SET DEFAULT ROLE` 后角色才生效
- 传输加密用 `require_secure_transport=ON` 或账号级 `REQUIRE SSL`，MySQL 没有 `require_ssl` 这个参数
- 配置参数只记关键几个，细节以各篇原理文章为准

## 参考资料

- 视图：[https://dev.mysql.com/doc/refman/8.4/en/views.html](https://dev.mysql.com/doc/refman/8.4/en/views.html)
- 预处理语句与存储程序的缓存：[https://dev.mysql.com/doc/refman/8.4/en/statement-caching.html](https://dev.mysql.com/doc/refman/8.4/en/statement-caching.html)
- DECLARE ... HANDLER：[https://dev.mysql.com/doc/refman/8.4/en/declare-handler.html](https://dev.mysql.com/doc/refman/8.4/en/declare-handler.html)
- 角色：[https://dev.mysql.com/doc/refman/8.4/en/roles.html](https://dev.mysql.com/doc/refman/8.4/en/roles.html)
- 加密连接：[https://dev.mysql.com/doc/refman/8.4/en/using-encrypted-connections.html](https://dev.mysql.com/doc/refman/8.4/en/using-encrypted-connections.html)
- caching_sha2_password：[https://dev.mysql.com/doc/refman/8.4/en/caching-sha2-pluggable-authentication.html](https://dev.mysql.com/doc/refman/8.4/en/caching-sha2-pluggable-authentication.html)
- 密码校验组件：[https://dev.mysql.com/doc/refman/8.4/en/validate-password.html](https://dev.mysql.com/doc/refman/8.4/en/validate-password.html)

> 下一篇：[MySQL 执行流程](./1_topic_execution) —— 一条 SELECT / UPDATE 从连接器到存储引擎的完整路径，以及各组件的职责与常见问题。
