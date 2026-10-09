---
description: 静态嵌套类与内部类、JDK 16 放宽、嵌套访问控制、外部引用与捕获、Lambda 差异、内存泄漏
---

# 内部类

> **本篇目标**：按 JLS 术语分清静态嵌套类与三种内部类，理解 javac 为它们生成的外部引用和捕获字段，掌握 JDK 11 嵌套访问控制与 JDK 16 的规则放宽，能识别并避免服务端由内部类、匿名类和 Lambda 引起的内存泄漏。
>
> **前置阅读**：[枚举](./12_topic_enum)

本文以 JDK 21 / 25 为基线，与 JDK 8 / 17 不同之处单独标注。

---

## 一、嵌套类的分类

JLS 的术语是**嵌套类（nested class）**：声明在另一个类或接口内部的类。它分为两大类：

- **静态嵌套类**（static nested class）：用 `static` 修饰的成员类，**不是内部类**，与外部类实例无关
- **内部类**（inner class）：所有非 static 的嵌套类，细分为成员内部类、局部类、匿名类

接口中声明的成员类、嵌套的枚举、记录和接口都隐式为 static。

| 类型 | 声明位置 | 外部实例引用 | 能访问的外部内容 | 声明静态成员 | 典型场景 |
|------|---------|-------------|----------------|------------|---------|
| 静态嵌套类 | 类体内，有 `static` | 无 | 外部类的静态成员；持有外部实例引用时，可访问其 private 实例成员 | 允许 | Builder、链表节点、DTO 分组 |
| 成员内部类 | 类体内，无 `static` | 有 | 外部类全部成员（含 private） | JDK 16+ 允许，此前只允许编译期常量 | 迭代器等需要访问外部实例状态的辅助类 |
| 局部类 | 方法或代码块内 | 在实例上下文中有 | 外部类成员 + effectively final 的局部变量 | JDK 16+ 允许 | 方法内的临时类型 |
| 匿名类 | 表达式中 | 在实例上下文中有 | 同局部类 | JDK 16+ 允许 | 一次性实现，多数已被 Lambda 取代 |

「只能读 effectively final」只约束**捕获的局部变量和参数**；外部类的字段无论是否 final 都可以读写。

![javac 为各类嵌套类和 Lambda 生成的外部引用](../assets/java/inner-class-capture.svg)

---

## 二、成员内部类

```java
public class Outer {
    private int x = 10;

    class Inner {
        void show() {
            System.out.println(x);            // 直接访问外部类的 private 字段
            System.out.println(Outer.this.x); // 显式引用外部实例
        }
    }
}

// 创建：必须先有外部实例
Outer outer = new Outer();
Outer.Inner inner = outer.new Inner();
inner.show();
```

成员内部类的实例绑定一个外部实例，javac 为它生成 `final Outer this$0` 字段，并在构造器中隐式传入外部实例。只要内部类实例还活着，外部实例就不能被回收。

JDK 中的典型用法是集合的迭代器：`ArrayList.Itr` 是成员内部类，需要读取外部 `ArrayList` 的 `elementData` 与 `modCount`。

---

## 三、静态嵌套类（默认首选）

```java
public class LinkedList<E> {
    private Node<E> head;

    private static class Node<E> {    // 不持有外部实例
        E item;
        Node<E> next;
        Node(E item, Node<E> next) {
            this.item = item;
            this.next = next;
        }
    }
}
```

- 不需要访问外部实例时一律用 `static`：没有隐藏的外部引用，可以独立创建，也不会因序列化而连带外部对象
- 静态嵌套类与外部类互相可以访问对方的 private 成员（见第六节的嵌套访问控制）
- 典型用法：Builder（见 [建造者模式](/patterns/4_creational_builder)）、单例的静态 Holder 写法（见 [单例模式](/patterns/1_creational_singleton)）、接口的请求 / 响应 DTO 分组

