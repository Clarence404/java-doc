---
description: 构建期增强、ArC、Dev Services、REST 线程模型、Panache、Mutiny、原生镜像、迁移选型
---

# Quarkus 面试题解答

> 题目清单见 [Quarkus 面试题](/quarkus/99_interview)；细节见 [Quarkus 总览](/quarkus/0_overview)。
>
> 版本基线：Quarkus 3.40 LTS（Quarkus 4 的变化单独说明）、JDK 21 / 25、Mandrel / GraalVM 25。

## 一、构建期增强与 CDI / ArC

### Q1：Quarkus 为什么启动快？构建期增强是什么？

**一句话**：Spring Boot 每次启动都要扫描类路径、解析注解、生成代理，Quarkus 把这些活挪到构建期做一次，录成字节码，运行期只回放结果，所以启动快、内存低。

- 增强（Augmentation）：`javac` 之后多一个阶段，由扩展的 `@BuildStep` 读 Jandex 索引（构建期生成的类与注解目录）、决定生成什么字节码
- Recorder：把「启动时调哪些初始化方法、传什么参数」录成字节码，启动时直接执行
- 内存低：注解解析器、条件评估器这些只在构建期用的类不进运行期
- 代价一：Bean 图构建期就定了，未被注入的 Bean 默认移除，运行期动态注册基本行不通
- 代价二：部分配置（如 `quarkus.datasource.db-kind`）构建期固化，运行时改了不生效，配置参考里带锁图标的就是

