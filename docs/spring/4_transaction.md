---
description: "@Transactional 原理、传播行为、回滚规则、只读与超时、编程式事务、失效场景"
---

# 事务管理

> 前置阅读：[AOP](./2_aop)、[MySQL 事务与锁](/database/1_mysql/5_topic_transaction)

Spring 声明式事务通过 `@Transactional` 代理把数据库连接绑定到当前线程。本篇讲它的工作机制、传播行为、回滚规则、编程式事务，以及事务失效的逐条排查。

---

## 一、@Transactional 的工作原理

`@Transactional` 是一个 AOP 环绕通知，一次调用经过以下环节：

1. **代理**：调用方拿到的是代理对象，调用进入 `TransactionInterceptor`
2. **解析事务属性**：从方法或类上的 `@Transactional` 读取传播行为、隔离级别、超时、只读和回滚规则
3. **事务管理器**：`PlatformTransactionManager` 按传播行为决定新建、加入还是挂起事务；新建时从连接池取连接、`setAutoCommit(false)`
4. **绑定线程**：`TransactionSynchronizationManager` 把连接放进 `ThreadLocal`，同一线程中的 `JdbcTemplate`、MyBatis、JPA 通过 `DataSourceUtils` 取到的是同一个连接
5. **提交或回滚**：方法正常返回则提交；抛出异常时按回滚规则决定回滚还是提交，然后解绑连接、归还连接池

由此可以直接推出事务的几条边界：**不经过代理就没有事务**（自调用、`private` 方法）；**事务绑定在线程上**，新开的线程拿不到当前事务；**只有通过 Spring 管理的连接访问数据库**才在事务中。

| 事务管理器 | 适用场景 |
|-----------|---------|
| `JdbcTransactionManager` / `DataSourceTransactionManager` | JDBC、`JdbcClient`、MyBatis；Boot 未引入 JPA 时自动配置前者 |
| `JpaTransactionManager` | JPA / Hibernate，同时支持同一数据源上的 JDBC 访问；Boot 引入 JPA 时自动配置 |
| `JtaTransactionManager` | 跨多个资源的 XA 事务，很少使用 |
| `R2dbcTransactionManager` 等 `ReactiveTransactionManager` | 响应式栈，事务上下文存放在 Reactor `Context` 而非 `ThreadLocal`，见 [WebFlux](./8_webflux) |

---

## 二、传播行为

### 1、七种传播行为

传播行为决定「一个事务方法被另一个事务方法调用时」如何处理事务：

| 传播行为 | 当前有事务 | 当前无事务 |
|---------|-----------|-----------|
| `REQUIRED`（默认） | 加入 | 新建 |
| `REQUIRES_NEW` | 挂起当前事务，新建独立事务 | 新建 |
| `NESTED` | 在当前事务中创建保存点 | 新建 |
| `SUPPORTS` | 加入 | 以非事务方式执行 |
| `NOT_SUPPORTED` | 挂起当前事务，以非事务方式执行 | 以非事务方式执行 |
| `MANDATORY` | 加入 | 抛 `IllegalTransactionStateException` |
| `NEVER` | 抛 `IllegalTransactionStateException` | 以非事务方式执行 |

传播行为只在**跨代理调用**时生效：同一个类内部互相调用不经过代理，被调用方法上的传播行为会被完全忽略。

### 2、REQUIRED、REQUIRES_NEW 与 NESTED

![REQUIRED / REQUIRES_NEW / NESTED 对比](../assets/spring/spring-tx-propagation.svg)

