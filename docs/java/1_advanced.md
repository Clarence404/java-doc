---
description: Lambda 实现原理、函数式接口与方法引用、Stream 惰性求值与并行流、Optional、注解与注解处理器
---

# Lambda、Stream 与注解

> **本篇目标**：讲清 Lambda 从 javac 脱糖到 `invokedynamic` 链接的完整过程，掌握函数式接口、方法引用、Stream 的求值模型与并行流的适用边界，写出符合规范的 Optional 代码，并理解注解从定义、运行时读取到编译期处理的全链路（含 JDK 23 注解处理默认行为的变化）。
>
> **前置阅读**：[Java 总览](./0_overview)

> 参考资料：
> * JLS §15.27 Lambda Expressions：[https://docs.oracle.com/javase/specs/jls/se25/html/jls-15.html#jls-15.27](https://docs.oracle.com/javase/specs/jls/se25/html/jls-15.html#jls-15.27)
> * `java.util.stream` 包文档：[https://docs.oracle.com/en/java/javase/25/docs/api/java.base/java/util/stream/package-summary.html](https://docs.oracle.com/en/java/javase/25/docs/api/java.base/java/util/stream/package-summary.html)
> * `LambdaMetafactory` API：[https://docs.oracle.com/en/java/javase/25/docs/api/java.base/java/lang/invoke/LambdaMetafactory.html](https://docs.oracle.com/en/java/javase/25/docs/api/java.base/java/lang/invoke/LambdaMetafactory.html)
> * JEP 371 Hidden Classes：[https://openjdk.org/jeps/371](https://openjdk.org/jeps/371)
> * javac 文档（`-proc` 与注解处理）：[https://docs.oracle.com/en/java/javase/25/docs/specs/man/javac.html](https://docs.oracle.com/en/java/javase/25/docs/specs/man/javac.html)

版本基线：JDK 21 / 25 LTS，JDK 8 / 17 的差异单独标出。泛型见 [泛型](./14_topic_generics)，反射见 [反射](./15_topic_reflection)，本篇不重复。

---

## 一、Lambda 表达式

### 1、语法与变量捕获

Lambda 是**函数式接口实例**的简写：目标类型必须是只有一个抽象方法的接口，编译器根据上下文推断参数类型。

```java
Comparator<String> byLength = (a, b) -> Integer.compare(a.length(), b.length());
Runnable task = () -> System.out.println("run");
Function<String, Integer> parse = Integer::parseInt;   // 方法引用，见第二节
```

Lambda 只能捕获 **effectively final** 的局部变量（声明后从未被重新赋值，不必显式写 `final`）。原因是捕获的是值的拷贝：局部变量活在栈帧里，Lambda 可能在方法返回后、甚至在别的线程中执行，允许修改会产生「改了副本、原值不变」的歧义和数据竞争。

```java
int base = 10;
Function<Integer, Integer> add = x -> x + base;   // OK
// base++;                                        // 编译错误：base 不再是 effectively final

// 需要累加时，用 Stream 归约，而不是借 int[] / AtomicInteger 绕过检查
int sum = list.stream().mapToInt(Integer::intValue).sum();
```

字段（实例字段 / 静态字段）不受此限制，因为 Lambda 捕获的是 `this` 引用或直接访问静态字段——但这意味着并发修改需要自己保证线程安全。

### 2、底层实现：invokedynamic + LambdaMetafactory

![Lambda 的编译与链接](../assets/java/java-lambda-indy.svg)

Lambda **不是**匿名内部类的语法糖，编译后也不会产生 `Outer$1.class` 这样的类文件。过程分两段：

**编译期（javac）**

1. Lambda 体被脱糖成当前类中的一个私有方法 `lambda$<所在方法>$<序号>`。不引用 `this` 时是 `static` 方法，引用了 `this`（包括访问实例字段）时是实例方法；捕获的局部变量变成该方法的前置参数。
2. 在 Lambda 出现的位置生成一条 `invokedynamic` 指令，引导方法（bootstrap method）指向 `LambdaMetafactory.metafactory`，静态参数里带上接口方法签名和第 1 步生成方法的 `MethodHandle`。

```java
public class Demo {
    public static void main(String[] args) {
        int factor = 3;
        Function<Integer, Integer> f = x -> x * factor;
        System.out.println(f.apply(2));
    }
}
```

```shell
$ javac Demo.java && javap -c -p Demo
  public static void main(java.lang.String[]);
       ...
       3: invokedynamic #7,  0   // InvokeDynamic #0:apply:(I)Ljava/util/function/Function;
       ...
  private static java.lang.Integer lambda$main$0(int, java.lang.Integer);
```

可以看到：捕获的 `factor` 成了 `lambda$main$0` 的第一个参数，`invokedynamic` 的调用签名 `(I)Function` 表示「传入捕获值，返回一个 Function 实例」。

**运行期（首次执行该调用点）**

1. JVM 调用引导方法 `LambdaMetafactory.metafactory`，它在运行时生成一个实现了 `Function` 的类：JDK 15 起通过 `Lookup.defineHiddenClass` 定义为**隐藏类**（JEP 371，此前用的是 `Unsafe.defineAnonymousClass`），类名形如 `Demo$$Lambda/0x...`，不能被其他类按名引用。
2. 该类的 `apply` 方法直接调用 `lambda$main$0`，捕获值保存在它的 final 字段里。
3. 引导方法返回一个 `CallSite`，调用点被链接到它；之后再执行这行代码不再走引导过程。

**捕获与非捕获的区别**：非捕获 Lambda（不引用任何外部变量）链接后每次求值返回同一个实例；捕获 Lambda 每次求值都 `new` 一个实例来装捕获值。这是当前 HotSpot 的实现行为，规范并不保证 Lambda 实例的同一性，所以不要用 `==` 比较 Lambda，也不要拿 Lambda 当锁或 Map 的 key。

为什么选择 `invokedynamic` 而不是直接编译成内部类：

- 类文件更少更小，不会每个 Lambda 都多一个 `.class`
- 生成策略留给运行时决定，JDK 升级（如改用隐藏类）不需要重新编译用户代码
- 首次链接有成本（生成类、解析方法句柄），对启动时间敏感的场景可借助 CDS / AOT 缓存，见 [启动与部署优化](/spring-boot/14_startup)

可序列化的 Lambda（目标类型实现了 `Serializable`）会改用 `LambdaMetafactory.altMetafactory`，并在宿主类生成 `$deserializeLambda$` 方法；除非框架需要（如部分 RPC 框架序列化 Lambda），一般不要让 Lambda 可序列化。`invokedynamic` 指令本身的执行过程见 [字节码执行](/jvm/3_bytecode)。

### 3、Lambda 与匿名内部类的区别

| 维度 | 匿名内部类 | Lambda |
|------|-----------|--------|
| 编译产物 | 独立类文件 `Outer$1.class` | 宿主类中的私有方法 + `invokedynamic` |
| 运行时类 | 编译期确定的普通类 | 首次链接时生成的隐藏类 |
| `this` 含义 | 匿名类实例自身 | 外围类实例（词法作用域） |
| 变量遮蔽 | 可声明与外部同名的局部变量 | 不允许与外围局部变量同名 |
| 目标类型 | 接口或抽象类，可有多个方法 | 只能是函数式接口 |
| 实例创建 | 每次 `new` 都新建 | 非捕获时可复用同一实例 |
| 状态 | 可以有自己的字段 | 无字段，只能捕获外部变量 |

匿名内部类与其他嵌套类的分类见 [内部类](./13_topic_inner_class)。

### 4、受检异常的处理

`java.util.function` 中的接口方法都没有声明 `throws`，Lambda 体内抛出受检异常无法通过编译。常见处理方式：

```java
// 方式一：就地包装为非受检异常（IO 场景用 UncheckedIOException）
List<String> contents = paths.stream()
    .map(p -> {
        try {
            return Files.readString(p);
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    })
    .toList();

// 方式二：自定义可抛异常的函数式接口，在边界处统一转换
@FunctionalInterface
interface ThrowingFunction<T, R> {
    R apply(T t) throws Exception;

    static <T, R> Function<T, R> unchecked(ThrowingFunction<T, R> f) {
        return t -> {
            try {
                return f.apply(t);
            } catch (RuntimeException e) {
                throw e;
            } catch (Exception e) {
                throw new IllegalStateException(e);
            }
        };
    }
}

List<String> contents2 = paths.stream()
    .map(ThrowingFunction.unchecked(Files::readString))
    .toList();
```

不建议用 Lombok `@SneakyThrows` 之类的手段「偷偷」抛出受检异常：调用方的 `catch (IOException e)` 会因为编译器认为不可能抛出而无法编写。异常体系见 [异常体系](./10_topic_exception)。

---

## 二、函数式接口与方法引用

### 1、@FunctionalInterface 与核心接口

函数式接口是**只有一个抽象方法**的接口（`default`、`static` 方法以及与 `Object` 公共方法同签名的抽象方法不计数）。`@FunctionalInterface` 不是必需的，加上后编译器会校验，防止后来者再加一个抽象方法破坏所有 Lambda 调用方。

`java.util.function` 的核心接口：

| 接口 | 方法签名 | 典型用途 |
|------|----------|----------|
| `Function<T,R>` | `R apply(T)` | 转换，`map` |
| `BiFunction<T,U,R>` | `R apply(T,U)` | 双参转换，`Map.merge` / `compute` |
| `UnaryOperator<T>` | `T apply(T)` | 同类型变换，`List.replaceAll` |
| `BinaryOperator<T>` | `T apply(T,T)` | 归约，`reduce` |
| `Predicate<T>` | `boolean test(T)` | 过滤，`filter` / `removeIf` |
| `Consumer<T>` | `void accept(T)` | 消费，`forEach` |
| `BiConsumer<T,U>` | `void accept(T,U)` | `Map.forEach` |
| `Supplier<T>` | `T get()` | 延迟创建，`orElseGet` / `ThreadLocal.withInitial` |

原始类型特化（`IntFunction`、`ToLongFunction`、`IntPredicate`、`IntBinaryOperator` 等）避免装箱，在热点路径和 `IntStream` / `LongStream` 中优先使用。

组合方法让小函数拼成大逻辑：

```java
Predicate<String> notBlank = Predicate.not(String::isBlank);       // JDK 11
Predicate<String> valid = notBlank.and(s -> s.length() <= 32);

Function<String, String> normalize = ((Function<String, String>) String::trim)
    .andThen(String::toLowerCase);

Comparator<User> order = Comparator.comparing(User::getDept)
    .thenComparing(User::getAge, Comparator.reverseOrder())
    .thenComparing(User::getName, Comparator.nullsLast(Comparator.naturalOrder()));
```

### 2、方法引用的四种形式

| 形式 | 示例 | 等价 Lambda |
|------|------|-------------|
| 静态方法 | `Integer::parseInt` | `s -> Integer.parseInt(s)` |
| 绑定实例方法（特定对象） | `System.out::println`、`prefix::concat` | `x -> System.out.println(x)` |
| 未绑定实例方法（任意对象） | `String::length` | `s -> s.length()` |
| 构造方法 / 数组构造 | `ArrayList::new`、`int[]::new` | `() -> new ArrayList<>()`、`n -> new int[n]` |

绑定实例方法引用有一个与 Lambda 不同的语义：**接收者在创建引用时就求值**。

```java
String prefix = null;
Supplier<String> lazy = () -> prefix.trim();   // 创建时不报错，调用 get() 时才 NPE
Supplier<String> eager = prefix::trim;         // 创建时立即 NPE
```

方法引用和 Lambda 编译后走同一套 `invokedynamic` 机制；方法引用通常直接把目标方法的句柄交给 `LambdaMetafactory`，不必再生成 `lambda$` 方法。

---

## 三、Stream

### 1、流水线与惰性求值

![Stream 流水线](../assets/java/java-stream-pipeline.svg)

Stream 由**数据源 + 零个或多个中间操作 + 一个终结操作**组成。它不存储数据，只描述对数据源的计算：

- **惰性求值**：中间操作只是把阶段挂到流水线上，终结操作调用时才从源头逐个拉取元素
- **纵向执行**：对无状态操作，一个元素会一口气走完 `filter → map → ...` 再处理下一个，而不是先把所有元素 `filter` 一遍再整体 `map`；因此流水线只遍历数据源一次
- **一次性**：一个流只能被消费一次，再次调用终结操作抛 `IllegalStateException`；需要重复使用时保存 `Supplier<Stream<T>>` 或直接保存集合

```java
List<String> result = Stream.of("apple", "kiwi", "banana", "fig", "cherry")
    .filter(s -> { System.out.println("filter " + s); return s.length() > 3; })
    .map(s -> { System.out.println("map " + s); return s.toUpperCase(); })
    .limit(2)
    .toList();
// 输出：filter apple, map apple, filter kiwi, map kiwi, 然后结束
// banana / fig / cherry 根本没被访问——limit 是短路操作
```

中间操作按是否需要「看到其他元素」分为：

| 类别 | 操作 | 说明 |
|------|------|------|
| 无状态 | `filter` `map` `flatMap` `mapMulti` `peek` | 每个元素独立处理 |
| 有状态 | `sorted` `distinct` `limit` `skip` | 需要缓冲或计数；`sorted` 必须拿到全部上游元素才能输出第一个，是整条流水线的「屏障」 |
| 短路 | `limit` `takeWhile`（中间）/ `findFirst` `findAny` `anyMatch` `allMatch` `noneMatch`（终结） | 满足条件即停止拉取，可作用于无限流 |

`peek` 只用于调试；从 JDK 9 起，若终结操作能直接从源头算出结果（如对 `SIZED` 流调用 `count()`），流水线可能被跳过，`peek` 里的副作用不会执行。

### 2、常用操作速查

| 操作 | 示例 | 说明 |
|------|------|------|
| 创建流 | `list.stream()`、`Stream.of(a, b)`、`Arrays.stream(arr)` | 顺序流 |
| 过滤 | `filter(x -> x > 10)` | |
| 映射 | `map(String::toUpperCase)` | 一对一 |
| 扁平映射 | `flatMap(o -> o.getItems().stream())` | 一对多，`List<List<T>>` → `Stream<T>` |
| 去重 | `distinct()` | 依赖 `equals` / `hashCode` |
| 排序 | `sorted(Comparator.comparing(User::getAge))` | 有状态 |
| 收集为 List | `toList()`（JDK 16） | 返回**不可修改**列表，允许 `null` 元素 |
| 收集为可变 List | `collect(Collectors.toList())` | 规范不保证类型与可变性，当前实现是 `ArrayList` |
| 收集为不可变 List | `collect(Collectors.toUnmodifiableList())`（JDK 10） | 不可修改，遇到 `null` 抛 NPE |
| 计数 / 极值 | `count()`、`max(cmp)` | `max` 返回 `Optional` |
| 归约 | `reduce(0, Integer::sum)` | |
| 遍历 | `forEach(...)` | 有副作用；并行流下不保证顺序，需要有序时用 `forEachOrdered` |

JDK 16 之后新代码优先用 `Stream.toList()`；只有确实要在结果上继续 `add` / `remove` 时，才用 `collect(Collectors.toCollection(ArrayList::new))` 明确声明可变。

### 3、Collectors 收集器

```java
List<Employee> employees = loadEmployees();

// 分组
Map<String, List<Employee>> byDept = employees.stream()
    .collect(Collectors.groupingBy(Employee::getDept));

// 分组 + 下游收集器：计数、平均、取最大
Map<String, Long> countByDept = employees.stream()
    .collect(Collectors.groupingBy(Employee::getDept, Collectors.counting()));
Map<String, Double> avgSalary = employees.stream()
    .collect(Collectors.groupingBy(Employee::getDept, Collectors.averagingDouble(Employee::getSalary)));
Map<String, Optional<Employee>> topByDept = employees.stream()
    .collect(Collectors.groupingBy(Employee::getDept,
             Collectors.maxBy(Comparator.comparingDouble(Employee::getSalary))));

// 需要有序 Map 时显式指定 Map 工厂（groupingBy 默认 HashMap）
TreeMap<String, List<String>> namesByDept = employees.stream()
    .collect(Collectors.groupingBy(Employee::getDept, TreeMap::new,
             Collectors.mapping(Employee::getName, Collectors.toList())));

// 二分
Map<Boolean, List<Employee>> highPaid = employees.stream()
    .collect(Collectors.partitioningBy(e -> e.getSalary() >= 10_000));

// 拼接
String names = employees.stream()
    .map(Employee::getName)
    .collect(Collectors.joining(", ", "[", "]"));
```

**`Collectors.toMap` 的两个坑**：

```java
// 坑 1：key 重复直接抛 IllegalStateException: Duplicate key
Map<String, Employee> byName = employees.stream()
    .collect(Collectors.toMap(Employee::getName, Function.identity()));

// 修正：提供合并函数（这里保留先出现的），需要保持顺序时再给 Map 工厂
Map<String, Employee> byName2 = employees.stream()
    .collect(Collectors.toMap(Employee::getName, Function.identity(),
             (first, second) -> first, LinkedHashMap::new));

// 坑 2：value 为 null 抛 NPE（内部用的是 HashMap.merge，不接受 null 值）
// 修正：value 可能为 null 时改用三参 collect
Map<String, String> emailByName = employees.stream()
    .collect(HashMap::new, (m, e) -> m.put(e.getName(), e.getEmail()), HashMap::putAll);
```

### 4、reduce 与原始类型流

```java
int total = IntStream.rangeClosed(1, 100).sum();                       // 5050，优先用专用方法
Optional<Integer> max = Stream.of(3, 1, 4, 1, 5, 9).reduce(Integer::max);
BigDecimal amount = orders.stream()
    .map(Order::getAmount)
    .reduce(BigDecimal.ZERO, BigDecimal::add);                         // 金额求和的标准写法

IntSummaryStatistics stats = employees.stream()
    .mapToInt(Employee::getAge)
    .summaryStatistics();                                              // 一次遍历得到 count/min/max/avg/sum
```

`reduce(identity, accumulator, combiner)` 要求 `identity` 是真正的单位元、`accumulator` 满足结合律，否则并行流结果错误。数值计算用 `mapToInt` / `mapToLong` 转成原始类型流，避免装箱；字符串拼接用 `joining` 而不是 `reduce("", String::concat)`（后者是 O(n²) 拷贝）。

### 5、JDK 9+ 新增操作

```java
// JDK 9：takeWhile / dropWhile ——对有序流按前缀截断（遇到第一个不满足的就停）
List<Integer> head = Stream.of(1, 2, 3, 10, 4).takeWhile(i -> i < 5).toList();   // [1, 2, 3]
List<Integer> tail = Stream.of(1, 2, 3, 10, 4).dropWhile(i -> i < 5).toList();   // [10, 4]

// JDK 9：带终止条件的 iterate，替代 iterate + limit
Stream.iterate(1, i -> i <= 1024, i -> i * 2).forEach(System.out::println);

// JDK 9：ofNullable，把可能为 null 的单值变成 0 或 1 个元素的流
Stream<String> s = Stream.ofNullable(System.getenv("APP_PROFILE"));

// JDK 16：mapMulti，一对多展开且不必为每个元素创建中间 Stream
List<Item> items = orders.stream()
    .<Item>mapMulti((order, sink) -> order.getItems().forEach(sink))
    .toList();
```

`flatMap` 要为每个元素新建一个 `Stream`，当每个元素只展开出很少几个结果时，`mapMulti` 开销更低。

JDK 24 正式发布的 **Stream Gatherers**（JEP 485）允许自定义中间操作，内置窗口、`scan`、`fold`、`mapConcurrent` 等，用法见 [版本演进](./2_version)。

### 6、并行流

![并行流执行过程](../assets/java/java-parallel-stream.svg)

`parallelStream()` / `.parallel()` 的执行过程：

1. **拆分**：数据源的 `Spliterator.trySplit()` 递归把数据一分为二。`ArrayList`、数组、`IntStream.range` 能精确均分；`LinkedList`、`Stream.iterate`、`BufferedReader.lines()` 拆分效果差，并行几乎没有收益。
2. **执行**：子任务提交到 **`ForkJoinPool.commonPool()`**。它的默认并行度是 `Runtime.availableProcessors() - 1`，而发起终结操作的调用线程也会参与执行任务，所以实际约有 CPU 核数个线程在干活。可通过 `-Djava.util.concurrent.ForkJoinPool.common.parallelism=N` 调整，但这是 JVM 全局设置。
3. **合并**：结果逐层 `combine`。`sorted`、`distinct`、`limit`、`findFirst` 这类依赖顺序的操作在合并阶段要付出额外代价；不关心顺序时用 `unordered()`、`findAny()` 可以减轻。

**线上最常见的问题**：

- **阻塞 IO 拖垮 commonPool**：commonPool 是整个 JVM 共享的，`CompletableFuture.supplyAsync` 不指定线程池时用的也是它（并行度大于 1 时）。在并行流里调 RPC、查数据库，会把这几个线程全部阻塞住，进而拖慢所有依赖 commonPool 的代码。IO 并发请用专门的线程池或虚拟线程，见 [CompletableFuture](./29_topic_completable_future)、[线程池](./28_topic_thread_pool)。
- **共享可变状态**：在 `forEach` 里往 `ArrayList` / `HashMap` 写数据会丢数据或抛异常，必须用 `collect` 让框架负责合并。
- **数据量小或单元素计算很轻**：拆分、调度、合并的开销超过收益，通常比顺序流更慢。
- **把并行流提交到自定义 `ForkJoinPool` 执行**：`pool.submit(() -> list.parallelStream()...).get()` 这种写法能让任务跑在指定池里，但依赖的是实现细节而非规范，不建议作为正式方案。

适用场景：数据量大（通常十万级以上）、数据源可均匀拆分、每个元素是纯 CPU 计算且无共享状态。是否真的变快要用 JMH 测，见 [基准测试（JMH）](/high-perf/4_benchmark)。

---

## 四、Optional

`Optional` 的设计目的只有一个：**作为方法返回值，明确表达「可能没有结果」**，迫使调用方处理空的情况。

```java
public Optional<User> findByEmail(String email) {
    return Optional.ofNullable(userMapper.selectByEmail(email));
}

// 调用方：链式转换 + 兜底
String city = userService.findByEmail(email)
    .map(User::getAddress)            // map：函数返回普通值，结果自动包成 Optional
    .map(Address::getCity)
    .orElse("unknown");

// flatMap：函数本身返回 Optional 时用，避免 Optional<Optional<T>>
Optional<Account> account = userService.findByEmail(email)
    .flatMap(user -> accountService.findByUserId(user.getId()));

// 没有结果就是业务错误时直接抛
User user = userService.findByEmail(email)
    .orElseThrow(() -> new NotFoundException("user not found: " + email));
```

**使用规则**：

| 规则 | 说明 |
|------|------|
| 只用作返回类型 | 不要用作字段（`Optional` 不可序列化、多一层对象）、方法参数、集合元素 |
| 返回集合时不包 Optional | 没有数据就返回空集合，`Optional<List<T>>` 是多余的 |
| 不要对 Optional 变量赋 `null` | 方法返回 `Optional` 时绝不能返回 `null` |
| `orElse` 与 `orElseGet` | `orElse(x)` 的参数**总是先求值**，即使有值也会执行；默认值需要计算（查库、new 对象）时用 `orElseGet(supplier)` |
| 避免 `isPresent()` + `get()` | 这只是换个写法的判空，用 `map` / `orElse` / `ifPresent` 代替 |
| 原始类型 | 用 `OptionalInt` / `OptionalLong` / `OptionalDouble` 避免装箱 |

```java
// orElse 的陷阱：即使 cache 命中，loadFromDb 也会执行
String v1 = cache.get(key).orElse(loadFromDb(key));
// 正确：只有为空时才执行
String v2 = cache.get(key).orElseGet(() -> loadFromDb(key));
```

各版本新增的 API：

| 版本 | 方法 | 作用 |
|------|------|------|
| JDK 9 | `ifPresentOrElse(action, emptyAction)` | 有值 / 无值分别处理 |
| JDK 9 | `or(supplier)` | 为空时换成另一个 `Optional`（多级兜底） |
| JDK 9 | `stream()` | 转为 0 或 1 个元素的流，便于 `flatMap(Optional::stream)` 过滤掉空值 |
| JDK 10 | `orElseThrow()` | 无参版本，语义同 `get()`，但名字明确表达「可能抛异常」 |
| JDK 11 | `isEmpty()` | 与 `isPresent()` 相反 |

---

## 五、注解

### 1、定义与属性限制

注解（JDK 5）是附加在声明或类型上的元数据，本身不包含行为，需要由编译器、注解处理器或运行时框架读取后才产生作用。

```java
@Documented
@Retention(RetentionPolicy.RUNTIME)
@Target({ElementType.METHOD, ElementType.TYPE})
public @interface RateLimit {
    String key() default "";
    int permitsPerSecond() default 100;
    TimeUnit unit() default TimeUnit.SECONDS;
}
```

属性的限制：

- 类型只能是：基本类型、`String`、`Class`、枚举、其他注解，以及它们的一维数组
- 值必须是**编译期常量**（字面量、`static final` 常量表达式、枚举常量、类字面量），不能是方法调用结果
- 默认值不能是 `null`；需要「未设置」语义时用空串、`-1` 或专门的哨兵值
- 只有一个名为 `value` 的属性时，使用时可省略属性名：`@RateLimit("login")`（前提是该注解声明了 `value`）

### 2、元注解

| 元注解 | 作用 | 要点 |
|--------|------|------|
| `@Retention` | 保留到哪个阶段 | `SOURCE`：编译后丢弃（`@Override`、Lombok 注解）；`CLASS`：写入 class 文件但运行时不可见，**这是默认值**；`RUNTIME`：运行时可通过反射读取。自定义注解要被 Spring 等框架读取，必须是 `RUNTIME` |
| `@Target` | 能标注在哪里 | `TYPE`、`METHOD`、`FIELD`、`PARAMETER` 等；JDK 8 新增 `TYPE_PARAMETER` / `TYPE_USE`（可标注在任何使用类型的位置，如 `List<@NonNull String>`），JDK 9 新增 `MODULE`，JDK 16 新增 `RECORD_COMPONENT` |
| `@Inherited` | 子类继承父类上的注解 | 只对**类上的注解**、只沿**父类**生效；接口上的注解、方法上的注解都不会被继承 |
| `@Repeatable` | 同一位置可重复标注（JDK 8） | 需要一个容器注解；读取时用 `getAnnotationsByType`，`getAnnotation` 拿不到重复的注解 |
| `@Documented` | 出现在 Javadoc 中 | 仅影响文档 |

### 3、运行时读取

```java
Method method = OrderController.class.getMethod("create", OrderRequest.class);
RateLimit limit = method.getAnnotation(RateLimit.class);   // RUNTIME 保留才非 null
if (limit != null) {
    rateLimiter.acquire(limit.key(), limit.permitsPerSecond());
}
```

JDK 的 `getAnnotation` 只看直接标注的注解（加上 `@Inherited` 规则），**不识别元注解组合**：方法上标了 `@GetMapping`，用 `getAnnotation(RequestMapping.class)` 拿到的是 `null`。Spring 通过 `MergedAnnotations` / `AnnotatedElementUtils` 递归解析元注解，并用 `@AliasFor` 把组合注解的属性映射到元注解属性，这才有了 `@RestController`、`@GetMapping` 这类组合注解。业务中用注解驱动横切逻辑（限流、审计、幂等）通常借助切面实现，见 [AOP](/spring/2_aop)。反射 API 本身见 [反射](./15_topic_reflection)。

### 4、注解处理器

注解处理器（JSR 269，`javax.annotation.processing`）在**编译期**运行：javac 解析源码后，按轮次（round）把标注了目标注解的元素交给处理器；处理器生成的新源文件会进入下一轮继续编译，直到没有新文件产生。

```java
@SupportedAnnotationTypes("com.example.Descriptor")
public class DescriptorProcessor extends AbstractProcessor {

    @Override
    public SourceVersion getSupportedSourceVersion() {
        return SourceVersion.latestSupported();     // 不要硬编码 RELEASE_17，否则新 JDK 上会报警告
    }

    @Override
    public boolean process(Set<? extends TypeElement> annotations, RoundEnvironment roundEnv) {
        for (Element element : roundEnv.getElementsAnnotatedWith(Descriptor.class)) {
            if (element.getKind() != ElementKind.CLASS) {
                processingEnv.getMessager().printMessage(
                    Diagnostic.Kind.ERROR, "@Descriptor 只能标注在类上", element);   // 直接让编译失败
                continue;
            }
            TypeElement type = (TypeElement) element;
            String pkg = processingEnv.getElementUtils().getPackageOf(type).getQualifiedName().toString();
            String name = type.getSimpleName() + "Descriptor";
            try (Writer writer = processingEnv.getFiler()
                    .createSourceFile(pkg + "." + name, type).openWriter()) {
                writer.write("package " + pkg + ";\n\n"
                    + "public final class " + name + " {\n"
                    + "    public static final String TYPE = \"" + type.getQualifiedName() + "\";\n"
                    + "}\n");
            } catch (IOException e) {
                processingEnv.getMessager().printMessage(Diagnostic.Kind.ERROR, e.getMessage(), element);
            }
        }
        return true;
    }
}
```

要点：

- **只能生成新文件，不能修改已有类**。标准处理器（MapStruct、Dagger、AutoValue、Spring 的 `spring-context-indexer` 等）都是「读注解 → 生成新类」
- **Lombok 是例外**：它借用注解处理器的入口，却直接修改 javac 内部的语法树（AST），往原有类里塞 getter / 构造器。这依赖 javac 的内部 API，所以每个新 JDK 都要等 Lombok 发布适配版本，详见 [效率工具库](./98_dev_tool)
- **注册方式**：在处理器 jar 的 `META-INF/services/javax.annotation.processing.Processor` 中列出类名（可用 Google AutoService 自动生成）
- **生成源码**：手写字符串容易出错，可用 JavaPoet。原 `square/javapoet` 已归档，维护中的分支是 `com.palantir.javapoet:javapoet`

**JDK 23 的默认行为变化**：从 JDK 23 起，javac **不再自动运行类路径上发现的注解处理器**，除非显式指定处理器（`-processor`、`--processor-path` / `-processorpath`、`--processor-module-path`）或使用 `-proc:full`。JDK 21 起在隐式运行处理器时会给出提示。升级到 JDK 23+ 后最典型的症状是「Lombok 的 getter 突然找不到」「MapStruct 的实现类没有生成」。正确做法是在构建工具中显式声明处理器路径：

```xml
<plugin>
    <groupId>org.apache.maven.plugins</groupId>
    <artifactId>maven-compiler-plugin</artifactId>
    <configuration>
        <annotationProcessorPaths>
            <path>
                <groupId>com.example</groupId>
                <artifactId>descriptor-processor</artifactId>
                <version>1.0.0</version>
            </path>
        </annotationProcessorPaths>
    </configuration>
</plugin>
```

Gradle 的 `annotationProcessor` 依赖配置本来就走处理器路径，不受影响。Lombok + MapStruct 的完整配置见 [效率工具库](./98_dev_tool)，构建工具本身见 [构建工具](/engineering/1_build_tools)。

---

## 小结

- Lambda 由 javac 脱糖为私有方法 + `invokedynamic`，首次执行时由 `LambdaMetafactory` 生成隐藏类并链接 CallSite；它不是匿名内部类，`this` 指外围实例，不生成 `.class` 文件
- 捕获的局部变量必须 effectively final；非捕获 Lambda 可复用实例，但规范不保证同一性
- 函数式接口只有一个抽象方法；方法引用分静态、绑定实例、未绑定实例、构造四种，绑定引用的接收者在创建时就求值
- Stream 惰性、纵向、一次性；操作分无状态、有状态、短路三类；JDK 16+ 用 `toList()` 收集，`toMap` 注意重复 key 和 null 值
- 并行流跑在 JVM 共享的 commonPool 上（并行度 CPU 核数 − 1，调用线程也参与），只适合大数据量、可均匀拆分、纯 CPU 计算；阻塞 IO 绝不要放进并行流
- Optional 只做返回值；默认值需要计算时用 `orElseGet`
- 注解靠元注解定义保留期与位置；JDK 反射不识别元注解组合，Spring 用 `MergedAnnotations` 实现；注解处理器只能生成新文件，Lombok 修改 AST 是特例；JDK 23 起必须显式声明处理器路径

> 下一篇：[版本演进](./2_version) —— 从 JDK 8 到 27，按升级路径梳理各版本的关键特性与迁移坑点。
