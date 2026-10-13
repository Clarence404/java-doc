---
description: 初始配置、日常提交、分支与远程同步、整理历史、撤销与找回、stash、tag、定位问题
---

# Git 命令速查

> 前置阅读：[Git 工作流](/devops/1_git_workflow)

日常开发与排查中最常用的 Git 命令，按操作场景分组，可直接复制执行。分支模型、Commit 规范与钩子见前置阅读，基线为 Git 2.5x。

---

## 一、初始配置

| 场景 | 命令 | 说明 |
|------|------|------|
| 设置提交身份 | `git config --global user.name "<name>"`、`git config --global user.email "<email>"` | 单个仓库去掉 `--global` 单独设置 |
| 新仓库默认分支名 | `git config --global init.defaultBranch main` | 新建仓库时生效 |
| 拉取时默认变基 | `git config --global pull.rebase true` | 避免产生无意义的合并提交 |
| 变基前自动暂存 | `git config --global rebase.autoStash true` | 工作区有改动也能直接 `pull --rebase` |
| 首次推送自动建立跟踪 | `git config --global push.autoSetupRemote true` | 新分支直接 `git push`，不用写 `-u origin HEAD` |
| 记住冲突解决方式 | `git config --global rerere.enabled true` | 反复变基时同一处冲突只需解决一次 |
| 查看配置来源 | `git config --list --show-origin` | 排查配置在哪个文件里被覆盖 |
| 浅克隆大仓库 | `git clone --depth 1 <url>` | 只要最新代码时使用，CI 中常用 |
| 部分克隆 | `git clone --filter=blob:none <url>` | 保留完整提交历史，文件内容按需下载 |

---

## 二、日常提交

| 场景 | 命令 | 说明 |
|------|------|------|
| 查看状态 | `git status -sb` | 简洁格式，带分支与领先 / 落后提交数 |
| 查看未暂存的改动 | `git diff` | 已暂存的改动用 `git diff --staged` |
| 交互式暂存部分改动 | `git add -p` | 按块选择，避免把调试代码一起提交 |
| 提交 | `git commit -m "feat(order): support timeout cancel"` | 信息格式遵循 Conventional Commits |
| 修改最后一次提交 | `git commit --amend --no-edit` | 补漏文件且不改提交信息；已推送的提交慎用 |
| 取消暂存 | `git restore --staged <file>` | 改动保留在工作区 |
| 丢弃工作区改动 | `git restore <file>` | 不可恢复，执行前确认 |
| 停止跟踪但保留本地文件 | `git rm --cached <file>` | 误提交的配置文件，随后加入 `.gitignore` |
| 查看文件为何被忽略 | `git check-ignore -v <file>` | 输出命中的 `.gitignore` 文件与行号 |

---

## 三、分支与远程同步

| 场景 | 命令 | 说明 |
|------|------|------|
| 基于最新主干切分支 | `git fetch origin && git switch -c feat/ORD-128 origin/main` | 不依赖本地 `main` 是否最新 |
| 切换分支 | `git switch <branch>` | 回到上一个分支用 `git switch -` |
| 推送并建立跟踪 | `git push -u origin HEAD` | 已开启 `push.autoSetupRemote` 时直接 `git push` |
| 跟上主干 | `git fetch origin && git rebase origin/main` | 功能分支用变基，不用合并 |
| 查看分支与跟踪关系 | `git branch -vv` | 显示每个分支的上游与领先 / 落后数 |
| 清理远程已删除的分支引用 | `git fetch --prune` | 可配 `git config --global fetch.prune true` |
| 列出已合并到主干的分支 | `git branch --merged origin/main` | 确认后再删除 |
| 删除本地分支 | `git branch -d <branch>` | 未合并的分支需要 `-D` 强删 |
| 删除远程分支 | `git push origin --delete <branch>` | 受规则集保护的分支无法删除 |
| 查看远程地址 | `git remote -v` | 修改用 `git remote set-url origin <url>` |

---

## 四、整理提交历史

| 场景 | 命令 | 说明 |
|------|------|------|
| 为旧提交补一个修正 | `git commit --fixup=<commit-sha>` | 生成 `fixup!` 提交，等待自动压缩 |
| 自动压缩修正提交 | `git rebase -i --autosquash origin/main` | 打开编辑器确认顺序后保存 |
| 合并最近几次提交 | `git reset --soft HEAD~3 && git commit -m "<message>"` | 改动全部保留在暂存区 |
| 变基后安全地强推 | `git push --force-with-lease --force-if-includes` | 远程被别人更新过时拒绝覆盖；只用于自己的分支 |
| 中止变基 | `git rebase --abort` | 回到变基开始前的状态 |
| 解决冲突后继续变基 | `git add <file> && git rebase --continue` | 跳过当前提交用 `git rebase --skip` |
| 对比变基前后的提交 | `git range-diff origin/main @{1} @` | 变基完成后立即执行，`@{1}` 是分支变基前的位置 |

---

## 五、撤销与找回

