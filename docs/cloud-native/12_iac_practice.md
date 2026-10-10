---
description: 仓库布局与环境晋级、PR 流水线与 OIDC、策略即代码、漂移检测、State 安全、Ansible 进 CI
---

# IaC 工程实践

> **本篇目标**：把 Terraform 从「本地敲命令」升级为「走 PR 的团队流程」：能搭出一条 fmt / validate / tflint → plan 贴到 PR → 评审 → 合并后 apply 同一份计划的 GitHub Actions 流水线，用 OIDC 取代长期密钥，用策略即代码和漂移检测兜底，并守住 State 的安全边界。
>
> **前置阅读**：[Terraform](./11_terraform)、[cloud-init 与 Packer](./12_cloud_init)

[Terraform](./11_terraform) 讲了 HCL、State、Module 和多环境目录，[Ansible](./12_ansible) 讲了 Playbook 和 Role。本篇不重复这些语法，只回答一个问题：**多人协作时，基础设施代码怎么评审、怎么上线、怎么防止出事**。示例以 GitHub Actions + AWS 为主（OIDC 生态最成熟），阿里云的对应做法在文中点出；工具版本以 2026 年 10 月为准：Terraform 1.16、hashicorp/setup-terraform v4、Conftest 0.71。

---

## 一、仓库布局与环境晋级

### 1、推荐布局

```text
infra-repo/
├── .github/workflows/
│   ├── terraform.yml        # PR plan + 合并后 apply
│   └── terraform-drift.yml  # 定时漂移检测
├── modules/                 # 共享模块，按 tag 发版
│   ├── network/
│   └── web/
├── envs/
│   ├── dev/                 # 每个环境一个根模块、一份独立 State
│   ├── staging/
│   └── prod/
├── policy/                  # Conftest 的 Rego 策略
│   └── terraform.rego
├── ansible/                 # Playbook / Role（机器内部配置）
└── .tflint.hcl
```

目录隔离、Workspace 与 Module 的写法见 [Terraform 第六节「Module 与多环境」](./11_terraform)，这里只补三条工程约定：

- **一个目录 = 一个 State = 一个爆炸半径**：网络、数据库、应用层再按目录拆开，改应用不会顺带 plan 出数据库变更，也能给不同目录配不同的 apply 权限
- **`.terraform.lock.hcl` 提交到 Git**：CI 和本地用同一份 Provider 哈希，否则 PR 上 plan 的和合并后 apply 的可能不是同一个 Provider 版本
- **`required_version` 与 CI 里的 `terraform_version` 保持一致**：升级 Terraform 单独走一个 PR

### 2、环境晋级：同一个模块版本逐级推进

共享模块打 tag 后，各环境按 tag 引用，晋级就是「改 ref 的 PR」：

```hcl
# envs/staging/main.tf：先在 dev、staging 验证 v1.5.0
module "web" {
  source         = "git::https://github.com/acme/tf-modules.git//web?ref=v1.5.0"
  name           = "staging-web"
  instance_count = 2
}
```

dev 验证通过后，提一个 PR 把 staging 的 `ref` 改成新版本；staging 稳定后再提一个 PR 改 prod。每次晋级都有独立的 plan、评审记录和回滚点（回滚就是把 `ref` 改回去）。不要让 prod 跟随分支（`ref=main`），否则模块仓库任何一次合并都会悄悄改变生产的下一次 plan。

---

## 二、PR 流水线：plan 贴到 PR，合并后 apply

![IaC 的 PR 流水线](../assets/cloud-native/iac-pr-pipeline.svg)

流程分两段：

1. **PR 阶段**（只读角色）：静态检查 → `plan -out` → 策略检查 → 把 plan 文本贴到 PR，评审人看的是「将要发生什么」，而不只是代码 diff
2. **合并阶段**（apply 角色）：main 上重新 plan 并把 `tfplan` 存为制品 → `production` 环境人工审批 → `apply tfplan`，执行的正是审批人看到的那份计划

为什么合并后要重新 plan，而不是直接拿 PR 上的计划：PR 的计划基于 PR 分支，合并时 main 上可能已经进了别的变更；并且 Terraform 会拒绝执行「生成之后 State 已变化」的过期计划（Saved plan is stale）。在 main 上重算一次，再用环境审批把它定住，是最稳妥的做法。

### 1、OIDC：不在仓库里存长期密钥

![OIDC 换取云凭证](../assets/cloud-native/iac-oidc-credentials.svg)

