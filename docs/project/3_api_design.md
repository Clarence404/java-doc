---
description: 资源路径、ProblemDetail 与模块错误码、下单幂等、游标分页、校验分组、版本兼容与鉴权
---

# 接口设计

> 前置阅读：[工程搭建](./1_project_setup)、[数据建模](./2_data_model)、[API 设计规范](/engineering/4_api_design_rule)

订单服务要把下单、查询、取消交给 App、H5 和运营后台。本篇讲阶段一的资源路径、错误响应、下单幂等与分页，基线为 Spring Boot 4、Spring Framework 7。

---

## 一、背景

阶段一的数字很小：日订单 1 万，下单峰值约 20 QPS，调用方只有自家的 App、H5 和运营后台，前后端都是这 3 个人写。性能不是问题，真正要防的是三类「上线后才发现、改起来很贵」的坑：

- **重复下单**：弱网下「提交订单」超时，用户再点一次或客户端自动重试，生成两笔订单
- **错误不可区分**：失败都返回 200 加中文提示，前端只能比对文案，监控也看不出错误率
- **发布后改不动**：订单号用 `long` 传给 JavaScript 丢精度、列表 offset 翻页越翻越慢，等装机量上来再改就要强制升级客户端

所以这一阶段的接口设计目标是：**约定一次定好，后面阶段只做加法**。通用规则以 [API 设计规范](/engineering/4_api_design_rule) 为准，本篇只记录订单服务落地时的选择。

---

## 二、决策一览

| 问题 | 可选方案 | 决策 | 暂不做 |
|------|---------|------|--------|
| 成功响应 | `Result{code, data}` 包装 / 资源直出 | 资源直出，HTTP 状态码真实 | 不给成功响应套包装 |
| 错误响应 | 自定义 JSON / RFC 9457 | `ProblemDetail`，扩展 `code`、`traceId` | 不做多语言错误文案 |
| 错误码 | 数字码 / 全局一个枚举 / 按模块前缀 | 字符串码，按模块前缀，各模块自己的枚举 | 不建错误码管理平台 |
| 下单防重 | 前端按钮置灰 / 令牌 / `Idempotency-Key` | `Idempotency-Key` 请求头 + 订单表唯一约束 | 暂不引入 Redis 占位，暂不检测同键不同请求体 |
| 列表分页 | offset / 游标 | 用户端游标分页 | 不返回总数 |
| 版本 | URL / 请求头 | 请求头 `API-Version`，缺省 1.0 | 不提前做 v2 |
| 鉴权 | Session / JWT | 短期 JWT + 可吊销的刷新令牌 | 不接 OAuth2 授权服务器 |
| 契约 | 手写文档 / springdoc 生成 | springdoc 生成 OpenAPI，CI 做兼容性检查 | 暂不生成客户端 SDK |

下面按这张表逐项展开，下单接口的整条处理链路如下图：

![下单接口请求处理链路](../assets/project/order-create-request-flow.svg)

---

## 三、资源与路径

订单服务对外只有一个资源 `orders`，四个接口：

| 接口 | 用途 | 成功 | 常见失败 |
|------|------|------|---------|
| `POST /api/orders` | 下单 | 201 + `Location` | 400 校验失败、409 库存不足、422 商品已下架 |
| `GET /api/orders/{orderNo}` | 订单详情 | 200 | 404 订单不存在 |
| `GET /api/orders?status=&cursor=&size=` | 我的订单列表 | 200 | 400 游标非法 |
| `POST /api/orders/{orderNo}/cancel` | 取消订单 | 200 | 404、409 当前状态不能取消 |

几个具体约定：

- **`orderNo` 是对外订单号，不是主键**：对应 `t_order.order_no VARCHAR(32)`，阶段一取值是雪花 ID 的十进制字符串，阶段三可能改生成规则；主键 `id` 只在服务内部使用，不出现在路径和响应里。订单号一律按字符串传，19 位数字超过 2^53，JavaScript 的 `Number` 存不下；这一条一开始就要定，事后把 `long` 改成 `String` 属于破坏性变更
- **下单请求不传价格**：请求体只有 `skuId`、`quantity` 和收货地址，金额由服务端按当前价格计算，客户端传来的金额一律不信；金额字段输出为字符串 `"199.00"`
- **状态流转用动作子资源**：取消不写成 `PATCH /api/orders/{orderNo}` 加 `{"status":"CANCELLED"}`。取消要校验状态、回补库存、记录原因，是带业务规则的动作；开放 `status` 字段，客户端就能把订单直接改成「已支付」。`/cancel` 让每种流转有独立的校验和审计，后面的 `/confirm-receipt`、`/apply-refund` 照此命名
- **查询只看自己的订单**：用户 ID 从登录态取，不接受参数传入；查到别人的订单和查不到一样返回 404，不让人借 403 和 404 的差别探测订单号是否存在

