---
description: 类演进兼容规则、Externalizable、record、反序列化过滤器、Jackson 3、框架选型
---

# 序列化

> 前置阅读：[IO 与 NIO](./18_topic_io)

序列化把对象变成字节，用于网络传输、持久化和进程间传递。本篇讲原生序列化演进与陷阱、反序列化过滤器、框架选型、Jackson 3 变化。

---

## 一、Java 原生序列化

选型看体积与速度、跨语言、类演进兼容和安全四件事；候选有 Kryo / Protobuf / Hessian / JSON，Jackson 3 是 Spring Boot 4 默认。

### 1、基本用法

实现 `Serializable`（标记接口，无方法），用 `ObjectOutputStream.writeObject` / `ObjectInputStream.readObject` 读写。

```java
public class User implements Serializable {
    @Serial
    private static final long serialVersionUID = 1L;  // 版本号，必须显式声明
    private String name;
    private transient String password;                 // transient：不参与序列化
    private static int count;                          // static：属于类，不序列化
}
```

- `transient` 字段反序列化后是默认值（null / 0 / false）
- `static` 字段不在流里，反序列化后读到的是当前 JVM 里的类变量值
- `@Serial`（JDK 14）标注 `serialVersionUID`、`writeObject`、`readResolve` 等序列化相关成员，拼错签名时编译器会告警

### 2、serialVersionUID

反序列化时比对流中的 UID 与本地类的 UID，不一致抛 `InvalidClassException`。不声明时由类名、接口、字段、方法签名等计算出来，**加一个方法都会变**，不同编译器生成的合成成员也可能导致不一致，所以必须显式声明，类演进时保持不变。

### 3、类演进兼容规则

UID 相同只保证「能尝试反序列化」，字段变化如何处理由规范第 5.6 节定义：

| 变更 | 规范定性 | 实际行为 |
|------|----------|----------|
| 新增字段 | 兼容 | 新字段取类型默认值（null / 0 / false），**字段初始化器和构造器都不会执行** |
| 删除字段 | 不兼容 | 不抛异常：新类读旧流时忽略多余值；旧类读新流时该字段为默认值，可能破坏旧版本的业务约束 |
| 修改字段类型 | 不兼容 | 基本类型变更抛 `InvalidClassException`；引用类型可能抛 `ClassCastException` |
| 非 static 改为 static、非 transient 改为 transient | 不兼容 | 等同删除字段 |
| 类在继承层次中上移或下移 | 不兼容 | 流中数据顺序对不上 |
| `Serializable` 与 `Externalizable` 互换 | 不兼容 | 流格式不同 |
| 新增 / 删除 `writeObject`、`readObject` | 兼容 | `readObject` 中应先调 `defaultReadObject()` |

**新增字段的坑**：`private List<String> tags = new ArrayList<>();` 这类初始化器在反序列化时不执行，旧数据读出来 `tags` 是 null，后续 `tags.add(...)` 直接 NPE。需要默认值时在 `readObject` 里补：

```java
@Serial
private void readObject(ObjectInputStream in) throws IOException, ClassNotFoundException {
    in.defaultReadObject();
    if (tags == null) {
        tags = new ArrayList<>();
    }
}
```

反序列化不调用本类构造器，而是调用**第一个不可序列化父类**的无参构造器（通常是 `Object`）。父类不可序列化时，它必须有可访问的无参构造器，否则抛 `InvalidClassException`，且父类的字段不会被序列化。

### 4、自定义序列化：writeObject / readObject / readResolve

```java
@Serial
private void writeObject(ObjectOutputStream oos) throws IOException {
    oos.defaultWriteObject();
    oos.writeObject(encrypt(password));      // 敏感字段加密后写出
}

@Serial
private void readObject(ObjectInputStream ois) throws IOException, ClassNotFoundException {
    ois.defaultReadObject();
    this.password = decrypt((String) ois.readObject());
}
```

- `readResolve()`：反序列化后用返回值替换新建的对象，用于保证单例（单例的完整写法见 [单例模式](/patterns/1_creational_singleton)）
- `writeReplace()`：序列化前替换成另一个对象写出，配合 `readResolve` 实现「序列化代理」模式，让反序列化只走公开的构造逻辑
- `serialPersistentFields`：显式声明要序列化的字段列表，与 Java 字段解耦

### 5、Externalizable

`Externalizable` 继承 `Serializable`，所有字段都由你自己写出和读入：

