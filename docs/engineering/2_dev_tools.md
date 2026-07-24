# 开发工具

---

## 一、IntelliJ IDEA

### 高频快捷键（macOS / Windows）

| 功能 | macOS | Windows |
|------|-------|---------|
| 全局搜索文件 | `⌘⇧O` | `Ctrl+Shift+N` |
| 全局搜索内容 | `⌘⇧F` | `Ctrl+Shift+F` |
| 搜索任意（双击） | `⇧⇧` | `Shift Shift` |
| 跳转到类 | `⌘O` | `Ctrl+N` |
| 查看方法调用链 | `⌘Alt+H` | `Ctrl+Alt+H` |
| 查看接口实现 | `⌘Alt+B` | `Ctrl+Alt+B` |
| 提取变量/方法/常量 | `⌘Alt+V/M/C` | `Ctrl+Alt+V/M/C` |
| 重命名（重构） | `⇧F6` | `Shift+F6` |
| 格式化代码 | `⌘Alt+L` | `Ctrl+Alt+L` |
| 优化 import | `⌘Alt+O` | `Ctrl+Alt+O` |
| 运行当前测试 | `⌃⇧R` | `Ctrl+Shift+F10` |
| 多光标选择相同词 | `⌃G` | `Alt+J` |
| 列模式编辑 | `⌘⇧8` | `Alt+Shift+Insert` |

### 调试技巧

```
条件断点：右键断点 → Condition → 填表达式（如 userId.equals("1001")）
日志断点：右键断点 → 勾选 Evaluate and log → 不暂停，只打印日志
异常断点：Run → View Breakpoints → + → Exception Breakpoints → 指定异常类
Drop Frame：调试时回退到上一帧重新执行（适合重现 Bug）
Remote Debug：JVM 启动加 -agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=5005
```

### Live Templates（代码模板）

```
sout  → System.out.println()
psvm  → public static void main
fori  → 普通 for 循环
iter  → for-each 循环
ifn   → if (xxx == null)
inn   → if (xxx != null)
```

**自定义 Live Template**：Settings → Editor → Live Templates → 新建，输入缩写和展开内容，`$VAR$` 为光标停留位置。

---

## 二、推荐插件

| 插件 | 用途 |
|------|------|
| **Lombok** | 消除 getter/setter/builder 模板代码 |
| **MapStruct Support** | MapStruct 映射提示与双向跳转 |
| **MyBatisX** | Mapper 接口与 XML 互跳、SQL 补全 |
| **RestfulTool** | 按 URL 搜索 Controller 方法（`Ctrl+\`）|
| **GitToolBox** | 行内显示 git blame，快速定位责任人 |
| **SonarLint** | 本地实时代码质量扫描，与 SonarQube 规则同步 |
| **String Manipulation** | 字符串格式互转（camelCase / snake_case / UPPER）|
| **Grep Console** | 控制台日志颜色高亮与过滤 |
| **SequenceDiagram** | 根据调用链自动生成时序图 |

---

## 三、API 调试工具

### APIFox

国内主流 API 协作平台，集设计、调试、Mock、测试于一体。

```
核心能力：
  - API 设计：可视化编辑 OpenAPI 3 规范，生成 Mock 数据
  - 环境管理：dev / test / staging / prod 变量隔离
  - 接口测试：断言、前置脚本（登录取 Token）、后置提取
  - 团队协作：在线实时同步，无需导出文件共享

与 CI 集成：
  npm install -g apifox-cli
  apifox run <collection-id> --env-id <env-id> --token <token>

导入 OpenAPI：
  URL 填 http://localhost:8080/v3/api-docs，点同步即可
```

### Postman 常用技巧

```javascript
// Pre-request Script：自动获取 Token 注入后续请求
pm.sendRequest({
    url: pm.environment.get("base_url") + "/auth/token",
    method: "POST",
    header: { "Content-Type": "application/json" },
    body: { mode: "raw", raw: JSON.stringify({ username: "admin", password: "123456" }) }
}, (err, res) => {
    pm.environment.set("token", res.json().data.token);
});

// Tests 脚本：接口断言
pm.test("状态码 200", () => pm.response.to.have.status(200));
pm.test("包含 orderId", () => {
    pm.expect(pm.response.json().data.orderId).to.be.a("string");
});
// 提取字段供下一个请求使用
pm.environment.set("orderId", pm.response.json().data.orderId);
```

---

## 四、效率工具

### 终端

| 工具 | 平台 | 推荐理由 |
|------|------|---------|
| **iTerm2** | macOS | 分屏、搜索历史、Profile 快速切换环境 |
| **Windows Terminal** | Windows | 多 Tab、PowerShell + WSL 无缝集成 |
| **Oh My Zsh** | macOS/Linux | 插件生态丰富，自动补全、历史建议 |

```bash
# ~/.zshrc 推荐配置
plugins=(git z zsh-autosuggestions zsh-syntax-highlighting docker kubectl)

alias gs="git status"
alias gl="git log --oneline --graph --all"
alias k="kubectl"
alias dps="docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'"
```

### 数据库客户端

| 工具 | 特点 |
|------|------|
| **DataGrip** | JetBrains 出品，与 IDEA 体验一致，支持多数据库，付费 |
| **DBeaver** | 开源免费，支持 100+ 数据源，插件丰富 |
| **TablePlus** | macOS/Windows，UI 简洁，响应快，轻量 |

**DataGrip 技巧**：
- 数据编辑器直接改数据（`F2` 编辑，`Ctrl+Enter` 提交）
- 多结果集横向对比
- SQL 历史记录（`Ctrl+Alt+E`）

### Redis 客户端

| 工具 | 特点 |
|------|------|
| **Another Redis Desktop Manager** | 开源免费，支持 Cluster/Sentinel，树形结构直观 |
| **RedisInsight** | Redis 官方出品，内置分析、慢查询、内存可视化 |

### 多 JDK 版本管理

```bash
# SDKMAN（macOS/Linux）
curl -s "https://get.sdkman.io" | bash
sdk install java 21-tem        # 安装 Temurin 21
sdk install java 17-tem
sdk use java 17-tem            # 当前 shell 切换
sdk default java 21-tem        # 设为全局默认

# jenv（macOS）
brew install jenv
jenv add /Library/Java/JavaVirtualMachines/temurin-21.jdk/Contents/Home
jenv global 21
jenv local 17                  # 当前目录使用 17（写入 .java-version）
```
