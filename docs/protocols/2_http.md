---
description: 方法与状态码、缓存、Cookie 与会话、长连接、HTTP/2、HTTP/3 与 QUIC、HttpClient
---

# HTTP

> 前置阅读：[TCP 与 UDP](./1_tcp_udp)

HTTP 的语义（方法、状态码、头部、缓存）由 RFC 9110 / 9111 统一定义，HTTP/1.1、2、3 只是不同的传输方式（RFC 9112 / 9113 / 9114）。本篇先讲语义与 Cookie，再讲三代传输的演进，以及在 Java 服务中正确设置缓存头、Cookie 和 HTTP 客户端。

---

## 一、报文结构

### 1、请求与响应

HTTP/1.1 的报文是纯文本：起始行 + 头部 + 空行 + 可选的消息体。

```http
POST /api/orders HTTP/1.1
Host: shop.example.com
Content-Type: application/json
Content-Length: 39
Authorization: Bearer eyJhbGciOi...

{"skuId": 1001, "quantity": 2}
```

```http
HTTP/1.1 201 Created
Location: /api/orders/88231
Content-Type: application/json
Cache-Control: no-store

{"orderId": 88231, "status": "CREATED"}
```

HTTP/2 和 HTTP/3 不再传这种文本，而是把起始行拆成 `:method`、`:path`、`:status` 等伪头部，和普通头部一起压缩后放进二进制帧，但语义完全相同。

### 2、需要关注的头部

| 头部 | 方向 | 作用 |
|------|------|------|
| `Host` | 请求 | 目标主机名，同一 IP 上多个站点靠它区分；HTTP/1.1 必填 |
| `Content-Type` / `Content-Length` | 双向 | 消息体的媒体类型与长度；长度未知时用 `Transfer-Encoding: chunked`（仅 1.1） |
| `Accept` / `Accept-Encoding` | 请求 | 内容协商：想要的媒体类型、压缩算法（gzip、br） |
| `Authorization` | 请求 | 凭证，常见 `Bearer <token>` |
| `Cache-Control` / `ETag` / `Last-Modified` | 响应 | 缓存控制与协商缓存的校验器，见第四节 |
| `Set-Cookie` / `Cookie` | 响应 / 请求 | 服务端下发、浏览器回传的会话状态，见第五节 |
| `Location` | 响应 | 重定向目标，或 201 时新资源的地址 |
| `Connection` | 双向 | 1.1 的逐跳头，`close` 表示用完关闭；HTTP/2、3 中禁止出现 |
| `X-Forwarded-For` / `Forwarded` | 请求 | 经过代理后传递客户端原始 IP（`Forwarded` 是 RFC 7239 的标准写法） |
| `Retry-After` | 响应 | 配合 429 / 503 告诉客户端多久后再试 |

---

## 二、方法语义：安全与幂等

RFC 9110 给方法定义了两个关键属性：

- **安全（safe）**：语义上只读，不改变服务器状态。爬虫、预取可以放心调用
- **幂等（idempotent）**：同一请求执行一次和执行多次，对服务器状态的影响相同。网络超时后客户端、网关可以自动重试

| 方法 | 用途 | 安全 | 幂等 | 可缓存 |
|------|------|------|------|--------|
| GET | 获取资源 | 是 | 是 | 是 |
| HEAD | 同 GET，但只要头部 | 是 | 是 | 是 |
| OPTIONS | 查询支持的方法，CORS 预检 | 是 | 是 | 否 |
| POST | 提交数据、创建资源、执行动作 | 否 | 否 | 仅在显式声明时 |
| PUT | 整体替换资源 | 否 | 是 | 否 |
| DELETE | 删除资源 | 否 | 是 | 否 |
| PATCH | 部分修改（RFC 5789） | 否 | 不保证 | 否 |

几个容易说错的点：

