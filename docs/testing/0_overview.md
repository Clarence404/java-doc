---
description: 测试金字塔与蜂巢、各层工具与版本基线、健康测试套件的标准、CI 中的测试分工
---

# 测试工程总览

测试工程关心的不是「写没写测试」，而是一套测试能不能在每次提交时快速、稳定地回答一个问题：**这次改动能不能放心合并、放心上线**。本模块按测试层次展开：先写好不依赖任何外部环境的单元测试，再用 Mock 隔离协作者，用真实容器做集成测试，用契约测试守住服务间接口，最后用性能测试验证容量；TDD 一篇讲怎样让测试反过来驱动设计。

本模块写的是与框架无关的测试方法和工具。几类相关内容各有主文档，这里只链接：Spring 的切片测试、`@MockitoBean`、`@ServiceConnection` 在 [Spring Boot 测试](/spring-boot/13_testing)；JMH 微基准在 [基准测试（JMH）](/high-perf/4_benchmark)；覆盖率门禁的阈值与 Sonar 配置在 [代码质量](/engineering/3_code_quality)；流水线怎么编排在 [CI/CD](/devops/2_ci_cd)。

![测试金字塔与测试蜂巢](../assets/testing/overview-test-pyramid-honeycomb.svg)

版本基线（2026 年 10 月）：

| 类别 | 工具 | 版本与说明 |
|------|------|------------|
| 运行环境 | JDK / Spring Boot | JDK 21（25 为新 LTS）；Spring Boot 4.x（Spring Framework 7） |
| 测试框架 | JUnit | **JUnit 6**（2025-09 发布 6.0，当前 6.1.x）；Java 17 基线，Platform / Jupiter / Vintage 版本号统一，包名仍是 `org.junit.jupiter.*`；Spring Framework 7 以 JUnit 6 为最低要求，Boot 4.1 依赖管理为 6.0.x |
| 断言 | AssertJ | 3.27.x（Boot 4.1 管理 3.27.7） |
| Mock | Mockito | 5.x（Boot 4.1 管理 5.23.0，独立最新 5.24.0） |
| 集成测试 | Testcontainers | **2.0.x**（Boot 4.1 管理 2.0.5）；artifact 统一加 `testcontainers-` 前缀，移除 JUnit 4 支持 |
| 契约测试 | Spring Cloud Contract / Pact JVM | Spring Cloud Contract 5.0.x（随 Spring Cloud 2025.1）；Pact JVM 4.7.x |
| 性能测试 | k6 / Gatling / JMeter | k6 2.x（2026-05 发布 2.0）；Gatling 3.x（Java DSL）；JMeter 5.6.3 |
| 质量度量 | JaCoCo / PIT | JaCoCo 0.8.14+（支持 Java 25）；PIT 1.x + `pitest-junit5-plugin`（JUnit 6 下可用） |

::: tip 版本由谁管
Spring Boot 项目里，JUnit、AssertJ、Mockito、Testcontainers 的版本都由 Boot 依赖管理统一控制，不要再单独导入 JUnit BOM 或写死版本号，否则升级 Boot 时容易出现 Platform 与引擎版本不一致。非 Boot 的纯 Java 模块才需要自己导入 `junit-bom`。
:::

---

## 一、模块导航

<ModuleNav />

---

## 二、推荐阅读路径

按测试层次从下往上读：

1. [单元测试](./1_unit_test)：JUnit 6 编程模型、参数化与嵌套测试、AssertJ、好测试的标准、时间与随机数、测试数据构建器
2. [Mock 测试](./2_mock)：测试替身分类、Mockito 5、参数捕获、静态方法 Mock、Mock 过度的反模式
3. [集成测试](./3_integration_test)：集成测试的边界、外部依赖替代方案、测试数据管理、Flaky 治理、Surefire / Failsafe 分工
4. [Testcontainers](./5_testcontainers)：容器生命周期、等待策略、单例与复用、2.x 依赖变化
5. [契约测试](./6_contract_test)：消费者驱动契约、Spring Cloud Contract、Pact 与 can-i-deploy
6. [性能测试](./7_performance_test)：测试类型、开放与封闭负载模型、k6 / Gatling / JMeter
7. [TDD 测试驱动开发](./4_tdd)：红-绿-重构、两种流派、遗留代码引入测试

TDD 编号靠前，但它要求先熟悉单元测试与 Mock，放在最后读更容易落地。Spring 项目读完前三篇后接着读 [Spring Boot 测试](/spring-boot/13_testing)。

