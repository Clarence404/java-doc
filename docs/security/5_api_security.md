# API 安全

## 一、接口签名

防止请求参数被中间人篡改，确保数据完整性。

### 签名方案（HMAC-SHA256）

**签名步骤：**
1. 收集所有请求参数（排除 `sign` 字段本身）
2. 按 key 字典序升序排列
3. 拼接成 `key1=value1&key2=value2&nonce=xxx&timestamp=yyy`
4. 用 `HMAC-SHA256(appSecret, 拼接字符串)` 计算签名
5. 签名通过 Header `X-Sign` 传递

```java
public String generateSign(Map<String, String> params, String appSecret) throws Exception {
    String paramStr = params.entrySet().stream()
        .filter(e -> !"sign".equals(e.getKey()))
        .sorted(Map.Entry.comparingByKey())
        .map(e -> e.getKey() + "=" + e.getValue())
        .collect(Collectors.joining("&"));

    Mac mac = Mac.getInstance("HmacSHA256");
    mac.init(new SecretKeySpec(appSecret.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
    byte[] hash = mac.doFinal(paramStr.getBytes(StandardCharsets.UTF_8));
    return HexFormat.of().formatHex(hash).toUpperCase();
}
```

**服务端验证：**

```java
@Component
public class SignVerifyFilter extends OncePerRequestFilter {
    @Override
    protected void doFilterInternal(HttpServletRequest req, HttpServletResponse res,
                                    FilterChain chain) throws ... {
        String sign      = req.getHeader("X-Sign");
        String timestamp = req.getHeader("X-Timestamp");
        String nonce     = req.getHeader("X-Nonce");

        long ts = Long.parseLong(timestamp);
        if (Math.abs(Instant.now().getEpochSecond() - ts) > 300) {
            res.sendError(401, "Request expired");
            return;
        }

        Map<String, String> params = extractParams(req);
        params.put("timestamp", timestamp);
        params.put("nonce", nonce);
        if (!generateSign(params, getAppSecret(req)).equalsIgnoreCase(sign)) {
            res.sendError(401, "Invalid signature");
            return;
        }
        chain.doFilter(req, res);
    }
}
```

---

## 二、防重放攻击

仅有签名不够——合法的已签名请求仍可被重复提交，需要 nonce + timestamp 双重保障。

```java
@Service
public class ReplayProtectionService {

    public void validate(String nonce, String timestamp) {
        long ts = Long.parseLong(timestamp);
        if (Math.abs(Instant.now().getEpochSecond() - ts) > 300) {
            throw new SecurityException("Request expired");
        }
        // SET NX EX：不存在才写入，窗口内唯一
        String key = "api:nonce:" + nonce;
        Boolean isNew = redis.opsForValue().setIfAbsent(key, "1", Duration.ofMinutes(5));
        if (Boolean.FALSE.equals(isNew)) {
            throw new SecurityException("Duplicate request rejected");
        }
    }
}
```

| 参数 | 作用 |
|------|------|
| `timestamp` | 限制请求时效，超时直接拒绝 |
| `nonce` | 时间窗口内全局唯一，Redis 去重 |
| `sign` | 防参数篡改，两者缺一不可 |

---

## 三、API Key 管理

对外开放接口（Open API / 合作方接入）时，用 API Key 标识调用方身份。

### 颁发与存储

```sql
CREATE TABLE api_key (
  id          BIGINT PRIMARY KEY AUTO_INCREMENT,
  app_name    VARCHAR(100) NOT NULL,
  access_key  CHAR(32)    NOT NULL UNIQUE,   -- 公开标识，可在请求中传递
  secret_key  VARCHAR(64) NOT NULL,          -- 私钥，仅用于签名，不在网络中传输
  status      TINYINT     NOT NULL DEFAULT 1, -- 1=有效 0=禁用
  expired_at  DATETIME,                      -- NULL 表示永不过期
  created_at  DATETIME    NOT NULL
);
```

### 透传方式

```http
# 方式一：自定义 Header（推荐，不会出现在 URL 日志中）
GET /api/orders HTTP/1.1
X-Access-Key: ak_abc123
X-Sign: <HMAC签名>
X-Timestamp: 1720000000
X-Nonce: uuid-xxx

# 方式二：Authorization Header
Authorization: ApiKey ak_abc123:<sign>
```

### 轮换与吊销

```java
// 轮换：生成新 Key，旧 Key 保留宽限期（7 天后失效）
public ApiKey rotateKey(Long appId) {
    ApiKey oldKey = apiKeyRepo.findActiveByAppId(appId);
    oldKey.setExpiredAt(LocalDateTime.now().plusDays(7));
    apiKeyRepo.save(oldKey);

    ApiKey newKey = ApiKey.generate(appId);
    apiKeyRepo.save(newKey);
    return newKey;
}

// 吊销：立即禁用
public void revokeKey(String accessKey) {
    apiKeyRepo.updateStatus(accessKey, 0);
    redis.delete("apikey:" + accessKey);   // 同步清除缓存
}
```

---

## 四、Bearer Token 验证

前后端分离 / 微服务场景，在过滤器层统一验证 JWT，业务接口无需重复鉴权。

