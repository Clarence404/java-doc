---
description: 阿里云核心服务、腾讯云 / 华为云差异点、Java 微服务部署架构、国内云选型
---

# 国内云平台

> **本篇目标**：熟悉阿里云面向 Java 后端的核心服务及其当前命名，了解腾讯云、华为云的差异化产品，能画出一套阿里云上的微服务部署架构，并按业务场景做国内云选型。
>
> **前置阅读**：[云计算概览](./13_cloud_overview)

面向国内用户的业务，国内云在 ICP 备案、等保合规、境内多运营商网络质量上有天然优势。本篇以阿里云为主体，腾讯云、华为云只写它们的差异点；三家与 AWS 等国际厂商的服务名称对照统一见 [云计算概览](./13_cloud_overview)。

::: tip 产品改名频繁
国内云厂商的产品名经常调整（如阿里云 MNS 改为「轻量消息队列」、SLB 拆分为 CLB / ALB / NLB），下文用当前名称并在括号中注明旧名。以控制台与官方文档为准。
:::

---

## 一、三大厂商定位

| 对比项 | 阿里云 | 腾讯云 | 华为云 |
|-------|-------|-------|-------|
| 优势 | 产品线最全、文档与社区资料多，电商 / 金融场景积累深 | 游戏、音视频、社交生态，与微信 / 小程序打通 | 政企、运营商、政务合规，软硬件一体与信创适配 |
| 不足 | 产品多、命名变动频繁，选型需要先理清产品族 | 部分中间件产品线收敛、调整较多 | 面向企业客户为主，个人开发者资料相对少 |
| 适合场景 | 互联网、电商、金融、中小企业 | 游戏、直播、泛娱乐、小程序 | 政府、运营商、大型企业、国产化项目 |
| 代表性开源 / 自研 | RocketMQ（已捐给 Apache）、Nacos、Sentinel、PolarDB | 北极星 PolarisMesh、TARS、TDSQL | ServiceComb（已捐给 Apache）、openEuler、GaussDB |

---

## 二、阿里云核心服务

### 1、计算

| 服务 | 说明 |
|------|------|
| **ECS** | 弹性云服务器 |
| **弹性伸缩 ESS** | 按指标或定时自动增减 ECS 实例 |
| **ACK** | 容器服务 Kubernetes 版（托管 K8s），概念见 [Kubernetes](./6_kubernetes) |
| **SAE** | Serverless 应用引擎，免运维节点，直接部署 JAR / WAR / 镜像，适合 Spring Cloud 应用平迁 |
| **函数计算 FC** | 事件驱动的 Serverless 函数 |
| **轻量应用服务器** | 面向个人开发者，套餐化，适合建站与小项目 |

### 2、存储

| 服务 | 说明 |
|------|------|
| **OSS** | 对象存储，兼容 S3 协议的常用操作，支持图片处理、视频截帧；接入方式见 [对象存储](/architecture/4_object_storage) |
| **云盘 ESSD** | 块存储，挂载到 ECS |
| **NAS** | 文件存储，多台 ECS / Pod 共享挂载 |
| **OSS 归档 / 冷归档** | OSS 的低频访问存储类型，适合冷数据，取回需要解冻时间 |

### 3、数据库

| 服务 | 说明 |
|------|------|
| **RDS** | 托管关系型数据库，支持 MySQL / PostgreSQL / SQL Server / MariaDB |
| **PolarDB** | 自研云原生数据库，存算分离，兼容 MySQL / PostgreSQL，一写多读、秒级扩只读节点 |
| **云数据库 Tair（兼容 Redis）** | 托管 Redis，支持标准版（主从）、集群版、读写分离 |
| **云数据库 MongoDB** | 托管 MongoDB |
| **AnalyticDB** | 实时数仓（MySQL / PostgreSQL 两个版本） |
| **Lindorm** | 多模数据库，兼容 HBase / Cassandra 等宽表接口，适合时序与海量明细 |
| **表格存储 Tablestore** | Serverless 宽表 NoSQL |

数据库选型思路见 [数据库总览](/database/0_overview)。

### 4、网络

| 服务 | 说明 |
|------|------|
| **VPC** | 专有网络：交换机（子网）、路由表、安全组 |
| **CLB / ALB / NLB** | 负载均衡产品族：CLB 为传统型（原 SLB），ALB 为七层应用型（可作 ACK 的 Ingress），NLB 为四层网络型；新业务优先 ALB / NLB |
| **CDN** | 静态资源加速，境内节点覆盖广 |
| **云解析 DNS** | 权威 DNS，支持按运营商 / 地域的智能线路 |
| **高速通道** | 专线与跨地域互联 |
| **NAT 网关** | 私网 ECS 访问公网的出口（SNAT）与端口映射（DNAT） |