复习时用 [高频面试题](./99_interview) 自测，答案在 [测试工程面试题解答](/interview/20_testing)。

---

## 三、测试分层与比例

### 1、各层测什么

| 层次 | 测什么 | 典型工具 | 单个用例耗时 | 失败时能说明什么 |
|------|--------|----------|--------------|------------------|
| 单元测试 | 单个类 / 方法的业务规则、边界与异常 | JUnit 6、AssertJ、Mockito | 毫秒级 | 精确到某条规则 |
| 切片测试 | Spring 帮你做的事：参数绑定、校验、序列化、Repository 查询 | `@WebMvcTest`、`@DataJpaTest` | 百毫秒到秒级（上下文可缓存） | 某一层的配置或映射 |
| 集成测试 | 跨进程边界：真实 SQL 方言、事务、MQ 收发、缓存 | `@SpringBootTest` + Testcontainers、WireMock | 秒级（含容器启动） | 组件协作或中间件用法 |
| 契约测试 | 服务之间的请求 / 响应格式是否兼容 | Spring Cloud Contract、Pact | 秒级 | 哪个接口字段被破坏 |
| 端到端测试 | 部署好的整套系统上的关键业务流程 | Playwright、REST Assured | 秒到分钟级 | 「某处坏了」，定位要靠日志与链路 |
| 性能测试 | 吞吐、延迟分位数、容量拐点 | k6、Gatling、JMeter | 分钟到小时级 | 容量与瓶颈，不判断功能对错 |

### 2、金字塔还是蜂巢

- **测试金字塔**（Mike Cohn）：底层单元测试最多，越往上越少。适合业务规则复杂、计算逻辑多的服务，比如计价、风控、库存分配，规则的组合用单元测试穷举最划算
- **测试蜂巢**（Spotify 提出）：中间的集成测试最多，两头少。适合「本身逻辑不多、主要在调用别的服务和中间件」的微服务，这类服务的风险集中在 SQL、序列化、超时与重试上，Mock 掉这些依赖的单元测试反而什么都证明不了
- **测试奖杯**（Kent C. Dodds，源自前端）：静态检查打底、集成测试为主，思路与蜂巢相近

形状只是结果，真正的判断标准是**每类风险由最便宜、又真能发现它的那一层来覆盖**：

- 折扣叠加顺序错了 → 单元测试
- `@RequestBody` 字段名映射错了 → 切片测试
- MySQL 和 H2 的分页语法不一致 → 集成测试（用真实 MySQL 容器）
- 上游把 `amount` 从数字改成字符串 → 契约测试
- 下单链路整体能不能走通 → 少量端到端冒烟

### 3、几条分层原则

- **能不启动 Spring 就不启动**：构造器注入的类直接 `new` 出来测，比任何 Spring 测试都快，见 [Spring Boot 测试](/spring-boot/13_testing) 第一节
- **数据库用真实的，不用 H2 冒充**：Testcontainers 让真实数据库的成本降到可以接受，H2 的兼容模式会掩盖方言差异
- **端到端只留关键路径**：E2E 用例慢且脆，一个流程一两条冒烟即可，分支组合交给下层
- **不在多层重复测同一件事**：单元测试已经穷举了折扣规则，集成测试只需验证「规则被调用、结果被正确落库」

---

## 四、健康测试套件的标准

### 1、可信：失败就一定有问题

- **确定性**：同样的代码跑一百次结果一样。时间、随机数、线程调度、端口、执行顺序是不确定性的主要来源，单元测试里的处理方法见 [单元测试](./1_unit_test) 第六节，集成测试里的 Flaky 治理见 [集成测试](./3_integration_test)
- **Flaky 测试零容忍**：一个时好时坏的测试会让团队养成「失败了就重跑」的习惯，真正的失败也会被重跑掉。发现后要么当天修复，要么隔离并建工单，不能放任
- **断言行为而不是实现**：测试只关心输入和可观察的输出，重构内部实现不应导致测试失败

### 2、快：反馈时间有预算

| 阶段 | 建议预算 | 包含的测试 |
|------|----------|------------|
| 本地保存 / 提交前 | 秒级 | 当前模块的单元测试 |
| PR 流水线 | 10 分钟以内 | 全部单元、切片、集成、契约测试 |
| 合并后 / 夜间 | 不限，但要有人看结果 | 端到端、性能基线、变异测试 |

