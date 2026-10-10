---
description: Router 与 Handler 链、请求体、参数校验、JWT 认证、统一异常、WebClient
---

# Vert.x Web 与 HTTP 客户端

> 前置阅读：[Event Loop 与 Verticle](./2_core)

Vert.x Web 提供路由与 Handler 链，用于搭建 REST 服务。本篇讲路由组织、请求体限制、参数校验、JWT 认证授权、统一错误处理、WebClient 调用下游，以及 SSE / WebSocket 与 OpenAPI Router。

---

## 一、Router 与 Handler 链

### 1、基本模型

Vert.x Core 的 `HttpServer` 只给一个 `requestHandler`，所有请求都进同一个回调。Vert.x Web 的 `Router` 把它变成**按顺序匹配的 Route 列表**，每个 Route 挂一个或多个 Handler，Handler 之间通过 `RoutingContext` 传递数据，调用 `ctx.next()` 进入下一个匹配的 Handler：

![Vert.x Web 请求处理链](../assets/vertx/web-handler-chain.svg)

```java
import io.vertx.core.Future;
import io.vertx.core.VerticleBase;
import io.vertx.core.http.HttpMethod;
import io.vertx.ext.web.Router;
import io.vertx.ext.web.handler.BodyHandler;
import io.vertx.ext.web.handler.LoggerHandler;
import io.vertx.ext.web.handler.ResponseTimeHandler;
import io.vertx.ext.web.handler.TimeoutHandler;

public class ApiVerticle extends VerticleBase {

  @Override
  public Future<?> start() {
    Router router = Router.router(vertx);

    // 1. 平台级 Handler：所有请求都经过
    router.route().handler(LoggerHandler.create());
    router.route().handler(ResponseTimeHandler.create());
    router.route().handler(TimeoutHandler.create(5_000));          // 5s 未响应返回 503

    // 2. 请求体：只挂在需要的路径上
    router.route("/api/*").handler(BodyHandler.create().setBodyLimit(1024 * 1024));

    // 3. 业务子路由
    router.route("/api/orders/*").subRouter(new OrderRoutes(vertx).router());

    // 4. 健康检查
    router.get("/health").handler(ctx -> ctx.response().end("UP"));

    return vertx.createHttpServer().requestHandler(router).listen(8080);
  }
}
```

### 2、路由匹配规则

| 规则 | 说明 |
|------|------|
| 匹配顺序 | 按注册顺序依次匹配，`route.order(n)` 可显式调整 |
| 路径参数 | `/orders/:id` 用 `ctx.pathParam("id")` 读取 |
| 通配 | `/api/*` 匹配前缀；正则用 `routeWithRegex` |
| 方法 | `router.get(...)`、`router.post(...)`，或 `route(HttpMethod.PUT, path)` |
| 内容协商 | `.consumes("application/json")`、`.produces("application/json")` |
| 子路由 | `route("/api/orders/*").subRouter(subRouter)`，子路由内路径相对挂载点 |

Handler 有三种结局：**写出响应**（`ctx.json(...)`、`ctx.response().end(...)`）、**交给下一个**（`ctx.next()`）、**失败**（`ctx.fail(...)`）。三者都没发生时请求会一直挂着，直到 `TimeoutHandler` 介入——这是 Vert.x Web 最常见的 bug。

### 3、阻塞 Handler

```java
router.post("/api/reports").blockingHandler(ctx -> {
  byte[] pdf = legacyReportSdk.generate(ctx.body().asJsonObject());  // 同步 SDK
  ctx.response().putHeader("Content-Type", "application/pdf").end(Buffer.buffer(pdf));
}, false);   // false：同一 Context 上的阻塞 Handler 可并行；默认 true 串行
```

`blockingHandler` 默认是**有序的**——同一 Event Loop 上的请求会排队串行进入 Worker，吞吐会很差。阻塞操作之间没有顺序依赖时一定传 `false`。更好的做法是把这类路由放到虚拟线程 Verticle 里处理。

---

## 二、请求体处理

### 1、BodyHandler

```java
BodyHandler.create()
    .setBodyLimit(1024 * 1024)               // 默认 10 MB，按接口实际需要收紧
    .setUploadsDirectory("/data/uploads")    // 默认 file-uploads（工作目录下）
    .setDeleteUploadedFilesOnEnd(true)       // 请求结束删除临时文件
    .setHandleFileUploads(false);            // 不接收文件上传的接口直接关闭
```

