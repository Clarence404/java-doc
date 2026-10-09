---
description: 事件发布与监听、同步与异步、条件监听、事务事件与 AFTER_COMMIT 陷阱、可靠性边界、内置事件
---

# 事件机制

> **本篇目标**：掌握 Spring 事件的发布、监听、异步与排序，理解 `@TransactionalEventListener` 各阶段的执行时机与 AFTER_COMMIT 写库陷阱，清楚进程内事件「至多一次」的可靠性边界，知道什么时候该升级到 Outbox、Spring Modulith 或消息队列。
>
> **前置阅读**：[事务管理](./4_transaction)

---

## 一、核心概念

Spring 事件机制基于**观察者模式**，用于进程内模块间解耦：发布方不需要知道谁在监听，监听方不需要感知发布方。

| 角色 | 说明 |
|------|------|
| 事件 | 任意对象（推荐 record）；也可继承 `ApplicationEvent` |
| `ApplicationEventPublisher` | 发布器，`ApplicationContext` 实现了此接口，直接注入即可 |
| `@EventListener` | 监听器注解，方法参数类型即监听的事件类型 |
| `ApplicationListener<E>` | 监听器接口，框架内部与早期代码常见，业务代码用注解即可 |
| `ApplicationEventMulticaster` | 真正负责把事件分发给监听器，默认 `SimpleApplicationEventMulticaster` |

事件是**进程内、内存中**的：不跨服务、不持久化、进程重启即丢失。跨服务通信用消息队列，见 [消息队列总览](/messaging/0_overview)。

---

## 二、定义、发布与监听

### 1、定义事件

```java
// 推荐：不可变 record，无需继承任何类
public record OrderCreatedEvent(Long orderId, String userId, BigDecimal amount) {}

// 需要 source / timestamp 时才继承 ApplicationEvent
public class OrderPaidEvent extends ApplicationEvent {
    private final Long orderId;

    public OrderPaidEvent(Object source, Long orderId) {
        super(source);
        this.orderId = orderId;
    }

    public Long getOrderId() { return orderId; }
}
```

### 2、发布事件

```java
@Service
@RequiredArgsConstructor
public class OrderService {

    private final OrderRepository orderRepo;
    private final ApplicationEventPublisher eventPublisher;

    @Transactional
    public OrderVO createOrder(OrderCreateDTO dto) {
        Order order = orderRepo.save(Order.from(dto));
        // 业务完成后发布事件，让其他模块响应
        eventPublisher.publishEvent(
            new OrderCreatedEvent(order.getId(), dto.userId(), order.getTotalAmount()));
        return OrderVO.from(order);
    }
}
```

### 3、监听事件

```java
@Component
@RequiredArgsConstructor
@Slf4j
public class OrderEventListener {

    private final NotificationService notificationService;

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

    // 返回值非 null 时会作为新事件继续发布（返回数组或集合则逐个发布）
    @EventListener
    public OrderAuditEvent toAudit(OrderPaidEvent event) {
        return new OrderAuditEvent(event.getOrderId(), "PAID");
    }
}
```

> 返回值转发事件对 `@Async` 监听器不生效；异步场景需要继续发布时，在方法里显式调用 `publishEvent`。

---

## 三、同步与异步

**默认同步**：监听器在发布线程中依次执行，全部执行完 `publishEvent` 才返回；监听器抛出的异常会直接抛给发布方，在事务里还会导致事务回滚。

### 1、@Async 异步监听

```java
@Configuration
@EnableAsync
public class AsyncConfig {

    // 专用于事件处理的线程池（@Bean 返回 ThreadPoolTaskExecutor 时由容器负责 initialize / shutdown）
    @Bean("eventExecutor")
    public ThreadPoolTaskExecutor eventExecutor() {
        ThreadPoolTaskExecutor executor = new ThreadPoolTaskExecutor();
        executor.setCorePoolSize(4);
        executor.setMaxPoolSize(16);
        executor.setQueueCapacity(200);
        executor.setThreadNamePrefix("event-");
        executor.setRejectedExecutionHandler(new ThreadPoolExecutor.CallerRunsPolicy());
        executor.setWaitForTasksToCompleteOnShutdown(true);
        executor.setAwaitTerminationSeconds(30);
        return executor;
    }
}

@Component
@RequiredArgsConstructor
public class OrderAsyncListener {

    private final EmailService emailService;

    @Async("eventExecutor")     // 不阻塞发布线程
    @EventListener
    public void sendEmail(OrderCreatedEvent event) {
        emailService.sendConfirmation(event.userId());
    }
}
```

