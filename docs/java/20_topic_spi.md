---
description: ServiceLoader、TCCL、JPMS provides / uses、Dubbo 扩展点、自动配置登记
---

# SPI 机制

> 前置阅读：[序列化](./19_topic_serialization)、[类加载机制](/jvm/2_class_loading)

SPI（Service Provider Interface）是框架只定义接口、第三方 jar 提供实现并在约定位置登记、运行时再把实现找出来的服务发现机制，JDBC、SLF4J、Dubbo、Spring Boot 自动配置都是这个思路。本篇讲 `ServiceLoader` 的加载过程，以及 JPMS、Dubbo、Spring Boot 的 SPI 变体与自定义扩展点。

---

## 一、SPI 与 API 的区别

| 维度 | API | SPI |
|------|-----|-----|
| 谁定义接口 | 实现方（框架） | 调用方（框架） |
| 谁实现接口 | 框架自己 | 第三方 |
| 调用方向 | 应用调用框架 | 框架调用第三方实现 |
| 典型例子 | `List.add()`、`String.length()` | `java.sql.Driver`、`SLF4JServiceProvider`、Dubbo `Protocol` |

一句话：API 是「我提供能力给你用」，SPI 是「我定规则，你来实现，我负责发现和调用」。

---

## 二、Java 原生 SPI：ServiceLoader

### 1、使用步骤

1. 定义服务接口
2. 实现方在自己的 jar 中提供实现类（需 public 无参构造器）
3. 在 `META-INF/services/` 下创建以**接口全限定名**命名的文件，每行写一个实现类全限定名
4. 调用方用 `ServiceLoader` 加载

```java
// 框架定义的接口
public interface MessageSender {
    String type();
    void send(String message);
}

// 另一个 jar 中的实现
public class KafkaSender implements MessageSender {
    public String type() { return "kafka"; }
    public void send(String message) { /* ... */ }
}
```

`META-INF/services/com.example.MessageSender` 文件内容：

```text
com.example.kafka.KafkaSender
```

```java
ServiceLoader<MessageSender> loader = ServiceLoader.load(MessageSender.class);
for (MessageSender sender : loader) {          // 迭代到哪个实现，才实例化哪个
    sender.send("hello");
}
```

### 2、加载过程

![ServiceLoader 加载流程：TCCL 定位配置文件、懒解析、迭代或 get() 时才实例化](../assets/java/spi_service_loader.svg)

- **懒加载**：`load()` 本身不读文件也不创建对象；迭代器每前进一步才解析下一个类名并实例化。已实例化的提供者会被缓存，`reload()` 清空缓存
- **按类型筛选（JDK 9+）**：`stream()` 返回 `Stream<ServiceLoader.Provider<S>>`，`Provider.type()` 只加载类、不实例化，`get()` 才创建对象；`findFirst()` 取第一个可用实现

```java
// 只实例化需要的实现：按注解或类名筛选，再 get()
MessageSender sender = ServiceLoader.load(MessageSender.class).stream()
        .filter(p -> p.type().getSimpleName().startsWith("Kafka"))
        .map(ServiceLoader.Provider::get)
        .findFirst()
        .orElseThrow();
```

- **出错处理**：配置文件中的类找不到、不是接口的实现、构造器抛异常，都会在迭代时抛 `ServiceConfigurationError`（是 `Error`，普通的 `catch (Exception)` 接不住）
- **线程安全**：`ServiceLoader` 实例不是线程安全的，多线程共享时自行同步，或在启动时加载完放进不可变集合

### 3、线程上下文类加载器（TCCL）

