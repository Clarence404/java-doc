# 国际云平台

> 以 AWS 为主体，附 Azure / GCP 横向对比。三者均提供全球多 Region 部署，适合出海业务或对开源生态有高要求的场景。

---

## 一、三大厂商概览

| 对比项 | AWS | Azure | GCP |
|-------|-----|-------|-----|
| 市场份额 | ~32%，全球第一 | ~22%，第二 | ~12%，第三 |
| 优势 | 服务最全、生态最成熟 | 企业 / Office 365 / AD 集成 | K8s 原生、AI/ML、大数据 |
| 劣势 | 学习曲线陡、定价复杂 | 部分服务不如 AWS 成熟 | 企业服务相对弱 |
| 适合场景 | 通用互联网、微服务 | 企业内网打通、混合云 | AI 训练、数据分析、K8s |
| 中国区 | 由光环新网/西云数据运营 | 由世纪互联运营 | 无中国大陆节点 |

---

## 二、AWS 核心服务

### 1、计算

| 服务 | 说明 |
|------|------|
| **EC2** | 弹性云服务器，支持多种实例类型（通用/计算优化/内存优化/GPU） |
| **Auto Scaling** | 根据负载自动增减 EC2 实例 |
| **EKS** | 托管 Kubernetes，免运维 Control Plane |
| **ECS** | AWS 自有容器编排服务（Fargate 模式无需管理节点） |
| **Lambda** | Serverless 函数，支持 Java/Node/Python 等，按调用次数计费 |
| **Elastic Beanstalk** | PaaS，上传代码自动完成部署（适合快速验证） |

### 2、存储

| 服务 | 说明 |
|------|------|
| **S3** | 对象存储，99.999999999% 耐久性，支持生命周期策略 |
| **EBS** | 块存储，挂载到 EC2，类似云硬盘 |
| **EFS** | 托管 NFS，多实例共享挂载 |
| **S3 Glacier** | 归档存储，成本极低，适合合规备份 |

### 3、数据库

| 服务 | 说明 |
|------|------|
| **RDS** | 托管关系型数据库，支持 MySQL/PostgreSQL/Oracle/SQL Server |
| **Aurora** | AWS 自研，兼容 MySQL/PostgreSQL，性能最高可达 5x |
| **DynamoDB** | 全托管 NoSQL，毫秒级延迟，无限扩展 |
| **ElastiCache** | 托管 Redis / Memcached |
| **Redshift** | 列式数据仓库，适合 OLAP |

### 4、网络

| 服务 | 说明 |
|------|------|
| **VPC** | 私有网络，子网划分、路由表、安全组 |
| **ALB / NLB** | 应用层（7层）/ 网络层（4层）负载均衡 |
| **CloudFront** | CDN，全球边缘节点加速 |
| **Route 53** | DNS 解析，支持健康检查和流量路由策略 |
| **Direct Connect** | 专线接入，绕过公网，适合混合云 |

### 5、监控与运维

| 服务 | 说明 |
|------|------|
| **CloudWatch** | 指标监控、日志收集、告警规则 |
| **CloudTrail** | API 审计日志，记录所有操作 |
| **X-Ray** | 分布式链路追踪 |
| **Systems Manager** | 批量管理 EC2，参数存储（替代配置中心） |

### 6、安全

| 服务 | 说明 |
|------|------|
| **IAM** | 身份与权限管理，用户/角色/策略 |
| **KMS** | 密钥管理服务 |
| **WAF** | Web 应用防火墙 |
| **Shield** | DDoS 防护 |
| **Secrets Manager** | 密钥/密码托管，支持自动轮换 |

---

## 三、AWS vs Azure vs GCP 核心服务对照

| 服务类型 | AWS | Azure | GCP |
|---------|-----|-------|-----|
| 虚拟机 | EC2 | Virtual Machines | Compute Engine |
| 托管 K8s | EKS | AKS | GKE |
| Serverless | Lambda | Azure Functions | Cloud Functions |
| 对象存储 | S3 | Blob Storage | Cloud Storage |
| 关系型数据库 | RDS / Aurora | Azure SQL Database | Cloud SQL |
| NoSQL | DynamoDB | Cosmos DB | Firestore / Bigtable |
| 消息队列 | SQS / SNS | Service Bus | Pub/Sub |
| CDN | CloudFront | Azure CDN | Cloud CDN |
| 监控 | CloudWatch | Azure Monitor | Cloud Monitoring |
| IAM | IAM | Azure AD | Cloud IAM |
| 数据仓库 | Redshift | Synapse Analytics | BigQuery |
| AI/ML 平台 | SageMaker | Azure ML | Vertex AI |

---

## 四、Java 后端常用组合

```
典型微服务部署架构（AWS）：

Route 53（DNS）
    ↓
CloudFront（CDN / WAF）
    ↓
ALB（负载均衡）
    ↓
EKS（Spring Boot 容器集群）
    ↓
RDS Aurora（MySQL）+ ElastiCache（Redis）+ SQS（消息队列）
    ↓
S3（文件存储）+ CloudWatch（监控）
```

> [!warning] 待补充：AWS 实战操作（控制台 / CLI / SDK 使用示例）
