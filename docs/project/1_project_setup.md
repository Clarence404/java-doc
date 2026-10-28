---
description: 模块化单体的仓库与模块划分、按功能分包、父 POM 与依赖管理、质量门禁、Git 与 CI、多环境配置
---

# 工程搭建

> 前置阅读：[项目演进总览](./0_overview)、[工程结构与分包](/architecture/2_package_structure)

阶段一只有 3 个人、要尽快上线，工程骨架决定了以后拆服务时是顺手拆开还是推倒重来。本篇讲仓库与模块、包结构、构建与质量门禁、Git 与 CI、配置与环境，基线为 JDK 21、Spring Boot 4、Maven 3.9。

---

## 一、背景

项目启动时的约束很明确：

- **人**：3 个全栈开发，没有专职运维和测试
- **量**：预估日订单 1 万，下单峰值约 20 QPS，一台 4 核 8 G 的机器就扛得住
- **时间**：两个月内上线下单、支付、发货通知的主链路
- **部署**：两台云主机 + 一个云数据库 MySQL 8.4，前面挂云负载均衡

这个规模下性能不是问题，真正的风险有两个：一是为了快而写成「大泥球」，半年后谁都不敢改；二是照着大厂架构一上来就拆微服务，3 个人被注册中心、配置中心、分布式事务拖住，迟迟上不了线。

---

## 二、选项

| 方案 | 做法 | 好处 | 代价 |
|------|------|------|------|
| 单模块单体 | 一个 Maven 工程，按 controller / service / mapper 分包 | 最快 | 边界全靠自觉，订单代码直接调库存的 Mapper，以后拆不开 |
| **模块化单体** | 一个仓库、多个 Maven 模块、打成一个 jar；模块之间只能走对方的 `api` 包 | 部署和单体一样简单，边界由编译与测试守住 | 要多花一两天搭骨架，写跨模块调用时多一层接口 |
| 微服务 | 订单、商品、库存、用户各自独立部署 | 独立发布、独立扩容 | 需要注册发现、网关、远程调用、分布式事务、链路追踪，3 个人维护不过来 |

拆不拆、什么时候拆的判断标准见 [服务拆分](/microservices/1_service_split)：团队规模、发布冲突、扩容需求三者都还没出现，现在拆只有成本没有收益。

---

## 三、决策

**选模块化单体**：按业务能力分 Maven 模块，运行时是一个进程、一个数据库，但代码层面提前把边界划好。等到阶段三真要拆服务时，每个业务模块原则上就是一个服务的雏形。

同时明确**现在不做**的事：

| 不做 | 原因 | 什么时候做 |
|------|------|-----------|
| Kubernetes | 两台主机 + systemd 足够，学习和运维成本太高 | 阶段三 [拆分服务](./6_split) |
| 注册中心、配置中心、网关 | 只有一个应用，没有服务要发现 | 阶段三 [拆分服务](./6_split) |
| 消息队列 | 20 QPS 下同步调用完全够用 | 阶段二 [异步化](./5_async) |
| Redis 缓存 | 数据库还远没到瓶颈 | 阶段二 [引入缓存](./4_cache) |
| 分库分表、读写分离 | 日订单 1 万，单库单表能撑几年的数据量 | 视数据量而定，阶段二后再评估 |

---

## 四、仓库与模块

### 1、仓库布局

一个 Git 仓库 `qingyou-mall`，根目录就是父工程，模块平铺在根目录下：

```text
qingyou-mall/
├── pom.xml                 父 POM：版本、依赖管理、插件
├── mvnw / mvnw.cmd         Maven Wrapper，所有人和 CI 用同一个 Maven 版本
├── .mvn/wrapper/
├── mall-common/            通用组件：错误码、异常与全局异常处理、ID 生成
├── mall-user/              用户、收货地址
├── mall-product/           商品、类目、价格
├── mall-inventory/         库存查询与扣减
├── mall-order/             下单、订单状态、支付单
├── mall-app/               启动模块：启动类、配置文件、打包成可执行 jar
├── config/checkstyle/      Checkstyle 规则
├── deploy/                 systemd 单元文件、部署脚本
└── .github/workflows/      CI 流水线
```

