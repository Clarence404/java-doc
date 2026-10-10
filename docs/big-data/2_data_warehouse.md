---
description: ODS / DWD / DWS / ADS 分层、星型与雪花、事实表与维度表、缓慢变化维与拉链表、宽表、命名与数据域、指标体系
---

# 数仓分层与建模

> 前置阅读：[大数据基础](./1_basics)

数仓建模回答的是：从业务库同步过来的几百张表，怎样**组织成一套口径统一、可复用、可追溯**的数据，让"昨天各省份 GMV"这种问题只需要一处计算、一个答案。本篇讲分层、维度建模、事实表与维度表、缓慢变化维与拉链表、宽表、命名规范和指标体系，SQL 以 Spark SQL + Iceberg 1.12 写法给出。

---

## 一、为什么要分层

没有规划的数仓通常长成"烟囱式"：每来一个报表需求，开发就从 ODS 原始表写一条几百行的 SQL 直接出结果。半年之后会出现这些问题：

| 问题 | 表现 |
|------|------|
| 口径不一致 | 运营报表的 GMV 含取消单，财务报表不含，两个数字差 3%，没人说得清哪个对 |
| 重复计算 | 十张报表各自把订单明细和商品表 JOIN 一遍，集群资源大半花在重复工作上 |
| 牵一发而动全身 | 业务库改了一个字段名，几十个下游任务同时报错 |
| 无法追溯 | 某个指标异常时，要读几百行 SQL 才能定位是哪一步出了问题 |

分层的本质是**把复杂计算拆成职责单一的几步，并让中间结果可复用**：

- **清晰的数据结构**：每层有明确职责，看到表名就知道它在哪一层、加工到什么程度
- **减少重复开发**：公共的清洗、关联、汇总在下层做一次，上层直接复用
- **统一口径**：同一指标只在一个地方定义和计算
- **隔离变化**：业务库的变化只影响 ODS 到 DWD 这一段，上层不感知
- **便于追溯和回刷**：每一层都落地存储，出问题时可以逐层排查、从任意一层重算

---

## 二、ODS / DWD / DWS / ADS 与 DIM

![电商订单数仓分层](../assets/big-data/dw-layering.svg)

### 1、各层职责

| 层 | 全称 | 职责 | 粒度 | 示例表 |
|----|------|------|------|--------|
| ODS | Operational Data Store，贴源层 | 原样接入业务库、日志、文件，结构与源系统保持一致，保留原始数据便于回溯 | 与源一致 | `ods_order_info_inc`、`ods_user_info_full`、`ods_log_inc` |
| DIM | Dimension，公共维度层 | 用户、商品、地区、日期等维度表，被 DWD 和 DWS 共用 | 每个维度成员一行（或一个版本一行） | `dim_user_zip`、`dim_product_full`、`dim_date` |
| DWD | Data Warehouse Detail，明细层 | 按业务过程建立最细粒度的事实表：清洗、去重、统一编码和单位、维度退化、脱敏 | 业务过程的最细粒度 | `dwd_trade_order_detail_inc`、`dwd_trade_pay_detail_inc` |
| DWS | Data Warehouse Summary，汇总层 | 按主题 + 统计粒度 + 时间周期做轻度汇总，沉淀公共派生指标 | 粒度 + 周期 | `dws_trade_user_order_1d`、`dws_trade_province_order_nd` |
| ADS | Application Data Service，应用层 | 面向具体报表、接口、看板的结果数据，通常数据量小，可导出到 OLAP 或业务库 | 按需求 | `ads_trade_gmv_1d`、`ads_user_retention` |

部分团队会在 DWD 和 DWS 之间加一层 DWM（中间层），或把 DWS 与 ADS 合并，层数不是重点，重点是每层职责明确、全团队遵守同一套约定。

### 2、引用规则

- **只向下引用，不跨层**：ADS 读 DWS / DWD，DWS 读 DWD / DIM，DWD 读 ODS / DIM。ADS 直接读 ODS 是最常见的反模式，等于绕过了全部清洗和口径统一
- **同层引用要克制**：DWS 之间相互引用会形成长依赖链，一个任务延迟会层层传导，需要时把公共部分下沉
- **ODS 不做业务加工**：只做格式转换（比如 JSON 解析成列）和必要的分区，保证出问题时能拿原始数据重跑
- **任何一层都按天（或小时）分区**：分区既是增量计算的单位，也是回刷和数据生命周期管理的单位

