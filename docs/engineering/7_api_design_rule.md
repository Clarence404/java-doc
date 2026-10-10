---
description: URL 与方法、状态码、统一响应与 Problem Details、分页、版本控制与废弃
---

# API 设计规范

> **本篇目标**：掌握一套可以直接落地的 REST 接口约定，覆盖 URL 与方法、状态码、数据格式、成功响应结构、RFC 9457 错误响应、分页、Spring Framework 7 内置版本控制，以及基于 Deprecation / Sunset 响应头的废弃流程。
>
> **前置阅读**：[HTTP](/protocols/2_http)

本篇是站内 REST 约定和统一响应结构的主文档，其他模块只引用、不重复。HTTP 方法、状态码本身的语义见 [HTTP](/protocols/2_http)，接口签名、限流和防重放见 [API 安全](/security/6_api_security)，规范怎样生成和接受 CI 检查见 [API 文档](./5_api_doc)。代码基于 Spring Boot 4 / Spring Framework 7，JSON 由 Jackson 3 处理。

---

## 一、资源与 URL

### 1、命名规则

| 规则 | 正例 | 反例 |
|------|------|------|
| 资源用名词复数，不用动词 | `/orders` | `/getOrder`、`/order/list` |
| 层级关系用路径表达 | `/users/{userId}/orders` | `/orders?ofUser={userId}`（属于归属关系时） |
| 全部小写，多个单词用连字符 | `/order-items` | `/orderItems`、`/order_items` |
| 嵌套不超过两级资源 | `/users/{userId}/orders` | `/users/{u}/orders/{o}/items/{i}/logs` |
| 不带文件扩展名和尾斜杠 | `/orders/{id}` | `/orders/{id}.json`、`/orders/` |
| 统一前缀与主版本号 | `/api/v1/orders` | 有的接口带版本、有的不带 |

嵌套超过两级时，把深层资源提升为顶级资源，用查询参数过滤，例如 `/order-items?orderId=123`。Spring Framework 6 起默认不再匹配尾斜杠，`/orders/` 会返回 404，这正好与「不带尾斜杠」的约定一致。

### 2、标准端点

| 方法 | URL | 含义 | 成功状态码 |
|------|-----|------|-----------|
| GET | `/api/v1/orders` | 查询订单列表（分页） | 200 |
| GET | `/api/v1/orders/{id}` | 查询单个订单 | 200 |
| POST | `/api/v1/orders` | 创建订单 | 201，带 `Location` 头 |
| PUT | `/api/v1/orders/{id}` | 整体替换订单 | 200 或 204 |
| PATCH | `/api/v1/orders/{id}` | 部分更新订单 | 200 或 204 |
| DELETE | `/api/v1/orders/{id}` | 删除订单 | 204 |
| POST | `/api/v1/orders/{id}/cancel` | 业务动作：取消订单 | 200 或 202 |

「取消」「审批」「重试」这类动作有自己的业务规则和副作用，用 PATCH 修改状态字段很难表达，所以用「资源 + 动词子路径」的 POST 形式。这是对 REST 的有意妥协，只用在少数动作上。

---

## 二、HTTP 方法与状态码

### 1、方法语义

| 方法 | 安全 | 幂等 | 用途 |
|------|------|------|------|
| GET | 是 | 是 | 查询，不修改资源 |
| POST | 否 | 否 | 创建资源、触发业务动作 |
| PUT | 否 | 是 | 整体替换资源，客户端提交完整表示 |
| PATCH | 否 | 不保证 | 部分更新；JSON Merge Patch 这类「设为某值」的写法是幂等的，「加一」这类写法不是 |
| DELETE | 否 | 是 | 删除资源；重复删除可以返回 204 或 404，团队统一一种即可 |

「幂等」说的是对服务端状态的影响，不是说每次的响应都相同。

### 2、状态码速查

