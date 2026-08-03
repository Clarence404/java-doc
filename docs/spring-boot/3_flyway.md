# 数据库版本迁移

> 参考资料：
> * Flyway 官方文档：[https://documentation.red-gate.com/flyway](https://documentation.red-gate.com/flyway)
> * Liquibase 官方文档：[https://docs.liquibase.com/](https://docs.liquibase.com/)
> * Spring Boot 集成 Flyway：[https://docs.spring.io/spring-boot/docs/current/reference/html/howto.html#howto.data-initialization.migration-tool.flyway](https://docs.spring.io/spring-boot/docs/current/reference/html/howto.html#howto.data-initialization.migration-tool.flyway)

## 一、为什么需要数据库版本管理

多环境（开发 / 测试 / 生产）下表结构频繁变更，手动同步容易遗漏。数据库版本管理工具的作用：**像 Git 管理代码一样，管理数据库 Schema 的变更历史**。

| 工具 | 特点 | 推荐场景 |
|------|------|---------|
| Flyway | 轻量，SQL 脚本驱动，上手快 | 大多数项目首选 |
| Liquibase | 支持 XML / YAML / JSON，回滚能力强 | 需要跨数据库或复杂回滚 |

---

## 二、Flyway

> 依赖：`spring-boot-starter-flyway`（Spring Boot 自动配置）

### 2.1 工作原理

1. 启动时扫描 `classpath:db/migration/` 下的 SQL 脚本
2. 对比 `flyway_schema_history` 表中的执行记录
3. 按版本号顺序执行未执行过的脚本

### 2.2 命名规范

```
V{版本号}__{描述}.sql

V1__init_schema.sql
V2__add_user_table.sql
V3__add_index_on_email.sql
```

- `V` 开头为版本化迁移（不可重复执行）
- `R` 开头为可重复迁移（内容变化时重新执行）

### 2.3 常用配置

```yaml
spring:
  flyway:
    enabled: true
    locations: classpath:db/migration
    baseline-on-migrate: true   # 已有数据库首次接入时使用
    out-of-order: false         # 禁止乱序执行
```

### 2.4 注意事项

- 已执行的脚本**禁止修改**，否则校验失败
- 多服务同时启动时注意并发迁移（加分布式锁或单点执行）

---

## 三、Liquibase

> 依赖：`liquibase-core`（Spring Boot 已内置自动配置，无需独立 Starter）

### 3.1 与 Flyway 的主要区别

- 支持 XML / YAML / JSON / SQL 多种格式编写变更集
- 内置回滚（`rollback`）支持，Flyway 免费版不支持
- 跨数据库兼容性更强

### 3.2 changelog 示例（YAML 格式）

```yaml
databaseChangeLog:
  - changeSet:
      id: 1
      author: clarence
      changes:
        - createTable:
            tableName: user
            columns:
              - column:
                  name: id
                  type: BIGINT
                  autoIncrement: true
```

> [!warning]
> 待补充
