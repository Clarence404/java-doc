---
description: OWASP API Top 10、调用方认证、HMAC 签名与防重放、API Key、BOLA 与批量赋值、校验、CORS 与安全头
---

# API 安全

> **本篇目标**：知道一个对外 API 最常见的风险在哪（OWASP API Security Top 10 2023）；能为不同调用方选认证方式，写出正确的 HMAC 签名 + 时间戳 + nonce 防重放校验；会存放和轮换 API Key；能在代码里挡住越权访问（BOLA）和批量赋值；会在 Spring Security 7 里配好资源服务器、CORS 与安全响应头，并收敛错误信息和运维端点。
>
> **前置阅读**：[JWT 令牌机制](./1_jwt)、[OAuth2](./2_oauth2)、[Spring Security](/spring/9_security)（过滤器链与认证流程）

API 安全要回答三个问题：**调用方是谁**（认证）、**它能动哪些数据**（授权）、**它能用多少资源**（限流与资源限制）。本篇以 Spring Boot 4 / Spring Security 7 为基线。过滤器链与认证流程的原理在 [Spring Security](/spring/9_security)，限流算法在 [限流与过载保护](/high-avail/7_rate_limiting)，TLS 在 [HTTPS 与 TLS](/protocols/3_https_tls)，本篇只讲 API 这一层怎么做。

---

## 一、API 面临的主要风险

OWASP 在 2023 年发布了第二版 API Security Top 10。前几名几乎都是**授权**问题，而不是注入：

| 编号 | 风险 | 一句话解释 | 本篇对应 |
|------|------|------------|----------|
| API1 | 对象级授权失效（BOLA） | 改一下 URL 里的 ID 就能看别人的订单 | 第五节 |
| API2 | 认证失效 | 令牌不校验签名、不过期，密码接口可被撞库 | 第二～四节 |
| API3 | 对象属性级授权失效（BOPLA） | 响应多返回了敏感字段，或请求能改不该改的字段 | 第五节 |
| API4 | 资源消耗不受限 | 不限分页大小、请求体大小、调用频率 | 第六节 |
| API5 | 功能级授权失效 | 普通用户能调管理接口 | 第五节、[RBAC 与 ABAC](./5_rbac_abac) |
| API6 | 敏感业务流不受限 | 脚本批量抢券、刷注册 | 第六节 |
| API7 | 服务端请求伪造（SSRF） | 服务端替用户去请求任意 URL | [常见漏洞与防护](./8_vulnerabilities) |
| API8 | 安全配置错误 | CORS 放开 `*`、错误信息带堆栈、Actuator 全暴露 | 第七、八节 |
| API9 | 资产管理不当 | 老版本接口、测试环境接口没下线 | 网关统一登记 |
| API10 | 不安全地使用第三方 API | 盲目信任上游返回的数据 | 对上游响应同样做校验 |

---

## 二、调用方认证：按调用方选方案

不同调用方适合不同的认证方式，没有一种通吃：

| 方案 | 适用调用方 | 优点 | 缺点 |
|------|------------|------|------|
| API Key（Bearer） | 内部工具、低风险只读接口 | 实现最简单 | Key 随请求传输，泄露即失守；不防篡改、不防重放 |
| HMAC 签名 + 时间戳 + nonce | 合作方服务端（Open API、支付回调） | Secret 不上网络；防篡改、防重放 | 双方都要实现规范串，排错成本高 |
| OAuth2 Bearer Token（JWT） | 自家前端、App、第三方应用 | 标准化，有过期与作用域 | 需要授权服务器；Token 泄露期内可被冒用 |
| mTLS | 服务间调用、高安全合作方 | 身份绑定到证书，传输层即完成认证 | 证书签发与轮换要有配套体系，见 [零信任架构](./9_zero_trust) |

**网关统一认证**：多服务时把认证放到网关（Spring Cloud Gateway、APISIX、Kong 等），网关做验签、验 Token、限流，再把调用方身份通过内部头传给下游。下游服务仍要校验来源（只接受来自网关或网格内的流量，或再次校验 JWT），不能因为"网关验过了"就信任任意请求里的身份头。网关作为 Resource Server 的配置见 [API 网关](/spring-cloud/2_api_gateway)。

---

## 三、接口签名与防重放

