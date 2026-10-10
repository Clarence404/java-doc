---
description: HCL、State 与锁、Module、多环境、Terraform vs OpenTofu / Pulumi
---

# Terraform

> 前置阅读：[云计算概览](./13_cloud_overview)、[Linux 概览](./1_linux)

Terraform 是 **IaC（Infrastructure as Code，基础设施即代码）** 工具：用 HCL 描述云上的服务器、网络、数据库、DNS，再由 Terraform 调用云厂商 API 把描述变成真实资源，并记录资源现状。本篇以 Terraform 1.16（2026 年 10 月的稳定版）和 OpenTofu 1.13 为基线，示例使用阿里云 Provider。

---

## 一、定位与许可证

**解决的问题**：在云控制台手工点配置，无法重复、没有版本记录、多环境容易不一致。写成代码后，基础设施可以进 Git、走 PR 评审、一键复制出新环境。

**和 Helm / Argo CD 的分工**：

- Terraform 管**云资源**：VPC、ECS、RDS、负载均衡、DNS、K8s 集群本身
- [Helm](./8_helm) / [Argo CD](./9_argocd) 管 **K8s 集群里的应用**
- [Ansible](./12_ansible) 管**机器内部**：装软件、改配置、发应用

**2023 年以后的变化**：

- 2023 年 8 月，HashiCorp 把 Terraform 从 MPL 2.0 改为 **BSL 1.1**（Business Source License），1.6 起的版本不再是 OSI 认可的开源软件。企业内部自用不受影响，限制的是拿它做与 HashiCorp 竞争的托管产品
- 社区随即从 1.5.x 分叉出 **OpenTofu**，继续使用 MPL 2.0，由 Linux Foundation 托管，2025 年 4 月进入 CNCF Sandbox
- 2024 年 Terraform Cloud 更名为 **HCP Terraform**；2025 年 2 月 IBM 完成对 HashiCorp 的收购

两者的取舍放在第七节。

---

## 二、核心概念

| 概念 | 说明 |
|------|------|
| **Provider** | 对接某个平台 API 的插件（阿里云、AWS、Kubernetes、Cloudflare 等），提供一组资源类型 |
| **Resource** | 要创建并管理的资源，如一台 ECS、一个 VPC、一条 DNS 记录 |
| **Data Source** | 只读查询已存在的信息（可用区、最新镜像），不创建任何东西 |
| **State** | 状态文件 `terraform.tfstate`，记录「代码里的资源」与「云上真实资源 ID」的对应关系 |
| **Backend** | State 存在哪里：本地文件，或 OSS / S3 / HCP Terraform 等远程存储 |
| **Module** | 一组资源的封装，像函数一样有输入（variable）和输出（output），可复用 |
| **Variable / Output** | 输入参数和输出值，Output 可供其他模块或外部工具（如 Ansible）读取 |

Terraform 是**声明式**的：你描述「应该有什么」，它对比 State 和真实资源算出差异，再决定创建、修改还是删除。

---

## 三、HCL 示例：一台可公网访问的 ECS

下面的配置从零创建 VPC、交换机、安全组和一台 ECS。可用区、实例规格和镜像都通过 Data Source 动态查询，不写死过期的 ID。

