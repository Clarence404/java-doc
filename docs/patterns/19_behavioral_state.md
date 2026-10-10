---
description: sealed + record 状态、枚举转换表、持久化与并发、状态机框架现状、状态 vs 策略
---

# 状态模式

> 前置阅读：[版本演进](/java/2_version)

状态模式让对象在内部状态改变时改变行为。本篇用 sealed 接口 + record 写完整的状态模式，讲可持久化的枚举转换表订单状态机、数据库条件更新、Spring Statemachine 已停止开源维护的现状，以及状态模式与策略模式的区别。

---

## 一、定义与角色

GoF 的定义：允许一个对象在内部状态改变时改变它的行为，对象看起来好像修改了它的类。

做法是把「每种状态下各个操作该怎么做」拆进独立的状态对象，上下文只持有当前状态并把操作委托给它，从而消掉散落在各处的 `if (status == ...)`。

![状态模式的角色](../assets/patterns/state_structure.svg)

| 角色 | 职责 | 示例中的类 |
|------|------|-----------|
| Context | 持有当前状态，把操作委托给状态对象 | `Order` |
| State | 声明各状态都要响应的操作 | `OrderState` |
| ConcreteState | 实现某一状态下的行为，并决定下一个状态 | `Pending`、`Paid` 等 |

订单的状态流转如下：取消是从「待支付」「已支付」分出去的独立分支，已发货之后不能取消，已完成、已取消都是终态。

![订单状态流转](../assets/patterns/state_order_transition.svg)

---

## 二、sealed 接口 + record 实现

每个状态是一个 record，接口用默认方法把「不允许的操作」统一抛异常，状态只需重写自己允许的操作，并**返回下一个状态**：

```java
public sealed interface OrderState
        permits Pending, Paid, Shipped, Completed, Cancelled {

    default OrderState pay()      { throw illegal("支付"); }
    default OrderState ship()     { throw illegal("发货"); }
    default OrderState complete() { throw illegal("确认收货"); }
    default OrderState cancel()   { throw illegal("取消"); }

    private IllegalStateException illegal(String action) {
        return new IllegalStateException(getClass().getSimpleName() + " 状态下不能" + action);
    }
}

record Pending() implements OrderState {
    @Override public OrderState pay()    { return new Paid(); }
    @Override public OrderState cancel() { return new Cancelled("用户取消"); }
}

record Paid() implements OrderState {
    @Override public OrderState ship()   { return new Shipped(); }
    @Override public OrderState cancel() { return new Cancelled("已支付取消，需退款"); }
}

record Shipped() implements OrderState {
    @Override public OrderState complete() { return new Completed(); }
}

record Completed() implements OrderState {}                 // 终态：全部操作都拒绝

record Cancelled(String reason) implements OrderState {}    // 终态，带取消原因
```

上下文只做委托；因为接口是 sealed 的，`switch` 不写 `default` 也能被编译器检查是否覆盖了所有状态，以后新增状态漏改这里会直接编译失败：

```java
public final class Order {
    private final long id;
    private OrderState state = new Pending();

    public Order(long id) { this.id = id; }

    public void pay()      { state = state.pay(); }
    public void ship()     { state = state.ship(); }
    public void complete() { state = state.complete(); }
    public void cancel()   { state = state.cancel(); }

    public String statusText() {
        return switch (state) {
            case Pending p                -> "待支付";
            case Paid p                   -> "已支付";
            case Shipped s                -> "已发货";
            case Completed c              -> "已完成";
            case Cancelled(String reason) -> "已取消（" + reason + "）";
        };
    }
}

public class StateDemo {
    public static void main(String[] args) {
        Order order = new Order(1001L);
        order.pay();
        order.ship();
        order.complete();
        System.out.println(order.statusText());   // 已完成

        Order other = new Order(1002L);
        other.pay();
        other.cancel();
        System.out.println(other.statusText());   // 已取消（已支付取消，需退款）
        other.ship();                              // IllegalStateException: Cancelled 状态下不能发货
    }
}
```

状态对象不持有可变字段，可以安全复用；有状态相关的数据（如取消原因）就放在 record 的组件里。

---

## 三、枚举 + 转换表

业务系统里状态通常要存进数据库，用枚举表示状态、用一张 `EnumMap` 表达「当前状态 + 事件 → 下一状态」更直观，转换规则一眼可见，也方便和数据库里的字符串互转：