签名解决"请求有没有被改过、是不是持有 Secret 的人发的"；时间戳 + nonce 解决"合法请求被截获后原样重发"。三者缺一不可。

![HMAC 签名与防重放流程](../assets/security/security-api-sign-verify.svg)

### 规范串怎么拼

签名只覆盖参数是不够的：攻击者可以把同一组参数挪到另一个路径、换一个 HTTP 方法，或者改请求体。规范串至少包含以下几项，用换行分隔：

1. HTTP 方法（大写）
2. 请求路径（客户端实际发送的路径，含上下文路径）
3. 查询串：按 `&` 拆开后字典序排序，保持原始编码
4. 时间戳（Unix 秒）
5. nonce（每次请求随机生成，如 UUID）
6. 请求体的 SHA-256 十六进制摘要（无请求体时对空字节数组求摘要）

服务端只认这个固定格式。经过网关改写路径时，签名要按**外部路径**在网关上校验，否则下游拿到的路径和客户端签名时不一致。业界也有标准化方案 RFC 9421（HTTP Message Signatures），对接方支持时可以直接采用。

### 签名工具类

客户端和服务端共用同一份规范串实现：

```java
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.HexFormat;
import java.util.Locale;
import java.util.stream.Collectors;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

public final class ApiSigner {

    private static final HexFormat HEX = HexFormat.of();

    private ApiSigner() {
    }

    public static String canonical(String method, String path, String rawQuery,
                                   String timestamp, String nonce, byte[] body) {
        String sortedQuery = (rawQuery == null || rawQuery.isEmpty())
                ? ""
                : Arrays.stream(rawQuery.split("&")).sorted().collect(Collectors.joining("&"));
        return String.join("\n",
                method.toUpperCase(Locale.ROOT), path, sortedQuery, timestamp, nonce, sha256Hex(body));
    }

    public static byte[] hmac(byte[] secret, String canonical) {
        try {
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(secret, "HmacSHA256"));
            return mac.doFinal(canonical.getBytes(StandardCharsets.UTF_8));
        } catch (GeneralSecurityException e) {
            throw new IllegalStateException("HmacSHA256 不可用", e);
        }
    }

    /** 客户端：生成放进 X-Signature 头的签名 */
    public static String sign(byte[] secret, String canonical) {
        return HEX.formatHex(hmac(secret, canonical));
    }

    private static String sha256Hex(byte[] body) {
        try {
            return HEX.formatHex(MessageDigest.getInstance("SHA-256").digest(body));
        } catch (GeneralSecurityException e) {
            throw new IllegalStateException("SHA-256 不可用", e);
        }
    }
}
```

### 服务端校验过滤器

校验要读请求体，而 Servlet 的输入流只能读一次，所以先把请求体缓存下来（同时限制大小），再把包装后的请求传给后续链路。Spring 自带的 `ContentCachingRequestWrapper` 只在下游读取时才缓存，过滤器里拿不到，不适合这里。

```java
import jakarta.servlet.ReadListener;
import jakarta.servlet.ServletInputStream;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletRequestWrapper;
import java.io.BufferedReader;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStreamReader;
import java.nio.charset.Charset;
import java.nio.charset.StandardCharsets;
import java.util.Optional;

public final class CachedBodyRequest extends HttpServletRequestWrapper {

    private final byte[] body;

    private CachedBodyRequest(HttpServletRequest request, byte[] body) {
        super(request);
        this.body = body;
    }

    /** 读取并缓存请求体；超过上限返回 empty */
    public static Optional<CachedBodyRequest> of(HttpServletRequest request, int maxBytes) throws IOException {
        if (request.getContentLengthLong() > maxBytes) {
            return Optional.empty();
        }
        byte[] body = request.getInputStream().readNBytes(maxBytes + 1);
        return body.length > maxBytes ? Optional.empty() : Optional.of(new CachedBodyRequest(request, body));
    }

    public byte[] getBody() {
        return body;
    }

    @Override
    public ServletInputStream getInputStream() {
        ByteArrayInputStream in = new ByteArrayInputStream(body);
        return new ServletInputStream() {
            @Override
            public int read() {
                return in.read();
            }

            @Override
            public int read(byte[] b, int off, int len) {
                return in.read(b, off, len);
            }

            @Override
            public boolean isFinished() {
                return in.available() == 0;
            }

            @Override
            public boolean isReady() {
                return true;
            }

            @Override
            public void setReadListener(ReadListener listener) {
                throw new UnsupportedOperationException("不支持异步读取");
            }
        };
    }

    @Override
    public BufferedReader getReader() {
        String encoding = getCharacterEncoding();
        Charset charset = encoding == null ? StandardCharsets.UTF_8 : Charset.forName(encoding);
        return new BufferedReader(new InputStreamReader(getInputStream(), charset));
    }
}
```

