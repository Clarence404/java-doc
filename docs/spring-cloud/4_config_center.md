---
description: spring.config.import 接入、gRPC 推送刷新、@RefreshScope 与重绑定、隔离分层
---

# 配置中心

> 前置阅读：[注册发现](./1_service_registry)

配置中心让配置脱离安装包，支持动态刷新、环境隔离、集中管理与敏感信息保护。本篇讲 Nacos Config 接入、刷新链路、`@RefreshScope` 与属性重绑定、环境隔离与配置分层，基线为 Spring Boot 4.x。

---

## 一、主流方案对比

本篇对应 Spring Cloud 2025.1；刷新部分重点对比 `@RefreshScope` 与 `@ConfigurationProperties` 重绑定的差异。

配置写在包里，变更就要重新打包发布。配置中心解决四件事：

| 问题 | 解决方式 |
|------|---------|
| **动态刷新** | 改开关、阈值、超时不重启即可生效 |
| **环境隔离** | dev / test / prod 配置分离，防止误用 |
| **集中管理** | 统一维护、变更审计、历史版本回滚、灰度发布配置 |
| **敏感信息保护** | 密码、密钥不进代码仓库，按权限访问 |

| 组件 | 特点 | 适用场景 |
|------|------|---------|
| **Nacos Config** | 与注册中心一体，gRPC 推送，支持命名空间、Beta 灰度发布与历史回滚 | 国内主流，Spring Cloud Alibaba 首选 |
| **Apollo** | 权限、审计、灰度发布完善，客户端本地缓存，UI 友好 | 配置治理要求高、多团队共用的场景 |
| **Spring Cloud Config** | Spring 官方，仍在维护；后端支持 Git、Vault、JDBC、Redis、AWS 等；变更推送需配合 Spring Cloud Bus | 配置走 Git 评审流程、已有 Vault 的团队 |
| **Kubernetes ConfigMap / Secret** | 平台原生；Spring Cloud Kubernetes 可监听变更并触发刷新 | 运行在 K8s 上、不想再引入配置中心 |

敏感配置（数据库密码、第三方密钥）优先放 Vault、K8s Secret 或云厂商 KMS，Jasypt 加密只是退而求其次的方案，对比见 [数据安全](/security/7_data_security)。

---

## 二、Nacos Config 接入

### 1、依赖与 spring.config.import

```xml
<dependency>
    <groupId>com.alibaba.cloud</groupId>
    <artifactId>spring-cloud-starter-alibaba-nacos-config</artifactId>
</dependency>
```

配置写在 `application.yml` 中，通过 `spring.config.import` 声明要加载的 Nacos 配置：

```yaml
spring:
  application:
    name: order-service
  cloud:
    nacos:
      server-addr: nacos-1:8848,nacos-2:8848,nacos-3:8848
      username: ${NACOS_USERNAME}
      password: ${NACOS_PASSWORD}
      config:
        namespace: 3f2a6c1e-dev          # 命名空间 ID，按环境隔离
        file-extension: yaml
  config:
    import:
      # 列在后面的导入优先级更高，服务配置覆盖公共配置
      - optional:nacos:common-datasource.yaml?group=COMMON_GROUP&refreshEnabled=false
      - optional:nacos:common-redis.yaml?group=COMMON_GROUP
      - nacos:order-service.yaml?group=DEFAULT_GROUP&refreshEnabled=true
```

- `nacos:` 前缀不带 `optional:` 时，Nacos 不可达或 dataId 不存在会导致启动失败，核心配置建议这样做，强制暴露问题
- `refreshEnabled=false` 用于数据源这类不应运行时变更的配置
- **bootstrap 已成为历史**：Boot 2.4 / Spring Cloud 2020.0 起 bootstrap 上下文默认关闭（需要额外引入 `spring-cloud-starter-bootstrap`），Spring Cloud Alibaba 2025.1 起不再支持 bootstrap 方式，`bootstrap.yml` 中的配置不会再被读取，升级时要迁移到 `spring.config.import`

### 2、读取配置

```java
// 方式一：@ConfigurationProperties（推荐）：类型安全，变更后自动原地重绑定，不需要 @RefreshScope
@ConfigurationProperties(prefix = "order")
public class OrderProperties {

    private int timeout = 30;
    private int maxRetry = 3;
    private List<String> allowedPaymentMethods = new ArrayList<>();

    // getter / setter 省略；需要通过 @EnableConfigurationProperties 或 @ConfigurationPropertiesScan 注册
}
```

