---
description: 控制对目标的访问、静态代理、远程 / 虚拟 / 保护 / 缓存代理、Spring 代理的坑、代理 vs 装饰器
---

# 代理模式

> **本篇目标**：从设计模式的角度理解代理：它的角色、常见种类和在 Spring 中的体现，能写出静态代理和正确的动态代理处理器，知道 Spring 代理失效的几种情况。
>
> **前置阅读**：[装饰器模式](./9_structural_decorator)、[动态代理](/java/16_topic_proxy)

代理模式（Proxy）为目标对象提供一个**替身**，客户端调用替身，替身决定何时、是否、以什么方式把调用转给真正的对象。代理与目标实现同一接口，客户端感知不到区别，因此可以在不改目标类的情况下加入访问控制、延迟加载、远程调用、缓存等逻辑。

本篇只讲模式本身；JDK 动态代理和 CGLIB 在运行时生成了什么类、两者的限制和选择，统一见 [动态代理](/java/16_topic_proxy)。

---

## 一、定义与角色

![代理模式的角色（缓存代理）](../assets/patterns/proxy.svg)

| 角色 | 本篇示例 | 职责 |
|------|----------|------|
| Subject（抽象主题） | `UserService` | 代理和真实对象共同的接口 |
| RealSubject（真实主题） | `UserServiceImpl` | 真正干活的对象 |
| Proxy（代理） | `CachingUserServiceProxy` | 持有真实对象的引用，控制对它的访问 |
| Client（客户端） | 调用方 | 面向 `Subject` 编程，不知道拿到的是代理 |

---

## 二、实现

### 1、静态代理

代理类手写，编译期就存在：

```java
public record User(long id, String name) {}

public interface UserService {
    User findById(long id);
}

public class UserServiceImpl implements UserService {
    @Override
    public User findById(long id) {
        // … 查库
        return new User(id, "user-" + id);
    }
}

// 缓存代理：命中缓存就不访问真实对象
public class CachingUserServiceProxy implements UserService {
    private final UserService target;
    private final Map<Long, User> cache = new ConcurrentHashMap<>();

    public CachingUserServiceProxy(UserService target) {
        this.target = target;
    }

    @Override
    public User findById(long id) {
        // 注意：findById 返回 null 时不会放入缓存；这个 Map 也没有容量上限，仅作演示
        return cache.computeIfAbsent(id, target::findById);
    }
}
```

静态代理不一定要实现接口，也可以继承目标类并覆盖方法。它的问题是每个接口都要手写一个代理类，接口一多就难以维护，于是有了动态代理。

### 2、动态代理

动态代理在运行时生成代理类，一个处理器可以代理任意接口。写处理器时要注意：`Method.invoke` 会把目标方法抛出的异常包成 `InvocationTargetException`，必须拆开再抛，否则调用方收到的是 `UndeclaredThrowableException`，业务异常被吞掉：

```java
public final class LoggingProxy {
    private static final Logger log = LoggerFactory.getLogger(LoggingProxy.class);

    private LoggingProxy() {}

    public static <T> T wrap(T target, Class<T> iface) {
        InvocationHandler handler = (proxy, method, args) -> {
            long start = System.nanoTime();
            try {
                return method.invoke(target, args);
            } catch (InvocationTargetException e) {
                throw e.getCause();   // 还原目标方法抛出的原始异常
            } finally {
                log.info("{} 耗时 {}μs", method.getName(), (System.nanoTime() - start) / 1_000);
            }
        };
        return iface.cast(Proxy.newProxyInstance(
                iface.getClassLoader(), new Class<?>[]{iface}, handler));
    }
}

UserService service = LoggingProxy.wrap(new UserServiceImpl(), UserService.class);
```

