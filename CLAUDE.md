# java-doc 知识库总览

> Java 后端技术知识体系文档站，基于 VuePress 构建，覆盖从基础原理到系统架构的完整知识图谱。
> 定位：开发总结 + 工程实践参考手册。

---

## 项目结构

```
docs/
├── ai/             AI：框架 / RAG / Agent / MCP / API 接入 / 工具
├── algorithms/     算法与数据结构
├── architecture/   系统架构 / DDD / 幂等 / 访问控制
├── cache/          缓存：Redis / Caffeine
├── cloud-native/   云原生：Linux / Docker / Kubernetes / VPS
├── database/       数据库：MySQL / 列存 / 分布式 / 时序 / 文档 / 搜索
├── devops/         DevOps：Git 工作流 / CI/CD / Code Review / 团队规范
├── distributed/    分布式理论 / 锁 / 事务 / 会话
├── engineering/    工程效率：构建 / 工具链 / 代码质量 / 线上诊断 / API 规范
├── high-avail/     高可用：限流 / 熔断 / 降级
├── high-con/       高并发：JUC / 线程池 / 系统设计
├── interview/      开发总结（各方向高频问题汇总）
├── iot/            物联网：基础 / 协议 / 开源平台
├── java/           Java 8+ 语言特性
├── jvm/            JVM 原理与调优
├── messaging/      消息队列：Kafka / RocketMQ / RabbitMQ
├── microservices/  微服务：概念 / 拆分 / 组件 / 模式
├── netty/          IO 模型 / Reactor / Netty / WebSocket / SSE
├── observability/  可观测性：日志 / 指标 / 链路追踪 / 告警 / OpenTelemetry
├── patterns/       设计模式（23 种 GoF）
├── protocols/      协议体系：网络通信 / IoT / 远程调用 / 安全 / 文件 / 数据库 / 邮件 / 分布式
├── scenario/       业务场景：大数据
├── security/       安全体系：认证授权 / API 安全 / 数据安全 / 漏洞防护 / 零信任
├── spring/         Spring Framework / WebFlux / Security
├── spring-boot/    Spring Boot / Flyway
└── testing/        测试体系：单元测试 / Mock / 集成测试 / TDD
```

---

## 模块索引

| 模块 | 路径 | 覆盖主题 |
|------|------|----------|
| 面试专题 | `docs/interview/` | Java / DB / 缓存 / JVM / Spring / MQ 高频题 |
| Java 特性 | `docs/java/` | Java 8–21 核心新特性 |
| JVM | `docs/jvm/` | 内存结构 / 类加载 / GC / 调优 |
| 算法 | `docs/algorithms/` | 数据结构 / 搜索 / 排序 / DP / LeetCode |
| 设计模式 | `docs/patterns/` | 23 种 GoF 模式 |
| Spring | `docs/spring/` | IoC / AOP / WebFlux / Security |
| Spring Boot | `docs/spring-boot/` | 自动配置 / Flyway 数据迁移 |
| 测试体系 | `docs/testing/` | 单元测试 / Mock / 集成测试 / TDD |
| Netty | `docs/netty/` | IO 模型 / Reactor / WebSocket / SSE |
| 分布式 | `docs/distributed/` | CAP / Raft / 分布式锁 / 事务 |
| 高并发 | `docs/high-con/` | JUC / 线程池 / 压测 / Profiler |
| 高可用 | `docs/high-avail/` | 限流 / 熔断 / 降级 |
| 消息队列 | `docs/messaging/` | Kafka / RocketMQ / RabbitMQ |
| 微服务 | `docs/microservices/` | 拆分 / 注册发现 / 网关 / 模式 |
| 数据库 | `docs/database/` | MySQL / 分库分表 / 各类 NoSQL |
| 缓存 | `docs/cache/` | Redis / Caffeine / 两级缓存 |
| 系统架构 | `docs/architecture/` | 架构设计 / DDD / 幂等 / 对象存储 |
| 业务场景 | `docs/scenario/` | 大数据场景方案 |
| 云原生 | `docs/cloud-native/` | Linux 运维 / Docker / Kubernetes / Helm / VPS |
| DevOps | `docs/devops/` | Git 工作流 / CI/CD / Code Review / 团队规范 |
| 工程效率 | `docs/engineering/` | 构建工具 / 开发工具 / 代码质量 / 线上诊断 / API 规范 |
| 可观测性 | `docs/observability/` | 日志 / 指标 / 链路追踪 / 告警 / OpenTelemetry |
| 协议体系 | `docs/protocols/` | TCP/UDP / HTTP / IoT 协议 / gRPC / TLS / 数据库协议 |
| 安全体系 | `docs/security/` | 认证授权 / API 安全 / 数据安全 / 漏洞防护 / 零信任 |
| IoT | `docs/iot/` | 物联网架构 / 协议 / 开源平台 |
| AI | `docs/ai/` | Spring AI / LangChain4j / RAG / Agent / MCP / API 接入 / AI 工具 |

