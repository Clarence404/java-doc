---
description: OWASP Top 10:2025、注入、XSS、CSRF、SSRF、反序列化、XXE、路径穿越与上传、越权
---

# 常见漏洞与防护

> 前置阅读：[JWT 令牌机制](./1_jwt)、[API 安全](./6_api_security)、[Spring Security](/spring/9_security)

Java Web 漏洞的根源是把数据当成代码，或把「能连上」当成「被授权」。本篇对照 OWASP Top 10:2025 讲各类漏洞原理与防护写法和全站 CSRF 立场，基线为 Spring Security 7.0。

---

## 一、OWASP Top 10:2025

前一类包括注入、XSS、反序列化、XXE，后一类包括越权、CSRF、SSRF，防护对应数据与代码分离、每次访问都显式校验身份与权限。代码基线为 JDK 21、Spring Boot 4、Spring Security 7、Jackson 3。

OWASP Top 10 每三到四年更新一次，2025 版在 2021 版基础上做了合并和新增：

| 编号 | 类别 | 典型问题 | 本篇 / 相关章节 |
|------|------|---------|----------------|
| A01 | 访问控制失效（Broken Access Control） | 水平越权、垂直越权、SSRF（2025 版并入本类） | 第五节、第十一节 |
| A02 | 安全配置错误（Security Misconfiguration） | 默认口令、Actuator 全暴露、详细错误信息外泄、缺安全响应头 | 第三节、[API 安全](./6_api_security) |
| A03 | 软件供应链失败（Software Supply Chain Failures） | 依赖含已知 CVE、构建链被篡改、来源不明的组件 | 第十节 |
| A04 | 加密失败（Cryptographic Failures） | 明文传输、弱哈希存密码、密钥硬编码 | [数据安全](./7_data_security) |
| A05 | 注入（Injection） | SQL / 命令 / 表达式注入，XSS 也归入此类 | 第二节、第三节 |
| A06 | 不安全设计（Insecure Design） | 缺威胁建模、业务逻辑漏洞（如优惠券可无限叠加） | 贯穿全篇 |
| A07 | 认证失败（Authentication Failures） | 撞库无限速、会话固定、弱口令 | [JWT 令牌机制](./1_jwt)、[单点登录](./4_sso) |
| A08 | 软件或数据完整性失败（Software or Data Integrity Failures） | 不安全的反序列化、更新包不校验签名 | 第六节 |
| A09 | 安全日志与告警失败（Security Logging and Alerting Failures） | 攻击无记录、有日志无告警、日志被注入伪造 | 第九节 |
| A10 | 异常条件处理不当（Mishandling of Exceptional Conditions） | 出错时放行（fail-open）、异常栈外泄 | 第十二节 |

与 2021 版相比的主要变化：

- **SSRF 不再单列**，作为 CWE-918 并入 A01 访问控制失效
- **A03 软件供应链失败是扩展后的新类别**，范围从"使用易受攻击的组件"扩大到依赖、构建系统、分发渠道整条链路
- **A10 异常条件处理不当是新增类别**，关注错误处理逻辑本身造成的安全问题
- 安全配置错误从第五升到第二，加密失败从第二降到第四，注入从第三降到第五

---

## 二、SQL 注入与其他注入

### 1、原理

攻击者让输入"跳出"数据的位置，变成 SQL 语法的一部分：

```java
// 错误：字符串拼接 SQL
String sql = "SELECT * FROM users WHERE username = '" + username + "'";
// 输入 ' OR '1'='1 后实际执行：
// SELECT * FROM users WHERE username = '' OR '1'='1'   —— 条件恒真，返回所有用户
```

### 2、参数化查询

```java
// 正确：PreparedStatement 参数化，参数只会被当作数据
String sql = "SELECT id, username FROM users WHERE username = ?";
try (PreparedStatement ps = conn.prepareStatement(sql)) {
    ps.setString(1, username);
    try (ResultSet rs = ps.executeQuery()) {
        // ...
    }
}
```

MyBatis 中 `#{}` 和 `${}` 的区别是 Java 后端最常被问到的注入点：

| 写法 | 底层 | 是否安全 | 能否用于表名 / 列名 / ORDER BY |
|------|------|---------|-------------------------------|
| `#{}` | `PreparedStatement` 的 `?` 占位符 | 安全 | 不能（会被加上引号当字符串） |
| `${}` | 直接字符串替换 | 不安全 | 能，但必须白名单 |

