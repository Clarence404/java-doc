# Java 版本演进

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

| 特性 | 版本 | 状态 |
|------|------|------|
| Unnamed Variables（`_`）| 22 | 正式 |
| String Templates | 22 预览 → 23 二次预览 | 仍在演进 |
| 结构化并发 | 22 | 第四次预览 |
| Stream Gatherers | 22 | 预览 |
| 类文件 API | 22 | 预览 |
| 原始类型模式匹配 | 23 | 预览 |

```java
// Unnamed Variables（Java 22）
try {
    doSomething();
} catch (Exception _) {   // 不关心异常对象时用 _
    log.warn("failed");
}

for (var _ : list) count++;  // 不关心循环变量
```