```java
public enum OrderStatus { PENDING, PAID, SHIPPED, COMPLETED, CANCELLED }

public enum OrderEvent { PAY, SHIP, COMPLETE, CANCEL }

public final class OrderTransitions {
    private static final Map<OrderStatus, Map<OrderEvent, OrderStatus>> TABLE =
            new EnumMap<>(OrderStatus.class);

    static {
        add(OrderStatus.PENDING, OrderEvent.PAY,      OrderStatus.PAID);
        add(OrderStatus.PENDING, OrderEvent.CANCEL,   OrderStatus.CANCELLED);
        add(OrderStatus.PAID,    OrderEvent.SHIP,     OrderStatus.SHIPPED);
        add(OrderStatus.PAID,    OrderEvent.CANCEL,   OrderStatus.CANCELLED);
        add(OrderStatus.SHIPPED, OrderEvent.COMPLETE, OrderStatus.COMPLETED);
    }

    private static void add(OrderStatus from, OrderEvent event, OrderStatus to) {
        TABLE.computeIfAbsent(from, k -> new EnumMap<>(OrderEvent.class)).put(event, to);
    }

    public static OrderStatus next(OrderStatus from, OrderEvent event) {
        OrderStatus to = TABLE.getOrDefault(from, Map.of()).get(event);
        if (to == null) {
            throw new IllegalStateException(from + " 不接受事件 " + event);
        }
        return to;
    }
}
```

两种写法的取舍：状态下的行为差异大（每个状态要做不同的计算、调用不同的服务）用状态类；只是「能不能转、转到哪」用转换表。

---

## 四、持久化与并发

内存里的状态模式只解决了「规则写在哪」，订单状态真正落在数据库里，还要处理并发和重复请求：

- **只用条件更新改状态**：把「当前状态」作为更新条件，影响行数为 0 说明状态已被别人改过（重复回调、并发取消），按幂等处理而不是报错

```sql
UPDATE t_order
SET    status = 'PAID', version = version + 1
WHERE  id = ? AND status = 'PENDING';
```

- **先校验再更新**：用 `OrderTransitions.next(status, event)` 在应用层算出目标状态并拒绝非法转换，再执行上面的条件更新
- **副作用放在更新成功之后**：状态更新成功（影响 1 行）才发消息、扣库存，否则重复请求会重复触发
- **记录状态流水**：每次转换写一条「订单号、原状态、新状态、事件、时间」记录，方便对账和排查

完整的订单状态机、支付回调与超时关单见 [订单](/scenario/5_order_system) 和 [支付系统](/scenario/14_payment)，条件更新做幂等的原理见 [幂等设计](/architecture/5_idempotence)。

---

## 五、状态机框架

Spring Statemachine 曾是 Spring 生态里的状态机框架。2025 年 4 月 Spring 团队宣布不再以开源方式维护它，4.0.x 是最后的开源版本线，后续版本只提供给 Tanzu Spring 商业客户，GitHub 仓库已标注不再维护。新项目不建议再引入。

可选的替代方案：

- **枚举转换表**（第三节）：几十行代码，状态和事件不多时最简单
- **COLA StateMachine**（阿里 COLA 组件之一）：用流式 API 声明转换规则，状态机本身无状态、可单例复用，状态存在业务对象里
- **工作流引擎**（Flowable、Camunda 等）：有人工审批、长时间等待、可视化流程编排需求时再考虑

---

## 六、状态 vs 策略

两者的类图几乎一样（上下文持有一个接口，接口有多个实现），区别在于**谁来切换**：

| 维度 | 状态 | 策略 |
|------|------|------|
| 谁决定用哪个实现 | 状态对象自己决定下一个状态 | 客户端选择策略 |
| 实现之间是否知道彼此 | 知道，`Pending` 会返回 `Paid` | 互不知道 |
| 切换频率 | 随业务事件不断变化 | 通常创建时选定，很少变化 |
| 解决的问题 | 状态相关的行为和流转规则 | 同一件事的多种算法可互换 |

和 if-else 相比，状态模式的好处是：新增状态只加一个类（sealed 接口会让编译器提示需要同步修改的 `switch`），每个状态可以单独测试。

---

## 小结

- 状态模式把「某状态下的行为」放进状态对象，上下文只委托；状态对象自己返回下一个状态
- JDK 21 写法：sealed 接口 + record 状态，默认方法统一拒绝非法操作，`switch` 由编译器保证覆盖所有状态
- 需要持久化的流转用枚举 + `EnumMap` 转换表；落库时以当前状态为条件做更新，影响 0 行按幂等处理
- Spring Statemachine 已停止开源维护，用转换表、COLA StateMachine 或工作流引擎替代
- 状态与策略结构相同，区别是状态自己切换、策略由客户端选

## 参考资料

- Refactoring.Guru State：[https://refactoring.guru/design-patterns/state](https://refactoring.guru/design-patterns/state)
- JEP 409 Sealed Classes：[https://openjdk.org/jeps/409](https://openjdk.org/jeps/409)
- JEP 441 Pattern Matching for switch：[https://openjdk.org/jeps/441](https://openjdk.org/jeps/441)
- Spring 博客（Spring Statemachine 停止开源维护）：[https://spring.io/blog/2025/04/21/spring-cloud-data-flow-commercial](https://spring.io/blog/2025/04/21/spring-cloud-data-flow-commercial)
- Spring Statemachine 仓库：[https://github.com/spring-projects/spring-statemachine](https://github.com/spring-projects/spring-statemachine)
- COLA：[https://github.com/alibaba/COLA](https://github.com/alibaba/COLA)

> 下一篇：[策略模式](./20_behavioral_strategy) —— Comparator 与 lambda、枚举策略、Spring 注入策略表、策略工厂。
