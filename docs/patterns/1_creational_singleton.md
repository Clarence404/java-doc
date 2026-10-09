---
description: 角色与唯一性范围、五种实现对比、序列化与反射防护、Runtime 与 Spring 单例 Bean
---

# 单例模式

> **本篇目标**：掌握单例的五种写法和各自的取舍，知道「唯一」只在一个 ClassLoader 内成立、Spring 单例 Bean 与 GoF 单例不是一回事，能写出抵御序列化与反射破坏的单例。
>
> **前置阅读**：[JMM 内存模型](/java/22_topic_jmm)（双重检查锁一节）、[类加载机制](/jvm/2_class_loading)

---

## 一、定义与角色

### 1、定义

GoF 的定义：保证一个类**只有一个实例**，并提供一个访问它的**全局访问点**。

![单例模式的角色](../assets/patterns/singleton-class.svg)

| 角色 | 职责 |
|------|------|
| Singleton | 构造方法私有，自己持有唯一实例（静态字段），通过静态方法 `getInstance()` 对外提供 |
| Client | 只能通过 `getInstance()` 拿到实例，不能 `new` |

### 2、「唯一」的范围

- **GoF 单例的唯一性以 ClassLoader 为单位**：静态字段属于「某个类加载器加载的那个类」。同一个 `.class` 被两个类加载器加载（Tomcat 多个 webapp、OSGi、热部署），就是两个类、两个实例
- **Spring 单例 Bean 的唯一性以「容器 + bean 名」为单位**：Spring 文档原话的意思是，GoF 单例是每个 ClassLoader 一个，Spring 单例是每个容器、每个 bean 定义一个。同一个类注册成两个 bean 名，或者再起一个 `ApplicationContext`，或者在别处直接 `new`，都会得到更多实例

---

## 二、实现（JDK 21）

### 1、懒汉式（线程不安全）

延迟初始化，但两个线程同时通过 `instance == null` 判断时会各建一个实例，**只适合单线程**。

```java
public class SingletonLazy {
    private static SingletonLazy instance;

    private SingletonLazy() {}

    public static SingletonLazy getInstance() {
        if (instance == null) {
            instance = new SingletonLazy();
        }
        return instance;
    }
}
```

### 2、饿汉式

实例在类初始化时创建，由 JVM 的类初始化锁保证线程安全。

```java
public class SingletonEager {
    private static final SingletonEager INSTANCE = new SingletonEager();

    private SingletonEager() {}

    public static SingletonEager getInstance() {
        return INSTANCE;
    }
}
```

「饿」并不是 JVM 启动就创建：类在**首次主动使用**时才初始化（JLS 12.4.1）。它与 Holder 的区别在于，访问这个类的**任何**静态成员（哪怕是一个无关的静态方法）都会触发实例创建。

### 3、双重检查锁（DCL）

懒加载 + 线程安全，`instance` 必须加 `volatile`。

```java
public class SingletonDCL {
    private static volatile SingletonDCL instance;

    private SingletonDCL() {}

    public static SingletonDCL getInstance() {
        if (instance == null) {                      // 第一次检查：已初始化时不加锁
            synchronized (SingletonDCL.class) {
                if (instance == null) {              // 第二次检查：防止重复创建
                    instance = new SingletonDCL();
                }
            }
        }
        return instance;
    }
}
```

