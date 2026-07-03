# Java 专项-序列化

## 一、Java 原生序列化

实现 `Serializable` 接口（标记接口，无方法），JVM 自动处理对象的二进制转换。

```java
public class User implements Serializable {
    private static final long serialVersionUID = 1L; // 版本号
    private String name;
    private transient String password; // transient：不参与序列化
    private static int count;          // static：不属于对象状态，不序列化
}
```

### serialVersionUID

- 序列化时写入文件，反序列化时比对，不一致抛 `InvalidClassException`
- 不声明时 JVM 自动根据类结构计算，类结构一改就变——**必须显式声明**
- 版本兼容演进：新增字段赋默认值可兼容；删字段、改类型不兼容

### 自定义序列化

```java
private void writeObject(ObjectOutputStream oos) throws IOException {
    oos.defaultWriteObject();
    oos.writeObject(encrypt(password)); // 自定义字段处理
}

private void readObject(ObjectInputStream ois) throws IOException, ClassNotFoundException {
    ois.defaultReadObject();
    this.password = decrypt((String) ois.readObject());
}
```

### 原生序列化的缺点

- 性能差：序列化后体积大，速度慢
- 只支持 Java：跨语言不兼容
- 安全风险：反序列化漏洞（如 Apache Commons Collections 历史漏洞）
- 不支持向前兼容的复杂演进

---

## 二、序列化框架对比

| 框架 | 格式 | 跨语言 | 性能 | 体积 | 适用场景 |
|------|------|--------|------|------|----------|
| Java 原生 | 二进制 | ❌ | 差 | 大 | 简单 JVM 内使用 |
| **Kryo** | 二进制 | ❌ | **极快** | 小 | Flink、Spark 等高性能场景 |
| **Protobuf** | 二进制 | ✅ | 快 | **最小** | 跨语言 RPC、gRPC |
| **Hessian** | 二进制 | 有限 | 中 | 中 | Dubbo 默认 |
| **Jackson** | JSON | ✅ | 中 | 大 | HTTP API、可读性要求高 |
| **Fastjson2** | JSON | ✅ | 快 | 大 | 国内项目 JSON 处理 |
| **Avro** | 二进制 | ✅ | 快 | 小 | Kafka Schema Registry |

---

## 三、JSON 序列化（Jackson 重点）

### 常用注解

```java
@JsonProperty("user_name")        // 指定 JSON 字段名
@JsonIgnore                        // 忽略该字段
@JsonFormat(pattern = "yyyy-MM-dd HH:mm:ss", timezone = "GMT+8")
private LocalDateTime createTime;

@JsonInclude(JsonInclude.Include.NON_NULL) // 类级别：null 字段不序列化
public class UserDTO { ... }
```

### 常见坑

```java
// LocalDateTime 需注册 JavaTimeModule
ObjectMapper mapper = new ObjectMapper();
mapper.registerModule(new JavaTimeModule());
mapper.disable(SerializationFeature.WRITE_DATES_AS_TIMESTAMPS);

// Long 精度丢失（JS Number 只有 53 位精度）
// 解决：Long 字段序列化为 String
@JsonSerialize(using = ToStringSerializer.class)
private Long id;
```

---

## 四、Protobuf

```protobuf
syntax = "proto3";
message User {
    int64 id = 1;
    string name = 2;
    repeated string roles = 3;
}
```

- 字段编号（1, 2, 3）决定二进制格式，**修改已有编号会破坏兼容性**
- 新增字段向后兼容；删除字段用 `reserved` 声明编号不可复用
- Java 生成的类是不可变的 Builder 模式

---

## 五、反序列化安全

Java 原生反序列化漏洞原理：`readObject` 会执行对象中的自定义逻辑，攻击者可构造恶意序列化数据触发任意代码执行。

**防护措施**：
- 不要反序列化不可信来源的数据
- 使用 `ObjectInputFilter` 限制可反序列化的类白名单（Java 9+）
- 升级有漏洞的依赖（Commons Collections、Spring 等）
- 优先使用 JSON/Protobuf 替代原生序列化

---

## 六、常见面试问题

**Q：transient 和 static 的区别？**
`transient` 明确标记该字段不参与序列化；`static` 字段属于类而非对象，天然不被序列化（但如果反序列化后访问 static 字段，会读到 JVM 中当前的静态值）。

**Q：为什么 Kryo 比 Java 原生快？**
原生序列化写入大量元数据（类名、字段名等）；Kryo 用数字 ID 替代类名，不写字段名，且使用变长编码，体积更小、速度更快。

**Q：如何实现对象深拷贝？**
序列化后反序列化是一种通用深拷贝方案（Jackson `convertValue`、Kryo 等均可），但有性能开销；更高效的方案是手动实现 `clone()` 或使用 MapStruct。
