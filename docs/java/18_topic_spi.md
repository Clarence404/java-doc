# Java 专项-SPI 机制

## 一、什么是 SPI

SPI（Service Provider Interface）是 Java 提供的一套服务发现机制，允许第三方为某个接口提供实现，框架在运行时自动加载。

**核心思想**：接口定义与实现分离，调用方只依赖接口，实现通过配置文件注册。

---

## 二、Java 原生 SPI

### 使用步骤

1. 定义服务接口
2. 在 `META-INF/services/` 目录下创建以接口全限定名命名的文件
3. 文件内容为实现类的全限定名（每行一个）
4. 使用 `ServiceLoader` 加载

```java
// 1. 接口
public interface MessageSender {
    void send(String message);
}

// 2. 实现（在另一个 jar 中）
public class KafkaSender implements MessageSender {
    public void send(String message) { /* ... */ }
}
```

`META-INF/services/com.example.MessageSender` 文件内容：
```
com.example.kafka.KafkaSender
```

```java
// 3. 加载并使用
ServiceLoader<MessageSender> loader = ServiceLoader.load(MessageSender.class);
for (MessageSender sender : loader) {
    sender.send("hello");
}
```

### 原生 SPI 的局限

- **全量加载**：所有实现都会被实例化，不支持按需加载
- **不支持排序**：无法指定实现的优先级
- **不支持依赖注入**：无法自动注入 Spring Bean
- **线程不安全**：多线程使用需自行处理

---

## 三、框架中的 SPI 实践

### Dubbo SPI（扩展点机制）

Dubbo 重新实现了 SPI，解决了原生 SPI 的全量加载问题：

- 配置文件放在 `META-INF/dubbo/` 目录，使用 `key=实现类` 格式
- 支持**按名称获取指定实现**（`ExtensionLoader.getExtension("kafka")`）
- 支持 **Adaptive**（自适应扩展）、**Activate**（条件激活）
- 支持 **Wrapper**（AOP 装饰器模式）

```
# META-INF/dubbo/org.apache.dubbo.rpc.Protocol
dubbo=org.apache.dubbo.rpc.protocol.dubbo.DubboProtocol
http=org.apache.dubbo.rpc.protocol.http.HttpProtocol
```

### Spring SPI（spring.factories）

Spring Boot 2.x 及以前通过 `META-INF/spring.factories` 实现自动配置加载：

```properties
# META-INF/spring.factories
org.springframework.boot.autoconfigure.EnableAutoConfiguration=\
  com.example.MyAutoConfiguration,\
  com.example.AnotherAutoConfiguration
```

Spring Boot 3.x 改为 `META-INF/spring/org.springframework.boot.autoconfigure.AutoConfiguration.imports`，每行一个类名。

### JDBC DriverManager

JDBC 驱动注册就是标准 SPI：MySQL Driver jar 的 `META-INF/services/java.sql.Driver` 中声明 `com.mysql.cj.jdbc.Driver`，`DriverManager` 通过 ServiceLoader 自动加载。

---

## 四、SPI 与 API 的区别

| | API | SPI |
|--|-----|-----|
| 调用方向 | 调用方调用框架提供的接口 | 框架调用第三方实现的接口 |
| 设计者 | 接口与实现都在框架内 | 接口在框架，实现在外部 |
| 典型例子 | `List.add()`、`String.length()` | JDBC Driver、Spring AutoConfiguration |

---

## 五、常见面试问题

**Q：Java SPI 和 Spring @Autowired 有什么区别？**
SPI 是类级别的插件发现机制，运行时通过 ClassLoader 扫描 jar 包中的配置文件加载实现；Spring 的依赖注入是容器级别的，Bean 由 Spring IoC 容器管理，支持生命周期、AOP 等。两者可结合使用（如 Spring Boot AutoConfiguration 用 SPI 发现配置类，再交由 Spring 容器管理）。

**Q：为什么 JDBC 不需要 `Class.forName()` 了？**
JDBC 4.0（Java 6+）起，`DriverManager` 使用 ServiceLoader 自动加载 classpath 中所有 `java.sql.Driver` 的 SPI 实现，不再需要手动触发类加载。

**Q：Dubbo SPI 相比 Java SPI 有哪些增强？**
按需加载（键值映射）、自适应扩展（运行时选择实现）、条件激活、Wrapper 包装增强、支持 IoC 和 AOP。
