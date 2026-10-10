---
description: MyBatis 缓存、分页、Mapper 代理、TypeHandler、插件、多租户、Hibernate 持久化上下文
---

# ORM 框架

> 前置阅读：[事务管理](/spring/4_transaction)、[数据访问](/spring-boot/3_data_access)

ORM 框架负责把 Java 对象和数据库表互相映射，Java 项目里最常用的是 MyBatis 和 Hibernate。本篇讲 MyBatis 缓存与插件原理、MyBatis-Plus 多租户、Hibernate 持久化上下文与 N+1，基线为 MyBatis 3.5。

---

## 一、MyBatis 缓存

版本基线：MyBatis 3.5.19（mybatis-spring-boot-starter 3.0.x 对应 Boot 3.2–3.5，4.0.x 对应 Boot 4.0）、MyBatis-Plus 3.5.17、Hibernate ORM 7.x（实现 Jakarta Persistence 3.2，Boot 4 默认）；原理部分还涉及分页插件、Mapper 代理、执行器、TypeHandler 与数据源路由。

本篇讲框架原理；在 Spring Boot 中引入依赖、写实体与 Repository、配置 MyBatis-Plus 与多数据源等用法见 [数据访问](/spring-boot/3_data_access)。

### 1、一级缓存（SqlSession 级）

- 默认开启（`localCacheScope=SESSION`），作用域是同一个 `SqlSession`；同一 Session 内 statement、参数、分页、SQL 都相同的查询直接返回缓存的对象
- 以下情况会清空：执行 INSERT / UPDATE / DELETE；`commit` / `rollback`；调用 `clearCache()`；Session 关闭；查询语句配置了 `flushCache="true"`
- 设置 `localCacheScope=STATEMENT` 后一级缓存只在单条语句内有效，相当于关闭。多个应用实例共享数据库时，一个长事务中重复查询可能读到本 Session 缓存的旧对象，对此敏感的场景可以这样设置
- 命中时返回的是**同一个对象引用**，修改返回对象会污染缓存中的数据

在 Spring 中，Mapper 由 `SqlSessionTemplate` 代理：

- **没有事务时**，每次调用 Mapper 方法都会打开并关闭一个新的 `SqlSession`，同一个 Service 方法里连续两次查询也不会共享一级缓存
- **在 `@Transactional` 内**，`SqlSession` 绑定到当前事务，事务内的查询才共享一级缓存

```java
@Transactional
public void demo() {
    User u1 = userMapper.selectById(1L);  // 查询数据库
    User u2 = userMapper.selectById(1L);  // 命中一级缓存，不发 SQL
    // u1 == u2，是同一个对象引用
}
```

### 2、二级缓存（namespace 级）

- 全局开关 `cacheEnabled` **默认就是 true**；二级缓存之所以“默认不生效”，是因为每个 Mapper 还需要单独声明 `<cache/>` 或 `@CacheNamespace`。把 `cacheEnabled` 设为 false 会在全局关闭二级缓存
- 作用域是 namespace，跨 `SqlSession` 共享；写入先暂存在 `TransactionalCache`，**事务提交后**才对其他 Session 可见
- 同一 namespace 的增删改默认会清空该 namespace 的缓存；单条查询可用 `useCache="false"` 跳过二级缓存

```xml
<!-- UserMapper.xml：声明后该 namespace 的查询才使用二级缓存 -->
<cache eviction="LRU" flushInterval="60000" size="512" readOnly="true"/>
```

```java
// 注解方式；readWrite = true（默认）时通过序列化返回副本，实体需实现 Serializable
@CacheNamespace(eviction = LruCache.class, flushInterval = 60000, size = 512, readWrite = false)
public interface UserMapper {
    // ...
}
```

二级缓存的问题：

- 多表关联查询的结果缓存在当前 namespace，其他 namespace 更新了关联表不会清除它，容易读到脏数据
- 缓存在各应用实例的本地内存中，多实例部署时彼此不一致

只建议用于几乎不变的字典类数据；业务数据的缓存应在应用层用 Redis 等实现，缓存与数据库的一致性策略见 [缓存总览](/cache/0_overview)。

### 3、查找顺序

![MyBatis 查询的缓存查找顺序](../../assets/database/mybatis-cache-layers.svg)

`Configuration.newExecutor` 在 `cacheEnabled=true`（默认）时总会用 `CachingExecutor` 包装实际的执行器，所以它几乎总是存在；只有当 `MappedStatement` 有对应的 Cache（namespace 声明了 `<cache/>`）且 `useCache=true` 时，它才会真正查二级缓存，否则直接委托给内部执行器去查一级缓存和数据库。