---

## 推荐学习路径

```
基础层：  Java 特性 → JVM → 算法 → 设计模式
框架层：  Spring → Spring Boot → Netty
数据层：  数据库 → 缓存 → 消息队列
分布式层：分布式理论 → 高并发 → 高可用 → 微服务
架构层：  系统架构 → 业务场景
运维层：  云原生 → DevOps → 工程效率 → 可观测性 → 协议体系 → 安全体系
新兴层：  IoT → AI
面试：    interview/ 各专题汇总复习
```

---

## 文档约定

- 文件命名：`数字_主题.md`，数字前缀决定侧边栏顺序，全部使用下划线分隔
- 文件夹命名：全小写，多单词使用连字符（kebab-case），如 `cloud-native`、`spring-boot`
- 图片存放：`docs/assets/<模块名>/`
- 待补充内容用 VuePress `warning` callout 标记：`> [!warning] 待补充`
- 参考链接放文章顶部，便于溯源
- 站点部署：GitHub Actions → `.github/workflows/deploy-docs.yml`

## 画图规范

- **禁止**在 Markdown 代码块（` ``` `）内用 ASCII 字符画流程图、时序图、架构图
- **必须**输出 SVG 文件，保存到 `docs/assets/<模块名>/`，Markdown 用 `![描述](../assets/xxx/yyy.svg)` 引用
- SVG 必须携带 CSS 变量，同时支持亮色/暗色主题：

```css
:root {
  --fg:#1a1a2e; --muted:#6b7280; --bg:#f8f9fc; --card:#ffffff; --border:#e2e8f0;
  --p:#6366f1;  --b:#0284c7;    --g:#059669;   --y:#d97706;   --r:#dc2626;
}
:root[data-theme="dark"] {
  --fg:#e5e7eb; --muted:#9ca3af; --bg:#1a1a2e; --card:#252540; --border:#3a3a5c;
  --p:#818cf8;  --b:#38bdf8;    --g:#34d399;   --y:#fbbf24;   --r:#f87171;
}
@media (prefers-color-scheme: dark) {
  :root { /* 同 dark 值 */ }
}
```

- 已有的旧图不强制改动，除非明确要求

## SVG 绘图质量规范

> 以下规范适用于所有新绘制的 SVG，修改已有 SVG 时同样需遵守。

### 文字间距

- **文字基线距所在 `<rect>` 底边 ≥ 12px**（`<text>` 的 `y` 属性是基线，下行字母还会向下延伸约 3px）
- 同一 `<rect>` 内多行文字，最后一行基线必须满足上述要求
- 违例示例：`<rect y="100" height="30"/>` + `<text y="130">`（基线恰好在底边，无留白）

### 箭头间距

- **箭头端点距目标 `<rect>` 边框 6px**（`markerWidth=7` + `refX=6` 时箭头尖端会超出端点约 1px，故线段端点需提前 6px）
- 同时适用于 `<line>` 和 `<path>` 元素：
  - `<line>` 修改 `x2` / `y2`（水平/垂直箭头）
  - `<path>` 修改 `d` 属性中最后一对坐标
- 箭头不得穿过目标框的 `<rect>` 区域

### 框线不重叠

- **兄弟 `<rect>` 元素之间间距 ≥ 8px**（同行或同列布局均适用）
- 验证方式：`rect1.x + rect1.width + 8 ≤ rect2.x`（水平方向）

### 比例合理

- **含 2 行及以上文字的 `<rect>` 高度 ≥ 60px**
- 层级图中各层高度应与内容量相称；同组兄弟层最矮不应低于最高的 50%

### 留白一致

- **viewBox 上下留白差值 ≤ 10px**（上留白 = 第一个元素 `y`；下留白 = `viewBox height - 末尾元素底边`）
- 顶部空白 > 30px 时须添加图表标题（`<text>` 居中，`font-weight="700"`，`font-size="14"`）
- 推荐留白：上 20px、下 20px；有标题时上留白约 10px（标题占用剩余空间）

### 标签不压线

- **箭头旁的文字标注必须完全在箭头线上方或下方，不得与箭头线交叉**
- 水平箭头标注：标注 `y` ≤ 箭头 `y1 - 3`（放在线上方）或 ≥ 箭头 `y1 + font-size + 3`（放在线下方）

### 模块间距均匀

- **同一 SVG 中各层/组之间的间距（含箭头区域）应保持一致，最大间距差值 ≤ 8px**
- 间距定义：上一层底边 → 下一层顶边的距离
- 违例示例：层A→层B 间距 58px，层B→层C 间距 38px（差值 20px）
- 修正方式：统一为相同间距（如均取 46px），同步调整各层 y 坐标

### 层内布局：标题居中 + 内容对称分布

- **层/卡片的标题（tag）使用 `text-anchor="middle"` 水平居中**，x 取层宽中心
- **层内文本内容按列对称分布**，避免全部堆在左侧造成右侧大片留白：
  - 2 条内容：左列 x ≈ 层宽 1/4，右列 x ≈ 层宽 3/4，均使用 `text-anchor="middle"`
  - 3 条内容：前两条左右各占 1/4 和 3/4，第三条居中（x = 层宽 1/2）
  - 4 条及以上：均分为 2 × 2 网格，各列 x 取对应四等分位置
- 列中心 x 计算参考（rect.x=10, width=660）：左列 x=170，右列 x=510，中列 x=340

### 箭头线身可见

- **连接两个元素的箭头必须有可见的线段身体，不能仅有箭头头部**
- 要求：箭头所在间距（上层底边 → 下层顶边）**≥ 30px**，确保线身长度 ≥ 18px
- 线段端点规则：`y1 = 上层底边 + 4`，`y2 = 下层顶边 - 6`（结合箭头间距规范）
- 违例示例：层间距 16px → 线身仅 10px，视觉上只见箭头头部
- 修正方式：增大层间距至 30px，同步下移后续层的 `y` 坐标及文字坐标，并更新 viewBox 高度

### 行内左右分列：右侧文字不溢出

- **同一 `<rect>` 内左右并排的文字，右侧列必须使用 `text-anchor="end"`，x 取 `rect.x + rect.width - 10`**
- 适用场景：层/行内左侧放标题+副标题，右侧放描述（典型如 DDD 分层图）
- 违例示例：`<rect x="20" width="520"/>` + `<text x="380">长描述文字</text>`（文字可延伸到 580，超出 viewBox）
- 修正方式：`<text x="530" text-anchor="end">长描述文字</text>`（530 = 20 + 520 − 10）

### 审查清单（修改 SVG 后自检）

```
□ 每个 <rect> 内所有 <text> 基线距底边 ≥ 12px
□ 每条箭头端点距目标框边 ≥ 6px，且不穿入框内
□ 所有同行/同列 <rect> 之间间距 ≥ 8px，无重叠
□ 含多行文字的 <rect> 高度 ≥ 60px
□ viewBox 上下留白差值 ≤ 10px
□ 箭头标注文字不与箭头线交叉
□ 层级图各层之间间距差值 ≤ 8px（无大片留白）
□ 层内文本均匀分布，无单侧大面积空白
□ 行内右侧描述文字使用 text-anchor="end"，不超出 rect 右边界
□ 箭头所在层间距 ≥ 30px，线身长度 ≥ 18px，不能只有箭头头部
```
