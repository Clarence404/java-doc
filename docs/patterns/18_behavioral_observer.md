---
description: 发布订阅对比、lambda 实现、PropertyChangeSupport、Flow、Spring 事件、常见坑
---

# 观察者模式

> 前置阅读：[中介者模式](./16_behavioral_mediator)

观察者模式定义一对多的通知结构，被观察者状态变化时通知所有观察者。本篇讲它与发布订阅的差别，用 lambda、`PropertyChangeSupport`、JDK `Flow` 的实现，Spring 事件的定位，以及同步阻塞、异常中断、监听器泄漏等坑。

---

## 一、定义与角色

GoF 的定义：定义对象之间一对多的依赖关系，当一个对象的状态改变时，所有依赖它的对象都会得到通知并自动更新。

| 角色 | 职责 |
|------|------|
| Subject（主题） | 维护观察者列表，提供订阅 / 取消订阅，状态变化时通知 |
| Observer（观察者） | 定义收到通知时的回调，如 `update(event)` |
| ConcreteObserver | 具体的响应逻辑：发邮件、加积分、刷新界面 |

通知的数据怎么传有两种方式：

| 方式 | 说明 | 示例 |
|------|------|------|
| 推模式 | 主题把变化的数据放进事件对象推给观察者 | Spring 事件携带完整的事件对象 |
| 拉模式 | 只通知「我变了」，观察者自己回主题取数据 | 回调参数只有主题引用，观察者调 `getXxx()` |

---

## 二、观察者 vs 发布订阅

![观察者 vs 发布订阅](../assets/patterns/observer_vs_pubsub.svg)

| 维度 | 观察者 | 发布订阅 |
|------|--------|----------|
| 耦合 | 主题直接持有观察者列表并回调 | 发布者与订阅者都只认识中间的事件通道 |
| 通道 | 无 | 事件总线、Broker（Spring 事件广播器、Kafka、RocketMQ） |
| 同步 / 异步 | 通常同步、同进程 | 可异步、可跨进程 |
| 典型例子 | `PropertyChangeSupport`、Swing 监听器 | Spring `ApplicationEvent`、消息队列 |

发布订阅可以看作观察者的变体：多了一个中间通道，发布者连「有哪些订阅者」都不知道。它和[中介者模式](./16_behavioral_mediator)也不同：通道只按类型或主题分发，不包含协调逻辑。

---

## 三、手写观察者：Consumer 列表

Java 8 之后，观察者接口通常就是一个函数式接口，直接用 `Consumer<T>` 和 lambda：

```java
public record UserRegistered(long userId, String email) {}

public final class EventSource<T> {
    // 写少读多、通知时可能有人取消订阅：用 CopyOnWriteArrayList 避免 ConcurrentModificationException
    private final List<Consumer<? super T>> listeners = new CopyOnWriteArrayList<>();

    /** 返回取消订阅的句柄，调用方负责在不需要时调用 */
    public Runnable subscribe(Consumer<? super T> listener) {
        listeners.add(listener);
        return () -> listeners.remove(listener);
    }

    public void publish(T event) {
        for (Consumer<? super T> listener : listeners) {
            try {
                listener.accept(event);
            } catch (RuntimeException e) {
                // 一个观察者失败不能打断其他观察者
                System.err.println("观察者处理失败：" + e.getMessage());
            }
        }
    }
}

public class ObserverDemo {
    public static void main(String[] args) {
        EventSource<UserRegistered> source = new EventSource<>();
        source.subscribe(e -> System.out.println("发送欢迎邮件给 " + e.email()));
        Runnable cancel = source.subscribe(e -> System.out.println("给用户 " + e.userId() + " 初始化积分"));

        source.publish(new UserRegistered(1L, "a@example.com"));
        cancel.run();                                   // 取消积分观察者
        source.publish(new UserRegistered(2L, "b@example.com"));
    }
}
```

---

## 四、JDK 中的观察者

`java.util.Observable` / `Observer` 从 Java 9 起已废弃。按官方说明，它支持的事件模型很有限，通知顺序没有规定，状态变化与通知也不是一一对应。Javadoc 推荐的替代方案是 `java.beans` 包和 `Flow` API，也就是下面两节。

### 1、PropertyChangeSupport：属性变化通知

`java.beans.PropertyChangeSupport` 帮你维护监听器列表，适合「某个属性变了就通知」的场景（位于 `java.desktop` 模块）：

```java
public class Account {
    private final PropertyChangeSupport changes = new PropertyChangeSupport(this);
    private long balance;

    public void addListener(PropertyChangeListener listener) {
        changes.addPropertyChangeListener(listener);
    }

    public void removeListener(PropertyChangeListener listener) {
        changes.removePropertyChangeListener(listener);
    }

    public void setBalance(long newBalance) {
        long old = balance;
        balance = newBalance;
        changes.firePropertyChange("balance", old, newBalance);   // 新旧值相等时不会通知
    }
}

// 使用
Account account = new Account();
account.addListener(e -> System.out.println(e.getPropertyName() + "：" + e.getOldValue() + " → " + e.getNewValue()));
account.setBalance(100);
```

