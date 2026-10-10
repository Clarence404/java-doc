---
description: 2PC 与 XA、TCC、Saga、本地消息表、RocketMQ 事务消息、Seata 四种模式、选型
---

# 分布式事务

> 前置阅读：[分布式理论](./2_theorem)、[MySQL 事务与锁](/database/1_mysql/5_topic_transaction)

本篇是分布式事务原理与 Seata 机制的主文档，对比 2PC / XA、TCC、Saga、本地消息表、事务消息与最大努力通知的一致性保证与代价，并讲 Seata AT 全局锁、TCC 空回滚 / 幂等 / 悬挂处理与方案选型。

---

## 一、先问能不能不用

本地事务由数据库保证 ACID，简单可靠。下面这些情况会跨出单个本地事务：

- **跨库**：订单库建单，账户库扣余额
- **跨服务**：订单服务调用库存服务、支付服务
- **数据库 + 消息队列**：写库成功后要发一条消息通知下游

难点在于网络不可靠：调用超时时，不知道对方到底成功还是失败。没有任何方案能在网络分区下同时做到强一致、高可用、高性能（见 [分布式理论](./2_theorem)）。

所以第一步是**尽量不产生分布式事务**：

- 调整服务边界，让必须原子变更的数据落在同一个服务、同一个库里
- 能接受最终一致的，用「本地事务 + 可靠消息」，下游异步处理
- 只有确实需要同步得到一致结果的链路，才考虑 TCC、Seata 等协调方案

---

## 二、2PC 与 XA

### 1、XA 规范

XA 是 X/Open 定义的接口规范，规定事务管理器（TM）与资源管理器（RM，如 MySQL）之间如何做两阶段提交。Java 通过 JTA（`jakarta.transaction`）和 `javax.transaction.xa.XAResource` 接入。MySQL InnoDB 原生支持 `XA START / END / PREPARE / COMMIT`。

### 2、两阶段提交流程

1. **准备阶段**：协调者向所有参与者发送 Prepare；参与者执行操作、写好 redo / undo、**持有锁不提交**，回复 Yes 或 No
2. **提交阶段**：全部 Yes 则发送 Commit，任一 No 或超时则发送 Rollback；参与者执行后释放锁

| 问题 | 说明 |
|------|------|
| 同步阻塞 | 参与者从 Prepare 到 Commit 一直持有行锁，热点数据吞吐大幅下降 |
| 协调者单点 | 协调者在发出决议前宕机，已 Prepare 的参与者不知道该提交还是回滚，只能等协调者恢复 |
| 部分提交 | Commit 发出后部分参与者没收到，短时间内数据不一致，需要协调者恢复后重发 |

### 3、3PC

3PC 在 Prepare 前加一个 CanCommit 询问，并让参与者在 PreCommit 后超时**默认提交**，以减少阻塞。但网络分区时，一侧超时提交、另一侧收到 Abort，反而会产生不一致，工程上几乎没有实现。

### 4、实际可用的 2PC

- **MySQL XA / JTA 事务管理器**（Atomikos、Narayana）：强一致，适合低并发、跨少量数据库的场景
- **Seata XA 模式**：由 Seata 充当协调者，参与者是支持 XA 的数据库（见第八节）

---

## 三、TCC

### 1、原理

TCC 是业务层的两阶段提交，每个参与者提供三个接口：

| 阶段 | 职责 |
|------|------|
| **Try** | 检查并**预留**资源（冻结），不做最终变更 |
| **Confirm** | 使用预留的资源完成业务，不再做检查，必须能成功（失败就重试） |
| **Cancel** | 释放预留的资源 |

以扣余额为例，账户表增加冻结字段：

| 阶段 | 账户服务的操作 |
|------|----------------|
| Try | `UPDATE account SET balance = balance - 100, frozen = frozen + 100 WHERE id = ? AND balance >= 100` |
| Confirm | `UPDATE account SET frozen = frozen - 100 WHERE id = ?` |
| Cancel | `UPDATE account SET balance = balance + 100, frozen = frozen - 100 WHERE id = ?` |

TCC 是**最终一致**的：Try 之后、Confirm 之前存在中间状态，只是被冻结字段隔离开，其他事务不会用到被预留的资源（业务层面的隔离）。