```java
@Component
public class JwtAuthFilter extends OncePerRequestFilter {

    @Override
    protected void doFilterInternal(HttpServletRequest req, HttpServletResponse res,
                                    FilterChain chain) throws ... {
        String header = req.getHeader(HttpHeaders.AUTHORIZATION);
        if (header == null || !header.startsWith("Bearer ")) {
            chain.doFilter(req, res);
            return;
        }

        String token = header.substring(7);
        try {
            Claims claims = jwtService.parseToken(token);

            UsernamePasswordAuthenticationToken auth =
                new UsernamePasswordAuthenticationToken(
                    claims.getSubject(),
                    null,
                    buildAuthorities(claims.get("roles", List.class))
                );
            SecurityContextHolder.getContext().setAuthentication(auth);

        } catch (ExpiredJwtException e) {
            res.sendError(HttpServletResponse.SC_UNAUTHORIZED, "Token expired");
            return;
        } catch (JwtException e) {
            res.sendError(HttpServletResponse.SC_UNAUTHORIZED, "Invalid token");
            return;
        }

        chain.doFilter(req, res);
    }

    @Override
    protected boolean shouldNotFilter(HttpServletRequest req) {
        // 白名单路径跳过 token 校验
        return new AntPathMatcher().match("/public/**", req.getServletPath());
    }
}
```

---

## 五、CORS 配置

配置不当会导致非预期域名可以调用接口，或合法前端被浏览器拦截。

```java
@Bean
public CorsConfigurationSource corsConfigurationSource() {
    CorsConfiguration config = new CorsConfiguration();

    // ❌ 生产禁止 *（配合 allowCredentials=true 时浏览器直接拒绝）
    // config.addAllowedOrigin("*");

    // ✅ 明确枚举允许的域名
    config.setAllowedOrigins(List.of(
        "https://app.example.com",
        "https://admin.example.com"
    ));
    config.setAllowedMethods(List.of("GET", "POST", "PUT", "DELETE", "OPTIONS"));
    config.setAllowedHeaders(List.of(
        "Authorization", "Content-Type",
        "X-Access-Key", "X-Sign", "X-Timestamp", "X-Nonce"
    ));
    config.setAllowCredentials(true);   // 允许携带 Cookie / Authorization Header
    config.setMaxAge(3600L);            // 预检请求结果缓存 1 小时

    UrlBasedCorsConfigurationSource source = new UrlBasedCorsConfigurationSource();
    source.registerCorsConfiguration("/**", config);
    return source;
}
```

```java
// Spring Security 中注册
http.cors(cors -> cors.configurationSource(corsConfigurationSource()));
```

---

## 六、输入校验

在 Controller 层统一校验，不要在 Service 内散乱处理。

```java
@Validated
@RestController
public class UserController {

    @PostMapping("/users")
    public UserVO create(@RequestBody @Valid CreateUserRequest req) { ... }

    @GetMapping("/users")
    public Page<UserVO> list(
        @RequestParam @Min(1) Integer page,
        @RequestParam @Max(100) Integer size) { ... }
}

// DTO 上声明约束
public record CreateUserRequest(
    @NotBlank(message = "用户名不能为空")
    @Size(min = 2, max = 20)
    String username,

    @NotBlank
    @Pattern(regexp = "^(?=.*[A-Za-z])(?=.*\\d).{8,}$", message = "密码至少 8 位，需含字母和数字")
    String password,

    @NotBlank @Email
    String email
) {}
```

```java
// 全局异常处理，统一 400 响应格式
@RestControllerAdvice
public class GlobalExceptionHandler {

    @ExceptionHandler(MethodArgumentNotValidException.class)
    @ResponseStatus(HttpStatus.BAD_REQUEST)
    public ApiResponse<Void> handleValidation(MethodArgumentNotValidException ex) {
        String msg = ex.getBindingResult().getFieldErrors().stream()
            .map(e -> e.getField() + ": " + e.getDefaultMessage())
            .collect(Collectors.joining("; "));
        return ApiResponse.fail(400, msg);
    }

    @ExceptionHandler(ConstraintViolationException.class)
    @ResponseStatus(HttpStatus.BAD_REQUEST)
    public ApiResponse<Void> handleConstraint(ConstraintViolationException ex) {
        String msg = ex.getConstraintViolations().stream()
            .map(ConstraintViolation::getMessage)
            .collect(Collectors.joining("; "));
        return ApiResponse.fail(400, msg);
    }
}
```

---

## 七、日志脱敏与错误响应

### 日志脱敏

密码、token、手机号、身份证等敏感参数不能出现在日志中：

```java
// ❌ 危险
log.info("登录请求: {}", request);   // password 会被打印

// ✅ DTO 重写 toString() 主动脱敏
public record LoginRequest(String username, String password) {
    @Override
    public String toString() {
        return "LoginRequest{username='" + username + "', password='******'}";
    }
}
```

```yaml
# Actuator 端点收敛，不暴露 env 中的配置值
management:
  endpoints:
    web:
      exposure:
        include: health, info
  endpoint:
    env:
      show-values: never
```

### 错误响应不暴露内部信息

```java
// ❌ 危险：暴露堆栈、表名、内部路径
{
  "error": "NullPointerException at com.example.UserService:42",
  "cause": "Table 'prod.users' doesn't exist"
}

// ✅ 只返回 traceId，完整堆栈写日志
@ExceptionHandler(Exception.class)
@ResponseStatus(HttpStatus.INTERNAL_SERVER_ERROR)
public ApiResponse<Void> handleUnknown(Exception ex, HttpServletRequest req) {
    String traceId = MDC.get("traceId");
    log.error("[{}] {} - {}", traceId, req.getRequestURI(), ex.getMessage(), ex);
    return ApiResponse.fail(500, "服务器内部错误，traceId: " + traceId);
}
```

---

## 八、HTTPS / TLS

> TLS 握手流程、证书链校验、mTLS 双向认证详见 → [安全通信协议](/protocols/4_security_protocols)

```yaml
server:
  ssl:
    enabled: true
    key-store: classpath:server.p12
    key-store-password: ${SSL_KEY_STORE_PASSWORD}
    key-store-type: PKCS12
```

---

## 九、幂等设计

→ 详见 [幂等性设计](/architecture/5_idempotence)

## 十、限流与熔断

→ 详见 [限流与降级](/high-avail/1_rate_limiting)