```xml
<!-- 正确：#{} 参数化 -->
<select id="findByUsername" resultType="User">
  SELECT id, username FROM users WHERE username = #{username}
</select>

<!-- 正确：LIKE 也用 #{}，在 SQL 里拼通配符，不要写 '%${kw}%' -->
<select id="search" resultType="User">
  SELECT id, username FROM users WHERE username LIKE CONCAT('%', #{kw}, '%')
</select>

<!-- 危险：${} 直接拼接，sortColumn 必须来自白名单 -->
<select id="findOrdered" resultType="User">
  SELECT id, username FROM users ORDER BY ${sortColumn}
</select>
```

动态排序时，不要把前端传来的字符串直接交给 `${}`，而是把它映射成代码里写死的列名：

```java
public enum UserSort {
    NAME("username"), CREATED("created_at");

    private final String column;
    UserSort(String column) { this.column = column; }
    public String column() { return column; }
}

public List<User> findOrdered(String sort) {
    // valueOf 遇到非法值会抛 IllegalArgumentException，交给全局异常处理返回 400
    UserSort s = UserSort.valueOf(sort.toUpperCase(Locale.ROOT));
    return userMapper.findOrdered(s.column());
}
```

几个容易漏掉的地方：

- MyBatis-Plus 的 `last()`、`apply()`、`orderBy` 系列方法若拼接用户输入同样会注入，`apply` 要用 `{0}` 占位符传参
- JPA 的 JPQL / 原生 SQL 字符串拼接一样会注入，要用命名参数 `:name` 或 Criteria API
- 数据库账号按最小权限分配，应用账号不应有 `DROP`、`FILE` 等权限，注入发生时能把损失控制住

### 3、命令注入与表达式注入

```java
// 错误：交给 shell 解析，输入 "a.png; rm -rf /" 会执行第二条命令
new ProcessBuilder("sh", "-c", "convert " + fileName + " out.png").start();

// 正确：参数逐个传入，不经过 shell；文件名先按第八节做校验
new ProcessBuilder("convert", "--", fileName, "out.png").start();
```

`--` 告诉多数命令行工具"后面都是参数，不是选项"，防止以 `-` 开头的文件名被当成选项（参数注入）。

Spring 表达式（SpEL）同理：不要用 `StandardEvaluationContext` 解析用户输入，它能调用任意类的方法。确实需要让用户写表达式时，用只支持属性访问的 `SimpleEvaluationContext`：

```java
ExpressionParser parser = new SpelExpressionParser();
EvaluationContext ctx = SimpleEvaluationContext.forReadOnlyDataBinding().build();
Object value = parser.parseExpression(userExpression).getValue(ctx, rootObject);
```

---

## 三、XSS 跨站脚本

### 1、三种类型

| 类型 | 恶意脚本在哪 | 特点 |
|------|------------|------|
| 反射型 | URL 参数，服务端原样输出到页面 | 需诱导用户点击构造好的链接 |
| 存储型 | 数据库（评论、昵称、工单） | 所有查看该数据的用户都中招，危害最大 |
| DOM 型 | 前端 JS 把不可信数据写进 DOM | 不经过服务端，如 `element.innerHTML = location.hash` |

### 2、输出编码：按上下文转义

XSS 的根本防护是**输出时按所处上下文编码**，而不是在入库时"过滤危险字符"。同一个字符串放进 HTML 正文、属性、JS 字符串、URL 时需要的编码各不相同。

服务端模板：Thymeleaf 的 `th:text` 默认做 HTML 转义，`th:utext` 原样输出：

```html
<p th:text="${comment.content}">安全：&lt;script&gt; 会被转义</p>
<p th:utext="${comment.content}">危险：原样输出 HTML，只能用于已净化的内容</p>
```

手工拼输出时用 OWASP Java Encoder，按上下文选方法：

```java
import org.owasp.encoder.Encode;

String html = "<div>" + Encode.forHtml(name) + "</div>";
String attr = "<input value=\"" + Encode.forHtmlAttribute(name) + "\">";
String js   = "<script>var n = '" + Encode.forJavaScript(name) + "';</script>";
String url  = "/search?q=" + Encode.forUriComponent(keyword);
```

前后端分离时，React / Vue 的插值默认转义，风险集中在 `dangerouslySetInnerHTML`、`v-html`。后端 JSON 接口要返回正确的 `Content-Type: application/json`，配合 `X-Content-Type-Options: nosniff`，防止浏览器把 JSON 当 HTML 渲染。