---

## 四、统一响应与错误码

### 1、成功直出，失败用 ProblemDetail

成功时直接返回订单资源，结果由状态码表达；失败时返回 RFC 9457 的 `application/problem+json`，在标准字段之外扩展两个字段：`code`（稳定的业务码，前端靠它分支）和 `traceId`（用户报障时给出来，直接定位到这次请求）。取消一笔已发货的订单，响应如下：

```json
{
  "type": "https://api.qingyou.com/problems/order-status-conflict",
  "title": "订单状态不允许此操作",
  "status": 409,
  "detail": "订单 1849203385720832512 已发货，不能取消",
  "instance": "/api/orders/1849203385720832512/cancel",
  "code": "ORDER_STATUS_CONFLICT",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

为什么不用国内常见的 `Result{code, message, data}` 包装：前端是自己人，没有存量包装要兼容；而真实状态码能让网关、监控、客户端重试策略直接工作，5xx 比例就是错误率，不用再解析响应体。两种风格的完整对比见 [API 设计规范 · 错误响应](/engineering/4_api_design_rule#五、错误响应-problem-details)。

### 2、错误码按模块分前缀

[API 设计规范](/engineering/4_api_design_rule) 用一个全局 `ErrorCode` 枚举。青柚是模块化单体（`mall-order`、`mall-inventory`、`mall-user` 等，支付阶段一放在 `mall-order` 的 `pay` 包里），所有模块往一个枚举文件里加码，既容易冲突，阶段三拆服务时还得把枚举拆开。所以改成**公共接口 + 每个模块一个枚举**，业务码 = 模块前缀 + 原因：

| 所在模块 | 前缀 | 示例 |
|---------|------|------|
| `mall-common` | 无 | `VALIDATION_FAILED`、`UNAUTHORIZED`、`SYSTEM_ERROR` |
| `mall-order` | `ORDER_` | `ORDER_NOT_FOUND`、`ORDER_STATUS_CONFLICT`、`ORDER_SKU_OFF_SHELF` |
| `mall-product` | `PRODUCT_` | `PRODUCT_NOT_FOUND` |
| `mall-inventory` | `STOCK_` | `STOCK_INSUFFICIENT` |
| `mall-order` 的 `pay` 包 | `PAY_` | `PAY_AMOUNT_MISMATCH` |
| `mall-user` | `USER_` | `USER_ADDRESS_NOT_FOUND` |

`mall-common` 里的 `ErrorCode` 是接口，只声明 `status()`、`title()`、`code()` 三个方法，各模块的枚举实现它，并放在本模块的 `api` 包，例如库存的 `InventoryErrorCode.STOCK_INSUFFICIENT`，订单模块扣减失败时直接抛它。支付码单独建 `PayErrorCode` 枚举放在 `com.qingyou.order.pay`，不并进 `OrderErrorCode`，阶段三支付独立成服务时连包带枚举一起搬走，前缀不变：

```java
package com.qingyou.order.api;

public enum OrderErrorCode implements ErrorCode {

    ORDER_NOT_FOUND(HttpStatus.NOT_FOUND, "订单不存在"),
    ORDER_STATUS_CONFLICT(HttpStatus.CONFLICT, "订单状态不允许此操作"),
    ORDER_SKU_OFF_SHELF(HttpStatus.UNPROCESSABLE_CONTENT, "商品已下架");

    private final HttpStatus status;
    private final String title;

    OrderErrorCode(HttpStatus status, String title) {
        this.status = status;
        this.title = title;
    }

