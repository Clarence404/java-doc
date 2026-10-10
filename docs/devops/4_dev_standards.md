---
description: 命名、类与 Lombok / record、注释、异常、日志、并发与金额、数据访问、禁止事项
---

# 开发规范

> 前置阅读：[Code Review](./3_code_review)

开发规范是一份 Java 团队可直接采用的编码规约，取材于阿里巴巴 Java 开发手册和 Google Java Style Guide。本篇讲命名与注释、Lombok 与 record、异常体系、日志并发等硬性规定，基线为 JDK 21。

---

## 一、规约怎么落地

规约来源为《阿里巴巴 Java 开发手册（黄山版）》，结合 JDK 21（JDK 25 的差异会注明）与 Spring Boot 4 做了取舍；硬性规定覆盖日志 / 并发 / 金额 / 数据访问，每条都配正例与反例。

规约分两类，处理方式不同：

本篇是全站**代码坏味道正反例**的出处，[Code Review](./3_code_review) 的检查清单逐条对应这里。与其他模块的分工：

| 主题 | 本篇只写 | 完整内容 |
|------|----------|----------|
| 格式化与静态检查 | 规约本身 | [代码质量](/engineering/3_code_quality)：Spotless / Checkstyle / SonarQube 在 CI 中强制 |
| 日志 | 编码层面的硬性规定 | [日志](/spring-boot/12_logging)：门面、配置、结构化日志、MDC |
| REST 与统一响应 | 不展开 | [API 设计规范](/engineering/7_api_design_rule)：URL、状态码、响应体、分页、版本 |
| 异常机制 | 业务异常体系 | [Java 异常](/java/10_topic_exception) |

- **机器能判断的交给工具**：缩进、import 顺序、行宽、大括号位置、未使用变量，由格式化工具和静态检查在 CI 中强制，不靠人记、也不在 Review 里讨论，配置见 [代码质量](/engineering/3_code_quality)
- **需要理解语义的交给人**：命名是否达意、异常是否该捕获、事务边界是否正确，由作者自检和 [Code Review](./3_code_review) 把关

条目按强度分「强制」和「推荐」：强制项违反即阻塞合并，推荐项由 Reviewer 酌情提出。新项目从第一天开启格式化检查；老项目先一次性格式化全量代码并单独提交（把该提交加进 `.git-blame-ignore-revs`，避免污染 `git blame`），再开启检查。

---

## 二、命名

### 1、基础规则（强制）

| 类型 | 规则 | 示例 |
|------|------|------|
| 包名 | 全小写，域名倒写，单数 | `com.example.order.service` |
| 类、接口、枚举、record | UpperCamelCase | `OrderService`、`OrderStatus`、`OrderView` |
| 方法 | lowerCamelCase，动词开头 | `findById`、`cancelOrder` |
| 变量、参数 | lowerCamelCase，表达含义 | `pendingOrders`、`maxRetryTimes` |
| 常量 | UPPER_SNAKE_CASE | `MAX_RETRY_TIMES` |
| 枚举值 | UPPER_SNAKE_CASE | `OrderStatus.WAIT_PAY` |
| 测试类 | 被测类名 + `Test` | `OrderServiceTest` |
| 缩写 | 按单词处理，只首字母大写 | `HttpClient`、`userId`，而不是 `HTTPClient`、`userID` |

### 2、语义

```java
// 反例：名字不携带任何信息
int a, tmp;
List<Object> list1;
boolean flag;

// 正例：名字说明用途；布尔值用 is / has / can / should 开头
int retryTimes;
List<Order> pendingOrders;
boolean hasPermission;
```

```java
// 反例：POJO 的布尔字段带 is 前缀，部分序列化框架会把属性名解析成 deleted 而不是 isDeleted
private Boolean isDeleted;

// 正例：字段名不带 is，getter 由 Lombok / IDE 按规范生成
private boolean deleted;
```

分层后缀表达职责，团队内统一一套即可：

