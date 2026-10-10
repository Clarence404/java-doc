---
description: 数据分级与合规、密码哈希、AES-GCM、信封加密与 KMS、Vault、审计日志、字段加密与盲索引、脱敏
---

# 数据安全

> 前置阅读：[API 安全](./6_api_security)、[HTTPS 与 TLS](/protocols/3_https_tls)

数据安全覆盖数据从采集到删除的整个生命周期。本篇讲数据分级与合规、密码哈希、AES-GCM 与信封加密、审计日志、字段级加密与脱敏，基线为 JDK 21。

---

## 一、数据分级与合规

生命周期要求：采集时分级、传输时加密、存储时加密、使用时脱敏、操作时审计、删除时可证明；本篇聚焦存储与使用环节，代码基线为 JDK 21、Spring Boot 4 / Spring Security 7、Jackson 3。

### 先分级，再定措施

不同数据的保护强度应该不同，否则要么处处过度加密拖垮性能，要么关键数据裸奔。一个常见的四级划分：

| 级别 | 示例 | 存储 | 展示 | 日志 |
|------|------|------|------|------|
| 公开 | 商品信息、公告 | 明文 | 原样 | 可记录 |
| 内部 | 订单号、内部配置 | 明文，限制访问 | 原样 | 可记录 |
| 敏感（个人信息） | 姓名、手机号、地址、邮箱 | 字段加密或库级加密 | 脱敏 | 脱敏后记录 |
| 高度敏感 | 证件号、银行卡、生物特征、健康信息、密码、密钥 | 字段加密 + 独立密钥；密码只存哈希 | 默认不展示，查看需授权并审计 | 禁止记录 |

分级结果要落到数据字典里（哪张表哪个字段是什么级别），作为加密、脱敏、权限和审计规则的依据。

### 合规要求落到技术上

| 法规 | 生效时间 | 对技术侧的主要要求 |
|------|----------|--------------------|
| 《数据安全法》 | 2021-09-01 | 数据分类分级保护，重要数据的风险评估与报送 |
| 《个人信息保护法》（PIPL） | 2021-11-01 | 告知同意、最小必要；敏感个人信息需单独同意并采取严格保护措施；支持查询、更正、删除；个人信息出境需走安全评估、标准合同或认证 |
| 《网络数据安全管理条例》 | 2025-01-01 | 细化个人信息处理、重要数据保护和数据出境的义务 |
| GDPR（欧盟） | 2018-05-25 | 设计即隐私（Privacy by Design）、被遗忘权、数据可携带、72 小时内通报数据泄露；罚款最高可达全球年营业额 4% 或 2000 万欧元 |

PIPL 所说的敏感个人信息包括生物识别、宗教信仰、特定身份、医疗健康、金融账户、行踪轨迹，以及不满 14 周岁未成年人的个人信息。技术上通常落实为：最小化采集、加密存储、访问审计、留存期满自动删除或匿名化、支持用户导出和注销。具体合规判断以法务意见为准。

---

## 二、加密算法与密码哈希

传输加密见 [HTTPS 与 TLS](/protocols/3_https_tls)。

### 对称加密：首选 AES-GCM

| 模式 | 说明 | 结论 |
|------|------|------|
| AES-GCM | 认证加密（AEAD），同时保证机密性和完整性，篡改后解密直接失败 | 首选 |
| AES-CBC | 需要随机 IV 和填充，本身不防篡改，必须再加 HMAC（先加密后 MAC），实现不当会有填充预言攻击 | 仅为兼容旧系统 |
| AES-ECB | 相同明文块产生相同密文块，会泄露数据模式；问题出在模式，与密钥长度无关 | 禁止使用 |

GCM 有两条硬性规则：

- **同一个密钥下 IV 绝不能重复**。IV 重复会同时破坏机密性和完整性：攻击者可以算出两段明文的异或，还能伪造认证标签
- **随机生成 96 位 IV 时，同一个密钥最多加密约 2^32 条消息**（NIST SP 800-38D 的限制），超过之前必须轮换密钥。字段加密的数据量大时，用信封加密给每条记录或每批记录分配独立的数据密钥，就不会碰到这个上限

