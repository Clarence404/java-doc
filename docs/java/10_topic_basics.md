---
description: 分派与重写、抽象类与接口、equals / hashCode、Integer 缓存、值传递、BigDecimal 金额
---

# 面向对象与 Object

> 前置阅读：[版本演进](./2_version)

面向对象在 Java 里落到分派规则、类型设计和 `Object` 方法的契约上。本篇讲重载与重写、抽象类与接口、equals / hashCode、自动装箱、值传递和 BigDecimal 金额计算，基线为 JDK 21 / 25。

---

## 一、封装、继承与多态

### 1、三大特性在 Java 里落在哪

| 特性 | Java 中的落点 | 一句话 |
|------|--------------|--------|
| 封装 | `private` 字段 + 方法暴露行为；包与模块（`exports`）控制可见范围 | 外部只能通过方法改状态，不变式由类自己守住 |
| 继承 | `extends` 单继承类、`implements` 多实现接口；`final` 禁止继承，`sealed` 限定子类 | 复用与「是一种」关系；没有「是一种」关系时用组合 |
| 多态 | 方法重写 + 运行期按实际类型调用 | 同一个调用点，不同对象执行不同实现 |

访问修饰符从宽到窄：`public` → `protected`（同包 + 子类）→ 包私有（不写）→ `private`。JDK 9 起模块系统在包之上又加了一层：未 `exports` 的包即使是 `public` 类，模块外也访问不到。

### 2、静态分派与动态分派

