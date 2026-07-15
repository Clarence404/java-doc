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

| 方案 | 安全性 | 典型场景 |
|------|:------:|---------|
| 硬编码 | ❌ 极低 | 绝不使用 |
| 环境变量 | 低 | 开发 / 测试 |
| K8s Secret | 中（etcd 需加密）| 容器化应用 |
| Nacos / Apollo 加密字段 | 中 | 配置中心 |
| HashiCorp Vault | 高 | 推荐生产 |
| 云 KMS（AWS/阿里云）| 高 | 云原生，密钥不落地 |

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
      authentication: KUBERNETES    # Pod 使用 K8s ServiceAccount 认证，无需硬编码 token
      database:
        enabled: true
        role: app-db-role           # Vault 定期轮换数据库凭证，应用无感知
```

**密钥轮换最佳实践：**
- 定期轮换（生产至少每 90 天）
- 新旧密钥有重叠期，平滑迁移（双密钥同时有效）
- 发现泄露立即吊销，不等周期
- 审计所有密钥的使用记录

---

## 四、审计日志

→ 详见 [审计日志与密钥管理](/security/9_audit_secret)
