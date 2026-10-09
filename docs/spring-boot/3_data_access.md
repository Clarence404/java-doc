---
description: 持久化选型、JdbcClient、JPA 实体与 Repository、MyBatis-Plus、事务、多数据源、分页
---

# 数据访问

> **本篇目标**：能按场景在 JdbcClient、Spring Data JPA、MyBatis-Plus 之间做选择；写出没有反模式的 JPA 实体与 Repository；在 Boot 4 上正确引入 MyBatis-Plus 与多数据源组件；理解 Boot 自动装配的事务管理器、多数据源下事务与路由的冲突，以及两种分页的差异。
>
> **前置阅读**：[事务管理](/spring/4_transaction)、[MySQL 基础](/database/1_mysql/0_overview)

---

## 一、持久化方案选型

| 方案 | 风格 | 适用场景 |
|------|------|---------|
| `JdbcClient`（Framework 6.1+） | 手写 SQL，Fluent API，结果映射到 record | 报表、统计、少量表的轻量服务，或在 ORM 项目中补充复杂查询 |
| Spring Data JDBC | 聚合根映射，无懒加载、无持久化上下文 | 领域模型清晰、想要 Repository 但不想要 JPA 复杂性 |
| Spring Data JPA（Hibernate 7） | 对象映射，派生查询，自动生成 SQL | 标准 CRUD、领域模型较复杂、团队熟悉 JPA |
| MyBatis | 手写 SQL（XML / 注解），完全可控 | 复杂 SQL、性能敏感、DBA 参与 SQL 审核 |
| MyBatis-Plus | MyBatis 增强，内置单表 CRUD 与条件构造器 | 国内项目主流，单表操作多、复杂查询仍写 XML |

一个项目里可以组合使用，例如 JPA 负责写模型、`JdbcClient` 负责报表查询，它们共用同一个数据源和事务管理器。ORM 框架本身的原理与对比见 [ORM 框架](/database/3_relational/2_orm_framework)。

---

## 二、数据源与 JdbcClient

### 1、数据源与连接池

```yaml
spring:
  datasource:
    url: jdbc:mysql://localhost:3306/shop?rewriteBatchedStatements=true
    username: shop_app
    password: ${DB_PASSWORD}          # 密钥不写进配置文件
    hikari:
      maximum-pool-size: 20
      minimum-idle: 20                # 与最大值相同，固定大小的池更稳定
      connection-timeout: 3s          # 等待连接的最长时间
      max-lifetime: 30m               # 小于数据库 wait_timeout
```

Boot 默认使用 HikariCP，引入 `spring-boot-starter-jdbc`（JPA / MyBatis 的 starter 已间接包含）即自动配置 `DataSource`、`JdbcTemplate`、`JdbcClient` 与事务管理器。连接池大小的估算与参数含义见 [数据库连接池](/database/5_practice/3_connection_pool)。

### 2、JdbcClient

```java
public record OrderSummary(Long id, String orderNo, BigDecimal totalAmount) {}

@Repository
@RequiredArgsConstructor
public class OrderQueryDao {

    private final JdbcClient jdbcClient;

    public Optional<OrderSummary> findSummary(long id) {
        return jdbcClient.sql("SELECT id, order_no, total_amount FROM orders WHERE id = :id")
            .param("id", id)
            .query(OrderSummary.class)          // 列名下划线自动映射到 record 组件
            .optional();
    }

    public int cancelExpired(LocalDateTime deadline) {
        return jdbcClient.sql("UPDATE orders SET status = 'CANCELLED' WHERE status = 'PENDING' AND created_at < :deadline")
            .param("deadline", deadline)
            .update();
    }
}
```

---

## 三、Spring Data JPA

```xml
<dependency>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-data-jpa</artifactId>
</dependency>
```

### 1、实体类