- 超过限制返回 **413**；默认 10 MB 对 JSON 接口太大，是被打内存的入口之一；
- **BodyHandler 必须挂在所有需要读取 body 的 Handler 之前**，官方建议尽早安装。Router 会先暂停（pause）进入的请求，等 BodyHandler 接管后再恢复读取，所以在它之前做认证之类的异步操作不会丢数据；但如果绕过 Router 直接处理 `HttpServerRequest`，就要自己先 `pause()`；
- 读取：`ctx.body().asJsonObject()`、`ctx.body().asPojo(Order.class)`、`ctx.body().buffer()`；上传文件：`ctx.fileUploads()`。

### 2、大文件与流式处理

大文件上传、下载不要用 BodyHandler 全量读入内存，直接操作流：

```java
router.put("/api/files/:name").handler(ctx -> {
  HttpServerRequest req = ctx.request();
  req.pause();                                // Router 已暂停请求，这里显式再暂停一次，表明打开文件期间不读取数据
  vertx.fileSystem().open("/data/" + safeName(ctx.pathParam("name")), new OpenOptions().setWrite(true))
      .compose(file -> req.pipeTo(file))      // 背压：磁盘写不过来时自动暂停读 socket
      .onSuccess(v -> ctx.response().setStatusCode(201).end())
      .onFailure(ctx::fail);
});
```

`pipeTo` 内部用 `pause()` / `resume()` 做流控，避免慢磁盘拖爆内存。注意文件名一定要做路径穿越校验。

---

## 三、参数校验

`vertx-web-validation` 基于 JSON Schema，在进入业务 Handler 之前完成类型转换与校验：

```java
import static io.vertx.json.schema.common.dsl.Keywords.maxLength;
import static io.vertx.json.schema.common.dsl.Keywords.minimum;
import static io.vertx.json.schema.common.dsl.Schemas.*;
import static io.vertx.ext.web.validation.builder.Parameters.optionalParam;

import io.vertx.ext.web.validation.RequestParameters;
import io.vertx.ext.web.validation.RequestPredicate;
import io.vertx.ext.web.validation.ValidationHandler;
import io.vertx.ext.web.validation.builder.Bodies;
import io.vertx.ext.web.validation.builder.ValidationHandlerBuilder;
import io.vertx.json.schema.JsonSchemaOptions;
import io.vertx.json.schema.SchemaRepository;
import io.vertx.json.schema.Draft;

SchemaRepository repo = SchemaRepository.create(
    new JsonSchemaOptions().setDraft(Draft.DRAFT7).setBaseUri("app://"));   // 迁移指南给出的写法：Draft-7

router.post("/api/orders")
    .handler(ValidationHandlerBuilder.create(repo)
        .queryParameter(optionalParam("dryRun", booleanSchema()))
        .body(Bodies.json(objectSchema()
            .requiredProperty("skuId", intSchema().with(minimum(1)))
            .requiredProperty("quantity", intSchema().with(minimum(1)))
            .optionalProperty("remark", stringSchema().with(maxLength(200)))))
        .predicate(RequestPredicate.BODY_REQUIRED)
        .build())
    .handler(ctx -> {
      RequestParameters params = ctx.get(ValidationHandler.REQUEST_CONTEXT_KEY);
      JsonObject body = params.body().getJsonObject();
      // 到这里参数已经保证合法
    });
```

校验失败时以 **400** 失败，异常是 `BadRequestException` 的子类（`ParameterProcessorException`、`BodyProcessorException`、`RequestPredicateException`），可以在 `router.errorHandler(400, ...)` 中统一转成错误响应。Vert.x 5 中 `SchemaParser` 已被 `SchemaRepository` 取代，外部 `$ref` 引用的 Schema 需要事先加载进仓库。

---

## 四、认证与授权

### 1、JWT 认证