| 状态码 | 场景 | 约定 |
|--------|------|------|
| `200 OK` | 查询、更新成功 | |
| `201 Created` | 创建成功 | 带 `Location` 头，指向新资源 |
| `202 Accepted` | 已受理，异步处理 | 响应体返回任务 ID 或状态查询地址 |
| `204 No Content` | 成功，没有响应体 | 常用于删除 |
| `304 Not Modified` | 条件 GET 命中 | 配合 `ETag` / `If-None-Match` |
| `400 Bad Request` | 请求格式错误、参数校验失败 | 响应体列出出错字段 |
| `401 Unauthorized` | 未认证，或凭证无效 | 必须带 `WWW-Authenticate` 头 |
| `403 Forbidden` | 已认证，但没有权限 | |
| `404 Not Found` | 资源不存在 | 不想暴露资源是否存在时，越权访问也可以返回 404 |
| `409 Conflict` | 状态冲突，如重复创建、状态机不允许 | |
| `410 Gone` | 资源或接口版本已永久下线 | 用于下线后的旧版本接口 |
| `412 Precondition Failed` | `If-Match` 版本不匹配 | 用于乐观并发控制 |
| `415 Unsupported Media Type` | 请求的 `Content-Type` 不支持 | |
| `422 Unprocessable Content` | 格式正确，但违反业务规则 | RFC 9110 中的新名称 |
| `429 Too Many Requests` | 触发限流 | 带 `Retry-After` 头 |
| `500 Internal Server Error` | 未预期的服务端错误 | 不返回堆栈 |
| `503 Service Unavailable` | 过载、维护或依赖不可用 | 可以带 `Retry-After` |

400 和 422 怎么分：JSON 解析失败、必填字段缺失、格式不对，返回 400；「余额不足」「订单已发货不能取消」这类业务规则不满足，返回 422 或 409。

### 3、乐观并发：ETag 与 If-Match

多人同时编辑同一资源时，用 `ETag` 携带版本号，客户端更新时带上 `If-Match`：

```http
GET /api/v1/orders/1001 HTTP/1.1

HTTP/1.1 200 OK
ETag: "7"

PATCH /api/v1/orders/1001 HTTP/1.1
If-Match: "7"
Content-Type: application/merge-patch+json

{"remark": "请周末配送"}
```

服务端用 `UPDATE ... WHERE id = ? AND version = 7` 执行更新，影响行数为 0 时返回 `412`，客户端重新拉取后再提交。条件更新的原理见 [幂等设计](/architecture/5_idempotence)。

---

## 三、数据格式约定

| 项目 | 约定 | 原因 |
|------|------|------|
| 字段命名 | JSON 字段和查询参数统一 camelCase | 与 Java、JavaScript 的习惯一致，不需要额外的命名策略 |
| 时间 | RFC 3339 字符串，带时区偏移，如 `2026-10-10T08:30:00+08:00`；服务端存储与传输优先使用 UTC | 不同客户端之间没有歧义；Boot 默认就把 `java.time` 类型序列化为 ISO-8601 字符串 |
| 64 位 ID | 序列化为字符串 | JavaScript 的 `Number` 超过 2^53 会丢失精度，雪花 ID 一定会超过 |
| 金额 | 十进制字符串（`"199.00"`）或最小货币单位的整数（分） | 避免浮点误差；全站统一一种写法 |
| 枚举 | 大写字符串，如 `PAID` | 不用数字编码；客户端要能容忍未知的枚举值 |
| 空值 | 字段不存在和 `null` 含义相同，团队统一一种输出方式 | PATCH 语义除外：Merge Patch 中 `null` 表示删除该字段 |
| 布尔 | `true` / `false`，字段名不加 `is` 前缀，如 `paid` | 避免 Jackson 与 Lombok 的 getter 命名冲突 |

64 位 ID 只需在字段上加注解（Jackson 3 中注解仍在 `com.fasterxml.jackson.annotation` 包）：

```java
import com.fasterxml.jackson.annotation.JsonFormat;

public record OrderView(
        @JsonFormat(shape = JsonFormat.Shape.STRING) Long orderId,
        String status,
        String amount) {
}
```

---

## 四、成功响应结构

### 1、两种风格

| 风格 | 成功响应 | 错误响应 | 适用 |
|------|----------|----------|------|
| **资源直出** | 直接返回资源 JSON，结果由 HTTP 状态码表达 | RFC 9457 Problem Details | 对外开放 API、新项目，**推荐** |
| **Result 包装** | `{code, message, data, traceId}` | 同一个包装结构，或 Problem Details | 国内项目的存量习惯，前端统一拦截 |