- **幂等说的是服务器状态，不是响应**：第二次 DELETE 返回 404 而第一次返回 204，仍然是幂等的
- **GET 与 POST 的区别是语义**，不是“GET 参数在 URL、POST 在 body”：GET 带 body 没有定义好的语义，很多代理会丢弃；URL 长度限制来自浏览器和服务器实现（常见 8 KB 左右），协议本身没有规定；POST 放 body 也不等于“更安全”，没有 TLS 一样是明文
- **非幂等的 POST 不能盲目重试**：网关、HTTP 客户端的自动重试应只对幂等方法开启；下单这类 POST 要靠幂等键在业务层兜底，见 [幂等设计](/architecture/5_idempotence)

---

## 三、状态码

| 状态码 | 含义 | 实际场景 |
|--------|------|----------|
| 101 Switching Protocols | 协议切换 | WebSocket 握手成功 |
| 103 Early Hints | 提前提示 | 服务端还在生成页面时先告诉浏览器 `Link: rel=preload` 的资源（RFC 8297） |
| 200 OK | 成功 | — |
| 201 Created | 已创建 | POST 创建资源，配 `Location` |
| 204 No Content | 成功无响应体 | DELETE、PUT 成功 |
| 206 Partial Content | 部分内容 | `Range` 断点续传、视频拖动 |
| 301 / 308 | 永久重定向 | 308 要求保持原方法和 body，301 允许浏览器把 POST 改成 GET |
| 302 / 307 | 临时重定向 | 307 保持原方法，302 历史上会被改成 GET |
| 303 See Other | 去别处 GET | 表单 POST 后跳到结果页，防止刷新重复提交 |
| 304 Not Modified | 协商缓存命中 | 无响应体，客户端用本地副本 |
| 400 Bad Request | 请求格式或参数错误 | 参数校验失败 |
| 401 Unauthorized | 未认证 | 没带凭证或 Token 过期，应带 `WWW-Authenticate` |
| 403 Forbidden | 已认证但无权限 | 越权访问 |
| 404 Not Found | 资源不存在 | — |
| 405 Method Not Allowed | 方法不支持 | 对只读资源发 DELETE |
| 409 Conflict | 状态冲突 | 乐观锁版本冲突、重复创建 |
| 429 Too Many Requests | 被限流 | 配 `Retry-After` |
| 500 Internal Server Error | 服务端未处理的异常 | — |
| 502 Bad Gateway | 网关从上游拿到了无效响应 | 上游进程挂了、连接被重置、上游返回非法报文 |
| 503 Service Unavailable | 暂时不可用 | 过载、维护、熔断打开 |
| 504 Gateway Timeout | 网关等上游超时 | 上游太慢，超过网关的读超时 |

排查网关报错时，**502 看上游是否活着、连接是否被异常关闭（常见是上游 keep-alive 超时比网关短，见第六节）；504 看上游耗时和网关超时配置**。业务接口用哪些状态码、错误体怎么设计，见 [API 设计规范](/engineering/7_api_design_rule)。

---

## 四、缓存

HTTP 缓存（RFC 9111）分两层：**强缓存**判断“还能不能直接用”，不发请求；过期后走**协商缓存**，带校验器问服务器“变了没有”，没变就回 304，省掉响应体。

![HTTP 缓存判断流程](../assets/protocols/http-cache-flow.svg)

### 1、强缓存：Cache-Control

| 指令 | 含义 |
|------|------|
| `max-age=N` | N 秒内新鲜，直接用；优先级高于旧的 `Expires` 绝对时间 |
| `s-maxage=N` | 只对 CDN、代理等共享缓存生效，覆盖 `max-age` |
| `public` / `private` | 是否允许共享缓存存；带用户数据的响应用 `private` |
| `no-cache` | **可以存**，但每次使用前都要协商（不是“不缓存”） |
| `no-store` | 完全不存，适合敏感数据 |
| `must-revalidate` | 过期后必须协商成功才能用，不允许拿过期副本凑合 |
| `immutable` | 新鲜期内内容不会变，浏览器刷新时也不必协商 |
| `stale-while-revalidate=N` | 过期后 N 秒内先返回旧副本，后台再刷新（RFC 5861） |

