---
description: DispatcherServlet 流程、参数校验、消息转换、ProblemDetail 异常处理、拦截器、API 版本
---

# MVC

> **本篇目标**：理解 Spring MVC 处理一个请求的完整链路和每个组件的扩展方式，能用 `ProblemDetail` 写出标准的统一异常处理，正确处理 6.1+ 的方法参数校验，并在 Framework 7 / Jackson 3 下正确定制消息转换。
>
> **前置阅读**：[IoC 容器](./1_ioc)、[AOP](./2_aop)

> 参考资料：
> * Spring Framework 参考文档 - Spring Web MVC：[https://docs.spring.io/spring-framework/reference/web/webmvc.html](https://docs.spring.io/spring-framework/reference/web/webmvc.html)
> * 错误响应（RFC 9457）：[https://docs.spring.io/spring-framework/reference/web/webmvc/mvc-ann-rest-exceptions.html](https://docs.spring.io/spring-framework/reference/web/webmvc/mvc-ann-rest-exceptions.html)
> * 参数校验：[https://docs.spring.io/spring-framework/reference/web/webmvc/mvc-controller/ann-validation.html](https://docs.spring.io/spring-framework/reference/web/webmvc/mvc-controller/ann-validation.html)
> * 消息转换器配置：[https://docs.spring.io/spring-framework/reference/web/webmvc/mvc-config/message-converters.html](https://docs.spring.io/spring-framework/reference/web/webmvc/mvc-config/message-converters.html)
> * API 版本：[https://docs.spring.io/spring-framework/reference/web/webmvc/mvc-config/api-version.html](https://docs.spring.io/spring-framework/reference/web/webmvc/mvc-config/api-version.html)
> * Introducing Jackson 3 support in Spring：[https://spring.io/blog/2025/10/07/introducing-jackson-3-support-in-spring/](https://spring.io/blog/2025/10/07/introducing-jackson-3-support-in-spring/)

本篇讲 Spring MVC 的框架机制。Boot 下的 Web 开发实践（参数校验注解、分组与自定义校验、CORS、HTTP 客户端）见 [Web 开发](/spring-boot/2_web_dev)；响应式栈见 [WebFlux](./8_webflux)。Spring 6 起 Servlet API 全部是 `jakarta.servlet.*`，Framework 7 要求 Servlet 6.1（Jakarta EE 11），Boot 4 内嵌 Tomcat 或 Jetty（Undertow 已移除）。在 Boot 4 中引入 Spring MVC 的 starter 是 `spring-boot-starter-webmvc`（Boot 3.x 为 `spring-boot-starter-web`）。

---

## 一、DispatcherServlet 请求处理流程

### 1、处理流程

`DispatcherServlet` 是前端控制器，所有请求经它的 `doDispatch()` 分发：

![DispatcherServlet 请求处理流程](../assets/spring/spring-mvc-dispatcher-flow.svg)

1. 请求先经过 Servlet 容器中的 **Filter 链**（字符编码、CORS、Spring Security 都在这一层），再到达 `DispatcherServlet`
2. 遍历 `HandlerMapping` 找到处理器，返回 `HandlerExecutionChain`（处理器 + 匹配的拦截器）；找不到时返回 404
3. 按顺序执行拦截器的 `preHandle`，任一返回 `false` 则中断，并对已执行成功的拦截器回调 `afterCompletion`
4. `HandlerAdapter`（注解控制器对应 `RequestMappingHandlerAdapter`）用参数解析器绑定参数、执行校验，再反射调用 Controller 方法
5. 返回值处理器处理返回值：`@ResponseBody` / `ResponseEntity` 由 `HttpMessageConverter` 直接写入响应体；返回视图名则得到 `ModelAndView`
6. 逆序执行 `postHandle`。对 `@ResponseBody` 方法，响应体此时**已经写出**，在 `postHandle` 中改响应头或状态码不会生效，应改用 `ResponseBodyAdvice`
7. 有 `ModelAndView` 时由 `ViewResolver` 解析视图并渲染（REST 接口没有这一步）
8. 逆序执行 `afterCompletion`，无论成功还是异常都会回调，适合清理 `ThreadLocal`

第 2–6 步中抛出的异常（包括拦截器 `preHandle` 中的异常）交给 `HandlerExceptionResolver` 处理，见第五节。

### 2、核心组件

| 组件 | 职责 | 常用实现 / 扩展方式 |
|------|------|-------------------|
| `HandlerMapping` | 请求 → 处理器 | `RequestMappingHandlerMapping` 处理 `@RequestMapping` |
| `HandlerAdapter` | 执行不同类型的处理器 | `RequestMappingHandlerAdapter` |
| `HandlerMethodArgumentResolver` | 解析方法参数 | `@RequestParam`、`@RequestBody` 等内置解析器；自定义见第二节 |
| `HandlerMethodReturnValueHandler` | 处理返回值 | `RequestResponseBodyMethodProcessor` 处理 `@ResponseBody` |
| `HttpMessageConverter` | 请求体 / 响应体与 Java 对象互转 | Jackson JSON、String、ByteArray 等，见第四节 |
| `HandlerInterceptor` | 处理器执行前后的回调 | 登录态、上下文、审计，见第六节 |
| `HandlerExceptionResolver` | 把异常转换为响应 | `@ExceptionHandler`、`ResponseEntityExceptionHandler` |
| `ViewResolver` | 视图名 → 视图 | Thymeleaf 等模板引擎 |

### 3、Filter 与 HandlerInterceptor

| 对比 | Filter | HandlerInterceptor |
|------|--------|--------------------|
| 所属规范 | Servlet 规范，由容器调用 | Spring MVC，由 `DispatcherServlet` 调用 |
| 作用范围 | 所有请求，包括静态资源和 `/error` | 只拦截映射到处理器的请求 |
| 能拿到的信息 | 原始 `ServletRequest` / `ServletResponse` | 还能拿到处理器（`HandlerMethod`），可读取方法上的注解 |
| 异常处理 | 抛出的异常**不会**进入 `@RestControllerAdvice` | 抛出的异常由 `HandlerExceptionResolver` 统一处理 |
| 典型用途 | 编码、CORS、安全认证、请求日志、包装请求体 | 登录态、用户上下文、按注解做权限或幂等检查 |

---

## 二、请求映射与参数解析

### 1、Controller 示例

```java
@RestController
@RequestMapping("/api/users")
@RequiredArgsConstructor
public class UserController {          // 不要在类上加 @Validated，见第三节

    private final UserService userService;

    @GetMapping
    public PageResult<UserVO> list(@RequestParam(defaultValue = "0") @Min(0) int page,
                                   @RequestParam(defaultValue = "20") @Min(1) @Max(100) int size,
                                   @RequestParam(required = false) String keyword) {
        return userService.list(page, size, keyword);   // 页码从 0 开始，与 Spring Data 一致
    }

    @GetMapping("/{id}")
    public UserVO get(@PathVariable @Positive Long id) {
        return userService.getById(id);
    }

    @PostMapping
    public ResponseEntity<UserVO> create(@RequestBody @Valid UserCreateDTO dto,
                                         UriComponentsBuilder uriBuilder) {
        UserVO created = userService.create(dto);
        URI location = uriBuilder.path("/api/users/{id}").buildAndExpand(created.id()).toUri();
        return ResponseEntity.created(location).body(created);   // 201 + Location
    }

    @DeleteMapping("/{id}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    public void delete(@PathVariable Long id) {
        userService.delete(id);
    }

    @GetMapping("/me")
    public UserVO me(@CurrentUser Long userId) {     // 自定义参数解析器注入
        return userService.getById(userId);
    }
}

public record PageResult<T>(List<T> items, long total, int page, int size) {}
```

分页结果用自定义的 `PageResult` 而不是直接返回 Spring Data 的 `Page`：Spring Data 3.3 起直接序列化 `PageImpl` 会打印警告，因为它的 JSON 结构不保证稳定。使用 Spring Data 时也可以开启 `@EnableSpringDataWebSupport(pageSerializationMode = VIA_DTO)`，统一输出稳定的 `PagedModel` 结构。

### 2、常用注解

| 注解 | 说明 |
|------|------|
| `@RequestMapping` / `@GetMapping` 等 | 映射路径、方法、`consumes` / `produces`，Framework 7 起还可声明 `version` |
| `@PathVariable` | 路径变量 |
| `@RequestParam` | 查询参数或表单字段，`required = false` 或 `defaultValue` 表示可选 |
| `@RequestBody` | 请求体，经 `HttpMessageConverter` 反序列化 |
| `@RequestHeader` / `@CookieValue` | 请求头 / Cookie |
| `@ModelAttribute` | 把查询参数或表单字段绑定到对象 |
| `@ResponseStatus` | 指定成功响应的状态码，或标注在异常类上 |
| `@RestController` | `@Controller` + `@ResponseBody` |
| `@ExceptionHandler` / `@RestControllerAdvice` | 局部 / 全局异常处理 |

### 3、自定义参数解析器

把「从请求中取当前用户」这类重复逻辑收敛到参数解析器，Controller 只声明参数：

```java
@Target(ElementType.PARAMETER)
@Retention(RetentionPolicy.RUNTIME)
public @interface CurrentUser {}

public class CurrentUserArgumentResolver implements HandlerMethodArgumentResolver {

    @Override
    public boolean supportsParameter(MethodParameter parameter) {
        return parameter.hasParameterAnnotation(CurrentUser.class)
                && Long.class.equals(parameter.getParameterType());
    }

    @Override
    public Object resolveArgument(MethodParameter parameter, ModelAndViewContainer mavContainer,
                                  NativeWebRequest webRequest, WebDataBinderFactory binderFactory) {
        Long userId = UserContextHolder.currentUserId();   // 由拦截器写入，见第六节
        if (userId == null) {
            throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "未登录");
        }
        return userId;
    }
}
```

注册方式见第六节的 `WebConfig#addArgumentResolvers`。使用 Spring Security 时直接用它的 `@AuthenticationPrincipal`。

---

## 三、参数校验

Spring MVC 有两级校验，抛出的异常不同，**两种都要处理**：

| 触发条件 | 校验方式 | 失败异常 |
|----------|----------|----------|
| 只有 `@RequestBody` / `@ModelAttribute` 参数标了 `@Valid` | 逐个参数校验 | `MethodArgumentNotValidException` |
| 方法参数上直接写约束（如 `@PathVariable @Positive`、`@RequestParam @Max`），或返回值有约束 | 6.1 起的**内置方法校验**，一次校验全部参数，同时覆盖 `@Valid` 对象 | `HandlerMethodValidationException` |

Framework 6.1（Boot 3.2）之前，`@PathVariable` / `@RequestParam` 上的约束需要在 Controller 类上加 `@Validated`，靠 AOP 的 `MethodValidationPostProcessor` 生效，失败时抛 `jakarta.validation.ConstraintViolationException`。**6.1 起应去掉 Controller 类上的 `@Validated`**，否则方法校验走 AOP 代理而不是内置支持，抛出的异常类型变成 `ConstraintViolationException`，`ResponseEntityExceptionHandler` 不处理它，会落入兜底的 500。`@Validated` 留给 Service 层的方法校验和分组校验。

两种异常的处理代码见第五节。校验注解、嵌套校验、分组校验和自定义约束见 [Web 开发](/spring-boot/2_web_dev)。

---

## 四、消息转换

### 1、转换器的选择

读请求体时，按请求的 `Content-Type` 和参数类型找第一个能读的 `HttpMessageConverter`；写响应体时，按请求的 `Accept`、方法的 `produces` 和返回值类型协商出媒体类型，再找能写的转换器。找不到时分别返回 415（Unsupported Media Type）和 406（Not Acceptable）。返回 `String` 时会被 `StringHttpMessageConverter` 抢先处理，统一包装返回值时要注意这一点。

### 2、Jackson 3 与 Boot 4

Framework 7 / Boot 4 默认使用 Jackson 3（包名 `tools.jackson`，注解包 `com.fasterxml.jackson.annotation` 不变），对应的转换器是 `JacksonJsonHttpMessageConverter`；Jackson 2 的 `MappingJackson2HttpMessageConverter` 已废弃。Jackson 3 内置 Java 时间类型支持，且默认不再把日期写成时间戳，不需要再手动注册 `JavaTimeModule`。

在 Boot 中**不要自己 new 一个 Mapper 塞进转换器**，那会绕过 Boot 自动配置的 Mapper，`spring.jackson.*` 配置和自动注册的模块全部失效。按优先级用以下方式定制：

```yaml
spring:
  jackson:
    time-zone: Asia/Shanghai
    default-property-inclusion: non_null
```

```java
import org.springframework.boot.jackson.autoconfigure.JsonMapperBuilderCustomizer;
import tools.jackson.databind.DeserializationFeature;

@Configuration(proxyBeanMethods = false)
public class JacksonConfig {

    // Boot 4：在自动配置的 JsonMapper 上追加定制
    @Bean
    JsonMapperBuilderCustomizer jsonCustomizer() {
        return builder -> builder.disable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES);
    }
}
```

Boot 3.x（Jackson 2）对应的是 `Jackson2ObjectMapperBuilderCustomizer`。从 Boot 3 升级时，Jackson 3 的部分默认值不同，可以先设 `spring.jackson.use-jackson2-defaults=true` 过渡，迁移细节见 [Spring Boot 版本演进](/spring-boot/11_versions)。

### 3、Framework 7 的转换器配置 API

不使用 Boot、或确实需要替换转换器时，Framework 7 提供基于构建器的新 API；旧的 `configureMessageConverters(List)` 与 `extendMessageConverters(List)` 已废弃并计划移除：

```java
@Configuration
public class WebConverterConfig implements WebMvcConfigurer {

    @Override
    public void configureMessageConverters(HttpMessageConverters.ServerBuilder builder) {
        JsonMapper jsonMapper = JsonMapper.builder()
                .findAndAddModules()
                .disable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES)
                .build();
        builder.withJsonConverter(new JacksonJsonHttpMessageConverter(jsonMapper));
    }
}
```

---

## 五、统一异常处理

### 1、异常处理链

`DispatcherServlet` 默认按顺序尝试三个 `HandlerExceptionResolver`：

| 顺序 | 解析器 | 处理什么 |
|------|--------|----------|
| 1 | `ExceptionHandlerExceptionResolver` | `@ExceptionHandler` 方法，先找 Controller 内的，再找 `@ControllerAdvice` |
| 2 | `ResponseStatusExceptionResolver` | 标了 `@ResponseStatus` 的异常、`ResponseStatusException` |
| 3 | `DefaultHandlerExceptionResolver` | Spring MVC 内置异常（405、415、400 等）转换为状态码 |

都处理不了的异常会抛给 Servlet 容器，Boot 将其转发到 `/error`，由 `BasicErrorController` 输出错误响应。Filter 中抛出的异常、Spring Security 的认证 / 授权失败（由 `AuthenticationEntryPoint` / `AccessDeniedHandler` 处理）不经过上面这条链，`@RestControllerAdvice` 管不到。

### 2、ProblemDetail：推荐的错误响应格式

Framework 6.0 起支持 RFC 9457（原 RFC 7807）Problem Details，响应类型为 `application/problem+json`：

```json
{
  "type": "about:blank",
  "title": "Not Found",
  "status": 404,
  "detail": "订单不存在: 1001",
  "instance": "/api/orders/1001",
  "code": "ORDER_NOT_FOUND"
}
```

相关类型：

- `ProblemDetail`：错误体，标准字段之外的扩展字段放进 `properties`，Jackson 序列化时展开为顶层字段
- `ErrorResponse` / `ErrorResponseException`：携带状态码、响应头和 `ProblemDetail` 的异常契约，Spring MVC 的内置异常都实现了它
- `ResponseEntityExceptionHandler`：处理全部 Spring MVC 内置异常并输出 `ProblemDetail` 的基类

Boot 中设置 `spring.mvc.problemdetails.enabled=true` 会自动注册一个 `ResponseEntityExceptionHandler`，前提是容器里没有其他该类型的 Bean。生产项目通常自己继承它，在同一个类中处理业务异常：

```java
@Getter
public class BizException extends RuntimeException {

    private final ErrorCode errorCode;

    public BizException(ErrorCode errorCode, String detail) {
        super(detail);
        this.errorCode = errorCode;
    }
}

@Getter
@RequiredArgsConstructor
public enum ErrorCode {
    ORDER_NOT_FOUND(HttpStatus.NOT_FOUND, "订单不存在"),
    STOCK_NOT_ENOUGH(HttpStatus.CONFLICT, "库存不足"),
    PARAM_INVALID(HttpStatus.BAD_REQUEST, "参数校验失败");

    private final HttpStatus status;
    private final String title;
}

@Slf4j
@RestControllerAdvice
public class GlobalExceptionHandler extends ResponseEntityExceptionHandler {

    // 业务异常：状态码与错误码来自枚举
    @ExceptionHandler(BizException.class)
    public ProblemDetail handleBiz(BizException ex) {
        ErrorCode code = ex.getErrorCode();
        ProblemDetail pd = ProblemDetail.forStatusAndDetail(code.getStatus(), ex.getMessage());
        pd.setTitle(code.getTitle());
        pd.setProperty("code", code.name());
        return pd;
    }

    // @RequestBody @Valid 校验失败：覆写父类方法，不能再写 @ExceptionHandler，否则映射重复启动失败
    @Override
    protected ResponseEntity<Object> handleMethodArgumentNotValid(
            MethodArgumentNotValidException ex, HttpHeaders headers,
            HttpStatusCode status, WebRequest request) {
        Map<String, String> errors = ex.getBindingResult().getFieldErrors().stream()
                .collect(Collectors.toMap(
                        FieldError::getField,
                        fe -> Objects.requireNonNullElse(fe.getDefaultMessage(), "invalid"),
                        (first, second) -> first,          // 同一字段多个约束失败时保留第一条，避免 Duplicate key
                        LinkedHashMap::new));
        ProblemDetail body = ex.getBody();
        body.setDetail(ErrorCode.PARAM_INVALID.getTitle());
        body.setProperty("code", ErrorCode.PARAM_INVALID.name());
        body.setProperty("errors", errors);
        return handleExceptionInternal(ex, body, headers, status, request);
    }

    // 6.1+ 内置方法校验失败（路径 / 查询参数上的约束）
    @Override
    protected ResponseEntity<Object> handleHandlerMethodValidationException(
            HandlerMethodValidationException ex, HttpHeaders headers,
            HttpStatusCode status, WebRequest request) {
        List<String> errors = ex.getAllErrors().stream()
                .map(MessageSourceResolvable::getDefaultMessage)
                .toList();
        ProblemDetail body = ex.getBody();
        body.setDetail(ErrorCode.PARAM_INVALID.getTitle());
        body.setProperty("code", ErrorCode.PARAM_INVALID.name());
        body.setProperty("errors", errors);
        return handleExceptionInternal(ex, body, headers, status, request);
    }

    // Service 层 @Validated 方法校验失败
    @ExceptionHandler(ConstraintViolationException.class)
    public ProblemDetail handleConstraintViolation(ConstraintViolationException ex) {
        ProblemDetail pd = ProblemDetail.forStatusAndDetail(HttpStatus.BAD_REQUEST, ErrorCode.PARAM_INVALID.getTitle());
        pd.setProperty("code", ErrorCode.PARAM_INVALID.name());
        pd.setProperty("errors", ex.getConstraintViolations().stream()
                .map(ConstraintViolation::getMessage)
                .toList());
        return pd;
    }

    // 兜底：记录完整堆栈，对外只返回通用信息，不泄露内部细节
    @ExceptionHandler(Exception.class)
    public ProblemDetail handleUnknown(Exception ex) throws Exception {
        if (ex instanceof AccessDeniedException || ex instanceof AuthenticationException) {
            throw ex;                                  // 交还给 Spring Security 处理成 401 / 403
        }
        log.error("未处理的异常", ex);
        return ProblemDetail.forStatusAndDetail(HttpStatus.INTERNAL_SERVER_ERROR, "服务器内部错误");
    }
}
```

几点说明：

- `ConstraintViolationException`、`ConstraintViolation` 来自 `jakarta.validation`；`AccessDeniedException`、`AuthenticationException` 来自 Spring Security，未使用时删掉这段判断
- `@ExceptionHandler` 的匹配按异常继承层次取最近的，所以兜底的 `Exception` 不会抢走父类中更具体的 Spring MVC 异常映射
- `title`、`detail` 支持国际化：`ResponseEntityExceptionHandler` 按 `problemDetail.title.<异常全限定名>` 等消息码从 `MessageSource` 解析
- 异常也可以直接继承 `ErrorResponseException`，此时无需写 `@ExceptionHandler`，父类会统一渲染

### 3、仍要统一包装 Result 时

很多团队约定所有接口返回 `{code, message, data}`，并对业务异常返回 HTTP 200 + 业务码。这样前端处理统一，但 HTTP 状态码失去语义：网关、监控、重试策略都无法从状态码区分成功与失败，告警只能依赖解析响应体。新项目推荐「成功直接返回数据、失败返回 4xx / 5xx + ProblemDetail」；已有约定的项目至少应让校验失败、未认证、服务器错误返回正确的状态码：

```java
public record Result<T>(String code, String message, T data) {

    public static <T> Result<T> ok(T data) {
        return new Result<>("OK", "success", data);
    }

    public static <T> Result<T> fail(String code, String message, T data) {
        return new Result<>(code, message, data);
    }
}

@RestControllerAdvice
public class ResultExceptionHandler {

    @ExceptionHandler(MethodArgumentNotValidException.class)
    @ResponseStatus(HttpStatus.BAD_REQUEST)
    public Result<Map<String, String>> handleValidation(MethodArgumentNotValidException ex) {
        Map<String, String> errors = ex.getBindingResult().getFieldErrors().stream()
                .collect(Collectors.toMap(
                        FieldError::getField,
                        fe -> Objects.requireNonNullElse(fe.getDefaultMessage(), "invalid"),
                        (first, second) -> first,
                        LinkedHashMap::new));
        return Result.fail("PARAM_INVALID", "参数校验失败", errors);   // 把字段错误带回去
    }
}
```

---

## 六、拦截器

拦截器适合做依赖处理器信息的事情，例如读取当前用户写入上下文。下面的示例只演示拦截器 API，生产中的认证应交给 Spring Security（见 [Security](./9_security)）：

```java
public final class UserContextHolder {

    private static final ThreadLocal<Long> USER_ID = new ThreadLocal<>();

    private UserContextHolder() {}

    public static void set(Long userId) { USER_ID.set(userId); }
    public static Long currentUserId() { return USER_ID.get(); }
    public static void clear() { USER_ID.remove(); }
}

@Component
@RequiredArgsConstructor
public class UserContextInterceptor implements HandlerInterceptor {

    private final TokenService tokenService;   // 项目内的令牌解析服务

    @Override
    public boolean preHandle(HttpServletRequest request, HttpServletResponse response, Object handler) {
        String header = request.getHeader(HttpHeaders.AUTHORIZATION);
        if (header == null || !header.startsWith("Bearer ")) {
            // 抛异常交给统一异常处理输出 ProblemDetail，避免手写 JSON（手写时必须设置 application/json;charset=UTF-8）
            throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "请先登录");
        }
        UserContextHolder.set(tokenService.parseUserId(header.substring(7)));
        return true;
    }

    @Override
    public void afterCompletion(HttpServletRequest request, HttpServletResponse response,
                                Object handler, Exception ex) {
        UserContextHolder.clear();   // 线程会被复用，必须清理
    }
}

@Configuration
@RequiredArgsConstructor
public class WebConfig implements WebMvcConfigurer {

    private final UserContextInterceptor userContextInterceptor;

    @Override
    public void addInterceptors(InterceptorRegistry registry) {
        registry.addInterceptor(userContextInterceptor)
                .addPathPatterns("/api/**")
                .excludePathPatterns("/api/auth/**");   // 白名单只在这里维护一处
    }

    @Override
    public void addArgumentResolvers(List<HandlerMethodArgumentResolver> resolvers) {
        resolvers.add(new CurrentUserArgumentResolver());
    }
}
```

异步请求（返回 `Callable`、`DeferredResult`）时，`preHandle` 与 `afterCompletion` 不在同一线程执行，需要实现 `AsyncHandlerInterceptor`。`@Async` 等跨线程场景中 `ThreadLocal` 上下文不会自动传递。

---

## 七、API 版本控制

Framework 7 在 Spring MVC 和 WebFlux 中内置 API 版本控制，版本可以从请求头、查询参数、路径段或媒体类型参数中解析：

```java
@Configuration
public class ApiVersionConfig implements WebMvcConfigurer {

    @Override
    public void configureApiVersioning(ApiVersionConfigurer configurer) {
        configurer.useRequestHeader("API-Version");
    }
}

@RestController
@RequestMapping("/api/accounts")
public class AccountController {

    @GetMapping(path = "/{id}", version = "1.1")
    public AccountV1 getV1(@PathVariable Long id) { /* ... */ }

    @GetMapping(path = "/{id}", version = "1.2+")   // 1.2 及以上
    public AccountV2 getV2(@PathVariable Long id) { /* ... */ }
}
```

请求的版本不受支持时抛 `InvalidApiVersionException`，启用后缺少版本时抛 `MissingApiVersionException`，两者都返回 400；`ApiVersionDeprecationHandler` 可以按 RFC 9745 / RFC 8594 为废弃版本输出 `Deprecation`、`Sunset` 响应头。Boot 4 的 `spring.mvc.apiversion.*` 配置见 [Spring Boot 版本演进](/spring-boot/11_versions)。

---

## 小结

- 请求链路：Filter → `DispatcherServlet` → `HandlerMapping` 得到 `HandlerExecutionChain` → `preHandle` → `HandlerAdapter`（参数解析、校验、调用）→ 返回值处理 / 消息转换 → `postHandle` → 视图渲染 → `afterCompletion`
- Filter 属于 Servlet 容器，异常不进 `@RestControllerAdvice`；拦截器能拿到 `HandlerMethod`，`@ResponseBody` 方法在 `postHandle` 时响应已写出
- 6.1+ 去掉 Controller 类上的 `@Validated`，同时处理 `MethodArgumentNotValidException` 和 `HandlerMethodValidationException`；`toMap` 收集字段错误要提供合并函数
- Framework 7 / Boot 4 默认 Jackson 3，转换器为 `JacksonJsonHttpMessageConverter`；Boot 中用 `spring.jackson.*` 或 `JsonMapperBuilderCustomizer` 定制，不要自己 new Mapper；纯 Spring 用 `configureMessageConverters(HttpMessageConverters.ServerBuilder)`
- 统一异常处理推荐继承 `ResponseEntityExceptionHandler` 输出 `ProblemDetail`，校验异常覆写父类方法，兜底异常不泄露内部信息
- Framework 7 内置 API 版本控制，`@GetMapping(version = "1.2+")` 声明版本

> 下一篇：[事务管理](./4_transaction) —— Web 层之下，看 `@Transactional` 如何通过 AOP 管理事务边界，以及传播行为与失效场景。