无论哪种风格，有两条底线不能破：**HTTP 状态码必须真实**，不能出错了也返回 200 再在 body 里写错误码，否则网关、监控、重试和缓存全部会误判；**业务码不要模仿 HTTP 状态码**，`code=200`、`code=400` 只是重复了状态码，应改用稳定的字符串码，如 `ORDER_NOT_FOUND`。

### 2、Result 包装的正确写法

用 Java record 定义包装类，不可变，构造器和访问器都由编译器生成。不要用 `@Data` 再去调用一个并不存在的全参构造器：

```java
import org.slf4j.MDC;

public record Result<T>(String code, String message, T data, String traceId) {

    public static final String OK = "OK";

    public static <T> Result<T> ok(T data) {
        return new Result<>(OK, "success", data, MDC.get("traceId"));
    }

    public static <T> Result<T> fail(String code, String message) {
        return new Result<>(code, message, null, MDC.get("traceId"));
    }
}
```

`traceId` 来自 Micrometer Tracing 写入 MDC 的同名键（见 [链路追踪](/observability/3_tracing)），排查问题时用户把它报给你就能定位到具体请求。

### 3、分页响应

不要直接把 Spring Data 的 `Page` 返回给前端，它的 JSON 结构随版本变化。应该映射成自己的分页结构：

```java
import java.util.List;
import java.util.function.Function;
import org.springframework.data.domain.Page;

public record PageResult<T>(List<T> items, long total, int page, int size) {

    public static <E, T> PageResult<T> of(Page<E> page, Function<E, T> mapper) {
        return new PageResult<>(page.map(mapper).getContent(),
                page.getTotalElements(), page.getNumber(), page.getSize());
    }
}

public record CursorResult<T>(List<T> items, String nextCursor, boolean hasMore) {
}
```

```json
{
  "items": [{ "orderId": "1849203385720832", "status": "PAID", "amount": "199.00" }],
  "total": 1024,
  "page": 0,
  "size": 20
}
```

---

## 五、错误响应：Problem Details

### 1、RFC 9457 的结构

RFC 9457（取代 RFC 7807）定义了 HTTP API 的标准错误格式，内容类型为 `application/problem+json`：

| 字段 | 含义 |
|------|------|
| `type` | 问题类型的 URI，最好指向一份说明文档；缺省为 `about:blank` |
| `title` | 问题类型的简短描述，同一 `type` 下保持不变 |
| `status` | HTTP 状态码，与响应行一致 |
| `detail` | 本次出错的具体说明，面向调用方 |
| `instance` | 本次出错的请求路径或标识 |
| 扩展字段 | 可以自由添加，如 `code`、`traceId`、`errors` |

```json
{
  "type": "https://api.example.com/problems/validation-failed",
  "title": "参数校验失败",
  "status": 400,
  "detail": "请求中有 2 个字段不合法",
  "instance": "/api/v1/orders",
  "code": "VALIDATION_FAILED",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736",
  "errors": [
    { "field": "userId", "message": "不能为空" },
    { "field": "amount", "message": "必须大于 0" }
  ]
}
```

### 2、Spring 中的实现

Spring Framework 6 起内置 `ProblemDetail` 与 `ErrorResponse`。框架自身抛出的异常（参数校验失败、不支持的方法、找不到处理器等）都能直接渲染成 Problem Details。有两种开启方式，二选一：

- 只设置 `spring.mvc.problemdetails.enabled=true`，Boot 会注册一个默认的异常处理器
- 自己写 `@RestControllerAdvice` 继承 `ResponseEntityExceptionHandler`，同时处理业务异常。此时 Boot 不再注册默认处理器，上面的属性也就不需要了

```java
import org.springframework.http.HttpStatus;

public class BizException extends RuntimeException {

    private final HttpStatus status;
    private final String code;

    public BizException(HttpStatus status, String code, String message) {
        super(message);
        this.status = status;
        this.code = code;
    }

    public HttpStatus getStatus() { return status; }
    public String getCode() { return code; }
}
```

