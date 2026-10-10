---
description: 主干开发与 GitHub Flow、分支保护规则集、Conventional Commits、提交钩子、PR 流程、常用命令
---

# Git 工作流

> **本篇目标**：按全站统一的「主干开发 / GitHub Flow」组织分支：能说清为什么不再用 Git Flow 的 `develop` 分支，能给 `main` 配好规则集与 CODEOWNERS，能用 Conventional Commits 写出可生成变更日志的提交信息，并把提交校验做成随仓库分发、CI 兜底的门禁。
>
> **前置阅读**：Git 基础命令（`add` / `commit` / `push` / `merge` / `rebase`）；[DevOps 总览](./0_overview)

分支模型决定了 CI 怎么触发、环境怎么晋级、版本怎么发布，所以它是本模块其余各篇的前提。本篇示例以 GitHub 为主，GitLab 的对应功能在文中点出；命令基于 Git 2.23 以上（`git switch` / `git restore` 自该版本引入），当前稳定版为 2.56。

---

## 一、分支模型选型

### 1、三种主流模型

| 模型 | 长期分支 | 发布方式 | 适用场景 | 代价 |
|------|---------|---------|---------|------|
| **主干开发**（Trunk-Based Development） | 只有 `main` | 从 `main` 持续部署，或在 `main` 上打 tag | 持续交付的服务端项目 | 需要完善的自动化测试和 Feature Flag |
| **GitHub Flow** | 只有 `main` | 合并即部署，按 tag 记录版本 | 同上，是主干开发「每个变更都走 PR」的具体做法 | 同上 |
| **Git Flow** | `main` + `develop` | 从 `release/*` 分支发版，合回 `main` 和 `develop` | 需要同时维护多个已发布版本的产品（SDK、私有化部署） | 分支多、合并多、集成晚 |

主干开发与 GitHub Flow 本质相同：所有人基于 `main` 工作，分支只活很短时间。主干开发对分支寿命的要求更明确：一个功能分支只由一个人（结对时两人）使用，存活不超过一两天，超过就成了它所反对的长期分支。

### 2、全站约定：主干开发 + GitHub Flow

![分支模型对比](../assets/devops/git-workflow-branch-models.svg)

本站所有模块（CI/CD、环境管理、发布策略）都按以下规则展开：

- **`main` 始终可发布**：任何时刻从 `main` 构建出的制品都能上生产，坏了的 `main` 是最高优先级问题
- **短命分支**：从 `main` 切出，一个分支只做一件事，1–2 天内合并；大功能拆成多个可独立合并的小 PR
- **只通过 PR 合并**：`main` 禁止直接推送，合并前必须通过 CI 和评审（见第三节）
- **未完成的功能用开关隐藏**：代码先合进 `main`，用 Feature Flag 控制是否对用户可见，而不是在分支上囤积数周，做法见 [环境管理](./7_env_management)
- **用 tag 发版**：在 `main` 的某个提交上打 `v1.5.0` 这样的 tag 触发正式发布，版本号规则见 [制品与版本管理](./6_artifact_version)
- **不设 `develop` 分支**：环境差异不靠分支表达，同一个制品从测试环境逐级晋级到生产，见 [环境管理](./7_env_management) 与 [发布策略](./5_release_strategy)

### 3、紧急修复怎么走

线上问题的修复也走 `main`，只是评审和流水线优先处理：

1. 从 `main` 切 `fix/` 分支，修复并补一个能复现问题的测试
2. 提 PR，加急评审，合并后按正常流水线部署（或从 `main` 打补丁版本 tag）

如果产品需要给已发布的旧版本打补丁（例如客户还在用 1.4），从对应 tag 拉一个维护分支，**修复先进 `main`，再摘取到维护分支**，避免修复只存在于旧版本、下个版本又复发：

```bash
git switch -c release/1.4.x v1.4.0        # 从 tag 拉维护分支（只拉一次，之后复用）
git cherry-pick -x <main 上的修复提交>      # -x 在提交信息里记录来源提交
git tag -a v1.4.1 -m "v1.4.1"
git push origin release/1.4.x v1.4.1
```

### 4、Git Flow：只作为遗留选项

Git Flow 由 Vincent Driessen 在 2010 年提出，用 `main` 记录生产版本、`develop` 做集成，功能、发布、热修复各有一类分支。它的作者在 2020 年给原文加了一段反思：对持续交付的软件（大多数 Web 服务）推荐改用 GitHub Flow 这类更简单的流程，只有发布带明确版本号、需要同时支持多个版本的软件才可能适合 Git Flow。