```java
import io.vertx.ext.auth.PubSecKeyOptions;
import io.vertx.ext.auth.JWTOptions;
import io.vertx.ext.auth.jwt.JWTAuth;
import io.vertx.ext.auth.jwt.JWTAuthOptions;
import io.vertx.ext.web.handler.JWTAuthHandler;

JWTAuth jwtAuth = JWTAuth.create(vertx, new JWTAuthOptions()
    .addPubSecKey(new PubSecKeyOptions()
        .setAlgorithm("RS256")
        .setBuffer(config().getString("jwt.publicKeyPem")))
    .setJWTOptions(new JWTOptions()
        .setIssuer("https://auth.example.com")
        .addAudience("order-service")));

router.route("/api/*").handler(JWTAuthHandler.create(jwtAuth));
```

`JWTAuthHandler` 从 `Authorization: Bearer ...` 读取令牌，校验签名、`exp` / `nbf` / `iat`，以及配置了的 `iss` / `aud`，成功后把用户写入 `ctx.user()`，失败返回 **401**。资源服务只需要公钥；签发令牌应当集中在认证中心。JWT 的结构、算法选择与吊销问题见 [JWT 令牌机制](/security/1_jwt)。

### 2、授权

```java
import io.vertx.ext.auth.authorization.PermissionBasedAuthorization;
import io.vertx.ext.auth.jwt.authorization.JWTAuthorization;
import io.vertx.ext.web.handler.AuthorizationHandler;

router.post("/api/orders/*")
    .handler(AuthorizationHandler.create(PermissionBasedAuthorization.create("order:write"))
        .addAuthorizationProvider(JWTAuthorization.create("permissions")));
```

`JWTAuthorization` 从令牌的指定 claim（这里是 `permissions`）中读取权限；Keycloak 风格的令牌可以用 `realm_access/roles` 这样的路径。权限不足返回 **403**。

### 3、其他安全 Handler

| Handler | 作用 |
|---------|------|
| `CorsHandler` | 跨域，**明确列出允许的 Origin**，不要用通配符配合凭证 |
| `CSRFHandler` | 基于 Cookie 会话的表单应用需要；纯 Bearer Token API 通常不需要 |
| `HSTSHandler` / `CSPHandler` / `XFrameHandler` | 常见安全响应头 |
| `RateLimit` | Vert.x Web 没有内建限流 Handler，通常在网关做，或用 Redis 自行实现 |

---

## 五、统一错误处理

```java
router.route().failureHandler(ctx -> {
  Throwable err = ctx.failure();
  int status = ctx.statusCode() > 0 ? ctx.statusCode() : 500;

  if (err instanceof BizException be) {
    status = be.httpStatus();
  } else if (err instanceof BadRequestException bre) {
    status = 400;
  }
  if (status >= 500) {
    log.error("request failed {} {}", ctx.request().method(), ctx.normalizedPath(), err);
  }
  if (!ctx.response().ended()) {
    ctx.response().setStatusCode(status)
        .putHeader("Content-Type", "application/json")
        .end(new JsonObject()
            .put("code", status)
            .put("message", status >= 500 ? "internal error" : String.valueOf(err == null ? "" : err.getMessage()))
            .encode());
  }
});

router.errorHandler(404, ctx -> ctx.json(new JsonObject().put("code", 404).put("message", "not found")));
```

| 触发方式 | `statusCode()` | `failure()` |
|----------|----------------|-------------|
| `ctx.fail(403)` | 403 | 不保证有值，以状态码为准 |
| `ctx.fail(400, exception)` | 400 | 异常对象 |
| `ctx.fail(exception)` | 未显式设置，按 500 处理 | 异常对象 |
| Handler 同步抛异常 | 同 `fail(exception)` | 异常对象 |
| 异步回调中抛异常 | **不会进入 failureHandler**，交给 Vert.x 全局异常处理器，请求挂起 | — |

最后一行是重点：**Future 链的失败要显式 `.onFailure(ctx::fail)`**，否则既没有错误响应，也没有日志。

- 生产环境不要把异常堆栈和内部错误信息返回给客户端，5xx 只返回通用信息与 traceId；
- `errorHandler(code, handler)` 处理路由级失败（如 404 无匹配、405 方法不允许），`failureHandler` 处理 Route 内的失败，两者配合覆盖全部情况；
- 错误响应体格式与状态码规范见 [API 设计规范](/engineering/7_api_design_rule)。

---

## 六、WebClient