```hcl
# main.tf
terraform {
  required_version = ">= 1.11"

  required_providers {
    alicloud = {
      source  = "aliyun/alicloud"
      version = "~> 1.260" # 允许 1.x 的后续小版本，不会自动升到 2.0
    }
  }
}

provider "alicloud" {
  region = var.region # 凭证通过环境变量 ALIBABA_CLOUD_ACCESS_KEY_ID / ALIBABA_CLOUD_ACCESS_KEY_SECRET 提供
}

variable "region" {
  type    = string
  default = "cn-hangzhou"
}

variable "name" {
  type    = string
  default = "demo-web"
}

variable "admin_cidr" {
  description = "允许 SSH 登录的来源网段，建议填办公出口 IP"
  type        = string
  default     = "203.0.113.10/32"
}

# 查一个 2 核 4G、支持 ESSD 云盘的实例规格，并取它所在的可用区
data "alicloud_instance_types" "c2m4" {
  cpu_core_count       = 2
  memory_size          = 4
  network_type         = "Vpc"
  system_disk_category = "cloud_essd"
}

# 查最新的 Ubuntu 24.04 公共镜像
data "alicloud_images" "ubuntu" {
  owners      = "system"
  name_regex  = "^ubuntu_24_04_x64"
  most_recent = true
}

locals {
  instance_type = data.alicloud_instance_types.c2m4.instance_types[0].id
  zone_id       = data.alicloud_instance_types.c2m4.instance_types[0].availability_zones[0]
}

resource "alicloud_vpc" "main" {
  vpc_name   = var.name
  cidr_block = "172.16.0.0/16"
}

resource "alicloud_vswitch" "main" {
  vswitch_name = var.name
  vpc_id       = alicloud_vpc.main.id
  cidr_block   = "172.16.1.0/24"
  zone_id      = local.zone_id
}

resource "alicloud_security_group" "web" {
  security_group_name = var.name
  vpc_id              = alicloud_vpc.main.id
}

resource "alicloud_security_group_rule" "http" {
  security_group_id = alicloud_security_group.web.id
  type              = "ingress"
  ip_protocol       = "tcp"
  nic_type          = "intranet" # VPC 安全组固定填 intranet
  port_range        = "80/80"
  cidr_ip           = "0.0.0.0/0"
}

resource "alicloud_security_group_rule" "ssh" {
  security_group_id = alicloud_security_group.web.id
  type              = "ingress"
  ip_protocol       = "tcp"
  nic_type          = "intranet"
  port_range        = "22/22"
  cidr_ip           = var.admin_cidr
}

resource "alicloud_instance" "web" {
  instance_name              = var.name
  instance_type              = local.instance_type
  image_id                   = data.alicloud_images.ubuntu.images[0].id
  availability_zone          = local.zone_id
  vswitch_id                 = alicloud_vswitch.main.id
  security_groups            = [alicloud_security_group.web.id]
  system_disk_category       = "cloud_essd"
  instance_charge_type       = "PostPaid"
  internet_charge_type       = "PayByTraffic"
  internet_max_bandwidth_out = 5 # 大于 0 才会分配公网 IP
}

output "public_ip" {
  value = alicloud_instance.web.public_ip
}

output "private_ip" {
  value = alicloud_instance.web.private_ip
}
```

几个读代码的要点：

- **引用即依赖**：`alicloud_vpc.main.id` 这样的引用会让 Terraform 自动推导创建顺序（先 VPC，再交换机，再实例），不用手写顺序
- **`required_providers` 必须写**：`source` 指明 Provider 来源，`version` 约束版本；`terraform init` 后生成的 `.terraform.lock.hcl` 锁定具体版本，要提交到 Git
- **凭证不进代码**：AccessKey 走环境变量或 RAM 角色，不要写进 `.tf`，也不要通过 `-backend-config` 传，否则可能落进 `.terraform` 目录和 plan 文件
- 示例没有配置登录凭证，实际使用时可以加 `key_name`（密钥对）或在控制台重置密码

---

## 四、核心工作流

![Terraform 工作流](../assets/cloud-native/terraform-workflow.svg)

```bash
# 1. 初始化：下载 Provider、连接 Backend，生成 .terraform.lock.hcl
terraform init

# 2. 格式化与静态检查（CI 里常用 -check，只报错不改文件）
terraform fmt -check -recursive
terraform validate

# 3. 生成变更计划并保存，确保 apply 执行的正是评审过的内容
terraform plan -out=tfplan
terraform show tfplan

# 4. 按计划执行
terraform apply tfplan

# 查看 State 里管理着哪些资源
terraform state list

# 销毁本配置管理的全部资源（会先展示计划并要求确认）
terraform destroy
```

