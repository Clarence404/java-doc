---
description: 仓库布局、Maven 模块划分、按层与按功能分包、COLA 与 Modulith、对象归属、ArchUnit 守边界
---

# 工程结构与分包

> 前置阅读：[架构模式与风格](./1_arch_patterns)、[DDD 领域驱动设计](./2_ddd)、[构建工具](/engineering/1_build_tools)

工程结构决定了新人多久能找到代码、改一个需求要动几处、模块边界会不会被随手打穿。本篇从外到内讲仓库布局、模块划分、包结构、对象归属与边界校验，基线为 JDK 21、Spring Boot 4、Maven 3.9。

---

## 一、仓库布局

仓库根目录怎么摆，常见三种做法。下面的目录都取自真实开源项目，只列关键目录，以 2026 年 10 月仓库为准。

### 1、根目录即父工程，模块平铺

根目录就是 Maven 父工程（或 Gradle 根项目），各子模块直接平铺在根目录下。Java 项目绝大多数是这种布局，差别只在前端是否放在同一个仓库。

**ThingsBoard**（物联网平台，前端在同一仓库）：

```text
thingsboard/
├── pom.xml            # 父 POM
├── application/       # 主应用模块（自带 pom.xml）
├── common/            # 公共模块
├── dao/               # 数据访问
├── rule-engine/       # 规则引擎
├── transport/         # 各类设备接入协议
├── msa/               # 各服务的 Docker 镜像与黑盒测试
├── ui-ngx/            # Angular 前端，也是一个 Maven 模块
├── packaging/         # 安装包与部署脚本
└── tools/
```

**JetLinks 社区版**（物联网平台，前端不在本仓库）：

```text
jetlinks-community/
├── pom.xml
├── mvnw / .mvn/       # Maven Wrapper
├── jetlinks-components/   # 通用组件模块
├── jetlinks-manager/      # 各业务管理模块
├── jetlinks-standalone/   # 启动模块，打可执行 jar
├── simulator/         # 设备模拟器
├── docker/            # dev-env 与 run-all 两套环境编排
└── .run/              # 提交到仓库的 IDEA 运行配置
```

**Spring Boot 本身**（Gradle 多项目构建）：

```text
spring-boot/
├── settings.gradle    # 声明所有子项目
├── build.gradle
├── gradlew / gradle/  # Gradle Wrapper
├── buildSrc/          # 构建逻辑（自定义插件）
├── core/              # 核心模块
├── module/            # 各技术方向的模块
├── starter/           # 各 starter
├── loader/            # 可执行 jar 的加载器
├── smoke-test/        # 冒烟测试工程
└── documentation/
```

### 2、按语言分 backend/ 与 frontend/

**FastAPI 全栈模板**把前后端各放一个目录，根目录只放编排与公共配置：

```text
full-stack-fastapi-template/
├── backend/           # Python 后端
├── frontend/          # 前端
├── compose.yml        # 一键拉起全部服务
├── compose.override.yml
├── scripts/
└── .github/
```

这种布局适合没有「父工程」概念的技术栈（Python、Node），根目录只是一个容器。Java 项目若照搬，会变成 `backend/pom.xml` 下再平铺模块，IDE 里多一层嵌套，`mvn` 命令也要先 `cd backend`，收益不大。

### 3、前后端分仓库

**RuoYi-Vue** 的后端仓库只有 Java 代码，前端已拆到独立仓库（RuoYi-Vue3 等），仓库里不再有 `ruoyi-ui`。后端仓库内部仍是布局 1：

```text
RuoYi-Vue/
├── pom.xml
├── ruoyi-admin/       # 启动模块与 Controller
├── ruoyi-framework/   # 安全、数据源等框架配置
├── ruoyi-system/      # 系统管理业务
├── ruoyi-common/      # 公共工具
├── ruoyi-quartz/      # 定时任务
├── ruoyi-generator/   # 代码生成
├── sql/               # 初始化脚本
├── bin/ 与 ry.sh      # 启停脚本
└── doc/
```

### 4、根目录常见的辅助目录

| 目录 | 放什么 | 例子 |
|------|--------|------|
| `docker/` 或 `deploy/` | Dockerfile、Compose、K8s 清单 | JetLinks 的 `docker/` |
| `docs/` | 架构说明、ADR、接口文档 | RuoYi 的 `doc/` |
| `sql/` | 初始化脚本；迁移脚本更推荐放进模块的 `db/migration` 交给 Flyway | RuoYi 的 `sql/` |
| `.run/` | 提交到仓库的 IDEA 运行配置，新人克隆即可启动 | JetLinks 的 `.run/` |
| `scripts/` | 构建、发布、本地环境脚本 | FastAPI 模板的 `scripts/` |
| `simulator/` | 设备或外部系统模拟器，联调与压测用 | JetLinks 的 `simulator/` |

