---
description: Jackson 3、参数校验、ProblemDetail、Filter、CORS、HTTP 客户端、Tomcat 线程模型
---

# Web 开发

> 前置阅读：[MVC](/spring/3_mvc)

Spring Boot 在 Spring MVC 之上提供 Web 自动装配和一套工程默认值。本篇讲 Jackson 3、参数校验、错误响应、Filter 与 CORS、HTTP 客户端和内嵌 Tomcat 线程模型，基线为 Spring Boot 4。

---

## 一、Web 自动装配

DispatcherServlet 的请求处理流程、统一返回结构、`@RestControllerAdvice` 全局异常处理和拦截器实现属于 Spring MVC 本身，统一在 [MVC](/spring/3_mvc) 讲解。

### 1、starter 与默认装配

```xml
<dependency>
    <groupId>org.springframework.boot</groupId>
    <!-- Boot 4；3.x 为 spring-boot-starter-web -->
    <artifactId>spring-boot-starter-webmvc</artifactId>
</dependency>
```

引入后 Boot 自动装配：`DispatcherServlet`、基于 Jackson 的消息转换器、静态资源映射、`/error` 错误处理（`BasicErrorController`）、文件上传（`MultipartConfigElement`）以及内嵌 Tomcat。

**定制方式是实现 `WebMvcConfigurer`，不要加 `@EnableWebMvc`**：后者会让 Boot 的 MVC 自动配置整体退出，静态资源、消息转换器等默认配置全部失效。

### 2、Jackson 3

Boot 4 默认使用 Jackson 3（包名 `tools.jackson`，注解仍在 `com.fasterxml.jackson.annotation`），自动配置的是 `JsonMapper`：

| 场景 | Boot 4（Jackson 3） | Boot 3.x（Jackson 2） |
|------|--------------------|----------------------|
| 定制自动配置的 Mapper | `JsonMapperBuilderCustomizer` | `Jackson2ObjectMapperBuilderCustomizer` |
| 注册自定义序列化器 | `@JacksonComponent` | `@JsonComponent` |
| 完全替换 Mapper | 声明 `JsonMapper` Bean | 声明 `ObjectMapper` Bean |
| 读写特性配置 | `spring.jackson.json.read.*` / `spring.jackson.json.write.*` | `spring.jackson.read.*` / `spring.jackson.write.*`、`spring.jackson.parser.*` |

常用配置仍可直接写在 yml 中：

```yaml
spring:
  jackson:
    default-property-inclusion: non_null   # 不输出 null 字段
    time-zone: Asia/Shanghai
```

升级时需要沿用 Jackson 2 的默认行为，可设置 `spring.jackson.use-jackson2-defaults=true` 过渡；仍依赖 Jackson 2 的三方库可引入已废弃的 `spring-boot-jackson2` 模块。

### 3、常用配置

```yaml
server:
  servlet:
    context-path: /api
  error:
    include-message: never           # 生产环境不向客户端暴露异常信息
    include-stacktrace: never
spring:
  servlet:
    multipart:
      max-file-size: 20MB            # 默认 1MB
      max-request-size: 50MB
  mvc:
    problemdetails:
      enabled: true                  # 见第四节
```

---

## 二、Controller 与参数绑定

### 1、常用参数绑定