---

## 二、分页原理

### 1、RowBounds 逻辑分页

```java
List<User> users = sqlSession.selectList("com.example.mapper.UserMapper.selectAll", null, new RowBounds(100, 10));
```

`RowBounds` 不改写 SQL。`DefaultResultSetHandler` 先把游标移过 `offset` 行（支持时用 `absolute()`，否则逐行 `next()`），再只映射 `limit` 行，并不会把所有行都映射成对象。真正的代价在于：

- 数据库仍然要执行不带 LIMIT 的完整查询，并把结果发给客户端
- MySQL Connector/J 默认把整个结果集缓存到客户端内存（没有开启流式读取），大表同样可能 OOM

所以 `RowBounds` 只适合结果集本身就很小的场景。

### 2、PageHelper 物理分页

PageHelper 的 `PageInterceptor` 拦截的是 **`Executor.query`**，同时声明了 4 参数和 6 参数两个重载：

1. `PageHelper.startPage(1, 10)` 把分页参数放进 `ThreadLocal`
2. 紧随其后的第一个查询进入拦截器，先根据原 SQL 生成并执行 `COUNT` 查询
3. 再用对应数据库的方言（Dialect）改写 SQL，追加 `LIMIT`（Oracle 等用各自语法）后执行
4. 在 `finally` 中清除 `ThreadLocal`

```java
// 推荐写法：分页参数与查询绑定在一起，不会遗留在 ThreadLocal 中
PageInfo<User> pageInfo = PageHelper.startPage(1, 10)
        .doSelectPageInfo(() -> userMapper.selectAll());
```

常见坑：`startPage` 之后如果没有执行查询（例如中间抛出异常或走了别的分支），参数会留在线程中，被该线程下一次查询误用；`startPage` 与查询之间也不能插入其他查询。

依赖版本：`pagehelper-spring-boot-starter` 1.4.x 只支持 Boot 2；Boot 3 使用 2.1.x；Boot 4 使用 4.x（4.1 起最低 JDK 17）。

### 3、MyBatis-Plus 分页

`PaginationInnerInterceptor` 是 `MybatisPlusInterceptor` 中的一个内部插件：它用 jsqlparser 解析原 SQL，生成优化过的 COUNT 语句（例如去掉无用的 `ORDER BY` 和不影响行数的 `LEFT JOIN`），再按数据库类型追加分页子句。3.5.9 起 jsqlparser 拆成独立模块，必须额外引入 `mybatis-plus-jsqlparser`，否则分页插件无法使用。依赖与 `Page` 的用法见 [数据访问](/spring-boot/3_data_access) 的「分页」一节。

无论哪种物理分页，`LIMIT` 偏移量很大时都会变慢，深分页的优化见 [MySQL 索引](../1_mysql/4_topic_index)。

---

## 三、MyBatis 工作原理

### 1、初始化与执行

MyBatis 的工作分为**初始化阶段**（启动时解析配置与 Mapper，构建 `Configuration`）和**执行阶段**（每次 SQL 调用）：

![MyBatis 初始化流程](../../assets/database/mybatis-init-flow.svg)

![MyBatis 执行流程（一次查询）](../../assets/database/mybatis-exec-flow.svg)

| 组件 | 职责 |
|------|------|
| `SqlSessionFactory` | 创建 `SqlSession`，线程安全，全局单例 |
| `SqlSession` | 执行 SQL 的门面，非线程安全；Spring 中由线程安全的 `SqlSessionTemplate` 代替 |
| `Executor` | SQL 执行器，管理一级缓存、批处理与事务 |
| `StatementHandler` | 创建并操作 JDBC `Statement` |
| `ParameterHandler` | 把 Java 参数绑定到 SQL 占位符 |
| `ResultSetHandler` | 把 `ResultSet` 映射为 Java 对象 |
| `TypeHandler` | Java 类型与 JDBC 类型互转 |

### 2、Mapper 接口的代理

Mapper 接口没有实现类，MyBatis 通过 **JDK 动态代理**在运行时生成代理对象，创建过程：

1. `sqlSession.getMapper(UserMapper.class)` 委托给 `Configuration.getMapper`
2. `MapperRegistry` 找到该接口在初始化时注册的 `MapperProxyFactory`
3. `MapperProxyFactory.newInstance` 创建 `MapperProxy`（`InvocationHandler`），并调用 `Proxy.newProxyInstance` 生成代理实例

