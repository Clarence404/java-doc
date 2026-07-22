# 中介者模式

**作用**：用一个**中介对象**封装一系列对象间的交互，降低对象之间的直接耦合，避免网状依赖。

**应用场景**：
- Spring `ApplicationEventPublisher`：事件发布者不关心谁消费，消费者不关心谁发布
- 聊天室服务器（用户之间不直接通信，统一经过服务器转发）
- 微服务中的消息队列（服务间通过 MQ 解耦）
- MVC 中 Controller 作为 View 与 Model 的中介

---

## 一、Spring 事件（最常用的中介者实现）

```java
// 1. 定义事件（中介者传递的消息）
public class OrderCreatedEvent {
    private final Long    orderId;
    private final Long    userId;
    private final BigDecimal amount;

    public OrderCreatedEvent(Long orderId, Long userId, BigDecimal amount) {
        this.orderId = orderId;
        this.userId  = userId;
        this.amount  = amount;
    }
    // getters...
}

// 2. 发布方：只依赖 ApplicationEventPublisher，不依赖任何消费者
@Service
public class OrderService {
    private final ApplicationEventPublisher eventPublisher;

    public OrderService(ApplicationEventPublisher eventPublisher) {
        this.eventPublisher = eventPublisher;
    }

    public Long createOrder(CreateOrderRequest req) {
        Order order = orderRepository.save(new Order(req));
        // 发布事件，无需知道谁来处理
        eventPublisher.publishEvent(
            new OrderCreatedEvent(order.getId(), req.getUserId(), order.getAmount()));
        return order.getId();
    }
}

// 3. 消费方 A：发送确认邮件
@Component
public class OrderEmailListener {
    @EventListener
    public void onOrderCreated(OrderCreatedEvent event) {
        emailService.sendOrderConfirm(event.getUserId(), event.getOrderId());
    }
}

// 4. 消费方 B：更新用户统计
@Component
public class OrderStatsListener {
    @EventListener
    public void onOrderCreated(OrderCreatedEvent event) {
        statsService.incrementUserOrderCount(event.getUserId());
    }
}

// 5. 异步处理（加 @Async 不阻塞主线程）
@Component
public class OrderNotifyListener {
    @Async
    @TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT)
    public void onOrderCreated(OrderCreatedEvent event) {
        // 事务提交后才触发，避免数据未持久化就通知
        pushService.notify(event.getUserId(), "您的订单已创建");
    }
}
```

---

## 二、传统中介者实现

```java
// 中介者接口
public interface ChatMediator {
    void sendMessage(String message, ChatUser sender);
    void addUser(ChatUser user);
}

// 具体中介者：聊天室
public class ChatRoom implements ChatMediator {
    private final List<ChatUser> users = new ArrayList<>();

    @Override
    public void addUser(ChatUser user) { users.add(user); }

    @Override
    public void sendMessage(String message, ChatUser sender) {
        users.stream()
             .filter(u -> u != sender)
             .forEach(u -> u.receive(message, sender.getName()));
    }
}
```

---

## 三、中介者 vs 观察者

| 维度 | 中介者 | 观察者 |
|------|--------|--------|
| 控制方向 | 中心化，所有交互经过中介 | 去中心化，主题直接通知订阅者 |
| 组件耦合 | 组件互相解耦，只知道中介 | 观察者知道主题类型 |
| 适用 | 多对多复杂交互 | 一对多的状态变更通知 |