```java
// 方式二：@Value：需要 @RefreshScope 才能拿到新值
@RefreshScope
@RestController
public class FeatureController {

    @Value("${feature.new-checkout:false}")
    private boolean newCheckout;

    @GetMapping("/features/new-checkout")
    public boolean newCheckout() {
        return newCheckout;
    }
}
```

两种方式的刷新行为不同：

| 维度 | `@ConfigurationProperties` 重绑定 | `@RefreshScope` |
|------|--------------------------------|-----------------|
| 触发 | `EnvironmentChangeEvent` → `ConfigurationPropertiesRebinder` | `RefreshScope.refreshAll()` |
| 行为 | 同一个 Bean 实例，重新执行绑定，字段被覆盖 | Bean 是代理，刷新时销毁目标对象，下次方法调用时重建 |
| 副作用 | 初始化时根据配置算出的派生状态（如按配置建好的线程池）不会更新 | 重建会重新执行初始化逻辑，持有连接、定时任务的 Bean 会被反复创建 |
| 适用 | 绝大多数业务参数 | 少数需要「整体重建」的 Bean |

注意：只有 JavaBean（setter）写法的属性类会被原地重绑定；record 等构造器绑定的属性类不可变，刷新时不会更新，需要动态刷新的属性类要用 JavaBean 写法。

`@RefreshScope` Bean 在刷新后的第一次调用时才重建，如果重建失败（比如新配置非法），异常会抛到业务请求上，所以上线前要校验配置内容（`@Validated` 配合属性类）。

### 3、监听变更

需要在配置变化时执行动作（重建客户端、清缓存），优先监听 Spring 的 `EnvironmentChangeEvent`，与具体配置中心解耦：

```java
import java.util.Set;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.cloud.context.environment.EnvironmentChangeEvent;
import org.springframework.context.event.EventListener;
import org.springframework.stereotype.Component;

@Component
public class OrderConfigChangeHandler {

    private static final Logger log = LoggerFactory.getLogger(OrderConfigChangeHandler.class);

    @EventListener
    public void onChange(EnvironmentChangeEvent event) {
        Set<String> keys = event.getKeys();          // 本次变化的配置键
        if (keys.stream().anyMatch(k -> k.startsWith("order.http."))) {
            log.info("HTTP 客户端配置变化，重建连接池 keys={}", keys);
            // rebuildHttpClient();
        }
    }
}
```

需要拿到 dataId 的原始内容时（例如配置里存的是一段 JSON 规则），用 `NacosConfigManager` 注册 Nacos 原生监听器：

```java
import com.alibaba.cloud.nacos.NacosConfigManager;
import com.alibaba.nacos.api.config.listener.AbstractListener;
import com.alibaba.nacos.api.exception.NacosException;
import jakarta.annotation.PostConstruct;
import org.springframework.stereotype.Component;

@Component
public class PricingRuleListener {

    private final NacosConfigManager nacosConfigManager;
    private final PricingRuleHolder ruleHolder;

    public PricingRuleListener(NacosConfigManager nacosConfigManager, PricingRuleHolder ruleHolder) {
        this.nacosConfigManager = nacosConfigManager;
        this.ruleHolder = ruleHolder;
    }

    @PostConstruct
    public void register() throws NacosException {
        nacosConfigManager.getConfigService().addListener("pricing-rules.json", "DEFAULT_GROUP",
            new AbstractListener() {
                @Override
                public void receiveConfigInfo(String content) {
                    ruleHolder.reload(content);       // 在 Nacos 回调线程执行，避免耗时操作
                }
            });
    }
}
```

Boot 自身的配置加载顺序、Profile 与 `@ConfigurationProperties` 校验见 Spring Boot 模块的 [配置管理](/spring-boot/6_config)。

---

## 三、动态刷新原理

![Nacos 2.x+ 配置动态刷新链路](../assets/spring-cloud/nacos-config-refresh.svg)

1. 配置在控制台或 OpenAPI 发布后，Nacos Server 持久化内容并更新 MD5
2. Server 通过 gRPC 长连接向订阅了该 dataId 的客户端推送变更通知（只是通知，不带内容）
3. 客户端收到通知后主动拉取最新内容，与本地 MD5 比较，确有变化才回调监听器；客户端还会定期全量比对 MD5 兜底，防止通知丢失
4. `NacosContextRefresher` 为每个 `refreshEnabled` 的 dataId 注册了监听器，回调时发布 `RefreshEvent`
5. `ContextRefresher` 重新加载配置源、更新 `Environment`，计算出变化的键并发布 `EnvironmentChangeEvent`
6. `ConfigurationPropertiesRebinder` 重绑定 `@ConfigurationProperties` Bean，`RefreshScope.refreshAll()` 销毁 `@RefreshScope` Bean