### 2、空回滚、幂等与悬挂

网络超时和重试会让 Try / Confirm / Cancel 以意外的顺序或次数到达：

| 问题 | 场景 | 处理 |
|------|------|------|
| 空回滚 | Try 请求丢了或超时，协调者发起 Cancel，此时根本没有可释放的资源 | Cancel 发现没有 Try 记录时直接返回成功，并记录「已回滚」 |
| 幂等 | Confirm / Cancel 失败后被重试 | 按全局事务 ID + 分支 ID 记录执行状态，重复调用直接返回 |
| 悬挂 | Try 网络延迟，Cancel 先执行完，迟到的 Try 才到达并冻结资源，再也没人释放 | Try 执行前检查是否已有「已回滚」记录，有则拒绝执行 |

三者都依赖一张事务控制表，并且记录要与业务操作在**同一个本地事务**里写。Seata 1.5 起提供 **TCC Fence**：开启 `useTCCFence = true` 后，框架用 `tcc_fence_log` 表自动处理这三个问题，前提是 TCC 方法运行在本地事务中、且与业务表使用同一个数据源。

### 3、优缺点

| 优点 | 缺点 |
|------|------|
| 不持有数据库长锁，性能好 | 每个参与者都要实现三个接口，侵入大 |
| 资源预留粒度可控，适合资金类场景 | 需要冻结字段或预留表，以及事务控制表 |
| 不依赖数据库的 XA 能力 | Confirm / Cancel 必须幂等且最终成功，开发测试成本高 |

---

## 四、Saga

### 1、原理

Saga（Garcia-Molina 与 Salem，1987）把长事务拆成一串本地事务 T1…Tn，每个 Ti 有对应的补偿 Ci。某一步失败时，**逆序补偿已经完成的步骤**。

如果 T3 失败，T3 自己的本地事务已经回滚，需要执行的是 C2 → C1，而不是 C3：

![Saga 编排：T3 失败后逆序补偿](../assets/distributed/saga-orchestration.svg)

补偿的要求：

- **幂等**：补偿可能被重复调用
- **可重试直到成功**：补偿不能「失败了就算了」，只能不断重试或转人工
- **允许空补偿**：补偿时发现正向操作没执行过，直接成功

### 2、编排与协同

| | 编排（Orchestration） | 协同（Choreography） |
|---|---|---|
| 驱动方式 | 中心编排器按顺序调用各服务，失败时触发补偿 | 各服务完成后发布事件，下一个服务订阅事件继续 |
| 优点 | 流程集中、状态可查、容易监控与重试 | 无中心节点，服务间松耦合 |
| 缺点 | 编排器要高可用、持久化每一步状态 | 流程分散在各服务，难追踪；容易形成事件环 |
| 适合 | 步骤多、需要可视化和人工介入的流程 | 步骤少、链路简单的流程 |

编排器的实现可以是 Seata Saga 状态机（JSON 定义流程），也可以是 Temporal 这类持久化执行引擎（流程代码化，引擎记录每一步结果，崩溃后从断点继续），见 [工作流引擎](./7_work_flow)。

### 3、隔离性问题

Saga 没有隔离：T1 提交后，在 Saga 结束前其他事务就能看到它的结果，可能出现读到稍后被补偿的数据、或在补偿前被其他事务修改。常用对策：

- **语义锁**：正向步骤把数据置为中间状态（如订单「待支付」），其他流程看到中间状态就等待或拒绝
- **可交换的更新**：设计成先后顺序无关的操作（如增减库存而不是覆盖库存值）
- **重读校验**：补偿或后续步骤执行前重新读取数据，确认没被他人改过

### 4、与 TCC 对比

| | TCC | Saga |
|---|---|---|
| 隔离 | 资源预留，中间状态对外不可用 | 无隔离，需要语义锁等对策 |
| 侵入 | 三个接口 + 冻结字段 | 正向操作 + 补偿操作 |
| 时长 | 短流程，秒级 | 可以是长流程（分钟到天） |
| 典型场景 | 扣款、扣积分 | 订单全流程、旅行预订、跨企业流程 |

