---
description: 多环境分层、trunk-based 晋级、Boot 4 配置、Nacos、密钥、功能开关、Kustomize
---

# 环境管理

> **本篇目标**：定下 dev / test / staging / prod 四个环境各自的用途、触发方式与准入门槛；在 trunk-based 流程下让同一个镜像 digest 逐级晋级；用 Profile、Nacos 命名空间和 Kustomize overlay 承载环境差异，密钥交给专门的密钥系统；写出能随配置中心实时生效的功能开关；守住测试数据与集群层面的隔离边界。
>
> **前置阅读**：[配置管理](/spring-boot/6_config)、[Kubernetes](/cloud-native/6_kubernetes)、[制品与版本管理](./6_artifact_version)

多环境要解决的核心矛盾是：**环境之间要尽量一致，才能让测试结论可信；又必须严格隔离，才能让测试不伤及生产**。本篇是全站多环境划分的主文档，其他模块只引用这里的结论。Spring Boot 的配置加载顺序与 Profile 语法见 [配置管理](/spring-boot/6_config)，Nacos 接入与刷新原理见 [配置中心](/spring-cloud/4_config_center)，加密与密钥体系见 [数据安全](/security/7_data_security)。

---

## 一、标准四环境分层

| 环境 | 用途 | 部署触发 | 数据 | 基础设施 | 访问权限 |
|------|------|---------|------|---------|---------|
| **dev** | 开发联调、PR 预览 | PR 打开或更新时部署独立的预览环境（`pr-<编号>` 命名空间），合并或关闭后自动销毁 | 合成数据 | 非生产集群 | 开发团队 |
| **test** | QA 功能测试、回归、自动化 E2E | 合并到 `main` 且 CI 全绿后自动部署 | 合成数据 + 少量脱敏样本 | 非生产集群 | 开发 + 测试 |
| **staging（预发）** | 上线前验收、性能验证、发布演练 | 推送 `v*` tag 后自动部署，或手动晋级 test 已验证的 digest | 结构与生产一致的脱敏数据 | 与生产同规格：独立集群或独立节点池 | 开发 + 测试 + 产品（只读） |
| **prod（生产）** | 真实用户流量 | staging 验证通过 + 人工审批，部署与 staging **相同的 digest** | 生产数据 | 独立生产集群 | 运维 + 值班开发，最小权限 |

核心原则：

- **一次构建，多处部署**：四个环境跑的是同一个镜像 digest，差异只来自注入的配置与密钥；为某个环境单独打包，等于让测试结论作废
- **越靠近生产，准入越严**：dev 随时可部署，prod 必须审批，且只能部署在 staging 验证过的 digest
- **staging 与 prod 对齐**：副本数、资源规格、中间件版本、JVM 参数、网络拓扑保持一致，差异项要登记在案
- **生产数据不出生产**：任何人不直接操作生产库，测试环境不使用未脱敏的生产数据
- **配置即代码**：各环境的差异写在 Git 仓库里（overlay、values 文件），经过 PR 评审，而不是在控制台上手工修改

---

## 二、部署流转：trunk-based 下的环境晋级

全站分支模型统一为 trunk-based / GitHub Flow（见 [Git 工作流](./1_git_workflow)）：没有长期存在的 `develop` 分支，环境与分支解耦，**晋级的是制品，不是代码**。

![环境晋级流程](../assets/devops/env-promotion.svg)

| 环节 | 触发 | 门禁 |
|------|------|------|
| PR 预览（dev） | PR 打开 / 更新 | 构建与单元测试通过 |
| 合并 `main` → test | PR 合并 | 评审通过 + CI 全绿（测试、代码扫描、镜像扫描） |
| test → staging | 推送 `v1.4.0` 这样的 tag，或手动选择 digest 晋级 | test 环境回归通过 + QA 签字 |
| staging → prod | 手动触发晋级任务 | staging 验收通过 + 技术负责人审批 + 发布窗口内 |

晋级的落地方式是修改 GitOps 仓库中对应环境 overlay 的镜像 digest，Argo CD 检测到变更后同步到集群（见 [Argo CD](/cloud-native/9_argocd)）。合并 `main` 后的流水线自动改写 test overlay；staging 与 prod 用一个带审批的晋级任务：

