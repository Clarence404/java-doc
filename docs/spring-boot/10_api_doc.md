---
description: springdoc 3.x 集成与分组、注解、Knife4j（Boot 3）、Security 放行、按环境关闭
---

# 接口文档

> 前置阅读：[Web 开发](./2_web_dev)

springdoc-openapi 可以从代码直接生成 OpenAPI 3 文档。本篇讲 Spring Boot 4 + springdoc-openapi 3.x 的全局配置、分组与注解写法，Knife4j 在 Boot 3 项目中的用法，以及在生产环境用配置关掉文档端点。

---

## 一、版本选择

springdoc-openapi 是社区项目，不属于 Spring 官方，但已是 Spring Boot 生成 OpenAPI 文档的事实标准（Spring 官方的文档项目是测试驱动的 Spring REST Docs）。它的大版本与 Boot 大版本绑定：

方案选型（springdoc、Spring REST Docs、手写 OpenAPI 等）、文档导出与 CI 集成、接口文档规范见 [API 文档](/engineering/5_api_doc)。

| Spring Boot | springdoc-openapi | 说明 |
|-------------|-------------------|------|
| 4.x | 3.x（Boot 4.0 对应 3.0.x） | 本篇基线；Boot 4 的小版本对应关系以官网 FAQ 兼容表为准 |
| 3.x | 2.x（Boot 3.5 用 2.8.x） | 2.x 不能用于 Boot 4 |
| 2.x | 1.x | 已停止维护 |

老项目里的 Springfox 早已停更，且不支持 Boot 3 的 Jakarta 命名空间，升级时直接换成 springdoc。

---

## 二、springdoc 集成

### 1、依赖

```xml
<properties>
    <!-- 按 springdoc 官网兼容表选择与 Boot 版本对应的最新补丁版本 -->
    <springdoc.version>3.1.1</springdoc.version>
</properties>

<dependency>
    <groupId>org.springdoc</groupId>
    <artifactId>springdoc-openapi-starter-webmvc-ui</artifactId>
    <version>${springdoc.version}</version>
</dependency>
```

| 场景 | starter |
|------|---------|
| Spring MVC + Swagger UI | `springdoc-openapi-starter-webmvc-ui` |
| Spring MVC，只要 JSON / YAML 规范（UI 由网关或其他系统提供） | `springdoc-openapi-starter-webmvc-api` |
| WebFlux | `springdoc-openapi-starter-webflux-ui` / `-api` |
| 换用 Scalar 界面 | `springdoc-openapi-starter-webmvc-scalar`（WebFlux 为 `-webflux-scalar`），页面路径 `/scalar` |

启动后访问 `/swagger-ui.html`（会重定向到 `/swagger-ui/index.html`），规范 JSON 在 `/v3/api-docs`。

### 2、OpenAPI 全局配置与分组

```java
import io.swagger.v3.oas.models.Components;
import io.swagger.v3.oas.models.OpenAPI;
import io.swagger.v3.oas.models.info.Contact;
import io.swagger.v3.oas.models.info.Info;
import io.swagger.v3.oas.models.info.License;
import io.swagger.v3.oas.models.security.SecurityRequirement;
import io.swagger.v3.oas.models.security.SecurityScheme;
import org.springdoc.core.models.GroupedOpenApi;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@Configuration
public class OpenApiConfig {

    @Bean
    public OpenAPI openAPI() {
        return new OpenAPI()
            .info(new Info()
                .title("Order Service API")
                .description("订单服务接口文档")
                .version("v1.0.0")
                .contact(new Contact().name("Order Team").email("order-team@example.com"))
                .license(new License().name("Apache 2.0")))
            // 全局安全要求：所有接口默认需要 Bearer Token
            .addSecurityItem(new SecurityRequirement().addList("bearerAuth"))
            .components(new Components()
                .addSecuritySchemes("bearerAuth", new SecurityScheme()
                    .type(SecurityScheme.Type.HTTP)
                    .scheme("bearer")
                    .bearerFormat("JWT")
                    .description("在此填入 Token，无需加 Bearer 前缀")));
    }

    // 按模块分组，Swagger UI 右上角可切换
    @Bean
    public GroupedOpenApi userApi() {
        return GroupedOpenApi.builder()
            .group("user")
            .displayName("用户模块")
            .pathsToMatch("/api/users/**", "/api/auth/**")
            .build();
    }

    @Bean
    public GroupedOpenApi orderApi() {
        return GroupedOpenApi.builder()
            .group("order")
            .displayName("订单模块")
            .pathsToMatch("/api/orders/**")
            .build();
    }
}
```

