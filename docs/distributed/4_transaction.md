# 分布式事务

> 分布式事务解决跨服务、跨数据库操作的数据一致性问题。没有银弹，每种方案都是一致性与可用性的权衡。

---

## 一、本地事务 vs 分布式事务

**本地事务**：同一数据库连接内，ACID 由数据库引擎保证，简单可靠。

**分布式事务触发场景：**
- 跨库操作：订单库扣库存 + 账户库扣余额
- 跨服务调用：订单服务 → 库存服务 → 物流服务，任一失败需回滚
- 数据库 + 消息队列：写 DB 成功 + 发 MQ 消息，需保证两者同时成功或失败

**核心难点**：网络不可靠（超时/丢包），无法像本地事务一样原子操作。

---

## 二、XA 事务（2PC / 3PC）

### 2.1 XA 协议

XA 是 X/Open 组织定义的分布式事务规范，定义了事务管理器（TM）与资源管理器（RM，如 MySQL）之间的接口。Java 通过 `javax.transaction.xa.XAResource` 接入。

### 2.2 两阶段提交（2PC）

**角色：**
- **协调者（Coordinator / TM）**：发起并协调事务
- **参与者（Participant / RM）**：各数据库节点

**Phase 1 — 准备阶段（Prepare）：**
```
1. 协调者向所有参与者发送 Prepare 请求
2. 参与者执行事务操作（但不提交），写 Undo/Redo 日志，回复 Yes/No
```

**Phase 2 — 提交阶段（Commit/Rollback）：**
```
所有参与者回复 Yes → 协调者发送 Commit → 各参与者提交
任一参与者回复 No  → 协调者发送 Rollback → 各参与者回滚
```

**2PC 的问题：**

| 问题 | 说明 |
|------|------|
| 同步阻塞 | 参与者在 Prepare 后持有锁等待 Commit，期间无法服务其他请求 |
| 单点故障 | 协调者宕机后，参与者永久阻塞（不知道提交还是回滚） |
| 数据不一致 | 协调者发送 Commit 后部分参与者宕机，导致部分提交 |

### 2.3 三阶段提交（3PC）

在 2PC 基础上增加 **CanCommit** 阶段，并引入**超时机制**：

```
Phase 1 — CanCommit：询问参与者是否可以提交（不锁资源）
Phase 2 — PreCommit：参与者执行并锁定资源（类似2PC的Prepare）
Phase 3 — DoCommit：正式提交
```

**改进**：参与者在 PreCommit 超时后**默认提交**（而非阻塞），降低了阻塞概率。但仍存在协调者与参与者网络分区时的数据不一致问题，且更复杂，工程上很少直接使用。

::: tip 适用场景
2PC 适合对一致性要求极高、并发量不大的场景（如传统金融系统）。高并发互联网场景应选择柔性事务。
:::

---

## 三、TCC（Try-Confirm-Cancel）

### 3.1 原理

TCC 是**应用层**的两阶段提交，将业务逻辑分为三个操作：

| 阶段 | 说明 |
|------|------|
| **Try** | 预留资源（不真正执行业务），检查并锁定资源 |
| **Confirm** | 正式执行业务，使用 Try 阶段预留的资源 |
| **Cancel** | 释放 Try 阶段预留的资源，回滚 |

### 3.2 订单扣款示例

```
Try 阶段：
  - 订单服务：创建订单（状态=待确认）
  - 库存服务：冻结库存（可用库存-1，冻结库存+1）
  - 账户服务：冻结余额（余额-100，冻结金额+100）

Confirm 阶段（全部 Try 成功）：
  - 订单服务：更新订单状态=已确认
  - 库存服务：扣减冻结库存（冻结库存-1）
  - 账户服务：扣减冻结余额（冻结金额-100）

Cancel 阶段（任一 Try 失败）：
  - 订单服务：删除/取消订单
  - 库存服务：释放冻结库存（冻结库存-1，可用库存+1）
  - 账户服务：释放冻结余额（冻结金额-100，余额+100）
```

### 3.3 需要处理的问题

| 问题 | 解决方案 |
|------|---------|
| 空回滚 | Try 未执行就收到 Cancel（网络超时），Cancel 需判断 Try 是否执行过 |
| 幂等 | Confirm/Cancel 可能被重复调用，需保证幂等（记录执行状态） |
| 悬挂 | Cancel 先于 Try 执行完成后 Try 才到达，需拒绝迟到的 Try |

### 3.4 优缺点

| 优点 | 缺点 |
|------|------|
| 无长事务，性能较好 | 业务侵入性强，需实现三个接口 |
| 可精确控制资源预留 | 数据库需额外的冻结字段 |
| 适合强一致要求的场景 | 开发成本高 |

