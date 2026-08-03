# Web 开发

> 参考资料：
> * Spring MVC 文档：[https://docs.spring.io/spring-framework/docs/current/reference/html/web.html](https://docs.spring.io/spring-framework/docs/current/reference/html/web.html)
> * Bean Validation：[https://beanvalidation.org/](https://beanvalidation.org/)

## 一、Controller 与路由

### 1.1 常用参数绑定

```java
@RestController
@RequestMapping("/api/orders")
@RequiredArgsConstructor
public class OrderController {

    private final OrderService orderService;

    // 查询参数：?status=PENDING&page=1&size=20
    @GetMapping
    public Result<Page<OrderVO>> list(
            @RequestParam(required = false) String status,
            @RequestParam(defaultValue = "1") int page,
            @RequestParam(defaultValue = "20") int size) {
        return Result.ok(orderService.list(status, page, size));
    }

    // 路径变量：/api/orders/123
    @GetMapping("/{id}")
    public Result<OrderVO> getById(@PathVariable Long id) {
        return Result.ok(orderService.getById(id));
    }

    // 请求体（JSON → 对象）
    @PostMapping
    public Result<OrderVO> create(@RequestBody @Valid OrderCreateDTO dto) {
        return Result.ok(orderService.create(dto));
    }

    // 请求头
    @GetMapping("/export")
    public ResponseEntity<byte[]> export(
            @RequestHeader("Accept-Language") String lang,
            @RequestParam String format) {
        byte[] data = orderService.export(format);
        return ResponseEntity.ok()
            .header("Content-Disposition", "attachment; filename=orders." + format)
            .contentType(MediaType.APPLICATION_OCTET_STREAM)
            .body(data);
    }

    // 表单 + 文件上传
    @PostMapping("/import")
    public Result<Integer> importOrders(@RequestParam MultipartFile file,
                                         @RequestParam String type) {
        return Result.ok(orderService.importFromFile(file, type));
    }
}
```

### 1.2 ResponseEntity 精细控制

```java
@GetMapping("/{id}")
public ResponseEntity<OrderVO> getById(@PathVariable Long id) {
    return orderService.findById(id)
        .map(ResponseEntity::ok)
        .orElse(ResponseEntity.notFound().build());
}

@PostMapping
public ResponseEntity<OrderVO> create(@RequestBody @Valid OrderCreateDTO dto) {
    OrderVO order = orderService.create(dto);
    URI location = URI.create("/api/orders/" + order.getId());
    return ResponseEntity.created(location).body(order);
}
```

---

## 二、参数校验

### 2.1 常用注解

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
}
```

```java
// Controller 中加 @Valid 触发校验
@PostMapping
public Result<UserVO> create(@RequestBody @Valid UserCreateDTO dto) { ... }

// 路径参数 / 查询参数校验需在类上加 @Validated
@RestController
@Validated
public class UserController {

    @GetMapping("/{id}")
    public Result<UserVO> getById(@PathVariable @Positive(message = "ID 必须为正数") Long id) { ... }
}
```

### 2.2 分组校验

```java
// 定义分组接口
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

// 使用分组
@PostMapping
public Result<UserVO> create(@RequestBody @Validated(CreateGroup.class) UserDTO dto) { ... }

@PutMapping
public Result<UserVO> update(@RequestBody @Validated(UpdateGroup.class) UserDTO dto) { ... }
```

### 2.3 自定义校验注解

```java
// 1. 定义注解
@Target({ElementType.FIELD, ElementType.PARAMETER})
@Retention(RetentionPolicy.RUNTIME)
@Constraint(validatedBy = PhoneValidator.class)
public @interface Phone {
    String message() default "手机号格式不正确";
    Class<?>[] groups() default {};
    Class<? extends Payload>[] payload() default {};
}

// 2. 实现校验逻辑
public class PhoneValidator implements ConstraintValidator<Phone, String> {

    private static final Pattern PHONE_PATTERN = Pattern.compile("^1[3-9]\\d{9}$");

    @Override
    public boolean isValid(String value, ConstraintValidatorContext context) {
        if (value == null) return true;   // null 由 @NotNull 处理
        return PHONE_PATTERN.matcher(value).matches();
    }
}

// 3. 使用
public class UserCreateDTO {
    @Phone
    private String phone;
}
```

---

## 三、统一异常处理

```java
@RestControllerAdvice
@Slf4j
public class GlobalExceptionHandler {

    // Bean Validation 失败
    @ExceptionHandler(MethodArgumentNotValidException.class)
    @ResponseStatus(HttpStatus.BAD_REQUEST)
    public Result<Map<String, String>> handleValidation(MethodArgumentNotValidException e) {
        Map<String, String> errors = e.getBindingResult().getFieldErrors().stream()
            .collect(Collectors.toMap(
                FieldError::getField,
                fe -> Objects.requireNonNullElse(fe.getDefaultMessage(), "invalid"),
                (a, b) -> a  // 同一字段取第一个错误
            ));
        return Result.fail(400, "参数校验失败", errors);
    }

    // @Validated 路径/查询参数校验失败
    @ExceptionHandler(ConstraintViolationException.class)
    @ResponseStatus(HttpStatus.BAD_REQUEST)
    public Result<String> handleConstraint(ConstraintViolationException e) {
        String message = e.getConstraintViolations().stream()
            .map(ConstraintViolation::getMessage)
            .collect(Collectors.joining("; "));
        return Result.fail(400, message);
    }

    // JSON 解析失败
    @ExceptionHandler(HttpMessageNotReadableException.class)
    @ResponseStatus(HttpStatus.BAD_REQUEST)
    public Result<Void> handleJsonParse(HttpMessageNotReadableException e) {
        return Result.fail(400, "请求体格式错误");
    }

    // 业务异常
    @ExceptionHandler(BusinessException.class)
    public ResponseEntity<Result<Void>> handleBusiness(BusinessException e) {
        log.warn("业务异常: code={} msg={}", e.getCode(), e.getMessage());
        return ResponseEntity
            .status(e.getHttpStatus())
            .body(Result.fail(e.getCode(), e.getMessage()));
    }

    // 资源不存在
    @ExceptionHandler(EntityNotFoundException.class)
    @ResponseStatus(HttpStatus.NOT_FOUND)
    public Result<Void> handleNotFound(EntityNotFoundException e) {
        return Result.fail(404, e.getMessage());
    }

    // 兜底
    @ExceptionHandler(Exception.class)
    @ResponseStatus(HttpStatus.INTERNAL_SERVER_ERROR)
    public Result<Void> handleAll(Exception e, HttpServletRequest req) {
        log.error("未知异常 URI={}", req.getRequestURI(), e);
        return Result.fail(500, "服务器内部错误");
    }
}
```

---

## 四、拦截器与过滤器

| 对比 | Filter | Interceptor |
|------|--------|-------------|
| 规范 | Servlet 规范 | Spring MVC |
| 作用范围 | 所有请求 | DispatcherServlet 之后 |
| 获取 Spring Bean | 不方便 | 方便 |
| 典型场景 | 跨域、日志、压缩 | 登录校验、权限、接口耗时 |

```java
// 过滤器（适合全局 HTTP 层面处理）
@Component
@Order(1)
public class RequestLoggingFilter extends OncePerRequestFilter {

    @Override
    protected void doFilterInternal(HttpServletRequest req, HttpServletResponse res,
                                    FilterChain chain) throws ServletException, IOException {
        long start = System.currentTimeMillis();
        chain.doFilter(req, res);
        log.info("{} {} → {} ({}ms)", req.getMethod(), req.getRequestURI(),
            res.getStatus(), System.currentTimeMillis() - start);
    }
}
```

---

## 五、CORS 跨域配置

### 5.1 三种配置方式

```java
// 方式一：注解（单接口）
@CrossOrigin(origins = "https://example.com")
@GetMapping("/api/data")
public Result<Object> getData() { ... }

// 方式二：全局配置（推荐）
@Configuration
public class CorsConfig implements WebMvcConfigurer {
    @Override
    public void addCorsMappings(CorsRegistry registry) {
        registry.addMapping("/**")
                .allowedOriginPatterns("*")
                .allowedMethods("GET", "POST", "PUT", "DELETE", "OPTIONS")
                .allowedHeaders("*")
                .allowCredentials(true)
                .maxAge(3600);
    }
}
```

### 5.2 Spring Security 项目

```java
// Security 配置中必须显式开启 CORS，否则全局配置不生效
@Bean
public SecurityFilterChain filterChain(HttpSecurity http) throws Exception {
    return http
        .cors(cors -> cors.configurationSource(corsConfigurationSource()))
        // ...
        .build();
}

@Bean
public CorsConfigurationSource corsConfigurationSource() {
    CorsConfiguration config = new CorsConfiguration();
    config.setAllowedOriginPatterns(List.of("*"));
    config.setAllowedMethods(List.of("GET","POST","PUT","DELETE","OPTIONS"));
    config.setAllowedHeaders(List.of("*"));
    config.setAllowCredentials(true);
    UrlBasedCorsConfigurationSource source = new UrlBasedCorsConfigurationSource();
    source.registerCorsConfiguration("/**", config);
    return source;
}
```

> **常见坑**：携带 Cookie 时 `allowedOrigins` 不能用 `*`，必须换成 `allowedOriginPatterns`。
