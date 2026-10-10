---
description: 云计算定义、IaaS / PaaS / SaaS 责任划分、六大云厂商服务对照、选型与成本模型
---

# 云计算概览

> 前置阅读：[虚拟化概览](./3_virtual)

云计算把计算、存储、网络等资源按需租给用户，并按服务模型划分厂商与用户的责任边界。本篇讲基本概念、Region 与可用区、六大云厂商核心服务对照和国内外选云的选型维度，产品名以 2026 年 10 月各厂商官网为准。

---

## 一、基本概念

### 1、云计算的定义

NIST SP 800-145 的定义：云计算是一种模型，让用户通过网络按需使用一个共享的、可配置的计算资源池（网络、服务器、存储、应用和服务），资源能快速申请和释放，几乎不需要和服务商人工打交道。它列了五个基本特征：

| 特征 | 含义 | 落到日常使用 |
|------|------|-------------|
| 按需自助服务 | 自己在控制台或 API 上开资源，不用找人审批 | 几分钟拉起一台云主机或一个数据库 |
| 广泛的网络访问 | 通过标准网络协议从各种终端访问 | 控制台、CLI、SDK、Terraform 都能操作 |
| 资源池化 | 物理资源被多租户共享，用户不关心具体在哪台机器 | 只选 Region 和可用区，不选机柜 |
| 快速弹性 | 资源能快速扩缩，看起来近乎无限 | 大促前扩容、结束后释放 |
| 可计量的服务 | 用量被计量和报告 | 按小时、按秒、按请求数或按流量计费 |

### 2、服务模型与责任划分

服务模型的区别在于「哪几层归你管」。越往上走，云厂商替你管得越多，你的灵活度也越低：

![自建 / IaaS / PaaS / SaaS 各层由谁负责](../assets/cloud-native/cloud-overview-service-models.svg)

| 模型 | 你管理的部分 | 云厂商管理的部分 | 典型产品 |
|------|------------|----------------|---------|
| IaaS（基础设施即服务） | 操作系统、运行时、中间件、应用、数据 | 机房、网络、服务器、虚拟化 | AWS EC2、阿里云 ECS、Azure Virtual Machines |
| PaaS（平台即服务） | 应用代码、数据、配置 | 操作系统、运行时、扩缩容 | 阿里云 SAE、AWS Elastic Beanstalk、Google App Engine |
| FaaS / Serverless | 函数代码、数据 | 运行环境、实例调度、按请求扩缩 | AWS Lambda、阿里云函数计算 FC、腾讯云云函数 SCF |
| SaaS（软件即服务） | 数据、账号与权限配置 | 整个软件栈 | Microsoft 365、Salesforce、飞书 |

托管 Kubernetes（EKS / ACK 等）介于 IaaS 和 PaaS 之间：控制面由云厂商负责，工作节点、镜像和应用仍然要你自己管，用 Fargate、ACK Serverless 这类无节点模式时，节点也交给云厂商。

**责任共担模型**：无论哪种模型，**数据、账号和访问权限永远是用户的责任**。最常见的云上事故，比如对象存储桶设成公共读、AccessKey 泄露到代码仓库、安全组放开 `0.0.0.0/0` 的 22 端口，都出在用户这一侧，云厂商不会替你兜底。

### 3、部署模型

| 模型 | 说明 | 适用场景 |
|------|------|---------|
| **公有云** | 资源由云厂商拥有，多租户共享 | 互联网业务、中小企业 |
| **私有云** | 资源由单个组织独享，自建或托管（如阿里云专有云、华为云 Stack） | 金融、政务等强监管行业 |
| **混合云** | 公有云与私有云 / 自建机房通过专线互通 | 核心数据留在本地，弹性业务上公有云 |
| **多云** | 同时使用多家云厂商 | 避免厂商锁定、出海与国内分别部署、跨云容灾 |

多云的代价是每家的 IAM、网络和托管服务都不一样，团队要学多套东西。常见做法是用 Kubernetes 和 [Terraform](./11_terraform) 抹平计算和资源编排的差异，数据库、消息队列这类有状态服务仍然各用各的。

