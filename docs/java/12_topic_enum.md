---
description: 编译产物与初始化、业务枚举、EnumSet / EnumMap、switch 穷举、序列化与反射、持久化
---

# 枚举

> 前置阅读：[String](./11_topic_string)

本篇讲 javac 为枚举生成的代码与初始化时机、业务枚举的写法，以及枚举在 switch、序列化、反射、数据库与 JSON 中的特殊规则，以 JDK 21 / 25 为基线，与 JDK 8 / 17 不同之处单独标注。

---

## 一、枚举的本质

### 1、javac 生成了什么

```java
public enum Season { SPRING, SUMMER, AUTUMN, WINTER }
```

用 `javap -p Season.class` 查看，结构大致如下：

```java
public final class Season extends java.lang.Enum<Season> {
    public static final Season SPRING;
    public static final Season SUMMER;
    public static final Season AUTUMN;
    public static final Season WINTER;
    private static final Season[] $VALUES;

    public static Season[] values();            // 返回 $VALUES.clone()
    public static Season valueOf(String name);  // 委托 Enum.valueOf(Season.class, name)
    private Season(String name, int ordinal);   // 编译器追加 name 与 ordinal 两个参数
    static {};                                  // 依次 new 出每个常量，再填充 $VALUES
}
```

要点：

- 每个枚举类隐式继承 `java.lang.Enum<E>`，因此不能再 `extends` 其他类，但可以实现接口
- 构造器只能是 `private`（不写修饰符也是 private），外部无法 `new`
- `values()` 每次调用都**克隆**一份数组，热点代码中反复调用会产生无谓的分配，可以缓存为 `List.of(values())`
- `valueOf(name)` 找不到时抛 `IllegalArgumentException`，name 为 null 时抛 NPE，解析外部输入时要处理
- `compareTo` 按 `ordinal()` 比较，`equals` 就是 `==`，比较枚举直接用 `==`，且不会 NPE

### 2、枚举一定是 final 吗

不一定。JLS §8.9 规定：**只有当所有常量都没有类体时，枚举类才隐式为 `final`**。只要有常量带类体（见第三节的 `Operation`），每个这样的常量都会编译成一个匿名子类（`Operation$1` 等），枚举类本身就不是 final；JDK 17 起此时它隐式为 `sealed`，只允许这些常量类继承。

所以「枚举能被继承吗」的准确回答是：**用户代码不能继承枚举**——`extends` 一个枚举类是编译错误，构造器又是 private；但带类体的常量是编译器生成的子类。

### 3、常量何时初始化

枚举常量是 `public static final` 字段，在类初始化（执行 `<clinit>`）时按声明顺序创建，而不是在类加载时。JVM 用类初始化锁保证 `<clinit>` 只执行一次且对其他线程可见（JLS §12.4.2），这就是枚举常量天然线程安全的原因。初始化时机见 [类加载机制](/jvm/2_class_loading)。

由此带来一条编译限制：**枚举构造器中不能访问本类的非常量静态字段**。因为常量在静态字段之前初始化，构造器执行时那些字段还是默认值，编译器直接禁止这种写法。需要按 code 建查找表时，放在常量之后的静态字段或静态块里构建（见下一节）。

---

## 二、带字段与行为的业务枚举

```java
public enum OrderStatus {
    CREATED(10, "待支付"),
    PAID(20, "已支付"),
    SHIPPED(30, "已发货"),
    COMPLETED(40, "已完成"),
    CANCELLED(90, "已取消");

    private final int code;
    private final String desc;

    OrderStatus(int code, String desc) {
        this.code = code;
        this.desc = desc;
    }

    public int getCode() { return code; }
    public String getDesc() { return desc; }

    // 查找表：常量全部创建完后再构建，O(1) 查找，避免每次遍历 values()
    private static final Map<Integer, OrderStatus> BY_CODE = Arrays.stream(values())
            .collect(Collectors.toUnmodifiableMap(OrderStatus::getCode, Function.identity()));

    public static OrderStatus ofCode(int code) {
        OrderStatus s = BY_CODE.get(code);
        if (s == null) {
            throw new IllegalArgumentException("未知订单状态: " + code);
        }
        return s;
    }

    // 允许的状态流转：状态机规则集中在枚举内部
    public boolean canTransitTo(OrderStatus target) {
        return switch (this) {
            case CREATED -> target == PAID || target == CANCELLED;
            case PAID -> target == SHIPPED || target == CANCELLED;
            case SHIPPED -> target == COMPLETED;
            case COMPLETED, CANCELLED -> false;
        };
    }
}

// 使用
OrderStatus current = OrderStatus.ofCode(row.getStatusCode());   // 数据库或接口中的 code
if (!current.canTransitTo(OrderStatus.SHIPPED)) {
    throw new BusinessException("ORDER_STATE_INVALID", "当前状态不能发货: " + current.getDesc());
}
```

