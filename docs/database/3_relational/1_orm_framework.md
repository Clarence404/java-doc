# Orm Frameworks

## 一、Mybatis

### 1、Mybatis的缓存机制

MyBatis 内置两级缓存机制：

#### 一级缓存（SqlSession 级别）

- 默认**开启**，作用域为同一个 `SqlSession`
- 同一个 SqlSession 内，相同的查询（SQL + 参数相同）直接返回缓存，不再发 SQL
- 以下情况一级缓存失效：执行了 INSERT/UPDATE/DELETE、调用了 `sqlSession.clearCache()`、SqlSession 关闭

```java
// 一级缓存生效示例（Spring 中每个事务共享同一 SqlSession）
@Transactional
public void demo() {
    User u1 = userMapper.selectById(1);  // 查询数据库
    User u2 = userMapper.selectById(1);  // 命中一级缓存，不发 SQL
    // u1 == u2（同一对象引用）
}
```

> Spring 集成 MyBatis 时，每个方法调用默认新建 SqlSession（非事务），一级缓存在方法结束后即失效，实际效果有限。**开启 `@Transactional` 后**，同一事务内共用 SqlSession，一级缓存才真正生效。

#### 二级缓存（Mapper/namespace 级别）

- 默认**关闭**，需手动开启
- 跨 SqlSession 共享，同一个 namespace 下的查询可命中
- 数据存储在 namespace 对应的 Cache 对象中，SqlSession **关闭或提交**后数据才放入二级缓存

**开启方式**：

```xml
<!-- mybatis-config.xml 全局开关 -->
<settings>
  <setting name="cacheEnabled" value="true"/>
</settings>

<!-- 对应的 Mapper XML 中声明 -->
<cache eviction="LRU" flushInterval="60000" size="512" readOnly="true"/>
```

或注解方式：

```java
@CacheNamespace(eviction = LruCache.class, flushInterval = 60000, size = 512, readWrite = false)
public interface UserMapper { ... }
```

**二级缓存缺点**：
- 多表关联查询时，某个表更新只会清空本 namespace 的缓存，关联表的缓存不会清，容易出现脏数据
- 分布式环境下各节点缓存不一致

> **工程建议**：二级缓存适用于数据几乎不变的字典表；业务表的缓存建议用 Redis 在应用层实现，不要依赖 MyBatis 二级缓存。

### 2、Mybatis分页原理

#### 逻辑分页（RowBounds，不推荐）

MyBatis 内置 `RowBounds` 实现分页：**先全量查询，再内存截取**。数据量大时 OOM 风险极高。

```java
// 内存分页：查出所有数据再截取，仅适合极小数据量
List<User> users = sqlSession.selectList("selectAll", null, new RowBounds(100, 10));
```

#### 物理分页（PageHelper，推荐）

PageHelper 通过 MyBatis **拦截器（Interceptor）** 拦截 `StatementHandler.prepare` 阶段，在执行前自动拼接 `LIMIT` 子句，并额外发一次 `COUNT(*)` 查询获取总数。

```xml
<dependency>
  <groupId>com.github.pagehelper</groupId>
  <artifactId>pagehelper-spring-boot-starter</artifactId>
  <version>1.4.7</version>
</dependency>
```

```java
// PageHelper 使用（必须紧跟 startPage，中间不能有其他查询）
PageHelper.startPage(1, 10);
List<User> list = userMapper.selectAll();
PageInfo<User> pageInfo = new PageInfo<>(list);
// pageInfo.getTotal()、pageInfo.getList()、pageInfo.getPages()
```

**原理**：`startPage()` 将分页参数存入 `ThreadLocal`，拦截器在 SQL 执行前取出并拼接 `LIMIT`，执行后清空 ThreadLocal。

#### MyBatis-Plus IPage

```java
Page<User> page = new Page<>(1, 10);
IPage<User> result = userMapper.selectPage(page, 
    new LambdaQueryWrapper<User>().eq(User::getStatus, 1));
result.getRecords(); // 当前页数据
result.getTotal();   // 总数
```

### 3、Mybatis工作原理

MyBatis 核心工作流程分为**初始化阶段**和**执行阶段**：

#### 初始化阶段（应用启动时）

```
读取 mybatis-config.xml + Mapper XML（或注解）
  ↓
SqlSessionFactoryBuilder.build()
  ↓
XMLConfigBuilder 解析配置 → Configuration 对象（全局唯一）
  ↓
XMLMapperBuilder 解析 Mapper → MappedStatement（每条 SQL 对应一个）
  ↓
构建 SqlSessionFactory（DefaultSqlSessionFactory）
```

