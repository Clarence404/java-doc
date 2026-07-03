# Java 专项-动态代理

## 一、代理模式回顾

代理模式为目标对象提供一个替代品，在不修改原有代码的前提下增强功能（日志、事务、权限等）。

- **静态代理**：编译期手动编写代理类，代码量大，维护困难
- **动态代理**：运行时动态生成代理类，是 AOP 的实现基础

---

## 二、JDK 动态代理

**限制**：目标类必须实现接口，代理的是接口方法。

```java
public interface UserService {
    User findById(Long id);
}

public class UserServiceImpl implements UserService {
    public User findById(Long id) { return userDao.findById(id); }
}

// InvocationHandler：拦截所有接口方法
public class LoggingHandler implements InvocationHandler {
    private final Object target;

    public LoggingHandler(Object target) { this.target = target; }

    @Override
    public Object invoke(Object proxy, Method method, Object[] args) throws Throwable {
        log.info("调用方法: {}", method.getName());
        long start = System.currentTimeMillis();
        try {
            return method.invoke(target, args); // 调用真实方法
        } finally {
            log.info("耗时: {}ms", System.currentTimeMillis() - start);
        }
    }
}

// 创建代理
UserService proxy = (UserService) Proxy.newProxyInstance(
    UserServiceImpl.class.getClassLoader(),
    new Class[]{UserService.class},
    new LoggingHandler(new UserServiceImpl())
);
proxy.findById(1L);
```

### 底层原理

1. `Proxy.newProxyInstance()` 在运行时动态生成一个 `$Proxy0` 类
2. 该类实现目标接口，所有方法都委托给 `InvocationHandler.invoke()`
3. 生成的字节码通过 `ClassLoader` 加载到 JVM

---

## 三、CGLIB 动态代理

**优势**：不需要接口，通过继承目标类生成子类实现代理。
**限制**：`final` 类和 `final` 方法无法代理（无法继承/覆写）。

```java
// 引入依赖：spring-core 已内置 CGLIB
Enhancer enhancer = new Enhancer();
enhancer.setSuperclass(UserServiceImpl.class); // 设置父类（目标类）
enhancer.setCallback(new MethodInterceptor() {
    @Override
    public Object intercept(Object obj, Method method, Object[] args,
                            MethodProxy proxy) throws Throwable {
        log.info("CGLIB 拦截: {}", method.getName());
        return proxy.invokeSuper(obj, args); // 调用父类方法
    }
});

UserServiceImpl proxy = (UserServiceImpl) enhancer.create();
proxy.findById(1L);
```

### CGLIB vs JDK 动态代理

| | JDK 动态代理 | CGLIB |
|--|--------------|-------|
| 要求 | 必须有接口 | 无需接口 |
| 原理 | 实现接口，生成 `$Proxy` 类 | 继承目标类，生成子类 |
| `final` 限制 | 接口方法均可代理 | `final` 类/方法不可代理 |
| 性能（创建） | 快 | 慢（ASM 生成字节码） |
| 性能（调用） | Java 8+ 差距不大 | FastClass 机制略快 |
| Spring 默认 | 有接口时优先用 JDK | 无接口 / 强制时用 CGLIB |

---

## 四、Spring AOP 中的代理选择

Spring Boot 2.x 起**默认使用 CGLIB**（即使有接口），因为 CGLIB 代理可以注入接口类型也可以注入具体类类型，避免了 JDK 代理只能注入接口类型导致的注入失败问题。

强制使用 JDK 代理：
```yaml
spring:
  aop:
    proxy-target-class: false
```

### Spring AOP 代理的调用链

```
调用方
  → 代理对象（$Proxy 或 CGLIB 子类）
    → MethodInterceptor 链（@Before / @Around / @After 等）
      → 目标对象的真实方法
```

**注意**：方法内部的 `this.xxx()` 调用不经过代理，`@Transactional` 等注解在自调用时失效就是这个原因。解决方案：注入自身代理、使用 `AopContext.currentProxy()`、或重构为两个 Bean。

---

## 五、常见面试问题

**Q：JDK 代理和 CGLIB 各在什么场景下用？**
有接口时两者均可，Spring 默认用 CGLIB；目标类没有接口时只能用 CGLIB；目标类是 `final` 时只能用 JDK 代理（或根本无法代理）。

**Q：为什么 Spring 事务在同一类中自调用会失效？**
Spring AOP 基于动态代理，事务增强逻辑在代理对象上；同一类内的 `this.method()` 调用绕过了代理，直接访问目标对象，所以事务拦截器不执行。

**Q：CGLIB 的 `invokeSuper` 和 `invoke` 有什么区别？**
`invokeSuper` 调用父类（目标类）的真实方法，不经过代理拦截；`invoke` 会走完整代理链，可能导致无限递归。拦截器内部应始终使用 `invokeSuper`。

**Q：动态代理生成的类在哪里？**
运行时生成，存在 JVM 的元空间（Metaspace）中。可通过 `-Dsun.misc.ProxyGenerator.saveGeneratedFiles=true`（JDK 代理）或 `-Dcglib.debugLocation=/tmp`（CGLIB）将字节码保存到磁盘查看。