```java
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.security.MessageDigest;
import java.time.Duration;
import java.time.Instant;
import java.util.HexFormat;
import java.util.Optional;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.security.web.servlet.util.matcher.PathPatternRequestMatcher;
import org.springframework.security.web.util.matcher.RequestMatcher;
import org.springframework.stereotype.Component;
import org.springframework.util.StringUtils;
import org.springframework.web.filter.OncePerRequestFilter;

@Component
public class SignatureVerifyFilter extends OncePerRequestFilter {

    private static final long WINDOW_SECONDS = 300;
    private static final int MAX_BODY_BYTES = 1024 * 1024;
    private static final RequestMatcher OPEN_API =
            PathPatternRequestMatcher.withDefaults().matcher("/open-api/**");

    private final ApiCredentialService credentials;   // 按 access key 取出（已解密的）secret
    private final StringRedisTemplate redis;

    public SignatureVerifyFilter(ApiCredentialService credentials, StringRedisTemplate redis) {
        this.credentials = credentials;
        this.redis = redis;
    }

    @Override
    protected boolean shouldNotFilter(HttpServletRequest request) {
        return !OPEN_API.matches(request);
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response,
                                    FilterChain chain) throws ServletException, IOException {
        String accessKey = request.getHeader("X-Access-Key");
        String timestamp = request.getHeader("X-Timestamp");
        String nonce = request.getHeader("X-Nonce");
        String signature = request.getHeader("X-Signature");
        if (!StringUtils.hasText(accessKey) || !StringUtils.hasText(timestamp)
                || !StringUtils.hasText(nonce) || !StringUtils.hasText(signature)) {
            response.sendError(HttpServletResponse.SC_UNAUTHORIZED, "missing signature headers");
            return;
        }

        // 1. 时间窗：拒绝过旧或来自"未来"的请求
        long ts;
        try {
            ts = Long.parseLong(timestamp);
        } catch (NumberFormatException e) {
            response.sendError(HttpServletResponse.SC_UNAUTHORIZED, "bad timestamp");
            return;
        }
        if (Math.abs(Instant.now().getEpochSecond() - ts) > WINDOW_SECONDS) {
            response.sendError(HttpServletResponse.SC_UNAUTHORIZED, "request expired");
            return;
        }

        // 2. 重算签名，常量时间比较
        Optional<byte[]> secret = credentials.findSecret(accessKey);
        if (secret.isEmpty()) {
            response.sendError(HttpServletResponse.SC_UNAUTHORIZED, "unknown access key");
            return;
        }
        Optional<CachedBodyRequest> cached = CachedBodyRequest.of(request, MAX_BODY_BYTES);
        if (cached.isEmpty()) {
            response.sendError(HttpServletResponse.SC_REQUEST_ENTITY_TOO_LARGE);
            return;
        }
        String canonical = ApiSigner.canonical(request.getMethod(), request.getRequestURI(),
                request.getQueryString(), timestamp, nonce, cached.get().getBody());
        byte[] expected = ApiSigner.hmac(secret.get(), canonical);
        byte[] actual;
        try {
            actual = HexFormat.of().parseHex(signature);   // 大小写都接受
        } catch (IllegalArgumentException e) {
            response.sendError(HttpServletResponse.SC_UNAUTHORIZED, "bad signature");
            return;
        }
        if (!MessageDigest.isEqual(expected, actual)) {
            response.sendError(HttpServletResponse.SC_UNAUTHORIZED, "bad signature");
            return;
        }

        // 3. nonce 去重：签名通过后再写，避免伪造请求占满 nonce
        Boolean first = redis.opsForValue().setIfAbsent(
                "api:nonce:" + accessKey + ":" + nonce, "1", Duration.ofSeconds(2 * WINDOW_SECONDS));
        if (!Boolean.TRUE.equals(first)) {
            response.sendError(HttpServletResponse.SC_UNAUTHORIZED, "replayed request");
            return;
        }

        request.setAttribute("apiClient", accessKey);
        chain.doFilter(cached.get(), response);
    }
}
```