- 字段一律 `final`：枚举常量是全局单例，可变字段等于全局可变状态
- `code` 显式定义且永不复用，持久化和接口传输都用它，而不是 `ordinal()`
- 查找表用 `toUnmodifiableMap`，重复 code 会在类初始化时直接失败，比运行时查错更早暴露

---

## 三、常量专属方法体：枚举作为策略

```java
public enum Operation implements DoubleBinaryOperator {
    PLUS("+") {
        @Override public double applyAsDouble(double x, double y) { return x + y; }
    },
    MINUS("-") {
        @Override public double applyAsDouble(double x, double y) { return x - y; }
    },
    TIMES("*") {
        @Override public double applyAsDouble(double x, double y) { return x * y; }
    };

    private final String symbol;

    Operation(String symbol) { this.symbol = symbol; }

    @Override public String toString() { return symbol; }
}

double result = Operation.PLUS.applyAsDouble(3, 4);   // 7.0
DoubleBinaryOperator op = Operation.TIMES;              // 可以当作普通接口实现传递
```

- 每个常量用类体实现接口方法（或枚举中声明的 `abstract` 方法），新增常量时编译器强制补齐实现
- 行为差异较小时，更简洁的写法是把 Lambda 作为构造参数：`PLUS("+", (x, y) -> x + y)`，避免生成匿名子类
- 枚举适合「取值固定、随代码发布」的策略；需要运行时扩展（插件、按租户配置）的策略，用接口加 Spring Bean 注册更合适

---

## 四、EnumSet 与 EnumMap

二者是 `Set<E extends Enum>` 和 `Map<E extends Enum, V>` 的专用实现，都依赖 `ordinal()`，但结构不同：

| | 底层结构 | 说明 |
|--|---------|------|
| `EnumSet` | 位向量 | 常量数 ≤ 64 时为 `RegularEnumSet`，用一个 `long` 的位表示成员；超过 64 时为 `JumboEnumSet`，用 `long[]` |
| `EnumMap` | 按 `ordinal()` 下标的数组 | `vals[e.ordinal()]` 直接存取，无哈希、无冲突 |

```java
// EnumSet：集合运算就是位运算
EnumSet<OrderStatus> finished = EnumSet.of(OrderStatus.COMPLETED, OrderStatus.CANCELLED);
EnumSet<OrderStatus> active   = EnumSet.complementOf(finished);
boolean isActive = active.contains(order.status());       // 一次位与运算

// EnumMap：迭代顺序即声明顺序
EnumMap<OrderStatus, Long> countByStatus = orders.stream()
        .collect(Collectors.groupingBy(Order::status,
                () -> new EnumMap<>(OrderStatus.class), Collectors.counting()));
```

- 二者都不是线程安全的，需要并发访问时用 `Collections.synchronizedMap` 包装或换成不可变副本
- `EnumSet` 适合替代 `int` 位标志（如权限、开关组合），可读性和类型安全都更好

---

## 五、枚举与 switch

### 1、switch 表达式的穷举检查（Java 14+）

```java
String label = switch (season) {
    case SPRING -> "春";
    case SUMMER -> "夏";
    case AUTUMN -> "秋";
    case WINTER -> "冬";
};   // 覆盖全部常量时不需要 default
```

- **编译期**：漏掉任一常量就编译失败，新增常量时所有 switch 表达式都会被编译器找出来
- **运行期**：如果枚举新增了常量，而使用方没有重新编译（独立编译、独立部署的 jar），switch 遇到未知常量时，JDK 21 起抛 `MatchException`（JDK 17 及以前抛 `IncompatibleClassChangeError`）
- 选择子为 `null` 时抛 NPE；JDK 21 起可以显式写 `case null ->` 处理

穷举检查只针对 switch **表达式**和带模式的 switch；传统的 switch 语句漏写常量不会报错。因此在业务代码里，把「对每个状态分别处理」写成 switch 表达式而不是写 `default`，才能让编译器帮忙兜底。

### 2、限定名常量与 sealed 接口混用（Java 21+）

JEP 441 起，`case` 可以使用带类名的枚举常量，并且枚举可以作为 sealed 接口的一个实现参与穷举：

```java
sealed interface PayResult permits PaySuccess, PayFailure {}
record PaySuccess(String txnId) implements PayResult {}
enum PayFailure implements PayResult { INSUFFICIENT_BALANCE, CARD_EXPIRED }

String message = switch (result) {
    case PaySuccess s -> "支付成功：" + s.txnId();
    case PayFailure.INSUFFICIENT_BALANCE -> "余额不足";
    case PayFailure.CARD_EXPIRED -> "卡已过期";
};   // PaySuccess + PayFailure 的全部常量 = 穷举，无需 default
```

JDK 21 之前，`case` 只能写不带类名的常量，且选择子类型必须就是该枚举本身。

---

## 六、序列化与反射

### 1、序列化：只写名字

枚举的序列化由规范单独规定（Java Object Serialization Specification §1.12）：

- 序列化时只写出常量的 `name()`，字段值不写入
- 反序列化时调用 `Enum.valueOf(类型, name)` 取回**已有**常量，不会创建新对象
- 枚举中定义的 `readObject`、`readResolve`、`writeReplace`、`serialPersistentFields` 等定制方法**全部被忽略**，`serialVersionUID` 固定为 0L