```java
// Builder 的骨架：静态嵌套类可以调用外部类的 private 构造器
public class HttpRequestSpec {
    private final String url;
    private final Duration timeout;

    private HttpRequestSpec(Builder b) {
        this.url = b.url;
        this.timeout = b.timeout;
    }

    public static Builder builder(String url) { return new Builder(url); }

    public static final class Builder {
        private final String url;
        private Duration timeout = Duration.ofSeconds(3);

        private Builder(String url) { this.url = url; }
        public Builder timeout(Duration t) { this.timeout = t; return this; }
        public HttpRequestSpec build() { return new HttpRequestSpec(this); }
    }
}
```

---

## 四、局部类、局部记录与局部枚举

局部类声明在方法或代码块内，只在该作用域可见。JDK 16（JEP 395）起还可以声明**局部记录、局部枚举和局部接口**，它们隐式为 static，不能捕获外围的局部变量和外部实例：

```java
List<String> topSpenders(List<Order> orders, int n) {
    // 局部记录：只在本方法内使用的中间结果，不必污染类的命名空间
    record UserTotal(String userId, long amount) {}

    return orders.stream()
            .collect(Collectors.groupingBy(Order::userId, Collectors.summingLong(Order::amount)))
            .entrySet().stream()
            .map(e -> new UserTotal(e.getKey(), e.getValue()))
            .sorted(Comparator.comparingLong(UserTotal::amount).reversed())
            .limit(n)
            .map(UserTotal::userId)
            .toList();
}
```

普通局部类（非记录）在实例方法中会捕获外部实例和用到的局部变量，现在已很少直接使用。

JDK 16 同时放宽了内部类的限制：成员内部类、局部类、匿名类都可以声明 `static` 成员，此前只允许 `static final` 的编译期常量。

---

## 五、匿名类

匿名类在声明处同时创建实例，适合一次性的实现：

```java
// JDK 9+：匿名类也可以使用菱形推断
Comparator<String> byLength = new Comparator<>() {
    @Override
    public int compare(String a, String b) {
        return Integer.compare(a.length(), b.length());
    }
};
```

- 匿名类可以继承类（包括抽象类）或实现**一个**接口，可以有字段、多个方法和实例初始化块，但不能声明构造器
- 只实现函数式接口的匿名类，现在都应写成 Lambda 或方法引用：`Comparator.comparingInt(String::length)`
- 启动线程也不再需要 `new Thread(new Runnable() {...})`：用线程池提交任务，或 JDK 21 起的 `Thread.ofVirtual().start(() -> ...)`

仍然需要匿名类的场景：要继承抽象类而不是实现接口、需要多个方法、需要在实现内部保存状态，或者要让 `this` 指向实现对象本身。

---

## 六、编译器在背后做了什么

### 1、外部引用 this$0 与捕获字段 val$x

```java
public class OrderService {
    private final Repo repo = new Repo();

    Runnable task(long orderId) {
        return new Runnable() {
            @Override public void run() { repo.load(orderId); }
        };
    }
}
```

javac 为这个匿名类生成 `OrderService$1`，`javap -p` 可以看到：

```java
final class OrderService$1 implements Runnable {
    final long val$orderId;        // 捕获的局部变量副本
    final OrderService this$0;     // 外部实例（因为用到了 repo 字段）
    OrderService$1(OrderService, long);
    public void run();
}
```

为什么捕获的局部变量必须是 effectively final：局部变量属于方法的栈帧，方法返回后就不存在了，而匿名类实例可能活得更久。javac 的做法是把变量的**值复制**到 `val$x` 字段里。如果允许之后再修改，方法里的变量和副本就会不一致，所以语言层面直接禁止修改（Java 8 起不必显式写 `final`，只要事实上没有再赋值）。需要可变状态时，捕获一个 `AtomicLong` 或数组之类的容器对象。

### 2、JDK 18 起未使用的 this$0 会被省略

JDK 17 及以前，javac 为每个内部类都生成 `this$0`，哪怕它从未使用外部实例。JDK 18 起（JDK-8271623），**未使用外部实例的内部类不再生成 `this$0` 字段**，减少了意外持有外部对象的情况；但实现了 `Serializable` 的内部类不受此优化影响，仍然保留该字段。

