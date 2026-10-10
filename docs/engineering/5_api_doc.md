---
description: OpenAPI 3.1、代码优先与契约优先、客户端生成、CI 校验与文档发布
---

# API 文档

> 前置阅读：[接口文档](/spring-boot/10_api_doc)、[API 设计规范](./7_api_design_rule)

OpenAPI 规范是描述 HTTP 接口契约的标准格式，本篇把它当作构建产物管理，讲规范从哪里来、怎样保证它和代码一致、团队拿它做什么。工具版本以 2026 年 10 月为准：springdoc-openapi 3.1.x（Boot 4）、springdoc-openapi-maven-plugin 1.5、openapi-generator 7.26、Redocly CLI 2.x、Spectral 6.x。

---

## 一、OpenAPI 规范与版本

OpenAPI 规范（OAS）用 YAML / JSON 描述 HTTP 接口，包括路径、参数、请求体、响应、错误和安全方案。它的前身是 Swagger 2.0，现在由 Linux 基金会下的 OpenAPI Initiative 维护。Swagger UI、Redoc、Scalar 这类工具只负责「展示」规范，规范本身才是团队之间的契约。

| 版本 | 发布 | 关键变化 | 工具支持 |
|------|------|----------|----------|
| 3.0.x | 2017 | 相对 Swagger 2.0 重构，引入 `components`、`requestBody` 和多个 `servers` | 全部工具都支持 |
| 3.1.x | 2021 | Schema 完全对齐 JSON Schema 2020-12：去掉 `nullable`，改写 `type: [string, "null"]`；新增 `webhooks`；`examples` 取代 `example` | 主流工具都已支持，**本篇基线** |
| 3.2.0 | 2025-09 | 新增 `query` 方法、层级 Tag、`itemSchema`（流式响应，如 SSE / JSON Lines） | Swagger UI 等陆续跟进，生成器和 lint 工具还没有全部覆盖 |

springdoc-openapi 3.x 默认输出 3.1（`springdoc.api-docs.version` 默认值为 `openapi_3_1`）。下游有只认 3.0 的老工具时，可以设为 `openapi_3_0` 临时降级。3.2 暂时不急着跟进，等生成器和 lint 工具跟上再说。

---

## 二、方案选型

| 方案 | 规范从哪来 | 维护状态 | 适用场景 |
|------|-----------|---------|---------|
| **springdoc-openapi** | 运行期扫描 Controller 和注解，生成规范（代码优先） | 活跃；Boot 4 用 3.x，Boot 3 用 2.x | 内部服务、迭代快的业务接口，**默认选择** |
| **契约优先（Design-first）** | 手写 `openapi.yaml`，用 openapi-generator 生成服务端接口 | 活跃 | 对外开放平台、多团队并行开发、多语言客户端 |
| **Spring REST Docs** | 集成测试通过时输出文档片段，再用 Asciidoctor 拼成文档 | Spring 官方维护 | 要求「文档里的每个示例都经过测试验证」的场景 |
| **Knife4j** | 基于 springdoc 2.x 的增强 UI | 4.5.0 之后更新放缓 | **只用于 Boot 3 项目**；Boot 4 用 Swagger UI 或 Scalar |
| **Springfox** | Swagger 2 注解 | 已停止维护，不支持 Jakarta | 只在遗留项目里出现，升级时换成 springdoc |

真正的选择是**代码优先**还是**契约优先**：

| 维度 | 代码优先（springdoc） | 契约优先（openapi.yaml） |
|------|----------------------|------------------------|
| 唯一事实来源 | Java 代码 | YAML 规范 |
| 上手成本 | 低，写注解就行 | 高，要先学会 OpenAPI 语法 |
| 文档和实现一致 | 天然一致（规范由代码生成） | 靠生成接口和契约测试保证 |
| 并行开发 | 接口写完后前端才能拿到文档 | 评审完规范，前后端和测试就能同时开工 |
| 接口评审 | 只能评审代码 diff | 直接评审 YAML diff，非 Java 角色也看得懂 |
| 风险 | 注解写得随意，规范质量参差不齐 | 规范和实现的生成代码可能脱节 |

经验上，内部服务用代码优先就够了，但要把生成出来的规范**提交入库**，接受 CI 检查。对外 API，以及有多个消费方的平台接口，用契约优先：先评审 YAML，再写代码。两种做法的下游流程完全相同。

---

## 三、OpenAPI 流水线

无论规范从哪来，都汇入同一条流水线：

![OpenAPI 流水线](../assets/engineering/api-doc-openapi-pipeline.svg)