富文本（用户可以提交 HTML）只能走白名单净化：

```java
import org.owasp.html.PolicyFactory;
import org.owasp.html.Sanitizers;

PolicyFactory policy = Sanitizers.FORMATTING.and(Sanitizers.LINKS).and(Sanitizers.BLOCKS);
String safeHtml = policy.sanitize(untrustedHtml);
```

### 3、CSP 与安全响应头

CSP（Content Security Policy）告诉浏览器只执行哪些来源的脚本，即使有漏网的注入点，内联脚本也无法执行。Spring Security 默认已经写出 `X-Content-Type-Options: nosniff`、`X-Frame-Options: DENY`、`Cache-Control` 禁缓存，以及 HTTPS 下的 `Strict-Transport-Security`；CSP 和 `Referrer-Policy` 需要自己加：

```java
@Bean
SecurityFilterChain web(HttpSecurity http) throws Exception {
    http
        .authorizeHttpRequests(auth -> auth.anyRequest().authenticated())
        .headers(headers -> headers
            .contentSecurityPolicy(csp -> csp.policyDirectives(
                "default-src 'self'; script-src 'self'; object-src 'none'; "
                + "base-uri 'self'; frame-ancestors 'none'"))
            .referrerPolicy(ref -> ref.policy(
                ReferrerPolicyHeaderWriter.ReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN))
            .httpStrictTransportSecurity(hsts -> hsts
                .includeSubDomains(true)
                .maxAgeInSeconds(31_536_000)));
    return http.build();
}
```

- 新上 CSP 时先用 `.reportOnly()` 观察违规报告，确认不误伤再切换为强制
- 避免 `'unsafe-inline'`、`'unsafe-eval'`，否则 CSP 对 XSS 几乎失去作用
- 会话 Cookie 设 `HttpOnly`（Spring Boot 默认开启）能防止脚本读取 Cookie，但不能阻止 XSS 以用户身份发请求，它只是纵深防御

---

## 四、CSRF 跨站请求伪造

### 1、原理

![CSRF 攻击流程与防线](../assets/security/vuln-csrf-attack.svg)

用户登录站点 A 后访问恶意站点 B，B 的页面自动向 A 提交表单。浏览器发往 A 的请求会**自动带上 A 的 Cookie**，A 只看 Cookie 就会认为是用户本人操作：

```html
<!-- 恶意站点 B 上的隐藏表单 -->
<form action="https://bank.example/transfer" method="POST">
  <input type="hidden" name="to" value="attacker">
  <input type="hidden" name="amount" value="10000">
</form>
<script>document.forms[0].submit();</script>
```

B 发得出请求，但读不到 A 的响应和 A 页面里的内容，所以只要请求里必须带一个 B 拿不到的值（CSRF Token），攻击就失败。

### 2、本站统一立场

CSRF 是否需要防护，只取决于一件事：**凭据是不是浏览器自动携带的**。

| 场景 | 凭据位置 | CSRF 防护 |
|------|---------|----------|
| 服务端渲染 + Session | Session Cookie | 必须开启 |
| SPA + BFF（推荐的浏览器方案） | BFF 持有令牌，浏览器只有 httpOnly 会话 Cookie | 必须开启（SPA 模式） |
| 令牌放在 httpOnly Cookie 里直接调 API | Cookie | 必须开启 |
| 纯 API：移动端、服务间、第三方调用 | `Authorization: Bearer` 头，令牌不进 Cookie | 可以关闭 |

结合 [JWT 令牌机制](./1_jwt) 中"浏览器端令牌不放 localStorage"的建议，本站对浏览器场景的统一做法是：**BFF + httpOnly 会话 Cookie + `SameSite=Lax` + CSRF Token**；只有不经浏览器 Cookie、只认 `Authorization` 头的无状态 API 才关闭 CSRF。

### 3、Spring Security 7 配置

同一个应用里同时有两类入口时，用两条 `SecurityFilterChain` 分开：

