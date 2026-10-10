---
description: 对象适配器与类适配器、SDK 接入、HandlerAdapter、与装饰器 / 代理 / 外观的区别
---

# 适配器模式

> 前置阅读：[设计模式总览](./0_overview)

适配器把已有接口转换成客户端期望的接口。本篇讲用对象适配器接入三方 SDK、JDK 与 Spring MVC 中的适配器，以及它与装饰器、代理、外观的区别。

---

## 一、定义与角色

### 1、定义

GoF 的定义：将一个类的接口**转换成客户端期望的另一个接口**，使原本因接口不兼容而不能一起工作的类可以一起工作。

![适配器模式：对象适配器与类适配器](../assets/patterns/adapter-class.svg)

| 角色 | 职责 |
|------|------|
| Target（目标接口） | 客户端期望的接口 |
| Adaptee（被适配者） | 已存在、接口不兼容、通常不能修改的类（三方 SDK、遗留代码） |
| Adapter（适配器） | 实现 Target，把调用转换后交给 Adaptee |
| Client | 只依赖 Target |

### 2、两种形式

- **对象适配器**：Adapter **持有** Adaptee 实例，通过组合委托调用。可以适配 Adaptee 的任意子类，Java 中首选
- **类适配器**：Adapter **继承** Adaptee 并实现 Target。受 Java 单继承限制，且把 Adaptee 的公开方法全暴露出来，较少使用

---

## 二、实现（JDK 21）

### 1、对象适配器

场景：业务只认自己的 `MessageSender` 接口，底层要接一个参数形式完全不同的短信 SDK。

```java
import java.util.Map;

// Target：客户端期望的接口
public interface MessageSender {
    void send(String to, String content);
}

// Adaptee：三方 SDK，无法修改
public class AliyunSmsClient {
    public void sendSms(String phone, String templateCode, Map<String, String> params) {
        System.out.println("Aliyun SMS -> " + phone + " " + templateCode + " " + params);
    }
}

// Adapter：实现 Target，内部委托给 Adaptee
public class AliyunSmsAdapter implements MessageSender {
    private final AliyunSmsClient client;
    private final String templateCode;

    public AliyunSmsAdapter(AliyunSmsClient client, String templateCode) {
        this.client = client;
        this.templateCode = templateCode;
    }

    @Override
    public void send(String to, String content) {
        client.sendSms(to, templateCode, Map.of("content", content));   // 参数格式转换
    }
}

// Client：只依赖 MessageSender，感知不到底层 SDK
@Service
public class NoticeService {
    private final MessageSender sender;

    public NoticeService(MessageSender sender) {
        this.sender = sender;
    }

    public void sendNotice(String phone, String msg) {
        sender.send(phone, msg);
    }
}
```

参数统一用 `Map` 传给 SDK，由 SDK 负责序列化；不要用 `String.format` 拼 JSON，内容里出现引号、反斜杠或换行时会生成非法 JSON。

### 2、类适配器

```java
public class AliyunSmsClassAdapter extends AliyunSmsClient implements MessageSender {
    private static final String TEMPLATE_CODE = "TPL_001";

    @Override
    public void send(String to, String content) {
        sendSms(to, TEMPLATE_CODE, Map.of("content", content));
    }
}
```

调用方拿到的对象同时也是 `AliyunSmsClient`，可以绕过 `MessageSender` 直接调用 `sendSms`，隔离效果不如对象适配器。

### 3、两种方式对比

| 维度 | 对象适配器（组合） | 类适配器（继承） |
|------|-----------------|----------------|
| 能否适配 Adaptee 的子类 | 能 | 不能，绑定具体类 |
| Java 限制 | 无 | 受单继承限制，Adaptee 为 `final` 时不可用 |
| 能否重写 Adaptee 的行为 | 不能直接重写 | 能 |
| 推荐 | 推荐 | 不推荐 |

---

## 三、JDK 与 Spring 中的应用