```java
import java.nio.ByteBuffer;
import java.security.GeneralSecurityException;
import java.security.SecureRandom;
import javax.crypto.AEADBadTagException;
import javax.crypto.Cipher;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

public final class AesGcm {

    private static final int IV_BYTES = 12;     // 96 位 IV，GCM 推荐长度
    private static final int TAG_BITS = 128;    // 认证标签 128 位
    private static final SecureRandom RANDOM = new SecureRandom();

    private AesGcm() {
    }

    /** 输出格式：IV(12 字节) + 密文 + 认证标签(16 字节) */
    public static byte[] encrypt(SecretKey key, byte[] plaintext, byte[] aad) throws GeneralSecurityException {
        byte[] iv = new byte[IV_BYTES];
        RANDOM.nextBytes(iv);
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, key, new GCMParameterSpec(TAG_BITS, iv));
        cipher.updateAAD(aad);
        byte[] ciphertext = cipher.doFinal(plaintext);
        return ByteBuffer.allocate(IV_BYTES + ciphertext.length).put(iv).put(ciphertext).array();
    }

    public static byte[] decrypt(SecretKey key, byte[] message, byte[] aad) throws GeneralSecurityException {
        if (message.length < IV_BYTES + TAG_BITS / 8) {
            throw new AEADBadTagException("ciphertext too short");
        }
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, key, new GCMParameterSpec(TAG_BITS, message, 0, IV_BYTES));
        cipher.updateAAD(aad);
        return cipher.doFinal(message, IV_BYTES, message.length - IV_BYTES);
    }
}
```

- 每次加密都新建 IV，用 `SecureRandom` 生成；`Cipher` 实例不是线程安全的，每次调用新建
- AAD（附加认证数据）不加密但参与认证，适合放"这段密文属于哪张表、哪条记录、哪个字段"，例如 `"user:10086:phone"`。这样攻击者把 A 用户的密文拷到 B 用户名下，解密会直接失败
- 密钥用 `KeyGenerator.getInstance("AES")` 配合 `init(256)` 生成，或由 KMS 下发，不要用字符串直接当密钥

### 非对称加密与签名

公钥可以公开分发，私钥自己保管。非对称算法比对称算法慢几个数量级，**不用于加密大量数据**，主要用在：

| 场景 | 常用算法 |
|------|----------|
| JWT / 接口签名 | RS256（RSA）、ES256（ECDSA P-256）、EdDSA（Ed25519） |
| 加密对称密钥 | RSA-OAEP，或 ECDH 协商出共享密钥 |
| TLS 密钥交换 | ECDHE（X25519）；主流浏览器和 CDN 已部署后量子混合方案 X25519MLKEM768 |

### 密码哈希

密码不能可逆加密，只能用**专门的慢哈希**单向处理。MD5、SHA-1、SHA-256 直接哈希密码的问题不在彩虹表（加了盐彩虹表就失效了），而在于**太快**：GPU 每秒能算数十亿次，泄露后可以大规模暴力猜解。慢哈希通过可调的计算量和内存消耗，把单次猜测的成本抬高几个数量级。

| 算法 | 推荐参数（OWASP Password Storage Cheat Sheet） | 说明 |
|------|-----------------------------------------------|------|
| Argon2id | m=19 MiB、t=2、p=1（最低配置） | 首选，内存困难，抗 GPU / ASIC |
| scrypt | N=2^17、r=8、p=1 | Argon2 不可用时的选择 |
| bcrypt | cost ≥ 10 | 老系统常用；只处理前 72 字节 |
| PBKDF2-HMAC-SHA256 | 60 万次迭代 | 需要 FIPS 合规时使用 |

在 Spring Security 中用 `DelegatingPasswordEncoder`，存储格式为 `{id}哈希值`，前缀记录算法，换算法时老数据仍能校验：

```java
import java.util.Map;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.security.crypto.argon2.Argon2PasswordEncoder;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.security.crypto.password.DelegatingPasswordEncoder;
import org.springframework.security.crypto.password.PasswordEncoder;

@Configuration
public class PasswordConfig {

    @Bean
    PasswordEncoder passwordEncoder() {
        Map<String, PasswordEncoder> encoders = Map.of(
                // saltLength, hashLength, parallelism, memory(KiB), iterations：OWASP 推荐的 m=19 MiB, t=2, p=1
                "argon2", new Argon2PasswordEncoder(16, 32, 1, 19 * 1024, 2),
                "bcrypt", new BCryptPasswordEncoder());   // 兼容存量 {bcrypt} 哈希，默认 strength 为 10
        return new DelegatingPasswordEncoder("argon2", encoders);   // 新密码用 argon2
    }
}
```