```java
@Configuration
@EnableWebSecurity
public class SecurityConfig {

    // 纯 API：只认 Authorization 头里的 Bearer Token，不用 Cookie，可关闭 CSRF
    @Bean
    @Order(1)
    SecurityFilterChain apiChain(HttpSecurity http) throws Exception {
        http
            .securityMatcher("/api/open/**")   // Spring Security 7 中字符串默认按 PathPatternRequestMatcher 解析
            .authorizeHttpRequests(auth -> auth.anyRequest().authenticated())
            .oauth2ResourceServer(oauth2 -> oauth2.jwt(Customizer.withDefaults()))
            .sessionManagement(s -> s.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
            .csrf(csrf -> csrf.disable());
        return http.build();
    }

    // 浏览器入口（BFF / 服务端会话）：凭据在 Cookie 中，必须开启 CSRF
    @Bean
    @Order(2)
    SecurityFilterChain browserChain(HttpSecurity http) throws Exception {
        http
            .authorizeHttpRequests(auth -> auth
                .requestMatchers("/login/**", "/oauth2/**", "/error").permitAll()
                .anyRequest().authenticated())
            .oauth2Login(Customizer.withDefaults())
            .csrf(csrf -> csrf.spa());   // SPA：Token 写入 XSRF-TOKEN Cookie，前端回传 X-XSRF-TOKEN 头
        return http.build();
    }
}
```

- `csrf.spa()` 把 Token 写进 JavaScript 可读的 `XSRF-TOKEN` Cookie，前端在写请求里用 `X-XSRF-TOKEN` 头回传；Axios 对同源请求会自动完成这一步
- 登录成功和登出后 CSRF Cookie 会被清除，前端需要重新获取一次 Token 再发写请求
- 服务端渲染的表单只要用 `th:action`，Thymeleaf 与 Spring Security 的集成会自动插入隐藏的 `_csrf` 字段：

```html
<form th:action="@{/transfer}" method="post">
  <!-- 自动生成：<input type="hidden" name="_csrf" value="..."> -->
  <input name="to"><input name="amount">
  <button type="submit">转账</button>
</form>
```

### 4、SameSite：用 Lax，不用 Strict

```yaml
server:
  servlet:
    session:
      cookie:
        same-site: lax     # 跨站的 POST / iframe / 图片请求不带 Cookie，跨站顶级 GET 导航仍带
        secure: true
        http-only: true
```

::: warning SameSite=Strict 会破坏 SSO 回调
`Strict` 下，只要是从别的站点跳过来的请求，浏览器一律不带 Cookie。OIDC / SSO 登录时，IdP 把浏览器重定向回应用的回调地址，这是一次跨站的顶级导航：应用收不到会话 Cookie，就找不到登录前保存在会话里的 `state`，登录失败或要求重新登录。从邮件、IM 里点链接进入站点也会表现为"未登录"。因此会话 Cookie 统一用 `Lax`。若 IdP 使用 `response_mode=form_post`（跨站 POST 回调），连 `Lax` 也不会带 Cookie，需要改用默认的 query 模式。
:::

SameSite 只是纵深防御，不能替代 CSRF Token：同站（same-site）的子域被攻破时它不起作用；`Lax` 允许跨站顶级 GET，所以**任何有副作用的操作都不能用 GET**。

---

## 五、SSRF 服务端请求伪造

![SSRF 与出站校验](../assets/security/vuln-ssrf-guard.svg)

凡是"服务端按用户给的 URL 去发请求"的功能都可能被利用：图片抓取、链接预览、Webhook 回调地址、导入远程文件、PDF 生成。攻击者把 URL 换成内网地址，让服务器替他访问：

- `http://169.254.169.254/latest/meta-data/iam/security-credentials/`：云主机元数据服务，可拿到临时访问密钥（阿里云为 `100.100.100.200`）
- `http://10.0.1.5:6379/`、`http://localhost:8080/actuator/env`：内网服务、管理端点
- `file:///etc/passwd`、`gopher://`：利用非 HTTP 协议读文件或构造任意 TCP 报文

### 1、出站校验

```java
public final class OutboundUrlGuard {

    private static final Set<String> ALLOWED_HOSTS = Set.of("api.partner.com", "img.cdn.example.com");

    public static URI check(String raw) {
        URI uri = URI.create(raw);   // 格式非法时抛 IllegalArgumentException
        if (!"https".equalsIgnoreCase(uri.getScheme())) {
            throw new IllegalArgumentException("only https is allowed");
        }
        String host = uri.getHost();  // https://api.partner.com@evil.com 的 host 是 evil.com，会被白名单拦下
        if (host == null || !ALLOWED_HOSTS.contains(host.toLowerCase(Locale.ROOT))) {
            throw new IllegalArgumentException("host not allowed");
        }
        try {
            for (InetAddress addr : InetAddress.getAllByName(host)) {
                if (isInternal(addr)) {
                    throw new IllegalArgumentException("resolves to internal address");
                }
            }
        } catch (UnknownHostException e) {
            throw new IllegalArgumentException("unknown host", e);
        }
        return uri;
    }

    static boolean isInternal(InetAddress a) {
        if (a.isAnyLocalAddress() || a.isLoopbackAddress() || a.isSiteLocalAddress()
                || a.isLinkLocalAddress()        // 169.254.0.0/16，含云元数据地址
                || a.isMulticastAddress()) {
            return true;
        }
        byte[] b = a.getAddress();
        if (b.length == 4) {
            return (b[0] & 0xFF) == 100 && (b[1] & 0xC0) == 64;   // 100.64.0.0/10，含阿里云元数据
        }
        return (b[0] & 0xFE) == 0xFC;                              // IPv6 唯一本地地址 fc00::/7
    }
}
```