| 对比 | `REQUIRED` | `REQUIRES_NEW` | `NESTED` |
|------|-----------|---------------|----------|
| 物理事务 | 与外层同一个 | 两个独立事务 | 同一个，内层是保存点 |
| 数据库连接 | 1 个 | 2 个（外层连接挂起期间仍被占用） | 1 个 |
| 内层失败 | 整个事务被标记为 rollback-only | 只回滚内层；异常若不被外层捕获，外层也会回滚 | 回滚到保存点，外层可以继续 |
| 外层失败 | 一起回滚 | 内层已提交，不受影响 | 内层一起回滚 |
| 典型场景 | 绝大多数业务方法 | 审计日志、发号器等必须独立提交的操作 | 批量处理中允许部分失败 |

### 3、REQUIRES_NEW：独立提交的审计日志

```java
@Service
@RequiredArgsConstructor
public class OrderService {

    private final OrderRepository orderRepo;
    private final AuditService auditService;

    @Transactional
    public void createOrder(Order order) {
        orderRepo.save(order);
        auditService.log("CREATE_ORDER", order.getId());   // 独立事务，立即提交

        if (order.getAmount().signum() < 0) {
            throw new BizException(ErrorCode.PARAM_INVALID, "金额不能为负");   // 订单回滚，审计日志保留
        }
    }
}

@Service
@RequiredArgsConstructor
public class AuditService {

    private final AuditLogRepository auditRepo;

    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public void log(String action, Long targetId) {
        auditRepo.save(new AuditLog(action, targetId));
    }
}
```

`REQUIRES_NEW` 执行期间外层事务的连接被挂起但不归还，一次调用占用两个连接。高并发下如果所有连接都被外层事务占住，内层永远拿不到连接，会出现连接池耗尽式的「死锁」，直到获取连接超时。使用 `REQUIRES_NEW` 的链路要单独评估连接池大小，并避免在循环中调用。

### 4、NESTED：批量处理允许部分失败

`NESTED` 的方法**必须放在另一个 Bean 中**，同类调用不会创建保存点，内层失败时已写入的数据会随外层一起提交：

```java
@Slf4j
@Service
@RequiredArgsConstructor
public class OrderBatchService {

    private final OrderItemWriter itemWriter;   // 另一个 Bean，调用经过代理

    @Transactional
    public int batchCreate(List<Order> orders) {
        int success = 0;
        for (Order order : orders) {
            try {
                itemWriter.createSingle(order);   // 每条订单一个保存点
                success++;
            } catch (BizException e) {
                // 已回滚到保存点：这条订单的 save 和扣减都被撤销，外层事务继续
                log.warn("订单 {} 创建失败，跳过: {}", order.getOrderNo(), e.getMessage());
            }
        }
        return success;
    }
}

@Service
@RequiredArgsConstructor
public class OrderItemWriter {

    private final OrderRepository orderRepo;
    private final InventoryService inventoryService;

    @Transactional(propagation = Propagation.NESTED)
    public void createSingle(Order order) {
        orderRepo.save(order);
        inventoryService.deduct(order.getItems());   // 库存不足时抛 BizException
    }
}
```

`NESTED` 依赖 JDBC 3.0 的 `Savepoint`：`DataSourceTransactionManager` / `JdbcTransactionManager` 默认支持；`JpaTransactionManager` 默认不支持（`nestedTransactionAllowed = false`），开启后也只对 JDBC 操作有效，Hibernate 一级缓存中的变更不会回滚到保存点。注意方向性：内层回滚不影响外层，但**外层回滚时内层的工作一并回滚**。

### 5、rollback-only 与 UnexpectedRollbackException

一个常见的线上报错是 `UnexpectedRollbackException: Transaction silently rolled back because it has been marked as rollback-only`：

```java
@Transactional
public void placeOrder(Order order) {
    orderRepo.save(order);
    try {
        couponService.use(order.getCouponId());   // 另一个 Bean 的 REQUIRED 方法，内部抛了 RuntimeException
    } catch (BizException e) {
        log.warn("优惠券使用失败，按原价下单");     // 以为吞掉异常就能继续
    }
}   // 提交时发现事务已被标记为 rollback-only，整体回滚并抛 UnexpectedRollbackException
```