| 环节 | 工具 | 产出 |
|------|------|------|
| 生成 / 编写 | springdoc-openapi-maven-plugin、Gradle 插件，或手写 | `api/openapi.yaml`（入库） |
| 质量检查 | Redocly CLI `lint`、Spectral | PR 上的注解告警，违规时构建失败 |
| 兼容性检查 | oasdiff | 破坏性变更报告，未经确认不得合并 |
| 发布文档 | Redocly CLI `build-docs` | 单文件 HTML，发布到内部站点或 GitHub Pages |
| 客户端 | openapi-generator | Java / TypeScript SDK |
| 联调与测试 | Prism Mock、契约测试 | 前端不必等后端；后端改动有回归保护 |

关键在于**规范是构建产物，而不是部署后从线上抓下来的副产品**。旧做法在 CI 里 `java -jar app.jar & sleep 15 && curl ...`，既有启动竞态，又不能参与 PR 评审，本篇不再采用。

---

## 四、代码优先：构建期生成规范

springdoc 的依赖、注解、分组、Security 放行和按环境关闭见 [接口文档](/spring-boot/10_api_doc)，这里不重复。

### 1、Maven：spring-boot-maven-plugin + springdoc 插件

springdoc-openapi-maven-plugin 在 `integration-test` 阶段请求 `/v3/api-docs`，因此要用 spring-boot-maven-plugin 在 `pre-integration-test` 阶段启动应用，在 `post-integration-test` 阶段停止应用：

```xml
<build>
  <plugins>
    <plugin>
      <groupId>org.springframework.boot</groupId>
      <artifactId>spring-boot-maven-plugin</artifactId>
      <configuration>
        <jvmArguments>-Dspring.application.admin.enabled=true</jvmArguments>
        <profiles>
          <profile>openapi</profile>
        </profiles>
      </configuration>
      <executions>
        <execution>
          <id>pre-integration-test</id>
          <goals>
            <goal>start</goal>
          </goals>
        </execution>
        <execution>
          <id>post-integration-test</id>
          <goals>
            <goal>stop</goal>
          </goals>
        </execution>
      </executions>
    </plugin>
    <plugin>
      <groupId>org.springdoc</groupId>
      <artifactId>springdoc-openapi-maven-plugin</artifactId>
      <version>1.5</version>
      <executions>
        <execution>
          <id>integration-test</id>
          <goals>
            <goal>generate</goal>
          </goals>
        </execution>
      </executions>
      <configuration>
        <apiDocsUrl>http://localhost:8080/v3/api-docs.yaml</apiDocsUrl>
        <outputFileName>openapi.yaml</outputFileName>
        <outputDir>${project.basedir}/api</outputDir>
      </configuration>
    </plugin>
  </plugins>
</build>
```

`openapi` 这个 Profile 专门用来生成文档：

```yaml
# src/main/resources/application-openapi.yml
springdoc:
  api-docs:
    enabled: true                 # 默认关闭，只在生成文档时打开
  writer-with-order-by-keys: true # 按键排序输出，避免同样的代码生成出不同的 diff
spring:
  autoconfigure:
    exclude:
      - org.springframework.boot.flyway.autoconfigure.FlywayAutoConfiguration
```

`exclude` 只是一个示例，意思是在这个 Profile 里关掉启动时依赖外部资源的组件。数据源、MQ 这类依赖可以换成内存实现，或者在 CI 里用服务容器提供，目标是应用在 CI 中能独立启动。执行 `./mvnw verify` 后，规范写到 `api/openapi.yaml`。

### 2、Gradle：springdoc-openapi-gradle-plugin

```kotlin
// build.gradle.kts
plugins {
    java
    id("org.springframework.boot") version "4.1.1"
    id("io.spring.dependency-management") version "1.1.7"
    id("org.springdoc.openapi-gradle-plugin") version "1.9.0"
}

openApi {
    apiDocsUrl.set("http://localhost:8080/v3/api-docs.yaml")   // 以 .yaml 结尾时输出 YAML
    outputDir.set(layout.projectDirectory.dir("api"))
    outputFileName.set("openapi.yaml")
    waitTimeInSeconds.set(60)
    customBootRun {
        args.set(listOf("--spring.profiles.active=openapi"))
    }
}
```

执行 `./gradlew generateOpenApiDocs`。插件通过 `forkedSpringBootRun` 后台启动应用，拉取规范后再停掉应用。分组文档用 `groupedApiMappings` 为每个分组单独输出一个文件。

### 3、为什么把规范提交入库

