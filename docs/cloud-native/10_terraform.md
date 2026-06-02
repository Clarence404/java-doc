# Terraform

> 参考资料：
> * 官方文档：[https://developer.hashicorp.com/terraform/docs](https://developer.hashicorp.com/terraform/docs)
> * Terraform Registry（Provider / Module）：[https://registry.terraform.io/](https://registry.terraform.io/)

## 一、是什么

**Terraform** 是 HashiCorp 开源的 **IaC（Infrastructure as Code，基础设施即代码）** 工具。

用代码（HCL 语言）描述云基础设施（服务器、网络、数据库、DNS……），Terraform 负责将这些描述转化为实际的云资源，并追踪资源状态。

**解决的核心问题**：手动在云控制台点点点 → 配置不可重复、无版本记录、多环境不一致。Terraform 让基础设施像代码一样可版本管理、可 Review、可复用。

> Terraform vs Helm / Argo CD 的区别：
> - Terraform：管理**云资源**（VPC、ECS、RDS、DNS 等），偏"建房子"
> - Helm / Argo CD：管理**K8s 内的应用部署**，偏"在房子里布置家具"

## 二、核心概念

| 概念 | 说明 |
|------|------|
| **Provider** | 对接不同云厂商的插件（AWS / 阿里云 / GCP / Azure / K8s 等），每个 Provider 提供一组资源类型 |
| **Resource** | 要创建的云资源，如一台 ECS、一个 VPC、一条 DNS 记录 |
| **Data Source** | 只读查询已有资源（不创建），用于引用已存在的数据 |
| **State** | Terraform 维护的状态文件（`.tfstate`），记录"当前实际资源"与"代码定义"的映射关系 |
| **Module** | 可复用的资源组合，类似函数，封装一组常用基础设施模式 |
| **Variable** | 输入变量，让配置可参数化（区分 dev / prod 环境） |
| **Output** | 输出值，暴露资源属性（如 IP、ID）供其他模块引用 |

## 三、HCL 语法示例

```hcl
# 配置 Provider（以阿里云为例）
terraform {
  required_providers {
    alicloud = {
      source  = "aliyun/alicloud"
      version = "~> 1.200"
    }
  }
}

provider "alicloud" {
  region = var.region
}

# 变量定义
variable "region" {
  default = "cn-hangzhou"
}

# 创建一个 ECS 实例
resource "alicloud_instance" "web" {
  instance_name        = "my-web-server"
  instance_type        = "ecs.c6.large"
  image_id             = "ubuntu_22_04_x64_20G_alibase_20240530.vhd"
  security_groups      = [alicloud_security_group.default.id]
  vswitch_id           = alicloud_vswitch.default.id
}

# 输出实例 IP
output "instance_public_ip" {
  value = alicloud_instance.web.public_ip
}
```

## 四、核心工作流

```bash
# 1. 初始化（下载 Provider 插件）
terraform init

# 2. 预览变更（类似 git diff，不实际执行）
terraform plan

# 3. 应用变更（创建 / 修改资源）
terraform apply

# 4. 销毁资源
terraform destroy

# 查看当前状态
terraform show

# 格式化代码
terraform fmt
```

## 五、State 状态管理

Terraform 用 `.tfstate` 文件追踪已创建的资源。**多人协作时必须使用远程 State**，否则会产生冲突：

```hcl
# 将 State 存储在阿里云 OSS（推荐）
terraform {
  backend "oss" {
    bucket = "my-terraform-state"
    prefix = "envs/prod"
    region = "cn-hangzhou"
  }
}
```

常用远程 Backend：阿里云 OSS / AWS S3 / Terraform Cloud

## 六、多环境管理

```
envs/
├── dev/
│   ├── main.tf
│   └── terraform.tfvars    # dev 环境参数
├── staging/
│   ├── main.tf
│   └── terraform.tfvars
└── prod/
    ├── main.tf
    └── terraform.tfvars    # prod 环境参数
```

不同环境切换只需进入对应目录执行 `terraform apply`，配置通过 `.tfvars` 隔离。

## 七、适用场景

- ✅ 云基础设施的创建与管理（VPC / 子网 / 安全组 / ECS / RDS / 负载均衡）
- ✅ 多云或混合云环境统一管理
- ✅ 环境快速复制（一套代码 apply 出 dev / staging / prod 三套相同架构）
- ✅ 搭配 Argo CD 使用：Terraform 建好基础设施，Argo CD 在上面部署应用
- ❌ 不适合管理 K8s 内部的应用配置（用 Helm / Argo CD）

> [!warning]
> 待补充：Terraform Cloud / Atlantis 实践、Module 封装最佳实践、Import 导入已有资源
