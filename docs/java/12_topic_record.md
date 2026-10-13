---
description: record 构造器与限制、Jackson 3 DTO、sealed 穷举、模式匹配、支付结果建模
---

# Record、Sealed 与模式匹配

> 前置阅读：[面向对象与 Object](./10_topic_basics)、[枚举](./12_topic_enum)

record、sealed 和模式匹配让 Java 能简洁地表达「数据 + 有限种类型」。本篇讲三者的规则与限制，并用它们为支付结果建模，基线为 JDK 21 / 25。

---

## 一、Record：透明的数据载体

各特性从预览到正式的版本路线见 [版本演进](./2_version#_4、record-java-16)，这里只讲用法与规则。

### 1、编译器生成了什么

```java
public record Point(int x, int y) { }
```

这一行等价于手写：

- `private final int x; private final int y;`，类本身隐式 `final`，隐式继承 `java.lang.Record`
- **规范构造器** `Point(int x, int y)`，按声明顺序给所有字段赋值
- **访问器** `x()`、`y()`，与组件同名，不是 `getX()`
- `equals`：同类型且每个组件都相等（基本类型按 `==` 比较，引用类型按 `Objects.equals` 语义）
- `hashCode`：由全部组件计算；`toString`：形如 `Point[x=1, y=2]`

record 的定位是「状态即 API」：组件列表就是它的全部状态，构造、访问、比较都由组件决定，所以叫透明数据载体。值对象、DTO、方法的多返回值、`Map` 的复合 key 都是典型用途。

### 2、规范构造器与紧凑构造器

```java
public record Money(long cents, String currency) {

    // 紧凑构造器：没有参数列表，用于校验和规范化，字段赋值由编译器在末尾补上
    public Money {
        if (cents < 0) throw new IllegalArgumentException("cents < 0");
        currency = currency.toUpperCase();   // 可以重新给参数赋值，不能写 this.currency = ...
    }

    // 非规范构造器：必须先委托给规范构造器
    public Money(long cents) {
        this(cents, "CNY");
    }

    // 静态工厂与实例方法都可以有
    public static Money zero() { return new Money(0); }
    public Money plus(Money other) { return new Money(cents + other.cents, currency); }
}
```

- 紧凑构造器与显式写出的规范构造器二选一，不能同时出现；显式规范构造器必须给每个字段赋值
- 规范构造器的访问级别不能低于 record 本身（`public record` 的规范构造器必须是 `public`）
- 非规范构造器第一句必须是 `this(...)`；JDK 25 起（灵活构造器体，JEP 513）`this(...)` 之前可以写不访问 `this` 的校验语句
- 显式写访问器时必须是 `public`，返回类型与组件一致，且不能声明 `throws`

### 3、浅不可变：可变组件要防御性拷贝

record 的字段是 `final`，但引用的对象本身可能是可变的：

```java
public record Order(String id, List<String> items) {
    public Order {
        items = List.copyOf(items);   // 拷贝成不可变列表，外部再改原列表不影响 record
    }
}
```

- 不拷贝的话，调用方持有原列表的引用，改了它就等于改了 record 的状态，也会改变 `hashCode`，作为 `HashMap` 的 key 时会「丢」
- **数组组件是个坑**：生成的 `equals` 对数组比较的是引用，两个内容相同的 `record R(int[] data)` 不相等；需要数组时用 `List`，或自己重写 `equals` / `hashCode` / `toString`（用 `Arrays.equals` 等）
- `toString` 会输出全部组件，含密码、令牌等敏感字段时要重写

不可变类的通用写法见 [面向对象与 Object · 不可变类的基本写法](./10_topic_basics#六、不可变类的基本写法)。

### 4、record 的限制

| 不能做 | 原因 / 替代 |
|--------|-------------|
| 继承其他类 | 隐式继承 `Record`；可以实现接口 |
| 被继承 | 隐式 `final`，可作为 sealed 接口的实现 |
| 声明额外的实例字段 | 状态只能来自组件；可以有 `static` 字段 |
| 修改字段 | 字段 `final`，「修改」写成返回新对象的 `withXxx` 方法 |
| 有无参构造器 | 需要无参构造 + setter 的框架（JPA 实体）不能用 record |

可以做的：实现接口、声明静态与实例方法、嵌套类型、泛型（`record Pair<A, B>(A first, B second)`）、在方法内声明局部 record（隐式 `static`，不捕获外部变量）、在组件上加注解（注解会按目标传播到字段、访问器或构造器参数）。

### 5、作为 DTO：Jackson 3 与 Spring Boot 4

Boot 4 默认使用 Jackson 3，record 可以直接作为请求体和响应体，Jackson 通过规范构造器反序列化，不需要 `@JsonCreator`、无参构造器或 setter：

```java
public record CreateOrderRequest(
        @NotBlank String userId,
        @NotEmpty List<@Valid OrderItem> items,
        @JsonProperty("coupon_code") String couponCode,   // 注解仍在 com.fasterxml.jackson.annotation
        Integer pointsToUse                               // 可选数值用包装类型
) { }

public record OrderItem(@NotBlank String skuId, @Positive int quantity) { }

@PostMapping("/orders")
public OrderView create(@Valid @RequestBody CreateOrderRequest request) { ... }
```

- Bean Validation 注解写在组件上即可生效，`@Valid` 用法与普通类相同，见 [Web 开发 · 参数校验](/spring-boot/2_web_dev#三、参数校验)
- **Jackson 3 默认开启 `FAIL_ON_NULL_FOR_PRIMITIVES`**：JSON 里缺少或为 null 的字段如果对应 `int` / `long` 组件，反序列化直接失败（Jackson 2 会给 0）。可选字段用包装类型，或在紧凑构造器里补默认值
- Jackson 3 默认 `FAIL_ON_UNKNOWN_PROPERTIES` 关闭、`SORT_PROPERTIES_ALPHABETICALLY` 开启（输出按字母序，`@JsonPropertyOrder` 可改）；升级过渡期可设 `spring.jackson.use-jackson2-defaults=true`，Boot 4 的 Jackson 配置见 [Web 开发 · Jackson 3](/spring-boot/2_web_dev#_2、jackson-3)
- 除 Web DTO 外，`@ConfigurationProperties` 配置类（构造器绑定）、`JdbcClient` / Spring Data 的查询投影都适合用 record；JPA 实体不行，但 Hibernate 6.2 起 record 可以作为 `@Embeddable`
- 原生序列化下 record 反序列化同样走规范构造器，紧凑构造器里的校验会执行，见 [序列化 · enum 与 record](./19_topic_serialization#_6、enum-与-record)；与 Lombok `@Value` 的取舍见 [效率工具库](./98_dev_tool)

---

## 二、Sealed：限定子类型

### 1、permits 与子类的三种修饰

```java
public sealed interface Shape permits Circle, Rect, Polygon { }

public record Circle(double r) implements Shape { }               // record 隐式 final
public final class Rect implements Shape { /* ... */ }            // final：到此为止
public non-sealed class Polygon implements Shape { /* ... */ }    // non-sealed：重新开放，任何类可继承
```

规则：

- 每个被许可的子类型必须**直接**继承 / 实现 sealed 类型，并且必须声明为 `final`、`sealed` 或 `non-sealed` 三者之一（record 和 enum 隐式 `final`，不用写）
- 子类型与 sealed 类型必须在同一个模块；没有使用模块（未命名模块）时必须在同一个包
- 所有子类型都写在同一个源文件里时，`permits` 子句可以省略，由编译器推断
- sealed 是在类文件里记录 `PermittedSubclasses` 属性，JVM 加载时也会校验，不只是编译期约束

### 2、sealed 解决什么问题

- **表达封闭的领域**：「支付结果只有成功、处理中、失败三种」，是领域知识，不应该被随意扩展
- **穷举检查**：`switch` 覆盖全部子类型时不需要 `default`，新增子类型后所有漏处理的 switch 都编译失败
- **对比 `final`**：`final` 不允许任何子类，sealed 允许指定的子类
- **对比枚举**：枚举的每个取值是单例、字段结构相同；sealed 的每个子类型可以携带**不同结构**的数据，且可以有多个实例。两者也可以混用，枚举可以作为 sealed 接口的一个实现，见 [枚举 · 限定名常量与 sealed 接口混用](./12_topic_enum#_2、限定名常量与-sealed-接口混用-java-21)

---

## 三、模式匹配

### 1、instanceof 模式

```java
if (obj instanceof String s && !s.isBlank()) {   // 匹配成功才绑定 s，&& 右侧可直接使用
    System.out.println(s.length());
}

if (!(obj instanceof Order order)) {
    throw new IllegalArgumentException("not an order");
}
order.id();   // 流作用域：取反后提前退出，后面的代码里 order 一定已绑定
```

- 绑定变量的作用域由「哪里一定匹配成功」决定，`||` 右侧不能用
- `obj` 为 null 时 `instanceof` 返回 false，不会抛 NPE

### 2、switch 模式

```java
static String describe(Object obj) {
    return switch (obj) {
        case null -> "null";                                // 不写 case null 时，null 直接抛 NPE
        case Integer i when i > 100 -> "big int " + i;      // when 守卫
        case Integer i -> "int " + i;
        case String s -> "string of length " + s.length();
        case int[] arr -> "int array of " + arr.length;
        default -> obj.getClass().getSimpleName();
    };
}
```

写法规则：

- **穷举**：带模式的 switch（语句和表达式都算）必须覆盖所有可能，要么有 `default`，要么选择子是 sealed 类型并覆盖了全部子类型
- **支配性**：前面的 case 能匹配后面 case 的全部值时，后面的 case 编译报错。例如 `case CharSequence cs` 写在 `case String s` 前面；带守卫的 case 要写在同类型无守卫的 case 之前
- **null**：传统 switch 遇到 null 一律 NPE；只有显式写了 `case null`（可写成 `case null, default ->`）才会进入分支
- **运行期兜底**：穷举的 switch 编译后带有隐藏的默认分支，如果 sealed 类型新增了子类型而使用方没有重新编译，遇到新类型时抛 `MatchException`

### 3、record 模式：解构

record 模式按组件把 record 拆开，并且可以嵌套：

```java
record Point(int x, int y) { }
record Line(Point start, Point end) { }

static double length(Object obj) {
    if (obj instanceof Line(Point(var x1, var y1), Point(var x2, var y2))) {   // 嵌套解构，var 推断类型
        return Math.hypot(x2 - x1, y2 - y1);
    }
    return 0;
}
```

- 解构调用的是访问器方法，所以自定义的访问器逻辑会生效
- 组件为 null 时，嵌套的 record 模式不匹配（`Line(null, p)` 不能匹配 `Line(Point(var a, var b), _)`），类型模式 `Point p` 则可以匹配 null 组件
- 泛型 record 的类型参数可以推断：`case Pair<String, Integer>(var k, var v)` 可以简写为 `case Pair(var k, var v)`

### 4、未命名变量 _（JDK 22+）

JDK 22（JEP 456）起，用不到的变量和模式组件可以写成 `_`：

```java
case Line(Point start, _) -> start.x();          // 只关心起点
case Circle _, Square _ -> "有规则形状";          // 多个模式共用一个分支（模式里不能有绑定变量）

try { ... } catch (NumberFormatException _) { return 0; }
map.forEach((_, v) -> total.add(v));
for (var _ : list) count++;
```

`_` 不是变量名，不能被读取，同一作用域里可以出现多次。JDK 21 中这是预览特性，生产代码要求 JDK 22 及以上，LTS 中即 JDK 25。

### 5、原始类型模式（仍是预览）

让 `instanceof` 和 `switch` 支持 `int`、`long`、`double` 等原始类型模式，`instanceof int` 的语义是「能否无损转换为 int」。JDK 23 首次预览，JDK 25（JEP 507）、26（JEP 530）、27（JEP 532）仍为预览，需要 `--enable-preview`，不要用在生产代码中，示例见 [版本演进 · 原始类型模式匹配](./2_version#_3、原始类型模式匹配-第三次预览-jep-507)。

---

## 四、实战：用 sealed + record + switch 建模支付结果

支付渠道回调后，订单服务要根据结果决定下一步动作。传统写法是一个大而全的 `PayResultDTO`（`status` 字符串 + 一堆可能为 null 的字段）加 `if-else`，问题是：某个状态下哪些字段有效靠约定，新增状态时漏改分支编译器也不会提醒。

### 1、建模：每种结果只带自己需要的数据

```java
@JsonTypeInfo(use = JsonTypeInfo.Id.NAME, property = "status")
@JsonSubTypes({
        @JsonSubTypes.Type(value = PaymentResult.Success.class, name = "SUCCESS"),
        @JsonSubTypes.Type(value = PaymentResult.Pending.class, name = "PENDING"),
        @JsonSubTypes.Type(value = PaymentResult.Failed.class, name = "FAILED")
})
public sealed interface PaymentResult {   // 子类型都在本文件内，permits 省略

    String orderNo();

    record Success(String orderNo, String txnId, long paidCents, Instant paidAt) implements PaymentResult { }

    record Pending(String orderNo, String txnId, Duration retryAfter) implements PaymentResult { }

    record Failed(String orderNo, FailReason reason, String channelMessage) implements PaymentResult { }

    enum FailReason { INSUFFICIENT_BALANCE, CARD_EXPIRED, RISK_REJECTED, CHANNEL_TIMEOUT }
}
```

- `Success` 一定有交易号和金额，`Failed` 一定有失败原因，不存在「成功但没有交易号」这种非法状态
- 渠道回调的 JSON 通过 `status` 字段区分子类型，Jackson 按 `@JsonSubTypes` 反序列化成对应的 record
- 公共字段（`orderNo`）声明在接口上，每个 record 的同名组件自动实现它

### 2、处理：穷举的 switch

```java
public sealed interface OrderAction {
    record MarkPaid(String orderNo, String txnId, long cents) implements OrderAction { }
    record ScheduleQuery(String orderNo, Duration delay) implements OrderAction { }
    record ManualReview(String orderNo) implements OrderAction { }
    record CloseOrder(String orderNo, String reason) implements OrderAction { }
}

static OrderAction decide(PaymentResult result) {
    return switch (result) {
        case Success(var orderNo, var txnId, var cents, _) ->
                new MarkPaid(orderNo, txnId, cents);

        case Pending(var orderNo, _, var retry) when retry.toMinutes() >= 30 ->
                new ManualReview(orderNo);                       // 等待过久转人工
        case Pending(var orderNo, _, var retry) ->
                new ScheduleQuery(orderNo, retry);               // 延迟主动查单

        case Failed(var orderNo, var reason, _) when reason == FailReason.CHANNEL_TIMEOUT ->
                new ScheduleQuery(orderNo, Duration.ofSeconds(30));   // 超时不等于失败，先查单
        case Failed(var orderNo, var reason, _) ->
                new CloseOrder(orderNo, reason.name());
    };   // 覆盖了 PaymentResult 全部子类型，不需要 default
}
```

（示例省略了 `import static` 与嵌套类型的导入。）

这套写法的收益：

- **编译器兜底**：将来新增 `Refunded` 结果，`decide` 以及所有对 `PaymentResult` 做穷举 switch 的地方都会编译失败，不会漏处理
- **不写 default**：写了 `default` 就等于放弃了穷举检查，新增子类型会被悄悄归入默认分支
- **数据与行为分离**：record 只装数据，处理逻辑集中在 switch 里；新增「操作」只需新写一个 switch，不用改每个子类型。反过来，如果子类型经常新增而操作很少变，传统的多态方法（每个子类重写）更合适
- 与访问者模式相比，省掉了 `accept` / `visit` 的双重分派样板代码，见 [访问者模式](/patterns/22_behavioral_visitor)；订单生命周期本身的状态流转更适合用状态机建模，见 [状态模式](/patterns/19_behavioral_state)

---

## 小结

- record 是透明数据载体：自动生成规范构造器、访问器、`equals` / `hashCode` / `toString`；紧凑构造器做校验和规范化，可变组件要防御性拷贝，数组组件的 `equals` 比较引用
- record 不能继承、不能有额外实例字段、没有无参构造器，适合 DTO、值对象、配置类和查询投影，不适合 JPA 实体
- Boot 4 默认 Jackson 3，record 直接作为请求 / 响应体；注意 `FAIL_ON_NULL_FOR_PRIMITIVES` 默认开启，可选数值组件用包装类型
- sealed 用 `permits` 限定直接子类型，子类型必须是 `final` / `sealed` / `non-sealed`；它让 switch 可以做穷举检查
- switch 模式要求穷举、遵守支配性规则，null 只有写了 `case null` 才进分支；record 模式可嵌套解构，`_`（JDK 22+）省略不关心的部分；原始类型模式到 JDK 27 仍是预览
- sealed + record + 穷举 switch 能把「哪些状态、各带什么数据、每种怎么处理」交给编译器检查，处理分支里不要写 `default`

## 参考资料

- JEP 395 Records：[https://openjdk.org/jeps/395](https://openjdk.org/jeps/395)
- JEP 409 Sealed Classes：[https://openjdk.org/jeps/409](https://openjdk.org/jeps/409)
- JEP 440 Record Patterns：[https://openjdk.org/jeps/440](https://openjdk.org/jeps/440)
- JEP 441 Pattern Matching for switch：[https://openjdk.org/jeps/441](https://openjdk.org/jeps/441)
- JEP 456 Unnamed Variables & Patterns：[https://openjdk.org/jeps/456](https://openjdk.org/jeps/456)
- JEP 532 Primitive Types in Patterns, instanceof, and switch (Fifth Preview)：[https://openjdk.org/jeps/532](https://openjdk.org/jeps/532)
- Jackson 3 迁移指南：[https://github.com/FasterXML/jackson/blob/main/jackson3/MIGRATING_TO_JACKSON_3.md](https://github.com/FasterXML/jackson/blob/main/jackson3/MIGRATING_TO_JACKSON_3.md)
- Spring Boot JSON 参考文档：[https://docs.spring.io/spring-boot/reference/features/json.html](https://docs.spring.io/spring-boot/reference/features/json.html)

> 下一篇：[内部类](./13_topic_inner_class) —— 嵌套类的四种形态、编译器生成的外部引用，以及它们如何导致内存泄漏。
