# Spring 事件机制

> 参考资料：
> * Spring 官方文档 - Events：[https://docs.spring.io/spring-framework/reference/core/beans/context-introduction.html#context-functionality-events](https://docs.spring.io/spring-framework/reference/core/beans/context-introduction.html#context-functionality-events)
> * Spring Events 实战：[https://www.baeldung.com/spring-events](https://www.baeldung.com/spring-events)

## 一、核心概念

Spring 事件机制基于**观察者模式**，用于模块间解耦：发布方不需要知道谁在监听，监听方不需要感知发布方。

| 角色 | 说明 |
|------|------|
| `ApplicationEvent` | 事件对象（Spring 4.2+ 可用任意对象，无需继承） |
| `ApplicationEventPublisher` | 发布器（`ApplicationContext` 实现了此接口） |
| `@EventListener` | 监听器注解，方法参数类型即为监听的事件类型 |
| `ApplicationListener<E>` | 监听器接口（老写法，不推荐） |

---

## 二、定义 & 发布 & 监听

### 2.1 定义事件（推荐用 record / POJO，无需继承）

```java
// Spring 4.2+ 任意对象均可作为事件
public record OrderCreatedEvent(Long orderId, String userId, BigDecimal amount) {}

// 需要访问 source 时才继承 ApplicationEvent
public class OrderPaidEvent extends ApplicationEvent {
    private final Long orderId;
    public OrderPaidEvent(Object source, Long orderId) {
        super(source);
        this.orderId = orderId;
    }
    public Long getOrderId() { return orderId; }
}
```

### 2.2 发布事件

```java
@Service
@RequiredArgsConstructor
public class OrderService {

    private final ApplicationEventPublisher eventPublisher;

    @Transactional
    public OrderVO createOrder(OrderCreateDTO dto) {
        Order order = orderRepo.save(buildOrder(dto));
        // 业务完成后发布事件，让其他模块响应
        eventPublisher.publishEvent(new OrderCreatedEvent(order.getId(),
                                                          dto.getUserId(),
                                                          order.getTotalAmount()));
        return toVO(order);
    }
}
```

### 2.3 监听事件

```java
@Component
@Slf4j
public class OrderEventListener {

    // 监听订单创建事件
    @EventListener
    public void onOrderCreated(OrderCreatedEvent event) {
        log.info("收到订单创建事件: orderId={}", event.orderId());
        notificationService.sendOrderConfirmation(event.userId(), event.orderId());
    }

    // 监听多个事件类型
    @EventListener({OrderCreatedEvent.class, OrderPaidEvent.class})
    public void onOrderChange(Object event) {
        log.info("订单状态变更: {}", event.getClass().getSimpleName());
    }
}
```

---

## 三、同步 vs 异步

**默认同步**：事件处理在发布线程中执行，处理完才继续往下走。

### 3.1 方法级异步

```java
@Configuration
@EnableAsync
public class AsyncConfig {

    // 专用于事件处理的线程池
    @Bean("eventExecutor")
    public Executor eventExecutor() {
        ThreadPoolTaskExecutor executor = new ThreadPoolTaskExecutor();
        executor.setCorePoolSize(4);
        executor.setMaxPoolSize(16);
        executor.setQueueCapacity(200);
        executor.setThreadNamePrefix("event-");
        executor.setRejectedExecutionHandler(new ThreadPoolExecutor.CallerRunsPolicy());
        executor.initialize();
        return executor;
    }
}

@Component
public class OrderEventListener {

    // 异步监听：不阻塞发布线程，在 eventExecutor 中执行
    @EventListener
    @Async("eventExecutor")
    public void sendEmail(OrderCreatedEvent event) {
        emailService.sendConfirmation(event.userId());
    }

    @EventListener
    @Async("eventExecutor")
    public void updateInventory(OrderCreatedEvent event) {
        inventoryService.reserve(event.orderId());
    }
}
```

---

## 四、监听器排序

多个监听器监听同一事件时，用 `@Order` 控制执行顺序（数字越小越先执行）：

```java
@Component
public class OrderEventListener {

    @EventListener
    @Order(1)
    public void validateOrder(OrderCreatedEvent event) {
        // 先做校验
    }

    @EventListener
    @Order(2)
    public void deductInventory(OrderCreatedEvent event) {
        // 再扣库存
    }

    @EventListener
    @Order(3)
    public void sendNotification(OrderCreatedEvent event) {
        // 最后发通知
    }
}
```

> ⚠️ `@Order` + `@Async` 同时使用时，排序失效（异步执行顺序不确定）。

---

## 五、条件监听

```java
@EventListener(condition = "#event.amount > 1000")
public void onHighValueOrder(OrderCreatedEvent event) {
    // 只处理金额 > 1000 的订单
    vipService.notifyVipTeam(event.orderId());
}

@EventListener(condition = "#event.userId.startsWith('VIP_')")
public void onVipOrder(OrderCreatedEvent event) {
    giftService.sendGift(event.userId());
}
```

---

## 六、事务事件（@TransactionalEventListener）

解决事务提交前就执行监听器导致数据未落盘的问题：

```java
@Component
@Slf4j
public class OrderTransactionalListener {

    // 事务提交后执行（最常用：确保数据已落盘再发 MQ / 通知）
    @TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT)
    public void afterCommit(OrderCreatedEvent event) {
        log.info("事务已提交，发送 MQ 消息: {}", event.orderId());
        mqProducer.send("order.created", event);
    }

    // 事务回滚后执行（补偿、告警）
    @TransactionalEventListener(phase = TransactionPhase.AFTER_ROLLBACK)
    public void afterRollback(OrderCreatedEvent event) {
        log.warn("事务回滚，订单创建失败: {}", event.orderId());
        alertService.notify("订单事务回滚: " + event.orderId());
    }

    // 事务完成后执行（无论提交还是回滚）
    @TransactionalEventListener(phase = TransactionPhase.AFTER_COMPLETION)
    public void afterCompletion(OrderCreatedEvent event) {
        log.info("事务完成（提交或回滚）: {}", event.orderId());
        metricsService.record(event);
    }

    // 事务提交前执行（在 BEFORE_COMMIT 阶段，仍在事务中）
    @TransactionalEventListener(phase = TransactionPhase.BEFORE_COMMIT)
    public void beforeCommit(OrderCreatedEvent event) {
        // 仍在事务中，可以做数据一致性补充操作
        auditService.log(event.orderId());
    }
}
```

| 阶段 | 说明 | 典型用途 |
|------|------|---------|
| `BEFORE_COMMIT` | 提交前，仍在事务中 | 补充数据操作、审计 |
| `AFTER_COMMIT` | 提交后 | 发 MQ、推送通知、清缓存 |
| `AFTER_ROLLBACK` | 回滚后 | 补偿操作、告警 |
| `AFTER_COMPLETION` | 完成后（提交或回滚） | 指标记录、资源释放 |

> ⚠️ `@TransactionalEventListener` 默认在没有事务时不执行。若需要在无事务场景也能触发，加 `fallbackExecution = true`。

---

## 七、Spring 内置事件

```java
@Component
@Slf4j
public class SpringBuiltinEventListener {

    // 容器刷新完成（所有 Bean 初始化完毕）
    @EventListener
    public void onRefresh(ContextRefreshedEvent event) {
        log.info("Spring 容器初始化完成");
    }

    // Spring Boot 应用启动完成（Boot 专用）
    @EventListener
    public void onReady(ApplicationReadyEvent event) {
        log.info("应用启动完成，开始预热缓存");
        cacheService.warmUp();
    }

    // 容器关闭
    @EventListener
    public void onClose(ContextClosedEvent event) {
        log.info("Spring 容器关闭，释放资源");
    }

    // Web 请求处理完成（仅 Spring MVC 场景）
    @EventListener
    public void onRequest(RequestHandledEvent event) {
        log.debug("请求处理完成: {} {}ms", event.getDescription(), event.getProcessingTimeMillis());
    }
}
```

---

## 八、实战模式：事件驱动业务解耦

用事件将订单创建的多个后续动作从 `OrderService` 中剥离：

```java
// 之前：OrderService 直接调用多个服务（强耦合）
public void createOrder(OrderCreateDTO dto) {
    orderRepo.save(order);
    inventoryService.deduct(order);     // 耦合
    notificationService.notify(order);  // 耦合
    pointService.award(order);          // 耦合
    couponService.consume(order);       // 耦合
}

// 之后：OrderService 只发布事件，各模块自行监听（解耦）
@Transactional
public void createOrder(OrderCreateDTO dto) {
    Order order = orderRepo.save(buildOrder(dto));
    eventPublisher.publishEvent(new OrderCreatedEvent(
        order.getId(), dto.getUserId(), order.getTotalAmount()));
    // 完成，后续由各监听器处理
}

// 库存模块监听
@Component
public class InventoryListener {
    @TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT)
    public void deduct(OrderCreatedEvent e) { inventoryService.deduct(e.orderId()); }
}

// 积分模块监听
@Component
public class PointListener {
    @TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT)
    @Async("eventExecutor")
    public void award(OrderCreatedEvent e) { pointService.award(e.userId(), e.amount()); }
}

// 通知模块监听
@Component
public class NotificationListener {
    @TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT)
    @Async("eventExecutor")
    public void notify(OrderCreatedEvent e) { notificationService.send(e.userId()); }
}
```
