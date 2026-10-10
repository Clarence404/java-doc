---
description: NIST 800-207 原则与组件、身份感知代理、SPIFFE 与 mTLS、Istio 授权、持续评估
---

# 零信任架构

> 前置阅读：[权限模型：RBAC 与 ABAC](./5_rbac_abac)、[HTTPS 与 TLS](/protocols/3_https_tls)、[服务网格](/microservices/3_service_mesh)

传统网络安全是"城堡加护城河"，进了内网就默认可信；零信任反过来假设**内网和外网一样不可信**，访问是否允许只取决于"谁、用什么设备、在什么上下文下、访问哪个资源"。本篇讲 NIST SP 800-207 中 PE / PA / PEP 的分工，以及身份感知代理（如 Cloudflare Access）和工作负载身份（SPIFFE、mTLS、Istio）如何落地。

---

## 一、核心原则

"Never trust, always verify"这一说法来自 Forrester 分析师 John Kindervag 在 2010 年提出的零信任模型；Google 从 2011 年起在内部落地 BeyondCorp，取消了员工访问内部应用的 VPN；NIST 在 2020 年发布 SP 800-207，给出了目前最常被引用的定义。SP 800-207 的七条基本原则可以归纳为：

| 原则 | 含义 | 对 Java 后端意味着什么 |
|------|------|----------------------|
| 一切都是资源 | 数据、服务、设备、SaaS 都按资源对待 | 内部管理端点、Actuator 也要鉴权 |
| 通信与位置无关地加密 | 内网流量同样加密并认证 | 服务间用 mTLS，不因"在集群内"就走明文 |
| 按会话授权 | 每次访问单独授予，权限不跨资源延续 | 令牌短时效、按受众（`aud`）区分 |
| 动态策略 | 决策依据身份、设备状态、行为与环境属性 | 授权不只看角色，还看来源、时间、风险 |
| 持续监测资产状态 | 设备与工作负载的安全状态持续评估 | 设备不合规时会话应能被撤销 |
| 访问前严格认证授权 | 认证和授权在访问发生前完成，并持续进行 | 每个服务都校验调用方身份，不只在网关做一次 |
| 尽量多收集状态信息 | 网络、访问、资产数据用于改进策略 | 访问日志、审计日志进 SIEM |

一句话概括：**以身份代替网络位置作为信任依据，最小权限，持续验证，并假设已经被攻破**。

---

## 二、NIST SP 800-207 逻辑架构

![NIST SP 800-207 零信任逻辑组件](../assets/security/zt-nist-components.svg)

SP 800-207 把零信任系统拆成控制平面和数据平面：

| 组件 | 职责 | 常见实现 |
|------|------|---------|
| PE 策略引擎（Policy Engine） | 运行信任算法，对每次访问给出授予、拒绝或撤销的决策 | IdP 的条件访问、OPA、Istio 控制面的授权配置 |
| PA 策略管理员（Policy Administrator） | 执行 PE 的决策：建立或切断主体与资源之间的通信路径，下发会话凭据 | IdP 签发令牌、istiod 下发证书与策略 |
| PEP 策略执行点（Policy Enforcement Point） | 位于主体与资源之间，拦截请求并执行决策 | 身份感知代理、API 网关、Sidecar / ztunnel、应用内的 Spring Security |

PE 与 PA 合起来称为 PDP（策略决策点）。PE 做决策时参考的输入包括：身份系统（用户、服务账号、MFA 结果）、设备状态（MDM / EDR 报告的补丁、加密、杀毒状态）、威胁情报与风险信号、按资源定义的访问策略、历史活动日志与行为基线、PKI 签发的证书。

PEP 之后到资源之间的区域叫**隐式信任区**，零信任落地的过程就是把这块区域不断缩小：从"整个内网"缩到"一个集群"，再到"一个 Pod"，最终每个服务自己校验调用方。

---

## 三、用户访问：身份感知代理与 ZTNA

### 1、用身份感知代理替代 VPN

VPN 的问题是"连上即全通"：认证一次就获得整段网络的访问能力。零信任网络访问（ZTNA）用**身份感知代理**（Identity-Aware Proxy）替代它：