存量项目从 Git Flow 迁到 GitHub Flow 的步骤：

1. 把 `develop` 合进 `main`，确认 `main` 可发布后冻结 `develop` 的写入
2. 把 CI 中针对 `develop` 的触发条件改为针对 PR 与 `main`，部署改为「合并后部署到测试环境、按 tag 或审批晋级到生产」
3. 正在开发的 `feature/*` 分支改为以 `main` 为目标重新提 PR
4. 删除 `develop`，在仓库设置中把默认分支确认为 `main`

---

## 二、分支命名

分支前缀与 Conventional Commits 的 type 对齐，名字里带上需求或缺陷编号，方便与工单系统互相跳转：

| 类型 | 格式 | 示例 |
|------|------|------|
| 新功能 | `feat/<工单号>-<简述>` | `feat/ORD-128-timeout-cancel` |
| 缺陷修复（含线上紧急修复） | `fix/<工单号>-<简述>` | `fix/PAY-77-duplicate-charge` |
| 重构 | `refactor/<简述>` | `refactor/order-service-split` |
| 构建、依赖、杂项 | `chore/<简述>` | `chore/bump-spring-boot` |
| 文档 | `docs/<简述>` | `docs/api-changelog` |
| 旧版本维护（仅多版本产品） | `release/<主版本>.<次版本>.x` | `release/1.4.x` |

命名要求：全小写、单词用连字符分隔、简述不超过 5 个单词。GitHub 规则集没有直接限制分支名的规则，需要强制时在 CI 中校验，或用规则集的 `Restrict creations` 只允许特定人员创建 `release/*`。

---

## 三、分支保护与规则集

GitHub 的规则集（Rulesets）是分支保护规则的新形态：可以叠加多套、按分支名模式批量生效，还能单独设置豁免名单。GitLab 的对应功能是 Protected branches 加 Merge request approvals。

### 1、`main` 的推荐规则集

| 规则 | 建议设置 | 作用 |
|------|---------|------|
| Restrict deletions | 开启 | 防止误删 `main` |
| Block force pushes | 开启 | 已发布的历史不可改写 |
| Require a pull request before merging | 至少 1 人批准；新提交推送后作废旧批准；要求最后一次推送也被批准；要求评论全部解决；要求代码所有者评审 | 所有变更必须经过评审，且评审的是最终代码 |
| Require status checks to pass | 选中构建、单元测试、质量门禁等必需检查；勾选 Require branches to be up to date before merging | 合并前在最新的 `main` 上验证过 |
| Require linear history | 开启 | 只允许 Squash 或 Rebase 合并，`main` 上没有合并提交 |
| Require a specific merge method | 只允许 squash | 一个 PR 对应 `main` 上的一个提交，便于回滚与生成变更日志 |
| Bypass list | 只放发布机器人或少数管理员 | 紧急情况可绕过，但豁免要留痕、事后复盘 |

另建一套针对 `v*` tag 的规则集，开启 Restrict updates 与 Restrict deletions，让已发布的 tag 不可移动、不可删除，保证同一个版本号永远指向同一份代码。

### 2、CODEOWNERS：按目录自动指派评审人

`.github/CODEOWNERS`（也可放在仓库根目录或 `docs/` 下）声明每个路径由谁负责，开启「要求代码所有者评审」后，改动这些路径的 PR 必须得到对应人员批准。**后出现的规则优先级更高**，所以通配规则写在最前面：

```text
# 默认评审人
*                                       @acme/backend-reviewers

# 支付模块由支付组把关
/src/main/java/com/acme/payment/        @acme/payment-team

# 数据库迁移脚本需要 DBA 批准
/src/main/resources/db/migration/       @acme/dba

# 流水线与部署配置需要平台组批准
/.github/workflows/                     @acme/platform
/deploy/                                @acme/platform
```

### 3、合并队列：并发合并时保持 `main` 为绿

「要求分支是最新的」会让多个 PR 排队反复 rebase。PR 多的仓库可以开启合并队列（Merge queue）：PR 批准后进入队列，GitHub 把它与排在前面的 PR 组合成临时分支跑一遍 CI，通过才真正合并。开启后 GitHub Actions 的工作流必须同时监听 `merge_group` 事件，否则必需检查永远不会上报，队列会卡住：

```yaml
on:
  pull_request:
  merge_group:
```

合并队列在分支保护规则或规则集中开启（Require merge queue），不能用于名称中带通配符 `*` 的分支保护规则。GitLab 的对应功能是 Merge trains。

---

## 四、Commit 规范（Conventional Commits）

### 1、格式

```text
<type>(<scope>)!: <subject>

[body]

[footer]
```