### 2、模块与依赖方向

![qingyou-mall 模块依赖](../assets/project/qingyou-module-deps.svg)

依赖规则只有三条：

- **单向**：`mall-order` 可以依赖商品、库存、用户，反过来不行；业务模块之间不允许出现环
- **只走 api**：每个业务模块对外只暴露 `api` 包（接口 + DTO），其他模块不能引用它的实体、Mapper、Service 实现
- **common 不放业务**：`mall-common` 只放与业务无关的基础设施，防止它变成什么都往里塞的「垃圾桶」

`mall-app` 是唯一的启动模块，依赖全部业务模块，自己几乎不写业务代码。支付暂时放在 `mall-order` 里（支付单与订单强相关、量也小），阶段三再视情况独立。模块划分与依赖方向的通用做法见 [工程结构与分包](/architecture/2_package_structure)。

---

## 五、包结构

模块内**按功能分包**（feature-first），而不是全模块共用一套 controller / service / mapper。以 `mall-order` 为例：

```text
mall-order/src/main/java/com/qingyou/order/
├── api/                        对外暴露，其他模块只能用这里
│   ├── OrderQueryApi.java
│   └── OrderSummaryDTO.java
├── domain/                     订单模块内部共享的领域对象
│   ├── Order.java
│   ├── OrderItem.java
│   ├── OrderStatus.java
│   ├── OrderMapper.java
│   └── OrderItemMapper.java
├── place/                      下单
│   ├── PlaceOrderController.java
│   ├── PlaceOrderService.java      应用服务：计价、幂等处理
│   ├── PlaceOrderTxService.java    事务：扣库存、写订单与明细
│   └── PlaceOrderRequest.java
├── query/                      订单查询（实现 OrderQueryApi）
├── pay/                        支付单、支付回调、PayErrorCode
└── cancel/                     取消与超时关单
```

其他模块同理：`com.qingyou.inventory.api.InventoryApi`、`com.qingyou.product.api.ProductApi`、`com.qingyou.user.api.UserApi`；`mall-common` 的根包是 `com.qingyou.common`；启动类 `com.qingyou.MallApplication` 放在最顶层包，组件扫描能覆盖所有模块。

按功能分包的好处是改一个功能只动一个目录，功能内部的类可以用包私有可见性藏起来；按层分包与按功能分包的对比见 [工程结构与分包](/architecture/2_package_structure)。

---

## 六、依赖与构建

父 POM 继承 `spring-boot-starter-parent`，统一管理 Spring 生态的版本；内部模块和少量第三方库的版本集中写在 `dependencyManagement`，子模块引用时不写版本号：

```xml
<!-- qingyou-mall/pom.xml（节选） -->
<parent>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-parent</artifactId>
    <version>4.1.1</version> <!-- 取 4.x 最新补丁版 -->
</parent>

<groupId>com.qingyou</groupId>
<artifactId>qingyou-mall</artifactId>
<version>${revision}</version>
<packaging>pom</packaging>

<properties>
    <java.version>21</java.version>
    <revision>1.0.0-SNAPSHOT</revision>
</properties>

<modules>
    <module>mall-common</module>
    <module>mall-user</module>
    <module>mall-product</module>
    <module>mall-inventory</module>
    <module>mall-order</module>
    <module>mall-app</module>
</modules>

<dependencyManagement>
    <dependencies>
        <dependency>
            <groupId>com.qingyou</groupId>
            <artifactId>mall-common</artifactId>
            <version>${revision}</version>
        </dependency>
        <!-- mall-user / mall-product / mall-inventory / mall-order 同理 -->
    </dependencies>
</dependencyManagement>
```

