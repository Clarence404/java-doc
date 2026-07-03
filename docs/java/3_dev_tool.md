# 编码效率工具

Java 生态中有大量工具库可以减少样板代码、提升开发效率。本文覆盖项目中最常用的四个：Lombok、MapStruct、Hutool、Guava。

---

## 一、Lombok

官网：[https://projectlombok.org/](https://projectlombok.org/)

通过注解在编译期自动生成样板代码（getter/setter、构造方法、equals/hashCode、toString 等）。

### 常用注解

| 注解 | 作用 |
|------|------|
| `@Getter` / `@Setter` | 生成 getter/setter |
| `@ToString` | 生成 toString |
| `@EqualsAndHashCode` | 生成 equals 和 hashCode |
| `@Data` | 以上全部 + `@RequiredArgsConstructor` |
| `@Builder` | 建造者模式 |
| `@NoArgsConstructor` / `@AllArgsConstructor` | 无参/全参构造 |
| `@Slf4j` / `@Log4j2` | 注入日志对象 `log` |
| `@Value` | 不可变类（所有字段 final + private）|

```java
@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class UserDTO {
    private Long id;
    private String name;
    private Integer age;
}
```

### 注意事项

- 需在 IDE 安装 Lombok 插件（IDEA 内置支持）
- `@EqualsAndHashCode` 默认包含所有非 static 字段，有继承关系时慎用（用 `callSuper=true`）
- `@Builder` 和 `@NoArgsConstructor` 同时使用时需显式加 `@AllArgsConstructor`
- 编译期生成，代码不可见，对部分框架（如 MapStruct）需注意访问方式

---

## 二、MapStruct

官网：[https://mapstruct.org/](https://mapstruct.org/)

基于注解处理器，在编译期自动生成类型安全的 Bean 映射代码，主要用于 DTO ⇄ Entity 转换。

```java
@Mapper(componentModel = "spring")
public interface UserMapper {

    UserDTO toDTO(User user);

    User toEntity(UserDTO dto);

    // 字段名不同时自定义映射
    @Mapping(source = "userName", target = "name")
    @Mapping(source = "createTime", target = "createdAt",
             dateFormat = "yyyy-MM-dd")
    UserVO toVO(User user);

    // 集合映射自动支持
    List<UserDTO> toDTOList(List<User> users);
}
```

### 与 Lombok 配合

```xml
<!-- pom.xml 注意处理器顺序 -->
<plugin>
    <groupId>org.apache.maven.plugins</groupId>
    <artifactId>maven-compiler-plugin</artifactId>
    <configuration>
        <annotationProcessorPaths>
            <path><groupId>org.projectlombok</groupId><artifactId>lombok</artifactId></path>
            <path><groupId>org.mapstruct</groupId><artifactId>mapstruct-processor</artifactId></path>
        </annotationProcessorPaths>
    </configuration>
</plugin>
```

**Lombok 必须在 MapStruct 之前处理**，否则 MapStruct 看不到 getter/setter。

### Lombok vs MapStruct 对比

| | Lombok | MapStruct |
|--|--------|-----------|
| 目标 | 消除样板代码 | 对象转换（DTO ⇄ Entity）|
| 原理 | 编译期注解处理 | 编译期代码生成 |
| 性能 | 优秀 | 优秀（生成的是普通 Java 代码）|
| 适用 | POJO 类 | 层间对象映射 |

---

## 三、Hutool

官网：[https://hutool.cn/](https://hutool.cn/) | GitHub：[https://github.com/dromara/hutool](https://github.com/dromara/hutool)

国内主流的 Java 工具库，"Java 工具库界的瑞士军刀"，覆盖字符串、日期、加密、HTTP、Excel、JSON 等几乎所有常见工具需求。

```xml
<dependency>
    <groupId>cn.hutool</groupId>
    <artifactId>hutool-all</artifactId>
    <version>5.8.25</version>
</dependency>
```

### 常用模块速览

```java
// 字符串工具
StrUtil.isBlank(str);                      // 判空（含空白字符）
StrUtil.format("Hello {}!", "World");      // 占位符格式化
StrUtil.toCamelCase("user_name");          // 转驼峰

// 集合工具
CollUtil.isEmpty(list);
CollUtil.newArrayList("a", "b", "c");
CollUtil.toList(array);

// 日期工具（比 SimpleDateFormat 更简单）
DateUtil.now();                            // 当前时间字符串
DateUtil.parse("2024-01-01");             // 解析
DateUtil.offset(date, DateField.DAY_OF_MONTH, 7);  // 日期偏移

// Bean 工具
BeanUtil.copyProperties(source, target);   // 属性复制
BeanUtil.beanToMap(bean);

// 加密工具
SecureUtil.md5("password");
SecureUtil.sha256("data");
String encrypted = SecureUtil.aes(key).encryptHex(content);

// HTTP 工具
String result = HttpUtil.get("https://api.example.com/users");
String post = HttpUtil.post(url, MapUtil.of("key", "value"));

// Excel 工具（hutool-poi）
ExcelReader reader = ExcelUtil.getReader("data.xlsx");
List<List<Object>> rows = reader.read();

// 身份证/手机号验证
IdcardUtil.isValidCard("110101199001011234");
Validator.isMobile("13800138000");

// 雪花 ID
long id = IdUtil.getSnowflakeNextId();
String uuid = IdUtil.fastSimpleUUID();
```

---

## 四、Guava

官网：[https://github.com/google/guava](https://github.com/google/guava)

Google 出品的 Java 核心库，提供集合、缓存、并发、字符串处理、IO 等高质量工具。Spring 等众多框架内部使用。

```xml
<dependency>
    <groupId>com.google.guava</groupId>
    <artifactId>guava</artifactId>
    <version>33.1.0-jre</version>
</dependency>
```

### 常用功能

```java
// 不可变集合（线程安全、防御性编程）
ImmutableList<String> list = ImmutableList.of("a", "b", "c");
ImmutableMap<String, Integer> map = ImmutableMap.of("k1", 1, "k2", 2);
ImmutableSet<String> set = ImmutableSet.copyOf(sourceSet);

// 多值 Map（一个 key 对应多个 value）
Multimap<String, String> multimap = ArrayListMultimap.create();
multimap.put("fruits", "apple");
multimap.put("fruits", "banana");
multimap.get("fruits");  // ["apple", "banana"]

// 双向 Map（key ⇄ value 互查）
BiMap<String, Integer> biMap = HashBiMap.create();
biMap.put("one", 1);
biMap.inverse().get(1);  // "one"

// 范围
Range<Integer> range = Range.closed(1, 10);  // [1, 10]
range.contains(5);   // true
range.lowerEndpoint(); // 1

// 字符串工具
Joiner.on(", ").skipNulls().join("a", null, "b");  // "a, b"
Splitter.on(",").trimResults().omitEmptyStrings().split("a, ,b, c");

// 本地缓存（轻量级，不需要 Redis 时的首选）
Cache<String, User> cache = CacheBuilder.newBuilder()
    .maximumSize(1000)
    .expireAfterWrite(10, TimeUnit.MINUTES)
    .build();
cache.put("key", user);
User u = cache.getIfPresent("key");

// 事件总线（进程内发布订阅）
EventBus eventBus = new EventBus();
eventBus.register(listener);   // 订阅
eventBus.post(new OrderEvent(order));  // 发布

// 文件与 IO
Files.asCharSource(file, Charsets.UTF_8).read();
Files.asByteSource(file).hash(Hashing.sha256());

// 数学工具
IntMath.checkedAdd(a, b);    // 溢出时抛异常（而非静默返回错误值）
LongMath.log2(n, RoundingMode.CEILING);
```

### Guava vs Hutool 选型

| 场景 | 推荐 |
|------|------|
| 国内项目，需要快速上手 | Hutool（文档中文，API 直观）|
| 需要 ImmutableCollections、EventBus | Guava |
| 本地缓存（轻量，不依赖 Redis）| Guava Cache 或 Caffeine |
| 已有 Spring 项目 | Spring 工具类优先，再考虑 Hutool/Guava |
