# 常见漏洞与防护

## 一、OWASP Top 10（2021 版）

| 排名 | 漏洞类型 | 常见场景 |
|------|---------|---------|
| A01 | **访问控制失效** | 越权访问他人数据（水平越权）、普通用户访问管理接口（垂直越权）|
| A02 | **加密失败** | 明文传输密码、用 MD5 存密码、HTTP 传输敏感数据 |
| A03 | **注入** | SQL 注入、LDAP 注入、命令注入、SSTI 模板注入 |
| A04 | **不安全设计** | 缺乏安全需求分析、没有威胁建模、业务逻辑漏洞 |
| A05 | **安全配置错误** | 默认凭据未修改、不必要的功能开启、详细错误信息暴露 |
| A06 | **易受攻击的组件** | 使用含已知 CVE 漏洞的依赖库（Fastjson、Log4j 等）|
| A07 | **认证失败** | 暴力破解无限速、会话 ID 可预测、密码弱 |
| A08 | **数据完整性失败** | 不安全的反序列化、CI/CD 管道被篡改、不校验更新包签名 |
| A09 | **日志与监控不足** | 无法检测攻击、事后无法追溯操作、告警缺失 |
| A10 | **SSRF** | 服务端请求伪造，访问内网元数据服务（AWS `169.254.169.254`）|

---

## 二、SQL 注入

### 原理

攻击者通过拼接 SQL 破坏查询逻辑：

```java
// ❌ 拼接 SQL，存在注入漏洞
String sql = "SELECT * FROM users WHERE username = '" + username + "'";
// 攻击输入：' OR '1'='1
// 实际执行：SELECT * FROM users WHERE username = '' OR '1'='1'  → 绕过认证，返回所有用户
```

### 防护

```java
// ✅ PreparedStatement 参数化查询（JDBC）
String sql = "SELECT * FROM users WHERE username = ?";
try (PreparedStatement ps = conn.prepareStatement(sql)) {
    ps.setString(1, username);   // 参数作为数据，不会被当作 SQL 解析
    ResultSet rs = ps.executeQuery();
}
```

```xml
<!-- MyBatis：#{} 参数化，${} 直接拼接（危险） -->

<!-- ✅ 使用 #{} — 安全，底层是 PreparedStatement -->
<select id="findByUsername" resultType="User">
  SELECT * FROM users WHERE username = #{username}
</select>

<!-- ❌ 使用 ${} — 直接拼接，存在注入风险 -->
<select id="findOrdered" resultType="User">
  SELECT * FROM users ORDER BY ${sortField}   <!-- 攻击者可注入任意 SQL -->
</select>
```

**`${}` 的安全用法**（仅用于动态表名/列名，配合白名单）：

```java
private static final Set<String> ALLOWED_SORT = Set.of("name", "age", "created_at");

public List<User> findOrdered(String sortField) {
    if (!ALLOWED_SORT.contains(sortField)) {
        throw new IllegalArgumentException("Invalid sort field: " + sortField);
    }
    return userMapper.findOrdered(sortField);   // 此时 ${} 是安全的
}
```

---

## 三、XSS（跨站脚本）

### 三种类型

| 类型 | 特征 | 危害 |
|------|------|------|
| **反射型** | 恶意脚本在 URL 参数中，服务端返回响应时直接输出 | 诱导用户点击恶意链接 |
| **存储型** | 恶意脚本存入数据库，所有访问该数据的用户都受影响 | 危害最大，持久存在 |
| **DOM 型** | 完全在浏览器端执行，不经过服务端 | `document.write(location.hash)` |

### 防护

```java
// 1. 输出编码：Thymeleaf th:text 自动转义（推荐）
// th:text 会把 <script> 转义为 &lt;script&gt;
<p th:text="${userInput}">   <!-- 安全：自动转义 -->
<p th:utext="${userInput}">  <!-- 危险：原始 HTML 输出，仅用于可信内容 -->
```

```java
// 2. Content Security Policy（CSP）响应头
http.headers(h -> h.contentSecurityPolicy(csp ->
    csp.policyDirectives(
        "default-src 'self'; " +
        "script-src 'self'; " +
        "object-src 'none'; " +
        "frame-ancestors 'none'"
    )));
```

```yaml
# 3. Cookie httpOnly（防止 XSS 偷取 Token）
server:
  servlet:
    session:
      cookie:
        http-only: true
        secure: true
```

