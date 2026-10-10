---
description: 领域与限界上下文、上下文映射、实体与值对象、聚合规则、仓储、领域事件与 Outbox、Spring Boot 落地
---

# DDD 领域驱动设计

> 前置阅读：[架构模式与风格](./2_arch_patterns)

Domain-Driven Design 以业务领域为核心建模，解决的是**复杂业务逻辑的组织问题**，以增删改查为主的系统用 DDD 成本大于收益。本篇讲战略设计、战术设计、领域事件与 Outbox，以及在 Spring Boot 中的分层落地。

---

## 一、为什么需要 DDD

传统三层架构里，业务规则散落在各个 Service 中，实体只有 getter / setter（贫血模型），Service 变成一段段事务脚本。业务一复杂，同一条规则在多处重复实现，改一处漏一处。

DDD 的核心价值：

- **统一语言（Ubiquitous Language）**：业务专家与开发使用同一套术语，并直接体现在类名、方法名里
- **限界上下文**：给模型划定边界，同一个词在不同上下文可以有不同含义，边界清晰后才能谈服务拆分
- **聚合**：把需要一起保持一致的数据圈在一起，由聚合根保护业务不变量

---

## 二、战略设计

### 1、子域划分

| 类型 | 说明 | 例子 |
|------|------|------|
| **核心域（Core Domain）** | 业务竞争力所在，投入最强的团队重点建模 | 电商的交易、定价、推荐 |
| **支撑域（Supporting Domain）** | 支撑核心域运作，有业务特性但不是竞争力 | 通知、报表、运营后台 |
| **通用域（Generic Domain）** | 行业通用能力，优先采购或用开源 | 认证、支付接入、短信 |

### 2、限界上下文（Bounded Context）

同一个词在不同上下文含义不同。以「商品」为例：

| 上下文 | 「商品」的含义 |
|-------|----------|
| 商品中心 | 标题、描述、图片、类目、属性 |
| 订单中心 | 下单时的商品 ID、名称、单价快照 |
| 库存中心 | SKU 与可售数量 |

限界上下文是**模型的边界**，常常也是微服务拆分的候选边界，但不是一一对应：一个上下文可以按部署与扩容需要拆成多个服务，一个模块化单体里也可以有多个上下文。服务拆分的方法见 [微服务设计模式](/microservices/2_patterns)。

### 3、上下文映射

上下文之间的集成关系，既是技术选择，也反映团队之间的协作关系：

| 模式 | 含义 | 耦合度 | 团队关系 |
|------|------|------|------|
| **合作关系（Partnership）** | 两个上下文同进同退，接口变更一起协调 | 高 | 两个团队目标一致、紧密协作 |
| **共享内核（Shared Kernel）** | 共用一小部分模型（如公共值对象库） | 高 | 修改共享部分需双方同意 |
| **客户-供应商（Customer-Supplier）** | 下游提需求，上游排期提供接口 | 中 | 上游愿意配合下游 |
| **跟随者（Conformist）** | 下游直接使用上游模型，不做转换 | 中到高 | 上游不配合，下游只能接受 |
| **防腐层（ACL）** | 下游用转换层隔离上游模型 | 低 | 上游模型复杂或不稳定（如遗留系统、第三方） |
| **开放主机服务 / 发布语言（OHS / PL）** | 上游提供稳定的公开协议（REST、gRPC、事件格式） | 低 | 上游服务多个下游 |
| **各行其道（Separate Ways）** | 不集成，各自实现 | 无 | 集成成本大于收益 |

调用外部上下文时，**下游自己的模型不应被上游模型污染**：在 infrastructure 层实现防腐层，把对方的 DTO 转换成本上下文的值对象。

---

## 三、战术设计

### 1、实体（Entity）

有唯一标识，通过标识判等，生命周期内状态可变。`equals` 与 `hashCode` 必须同时按标识实现，否则放进 `HashSet` / `HashMap` 会出错：

```java
public class Order {
    private final OrderId id;
    private OrderStatus status;

    @Override
    public boolean equals(Object o) {
        return this == o || (o instanceof Order other && id.equals(other.id));
    }

    @Override
    public int hashCode() {
        return id.hashCode();
    }
}
```

标识应在创建时就确定（应用生成 ID 或号段分配，见 [分布式 ID 生成](/distributed/8_id_generator)），不要等数据库自增回填后才有，否则持久化前后的 `hashCode` 不一致。

### 2、值对象（Value Object）

没有标识，通过全部属性判等，不可变。Java 的 `record` 天然满足：`equals` / `hashCode` 按全部分量生成。