```yaml
# GitOps 仓库：.github/workflows/promote.yml
name: promote

on:
  workflow_dispatch:
    inputs:
      target:
        description: 目标环境
        type: choice
        options: [staging, prod]
        required: true
      digest:
        description: 要晋级的镜像 digest（sha256:...），必须已在上一环境验证
        required: true

permissions:
  contents: write

jobs:
  promote:
    runs-on: ubuntu-latest
    # 在仓库 Settings → Environments 中为 prod 配置 Required reviewers，审批通过后才会执行
    environment: ${{ inputs.target }}
    steps:
      - uses: actions/checkout@v6

      - name: 校验 digest 格式
        env:
          DIGEST: ${{ inputs.digest }}
        run: |
          [[ "$DIGEST" =~ ^sha256:[0-9a-f]{64}$ ]] || { echo "非法的 digest: $DIGEST"; exit 1; }

      - name: 更新 overlay 并提交
        env:
          DIGEST: ${{ inputs.digest }}
          TARGET: ${{ inputs.target }}
        run: |
          yq -i '.images[0].digest = strenv(DIGEST)' "deploy/overlays/${TARGET}/kustomization.yaml"
          git config user.name "github-actions[bot]"
          git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
          git commit -am "promote ${TARGET} to ${DIGEST}"
          git push
```

- 输入值通过 `env` 传给脚本，而不是直接在 `run` 中拼接 `${{ inputs.* }}`，避免脚本注入
- 晋级记录就是 Git 提交历史：谁、在什么时间、把哪个 digest 推到了哪个环境，一目了然；回滚就是 `git revert` 这次提交
- 构建、签名与 digest 的获取见 [制品与版本管理](./6_artifact_version)，流水线整体结构见 [CI/CD](./2_ci_cd)，发布方式（滚动、蓝绿、金丝雀）见 [发布策略](./5_release_strategy)

---

## 三、应用配置：一份制品，多份配置

### 1、Profile 与环境的映射规则

Profile 的语法细节（多文档、分组、`@Profile`）见 [配置管理](/spring-boot/6_config)，这里只定团队规则：

- Profile 名与环境名一一对应：`dev`、`test`、`staging`、`prod`；本机开发另用 `local`
- **Jar 里不写默认激活的 Profile**：不要写 `spring.profiles.active: ${SPRING_PROFILES_ACTIVE:dev}`。一旦生产 Pod 漏配环境变量，应用会带着 dev 配置（dev 库地址与账号）静默启动；不写默认值时，缺少数据源地址会让应用启动失败，问题当场暴露
- Profile 文件只放非敏感的差异项（日志级别、连接池大小、开关默认值），密码、密钥一律来自环境变量或挂载的 Secret
- 本机开发通过 IDE 运行配置或 `-Dspring.profiles.active=local` 激活，`application-local.yml` 加入 `.gitignore`

```text
src/main/resources/
├── application.yml           # 所有环境共享，不含任何凭证
├── application-dev.yml
├── application-test.yml
├── application-staging.yml
└── application-prod.yml
```

```yaml
# application.yml：不设置 spring.profiles.active，由部署环境注入 SPRING_PROFILES_ACTIVE
spring:
  application:
    name: my-app

server:
  port: 8080

app:
  order:
    timeout-minutes: 30
```

```yaml
# application-dev.yml：非生产环境可以写固定地址，凭证仍由环境变量注入
spring:
  datasource:
    url: jdbc:mysql://mysql.dev.svc:3306/myapp
    username: ${DB_USER}
    password: ${DB_PASS}
  data:
    redis:
      host: redis.dev.svc
      port: 6379

logging:
  level:
    com.example: DEBUG
```

```yaml
# application-prod.yml
spring:
  datasource:
    url: ${DB_URL}
    username: ${DB_USER}
    password: ${DB_PASS}
    hikari:
      maximum-pool-size: 30
  data:
    redis:
      host: ${REDIS_HOST}
      password: ${REDIS_PASS}
      ssl:
        enabled: true          # 生产强制 TLS

logging:
  level:
    root: WARN
    com.example: INFO
```

