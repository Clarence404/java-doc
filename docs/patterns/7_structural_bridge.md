---
description: 抽象与实现两个层次、n×m 到 n+m、消息类型 × 发送渠道示例、与适配器 / 策略的区别
---

# 桥接模式

> **本篇目标**：能识别「两个维度各自独立变化」的场景，用桥接把 n×m 个子类降到 n+m 个，并分清桥接与适配器、策略这两个结构相似的模式。
>
> **前置阅读**：[适配器模式](./6_structural_adapter)

---

## 一、定义与角色

### 1、定义

GoF 的定义：将**抽象部分**与它的**实现部分**分离，使它们都可以独立地变化。

这里的「抽象」和「实现」不是指接口和实现类，而是两个**独立变化的维度**：一个维度用继承扩展，另一个维度抽出来成为被持有的对象，两者之间那条组合关系就是「桥」。

![桥接模式：两个维度各自扩展](../assets/patterns/bridge-class.svg)

| 角色 | 职责 |
|------|------|
| Abstraction（抽象部分） | 面向调用方的高层接口，持有一个 Implementor 引用 |
| RefinedAbstraction（扩充抽象） | Abstraction 的子类，扩展高层行为（普通消息、紧急消息） |
| Implementor（实现部分） | 底层操作的接口（发送渠道） |
| ConcreteImplementor | Implementor 的具体实现（邮件、短信） |

### 2、为什么是 n×m → n+m

消息有「普通 / 紧急」两种类型，渠道有「邮件 / 短信」两种。全用继承就是 `NormalEmail`、`NormalSms`、`UrgentEmail`、`UrgentSms` 共 2×2 个类，再加一个钉钉渠道就要再加 2 个。桥接后消息类型 2 个类、渠道 2 个类，加钉钉只多 1 个类。

---

## 二、实现（JDK 21）

```java
// Implementor：发送渠道
@FunctionalInterface
public interface MessageChannel {
    void deliver(String to, String content);
}

public final class EmailChannel implements MessageChannel {
    @Override
    public void deliver(String to, String content) {
        System.out.println("Email -> " + to + ": " + content);
    }
}

public final class SmsChannel implements MessageChannel {
    @Override
    public void deliver(String to, String content) {
        System.out.println("SMS -> " + to + ": " + content);
    }
}

// Abstraction：消息类型，持有渠道引用（桥）
public abstract class Notification {
    protected final MessageChannel channel;

    protected Notification(MessageChannel channel) {
        this.channel = channel;
    }

    public abstract void send(String to, String message);
}

// RefinedAbstraction
public class NormalNotification extends Notification {
    public NormalNotification(MessageChannel channel) {
        super(channel);
    }

    @Override
    public void send(String to, String message) {
        channel.deliver(to, "[普通] " + message);
    }
}

public class UrgentNotification extends Notification {
    public UrgentNotification(MessageChannel channel) {
        super(channel);
    }

    @Override
    public void send(String to, String message) {
        channel.deliver(to, "[紧急] " + message);
        channel.deliver(to, "[紧急] 请在 15 分钟内处理");   // 紧急消息的扩展行为：追加提醒
    }
}

// 两个维度自由组合
Notification alarm = new UrgentNotification(new SmsChannel());
alarm.send("13800138000", "订单服务不可用");

Notification weekly = new NormalNotification(new EmailChannel());
weekly.send("ops@example.com", "周报已生成");

// MessageChannel 是函数式接口，临时渠道可以直接用 lambda
Notification debug = new NormalNotification((to, c) -> System.out.println("Console -> " + c));
```

在 Spring 中，渠道实现都注册为 Bean，按名字注入 `Map<String, MessageChannel>`，运行时根据用户配置选渠道后交给 `Notification`。

---

## 三、JDK 与 Spring 中的应用

JDK 与 Spring 中没有像 `InputStreamReader` 之于适配器那样公认的桥接实现。Refactoring.Guru 的 Java 示例页没有列出 JDK 用例；常被引用的「JDBC 是桥接」说法缺少权威出处，本篇不采用，`Connection` 接口与各驱动实现类之间只是普通的接口与实现关系。

Refactoring.Guru 给出的典型用途是跨平台、多种数据库、多家同类 API 提供商（云平台、社交网络），与业务代码中常见的桥接一致：

| 场景 | 抽象部分（继承扩展） | 实现部分（被持有） |
|------|-------------------|------------------|
| 通知系统 | 消息类型：普通 / 紧急 / 营销 | 发送渠道：邮件 / 短信 / IM |
| 报表导出 | 报表类型：销售 / 库存 / 财务 | 输出格式：Excel / CSV / PDF |
| 支付 | 支付场景：扫码 / App / 小程序 | 支付通道：微信 / 支付宝 / 银联 |
| 多云接入 | 业务操作：归档 / 备份 / 分享 | 云厂商：阿里云 / AWS / 自建 |

---

## 四、适用场景与常见坑

**适用场景**：

- 一个类存在**两个（或更多）独立变化的维度**，用继承会出现子类组合爆炸
- 希望在运行时切换实现部分（同一条消息改走另一个渠道）
- 抽象部分和实现部分需要由不同团队、按各自节奏扩展

**常见坑**：

- **只有一个维度在变也用桥接**：只是「接口 + 多个实现」时，直接依赖接口即可，多一层抽象类是过度设计
- **维度划分错误**：把本该属于同一维度的变化拆到两边，两边的子类会互相知道对方的细节
- **Implementor 接口设计得太窄**：抽象部分需要的能力表达不出来，只能向下转型，桥就断了

---

## 五、与相近模式的区别

| 对比项 | 桥接 | 适配器 | 策略 |
|--------|------|--------|------|
| 目的 | 主动设计，让两个维度独立变化 | 事后补救，让不兼容的接口能一起用 | 让一个算法可替换 |
| 时机 | 设计阶段 | 已有代码不能改时 | 设计阶段 |
| 结构 | 抽象部分本身也有继承层次，持有实现部分 | 单层包装，转换接口 | Context 通常没有继承层次，只持有一个策略 |
| 变化维度 | 两个 | 不涉及 | 一个（算法） |

桥接与 [策略模式](./20_behavioral_strategy) 的代码结构几乎一样（都是持有一个接口引用），区别在意图：策略只有「算法」一个维度在变，桥接的持有方自己也在扩展。

---

## 小结

- 桥接把两个独立变化的维度拆成两个类层次，用组合连接，子类数从 n×m 降到 n+m
- 「抽象」与「实现」指两个维度，不是接口与实现类；单一维度变化时不需要桥接
- JDK / Spring 中没有公认的标准桥接实现，桥接主要出现在业务代码的多维度组合里
- 与适配器比：桥接是事前设计，适配器是事后补救；与策略比：桥接的持有方自己也有继承层次

## 参考资料

- Refactoring.Guru - Bridge：[https://refactoring.guru/design-patterns/bridge](https://refactoring.guru/design-patterns/bridge)
- 《设计模式：可复用面向对象软件的基础》（GoF）

> 下一篇：[组合模式](./8_structural_composite) —— 用统一接口处理树形结构中的叶子与容器。
