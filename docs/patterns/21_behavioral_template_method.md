---
description: 定义与角色、final 模板与钩子、数据导入示例、JDK 经典例子、模板 + 回调（JdbcTemplate）、继承的坑
---

# 模板方法模式

> **本篇目标**：掌握模板方法「父类定骨架、子类填步骤、钩子可选覆盖」的写法，认识 JDK 与 Spring 中基于继承的经典模板方法，分清它与 Spring 风格的「模板 + 回调」，并知道继承带来的脆弱基类问题。
>
> **前置阅读**：[策略模式](./20_behavioral_strategy)

---

## 一、定义与角色

GoF 的定义：在一个方法中定义算法的骨架，把一些步骤延迟到子类实现，使子类可以在不改变算法结构的情况下，重新定义算法中的某些步骤。

| 角色 | 职责 |
|------|------|
| AbstractClass | 定义模板方法（通常 `final`），以及抽象步骤、默认步骤和钩子 |
| ConcreteClass | 实现抽象步骤，按需覆盖默认步骤和钩子 |

方法分三类：

| 类型 | 写法 | 子类 |
|------|------|------|
| 模板方法 | `public final`，按顺序调用各步骤 | 不能覆盖，保证流程不被改乱 |
| 抽象步骤 | `protected abstract` | 必须实现 |
| 默认步骤 / 钩子 | `protected` 且有默认实现（钩子通常是空实现） | 可选覆盖，在固定的位置插入逻辑 |

![importData() 模板方法的固定流程](../assets/patterns/template_method_flow.svg)

---

## 二、实现示例：数据导入

导入流程固定为「读取 → 解析 → 校验 → 持久化前处理 → 持久化 → 导入后处理」，CSV、JSON 只在解析上不同：

```java
public record UserDTO(String name, String email, String phone) {}

public record ImportResult(boolean success, int count, List<String> errors) {
    static ImportResult success(int count)          { return new ImportResult(true, count, List.of()); }
    static ImportResult failed(List<String> errors) { return new ImportResult(false, 0, errors); }
}

public interface UserRepository {
    int batchInsert(List<UserDTO> users);
}

public abstract class DataImporter<T> {
    private static final System.Logger LOG = System.getLogger(DataImporter.class.getName());

    // 模板方法：final，子类不能改变流程
    public final ImportResult importData(InputStream input) {
        List<String> lines = readLines(input);          // 默认步骤
        List<T> records = parse(lines);                 // 抽象步骤
        List<String> errors = validate(records);        // 默认步骤
        if (!errors.isEmpty()) {
            return ImportResult.failed(errors);
        }
        beforePersist(records);                         // 钩子
        int saved = persist(records);                   // 抽象步骤
        afterImport(saved);                             // 钩子
        LOG.log(System.Logger.Level.INFO, "Imported {0} records", saved);
        return ImportResult.success(saved);
    }

    protected abstract List<T> parse(List<String> lines);

    protected abstract int persist(List<T> records);

    protected List<String> readLines(InputStream input) {
        // 显式指定字符集，不依赖平台默认值
        try (var reader = new BufferedReader(new InputStreamReader(input, StandardCharsets.UTF_8))) {
            return reader.lines().toList();
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    protected List<String> validate(List<T> records) {
        return List.of();                               // 默认不校验
    }

    protected void beforePersist(List<T> records) {}    // 钩子：如脱敏、补默认值

    protected void afterImport(int count) {}            // 钩子：如清缓存、发通知
}

public class CsvUserImporter extends DataImporter<UserDTO> {
    private final UserRepository userRepository;

    public CsvUserImporter(UserRepository userRepository) {
        this.userRepository = userRepository;
    }

    @Override
    protected List<UserDTO> parse(List<String> lines) {
        return lines.stream()
                .skip(1)                                // 跳过表头
                .map(line -> line.split(",", -1))
                .map(p -> new UserDTO(p[0].trim(), p[1].trim(), p[2].trim()))
                .toList();
    }

    @Override
    protected List<String> validate(List<UserDTO> records) {
        return records.stream()
                .filter(u -> !u.email().contains("@"))
                .map(u -> "邮箱格式错误：" + u.email())
                .toList();
    }

    @Override
    protected int persist(List<UserDTO> records) {
        return userRepository.batchInsert(records);
    }
}
```

JSON 版本只需实现两个抽象步骤。以 Jackson 2 为例，`readValue` 抛出受检的 `JsonProcessingException`，在步骤内部转换成非受检异常（Jackson 3 的异常本身就是非受检的）：

```java
public class JsonUserImporter extends DataImporter<UserDTO> {
    private final ObjectMapper mapper;
    private final UserRepository userRepository;

    public JsonUserImporter(ObjectMapper mapper, UserRepository userRepository) {
        this.mapper = mapper;
        this.userRepository = userRepository;
    }

    @Override
    protected List<UserDTO> parse(List<String> lines) {
        try {
            return mapper.readValue(String.join("", lines), new TypeReference<List<UserDTO>>() {});
        } catch (JsonProcessingException e) {
            throw new UncheckedIOException(e);
        }
    }

    @Override
    protected int persist(List<UserDTO> records) {
        return userRepository.batchInsert(records);
    }
}
```

