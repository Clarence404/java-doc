# 数据安全

## 一、加密算法

### 对称加密（AES）

加解密使用同一密钥，速度快，适合大量数据加密。

| 模式 | 说明 | 推荐 |
|------|------|:---:|
| AES-256-GCM | 认证加密，自带完整性校验，无 padding 攻击风险 | ✅ 首选 |
| AES-256-CBC | 需要 PKCS7 padding，IV 必须随机，无完整性校验 | 兼容 |
| AES-128-ECB | 相同明文产生相同密文，不安全 | ❌ |

```java
// AES-256-GCM 加密
public static byte[] encrypt(byte[] plaintext, SecretKey key) throws Exception {
    Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
    byte[] iv = new byte[12];                         // GCM 推荐 12 字节 IV
    new SecureRandom().nextBytes(iv);

    cipher.init(Cipher.ENCRYPT_MODE, key, new GCMParameterSpec(128, iv));
    byte[] ciphertext = cipher.doFinal(plaintext);

    // 实际存储格式：iv(12 字节) + ciphertext
    ByteBuffer buf = ByteBuffer.allocate(12 + ciphertext.length);
    return buf.put(iv).put(ciphertext).array();
}

// AES-256-GCM 解密
public static byte[] decrypt(byte[] encrypted, SecretKey key) throws Exception {
    ByteBuffer buf = ByteBuffer.wrap(encrypted);
    byte[] iv = new byte[12];
    buf.get(iv);
    byte[] ciphertext = new byte[buf.remaining()];
    buf.get(ciphertext);

    Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
    cipher.init(Cipher.DECRYPT_MODE, key, new GCMParameterSpec(128, iv));
    return cipher.doFinal(ciphertext);
}
```

### 非对称加密（RSA / ECC）

私钥签名或解密，公钥任意分发。适合密钥交换、数字签名，**不适合加密大量数据**（速度慢）。

| 场景 | 算法 |
|------|------|
| JWT 签名 | RS256（RSA）/ ES256（ECDSA，密钥更短，更快）|
| 加密对称密钥（信封加密）| RSA-OAEP |
| TLS 密钥协商 | ECDH |

### 密码哈希

密码**不能可逆加密**，只能单向哈希，且必须加盐：

```java
// BCrypt（Spring Security 默认，推荐）
BCryptPasswordEncoder encoder = new BCryptPasswordEncoder(12); // cost=12，约 300ms/次
String hash = encoder.encode("password");
encoder.matches("password", hash);  // 验证

// Argon2（更新，抗 GPU 暴力破解，OWASP 推荐）
Argon2PasswordEncoder encoder = Argon2PasswordEncoder.defaultsForSpringSecurity_v5_8();
```

> **永远不要用 MD5/SHA-1/SHA-256 直接哈希密码**——彩虹表可破解，速度太快（GPU 每秒可算数十亿次）。

---

## 二、数据脱敏

### 脱敏规则

| 数据类型 | 规则 | 示例 |
|---------|------|------|
| 手机号 | 保留前 3 后 4，中间 `****` | `138****5678` |
| 身份证 | 保留前 6 后 4，中间 `********` | `110101********1234` |
| 银行卡 | 保留后 4 位 | `**** **** **** 6789` |
| 邮箱 | 用户名保留首字符 | `a***@example.com` |
| 姓名 | 保留姓 | `张*` |

```java
public final class Desensitize {
    public static String phone(String phone) {
        if (phone == null || phone.length() < 7) return phone;
        return phone.substring(0, 3) + "****" + phone.substring(phone.length() - 4);
    }

    public static String idCard(String id) {
        if (id == null || id.length() < 10) return id;
        return id.substring(0, 6) + "********" + id.substring(id.length() - 4);
    }

    public static String email(String email) {
        if (email == null || !email.contains("@")) return email;
        String[] parts = email.split("@");
        return parts[0].charAt(0) + "***@" + parts[1];
    }
}
```