`group` 会出现在 URL 中（`/v3/api-docs/order`），用英文；中文名放在 `displayName`。

### 3、常用配置

```yaml
springdoc:
  api-docs:
    path: /v3/api-docs
  swagger-ui:
    path: /swagger-ui.html
    operations-sorter: method     # 按 HTTP 方法排序
    tags-sorter: alpha            # 按 Tag 字母排序
    persist-authorization: true   # 刷新页面后保留已填的 Token
  packages-to-scan: com.example.order.interfaces.rest
  paths-to-exclude: /actuator/**
  default-produces-media-type: application/json
```

### 4、Controller 注解

```java
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.Parameter;
import io.swagger.v3.oas.annotations.responses.ApiResponse;
import io.swagger.v3.oas.annotations.security.SecurityRequirements;
import io.swagger.v3.oas.annotations.tags.Tag;
import jakarta.validation.Valid;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.*;

@Tag(name = "用户管理", description = "用户的增删改查接口")
@RestController
@RequestMapping("/api/users")
public class UserController {

    private final UserService userService;

    public UserController(UserService userService) {
        this.userService = userService;
    }

    @Operation(summary = "分页查询用户", description = "支持按用户名模糊查询")
    @GetMapping
    public Result<PageResult<UserVO>> list(
            @Parameter(description = "用户名（模糊匹配）", example = "张三")
            @RequestParam(required = false) String username,
            @Parameter(description = "页码，从 1 开始", example = "1")
            @RequestParam(defaultValue = "1") int page,
            @Parameter(description = "每页条数", example = "20")
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

    @Operation(summary = "用户名是否可用")
    @SecurityRequirements                      // 空注解：覆盖全局要求，该接口无需认证
    @GetMapping("/check")
    public Result<Boolean> check(@RequestParam String username) {
        return Result.ok(userService.isAvailable(username));
    }
}
```

- `@Parameter` 直接写在参数上，比方法级 `@Parameters` 列表更不容易和实际参数脱节
- 全局已声明安全要求时，个别公开接口用空的 `@SecurityRequirements` 取消
- springdoc 会读取 Bean Validation 注解（`@NotBlank`、`@Size` 等）生成必填与长度约束，不必在 `@Schema` 中重复描述

### 5、DTO 注解

```java
import io.swagger.v3.oas.annotations.media.Schema;
import jakarta.validation.constraints.Email;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;
import java.util.List;

@Schema(description = "用户创建请求")
public record UserCreateDTO(

    @Schema(description = "用户名，3-20 位字母或数字", example = "zhangsan")
    @NotBlank @Size(min = 3, max = 20)
    String username,

    @Schema(description = "密码，至少 8 位，含字母和数字", accessMode = Schema.AccessMode.WRITE_ONLY)
    @NotBlank @Size(min = 8)
    String password,

    @Schema(description = "邮箱", example = "user@example.com")
    @Email
    String email,

    @Schema(description = "角色列表", example = "[\"admin\", \"operator\"]")
    List<String> roles) { }
```

密码等敏感字段不要写看起来真实的 `example`，并标 `WRITE_ONLY`，避免出现在响应模型中。

### 6、与 Framework 7 API 版本控制配合

使用 Framework 7 内置的 API 版本控制（见 [Spring Boot 版本演进](./11_versions)）时，同一路径会因版本不同映射到不同方法。建议每个对外版本建一个 `GroupedOpenApi`，让每份文档只包含一个版本的接口；具体的按版本筛选方式随 springdoc 3.x 小版本演进，以官方文档为准。

---

## 三、Knife4j（Boot 3 项目可选）

Knife4j 是基于 springdoc 的增强 UI，提供中文界面、离线文档导出（Markdown / Word / HTML）和更友好的在线调试。它当前的 `knife4j-openapi3-jakarta-spring-boot-starter` 4.x 构建在 springdoc 2.x 之上，**只适用于 Boot 3.x**；截至本文基线未见支持 Boot 4 / springdoc 3 的正式版本，Boot 4 项目使用 springdoc 自带的 Swagger UI 或 Scalar。