GitHub Actions 给每个 Job 签发一个短期 JWT，云厂商 STS 校验其中的 `aud` 和 `sub` 后，换出约 1 小时有效的临时凭证。仓库里不再有 AccessKey，泄露面和轮换成本都大幅下降。关键是**按 `sub` 拆角色**：

```hcl
# 在 AWS 侧用 Terraform 声明 apply 角色的信任策略：只有 production 环境的 Job 能扮演
data "aws_iam_policy_document" "tf_apply_trust" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.github.arn]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values   = ["repo:acme/infra-repo:environment:production"]
    }
  }
}
```

- **plan 角色**：只读权限 + State 桶读和锁文件读写，信任 `repo:acme/infra-repo:pull_request` 与 `repo:acme/infra-repo:ref:refs/heads/main`
- **apply 角色**：写权限，只信任 `environment:production`，再配合环境保护规则，等于「必须有人点批准才拿得到写凭证」
- 阿里云同理：RAM 中创建 OIDC 身份提供商与角色，Workflow 里用官方的 `aliyun/configure-aliyun-credentials-action` 传 `role-to-assume` 和 `oidc-provider-arn`

::: tip 2026 年 7 月起的 sub 格式变化
GitHub 对 2026 年 7 月 15 日之后新建（或改名、转移）的仓库，默认在 `sub` 中加入不可变的所有者 ID 和仓库 ID，形如 `repo:acme@123456/infra-repo@987654:environment:production`；存量仓库可在组织或仓库的 OIDC 设置里选择启用。配置信任策略前先看一眼仓库实际签发的 `sub`，否则会出现「角色存在却 AssumeRole 失败」。
:::

### 2、完整 Workflow

```yaml
# .github/workflows/terraform.yml
name: terraform

on:
  pull_request:
    branches: [main]
    paths: ["envs/prod/**", "modules/**", "policy/**"]
  push:
    branches: [main]
    paths: ["envs/prod/**", "modules/**", "policy/**"]

permissions:
  contents: read                     # 默认最小权限，各 Job 再按需放开

# PR 上新提交会取消旧的 plan；main 上的运行排队串行，绝不并行 apply
concurrency:
  group: terraform-prod-${{ github.event_name == 'push' && 'main' || github.event.pull_request.number }}
  cancel-in-progress: ${{ github.event_name == 'pull_request' }}

env:
  TF_DIR: envs/prod
  TF_IN_AUTOMATION: "true"
  TF_INPUT: "false"
  AWS_REGION: ap-southeast-1
  CONFTEST_VERSION: 0.71.1

jobs:
  plan:
    runs-on: ubuntu-24.04
    permissions:
      contents: read
      id-token: write                # 申请 OIDC 令牌
      pull-requests: write           # 在 PR 上写评论
    outputs:
      changes: ${{ steps.plan.outputs.changes }}
    defaults:
      run:
        working-directory: ${{ env.TF_DIR }}
    steps:
      - uses: actions/checkout@v7

      - uses: aws-actions/configure-aws-credentials@v6
        with:
          role-to-assume: ${{ vars.TF_PLAN_ROLE_ARN }}
          aws-region: ${{ env.AWS_REGION }}

      - uses: hashicorp/setup-terraform@v4
        with:
          terraform_version: 1.16.5
          terraform_wrapper: false   # 自己处理退出码和输出

      - uses: terraform-linters/setup-tflint@v6

      - name: Install conftest
        working-directory: ${{ runner.temp }}
        run: |
          curl -fsSLO "https://github.com/open-policy-agent/conftest/releases/download/v${CONFTEST_VERSION}/conftest_${CONFTEST_VERSION}_Linux_x86_64.tar.gz"
          tar -xzf "conftest_${CONFTEST_VERSION}_Linux_x86_64.tar.gz" conftest
          sudo mv conftest /usr/local/bin/

      - name: Lint
        env:
          GITHUB_TOKEN: ${{ github.token }}   # tflint --init 下载插件时避免 API 限流
        run: |
          terraform fmt -check -recursive "$GITHUB_WORKSPACE"
          terraform init
          terraform validate
          tflint --init --config "$GITHUB_WORKSPACE/.tflint.hcl"
          tflint --config "$GITHUB_WORKSPACE/.tflint.hcl"

      - name: Plan
        id: plan
        run: |
          set +e
          terraform plan -detailed-exitcode -out=tfplan
          ec=$?
          set -e
          if [ "$ec" -eq 1 ]; then exit 1; fi
          if [ "$ec" -eq 2 ]; then echo "changes=true" >> "$GITHUB_OUTPUT"; else echo "changes=false" >> "$GITHUB_OUTPUT"; fi
          terraform show -no-color tfplan > plan.txt
          terraform show -json tfplan > plan.json

      - name: Policy check
        run: conftest test plan.json --policy "$GITHUB_WORKSPACE/policy"

      - name: Comment plan on PR
        if: github.event_name == 'pull_request'
        env:
          GH_TOKEN: ${{ github.token }}
          PR_NUMBER: ${{ github.event.pull_request.number }}
        run: |
          {
            echo "### Terraform plan：\`${TF_DIR}\`（变更：${{ steps.plan.outputs.changes }}）"
            echo "<details><summary>展开完整 plan</summary>"
            echo
            echo '~~~text'
            head -c 60000 plan.txt          # PR 评论上限 65536 字符，超长截断
            echo
            echo '~~~'
            echo "</details>"
          } > comment.md
          gh pr comment "$PR_NUMBER" --body-file comment.md --edit-last --create-if-none

      - name: Upload plan
        if: github.event_name == 'push' && steps.plan.outputs.changes == 'true'
        uses: actions/upload-artifact@v7
        with:
          name: tfplan
          path: ${{ env.TF_DIR }}/tfplan
          retention-days: 1          # 计划文件含敏感值，用完即删

  apply:
    needs: plan
    if: github.event_name == 'push' && needs.plan.outputs.changes == 'true'
    runs-on: ubuntu-24.04
    environment: production          # 在仓库设置里为它配置 Required reviewers
    permissions:
      contents: read
      id-token: write
    defaults:
      run:
        working-directory: ${{ env.TF_DIR }}
    steps:
      - uses: actions/checkout@v7

      - uses: aws-actions/configure-aws-credentials@v6
        with:
          role-to-assume: ${{ vars.TF_APPLY_ROLE_ARN }}   # 环境级变量
          aws-region: ${{ env.AWS_REGION }}

      - uses: hashicorp/setup-terraform@v4
        with:
          terraform_version: 1.16.5
          terraform_wrapper: false

      - uses: actions/download-artifact@v8
        with:
          name: tfplan
          path: ${{ env.TF_DIR }}

      - name: Apply saved plan
        run: |
          terraform init
          terraform apply tfplan
```