### 3、ODS 的同步方式

ODS 的数据来自数据集成工具（见 [数据集成](./5_data_integration)），按表的特点选择同步方式：

| 方式 | 做法 | 适用 | 表后缀 |
|------|------|------|--------|
| 全量同步 | 每天把整张表抽一份快照，按 `dt` 分区存放 | 数据量小、变化频繁的表，如商品、地区、优惠券 | `_full` |
| 增量同步 | 每天只同步新增和变化的行，按 `update_time` 或 binlog 获取 | 数据量大的表，如订单、订单明细、支付流水 | `_inc` |
| 实时 CDC | 订阅 binlog，持续写入 Kafka 或湖仓主键表 | 有实时需求的表 | `_inc` |

增量同步要求业务表有可靠的 `update_time`（并且更新时一定会改它）或开启 binlog，这是后端设计表结构时就要考虑的，binlog 配置见 [CDC 工具](/database/5_practice/0_cdc_tools) 第二节。

### 4、从 ODS 到 DWD

本篇示例统一使用电商订单业务：业务库有 `order_info`（订单）、`order_item`（订单明细）、`user_info`（用户）、`product`（商品）等表；SQL 以 Spark SQL 写法给出、表格式为 Iceberg（需按 Iceberg 文档配置 Catalog 与 `IcebergSparkSessionExtensions`）。

DWD 是建模工作量最集中的一层。下面把当天新建的订单明细加工成下单事实表：对 ODS 增量数据按主键取最新一条去重，关联订单头表补齐用户与地区，再从商品维度把一级品类**退化**到事实表里，避免下游每次都 JOIN 商品维度。

```sql
CREATE TABLE dwd_trade_order_detail_inc (
    order_detail_id        BIGINT    COMMENT '订单明细 ID，粒度：一个订单中的一个商品',
    order_id               BIGINT    COMMENT '订单 ID（退化维度）',
    user_id                BIGINT,
    product_id             BIGINT,
    category1_id           BIGINT    COMMENT '一级品类，从商品维度退化而来',
    province_id            BIGINT,
    order_time             TIMESTAMP,
    sku_num                INT       COMMENT '购买件数',
    original_amount_fen    BIGINT    COMMENT '原始金额（分）',
    coupon_reduce_fen      BIGINT    COMMENT '优惠券分摊金额（分）',
    split_total_amount_fen BIGINT    COMMENT '实付分摊金额（分）',
    dt                     STRING
) USING iceberg
PARTITIONED BY (dt);

INSERT OVERWRITE TABLE dwd_trade_order_detail_inc PARTITION (dt = '2026-10-09')
SELECT
    oi.id,
    oi.order_id,
    o.user_id,
    oi.product_id,
    p.category1_id,
    o.province_id,
    o.create_time,
    oi.sku_num,
    oi.sku_num * oi.price_fen,
    COALESCE(oi.split_coupon_fen, 0),
    oi.split_total_fen
FROM (
    SELECT *, ROW_NUMBER() OVER (PARTITION BY id ORDER BY update_time DESC) AS rn
    FROM ods_order_item_inc
    WHERE dt = '2026-10-09' AND to_date(create_time) = DATE '2026-10-09'
) oi
JOIN (
    SELECT *, ROW_NUMBER() OVER (PARTITION BY id ORDER BY update_time DESC) AS rn
    FROM ods_order_info_inc
    WHERE dt = '2026-10-09' AND to_date(create_time) = DATE '2026-10-09'
) o ON oi.order_id = o.id AND o.rn = 1
LEFT JOIN dim_product_full p
       ON oi.product_id = p.product_id AND p.dt = '2026-10-09'
WHERE oi.rn = 1;
```

要点：

