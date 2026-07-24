# Code Review

> 参考资料：
> * Google Engineering Practices：[https://google.github.io/eng-practices/review/](https://google.github.io/eng-practices/review/)
> * Conventional Comments：[https://conventionalcomments.org/](https://conventionalcomments.org/)

---

## 一、核心原则

- **Review 代码，而非评判人**：所有评论针对代码本身，不带个人情绪
- **作者负责理解，Reviewer 负责提问**：Reviewer 看不懂就说看不懂，不是作者的错就是文档不足
- **小 PR 优于大 PR**：单次 PR 建议 ≤ 400 行，超过 800 行的 PR 很难 Review 到位
- **速度比完美更重要**：非关键问题不阻塞合并，留 comment 即可；1 个工作日内完成 Review

---

## 二、Reviewer 职责清单

### 必须检查

- [ ] **正确性**：逻辑是否正确，边界条件是否处理（null、空集合、并发）
- [ ] **安全性**：SQL 注入、XSS、未授权访问、敏感信息泄露
- [ ] **性能**：循环内 DB 查询（N+1）、大对象频繁创建、缺少索引
- [ ] **可读性**：命名是否清晰，逻辑是否能在 5 分钟内理解
- [ ] **测试覆盖**：核心分支是否有测试，异常路径是否覆盖

### 建议检查（非阻塞）

- [ ] 是否有更简洁的实现方式
- [ ] 重复代码是否可以抽取
- [ ] 注释是否解释了"为什么"（而非"做了什么"）

---

## 三、作者职责清单

提交 PR 前自检：

- [ ] 本地运行所有测试通过
- [ ] PR 描述清楚说明了"做了什么"和"为什么"
- [ ] 变更范围聚焦，无无关修改混入
- [ ] 删除了调试代码、TODO、临时注释
- [ ] 关联了对应的 Issue 或需求单

---

## 四、Conventional Comments 规范

在评论前加**标签**，让意图一目了然：

| 标签 | 含义 | 是否阻塞合并 |
|------|------|------------|
| `[blocker]` | 必须修改，否则不能合并 | ✅ 是 |
| `[suggestion]` | 建议修改，作者可自行判断 | ❌ 否 |
| `[question]` | 需要解释，不一定要修改代码 | ❌ 否 |
| `[nitpick]` | 细节/风格问题，可忽略 | ❌ 否 |
| `[praise]` | 写得好，给正向反馈 | ❌ 否 |
| `[thought]` | 随想/探讨，无需回应 | ❌ 否 |

### 示例

```
[blocker] 这里存在 SQL 注入风险，userId 需要参数化处理，不能直接拼接字符串。

[suggestion] 这个 for 循环可以用 stream + filter 简化，可读性更好：
  list.stream().filter(x -> x.isActive()).toList()

[question] 为什么这里选择了同步调用而不是异步？是有顺序依赖吗？

[nitpick] 变量名 `tmp` 不够语义化，可以改为 `pendingOrders`。

[praise] 这个幂等设计很优雅，双重检查 + 唯一索引兜底，处理得很周全 👍
```

---

## 五、常见问题速查

### 代码逻辑

```java
// ❌ 循环内查 DB（N+1 问题）
for (Long orderId : orderIds) {
    Order order = orderMapper.selectById(orderId);  // 每次都查 DB
}

// ✅ 批量查询
List<Order> orders = orderMapper.selectBatchIds(orderIds);
Map<Long, Order> orderMap = orders.stream()
    .collect(toMap(Order::getId, identity()));
```

```java
// ❌ 捕获异常后不处理（吞掉异常）
try {
    process();
} catch (Exception e) {
    // 什么都不做
}

// ✅ 至少记录日志
try {
    process();
} catch (Exception e) {
    log.error("处理失败，orderId={}", orderId, e);
    throw new ServiceException("处理失败", e);
}
```

### 安全问题

```java
// ❌ SQL 拼接（注入风险）
String sql = "SELECT * FROM user WHERE name = '" + name + "'";

// ✅ 参数化
@Select("SELECT * FROM user WHERE name = #{name}")
User selectByName(@Param("name") String name);
```

```java
// ❌ 日志打印敏感信息
log.info("用户登录，手机号：{}, 密码：{}", phone, password);

// ✅ 脱敏处理
log.info("用户登录，手机号：{}", MaskUtils.phone(phone));
```

### 并发问题

```java
// ❌ 非线程安全的 SimpleDateFormat 作为静态字段
private static SimpleDateFormat sdf = new SimpleDateFormat("yyyy-MM-dd");

// ✅ 使用线程安全的 DateTimeFormatter（Java 8+）
private static final DateTimeFormatter FORMATTER =
    DateTimeFormatter.ofPattern("yyyy-MM-dd");
```

---

## 六、PR 模板

在仓库根目录创建 `.github/pull_request_template.md`：

```markdown
## 变更描述
<!-- 说明本次 PR 的背景和目标 -->

## 变更类型
- [ ] feat（新功能）
- [ ] fix（Bug 修复）
- [ ] refactor（重构）
- [ ] perf（性能优化）
- [ ] docs（文档）
- [ ] chore（工具/依赖）

## 测试情况
- [ ] 单元测试已添加/更新，覆盖核心分支
- [ ] 本地环境已验证
- [ ] 测试环境已验证

## 自检清单
- [ ] 无调试代码残留（System.out.println、TODO 等）
- [ ] 无敏感信息（密码、密钥）提交
- [ ] 变更范围聚焦，无无关修改
- [ ] PR 描述完整

## 关联 Issue
Closes #

## Reviewer 重点关注
<!-- 指出需要 Reviewer 特别注意的地方 -->

## 截图（UI 变更时）
```

---

## 七、Review 效率技巧

- **先看 PR 描述**，了解目标再看代码，不要盲目阅读
- **从测试开始看**，测试代码揭示了作者对功能的理解
- **一次 Review 不超过 400 行**，超过分批或要求作者拆分
- **使用 GitHub Suggested Changes**，直接给出修改建议，作者一键 Accept
- **批量评论后统一提交**，避免多次邮件轰炸通知作者
