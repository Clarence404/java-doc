# 测试体系概览

> 参考资料：
> * JUnit 5 官方文档：[https://junit.org/junit5/docs/current/user-guide/](https://junit.org/junit5/docs/current/user-guide/)
> * Spring Boot Testing：[https://docs.spring.io/spring-boot/docs/current/reference/html/testing.html](https://docs.spring.io/spring-boot/docs/current/reference/html/testing.html)

## 一、测试分层

| 层次 | 类型 | 工具 | 关注点 |
|------|------|------|--------|
| 单元测试 | Unit Test | JUnit 5 / Mockito | 单个类 / 方法的逻辑正确性 |
| 集成测试 | Integration Test | Spring Test / TestContainers | 多组件协作、数据库、消息队列 |
| 接口测试 | API Test | MockMvc / RestAssured | HTTP 接口行为验证 |
| 端到端测试 | E2E Test | Selenium / Playwright | 完整业务流程 |
| 契约测试 | Contract Test | Pact / Spring Cloud Contract | 服务间接口兼容性 |
| 性能测试 | Performance Test | JMeter / k6 / Gatling | 容量、吞吐、响应时间 |

## 二、测试原则

- **F**ast：测试应快速执行
- **I**ndependent：测试之间互不依赖
- **R**epeatable：任何环境下结果一致
- **S**elf-validating：自动判断通过 / 失败
- **T**imely：与生产代码同步编写（FIRST 原则）

## 三、覆盖率参考

| 级别 | 覆盖率 | 说明 |
|------|--------|------|
| 基础 | 60% | 核心业务逻辑有测试 |
| 良好 | 80% | 大部分分支覆盖 |
| 优秀 | 90%+ | 包含边界条件和异常路径 |

> [!warning]
> 待补充

## 四、后续专题

- [Testcontainers](./5_testcontainers)：用真实中间件做集成测试
- [契约测试](./6_contract_test)：降低服务间接口变更风险
- [性能测试](./7_performance_test)：建立容量评估和瓶颈分析方法