套件变慢时先看三件事：Spring 上下文是否被频繁重建（[Spring Boot 测试](/spring-boot/13_testing) 第八节）、容器是否每个测试类都重启（[Testcontainers](./5_testcontainers)）、是否有 `Thread.sleep` 等待异步结果（改用 Awaitility）。

### 3、覆盖率只是信号

- 覆盖率回答的是「哪些代码**没被执行过**」，不回答「执行过的代码有没有被正确验证」，没有断言的测试照样能刷到 100%
- 全站统一口径：**合并门槛只看 Sonar 质量门禁的新代码覆盖率（≥ 80%）**，JaCoCo `check` 只做只升不降的整体底线，整体覆盖率看趋势不设硬目标，配置与理由见 [代码质量](/engineering/3_code_quality)
- 想知道测试的断言是否有力，用变异测试（PIT）抽查核心模块，见 [单元测试](./1_unit_test) 第八节

---

## 五、测试在 CI 中的位置

流水线的编排（触发条件、Job 依赖、缓存、分支保护）在 [CI/CD](/devops/2_ci_cd)，这里只说各类测试放在哪一步：

| 阶段 | 运行的测试 | 构建命令 / 工具 | 失败的后果 |
|------|------------|-----------------|------------|
| `mvn test` | 单元测试、切片测试（`*Test`） | Maven Surefire | PR 不能合并 |
| `mvn verify` | 集成测试（`*IT`），JaCoCo 报告 | Maven Failsafe + Testcontainers | PR 不能合并 |
| 质量门禁 | 新代码覆盖率、静态检查 | SonarQube | PR 不能合并 |
| 发布前 | 契约验证、`can-i-deploy` | Pact Broker / Spring Cloud Contract | 阻止部署 |
| 部署到预发后 | 端到端冒烟 | Playwright / REST Assured | 阻止晋级生产 |
| 夜间 / 版本前 | 性能基线、变异测试 | k6 / Gatling、PIT | 出报告，回归时建工单 |

Surefire 与 Failsafe 的分工及配置见 [构建工具](/engineering/1_build_tools)。GitHub Actions 的 Ubuntu Runner 自带 Docker，Testcontainers 可以直接运行，不需要额外配置 Docker-in-Docker。

---

## 六、关联模块

- Spring 测试支持（切片测试、`MockMvcTester`、`@MockitoBean`、`@ServiceConnection`、上下文缓存）→ [Spring Boot 测试](/spring-boot/13_testing)
- 微基准测试 → [基准测试（JMH）](/high-perf/4_benchmark)；性能分析方法论 → [性能分析方法论](/high-perf/2_methodology)；容量规划与全链路压测 → [容量评估与规划](/high-con/8_capacity_planning)
- 故障注入与混沌实验 → [混沌工程](/high-avail/10_chaos_engineering)
- 覆盖率门禁、JaCoCo、Sonar、ArchUnit → [代码质量](/engineering/3_code_quality)
- Surefire / Failsafe 与 Maven 生命周期 → [构建工具](/engineering/1_build_tools)
- 流水线中的测试阶段与质量门禁 → [CI/CD](/devops/2_ci_cd)；评审时怎么看测试 → [Code Review](/devops/3_code_review)
- 测试数据构建器的模式基础 → [建造者模式](/patterns/4_creational_builder)

---

## 参考资料

- JUnit 6 用户指南：[JUnit User Guide](https://docs.junit.org/current/user-guide/)
- JUnit 发布说明：[JUnit Release Notes](https://docs.junit.org/current/release-notes/)
- Spring Boot 测试文档：[Testing](https://docs.spring.io/spring-boot/reference/testing/index.html)
- AssertJ：[AssertJ Documentation](https://assertj.github.io/doc/)
- Mockito：[Mockito](https://site.mockito.org/)
- Testcontainers for Java：[Testcontainers](https://java.testcontainers.org/)
- 测试金字塔：[The Practical Test Pyramid（Martin Fowler 网站）](https://martinfowler.com/articles/practical-test-pyramid.html)
- 测试蜂巢：[Testing of Microservices（Spotify Engineering）](https://engineering.atspotify.com/2018/01/testing-of-microservices)
- Spring Cloud Contract：[Spring Cloud Contract](https://spring.io/projects/spring-cloud-contract)
- Pact：[Pact Docs](https://docs.pact.io/)
- k6：[Grafana k6 Documentation](https://grafana.com/docs/k6/latest/)
- PIT 变异测试：[PIT Mutation Testing](https://pitest.org/)

> 下一篇：[单元测试](./1_unit_test)
