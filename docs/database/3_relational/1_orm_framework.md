# Orm Frameworks

## 一、Mybatis

### 1、Mybatis的缓存机制

### 2、Mybatis分页原理

### 3、Mybatis工作原理

### 4、Mapper 接口的实现原理

### 5、MyBatis 执行器

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

todo

## 三、Hibernate

详细配置见：[Hibernate-官网](https://hibernate.org/)，此处不做赘述；