- 每次运行只覆盖当天这一个静态分区，任务可以安全地重跑（幂等），这是批处理任务最重要的性质
- 下单是一次性发生的事件，所以按订单创建日期落分区；订单状态的后续变化属于支付、发货等其他业务过程，各自建事实表，或进入累积快照事实表（第四节）
- 金额统一用「分」存储为整数，避免浮点误差，与业务库约定保持一致
- 日期 `'2026-10-09'` 在实际任务中由调度系统以参数传入，见 [任务调度](./6_scheduling)

### 5、从 DWD 到 DWS

DWS 按"统计粒度 + 时间周期"沉淀公共的派生指标。以用户粒度的下单汇总为例：

```sql
-- 最近 1 日：用户粒度下单汇总
INSERT OVERWRITE TABLE dws_trade_user_order_1d PARTITION (dt = '2026-10-09')
SELECT
    user_id,
    COUNT(DISTINCT order_id)    AS order_count_1d,
    SUM(sku_num)                AS order_num_1d,
    SUM(split_total_amount_fen) AS order_amount_fen_1d
FROM dwd_trade_order_detail_inc
WHERE dt = '2026-10-09'
GROUP BY user_id;

-- 最近 7 日：直接在 1d 表上累加，避免重新扫描 7 天明细
INSERT OVERWRITE TABLE dws_trade_user_order_nd PARTITION (dt = '2026-10-09')
SELECT
    user_id,
    SUM(order_count_1d)      AS order_count_7d,
    SUM(order_amount_fen_1d) AS order_amount_fen_7d
FROM dws_trade_user_order_1d
WHERE dt BETWEEN '2026-10-03' AND '2026-10-09'
GROUP BY user_id;
```

能这样从 1d 累加到 7d，是因为每个订单只属于某一天，订单数和金额在时间上**可加**。"最近 7 日下单用户数"就不行：同一个用户可能每天都下单，7 个 1d 用户数相加会重复计数，必须在 nd 表里按用户粒度去重后再数，或在用户粒度的 nd 表上 `COUNT(*)`。识别指标是否可加，是设计汇总层时最需要小心的地方。

---

## 三、维度建模

### 1、四个步骤

维度建模由 Ralph Kimball 提出，是目前数仓最主流的建模方法。它把数据分成两类：**事实**（业务过程中发生的、可度量的事件，如一次下单的金额、件数）和**维度**（描述事实的上下文，如谁、什么商品、在哪、什么时候）。建模按四步进行：

1. **选择业务过程**：下单、支付、退款、加购、浏览，每个业务过程对应一张事实表。业务过程是动词，不是部门或报表
2. **声明粒度**：事实表的一行代表什么，例如"一个订单中的一个商品"。粒度要尽可能细，细粒度可以汇总成粗粒度，反之不行
3. **确认维度**：在声明的粒度下，有哪些描述性的上下文：日期、用户、商品、地区、优惠券、渠道
4. **确认事实**：在声明的粒度下有哪些度量：件数、原始金额、优惠金额、实付金额

### 2、总线矩阵

多个业务过程共享同一套维度，这些被共享的维度称为**一致性维度**（Conformed Dimension）。用总线矩阵把业务过程和维度的关系画出来，是数仓规划阶段的核心产出：

| 业务过程 \ 维度 | 日期 | 用户 | 商品 | 地区 | 优惠券 | 渠道 |
|-----------------|------|------|------|------|--------|------|
| 加购 | √ | √ | √ | | | √ |
| 下单 | √ | √ | √ | √ | √ | √ |
| 支付 | √ | √ | √ | √ | √ | √ |
| 退款 | √ | √ | √ | √ | | |
| 浏览（流量） | √ | √ | √ | √ | | √ |

矩阵告诉我们：需要建哪些事实表（每行一张）、哪些维度表必须统一（每列一张），以及哪些业务过程可以沿着共同维度做"钻取交叉"分析（例如按商品维度对比加购与下单，得到转化率）。

### 3、星型模型与雪花模型

![星型模型 vs 雪花模型](../assets/big-data/dw-star-snowflake.svg)

