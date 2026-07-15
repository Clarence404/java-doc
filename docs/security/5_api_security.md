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
    // 1. 排序 + 拼接（排除 sign 自身）
    String paramStr = params.entrySet().stream()
        .filter(e -> !"sign".equals(e.getKey()))
        .sorted(Map.Entry.comparingByKey())
        .map(e -> e.getKey() + "=" + e.getValue())
        .collect(Collectors.joining("&"));

    // 2. HMAC-SHA256
    Mac mac = Mac.getInstance("HmacSHA256");
    mac.init(new SecretKeySpec(appSecret.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
    byte[] hash = mac.doFinal(paramStr.getBytes(StandardCharsets.UTF_8));
    return HexFormat.of().formatHex(hash).toUpperCase();
}
```

**服务端验证过滤器：**

```java
@Component
public class SignVerifyFilter extends OncePerRequestFilter {

    @Override
    protected void doFilterInternal(HttpServletRequest req, HttpServletResponse res,
                                    FilterChain chain) throws ... {
        String sign      = req.getHeader("X-Sign");
        String timestamp = req.getHeader("X-Timestamp");
        String nonce     = req.getHeader("X-Nonce");

        // 1. 时间窗口（5 分钟内有效，防重放初步过滤）
        long ts = Long.parseLong(timestamp);
        if (Math.abs(Instant.now().getEpochSecond() - ts) > 300) {
            res.sendError(401, "Request expired");
            return;
        }

        // 2. 重新计算并比对签名
        Map<String, String> params = extractParams(req);
        params.put("timestamp", timestamp);
        params.put("nonce", nonce);
        String expected = generateSign(params, getAppSecret(req));
        if (!expected.equalsIgnoreCase(sign)) {
            res.sendError(401, "Invalid signature");
            return;
        }

        chain.doFilter(req, res);
    }
}
```

---

## 二、防重放攻击

仅有签名不够——合法的已签名请求仍可被重复提交。需要 nonce + timestamp 双重保障。

```
请求 = { 业务参数, timestamp（Unix 秒）, nonce（UUID）, sign }
```

**nonce + Redis 去重：**

```java
@Service
public class ReplayProtectionService {

    private final RedisTemplate<String, String> redis;

    public void validate(String nonce, String timestamp) {
        // 1. 时间窗口
        long ts = Long.parseLong(timestamp);
        if (Math.abs(Instant.now().getEpochSecond() - ts) > 300) {
            throw new SecurityException("Request expired");
        }

        // 2. nonce 去重：setIfAbsent = 不存在才写入（等效 SET NX EX）
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
| `timestamp` | 限制请求时效（5 分钟窗口），超时直接拒绝 |
| `nonce` | 在时间窗口内全局唯一，Redis 去重 |
| `sign` | 防参数篡改，两者缺一不可 |

---

## 三、HTTPS / TLS

> TLS 握手流程、证书链校验、mTLS 双向认证详见 → [安全通信协议](/protocols/4_security_protocols)

**Spring Boot 开启 HTTPS：**

```yaml
server:
  ssl:
    enabled: true
    key-store: classpath:server.p12
    key-store-password: ${SSL_KEY_STORE_PASSWORD}
    key-store-type: PKCS12
    key-alias: server

# 同时强制 HTTP → HTTPS 跳转
```

```java
// 强制 HTTP 跳转 HTTPS
@Bean
public TomcatServletWebServerFactory tomcatFactory() {
    TomcatServletWebServerFactory factory = new TomcatServletWebServerFactory();
    factory.addAdditionalTomcatConnectors(httpConnector());
    return factory;
}

private Connector httpConnector() {
    Connector connector = new Connector(TomcatServletWebServerFactory.DEFAULT_PROTOCOL);
    connector.setScheme("http");
    connector.setPort(8080);
    connector.setSecure(false);
    connector.setRedirectPort(8443);
    return connector;
}
```

---

## 四、幂等设计

→ 详见 [幂等性设计](/architecture/5_idempotence)

## 五、限流与熔断

→ 详见 [限流与降级](/high-avail/1_rate_limiting)
