---
description: MDL 与 Online DDL、gh-ost、PostgreSQL 锁、扩展 - 迁移 - 收缩、分批回填、换库迁移
---

# Schema 变更与数据迁移

> 前置阅读：[MySQL 事务与锁](../1_mysql/4_topic_transaction)、[数据库版本迁移](/spring-boot/4_flyway)

线上改表出事，多半不是 SQL 写错，而是锁住了整张表，或者新结构上线时旧代码还在跑。本篇讲变更风险判断、MySQL 与 PostgreSQL 的在线改表、配合滚动发布的扩展 - 迁移 - 收缩与分批回填，以及换库迁移的流程，基线为 MySQL 8.4、PostgreSQL 18。

---

## 一、先判断风险

一次表结构变更要回答两个问题：**会不会长时间锁表**，**正在运行的旧代码还能不能跑**。前者决定用什么方式执行，后者决定要不要拆成几次发布。

| 变更 | 锁与耗时 | 旧代码 | 做法 |
|------|---------|-------|------|
| 加表、加可空列、加带常量默认值的列 | MySQL 是 INSTANT，PostgreSQL 11 起不重写表，只需短暂拿锁 | 不受影响 | 随版本直接发布，配好锁等待超时 |
| 加二级索引 | 不阻塞读写，但大表耗时长、IO 高、复制延迟 | 不受影响 | MySQL 用 INPLACE 或 gh-ost，PostgreSQL 用 `CONCURRENTLY` |
| 改列类型、改字符集、加主键 | 多数要重建表，MySQL 的 `COPY` 期间不能写 | 可能受影响 | 超大表用 gh-ost；类型语义变化走第四节的扩展 - 迁移 - 收缩 |
| 已有列加 `NOT NULL`、加唯一约束、加外键 | 要校验全部存量数据 | 写入可能开始报错 | 先清洗数据，再用分步校验的写法加约束 |
| 删列、改列名、改表名 | 本身很快 | 立刻报错 | 必须拆成多次发布，等旧代码全部下线再执行 |

脚本本身用 Flyway 或 Liquibase 纳入版本管理，接入、命名、多实例并发迁移见 [数据库版本迁移](/spring-boot/4_flyway)；本篇讲脚本里的语句怎么写才安全。

---

## 二、MySQL：MDL 与 Online DDL

### 1、DDL 被 MDL 阻塞，拖垮整张表

DDL 执行时需要拿表的 **MDL 写锁**；而任何访问过该表、尚未提交的事务（哪怕只执行过一条 `SELECT`）都持有 MDL 读锁。MDL 请求按队列排队，于是形成下面的阻塞链：

![MDL 阻塞链](../../assets/database/mysql-mdl-blocking.svg)

8.0.12 起 `ADD COLUMN` 默认就是 INSTANT，重建表的耗时已经不是问题，真正的风险在于等 MDL。

```sql
-- 1、DDL 前先找长事务
SELECT trx_id, trx_mysql_thread_id, trx_started, trx_query
FROM information_schema.innodb_trx
WHERE trx_started < NOW() - INTERVAL 60 SECOND;

-- 2、给 DDL 设置较短的 MDL 等待超时，拿不到锁就失败，而不是排队堵死业务
SET SESSION lock_wait_timeout = 5;
ALTER TABLE orders ADD COLUMN remark VARCHAR(64), ALGORITHM = INSTANT;

-- 3、DDL 卡住时查看谁在等、谁持有 MDL（8.x 默认已开启 MDL 采集）
SELECT * FROM sys.schema_table_lock_waits;
SELECT OBJECT_SCHEMA, OBJECT_NAME, LOCK_TYPE, LOCK_STATUS, OWNER_THREAD_ID
FROM performance_schema.metadata_locks
WHERE OBJECT_NAME = 'orders';
```

`information_schema.innodb_trx` 只能看到 InnoDB 事务，MDL 的持有和等待要看 `performance_schema.metadata_locks` 或 `sys.schema_table_lock_waits`。

### 2、Online DDL 的算法与锁

`ALTER TABLE` 有三种算法，代价依次升高：

