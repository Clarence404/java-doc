# 架构模式与风格

> 本文聚焦 Java 后端常见架构模式，每个模式附核心思想、结构说明与代码示例。

---

## 一、分层架构（Layered Architecture）

Java 项目最经典的结构，关注点按层分离。

![分层架构示意图](../assets/architecture/layered-arch.svg)

**依赖方向**：上层依赖下层，下层不感知上层。

---

## 二、Clean Architecture（整洁架构）

Robert C. Martin 提出，核心是**依赖规则：外层依赖内层，内层不依赖外层**。

![Clean Architecture 同心圆](../assets/architecture/clean-arch.svg)

**核心收益**：业务逻辑（Entity + Use Case）与框架/DB 完全解耦，可独立测试。

**Spring Boot 包结构落地**：

```
com.example.shop/
├── domain/               # Entity + Domain Service（无 Spring 依赖）
│   ├── order/
│   │   ├── Order.java
│   │   ├── OrderRepository.java  (interface)
│   │   └── OrderService.java
├── application/          # Use Case（编排 Domain）
│   └── order/
│       └── PlaceOrderUseCase.java
├── infrastructure/       # 实现 Repository + 外部调用
│   ├── persistence/
│   │   └── OrderRepositoryImpl.java
│   └── mq/
│       └── OrderEventPublisher.java
└── interfaces/           # Controller + DTO
    └── rest/
        └── OrderController.java
```

---

## 三、六边形架构（Hexagonal / Ports & Adapters）

业务核心在中心，外部系统通过"端口"与"适配器"接入，方向对称。

![六边形架构（Ports & Adapters）](../assets/architecture/hexagonal-arch.svg)

```java
// 端口（Port）= 接口
public interface OrderRepository {
    void save(Order order);
    Optional<Order> findById(OrderId id);
}

// 适配器（Adapter）= 实现
@Repository
public class OrderJpaAdapter implements OrderRepository {
    @Autowired private OrderJpaRepository jpaRepo;

    @Override
    public void save(Order order) {
        jpaRepo.save(OrderPO.from(order));
    }
}
```

---

## 四、CQRS（命令查询职责分离）

将**写操作（Command）**和**读操作（Query）**拆分为独立的处理路径，分别优化。

```
用户请求
    ├── Command（写）─→ Command Handler ─→ 写库（MySQL 主库）─→ 发布领域事件
    │                                                              │
    │                                                              ▼
    └── Query（读）──→ Query Handler  ─→ 读库（MySQL 从库 / Elasticsearch / Redis）
```

**适用场景**：读写比例严重不平衡（如电商商品详情：10000 读 : 1 写）。

```java
// Command（写）
public record CreateOrderCommand(String userId, List<OrderItem> items) {}

@Service
public class CreateOrderHandler {
    public OrderId handle(CreateOrderCommand cmd) {
        Order order = Order.create(cmd.userId(), cmd.items());
        orderRepo.save(order);
        eventBus.publish(new OrderCreatedEvent(order.getId()));
        return order.getId();
    }
}

// Query（读）—— 直接走 DTO，不经过 Domain
public record OrderSummaryDTO(String id, String status, BigDecimal amount) {}

@Service
public class OrderQueryService {
    @Autowired private OrderReadMapper readMapper;  // 专用读 Mapper，可走从库

    public OrderSummaryDTO getOrderSummary(String orderId) {
        return readMapper.selectSummaryById(orderId);
    }
}
```

---

## 五、Event Sourcing（事件溯源）

不存储当前状态，而是存储**所有导致状态变更的事件序列**，当前状态通过重放事件得出。

```
传统模式：  orders 表 → { id, status="COMPLETED", amount=100 }

事件溯源：  order_events 表 →
            { OrderCreated,  amount=100 }
            { OrderPaid,     payTime=... }
            { OrderShipped,  trackNo=... }
            { OrderCompleted }
            重放以上事件 → 得到当前状态
```

**核心优势**：完整审计日志、支持时间旅行（回到任意历史状态）、天然适合 CQRS。

```java
// 事件定义
public sealed interface OrderEvent permits OrderCreated, OrderPaid, OrderCompleted {}
public record OrderCreated(String orderId, String userId, BigDecimal amount) implements OrderEvent {}
public record OrderPaid(String orderId, String payNo) implements OrderEvent {}

// 聚合通过事件重建状态
public class Order {
    private String id;
    private OrderStatus status;
    private final List<OrderEvent> changes = new ArrayList<>();

    public static Order reconstitute(List<OrderEvent> events) {
        Order order = new Order();
        events.forEach(order::apply);
        return order;
    }

    private void apply(OrderEvent event) {
        switch (event) {
            case OrderCreated e -> { this.id = e.orderId(); this.status = PENDING; }
            case OrderPaid e    -> this.status = PAID;
            case OrderCompleted e -> this.status = COMPLETED;
        }
    }
}
```

---

## 六、系统架构风格对比

| 风格 | 部署单元 | 通信方式 | 适用场景 | 主要挑战 |
|------|---------|---------|---------|---------|
| **单体** | 一个 JAR/WAR | 方法调用 | 小团队、初期产品 | 扩展粒度粗，耦合重 |
| **微服务** | 多个独立服务 | HTTP / gRPC / MQ | 大团队、复杂业务 | 分布式事务、运维复杂 |
| **EDA（事件驱动）** | 服务 + MQ | 异步事件 | 解耦、异步场景 | 最终一致性、调试难 |
| **Serverless** | 函数 | 事件触发 | 定时任务、低频请求 | 冷启动延迟、状态管理难 |

---

## 七、实战组合推荐

| 业务规模 | 推荐架构组合 |
|---------|------------|
| 初创小项目 | 单体 + 分层架构 |
| 中型业务系统 | Spring Boot + DDD + Clean Architecture |
| 大型电商/金融 | 微服务 + DDD + CQRS + Kafka EDA |
| 数据密集型 | 微服务 + Event Sourcing + CQRS + Elasticsearch 读模型 |