| 后缀 | 职责 |
|------|------|
| `Controller` | HTTP 入口，只做参数接收、校验与结果转换 |
| `Service` / `ServiceImpl` | 业务编排、事务边界 |
| `Repository` / `Mapper` | 数据访问（DDD 风格用 Repository，MyBatis 用 Mapper） |
| `Client` | 调用外部服务 |
| `Request` / `Command`、`View` / `Response` | 入参与出参对象 |
| `Entity` 或无后缀 | 持久化对象 |

避免 `Manager`、`Helper`、`Util` 这类说不清职责的名字装下越来越多的逻辑；工具类确有必要时，类名写清领域，如 `MoneyFormats`。

---

## 三、类与对象：Lombok 与 record

### 1、一个常见的编译错误

```java
// 反例：编译失败
@Data
public class OrderView {
    private Long id;
    private String orderNo;
    private BigDecimal amount;

    public static OrderView of(Order order) {
        return new OrderView(order.getId(), order.getOrderNo(), order.getAmount()); // 找不到该构造器
    }
}
```

`@Data` 等价于 `@Getter @Setter @ToString @EqualsAndHashCode @RequiredArgsConstructor`，其中 `@RequiredArgsConstructor` 只为 `final` 字段和 `@NonNull` 字段生成参数。上面的类没有 `final` 字段，所以只得到一个无参构造器，全参调用无法编译。

### 2、按用途选择

| 场景 | 推荐写法 | 理由 |
|------|----------|------|
| DTO、出参、值对象、事件 | **record**（JDK 16+） | 不可变、自带构造器 / 访问器 / equals / hashCode / toString，Jackson 与 Bean Validation 均直接支持 |
| 需要无参构造 + setter 的可变对象（部分框架绑定、老代码） | `@Data @NoArgsConstructor @AllArgsConstructor` | 三个注解缺一不可，见下文 |
| 字段多、可选参数多 | `@Builder`（可加在 record 上） | 避免长参数列表 |
| JPA 实体 | `@Getter @Setter @NoArgsConstructor(access = AccessLevel.PROTECTED)` | 不用 `@Data`：基于全部字段的 equals / hashCode 与懒加载、集合关联冲突，toString 可能触发懒加载或循环引用 |

```java
// 正例一：record，不可变，构造器由编译器生成
public record OrderView(Long id, String orderNo, OrderStatus status, BigDecimal amount) {

    public static OrderView of(Order order) {
        return new OrderView(order.getId(), order.getOrderNo(), order.getStatus(), order.getAmount());
    }
}
```

```java
// 正例二：可变对象同时需要无参与全参构造
@Data
@NoArgsConstructor
@AllArgsConstructor
public class OrderQuery {
    private Long userId;
    private OrderStatus status;
    private LocalDate createdFrom;
}
```

```java
// 正例三：@Builder 与 @NoArgsConstructor 同时使用时，必须补上 @AllArgsConstructor
@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class OrderCreatedEvent {
    private String orderNo;
    private Long userId;
    private BigDecimal amount;
    @Builder.Default
    private Instant occurredAt = Instant.now();
}
```

正例三中的规则来自 Lombok 本身：类上的 `@Builder` 需要一个全参构造器，只有在类里**没有任何其他构造器**时它才会自动生成；`@NoArgsConstructor` 也算构造器，所以必须显式加 `@AllArgsConstructor`，否则编译失败。

### 3、其他对象相关规约

- **覆写 `equals` 必须同时覆写 `hashCode`**（强制）；用作 `HashMap` 键或放入 `HashSet` 的对象，参与计算的字段不能在存放期间被修改
- **比较包装类型用 `equals` 或 `Objects.equals`**（强制）：`Integer` 只缓存 -128 到 127，超出范围 `==` 比较的是引用
- **`Optional` 只用作返回值**：不用作字段、方法参数或集合元素
- **不可变集合**：`List.of(...)`、`Stream.toList()` 返回不可修改的列表，调用 `add` 会抛 `UnsupportedOperationException`；需要修改时用 `new ArrayList<>(...)` 包一层
- **对枚举做 `switch` 表达式时不写 `default`**：编译器会检查是否覆盖了所有枚举值，新增枚举值后漏改的地方直接编译失败

