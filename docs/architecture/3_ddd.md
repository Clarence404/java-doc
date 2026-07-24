# DDD 领域驱动设计

> Domain-Driven Design：以业务领域为核心建模，让代码结构与业务语言保持一致。

---

## 一、为什么需要 DDD？

**传统三层架构的痛点**：业务逻辑散落在 Service 中，Service 变成"贫血"的事务脚本，随着业务增长代码越来越难以维护。

**DDD 的核心价值**：
- 业务专家与开发人员使用**统一语言（Ubiquitous Language）**，减少沟通损耗
- 通过**限界上下文**划定边界，天然对应微服务拆分粒度
- **聚合根**保护业务不变量，防止跨聚合的非法操作

---

## 二、战略设计

### 1. 领域划分

| 类型 | 说明 | 例子 |
|------|------|------|
| **核心域（Core Domain）** | 最重要的业务竞争力，需重点投入 | 电商的订单域、推荐算法 |
| **支撑域（Supporting Domain）** | 支持核心域运作，但非核心竞争力 | 通知域、报表域 |
| **通用域（Generic Domain）** | 通用能力，可直接采购 SaaS | 认证域、支付域（接第三方） |

### 2. 限界上下文（Bounded Context）

同一个词在不同上下文含义不同。以"商品"为例：

| 上下文 | "商品"含义 |
|-------|----------|
| 商品中心 | 包含标题、描述、图片、分类、属性 |
| 订单中心 | 仅需商品 ID、名称、单价（快照） |
| 库存中心 | 仅需商品 ID 和 SKU 库存数量 |

**限界上下文 ≈ 微服务边界**，一个限界上下文通常对应一个独立部署的服务。

### 3. 上下文集成方式

| 方式 | 适用场景 | 一致性 |
|------|---------|--------|
| **共享内核** | 两个上下文共用部分模型 | 强，但耦合高 |
| **防腐层（ACL）** | 调用外部系统，隔离外部模型侵入 | 中 |
| **发布/订阅事件** | 跨上下文异步通知 | 最终一致 |
| **开放主机服务（OHS）** | 提供标准 REST/gRPC 接口 | 弱，协议驱动 |

---

## 三、战术设计（构建块）

### 1. 实体（Entity）

有唯一标识，通过 ID 判等，生命周期内状态可变。

```java
public class Order {
    private final OrderId id;         // 唯一标识（值对象）
    private OrderStatus status;
    private final UserId userId;
    private List<OrderLine> lines;

    // 通过 ID 判等，与属性值无关
    @Override
    public boolean equals(Object o) {
        if (!(o instanceof Order other)) return false;
        return this.id.equals(other.id);
    }
}
```

### 2. 值对象（Value Object）

无身份标识，通过属性判等，不可变（immutable）。

```java
public record Money(BigDecimal amount, Currency currency) {
    public Money {
        Objects.requireNonNull(amount);
        Objects.requireNonNull(currency);
        if (amount.compareTo(BigDecimal.ZERO) < 0)
            throw new IllegalArgumentException("Amount must be non-negative");
    }

    public Money add(Money other) {
        if (!this.currency.equals(other.currency))
            throw new IllegalArgumentException("Currency mismatch");
        return new Money(this.amount.add(other.amount), this.currency);
    }
}

public record Address(String province, String city, String detail) {}
```

### 3. 聚合根（Aggregate Root）

聚合是一组高内聚的对象集合，聚合根是外部访问的唯一入口。**外部只能通过聚合根修改内部状态**。

