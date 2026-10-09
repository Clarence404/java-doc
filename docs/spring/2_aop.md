---
description: 核心概念、通知类型与执行顺序、切点表达式、代理选择、自调用失效、Spring AOP 与 AspectJ
---

# AOP

> **本篇目标**：能写出正确的 `@Aspect` 切面，说清同一切面内与多个切面之间的通知执行顺序，理解 Spring 如何选择代理类型，并能定位和修复自调用导致的 `@Transactional`、`@Async`、`@Cacheable` 失效。
>
> **前置阅读**：[IoC 容器](./1_ioc)、[动态代理](/java/16_topic_proxy)

> 参考资料：
> * Spring Framework 参考文档 - AOP：[https://docs.spring.io/spring-framework/reference/core/aop.html](https://docs.spring.io/spring-framework/reference/core/aop.html)
> * 通知声明与执行顺序：[https://docs.spring.io/spring-framework/reference/core/aop/ataspectj/advice.html](https://docs.spring.io/spring-framework/reference/core/aop/ataspectj/advice.html)
> * Spring Boot 参考文档 - AOP：[https://docs.spring.io/spring-boot/reference/features/aop.html](https://docs.spring.io/spring-boot/reference/features/aop.html)

AOP（面向切面编程）把日志、事务、权限、缓存这类横切关注点从业务方法中剥离出来，集中写在切面里。Spring AOP 基于**运行时代理**：容器在 Bean 初始化之后（`postProcessAfterInitialization`）用代理对象替换原始 Bean，调用方拿到的是代理，代理先执行通知再调用目标方法。`@Transactional`、`@Async`、`@Cacheable`、`@Validated` 方法校验都建立在这套机制上。

Spring Boot 4 中使用 `@Aspect` 需要引入 `spring-boot-starter-aspectj`（Boot 3.x 叫 `spring-boot-starter-aop`），类路径上有 AspectJ 时自动开启代理，无需再写 `@EnableAspectJAutoProxy`。

---

## 一、核心概念

| 概念 | 说明 |
|------|------|
| Aspect（切面） | 横切关注点的模块化，包含切点和通知，即一个 `@Aspect` 类 |
| JoinPoint（连接点） | 可以织入的位置；Spring AOP 中只有「方法执行」这一种 |
| Pointcut（切点） | 用表达式选出哪些连接点需要织入 |
| Advice（通知） | 在切点上执行的动作：前置、后置、环绕等 |
| Advisor | Spring 内部的「切点 + 通知」组合，`@Transactional` 对应 `BeanFactoryTransactionAttributeSourceAdvisor` |
| Weaving（织入） | 把切面应用到目标对象；Spring AOP 在运行时通过代理织入 |

---

## 二、通知类型与执行顺序

### 1、五种通知

| 类型 | 注解 | 执行时机 |
|------|------|---------|
| 前置通知 | `@Before` | 目标方法执行前；抛异常则目标方法不执行 |
| 返回通知 | `@AfterReturning` | 目标方法正常返回后，可拿到返回值 |
| 异常通知 | `@AfterThrowing` | 目标方法抛出异常后，可拿到异常，但不能吞掉异常 |
| 后置通知 | `@After` | 无论正常还是异常都会执行，相当于 `finally` |
| 环绕通知 | `@Around` | 包裹整个调用，可以决定是否调用、修改参数和返回值、吞掉或转换异常 |

### 2、同一切面内的顺序

同一个 `@Aspect` 类中，通知按类型确定优先级：`@Around` > `@Before` > `@After` > `@AfterReturning` > `@AfterThrowing`。但 `@After` 遵循 AspectJ 的 finally 语义，**实际在 `@AfterReturning` / `@AfterThrowing` 之后执行**（Spring 5.2.7 起如此，之前版本 `@After` 先执行）。一次正常调用的完整顺序是：

1. `@Around` 中 `proceed()` 之前的代码
2. `@Before`
3. 目标方法
4. `@AfterReturning`（异常时为 `@AfterThrowing`）
5. `@After`
6. `@Around` 中 `proceed()` 之后的代码

同一切面内两个同类型的通知（例如两个 `@Before`）顺序不确定，应合并成一个方法，或拆到不同切面再用 `@Order` 排序。

### 3、多个切面之间的顺序

多个切面作用于同一方法时，切面类上用 `@Order`（或实现 `Ordered`）声明优先级，**数值越小优先级越高**；不声明时顺序不确定。优先级高的切面「进入时最先执行、退出时最后执行」，像洋葱一样包在最外层。

这直接影响与事务的配合：事务通知默认是 `Ordered.LOWEST_PRECEDENCE`，处在最内层。如果自定义切面要在事务**内部**执行（例如需要在同一事务中写审计表），它的优先级必须低于事务；如果要在事务**外部**执行（例如分布式锁、重试，必须在事务提交后才释放锁或重试），就给它更高的优先级：

```java
@Aspect
@Component
@Order(Ordered.HIGHEST_PRECEDENCE + 10)   // 在事务外层：先加锁再开事务，事务提交后才解锁
public class DistributedLockAspect {
    // ...
}
```

也可以通过 `@EnableTransactionManagement(order = ...)` 调整事务通知自身的顺序。

---

## 三、切面示例

### 1、耗时与异常日志

```java
@Slf4j
@Aspect
@Component
public class OperationLogAspect {

    @Pointcut("execution(public * com.example.order.service..*(..))")
    public void serviceLayer() {}

    @Pointcut("@annotation(com.example.common.annotation.Log)")
    public void logAnnotated() {}

    @AfterThrowing(pointcut = "serviceLayer()", throwing = "ex")
    public void afterThrowing(JoinPoint joinPoint, Exception ex) {
        log.error("方法异常: {} 原因: {}", joinPoint.getSignature().toShortString(), ex.getMessage());
    }

    @Around("logAnnotated()")
    public Object around(ProceedingJoinPoint pjp) throws Throwable {
        long start = System.nanoTime();
        String method = pjp.getSignature().toShortString();
        try {
            return pjp.proceed();
        } finally {
            log.info("{} 耗时 {}ms", method, TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - start));
        }
    }
}
```

`@Around` 方法必须调用 `pjp.proceed()` 并把返回值返回，忘记 `return` 会导致目标方法的返回值变成 `null`。不要在日志里直接打印参数和返回值的完整内容，可能包含密码、手机号等敏感数据，也可能是很大的集合。

### 2、自定义注解 + 切面：权限校验

```java
@Target(ElementType.METHOD)
@Retention(RetentionPolicy.RUNTIME)
public @interface RequirePermission {
    String value();   // 权限码，如 "order:delete"
}

@Aspect
@Component
@RequiredArgsConstructor
public class PermissionAspect {

    private final PermissionService permissionService;

    // 参数名 requirePermission 与通知方法参数绑定，直接拿到注解实例
    @Before("@annotation(requirePermission)")
    public void check(RequirePermission requirePermission) {
        Long userId = UserContextHolder.currentUserId();   // 项目内的 ThreadLocal 用户上下文
        if (!permissionService.hasPermission(userId, requirePermission.value())) {
            throw new ForbiddenException("无权限: " + requirePermission.value());
        }
    }
}

@Service
public class OrderService {

    @RequirePermission("order:delete")
    public void deleteOrder(Long orderId) {
        // 业务逻辑
    }
}
```

这个例子演示的是「注解 + 切面」的写法。使用 Spring Security 的项目不必自己写，直接用 `@PreAuthorize("hasAuthority('order:delete')")`，见 [Security](./9_security)。

---

## 四、Spring 的代理选择

JDK 动态代理与 CGLIB 的实现原理、限制和排查方法见 [动态代理](/java/16_topic_proxy)，这里只说 Spring 的选择规则：

| 条件 | 使用的代理 |
|------|-----------|
| 纯 Spring Framework，`proxyTargetClass = false`（默认），Bean 实现了接口 | JDK 动态代理 |
| 纯 Spring Framework，Bean 没有实现接口 | CGLIB |
| `@EnableAspectJAutoProxy(proxyTargetClass = true)` | CGLIB |
| Spring Boot 2.0+（`spring.aop.proxy-target-class` 默认 `true`） | CGLIB，有接口也一样 |

选择依据是**能力而不是性能**：在现代 JDK 上两种代理的调用开销差别可以忽略，远小于通知本身的逻辑。CGLIB 通过生成子类实现，因此 `final` 类无法代理，`final`、`private`、`static` 方法无法被拦截。

需要在不用注解的场景下给对象加通知，可以用 `ProxyFactory`：

```java
import org.aopalliance.intercept.MethodInterceptor;   // AOP 联盟接口，不是 CGLIB 的同名接口

OrderService target = new OrderServiceImpl();
ProxyFactory factory = new ProxyFactory(target);
factory.addAdvice((MethodInterceptor) invocation -> {
    long start = System.nanoTime();
    try {
        return invocation.proceed();
    } finally {
        System.out.printf("%s 耗时 %dns%n", invocation.getMethod().getName(), System.nanoTime() - start);
    }
});
OrderService proxy = (OrderService) factory.getProxy();
```

---

## 五、切点表达式速查

| 指示符 | 示例 | 匹配 |
|--------|------|------|
| `execution` | `execution(* com.example.service.*.*(..))` | `service` 包下所有类的所有方法（不含子包） |
| `execution` | `execution(public * com.example..*Service.*(..))` | 任意子包中以 `Service` 结尾的类的 public 方法 |
| `within` | `within(com.example.service..*)` | 指定包及子包中类型的所有方法 |
| `@annotation` | `@annotation(org.springframework.transaction.annotation.Transactional)` | 方法上标了该注解 |
| `@within` | `@within(org.springframework.stereotype.Service)` | 类上标了该注解的所有方法 |
| `this` | `this(com.example.service.OrderService)` | 代理对象是该类型 |
| `target` | `target(com.example.service.OrderService)` | 目标对象是该类型；JDK 代理下与 `this` 结果可能不同 |
| `args` | `args(Long, ..)` | 运行时第一个参数是 `Long` |
| `bean` | `bean(*Service)` | Spring 特有，按 Bean 名称匹配 |

切点可以用 `&&`、`||`、`!` 组合，例如 `serviceLayer() && !@annotation(com.example.NoLog)`。性能上，`execution` / `within` 能在启动时静态判断，`args`、`this`、`target` 这类需要运行时判断的指示符应与前者组合使用，缩小匹配范围。

---

## 六、自调用失效问题

这是 Spring 中最常见的 AOP 陷阱，`@Transactional`、`@Async`、`@Cacheable`、`@Retryable`、`@Validated` 等所有基于代理的注解都会遇到。

**原因**：调用方持有的是代理，代理执行通知后调用目标对象的方法；目标方法内部用 `this.xxx()` 调用本类另一个方法时，`this` 是目标对象本身，不经过代理，被调用方法上的注解不会生效。

```java
@Service
@RequiredArgsConstructor
public class UserService {

    private final UserRepository userRepo;

    public void importUsers(List<User> users) {
        users.forEach(this::createOne);   // 自调用：createOne 上的 @Transactional 不生效
    }

    @Transactional
    public void createOne(User user) {
        userRepo.save(user);
    }
}
```

修复方式，按推荐程度排序：

| 方式 | 写法 | 说明 |
|------|------|------|
| 拆分 Bean（首选） | 把 `createOne` 移到 `UserWriter` 中，`UserService` 注入它 | 职责清晰，没有隐式依赖，测试简单 |
| 编程式事务 | 用 `TransactionTemplate` 在方法内控制事务边界 | 只适用于事务，见 [事务管理](./4_transaction) |
| 延迟获取自身代理 | 注入 `ObjectProvider<UserService>`，或在字段 / 构造参数上加 `@Lazy` | 能用，但读者不易看出意图 |
| `AopContext.currentProxy()` | 必须开启 `@EnableAspectJAutoProxy(exposeProxy = true)`，否则抛 `IllegalStateException` | 代码与 AOP 实现耦合，且只在当前代理调用链中有效，`@Async` 线程中拿不到 |
| AspectJ 编译期 / 加载期织入 | `@EnableTransactionManagement(mode = AdviceMode.ASPECTJ)` 等 | 字节码直接织入，自调用和非 public 方法也能拦截；构建复杂，很少使用 |

**不要直接用 `@Autowired private UserService self` 注入自身**：这本质是循环依赖，Spring Boot 2.6+ 默认禁止循环依赖，应用会启动失败（见 [IoC 容器](./1_ioc) 第七节）。

```java
// 推荐：拆分 Bean
@Service
@RequiredArgsConstructor
public class UserImportService {

    private final UserWriter userWriter;

    public void importUsers(List<User> users) {
        users.forEach(userWriter::createOne);   // 经过 UserWriter 的代理，事务生效
    }
}

@Service
@RequiredArgsConstructor
public class UserWriter {

    private final UserRepository userRepo;

    @Transactional
    public void createOne(User user) {
        userRepo.save(user);
    }
}

// 不便拆分时：延迟获取自身代理
@Service
public class UserService {

    private final ObjectProvider<UserService> self;
    private final UserRepository userRepo;

    public UserService(ObjectProvider<UserService> self, UserRepository userRepo) {
        this.self = self;
        this.userRepo = userRepo;
    }

    public void importUsers(List<User> users) {
        UserService proxy = self.getObject();
        users.forEach(proxy::createOne);
    }

    @Transactional
    public void createOne(User user) {
        userRepo.save(user);
    }
}
```

---

## 七、Spring AOP 与 AspectJ

| 对比 | Spring AOP | AspectJ |
|------|------------|---------|
| 织入时机 | 运行时，通过代理 | 编译期（ajc）或类加载期（LTW） |
| 连接点 | 只有 Spring Bean 的方法执行 | 方法调用与执行、构造器、字段读写、静态初始化等 |
| 能否拦截自调用 | 不能 | 能 |
| `private` / `final` / `static` 方法 | 不能 | 能 |
| 非 Spring 管理的对象 | 不能 | 能 |
| 使用成本 | 零配置，Boot 自动开启 | 需要 ajc 编译器或 `-javaagent` |

Spring AOP 复用了 AspectJ 的注解（`@Aspect`、`@Pointcut`）和切点表达式解析器，但织入方式是自己的代理机制。绝大多数业务场景 Spring AOP 足够，只有需要拦截自调用、领域对象或字段访问时才考虑 AspectJ。

---

## 八、AOP 与事务等注解的关系

`@Transactional` 的实现是一个 Advisor：切点匹配带注解的方法，通知是 `TransactionInterceptor`（一个环绕通知），在调用前通过 `PlatformTransactionManager` 开启事务，正常返回时提交，异常时按回滚规则回滚。

因此「没有经过代理」类的失效场景，包括自调用、方法为 `private` / `final`、对象不是 Spring Bean，都源自 AOP。但事务失效并不都是代理问题：异常被吞掉、受检异常默认不回滚、传播行为选错、多线程、存储引擎不支持事务等，都与代理无关，完整列表见 [事务管理](./4_transaction)。

---

## 小结

- Spring AOP 在 Bean 初始化后用代理替换原 Bean，连接点只有方法执行；Boot 4 引入 `spring-boot-starter-aspectj`（Boot 3 为 `spring-boot-starter-aop`）即自动开启
- 同一切面内：`@Around` 前半 → `@Before` → 目标 → `@AfterReturning` / `@AfterThrowing` → `@After` → `@Around` 后半；多个切面用 `@Order` 排序，数值小的包在外层；事务通知默认在最内层
- Boot 默认一律使用 CGLIB，选择依据是能力而非性能；`final` 类和 `private` / `final` / `static` 方法无法被代理
- 切点优先用 `execution` / `within` / `@annotation` 等可静态匹配的指示符
- 自调用不经过代理，首选拆分 Bean，其次 `ObjectProvider` / `@Lazy` 获取自身代理或 `AopContext`（需 `exposeProxy = true`）；直接注入自身在 Boot 2.6+ 会因循环依赖启动失败
- 需要拦截自调用、非 Spring 对象或字段访问时才考虑 AspectJ 织入

> 下一篇：[MVC](./3_mvc) —— 从 DispatcherServlet 出发，看一个 HTTP 请求如何被映射、绑定、校验、执行并转换成响应。