```java
// 正例：穷尽检查，新增 OrderStatus 值后这里会编译报错提醒
String label = switch (status) {
    case WAIT_PAY -> "待支付";
    case PAID -> "已支付";
    case CANCELLED -> "已取消";
};
```

---

## 四、注释

注释解释**为什么**，代码本身说明做了什么：

```java
// 正例：说明了不显而易见的原因
// 服务多实例部署，进程内锁无效，因此用 Redis SET NX EX 做分布式锁
Boolean locked = redisTemplate.opsForValue().setIfAbsent(lockKey, requestId, Duration.ofSeconds(30));

// 正例：外部约定写清出处
// 支付回调金额单位为分（见支付渠道接口文档「通知参数」一节），入库前转换为元
BigDecimal amountYuan = BigDecimal.valueOf(totalFen).movePointLeft(2);
```

```java
// 反例：复述代码
// 获取用户 ID
Long userId = user.getId();

// 反例：没有负责人和期限的 TODO，最终变成永久注释
// TODO 以后优化
```

规约：

- 公共 API（对外提供的接口、SDK、框架扩展点）写 Javadoc，说明参数约束、返回值、抛出的异常和幂等性
- TODO 必须带负责人或问题单号，如 `// TODO(#1234): 改为批量接口`，由静态检查统计
- 被注释掉的代码直接删除，历史交给 Git
- 修改代码时同步修改注释，过时注释比没有注释更糟

```java
/**
 * 创建订单并锁定库存。
 *
 * <p>幂等：相同 {@code requestId} 重复调用返回首次创建的订单，不会重复锁库存。
 *
 * @param request   创建请求，不能为 null
 * @param requestId 调用方生成的幂等键，24 小时内唯一
 * @return 订单号
 * @throws BizException 库存不足或商品已下架时抛出，错误码见 {@link ErrorCode}
 */
public String createOrder(CreateOrderRequest request, String requestId) {
    // ...
}
```

---

## 五、异常

### 1、捕获的规约

```java
// 反例一：吞掉异常，问题无从排查
try {
    process();
} catch (Exception e) {
}

// 反例二：printStackTrace 输出到标准错误，不进日志系统
try {
    process();
} catch (Exception e) {
    e.printStackTrace();
}

// 反例三：记录后又抛出，同一个异常在每一层都打一遍堆栈
try {
    process();
} catch (IOException e) {
    log.error("文件处理失败", e);
    throw new BizException(ErrorCode.FILE_PROCESS_FAILED, "文件处理失败", e);
}

// 正例：只捕获能处理的具体异常；不处理就包装后抛出、保留 cause，由全局处理器统一记录
try {
    process();
} catch (IOException e) {
    throw new BizException(ErrorCode.FILE_PROCESS_FAILED, "文件处理失败，path=" + path, e);
}
```

要点：

- **一个异常只记录一次**：要么在当前层处理并记录，要么包装后抛出，不要两样都做
- **捕获具体类型**：不在业务代码里 `catch (Exception e)`，最外层的兜底交给全局处理器
- **包装时保留原始异常**（`cause`），否则丢失根因堆栈
- **不用异常控制正常流程**：查询不到数据返回空集合或 `Optional`，而不是抛异常再捕获
- **`InterruptedException` 要么向上抛，要么恢复中断标志**（`Thread.currentThread().interrupt()`），机制细节见 [Java 异常](/java/10_topic_exception)

### 2、业务异常体系

用一个错误码枚举承载「HTTP 状态 + 业务错误码 + 默认提示」，业务异常只引用错误码：