调用 Mapper 方法时进入 `MapperProxy.invoke`，3.5.x 的逻辑（简化）如下：

```java
@Override
public Object invoke(Object proxy, Method method, Object[] args) throws Throwable {
    // Object 自带的方法（toString / hashCode / equals）直接调用
    if (Object.class.equals(method.getDeclaringClass())) {
        return method.invoke(this, args);
    }
    // 按 Method 缓存调用器：接口 default 方法用 DefaultMethodInvoker，
    // 普通方法用 PlainMethodInvoker，其内部持有 MapperMethod
    return cachedInvoker(method).invoke(proxy, method, args, sqlSession);
}
```

`MapperMethod.execute` 根据 SQL 类型（SELECT / INSERT / UPDATE / DELETE）和返回类型，分发到 `SqlSession` 的 `selectOne`、`selectList`、`update` 等方法。

每个 Mapper 方法对应一个 `MappedStatement`，其 id 是**接口全限定名 + "." + 方法名**，初始化时注册在 `Configuration` 中。id 里没有参数类型，同名重载方法会对应同一个 statement，所以 Mapper 方法不应重载。

### 3、执行器

| 执行器 | 说明 | 适用场景 |
|--------|------|---------|
| `SimpleExecutor`（默认） | 每次执行都创建新的 `PreparedStatement` | 通用 |
| `ReuseExecutor` | 在同一 Session 内按 SQL 复用 `PreparedStatement` | 同一 Session 内重复执行相同 SQL |
| `BatchExecutor` | 把多条 DML 攒成 JDBC batch，`flushStatements` 时统一执行 | 大批量写入 |

```java
public void batchInsert(List<User> users) {
    try (SqlSession session = sqlSessionFactory.openSession(ExecutorType.BATCH)) {
        UserMapper mapper = session.getMapper(UserMapper.class);
        for (int i = 0; i < users.size(); i++) {
            mapper.insert(users.get(i));
            if ((i + 1) % 1000 == 0) {
                session.flushStatements();  // 每 1000 条执行一次 batch，控制内存占用
            }
        }
        session.flushStatements();
        session.commit();  // 处于 Spring 事务中时不会真正提交，由外层事务负责
    }
}
```

要点：

- MySQL 需要在 JDBC URL 上加 `rewriteBatchedStatements=true`，驱动才会把 batch 合并成多值 INSERT，否则仍是逐条发送
- 由 mybatis-spring 创建的 `SqlSessionFactory` 使用 `SpringManagedTransaction`：存在 Spring 事务时复用事务连接，`session.commit()` 不生效，提交由外层事务决定
- MyBatis-Plus 的 `IService.saveBatch` 同样基于 BATCH 执行器，默认每 1000 条刷新一次

`CachingExecutor` 是包在上述执行器外面的装饰器，见上一节的查找顺序。

---

## 四、TypeHandler

数据库字段与 Java 类型之间需要非标准转换时使用，例如 JSON 字符串与 `List` 互转、枚举按 code 存储。MyBatis 内置了枚举的 `EnumTypeHandler`（按名称，默认）与 `EnumOrdinalTypeHandler`（按序号）。

### 1、自定义实现

自定义时继承 `BaseTypeHandler`，它已经处理了参数为 `null` 的情况，子类只需实现非空写入与可空读取：

```java
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JavaType;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.apache.ibatis.type.BaseTypeHandler;
import org.apache.ibatis.type.JdbcType;

import java.sql.CallableStatement;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.List;

public abstract class JsonListTypeHandler<E> extends BaseTypeHandler<List<E>> {

    private static final ObjectMapper MAPPER = new ObjectMapper();

    private final JavaType listType;

    protected JsonListTypeHandler(Class<E> elementType) {
        this.listType = MAPPER.getTypeFactory().constructCollectionType(List.class, elementType);
    }

    @Override
    public void setNonNullParameter(PreparedStatement ps, int i, List<E> parameter, JdbcType jdbcType)
            throws SQLException {
        try {
            ps.setString(i, MAPPER.writeValueAsString(parameter));
        } catch (JsonProcessingException e) {
            throw new SQLException("List 序列化为 JSON 失败", e);
        }
    }

    @Override
    public List<E> getNullableResult(ResultSet rs, String columnName) throws SQLException {
        return parse(rs.getString(columnName));
    }

    @Override
    public List<E> getNullableResult(ResultSet rs, int columnIndex) throws SQLException {
        return parse(rs.getString(columnIndex));
    }

    @Override
    public List<E> getNullableResult(CallableStatement cs, int columnIndex) throws SQLException {
        return parse(cs.getString(columnIndex));
    }

    private List<E> parse(String json) throws SQLException {
        if (json == null || json.isEmpty()) {
            return null;
        }
        try {
            return MAPPER.readValue(json, listType);
        } catch (JsonProcessingException e) {
            throw new SQLException("JSON 解析为 List 失败: " + json, e);
        }
    }
}
```