| 维度 | 星型模型 | 雪花模型 |
|------|----------|----------|
| 结构 | 事实表周围直接挂一层维度表，维度表是反范式的宽表 | 维度表进一步规范化，拆出子维度（商品 → 品类 → 一级品类） |
| 查询 | JOIN 少，SQL 简单，性能好 | JOIN 多，SQL 复杂 |
| 冗余 | 维度表有冗余（每个商品行都存品类名称） | 冗余少 |
| 维护 | 品类改名要更新多行 | 只改一行 |
| 适用 | 数仓的主流选择 | 维度极大且层级稳定、存储敏感的场景 |

在列存和廉价存储的今天，维度表的冗余几乎不构成成本问题，而 JOIN 是分布式查询最贵的操作之一，因此**数仓普遍采用星型模型**，必要时在 DWD 把常用维度属性直接退化到事实表里，进一步减少 JOIN。多个事实表共享一致性维度时形成的结构称为星座模型（Fact Constellation），这是实际数仓的常态。

::: tip 维度建模与三范式
业务库用三范式是为了写入一致、避免更新异常；数仓几乎只读不改，追求的是查询简单、易于理解，所以用反范式的维度模型。后端工程师初次接触数仓时最常见的不适，就是觉得"冗余太多"，这是有意为之的取舍。
:::

---

## 四、事实表

### 1、四种事实表

| 类型 | 一行代表 | 特点 | 电商示例 |
|------|----------|------|----------|
| 事务事实表 | 一次业务事件 | 最常见，插入后不再更新，粒度最细 | 下单明细、支付明细、退款明细 |
| 周期快照事实表 | 某个对象在某个周期末的状态 | 按固定周期（天 / 月）记录，适合存量指标 | 每天每个 SKU 的库存、每天每个用户的账户余额 |
| 累积快照事实表 | 一个有明确生命周期的对象 | 一行记录多个里程碑时间，随流程推进不断更新 | 一个订单的下单 → 支付 → 发货 → 签收时间与金额 |
| 无事实的事实表 | 一次事件的发生 | 没有度量，只有维度外键，用于计数 | 用户领券、学生选课、商品被浏览 |

几点说明：

- **事务事实表回答"发生了多少"，周期快照回答"现在有多少"**：库存、余额这类存量指标无法从流水简单累加得到（期初未知、补录调整多），用快照更可靠
- **累积快照用于分析流程时效**：比如"下单到支付的平均时长""发货到签收超过 3 天的订单占比"。由于要随订单状态更新，它在 Hive 表上实现很繁琐，通常按"未完成订单放 `9999-12-31` 分区、完成后移到完成日期分区"的方式组织；在 Iceberg / Paimon 等支持行级更新的表格式上可以直接 `MERGE INTO` 更新
- **粒度不能混**：同一张事实表里不能既有订单级的运费又有商品级的金额，订单级度量要么分摊到明细，要么单独建订单粒度的事实表

### 2、度量的可加性

| 类型 | 含义 | 示例 | 汇总注意 |
|------|------|------|----------|
| 可加 | 沿所有维度都能求和 | 下单金额、件数 | 可以从细粒度逐层累加 |
| 半可加 | 只能沿部分维度求和 | 库存、余额（不能沿时间相加） | 跨时间取期末值或平均值 |
| 不可加 | 不能直接求和 | 单价、转化率、去重用户数 | 存分子分母，查询时再算比例；去重数要重新去重 |

事实表里应尽量存可加的度量：转化率存"支付用户数"和"下单用户数"两列，客单价存"金额"和"订单数"两列，比例在最后一步计算。

---

## 五、维度表

维度表决定了数据能"按什么分析"，它的设计质量直接影响使用体验：

- **属性要丰富且可读**：商品维度不仅有 `product_id`，还要有名称、品牌、三级品类、价格带；状态码要翻译成中文描述或至少配套码表。分析师按维度属性做筛选和分组，属性越全，能回答的问题越多
- **代理键与自然键**：经典 Kimball 做法为维度表生成无业务含义的代理键（surrogate key），以支持同一自然键的多个历史版本；大数据场景下更常见的做法是直接用业务主键加生效日期区间（拉链表，见第六节），避免维护代理键映射
- **维度退化**：订单号这种没有其他属性的维度，直接作为事实表的一列存在即可，不单独建维度表
- **日期维度必建**：一行一天，包含年、季、月、周、是否周末、是否节假日、是否大促日，能让"国庆期间""双十一当周"这类筛选变得简单，且预先生成几十年的数据即可
- **层级展平**：商品 → 三级品类 → 二级品类 → 一级品类在星型模型中展平成一张维度表的多列，而不是像雪花那样拆表
- **快照方式存储**：变化不频繁、数据量小的维度（商品、地区）可以每天存一份全量快照（`_full`，按 `dt` 分区），历史查询取对应日期的分区即可，简单可靠；数据量大、变化少的维度（用户）每天全量存储太浪费，适合用拉链表

