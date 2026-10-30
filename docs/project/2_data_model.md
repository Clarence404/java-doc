---
description: 实体与模块归属、雪花 ID 与订单号、订单与明细表、状态机、按查询规划索引、条件更新扣库存、事务边界与下单幂等、数据量预估
---

# 数据建模

> 前置阅读：[MySQL 表设计规范](/database/1_mysql/3_table_design)、[MySQL 索引](/database/1_mysql/4_topic_index)、[分布式 ID 生成](/distributed/8_id_generator)

工程搭好后先定表结构：表有了线上数据，再改主键或金额类型的代价远高于改代码。本篇讲实体边界、订单与库存表、索引、事务与幂等，基线为 MySQL 8.4。

---

## 一、背景

阶段一的数字很小：日订单约 1 万，下单峰值约 20 QPS，平均每单 3 件商品，一台 MySQL 8.4 主库加一台从库做备份。按这个量，任何「正常」的表设计都扛得住，所以本篇真正要防的不是性能问题，而是三类**以后很难改**的坑：

| 坑 | 以后改的代价 |
|----|-------------|
| 订单号用自增 ID 直接对外 | 对外接口、支付渠道、客服系统都存了这个号，换号要全链路迁移 |
| 金额用 `FLOAT` / `DOUBLE` | 历史数据已有精度误差，对账永远对不平 |
| 订单代码里直接 `JOIN` 商品表、库存表 | 阶段三拆服务时，每条 SQL 都要改成接口调用 |

团队只有 3 个人，原则是：**表结构按阶段三能拆开的方式设计，实现按阶段一最简单的方式来**。

---

## 二、实体与边界

### 1、五张表与模块归属

阶段一只建五张核心表，每张表只归一个模块所有，其他模块不得直接读写：

| 表 | 所属模块 | 说明 |
|----|---------|------|
| `t_order` | mall-order | 订单主表：订单号、用户、状态、金额 |
| `t_order_item` | mall-order | 订单明细：一行一个商品，含下单时的商品快照 |
| `t_payment` | mall-order | 支付单：一笔订单可能有多次支付尝试；阶段一先放在订单模块 |
| `t_product` | mall-product | 商品：名称、售价、上下架状态 |
| `t_inventory` | mall-inventory | 库存：按 `sku_id` 一行，只存可售数量 |

![阶段一数据模型 ER 图](../assets/project/data-model-er.svg)

用户表归 mall-user，和订单只通过 `user_id` 关联，图中省略。商品阶段一不拆 SPU / SKU，`t_product` 的一行就是一个可售规格，`id` 即 `sku_id`；规格变多后再拆，订单侧只认 `sku_id`，不受影响。

### 2、单体里也不跨模块 JOIN

虽然五张表在同一个库里，订单模块也**不写**下面这种 SQL：

```sql
-- 不允许：订单模块的 Mapper 直接关联商品表
SELECT o.order_no, p.name FROM t_order o
JOIN t_order_item i ON i.order_id = o.id
JOIN t_product p ON p.id = i.sku_id
WHERE o.user_id = ?;
```

订单要用商品信息时，调用 mall-product 暴露的 Java 接口（如 `ProductApi.listByIds`），在内存里拼装。好处是以后把商品拆成独立服务时，只需把接口实现从本地调用换成 RPC，订单模块的 SQL 一行不改。为了让这条规则落地，工程上每个模块只扫描自己包下的 Mapper，代码评审时检查 `JOIN` 的表是否都属于本模块。

同样，**不建外键**：外键会让删除、迁移、拆库都受约束，引用关系由应用保证，图中虚线只表示逻辑引用。外键的取舍见 [MySQL 表设计规范](/database/1_mysql/3_table_design)。

---

## 三、主键与订单号

### 1、选项

| 方案 | 优点 | 代价 |
|------|------|------|
| 自增 ID 直接对外 | 最简单，聚簇索引顺序写入 | 订单号可被遍历，单日订单量一眼看出；拆库后多库自增冲突 |
| UUID v4 | 无需协调 | 36 字符、完全随机，B+ 树页分裂严重，二级索引都要带上这 16 字节 |
| UUID v7 | 按时间有序，标准化，无需分配机器号 | 仍是 16 字节，对用户太长，不适合当订单号念给客服 |
| 雪花 ID | 8 字节 `BIGINT`、趋势递增、不暴露业务量 | 需要分配机器号，依赖时钟，时钟回拨要处理 |

### 2、决策