---

## 四、本地消息表（异步事务）

### 4.1 原理

将消息与业务操作存入**同一数据库**，利用本地事务保证两者的原子性，再由后台任务异步投递消息。

### 4.2 流程

```
1. 业务操作 + 写消息表 → 同一本地事务提交（原子）
2. 定时任务扫描消息表中未发送的消息 → 投递到 MQ
3. 消费方处理成功 → 回调更新消息状态为已完成
4. 超时未确认 → 重试投递（消费方需幂等）
```

**消息表结构（示意）：**
```sql
CREATE TABLE local_message (
    id          BIGINT PRIMARY KEY,
    biz_id      VARCHAR(64),       -- 业务唯一 ID
    topic       VARCHAR(128),      -- MQ Topic
    payload     TEXT,              -- 消息内容（JSON）
    status      TINYINT,           -- 0:待发送 1:已发送 2:已完成
    retry_count INT DEFAULT 0,
    created_at  DATETIME,
    updated_at  DATETIME
);
```

### 4.3 优缺点

| 优点 | 缺点 |
|------|------|
| 实现简单，不依赖 MQ 事务特性 | 消息表与业务库耦合 |
| 可靠性高（DB 可靠性保证） | 定时任务扫表有延迟 |
| | 消息表会膨胀，需定期清理 |

---

## 五、可靠消息最终一致性（基于 MQ）

### 5.1 原理

利用 MQ 的**事务消息**特性，在消息发送与业务操作之间建立原子性保证。

**以 RocketMQ 事务消息为例：**

```
1. Producer 发送 Half Message（半消息）到 Broker，此时消费方不可见
2. Broker 存储半消息，回复确认
3. Producer 执行本地事务
4. 本地事务成功 → Producer 发送 Commit → Broker 投递消息给消费方
   本地事务失败 → Producer 发送 Rollback → Broker 删除半消息
5. 若 Producer 宕机（第4步未执行）→ Broker 定期回查 Producer 的事务状态
```

### 5.2 消息回查

```java
// RocketMQ 事务监听器
public class OrderTransactionListener implements TransactionListener {

    @Override
    public LocalTransactionState executeLocalTransaction(Message msg, Object arg) {
        try {
            // 执行本地事务（如扣减库存）
            orderService.createOrder((OrderDTO) arg);
            return LocalTransactionState.COMMIT_MESSAGE; // 提交：MQ 消息可见
        } catch (Exception e) {
            return LocalTransactionState.ROLLBACK_MESSAGE; // 回滚：删除半消息
        }
    }

    @Override
    public LocalTransactionState checkLocalTransaction(MessageExt msg) {
        // Broker 回查：判断本地事务是否执行成功
        String orderId = msg.getUserProperty("orderId");
        return orderService.exists(orderId)
            ? LocalTransactionState.COMMIT_MESSAGE
            : LocalTransactionState.ROLLBACK_MESSAGE;
    }
}
```

### 5.3 优缺点

| 优点 | 缺点 |
|------|------|
| 与业务解耦，通用性强 | 最终一致，有延迟 |
| 依赖 MQ 的可靠性，无需额外消息表 | 消费方必须实现幂等 |
| 吞吐量高 | 需要 MQ 支持事务消息（RocketMQ 支持，Kafka 不直接支持） |

---

## 六、Saga 事务（长事务补偿机制）

### 6.1 原理

Saga 将长事务拆分为多个**本地事务**，每个本地事务都有对应的**补偿事务**（逆操作）。如果某步骤失败，按逆序执行已成功步骤的补偿操作。

```
正向：T1 → T2 → T3 → T4
补偿：C4 → C3 → C2 → C1（失败时逆序执行）
```

### 6.2 两种协调模式

**编排模式（Choreography）：**
各服务通过事件相互驱动，无中心协调者。服务完成后发布事件，下一个服务监听并执行。
- 优点：松耦合，无单点
- 缺点：流程分散，难以追踪整体状态

**orchestration（编制模式）：**
中心化 Saga 协调者（Orchestrator）按顺序调用各服务，并在失败时触发补偿。
- 优点：流程清晰，易于监控
- 缺点：协调者成为中心节点

### 6.3 旅游预订示例（编制模式）

```
Saga Orchestrator:
  1. 调用 航班服务.预订() → 成功
  2. 调用 酒店服务.预订() → 成功
  3. 调用 租车服务.预订() → 失败！
  
补偿（逆序）：
  2. 调用 酒店服务.取消()
  1. 调用 航班服务.取消()
```

### 6.4 与 TCC 的区别

