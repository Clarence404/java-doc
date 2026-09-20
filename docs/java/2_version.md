 Java 版本演进

本文按升级路径梳理各 LTS 版本的核心新特性，适合系统回顾 Java 版本演进的开发者。

## 一、Java 8 核心特性（起点）

Java 8 是目前仍被广泛使用的版本，以下是它最重要的几个特性：

### 1、Lambda 表达式

```java
// 旧写法
Comparator<String> c = new Comparator<String>() {
    public int compare(String a, String b) { return a.compareTo(b); }
};

// Lambda
Comparator<String> c = (a, b) -> a.compareTo(b);
// 方法引用
Comparator<String> c = String::compareTo;
```

### 2、Stream API

```java
List<String> result = list.stream()
    .filter(s -> s.startsWith("A"))
    .map(String::toUpperCase)
    .sorted()
    .collect(Collectors.toList());

// 并行流
list.parallelStream().forEach(System.out::println);
```

### 3、Optional

```java
Optional<String> opt = Optional.ofNullable(name);
String result = opt
    .filter(s -> s.length() > 3)
    .map(String::toUpperCase)
    .orElse("DEFAULT");
```

### 4、函数式接口（java.util.function）

| 接口 | 参数 | 返回 | 用途 |
|------|------|------|------|
| `Function<T,R>` | T | R | 转换 |
| `Predicate<T>` | T | boolean | 过滤 |
| `Consumer<T>` | T | void | 消费 |
| `Supplier<T>` | 无 | T | 生产 |
| `BiFunction<T,U,R>` | T,U | R | 双参转换 |

### 5、新 Date/Time API（java.time）

```java
LocalDate today = LocalDate.now();
LocalDateTime now = LocalDateTime.now();
ZonedDateTime zdt = ZonedDateTime.now(ZoneId.of("Asia/Shanghai"));
Duration duration = Duration.between(start, end);
DateTimeFormatter fmt = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss");
```

### 6、接口默认方法与静态方法

```java
interface Greeting {
    default String hello(String name) { return "Hello, " + name; }
    static String bye(String name) { return "Bye, " + name; }
}
```

---

## 二、Java 8 → Java 11（LTS）重要变化

Java 11 是许多企业从 Java 8 直接升级的目标版本：

### 1、模块系统（Java 9）

```java
// module-info.java
module com.example.myapp {
    requires java.sql;
    exports com.example.myapp.api;
}
```

升级时若反射访问 JDK 内部类，可能需要：
```shell
--add-opens java.base/java.lang=ALL-UNNAMED
```

### 2、局部变量类型推断 var（Java 10）

```java
var list = new ArrayList<String>();   // 编译器自动推断类型
var map = new HashMap<String, Integer>();
// 不能用于字段、方法参数、返回类型
```

### 3、新 HTTP 客户端（Java 11）

```java
HttpClient client = HttpClient.newHttpClient();
HttpRequest request = HttpRequest.newBuilder()
    .uri(URI.create("https://example.com"))
    .GET().build();
HttpResponse<String> response = client.send(request, BodyHandlers.ofString());
```

### 4、String 新增方法（Java 11）

```java
"  ".isBlank()          // true
"  hello  ".strip()     // "hello"（Unicode感知，优于trim）
"a\nb\nc".lines()       // Stream<String>
"ha".repeat(3)          // "hahaha"
```

### 5、Files 读写简化（Java 11）

```java
Files.writeString(Path.of("file.txt"), "content");
String content = Files.readString(Path.of("file.txt"));
```

### 6、Flight Recorder 开放（Java 11）

JFR 从商业特性变为开源，可免费用于生产环境性能分析。

---

## 三、Java 11 → Java 17（LTS）重要变化

### 1、文本块（Java 15）

```java
String json = """
        {
          "name": "Java",
          "version": 17
        }
        """;
```

### 2、instanceof 模式匹配（Java 16）

```java
// 旧写法
if (obj instanceof String) {
    String s = (String) obj;
    System.out.println(s.toLowerCase());
}
// 新写法
if (obj instanceof String s) {
    System.out.println(s.toLowerCase());
}
```

### 3、Record 类（Java 16，正式）

