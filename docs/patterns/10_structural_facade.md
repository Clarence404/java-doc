# 外观模式

**作用**：为复杂子系统提供一个**简化的统一接口**，隐藏内部复杂度，降低客户端与子系统的耦合。

**应用场景**：
- Spring `JdbcTemplate`：封装获取连接、创建语句、处理结果集、关闭资源等底层细节
- SLF4J：统一日志门面，屏蔽 Logback/Log4j 等具体实现
- Service 层：聚合多个 Repository/远程调用，对 Controller 提供简单接口
- 微服务网关：统一入口屏蔽后端多服务拓扑

---

## 一、实现示例

以「下单流程」聚合多个子系统为例：

```java
// 子系统 1：库存
@Service
public class InventoryService {
    public void reserve(Long productId, int qty) {
        System.out.println("库存锁定: product=" + productId + " qty=" + qty);
    }
    public void release(Long productId, int qty) {
        System.out.println("库存释放: product=" + productId);
    }
}

// 子系统 2：支付
@Service
public class PaymentService {
    public String pay(Long userId, BigDecimal amount) {
        System.out.println("支付成功: user=" + userId + " amount=" + amount);
        return "PAY_" + System.currentTimeMillis();
    }
}

// 子系统 3：通知
@Service
public class NotificationService {
    public void sendOrderConfirm(Long userId, String orderId) {
        System.out.println("通知发送: user=" + userId + " order=" + orderId);
    }
}

// 外观：对 Controller 提供简单的 placeOrder 接口
@Service
public class OrderFacade {
    private final InventoryService  inventory;
    private final PaymentService    payment;
    private final NotificationService notify;

    public OrderFacade(InventoryService inventory, PaymentService payment,
                       NotificationService notify) {
        this.inventory = inventory;
        this.payment   = payment;
        this.notify    = notify;
    }

    public String placeOrder(Long userId, Long productId, int qty, BigDecimal amount) {
        // 1. 锁定库存
        inventory.reserve(productId, qty);
        try {
            // 2. 支付
            String payId = payment.pay(userId, amount);
            // 3. 通知
            notify.sendOrderConfirm(userId, payId);
            return payId;
        } catch (Exception e) {
            // 回滚库存
            inventory.release(productId, qty);
            throw e;
        }
    }
}

// Controller 只与 Facade 交互，不感知子系统
@RestController
public class OrderController {
    private final OrderFacade facade;

    @PostMapping("/orders")
    public String createOrder(@RequestBody PlaceOrderRequest req) {
        return facade.placeOrder(req.getUserId(), req.getProductId(),
                                  req.getQty(), req.getAmount());
    }
}
```

---

## 二、注意事项

- 外观不应该成为"上帝对象"——它只负责**编排**，不包含业务逻辑
- 子系统内部仍可被直接调用，外观只是提供一条便捷路径
- 过多的外观层会引入不必要的间接，适可而止
