---
description: IDEA 快捷键与调试、远程调试、HTTP Client / Bruno、插件、终端与 JDK 版本管理
---

# 开发工具

> **本篇目标**：把 IntelliJ IDEA 用顺手（高频快捷键、断点技巧、JDWP 远程调试），用可以进 Git 的 `.http` 文件或 Bruno 取代散落在个人电脑上的接口集合，并用 SDKMAN / mise 在多 JDK 之间按项目切换。
>
> **前置阅读**：[构建工具](./1_build_tools)

本篇只讲 IDE 和桌面工具本身。Lombok、MapStruct 等库的用法见 [效率工具库](/java/98_dev_tool)，代码质量插件的规则与门禁见 [代码质量](./3_code_quality)，AI 编码助手见 [AI 工具](/ai/6_tools/0_ai_tools)。版本以 2026 年 10 月为准：IntelliJ IDEA 2026.x、JDK 21（25 为最新 LTS）。

---

## 一、IntelliJ IDEA

### 1、统一发行版

从 2025.3 起，IntelliJ IDEA 不再区分 Community 和 Ultimate 两个安装包，合并为**一个统一发行版**：

- 不订阅也能用，原 Community 的全部功能对商业项目同样免费，并新增了基础数据库工具、Spring 项目向导等
- Ultimate 变成同一个 IDE 里的订阅解锁项，完整的 Spring 支持、Database Tools、IntelliJ Profiler、HTTP Client、Endpoints 工具窗口等需要订阅
- 订阅到期不会锁死 IDE，只是回落到免费功能

还想用独立的 Community 版只能停在 2025.2 及以前。下文标注「Ultimate」的功能，以 JetBrains 官网的功能对比为准。

### 2、高频快捷键

Windows 列是默认 keymap（Windows / Linux 相同），macOS 列是 macOS keymap。

| 功能 | macOS | Windows / Linux |
|------|-------|-----------------|
| 搜索任意（类、文件、动作） | `⇧⇧` | `Shift Shift` |
| 跳转到类 | `⌘O` | `Ctrl+N` |
| 跳转到文件 | `⌘⇧O` | `Ctrl+Shift+N` |
| 全局搜索内容 | `⌘⇧F` | `Ctrl+Shift+F` |
| 查看接口实现 | `⌘⌥B` | `Ctrl+Alt+B` |
| 查看方法调用层级 | `⌃⌥H` | `Ctrl+Alt+H` |
| 最近文件 | `⌘E` | `Ctrl+E` |
| 提取变量 / 方法 / 常量 | `⌘⌥V` / `⌘⌥M` / `⌘⌥C` | `Ctrl+Alt+V` / `M` / `C` |
| 重命名（重构） | `⇧F6` | `Shift+F6` |
| 格式化代码 | `⌘⌥L` | `Ctrl+Alt+L` |
| 优化 import | `⌃⌥O` | `Ctrl+Alt+O` |
| 运行光标处的测试 / main | `⌃⇧R` | `Ctrl+Shift+F10` |
| 选中下一个相同词（多光标） | `⌃G` | `Alt+J` |
| 列选择模式 | `⌘⇧8` | `Alt+Shift+Insert` |

记不住的快捷键用 `⇧⇧` 搜动作名即可；装 Key Promoter X 插件，鼠标点菜单时会提示对应快捷键。

### 3、调试

调试快捷键：

| 动作 | macOS | Windows / Linux |
|------|-------|-----------------|
| 切换断点 | `⌘F8` | `Ctrl+F8` |
| 查看全部断点 | `⌘⇧F8` | `Ctrl+Shift+F8` |
| 单步跳过 / 进入 / 跳出 | `F8` / `F7` / `⇧F8` | `F8` / `F7` / `Shift+F8` |
| 运行到光标 | `⌥F9` | `Alt+F9` |
| 继续运行 | `⌘⌥R` | `F9` |
| 计算表达式 | `⌥F8` | `Alt+F8` |

常用断点与调试技巧：