---

## 三、JDK 与框架中的模板方法

基于继承的经典例子：

| 例子 | 模板方法 | 子类实现的步骤 / 钩子 |
|------|----------|----------------------|
| `java.util.AbstractList` | `iterator()`、`indexOf()`、`equals()` 等都基于 `get` / `size` 实现 | 只需实现 `get(int)`、`size()` |
| `java.io.InputStream` | `read(byte[], int, int)` 循环调用单字节 `read()` | 实现抽象的 `read()`，性能敏感时再覆盖批量读 |
| `HttpServlet` | `service()` 按请求方法分派 | 覆盖 `doGet`、`doPost` 等 |
| `AbstractQueuedSynchronizer` | `acquire` / `release` 负责排队、阻塞、唤醒 | 实现 `tryAcquire`、`tryRelease` 等，见 [显式锁（Lock）](/java/25_topic_lock) |
| Spring `AbstractApplicationContext` | `refresh()` 固定容器启动流程 | 钩子 `postProcessBeanFactory`、`onRefresh` |
| Spring Security `AbstractAuthenticationProcessingFilter` | `doFilter` 固定认证流程 | 实现 `attemptAuthentication` |

`AbstractList` 的效果最直观：实现两个方法，就得到一个完整的只读 `List`：

```java
List<Integer> squares = new AbstractList<>() {
    @Override public Integer get(int index) { return index * index; }
    @Override public int size()             { return 10; }
};

System.out.println(squares);               // [0, 1, 4, 9, ..., 81]
System.out.println(squares.contains(49));  // true，contains 由父类基于 get / size 实现
```

---

## 四、模板 + 回调：Spring 的 XxxTemplate

`JdbcTemplate`、`RestTemplate`、`TransactionTemplate` 名字里有 Template，但主要用的不是继承：模板类固定「获取连接 → 执行 → 处理结果 → 释放资源 → 转换异常」的流程，变化的步骤通过**回调接口**（`RowMapper`、`PreparedStatementCreator`、`TransactionCallback`）以参数形式传入。这是模板方法和策略的组合，用组合代替了继承：

```java
List<User> users = jdbcTemplate.query(
        "SELECT id, name FROM t_user WHERE status = ?",
        (rs, rowNum) -> new User(rs.getLong("id"), rs.getString("name")),   // RowMapper 回调
        1);
```

| 维度 | 模板方法（继承） | 模板 + 回调 | 策略 |
|------|------------------|-------------|------|
| 复用机制 | 继承 | 组合，回调作为参数 | 组合 |
| 变化粒度 | 流程中的若干步骤 | 流程中的若干步骤 | 整个算法 |
| 一次调用能否换实现 | 不能，取决于子类 | 能，每次传不同回调 | 能 |
| 典型例子 | `AbstractList`、`HttpServlet` | `JdbcTemplate`、`TransactionTemplate` | `Comparator` |

在现代 Java 里，可变步骤只有一两个时，用 lambda 回调通常比新建子类更简单。

---

## 五、坑

- **忘记把模板方法声明为 `final`**：子类覆盖后可以跳过校验等关键步骤，流程保证就失效了
- **脆弱基类**：父类调整步骤顺序或新增步骤，所有子类都可能受影响；父类要谨慎演进，新增步骤尽量以带默认实现的钩子形式加入
- **构造器里调用可被覆盖的方法**：父类构造器执行时子类字段还没初始化，子类覆盖的方法会读到 `null`
- **继承层次过深**：模板套模板，阅读时要在多层父类之间来回跳。层次超过两层或需要组合多种变化时，改用回调或策略
- **钩子太多**：每个位置都开钩子，子类可以改变的东西太多，等于没有骨架

---

## 小结

- 模板方法 = `final` 的骨架方法 + 抽象步骤 + 可选钩子，流程由父类控制，子类只填空
- JDK 经典例子：`AbstractList`、`InputStream.read`、`HttpServlet.service`、AQS
- Spring 的 `JdbcTemplate` 等是「模板 + 回调」，用组合传入变化的步骤，比继承更灵活
- 注意 `final`、脆弱基类和构造器调用可覆盖方法的问题；变化点少时优先用 lambda 回调

## 参考资料

- Refactoring.Guru Template Method：[https://refactoring.guru/design-patterns/template-method](https://refactoring.guru/design-patterns/template-method)
- Java SE 21 `AbstractList`：[https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/AbstractList.html](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/AbstractList.html)
- Jakarta Servlet `HttpServlet`：[https://jakarta.ee/specifications/servlet/6.0/apidocs/jakarta.servlet/jakarta/servlet/http/httpservlet](https://jakarta.ee/specifications/servlet/6.0/apidocs/jakarta.servlet/jakarta/servlet/http/httpservlet)
- Spring Framework Using JdbcTemplate：[https://docs.spring.io/spring-framework/reference/data-access/jdbc/core.html](https://docs.spring.io/spring-framework/reference/data-access/jdbc/core.html)

> 下一篇：[访问者模式](./22_behavioral_visitor) —— 双分派、record 元素、sealed + switch 替代方案。