#### 执行阶段（每次 SQL 调用）

```
SqlSessionFactory.openSession()
  ↓
创建 SqlSession（DefaultSqlSession）+ 创建 Executor
  ↓
调用 Mapper 接口方法
  ↓
MapperProxy.invoke() → MapperMethod.execute()
  ↓
Executor.query() / update()
  ↓
StatementHandler 创建 PreparedStatement
  ↓
ParameterHandler 设置参数（调用 TypeHandler）
  ↓
执行 JDBC，获取 ResultSet
  ↓
ResultSetHandler 映射结果（调用 TypeHandler）
  ↓
返回 Java 对象
```

#### 核心组件职责

| 组件 | 职责 |
|------|------|
| `SqlSessionFactory` | 工厂，创建 SqlSession（线程安全，全局单例）|
| `SqlSession` | 执行 SQL 的门面，非线程安全（每次请求新建）|
| `Executor` | SQL 执行器，管理缓存和事务 |
| `StatementHandler` | 创建并操作 JDBC Statement |
| `ParameterHandler` | 将 Java 参数绑定到 SQL 占位符 |
| `ResultSetHandler` | 将 ResultSet 映射为 Java 对象 |
| `TypeHandler` | Java 类型 ↔ JDBC 类型互转 |

### 4、Mapper 接口的实现原理

Mapper 接口没有实现类，MyBatis 通过 **JDK 动态代理**在运行时生成代理对象：

```
getMapper(UserMapper.class)
  ↓
MapperRegistry.getMapper()
  ↓
MapperProxyFactory.newInstance()
  ↓
Proxy.newProxyInstance(classLoader, [UserMapper.class], mapperProxy)
  ↓
返回 UserMapper 的代理实例
```

**MapperProxy.invoke() 核心逻辑**：

```java
public Object invoke(Object proxy, Method method, Object[] args) throws Throwable {
    // 1. Object 自带方法（toString/hashCode/equals）直接调用
    if (Object.class.equals(method.getDeclaringClass())) {
        return method.invoke(this, args);
    }
    // 2. default 方法（接口默认方法）特殊处理
    if (method.isDefault()) {
        return invokeDefaultMethod(proxy, method, args);
    }
    // 3. 普通 Mapper 方法：找到对应的 MappedStatement 并执行
    MapperMethod mapperMethod = cachedMapperMethod(method);
    return mapperMethod.execute(sqlSession, args);
}
```

`MapperMethod.execute()` 根据 SQL 类型（SELECT/INSERT/UPDATE/DELETE）和返回类型分发到 SqlSession 的对应方法。

**关键点**：每个 Mapper 接口方法 → 一个 `MappedStatement`（通过 namespace + methodName 唯一标识），MyBatis 初始化时已将所有 MappedStatement 注册到 `Configuration` 中。

### 5、MyBatis 执行器

MyBatis 提供三种基础执行器，由 `ExecutorType` 控制：

| 执行器 | 说明 | 适用场景 |
|--------|------|---------|
| `SimpleExecutor`（默认）| 每次执行都创建新的 `PreparedStatement` | 通用 |
| `ReuseExecutor` | 复用已创建的 `PreparedStatement`（按 SQL 缓存）| 相同 SQL 重复执行 |
| `BatchExecutor` | 批量提交，多条 DML 合并为 JDBC batch 执行 | 大批量写入 |

```java
// 使用 BatchExecutor 批量插入（Spring 中）
@Autowired
private SqlSessionFactory sqlSessionFactory;

public void batchInsert(List<User> users) {
    try (SqlSession session = sqlSessionFactory.openSession(ExecutorType.BATCH)) {
        UserMapper mapper = session.getMapper(UserMapper.class);
        for (User user : users) {
            mapper.insert(user);
        }
        session.commit();
    }
}
```

**CachingExecutor（装饰器）**：开启二级缓存时，MyBatis 用 `CachingExecutor` 包装上述三种执行器。每次查询前先检查二级缓存，未命中再委托给内部的实际执行器。

```
开启二级缓存后的执行链：
CachingExecutor.query()
  → 检查二级缓存（有则返回）
  → 委托给 SimpleExecutor.query()
      → 检查一级缓存（有则返回）
      → 真正执行 JDBC
```

### 6、自定义的 TypeHandler

在实际开发中，我们常常需要将数据库中的某些类型与 Java 对象之间进行复杂转换，例如：