- `PasswordEncoderFactories.createDelegatingPasswordEncoder()` 在 Spring Security 7 中默认仍用 bcrypt 编码新密码；想默认用 Argon2id 就像上面这样自己构造
- `Argon2PasswordEncoder` 依赖 BouncyCastle，需要引入 `org.bouncycastle:bcprov-jdk18on`；Spring Security 7 另外提供基于 Password4j 的 `Argon2Password4jPasswordEncoder` 等实现，引入 `com.password4j:password4j` 即可使用
- **平滑升级**：提供一个 `UserDetailsPasswordService` Bean，用户下次登录成功时，如果 `upgradeEncoding` 判断哈希需要升级（算法或参数变了），Spring Security 会用新算法重新哈希并调用它保存，无需强制所有人改密码
- 参数以单次校验 200～500ms 为目标在生产机型上压测确定；登录接口要配合限流和失败锁定，否则慢哈希会被用来打满 CPU

---

## 三、密钥管理

加密做得再好，密钥和密文放在一起就等于没加密。密钥管理要回答：密钥放在哪、谁能用、多久换一次、泄露了怎么办。

JWT 签名密钥的轮换见 [JWT 令牌机制](./1_jwt)。

### 密钥生命周期

![密钥生命周期与轮换重叠期](../assets/security/security-key-lifecycle.svg)

- **生成**：用 CSPRNG（`SecureRandom`）或在 KMS / HSM 内生成，主密钥最好从生成起就不离开 HSM
- **存储与分发**：放在 KMS 或 Vault，应用按自身身份（K8s ServiceAccount、云上实例角色）获取使用权限，而不是拿到一份可以拷走的密钥文件
- **轮换**：定期（常见做法为每年一次，高敏感数据更短）或怀疑泄露时立即轮换。轮换后新数据用新版本加密，旧版本进入"只解密"状态，直到存量数据重新加密完成才撤销、销毁
- **记录版本**：密文旁边存密钥版本号（或 KMS 返回的密文本身已带版本），解密时按版本选密钥

### 信封加密

直接拿 KMS 主密钥加密业务数据行不通：每次加解密都要远程调用，单次请求还有大小限制。**信封加密**用两层密钥解决：

![信封加密流程](../assets/security/security-envelope-encryption.svg)

- **主密钥（CMK / KEK）**：存放在 KMS / HSM 内部，永不导出，只用来加解密数据密钥
- **数据密钥（DEK）**：由 KMS 生成，同时返回明文和用主密钥加密后的密文。应用用明文 DEK 在本地加密数据后立即丢弃，只把加密后的 DEK 和数据密文存在一起
- **解密**：把加密后的 DEK 交给 KMS 解开，再在本地解密数据。KMS 的每次调用都受访问策略控制并留下审计记录
- **轮换主密钥**只需重新加密 DEK，不用重新加密全部数据

以 AWS SDK for Java 2.x 为例（阿里云、腾讯云 KMS 的接口名称相同或类似）：

```java
import javax.crypto.SecretKey;
import javax.crypto.spec.SecretKeySpec;
import software.amazon.awssdk.core.SdkBytes;
import software.amazon.awssdk.services.kms.KmsClient;
import software.amazon.awssdk.services.kms.model.DataKeySpec;
import software.amazon.awssdk.services.kms.model.GenerateDataKeyResponse;

public class EnvelopeCipher {

    /** 加密后的 DEK 与数据密文一起落库 */
    public record EncryptedRecord(byte[] encryptedDataKey, byte[] ciphertext) {
    }

    private final KmsClient kms;
    private final String keyArn;

    public EnvelopeCipher(KmsClient kms, String keyArn) {
        this.kms = kms;
        this.keyArn = keyArn;
    }

    public EncryptedRecord encrypt(byte[] plaintext, byte[] aad) throws Exception {
        GenerateDataKeyResponse dataKey = kms.generateDataKey(r -> r.keyId(keyArn).keySpec(DataKeySpec.AES_256));
        byte[] rawKey = dataKey.plaintext().asByteArray();
        try {
            SecretKey dek = new SecretKeySpec(rawKey, "AES");
            return new EncryptedRecord(dataKey.ciphertextBlob().asByteArray(), AesGcm.encrypt(dek, plaintext, aad));
        } finally {
            java.util.Arrays.fill(rawKey, (byte) 0);   // 尽快清除明文 DEK
        }
    }

    public byte[] decrypt(EncryptedRecord record, byte[] aad) throws Exception {
        byte[] rawKey = kms.decrypt(r -> r.keyId(keyArn)
                        .ciphertextBlob(SdkBytes.fromByteArray(record.encryptedDataKey())))
                .plaintext().asByteArray();
        try {
            return AesGcm.decrypt(new SecretKeySpec(rawKey, "AES"), record.ciphertext(), aad);
        } finally {
            java.util.Arrays.fill(rawKey, (byte) 0);
        }
    }
}
```