因此「匿名类一定持有外部引用」只对 JDK 17 及以前成立。不确定时用 `javap -p` 查看实际生成的字段，不要依赖编译器版本做推断——把不需要外部实例的类声明为 static 才是可靠的做法。

### 3、嵌套访问控制（JDK 11+）

内部类和外部类在源码中可以互相访问 private 成员，但在 JVM 看来它们是两个独立的类，private 本应只对本类可见。

- **JDK 10 及以前**：javac 生成包级可见的合成桥接方法（`access$000` 等）来转发访问。这些方法放宽了实际的访问范围，增加了字节码体积，并且反射与源码语义不一致——内部类通过反射访问外部类 private 成员会抛 `IllegalAccessException`
- **JDK 11 起（JEP 181）**：同一个顶层类及其所有嵌套类组成一个**巢（nest）**，class 文件通过 `NestHost` / `NestMembers` 属性声明成员关系，JVM 允许巢内成员直接访问彼此的 private 成员，不再需要桥接方法，反射行为也与源码一致

```java
Class<?> host = Outer.Inner.class.getNestHost();         // Outer.class
Class<?>[] members = Outer.class.getNestMembers();        // Outer 及其全部嵌套类
boolean mates = Outer.class.isNestmateOf(Outer.Inner.class); // true
```

---

## 七、Lambda 与匿名类的区别

Lambda 不是匿名类的语法糖。javac 把 Lambda 体编译为外部类中的私有合成方法（如 `lambda$task$0`），在调用处生成 `invokedynamic`，运行时由 `LambdaMetafactory` 生成实现函数式接口的类（JDK 15 起为隐藏类）。底层原理见 [Lambda、Stream 与注解](./1_advanced)，这里只列出与匿名类的差异：

| | Lambda | 匿名类 |
|--|--------|--------|
| 实现目标 | 只能是函数式接口 | 任意接口或类（含抽象类） |
| `this` 含义 | 外围实例（Lambda 不引入新的作用域） | 匿名类实例自身 |
| 变量遮蔽 | 参数和局部变量不能与外围局部变量同名 | 可以遮蔽 |
| 编译产物 | 合成方法 + `invokedynamic`，不生成 `.class` 文件，运行时生成隐藏类 | 编译期生成 `Outer$1.class` |
| 外部实例引用 | 只有 Lambda 体用到 `this` 或实例成员时才捕获 | JDK 17 及以前总是持有；JDK 18+ 用到时才持有 |
| 实例分配 | 不捕获任何变量时通常复用同一个实例；捕获变量时每次求值创建新实例 | 每次求值都创建新实例 |

两者捕获局部变量的规则相同：都只能捕获 effectively final 的局部变量。

---

## 八、服务端常见内存泄漏

泄漏的本质都一样：**生命周期长的对象**（静态集合、全局注册表、线程池队列、缓存）引用了一个内部类 / 匿名类 / Lambda 实例，后者又通过 `this$0` 或捕获变量引用了一个大对象。

### 1、监听器注册到全局注册表后没有注销

```java
public final class GlobalEvents {
    private static final List<Consumer<String>> LISTENERS = new CopyOnWriteArrayList<>();

    public static void register(Consumer<String> listener)   { LISTENERS.add(listener); }
    public static void unregister(Consumer<String> listener) { LISTENERS.remove(listener); }
    public static void publish(String event) { LISTENERS.forEach(l -> l.accept(event)); }
}

// 每个租户创建一个上下文，租户下线时丢弃
public class TenantReportContext implements AutoCloseable {
    private final byte[] templateCache = new byte[20 * 1024 * 1024];
    private final Consumer<String> listener = this::onEvent;   // 方法引用捕获了 this

    public void start() {
        GlobalEvents.register(listener);
    }

    private void onEvent(String event) {
        // 使用 templateCache 刷新报表
    }

    @Override
    public void close() {
        GlobalEvents.unregister(listener);   // 漏掉这一步，每个下线的租户都会留下 20MB
    }
}
```

把 `this::onEvent` 换成匿名类结果一样。修复方式是**管理生命周期**：注册与注销成对出现，放进 `close()` / `@PreDestroy`，或让注册方法返回一个用于注销的 `AutoCloseable` 句柄。