```java
import java.net.URI;
import java.util.Map;
import java.util.Objects;
import org.slf4j.MDC;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatusCode;
import org.springframework.http.ProblemDetail;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.MethodArgumentNotValidException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.context.request.WebRequest;
import org.springframework.web.servlet.mvc.method.annotation.ResponseEntityExceptionHandler;

@RestControllerAdvice
public class GlobalExceptionHandler extends ResponseEntityExceptionHandler {

    private static final String PROBLEM_BASE = "https://api.example.com/problems/";

    @ExceptionHandler(BizException.class)
    public ProblemDetail handleBiz(BizException ex) {
        ProblemDetail pd = ProblemDetail.forStatusAndDetail(ex.getStatus(), ex.getMessage());
        pd.setType(URI.create(PROBLEM_BASE + ex.getCode().toLowerCase().replace('_', '-')));
        pd.setTitle(ex.getStatus().getReasonPhrase());
        pd.setProperty("code", ex.getCode());
        pd.setProperty("traceId", MDC.get("traceId"));
        return pd;
    }

    @Override
    protected ResponseEntity<Object> handleMethodArgumentNotValid(
            MethodArgumentNotValidException ex, HttpHeaders headers,
            HttpStatusCode status, WebRequest request) {
        ProblemDetail pd = ex.getBody();
        pd.setType(URI.create(PROBLEM_BASE + "validation-failed"));
        pd.setTitle("参数校验失败");
        pd.setProperty("code", "VALIDATION_FAILED");
        pd.setProperty("traceId", MDC.get("traceId"));
        pd.setProperty("errors", ex.getBindingResult().getFieldErrors().stream()
                .map(e -> Map.of("field", e.getField(),
                        "message", Objects.requireNonNullElse(e.getDefaultMessage(), "")))
                .toList());
        return handleExceptionInternal(ex, pd, headers, status, request);
    }
}
```

业务代码只需 `throw new BizException(HttpStatus.UNPROCESSABLE_CONTENT, "ORDER_SHIPPED", "订单已发货，不能取消")`。`500` 一类未预期的异常，只返回通用的 `detail` 和 `traceId`，堆栈只写日志，不放进响应。

::: tip 已经在用 Result 包装的项目
不必一次性全部迁移。成功响应继续用 `Result`，错误响应先做到两点：HTTP 状态码真实，业务码改成稳定的字符串。之后新接口用 Problem Details，旧接口在下一个大版本里统一切换。
:::

---

## 六、分页、排序与过滤

### 1、Offset 分页与 Cursor 分页

| 维度 | Offset 分页 | Cursor（游标）分页 |
|------|-------------|--------------------|
| 请求 | `?page=0&size=20` | `?cursor=eyJpZCI6MTAwMH0&size=20` |
| 能否跳页 | 能 | 不能，只能上一页 / 下一页 |
| 深分页性能 | 越往后越慢，`LIMIT 100000, 20` 要扫描并丢弃前 10 万行 | 稳定，`WHERE (created_at, id) < (?, ?)` 直接走索引 |
| 数据变动时 | 翻页过程中有插入或删除，会出现重复或漏数据 | 不重复、不遗漏 |
| 返回总数 | 通常返回 `total` | 一般不返回，用 `hasMore` 判断 |
| 适用 | 后台管理列表 | 信息流、消息列表、对外开放的大数据量接口 |

游标对客户端是**不透明**的字符串，通常是「最后一条记录的排序键」做 Base64 编码。排序字段必须唯一，或者带上 ID 作为第二排序键，否则排序键相同的记录会在翻页时丢失：

```sql
SELECT id, status, amount, created_at
FROM orders
WHERE user_id = ? AND (created_at, id) < (?, ?)
ORDER BY created_at DESC, id DESC
LIMIT 21;   -- 多取一条，用来判断 hasMore
```

### 2、参数约定

| 用途 | 参数 | 示例 |
|------|------|------|
| 页码 / 每页条数 | `page`、`size` | `?page=0&size=20`，`size` 设上限（如 100） |
| 游标 | `cursor`、`size` | `?cursor=eyJpZCI6MTAwMH0&size=20` |
| 排序 | `sort`，可重复 | `?sort=createdAt,desc&sort=amount,asc` |
| 精确过滤 | 字段名 | `?status=PAID` |
| 范围过滤 | `xxxFrom` / `xxxTo` | `?createdFrom=2026-10-01T00:00:00Z&createdTo=2026-10-08T00:00:00Z` |
| 字段裁剪 | `fields` | `?fields=orderId,status,amount` |
| 复杂查询 | `POST /api/v1/orders/search` | 条件放在请求体，避免 URL 过长 |