- `scope` 可选，写受影响的模块，如 `order`、`payment`
- `!` 可选，表示包含不兼容变更
- `subject` 用祈使句说明做了什么，不超过 72 个字符，结尾不加句号
- `footer` 写 `Closes #128` 关联工单，或用 `BREAKING CHANGE: <说明>` 描述不兼容变更（规范也接受 `BREAKING-CHANGE`）

### 2、type 类型

| type | 说明 | 对版本号的影响 |
|------|------|------|
| `feat` | 新功能 | 次版本号 +1 |
| `fix` | 缺陷修复 | 修订号 +1 |
| `perf` | 性能优化 | 无（按团队约定可视同 fix） |
| `refactor` | 重构，既不是新功能也不是修复 | 无 |
| `docs` | 文档 | 无 |
| `style` | 格式调整，不影响逻辑 | 无 |
| `test` | 新增或修改测试 | 无 |
| `build` | 构建系统或外部依赖，如 `pom.xml`、Gradle 脚本 | 无 |
| `ci` | CI 配置与脚本 | 无 |
| `chore` | 其他杂项 | 无 |
| `revert` | 回滚某次提交 | 视被回滚内容而定 |

任何 type 只要带 `!` 或 `BREAKING CHANGE` 脚注，就意味着主版本号 +1。这套映射让 release-please、semantic-release 这类工具能从提交历史自动算出下一个版本号并生成变更日志，发版流程见 [制品与版本管理](./6_artifact_version)。

### 3、示例

```text
feat(order): 新增订单超时自动取消

- 通过 RocketMQ 延迟消息实现 30 分钟超时检测
- 超时后回退库存并通知用户

Closes #128
```

```text
fix(payment): 修复网络重试导致的重复扣款

扣款前以 idempotencyKey 做 Redis SET NX 判重，重复请求直接返回首次结果。

Closes #131
```

```text
feat(payment)!: 支付接口新增必填参数 idempotencyKey

BREAKING CHANGE: 调用方必须在请求体中传入 idempotencyKey，缺失时返回 400
```

反例与正例：

```bash
# 反例：看不出改了什么
git commit -m "fix bug"
git commit -m "update"
git commit -m "调整代码"

# 正例
git commit -m "fix(auth): 修复 JWT 过期后未跳转登录页"
```

### 4、Squash 合并下以 PR 标题为准

采用 Squash 合并后，`main` 上留下的是 PR 级别的提交，分支里的中间提交（「wip」「修复评审意见」）不会进入主干历史。把仓库设置中 Squash 合并的默认提交信息设为「Pull request title」（或标题加描述），PR 标题就是最终的提交信息，所以 **PR 标题必须符合 Conventional Commits**，分支内的提交可以宽松一些。

---

## 五、提交钩子

`.git/hooks` 目录不受版本控制，写在里面的钩子只对自己生效，团队拿不到。让钩子随仓库分发有三种方式：

| 方式 | 依赖 | 适合 |
|------|------|------|
| pre-commit 框架 | Python（用 pipx 安装即可） | 多语言仓库、需要丰富现成钩子 |
| `core.hooksPath` 指向仓库内目录 | 只需 Git 与 sh | 不想引入额外工具的纯 Java 仓库 |
| Husky + commitlint | Node.js | 前后端同仓、已有 `package.json` |

无论哪种，本地钩子都可以用 `git commit --no-verify` 跳过，所以 **CI 必须用同样的规则再校验一遍**，本地钩子只负责让问题更早暴露。

### 1、pre-commit 框架

```yaml
# .pre-commit-config.yaml
default_install_hook_types: [pre-commit, commit-msg, pre-push]

repos:
  - repo: https://github.com/pre-commit/pre-commit-hooks
    rev: v6.0.0
    hooks:
      - id: trailing-whitespace
      - id: end-of-file-fixer
      - id: check-merge-conflict
      - id: check-yaml
        args: [--allow-multiple-documents]   # 允许 Kubernetes 多文档 YAML
      - id: check-added-large-files
        args: [--maxkb=1024]
      - id: detect-private-key

  - repo: https://github.com/compilerla/conventional-pre-commit
    rev: v4.4.0
    hooks:
      - id: conventional-pre-commit
        stages: [commit-msg]
        args: []                              # 空列表表示使用规范的标准 type

  - repo: local
    hooks:
      - id: spotless-check
        name: spotless check
        entry: ./mvnw -q spotless:check
        language: system
        pass_filenames: false
        types: [java]
        stages: [pre-push]                    # Maven 启动慢，放在推送前而不是每次提交
```