---

## 二、Region 与可用区

| 概念 | 含义 | 设计要点 |
|------|------|---------|
| **Region（地域）** | 一个地理区域，如华东 1（杭州）、us-east-1 | 选离用户近的；数据主权和合规要求决定数据能放在哪 |
| **可用区（AZ）** | 同一 Region 内电力、网络相互独立的机房 | 生产环境至少跨两个 AZ 部署，单机房故障不影响服务 |
| **边缘节点** | CDN、DNS、边缘计算的接入点 | 静态资源和 TLS 终止下沉到边缘 |

同一 Region 内跨 AZ 的网络延迟通常在毫秒级以内，适合做同步复制；跨 Region 延迟高、流量费贵，一般只做异步复制和容灾。跨 Region 多活的设计见 [多活与容灾](/high-avail/9_multi_active)。

---

## 三、六大云厂商核心服务对照

下表是本站唯一维护的跨厂商对照表，[国际云平台](./15_cloud_global) 和 [国内云平台](./14_cloud_domestic) 只讲各家的特色服务。

| 服务类型 | AWS | Azure | GCP | 阿里云 | 腾讯云 | 华为云 |
|---------|-----|-------|-----|-------|-------|-------|
| 云主机 | EC2 | Virtual Machines | Compute Engine | ECS | CVM | ECS |
| 托管 Kubernetes | EKS | AKS | GKE | ACK | TKE | CCE |
| Serverless 函数 | Lambda | Azure Functions | Cloud Run functions | 函数计算 FC | 云函数 SCF | FunctionGraph |
| Serverless 应用 / 容器 | ECS on Fargate（Express Mode） | Container Apps | Cloud Run | SAE | TKE 超级节点 / 云托管 | CCI |
| 对象存储 | S3 | Blob Storage | Cloud Storage | OSS | COS | OBS |
| 块存储 | EBS | Managed Disks | Persistent Disk / Hyperdisk | 云盘（ESSD） | 云硬盘 CBS | 云硬盘 EVS |
| 关系型数据库 | RDS / Aurora | Azure Database for MySQL / PostgreSQL、Azure SQL Database | Cloud SQL / AlloyDB | RDS / PolarDB | TencentDB for MySQL / TDSQL-C | RDS / GaussDB |
| 缓存（Redis 兼容） | ElastiCache（Valkey / Redis OSS） | Azure Managed Redis | Memorystore | 云数据库 Tair（兼容 Redis） | 云数据库 Redis | 分布式缓存 DCS |
| 消息队列 | SQS / SNS / MSK（Kafka） | Service Bus / Event Hubs | Pub/Sub | 云消息队列 RocketMQ / Kafka、轻量消息队列（原 MNS） | TDMQ（RocketMQ / Pulsar / RabbitMQ）、CKafka | 分布式消息服务 DMS（Kafka / RocketMQ / RabbitMQ） |
| 负载均衡 | ALB / NLB | Load Balancer / Application Gateway | Cloud Load Balancing | CLB / ALB / NLB | CLB | ELB |
| CDN | CloudFront | Front Door | Cloud CDN | CDN / ESA | CDN / EdgeOne | CDN |
| DNS | Route 53 | Azure DNS | Cloud DNS | 云解析 DNS | DNSPod | 云解析服务 DNS |
| 私有网络 | VPC | Virtual Network | VPC | 专有网络 VPC | 私有网络 VPC | 虚拟私有云 VPC |
| 监控 | CloudWatch | Azure Monitor | Cloud Monitoring | 云监控 / ARMS | 腾讯云可观测平台 | 云监控服务 CES |
| 身份与权限 | IAM | Microsoft Entra ID + Azure RBAC | Cloud IAM | RAM | CAM | IAM |
| 密钥管理 | KMS / Secrets Manager | Key Vault | Cloud KMS / Secret Manager | 密钥管理服务 KMS | 密钥管理系统 KMS / 凭据管理系统 SSM | 数据加密服务 DEW |

几个近年的改名和换代，查旧资料时容易对不上：