Nacos 1.x 与 2.x+ 的差异：

| 维度 | Nacos 1.x | Nacos 2.x / 3.x |
|------|-----------|-----------------|
| 感知变更 | HTTP 长轮询：客户端带上 MD5 请求，默认超时 30s，服务端挂起约 29.5s | gRPC 长连接，服务端主动推送 |
| 无变更时 | 挂起到期后返回 200 和空结果，客户端立即发起下一轮 | 无请求，连接保持 |
| 有变更时 | 立即返回变化的 dataId 列表，客户端再拉内容 | 推送通知，客户端再拉内容 |
| 服务端压力 | 每个客户端持续占用一个挂起请求 | 连接复用，压力显著降低 |

客户端拉到的配置会写入本地快照文件，Nacos 不可用时应用重启仍能用快照启动。

---

## 四、隔离与分层

### 1、三层隔离模型

| 层级 | 用途 | 示例 |
|------|------|------|
| `namespace` | 环境或租户隔离，彼此完全不可见 | dev / test / prod 各一个命名空间 |
| `group` | 业务线或公共配置分组 | `DEFAULT_GROUP`、`COMMON_GROUP`、`PAY_GROUP` |
| `dataId` | 具体配置文件 | `order-service.yaml` |

推荐用 namespace 隔离环境，不同环境里 dataId 同名，应用只需切换 namespace ID。也可以在同一 namespace 内用 `order-service-dev.yaml` 这类带 Profile 后缀的 dataId 区分环境，但隔离更弱、误改风险更高。命名规范要在接入前定好，后期迁移代价很大。

### 2、配置分层

| 层次 | 内容 | 示例 dataId | 刷新 |
|------|------|------------|------|
| 公共层 | 多服务共享的中间件地址、通用参数 | `common-datasource.yaml`、`common-redis.yaml` | 数据源类关闭 |
| 服务层 | 单个服务独有的业务参数 | `order-service.yaml` | 开启 |
| 开关层 | 功能开关、降级开关、灰度比例 | `order-service-switch.yaml` | 开启 |

### 3、变更规范

- 生产配置变更走审批，先用 Nacos 的 Beta 发布推送给指定 IP 验证，再全量发布
- 能热更新的只放「运行时可安全变更」的参数；数据源地址、线程池核心结构这类变更走发布流程
- 配置变更要能追溯：保留历史版本，出问题时直接回滚到上一版本

---

## 小结

- 配置中心解决动态刷新、环境隔离、集中管理与敏感信息保护；国内主流 Nacos，配置治理要求高选 Apollo，K8s 原生场景用 ConfigMap / Secret
- Spring Cloud Alibaba 2025.1 取消 bootstrap，统一在 `application.yml` 中用 `spring.config.import=nacos:...` 加载，后导入的配置优先级更高
- Nacos 2.x+ 用 gRPC 推送变更通知、客户端再拉内容并校验 MD5；1.x 的 HTTP 长轮询无变更时返回 200 空结果，不是 304
- 刷新链路：`RefreshEvent` → `ContextRefresher` 刷新 `Environment` → `EnvironmentChangeEvent` 重绑定 `@ConfigurationProperties` → `RefreshScope` 销毁并懒重建 Bean
- `@ConfigurationProperties` 不需要 `@RefreshScope`；`@Value` 需要；`@RefreshScope` 会重跑初始化逻辑，慎用于持有资源的 Bean
- 监听变更优先用 `EnvironmentChangeEvent`，需要原始内容时用 `NacosConfigManager` 注册原生监听器
- namespace 隔离环境、group 分业务、dataId 分文件；敏感配置交给 Vault / K8s Secret / KMS

## 参考资料

- Spring Cloud Alibaba Nacos Config：[https://sca.aliyun.com/docs/2025.x/user-guide/nacos/overview/](https://sca.aliyun.com/docs/2025.x/user-guide/nacos/overview/)
- Spring Cloud Commons（Environment Changes / Refresh Scope）：[https://docs.spring.io/spring-cloud-commons/reference/spring-cloud-commons/application-context-services.html](https://docs.spring.io/spring-cloud-commons/reference/spring-cloud-commons/application-context-services.html)
- Spring Boot 外部化配置（Importing Additional Data）：[https://docs.spring.io/spring-boot/reference/features/external-config.html](https://docs.spring.io/spring-boot/reference/features/external-config.html)
- Apollo：[https://www.apolloconfig.com/](https://www.apolloconfig.com/)

> 下一篇：[服务治理](./5_service_governance) —— 负载均衡、灰度路由、限流熔断在 Spring Cloud 中的落地。