几个容易写错的点：

- **比较签名用 `MessageDigest.isEqual`**，它的耗时与两个数组在第几个字节出现差异无关；`String.equals` / `equalsIgnoreCase` 碰到第一个不同的字符就返回，攻击者可以通过响应时间逐字节猜出签名
- **nonce 的过期时间取时间窗的 2 倍**：时间戳允许前后各偏 300 秒，同一个请求最长能在 600 秒内被接受，nonce 记录必须活得比这更久
- **nonce 键里带上 access key**，不同调用方的 nonce 互不干扰
- **缺头、格式错误一律返回 401**，不能让 `Long.parseLong(null)` 之类的异常变成 500
- 这个过滤器只按 JSON 请求体设计；`application/x-www-form-urlencoded` 表单的参数解析依赖原始输入流，开放接口统一用 JSON 最省事

---

## 四、API Key 的存储与轮换

### 存什么

两种 Key 的存法不同，混用是常见错误：

| Key 类型 | 服务端需要原文吗 | 存储方式 |
|----------|------------------|----------|
| Bearer API Key（请求里直接带 Key） | 不需要，只需比对 | 只存 SHA-256 摘要；Key 本身是 32 字节以上的随机数，熵足够高，快速哈希即可，不必用 bcrypt |
| HMAC Secret（用来签名） | 需要，服务端要用原文重算签名 | 加密后存储：用 KMS 的数据密钥做字段加密，或直接放 Vault，见 [数据安全](./7_data_security) |

```sql
CREATE TABLE api_credential (
  id                BIGINT PRIMARY KEY AUTO_INCREMENT,
  app_id            BIGINT       NOT NULL,
  access_key        CHAR(32)     NOT NULL UNIQUE,   -- 公开标识，随请求传输
  secret_ciphertext VARBINARY(512) NOT NULL,        -- HMAC Secret 的密文（AES-GCM）
  secret_key_ver    INT          NOT NULL,          -- 加密所用密钥版本，便于轮换
  status            TINYINT      NOT NULL DEFAULT 1, -- 1 有效 0 禁用
  expired_at        DATETIME     NULL,              -- 轮换宽限期结束时间
  created_at        DATETIME     NOT NULL
);
```

Secret 只在创建时向合作方展示一次，之后后台只能重置、不能查看。

### 怎么传

```text
GET /open-api/orders?page=1 HTTP/1.1
X-Access-Key: ak_3f9c2e...
X-Timestamp: 1791590400
X-Nonce: 9b2f3c1e-6a4d-4e8b-9f0a-2c7d5e1b8a63
X-Signature: 5d41402abc4b2a76b9719d911017c592...
```

Key 和签名一律放请求头，不放 URL：URL 会被写进网关日志、浏览器历史和 Referer。

### 轮换与吊销

- **轮换**：为同一个应用签发新凭证，旧凭证设置宽限期（如 7 天）后失效，期间新旧都能用，合作方切换完成后提前下线旧凭证
- **吊销**：立即把状态置为禁用，同时删除网关和服务里的凭证缓存
- **监控**：按 access key 统计调用量和失败率，签名失败突增往往意味着 Secret 泄露或对方实现有误

```java
@Transactional
public NewCredential rotate(long appId) {
    ApiCredential old = repository.findActiveByAppId(appId).orElseThrow();
    old.expireAt(LocalDateTime.now().plusDays(7));       // 旧凭证进入宽限期

    NewCredential created = credentialFactory.create(appId);   // 生成新 access key 与 secret，secret 加密落库
    repository.save(created.entity());
    return created;                                      // secret 原文只在这里返回一次
}

public void revoke(String accessKey) {
    repository.disable(accessKey);
    credentialCache.evict(accessKey);
}
```

---

## 五、Bearer Token 与对象级授权

### Token 校验交给资源服务器