### 1、创建与复用

```java
import io.vertx.core.http.HttpClient;
import io.vertx.core.http.HttpClientOptions;
import io.vertx.core.http.PoolOptions;
import io.vertx.core.net.endpoint.LoadBalancer;
import io.vertx.ext.web.client.WebClient;

HttpClient httpClient = vertx.httpClientBuilder()
    .with(new HttpClientOptions()
        .setConnectTimeout(1_000)
        .setKeepAlive(true)
        .setKeepAliveTimeout(30))
    .with(new PoolOptions()
        .setHttp1MaxSize(50)            // 默认 5，对高并发下游明显不够
        .setMaxWaitQueueSize(200))      // 默认 -1 无界，必须设上限
    .withLoadBalancer(LoadBalancer.ROUND_ROBIN)
    .build();

WebClient client = WebClient.wrap(httpClient);
```

- **WebClient 应在 Verticle 启动时创建一次并复用**，每次请求新建客户端会导致连接无法复用；
- HTTP/1.1 连接池默认每个目标只有 5 个连接，等待队列无界：下游一慢，请求就在队列里无限堆积。按下游容量设置 `http1MaxSize` 与 `maxWaitQueueSize`；
- 客户端负载均衡支持 `ROUND_ROBIN`、`LEAST_REQUESTS`、`POWER_OF_TWO_CHOICES`、`CONSISTENT_HASHING`；默认只用 DNS 解析出的第一个 IP。

### 2、发请求

```java
import io.vertx.core.http.HttpResponseExpectation;
import io.vertx.ext.web.codec.BodyCodec;

public Future<User> getUser(long id) {
  return client.get(8080, "user-service", "/users/" + id)
      .putHeader("x-trace-id", traceId)
      .timeout(2_000)                                   // 同时设置连接超时与空闲超时
      .as(BodyCodec.json(User.class))
      .send()
      .expecting(HttpResponseExpectation.SC_SUCCESS)    // 非 2xx 转为失败
      .map(HttpResponse::body);
}
```

**不设置 `expecting` 时，只有网络错误才会让 Future 失败**，404、500 都算成功——这是从 RestTemplate、Feign 迁过来的人最容易踩的坑。超时可以细分为 `connectTimeout`（获取连接）与 `idleTimeout`（无数据到达），`timeout` 同时设置两者。

### 3、熔断与重试

```java
import io.vertx.circuitbreaker.CircuitBreaker;
import io.vertx.circuitbreaker.CircuitBreakerOptions;

CircuitBreaker breaker = CircuitBreaker.create("user-service", vertx,
    new CircuitBreakerOptions()
        .setMaxFailures(5)          // 近期失败达到 5 次打开（按滚动窗口统计）
        .setTimeout(2_000)          // 单次调用超时
        .setResetTimeout(10_000)    // 10s 后进入半开
        .setMaxRetries(0));         // 非幂等接口不要重试

Future<User> user = breaker.execute(() -> getUser(id))          // Supplier<Future<T>> 形式
    .recover(err -> Future.succeededFuture(User.anonymous()));   // 降级
```

重试只能用于幂等接口，而且要配合退避；熔断、超时预算的系统级策略见 [熔断](/high-avail/5_circuit_breaking) 与 [超时、重试与隔离](/high-avail/4_timeout_retry_bulkhead)。

---

## 七、SSE 与 WebSocket

### 1、SSE

Vert.x Web 没有专门的 SSE Handler，用分块响应即可：

```java
router.get("/api/stream/prices").handler(ctx -> {
  HttpServerResponse resp = ctx.response()
      .setChunked(true)
      .putHeader("Content-Type", "text/event-stream")
      .putHeader("Cache-Control", "no-cache");

  MessageConsumer<JsonObject> consumer = vertx.eventBus().localConsumer("push.price", msg ->
      resp.write("event: price\ndata: " + msg.body().encode() + "\n\n"));
  long heartbeat = vertx.setPeriodic(15_000, id -> resp.write(": ping\n\n"));

  resp.closeHandler(v -> {                 // 客户端断开时清理，否则 consumer 与定时器泄漏
    consumer.unregister();
    vertx.cancelTimer(heartbeat);
  });
});
```

### 2、WebSocket