---

## 六、缓慢变化维（SCD）

维度属性会随时间变化：用户从普通会员升级成 VIP，从杭州搬到上海。问题是：**上个月的订单统计，用户等级应该按下单时的值还是现在的值？** 处理这类变化的方法称为缓慢变化维（Slowly Changing Dimension）。

### 1、常见类型

| 类型 | 做法 | 历史 | 适用 |
|------|------|------|------|
| Type 0 | 保留原值，永不更新 | 只有初始值 | 注册日期、首单渠道 |
| Type 1 | 直接覆盖为新值 | 不保留 | 纠正错误数据、不关心历史的属性（如昵称） |
| Type 2 | 新增一行作为新版本，旧行标记失效 | 完整保留 | 会员等级、所在城市等需要按历史分析的属性 |
| Type 3 | 增加一列保存"上一个值" | 只保留一次变化 | 组织架构调整前后对比 |

Kimball 还定义了 Type 4 到 Type 7，本质都是以上几种的组合（如 Type 6 = 1 + 2 + 3），实际最常用的就是 Type 1 和 Type 2。

### 2、Type 1：覆盖

商品维度中，商品名称修正只需要最新值，用 `MERGE INTO` 按主键覆盖即可（`product_chg` 为当天去重后的商品变更数据）：

```sql
MERGE INTO dim_product t
USING product_chg s
ON t.product_id = s.product_id
WHEN MATCHED THEN UPDATE SET *
WHEN NOT MATCHED THEN INSERT *;
```

Spark 4.2 的声明式管道（Declarative Pipelines）还提供了 Auto CDC 能力，可以把变更流自动应用为 SCD Type 1 表，适合不想手写 MERGE 的场景。

### 3、Type 2：拉链表

拉链表是 SCD Type 2 在国内数仓中的通用叫法：每个版本一行，用 `start_date` 和 `end_date` 表示有效区间，当前有效版本的 `end_date` 统一为 `9999-12-31`。用户 1001 在 10 月 5 日从 `NORMAL` 升级为 `VIP` 后，表中是这样两行：

| user_id | user_level | city | start_date | end_date |
|---------|------------|------|------------|----------|
| 1001 | NORMAL | 杭州 | 2026-03-12 | 2026-10-04 |
| 1001 | VIP | 杭州 | 2026-10-05 | 9999-12-31 |

**建表与首日初始化**：

```sql
CREATE TABLE dim_user_zip (
    user_id    BIGINT,
    user_level STRING,
    city       STRING,
    start_date DATE,
    end_date   DATE
) USING iceberg;

-- 首日：用全量快照初始化，所有用户都是当前版本
INSERT INTO dim_user_zip
SELECT id, user_level, city, DATE '2026-10-01', DATE '9999-12-31'
FROM ods_user_info_full
WHERE dt = '2026-10-01';
```

**每日更新**：先把当天的增量变更按主键去重，再用一条 `MERGE INTO` 同时完成"关闭旧版本"和"插入新版本"。技巧在于把变更数据拼成两份：第一份带合并键，用于命中并关闭当前版本（新用户命中不到，直接插入）；第二份合并键为空，保证属性有变化的老用户一定走插入分支，生成新版本。