```java
@RestController
@RequestMapping("/api/orders")
@RequiredArgsConstructor
public class OrderController {

    private final OrderService orderService;

    // 查询参数：?status=PENDING&page=1&size=20
    @GetMapping
    public PageResult<OrderVO> list(@RequestParam(required = false) OrderStatus status,
                                    @RequestParam(defaultValue = "1") int page,
                                    @RequestParam(defaultValue = "20") @Max(100) int size) {
        return orderService.list(status, page, size);
    }

    // 路径变量：/api/orders/123
    @GetMapping("/{id}")
    public ResponseEntity<OrderVO> getById(@PathVariable @Positive Long id) {
        return orderService.findById(id)
            .map(ResponseEntity::ok)
            .orElse(ResponseEntity.notFound().build());
    }

    // 请求体：返回 201 + Location
    @PostMapping
    public ResponseEntity<OrderVO> create(@RequestBody @Valid OrderCreateDTO dto) {
        OrderVO order = orderService.create(dto);
        URI location = URI.create("/api/orders/" + order.id());
        return ResponseEntity.created(location).body(order);
    }

    // 文件下载：用 ContentDisposition 构造响应头，正确处理中文文件名，避免头注入
    @GetMapping("/export")
    public ResponseEntity<byte[]> export(@RequestParam ExportFormat format) {
        byte[] data = orderService.export(format);
        ContentDisposition cd = ContentDisposition.attachment()
            .filename("订单导出." + format.extension(), StandardCharsets.UTF_8)
            .build();
        return ResponseEntity.ok()
            .header(HttpHeaders.CONTENT_DISPOSITION, cd.toString())
            .contentType(MediaType.APPLICATION_OCTET_STREAM)
            .body(data);
    }

    // 文件上传
    @PostMapping("/import")
    public int importOrders(@RequestParam MultipartFile file) {
        return orderService.importFromFile(file);
    }
}
```

`PageResult`、`OrderVO`（record）、`ExportFormat`（枚举）为项目自定义类型。几个容易忽略的点：

- **`@PathVariable Long id` 不写名字依赖编译参数 `-parameters`**。Framework 6.1 起不再从调试信息推断参数名，`spring-boot-starter-parent` 已默认开启；自建父 POM 或 Gradle 项目要自己加，否则运行时报找不到参数名
- 导出文件名用 `ContentDisposition` 构造，直接字符串拼接既有中文乱码问题，也有响应头注入风险
- 枚举参数（`OrderStatus`、`ExportFormat`）由框架自动转换，非法值会返回 400

### 2、API 版本控制（Boot 4）

Framework 7 内置 API 版本控制，Boot 4 通过 `spring.mvc.apiversion.*`（WebFlux 为 `spring.webflux.apiversion.*`）配置版本来源，版本可来自请求头、查询参数、媒体类型参数或路径：

```yaml
spring:
  mvc:
    apiversion:
      default: 1.0
      use:
        header: X-API-Version
```

```java
@GetMapping(path = "/{id}", version = "1.1")      // 仅匹配 1.1
public OrderVO getV1_1(@PathVariable Long id) { ... }

@GetMapping(path = "/{id}", version = "1.2+")     // 1.2 及以上
public OrderDetailVO getV1_2(@PathVariable Long id) { ... }
```