Spring Data 的 `Pageable` 参数解析默认**页码从 0 开始**，参数名为 `page` / `size` / `sort`，上面的约定与默认值保持一致。如果前端坚持页码从 1 开始，设置 `spring.data.web.pageable.one-indexed-parameters=true`，不要在每个 Controller 里手动减一。每页条数的上限用 `spring.data.web.pageable.max-page-size` 控制（默认 2000，对外接口应当调小）。

---

## 七、幂等

创建订单、发起支付这类非幂等的写接口，由客户端生成幂等键，放在 `Idempotency-Key` 请求头里（IETF 草案 draft-ietf-httpapi-idempotency-key-header 使用的名称，Stripe 等平台同样用这个名字）。服务端收到请求后，先用 `SET key PROCESSING NX EX` **原子地占位**，再执行业务，完成后把结果写回同一个 key。重复请求遇到 `PROCESSING` 返回 409，遇到已完成则直接重放首次结果。同一个 key 搭配不同的请求体，应返回 422。千万不要写成「先 GET 查一下，没有再执行」：两个并发请求会同时查不到，然后各创建一笔订单。占位状态机、唯一约束兜底和支付回调等完整方案见 [幂等设计](/architecture/5_idempotence)。

---

## 八、版本管理

### 1、版本号放在哪

| 方式 | 示例 | 优点 | 缺点 | 建议 |
|------|------|------|------|------|
| URL 路径 | `/api/v1/orders` | 一眼可见，网关路由和缓存都简单 | 同一资源有多个 URL | 对外 API 的**主版本** |
| 请求头 | `API-Version: 1.2` | URL 稳定 | 浏览器直接访问和缓存都要额外处理 | 内部服务、细粒度版本 |
| 媒体类型参数 | `Accept: application/json;version=1.2` | 符合内容协商语义 | 调用方和工具链支持度差 | 少用 |
| 查询参数 | `/api/orders?version=1` | 简单 | 与业务参数混在一起 | 不推荐 |

只有出现破坏性变更时才升级主版本。兼容性变更直接发布，不升版本。

### 2、兼容与破坏

| 变更 | 是否兼容 | 说明 |
|------|----------|------|
| 新增响应字段 | 兼容 | 前提是客户端忽略未知字段（Jackson 在 Boot 中默认如此） |
| 新增可选请求参数 | 兼容 | 不传时的行为与原来一致 |
| 新增枚举值 | 有条件兼容 | 客户端必须能处理未知值；没有事先约定时按破坏性变更对待 |
| 放宽校验（如长度上限变大） | 兼容 | |
| 删除或重命名字段、参数 | 破坏 | |
| 修改字段类型，包括 `int` 改 `long` | 破坏 | 用 `int` 反序列化的客户端会溢出，JavaScript 超过 2^53 会丢失精度；ID 一开始就用字符串 |
| 可选参数改为必填 | 破坏 | |
| 删除枚举值 | 破坏 | |
| 修改错误码或状态码的含义 | 破坏 | 客户端的错误处理分支会失效 |
| 修改 `operationId`、Schema 名 | 破坏 | 生成的 SDK 方法名和类名会变 |

这张表就是 [API 文档](./5_api_doc) 中 oasdiff 在 CI 里检查的内容，判断规则交给工具执行，不靠人工记忆。

### 3、Spring Framework 7 内置版本控制

Framework 7 在 Spring MVC 和 WebFlux 中内置了 API 版本控制，不再需要自己写 `RequestCondition`。版本可以从请求头、查询参数、媒体类型参数或路径段中解析；Boot 4 提供 `spring.mvc.apiversion.*` 属性来配置，属性写法见 [Spring Boot 版本演进](/spring-boot/11_versions)。路径版本要配合废弃处理器使用时，用 Java 配置更直观：

```java
import java.net.URI;
import java.time.ZoneOffset;
import java.time.ZonedDateTime;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.accept.StandardApiVersionDeprecationHandler;
import org.springframework.web.servlet.config.annotation.ApiVersionConfigurer;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;

@Configuration
public class ApiVersionConfig implements WebMvcConfigurer {

    @Override
    public void configureApiVersioning(ApiVersionConfigurer configurer) {
        StandardApiVersionDeprecationHandler deprecation = new StandardApiVersionDeprecationHandler();
        deprecation.configureVersion("1")
                .setDeprecationDate(ZonedDateTime.of(2026, 7, 1, 0, 0, 0, 0, ZoneOffset.UTC))
                .setDeprecationLink(URI.create("https://developer.example.com/changelog/v1-deprecation"))
                .setSunsetDate(ZonedDateTime.of(2027, 1, 1, 0, 0, 0, 0, ZoneOffset.UTC));

        configurer.usePathSegment(1)            // /api/{version}/...，下标从 0 开始，api 是第 0 段
                .addSupportedVersions("1", "2")
                .setDeprecationHandler(deprecation);
    }
}
```