    @Override public HttpStatus status() { return status; }
    @Override public String title() { return title; }
    @Override public String code() { return name(); }      // 业务码 = 枚举名
}
```

`BizException` 只持有 `ErrorCode` 接口，业务代码写 `throw new BizException(OrderErrorCode.ORDER_STATUS_CONFLICT, "订单 " + orderNo + " 已发货，不能取消")`。前缀与模块一一对应，看到码就知道是哪个小组的问题；一个码对外发布后不再改含义，编码规约见 [开发规范 · 异常](/devops/3_dev_standards#五、异常)。

### 3、全局异常处理器

处理器放在 `mall-common`，继承 `ResponseEntityExceptionHandler`，让 Spring MVC 自身的异常（缺请求头、请求体解析失败、校验失败）由父类转成 4xx，只额外处理业务异常和兜底异常：

```java
@Slf4j
@RestControllerAdvice
public class GlobalExceptionHandler extends ResponseEntityExceptionHandler {

    private static final String PROBLEM_BASE = "https://api.qingyou.com/problems/";

    @ExceptionHandler(BizException.class)
    public ProblemDetail handleBiz(BizException ex) {
        ErrorCode ec = ex.getErrorCode();
        if (ec.status().is5xxServerError()) {
            log.error("业务处理失败，code={}", ec.code(), ex);
            return problem(ec, ec.title());                 // 5xx 不把内部信息给客户端
        }
        log.warn("业务异常，code={}, message={}", ec.code(), ex.getMessage());
        return problem(ec, ex.getMessage());
    }

    // 兜底的 @ExceptionHandler(Exception.class) 返回 SYSTEM_ERROR，写法同上，略

    private ProblemDetail problem(ErrorCode ec, String detail) {
        ProblemDetail pd = ProblemDetail.forStatusAndDetail(ec.status(), detail);
        pd.setType(URI.create(PROBLEM_BASE + ec.code().toLowerCase().replace('_', '-')));
        pd.setTitle(ec.title());
        pd.setProperty("code", ec.code());
        pd.setProperty("traceId", MDC.get("traceId"));
        return pd;
    }
}
```

校验失败时把字段错误放进 `errors` 扩展字段的写法（覆盖 `handleMethodArgumentNotValid`）与主文档一致，见 [API 设计规范](/engineering/4_api_design_rule)；`traceId` 由过滤器链最前面的 `TraceIdFilter` 写入 MDC，阶段四接入链路追踪后换成 Micrometer Tracing 生成的值，字段名不变。

---

## 五、下单幂等

### 1、方案选择

| 方案 | 能防住什么 | 问题 |
|------|-----------|------|
| 前端按钮置灰 | 手抖连点 | 防不住超时重试、网关重试 |
| 先查后插 | 串行的重复请求 | 两个并发请求同时查不到，照样建两单 |
| 下单前取令牌 | 重复提交 | 多一次往返，令牌要存储，阶段一还没有 Redis |
| **`Idempotency-Key` + 唯一约束** | 重试、并发重复 | 键要随订单一起存下来 |

选最后一种：客户端进入确认页时生成一个 UUID（长度限定 16–64 字符），放在 `Idempotency-Key` 请求头里，**同一次提交的所有重试都带同一个键**。服务端不另建幂等表，把键存进 `t_order.biz_no`，靠 [数据建模](./2_data_model) 中的唯一键 `uk_user_biz (user_id, biz_no)` 兜底。幂等键、唯一约束、Redis 占位等方案的完整对比见 [幂等设计](/architecture/3_idempotence)。

### 2、重复请求的行为

- **同键重复请求**：不再下单，**重放首次结果**，返回同一笔订单和同样的 201，并带响应头 `Idempotent-Replayed: true`，客户端无需区分首次还是重试
- **同键不同请求体**：阶段一不识别，同样按重放返回首单；检测这类客户端复用键的 bug 要另存请求摘要，暂不做
- **缺少请求头**：Spring 抛 `MissingRequestHeaderException`，由父类处理器返回 400
- **两个并发请求**：第二个请求插入 `t_order` 时会等第一个事务提交，随后撞 `uk_user_biz`，走重放；第一个事务回滚时，第二个请求的插入直接成功，正常下单

### 3、关键实现

幂等键就是订单行的一列，随订单在同一条 `INSERT` 里写入，要么一起成功，要么一起回滚，不会出现「占了键却没下单」的中间状态，因此不需要 `PROCESSING` 状态。`PlaceOrderService` 负责幂等，`PlaceOrderTxService` 负责事务，完整写法见 [数据建模 · 下单幂等](./2_data_model#八、下单幂等)，这里只看冲突分支：

```java
// com.qingyou.order.place.PlaceOrderService（节选）
try {
    // 一个事务：按 sku_id 升序扣库存，再写 t_order（biz_no = 幂等键）/ t_order_item
    return PlaceOrderResult.created(placeOrderTxService.create(userId, idemKey, req, items));
} catch (DuplicateKeyException e) {                 // uk_user_biz 冲突：这个键已经下过单
    return PlaceOrderResult.replayed(orderMapper.selectByUserAndBizNo(userId, idemKey));
}
```

```java
// com.qingyou.order.place.PlaceOrderController
@PostMapping("/api/orders")
public ResponseEntity<OrderView> place(@AuthenticationPrincipal LoginUser user,
        @RequestHeader("Idempotency-Key") @Size(min = 16, max = 64) String idemKey,
        @RequestBody @Validated(OnCreate.class) PlaceOrderRequest req) {
    PlaceOrderResult r = placeOrderService.place(user.id(), idemKey, req);
    OrderView view = OrderView.of(r.order());          // 对外只给 orderNo，不给主键 id
    return ResponseEntity.created(URI.create("/api/orders/" + view.orderNo()))
            .header("Idempotent-Replayed", String.valueOf(r.replayed()))
            .body(view);
}
```

重放放在事务外的 `catch` 里做，是因为冲突后原事务已经回滚，在新的读里才能看到对方已提交的订单。

---

## 六、列表分页

「我的订单」在 App 上是无限下拉，不需要跳页，也不需要总数，所以用游标分页，不用 `page/size`：

- **offset 越翻越慢**：`LIMIT 10000, 20` 要先扫过前 10000 行再丢掉，原理与优化见 [MySQL 索引 · 深度分页优化](/database/1_mysql/4_topic_index#九、深度分页优化)，线上案例见 [深分页拖垮数据库](/handbook/2_incidents/9_deep_paging)
- **offset 会重复或漏数据**：用户下拉时有新订单插进来，下一页的第一条会是上一页的最后一条
- **游标对客户端不透明**：`cursor` 是 Base64URL 编码的 `{"id":"..."}`，客户端原样回传即可；以后要改成按别的字段排序，只改编解码，接口不变

响应用 `CursorResult{items, nextCursor, hasMore}`，`size` 上限 50。查询落到 SQL 上是这样：

```sql
SELECT id, order_no, status, pay_amount, created_at
FROM t_order
WHERE user_id = ? AND id < ?              -- 游标里的上一页最后一个 id，首页不拼 id 条件
  AND status = ?                          -- 可选：status 为空时不拼
