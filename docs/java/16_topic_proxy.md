---
description: JDK Proxy、CGLIB invokeSuper、ByteBuddy、Spring 默认代理、生成类导出
---

# 动态代理

> 前置阅读：[反射](./15_topic_reflection)

动态代理是在运行时生成一个实现相同接口或继承目标类的新类，把每次方法调用分派给统一的拦截逻辑，Spring AOP、`@Transactional`、MyBatis Mapper、Feign / Dubbo 客户端都建立在它之上。本篇讲 JDK 动态代理与 CGLIB 生成的类和调用分派、异常传递、`invoke` 与 `invokeSuper` 的区别，以及 Spring 的代理选择与排查方法。

---

## 一、JDK 动态代理

代理模式本身的意图、静态代理写法见 [代理模式](/patterns/12_structural_proxy)，本篇只讲 JVM 层面的实现机制。

### 1、写一个正确的 InvocationHandler

```java
public interface UserService {
    User findById(Long id);
    default String describe() { return "UserService"; }
}

public final class TimingHandler implements InvocationHandler {
    private static final Logger log = LoggerFactory.getLogger(TimingHandler.class);
    private final Object target;

    public TimingHandler(Object target) { this.target = target; }

    @Override
    public Object invoke(Object proxy, Method method, Object[] args) throws Throwable {
        // equals / hashCode / toString 也会进入这里，按需单独处理
        if (method.getDeclaringClass() == Object.class) {
            return method.invoke(target, args);
        }
        long start = System.nanoTime();
        try {
            return method.invoke(target, args);
        } catch (InvocationTargetException e) {
            throw e.getCause();                 // 解包：让调用方看到原始的业务异常
        } finally {
            log.info("{} 耗时 {} µs", method.getName(), (System.nanoTime() - start) / 1_000);
        }
    }
}

UserService proxy = (UserService) Proxy.newProxyInstance(
        UserService.class.getClassLoader(),
        new Class<?>[]{UserService.class},
        new TimingHandler(new UserServiceImpl()));
```

两个容易写错的地方：

- **不解包 `InvocationTargetException`**：目标方法抛出的 `RuntimeException` 会以 `InvocationTargetException` 的形式从 `invoke` 抛出；它是受检异常，而接口方法没有声明它，代理类会再把它包成 `UndeclaredThrowableException`。调用方 `catch (BizException e)` 就永远抓不到。
- **在 handler 里调用 `proxy` 的方法**：`proxy.toString()` 会再次进入 `invoke`，造成无限递归；日志里打印要用 `target` 或 `method`。

接口的 default 方法如果想「不拦截、直接执行接口里的默认实现」，JDK 16 起可以用 `InvocationHandler.invokeDefault(proxy, method, args)`，不再需要借助 `MethodHandles.privateLookupIn` 的 hack。

### 2、运行时生成了什么

`Proxy.newProxyInstance` 内部由 `ProxyGenerator` 直接生成字节码，再通过目标类加载器定义成类。按 (类加载器, 接口列表) 缓存，同一组接口只生成一次。反编译生成的类，结构大致如下：

```java
public final class $Proxy0 extends Proxy implements UserService {
    private static final Method m3;   // 静态初始化时用反射查好：UserService.findById
    public $Proxy0(InvocationHandler h) { super(h); }
    public final User findById(Long id) {
        try {
            return (User) h.invoke(this, m3, new Object[]{id});
        } catch (RuntimeException | Error e) {
            throw e;
        } catch (Throwable t) {
            throw new UndeclaredThrowableException(t);   // 未声明的受检异常被包装
        }
    }
    // equals / hashCode / toString 同样转发给 h
}
```

由此可以推出 JDK 代理的特性：

- 代理类继承 `Proxy`、实现接口，**只能按接口类型使用**，强转成 `UserServiceImpl` 会 `ClassCastException`；
- 只有接口里声明的方法会被拦截，实现类自己额外的 public 方法不在代理上；
- 类名在 JDK 8 中形如 `com.sun.proxy.$Proxy0`；较新的 JDK 中，全部为 public 接口时代理类定义在 JDK 创建的动态模块里，类名形如 `jdk.proxy2.$Proxy12`。包名与编号由 JDK 决定，代码不应依赖。

---

## 二、CGLIB 动态代理

### 1、用哪个 CGLIB

原版 `cglib`（`net.sf.cglib`）已停止维护，它的 README 明确说明在 JDK 17+ 上工作不佳：它通过反射调用 `ClassLoader.defineClass`，在强封装下需要 `--add-opens java.base/java.lang=ALL-UNNAMED`。实际项目中有两个选择：

- Spring 内嵌的分支 `org.springframework.cglib.*`（随 `spring-core` 发布、持续维护，在 JDK 9+ 上优先用 `MethodHandles.Lookup` 定义类）；
- 新代码直接用 ByteBuddy（见第三节）。

### 2、invoke 与 invokeSuper

