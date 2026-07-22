# 代理模式

**作用**：为目标对象提供一个代理，控制对目标的访问，可在不修改原类的情况下增加前置/后置逻辑。

**应用场景（Spring 中无处不在）**：
- `@Transactional`：事务代理，方法前后 begin/commit/rollback
- `@Cacheable`：缓存代理，调用前查缓存，调用后写缓存
- `@Async`：异步代理，提交到线程池执行
- MyBatis Mapper 接口：运行时生成代理对象，执行 SQL
- 权限校验、日志记录、限流熔断

---

## 一、静态代理

代理类与目标类实现相同接口，代理类持有目标对象引用：

```java
public interface UserService {
    User findById(Long id);
}

@Service
public class UserServiceImpl implements UserService {
    public User findById(Long id) { /* 查库 */ return new User(id); }
}

// 静态代理：加缓存
public class CachingUserServiceProxy implements UserService {
    private final UserService    target;
    private final Map<Long, User> cache = new ConcurrentHashMap<>();

    public CachingUserServiceProxy(UserService target) { this.target = target; }

    @Override
    public User findById(Long id) {
        return cache.computeIfAbsent(id, target::findById);
    }
}
```

缺点：每个接口都要写一个代理类，维护成本高。

---

## 二、JDK 动态代理

运行时通过 `Proxy.newProxyInstance` 生成代理，要求目标类**实现接口**：

```java
public class LoggingProxy implements InvocationHandler {
    private final Object target;

    public LoggingProxy(Object target) { this.target = target; }

    @Override
    public Object invoke(Object proxy, Method method, Object[] args) throws Throwable {
        log.info("→ {}.{}({})", target.getClass().getSimpleName(),
                 method.getName(), Arrays.toString(args));
        long start = System.currentTimeMillis();
        Object result = method.invoke(target, args);
        log.info("← {}ms", System.currentTimeMillis() - start);
        return result;
    }

    @SuppressWarnings("unchecked")
    public static <T> T wrap(T target) {
        return (T) Proxy.newProxyInstance(
            target.getClass().getClassLoader(),
            target.getClass().getInterfaces(),
            new LoggingProxy(target)
        );
    }
}

// 使用
UserService proxy = LoggingProxy.wrap(new UserServiceImpl());
proxy.findById(1L);
```

---

## 三、CGLIB 动态代理

目标类**无需实现接口**，通过继承生成子类代理（Spring 默认使用 CGLIB）：

```java
// Spring 自动做，了解原理
Enhancer enhancer = new Enhancer();
enhancer.setSuperclass(UserServiceImpl.class);
enhancer.setCallback((MethodInterceptor) (obj, method, args, proxy) -> {
    System.out.println("Before: " + method.getName());
    Object result = proxy.invokeSuper(obj, args);
    System.out.println("After: " + method.getName());
    return result;
});
UserServiceImpl proxy = (UserServiceImpl) enhancer.create();
```

---

## 四、三种代理对比

| 维度 | 静态代理 | JDK 动态代理 | CGLIB |
|------|---------|-------------|-------|
| 是否需要接口 | ✅ 需要 | ✅ 需要 | ❌ 不需要 |
| 代码生成 | 手写 | 运行时生成 | 运行时生成子类 |
| 性能 | 最快 | 较快 | 略慢（生成子类字节码）|
| Spring 使用 | 不使用 | 目标有接口时 | 目标无接口或强制配置时 |

> `@EnableAspectJAutoProxy(proxyTargetClass=true)` 强制 Spring 使用 CGLIB。