* JSON 转 List 或 Map；
* 数据库存储枚举的 code 值，而 Java 中使用枚举类型；
* 特殊格式的字符串映射为 Java Bean 等。

MyBatis 提供了 `TypeHandler` 接口来支持自定义类型转换。

#### 核心接口

```java
public interface TypeHandler<T> {
    void setParameter(PreparedStatement ps, int i, T parameter, JdbcType jdbcType) throws SQLException;

    T getResult(ResultSet rs, String columnName) throws SQLException;

    T getResult(ResultSet rs, int columnIndex) throws SQLException;

    T getResult(CallableStatement cs, int columnIndex) throws SQLException;
}
```

#### 示例：JSON -> List 的转换

```java

@MappedTypes(List.class)
@MappedJdbcTypes(JdbcType.VARCHAR)
public class JacksonListTypeHandler<T> implements TypeHandler<List<T>> {

    private static final ObjectMapper objectMapper = new ObjectMapper();

    private final Class<T> elementType;

    public JacksonListTypeHandler(Class<T> elementType) {
        this.elementType = elementType;
    }

    @Override
    public void setParameter(PreparedStatement ps, int i, List<T> parameter, JdbcType jdbcType) throws SQLException {
        ps.setString(i, objectMapper.writeValueAsString(parameter));
    }

    @Override
    public List<T> getResult(ResultSet rs, String columnName) throws SQLException {
        String json = rs.getString(columnName);
        return parseJson(json);
    }

    @Override
    public List<T> getResult(ResultSet rs, int columnIndex) throws SQLException {
        String json = rs.getString(columnIndex);
        return parseJson(json);
    }

    @Override
    public List<T> getResult(CallableStatement cs, int columnIndex) throws SQLException {
        String json = cs.getString(columnIndex);
        return parseJson(json);
    }

    private List<T> parseJson(String json) throws SQLException {
        try {
            JavaType javaType = objectMapper.getTypeFactory().constructCollectionType(List.class, elementType);
            return objectMapper.readValue(json, javaType);
        } catch (Exception e) {
            throw new SQLException("Failed to convert JSON to List<" + elementType.getSimpleName() + ">", e);
        }
    }
}
```

#### 注册方式

1. **XML 配置注册**

```xml

<typeHandlers>
    <typeHandler handler="com.example.handler.JacksonListTypeHandler"/>
</typeHandlers>
```

2. **注解注册**

```java
private class configuration {

    @TableField(typeHandler = JacksonListTypeHandler.class)
    private List<JAVA-OBJECT>failureReason;

}
```

#### 进阶源码