```java
import org.springframework.cglib.proxy.Enhancer;
import org.springframework.cglib.proxy.MethodInterceptor;

UserServiceImpl target = new UserServiceImpl();

Enhancer enhancer = new Enhancer();
enhancer.setSuperclass(UserServiceImpl.class);
enhancer.setCallback((MethodInterceptor) (proxy, method, args, methodProxy) -> {
    log.info("拦截 {}", method.getName());
    // 方式 A：在代理对象自身上执行父类（目标类）的实现
    return methodProxy.invokeSuper(proxy, args);
    // 方式 B：转发给另一个独立的目标对象
    // return methodProxy.invoke(target, args);
    // 错误：methodProxy.invoke(proxy, args) 会再次进入代理自身的覆写方法 → 无限递归 StackOverflowError
});
UserServiceImpl proxy = (UserServiceImpl) enhancer.create();
```

两种方式都正确，区别在 `this` 是谁：

| 写法 | 方法体里的 `this` | `this.other()` 自调用 | 典型使用者 |
|------|------------------|----------------------|------------|
| `invokeSuper(proxy, args)` | 代理对象 | **会**再次被拦截 | Spring `@Configuration` 类增强（`@Bean` 方法互调返回同一单例） |
| `invoke(target, args)` | 独立的 target 对象 | **不会**被拦截 | Spring AOP 的 `CglibAopProxy` |

Spring AOP 即使用 CGLIB，也是「代理对象 + 独立的目标 Bean」两个实例，调用最终落在目标 Bean 上，所以 `@Transactional` 的自调用失效问题在 CGLIB 代理下同样存在。`MethodProxy` 通过为代理类和目标类各生成一个 FastClass（按方法下标 switch 直接调用）来避免反射。

### 3、CGLIB 的限制

- `final` 类不能被继承，`final` / `private` / `static` 方法不能被覆写，调用这些方法时**不会**进入拦截器，而是直接执行父类（代理对象自身）的代码——代理对象中的字段通常是空的，于是出现「`final` 方法里注入的依赖为 null」的诡异 NPE；
- 生成子类需要调用父类构造器，Spring 借助 Objenesis 绕过构造器创建代理实例，因此目标类的构造器不会被执行两次；
- 每次 `new Enhancer()` 且关闭缓存或使用不同的回调类型会生成新类，循环中创建代理会撑爆元空间。

![JDK 动态代理与 CGLIB 的结构对比](../assets/java/proxy_jdk_vs_cglib.svg)

---

## 三、ByteBuddy 与其他字节码库

ByteBuddy 是目前最活跃的运行时字节码库，Mockito、Hibernate 6、众多 APM Agent 都基于它，它跟进新版 JDK 的 class 文件格式也最及时。用 ByteBuddy 实现与上文相同的子类代理：

```java
public class TimingInterceptor {
    @RuntimeType
    public static Object intercept(@Origin Method method,
                                   @SuperCall Callable<?> superCall) throws Exception {
        long start = System.nanoTime();
        try {
            return superCall.call();               // 相当于 invokeSuper
        } finally {
            System.out.printf("%s 耗时 %d µs%n", method.getName(), (System.nanoTime() - start) / 1_000);
        }
    }
}

Class<? extends UserServiceImpl> type = new ByteBuddy()
        .subclass(UserServiceImpl.class)
        .method(ElementMatchers.isPublic().and(ElementMatchers.not(ElementMatchers.isDeclaredBy(Object.class))))
        .intercept(MethodDelegation.to(TimingInterceptor.class))
        .make()
        .load(UserServiceImpl.class.getClassLoader())
        .getLoaded();
UserServiceImpl proxy = type.getDeclaredConstructor().newInstance();
```

| | JDK 动态代理 | CGLIB（Spring 分支） | ByteBuddy |
|--|--------------|----------------------|-----------|
| 前提 | 必须有接口 | 非 final 类 | 子类方式同 CGLIB，另支持重定义已有类 |
| 生成方式 | 实现接口 | 继承目标类 | 继承 / 重定义 / Java Agent 改写 |
| 依赖 | JDK 自带 | `spring-core` | 独立依赖 |
| 典型用户 | MyBatis Mapper、Feign、Dubbo 客户端 | Spring AOP、`@Configuration` 增强 | Mockito、Hibernate、APM Agent |

性能方面：创建代理类时都要生成和加载字节码，属于一次性成本；调用开销在 JIT 预热后差距很小，具体以 [基准测试（JMH）](/high-perf/4_benchmark) 实测为准，不要凭旧资料下结论。Javassist 支持用 Java 源码字符串生成代码，上手简单，但维护活跃度不如 ByteBuddy，常见于老版本 Dubbo、MyBatis 的部分模块。

---

## 四、Spring 中的代理选择

Spring 默认用哪种代理，要区分 Spring Framework 和 Spring Boot：