---

## 二、模块划分

### 1、从单模块到多模块

单模块（一个 `pom.xml`、一个 `src/`）能撑很久，包结构清楚就够了。出现下面的信号再拆成多模块：

- 接口契约（DTO、Feign 接口）要以 jar 形式给其他服务引用
- 需要靠编译器阻止「Controller 直接用 Mapper」这类越层调用，包约定已经守不住
- 同一套领域代码要被多个入口复用（Web 服务、定时任务、批处理）

### 2、典型模块与依赖方向

![模块依赖方向](../assets/architecture/module-dependency.svg)

| 模块 | 内容 | 依赖 |
|------|------|------|
| `xxx-common` | 真正通用的工具、常量、异常基类 | 无业务依赖 |
| `xxx-api`（或 `xxx-client`） | 对外 DTO、接口定义、错误码，不依赖 Spring Boot | `common` |
| `xxx-domain` | 实体、业务规则、仓储与网关接口 | `common`，可选 `api` |
| `xxx-infrastructure` | 仓储实现、Mapper、MQ、外部服务客户端 | `domain` |
| `xxx-server` | Controller、消费者、应用服务 | `domain`、`api` |
| `xxx-start`（或 `xxx-boot`） | 启动类、配置文件、装配 | `server`、`infrastructure` |

几条规则：

- **依赖只能单向**，禁止循环；`infrastructure` 依赖 `domain` 而不是反过来，这就是依赖倒置
- **只有启动模块打可执行 jar**，Boot 插件只配在它身上，其他模块是普通 jar
- **common 要瘦**：只放与业务无关、所有模块都要用的东西。「两个模块都用到」不是放进 common 的理由，否则它会变成谁都依赖、谁都不敢改的大杂烩
- 模块不是越多越好，小服务拆成 api + server + start 三个往往就够