```java
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/{version}/orders")
public class OrderController {

    private final OrderQueryService queryService;

    public OrderController(OrderQueryService queryService) {
        this.queryService = queryService;
    }

    @GetMapping(path = "/{id}", version = "1")     // 只匹配 v1
    public OrderViewV1 getV1(@PathVariable String id) {
        return queryService.getV1(id);
    }

    @GetMapping(path = "/{id}", version = "2+")    // 匹配 v2 及以上已支持的版本
    public OrderViewV2 getV2(@PathVariable String id) {
        return queryService.getV2(id);
    }
}
```

| 要点 | 说明 |
|------|------|
| 版本解析 | 默认用 `SemanticApiVersionParser` 解析，`v1` 的前缀 `v` 会被跳过，按 `1.0.0` 比较 |
| 版本匹配 | `"1"` 只匹配该版本；`"2+"` 匹配 2 及以上已支持的版本；不写 `version` 的映射优先级最低 |
| 不支持的版本 | 抛 `InvalidApiVersionException`，返回 400 |
| 缺少版本 | 默认要求必须带版本，否则抛 `MissingApiVersionException`（400）；设置了默认版本时按默认版本处理 |
| 路径段解析器 | 必须声明 `{version}` URI 变量；它不会返回「无版本」，因此不能和其他解析器组合，除非使用带 `Predicate<RequestPath>` 的重载（7.0.6 起） |
| 废弃提示 | 请求命中 v1 时，`StandardApiVersionDeprecationHandler` 自动加上 `Deprecation`、`Sunset`、`Link` 响应头 |

文档侧的配合方式（每个版本一个 `GroupedOpenApi`）见 [接口文档](/spring-boot/10_api_doc)。

---

## 九、废弃与下线

![API 废弃时间线](../assets/engineering/api-design-deprecation-timeline.svg)

### 1、响应头

命中废弃版本时，响应应带上这三个头：

```http
HTTP/1.1 200 OK
Deprecation: @1782864000
Sunset: Fri, 01 Jan 2027 00:00:00 GMT
Link: <https://developer.example.com/changelog/v1-deprecation>; rel="deprecation"; type="text/html"
```

| 响应头 | 标准 | 格式 | 含义 |
|--------|------|------|------|
| `Deprecation` | RFC 9745 | 结构化字段日期：`@` 加 Unix 秒数 | 从何时起废弃（可以是过去或将来的时间） |
| `Sunset` | RFC 8594 | HTTP-date | 预计何时停止响应，不得早于 `Deprecation` |
| `Link` | RFC 9745 / RFC 8594 | `rel="deprecation"` 指向迁移说明，`rel="sunset"` 指向下线说明 | 告诉调用方去哪里看迁移指南 |

上例中 `@1782864000` 即 2026-07-01 00:00:00 UTC。使用 Framework 7 内置版本控制时，这些头由废弃处理器自动输出；其他框架或网关手动添加时，要严格按这个格式写，`Deprecation: version="v1"`、`Sunset: 2025-01-01` 都是错误写法。

### 2、下线步骤

| 阶段 | 动作 |
|------|------|
| 发布新版本 | v2 上线，v1 与 v2 并行运行；文档中给 v1 标 `@Deprecated`，并写清迁移指南 |
| 宣布废弃 | v1 响应开始带 `Deprecation`、`Sunset`、`Link` 头；通过邮件、变更日志、开放平台公告通知调用方 |
| 迁移窗口 | 按版本和调用方统计 v1 的调用量（如 Micrometer 指标加上 `api.version` 标签），逐个跟进；对外 API 的窗口通常不少于 6 个月 |
| 到达 Sunset | 确认调用量已降为零或已获得调用方同意，再下线 |
| 下线 | 删除 v1 的代码；网关层对 v1 路径返回 `410 Gone`，响应体为 Problem Details，指向迁移指南，保留一段时间 |

