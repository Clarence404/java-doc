---
description: 为子系统提供简单入口、下单流程编排、SLF4J 日志门面、外观 vs 适配器 vs 中介者
---

# 外观模式

> 前置阅读：[装饰器模式](./9_structural_decorator)

外观模式（Facade）给一组复杂子系统提供一个**更简单的统一入口**，客户端只和外观打交道，子系统不感知外观、仍可被直接调用。本篇讲它的角色与边界、只做编排的业务外观写法、SLF4J 等生态中的外观，以及外观、适配器与中介者的区别。

---

## 一、定义与角色

![外观模式的角色（下单流程）](../assets/patterns/facade.svg)

| 角色 | 本篇示例 | 职责 |
|------|----------|------|
| Facade（外观） | `OrderFacade` | 对外提供 `placeOrder`，内部按顺序调用各子系统并处理失败 |
| Subsystem（子系统） | `InventoryService`、`PaymentService`、`NotificationService` | 各自完成一块功能，不知道外观的存在 |
| Client（客户端） | `OrderController` | 只依赖外观 |

外观模式不新增功能，只是**减少客户端需要了解的东西**：把「先锁库存、再支付、失败要释放、成功后通知」这套流程收进一个方法。

---

## 二、实现

以「下单」为例，外观编排三个子系统：

```java
public record PlaceOrderRequest(long userId, long productId, int qty, BigDecimal amount) {}

// 子系统 1：库存
@Service
public class InventoryService {
    public void reserve(long productId, int qty) { /* 锁定库存 */ }
    public void release(long productId, int qty) { /* 释放库存 */ }
}

// 子系统 2：支付
@Service
public class PaymentService {
    public String pay(String orderId, long userId, BigDecimal amount) {
        // … 调用支付渠道
        return "PAY-" + orderId;
    }
}

// 子系统 3：通知
@Service
public class NotificationService {
    public void sendOrderConfirm(long userId, String orderId) { /* 发短信、站内信 */ }
}

// 外观：对 Controller 只暴露 placeOrder
@Service
public class OrderFacade {
    private static final Logger log = LoggerFactory.getLogger(OrderFacade.class);

    private final InventoryService inventory;
    private final PaymentService payment;
    private final NotificationService notification;

    public OrderFacade(InventoryService inventory, PaymentService payment,
                       NotificationService notification) {
        this.inventory = inventory;
        this.payment = payment;
        this.notification = notification;
    }

    public String placeOrder(PlaceOrderRequest req) {
        String orderId = "O" + System.nanoTime();   // 演示用，生产环境用分布式 ID
        inventory.reserve(req.productId(), req.qty());
        try {
            payment.pay(orderId, req.userId(), req.amount());
        } catch (RuntimeException e) {
            inventory.release(req.productId(), req.qty());   // 只有支付失败才释放库存
            throw e;
        }
        try {
            notification.sendOrderConfirm(req.userId(), orderId);
        } catch (RuntimeException e) {
            // 已经扣款成功，通知失败不能让整个下单失败，记录后由重试任务补发
            log.warn("下单通知发送失败 orderId={}", orderId, e);
        }
        return orderId;
    }
}

// 客户端：只与外观交互
@RestController
public class OrderController {
    private final OrderFacade facade;

    public OrderController(OrderFacade facade) {
        this.facade = facade;
    }

    @PostMapping("/orders")
    public String createOrder(@RequestBody PlaceOrderRequest req) {
        return facade.placeOrder(req);
    }
}
```

两个要点：

- **失败处理按步骤区分**：支付失败要释放库存；支付成功后通知失败，不应该回滚已经发生的扣款，而是记录下来补发。一个 `catch` 包住全部步骤，会出现「已扣款但库存被释放」的不一致
- **外观只做编排**：库存怎么锁、钱怎么扣属于子系统，外观里只有调用顺序和失败分支。跨服务的一致性（库存、支付在不同服务时）要靠补偿或分布式事务，见 [分布式事务](/distributed/4_transaction)，分布式 ID 见 [分布式 ID 生成](/distributed/8_id_generator)

---

## 三、JDK 与 Spring 中的应用

