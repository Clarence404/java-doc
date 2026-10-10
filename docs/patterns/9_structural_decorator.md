---
description: 包装叠加功能、Java I/O 流、Spring 中装配装饰器、装饰器 vs 代理 vs AOP
---

# 装饰器模式

> 前置阅读：[组合模式](./8_structural_composite)、[IO 与 NIO](/java/18_topic_io)

装饰器模式（Decorator）用一个**实现同一接口、内部持有原对象**的包装类给对象叠加功能，可以层层嵌套、运行时组合，比为每种组合写子类灵活得多。本篇讲四个角色、手写与 Spring 装配、JDK / Servlet / Spring 中的装饰器，以及与代理、AOP 的界限。

---

## 一、定义与角色

Java I/O 是最经典的装饰器实现：

![装饰器模式的角色（Java I/O）](../assets/patterns/decorator.svg)

| 角色 | Java I/O 中的类 | 职责 |
|------|----------------|------|
| Component（抽象组件） | `InputStream` | 统一接口 |
| ConcreteComponent（具体组件） | `FileInputStream`、`ByteArrayInputStream` | 数据来源，真正读字节 |
| Decorator（抽象装饰器） | `FilterInputStream` | 实现 `InputStream`，内部持有一个 `InputStream in`，默认把调用转给它 |
| ConcreteDecorator（具体装饰器） | `BufferedInputStream`、`DataInputStream` | 在转发前后加功能：缓冲、按类型读取 |

关键点有两个：装饰器和被装饰对象**类型相同**，所以可以无限嵌套；装饰器**持有**被装饰对象，而不是继承它。

---

## 二、实现

### 1、Java I/O 的多层嵌套

```java
try (DataInputStream in = new DataInputStream(          // 第 3 层：按类型读
        new BufferedInputStream(                       // 第 2 层：加缓冲
            new FileInputStream("data.bin")))) {       // 第 1 层：数据来源
    int version = in.readInt();
    long timestamp = in.readLong();
}
```

关闭最外层时会逐层调用 `close()`，最里层的文件句柄也会被关闭，所以只需要关最外层。字节流、字符流的完整体系见 [IO 与 NIO](/java/18_topic_io)。

### 2、手写装饰器：给订单服务加日志与计数

```java
public record CreateOrderRequest(long userId, long productId, int qty) {}
public record Order(long id, long userId) {}

// 组件接口
public interface OrderService {
    Order createOrder(CreateOrderRequest req);
}

// 具体组件：核心业务
@Service
public class OrderServiceImpl implements OrderService {
    @Override
    public Order createOrder(CreateOrderRequest req) {
        // … 校验、落库
        return new Order(System.nanoTime(), req.userId());
    }
}

// 具体装饰器 1：日志与耗时
public class LoggingOrderService implements OrderService {
    private static final Logger log = LoggerFactory.getLogger(LoggingOrderService.class);
    private final OrderService delegate;

    public LoggingOrderService(OrderService delegate) {
        this.delegate = delegate;
    }

    @Override
    public Order createOrder(CreateOrderRequest req) {
        long start = System.nanoTime();
        try {
            Order order = delegate.createOrder(req);
            log.info("下单成功 orderId={} 耗时={}ms", order.id(), (System.nanoTime() - start) / 1_000_000);
            return order;
        } catch (RuntimeException e) {
            log.error("下单失败 userId={}", req.userId(), e);
            throw e;
        }
    }
}

// 具体装饰器 2：成功计数
public class MetricsOrderService implements OrderService {
    private final OrderService delegate;
    private final LongAdder created = new LongAdder();

    public MetricsOrderService(OrderService delegate) {
        this.delegate = delegate;
    }

    @Override
    public Order createOrder(CreateOrderRequest req) {
        Order order = delegate.createOrder(req);
        created.increment();
        return order;
    }

    public long createdCount() {
        return created.sum();
    }
}
```

调用方决定叠加顺序：

```java
OrderService service = new LoggingOrderService(        // 外层：日志
        new MetricsOrderService(                       // 中层：计数
            new OrderServiceImpl()));                  // 内层：业务
```

这里只有一个方法，装饰器直接实现接口即可；接口方法多时，可以先写一个「全部方法都转发给 `delegate`」的抽象基类（相当于 `FilterInputStream`），具体装饰器只覆盖关心的方法。

### 3、在 Spring 中装配装饰器

`OrderServiceImpl` 已经是一个 Bean，再用 `@Primary` 声明一个包装好的 `OrderService`，按类型注入时就会拿到装饰后的版本：

```java
@Configuration
public class OrderServiceConfig {

    @Bean
    @Primary
    public OrderService orderService(OrderServiceImpl impl) {
        return new LoggingOrderService(new MetricsOrderService(impl));
    }
}
```

需要对一批 Bean 统一包装时，也可以在 `BeanPostProcessor#postProcessAfterInitialization` 里返回包装对象，但那已经接近 Spring AOP 自己的做法，通常直接写切面更合适。

---

## 三、JDK、Servlet 与 Spring 中的应用