没有接口的类要用 CGLIB 一类的字节码库生成子类代理；Spring 使用的是它重新打包的 `org.springframework.cglib`，不要再引入早已停止维护的独立 `cglib` 包。JDK 代理与 CGLIB 的机制、`proxyTargetClass` 与 Spring Boot 的默认选择见 [动态代理](/java/16_topic_proxy#四、spring-中的代理选择)。

---

## 三、JDK 与 Spring 中的应用

按「代理在控制什么」，常见的代理分成以下几类：

| 种类 | 控制什么 | 例子 |
|------|----------|------|
| 远程代理 | 把本地调用转成网络请求 | OpenFeign 客户端、Dubbo / gRPC 生成的 stub、Java RMI |
| 虚拟代理（延迟加载） | 真正用到时才创建或加载目标 | Hibernate / JPA 的懒加载实体、Spring `@Lazy` 注入点 |
| 保护代理 | 调用前做权限检查 | Spring Security `@PreAuthorize` 方法级权限 |
| 缓存代理 | 命中缓存就不调用目标 | Spring `@Cacheable`（代理加 `CacheInterceptor`） |
| 增强代理 | 在调用前后加通用逻辑 | `@Transactional` 开启和提交事务、`@Async` 把调用提交到线程池 |
| 接口实现代理 | 目标根本不存在，由代理直接实现接口 | MyBatis Mapper 接口、Spring Data Repository 接口 |

Spring 中这些注解背后都是同一套机制：容器在 Bean 初始化后用 AOP 生成代理，把多个切面的通知组织成拦截器链，详见 [AOP](/spring/2_aop)。

---

## 四、适用场景与常见坑

适合用代理的场景：

- 需要控制对象的访问：权限、限流、延迟创建
- 需要在不改目标类的情况下统一加横切逻辑：事务、缓存、日志、监控
- 目标在远端，希望调用方像调本地方法一样使用

Spring 代理的常见坑：

- **自调用不走代理**：同一个类里 `this.methodB()` 调用带 `@Transactional` 的 `methodB`，调用的是目标对象本身，事务不生效，见 [AOP](/spring/2_aop#六、自调用失效问题)
- **`final` / `private` 方法无法被拦截**：CGLIB 通过生成子类覆盖方法实现代理，覆盖不了的方法上加注解不起作用
- **按实现类注入失败**：使用 JDK 代理时，代理只实现了接口，按实现类类型注入会报类型不匹配
- **`getClass()` 拿到的是代理类**：需要目标类型时用 `AopUtils.getTargetClass` 或 `AopProxyUtils.ultimateTargetClass`
- **异常被包装**：手写 `InvocationHandler` 不拆 `InvocationTargetException`，调用方收到 `UndeclaredThrowableException`

---

## 五、与相近模式的区别

| 模式 | 是否改接口 | 意图 | 谁创建 |
|------|-----------|------|--------|
| 代理 | 不改，与目标相同 | **控制访问** | 通常由框架或工厂创建，客户端无感知 |
| [装饰器](./9_structural_decorator) | 不改，与目标相同 | **增强功能**，可多层叠加 | 客户端显式一层层包装 |
| [适配器](./6_structural_adapter) | 改，把旧接口转成新接口 | **接口兼容** | 客户端或配置显式创建 |
| [外观](./10_structural_facade) | 定义新的简化接口 | **简化使用**，面向一组子系统 | 显式创建 |

代理和装饰器在代码结构上几乎一样，区别只在意图：代理可以决定**不调用**目标（缓存命中、权限不足），也可以自己负责创建目标；装饰器总是调用被装饰对象，只在前后加功能。

---

## 小结

- 代理与目标实现同一接口并持有目标引用，在不改目标类的前提下控制对它的访问
- 常见种类：远程代理、虚拟代理、保护代理、缓存代理、增强代理，Spring 的 `@Transactional`、`@Cacheable`、`@Async`、MyBatis Mapper 都是代理
- 手写动态代理处理器要拆开 `InvocationTargetException`；JDK 代理与 CGLIB 的机制见 [动态代理](/java/16_topic_proxy)
- Spring 代理的典型坑：自调用失效、`final` / `private` 方法不被拦截、JDK 代理下按实现类注入失败
- 代理重在控制访问、通常由框架创建；装饰器重在增强、由调用方组装

## 参考资料

- Refactoring Guru：Proxy：[https://refactoring.guru/design-patterns/proxy](https://refactoring.guru/design-patterns/proxy)
- Erich Gamma 等：《设计模式：可复用面向对象软件的基础》，Proxy 一章
- Java SE 21 API：java.lang.reflect.Proxy：[https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/lang/reflect/Proxy.html](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/lang/reflect/Proxy.html)
- Spring Framework Reference：Proxying Mechanisms：[https://docs.spring.io/spring-framework/reference/core/aop/proxying.html](https://docs.spring.io/spring-framework/reference/core/aop/proxying.html)

> 下一篇：[责任链模式](./13_behavioral_chain_of_responsibility) —— 请求沿处理者链传递、纯责任链与管道、Servlet Filter 与 Netty Pipeline。