父 POM、`dependencyManagement` 和 `-pl -am` 的用法见 [构建工具 · 多模块项目](/engineering/1_build_tools#六、多模块项目)。

---

## 三、包结构

### 1、按层分包与按功能分包

![三种分包方式](../assets/architecture/package-styles.svg)

| 方式 | 顶层包 | 优点 | 问题 |
|------|--------|------|------|
| 按层分包 | `controller` / `service` / `mapper` | 上手快，脚手架默认 | 改一个功能要跨多个包；所有类被迫 `public`；业务边界看不出来 |
| 按功能分包 | `order` / `user` / `payment` | 改动集中；可用包私有隐藏实现；模块边界清晰 | 功能内类多了会乱 |
| 混合：先功能后分层 | `order/web`、`order/app`、`order/domain` | 兼顾业务边界与层次，便于以后拆服务 | 包层级多一层 |

结论：**顶层按功能（业务模块）划分，模块内部再按层划分**。按层分包只适合十几个类的小工具。

### 2、常见问题

- **util / common 膨胀**：`util` 包里几十个类，一半只被一个功能用到；应把它们移回所属功能包
- **包之间循环依赖**：`order` 调 `user`，`user` 又调 `order`；用领域事件或抽出被依赖的接口打破循环
- **一切都是 public**：按层分包时 Service 实现类必须 `public` 才能被 Controller 用，任何人都能绕过接口直接调用
- **按技术名起包**：`redis`、`kafka` 这类包名应归到 `infrastructure` 之下，而不是与业务包并列

### 3、业界常见结构

**经典三层**：`controller` → `service` → `mapper`（或 `dao`），配合 `entity`、`dto` 包。RuoYi 等脚手架都是这种结构，适合 CRUD 为主的系统。

**阿里 COLA**：原型工程生成 `adapter`、`app`、`client`、`domain`、`infrastructure`、`start` 六个模块。`adapter` 相当于 Controller 层（按六边形架构改名），`client` 放对外 DTO 与接口，`domain` 通过网关（gateway）接口声明依赖，由 `infrastructure` 实现。原型的 POM 依赖是 `start → adapter → app → client / infrastructure`，`infrastructure → domain → client`。COLA 5 另提供基于包分层的轻量原型，不强制拆模块。

**六边形架构**：按端口与适配器分包，`application/port/in`（入站端口，即用例接口）、`application/port/out`（出站端口）、`adapter/in/web`、`adapter/out/persistence`。理论见 [架构模式与风格 · 六边形架构](./1_arch_patterns#三、六边形架构-ports-adapters)。

**DDD 四层**：`interfaces` / `application` / `domain` / `infrastructure`，完整的包结构示例见 [DDD · 包结构](./2_ddd#_1、包结构)，这里不再重复。

**Spring Modulith**：启动类所在包的**每个直接子包是一个应用模块**；模块根包里的公开类型是对外 API，模块下的任何子包（习惯命名为 `internal`）都视为内部实现，其他模块不能引用。需要额外暴露的子包用 `@NamedInterface` 标注。

```text
com.example.shop/
├── ShopApplication.java
├── order/                  # 应用模块：order
│   ├── OrderService.java   # 模块根包：对外 API
│   ├── OrderPlaced.java    # 对外发布的事件
│   └── internal/           # 内部实现，其他模块不可引用
│       ├── OrderRepository.java
│       └── OrderController.java
└── inventory/              # 应用模块：inventory
    ├── InventoryService.java
    └── internal/
```

---

## 四、对象放在哪

| 对象 | 含义 | 所在位置 | 谁来转换 |
|------|------|----------|----------|
| Request / DTO | 接口入参出参，带校验注解 | `api` 模块或 `web/dto` 包 | Controller 或应用服务 |
| VO | 返回给前端的展示对象 | `web/vo`，与 DTO 二选一即可 | Controller |
| Command / Query | 用例的入参，表达「做什么」「查什么」 | `app` 层 | Controller 由 DTO 转换 |
| BO / 领域对象 | 承载业务规则的实体、值对象 | `domain` 层 | 仓储实现负责与 PO 互转 |
| PO（DO / Entity） | 与表结构一一对应的持久化对象 | `infrastructure/persistence` | 仓储实现 |
| Event | 领域事件或集成事件 | 领域事件在 `domain`，对外发布的事件契约放 `api` | 发布方 |

- 转换只发生在**层边界**：Controller 把 DTO 转成 Command，仓储实现把领域对象转成 PO；PO 不能出 `infrastructure`，DTO 不能进 `domain`
- 字段多的转换用 MapStruct 在编译期生成映射代码，避免反射拷贝和手写遗漏
- 不必每层都有一套对象：CRUD 接口 DTO 直接映射 PO 也可以，类型名不同而字段完全相同的多层对象只是负担
- 名称各公司不一，阿里规约里 DO 指数据对象（即 PO），与「领域对象」容易混淆，团队内统一一套叫法即可，命名约定见 [开发规范 · 命名](/devops/3_dev_standards#二、命名)

---

## 五、包命名与可见性

### 1、包命名

- 格式：`com.<公司>.<产品>.<模块>`，全小写、单数，不用下划线或连字符：`com.example.mall.order`
- Maven 坐标与包名对齐：`groupId=com.example.mall`、`artifactId=mall-order-server`，看到 jar 名就能找到包
- 多模块时各模块包名前缀相同，后缀区分层：`com.example.mall.order.domain`、`com.example.mall.order.infrastructure`
- 启动类放在最顶层包，组件扫描与 Spring Modulith 都以它为根

### 2、包私有是最便宜的封装

Java 默认的包私有（不写访问修饰符）只允许同包访问。按功能分包后，把实现类、Mapper、内部 DTO 都设为包私有，只把接口和对外类型设为 `public`，编译器就能阻止其他功能直接使用内部类：

```java
package com.example.mall.order;

public interface OrderService {            // 对外：其他功能只能看到接口
    OrderView place(PlaceOrderCommand cmd);
}

@Service
class DefaultOrderService implements OrderService {   // 包私有：order 包外不可见
    // ...
}
```

Spring 扫描与注入不受包私有影响。按层分包做不到这一点，这也是推荐按功能分包的重要原因。

### 3、JPMS

JPMS（`module-info.java`）可以在模块级声明 `exports`，比包私有更强，但与 Spring 的反射、类路径扫描配合成本高，Spring Boot 应用里很少使用；需要模块边界时用多模块或 Spring Modulith 即可。

---

## 六、用工具守住边界

包结构的约定只写在文档里，几个月后就会被打穿。两种工具把约定写成测试，随 `mvn test` 执行：

**ArchUnit**：描述层与层之间允许的依赖，适合任意分包方式。

```java
@AnalyzeClasses(packages = "com.example.mall.order")
class ArchitectureTest {

    @ArchTest
    static final ArchRule layers = layeredArchitecture()
            .consideringOnlyDependenciesInLayers()
            .layer("Web").definedBy("..web..")
            .layer("App").definedBy("..app..")
            .layer("Domain").definedBy("..domain..")
            .layer("Infra").definedBy("..infrastructure..")
            .whereLayer("Web").mayNotBeAccessedByAnyLayer()
            .whereLayer("App").mayOnlyBeAccessedByLayers("Web")
            .whereLayer("Domain").mayOnlyBeAccessedByLayers("App", "Infra");
}
```

**Spring Modulith**：按上一章的约定识别模块，校验模块间无循环依赖、不引用其他模块的内部包：

```java
@Test
void verifyModules() {
    ApplicationModules.of(ShopApplication.class).verify();
}
```

依赖坐标、`FreezingArchRule` 渐进治理等细节见 [代码质量 · ArchUnit](/engineering/3_code_quality#五、archunit-把架构约定写成测试)，模块化单体的取舍见 [服务拆分 · 模块化单体](/microservices/1_service_split#_2、模块化单体)。

---

## 七、选型建议与模板

### 1、按规模选择

| 项目 | 仓库与模块 | 包结构 | 守边界 |
|------|------------|--------|--------|
| 小工具、脚手架 | 单模块 | 按层分包即可 | 不需要 |
| 中型单体 | 单模块或 api + server + start | 先功能后分层，实现类包私有 | ArchUnit |
| 模块化单体 | 单模块即可，模块用包表达 | Spring Modulith 约定：顶层包即模块、`internal` 放实现 | Modulith `verify()` |
| 微服务中的单个服务 | api（供调用方引用）+ server + start，复杂时再拆 domain / infrastructure | 先功能后分层；领域复杂时用 DDD 四层 | ArchUnit |

原则：**先用包划清边界，边界守不住或需要发布契约 jar 时再升级成模块**。模块拆得早、拆得细，换来的往往只是更长的构建时间和更多的 POM。

### 2、推荐模板

一个微服务从仓库根目录到包的完整结构：

```text
order-service/
├── pom.xml                         # 父 POM，packaging=pom
├── mvnw / .mvn/                    # Maven Wrapper
├── README.md
├── docs/                           # 架构说明、ADR
├── deploy/                         # Dockerfile、Compose、K8s 清单
├── .run/                           # 共享的 IDEA 运行配置
├── order-api/                      # 契约：可被其他服务引用
│   └── src/main/java/com/example/mall/order/api/
│       ├── OrderClient.java        # HTTP 接口声明
│       ├── dto/                    # 请求与响应 DTO
│       └── event/                  # 对外发布的事件契约
├── order-server/                   # 业务代码
│   └── src/main/java/com/example/mall/order/
│       ├── order/                  # 功能模块：订单
│       │   ├── web/                # Controller、MQ 消费者
│       │   ├── app/                # 应用服务、Command / Query
│       │   ├── domain/             # 实体、规则、仓储接口
│       │   └── infrastructure/     # 仓储实现、Mapper、PO
│       ├── refund/                 # 功能模块：退款，结构同上
│       └── shared/                 # 跨功能的公共内核，越少越好
└── order-start/                    # 启动与装配
    └── src/
        ├── main/java/com/example/mall/order/OrderApplication.java
        ├── main/resources/
        │   ├── application.yml
        │   └── db/migration/       # Flyway 迁移脚本
        └── test/java/.../ArchitectureTest.java
```

这个模板把业务代码放在一个 `order-server` 模块里，靠包和 ArchUnit 守层次；当领域足够复杂、需要编译期隔离时，再把 `domain`、`infrastructure` 抽成独立模块，包名不变，迁移成本很低。

---

## 小结

- Java 项目通常采用「根目录即父工程、模块平铺」的布局，差别只在前端是否同仓库；backend/frontend 分目录更适合没有父工程概念的技术栈
- 模块依赖单向，`infrastructure` 依赖 `domain`；只有启动模块打可执行 jar；common 保持精简
- 顶层按功能分包、功能内再分层，配合包私有隐藏实现
- DTO、Command、领域对象、PO 各在其层，转换只发生在层边界
- 约定要靠 ArchUnit 或 Spring Modulith 写成测试，否则一定会被打穿
- 先用包划边界，确有需要再升级为模块

## 参考资料

- Spring Modulith · Fundamentals：[https://docs.spring.io/spring-modulith/reference/fundamentals.html](https://docs.spring.io/spring-modulith/reference/fundamentals.html)
- ArchUnit User Guide：[https://www.archunit.org/userguide/html/000_Index.html](https://www.archunit.org/userguide/html/000_Index.html)
- Alibaba COLA：[https://github.com/alibaba/COLA](https://github.com/alibaba/COLA)
- ThingsBoard：[https://github.com/thingsboard/thingsboard](https://github.com/thingsboard/thingsboard)
- JetLinks Community：[https://github.com/jetlinks/jetlinks-community](https://github.com/jetlinks/jetlinks-community)
- Spring Boot 源码仓库：[https://github.com/spring-projects/spring-boot](https://github.com/spring-projects/spring-boot)
- Full Stack FastAPI Template：[https://github.com/fastapi/full-stack-fastapi-template](https://github.com/fastapi/full-stack-fastapi-template)
- RuoYi-Vue：[https://gitee.com/y_project/RuoYi-Vue](https://gitee.com/y_project/RuoYi-Vue)

> 下一篇：[幂等设计](./3_idempotence) —— HTTP 幂等语义与 Idempotency-Key，按插入、更新、消费、提交四类操作选方案，以及下单与支付回调的幂等落地。