```bash
pipx install pre-commit
pre-commit install            # 按 default_install_hook_types 安装三类钩子
pre-commit run --all-files    # 首次接入时对存量文件跑一遍
pre-commit autoupdate         # 定期把 rev 升级到各仓库的最新 tag
```

`spotless-check` 假设项目已配置 Spotless 插件，格式化、Checkstyle、SpotBugs 的完整配置见 [代码质量](/engineering/3_code_quality)。不要在 pre-commit 阶段跑 `mvn checkstyle:check` 这类完整构建：每次提交都要启动 Maven，慢到大家习惯性加 `--no-verify`；而且不指定配置文件时 Checkstyle 默认使用 `sun_checks.xml`，几乎所有项目都通不过。

### 2、不依赖 Python：`core.hooksPath`

把钩子放进仓库内的 `.githooks/` 目录，每个开发者克隆后执行一次 `git config core.hooksPath .githooks`。`.githooks/commit-msg` 内容如下，注意 shebang 必须在第一行：

```sh
#!/bin/sh
# 只校验标题行（第一行），正文与脚注不受限制
subject=$(head -n 1 "$1")

# 放行 Git 自动生成的合并、回滚信息与 fixup / squash 提交
case "$subject" in
  "Merge "*|"Revert \""*|"fixup! "*|"squash! "*) exit 0 ;;
esac

pattern='^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([^)]+\))?!?: .{1,72}$'

if ! printf '%s\n' "$subject" | grep -qE "$pattern"; then
  echo "提交信息不符合 Conventional Commits：$subject" >&2
  echo "格式：<type>(<scope>)!: <subject>，例如 feat(order): 新增订单超时自动取消" >&2
  exit 1
fi
```

```bash
git config core.hooksPath .githooks
git update-index --chmod=+x .githooks/commit-msg   # Windows 上也能把可执行位提交进仓库
```

正则末尾的 `$` 让 72 字符上限真正生效；`.{1,72}` 在 UTF-8 locale 下按字符计数，在 `C` locale 下按字节计数（一个汉字算 3 个），对中文标题会更严格。

### 3、CI 兜底：校验 PR 标题

既然 Squash 合并以 PR 标题为准，CI 里校验 PR 标题即可覆盖所有绕过本地钩子的情况。标题通过环境变量传入脚本，而不是直接拼进 `run`，防止标题中的特殊字符被当作命令执行：

```yaml
# .github/workflows/pr-title.yml
name: pr-title
on:
  pull_request:
    types: [opened, edited, synchronize, reopened]

permissions: {}

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - name: 校验 PR 标题
        env:
          TITLE: ${{ github.event.pull_request.title }}
        run: |
          pattern='^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([^)]+\))?!?: .{1,72}$'
          if ! printf '%s\n' "$TITLE" | grep -qE "$pattern"; then
            echo "PR 标题不符合 Conventional Commits：$TITLE"
            exit 1
          fi
```

把这个检查加入规则集的必需检查后，标题不合规的 PR 无法合并。流水线的整体结构见 [CI/CD](./2_ci_cd)。

---

## 六、PR 流程

![PR 生命周期](../assets/devops/git-workflow-pr-lifecycle.svg)

PR 模板、评审清单、评审时效与评论写法以 [Code Review](./3_code_review) 为准，本篇不重复。和分支模型直接相关的约定如下：

- **大小**：单个 PR 改动建议不超过 **400 行**（不含生成代码与锁文件），超过时在描述里说明原因或拆分；全站统一这个数字
- **单一主题**：一个 PR 只做一件事，重构与功能改动分开提，方便评审和回滚
- **尽早可见**：工作量较大时先提 Draft PR，让评审人提前看方向
- **保持与主干同步**：用 `git rebase origin/main` 或页面上的 Update branch 跟上 `main`，不要把 `main` 反复 merge 进功能分支
- **合并后清理**：在仓库设置中开启「Automatically delete head branches」，合并后自动删除远程分支
- **大功能拆分**：拆成「接口与开关」「核心逻辑」「接入与放量」等依次合并的小 PR，未完成部分由 Feature Flag 关闭

---

## 七、常用命令速查

### 1、日常开发

```bash
# 基于最新的 main 切分支并推送
git fetch origin
git switch -c feat/ORD-128-timeout-cancel origin/main
git push -u origin HEAD

# 取消暂存 / 丢弃工作区修改（Git 2.23+，替代 checkout 与 reset 的这部分用法）
git restore --staged src/main/java/com/acme/order/OrderService.java
git restore src/main/java/com/acme/order/OrderService.java

# 跟上主干：变基而不是合并
git fetch origin
git rebase origin/main
```