Mybatis-plus的处理方案：[https://baomidou.com/guides/type-handler/](https://baomidou.com/guides/type-handler/)

### 7、拦截器和过滤器

MyBatis 拦截器是一种插件机制，可以在四大对象的方法执行前后进行拦截，常用于实现通用逻辑（如 SQL 日志、加密解密、多租户等）。

#### 四大拦截目标对象

* Executor（执行器）：增删改查执行逻辑；
* ParameterHandler：参数处理逻辑；
* ResultSetHandler：结果集处理；
* StatementHandler：SQL 预处理逻辑。

#### 自定义拦截器示例：打印执行 SQL 和耗时

```java

@Intercepts({
        @Signature(type = Executor.class, method = "update", args = {MappedStatement.class, Object.class}),
        @Signature(type = Executor.class, method = "query", args = {MappedStatement.class, Object.class, RowBounds.class, ResultHandler.class})
})
public class SqlLogInterceptor implements Interceptor {

    @Override
    public Object intercept(Invocation invocation) throws Throwable {
        long start = System.currentTimeMillis();
        try {
            return invocation.proceed();
        } finally {
            MappedStatement ms = (MappedStatement) invocation.getArgs()[0];
            Object param = invocation.getArgs()[1];
            String sqlId = ms.getId();
            BoundSql boundSql = ms.getBoundSql(param);
            String sql = boundSql.getSql().replaceAll("\\s+", " ");
            long cost = System.currentTimeMillis() - start;
            System.out.println("SQL ID: " + sqlId + ", Time: " + cost + "ms");
            System.out.println("SQL: " + sql);
        }
    }

    @Override
    public Object plugin(Object target) {
        return Plugin.wrap(target, this); // 包装目标对象
    }

    @Override
    public void setProperties(Properties properties) {
        // 可配置属性
    }
}
```

#### 注册方式

```xml

<plugins>
    <plugin interceptor="com.example.interceptor.SqlLogInterceptor"/>
</plugins>
```

或 Spring Boot 中配置：

```yaml
mybatis-plus:
  configuration:
    log-impl: org.apache.ibatis.logging.stdout.StdOutImpl
  plugins:
    - com.example.interceptor.SqlLogInterceptor
```

## 二、Mybatis-plus

详细配置见：[Mybatis-官网](https://baomidou.com/)，此处不做赘述；

### 1、多租户方案

| 隔离级别       | 实现方式             | 说明                             | 场景适配                      | 优缺点                    |
|------------|------------------|--------------------------------|---------------------------|------------------------|
| 字段级（逻辑隔离）  | 共表共库，加 tenant_id | 一张表存多租户，靠 SQL 中拼接 tenant_id 区分 | 适合中小型 SaaS                | 实现简单，成本低，但易出现数据泄露（靠代码） |
| 库级（数据库隔离）  | 每租户一个数据库         | 每个租户单独库，动态切换数据源                | 中大型 SaaS                  | 数据更安全，隔离性好，运维复杂度中等     |
| Schema 级隔离 | 同库不同 schema      | 每个租户用一个 schema，表结构一致           | PostgreSQL 等支持 schema 的系统 | 结构清晰，适中隔离，MySQL 支持不佳   |
| 实例级（物理隔离）  | 每租户部署独立实例        | 每个租户单独部署服务 + 数据库               | 政企客户、私有部署场景               | 成本高、运维复杂，但隔离性最强，安全性最佳  |

#### ✅ 方案 1：字段级（逻辑隔离）

**核心做法：**

* 所有业务表增加 `tenant_id` 字段；
* 用 MyBatis-Plus 的 `TenantLineInnerInterceptor` 拦截器自动拼接；
* 租户 ID 从 ThreadLocal、Token、Header 中动态获取。

**优点：**

* 实现简单；
* 不需要多个数据库或数据源；
* 单表结构复用，维护成本低。

**缺点：**

* **数据隔离依赖程序层控制**，一旦控制失效，可能出现数据泄漏；
* 不支持租户间字段结构差异。

---

#### ✅ 方案 2：库级隔离（多数据源 + 动态路由）

**核心做法：**

* 每个租户对应一个数据库（如 `mdm_tenant_001`, `mdm_tenant_002`）；
*

程序通过动态数据源切换（如使用 [DynamicDatasource](https://github.com/baomidou/dynamic-datasource-spring-boot-starter)）；

* 每次请求根据租户 ID 决定使用哪个 DataSource。

**实现要点：**

* 创建 `TenantContext` 保存当前租户；
* 创建一个数据源注册器管理所有租户的数据源；
* 使用 AOP 或拦截器动态切换。

**优点：**

* 每个租户独立数据库，隔离性强；
* 更容易扩展不同租户的数据结构、性能优化；
* 避免大表问题。

**缺点：**

* 数据源管理复杂；
* 每个租户都要配置一份数据库连接；
* 报表、跨租户统计麻烦。

---

#### ✅ 方案 3：Schema级隔离（PostgreSQL 推荐）

**核心做法：**

* 每个租户分配一个独立 schema；
* 程序中设置当前会话的 schema（如 `SET search_path TO tenant1`）；
* 使用统一的表结构。

**优点：**

* SQL 可复用，数据隔离好；
* Schema 切换比 DataSource 快；
* PostgreSQL 支持最佳。

**缺点：**

* MySQL 不支持 schema，难落地；
* ORM 适配性略差；
* 跨租户操作同样麻烦。

---

#### ✅ 方案 4：实例级隔离（物理隔离）

**核心做法：**

* 每个租户部署一套完整系统：服务 + 数据库；
* 可用容器（Kubernetes）、自动化运维工具部署。

**适用场景：**

* 政企大客户；
* 要求私有化部署；
* 高安全隔离场景。

**优点：**

* 安全性最高；
* 性能独立；
* 支持差异化配置。

**缺点：**

* 成本最高；
* 自动化运维要求高；
* 版本升级难度大。

### 2、多数据源方案

多数据源常见于：读写分离、数据库分库、访问多个业务库等场景。

#### 方案 1：Spring AbstractRoutingDataSource（原生）

```java
// 1. 定义数据源上下文持有者
public class DataSourceContextHolder {
    private static final ThreadLocal<String> CONTEXT = new ThreadLocal<>();
    public static void set(String ds) { CONTEXT.set(ds); }
    public static String get() { return CONTEXT.get(); }
    public static void clear() { CONTEXT.remove(); }
}

// 2. 继承 AbstractRoutingDataSource
public class RoutingDataSource extends AbstractRoutingDataSource {
    @Override
    protected Object determineCurrentLookupKey() {
        return DataSourceContextHolder.get();
    }
}

// 3. 注册多个数据源
@Bean
public DataSource dataSource(DataSource master, DataSource slave) {
    RoutingDataSource routing = new RoutingDataSource();
    Map<Object, Object> map = new HashMap<>();
    map.put("master", master);
    map.put("slave", slave);
    routing.setTargetDataSources(map);
    routing.setDefaultTargetDataSource(master);
    return routing;
}

// 4. AOP 切换（或手动切换）
DataSourceContextHolder.set("slave");
List<User> users = userMapper.selectAll();
DataSourceContextHolder.clear();
```

#### 方案 2：dynamic-datasource-spring-boot-starter（推荐）

MyBatis-Plus 官方出品，注解驱动，开箱即用：

```xml
<dependency>
  <groupId>com.baomidou</groupId>
  <artifactId>dynamic-datasource-spring-boot-starter</artifactId>
  <version>4.3.1</version>
</dependency>
```

```yaml
spring:
  datasource:
    dynamic:
      primary: master
      datasource:
        master:
          url: jdbc:mysql://db-master:3306/mydb
          username: root
          password: xxx
        slave:
          url: jdbc:mysql://db-slave:3306/mydb
          username: root
          password: xxx
```

```java
// @DS 注解指定数据源（方法级 > 类级）
@Service
public class UserService {
    @DS("slave")
    public List<User> listUsers() { ... }  // 走从库

    @DS("master")
    public void createUser(User user) { ... }  // 走主库
}
```

## 三、Hibernate

- 官网：[hibernate.org](https://hibernate.org/)
- Java 最早的 ORM 框架，JPA 规范的参考实现
- Spring Data JPA 底层默认使用 Hibernate

### 1、核心概念

| 概念 | 说明 |
|------|------|
| `SessionFactory` | 线程安全，全局单例，类比 SqlSessionFactory |
| `Session` | 非线程安全，类比 SqlSession；Spring 中由 `EntityManager` 替代 |
| 实体状态 | Transient（临时）/ Persistent（持久）/ Detached（游离）/ Removed（删除）|
| 懒加载 | 关联对象默认懒加载，Session 关闭后访问触发 `LazyInitializationException` |

### 2、HQL 查询

```java
// JPQL（Hibernate 实现）
TypedQuery<User> query = em.createQuery(
    "SELECT u FROM User u WHERE u.status = :status ORDER BY u.createdAt DESC",
    User.class);
query.setParameter("status", 1);
List<User> users = query.setMaxResults(10).getResultList();

// Criteria API（类型安全）
CriteriaBuilder cb = em.getCriteriaBuilder();
CriteriaQuery<User> cq = cb.createQuery(User.class);
Root<User> root = cq.from(User.class);
cq.where(cb.equal(root.get("status"), 1));
List<User> users = em.createQuery(cq).getResultList();
```

### 3、N+1 问题

```java
// 查询 100 个订单，每个订单又懒加载 user → 发出 1 + 100 条 SQL
List<Order> orders = orderRepo.findAll();
orders.forEach(o -> System.out.println(o.getUser().getName())); // N+1

// 解决：JPQL 用 JOIN FETCH 提前加载
@Query("SELECT o FROM Order o JOIN FETCH o.user WHERE o.status = 'paid'")
List<Order> findPaidOrdersWithUser();

// 或 @EntityGraph
@EntityGraph(attributePaths = {"user"})
List<Order> findByStatus(String status);
```

### 4、Hibernate vs MyBatis 选型

| 维度 | Hibernate / JPA | MyBatis |
|------|:---------------:|:-------:|
| SQL 控制 | ORM 自动生成，灵活度低 | 手写 SQL，完全可控 |
| 复杂查询 | HQL/Criteria 复杂 | 直接写 SQL，简单直观 |
| 数据库移植 | 切换方言即可 | SQL 可能需要重写 |
| 学习曲线 | 陡（实体状态、级联、懒加载）| 平缓 |
| 国内生态 | Spring Data JPA 普及 | MyBatis-Plus 更流行 |
| 适用场景 | 领域模型清晰、CRUD 为主 | 复杂 SQL、报表、存储过程 |
