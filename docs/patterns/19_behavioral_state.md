# 状态模式

**作用**：允许对象在**内部状态改变时改变其行为**，将每种状态的行为封装到独立的类中，消除大量 if-else/switch。

**应用场景**：
- 订单状态机（待支付 → 已支付 → 已发货 → 已完成 → 已取消）
- 工作流审批流转
- 交通灯控制
- Spring State Machine 框架

---

## 一、枚举 + 状态接口（推荐）

```java
// 状态接口：定义各状态下的合法操作
public interface OrderState {
    void pay(OrderContext ctx);
    void ship(OrderContext ctx);
    void complete(OrderContext ctx);
    void cancel(OrderContext ctx);
}

// 上下文：持有当前状态
public class OrderContext {
    private OrderState state;
    private final Long orderId;

    public OrderContext(Long orderId) {
        this.orderId = orderId;
        this.state   = PendingState.INSTANCE;   // 初始状态
    }

    public void setState(OrderState state) { this.state = state; }
    public Long getOrderId() { return orderId; }

    // 委托给当前状态处理
    public void pay()      { state.pay(this); }
    public void ship()     { state.ship(this); }
    public void complete() { state.complete(this); }
    public void cancel()   { state.cancel(this); }
}

// 待支付状态
public enum PendingState implements OrderState {
    INSTANCE;

    @Override
    public void pay(OrderContext ctx) {
        System.out.println("订单 " + ctx.getOrderId() + " 支付成功");
        ctx.setState(PaidState.INSTANCE);
    }

    @Override
    public void ship(OrderContext ctx) {
        throw new IllegalStateException("未支付，不能发货");
    }

    @Override
    public void complete(OrderContext ctx) {
        throw new IllegalStateException("未支付，不能完成");
    }

    @Override
    public void cancel(OrderContext ctx) {
        System.out.println("订单 " + ctx.getOrderId() + " 已取消");
        ctx.setState(CancelledState.INSTANCE);
    }
}

// 已支付状态
public enum PaidState implements OrderState {
    INSTANCE;

    @Override
    public void pay(OrderContext ctx) {
        throw new IllegalStateException("已支付，不能重复支付");
    }

    @Override
    public void ship(OrderContext ctx) {
        System.out.println("订单 " + ctx.getOrderId() + " 已发货");
        ctx.setState(ShippedState.INSTANCE);
    }

    @Override
    public void complete(OrderContext ctx) {
        throw new IllegalStateException("未发货，不能完成");
    }

    @Override
    public void cancel(OrderContext ctx) {
        System.out.println("订单已支付，取消需退款");
        ctx.setState(CancelledState.INSTANCE);
    }
}

// 使用
OrderContext order = new OrderContext(1001L);
order.pay();       // 待支付 → 已支付
order.ship();      // 已支付 → 已发货
order.complete();  // 已发货 → 已完成
```

---

## 二、Spring State Machine（复杂场景）

```java
@Configuration
@EnableStateMachine
public class OrderStateMachineConfig extends StateMachineConfigurerAdapter<OrderStatus, OrderEvent> {

    @Override
    public void configure(StateMachineStateConfigurer<OrderStatus, OrderEvent> states) throws Exception {
        states.withStates()
            .initial(OrderStatus.PENDING)
            .states(EnumSet.allOf(OrderStatus.class));
    }

    @Override
    public void configure(StateMachineTransitionConfigurer<OrderStatus, OrderEvent> transitions) throws Exception {
        transitions
            .withExternal().source(PENDING).target(PAID).event(PAY)
            .and()
            .withExternal().source(PAID).target(SHIPPED).event(SHIP)
            .and()
            .withExternal().source(SHIPPED).target(COMPLETED).event(COMPLETE);
    }
}
```

---

## 三、状态模式 vs if-else

| 维度 | if-else | 状态模式 |
|------|---------|---------|
| 新增状态 | 修改现有代码 | 新增状态类，符合开闭原则 |
| 可读性 | 随状态增多急剧下降 | 每个状态类职责单一，清晰 |
| 测试 | 分支组合爆炸 | 每个状态独立测试 |
