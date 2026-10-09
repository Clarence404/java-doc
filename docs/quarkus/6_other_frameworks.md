---
description: Micronaut、Helidon、Solon、Javalin 定位与现状、六种 Java 框架选型对比
---

# 其他 Java 框架

> **本篇目标**：了解 Spring Boot 与 Quarkus 之外常被拿来比较的 Java 后端框架——Micronaut、Helidon、Solon、Javalin——各自解决什么问题、代价是什么、当前版本状态如何；最后用一张表把六种框架放在一起，选型时心里有数。
>
> **前置阅读**：[Quarkus 概览](./1_basics)、[从 Spring Boot 迁移](./5_from_spring)

版本信息截至 2026 年 10 月。这几个框架都在快速演进，落地前请以官方发布页为准。

---

## 一、Micronaut

### 1、定位

Micronaut 最早由 Grails 团队（OCI）推出，现由 Micronaut Foundation 维护。它和 Quarkus 解决同一个问题——Spring 的运行期反射与扫描带来的启动慢、内存高——但路线不同：**Quarkus 靠构建工具插件在构建期增强，Micronaut 靠 Java 注解处理器在编译期生成代码**。

### 2、编译期依赖注入

`javac` 编译时，Micronaut 的注解处理器（Kotlin 用 KSP）为每个 Bean 生成 `BeanDefinition` 类，把「构造器是哪个、注入点在哪、有哪些注解元数据」全部写成普通 Java 代码。运行期：

- 不扫描类路径，不用反射读注解
- 不生成运行期代理，AOP 也在编译期生成子类
- 依赖缺失在编译期或启动时快速失败

```java
import io.micronaut.http.annotation.Controller;
import io.micronaut.http.annotation.Get;

@Controller("/orders")
public class OrderController {

    private final OrderService orderService;

    OrderController(OrderService orderService) {   // 构造器注入，编译期生成注入代码
        this.orderService = orderService;
    }

    @Get("/{id}")
    public OrderDto get(long id) {
        return orderService.find(id);
    }
}
```

注解风格刻意贴近 Spring（`@Controller`、`@Get`、`@Value`、`@Requires` 条件装配），Spring 开发者上手成本低。**`@Requires` 条件在运行期评估**，这一点比 Quarkus 的构建期条件更灵活。

### 3、AOT 与原生

- **Micronaut AOT**：构建期额外做一轮优化（预计算配置、替换服务加载、裁剪环境探测），进一步缩短启动
- **GraalVM 原生**：由于本来就没有运行期反射，原生镜像适配成本低，官方模块普遍支持原生
- **Micronaut Data**：在编译期把派生查询方法翻译成 SQL / JPQL，查询写错直接编译失败，运行期没有方法名解析开销

### 4、版本状态

- **Micronaut 5.0** 于 2026 年 5 月 GA，**Java 基线提升到 Java 25**，`micronaut-jackson-databind` 升级到 Jackson 3，移除 RxJava 2 支持
- 截至 2026 年 8 月底最新为 5.1.x；仍在 Java 17 / 21 上的项目只能停留在 4.x 线

### 5、适合谁

适合想要「类 Spring 的写法 + 低启动开销」、且能接受较小生态的团队；Serverless 函数、CLI 工具、对启动敏感的微服务是常见场景。国内社区和中文资料较少。

---

## 二、Helidon

### 1、定位

Helidon 是 Oracle 开源的微服务框架，提供两种编程模型：

| 风格 | 特点 |
|------|------|
| **Helidon SE** | 轻量、函数式路由，显式构建对象，没有注入魔法，依赖最少 |
| **Helidon MP** | 实现 MicroProfile 规范（CDI、Jakarta REST、Config、Health、Metrics、Fault Tolerance 等），写法接近 Jakarta EE / Quarkus |

### 2、Helidon 4：基于虚拟线程重写 Web 服务器