配置了 `default` 时，缺少版本的请求按默认版本处理；未配置时缺少版本返回 400。版本解析、支持版本的收集、异常与废弃响应头等框架机制见 [MVC · API 版本控制](/spring/3_mvc#七、api-版本控制)。

---

## 三、参数校验

```xml
<dependency>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-validation</artifactId>
</dependency>
```

### 1、常用注解

```java
@Data
public class UserCreateDTO {

    @NotBlank(message = "用户名不能为空")
    @Size(min = 3, max = 20, message = "用户名长度 3-20 位")
    private String username;

    @NotBlank
    @Pattern(regexp = "^(?=.*[A-Za-z])(?=.*\\d).{8,}$", message = "密码至少 8 位，含字母和数字")
    private String password;

    @NotNull
    @Email(message = "邮箱格式不正确")
    private String email;

    @NotNull
    @Min(value = 1, message = "年龄不能小于 1")
    @Max(value = 150, message = "年龄不能大于 150")
    private Integer age;

    @NotEmpty(message = "角色列表不能为空")
    private List<@NotBlank String> roles;

    @Valid                       // 嵌套对象需要 @Valid 才会级联校验
    private AddressDTO address;
}
```

### 2、两条校验路径

Framework 6.1（Boot 3.2）起，Spring MVC 内置了**方法参数校验**，不再需要在 Controller 类上加 `@Validated`：

| 写法 | 触发方式 | 失败时的异常 |
|------|---------|-------------|
| 只有 `@RequestBody @Valid` 等对象参数需要校验 | 参数解析时校验 | `MethodArgumentNotValidException` |
| `@PathVariable` / `@RequestParam` 上直接写约束注解（`@Positive`、`@Max` 等），或方法上有返回值约束 | 内置方法校验（6.1+），一次校验全部参数 | `HandlerMethodValidationException` |
| Controller 类上加 `@Validated`（旧写法） | AOP 方法校验（`MethodValidationPostProcessor`） | `ConstraintViolationException` |

- 新代码**不要在 Controller 上加 `@Validated`**，否则同一请求会被内置校验与 AOP 校验各跑一遍，异常类型也会混乱。`@Validated` 留给 Service 层的方法校验和分组校验
- 内置方法校验生效时，`@RequestBody @Valid` 的失败也会被包装进 `HandlerMethodValidationException`，所以两类异常都要处理

```java
@RestControllerAdvice
public class ValidationExceptionHandler {

    // 只有 @RequestBody @Valid 需要校验时
    @ExceptionHandler(MethodArgumentNotValidException.class)
    public ProblemDetail handleBody(MethodArgumentNotValidException e) {
        ProblemDetail pd = ProblemDetail.forStatusAndDetail(HttpStatus.BAD_REQUEST, "参数校验失败");
        Map<String, String> errors = new LinkedHashMap<>();
        e.getBindingResult().getFieldErrors()
            .forEach(fe -> errors.putIfAbsent(fe.getField(), fe.getDefaultMessage()));
        pd.setProperty("errors", errors);
        return pd;
    }

    // 路径 / 查询参数上有约束注解时（6.1+ 内置方法校验）
    @ExceptionHandler(HandlerMethodValidationException.class)
    public ProblemDetail handleMethod(HandlerMethodValidationException e) {
        ProblemDetail pd = ProblemDetail.forStatusAndDetail(HttpStatus.BAD_REQUEST, "参数校验失败");
        List<String> errors = e.getAllErrors().stream()
            .map(MessageSourceResolvable::getDefaultMessage)
            .toList();
        pd.setProperty("errors", errors);
        return pd;
    }
}
```

如果全局异常处理器继承了 `ResponseEntityExceptionHandler`，它已经声明了这两个异常的处理方法，应覆写 `handleMethodArgumentNotValid` / `handleHandlerMethodValidationException`，再写 `@ExceptionHandler` 会因映射重复而启动失败。

### 3、分组校验

```java
public interface CreateGroup {}
public interface UpdateGroup {}

@Data
public class UserDTO {

    @Null(groups = CreateGroup.class, message = "创建时不允许传 id")
    @NotNull(groups = UpdateGroup.class, message = "更新时必须传 id")
    private Long id;

    @NotBlank(groups = {CreateGroup.class, UpdateGroup.class})
    private String username;
}

@PostMapping
public UserVO create(@RequestBody @Validated(CreateGroup.class) UserDTO dto) { ... }

@PutMapping
public UserVO update(@RequestBody @Validated(UpdateGroup.class) UserDTO dto) { ... }
```

分组让一个 DTO 服务多个接口，但分组一多就难以阅读；字段差异大时，直接拆成 `UserCreateDTO` / `UserUpdateDTO` 更清晰。

### 4、自定义校验注解

```java
@Target({ElementType.FIELD, ElementType.PARAMETER})
@Retention(RetentionPolicy.RUNTIME)
@Constraint(validatedBy = PhoneValidator.class)
public @interface Phone {
    String message() default "手机号格式不正确";
    Class<?>[] groups() default {};
    Class<? extends Payload>[] payload() default {};
}

public class PhoneValidator implements ConstraintValidator<Phone, String> {

    private static final Pattern PHONE_PATTERN = Pattern.compile("^1[3-9]\\d{9}$");

    @Override
    public boolean isValid(String value, ConstraintValidatorContext context) {
        if (value == null) {
            return true;              // null 交给 @NotNull 处理，职责单一
        }
        return PHONE_PATTERN.matcher(value).matches();
    }
}
```

`ConstraintValidator` 实现类由 Spring 创建，可以注入 Bean（如查库校验唯一性），但要注意校验里查库会放大接口耗时。

---

## 四、错误响应：/error 与 ProblemDetail

### 1、Boot 的默认错误处理

没有被 `@ExceptionHandler` 处理的异常，最终由 Servlet 容器转发到 `/error`，Boot 的 `BasicErrorController` 返回 JSON（浏览器访问时返回 Whitelabel 页面）：

- 返回字段由 `DefaultErrorAttributes` 决定，`server.error.include-message`、`include-binding-errors`、`include-stacktrace` 控制是否暴露细节，**生产环境保持 `never`**
- **Filter 里抛出的异常不会进入 `@RestControllerAdvice`**：它发生在 DispatcherServlet 之外，只能走 `/error`。认证失败等 Filter 层错误要在 Filter 内自己写响应，或交给 Spring Security 的 `AuthenticationEntryPoint`

### 2、ProblemDetail（RFC 9457）

Framework 6 支持 RFC 9457 标准错误体（`application/problem+json`）：

```json
{
  "type": "about:blank",
  "title": "Not Found",
  "status": 404,
  "detail": "订单不存在: 123",
  "instance": "/api/orders/123"
}
```

设置 `spring.mvc.problemdetails.enabled=true` 后，Boot 注册一个继承自 `ResponseEntityExceptionHandler` 的处理器，Spring MVC 自身的异常（参数缺失、类型转换失败、405、415 等）都会以 ProblemDetail 返回。项目里已经有继承 `ResponseEntityExceptionHandler` 的全局处理器时，Boot 的这个处理器会自动退出。

业务异常可以直接继承 `ErrorResponseException`，不用再写对应的 `@ExceptionHandler`：

```java
public class OrderNotFoundException extends ErrorResponseException {

    public OrderNotFoundException(long id) {
        super(HttpStatus.NOT_FOUND,
              ProblemDetail.forStatusAndDetail(HttpStatus.NOT_FOUND, "订单不存在: " + id),
              null);
    }
}
```

ProblemDetail 与「统一 `Result` 包装 + 业务错误码」两种风格的取舍、全局异常处理器的完整写法见 [MVC](/spring/3_mvc)。

---

## 五、Filter 与拦截器的注册

| 对比 | Filter | HandlerInterceptor |
|------|--------|-------------------|
| 所属规范 | Servlet 规范 | Spring MVC |
| 执行位置 | DispatcherServlet 之前，可包装 request / response | DispatcherServlet 之内，Handler 执行前后 |
| 能拿到什么 | 原始请求与响应 | 将要执行的 Handler（方法与注解） |
| 在 Boot 中注册 | `@Component` 或 `FilterRegistrationBean` | `WebMvcConfigurer#addInterceptors` |
| 典型场景 | 请求日志、traceId、请求体缓存、压缩 | 登录态检查、按注解做权限或限流 |

两者在 Boot 里都是 Spring Bean，都可以注入依赖。拦截器的完整实现见 [MVC](/spring/3_mvc)，这里只讲 Boot 对 Filter 的注册方式。

### 1、@Component 直接注册

```java
@Slf4j
@Component
@Order(Ordered.HIGHEST_PRECEDENCE)    // 排在 Spring Security 之前，失败请求也能记到
public class RequestLoggingFilter extends OncePerRequestFilter {

    @Override
    protected void doFilterInternal(HttpServletRequest req, HttpServletResponse res,
                                    FilterChain chain) throws ServletException, IOException {
        long start = System.nanoTime();
        try {
            chain.doFilter(req, res);
        } finally {
            log.info("{} {} -> {} ({}ms)", req.getMethod(), req.getRequestURI(),
                res.getStatus(), (System.nanoTime() - start) / 1_000_000);
        }
    }
}
```

`@Component` 的 Filter 默认拦截所有 URL。Spring Security 的过滤器链整体作为一个 Filter 注册，顺序为 `spring.security.filter.order`（默认 -100）：`@Order` 数值比它小的 Filter 在认证之前执行，比它大的在认证之后执行。

### 2、FilterRegistrationBean 精确控制

```java
@Configuration
public class FilterConfig {

    @Bean
    public FilterRegistrationBean<SignatureFilter> signatureFilter(SignatureVerifier verifier) {
        FilterRegistrationBean<SignatureFilter> reg =
            new FilterRegistrationBean<>(new SignatureFilter(verifier));
        reg.addUrlPatterns("/api/open/*");   // 只拦截开放接口
        reg.setOrder(10);
        return reg;
    }
}
```

`SignatureFilter` 此时**不要再加 `@Component`**，否则会被注册两次（一次全局、一次按 URL）。

---

## 六、CORS 跨域

### 1、全局配置

```java
@Configuration
@RequiredArgsConstructor
public class CorsConfig implements WebMvcConfigurer {

    private final CorsProperties corsProperties;   // @ConfigurationProperties，从配置读取白名单

    @Override
    public void addCorsMappings(CorsRegistry registry) {
        registry.addMapping("/api/**")
                .allowedOrigins(corsProperties.allowedOrigins().toArray(String[]::new))
                .allowedMethods("GET", "POST", "PUT", "DELETE")
                .allowedHeaders("Content-Type", "Authorization", "X-API-Version")
                .allowCredentials(true)
                .maxAge(3600);                     // 预检结果缓存 1 小时
    }
}

@ConfigurationProperties(prefix = "app.cors")
public record CorsProperties(List<String> allowedOrigins) {}
```

```yaml
app:
  cors:
    allowed-origins:
      - https://admin.example.com
      - https://www.example.com
```

单个接口也可以用 `@CrossOrigin(origins = "https://admin.example.com")`，但分散在各处的注解难以审计，统一放在全局配置里更好。

### 2、携带凭证时的安全陷阱

| 写法 | 结果 |
|------|------|
| `allowedOrigins("*")` + `allowCredentials(true)` | 启动后第一次跨域请求就抛 `IllegalArgumentException`，框架直接禁止 |
| `allowedOriginPatterns("*")` + `allowCredentials(true)` | **能运行，但等于把任意来源原样回显到 `Access-Control-Allow-Origin`**：任何网站都能带着用户的 Cookie 调用接口并读取响应，造成数据泄露 |
| 明确的域名白名单 + `allowCredentials(true)` | 推荐 |
| `allowedOriginPatterns("https://*.example.com")` + `allowCredentials(true)` | 子域多且都可信时使用，前提是子域不会被第三方接管 |

网上常见的「把 `allowedOrigins` 换成 `allowedOriginPatterns("*")` 就好了」只是绕过了框架的保护。使用 Bearer Token 而不依赖 Cookie 的接口通常不需要 `allowCredentials(true)`。

### 3、Spring Security 项目

启用了 Spring Security 时，预检请求（OPTIONS）会先被过滤器链拦下，必须在 Security 配置里开启 CORS：

```java
@Bean
public SecurityFilterChain filterChain(HttpSecurity http) throws Exception {
    return http
        .cors(Customizer.withDefaults())   // 使用 CorsConfigurationSource Bean；没有时复用上面的 MVC 配置
        // 其他配置省略
        .build();
}
```

CORS 只是浏览器的读取限制，不是鉴权手段，非浏览器客户端不受它约束。Security 的完整配置见 [Spring Security](/spring/9_security)。

---

## 七、HTTP 客户端

### 1、选型

| 客户端 | 风格 | 状态 | 适用 |
|--------|------|------|------|
| `RestTemplate` | 模板方法 | Framework 7.1 起标记 `@Deprecated`，计划在 8.0 移除；Boot 只提供 `RestTemplateBuilder`，不提供实例 | 只维护存量代码 |
| `RestClient`（6.1 / Boot 3.2+） | 同步、Fluent 链式 | 同步场景的推荐方案 | 新代码的同步调用 |
| `WebClient` | 响应式 | 持续维护 | WebFlux 应用、需要非阻塞 |
| HTTP Service Clients（`@HttpExchange` 接口） | 声明式接口 | Framework 6 引入；Framework 7 / Boot 4 新增分组注册与配置 | 调用面较宽的外部 API、服务间调用 |

### 2、RestClient

Boot 预先配置了一个原型作用域的 `RestClient.Builder`（已带上消息转换器、超时、观测等配置），**注入它来构造客户端**，而不是 `RestClient.create()`：

```java
@Service
public class ProductClient {

    private final RestClient restClient;

    public ProductClient(RestClient.Builder builder) {
        this.restClient = builder
            .baseUrl("https://api.example.com")
            .defaultHeader("X-App", "order-service")
            .build();
    }

    public Product getProduct(long id) {
        return restClient.get()
            .uri("/products/{id}", id)
            .retrieve()
            .onStatus(status -> status.value() == 404,
                (req, resp) -> { throw new ProductNotFoundException(id); })
            .body(Product.class);
    }
}
```

```yaml
spring:
  http:
    clients:                     # Boot 4：所有 HTTP 客户端的全局默认值
      connect-timeout: 1s
      read-timeout: 3s
```

**一定要设置超时**：未设置时的默认值可能是无限等待，一个慢下游就能耗尽调用方的线程。超时、重试与隔离的系统性设计见 [超时、重试与隔离](/high-avail/4_timeout_retry_bulkhead)；Framework 7 自带的 `@Retryable` 见 [Retry 重试](/spring/6_retry)。

### 3、HTTP Service Clients

把远程 API 声明成接口：

```java
public interface ProductApi {

    @GetExchange("/products/{id}")
    Product getProduct(@PathVariable long id);

    @PostExchange("/products")
    Product create(@RequestBody ProductRequest request);
}
```

**Boot 4**：用 `@ImportHttpServices` 按分组注册，地址与超时写在配置里，接口直接注入使用：

```java
@SpringBootApplication
@ImportHttpServices(group = "product", types = ProductApi.class)
// 也可以按包扫描整组接口：@ImportHttpServices(group = "inventory", basePackages = "com.example.client.inventory")
public class Application { ... }
```

```yaml
spring:
  http:
    clients:
      connect-timeout: 1s           # 所有 HTTP 客户端的全局默认值
    serviceclient:
      product:                      # 按组覆盖
        base-url: https://product.example.com
        read-timeout: 2s
```

需要按组统一加请求头、拦截器时，声明 `RestClientHttpServiceGroupConfigurer` Bean：

```java
@Bean
RestClientHttpServiceGroupConfigurer groupConfigurer() {
    return groups -> groups.forEachClient((group, builder) ->
        builder.defaultHeader("X-Caller", "order-service"));
}
```

**Boot 3.x**：没有分组注册，需要为每个接口手写代理工厂：

```java
@Bean
public ProductApi productApi(RestClient.Builder builder) {
    RestClient restClient = builder.baseUrl("https://product.example.com").build();
    return HttpServiceProxyFactory
        .builderFor(RestClientAdapter.create(restClient))
        .build()
        .createClient(ProductApi.class);
}
```

### 4、选型速记

- 新代码的同步调用用 `RestClient`；调用的接口多、希望收口成接口时用 HTTP Service Clients
- 响应式技术栈用 WebClient，见 [WebFlux](/spring/8_webflux)
- 微服务内部调用：Spring Cloud OpenFeign 已进入功能完备（feature-complete）状态，新项目优先 HTTP Service Clients 配合服务发现与负载均衡，存量 OpenFeign 可继续使用，见 [服务通信](/microservices/12_communication)
- `RestTemplate` 只在存量代码中维持，趁改动时逐步替换为 `RestClient`（两者可以共用同一个底层 `ClientHttpRequestFactory`）

---

## 八、内嵌 Tomcat 线程模型

Boot 4 默认的内嵌容器是 Tomcat 11（另一个选择是 Jetty，Undertow 已移除）。参数的容量估算和压测方法在 [并发参数调优](/high-con/7_concurrency_tuning#二、web-容器参数) 统一讲，这里讲清楚请求在哪些线程之间流转，以及默认值背后的道理。

### 1、一个请求经过的线程

![内嵌 Tomcat（NIO）一个请求经过的线程](../assets/spring-boot/tomcat-thread-model.svg)

| 角色 | 线程名（端口 8080） | 数量 | 职责 |
|------|-------------------|------|------|
| Acceptor | `http-nio-8080-Acceptor` | 1 | 从 OS 全连接队列 `accept()` 新连接，交给 Poller；连接数到达 `max-connections` 时暂停 accept |
| Poller | `http-nio-8080-Poller` | 1 | 用 NIO `Selector` 监听所有连接的可读事件，有数据到达就把连接封装成任务提交给工作线程池 |
| 工作线程 | `http-nio-8080-exec-N` | `min-spare` ~ `threads.max` | 解析 HTTP、执行 Filter 链、`DispatcherServlet` 与 Controller，直到响应写完 |

这正是 Reactor 的分工：Acceptor 收连接、Selector 分发事件、线程池处理业务（与 Netty 的对比见 [Reactor 模型](/netty/2_reactor)），由此有两个推论：

- **空闲的长连接不占工作线程**：Keep-Alive 连接在两次请求之间回到 Poller 等待，所以 `max-connections`（8192）可以远大于 `threads.max`（200）
- **业务代码里的阻塞会一直占着工作线程**：查库、调下游、等锁期间，这个线程什么也不干但也不释放。线程 dump 里大量 `exec-N` 停在 socket 读（`NioSocketImpl.read`）或 `HikariPool.getConnection`，说明瓶颈在下游而不在 Tomcat

### 2、默认值与三道闸门

| 属性（Boot 4） | 默认值 | 作用 |
|---------------|--------|------|
| `server.tomcat.threads.max` | 200 | 工作线程上限，即同时处理的请求数 |
| `server.tomcat.threads.min-spare` | 10 | 常驻的最少工作线程 |
| `server.tomcat.threads.max-queue-capacity` | `Integer.MAX_VALUE` | 线程用满后任务排队的容量 |
| `server.tomcat.max-connections` | 8192 | 已接收连接的总数上限 |
| `server.tomcat.accept-count` | 100 | OS 全连接队列长度，实际取 `min(accept-count, somaxconn)` |

请求压力递增时依次触发：工作线程扩到 `threads.max` → 新请求在连接上等待，直到连接数达到 `max-connections` → 新连接停在 OS 队列 → 队列满后客户端连接超时或被拒绝。

Tomcat 的工作线程池与 JDK `ThreadPoolExecutor` 默认行为相反：它用自定义的 `TaskQueue`，线程数没到 `threads.max` 时**先建线程再排队**，适合请求处理这种「宁可多开线程也不要排队」的场景，JDK 线程池的提交流程见 [线程池](/java/28_topic_thread_pool)。

### 3、为什么默认 200 而不是 N + 1

「CPU 核数 + 1」是 **CPU 密集型** 任务的经验值：线程几乎不等待，多开只会增加上下文切换。Web 请求是 **IO 密集型**，大部分时间在等数据库、缓存和下游接口，线程等待时 CPU 是空闲的，需要更多线程才能把 CPU 用起来：

```text
线程数 ≈ CPU 核数 × (1 + 等待时间 / 计算时间)
```

8 核机器上，一个请求耗时 50ms、其中只有 5ms 在用 CPU，约 `8 × (1 + 45 / 5) = 80` 个线程就能让 CPU 跑满；等待占比更高的接口需要的更多。200 是一个面向「普通 IO 型 Web 应用」的通用默认值，不是算出来的最优值，调整时注意：

- **按 Little 定律反推**：所需并发 ≈ 目标 QPS × 平均响应时间，例如 2000 QPS × 0.1s = 200
- **先看下游池**：HikariCP 默认 `maximum-pool-size` 只有 10，200 个工作线程同时查库，190 个会在 `getConnection` 上排队；加大 `threads.max` 前先确认数据库连接池、HTTP 客户端连接池能不能接住
- **调大不是免费的**：每个平台线程默认栈 1MB（`-Xss`），上千线程既占内存又增加切换开销；线程不够用通常意味着响应时间变长了，先查慢在哪里

### 4、虚拟线程

JDK 21+ 设置 `spring.threads.virtual.enabled=true` 后，Boot 4 把 Tomcat 的执行器换成 `VirtualThreadExecutor`，每个请求一个虚拟线程，线程名变为 `tomcat-handler-N`：

```yaml
spring:
  threads:
    virtual:
      enabled: true          # Boot 3.2+；Boot 4 中同样适用于 Jetty
```

- Acceptor 和 Poller 不变，只有工作线程换成虚拟线程；`threads.max`、`min-spare`、`max-queue-capacity` 不再生效
- `max-connections` 成为容器层唯一的并发闸门，阻塞等待不再占用平台线程，瓶颈直接转移到下游：数据库连接池、对外 HTTP 调用要靠池大小或信号量限流
- 虚拟线程在 JDK 21–23 中于 `synchronized` 内阻塞会钉住载体线程，JDK 24 起解决；开关影响的组件（`@Async`、`@Scheduled` 等）见 [异步任务与定时任务](./7_async_schedule)，原理见 [虚拟线程](/java/30_topic_virtual_thread)

---

## 小结

- Boot 4 的 Web starter 是 `spring-boot-starter-webmvc`；定制用 `WebMvcConfigurer`，加 `@EnableWebMvc` 会关掉 Boot 的 MVC 自动配置
- Boot 4 默认 Jackson 3：定制用 `JsonMapperBuilderCustomizer`，自定义序列化器用 `@JacksonComponent`
- 省略参数名依赖 `-parameters` 编译选项；导出文件名用 `ContentDisposition` 构造
- 6.1+ 内置方法校验：路径 / 查询参数直接写约束注解，失败抛 `HandlerMethodValidationException`；Controller 上不要再加 `@Validated`
- 未处理的异常最终走 `/error`，Filter 里的异常进不了 `@RestControllerAdvice`；`spring.mvc.problemdetails.enabled=true` 让 MVC 异常以 RFC 9457 格式返回
- Filter 用 `@Component` 或 `FilterRegistrationBean` 注册，二选一；相对 Spring Security（-100）的顺序决定它在认证前还是认证后执行
- CORS 携带凭证时必须用明确的来源白名单，`allowedOriginPatterns("*")` + 凭证等于对所有网站开放
- 同步调用用 `RestClient`，接口化调用用 HTTP Service Clients（Boot 4 的 `@ImportHttpServices` + `spring.http.serviceclient.*`），`RestTemplate` 在 Framework 7.1 被废弃；所有客户端都要设超时
- 内嵌 Tomcat：1 个 Acceptor、1 个 Poller、最多 `threads.max`（200）个工作线程；IO 型请求大部分时间在等待，所以默认值远大于 N + 1，调大前先看下游连接池；开启虚拟线程后 `max-connections` 是容器层唯一的闸门

## 参考资料

- Spring Boot Servlet Web Applications：[https://docs.spring.io/spring-boot/reference/web/servlet.html](https://docs.spring.io/spring-boot/reference/web/servlet.html)
- Spring MVC：[https://docs.spring.io/spring-framework/reference/web/webmvc.html](https://docs.spring.io/spring-framework/reference/web/webmvc.html)
- Spring MVC Validation：[https://docs.spring.io/spring-framework/reference/web/webmvc/mvc-controller/ann-validation.html](https://docs.spring.io/spring-framework/reference/web/webmvc/mvc-controller/ann-validation.html)
- CORS：[https://docs.spring.io/spring-framework/reference/web/webmvc-cors.html](https://docs.spring.io/spring-framework/reference/web/webmvc-cors.html)
- Spring Boot Calling REST Services：[https://docs.spring.io/spring-boot/reference/io/rest-client.html](https://docs.spring.io/spring-boot/reference/io/rest-client.html)
- Spring Boot Embedded Web Servers：[https://docs.spring.io/spring-boot/how-to/webserver.html](https://docs.spring.io/spring-boot/how-to/webserver.html)
- Apache Tomcat 11 HTTP Connector 配置：[https://tomcat.apache.org/tomcat-11.0-doc/config/http.html](https://tomcat.apache.org/tomcat-11.0-doc/config/http.html)
- Framework REST Clients：[https://docs.spring.io/spring-framework/reference/integration/rest-clients.html](https://docs.spring.io/spring-framework/reference/integration/rest-clients.html)

> 下一篇：[数据访问](./3_data_access) —— 持久化方案选型、JPA 与 MyBatis-Plus 的正确用法、事务装配、多数据源与分页。