把 `api/openapi.yaml` 当作源码提交，带来三个好处：

- **接口变更在 PR 里可见**：评审者直接看 YAML diff，不用从 Controller 代码里推断接口改了什么
- **CI 能校验一致性**：CI 重新生成一遍规范，再执行 `git diff --exit-code api/openapi.yaml`。如果开发者改了代码却没有提交新规范，构建直接失败
- **有基线可以对比**：oasdiff 拿目标分支的规范和 PR 的规范比较，找出破坏性变更

---

## 五、契约优先：从规范生成代码

### 1、先写规范

```yaml
# src/main/resources/openapi/order-api.yaml
openapi: 3.1.0
info:
  title: Order API
  version: 1.0.0
paths:
  /api/v1/orders/{orderId}:
    get:
      tags: [orders]
      operationId: getOrder
      parameters:
        - name: orderId
          in: path
          required: true
          schema:
            type: string
      responses:
        "200":
          description: 订单详情
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/OrderView"
        "404":
          description: 订单不存在
          content:
            application/problem+json:
              schema:
                $ref: "#/components/schemas/Problem"
components:
  schemas:
    OrderView:
      type: object
      required: [orderId, status, amount]
      properties:
        orderId:
          type: string
          examples: ["1849203385720832"]
        status:
          type: string
          enum: [PENDING, PAID, CANCELLED]
        amount:
          type: string
          description: 金额，单位元，十进制字符串
          examples: ["199.00"]
    Problem:
      type: object
      properties:
        type:
          type: string
        title:
          type: string
        status:
          type: integer
        detail:
          type: string
```

`operationId` 会变成生成代码里的方法名，`tags` 会变成接口名，**发布后不要随意改名**，否则所有客户端的代码都要跟着改。错误响应统一使用 RFC 9457 Problem Details，约定见 [API 设计规范](./7_api_design_rule)。

### 2、生成服务端接口

```xml
<plugin>
  <groupId>org.openapitools</groupId>
  <artifactId>openapi-generator-maven-plugin</artifactId>
  <version>7.26.0</version>
  <executions>
    <execution>
      <id>generate-order-api</id>
      <goals>
        <goal>generate</goal>
      </goals>
      <configuration>
        <inputSpec>${project.basedir}/src/main/resources/openapi/order-api.yaml</inputSpec>
        <generatorName>spring</generatorName>
        <apiPackage>com.example.order.api</apiPackage>
        <modelPackage>com.example.order.api.model</modelPackage>
        <configOptions>
          <useSpringBoot4>true</useSpringBoot4>
          <interfaceOnly>true</interfaceOnly>
          <useTags>true</useTags>
          <skipDefaultInterface>true</skipDefaultInterface>
          <openApiNullable>false</openApiNullable>
          <documentationProvider>none</documentationProvider>
          <annotationLibrary>none</annotationLibrary>
        </configOptions>
      </configuration>
    </execution>
  </executions>
</plugin>
```

| 选项 | 作用 |
|------|------|
| `useSpringBoot4` | 按 Boot 4 生成代码，使用 `jakarta` 命名空间 |
| `interfaceOnly` | 只生成接口和模型，Controller 自己实现 |
| `useTags` | 按 Tag 命名接口，上例生成 `OrdersApi` |
| `skipDefaultInterface` | 不生成返回 501 的默认方法，漏实现时编译期就能发现 |
| `openApiNullable` | 关掉 jackson-databind-nullable 依赖，少引入一个 Jackson 2 时代的模块 |
| `documentationProvider` / `annotationLibrary` | 不在生成代码里写 Swagger 注解，文档以 YAML 为准 |

生成代码默认带 Bean Validation 注解，所以项目要引入 `spring-boot-starter-validation`。Controller 只需实现接口，映射注解和校验注解都继承自生成的接口：

```java
import com.example.order.api.OrdersApi;
import com.example.order.api.model.OrderView;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class OrderController implements OrdersApi {

    private final OrderQueryService queryService;

    public OrderController(OrderQueryService queryService) {
        this.queryService = queryService;
    }

    @Override
    public ResponseEntity<OrderView> getOrder(String orderId) {
        return ResponseEntity.ok(queryService.getView(orderId));
    }
}
```

规范一改，生成的接口签名随之变化，实现类编译不过，规范和代码就不会悄悄脱节。契约优先的项目里，在线文档直接展示源规范即可：把 YAML 放到静态资源目录，设置 `springdoc.swagger-ui.url=/openapi/order-api.yaml`，不必再让 springdoc 扫描生成一份。