Redis 属性在 Spring Boot 3.0 起已从 `spring.redis.*` 迁到 `spring.data.redis.*`，旧前缀在 Boot 4 中不会生效；从老项目复制配置时最容易踩这个坑。

### 2、在 Kubernetes 中注入

环境差异通过 ConfigMap 注入，凭证通过 Secret 注入，同一份 Deployment 模板在各环境复用：

```yaml
# deploy/base/deployment.yaml 片段
spec:
  template:
    spec:
      containers:
        - name: my-app
          image: harbor.example.com/backend/my-app   # digest 由各环境 overlay 的 images 字段填入
          envFrom:
            - configMapRef:
                name: app-config                   # 含 SPRING_PROFILES_ACTIVE、DB_URL 等非敏感项
          env:
            - name: DB_USER
              valueFrom:
                secretKeyRef:
                  name: my-app-db
                  key: username
            - name: DB_PASS
              valueFrom:
                secretKeyRef:
                  name: my-app-db
                  key: password
```

更推荐把 Secret 挂载成文件，用 `spring.config.import: optional:configtree:/etc/secrets/` 读取：文件不会出现在进程环境变量里，轮换也不必重建 Pod 环境，做法见 [配置管理](/spring-boot/6_config)。

### 3、Nacos 命名空间隔离

使用 Nacos 时，每个环境一个命名空间，各命名空间里的 dataId 同名，应用只切换命名空间 ID：

| 环境 | 命名空间名称 | 命名空间 ID | 说明 |
|------|-------------|------------|------|
| dev | dev | `dev-7c1e` | 开发可写 |
| test | test | `test-4a9b` | 开发、测试可写 |
| staging | staging | `staging-2d6f` | 变更走 PR 或审批 |
| prod | prod | `prod-9e3a` | 仅发布负责人可写，变更需审批 |

Spring Cloud Alibaba 2025.x（对应 Spring Boot 4 / Spring Cloud 2025.x）不再支持 bootstrap，必须用 `spring.config.import` 声明要加载的配置，只写 `spring.cloud.nacos.config.*` 不会加载任何远端配置：

```yaml
spring:
  application:
    name: my-app
  cloud:
    nacos:
      server-addr: nacos.example.com:8848
      username: ${NACOS_USERNAME}
      password: ${NACOS_PASSWORD}
      config:
        namespace: ${NACOS_NAMESPACE}     # 各环境的命名空间 ID，由部署清单注入，不设默认值
        file-extension: yaml
  config:
    import:
      # 后导入的优先级更高：服务配置覆盖公共配置
      - optional:nacos:common.yaml?group=COMMON_GROUP
      - nacos:my-app.yaml?group=DEFAULT_GROUP&refreshEnabled=true
```

配置变更按环境逐级推进：

1. 在 dev 命名空间修改并验证
2. 同步到 test 命名空间，跑回归
3. 同步到 staging 命名空间，验收
4. 提交 prod 变更审批，先用 Beta 发布推给指定实例验证
5. 全量发布到 prod，保留历史版本以便回滚

更进一步的做法是把各环境的 Nacos 配置文件也放进 Git 仓库，通过流水线调用 Nacos OpenAPI 发布，让配置变更与代码一样走 PR 评审。分组规划、刷新链路与 `@RefreshScope` 的取舍见 [配置中心](/spring-cloud/4_config_center)。

---

## 四、密钥管理

Kubernetes Secret 默认只是 Base64 编码，能读 Secret 的人就能看到明文；把 Secret 清单提交进 Git 更是等于公开密码。常见方案：

| 方案 | 做法 | 适用 |
|------|------|------|
| External Secrets Operator | 从 Vault、云 KMS / Secrets Manager 同步成 K8s Secret，Git 中只存引用 | 已有 Vault 或云密钥服务，推荐 |
| Sealed Secrets | 用集群公钥加密后提交 Git，只有集群内控制器能解密 | 纯 GitOps、无外部密钥服务 |
| Vault Agent / CSI Driver | 直接把密钥以文件形式挂进 Pod，不落 K8s Secret | 合规要求高、需要动态凭证 |
| 云厂商 KMS 集成 | 开启 etcd 静态加密（KMS Provider），配合云 Secrets Manager | 托管 K8s |