每条记录都调用一次 KMS 成本高、延迟大，常见优化是把解密后的 DEK 在内存里缓存几分钟，或者一个 DEK 加密一批记录（注意 GCM 的消息数上限）。不想自己写的话，可以用 AWS Encryption SDK、Google Tink 这类封装好信封加密和密钥缓存的库。

### 密钥存放方案对比

| 方案 | 安全性 | 适用场景 |
|------|--------|----------|
| 写在代码或配置文件里 | 极低 | 任何情况都不要用 |
| 环境变量 | 低（进程信息、崩溃转储里可见） | 开发、测试 |
| K8s Secret | 中（etcd 默认明文，需开启静态加密并收紧 RBAC） | 容器化应用，配合 External Secrets 从 Vault / KMS 同步 |
| 配置中心加密字段（Nacos、Apollo、Jasypt） | 中（主密钥仍要找地方放） | 过渡方案 |
| Vault / OpenBao | 高 | 自建，需要动态凭证、多云或混合云 |
| 云 KMS / Secrets Manager | 高 | 云上应用，主密钥不出 HSM |
| 专用 HSM | 极高 | 金融、支付等有合规要求的场景 |

### Vault 与 OpenBao

HashiCorp 在 2023 年 8 月把 Vault 的许可证从 MPL 2.0 改为 BSL 1.1（商业源码许可证）：自用不受影响，但不能拿它做与 HashiCorp 竞争的托管服务。社区随后从最后一个 MPL 版本（1.14）分叉出 **OpenBao**，现为 OpenSSF 下的项目，API 与 Vault 基本兼容。新项目选型时两者都可以，看重商业支持和企业功能选 Vault，看重开源许可证选 OpenBao。

Spring Cloud Vault 通过 Spring Boot 的 ConfigData 机制加载密钥，**必须写 `spring.config.import`**（旧的 bootstrap 上下文方式已经不再默认启用）：

```yaml
spring:
  config:
    import: vault://
  cloud:
    vault:
      uri: https://vault.example.com:8200
      authentication: KUBERNETES      # 用 Pod 的 ServiceAccount 认证，不需要在配置里放 token
      kubernetes:
        role: order-service           # Vault 中绑定了 ServiceAccount 与命名空间的角色
        kubernetes-path: kubernetes
      kv:
        enabled: true
        backend: secret
        default-context: order-service
      database:
        enabled: true
        role: order-db-role           # Vault 按角色动态签发有时效的数据库账号
        backend: database
```

数据库动态凭证默认注入到 `spring.datasource.username` 和 `spring.datasource.password`，Spring Boot 自动配置的数据源直接就能用，不需要再写 `@Value`。如果要注入到别的属性，用 `spring.cloud.vault.database.username-property` / `password-property` 指定。动态凭证有租约期限，Spring Cloud Vault 会自动续租；租约到期换新账号时，连接池里的旧连接要能平滑淘汰（设置合理的 `max-lifetime`）。

### Jasypt：配置加密的过渡方案

Jasypt 把配置值加密成 `ENC(...)`，启动时用主密钥解密，适合暂时上不了 Vault / KMS 的项目：

```yaml
jasypt:
  encryptor:
    password: ${JASYPT_MASTER_KEY}             # 主密钥从环境变量注入，不进仓库
    algorithm: PBEWITHHMACSHA512ANDAES_256

spring:
  datasource:
    password: ENC(密文)
```

它的问题是主密钥本身仍然要找地方放，也没有轮换和审计能力。`jasypt-spring-boot-starter` 当前版本为 4.0.x，README 标注支持 Spring Boot 3.5+，在 Spring Boot 4 上使用前先验证兼容性。

### 轮换与泄露应急

计划内轮换的步骤：