```sql
CREATE OR REPLACE TEMPORARY VIEW user_chg AS
SELECT id AS user_id, user_level, city
FROM (
    SELECT *, ROW_NUMBER() OVER (PARTITION BY id ORDER BY update_time DESC) AS rn
    FROM ods_user_info_inc
    WHERE dt = '2026-10-09'
) t
WHERE rn = 1;

MERGE INTO dim_user_zip t
USING (
    -- 第一份：用 user_id 作为合并键
    SELECT c.user_id AS merge_key, c.user_id, c.user_level, c.city
    FROM user_chg c
    UNION ALL
    -- 第二份：属性确实变化的老用户，合并键置空，必然走 NOT MATCHED 插入新版本
    SELECT CAST(NULL AS BIGINT) AS merge_key, c.user_id, c.user_level, c.city
    FROM user_chg c
    JOIN dim_user_zip z
      ON c.user_id = z.user_id AND z.end_date = DATE '9999-12-31'
    WHERE NOT (c.user_level <=> z.user_level AND c.city <=> z.city)
) s
ON t.user_id = s.merge_key AND t.end_date = DATE '9999-12-31'
WHEN MATCHED AND NOT (t.user_level <=> s.user_level AND t.city <=> s.city) THEN
    UPDATE SET end_date = DATE '2026-10-08'
WHEN NOT MATCHED THEN
    INSERT (user_id, user_level, city, start_date, end_date)
    VALUES (s.user_id, s.user_level, s.city, DATE '2026-10-09', DATE '9999-12-31');
```

这条语句对三种用户的处理：

| 用户情况 | 第一份数据 | 第二份数据 | 结果 |
|----------|------------|------------|------|
| 新注册用户 | 命中不到当前版本 → 插入 | 无（JOIN 不上） | 新增一个当前版本 |
| 属性有变化的老用户 | 命中当前版本 → 关闭（`end_date` 改为前一天） | 插入新版本 | 一旧一新两行 |
| 有更新但属性没变的老用户（如只改了昵称） | 命中但条件不满足 → 不动 | 无（被 WHERE 过滤） | 不变 |

注意事项：

- `<=>` 是 Spark SQL 的空值安全等于，`NULL <=> NULL` 为真，避免属性为空时被误判为变化
- Iceberg 要求目标表的每一行最多被源数据中的一行命中，否则报错，所以第一步必须按主键去重
- 粒度是"天"：同一天内多次变更只保留最后一次。需要更细粒度时把日期换成时间戳
- 只把需要追踪历史的属性放进比较条件；昵称、头像这类频繁变化又不需要历史的属性放进拉链会让表急剧膨胀，应拆到 Type 1 维度
- 在不支持 `MERGE` 的 Hive 表上，拉链表的经典做法是"旧拉链表 LEFT JOIN 当天变更关闭旧版本，UNION ALL 当天新版本，整体 INSERT OVERWRITE 到新表或新分区"，逻辑相同只是写法更长

**按历史版本关联**：事实表关联拉链维度时，用业务发生日期落在有效区间内作为关联条件，取到的就是"下单当时"的用户等级：

```sql
SELECT o.order_id, o.split_total_amount_fen, u.user_level
FROM dwd_trade_order_detail_inc o
JOIN dim_user_zip u
  ON o.user_id = u.user_id
 AND to_date(o.order_time) BETWEEN u.start_date AND u.end_date
WHERE o.dt = '2026-10-09';

-- 只要当前状态时，直接取当前版本
SELECT * FROM dim_user_zip WHERE end_date = DATE '9999-12-31';
```

---

## 七、宽表

宽表是把事实和大量维度属性预先 JOIN 好的反范式大表，例如把订单明细、用户属性、商品属性、地区、优惠券信息合并成一张上百列的 `dwd_trade_order_detail_wide`。

| 优点 | 代价 |
|------|------|
| 查询不需要 JOIN，分析师和 BI 工具易用 | 任一维度属性变化都要回刷整张宽表 |
| 列存格式下只读用到的列，宽本身不影响扫描量 | 维度属性的取值时点被固定（通常是加工当天），历史口径不灵活 |
| 配合 OLAP 引擎（Doris / StarRocks / ClickHouse）性能极好 | 列越加越多，最终没人知道每列的口径和来源 |

使用原则：