```java
// 4. 富文本场景：使用白名单过滤（OWASP Java HTML Sanitizer）
PolicyFactory policy = Sanitizers.FORMATTING.and(Sanitizers.LINKS);
String safeHtml = policy.sanitize(userInput);
```

---

## 四、CSRF（跨站请求伪造）

### 原理

用户登录 A 网站后，访问攻击者的 B 网站，B 偷偷向 A 发起请求（浏览器自动携带 Cookie）：

```html
<!-- 攻击者 B 网站的隐藏表单 -->
<form action="https://bank.com/transfer" method="POST">
  <input name="to" value="attacker_account">
  <input name="amount" value="10000">
</form>
<script>document.forms[0].submit();</script>
```

### 防护

```java
// 1. Spring Security CSRF Token（传统表单，默认开启）
<form th:action="@{/transfer}" method="post">
  <input type="hidden" th:name="${_csrf.parameterName}" th:value="${_csrf.token}"/>
  <!-- ... -->
</form>
```

```yaml
# 2. SameSite Cookie（现代浏览器，最简单的防护）
server:
  servlet:
    session:
      cookie:
        same-site: strict    # strict: 完全禁止跨站携带；lax: 允许顶级导航 GET 请求
```

```java
// 3. 前后端分离：Token 放 Authorization Header（天然防 CSRF）
// 攻击者无法读取 Authorization Header，也无法伪造它
// REST API 默认可关闭 CSRF Token
http.csrf(csrf -> csrf.disable());
```

---

## 五、不安全的反序列化

### Java 历史漏洞

| 组件 | 版本 | 漏洞 |
|------|------|------|
| Fastjson | < 1.2.83 | AutoType 远程代码执行（RCE）|
| Jackson | < 2.10 | Polymorphic Type Handling RCE |
| Apache Commons Collections | 多版本 | Java 原生反序列化 gadget chain |
| Log4j | 2.x < 2.17 | JNDI 注入（Log4Shell，CVE-2021-44228）|

### 防护

```java
// 1. Fastjson：升级到 2.x（不再有 AutoType 问题）
//    或 1.x 显式关闭 AutoType
ParserConfig.getGlobalInstance().setAutoTypeSupport(false);

// 2. Jackson：禁用 Default Typing
ObjectMapper mapper = new ObjectMapper();
mapper.deactivateDefaultTyping();          // 不启用多态类型
// 需要多态时，用 @JsonTypeInfo 精确控制，不用 enableDefaultTyping()

// 3. Java 原生序列化：尽量用 JSON/Protobuf 替代
//    不可避免时，实现 ObjectInputFilter 过滤不安全的类
ObjectInputStream ois = new ObjectInputStream(input);
ois.setObjectInputFilter(info -> {
    if (info.serialClass() != null &&
        !ALLOW_LIST.contains(info.serialClass().getName())) {
        return ObjectInputFilter.Status.REJECTED;
    }
    return ObjectInputFilter.Status.ALLOWED;
});
```

**依赖安全扫描（集成到 CI）：**

```xml
<!-- Maven OWASP Dependency Check -->
<plugin>
  <groupId>org.owasp</groupId>
  <artifactId>dependency-check-maven</artifactId>
  <version>9.2.0</version>
  <configuration>
    <failBuildOnCVSS>7</failBuildOnCVSS>   <!-- CVSS ≥ 7 时构建失败 -->
  </configuration>
</plugin>
```

---

## 六、越权访问（Broken Access Control）

越权是 OWASP 2021 第一名，最常见且最容易被忽视。

```java
// ❌ 水平越权：只校验登录，未校验是否是本人数据
@GetMapping("/orders/{orderId}")
public Order getOrder(@PathVariable Long orderId) {
    return orderService.findById(orderId);  // 任何登录用户都能查任意订单
}

// ✅ 加上数据归属校验
@GetMapping("/orders/{orderId}")
public Order getOrder(@PathVariable Long orderId,
                      @AuthenticationPrincipal UserDetails user) {
    Order order = orderService.findById(orderId);
    if (!order.getUserId().equals(Long.parseLong(user.getUsername()))) {
        throw new AccessDeniedException("Forbidden");
    }
    return order;
}
```

```java
// ✅ 或者在查询层就加入用户过滤
@Select("SELECT * FROM orders WHERE id = #{id} AND user_id = #{userId}")
Order findByIdAndUserId(@Param("id") Long id, @Param("userId") Long userId);
```