1. 在 KMS / Vault 中生成新版本密钥，新旧版本同时可用于解密
2. 应用切换为用新版本加密（配置刷新或滚动重启）
3. 后台任务把存量数据用新版本重新加密（信封加密下只需重新加密 DEK）
4. 确认没有数据再引用旧版本后，禁用并最终销毁旧版本
5. 每一步都写入审计日志

JWT 签名密钥的轮换（`kid` + JWKS 新旧公钥并存）见 [JWT 令牌机制](./1_jwt)，这里不重复。

发现密钥泄露时：

1. **立即吊销**泄露的密钥或凭证，不等轮换周期
2. **使派生凭证失效**：用该密钥签发的令牌、会话一并作废
3. **查审计日志**，确定泄露时间窗口内的所有访问
4. **生成新密钥**并重新加密受影响的数据
5. 涉及个人信息的，按 PIPL / GDPR 要求评估是否需要通知用户和监管部门

---

## 四、审计日志

### 为什么要审计日志

- **合规**：等保 2.0、PIPL、GDPR、SOC 2 都要求记录对敏感数据的访问和变更，《网络安全法》要求网络日志留存不少于 6 个月
- **追溯**：事故发生后还原"谁、在什么时候、对什么数据、做了什么"
- **检测**：发现账号被盗用、内部人员批量导出等异常行为

### 记录哪些字段

| 字段 | 说明 | 示例 |
|------|------|------|
| `operator_id` | 操作者 ID | `10086` |
| `action` | 操作类型 | `user:delete`、`order:export` |
| `target_type` / `target_id` | 操作对象 | `User` / `12345` |
| `before` / `after` | 变更前后的值（JSON，敏感字段先脱敏） | `{"status":"active"}` |
| `result` / `error_msg` | 结果与失败原因 | `FAILED` / `权限不足` |
| `client_ip` / `user_agent` | 来源 | `203.0.113.10` |
| `trace_id` | 链路 ID，关联应用日志与链路追踪 | `4bf92f3577b34da6` |
| `created_at` | 操作时间（UTC） | `2026-10-10T08:00:00Z` |

### 用 AOP 记录

```java
import java.lang.annotation.ElementType;
import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import java.lang.annotation.Target;

@Target(ElementType.METHOD)
@Retention(RetentionPolicy.RUNTIME)
public @interface AuditLog {
    String action();
    String targetType() default "";
}
```

```java
import java.time.Duration;
import java.time.Instant;
import org.aspectj.lang.ProceedingJoinPoint;
import org.aspectj.lang.annotation.Around;
import org.aspectj.lang.annotation.Aspect;
import org.slf4j.MDC;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.stereotype.Component;
import org.springframework.web.context.request.RequestContextHolder;
import org.springframework.web.context.request.ServletRequestAttributes;

@Aspect
@Component
public class AuditLogAspect {

    private final AuditLogService auditLogService;

    public AuditLogAspect(AuditLogService auditLogService) {
        this.auditLogService = auditLogService;
    }

    @Around("@annotation(auditLog)")
    public Object around(ProceedingJoinPoint pjp, AuditLog auditLog) throws Throwable {
        AuditLogEntry entry = new AuditLogEntry();
        entry.setAction(auditLog.action());
        entry.setTargetType(auditLog.targetType());
        entry.setOperatorId(currentUser());
        entry.setClientIp(clientIp());
        entry.setTraceId(MDC.get("traceId"));
        Instant start = Instant.now();
        try {
            Object result = pjp.proceed();
            entry.setResult("SUCCESS");
            return result;
        } catch (Throwable e) {
            entry.setResult("FAILED");
            entry.setErrorMsg(e.getMessage());
            throw e;
        } finally {
            entry.setDurationMillis(Duration.between(start, Instant.now()).toMillis());
            auditLogService.save(entry);
        }
    }

    private static String currentUser() {
        Authentication auth = SecurityContextHolder.getContext().getAuthentication();
        return auth == null ? "anonymous" : auth.getName();
    }

    private static String clientIp() {
        // 前提：已配置 server.forward-headers-strategy，且只信任来自可信代理的 X-Forwarded-For
        return RequestContextHolder.getRequestAttributes() instanceof ServletRequestAttributes attrs
                ? attrs.getRequest().getRemoteAddr()
                : null;
    }
}
```

