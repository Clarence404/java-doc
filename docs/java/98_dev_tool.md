---
description: Lombok、MapStruct、Hutool、Guava 的用法与坑点、JDK 版本兼容、JDK 内置替代
---

# 效率工具库

> **本篇目标**：掌握 Lombok、MapStruct、Hutool、Guava 在后端项目中的正确用法，避开 Lombok 与新 JDK 的兼容问题、Lombok + MapStruct 的构建配置坑、过时的 API 推荐（Guava Cache、EventBus、MD5 存密码等），并知道哪些需求 JDK 本身已经能满足。
>
> **前置阅读**：[Lambda、Stream 与注解](./1_advanced)（注解处理器原理）

> 参考资料：
> * Lombok：[https://projectlombok.org/](https://projectlombok.org/)，变更日志 [https://projectlombok.org/changelog](https://projectlombok.org/changelog)
> * MapStruct 参考文档：[https://mapstruct.org/documentation/stable/reference/html/](https://mapstruct.org/documentation/stable/reference/html/)
> * MapStruct FAQ（与 Lombok 配合）：[https://mapstruct.org/faq/](https://mapstruct.org/faq/)
> * Hutool：[https://github.com/dromara/hutool](https://github.com/dromara/hutool)
> * Guava：[https://github.com/google/guava](https://github.com/google/guava)

IDE 插件与日常软件工具见 [开发工具](/engineering/2_dev_tools)，依赖版本管理见 [依赖治理](/engineering/6_dependency_governance)。本文的版本号以撰写时（2026-10）Maven Central 的版本为例，使用时以最新发布为准。

---

## 一、Lombok

### 1、常用注解

Lombok 在编译期修改 javac 的语法树，生成 getter / setter、构造器、`equals` / `hashCode`、`toString` 等样板代码。

| 注解 | 作用 |
|------|------|
| `@Getter` / `@Setter` | 生成 getter / setter |
| `@ToString` | 生成 `toString`，`@ToString.Exclude` 排除字段 |
| `@EqualsAndHashCode` | 生成 `equals` / `hashCode`，默认包含所有非 static、非 transient 字段 |
| `@Data` | `@Getter` + `@Setter` + `@ToString` + `@EqualsAndHashCode` + `@RequiredArgsConstructor` |
| `@Value` | 不可变类：字段 `private final`，类 `final`，只有 getter |
| `@Builder` | 建造者模式 |
| `@NoArgsConstructor` / `@AllArgsConstructor` / `@RequiredArgsConstructor` | 无参 / 全参 / final 字段构造器；`@RequiredArgsConstructor` 常用于 Spring 构造器注入 |
| `@Slf4j` | 生成 `private static final Logger log` |

```java
@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class UserDTO {
    private Long id;
    private String name;
    @Builder.Default
    private Integer status = 1;     // 不加 @Builder.Default，builder 构建出来的 status 是 null
}

@Service
@RequiredArgsConstructor
public class OrderService {
    private final OrderMapper orderMapper;      // 构造器注入，无需 @Autowired
    private final PaymentClient paymentClient;
}
```

### 2、原理与 JDK 兼容性

标准注解处理器只能生成新文件，Lombok 则借用处理器入口、通过 javac 的**内部 API** 直接改写已有类的语法树（原理见 [Lambda、Stream 与注解](./1_advanced)）。代价是：**每个新 JDK 都可能改动 javac 内部结构，Lombok 必须发布对应的适配版本**，否则编译直接失败。

| JDK | 最低 Lombok 版本 |
|-----|------------------|
| 21 | 1.18.30 |
| 22 | 1.18.32 |
| 23 | 1.18.36 |
| 24 | 1.18.38 |
| 25 | 1.18.40 |
| 26 | 1.18.46 |
| 27 | 1.18.48 |

升级 JDK 时先查 Lombok 变更日志。Spring Boot 的依赖管理会给出 Lombok 版本，但老版本 Boot 管理的 Lombok 未必支持新 JDK，需要用 `lombok.version` 属性覆盖。

**JDK 23 起必须显式声明处理器路径**：javac 默认不再运行类路径上发现的注解处理器。只在 `<dependencies>` 里声明 `lombok`（`provided` 作用域）而没有配置处理器路径的项目，升级到 JDK 23+ 后会出现「找不到 getXxx 方法」「找不到符号 log」等大量编译错误。配置方式见下一节的 Maven 示例；Gradle 用 `annotationProcessor` 依赖配置，不受影响。

### 3、使用坑点

- **JPA / Hibernate 实体上不要用 `@Data`**：生成的 `equals` / `hashCode` / `toString` 会访问所有字段，触发懒加载甚至因双向关联无限递归（`StackOverflowError`）；实体放进 `HashSet` 后修改字段会导致 `hashCode` 变化找不到元素。实体只用 `@Getter` / `@Setter`，`equals` / `hashCode` 基于业务主键手写
- **继承时的 `@EqualsAndHashCode`**：默认 `callSuper = false`，父类字段不参与比较，两个父类字段不同的子类对象会被判为相等；有继承关系时显式写 `callSuper = true`
- **`@Builder` 与 `@NoArgsConstructor` 同时使用**需要再加 `@AllArgsConstructor`，否则编译失败；字段默认值必须配 `@Builder.Default`
- **慎用 `@SneakyThrows`**：它绕过编译器偷偷抛出受检异常，调用方无法 `catch` 具体的受检异常类型
- **测试覆盖率**：在 `lombok.config` 中配置 `lombok.addLombokGeneratedAnnotation = true`，JaCoCo 会自动排除生成代码
- **JDK 16+ 的简单 DTO 优先用 `record`**：不可变、无需任何依赖，替代 `@Value` 足够；需要 builder 或可变性时再用 Lombok

---

## 二、MapStruct

### 1、基本用法

MapStruct 是标准的注解处理器：编译期为 `@Mapper` 接口生成实现类，生成的就是普通的 getter / setter 调用，没有反射，类型不匹配在编译期就会报错。

```java
@Mapper(componentModel = MappingConstants.ComponentModel.SPRING,
        unmappedTargetPolicy = ReportingPolicy.ERROR)      // 目标字段漏映射直接编译失败
public interface UserMapper {

    UserDTO toDTO(User user);

    @Mapping(source = "userName", target = "name")
    @Mapping(source = "createTime", target = "createdAt", dateFormat = "yyyy-MM-dd HH:mm:ss")
    @Mapping(target = "password", ignore = true)
    UserVO toVO(User user);

    List<UserDTO> toDTOList(List<User> users);           // 集合映射自动复用单个对象的映射方法

    @BeanMapping(nullValuePropertyMappingStrategy = NullValuePropertyMappingStrategy.IGNORE)
    void updateFromDTO(UserDTO dto, @MappingTarget User user);   // 局部更新：null 字段不覆盖
}
```

`unmappedTargetPolicy = ReportingPolicy.ERROR` 建议在全局配置（`@MapperConfig` 或编译参数 `-Amapstruct.unmappedTargetPolicy=ERROR`），这样 DTO 新增字段而忘了映射时编译就会失败，而不是上线后才发现字段为 null。

### 2、与 Lombok 配合

两者都是注解处理器，MapStruct 需要看到 Lombok 生成的 getter / setter。**处理器在列表中的顺序并不能保证这一点**，Lombok 1.18.16 起必须额外引入 `lombok-mapstruct-binding`，由它协调两者的执行。

```xml
<properties>
    <java.version>25</java.version>
    <lombok.version>1.18.48</lombok.version>
    <mapstruct.version>1.6.3</mapstruct.version>
    <lombok-mapstruct-binding.version>0.2.0</lombok-mapstruct-binding.version>
</properties>

<dependencies>
    <dependency>
        <groupId>org.mapstruct</groupId>
        <artifactId>mapstruct</artifactId>
        <version>${mapstruct.version}</version>
    </dependency>
    <dependency>
        <groupId>org.projectlombok</groupId>
        <artifactId>lombok</artifactId>
        <version>${lombok.version}</version>
        <scope>provided</scope>
    </dependency>
</dependencies>

<build>
    <plugins>
        <plugin>
            <groupId>org.apache.maven.plugins</groupId>
            <artifactId>maven-compiler-plugin</artifactId>
            <configuration>
                <release>${java.version}</release>
                <annotationProcessorPaths>
                    <path>
                        <groupId>org.projectlombok</groupId>
                        <artifactId>lombok</artifactId>
                        <version>${lombok.version}</version>
                    </path>
                    <path>
                        <groupId>org.projectlombok</groupId>
                        <artifactId>lombok-mapstruct-binding</artifactId>
                        <version>${lombok-mapstruct-binding.version}</version>
                    </path>
                    <path>
                        <groupId>org.mapstruct</groupId>
                        <artifactId>mapstruct-processor</artifactId>
                        <version>${mapstruct.version}</version>
                    </path>
                </annotationProcessorPaths>
                <compilerArgs>
                    <arg>-Amapstruct.unmappedTargetPolicy=ERROR</arg>
                </compilerArgs>
            </configuration>
        </plugin>
    </plugins>
</build>
```

`annotationProcessorPaths` 中的每个 `<path>` 都要写 `<version>`（maven-compiler-plugin 3.12 起才支持从 `dependencyManagement` 读取版本）。一旦配置了 `annotationProcessorPaths`，Maven 只运行列出的处理器，项目中其他处理器（如 `spring-boot-configuration-processor`、Hibernate JPA Metamodel）也要一并加进来。

### 3、对象转换方案对比

| 维度 | Lombok | MapStruct | `BeanUtils.copyProperties`（Spring / Hutool） |
|------|--------|-----------|----------------------------------------------|
| 解决的问题 | 消除样板代码 | 层间对象映射 | 层间对象映射 |
| 实现方式 | 编译期改写 AST | 编译期生成普通 Java 代码 | 运行时反射 |
| 性能 | 无运行时开销 | 等同手写 | 反射开销，热点路径明显 |
| 类型安全 | — | 编译期检查，字段名 / 类型不匹配报错 | 名称相同但类型不同的字段被**静默跳过**，字段改名后悄悄变成 null |
| 适用 | POJO | DTO ⇄ Entity ⇄ VO | 字段完全一致的简单拷贝、原型代码 |

---

## 三、Hutool

### 1、引入方式

国内常用的综合工具库，覆盖字符串、集合、IO、加密、HTTP、Excel、JSON 等。

```xml
<dependency>
    <groupId>cn.hutool</groupId>
    <artifactId>hutool-all</artifactId>
    <version>${hutool.version}</version>   <!-- 5.8.x 稳定线 -->
</dependency>
```

注意版本线：5.x 的 groupId 与包名是 `cn.hutool`；6.x 起改为 `org.dromara.hutool`，包名变化意味着从 5 升到 6 要改所有 `import`。生产项目建议按需引入子模块（`hutool-core`、`hutool-crypto` 等），而不是 `hutool-all` 全家桶，以减小依赖面。

### 2、常用模块

```java
// 字符串与集合
StrUtil.isBlank(str);
StrUtil.format("Hello {}!", "World");
StrUtil.toCamelCase("user_name");
CollUtil.isEmpty(list);

// 摘要：只用于校验和、签名、去重键，不能用来存密码
String checksum = SecureUtil.sha256(fileContent);

// 对称加密
String encrypted = SecureUtil.aes(key).encryptHex(content);

// 校验
IdcardUtil.isValidCard(idCardNo);
Validator.isMobile(phone);

// ID 生成
long id = IdUtil.getSnowflakeNextId();
String uuid = IdUtil.fastSimpleUUID();

// Excel（需要 hutool-poi + Apache POI）
try (ExcelReader reader = ExcelUtil.getReader(FileUtil.file("data.xlsx"))) {
    List<List<Object>> rows = reader.read();
}
```

### 3、需要避开的用法

- **不要用 MD5 / SHA-256 存储密码**：`SecureUtil.md5(password)` 这类快速哈希可以被 GPU 每秒尝试数十亿次，彩虹表也能直接反查。密码必须用带盐、可调成本的慢哈希（BCrypt、Argon2，Spring Security 的 `PasswordEncoder`），见 [数据安全](/security/7_data_security#密码哈希)。MD5 / SHA 只用于文件校验、缓存键等非安全场景
- **日期处理用 `java.time`，不用 `DateUtil`**：`DateUtil` 基于 `java.util.Date`，可变且时区语义模糊。新代码统一用 `LocalDate` / `LocalDateTime` / `Instant` / `ZonedDateTime` 与 `DateTimeFormatter`，见 [日期与时间](./17_topic_time)

```java
// 替代 DateUtil.now() / DateUtil.parse() / DateUtil.offset()
private static final DateTimeFormatter FMT = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss");

String now = LocalDateTime.now().format(FMT);
LocalDate day = LocalDate.parse("2026-01-01");
LocalDate nextWeek = day.plusDays(7);
```

- **HTTP 调用**：`HttpUtil.get(url)` 默认超时与连接复用不适合生产；服务间调用用 JDK `HttpClient`、Spring `RestClient` 或 OpenFeign，并显式设置超时
- **`BeanUtil.copyProperties`** 的问题同上表，层间映射优先 MapStruct

---

## 四、Guava

### 1、仍然有价值的部分

Google 出品的核心库，以 API 设计严谨著称。Spring Framework 本身并不依赖 Guava；项目里往往是间接引入的（如某些 Google 客户端库），版本冲突很常见，见 [依赖治理](/engineering/6_dependency_governance)。

```xml
<dependency>
    <groupId>com.google.guava</groupId>
    <artifactId>guava</artifactId>
    <version>${guava.version}</version>   <!-- 33.x-jre；注意选择 -jre 而不是 -android 变体 -->
</dependency>
```

JDK 至今没有对应物、仍值得用的功能：

```java
// 多值 Map：一个 key 对应多个 value
ListMultimap<String, String> tags = MultimapBuilder.hashKeys().arrayListValues().build();
tags.put("fruit", "apple");
tags.put("fruit", "banana");
tags.get("fruit");                    // [apple, banana]

// 双向 Map
BiMap<String, Integer> codes = HashBiMap.create();
codes.put("OK", 200);
codes.inverse().get(200);             // "OK"

// 区间与区间集合
Range<Integer> range = Range.closedOpen(1, 10);   // [1, 10)
range.contains(5);                    // true
RangeSet<Integer> free = TreeRangeSet.create();

// 计数集合
Multiset<String> words = HashMultiset.create(List.of("a", "b", "a"));
words.count("a");                     // 2

// 字符串拆分（比 String.split 的正则语义更可控）
List<String> parts = Splitter.on(',').trimResults().omitEmptyStrings().splitToList("a, ,b, c");

// 进程内限流
RateLimiter limiter = RateLimiter.create(100.0);   // 每秒 100 个许可，单机有效
limiter.acquire();
```

`RateLimiter` 只在单 JVM 内生效，分布式限流需要 Redis / 网关层方案。

### 2、已过时、不再推荐的部分

| 功能 | 现状 | 替代方案 |
|------|------|----------|
| `CacheBuilder` / `LoadingCache` | Guava 官方文档建议改用 Caffeine，后者命中率（W-TinyLFU）与并发性能更好，也是 Spring Boot 的默认本地缓存 | [Caffeine](/cache/7_caffeine) |
| `EventBus` | Guava 官方文档已明确不推荐使用：基于反射分发、异常被吞掉、难以追踪调用关系 | Spring `ApplicationEventPublisher` + `@EventListener`，见 [事件机制](/spring/7_event)；或直接使用显式的监听器接口 |
| `ListenableFuture` / `Futures` | JDK 8 起有 `CompletableFuture` | [CompletableFuture](./29_topic_completable_future) |
| `Optional`（Guava 版） | JDK 8 已内置 | `java.util.Optional` |
| `Preconditions` | 仍可用 | `Objects.requireNonNull`、`Objects.checkIndex`（JDK 9） |

### 3、JDK 内置替代

很多早年需要 Guava 的场景，JDK 已经原生支持：

| Guava | JDK 替代 | 版本 |
|-------|----------|------|
| `ImmutableList.of` / `ImmutableMap.of` | `List.of` / `Map.of` / `Set.copyOf`（不可修改、不允许 null） | 9 / 10 |
| `Joiner.on(",").join(...)` | `String.join` / `Collectors.joining` | 8 |
| `Strings.isNullOrEmpty` / `repeat` | `String.isBlank` / `String.repeat` | 11 |
| `IntMath.checkedAdd` | `Math.addExact` / `Math.multiplyExact` | 8 |
| `Files.asCharSource(...).read()` | `Files.readString` | 11 |
| `Lists.newArrayList(...)` | `new ArrayList<>(List.of(...))` | 9 |
| `MoreObjects.firstNonNull` | `Objects.requireNonNullElse` | 9 |
| Hutool `HttpUtil` / 第三方 HTTP 客户端 | `java.net.http.HttpClient` | 11 |
| Lombok `@Value` 不可变 DTO | `record` | 16 |

注意 `ImmutableList.of` 和 `List.of` 都不接受 null，但 `Collectors.toList()` 和 `Stream.toList()` 接受 null，替换时要确认数据中是否可能有 null。

### 4、选型建议

| 场景 | 推荐 |
|------|------|
| 已有 Spring 项目 | 先用 JDK 与 Spring 自带工具（`StringUtils`、`CollectionUtils`、`ObjectUtils`），不够再引第三方 |
| 本地缓存 | Caffeine |
| 进程内事件 | Spring 事件机制 |
| 多值 Map、区间、双向 Map | Guava |
| 国内业务的身份证 / 手机号校验、Excel 快速读写 | Hutool（按需引入子模块） |
| 层间对象映射 | MapStruct |

---

## 小结

- Lombok 通过改写 javac 内部 AST 工作，每个新 JDK 都需要对应版本（JDK 21 → 1.18.30，JDK 25 → 1.18.40）；JDK 23 起必须在 `annotationProcessorPaths` 中显式声明
- 实体类不用 `@Data`，有继承用 `callSuper = true`，builder 默认值加 `@Builder.Default`；简单不可变 DTO 优先 `record`
- MapStruct 与 Lombok 同用时必须引入 `lombok-mapstruct-binding`，处理器路径每项都写版本；开启 `unmappedTargetPolicy = ERROR`
- `BeanUtils.copyProperties` 基于反射且静默跳过类型不匹配的字段，层间映射用 MapStruct
- 密码不能用 MD5 / SHA 存储，用 BCrypt / Argon2；日期用 `java.time` 而不是 `DateUtil`
- Guava Cache 改用 Caffeine，EventBus 改用 Spring 事件；不可变集合、字符串拼接、溢出检查等 JDK 已内置

> 返回：[Java 总览](./0_overview)