前后端分离和微服务场景下，Token 校验不要手写 JWT 过滤器，直接让服务成为 OAuth2 Resource Server：验签、过期、签发方、受众都由 Spring Security 完成，JWKS 公钥自动拉取并按 `kid` 轮换。认证过滤器的执行机制见 [Spring Security](/spring/9_security)，JWT 本身的结构与吊销见 [JWT 令牌机制](./1_jwt)。

```yaml
spring:
  security:
    oauth2:
      resourceserver:
        jwt:
          issuer-uri: https://auth.example.com
          audiences: order-api
          authorities-claim-name: roles   # 从 roles 声明取权限
          authority-prefix: ROLE_
```

过滤器链的写法放在第七节，与 CORS、安全头一起给出。

### BOLA：每次按"当前用户 + 对象 ID"查

对象级授权失效排在 OWASP API Top 10 第一位。根因是只校验了"登录了没有"，没校验"这条数据是不是你的"：

```java
@GetMapping("/api/orders/{id}")
public OrderView get(@PathVariable long id, @AuthenticationPrincipal Jwt jwt) {
    // 错误写法：orderRepository.findById(id)，任何登录用户改 ID 就能看别人的订单
    return orderRepository.findByIdAndUserId(id, jwt.getSubject())
            .map(OrderView::from)
            .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND));
}
```

- 查不到时返回 404 而不是 403，不暴露"这个 ID 存在"
- 对外 ID 用不可猜测的值（UUID、雪花 ID）能降低枚举风险，但**不能代替授权检查**
- 管理员、客服等跨用户访问走单独的接口和权限，数据范围控制见 [访问控制](/architecture/6_access_control)

### BOPLA 与批量赋值：请求和响应都用专用 DTO

对象属性级授权失效有两个方向：

- **响应方向**：直接返回实体，把密码哈希、内部备注、其他用户信息一起序列化出去。对策是每个接口返回专用的 View 对象，只包含该角色能看的字段
- **请求方向（批量赋值）**：直接把请求体绑定到实体，用户多传一个 `"role": "ADMIN"` 或 `"balance": 99999` 就被写进数据库。对策是请求也用专用 DTO，只包含允许修改的字段

```java
public record UpdateProfileRequest(
        @Size(max = 30) String nickname,
        @Size(max = 200) String bio) {
}

@PatchMapping("/api/me")
public ProfileView update(@RequestBody @Valid UpdateProfileRequest req, @AuthenticationPrincipal Jwt jwt) {
    User user = userService.load(jwt.getSubject());
    user.changeProfile(req.nickname(), req.bio());   // 只拷贝白名单字段
    return ProfileView.from(userService.save(user));
}
```

Spring Boot 默认让 Jackson 忽略未知字段，所以多传的 `role` 不会报错，防线在于 DTO 里根本没有这个字段。希望显式拒绝时可以开启 `spring.jackson.deserialization.fail-on-unknown-properties=true`。

功能级授权（普通用户调管理接口）用 URL 规则或 `@PreAuthorize` 控制，模型设计见 [RBAC 与 ABAC](./5_rbac_abac)。

---

## 六、输入校验与资源限制

### 参数校验

Spring Framework 6.1 起，控制器内置了方法参数校验：参数上直接写 `@Min`、`@NotBlank` 等约束即可生效。**不要再在控制器类上加 `@Validated`**，否则会额外走一层 AOP 代理校验，抛出的异常类型也变成 `ConstraintViolationException`。

```java
@RestController
@RequestMapping("/api/users")
public class UserController {

    private final UserService userService;

    public UserController(UserService userService) {
        this.userService = userService;
    }

    @PostMapping
    public UserView create(@RequestBody @Valid CreateUserRequest req) {
        return userService.create(req);
    }

    @GetMapping
    public List<UserView> list(@RequestParam(defaultValue = "1") @Min(1) int page,
                               @RequestParam(defaultValue = "20") @Min(1) @Max(100) int size) {
        return userService.list(page, size);
    }
}

public record CreateUserRequest(
        @NotBlank @Size(min = 2, max = 20) String username,
        @NotBlank @Size(min = 12, max = 64) String password,
        @NotBlank @Email String email) {
}
```

两种校验失败抛出的异常不同，全局异常处理都要覆盖：

| 触发方式 | 异常 |
|----------|------|
| `@Valid` 标在 `@RequestBody` / `@ModelAttribute` 上 | `MethodArgumentNotValidException` |
| 约束注解直接标在方法参数上（如 `@RequestParam @Min(1)`） | `HandlerMethodValidationException` |