Helidon 4（2023 年 GA）是一次根本性的重写：**移除了基于 Netty 的响应式 WebServer / WebClient，替换为从零实现、基于虚拟线程的 Web 服务器**（开发代号 Níma）。带来的变化：

- Helidon SE 的 API 从异步响应式改为**阻塞式**：处理器里直接写同步代码，阻塞的只是虚拟线程
- 每个请求一个虚拟线程，不再有事件循环「不能阻塞」的约束，也不需要 Reactor / Mutiny 这样的响应式库
- 代价是 3.x 的 SE 代码需要改造才能迁移；Helidon 4 要求 Java 21+

这是主流 Java 框架中**最彻底地押注虚拟线程**的一个，对比 Vert.x / Quarkus「事件循环 + 可选虚拟线程」的路线很有参考意义。虚拟线程本身见 [虚拟线程](/java/30_topic_virtual_thread)。

### 3、版本状态

- **Helidon 4** 被定为 LTS，2026 年 9 月仍在发布 4.5.x 维护版本
- **Helidon 27.0.0**（2026 年 9 月）开始全面采用 JDK 的 Tip & Tail 模型：**版本号与 JDK 版本对齐，Helidon 27 要求最低 Java 27**；官方说明下一个 LTS 是 Helidon 29
- 生产选型时，追求稳定选 4.x LTS，愿意跟随最新 JDK 的再考虑 27 及之后的版本

### 4、适合谁

Oracle 技术栈（Oracle Database、OCI）用户、希望用 MicroProfile 规范又不想要应用服务器的团队，以及想用最纯粹的「虚拟线程 + 同步代码」模型的场景。国内使用面很小。

---

## 三、Solon

### 1、定位

Solon 是国产开源 Java 应用开发框架（Apache-2.0，主仓库在 GitHub `opensolon/solon`，同时托管在 Gitee），官网口号是「克制、高效、开放」。它的设计取向有几个关键点：

- **不基于 Spring、不基于 Servlet、不依赖 Jakarta EE**，有自己的接口标准和插件体系；Web 层用自己的 `Context` 对象代替 `HttpServletRequest` / `HttpServletResponse`
- **IoC / AOP / MVC 的概念与 Spring 一致，注解名不同**，Spring 开发者理解成本低
- **Java 版本跨度大**：官方声明兼容 Java 8 到最新 JDK，并支持 GraalVM 原生运行

### 2、和 Spring 的注解对照

| 用途 | Solon | Spring Boot |
|------|-------|-------------|
| 按类型注入 | `@Inject` | `@Autowired` |
| 按名称注入 | `@Inject("name")` | `@Qualifier` + `@Autowired` |
| 注入配置值 | `@Inject("${name}")` | `@Value("${name}")` |
| 绑定配置集合 | `@BindProps(prefix = "x")` | `@ConfigurationProperties(prefix = "x")` |
| 组件 | `@Component` | `@Component` / `@Service` / `@Repository` |
| 配置类与 Bean | `@Configuration` + `@Bean` | 同名 |
| 控制器与映射 | `@Controller` + `@Mapping` | `@RestController` + `@RequestMapping` 系列 |
| 初始化 / 销毁 | `@Init` / `@Destroy` | `@PostConstruct` / `@PreDestroy` |
| 启动完成事件 | `AppLoadEndEvent` | `ApplicationRunner` |

```java
import org.noear.solon.Solon;
import org.noear.solon.annotation.Controller;
import org.noear.solon.annotation.Mapping;
import org.noear.solon.annotation.Param;
import org.noear.solon.annotation.SolonMain;

@SolonMain
public class App {
    public static void main(String[] args) {
        Solon.start(App.class, args);
    }
}

@Controller
class DemoController {
    @Mapping("/hello")
    public String hello(@Param(defaultValue = "world") String name) {
        return String.format("Hello %s!", name);
    }
}
```

几个与 Spring 不同、迁移时要注意的细节：`@Mapping` 一个方法只能映射一个路径且只对 `public` 方法生效；只有注册了拦截器的 `public` 方法才会被代理；组件默认不按类名注册名称，需要显式命名。