几个容易被忽略的细节：

- **`permissions` 默认收紧**：顶层只给 `contents: read`，`id-token: write` 只在需要云凭证的 Job 打开；apply Job 不需要 `pull-requests: write`
- **`concurrency` 防并行 apply**：两个 PR 先后合并时，第二次运行会排队等第一次结束；GitHub 同一组只保留一个等待中的运行，更新的会顶替更旧的，这对 IaC 反而合适，因为最新的 main 已包含之前所有变更。真正的互斥仍靠 Backend 的状态锁，`concurrency` 只是让流水线别去抢锁
- **`-detailed-exitcode`**：退出码 0 无变更、1 出错、2 有变更；用它决定是否需要 apply，没有变更就不打扰审批人
- **环境保护**：`production` 环境配置必需审批人、禁止自审（Prevent self-review）、只允许 `main` 分支部署；审批人在审批页面能看到该运行的 plan 日志
- **fork PR**：来自 fork 的 `pull_request` 拿不到 OIDC 令牌和写权限，基础设施仓库通常不接受 fork 贡献；更不要为了让 fork 也能 plan 而改用 `pull_request_target`

::: tip Action 固定到提交 SHA
示例为了易读写的是主版本标签（`@v7`），生产仓库应固定到完整的 40 位提交 SHA，并在行尾注释版本号，例如 `uses: actions/checkout@<完整SHA> # v7.0.1`，再用 Dependabot 或 Renovate 自动发升级 PR。标签可以被改写：2026 年 3 月 `aquasecurity/trivy-action` 的几乎全部版本标签被攻击者强推为窃取 CI 密钥的恶意提交，只有按 SHA 引用的流水线不受影响。基础设施流水线手里握着云上的写权限，更值得这样做。
:::

---

## 三、策略即代码

评审靠人，人会漏看。把「绝不允许」的规则写成代码，在 plan 阶段自动拦截：

| 层次 | 工具 | 检查对象 | 典型规则 |
|------|------|----------|----------|
| 语法与风格 | `terraform fmt` / `validate`、tflint | HCL 源码 | 未使用的变量、废弃语法、实例规格拼写错误（需云厂商规则集） |
| 安全基线 | Checkov、Trivy（`trivy config`，已合并原 tfsec） | HCL 源码或 plan JSON | 存储桶未加密、安全组对公网开放、日志未开启 |
| 组织规则 | OPA / Conftest | plan JSON | 禁止删除数据库、限定可用区域、必须带成本标签 |