继承 `ResponseEntityExceptionHandler` 可以让这两种异常以及其他 Spring MVC 异常都返回 RFC 9457 的 ProblemDetail 格式，只需覆盖想定制的部分：

```java
import jakarta.servlet.http.HttpServletRequest;
import java.util.stream.Collectors;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.slf4j.MDC;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.HttpStatusCode;
import org.springframework.http.ProblemDetail;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.AccessDeniedException;
import org.springframework.web.bind.MethodArgumentNotValidException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.context.request.WebRequest;
import org.springframework.web.method.annotation.HandlerMethodValidationException;
import org.springframework.web.servlet.mvc.method.annotation.ResponseEntityExceptionHandler;

@RestControllerAdvice
public class ApiExceptionHandler extends ResponseEntityExceptionHandler {

    private static final Logger log = LoggerFactory.getLogger(ApiExceptionHandler.class);

    @Override
    protected ResponseEntity<Object> handleMethodArgumentNotValid(
            MethodArgumentNotValidException ex, HttpHeaders headers, HttpStatusCode status, WebRequest request) {
        String detail = ex.getBindingResult().getFieldErrors().stream()
                .map(e -> e.getField() + ": " + e.getDefaultMessage())
                .collect(Collectors.joining("; "));
        return handleExceptionInternal(ex, ProblemDetail.forStatusAndDetail(status, detail), headers, status, request);
    }

    @Override
    protected ResponseEntity<Object> handleHandlerMethodValidationException(
            HandlerMethodValidationException ex, HttpHeaders headers, HttpStatusCode status, WebRequest request) {
        String detail = ex.getParameterValidationResults().stream()
                .flatMap(r -> r.getResolvableErrors().stream()
                        .map(err -> r.getMethodParameter().getParameterName() + ": " + err.getDefaultMessage()))
                .collect(Collectors.joining("; "));
        return handleExceptionInternal(ex, ProblemDetail.forStatusAndDetail(status, detail), headers, status, request);
    }

    /** 兜底处理器会吞掉方法级授权抛出的 AccessDeniedException，单独映射成 403 */
    @ExceptionHandler(AccessDeniedException.class)
    public ProblemDetail onAccessDenied(AccessDeniedException ex) {
        return ProblemDetail.forStatus(HttpStatus.FORBIDDEN);
    }

    /** 未知异常：完整堆栈写日志，响应只给 traceId */
    @ExceptionHandler(Exception.class)
    public ProblemDetail onUnexpected(Exception ex, HttpServletRequest request) {
        log.error("unhandled error on {}", request.getRequestURI(), ex);
        ProblemDetail problem = ProblemDetail.forStatusAndDetail(HttpStatus.INTERNAL_SERVER_ERROR, "服务器内部错误");
        problem.setProperty("traceId", MDC.get("traceId"));
        return problem;
    }
}
```

响应体里不出现异常类名、SQL、表名、内部主机名；Spring Boot 的 `server.error.include-stacktrace`、`include-message` 默认都是 `never`，不要在生产打开。统一响应结构的约定见 [API 设计规范](/engineering/7_api_design_rule)。

### 资源限制

对应 OWASP API4（资源消耗不受限），每个维度都要有上限：

| 维度 | 做法 |
|------|------|
| 分页大小 | 参数上加 `@Max`；用 Spring Data `Pageable` 时设置 `spring.data.web.pageable.max-page-size`（默认 2000，通常要调小） |
| 请求体大小 | 网关 / Nginx 限制（如 `client_max_body_size`）；上传接口设置 `spring.servlet.multipart.max-file-size` 与 `max-request-size` |
| 请求头大小 | `server.max-http-request-header-size` |
| 批量接口 | 限制单次条数（如一次最多 100 个 ID） |
| 耗时操作 | 导出、报表改为异步任务，接口只返回任务 ID |
| 重复提交 | 写接口要求幂等键，见 [幂等设计](/architecture/5_idempotence) |

### 限流与防刷

