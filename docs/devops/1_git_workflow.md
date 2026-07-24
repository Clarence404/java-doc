# Git 工作流

> 参考资料：
> * Git Flow：[https://nvie.com/posts/a-successful-git-branching-model/](https://nvie.com/posts/a-successful-git-branching-model/)
> * GitHub Flow：[https://docs.github.com/en/get-started/quickstart/github-flow](https://docs.github.com/en/get-started/quickstart/github-flow)
> * Conventional Commits：[https://www.conventionalcommits.org/](https://www.conventionalcommits.org/)

---

## 一、分支策略选型

| 策略 | 适用场景 | 优点 | 缺点 |
|------|---------|------|------|
| **Git Flow** | 有明确版本号的产品（如 SDK、APP） | 版本管理清晰 | 分支多，流程重 |
| **GitHub Flow** | SaaS 产品，频繁发布 | 简单，CI/CD 友好 | 无版本管理 |
| **Trunk Based** | 高频发布团队（Elite DevOps） | 集成最快，冲突最少 | 需完善 Feature Flag |

### 推荐：GitHub Flow（大多数后端项目）

```
main（保护分支，始终可发布）
  ├── feature/user-login
  ├── feature/order-refund
  ├── fix/payment-timeout
  └── hotfix/prod-null-pointer
```

**流程**：
1. 从 `main` 切出功能分支
2. 开发完成后提 PR，至少 1 人 Review 通过
3. CI 全部绿灯后合并到 `main`
4. 合并即触发部署流水线

### Git Flow（版本化产品）

```
main        永远是生产状态
develop     集成分支
  ├── feature/xxx   功能开发
  ├── release/1.2.0 发布准备（只修 Bug）
  └── hotfix/xxx    生产紧急修复（同时合回 main + develop）
```

---

## 二、分支命名规范

| 类型 | 格式 | 示例 |
|------|------|------|
| 功能 | `feature/<简短描述>` | `feature/user-oauth-login` |
| 缺陷修复 | `fix/<简短描述>` | `fix/order-amount-overflow` |
| 紧急热修复 | `hotfix/<简短描述>` | `hotfix/prod-npe-checkout` |
| 发布分支 | `release/<版本号>` | `release/2.1.0` |
| 重构 | `refactor/<简短描述>` | `refactor/user-service-ddd` |

**命名要求**：全小写、连字符分隔、描述简洁（不超过 5 个单词）。

---

## 三、Commit 规范（Conventional Commits）

### 格式

```
<type>(<scope>): <subject>

[body]

[footer]
```

### type 类型

| type | 说明 |
|------|------|
| `feat` | 新功能 |
| `fix` | Bug 修复 |
| `docs` | 文档变更 |
| `style` | 格式调整（不影响逻辑） |
| `refactor` | 重构（既非 feat 也非 fix） |
| `perf` | 性能优化 |
| `test` | 新增或修改测试 |
| `chore` | 构建、依赖、工具链变更 |
| `ci` | CI/CD 配置变更 |
| `revert` | 回滚某次提交 |

### 示例

```
feat(order): 新增订单超时自动取消功能

- 通过 RocketMQ 延迟消息实现 30 分钟超时检测
- 超时后触发库存回退和用户通知

Closes #128
```

```
fix(payment): 修复并发下重复扣款问题

使用 Redis SETNX 实现幂等控制，防止网络重试导致多次扣款。

BREAKING CHANGE: 支付接口新增必填参数 idempotentKey
```

### 禁止的写法

```
# ❌ 含糊不清
git commit -m "fix bug"
git commit -m "update"
git commit -m "调整代码"

# ✅ 清晰描述
git commit -m "fix(auth): 修复 JWT token 过期后未跳转登录页问题"
```

---

## 四、PR / MR 规范

### PR 模板（`.github/pull_request_template.md`）

```markdown
## 变更描述
<!-- 简要说明本次 PR 做了什么，为什么这样做 -->

## 变更类型
- [ ] feat（新功能）
- [ ] fix（Bug 修复）
- [ ] refactor（重构）
- [ ] docs（文档）
- [ ] chore（工具/依赖）

## 测试情况
- [ ] 已添加单元测试
- [ ] 已在本地联调通过
- [ ] 已在测试环境验证

## 关联 Issue
Closes #

## 注意事项（供 Reviewer 重点关注）
```

### PR 规则

- 单个 PR 变更文件数建议 **≤ 20 个**，行数 **≤ 500 行**（特殊情况注明原因）
- PR 标题遵循 Conventional Commits 格式
- 合并前必须通过 CI、至少 **1 人 Review**
- 不允许 force push 到受保护分支
- 合并策略统一用 **Squash and Merge**（保持 main 分支提交记录整洁）

---

## 五、Git Hooks（本地质量门禁）

使用 `pre-commit` 在本地提交前自动检查，拦截不合规代码进入仓库。

### 安装（Java 项目配合 Maven）

```bash
# 使用 Husky（Node 项目）或 pre-commit（通用）
pip install pre-commit
```

```yaml
# .pre-commit-config.yaml
repos:
  - repo: https://github.com/pre-commit/pre-commit-hooks
    rev: v4.5.0
    hooks:
      - id: trailing-whitespace      # 移除行尾空格
      - id: end-of-file-fixer        # 文件末尾换行
      - id: check-merge-conflict     # 检测未解决的合并冲突标记
      - id: detect-private-key       # 禁止提交私钥

  - repo: local
    hooks:
      - id: checkstyle
        name: Checkstyle
        entry: mvn checkstyle:check -q
        language: system
        pass_filenames: false
```

### commit-msg hook（校验 Commit 格式）

```bash
# .git/hooks/commit-msg
#!/bin/sh
commit_msg=$(cat "$1")
pattern="^(feat|fix|docs|style|refactor|perf|test|chore|ci|revert)(\(.+\))?: .{1,72}"

if ! echo "$commit_msg" | grep -qE "$pattern"; then
  echo "❌ Commit 格式不符合规范！"
  echo "格式：<type>(<scope>): <subject>"
  echo "示例：feat(order): 新增订单超时取消"
  exit 1
fi
```

---

## 六、常用 Git 操作速查

```bash
# 同步主干，变基保持线性历史
git fetch origin && git rebase origin/main

# 交互式整理提交（合并 WIP 提交）
git rebase -i HEAD~3

# 从主干精准摘取某个提交（hotfix 场景）
git cherry-pick <commit-sha>

# 撤销已推送的提交（不修改历史，只新增一个反向提交）
git revert <commit-sha>

# 查看某行代码是谁写的
git blame -L 100,120 src/main/java/com/example/OrderService.java

# 二分查找引入 Bug 的提交
git bisect start
git bisect bad HEAD
git bisect good v1.0.0
```