```java
public enum ErrorCode {

    PARAM_INVALID(HttpStatus.BAD_REQUEST, "A0400", "请求参数错误"),
    ORDER_NOT_FOUND(HttpStatus.NOT_FOUND, "A0404", "订单不存在"),
    STOCK_INSUFFICIENT(HttpStatus.CONFLICT, "A0409", "库存不足"),
    FILE_PROCESS_FAILED(HttpStatus.INTERNAL_SERVER_ERROR, "B0002", "文件处理失败"),
    SYSTEM_ERROR(HttpStatus.INTERNAL_SERVER_ERROR, "B0001", "系统繁忙，请稍后重试");

    private final HttpStatus status;
    private final String code;
    private final String defaultMessage;

    ErrorCode(HttpStatus status, String code, String defaultMessage) {
        this.status = status;
        this.code = code;
        this.defaultMessage = defaultMessage;
    }

    public HttpStatus status() { return status; }
    public String code() { return code; }
    public String defaultMessage() { return defaultMessage; }
}
```

```java
@Getter
public class BizException extends RuntimeException {

    private final ErrorCode errorCode;

    public BizException(ErrorCode errorCode) {
        this(errorCode, errorCode.defaultMessage());
    }

    public BizException(ErrorCode errorCode, String message) {
        super(message);
        this.errorCode = errorCode;
    }

    public BizException(ErrorCode errorCode, String message, Throwable cause) {
        super(message, cause);
        this.errorCode = errorCode;
    }
}
```

错误码借鉴黄山版手册的风格：首字母表示来源（A 用户端、B 系统内部、C 第三方服务），便于一眼判断该找谁。

### 3、全局处理：HTTP 状态码要真实

```java
@Slf4j
@RestControllerAdvice
public class GlobalExceptionHandler extends ResponseEntityExceptionHandler {

    @ExceptionHandler(BizException.class)
    public ResponseEntity<ProblemDetail> handleBiz(BizException e) {
        ErrorCode ec = e.getErrorCode();
        if (ec.status().is5xxServerError()) {
            log.error("业务处理失败，code={}", ec.code(), e);
        } else {
            log.warn("业务异常，code={}, message={}", ec.code(), e.getMessage());
        }
        return build(ec, ec.status().is5xxServerError() ? ec.defaultMessage() : e.getMessage());
    }

    @ExceptionHandler(Exception.class)
    public ResponseEntity<ProblemDetail> handleUnknown(Exception e) {
        log.error("未处理的异常", e);
        return build(ErrorCode.SYSTEM_ERROR, ErrorCode.SYSTEM_ERROR.defaultMessage());
    }

    private ResponseEntity<ProblemDetail> build(ErrorCode ec, String detail) {
        ProblemDetail body = ProblemDetail.forStatusAndDetail(ec.status(), detail);
        body.setProperty("code", ec.code());
        return ResponseEntity.status(ec.status()).body(body);
    }
}
```

几处设计说明：

- **HTTP 状态码反映真实结果**：参数错误返回 400、资源不存在返回 404、服务端故障返回 500，而不是所有响应都返回 200 再在响应体里放错误码；网关、监控、重试策略都依赖真实状态码
- **继承 `ResponseEntityExceptionHandler`**：Spring MVC 自身的异常（参数校验失败、请求体无法解析、方法不支持、静态资源不存在等）由父类转换成对应 4xx 的 `ProblemDetail`，不会被 `Exception` 兜底成 500
- **5xx 不把内部信息返回给客户端**：只返回通用提示，细节进日志
- **响应体格式以 API 规范为准**：示例使用 Spring 内置的 `ProblemDetail`（RFC 9457）；团队若采用自定义的统一响应包装，字段约定见 [API 设计规范](/engineering/7_api_design_rule)，这里不重复

---

## 六、日志

日志框架、配置、结构化日志和 MDC 见 [日志](/spring-boot/12_logging)，编码层面的硬性规定如下：

```java
// 反例
System.out.println("order created: " + orderId);              // 不进日志系统，无级别、无 traceId
log.info("order created: " + orderId);                        // 字符串拼接，级别关闭时也会构造字符串
log.error("下单失败：" + e.getMessage());                       // 丢失堆栈
log.info("登录，phone={}, password={}", phone, password);       // 记录敏感信息

// 正例
log.info("订单创建成功，orderId={}, userId={}", orderId, userId);  // 占位符
log.error("下单失败，userId={}", userId, e);                     // 最后一个参数传异常，输出完整堆栈
log.info("登录，phone={}", Masks.phone(phone));                  // 脱敏（Masks 为项目内的脱敏工具类）
```