几个约定：

- **用 Maven Wrapper**：本地和 CI 都执行 `./mvnw`，避免「我这能编过」
- **只有 `mall-app` 配 `spring-boot-maven-plugin`**：业务模块是普通 jar，只有启动模块打可执行 jar
- **Maven Enforcer 守底线**：`requireJavaVersion` 限定 21、`dependencyConvergence` 拦住同一个库多个版本、`banDuplicatePomDependencyVersions` 拦重复声明
- **新增第三方依赖要在 PR 里说明理由**：3 个人也会不知不觉引入三个 JSON 库

Maven 与 Gradle 的取舍见 [构建工具](/engineering/1_build_tools)，BOM、版本冲突与依赖升级的做法见 [依赖治理](/engineering/2_dependency_governance)。

---

## 七、开发规范与质量门禁

小团队没人专门做 Code Review 时，能交给机器的检查都交给机器，并且全部挂在 `./mvnw verify` 上，本地和 CI 跑的是同一套：

| 门禁 | 工具 | 拦什么 |
|------|------|--------|
| 格式 | Spotless（palantir-java-format） | 格式差异；`./mvnw spotless:apply` 一键修复，不在 Review 里争格式 |
| 规范 | Checkstyle | 命名、禁止通配符导入、禁止 `System.out` 等少量硬规则 |
| 架构边界 | ArchUnit | 跨模块引用 `api` 以外的包、模块间循环依赖 |
| 测试 | JUnit 5 + Testcontainers | 单元测试与带真实 MySQL 的集成测试 |

其中最关键的是 ArchUnit：模块化单体的边界如果只靠约定，赶工期时一定会被打穿。规则写成测试放在 `mall-app` 里（它能看到所有模块的类）：

```java
@AnalyzeClasses(packages = "com.qingyou", importOptions = ImportOption.DoNotIncludeTests.class)
class ModuleBoundaryTest {

    // 订单模块只能使用其他业务模块的 api 包
    @ArchTest
    static final ArchRule order_only_uses_api_of_other_modules =
            noClasses().that().resideInAPackage("com.qingyou.order..")
                    .should().dependOnClassesThat(
                            resideInAnyPackage("com.qingyou.product..", "com.qingyou.inventory..", "com.qingyou.user..")
                                    .and(not(resideInAPackage("com.qingyou.*.api.."))));

    // 业务模块之间不允许循环依赖
    @ArchTest
    static final ArchRule modules_free_of_cycles =
            slices().matching("com.qingyou.(*)..").should().beFreeOfCycles();
}
```

Spring Modulith 能按「顶层包即模块」自动推导同样的规则，模块多了以后可以换成它，见 [工程结构与分包](/architecture/2_package_structure)。各类质量工具的配置见 [代码质量](/engineering/3_code_quality)，命名、注释、异常处理等团队约定见 [开发规范](/devops/3_dev_standards)。

---

## 八、Git 与 CI

### 1、分支：主干开发

只有一个长期分支 `main`，功能分支一两天内合回；`main` 开启保护：必须走 PR、CI 通过、至少 1 人 Approve，统一 Squash 合并，提交信息用 Conventional Commits。3 个人没有理由维护 `develop` 和 `release/*`，分支模型的取舍见 [Git 工作流](/devops/1_git_workflow)。

### 2、流水线

GitHub Actions 两条流水线：

- **PR 检查**：`./mvnw -B verify`，包含格式、Checkstyle、ArchUnit、单元与集成测试，目标 10 分钟以内
- **合并到 `main`**：重新构建出 `mall-app.jar`，自动部署到测试环境；生产部署手动触发，逐台下线 → 替换 jar → `systemctl restart` → 健康检查通过后挂回负载均衡

```yaml
# .github/workflows/pr.yml（节选）
on: pull_request
jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-java@v4
        with:
          distribution: temurin
          java-version: '21'
          cache: maven
      - run: ./mvnw -B verify
```