```java
// 每种元素类型一个具体子类：MyBatis 用无参构造实例化，泛型信息在这里确定
public class LongListTypeHandler extends JsonListTypeHandler<Long> {
    public LongListTypeHandler() {
        super(Long.class);
    }
}
```

不要用 `@MappedTypes(List.class)` 把一个泛型 `List` 处理器全局注册：MyBatis 会用 `List.class` 调用 `(Class<?>)` 构造器，元素类型就丢失了，而且所有 `List` 参数都会被它接管。

上面的代码基于 Jackson 2（`com.fasterxml.jackson`）。Boot 4 默认使用 Jackson 3（包名 `tools.jackson`），其异常改为非受检的 `JacksonException`，`ObjectMapper` 推荐用 `JsonMapper.builder().build()` 创建，代码需要相应调整。

### 2、按字段绑定

MyBatis 核心写法是在结果映射和参数上逐个指定：

```xml
<resultMap id="articleMap" type="com.example.entity.Article">
    <id column="id" property="id"/>
    <result column="tag_ids" property="tagIds" typeHandler="com.example.handler.LongListTypeHandler"/>
</resultMap>

<insert id="insert">
    INSERT INTO article (id, tag_ids)
    VALUES (#{id}, #{tagIds, typeHandler=com.example.handler.LongListTypeHandler})
</insert>
```

MyBatis-Plus 用 `@TableField(typeHandler = ...)`，并且**必须**在实体上开启 `autoResultMap`，否则查询时不会使用该处理器。JSON 字段可以直接用内置的 `JacksonTypeHandler` / `Fastjson2TypeHandler`，它会读取字段的泛型类型：

```java
@TableName(value = "article", autoResultMap = true)
public class Article {

    private Long id;

    @TableField(typeHandler = JacksonTypeHandler.class)
    private List<Long> tagIds;
}
```

`autoResultMap` 只对 MyBatis-Plus 生成的查询生效；在 XML 中手写的查询仍需按上面的 `resultMap` 方式指定。

---

## 五、插件（Interceptor）原理

### 1、可拦截的对象与代理链

MyBatis 插件只能拦截四类对象的方法：

| 对象 | 典型方法 | 常见用途 |
|------|---------|---------|
| `Executor` | `update`、`query`、`commit`、`rollback` | 分页、慢 SQL 统计、读写分离 |
| `StatementHandler` | `prepare`、`parameterize`、`query` | 改写 SQL、设置超时 |
| `ParameterHandler` | `setParameters` | 参数加密 |
| `ResultSetHandler` | `handleResultSets` | 结果解密、脱敏 |

机制：

- `Configuration` 在创建这四类对象时（如 `newExecutor`、`newStatementHandler`）调用 `InterceptorChain.pluginAll(target)`，依次让每个插件包装目标对象
- `Plugin.wrap` 读取插件上的 `@Intercepts` / `@Signature`，只有目标类实现了被声明的接口方法时才生成 JDK 动态代理，否则原样返回
- 多个插件层层嵌套：**后注册的包在最外层，最先执行**
- `Executor.query` 有 4 参数和 6 参数（多了 `CacheKey`、`BoundSql`）两个重载，PageHelper 这类插件必须同时声明两个签名，否则会漏拦截

### 2、示例：慢 SQL 日志