```java
public record Money(BigDecimal amount, Currency currency) {
    public Money {
        Objects.requireNonNull(amount);
        Objects.requireNonNull(currency);
        if (amount.signum() < 0) {
            throw new IllegalArgumentException("金额不能为负");
        }
        // BigDecimal.equals 会比较 scale：1.0 与 1.00 不相等，先统一精度
        amount = amount.setScale(currency.getDefaultFractionDigits(), RoundingMode.UNNECESSARY);
    }

    public Money add(Money other) {
        if (!currency.equals(other.currency)) {
            throw new IllegalArgumentException("币种不一致");
        }
        return new Money(amount.add(other.amount), currency);
    }
}

public record Address(String province, String city, String detail) {}
```

能用值对象表达的概念（金额、地址、时间区间、数量）都不要用裸的 `BigDecimal`、`String`，校验规则随类型走，不用在每个调用处重复。

### 3、聚合与聚合根（Aggregate）

聚合是一组必须**一起保持一致**的对象，聚合根是外部访问的唯一入口。设计规则（Vernon《实现领域驱动设计》）：

- **在边界内保护真正的不变量**：例如「订单总额 = 各明细之和」「已支付订单不能修改明细」
- **聚合尽量小**：大聚合并发冲突多、加载慢；多数聚合只有根实体加几个值对象
- **通过 ID 引用其他聚合**：订单里存 `UserId`，而不是持有 `User` 对象
- **一个事务只修改一个聚合**：聚合之间用领域事件达到最终一致

```java
public class Order {                                          // 聚合根
    private OrderId id;
    private UserId userId;
    private OrderStatus status;
    private List<OrderLine> lines = new ArrayList<>();        // 聚合内部对象
    private long version;                                     // 乐观锁，防止并发覆盖整个聚合
    private final List<DomainEvent> events = new ArrayList<>();

    private Order() {
    }

    public static Order create(UserId userId, List<OrderItem> items) {
        if (items.isEmpty()) {
            throw new DomainException("订单至少包含一个商品");
        }
        Order order = new Order();
        order.id = OrderId.generate();
        order.userId = userId;
        order.status = OrderStatus.PENDING;
        order.lines = new ArrayList<>(items.stream().map(OrderLine::from).toList());
        order.events.add(new OrderCreatedEvent(order.id, userId));
        return order;
    }

    public void pay(PaymentInfo payment) {
        if (status != OrderStatus.PENDING) {
            throw new DomainException("只有待支付订单可以支付，当前状态: " + status);
        }
        status = OrderStatus.PAID;
        events.add(new OrderPaidEvent(id, payment.payNo()));
    }

    public void cancel() {
        if (status == OrderStatus.SHIPPED || status == OrderStatus.COMPLETED || status == OrderStatus.CANCELLED) {
            throw new DomainException("当前状态不能取消: " + status);
        }
        status = OrderStatus.CANCELLED;
        events.add(new OrderCancelledEvent(id));
    }

    /** 取出并清空本次变更产生的事件，由应用层在同一事务中写入 Outbox */
    public List<DomainEvent> pullEvents() {
        List<DomainEvent> copy = List.copyOf(events);
        events.clear();
        return copy;
    }

    public OrderId getId() { return id; }
    public long getVersion() { return version; }
    public List<OrderLine> getLines() { return Collections.unmodifiableList(lines); }
}
```

聚合根不暴露 setter，也不把内部可变集合直接交出去；所有状态变化都通过表达业务意图的方法完成。

### 4、领域服务（Domain Service）

业务逻辑不自然地属于任何一个实体或值对象时，放进领域服务，例如需要同时读取多个聚合才能做出的判断：

```java
public class TransferPolicy {
    /** 判断能否转账：涉及转出账户、转入账户与风控规则 */
    public void check(Account from, Account to, Money amount) {
        if (from.isFrozen() || to.isFrozen()) {
            throw new DomainException("账户已冻结");
        }
        if (!from.canDebit(amount)) {
            throw new DomainException("余额不足");
        }
    }
}
```

「转账」修改两个账户聚合，违背「一个事务只改一个聚合」，有两种处理方式，要**显式选择**而不是默认写在一个事务里：

| 方式 | 做法 | 适用 |
|------|------|------|
| 同库强一致 | 两个账户在同一个库，应用服务在一个本地事务里修改两个聚合，并按账户 ID 顺序加锁避免死锁 | 同一限界上下文、强一致要求，有意识地放宽规则 |
| 最终一致 | 引入「转账单」聚合：扣款成功 → 发布事件 → 入账，失败则补偿；跨服务时用 Saga | 跨库、跨服务，见 [分布式事务](/distributed/4_transaction) |

领域服务是无状态的，只依赖领域对象和端口接口，不注入数据访问或远程调用的实现类。

### 5、仓储（Repository）

聚合的持久化接口，**以聚合为单位读写**；接口定义在 domain 层，实现在 infrastructure 层。仓储只负责持久化，不负责发布事件。

