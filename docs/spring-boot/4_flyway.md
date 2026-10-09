---
description: Flyway 原理与命名、Boot 4 依赖、迁移锁、Liquibase 与回滚、上线实践
---

# 数据库版本迁移

> **本篇目标**：理解 Flyway 的执行过程与命名规则，在 Boot 4 上正确引入 Flyway / Liquibase（starter 与数据库模块），知道多实例并发迁移由谁保证、真正要担心的是什么；掌握 Liquibase 的 changelog、上下文与回滚；能把表结构变更安全地纳入滚动发布。
>
> **前置阅读**：[数据访问](./3_data_access)

> 参考资料：
> * Spring Boot Database Initialization：[https://docs.spring.io/spring-boot/how-to/data-initialization.html](https://docs.spring.io/spring-boot/how-to/data-initialization.html)
> * Flyway 官方文档：[https://documentation.red-gate.com/flyway](https://documentation.red-gate.com/flyway)
> * Liquibase 官方文档：[https://docs.liquibase.com/](https://docs.liquibase.com/)
> * Spring Boot 4.0 Migration Guide：[https://github.com/spring-projects/spring-boot/wiki/Spring-Boot-4.0-Migration-Guide](https://github.com/spring-projects/spring-boot/wiki/Spring-Boot-4.0-Migration-Guide)

---

## 一、为什么需要数据库版本管理

多环境（开发 / 测试 / 预发 / 生产）下表结构频繁变更，手工执行 SQL 容易遗漏、顺序错乱，也无法回答「这个库现在是哪个版本」。迁移工具的作用是**像 Git 管理代码一样管理 Schema 的变更历史**：变更脚本与代码一起提交、评审，应用启动或发布流水线中自动按顺序执行，并在库里记录执行历史。

| 工具 | 特点 | 推荐场景 |
|------|------|---------|
| Flyway | SQL 脚本驱动，约定简单，上手快 | 单一数据库类型、团队习惯直接写 SQL，大多数项目的首选 |
| Liquibase | XML / YAML / JSON / SQL 描述变更，内置回滚、上下文、前置条件 | 需要同一套变更适配多种数据库，或对回滚有明确要求 |

---

## 二、Flyway

### 1、依赖

```xml
<dependency>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-flyway</artifactId>
</dependency>
<!-- Flyway 10+ 把各数据库的支持拆成独立模块，MySQL / MariaDB 必须引入 -->
<dependency>
    <groupId>org.flywaydb</groupId>
    <artifactId>flyway-mysql</artifactId>
</dependency>
```

| 数据库 | 需要的模块 |
|--------|-----------|
| MySQL / MariaDB | `flyway-mysql` |
| PostgreSQL | `flyway-database-postgresql` |
| SQL Server | `flyway-sqlserver` |
| Oracle | `flyway-database-oracle` |

- **Boot 4 必须使用 `spring-boot-starter-flyway`**：自动配置拆分到独立模块后，只引入 `flyway-core` 不会再触发自动配置，迁移会静默不执行。Boot 3.x 直接引入 `flyway-core` 即可
- 漏掉数据库模块时启动报 `Unsupported Database`，这是升级到 Flyway 10 后最常见的错误
- 版本均由 Boot 依赖管理，不需要写版本号

### 2、执行过程

![Flyway migrate 执行过程](../assets/spring-boot/flyway-migrate.svg)

Boot 在创建 `EntityManagerFactory` 等依赖数据源的 Bean 之前执行迁移，保证 JPA 的 `ddl-auto: validate` 校验的是迁移之后的表结构。

**每个脚本默认在一个事务中执行**，但 MySQL 的 DDL 会隐式提交，无法回滚：一个脚本里写了三条 `ALTER TABLE`，第二条失败时第一条已经生效，历史表中留下一条失败记录。处理方式是手工修正库表后执行 `flyway repair` 清除失败记录，再重新迁移。因此 **MySQL 上一个脚本只做一件事**，PostgreSQL 支持事务性 DDL，没有这个问题。

### 3、命名规范

```text
db/migration/
├── V1__init_schema.sql
├── V1_1__add_user_phone.sql          # 版本 1.1
├── V2__create_order_tables.sql
├── V3__Backfill_order_status.java    # Java 迁移也可以放在这里
└── R__view_order_summary.sql         # 可重复迁移
```

| 前缀 | 含义 | 说明 |
|------|------|------|
| `V` | 版本化迁移 | 每个版本只执行一次；版本号中的 `_` 等同于 `.`，`V1_1` 即 1.1；按数值比较，`V10` 排在 `V9` 之后 |
| `R` | 可重复迁移 | 内容的 checksum 变化就重新执行，在所有 `V` 之后执行；适合视图、存储过程 |
| `U` | 撤销迁移 | 与同版本的 `V` 对应，**仅 Flyway 付费版支持** |

- 版本号与描述之间是**两个下划线**，描述中的单下划线显示为空格
- 多人并行开发时版本号容易撞车，可以用时间戳做版本号（如 `V20261008_1030__add_index.sql`）；代价是不同分支合并后可能出现「新版本号小于已执行版本」，需要评估是否开启 `out-of-order`

复杂的数据回填可以写成 Java 迁移：继承 `BaseJavaMigration` 放在 `db.migration` 包下，或者声明为实现 `JavaMigration` 的 Spring Bean，Boot 会自动注册给 Flyway。

### 4、常用配置

```yaml
spring:
  flyway:
    enabled: true
    locations: classpath:db/migration/{vendor}   # {vendor} 按数据库类型替换为 mysql、postgresql 等
    baseline-on-migrate: true      # 已有数据的库首次接入：把当前状态记为基线
    baseline-version: 1            # 基线版本，小于等于它的脚本不会执行
    validate-on-migrate: true      # 默认开启：已执行脚本被改动时启动失败
    clean-disabled: true           # 默认开启：禁止 clean（删除库内所有对象）
    out-of-order: false            # 不允许执行比已执行版本更小的脚本
    # 迁移使用单独的高权限账号，应用运行账号只保留 DML 权限
    user: ${FLYWAY_USER}
    password: ${FLYWAY_PASSWORD}
```

`clean` 会删除 Schema 里的所有对象，**生产环境任何时候都不要打开 `clean-disabled: false`**，测试环境需要干净的库时优先用 Testcontainers 每次新建，见 [Testcontainers](/testing/5_testcontainers)。

### 5、并发迁移与发布

**多个实例同时启动不需要额外的分布式锁**。Flyway 在迁移前会获取数据库级的锁（MySQL 使用命名锁，PostgreSQL 使用 advisory lock，其他数据库锁定历史表），后启动的实例等待锁释放，再读取历史表时发现已无待执行脚本，直接跳过。

真正需要考虑的是下面几件事：

| 问题 | 说明 | 做法 |
|------|------|------|
| 大表 DDL 锁表 | `ALTER TABLE` 大表可能长时间持有元数据锁，阻塞业务读写，也让其他实例在迁移锁上长时间等待 | 评估是否支持 Online DDL；超大表交给 gh-ost / pt-online-schema-change 在发布前单独执行 |
| 滚动发布期间新旧代码并存 | 新版本的迁移执行后，旧版本实例仍在服务 | 变更必须向后兼容，按「先扩展后收缩」分多个版本发布，见 [优雅上下线与变更](/high-avail/8_graceful_release) |
| 迁移拖慢启动 | 迁移耗时计入启动时间，可能超过存活探针的宽限期 | 迁移与应用启动解耦：Kubernetes 中用 Job 或 initContainer 执行迁移，应用里设置 `spring.flyway.enabled=false` |
| 脚本被改动 | 已执行脚本的 checksum 变化，`validate` 失败 | 已执行的脚本永远不改，修正通过新版本脚本完成；`repair` 只用于清理失败记录、对齐 checksum，不是常规手段 |

---

## 三、Liquibase

### 1、依赖与配置

```xml
<!-- Boot 4；Boot 3.x 直接引入 org.liquibase:liquibase-core -->
<dependency>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-liquibase</artifactId>
</dependency>
```

```yaml
spring:
  liquibase:
    change-log: classpath:db/changelog/db.changelog-master.yaml   # 默认值
    contexts: prod                 # 只执行匹配上下文的 changeSet
    label-filter: "!experimental"  # 按标签表达式过滤
    drop-first: false              # 生产必须为 false
```

Liquibase 与 Flyway 同时存在时两者都会执行，一个项目只选一个。

### 2、changelog 结构

主文件只负责按顺序引入各变更文件：

```yaml
# db/changelog/db.changelog-master.yaml
databaseChangeLog:
  - include:
      file: db/changelog/changes/001-create-users.yaml
  - include:
      file: db/changelog/changes/002-add-user-status.yaml
```

```yaml
# db/changelog/changes/001-create-users.yaml
databaseChangeLog:
  - changeSet:
      id: 001-create-users
      author: clarence
      changes:
        - createTable:
            tableName: users                 # 避免 user 等保留字
            columns:
              - column:
                  name: id
                  type: BIGINT
                  autoIncrement: true
                  constraints:
                    primaryKey: true
                    nullable: false
              - column:
                  name: username
                  type: VARCHAR(50)
                  constraints:
                    nullable: false
                    unique: true
              - column:
                  name: created_at
                  type: DATETIME
                  defaultValueComputed: CURRENT_TIMESTAMP
```

```yaml
# db/changelog/changes/002-add-user-status.yaml
databaseChangeLog:
  - changeSet:
      id: 002-add-user-status
      author: clarence
      changes:
        - addColumn:
            tableName: users
            columns:
              - column:
                  name: status
                  type: VARCHAR(20)
  - changeSet:
      id: 002-backfill-user-status
      author: clarence
      context: "!test"               # 测试环境不执行这条数据回填
      preConditions:
        - onFail: MARK_RAN           # 条件不满足时标记为已执行，不报错
        - columnExists:
            tableName: users
            columnName: status
      changes:
        - sql:
            sql: UPDATE users SET status = 'ACTIVE' WHERE status IS NULL
      rollback:
        - sql:
            sql: UPDATE users SET status = NULL WHERE status = 'ACTIVE'
```

- 每个 changeSet 以 `id + author + 文件路径` 唯一标识，执行记录写入 `DATABASECHANGELOG` 表，并保存 checksum；与 Flyway 一样，**已执行的 changeSet 不能修改**
- 并发控制依靠 `DATABASECHANGELOGLOCK` 表中的锁记录。进程在迁移中途被强杀时锁不会自动释放，后续启动会一直等待，需要执行 `liquibase release-locks` 手工释放
- `context` 与 `labels` 用于按环境或按特性选择性执行，Boot 中对应 `spring.liquibase.contexts` 与 `spring.liquibase.label-filter`

### 3、回滚

| 变更类型 | 回滚方式 |
|---------|---------|
| `createTable`、`addColumn`、`renameColumn`、`createIndex` 等 | Liquibase 可以自动推导反向操作 |
| `sql`、`dropTable`、`dropColumn`、数据修改 | 无法推导，必须写 `rollback` 块，否则回滚时报错 |

Boot 只在启动时执行 `update`，回滚通过 Liquibase CLI 或 Maven / Gradle 插件执行：

```bash
liquibase update-sql                  # 只生成将要执行的 SQL，不执行，适合上线前评审
liquibase tag --tag=v2.3.0            # 发布前打标签
liquibase rollback --tag=v2.3.0       # 回滚到标签
liquibase rollback-count --count=1    # 回滚最近一个 changeSet
```

回滚 DDL 往往伴随数据丢失（删掉新加的列，列里的数据也没了），**生产上更常用的是「向前修复」**：发一个新的变更把问题改掉。回滚脚本的价值主要在于发布失败、数据尚未写入时的快速撤回。

### 4、与 Flyway 对比

| 对比 | Flyway | Liquibase |
|------|--------|-----------|
| 变更描述 | SQL 为主，也支持 Java | XML / YAML / JSON / SQL，抽象的变更类型可跨数据库 |
| 回滚 | 撤销迁移（`U`）仅付费版 | 免费版内置，部分变更自动推导 |
| 预览 SQL | dry run 仅付费版 | `update-sql` 免费 |
| 选择性执行 | 按 `locations` 区分目录 | `context`、`labels`、前置条件 |
| 并发控制 | 数据库级锁，进程退出自动释放 | 锁表，异常退出需手工释放 |
| 学习成本 | 低 | 中，需要熟悉 changelog 语法 |

---

## 四、上线实践

- **迁移账号与应用账号分离**：迁移账号有 DDL 权限，应用运行账号只有 DML 权限，降低被注入后删表的风险
- **先扩展后收缩**：加列、加表、加索引可以先于代码上线；删列、改名必须拆成多个版本，等旧代码全部下线后再执行
- **加列带默认值、加索引要评估数据量**：在测试环境用接近生产规模的数据演练耗时
- **脚本进代码评审**：迁移脚本与业务代码在同一个合并请求中评审，评审时关注锁表风险与回滚方案
- **所有环境执行同一套脚本**：禁止在生产手工改表；已有库首次接入用 `baseline`，不要回补历史脚本
- **集成测试覆盖迁移**：用 Testcontainers 启动真实数据库执行全部迁移，再跑 `ddl-auto: validate`，能在合并前发现脚本与实体不一致

---

## 小结

- 迁移工具把 Schema 变更纳入版本管理；Flyway 简单直接，Liquibase 在多数据库与回滚上更强
- Boot 4 必须引入 `spring-boot-starter-flyway` / `spring-boot-starter-liquibase`，只引入核心库不会触发自动配置
- Flyway 10+ 需要单独引入数据库模块（如 `flyway-mysql`），否则报 `Unsupported Database`
- Flyway 命名：`V<版本>__<描述>.sql`，`R` 为可重复迁移，`U` 撤销迁移仅付费版；MySQL 的 DDL 不可回滚，一个脚本只做一件事
- 多实例并发迁移由 Flyway 的数据库锁或 Liquibase 的锁表串行化，不需要分布式锁；要关注的是大表 DDL、滚动发布兼容性与启动耗时
- `clean` 在生产永远禁用；已执行脚本不可修改，修正通过新版本完成
- Liquibase 用 changeSet + `rollback` + `context` 管理变更，回滚通过 CLI 执行，生产上更常用向前修复

> 下一篇：[中间件集成](./5_middleware) —— Redis、Kafka、RabbitMQ、Elasticsearch、MongoDB 的 Starter、关键配置与 Boot 4 变化。