发请求的客户端**禁止跟随重定向**，否则白名单内的地址返回一个 302 指向内网就绕过了校验：

```java
HttpClient httpClient = HttpClient.newBuilder()
        .followRedirects(HttpClient.Redirect.NEVER)
        .connectTimeout(Duration.ofSeconds(3))
        .build();

RestClient client = RestClient.builder()
        .requestFactory(new JdkClientHttpRequestFactory(httpClient))
        .build();

String body = client.get().uri(OutboundUrlGuard.check(userUrl)).retrieve().body(String.class);
```

### 2、网络层兜底

应用层校验在"校验时解析一次、连接时再解析一次"之间存在 DNS 重绑定的窗口，所以还需要网络层的限制：

- 抓取类功能走专用的**出口代理**，由代理统一拒绝内网网段；或用 Kubernetes NetworkPolicy 限制 Pod 的出站目标
- AWS 上强制使用 **IMDSv2**（访问元数据需先用 PUT 获取会话令牌，并可把跳数限制为 1），普通的 GET 型 SSRF 拿不到凭据
- 能用白名单就不用黑名单；必须允许任意外部地址时（如用户自定义 Webhook），把这类请求隔离到没有内网权限的独立服务里执行

---

## 六、不安全的反序列化

### 1、典型漏洞

| 组件 | 问题 | 现状 |
|------|------|------|
| Java 原生序列化 + Commons Collections 等 | `readObject` 触发 gadget 链执行任意代码 | 不对不可信数据做原生反序列化 |
| Fastjson 1.x | AutoType 让 JSON 指定任意类名，黑名单多次被绕过（1.2.83 修复已知绕过） | 2.x 默认关闭 AutoType，不要手动开启 |
| Jackson 2.x | 开启 Default Typing 后 JSON 可指定类名，配合 gadget RCE | 2.10 起引入 `PolymorphicTypeValidator`；Jackson 3 激活 Default Typing 必须传入校验器 |
| SnakeYAML 1.x | `new Yaml().load()` 可按全局标签实例化任意类（CVE-2022-1471） | 2.0 起默认不允许全局标签 |

共同点是：**数据决定了要实例化哪个类**。防护就是不让外部数据决定类型。

### 2、Jackson 3：用逻辑名做多态

需要多态时，用 `@JsonTypeInfo(use = Id.NAME)` 加显式子类型列表，JSON 里只出现逻辑名，不出现类名：

```java
@JsonTypeInfo(use = JsonTypeInfo.Id.NAME, property = "type")
@JsonSubTypes({
    @JsonSubTypes.Type(value = CardPayment.class, name = "card"),
    @JsonSubTypes.Type(value = WalletPayment.class, name = "wallet")
})
public sealed interface Payment permits CardPayment, WalletPayment {}

public record CardPayment(String cardToken, long amount) implements Payment {}
public record WalletPayment(String walletId, long amount) implements Payment {}
```

不要使用 `Id.CLASS` / `Id.MINIMAL_CLASS`。确实要对缓存等内部数据启用全局 Default Typing 时，用白名单式的校验器限定包前缀：

```java
import tools.jackson.databind.DefaultTyping;
import tools.jackson.databind.json.JsonMapper;
import tools.jackson.databind.jsontype.BasicPolymorphicTypeValidator;
import tools.jackson.databind.jsontype.PolymorphicTypeValidator;

PolymorphicTypeValidator ptv = BasicPolymorphicTypeValidator.builder()
        .allowIfSubType("com.example.cache.")
        .build();

JsonMapper mapper = JsonMapper.builder()
        .activateDefaultTyping(ptv, DefaultTyping.NON_FINAL)
        .build();
```

