# API 文档

> Spring Boot 集成实践详见 [spring-boot/9_api_doc](../spring-boot/9_api_doc)。

---

## 一、方案对比

| 方案 | 规范版本 | 维护状态 | 适用场景 |
|------|---------|---------|---------|
| **Springdoc OpenAPI 3** | OpenAPI 3.x | 活跃 | 新项目首选，标准化 |
| **Knife4j** | OpenAPI 2/3 | 活跃 | 国内项目，UI 更友好 |
| **Swagger 2（springfox）** | OpenAPI 2 | 停止维护 | 旧项目维护，不建议新用 |
| **手写 API 文档** | — | 人工维护 | 对外 OpenAPI，需精细控制 |

---

## 二、Springdoc OpenAPI 3 集成

```xml
<dependency>
  <groupId>org.springdoc</groupId>
  <artifactId>springdoc-openapi-starter-webmvc-ui</artifactId>
  <version>2.3.0</version>
</dependency>
```

```yaml
# application.yml
springdoc:
  api-docs:
    path: /v3/api-docs      # JSON 文档地址
  swagger-ui:
    path: /swagger-ui.html  # UI 地址
    tags-sorter: alpha       # 按 Tag 字母排序
    operations-sorter: alpha
  packages-to-scan: com.example.interfaces.rest   # 只扫描 Controller 包
  paths-to-exclude: /actuator/**                  # 排除 actuator 接口
```

```java
// 全局 API 信息配置
@Configuration
public class OpenApiConfig {

    @Bean
    public OpenAPI customOpenAPI() {
        return new OpenAPI()
            .info(new Info()
                .title("订单服务 API")
                .version("v1.0")
                .description("订单管理相关接口")
                .contact(new Contact().name("后端团队").email("backend@example.com")))
            .addSecurityItem(new SecurityRequirement().addList("Bearer"))
            .components(new Components()
                .addSecuritySchemes("Bearer", new SecurityScheme()
                    .type(SecurityScheme.Type.HTTP)
                    .scheme("bearer")
                    .bearerFormat("JWT")));
    }
}

// Controller 注解
@Tag(name = "订单管理", description = "订单 CRUD 接口")
@RestController
@RequestMapping("/api/orders")
public class OrderController {

    @Operation(summary = "创建订单", description = "幂等接口，相同 idempotentKey 只创建一次")
    @ApiResponse(responseCode = "200", description = "创建成功")
    @ApiResponse(responseCode = "400", description = "参数错误")
    @PostMapping
    public Result<String> createOrder(
        @Parameter(description = "幂等键", required = true)
        @RequestHeader("Idempotent-Key") String idempotentKey,
        @RequestBody @Valid CreateOrderRequest req) {
        return Result.ok(orderService.create(req, idempotentKey));
    }
}
```

---

## 三、Knife4j 集成（国内友好）

```xml
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
    language: zh_cn
    enable-swagger-models: true
    enable-document-manage: true
  production: false   # 生产环境设为 true 关闭 UI
```

访问地址：`http://localhost:8080/doc.html`

**Knife4j 特有功能**：
- 接口分组管理
- 在线调试（支持文件上传）
- 导出 Word / Markdown 文档
- 离线文档下载

---

## 四、OpenAPI 文档版本化与导出

```bash
# 从运行中的服务导出 JSON 规范
curl http://localhost:8080/v3/api-docs -o openapi.json

# 转换为 YAML（可读性更好）
npx @apidevtools/swagger-cli bundle openapi.json -o openapi.yaml

# 生成 HTML 静态文档（归档用）
npx redoc-cli bundle openapi.yaml -o api-docs.html
```

**与 CI 集成（每次构建自动更新文档）**：

```yaml
# GitHub Actions
- name: 导出 OpenAPI 文档
  run: |
    # 启动服务
    java -jar target/app.jar &
    sleep 15
    # 导出文档
    curl http://localhost:8080/v3/api-docs -o docs/openapi.json
    # 提交到文档分支
    git add docs/openapi.json
    git commit -m "chore: update OpenAPI spec" || true
```

---

## 五、接口文档规范

- **必须描述**：接口用途、入参约束、成功/失败响应示例
- **请求示例**：`@Schema(example = "1001")` 提供有意义的示例值，不要用 `string` / `0`
- **敏感字段**：密码、Token 等字段加 `@Schema(accessMode = READ_ONLY)`
- **废弃接口**：加 `@Deprecated` + `@Operation(deprecated = true)`，保留至少一个版本后再删
- **生产关闭**：生产环境通过配置关闭 Swagger UI（`springdoc.swagger-ui.enabled=false`）