- **Azure**：Azure AD 改名 Microsoft Entra ID；Azure Cache for Redis 进入退役流程，新建推荐 Azure Managed Redis；Azure CDN（classic）逐步退役，CDN 能力由 Front Door 承接
- **GCP**：Cloud Functions 并入 Cloud Run，改名 Cloud Run functions
- **AWS**：ElastiCache 新增 Valkey 引擎（Redis 开源分支）；原 SageMaker 改名 SageMaker AI；App Runner 2026 年 4 月起不再接受新客户，官方推荐 ECS Express Mode
- **阿里云**：云数据库 Redis 版与 Tair 合并为「云数据库 Tair（兼容 Redis）」；MNS 改名「轻量消息队列（原 MNS）」；负载均衡 SLB 现在是产品族统称，下分 CLB（传统型，即原来的 SLB）、ALB（七层）和 NLB（四层）

::: tip 对照表只说明「同类」，不代表能力等价
同是托管 Redis，各家支持的版本、集群模式和命令子集都不同；同是消息队列，SQS 是简单队列，RocketMQ 支持事务消息和顺序消息。迁移前要对照目标产品的文档逐项确认。消息队列的选型见 [消息队列](/messaging/0_overview)，对象存储的设计见 [对象存储](/architecture/4_object_storage)。
:::

---

## 四、云原生与传统架构

| 对比维度 | 传统架构 | 云原生架构 |
|---------|---------|----------|
| 部署单元 | 物理机 / 虚拟机 | 容器镜像（Docker + Kubernetes） |
| 扩缩容 | 人工申请机器，天级到周级 | 自动：Pod 秒级扩容，节点（Cluster Autoscaler / Karpenter）分钟级扩容 |
| 交付频率 | 周级 / 月级发布 | 持续交付，每天可多次发布 |
| 故障恢复 | 人工介入 | 健康检查失败后自动重启或替换实例 |
| 资源利用率 | 低（按峰值预留） | 较高（按需弹性，但要配好 requests / limits） |
| 运维门槛 | 低，单体应用部署简单 | 高，要掌握容器、K8s、可观测性等一整套技术 |

节点扩容要经历「申请云主机 → 启动 → 加入集群 → 拉镜像」，比 Pod 扩容慢一个量级。所以大促这类可预期的流量高峰，仍然要提前扩好节点，不能只靠自动扩缩。Pod、HPA 与资源模型见 [Kubernetes](./6_kubernetes)，容量规划见 [高并发](/high-con/0_overview)。

---

## 五、选型维度

云厂商的价格、免费额度和市场份额变化很快，这里只做定性描述，需要具体数字时请查官网定价页或计算器。

### 1、面向国内用户

| 维度 | 说明 |
|------|------|
| **ICP 备案** | 在中国大陆服务器上用域名提供网站服务必须先备案，备案在接入的云厂商处办理，换云厂商要做接入变更 |
| **数据合规** | 《网络安全法》《数据安全法》《个人信息保护法》要求重要数据和个人信息原则上境内存储；确需出境的，按 2024 年施行的《促进和规范数据跨境流动规定》判断是否要做数据出境安全评估、签订个人信息出境标准合同或通过认证。金融、医疗等行业还有各自的监管要求。技术侧的落地做法见 [数据安全](/security/7_data_security) |
| **等保** | 涉及等级保护的系统要选择提供等保合规方案的云厂商和 Region |
| **网络质量** | 国内云在境内有 BGP 多线接入，访问延迟和稳定性优于境外节点 |
| **技术支持** | 中文文档、工单和本地化服务团队 |

### 2、面向海外用户

| 维度 | 说明 |
|------|------|
| **全球覆盖** | AWS 和 Azure 的 Region 覆盖最广；GCP 骨干网质量好；国内云厂商的海外 Region 适合「国内团队、海外用户」的出海业务 |
| **数据主权** | 欧盟 GDPR 等法规对个人数据的存放和跨境传输有要求，Region 选择要先过法务 |
| **生态成熟度** | AWS 服务种类最多，第三方工具和社区资料最丰富 |
| **云原生与 AI** | GCP 在 Kubernetes（GKE）、TPU 和 Vertex AI 上有优势；Azure 与 Microsoft 365、Entra ID 及 OpenAI 模型集成紧密 |