| 技巧 | 操作 | 适用场景 |
|------|------|----------|
| 条件断点 | 右键断点 → Condition，填布尔表达式，如 `"1001".equals(userId)` | 循环或高频接口里只停特定数据 |
| 日志断点 | 右键断点 → 取消 Suspend，勾选 Evaluate and log | 不停线程、不改代码地打印变量 |
| 异常断点 | 查看全部断点 → `+` → Java Exception Breakpoints，指定异常类 | 异常被吞或被包装，找第一现场 |
| 字段断点 | 在字段声明行加断点（Field Watchpoint） | 找出是谁改了某个字段 |
| Reset Frame | 调试工具栏的 Reset Frame（旧版叫 Drop Frame） | 回到当前方法开头重新执行；已产生的副作用（写库、发消息）不会回滚 |
| 计算表达式 | 暂停时 `Alt+F8` 执行任意表达式 | 临时调用方法验证猜想 |
| Async Stack Traces | 默认开启，在线程池、`CompletableFuture` 中显示提交方的调用栈 | 异步代码定位调用来源 |
| Stream Trace | 停在 Stream 链上时点 Trace Current Stream Chain | 看每个中间操作后的元素 |

### 4、远程调试（JDWP）

目标 JVM 启动时加 JDWP agent，IDEA 用 Run → Edit Configurations → `+` → Remote JVM Debug 连接，它会生成同样的参数供复制：

```bash
java -agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=*:5005 -jar app.jar
```

- **JDK 9 起 `address=5005` 只监听 localhost**，从另一台机器连不上；要接受远程连接必须写成 `address=*:5005`（或指定网卡 IP）
- `suspend=y` 会让 JVM 等调试器连上才启动，适合排查启动阶段的问题
- 容器里通过环境变量注入，不改启动脚本：`JAVA_TOOL_OPTIONS="-agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=*:5005"`

::: warning 只在受控环境开启
JDWP 没有认证，任何能连上端口的人都能在目标 JVM 里执行任意代码。只在开发、测试环境开启，端口不暴露到公网；Kubernetes 里优先保持监听 localhost，再用 `kubectl port-forward pod/<pod-name> 5005:5005` 转发到本机。断点停住的是真实线程，在共享环境调试时优先用日志断点。生产问题用 [Arthas 线上诊断](./4_diagnosis)。
:::

### 5、Live Templates 与 Postfix

内置模板（输入缩写后按 `Tab`）：

| 缩写 | 展开 |
|------|------|
| `sout` / `soutv` / `soutm` | `System.out.println()`，分别带变量值、方法名 |
| `psvm` 或 `main` | `public static void main(String[] args)` |
| `fori` / `iter` | 下标 for 循环 / for-each 循环 |
| `ifn` / `inn` | `if (x == null)` / `if (x != null)` |
| `thr` | `throw new` |

Postfix 补全写在表达式后面：`list.for` 生成 for-each，`user.nn` 生成非空判断，`new Order().var` 提取局部变量，`result.return` 生成 return 语句。

自定义模板：Settings → Editor → Live Templates → `+`，例如缩写 `logd`、模板文本：

```text
log.debug("$MSG$: {}", $VAR$);$END$
```

`$MSG$`、`$VAR$` 是模板变量，展开后按 `Tab` 依次跳转填写，可在 Edit Variables 里给它们配默认值或表达式；`$END$` 是填写完成后光标最终停留的位置。最后在 Define 里勾选适用上下文（如 Java → Statement）。

---

## 二、插件

先确认是不是已经内置，再装插件：

- **Lombok**：2020.3 起内置支持，无需安装插件（库本身仍要引依赖，见 [效率工具库](/java/98_dev_tool)）
- **按 URL 找 Controller**：Ultimate 的 Endpoints 工具窗口可按路径搜索 Spring MVC / WebFlux 接口，RestfulTool 类插件已多年未适配新版 IDE
- **行内 blame**：Code Vision 默认在方法上显示最近修改者，右键行号 → Annotate with Git Blame 看逐行作者；GitToolBox 已转为付费插件

| 插件 | 用途 |
|------|------|
| **SonarQube for IDE** | 原 SonarLint，本地实时扫描；连接 SonarQube Server / Cloud 后与服务端规则和质量配置同步，见 [代码质量](./3_code_quality) |
| **MyBatisX** | Mapper 接口与 XML 互跳、SQL 补全、代码生成 |
| **MapStruct Support** | MapStruct 映射属性补全、校验与跳转 |
| **String Manipulation** | camelCase / snake_case / 常量名等格式互转 |
| **Grep Console** | 控制台日志按级别着色、过滤 |
| **Key Promoter X** | 提示鼠标操作对应的快捷键 |

插件越多启动越慢、越容易与新版本不兼容。团队必装的插件写在项目的 `.idea/externalDependencies.xml` 里（Settings → Build, Execution, Deployment → Required Plugins），打开项目时 IDEA 会提示缺失的插件。

