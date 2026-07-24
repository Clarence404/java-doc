# 环境管理

> 合理的多环境隔离是保障生产稳定性的基础，防止开发测试变更污染生产数据。

---

## 一、标准四环境分层

| 环境 | 用途 | 部署触发 | 数据库 | 访问权限 |
|------|------|---------|--------|---------|
| **dev** | 开发联调，功能快速验证 | push 到 develop 自动部署 | 独立开发库 | 开发团队 |
| **test** | QA 功能测试、回归测试 | PR 合并到 develop 自动部署 | 独立测试库 | 开发 + 测试 |
| **staging（预发）** | 上线前验证，环境与生产一致 | 手动触发 | 与生产结构一致的预发库 | 开发 + 测试 + 产品 |
| **prod（生产）** | 真实用户使用 | 人工审批后部署 | 生产库 | 运维 + 部分开发 |

**核心原则**：
- 越靠近生产的环境，准入越严格
- staging 环境配置应与 prod **完全一致**（副本数、资源规格、中间件版本）
- 任何人不能直接操作生产数据库，需走审批流程

---

## 二、Spring Boot 多环境配置

### 配置文件分层

```
src/main/resources/
├── application.yml           # 通用配置（所有环境共享）
├── application-dev.yml       # 开发环境
├── application-test.yml      # 测试环境
├── application-staging.yml   # 预发环境
└── application-prod.yml      # 生产环境
```

```yaml
# application.yml（通用，不含敏感信息）
spring:
  application:
    name: my-app
  profiles:
    active: ${SPRING_PROFILES_ACTIVE:dev}   # 默认 dev，生产由环境变量覆盖

server:
  port: 8080

# 公共业务配置
app:
  order:
    timeout-minutes: 30
```

```yaml
# application-dev.yml
spring:
  datasource:
    url: jdbc:mysql://dev-mysql:3306/myapp_dev
    username: dev_user
    password: dev_pass
  redis:
    host: dev-redis
    port: 6379

logging:
  level:
    com.example: DEBUG    # 开发环境开启 DEBUG
```

```yaml
# application-prod.yml
spring:
  datasource:
    url: ${DB_URL}          # 从环境变量注入，禁止硬编码
    username: ${DB_USER}
    password: ${DB_PASS}
  redis:
    host: ${REDIS_HOST}
    password: ${REDIS_PASS}
    ssl: true               # 生产环境强制 TLS

logging:
  level:
    root: WARN              # 生产环境减少日志量
    com.example: INFO
```

### Kubernetes 中激活 Profile

```yaml
# deployment.yaml
spec:
  template:
    spec:
      containers:
        - name: my-app
          env:
            - name: SPRING_PROFILES_ACTIVE
              value: prod                  # 或通过 ConfigMap 注入
            - name: DB_URL
              valueFrom:
                secretKeyRef:
                  name: app-secrets
                  key: db-url
            - name: DB_PASS
              valueFrom:
                secretKeyRef:
                  name: app-secrets
                  key: db-pass
```

---

## 三、Nacos 配置中心多环境隔离

使用 Nacos 的**命名空间（Namespace）**对应不同环境，实现配置完全隔离。

```
Nacos 命名空间：
  ├── dev       (命名空间 ID: dev-xxx)
  ├── test      (命名空间 ID: test-xxx)
  ├── staging   (命名空间 ID: staging-xxx)
  └── prod      (命名空间 ID: prod-xxx)
```

```yaml
# application.yml
spring:
  cloud:
    nacos:
      config:
        server-addr: nacos.example.com:8848
        namespace: ${NACOS_NAMESPACE:dev-xxx}   # 由环境变量决定读哪个命名空间
        group: DEFAULT_GROUP
        file-extension: yaml
        shared-configs:
          - data-id: common.yaml               # 公共配置（所有环境共享）
            refresh: true
```

**配置变更流程**：

```
开发修改配置 → dev 命名空间验证 → test 命名空间同步 → 
staging 命名空间验证 → 审批 → prod 命名空间发布
```

---

## 四、Feature Flag（功能开关）

在不重新部署的情况下，动态控制功能的开启/关闭，是金丝雀发布和 A/B 测试的基础。

### 简单实现（Nacos 配置驱动）