- **宽表是一种物化手段，不是建模方法**：先按维度模型建好事实表和维度表，再根据高频查询有选择地物化宽表；直接为每个需求建一张宽表，就退化回了烟囱式开发
- **放在 DWD 或 DWS 的末端**：DWD 宽表服务于明细查询和自助分析，DWS 宽表服务于固定的指标看板
- **控制维度属性的数量**：只放高频使用的属性，低频属性在查询时再 JOIN 维度表
- ClickHouse 擅长单表大宽表，Doris / StarRocks 的多表 JOIN 能力较强，可以少建宽表，选型见 [列式与 OLAP 数据库](/database/4_nosql/0_column_db)

---

## 八、数据域与命名规范

### 1、数据域

数据域是对业务过程的高层分类，用来组织事实表、划分团队职责，也是表名的一部分。电商常见的划分：

| 数据域 | 缩写 | 包含的业务过程 |
|--------|------|----------------|
| 交易域 | `trade` | 加购、下单、取消、支付、退款 |
| 用户域 | `user` | 注册、登录、实名认证 |
| 商品域 | `product` | 商品上下架、价格变更、收藏 |
| 流量域 | `traffic` | 页面浏览、曝光、点击、启动 |
| 营销域 | `marketing` | 领券、用券、活动参与 |
| 履约域 | `fulfil` | 发货、配送、签收 |

数据域一旦确定要保持稳定，新业务过程优先归入已有的域。域划分要和团队、业务方达成一致，并登记到数据治理平台，见 [数据治理](./8_governance)。

### 2、表命名

推荐格式：`{层}_{数据域}_{业务过程或主题}_{后缀}`，全部小写，下划线分隔：

| 层 | 命名模式 | 示例 |
|----|----------|------|
| ODS | `ods_{源表名}_{同步方式}` | `ods_order_info_inc`、`ods_product_full` |
| DIM | `dim_{维度名}_{存储方式}` | `dim_user_zip`、`dim_product_full`、`dim_date` |
| DWD | `dwd_{数据域}_{业务过程}_{同步方式}` | `dwd_trade_order_detail_inc`、`dwd_traffic_page_view_inc` |
| DWS | `dws_{数据域}_{统计粒度}_{业务过程}_{周期}` | `dws_trade_user_order_1d`、`dws_trade_province_order_nd` |
| ADS | `ads_{主题}_{描述}` | `ads_trade_gmv_1d`、`ads_user_retention` |

常用后缀约定：

| 后缀 | 含义 |
|------|------|
| `_inc` | 增量表，每个分区存当天新增或变化的数据 |
| `_full` | 全量快照表，每个分区存当天的完整数据 |
| `_zip` | 拉链表 |
| `_acc` | 累积快照事实表 |
| `_1d` / `_nd` / `_td` | 最近 1 日 / 最近 N 日 / 历史至今的汇总 |

字段命名同样要统一：金额以 `_amount` 结尾并在注释中写清单位，件数用 `_num`，次数用 `_count`，时间用 `_time`，日期用 `_date`；分区字段全仓统一为 `dt`（格式 `yyyy-MM-dd`），小时分区为 `hr`。规范写进团队文档后，最好在建表流程中用工具自动校验。

---

## 九、指标体系

指标是数仓最终交付给业务的东西，也是最容易出现口径之争的地方。业界常用阿里巴巴 OneData 方法论中的三类指标来规范定义：

### 1、原子、派生与衍生指标

| 类型 | 定义 | 构成 | 示例 |
|------|------|------|------|
| 原子指标 | 某个业务过程下的一个度量及其聚合方式，不可再拆分 | 业务过程 + 度量 + 聚合逻辑 | 下单金额 = 下单业务过程的 `SUM(split_total_amount)` |
| 派生指标 | 原子指标加上限定条件 | 原子指标 + 统计周期 + 业务限定 + 统计粒度 | 最近 7 日 · 手机品类 · 各省份 · 下单金额 |
| 衍生指标 | 在一个或多个派生指标基础上计算得到 | 比率、比例、变化量等 | 最近 7 日支付转化率 = 最近 7 日支付用户数 ÷ 最近 7 日下单用户数 |

四个限定要素各自的含义：

- **统计周期**：最近 1 日、最近 7 日、自然月、历史至今
- **业务限定**：对数据的筛选条件，如"手机品类""App 渠道""剔除测试订单"，可以复用在多个指标上
- **统计粒度**：按什么分组，如用户、省份、商品，一个粒度可以由多个维度组合
- **原子指标**：决定"算什么"