| 级别 | 使用场景 |
|------|----------|
| `ERROR` | 需要人工介入的系统故障，必须带异常对象，通常触发告警 |
| `WARN` | 可预期的异常情况：业务校验失败、重试、降级、慢调用 |
| `INFO` | 关键业务节点：状态变更、定时任务开始与结束、对外调用的结果摘要 |
| `DEBUG` | 排查细节，生产默认关闭，需要时通过 Actuator 临时调高 |

- **接口入参只记录关键字段**（业务主键、操作类型），不整包打印请求体；请求体中常含手机号、地址、证件号等个人信息
- **禁止记录**：密码、Token、密钥、完整银行卡号与证件号；手机号、姓名脱敏后再记录
- **日志带上业务主键**（订单号、用户 ID），traceId 由 Micrometer Tracing 自动放入 MDC，不要手工拼接
- **循环内不打 INFO 日志**，大对象不直接 `toString()` 输出

---

## 七、并发、时间与金额

### 1、线程与线程池

```java
// 反例：每次请求 new Thread，数量不受控
new Thread(() -> exportService.export(taskId)).start();

// 反例：Executors.newFixedThreadPool 使用无界队列，任务堆积会耗尽内存
ExecutorService pool = Executors.newFixedThreadPool(8);
```

```java
// 正例：平台线程池用于 CPU 密集或需要限流的任务——有界队列、有名字、拒绝策略明确
ThreadPoolExecutor exportPool = new ThreadPoolExecutor(
        4, 8,
        60, TimeUnit.SECONDS,
        new ArrayBlockingQueue<>(200),
        Thread.ofPlatform().name("export-", 0).factory(),
        new ThreadPoolExecutor.CallerRunsPolicy());
```

```java
// 正例：IO 密集的并发调用用虚拟线程（JDK 21+），每个任务一个虚拟线程，不需要池化
try (ExecutorService executor = Executors.newVirtualThreadPerTaskExecutor()) {
    List<Future<Price>> futures = skuIds.stream()
            .map(skuId -> executor.submit(() -> priceClient.query(skuId)))
            .toList();
    for (Future<Price> future : futures) {
        prices.add(future.get());
    }
}
```

- 虚拟线程不要放进池子复用，对下游的并发量用 `Semaphore` 控制；JDK 21–23 中 `synchronized` 块内阻塞会钉住载体线程，JDK 24 起由 JEP 491 解决，详见 [虚拟线程](/java/30_topic_virtual_thread)
- Spring Boot 中开启 `spring.threads.virtual.enabled=true` 后，Tomcat 请求处理和 `@Async` 等默认使用虚拟线程
- 线程池参数与监控见 [线程池](/java/28_topic_thread_pool)
- `ThreadLocal` 用完必须在 `finally` 中 `remove()`，线程复用时否则会串数据并泄漏内存；JDK 25 起可优先考虑正式发布的 `ScopedValue`

### 2、时间

```java
// 反例：SimpleDateFormat 非线程安全，作为共享静态字段会在并发下解析出错
private static final SimpleDateFormat SDF = new SimpleDateFormat("yyyy-MM-dd");

// 正例：java.time 的格式化器不可变、线程安全
private static final DateTimeFormatter DATE = DateTimeFormatter.ofPattern("yyyy-MM-dd");
```

- 新代码不使用 `Date`、`Calendar`：时间点用 `Instant`，带时区用 `ZonedDateTime` / `OffsetDateTime`，业务日期用 `LocalDate`
- 年份模式写 `yyyy`，不要写 `YYYY`（基于周的年份，年末几天会算成下一年）
- 服务器、数据库、JVM 统一时区，或统一存 UTC，展示时再转换；详见 [日期时间](/java/17_topic_time)

### 3、金额