| 例子 | 外观对外提供什么 | 屏蔽了什么 |
|------|------------------|-----------|
| SLF4J | `Logger`、`LoggerFactory` 一套 API | 底层是 Logback、Log4j2 还是 JUL；名字本身就是 Simple Logging **Facade** for Java |
| Spring `ApplicationContext` | 一个容器对象 | 背后的 `BeanFactory`、`MessageSource`、`ResourceLoader`、`ApplicationEventPublisher` 等多个接口 |
| `java.nio.file.Files` | `readString`、`copy`、`walk` 等静态方法 | 实际工作交给对应的 `FileSystemProvider`，调用方不用关心是哪种文件系统 |
| Spring `JdbcTemplate` | `query`、`update` | 获取连接、创建语句、遍历结果集、关闭资源、异常转换；它同时也是模板方法加回调的典型，见 [模板方法模式](./21_behavioral_template_method) |

SLF4J 是最典型的外观：业务代码只依赖 `slf4j-api`，换日志实现只需要换依赖，代码不用改。门面、实现与桥接包的关系见 [日志](/spring-boot/12_logging)。

微服务网关常被比作「系统级外观」：客户端只认网关一个入口，背后有多少服务对外不可见。这是架构层面的类比，网关的具体能力见 [API 网关](/spring-cloud/2_api_gateway)。

---

## 四、适用场景与常见坑

适合用外观的场景：

- 子系统多、调用顺序复杂，客户端只关心一个结果
- 要给一个老旧或复杂的模块包一层干净的入口，逐步替换内部实现
- 分层：Controller 只调一个应用服务方法，应用服务编排多个领域服务或仓储

常见坑：

- **变成上帝对象**：所有业务都往外观里塞，外观里出现大量 `if` 和计算逻辑。外观只该有编排，规则应下沉到子系统
- **以为 `@Transactional` 能兜住一切**：在外观方法上加 `@Transactional` 只能回滚本地数据库操作，已经调用的远程支付、已经发出的消息不会被回滚
- **层层套外观**：外观再包外观，每层只是原样转发，徒增调用链长度，没有隐藏任何复杂度的那层应删掉
- **把外观当成强制屏障**：外观是便捷入口，确有需要时客户端仍可以直接调用子系统，不必为每个子系统方法都在外观上加一个转发方法

---

## 五、与相近模式的区别

| 模式 | 解决的问题 | 接口变化 | 对象之间的关系 |
|------|-----------|----------|----------------|
| 外观 | 子系统太复杂，客户端不想了解 | 定义一个**新的、更简单**的接口 | 单向：外观调用子系统，子系统不知道外观 |
| [适配器](./6_structural_adapter) | 已有接口与期望接口**不匹配** | 把一个已有接口**转换**成另一个已有接口 | 通常包装一个对象 |
| [中介者](./16_behavioral_mediator) | 一组同级对象之间**互相调用**成网状 | 同事对象依赖中介者接口 | 双向：同事对象主动通知中介者，中介者再协调其他同事 |

简单记：外观是「把复杂变简单」，适配器是「把不兼容变兼容」，中介者是「把多对多变成一对多」。

---

## 小结

- 外观为一组子系统提供简单统一的入口，客户端只依赖外观，子系统不感知外观
- 外观只做编排和失败分支，按步骤区分失败处理，不要一个 `catch` 回滚全部
- SLF4J 是最典型的外观；`ApplicationContext`、`Files`、`JdbcTemplate` 也都起到了外观的作用
- 外观定义新的简单接口，适配器转换已有接口，中介者协调同级对象之间的交互

## 参考资料

- Refactoring Guru：Facade：[https://refactoring.guru/design-patterns/facade](https://refactoring.guru/design-patterns/facade)
- Erich Gamma 等：《设计模式：可复用面向对象软件的基础》，Facade 一章
- SLF4J Manual：[https://www.slf4j.org/manual.html](https://www.slf4j.org/manual.html)
- Spring Framework Reference：The IoC Container：[https://docs.spring.io/spring-framework/reference/core/beans.html](https://docs.spring.io/spring-framework/reference/core/beans.html)

> 下一篇：[享元模式](./11_structural_flyweight) —— 共享不可变的细粒度对象、Integer 缓存与字符串常量池、享元与对象池的区别。