```java
@AuditLog(action = "user:delete", targetType = "User")
@DeleteMapping("/users/{id}")
public void deleteUser(@PathVariable long id) {
    userService.delete(id);
}
```

- **来源 IP 不要直接读 `X-Forwarded-For` 头**：客户端可以随便伪造。设置 `server.forward-headers-strategy=native`（由 Tomcat 的 RemoteIpValve 处理）并配置可信代理网段，之后 `getRemoteAddr()` 拿到的才是可信的客户端地址
- **写入方式**：合规要求"必须记下来"的操作要同步写入或先写本地可靠队列，异步写丢了就等于没记；普通操作可以异步
- 审计日志单独一条管道，与应用日志分开存储和授权，日志管道设计见 [日志](/observability/1_logging)，Logback 配置见 [日志](/spring-boot/12_logging)

### 存储与防篡改

| 存储 | 特点 | 适用场景 |
|------|------|----------|
| 数据库只追加表 | 简单，便于结构化查询 | 中小规模 |
| Kafka → 消费落库 | 解耦，高吞吐 | 高并发写入 |
| Elasticsearch / OpenSearch | 检索与可视化分析 | 大规模，需要检索 |
| 对象存储（开启对象锁 / WORM） | 成本低，写入后不可修改 | 合规归档、长期保留 |

审计日志**不允许修改和删除**：应用账号对审计表只授予 `INSERT` 和 `SELECT`，归档写入开启对象锁的存储；要求更高时可以给每条记录加上前一条记录的哈希形成哈希链，任何篡改都能被发现。

---

## 五、字段级加密与盲索引

### 加密放在哪一层

| 层级 | 做法 | 能防住 | 防不住 |
|------|------|--------|--------|
| 磁盘 / 云盘加密 | 云厂商默认开启、LUKS | 硬盘被拿走 | 能登录数据库的人 |
| 数据库透明加密（TDE） | MySQL InnoDB 表空间加密、云数据库 TDE | 数据文件和备份文件泄露 | DBA、SQL 注入、应用账号泄露 |
| 应用层字段加密 | 应用写库前加密，读出后解密 | 以上全部，加上 DBA 和数据库层面的泄露 | 应用自身被攻破 |

高度敏感字段（证件号、银行卡、手机号）适合应用层字段加密。代价是数据库里只有密文，无法直接按这些字段查询、排序、模糊匹配。

### 盲索引：加密后仍能精确查询

做法是额外存一列 **盲索引**：用一个独立的密钥对规范化后的明文做 HMAC。查询时对输入做同样的计算，按盲索引列精确匹配：

```sql
CREATE TABLE customer (
  id           BIGINT PRIMARY KEY,
  phone_cipher VARBINARY(256) NOT NULL,   -- AES-GCM 密文，AAD 绑定 id 与字段名
  phone_bidx   CHAR(64)       NOT NULL,   -- HMAC-SHA256(索引密钥, 规范化手机号)
  key_version  INT            NOT NULL,
  KEY idx_phone_bidx (phone_bidx)
);
```

```java
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.util.HexFormat;
import java.util.Locale;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

public final class BlindIndex {

    private final SecretKeySpec indexKey;   // 与加密密钥分开管理

    public BlindIndex(byte[] indexKey) {
        this.indexKey = new SecretKeySpec(indexKey, "HmacSHA256");
    }

    public String of(String value) {
        String normalized = value.strip().toLowerCase(Locale.ROOT);   // 规范化：去空格、统一大小写
        try {
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(indexKey);
            return HexFormat.of().formatHex(mac.doFinal(normalized.getBytes(StandardCharsets.UTF_8)));
        } catch (GeneralSecurityException e) {
            throw new IllegalStateException("HmacSHA256 不可用", e);
        }
    }
}
```

```java
// 查询：对输入算盲索引，再按索引列查
List<Customer> found = customerRepository.findByPhoneBidx(blindIndex.of(inputPhone));
```

使用盲索引要注意：

- **只支持精确匹配**。需要按后四位查时，单独为后四位再建一个盲索引；模糊搜索需要分词后为每个词建索引，会泄露更多信息，要权衡
- **索引密钥必须和加密密钥分开**，并同样放在 KMS / Vault。手机号、证件号这类取值空间小的字段，索引密钥一旦泄露就能被穷举还原
- **不要用不带密钥的 SHA-256 做索引**：11 位手机号的全部取值几秒钟就能算完
- 盲索引会暴露"哪些记录的值相同"，这是为了能查询而接受的信息泄露
- 读写时机可以用 JPA 的 `AttributeConverter` 或 MyBatis 的 `TypeHandler` 统一处理加解密，业务代码只看到明文

