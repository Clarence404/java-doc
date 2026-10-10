---
description: Director 与流式建造者、防御性复制、record 替代、Lombok @Builder
---

# 建造者模式

> 前置阅读：[工厂模式](./2_creational_factory)、[内部类](/java/13_topic_inner_class)

建造者模式有带 Director 的 GoF 版本和《Effective Java》的流式版本。本篇讲如何写出真正不可变的建造者，以及 record 与 Lombok `@Builder` 的取舍和搭配。

---

## 一、定义与角色

### 1、定义

GoF 的定义：将一个复杂对象的**构建**与它的**表示**分离，使得同样的构建过程可以创建不同的表示。

![建造者模式的角色](../assets/patterns/builder-class.svg)

| 角色 | 职责 |
|------|------|
| Builder | 声明构建各部件的步骤（`buildPartA()`、`buildPartB()`）和取结果的方法 |
| ConcreteBuilder | 实现各步骤，暂存部件，最后组装出产品 |
| Director（指挥者） | 按固定顺序调用 Builder 的步骤，封装「怎么组装」 |
| Product | 被构建的复杂对象 |

### 2、两种建造者

- **GoF 建造者**：重点是 Director 封装固定的构建流程，换一个 ConcreteBuilder 就得到不同表示（比如同一份文档流程，产出 HTML 或 PDF）
- **流式建造者**（《Effective Java》第 2 条）：省略 Director，由客户端链式调用 `xxx().yyy().build()`；解决的是**构造参数多、可选项多**的问题。日常 Java 代码里说「建造者」基本指这一种

---

## 二、实现（JDK 21）

### 1、手写流式建造者

```java
import java.time.Duration;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Objects;

public final class ApiRequest {
    private final String url;
    private final String method;
    private final Map<String, String> headers;
    private final String body;
    private final Duration timeout;

    private ApiRequest(Builder b) {
        this.url     = b.url;
        this.method  = b.method;
        this.headers = Collections.unmodifiableMap(new LinkedHashMap<>(b.headers)); // 防御性复制
        this.body    = b.body;
        this.timeout = b.timeout;
    }

    public static Builder builder(String url) {
        return new Builder(url);
    }

    public String url()                  { return url; }
    public String method()               { return method; }
    public Map<String, String> headers() { return headers; }
    public String body()                 { return body; }
    public Duration timeout()            { return timeout; }

    public static final class Builder {
        private final String url;
        private final Map<String, String> headers = new LinkedHashMap<>();
        private String method = "GET";
        private String body;
        private Duration timeout = Duration.ofSeconds(5);

        private Builder(String url) {
            this.url = Objects.requireNonNull(url, "url is required");   // 必填参数放构造方法
        }

        public Builder method(String method)        { this.method = method; return this; }
        public Builder header(String k, String v)   { headers.put(k, v);    return this; }
        public Builder body(String body)            { this.body = body;     return this; }
        public Builder timeout(Duration timeout)    { this.timeout = timeout; return this; }

        public ApiRequest build() {                  // 跨字段校验放 build()
            if (body != null && "GET".equals(method)) {
                throw new IllegalStateException("GET request must not have a body");
            }
            return new ApiRequest(this);
        }
    }
}

// 使用
ApiRequest req = ApiRequest.builder("https://api.example.com/orders")
        .method("POST")
        .header("Content-Type", "application/json")
        .body("""
              {"userId":1001,"productId":2001}
              """)
        .timeout(Duration.ofSeconds(3))
        .build();
```

两个容易写错的地方：

- **集合要复制**：如果只写 `Collections.unmodifiableMap(b.headers)`，包装的仍是 Builder 里那个活的 Map，Builder 被复用后再 `header()` 会改到已经构建好的对象
- **文本块的开头 `"""` 后必须换行**（JLS 3.10.6），`"""{"userId":1001}"""` 写在一行里编译不过

### 2、Director：封装固定的组装顺序

```java
final class RequestDirector {
    // 所有 JSON 接口调用都按同一套步骤组装
    ApiRequest jsonPost(String url, String json) {
        return ApiRequest.builder(url)
                .method("POST")
                .header("Content-Type", "application/json")
                .header("Accept", "application/json")
                .body(json)
                .build();
    }
}
```

GoF 原版里 Director 面向 Builder 接口编程，换 ConcreteBuilder 即可产出不同表示；这里只有一种表示，Director 退化成「预设好的组装流程」，项目中常以静态工厂方法或测试数据工厂的形式出现。

### 3、参数不多时：record 就够了

```java
public record PageQuery(int page, int size, String sort) {
    public PageQuery {                               // 紧凑构造方法：校验与默认值
        if (page < 1) throw new IllegalArgumentException("page must be >= 1");
        if (size <= 0 || size > 500) throw new IllegalArgumentException("size out of range");
        sort = (sort == null) ? "id" : sort;
    }

    public PageQuery(int page) {                     // 常用组合给一个便捷构造方法
        this(page, 20, null);
    }
}
```