### 3、生成客户端

调用方用同一份规范生成 SDK。Java 客户端推荐 `restclient` 库，它基于 Spring 的 `RestClient`：

```bash
npx --yes @openapitools/openapi-generator-cli generate \
  -i api/openapi.yaml \
  -g java \
  --library restclient \
  --additional-properties=useSpringBoot4=true,useJackson3=true,openApiNullable=false \
  --api-package com.example.order.client.api \
  --model-package com.example.order.client.model \
  -o build/order-client
```

前端常用 `-g typescript-fetch` 或 `-g typescript-axios`。Spring 体系内的服务间调用也可以选 `-g spring --library spring-http-interface`，生成 HTTP Interface 声明，配合 Boot 4 的 `@ImportHttpServices` 注册（见 [Spring Cloud 服务通信](/spring-cloud/3_communication)）。生成的 SDK 应作为独立制品发布，版本号跟随 API 版本，不要让每个调用方各自生成一份。

---

## 六、CI 中的规范检查

### 1、lint：用规则约束规范质量

Redocly CLI 内置 `recommended` 规则集，在仓库根目录放一个 `redocly.yaml` 即可调整规则：

```yaml
# redocly.yaml
extends:
  - recommended
rules:
  operation-4xx-response: error   # 每个接口至少声明一个 4xx 响应
  security-defined: error         # 每个接口都声明了安全方案
  info-license: off               # 内部 API 不要求 license
```

团队自己的接口约定，比如路径只用小写和连字符，更适合写成 Spectral 的自定义规则：

```yaml
# .spectral.yaml
extends: ["spectral:oas"]
rules:
  paths-kebab-case:
    description: 路径只用小写字母、数字、连字符和路径参数
    severity: error
    given: "$.paths[*]~"
    then:
      function: pattern
      functionOptions:
        match: "^(/([a-z0-9-]+|\\{[a-zA-Z0-9]+\\}))+$"
```

两个工具选一个作为主 lint 即可。Redocly 同时提供 `bundle`（合并多文件规范）和 `build-docs`（生成 HTML）；Spectral 的自定义规则更灵活。

### 2、工作流

下面的工作流在 PR 上做三件事：校验入库规范与代码一致，执行 lint，检测破坏性变更。

```yaml
# .github/workflows/api-contract.yml
name: api-contract
on:
  pull_request:
    branches: [main]
permissions:
  contents: read
jobs:
  openapi:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-java@v6
        with:
          distribution: temurin
          java-version: "21"
          cache: maven
      - name: 重新生成规范并校验已提交
        run: |
          ./mvnw -B verify -DskipTests
          git diff --exit-code api/openapi.yaml
      - name: Lint
        run: npx --yes @redocly/cli@2.62.1 lint api/openapi.yaml --format=github-actions
      - name: 拉取目标分支
        run: git fetch --depth=1 origin ${{ github.base_ref }}
      - name: 破坏性变更检测
        uses: oasdiff/oasdiff-action/breaking@v0
        with:
          base: "origin/${{ github.base_ref }}:api/openapi.yaml"
          revision: "HEAD:api/openapi.yaml"
          fail-on: ERR
```