有了这套拆解，"最近 7 日各省份手机品类下单金额"就不再是一条孤立的 SQL，而是可以在 DWS 的 `dws_trade_province_order_nd` 表上按标准方式得到；不同报表引用同一个派生指标，结果必然一致。

### 2、指标字典

每个指标都要登记到指标字典，至少包含：

| 字段 | 示例 |
|------|------|
| 指标名称 / 英文名 | 支付 GMV / `pay_gmv` |
| 类型 | 派生指标 |
| 业务口径 | 统计周期内支付成功的订单实付金额之和，含运费，不扣除退款，剔除测试账号订单 |
| 技术口径 | `dws_trade_province_order_1d.pay_amount_fen_1d` 按日期汇总 |
| 统计周期 / 粒度 | 最近 1 日 / 全站、省份 |
| 负责人 | 交易域数据负责人 |

业务口径是给人看的，要写清楚含不含什么；技术口径指向具体的表和字段，便于追溯。口径变更必须走评审并记录版本，否则历史报表和当前报表会悄悄对不上。Spark 4.2 新增的指标视图（metric views）支持在 SQL 层声明式地定义语义模型，[OLAP 查询与数据服务](./7_olap_service) 中会讨论指标层与数据服务的结合方式。

---

## 小结

- 分层是为了统一口径、复用计算、隔离变化、便于追溯：ODS 贴源、DWD 明细、DWS 汇总、ADS 应用，DIM 存放公共维度；只向下引用、不跨层，每层按天分区并保证任务可重跑
- 维度建模四步：选择业务过程、声明粒度、确认维度、确认事实；总线矩阵规划事实表与一致性维度；数仓普遍采用星型模型，常用维度属性退化到事实表中减少 JOIN
- 事实表分事务、周期快照、累积快照、无事实四种；度量分可加、半可加、不可加，比例和去重数存分子分母或重新计算，不能逐层相加
- 缓慢变化维：Type 1 直接覆盖，Type 2 拉链表保留每个版本的有效区间；在 Iceberg 上可用一条 `MERGE INTO`（双份源数据技巧）完成每日拉链，事实表按业务日期落在区间内关联历史维度
- 宽表是在维度模型之上的物化手段，不是建模方法本身
- 表名按"层_数据域_业务过程_后缀"统一命名；指标拆成原子、派生、衍生三类，用指标字典登记业务口径与技术口径
- 相关阅读：Spark 本身的执行与调优见 [Spark](./3_spark)，Iceberg 的原理见 [数据湖与湖仓](./4_lakehouse)；实时数仓的分层在 Flink 侧的实现见 [实战场景](/flink/8_scenarios) 第三节和 [实时数仓实战](./9_realtime_dw)

## 参考资料

- Kimball 维度建模技术总览：[Dimensional Modeling Techniques](https://www.kimballgroup.com/data-warehouse-business-intelligence-resources/kimball-techniques/dimensional-modeling-techniques/)
- 缓慢变化维 Type 2：[Type 2: Add New Row](https://www.kimballgroup.com/data-warehouse-business-intelligence-resources/kimball-techniques/dimensional-modeling-techniques/type-2/)
- Iceberg Spark 写入（MERGE INTO、INSERT OVERWRITE）：[Spark Writes](https://iceberg.apache.org/docs/latest/spark-writes/)
- Iceberg Spark 配置与 SQL 扩展：[Spark Configuration](https://iceberg.apache.org/docs/latest/spark-configuration/)
- Spark SQL INSERT 语法：[INSERT TABLE](https://spark.apache.org/docs/latest/sql-ref-syntax-dml-insert-table.html)
- Spark 4.2.0 发布说明（Auto CDC、指标视图）：[Spark Release 4.2.0](https://spark.apache.org/releases/spark-release-4-2-0.html)
- 阿里云 DataWorks 数仓规划（数据域、业务过程、指标定义）：[DataWorks 数据建模](https://help.aliyun.com/zh/dataworks/user-guide/data-modeling/)

> 下一篇：[Spark](./3_spark)