`new` 分三步：分配内存 → 执行构造方法 → 把引用赋给 `instance`。没有 `volatile` 时后两步可能重排，别的线程会在第一次检查处拿到一个构造还没跑完的对象。重排的细节和图示见 [JMM 内存模型](/java/22_topic_jmm#七、双重检查锁-dcl)，这里不再展开。

### 4、静态内部类（Holder，推荐）

```java
public class SingletonHolder {
    private SingletonHolder() {}

    private static class Holder {
        private static final SingletonHolder INSTANCE = new SingletonHolder();
    }

    public static SingletonHolder getInstance() {
        return Holder.INSTANCE;
    }
}
```

- **懒加载**：只有调用 `getInstance()` 访问 `Holder.INSTANCE` 时，`Holder` 才会初始化；访问外部类的其他静态成员不会触发
- **线程安全**：类初始化由 JVM 加锁执行且只执行一次（JLS 12.4.2），不需要 `volatile` 和 `synchronized`

### 5、枚举单例

```java
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

public enum SingletonEnum {
    INSTANCE;

    private final Map<String, String> config = new ConcurrentHashMap<>();

    public String get(String key) {
        return config.get(key);
    }
}

// 使用
String v = SingletonEnum.INSTANCE.get("timeout");
```

《Effective Java》第 3 条推荐的写法，天然防序列化和反射破坏：

- **序列化**：枚举只写出常量名，反序列化时按名字查回原常量，不会新建对象
- **反射**：枚举的构造方法签名是 `(String, int)`，`getDeclaredConstructor()` 无参调用直接抛 `NoSuchMethodException`；拿到 `(String, int)` 构造方法再 `newInstance` 会抛 `IllegalArgumentException: Cannot reflectively create enum objects`

原理见 [枚举](/java/12_topic_enum#六、序列化与反射)。

### 6、普通类的序列化与反射防护

饿汉、Holder、DCL 默认都挡不住这两种破坏，需要手动加两处代码：

```java
import java.io.Serial;
import java.io.Serializable;

public class SafeSingleton implements Serializable {
    @Serial
    private static final long serialVersionUID = 1L;

    private static final SafeSingleton INSTANCE = new SafeSingleton();

    private SafeSingleton() {
        if (INSTANCE != null) {                 // 防反射：实例已存在时拒绝再次构造
            throw new IllegalStateException("Singleton already initialized");
        }
    }

    public static SafeSingleton getInstance() {
        return INSTANCE;
    }

    @Serial
    private Object readResolve() {              // 防反序列化：用唯一实例替换新建的对象
        return INSTANCE;
    }
}
```

构造方法里的检查只能挡住常规的反射调用，`Unsafe.allocateInstance` 之类的手段仍能绕过；需要严格防护时直接用枚举。

### 7、五种实现对比

| 方式 | 线程安全 | 懒加载 | 防序列化 | 防反射 | 推荐场景 |
|------|---------|--------|---------|--------|---------|
| 懒汉式 | 否 | 是 | 否 | 否 | 仅单线程环境 |
| 饿汉式 | 是 | 否（首次访问类即创建） | 需 `readResolve` | 需构造方法检查 | 实例轻量、必然会用到 |
| DCL | 是（必须 `volatile`） | 是 | 需 `readResolve` | 需构造方法检查 | 需要按参数延迟构造等 Holder 做不到的场景 |
| 静态内部类（Holder） | 是 | 是 | 需 `readResolve` | 需构造方法检查 | **首选**：普通懒加载单例 |
| 枚举 | 是 | 否（首次访问枚举类即创建） | 是 | 是 | **首选**：需要防序列化 / 反射破坏 |

---

## 三、JDK 与 Spring 中的应用

| 位置 | 写法 | 说明 |
|------|------|------|
| `java.lang.Runtime` | 饿汉式 | 私有构造，`getRuntime()` 返回静态 `final` 字段，代表当前 JVM 的运行时 |
| `Collections.emptyList()` 等 | 共享常量 | 返回同一个不可变实例 `EMPTY_LIST`；无状态对象共享一份即可 |
| Spring 单例 Bean | 容器管理 | 默认 `singleton` 作用域，实例缓存在 `DefaultSingletonBeanRegistry` 的单例注册表里；唯一性是「每容器、每 bean 名」，类本身仍是普通类 |

在 Spring 应用里，几乎不需要手写单例：把类声明成 Bean、构造器注入即可，既是单实例，又能在测试里替换成 Mock。

---

## 四、适用场景与常见坑

**适用场景**：

- 无状态的工具对象、全局只读配置
- 昂贵且必须共享的资源，如进程级的注册表、ID 生成器
- 非 Spring 环境（SDK、Agent、命令行工具）里需要全局入口时

**常见坑**：

- **可变全局状态**：单例被所有线程共享，内部有可变字段就必须自己保证线程安全
- **难以测试**：调用方直接 `getInstance()` 把依赖写死了，无法替换成 Mock；能用依赖注入就用依赖注入
- **多 ClassLoader 出现多个实例**：Web 容器、插件化场景下「全局唯一」可能并不唯一
- **枚举构造方法做重操作**：构造方法抛异常会变成 `ExceptionInInitializerError`，之后每次访问都是 `NoClassDefFoundError`，无法重试，见 [枚举](/java/12_topic_enum)
- **把 Spring 单例 Bean 当 GoF 单例**：同一个类配了两个 `@Bean` 方法，就是两个实例

---

## 五、与相近模式的区别

| 对比项 | 单例 | 静态工具类 | Spring 单例 Bean | 享元 |
|--------|------|-----------|-----------------|------|
| 实例数 | 每 ClassLoader 一个 | 没有实例 | 每容器每 bean 名一个 | 每种内部状态一个，可以很多 |
| 能否实现接口、被替换 | 能实现接口，难替换 | 不能 | 能，注入时可替换 | 能 |
| 生命周期 | 随类加载 | 随类加载 | 由容器管理 | 由享元工厂管理 |
| 典型例子 | `Runtime` | `Math`、`Collections` | Service、Repository | `Integer.valueOf` 缓存 |

---

## 小结

- 单例 = 私有构造 + 自持唯一实例 + 静态访问点；唯一性只在一个 ClassLoader 内成立
- 普通懒加载用 Holder，要防序列化与反射用枚举；DCL 必须加 `volatile`，一般不作首选
- 非枚举单例要防破坏：`readResolve` 挡反序列化，构造方法检查挡常规反射
- Spring 单例 Bean 是「每容器、每 bean 名一个」，Spring 应用里优先交给容器管理而不是手写

## 参考资料

- Refactoring.Guru - Singleton：[https://refactoring.guru/design-patterns/singleton](https://refactoring.guru/design-patterns/singleton)
- Spring Framework Reference - Bean Scopes：[https://docs.spring.io/spring-framework/reference/core/beans/factory-scopes.html](https://docs.spring.io/spring-framework/reference/core/beans/factory-scopes.html)
- JLS 12.4 Initialization of Classes and Interfaces：[https://docs.oracle.com/javase/specs/jls/se21/html/jls-12.html#jls-12.4](https://docs.oracle.com/javase/specs/jls/se21/html/jls-12.html#jls-12.4)
- Java Object Serialization Specification - readResolve：[https://docs.oracle.com/en/java/javase/21/docs/specs/serialization/input.html](https://docs.oracle.com/en/java/javase/21/docs/specs/serialization/input.html)
- 《设计模式：可复用面向对象软件的基础》（GoF）、《Effective Java》第 3 版第 3 条

> 下一篇：[工厂模式](./2_creational_factory) —— 简单工厂、工厂方法、静态工厂方法与 `FactoryBean`。