`couponService.use` 加入了外层事务，它抛出异常时 `TransactionInterceptor` 已经把**整个事务**标记为 rollback-only，外层再 catch 也救不回来。修复方式：内层改为 `NESTED` 或 `REQUIRES_NEW`；或者让内层不开启事务、只在外层控制；或者在调用前先做校验，不用异常控制流程。

---

## 三、隔离级别

`@Transactional(isolation = ...)` 只是把 JDBC 的隔离级别传给数据库，具体行为由数据库决定：

| `Isolation` 枚举 | 含义 |
|------------------|------|
| `DEFAULT`（默认） | 使用数据库默认级别：MySQL InnoDB 为 `REPEATABLE_READ`，PostgreSQL、Oracle 为 `READ_COMMITTED` |
| `READ_UNCOMMITTED` | 读未提交，可能脏读 |
| `READ_COMMITTED` | 读已提交，避免脏读 |
| `REPEATABLE_READ` | 可重复读，避免不可重复读 |
| `SERIALIZABLE` | 串行化 |

两点注意：

- 隔离级别**只在新建事务时生效**。以 `REQUIRED` 加入已有事务时，内层声明的隔离级别会被忽略（可开启事务管理器的 `validateExistingTransaction` 让不一致时直接报错）
- 各级别下的并发现象、MySQL 的 MVCC 与 next-key 锁（快照读靠 MVCC 避免幻读，当前读靠 next-key 锁）见 [MySQL 事务与锁](/database/1_mysql/5_topic_transaction)

---

## 四、回滚规则、只读与超时

### 1、回滚规则

默认规则：**`RuntimeException` 和 `Error` 回滚，受检异常（checked exception）提交**。这是沿用 EJB 的约定，但在大多数项目里受检异常同样意味着失败，按默认规则提交很危险。两种修正方式：

```java
// 方式一：逐个方法声明
@Transactional(rollbackFor = Exception.class)
public void importFile(MultipartFile file) throws IOException { /* ... */ }

// 方式二（Framework 6.2+，推荐）：全局把默认规则改为所有异常都回滚
@Configuration
@EnableTransactionManagement(rollbackOn = RollbackOn.ALL_EXCEPTIONS)
public class TransactionConfig {
}
```

Spring 参考文档建议：除非依赖「受检异常提交」的 EJB 式语义，否则应切换到 `ALL_EXCEPTIONS`，Kotlin 项目更应如此（没有受检异常的强制检查）。需要「某个业务异常不回滚」时用 `noRollbackFor` 精确排除。

### 2、只读事务

`@Transactional(readOnly = true)` 是一个提示，具体效果取决于事务管理器和数据库：

- JDBC 层调用 `Connection.setReadOnly(true)`，MySQL 会以只读事务执行，省去分配事务 ID 等开销
- JPA / Hibernate 下把 Session 的 FlushMode 设为 `MANUAL`，不做脏检查和 flush，大查询时节省内存和 CPU
- 读写分离的路由数据源（`AbstractRoutingDataSource`）通常以 `readOnly` 作为路由到从库的依据，此时要用 `LazyConnectionDataSourceProxy` 包装，保证路由发生在事务属性确定之后

只读事务中执行写操作的结果取决于数据库，不要依赖它做权限控制。

### 3、超时与多数据源

- `timeout`（秒）从事务开始计时，在下一次执行 SQL 时检查，超时抛 `TransactionTimedOutException`；它无法中断正在执行的慢 SQL 或方法中的非数据库耗时
- 多数据源时每个数据源一个事务管理器，`@Transactional` 默认使用 `@Primary` 的那个，访问其他数据源要显式指定：`@Transactional(transactionManager = "orderTxManager")`。一个 `@Transactional` 只能管理一个数据源，跨库一致性见 [分布式事务](/distributed/4_transaction)

---

## 五、编程式事务

