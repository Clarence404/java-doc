# 数据访问

> 参考资料：
> * Spring Data JPA：[https://docs.spring.io/spring-data/jpa/docs/current/reference/html/](https://docs.spring.io/spring-data/jpa/docs/current/reference/html/)
> * MyBatis-Plus：[https://baomidou.com/](https://baomidou.com/)

## 一、ORM 框架选型

| 框架 | 风格 | 适用场景 |
|------|------|---------|
| Spring Data JPA | 声明式，自动生成 SQL | 标准 CRUD，快速开发 |
| MyBatis | 手写 SQL，灵活可控 | 复杂查询，性能敏感 |
| MyBatis-Plus | MyBatis 增强，内置 CRUD | 兼顾灵活与效率（国内主流） |

---

## 二、Spring Data JPA

```xml
<dependency>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-data-jpa</artifactId>
</dependency>
```

### 2.1 实体类

```java
@Entity
@Table(name = "orders")
@Data
@NoArgsConstructor
@AllArgsConstructor
@EntityListeners(AuditingEntityListener.class)
public class Order {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(nullable = false, length = 50)
    private String orderNo;

    @ManyToOne(fetch = FetchType.LAZY)
    @JoinColumn(name = "user_id")
    private User user;

    @OneToMany(mappedBy = "order", cascade = CascadeType.ALL, orphanRemoval = true)
    private List<OrderItem> items = new ArrayList<>();

    @Enumerated(EnumType.STRING)
    private OrderStatus status;

    @Column(precision = 10, scale = 2)
    private BigDecimal totalAmount;

    @CreatedDate
    private LocalDateTime createdAt;

    @LastModifiedDate
    private LocalDateTime updatedAt;
}
```

```yaml
spring:
  jpa:
    hibernate:
      ddl-auto: validate    # 生产用 validate，开发用 update
    show-sql: false
    properties:
      hibernate:
        format_sql: true
        dialect: org.hibernate.dialect.MySQLDialect
```

### 2.2 Repository 接口

```java
public interface OrderRepository extends JpaRepository<Order, Long> {

    // 方法名派生查询
    List<Order> findByUserId(Long userId);
    List<Order> findByStatusAndCreatedAtBetween(OrderStatus status,
                                                 LocalDateTime start,
                                                 LocalDateTime end);
    Optional<Order> findByOrderNo(String orderNo);
    boolean existsByOrderNo(String orderNo);
    long countByStatus(OrderStatus status);

    // JPQL 查询
    @Query("SELECT o FROM Order o WHERE o.user.id = :userId AND o.status = :status")
    List<Order> findByUserAndStatus(@Param("userId") Long userId,
                                    @Param("status") OrderStatus status);

    // 原生 SQL（nativeQuery = true）
    @Query(value = "SELECT * FROM orders WHERE total_amount > :amount LIMIT :limit",
           nativeQuery = true)
    List<Order> findHighValueOrders(@Param("amount") BigDecimal amount,
                                    @Param("limit") int limit);

    // 更新语句
    @Modifying
    @Transactional
    @Query("UPDATE Order o SET o.status = :status WHERE o.id = :id")
    int updateStatus(@Param("id") Long id, @Param("status") OrderStatus status);

    // 分页 + 排序
    Page<Order> findByStatus(OrderStatus status, Pageable pageable);
}
```

```java
// 使用
@Service
@RequiredArgsConstructor
public class OrderService {

    private final OrderRepository orderRepo;

    public Page<OrderVO> list(OrderStatus status, int page, int size) {
        Pageable pageable = PageRequest.of(page - 1, size, Sort.by("createdAt").descending());
        return orderRepo.findByStatus(status, pageable).map(this::toVO);
    }

    // 开启 JPA Auditing
    @Bean
    public AuditorAware<Long> auditorAware() {
        return () -> Optional.ofNullable(SecurityContext.getCurrentUserId());
    }
}
```

---

## 三、MyBatis-Plus

```xml
<dependency>
    <groupId>com.baomidou</groupId>
    <artifactId>mybatis-plus-spring-boot3-starter</artifactId>
    <version>3.5.7</version>
</dependency>
```

```yaml
mybatis-plus:
  mapper-locations: classpath*:mapper/**/*.xml
  type-aliases-package: com.example.entity
  configuration:
    map-underscore-to-camel-case: true
    log-impl: org.apache.ibatis.logging.nologging.NoLoggingImpl
  global-config:
    db-config:
      id-type: auto
      logic-delete-field: deleted
      logic-delete-value: 1
      logic-not-delete-value: 0
```

### 3.1 实体类

```java
@Data
@TableName("users")
public class User {

    @TableId(type = IdType.AUTO)
    private Long id;

    private String username;
    private String password;

    @TableField(fill = FieldFill.INSERT)
    private LocalDateTime createdAt;

    @TableField(fill = FieldFill.INSERT_UPDATE)
    private LocalDateTime updatedAt;

    @TableLogic
    private Integer deleted;   // 逻辑删除

    @Version
    private Integer version;   // 乐观锁
}
```

### 3.2 Mapper 接口

```java
@Mapper
public interface UserMapper extends BaseMapper<User> {
    // BaseMapper 已内置 insert / deleteById / updateById / selectById 等
    // 自定义复杂 SQL 用 XML 或注解
    @Select("SELECT * FROM users WHERE phone = #{phone}")
    Optional<User> findByPhone(String phone);
}
```

### 3.3 Service 层

```java
@Service
public class UserServiceImpl extends ServiceImpl<UserMapper, User> implements UserService {

    public Page<User> listByCondition(String username, int page, int size) {
        // LambdaQueryWrapper：类型安全，防 SQL 注入
        LambdaQueryWrapper<User> wrapper = Wrappers.<User>lambdaQuery()
            .like(StringUtils.isNotBlank(username), User::getUsername, username)
            .eq(User::getDeleted, 0)
            .orderByDesc(User::getCreatedAt);

        return page(new Page<>(page, size), wrapper);
    }

    public boolean updatePhone(Long userId, String phone) {
        return lambdaUpdate()
            .set(User::getPhone, phone)
            .set(User::getUpdatedAt, LocalDateTime.now())
            .eq(User::getId, userId)
            .update();
    }

    public void batchInsert(List<User> users) {
        saveBatch(users, 500);   // 每批 500 条
    }
}
```

### 3.4 自动填充

```java
@Component
public class AutoFillHandler implements MetaObjectHandler {

    @Override
    public void insertFill(MetaObject metaObject) {
        this.strictInsertFill(metaObject, "createdAt", LocalDateTime.class, LocalDateTime.now());
        this.strictInsertFill(metaObject, "updatedAt", LocalDateTime.class, LocalDateTime.now());
    }

    @Override
    public void updateFill(MetaObject metaObject) {
        this.strictUpdateFill(metaObject, "updatedAt", LocalDateTime.class, LocalDateTime.now());
    }
}
```

---

## 四、事务管理

```java
@Service
@RequiredArgsConstructor
public class OrderService {

    @Transactional(rollbackFor = Exception.class)
    public OrderVO createOrder(OrderCreateDTO dto) {
        Order order = buildOrder(dto);
        orderMapper.insert(order);
        inventoryService.deduct(dto.getItems());   // 扣减库存
        return toVO(order);
    }

    // 只读事务（查询优化）
    @Transactional(readOnly = true)
    public OrderVO getById(Long id) {
        return toVO(orderMapper.selectById(id));
    }
}
```

> 事务传播行为详解见 → [Spring 事务管理](/spring/4_transaction)

---

## 五、多数据源

```xml
<dependency>
    <groupId>com.baomidou</groupId>
    <artifactId>dynamic-datasource-spring-boot3-starter</artifactId>
    <version>4.3.1</version>
</dependency>
```

```yaml
spring:
  datasource:
    dynamic:
      primary: master
      strict: false
      datasource:
        master:
          url: jdbc:mysql://master:3306/db
          username: root
          password: xxx
        slave:
          url: jdbc:mysql://slave:3306/db
          username: root
          password: xxx
```

```java
@Service
public class UserService {

    @DS("master")
    @Transactional
    public void createUser(User user) { ... }

    @DS("slave")
    public List<User> listAll() { ... }
}
```

---

## 六、分页

```java
// JPA 分页
Pageable pageable = PageRequest.of(0, 20, Sort.by("createdAt").descending());
Page<User> page = userRepo.findAll(pageable);
page.getContent();    // 当前页数据
page.getTotalElements();  // 总记录数
page.getTotalPages();     // 总页数

// MyBatis-Plus 分页（需注册插件）
@Bean
public MybatisPlusInterceptor mybatisPlusInterceptor() {
    MybatisPlusInterceptor interceptor = new MybatisPlusInterceptor();
    interceptor.addInnerInterceptor(new PaginationInnerInterceptor(DbType.MYSQL));
    interceptor.addInnerInterceptor(new OptimisticLockerInnerInterceptor()); // 乐观锁
    return interceptor;
}

Page<User> result = userMapper.selectPage(new Page<>(1, 20), wrapper);
```