```java
public record Point(int x, int y) {}  // 自动生成构造器、getter、equals、hashCode、toString

Point p = new Point(1, 2);
System.out.println(p.x());   // getter
```

### 4、Switch 表达式（Java 14，正式）

```java
int result = switch (day) {
    case MONDAY, FRIDAY -> 6;
    case TUESDAY -> 7;
    default -> {
        System.out.println("other day");
        yield -1;
    }
};
```

### 5、Sealed 类（Java 17）

```java
public sealed class Shape permits Circle, Square, Triangle {}

final class Circle extends Shape {}
final class Square extends Shape {}
non-sealed class Triangle extends Shape {}  // 允许进一步继承
```

配合 `instanceof` 模式匹配，实现类型安全的代数数据类型。

---

## 四、Java 21（LTS）核心亮点

### 1、虚拟线程（正式发布）

```java
// 启动虚拟线程
Thread.startVirtualThread(() -> System.out.println("virtual: " + Thread.currentThread()));

// 线程池方式
try (var executor = Executors.newVirtualThreadPerTaskExecutor()) {
    IntStream.range(0, 10_000).forEach(i ->
        executor.submit(() -> {
            Thread.sleep(Duration.ofMillis(100));
            return i;
        }));
}
```

虚拟线程由 JVM 调度（不是 OS 线程），栈内存极小（KB 级），可轻松创建百万级并发，适合高 IO 场景。

### 2、结构化并发（预览）

```java
try (var scope = new StructuredTaskScope.ShutdownOnFailure()) {
    Future<String> f1 = scope.fork(() -> fetchUser());
    Future<String> f2 = scope.fork(() -> fetchOrder());
    scope.join().throwIfFailed();
    process(f1.resultNow(), f2.resultNow());
}
```

### 3、Switch 模式匹配（正式）

```java
static String format(Object obj) {
    return switch (obj) {
        case Integer i -> "int: " + i;
        case String s when s.length() > 5 -> "long string: " + s;
        case String s -> "short string: " + s;
        case null -> "null";
        default -> obj.toString();
    };
}
```

### 4、Sequenced Collections（正式）

新增 `SequencedCollection`、`SequencedSet`、`SequencedMap` 接口，统一提供 `getFirst()`/`getLast()`/`addFirst()`/`reversed()` 等方法：

```java
var list = new ArrayList<>(List.of(1, 2, 3));
list.getFirst();   // 1
list.getLast();    // 3
list.reversed();   // [3, 2, 1]
```

---

## 五、Java 22 / 23 / 24 新特性速览

| 特性 | 引入版本 | Java 24 状态 |
|------|----------|-------------|
| Unnamed Variables（`_`） | 22 | **正式** |
| Stream Gatherers | 22 预览 | **正式**（24，JEP 485） |
| Class-File API | 22 预览 | **正式**（24，JEP 484） |
| 原始类型模式匹配 | 23 预览 | 二次预览（24） |
| 结构化并发 | 22 预览 | 四次预览（24） |
| Scoped Values | 22 预览 | 四次预览（24） |
| Flexible Constructor Bodies | 22 预览 | 三次预览（24） |
| String Templates | 22 预览 | **已撤回**（JEP 430 withdrawn） |

```java
// Unnamed Variables（Java 22，正式）
try {
    doSomething();
} catch (Exception _) {   // 不关心异常对象时用 _
    log.warn("failed");
}
for (var _ : list) count++;  // 不关心循环变量

// Stream Gatherers（Java 24，正式）——自定义流中间操作
List<List<Integer>> windows = Stream.of(1, 2, 3, 4, 5)
    .gather(Gatherers.windowFixed(2))
    .toList();
// 结果：[[1,2],[3,4],[5]]

// 内置 Gatherer：fold（有状态归约）、scan（滚动前缀和）、mapConcurrent（并发映射）
List<Integer> prefixSums = IntStream.rangeClosed(1, 5).boxed()
    .gather(Gatherers.scan(() -> 0, Integer::sum))
    .toList();
// 结果：[1, 3, 6, 10, 15]
```

---

## 六、Java 25（LTS）核心亮点

Java 25 是继 Java 21 之后的下一个 LTS 版本（2025 年 9 月发布），多个长期预览特性在此正式定稿。

### 1、Scoped Values（正式，JEP 506）

