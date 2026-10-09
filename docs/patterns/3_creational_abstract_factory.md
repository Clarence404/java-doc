---
description: 产品族与产品等级、多云厂商示例、JDBC Connection 与 XML 工厂、与工厂方法的分工
---

# 抽象工厂模式

> **本篇目标**：理解「产品族」与「产品等级」两个维度，能用抽象工厂保证同族产品一起切换，认出 JDBC `Connection` 这样的真实抽象工厂，并判断什么时候它是过度设计。
>
> **前置阅读**：[工厂模式](./2_creational_factory)

---

## 一、定义与角色

### 1、定义

GoF 的定义：提供一个接口，用于创建**一系列相关或相互依赖的对象**，而无需指定它们的具体类。

![抽象工厂模式：产品族 × 产品等级](../assets/patterns/abstract-factory-class.svg)

| 角色 | 职责 |
|------|------|
| AbstractFactory | 声明一组创建方法，每个方法创建一种产品（`createStorage()`、`createSms()`） |
| ConcreteFactory | 实现全部创建方法，产出**同一族**的产品（阿里云工厂只产阿里云的产品） |
| AbstractProduct | 每种产品的接口（`ObjectStorage`、`SmsSender`） |
| ConcreteProduct | 某一族的具体产品（`AliyunOss`、`AwsS3`） |

### 2、两个维度

- **产品等级**：同一种产品的不同实现，如 OSS 与 S3 都是「对象存储」
- **产品族**：同一厂商 / 同一主题下必须搭配使用的一组产品，如阿里云的 OSS + 短信

抽象工厂保证客户端拿到的产品**来自同一族**，不会出现「阿里云存储 + AWS 短信」这种混搭；每个 `createX()` 本身就是一个工厂方法。

---

## 二、实现（JDK 21）

以「多云厂商接入」为例：业务同时用到对象存储和短信，按部署环境整体切换厂商。

```java
// 抽象产品
@FunctionalInterface
interface ObjectStorage {
    void put(String key, byte[] data);
}

@FunctionalInterface
interface SmsSender {
    void send(String phone, String text);
}

// 抽象工厂
interface CloudFactory {
    ObjectStorage createStorage();
    SmsSender createSms();
}

// 阿里云产品族
record AliyunOss(String bucket) implements ObjectStorage {
    public void put(String key, byte[] data) { System.out.println("OSS " + bucket + "/" + key); }
}

record AliyunSms(String signName) implements SmsSender {
    public void send(String phone, String text) { System.out.println("Aliyun SMS -> " + phone); }
}

final class AliyunFactory implements CloudFactory {
    public ObjectStorage createStorage() { return new AliyunOss("prod-bucket"); }
    public SmsSender createSms()         { return new AliyunSms("MyApp"); }
}

// AWS 产品族
record AwsS3(String bucket) implements ObjectStorage {
    public void put(String key, byte[] data) { System.out.println("S3 " + bucket + "/" + key); }
}

record AwsSns(String region) implements SmsSender {
    public void send(String phone, String text) { System.out.println("AWS SNS -> " + phone); }
}

final class AwsFactory implements CloudFactory {
    public ObjectStorage createStorage() { return new AwsS3("prod-bucket"); }
    public SmsSender createSms()         { return new AwsSns("us-east-1"); }
}

// 客户端只依赖抽象，换厂商只换工厂
final class ReceiptService {
    private final ObjectStorage storage;
    private final SmsSender sms;

    ReceiptService(CloudFactory factory) {
        this.storage = factory.createStorage();
        this.sms = factory.createSms();
    }

    void issue(String orderNo, String phone, byte[] pdf) {
        storage.put("receipt/" + orderNo + ".pdf", pdf);
        sms.send(phone, "电子回单已生成：" + orderNo);
    }
}
```

Spring Boot 中按配置选择整族实现，而不是在 `@Bean` 方法里写三元表达式：