---

## 十、接口评审检查项

通用的 PR 检查清单见 [Code Review](/devops/3_code_review)，这里只列接口专项：

- [ ] URL 使用名词复数、小写连字符，嵌套不超过两级资源
- [ ] HTTP 方法与语义匹配，状态码真实，创建返回 201 和 `Location`
- [ ] 错误响应使用 Problem Details（或团队约定的结构），业务码为稳定的字符串
- [ ] 时间带时区偏移，64 位 ID 和金额序列化为字符串
- [ ] 列表接口有分页，`size` 有上限；大数据量接口使用游标分页
- [ ] 非幂等写接口支持 `Idempotency-Key`，或有唯一约束兜底
- [ ] 变更已对照兼容性表；破坏性变更已升级主版本，并规划了废弃时间线
- [ ] OpenAPI 规范已更新入库，lint 和 oasdiff 检查通过
- [ ] 响应中没有堆栈、SQL、内部主机名，敏感字段已脱敏（见 [数据安全](/security/7_data_security)）
- [ ] 鉴权、限流、签名等安全措施已落实（见 [API 安全](/security/6_api_security)）

---

## 小结

- URL 用名词复数、小写连字符、路径带主版本号；业务动作用 `POST /资源/{id}/动作`，PATCH 不保证幂等
- 状态码必须真实：201 带 `Location`，401 带 `WWW-Authenticate`，429 带 `Retry-After`，业务规则失败用 422 / 409，并发冲突用 `If-Match` + 412
- 时间用 RFC 3339 并带时区，64 位 ID 和金额用字符串；成功响应可以直出资源，也可以用 record 定义的 `Result` 包装，业务码不要模仿 HTTP 状态码
- 错误统一使用 RFC 9457 Problem Details，Spring 用 `ProblemDetail` 加继承 `ResponseEntityExceptionHandler` 的全局处理器实现
- 后台列表用 Offset 分页（Spring Data 页码从 0 开始），信息流和大数据量接口用游标分页；幂等用 `Idempotency-Key` 加原子占位
- 版本用 Framework 7 内置的版本控制，只有破坏性变更才升主版本（`int` 改 `long` 也算）；废弃时按 RFC 9745 / RFC 8594 输出 `Deprecation`、`Sunset`、`Link` 头，到期后返回 410

## 参考资料

- HTTP 语义（方法、状态码、条件请求）：[RFC 9110 HTTP Semantics](https://www.rfc-editor.org/rfc/rfc9110.html)
- Problem Details：[RFC 9457 Problem Details for HTTP APIs](https://www.rfc-editor.org/rfc/rfc9457.html)
- Deprecation 响应头：[RFC 9745 The Deprecation HTTP Response Header Field](https://www.rfc-editor.org/rfc/rfc9745.html)
- Sunset 响应头：[RFC 8594 The Sunset HTTP Header Field](https://www.rfc-editor.org/rfc/rfc8594.html)
- 时间格式：[RFC 3339 Date and Time on the Internet](https://www.rfc-editor.org/rfc/rfc3339.html)
- JSON Merge Patch：[RFC 7396](https://www.rfc-editor.org/rfc/rfc7396.html)
- 幂等键请求头草案：[The Idempotency-Key HTTP Header Field](https://datatracker.ietf.org/doc/draft-ietf-httpapi-idempotency-key-header/)
- Spring MVC API 版本控制：[API Versioning](https://docs.spring.io/spring-framework/reference/web/webmvc-versioning.html)
- Spring MVC 版本控制配置：[MVC Config: API Version](https://docs.spring.io/spring-framework/reference/web/webmvc/mvc-config/api-version.html)
- 废弃处理器 Javadoc：[StandardApiVersionDeprecationHandler](https://docs.spring.io/spring-framework/docs/current/javadoc-api/org/springframework/web/accept/StandardApiVersionDeprecationHandler.html)
- Spring MVC 错误响应：[Error Responses](https://docs.spring.io/spring-framework/reference/web/webmvc/mvc-ann-rest-exceptions.html)
- Spring Data Web 分页支持：[Web support](https://docs.spring.io/spring-data/commons/reference/repositories/core-extensions.html#core.web)