| 类 | 所属 | 被装饰的对象 | 叠加的能力 |
|----|------|-------------|-----------|
| `BufferedInputStream`、`DataInputStream`、`BufferedReader` | JDK `java.io` | 另一个流 | 缓冲、按类型读、按行读 |
| `Collections.unmodifiableList` / `synchronizedList` / `checkedList` | JDK `java.util` | 原集合 | 只读、加锁、运行时类型检查 |
| `HttpServletRequestWrapper` / `HttpServletResponseWrapper` | Servlet API（`jakarta.servlet.http`） | 原请求 / 响应 | 供开发者继承后改写参数、请求头等 |
| `ContentCachingRequestWrapper` | Spring Web | 原请求（继承自 `HttpServletRequestWrapper`） | 缓存已读取的请求体，供日志等后续读取 |
| `ServerHttpRequestDecorator` / `ServerHttpResponseDecorator` | Spring WebFlux | 原 `ServerHttpRequest` / `ServerHttpResponse` | 改写请求或响应，常用在网关过滤器里 |
| `TransactionAwareCacheDecorator` | Spring Cache | 原 `Cache` | 让 `put` / `evict` 等到事务提交后才执行 |

`HttpServletRequestWrapper` 是 Servlet 规范提供的，不是 Spring 的类。另外，`@Cacheable` 不是装饰器：它由 Spring AOP 生成代理，在 `CacheInterceptor` 里查缓存、写缓存，属于代理模式，见 [代理模式](./12_structural_proxy)。

---

## 四、适用场景与常见坑

适合用装饰器的场景：

- 需要给对象叠加若干**可自由组合**的功能，用继承会出现类爆炸（缓冲 × 加密 × 压缩 ……）
- 不能或不想修改原类，例如原类来自第三方库
- 需要在运行时按配置决定加哪些功能

常见坑：

- **顺序有影响**：日志包在计数外面，能记录计数层的耗时；反过来就记不到。加密和压缩也一样，先压缩再加密才有压缩效果
- **身份判断失效**：包装后 `service instanceof OrderServiceImpl` 为 `false`，`equals` 默认比较的也是包装对象；需要原对象时应提供 `unwrap` 方法，而不是到处强转
- **接口新增方法被漏转发**：接口后来加了 `default` 方法，装饰器没有覆盖它，调用会直接走默认实现而绕过被装饰对象，新方法要在抽象装饰器里补上转发
- **层数太多难排查**：异常栈里一串包装类，调试时很难看出哪一层改了数据，每层只做一件事并起清楚的名字

---

## 五、与相近模式的区别

### 1、装饰器 vs 代理

两者结构几乎一样：都实现同一接口、都持有目标对象。区别在意图和由谁组装：

| 维度 | 装饰器 | 代理 |
|------|--------|------|
| 意图 | **增强**功能，叠加新行为 | **控制访问**：延迟加载、权限、远程调用、缓存 |
| 谁来组装 | 调用方显式一层层包装 | 通常由框架或工厂创建，调用方不知道拿到的是代理 |
| 叠加 | 常常多层嵌套，顺序由调用方决定 | 一般只有一层（Spring 把多个切面合成一个代理里的拦截器链） |
| 对目标的生命周期 | 目标从外部传入 | 代理可以自己创建或延迟创建目标 |
| 典型例子 | `BufferedInputStream`、`Collections.unmodifiableList` | Spring AOP 代理、MyBatis Mapper、OpenFeign 客户端 |

### 2、装饰器 vs 继承 vs AOP

| 维度 | 继承 | 装饰器 | AOP |
|------|------|--------|-----|
| 扩展时机 | 编译期确定 | 运行时组装对象 | Spring AOP 运行时生成代理；AspectJ 可在编译期或类加载期织入 |
| 叠加组合 | 受单继承限制，组合多了类爆炸 | 支持多层嵌套 | 支持多个切面，用 `@Order` 排序 |
| 作用范围 | 单个类 | 单个对象 | 按切点批量作用于很多类 |
| 适用 | 稳定、固定的扩展 | 少量对象、灵活组合 | 日志、事务、权限等横切关注点 |

AOP 的细节见 [AOP](/spring/2_aop)。

---

## 小结

- 装饰器实现与被装饰对象相同的接口并持有它，在转发前后叠加功能，可以多层嵌套
- Java I/O 是标准实现：`InputStream` 是组件，`FilterInputStream` 是抽象装饰器，`BufferedInputStream` 等是具体装饰器
- Spring 中可用 `@Primary` 的 `@Bean` 包装已有实现；`ContentCachingRequestWrapper`、`ServerHttpRequestDecorator`、`TransactionAwareCacheDecorator` 是 Spring 里的装饰器，`HttpServletRequestWrapper` 属于 Servlet API
- `@Cacheable`、`@Transactional` 是代理加拦截器，不是装饰器
- 装饰器重在增强、由调用方组装；代理重在控制访问、通常由框架创建

## 参考资料

- Refactoring Guru：Decorator：[https://refactoring.guru/design-patterns/decorator](https://refactoring.guru/design-patterns/decorator)
- Erich Gamma 等：《设计模式：可复用面向对象软件的基础》，Decorator 一章
- Java SE 21 API：FilterInputStream：[https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/io/FilterInputStream.html](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/io/FilterInputStream.html)
- Spring Framework Javadoc：TransactionAwareCacheDecorator：[https://docs.spring.io/spring-framework/docs/current/javadoc-api/org/springframework/cache/transaction/TransactionAwareCacheDecorator.html](https://docs.spring.io/spring-framework/docs/current/javadoc-api/org/springframework/cache/transaction/TransactionAwareCacheDecorator.html)
- Spring Framework Javadoc：ContentCachingRequestWrapper：[https://docs.spring.io/spring-framework/docs/current/javadoc-api/org/springframework/web/util/ContentCachingRequestWrapper.html](https://docs.spring.io/spring-framework/docs/current/javadoc-api/org/springframework/web/util/ContentCachingRequestWrapper.html)

> 下一篇：[外观模式](./10_structural_facade) —— 为复杂子系统提供简单入口、SLF4J、外观与适配器和中介者的区别。