tflint 的配置放在仓库根目录：

```hcl
# .tflint.hcl
plugin "terraform" {
  enabled = true
  preset  = "recommended"
}

# 云厂商规则集（如 tflint-ruleset-aws）按需追加 plugin 块，并写死 version
```

安全扫描的常用命令：

```bash
# Checkov：扫描源码目录，或扫描 plan JSON（能看到变量代入后的真实值）
checkov -d envs/prod --framework terraform
checkov -f plan.json --framework terraform_plan

# Trivy：扫描 IaC 配置错误
trivy config envs/prod
```

**Conftest 检查 plan JSON** 最灵活，因为它看到的是「这次到底要改什么」。`terraform show -json` 输出的 `resource_changes` 数组里，每一项有 `address`、`type` 和 `change.actions`（`create` / `update` / `delete`，替换是 `delete` + `create`）。下面的策略用 Rego v1 语法（OPA 1.0 起的默认语法，新版 Conftest 默认按它解析）：

```rego
# policy/terraform.rego
package main

protected_types := {"aws_db_instance", "aws_rds_cluster", "aws_s3_bucket", "aws_dynamodb_table"}

# 有状态资源禁止删除或替换，需要时先在代码里移除保护再走单独评审
deny contains msg if {
	some rc in input.resource_changes
	rc.type in protected_types
	"delete" in rc.change.actions
	msg := sprintf("禁止删除或替换有状态资源：%s", [rc.address])
}

# 新建或修改的资源必须带 owner 标签（AWS Provider 的 tags_all 包含 default_tags）
deny contains msg if {
	some rc in input.resource_changes
	some action in rc.change.actions
	action in {"create", "update"}
	"tags_all" in object.keys(rc.change.after)
	not rc.change.after.tags_all.owner
	msg := sprintf("资源缺少 owner 标签：%s", [rc.address])
}
```

`deny` 命中会让 `conftest test` 以非零退出码失败，流水线随之变红；只想提醒不想拦截的规则写成 `warn contains msg if { ... }`。策略本身也要测试：在 `policy/` 下写 `*_test.rego`，用 `conftest verify` 跑。

---

## 四、漂移检测

**漂移（Drift）** 指云上的真实资源与代码 / State 不一致，常见原因是有人在控制台手工改了安全组、紧急扩容后没回写代码。漂移不处理，下一次 apply 会把手工改动悄悄覆盖回去，或者在 plan 里出现一堆与本次 PR 无关的变更。

做法是定时跑一次 plan，用 `-detailed-exitcode` 判断结果，有差异就开 Issue：

```yaml
# .github/workflows/terraform-drift.yml
name: terraform-drift

on:
  schedule:
    - cron: "0 1 * * *"              # 每天 UTC 01:00
  workflow_dispatch:

permissions:
  contents: read
  id-token: write
  issues: write

jobs:
  drift:
    runs-on: ubuntu-24.04
    defaults:
      run:
        working-directory: envs/prod
    steps:
      - uses: actions/checkout@v7

      - uses: aws-actions/configure-aws-credentials@v6
        with:
          role-to-assume: ${{ vars.TF_PLAN_ROLE_ARN }}   # 只读角色即可
          aws-region: ap-southeast-1

      - uses: hashicorp/setup-terraform@v4
        with:
          terraform_version: 1.16.5
          terraform_wrapper: false

      - name: Detect drift
        id: drift
        run: |
          terraform init
          set +e
          terraform plan -detailed-exitcode -lock=false -no-color > drift.txt
          ec=$?
          set -e
          echo "exitcode=$ec" >> "$GITHUB_OUTPUT"
          if [ "$ec" -eq 1 ]; then cat drift.txt; exit 1; fi

      - name: Open issue
        if: steps.drift.outputs.exitcode == '2'
        env:
          GH_TOKEN: ${{ github.token }}
        run: |
          head -c 60000 drift.txt > body.txt
          gh issue create --title "Terraform drift: envs/prod $(date -u +%F)" --body-file body.txt
```

