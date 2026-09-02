# MVC

> 参考资料：
> * Spring 官方文档 - MVC：[https://docs.spring.io/spring-framework/reference/web/webmvc.html](https://docs.spring.io/spring-framework/reference/web/webmvc.html)
> * DispatcherServlet 源码分析：[https://www.baeldung.com/spring-dispatcherservlet](https://www.baeldung.com/spring-dispatcherservlet)

## 一、DispatcherServlet 请求处理流程

```
请求 → DispatcherServlet
  → HandlerMapping  查找对应 Handler（Controller 方法）
  → HandlerAdapter  执行 Handler
    → 参数解析（HandlerMethodArgumentResolver）
    → 调用 Controller 方法
    → 返回值处理（HandlerMethodReturnValueHandler）
  → ViewResolver     解析视图（REST 接口直接写响应体）
  → 响应
```

| 组件 | 作用 |
|------|------|
| `HandlerMapping` | 请求 URL → Handler 的映射关系 |
| `HandlerAdapter` | 适配不同类型的 Handler 执行 |
| `HandlerMethodArgumentResolver` | 解析方法参数（@RequestParam / @RequestBody 等） |
| `HttpMessageConverter` | 请求体 / 响应体的序列化与反序列化 |
| `HandlerExceptionResolver` | 统一异常处理 |

---

## 二、Controller 完整示例

```java
@RestController
@RequestMapping("/api/users")
@RequiredArgsConstructor
@Validated
public class UserController {

    private final UserService userService;

    // 查询列表（分页）
    @GetMapping
    public Result<Page<UserVO>> list(
            @RequestParam(defaultValue = "1") int page,
            @RequestParam(defaultValue = "20") int size,
            @RequestParam(required = false) String keyword) {
        return Result.ok(userService.list(page, size, keyword));
    }

    // 查询单个
    @GetMapping("/{id}")
    public Result<UserVO> getById(@PathVariable @Positive Long id) {
        return Result.ok(userService.getById(id));
    }

    // 创建
    @PostMapping
    @ResponseStatus(HttpStatus.CREATED)
    public Result<UserVO> create(@RequestBody @Valid UserCreateDTO dto) {
        return Result.ok(userService.create(dto));
    }

    // 更新
    @PutMapping("/{id}")
    public Result<UserVO> update(@PathVariable Long id,
                                  @RequestBody @Valid UserUpdateDTO dto) {
        return Result.ok(userService.update(id, dto));
    }

    // 删除
    @DeleteMapping("/{id}")
    public Result<Void> delete(@PathVariable Long id) {
        userService.delete(id);
        return Result.ok();
    }

    // 文件上传
    @PostMapping("/avatar")
    public Result<String> uploadAvatar(@RequestParam MultipartFile file) {
        String url = userService.uploadAvatar(file);
        return Result.ok(url);
    }

    // 获取当前登录用户信息（从 Header / Token 解析）
    @GetMapping("/me")
    public Result<UserVO> me(@RequestHeader("Authorization") String token) {
        return Result.ok(userService.getCurrentUser(token));
    }
}
```

---

## 三、统一返回结构

```java
@Data
@NoArgsConstructor
@AllArgsConstructor
public class Result<T> {

    private int code;
    private String message;
    private T data;

    public static <T> Result<T> ok(T data) {
        return new Result<>(200, "success", data);
    }

    public static <T> Result<T> ok() {
        return new Result<>(200, "success", null);
    }

    public static <T> Result<T> fail(int code, String message) {
        return new Result<>(code, message, null);
    }

    public static <T> Result<T> fail(ResultCode resultCode) {
        return new Result<>(resultCode.getCode(), resultCode.getMessage(), null);
    }
}
```

---

## 四、统一异常处理

```java
@RestControllerAdvice
@Slf4j
public class GlobalExceptionHandler {

    // 参数校验失败（@Valid 触发）
    @ExceptionHandler(MethodArgumentNotValidException.class)
    @ResponseStatus(HttpStatus.BAD_REQUEST)
    public Result<Map<String, String>> handleValidation(MethodArgumentNotValidException e) {
        Map<String, String> errors = e.getBindingResult().getFieldErrors().stream()
            .collect(Collectors.toMap(
                FieldError::getField,
                fe -> fe.getDefaultMessage() != null ? fe.getDefaultMessage() : "invalid"
            ));
        return Result.fail(400, "参数校验失败");
    }

    // 业务异常
    @ExceptionHandler(BusinessException.class)
    @ResponseStatus(HttpStatus.OK)
    public Result<Void> handleBusiness(BusinessException e) {
        log.warn("业务异常: {}", e.getMessage());
        return Result.fail(e.getCode(), e.getMessage());
    }

    // 资源不存在
    @ExceptionHandler(EntityNotFoundException.class)
    @ResponseStatus(HttpStatus.NOT_FOUND)
    public Result<Void> handleNotFound(EntityNotFoundException e) {
        return Result.fail(404, e.getMessage());
    }

    // 兜底异常
    @ExceptionHandler(Exception.class)
    @ResponseStatus(HttpStatus.INTERNAL_SERVER_ERROR)
    public Result<Void> handleAll(Exception e) {
        log.error("未知异常", e);
        return Result.fail(500, "服务器内部错误");
    }
}
```

---

## 五、拦截器实现

```java
// 登录鉴权拦截器
@Component
@RequiredArgsConstructor
@Slf4j
public class AuthInterceptor implements HandlerInterceptor {

    private final JwtUtil jwtUtil;
    private final Set<String> whiteList = Set.of("/api/auth/login", "/api/auth/register");

    @Override
    public boolean preHandle(HttpServletRequest request,
                             HttpServletResponse response,
                             Object handler) throws Exception {
        String uri = request.getRequestURI();
        if (whiteList.contains(uri)) {
            return true;
        }

        String token = request.getHeader("Authorization");
        if (token == null || !token.startsWith("Bearer ")) {
            response.setStatus(HttpStatus.UNAUTHORIZED.value());
            response.getWriter().write("{\"code\":401,\"message\":\"请先登录\"}");
            return false;
        }

        try {
            Long userId = jwtUtil.parseUserId(token.substring(7));
            request.setAttribute("userId", userId);
            return true;
        } catch (JwtException e) {
            response.setStatus(HttpStatus.UNAUTHORIZED.value());
            return false;
        }
    }

    @Override
    public void afterCompletion(HttpServletRequest request,
                                HttpServletResponse response,
                                Object handler, Exception ex) {
        // 清理 ThreadLocal 等资源
    }
}

// 注册拦截器
@Configuration
@RequiredArgsConstructor
public class WebConfig implements WebMvcConfigurer {

    private final AuthInterceptor authInterceptor;

    @Override
    public void addInterceptors(InterceptorRegistry registry) {
        registry.addInterceptor(authInterceptor)
                .addPathPatterns("/api/**")
                .excludePathPatterns("/api/auth/**", "/swagger-ui/**");
    }

    // 配置消息转换器（日期格式等）
    @Override
    public void configureMessageConverters(List<HttpMessageConverter<?>> converters) {
        converters.add(0, new MappingJackson2HttpMessageConverter(objectMapper()));
    }

    private ObjectMapper objectMapper() {
        return new ObjectMapper()
            .registerModule(new JavaTimeModule())
            .disable(SerializationFeature.WRITE_DATES_AS_TIMESTAMPS);
    }
}
```

---

## 六、常用注解速查

| 注解 | 说明 |
|------|------|
| `@RequestMapping` | 映射请求路径，可细化为 @GetMapping / @PostMapping 等 |
| `@RequestParam` | 获取查询参数，`required=false` 可选 |
| `@PathVariable` | 获取路径变量 |
| `@RequestBody` | 获取请求体（JSON → 对象） |
| `@RequestHeader` | 获取请求头 |
| `@ResponseBody` | 返回值直接写入响应体 |
| `@RestController` | = @Controller + @ResponseBody |
| `@ResponseStatus` | 指定响应状态码 |
| `@ExceptionHandler` | 方法级别异常处理 |
| `@ControllerAdvice` | 全局异常处理 / 全局数据绑定 |
