# Spring 事务管理

> 参考资料：
> * Spring 官方文档 - Transaction：[https://docs.spring.io/spring-framework/reference/data-access/transaction.html](https://docs.spring.io/spring-framework/reference/data-access/transaction.html)
> * 事务传播行为详解：[https://www.baeldung.com/spring-transactional-propagation-isolation](https://www.baeldung.com/spring-transactional-propagation-isolation)

## 一、7 种传播行为

| 传播行为 | 说明 |
|---------|------|
| `REQUIRED` | 默认。有事务则加入，没有则新建 |
| `REQUIRES_NEW` | 始终新建事务，挂起当前事务 |
| `NESTED` | 嵌套事务，内层回滚不影响外层 |
| `SUPPORTS` | 有事务则加入，没有则以非事务执行 |
| `NOT_SUPPORTED` | 以非事务执行，挂起当前事务 |
| `MANDATORY` | 必须在已有事务中执行，否则抛异常 |
| `NEVER` | 不允许在事务中执行，否则抛异常 |

---

## 二、4 种隔离级别

| 隔离级别 | 脏读 | 不可重复读 | 幻读 |
|---------|------|----------|------|
| `READ_UNCOMMITTED` | ✅ | ✅ | ✅ |
| `READ_COMMITTED` | ❌ | ✅ | ✅ |
| `REPEATABLE_READ` | ❌ | ❌ | ✅ |
| `SERIALIZABLE` | ❌ | ❌ | ❌ |

> MySQL 默认 REPEATABLE_READ，通过 MVCC 解决大部分幻读问题。

---

## 三、@Transactional 完整配置

```java
@Service
public class OrderService {

    // 完整配置
    @Transactional(
        propagation = Propagation.REQUIRED,
        isolation = Isolation.DEFAULT,    // 使用数据库默认隔离级别
        rollbackFor = Exception.class,    // 必须显式指定，否则只回滚 RuntimeException
        noRollbackFor = BusinessException.class,
        readOnly = false,
        timeout = 30                      // 秒
    )
    public void createOrder(OrderCreateDTO dto) {
        // 业务逻辑
    }

    // 只读事务（查询性能优化）
    @Transactional(readOnly = true)
    public OrderVO getOrder(Long id) {
        return orderRepository.findById(id).orElseThrow();
    }
}
```

---

## 四、传播行为实战

### REQUIRED vs REQUIRES_NEW

```java
@Service
@RequiredArgsConstructor
public class OrderService {

    private final OrderRepository orderRepo;
    private final AuditService auditService;

    @Transactional
    public void createOrder(Order order) {
        orderRepo.save(order);

        // REQUIRES_NEW：审计日志独立事务，即使主事务回滚，日志依然保存
        auditService.log("CREATE_ORDER", order.getId());

        // 模拟异常 → 主事务回滚，但日志已提交
        if (order.getAmount().compareTo(BigDecimal.ZERO) < 0) {
            throw new BusinessException("金额不能为负");
        }
    }
}

@Service
public class AuditService {

    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public void log(String action, Long targetId) {
        // 独立事务，不受外层影响
        auditRepo.save(new AuditLog(action, targetId));
    }
}
```

### NESTED（嵌套事务）

```java
@Transactional
public void batchCreate(List<Order> orders) {
    for (Order order : orders) {
        try {
            createSingle(order);  // 内层失败不影响外层
        } catch (Exception e) {
            log.warn("订单 {} 创建失败，跳过", order.getId());
        }
    }
}

@Transactional(propagation = Propagation.NESTED)
public void createSingle(Order order) {
    orderRepo.save(order);
    inventoryService.deduct(order.getItems());  // 可能失败
}
```

---

## 五、编程式事务（TransactionTemplate）

```java
@Service
@RequiredArgsConstructor
public class PayService {

    private final TransactionTemplate txTemplate;  // Spring 自动装配

    public PayResult pay(PayRequest req) {
        return txTemplate.execute(status -> {
            try {
                accountService.deduct(req.getUserId(), req.getAmount());
                recordService.record(req);
                notifyService.notify(req);   // 假设不需要回滚通知
                return PayResult.success();
            } catch (InsufficientBalanceException e) {
                status.setRollbackOnly();    // 标记回滚
                return PayResult.fail("余额不足");
            }
        });
    }

    // 配置 TransactionTemplate
    @Bean
    public TransactionTemplate transactionTemplate(PlatformTransactionManager txManager) {
        TransactionTemplate template = new TransactionTemplate(txManager);
        template.setIsolationLevel(TransactionDefinition.ISOLATION_READ_COMMITTED);
        template.setTimeout(10);
        return template;
    }
}
```

---

## 六、事务失效的常见场景 ⚠️

| 场景 | 原因 | 解决 |
|------|------|------|
| 同类内方法调用 | 不走代理，AOP 失效 | 注入自身代理 `@Autowired UserService self` |
| 方法非 public | Spring AOP 不代理非 public 方法 | 改为 public |
| 异常被 catch 吞掉 | Spring 感知不到异常，不回滚 | catch 后重新抛出或手动 `TransactionAspectSupport.currentTransactionStatus().setRollbackOnly()` |
| 只配置了 `@Transactional` | 默认只回滚 RuntimeException | 加 `rollbackFor = Exception.class` |
| 多线程调用 | 事务绑定线程，子线程不在同一事务 | 用 `TransactionTemplate` 在子线程独立开启事务 |
| 数据库不支持事务 | 如 MySQL MyISAM 引擎 | 换 InnoDB |
| Bean 未被 Spring 管理 | new 出来的对象没有代理 | 通过 Spring 容器获取 Bean |

```java
// 同类自调用解决方案
@Service
public class UserService {

    @Autowired
    private UserService self;   // 注入代理

    public void batchUpdate(List<User> users) {
        users.forEach(u -> self.updateOne(u));  // 通过代理调用，事务生效
    }

    @Transactional
    public void updateOne(User user) {
        userRepo.save(user);
    }
}

// 手动触发回滚（catch 后不想重新抛异常）
@Transactional
public void process() {
    try {
        doSomething();
    } catch (Exception e) {
        log.error("处理失败", e);
        TransactionAspectSupport.currentTransactionStatus().setRollbackOnly();
    }
}
```