- 应用不再暴露在公网或 VPN 网段里，所有访问先到代理
- 代理把用户重定向到 IdP 登录（OIDC / SAML），结合设备状态和访问策略逐个应用授权
- 授权通过后，代理把请求转发到应用，并附上一个签名的身份断言（通常是 JWT）

常见产品有 Cloudflare Access、Google Cloud IAP、Microsoft Entra 应用代理，开源方案有 Pomerium、oauth2-proxy。

### 2、Cloudflare Access 与 Tunnel

Cloudflare 上的典型组合是 **Tunnel + Access**：

- **Tunnel** 由内网的 `cloudflared` 主动向 Cloudflare 边缘建立出站连接，源站不开放任何入站端口，解决"连得进来"
- **Access** 在边缘对每个请求做身份校验，按 IdP 登录结果、用户组、设备状态决定是否放行，解决"谁能进来"
- 放行的请求会带上 `Cf-Access-Jwt-Assertion` 头，里面是 Access 签发的 JWT

应用侧**必须校验这个 JWT**，而不是"只要来自 Cloudflare 就信任"：用 `https://<team-name>.cloudflareaccess.com/cdn-cgi/access/certs` 上的公钥验签，校验 `iss` 为团队域名、`aud` 为该应用的 Application Audience（AUD）Tag。这样即使有人绕过 Tunnel 直连源站，也伪造不出合法断言。在 Spring Security 中可以用资源服务器的 JWT 校验能力实现，读取自定义请求头用 `HeaderBearerTokenResolver`；业务本身的会话与 CSRF 防护仍按 [常见漏洞与防护](./8_vulnerabilities) 的做法保留。

Tunnel 的安装与入口规则配置见 [Cloudflare 边缘服务](/cloud-native/16_cloudflare)。

### 3、设备状态

零信任的"主体"是用户加设备。同一个账号，从公司管理的、已加密、补丁最新的电脑登录，和从未知设备登录，应该得到不同的访问权限。设备状态（Device Posture）检查通常包括：

| 检查项 | 例子 |
|--------|------|
| 设备是否受管 | 是否注册在 MDM、是否安装了公司证书 |
| 系统与补丁 | 操作系统版本不低于基线 |
| 安全配置 | 磁盘加密、防火墙、屏幕锁已开启 |
| 终端防护 | EDR 在线，风险评分低于阈值 |

在 Cloudflare 中由 WARP 客户端上报设备状态，Access 策略里引用这些检查；Microsoft Entra 的条件访问结合 Intune 合规状态做同样的事。设备状态检查对后端代码是透明的，后端只需要信任代理给出的身份断言。

---

## 四、服务间：工作负载身份与 mTLS

### 1、为什么不能用 IP 当身份

在 Kubernetes 中，Pod IP 随时变化，NetworkPolicy 按标签放行也只能回答"哪个网段可以连"，回答不了"调用方是哪个服务"。服务间零信任需要**可验证的工作负载身份**：每个服务持有一份由可信机构签发、短时效、自动轮换的凭据，对端据此确认身份后再授权。

### 2、SPIFFE 与 SPIRE

SPIFFE（Secure Production Identity Framework For Everyone）是 CNCF 毕业项目，定义了工作负载身份的标准格式：

- **SPIFFE ID**：形如 `spiffe://<trust-domain>/<path>` 的 URI，例如 `spiffe://prod.example.com/ns/payment/sa/order-service`
- **SVID**（SPIFFE Verifiable Identity Document）：承载 SPIFFE ID 的凭据，有 X.509 证书（ID 写在 SAN 的 URI 字段）和 JWT 两种形式
- **Workload API**：工作负载通过本地 Unix Socket 获取自己的 SVID 和信任包，不需要任何预置密钥

SPIRE 是 SPIFFE 的参考实现：SPIRE Server 充当签发机构，每个节点上的 SPIRE Agent 先完成节点证明（如校验 Kubernetes 节点的 ServiceAccount 令牌），再对本机工作负载做证明（核对 Pod 所在命名空间、ServiceAccount、镜像等），通过后签发 SVID。Istio 的工作负载证书同样遵循 SPIFFE 格式，因此不同系统之间可以用同一套身份互认。

### 3、mTLS