### 2、协商缓存：ETag 与 Last-Modified

| 校验器 | 服务端响应头 | 客户端条件请求头 | 特点 |
|--------|--------------|------------------|------|
| 实体标签 | `ETag: "v42"` | `If-None-Match: "v42"` | 精确；`W/` 前缀表示弱校验（语义相同即可） |
| 修改时间 | `Last-Modified` | `If-Modified-Since` | 只到秒级，1 秒内多次修改或内容没变但时间变了都会误判 |

两者都带时，服务器优先比较 `If-None-Match`。多实例部署时 ETag 要基于内容或版本号生成，不能用各实例不同的文件 inode 之类的值，否则协商永远失败。

### 3、常用组合

| 资源 | 推荐响应头 | 原因 |
|------|-----------|------|
| 带内容哈希的静态资源（`app.3f9a.js`） | `Cache-Control: public, max-age=31536000, immutable` | 内容变了文件名就变，可以永久缓存 |
| HTML 入口页 | `Cache-Control: no-cache` + `ETag` | 每次协商，保证能拿到新版本的资源引用 |
| 公共只读接口 | `Cache-Control: public, max-age=60` | 让 CDN 吸收热点读 |
| 带用户数据的接口 | `Cache-Control: private, no-store` | 防止被 CDN、代理缓存后串给别人 |

响应随某个请求头变化时（如按 `Accept-Encoding` 返回 gzip 或 br），要加 `Vary` 让缓存按该头分别存储。

Spring MVC 里返回带 `ETag` 的 `ResponseEntity`，框架会自动比对条件请求头，命中时直接回 304、不带响应体：

```java
@GetMapping("/products/{id}")
public ResponseEntity<ProductView> get(@PathVariable long id) {
    ProductView view = productService.find(id);               // …
    return ResponseEntity.ok()
            .cacheControl(CacheControl.maxAge(Duration.ofMinutes(5)).cachePrivate())
            .eTag(Long.toString(view.version()))              // 用版本号作 ETag
            .body(view);
}
```

CDN 层的缓存与回源策略见 [缓存最佳实践](/cache/11_cache_rule)。

---

## 五、Cookie、Session 与 Token

HTTP 本身无状态，登录态要么放在 Cookie 里由浏览器自动携带，要么由客户端放进 `Authorization` 头。

### 1、Cookie 的安全属性

| 属性 | 作用 | 建议 |
|------|------|------|
| `HttpOnly` | JS 读不到该 Cookie | 会话 Cookie 必开，降低 XSS 窃取风险 |
| `Secure` | 只在 HTTPS 下发送 | 生产环境必开 |
| `SameSite=Strict` | 跨站请求一律不带 | 安全性最高，但从外链点进来会丢登录态 |
| `SameSite=Lax` | 跨站只在顶层导航的 GET 中携带 | 兼顾体验与 CSRF 防护；Chrome、Edge 对未声明的 Cookie 按 Lax 处理 |
| `SameSite=None` | 跨站也带 | 第三方嵌入场景才用，必须同时带 `Secure` |
| `Domain` / `Path` | 作用范围 | `Domain` 不写时只对当前主机生效，范围越小越安全 |
| `Max-Age` / `Expires` | 有效期 | 都不写就是会话 Cookie，关闭浏览器即失效 |

```java
ResponseCookie cookie = ResponseCookie.from("SESSION", sessionId)
        .httpOnly(true)
        .secure(true)
        .sameSite("Lax")
        .path("/")
        .maxAge(Duration.ofHours(2))
        .build();
return ResponseEntity.noContent()
        .header(HttpHeaders.SET_COOKIE, cookie.toString())
        .build();
```

用 Spring Session 或容器 Session 时，同样的属性可以通过 `server.servlet.session.cookie.*`（如 `same-site`、`secure`、`http-only`）配置。

### 2、Session 与 Token 怎么选