```java
@Intercepts({
    @Signature(type = Executor.class, method = "update",
               args = {MappedStatement.class, Object.class}),
    @Signature(type = Executor.class, method = "query",
               args = {MappedStatement.class, Object.class, RowBounds.class, ResultHandler.class}),
    @Signature(type = Executor.class, method = "query",
               args = {MappedStatement.class, Object.class, RowBounds.class, ResultHandler.class,
                       CacheKey.class, BoundSql.class})
})
public class SlowSqlInterceptor implements Interceptor {

    private static final Logger log = LoggerFactory.getLogger(SlowSqlInterceptor.class);

    private long thresholdMs = 500;

    @Override
    public Object intercept(Invocation invocation) throws Throwable {
        Object[] args = invocation.getArgs();
        MappedStatement ms = (MappedStatement) args[0];
        long start = System.nanoTime();
        try {
            return invocation.proceed();
        } finally {
            long costMs = (System.nanoTime() - start) / 1_000_000;
            if (costMs >= thresholdMs) {
                // 6 参数版本已带 BoundSql；其余情况才重新生成（动态 SQL 会再渲染一次，只在慢 SQL 时发生）
                BoundSql boundSql = args.length == 6 ? (BoundSql) args[5] : ms.getBoundSql(args[1]);
                log.warn("slow sql [{}] {}ms: {}", ms.getId(), costMs,
                        boundSql.getSql().replaceAll("\\s+", " "));
            }
        }
    }

    @Override
    public void setProperties(Properties properties) {
        this.thresholdMs = Long.parseLong(properties.getProperty("thresholdMs", "500"));
    }
}
```

`Interceptor.plugin` 在 3.5 中有默认实现（调用 `Plugin.wrap`），一般不需要重写。

### 3、注册方式

- **XML**：`mybatis-config.xml` 中 `<plugins><plugin interceptor="com.example.SlowSqlInterceptor"/></plugins>`
- **Spring Boot**：把插件声明为 `@Bean`，mybatis-spring-boot-starter 与 MyBatis-Plus 的 starter 都会自动把容器中的 `Interceptor` 注册进去
- **MyBatis-Plus 内置插件**：不是独立的 `Interceptor`，而是注册在 `MybatisPlusInterceptor` 上的 `InnerInterceptor`，按添加顺序执行。官方建议的顺序是：多租户、动态表名 → 分页、乐观锁 → SQL 性能规范、防全表更新与删除

---

## 六、MyBatis-Plus 多租户与数据源路由

### 1、多租户隔离方式

| 隔离方式 | 实现 | 隔离性 | 成本 |
|---------|------|-------|------|
| 字段级 | 共库共表，加 `tenant_id` 列 | 依赖代码，最弱 | 最低 |
| Schema 级 | 同实例不同 schema | 中 | 中 |
| 库级 | 每租户一个库，动态切换数据源 | 较强 | 较高 |
| 实例级 | 每租户独立部署服务与数据库 | 最强 | 最高 |

在 MySQL 中 `SCHEMA` 是 `DATABASE` 的同义词，Schema 级与库级是同一回事；PostgreSQL 的 schema 是库内的命名空间，可以用 `SET search_path` 切换。租户隔离与数据权限在权限体系中的分层见 [权限系统架构设计](/architecture/6_access_control)。

### 2、TenantLineInnerInterceptor

字段级隔离由 MyBatis-Plus 的多租户插件实现：

```java
@Configuration
public class MybatisPlusConfig {

    private static final Set<String> IGNORE_TABLES = Set.of("sys_dict", "sys_tenant");

    @Bean
    public MybatisPlusInterceptor mybatisPlusInterceptor() {
        MybatisPlusInterceptor interceptor = new MybatisPlusInterceptor();
        interceptor.addInnerInterceptor(new TenantLineInnerInterceptor(new TenantLineHandler() {
            @Override
            public Expression getTenantId() {
                return new LongValue(TenantContext.getTenantId());  // 从请求上下文取当前租户
            }

            @Override
            public String getTenantIdColumn() {
                return "tenant_id";
            }

            @Override
            public boolean ignoreTable(String tableName) {
                return IGNORE_TABLES.contains(tableName);  // 公共表不加租户条件
            }
        }));
        // 多租户插件必须加在分页插件之前
        interceptor.addInnerInterceptor(new PaginationInnerInterceptor(DbType.MYSQL));
        return interceptor;
    }
}
```

`Expression`、`LongValue` 来自 jsqlparser（`net.sf.jsqlparser.expression`），`TenantContext` 是自己维护的 `ThreadLocal` 持有类。

行为与陷阱：

- SELECT / UPDATE / DELETE 自动追加 `tenant_id = ?`，JOIN 的表和子查询也会处理；INSERT 自动补上 `tenant_id` 列（SQL 中已有该列时不重复添加）
- 超管、跨租户统计等需要绕过时，在 Mapper 方法上加 `@InterceptorIgnore(tenantLine = "true")`
- 插件依赖 jsqlparser 解析 SQL，数据库特有的复杂语法可能解析失败
- 只对经过 MyBatis 的 SQL 生效，`JdbcTemplate`、原生 JDBC 不受保护
- 异步线程、线程池、MQ 消费者中 `ThreadLocal` 里没有租户，需要显式传递，否则可能拿到 null 或上一个任务残留的租户