ORDER BY id DESC
LIMIT ?;                                  -- size + 1，多取一条判断 hasMore
```

雪花 ID 大致随时间递增，按 `id` 倒序就是按下单时间倒序。这条查询走 [数据建模](./2_data_model) 中的 `idx_user_id (user_id, id)`，索引本身按 `id` 有序，不需要额外排序；带 `status` 时在回表后过滤。游标里的 `id` 经过编码，客户端不应解析它。运营后台要按条件查、要跳页、要总数，单独走后台接口，用 offset 并限制最大页数。

---

## 七、参数校验

校验用 Bean Validation，在 Controller 入参上触发，Service 里不再重复判空。分组只用在**同一个对象被多个接口复用**的地方：收货地址 `AddressForm` 在下单时所有字段必填，在后来增加的「发货前改地址」`PATCH /api/orders/{orderNo}/address` 里只传要改的字段：

```java
public interface OnCreate extends Default {}
public interface OnPatch extends Default {}

public record AddressForm(
        @NotBlank(groups = OnCreate.class) @Size(max = 20) String receiver,
        @NotBlank(groups = OnCreate.class) @Pattern(regexp = "1\\d{10}") String phone,
        @NotBlank(groups = OnCreate.class) @Size(max = 200) String detail) {
}

public record PlaceOrderRequest(
        @NotEmpty @Size(max = 50) List<@Valid OrderLine> lines,
        @NotNull @Valid AddressForm address,
        @Size(max = 200) String remark) {
}
```

- **两个分组都继承 `Default`**：没写 `groups` 的格式约束（长度、手机号）在两个接口里都生效，`@NotBlank` 只在下单时生效；改地址时字段为 `null`，`@Pattern` 直接放行
- **分组会被 `@Valid` 级联带下去**：`@Validated(OnCreate.class)` 校验 `PlaceOrderRequest` 时，嵌套的 `AddressForm` 也按 `OnCreate` 校验
- **能拆 DTO 就不用分组**：分组多了，一个字段在哪个接口必填要对着注解推，可读性差；只有共享的嵌套对象才用

::: tip 常见坑
分组不继承 `Default` 时，`@Validated(OnCreate.class)` **只校验**标了 `OnCreate` 的约束，所有没写 `groups` 的注解静默失效，测试不覆盖很难发现。
:::

Web 层校验与异常的框架机制见 [Web 开发](/spring-boot/2_web_dev)。

---

## 八、版本与兼容

阶段一只有一个版本，但「版本从哪读」现在就要定。URL 路径 `/api/v1/orders` 网关好路由，可一升级所有路径都变，App 里写死的地址要全改；请求头 `API-Version` 让 URL 保持稳定，Framework 7 内置支持。选请求头，不带请求头的请求按 1.0 处理，老客户端不用改：

```yaml
spring:
  mvc:
    apiversion:
      default: 1.0
      use:
        header: API-Version