- Spring Boot 已自动配置名为 `applicationTaskExecutor` 的执行器，`@Async` 不指定名称时使用它，线程池参数用 `spring.task.execution.pool.*` 调整；开启 `spring.threads.virtual.enabled=true` 后改为虚拟线程执行，见 [虚拟线程](/java/30_topic_virtual_thread)
- 异步监听器的异常**不会**传回发布方，`void` 方法的异常交给 `AsyncUncaughtExceptionHandler`（默认只打日志），需要实现 `AsyncConfigurer` 自定义处理与告警
- 异步执行时 `ThreadLocal` 中的内容（如 `SecurityContext`、MDC 中的 traceId）不会自动传递，需要 `TaskDecorator` 处理，见 [日志 · traceId](/spring-boot/12_logging)
- 线程池参数怎么定、拒绝策略怎么选见 [线程池](/java/28_topic_thread_pool)

### 2、全局异步：ApplicationEventMulticaster

给 `SimpleApplicationEventMulticaster` 设置 `TaskExecutor` 后，**所有**监听器（包括 Spring 内部的）都变成异步：

```java
@Bean(name = AbstractApplicationContext.APPLICATION_EVENT_MULTICASTER_BEAN_NAME)
public ApplicationEventMulticaster applicationEventMulticaster(ThreadPoolTaskExecutor eventExecutor) {
    SimpleApplicationEventMulticaster multicaster = new SimpleApplicationEventMulticaster();
    multicaster.setTaskExecutor(eventExecutor);
    multicaster.setErrorHandler(t -> LoggerFactory.getLogger("event").error("事件处理失败", t));
    return multicaster;
}
```

影响面太大（事务事件的同步语义、启动事件的顺序都会变化），一般只在确实需要时才用，按监听器 `@Async` 更可控。

---

## 四、监听器排序

多个监听器监听同一事件时，用 `@Order` 控制执行顺序（数字越小越先执行）：

```java
@Component
public class OrderSyncListeners {

    @EventListener
    @Order(1)
    public void validate(OrderCreatedEvent event) { /* 先校验 */ }

    @EventListener
    @Order(2)
    public void reserveStock(OrderCreatedEvent event) { /* 再预占库存 */ }

    @EventListener
    @Order(3)
    public void notifyUser(OrderCreatedEvent event) { /* 最后通知 */ }
}
```

> [!warning]
> `@Order` 只决定**提交**到执行器的顺序。监听器加了 `@Async` 后在不同线程并发执行，完成顺序不确定；存在先后依赖的步骤不要拆成异步监听器。

---

## 五、条件监听

`condition` 是 SpEL，`#event` 引用事件对象：

```java
@EventListener(condition = "#event.amount() > 1000")
public void onHighValueOrder(OrderCreatedEvent event) {
    vipService.notifyVipTeam(event.orderId());
}

@EventListener(condition = "#event.userId().startsWith('VIP_')")
public void onVipOrder(OrderCreatedEvent event) {
    giftService.sendGift(event.userId());
}
```

- record 的访问器是 `amount()` 而不是 `getAmount()`，用方法调用形式 `#event.amount()` 最稳妥，不依赖 SpEL 属性访问器对 record 风格方法的支持
- SpEL 的比较运算支持 `BigDecimal` 与整数字面量比较，`#event.amount() > 1000` 按数值比较
- 条件复杂时，与其写长 SpEL，不如在方法内 `if` 判断，可读、可测试

---

## 六、事务事件：@TransactionalEventListener

### 1、执行时机

在事务中发布事件时，普通 `@EventListener` 会**立即同步执行**，此时事务还没提交：监听器里发 MQ、发通知，如果事务随后回滚，就发出了「幽灵消息」。`@TransactionalEventListener` 把监听器绑定到事务的某个阶段：

![@TransactionalEventListener 各阶段执行时机](../assets/spring/spring_tx_event_phases.svg)

| 阶段 | 时机 | 典型用途 |
|------|------|---------|
| `BEFORE_COMMIT` | 提交前，仍在原事务内 | 需要与业务数据同生共死的写入（审计、Outbox 记录） |
| `AFTER_COMMIT`（默认） | 提交成功后 | 发 MQ、推送通知、删缓存 |
| `AFTER_ROLLBACK` | 回滚后 | 补偿、告警 |
| `AFTER_COMPLETION` | 提交或回滚后 | 指标记录、资源清理 |

```java
@Component
@RequiredArgsConstructor
@Slf4j
public class OrderTransactionalListener {

    private final OrderMessageProducer producer;
    private final AlertService alertService;

    @TransactionalEventListener      // 默认 AFTER_COMMIT
    public void afterCommit(OrderCreatedEvent event) {
        producer.sendOrderCreated(event);
    }

    @TransactionalEventListener(phase = TransactionPhase.AFTER_ROLLBACK)
    public void afterRollback(OrderCreatedEvent event) {
        alertService.notify("订单事务回滚: " + event.orderId());
    }
}
```

