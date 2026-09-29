# API 文档

> SpringDoc / Knife4j 的依赖、配置、注解等集成代码统一见 [spring-boot/9_api_doc](../spring-boot/9_api_doc)，本文聚焦方案选型、文档导出与规范。

---

## 一、方案对比

| 方案 | 规范版本 | 维护状态 | 适用场景 |
|------|---------|---------|---------|
| **Springdoc OpenAPI 3** | OpenAPI 3.x | 活跃 | 新项目首选，标准化 |
| **Knife4j** | OpenAPI 2/3 | 活跃 | 国内项目，UI 更友好 |
| **Swagger 2（springfox）** | OpenAPI 2 | 停止维护 | 旧项目维护，不建议新用 |
| **手写 API 文档** | — | 人工维护 | 对外 OpenAPI，需精细控制 |

---

## 二、集成实践

SpringDoc OpenAPI 3 与 Knife4j 的依赖、`application.yml` 配置、全局 OpenAPI Bean、Controller / DTO 注解、Spring Security 放行及多环境控制，详见 [spring-boot/9_api_doc](../spring-boot/9_api_doc)。

---

## 三、OpenAPI 文档版本化与导出

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

## 四、接口文档规范

- **必须描述**：接口用途、入参约束、成功/失败响应示例
- **请求示例**：`@Schema(example = "1001")` 提供有意义的示例值，不要用 `string` / `0`
- **敏感字段**：密码、Token 等字段加 `@Schema(accessMode = READ_ONLY)`
- **废弃接口**：加 `@Deprecated` + `@Operation(deprecated = true)`，保留至少一个版本后再删
- **生产关闭**：生产环境通过配置关闭 Swagger UI（`springdoc.swagger-ui.enabled=false`）
