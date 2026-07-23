# 配置中心

> 参考资料：
> * Nacos 配置管理：[https://nacos.io/zh-cn/docs/quick-start-spring-cloud.html](https://nacos.io/zh-cn/docs/quick-start-spring-cloud.html)
> * Apollo：[https://www.apolloconfig.com/](https://www.apolloconfig.com/)

---

## 一、为什么需要配置中心

传统应用将配置写在文件或代码中，变更需要重新打包部署。配置中心解决：

| 问题 | 解决方式 |
|------|---------|
| **动态刷新** | 不重启服务即可生效，避免发布窗口限制 |
| **环境隔离** | dev / test / prod 配置完全分离，防止误用 |
| **集中管理** | 所有服务配置统一维护、变更审计、回滚 |
| **敏感信息保护** | 数据库密码、密钥集中管理，不进代码仓库 |

---

## 二、主流方案对比

| 组件 | 特点 | 适用场景 |
|------|------|---------|
| **Nacos Config** | 与注册中心一体化，轻量，支持 YAML/Properties/JSON | 国内主流，Spring Cloud Alibaba 首选 |
| **Apollo** | 配置分组、灰度发布、权限管控完善，UI 友好 | 对配置管理有高要求的复杂场景 |
| **Spring Cloud Config** | Spring 原生，依赖 Git 仓库存储配置 | 已有 Git 流程管理配置的团队 |
| **Kubernetes ConfigMap** | 云原生原生支持，与 Pod 生命周期绑定 | 纯云原生场景 |

---

## 三、Nacos Config Spring Boot 接入

### 依赖

```xml
<dependency>
    <groupId>com.alibaba.cloud</groupId>
    <artifactId>spring-cloud-starter-alibaba-nacos-config</artifactId>
</dependency>
```

### bootstrap.yml（必须用 bootstrap，在 application.yml 之前加载）

```yaml
spring:
  application:
    name: order-service
  config:
    import: nacos:order-service.yaml   # Spring Boot 2.4+ 方式
  cloud:
    nacos:
      config:
        server-addr: localhost:8848
        namespace: dev
        group: DEFAULT_GROUP
        file-extension: yaml
        # 共享配置（多个服务共用的公共配置）
        shared-configs:
          - data-id: common-datasource.yaml
            group: DEFAULT_GROUP
            refresh: true
          - data-id: common-redis.yaml
            group: DEFAULT_GROUP
            refresh: true
```

### 读取配置

```java
// 方式一：@Value（需配合 @RefreshScope 才能动态刷新）
@RefreshScope
@RestController
public class OrderController {

    @Value("${order.timeout:30}")
    private int orderTimeout;

    @Value("${order.max-retry:3}")
    private int maxRetry;

    @GetMapping("/config")
    public Map<String, Object> getConfig() {
        return Map.of("timeout", orderTimeout, "maxRetry", maxRetry);
    }
}

// 方式二：@ConfigurationProperties（推荐，类型安全，自动刷新）
@Data
@Component
@RefreshScope
@ConfigurationProperties(prefix = "order")
public class OrderProperties {
    private int timeout = 30;
    private int maxRetry = 3;
    private String paymentCallbackUrl;
    private List<String> allowedPaymentMethods;
}
```

### 监听配置变更（编程式）

```java
@Component
public class ConfigChangeListener {

    @NacosConfigListener(dataId = "order-service.yaml", groupId = "DEFAULT_GROUP")
    public void onConfigChange(String newConfig) {
        log.info("Config changed: {}", newConfig);
        // 处理配置变更逻辑（如重新初始化连接池）
    }
}
```

---

## 四、配置动态刷新原理

```
Nacos Config 长轮询机制（默认 30s）：
  客户端 → 发起 HTTP 请求到 Nacos Server（携带当前配置的 MD5）
  Nacos  → 配置未变更：hold 请求 29.5s 后返回 304
         → 配置已变更：立即返回新配置内容
  客户端 → 收到新配置后，触发 ApplicationContext 中 @RefreshScope Bean 的重建
```

**@RefreshScope 原理**：被标注的 Bean 是代理对象，配置变更时销毁旧 Bean，下次调用时重新创建并注入新配置值。

---

## 五、最佳实践

### 敏感配置加密

不要将数据库密码等敏感信息明文存 Nacos，结合 Jasypt 加密：

```yaml
# 配置中心中存储
spring:
  datasource:
    password: ENC(加密后的密文)
```

```java
// 启动时解密
jasypt:
  encryptor:
    password: ${JASYPT_MASTER_KEY}  # 从环境变量注入主密钥
```

### 环境隔离策略

```
Nacos Namespace（推荐）：
  dev  Namespace → order-service.yaml（开发配置）
  test Namespace → order-service.yaml（测试配置）
  prod Namespace → order-service.yaml（生产配置）

Spring Profile 对应方式：
  order-service.yaml          → 公共配置
  order-service-dev.yaml      → dev 环境覆盖
  order-service-prod.yaml     → prod 环境覆盖
```

### 配置分层原则

```
公共层（多服务共享）：common-datasource.yaml、common-redis.yaml
服务层（单服务独有）：order-service.yaml
环境层（环境差异）：  order-service-prod.yaml
```
