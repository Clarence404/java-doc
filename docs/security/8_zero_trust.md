# 零信任架构

> "从不信任，始终验证（Never trust, always verify）" —— NIST SP 800-207

传统安全模型假设内网可信（"城墙模型"）：进了内网就信任一切。零信任假设**内外网都不可信**，每次访问都必须验证身份、评估设备状态、动态授权。

---

## 一、核心原则

| 原则 | 说明 |
|------|------|
| **身份为边界** | 以用户/设备/服务的身份替代网络位置作为信任边界 |
| **最小权限** | 只授予完成当前任务的最小权限，不用时即撤销 |
| **持续验证** | 不因已登录就持续信任，每次访问评估上下文风险 |
| **假设已被攻破** | 设计时假设内网有攻击者，做好横向隔离 |
| **显式授权** | 所有资源访问必须显式鉴权，不存在"内网免认证" |

---

## 二、零信任决策架构

```
访问请求
    ↓
政策引擎（Policy Engine）
  ├── 身份验证（用户 / 服务账户 / 设备证书）
  ├── 设备信任评估（是否合规、是否加入域）
  └── 访问上下文（时间、地理位置、风险评分）
    ↓
政策执行点（Policy Enforcement Point）
    ↓
资源（API / 数据库 / 文件系统）
```

---

## 三、mTLS 双向认证

普通 TLS：客户端验证服务端证书（单向）。mTLS：双方互相验证证书，常用于**微服务间通信**，防止伪造服务。

```yaml
# Spring Boot 服务端配置（要求客户端提供证书）
server:
  ssl:
    enabled: true
    client-auth: need                          # need = 强制要求；want = 可选
    key-store: classpath:server.p12            # 服务端证书
    key-store-password: ${SERVER_KS_PASSWORD}
    trust-store: classpath:truststore.p12      # 信任的 CA（用于验证客户端证书）
    trust-store-password: ${TRUST_KS_PASSWORD}
```

```java
// RestTemplate 客户端携带证书
SSLContext sslContext = SSLContextBuilder.create()
    .loadKeyMaterial(keyStore, keyPassword.toCharArray())    // 发给服务端的客户端证书
    .loadTrustMaterial(trustStore, null)                     // 信任的服务端 CA
    .build();

CloseableHttpClient httpClient = HttpClients.custom()
    .setSSLContext(sslContext)
    .build();

RestTemplate restTemplate = new RestTemplate(
    new HttpComponentsClientHttpRequestFactory(httpClient));
```

### Istio 自动化 mTLS（服务网格）

```yaml
# 全局开启 mTLS，无需改业务代码
apiVersion: security.istio.io/v1beta1
kind: PeerAuthentication
metadata:
  name: default
  namespace: default
spec:
  mtls:
    mode: STRICT     # STRICT = 所有服务间通信强制 mTLS
```

Istio 自动通过 cert-manager / SPIFFE 为每个 Pod 颁发 SVID 证书，每 24 小时轮换，运维成本极低。

---

## 四、OPA 动态授权（Open Policy Agent）

OPA 是 CNCF 的策略引擎，将权限策略从业务代码解耦，以"策略即代码"方式集中管理。

```rego
# policy.rego
package httpapi.authz

import future.keywords.if

default allow := false

# 管理员可访问所有资源
allow if {
    input.user.role == "admin"
}

# 用户只能访问自己的资源
allow if {
    input.method == "GET"
    input.resource.owner_id == input.user.id
}

# 审计员只能在工作时间访问报表
allow if {
    input.user.role == "auditor"
    input.path[0] == "reports"
    to_number(time.clock(time.now_ns())[0]) >= 9
    to_number(time.clock(time.now_ns())[0]) < 18
}
```

```java
// Spring 拦截器集成 OPA
@Component
public class OpaAuthInterceptor implements HandlerInterceptor {

    private final RestTemplate restTemplate;

    @Override
    public boolean preHandle(HttpServletRequest request, HttpServletResponse response, ...) {
        Map<String, Object> input = Map.of(
            "method", request.getMethod(),
            "path",   Arrays.asList(request.getRequestURI().replaceFirst("/", "").split("/")),
            "user",   Map.of(
                "id",   getCurrentUserId(),
                "role", getCurrentUserRole()
            ),
            "resource", Map.of("owner_id", getResourceOwnerId(request))
        );

        // OPA REST API：POST /v1/data/httpapi/authz
        Map<String, Object> body = Map.of("input", input);
        ResponseEntity<Map> resp = restTemplate.postForEntity(
            "http://opa:8181/v1/data/httpapi/authz", body, Map.class);

        boolean allowed = (Boolean) ((Map<?, ?>) resp.getBody()).get("result");
        if (!allowed) {
            response.sendError(HttpServletResponse.SC_FORBIDDEN);
            return false;
        }
        return true;
    }
}
```

---

## 五、零信任在微服务中的实践

| 层级 | 技术选型 |
|------|---------|
| 服务间认证 | mTLS（Istio / cert-manager）|
| 身份令牌 | JWT / SPIFFE SVID |
| 动态授权 | OPA / Casbin |
| 密钥管理 | HashiCorp Vault / KMS |
| 访问审计 | OpenTelemetry + 审计日志 |
| 网络微分段 | Kubernetes NetworkPolicy / Istio AuthorizationPolicy |