| 算法 | 做法 | 并发 DML |
|------|------|---------|
| `INSTANT` | 只修改数据字典 | 允许 |
| `INPLACE` | 在引擎内部完成，可能需要重建表（rebuild），执行期间记录并回放增量 | 大多允许 |
| `COPY` | 建新表、逐行拷贝、再替换 | 不允许 |

常见操作在 8.4 上的表现：

| 操作 | 算法 | 重建表 | 并发 DML |
|------|------|-------|---------|
| 加列（任意位置）、删列 | `INSTANT`（8.0.29+） | 否 | 允许 |
| 重命名列（类型与 NULL 属性不变） | `INSTANT` | 否 | 允许 |
| 修改 / 删除列默认值 | `INSTANT` | 否 | 允许 |
| 加二级索引 | `INPLACE` | 否 | 允许 |
| 删除索引、重命名索引 | `INPLACE`（只改元数据） | 否 | 允许 |
| 扩展 `VARCHAR` 长度（长度前缀字节数不变：都在 255 字节以内或都超过 255 字节） | `INPLACE` | 否 | 允许 |
| 加主键 | `INPLACE` | 是 | 允许 |
| 修改列类型、修改字符集 | `COPY` | 是 | 不允许 |
| `OPTIMIZE TABLE` / `ENGINE=InnoDB` 重建 | `INPLACE` | 是 | 允许 |

显式写出 `ALGORITHM` 和 `LOCK`，MySQL 做不到时会直接报错，而不是悄悄退化成锁表的 COPY：

```sql
ALTER TABLE orders ADD INDEX idx_status (status), ALGORITHM = INPLACE, LOCK = NONE;
ALTER TABLE orders ADD COLUMN channel VARCHAR(16), ALGORITHM = INSTANT;
```

INSTANT 加 / 删列受表的行版本数上限约束（8.4 为 64，9.1 起为 255），达到上限后只能重建表，见 [MySQL 版本特性](../1_mysql/9_feature)。

MySQL 的 DDL 会隐式提交，不能回滚。Flyway 虽然给每个迁移套一个事务，迁移中途失败时前面已执行的 DDL 仍留在库里，Flyway 只把这个版本标记为失败：要先手工清理残留，再用 `flyway repair` 删掉失败记录后重跑。所以 MySQL 的迁移脚本**一个文件只放一条 DDL**，失败时现场最好判断。

### 3、超大表用 gh-ost

INPLACE 不阻塞 DML，但重建表期间的 IO 压力和副本延迟仍然很大：DDL 在源库执行完之后才写入 binlog，副本要再完整执行一遍，期间复制延迟持续累积。千万行以上的表建议用外部工具：

| 工具 | 原理 | 特点与限制 |
|------|------|-----------|
| **gh-ost**（GitHub） | 建影子表，拷贝存量数据，同时消费 binlog 回放增量，最后原子切换表名 | 不靠触发器同步增量，可暂停、限速；要求 `binlog_format=ROW` 且 `binlog_row_image=FULL`，不支持外键 |
| **pt-online-schema-change**（Percona） | 建影子表，用触发器同步增量 | 成熟稳定；触发器带来额外写开销，外键需要特殊处理 |

gh-ost 默认连副本读 binlog、再找到主库写影子表，只有主库可连时加 `--allow-on-master`。几个关键参数：

```bash
gh-ost --alter="ADD COLUMN remark VARCHAR(64)" \
  --host=replica-1 --database=shop --table=orders \
  --chunk-size=1000 \
  --max-lag-millis=1500 \
  --max-load=Threads_running=50 \
  --critical-load=Threads_running=200 \
  --postpone-cut-over-flag-file=/tmp/ghost.postpone \
  --execute
```

- `--max-lag-millis`：副本延迟超过阈值就暂停拷贝，等延迟回落再继续
- `--max-load`：任一指标超过阈值就限速；`--critical-load` 超过则直接退出，保护主库
- `--postpone-cut-over-flag-file`：这个文件存在时，数据追平后也不切换表名；删掉文件（或发交互命令 `cut-over`）才执行切换，切换时间就能放在业务低峰
- 切换是原子换表名，但会短暂锁表，等锁默认最多 3 秒，超时就重试，期间请求会被阻塞片刻