Jackson 3 的包名从 `com.fasterxml.jackson` 改为 `tools.jackson`（注解仍在 `com.fasterxml.jackson.annotation`），`ObjectMapper` 不可变，配置统一通过 `JsonMapper.builder()` 完成，详见 [序列化](/java/19_topic_serialization)。

### 3、Java 原生序列化

对外接口一律用 JSON / Protobuf。遗留系统必须接收原生序列化数据时，用 `ObjectInputFilter`（JDK 9+）配置以 `!*` 结尾的白名单：

```java
ObjectInputFilter filter = ObjectInputFilter.Config.createFilter(
        "com.example.dto.*;java.base/*;maxdepth=20;maxarray=10000;!*");
try (ObjectInputStream in = new ObjectInputStream(input)) {
    in.setObjectInputFilter(filter);
    Object obj = in.readObject();
}
```

进程级过滤器 `-Djdk.serialFilter` 与 JDK 17 的过滤器工厂见 [序列化](/java/19_topic_serialization)。

---

## 七、XXE 外部实体注入

XML 的 DTD 可以声明外部实体，解析器会去读取实体指向的文件或 URL：

```xml
<?xml version="1.0"?>
<!DOCTYPE data [ <!ENTITY xxe SYSTEM "file:///etc/passwd"> ]>
<data>&xxe;</data>
```

解析后 `&xxe;` 被替换为文件内容，若结果回显给用户就造成任意文件读取；实体指向内网 URL 时就是 SSRF。JDK 自带的 JAXP 解析器默认允许 DTD，必须显式关闭：

```java
DocumentBuilderFactory dbf = DocumentBuilderFactory.newInstance();
// 最彻底：直接禁止 DOCTYPE 声明，带 DTD 的文档会解析失败
dbf.setFeature("http://apache.org/xml/features/disallow-doctype-decl", true);
dbf.setFeature(XMLConstants.FEATURE_SECURE_PROCESSING, true);
dbf.setXIncludeAware(false);
dbf.setExpandEntityReferences(false);
DocumentBuilder builder = dbf.newDocumentBuilder();
```

`SAXParserFactory`、`XMLInputFactory`（StAX）、`TransformerFactory`、`SchemaFactory` 各有对应开关，每种解析器的写法见文末 OWASP XXE Cheat Sheet。能用 JSON 的接口尽量不接收 XML；处理 SVG、DOCX、XLSX 等本质是 XML 的上传文件时同样要注意。

---

## 八、路径穿越与文件上传

### 1、路径穿越

下载接口 `GET /files?name=../../etc/passwd` 若直接拼路径，就能读到任意文件。校验方法是"规范化后必须仍在根目录下"：

```java
private static final Path BASE = Path.of("/data/uploads").toAbsolutePath().normalize();

public Path resolveSafe(String name) {
    Path target = BASE.resolve(name).normalize();
    if (!target.startsWith(BASE)) {
        throw new IllegalArgumentException("invalid path");
    }
    return target;
}
```

`Path.startsWith` 按路径段比较，不会把 `/data/uploads-evil` 误判为 `/data/uploads` 的子目录。目录内若可能存在符号链接，再对已存在的文件调用 `toRealPath()` 后做同样的判断。更好的做法是对外只暴露文件 ID，由服务端查表得到真实路径。

### 2、文件上传

| 风险 | 防护 |
|------|------|
| 上传 WebShell（`.jsp`）并被执行 | 存到对象存储或 Web 根目录之外，存储路径不可执行 |
| 伪造扩展名 / Content-Type | 扩展名白名单 + 按文件头魔数检测真实类型（如 Apache Tika） |
| 文件名里带 `../` 或特殊字符 | 服务端用 UUID 重命名，原始文件名只存数据库 |
| 上传 HTML / SVG 造成存储型 XSS | 下载时返回 `Content-Disposition: attachment` 与 `nosniff`，用户文件放独立域名 |
| 超大文件、压缩炸弹拖垮服务 | 限制大小，解压时限制总大小与条目数 |

```yaml
spring:
  servlet:
    multipart:
      max-file-size: 10MB
      max-request-size: 20MB
```

对象存储的直传与签名 URL 方案见 [对象存储](/architecture/4_object_storage)。

---

## 九、日志注入与 Log4Shell