- `-lock=false`：只读巡检不写 State，不必与正常的 apply 抢锁；但**只限这种只读场景**，任何会 apply 的命令都不能关锁
- 退出码 2 既可能是漂移，也可能是 main 上有尚未 apply 的代码；只想看云上被改了什么，可改用 `terraform plan -refresh-only -detailed-exitcode`
- 发现漂移后二选一：手工改动是对的，就把它写回代码走 PR；手工改动是错的，就走正常流程 apply 覆盖回去。长期目标是收掉控制台的写权限，让漂移无从产生

---

## 五、State 安全

State 里保存着所有资源属性的明文，包括数据库初始密码、私钥等，安全级别应当与生产数据库的凭证等同：

- **远程 Backend + 状态锁**：OSS 配 Tablestore、S3 用 `use_lockfile`（写法见 [Terraform 第五节](./11_terraform)），本地 State 只用于个人实验
- **存储加密与版本化**：桶开启服务端加密（最好用自管 KMS 密钥）和对象版本，State 被写坏时可以回滚到上一版本；同时开启访问日志
- **最小权限**：开发者个人账号对生产 State 桶只读或无权限；plan 角色需要读 State 并读写锁文件（S3 原生锁是同目录下的 `<key>.tflock` 对象），apply 角色才能写 State；按目录拆分的 State 可以各自授权
- **绝不提交 State**：`.gitignore` 至少包含 `*.tfstate`、`*.tfstate.*`、`.terraform/`、`*.tfplan`、`tfplan`；`.terraform.lock.hcl` 则要提交
- **敏感值**：输出和变量加 `sensitive = true` 只是让 CLI 输出打码，值**仍然以明文写入 State 和计划文件**；Terraform 1.10 起的临时值（ephemeral 变量与资源）和 1.11 起的 write-only 参数可以让密码完全不落 State，新代码优先用它们
- **计划文件同样敏感**：`tfplan` 里有完整的变量值，制品保留期设短，日志里不要 `cat` 计划 JSON
- **OpenTofu 用户**：可以开启客户端 State 加密（1.7+），在写入 Backend 之前就加密

**密钥本身**（数据库密码、API Token）不应写在 `.tfvars` 里提交：放进 Vault 或云厂商的密钥管理服务，由 Terraform 在运行时读取，或交给应用启动时拉取。Vault 动态凭证与密钥轮换的做法见 [数据安全](/security/7_data_security)。

---

## 六、Ansible 进 CI

[Ansible](./12_ansible) 的 Playbook 同样走 PR 流程，检查分三层：

```bash
# 1. 语法与最佳实践：FQCN、幂等写法、废弃模块等（production 是最严格的内置档位）
ansible-lint --profile production ansible/

# 2. 语法检查：不连接主机，只解析 Playbook
ansible-playbook -i ansible/inventory/prod ansible/site.yml --syntax-check

# 3. 演练：连接主机，展示将要发生的变更但不执行，作用类似 terraform plan
ansible-playbook -i ansible/inventory/prod ansible/site.yml --check --diff
```

- `--check` 需要连到目标机器，CI Runner 要能访问内网（自托管 Runner 或跳板机），SSH 私钥和 Vault 密码由 CI 的密钥管理注入
- 部分模块不支持 check 模式，`shell` / `command` 默认在 check 模式下跳过，结果不能完全当真；关键任务加 `check_mode: false` 只读执行，或接受这个盲区
- 与 Terraform 衔接时，在同一条流水线里先 apply 基础设施、再用 Terraform 输出生成 inventory 运行 Playbook，顺序由 Job 的 `needs` 保证

---

## 七、IaC 的 GitOps：PR 驱动的执行器

上面的流水线是用 GitHub Actions「自己搭」。团队规模变大后，常见做法是交给专门的执行器，核心思路相同：**Git 是唯一入口，plan 结果回写到 PR，合并或评论触发 apply**。

| 形态 | 代表 | 特点 |
|------|------|------|
| 自托管 PR 机器人 | Atlantis | 部署在自己的网络里，PR 评论 `atlantis plan` / `atlantis apply` 触发；自带按目录加锁，防止两个 PR 同时改同一目录 |
| 托管执行平台 | HCP Terraform、Spacelift、env0 等 | 远程执行、State 托管、内置策略与审批、运行历史与审计 |
| K8s 控制器 | Flux 的 tofu-controller 等 | 在集群里持续 reconcile Terraform / OpenTofu 配置，风格接近 [Argo CD](./9_argocd) |

选择时看三点：凭证放在哪里（自托管 Runner 还是平台）、State 交给谁、审批和审计是否满足合规要求。无论选哪种，plan 可见、apply 受控、凭证短期这三条原则不变。