record 天然不可变、自带 `equals` / `hashCode`；字段少、可选项少时比建造者简单。可选参数一多（四五个以上）、组合多，再上建造者。

### 4、Lombok @Builder

```java
@Value                              // 所有字段 private final，只有 getter，不可变
@Builder(toBuilder = true)          // toBuilder() 基于已有对象改几个字段生成新对象
@Jacksonized                        // 让 Jackson 反序列化走 Builder（Lombok 1.18.14+）
public class CreateOrderRequest {
    @NonNull Long userId;
    @NonNull Long productId;
    @Builder.Default int quantity = 1;   // 不加 @Builder.Default，字段初始值会被 Builder 忽略
    String couponCode;
    String remark;
}

// 使用
CreateOrderRequest req = CreateOrderRequest.builder()
        .userId(1001L)
        .productId(2001L)
        .quantity(2)
        .couponCode("SAVE10")
        .build();
```

不要用 `@Builder` + `@Data`：`@Data` 会生成 setter，对象不再不可变；而且没有无参构造方法，Jackson 反序列化会失败。要么 `@Value @Builder @Jacksonized`，要么直接用 record。

---

## 三、JDK 与 Spring 中的应用

| 位置 | 说明 |
|------|------|
| `java.net.http.HttpClient.newBuilder()`、`HttpRequest.newBuilder()` | 标准的流式建造者，`build()` 产出不可变对象 |
| `Stream.builder()`、`Locale.Builder`、`Calendar.Builder` | JDK 中的流式建造者 |
| `StringBuilder` | 常被列为建造者，实际是可变的字符累加器；`toString()` 才得到不可变的 `String` |
| Spring `UriComponentsBuilder` | 分步拼装 URI，`build()` 得到 `UriComponents` |
| Spring `RestClient.builder()`、`WebClient.builder()` | 配置 HTTP 客户端 |
| Spring `BeanDefinitionBuilder` | 编程式构建 `BeanDefinition` |
| Spring `ResponseEntity.ok()` | 返回 `BodyBuilder`，链式设置响应头和响应体 |
| Spring Test `MockMvcRequestBuilders.get()` | 静态工厂方法，返回的 `MockHttpServletRequestBuilder` 才是建造者 |

---

## 四、适用场景与常见坑

**适用场景**：

- 构造参数多（四五个以上）且大部分可选，用构造方法会出现一长串重叠构造方法（telescoping constructor）
- 需要不可变对象，又不想让调用方面对一个十几个参数的构造方法
- 构建过程有校验或步骤约束

**常见坑**：

- **校验写在 setter 里**：单字段在各步骤校验，跨字段约束必须放到 `build()`
- **集合不做防御性复制**：见上文 `headers` 的例子
- **Lombok 字段初始值失效**：没有 `@Builder.Default` 时，`builder()` 构建的对象该字段是 `null` / 0
- **字段少也用建造者**：两三个字段直接用构造方法、静态工厂或 record

---

## 五、与相近模式的区别

| 对比项 | 建造者 | 工厂 / 静态工厂 | 抽象工厂 |
|--------|-------|----------------|---------|
| 关注点 | 怎么一步步组装一个复杂对象 | 创建哪个类的对象 | 创建一族相关对象 |
| 返回时机 | 最后调用 `build()` 才返回 | 一次调用立即返回 | 每个 `createX()` 立即返回 |
| 参数 | 多、可选、按需设置 | 少，一次传完 | 通常无参 |

---

## 小结

- GoF 建造者强调 Director 封装构建流程；日常说的建造者是《Effective Java》的流式写法
- 手写建造者：必填参数放 Builder 构造方法，跨字段校验放 `build()`，集合做防御性复制
- 参数少用 record（紧凑构造方法做校验和默认值），参数多再用建造者
- Lombok 用 `@Value @Builder @Jacksonized`，不要搭配 `@Data`；有初始值的字段加 `@Builder.Default`

## 参考资料

- Refactoring.Guru - Builder：[https://refactoring.guru/design-patterns/builder](https://refactoring.guru/design-patterns/builder)
- Project Lombok - @Builder：[https://projectlombok.org/features/Builder](https://projectlombok.org/features/Builder)
- Project Lombok - @Jacksonized：[https://projectlombok.org/features/experimental/Jacksonized](https://projectlombok.org/features/experimental/Jacksonized)
- JLS 3.10.6 Text Blocks：[https://docs.oracle.com/javase/specs/jls/se21/html/jls-3.html#jls-3.10.6](https://docs.oracle.com/javase/specs/jls/se21/html/jls-3.html#jls-3.10.6)
- 《设计模式：可复用面向对象软件的基础》（GoF）、《Effective Java》第 3 版第 2 条

> 下一篇：[原型模式](./5_creational_prototype) —— 复制已有对象来创建新对象，浅拷贝、深拷贝与复制构造方法。