### 2、Flow：带背压的异步观察者

`java.util.concurrent.Flow`（Java 9）是 Reactive Streams 规范在 JDK 中的接口，`SubmissionPublisher` 是自带的发布者实现：订阅者在独立线程中异步接收，并通过 `request(n)` 控制拉取速度（背压）。

```java
try (var publisher = new SubmissionPublisher<UserRegistered>()) {
    CompletableFuture<Void> done = publisher.consume(
            e -> System.out.println("异步处理 " + e.email()));
    publisher.submit(new UserRegistered(1L, "a@example.com"));
    publisher.submit(new UserRegistered(2L, "b@example.com"));
    publisher.close();       // 通知订阅者 onComplete
    done.join();             // 等订阅者处理完
}
```

`consume` 是 `subscribe` 的简化写法；需要自己控制背压时实现 `Flow.Subscriber`，在 `onSubscribe` 和 `onNext` 里调用 `subscription.request(n)`。业务里更常用的是基于同一规范的 Project Reactor，见 [WebFlux](/spring/8_webflux)。

---

## 五、Spring 事件

Spring 应用里最常用的是 `ApplicationEventPublisher` + `@EventListener`。Spring 4.2 起任意对象都能作为事件，不必继承 `ApplicationEvent`：

```java
public record UserRegisteredEvent(long userId, String email) {}

@Service
public class UserService {
    private final ApplicationEventPublisher publisher;

    public UserService(ApplicationEventPublisher publisher) {
        this.publisher = publisher;
    }

    @Transactional
    public void register(long userId, String email) {
        // … 保存用户
        publisher.publishEvent(new UserRegisteredEvent(userId, email));
    }
}

@Component
class WelcomeMailListener {
    @TransactionalEventListener        // 默认 AFTER_COMMIT：事务提交后才发邮件
    void onRegistered(UserRegisteredEvent event) {
        // … 发送欢迎邮件
    }
}
```

同步与异步、`@TransactionalEventListener` 的各个阶段、监听器排序与可靠性边界，见 [事件机制](/spring/7_event)。

Guava 的 `EventBus` 曾是常见的进程内事件总线，但 Guava 官方文档已明确不推荐使用：订阅关系难以追踪、异常不会传给发布者、不支持背压和泛型事件。新代码在 Spring 里用 Spring 事件，需要异步流处理用 Reactor 或 `Flow`。

---

## 六、常见坑

- **同步观察者拖慢主题**：默认通知是同步串行的，一个观察者慢，主流程就慢。耗时操作放到线程池或改为异步事件
- **一个观察者异常打断后续通知**：通知循环里要捕获单个观察者的异常（见第三节的 `publish`），Spring 同步监听器抛异常会传回发布方
- **监听器泄漏**（lapsed listener）：只订阅不取消，短生命周期对象被长生命周期主题引用，无法回收。订阅时返回取消句柄，在对象销毁时调用
- **通知顺序不确定**：不要让业务依赖观察者的执行顺序；确实需要时显式排序（Spring 用 `@Order`）
- **重入与循环通知**：观察者在回调里又修改主题，可能引起再次通知甚至无限递归。回调里避免修改主题，或者在主题里加「正在通知」标记

---

## 小结

- 观察者 = 主题维护观察者列表，状态变化时逐个回调；发布订阅多了一层事件通道
- 手写时用 `Consumer<T>` + `CopyOnWriteArrayList`，通知循环里隔离异常，订阅时返回取消句柄
- `Observable` 已废弃；属性变化用 `PropertyChangeSupport`，异步带背压用 `Flow` 或 Reactor
- Spring 事件是发布订阅的进程内实现，事件用 record，注入用构造器；Guava `EventBus` 官方不推荐

## 参考资料

- Refactoring.Guru Observer：[https://refactoring.guru/design-patterns/observer](https://refactoring.guru/design-patterns/observer)
- Java SE 21 `Observable`（废弃说明）：[https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/Observable.html](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/Observable.html)
- Java SE 21 `PropertyChangeSupport`：[https://docs.oracle.com/en/java/javase/21/docs/api/java.desktop/java/beans/PropertyChangeSupport.html](https://docs.oracle.com/en/java/javase/21/docs/api/java.desktop/java/beans/PropertyChangeSupport.html)
- Java SE 21 `SubmissionPublisher`：[https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/concurrent/SubmissionPublisher.html](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/concurrent/SubmissionPublisher.html)
- Guava EventBus（Avoid EventBus 说明）：[https://guava.dev/releases/snapshot-jre/api/docs/com/google/common/eventbus/EventBus.html](https://guava.dev/releases/snapshot-jre/api/docs/com/google/common/eventbus/EventBus.html)
- Spring Framework Standard and Custom Events：[https://docs.spring.io/spring-framework/reference/core/beans/context-introduction.html#context-functionality-events](https://docs.spring.io/spring-framework/reference/core/beans/context-introduction.html#context-functionality-events)

> 下一篇：[状态模式](./19_behavioral_state) —— sealed 接口 + record 状态、订单状态机、持久化与并发、Spring Statemachine 现状。