### 3、性能与生态宣传

官网与 README 给出的宣传数据是：并发高 700%（引用 TechEmpower plaintext 测试）、内存节省 50%、启动快 10 倍、打包小 90%。这些是**项目方自述**，对比基线与测试条件没有在首页说明，选型时应当用自己的业务做压测，不要直接引用。

生态方面（官网数据，2026 年 10 月，当前版本 v4.1.1）：

- 约 130 名贡献者，GitHub + Gitee 合计约 7.1K Star，官网称近半年下载量 1200 万+
- 子项目覆盖 Web、数据访问、调度、远程调用、Solon Cloud（微服务）、Solon Flow（流程编排）、Solon AI（含 MCP 支持）、原生 AOT 等
- 官网列出的用户包括美团、快手、格力、中国移动、中国电科等企业（未给出具体使用规模）

### 4、信创适配

Solon 在开源社区宣传中把「为应用软件国产化提供支持、助力信创建设」作为卖点，其依据主要是：自主的接口标准、不依赖国外商业框架、支持 Java 8 这类在部分信创环境中仍常见的老版本 JDK。

需要说清楚的是：**本文未查到 Solon 官方公开发布的、与具体国产操作系统、数据库、中间件的兼容性认证清单**。信创项目里能否使用，仍要以甲方的产品名录与兼容性测试要求为准；框架本身是纯 Java，与国产 OS / CPU 的适配主要取决于所用的 JDK 发行版。

### 5、适合谁

- 对国产化有要求、或希望减少对 Spring 生态依赖的项目
- 资源受限的部署环境（小内存容器、边缘设备），需要轻量框架
- 仍然运行在 Java 8 上、短期无法升级 JDK 的系统

代价是生态规模、第三方集成、招聘与资料量都明显小于 Spring；大型团队引入前要评估长期维护与人员培养成本。

---

## 四、Javalin

Javalin 是一个**极简的 Web 框架**，而不是全栈框架：只提供路由、请求上下文、中间件、WebSocket、SSE 等 Web 能力，基于 Jetty 内嵌服务器，同时支持 Java 与 Kotlin。

- **没有依赖注入、没有自动配置、没有 ORM**，对象怎么创建、数据库怎么连都由你自己决定
- 当前为 7.x 线（截至 2026 年 10 月最新 7.2.3），7.0 起要求 Java 17+、迁移到 Jetty 12
- 代码量少、心智负担低、启动快，适合内部工具、小型 API、原型、教学，或作为嵌入到其他程序里的 HTTP 端口

服务规模变大、需要事务、配置管理、可观测性等能力时，往往要自己补齐，这时选全栈框架更合适。

---

## 五、选型对比

### 1、六种框架一览

| 维度 | Spring Boot | Quarkus | Micronaut | Helidon | Solon | Vert.x |
|------|-------------|---------|-----------|---------|-------|--------|
| 核心机制 | 运行期扫描 + 反射，Spring AOT 可选 | 构建期增强 | 编译期注解处理 | SE 函数式 / MP 规范；虚拟线程 Web 服务器 | 自有 IoC，启动时一次扫描 | 事件循环工具包，非框架 |
| JVM 模式启动 | 较慢（CDS / AOT 缓存可改善） | 快 | 快 | 快 | 快 | 很快 |
| 原生镜像 | 支持，适配成本中 | 一等公民 | 一等公民 | 支持 | 支持 | 支持 |
| 生态 | 最大，事实标准 | 大，扩展丰富 | 中 | 小 | 中，国内为主 | 中，偏底层组件 |
| 学习曲线 | 低（人人会） | 中：CDI、Jakarta REST、构建期概念 | 低到中：类 Spring | 中：SE 简单、MP 需懂规范 | 低：概念同 Spring | 高：异步、事件循环、回调与 Future |
| 国内社区 | 极大 | 小 | 小 | 很小 | 中，中文资料为主 | 小 |
| 最低 JDK | 4.x：17 | 3.x：17；4.x：21 | 5.x：25 | 4.x：21；27：27 | 8 | 5.x：11（虚拟线程需 21） |
| 典型场景 | 绝大多数业务系统 | 云原生微服务、Serverless、K8s 高密度部署 | Serverless、函数、CLI、类 Spring 轻量服务 | Oracle 技术栈、MicroProfile、纯虚拟线程模型 | 国产化项目、轻量服务、Java 8 存量系统 | 网关、长连接、高并发 I/O 组件、底层平台 |