**日志注入**：用户输入里的 `\r\n` 会在文本日志中伪造出一行新日志（如伪造一条"管理员登录成功"），干扰审计与告警。最简单的解决办法是输出结构化 JSON 日志（Spring Boot 3.4 起支持 `logging.structured.format.console=ecs` 等），换行会被转义；坚持用文本格式时在 pattern 里替换换行：

```xml
<!-- logback-spring.xml：把消息中的回车换行替换为下划线 -->
<pattern>%d{ISO8601} %-5level [%thread] %logger{36} - %replace(%msg){'[\r\n]', '_'}%n</pattern>
```

**Log4Shell（CVE-2021-44228）**：Log4j 2 会解析日志消息里的 `${jndi:ldap://...}` 查找表达式并加载远程类，只要把用户输入写进日志就能远程执行代码。后续又修补了 CVE-2021-45046、CVE-2021-45105、CVE-2021-44832，完整修复需要 **2.17.1 及以上**（Java 8+），实际使用时跟随 Spring Boot BOM 用最新的 2.x 版本。Spring Boot 默认的日志实现是 Logback，只有显式切换到 `spring-boot-starter-log4j2` 的项目才使用 Log4j 2 核心。

日志脱敏、日志注入的完整说明见 [日志](/spring-boot/12_logging)。

---

## 十、依赖与供应链漏洞

A03 软件供应链失败覆盖的范围比"依赖有 CVE"更广：依赖本身的漏洞、被投毒的包、被篡改的构建流水线、来源不可追溯的制品。Java 项目的基本动作：

- **漏洞扫描进 CI**：PR 上跑速度快的 OSV-Scanner 或 Trivy，每日定时跑 OWASP Dependency-Check；Dependency-Check 需要配置 NVD API Key，否则漏洞库同步极慢
- **自动升级**：用 Renovate 或 Dependabot 持续提升级 PR，版本统一由 BOM 管理
- **SBOM**：用 CycloneDX 插件生成软件物料清单，漏洞爆发时能在几分钟内回答"哪些服务用了受影响版本"
- **完整性**：校验依赖签名与校验和，CI 中的第三方 Action 固定到完整 commit SHA

具体配置（插件版本、误报抑制、研判流程、SBOM 生成与 `/actuator/sbom`）见 [依赖治理](/engineering/6_dependency_governance)，镜像扫描见 [Docker](/cloud-native/5_docker)。

---

## 十一、越权访问

越权在 OWASP 2025 版中仍排第一。最常见的是 **BOLA**（Broken Object Level Authorization，对象级越权）：接口只校验了"已登录"，没有校验"这条数据是不是你的"。

```java
// 错误：任何登录用户把 orderId 换一个数字就能看别人的订单
@GetMapping("/orders/{orderId}")
public OrderView getOrder(@PathVariable Long orderId) {
    return orderService.findById(orderId);
}
```

正确做法是把归属条件放进查询，查不到就返回 404（不返回 403，避免暴露"这个 ID 存在"）：

```java
// LoginUser 是自定义的认证主体（实现 UserDetails 或由 JWT 转换而来），携带用户 ID
@GetMapping("/orders/{orderId}")
public OrderView getOrder(@PathVariable Long orderId,
                          @AuthenticationPrincipal LoginUser user) {
    return orderService.findOwned(orderId, user.id())
            .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND));
}
```

```java
@Select("SELECT id, user_id, amount, status FROM orders WHERE id = #{id} AND user_id = #{userId}")
Optional<Order> findByIdAndUserId(@Param("id") Long id, @Param("userId") Long userId);
```

- 用户 ID 一律取自认证主体，绝不信任请求参数或请求体里的 `userId`
- 对外暴露的 ID 可以用不可猜测的 UUID，但这只是增加枚举难度，不能替代归属校验
- 垂直越权（普通用户调管理接口）靠接口级授权解决，见 [权限模型：RBAC 与 ABAC](./5_rbac_abac) 与 [Spring Security](/spring/9_security) 的方法级权限
- "只能看本部门数据"这类行级数据权限，统一在 SQL 层追加过滤条件，实现见 [权限系统架构设计](/architecture/6_access_control)

---

## 十二、异常条件处理

A10 关注的是出错时系统处于什么状态。原则是**失败即拒绝（fail-closed）**：

```java
// 错误：策略服务超时或返回空，就当作允许
boolean allowed;
try {
    allowed = policyClient.check(request);
} catch (Exception e) {
    allowed = true;
}

// 正确：任何异常或拿不到明确的"允许"，都按拒绝处理
boolean allowed;
try {
    allowed = Boolean.TRUE.equals(policyClient.check(request));
} catch (RuntimeException e) {
    log.warn("policy check failed, deny by default", e);
    allowed = false;
}
```