```java
@Entity
@Table(name = "orders")
@Getter
@Setter
@NoArgsConstructor(access = AccessLevel.PROTECTED)   // JPA 需要无参构造，但不对外暴露
@EntityListeners(AuditingEntityListener.class)
public class Order {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(nullable = false, length = 50, unique = true)
    private String orderNo;

    @ManyToOne(fetch = FetchType.LAZY, optional = false)
    @JoinColumn(name = "customer_id")
    private Customer customer;                     // 同包下的另一个实体

    @OneToMany(mappedBy = "order", cascade = CascadeType.ALL, orphanRemoval = true)
    private List<OrderItem> items = new ArrayList<>();

    @Enumerated(EnumType.STRING)
    @Column(nullable = false, length = 20)
    private OrderStatus status;

    @Column(precision = 12, scale = 2)
    private BigDecimal totalAmount;

    @CreatedBy
    private String createdBy;

    @CreatedDate
    private LocalDateTime createdAt;

    @LastModifiedDate
    private LocalDateTime updatedAt;

    public Order(String orderNo, Customer customer) {
        this.orderNo = orderNo;
        this.customer = customer;
        this.status = OrderStatus.PENDING;
    }

    // 双向关联由一方统一维护，避免两边不一致
    public void addItem(OrderItem item) {
        items.add(item);
        item.setOrder(this);
    }

    // 基于 id 的 equals：新建实体 id 为 null 时只与自身相等
    @Override
    public boolean equals(Object o) {
        if (this == o) return true;
        if (!(o instanceof Order other)) return false;
        return id != null && id.equals(other.getId());
    }

    // 固定值：保证实体持久化前后（id 从 null 变为有值）hashCode 不变
    @Override
    public int hashCode() {
        return getClass().hashCode();
    }
}
```

**JPA 实体不要用 `@Data`**：

| `@Data` 生成的方法 | 问题 |
|-------------------|------|
| `toString()` | 访问懒加载关联，事务外触发 `LazyInitializationException`；双向关联互相调用导致 `StackOverflowError` |
| `equals()` / `hashCode()` | 基于全部字段：遍历集合触发额外查询；实体放入 `HashSet` 后字段变化就再也找不到 |
| 全部 setter | `id`、审计字段也能被随意修改，破坏封装 |

用 `@Getter` / `@Setter` + 手写基于 id 的 `equals`，需要 `toString` 时只包含基本字段。

```yaml
spring:
  jpa:
    open-in-view: false          # 默认 true 会在整个请求期间占用连接，并掩盖懒加载问题
    hibernate:
      ddl-auto: validate         # 生产只校验；表结构变更交给 Flyway
    properties:
      hibernate:
        jdbc:
          batch_size: 50
        order_inserts: true
```

方言（dialect）由 Hibernate 6+ 根据数据库元数据自动识别，**不要再手动配置 `hibernate.dialect`**，显式指定反而会收到废弃告警。

### 2、Repository

```java
public interface OrderRepository extends JpaRepository<Order, Long> {

    // 方法名派生查询
    Optional<Order> findByOrderNo(String orderNo);
    boolean existsByOrderNo(String orderNo);
    long countByStatus(OrderStatus status);
    List<Order> findByStatusAndCreatedAtBetween(OrderStatus status,
                                                LocalDateTime start,
                                                LocalDateTime end);

    // 分页 + 排序
    Page<Order> findByStatus(OrderStatus status, Pageable pageable);

    // 一次查出订单与明细，避免 N+1
    @EntityGraph(attributePaths = "items")
    Optional<Order> findWithItemsById(Long id);

    // JPQL
    @Query("SELECT o FROM Order o WHERE o.customer.id = :customerId AND o.status = :status")
    List<Order> findByCustomerAndStatus(@Param("customerId") Long customerId,
                                        @Param("status") OrderStatus status);

    // 批量更新：绕过持久化上下文，执行后清空一级缓存，避免读到旧对象
    @Modifying(clearAutomatically = true)
    @Query("UPDATE Order o SET o.status = :status WHERE o.id = :id")
    int updateStatus(@Param("id") Long id, @Param("status") OrderStatus status);
}
```

```java
@Service
@RequiredArgsConstructor
public class OrderQueryService {

    private final OrderRepository orderRepository;

    @Transactional(readOnly = true)
    public Page<OrderVO> list(OrderStatus status, int page, int size) {
        // PageRequest 页码从 0 开始，前端传 1 开始时要减 1
        Pageable pageable = PageRequest.of(page - 1, size, Sort.by("createdAt").descending());
        return orderRepository.findByStatus(status, pageable).map(OrderVO::from);
    }
}
```

`@Modifying` 方法必须在事务中执行，事务边界放在 Service 层，不要在 Repository 上随手加 `@Transactional`。

### 3、审计

```java
@Configuration
@EnableJpaAuditing                     // 不开启时 @CreatedDate 等注解不生效
public class JpaAuditingConfig {

    @Bean
    public AuditorAware<String> auditorAware() {
        return () -> Optional.ofNullable(SecurityContextHolder.getContext().getAuthentication())
            .filter(auth -> auth.isAuthenticated() && !(auth instanceof AnonymousAuthenticationToken))
            .map(Authentication::getName);
    }
}
```

### 4、常见问题

