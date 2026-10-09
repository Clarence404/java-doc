---
description: REST 执行模型、@Blocking 与虚拟线程、REST Client、Panache、事务、校验、OpenAPI
---

# REST 与数据访问

> **本篇目标**：搞清楚 Quarkus REST 端点到底跑在哪个线程上、什么时候该用 `@Blocking` / `@RunOnVirtualThread`，能写出带校验、异常映射、OpenAPI 文档的接口，会用 REST Client 调下游，并用 Hibernate ORM with Panache 完成常规的数据访问与事务控制。
>
> **前置阅读**：[Quarkus 概览](./1_basics)、[虚拟线程](/java/30_topic_virtual_thread)

> 参考资料：
> * Quarkus REST：[https://quarkus.io/guides/rest](https://quarkus.io/guides/rest)
> * REST Client：[https://quarkus.io/guides/rest-client](https://quarkus.io/guides/rest-client)
> * Hibernate ORM with Panache：[https://quarkus.io/guides/hibernate-orm-panache](https://quarkus.io/guides/hibernate-orm-panache)
> * Hibernate Reactive with Panache：[https://quarkus.io/guides/hibernate-reactive-panache](https://quarkus.io/guides/hibernate-reactive-panache)
> * 事务：[https://quarkus.io/guides/transaction](https://quarkus.io/guides/transaction)
> * 虚拟线程：[https://quarkus.io/guides/virtual-threads](https://quarkus.io/guides/virtual-threads)
> * Quarkus Data（原 Panache Next）：[https://quarkus.io/blog/introducing-quarkus-data/](https://quarkus.io/blog/introducing-quarkus-data/)

---

## 一、Quarkus REST 与执行模型

### 1、Quarkus REST 是什么

Quarkus REST（原名 RESTEasy Reactive）是 Quarkus 默认的 Jakarta REST 实现，扩展名 `quarkus-rest`，JSON 支持用 `quarkus-rest-jackson`。名字里虽然曾带 Reactive，但它**同时支持阻塞与非阻塞端点**，写传统的同步代码完全没问题。旧的 RESTEasy Classic（`quarkus-resteasy`）仍可用，新项目不建议再选。

### 2、端点跑在哪个线程上

![Quarkus REST 端点的执行线程选择](../assets/quarkus/quarkus-rest-threads.svg)

请求先由 Vert.x 事件循环（I/O 线程）接收，Quarkus REST **在构建期根据方法签名决定**后续在哪个线程执行：

| 方法签名 / 注解 | 默认执行线程 |
|----------------|--------------|
| 返回 `Uni`、`Multi`、`CompletionStage`、`Publisher`、Kotlin `suspend` | I/O 线程 |
| 直接返回结果（POJO、`String`、`Response`、`RestResponse<T>`） | Worker 线程 |
| 标注 `@Blocking` | Worker 线程（即使返回 `Uni`） |
| 标注 `@NonBlocking` | I/O 线程（即使是同步签名） |
| 标注 `@Transactional` | 视为阻塞，Worker 线程 |
| 标注 `@RunOnVirtualThread` | 虚拟线程（仅对阻塞签名生效） |

注解可加在方法、类或 `jakarta.ws.rs.core.Application` 子类上，后者设置全局默认值。

这套规则有一个推论：**返回 `Uni` 的方法里绝对不能做阻塞调用**。在 I/O 线程上调用 JDBC、`Thread.sleep`、同步 HTTP 客户端，会卡住事件循环，同一个事件循环上的所有连接都会被拖慢；Hibernate ORM 在 I/O 线程上被调用时会直接抛异常拒绝执行。

### 3、三种写法对比

```java
import io.smallrye.common.annotation.RunOnVirtualThread;
import io.smallrye.mutiny.Uni;
import jakarta.inject.Inject;
import jakarta.ws.rs.GET;
import jakarta.ws.rs.Path;
import jakarta.ws.rs.PathParam;

@Path("/orders")
public class OrderResource {

    @Inject
    OrderService orderService;           // 阻塞实现（JDBC / Hibernate ORM）

    @Inject
    ReactiveOrderService reactiveService; // 响应式实现（Hibernate Reactive）

    // 1. 同步签名：默认在 Worker 线程
    @GET
    @Path("/{id}")
    public OrderDto get(@PathParam("id") long id) {
        return orderService.find(id);
    }

    // 2. 虚拟线程：同步写法，阻塞时只挂起虚拟线程
    @GET
    @Path("/vt/{id}")
    @RunOnVirtualThread
    public OrderDto getOnVirtualThread(@PathParam("id") long id) {
        return orderService.find(id);
    }

    // 3. 响应式：在 I/O 线程上，必须全链路非阻塞
    @GET
    @Path("/reactive/{id}")
    public Uni<OrderDto> getReactive(@PathParam("id") long id) {
        return reactiveService.find(id);
    }
}
```

### 4、怎么选

| 场景 | 推荐 |
|------|------|
| 普通 CRUD、团队熟悉同步编程 | 同步签名（Worker 线程），最省心 |
| 大量下游阻塞调用、Worker 池经常打满 | `@RunOnVirtualThread`，JDK 21+，最好 JDK 24+ |
| 全链路已有响应式驱动（Hibernate Reactive、响应式 Redis / Kafka）、追求极致资源利用 | 返回 `Uni` / `Multi` |
| 纯内存计算、几微秒就返回 | `@NonBlocking`，省一次线程切换 |

使用虚拟线程时注意：

- **钉住**：JDK 21–23 上 `synchronized` 内的阻塞会钉住载体线程，JDK 24（JEP 491）起解决；老版本 PostgreSQL JDBC 驱动（42.6.0 之前）在 JDK 21–23 上钉住严重
- **ThreadLocal 池化**：Jackson、Netty 等在 `ThreadLocal` 里缓存对象的库，在海量虚拟线程下内存会膨胀
- **限流**：虚拟线程不限制并发数，打到数据库的并发要靠连接池上限或信号量兜住

虚拟线程的原理与使用原则见 [虚拟线程](/java/30_topic_virtual_thread)。

---

## 二、接口编写：参数、校验、异常与 OpenAPI

### 1、请求校验

引入 `quarkus-hibernate-validator` 后，在参数上加 `@Valid` 即可，校验失败自动返回 400，响应体包含违例字段：

```java
import jakarta.validation.Valid;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotEmpty;
import java.util.List;

public record CreateOrderRequest(
        @NotBlank String customerId,
        @NotEmpty List<@Valid Item> items) {

    public record Item(@NotBlank String sku, @Min(1) int quantity) {}
}
```

```java
// OrderResource 中新增（import jakarta.ws.rs.POST; import org.jboss.resteasy.reactive.RestResponse;）
@POST
public RestResponse<OrderDto> create(@Valid CreateOrderRequest req) {
    OrderDto created = orderService.create(req);
    return RestResponse.status(RestResponse.Status.CREATED, created);
}
```

`RestResponse<T>` 是 Quarkus REST 提供的泛型响应类型，比 `jakarta.ws.rs.core.Response` 多了类型信息，OpenAPI 文档也能据此推导响应模型。

### 2、统一异常映射

Quarkus REST 提供 `@ServerExceptionMapper`，写法比实现 `ExceptionMapper` 接口更简洁：

```java
import org.jboss.resteasy.reactive.RestResponse;
import org.jboss.resteasy.reactive.server.ServerExceptionMapper;

public class GlobalExceptionMappers {

    public record ErrorBody(String code, String message) {}

    @ServerExceptionMapper
    public RestResponse<ErrorBody> notFound(OrderNotFoundException e) {
        return RestResponse.status(RestResponse.Status.NOT_FOUND,
                new ErrorBody("ORDER_NOT_FOUND", e.getMessage()));
    }

    @ServerExceptionMapper
    public RestResponse<ErrorBody> conflict(OptimisticLockConflictException e) {
        return RestResponse.status(RestResponse.Status.CONFLICT,
                new ErrorBody("CONCURRENT_UPDATE", "请刷新后重试"));
    }
}
```

### 3、OpenAPI

引入 `quarkus-smallrye-openapi` 后，构建期根据 Jakarta REST 注解生成文档：

- `/q/openapi`：OpenAPI 文档
- `/q/swagger-ui`：Swagger UI，**默认只在 dev / test 模式启用**，生产需显式设置 `quarkus.swagger-ui.always-include=true`（同时要考虑鉴权）
- 细化描述用 MicroProfile OpenAPI 注解：`@Operation`、`@APIResponse`、`@Tag`

接口文档的通用规范见 [接口文档](/spring-boot/10_api_doc)。

---

## 三、REST Client：调用下游服务

### 1、声明式客户端

`quarkus-rest-client-jackson` 提供基于 MicroProfile REST Client 的声明式客户端，地位相当于 Spring 的 `@HttpExchange` / OpenFeign：

```java
import io.smallrye.mutiny.Uni;
import jakarta.ws.rs.GET;
import jakarta.ws.rs.Path;
import jakarta.ws.rs.PathParam;
import org.eclipse.microprofile.rest.client.inject.RegisterRestClient;

@Path("/inventory")
@RegisterRestClient(configKey = "inventory")
public interface InventoryClient {

    @GET
    @Path("/{sku}")
    StockDto stock(@PathParam("sku") String sku);          // 阻塞调用

    @GET
    @Path("/{sku}")
    Uni<StockDto> stockAsync(@PathParam("sku") String sku); // 非阻塞调用
}
```

```java
import org.eclipse.microprofile.rest.client.inject.RestClient;

@ApplicationScoped
public class OrderService {

    @RestClient
    InventoryClient inventoryClient;
}
```

```properties
quarkus.rest-client.inventory.url=http://inventory-service:8080
quarkus.rest-client.inventory.connect-timeout=1000
quarkus.rest-client.inventory.read-timeout=3000
```

### 2、生产要点

- **一定要配超时**：连接与读取超时都要显式设置，默认值不适合跨服务调用
- **签名决定是否阻塞**：同步返回值的方法会阻塞调用线程，在 I/O 线程上调用会出问题；响应式端点里用返回 `Uni` 的方法
- **重试、熔断**：加 `quarkus-smallrye-fault-tolerance`，在客户端方法或调用方加 `@Retry`、`@Timeout`、`@CircuitBreaker`、`@Fallback`；重试只用于幂等请求
- **错误映射**：默认非 2xx 抛 `WebApplicationException`，可用 `@ClientExceptionMapper` 映射为业务异常
- **服务发现**：URL 可写 `stork://inventory-service`，由 SmallRye Stork 做服务发现与负载均衡；在 Kubernetes 内一般直接用 Service 域名

---

## 四、Hibernate ORM with Panache

Panache 是 Quarkus 在 Hibernate ORM 之上的简化层，目标是让常见 CRUD 少写样板代码。它提供两种风格。

### 1、Active Record 模式

实体继承 `PanacheEntity`（自带 `Long id`），查询方法直接是实体类的静态方法：

```java
import io.quarkus.hibernate.orm.panache.PanacheEntity;
import io.quarkus.panache.common.Page;
import io.quarkus.panache.common.Sort;
import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.EnumType;
import jakarta.persistence.Enumerated;
import jakarta.persistence.Table;
import jakarta.persistence.Version;
import java.time.Instant;
import java.util.List;

@Entity
@Table(name = "orders")
public class Order extends PanacheEntity {

    @Column(nullable = false)
    public String customerId;

    @Enumerated(EnumType.STRING)
    public OrderStatus status;

    public long amountCents;

    public Instant createdAt;

    @Version
    public int version;

    public static List<Order> pendingOf(String customerId, int page) {
        return find("customerId = ?1 and status = ?2", Sort.descending("id"),
                    customerId, OrderStatus.PENDING)
               .page(Page.of(page, 20))
               .list();
    }
}
```

字段写成 `public` 不是坏习惯的放任：Panache **在构建期把字段访问改写为 getter / setter 调用**，Hibernate 的懒加载与脏检查照常工作；需要自定义逻辑时直接写 getter 即可。

### 2、Repository 模式

偏好分层或不想让实体带静态方法时，实体用普通 `@Entity`（或继承 `PanacheEntityBase` 自定义主键），查询放到 Repository：

```java
import io.quarkus.hibernate.orm.panache.PanacheRepository;
import jakarta.enterprise.context.ApplicationScoped;
import java.util.Optional;

@ApplicationScoped
public class OrderRepository implements PanacheRepository<Order> {

    public Optional<Order> findByIdAndCustomer(long id, String customerId) {
        return find("id = ?1 and customerId = ?2", id, customerId).firstResultOptional();
    }

    public long cancelExpired(java.time.Instant before) {
        return update("status = ?1 where status = ?2 and createdAt < ?3",
                      OrderStatus.CANCELLED, OrderStatus.PENDING, before);
    }
}
```

### 3、怎么选与注意事项

| 维度 | Active Record | Repository |
|------|---------------|------------|
| 代码量 | 最少 | 多一个类 |
| 测试 | 静态方法需 `quarkus-panache-mock` 才能 Mock | 普通 Bean，`@InjectMock` 即可 |
| 分层 / DDD | 实体带持久化能力，领域模型不够纯 | 更符合分层 |
| 团队来自 Spring Data | 风格陌生 | 更接近 |

通用注意事项：

- **简化 HQL**：`find("status", s)` 中只写属性名时会被补全为 `from Order where status = ?1`；复杂查询直接写完整 HQL 或用命名查询
- **N+1**：Panache 没有改变 Hibernate 的抓取语义，关联集合仍需 `join fetch` 或实体图；`list()` 大结果集用 `stream()` 或分页
- **Schema 管理**：生产环境用 `quarkus-flyway` 或 `quarkus-liquibase` 管理表结构，Hibernate 自动建表只在开发期使用；思路见 [数据库版本迁移](/spring-boot/4_flyway)
- **Quarkus Data（原 Panache Next）**：Quarkus 3.31 以 Panache Next 之名引入新一代 Panache，3.37 起更名为 Quarkus Data（扩展 `quarkus-data-hibernate`），基于 Jakarta Data、同一套实体可用于阻塞与响应式；目前仍是实验性扩展，生产暂不建议采用

---

## 五、事务

### 1、声明式事务

`@Transactional`（`jakarta.transaction.Transactional`）可加在 CDI Bean 的方法或类上，语义与 Spring 基本一致：

```java
import jakarta.transaction.Transactional;

@ApplicationScoped
public class OrderService {

    @Inject
    OrderRepository orderRepository;

    @Transactional
    public OrderDto pay(long orderId, long amountCents) {
        Order order = orderRepository.findByIdOptional(orderId)
                .orElseThrow(() -> new OrderNotFoundException(orderId));
        if (order.status != OrderStatus.PENDING) {
            throw new IllegalStateException("order not payable: " + order.status);
        }
        order.status = OrderStatus.PAID;   // 托管实体，提交时自动 flush
        return OrderDto.from(order);
    }
}
```

和 Spring 对照的关键点：

- **回滚规则**：默认运行时异常回滚、受检异常不回滚，可用 `rollbackOn` / `dontRollbackOn` 调整
- **传播行为**：`@Transactional(Transactional.TxType.REQUIRES_NEW)` 等，取值与 Spring 的 `Propagation` 对应
- **自调用同样失效**：拦截器基于构建期生成的子类，`this.xxx()` 不经过拦截器，与 Spring 的代理问题本质相同
- **超时**：`@TransactionConfiguration(timeout = 5)`，全局默认 `quarkus.transaction-manager.default-transaction-timeout`

### 2、编程式事务

需要在一个方法里控制多个事务边界时用 `QuarkusTransaction`：

```java
import io.quarkus.narayana.jta.QuarkusTransaction;

public void importBatch(List<OrderDto> batch) {
    int chunkSize = 500;
    for (int from = 0; from < batch.size(); from += chunkSize) {
        List<OrderDto> chunk = batch.subList(from, Math.min(from + chunkSize, batch.size()));
        // 每批一个新事务，单批失败只回滚本批
        QuarkusTransaction.requiringNew().run(() -> chunk.forEach(this::upsert));
    }
}
```

分批提交可以避免一个超大事务长时间持锁、撑爆持久化上下文。

---

## 六、Hibernate Reactive 简述

`quarkus-hibernate-reactive-panache` 提供响应式版本的 Panache，底层用 Vert.x 的响应式数据库驱动（如 `quarkus-reactive-pg-client`），所有操作返回 `Uni`：

```java
import io.quarkus.hibernate.reactive.panache.common.WithSession;
import io.quarkus.hibernate.reactive.panache.common.WithTransaction;
import io.smallrye.mutiny.Uni;

@ApplicationScoped
public class ReactiveOrderService {

    @WithSession   // 在 REST 端点外（如消息消费、定时任务）调用时需要显式打开会话
    public Uni<OrderDto> find(long id) {
        return ReactiveOrder.<ReactiveOrder>findById(id)
                .onItem().ifNull().failWith(() -> new OrderNotFoundException(id))
                .map(OrderDto::from);
    }

    @WithTransaction
    public Uni<Void> cancel(long id) {
        return ReactiveOrder.<ReactiveOrder>findById(id)
                .invoke(o -> o.status = OrderStatus.CANCELLED)
                .replaceWithVoid();
    }
}
```

其中 `ReactiveOrder` 继承 `io.quarkus.hibernate.reactive.panache.PanacheEntity`。使用前要想清楚：

- **会话绑定在 Vert.x 上下文**：不能把实体或会话传到别的线程上用，也不能在一个会话里并发执行多个操作
- **会话与事务用 `@WithSession` / `@WithTransaction` 或 `Panache.withSession()` / `Panache.withTransaction()`**；从 Quarkus REST 端点调用时会话可按需自动打开，其他入口需要显式声明；官方提醒不要在同一应用中混用 `@Transactional` 与这些 Panache 注解
- **同一实体不要同时用两套**：阻塞与响应式 Panache 的实体基类不同，混用会让代码和测试都变复杂
- **收益看场景**：只有在并发连接极高、且全链路都是非阻塞驱动时，才能明显优于「Worker 线程 + JDBC」或「虚拟线程 + JDBC」；有了虚拟线程之后，多数业务系统没必要为数据访问切换响应式

---

## 小结

- Quarkus REST 同时支持阻塞与非阻塞：同步签名跑 Worker 线程，返回 `Uni` / `Multi` 跑 I/O 线程，`@Blocking`、`@NonBlocking`、`@Transactional`、`@RunOnVirtualThread` 可改变默认值
- I/O 线程上不能有阻塞调用；大量阻塞调用优先考虑虚拟线程，注意钉住、ThreadLocal 内存与并发上限
- 校验用 `@Valid` 自动 400，异常用 `@ServerExceptionMapper` 统一映射，OpenAPI 的 Swagger UI 默认只在 dev / test 启用
- REST Client 用 `configKey` 配置地址与超时，重试熔断交给 SmallRye Fault Tolerance，只对幂等请求重试
- Panache 有 Active Record 与 Repository 两种风格，前者代码少、后者便于测试与分层；N+1 与 Schema 管理的问题与原生 Hibernate 相同
- `@Transactional` 语义与 Spring 相近，自调用同样失效；分批提交用 `QuarkusTransaction`
- Hibernate Reactive 只在全链路非阻塞、并发连接极高时才值得引入

> 下一篇：[原生镜像与云原生部署](./3_native) —— 把应用编译成原生可执行文件、打成容器镜像并部署到 Kubernetes，看看构建期增强在部署侧的收益与代价。
