---
description: 分层架构、Clean Architecture、六边形架构、CQRS、Event Sourcing、架构风格对比与组合
---

# 架构模式与风格

> **本篇目标**：理解分层、整洁架构、六边形架构的依赖规则与差异，知道 CQRS 与事件溯源分别解决什么问题、带来哪些代价（读模型延迟、事件演进、快照），并能按业务复杂度选择合适的组合。
>
> **前置阅读**：[微服务优势与挑战](/microservices/1_pros_and_cons)（单体与微服务的取舍）

架构模式回答的是「代码怎么组织、依赖朝哪个方向」，架构风格回答的是「系统怎么部署、服务之间怎么通信」。前者在单体里同样重要，后者见第六节。

---

## 一、分层架构

Java 项目最经典的结构：表现层 → 业务层 → 持久层，关注点按层分离。

![分层架构示意图](../assets/architecture/layered-arch.svg)

- **严格分层**：每层只能调用紧邻的下一层，隔离性好，但简单查询也要层层透传
- **松散分层**：上层可以跨层调用任意下层，开发快，但边界容易被打穿

它的问题不在分层本身，而在**依赖方向**：业务层依赖持久层，业务规则就和数据库表结构、ORM 绑在一起。实体只剩 getter / setter，规则堆在 Service 里（贫血模型），业务一复杂就难以维护和测试。整洁架构与六边形架构都是为了把这个依赖方向反过来。

---

## 二、Clean Architecture（整洁架构）

Robert C. Martin 提出，核心是**依赖规则：源码依赖只能从外层指向内层，内层不知道外层的存在**。

![Clean Architecture 同心圆](../assets/architecture/clean-arch.svg)

- **Entities**：企业级业务规则，最稳定
- **Use Cases**：应用级业务规则，编排实体完成一个用例
- **Interface Adapters**：Controller、Presenter、Gateway，负责数据格式转换
- **Frameworks & Drivers**：Web 框架、数据库、MQ 等细节

内层需要访问数据库时，由内层定义接口、外层实现（依赖倒置）。收益是业务规则与框架、数据库解耦，可以不启动 Spring 就完成单元测试。Spring Boot 中按 interfaces / application / domain / infrastructure 落地的包结构见 [DDD 领域驱动设计](./3_ddd) 的「Spring Boot 落地」一节。

---

## 三、六边形架构（Ports & Adapters）

Alistair Cockburn 提出：业务核心在中间，外部世界通过**端口**（接口）与**适配器**（实现）接入。和分层架构「上下」的视角不同，它强调**内外对称**：

- **驱动端（左侧）**：REST Controller、MQ 消费者、定时任务，调用应用的入站端口
- **被驱动端（右侧）**：数据库、MQ 生产者、第三方接口，实现应用定义的出站端口

![六边形架构（Ports & Adapters）](../assets/architecture/hexagonal-arch.svg)

```java
// 出站端口：由领域 / 应用层定义
public interface OrderRepository {
    void save(Order order);
    Optional<Order> findById(OrderId id);
}

// 适配器：infrastructure 层实现
@Repository
public class OrderJpaAdapter implements OrderRepository {
    private final OrderJpaRepository jpaRepo;

    public OrderJpaAdapter(OrderJpaRepository jpaRepo) {
        this.jpaRepo = jpaRepo;
    }

    @Override
    public void save(Order order) {
        jpaRepo.save(OrderPO.from(order));
    }

    @Override
    public Optional<Order> findById(OrderId id) {
        return jpaRepo.findById(id.value()).map(OrderPO::toDomain);
    }
}
```

整洁架构、六边形架构、洋葱架构说的是同一件事：**业务核心不依赖技术细节**。实际项目不必拘泥于哪一种画法，守住依赖方向即可。

---

## 四、CQRS（命令查询职责分离）

把**写（Command）**和**读（Query）**拆成两套模型：写侧用领域模型保证业务规则，读侧用为查询优化的视图（反范式宽表、ES 索引、Redis 结构）。

![CQRS 读写分离与投影](../assets/architecture/cqrs-flow.svg)

### 1、什么时候用

CQRS 的主要动机是**读写模型差异大**，而不是读多写少：

- 查询需要跨多个聚合、多个服务拼装，或需要全文检索、多维筛选，用写侧的规范化表很难高效支撑
- 不同的查询方需要不同形态的视图（运营后台宽表、用户端搜索、统计报表）

单纯读多写少，先用缓存和读写分离解决，见 [数据层扩展](/high-con/5_data_scaling)。

### 2、写侧：事件与业务数据同事务

