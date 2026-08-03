# Spring AOP

> 参考资料：
> * Spring 官方文档 - AOP：[https://docs.spring.io/spring-framework/reference/core/aop.html](https://docs.spring.io/spring-framework/reference/core/aop.html)
> * JDK 动态代理 vs CGLIB：[https://www.baeldung.com/spring-aop-vs-aspectj](https://www.baeldung.com/spring-aop-vs-aspectj)

## 一、核心概念

| 概念 | 说明 |
|------|------|
| Aspect（切面） | 横切关注点的模块化，包含切点 + 通知 |
| JoinPoint（连接点） | 程序执行过程中的某个点，Spring AOP 中特指方法执行 |
| Pointcut（切点） | 定义在哪些 JoinPoint 上织入，用表达式描述 |
| Advice（通知） | 在切点处执行的动作（前置 / 后置 / 环绕等） |
| Weaving（织入） | 把切面应用到目标对象的过程 |

---

## 二、通知类型

| 类型 | 注解 | 执行时机 |
|------|------|---------|
| 前置通知 | `@Before` | 方法执行前 |
| 后置通知 | `@After` | 方法执行后（无论是否异常） |
| 返回通知 | `@AfterReturning` | 方法正常返回后 |
| 异常通知 | `@AfterThrowing` | 方法抛出异常后 |
| 环绕通知 | `@Around` | 方法前后，最强大，可控制是否执行 |

---

## 三、完整切面示例

### 3.1 操作日志切面

```java
@Aspect
@Component
@Slf4j
public class OperationLogAspect {

    // 切点：匹配所有 service 包下的 public 方法
    @Pointcut("execution(public * com.example.service..*(..))")
    public void serviceLayer() {}

    // 切点：匹配带有 @Log 注解的方法
    @Pointcut("@annotation(com.example.annotation.Log)")
    public void logAnnotated() {}

    // 前置通知
    @Before("serviceLayer()")
    public void before(JoinPoint joinPoint) {
        String method = joinPoint.getSignature().toShortString();
        log.debug("→ 进入方法: {}", method);
    }

    // 返回通知（拿到返回值）
    @AfterReturning(pointcut = "serviceLayer()", returning = "result")
    public void afterReturning(JoinPoint joinPoint, Object result) {
        log.debug("← 方法正常返回: {}", result);
    }

    // 异常通知（拿到异常）
    @AfterThrowing(pointcut = "serviceLayer()", throwing = "ex")
    public void afterThrowing(JoinPoint joinPoint, Exception ex) {
        log.error("✗ 方法异常: {} | 原因: {}", joinPoint.getSignature().getName(), ex.getMessage());
    }

    // 环绕通知（最完整控制，可替代上面所有）
    @Around("logAnnotated()")
    public Object around(ProceedingJoinPoint pjp) throws Throwable {
        long start = System.currentTimeMillis();
        String method = pjp.getSignature().toShortString();
        Object[] args = pjp.getArgs();
        log.info("调用 {} args={}", method, Arrays.toString(args));
        try {
            Object result = pjp.proceed();  // 执行目标方法
            log.info("完成 {} 耗时={}ms result={}", method, System.currentTimeMillis() - start, result);
            return result;
        } catch (Throwable e) {
            log.error("失败 {} 原因={}", method, e.getMessage());
            throw e;
        }
    }
}
```

### 3.2 自定义注解 + 切面（权限校验）

```java
// 1. 自定义注解
@Target(ElementType.METHOD)
@Retention(RetentionPolicy.RUNTIME)
public @interface RequirePermission {
    String value();  // 权限码，如 "order:delete"
}

// 2. 切面实现
@Aspect
@Component
@RequiredArgsConstructor
public class PermissionAspect {

    private final AuthService authService;

    @Around("@annotation(requirePermission)")
    public Object checkPermission(ProceedingJoinPoint pjp,
                                  RequirePermission requirePermission) throws Throwable {
        String permCode = requirePermission.value();
        Long userId = SecurityContext.getCurrentUserId();

        if (!authService.hasPermission(userId, permCode)) {
            throw new AccessDeniedException("无权限: " + permCode);
        }
        return pjp.proceed();
    }
}

// 3. 使用
@Service
public class OrderService {

    @RequirePermission("order:delete")
    public void deleteOrder(Long orderId) {
        // 业务逻辑
    }
}
```

---

## 四、JDK 动态代理 vs CGLIB

| 对比 | JDK 动态代理 | CGLIB |
|------|------------|-------|
| 原理 | 实现目标接口，生成代理类 | 继承目标类，生成子类 |
| 要求 | 目标必须有接口 | 目标类不能是 final |
| 性能 | 调用略慢（反射） | 调用较快（字节码） |
| Spring 默认 | 有接口时使用 | 无接口或强制时使用 |

> Spring Boot 2.x 起默认使用 CGLIB（`spring.aop.proxy-target-class=true`）

```java
// 强制使用 CGLIB
@EnableAspectJAutoProxy(proxyTargetClass = true)

// 编程式使用 ProxyFactory
ProxyFactory factory = new ProxyFactory(target);
factory.addAdvice(new MethodInterceptor() {
    @Override
    public Object invoke(MethodInvocation invocation) throws Throwable {
        System.out.println("before");
        Object result = invocation.proceed();
        System.out.println("after");
        return result;
    }
});
MyService proxy = (MyService) factory.getProxy();
```

---

## 五、切点表达式速查

```java
// execution：最常用，匹配方法签名
@Pointcut("execution(* com.example.service.*.*(..))")        // service 包所有方法
@Pointcut("execution(public * com.example..*Service.*(..))")  // ..Service 结尾的类

// @annotation：匹配带指定注解的方法
@Pointcut("@annotation(org.springframework.transaction.annotation.Transactional)")

// within：匹配某类型范围
@Pointcut("within(com.example.service..*)")

// bean：按 Bean 名称匹配
@Pointcut("bean(orderService) || bean(*Service)")

// args：匹配参数类型
@Pointcut("args(Long, ..)")  // 第一个参数是 Long 的方法
```

---

## 六、自调用失效问题

```java
@Service
public class UserService {

    // ❌ 自调用：createBatch 调用 createOne，@Transactional 不生效
    public void createBatch(List<User> users) {
        users.forEach(this::createOne);
    }

    @Transactional
    public void createOne(User user) {
        // ...
    }

    // ✅ 方案一：注入自身代理
    @Autowired
    private UserService self;

    public void createBatchFixed(List<User> users) {
        users.forEach(u -> self.createOne(u));  // 走代理
    }
}
```

---

## 七、AOP 与事务的关系

Spring 事务（`@Transactional`）底层就是 AOP：
- `TransactionInterceptor` 是一个 `MethodInterceptor`（环绕通知）
- 目标方法执行前开启事务，执行后提交，异常时回滚
- 事务的所有失效场景本质上都是 AOP 代理失效