```java
public class Point implements Externalizable {
    private int x;
    private int y;

    public Point() { }                       // 必须有 public 无参构造器

    @Override
    public void writeExternal(ObjectOutput out) throws IOException {
        out.writeInt(x);
        out.writeInt(y);
    }

    @Override
    public void readExternal(ObjectInput in) throws IOException {
        x = in.readInt();
        y = in.readInt();
    }
}
```

与 `Serializable` 的区别：反序列化时**先调用 public 无参构造器**再调 `readExternal`；不写类的字段描述，体积更小；但字段增删、版本兼容全靠手工维护，读写顺序必须严格一致。

### 6、enum 与 record

- **enum**：只写出常量名，反序列化时用 `Enum.valueOf` 找回同一个常量，`serialVersionUID` 固定为 0L，自定义的 `readObject` 等方法会被忽略。枚举天然防止反序列化破坏单例
- **record**（JDK 16 正式）：只序列化组件值，反序列化时**调用规范构造器**，紧凑构造器里的校验会执行；`writeObject` / `readObject` / `serialPersistentFields` 被忽略。新增或删除组件是兼容变更，缺失的组件传默认值

```java
public record Money(String currency, long cents) implements Serializable {
    public Money {
        if (cents < 0) throw new IllegalArgumentException("cents < 0");  // 反序列化时同样校验
    }
}
```

普通类反序列化能绕过构造器，攻击者可以构造出违反不变量的对象；record 堵住了这条路。需要原生序列化的值对象，优先写成 record。

### 7、原生序列化的缺点

- 体积大、速度慢：流里带完整类名、字段描述
- 只支持 Java
- 绕过构造器创建对象，容易破坏不变量
- `readObject` 可以执行任意代码，是反序列化漏洞的根源（见第五节）

---

## 二、序列化框架对比

| 框架 | 格式 | 跨语言 | 性能 | 体积 | 典型场景 |
|------|------|--------|------|------|----------|
| Java 原生 | 二进制 | 否 | 差 | 大 | 遗留系统，新代码不用 |
| Kryo | 二进制 | 否 | 极快 | 小 | Java 内部缓存、Spark（需开启）、Flink 泛型类型兜底 |
| Protobuf | 二进制 | 是 | 快 | 最小 | gRPC、Dubbo Triple、跨语言消息 |
| Hessian2 | 二进制 | 有限（需各语言实现） | 中 | 中 | Dubbo 2.x 默认、Dubbo 3.3 起再次默认 |
| Fastjson2 | JSON / JSONB | 是 | 快 | 中 | Dubbo 3.2 默认、国内项目 JSON |
| Jackson | JSON | 是 | 中 | 大 | HTTP API、Spring 默认 |
| Avro | 二进制 | 是 | 快 | 小 | Kafka + Schema Registry、大数据 |

各框架要点：

- **Kryo**：已注册的类写数字 ID，未注册的类写全类名；Kryo 5 默认要求注册（`setRegistrationRequired(true)`）。`Kryo` 实例**不是线程安全的**，用 `Pool<Kryo>` 或 `ThreadLocal` 复用。Spark 默认用 `JavaSerializer`，需设置 `spark.serializer=org.apache.spark.serializer.KryoSerializer` 才用 Kryo；Flink 用自己的 `TypeSerializer`，只在遇到无法识别的泛型类型时回退到 Kryo
- **Hessian2 / Fastjson2 与 Dubbo**：Dubbo 2.x 默认 hessian2；3.2.0 起 dubbo 协议默认改为 fastjson2；3.3.0 起又改回 hessian2，升级时可用 `prefer-serialization=fastjson2,hessian2` 保持一致。Triple 协议在 IDL 模式下用 Protobuf，详见 [Dubbo](/microservices/4_dubbo)
- **Fastjson**：1.x 的 `autoType` 机制多次出现远程代码执行漏洞，这是业界转向 Fastjson2 或 Jackson 的主因；Fastjson2 默认关闭 autoType，开启时必须配置白名单
- 序列化方式对性能的影响与选型建议见 [IO 与网络优化](/high-perf/9_io_network)

---

## 三、JSON 序列化（Jackson）

### 1、常用注解