---

## 三、API 调试

### 1、怎么选

| 工具 | 数据存在哪 | 能否进 Git 评审 | CI 运行 | 适合 |
|------|-----------|----------------|---------|------|
| **IntelliJ HTTP Client** | 项目里的 `.http` 文件 | 能 | `ijhttp` 命令行（免费） | 后端自测、接口样例随代码一起评审 |
| **Bruno** | 本地文件夹（YAML / `.bru`） | 能 | `bru run` | 离线、不想把接口数据放到云端的团队 |
| **Postman** | 云端工作区 | 需导出 | Postman CLI / Newman | 已有大量集合、跨团队共享 |
| **Apifox** | 云端项目 | 需导出 | `apifox run` | 国内团队一体化设计 / Mock / 测试 |

后端项目推荐 **`.http` 文件或 Bruno**：接口样例与代码同仓库，PR 里能看到接口变化，换电脑或新人入职不用再导入集合。接口文档本身由代码生成，见 [API 文档](./5_api_doc)。

### 2、IntelliJ HTTP Client

在项目里建 `http/order.http`（IDE 内编辑和运行需 Ultimate，命令行 `ijhttp` 免费）：

```http
### 登录，取 Token 存入全局变量
POST {{baseUrl}}/auth/token
Content-Type: application/json

{
  "username": "{{username}}",
  "password": "{{password}}"
}

> {%
    client.global.set("token", response.body.data.token);
%}

### 查询订单
GET {{baseUrl}}/orders/1001
Authorization: Bearer {{token}}

> {%
    client.test("状态码 200", () => {
        client.assert(response.status === 200, "实际状态码 " + response.status);
    });
%}
```

环境变量分两个文件：`http-client.env.json` 放公共变量并提交，`http-client.private.env.json` 放密码等敏感值，加入 `.gitignore`：

```json
{
  "dev": { "baseUrl": "http://localhost:8080", "username": "dev-user" },
  "test": { "baseUrl": "https://order.test.example.com", "username": "qa-user" }
}
```

```json
{
  "dev": { "password": "local-only-password" }
}
```

CI 里用 `ijhttp`（ZIP 版需 JDK 25+，也有 Docker 镜像 `jetbrains/intellij-http-client`），敏感值用 `-P` 从 CI Secret 传入，`--report` 输出 JUnit XML：

```bash
ijhttp --env-file http/http-client.env.json --env test \
  -P password="$API_TEST_PASSWORD" \
  --report http/order.http
```

### 3、Bruno

Bruno 是开源、离线优先的 API 客户端，集合就是一个普通文件夹（根目录有 `opencollection.yml` 或 `bruno.json`），每个请求一个文件，可以直接提交到仓库。命令行在集合根目录运行：

```bash
npm install -g @usebruno/cli
bru run orders --env ci --env-var API_PASSWORD="$API_TEST_PASSWORD" --reporter-junit results.xml
```

密钥类变量在 Bruno 里标记为 Secret，不会写进集合文件，CI 中用 `--env-var` 传入。

### 4、Postman 脚本

Pre-request Script 自动取 Token，账号密码从环境变量读，不写死在脚本里：

```javascript
pm.sendRequest({
    url: pm.environment.get("base_url") + "/auth/token",
    method: "POST",
    header: { "Content-Type": "application/json" },
    body: {
        mode: "raw",
        raw: JSON.stringify({
            username: pm.environment.get("username"),
            password: pm.environment.get("password")
        })
    }
}, (err, res) => {
    if (err || res.code !== 200) {
        console.error("获取 Token 失败", err || res.code);
        return;
    }
    pm.environment.set("token", res.json().data.token);
});
```

Tests（Post-response）脚本做断言并提取字段：

```javascript
pm.test("状态码 200", () => pm.response.to.have.status(200));
pm.test("返回 orderId", () => {
    pm.expect(pm.response.json().data.orderId).to.be.a("string");
});
pm.environment.set("orderId", pm.response.json().data.orderId);
```

`password` 在环境里设为 secret 类型，并且只填 Current Value，不要同步到团队共享的 Initial Value。

### 5、Apifox

Apifox 集 API 设计、调试、Mock、自动化测试于一体：

