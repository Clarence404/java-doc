---
description: 命名、主键选型、字段类型、NULL 与默认值、反范式、通用字段、索引规划、大表演进、建表模板与评审清单
---

# MySQL 表设计规范

> 前置阅读：[MySQL 基础](./0_overview)、[MySQL 避坑指南](./3_fallible_point)

表结构一旦上线就很难再改，建表时多想一步，能省掉后面大量的数据迁移和兼容代码。本篇讲命名、主键、字段类型、通用字段、索引规划与大表演进，最后给出建表模板和评审清单，基线为 MySQL 8.4 LTS。

---

## 一、命名规范

### 1、库、表、字段

- 一律使用**小写字母、数字和下划线**（snake_case），不以数字开头，不用拼音和拼音缩写
- 标识符上限是 64 个字符，实际建议控制在 32 个以内；表名用单数名词（`t_order` 而不是 `t_orders`）
- 表名按业务域加前缀，同一个库里保持一种风格，例如订单域统一 `ord_order`、`ord_order_item`，或者全库统一 `t_` 前缀
- **同一个含义在所有表里同名同类型**：`user_id` 在用户表是 `BIGINT UNSIGNED`，在订单表、日志表也必须是 `BIGINT UNSIGNED`，否则联表时会发生隐式类型转换，索引失效（见 [MySQL 索引](./4_topic_index#七、索引失效的常见场景)）
- 布尔含义的字段用 `is_` 前缀、`TINYINT UNSIGNED` 类型（1 是、0 否）；时间字段统一用 `_at` 或 `_time` 一种后缀，不要混用
- 每张表、每个字段都写 `COMMENT`，状态类字段把每个取值的含义写全

### 2、索引

| 类型 | 命名 | 示例 |
|------|------|------|
| 主键 | MySQL 固定为 `PRIMARY`，无需命名 | `PRIMARY KEY (id)` |
| 唯一索引 | `uk_` + 字段名 | `uk_order_no` |
| 普通索引 | `idx_` + 字段名，联合索引按列顺序拼接 | `idx_user_id_created_at` |

字段名太长时可以缩写，但同一个库里缩写要一致。

### 3、大小写

表名是否区分大小写由 `lower_case_table_names` 决定：Linux 默认 0（区分大小写），Windows 默认 1，macOS 默认 2。8.0 起这个参数**只能在初始化数据目录时设定**，之后不能修改。开发机是 macOS / Windows、生产是 Linux 时，`Order` 和 `order` 在开发环境是同一张表、在生产是两张表。全部用小写，这个问题就不存在。

### 4、保留字

`order`、`desc`、`key`、`group` 是常见的踩坑字段名；8.0 新增的窗口函数又把 `rank`、`groups`、`lead`、`lag`、`window` 等变成了保留字，5.7 能建的表升级后 SQL 直接报语法错误。用反引号包起来能绕过，但每条 SQL 都要记得加，不如一开始就换名字（`sort_order`、`order_desc`）。

```sql
-- 8.0.13 起可以直接查询关键字列表，RESERVED = 1 的是保留字
SELECT WORD FROM information_schema.KEYWORDS WHERE RESERVED = 1 AND WORD IN ('RANK', 'STATUS', 'GROUPS');
```

---

## 二、主键设计

### 1、为什么主键选型这么重要

InnoDB 的表就是一棵按主键组织的 B+ 树（聚簇索引），主键选型直接影响两件事：

- **写入方式**：主键递增时新行总是追加到最右边的叶子页，写满一页再开新页；主键随机时新行要插到中间某一页，页满了就要分裂成两页、各搬走一半记录
- **二级索引大小**：每个二级索引的叶子节点都存一份主键值，主键越长，所有二级索引都跟着变大

![主键顺序决定聚簇索引叶子页的写入方式](../../assets/database/mysql-pk-page-split.svg)

聚簇索引与二级索引的结构见 [MySQL 索引](./4_topic_index#三、聚簇索引与二级索引)，页与行溢出见 [InnoDB 存储结构](./8_topic_innodb)。

### 2、选型对比

| 方案 | 类型与长度 | 有序性 | 优点 | 缺点 |
|------|-----------|-------|------|------|
| 自增 `AUTO_INCREMENT` | `BIGINT UNSIGNED`，8 字节 | 严格递增 | 最简单，写入最友好 | 分库分表后不唯一；对外暴露会泄露业务量 |
| 雪花 ID | `BIGINT UNSIGNED`，8 字节 | 趋势递增 | 全局唯一、不依赖数据库 | 依赖时钟和 workerId 分配；超过 JS 安全整数范围 |
| UUIDv7 | `BINARY(16)`，16 字节 | 按毫秒递增 | 本地生成，无需协调 | 比 64 位方案多一倍空间 |
| UUIDv4 | `BINARY(16)` 或 `CHAR(36)` | 完全随机 | 本地生成，不可猜测 | 页分裂频繁，缓存命中率低，不适合作主键 |
| 业务字段（手机号、订单号） | 视字段而定 | 一般无序 | 省一个字段 | 业务规则一变主键就要改，所有关联表跟着改 |

选型建议：

- **单库单表**：用自增主键；需要对外暴露的标识另建业务编号（订单号）并加唯一索引
- **会分库分表或多写入源**：用雪花 ID 或号段这类 64 位全局 ID；不想引入发号服务又能接受 16 字节，用 UUIDv7
- **不要用业务字段作主键**，用代理主键 + 业务唯一索引；纯关联表（如用户-角色）可以用联合主键 `(user_id, role_id)`
- 雪花 ID 超过 JavaScript 的安全整数范围（2^53 - 1），返回给前端要序列化成字符串

各种 ID 生成方案的原理、时钟回拨与号段模式见 [分布式 ID 生成](/distributed/8_id_generator)；分库分表中间件的主键生成策略见 [分库分表与中间件](../5_practice/2_sharding#六、分布式主键)。

### 3、自增主键的几个事实

- 8.0 起自增计数器写入 redo log 持久化，重启后不会再回退到 `MAX(id) + 1`，已删除的最大 ID 不会被复用
- 8.0 起 `innodb_autoinc_lock_mode` 默认为 2（交错模式），批量插入时不同语句分配的 ID 可能交错，要求 binlog 为 ROW 格式
- 自增 ID 不连续是正常的：事务回滚、`INSERT ... ON DUPLICATE KEY UPDATE`、批量插入预分配都会跳号，不能当业务序号用
- `INT` 主键有用尽风险，统一用 `BIGINT UNSIGNED`，用尽的现象和巡检 SQL 见 [MySQL 避坑指南](./3_fallible_point#_2、自增-id-用尽)
- 一定要显式定义主键，没有主键的表会退化成使用全局隐藏的 `DB_ROW_ID`，原因见 [MySQL 索引](./4_topic_index#三、聚簇索引与二级索引)

---

## 三、字段类型选择

总原则：**够用的前提下选最小的类型，语义精确的类型优先**。行越窄，一页能放的行越多，Buffer Pool 能缓存的数据也越多。

### 1、整数

| 类型 | 字节 | 无符号范围 | 典型用途 |
|------|-----|-----------|---------|
| `TINYINT` | 1 | 0～255 | 状态、类型、布尔 |
| `SMALLINT` | 2 | 0～65535 | 年份、小范围枚举 |
| `INT` | 4 | 约 42 亿 | 数量、计数、版本号 |
| `BIGINT` | 8 | 约 1.8 × 10^19 | 主键、外部关联 ID、大计数 |

- 不会出现负数的字段加 `UNSIGNED`，范围翻倍
- `INT(11)` 里的 11 是显示宽度，不影响存储和范围，8.0.17 起已弃用，建表时不要再写
- 布尔值用 `TINYINT UNSIGNED`，MySQL 的 `BOOLEAN` 本身就是 `TINYINT(1)` 的别名

### 2、小数与金额

- **金额禁用 `FLOAT` / `DOUBLE`**：二进制浮点数无法精确表示 0.1，累加后出现 0.30000000000000004 这类误差
- 金额用 `DECIMAL(M, D)`，常见 `DECIMAL(12, 2)`（最大 99 亿多），精确运算，Java 侧对应 `BigDecimal`
- 另一种做法是用 `BIGINT` 存最小货币单位（分），计算快、不怕精度问题；多币种时要注意不同币种的小数位数不同（日元 0 位、科威特第纳尔 3 位），币种另存 `CHAR(3)`
- 汇率、费率这类需要更多小数位的值，按业务精度定义 `DECIMAL(18, 8)` 之类，不要和金额共用同一精度

### 3、字符串

- **字符集统一 `utf8mb4`**，不要用 `utf8`（即 `utf8mb3`），原因和字符集混用导致的索引失效见 [MySQL 避坑指南](./3_fallible_point#三、字符集与排序规则)
- `VARCHAR(n)` 的 n 是**字符数**，按业务真实上限定，不要一律写 `VARCHAR(255)`：长度本身就是一道数据校验，而且索引键长度有上限（见 [MySQL 避坑指南](./3_fallible_point#_4、varchar-长度与索引前缀)）
- 长度前缀在最大字节数超过 255 时从 1 字节变成 2 字节，`utf8mb4` 下的边界是 `VARCHAR(63)` 与 `VARCHAR(64)`；在线扩容时跨过这个边界只能走 COPY 重建表，所以长度预估时宁可一次给够
- 定长编码（币种、国家码、固定位数的状态码）用 `CHAR(n)`
- 区分大小写的值（Token、加密串、Base64）用 `utf8mb4_bin` 排序规则或 `VARBINARY`，默认的 `utf8mb4_0900_ai_ci` 不区分大小写和重音
- 哈希、摘要用 `BINARY`：SHA-256 存 `BINARY(32)`，比存 64 位十六进制字符串省一半空间
- IP 地址用 `VARBINARY(16)` 配合 `INET6_ATON()` / `INET6_NTOA()`，同时兼容 IPv4 和 IPv6

### 4、时间

| 对比 | `DATETIME` | `TIMESTAMP` |
|------|-----------|-------------|
| 存储 | 5 字节 + 小数秒 0～3 字节 | 4 字节 + 小数秒 0～3 字节 |
| 范围 | 1000-01-01～9999-12-31 | 1970-01-01 00:00:01～2038-01-19 03:14:07（UTC） |
| 时区 | 原样存储，不做转换 | 写入时按会话时区转成 UTC，读出时再转回会话时区 |

推荐 **`DATETIME(3)`**，原因有两个：

- **2038 问题已经不远**：`TIMESTAMP` 的上限是 2038 年 1 月，会员到期时间、合同截止日、证书有效期这类未来时间，今天写入就可能越界
- 时区在应用层统一约定（全部 UTC，或者全部 `+08:00`）比依赖会话时区更可控；时区配置不一致导致的「差 8 小时」见 [MySQL 避坑指南](./3_fallible_point#_3、时区不一致)

`(3)` 表示保留毫秒，和 Java 的 `Instant` / `LocalDateTime` 常用精度对齐；只需要日期的字段用 `DATE`。不要用 `VARCHAR` 或 `BIGINT` 时间戳存时间，既没法直接用日期函数，也失去了类型校验。

### 5、JSON

`JSON` 类型会校验格式并以二进制存储，适合**低频、结构不固定、不作为查询条件**的扩展属性，例如商品的规格参数、第三方回调的原始报文。

- 需要按某个 JSON 属性查询时，把它提取成生成列再建索引，或者用 8.0.13 起的函数索引；数组的包含查询用 8.0.17 起的多值索引，写法见 [MySQL 版本特性](./1_feature)
- 高频查询、需要约束的字段要拆成普通列，不要全部塞进 JSON 再靠函数索引补救
- JSON 列不能写字面量默认值，8.0.13 起可以写表达式默认值 `DEFAULT (JSON_OBJECT())`

### 6、ENUM 慎用

`ENUM('pending','paid')` 看起来省空间又直观，实际问题不少：

- 在成员列表**末尾**追加值且存储字节数不变时只改元数据；在中间插入、删除或调整顺序，都要重建表
- `ORDER BY` 按成员的序号排序而不是字符串，插入数字时会被当成序号，`INSERT ... VALUES (2)` 存进去的是第二个成员
- 迁移到其他数据库或大数据平台时没有对应类型

用 `TINYINT UNSIGNED` + `COMMENT` 写清每个取值的含义，或者用短 `VARCHAR` 存英文编码，取值合法性交给应用层校验。

### 7、TEXT / BLOB

- 大文本（商品详情、文章正文）拆到附表，与主表一对一、共用主键，列表查询只读主表；原因是行溢出要额外读溢出页、宽行让每页能放的行变少，见 [InnoDB 存储结构](./8_topic_innodb#_2、行溢出)
- 文件和图片存对象存储，表里只存对象 key 或 URL，不存 BLOB
- 查询只取需要的列，`SELECT *` 会把大字段一起读出来

### 8、速查表

| 数据 | 推荐类型 | 备注 |
|------|---------|------|
| 主键、关联 ID | `BIGINT UNSIGNED` | 返回前端时序列化为字符串 |
| 状态、类型、布尔 | `TINYINT UNSIGNED` | 取值含义写进 `COMMENT` |
| 数量、计数、版本号 | `INT UNSIGNED` | 可能超过 42 亿用 `BIGINT` |
| 金额 | `DECIMAL(12, 2)` 或 `BIGINT`（分） | 禁用 `FLOAT` / `DOUBLE` |
| 币种、国家码 | `CHAR(3)` / `CHAR(2)` | ISO 标准编码 |
| 名称、标题、备注 | `VARCHAR(n)` | n 按业务上限，字符集 `utf8mb4` |
| 正文、详情 | `TEXT` / `MEDIUMTEXT` | 拆附表 |
| 时间点 | `DATETIME(3)` | 未来时间不要用 `TIMESTAMP` |
| 日期 | `DATE` | 生日、账期 |
| 扩展属性 | `JSON` | 不作查询条件 |
| 哈希、摘要 | `BINARY(n)` | SHA-256 为 `BINARY(32)` |
| IP 地址 | `VARBINARY(16)` | `INET6_ATON()` 转换 |
| 文件、图片 | `VARCHAR(n)` 存对象 key | 不存 BLOB |

---

## 四、NULL 与默认值

### 1、默认 NOT NULL

业务字段默认声明 `NOT NULL` 并给出默认值（字符串 `''`、数值 `0`），理由是语义而不是性能：

- NULL 引入三值逻辑，`= NULL` 永远不成立、`NOT IN` 遇到 NULL 返回空、`COUNT(col)` 忽略 NULL，这些坑见 [MySQL 避坑指南](./3_fallible_point#四、null-处理)
- 唯一索引允许多个 NULL 共存，可空列上的唯一约束会「看起来有、实际没有」
- 应用层要处理 `null` 和空值两种状态，`NullPointerException` 的来源之一

两个常见误解：NULL 列**可以**走索引，`WHERE col IS NULL` 能用上索引（`EXPLAIN` 的 type 为 `ref` 或 `ref_or_null`）；NULL 的存储开销也很小，每个可空列只在行头的 NULL 位图中占 1 bit。

### 2、什么时候应该用 NULL

NULL 表达的是「未知」或「尚未发生」，这种语义找不到合适的默认值替代时，就应该用 NULL：

- 尚未发生的时间：`paid_at`（未支付）、`shipped_at`（未发货），不要用 `'1970-01-01'` 这类魔法值，8.x 默认的 `sql_mode` 含 `NO_ZERO_DATE`，`'0000-00-00'` 也写不进去
- 可选的关联：`parent_id` 为 NULL 表示顶级节点
- 0 有业务含义的数值：「评分未填」和「评了 0 分」需要区分时

### 3、默认值的几条规则

- 保持默认的严格模式（`sql_mode` 含 `STRICT_TRANS_TABLES`）：`NOT NULL` 且没有默认值的列，`INSERT` 时漏写会直接报错，而不是悄悄写入 0 或空串
- 默认值必须是合法的业务值，不要用默认值掩盖应用层漏传参数
- `TEXT`、`BLOB`、`JSON` 不能写字面量默认值，8.0.13 起可以用括号写表达式默认值

---

## 五、范式与反范式

三大范式的定义和示例见 [MySQL 基础](./0_overview#一、数据库范式)。一句话总结：每个字段只描述本表的主键，同一个事实只存一份。业务表做到 3NF，再按读场景有意识地冗余。

### 1、什么时候冗余

| 场景 | 例子 | 是否需要同步 |
|------|------|-------------|
| 历史快照 | 订单里的商品名称、下单单价、收货地址 | 不需要，冗余的就是当时的值 |
| 展示字段 | 评论表冗余用户昵称，列表页免 JOIN | 需要，源数据变了要跟着改 |
| 统计字段 | 文章表的评论数、点赞数 | 需要，且容易成为热点行 |
| 分库分表后的查询 | 订单表冗余商家 ID，支撑商家维度查询 | 需要，跨库 JOIN 不可用 |

**快照字段和冗余字段要区分清楚**：快照是业务语义（订单记录的就是下单那一刻的价格），本来就不该同步；冗余是性能手段，必须有人负责保持一致。

### 2、冗余字段的一致性

- **同一事务内更新**：源表和冗余表在同一个库时最简单，代价是写放大和锁范围变大
- **异步同步**：通过 MQ 或 CDC 订阅源表变更再更新冗余字段，允许秒级不一致，见 [CDC 工具](../5_practice/0_cdc_tools)
- **定期对账**：无论用哪种方式，都要有对账任务兜底修复漏掉的变更
- 统计字段的高频更新会形成热点行，计数先在 Redis 累加、再批量回写，见 [热点问题](/high-con/6_hotspot)

建表时在 `COMMENT` 里写明冗余字段的来源和维护方式，例如 `'用户昵称，冗余自 t_user.nickname，用户改名后由 MQ 异步更新'`。

### 3、外键

互联网业务一般**不建物理外键**，关联关系由应用层维护：

- 子表写入时要检查父表并加共享锁，父表更新、删除时要检查子表，高并发下额外的锁等待和死锁风险都会增加
- 级联更新、级联删除在数据库内部隐式发生，不写 binlog 中的独立事件，排查问题困难
- 分库分表后父子表可能不在同一个库，外键根本无法建立；gh-ost 这类在线变更工具也不支持外键

不建外键不等于不建索引：关联列（`order_id`、`user_id`）仍然要建普通索引，否则联表和按父表删除子表时都是全表扫描。

---

## 六、通用字段

### 1、创建时间与更新时间

每张业务表都带这两个字段，由数据库自动维护：

```sql
created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间',
updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '更新时间',
```

- 小数秒精度要前后一致：`DATETIME(3)` 的默认值必须写 `CURRENT_TIMESTAMP(3)`，精度不一致会报错
- `ON UPDATE` 只在行的值**真正发生变化**时触发，`UPDATE` 写入的值与原值相同时影响行数为 0，`updated_at` 也不变
- `updated_at` 是增量同步（ETL、数据对账）的天然水位线，需要按它增量拉取时要建索引
- 修数脚本不要手动把 `updated_at` 设成旧值，否则增量同步会漏掉这次修改

### 2、逻辑删除

逻辑删除用一个字段标记「已删除」，数据仍留在表里，便于恢复和审计。它最大的坑是**和唯一索引冲突**：用户注销后用同一个邮箱重新注册，唯一索引报重复。

| 方案 | 唯一索引 | 问题 |
|------|---------|------|
| `is_deleted TINYINT`（0 / 1） | `(email, is_deleted)` | 同一个邮箱只能删除一次，第二次删除时两行都是 `(email, 1)`，冲突 |
| `deleted_at DATETIME NULL` | `(email, deleted_at)` | 未删除的行都是 NULL，唯一索引允许多个 NULL，**未删除的数据也不再唯一** |
| `deleted BIGINT`，未删除为 0，删除时写入本行 `id` | `(email, deleted)` | 未删除的行都是 0，唯一性有保证；已删除的行值各不相同，互不冲突 |

```sql
CREATE TABLE t_user (
  id        BIGINT UNSIGNED NOT NULL COMMENT '主键',
  tenant_id BIGINT UNSIGNED NOT NULL DEFAULT 0 COMMENT '租户 ID',
  email     VARCHAR(128)    NOT NULL COMMENT '登录邮箱',
  deleted   BIGINT UNSIGNED NOT NULL DEFAULT 0 COMMENT '0 未删除；删除时写入本行 id',
  PRIMARY KEY (id),
  UNIQUE KEY uk_tenant_email_deleted (tenant_id, email, deleted)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COMMENT = '用户';

-- 删除：把 deleted 设为本行 id
UPDATE t_user SET deleted = id WHERE id = 1001 AND deleted = 0;
```

逻辑删除的其他代价：

- 每条查询都要带上 `deleted = 0`，漏一处就会查出已删除的数据；用 MyBatis-Plus `@TableLogic` 等插件自动拼接时，确认删除值能配置成上面这种写法，否则自己写删除 SQL
- 已删除的数据持续占用空间和索引，删除比例高的表定期把已删除数据迁到归档表
- 订单、流水这类本来就不该删除的数据用状态字段（已取消、已关闭）表达，不需要逻辑删除

### 3、乐观锁版本号

需要防止并发覆盖的表加 `version INT UNSIGNED NOT NULL DEFAULT 0`：

```sql
UPDATE t_order
   SET status = 1, version = version + 1
 WHERE id = 1001 AND version = 3;   -- 影响行数为 0 说明已被别人修改，重新读取后重试
```

能用条件更新解决的场景（`SET stock = stock - 1 WHERE id = ? AND stock >= 1`）不需要版本号；乐观锁适合「先读、在应用层计算、再写回」且冲突不多的场景。

### 4、租户 ID

SaaS 系统的业务表都带 `tenant_id`，并且：

- 所有联合索引以 `tenant_id` 打头，所有唯一约束都包含 `tenant_id`（不同租户可以有同名的数据）
- 由框架统一追加租户条件（如 MyBatis-Plus 多租户插件），不依赖每个开发者手写
- 大租户可能需要单独分库，`tenant_id` 同时也是天然的分片键候选

---

## 七、索引规划

建表时就要给出索引清单，而不是等慢查询出现再补。做法是先列出这张表**所有的查询场景**，再为它们设计索引：

| 查询场景 | 条件与排序 | 对应索引 |
|---------|-----------|---------|
| 订单详情 | `id = ?` | 主键 |
| 按订单号查 | `order_no = ?` | `uk_order_no` |
| 我的订单列表 | `tenant_id = ? AND user_id = ? ORDER BY created_at DESC` | `idx_tenant_user_created` |
| 超时未支付关单 | `status = 0 AND created_at < ?` | `idx_status_created` |
| 增量同步 | `updated_at > ?` | `idx_updated_at` |

规划时的几条原则：

- **业务唯一性必须用唯一索引兜底**：订单号、支付流水号、幂等键，应用层校验之外数据库再挡一层
- 关联列（`user_id`、`order_id`）要有索引，不建外键时尤其不能漏
- 一个联合索引尽量覆盖多个查询场景，单表索引控制在 5～6 个以内，每多一个索引写入就多维护一棵 B+ 树
- 区分度低的列（状态、性别）不单独建索引，放在联合索引里配合其他列使用

联合索引的列顺序、覆盖索引、索引失效和删除无用索引的方法，统一见 [MySQL 索引](./4_topic_index#十、索引设计原则)。

---

## 八、大表与演进

### 1、字段扩展

- **不要预留 `ext1`、`ext2` 这类字段**：没人知道里面存的是什么，类型也往往不对；确实需要灵活扩展的低频属性，用一个 `JSON` 列
- 加列在 8.4 上默认是 INSTANT，只改元数据；但 INSTANT 加删列有行版本数上限（8.4 为 64 次），频繁加删列的表达到上限后只能重建，Online DDL 的算法与 MDL 风险见 [MySQL 避坑指南](./3_fallible_point#七、大表-ddl-与-online-ddl)
- **不要修改已有字段的含义**：要改语义就加新字段，代码切换完成后再删旧字段；改类型、改字符集都要重建表
- 删除字段分两步：先确认代码已不再读写（可以先改名观察），下个版本再真正删除

### 2、垂直拆分

一张表的字段越来越多时，按访问频率拆开：

- 列表页、状态流转用到的字段留在主表
- 大文本、低频读取的详情放附表，与主表一对一、共用主键
- 更新特别频繁的计数字段单独成表，避免和主表的更新互相争锁

### 3、单表容量与归档

单表多大需要拆分，常见的经验值是千万行级别，但真正决定性能的是**行宽和访问模式**：三层 B+ 树能存多少行取决于每行多宽（估算方法见 [MySQL 索引](./4_topic_index#一、b-树数据结构)）。在拆分之前先考虑归档：

- 订单、日志这类按时间增长、老数据很少访问的表，定期把历史数据迁到归档表或归档库
- 按时间清理的日志表用 RANGE 分区，过期数据直接 `DROP PARTITION`
- 分区表的限制要提前知道：分区键必须包含在每个唯一索引（含主键）里；不带分区键的查询要扫所有分区；分区表不支持外键

### 4、为分库分表预留

即使当前是单库，预计会增长到需要拆分的核心表，建表时就按下面的方式设计，以后拆分时改动最小：

- **主键用全局 ID**（雪花 ID、号段），不依赖单库自增
- 选定分片键（通常是 `user_id` 或 `tenant_id`），核心查询都带上它
- 订单号等业务编号嵌入分片键的「基因」（例如 `user_id` 的后几位），按订单号查询时也能直接路由到分片
- 唯一约束只能在单个分片内保证，跨分片唯一要靠全局唯一的 ID 或单独的路由表
- 避免跨表 JOIN 和跨表事务，需要的字段提前冗余

分片键选择、迁移与扩容见 [分库分表与中间件](../5_practice/2_sharding) 和 [数据层扩展](/high-con/5_data_scaling)。

---

## 九、建表模板与评审清单

### 1、订单表模板

```sql
CREATE TABLE t_order (
  id            BIGINT UNSIGNED  NOT NULL COMMENT '主键，雪花 ID',
  order_no      VARCHAR(32)      NOT NULL COMMENT '订单号，对外展示，含用户 ID 基因',
  tenant_id     BIGINT UNSIGNED  NOT NULL DEFAULT 0 COMMENT '租户 ID',
  user_id       BIGINT UNSIGNED  NOT NULL COMMENT '下单用户 ID',
  status        TINYINT UNSIGNED NOT NULL DEFAULT 0 COMMENT '状态：0 待支付 1 已支付 2 已发货 3 已完成 4 已取消',
  total_amount  DECIMAL(12, 2)   NOT NULL DEFAULT 0.00 COMMENT '订单总额（元）',
  pay_amount    DECIMAL(12, 2)   NOT NULL DEFAULT 0.00 COMMENT '实付金额（元）',
  currency      CHAR(3)          NOT NULL DEFAULT 'CNY' COMMENT '币种，ISO 4217',
  goods_title   VARCHAR(128)     NOT NULL DEFAULT '' COMMENT '首件商品标题，下单时快照',
  remark        VARCHAR(500)     NOT NULL DEFAULT '' COMMENT '用户备注',
  ext           JSON             NULL COMMENT '低频扩展属性，不作查询条件',
  paid_at       DATETIME(3)      NULL COMMENT '支付时间，未支付为 NULL',
  version       INT UNSIGNED     NOT NULL DEFAULT 0 COMMENT '乐观锁版本号',
  created_at    DATETIME(3)      NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间',
  updated_at    DATETIME(3)      NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '更新时间',
  PRIMARY KEY (id),
  UNIQUE KEY uk_order_no (order_no),
  KEY idx_tenant_user_created (tenant_id, user_id, created_at),
  KEY idx_status_created (status, created_at),
  KEY idx_updated_at (updated_at)
) ENGINE = InnoDB
  DEFAULT CHARSET = utf8mb4
  COLLATE = utf8mb4_0900_ai_ci
  COMMENT = '订单主表';
```

几处设计说明：

- 主键用雪花 ID，订单号单独加唯一索引对外暴露，既不泄露订单量，也为分库分表留了路由依据
- 订单不做逻辑删除，取消、关闭都用 `status` 表达
- `goods_title` 是快照字段，商品改名后不同步；订单明细放在 `t_order_item`，通过 `order_id` 关联
- `paid_at` 允许 NULL，表示「尚未支付」；其余业务字段都是 `NOT NULL` 并带默认值

### 2、评审清单

| 类别 | 检查项 |
|------|-------|
| 命名 | 全小写 snake_case；无保留字；同义字段同名同类型；表和字段都有 `COMMENT` |
| 主键 | 显式定义；`BIGINT UNSIGNED`；会分库的表用全局 ID；不用业务字段和 UUIDv4 |
| 类型 | 金额用 `DECIMAL` 或分；时间用 `DATETIME(3)`；`VARCHAR` 长度有依据；不用 `ENUM`、`FLOAT` 存金额 |
| 字符集 | 表级 `utf8mb4` + `utf8mb4_0900_ai_ci`，与关联表一致 |
| NULL | 业务字段 `NOT NULL` + 默认值；允许 NULL 的字段有明确语义 |
| 通用字段 | 有 `created_at` / `updated_at`；逻辑删除方案不与唯一索引冲突；多租户表有 `tenant_id` |
| 索引 | 列出了查询场景；业务唯一键有唯一索引；关联列有索引；索引数不超过 5～6 个 |
| 大字段 | `TEXT` / `JSON` 不作查询条件；大文本拆附表；不存文件 |
| 冗余 | 冗余字段注明来源和同步方式；快照字段注明不同步 |
| 容量 | 预估了一年后的行数；有归档方案；需要分库的表已选好分片键 |

---

## 小结

- 命名全小写 snake_case，避开保留字；同一含义的字段在所有表里同名同类型，否则联表时隐式转换导致索引失效
- 主键显式定义为 `BIGINT UNSIGNED`：单库用自增，分库用雪花 ID 或号段，需要 UUID 时用 v7 存 `BINARY(16)`；随机主键导致页分裂，长主键让所有二级索引变大
- 金额用 `DECIMAL` 或以分为单位的 `BIGINT`；时间用 `DATETIME(3)`，`TIMESTAMP` 有 2038 上限；`ENUM` 改成员要重建表，用 `TINYINT` + 注释代替
- 业务字段默认 `NOT NULL`，NULL 只用于「未知 / 尚未发生」；NULL 列能走索引，真正的问题是三值逻辑和唯一约束失效
- 逻辑删除用「未删除为 0、删除时写入 id」的字段参与唯一索引，`deleted_at` 为 NULL 的方案会让唯一约束失效
- 快照字段不同步、冗余字段必须有维护方；互联网业务不建物理外键，但关联列要建索引
- 建表时先列查询场景再定索引；字段只加不改语义，大表优先归档，核心表提前为分库分表预留全局 ID 和分片键

## 参考资料

- Schema Object Names：[https://dev.mysql.com/doc/refman/8.4/en/identifiers.html](https://dev.mysql.com/doc/refman/8.4/en/identifiers.html)
- Identifier Case Sensitivity：[https://dev.mysql.com/doc/refman/8.4/en/identifier-case-sensitivity.html](https://dev.mysql.com/doc/refman/8.4/en/identifier-case-sensitivity.html)
- Keywords and Reserved Words：[https://dev.mysql.com/doc/refman/8.4/en/keywords.html](https://dev.mysql.com/doc/refman/8.4/en/keywords.html)
- Integer Types：[https://dev.mysql.com/doc/refman/8.4/en/integer-types.html](https://dev.mysql.com/doc/refman/8.4/en/integer-types.html)
- Fixed-Point Types（DECIMAL）：[https://dev.mysql.com/doc/refman/8.4/en/fixed-point-types.html](https://dev.mysql.com/doc/refman/8.4/en/fixed-point-types.html)
- The DATE, DATETIME, and TIMESTAMP Types：[https://dev.mysql.com/doc/refman/8.4/en/datetime.html](https://dev.mysql.com/doc/refman/8.4/en/datetime.html)
- Automatic Initialization and Updating for TIMESTAMP and DATETIME：[https://dev.mysql.com/doc/refman/8.4/en/timestamp-initialization.html](https://dev.mysql.com/doc/refman/8.4/en/timestamp-initialization.html)
- Data Type Default Values：[https://dev.mysql.com/doc/refman/8.4/en/data-type-defaults.html](https://dev.mysql.com/doc/refman/8.4/en/data-type-defaults.html)
- The JSON Data Type：[https://dev.mysql.com/doc/refman/8.4/en/json.html](https://dev.mysql.com/doc/refman/8.4/en/json.html)
- The ENUM Type：[https://dev.mysql.com/doc/refman/8.4/en/enum.html](https://dev.mysql.com/doc/refman/8.4/en/enum.html)
- AUTO_INCREMENT Handling in InnoDB：[https://dev.mysql.com/doc/refman/8.4/en/innodb-auto-increment-handling.html](https://dev.mysql.com/doc/refman/8.4/en/innodb-auto-increment-handling.html)
- Partitioning Keys, Primary Keys, and Unique Keys：[https://dev.mysql.com/doc/refman/8.4/en/partitioning-limitations-partitioning-keys-unique-keys.html](https://dev.mysql.com/doc/refman/8.4/en/partitioning-limitations-partitioning-keys-unique-keys.html)

> 下一篇：[MySQL 索引](./4_topic_index) —— B+ 树、聚簇与二级索引、覆盖索引、最左前缀、索引失效与深度分页。