线程局部数据的现代替代，专为虚拟线程设计——不可变、生命周期有界、天然防泄漏。

```java
static final ScopedValue<User> CURRENT_USER = ScopedValue.newInstance();

// 绑定作用域
ScopedValue.where(CURRENT_USER, user).run(() -> {
    processRequest();           // 作用域内可读取
    CURRENT_USER.get();         // User 对象
});
// 作用域外自动清除，子虚拟线程自动继承（无需手动传递）
```

**对比 ThreadLocal**：ThreadLocal 可修改、生命周期不受控、在虚拟线程大量使用时内存占用高；ScopedValue 不可变、与 StructuredTaskScope 天然协作。

### 2、结构化并发（正式，JEP 505）

将并发子任务的生命周期与代码块作用域绑定，出错时自动取消其他子任务。

```java
try (var scope = new StructuredTaskScope.ShutdownOnFailure()) {
    Subtask<User>  user  = scope.fork(() -> fetchUser(id));
    Subtask<Order> order = scope.fork(() -> fetchOrder(id));
    scope.join().throwIfFailed();       // 任一失败则取消另一个
    render(user.get(), order.get());
}
// 作用域结束时所有子任务必须完成，不会泄漏线程
```

### 3、原始类型模式匹配（正式，JEP 507）

`instanceof` 和 `switch` 中直接匹配原始类型，消除拆箱转换样板代码。

```java
Object obj = 42;

// instanceof 原始类型匹配
if (obj instanceof int i) {
    System.out.println(i * 2);   // 直接使用 int，无需拆箱
}

// switch 混合匹配
switch (obj) {
    case int i when i > 0    -> "正整数: " + i;
    case int i               -> "非正整数: " + i;
    case double d            -> "浮点数: " + d;
    case String s            -> "字符串: " + s;
    default                  -> "其他: " + obj;
}
```

### 4、灵活的构造器体（正式，JEP 513）

`super()` / `this()` 调用之前现在可以有语句，只要这些语句不引用 `this`。

```java
class Rectangle extends Shape {
    final int width, height;

    Rectangle(int w, int h) {
        // Java 25 之前：super() 必须是第一条语句
        // Java 25：合法，因为此处不引用 this
        if (w <= 0 || h <= 0) throw new IllegalArgumentException("尺寸须为正数");
        super();
        this.width  = w;
        this.height = h;
    }
}
```

### 5、模块导入声明（正式，JEP 511）

一行语句导入整个模块的所有公开包，简化大量 `import` 行。

```java
import module java.base;      // 等价于 java.util.* + java.io.* + java.lang.* 等
import module java.sql;

// 脚本、教学、快速原型时特别有用
```

### 6、主要变化汇总

| 特性 | JEP | 说明 |
|------|-----|------|
| Scoped Values | 506 | ThreadLocal 现代替代，虚拟线程友好 |
| 结构化并发 | 505 | 子任务生命周期与代码块绑定 |
| 原始类型模式匹配 | 507 | switch/instanceof 支持 int/double 等 |
| 灵活构造器体 | 513 | super() 前可有不引用 this 的语句 |
| 模块导入声明 | 511 | `import module M` 批量导入 |
| AOT 类加载与链接 | 483 | 应用启动时间显著缩短（实验性） |
| 紧凑对象头 | 450 | 堆内存降低约 10–20%（实验性） |

---

## 七、Java 26 / 27 新特性速览

Java 26（2026 年 3 月）和 Java 27（2026 年 9 月）均为非 LTS 版本，继续孵化 Valhalla、Loom 后续特性。

| 特性方向 | 说明 |
|----------|------|
| Project Valhalla — Value Classes | 轻量级值类型（无标识），减少堆分配，预计在 26/27 进入预览 |
| 泛型特化（Generic Specialization） | 泛型支持原始类型参数，如 `List<int>`，消除装箱开销 |
| String Templates（重新设计） | 原 JEP 430 已撤回，重新设计中 |
| 结构化并发增强 | 在 25 正式化基础上继续完善 API |

> **版本选型建议**：生产环境优先选 LTS 版本（8 / 11 / 17 / **21** / **25**）。新项目建议直接上 Java 21 或 Java 25；Java 27 作为非 LTS，适合尝鲜预览特性，不建议直接用于生产。