```

比「放在哪」更重要的是**尽量不升版本**：新增响应字段、新增可选参数、放宽校验都是兼容变更，直接发布；删字段、改类型、改错误码含义才是破坏性变更。订单状态枚举后面肯定会加值（如 `PARTIAL_REFUNDED`），因此现在就和前端约定：**遇到不认识的状态显示「处理中」，不报错**。兼容规则的完整清单见 [API 设计规范](/engineering/4_api_design_rule)，配置细节见 [Web 开发](/spring-boot/2_web_dev)。

---

## 九、鉴权

服务端 Session 随时可吊销，但两台主机要共享会话，阶段一还没有 Redis，App 和小程序处理 Cookie 也麻烦；JWT 无状态，两台主机都能独立校验，缺点是签发后无法撤销。

选 JWT，用两个令牌弥补不能撤销的问题：访问令牌有效期 30 分钟，放在 `Authorization: Bearer` 里；刷新令牌有效期 14 天，服务端只存它的哈希，改密码、踢下线时删掉即可。认证过滤器校验访问令牌后把 `LoginUser` 放进安全上下文，Controller 用 `@AuthenticationPrincipal` 取。登录方案的对比见 [认证与登录](/security/1_authentication)，令牌的签名与续期见 [JWT 令牌机制](/security/1_jwt)，限流、签名和防重放这类接口防护阶段一暂不做，见 [API 安全](/security/6_api_security)。

---

## 十、接口文档与契约

文档用 springdoc 3.x 从代码生成，不手写：

- `/v3/api-docs` 与 Swagger UI 只在开发和测试环境开启，生产关闭
- 每个接口显式写 `operationId`（如 `placeOrder`、`cancelOrder`），错误响应在文档里声明为 `ProblemDetail`
- CI 里导出 `openapi.json` 提交到仓库，和上一个版本做 diff，删字段、改类型这类破坏性变更直接让流水线失败

**暂不生成客户端 SDK**：调用方只有自己的三端，前端看文档写请求更快，生成的代码还要维护一条发布流程。到阶段三服务之间互相调用时，再考虑从 OpenAPI 生成客户端或用 HTTP 接口客户端。集成方式见 [接口文档](/spring-boot/8_api_doc)，导出与 CI 检查见 [API 文档](/engineering/5_api_doc)。

---

## 十一、接口测试

接口层的约定（状态码、响应头、错误码）最容易在重构中被悄悄改坏，每条约定至少有一个测试守住。下面用 `RestTestClient` 验证幂等重放，测试基类用 Testcontainers 拉起 MySQL：

```java
@AutoConfigureRestTestClient
class PlaceOrderApiTests extends IntegrationTestBase {

    @Autowired
    RestTestClient client;