- **设计与导入**：可视化编辑 OpenAPI 3；导入时 URL 填 `http://localhost:8080/v3/api-docs` 并开启定时同步
- **环境管理**：dev / test / staging 变量隔离，前置脚本登录取 Token
- **自动化测试**：把接口串成测试场景，带断言与变量提取
- **CI 集成**：在测试场景的 CI/CD 页签生成命令，Access Token 放 CI Secret

```bash
npm install -g apifox-cli
apifox run --access-token "$APIFOX_ACCESS_TOKEN" -t <测试场景ID> -e <环境ID> -r cli,html
```

参数以场景页签生成的命令为准，HTML 报告默认输出到 `apifox-reports/`。

---

## 四、效率工具

### 1、终端

| 工具 | 平台 | 推荐理由 |
|------|------|---------|
| **iTerm2** | macOS | 分屏、搜索、Profile 快速切换 |
| **Windows Terminal** | Windows | 多 Tab，PowerShell / WSL / Git Bash 统一入口 |
| **Oh My Zsh** | macOS / Linux / WSL | zsh 配置框架，自带 git、z、docker、kubectl 等插件 |

`zsh-autosuggestions`、`zsh-syntax-highlighting` 是第三方插件，**不随 Oh My Zsh 自带**，先克隆到自定义插件目录，否则启动时会报 `plugin not found`：

```bash
git clone https://github.com/zsh-users/zsh-autosuggestions \
  "${ZSH_CUSTOM:-$HOME/.oh-my-zsh/custom}/plugins/zsh-autosuggestions"
git clone https://github.com/zsh-users/zsh-syntax-highlighting \
  "${ZSH_CUSTOM:-$HOME/.oh-my-zsh/custom}/plugins/zsh-syntax-highlighting"
```

然后在 `~/.zshrc` 中启用（`zsh-syntax-highlighting` 放最后）：

```bash
plugins=(git z docker kubectl zsh-autosuggestions zsh-syntax-highlighting)

alias gs="git status"
alias gl="git log --oneline --graph --all"
alias k="kubectl"
alias dps="docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'"
```

### 2、数据库客户端

| 工具 | 特点 |
|------|------|
| **IDEA 内置 Database** | 统一发行版免费提供基础数据库工具，完整 Database Tools 需 Ultimate |
| **DataGrip** | JetBrains 独立数据库 IDE，与 IDEA 的数据库功能同源；商业使用需授权 |
| **DBeaver** | 社区版开源免费，支持上百种数据源 |
| **TablePlus** | macOS / Windows，界面简洁、启动快 |

JetBrains 数据库工具的几个实用点：结果集表格可直接改值后提交（事务模式下需手动 Commit）；多个查询结果可钉住对比；控制台执行过的 SQL 都留在历史里，可按关键字检索。连生产库时把数据源标为只读，并给连接设置醒目的颜色。

### 3、Redis 客户端

| 工具 | 特点 |
|------|------|
| **Redis Insight** | Redis 官方出品，支持 Cluster / Sentinel，带慢查询、内存分析与 Profiler |
| **Another Redis Desktop Manager** | 开源免费，树形浏览 Key，支持 Cluster / Sentinel / SSH 隧道 |

### 4、多 JDK 版本管理

| 工具 | 平台 | 特点 |
|------|------|------|
| **IDEA 内置下载** | 全平台 | Project Structure → SDKs → `+` → Download JDK，只管 IDE 内使用 |
| **SDKMAN** | macOS / Linux / WSL | 安装和切换 JDK、Maven、Gradle，支持项目级 `.sdkmanrc` |
| **mise** | 全平台（含 Windows） | 兼容 asdf 生态，一个工具管 JDK / Node / Maven 等多种运行时，项目级 `mise.toml` |
| **jenv** | macOS / Linux | 只负责切换，JDK 需另行安装后注册 |

**SDKMAN** 的候选标识（Identifier）是「完整版本号 + 发行商后缀」，`21-tem` 这类简写不存在，要先查列表再复制：

```bash
curl -s "https://get.sdkman.io" | bash
sdk list java | grep tem                 # 查看 Temurin 的可用 Identifier
sdk install java 21.0.12+1.1-tem          # 以 sdk list java 实际输出的 Identifier 为准
sdk use java 21.0.12+1.1-tem              # 仅当前 shell 生效
sdk default java 21.0.12+1.1-tem          # 设为全局默认

sdk env init                              # 在项目根目录生成 .sdkmanrc，记录当前版本
sdk env                                   # 进入项目后切换到 .sdkmanrc 中的版本
```