### 2、整理提交与安全地强推

```bash
# 针对某个旧提交补一个修正，再自动压进去
git commit --fixup=<commit-sha>
git rebase -i --autosquash origin/main

# 变基后推送：远程分支被别人更新过时拒绝覆盖
git push --force-with-lease --force-if-includes
```

`--force-with-lease` 只在远程分支仍是自己上次拉取时的状态才覆盖；`--force-if-includes`（Git 2.30+）进一步要求远程的最新提交已经包含在本地历史中，防止后台 `fetch` 让 lease 检查失效。两者只用于自己的功能分支，`main` 由规则集禁止强推。

### 3、回滚与摘取

```bash
# 撤销已合并的提交：新增一个反向提交，不改写历史
git revert <commit-sha>

# 撤销一个合并提交：-m 1 表示保留第一个父提交（主干）一侧
git revert -m 1 <merge-commit-sha>

# 摘取提交到维护分支，并在提交信息中记录来源
git cherry-pick -x <commit-sha>

# 误操作后找回：reflog 记录了 HEAD 的每次移动
git reflog
git switch -c rescue <reflog 中的提交>
```

### 4、定位问题

```bash
# 查看某几行代码最后由谁、在哪个提交修改
git blame -L 100,120 src/main/java/com/acme/order/OrderService.java

# 二分查找引入缺陷的提交：先标记坏、好两个端点，再让脚本自动判定
git bisect start HEAD v1.4.0
git bisect run ./mvnw -q -Dtest=OrderTimeoutTest test
git bisect reset          # 结束后回到原来的分支
```

`git bisect run` 根据脚本退出码判断：0 表示好，1–127（125 除外）表示坏，125 表示该提交无法测试、跳过。

---

## 小结

- 全站分支模型是主干开发 / GitHub Flow：只有 `main` 一个长期分支，功能分支 1–2 天内合并，未完成功能用 Feature Flag 隐藏，在 `main` 上打 tag 发版
- 紧急修复同样先进 `main`；只有需要维护旧版本的产品才从 tag 拉 `release/x.y.x`，并用 `cherry-pick -x` 摘取修复
- Git Flow 只作为多版本产品的遗留选项，其作者也不推荐把它用于持续交付的服务
- `main` 用规则集保护：禁止删除与强推、必须经 PR 与必需检查、线性历史、只允许 Squash；`v*` tag 另设规则集防止移动；CODEOWNERS 按目录指派评审人，PR 多时用合并队列（工作流需监听 `merge_group`）
- 提交遵循 Conventional Commits 1.0.0，`feat` / `fix` / `!` 分别对应次版本、修订号、主版本；Squash 合并下 PR 标题就是主干上的提交信息
- 钩子要随仓库分发（pre-commit 框架或 `core.hooksPath`），shebang 写在第一行；本地钩子可被跳过，CI 必须再校验 PR 标题
- PR 不超过 400 行、单一主题，模板与评审清单以 [Code Review](./3_code_review) 为准

---

## 参考资料

- 主干开发：[Trunk Based Development](https://trunkbaseddevelopment.com/)
- 短命功能分支：[Short-Lived Feature Branches](https://trunkbaseddevelopment.com/short-lived-feature-branches/)
- GitHub Flow：[GitHub flow](https://docs.github.com/en/get-started/using-github/github-flow)
- Git Flow 原文与 2020 年反思：[A successful Git branching model](https://nvie.com/posts/a-successful-git-branching-model/)
- 规则集可用规则：[Available rules for rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets)
- 代码所有者：[About code owners](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-code-owners)
- 合并队列：[Managing a merge queue](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue)
- Squash 合并默认提交信息：[Configuring commit squashing for pull requests](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/configuring-commit-squashing-for-pull-requests)
- Conventional Commits：[Conventional Commits 1.0.0](https://www.conventionalcommits.org/en/v1.0.0/)
- pre-commit 框架：[pre-commit.com](https://pre-commit.com/)
- pre-commit-hooks：[GitHub 仓库](https://github.com/pre-commit/pre-commit-hooks)
- conventional-pre-commit：[GitHub 仓库](https://github.com/compilerla/conventional-pre-commit)
- Git 钩子与 `core.hooksPath`：[githooks 文档](https://git-scm.com/docs/githooks)
- `git push --force-with-lease` / `--force-if-includes`：[git-push 文档](https://git-scm.com/docs/git-push)
- `git bisect run`：[git-bisect 文档](https://git-scm.com/docs/git-bisect)

> 下一篇：[CI/CD](./2_ci_cd)