Vert.x 的定位与模型见 [Vert.x 概览](/vertx/1_basics)。

### 2、怎么选

- **默认选 Spring Boot**：生态、人才、资料、国内中间件支持都是压倒性优势；启动与内存问题先用 CDS / AOT 缓存、虚拟线程、原生镜像在 Spring 内部解决
- **冷启动或内存是硬指标**，且团队愿意接受新的编程模型：Quarkus（生态更大）或 Micronaut（写法更像 Spring）
- **国产化、Java 8 存量、轻量部署**：可以评估 Solon，但要用自己的场景做压测与长期维护评估
- **网关、推送、IoT 接入等 I/O 密集组件**：Vert.x 或 [Netty 总览](/netty/0_overview)，而不是全栈框架
- **小工具、原型、嵌入式 HTTP 端口**：Javalin 这类极简框架足够
- **Oracle 生态或想要纯虚拟线程模型**：Helidon

### 3、常见误区

- **只看启动时间选型**：启动快在 Serverless 和弹性扩缩场景才是核心收益，对长期运行的服务影响有限；峰值吞吐、可观测性、生态成熟度通常更重要
- **把框架自述的基准数据当结论**：TechEmpower 等测试场景与真实业务差异很大，以自己的业务压测为准
- **以为换框架就能解决性能问题**：多数业务系统的瓶颈在数据库、缓存、下游调用和代码本身，见 [高性能总览](/high-perf/0_overview)
- **一个组织里框架过多**：每多一种框架，就多一套脚手架、规范、监控接入和排障经验；引入新框架应当有明确边界

---

## 小结

- Micronaut 用编译期注解处理实现无反射的 DI 与 AOP，写法接近 Spring；5.x 以 Java 25 为基线
- Helidon 分 SE 与 MP 两种风格，4.x 起 Web 服务器基于虚拟线程重写、API 改为阻塞式；4.x 为 LTS，27 起版本号与 JDK 对齐
- Solon 是国产轻量框架，不依赖 Spring / Servlet / Jakarta EE，概念同 Spring、注解不同，支持 Java 8 起的各版本；性能数据为官方自述，信创适配需按项目要求自行验证
- Javalin 是只管 Web 的极简框架，适合小工具与原型
- 默认选 Spring Boot；冷启动和内存是硬指标时考虑 Quarkus / Micronaut；I/O 密集组件用 Vert.x / Netty；国产化与 Java 8 存量可评估 Solon

## 参考资料

- Micronaut 发布公告：[https://micronaut.io/category/release-announcements/](https://micronaut.io/category/release-announcements/)
- Micronaut 5（Java 25 基线）：[https://micronaut.io/category/micronaut-5/](https://micronaut.io/category/micronaut-5/)
- Helidon 发布记录：[https://github.com/helidon-io/helidon/releases](https://github.com/helidon-io/helidon/releases)
- Solon 官网：[https://solon.noear.org/](https://solon.noear.org/)
- Solon 与 Spring Boot 对比：[https://solon.noear.org/article/compare-springboot](https://solon.noear.org/article/compare-springboot)
- Solon GitHub：[https://github.com/opensolon/solon](https://github.com/opensolon/solon)
- Javalin 发布记录：[https://github.com/javalin/javalin/releases](https://github.com/javalin/javalin/releases)

> 返回：[Quarkus 总览](./0_overview)