```xml
<!-- 仅 Spring Boot 3.x；会传递引入 springdoc 2.x，不要再单独声明另一个版本的 springdoc -->
<dependency>
    <groupId>com.github.xiaoymin</groupId>
    <artifactId>knife4j-openapi3-jakarta-spring-boot-starter</artifactId>
    <version>4.5.0</version>
</dependency>
```

```yaml
knife4j:
  enable: true
  setting:
    language: zh_cn
    enable-footer: false
  production: false                # 设为 true 时屏蔽所有文档资源
  basic:                           # 文档页面加 Basic 认证
    enable: true
    username: ${KNIFE4J_USER}
    password: ${KNIFE4J_PASSWORD}  # 从环境变量注入，不写死在配置文件里
```

访问路径为 `/doc.html`。前面的 `OpenAPI`、`GroupedOpenApi` 配置与注解写法完全通用。

---

## 四、Spring Security 放行

```java
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Profile;
import org.springframework.core.annotation.Order;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.web.SecurityFilterChain;

@Configuration
@Profile("!prod")                         // 只在非生产环境放行文档路径
public class ApiDocSecurityConfig {

    @Bean
    @Order(0)
    public SecurityFilterChain apiDocFilterChain(HttpSecurity http) throws Exception {
        http.securityMatcher("/v3/api-docs/**", "/swagger-ui/**", "/swagger-ui.html",
                             "/scalar/**", "/doc.html", "/webjars/**")
            .authorizeHttpRequests(auth -> auth.anyRequest().permitAll());
        return http.build();
    }
}
```

文档路径单独一条过滤链，不污染业务链的规则；生产环境不放行，配合下一节的配置开关关掉端点本身。SecurityFilterChain 的基础见 [Security](/spring/9_security)。

---

## 五、按环境关闭

**关闭文档要靠 springdoc 的配置开关**，而不是给 `OpenApiConfig` 加 `@Profile("!prod")`：后者只是去掉了自定义的 `OpenAPI` / `GroupedOpenApi` Bean，springdoc 的自动配置仍然会用默认信息提供 `/v3/api-docs` 和 Swagger UI。

```yaml
# application-prod.yml
springdoc:
  api-docs:
    enabled: false        # 关闭 /v3/api-docs（Swagger UI 随之不可用）
  swagger-ui:
    enabled: false        # 同时关闭 UI 资源
```

更稳妥的做法是**默认关闭、按需开启**：在 `application.yml` 里设 `springdoc.api-docs.enabled: false`，只在 `application-dev.yml` / `application-test.yml` 中设为 `true`，这样新增环境时不会因为忘记配置而把文档暴露出去。使用 Knife4j 时再加 `knife4j.production: true`。

需要在生产环境给合作方提供文档时，从测试环境导出 OpenAPI 规范后单独发布，导出流程见 [API 文档](/engineering/5_api_doc)。

---

## 小结

- springdoc-openapi 是社区维护的事实标准：Boot 4 用 3.x，Boot 3 用 2.x，大版本不能混用；Springfox 直接淘汰
- 全局 `OpenAPI` Bean 定义信息与安全方案，`GroupedOpenApi` 按模块或 API 版本分组，`group` 用英文、`displayName` 写中文
- 参数注解写在参数上，校验注解会自动反映到文档；敏感字段 `WRITE_ONLY`、不写真实示例
- Knife4j 只作为 Boot 3 项目的可选 UI；Boot 4 用 Swagger UI 或 Scalar
- 文档路径单独一条 SecurityFilterChain；生产环境用 `springdoc.api-docs.enabled=false` 关闭，推荐默认关闭、开发测试环境开启

## 参考资料

- springdoc-openapi：[https://springdoc.org/](https://springdoc.org/)
- springdoc-openapi FAQ（版本兼容表）：[https://springdoc.org/faq.html](https://springdoc.org/faq.html)
- OpenAPI Specification：[https://spec.openapis.org/oas/latest.html](https://spec.openapis.org/oas/latest.html)
- Spring REST Docs：[https://spring.io/projects/spring-restdocs](https://spring.io/projects/spring-restdocs)
- Knife4j：[https://doc.xiaominfo.com/](https://doc.xiaominfo.com/)

> 下一篇：[Spring Boot 版本演进](./11_versions) —— 2.x、3.x、4.x 每一代改了什么基线，以及一个老项目怎样一步步升级到 4.x。