```java
@JsonInclude(JsonInclude.Include.NON_NULL)       // 类级别：null 字段不输出
public class OrderDTO {
    @JsonProperty("order_no")                    // 指定 JSON 字段名
    private String orderNo;

    @JsonIgnore                                  // 不参与序列化
    private String internalNote;

    @JsonFormat(pattern = "yyyy-MM-dd HH:mm:ss")  // LocalDateTime 无时区，timezone 对它无效
    private LocalDateTime createTime;

    @JsonFormat(shape = JsonFormat.Shape.STRING, pattern = "yyyy-MM-dd HH:mm:ss", timezone = "Asia/Shanghai")
    private Instant paidAt;                      // Instant / Date / ZonedDateTime 才需要 timezone

    @JsonSerialize(using = ToStringSerializer.class)
    private Long id;                             // 超过 2^53 的 Long 在 JS 中丢精度，输出为字符串
}
```

时区写 `Asia/Shanghai` 这样的区域 ID，而不是固定偏移 `GMT+8`。时间类型的选择见 [日期与时间](./17_topic_time)。

### 2、在 Spring Boot 中使用

Spring Boot 自动配置的 `ObjectMapper`（Boot 4 中是 `JsonMapper`）已经支持 `java.time` 并关闭了「日期写成时间戳」，直接注入使用即可，全局定制用 `spring.jackson.*` 配置或 Builder 定制器。

常见问题都出在自己 `new ObjectMapper()`：Jackson 2 下它不会自动注册 `JavaTimeModule`，`LocalDateTime` 直接报错或被写成数组。必须手动创建时：

```java
// Jackson 2.x
ObjectMapper mapper = JsonMapper.builder()
        .addModule(new JavaTimeModule())
        .disable(SerializationFeature.WRITE_DATES_AS_TIMESTAMPS)
        .build();
```

`ObjectMapper` 线程安全且创建成本高，应全局复用。

### 3、Jackson 3 与 Spring Boot 4

Jackson 3.0 于 2025 年 10 月发布，Spring Framework 7 / Spring Boot 4 默认使用它（Jackson 2 仍可用，但已标记为过时）。升级时注意：

| 变化 | Jackson 2 | Jackson 3 |
|------|-----------|-----------|
| Maven groupId 与包名 | `com.fasterxml.jackson.*` | `tools.jackson.*`；注解仍在 `com.fasterxml.jackson.annotation` |
| `java.time` 支持 | 需 `jackson-datatype-jsr310` 模块 | 内置在 databind 中 |
| 日期默认格式 | `WRITE_DATES_AS_TIMESTAMPS` 默认开启 | 默认关闭，输出 ISO-8601 字符串 |
| 异常 | 受检的 `JsonProcessingException` | 非受检的 `JacksonException` |
| Mapper 配置 | 可变，`configure()` 随时改 | 不可变，通过 `JsonMapper.builder()` 构建，`rebuild()` 派生 |
| JDK 基线 | Java 8 | Java 17 |

```java
// Jackson 3
JsonMapper mapper = JsonMapper.builder().build();
String json = mapper.writeValueAsString(order);   // 不再需要 try-catch 受检异常
```

因为注解包没变，DTO 上的 `@JsonProperty` 等注解通常不用改；要改的是 import 了 `ObjectMapper`、自定义序列化器、模块注册的代码。

---

## 四、Protobuf

```protobuf
syntax = "proto3";
message User {
    int64 id = 1;
    string name = 2;
    repeated string roles = 3;
    reserved 4;            // 已删除字段的编号，禁止复用
}
```

- 二进制格式只写**字段编号 + 类型 + 值**，不写字段名，所以体积小；编号一旦发布不能改
- 新增字段兼容：旧代码读到未知编号时跳过；删除字段时用 `reserved` 保留编号和名称，防止后人复用导致数据错乱
- proto3 中标量字段缺失与默认值无法区分，需要区分时用 `optional`
- `protoc` 生成不可变的消息类，通过 Builder 构建

---

## 五、反序列化安全

原生反序列化会调用流中类的 `readObject` 等方法。攻击者把 classpath 上已有类的方法串成「gadget 链」（如 Commons Collections 的 `InvokerTransformer`），最终触发 `Runtime.exec`，这就是反序列化 RCE。漏洞不在业务类，而在任意可序列化的依赖类，所以只要对不可信数据调用 `readObject` 就有风险。

### 1、反序列化过滤器