- `-DskipTests` 只跳过测试，生成规范的插件照常执行；完整的构建和测试由主流水线负责（见 [CI/CD](/devops/2_ci_cd)）
- `git diff --exit-code` 有差异时退出码非零，提示开发者先在本地生成规范并提交
- oasdiff 把删除接口、删除响应字段、新增必填参数等改动判定为 ERR 级别；确实需要破坏兼容时，按 [API 设计规范](./7_api_design_rule#八、版本管理) 升级版本，而不是关掉检查
- 示例中第三方 Action 用的是主版本标签；生产仓库应按 GitHub 安全加固指南固定到 commit SHA

### 3、发布文档

合并到 main 后，把规范渲染成单文件 HTML，作为制品上传，或者发布到内部文档站：

```yaml
      - name: 生成 HTML 文档
        run: npx --yes @redocly/cli@2.62.1 build-docs api/openapi.yaml -o site/index.html
      - uses: actions/upload-artifact@v7
        with:
          name: api-docs
          path: site/
```

生产环境本身不开放文档端点（见 [接口文档](/spring-boot/10_api_doc)）。需要给合作方看文档时，发布的是这份静态 HTML，不是线上服务的 `/v3/api-docs`。

---

## 七、规范的下游用途

| 用途 | 做法 | 说明 |
|------|------|------|
| Mock 服务 | `npx @stoplight/prism-cli mock api/openapi.yaml` | 按规范里的 `examples` 返回响应，前端不必等后端 |
| 请求校验代理 | `prism proxy` 模式 | 校验真实请求和响应是否符合规范，适合联调环境 |
| 契约测试 | Spring Cloud Contract、Pact | 消费方驱动的契约测试，见 [契约测试](/testing/6_contract_test) |
| 网关导入 | 把规范导入 API 网关或开放平台 | 自动生成路由、限流和计费配置 |
| 变更日志 | `oasdiff changelog base.yaml revision.yaml` | 根据两版规范生成面向调用方的变更说明 |

---

## 八、接口文档规范

| 规则 | 做法 |
|------|------|
| 必须描述 | 每个接口写 `summary`，写清用途、入参约束、成功响应和主要错误响应 |
| 示例值有意义 | `@Schema(example = "1849203385720832")`，不写 `string`、`0` 这种默认值 |
| 只写字段 | 密码等只在请求里出现的字段，标 `@Schema(accessMode = Schema.AccessMode.WRITE_ONLY)`，不写看起来真实的示例 |
| 只读字段 | 服务端生成的 ID、创建时间标 `READ_ONLY`，只在响应模型中出现 |
| 凭证不进响应模型 | 签发的 Token、密钥只在专门的认证接口返回，不要作为普通字段出现在业务响应里 |
| 错误响应 | 用 `@ApiResponse` 声明 4xx / 5xx，内容类型为 `application/problem+json` |
| 废弃接口 | 加 `@Deprecated` 即可，springdoc 会自动标记 `deprecated: true`，不必再写 `@Operation(deprecated = true)`；下线流程见 [API 设计规范](./7_api_design_rule#九、废弃与下线) |
| 稳定标识 | `operationId`、Tag 名、Schema 名发布后视同接口的一部分，改名等于破坏性变更 |
| 生产关闭 | 同时关闭 `springdoc.api-docs.enabled` 和 `springdoc.swagger-ui.enabled`；只关 UI 时 `/v3/api-docs` 仍然可以访问 |

---

## 小结

- OpenAPI 规范是团队间的契约，展示工具只是它的视图；基线用 3.1（与 JSON Schema 2020-12 对齐），springdoc 3.x 默认输出 3.1，3.2 等工具链跟上再用
- 内部服务用代码优先（springdoc），对外和多消费方接口用契约优先（YAML + openapi-generator）；Knife4j 只用于 Boot 3，Springfox 应当淘汰
- 规范在构建期生成并提交入库（Maven 插件绑定 `integration-test`，Gradle 用 `generateOpenApiDocs`），CI 用 `git diff --exit-code` 保证代码和规范一致
- CI 中用 Redocly / Spectral 做 lint，用 oasdiff 检测破坏性变更；同一份规范再生成 HTML 文档、SDK、Mock，并支撑契约测试
- 字段标注要准确：只出现在请求里的字段用 `WRITE_ONLY`，`@Deprecated` 就足够标记废弃；生产环境要同时关闭规范端点和 UI

## 参考资料

- OpenAPI 规范 3.1 / 3.2：[OpenAPI Specification](https://spec.openapis.org/oas/latest.html)
- springdoc-openapi 官方文档（属性、插件、FAQ）：[springdoc.org](https://springdoc.org/)
- springdoc Maven 插件：[springdoc-openapi-maven-plugin](https://github.com/springdoc/springdoc-openapi-maven-plugin)
- springdoc Gradle 插件：[springdoc-openapi-gradle-plugin](https://github.com/springdoc/springdoc-openapi-gradle-plugin)
- openapi-generator Spring 生成器选项：[Documentation for the spring Generator](https://openapi-generator.tech/docs/generators/spring/)
- openapi-generator Java 生成器选项：[Documentation for the java Generator](https://openapi-generator.tech/docs/generators/java/)
- Redocly CLI lint 命令：[Redocly CLI lint](https://redocly.com/docs/cli/commands/lint)
- Spectral 规则集：[Spectral 文档](https://docs.stoplight.io/docs/spectral/)
- oasdiff GitHub Action：[oasdiff-action](https://github.com/oasdiff/oasdiff-action)
- Prism Mock 服务：[Prism](https://github.com/stoplightio/prism)
- Spring REST Docs：[Spring REST Docs](https://spring.io/projects/spring-restdocs)
- GitHub Actions 安全加固（固定 SHA）：[Security hardening for GitHub Actions](https://docs.github.com/en/actions/reference/security/secure-use)

> 下一篇：[依赖治理](./6_dependency_governance)
