---
description: 大商户慢查询占满 HikariCP、存活探针连带重启、补索引、语句超时与数据源隔离
---

# 慢 SQL 拖垮连接池

> 前置阅读：[数据库连接池](/database/5_practice/3_connection_pool)、[EXPLAIN 与 SQL 优化](/database/1_mysql/7_topic_explain)

一个只在大商户数据量下才慢的新查询，把订单服务的连接池占满，连带下单、支付回调全部超时，存活探针又把 Pod 接连重启。本篇按现象、排查、根因、修复、预防完整复盘，基线为 JDK 21、Spring Boot 4、MySQL 8.4。

---

## 一、现象

9 月 15 日 10:02，order-service v3.9.0 上线商家后台"已支付订单看板"（页面每 10 秒自动刷新）。order-service 6 个 Pod，HikariCP `maximum-pool-size=20`，`connection-timeout` 为默认 30 秒；MySQL 8.4 主库 32 核。

| 时间 | 告警 / 现象 |
|------|-------------|
| 10:21 | `HikariPendingHigh`：`hikaricp_connections_pending` 6 个 Pod 均 > 100，`hikaricp_connections_active` = 20 / 20 |
| 10:22 | `HttpErrorRateHigh`：下单、支付回调错误率 64%，日志大量 `Connection is not available` |
| 10:23 | `MySQLThreadsRunningHigh`：主库 `Threads_running` 从平时 12 升到 131，CPU 86% |
| 10:24 | `PodRestartFrequent`：4 个 Pod 在 5 分钟内重启 1–2 次，重启后几十秒又被打满 |

应用日志：

```text
2026-09-15T10:22:07.531+08:00 ERROR 1 --- [io-8080-exec-153] c.e.order.web.GlobalExceptionHandler : place order failed
org.springframework.jdbc.CannotGetJdbcConnectionException: Failed to obtain JDBC Connection
Caused by: java.sql.SQLTransientConnectionException: HikariPool-1 - Connection is not available, request timed out after 30000ms (total=20, active=20, idle=0, waiting=186)
```

`total=20, active=20, idle=0, waiting=186`：池子里 20 个连接全被借走，186 个线程在排队。

---

## 二、影响

- 10:21–10:49 共 28 分钟，下单成功率最低 31%，约 2.1 万笔下单失败
- 支付回调失败 3,400 笔，依赖支付渠道重试（最长 25 分钟）补回，期间用户看到"支付处理中"
- Pod 被存活探针反复重启，重启期间正在处理的请求直接断开，冷启动又放大了数据库压力

---

## 三、排查过程

### 1、连接被谁占着

连接池耗尽只有两种可能：借出去不还（泄漏），或者每次借得太久（慢）。先看连接持有时间：

```promql
histogram_quantile(0.99, sum by (le) (rate(hikaricp_connections_usage_seconds_bucket{app="order-service"}[1m])))
```

示例输出：上线前 P99 约 0.018s，10:15 后升到 2.6s 并持续。连接持有时间暴涨，而非连接借出不还，指向慢 SQL。

### 2、线程转储：持有连接的线程在执行什么

```bash
kubectl exec order-service-6b8d-p7v2n -- jcmd 1 Thread.print > td.txt
grep -c "HikariPool.getConnection" td.txt
grep -B3 -A25 "SocketInputStream\|NioSocketImpl.read" td.txt | grep "com.example" | sort | uniq -c | sort -rn | head -3
```

示例输出：

```text
181
     17 at com.example.order.query.MerchantOrderQueryService.paidBoard(MerchantOrderQueryService.java:64)
      2 at com.example.order.app.PlaceOrderService.place(PlaceOrderService.java:96)
      1 at com.example.order.pay.PayCallbackService.onPaid(PayCallbackService.java:41)
```

181 个线程卡在 `HikariPool.getConnection` 等连接；正在读 socket（即正在等 MySQL 返回）的 20 个线程里，17 个是新上线的看板查询。

### 3、数据库侧：哪条 SQL 在消耗

```sql
SELECT LEFT(query, 80) AS query, exec_count, total_latency, avg_latency, rows_examined_avg
FROM sys.statement_analysis
ORDER BY total_latency DESC LIMIT 3;
```

示例输出：