### Jackson 序列化脱敏（接口输出自动脱敏）

```java
// 自定义注解
@Target(ElementType.FIELD)
@Retention(RetentionPolicy.RUNTIME)
@JacksonAnnotationsInside
@JsonSerialize(using = SensitiveSerializer.class)
public @interface Sensitive {
    SensitiveType type();
}

// 自定义序列化器
public class SensitiveSerializer extends JsonSerializer<String>
    implements ContextualSerializer {

    private SensitiveType type;

    @Override
    public void serialize(String value, JsonGenerator gen, ...) throws IOException {
        gen.writeString(switch (type) {
            case PHONE   -> Desensitize.phone(value);
            case ID_CARD -> Desensitize.idCard(value);
            case EMAIL   -> Desensitize.email(value);
        });
    }
    // ...createContextual 获取 type
}

// 使用
public class UserVO {
    @Sensitive(type = SensitiveType.PHONE)
    private String phone;

    @Sensitive(type = SensitiveType.ID_CARD)
    private String idCard;
}
```

---

## 三、密钥管理

### 密钥生命周期

```
生成 → 存储 → 分发 → 使用 → 轮换 → 撤销 → 销毁
```

### 存储方案对比

| 方案 | 安全性 | 典型场景 |
|------|:------:|---------|
| 硬编码 | ❌ 极低 | 绝对不用 |
| 环境变量 | 低 | 开发 / 测试 |
| K8s Secret | 中（etcd 需加密）| 容器化应用 |
| Nacos / Apollo 加密字段 | 中 | 配置中心 |
| HashiCorp Vault | 高 | 推荐生产 |
| 云 KMS（AWS / 阿里云）| 高 | 云原生，密钥材料不出云 |
| HSM（硬件安全模块）| 极高 | 金融 / 支付合规 |

### jasypt 配置加密（配置中心方案）

```xml
<dependency>
  <groupId>com.github.ulisesbocchio</groupId>
  <artifactId>jasypt-spring-boot-starter</artifactId>
  <version>3.0.5</version>
</dependency>
```

```yaml
jasypt:
  encryptor:
    password: ${JASYPT_MASTER_KEY}         # 主密钥通过环境变量注入
    algorithm: PBEWITHHMACSHA512ANDAES_256

spring:
  datasource:
    password: ENC(加密后的密文)             # ENC() 包裹的内容自动解密
```

### HashiCorp Vault 动态凭证

```yaml
# spring-cloud-vault-config
spring:
  cloud:
    vault:
      uri: https://vault.example.com
      authentication: KUBERNETES    # K8s ServiceAccount 认证，无需硬编码 token
      kv:
        enabled: true
        backend: secret
        default-context: myapp
      database:
        enabled: true
        role: app-db-role           # Vault 自动轮换数据库凭证，应用无感知
```

```java
// 应用中直接用 @Value 读取，Vault 自动注入
@Value("${database.username}")
private String dbUsername;

@Value("${database.password}")
private String dbPassword;
```

### 密钥轮换最佳实践

```
定期轮换（至少每 90 天）
    ↓
生成新密钥，新旧密钥同时有效（重叠期，避免在途请求失败）
    ↓
应用逐步迁移到新密钥（灰度或重启）
    ↓
下线旧密钥
    ↓
记录轮换操作到审计日志
```

```java
// JWT 双密钥过渡：新旧 token 都能验证
@Bean
public JwtDecoder jwtDecoder(KeyPair currentKeyPair, KeyPair oldKeyPair) {
    NimbusJwtDecoder current = NimbusJwtDecoder
        .withPublicKey((RSAPublicKey) currentKeyPair.getPublic()).build();
    NimbusJwtDecoder old = NimbusJwtDecoder
        .withPublicKey((RSAPublicKey) oldKeyPair.getPublic()).build();

    return token -> {
        try {
            return current.decode(token);
        } catch (JwtException e) {
            return old.decode(token);   // 降级到旧密钥
        }
    };
}
```

