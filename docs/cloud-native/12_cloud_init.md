---
description: 烘焙镜像与启动初始化、cloud-init 模块与阶段、Terraform 传 user-data、Packer 构建与镜像版本
---

# cloud-init 与 Packer

> 前置阅读：[Terraform](./11_terraform)、[Ansible](./12_ansible)

cloud-init 负责开机初始化，Packer 负责把软件提前烘焙进镜像。本篇讲两种初始化思路、#cloud-config、Packer 镜像构建和四个工具的分工，基线为 cloud-init 26.2。

---

## 一、烘焙还是现炸：两种初始化思路

二者补上了 Terraform 造机器与 Ansible 做配置之间的空档；版本基线为 cloud-init 26.2 和 Packer 1.16。

上两篇里，Terraform 负责把机器造出来，Ansible 负责登上去配置。但还有两个问题没解决：机器刚创建、Ansible 还没连上之前，谁来建用户、装 JDK？每台机器都从零装一遍软件，扩容 20 台时慢不慢、装出来的是否完全一致？本篇的两个工具分别回答这两个问题。

| | 烘焙（Bake）：黄金镜像 | 现炸（Fry）：启动时初始化 |
|---|---|---|
| 做法 | 构建期把 OS 补丁、JDK、Agent 装进镜像 | 用公共镜像开机，启动脚本现场安装配置 |
| 工具 | Packer | cloud-init（配合 Terraform 传入 user-data） |
| 启动速度 | 快，开机即用，适合弹性伸缩 | 慢，每台都要下载安装，受外网和软件源影响 |
| 一致性 | 高，所有实例来自同一个镜像版本 | 取决于启动那一刻软件源里的版本 |
| 改动成本 | 改一行也要重新构建镜像 | 改脚本即可，下次开机生效 |
| 适合放什么 | 慢变、所有实例相同的东西 | 每台不同或频繁变化的东西 |

实际项目很少二选一，而是**半烘焙**：

- **进镜像**：系统补丁、JDK、node_exporter、OpenTelemetry Java Agent、安全基线、时区与内核参数
- **开机注入**：环境名、配置中心地址、主机名、要部署的应用版本、启动服务
- **不要进镜像**：密钥和证书（镜像会被复制、共享，密钥进去就收不回来），交给 KMS / Secrets Manager 在运行时读取，见 [数据安全](/security/7_data_security)

![Packer、Terraform、cloud-init、Ansible 的分工](../assets/cloud-native/cloud-init-tool-division.svg)

---

## 二、cloud-init 基础

cloud-init 是 Canonical 维护的实例初始化工具，几乎所有云厂商的 Linux 公共镜像（阿里云、AWS、Azure、GCP 的 Ubuntu / RHEL / Rocky 等）都预装了它。实例首次启动时，它从**数据源**（云厂商的元数据服务、或挂载的配置盘）读取 **user-data**，按其中的指令完成初始化。

### 1、user-data 的几种格式

cloud-init 根据 user-data 的**第一行**判断格式：

| 首行 | 格式 | 说明 |
|------|------|------|
| `#cloud-config` | 声明式 YAML | 最常用，调用各模块，可做 schema 校验 |
| `#!/bin/bash` | Shell 脚本 | 在最后阶段执行一次，简单但没有幂等和校验 |
| `## template: jinja` | Jinja 模板 | 第二行再写 `#cloud-config` 等，可引用实例元数据（如 `{{ v1.region }}`） |
| `Content-Type: multipart/mixed` | MIME 多段 | 把 cloud-config 和脚本组合在一起 |

### 2、常用模块

| 模块（键） | 作用 |
|------|------|
| `users` / `groups` | 创建用户和组、配置 sudo 与 SSH 公钥 |
| `package_update` / `package_upgrade` / `packages` | 刷新软件源、升级、安装软件包，自动选 apt / dnf |
| `write_files` | 写文件，可设属主和权限；`defer: true` 推迟到用户创建、软件安装之后 |
| `runcmd` | 执行命令；字符串交给 `sh` 解释，列表形式直接执行（不经 shell） |
| `bootcmd` | 每次开机都在很早阶段执行，一般用不到 |

### 3、执行阶段与顺序

![cloud-init 启动阶段](../assets/cloud-native/cloud-init-boot-stages.svg)

写 cloud-config 时要清楚：**YAML 里键的书写顺序不决定执行顺序**，执行顺序由模块所在的阶段决定（发行版在 `/etc/cloud/cloud.cfg` 里定义）。直接影响写法的几条：