**plan 输出怎么看**：`+` 新建、`~` 原地修改、`-` 删除、`-/+` 先删后建（替换）。评审时重点盯 `-/+`：Provider 把部分字段标记为 ForceNew（如 ECS 的可用区、交换机的网段），改动它们会触发替换，意味着资源被销毁重建、上面的数据随之丢失。

**`plan -out` + `apply tfplan`** 是团队协作的标准姿势：PR 阶段由 CI 跑 plan 并把结果贴到 PR，合并后执行同一份计划文件。直接 `terraform apply` 会重新计算一次，期间若有人改了云上资源，执行的可能不是你看到的那份。

---

## 五、State 与状态锁

State 是 Terraform 认知世界的唯一依据。它解决两件事：代码里的 `alicloud_instance.web` 对应云上哪个实例 ID；哪些资源归这份代码管理（删掉代码里的资源块，下次 apply 就会删除对应实例）。

**为什么必须用远程 State + 锁**：

- State 放在个人电脑上，别人拿不到，各自 apply 会重复创建资源
- 只放远程不加锁，两个人同时 apply 会互相覆盖 State，导致资源「失联」（云上存在但 State 里没有）
- State 里有资源属性的明文（包括数据库初始密码等），存储桶要开加密、收紧访问权限，不要提交到 Git

阿里云 OSS Backend 的锁依赖**表格存储 Tablestore**，表的主键须为 `LockID`（String 类型）：

```hcl
terraform {
  backend "oss" {
    bucket              = "my-terraform-state"
    prefix              = "envs/prod"
    key                 = "terraform.tfstate"
    region              = "cn-hangzhou"
    encrypt             = true
    tablestore_endpoint = "https://tf-lock.cn-hangzhou.ots.aliyuncs.com"
    tablestore_table    = "statelock"
  }
}
```

AWS S3 Backend 从 Terraform 1.11 起支持原生锁，在桶里写一个 `.tflock` 文件即可，不再需要 DynamoDB 表（`dynamodb_table` 已标记废弃）：

```hcl
terraform {
  backend "s3" {
    bucket       = "my-terraform-state"
    key          = "envs/prod/terraform.tfstate"
    region       = "us-east-1"
    encrypt      = true
    use_lockfile = true
  }
}
```

> [!warning]
> `backend` 块里不能引用变量。多环境共用一份 backend 写法时，用「部分配置」在 init 时补参数，例如 `terraform init -backend-config="prefix=envs/dev"`。

另一类做法是把 State 和执行都交给平台：**HCP Terraform**（HashiCorp 托管，计费方式以官网为准）或自建的 **Atlantis**（在 PR 评论里触发 plan / apply）。它们自带锁、执行记录和权限控制，适合团队规模变大以后。

---

## 六、Module 与多环境

### 1、Module：把资源组合封装成「函数」

把第三节的 VPC + 安全组 + ECS 收进 `modules/web`，对外暴露几个变量和输出：

```hcl
# modules/web/variables.tf
variable "name" {
  type = string
}

variable "instance_count" {
  type    = number
  default = 1
}
```

```hcl
# modules/web/outputs.tf（main.tf 里的 alicloud_instance 加上 count = var.instance_count）
output "public_ips" {
  value = alicloud_instance.web[*].public_ip
}
```

调用方只关心参数，不关心内部细节：

```hcl
# envs/prod/main.tf
module "web" {
  source         = "../../modules/web"
  name           = "prod-web"
  instance_count = 2
}

output "web_ips" {
  value = module.web.public_ips
}
```

Module 的 `source` 可以是本地路径、Git 仓库（`git::https://...?ref=v1.2.0`）或 Registry 地址。团队内共享的 Module 要打 tag 并按版本引用，避免一次改动影响所有环境。

### 2、多环境：目录隔离优先

