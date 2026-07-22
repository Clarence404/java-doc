# 桥接模式

**作用**：将**抽象**与**实现**分离到独立的类层次中，通过组合代替继承，让两者可以独立变化。

**应用场景**：
- JDBC：`Connection` 是抽象，`MySQLConnection`/`PGConnection` 是实现；两者可独立扩展
- Logback：`Logger`（抽象）→ `Appender`（实现），可自由组合不同输出目标
- 消息通知：消息类型（普通/紧急）× 发送渠道（邮件/短信/钉钉）组合爆炸时适用

---

## 一、实现示例

以「消息通知」为例，若用继承：`普通邮件`、`紧急邮件`、`普通短信`、`紧急短信` → n×m 个类。桥接后只需 n+m 个：

```java
// 实现层：发送渠道
public interface MessageChannel {
    void send(String recipient, String content);
}

public class EmailChannel implements MessageChannel {
    public void send(String to, String content) {
        System.out.println("Email → " + to + ": " + content);
    }
}

public class SmsChannel implements MessageChannel {
    public void send(String to, String content) {
        System.out.println("SMS → " + to + ": " + content);
    }
}

// 抽象层：消息类型，持有渠道的引用（桥接）
public abstract class Notification {
    protected final MessageChannel channel;

    protected Notification(MessageChannel channel) { this.channel = channel; }

    public abstract void notify(String recipient, String message);
}

public class NormalNotification extends Notification {
    public NormalNotification(MessageChannel channel) { super(channel); }

    @Override
    public void notify(String recipient, String message) {
        channel.send(recipient, "[普通] " + message);
    }
}

public class UrgentNotification extends Notification {
    public UrgentNotification(MessageChannel channel) { super(channel); }

    @Override
    public void notify(String recipient, String message) {
        channel.send(recipient, "【紧急】" + message);
        channel.send(recipient, "【紧急】请立即处理！");
    }
}

// 自由组合
Notification n1 = new UrgentNotification(new SmsChannel());
n1.notify("13800138000", "服务器宕机");

Notification n2 = new NormalNotification(new EmailChannel());
n2.notify("ops@example.com", "周报已生成");
```

---

## 二、与适配器的区别

| 维度 | 桥接 | 适配器 |
|------|------|--------|
| 目的 | 主动设计，分离抽象与实现 | 被动补救，适配不兼容接口 |
| 时机 | 设计阶段 | 已有代码无法修改时 |
| 结构 | 双层层次，通过组合桥接 | 单层包装，转换接口 |