| 维度 | 服务端 Session（Cookie 存 ID） | 自包含 Token（如 JWT） |
|------|-------------------------------|------------------------|
| 状态存在哪 | 服务端（单机内存或 Redis） | Token 本身，服务端只验签 |
| 水平扩展 | 需要共享存储（Spring Session + Redis） | 天然无状态 |
| 主动失效 | 删掉 Session 即可 | 难，需要黑名单或短有效期 + 刷新令牌 |
| 携带方式 | 浏览器自动带 Cookie，要防 CSRF | 客户端手动放 `Authorization` 头，天然不受 CSRF 影响 |
| 适合 | 传统 Web、同域前后端 | App、跨域、服务间调用 |

Token 的结构、签名与吊销见 [JWT 令牌机制](/security/1_jwt)，CSRF 的原理与防护见 [常见漏洞与防护](/security/8_vulnerabilities)，Token 在 API 网关上的设计见 [API 安全](/security/6_api_security)。

---

## 六、连接管理与 HTTP/1.1 队头阻塞

### 1、持久连接

- **HTTP/1.0** 默认每个请求新建一条 TCP 连接，用完即关；部分实现支持非标准的 `Connection: keep-alive` 扩展来复用连接
- **HTTP/1.1** 默认持久连接，一条 TCP 连接上可以顺序发多个请求，任一方发 `Connection: close` 才关闭

持久连接要两端配合超时：**客户端连接池的空闲超时要小于服务端（或上游网关）的 keep-alive 超时**。反过来时，服务端先关了空闲连接，客户端再从池里拿这条连接发请求，就会收到连接重置，表现为偶发的 `NoHttpResponseException` 或网关 502。

TCP 的 keepalive（内核探活）、HTTP 的 keep-alive（连接复用）和应用层心跳是三件不同的事，区别见 [心跳与连接管理](/netty/9_heartbeat)。

### 2、HTTP 层的队头阻塞

HTTP/1.1 的一条连接上，响应必须按请求顺序返回。前一个响应慢，后面的请求只能排队，这就是 **HTTP 层的队头阻塞**。

- **管线化（pipelining）**：允许不等响应就连发多个请求，但响应仍须按序，慢请求照样堵住后面；加上中间代理兼容性差，主流浏览器都没有启用
- **浏览器的应对**：对同一主机并发开多条连接（Chrome 为 6 条），以及把资源分散到多个域名（域名分片）。这些做法增加了握手和拥塞控制的开销，HTTP/2 出现后反而是负优化

---

## 七、HTTP/2

HTTP/2（RFC 9113，取代 RFC 7540）不改语义，只改传输方式，目标是在**一条 TCP 连接**上并发处理所有请求。

### 1、二进制分帧、流与多路复用

- **帧（frame）**：最小传输单位，类型有 `HEADERS`、`DATA`、`SETTINGS`、`WINDOW_UPDATE`、`RST_STREAM`、`PING`、`GOAWAY` 等，每帧带所属流的 ID
- **流（stream）**：一次请求 / 响应就是一个流，客户端发起的流用奇数 ID。单个流可以用 `RST_STREAM` 取消，不影响连接上的其他流
- **多路复用**：不同流的帧可以交错发送，接收端按流 ID 重新组装。响应不再需要按请求顺序返回，HTTP 层的队头阻塞消失

### 2、HPACK 头部压缩

HTTP/1.1 每个请求都重复发送 `Cookie`、`User-Agent` 等大头部。HPACK（RFC 7541）用三招压缩：

- **静态表**：61 个常见头部（如 `:method: GET`）直接用一个索引号表示
- **动态表**：连接内发过的头部存进表里，后续请求只发索引
- **Huffman 编码**：对字面值再做一次压缩

动态表是连接级状态，这也是 HTTP/2 必须保证头部帧按序处理的原因之一。

### 3、流量控制与优先级

