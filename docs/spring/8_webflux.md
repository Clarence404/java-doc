---
description: Mono/Flux、执行模型与冷热流、线程调度、背压、Context 传播、WebClient、R2DBC、调试测试
---

# WebFlux

> **本篇目标**：理解 Spring WebFlux 与 Project Reactor 的执行模型、线程模型和背压，能写出不阻塞事件循环、上下文不丢失、可调试可测试的响应式代码，并判断什么时候不该用 WebFlux。
>
> **前置阅读**：[MVC](./3_mvc)、[Reactor 模型](/netty/2_reactor)

> 参考资料：
> * 官方文档：[https://docs.spring.io/spring-framework/reference/web/webflux.html](https://docs.spring.io/spring-framework/reference/web/webflux.html)
> * Project Reactor：[https://projectreactor.io/docs/core/release/reference/](https://projectreactor.io/docs/core/release/reference/)
> * Reactor 调度器：[https://projectreactor.io/docs/core/release/reference/coreFeatures/schedulers.html](https://projectreactor.io/docs/core/release/reference/coreFeatures/schedulers.html)
> * Reactor 上下文传播：[https://projectreactor.io/docs/core/release/reference/advanced-contextPropagation.html](https://projectreactor.io/docs/core/release/reference/advanced-contextPropagation.html)
> * BlockHound：[https://github.com/reactor/BlockHound](https://github.com/reactor/BlockHound)
> * R2DBC 规范：[https://r2dbc.io/spec/1.0.0.RELEASE/spec/html/](https://r2dbc.io/spec/1.0.0.RELEASE/spec/html/)

版本基线：Spring Boot 4.x / Spring Framework 7.x（Boot 4.0 依赖 Reactor 2025.0，即 reactor-core 3.8.x），Java 21 / 25。与版本相关的特性在文中单独标注。

---

## 一、响应式编程基础

**响应式编程**：基于异步数据流的编程范式，通过非阻塞的方式处理数据，适合高并发、I/O 密集型场景。

WebFlux 构建在 **Reactive Streams** 规范之上（JDK 9 起以 `java.util.concurrent.Flow` 收录），规范只有四个接口：`Publisher`（发布者）、`Subscriber`（订阅者）、`Subscription`（二者之间的契约，提供 `request(n)` / `cancel()`）、`Processor`（两者兼具）。Project Reactor 是 Spring 选用的实现，提供两个核心类型：

| 类型 | 说明 | 类比 |
|------|------|------|
| `Mono<T>` | 0 或 1 个元素的异步序列 | 单个结果，类似 `CompletableFuture<T>` |
| `Flux<T>` | 0 到 N 个元素的异步序列 | 集合结果，类似异步 `Stream<T>` |

`Mono` 与 [CompletableFuture](/java/29_topic_completable_future) 的关键区别：

| 对比 | `CompletableFuture` | `Mono` / `Flux` |
|------|--------------------|-----------------|
| 触发时机 | 创建即执行（eager） | 订阅才执行（lazy），可重复订阅 |
| 元素个数 | 1 个 | `Mono` 0..1，`Flux` 0..N |
| 背压 | 无 | 有，下游通过 `request(n)` 控制速率 |
| 取消 | `cancel` 不会中断已在跑的任务 | `cancel` 沿链路向上传播，上游释放资源 |
| 线程 | 回调在完成线程或指定 Executor 上执行 | 由 `Scheduler` 与 `publishOn` / `subscribeOn` 控制 |

---

## 二、Spring MVC vs Spring WebFlux

| 对比 | Spring MVC | Spring WebFlux |
|------|-----------|----------------|
| 线程模型 | 每请求一线程（阻塞），靠大线程池吸收阻塞 | 少量事件循环线程（约等于 CPU 核数）处理大量请求，假设代码不阻塞 |
| 编程模型 | 命令式 | 声明式 / 函数式 |
| 底层容器 | Tomcat / Jetty（Servlet 阻塞 IO） | 默认 Reactor Netty，也可运行在 Tomcat / Jetty（Servlet 非阻塞 IO 适配） |
| 数据访问 | JDBC / JPA | R2DBC、响应式 Redis / MongoDB 等非阻塞驱动 |
| 学习与调试成本 | 低 | 高（堆栈不连续、线程切换、上下文传递） |
| 适用场景 | 常规业务系统 | 高并发 I/O 密集、网关、流式推送 |

- Boot 4.0 起移除了 Undertow 支持（Servlet 6.1 基线不兼容），WebFlux 可选服务器为 Netty / Tomcat / Jetty
- Boot 4.0 起 `WebClient.Builder` 的自动配置拆到 `spring-boot-starter-webclient`；只想在 MVC 应用里用 `WebClient` 调下游时引这个 starter 即可，不必引入 `spring-boot-starter-webflux`（后者会带上响应式服务端）
- **非阻塞的前提是整条链路都不阻塞**：WebFlux 里调用 JDBC 等阻塞 API 会卡住事件循环，吞吐反而低于 MVC
- 只是想用少量代码获得高并发的阻塞式业务，优先考虑 MVC + 虚拟线程（Boot 3.2+，`spring.threads.virtual.enabled=true`），见 [异步任务与定时任务](/spring-boot/9_async_schedule)

---

## 三、Mono / Flux 常用操作

```java
// 创建
Mono<String> mono = Mono.just("hello");                 // 值在组装时就已算好（eager）
Mono<String> lazy = Mono.fromSupplier(() -> compute()); // 订阅时才计算
Mono<String> deferred = Mono.defer(() -> callRemote()); // 订阅时才创建 Publisher
Mono<Void>   empty = Mono.empty();
Mono<String> error = Mono.error(new RuntimeException("fail"));

Flux<Integer> flux = Flux.just(1, 2, 3, 4, 5);
Flux<Integer> range = Flux.range(1, 100);
Flux<Long>    interval = Flux.interval(Duration.ofSeconds(1));  // 每秒发射一个元素（运行在 parallel 调度器）

// 转换
Flux.range(1, 10)
    .filter(i -> i % 2 == 0)
    .map(i -> i * 10)
    .take(3)
    .subscribe(System.out::println);   // 20 40 60

// 异步转换（flatMap：每个元素映射为一个 Publisher，并发展开，结果顺序不保证）
Flux.just("user1", "user2", "user3")
    .flatMap(name -> userRepository.findByName(name), 8)  // 第二个参数限制并发数
    .collectList()
    .subscribe(users -> log.info("查到 {} 个用户", users.size()));

// 聚合
Flux.range(1, 5)
    .reduce(0, Integer::sum)            // → Mono<15>
    .subscribe(System.out::println);

Flux.just("a", "b", "c")
    .collectList()                       // → Mono<List<String>>
    .subscribe(System.out::println);
```

三种「展开」操作符的区别：

| 操作符 | 内部 Publisher 订阅方式 | 输出顺序 | 场景 |
|--------|------------------------|----------|------|
| `flatMap` | 并发订阅（默认并发 256） | 谁先到谁先发 | 批量并发调用，顺序无关 |
| `flatMapSequential` | 并发订阅 | 按源顺序重排后输出 | 要并发也要保序 |
| `concatMap` | 前一个完成才订阅下一个 | 严格按源顺序 | 有依赖或需要串行写入 |

`Mono.just(x)` 中的 `x` 在组装阶段就求值了，即使最终没人订阅也会执行；包了远程调用或耗时计算时用 `fromSupplier` / `fromCallable` / `defer`。

---

## 四、两种编程模型

### 1、注解模型（推荐，与 Spring MVC 写法接近）

```java
@RestController
@RequestMapping("/api/users")
@RequiredArgsConstructor
public class UserController {

    private final UserService userService;

    @GetMapping
    public Flux<UserVO> list() {
        return userService.findAll();
    }

    @GetMapping("/{id}")
    public Mono<UserVO> getById(@PathVariable Long id) {
        return userService.findById(id);
    }

    @PostMapping
    @ResponseStatus(HttpStatus.CREATED)
    public Mono<UserVO> create(@RequestBody @Valid Mono<UserCreateDTO> dto) {
        return dto.flatMap(userService::create);
    }

    // SSE 服务端推送
    @GetMapping(value = "/events", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    public Flux<ServerSentEvent<String>> events() {
        return Flux.interval(Duration.ofSeconds(1))
            .map(seq -> ServerSentEvent.<String>builder()
                .id(String.valueOf(seq))
                .event("user-update")
                .data("第 " + seq + " 次推送")
                .build());
    }
}
```

控制器只负责**返回** `Mono` / `Flux`，由框架订阅；不要在控制器里自己 `subscribe()` 或 `block()`。SSE 的协议格式、心跳与反向代理配置见 [SSE](/netty/11_sse)。

### 2、函数式路由模型

```java
// Handler
@Component
@RequiredArgsConstructor
public class UserHandler {

    private final UserService userService;

    public Mono<ServerResponse> getById(ServerRequest request) {
        Long id = Long.parseLong(request.pathVariable("id"));
        return userService.findById(id)
            .flatMap(user -> ServerResponse.ok().bodyValue(user))
            .switchIfEmpty(ServerResponse.notFound().build());
    }

    public Mono<ServerResponse> create(ServerRequest request) {
        return request.bodyToMono(UserCreateDTO.class)
            .flatMap(userService::create)
            .flatMap(user -> ServerResponse.created(
                URI.create("/api/users/" + user.getId())).bodyValue(user));
    }
}

// Router
@Configuration
public class UserRouter {

    @Bean
    public RouterFunction<ServerResponse> userRoutes(UserHandler handler) {
        return RouterFunctions.route()
            .GET("/api/users/{id}", handler::getById)
            .POST("/api/users",     handler::create)
            .build();
    }
}
```

---

## 五、错误处理

### 1、错误操作符

```java
@Service
@RequiredArgsConstructor
public class UserService {

    private final UserRepository userRepository;

    public Mono<UserVO> findById(Long id) {
        return userRepository.findById(id)
            // 空结果 → 抛异常
            .switchIfEmpty(Mono.error(new EntityNotFoundException("用户不存在: " + id)))
            .map(this::toVO);
    }

    // 特定异常 → 返回默认值
    public Mono<UserVO> findOrAnonymous(Long id) {
        return findById(id)
            .onErrorReturn(EntityNotFoundException.class, UserVO.anonymous());
    }

    // 异常 → 切换到另一个 Publisher（降级）
    public Mono<UserVO> findWithFallback(Long id) {
        return findById(id)
            .onErrorResume(e -> {
                log.warn("查询失败: {}", e.getMessage());
                return Mono.just(UserVO.anonymous());
            });
    }

    // 异常转换（包装为业务异常）
    public Mono<UserVO> findWrapped(Long id) {
        return findById(id)
            .onErrorMap(DataAccessException.class, e -> new ServiceException("数据库异常", e));
    }
}
```

错误信号一旦被 `onErrorResume` / `onErrorReturn` 吞掉，下游的 `onErrorMap` 就再也看不到它，同一条链上多个错误操作符要注意先后顺序。

### 2、重试：Retry.backoff

```java
import java.util.concurrent.TimeoutException;
import org.springframework.web.reactive.function.client.WebClientRequestException;
import org.springframework.web.reactive.function.client.WebClientResponseException;
import reactor.util.retry.Retry;

public Mono<String> callRemote(String url) {
    return webClient.get().uri(url).retrieve().bodyToMono(String.class)
        .timeout(Duration.ofSeconds(3))                  // 单次调用超时，写在 retry 之前
        .retryWhen(Retry.backoff(3, Duration.ofMillis(200))
            .maxBackoff(Duration.ofSeconds(2))
            .jitter(0.5)                                  // 默认就是 0.5，避免重试风暴同步
            .filter(this::isRetryable)
            .onRetryExhaustedThrow((spec, signal) -> signal.failure()));  // 抛原始异常而非包装异常
}

private boolean isRetryable(Throwable e) {
    // WebClient 把连接/IO 异常包装成 WebClientRequestException，不是 IOException 本身
    return e instanceof WebClientRequestException
        || e instanceof TimeoutException
        || (e instanceof WebClientResponseException r && r.getStatusCode().is5xxServerError());
}
```

- 重试的本质是**重新订阅上游**：对 `WebClient` 来说就是重新发一次 HTTP 请求，所以只对幂等操作重试，非幂等的 POST 需配合幂等键，见 [幂等设计](/architecture/5_idempotence)
- 默认重试耗尽抛出的是包装后的 `RetryExhaustedException`（可用 `Exceptions.isRetryExhausted` 判断），上面用 `onRetryExhaustedThrow` 还原为原始异常，便于全局异常处理

### 3、全局异常处理

注解模型优先用 `@RestControllerAdvice` + `@ExceptionHandler`，写法与 MVC 一致；函数式路由和 `WebFilter` 中抛出的异常则由 `ErrorWebExceptionHandler` 兜底。

```java
@RestControllerAdvice
public class GlobalExceptionAdvice {

    @ExceptionHandler(EntityNotFoundException.class)
    public ProblemDetail notFound(EntityNotFoundException e) {
        return ProblemDetail.forStatusAndDetail(HttpStatus.NOT_FOUND, e.getMessage());
    }
}
```

```java
// 低层兜底：覆盖函数式路由、过滤器等所有异常
@Component
@Order(-2)   // Boot 自带的 errorWebExceptionHandler 为 @Order(-1)，自定义的要排在它之前
public class GlobalErrorHandler implements ErrorWebExceptionHandler {

    @Override
    public Mono<Void> handle(ServerWebExchange exchange, Throwable ex) {
        ServerHttpResponse response = exchange.getResponse();
        if (response.isCommitted()) {
            return Mono.error(ex);                    // 响应已开始写出，无法再改状态码
        }
        HttpStatus status = ex instanceof EntityNotFoundException
            ? HttpStatus.NOT_FOUND : HttpStatus.INTERNAL_SERVER_ERROR;
        response.setStatusCode(status);
        response.getHeaders().setContentType(MediaType.APPLICATION_JSON);
        // 不要把 ex.getMessage() 原样拼进响应：既可能泄露内部信息，也可能破坏 JSON 结构
        String body = "{\"code\":" + status.value() + ",\"message\":\"" + status.getReasonPhrase() + "\"}";
        DataBuffer buffer = response.bufferFactory().wrap(body.getBytes(StandardCharsets.UTF_8));
        return response.writeWith(Mono.just(buffer));
    }
}
```

---

## 六、WebClient（非阻塞 HTTP 客户端）

WebClient 是 WebFlux 提供的响应式 HTTP 客户端。阻塞式场景（MVC 应用）新代码优先用 `RestClient`，选型见 [Web 开发](/spring-boot/2_web_dev)。

```java
@Configuration
public class WebClientConfig {

    // 注入 Boot 自动配置的 WebClient.Builder，才能继承编解码、观测（指标 / 链路）等配置
    // Boot 4.x 需引入 spring-boot-starter-webclient
    @Bean
    public WebClient userServiceClient(WebClient.Builder builder) {
        return builder
            .baseUrl("http://user-service")   // 服务名寻址需要负载均衡的 Builder（@LoadBalanced）
            .defaultHeader(HttpHeaders.CONTENT_TYPE, MediaType.APPLICATION_JSON_VALUE)
            .filter(ExchangeFilterFunction.ofRequestProcessor(req -> {
                log.debug("→ {} {}", req.method(), req.url());
                return Mono.just(req);
            }))
            .codecs(c -> c.defaultCodecs().maxInMemorySize(2 * 1024 * 1024))
            .build();
    }
}
```

```java
@Service
@RequiredArgsConstructor
public class RemoteUserService {

    private final WebClient userServiceClient;

    // GET 请求
    public Mono<UserVO> getUser(Long userId) {
        return userServiceClient.get()
            .uri("/api/users/{id}", userId)
            .retrieve()
            .onStatus(HttpStatusCode::is4xxClientError,
                res -> res.bodyToMono(String.class)
                         .flatMap(body -> Mono.error(new BusinessException("用户不存在: " + body))))
            .onStatus(HttpStatusCode::is5xxServerError,
                res -> Mono.error(new ServiceException("用户服务异常")))
            .bodyToMono(UserVO.class);
    }

    // POST 请求：非幂等，不加 retry；需要重试时带上幂等键
    public Mono<OrderVO> createOrder(OrderCreateDTO dto, String idempotencyKey) {
        return userServiceClient.post()
            .uri("/api/orders")
            .header("Idempotency-Key", idempotencyKey)
            .bodyValue(dto)
            .retrieve()
            .bodyToMono(OrderVO.class)
            .timeout(Duration.ofSeconds(5))
            .retryWhen(Retry.fixedDelay(2, Duration.ofSeconds(1))
                // 只重试网络异常与超时，4xx 等业务错误重试也没用
                .filter(e -> e instanceof WebClientRequestException || e instanceof TimeoutException));
    }

    // 并发请求（同时查多个服务），总耗时取最慢的一个
    public Mono<DashboardVO> getDashboard(Long userId) {
        Mono<UserVO>          userMono   = getUser(userId);
        Mono<List<OrderVO>>   ordersMono = getOrders(userId);
        Mono<List<ProductVO>> recsMono   = getRecommendations(userId);

        return Mono.zip(userMono, ordersMono, recsMono)
            .map(tuple -> DashboardVO.builder()
                .user(tuple.getT1())
                .orders(tuple.getT2())
                .recommendations(tuple.getT3())
                .build());
    }

    // 流式响应（Flux）
    public Flux<EventVO> streamEvents(Long userId) {
        return userServiceClient.get()
            .uri("/api/events/stream?userId={id}", userId)
            .accept(MediaType.TEXT_EVENT_STREAM)
            .retrieve()
            .bodyToFlux(EventVO.class);
    }
}
```

`Mono.zip` 中任一 `Mono` 为空，结果整体为空；任一出错，整体出错并取消其余请求。允许部分失败时给各个子请求加 `onErrorResume` 降级。

---

## 七、Reactor 执行模型

### 1、订阅之前什么都不会发生

Reactor 的口号是 **Nothing happens until you subscribe**。一条响应式链路的生命周期分三个阶段：

| 阶段 | 发生什么 | 在哪个线程 |
|------|----------|-----------|
| 组装（Assembly） | 调用 `map`、`filter` 等操作符，只是层层包装出一个新的 `Flux` 对象，**不执行任何业务逻辑** | 调用方线程 |
| 订阅（Subscription） | `subscribe()` 从最下游沿链路**向上**传递，每层创建对应的 Subscriber；源头回调 `onSubscribe` 向下，下游再发出 `request(n)` 向上 | 默认调用方线程，`subscribeOn` 可改变 |
| 执行（Execution） | 源头按需求发出 `onNext`，数据**向下**流经各操作符，最终 `onComplete` / `onError` | 源头所在线程，`publishOn` 可改变 |

![Reactive Streams 信号流](../assets/spring/reactor_signal_flow.svg)

在 WebFlux 中，订阅由框架完成：控制器返回 `Mono` 后，框架订阅它并把结果写入响应。常见误区：

- 在 Service 里调用 `repository.save(entity);` 却不把返回的 `Mono` 接入链路 —— 没人订阅，**根本不会写库**
- 用 `doOnNext(x -> repo.save(x))` 做副作用 —— 同样没有订阅；应改为 `flatMap(repo::save)`
- 同一个 `Mono` 订阅两次会执行两次（例如发两次 HTTP 请求），需要复用结果时用 `cache()`

### 2、冷流与热流

| 类型 | 行为 | 例子 |
|------|------|------|
| 冷流（Cold） | 每个订阅者触发一次独立的完整执行，从头拿到全部数据 | `Flux.range`、`WebClient` 请求、R2DBC 查询（绝大多数） |
| 热流（Hot） | 数据产生与订阅无关，晚到的订阅者只能看到订阅之后的数据 | `Sinks`、`share()` 之后的流、外部事件源 |

冷流转热流的常用操作符：

| 操作符 | 语义 |
|--------|------|
| `share()` | 等价于 `publish().refCount()`：第一个订阅者到来时订阅源头，所有订阅者都取消后取消源头；晚到者会错过之前的数据 |
| `replay(n).autoConnect()` | 为晚到的订阅者回放最近 n 个元素 |
| `cache()` / `cache(Duration ttl)` | 缓存全部（或在 TTL 内的）信号，后续订阅直接回放，不再触发上游；适合对结果做短时复用 |
| `publish().autoConnect(n)` | 凑够 n 个订阅者后才连接源头 |

需要从命令式代码（如消息监听回调）往响应式流里「推」数据时，使用 `Sinks`：

```java
import reactor.core.publisher.Flux;
import reactor.core.publisher.Sinks;

@Component
public class OrderEventBus {

    // 多播：无订阅者时先缓冲（默认 256 条），之后按最慢订阅者的需求下发，慢订阅者会拖慢所有人
    // 需要给新订阅者回放最近 n 条时改用 Sinks.many().replay().limit(n)
    private final Sinks.Many<OrderEvent> sink = Sinks.many().multicast().onBackpressureBuffer();

    public void publish(OrderEvent event) {
        Sinks.EmitResult result = sink.tryEmitNext(event);
        if (result.isFailure()) {
            // FAIL_NON_SERIALIZED：多线程并发 emit；FAIL_OVERFLOW：缓冲已满；FAIL_TERMINATED：Sink 已终止
            log.warn("事件发布失败: {} {}", result, event.id());
        }
    }

    public Flux<OrderEvent> events() {
        return sink.asFlux();
    }
}
```

`Sinks.many()` 创建的 Sink 不允许多线程同时 emit，并发调用会得到 `FAIL_NON_SERIALIZED`，调用方要么串行化，要么按结果重试。

---

## 八、线程模型与调度器

### 1、Reactor 与并发无关

Reactor 本身**不规定在哪个线程执行**：没有 `publishOn` / `subscribeOn` 时，整条链路就跑在调用 `subscribe()` 的线程上（或源头发出数据的线程上，如 Netty IO 线程、`Flux.interval` 所在的 parallel 线程）。线程切换只通过 `Scheduler` 显式发生。

| 调度器 | 线程数 | 用途 |
|--------|--------|------|
| `Schedulers.parallel()` | 等于 CPU 核数 | CPU 密集计算，绝不可阻塞 |
| `Schedulers.boundedElastic()` | 上限默认 CPU 核数 × 10，超出后最多排队 100000 个任务，空闲线程 60 秒回收 | 包装阻塞调用（JDBC、文件、老旧 SDK） |
| `Schedulers.single()` | 1 个可复用线程 | 低延迟的一次性串行任务 |
| `Schedulers.immediate()` | 不切线程，在当前线程直接执行 | 作为「不调度」的占位实现 |
| `Schedulers.fromExecutorService(...)` | 取决于传入线程池 | 复用已有线程池 |

WebFlux 运行在 Reactor Netty 上时，请求由少量事件循环线程处理（线程名形如 `reactor-http-nio-N`），这正是 Netty 主从 Reactor 模型的落地，原理见 [Reactor 模型](/netty/2_reactor)。**在事件循环线程上阻塞，等于让这个线程负责的所有连接一起停摆。**

### 2、publishOn 与 subscribeOn

| 操作符 | 影响范围 | 位置是否重要 |
|--------|----------|-------------|
| `publishOn(s)` | 只影响**它之后（下游）**的操作符，`onNext` / `onComplete` / `onError` 在 `s` 上执行 | 重要，可多次使用多次切换 |
| `subscribeOn(s)` | 影响**订阅过程与源头发射**，从源头开始整条链路切到 `s`，直到遇到 `publishOn` | 不重要，写在哪都一样；多个时只有最靠近源头的生效 |

```java
Flux.range(1, 3)                                      // 源头：在 subscribeOn 指定的线程上发射
    .map(i -> log("map1", i))                         // boundedElastic-1
    .publishOn(Schedulers.parallel())                 // 从这里往下切到 parallel
    .map(i -> log("map2", i))                         // parallel-1
    .subscribeOn(Schedulers.boundedElastic())         // 虽然写在后面，影响的是源头
    .subscribe(i -> log("subscribe", i));             // parallel-1
```

![publishOn 与 subscribeOn 线程切换](../assets/spring/reactor_publishon_subscribeon.svg)

### 3、包装阻塞调用

无法避免的阻塞调用（JDBC、阻塞 SDK、文件 IO）用 `fromCallable` + `subscribeOn(boundedElastic)` 包起来，让阻塞发生在弹性线程池而不是事件循环上：

```java
public Mono<Report> loadReport(Long id) {
    return Mono.fromCallable(() -> legacyReportClient.fetch(id))   // 阻塞调用，延迟到订阅时执行
        .subscribeOn(Schedulers.boundedElastic())                 // 在弹性线程上执行
        .timeout(Duration.ofSeconds(3));
}
```

- 注意用 `fromCallable` 而不是 `Mono.just(legacyReportClient.fetch(id))`：后者在组装阶段、在当前线程上就已经阻塞了，`subscribeOn` 救不回来
- `boundedElastic` 有上限，只是隔离手段而不是扩容手段；大量阻塞调用说明这部分业务不适合响应式
- 绝不在响应式链路中调用 `block()` / `blockFirst()`；Reactor 在 parallel、single 及 Reactor Netty 的非阻塞线程上调用 `block()` 会直接抛 `IllegalStateException`

### 4、用 BlockHound 检测阻塞

BlockHound 是 Reactor 团队的 Java Agent，会在非阻塞线程上检测到阻塞调用（`Thread.sleep`、同步 Socket / 文件 IO、`Object.wait` 等）时直接抛错。通常只在测试中启用：

```xml
<dependency>
    <groupId>io.projectreactor.tools</groupId>
    <artifactId>blockhound</artifactId>
    <version>${blockhound.version}</version>  <!-- 不受 Boot 版本管理，以 Maven Central 为准 -->
    <scope>test</scope>
</dependency>
```

```java
@BeforeAll
static void installBlockHound() {
    BlockHound.install();   // 越早越好，最好在任何代码执行之前
}

@Test
void shouldNotBlock() {
    Mono.delay(Duration.ofMillis(1))             // 运行在 parallel 线程（非阻塞线程）
        .doOnNext(it -> {
            try {
                Thread.sleep(10);                // 阻塞调用 → BlockHound 抛出 BlockingOperationError
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
        })
        .as(StepVerifier::create)
        .expectErrorMatches(e -> e instanceof BlockingOperationError)   // reactor.blockhound.BlockingOperationError
        .verify();
}
```

JDK 13+ 需要加 JVM 参数 `-XX:+AllowRedefinitionToAddDeleteMethods`（如配置在 Surefire 的 `argLine` 中），否则无法完成插桩。

### 5、与虚拟线程的关系

| 能力 | 版本要求 | 说明 |
|------|----------|------|
| `boundedElastic` 基于虚拟线程 | Reactor 3.6+，Java 21+ | 设置系统属性 `-Dreactor.schedulers.defaultBoundedElasticOnVirtualThreads=true`，`Schedulers.boundedElastic()` 改为每个任务新建一个虚拟线程（不再保留空闲线程池），包装阻塞调用的成本更低 |
| WebFlux 阻塞控制器方法放到独立执行器 | Framework 6.1+ / Boot 3.2+ | 返回值不是响应式类型的控制器方法被视为阻塞方法，通过 `WebFluxConfigurer#configureBlockingExecution` 指定执行器；Boot 自动使用 `applicationTaskExecutor`，开启 `spring.threads.virtual.enabled=true` 后即为虚拟线程 |

虚拟线程让「阻塞式写法 + 高并发」变得廉价，削弱了为扩展性而引入 WebFlux 的理由；但背压、流式处理、取消传播、组合多个异步源这些能力仍是响应式独有的。

---

## 九、背压（Backpressure）

### 1、request(n)：背压的本质

背压就是**下游告诉上游自己还能处理多少**：订阅建立后，下游通过 `Subscription.request(n)` 声明需求，上游最多发 n 个；处理完再要。`subscribe(Consumer)` 默认请求 `Long.MAX_VALUE`（不限速），需要精细控制时继承 `BaseSubscriber`：

```java
Flux.range(1, 100).subscribe(new BaseSubscriber<Integer>() {
    @Override
    protected void hookOnSubscribe(Subscription subscription) {
        request(10);                 // 首批只要 10 个
    }

    @Override
    protected void hookOnNext(Integer value) {
        process(value);
        request(1);                  // 处理完一个再要一个
    }
});
```

### 2、prefetch 与 limitRate

不少操作符内部自带队列并预取（prefetch）：`publishOn` 默认预取 256 个元素，`flatMap` 默认并发 256、每个内部 Publisher 预取 32 个，然后在消费到一定比例时补充请求；而不带参数的 `concatMap` 不预取，前一个内部 Publisher 完成后才向上游再要一个。这些操作符把下游的「无限需求」转换为对上游的分批请求。

```java
Flux.range(1, 1_000)
    .limitRate(100)        // 对上游最多一次请求 100 个，已发出 75% 后再补一批
    .publishOn(Schedulers.boundedElastic(), 32)   // 第二个参数：publishOn 的预取量
    .subscribe(this::process);
```

`limitRate` 适合保护会因大批量请求而一次性拉取过多数据的上游（如分页查询、MQ 拉取）。

### 3、上游无法减速时：缓冲、丢弃或失败

`Flux.range`、R2DBC 查询这类源头能按需生产，天然遵守背压。但时间驱动或外部推送的源（`Flux.interval`、`Sinks`、WebSocket 消息）**无法减速**，下游跟不上时必须选择策略：

| 操作符 | 下游需求不足时 |
|--------|---------------|
| `onBackpressureBuffer(maxSize)` | 先缓冲，超过 `maxSize` 后以溢出错误终止并取消源头（不是丢弃） |
| `onBackpressureBuffer(maxSize, onOverflow, BufferOverflowStrategy.DROP_OLDEST)` | 缓冲满后按策略丢最旧或最新，不报错 |
| `onBackpressureDrop(onDropped)` | 直接丢弃新元素，可回调记录 |
| `onBackpressureLatest()` | 只保留最新一个，适合行情、状态类数据 |
| `onBackpressureError()` | 立即报错 |

```java
Flux.interval(Duration.ofMillis(1))                       // 每毫秒一个，无法减速
    .onBackpressureDrop(tick -> log.warn("处理不过来，丢弃 {}", tick))
    .concatMap(this::slowProcess)                          // 每个元素处理约 10ms
    .subscribe();

private Mono<Long> slowProcess(Long tick) {
    return Mono.delay(Duration.ofMillis(10)).thenReturn(tick);
}
```

没有背压策略时，`Flux.interval` 在下游跟不上会以 `OverflowException` 失败。

### 4、背压能否跨越网络

`request(n)` 是进程内的信号，能否传到远端取决于协议：

| 链路 | 背压传递方式 |
|------|-------------|
| HTTP（WebFlux 服务端 / WebClient） | 协议本身没有按条请求的语义，跨网络时只能退化为 TCP 流控：消费方不读，接收窗口变小，发送方写不出去 |
| RSocket | 协议级支持：`REQUEST_STREAM` / `REQUEST_CHANNEL` 帧携带初始需求，之后用 `REQUEST_N` 帧追加需求，请求方可以让响应方在源头减速 |
| R2DBC | 规范允许驱动根据背压推导抓取量（`fetchSize` 只是提示，可被忽略），是否映射为数据库游标分批拉取取决于具体驱动；背压是流控手段，限制结果集大小仍应写在 SQL 里 |

所以「WebFlux 天然背压」要打折扣：进程内的操作符链路完整遵守背压，到了 HTTP 边界就只剩 TCP 层的间接效果。

---

## 十、Context 与上下文传播

### 1、为什么 ThreadLocal / MDC 会失效

MDC、Spring Security 的 `SecurityContextHolder`、事务同步等都依赖 ThreadLocal。响应式链路中，一个请求的处理会在多个线程间跳转（事件循环线程、boundedElastic 线程、WebClient 回调线程），而一个线程又交替处理多个请求，因此在入口处放进 ThreadLocal 的值，在后续操作符中**可能读不到，甚至读到别的请求的值**。MDC 基础用法见 [日志](/spring-boot/12_logging)。

### 2、Reactor Context

Reactor 提供绑定在**订阅**而不是线程上的 `Context`：

```java
import reactor.core.publisher.Mono;
import reactor.util.context.Context;

Mono<String> greeting = Mono.deferContextual(ctx ->
        Mono.just("hello, " + ctx.getOrDefault("user", "anonymous")))
    .map(String::toUpperCase)
    .contextWrite(Context.of("user", "alice"));   // 写在下游，对上游可见

greeting.subscribe(System.out::println);           // HELLO, ALICE
```

- `Context` 是**不可变**的，`contextWrite` 返回新的 Context
- Context 随订阅从下往上传播，所以 `contextWrite` 只对写在它**上面（上游）**的操作符可见
- 在 WebFlux 中通常由 `WebFilter` 在 `chain.filter(exchange).contextWrite(...)` 写入，业务代码用 `deferContextual` 读取；Spring Security 的 `ReactiveSecurityContextHolder` 就是基于 Context 实现的

### 3、自动上下文传播（Micrometer Context Propagation）

日志框架只认 MDC，不认 Reactor Context。Reactor 3.5.3 起配合 `io.micrometer:context-propagation` 库提供**自动模式**：在每个操作符执行时，把 Context 中已注册键的值恢复到对应的 ThreadLocal 中，执行完再清理。

| 开启方式 | 版本 |
|----------|------|
| 启动时调用 `Hooks.enableAutomaticContextPropagation()` | Reactor 3.5.3+，只对之后创建的订阅生效 |
| Spring Boot 属性 `spring.reactor.context-propagation=auto`（默认 `limited`） | Boot 3.2+ |

```yaml
spring:
  reactor:
    context-propagation: auto
```

- 引入 Micrometer Tracing 后，当前 Observation 已注册，开启 `auto` 即可让 traceId / spanId 出现在响应式链路的日志里
- 自己放进 MDC 的业务字段（如 tenantId）需要注册 `ThreadLocalAccessor`，再在 `WebFilter` 中写入 Context：

```java
import io.micrometer.context.ContextRegistry;
import org.slf4j.MDC;
import org.springframework.web.server.WebFilter;
import reactor.util.context.Context;

@Configuration(proxyBeanMethods = false)
public class MdcPropagationConfig {

    static {
        // key 与 Reactor Context 中的 key 一致，Reactor 会在操作符执行前后调用 set / reset
        ContextRegistry.getInstance().registerThreadLocalAccessor(
            "tenantId",
            () -> MDC.get("tenantId"),
            value -> MDC.put("tenantId", value),
            () -> MDC.remove("tenantId"));
    }

    @Bean
    public WebFilter tenantWebFilter() {
        return (exchange, chain) -> {
            String tenantId = exchange.getRequest().getHeaders().getFirst("X-Tenant-Id");
            return tenantId == null
                ? chain.filter(exchange)
                : chain.filter(exchange).contextWrite(Context.of("tenantId", tenantId));
        };
    }
}
```

自动模式在每个操作符边界都要做 ThreadLocal 的恢复与清理，有一定性能开销，上线前应按预期负载压测；默认的 `limited` 模式只在 `handle`、`tap` 操作符中恢复 ThreadLocal。

---

## 十一、响应式 Repository（R2DBC）

```xml
<dependency>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-data-r2dbc</artifactId>
</dependency>
<dependency>
    <groupId>io.asyncer</groupId>
    <artifactId>r2dbc-mysql</artifactId>   <!-- 版本由 Spring Boot 管理 -->
</dependency>
```

```yaml
spring:
  r2dbc:
    url: r2dbc:mysql://localhost:3306/mydb
    username: root
    password: ${DB_PASSWORD}
```

```java
// Repository 接口
public interface UserRepository extends ReactiveCrudRepository<User, Long> {
    Flux<User> findByStatus(String status);
    Mono<User> findByUsername(String username);
    Mono<Long> countByStatus(String status);
}

// Service 使用
@Service
@RequiredArgsConstructor
public class UserService {

    private final UserRepository userRepo;

    public Flux<UserVO> listActiveUsers() {
        return userRepo.findByStatus("ACTIVE")
            .map(this::toVO)
            .doOnNext(u -> log.debug("查到用户: {}", u.getUsername()));
    }

    @Transactional  // 由自动配置的 R2dbcTransactionManager（ReactiveTransactionManager）驱动，事务绑定在 Reactor Context 上
    public Mono<UserVO> createUser(UserCreateDTO dto) {
        return userRepo.findByUsername(dto.getUsername())
            .flatMap(existing -> Mono.<UserVO>error(
                new BusinessException("用户名已存在")))
            .switchIfEmpty(
                Mono.fromSupplier(() -> toEntity(dto))
                    .flatMap(userRepo::save)
                    .map(this::toVO)
            );
    }
}
```

- 响应式事务依靠 Context 传递连接，所以事务内的操作必须处于**同一条响应式链路**中；在链路外另起 `subscribe()` 的操作不在事务里
- R2DBC 不是 ORM，没有懒加载与级联，关联查询需要手写 SQL 或在代码中组合
- 「先查再插」存在并发窗口，用户名唯一性最终要靠数据库唯一索引兜底

---

## 十二、调试与测试

### 1、调试手段

响应式链路出错时，异常堆栈里大多是 Reactor 内部类，看不出是哪条业务链路组装的操作符出了问题。

| 手段 | 作用 | 成本 | 建议 |
|------|------|------|------|
| `log()` / `log("category")` | 打印经过该点的所有信号：`onSubscribe`、`request`、`onNext`、`onError`、`onComplete`、`cancel` | 日志量大 | 排查背压、取消问题时临时加 |
| `checkpoint("描述")` | 在异常的回溯信息中标记出这一段链路 | 不带描述时会捕获堆栈；只带描述时很轻量 | 可以常驻在关键链路上 |
| `Hooks.onOperatorDebug()` | 全局为每个操作符记录组装位置的堆栈 | 全局生效，每个操作符都要捕获堆栈，代价很高 | 只在本地调试，禁止生产使用 |
| `ReactorDebugAgent`（reactor-tools） | 在类加载时插桩，把操作符的调用位置记录下来，效果接近 `onOperatorDebug` | 运行时开销小得多 | 可用于生产 |

引入 `io.projectreactor:reactor-tools`（版本由 Boot 管理）后，Spring Boot 会自动初始化调试 Agent，由 `spring.reactor.debug-agent.enabled` 控制（默认 `true`）。非 Boot 环境需在 `main` 方法最开始调用 `ReactorDebugAgent.init()`。

```java
return webClient.get().uri("/api/orders/{id}", id)
    .retrieve()
    .bodyToMono(OrderVO.class)
    .checkpoint("order-service#getOrder")          // 出错时回溯信息中会出现这个标记
    .log("order.fetch", Level.FINE);                 // java.util.logging.Level
```

### 2、StepVerifier

`reactor-test`（`io.projectreactor:reactor-test`，版本由 Boot 管理）提供 `StepVerifier`，逐个断言信号：

```java
import reactor.test.StepVerifier;

@Test
void filterAndMap() {
    Flux<Integer> flux = Flux.range(1, 5).filter(i -> i % 2 == 1).map(i -> i * 10);

    StepVerifier.create(flux)
        .expectNext(10, 30, 50)
        .verifyComplete();
}

@Test
void errorSignal() {
    StepVerifier.create(userService.findById(-1L))
        .expectError(EntityNotFoundException.class)
        .verify();
}
```

### 3、虚拟时间

涉及 `delay`、`interval`、`Retry.backoff` 的逻辑，用虚拟时间测试，不必真的等待：

```java
@Test
void delayedWithVirtualTime() {
    StepVerifier.withVirtualTime(() -> Mono.delay(Duration.ofHours(1)).map(tick -> "done"))  // 必须在 Supplier 中创建
        .expectSubscription()
        .expectNoEvent(Duration.ofHours(1))   // 推进虚拟时钟 1 小时，期间不应有信号
        .expectNext("done")
        .verifyComplete();
}
```

`withVirtualTime` 会把默认调度器替换为虚拟时钟，Publisher 必须在 Supplier 中惰性创建，提前创建好的 `Mono` 仍会使用真实时钟。

接口级测试（`@WebFluxTest` + `WebTestClient`）见 [Spring Boot 测试](/spring-boot/13_testing)。

---

## 十三、适用场景

**适合**：

- API 网关（大量并发转发），如 Spring Cloud Gateway
- 实时数据推送（SSE / WebSocket）
- 微服务间大量异步调用与多路聚合（配合 WebClient）
- 流式数据处理（Kafka 消费、文件流），需要背压与取消传播

**不适合**：

- 传统 CRUD 业务系统，依赖 JDBC / JPA 等阻塞库（引入复杂度，收益低，MVC + 虚拟线程通常更合适）
- 团队对响应式编程不熟悉时（调试困难，上下文与事务都要按响应式方式处理）

---

## 小结

- WebFlux 基于 Reactive Streams，默认运行在 Reactor Netty 上；非阻塞的前提是整条链路都不阻塞
- Nothing happens until you subscribe：组装阶段不执行业务，订阅自下而上，数据自上而下；忘记接入链路的 `Mono` 不会执行
- 冷流每次订阅都重新执行，`share` / `replay` / `cache` / `Sinks` 用于构造热流或复用结果
- `publishOn` 切换下游的执行线程，`subscribeOn` 切换源头与订阅线程且与位置无关；阻塞调用用 `fromCallable` + `subscribeOn(boundedElastic)` 隔离，用 BlockHound 在测试中兜底
- 背压靠 `request(n)`，`limitRate` / prefetch 控制批量；无法减速的源要选缓冲、丢弃或失败策略；HTTP 跨网络只剩 TCP 流控，RSocket 才有协议级背压
- ThreadLocal 在响应式链路中不可靠，用 Reactor Context；Boot 3.2+ 设置 `spring.reactor.context-propagation=auto` 让 traceId 等自动恢复到 MDC
- 重试会重新订阅上游，只用于幂等操作；`WebClient` 的连接异常是 `WebClientRequestException` 而不是 `IOException`
- 调试优先用 `checkpoint` 与 reactor-tools，`Hooks.onOperatorDebug` 仅限本地；测试用 `StepVerifier` 与虚拟时间

> 下一篇：[Spring Security](./9_security) —— 认证、授权与过滤器链，WebFlux 下同样基于响应式 Security 链路实现。