---

## 五、本地消息表（Transactional Outbox）

### 1、原理

解决「写库 + 发消息」的原子性：**不在数据库事务里直接发 MQ**（事务回滚了消息却已发出，或提交了却没发出去），而是在同一个本地事务里写业务表和消息表，再由投递程序把消息表里的记录发到 MQ。

1. 同一本地事务写业务数据和一条 `NEW` 状态的消息记录
2. 投递程序把消息发送到 MQ，收到 Broker 确认后标记为 `SENT`
3. 失败的记录按退避策略重试，超过上限告警
4. 消费方按消息 ID 或业务键做幂等，因为投递可能重复

```sql
CREATE TABLE outbox_message (
    id           BIGINT       PRIMARY KEY,
    biz_key      VARCHAR(64)  NOT NULL,           -- 业务唯一键，如订单号 + 事件类型
    topic        VARCHAR(128) NOT NULL,
    payload      JSON         NOT NULL,
    status       TINYINT      NOT NULL DEFAULT 0, -- 0:NEW 1:SENT 2:FAILED
    retry_count  INT          NOT NULL DEFAULT 0,
    next_retry_at DATETIME    NOT NULL,
    created_at   DATETIME     NOT NULL,
    UNIQUE KEY uk_biz_key (biz_key),
    KEY idx_status_retry (status, next_retry_at)
);
```

### 2、生产要点

- **提交后立即投递，扫表兜底**：用 `@TransactionalEventListener(phase = AFTER_COMMIT)` 或 `TransactionSynchronization.afterCommit` 在提交后立即发送，定时扫表只处理漏发和失败的记录，避免轮询带来的延迟
- **多实例扫表**：用 `SELECT ... FOR UPDATE SKIP LOCKED`（MySQL 8.0+ / PostgreSQL）或按 ID 分片，避免多个实例重复投递同一条
- **CDC 替代轮询**：用 Debezium 的 Outbox Event Router 读取 binlog 投递，业务侧只管写表
- **定期归档**：已发送的记录按时间归档或删除，防止表膨胀
- 消费方的「处理成功后回调更新状态」不是必需步骤，消费端靠幂等即可

