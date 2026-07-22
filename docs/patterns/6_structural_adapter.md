# 适配器模式

**作用**：将一个接口转换为客户端期望的另一个接口，让原本不兼容的类可以协同工作。

**应用场景**：
- `Arrays.asList()`：数组 → `List` 接口
- `InputStreamReader`：`InputStream`（字节流）→ `Reader`（字符流）
- Spring `HandlerAdapter`：将各种 Handler（Controller、HttpRequestHandler）适配为统一调用入口
- 对接第三方 SDK，包一层 Adapter 隔离变化

---

## 一、对象适配器（推荐）

通过**组合**持有被适配对象，更灵活：

```java
// 目标接口（客户端期望的）
public interface MessageSender {
    void send(String to, String content);
}

// 被适配类（三方 SDK，无法修改）
public class AliyunSmsClient {
    public void sendSms(String phone, String templateCode, String params) {
        System.out.println("Aliyun SMS → " + phone + ": " + params);
    }
}

// 适配器：实现目标接口，内部调用被适配类
public class AliyunSmsAdapter implements MessageSender {
    private final AliyunSmsClient client;
    private final String templateCode;

    public AliyunSmsAdapter(AliyunSmsClient client, String templateCode) {
        this.client       = client;
        this.templateCode = templateCode;
    }

    @Override
    public void send(String to, String content) {
        // 转换参数格式
        String params = String.format("{\"content\":\"%s\"}", content);
        client.sendSms(to, templateCode, params);
    }
}

// 客户端：只依赖 MessageSender 接口，无感知底层 SDK
@Service
public class NotificationService {
    private final MessageSender sender;

    public NotificationService(MessageSender sender) { this.sender = sender; }

    public void notify(String phone, String msg) {
        sender.send(phone, msg);
    }
}
```

---

## 二、类适配器（了解）

通过**继承**被适配类，Java 中受单继承限制，较少使用：

```java
public class AliyunSmsClassAdapter extends AliyunSmsClient implements MessageSender {
    @Override
    public void send(String to, String content) {
        sendSms(to, "TPL_001", content);
    }
}
```

---

## 三、两种方式对比

| 维度 | 对象适配器（组合）| 类适配器（继承）|
|------|-----------------|----------------|
| 灵活性 | 高，可适配子类 | 低，绑定具体类 |
| Java 限制 | 无 | 受单继承限制 |
| 推荐 | ✅ 推荐 | 不推荐 |