---

## 八、常见坑

- **本地 apply 与 CI 并存**：有人图快在本地 apply，State 与 main 上的代码对不上，下一次 CI 的 plan 出现大量意外变更。生产只允许流水线 apply，个人账号收掉写权限
- **评审只看代码不看 plan**：一行 `name` 修改可能触发 `-/+` 替换，删掉数据库重建。plan 中的替换和删除必须重点看，并用 Conftest 拦住有状态资源
- **plan 与 apply 用了不同版本**：没提交 `.terraform.lock.hcl`，或 CI 里 `terraform_version` 用 `latest`，两次运行装到不同版本
- **apply 时重新计算**：合并后直接 `terraform apply -auto-approve`，执行的不是任何人审过的计划；应 `apply tfplan`
- **plan 角色权限过大**：PR 上能被任何分支触发的 Job 拿到写权限，等于任何能提 PR 的人都能改生产。按 `sub` 拆分只读与写角色
- **State 拆得太粗**：所有资源一个 State，plan 慢、锁冲突频繁、一次失误影响全部；按层次和团队拆分
- **在 PR 评论里打印敏感值**：plan 文本可能包含未标记 `sensitive` 的密码，变量要正确标注，评论里只放 plan 摘要也是一种选择
- **漂移长期无人处理**：巡检 Issue 堆积后没人看，漂移越积越多，最终没人敢 apply。漂移要有明确的处理人和时限

---

## 小结

- 仓库按「一个目录一份 State」布局，模块打 tag，环境晋级就是逐级修改 `ref` 的 PR
- PR 阶段用只读角色跑 fmt / validate / tflint、plan、策略检查并把 plan 贴到 PR；合并后在 main 上重新 plan，经 `production` 环境审批后 `apply tfplan`
- OIDC 按 `sub` 拆分 plan / apply 角色，仓库里不存长期密钥；`permissions` 最小化、`concurrency` 串行、Action 固定到 SHA
- 策略即代码分三层：tflint 管风格，Checkov / Trivy 管安全基线，Conftest + Rego 在 plan JSON 上执行组织规则
- 定时 `plan -detailed-exitcode` 发现漂移；State 与计划文件都按生产凭证的级别保护，敏感值优先用 ephemeral / write-only 不落盘

## 参考资料

- Terraform 在自动化中运行：[Running Terraform in automation](https://developer.hashicorp.com/terraform/tutorials/automation/automate-terraform)
- Terraform plan 命令（`-detailed-exitcode`、`-refresh-only`）：[terraform plan](https://developer.hashicorp.com/terraform/cli/commands/plan)
- Terraform JSON 输出格式（`resource_changes`）：[JSON Output Format](https://developer.hashicorp.com/terraform/internals/json-format)
- Terraform 临时值与 write-only 参数：[Ephemeral values](https://developer.hashicorp.com/terraform/language/manage-sensitive-data/ephemeral)
- hashicorp/setup-terraform：[GitHub 仓库](https://github.com/hashicorp/setup-terraform)
- GitHub Actions OIDC 与 AWS：[Configuring OpenID Connect in Amazon Web Services](https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-in-aws)
- GitHub Actions OIDC 参考（sub 格式）：[OpenID Connect reference](https://docs.github.com/en/actions/reference/security/oidc)
- GitHub Actions 安全加固（固定 SHA）：[Security hardening for GitHub Actions](https://docs.github.com/en/actions/reference/security/secure-use)
- GitHub Actions 部署环境与保护规则：[Managing environments for deployment](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments)
- GitHub Actions 并发控制：[Control the concurrency of workflows and jobs](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency)
- 阿里云凭证 Action（OIDC）：[aliyun/configure-aliyun-credentials-action](https://github.com/aliyun/configure-aliyun-credentials-action)
- TFLint：[TFLint 文档](https://github.com/terraform-linters/tflint)
- Checkov：[Checkov 文档](https://www.checkov.io/)
- Trivy 配置扫描：[Trivy Misconfiguration Scanning](https://trivy.dev/latest/docs/scanner/misconfiguration/)
- Conftest：[conftest.dev](https://www.conftest.dev/)
- OPA Rego v1 语法：[Policy Language](https://www.openpolicyagent.org/docs/policy-language)
- ansible-lint：[Ansible Lint 文档](https://docs.ansible.com/projects/lint/)
- Atlantis：[runatlantis.io](https://www.runatlantis.io/)

> 下一篇：[云计算概览](./13_cloud_overview)