上线守则：

1. 先在副本或预发环境验证耗时和锁行为
2. 放在业务低峰期执行，DDL 会话设置较短的 `lock_wait_timeout`
3. 执行前确认没有长事务，执行中盯住副本延迟和 `Threads_running`
4. 准备好回滚方案（反向 DDL 或影子表保留）

---

## 三、PostgreSQL：锁级别与安全写法

PostgreSQL 的 `ALTER TABLE` 默认拿 **ACCESS EXCLUSIVE** 锁，读写全部阻塞。锁请求同样排队：前面有一个长事务没提交，DDL 等着，DDL 后面的所有查询又排在 DDL 后面，现象和 MySQL 的 MDL 阻塞链一样。所以每条 DDL 前都先设锁等待超时，拿不到锁就失败重试：

```sql
SET lock_timeout = '5s';
ALTER TABLE orders ADD COLUMN channel varchar(16);
```

常见操作的代价与安全写法：

| 操作 | 是否重写表 | 安全写法 |
|------|-----------|---------|
| 加列，无默认值或常量默认值 | 否（11 起） | 直接执行，配 `lock_timeout` |
| 加列，易变默认值（如 `clock_timestamp()`） | 是 | 先加无默认值的列，再分批回填 |
| 改类型：`varchar` 加长、`varchar` 转 `text` | 否 | 直接执行 |
| 改类型：其他（如 `int` 转 `bigint`） | 是，全程 ACCESS EXCLUSIVE | 新列 + 回填 + 切换，见第四节 |
| 已有列加 `NOT NULL` | 否，但持 ACCESS EXCLUSIVE 扫全表 | 先加 `NOT VALID` 约束，再单独校验 |
| 加外键 | 否，但要校验存量 | `NOT VALID` + `VALIDATE CONSTRAINT` |
| 建 / 删索引 | — | `CREATE INDEX CONCURRENTLY` / `DROP INDEX CONCURRENTLY` |

**加约束分两步**：`NOT VALID` 只对新写入生效、不扫存量，几乎瞬间完成；`VALIDATE CONSTRAINT` 再扫存量，但只拿 SHARE UPDATE EXCLUSIVE 锁，不阻塞读写。已有列加 `NOT NULL` 借一个 CHECK 约束完成，有已校验的 `CHECK (col IS NOT NULL)` 时 `SET NOT NULL` 会跳过全表扫描：

```sql
SET lock_timeout = '5s';
ALTER TABLE orders ADD CONSTRAINT orders_channel_nn CHECK (channel IS NOT NULL) NOT VALID;
ALTER TABLE orders VALIDATE CONSTRAINT orders_channel_nn;  -- 扫全表，但不阻塞读写
ALTER TABLE orders ALTER COLUMN channel SET NOT NULL;       -- 有已校验的 CHECK，跳过扫描
ALTER TABLE orders DROP CONSTRAINT orders_channel_nn;

-- 外键同理
ALTER TABLE order_item ADD CONSTRAINT fk_item_order
    FOREIGN KEY (order_id) REFERENCES orders (id) NOT VALID;
ALTER TABLE order_item VALIDATE CONSTRAINT fk_item_order;
```

PostgreSQL 18 起 `NOT NULL` 约束本身也能加成 `NOT VALID` 再 `VALIDATE`，不必借 CHECK 绕一圈。

**`CONCURRENTLY` 的两个坑**：

- 不能在事务块里执行，而 Flyway 默认给每个迁移套一个事务。把建索引单独放一个脚本，并在同目录放一个同名配置文件（如 `V12__idx_orders_status.sql.conf`），写上 `executeInTransaction=false`
- 失败（比如唯一索引遇到重复数据）会留下一个 INVALID 索引：查询不用它，写入却要维护它。用下面的 SQL 找出来，删掉后重建，或 `REINDEX INDEX CONCURRENTLY`

```sql
SELECT indexrelid::regclass AS index_name, indrelid::regclass AS table_name
FROM pg_index
WHERE NOT indisvalid;
```

---

## 四、配合发布：扩展 - 迁移 - 收缩

