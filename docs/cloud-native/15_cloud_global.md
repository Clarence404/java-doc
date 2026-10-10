---
description: AWS / Azure / GCP 定位差异、AWS 核心服务、Azure 与 GCP 特色服务、Java 微服务参考架构
---

# 国际云平台

> **本篇目标**：了解 AWS / Azure / GCP 各自的定位和中国区情况，熟悉 Java 后端在 AWS 上最常用的服务及其近年变化，能画出一套基于 EKS 的微服务部署架构。
>
> **前置阅读**：[云计算概览](./13_cloud_overview)（服务模型、Region 与可用区，以及六大云厂商服务对照表）

本篇以 AWS 为主，Azure 和 GCP 只讲有特色、和 AWS 差异较大的部分。三家同类服务的名称对照见 [云计算概览 · 六大云厂商核心服务对照](./13_cloud_overview#三、六大云厂商核心服务对照)，这里不再重复。产品状态以 2026 年 10 月官方文档为准。

---

## 一、三大厂商定位

| 对比项 | AWS | Azure | GCP |
|-------|-----|-------|-----|
| 市场地位 | 全球规模最大，起步最早 | 第二梯队之首，企业客户基础深厚 | 三家中规模最小，增长较快 |
| 优势 | 服务种类最全、生态和社区资料最丰富 | 与 Microsoft 365、Entra ID、Windows Server 打通，混合云方案成熟 | Kubernetes（GKE）、数据分析（BigQuery）、AI（TPU、Vertex AI） |
| 劣势 | 服务多、计费项复杂，学习曲线陡 | 产品线调整频繁，部分服务命名和层级变动多 | 企业级支持和合作伙伴生态相对较弱 |
| 适合场景 | 通用互联网业务、微服务、出海首选 | 已深度使用微软技术栈的企业、混合云 | 数据密集型业务、AI 训练与推理、K8s 重度用户 |
| 中国区 | 北京 Region 由光环新网运营，宁夏 Region 由西云数据运营 | 由世纪互联运营 | 无中国大陆 Region |

::: warning 中国区是独立的「分区」
AWS 中国区（`aws-cn` 分区）和 Azure 中国区与各自的全球区账号体系隔离，需要单独注册，服务上线时间和功能也落后于全球区。在 IAM 策略里，中国区的 ARN 前缀是 `arn:aws-cn:` 而不是 `arn:aws:`，Terraform 和 SDK 配置要相应调整。
:::

---

## 二、AWS 核心服务

### 1、计算

| 服务 | 说明 |
|------|------|
| **EC2** | 云主机，按用途分通用、计算优化、内存优化、GPU 等实例族；Graviton（ARM）实例性价比高，Java 应用一般无需改代码，换成 ARM 版 JDK 和镜像即可 |
| **Auto Scaling** | 按指标或定时策略增减 EC2 实例 |
| **EKS** | 托管 Kubernetes，控制面由 AWS 运维；节点可用托管节点组、Karpenter 自动扩缩，或 Fargate 无节点模式 |
| **ECS** | AWS 自有的容器编排，比 EKS 简单；Fargate 模式无需管理节点，Express Mode 用于快速部署 Web 服务 |
| **Lambda** | Serverless 函数，支持 Java 21 / 25 等运行时，按请求次数和执行时长计费 |
| **Elastic Beanstalk** | PaaS，上传 jar 包即可完成部署，适合快速验证 |

**Java 跑 Lambda 的冷启动**：JVM 启动加类加载让 Java 函数冷启动明显慢于 Node / Python。官方的解法是 **SnapStart**：发布函数版本时先执行初始化，把内存和磁盘状态做成快照，冷启动时直接从快照恢复。开启后要注意快照恢复的副作用，比如在初始化阶段生成的随机数、建立的网络连接，会被所有恢复出来的实例共享，要放到 `afterRestore` 钩子里重新处理。Java 25 运行时还用上了 JDK 的 AOT 缓存来进一步缩短启动。另一条路是用 GraalVM 原生镜像，见 [Quarkus 原生镜像](/quarkus/3_native)。

### 2、存储

| 服务 | 说明 |
|------|------|
| **S3** | 对象存储，设计耐久性 11 个 9，支持版本控制和生命周期策略 |
| **EBS** | 块存储，挂载到同一可用区的 EC2，相当于云硬盘 |
| **EFS** | 托管 NFS，多个实例共享挂载 |
| **S3 归档存储类型** | S3 Glacier Instant Retrieval（毫秒级取回）、Flexible Retrieval（分钟到小时级）、Deep Archive（小时级，成本最低），通过生命周期规则自动转换 |

::: warning 新项目不要再用 Glacier 保管库
早期独立的 Amazon Glacier 服务（基于 Vault 和独立 API）从 2025 年 12 月 15 日起不再接受新客户，存量数据不受影响。新的归档需求一律用 S3 桶加上述 Glacier 存储类型。
:::

### 3、数据库

| 服务 | 说明 |
|------|------|
| **RDS** | 托管关系型数据库，支持 MySQL / PostgreSQL / MariaDB / Oracle / SQL Server |
| **Aurora** | AWS 自研，兼容 MySQL / PostgreSQL，计算与存储分离，存储层自动跨三个可用区复制 |
| **DynamoDB** | 全托管键值 / 文档数据库，单位数毫秒延迟，按容量或按请求计费 |
| **ElastiCache** | 托管缓存，支持 Valkey / Redis OSS / Memcached 三种引擎，Valkey 引擎的定价低于 Redis OSS，是 AWS 推荐的新集群选择 |
| **Redshift** | 列式数据仓库，适合 OLAP 分析 |

ElastiCache 的 Valkey 是 Redis 改为非开源许可后由 Linux 基金会维护的开源分支，协议兼容 Redis，Spring Data Redis（Lettuce / Jedis）客户端无需改动。缓存的使用方式见 [Redis](/cache/0_overview)。

### 4、网络

| 服务 | 说明 |
|------|------|
| **VPC** | 私有网络，含子网、路由表、安全组、NAT 网关 |
| **ALB / NLB** | 七层 / 四层负载均衡；ALB 按路径和 Host 路由，NLB 提供固定 IP 和极低延迟 |
| **CloudFront** | CDN，全球边缘节点缓存与 HTTPS 终止 |
| **Route 53** | DNS，支持健康检查和延迟、地理位置、加权等路由策略 |
| **Direct Connect** | 专线接入，绕过公网，用于混合云 |

### 5、监控与运维

| 服务 | 说明 |
|------|------|
| **CloudWatch** | 指标、日志、告警和看板；Application Signals 基于 OpenTelemetry 提供应用级 APM |
| **X-Ray** | 分布式链路追踪的后端与控制台 |
| **CloudTrail** | 记录账号内所有 API 调用，用于安全审计 |
| **Systems Manager** | 批量管理 EC2，Parameter Store 可存放配置 |

::: warning X-Ray SDK 已进入维护期
X-Ray SDK 和 Daemon 从 2026 年 2 月 25 日起只修安全问题，2027 年 2 月 25 日停止支持。X-Ray 服务本身继续可用，但应用侧埋点应改用 OpenTelemetry：Java 应用挂载 ADOT（AWS Distro for OpenTelemetry）Java Agent，或启用 CloudWatch Application Signals。通用的链路追踪和 OTel 接入见 [链路追踪](/observability/3_tracing) 与 [OpenTelemetry](/observability/5_opentelemetry)。
:::

### 6、安全

| 服务 | 说明 |
|------|------|
| **IAM** | 用户、角色和策略；EC2 / EKS 上的应用应通过角色获取临时凭证（EKS 用 Pod Identity 或 IRSA），不要把 AccessKey 写进配置 |
| **KMS** | 托管密钥，S3、EBS、RDS 等服务的加密都基于它 |
| **Secrets Manager** | 托管数据库密码等密钥，支持自动轮换 |
| **AWS WAF** | 独立的 Web 应用防火墙，规则集（Web ACL）挂载到 CloudFront、ALB 或 API Gateway 上生效 |
| **Shield** | DDoS 防护，基础版默认开启，Advanced 版需单独订阅 |

### 7、数据与 AI

| 服务 | 说明 |
|------|------|
| **Amazon Bedrock** | 托管生成式 AI 服务，通过统一 API 调用多家基础模型 |
| **SageMaker AI** | 机器学习的训练、调优和部署（即原来的 SageMaker） |
| **Amazon SageMaker** | 2024 年起指统一的数据、分析与 AI 平台，核心是 SageMaker Unified Studio |

Java 应用接入大模型的方式见 [AI](/ai/0_overview)。

---

## 三、Azure 与 GCP 特色服务

### 1、Azure

| 服务 | 特色 |
|------|------|
| **Microsoft Entra ID** | 原 Azure AD，企业统一身份；Spring Boot 应用可通过 OIDC 接入 SSO |
| **AKS** | 托管 Kubernetes，与 Entra ID、Azure Monitor 集成紧密 |
| **Azure Container Apps** | 基于 Kubernetes 的 Serverless 容器平台，内置 KEDA 事件驱动扩缩和 Dapr |
| **Azure Front Door** | 全球七层入口，集 CDN、WAF 和全局负载均衡于一体；Azure CDN（classic）正在退役，新项目用 Front Door 标准版 / 高级版 |
| **Azure Managed Redis** | 新一代托管 Redis；Azure Cache for Redis 已停止新建并进入退役流程 |
| **Microsoft Fabric** | 一体化数据分析平台，是 Synapse Analytics 之后微软主推的方向 |
| **Azure Arc** | 把本地机房和其他云上的服务器、K8s 集群纳入 Azure 统一管理，是混合云方案的核心 |

### 2、GCP

| 服务 | 特色 |
|------|------|
| **GKE** | Kubernetes 起源于 Google，GKE 的版本跟进和 Autopilot（按 Pod 计费、无需管理节点）模式是其强项 |
| **Cloud Run** | 运行任意容器的 Serverless 平台，可缩容到零；原 Cloud Functions 已并入，改名 Cloud Run functions |
| **BigQuery** | Serverless 数据仓库，无需管理集群，按扫描量或预留容量计费 |
| **Spanner** | 全球分布式关系型数据库，跨 Region 强一致 |
| **Vertex AI** | 统一的 AI 平台，提供 Gemini 等模型的调用、训练和部署 |
| **全球 VPC** | GCP 的 VPC 是全球资源，子网按 Region 划分，跨 Region 内网互通无需对等连接 |

---

## 四、Java 微服务参考架构（AWS）

![AWS 上的 Java 微服务参考架构](../assets/cloud-native/cloud-global-aws-java-arch.svg)

请求从上往下依次经过：

1. **Route 53** 解析域名，对后端做健康检查
2. **CloudFront** 在边缘缓存静态资源、终止 HTTPS；**AWS WAF** 以 Web ACL 的形式挂在 CloudFront 上，拦截注入、恶意爬虫等请求
3. **ALB** 按路径把动态请求转发到 EKS 中的 Service（通常由 AWS Load Balancer Controller 根据 Ingress 自动创建）
4. **EKS** 跨多个可用区运行 Spring Boot Pod，HPA 负责 Pod 扩缩，Karpenter 负责节点扩缩
5. 数据层：**Aurora** 存业务数据，**ElastiCache** 做缓存，**SQS** 做异步解耦，**S3** 存文件，静态资源也可以作为 CloudFront 的源站

右侧的横切能力贯穿所有层：CloudWatch 收集指标和日志，ADOT 采集链路发往 X-Ray，CloudTrail 审计 API 调用，Pod 通过 IAM 角色访问 S3、SQS 等服务，不在代码里存放 AccessKey。

几个落地要点：

- **跨可用区**：EKS 节点组、Aurora 副本、ElastiCache 副本都至少分布在两个可用区，见 [冗余与故障转移](/high-avail/2_redundancy_failover)
- **优雅上下线**：ALB 目标注销延迟要和 Pod 的 `preStop`、Spring Boot 优雅停机时间配合，否则滚动发布时会有 502，见 [优雅上下线](/high-avail/8_graceful_release)
- **健康检查**：ALB 健康检查和 K8s 探针指向 Actuator 的 liveness / readiness 端点，见 [Actuator](/spring-boot/7_actuator)
- **基础设施即代码**：上述资源用 [Terraform](./11_terraform) 统一管理，避免在控制台手工点出来的环境无法复现

::: warning 待补充
AWS 实战操作：AWS CLI 常用命令、AWS SDK for Java 2.x 访问 S3 / SQS 的示例。
:::

---

## 小结

- AWS 服务最全、生态最成熟，是出海的默认选择；Azure 强在微软生态和混合云；GCP 强在 K8s、数据分析和 AI
- AWS / Azure 中国区由本地公司运营，账号和全球区隔离；GCP 没有中国大陆 Region
- 近年变化要记住：Glacier 保管库停止接新客户、ElastiCache 推荐 Valkey、X-Ray SDK 进入维护期改用 OpenTelemetry、Azure AD 改名 Entra ID、Cloud Functions 改名 Cloud Run functions
- Java 跑 Lambda 用 SnapStart 缓解冷启动，注意快照恢复后的唯一性和连接问题
- 典型部署是 Route 53 → CloudFront + WAF → ALB → EKS → Aurora / ElastiCache / SQS / S3，各层跨可用区，用 Terraform 管理

## 参考资料

- AWS 产品总览：[https://aws.amazon.com/products/](https://aws.amazon.com/products/)
- AWS Lambda SnapStart：[https://docs.aws.amazon.com/lambda/latest/dg/snapstart.html](https://docs.aws.amazon.com/lambda/latest/dg/snapstart.html)
- Amazon S3 存储类型：[https://aws.amazon.com/s3/storage-classes/](https://aws.amazon.com/s3/storage-classes/)
- Amazon Glacier 文档历史（停止接受新客户）：[https://docs.aws.amazon.com/amazonglacier/latest/dev/document-history.html](https://docs.aws.amazon.com/amazonglacier/latest/dev/document-history.html)
- AWS X-Ray SDK 与 Daemon 支持时间表：[https://docs.aws.amazon.com/xray/latest/devguide/xray-sdk-daemon-timeline.html](https://docs.aws.amazon.com/xray/latest/devguide/xray-sdk-daemon-timeline.html)
- Amazon ElastiCache 用户指南：[https://docs.aws.amazon.com/AmazonElastiCache/latest/dg/WhatIs.html](https://docs.aws.amazon.com/AmazonElastiCache/latest/dg/WhatIs.html)
- AWS 中国区：[https://www.amazonaws.cn/](https://www.amazonaws.cn/)
- Azure CDN（classic）退役常见问题：[https://learn.microsoft.com/azure/cdn/classic-cdn-retirement-faq](https://learn.microsoft.com/azure/cdn/classic-cdn-retirement-faq)
- Azure Cache for Redis 退役常见问题：[https://learn.microsoft.com/azure/azure-cache-for-redis/retirement-faq](https://learn.microsoft.com/azure/azure-cache-for-redis/retirement-faq)
- Google Cloud Run functions：[https://cloud.google.com/functions/docs](https://cloud.google.com/functions/docs)
- Google Cloud 与 AWS、Azure 产品对照：[https://cloud.google.com/docs/get-started/aws-azure-gcp-service-comparison](https://cloud.google.com/docs/get-started/aws-azure-gcp-service-comparison)

> 下一篇：[Cloudflare 边缘服务](./16_cloudflare)