External Secrets Operator 的引用示例（`external-secrets.io/v1`）：

```yaml
apiVersion: external-secrets.io/v1
kind: ExternalSecret
metadata:
  name: my-app-db
  namespace: prod
spec:
  refreshInterval: 1h
  secretStoreRef:
    kind: ClusterSecretStore
    name: vault-prod                 # 指向生产 Vault 的连接配置
  target:
    name: my-app-db                  # 生成的 K8s Secret 名，供 Deployment 引用
  data:
    - secretKey: username
      remoteRef:
        key: prod/my-app/db
        property: username
    - secretKey: password
      remoteRef:
        key: prod/my-app/db
        property: password
```

团队规则：

- 每个环境使用**不同的凭证**，非生产环境的凭证泄露不能波及生产
- 生产密钥只由密钥系统和应用读取，人员默认无读取权限，紧急查看要审批并留审计
- 密钥定期轮换，应用要支持不停机切换（双账号或动态凭证）

密钥生命周期、Vault 动态凭证与轮换细节见 [数据安全](/security/7_data_security)，Helm 场景下的用法见 [Helm](/cloud-native/8_helm)。

---

## 五、功能开关（Feature Flag）

功能开关让「部署」和「发布」分离：代码已经上线，但新功能对谁可见由开关决定。它是金丝雀放量、A/B 实验和快速止损的基础；放量与回滚的整体流程见 [发布策略](./5_release_strategy)，用开关做降级见 [服务降级](/high-avail/6_degradation)。

### 1、配置中心驱动的简单实现

用 `@ConfigurationProperties` 承载开关：Nacos 推送变更后，Spring Cloud 会触发 `EnvironmentChangeEvent` 并重新绑定这类 Bean，**不需要 `@RefreshScope`**。用 `@Value` 字段的普通 `@Component` 则拿不到新值，开关改了等于没改。注意重新绑定只作用于 JavaBean 风格（有 setter）的属性类，构造器绑定的 record 不会被刷新。

```java
import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;

import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.stereotype.Component;

@Component
@ConfigurationProperties(prefix = "feature")
public class FeatureFlags {

    private Map<String, Flag> flags = new HashMap<>();

    public boolean isEnabled(String featureKey, long userId) {
        Flag flag = flags.get(featureKey);
        if (flag == null || !flag.isEnabled()) {
            return false;                                   // 总开关关闭或未配置：走旧逻辑
        }
        if (flag.getWhitelist().contains(userId)) {
            return true;                                    // 白名单优先
        }
        // 稳定分桶：同一用户在同一功能下始终落在同一个桶；
        // 拼上 featureKey，避免不同功能总是命中同一批用户；floorMod 保证结果非负
        int bucket = Math.floorMod((featureKey + ":" + userId).hashCode(), 100);
        return bucket < flag.getRolloutPercent();
    }

    public Map<String, Flag> getFlags() { return flags; }
    public void setFlags(Map<String, Flag> flags) { this.flags = flags; }

    public static class Flag {
        private boolean enabled;
        private Set<Long> whitelist = new HashSet<>();
        private int rolloutPercent;                         // 0-100

        public boolean isEnabled() { return enabled; }
        public void setEnabled(boolean enabled) { this.enabled = enabled; }
        public Set<Long> getWhitelist() { return whitelist; }
        public void setWhitelist(Set<Long> whitelist) { this.whitelist = whitelist; }
        public int getRolloutPercent() { return rolloutPercent; }
        public void setRolloutPercent(int rolloutPercent) { this.rolloutPercent = rolloutPercent; }
    }
}
```

```java
@Service
public class CheckoutService {

    private final FeatureFlags featureFlags;

    public CheckoutService(FeatureFlags featureFlags) {
        this.featureFlags = featureFlags;
    }

    public CheckoutResult checkout(long userId, CheckoutRequest request) {
        // newCheckout / legacyCheckout 是本类中的新旧两套实现
        if (featureFlags.isEnabled("new-checkout", userId)) {
            return newCheckout(request);
        }
        return legacyCheckout(request);
    }
}
```