- **主键 `id` 用雪花 ID**（`BIGINT`），由应用生成，不用数据库自增。阶段一只有两台应用机，机器号直接写在配置里（1 和 2），时钟回拨策略照搬 [分布式 ID 生成](/distributed/8_id_generator) 中的做法
- **对外订单号 `order_no` 单独一列**，阶段一取值就是雪花 ID 的十进制字符串（19 位）；之所以不直接用 `id`，是为阶段三留口子：分库分表时要把用户 ID 的低位「基因」嵌进订单号，让按订单号查询也能定位到分片，届时只改 `order_no` 的生成规则，主键不动
- **对前端一律按字符串返回**：19 位整数超过 JavaScript 的安全整数范围，按数字返回会丢精度
- **不用 UUID v7**：它解决的是「不想分配机器号」，而阶段一两台机器手工分配就够了；8 字节对 16 字节，在明细表、支付表的二级索引上每行都能省下 8 字节

---

## 四、订单表与明细表

### 1、金额：DECIMAL 还是分

金额只在 `DECIMAL` 和「以分为单位的 `BIGINT`」之间选，`FLOAT` / `DOUBLE` 直接排除。青柚商城只卖人民币，选 **`DECIMAL(12,2)` + Java `BigDecimal`**：SQL 里直接可读，运营导出报表、财务对账不需要再除以 100。代价是 Java 侧必须统一用 `BigDecimal` 并约定舍入规则（`HALF_UP` 保留 2 位），这一条写进编码规范。以后要做多币种时，再加 `currency` 列并评估改成最小货币单位。

### 2、状态与状态机

状态用 `TINYINT` 存，代码里用枚举，取值留间隔，方便以后插入中间状态：

| 值 | 枚举 | 含义 |
|----|------|------|
| 10 | `PENDING_PAYMENT` | 待支付 |
| 20 | `PENDING_SHIPMENT` | 待发货（已支付） |
| 30 | `SHIPPED` | 已发货 |
| 40 | `COMPLETED` | 已完成 |
| 50 | `CANCELLED` | 已取消（用户取消或超时未支付） |
| 60 | `CLOSED` | 已关闭（支付后全额退款） |

允许的流转只有下面几条，其余一律拒绝：

| 从 | 到 | 触发 |
|----|----|------|
| 待支付 | 待发货 | 支付成功 |
| 待支付 | 已取消 | 用户取消、超时 15 分钟未支付 |
| 待发货 | 已发货 | 仓库发货 |
| 待发货 | 已关闭 | 发货前全额退款 |
| 已发货 | 已完成 | 用户确认收货或 7 天自动确认 |

流转一律用**带旧状态的条件更新**，影响 0 行就说明状态已被别人改过：

```sql
UPDATE t_order SET status = 20, paid_at = NOW(3)
WHERE id = ? AND status = 10;
```

支付回调和超时取消同时到达时，只有一个能成功，这本身就是并发控制，状态流转不需要再加锁。

### 3、快照字段与乐观锁

- **快照**：明细表保存下单那一刻的商品名称、图片、单价。商品后来改名、调价，历史订单显示的仍是当时成交的样子，售后和对账也以快照为准
- **`version`**：只用于状态以外的字段修改，例如用户在待发货时改收货地址、客服同时改备注，用 `WHERE id = ? AND version = ?` 防止后写覆盖先写；状态流转走上面的条件更新，不碰 `version`
- **`created_at` / `updated_at`**：所有表都有，`updated_at` 由数据库 `ON UPDATE` 维护，后面做增量同步、数据核对都要用

### 4、建表语句

```sql
CREATE TABLE t_order (
    id              BIGINT        NOT NULL COMMENT '雪花 ID',
    order_no        VARCHAR(32)   NOT NULL COMMENT '对外订单号',
    user_id         BIGINT        NOT NULL,
    biz_no          VARCHAR(64)   NOT NULL COMMENT '下单幂等键，取自 Idempotency-Key 请求头',
    status          TINYINT       NOT NULL DEFAULT 10 COMMENT '10 待支付 20 待发货 30 已发货 40 已完成 50 已取消 60 已关闭',
    total_amount    DECIMAL(12,2) NOT NULL COMMENT '商品总额',
    freight_amount  DECIMAL(12,2) NOT NULL DEFAULT 0.00,
    discount_amount DECIMAL(12,2) NOT NULL DEFAULT 0.00,
    pay_amount      DECIMAL(12,2) NOT NULL COMMENT '应付 = 总额 + 运费 - 优惠',
    receiver_name   VARCHAR(64)   NOT NULL,
    receiver_phone  VARCHAR(32)   NOT NULL,
    receiver_addr   VARCHAR(255)  NOT NULL,
    remark          VARCHAR(255)  NOT NULL DEFAULT '',
    paid_at         DATETIME(3)   NULL,
    version         INT           NOT NULL DEFAULT 0,
    created_at      DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at      DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    PRIMARY KEY (id),
    UNIQUE KEY uk_order_no (order_no),
    UNIQUE KEY uk_user_biz (user_id, biz_no),
    KEY idx_user_id (user_id, id),
    KEY idx_status_created (status, created_at)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COMMENT = '订单';

CREATE TABLE t_order_item (
    id            BIGINT        NOT NULL COMMENT '雪花 ID',
    order_id      BIGINT        NOT NULL,
    sku_id        BIGINT        NOT NULL,
    product_name  VARCHAR(128)  NOT NULL COMMENT '快照：下单时商品名',
    product_image VARCHAR(255)  NOT NULL DEFAULT '' COMMENT '快照：下单时主图',
    unit_price    DECIMAL(12,2) NOT NULL COMMENT '快照：下单时单价',
    quantity      INT           NOT NULL,
    item_amount   DECIMAL(12,2) NOT NULL COMMENT 'unit_price × quantity',
    created_at    DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at    DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    PRIMARY KEY (id),
    KEY idx_order_id (order_id)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COMMENT = '订单明细';
```