### 3、数据源路由：AbstractRoutingDataSource

读写分离、库级多租户都基于 Spring 的 `AbstractRoutingDataSource`：它本身是一个 `DataSource`，每次 `getConnection()` 时调用 `determineCurrentLookupKey()` 选出目标数据源。

```java
public class DataSourceContextHolder {
    private static final ThreadLocal<String> CONTEXT = new ThreadLocal<>();
    public static void set(String key) { CONTEXT.set(key); }
    public static String get() { return CONTEXT.get(); }
    public static void clear() { CONTEXT.remove(); }
}

public class RoutingDataSource extends AbstractRoutingDataSource {
    @Override
    protected Object determineCurrentLookupKey() {
        return DataSourceContextHolder.get();  // 为 null 时使用默认数据源
    }
}

@Configuration
public class DataSourceConfig {

    @Bean
    @ConfigurationProperties("app.datasource.master")  // HikariCP 使用 jdbc-url 属性
    public DataSource masterDataSource() {
        return DataSourceBuilder.create().build();
    }

    @Bean
    @ConfigurationProperties("app.datasource.slave")
    public DataSource slaveDataSource() {
        return DataSourceBuilder.create().build();
    }

    @Bean
    @Primary  // 让 MyBatis、事务管理器注入的是路由数据源
    public DataSource dataSource(@Qualifier("masterDataSource") DataSource master,
                                 @Qualifier("slaveDataSource") DataSource slave) {
        RoutingDataSource routing = new RoutingDataSource();
        routing.setTargetDataSources(Map.<Object, Object>of("master", master, "slave", slave));
        routing.setDefaultTargetDataSource(master);
        return routing;
    }
}
```

手动切换时必须用 `try / finally` 清理，否则异常时 `ThreadLocal` 残留，会影响该线程后续的请求：

```java
DataSourceContextHolder.set("slave");
try {
    return userMapper.selectList(null);
} finally {
    DataSourceContextHolder.clear();
}
```

**与事务的冲突**：`DataSourceTransactionManager` 在事务开始时就获取连接并绑定到线程，之后事务内的所有 SQL 都用这一个连接。因此路由键必须在事务开始**之前**设置：切换数据源的切面要比事务切面先执行（`@Order` 值更小）；已经进入事务后再切换不会生效。

实际项目通常直接用 baomidou 的 dynamic-datasource（`@DS` 注解）。Boot 3 使用 `dynamic-datasource-spring-boot3-starter`，Boot 4 使用 `dynamic-datasource-spring-boot4-starter`，不带后缀的 `dynamic-datasource-spring-boot-starter` 只适用于 Boot 2。配置与用法见 [数据访问](/spring-boot/3_data_access) 的「多数据源」一节。跨库写入的一致性需要分布式事务，见 [分布式事务](/distributed/4_transaction)。

---

## 七、Hibernate 与 JPA