```text
infra/
├── modules/
│   └── web/              # 共享模块
└── envs/
    ├── dev/
    │   ├── main.tf       # 调用 ../../modules/web
    │   ├── backend.tf    # prefix = envs/dev
    │   └── terraform.tfvars
    └── prod/
        ├── main.tf
        ├── backend.tf    # prefix = envs/prod
        └── terraform.tfvars
```

| 方式 | 做法 | 适合 |
|------|------|------|
| 目录隔离 | 每个环境一个目录、一份独立 State，共享 Module | 生产环境，权限和 Backend 可以分开 |
| Workspace | 同一份代码，`terraform workspace new dev` 切换多份 State | 结构完全相同的临时环境（如每个 PR 一套） |

Workspace 的问题是所有环境共用同一份代码和 Backend 配置，切错 workspace 就会把 dev 的变更打到 prod。生产环境推荐目录隔离。

### 3、接管与重构

- **`import` 块**（1.5+）：把手工创建的存量资源纳入管理，配合 `terraform plan -generate-config-out=generated.tf` 自动生成对应的 HCL
- **`moved` 块**：资源改名或挪进 Module 时声明新旧地址，避免 Terraform 误判为「删旧建新」
- **`removed` 块**（1.7+）：让 Terraform 不再管理某个资源，但不删除云上实例

```hcl
import {
  to = alicloud_vpc.legacy
  id = "vpc-bp1xxxxxxxxxxxxxxxx"
}

moved {
  from = alicloud_instance.web
  to   = module.web.alicloud_instance.web[0]
}

removed {
  from = alicloud_instance.old_batch
  lifecycle {
    destroy = false
  }
}
```

---

## 七、Terraform vs OpenTofu vs Pulumi

### 1、Terraform 与 OpenTofu

| | Terraform | OpenTofu |
|---|---|---|
| 许可证 | BSL 1.1（source-available） | MPL 2.0（开源） |
| 归属 | HashiCorp（IBM） | Linux Foundation，CNCF Sandbox |
| 命令 | `terraform` | `tofu`，子命令基本一致 |
| 兼容性 | — | 从 1.5.x 分叉，HCL 与 State 格式大体兼容，Provider 通用 |
| 差异化能力 | 与 HCP Terraform 深度集成 | 客户端 State 加密（1.7+）等社区特性 |
| 2026-10 稳定版 | 1.16.x | 1.13.x |

**怎么选**：只是在公司内部用它管自己的云资源，两者都可以；已经深度用 HCP Terraform 的团队留在 Terraform；对许可证敏感（要做对外的平台产品、或公司要求 OSI 开源）选 OpenTofu。两者在新特性上已逐渐分叉，迁移前用 `tofu plan` 跑一遍确认无差异。

### 2、Pulumi：用通用语言写 IaC