限流按**调用方维度**做才有意义：开放接口按 access key，登录用户按用户 ID，匿名接口按 IP + 设备指纹。登录、发短信、领券这类敏感业务流（OWASP API6）还要叠加验证码、失败次数锁定和行为风控。限流算法（令牌桶、滑动窗口）、分层限流与网关上的落地见 [限流与过载保护](/high-avail/7_rate_limiting)。

---

## 七、过滤器链、CORS 与安全响应头

一个典型的 API 过滤器链（Spring Security 7，lambda DSL）：

```java
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.HttpMethod;
import org.springframework.security.config.Customizer;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.annotation.web.configuration.EnableWebSecurity;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.header.writers.ReferrerPolicyHeaderWriter.ReferrerPolicy;
import org.springframework.web.cors.CorsConfiguration;
import org.springframework.web.cors.UrlBasedCorsConfigurationSource;

import java.util.List;

@Configuration
@EnableWebSecurity
public class ApiSecurityConfig {

    @Bean
    SecurityFilterChain apiChain(HttpSecurity http) throws Exception {
        http
            .securityMatcher("/api/**")
            .authorizeHttpRequests(auth -> auth
                .requestMatchers(HttpMethod.GET, "/api/public/**").permitAll()
                .requestMatchers("/api/admin/**").hasRole("ADMIN")
                .anyRequest().authenticated())
            .oauth2ResourceServer(oauth2 -> oauth2.jwt(Customizer.withDefaults()))
            .sessionManagement(session -> session.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
            // 只用 Authorization 头传 Token 的纯 API 可以关闭 CSRF；用 Cookie 会话的不要关
            .csrf(csrf -> csrf.disable())
            .cors(Customizer.withDefaults())
            .headers(headers -> headers
                .contentSecurityPolicy(csp -> csp.policyDirectives("default-src 'none'; frame-ancestors 'none'"))
                .referrerPolicy(referrer -> referrer.policy(ReferrerPolicy.NO_REFERRER)));
        return http.build();
    }

    @Bean
    UrlBasedCorsConfigurationSource corsConfigurationSource() {
        CorsConfiguration config = new CorsConfiguration();
        config.setAllowedOrigins(List.of("https://app.example.com", "https://admin.example.com"));
        config.setAllowedMethods(List.of("GET", "POST", "PUT", "PATCH", "DELETE"));
        config.setAllowedHeaders(List.of("Authorization", "Content-Type", "Idempotency-Key"));
        config.setAllowCredentials(true);
        config.setMaxAge(3600L);   // 预检结果缓存 1 小时

        UrlBasedCorsConfigurationSource source = new UrlBasedCorsConfigurationSource();
        source.registerCorsConfiguration("/api/**", config);
        return source;
    }
}
```

Spring Security 7 中 `requestMatchers(String)` 默认就是基于 `PathPatternRequestMatcher` 的路径模式匹配；需要手动构造匹配器时用 `PathPatternRequestMatcher.withDefaults().matcher(...)`（见第三节过滤器），旧的 `AntPathRequestMatcher` 已经移除。

### CORS 的几个要点

- **CORS 不是安全边界**：它只约束浏览器里的跨域读取，curl、脚本、服务端调用完全不受影响，接口本身的认证授权一个都不能少
- **允许携带凭证时不能用 `*`**：`allowCredentials=true` 搭配 `allowedOrigins("*")` 会被 Spring 拒绝；也不要把请求里的 `Origin` 原样回写，那等于放开所有来源。确需通配子域名时用 `setAllowedOriginPatterns(List.of("https://*.example.com"))`
- **CORS 必须在 Spring Security 之前处理**：预检请求不带 Token，`http.cors(...)` 会把 CORS 过滤器放在认证之前；容器里只放一个 `UrlBasedCorsConfigurationSource` Bean 时会被自动使用，有多个时要在 `cors(c -> c.configurationSource(...))` 里显式指定
- 遇到 CORS 报错时要补上正确配置，不要靠关闭 CORS 绕过

### 安全响应头

Spring Security 默认会写出以下响应头，一般不需要改：

| 响应头 | 默认值 | 作用 |
|--------|--------|------|
| `Cache-Control` / `Pragma` / `Expires` | 禁止缓存 | 防止敏感响应被浏览器或代理缓存 |
| `X-Content-Type-Options` | `nosniff` | 禁止浏览器猜测内容类型 |
| `Strict-Transport-Security` | `max-age=31536000 ; includeSubDomains`（仅 HTTPS 请求） | 强制浏览器只用 HTTPS |
| `X-Frame-Options` | `DENY` | 禁止被嵌入 iframe，防点击劫持 |
| `X-XSS-Protection` | `0` | 关闭已废弃的浏览器 XSS 过滤器 |

