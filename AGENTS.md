# java-doc 知识库总览

> Java 后端技术知识体系文档站，基于 VuePress 构建，覆盖从基础原理到系统架构的完整知识图谱。
> 定位：开发总结 + 工程实践参考手册。

---

## 项目结构

```
docs/
├── ai/             AI：框架 / RAG / Agent / MCP / API 接入 / 工具
├── algorithms/     算法与数据结构
├── architecture/   系统架构 / DDD / 幂等 / 访问控制
├── cache/          缓存：Redis / Caffeine
├── cloud-native/   云原生：Linux / Docker / Kubernetes / VPS
├── database/       数据库：MySQL / 列存 / 分布式 / 时序 / 文档 / 搜索
├── devops/         DevOps：Git 工作流 / CI/CD / Code Review / 团队规范
├── distributed/    分布式理论 / 锁 / 事务 / 会话
├── engineering/    工程效率：构建 / 工具链 / 代码质量 / 线上诊断 / API 规范
├── high-avail/     高可用：限流 / 熔断 / 降级
├── high-con/       高并发：JUC / 线程池 / 系统设计
├── interview/      开发总结（各方向高频问题汇总）
├── iot/            物联网：基础 / 协议 / 开源平台
├── java/           Java 8+ 语言特性
├── jvm/            JVM 原理与调优
├── messaging/      消息队列：Kafka / RocketMQ / RabbitMQ
├── microservices/  微服务：概念 / 拆分 / 组件 / 模式
├── netty/          IO 模型 / Reactor / Netty / WebSocket / SSE
├── observability/  可观测性：日志 / 指标 / 链路追踪 / 告警 / OpenTelemetry
├── patterns/       设计模式（23 种 GoF）
├── protocols/      协议体系：网络通信 / IoT / 远程调用 / 安全 / 文件 / 数据库 / 邮件 / 分布式
├── scenario/       业务场景：大数据
├── security/       安全体系：认证授权 / API 安全 / 数据安全 / 漏洞防护 / 零信任
├── spring/         Spring Framework / WebFlux / Security
├── spring-boot/    Spring Boot / Flyway
└── testing/        测试体系：单元测试 / Mock / 集成测试 / TDD
```

---

## 模块索引

| 模块 | 路径 | 覆盖主题 |
|------|------|----------|
| 面试专题 | `docs/interview/` | Java / DB / 缓存 / JVM / Spring / MQ 高频题 |
| Java 特性 | `docs/java/` | Java 8–21 核心新特性 |
| JVM | `docs/jvm/` | 内存结构 / 类加载 / GC / 调优 |
| 算法 | `docs/algorithms/` | 数据结构 / 搜索 / 排序 / DP / LeetCode |
| 设计模式 | `docs/patterns/` | 23 种 GoF 模式 |
| Spring | `docs/spring/` | IoC / AOP / WebFlux / Security |
| Spring Boot | `docs/spring-boot/` | 自动配置 / Flyway 数据迁移 |
| 测试体系 | `docs/testing/` | 单元测试 / Mock / 集成测试 / TDD |
| Netty | `docs/netty/` | IO 模型 / Reactor / WebSocket / SSE |
| 分布式 | `docs/distributed/` | CAP / Raft / 分布式锁 / 事务 |
| 高并发 | `docs/high-con/` | JUC / 线程池 / 压测 / Profiler |
| 高可用 | `docs/high-avail/` | 限流 / 熔断 / 降级 |
| 消息队列 | `docs/messaging/` | Kafka / RocketMQ / RabbitMQ |
| 微服务 | `docs/microservices/` | 拆分 / 注册发现 / 网关 / 模式 |
| 数据库 | `docs/database/` | MySQL / 分库分表 / 各类 NoSQL |
| 缓存 | `docs/cache/` | Redis / Caffeine / 两级缓存 |
| 系统架构 | `docs/architecture/` | 架构设计 / DDD / 幂等 / 对象存储 |
| 业务场景 | `docs/scenario/` | 大数据场景方案 |
| 云原生 | `docs/cloud-native/` | Linux 运维 / Docker / Kubernetes / Helm / VPS |
| DevOps | `docs/devops/` | Git 工作流 / CI/CD / Code Review / 团队规范 |
| 工程效率 | `docs/engineering/` | 构建工具 / 开发工具 / 代码质量 / 线上诊断 / API 规范 |
| 可观测性 | `docs/observability/` | 日志 / 指标 / 链路追踪 / 告警 / OpenTelemetry |
| 协议体系 | `docs/protocols/` | TCP/UDP / HTTP / IoT 协议 / gRPC / TLS / 数据库协议 |
| 安全体系 | `docs/security/` | 认证授权 / API 安全 / 数据安全 / 漏洞防护 / 零信任 |
| IoT | `docs/iot/` | 物联网架构 / 协议 / 开源平台 |
| AI | `docs/ai/` | Spring AI / LangChain4j / RAG / Agent / MCP / API 接入 / AI 工具 |

---

## 推荐学习路径

```
基础层：  Java 特性 → JVM → 算法 → 设计模式
框架层：  Spring → Spring Boot → Netty
数据层：  数据库 → 缓存 → 消息队列
分布式层：分布式理论 → 高并发 → 高可用 → 微服务
架构层：  系统架构 → 业务场景
运维层：  云原生 → DevOps → 工程效率 → 可观测性 → 协议体系 → 安全体系
新兴层：  IoT → AI
面试：    interview/ 各专题汇总复习
```

---

## 文档约定

- 文件命名：`数字_主题.md`，数字前缀决定侧边栏顺序，全部使用下划线分隔
- 文件夹命名：全小写，多单词使用连字符（kebab-case），如 `cloud-native`、`spring-boot`
- 图片存放：`docs/assets/<模块名>/`
- 待补充内容用 VuePress `warning` callout 标记：`> [!warning] 待补充`
- 参考链接放文章顶部，便于溯源
- 站点部署：GitHub Actions → `.github/workflows/deploy-docs.yml`