→ 详见 [Quarkus 概览](/quarkus/1_basics#一、为什么启动快-构建期增强)

### Q2：Quarkus 扩展和 Spring Boot Starter 有什么区别？没有扩展的库能用吗？

**一句话**：Starter 只管「引依赖 + 自动配置」，扩展还要负责让这个库适配构建期增强和原生镜像；没有扩展的库在 JVM 模式照样能用，只是享受不到构建期优化，做原生镜像时往往要手工登记反射。

- 扩展分两个模块：`runtime` 进运行期，`deployment` 只在构建期执行、不进制品
- 扩展的额外工作：把库的初始化挪到构建期、登记反射、替换不兼容原生镜像的代码
- 版本统一由平台 BOM `quarkus-bom` 管，作用同 `spring-boot-dependencies`
- 选型先查 code.quarkus.io 和 Quarkiverse（社区扩展仓库）有没有对应扩展；社区扩展版本号独立，升级 Quarkus 时要一起检查

→ 详见 [Quarkus 概览](/quarkus/1_basics#二、扩展-extension)

### Q3：ArC 和 Spring IoC 有什么区别？有哪些常见坑？

**一句话**：ArC 是 Quarkus 自带的 CDI Lite 实现，Bean 发现和依赖校验都在构建期完成，缺 Bean 或有歧义直接构建失败，而不是等到启动才报错。

| 维度 | Spring IoC | ArC |
|------|-----------|-----|
| Bean 发现 | 运行期扫描 | 构建期 Jandex 索引 |
| 依赖校验 | 启动时 | 构建期 |
| 代理 | CGLIB 运行期生成 | 构建期生成字节码 |
| 未使用的 Bean | 全部创建 | 默认移除 |

- 没加作用域注解的类不是 Bean；`@ApplicationScoped` 是懒加载 + 客户端代理（调用经代理转发），`@Singleton` 无代理
- 私有字段注入要走反射，官方推荐包级可见字段或构造器注入

**常见坑**：`@ApplicationScoped` 第一次调用才创建，要启动即初始化得监听 `StartupEvent` 或加 `@Startup`；只靠 `CDI.current().select(...)` 动态查找的 Bean 会被当作未使用移除，要加 `@Unremovable`。

→ 详见 [Quarkus 概览](/quarkus/1_basics#_2、和-spring-ioc-的关键差异)

### Q4：Dev Mode、持续测试和 Dev Services 分别是什么？

**一句话**：这是 Quarkus 开发体验的三件套：改完代码下一次请求就热重载、后台只重跑受影响的测试、引入扩展不配地址就自动用容器拉起数据库或 Kafka。

- Dev Mode：`quarkus dev`，下一次 HTTP 请求触发重新编译和增强，一秒级；不是 JVM HotSwap，能改方法签名、加类
- 持续测试：Dev Mode 终端按 `r` 开启；`@QuarkusTest` 启动一次应用在测试类间复用
- Dev Services：底层是 Testcontainers，只在 dev / test 模式生效，配了连接地址就不再启动
- 生产地址用 `%prod.` 前缀写，dev / test 不配，两边互不干扰

**常见坑**：CI Runner 没有 Docker 时 Dev Services 起不来，测试直接失败；要么给 Runner 配 Docker，要么在 CI Profile 里显式配外部服务地址。

→ 详见 [Quarkus 概览](/quarkus/1_basics#五、dev-services)

## 二、REST、Panache 与响应式

### Q5：Quarkus REST 的端点跑在哪个线程上？什么时候用虚拟线程？

**一句话**：请求先由 Vert.x 事件循环（I/O 线程）接收，Quarkus REST 在构建期按方法签名决定后续线程：同步返回值走 Worker 线程，返回 `Uni` / `Multi` 留在 I/O 线程。

| 签名 / 注解 | 执行线程 |
|------------|----------|
| 返回 POJO、`String`、`RestResponse<T>` | Worker 线程 |
| 返回 `Uni`、`Multi`、`CompletionStage` | I/O 线程 |
| `@Blocking` / `@Transactional` | Worker 线程 |
| `@NonBlocking` | I/O 线程 |
| `@RunOnVirtualThread` | 虚拟线程（只对阻塞签名生效） |

- 返回 `Uni` 的方法里不能调 JDBC、`Thread.sleep`，否则卡住整个事件循环；Hibernate ORM 在 I/O 线程上会直接拒绝执行
- 普通 CRUD 用同步签名最省心；下游阻塞调用多、Worker 池常打满时用虚拟线程（最好 JDK 24+，解决 `synchronized` 钉住）
- 虚拟线程不限并发，打到数据库的并发靠连接池上限或信号量兜住

→ 详见 [REST 与数据访问](/quarkus/2_rest_data#_2、端点跑在哪个线程上)

### Q6：Panache 的 Active Record 和 Repository 怎么选？`@Transactional` 和 Spring 有什么异同？

**一句话**：Active Record 让实体直接带静态查询方法，代码最少；Repository 把查询放到单独的 Bean，便于 Mock 和分层。事务注解用 `jakarta.transaction.Transactional`，语义和 Spring 基本一致。

- 实体字段写 `public` 没问题：Panache 构建期把字段访问改写成 getter / setter，懒加载和脏检查照常工作
- Active Record 的静态方法要 `quarkus-panache-mock` 才能 Mock；Repository 是普通 Bean，`@InjectMock` 即可
- Panache 不改变 Hibernate 的抓取语义，N+1 仍要 `join fetch`；生产表结构用 Flyway / Liquibase 管
- 事务：默认运行时异常回滚、受检异常不回滚；同类自调用不经过拦截器，同样失效
- 分批提交用 `QuarkusTransaction.requiringNew().run(...)`，单批失败只回滚本批

**常见坑**：Quarkus Data（原 Panache Next）目前还是实验性扩展，生产暂不建议用。

→ 详见 [REST 与数据访问](/quarkus/2_rest_data#四、hibernate-orm-with-panache)、[事务](/quarkus/2_rest_data#五、事务)

### Q7：Mutiny 和 Reactor 有什么区别？有了虚拟线程还需要响应式吗？

**一句话**：Mutiny 的 `Uni` / `Multi` 对应 Reactor 的 `Mono` / `Flux`，区别在 API 按事件分组（先选 `onItem()` / `onFailure()` 再选动作）、操作符更少；请求-响应式的业务优先用同步写法 + 虚拟线程，流式处理和消息管道才用 Mutiny。

- Uni 是惰性的：每订阅一次就重新执行一次，同一个 Uni 被用两次要加 `memoize()`，否则下游被调两次
- Mutiny 不自己切线程：阻塞调用用 `runSubscriptionOn(...)` 卸到 Worker 池（相当于 `subscribeOn`），否则直接跑在事件循环上
- 响应式的代价：异常栈不连续、调试难，而且要全链路非阻塞驱动
- 虚拟线程的短板：没有原生背压、不擅长 SSE 这类无限流，并发要自己限

→ 详见 [响应式与消息](/quarkus/4_reactive#一、mutiny-quarkus-的响应式-api)、[虚拟线程](/quarkus/4_reactive#四、虚拟线程-响应式之外的选择)

### Q8：Quarkus 消费 Kafka 怎么保证不丢不停？ack、commit、失败策略分别管什么？

**一句话**：业务代码只负责 ack / nack，什么时候真正提交 offset 由提交策略决定；默认 `throttled` 只提交连续确认的最大 offset，所以没确认的消息重启后会重投，消费端必须幂等。

- ack：接收 payload 或 `Record` 时方法正常返回就 ack、抛异常就 nack；接收 `Message<T>` 时要自己调 `ack()`
- commit：`throttled` 周期性提交，某条消息超过 60 秒未确认，连接器会被标记为不健康
- 失败策略：默认 `fail` 一条毒消息就让整个通道停摆，生产改为有限重试 + `dead-letter-queue`
- 线程：`@Incoming` 默认在 I/O 线程，阻塞逻辑要加 `@Blocking` / `@Transactional` / `@RunOnVirtualThread`；吞吐不够加 `concurrency`，不要关顺序保证
- 生产：`Emitter.send` 返回的 `CompletionStage` 要处理失败；「写库 + 发消息」一致性仍要 Outbox

→ 详见 [响应式与消息](/quarkus/4_reactive#_3、确认-ack-与提交-commit)

## 三、原生镜像、迁移与选型

### Q9：为什么 Quarkus 做原生镜像比 Spring 顺？哪些情况仍要手工处理？

**一句话**：`native-image` 要求构建期就知道所有反射、代理和资源（闭世界假设），Quarkus 的扩展本来就在构建期处理这些元数据，登记是扩展的分内工作，用官方扩展的应用一般不用手写 `reflect-config.json`。

- 要手工登记的三类：未出现在 REST 端点签名里的序列化类、无扩展且用反射的第三方库、`Class.forName` 动态加载
- 登记方式：`@RegisterForReflection`（第三方类用 `targets` 集中登记）；自定义资源用 `quarkus.native.resources.includes`
- Quarkus 默认构建期初始化所有类：`static final` 里的时间戳会变成构建时间，静态块读环境变量读到的是构建机的值
- 静态字段持有 `Random`、线程、连接会构建失败，要改懒加载或 `--initialize-at-run-time`

**常见坑**：这些问题 JVM 模式下完全不出现，必须跑原生集成测试（`./mvnw verify -Dnative`）才能发现；JSON 输出 `{}` 往往就是漏了反射登记。

→ 详见 [原生镜像与云原生部署](/quarkus/3_native#二、反射与资源登记)、[构建期初始化](/quarkus/3_native#三、构建期初始化与运行期初始化)

### Q10：JVM 模式和原生模式怎么选？

**一句话**：冷启动敏感、高密度部署选原生；长期运行、高吞吐的核心服务留在 JVM 模式，因为 JIT 预热后峰值吞吐更高、诊断工具也全。

| 维度 | JVM 模式 | 原生模式 |
|------|----------|----------|
| 启动 | 秒级以内 | 毫秒级 |
| 峰值吞吐 | 高（JIT 按运行画像优化） | 通常更低 |
| GC / 诊断 | G1、ZGC、JFR、Arthas 全套 | 默认 Serial GC，工具受限 |
| 构建与兼容 | 快，任何库都能用 | 慢、吃内存，反射要登记 |

- 适合原生：Serverless / FaaS、CLI、大量小流量内部服务
- 只想改善启动又不想背原生约束：JVM 模式 + AOT 缓存（JDK 25）
- 务实路径：先 JVM 模式上线拿到构建期增强的大部分收益，再挑冷启动敏感的服务原生化；具体数字以自己的压测为准

→ 详见 [原生镜像与云原生部署](/quarkus/3_native#六、jvm-模式还是原生模式)

### Q11：从 Spring Boot 迁到 Quarkus 怎么做？Spring 兼容扩展能帮多少？

**一句话**：兼容扩展不启动 Spring 容器，只在构建期把 Spring 注解翻译成 CDI / Jakarta REST 的等价物，是过渡工具；推荐「先兼容跑通、再逐模块替换成原生 API」。

- 兼容层的边界：`BeanPostProcessor` 等 Spring 基础设施不执行，任何 Starter、自定义自动配置都不生效，`@Conditional` 被忽略
- 迁移步骤：评估依赖 → 兼容扩展跑通 → 逐模块替换 → 配置与测试迁移 → JVM 模式灰度 → 视收益原生化
- AOP 改成 CDI 拦截器：只能按注解绑定，没有 `execution(...)` 切点表达式，自调用同样不生效
- 不值得迁：深度依赖 Spring Cloud Alibaba / Spring Batch、强依赖没有 Quarkus 扩展的国内中间件 SDK、启动和内存本来就不是瓶颈

**常见坑**：兼容扩展对不支持的注解属性静默不生效、也不报错，不要依赖它的边缘特性。

→ 详见 [从 Spring Boot 迁移](/quarkus/5_from_spring#二、spring-兼容扩展)、[什么时候迁](/quarkus/5_from_spring#五、什么时候迁-什么时候不迁)

### Q12：Quarkus、Spring Boot、Micronaut、Helidon 怎么选？

**一句话**：默认选 Spring Boot；冷启动或内存是硬指标、团队愿意换编程模型时，选 Quarkus（生态更大）或 Micronaut（写法更像 Spring）；Oracle 技术栈或想要纯虚拟线程模型选 Helidon。

| 框架 | 核心机制 | 最低 JDK |
|------|----------|----------|
| Spring Boot | 运行期扫描 + 反射，AOT 可选 | 4.x：17 |
| Quarkus | 构建期增强（构建插件） | 3.x：17；4.x：21 |
| Micronaut | 编译期注解处理器生成代码 | 5.x：25 |
| Helidon | SE 函数式 / MP 规范，虚拟线程 Web 服务器 | 4.x：21 |

- Micronaut 的 `@Requires` 条件在运行期评估，比 Quarkus 的构建期条件灵活
- Helidon 4 去掉了 Netty 响应式服务器，改成每请求一个虚拟线程、API 改为阻塞式
- 只看启动时间选型是误区：对长期运行的服务影响有限，峰值吞吐、可观测性、生态更重要

→ 详见 [其他 Java 框架](/quarkus/6_other_frameworks#五、选型对比)