拿到 X.509 SVID 后，服务间用 **mTLS** 互相验证：双方都出示证书，各自用信任包校验对端证书链，再从证书 SAN 中取出对端的 SPIFFE ID 交给授权逻辑。mTLS 只解决"对方是谁"，"能做什么"仍由授权策略决定。

没有服务网格时，Spring Boot 用 SSL Bundle 同时配置服务端（`server.ssl.client-auth: need`）与 `RestClient` 客户端证书，配置方式见 [HTTPS 与 TLS](/protocols/3_https_tls)。证书要短时效并自动轮换，手工管理大量服务证书很快就会失控，这正是服务网格和 SPIRE 的价值所在。

### 4、Kubernetes ServiceAccount 令牌

不使用证书时，Kubernetes 的**投射 ServiceAccount 令牌**（Bound Service Account Token）是轻量的工作负载身份：令牌绑定到具体 Pod、带有受众和过期时间，kubelet 自动轮换。被调用方通过 TokenReview API 或 OIDC 发现文档验证令牌：

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: order-service
spec:
  serviceAccountName: order-service
  containers:
    - name: app
      image: registry.example.com/order-service:1.4.0
      volumeMounts:
        - name: payment-token
          mountPath: /var/run/secrets/tokens
          readOnly: true
  volumes:
    - name: payment-token
      projected:
        sources:
          - serviceAccountToken:
              path: payment-token
              audience: payment-service   # 只对 payment-service 有效
              expirationSeconds: 3600     # 最小 600 秒，kubelet 在过期前自动刷新
```

应用每次调用前重新读取文件里的令牌，放进 `Authorization: Bearer` 头即可。云厂商的"工作负载身份联合"（如 AWS EKS 的 IRSA、GKE Workload Identity Federation）也是用这类令牌换取云 API 的临时凭据，替代长期 AccessKey。

---

## 五、Istio 中的零信任

服务网格的架构、Sidecar 与 Ambient 的取舍见 [服务网格](/microservices/3_service_mesh)，这里只讲安全相关的三类资源。istiod 内置的 CA 为每个工作负载签发 SPIFFE 格式的证书（如 `spiffe://cluster.local/ns/production/sa/order-service`），默认 24 小时有效并自动轮换；需要对接企业 PKI 时，可以通过 istio-csr 等方式接入 cert-manager 作为外部 CA。

### 1、PeerAuthentication：全网格强制 mTLS

```yaml
apiVersion: security.istio.io/v1
kind: PeerAuthentication
metadata:
  name: default
  namespace: istio-system    # 放在 Istio 根命名空间才对整个网格生效
spec:
  mtls:
    mode: STRICT             # 只接受 mTLS；存量服务迁移期间先用 PERMISSIVE
```

放在某个业务命名空间里的同名策略只对该命名空间生效，可以用来做命名空间级的覆盖。根命名空间默认是 `istio-system`，以安装时的 `meshConfig.rootNamespace` 为准。

### 2、AuthorizationPolicy：默认拒绝，显式放行

mTLS 之后，每个请求都带有可信的来源身份（`source.principal`），可以据此写"谁能调用谁"：

```yaml
# 1. 命名空间内默认拒绝：spec 为空的 ALLOW 策略不匹配任何请求，等于全部拒绝
apiVersion: security.istio.io/v1
kind: AuthorizationPolicy
metadata:
  name: allow-nothing
  namespace: production
spec: {}
---
# 2. 只允许网关和订单服务调用支付服务的指定接口
apiVersion: security.istio.io/v1
kind: AuthorizationPolicy
metadata:
  name: payment-allow
  namespace: production
spec:
  selector:
    matchLabels:
      app: payment-service
  action: ALLOW
  rules:
    - from:
        - source:
            principals:
              - cluster.local/ns/production/sa/order-service
              - cluster.local/ns/istio-ingress/sa/istio-ingressgateway
      to:
        - operation:
            methods: ["POST"]
            paths: ["/api/payments", "/api/payments/*"]
```

- `principals` 写的是去掉 `spiffe://` 前缀的身份，形如 `<trust-domain>/ns/<namespace>/sa/<serviceaccount>`
- 策略评估顺序是 CUSTOM → DENY → ALLOW：任一 DENY 命中即拒绝；存在 ALLOW 策略时，必须至少命中一条才放行
- 终端用户的 JWT 可以用 `RequestAuthentication` 在网格层验签，再在 AuthorizationPolicy 中用 `requestPrincipals` 或 `request.auth.claims[...]` 做条件；网格层校验不替代应用内的对象级授权（见 [常见漏洞与防护](./8_vulnerabilities) 的越权一节）