### 3、成本模型

成本差异主要来自计费方式和流量，而不是单价：

- **按需、承诺用量与竞价**：按需最灵活也最贵；承诺 1 年或 3 年用量能换取明显折扣，AWS 有预留实例（RI）和更灵活的 Savings Plans，国内云有包年包月和节省计划；Spot / 抢占式实例最便宜，但可能被随时回收，只适合可中断的批处理和无状态任务
- **流量费**：入站流量通常免费，出公网和跨 Region 流量按量计费，是很多团队账单里最容易被低估的一项；静态资源走 CDN、同 Region 内走内网能省下不少
- **存储分层**：冷数据用生命周期规则自动转到低频、归档存储类型（如 S3 Glacier 系列、OSS 归档存储）；归档类型取回慢且有取回费用，不适合会被频繁访问的数据
- **托管服务的隐性成本**：托管数据库、NAT 网关、负载均衡按小时计费，开发、测试环境用完不关会持续扣费；用标签区分环境和团队，配合预算告警做成本归属

::: tip 估算成本的正确姿势
用各家官方的价格计算器按「实例规格 × 时长 + 存储 + 流量 + 托管服务」逐项估算，再乘上冗余系数（跨 AZ 双副本、预留扩容余量）。不要拿某篇文章里的价格截图做决策，云厂商调价很频繁。
:::

---

## 小结

- 云计算的五个特征是按需自助、网络访问、资源池化、快速弹性和计量计费
- IaaS → PaaS → FaaS → SaaS，云厂商管的层越来越多；无论哪种模型，数据、账号和权限都是用户的责任
- 生产环境至少跨两个可用区；跨 Region 只做异步复制和容灾
- 六大云厂商的同类服务以第三节对照表为准，迁移前逐项核对能力差异
- 国内业务先看备案和数据合规，海外业务先看覆盖范围和数据主权；成本的大头往往是流量和闲置的托管服务

后面三篇分别讲国际云、国内云和 Cloudflare，都只写各家自己的特色；跨厂商的服务对照只在本篇第三节维护。

## 参考资料

- NIST SP 800-145 The NIST Definition of Cloud Computing：[https://csrc.nist.gov/pubs/sp/800/145/final](https://csrc.nist.gov/pubs/sp/800/145/final)
- AWS 责任共担模型：[https://aws.amazon.com/compliance/shared-responsibility-model/](https://aws.amazon.com/compliance/shared-responsibility-model/)
- AWS 全球基础设施（Region 与可用区）：[https://aws.amazon.com/about-aws/global-infrastructure/](https://aws.amazon.com/about-aws/global-infrastructure/)
- Azure 服务与 AWS 服务对照：[https://learn.microsoft.com/azure/architecture/aws-professional/](https://learn.microsoft.com/azure/architecture/aws-professional/)
- Google Cloud 与 AWS、Azure 产品对照：[https://cloud.google.com/docs/get-started/aws-azure-gcp-service-comparison](https://cloud.google.com/docs/get-started/aws-azure-gcp-service-comparison)
- 阿里云 云数据库 Tair（兼容 Redis）合并公告：[https://help.aliyun.com/zh/redis/product-overview/notice-apsaradb-for-redis-and-tair-have-been-merged](https://help.aliyun.com/zh/redis/product-overview/notice-apsaradb-for-redis-and-tair-have-been-merged)
- 阿里云 轻量消息队列（原 MNS）产品简介：[https://help.aliyun.com/zh/mns/product-overview/what-is-mns](https://help.aliyun.com/zh/mns/product-overview/what-is-mns)
- 国家网信办《促进和规范数据跨境流动规定》：[https://www.gov.cn/gongbao/2024/issue_11366/202405/content_6954192.html](https://www.gov.cn/gongbao/2024/issue_11366/202405/content_6954192.html)

> 下一篇：[国内云平台](./14_cloud_domestic)