- `write_files` 在 Network 阶段执行，早于创建用户，所以属主是自建用户的文件要加 `defer: true`
- `packages` 在 Final 阶段安装，`runcmd` 在 Config 阶段只是写成脚本，真正执行是 Final 阶段的 `scripts_user`，排在装包之后，所以 `runcmd` 里可以放心用刚装的软件
- `users` 列表里要保留 `- default` 并放在第一项，否则发行版默认用户（如 `ubuntu`）不会创建，云平台注入的 SSH 公钥也可能装不上

### 4、只执行一次：重跑的坑

`users`、`packages`、`write_files`、`runcmd` 这些模块的频率都是 **once-per-instance**：同一实例只在首次启动时执行，重启不会再跑。判断依据是实例 ID，cloud-init 在 `/var/lib/cloud/` 下记录了哪些模块已经执行过。

- **改了 user-data 不会自动生效**：在控制台或 Terraform 里修改 user-data 后重启，实例 ID 没变，这些模块不会重跑。要么重建实例，要么在测试机上手工重置
- **手工重跑**：`sudo cloud-init clean --logs --reboot` 清除执行记录和日志并重启，下次开机按「首次启动」处理。只用于调试，生产环境更推荐直接替换实例
- **想每次开机都跑**：放进 `bootcmd`，或把脚本放到 `/var/lib/cloud/scripts/per-boot/`

### 5、排查命令

```bash
# 阻塞等待 cloud-init 全部阶段结束：0 成功，1 失败，2 完成但有可恢复错误
cloud-init status --wait --long

# 模块执行明细与 runcmd 等命令的输出
sudo less /var/log/cloud-init.log
sudo less /var/log/cloud-init-output.log

# 查看实例实际收到的 user-data，以及校验其 schema
sudo cloud-init query userdata
sudo cloud-init schema --system --annotate

# 本地校验写好的文件，不用开机器试错
cloud-init schema -c cloud-init.yaml --annotate

# 各阶段与各模块耗时，排查开机慢
cloud-init analyze blame
```

---

## 三、用 cloud-config 准备一台 Java 服务器

下面的 user-data 让一台全新的 Ubuntu 24.04 开机后自动完成：建运行用户、装 JRE 21、写 systemd 服务文件和应用配置、下载 jar、启动服务。用户名、目录和 unit 内容与 [Linux 概览](./1_linux) 中的 systemd 示例一致；RHEL 系把包名换成 `java-21-openjdk-headless` 即可。

```yaml
#cloud-config
groups:
  - app

users:
  - default                       # 保留发行版默认用户和云平台注入的 SSH 公钥
  - name: app
    primary_group: app
    system: true                  # 系统用户，不建家目录
    shell: /usr/sbin/nologin

package_update: true
packages:
  - openjdk-21-jre-headless
  - curl

write_files:
  - path: /etc/systemd/system/order.service
    permissions: "0644"
    content: |
      [Unit]
      Description=Order Service
      After=network-online.target
      Wants=network-online.target

      [Service]
      Type=simple
      User=app
      Group=app
      WorkingDirectory=/opt/order
      ExecStart=/usr/bin/java -XX:MaxRAMPercentage=70 -jar /opt/order/order.jar
      SuccessExitStatus=143
      Restart=on-failure
      RestartSec=5
      TimeoutStopSec=40
      LimitNOFILE=65535

      [Install]
      WantedBy=multi-user.target

  - path: /opt/order/application.properties
    owner: app:app                # app 用户此时还不存在，必须 defer
    permissions: "0640"
    defer: true
    content: |
      server.port=8080
      spring.profiles.active=prod

runcmd:
  - [curl, -fsSL, --retry, "5", -o, /opt/order/order.jar, "https://artifacts.example.com/order/1.4.2/order.jar"]
  - [systemctl, daemon-reload]
  - [systemctl, enable, --now, order.service]
```

几个细节：

- `runcmd` 用列表形式，参数不经过 shell，不用操心引号和特殊字符；含 `:` 等 YAML 敏感字符的整条字符串命令要加引号
- Spring Boot 默认会读取工作目录下的 `application.properties`，所以配置文件放在 `/opt/order/`，与 `WorkingDirectory` 对应
- 生产中 jar 通常不在开机时下载，而是烘焙进镜像或改用容器；这里演示完整流程，下载地址换成自己的制品库
- 这份配置和 [Ansible](./12_ansible) 第四节的 Playbook 做的是同一件事。区别在于 cloud-init 只在开机时跑一次、不需要 SSH，Ansible 可以反复执行、适合后续变更

---

## 四、从 Terraform 传入 user-data