### 3、Ambient 模式下的安全

Istio 1.24 起 Ambient 模式正式 GA。它不再为每个 Pod 注入 Sidecar，而是把安全能力分成两层：

| 层 | 组件 | 安全能力 |
|----|------|---------|
| L4 | 每个节点上的 ztunnel | mTLS（HBONE 隧道）、工作负载身份、只用 L4 条件（来源身份、命名空间、端口、IP）的授权 |
| L7 | 按需部署的 waypoint 代理 | 基于 HTTP 方法、路径、请求头、JWT 的授权与路由 |

命名空间打上 `istio.io/dataplane-mode=ambient` 标签后即获得 mTLS，无需重启 Pod。需要注意：

- 上面的 PeerAuthentication 在 Ambient 下同样适用，但不支持 `DISABLE` 模式
- 含 L7 条件（`methods`、`paths` 等）的 AuthorizationPolicy 必须由 waypoint 执行，策略要用 `targetRefs` 绑定到 Service 或 waypoint，而不是 `selector`：

```yaml
apiVersion: security.istio.io/v1
kind: AuthorizationPolicy
metadata:
  name: payment-allow-l7
  namespace: production
spec:
  targetRefs:
    - kind: Service
      group: ""
      name: payment-service
  action: ALLOW
  rules:
    - from:
        - source:
            principals: ["cluster.local/ns/production/sa/order-service"]
      to:
        - operation:
            methods: ["POST"]
```

如果服务没有接入 waypoint，绑定到它的 L7 策略不会被执行，从 Sidecar 迁移到 Ambient 时要逐条核对。

---

## 六、策略执行与持续评估

### 1、PEP 放在哪里

零信任不要求只有一个 PEP，而是**多层执行、各管一段**：

| 层 | PEP | 适合做的判断 |
|----|-----|-------------|
| 边缘 | 身份感知代理、WAF | 用户是否登录、设备是否合规、能否访问这个应用 |
| 网关 | API 网关 | 令牌有效性、限流、粗粒度的接口权限 |
| 网格 | Sidecar / ztunnel / waypoint | 服务 A 能否调用服务 B 的哪些接口 |
| 应用 | Spring Security、方法级授权 | 这条数据是否属于当前用户、业务规则是否允许 |

越靠外的层越粗粒度，对象级、数据级的授权只能在应用内完成。把策略从代码里抽出来集中管理时，可以用 OPA 作为 PDP，各层 PEP 调用它做决策，Rego 策略与 Spring 集成见 [权限模型：RBAC 与 ABAC](./5_rbac_abac)，PEP / PDP 在系统中的部署形态见 [权限系统架构设计](/architecture/6_access_control)。

不论 PDP 是什么，PEP 都要遵循两条：**拿不到明确的允许就拒绝**（PDP 超时、返回空结果都按拒绝处理），以及**决策可缓存但要短**（秒级 TTL，策略变更能尽快生效）。

### 2、持续评估

传统做法是登录时认证一次，之后在令牌有效期内一直信任。零信任要求在会话期间也能响应变化：员工离职、设备被检测出恶意软件、账号出现异地登录，已经签发的会话应当尽快失效。

- **短时效令牌**：访问令牌几分钟到一小时，刷新时重新评估设备与风险；令牌策略见 [JWT 令牌机制](./1_jwt)
- **共享信号**：OpenID Foundation 在 2025 年 9 月将 Shared Signals Framework（SSF）1.0、CAEP（持续访问评估协议）1.0、RISC 1.0 定为最终规范。IdP、设备管理、SaaS 之间通过标准化的安全事件互相通知，例如 CAEP 的 `session-revoked`、`device-compliance-change`，接收方据此立即终止会话
- **行为基线**：访问日志进入 SIEM，与历史基线比较，异常时提高认证强度（要求 MFA）或撤销会话

---

## 七、落地路线

零信任是一个逐步收紧的过程，而不是一次性采购的产品。对一个典型的 Java 微服务系统，可以按以下顺序推进：