| 场景 | 命令 | 说明 |
|------|------|------|
| 撤销已推送的提交 | `git revert <commit-sha>` | 新增反向提交，不改写历史，主干上只用这种方式 |
| 撤销合并提交 | `git revert -m 1 <merge-commit-sha>` | `-m 1` 表示保留主干一侧 |
| 撤销本地最后一次提交 | `git reset --soft HEAD~1` | 改动回到暂存区，可重新提交 |
| 本地分支与远程完全一致 | `git fetch origin && git reset --hard origin/<branch>` | 丢弃本地所有提交和改动，执行前确认 |
| 预览要清理的未跟踪文件 | `git clean -nd` | 确认无误后把 `-n` 换成 `-f` 才真正删除 |
| 恢复某个文件到指定版本 | `git restore --source=<commit-sha> -- <file>` | 只影响工作区该文件 |
| 查看文件在某个版本的内容 | `git show <commit-sha>:<path>` | 不修改工作区 |
| 找回误删的提交或分支 | `git reflog` | 找到目标提交后 `git switch -c rescue <sha>` |
| 摘取提交到其他分支 | `git cherry-pick -x <commit-sha>` | `-x` 在提交信息里记录来源 |

---

## 六、stash 与 worktree

| 场景 | 命令 | 说明 |
|------|------|------|
| 临时保存改动 | `git stash push -u -m "wip: order timeout"` | `-u` 连同未跟踪文件一起保存 |
| 查看保存列表 | `git stash list` | 最新的是 `stash@{0}` |
| 查看某次保存的内容 | `git stash show -p stash@{0}` | 以补丁形式显示 |
| 恢复并删除 | `git stash pop` | 有冲突时不会删除该条记录 |
| 恢复但保留 | `git stash apply stash@{1}` | 需要应用到多个分支时使用 |
| 并行处理另一个分支 | `git worktree add ../hotfix-1.4 -b hotfix/1.4.1 v1.4.0` | 新目录独立检出，不打断当前工作 |
| 列出与清理 worktree | `git worktree list`、`git worktree remove ../hotfix-1.4` | 用完及时删除 |

---

## 七、tag 与版本

| 场景 | 命令 | 说明 |
|------|------|------|
| 打附注 tag | `git tag -a v1.4.0 -m "release 1.4.0"` | 发版用附注 tag，带作者与时间 |
| 推送 tag | `git push origin v1.4.0` | `git push` 默认不推送 tag |
| 删除 tag | `git tag -d v1.4.0 && git push origin --delete v1.4.0` | 已发布的版本 tag 不要移动或复用 |
| 最近的 tag | `git describe --tags --abbrev=0` | 生成版本号、变更日志时使用 |
| 两个版本之间的提交 | `git log --oneline v1.3.0..v1.4.0` | 整理发布说明 |
| 当前提交的短哈希 | `git rev-parse --short HEAD` | 写入镜像标签或构建信息 |

---

## 八、查看历史与定位问题

| 场景 | 命令 | 说明 |
|------|------|------|
| 图形化查看历史 | `git log --oneline --graph --decorate -20` | 最近 20 条，带分支与 tag |
| 某个文件的修改历史 | `git log --follow -p -- <file>` | `--follow` 跟踪重命名 |
| 哪次提交引入或删除了某段代码 | `git log -S 'payTimeout' --oneline` | 按内容增减搜索提交（pickaxe） |
| 按提交信息搜索 | `git log --grep='ORD-128' --oneline` | 按工单号查关联提交 |
| 某几行最后由谁修改 | `git blame -L 100,120 <file>` | 忽略格式化提交可加 `--ignore-revs-file .git-blame-ignore-revs` |
| 分支相对主干改了什么 | `git diff --stat origin/main...HEAD` | 三个点表示从分叉点开始比较 |
| 二分查找引入缺陷的提交 | `git bisect start HEAD v1.4.0 && git bisect run ./mvnw -q -Dtest=OrderTimeoutTest test` | 脚本退出码 0 为好、125 跳过、其他为坏 |
| 结束二分查找 | `git bisect reset` | 回到开始前的分支 |
| 在代码中搜索 | `git grep -n 'payTimeout'` | 只搜已跟踪文件，比 `grep -r` 快 |
| 贡献者统计 | `git shortlog -sn --no-merges` | 按提交数排序 |

---

## 小结

最该记住的 5 条：

- `git fetch origin && git rebase origin/main`：功能分支跟上主干
- `git push --force-with-lease --force-if-includes`：变基后安全地强推
- `git revert <commit-sha>`：撤销已推送的提交，不改写历史
- `git reflog`：误操作后找回提交与分支
- `git bisect run <测试命令>`：自动二分定位引入缺陷的提交

## 参考资料

- Git 命令参考：[Git Reference](https://git-scm.com/docs)
- 配置项说明：[git-config 文档](https://git-scm.com/docs/git-config)
- 强推保护：[git-push 文档](https://git-scm.com/docs/git-push)
- 变基与 autosquash：[git-rebase 文档](https://git-scm.com/docs/git-rebase)
- 引用日志：[git-reflog 文档](https://git-scm.com/docs/git-reflog)
- 多工作区：[git-worktree 文档](https://git-scm.com/docs/git-worktree)
- 二分查找：[git-bisect 文档](https://git-scm.com/docs/git-bisect)
- 部分克隆：[Partial Clone](https://git-scm.com/docs/partial-clone)
- 提交信息规范：[Conventional Commits 1.0.0](https://www.conventionalcommits.org/en/v1.0.0/)

> 下一篇：[Docker 与 kubectl 速查](./2_container)