- 授权、签名校验、风控这类安全判断出错时一律拒绝；可用性需求通过降级页面满足，而不是放行
- 对外错误响应只给错误码和通用信息，堆栈、SQL、内部路径只写日志，做法见 [API 安全](./6_api_security)
- 资源耗尽类异常（超大请求、深层嵌套 JSON、正则回溯）要有上限：请求体大小、JSON 嵌套深度、超时
- 事务中途失败要回滚干净，避免出现"扣了款没发货"之类的半完成状态

---

## 小结

- OWASP Top 10:2025 中，SSRF 并入 A01 访问控制失效，新增 A03 软件供应链失败与 A10 异常条件处理不当
- 注入类漏洞的根本解法是数据与代码分离：SQL 用 `#{}` / 参数化，排序字段走枚举映射，命令不经 shell，SpEL 用 `SimpleEvaluationContext`
- XSS 靠按上下文输出编码，CSP 与 `HttpOnly` 是纵深防御
- CSRF 只看凭据是否由浏览器自动携带：浏览器场景用 BFF + httpOnly Cookie + `SameSite=Lax` + CSRF Token，只有纯 `Authorization` 头的无状态 API 才关闭 CSRF；`Strict` 会破坏 SSO 回调
- SSRF 用协议与域名白名单、解析后拒绝内网地址、禁止重定向，再用出口代理和 IMDSv2 兜底
- 反序列化不让外部数据决定类型：Jackson 用 `Id.NAME` 多态，原生序列化用 `ObjectInputFilter` 白名单；XML 解析禁用 DTD
- 越权的解法是把归属条件写进查询；安全判断出错一律拒绝

---

## 参考资料

- OWASP Top 10:2025：[OWASP Top 10:2025](https://top10.owasp.org/2025/)、[A01:2025 Broken Access Control](https://top10.owasp.org/2025/A01_2025-Broken_Access_Control/)
- OWASP Cheat Sheet Series：[SQL Injection Prevention](https://cheatsheetseries.owasp.org/cheatsheets/SQL_Injection_Prevention_Cheat_Sheet.html)、[Cross Site Scripting Prevention](https://cheatsheetseries.owasp.org/cheatsheets/Cross_Site_Scripting_Prevention_Cheat_Sheet.html)、[Cross-Site Request Forgery Prevention](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html)、[Server Side Request Forgery Prevention](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html)、[Deserialization](https://cheatsheetseries.owasp.org/cheatsheets/Deserialization_Cheat_Sheet.html)、[XML External Entity Prevention](https://cheatsheetseries.owasp.org/cheatsheets/XML_External_Entity_Prevention_Cheat_Sheet.html)、[File Upload](https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html)
- Spring Security 参考文档：[Cross Site Request Forgery (CSRF)](https://docs.spring.io/spring-security/reference/servlet/exploits/csrf.html)、[Security HTTP Response Headers](https://docs.spring.io/spring-security/reference/servlet/exploits/headers.html)
- MDN：[Content Security Policy (CSP)](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/CSP)、[Set-Cookie SameSite](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Set-Cookie#samesitesamesite-value)
- OWASP 编码与净化库：[OWASP Java Encoder](https://owasp.org/www-project-java-encoder/)、[OWASP Java HTML Sanitizer](https://owasp.org/www-project-java-html-sanitizer/)
- AWS 元数据服务：[Use the Instance Metadata Service (IMDSv2)](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/configuring-instance-metadata-service.html)
- Log4Shell：[CVE-2021-44228](https://nvd.nist.gov/vuln/detail/CVE-2021-44228)、[Apache Log4j Security Vulnerabilities](https://logging.apache.org/security.html)
- Java 序列化过滤：[Serialization Filtering（Oracle Java SE 21）](https://docs.oracle.com/en/java/javase/21/core/serialization-filtering1.html)
- Jackson 多态安全：[Jackson Polymorphic Deserialization CVE Criteria](https://github.com/FasterXML/jackson/wiki/Jackson-Polymorphic-Deserialization-CVE-Criteria)、[Jackson Polymorphic Deserialization](https://github.com/FasterXML/jackson-docs/wiki/JacksonPolymorphicDeserialization)

> 下一篇：[零信任架构](./9_zero_trust) —— 不再信任网络位置，用户、设备与服务的每一次访问都显式验证。