> [!warning]
> 没有活动事务时发布事件，`@TransactionalEventListener` **默认不执行**，事件被静默丢弃。需要在无事务时也触发，设置 `fallbackExecution = true`。

### 2、AFTER_COMMIT 里写库：必须 REQUIRES_NEW

AFTER_COMMIT 阶段原事务已经提交，但事务资源（连接、`EntityManager`）**仍绑定在当前线程上**。此时监听器里的数据库写操作会「加入」这个已经提交完毕的事务，不会再被提交——更新静默丢失，或者抛出 `TransactionRequiredException` 后被框架吞掉只打 DEBUG 日志。

正确写法是让监听器开启一个**新事务**：

```java
@Component
@RequiredArgsConstructor
public class PointListener {

    private final PointService pointService;

    @TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT)
    @Transactional(propagation = Propagation.REQUIRES_NEW)    // 独立的新事务
    public void award(OrderCreatedEvent e) {
        pointService.award(e.userId(), e.amount());
    }
}
```

- Framework 6.1 起框架会在启动时校验：`@TransactionalEventListener` 方法上若有 `@Transactional`，传播行为只能是 `REQUIRES_NEW` 或 `NOT_SUPPORTED`，否则启动失败
- 监听器加了 `@Async` 时在新线程执行，不存在资源绑定问题，但写库仍需要自己的事务，同样用 `REQUIRES_NEW`
- AFTER_COMMIT 监听器抛出的异常不会影响已提交的原事务，也不会抛给发布方，只会被记录日志——**失败了没有人知道**

### 3、可靠性边界：至多一次

事务事件解决了「回滚了还发消息」的问题，但没有解决「提交了却没发出去」：

- 事务提交成功后、监听器执行完成前，**进程崩溃或重启**，事件就丢了（只在内存中）
- 监听器执行失败（MQ 不可用、下游超时），没有重试，也没有记录

也就是说，进程内事件是**至多一次（at-most-once）**投递。对于「订单已创建，必须扣库存 / 必须发消息」这类不能丢的场景，需要把事件持久化：

| 方案 | 做法 | 适用 |
|------|------|------|
| 事务性 Outbox（本地消息表） | 在业务事务内把事件写入消息表，提交后由定时任务或 CDC 投递到 MQ，失败重试 | 跨服务，需要 MQ，通用方案。见 [分布式事务 · 本地消息表](/distributed/4_transaction) |
| Spring Modulith 事件发布注册表 | 引入 `spring-modulith-starter-jdbc`（或 `-jpa`），发布事件时在原事务内为每个事务监听器记录一条发布记录，监听器成功后标记完成；失败的记录保留，可配置 `spring.modulith.events.republish-outstanding-events-on-restart=true` 在重启时重新投递 | 单体或模块化单体内部，模块间可靠的异步事件 |
| 事务消息 | RocketMQ 半消息 + 回查 | 已使用 RocketMQ 的场景，见 [分布式事务 · 可靠消息最终一致性](/distributed/4_transaction) |

Spring Modulith 提供的 `@ApplicationModuleListener` 等价于 `@Async` + `@Transactional(propagation = REQUIRES_NEW)` + `@TransactionalEventListener` 三者组合，正好是上一节推荐的写法：

```java
@Component
class InventoryManagement {

    @ApplicationModuleListener     // 提交后异步执行，独立事务；配合发布注册表可重投
    void on(OrderCreatedEvent event) { /* ... */ }
}
```

由于可能重投，监听器本身必须**幂等**，见 [幂等方案总结](/architecture/5_idempotence)。

---

## 七、Spring 内置事件

| 事件 | 时机 | 说明 |
|------|------|------|
| `ContextRefreshedEvent` | 容器初始化或刷新完成 | 父子容器、手动 `refresh()` 时会**触发多次**，做一次性初始化要防重 |
| `ApplicationStartedEvent` | Boot：容器刷新完成，Runner 执行前 | |
| `ApplicationReadyEvent` | Boot：Runner 执行完毕，应用可以接收流量 | **缓存预热、注册上线**等放这里 |
| `ContextClosedEvent` | 容器关闭 | 释放资源；优雅停机见 [优雅上下线与变更](/high-avail/8_graceful_release) |
| `RequestHandledEvent` | Spring MVC 处理完一个请求 | 每个请求一次，监听器要轻量 |

```java
@Component
@RequiredArgsConstructor
@Slf4j
public class StartupListener {

    private final CacheWarmUpService cacheWarmUpService;

    @EventListener(ApplicationReadyEvent.class)
    public void onReady() {
        log.info("应用启动完成，开始预热缓存");
        cacheWarmUpService.warmUp();
    }
}
```