- 官网：[hibernate.org](https://hibernate.org/)
- 2001 年发布，是使用最广的 JPA 实现，但不是最早的 Java ORM（TopLink 等更早），也不是 JPA 的参考实现（JPA 2.0 起参考实现是 EclipseLink）
- Hibernate ORM 7 实现 Jakarta Persistence 3.2，是 Spring Boot 4 中 Spring Data JPA 的默认实现

### 1、核心概念与实体状态

| 概念 | 说明 |
|------|------|
| `SessionFactory` / `EntityManagerFactory` | 线程安全，全局单例；`SessionFactory` 继承 `EntityManagerFactory` |
| `Session` / `EntityManager` | 非线程安全，代表一个持久化上下文；`Session` 继承 `EntityManager` |
| 实体状态 | 瞬时（new）、托管（managed）、游离（detached）、删除（removed） |

状态转换：

- `persist`：瞬时 → 托管
- `find` / 查询：从数据库加载的实体直接处于托管状态
- `merge`：把游离对象的状态复制到一个托管实例上，**返回的是托管实例**，传入的对象仍是游离的
- `remove`：托管 → 删除，flush 时发出 DELETE
- `detach` / `clear` / 上下文关闭：托管 → 游离

### 2、持久化上下文与脏检查

持久化上下文就是 Hibernate 的一级缓存，本质是按 id 索引的实体表：

- 同一上下文内 `find` 同一个 id 返回同一个对象，不再发 SQL
- 实体加载时保存一份快照，**flush 时与快照比对**（脏检查），有变化就自动生成 UPDATE，不需要调用 save

```java
@Transactional
public void rename(Long id, String name) {
    User user = em.find(User.class, id);  // 进入持久化上下文并保存快照
    user.setName(name);                    // 不需要调用 save / update
}                                          // 提交前 flush：与快照比对后发出 UPDATE
```

- **Flush 时机**：默认 `AUTO`，在事务提交前、以及执行涉及已修改表的查询前自动 flush；`COMMIT` 只在提交时 flush
- **写延迟与批处理**：SQL 推迟到 flush 时发出，配合 `hibernate.jdbc.batch_size` 可以合并成 JDBC batch。主键用 `GenerationType.IDENTITY` 时，必须立即执行 INSERT 才能拿到 id，**插入批处理会失效**；PostgreSQL、Oracle 可用 `SEQUENCE` 加 pooled 优化器保留批处理
- 大批量处理时上下文中的实体会越积越多，需要定期 `flush()` + `clear()`

### 3、查询：JPQL、HQL 与 Criteria

```java
// JPQL：标准语法，任何 JPA 实现都支持
List<User> active = em.createQuery(
                "select u from User u where u.status = :status order by u.createdAt desc", User.class)
        .setParameter("status", 1)
        .setMaxResults(10)
        .getResultList();

// HQL：Hibernate 的查询语言，是 JPQL 的超集，例如可以省略 select 子句
Session session = em.unwrap(Session.class);
List<User> sameUsers = session.createSelectionQuery("from User where status = :status", User.class)
        .setParameter("status", 1)
        .getResultList();

// Criteria API：类型安全，适合动态拼接条件
CriteriaBuilder cb = em.getCriteriaBuilder();
CriteriaQuery<User> cq = cb.createQuery(User.class);
Root<User> root = cq.from(User.class);
cq.select(root).where(cb.equal(root.get("status"), 1));
List<User> byCriteria = em.createQuery(cq).getResultList();
```

### 4、关联加载与 N+1

JPA 规定的默认抓取策略：`@ManyToOne`、`@OneToOne` 是 **EAGER**；`@OneToMany`、`@ManyToMany` 是 LAZY。

N+1 有两种来源：

- **EAGER 的对一关联**：用 JPQL 或 `findAll()` 查出 N 篇文章时，查询本身不带 JOIN，Hibernate 会再为每个不同的作者各发一条 SELECT，**即使代码从未访问 `getAuthor()`**
- **LAZY 关联被逐个访问**：遍历结果时每次访问未初始化的关联都会触发一次查询

推荐做法是把对一关联显式设为 LAZY，再在需要关联数据的查询上显式抓取：

```java
@Entity
public class Article {

    @Id
    private Long id;

    private String status;

    @ManyToOne(fetch = FetchType.LAZY)  // JPA 默认 EAGER，显式改为 LAZY
    @JoinColumn(name = "author_id")
    private Author author;
}

public interface ArticleRepository extends JpaRepository<Article, Long> {

    // 需要作者信息的查询用 join fetch 一次取回
    @Query("select a from Article a join fetch a.author where a.status = :status")
    List<Article> findWithAuthor(@Param("status") String status);
}
```

其他手段：`@EntityGraph` 声明要抓取的关联；全局设置 `hibernate.default_batch_fetch_size`，让懒加载按 `IN (...)` 批量加载，把 N 次查询降到 N / batch_size 次。Repository 层的写法与 `LazyInitializationException` 的处理见 [数据访问](/spring-boot/3_data_access) 的「Spring Data JPA」一节。

### 5、二级缓存与 Open Session in View

- **二级缓存**：`SessionFactory` 级别，默认关闭；需要接入 JCache 实现（如 Ehcache 3、Caffeine 的 JCache 适配），并在实体上加 `@Cache`。查询缓存需另外开启。与 MyBatis 二级缓存一样，多实例部署要考虑一致性，多数业务不开启
- **Open Session in View**：Spring Boot 的 `spring.jpa.open-in-view` 默认为 true（启动时会打印警告），持久化上下文一直保持到 Web 请求结束，Controller 和序列化阶段访问懒加载关联也能成功。代价是在事务之外悄悄发出 SQL，N+1 更隐蔽；建议设为 false，在 Service 层用 `join fetch` 或 DTO 投影取齐数据

### 6、Hibernate 与 MyBatis 选型

| 维度 | Hibernate / JPA | MyBatis / MyBatis-Plus |
|------|-----------------|------------------------|
| SQL 控制 | 自动生成，需要关注实际发出的 SQL | 手写 SQL，完全可控 |
| 复杂查询 | JPQL / Criteria 表达多表报表较繁琐 | 直接写 SQL，直观 |
| 数据库移植 | 切换方言即可 | SQL 可能需要重写 |
| 学习曲线 | 陡（实体状态、脏检查、抓取策略） | 平缓 |
| 国内生态 | Spring Data JPA | MyBatis-Plus 更流行 |
| 适用场景 | 领域模型清晰、以聚合为单位读写 | 复杂 SQL、报表、性能敏感、DBA 审核 SQL |

---

## 小结

- MyBatis 一级缓存默认开启，Spring 中只有在事务内才共享；二级缓存的全局开关 `cacheEnabled` 默认 true，但需要在 namespace 声明 `<cache/>` 才生效，提交后才可见
- `CachingExecutor` 在默认配置下总会包装执行器，只有 namespace 配置了缓存时才查二级缓存
- `RowBounds` 不改写 SQL，数据库仍返回全部结果；PageHelper 拦截 `Executor.query` 的两个重载，先查 COUNT 再改写 LIMIT；Boot 3 用 PageHelper starter 2.1.x，Boot 4 用 4.x
- Mapper 是 JDK 动态代理，`MappedStatement` id 为接口全名 + 方法名，所以 Mapper 方法不应重载
- BATCH 执行器在 MySQL 上要配合 `rewriteBatchedStatements=true`，并定期 `flushStatements`
- TypeHandler 继承 `BaseTypeHandler`，泛型处理器用具体子类按字段绑定；MyBatis-Plus 的 `typeHandler` 需要 `autoResultMap = true`
- 插件只能拦截四类对象，后注册的先执行；MyBatis-Plus 内置插件是 `InnerInterceptor`，多租户要在分页之前
- 数据源路由在获取连接时决定，切换必须在事务开始之前，并用 `try / finally` 清理
- Hibernate 的核心是持久化上下文与脏检查；`IDENTITY` 主键会让插入批处理失效；对一关联默认 EAGER 会引发 N+1，应改为 LAZY 再按需抓取

## 参考资料

- MyBatis 3 文档：[https://mybatis.org/mybatis-3/](https://mybatis.org/mybatis-3/)
- MyBatis 配置项（cacheEnabled、localCacheScope）：[https://mybatis.org/mybatis-3/configuration.html#settings](https://mybatis.org/mybatis-3/configuration.html#settings)
- MyBatis 缓存：[https://mybatis.org/mybatis-3/sqlmap-xml.html#cache](https://mybatis.org/mybatis-3/sqlmap-xml.html#cache)
- MyBatis 插件：[https://mybatis.org/mybatis-3/configuration.html#plugins](https://mybatis.org/mybatis-3/configuration.html#plugins)
- MyBatis-Spring：[https://mybatis.org/spring/](https://mybatis.org/spring/)
- mybatis-spring-boot-starter：[https://github.com/mybatis/spring-boot-starter](https://github.com/mybatis/spring-boot-starter)
- PageHelper：[https://github.com/pagehelper/Mybatis-PageHelper](https://github.com/pagehelper/Mybatis-PageHelper)
- pagehelper-spring-boot：[https://github.com/pagehelper/pagehelper-spring-boot](https://github.com/pagehelper/pagehelper-spring-boot)
- MyBatis-Plus 插件主体：[https://baomidou.com/plugins/](https://baomidou.com/plugins/)
- MyBatis-Plus 多租户插件：[https://baomidou.com/plugins/tenant/](https://baomidou.com/plugins/tenant/)
- MyBatis-Plus 字段类型处理器：[https://baomidou.com/guides/type-handler/](https://baomidou.com/guides/type-handler/)
- dynamic-datasource：[https://github.com/baomidou/dynamic-datasource](https://github.com/baomidou/dynamic-datasource)
- Hibernate ORM 文档：[https://hibernate.org/orm/documentation/](https://hibernate.org/orm/documentation/)
- Jakarta Persistence 3.2：[https://jakarta.ee/specifications/persistence/3.2/](https://jakarta.ee/specifications/persistence/3.2/)

> 下一篇：[列式与 OLAP 数据库](../4_nosql/0_column_db) —— 列式存储与 OLAP 引擎：ClickHouse、Apache Doris / StarRocks 的原理与选型。