    @Test
    void sameKeyReplaysFirstOrder() {
        String key = UUID.randomUUID().toString();
        String body = """
                {"lines":[{"skuId":"20001","quantity":2}],
                 "address":{"receiver":"张三","phone":"13800000000","detail":"杭州市西湖区"}}
                """;

        String first = placeOrder(key, body)
                .expectStatus().isCreated()
                .expectBody(OrderView.class).returnResult().getResponseBody().orderNo();

        placeOrder(key, body)
                .expectStatus().isCreated()
                .expectHeader().valueEquals("Idempotent-Replayed", "true")
                .expectBody().jsonPath("$.orderNo").isEqualTo(first);
    }

    private RestTestClient.ResponseSpec placeOrder(String key, String body) {
        return client.post().uri("/api/orders")
                .header(HttpHeaders.AUTHORIZATION, TestTokens.bearer(10001L))
                .header("Idempotency-Key", key)
                .contentType(MediaType.APPLICATION_JSON)
                .body(body)
                .exchange();
    }
}
```

同样的写法再补三条：取消已发货订单返回 409 和 `ORDER_STATUS_CONFLICT`，缺少 `Idempotency-Key` 返回 400，查别人的订单返回 404。测试基类、数据隔离与 CI 中的运行方式见 [集成测试](/testing/3_integration_test)。

---

## 十二、代价与后续

| 本篇的决策 | 带来的问题 | 在哪解决 |
|-----------|-----------|---------|
| 订单详情、列表直接查库 | 阶段二商品详情读约 2000 QPS，订单查询也跟着涨，数据库读压力大 | 下一篇 [引入缓存](./4_cache)：先缓存商品详情，订单查询走索引继续直查 |
| 后续动作都同步执行 | 支付成功后的通知、积分等动作塞在回调里，第三方一慢就拖累下单 | [异步化](./5_async) |
| 幂等靠单库唯一约束 | 拆服务后订单、库存、支付不在一个库里，一个事务包不住 | [跨服务一致性](./7_consistency) |
| 幂等只认键、不比对请求体 | 客户端复用键的 bug 会被当成重放，悄悄返回旧订单 | 需要时在 [数据建模](./2_data_model) 的订单表上补请求摘要列 |
| 没有限流与签名 | 大促时被刷接口没有防线 | 「稳定性」 |

按模块分前缀的错误码、请求头版本和 OpenAPI 契约，到阶段三拆服务时会直接变成服务边界上的约定，不用再迁移。

---

## 小结

- 资源直出 + 真实状态码，失败统一 `ProblemDetail`，扩展 `code` 与 `traceId`；业务码是字符串，按模块加前缀
- 状态流转用 `POST /api/orders/{orderNo}/cancel` 这类动作子资源，`orderNo` 一开始就用字符串
- 下单用 `Idempotency-Key` 请求头，键存进 `t_order.biz_no`，由 `uk_user_biz` 唯一约束兜底，冲突时在事务外查出首单重放
- 用户端订单列表用游标分页，不返回总数；后台查询另走 offset
- 校验分组只用于共享的嵌套对象，分组继承 `Default`；版本从 `API-Version` 请求头读，缺省 1.0，尽量只做兼容变更
- 鉴权用短期 JWT + 可吊销的刷新令牌；文档由 springdoc 生成，CI 做兼容性检查，暂不生成 SDK

---

## 参考资料

- RFC 9457 Problem Details for HTTP APIs：[https://www.rfc-editor.org/rfc/rfc9457](https://www.rfc-editor.org/rfc/rfc9457)
- The Idempotency-Key HTTP Header Field（IETF 草案）：[https://datatracker.ietf.org/doc/draft-ietf-httpapi-idempotency-key-header/](https://datatracker.ietf.org/doc/draft-ietf-httpapi-idempotency-key-header/)
- Spring Framework Reference · Error Responses：[https://docs.spring.io/spring-framework/reference/web/webmvc/mvc-ann-rest-exceptions.html](https://docs.spring.io/spring-framework/reference/web/webmvc/mvc-ann-rest-exceptions.html)
- Spring Framework Reference · API Versioning：[https://docs.spring.io/spring-framework/reference/web/webmvc-versioning.html](https://docs.spring.io/spring-framework/reference/web/webmvc-versioning.html)
- Jakarta Bean Validation 3.1 Specification：[https://jakarta.ee/specifications/bean-validation/3.1/](https://jakarta.ee/specifications/bean-validation/3.1/)

> 下一篇：[引入缓存](./4_cache) —— 读多写少的商品与订单查询怎么加缓存、怎么保证一致