在 [Terraform](./11_terraform) 第三节的 ECS 示例基础上，把上一节的 YAML 存成模板文件 `cloud-init.yaml.tftpl`，把 jar 地址里的版本号换成 `${app_version}`，再在实例上加 `user_data`：

```hcl
variable "app_version" {
  type    = string
  default = "1.4.2"
}

resource "alicloud_instance" "web" {
  # ……其余参数同 Terraform 一篇的示例

  # 阿里云 Provider 推荐传 base64 编码后的内容
  user_data = base64encode(templatefile("${path.module}/cloud-init.yaml.tftpl", {
    app_version = var.app_version
  }))
}
```

- `templatefile` 用 `${...}` 做插值，模板里如果还有要原样保留的 `${`（如 shell 变量），写成 `$${`
- 阿里云修改 `user_data` 会原地更新并重启实例，但按上一节的规则，once-per-instance 模块不会重跑。AWS 的 `aws_instance` 提供 `user_data_replace_on_change = true`，改 user-data 时直接替换实例，行为更可预期
- 需要把多段 cloud-config 与脚本组合、或 user-data 超过平台大小限制时，用 `hashicorp/cloudinit` Provider 的 `cloudinit_config` 数据源生成 MIME 多段内容（支持 gzip）
- user-data 可以从元数据服务读到，**不要放密码和 AccessKey**；实例通过 RAM 角色 / IAM 角色获取临时凭证再去读密钥服务

---

## 五、Packer：构建版本化镜像

Packer 是 HashiCorp 的镜像构建工具：读取 HCL2 模板，临时启动一台构建机，执行 provisioner 装软件，再把它做成云镜像并清理构建资源。同一份模板可以同时产出 AWS AMI、阿里云自定义镜像、VMware 模板等。

::: warning 许可证
与 Terraform 一样，Packer 从 1.10.0 起改为 **BSL 1.1**（2023 年 8 月 HashiCorp 统一调整），最后一个 MPL 2.0 版本是 1.9.5。企业内部用来构建自己的镜像不受影响，限制的是提供与 HashiCorp 竞争的托管服务。插件 SDK 仍是 MPL 2.0。
:::

### 1、模板示例

下面以 AWS 为例（`amazon` 插件最成熟），基于最新的 Ubuntu 24.04 官方镜像构建一个带 JRE 21、node_exporter 和 OpenTelemetry Java Agent 的基础镜像。阿里云对应的是 `hashicorp/alicloud` 插件的 `alicloud-ecs` builder，结构相同。

```hcl
# java-base.pkr.hcl
packer {
  required_version = ">= 1.11.0"

  required_plugins {
    amazon = {
      source  = "github.com/hashicorp/amazon"
      version = "~> 1.8"
    }
    ansible = {
      source  = "github.com/hashicorp/ansible"
      version = "~> 1.1"
    }
  }
}

variable "region" {
  type    = string
  default = "ap-southeast-1"
}

variable "image_version" {
  type        = string
  description = "镜像版本，通常取 Git tag，如 1.4.0"
}

locals {
  build_time = formatdate("YYYYMMDDhhmm", timestamp())
}

source "amazon-ebs" "java_base" {
  region        = var.region
  instance_type = "t3.small"
  ssh_username  = "ubuntu"
  ami_name      = "java-base-${var.image_version}-${local.build_time}"
  encrypt_boot  = true
  imds_support  = "v2.0" # 用该镜像启动的实例强制使用 IMDSv2

  source_ami_filter {
    filters = {
      name                = "ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-*"
      root-device-type    = "ebs"
      virtualization-type = "hvm"
    }
    owners      = ["099720109477"] # Canonical 官方账号，必须指定 owners
    most_recent = true
  }

  tags = {
    Name      = "java-base"
    Version   = var.image_version
    BaseImage = "{{ .SourceAMIName }}"
    BuiltBy   = "packer"
  }
}

build {
  sources = ["source.amazon-ebs.java_base"]

  # 1. 等系统自带的 cloud-init 跑完再装软件，避免和它抢 apt 锁
  provisioner "shell" {
    inline = ["cloud-init status --wait || test $? -eq 2"]
  }

  # 2. 装 JRE（以 root 执行，环境变量通过 env 传入）
  provisioner "shell" {
    environment_vars = ["DEBIAN_FRONTEND=noninteractive"]
    execute_command  = "chmod +x {{ .Path }}; sudo env {{ .Vars }} {{ .Path }}"
    inline = [
      "apt-get update",
      "apt-get install -y openjdk-21-jre-headless",
    ]
  }

  # 3. 复用 Ansible Playbook 装监控与链路 Agent
  provisioner "ansible" {
    playbook_file = "./ansible/agents.yml"
    user          = "ubuntu"
    use_proxy     = false
  }

  # 4. 清理执行记录，让基于该镜像的新实例按首次启动执行 cloud-init
  provisioner "shell" {
    inline = ["sudo cloud-init clean --logs --machine-id"]
  }

  # 记录产出的镜像 ID，供 CI 或 Terraform 读取
  post-processor "manifest" {
    output     = "packer-manifest.json"
    strip_path = true
  }
}
```