滚动发布时新旧两个版本同时在线，所以**每一步表结构都要让正在运行的两个版本都能跑**。删列、改名、改类型这类破坏性变更，拆成「先扩展、再迁移、最后收缩」几次发布，每一步都能单独回滚。

以订单金额从 `amount DECIMAL(10,2)`（元）改成 `amount_cent BIGINT`（分）为例：

| 发布 | 数据库 | 代码 | 能否回滚 |
|------|-------|------|---------|
| ① 扩展 | 加可空列 `amount_cent` | 写入时同时写两列，读旧列 | 能，新列没人读 |
| ② 迁移 | 分批回填存量（见第五节），校验两列一致 | 不变 | 能 |
| ③ 切读 | — | 读新列，仍然双写 | 能，切回读旧列 |
| ④ 收缩 | 旧版本全部下线后，删旧列；需要时给新列加 `NOT NULL` | 只读写新列 | 不能，删列前确认没有任何引用 |

几个容易漏的点：

- **新列起新名字**：直接改旧列的类型或名字，旧代码当场就会出错；收缩阶段再把新列改回旧名，又是一次破坏性变更
- **删列前先清代码引用**：MyBatis 的 `resultMap`、JPA 实体字段、报表和数据同步任务都要先去掉；`SELECT *` 在加列时没事，删列时会让依赖列序的代码出错
- **双写期间回填不覆盖新值**：回填条件带上 `amount_cent IS NULL`，已经由新代码写入的行不再改
- **收缩等一个观察期**：确认旧版本实例全部下线、没有回滚计划之后再删列

服务接口与消息事件的破坏性变更是同一套思路，见 [服务间通信与契约](/microservices/4_communication)。

---

## 五、分批回填