完整的投递代码与各 MQ 的确认机制见 [消息队列基础](/messaging/1_basics#八、分布式事务中的消息)。

---

## 六、RocketMQ 事务消息

### 1、流程

RocketMQ 把「本地事务 + 发消息」做成了两阶段，效果与本地消息表相同，但不需要自建消息表和投递程序：

![RocketMQ 事务消息与回查](../assets/distributed/rocketmq-tx-message.svg)

关键在回查：Broker 迟迟收不到二次确认时，会回调生产者查询本地事务状态。**回查可能在本地事务还没执行完时到达**（慢事务、大事务），此时查不到记录不代表失败，必须返回 `UNKNOW` 让 Broker 稍后再查；直接返回回滚会丢掉一条本该提交的消息。

### 2、代码

下面用 RocketMQ 的 Remoting 客户端（`rocketmq-client`，可连接 5.x Broker）。本地事务里建的订单本身就是「事务日志」，回查时按订单号查询：

```java
// 发送：订单号放进用户属性，供回查使用
Message msg = new Message("order-created", objectMapper.writeValueAsBytes(dto));
msg.putUserProperty("orderNo", dto.getOrderNo());
producer.sendMessageInTransaction(msg, dto);   // producer 是 TransactionMQProducer，已设置下面的监听器
```

```java
@Component
@RequiredArgsConstructor
public class OrderTxListener implements TransactionListener {

    private static final long CHECK_GRACE_MILLIS = Duration.ofMinutes(5).toMillis();

    private final OrderService orderService;

    @Override
    public LocalTransactionState executeLocalTransaction(Message msg, Object arg) {
        try {
            orderService.createOrder((OrderDTO) arg);       // 本地事务：写订单表
            return LocalTransactionState.COMMIT_MESSAGE;
        } catch (Exception e) {
            return LocalTransactionState.ROLLBACK_MESSAGE;
        }
    }

    @Override
    public LocalTransactionState checkLocalTransaction(MessageExt msg) {
        String orderNo = msg.getUserProperty("orderNo");
        if (orderService.exists(orderNo)) {
            return LocalTransactionState.COMMIT_MESSAGE;
        }
        // 查不到：本地事务可能还在执行，未超过宽限期就让 Broker 稍后再查
        long age = System.currentTimeMillis() - msg.getBornTimestamp();
        return age < CHECK_GRACE_MILLIS
                ? LocalTransactionState.UNKNOW
                : LocalTransactionState.ROLLBACK_MESSAGE;
    }
}
```

要点：

- `executeLocalTransaction` 返回 `UNKNOW` 或进程崩溃时，Broker 按 `transactionCheckInterval` 周期回查，超过 `transactionCheckMax` 次（默认 15）后丢弃半消息
- 宽限期要大于本地事务的最长执行时间；更严谨的做法是在同一本地事务中写一张以事务 ID 为主键的事务日志表，回查只查日志
- 5.x 的 gRPC 客户端（`rocketmq-client-java`）用 `TransactionChecker` 和 `producer.beginTransaction()`，语义相同
- 消费端仍需幂等

更多 RocketMQ 事务消息配置见 [RocketMQ](/messaging/3_rocketmq#七、事务消息)。

### 3、Kafka 为什么不行

Kafka 事务保证的是**多个分区写入的原子性**，以及「消费-处理-生产」的 Exactly Once，它无法与外部数据库事务绑定。使用 Kafka 时，「写库 + 发消息」仍要用本地消息表或 CDC。

---

## 七、最大努力通知

上游完成业务后通知下游，失败按递增间隔重试有限次数，并**提供查询接口让下游主动对账**兜底。一致性最弱，但最简单，适合跨企业的结果通知。

典型是支付结果回调：支付宝在 25 小时内最多发送 8 次异步通知，间隔逐步拉长（国际站文档给出 2m、10m、10m、1h、2h、6h、15h，具体以所接入产品的文档为准），直到商户返回约定的成功字符串。

| | 最大努力通知 | 本地消息表 / 事务消息 |
|---|---|---|
| 可靠性 | 有限次重试，可能放弃 | 持续重试直到成功 |
| 兜底 | 下游主动查询、定期对账 | 投递方重试，消费方幂等 |
| 适用 | 跨企业、跨系统通知 | 企业内部服务间 |

接收方要先验签、做幂等处理，再返回成功应答。

---

## 八、Seata

### 1、简介

Seata 由阿里巴巴开源，2023 年进入 Apache 孵化器（截至本文，仍为孵化项目），2.x 起 groupId 为 `org.apache.seata`、包名为 `org.apache.seata.*`。架构有三个角色：

- **TC**（Transaction Coordinator）：独立部署的 seata-server，维护全局事务和分支状态、管理全局锁
- **TM**（Transaction Manager）：发起全局事务的一方，即标注 `@GlobalTransactional` 的方法
- **RM**（Resource Manager）：管理分支事务，向 TC 注册分支、汇报状态、执行二阶段

全局事务 ID（XID）随 RPC 调用在服务间透传。

### 2、四种模式

| 模式 | 一致性 | 隔离 | 侵入 | 性能 | 适用 |
|------|--------|------|------|------|------|
| AT | 最终一致（二阶段异步） | 写隔离靠全局锁，读默认读未提交 | 几乎无 | 较高，热点行受全局锁限制 | 普通业务，关系库，想快速落地 |
| TCC | 最终一致 | 业务资源预留 | 高 | 高 | 资金类、非关系型资源 |
| Saga | 最终一致 | 无 | 中 | 高 | 长流程、调用遗留系统 |
| XA | 强一致 | 数据库 XA 隔离 | 几乎无 | 低（锁持有到二阶段） | 强一致、低并发 |

### 3、AT 模式

![Seata AT 模式两阶段流程](../assets/spring-cloud/seata-at.svg)

一阶段（每个 RM）：

1. 解析业务 SQL，查出修改前的数据作为**前镜像**
2. 执行业务 SQL，查出修改后的数据作为**后镜像**
3. 把前后镜像写入 `undo_log` 表，与业务 SQL 在**同一个本地事务**里
4. 提交本地事务前，向 TC 注册分支并申请这些行的**全局锁**
5. 拿到全局锁后提交本地事务，释放本地行锁；拿不到全局锁则重试，超时后回滚本地事务

二阶段：

- **全局提交**：TC 立即释放全局锁，各分支异步删除 `undo_log`，非常快
- **全局回滚**：各分支先拿后镜像与当前数据比对，一致则用前镜像生成反向 SQL 恢复数据并删除 `undo_log`；**不一致说明数据被 Seata 之外的写入改过（脏写），回滚失败，需要人工处理**

隔离性：

- **写隔离**：全局锁保证一个全局事务未结束前，其他全局事务不能改同一行，避免脏写
- **读隔离**：全局层面默认是**读未提交**，其他事务能读到一阶段已提交、但之后会回滚的数据。需要读已提交时用 `SELECT ... FOR UPDATE`，Seata 代理会检查全局锁
- 不在全局事务中、但会修改同一批表的本地方法，加 `@GlobalLock`（配合 `SELECT ... FOR UPDATE`）让它也检查全局锁；完全绕过 Seata 数据源代理的写入（其他系统直接改库）是回滚失败的主要来源

代价：热点行在整个全局事务期间被全局锁串行化，**不适合秒杀库存这类热点更新**。

```java
import org.apache.seata.spring.annotation.GlobalTransactional;

@Service
@RequiredArgsConstructor
public class OrderAppService {

    private final OrderMapper orderMapper;
    private final InventoryClient inventoryClient;   // OpenFeign，XID 由 starter 自动透传
    private final AccountClient accountClient;

    @GlobalTransactional(name = "create-order", timeoutMills = 30000, rollbackFor = Exception.class)
    public void createOrder(OrderDTO dto) {
        orderMapper.insert(Order.from(dto));
        inventoryClient.deduct(dto.getSkuId(), dto.getCount());
        accountClient.debit(dto.getUserId(), dto.getAmount());
    }
}
```

每个参与的数据库都要建 `undo_log` 表；依赖与配置见 [Spring Cloud Alibaba](/spring-cloud/6_alibaba)。

### 4、TCC 模式

```java
import org.apache.seata.rm.tcc.api.BusinessActionContext;
import org.apache.seata.rm.tcc.api.BusinessActionContextParameter;
import org.apache.seata.rm.tcc.api.LocalTCC;
import org.apache.seata.rm.tcc.api.TwoPhaseBusinessAction;

@LocalTCC
public interface AccountTccAction {

    @TwoPhaseBusinessAction(name = "accountDebit",
            commitMethod = "confirm", rollbackMethod = "cancel", useTCCFence = true)
    boolean tryDebit(@BusinessActionContextParameter(paramName = "userId") Long userId,
                     @BusinessActionContextParameter(paramName = "amount") BigDecimal amount);

    boolean confirm(BusinessActionContext ctx);

    boolean cancel(BusinessActionContext ctx);
}
```

实现类的三个方法上加 `@Transactional`，`tcc_fence_log` 建在与业务表相同的库里。开启 TCC Fence 后，空回滚、幂等、悬挂由框架处理，业务只写冻结与解冻逻辑。

### 5、Saga 与 XA 模式

- **Saga 模式**：用状态机 JSON 描述每一步的正向服务与补偿服务，由状态机引擎驱动执行与补偿，适合长流程和无法改造成 TCC 的遗留服务
- **XA 模式**：分支使用数据库的 XA 事务，一阶段 `XA PREPARE` 后持有锁，二阶段统一提交或回滚。强一致，但锁持有时间长，吞吐低

---

## 九、方案选型

| 方案 | 一致性 | 性能 | 侵入 | 适用场景 |
|------|--------|------|------|----------|
| 本地事务（调整边界） | 强一致 | 最高 | 无 | 首选，能合并就合并 |
| 本地消息表 / Outbox | 最终一致 | 高 | 中 | 写库后通知下游，通用，不绑定 MQ |
| RocketMQ 事务消息 | 最终一致 | 高 | 中（实现回查） | 已使用 RocketMQ 的核心链路 |
| 最大努力通知 | 尽力而为 + 对账 | 高 | 低 | 跨企业回调 |
| TCC | 最终一致，业务隔离 | 高 | 高 | 资金、库存预留，需要同步结果 |
| Saga | 最终一致，无隔离 | 高 | 中 | 长流程、跨多个服务或外部系统 |
| Seata AT | 最终一致，全局锁写隔离 | 中 | 低 | 内部系统、非热点数据、需要同步结果 |
| XA / Seata XA | 强一致 | 低 | 低 | 低并发、强一致 |

建议顺序：

1. 先通过服务边界设计避免分布式事务
2. 能异步的用本地消息表或事务消息，下游幂等消费
3. 必须同步得到一致结果时：资金类用 TCC，其他内部业务可以用 Seata AT（避开热点行）
4. 长流程用 Saga，配合语义锁处理隔离
5. 所有方案都要有对账和人工补偿兜底

---

## 小结

- 分布式事务的首选是不产生分布式事务；其次是本地事务 + 可靠消息的最终一致
- 2PC 强一致但阻塞、协调者单点；3PC 几乎不用；实际可用的是 MySQL XA 与 Seata XA
- TCC 靠资源预留实现业务隔离，必须处理空回滚、幂等、悬挂，Seata TCC Fence 用 `tcc_fence_log` 自动处理
- Saga 只补偿已完成的步骤，补偿要幂等并重试到成功；编排集中可控，协同松耦合但难追踪
- 不要在数据库事务里发 MQ：用本地消息表（提交后立即发 + 扫表兜底）或 RocketMQ 事务消息
- 事务消息回查查不到记录时，本地事务可能仍在执行，应返回 `UNKNOW`
- Seata AT 一阶段写 `undo_log` 并取全局锁后本地提交；写隔离靠全局锁，读默认读未提交，回滚时后镜像不一致需人工处理；不适合热点行

## 参考资料

- Apache Seata 文档：[https://seata.apache.org/docs/overview/what-is-seata/](https://seata.apache.org/docs/overview/what-is-seata/)
- Seata AT 模式：[https://seata.apache.org/docs/dev/mode/at-mode/](https://seata.apache.org/docs/dev/mode/at-mode/)
- Seata TCC 模式：[https://seata.apache.org/docs/dev/mode/tcc-mode/](https://seata.apache.org/docs/dev/mode/tcc-mode/)
- Seata Saga 模式：[https://seata.apache.org/docs/dev/mode/saga-mode/](https://seata.apache.org/docs/dev/mode/saga-mode/)
- Seata XA 模式：[https://seata.apache.org/docs/dev/mode/xa-mode/](https://seata.apache.org/docs/dev/mode/xa-mode/)
- Apache Seata GitHub：[https://github.com/apache/incubator-seata](https://github.com/apache/incubator-seata)
- RocketMQ 事务消息：[https://rocketmq.apache.org/docs/featureBehavior/04transactionmessage/](https://rocketmq.apache.org/docs/featureBehavior/04transactionmessage/)
- MySQL XA Transactions：[https://dev.mysql.com/doc/refman/8.4/en/xa.html](https://dev.mysql.com/doc/refman/8.4/en/xa.html)
- Garcia-Molina & Salem, Sagas（1987）：[https://dl.acm.org/doi/10.1145/38713.38742](https://dl.acm.org/doi/10.1145/38713.38742)
- Microservices.io, Pattern: Saga：[https://microservices.io/patterns/data/saga.html](https://microservices.io/patterns/data/saga.html)
- Microservices.io, Pattern: Transactional outbox：[https://microservices.io/patterns/data/transactional-outbox.html](https://microservices.io/patterns/data/transactional-outbox.html)
- Debezium Outbox Event Router：[https://debezium.io/documentation/reference/stable/transformations/outbox-event-router.html](https://debezium.io/documentation/reference/stable/transformations/outbox-event-router.html)
- Antom（支付宝国际）异步通知：[https://docs.antom.com/ac/website_hk/asyncnotif](https://docs.antom.com/ac/website_hk/asyncnotif)

> 下一篇：[分布式会话](./5_session) —— 多实例下的会话共享：粘性会话、Spring Session + Redis 与 JWT 的取舍。