Java 的方法选择分两步，很多「多态失灵」的问题都出在把这两步混为一谈：重载是**静态分派**，编译期按参数的**声明类型**选签名；重写是**动态分派**，运行期按接收者的**实际类型**找实现。所以 `Animal a = new Dog(); print(a)` 会选中 `print(Animal)`，但其中 `a.name()` 调的是 `Dog` 的实现。对比表、字节码指令与虚方法表见 [字节码执行 · 静态分派与动态分派](/jvm/3_bytecode#_4、静态分派与动态分派)。

### 3、重载与重写的规则

| 对比 | 重载（Overload） | 重写（Override） |
|------|-----------------|-----------------|
| 发生位置 | 同一个类（或继承来的同名方法） | 子类与父类 / 接口 |
| 方法名 | 相同 | 相同 |
| 参数列表 | 必须不同（个数、类型或顺序） | 必须相同（泛型擦除后一致） |
| 返回类型 | 无要求，不能单靠它区分 | 相同或是其子类型（协变返回） |
| 访问权限 | 无要求 | 不能比父类更严格 |
| 受检异常 | 无要求 | 不能抛出新的或更宽的受检异常 |
| 决定时机 | 编译期 | 运行期 |

重载解析分三个阶段，前一阶段找到就不再往后：① 不装箱、不用可变参数；② 允许装箱拆箱；③ 允许可变参数。一个常见的坑：

```java
List<Integer> list = new ArrayList<>(List.of(1, 2, 3));
list.remove(1);                    // 匹配 remove(int index)，删掉的是下标 1 的元素 2
list.remove(Integer.valueOf(1));   // 匹配 remove(Object o)，删掉的是元素 1
```

重写一律加 `@Override`，签名写错时编译器会报错，而不是悄悄变成重载。

### 4、哪些成员不参与多态

- **`static` 方法**：只能隐藏（hide），不能重写，调用哪个由声明类型决定
- **`private` 方法**：子类看不到，同名方法是另一个新方法
- **`final` 方法**：禁止重写
- **字段**：同名字段只是隐藏，`a.field` 取声明类型的字段，没有动态分派

构造器里也不要调用可被重写的方法：父类构造器执行时子类字段还没初始化，子类重写的方法会读到默认值。

---

## 二、抽象类与接口

### 1、对比

| 对比 | 抽象类 | 接口 |
|------|-------|------|
| 表达 | 「是什么」，同一族类的公共骨架 | 「能做什么」，一种能力或契约 |
| 字段 | 任意实例字段与静态字段 | 只有 `public static final` 常量 |
| 构造器 | 有，子类构造时调用 | 无 |
| 方法 | 抽象 + 具体，任意访问级别 | 抽象、`default`、`static`、`private` |
| 继承数量 | 单继承 | 多实现，接口之间可多继承 |
| 状态 | 可以持有状态 | 不能持有实例状态 |

### 2、接口方法的演进

```java
public interface PaymentChannel {
    String code();                               // 抽象方法，隐式 public abstract

    default boolean supports(String currency) {  // JDK 8：默认方法，实现类可不重写
        return "CNY".equals(currency) && checkEnabled();
    }

    static PaymentChannel noop() {               // JDK 8：静态方法，只能通过接口名调用
        return () -> "NOOP";
    }

    private boolean checkEnabled() {             // JDK 9：私有方法，供默认方法复用
        return true;
    }
}
```

- 默认方法的初衷是**接口演进**：给 `Collection` 加 `stream()` 时不必改动所有实现类，而不是让接口代替抽象类承载逻辑
- 接口的 `static` 方法不会被实现类继承，`ArrayList.of(...)` 编译不过，只能写 `List.of(...)`
- 默认方法不能重写 `Object` 的 `equals` / `hashCode` / `toString`，编译报错

### 3、默认方法冲突的解决规则

一个类从多处继承到同签名的方法时，按以下顺序决定（JLS §8.4.8）：

1. **类优先**：父类（含抽象类）中的方法胜过任何接口的默认方法
2. **更具体的接口优先**：子接口的默认方法胜过父接口的
3. **仍分不出来就编译报错**：实现类必须自己重写，可用 `X.super.m()` 指定调用哪个接口的版本

```java
interface Flyer   { default String move() { return "fly"; } }
interface Swimmer { default String move() { return "swim"; } }

// 规则 3：两个无关接口的默认方法冲突，不重写就编译失败
class Duck implements Flyer, Swimmer {
    @Override
    public String move() {
        return Flyer.super.move() + "+" + Swimmer.super.move();   // "fly+swim"
    }
}

// 规则 2：子接口更具体
interface FastFlyer extends Flyer { default String move() { return "fast fly"; } }
class Eagle implements Flyer, FastFlyer { }          // new Eagle().move() → "fast fly"

// 规则 1：类优先
class Bird { public String move() { return "walk"; } }
class Penguin extends Bird implements Flyer { }      // new Penguin().move() → "walk"
```

`X.super.m()` 只能调用**直接**实现的接口的默认方法，不能跨级调用祖父接口。

### 4、怎么选

- 多个类共享状态和部分实现，且确实是「是一种」关系：抽象类，典型是模板方法，见 [模板方法模式](/patterns/21_behavioral_template_method)
- 描述能力、供多方实现、需要多实现：接口；需要限定实现类范围时用 `sealed interface`
- 两者常组合使用：接口定义契约，抽象类提供骨架实现（如 `List` 与 `AbstractList`）
- 只为复用几个方法而继承是滥用，优先组合

---

## 三、equals 与 hashCode

### 1、equals 的契约

`Object.equals` 默认就是 `==`。按内容比较时，重写必须满足五条（`Object` Javadoc）：

- **自反性**：`x.equals(x)` 为 true
- **对称性**：`x.equals(y)` 与 `y.equals(x)` 结果相同
- **传递性**：`x.equals(y)`、`y.equals(z)` 为 true，则 `x.equals(z)` 为 true
- **一致性**：对象未修改时，多次调用结果相同
- **非空性**：`x.equals(null)` 为 false

配套的 `hashCode` 契约只有一条硬性要求：**`equals` 相等的两个对象，`hashCode` 必须相等**；`hashCode` 相等不要求 `equals` 相等，但冲突越少，哈希表越快。

### 2、正确的实现

```java
public final class Money {
    private final long amount;      // 单位：分
    private final String currency;

    public Money(long amount, String currency) {
        this.amount = amount;
        this.currency = Objects.requireNonNull(currency);
    }

    @Override
    public boolean equals(Object o) {
        if (this == o) return true;
        if (!(o instanceof Money other)) return false;   // JDK 16+ 模式匹配，null 也返回 false
        return amount == other.amount && currency.equals(other.currency);
    }

    @Override
    public int hashCode() {
        return Objects.hash(amount, currency);   // 与 equals 使用同一组字段
    }
}
```

- `equals` 与 `hashCode` 必须使用**同一组字段**，少一个就可能违反契约
- `instanceof` 还是 `getClass()`：类是 `final` 时两者等价；可继承的类用 `instanceof` 时，子类加字段后很难再保持对称性，这时用 `getClass() != o.getClass()` 或干脆把类设计为 `final`
- `Objects.hash` 会创建可变参数数组，极热路径上可以手写 `31 * Long.hashCode(amount) + currency.hashCode()`
- 浮点字段用 `Double.compare` 比较，不用 `==`（`NaN` 与 `-0.0` 的语义不同）
- 纯值对象优先写成 `record`，`equals` / `hashCode` / `toString` 由编译器按组件生成

### 3、违反契约在 HashMap 里的后果

`HashMap` 先用 `hashCode` 定位桶，再在桶内用 `equals` 比较。只重写 `equals` 不重写 `hashCode`：

```java
class Point {
    final int x, y;
    Point(int x, int y) { this.x = x; this.y = y; }
    @Override public boolean equals(Object o) {
        return o instanceof Point p && p.x == x && p.y == y;
    }
    // 没有重写 hashCode：使用 Object 的身份哈希
}

Map<Point, String> map = new HashMap<>();
map.put(new Point(1, 2), "A");
map.get(new Point(1, 2));          // 大概率 null：两个对象 hashCode 不同，落在不同桶
Set<Point> set = new HashSet<>();
set.add(new Point(1, 2));
set.add(new Point(1, 2));          // size 变成 2，「去重」失效
```

另一类问题是 key 放入后再修改参与 `hashCode` 的字段，元素既查不到也删不掉，所以作为 key 的对象应当不可变，详见 [集合框架 · key 的设计](./21_topic_collection#_5、key-的设计)。`TreeMap` 不用 `equals` 而用 `compareTo` 判断相等，`compareTo` 与 `equals` 不一致时同样会「丢」元素。

---

## 四、toString、clone 与 finalize

### 1、toString

默认实现是 `类名@身份哈希的十六进制`，排查问题时几乎没用。值对象、DTO 应重写，输出关键字段；但不要输出密码、令牌、身份证号等敏感字段，日志里的 `toString` 是常见的泄露途径。`record` 自动生成的 `toString` 会输出全部组件，含敏感字段时要自己重写。

### 2、clone：浅拷贝、深拷贝与为什么不推荐

`Object.clone()` 是 `protected native` 方法，类必须实现标记接口 `Cloneable`，否则抛 `CloneNotSupportedException`。默认行为是**浅拷贝**：基本类型字段复制值，引用字段只复制引用，新旧对象共享同一个子对象。

```java
class Order implements Cloneable {
    String id;
    List<String> items = new ArrayList<>();

    @Override
    public Order clone() {
        try {
            Order copy = (Order) super.clone();           // 浅拷贝：items 仍指向同一个列表
            copy.items = new ArrayList<>(this.items);     // 深拷贝要逐个引用字段手动复制
            return copy;
        } catch (CloneNotSupportedException e) {
            throw new AssertionError(e);
        }
    }
}
```

`Cloneable` 机制被普遍认为是设计失误，新代码不建议使用：

- `Cloneable` 接口里没有 `clone` 方法，能否调用取决于类有没有把它重写为 `public`
- 创建对象不经过构造器，构造器里的校验和不变式全部绕过
- 与 `final` 字段冲突：`final` 引用字段无法在 `clone` 里重新赋值，深拷贝做不了
- 必须处理一个实际上不会抛出的受检异常

替代方案是**拷贝构造器**或**静态工厂**，深浅由自己明确控制：

```java
public Order(Order other) {                      // 拷贝构造器
    this.id = other.id;
    this.items = new ArrayList<>(other.items);
}
public static Order copyOf(Order other) { return new Order(other); }
```

数组是例外：`int[]` 的 `clone()` 是复制数组最简洁的写法（对象数组仍是浅拷贝）。不可变对象则根本不需要拷贝，直接共享即可。对象之间的转换（DTO 与实体互转）用 MapStruct 这类编译期生成代码的工具，见 [效率工具库 · MapStruct](./98_dev_tool#二、mapstruct)。

### 3、finalize 已废弃，用 Cleaner 替代

`finalize()` 在 JDK 9 标记废弃，JDK 18 起（JEP 421）标记为待移除。它的问题是：执行时机不确定甚至不执行、拖慢 GC（对象至少要两次 GC 才能回收）、方法里可以让对象「复活」、抛出的异常被静默吞掉。

释放资源的首选是 `AutoCloseable` + try-with-resources；`Cleaner`（JDK 9）只作为调用方忘记 `close()` 时的兜底：

```java
public final class NativeBuffer implements AutoCloseable {
    private static final Cleaner CLEANER = Cleaner.create();

    // 清理动作必须是静态嵌套类，不能引用外部的 NativeBuffer，否则它永远不会变成不可达
    private static final class State implements Runnable {
        private final long address;
        State(long address) { this.address = address; }
        @Override public void run() { freeMemory(address); }   // 释放本地资源
    }

    private final Cleaner.Cleanable cleanable;

    public NativeBuffer(long size) {
        this.cleanable = CLEANER.register(this, new State(allocateMemory(size)));
    }

    @Override
    public void close() {
        cleanable.clean();   // 显式释放；clean() 至多执行一次，GC 兜底时不会重复释放
    }

    private static long allocateMemory(long size) { return size; }  // 示意
    private static void freeMemory(long address) { }                 // 示意
}
```

`Cleaner` 基于虚引用实现，`DirectByteBuffer` 的堆外内存就是这样释放的，引用类型与回收过程见 [GC 原理](/jvm/4_gc_theory)。

---

## 五、包装类与自动装箱

### 1、装箱与拆箱是编译器做的

```java
Integer a = 100;     // 编译为 Integer.valueOf(100)
int b = a;           // 编译为 a.intValue()
a++;                 // 拆箱、加 1、再装箱成一个新对象
```

包装类都是不可变的，`a++` 之后 `a` 指向另一个对象。JDK 9 起包装类的构造器（`new Integer(100)`）已废弃，JDK 16 起标记为待移除，统一用 `valueOf`。

### 2、Integer 缓存

`Integer.valueOf` 对 -128 ~ 127 返回 `IntegerCache` 里预先创建的对象，范围外每次新建：

```java
Integer x = 127, y = 127;
System.out.println(x == y);        // true，同一个缓存对象
Integer p = 128, q = 128;
System.out.println(p == q);        // false（默认配置下），两个不同对象
System.out.println(p.equals(q));   // true
```

- 上界可通过 `-XX:AutoBoxCacheMax=<n>` 调大，它实际设置的是系统属性 `java.lang.Integer.IntegerCache.high`；下界固定为 -128
- `Long` / `Short` / `Byte` 固定缓存 -128 ~ 127，`Character` 缓存 0 ~ 127，`Boolean` 只有两个实例；`Float` / `Double` 没有缓存
- 缓存是享元模式的典型应用，前提是包装类不可变，各类型的缓存范围对照见 [享元模式 · JDK 中的应用](/patterns/11_structural_flyweight#三、jdk-中的应用)

### 3、== 与 equals 的坑

```java
Long id = 1L;
id.equals(1);                      // false：1 装箱成 Integer，类型不同直接返回 false
id.equals(1L);                     // true

Integer i1 = 1000, i2 = 1000;
i1 == i2;                          // false：两个对象比引用
i1 == 1000;                        // true：一边是基本类型，另一边会拆箱后比值
i1.intValue() == i2.intValue();    // true
```

- 包装类之间一律用 `equals` 或 `Objects.equals`（可处理 null），不用 `==`；只在测试里 127 以内「碰巧」相等，上线后数值一大就出错
- `equals` 不会跨类型比较，`Long` 与 `Integer` 永远不相等；跨类型比数值先转成基本类型
- `BigDecimal` 不要用 `equals` 比数值：`new BigDecimal("1.0").equals(new BigDecimal("1.00"))` 为 false（精度不同），比数值用 `compareTo`，金额计算的完整注意事项见第八节

### 4、拆箱 NPE

包装类型为 null 时，任何触发拆箱的地方都会 NPE，而且报错行看起来「没有调用任何方法」：

```java
Map<String, Integer> stock = new HashMap<>();
int n = stock.get("sku-1");                        // get 返回 null，拆箱 NPE

boolean vip = false;
Integer discount = vip ? 10 : stock.get("sku-1");  // NPE！三元运算符一边是 int，整个表达式按 int 类型，null 被拆箱
Integer safe = vip ? Integer.valueOf(10) : stock.get("sku-1");   // 两边都是 Integer，不拆箱
```

- 实体和 DTO 的数值字段用包装类型（能表达「没有值」），方法内部计算用基本类型
- 从 `Map`、数据库、JSON 拿到的包装值先判空，或用 `getOrDefault`
- JDK 14 起（JEP 358）NPE 信息会写明 `because the return value of "java.util.Map.get(Object)" is null`，定位已经很容易

### 5、集合与 Stream 中的性能

集合只能存对象，`List<Integer>` 里每个元素都是一个独立的 `Integer` 对象（开启压缩指针时对象本身 16 字节，再加 4 字节引用），比 `int[]` 每元素 4 字节大好几倍，遍历时还要多一次指针跳转。

```java
long sum1 = list.stream().mapToLong(Integer::longValue).sum();   // 转成 LongStream，后续不再装箱
long sum2 = list.stream().reduce(0, Integer::sum);               // 每一步都拆箱再装箱
int[] arr = IntStream.range(0, 1_000_000).toArray();             // 数值计算直接用原始类型流
```

- 数值计算用 `IntStream` / `LongStream` / `DoubleStream`，以及 `mapToInt`、`sum`、`summaryStatistics` 等原始类型特化方法
- 循环里的累加变量用 `long` 而不是 `Long`，后者每次 `+=` 都会创建新对象
- 大量基本类型数据（百万级 ID、计数器）可以用原始类型数组，或 fastutil、Eclipse Collections 的原始类型集合
- 值类型（Valhalla，JEP 401）目前仍未进入正式版本，JDK 26 / 27 都没有

---

## 六、不可变类的基本写法

不可变对象创建后状态不再改变，天然线程安全，可以放心共享、缓存和作为 `HashMap` 的 key。`String`、包装类、`BigDecimal`、`java.time` 的类型都是不可变的。手写一个不可变类的规则：

- 类声明为 `final`（或构造器私有、只提供静态工厂），防止子类添加可变状态
- 所有字段 `private final`，不提供 setter
- 构造器里对可变参数做**防御性拷贝**，访问器里不直接返回可变字段
- 「修改」方法返回新对象（如 `withAmount`）

```java
public final class OrderSnapshot {
    private final String orderId;
    private final List<String> items;

    public OrderSnapshot(String orderId, List<String> items) {
        this.orderId = Objects.requireNonNull(orderId);
        this.items = List.copyOf(items);      // 防御性拷贝 + 不可变列表，元素不能为 null
    }

    public String orderId() { return orderId; }
    public List<String> items() { return items; }   // 已是不可变列表，可以直接返回

    public OrderSnapshot withItem(String item) {
        List<String> next = new ArrayList<>(items);
        next.add(item);
        return new OrderSnapshot(orderId, next);
    }
}
```

`final` 只保证引用不变，不保证引用的对象不变：`final List<String>` 指向一个 `ArrayList` 时，列表内容仍然可以被修改。`List.copyOf` 与 `Collections.unmodifiableList` 的区别见 [集合框架 · 不可变集合](./21_topic_collection#_2、不可变集合)。

JDK 16 起这类值对象优先写成 `record`，它自动满足前两条规则，但同样只是浅不可变，见 [Record、Sealed 与模式匹配](./12_topic_record)。另外，JDK 26（JEP 500）开始对通过深度反射修改 `final` 字段打印警告，「`final` 就是真的不可变」正在由 JVM 强制保证，见 [版本演进 · Java 26](./2_version#_1、java-26-10-个-jep)。

---

## 七、值传递

### 1、Java 只有值传递

调用方法时，实参的值被**复制**到新的形参变量里（JLS §8.4.1）。基本类型复制的是数值，引用类型复制的是引用（对象地址），对象本身不复制。所以：

- 通过形参**修改对象的状态**，调用方看得到：两个变量指向同一个对象
- 给形参**重新赋值**，调用方看不到：只是让副本指向了别处，原变量不受影响

```java
static void rename(User u) {
    u.setName("Bob");          // 改的是同一个对象，调用方可见
    u = new User("Carol");     // 只改了形参这个副本，调用方的 user 仍指向原对象
}

User user = new User("Alice");
rename(user);
System.out.println(user.getName());   // Bob
```

### 2、swap 为什么写不出来

```java
static void swap(Integer a, Integer b) {
    Integer tmp = a;
    a = b;                     // 只交换了两个形参副本
    b = tmp;
}

Integer x = 1, y = 2;
swap(x, y);
System.out.println(x + "," + y);   // 1,2，没有交换
```

C++ 的引用参数（`int&`）能让形参成为实参的别名，Java 没有这种机制。想「交换」只能交换容器里的元素（如 `Collections.swap(list, i, j)`、交换数组下标），或者返回新值让调用方重新赋值。

- `String`、包装类看起来像「传值」，是因为它们**不可变**：方法里无法修改对象本身，只能让形参指向新对象，调用方当然看不到
- 「引用传递」一词在 Java 里不准确，准确的说法是「按值传递引用」；面试回答时把「复制的是引用」这一点说清楚即可

---

## 八、金额计算与 BigDecimal

### 1、不要用 double 表示金额

`double` 是二进制浮点数，0.1、0.2 这类十进制小数无法精确表示，运算结果带误差：

```java
System.out.println(0.1 + 0.2);            // 0.30000000000000004
System.out.println(1.0 - 0.9);            // 0.09999999999999998
```

单次误差很小，但累加、比较相等、四舍五入时会放大成「对账差一分钱」。金额只有两种正确的表示：`BigDecimal`，或以最小货币单位（分）存的 `long`。

### 2、构造：用 String 或 valueOf

```java
new BigDecimal(0.1);          // 0.1000000000000000055511151231257827021181583404541015625
new BigDecimal("0.1");        // 0.1
BigDecimal.valueOf(0.1);      // 0.1：内部走 Double.toString(0.1)
BigDecimal.valueOf(0.1f);     // 0.10000000149011612：float 先拓宽成 double，误差已经带进来
```

- `new BigDecimal(double)` 精确保留了 `double` 的二进制误差，等于把错误原样搬进来
- 来自接口、数据库、配置的金额本来就是字符串或 `DECIMAL`，直接用 `new BigDecimal(String)`；JDBC 的 `getBigDecimal` 也不经过 `double`
- 整数分转元用 `BigDecimal.valueOf(fen, 2)` 或 `movePointLeft(2)`，不要先除以 100.0

### 3、比较：compareTo 而不是 equals

`BigDecimal` 由「无标度值 + 标度（scale）」组成，`2.0` 是 20 × 10⁻¹，`2.00` 是 200 × 10⁻²。`equals` 同时比较数值和标度：

```java
BigDecimal a = new BigDecimal("2.0"), b = new BigDecimal("2.00");
a.equals(b);                   // false
a.compareTo(b) == 0;           // true，只比较数值
a.stripTrailingZeros().equals(b.stripTrailingZeros());   // true
```

- 判断金额相等、大小一律用 `compareTo`
- `BigDecimal` 作 `HashMap` / `HashSet` 的 key 时，`2.0` 与 `2.00` 是两个 key；需要按数值去重先 `stripTrailingZeros()`，或改用 `TreeMap`（按 `compareTo` 判等）
- 单元测试断言用 AssertJ 的 `isEqualByComparingTo`，见 [单元测试](/testing/1_unit_test)

### 4、除法与舍入：显式写出 scale 和 RoundingMode

```java
BigDecimal total = new BigDecimal("10");
total.divide(new BigDecimal("3"));                                // ArithmeticException：无限循环小数
total.divide(new BigDecimal("3"), 2, RoundingMode.HALF_UP);       // 3.33
new BigDecimal("2.345").setScale(2);                               // ArithmeticException：需要舍入但没给模式
new BigDecimal("2.345").setScale(2, RoundingMode.HALF_UP);        // 2.35
new BigDecimal("2.345").setScale(2, RoundingMode.HALF_EVEN);      // 2.34，银行家舍入
```

| 模式 | 规则 | 适用 |
|------|------|------|
| `HALF_UP` | 四舍五入 | 面向用户的价格展示、大多数业务结算 |
| `HALF_EVEN` | 恰好一半时向偶数舍入 | 大量累加的统计、利息计算，正负误差相互抵消 |
| `DOWN` / `UP` | 向零截断 / 远离零进位 | 优惠、手续费按合同约定「舍去」或「进位」 |
| `FLOOR` / `CEILING` | 向负无穷 / 正无穷 | 涉及负数（退款、冲正）时与 `DOWN` / `UP` 结果不同，需按约定选择 |

- 舍入规则是业务规则，写进常量或领域对象，不要散落在各个调用点；多步计算只在最后一步舍入，中间结果保留足够精度
- 分摊（如订单优惠按商品拆分）各项分别舍入后总和可能差一分，把差额补到最后一项，保证合计与总额一致
- scale 为负（如 `stripTrailingZeros()` 之后 100 变成 `1E+2`）或数值很小（`0.0000001` 输出 `1E-7`）时，`toString()` 会输出科学计数法，展示用 `toPlainString()`

### 5、BigDecimal 还是 long 分

| 对比 | `BigDecimal` | `long`（分） |
|------|-------------|-------------|
| 精度 | 任意精度，可表示汇率、单价等多位小数 | 只到最小货币单位 |
| 性能 | 对象运算，较慢、占内存 | 原始类型，快 |
| 数据库 | `DECIMAL(p,s)` | `BIGINT` |
| 风险点 | 舍入模式、`equals` | 单位换算错误（元当分）、乘除时的舍入仍要手写 |
| 适合 | 计价、利率、汇率、财务报表 | 支付、账户余额、库存金额等高频加减 |

常见做法是存储与流转用 `long` 分（支付渠道多以分为单位，见 [支付](/scenario/14_payment)），乘除、折扣、汇率换算时转成 `BigDecimal` 计算，舍入后再转回 `long`（`longValueExact()` 在有小数或溢出时抛异常，比 `longValue()` 安全）。不同币种的最小单位不同，日元没有小数、部分中东货币有 3 位，用 `Currency.getDefaultFractionDigits()` 查询，不要写死 100。领域模型中把金额封装成值对象（金额 + 币种），见 [DDD 领域驱动设计](/architecture/2_ddd)；团队规约见 [开发规范 · 金额](/devops/3_dev_standards#_3、金额)。

---

## 小结

- 重载在编译期按参数声明类型选定（静态分派），重写在运行期按接收者实际类型选定（动态分派）；`static`、`private`、`final` 方法与字段不参与多态
- 抽象类表达「是什么」并可持有状态，接口表达「能做什么」并可多实现；默认方法冲突按「类优先 → 更具体的接口优先 → 必须显式重写」解决
- `equals` 相等则 `hashCode` 必须相等，两者使用同一组字段；违反时 `HashMap` / `HashSet` 查不到元素、去重失效
- `clone` 绕过构造器且默认浅拷贝，用拷贝构造器或静态工厂替代；`finalize` 已待移除，资源释放用 try-with-resources，`Cleaner` 只做兜底
- 包装类之间用 `equals` 比较，`Integer` 默认只缓存 -128 ~ 127；三元运算符、`Map.get` 是拆箱 NPE 的高发点；数值计算用原始类型流
- 不可变类：`final` 类 + `private final` 字段 + 防御性拷贝；简单值对象优先 `record`
- Java 只有值传递，引用类型复制的是引用：方法内改对象状态调用方可见，给形参重新赋值不可见，所以写不出 swap
- 金额不用 `double`：`BigDecimal` 用 `String` 或 `valueOf` 构造，比较用 `compareTo`，除法和 `setScale` 显式给出 `RoundingMode`；高频加减与存储用 `long` 分

## 参考资料

- Object API（Java SE 21）：[https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/lang/Object.html](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/lang/Object.html)
- Java 语言规范 §8.4.8 继承、重写与隐藏：[https://docs.oracle.com/javase/specs/jls/se21/html/jls-8.html#jls-8.4.8](https://docs.oracle.com/javase/specs/jls/se21/html/jls-8.html#jls-8.4.8)
- Java 语言规范 §15.12 方法调用表达式：[https://docs.oracle.com/javase/specs/jls/se21/html/jls-15.html#jls-15.12](https://docs.oracle.com/javase/specs/jls/se21/html/jls-15.html#jls-15.12)
- Cleaner API（Java SE 21）：[https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/lang/ref/Cleaner.html](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/lang/ref/Cleaner.html)
- JEP 421 Deprecate Finalization for Removal：[https://openjdk.org/jeps/421](https://openjdk.org/jeps/421)
- JEP 500 Prepare to Make Final Mean Final：[https://openjdk.org/jeps/500](https://openjdk.org/jeps/500)
- Java 语言规范 §8.4.1 形式参数：[https://docs.oracle.com/javase/specs/jls/se21/html/jls-8.html#jls-8.4.1](https://docs.oracle.com/javase/specs/jls/se21/html/jls-8.html#jls-8.4.1)
- BigDecimal API（Java SE 21）：[https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/math/BigDecimal.html](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/math/BigDecimal.html)
- RoundingMode API（Java SE 21）：[https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/math/RoundingMode.html](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/math/RoundingMode.html)

> 下一篇：[异常体系](./10_topic_exception) —— 受检与非受检异常的设计、finally 与 try-with-resources，以及生产中的异常处理规范。
