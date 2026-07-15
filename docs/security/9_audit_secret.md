# 审计日志与密钥管理

## 一、审计日志

### 1、为什么需要审计日志

- **合规要求**：等保 2.0、GDPR、SOC2 要求记录所有敏感操作，留存时间通常 ≥ 6 个月
- **事故追溯**：事件发生后还原完整操作序列，定位"谁在什么时候做了什么"
- **异常检测**：发现账号被盗、内部人员越权操作等行为

### 2、记录哪些信息

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

### 3、Spring AOP 实现

```java
// 自定义注解
@Target(ElementType.METHOD)
@Retention(RetentionPolicy.RUNTIME)
public @interface AuditLog {
    String action();            // 操作类型，如 "user:delete"
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

@AuditLog(action = "order:export", targetType = "Order")
@PostMapping("/orders/export")
public void exportOrders(OrderQuery query) { ... }
```

### 4、存储选型

| 存储 | 特点 | 适用场景 |
|------|------|---------|
| 数据库（append-only 表）| 简单，支持结构化查询 | 中小规模 |
| Elasticsearch | 全文检索，Kibana 可视化 | 大规模，需要检索分析 |
| Kafka → 消费者落库 | 解耦，异步，高吞吐 | 高并发，不影响主业务 |
| S3 / OSS | 极低成本，防篡改 | 合规归档，长期保留 |

> 审计日志**禁止修改**：数据库表不设 UPDATE/DELETE 权限，或用 append-only 设计；重要合规场景写入不可变对象存储。

---

## 二、密钥管理

### 1、密钥生命周期

```
生成 → 存储 → 分发 → 使用 → 轮换 → 撤销 → 销毁
```

### 2、存储方案对比

| 方案 | 安全性 | 场景 |
|------|:------:|------|
| 硬编码 | ❌ 极低 | 绝对不用 |
| 代码注释 / README | ❌ 极低 | 绝对不用 |
| 环境变量 | 低 | 开发/测试 |
| K8s Secret | 中（需加密 etcd）| 容器化应用 |
| Spring Cloud Config 加密字段 | 中 | 传统配置中心 |
| HashiCorp Vault | 高 | 推荐生产 |
| 云 KMS（AWS KMS / 阿里云 KMS）| 高 | 云原生，密钥材料不出云 |
| HSM（硬件安全模块）| 极高 | 金融/支付合规 |

### 3、HashiCorp Vault 集成

```xml
<dependency>
  <groupId>org.springframework.cloud</groupId>
  <artifactId>spring-cloud-vault-config</artifactId>
</dependency>
```

```yaml
spring:
  cloud:
    vault:
      uri: https://vault.example.com
      authentication: KUBERNETES    # K8s ServiceAccount 认证，无需硬编码 token
      kv:
        enabled: true
        backend: secret
        default-context: myapp      # 读取 secret/myapp 下的所有 key
      database:
        enabled: true
        role: app-db-role           # Vault 自动轮换数据库凭证
```

```java
// 应用中直接用 @Value 读取，Vault 自动注入（动态凭证每次重启/刷新时获取新的）
@Value("${database.username}")
private String dbUsername;

@Value("${database.password}")
private String dbPassword;
```

### 4、密钥轮换最佳实践

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
// Spring Security JWT 密钥轮换示例（双密钥过渡）
@Bean
public JwtDecoder jwtDecoder(KeyPair currentKeyPair, KeyPair oldKeyPair) {
    // 用当前公钥验证新 token，用旧公钥验证仍在有效期内的旧 token
    NimbusJwtDecoder current = NimbusJwtDecoder
        .withPublicKey((RSAPublicKey) currentKeyPair.getPublic()).build();
    NimbusJwtDecoder old = NimbusJwtDecoder
        .withPublicKey((RSAPublicKey) oldKeyPair.getPublic()).build();

    return token -> {
        try {
            return current.decode(token);
        } catch (JwtException e) {
            return old.decode(token);     // 降级到旧密钥验证
        }
    };
}
```

### 5、发现泄露时的应急处理

1. **立即吊销**泄露的密钥/token（不等轮换周期）
2. **强制注销**所有使用该密钥签发的 token（JWT 黑名单 / Redis 版本号）
3. **审查审计日志**，确认泄露时间窗口内的所有操作
4. **通知受影响用户**
5. **生成新密钥**，按正常轮换流程部署