| 能力 | 版本 | 用法 |
|------|------|------|
| `ObjectInputFilter`（JEP 290） | JDK 9；回移到 8u121（包名为 `sun.misc`） | 按类名、数组长度、引用数、深度、字节数过滤 |
| 进程级过滤器 | 同上 | `-Djdk.serialFilter=...` 或 `java.security` 中的同名属性 |
| 过滤器工厂（JEP 415） | JDK 17 | `-Djdk.serialFilterFactory` 或 `ObjectInputFilter.Config.setSerialFilterFactory`，按调用上下文组合过滤器 |

```bash
# 只允许业务包与 java.base 的类，其余全部拒绝；同时限制深度与数组长度
-Djdk.serialFilter="com.example.dto.*;java.base/*;maxdepth=20;maxarray=10000;!*"
```

```java
// 针对单个流设置（JDK 9+）
ObjectInputFilter filter = ObjectInputFilter.Config.createFilter("com.example.dto.*;java.base/*;!*");
try (ObjectInputStream in = new ObjectInputStream(input)) {
    in.setObjectInputFilter(filter);
    Object obj = in.readObject();
}
```

### 2、防护清单

- 不对不可信来源的数据做原生反序列化，对外接口用 JSON / Protobuf
- 必须用原生序列化时，配置白名单式的 `jdk.serialFilter`（以 `!*` 结尾）
- JSON 库关闭多态类型自动识别：Fastjson 不开 autoType，Jackson 不用 `enableDefaultTyping` / `activateDefaultTyping` 处理不可信输入
- 及时升级有已知 gadget 的依赖，Web 层通用防护见 [常见漏洞防护](/security/8_vulnerabilities)

---

## 六、序列化与深拷贝

「序列化再反序列化」能得到深拷贝，但慢、要求整棵对象图可序列化，只适合偶尔使用。工程上更推荐：

- **不可变对象**：record 加不可变集合，根本不需要拷贝
- **拷贝构造器或静态工厂**：`new Order(other)`，嵌套对象逐层显式拷贝，意图清楚
- 慎用 `clone()`：浅拷贝、绕过构造器、与 `final` 字段冲突（《Effective Java》第 13 条）
- MapStruct 等映射工具**不是深拷贝工具**：同类型的嵌套属性默认直接复制引用，集合会新建但元素仍是同一批对象
- Jackson 的 `convertValue` 在目标类型与源对象类型相同时直接返回原对象；需要 JSON 往返时用 `readValue(writeValueAsBytes(obj), Type.class)`

---

## 小结

- `serialVersionUID` 必须显式声明；新增字段兼容但不执行初始化器，删除字段不报错但规范定性为不兼容，改类型才会直接失败
- 反序列化不调用本类构造器；`Externalizable` 调 public 无参构造器，record 调规范构造器并执行校验
- enum 按名称序列化，天然防单例破坏；普通单例要靠 `readResolve`
- 原生反序列化不可信数据是 RCE 入口，用 `jdk.serialFilter` 白名单（JDK 9 / 8u121），JDK 17 起可用过滤器工厂按上下文配置
- 框架选型：对外 JSON，跨语言 RPC 用 Protobuf，Java 内部高性能用 Kryo（注意注册与线程安全）；Dubbo 默认序列化在 3.2 是 fastjson2，3.3 起回到 hessian2
- Spring Boot 4 默认 Jackson 3：包名改为 `tools.jackson`，`java.time` 内置，日期默认输出字符串，异常变为非受检

## 参考资料

- Java 对象序列化规范（JDK 21）：[https://docs.oracle.com/en/java/javase/21/docs/specs/serialization/](https://docs.oracle.com/en/java/javase/21/docs/specs/serialization/)
- JEP 290 反序列化过滤：[https://openjdk.org/jeps/290](https://openjdk.org/jeps/290)
- JEP 415 上下文相关的反序列化过滤器：[https://openjdk.org/jeps/415](https://openjdk.org/jeps/415)
- Jackson 3.0 发布说明：[https://github.com/FasterXML/jackson/wiki/Jackson-Release-3.0](https://github.com/FasterXML/jackson/wiki/Jackson-Release-3.0)
- Dubbo 序列化文档：[https://cn.dubbo.apache.org/zh-cn/overview/mannual/java-sdk/reference-manual/serialization/](https://cn.dubbo.apache.org/zh-cn/overview/mannual/java-sdk/reference-manual/serialization/)

> 下一篇：[SPI 机制](./20_topic_spi) —— 框架如何在运行时发现第三方实现：ServiceLoader、Dubbo 扩展点与 Spring Boot 自动配置。