| | TCC | Saga |
|---|---|---|
| 隔离性 | 资源预留，有一定隔离 | 无隔离，中间状态对外可见 |
| 业务侵入 | 高（需实现 Try/Confirm/Cancel） | 中（需实现补偿操作） |
| 适用场景 | 短流程、强隔离需求 | 长事务、跨多服务流程 |
| 典型应用 | 支付、扣款 | 订单完整流程、旅行预订 |

---

## 七、最大努力通知

### 7.1 原理

对一致性要求最低的方案。系统执行完操作后，通过消息或回调**尽力通知**下游，允许下游暂时不一致，但最终通过多次重试达到一致。

**典型场景**：支付宝支付结果通知商户。支付宝会在回调失败后，按 1min / 5min / 10min / 30min / 1h ... 的间隔持续重试，最长重试 24 小时。

### 7.2 流程

```
1. 上游执行业务（如支付成功）
2. 立即通知下游（回调 URL / MQ）
3. 若下游处理失败 → 按指数退避策略重试
4. 超过最大重试次数 → 记录失败日志，人工介入或下游主动查询对账
```

### 7.3 与可靠消息的区别

| | 最大努力通知 | 可靠消息最终一致 |
|---|---|---|
| 消息可靠性 | 尽力，不保证 | 保证（MQ 可靠投递） |
| 主动查询 | 下游需主动对账 | 不需要 |
| 适用场景 | 跨企业通知（支付回调） | 企业内部系统间 |

---

## 八、Seata 框架

### 8.1 简介

Seata（Simple Extensible Autonomous Transaction Architecture）是阿里开源的分布式事务框架，支持多种事务模式，屏蔽底层细节。

> 开源地址：[https://github.com/apache/incubator-seata](https://github.com/apache/incubator-seata)

### 8.2 四种模式

| 模式 | 一致性 | 隔离性 | 性能 | 业务侵入 |
|------|--------|--------|------|---------|
| **AT 模式** | 最终一致 | 读未提交（默认） | 高 | 无（自动回滚） |
| **TCC 模式** | 最终一致 | 取决于业务实现 | 高 | 高 |
| **Saga 模式** | 最终一致 | 无 | 高 | 中 |
| **XA 模式** | 强一致 | 支持 | 低 | 无 |

### 8.3 AT 模式原理（最常用）

AT 模式是 Seata 默认模式，对业务代码**零侵入**：

```
Phase 1（业务执行 + 镜像生成）：
  - 拦截 SQL，执行前保存"前镜像"（before image）
  - 执行业务 SQL
  - 执行后保存"后镜像"（after image）
  - 注册分支事务到 TC（Transaction Coordinator）

Phase 2（提交 or 回滚）：
  提交：TC 通知各分支异步删除镜像，释放锁
  回滚：TC 通知各分支用前镜像做逆向 SQL 补偿
```

**三个核心角色：**
- **TC（Transaction Coordinator）**：独立部署的 Seata Server，协调全局事务
- **TM（Transaction Manager）**：发起全局事务的服务（`@GlobalTransactional` 注解处）
- **RM（Resource Manager）**：各参与分支事务的服务

**使用示例：**
```java
@Service
public class OrderService {

    @GlobalTransactional  // 开启全局事务，其他服务自动参与
    public void createOrder(OrderDTO dto) {
        orderMapper.insert(dto);         // 本地操作
        inventoryService.deduct(dto);    // 远程调用，自动纳入全局事务
        accountService.deduct(dto);      // 远程调用，自动纳入全局事务
    }
}
```

---

## 九、方案选型总结

| 方案 | 一致性 | 性能 | 业务侵入 | 适用场景 |
|------|--------|------|---------|---------|
| 2PC（XA） | 强一致 | 低 | 无 | 低并发、强一致要求（金融） |
| TCC | 最终一致（高） | 高 | 高 | 短流程、核心支付类场景 |
| 本地消息表 | 最终一致 | 高 | 中 | 简单跨库通知，无 MQ 事务支持时 |
| 可靠消息（MQ） | 最终一致 | 高 | 低 | 跨服务异步解耦，主流互联网方案 |
| Saga | 最终一致 | 高 | 中 | 长事务、多步骤跨服务流程 |
| 最大努力通知 | 弱一致 | 最高 | 低 | 跨企业回调通知 |
| Seata AT | 最终一致 | 高 | 无 | 快速落地，单一公司内部系统 |

::: tip 互联网场景推荐
优先选择**可靠消息（RocketMQ 事务消息）**或 **Seata AT 模式**。前者吞吐量更高适合高并发，后者落地最快适合快速交付。严格避免在高并发场景使用 2PC。
:::