```java
// domain 层：接口
public interface OrderRepository {
    void save(Order order);
    Optional<Order> findById(OrderId id);
}

// infrastructure 层：实现
@Repository
public class OrderRepositoryImpl implements OrderRepository {
    private final OrderMapper orderMapper;
    private final OrderLineMapper lineMapper;

    public OrderRepositoryImpl(OrderMapper orderMapper, OrderLineMapper lineMapper) {
        this.orderMapper = orderMapper;
        this.lineMapper = lineMapper;
    }

    @Override
    public void save(Order order) {
        OrderPO po = OrderPO.from(order);
        if (order.getVersion() == 0) {
            orderMapper.insert(po);
        } else if (orderMapper.updateWithVersion(po) == 0) {   // WHERE id = ? AND version = ?
            throw new OptimisticLockingFailureException("订单已被并发修改: " + order.getId());
        }
        lineMapper.replaceAll(po.getId(), OrderLinePO.from(order.getLines()));
    }

    @Override
    public Optional<Order> findById(OrderId id) {
        return Optional.ofNullable(orderMapper.selectById(id.value()))
                .map(po -> po.toDomain(lineMapper.selectByOrderId(po.getId())));
    }
}
```

---

## 四、领域事件与最终一致

领域事件表示「领域里发生了一件业务上关心的事」（订单已支付），用来驱动其他聚合、其他上下文的后续动作。关键问题是**什么时候发出去**：

- 在事务里直接发 MQ：事务回滚了，下游却已经收到「订单已支付」
- 在仓储 `save()` 里发：`save()` 仍在事务内，问题同上
- 提交后再发：提交成功但发送前进程崩溃，事件丢失

可靠的做法是 **Transactional Outbox**：聚合收集事件 → 应用服务在同一个本地事务里保存聚合并把事件写入 Outbox 表 → 提交后由投递任务（轮询或 CDC）发到 MQ → 下游幂等消费。

![领域事件经 Outbox 投递](../assets/architecture/ddd-event-outbox.svg)

```java
@Component
public class DomainEventOutbox {
    private final OutboxMapper outboxMapper;
    private final ObjectMapper objectMapper;   // Jackson 3：tools.jackson.databind.ObjectMapper

    public DomainEventOutbox(OutboxMapper outboxMapper, ObjectMapper objectMapper) {
        this.outboxMapper = outboxMapper;
        this.objectMapper = objectMapper;
    }

    /** 必须在业务事务内调用：与聚合一起提交或一起回滚 */
    @Transactional(propagation = Propagation.MANDATORY)
    public void append(List<DomainEvent> events) {
        for (DomainEvent e : events) {
            outboxMapper.insert(new OutboxRecord(e.eventId(), e.getClass().getSimpleName(),
                    e.aggregateId(), objectMapper.writeValueAsString(e)));
        }
    }
}
```

- 同一个上下文内、允许丢失的后续动作（发站内信、刷新本地缓存），可以用 Spring 的 `ApplicationEventPublisher` 发布进程内事件，监听器使用 `@TransactionalEventListener(phase = AFTER_COMMIT)` 在提交后执行；使用 Spring Data JPA / JDBC 时，聚合继承 `AbstractAggregateRoot` 并 `registerEvent(...)`，`save()` 时会自动发布，监听器同样要用 `AFTER_COMMIT`
- 跨上下文、不能丢的事件一律走 Outbox 或 RocketMQ 事务消息；投递与对比见 [消息队列基础](/messaging/1_basics)
- 事件至少投递一次，消费方必须幂等，见 [幂等设计](./5_idempotence)；事件本身要带事件 ID、聚合 ID 和发生时间

---

## 五、DDD 分层架构

![DDD 分层架构](../assets/architecture/ddd-layers.svg)

| 层 | 职责 | 依赖 |
|------|------|------|
| interfaces | Controller、MQ 消费入口、DTO 转换 | application |
| application | 用例编排、事务边界、权限校验，不写业务规则 | domain |
| domain | 实体、值对象、聚合、领域服务、仓储接口、领域事件 | 不依赖其他层和框架 |
| infrastructure | 仓储实现、防腐层、Outbox、消息投递 | 实现 domain 定义的接口 |

---

## 六、Spring Boot 落地

### 1、包结构

```
com.example.order/
├── interfaces/
│   └── rest/
│       ├── OrderController.java
│       └── dto/
│           ├── CreateOrderRequest.java
│           └── OrderResponse.java
├── application/
│   └── order/
│       ├── PlaceOrderUseCase.java
│       └── CancelOrderUseCase.java
├── domain/
│   └── order/
│       ├── Order.java                 # 聚合根
│       ├── OrderLine.java             # 聚合内实体
│       ├── OrderId.java               # 值对象
│       ├── Money.java                 # 值对象
│       ├── OrderStatus.java
│       ├── OrderRepository.java       # 仓储接口
│       └── event/
│           ├── OrderCreatedEvent.java
│           └── OrderPaidEvent.java
└── infrastructure/
    ├── persistence/
    │   ├── OrderRepositoryImpl.java
    │   ├── OrderMapper.java
    │   └── po/
    │       └── OrderPO.java
    ├── acl/
    │   └── ProductClient.java         # 防腐层：调用商品服务并转换模型
    └── outbox/
        ├── DomainEventOutbox.java
        └── OutboxRelay.java           # 投递任务：Outbox → MQ
```