| 问题 | 原因 | 处理 |
|------|------|------|
| `LazyInitializationException` | 事务结束后访问懒加载关联 | 在事务内用 fetch join / `@EntityGraph` 取齐数据，或直接查询 DTO 投影；不要靠开启 `open-in-view` 掩盖 |
| N+1 查询 | 遍历列表时逐个触发懒加载 | `@EntityGraph`、`JOIN FETCH`、`hibernate.default_batch_fetch_size` |
| 批量插入很慢 | `IDENTITY` 主键让 Hibernate 无法批量插入 | 大批量写入改用 `JdbcClient` / `JdbcTemplate.batchUpdate`，或使用序列 / 雪花 ID |
| `save()` 多发了一条查询 | 实体 id 已有值时 `save()` 走 `merge`，先查后更 | 新建实体不要手动设 id，或实现 `Persistable#isNew` |
| 只读查询也有脏检查开销 | 实体被持久化上下文跟踪 | `@Transactional(readOnly = true)`，或查询 DTO 投影 |

---

## 四、MyBatis-Plus

### 1、依赖

MyBatis-Plus 从 3.5.13 起提供 Boot 4 专用 starter；3.5.9 起分页插件依赖的 jsqlparser 拆成了独立模块，不引入则分页插件无法使用：

```xml
<dependencyManagement>
    <dependencies>
        <dependency>
            <groupId>com.baomidou</groupId>
            <artifactId>mybatis-plus-bom</artifactId>
            <version>3.5.17</version>
            <type>pom</type>
            <scope>import</scope>
        </dependency>
    </dependencies>
</dependencyManagement>

<dependencies>
    <dependency>
        <groupId>com.baomidou</groupId>
        <!-- Boot 4；Boot 3.x 为 mybatis-plus-spring-boot3-starter -->
        <artifactId>mybatis-plus-spring-boot4-starter</artifactId>
    </dependency>
    <dependency>
        <groupId>com.baomidou</groupId>
        <!-- 分页插件需要；JDK 8 项目用 mybatis-plus-jsqlparser-4.9 -->
        <artifactId>mybatis-plus-jsqlparser</artifactId>
    </dependency>
</dependencies>
```

```yaml
mybatis-plus:
  mapper-locations: classpath*:mapper/**/*.xml
  configuration:
    map-underscore-to-camel-case: true
  global-config:
    db-config:
      id-type: auto
      logic-delete-field: deleted
      logic-delete-value: 1
      logic-not-delete-value: 0
```

### 2、实体与 Mapper

```java
@Data                                   // 无关联映射的单表实体，用 @Data 没有 JPA 那些问题
@TableName("users")
public class User {

    @TableId(type = IdType.AUTO)
    private Long id;

    private String username;
    private String phone;
    private Integer status;             // 1 正常，0 禁用

    @TableField(fill = FieldFill.INSERT)
    private LocalDateTime createdAt;

    @TableField(fill = FieldFill.INSERT_UPDATE)
    private LocalDateTime updatedAt;

    @TableLogic
    private Integer deleted;            // 逻辑删除：查询时自动追加 deleted = 0

    @Version
    private Integer version;            // 乐观锁，需注册 OptimisticLockerInnerInterceptor
}

@Mapper
public interface UserMapper extends BaseMapper<User> {

    // 复杂 SQL 写在 XML 或注解里；#{} 是预编译参数，${} 是字符串拼接，有注入风险
    @Select("SELECT * FROM users WHERE phone = #{phone} AND deleted = 0")
    Optional<User> findByPhone(String phone);
}
```

### 3、Service 层

```java
public interface UserService extends IService<User> {
    Page<User> listByCondition(String username, int page, int size);
    boolean updatePhone(Long userId, String phone);
}

@Service
public class UserServiceImpl extends ServiceImpl<UserMapper, User> implements UserService {

    @Override
    public Page<User> listByCondition(String username, int page, int size) {
        // Lambda 条件构造器：类型安全，避免硬编码列名；逻辑删除条件由 @TableLogic 自动追加
        LambdaQueryWrapper<User> wrapper = Wrappers.<User>lambdaQuery()
            .like(StringUtils.isNotBlank(username), User::getUsername, username)
            .orderByDesc(User::getCreatedAt);
        return page(new Page<>(page, size), wrapper);   // MP 页码从 1 开始
    }

    @Override
    public boolean updatePhone(Long userId, String phone) {
        return lambdaUpdate()
            .set(User::getPhone, phone)
            .eq(User::getId, userId)
            .update();                                   // updatedAt 由自动填充处理
    }
}
```