收货信息阶段一直接平铺在订单表上；地址也是快照，用户之后改了地址簿不影响已下的单。没有 `deleted` 软删除列：订单不允许删除，用户「删除订单」只是隐藏，等真有这个需求再加一列。

---

## 五、索引规划

索引从查询清单反推，而不是看到哪个字段常用就给哪个字段建。阶段一的查询只有这几类：

| 查询 | SQL 形态 | 使用的索引 |
|------|---------|-----------|
| 用户订单列表 | `WHERE user_id = ? AND id < ? ORDER BY id DESC LIMIT 20` | `idx_user_id` |
| 用户按状态筛选 | 同上，加 `AND status = ?` | `idx_user_id`，状态在回表后过滤 |
| 按订单号查详情 | `WHERE order_no = ?` | `uk_order_no` |
| 后台按状态 + 时间查 | `WHERE status = ? AND created_at BETWEEN ? AND ?` | `idx_status_created` |
| 超时未支付扫描 | `WHERE status = 10 AND created_at < NOW() - INTERVAL 15 MINUTE` | `idx_status_created` |
| 下单幂等检查 | `WHERE user_id = ? AND biz_no = ?` | `uk_user_biz` |
| 订单明细 | `t_order_item WHERE order_id = ?` | `idx_order_id` |

几个取舍：

- **`(status, created_at)` 而不是反过来**：等值条件在前、范围条件在后，范围列之后的列用不上索引，原理见 [MySQL 索引](/database/1_mysql/4_topic_index)
- **用户列表按 `id` 而不是 `created_at` 排序**：雪花 ID 随时间递增，`ORDER BY id DESC` 近似就是最新的在前；`id` 唯一，游标只要一个值，不用处理同一毫秒多笔订单 `created_at` 相同的并列。二级索引末尾本来就带主键，写成 `(user_id, id)` 是把「靠它排序」写明
- **用户列表不建 `(user_id, status, id)`**：单个用户的订单通常只有几十到几百条，按 `user_id` 定位后过滤状态的代价很小；少一个索引就少一份写入开销
- **`status` 单列不建索引**：区分度低，单独使用时优化器多半不会选它
- **列表翻页用游标**：用上一页最后一条的 `id` 作为下一页的起点，不用大 `OFFSET`，接口形态在下一篇讲

---

## 六、库存表与扣减方式

### 1、选项

| 方案 | 做法 | 代价 |
|------|------|------|
| 先查后改 | `SELECT stock` 判断够不够，再 `UPDATE` | 两步之间有并发窗口，会超卖 |
| `SELECT ... FOR UPDATE` | 加行锁后判断再改 | 正确，但多一次交互，持锁时间更长 |
| 条件更新 | `UPDATE ... WHERE stock >= ?` 一条语句完成判断和扣减 | 只能表达「够不够」，无法记录每笔扣减明细 |
| Redis 预扣 | Lua 脚本在 Redis 扣，再异步落库 | 多一个数据源，要处理 Redis 与 MySQL 不一致、宕机丢数据 |

### 2、决策

阶段一选**条件更新**，和写订单放在同一个数据库事务里：

```sql
CREATE TABLE t_inventory (
    sku_id     BIGINT      NOT NULL,
    stock      INT         NOT NULL COMMENT '可售数量',
    updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    PRIMARY KEY (sku_id)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COMMENT = '库存';

-- 影响行数为 0 表示库存不足，整个下单事务回滚
UPDATE t_inventory SET stock = stock - #{quantity}
WHERE sku_id = #{skuId} AND stock >= #{quantity};

-- 取消订单时归还
UPDATE t_inventory SET stock = stock + #{quantity} WHERE sku_id = #{skuId};
```