存量数据补到新列，不能一条 `UPDATE orders SET amount_cent = amount * 100` 了事：一个事务改几千万行，锁持有时间长、undo 和 binlog 暴涨、副本延迟飙升，回滚也要同样久，见 [MySQL 避坑指南](../1_mysql/8_fallible_point#_1、大事务-一次删除海量数据)。按主键区间分批，每批单独提交：

```java
/**
 * 订单金额回填：按主键区间分批，把 amount（元）换算成 amount_cent（分）。
 * 双写上线之后执行；中断后传入上次记录的 startId 即可续跑。
 */
@Component
public class AmountBackfillJob {

    private static final Logger log = LoggerFactory.getLogger(AmountBackfillJob.class);
    private static final int BATCH = 2000;       // 每批行数，按单批耗时控制在几十毫秒内调整
    private static final long PAUSE_MILLIS = 50; // 批间停顿，给复制和业务留出余量

    private final JdbcTemplate jdbc;

    public AmountBackfillJob(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    public void run(long startId) throws InterruptedException {
        // 上界取开始时的最大 id：之后新写入的行由双写负责，不用回填
        long maxId = jdbc.queryForObject("SELECT COALESCE(MAX(id), 0) FROM orders", Long.class);
        for (long lo = startId; lo < maxId; lo += BATCH) {
            // 按主键区间更新，走主键索引；amount_cent IS NULL 保证不覆盖新代码写入的值
            int rows = jdbc.update("""
                    UPDATE orders SET amount_cent = ROUND(amount * 100)
                    WHERE id > ? AND id <= ? AND amount_cent IS NULL
                    """, lo, lo + BATCH);
            log.info("回填进度 id <= {}，本批 {} 行", lo + BATCH, rows); // 日志里的 id 就是续跑起点
            Thread.sleep(PAUSE_MILLIS);
        }
    }
}
```

- **按主键区间，不用 `LIMIT ... OFFSET`**：OFFSET 越往后扫得越多；区间里有空洞也没关系，只是那一批更新的行少一些
- **限速看副本延迟**：批间停顿是最简单的限速，更稳妥的是每批之后检查副本延迟，超过阈值就多停一会儿，延迟的看法见 [MySQL 主从与高可用](../1_mysql/6_topic_replication)
- **回填完要校验**：`SELECT COUNT(*) FROM orders WHERE amount_cent IS NULL OR amount_cent <> ROUND(amount * 100)` 结果为 0 才进入切读

---

## 六、数据迁移：换库与拆库

表结构变更是在原库里改；数据迁移是把数据整体搬到另一处，常见的有四种，流程都是「全量 + 增量 → 校验 → 灰度切读 → 停写切写 → 保留回退」：

| 场景 | 特点 | 主文档 |
|------|------|-------|
| 单库拆到分片库、分片扩容 | 数据按新的分片规则重新分布 | [分库分表与中间件 · 平滑迁移与扩容](./4_sharding#八、平滑迁移与扩容) |
| 从单体库拆出服务库 | 先切断跨服务的表访问，再搬数据 | [服务拆分](/microservices/2_service_split#_3、双写与数据迁移) |
| 换数据库产品（如 MySQL 换 PostgreSQL、国产库） | 还要处理类型映射与 SQL 方言差异 | [商业与国产库](../3_relational/1_other_rdbms) |
| 跨机房、上云 | 网络延迟大，增量同步是关键 | [CDC 工具](./8_cdc_tools) |

共同的要点：

- **先记位点再拷全量**：增量从全量开始前的 binlog 位点（或 PostgreSQL 的复制槽）回放，拷贝期间的修改就不会丢
- **增量优先用 CDC**：订阅日志按提交顺序回放，比在业务代码里写两遍可靠，工具选型见 [CDC 工具](./8_cdc_tools)
- **校验用分段 checksum**：按主键区间比对行数与校验值，不一致的段再逐行比对
- **切写后开反向同步**：新库出问题时能切回旧库而不丢数据，回退窗口保留到确认稳定

---

## 小结

- 改表前先问两件事：会不会长时间锁表，旧代码还能不能跑
- MySQL 的风险主要在 MDL 排队：先查长事务、设 `lock_wait_timeout`、显式写 `ALGORITHM` / `LOCK`，超大表用 gh-ost 并推迟切换到低峰；DDL 不能回滚，一个脚本一条 DDL
- PostgreSQL 的 `ALTER TABLE` 默认锁读写：设 `lock_timeout`，约束用 `NOT VALID` + `VALIDATE`，索引用 `CONCURRENTLY` 且不放进事务
- 删列、改名、改类型走扩展 - 迁移 - 收缩，每次发布都要兼容在线的新旧两个版本
- 回填按主键区间分批提交、限速、不覆盖新值，完成后校验
- 换库拆库统一是全量 + 增量、校验、灰度切读、停写切写、反向同步

## 参考资料

- MySQL Online DDL 操作：[https://dev.mysql.com/doc/refman/8.4/en/innodb-online-ddl-operations.html](https://dev.mysql.com/doc/refman/8.4/en/innodb-online-ddl-operations.html)
- MySQL 元数据锁：[https://dev.mysql.com/doc/refman/8.4/en/metadata-locking.html](https://dev.mysql.com/doc/refman/8.4/en/metadata-locking.html)
- gh-ost：[https://github.com/github/gh-ost](https://github.com/github/gh-ost)
- gh-ost 命令行参数：[https://github.com/github/gh-ost/blob/master/doc/command-line-flags.md](https://github.com/github/gh-ost/blob/master/doc/command-line-flags.md)
- PostgreSQL ALTER TABLE：[https://www.postgresql.org/docs/18/sql-altertable.html](https://www.postgresql.org/docs/18/sql-altertable.html)
- PostgreSQL CREATE INDEX：[https://www.postgresql.org/docs/18/sql-createindex.html](https://www.postgresql.org/docs/18/sql-createindex.html)
- Flyway 迁移的事务处理：[https://documentation.red-gate.com/flyway/flyway-concepts/migrations/migration-transaction-handling](https://documentation.red-gate.com/flyway/flyway-concepts/migrations/migration-transaction-handling)
- Flyway 脚本级配置：[https://documentation.red-gate.com/flyway/reference/script-configuration](https://documentation.red-gate.com/flyway/reference/script-configuration)

> 下一篇：[数据库监控与诊断](./6_monitoring) —— 关键指标、慢查询日志、sys 库、pg_stat_statements、锁等待、卡顿排查顺序