声明式事务的边界是整个方法，需要更细的边界（例如方法中只有一段需要事务，前后是远程调用）时，用 `TransactionTemplate`：

```java
@Service
public class PayService {

    private final TransactionTemplate txTemplate;
    private final AccountRepository accountRepo;
    private final PayRecordRepository recordRepo;
    private final ApplicationEventPublisher events;

    public PayService(PlatformTransactionManager txManager,
                      AccountRepository accountRepo,
                      PayRecordRepository recordRepo,
                      ApplicationEventPublisher events) {
        // 本类专用的配置：自己 new 一个，不要用 @Bean 覆盖 Boot 自动配置的全局 TransactionTemplate
        this.txTemplate = new TransactionTemplate(txManager);
        this.txTemplate.setIsolationLevel(TransactionDefinition.ISOLATION_READ_COMMITTED);
        this.txTemplate.setTimeout(10);
        this.accountRepo = accountRepo;
        this.recordRepo = recordRepo;
        this.events = events;
    }

    public PayResult pay(PayRequest req) {
        PayResult result = txTemplate.execute(status -> {
            recordRepo.save(PayRecord.of(req));
            int updated = accountRepo.deduct(req.userId(), req.amount());   // UPDATE ... WHERE balance >= ?
            if (updated == 0) {
                status.setRollbackOnly();                 // 不抛异常也能回滚，支付记录随之撤销
                return PayResult.fail("余额不足");
            }
            events.publishEvent(new PaidEvent(req.orderId()));   // 通知在提交后由事务事件监听器发送
            return PayResult.success();
        });
        return Objects.requireNonNull(result);            // execute 的返回值可能为 null
    }
}
```

- `TransactionTemplate` 配置好后线程安全，可以作为字段复用；没有返回值时用 `executeWithoutResult`
- 回调中抛出 `RuntimeException` 或 `Error` 会回滚并原样抛出；受检异常无法直接抛出，需要包装
- 发短信、发 MQ、调用外部接口这类副作用不要放在事务中直接执行：事务回滚了副作用却撤不回来，提交前发出的通知还可能让下游读到未提交的数据。应在提交后执行，用 `@TransactionalEventListener`，见 [事件机制](./7_event)
- `TransactionSynchronizationManager.registerSynchronization` 可以注册 `afterCommit` 等回调，是事务事件的底层机制

---

## 六、事务失效的常见场景