```java
@Configuration
@RefreshScope   // 配置变更时自动刷新
public class FeatureFlagConfig {

    @Value("${feature.new-payment-flow.enabled:false}")
    private boolean newPaymentFlowEnabled;

    @Value("${feature.ai-recommend.enabled:false}")
    private boolean aiRecommendEnabled;

    public boolean isNewPaymentFlowEnabled() { return newPaymentFlowEnabled; }
    public boolean isAiRecommendEnabled() { return aiRecommendEnabled; }
}

// 业务使用
@Service
public class PaymentService {
    @Autowired private FeatureFlagConfig featureFlag;

    public PayResult pay(PayRequest req) {
        if (featureFlag.isNewPaymentFlowEnabled()) {
            return newPaymentFlow.execute(req);
        }
        return legacyPaymentFlow.execute(req);
    }
}
```

```yaml
# Nacos 配置（dev 命名空间）
feature:
  new-payment-flow:
    enabled: true   # dev 开启
  ai-recommend:
    enabled: true

# Nacos 配置（prod 命名空间）
feature:
  new-payment-flow:
    enabled: false  # prod 先关闭，灰度验证后再开
  ai-recommend:
    enabled: false
```

### 按用户灰度（白名单）

```java
@Component
public class FeatureGate {

    @Value("${feature.new-checkout.whitelist:}")
    private String whitelistStr;   // 逗号分隔的用户ID，如 "1001,1002,1003"

    @Value("${feature.new-checkout.rollout-percent:0}")
    private int rolloutPercent;    // 0-100，按比例灰度

    public boolean isEnabled(String featureKey, Long userId) {
        // 白名单优先
        if (isInWhitelist(userId)) return true;
        // 按比例灰度（根据 userId 取模，保证同一用户始终进同一组）
        return userId % 100 < rolloutPercent;
    }

    private boolean isInWhitelist(Long userId) {
        return Arrays.stream(whitelistStr.split(","))
            .map(String::trim)
            .anyMatch(id -> id.equals(userId.toString()));
    }
}
```

---

## 五、环境数据管理

### 测试数据库同步策略

```bash
# 定期从生产脱敏同步到测试环境（每周一次）
#!/bin/bash

# 1. 导出生产数据（排除敏感表）
mysqldump -h prod-db -u readonly_user \
  --ignore-table=myapp.user_credential \
  --ignore-table=myapp.payment_record \
  myapp > /tmp/prod_dump.sql

# 2. 脱敏处理（手机号、姓名、邮箱替换为假数据）
python3 desensitize.py /tmp/prod_dump.sql /tmp/test_dump.sql

# 3. 导入测试库
mysql -h test-db -u admin myapp_test < /tmp/test_dump.sql

echo "测试库同步完成"
```

### 环境数据隔离规则

| 数据类型 | 隔离方式 |
|---------|---------|
| 数据库 | 完全独立实例，禁止共享 |
| Redis | 不同 DB 编号或独立实例 |
| MQ Topic | 加环境前缀（`dev.order.created`）|
| OSS Bucket | 独立 Bucket（`bucket-dev`、`bucket-prod`）|
| 第三方回调 | 使用测试账号 + ngrok 内网穿透 |

---

## 六、环境准入规则

| 环境 | 准入条件 |
|------|---------|
| **dev** | 无限制，个人分支随时部署 |
| **test** | CI 全绿（测试通过 + 代码扫描通过）|
| **staging** | test 环境验证通过 + QA 签字 |
| **prod** | staging 验证通过 + 技术负责人审批 + 低峰期发布 |

---

## 七、Kubernetes 多环境命名空间

```bash
# 按环境建立独立命名空间，资源配额隔离
kubectl create namespace dev
kubectl create namespace test
kubectl create namespace staging
kubectl create namespace prod

# 设置资源配额（防止 dev 环境抢占生产资源）
kubectl apply -f - <<EOF
apiVersion: v1
kind: ResourceQuota
metadata:
  name: dev-quota
  namespace: dev
spec:
  hard:
    requests.cpu: "4"
    requests.memory: 8Gi
    limits.cpu: "8"
    limits.memory: 16Gi
    pods: "20"
EOF
```

```yaml
# Kustomize 多环境配置（推荐）
# kustomize/overlays/prod/kustomization.yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
namespace: prod
bases:
  - ../../base
patches:
  - path: replica-patch.yaml    # 生产：replicas=6
  - path: resource-patch.yaml   # 生产：更大的 CPU/内存配额
configMapGenerator:
  - name: app-config
    envs:
      - prod.env
```