- **Spring Framework**：`@EnableAspectJAutoProxy` 的 `proxyTargetClass` 默认为 `false`——Bean 实现了接口就用 JDK 动态代理，没有接口才用 CGLIB；
- **Spring Boot 2.0 起**：`spring.aop.proxy-target-class` 默认为 `true`，即**默认一律使用 CGLIB**，有接口也一样。这样无论按接口还是按实现类注入都不会因为代理类型报 `BeanNotOfRequiredTypeException`。

需要改回 JDK 代理时：

```yaml
spring:
  aop:
    proxy-target-class: false
```

无论哪种代理，Spring AOP 的调用都经过「代理对象 → 拦截器链 → 目标 Bean」，目标 Bean 内部的 `this.xxx()` 不经过代理，`@Transactional`、`@Async`、`@Cacheable` 都会因此失效。修复方式有三种：拆到另一个 Bean（首选）、注入自身代理、`AopContext.currentProxy()`。最后一种**必须**开启 `@EnableAspectJAutoProxy(exposeProxy = true)`，否则调用时抛 `IllegalStateException`（提示设置 `exposeProxy`）。拦截器链、通知顺序与自调用的完整分析见 [AOP](/spring/2_aop#六、自调用失效问题)。

---

## 五、生产排查与 AOT

### 1、把生成的类导出来

| 代理 | 参数 | 适用版本 |
|------|------|----------|
| JDK 动态代理 | `-Dsun.misc.ProxyGenerator.saveGeneratedFiles=true` | JDK 8 |
| JDK 动态代理 | `-Djdk.proxy.ProxyGenerator.saveGeneratedFiles=true` | JDK 9+ |
| CGLIB | `-Dcglib.debugLocation=/tmp/cglib` | 原版与 Spring 分支 |

JDK 代理的 class 文件写入当前工作目录下按包名组织的子目录。拿到 class 文件后用 `javap -c -p` 或 IDE 反编译查看调用如何分派。

### 2、常见问题定位

- **注解读不到**：CGLIB 代理类是子类，`proxy.getClass()` 上拿不到方法注解；用 `AopUtils.getTargetClass(bean)` 或 `ClassUtils.getUserClass` 拿到原始类再查找；
- **元空间持续增长**：用 `jcmd <pid> VM.classloader_stats` 或 [性能分析工具](/high-perf/3_profilers) 看是否有大量 `$Proxy` / `$$SpringCGLIB$$` / `$ByteBuddy$` 类，通常是代理在循环里重复创建；
- **`ClassCastException: jdk.proxy2.$Proxy12 cannot be cast to ...Impl`**：拿到的是 JDK 代理，改为按接口注入或开启类代理。

### 3、Native Image 与 Spring AOT

GraalVM Native Image 不能在运行时生成类：JDK 动态代理需要在构建期登记接口列表（proxy-config / `RuntimeHints.proxies()`），CGLIB 代理类由 Spring AOT 在构建期提前生成。自己用 `Proxy.newProxyInstance` 的地方要补充 hints，详见 [启动与部署优化](/spring-boot/14_startup)。

---

## 小结

- JDK 动态代理运行时生成「继承 `Proxy`、实现接口」的类，所有接口方法和 `equals` / `hashCode` / `toString` 都转发给 `InvocationHandler`；只能按接口类型使用
- handler 中用 `method.invoke(target, args)` 必须捕获 `InvocationTargetException` 并抛出 `getCause()`，否则调用方拿到的是包装异常
- CGLIB 通过生成子类代理：`invokeSuper(proxy)` 在代理自身执行父类实现，自调用也被拦截；`invoke(target)` 转发到独立目标，自调用不被拦截；`invoke(proxy)` 会无限递归
- 原版 cglib 已停止维护，用 Spring 内嵌分支或 ByteBuddy；`final` 类和方法无法被拦截
- Spring Framework 默认有接口用 JDK 代理；Spring Boot 2.0 起 `spring.aop.proxy-target-class=true`，默认 CGLIB；`AopContext.currentProxy()` 依赖 `exposeProxy = true`
- JDK 9+ 用 `-Djdk.proxy.ProxyGenerator.saveGeneratedFiles=true` 导出代理类；Native Image 下代理要在构建期登记或生成

## 参考资料

- `java.lang.reflect.Proxy`（JDK 21）：[https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/lang/reflect/Proxy.html](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/lang/reflect/Proxy.html)
- `InvocationHandler`（含 `invokeDefault`）：[https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/lang/reflect/InvocationHandler.html](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/lang/reflect/InvocationHandler.html)
- Spring Framework - Proxying Mechanisms：[https://docs.spring.io/spring-framework/reference/core/aop/proxying.html](https://docs.spring.io/spring-framework/reference/core/aop/proxying.html)
- Byte Buddy：[https://bytebuddy.net/](https://bytebuddy.net/)

> 下一篇：[日期与时间](./17_topic_time) —— 从反射与代理回到日常 API：java.time 的类型模型、时区与夏令时，以及时间在数据库和 JSON 中如何存取。