### 5、消息与中间件

| 服务 | 说明 |
|------|------|
| **云消息队列 RocketMQ 版** | 托管 RocketMQ，事务消息、定时消息、顺序消息开箱即用 |
| **云消息队列 Kafka 版** | 托管 Kafka，日志采集、流处理 |
| **云消息队列 RabbitMQ 版** | 兼容 AMQP 0-9-1 |
| **轻量消息队列（原 MNS）** | 简单的队列 / 主题模型，适合云产品事件通知、轻量异步任务 |
| **微服务引擎 MSE** | 托管 Nacos / ZooKeeper 注册配置中心、云原生网关，以及基于 Sentinel 的服务治理 |

RocketMQ、Kafka 等各自适合什么场景，见 [消息队列总览](/messaging/0_overview) 与 [MQ 选型](/messaging/6_selection)；注册配置中心的原理见 [Spring Cloud](/spring-cloud/0_overview)。

### 6、监控与运维

| 服务 | 说明 |
|------|------|
| **云监控 CloudMonitor** | 云资源指标与告警 |
| **日志服务 SLS** | 日志采集、查询、分析与告警，相当于托管的日志平台 |
| **ARMS 应用监控** | APM，Java 探针无侵入接入，提供调用链、JVM 指标、持续剖析 |
| **可观测链路 OpenTelemetry 版** | 归入 ARMS 产品线的分布式追踪，兼容 OpenTelemetry、SkyWalking、Zipkin、Jaeger 上报 |
| **Prometheus 监控** | 托管 Prometheus 与 Grafana |

可观测性的通用设计见 [可观测性总览](/observability/0_overview)。

### 7、安全

| 服务 | 说明 |
|------|------|
| **RAM** | 访问控制：子账号、角色、策略；生产禁止使用主账号 AccessKey |
| **KMS** | 密钥管理与凭据管家 |
| **WAF** | Web 应用防火墙 |
| **DDoS 防护** | DDoS 原生防护与高防 |
| **云安全中心** | 主机漏洞、基线、入侵检测 |

---

## 三、腾讯云与华为云的差异点

通用的计算、存储、数据库、负载均衡三家能力相近，名称对照见 [云计算概览](./13_cloud_overview)。选型时更值得关注的是下面这些差异化产品和命名变化。

### 1、腾讯云

| 方向 | 说明 |
|------|------|
| **数据库** | 云数据库 MySQL（旧称 CDB，英文 TencentDB for MySQL）；TDSQL-C 为存算分离的云原生数据库，对标 PolarDB |
| **消息队列** | 消息队列 TDMQ 产品族：CKafka（兼容 Kafka）、RocketMQ 版、RabbitMQ 版、Pulsar 版、MQTT 版；早期的 CMQ 已迁入 TDMQ |
| **注册配置中心** | 微服务引擎 TSE 提供托管 Nacos 与自研开源的北极星 PolarisMesh；ZooKeeper、Consul 等引擎已停止新接入，新项目选 Nacos 或北极星 |
| **音视频 / 游戏** | 实时音视频 TRTC、云直播、游戏多媒体引擎 GME，以及与微信 / 小程序云开发的打通 |

### 2、华为云

| 方向 | 说明 |
|------|------|
| **数据库** | GaussDB（自研分布式数据库）与 RDS；国产化项目常见要求 |
| **消息队列** | 分布式消息服务 DMS，提供 Kafka、RocketMQ、RabbitMQ 版本 |
| **注册配置中心** | 微服务引擎 CSE 提供 ServiceComb 引擎与 Nacos 引擎，Spring Cloud 应用可用 Spring Cloud SDK 直接接 Nacos 引擎 |
| **缓存 / 监控** | 分布式缓存服务 DCS（Redis）；应用运维管理 AOM 与应用性能管理 APM |
| **信创** | 鲲鹏（ARM）服务器、openEuler 操作系统，Java 应用需要验证 ARM 架构下的镜像与原生依赖 |

---

## 四、阿里云上的 Java 微服务部署架构

![阿里云上的典型 Java 微服务部署](../assets/cloud-native/cloud-domestic-aliyun-arch.svg)