`StringUtils` 为 `com.baomidou.mybatisplus.core.toolkit.StringUtils`。`saveBatch` 默认按 1000 条一批提交，MySQL 需要在 URL 上加 `rewriteBatchedStatements=true` 才会真正合并成批量 INSERT。

### 4、自动填充与插件

```java
@Component
public class AutoFillHandler implements MetaObjectHandler {

    @Override
    public void insertFill(MetaObject metaObject) {
        LocalDateTime now = LocalDateTime.now();
        this.strictInsertFill(metaObject, "createdAt", LocalDateTime.class, now);
        this.strictInsertFill(metaObject, "updatedAt", LocalDateTime.class, now);
    }

    @Override
    public void updateFill(MetaObject metaObject) {
        this.strictUpdateFill(metaObject, "updatedAt", LocalDateTime.class, LocalDateTime.now());
    }
}

@Configuration
public class MybatisPlusConfig {

    @Bean
    public MybatisPlusInterceptor mybatisPlusInterceptor() {
        MybatisPlusInterceptor interceptor = new MybatisPlusInterceptor();
        interceptor.addInnerInterceptor(new PaginationInnerInterceptor(DbType.MYSQL));  // 需要 mybatis-plus-jsqlparser
        interceptor.addInnerInterceptor(new OptimisticLockerInnerInterceptor());
        interceptor.addInnerInterceptor(new BlockAttackInnerInterceptor());             // 拦截无 WHERE 的全表更新 / 删除
        return interceptor;
    }
}
```

---

## 五、事务装配

事务的传播行为、隔离级别与失效场景在 [事务管理](/spring/4_transaction) 详细展开，这里只讲 Boot 做了什么：

- **不需要 `@EnableTransactionManagement`**，Boot 自动开启注解事务
- **事务管理器按依赖自动选择**：只有 JDBC / MyBatis 时是 `JdbcTransactionManager`；引入 JPA 后是 `JpaTransactionManager`，它同样管理同一数据源上的 JDBC / MyBatis 操作，两者可以混用在一个事务里
- 全局默认超时：`spring.transaction.default-timeout=30s`；`spring.transaction.rollback-on-commit-failure=true` 让提交失败时也执行回滚
- 自己声明多个 `DataSource` 时，Boot 只会为唯一或标了 `@Primary` 的那个数据源创建事务管理器；其他数据源要自己声明事务管理器，并用 `@Transactional("orderTransactionManager")` 指定

```java
@Service
@RequiredArgsConstructor
public class OrderAppService {

    private final OrderMapper orderMapper;
    private final InventoryMapper inventoryMapper;

    @Transactional(rollbackFor = Exception.class)   // 默认只回滚 RuntimeException 和 Error
    public Long createOrder(Order order, List<OrderItem> items) {
        orderMapper.insert(order);
        for (OrderItem item : items) {
            int rows = inventoryMapper.deduct(item.getSkuId(), item.getQuantity());
            if (rows == 0) {
                throw new BusinessException("库存不足: " + item.getSkuId());  // 运行时异常，触发回滚
            }
        }
        return order.getId();
    }
}
```

最常见的失效原因是同类方法自调用（不经过代理），机制见 [AOP](/spring/2_aop)。

---

## 六、多数据源

### 1、dynamic-datasource

```xml
<dependency>
    <groupId>com.baomidou</groupId>
    <!-- Boot 4；Boot 3.x 为 dynamic-datasource-spring-boot3-starter -->
    <artifactId>dynamic-datasource-spring-boot4-starter</artifactId>
    <version>4.5.0</version>
</dependency>
```

```yaml
spring:
  datasource:
    dynamic:
      primary: master
      strict: true                 # 找不到数据源时报错，而不是悄悄回落到 primary
      datasource:
        master:
          url: jdbc:mysql://master:3306/shop
          username: shop_app
          password: ${DB_PASSWORD}
        slave_1:                   # 下划线前的 slave 为分组名，@DS("slave") 在组内负载均衡
          url: jdbc:mysql://slave1:3306/shop
          username: shop_ro
          password: ${DB_RO_PASSWORD}
```

```java
@Service
@RequiredArgsConstructor
public class UserQueryService {

    private final UserMapper userMapper;

    @DS("slave")
    public List<User> listActive() {
        return userMapper.selectList(Wrappers.<User>lambdaQuery().eq(User::getStatus, 1));
    }
}
```

### 2、路由原理与事务陷阱

![dynamic-datasource 的路由过程](../assets/spring-boot/dynamic-datasource.svg)

