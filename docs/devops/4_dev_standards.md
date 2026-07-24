# 团队开发规范

> 参考资料：
> * 阿里巴巴 Java 开发手册：[https://github.com/alibaba/p3c](https://github.com/alibaba/p3c)
> * Google Java Style Guide：[https://google.github.io/styleguide/javaguide.html](https://google.github.io/styleguide/javaguide.html)

---

## 一、命名规范

### 基础规则

| 类型 | 规则 | 示例 |
|------|------|------|
| 类名 | UpperCamelCase | `OrderService`、`UserController` |
| 方法名 | lowerCamelCase，动词开头 | `getOrderById`、`createUser` |
| 变量名 | lowerCamelCase，有意义 | `orderList`、`maxRetryCount` |
| 常量 | UPPER_SNAKE_CASE | `MAX_RETRY_COUNT`、`DEFAULT_TIMEOUT` |
| 包名 | 全小写，域名倒写 | `com.example.order.service` |
| 枚举 | UpperCamelCase，值用 UPPER_SNAKE | `OrderStatus.PENDING` |

### 命名语义规范

```java
// ❌ 无意义名称
int a, b, tmp;
List<Object> list1;
String str;

// ✅ 语义清晰
int orderCount, retryTimes;
List<Order> pendingOrders;
String customerEmail;

// ❌ 布尔值命名不清
boolean flag, isOk, check;

// ✅ 布尔值以 is/has/can/should 开头
boolean isActive, hasPermission, canDelete;

// ❌ Controller/Service/Repository 职责混乱
class OrderManager { ... }      // 不明确

// ✅ 后缀体现职责
class OrderController { ... }   // HTTP 接口层
class OrderService    { ... }   // 业务逻辑层
class OrderRepository { ... }   // 数据访问层（DDD 风格）
class OrderMapper     { ... }   // MyBatis Mapper
```

---

## 二、注释规范

```java
// ✅ 注释解释"为什么"，而非"做了什么"（代码本身说明做了什么）

// 使用 SETNX 而非 synchronized，因为服务是多实例部署
boolean locked = redisTemplate.opsForValue().setIfAbsent(lockKey, "1", 30, SECONDS);

// 历史遗留：支付宝回调的金额单位是分，需转换为元（文档 §3.2）
BigDecimal amount = new BigDecimal(alipayAmount).divide(BigDecimal.valueOf(100));

// ❌ 无效注释（代码已经说明了）
// 获取用户 ID
Long userId = user.getId();

// ❌ 过时注释（比没有更糟糕）
// TODO: 这里以后要优化（2019年留下，至今未动）
```

**Javadoc 规范**（仅公共 API 接口需要）：

```java
/**
 * 创建订单并扣减库存。
 *
 * <p>幂等设计：相同 {@code idempotentKey} 重复调用返回已有订单，不重复扣减。
 *
 * @param request 订单创建请求，不能为 null
 * @param idempotentKey 幂等键，格式为 {userId}_{timestamp}，调用方保证唯一
 * @return 创建的订单 ID
 * @throws InsufficientStockException 库存不足时抛出
 */
public String createOrder(CreateOrderRequest request, String idempotentKey) { ... }
```

---

## 三、异常处理规范

```java
// ❌ 捕获 Exception 后吞掉
try {
    process();
} catch (Exception e) { }

// ❌ 只打印，不重新抛出（调用方无法感知）
try {
    process();
} catch (Exception e) {
    e.printStackTrace();
}

// ✅ 记录日志 + 封装为业务异常
try {
    process();
} catch (IOException e) {
    log.error("文件处理失败，path={}", path, e);
    throw new ServiceException("文件处理失败，请稍后重试", e);
}

// ✅ 业务异常体系
// 基础异常
public class AppException extends RuntimeException {
    private final int code;
    public AppException(int code, String message) {
        super(message);
        this.code = code;
    }
}

// 业务异常（HTTP 400）
public class BizException extends AppException {
    public BizException(String message) { super(400, message); }
}

// 系统异常（HTTP 500）
public class SysException extends AppException {
    public SysException(String message, Throwable cause) {
        super(500, message);
        initCause(cause);
    }
}

// 全局异常处理
@RestControllerAdvice
public class GlobalExceptionHandler {

    @ExceptionHandler(BizException.class)
    public Result<Void> handleBiz(BizException e) {
        log.warn("业务异常：{}", e.getMessage());
        return Result.fail(e.getCode(), e.getMessage());
    }

    @ExceptionHandler(Exception.class)
    public Result<Void> handleUnknown(Exception e) {
        log.error("未知异常", e);
        return Result.fail(500, "系统繁忙，请稍后重试");
    }
}
```

---

## 四、日志规范

```java
// ❌ 不允许的写法
System.out.println("order created: " + orderId);   // 禁止 sout
e.printStackTrace();                                 // 禁止直接打印堆栈

// ✅ 正确的 Logger 声明（使用 Lombok 简化）
@Slf4j
@Service
public class OrderService {

    public void createOrder(CreateOrderRequest req) {
        // ✅ 使用占位符，不要字符串拼接（避免不必要的字符串构造）
        log.info("创建订单，userId={}, itemCount={}", req.getUserId(), req.getItems().size());

        try {
            // ...
            log.info("订单创建成功，orderId={}", orderId);
        } catch (InsufficientStockException e) {
            // ✅ 业务异常用 warn，不需要堆栈
            log.warn("库存不足，productId={}, required={}", productId, quantity);
            throw e;
        } catch (Exception e) {
            // ✅ 系统异常用 error，必须附上 Throwable
            log.error("订单创建失败，userId={}", req.getUserId(), e);
            throw new SysException("订单创建失败", e);
        }
    }
}
```

**日志级别使用原则**：

| 级别 | 使用场景 |
|------|---------|
| `ERROR` | 系统异常、需要立即介入的问题，必须附 Throwable |
| `WARN` | 业务异常、可预期但不正常的情况，如库存不足、重复请求 |
| `INFO` | 关键业务节点，如接口入参、订单状态变更、定时任务执行 |
| `DEBUG` | 调试信息，生产环境关闭 |

**禁止日志内容**：密码、完整手机号/身份证、银行卡号、Token。

---

## 五、SQL 规范

```sql
-- ❌ SELECT *（返回无用字段，影响索引覆盖）
SELECT * FROM orders WHERE user_id = 1001;

-- ✅ 只查需要的字段
SELECT id, order_no, status, amount FROM orders WHERE user_id = 1001;

-- ❌ 在 WHERE 条件中对列做函数操作（索引失效）
SELECT * FROM orders WHERE DATE(created_at) = '2024-01-01';

-- ✅ 对值做处理，保留列的原始形式
SELECT * FROM orders WHERE created_at >= '2024-01-01' AND created_at < '2024-01-02';

-- ❌ 隐式类型转换（索引失效）
SELECT * FROM user WHERE phone = 13800138000;   -- phone 是 varchar

-- ✅ 类型匹配
SELECT * FROM user WHERE phone = '13800138000';

-- ❌ NOT IN（当子查询包含 NULL 时结果为空）
SELECT * FROM orders WHERE user_id NOT IN (SELECT id FROM banned_users);

-- ✅ NOT EXISTS 或 LEFT JOIN ... WHERE IS NULL
SELECT o.* FROM orders o
LEFT JOIN banned_users b ON o.user_id = b.id
WHERE b.id IS NULL;
```

**批量操作规范**：

```java
// ❌ 循环单条插入（N 次网络往返）
for (Order order : orders) {
    orderMapper.insert(order);
}

// ✅ 批量插入（1 次网络往返）
orderMapper.batchInsert(orders);   // MyBatis foreach

// 大批量操作（>1000条）需分批，避免锁等待和内存溢出
Lists.partition(orders, 500).forEach(batch -> orderMapper.batchInsert(batch));
```

---

## 六、接口设计规范

```java
// ✅ RESTful 风格
GET    /api/orders/{id}          // 查询单个
GET    /api/orders?status=PENDING // 查询列表
POST   /api/orders               // 创建
PUT    /api/orders/{id}          // 全量更新
PATCH  /api/orders/{id}/status   // 部分更新
DELETE /api/orders/{id}          // 删除

// ✅ 统一响应结构
@Data
public class Result<T> {
    private int    code;     // 200=成功，400=业务错误，500=系统错误
    private String message;
    private T      data;

    public static <T> Result<T> ok(T data) {
        return new Result<>(200, "success", data);
    }
    public static <T> Result<T> fail(int code, String msg) {
        return new Result<>(code, msg, null);
    }
}

// ✅ 接口参数校验（使用 Validation）
@PostMapping("/orders")
public Result<String> createOrder(
    @RequestBody @Valid CreateOrderRequest req) { ... }

@Data
public class CreateOrderRequest {
    @NotBlank(message = "用户ID不能为空")
    private String userId;

    @NotEmpty(message = "商品列表不能为空")
    @Size(max = 50, message = "单次最多下50件")
    private List<@Valid OrderItem> items;
}
```

---

## 七、禁止事项速查

| 禁止 | 原因 | 替代方案 |
|------|------|---------|
| `new Thread()` 直接创建线程 | 无法管控，资源泄漏 | 使用 `ThreadPoolExecutor` |
| 魔法数字（`if (status == 3)`） | 可读性差，维护困难 | 使用枚举或常量 |
| `Date`、`Calendar` | 线程不安全、API 混乱 | `LocalDateTime`、`Instant` |
| `StringBuffer` 无并发场景 | 性能差 | `StringBuilder` |
| `==` 比较字符串 | 比较引用，非值 | `.equals()` 或 `Objects.equals()` |
| `catch (Exception e)` 后为空 | 吞掉异常，难以排查 | 必须记录日志或重新抛出 |
| `SELECT *` | 返回多余字段，影响性能 | 明确列出需要的字段 |
| 接口不加超时 | 级联阻塞，拖垮整个服务 | Feign/HTTP 客户端必须配置超时 |