ansible provisioner 调用的 Playbook 与 [Ansible](./12_ansible) 一篇写法相同，`hosts` 固定写 `default`（Packer 生成的临时 inventory 里只有这一台）：

```yaml
# ansible/agents.yml
- name: 安装监控与链路 Agent
  hosts: default
  become: true
  vars:
    otel_agent_version: "2.32.0"

  tasks:
    - name: 安装 node_exporter
      ansible.builtin.apt:
        name: prometheus-node-exporter
        state: present
        update_cache: true

    - name: 创建 Agent 目录
      ansible.builtin.file:
        path: /opt/otel
        state: directory
        mode: "0755"

    - name: 下载 OpenTelemetry Java Agent
      ansible.builtin.get_url:
        url: "https://github.com/open-telemetry/opentelemetry-java-instrumentation/releases/download/v{{ otel_agent_version }}/opentelemetry-javaagent.jar"
        dest: /opt/otel/opentelemetry-javaagent.jar
        mode: "0644"
```

应用启动时加 `-javaagent:/opt/otel/opentelemetry-javaagent.jar` 即可接入链路追踪，配置方式见 [OpenTelemetry](/observability/5_opentelemetry)。

### 2、构建命令

```bash
packer init .        # 按 required_plugins 下载插件
packer fmt -check .  # 格式检查
packer validate -var "image_version=1.4.0" .
packer build -var "image_version=1.4.0" .
```

- `ansible` provisioner 在**运行 Packer 的机器上**调用 `ansible-playbook`，需要本地已安装 Ansible
- `use_proxy = false` 让 Ansible 直连构建机的 IP，不经过 Packer 的 SSH 代理，避免新版 Ansible 卡在 Gathering Facts
- 第 4 步的 `cloud-init clean` 是镜像构建的惯例：清掉构建机的执行记录和日志，`--machine-id` 让每台新实例重新生成唯一的 machine-id

### 3、在 CI 中构建

```yaml
# .github/workflows/build-image.yml
name: build-image

on:
  push:
    tags: ["image-v*"]

permissions:
  contents: read
  id-token: write # 通过 OIDC 换取云上临时凭证，不在仓库里存 AccessKey

jobs:
  packer:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v7
      - uses: hashicorp/setup-packer@v3
        with:
          version: "1.16.1"
      - uses: aws-actions/configure-aws-credentials@v6
        with:
          role-to-assume: arn:aws:iam::123456789012:role/packer-build
          aws-region: ap-southeast-1
      - run: pipx install --include-deps ansible
      - run: packer init .
      - run: packer validate -var "image_version=${GITHUB_REF_NAME#image-v}" .
      - run: packer build -var "image_version=${GITHUB_REF_NAME#image-v}" .
```

示例按主版本号引用 Action，便于阅读；对安全要求高的仓库，应改为固定到完整的 commit SHA（如 `actions/checkout@<40 位 SHA> # v7`），并用 Dependabot 自动升级，防止 tag 被篡改后执行恶意代码。流水线的其他环节见 [CI/CD](/devops/2_ci_cd)。

---

## 六、镜像版本管理

镜像和 jar、容器镜像一样是**制品**，要能追溯、能回滚：

- **命名带版本和时间**：`java-base-1.4.0-202610101530`，版本取 Git tag，同一版本重建也不会重名
- **打标签**：版本号、基础镜像名、构建流水线编号写进 tags，出问题时能查到镜像由哪次提交、基于哪个上游镜像构建
- **Terraform 按标签引用**：用 `aws_ami` 等数据源按 `Version` 标签查询镜像 ID，升级镜像就是改一个变量再 `plan`，回滚就是改回旧版本
- **定期重建**：即使软件没变，也要按周或按月重建，把系统安全补丁带进去；配合 [IaC 工程实践](./12_iac_practice) 的流水线自动化
- **清理旧镜像**：保留最近若干版本和正在使用的版本，其余注销并删除对应快照，避免存储持续累积
- **集中登记**：多团队、多云场景可用 HCP Packer 统一登记镜像版本与渠道（`hcp_packer_registry` 块），Terraform 侧用 `hcp_packer_artifact` 数据源读取；它是 HashiCorp 的托管服务，按官网说明评估