```java
public record CreateOrderCommand(String userId, List<OrderItem> items) {}

@Service
public class CreateOrderHandler {
    private final OrderRepository orderRepo;
    private final DomainEventOutbox outbox;

    public CreateOrderHandler(OrderRepository orderRepo, DomainEventOutbox outbox) {
        this.orderRepo = orderRepo;
        this.outbox = outbox;
    }

    @Transactional
    public OrderId handle(CreateOrderCommand cmd) {
        Order order = Order.create(new UserId(cmd.userId()), cmd.items());
        orderRepo.save(order);
        outbox.append(order.pullEvents());    // 与业务数据同事务写入 Outbox，提交后再投递
        return order.getId();
    }
}
```

不要在 handler 里 `orderRepo.save()` 之后直接向 MQ 发布事件：handler 在事务内，事务回滚时下游已收到「幽灵事件」；事务提交了但发送失败，读模型永远不同步。Outbox 的实现见 [DDD 领域驱动设计](./3_ddd) 的「领域事件与最终一致」一节。

### 3、读侧：投影与查询

```java
public record OrderSummaryView(String orderId, String status, BigDecimal amount, long version) {}

@Component
public class OrderSummaryProjector {
    private final OrderViewMapper viewMapper;

    public OrderSummaryProjector(OrderViewMapper viewMapper) {
        this.viewMapper = viewMapper;
    }

    /** 消费领域事件更新读模型：按事件版本条件更新，重复和乱序的事件不会覆盖新数据 */
    public void on(OrderPaidEvent e) {
        viewMapper.updateStatusIfNewer(e.orderId().value(), "PAID", e.version());
    }
}

@Service
public class OrderQueryService {
    private final OrderViewMapper viewMapper;

    public OrderQueryService(OrderViewMapper viewMapper) {
        this.viewMapper = viewMapper;
    }

    public Optional<OrderSummaryView> getSummary(String orderId) {
        return Optional.ofNullable(viewMapper.selectById(orderId));   // 直接查视图，不经过领域模型
    }
}
```

### 4、代价

- **读模型最终一致**：用户刚下单就去「我的订单」可能看不到。常见处理：命令返回后前端先展示命令结果；关键页面按 ID 回读写库；或命令返回版本号，查询时等待读模型追上该版本
- **投影要幂等、可重建**：投影器至少一次消费事件，用版本号条件更新；视图结构变化时，从头重放事件或全量回灌重建
- 系统复杂度明显上升，只在确有需要的限界上下文中使用，不要全系统铺开

---

## 五、Event Sourcing（事件溯源）

不存储当前状态，而是存储**导致状态变化的全部事件**，当前状态通过按顺序重放事件得到。

| 传统模式：orders 表 | 事件溯源：order_events 表（只追加） |
|------|------|
| `{id: 1001, status: COMPLETED, amount: 100}` | v1 `OrderCreated(amount=100)` |
| 只知道现在是什么 | v2 `OrderPaid(payNo=P01)` |
| 历史靠额外的日志表 | v3 `OrderShipped(trackNo=T01)` |
| — | v4 `OrderCompleted` |

![事件溯源：加载、重放与追加](../assets/architecture/event-sourcing.svg)

### 1、聚合实现

```java
public sealed interface OrderEvent permits OrderCreated, OrderPaid, OrderCompleted {}
public record OrderCreated(String orderId, String userId, BigDecimal amount) implements OrderEvent {}
public record OrderPaid(String orderId, String payNo) implements OrderEvent {}
public record OrderCompleted(String orderId) implements OrderEvent {}

public class Order {
    private String id;
    private OrderStatus status;
    private long version;                                   // 已应用的事件数，追加时做乐观并发校验
    private final List<OrderEvent> changes = new ArrayList<>();

    public static Order reconstitute(List<OrderEvent> history) {
        Order order = new Order();
        history.forEach(e -> {
            order.apply(e);
            order.version++;
        });
        return order;
    }

    public static Order create(String orderId, String userId, BigDecimal amount) {
        Order order = new Order();
        order.raise(new OrderCreated(orderId, userId, amount));
        return order;
    }

    public void pay(String payNo) {
        if (status != OrderStatus.PENDING) {
            throw new IllegalStateException("只有待支付订单可以支付");
        }
        raise(new OrderPaid(id, payNo));
    }

    /** 命令方法只做校验，状态变化统一经 raise → apply */
    private void raise(OrderEvent event) {
        apply(event);
        changes.add(event);
    }

    private void apply(OrderEvent event) {
        switch (event) {
            case OrderCreated e -> {
                this.id = e.orderId();
                this.status = OrderStatus.PENDING;
            }
            case OrderPaid e -> this.status = OrderStatus.PAID;
            case OrderCompleted e -> this.status = OrderStatus.COMPLETED;
        }
    }

    public List<OrderEvent> uncommittedChanges() { return List.copyOf(changes); }
    public long expectedVersion() { return version; }
}
```

`apply` 只改状态、不做校验，也不能有副作用（发消息、调接口），因为重放历史时会被反复执行。保存时以 `expectedVersion` 追加新事件，事件存储发现版本已变化就拒绝写入，由调用方重新加载后重试。