```java
// 反例
new BigDecimal(0.1);                      // 得到 0.1000000000000000055511151231257827...
a.equals(b);                              // 2.0 与 2.00 精度不同，equals 返回 false
total.divide(count);                      // 除不尽时抛 ArithmeticException

// 正例
new BigDecimal("0.1");                    // 或 BigDecimal.valueOf(0.1)
boolean same = a.compareTo(b) == 0;       // 只比较数值
total.divide(count, 2, RoundingMode.HALF_UP);
```

- 金额一律用 `BigDecimal`，或以「分」为单位用 `long` 存储，不用 `float` / `double`
- 单位换算用 `movePointLeft` / `movePointRight`，不依赖除法

---

## 八、数据访问

SQL 优化与索引原理见 [MySQL 索引](/database/1_mysql/4_topic_index) 与 [执行过程](/database/1_mysql/6_topic_execution)，编码时的硬性规定：

| 规约 | 原因 |
|------|------|
| 不写 `SELECT *`，列出需要的字段 | 多取无用字段，无法利用覆盖索引，表结构变更时易出错 |
| 不在索引列上做函数或运算，如 `DATE(created_at) = ?` | 索引失效，改为范围条件 `created_at >= ? AND created_at < ?` |
| 参数类型与列类型一致 | `varchar` 列与数字比较触发隐式转换，索引失效 |
| 子查询可能含 `NULL` 时不用 `NOT IN` | 结果恒为空，改用 `NOT EXISTS` 或 `LEFT JOIN ... IS NULL` |
| MyBatis 中用 `#{}`，不用 `${}` 拼接用户输入 | SQL 注入；动态排序字段用白名单映射 |
| 分页查询必须有排序字段，深分页改用游标（`id > ?`） | 结果不稳定；`LIMIT 100000, 20` 会扫描并丢弃前十万行 |
| 事务内不做远程调用和耗时操作 | 长事务占用连接、持有锁 |

循环内查库是 Review 中最常见的性能问题：

```java
// 反例：N+1，每个 id 一次数据库往返
List<Order> orders = new ArrayList<>();
for (Long orderId : orderIds) {
    orders.add(orderMapper.selectById(orderId));
}
```

```java
import static java.util.function.Function.identity;
import static java.util.stream.Collectors.toMap;

// 正例：一次批量查询（MyBatis-Plus 3.5.8 起用 selectByIds，旧名 selectBatchIds 已废弃）
List<Order> orders = orderMapper.selectByIds(orderIds);
Map<Long, Order> orderById = orders.stream()
        .collect(toMap(Order::getId, identity()));
```

批量写入同样要分批，单批几百条为宜，避免单条 SQL 过大和长时间持锁：

```java
// insertBatch 为 Mapper 中用 <foreach> 实现的多值 INSERT
int batchSize = 500;
for (int from = 0; from < orders.size(); from += batchSize) {
    int to = Math.min(from + batchSize, orders.size());
    orderMapper.insertBatch(orders.subList(from, to));
}
```

使用 JDBC `addBatch` 方式批量写 MySQL 时，连接串加上 `rewriteBatchedStatements=true`，驱动才会把多条语句合并发送。

---

## 九、接口层

URL 设计、HTTP 方法与状态码、统一响应结构、分页与版本管理统一见 [API 设计规范](/engineering/7_api_design_rule)。编码层面只强调两点：

- **入参必须校验**，用 Bean Validation 注解声明，不在 Service 里手写一堆 `if`
- **入参与出参用独立的 record**，不直接暴露持久化实体，避免多余字段泄露和意外的批量赋值

```java
public record CreateOrderRequest(
        @NotNull Long userId,
        @NotEmpty @Size(max = 50) List<@Valid OrderItemRequest> items,
        @Size(max = 200) String remark) {
}

public record OrderItemRequest(@NotNull Long skuId, @Min(1) int quantity) {
}

@PostMapping("/orders")
public ResponseEntity<OrderView> create(@RequestBody @Valid CreateOrderRequest request) {
    OrderView view = orderService.create(request);
    return ResponseEntity.status(HttpStatus.CREATED).body(view);
}
```

校验失败抛出的 `MethodArgumentNotValidException` 由第五节的全局处理器（父类 `ResponseEntityExceptionHandler`）转换为 400 响应。