```text
+----------------------------------------------------------------------------------+------------+---------------+-------------+-------------------+
| query                                                                            | exec_count | total_latency | avg_latency | rows_examined_avg |
+----------------------------------------------------------------------------------+------------+---------------+-------------+-------------------+
| SELECT `id` , `order_no` , `amount` , `pay_time` FROM `t_order` WHERE `merchan ... |      21460 | 14.22 h       | 2.39 s      |           2864120 |
| UPDATE `t_order` SET `status` = ? , `pay_time` = ? , `update_time` = ? WHERE ... |      48211 | 6.81 m        | 8.47 ms     |                 1 |
| INSERT INTO `t_order` ( `order_no` , `user_id` , `merchant_id` , `amount` ... |      39876 | 3.97 m        | 5.97 ms     |                 0 |
+----------------------------------------------------------------------------------+------------+---------------+-------------+-------------------+
```

看板查询平均 2.39 秒、每次扫描约 286 万行，总耗时是第二名的上百倍。再按商户分布核对（慢查询日志里的参数）发现：只有 KA 大商户 20001（约 312 万订单）慢，普通商户 20ms 内返回。测试环境没有这种量级的商户，所以没测出来。

### 4、执行计划

```sql
EXPLAIN ANALYZE
SELECT id, order_no, amount, pay_time FROM t_order
WHERE merchant_id = 20001 AND status IN (2, 3) AND pay_time >= '2026-09-12 00:00:00'
ORDER BY pay_time DESC LIMIT 20;
```

示例输出：

```text
-> Limit: 20 row(s)  (actual time=2387.5..2387.5 rows=20 loops=1)
    -> Sort: t_order.pay_time DESC, limit input to 20 row(s) per chunk  (actual time=2387.5..2387.5 rows=20 loops=1)
        -> Filter: ((t_order.`status` in (2,3)) and (t_order.pay_time >= TIMESTAMP'2026-09-12 00:00:00'))  (actual time=0.09..2361.2 rows=286411 loops=1)
            -> Index lookup on t_order using idx_merchant_create (merchant_id=20001)  (actual time=0.08..2105.7 rows=3124560 loops=1)
```

只能用 `idx_merchant_create(merchant_id, create_time)` 定位到商户，然后回表 312 万行逐行过滤 `status`、`pay_time`，再排序取 20 条。

### 5、算一笔账

看板在线约 600 个页面，每 10 秒刷新一次，即约 60 QPS；每次 2.4 秒，按利特尔法则需要 `60 × 2.4 ≈ 144` 个连接同时被占用，而 6 个 Pod 一共只有 120 个连接。看板查询独占了全部连接，下单和支付回调排在后面等到 30 秒超时。

### 6、为什么 Pod 被重启

```bash
kubectl get deploy order-service -o jsonpath='{.spec.template.spec.containers[0].livenessProbe}'
```

示例输出：

```text
{"failureThreshold":3,"httpGet":{"path":"/actuator/health","port":8081},"periodSeconds":10,"timeoutSeconds":3}
```

存活探针配的是聚合的 `/actuator/health`，其中包含 `db` 健康检查，而 `db` 检查也要从同一个连接池借连接。池子耗尽 → 健康检查 3 秒超时 → 连续 3 次失败 → K8s 杀掉 Pod。重启不仅没解决问题，还把正在执行的请求全部打断。

---

## 四、根因

1. **索引不匹配**：新查询按 `status + pay_time` 过滤排序，现有索引只覆盖 `merchant_id + create_time`，大商户需回表扫描数百万行
2. **数据倾斜没测到**：测试数据里最大商户只有 2 万订单，SQL 审核只看了执行计划的 `type=ref`，没有结合 `rows` 评估
3. **没有查询超时**：慢查询可以一直占着连接，连接池 30 秒的获取超时让排队线程也长时间占住 Tomcat 线程
4. **所有查询共用一个池**：后台看板这类可降级查询与下单核心链路抢同一批连接，缺少隔离
5. **存活探针依赖数据库**：把"数据库慢"放大成"Pod 反复重启"

---

## 五、修复

### 1、止血

- 10:31 配置中心关闭看板自动刷新，看板接口返回"系统维护中"
- 10:33 DBA 按 SQL 指纹批量结束仍在执行的看板查询：

```sql
SELECT CONCAT('KILL QUERY ', processlist_id, ';')
FROM performance_schema.threads
WHERE processlist_command = 'Query' AND processlist_time > 2
  AND processlist_info LIKE 'SELECT id, order_no, amount, pay_time FROM t_order%';
```

- 10:36 存活探针改为 `/actuator/health/liveness`（只看应用自身状态），停止连带重启
- 10:49 连接池 pending 归零，错误率恢复

### 2、根治

**补索引**（MySQL 8.4 在线 DDL，不阻塞读写）：

```sql
ALTER TABLE t_order
  ADD INDEX idx_merchant_status_pay (merchant_id, status, pay_time),
  ALGORITHM = INPLACE, LOCK = NONE;
```

上线后同一查询 `actual time` 降到 3ms，扫描行数 40。

**加查询超时**，慢 SQL 不再无限占连接：

```yaml
spring:
  datasource:
    hikari:
      maximum-pool-size: 20
      connection-timeout: 3000        # 获取连接最多等 3 秒，快速失败，不拖住 Tomcat 线程
mybatis:
  configuration:
    default-statement-timeout: 5      # 单条 SQL 默认 5 秒超时（单位：秒）
```

后台类查询再叠加 MySQL 服务端的执行时间上限（只对 `SELECT` 生效）：

```sql
SELECT /*+ MAX_EXECUTION_TIME(2000) */ id, order_no, amount, pay_time FROM t_order WHERE ...
```

**资源隔离**：商家后台查询改走只读从库的独立数据源（`maximum-pool-size=8`），即使再出慢查询，也只影响后台本身，不会抢核心链路的连接。

**探针配置**：

```yaml
management:
  endpoint:
    health:
      probes:
        enabled: true
      group:
        readiness:
          include: readinessState,db   # 数据库不可用时摘流量，但不重启
```

---

## 六、预防

**监控告警**：

```yaml
- alert: HikariPendingHigh
  expr: max by (pod, pool) (hikaricp_connections_pending) > 5
  for: 1m
  labels: {severity: critical}
- alert: HikariAcquireSlow
  expr: |
    histogram_quantile(0.99, sum by (le, pod) (rate(hikaricp_connections_acquire_seconds_bucket[5m]))) > 0.1
  for: 3m
  labels: {severity: warning}
```

数据库侧每天对比 `sys.statement_analysis`，出现"新增且平均耗时 > 500ms"的 SQL 指纹自动推送给对应服务负责人。

**代码与发布规范**：

- 新 SQL 必须附 `EXPLAIN` 结果，并用生产量级最大的租户 / 商户参数评估 `rows`，而不是只看 `type`
- 所有数据源必须设置语句超时；后台、报表、导出类查询走独立数据源或从库
- 存活探针只能用 `/actuator/health/liveness`，禁止包含数据库、Redis 等外部依赖（纳入 Helm Chart 模板）

**测试**：预发环境保留一份脱敏的大商户数据，压测脚本按真实商户分布构造参数；用 Testcontainers 写集成测试，对关键查询断言 `EXPLAIN` 使用了预期索引。

---

## 七、涉及知识点

- HikariCP 参数、池大小估算与泄漏排查：[数据库连接池](/database/5_practice/3_connection_pool)
- 连接池为什么不是越大越好：[池化技术](/high-perf/7_pooling)
- 执行计划与 `EXPLAIN ANALYZE`：[EXPLAIN 与 SQL 优化](/database/1_mysql/7_topic_explain)
- 联合索引与回表：[MySQL 索引](/database/1_mysql/4_topic_index)
- 慢 SQL 治理闭环：[数据访问性能](/high-perf/10_db_performance)
- 舱壁隔离与超时：[超时、重试与隔离](/high-avail/4_timeout_retry_bulkhead)
- 存活与就绪探针：[优雅上下线](/high-avail/8_graceful_release)、[Actuator 监控](/spring-boot/11_actuator)

---

## 小结

- 连接池耗尽先分清"借了不还"和"借得太久"，看连接持有时间直方图
- 线程转储里卡在 `getConnection` 的是受害者，正在读 socket 的线程才指向元凶 SQL
- 只在大租户上慢的 SQL 最难测出来，评审要用最大租户参数看 `rows`
- 语句超时、获取连接超时、数据源隔离三道防线缺一不可
- 存活探针依赖数据库，会把一次慢查询放大成全量重启

## 参考资料

- HikariCP 配置项与默认值：[HikariCP README](https://github.com/brettwooldridge/HikariCP)
- 语句统计视图：[MySQL 8.4 Reference Manual: The statement_analysis View](https://dev.mysql.com/doc/refman/8.4/en/sys-statement-analysis.html)
- `EXPLAIN ANALYZE`：[MySQL 8.4 Reference Manual: EXPLAIN Statement](https://dev.mysql.com/doc/refman/8.4/en/explain.html)
- `MAX_EXECUTION_TIME` 提示：[MySQL 8.4 Reference Manual: Optimizer Hints](https://dev.mysql.com/doc/refman/8.4/en/optimizer-hints.html)
- 在线加索引：[MySQL 8.4 Reference Manual: Online DDL Operations](https://dev.mysql.com/doc/refman/8.4/en/innodb-online-ddl-operations.html)
- `defaultStatementTimeout`：[MyBatis 3 Configuration](https://mybatis.org/mybatis-3/configuration.html)
- 探针分组：[Spring Boot Actuator — Kubernetes Probes](https://docs.spring.io/spring-boot/reference/actuator/endpoints.html#actuator.endpoints.kubernetes-probes)

> 下一篇：[大事务锁表](./7_big_transaction)
