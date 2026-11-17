---
description: Conduit IoT 定位与版本进度、一条上报的全过程、接入与业务分进程、控制面与数据面、模块结构、系列路线
---

# 平台实战概览

> 前置阅读：[通信协议](../1_basics/1_protocol)、[平台选型](../1_basics/2_platform)、[MQTT 客户端](../2_access/3_mqtt_client)

前面各篇讲协议、选型和单点的接入写法，本系列用配套仓库 Conduit IoT 把它们串成一个能跑的多租户物联网平台，按「问题、设计决定、关键代码、怎么验证、已知限制」的顺序讲。本篇讲 Conduit 的定位与进度、一条上报的全过程、进程划分、代码结构和系列路线，基线为 JDK 21、Spring Boot 3.5。

---

## 一、Conduit 是什么

Conduit IoT 是一个开源的多租户物联网平台，面向工业、能源、园区这类「大量设备周期性上报测点」的场景。现在跑通的主链路是：设备用 MQTT 直连，平台鉴权、接收、按物模型校验，写入时序库，网页上看最新值和历史曲线。

| 设定 | 取值 |
|------|------|
| 仓库 | [`conduit-iot`](https://github.com/Clarence404/conduit-iot)，Maven 多模块，根包 `dev.conduit` |
| 本系列对应的提交 | [`811e441`](https://github.com/Clarence404/conduit-iot/tree/811e441)，文中的代码与文档链接都固定在这个提交上 |
| 后端 | JDK 21、Spring Boot 3.5（3.5.6）、MyBatis-Plus、Flyway、HiveMQ MQTT Client |
| 前端 | Vue 3、TypeScript、Element Plus、ECharts |
| 基础设施 | EMQX 5.10、Redis 7、PostgreSQL 16、InfluxDB 3 Core |
| 进程 | `conduit-transport`（接入，8081）、`conduit-server`（业务，8080）、`conduit-simulator`（设备模拟器） |
| 部署 | Docker Compose，开发环境包、独立部署包、EMQX 与应用分机三种 |

它和站内另外两个配套仓库不一样：[项目演进](/project/0_overview) 的 mall-evolution 与 [AI 应用实战概览](/ai/7_practice/0_intro) 的 mall-assistant 是按章节设计的练习仓库，每章有起点和答案；Conduit 是按版本往前做的真实项目，没有练习标签。所以本系列不带着写代码，而是读它已经做完的部分：当时遇到什么问题、为什么这样定、代码在哪、凭什么说它是对的、还差什么。

仓库的三类文档是本系列的主要依据，读代码前先知道它们在哪：

| 目录 | 内容 |
|------|------|
| [`docs/superpowers/specs/`](https://github.com/Clarence404/conduit-iot/tree/811e441/docs/superpowers/specs) | 每个版本动手前写的设计文档，记录范围、数据模型、取舍 |
| [`docs/test-reports/`](https://github.com/Clarence404/conduit-iot/tree/811e441/docs/test-reports) | 每次改动的测试报告：跑了什么命令、结果多少、哪些没测 |
| [`docs/roadmap-saas.md`](https://github.com/Clarence404/conduit-iot/blob/811e441/docs/roadmap-saas.md) | 当前生效的路线图，写明已有能力、差距和各阶段的完成门槛 |

---

## 二、做到哪一版

Conduit 的目标是生产级多租户 IoT SaaS，但路线图自己写得很清楚：这是目标，不是现状，生产就绪以各阶段验收和测试报告为准。到本系列对应的提交为止，已经做完的部分如下。

| 版本 | 做了什么 | 设计文档 | 本系列 |
|------|---------|---------|--------|
| V0.1 | 主链路：设备注册与凭据、MQTT 接入、总线、流水线、时序库、最新值页面 | [v0.1-design](https://github.com/Clarence404/conduit-iot/blob/811e441/docs/superpowers/specs/2026-10-14-conduit-v0.1-design.md) | [设备接入与鉴权](./1_access)、[数据流水线](./4_pipeline) |
| V0.2-A | 物模型逐测点校验、可插拔解码器 | [v0.2a-thing-model-design](https://github.com/Clarence404/conduit-iot/blob/811e441/docs/superpowers/specs/2026-10-15-conduit-v0.2a-thing-model-design.md) | [物模型与解码](./2_thing_model) |
| V0.2-B | 历史查询与曲线，按时间范围自动聚合 | [v0.2b-history-design](https://github.com/Clarence404/conduit-iot/blob/811e441/docs/superpowers/specs/2026-10-15-conduit-v0.2b-history-design.md) | [时序存储与历史查询](./5_telemetry) |
| V0.2-C | 多租户与用户管理，平台管理员进入租户代为操作 | [v0.2c-tenants-users-design](https://github.com/Clarence404/conduit-iot/blob/811e441/docs/superpowers/specs/2026-10-16-conduit-v0.2c-tenants-users-design.md) | [多租户与授权](./6_tenant) |
| V0.2-R | 可靠性加固：transport 单活多备，端到端故障测试 | [v0.2r-reliability-design](https://github.com/Clarence404/conduit-iot/blob/811e441/docs/superpowers/specs/2026-10-16-conduit-v0.2r-reliability-design.md) | [可靠上报与接入层主备](./3_reliable_uplink) |
| V0.2-R2 | 端到端可靠上报：设备带消息 id，收到平台业务回执才删本地副本 | [reliable-uplink-design](https://github.com/Clarence404/conduit-iot/blob/811e441/docs/superpowers/specs/2026-10-20-conduit-reliable-uplink-design.md) | [可靠上报与接入层主备](./3_reliable_uplink) |
| V0.2-R3 | 遥测重放：把总线里保留的原始报文重新写入时序库 | [telemetry-replay-design](https://github.com/Clarence404/conduit-iot/blob/811e441/docs/superpowers/specs/2026-10-20-conduit-telemetry-replay-design.md) | [数据流水线](./4_pipeline)、[时序存储与历史查询](./5_telemetry) |
| V0.3-A | 租户隔离加固：组合外键、跨租户查询收口、越权测试 | [tenant-isolation-design](https://github.com/Clarence404/conduit-iot/blob/811e441/docs/superpowers/specs/2026-10-22-conduit-tenant-isolation-design.md) | [多租户与授权](./6_tenant) |
| V0.3-B1～B3 | 客户 / 项目 / 站点 / 资产组织模型，预置与自定义角色、范围授权，邮件邀请与可吊销会话 | [organization-rbac-design](https://github.com/Clarence404/conduit-iot/blob/811e441/docs/superpowers/specs/2026-10-26-conduit-v0.3b-organization-rbac-design.md) | [多租户与授权](./6_tenant) |
| 接入链路调整 | EMQX 改用内存持久会话，主 transport 多连接共享订阅，微批写总线 | [session-wedge-fix-design](https://github.com/Clarence404/conduit-iot/blob/811e441/docs/superpowers/specs/2026-10-28-conduit-emqx-session-wedge-fix-design.md)、[shared-subscription-design](https://github.com/Clarence404/conduit-iot/blob/811e441/docs/superpowers/specs/2026-10-29-conduit-transport-shared-subscription-design.md) | [可靠上报与接入层主备](./3_reliable_uplink)、[压测与瓶颈排查](./10_capacity) |

路线图第 1 节给自己划了边界，近期**不做**的有三样：通用低代码平台、消息中间件、支付系统。另外有几项是评估后明确决定不做或暂缓的，原因都记在路线图里：

- **PostgreSQL 行级安全（RLS）不实施**：租户隔离留在应用层（`tenant_id` 列加 MyBatis-Plus 租户拦截器），并写明了重新评估的触发条件
- **CI 暂不做**：单人开发，合并前的全量测试由流程保证
- **租户级密码策略与 MFA 预留不实施**

写明「不做什么、为什么」和写明「做了什么」同样有用：读代码时看到某处没有，能分清是漏了还是定了不做。

---

## 三、一条上报的全过程

![Conduit IoT 架构：设备经 EMQX 接入，鉴权回调同步走 server，数据经 transport 与 Redis Streams 异步进入流水线](../../assets/iot/conduit-architecture.svg)

以一台三相电表上报 `{"ts":1760400000000,"params":{"Ua":220.1,"Ia":5.2}}` 为例，从设备发出到页面显示经过八步：

| 步 | 发生在哪 | 做什么 | 哪一篇展开 |
|----|---------|--------|-----------|
| 1 | 设备 → EMQX → server | 设备 CONNECT，EMQX 同步回调 server 的 `/internal/mqtt/auth`，拿到 allow 才放行 | [设备接入与鉴权](./1_access) |
| 2 | 设备 → EMQX | QoS 1 发布到 `conduit/{productKey}/{deviceKey}/up/property`，EMQX 按 ACL 检查 topic | [设备接入与鉴权](./1_access) |
| 3 | EMQX → transport | 主 transport 以共享订阅收到消息，解析 topic 得到产品、设备、消息类型，组装成 `RawMessage`，payload 原样不动 | [可靠上报与接入层主备](./3_reliable_uplink) |
| 4 | transport → Redis | 攒成微批 `XADD` 到 `conduit:stream:up`，写成功后才回 PUBACK；报文带 `id` 时再给设备发一条业务回执 | [可靠上报与接入层主备](./3_reliable_uplink) |
| 5 | Redis → server | 流水线以消费组 `conduit-server` 拉取一批 | [数据流水线](./4_pipeline) |
| 6 | server | 查设备身份，按产品取解码器与物模型，解码后逐测点校验 | [物模型与解码](./2_thing_model) |
| 7 | server → InfluxDB、Redis | 合格测点批量写 InfluxDB 的 `property` 表，再用 Lua 脚本更新最新值，最后 `XACK` | [时序存储与历史查询](./5_telemetry) |
| 8 | 浏览器 → server | 设备详情页调 `GET /api/v1/devices/{deviceKey}/latest`，每 5 秒刷新；「历史」标签页查 InfluxDB | [时序存储与历史查询](./5_telemetry)、[多租户与授权](./6_tenant) |

这条链路的可靠性靠一条简单的规矩：**每一跳都是下游确认之后才确认上游**。transport 写进 Redis 才回 PUBACK，server 写完时序库和最新值才 `XACK`。任何一个进程中途崩溃，消息还留在上一跳（EMQX 的会话队列或 Stream 的待确认列表）里，恢复后重新投递。代价是消息可能重复，由存储侧吸收：InfluxDB 里同设备同时间戳的点覆盖为同样的值，最新值按时间戳比较，旧值盖不掉新值。

出问题的消息有两种去向，流水线只认这两种：

- **消息本身有问题**（JSON 不合法、设备不存在、测点不符合物模型）：写进死信流 `conduit:stream:dead` 并确认，不重试
- **下游暂时不可用**（InfluxDB、Redis、PostgreSQL 连不上）：不确认，原地从 1 秒退避到 30 秒反复重试

设备上下线不需要设备自己报：EMQX 的连接、断开事件发布在 `$SYS` 系统 topic 上，transport 一并订阅，走同一条总线进 server。

---

## 四、为什么接入与业务分成两个进程

把 MQTT 客户端直接写在业务服务里是最省事的做法，[MQTT 客户端](../2_access/3_mqtt_client) 里的示例就是这样。Conduit 从 V0.1 起就拆成 `conduit-transport` 与 `conduit-server` 两个进程，两者之间**没有代码依赖**，只共用 `conduit-common` 里的一个消息格式和一个总线接口。

```java
// conduit-common：协议无关的原始消息，transport 只负责组装，业务解析在 server 完成
public record RawMessage(String productKey, String deviceKey, MessageType type, byte[] payload,
                         long receivedAt, Map<String, String> attributes) { ... }

public interface MessageBus {
    List<PublishResult> publish(List<RawMessage> messages);                 // transport 调
    List<Delivery> read(String group, String consumer, int count, Duration block);   // server 调
    List<Delivery> claimStale(String group, String consumer, Duration minIdle, int count);
    void ack(String group, List<String> ids);
    void recordDead(Delivery delivery, String reason, Map<String, String> details);
    // 另有单条 publish、ensureGroup、deadLetter、range
}
```

代码见 [`RawMessage`](https://github.com/Clarence404/conduit-iot/blob/811e441/conduit-common/src/main/java/dev/conduit/common/message/RawMessage.java)、[`MessageBus`](https://github.com/Clarence404/conduit-iot/blob/811e441/conduit-common/src/main/java/dev/conduit/common/bus/MessageBus.java)。这样拆换来四件事：

| 好处 | 说明 |
|------|------|
| server 慢或重启不堵接入 | 设备数据从不直连 server。server 重启期间消息在 Redis 里排队，恢复后接着处理；EMQX 那边 PUBACK 照常返回 |
| 加协议不动业务 | transport 只搬运字节，不解析业务内容。新增 HTTP、Modbus TCP 接入就是新增一个 `ProtocolAdapter` 实现，输出同样的 `RawMessage` |
| 解码留在业务侧 | 解码要按产品查物模型、选解码器，属于业务逻辑，放 server；transport 不需要连 PostgreSQL |
| 两边各自做高可用 | transport 是单活多备（Redis 锁选主），server 靠消费组，多个实例天然分摊消息 |

`MessageBus` 是接口，当前实现是 [`RedisStreamMessageBus`](https://github.com/Clarence404/conduit-iot/blob/811e441/conduit-common/src/main/java/dev/conduit/common/bus/RedisStreamMessageBus.java)；接口注释里写的是「后续可替换为 Kafka / RabbitMQ」，V0.1 选 Redis Streams 是因为 Redis 本来就要用（最新值、在线状态、身份缓存），少运维一个组件。消费组、ACK、待确认列表的通用用法见 [Redis 典型应用场景](/cache/4_redis_scenario)。

拆开也有代价，都记在仓库的已知限制里：

- **多一跳，多一个关键依赖**：Redis 不可用时 transport 不回 PUBACK，消息排在 EMQX 的内存会话队列里，队列满了就丢
- **总线有长度上限**：上行流按 `MAXLEN ~ 1000000` 近似裁剪，server 长时间不消费时，超出的旧条目会被裁掉
- **两个进程两个时钟**：`receivedAt` 取 transport 的时钟，入库延迟指标用 server 的时钟相减，分机部署时这个指标里含时钟差

---

## 五、控制面与数据面

`conduit-server` 只有一个进程，但有两个性质完全不同的入口，图里标作 ① 和 ②。

| | ① 鉴权回调（控制面） | ② 数据流水线（数据面） |
|---|---|---|
| 谁调用 | EMQX，HTTP 同步回调 | server 自己从 Redis Streams 拉 |
| 频率 | 每次连接一次 | 每条上报一次 |
| 时效 | 设备在等 CONNACK，EMQX 侧超时 10 秒 | 异步，积压了晚点处理 |
| server 不可用时 | 新设备连不上；已连接的设备不受影响，照常上报 | 消息在 Redis 里排队，恢复后继续 |
| 入口代码 | [`MqttAuthController`](https://github.com/Clarence404/conduit-iot/blob/811e441/conduit-server/src/main/java/dev/conduit/server/mqttauth/MqttAuthController.java) | [`PipelineWorker`](https://github.com/Clarence404/conduit-iot/blob/811e441/conduit-server/src/main/java/dev/conduit/server/pipeline/PipelineWorker.java)、[`PipelineProcessor`](https://github.com/Clarence404/conduit-iot/blob/811e441/conduit-server/src/main/java/dev/conduit/server/pipeline/PipelineProcessor.java) |

这个划分决定了故障时的表现：server 挂掉的那几十秒，在线设备的数据一条不丢，只是页面上的值暂时不更新；只有恰好在这段时间重连的设备会被拒绝，重连几次后恢复。把「必须同步」的事压到最少（只有鉴权），其余全部走异步，是这套架构能扛住 server 重启的原因。

第三个入口是给前端用的 REST API（图中 ③），登录、产品、设备、物模型、历史查询都在这里，带 JWT 和租户隔离，见 [多租户与授权](./6_tenant)。

---

## 六、模块与代码结构

```text
conduit/
├── conduit-common/        RawMessage、MessageBus 接口与 Redis Streams 实现
├── conduit-transport/     接入层（8081）
│   ├── adapter/           ProtocolAdapter 接口
│   ├── mqtt/              MQTT 适配器、topic 解析、微批、业务回执
│   ├── leader/            Redis 锁选主，只有主实例连接 EMQX
│   └── monitor/           经 EMQX REST API 监控自己的会话
├── conduit-server/        业务（8080），按领域分包
│   ├── mqttauth/          EMQX 鉴权回调
│   ├── pipeline/          流水线：消费、解码、校验、重试、死信
│   ├── thingmodel/        物模型属性、导入导出、按产品缓存
│   ├── telemetry/         InfluxDB 写入与历史查询、最新值
│   ├── presence/          在线状态
│   ├── product/ device/   产品、设备、凭据
│   ├── tenant/ auth/ authorization/ organization/   租户、登录、授权、组织
│   └── replay/            遥测重放
├── conduit-simulator/     设备模拟器，也是可靠上报的参考实现
├── conduit-e2e/           端到端故障测试（-Pe2e 时才构建）
├── conduit-ui/            Vue 3 前端
├── deploy/                dev / standalone / split 三套 Compose
└── docs/                  设计文档、测试报告、路线图、接入指南
```

模块依赖只有三条：transport 依赖 common，server 依赖 common，e2e 依赖 simulator。server 内部按业务领域分包而不是按 controller / service / mapper 分层，一个领域的接口、逻辑、数据访问放在同一个包里，分包思路见 [工程结构与分包](/architecture/2_package_structure)。

读代码建议从三个地方进：

| 想看 | 从哪进 |
|------|-------|
| 一条消息怎么进平台 | [`MqttProtocolAdapter#onPublish`](https://github.com/Clarence404/conduit-iot/blob/811e441/conduit-transport/src/main/java/dev/conduit/transport/mqtt/MqttProtocolAdapter.java) |
| 一条消息怎么被处理 | [`PipelineProcessor#process`](https://github.com/Clarence404/conduit-iot/blob/811e441/conduit-server/src/main/java/dev/conduit/server/pipeline/PipelineProcessor.java)、[`TelemetryIngestor#prepare`](https://github.com/Clarence404/conduit-iot/blob/811e441/conduit-server/src/main/java/dev/conduit/server/pipeline/TelemetryIngestor.java) |
| 表结构怎么一版版长出来 | [`db/migration/`](https://github.com/Clarence404/conduit-iot/tree/811e441/conduit-server/src/main/resources/db/migration) 下的 V1～V10 |

---

## 七、本地运行

步骤、环境变量和口令的填法都以 [仓库 README](https://github.com/Clarence404/conduit-iot/blob/811e441/README.md) 为准，这里只说有哪几种跑法和各自要什么。

| 跑法 | 需要 | 适合 |
|------|------|------|
| 独立部署包 `deploy/standalone` | 一台装了 Docker Compose v2 的 Linux | 只想看效果：一条命令起全套，模拟器自动上报，浏览器打开就有数据 |
| 开发环境包 `deploy/dev` 加 IDE | Docker 宿主机跑 PostgreSQL、Redis、InfluxDB、EMQX；本机 JDK 21 与 Node.js 跑应用 | 读代码、打断点 |
| 只跑测试 | JDK 21 与能用的 Docker（Testcontainers） | 验证本系列引用的测试 |

几件容易卡住的事：

- **EMQX 要能回调到 server**：开发模式下 EMQX 在 Docker 宿主机、server 在开发机，`.env` 里的 `CONDUIT_AUTH_URL` 要填宿主机能访问到的开发机地址，开发机防火墙要放行 8080，否则所有设备和 transport 都连不上
- **`.env` 里的 `change-me-*` 必须换掉**：模板里的占位值只为让文件完整，README 的安全提示写了生成方法
- **IDE 里从共享运行配置启动**：仓库 `.run/` 带了 `Conduit (local all)`，一次启动 server、transport、模拟器和前端；本地配置写在不入库的 `application-local.yml` 里
- **模拟器会重置它所模拟设备的密钥**：只对演示租户用，不要指向接了真实设备的环境

测试分三层，命令都在 README：

```bash
mvn verify                                   # 单元测试 + Testcontainers 集成测试
cd conduit-ui && npm install && npm test     # 前端
mvn -B verify -Pe2e -pl conduit-e2e          # 端到端故障场景，约 6～10 分钟，不进默认构建
```

---

## 八、系列路线

| 篇 | 讲什么 | 先读 |
|----|--------|------|
| 平台实战概览 | 本篇 | [平台选型](../1_basics/2_platform) |
| [设备接入与鉴权](./1_access) | topic 设计、设备凭据、EMQX HTTP 鉴权回调、ACL、上下线与在线状态 | [设备安全](../2_access/1_security)、[通信协议](../1_basics/1_protocol) |
| [物模型与解码](./2_thing_model) | 物模型数据结构、逐测点校验、可插拔解码器、按产品缓存、缺测与零值 | [平台选型](../1_basics/2_platform) |
| [可靠上报与接入层主备](./3_reliable_uplink) | 写入总线后才 PUBACK、消息 id 与业务回执、transport 选主、共享订阅 | [MQTT 客户端](../2_access/3_mqtt_client)、[分布式锁](/distributed/3_lock) |
| [数据流水线](./4_pipeline) | 消费组、批处理、退避重试、认领、死信、积压 | [遥测数据链路](../3_platform/2_data)、[Redis 典型应用场景](/cache/4_redis_scenario) |
| [时序存储与历史查询](./5_telemetry) | InfluxDB 3 建模与写入、最新值、自动聚合、缺桶、遥测重放 | [时序数据库](/nosql/4_time_series_db) |
| [多租户与授权](./6_tenant) | 租户过滤、跨租户通道、组织模型、范围授权、会话 | [权限系统架构设计](/architecture/6_access_control) |
| 规划中：设备影子 | Conduit 尚未实现，计划中（见 roadmap） | [设备影子](../3_platform/3_device_shadow) |
| 规划中：OTA 升级 | Conduit 尚未实现，计划中（见 roadmap） | [OTA 升级](../3_platform/5_ota) |
| 规划中：规则引擎 | Conduit 尚未实现，计划中（见 roadmap） | [规则引擎](../3_platform/6_rule_engine) |
| [压测与瓶颈排查](./10_capacity) | 压测方法、逐跳定位瓶颈、几次优化的前后对比 | [性能分析方法论](/high-perf/2_methodology) |
| [部署与可观测](./11_deploy) | 三套部署包、指标与看板、健康检查、发布与回滚 | [可观测性总览](/observability/0_overview) |

目前已完成的是其中九篇。「先读」一列的文章讲通用原理和选型，本系列只讲在 Conduit 里怎么落地、为什么这样取舍。标「规划中」的三行目前只有右边那三篇通用设计文章，讲的是这类功能一般怎么设计，不是 Conduit 的实现；Conduit 做完对应版本后，会在本系列补上实现篇，文件编号 19～21 就是留给它们的。

---

## 九、与现成平台的关系

[平台选型](../1_basics/2_platform) 对比过阿里云 IoT、ThingsBoard、JetLinks、EMQX 这些现成方案，并按场景给了选型建议。Conduit 自己从头写，和它们的关系是这样的：

- **EMQX 是 Conduit 的一个组件**，不是对手。连接、会话、QoS、ACL 这些 Broker 的活全部交给 EMQX；Conduit 只用它的 HTTP 认证回调、文件 ACL 和 `$SYS` 上下线事件。数据不走 EMQX 的规则引擎和数据桥接，而是由 transport 以普通 MQTT 客户端的身份订阅后写进总线，这样「写成功才确认」这一步握在自己的代码里
- **ThingsBoard 是对照物**。路线图写的是核心能力对标 ThingsBoard，但不以逐项复制为目标，想做出差别的地方是更清晰的产品模型、更可靠的上报语义、更低的部署复杂度
- **差距是实打实的**。规则链、仪表盘、设备影子、OTA、网关子设备这些现成平台已有的能力，Conduit 都还没有

所以本系列的用法是「看一个平台的骨架是怎么搭出来的」，不是「推荐你用它上生产」。要选型，回到 [平台选型](../1_basics/2_platform)。

---

## 十、还没做的

下面这些在路线图里有位置，但到本系列对应的提交为止代码里没有。站内相应的文章讲的是通用设计，不是 Conduit 的实现。

| 能力 | 路线图阶段 | 现状 | 站内文章 |
|------|-----------|------|---------|
| 设备影子与属性同步 | V0.4 | Conduit 尚未实现，计划中 | [设备影子](../3_platform/3_device_shadow)（通用设计） |
| OTA 升级 | V0.4 | Conduit 尚未实现，计划中 | [OTA 升级](../3_platform/5_ota)（通用设计） |
| 规则引擎与告警 | V0.5 | Conduit 尚未实现，计划中 | [规则引擎](../3_platform/6_rule_engine)（通用设计） |
| 下行命令（RPC） | V0.4 | 未实现；设备能订阅的下行 topic 目前只用于业务回执 `down/ack` | — |
| 网关与子设备 | V0.4 | 未实现，只支持设备直连 | — |
| 事件上报 | 随告警一起设计 | topic `up/event` 能解析，但流水线直接按 `UNSUPPORTED_TYPE` 进死信 | — |
| HTTP、Modbus TCP 等其他协议 | 后续 | `ProtocolAdapter` 接口已有，实现只有 MQTT | [Modbus 采集](../2_access/4_modbus)、[Netty 接入网关](../2_access/6_netty_gateway) |
| TLS | V0.8 | 未启用，凭据在网络上明文传输 | [设备安全](../2_access/1_security) |

设备影子、OTA 升级、规则引擎三项会在 Conduit 后续版本里实现，本系列已在第八节的路线表里给它们留了位置；做完之后补上的实现篇会和现有三篇通用设计文章互相链接，一篇讲「一般怎么设计」，一篇讲「在 Conduit 里怎么落地」。

除了功能，路线图第 2 节还列了离生产级 SaaS 的六类差距：租户配额与资源治理、SaaS 商业闭环（注册、套餐、计量、账单）、设备控制能力、规则与告警、水平扩展与灾备、开放 API 与审计。本系列各篇末尾的「已知限制」会把与该篇相关的差距写具体。

---

## 十一、验证

本篇是概览，下表只列支撑「全过程」和「分进程」这两节结论的测试，各篇有自己更细的验证表。

| 结论 | 测试 | 类型 |
|------|------|------|
| 合法上报写进 InfluxDB 并更新最新值 | [`PipelineIT#validPropertyIsWrittenToInfluxAndLatest`](https://github.com/Clarence404/conduit-iot/blob/811e441/conduit-server/src/test/java/dev/conduit/server/pipeline/PipelineIT.java) | 集成（真实 Redis、PostgreSQL、InfluxDB） |
| 补传的旧数据不覆盖最新值 | [`PipelineIT#olderMessageDoesNotOverwriteLatest`](https://github.com/Clarence404/conduit-iot/blob/811e441/conduit-server/src/test/java/dev/conduit/server/pipeline/PipelineIT.java) | 集成 |
| 没确认的消息会被重新认领并处理 | [`PipelineIT#unackedMessageIsClaimedAndProcessed`](https://github.com/Clarence404/conduit-iot/blob/811e441/conduit-server/src/test/java/dev/conduit/server/pipeline/PipelineIT.java) | 集成 |
| 投递超过 5 次进死信 | [`PipelineIT#messageExceedingMaxDeliveriesGoesToDeadLetter`](https://github.com/Clarence404/conduit-iot/blob/811e441/conduit-server/src/test/java/dev/conduit/server/pipeline/PipelineIT.java) | 集成 |
| `RawMessage` 与 Stream 字段互转不丢信息 | [`RawMessageCodecTest`](https://github.com/Clarence404/conduit-iot/blob/811e441/conduit-common/src/test/java/dev/conduit/common/message/RawMessageCodecTest.java) | 单元 |
| 总线的发布、消费组、认领、死信 | [`RedisStreamMessageBusIT`](https://github.com/Clarence404/conduit-iot/blob/811e441/conduit-common/src/test/java/dev/conduit/common/bus/RedisStreamMessageBusIT.java) | 集成（真实 Redis） |
| 强制结束 server、主 transport、EMQX 后数据条数恰好等于发送数 | [`ReliabilityE2EIT`](https://github.com/Clarence404/conduit-iot/blob/811e441/conduit-e2e/src/test/java/dev/conduit/e2e/ReliabilityE2EIT.java) | 端到端（5 个故障场景） |

端到端测试每个场景新建一个产品和 10 台设备，每台发 50 条，发送中途注入故障，最后断言 InfluxDB 里该产品恰好 500 条、死信流里没有它、消费组没有待确认消息。五个场景和各自验证的机制见 README「端到端测试」一节，[可靠上报与接入层主备](./3_reliable_uplink) 展开。

---

## 十二、已知限制

这里只列全局性的，都出自 README「已知限制」与路线图，各篇再细说。

- **未启用 TLS**，设备凭据和登录口令在网络上明文传输，只适合内网和演示环境
- **transport 同一时刻只有一个实例在消费**，接入吞吐受单个实例限制；多个实例是为了故障切换，不是为了分摊
- **不带消息 `id` 的设备没有端到端保证**：EMQX 进程重启时，已经 PUBACK 但还没投递给 transport 的消息会丢
- **InfluxDB 3 Core 的写入响应不代表已落盘**，非正常断电会丢内核回写窗口内的数据，要靠重放从总线里找回
- **部署以单机 Compose 为主**，没有水平扩展、滚动升级和灾备演练
- **物模型缓存是进程内缓存**，多实例部署时修改物模型最多 60 秒后才在其他实例生效
- **死信只能用 `redis-cli` 查看**，首页只有最近 1 小时的死信计数

---

## 小结

- Conduit IoT 是按版本演进的开源多租户物联网平台，本系列固定在提交 `811e441`，技术栈为 JDK 21、Spring Boot 3.5、EMQX 5、Redis Streams、PostgreSQL、InfluxDB 3 Core
- 已完成 V0.1 主链路、V0.2 的物模型 / 历史 / 多租户 / 可靠性、V0.3 的租户隔离加固与组织授权；设备影子、OTA、规则引擎、RPC、网关子设备尚未实现
- 一条上报经过设备、EMQX、transport、Redis Streams、server 流水线、InfluxDB 与 Redis，每一跳都是下游确认后才确认上游，重复由存储侧的覆盖语义吸收
- 接入与业务分成两个进程，只共用 `RawMessage` 和 `MessageBus`：server 重启不堵接入，加协议不动业务，两边各自做高可用；代价是多一跳和多一个关键依赖
- server 有两个入口：鉴权回调是同步的控制面，挂了只影响新连接；数据流水线是异步的数据面，挂了消息在总线里排队
- 仓库的设计文档、测试报告和路线图是读代码的入口，本系列每篇都把结论对到具体的测试或报告上
- 目前已完成的九篇，除本篇外依次讲接入鉴权、物模型、可靠上报、流水线、时序存储、多租户、压测、部署；设备影子、OTA 升级、规则引擎三篇待 Conduit 实现后补上

## 参考资料

- conduit-iot 仓库：[https://github.com/Clarence404/conduit-iot](https://github.com/Clarence404/conduit-iot)
- Conduit IoT Roadmap：[https://github.com/Clarence404/conduit-iot/blob/811e441/docs/roadmap-saas.md](https://github.com/Clarence404/conduit-iot/blob/811e441/docs/roadmap-saas.md)
- Conduit V0.1 设计文档：[https://github.com/Clarence404/conduit-iot/blob/811e441/docs/superpowers/specs/2026-10-14-conduit-v0.1-design.md](https://github.com/Clarence404/conduit-iot/blob/811e441/docs/superpowers/specs/2026-10-14-conduit-v0.1-design.md)
- Conduit 设备接入指南：[https://github.com/Clarence404/conduit-iot/blob/811e441/docs/device-integration.md](https://github.com/Clarence404/conduit-iot/blob/811e441/docs/device-integration.md)
- EMQX 文档：[https://docs.emqx.com/zh/emqx/latest/](https://docs.emqx.com/zh/emqx/latest/)
- Redis Streams：[https://redis.io/docs/latest/develop/data-types/streams/](https://redis.io/docs/latest/develop/data-types/streams/)

> 下一篇：[设备接入与鉴权](./1_access)