```hcl
# Terraform 侧：查询指定版本的镜像
data "aws_ami" "java_base" {
  owners      = ["self"]
  most_recent = true

  filter {
    name   = "tag:Version"
    values = [var.image_version]
  }
}
```

---

## 七、三个工具的分工与容器时代的位置

| 阶段 | 工具 | 负责什么 | 频率 |
|------|------|------|------|
| 构建期 | Packer（内部调 shell / Ansible） | 把慢变、通用的软件烘焙进镜像 | 软件升级或定期重建时 |
| 创建期 | Terraform | 用指定版本的镜像创建实例，传入 user-data | 基础设施变更时 |
| 首次启动 | cloud-init | 注入每台实例的差异配置，拉起服务 | 每台实例一次 |
| 运行期 | Ansible | 配置变更、批量运维、应急操作 | 按需 |

**不可变基础设施**的做法是尽量压缩运行期这一行：要改东西就构建新镜像、滚动替换实例，而不是登上去改。这样每台机器的状态都能从「镜像版本 + user-data」推出来，不会出现配置漂移。

**上了 Kubernetes 以后**，「镜像」指的就是**容器镜像**：应用、JRE 和 Agent 都在 Dockerfile 里构建（见 [Docker](./5_docker)），节点上不再部署应用。Packer 和 cloud-init 退到节点层：托管 K8s 的节点池用云厂商提供的节点镜像，需要预装安全 Agent 或预拉大镜像时才自定义节点镜像；节点开机时的初始化（加入集群、内核参数）同样由 cloud-init 或云厂商的启动脚本完成。

---

## 小结

- 镜像初始化有两种思路：Packer 把慢变的软件烘焙进镜像，cloud-init 在首次启动时注入差异配置，实践中两者组合使用，密钥两边都不放
- cloud-config 的执行顺序由阶段决定而非书写顺序：属主是自建用户的文件加 `defer: true`，`runcmd` 在装包之后执行，`users` 要保留 `default`
- 多数模块只在实例首次启动时执行一次，改 user-data 后应替换实例；排查看 `cloud-init status --wait --long` 和 `/var/log/cloud-init*.log`
- Terraform 通过 `user_data` + `templatefile` 传入 cloud-config；Packer 用 `required_plugins` 声明插件，shell / Ansible provisioner 装软件，镜像按版本命名、打标签、定期重建
- Packer 与 Terraform 一样自 1.10 起为 BSL 许可；在 K8s 上，镜像指容器镜像，Packer 和 cloud-init 只负责节点层

## 参考资料

- cloud-init 官方文档：[docs.cloud-init.io](https://docs.cloud-init.io/en/latest/)
- cloud-init 模块参考：[Module reference](https://docs.cloud-init.io/en/latest/reference/modules.html)
- cloud-init 启动阶段：[Boot stages](https://docs.cloud-init.io/en/latest/explanation/boot.html)
- cloud-init 命令行：[CLI commands](https://docs.cloud-init.io/en/latest/reference/cli.html)
- cloud-init 版本发布：[github.com/canonical/cloud-init/releases](https://github.com/canonical/cloud-init/releases)
- Packer 官方文档：[developer.hashicorp.com/packer/docs](https://developer.hashicorp.com/packer/docs)
- Packer Amazon EBS builder：[amazon-ebs](https://developer.hashicorp.com/packer/integrations/hashicorp/amazon/latest/components/builder/ebs)
- Packer Ansible provisioner：[ansible](https://developer.hashicorp.com/packer/integrations/hashicorp/ansible/latest/components/provisioner/ansible)
- Packer 阿里云 builder：[alicloud-ecs](https://developer.hashicorp.com/packer/integrations/hashicorp/alicloud/latest/components/builder/alicloud-ecs)
- Packer 版本发布：[github.com/hashicorp/packer/releases](https://github.com/hashicorp/packer/releases)
- HashiCorp 许可证调整公告：[HashiCorp adopts Business Source License](https://www.hashicorp.com/blog/hashicorp-adopts-business-source-license)
- 阿里云 Provider alicloud_instance：[registry.terraform.io](https://registry.terraform.io/providers/aliyun/alicloud/latest/docs/resources/instance)
- GitHub Actions 安全加固（固定 SHA）：[Security hardening for GitHub Actions](https://docs.github.com/en/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions)

> 下一篇：[IaC 工程实践](./12_iac_practice)