| 阶段 | 目标 | 主要手段 |
|------|------|---------|
| 1. 统一身份 | 所有人员访问都经过同一个 IdP，强制 MFA | OIDC / SSO，见 [单点登录](./4_sso) |
| 2. 去掉 VPN 暴露面 | 内部应用不再靠网络位置保护 | 身份感知代理 + Tunnel，加入设备状态检查 |
| 3. 服务间加密与认证 | 东西向流量全部 mTLS | 服务网格 PERMISSIVE → STRICT，或 SPIRE + SSL Bundle |
| 4. 服务间授权 | 默认拒绝，按调用关系显式放行 | AuthorizationPolicy、NetworkPolicy |
| 5. 应用内细粒度授权 | 对象级、数据级权限 | Spring Security 方法级授权、数据权限 |
| 6. 持续评估 | 风险变化能实时影响会话 | 短时效令牌、CAEP 事件、SIEM 告警 |

每个阶段都先以观察模式上线（PERMISSIVE、审计模式的策略、CSP 的 report-only 同理），看清实际流量后再切换为强制，避免一次性收紧导致业务中断。密钥与证书的管理（Vault、KMS）见 [数据安全](./7_data_security)。

---

## 小结

- 零信任以身份代替网络位置作为信任依据：每次访问都认证和授权、最小权限、持续验证、假设已被攻破；"Never trust, always verify"出自 John Kindervag，正式定义以 NIST SP 800-207 为准
- SP 800-207 的核心组件是 PE（决策）、PA（执行决策、下发凭据）和 PEP（拦截请求），PEP 之后的隐式信任区越小越好
- 用户侧用身份感知代理替代 VPN，例如 Cloudflare Tunnel + Access；应用必须校验代理附带的 JWT，并结合设备状态授权
- 服务侧以 SPIFFE ID 作为工作负载身份，用 mTLS 互相验证；Istio 用 `security.istio.io/v1` 的 PeerAuthentication 强制 mTLS，用 AuthorizationPolicy 做默认拒绝加显式放行；Ambient 模式下 L7 策略需要 waypoint 和 `targetRefs`
- 授权多层执行，对象级授权只能在应用内完成；PEP 出错一律拒绝；短时效令牌加 CAEP 共享信号实现会话期间的持续评估

---

## 参考资料

- NIST：[SP 800-207 Zero Trust Architecture](https://csrc.nist.gov/pubs/sp/800/207/final)、[SP 800-207A A Zero Trust Architecture Model for Access Control in Cloud-Native Applications in Multi-Cloud Environments](https://csrc.nist.gov/pubs/sp/800/207/a/final)
- Google BeyondCorp：[BeyondCorp: A New Approach to Enterprise Security（USENIX ;login: 2014）](https://www.usenix.org/publications/login/dec14/ward)
- SPIFFE / SPIRE：[SPIFFE Overview](https://spiffe.io/docs/latest/spiffe-about/overview/)、[SPIFFE Concepts](https://spiffe.io/docs/latest/spiffe-about/spiffe-concepts/)
- Istio 安全：[Security Concepts](https://istio.io/latest/docs/concepts/security/)、[PeerAuthentication](https://istio.io/latest/docs/reference/config/security/peer_authentication/)、[Authorization Policy](https://istio.io/latest/docs/reference/config/security/authorization-policy/)、[Ambient Mode Overview](https://istio.io/latest/docs/ambient/overview/)、[Fast, Secure, and Simple: Istio's Ambient Mode Reaches General Availability in v1.24](https://istio.io/latest/blog/2024/ambient-reaches-ga/)
- Kubernetes：[Service Account Token Volume Projection](https://kubernetes.io/docs/tasks/configure-pod-container/configure-service-account/#launch-a-pod-using-service-account-token-projection)
- Cloudflare Zero Trust：[Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/)、[Validate JWTs](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/)、[Device posture](https://developers.cloudflare.com/cloudflare-one/reusable-components/posture-checks/)
- OpenID Shared Signals：[OpenID Shared Signals Framework 1.0](https://openid.net/specs/openid-sharedsignals-framework-1_0-final.html)、[OpenID Continuous Access Evaluation Profile 1.0](https://openid.net/specs/openid-caep-1_0-final.html)
