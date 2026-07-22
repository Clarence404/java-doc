# 建造者模式

**作用**：将复杂对象的**构建过程**与其**表示**分离，通过链式调用逐步配置，最终构建对象。

**应用场景**：
- Lombok `@Builder` 注解（实际项目最常用）
- JDK `StringBuilder`、`HttpClient.newBuilder()`
- Spring `UriComponentsBuilder`、`MockMvcRequestBuilders`
- MyBatis-Plus `LambdaQueryWrapper` 链式构建

---

## 一、手写建造者

```java
public class HttpRequest {
    private final String url;
    private final String method;
    private final Map<String, String> headers;
    private final String body;
    private final int timeoutMs;

    private HttpRequest(Builder b) {
        this.url       = b.url;
        this.method    = b.method;
        this.headers   = Collections.unmodifiableMap(b.headers);
        this.body      = b.body;
        this.timeoutMs = b.timeoutMs;
    }

    public static class Builder {
        private final String url;
        private String method = "GET";
        private Map<String, String> headers = new LinkedHashMap<>();
        private String body;
        private int timeoutMs = 5000;

        public Builder(String url) { this.url = url; }

        public Builder method(String method)    { this.method = method;      return this; }
        public Builder header(String k, String v) { headers.put(k, v);       return this; }
        public Builder body(String body)        { this.body = body;          return this; }
        public Builder timeout(int ms)          { this.timeoutMs = ms;       return this; }

        public HttpRequest build() {
            Objects.requireNonNull(url, "url is required");
            return new HttpRequest(this);
        }
    }
}

// 使用
HttpRequest req = new HttpRequest.Builder("https://api.example.com/orders")
    .method("POST")
    .header("Content-Type", "application/json")
    .header("Authorization", "Bearer " + token)
    .body("""{"userId":1001,"productId":2001}""")
    .timeout(3000)
    .build();
```

---

## 二、Lombok @Builder（实际项目推荐）

```java
@Builder
@Data
public class CreateOrderRequest {
    @NonNull private Long userId;
    @NonNull private Long productId;
    @Builder.Default private int quantity = 1;
    private String couponCode;
    private String remark;
}

// 使用
CreateOrderRequest req = CreateOrderRequest.builder()
    .userId(1001L)
    .productId(2001L)
    .quantity(2)
    .couponCode("SAVE10")
    .build();
```

---

## 三、适用场景

| 场景 | 建议 |
|------|------|
| 参数多（>4）、部分可选 | 用建造者，避免重叠构造方法 |
| 对象不可变（字段 final）| 建造者天然支持，构建后不可修改 |
| 简单对象（2-3 个字段）| 直接构造方法或静态工厂即可 |