流水线分阶段、制品管理与部署策略见 [CI/CD](/devops/4_ci_cd)。

---

## 九、配置与环境

三套环境：`dev`（本地）、`test`（一台测试机）、`prod`（两台生产机），配置文件全部放在 `mall-app/src/main/resources`：

```text
application.yml          公共配置
application-dev.yml      本地：连 docker compose 起的 MySQL
application-test.yml     测试环境
application-prod.yml     生产环境：只放非敏感项，如连接池大小、日志级别
```

**密钥不进仓库**：数据库密码、支付密钥等在配置里只写占位，由环境变量注入：

```yaml
# application-prod.yml
spring:
  datasource:
    url: jdbc:mysql://${DB_HOST}:3306/qingyou_mall
    username: ${DB_USERNAME}
    password: ${DB_PASSWORD}
```

生产机上用 systemd 的 `EnvironmentFile=/etc/qingyou-mall/env` 提供这些变量，文件权限 600、只有部署账号可读；本地开发用不提交的 `application-local.yml`（已加入 `.gitignore`）。CI 里另外加一步密钥扫描，防止有人误提交。

现在只有一个应用、三套环境，不需要配置中心；阶段三拆出多个服务、需要动态改配置时再引入。Profile、配置优先级与绑定见 [配置管理](/spring-boot/5_config)，环境划分与晋级见 [环境管理](/devops/6_env_management)。

---

## 十、代价与后续

模块化单体换来了上线速度，也留下了几个要在后面处理的问题：

- **边界只在代码层**：所有模块共用一个库，SQL 照样能跨模块 join。下一篇 [数据建模](./2_data_model) 会约定每张表归属一个模块、禁止跨模块 join 和跨模块直接写表
- **跨模块调用是本地方法 + 本地事务**：下单扣库存现在一个 `@Transactional` 就能保证一致，拆服务后不再成立，这是阶段三 [跨服务一致性](./7_consistency) 要解决的
- **一起构建、一起发布**：现在 3 个人没问题，扩到 20 人、4 个小组后会互相阻塞发布，这正是阶段三 [拆分服务](./6_split) 的触发点
- **只有两台机器、手工式部署**：够用但没有自动扩容和回滚编排，阶段三迁到 Kubernetes，发布流程在「可观测与发布」中重新设计

---

## 小结

- 3 人团队、20 QPS 的阶段选**模块化单体**：一个仓库、六个 Maven 模块、一个 jar，部署像单体，边界像服务
- 模块之间只走 `api` 包、单向依赖、无环，由 **ArchUnit 测试**在 CI 中强制，而不是靠约定
- 模块内按功能分包，父 POM 统一版本，Maven Wrapper + Enforcer 保证构建一致
- 主干开发 + PR 检查，格式、规范、架构、测试全部挂在 `./mvnw verify` 上
- 密钥走环境变量，不进仓库；Kubernetes、注册中心、消息队列、缓存都明确推迟到出现瓶颈的阶段

---

## 参考资料

- Spring Boot 多模块构建：[Creating a Multi Module Project](https://spring.io/guides/gs/multi-module/)
- Maven Wrapper：[Maven Wrapper](https://maven.apache.org/tools/wrapper/)
- Maven Enforcer 内置规则：[Built-In Rules](https://maven.apache.org/enforcer/enforcer-rules/index.html)
- ArchUnit 用户指南：[ArchUnit User Guide](https://www.archunit.org/userguide/html/000_Index.html)
- Spotless：[Spotless Maven Plugin](https://github.com/diffplug/spotless/tree/main/plugin-maven)
- Spring Modulith：[Spring Modulith Reference](https://docs.spring.io/spring-modulith/reference/)
- Martin Fowler：[MonolithFirst](https://martinfowler.com/bliki/MonolithFirst.html)

> 下一篇：[数据建模](./2_data_model) —— 订单、商品、库存的表设计、索引与事务边界