- `stock >= ?` 由 InnoDB 行锁保证判断与扣减原子，不会超卖，也不需要 `version`：版本号会让库存充足时的并发请求也失败
- 一单多件商品时，**按 `sku_id` 升序扣减**，避免两个订单以相反顺序锁同两行导致死锁，加锁与死锁的分析见 [MySQL 事务与锁](/database/1_mysql/5_topic_transaction)
- **不上 Redis**：20 QPS 下单个 SKU 的行锁竞争可以忽略，引入 Redis 换来的只有一致性问题；阶段二商品详情读压力上来时先缓存商品，库存扣减仍走数据库，单 SKU 抢购的热点到大促阶段再处理
- **不做预占**：阶段一下单即扣、取消即还，不区分「预占」和「实扣」；阶段三库存独立成服务后，才需要预占记录来保证跨服务调用的幂等，见 [跨服务一致性](./7_consistency)

---

## 七、事务边界

下单在一个本地事务里完成：扣库存 + 写订单 + 写明细。这是全系列里唯一一处**跨模块共享一个事务**的地方，之所以允许，是因为阶段一所有表在同一个库里，本地事务最简单也最可靠；订单模块仍然只通过 `InventoryApi.deduct` 调用库存模块，不直接写 `t_inventory`。

```java
@Service
@RequiredArgsConstructor
public class PlaceOrderTxService {

    private final InventoryApi inventoryApi;
    private final OrderMapper orderMapper;
    private final OrderItemMapper orderItemMapper;

    @Transactional(rollbackFor = Exception.class)
    public Order create(long userId, String bizNo, PlaceOrderRequest req, List<PricedItem> items) {
        items.stream()
             .sorted(Comparator.comparing(PricedItem::skuId))
             .forEach(i -> {
                 if (!inventoryApi.deduct(i.skuId(), i.quantity())) {
                     throw new BizException(InventoryErrorCode.STOCK_INSUFFICIENT);
                 }
             });
        Order order = Order.create(userId, bizNo, req, items);  // 生成雪花 ID 与订单号，状态 10
        orderMapper.insert(order);                   // 撞 uk_user_biz 抛 DuplicateKeyException
        orderItemMapper.batchInsert(order.items());
        return order;
    }
}
```

几条约束，每条都对应一个常见的事务失效或长事务问题，详见 [事务管理](/spring/4_transaction) 与 [MySQL 避坑指南](/database/1_mysql/3_fallible_point)：

- **事务方法放在单独的 Bean 里**，由外层应用服务 `PlaceOrderService` 调用；同类内部 `this.create()` 调用不经过代理，事务不生效
- **计价、查商品放在事务外**：先查商品、算好价格（`PricedItem`）再进事务，事务里只剩写操作，持锁时间最短
- **调用支付、发通知不进事务**：远程调用超时会把行锁一直挂着；它们放到事务提交之后
- **不在事务内部 `catch` 唯一键冲突**：撞唯一键时库存已经扣了，在事务里吞掉异常、正常返回，扣减会跟着一起提交，库存白白少掉；让异常抛出事务方法、整体回滚，冲突在外层处理，见下一节

---

## 八、下单幂等

用户双击提交、网络超时后客户端重试，都会让同一笔下单请求到达两次。做法是**客户端在进入确认页时生成幂等键**，提交时放在 `Idempotency-Key` 请求头里，服务端把它存进 `t_order.biz_no`，用唯一约束 `uk_user_biz (user_id, biz_no)` 兜底：

```java
// PlaceOrderService：应用服务，不加 @Transactional
public PlaceOrderResult place(long userId, String bizNo, PlaceOrderRequest req) {
    Order existing = orderMapper.selectByUserAndBizNo(userId, bizNo);
    if (existing != null) {
        return PlaceOrderResult.replayed(existing);   // 重复请求，返回第一次的结果
    }
    List<PricedItem> items = pricingService.price(req);   // 事务外计价
    try {
        return PlaceOrderResult.created(placeOrderTxService.create(userId, bizNo, req, items));
    } catch (DuplicateKeyException e) {
        // 并发的两个请求都通过了前面的查询，后插入的撞唯一键，事务已整体回滚，库存也已归还
        return PlaceOrderResult.replayed(orderMapper.selectByUserAndBizNo(userId, bizNo));
    }
}
```