| 场景 | 原因 | 解决 |
|------|------|------|
| 同类方法自调用 | `this.xxx()` 不经过代理 | 拆分 Bean 等，见 [AOP](./2_aop#六、自调用失效问题) |
| `private`、`final`、`static` 方法 | CGLIB 无法覆盖这些方法 | 改为可覆盖的方法。Framework 6.0 起 `protected` 与包可见方法在 CGLIB 代理（Boot 默认）下也能生效；JDK 接口代理仍要求方法是接口中的 public 方法 |
| 对象不是 Spring Bean | `new` 出来的对象没有代理 | 从容器注入 |
| 异常被 catch 吞掉 | 拦截器感知不到异常，照常提交 | 重新抛出，或调用 `TransactionAspectSupport.currentTransactionStatus().setRollbackOnly()` |
| 抛出受检异常 | 默认只回滚 `RuntimeException` 和 `Error` | `rollbackFor = Exception.class`，或 6.2+ 全局 `rollbackOn = ALL_EXCEPTIONS` |
| 内层 `REQUIRED` 方法抛异常、外层 catch | 整个事务已被标记 rollback-only | 内层改 `NESTED` / `REQUIRES_NEW`，见第二节 |
| 传播行为选错 | `SUPPORTS`、`NOT_SUPPORTED`、`NEVER` 可能以非事务方式执行 | 按语义选择，写操作用 `REQUIRED` |
| 多数据源用错事务管理器 | 默认使用 `@Primary` 的事务管理器 | `@Transactional(transactionManager = "...")` |
| 在其他线程中访问数据库 | 连接绑定在当前线程的 `ThreadLocal` 上 | 子线程中独立开启事务，或不拆线程；跨线程一致性需要业务补偿 |
| 在 `@PostConstruct` 中调用事务方法 | 此时代理尚未生成，且是 `this` 调用 | 在 `ApplicationReadyEvent` 监听器或 `SmartInitializingSingleton` 中通过代理调用 |
| 绕开 Spring 管理的连接 | 直接 `dataSource.getConnection()` 拿到的是另一个连接 | 通过 `JdbcTemplate`、MyBatis-Spring 或 `DataSourceUtils.getConnection` |
| 存储引擎不支持事务 | 如 MySQL MyISAM | 使用 InnoDB |

catch 后不想重新抛出、又需要回滚时，手动标记：

```java
@Transactional
public void process(Long taskId) {
    try {
        doProcess(taskId);
    } catch (BizException e) {
        log.error("任务 {} 处理失败", taskId, e);
        TransactionAspectSupport.currentTransactionStatus().setRollbackOnly();
    }
}
```

---

## 七、长事务与相关主题

- **长事务**：事务越长，持有行锁和连接的时间越长，undo log 无法清理，主从延迟增大。事务中不要做远程调用、文件处理、大循环；批量操作分批提交。排查用 `information_schema.innodb_trx` 找运行时间长的事务
- **事务事件**：在事务提交后执行副作用，见 [事件机制](./7_event)
- **响应式事务**：WebFlux / R2DBC 使用 `ReactiveTransactionManager` 或 `TransactionalOperator`，见 [WebFlux](./8_webflux)
- **分布式事务**：一个 `@Transactional` 只覆盖一个数据源，跨服务、跨库一致性用 TCC、Saga、本地消息表、事务消息，见 [分布式事务](/distributed/4_transaction)

---

## 小结

- `@Transactional` = 代理 + `TransactionInterceptor` + `PlatformTransactionManager` + 连接绑定到线程；不经过代理、换了线程、绕开 Spring 管理的连接都会脱离事务
- `REQUIRED` 共享一个事务，内层失败会让整个事务 rollback-only；`REQUIRES_NEW` 独立提交但占用两个连接；`NESTED` 基于保存点，必须放在另一个 Bean 中调用
- 隔离级别只在新建事务时生效，具体语义由数据库决定
- 默认只回滚 `RuntimeException` 和 `Error`；6.2+ 推荐 `@EnableTransactionManagement(rollbackOn = ALL_EXCEPTIONS)`
- 编程式事务自己 new `TransactionTemplate` 定制，不要用 `@Bean` 覆盖全局实例；副作用放到提交之后
- 6.0 起 `protected` / 包可见方法在 CGLIB 代理下也能开启事务，`private` / `final` / `static` 仍然不行

## 参考资料

- Spring Framework 参考文档 - 事务管理：[https://docs.spring.io/spring-framework/reference/data-access/transaction.html](https://docs.spring.io/spring-framework/reference/data-access/transaction.html)
- 使用 @Transactional：[https://docs.spring.io/spring-framework/reference/data-access/transaction/declarative/annotations.html](https://docs.spring.io/spring-framework/reference/data-access/transaction/declarative/annotations.html)
- 事务传播：[https://docs.spring.io/spring-framework/reference/data-access/transaction/declarative/tx-propagation.html](https://docs.spring.io/spring-framework/reference/data-access/transaction/declarative/tx-propagation.html)
- 编程式事务：[https://docs.spring.io/spring-framework/reference/data-access/transaction/programmatic.html](https://docs.spring.io/spring-framework/reference/data-access/transaction/programmatic.html)

> 下一篇：[Cache 抽象](./5_cache) —— 同样基于 AOP 的缓存注解，以及 CacheManager、Redis 序列化与常见陷阱。