---

## 十、禁止事项速查

| 禁止 | 原因 | 替代 |
|------|------|------|
| 直接 `new Thread()` | 数量不受控、无法统一管理 | IO 密集用虚拟线程，其余用有界 `ThreadPoolExecutor` |
| `Executors.newFixedThreadPool` / `newCachedThreadPool` | 无界队列或无界线程数，可能耗尽内存 | 手动构造 `ThreadPoolExecutor` |
| 魔法值（`if (status == 3)`） | 含义不明，改动易遗漏 | 枚举或常量 |
| `Date`、`Calendar`、共享的 `SimpleDateFormat` | 可变、非线程安全 | `java.time` |
| `float` / `double` 表示金额、`new BigDecimal(double)` | 精度丢失 | `BigDecimal(String)`、`BigDecimal.valueOf` 或以分存 `long` |
| `==` 比较字符串或包装类型 | 比较的是引用 | `equals` / `Objects.equals` |
| 空的 `catch` 块、`e.printStackTrace()` | 吞掉异常 | 处理并记录，或包装后抛出 |
| `System.out.println` 打日志、字符串拼接日志 | 不进日志系统、浪费性能 | SLF4J 占位符 |
| 日志或响应中出现密码、Token、完整证件号 | 数据泄露 | 不记录或脱敏 |
| `SELECT *`、MyBatis `${}` 拼接用户输入 | 性能问题、SQL 注入 | 明确列名、`#{}` 参数绑定 |
| 外部调用不设超时 | 下游变慢时线程耗尽，故障级联 | HTTP 客户端、RPC、数据库连接全部配置超时 |
| 在 `@Data` 类上直接调用全参构造器 | 编译失败 | record，或补 `@NoArgsConstructor @AllArgsConstructor` |

---

## 小结

- 格式交给工具在 CI 中强制，语义规约交给作者自检和 Code Review；强制项违反即阻塞合并
- DTO、事件、值对象优先用 record；Lombok 的 `@Data` 不生成全参构造器，与 `@Builder` 混用时要成套写 `@NoArgsConstructor @AllArgsConstructor`；JPA 实体不用 `@Data`
- 异常只记录一次，业务异常引用错误码枚举，全局处理器返回真实的 HTTP 状态码，响应体格式以 API 设计规范为准
- 日志用占位符、带异常对象、不记录敏感信息；IO 密集并发用虚拟线程，平台线程池必须有界
- 金额用 `BigDecimal` 并显式指定舍入，时间用 `java.time`；数据访问避免 N+1 与 `${}` 拼接

## 参考资料

- 阿里巴巴 Java 开发手册（黄山版）与 P3C 插件：[alibaba/p3c](https://github.com/alibaba/p3c)
- Google Java 风格指南：[Google Java Style Guide](https://google.github.io/styleguide/javaguide.html)
- Lombok `@Data`：[@Data](https://projectlombok.org/features/Data)
- Lombok `@Builder`：[@Builder](https://projectlombok.org/features/Builder)
- JEP 395 Records：[JEP 395: Records](https://openjdk.org/jeps/395)
- JEP 444 虚拟线程：[JEP 444: Virtual Threads](https://openjdk.org/jeps/444)
- JEP 491 synchronized 不再钉住虚拟线程：[JEP 491](https://openjdk.org/jeps/491)
- Spring Framework 错误响应与 ProblemDetail：[Error Responses](https://docs.spring.io/spring-framework/reference/web/webmvc/mvc-ann-rest-exceptions.html)
- RFC 9457 Problem Details for HTTP APIs：[RFC 9457](https://www.rfc-editor.org/rfc/rfc9457)
- MyBatis-Plus BaseMapper 源码（`selectByIds`）：[BaseMapper.java](https://github.com/baomidou/mybatis-plus/blob/3.0/mybatis-plus-core/src/main/java/com/baomidou/mybatisplus/core/mapper/BaseMapper.java)
- SLF4J 用户手册：[SLF4J Manual](https://www.slf4j.org/manual.html)

> 下一篇：[发布策略](./5_release_strategy)