- 先查是快速路径，**唯一约束才是正确性的保证**：两个并发请求可能都查不到，但只会有一个插入成功
- 撞唯一键时扣库存和写订单在同一个事务里一起回滚，不会出现「库存扣了、订单没有」
- 唯一键带上 `user_id`，防止不同用户碰巧生成相同的幂等键互相干扰
- 幂等键的生成时机、长度（16–64 字符）和重放时的响应在接口层约定，见 [接口设计](./3_api_design)；幂等的通用方案见 [幂等设计](/architecture/3_idempotence)

---

## 九、数据量预估

| 表 | 年增量 | 单行估算 | 年数据量（含索引） |
|----|-------|---------|------------------|
| `t_order` | 1 万 × 365 ≈ 365 万行 | 约 400 B | 约 2–3 GB |
| `t_order_item` | 365 万 × 3 ≈ 1100 万行 | 约 250 B | 约 4–5 GB |
| `t_payment` | 约 400 万行（含重复支付尝试） | 约 200 B | 约 1–2 GB |
| `t_product` / `t_inventory` | 几万行，基本不增长 | — | 可忽略 |

单表几千万行、十几 GB，在有合适索引、查询都走索引的前提下，MySQL 8.4 单表完全够用。三年后明细表也只有三千多万行，所以阶段一**不分库分表、不做归档**。

需要重新评估的信号是：日订单涨到 100 万（年增 3.65 亿行），或者订单表单表超过 5000 万行、热数据装不进 Buffer Pool。按演进路线，这发生在阶段三，届时再决定按 `user_id` 分库分表还是先做冷热分离。

---

## 十、代价与后续

| 本篇的决策 | 带来的问题 | 在哪里解决 |
|-----------|-----------|-----------|
| 列表、详情都直接查主库 | 阶段二商品详情读到 2000 QPS，数据库读压力大 | [引入缓存](./4_cache) |
| 支付、通知在事务提交后同步调用 | 第三方变慢会拖慢下单接口 | [异步化](./5_async) |
| 超时未支付靠定时扫描取消 | 扫描有分钟级延迟，量大后扫描本身变重 | [异步化](./5_async)（定时消息 + 扫描兜底） |
| 下单与扣库存共享一个本地事务 | 库存拆成独立服务后，本地事务不再成立 | [跨服务一致性](./7_consistency) |
| 订单号就是雪花 ID 字符串 | 分库分表后按订单号查不到分片 | [拆分服务](./6_split) 阶段改为嵌入用户 ID 低位 |

最终形态（库存预占、Outbox、分库分表）见 [订单](/scenario/5_order_system)。

---

## 小结

- 五张表各归一个模块，单体里也不跨模块 `JOIN`、不建外键，为阶段三拆服务留好接缝
- 主键用 8 字节雪花 ID，对外订单号单独一列并按字符串返回；不用自增对外，也不用 16 字节的 UUID v7
- 金额用 `DECIMAL(12,2)` + `BigDecimal`；状态用 `TINYINT` 枚举，只靠「带旧状态的条件更新」流转
- 明细表保存商品名称、图片、单价快照；`version` 只管状态以外的字段修改
- 索引从查询清单反推：`(user_id, id)` 给用户列表的游标翻页，`(status, created_at)` 给后台查询和超时扫描
- 库存用 `stock >= n` 条件更新扣减，按 `sku_id` 升序避免死锁；阶段一不上 Redis、不做预占
- 下单 = 扣库存 + 写订单 + 写明细，一个本地事务；`uk_user_biz` 唯一约束兜底幂等，冲突在事务外处理
- 一年 365 万订单、1100 万明细，单表足够，阶段三再评估分库分表

## 参考资料

- MySQL 8.4 Reference Manual - Fixed-Point Types (DECIMAL)：[https://dev.mysql.com/doc/refman/8.4/en/fixed-point-types.html](https://dev.mysql.com/doc/refman/8.4/en/fixed-point-types.html)
- MySQL 8.4 Reference Manual - Multiple-Column Indexes：[https://dev.mysql.com/doc/refman/8.4/en/multiple-column-indexes.html](https://dev.mysql.com/doc/refman/8.4/en/multiple-column-indexes.html)
- RFC 9562 - Universally Unique IDentifiers (UUIDs)：[https://www.rfc-editor.org/rfc/rfc9562](https://www.rfc-editor.org/rfc/rfc9562)
- Spring Framework - Declarative Transaction Management：[https://docs.spring.io/spring-framework/reference/data-access/transaction/declarative.html](https://docs.spring.io/spring-framework/reference/data-access/transaction/declarative.html)

> 下一篇：[接口设计](./3_api_design) —— REST 规范、错误码、幂等与接口文档
