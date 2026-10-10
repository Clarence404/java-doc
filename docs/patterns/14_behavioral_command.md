---
description: 请求封装为对象、Receiver 与 Invoker、撤销与补偿、Runnable 与线程池、命令总线、命令 vs 策略
---

# 命令模式

> 前置阅读：[责任链模式](./13_behavioral_chain_of_responsibility)

命令模式（Command）把一个请求封装成**对象**，请求变成对象之后就可以排队、延迟执行、记录日志、撤销重做。本篇讲五个角色、支持撤销的命令队列与命令总线、`Runnable` 与 Spring 回调里的命令模式，以及命令与策略的区别。

---

## 一、定义与角色

![命令模式的角色（订单操作）](../assets/patterns/command.svg)

| 角色 | 本篇示例 | 职责 |
|------|----------|------|
| Command（命令接口） | `OrderCommand` | 声明 `execute()`，需要撤销时再声明 `undo()` |
| ConcreteCommand（具体命令） | `PlaceOrderCommand`、`PayOrderCommand` | 持有接收者和参数，在 `execute` 里调用接收者 |
| Receiver（接收者） | `OrderService`、`PaymentService` | 真正执行业务的对象 |
| Invoker（调用者） | `CommandExecutor` | 触发命令，可维护历史用于撤销；不认识接收者 |
| Client（客户端） | 组装代码 | 创建具体命令，把接收者注入进去，交给调用者 |

关键是调用者与接收者**解耦**：`CommandExecutor` 只认识 `OrderCommand` 接口，同一个执行器可以执行下单、支付、发券等任意命令。

---

## 二、实现

### 1、带撤销的命令队列

```java
public record CreateOrderRequest(long userId, long productId, int qty) {}

// 接收者
public interface OrderService {
    long create(CreateOrderRequest req);
    void cancel(long orderId);
}

public interface PaymentService {
    String pay(long orderId);
    void refund(String paymentId);
}

// 命令接口
public interface OrderCommand {
    void execute();
    void undo();
}

// 具体命令：下单
public class PlaceOrderCommand implements OrderCommand {
    private final OrderService orderService;
    private final CreateOrderRequest request;
    private Long orderId;   // 执行后才有值，撤销时要用

    public PlaceOrderCommand(OrderService orderService, CreateOrderRequest request) {
        this.orderService = orderService;
        this.request = request;
    }

    @Override
    public void execute() {
        orderId = orderService.create(request);
    }

    @Override
    public void undo() {
        if (orderId != null) {
            orderService.cancel(orderId);
        }
    }

    public long orderId() {
        if (orderId == null) {
            throw new IllegalStateException("命令尚未执行");
        }
        return orderId;
    }
}

// 具体命令：支付
public class PayOrderCommand implements OrderCommand {
    private final PaymentService paymentService;
    private final long orderId;
    private String paymentId;

    public PayOrderCommand(PaymentService paymentService, long orderId) {
        this.paymentService = paymentService;
        this.orderId = orderId;
    }

    @Override
    public void execute() {
        paymentId = paymentService.pay(orderId);
    }

    @Override
    public void undo() {
        if (paymentId != null) {
            paymentService.refund(paymentId);   // 撤销支付 = 退款，是补偿而不是回滚
        }
    }
}

// 调用者：执行命令并记录历史（单线程演示，未做并发控制）
public class CommandExecutor {
    private final Deque<OrderCommand> history = new ArrayDeque<>();

    public void execute(OrderCommand command) {
        command.execute();
        history.push(command);
    }

    public void undoLast() {
        OrderCommand last = history.poll();
        if (last != null) {
            last.undo();
        }
    }
}
```

客户端组装命令。第二个命令需要第一个命令产生的订单号，通过 `orderId()` 取得：

```java
CommandExecutor executor = new CommandExecutor();

PlaceOrderCommand place = new PlaceOrderCommand(orderService, new CreateOrderRequest(1L, 1001L, 2));
executor.execute(place);
executor.execute(new PayOrderCommand(paymentService, place.orderId()));

executor.undoLast();   // 退款
executor.undoLast();   // 取消订单
```

这里的命令用普通类而不是 `record`，因为撤销需要记住执行结果（`orderId`、`paymentId`），状态是可变的。不需要撤销的命令可以直接写成 `record`。

### 2、Lambda 就是命令：Runnable 与线程池

JDK 里最常见的命令就是 `Runnable` / `Callable`：把「要做的事」封装成对象，交给线程池在合适的时机执行。

```java
try (ExecutorService pool = Executors.newVirtualThreadPerTaskExecutor()) {   // Invoker
    Runnable sendSms = () -> smsClient.send(phone, "订单已发货");             // Command，smsClient 是 Receiver
    pool.submit(sendSms);
}   // JDK 19 起 ExecutorService 实现了 AutoCloseable，close 会等待已提交任务完成
```

线程池不知道任务做什么，只负责排队和调度，这正是调用者的角色。线程池本身见 [线程池](/java/28_topic_thread_pool)。

### 3、命令总线：按命令类型分发

CQRS 风格的系统常把每个写操作建模成一个命令 `record`，再由命令总线按类型找到对应的处理器。这里命令只携带数据，执行逻辑在处理器里，便于序列化后放进队列：