**mise** 的版本写法是 `java@<发行商>-<主版本>`，会解析到该主版本最新的补丁：

```bash
mise use --global java@temurin-21         # 全局默认
mise use java@temurin-25                  # 当前项目，写入 mise.toml
mise ls java                              # 查看已安装版本
```

**jenv** 通过 shims 改写 `java` 命令和 `JAVA_HOME`，不负责下载：

```bash
brew install jenv
jenv add /Library/Java/JavaVirtualMachines/temurin-21.jdk/Contents/Home
jenv versions                             # 查看注册后的版本名
jenv global 21
jenv local 17                             # 当前目录使用 17（写入 .java-version）
jenv enable-plugin export                 # 让 JAVA_HOME 跟随切换，Maven / Gradle 才能感知
```

项目级版本文件（`.sdkmanrc`、`mise.toml`、`.java-version`）提交到仓库，配合 Maven Toolchains 或 Gradle Toolchains（见 [构建工具](./1_build_tools)）让本地、CI 用同一个 JDK 主版本。

### 5、AI 编码助手

IDE 内的 AI 助手（JetBrains AI Assistant、GitHub Copilot 等）和命令行 Agent（Claude Code 等）已是日常工具。生成的代码同样要过格式化、静态分析和测试这道门禁，不因为是 AI 写的就放宽；选型与用法见 [AI 工具](/ai/6_tools/0_ai_tools)。

---

## 小结

- IntelliJ IDEA 自 2025.3 起是统一发行版，免费部分可用于商业项目，Spring 完整支持、HTTP Client、Profiler 等需 Ultimate 订阅
- macOS 的调用层级与优化 import 是 `⌃⌥H`、`⌃⌥O`；Drop Frame 已改名 Reset Frame，且不会回滚副作用
- JDK 9+ 远程调试要写 `address=*:5005` 才能接受远程连接；JDWP 无认证，只在受控环境开启，K8s 用 port-forward
- 接口样例优先放进仓库：`.http` 文件（`ijhttp` 跑 CI）或 Bruno；密码等敏感值放私有环境文件或 CI Secret
- Lombok 支持已内置，SonarLint 已更名 SonarQube for IDE，团队必装插件用 Required Plugins 声明
- SDKMAN 的 Identifier 要用 `sdk list java` 里的完整写法；版本文件提交到仓库，与构建工具的 Toolchains 配合

## 参考资料

- IntelliJ IDEA 统一发行版说明：[IntelliJ IDEA as a unified product](https://www.jetbrains.com/help/idea/intellij-idea-single-distribution.html)
- IntelliJ IDEA 快捷键参考：[IntelliJ IDEA keyboard shortcuts](https://www.jetbrains.com/help/idea/mastering-keyboard-shortcuts.html)
- IntelliJ IDEA 调试器文档：[Debug code](https://www.jetbrains.com/help/idea/debugging-code.html)
- IntelliJ IDEA 远程调试：[Tutorial: Remote debug](https://www.jetbrains.com/help/idea/tutorial-remote-debug.html)
- JDWP agent 参数：[Java Platform Debugger Architecture](https://docs.oracle.com/en/java/javase/21/docs/specs/jpda/conninv.html)
- Live Templates：[Live templates](https://www.jetbrains.com/help/idea/using-live-templates.html)
- HTTP Client：[HTTP Client](https://www.jetbrains.com/help/idea/http-client-in-product-code-editor.html)
- HTTP Client 命令行：[HTTP Client CLI](https://www.jetbrains.com/help/idea/http-client-cli.html)
- Bruno CLI：[bru run](https://docs.usebruno.com/bru-cli/run/overview)
- Postman 脚本：[Write scripts in Postman](https://learning.postman.com/docs/tests-and-scripts/write-scripts/intro-to-scripts/)
- Apifox CLI：[Apifox CLI 文档](https://docs.apifox.com/doc-5637752)
- SonarQube for IDE：[SonarQube for IntelliJ](https://docs.sonarsource.com/sonarqube-for-intellij/)
- Oh My Zsh 自定义插件：[Customization](https://github.com/ohmyzsh/ohmyzsh/wiki/Customization)
- SDKMAN 使用说明：[SDKMAN Usage](https://sdkman.io/usage)
- mise Java 插件：[mise Java](https://mise.jdx.dev/lang/java.html)
- jenv：[jenv 仓库](https://github.com/jenv/jenv)

> 下一篇：[代码质量](./3_code_quality)