[Pulumi](https://www.pulumi.com/) 用 TypeScript、Python、Go、Java、C# 代替 HCL。下面是 Java 版本，在 AWS 创建安全组和 3 台实例：

```java
package myproject;

import com.pulumi.Pulumi;
import com.pulumi.aws.ec2.Instance;
import com.pulumi.aws.ec2.InstanceArgs;
import com.pulumi.aws.ec2.SecurityGroup;
import com.pulumi.aws.ec2.SecurityGroupArgs;
import com.pulumi.aws.ec2.inputs.SecurityGroupIngressArgs;
import com.pulumi.core.Output;

public class App {
    public static void main(String[] args) {
        Pulumi.run(ctx -> {
            // 镜像 ID 来自配置：pulumi config set amiId ami-xxxxxxxx
            var amiId = ctx.config().require("amiId");

            var group = new SecurityGroup("web-sg", SecurityGroupArgs.builder()
                .ingress(SecurityGroupIngressArgs.builder()
                    .protocol("tcp").fromPort(80).toPort(80)
                    .cidrBlocks("0.0.0.0/0")
                    .build())
                .build());

            // HCL 里要用 count / for_each 表达的逻辑，这里就是普通循环
            for (int i = 0; i < 3; i++) {
                new Instance("web-" + i, InstanceArgs.builder()
                    .ami(amiId)
                    .instanceType("t3.micro")
                    .vpcSecurityGroupIds(Output.all(group.id()))
                    .build());
            }
        });
    }
}
```

| | Terraform / OpenTofu | Pulumi |
|---|---|---|
| 语言 | HCL（专用 DSL） | TypeScript / Python / Go / Java / C# |
| 逻辑表达 | `count` / `for_each` / 内置函数，复杂逻辑别扭 | 原生循环、条件、抽象，可写单元测试 |
| State | 自管 Backend（OSS / S3）或 HCP Terraform | 默认 Pulumi Cloud，也可自建 Backend（S3 等） |
| 生态 | Provider 最全，社区模块多 | 可桥接 Terraform Provider |
| 团队门槛 | 运维友好，学一门小 DSL | 开发友好，就是写代码 |

**选型速记**：运维主导、资源结构相对固定，选 Terraform / OpenTofu，生态和人才池更大；开发主导、需要按租户动态生成大量资源，Pulumi 的通用语言优势才真正兑现。

---

## 八、适用场景与边界

适合：

- 云基础设施的创建与变更：VPC、子网、安全组、ECS、RDS、负载均衡、DNS
- 托管 K8s 集群本身（ACK / EKS 的集群和节点池）
- 一套 Module 复制出 dev / staging / prod 三套同构环境
- 多云统一管理：同一套流程管理多家云厂商和 SaaS（Cloudflare、GitHub 等都有 Provider）

不适合：

- K8s 集群内的应用发布，交给 [Helm](./8_helm) / [Argo CD](./9_argocd)
- 机器内部的软件安装与配置，交给 [Ansible](./12_ansible) 或镜像构建
- 频繁变化的业务数据，Terraform 管的是「基础设施的形状」

---

## 小结

- Terraform 用 HCL 声明期望状态，`plan` 对比 State 算出差异，`apply` 调用云 API 执行；评审 `plan -out` 产出的计划文件，再 `apply` 同一份
- State 是唯一事实来源：团队协作必须远程存储 + 状态锁（OSS 配 Tablestore，S3 用 `use_lockfile`），并加密、限权
- Module 封装复用，多环境优先用目录隔离各自的 State；`import` / `moved` / `removed` 块负责接管存量和安全重构
- 1.6 起 Terraform 是 BSL 许可，OpenTofu 是 MPL 开源分支；Pulumi 用通用语言写 IaC，适合开发主导的团队

## 参考资料

- Terraform 官方文档：[developer.hashicorp.com/terraform/docs](https://developer.hashicorp.com/terraform/docs)
- Terraform OSS Backend（Tablestore 锁）：[developer.hashicorp.com/terraform/language/backend/oss](https://developer.hashicorp.com/terraform/language/backend/oss)
- Terraform S3 Backend（use_lockfile）：[developer.hashicorp.com/terraform/language/backend/s3](https://developer.hashicorp.com/terraform/language/backend/s3)
- Terraform import / moved / removed 块：[developer.hashicorp.com/terraform/language/import](https://developer.hashicorp.com/terraform/language/import)
- Terraform 版本发布：[github.com/hashicorp/terraform/releases](https://github.com/hashicorp/terraform/releases)
- 阿里云 Provider 文档：[registry.terraform.io/providers/aliyun/alicloud](https://registry.terraform.io/providers/aliyun/alicloud/latest/docs)
- OpenTofu 官方文档：[opentofu.org/docs](https://opentofu.org/docs/)
- OpenTofu CNCF 项目页：[cncf.io/projects/opentofu](https://www.cncf.io/projects/opentofu/)
- Pulumi Java 文档：[pulumi.com/docs/iac/languages-sdks/java](https://www.pulumi.com/docs/iac/languages-sdks/java/)

> 下一篇：[Ansible](./12_ansible)