### 发现泄露时的应急处理

1. **立即吊销**泄露的密钥 / token（不等轮换周期）
2. **强制注销**所有使用该密钥签发的 token（JWT 黑名单 / Redis 版本号）
3. **审查审计日志**，确认泄露时间窗口内的所有操作
4. **通知受影响用户**
5. **生成新密钥**，按正常轮换流程部署

---

## 四、审计日志

### 为什么需要审计日志

- **合规要求**：等保 2.0、GDPR、SOC2 要求记录所有敏感操作，留存时间通常 ≥ 6 个月
- **事故追溯**：事件发生后还原完整操作序列，定位"谁在什么时候做了什么"
- **异常检测**：发现账号被盗、内部人员越权操作等行为

### 记录哪些信息

| 字段 | 说明 | 示例 |
|------|------|------|
| `operator_id` | 操作者 ID | `10086` |
| `operator_name` | 操作者名称 | `张三` |
| `action` | 操作类型 | `user:delete`、`order:export` |
| `target_type` | 操作对象类型 | `User`、`Order` |
| `target_id` | 操作对象 ID | `12345` |
| `before` | 操作前的值（JSON）| `{"status":"active"}` |
| `after` | 操作后的值（JSON）| `{"status":"disabled"}` |
| `result` | 操作结果 | `SUCCESS` / `FAILED` |
| `error_msg` | 失败原因 | `权限不足` |
| `client_ip` | 来源 IP | `192.168.1.100` |
| `user_agent` | 客户端标识 | `Mozilla/5.0...` |
| `created_at` | 操作时间（UTC）| `2025-01-01T08:00:00Z` |
| `trace_id` | 链路追踪 ID | 可关联日志与链路 |

### Spring AOP 实现

```java
// 自定义注解
@Target(ElementType.METHOD)
@Retention(RetentionPolicy.RUNTIME)
public @interface AuditLog {
    String action();
    String targetType() default "";
}

// 切面
@Aspect
@Component
public class AuditLogAspect {

    private final AuditLogService auditLogService;

    @Around("@annotation(auditLog)")
    public Object around(ProceedingJoinPoint pjp, AuditLog auditLog) throws Throwable {
        AuditLogEntry entry = new AuditLogEntry();
        entry.setAction(auditLog.action());
        entry.setTargetType(auditLog.targetType());
        entry.setOperatorId(getCurrentUserId());
        entry.setClientIp(getClientIp());
        entry.setTraceId(MDC.get("traceId"));
        entry.setStartTime(Instant.now());

        try {
            Object result = pjp.proceed();
            entry.setResult("SUCCESS");
            return result;
        } catch (Exception e) {
            entry.setResult("FAILED");
            entry.setErrorMsg(e.getMessage());
            throw e;
        } finally {
            entry.setDuration(Duration.between(entry.getStartTime(), Instant.now()).toMillis());
            auditLogService.asyncSave(entry);    // 异步写入，不影响主流程
        }
    }
}

// 使用
@AuditLog(action = "user:delete", targetType = "User")
@DeleteMapping("/users/{id}")
public void deleteUser(@PathVariable Long id) { ... }
```

### 存储选型

| 存储 | 特点 | 适用场景 |
|------|------|---------|
| 数据库（append-only 表）| 简单，支持结构化查询 | 中小规模 |
| Elasticsearch | 全文检索，Kibana 可视化 | 大规模，需要检索分析 |
| Kafka → 消费者落库 | 解耦，异步，高吞吐 | 高并发，不影响主业务 |
| S3 / OSS | 极低成本，防篡改 | 合规归档，长期保留 |

> 审计日志**禁止修改**：数据库表不设 UPDATE/DELETE 权限，或用 append-only 设计；合规场景写入不可变对象存储。