`ServiceLoader.load(Class)` 使用 `Thread.currentThread().getContextClassLoader()` 加载实现类。原因是接口常在核心库中（如 `java.sql.Driver` 由平台类加载器加载），而实现在应用 classpath 上，按双亲委派父加载器看不到子加载器的类，只能借助 TCCL 「向下」加载，这就是常说的「SPI 打破双亲委派」。细节见 [类加载机制 · SPI 与线程上下文类加载器](/jvm/2_class_loading#_1、spi-与线程上下文类加载器)。

在 Tomcat 这类多 ClassLoader 环境里，可以用 `ServiceLoader.load(Class, ClassLoader)` 显式指定加载器，避免在错误的线程上下文中加载不到实现。

### 4、原生 SPI 的局限

- **不能按名称取**：只能遍历或按类型筛选，没有 `key → 实现` 的映射
- **没有排序与优先级**：顺序取决于 classpath 上 jar 的顺序，不可靠
- **没有依赖注入**：实现类用无参构造器（或 JPMS 的 `provider()` 方法）创建，无法注入其他组件
- **没有条件激活与包装**：不能按环境选择实现，也不能统一加横切逻辑

Dubbo 和 Spring 各自重新实现了 SPI，就是为了补上这些能力。

### 5、JPMS 中的 SPI（JDK 9+）

在模块化应用中，服务关系写在 `module-info.java` 里，由模块系统在启动时校验：

```java
// 框架模块：声明会使用这个服务
module com.example.framework {
    exports com.example.spi;
    uses com.example.spi.MessageSender;
}

// 实现模块：声明提供实现
module com.example.kafka {
    requires com.example.framework;
    provides com.example.spi.MessageSender with com.example.kafka.KafkaSender;
}
```

模块中的提供者可以不要 public 无参构造器，改为声明 `public static MessageSender provider()` 工厂方法，`ServiceLoader` 会优先调用它，实现单例或复杂构造。大多数 Spring 应用仍运行在 classpath 上，这时只有 `META-INF/services` 生效。

---

## 三、JDK 与常用库中的 SPI

| 场景 | 接口 | 说明 |
|------|------|------|
| JDBC 驱动 | `java.sql.Driver` | JDBC 4.0（JDK 6）起 `DriverManager` 首次使用时用 ServiceLoader 加载驱动，不再需要 `Class.forName` |
| 日志门面 | `org.slf4j.spi.SLF4JServiceProvider` | SLF4J 2.x 通过 ServiceLoader 找绑定；1.x 靠固定类名 `StaticLoggerBinder`。classpath 上有多个提供者时会打印警告并选第一个 |
| 字符集 | `java.nio.charset.spi.CharsetProvider` | 扩展自定义字符集 |
| Jakarta / JAXB / JSON-B | 各规范的 `*Provider` | 规范 API 与具体实现解耦 |

**JDBC 驱动泄漏**：`DriverManager` 由平台类加载器加载，却持有 Web 应用类加载器加载的驱动实例。Tomcat 停止或重新部署应用时，如果驱动没有注销，整个 Web 应用类加载器都无法回收，日志里会出现「registered the JDBC driver but failed to unregister it」的警告。解决办法是把驱动 jar 放到 Tomcat 的 `lib` 下，或在应用关闭时调用 `DriverManager.deregisterDriver`。

---

## 四、Dubbo SPI

Dubbo 的扩展点机制是对原生 SPI 的增强，协议、负载均衡、过滤器、序列化都通过它装配：

- 接口必须标注 `@SPI`（可指定默认实现名）
- 配置文件格式为 `name=实现类`，扫描 `META-INF/dubbo/internal/`、`META-INF/dubbo/`、`META-INF/services/` 三个目录
- **按名称获取**，只实例化用到的实现
- 支持 `@Adaptive`（运行时按 URL 参数选择实现）、`@Activate`（按条件自动激活，如过滤器链）、Wrapper 类（自动包装，相当于 AOP）、setter 注入其他扩展

```properties
# META-INF/dubbo/org.apache.dubbo.rpc.Protocol
dubbo=org.apache.dubbo.rpc.protocol.dubbo.DubboProtocol
tri=org.apache.dubbo.rpc.protocol.tri.TripleProtocol
```

```java
// Dubbo 3：通过 ScopeModel 获取 ExtensionLoader（静态的 ExtensionLoader.getExtensionLoader 已过时）
Protocol protocol = ApplicationModel.defaultModel()
        .getExtensionLoader(Protocol.class)
        .getExtension("tri");
```

自定义负载均衡等扩展的写法见 [Dubbo · SPI 扩展机制](/microservices/4_dubbo#六、spi-扩展机制)。

---

## 五、Spring 的 SPI 变体

### 1、SpringFactoriesLoader 与 spring.factories

`SpringFactoriesLoader` 属于 Spring Framework（spring-core），读取所有 jar 中的 `META-INF/spring.factories`，格式是 `接口全名=实现类列表`。它仍用于 `ApplicationContextInitializer`、`ApplicationListener`、`EnvironmentPostProcessor`、`FailureAnalyzer` 等扩展点。

```properties
# META-INF/spring.factories
org.springframework.boot.env.EnvironmentPostProcessor=\
  com.example.MyEnvironmentPostProcessor
```

### 2、自动配置的登记方式

| 版本 | 自动配置登记位置 |
|------|------------------|
| Boot 2.6 及以前 | `spring.factories` 中的 `org.springframework.boot.autoconfigure.EnableAutoConfiguration` 键 |
| Boot 2.7 | 引入 `META-INF/spring/org.springframework.boot.autoconfigure.AutoConfiguration.imports` 与 `@AutoConfiguration`，旧方式仍兼容 |
| Boot 3.0 起 | **只认** `AutoConfiguration.imports`，`spring.factories` 中的 `EnableAutoConfiguration` 键不再生效 |

```text
# META-INF/spring/org.springframework.boot.autoconfigure.AutoConfiguration.imports
com.example.autoconfigure.MyAutoConfiguration
```

`ImportCandidates.load()` 读取这个文件，交给 `AutoConfigurationImportSelector` 过滤（`@Conditional*`）和排序（`@AutoConfiguration(before = ..., after = ...)`）。与原生 SPI 相比，Spring 补上了条件激活、排序和依赖注入：被发现的不是实例，而是配置类，最终由 IoC 容器创建 Bean。自动配置原理见 [Spring Boot](/spring-boot/1_spring_boot)。

---

## 小结

- SPI 的核心是「框架定接口、外部提供实现、运行时发现」，与 API 的调用方向相反
- `ServiceLoader` 懒加载：迭代到才实例化；JDK 9 起 `stream()` 可先看 `type()` 再决定是否 `get()`
- 默认用 TCCL 加载实现，这是 SPI 绕开双亲委派的方式；多 ClassLoader 环境可显式传加载器
- 原生 SPI 缺按名获取、排序、注入和条件激活；JPMS 用 `provides` / `uses` 在模块层声明服务
- Dubbo 3 用 `@SPI` + `name=impl` 配置，经 `ApplicationModel` 获取扩展，支持 Adaptive、Activate、Wrapper
- Spring Boot 2.7 引入 `AutoConfiguration.imports`，3.0 起自动配置只能在这里登记；`spring.factories` 仍承载其他扩展点

## 参考资料

- ServiceLoader API（JDK 25）：[https://docs.oracle.com/en/java/javase/25/docs/api/java.base/java/util/ServiceLoader.html](https://docs.oracle.com/en/java/javase/25/docs/api/java.base/java/util/ServiceLoader.html)
- Dubbo SPI 扩展：[https://cn.dubbo.apache.org/zh-cn/overview/mannual/java-sdk/reference-manual/spi/](https://cn.dubbo.apache.org/zh-cn/overview/mannual/java-sdk/reference-manual/spi/)
- Spring Boot 自动配置：[https://docs.spring.io/spring-boot/reference/features/developing-auto-configuration.html](https://docs.spring.io/spring-boot/reference/features/developing-auto-configuration.html)

> 下一篇：[集合框架](./21_topic_collection) —— List / Set / Queue / Map 的实现原理，重点是 HashMap 与 ConcurrentHashMap。