- **外层已开启 `@Transactional` 时，内层 `@DS` 切换无效**：事务开始时连接已经从 primary 取出并绑定到当前线程，后续操作都复用这个连接。读写分离时，「在写事务里调一个 `@DS("slave")` 的查询」实际上查的是主库
- 一个方法里需要操作多个数据源时，`@DSTransactional` 提供本地多数据源事务，但它不是真正的分布式事务，提交阶段部分失败仍会不一致；跨库强一致写入见 [分布式事务](/distributed/4_transaction)
- `@DS` 依赖 Spring AOP 代理，同类方法自调用时注解不生效
- 从库存在复制延迟，「写完立即读」的场景要强制读主库；读写分离与分库分表的整体方案见 [分库分表与中间件](/database/5_practice/2_sharding)

---

## 七、分页

| 对比 | Spring Data（JPA / JDBC） | MyBatis-Plus |
|------|--------------------------|--------------|
| 页码起点 | **0** | **1** |
| 请求对象 | `PageRequest.of(page, size, sort)` | `new Page<>(current, size)` |
| 总数查询 | 返回 `Page` 时自动执行 count；用 `Slice` 可省掉 | 默认执行 count；`page.setSearchCount(false)` 关闭 |
| 前置条件 | 无 | 注册 `PaginationInnerInterceptor` 并引入 `mybatis-plus-jsqlparser` |

```java
// Spring Data：页码从 0 开始
Page<Order> p1 = orderRepository.findByStatus(OrderStatus.PAID,
    PageRequest.of(0, 20, Sort.by("createdAt").descending()));
p1.getContent();          // 当前页数据
p1.getTotalElements();    // 总记录数

// MyBatis-Plus：页码从 1 开始
Page<User> p2 = userMapper.selectPage(new Page<>(1, 20),
    Wrappers.<User>lambdaQuery().orderByDesc(User::getCreatedAt));
p2.getRecords();
p2.getTotal();
```

- Controller 直接接收 `Pageable` 参数时，可设置 `spring.data.web.pageable.one-indexed-parameters=true` 让前端从 1 开始传
- 不要把 Spring Data 的 `PageImpl` 直接作为接口返回值序列化，它的 JSON 结构不稳定；转换成自定义分页 DTO，或使用 `@EnableSpringDataWebSupport(pageSerializationMode = VIA_DTO)`
- 大表深分页（`LIMIT 1000000, 20`）会扫描并丢弃大量行，改用基于上一页最后一个 id 的游标分页

---

## 小结

- 选型：轻量查询用 `JdbcClient`，标准 CRUD 用 JPA，复杂 SQL 用 MyBatis / MyBatis-Plus，可以在一个项目中组合
- JPA 实体不用 `@Data`，用 `@Getter` / `@Setter` + 基于 id 的 `equals`；关闭 `open-in-view`，不手动配置方言
- `@Modifying` 加 `clearAutomatically = true`，事务边界放在 Service 层；审计需要 `@EnableJpaAuditing` 与 `AuditorAware`
- MyBatis-Plus 在 Boot 4 使用 `mybatis-plus-spring-boot4-starter`；3.5.9 起分页插件需要额外引入 `mybatis-plus-jsqlparser`；`@TableLogic` 会自动追加逻辑删除条件
- Boot 自动开启注解事务并按依赖选择事务管理器，多数据源时需要显式指定事务管理器
- dynamic-datasource 在 Boot 4 使用 `dynamic-datasource-spring-boot4-starter`；外层事务开启后 `@DS` 切换无效，跨库写入需要分布式事务
- Spring Data 页码从 0 开始，MyBatis-Plus 从 1 开始；深分页改用游标

## 参考资料

- Spring Boot SQL Databases：[https://docs.spring.io/spring-boot/reference/data/sql.html](https://docs.spring.io/spring-boot/reference/data/sql.html)
- Spring Data JPA：[https://docs.spring.io/spring-data/jpa/reference/](https://docs.spring.io/spring-data/jpa/reference/)
- JdbcClient：[https://docs.spring.io/spring-framework/reference/data-access/jdbc/core.html](https://docs.spring.io/spring-framework/reference/data-access/jdbc/core.html)
- MyBatis-Plus：[https://baomidou.com/](https://baomidou.com/)
- dynamic-datasource：[https://github.com/baomidou/dynamic-datasource](https://github.com/baomidou/dynamic-datasource)

> 下一篇：[数据库版本迁移](./4_flyway) —— 用 Flyway 或 Liquibase 把表结构变更纳入版本管理，并安全地随应用发布。
