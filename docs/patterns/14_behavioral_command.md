# 命令模式

**作用**：将**请求封装成对象**，使请求的发送者与接收者解耦，支持请求排队、撤销/重做、日志记录。

**应用场景**：
- CQRS（命令查询责任分离）：每个操作封装为 Command 对象
- Spring `@Async` + 任务队列：任务本身即命令对象
- 编辑器撤销/重做（Undo/Redo）
- Spring Batch `ItemProcessor`：每个处理步骤是命令

---

## 一、实现示例

以「订单操作命令队列」为例：

```java
// 命令接口
public interface OrderCommand {
    void execute();
    void undo();   // 可选，支持撤销
}

// 具体命令：下单
public class PlaceOrderCommand implements OrderCommand {
    private final OrderService orderService;
    private final CreateOrderRequest request;
    private Long createdOrderId;

    public PlaceOrderCommand(OrderService orderService, CreateOrderRequest request) {
        this.orderService = orderService;
        this.request      = request;
    }

    @Override
    public void execute() {
        createdOrderId = orderService.create(request);
        System.out.println("Order created: " + createdOrderId);
    }

    @Override
    public void undo() {
        if (createdOrderId != null) {
            orderService.cancel(createdOrderId);
            System.out.println("Order cancelled: " + createdOrderId);
        }
    }
}

// 具体命令：支付
public class PayOrderCommand implements OrderCommand {
    private final PaymentService paymentService;
    private final Long orderId;
    private String paymentId;

    public PayOrderCommand(PaymentService paymentService, Long orderId) {
        this.paymentService = paymentService;
        this.orderId        = orderId;
    }

    @Override
    public void execute() {
        paymentId = paymentService.pay(orderId);
        System.out.println("Paid: " + paymentId);
    }

    @Override
    public void undo() {
        if (paymentId != null) {
            paymentService.refund(paymentId);
        }
    }
}

// 调用者（Invoker）：命令队列
public class CommandExecutor {
    private final Deque<OrderCommand> history = new ArrayDeque<>();

    public void execute(OrderCommand command) {
        command.execute();
        history.push(command);
    }

    public void undoLast() {
        if (!history.isEmpty()) {
            history.pop().undo();
        }
    }
}

// 使用
CommandExecutor executor = new CommandExecutor();
executor.execute(new PlaceOrderCommand(orderService, req));
executor.execute(new PayOrderCommand(paymentService, orderId));

// 回滚最后一步
executor.undoLast();
```

---

## 二、在 Spring 中的应用

```java
// CQRS 风格：每个操作封装为 Command
public record CreateUserCommand(String username, String email) {}

@Component
public class CreateUserCommandHandler {
    public Long handle(CreateUserCommand cmd) {
        // 执行业务逻辑
        return userRepository.save(new User(cmd.username(), cmd.email())).getId();
    }
}
```