- **流量控制**：每个流和整条连接各有一个接收窗口，靠 `WINDOW_UPDATE` 帧扩大，防止一个大下载占满接收缓冲
- **优先级**：RFC 7540 的依赖树优先级方案实现复杂、各家支持不一，RFC 9113 已将其废弃；新方案是 RFC 9218 的 `Priority` 头（urgency + incremental），HTTP/2 和 HTTP/3 通用

### 4、Server Push 已退场

Server Push 允许服务端在客户端请求前主动推送资源，但实践中很难推准（客户端可能已有缓存），浪费带宽。Chrome 从 106 版起默认禁用，Firefox 也已移除。RFC 9113 仍保留该机制，但客户端可用 `SETTINGS_ENABLE_PUSH=0` 关掉。现在的替代方案是 **103 Early Hints + `Link: rel=preload`**：只提示，由浏览器自己决定是否去拿。

### 5、仍然存在的 TCP 层队头阻塞

所有流共用一条 TCP 连接，而 TCP 只认字节序：**任意一个包丢了，后面所有流的数据都要等它重传完才能交给应用**。丢包率高的移动网络下，HTTP/2 甚至可能比开 6 条连接的 HTTP/1.1 更慢。这是 HTTP/3 换掉 TCP 的直接原因。

### 6、h2 与 h2c

| 方式 | 说明 | 场景 |
|------|------|------|
| h2 | 基于 TLS，靠 ALPN 扩展在握手时协商出 `h2` | 浏览器只支持这一种 |
| h2c | 明文 HTTP/2，客户端事先知道对端支持（prior knowledge）直接发 | 网关卸载 TLS 后的内网、gRPC 内部调用 |

RFC 9113 已废弃早期从 HTTP/1.1 用 `Upgrade: h2c` 升级的方式。Spring Boot 用 `server.http2.enabled=true` 开启 HTTP/2：配置了 SSL 时走 h2，未配置时走 h2c。

---

## 八、HTTP/3 与 QUIC

![HTTP/1.1、HTTP/2、HTTP/3 协议栈与并发方式](../assets/protocols/http-versions.svg)

### 1、为什么换成 UDP

TCP 实现在操作系统内核里，又被大量中间设备（防火墙、NAT）按固定格式解析，几乎无法再演进。QUIC（RFC 9000）选择在 UDP 之上、用户态里重新实现可靠传输、拥塞控制和多路复用，升级只需更新应用或库。HTTP/3（RFC 9114）就是跑在 QUIC 上的 HTTP。

### 2、QUIC 的关键特性

| 特性 | 说明 |
|------|------|
| 独立的流 | 每个流单独保证有序，一个流丢包只阻塞这个流，其他流照常交付；但**同一个流内部仍然按序**，丢包仍要等重传 |
| 内置 TLS 1.3 | 传输握手和 TLS 握手合并（RFC 9001），新连接 1-RTT 即可发数据；除少量头部外全部加密，中间设备看不到也改不了 |
| 0-RTT | 曾经连过的服务端，客户端可以在第一个包里就带上请求数据；但 0-RTT 数据**可以被重放**，只应用于幂等请求 |
| 连接迁移 | 连接由 Connection ID 标识，不再绑定四元组；手机从 Wi-Fi 切到 4G、IP 变了，连接也不用重建 |
| QPACK | HPACK 的变体（RFC 9204），把动态表更新放进单独的流，避免头部压缩重新引入队头阻塞 |

### 3、落地要点

- **发现**：浏览器先用 HTTP/2 或 1.1 访问，看到响应头 `Alt-Svc: h3=":443"` 后，后续请求改用 HTTP/3；也可以通过 DNS 的 HTTPS 记录（RFC 9460）提前得知
- **降级**：部分企业网络屏蔽 UDP 443，客户端必须能回落到 TCP 上的 HTTP/2
- **终结位置**：一般在 CDN 或边缘网关终结 HTTP/3，回源与服务间调用仍用 HTTP/1.1 或 h2c；Nginx 从 1.25 起提供 `ngx_http_v3_module`
- **代价**：用户态协议栈加全量加密，同等流量下 CPU 开销通常高于 TCP + TLS