启动阶段的执行顺序与 `ApplicationRunner` / `CommandLineRunner` 的取舍见 [启动与部署优化](/spring-boot/14_startup)。

---

## 八、实战：事件驱动的订单后续动作

用事件把订单创建后的后续动作从 `OrderService` 中剥离，但要按**一致性要求**区分处理方式，而不是一律 AFTER_COMMIT：

```java
// 之前：OrderService 直接调用多个服务，新增一个后续动作就要改订单代码
@Transactional
public void createOrder(OrderCreateDTO dto) {
    Order order = orderRepo.save(Order.from(dto));
    inventoryService.deduct(order);
    pointService.award(order);
    notificationService.notify(order);
}

// 之后：OrderService 只发布事件
@Transactional
public void createOrder(OrderCreateDTO dto) {
    Order order = orderRepo.save(Order.from(dto));
    eventPublisher.publishEvent(
        new OrderCreatedEvent(order.getId(), dto.userId(), order.getTotalAmount()));
}
```

```java
// 库存：与订单强一致，必须同一事务 —— 同步 @EventListener，在原事务中执行，失败则订单一起回滚
@Component
@RequiredArgsConstructor
class InventoryListener {
    private final InventoryService inventoryService;

    @EventListener
    public void deduct(OrderCreatedEvent e) {
        inventoryService.deduct(e.orderId());
    }
}

// 积分：允许稍后完成，但需要写库 —— 提交后异步、独立事务
@Component
@RequiredArgsConstructor
class PointListener {
    private final PointService pointService;

    @Async("eventExecutor")
    @TransactionalEventListener
    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public void award(OrderCreatedEvent e) {
        pointService.award(e.userId(), e.amount());
    }
}

// 通知：丢了可以接受 —— 提交后异步发送即可
@Component
@RequiredArgsConstructor
class NotificationListener {
    private final NotificationService notificationService;

    @Async("eventExecutor")
    @TransactionalEventListener
    public void notify(OrderCreatedEvent e) {
        notificationService.send(e.userId());
    }
}
```

| 后续动作 | 一致性要求 | 方式 |
|---------|-----------|------|
| 扣库存（同库） | 与订单同生共死 | 同步 `@EventListener`，同一事务 |
| 发积分 | 最终一致，不能丢 | AFTER_COMMIT + `REQUIRES_NEW`，生产上配合发布注册表或 Outbox 防丢 |
| 发通知 | 尽力而为 | AFTER_COMMIT + `@Async` |
| 通知其他服务 | 最终一致，跨进程 | Outbox / 事务消息 → MQ |

事件让代码解耦了，但**调用链变隐式**了：读 `createOrder` 看不出会发生什么。监听器多了以后要有清单和监控；模块边界清晰的单体可以考虑 Spring Modulith 统一管理模块与事件。CQRS、事件溯源等架构模式见 [架构模式与风格](/architecture/2_arch_patterns)。

---

## 小结

- 事件是进程内、内存中的观察者模式，任意对象都可作为事件；默认同步执行，异常会抛回发布方
- `@Async` 让监听器异步执行：异常不回传、`ThreadLocal` 不传递；Boot 自动配置 `applicationTaskExecutor`，可切换虚拟线程
- 条件监听对 record 用 `#event.amount()` 方法调用形式；`@Order` 对异步监听器只决定提交顺序
- `@TransactionalEventListener` 默认 AFTER_COMMIT，无事务时默认不执行；AFTER_COMMIT 里写库必须 `REQUIRES_NEW`（6.1 起启动校验）
- 进程内事件是至多一次：崩溃或监听失败就丢；不能丢的事件用 Outbox、Spring Modulith 事件发布注册表或事务消息，并保证监听器幂等
- 一次性初始化用 `ApplicationReadyEvent`，`ContextRefreshedEvent` 可能触发多次

## 参考资料

- Spring Framework - Standard and Custom Events：[https://docs.spring.io/spring-framework/reference/core/beans/context-introduction.html#context-functionality-events](https://docs.spring.io/spring-framework/reference/core/beans/context-introduction.html#context-functionality-events)
- Spring Framework - Transaction-bound Events：[https://docs.spring.io/spring-framework/reference/data-access/transaction/event.html](https://docs.spring.io/spring-framework/reference/data-access/transaction/event.html)
- Spring Modulith - Working with Application Events：[https://docs.spring.io/spring-modulith/reference/events.html](https://docs.spring.io/spring-modulith/reference/events.html)

> 下一篇：[WebFlux](./8_webflux) —— 从阻塞式 Servlet 到响应式编程，看 Reactor 如何用少量线程处理大量并发。