```java
vertx.createHttpServer()
    .webSocketHandler(ws -> {
      if (!"/ws/chat".equals(ws.path())) {
        ws.close((short) 1008);
        return;
      }
      ws.textMessageHandler(text -> ws.writeTextMessage("echo: " + text));
      ws.closeHandler(v -> log.info("closed {}", ws.remoteAddress()));
    })
    .requestHandler(router)
    .listen(8080);
```

Vert.x 5 把服务端握手拆成 `webSocketHandshakeHandler`（在其中 `accept()` / `reject()`，适合做鉴权）与 `webSocketHandler`。连接数大时，要配合 Event Bus `publish` 把消息推到持有连接的节点。SSE 与 WebSocket 的协议细节、心跳、集群推送方案见 [SSE（Server-Sent Events）](/netty/11_sse) 与 [WebSocket](/netty/10_websocket)。

---

## 八、OpenAPI Router（契约优先）

`vertx-web-openapi-router`（Preview）从 OpenAPI 3.0 / 3.1 契约生成路由，自动完成参数与请求体校验：

```java
import io.vertx.ext.web.openapi.router.RouterBuilder;
import io.vertx.openapi.contract.OpenAPIContract;
import io.vertx.openapi.validation.ValidatedRequest;

public Future<?> start() {
  return OpenAPIContract.from(vertx, "openapi.yaml")
      .compose(contract -> {
        RouterBuilder builder = RouterBuilder.create(vertx, contract);

        builder.security("bearerAuth").httpHandler(JWTAuthHandler.create(jwtAuth));

        builder.getRoute("createOrder").addHandler(ctx -> {
          ValidatedRequest req = ctx.get(RouterBuilder.KEY_META_DATA_VALIDATED_REQUEST);
          JsonObject body = req.getBody().getJsonObject();
          // 业务处理……
        });

        Router router = builder.createRouter();
        return vertx.createHttpServer().requestHandler(router).listen(8080);
      });
}
```

- 契约中每个安全方案都必须通过 `builder.security(name)` 配置对应 Handler，否则构建失败；
- 路由按 `operationId` 绑定，契约变更时没有实现的操作会很快暴露；
- 模块仍是 Preview，API 可能在小版本间调整；4.x 的 `vertx-web-openapi` 在 5.x 中已被删除。

---

## 小结

- Router 按注册顺序匹配，Handler 要么写响应、要么 `next()`、要么 `fail()`；三者都没有时请求挂起
- BodyHandler 默认限制 10 MB，应按接口收紧，并放在读取 body 的 Handler 之前；大文件用 `pipeTo` 流式处理
- `blockingHandler` 默认串行，独立任务传 `false`；`vertx-web-validation` 基于 JSON Schema 校验，失败返回 400
- `JWTAuthHandler` 认证（401）+ `AuthorizationHandler` 授权（403）；`failureHandler` 与 `errorHandler(code)` 配合统一错误响应，异步失败要显式 `ctx::fail`
- WebClient 创建一次复用；连接池默认 5、等待队列无界，必须调整；不加 `expecting` 时 4xx / 5xx 不会失败
- SSE 用分块响应并在 `closeHandler` 中清理资源；Vert.x 5 拆分 WebSocket 握手；OpenAPI Router 按 `operationId` 绑定，仍为 Preview

## 参考资料

- Vert.x Web：[https://vertx.io/docs/vertx-web/java/](https://vertx.io/docs/vertx-web/java/)
- Vert.x Web Validation：[https://vertx.io/docs/vertx-web-validation/java/](https://vertx.io/docs/vertx-web-validation/java/)
- Vert.x Auth JWT：[https://vertx.io/docs/vertx-auth-jwt/java/](https://vertx.io/docs/vertx-auth-jwt/java/)
- Vert.x Web Client：[https://vertx.io/docs/vertx-web-client/java/](https://vertx.io/docs/vertx-web-client/java/)
- Vert.x OpenAPI Router（Preview）：[https://vertx.io/docs/vertx-web-openapi-router/java/](https://vertx.io/docs/vertx-web-openapi-router/java/)

> 下一篇：[响应式数据访问](./5_data) —— 用响应式 SQL、Redis 与 Kafka 客户端，让数据访问也不阻塞 Event Loop。