### 2、应用服务

远程调用不要放进数据库事务：事务期间会一直占用连接，远程调用慢或超时就形成长事务。先在事务外查询、组装，再开一个短事务完成写入：

```java
@Service
public class PlaceOrderUseCase {
    private final OrderRepository orderRepo;
    private final ProductClient productClient;    // 防腐层
    private final DomainEventOutbox outbox;
    private final TransactionTemplate tx;

    public PlaceOrderUseCase(OrderRepository orderRepo, ProductClient productClient,
                             DomainEventOutbox outbox, TransactionTemplate tx) {
        this.orderRepo = orderRepo;
        this.productClient = productClient;
        this.outbox = outbox;
        this.tx = tx;
    }

    public String execute(PlaceOrderCommand cmd) {
        // 1. 事务外：通过防腐层查询商品，转换成本上下文的模型
        List<OrderItem> items = cmd.items().stream()
                .map(i -> productClient.getOrderItem(i.productId(), i.quantity()))
                .toList();

        // 2. 短事务：创建聚合、保存、同事务写 Outbox
        return tx.execute(status -> {
            Order order = Order.create(new UserId(cmd.userId()), items);
            orderRepo.save(order);
            outbox.append(order.pullEvents());
            return order.getId().value();
        });
    }
}
```

---

## 七、常见误区

| 误区 | 正确做法 |
|------|---------|
| Service 直接改实体字段 | 状态变更都通过聚合根上表达业务意图的方法 |
| 领域对象注入 Spring Bean | 领域对象不注入 Bean；需要外部能力时由应用层或领域服务通过接口（端口）传入 |
| 一个聚合几十个字段、一堆子集合 | 按真正的不变量拆小，聚合之间用 ID 引用 |
| 一个事务里修改多个聚合 | 默认一个事务一个聚合，跨聚合用领域事件；确需强一致时显式说明理由 |
| Repository 返回 PO | Repository 返回领域对象，PO 转换在 infrastructure 层 |
| 在事务内或 `Repository.save()` 里直接发 MQ | 聚合收集事件 → 同事务写 Outbox → 提交后投递，消费方幂等 |
| 实体只重写 `equals` | `equals` 与 `hashCode` 同时按标识实现 |
| 所有项目都上 DDD | 业务规则简单的 CRUD 系统用分层架构即可 |

---

## 小结

- 战略设计先行：划分子域，确定限界上下文与上下文映射；上下文是模型边界，不等同于服务边界
- 实体按标识判等并同时实现 `equals` / `hashCode`；值对象不可变，用 record 表达并注意 `BigDecimal` 精度
- 聚合要小、通过 ID 引用其他聚合、一个事务只改一个聚合，聚合根保护不变量
- 仓储以聚合为单位持久化，用版本号防止并发覆盖，不负责发布事件
- 领域事件随聚合一起写入 Outbox，提交后投递；进程内的弱保证场景用 `AFTER_COMMIT` 监听器
- 应用服务把远程调用放在事务外，只用短事务包住写操作

## 参考资料

- Eric Evans, *Domain-Driven Design Reference*：[https://www.domainlanguage.com/ddd/reference/](https://www.domainlanguage.com/ddd/reference/)
- Vaughn Vernon, *Effective Aggregate Design*：[https://www.dddcommunity.org/library/vernon_2011/](https://www.dddcommunity.org/library/vernon_2011/)
- Martin Fowler, Bounded Context：[https://martinfowler.com/bliki/BoundedContext.html](https://martinfowler.com/bliki/BoundedContext.html)
- Spring Data · Publishing Events from Aggregate Roots：[https://docs.spring.io/spring-data/commons/reference/repositories/core-domain-events.html](https://docs.spring.io/spring-data/commons/reference/repositories/core-domain-events.html)
- Spring Framework · Transaction-bound Events：[https://docs.spring.io/spring-framework/reference/data-access/transaction/event.html](https://docs.spring.io/spring-framework/reference/data-access/transaction/event.html)
- microservices.io · Transactional Outbox：[https://microservices.io/patterns/data/transactional-outbox.html](https://microservices.io/patterns/data/transactional-outbox.html)

> 下一篇：[对象存储](./4_object_storage) —— 对象存储的数据模型与一致性、预签名直传，以及 MinIO 现状与自建替代方案。