带来的结果：枚举反序列化天然保持单例；但如果发送方的常量在接收方已被删除或改名，反序列化抛 `InvalidObjectException`。跨服务传输时同样要考虑版本兼容。

### 2、反射：无法创建实例

`Constructor.newInstance()` 检测到目标是枚举类时直接抛 `IllegalArgumentException("Cannot reflectively create enum objects")`。

这两点是「枚举单例」能抵御反射和反序列化破坏的原因。单例各种写法的完整对比见 [单例模式](/patterns/1_creational_singleton)。用枚举做单例时注意：常量在类初始化时**立即**创建，构造器中不要做 I/O 或获取连接这类可能失败的重操作——构造器抛出的异常会变成 `ExceptionInInitializerError`，之后每次访问该类都抛 `NoClassDefFoundError`，且无法重试。

---

## 七、持久化与 JSON

### 1、不要持久化 ordinal

`ordinal()` 是声明顺序。在中间插入常量、调整顺序或删除常量，已存储的数值就全部错位，且不会报任何错误。

| 方式 | 存储内容 | 风险 |
|------|---------|------|
| `ordinal()` | 声明序号 | 调整顺序即数据错乱，禁止使用 |
| `name()` | 常量名 | 重命名常量需要迁移数据 |
| 自定义 `code` | 显式编码 | 推荐，常量可以自由重命名、重排 |

### 2、ORM 框架的默认行为

- **JPA / Hibernate**：`@Enumerated` 的**默认值是 `EnumType.ORDINAL`**。至少要写 `@Enumerated(EnumType.STRING)`；用 code 存储时实现 `AttributeConverter<OrderStatus, Integer>`
- **MyBatis**：默认的 `EnumTypeHandler` 存 `name()`，`EnumOrdinalTypeHandler` 存 `ordinal()`；按 code 存储需要自定义 `TypeHandler`（MyBatis-Plus 可用 `@EnumValue` 标注 code 字段）

### 3、Jackson

Jackson 默认按 `name()` 序列化与反序列化。接口约定用 code 时：

```java
public enum OrderStatus {
    // 在第二节的 OrderStatus 上给已有的两个方法加注解

    @JsonValue                 // 序列化输出 code
    public int getCode() { return code; }

    @JsonCreator               // 反序列化按 code 查找
    public static OrderStatus ofCode(int code) {
        OrderStatus s = BY_CODE.get(code);
        if (s == null) {
            throw new IllegalArgumentException("未知订单状态: " + code);
        }
        return s;
    }
}
```

- 未知值默认反序列化失败（`InvalidFormatException`）。上游可能新增状态时，可在某个常量上标 `@JsonEnumDefaultValue` 并开启 `READ_UNKNOWN_ENUM_VALUES_USING_DEFAULT_VALUE`，或开启 `READ_UNKNOWN_ENUM_VALUES_AS_NULL`，避免一次上游发版导致下游全部解析失败
- 对外 API 中的枚举只增不删、不改 code，新增常量前先确认所有消费方能容忍未知值

---

## 小结

- 枚举编译为继承 `Enum` 的类：常量是 `public static final` 字段，`values()` 每次克隆数组，`valueOf` 找不到时抛 `IllegalArgumentException`
- 没有常量类体时枚举隐式 final，有类体时不是 final（JDK 17 起隐式 sealed）；用户代码无法继承枚举
- 常量在类初始化 `<clinit>` 中创建，由类初始化锁保证线程安全；构造器不能访问非常量静态字段
- 业务枚举带显式 `code`、静态查找表和状态流转规则；字段一律 final
- `EnumSet` 是位向量，`EnumMap` 是按 ordinal 下标的数组
- switch 表达式对枚举做穷举检查，JDK 21 起未知常量抛 `MatchException`，支持限定名常量与 sealed 接口混用
- 序列化只写 `name()`，反序列化走 `valueOf`，自定义的 `readResolve` 等方法被忽略；反射不能创建枚举实例
- 持久化与接口传输用 code，不用 ordinal；JPA 默认是 ORDINAL，务必显式配置

## 参考资料

- JLS §8.9 Enum Classes：[https://docs.oracle.com/javase/specs/jls/se21/html/jls-8.html#jls-8.9](https://docs.oracle.com/javase/specs/jls/se21/html/jls-8.html#jls-8.9)
- Java Object Serialization Specification §1.12 Serialization of Enum Constants：[https://docs.oracle.com/en/java/javase/21/docs/specs/serialization/serial-arch.html](https://docs.oracle.com/en/java/javase/21/docs/specs/serialization/serial-arch.html)
- JEP 441 Pattern Matching for switch：[https://openjdk.org/jeps/441](https://openjdk.org/jeps/441)

> 下一篇：[内部类](./13_topic_inner_class) —— 嵌套类的四种形态、编译器生成的外部引用，以及它们如何导致内存泄漏。