- **入口层**：云解析 DNS 按运营商返回就近地址；静态资源走 CDN（回源 OSS），动态请求经 WAF 过滤后到 ALB
- **接入层**：ALB 负责七层转发与 HTTPS 卸载，在 ACK 中可通过 ALB Ingress 直接作为集群入口，Ingress 的概念见 [Nginx 与 Ingress](./7_nginx_ingress)
- **应用层**：Spring Boot / Spring Cloud 服务部署在 ACK；也可以选 SAE，省去节点与集群运维
- **控制面**：MSE 托管 Nacos，是服务注册与配置下发的旁路组件，不在请求链路上；它不可用时已有实例仍可依赖客户端缓存继续调用
- **数据层**：PolarDB / RDS MySQL、Tair（兼容 Redis）、云消息队列 RocketMQ 版，均与 ACK 放在同一 VPC，通过内网地址访问
- **旁路**：OSS 存文件，SLS 收日志，ARMS 做 APM 与链路追踪

::: tip 多可用区部署
ACK 节点池、PolarDB / RDS、Tair 都选择多可用区，ALB 同时挂多个可用区的交换机，单可用区故障时入口与数据层都能切换。容灾的系统级策略见 [高可用总览](/high-avail/0_overview)。
:::

---

## 五、国内云选型建议

| 场景 | 推荐 | 理由 |
|------|------|------|
| 初创 / 中小互联网 | 阿里云 | 产品与资料最全，招聘到熟悉的人更容易 |
| 游戏 / 直播 / 音视频 | 腾讯云 | TRTC、云直播、GME 等生态完善 |
| 微信小程序业务 | 腾讯云 | 与微信生态、小程序云开发天然打通 |
| 政务 / 国企 / 信创 | 华为云 | 合规认证多，鲲鹏 + openEuler + GaussDB 的国产化栈完整 |
| 出海 + 国内双栈 | 阿里云或国际云 + 国内云组合 | 阿里云国际站在东南亚覆盖较好；面向欧美可用国际云，见 [国际云平台](./15_cloud_global) |

除厂商本身外，还要考虑：

- **锁定程度**：优先使用开源协议兼容的托管服务（MySQL、Redis、Kafka、RocketMQ、Nacos、Kubernetes），迁移时改连接地址即可；PolarDB、Tablestore 等自研产品能力强但迁出成本高
- **备案与合规**：境内服务器对外提供网站服务需要 ICP 备案，备案主体与接入商绑定，换云需要变更接入
- **基础设施即代码**：三家都提供 Terraform Provider，资源用代码管理便于多云与复刻环境，见 [Terraform](./11_terraform)

::: warning 待补充
阿里云实战操作：ECS 部署 Spring Boot、OSS 接入、MSE Nacos 配置。
:::

---

## 小结

- 国内云适合面向境内用户的业务，优势在备案、合规与多运营商网络；三家能力相近，差异在生态与行业
- 阿里云产品名变动多：负载均衡分为 CLB（原 SLB）/ ALB / NLB，MNS 改为轻量消息队列，链路追踪归入 ARMS 的可观测链路 OpenTelemetry 版，Redis 托管产品叫 Tair（兼容 Redis）
- 腾讯云的消息队列统一归入 TDMQ 产品族（含 CKafka），注册中心新项目选 Nacos 或北极星；华为云 CSE 同时提供 ServiceComb 与 Nacos 引擎
- 典型部署链路：DNS → CDN + WAF → ALB → ACK（或 SAE）→ PolarDB / Tair / RocketMQ，MSE 是旁路的注册配置中心，不在请求链路上
- 选型时优先开源兼容的托管服务以降低锁定，并提前考虑备案与 IaC 管理

## 参考资料

- [阿里云负载均衡产品概述（CLB / ALB / NLB）](https://help.aliyun.com/zh/slb/product-overview/slb-overview)
- [阿里云：什么是轻量消息队列（原 MNS）](https://help.aliyun.com/zh/mns/product-overview/what-is-mns)
- [阿里云：什么是可观测链路 OpenTelemetry 版](https://help.aliyun.com/zh/opentelemetry/product-overview/what-is-managed-service-for-opentelemetry)
- [阿里云微服务引擎 MSE 文档](https://help.aliyun.com/zh/mse/)
- [腾讯云注册配置治理（TSE）文档](https://www.tencentcloud.com/document/product/1290/79359)
- [腾讯云消息队列 TDMQ 产品页](https://cloud.tencent.com/product/tdmq)
- [华为云微服务引擎 CSE 产品页](https://www.huaweicloud.com/product/cse.html)

> 下一篇：[国际云平台](./15_cloud_global)