### 2、工程要点

| 问题 | 做法 |
|------|------|
| 事件很多，重放慢 | 每 N 个事件保存一份**快照**，加载时从最近快照开始重放 |
| 事件结构要改 | 事件一旦写入不能修改；新增版本号，读取旧事件时用 **upcaster** 转换成新结构 |
| 查询 | 事件存储不适合查询，必须配合 CQRS 投影出读模型 |
| 事件存储选型 | 专用的 EventStoreDB、Axon Server，或关系库的追加表（`aggregate_id + version` 唯一）；Kafka 适合做事件分发，不适合做事件存储：难以按聚合高效读取，也缺少按聚合版本的乐观并发写入 |
| 删除个人数据（GDPR 等） | 事件不可变，敏感字段加密存储，删除时销毁密钥（crypto-shredding） |

**适用场景**：天然以流水为核心、需要完整审计与追溯的领域，如账务、交易、库存流水。它和「数据量大」无关；对大多数 CRUD 业务来说，变更日志表或 CDC 已经能满足审计需求。

---

## 六、系统架构风格对比

| 风格 | 部署单元 | 通信方式 | 适用场景 | 主要挑战 |
|------|---------|---------|---------|---------|
| **单体 / 模块化单体** | 一个应用 | 方法调用 | 小团队、业务探索期 | 扩展粒度粗；模块边界靠纪律维持 |
| **微服务** | 多个独立服务 | HTTP / gRPC / MQ | 多团队并行交付 | 分布式事务、链路排查、运维成本 |
| **事件驱动（EDA）** | 服务 + 消息中间件 | 异步事件 | 解耦、异步、削峰 | 最终一致、事件演进、调试困难 |
| **Serverless** | 函数 | 事件触发 | 低频任务、突发流量 | 冷启动、状态管理、厂商绑定 |

单体与微服务的取舍见 [微服务优势与挑战](/microservices/1_pros_and_cons)，服务拆分与常用模式见 [微服务设计模式](/microservices/2_patterns)。

---

## 七、组合建议

| 业务特征 | 推荐组合 |
|---------|------------|
| 规则简单、以增删改查为主 | 单体 + 分层架构 |
| 业务规则复杂、需要长期演进 | DDD + 整洁 / 六边形架构，可从模块化单体起步 |
| 多团队、多限界上下文 | 微服务 + DDD，上下文之间用事件驱动集成 |
| 查询形态与写模型差异大（搜索、报表、聚合视图） | 在对应上下文引入 CQRS，读模型用 ES / 宽表 |
| 账务、交易流水等强审计领域 | 局部采用 Event Sourcing + CQRS |

模式是按限界上下文局部选择的：同一个系统里，交易上下文用事件溯源，运营配置上下文用简单分层，是常见且合理的做法。

---

## 小结

- 分层架构的问题在于业务层依赖持久层；整洁架构与六边形架构通过依赖倒置让业务核心不依赖技术细节
- 六边形架构强调内外对称：驱动端调用入站端口，被驱动端实现出站端口
- CQRS 的动机是读写模型差异大；写侧事件经 Outbox 投递，读侧投影幂等、可重建，并处理好写后读
- 事件溯源以事件为唯一事实来源：raise → apply → 追加，配合快照、upcasting 与 CQRS 投影；适合强审计领域
- 架构模式按限界上下文局部选择，不要全系统一刀切

## 参考资料

- Robert C. Martin, The Clean Architecture：[https://blog.cleancoder.com/uncle-bob/2012/08/13/the-clean-architecture.html](https://blog.cleancoder.com/uncle-bob/2012/08/13/the-clean-architecture.html)
- Alistair Cockburn, Hexagonal Architecture：[https://alistair.cockburn.us/hexagonal-architecture/](https://alistair.cockburn.us/hexagonal-architecture/)
- Martin Fowler, CQRS：[https://martinfowler.com/bliki/CQRS.html](https://martinfowler.com/bliki/CQRS.html)
- Martin Fowler, Event Sourcing：[https://martinfowler.com/eaaDev/EventSourcing.html](https://martinfowler.com/eaaDev/EventSourcing.html)
- Microsoft Azure Architecture Center · Event Sourcing pattern：[https://learn.microsoft.com/en-us/azure/architecture/patterns/event-sourcing](https://learn.microsoft.com/en-us/azure/architecture/patterns/event-sourcing)
- microservices.io · Transactional Outbox：[https://microservices.io/patterns/data/transactional-outbox.html](https://microservices.io/patterns/data/transactional-outbox.html)

> 下一篇：[DDD 领域驱动设计](./3_ddd) —— 限界上下文与上下文映射、实体与值对象、聚合规则、仓储，以及领域事件经 Outbox 的可靠投递。