---

## 九、版本对比

| 维度 | HTTP/1.0 | HTTP/1.1 | HTTP/2 | HTTP/3 |
|------|----------|----------|--------|--------|
| 传输层 | TCP | TCP | TCP | QUIC（基于 UDP） |
| 报文格式 | 文本 | 文本 | 二进制帧 | 二进制帧 |
| 连接复用 | 默认短连接（非标准 keep-alive 扩展） | 默认持久连接，请求串行 | 单连接多路复用 | 单连接多路复用 |
| 队头阻塞 | 有 | HTTP 层有 | HTTP 层消除，TCP 层仍有 | 消除跨流阻塞，单个流内仍按序 |
| 头部压缩 | 无 | 无 | HPACK | QPACK |
| 服务端推送 | 无 | 无 | 规范保留，主流浏览器已移除 | 规范定义，浏览器未实现 |
| 加密 | 可选 | 可选 | 浏览器只支持 TLS 上的 h2；内网可用 h2c | 强制 TLS 1.3 |
| 现状 | 基本淘汰 | 服务间调用与老客户端仍常见 | 浏览器与 gRPC 的主力协议 | CDN 与大型站点已普遍支持 |

服务端怎么选 HTTP 版本、连接池参数怎么配，属于性能调优话题，见 [IO 与网络优化](/high-perf/9_io_network)。

---

## 十、Java HttpClient

JDK 11 起标准库提供 `java.net.http.HttpClient`（JEP 321），支持 HTTP/1.1 和 HTTP/2、同步与异步调用，无需第三方依赖。JDK 26 起可以选择 HTTP/3（JEP 517），但默认仍是 HTTP/2。

```java
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;

public class HttpClientDemo {

    // 线程安全，内部维护连接池，整个应用复用一个实例，不要每次请求都新建
    private static final HttpClient CLIENT = HttpClient.newBuilder()
            .version(HttpClient.Version.HTTP_2)           // 优先 h2，对端不支持时自动降到 1.1
            .connectTimeout(Duration.ofSeconds(3))
            .followRedirects(HttpClient.Redirect.NORMAL)
            .build();

    public static void main(String[] args) {
        HttpRequest request = HttpRequest.newBuilder(URI.create("https://example.com/"))
                .timeout(Duration.ofSeconds(5))               // 等待响应的超时
                .header("Accept", "text/html")
                .GET()
                .build();

        // 异步调用返回 CompletableFuture，可与其他调用组合
        CLIENT.sendAsync(request, HttpResponse.BodyHandlers.ofString())
              .thenAccept(resp -> System.out.println(resp.version() + " " + resp.statusCode()))
              .join();
    }
}
```

- 同步调用用 `CLIENT.send(request, BodyHandlers.ofString())`，在虚拟线程里调用不会占用平台线程
- 一定要设 `connectTimeout` 和请求级 `timeout`，默认没有超时
- 在 Spring 应用里通常用 `RestClient`（Spring 6.1+）或 `WebClient`，它们可以以 JDK HttpClient 为底层实现；服务间调用的选型见 [服务通信](/spring-cloud/3_communication)

---

## 十一、相关协议：REST、WebSocket 与 SSE

**REST** 不是协议，而是基于 HTTP 语义设计接口的风格：用 URL 表示资源、用方法表示动作、用状态码表示结果。URL 命名、统一响应体、分页、版本管理等约定见 [API 设计规范](/engineering/7_api_design_rule)。

**WebSocket 与 SSE** 解决的是服务端主动推送：WebSocket 借 HTTP/1.1 的 `Upgrade` 握手（101 状态码）后切换成全双工的帧协议（RFC 6455）；SSE 则是一个不结束的 `text/event-stream` 响应，只能服务端到客户端单向推送，但天然复用 HTTP 的认证与代理。握手细节、帧格式和 Spring / Netty 实现分别见 [WebSocket](/netty/10_websocket) 和 [SSE（Server-Sent Events）](/netty/11_sse)。

