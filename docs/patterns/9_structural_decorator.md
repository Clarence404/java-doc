# 装饰器模式

**作用**：在不修改原类的情况下，通过**包装（Wrap）**动态为对象添加新功能，实现比继承更灵活的功能扩展。

**应用场景**：
- Java I/O 流：`BufferedReader(new InputStreamReader(new FileInputStream(...)))`
- Spring `HttpServletRequestWrapper`（扩展 Request 读取 Body）
- Spring Cache：`@Cacheable` 内部用装饰器在方法前后加缓存逻辑
- 日志、事务、权限等 AOP 横切关注点（装饰器的变体）

---

## 一、Java I/O 中的装饰器

```
InputStream（抽象组件）
  └── FileInputStream（具体组件）
  └── FilterInputStream（抽象装饰器）
        └── BufferedInputStream（具体装饰器，加缓冲）
        └── DataInputStream（具体装饰器，加类型读写）

// 多层嵌套
InputStream in = new DataInputStream(
                     new BufferedInputStream(
                         new FileInputStream("data.bin")));
```

---

## 二、手写装饰器

以「日志增强」为例：

```java
// 组件接口
public interface OrderService {
    Order createOrder(CreateOrderRequest req);
}

// 具体组件
@Service
public class OrderServiceImpl implements OrderService {
    @Override
    public Order createOrder(CreateOrderRequest req) {
        // 核心业务逻辑
        return new Order(req);
    }
}

// 装饰器：不修改原类，动态加日志
public class LoggingOrderService implements OrderService {
    private final OrderService delegate;

    public LoggingOrderService(OrderService delegate) {
        this.delegate = delegate;
    }

    @Override
    public Order createOrder(CreateOrderRequest req) {
        log.info("Creating order for user={}", req.getUserId());
        long start = System.currentTimeMillis();
        try {
            Order order = delegate.createOrder(req);
            log.info("Order created id={}, cost={}ms", order.getId(),
                     System.currentTimeMillis() - start);
            return order;
        } catch (Exception e) {
            log.error("Order creation failed", e);
            throw e;
        }
    }
}

// 多层叠加
OrderService service = new LoggingOrderService(
                           new MetricsOrderService(
                               new OrderServiceImpl()));
```

---

## 三、装饰器 vs 继承 vs AOP

| 维度 | 继承 | 装饰器 | AOP |
|------|------|--------|-----|
| 扩展方式 | 编译期静态 | 运行时动态 | 运行时动态 |
| 可叠加 | 受限（单继承）| ✅ 多层嵌套 | ✅ 多切面 |
| 适用 | 固定扩展 | 运行时灵活组合 | 横切所有类 |
| Spring 中 | 少用于功能扩展 | HttpServletRequestWrapper | `@Aspect` |