---

## 六、数据脱敏

### 脱敏规则

| 数据类型 | 规则 | 示例 |
|----------|------|------|
| 手机号 | 保留前 3 位和后 4 位 | `138****5678` |
| 身份证号 | 保留前 6 位和后 4 位 | `110101********1234` |
| 银行卡号 | 只保留后 4 位 | `**** **** **** 6789` |
| 邮箱 | 用户名只保留首字符 | `a***@example.com` |
| 姓名 | 只保留姓 | `张*` |

```java
public enum SensitiveType { PHONE, ID_CARD, BANK_CARD, EMAIL, NAME }
```

```java
public final class Desensitize {

    private Desensitize() {
    }

    public static String apply(SensitiveType type, String value) {
        if (value == null || value.isEmpty()) {
            return value;
        }
        return switch (type) {
            case PHONE -> keep(value, 3, 4);
            case ID_CARD -> keep(value, 6, 4);
            case BANK_CARD -> value.length() <= 4 ? "****" : "**** **** **** " + value.substring(value.length() - 4);
            case EMAIL -> email(value);
            case NAME -> value.substring(0, 1) + "*".repeat(Math.max(1, value.length() - 1));
        };
    }

    /** 保留前 head 位和后 tail 位，长度不足时整体遮盖 */
    private static String keep(String value, int head, int tail) {
        if (value.length() <= head + tail) {
            return "*".repeat(value.length());
        }
        return value.substring(0, head) + "*".repeat(value.length() - head - tail)
                + value.substring(value.length() - tail);
    }

    private static String email(String value) {
        int at = value.indexOf('@');
        if (at <= 0) {               // 没有 @ 或用户名为空（如 "@x.com"）
            return "***";
        }
        return value.charAt(0) + "***" + value.substring(at);
    }
}
```

### 接口输出自动脱敏（Jackson 3）

Spring Boot 4 默认使用 Jackson 3，包名从 `com.fasterxml.jackson` 改为 `tools.jackson`（注解包 `com.fasterxml.jackson.annotation` 保持不变）。序列化器的基类从 `JsonSerializer` 变为 `ValueSerializer`，`ContextualSerializer` 接口被移除，`createContextual` 直接定义在 `ValueSerializer` 上：

```java
import com.fasterxml.jackson.annotation.JacksonAnnotationsInside;
import java.lang.annotation.ElementType;
import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import java.lang.annotation.Target;
import tools.jackson.databind.annotation.JsonSerialize;

@Target({ElementType.FIELD, ElementType.METHOD})
@Retention(RetentionPolicy.RUNTIME)
@JacksonAnnotationsInside
@JsonSerialize(using = SensitiveSerializer.class)
public @interface Sensitive {
    SensitiveType value();
}
```

```java
import tools.jackson.core.JsonGenerator;
import tools.jackson.databind.BeanProperty;
import tools.jackson.databind.SerializationContext;
import tools.jackson.databind.ValueSerializer;
import tools.jackson.databind.ser.std.StdSerializer;

public class SensitiveSerializer extends StdSerializer<String> {

    private final SensitiveType type;

    public SensitiveSerializer() {          // Jackson 通过无参构造创建，再调用 createContextual
        this(null);
    }

    private SensitiveSerializer(SensitiveType type) {
        super(String.class);
        this.type = type;
    }

    @Override
    public ValueSerializer<?> createContextual(SerializationContext ctxt, BeanProperty property) {
        Sensitive sensitive = property == null ? null : property.getAnnotation(Sensitive.class);
        return sensitive == null ? this : new SensitiveSerializer(sensitive.value());
    }

    @Override
    public void serialize(String value, JsonGenerator gen, SerializationContext ctxt) {
        gen.writeString(type == null ? value : Desensitize.apply(type, value));
    }
}
```

```java
public record UserView(
        long id,
        @Sensitive(SensitiveType.NAME) String name,
        @Sensitive(SensitiveType.PHONE) String phone,
        @Sensitive(SensitiveType.ID_CARD) String idCard) {
}
```