`Content-Security-Policy` 和 `Referrer-Policy` 默认不写，纯 JSON API 可以像上面那样设置最严格的值；返回页面的应用要按实际资源来源配置 CSP，XSS 防护细节见 [常见漏洞与防护](./8_vulnerabilities)。TLS 终止在网关或 Ingress 时，HSTS 头也可以由网关统一添加。

---

## 八、运维端点与传输层

- **Actuator**：生产只通过 Web 暴露 `health`（必要时加 `info`、`prometheus`），其他端点走独立管理端口并限制来源；`env`、`configprops` 的值从 Spring Boot 3.0 起默认就以 `******` 显示（`show-values: never`），不要为了排查问题改成 `always`。完整配置见 [Actuator](/spring-boot/7_actuator)
- **日志脱敏**：请求日志里不打印密码、Token、Secret、完整手机号和证件号，规则与实现统一见 [数据安全](./7_data_security)
- **API 资产**：所有对外接口登记在网关和接口文档里，老版本有明确的下线时间，测试环境不对公网开放
- **TLS**：全程 HTTPS，通常在网关 / Ingress 终止 TLS，服务间按需启用 mTLS。协议版本、证书链与 Spring Boot 的 SSL Bundle 配置统一见 [HTTPS 与 TLS](/protocols/3_https_tls)

---

## 小结

- OWASP API Top 10（2023）的前几名都是授权问题：每次查询都带上"当前用户"条件挡住 BOLA，请求和响应都用专用 DTO 挡住批量赋值和字段泄露
- 认证方式按调用方选：合作方服务端用 HMAC 签名，自家前端和第三方应用用 OAuth2 Bearer Token，服务间用 mTLS；多服务时在网关统一认证
- HMAC 签名的规范串要覆盖方法、路径、排序后的查询串、时间戳、nonce 和请求体摘要；比较签名用 `MessageDigest.isEqual`；nonce 在签名通过后用 `SET NX` 写入，过期时间不短于时间窗的 2 倍
- Bearer API Key 只存摘要，HMAC Secret 必须加密存储；凭证轮换要有宽限期，吊销要清缓存
- Token 校验交给 `oauth2ResourceServer`，不手写 JWT 过滤器；控制器不再加类级 `@Validated`，同时处理 `MethodArgumentNotValidException` 与 `HandlerMethodValidationException`
- 分页、请求体、批量条数、调用频率都要有上限；CORS 明确列出来源，不要把它当作安全边界；错误响应只给 traceId，Actuator 只暴露必要端点

## 参考资料

- OWASP API Security Top 10 2023：[OWASP API Security Project](https://owasp.org/API-Security/editions/2023/en/0x11-t10/)
- HTTP 消息签名标准：[RFC 9421 - HTTP Message Signatures](https://www.rfc-editor.org/rfc/rfc9421)
- HMAC 定义：[RFC 2104 - HMAC: Keyed-Hashing for Message Authentication](https://www.rfc-editor.org/rfc/rfc2104)
- 错误响应格式：[RFC 9457 - Problem Details for HTTP APIs](https://www.rfc-editor.org/rfc/rfc9457)
- Spring Security 资源服务器：[OAuth 2.0 Resource Server JWT](https://docs.spring.io/spring-security/reference/servlet/oauth2/resource-server/jwt.html)
- Spring Security CORS：[CORS](https://docs.spring.io/spring-security/reference/servlet/integrations/cors.html)
- Spring Security 安全响应头：[Security HTTP Response Headers](https://docs.spring.io/spring-security/reference/servlet/exploits/headers.html)
- Spring MVC 参数校验：[Validation - Spring Framework](https://docs.spring.io/spring-framework/reference/web/webmvc/mvc-controller/ann-validation.html)
- OWASP 速查表：[REST Security Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/REST_Security_Cheat_Sheet.html)、[Mass Assignment Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Mass_Assignment_Cheat_Sheet.html)

> 下一篇：[数据安全](./7_data_security)