判定顺序如下：

![功能开关判定流程](../assets/devops/env-feature-flag-eval.svg)

dev 命名空间中的 `my-app.yaml`：

```yaml
feature:
  flags:
    new-checkout:
      enabled: true
      rollout-percent: 100      # dev 全量打开
```

prod 命名空间中的 `my-app.yaml`：

```yaml
feature:
  flags:
    new-checkout:
      enabled: true
      whitelist: [1001, 1002]   # 先对内部账号开放
      rollout-percent: 5        # 再放量 5% 用户，观察指标后逐步调大
```

- `String.hashCode()` 的算法由 Java 规范固定，不同实例、不同 JVM 计算结果一致，分桶稳定
- 关闭功能时把 `enabled` 改为 `false`，不要直接删掉配置项：Map 类型的属性重新绑定时，被删除的键不一定会从已有 Map 中移除

### 2、开关的生命周期

开关是有成本的技术债：每个开关都让代码多一条分支、测试多一种组合。

| 类型 | 用途 | 生命周期 |
|------|------|---------|
| 发布开关 | 新功能灰度放量 | 短期，全量后 1–2 个迭代内删除 |
| 实验开关 | A/B 实验 | 实验结束即删除 |
| 运维开关 | 降级、限流预案 | 长期保留，纳入故障预案并定期演练 |
| 权限开关 | 按租户、套餐开放功能 | 长期，属于业务配置 |

每个开关登记**负责人、创建时间、预计删除时间**；在看板或代码扫描中跟踪超期的开关，全量后同时删除配置和代码分支。

### 3、专业平台与 OpenFeature

开关多了、需要按用户属性定向、审计和实验分析时，就该用专业平台：开源的 Unleash、Flagsmith、flagd，Java 生态的 FF4j，或商业 SaaS。CNCF 的 **OpenFeature** 定义了与厂商无关的开关 API 和 SDK：业务代码只依赖 OpenFeature 的 `Client`，背后接哪个平台由 Provider 决定，换平台不用改业务代码。

---

## 六、环境数据管理

### 1、测试数据来源

测试数据优先级：**合成数据 > 脱敏后的生产样本 > 生产全量脱敏副本**。生产数据含个人信息，复制到测试环境属于数据处理行为，要符合《个人信息保护法》或 GDPR 的要求，能用合成数据就不要碰生产数据。

确需从生产同步时，导出、脱敏、导入全程走管道，原始数据不落盘：

```bash
#!/usr/bin/env bash
# 每周把生产数据脱敏后同步到测试库：导出 → 脱敏 → 导入全程走管道，原始数据不落盘
set -euo pipefail

# [client] 段写 host / user / password，文件权限 600，由密钥系统下发
PROD_CNF=/etc/db-sync/prod-readonly.cnf
TEST_CNF=/etc/db-sync/test-writer.cnf

mysqldump --defaults-extra-file="${PROD_CNF}" \
  --single-transaction --quick --set-gtid-purged=OFF \
  --ignore-table=myapp.user_credential \
  --ignore-table=myapp.payment_record \
  myapp \
| python3 desensitize.py \
| mysql --defaults-extra-file="${TEST_CNF}" myapp_test

echo "测试库同步完成"
```

- `--defaults-extra-file` 必须是第一个参数，凭证不出现在命令行和进程列表里
- `--single-transaction` 对 InnoDB 做一致性快照导出，不锁表；`--quick` 逐行输出，避免大表撑爆内存
- `pipefail` 保证管道中任一环节失败脚本即失败；导入中途失败时测试库可能只导入了一半，建议先导入临时库，校验后再切换
- `desensitize.py` 从标准输入读、向标准输出写，对手机号、姓名、证件号、邮箱做替换或哈希；脱敏规则见 [数据安全](/security/7_data_security)
- 用生产只读账号，且从只读副本导出，避免影响主库

### 2、中间件隔离规则