| 位置 | Adaptee → Target |
|------|------------------|
| `Arrays.asList(T...)` | 数组 → `List`，返回的列表直接以原数组为底层存储 |
| `InputStreamReader` / `OutputStreamWriter` | 字节流 → 字符流（`Reader` / `Writer`），中间做字符集编解码 |
| `Collections.list(Enumeration)`、`Collections.enumeration(Collection)` | 老的 `Enumeration` 与集合框架互转 |
| Spring MVC `HandlerAdapter` | 各种 Handler → `DispatcherServlet` 的统一调用：`supports(handler)` 判断能否处理，`handle(...)` 执行；实现有 `RequestMappingHandlerAdapter`（`@RequestMapping` 方法）、`HttpRequestHandlerAdapter`、`SimpleControllerHandlerAdapter`、`HandlerFunctionAdapter` |
| Spring AOP `AdvisorAdapter` | `MethodBeforeAdvice` 等通知 → `MethodInterceptor`，如 `MethodBeforeAdviceAdapter` |
| SLF4J 桥接模块 `jcl-over-slf4j` | Commons Logging API → SLF4J |

---

## 四、适用场景与常见坑

**适用场景**：

- 接入三方 SDK、遗留系统，对方接口不能改，又不想让业务代码依赖它
- 统一多个供应商的接口（多家短信、多家支付），每家写一个适配器
- 在 DDD 中，适配器是 [防腐层](/architecture/3_ddd) 的常见实现手段：把外部模型转换成本上下文的模型

**常见坑**：

- **适配器套适配器**：A 适配成 B 再适配成 C，调用链难以排查；直接适配到最终目标接口
- **在适配器里写业务逻辑**：适配器只做接口与参数的转换，业务规则放在服务层
- **转换有损却不说明**：目标接口表达不了的能力（如 SDK 的批量发送）要么扩展 Target，要么在文档中说明
- **`Arrays.asList` 当普通 List 用**：它是定长的，`add` / `remove` 抛 `UnsupportedOperationException`，`set` 会写回原数组

---

## 五、与相近模式的区别

四个模式都是「包一层」，区别在于包这一层的目的：

| 模式 | 接口是否改变 | 主要目的 | 典型例子 |
|------|------------|---------|---------|
| 适配器 | 改变：Adaptee 的接口 → Target | 让不兼容的接口能一起工作 | `InputStreamReader` |
| [装饰器](./9_structural_decorator) | 不变，与被装饰对象同一接口 | 动态叠加功能 | `BufferedInputStream` |
| [代理](./12_structural_proxy) | 不变，与真实对象同一接口 | 控制访问：延迟加载、权限、事务 | Spring AOP 代理 |
| [外观](./10_structural_facade) | 提供一个新的、更简单的接口 | 简化一组子系统的使用 | SLF4J |

---

## 小结

- 适配器把 Adaptee 的接口转换成客户端期望的 Target，客户端只依赖 Target
- Java 中优先用对象适配器（组合）；类适配器受单继承限制，且会暴露 Adaptee 的方法
- 真实例子：`Arrays.asList`、`InputStreamReader`、Spring MVC 的 `HandlerAdapter`
- 与装饰器、代理的根本区别是「接口变了」；与外观的区别是适配器面对一个类，外观面对一组子系统

## 参考资料

- Refactoring.Guru - Adapter：[https://refactoring.guru/design-patterns/adapter](https://refactoring.guru/design-patterns/adapter)
- Spring Framework API - HandlerAdapter：[https://docs.spring.io/spring-framework/docs/current/javadoc-api/org/springframework/web/servlet/HandlerAdapter.html](https://docs.spring.io/spring-framework/docs/current/javadoc-api/org/springframework/web/servlet/HandlerAdapter.html)
- Java SE 21 API - InputStreamReader：[https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/io/InputStreamReader.html](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/io/InputStreamReader.html)
- SLF4J - Bridging legacy APIs：[https://www.slf4j.org/legacy.html](https://www.slf4j.org/legacy.html)
- 《设计模式：可复用面向对象软件的基础》（GoF）

> 下一篇：[桥接模式](./7_structural_bridge) —— 把两个独立变化的维度拆成两个类层次，用组合连接。