仍在用 Jackson 2 的项目（Spring Boot 3.x，或 Boot 4 下显式切回 Jackson 2）对应写法是继承 `com.fasterxml.jackson.databind.JsonSerializer` 并实现 `ContextualSerializer`，逻辑相同。

接口层脱敏只是"展示时遮住"，数据库里存的仍是原值（或密文）。需要查看完整信息的场景（客服核实身份）应走单独的接口，校验权限并写审计日志。

### 日志脱敏

日志是敏感数据泄露最常见的渠道，按"源头不打、兜底再遮"两层处理：

- **源头不打**：不要直接 `log.info("{}", request)` 打印整个请求对象；含敏感字段的 record / DTO 重写 `toString()` 把字段替换为 `******`；请求日志过滤器排除 `Authorization`、`Cookie`、`X-Signature` 等头和密码、Token 字段
- **兜底遮盖**：在 Logback 中用 `%replace` 或自定义转换器，按正则把手机号、证件号遮住，防止漏网
- **禁止记录**：密码（含错误密码）、完整 Token、密钥、银行卡完整卡号、CVV

```java
public record LoginRequest(String username, String password) {
    @Override
    public String toString() {
        return "LoginRequest[username=" + username + ", password=******]";
    }
}
```

Logback 的配置方式和结构化日志见 [日志](/spring-boot/12_logging)，日志采集管道上的脱敏处理见 [日志](/observability/1_logging)。

---

## 小结

- 先给数据分级，再按级别决定加密、脱敏、日志和访问控制规则；PIPL 和 GDPR 落到技术上就是最小化采集、加密存储、访问审计、到期删除、支持用户行使权利
- 密码用 Argon2id（m=19 MiB、t=2、p=1）或 bcrypt，通过 `DelegatingPasswordEncoder` 的 `{id}` 前缀和 `UserDetailsPasswordService` 在登录时平滑升级；快速哈希的问题是太快，不是彩虹表
- 对称加密用 AES-GCM：每次随机 12 字节 IV、128 位标签，同一密钥下 IV 绝不重复，随机 IV 时每个密钥最多加密约 2^32 条消息；用 AAD 把密文绑定到具体记录
- 信封加密：主密钥不出 KMS，数据密钥加密后与密文一起存放，轮换主密钥只需重新加密数据密钥；Vault 自 2023 年起为 BSL 许可，OpenBao 是开源分叉；Spring Cloud Vault 要用 `spring.config.import: vault://`
- 审计日志单独存储、只追加、可防篡改，来源 IP 只信任可信代理传来的值
- 字段级加密后用盲索引（独立密钥的 HMAC）做精确查询；接口输出用 Jackson 3 的 `ValueSerializer` 自动脱敏，日志按"源头不打、兜底再遮"处理

## 参考资料

- OWASP 密码存储：[Password Storage Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)
- OWASP 密码学存储：[Cryptographic Storage Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Cryptographic_Storage_Cheat_Sheet.html)
- GCM 规范：[NIST SP 800-38D - Galois/Counter Mode](https://csrc.nist.gov/pubs/sp/800/38/d/final)
- 密钥管理：[NIST SP 800-57 Part 1 Rev. 5 - Recommendation for Key Management](https://csrc.nist.gov/pubs/sp/800/57/pt1/r5/final)
- Argon2 规范：[RFC 9106 - Argon2 Memory-Hard Function](https://www.rfc-editor.org/rfc/rfc9106)
- Spring Security 密码存储：[Password Storage](https://docs.spring.io/spring-security/reference/features/authentication/password-storage.html)
- Spring Cloud Vault：[Spring Cloud Vault Reference](https://docs.spring.io/spring-cloud-vault/reference/)
- 信封加密概念：[AWS KMS Concepts - Envelope Encryption](https://docs.aws.amazon.com/kms/latest/developerguide/kms-cryptography.html#enveloping)
- OpenBao：[OpenBao Documentation](https://openbao.org/docs/)
- Jackson 3 迁移：[Jackson 3.0 Migration Guide](https://github.com/FasterXML/jackson/blob/main/jackson3/MIGRATING_TO_JACKSON_3.md)
- 《中华人民共和国个人信息保护法》：[中国人大网](http://www.npc.gov.cn/npc/c2/c30834/202108/t20210820_313088.html)
- GDPR 全文：[Regulation (EU) 2016/679](https://eur-lex.europa.eu/eli/reg/2016/679/oj)

> 下一篇：[常见漏洞与防护](./8_vulnerabilities)