| 资源 | 隔离方式 | 说明 |
|------|---------|------|
| 数据库 | 每个环境独立实例 | 禁止跨环境共享实例，生产实例不开放给非生产网络 |
| Redis | 独立实例，或同一非生产实例内用 key 前缀区分 | Redis Cluster 只支持 0 号库，靠 DB 编号隔离在集群模式下不可行（Valkey 9.0 起集群模式支持多库，但仍不建议作为环境隔离手段） |
| MQ | 非生产可共用集群，Topic 加环境前缀（`test.order.created`）；生产独立集群 | 消费组同样加前缀，避免跨环境抢消息 |
| 对象存储 | 每个环境独立 Bucket，独立访问密钥 | `my-app-test`、`my-app-prod` |
| 第三方服务 | 使用沙箱账号与沙箱回调地址 | 支付、短信等绝不能在非生产环境使用生产账号 |

第三方回调需要访问到开发机时，可用 Cloudflare Tunnel 或 ngrok 临时暴露本地端口。这相当于把内网服务直接挂到公网：只在调试期间开启，用完关闭；只暴露回调接口，必要时加 Cloudflare Access 做身份校验，并校验回调签名。做法见 [Cloudflare](/cloud-native/16_cloudflare)。

---

## 七、Kubernetes 多环境隔离

### 1、隔离边界

**Namespace 不是安全边界**：同一集群内的命名空间共享节点、内核、控制面和集群级资源，一个配置错误或容器逃逸就可能波及其他命名空间。推荐布局：

| 环境 | 布局 |
|------|------|
| prod | 独立集群，独立云账号或 VPC，独立的访问凭证与审批流程 |
| staging | 独立集群（与生产同规格），预算紧张时与非生产共集群但使用独立节点池 |
| dev / test / PR 预览 | 共用一个非生产集群，按命名空间隔离，配 ResourceQuota、NetworkPolicy 与 RBAC |

非生产集群中，用 ResourceQuota 防止某个环境（尤其是数量不定的 PR 预览环境）耗尽集群资源：

```yaml
apiVersion: v1
kind: ResourceQuota
metadata:
  name: env-quota
  namespace: test
spec:
  hard:
    requests.cpu: "4"
    requests.memory: 8Gi
    limits.cpu: "8"
    limits.memory: 16Gi
    pods: "20"
```

再用 NetworkPolicy 限制跨命名空间访问，只允许同命名空间内的 Pod 互访（需要 CNI 支持 NetworkPolicy，如 Calico、Cilium）：

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: same-namespace-only
  namespace: test
spec:
  podSelector: {}
  policyTypes: [Ingress]
  ingress:
    - from:
        - podSelector: {}
```

### 2、Kustomize 管理环境差异

公共清单放 `base`，每个环境一个 overlay 只写差异：

```text
deploy/
├── base/
│   ├── kustomization.yaml
│   ├── deployment.yaml
│   └── service.yaml
└── overlays/
    ├── test/
    ├── staging/
    └── prod/
        ├── kustomization.yaml
        ├── replicas-patch.yaml
        └── prod.env
```

```yaml
# deploy/overlays/prod/kustomization.yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
namespace: my-app
resources:
  - ../../base              # 旧写法 bases: 已弃用，统一用 resources:
patches:
  - path: replicas-patch.yaml
configMapGenerator:
  - name: app-config        # 生成带内容哈希后缀的 ConfigMap，并自动改写 Deployment 中的引用
    envs:
      - prod.env
images:
  - name: harbor.example.com/backend/my-app
    digest: sha256:6f1d0c3e9a...   # 由晋级任务写入
```

```yaml
# deploy/overlays/prod/replicas-patch.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: my-app
spec:
  replicas: 6