---

## 小结

- 语义与传输分离：方法、状态码、头部、缓存在 RFC 9110 / 9111 中统一定义，1.1、2、3 只是不同的传输方式
- 安全方法只读，幂等方法可以安全重试；POST 重试要靠业务幂等键
- 502 是上游给了坏响应或连接被关，504 是上游太慢；客户端连接池空闲超时要短于服务端 keep-alive 超时
- 缓存先看强缓存（`Cache-Control: max-age`），过期再用 `ETag` / `Last-Modified` 协商，命中回 304；`no-cache` 是“每次协商”，`no-store` 才是“不存”
- 会话 Cookie 要 `HttpOnly`、`Secure`、`SameSite=Lax`；Session 便于主动失效，Token 便于无状态扩展
- HTTP/2 用二进制帧和流在一条 TCP 上多路复用，消除了 HTTP 层队头阻塞，但 TCP 层仍在；Server Push 已被 103 Early Hints 取代
- HTTP/3 基于 QUIC：流独立、内置 TLS 1.3、0-RTT（可重放，只用于幂等请求）、连接迁移
- JDK 11+ 的 `HttpClient` 默认协商 HTTP/2，要复用实例并显式设置超时
- HTTPS 的握手与证书放在下一篇；REST 接口的 URL 与状态码约定见 [API 设计规范](/engineering/7_api_design_rule)。

## 参考资料

- RFC 9110 HTTP Semantics：[https://www.rfc-editor.org/rfc/rfc9110.html](https://www.rfc-editor.org/rfc/rfc9110.html)
- RFC 9111 HTTP Caching：[https://www.rfc-editor.org/rfc/rfc9111.html](https://www.rfc-editor.org/rfc/rfc9111.html)
- RFC 9112 HTTP/1.1：[https://www.rfc-editor.org/rfc/rfc9112.html](https://www.rfc-editor.org/rfc/rfc9112.html)
- RFC 9113 HTTP/2：[https://www.rfc-editor.org/rfc/rfc9113.html](https://www.rfc-editor.org/rfc/rfc9113.html)
- RFC 9114 HTTP/3：[https://www.rfc-editor.org/rfc/rfc9114.html](https://www.rfc-editor.org/rfc/rfc9114.html)
- RFC 9000 QUIC：[https://www.rfc-editor.org/rfc/rfc9000.html](https://www.rfc-editor.org/rfc/rfc9000.html)
- RFC 9204 QPACK：[https://www.rfc-editor.org/rfc/rfc9204.html](https://www.rfc-editor.org/rfc/rfc9204.html)
- RFC 6265 HTTP State Management Mechanism（Cookie）：[https://www.rfc-editor.org/rfc/rfc6265.html](https://www.rfc-editor.org/rfc/rfc6265.html)
- RFC 8297 103 Early Hints：[https://www.rfc-editor.org/rfc/rfc8297.html](https://www.rfc-editor.org/rfc/rfc8297.html)
- JEP 321 HTTP Client：[https://openjdk.org/jeps/321](https://openjdk.org/jeps/321)
- JEP 517 HTTP/3 for the HTTP Client API：[https://openjdk.org/jeps/517](https://openjdk.org/jeps/517)
- Spring Framework HTTP Caching：[https://docs.spring.io/spring-framework/reference/web/webmvc/mvc-caching.html](https://docs.spring.io/spring-framework/reference/web/webmvc/mvc-caching.html)
- Spring Boot Configure HTTP/2：[https://docs.spring.io/spring-boot/how-to/webserver.html](https://docs.spring.io/spring-boot/how-to/webserver.html)

> 下一篇：[HTTPS 与 TLS](./3_https_tls) —— TLS 1.3 握手、ECDHE 与前向保密、证书链校验、SNI / ALPN / HSTS、mTLS 与 Spring Boot SSL Bundle。