```java
public sealed interface Command permits CreateUser, DisableUser {}
public record CreateUser(String username, String email) implements Command {}
public record DisableUser(long userId) implements Command {}

public interface CommandHandler<C extends Command> {
    Class<C> type();
    void handle(C command);
}

@Component
public class CreateUserHandler implements CommandHandler<CreateUser> {
    private final UserRepository userRepository;

    public CreateUserHandler(UserRepository userRepository) {
        this.userRepository = userRepository;
    }

    @Override
    public Class<CreateUser> type() {
        return CreateUser.class;
    }

    @Override
    public void handle(CreateUser command) {
        userRepository.save(new User(command.username(), command.email()));
    }
}

@Component
public class CommandBus {
    private final Map<Class<?>, CommandHandler<?>> handlers;

    public CommandBus(List<CommandHandler<?>> handlers) {
        this.handlers = handlers.stream()
                .collect(Collectors.toMap(CommandHandler::type, h -> h));
    }

    @SuppressWarnings("unchecked")
    public <C extends Command> void dispatch(C command) {
        var handler = (CommandHandler<C>) handlers.get(command.getClass());
        if (handler == null) {
            throw new IllegalArgumentException("没有处理器：" + command.getClass().getSimpleName());
        }
        handler.handle(command);
    }
}
```

`DisableUser` 的处理器写法相同，省略。新增一种命令只需加一个 `record` 和一个处理器 Bean，总线不用改。CQRS 本身的取舍见 [架构模式与风格](/architecture/2_arch_patterns)。

---

## 三、JDK 与 Spring 中的应用

| 例子 | 命令 | 调用者 |
|------|------|--------|
| `Runnable` / `Callable` | 任务对象 | `Thread`、`ExecutorService` |
| `javax.swing.Action` | 菜单项、按钮背后的动作 | 菜单、按钮、快捷键共用同一个 `Action` |
| `TransactionTemplate.execute(TransactionCallback)` | 回调对象，封装「事务内要做的事」 | `TransactionTemplate` 负责开启、提交、回滚 |
| `JdbcTemplate.execute(StatementCallback)` | 回调对象，封装「拿到 Statement 后做什么」 | `JdbcTemplate` 负责获取和释放资源 |
| `@Async` 方法 | 代理把这次方法调用包装成任务 | `TaskExecutor` |

`@Async` 本身是代理：代理拦截方法调用，把它包装成一个任务提交给 `TaskExecutor`，这个任务才是命令。Spring 的模板加回调同时也是 [模板方法模式](./21_behavioral_template_method) 的变体：模板固定流程，回调对象作为命令填充其中可变的一步。

---

## 四、适用场景与常见坑

适合用命令模式的场景：

- 请求要排队、延迟或异步执行：任务队列、定时任务、线程池
- 需要撤销 / 重做：编辑器操作、多步骤业务的补偿
- 需要记录操作日志并能重放：审计、事件溯源中的命令日志
- 同一类操作要由不同的入口触发：菜单、按钮、快捷键执行同一个动作

常见坑：

- **撤销不等于回滚**：撤销支付是发起退款，退款可能失败、可能有手续费，外部副作用（短信、消息）也收不回来。撤销要按补偿设计，并保证幂等，见 [幂等设计](/architecture/5_idempotence)
- **历史无限增长**：撤销栈要设上限，或在事务完成后清空
- **命令对象引用了服务**：要放进消息队列或持久化的命令只能携带数据（如上面的 `record`），不能持有 `OrderService` 这样的对象，执行时再由处理器查找接收者
- **线程安全**：命令执行器被多线程共用时，历史栈需要加锁或改为每个会话一个执行器

---

## 五、与相近模式的区别

| 模式 | 封装的是什么 | 调用方关心什么 | 典型场景 |
|------|-------------|--------------|----------|
| 命令 | **一次请求**：接收者 + 动作 + 参数 | 什么时候执行，能否撤销 | 任务队列、撤销重做、命令总线 |
| [策略](./20_behavioral_strategy) | **一种算法**，可互相替换 | 用哪种算法得出结果 | 计价规则、排序方式、路由选择 |
| [责任链](./13_behavioral_chain_of_responsibility) | 处理者链 | 请求交给链头，由链决定谁处理 | 过滤器、审批 |
| [备忘录](./17_behavioral_memento) | 对象某一时刻的状态快照 | 恢复到之前的状态 | 撤销的另一种实现 |

命令和策略在 Java 里常常都写成一个 Lambda，区别在于用法：策略是「调用方拿来算结果」，通常立即同步调用并使用返回值；命令是「交出去让别人执行」，调用者可能排队、延迟、记录或撤销它。撤销的两种做法：命令记录反向操作，或备忘录保存执行前的状态快照。

---

## 小结

- 命令模式把请求封装成对象，调用者只认识命令接口，不认识接收者
- 五个角色：Command、ConcreteCommand、Receiver（真正干活）、Invoker（触发与记录历史）、Client（组装）
- 撤销依赖命令记住执行结果；涉及外部系统时撤销是补偿，要考虑失败与幂等
- `Runnable` 加线程池是 JDK 中最常见的命令模式；`TransactionTemplate`、`JdbcTemplate` 的回调也是命令
- 命令封装「一次请求」并交给别人执行，策略封装「一种算法」供调用方选用

## 参考资料

- Refactoring Guru：Command：[https://refactoring.guru/design-patterns/command](https://refactoring.guru/design-patterns/command)
- Erich Gamma 等：《设计模式：可复用面向对象软件的基础》，Command 一章
- Java SE 21 API：ExecutorService：[https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/concurrent/ExecutorService.html](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/concurrent/ExecutorService.html)
- Spring Framework Reference：Programmatic Transaction Management：[https://docs.spring.io/spring-framework/reference/data-access/transaction/programmatic.html](https://docs.spring.io/spring-framework/reference/data-access/transaction/programmatic.html)

> 下一篇：[迭代器模式](./15_behavioral_iterator) —— 顺序访问聚合而不暴露内部结构、fail-fast、自定义分页迭代器与 Stream。