```

```text
# deploy/overlays/prod/prod.env
SPRING_PROFILES_ACTIVE=prod
NACOS_NAMESPACE=prod-9e3a
DB_URL=jdbc:mysql://mysql-prod.internal:3306/myapp
```

- `configMapGenerator` 生成的 ConfigMap 名带内容哈希，配置一改名字就变，Deployment 随之滚动更新，避免「改了 ConfigMap 但 Pod 没重启」
- 本地预览渲染结果用 `kubectl kustomize deploy/overlays/prod`，提交前在 PR 中审阅 diff
- 生产集群通常只有一个环境，`namespace` 按应用命名即可，不必再叫 `prod`
- 用 Helm 管理时，对应做法是每个环境一份 values 文件，见 [Helm](/cloud-native/8_helm)

### 3、用 GitOps 保持环境一致

各环境 overlay 放在同一个 GitOps 仓库，由 Argo CD 的 ApplicationSet 为每个环境生成一个 Application：环境之间的差异就是 overlay 目录之间的 diff，任何人在集群里手工改动都会被检测为漂移并自动纠正。PR 预览环境可用 ApplicationSet 的 Pull Request 生成器，为每个打开的 PR 创建一个命名空间，PR 关闭后自动清理。写法见 [Argo CD](/cloud-native/9_argocd)。

---

## 小结

- 四环境各有分工：dev 做 PR 预览、test 跟随 `main`、staging 与生产同规格、prod 只部署 staging 验证过的同一个 digest
- trunk-based 下环境与分支解耦，晋级的是制品：改 GitOps 仓库中 overlay 的 digest，prod 晋级走 GitHub Environments 审批
- Jar 里不设默认 Profile，漏配环境变量要启动失败而不是带着 dev 配置运行；Redis 属性用 `spring.data.redis.*`
- Nacos 每环境一个命名空间，Spring Cloud Alibaba 2025.x 必须用 `spring.config.import` 加载配置
- K8s Secret 只是 Base64，密钥交给 External Secrets / Sealed Secrets / Vault，各环境凭证互不相同
- 功能开关用 `@ConfigurationProperties` 承载才能随配置中心刷新；分桶用 `floorMod(hash(featureKey:userId))`；开关登记负责人与删除时间，规模上来后用 OpenFeature + 专业平台
- 测试数据优先合成数据；必须用生产数据时全程管道脱敏、不落盘
- Namespace 不是安全边界：生产独立集群，非生产按命名空间隔离并配额度、网络策略与 RBAC；Kustomize 用 `resources:` 引用 base

## 参考资料

- Spring Boot 外部化配置与 Profile：[Externalized Configuration](https://docs.spring.io/spring-boot/reference/features/external-config.html)、[Profiles](https://docs.spring.io/spring-boot/reference/features/profiles.html)
- Spring Boot 配置属性清单（`spring.data.redis.*`）：[Common Application Properties](https://docs.spring.io/spring-boot/appendix/application-properties/index.html)
- Spring Cloud 环境变更与重新绑定：[Spring Cloud Commons: Environment Changes](https://docs.spring.io/spring-cloud-commons/reference/spring-cloud-commons/application-context-services.html)
- Spring Cloud Alibaba Nacos Config：[Nacos Config 使用指南](https://sca.aliyun.com/docs/2025.x/user-guide/nacos/overview/)
- GitHub Actions 部署环境与审批：[Managing environments for deployment](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments)
- GitHub Actions 脚本注入防护：[Secure use reference](https://docs.github.com/en/actions/reference/security/secure-use)
- Kubernetes Secret 的安全建议：[Good practices for Kubernetes Secrets](https://kubernetes.io/docs/concepts/security/secrets-good-practices/)
- Kubernetes 资源配额与网络策略：[Resource Quotas](https://kubernetes.io/docs/concepts/policy/resource-quotas/)、[Network Policies](https://kubernetes.io/docs/concepts/services-networking/network-policies/)
- Kubernetes 多租户（Namespace 隔离的边界）：[Multi-tenancy](https://kubernetes.io/docs/concepts/security/multi-tenancy/)
- Kustomize：[Kustomization 参考](https://kubectl.docs.kubernetes.io/references/kustomize/kustomization/)
- External Secrets Operator：[ExternalSecret API](https://external-secrets.io/latest/api/externalsecret/)
- Sealed Secrets：[bitnami-labs/sealed-secrets](https://github.com/bitnami-labs/sealed-secrets)
- Argo CD ApplicationSet：[Generating Applications with ApplicationSet](https://argo-cd.readthedocs.io/en/stable/user-guide/application-set/)
- OpenFeature：[OpenFeature 文档](https://openfeature.dev/docs/reference/intro)
- MySQL mysqldump：[mysqldump — A Database Backup Program](https://dev.mysql.com/doc/refman/8.4/en/mysqldump.html)