```java
public class Order {   // 聚合根
    private OrderId id;
    private OrderStatus status;
    private List<OrderLine> lines = new ArrayList<>();  // 聚合内部对象
    private final List<DomainEvent> events = new ArrayList<>();

    // 工厂方法，保证创建时的业务完整性
    public static Order create(UserId userId, List<OrderItem> items) {
        if (items.isEmpty()) throw new DomainException("Order must have at least one item");
        Order order = new Order();
        order.id = OrderId.generate();
        order.status = OrderStatus.PENDING;
        order.lines = items.stream().map(OrderLine::from).toList();
        order.events.add(new OrderCreatedEvent(order.id));
        return order;
    }

    // 业务方法，保护不变量
    public void pay(PaymentInfo payment) {
        if (status != OrderStatus.PENDING)
            throw new DomainException("Only PENDING order can be paid");
        this.status = OrderStatus.PAID;
        this.events.add(new OrderPaidEvent(id, payment.payNo()));
    }

    public void cancel() {
        if (status == OrderStatus.COMPLETED || status == OrderStatus.CANCELLED)
            throw new DomainException("Cannot cancel order in status: " + status);
        this.status = OrderStatus.CANCELLED;
    }

    public List<DomainEvent> pullEvents() {
        List<DomainEvent> copy = new ArrayList<>(events);
        events.clear();
        return copy;
    }
}
```

### 4. 领域服务（Domain Service）

业务逻辑不属于任何单个聚合时，放入领域服务。

```java
// 跨聚合操作：转账涉及两个账户聚合
public class TransferService {
    public void transfer(Account from, Account to, Money amount) {
        from.debit(amount);   // 扣款
        to.credit(amount);    // 收款
        // 两个聚合的变更由应用层统一持久化
    }
}
```

### 5. 仓储（Repository）

聚合的持久化接口，**接口定义在 domain 层，实现在 infrastructure 层**。

```java
// domain 层：接口
public interface OrderRepository {
    void save(Order order);
    Optional<Order> findById(OrderId id);
    List<Order> findByUserId(UserId userId);
}

// infrastructure 层：实现
@Repository
public class OrderRepositoryImpl implements OrderRepository {
    @Autowired private OrderMapper mapper;

    @Override
    public void save(Order order) {
        OrderPO po = OrderPO.from(order);
        mapper.upsert(po);
        // 发布领域事件
        order.pullEvents().forEach(eventPublisher::publish);
    }
}
```

---

## 四、DDD 分层架构

![DDD 分层架构](../assets/architecture/ddd-layers.svg)

---

## 五、Spring Boot 落地包结构

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
│       ├── Order.java              ← 聚合根
│       ├── OrderLine.java          ← 聚合内实体
│       ├── OrderId.java            ← 值对象
│       ├── Money.java              ← 值对象
│       ├── OrderStatus.java
│       ├── OrderRepository.java    ← Repository 接口
│       └── event/
│           ├── OrderCreatedEvent.java
│           └── OrderPaidEvent.java
└── infrastructure/
    ├── persistence/
    │   ├── OrderRepositoryImpl.java
    │   ├── OrderMapper.java
    │   └── po/
    │       └── OrderPO.java
    └── mq/
        └── OrderEventPublisher.java
```

---

## 六、应用层示例

```java
@Service
@Transactional
public class PlaceOrderUseCase {
    @Autowired private OrderRepository orderRepo;
    @Autowired private ProductClient productClient;  // 防腐层，调用商品服务

    public String execute(PlaceOrderCommand cmd) {
        // 1. 查询商品信息（防腐层转换，隔离外部模型）
        List<OrderItem> items = cmd.items().stream()
            .map(i -> productClient.getOrderItem(i.productId(), i.quantity()))
            .toList();

        // 2. 创建聚合（业务逻辑在 Domain 层）
        Order order = Order.create(new UserId(cmd.userId()), items);

        // 3. 持久化（Repository 实现同时发布领域事件）
        orderRepo.save(order);

        return order.getId().value();
    }
}
```

---

## 七、DDD 常见误区

| 误区 | 正确做法 |
|------|---------|
| Service 直接操作 DO 字段 | 所有状态变更必须通过聚合根方法 |
| 聚合根依赖 Spring Bean | 领域层不引入框架依赖，通过构造器注入 |
| 一个聚合太大（几十个字段） | 按不变量边界拆分，聚合应尽量小 |
| Repository 返回 List\<PO\> | Repository 返回 Domain 对象，PO 转换在 infrastructure |
| 领域事件放在 Service 里发 | 聚合根内部收集事件，由 Repository.save() 统一发布 |