```java
@Configuration
class CloudConfig {

    @Bean
    @ConditionalOnProperty(name = "cloud.vendor", havingValue = "aliyun", matchIfMissing = true)
    CloudFactory aliyunFactory() {
        return new AliyunFactory();
    }

    @Bean
    @ConditionalOnProperty(name = "cloud.vendor", havingValue = "aws")
    CloudFactory awsFactory() {
        return new AwsFactory();
    }
}
```

---

## 三、JDK 与 Spring 中的应用

| 位置 | 说明 |
|------|------|
| JDBC `java.sql.Connection` | 每个驱动的 `Connection` 就是一个具体工厂：`createStatement()`、`prepareStatement()`、`createBlob()`、`createArrayOf()` 产出的都是同一驱动的对象，不会混用 |
| `javax.xml.parsers.DocumentBuilderFactory` | `newInstance()` 按配置选出具体实现的工厂，再由它创建 `DocumentBuilder` |
| `javax.xml.transform.TransformerFactory`、`javax.xml.xpath.XPathFactory` | 同上，整套 XML 处理对象来自同一实现 |

Spring 自身较少直接出现教科书式的抽象工厂，业务里常见的写法是上一节那样：按配置注入一整族实现。

---

## 四、适用场景与常见坑

**适用场景**：

- 确实存在**必须搭配使用**的一组对象：多云厂商 SDK、UI 主题（按钮 + 输入框 + 弹窗）、不同数据库方言的一整套组件
- 需要整体切换实现，比如测试环境用一整套 Mock 实现

**常见坑**：

- **过度设计**：只有一种产品时就是工厂方法，硬套抽象工厂只会多出接口
- **新增产品等级代价大**：加一种产品（如「推送」）要修改抽象工厂接口和所有具体工厂，违反开闭原则；新增产品族（加一个厂商）则只需新增类
- **工厂里塞业务逻辑**：工厂只负责创建，业务流程放在使用方

---

## 五、与相近模式的区别

| 对比项 | 工厂方法 | 抽象工厂 |
|--------|---------|---------|
| 创建对象 | 一种产品 | 一族相关产品 |
| 实现手段 | 继承：子类重写工厂方法 | 组合：客户端持有工厂对象 |
| 扩展新实现 | 新增 Creator 子类 | 新增一整族工厂与产品 |
| 扩展新产品种类 | 不涉及 | 要改所有工厂 |
| 关系 | — | 每个 `createX()` 都是一个工厂方法 |

---

## 小结

- 抽象工厂解决「一组对象必须同族搭配」的问题，客户端只依赖抽象工厂和抽象产品
- 新增产品族容易，新增产品种类困难；只有一种产品时用工厂方法即可
- 真实例子：JDBC `Connection` 产出同一驱动的 Statement / Blob，XML 的 `DocumentBuilderFactory` / `TransformerFactory`
- Spring 中用 `@ConditionalOnProperty` 等条件装配按配置注入整族实现

## 参考资料

- Refactoring.Guru - Abstract Factory：[https://refactoring.guru/design-patterns/abstract-factory](https://refactoring.guru/design-patterns/abstract-factory)
- Java SE 21 API - java.sql.Connection：[https://docs.oracle.com/en/java/javase/21/docs/api/java.sql/java/sql/Connection.html](https://docs.oracle.com/en/java/javase/21/docs/api/java.sql/java/sql/Connection.html)
- Java SE 21 API - DocumentBuilderFactory：[https://docs.oracle.com/en/java/javase/21/docs/api/java.xml/javax/xml/parsers/DocumentBuilderFactory.html](https://docs.oracle.com/en/java/javase/21/docs/api/java.xml/javax/xml/parsers/DocumentBuilderFactory.html)
- 《设计模式：可复用面向对象软件的基础》（GoF）

> 下一篇：[建造者模式](./4_creational_builder) —— 分步构建参数多、可选项多的不可变对象。
