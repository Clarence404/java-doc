# Spring WebFlux

> 参考资料：
> * 官方文档：[https://docs.spring.io/spring-framework/reference/web/webflux.html](https://docs.spring.io/spring-framework/reference/web/webflux.html)
> * Project Reactor：[https://projectreactor.io/docs/core/release/reference/](https://projectreactor.io/docs/core/release/reference/)

## 一、响应式编程基础

**响应式编程**：基于异步数据流的编程范式，通过非阻塞的方式处理数据，适合高并发、I/O 密集型场景。

| 类型 | 说明 | 类比 |
|------|------|------|
| `Mono<T>` | 0 或 1 个元素的异步序列 | 单个结果，类似 `CompletableFuture<T>` |
| `Flux<T>` | 0 到 N 个元素的异步序列 | 集合结果，类似异步 `Stream<T>` |

---

## 二、Spring MVC vs Spring WebFlux

| 对比 | Spring MVC | Spring WebFlux |
|------|-----------|----------------|
| 线程模型 | 每请求一线程（阻塞） | 少量线程处理大量请求（非阻塞） |
| 编程模型 | 命令式 | 声明式 / 函数式 |
| 底层容器 | Tomcat / Jetty | Netty / Undertow |
| 学习曲线 | 低 | 高 |
| 适用场景 | 常规业务系统 | 高并发 I/O 密集、网关、流处理 |

---

## 三、Mono / Flux 常用操作

```java
// 创建
Mono<String> mono = Mono.just("hello");
Mono<Void>   empty = Mono.empty();
Mono<String> error = Mono.error(new RuntimeException("fail"));

Flux<Integer> flux = Flux.just(1, 2, 3, 4, 5);
Flux<Integer> range = Flux.range(1, 100);
Flux<Long>    interval = Flux.interval(Duration.ofSeconds(1));  // 每秒发射一个元素

// 转换
Flux.range(1, 10)
    .filter(i -> i % 2 == 0)
    .map(i -> i * 10)
    .take(3)
    .subscribe(System.out::println);   // 20 40 60

// 异步转换（flatMap：每个元素映射为一个 Publisher，并发展开）
Flux.just("user1", "user2", "user3")
    .flatMap(name -> userRepository.findByName(name))  // 并发查询
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

---

## 四、两种编程模型

### 4.1 注解模型（推荐，与 Spring MVC 写法接近）

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

### 4.2 函数式路由模型

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

```java
@Service
public class UserService {

    public Mono<UserVO> findById(Long id) {
        return userRepository.findById(id)
            // 空结果 → 抛异常
            .switchIfEmpty(Mono.error(new EntityNotFoundException("用户不存在: " + id)))
            .map(this::toVO);
    }

    public Mono<UserVO> findByIdSafe(Long id) {
        return userRepository.findById(id)
            .map(this::toVO)
            // 遇到特定异常 → 返回默认值
            .onErrorReturn(EntityNotFoundException.class, UserVO.anonymous())
            // 遇到任意异常 → 转为另一个 Mono
            .onErrorResume(e -> {
                log.warn("查询失败: {}", e.getMessage());
                return Mono.just(UserVO.anonymous());
            })
            // 异常转换（包装为业务异常）
            .onErrorMap(DataAccessException.class,
                e -> new ServiceException("数据库异常", e));
    }

    // 重试
    public Mono<String> callRemote(String url) {
        return webClient.get().uri(url).retrieve().bodyToMono(String.class)
            .retryWhen(Retry.backoff(3, Duration.ofSeconds(1))
                .maxBackoff(Duration.ofSeconds(10))
                .filter(e -> e instanceof IOException));  // 只重试 IO 异常
    }
}
```

```java
// 全局异常处理（WebFlux 版）
@Component
public class GlobalErrorHandler implements ErrorWebExceptionHandler {

    @Override
    public Mono<Void> handle(ServerWebExchange exchange, Throwable ex) {
        ServerHttpResponse response = exchange.getResponse();

        if (ex instanceof EntityNotFoundException) {
            response.setStatusCode(HttpStatus.NOT_FOUND);
        } else if (ex instanceof BusinessException be) {
            response.setStatusCode(HttpStatus.OK);
        } else {
            response.setStatusCode(HttpStatus.INTERNAL_SERVER_ERROR);
        }

        response.getHeaders().setContentType(MediaType.APPLICATION_JSON);
        String body = "{\"code\":" + response.getStatusCode().value()
                    + ",\"message\":\"" + ex.getMessage() + "\"}";
        DataBuffer buffer = response.bufferFactory().wrap(body.getBytes(StandardCharsets.UTF_8));
        return response.writeWith(Mono.just(buffer));
    }
}
```

---

## 六、WebClient（非阻塞 HTTP 客户端）

WebClient 是 WebFlux 提供的响应式 HTTP 客户端，是 `RestTemplate` 的响应式替代品。

```java
@Configuration
public class WebClientConfig {

    @Bean
    public WebClient userServiceClient() {
        return WebClient.builder()
            .baseUrl("http://user-service")
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

    // POST 请求
    public Mono<OrderVO> createOrder(OrderCreateDTO dto) {
        return userServiceClient.post()
            .uri("/api/orders")
            .bodyValue(dto)
            .retrieve()
            .bodyToMono(OrderVO.class)
            .timeout(Duration.ofSeconds(5))
            .retryWhen(Retry.fixedDelay(2, Duration.ofSeconds(1)));
    }

    // 并发请求（同时查多个服务）
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

---

## 七、背压（Backpressure）

```java
// 生产者速度 > 消费者处理能力时，通过背压控制流速
Flux.range(1, 1_000_000)
    .onBackpressureBuffer(1000)          // 缓冲最多 1000 个，超出丢弃
    // .onBackpressureDrop()             // 超出直接丢弃
    // .onBackpressureLatest()           // 只保留最新的
    .publishOn(Schedulers.boundedElastic())
    .subscribe(
        item -> {
            Thread.sleep(10);            // 模拟慢消费者
            process(item);
        },
        error -> log.error("背压溢出", error)
    );

// limitRate：控制每次请求元素数量
Flux.range(1, 100)
    .limitRate(10)                        // 每次最多请求 10 个
    .subscribe(System.out::println);
```

---

## 八、响应式 Repository（R2DBC）

```xml
<dependency>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-data-r2dbc</artifactId>
</dependency>
<dependency>
    <groupId>io.asyncer</groupId>
    <artifactId>r2dbc-mysql</artifactId>
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

    @Transactional  // R2DBC 支持响应式事务
    public Mono<UserVO> createUser(UserCreateDTO dto) {
        return userRepo.findByUsername(dto.getUsername())
            .flatMap(existing -> Mono.<UserVO>error(
                new BusinessException("用户名已存在")))
            .switchIfEmpty(
                Mono.just(toEntity(dto))
                    .flatMap(userRepo::save)
                    .map(this::toVO)
            );
    }
}
```

---

## 九、适用场景

- ✅ API 网关（大量并发转发）
- ✅ 实时数据推送（SSE / WebSocket）
- ✅ 微服务间大量异步调用（配合 WebClient）
- ✅ 流式数据处理（Kafka 消费、文件流）
- ❌ 传统 CRUD 业务系统（引入复杂度，收益低）
- ❌ 团队对响应式编程不熟悉时（调试困难）
