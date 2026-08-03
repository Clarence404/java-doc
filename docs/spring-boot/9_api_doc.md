# 接口文档

> 参考资料：
> * SpringDoc OpenAPI：[https://springdoc.org/](https://springdoc.org/)
> * Knife4j：[https://doc.xiaominfo.com/](https://doc.xiaominfo.com/)

## 一、主流方案对比

| 方案 | 说明 | 推荐程度 |
|------|------|---------|
| SpringDoc + Swagger UI | Spring Boot 3.x 官方推荐 | ⭐⭐⭐ |
| Knife4j | SpringDoc 增强版，UI 更友好 | ⭐⭐⭐ |
| Springfox（已停更） | 老项目常见，不推荐新项目使用 | ⭐ |

---

## 二、SpringDoc 集成

```xml
<!-- Spring Boot 3.x -->
<dependency>
    <groupId>org.springdoc</groupId>
    <artifactId>springdoc-openapi-starter-webmvc-ui</artifactId>
    <version>2.6.0</version>
</dependency>
```

### 2.1 OpenAPI 配置

```java
@Configuration
public class OpenApiConfig {

    @Bean
    public OpenAPI openAPI() {
        return new OpenAPI()
            .info(new Info()
                .title("My Service API")
                .description("后端接口文档")
                .version("v1.0.0")
                .contact(new Contact()
                    .name("Team Name")
                    .email("team@example.com"))
                .license(new License().name("Apache 2.0")))
            .addSecurityItem(new SecurityRequirement().addList("bearerAuth"))
            .components(new Components()
                .addSecuritySchemes("bearerAuth",
                    new SecurityScheme()
                        .type(SecurityScheme.Type.HTTP)
                        .scheme("bearer")
                        .bearerFormat("JWT")
                        .description("JWT 认证 Token，格式：Bearer <token>")));
    }

    // 接口分组：按模块拆分
    @Bean
    public GroupedOpenApi userApi() {
        return GroupedOpenApi.builder()
            .group("用户模块")
            .pathsToMatch("/api/users/**", "/api/auth/**")
            .build();
    }

    @Bean
    public GroupedOpenApi orderApi() {
        return GroupedOpenApi.builder()
            .group("订单模块")
            .pathsToMatch("/api/orders/**")
            .build();
    }
}
```

```yaml
springdoc:
  api-docs:
    enabled: true
    path: /v3/api-docs
  swagger-ui:
    enabled: true
    path: /swagger-ui.html
    operations-sorter: method   # 按 HTTP 方法排序
    tags-sorter: alpha
  # 生产环境关闭
  # api-docs.enabled: false
```

### 2.2 Controller 注解

```java
@Tag(name = "用户管理", description = "用户的增删改查接口")
@RestController
@RequestMapping("/api/users")
@SecurityRequirement(name = "bearerAuth")   // 该 Controller 需要 JWT 认证
public class UserController {

    @Operation(
        summary = "获取用户列表",
        description = "支持按用户名模糊查询和分页"
    )
    @Parameters({
        @Parameter(name = "username", description = "用户名（模糊匹配）", example = "张三"),
        @Parameter(name = "page",     description = "页码，从 1 开始",    example = "1"),
        @Parameter(name = "size",     description = "每页条数",           example = "20")
    })
    @GetMapping
    public Result<Page<UserVO>> list(
            @RequestParam(required = false) String username,
            @RequestParam(defaultValue = "1") int page,
            @RequestParam(defaultValue = "20") int size) {
        return Result.ok(userService.list(username, page, size));
    }

    @Operation(summary = "创建用户")
    @ApiResponse(responseCode = "201", description = "创建成功")
    @ApiResponse(responseCode = "400", description = "参数校验失败")
    @PostMapping
    @ResponseStatus(HttpStatus.CREATED)
    public Result<UserVO> create(@RequestBody @Valid UserCreateDTO dto) {
        return Result.ok(userService.create(dto));
    }

    @Operation(summary = "删除用户", security = @SecurityRequirement(name = "bearerAuth"))
    @Parameter(name = "id", description = "用户 ID", required = true, example = "1")
    @DeleteMapping("/{id}")
    public Result<Void> delete(@PathVariable Long id) {
        userService.delete(id);
        return Result.ok();
    }
}
```

### 2.3 DTO 字段注解

```java
@Schema(description = "用户创建请求")
@Data
public class UserCreateDTO {

    @Schema(description = "用户名，3-20 位字母或数字", example = "zhangsan", requiredMode = Schema.RequiredMode.REQUIRED)
    @NotBlank
    @Size(min = 3, max = 20)
    private String username;

    @Schema(description = "密码，至少 8 位，含字母和数字", example = "Password123", requiredMode = Schema.RequiredMode.REQUIRED)
    @NotBlank
    private String password;

    @Schema(description = "邮箱", example = "user@example.com")
    @Email
    private String email;

    @Schema(description = "角色列表", example = "[\"admin\", \"operator\"]")
    private List<String> roles;
}
```

---

## 三、Knife4j 集成

```xml
<!-- Spring Boot 3.x + Jakarta -->
<dependency>
    <groupId>com.github.xiaoymin</groupId>
    <artifactId>knife4j-openapi3-jakarta-spring-boot-starter</artifactId>
    <version>4.4.0</version>
</dependency>
```

```yaml
knife4j:
  enable: true
  setting:
    language: zh_CN
    swagger-model-name: 请求参数
    enable-footer: false
    enable-debug: true        # 启用接口调试
    enable-open-api: true     # 显示 OpenAPI 规范链接
  # 生产环境关闭
  production: false
  # 开启访问鉴权
  # basic:
  #   enable: true
  #   username: admin
  #   password: 123456
```

访问路径：`/doc.html`（比 Swagger UI 更友好）

---

## 四、Spring Security 放行文档路径

```java
@Bean
public SecurityFilterChain filterChain(HttpSecurity http) throws Exception {
    return http
        .authorizeHttpRequests(auth -> auth
            // 放行 Swagger / Knife4j
            .requestMatchers(
                "/swagger-ui/**",
                "/swagger-ui.html",
                "/v3/api-docs/**",
                "/doc.html",
                "/webjars/**"
            ).permitAll()
            .anyRequest().authenticated()
        )
        .build();
}
```

---

## 五、多环境控制

```java
// 只在非生产环境启用文档
@Configuration
@Profile("!prod")
public class OpenApiConfig {
    @Bean
    public OpenAPI openAPI() { ... }
}
```

```yaml
# application-prod.yml
springdoc:
  api-docs:
    enabled: false
  swagger-ui:
    enabled: false
```