`WeakReference` 不是通用解法：如果监听器只被弱引用持有，它可能在任何一次 GC 后消失，导致事件「偶尔收不到」，比泄漏更难排查。

### 2、双括号初始化

```java
// 不推荐：创建了 HashMap 的匿名子类，在实例方法中会持有外部实例
Map<String, String> headers = new HashMap<>() {{
    put("Content-Type", "application/json");
    put("X-Trace-Id", traceId);
}};

// 推荐
Map<String, String> headers = Map.of(
        "Content-Type", "application/json",
        "X-Trace-Id", traceId);
```

双括号初始化每处都会多生成一个类；`HashMap` 实现了 `Serializable`，所以即使在 JDK 18+ 也会保留 `this$0`。这个 Map 一旦被放进缓存或作为返回值长期持有，外部对象（比如整个 Service 或请求上下文）也跟着留在内存里；对它做 Java 序列化时还会尝试连带序列化外部对象。

### 3、异步与定时任务捕获大对象

```java
// 不推荐：任务在队列里等 30 分钟，整个 request（可能含上传的文件内容）也被持有 30 分钟
scheduler.schedule(() -> audit(request), 30, TimeUnit.MINUTES);

// 推荐：只捕获任务真正需要的数据
String orderId = request.getOrderId();
scheduler.schedule(() -> auditOrder(orderId), 30, TimeUnit.MINUTES);
```

线程池队列积压时，所有排队任务捕获的对象都在堆里。另外，`audit` 是实例方法，Lambda 也会捕获外部实例 `this`；如果外部对象是短生命周期的，需要一并考虑。

### 4、缓存中存放内部类实例

把 `outer.new Inner()` 或匿名类实例放进本地缓存、静态 Map 时，缓存的生命周期决定了外部实例的生命周期。缓存中的值对象应使用静态嵌套类、记录或顶层类。本地缓存的容量与过期策略见 [Caffeine](/cache/7_caffeine)。

排查这类泄漏时，在堆转储中找到占用最大的对象，看它的 GC Root 引用链中是否有 `this$0` 或 `val$` 字段，见 [故障排查](/jvm/9_troubleshooting)。

---

## 小结

- JLS 术语：嵌套类 = 静态嵌套类 + 内部类（成员内部类、局部类、匿名类）；静态嵌套类不是内部类
- 不需要外部实例时一律声明为 static；静态嵌套类拿到外部实例引用时同样能访问其 private 成员
- JDK 16 起所有内部类都可以声明静态成员，并支持局部记录、局部枚举、局部接口
- javac 用 `this$0` 持有外部实例、用 `val$x` 复制捕获的局部变量，这是 effectively final 规则的来源；JDK 18 起未使用的 `this$0` 会被省略（可序列化类除外）
- JDK 11 起嵌套访问控制取代了 `access$000` 桥接方法，巢内成员直接互访 private 成员
- Lambda 不是匿名类的语法糖：`this` 指向外围实例，只在用到时捕获外部实例，运行时生成隐藏类
- 服务端泄漏来自「长生命周期容器引用了捕获大对象的回调」：注册与注销成对出现、只捕获需要的数据、避免双括号初始化；弱引用不是通用解法

## 参考资料

- JLS §8.1.3 Inner Classes and Enclosing Instances：[https://docs.oracle.com/javase/specs/jls/se21/html/jls-8.html#jls-8.1.3](https://docs.oracle.com/javase/specs/jls/se21/html/jls-8.html#jls-8.1.3)
- JEP 181 Nest-Based Access Control：[https://openjdk.org/jeps/181](https://openjdk.org/jeps/181)
- JEP 395 Records（含内部类静态成员放宽）：[https://openjdk.org/jeps/395](https://openjdk.org/jeps/395)
- JDK-8271623 Omit enclosing instance fields from inner classes that don't use it：[https://bugs.openjdk.org/browse/JDK-8271623](https://bugs.openjdk.org/browse/JDK-8271623)

> 下一篇：[泛型](./14_topic_generics) —— 类型擦除、通配符与 PECS，以及擦除带来的各种限制。
