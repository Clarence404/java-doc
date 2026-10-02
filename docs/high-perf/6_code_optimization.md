---
description: 对象复用、集合预分配、字符串、装箱、锁、异常、日志、Stream
---

# 代码级优化

> **本篇目标**：掌握热点路径上最常见的代码级优化手段，知道哪些值得改、哪些只是徒增复杂度。
>
> **前置阅读**：[JVM 层性能策略](./5_jvm_tuning)

代码级优化的前提是**先用 Profiler 确认热点就在这里**（见 [性能分析工具](./3_profilers)）。以下手段在热点路径（高频调用、大循环、核心接口）上收益明显，在冷代码上优先保证可读性；优化效果用 [基准测试（JMH）](./4_benchmark) 验证。

---

## 一、对象创建与复用

### 1、避免在热点路径上创建昂贵对象

一些对象创建或初始化代价很高，且线程安全，应作为常量复用：

```java
// Bad：每次调用都编译正则、创建 ObjectMapper
public boolean isValid(String email) {
    return Pattern.compile("^[\\w.-]+@[\\w.-]+$").matcher(email).matches();
}
public String toJson(Object obj) throws JsonProcessingException {
    return new ObjectMapper().writeValueAsString(obj);
}

// Good：线程安全的对象作为 static final 复用
private static final Pattern EMAIL = Pattern.compile("^[\\w.-]+@[\\w.-]+$");
private static final ObjectMapper MAPPER = new ObjectMapper();

public boolean isValid(String email) {
    return EMAIL.matcher(email).matches();
}
public String toJson(Object obj) throws JsonProcessingException {
    return MAPPER.writeValueAsString(obj);
}
```

| 可安全复用（线程安全） | 不可直接共享（非线程安全） |
|------------------------|----------------------------|
| `Pattern`、`ObjectMapper`（配置完成后）、`DateTimeFormatter` | `Matcher`、`SimpleDateFormat`、`StringBuilder` |

- `String.matches()`、`String.split()`（多字符正则）、`String.replaceAll()` 内部每次都会编译正则，热点路径上应改用预编译的 `Pattern`。
- `SimpleDateFormat` 非线程安全，JDK 8+ 使用 `DateTimeFormatter` 替代，见 [时间 API](/java/17_topic_time)。

### 2、不要自作聪明地做对象池

现代 JVM 分配小对象极快（TLAB 上指针碰撞），短命对象在年轻代回收几乎零成本。**只有创建代价高的资源（连接、线程、大缓冲区）才值得池化**，见 [池化技术](./7_pooling)。

---

## 二、集合预分配

`ArrayList` 默认扩容 1.5 倍，`HashMap` 超过 `容量 × 0.75` 时扩容并 rehash。已知元素数量时，预分配可以避免多次扩容和数组复制：

```java
// Bad：从默认容量开始多次扩容
List<UserDTO> result = new ArrayList<>();
Map<Long, User> index = new HashMap<>();
for (User u : users) {
    result.add(convert(u));
    index.put(u.getId(), u);
}

// Good：按已知大小预分配
List<UserDTO> result = new ArrayList<>(users.size());
// HashMap 需按负载因子换算：expected / 0.75 + 1
Map<Long, User> index = new HashMap<>((int) (users.size() / 0.75f) + 1);
```

- JDK 19+ 提供 `HashMap.newHashMap(int numMappings)`，Guava 提供 `Maps.newHashMapWithExpectedSize(n)`，可避免手动换算出错。
- 常见误区：`new HashMap<>(users.size())` 并不能保证不扩容，因为阈值是 `容量 × 0.75`。
- 集合的扩容机制见 [集合专题](/java/21_topic_collection)。

---

## 三、字符串处理

```java
// Bad：循环中用 + 拼接，每次都生成新字符串并复制
String sql = "";
for (String col : columns) {
    sql += col + ",";
}

// Good：使用 StringBuilder，或更语义化的 StringJoiner / String.join
StringBuilder sb = new StringBuilder(columns.size() * 16);
for (String col : columns) {
    sb.append(col).append(',');
}
String joined = String.join(",", columns);
```

| 场景 | 建议 |
|------|------|
| 单个表达式内拼接（`a + b + c`） | 直接用 `+`，编译器（JDK 9+ 为 `invokedynamic`）已优化 |
| 循环内拼接 | `StringBuilder`，能估算长度时预分配 |
| 按分隔符连接集合 | `String.join` / `Collectors.joining` |
| 单字符分割 | `split(",")` 单字符非正则元字符有快速路径；复杂分隔符用预编译 `Pattern` |
| 大量重复字符串（如枚举值、状态码） | 优先在业务层复用常量或枚举；JVM 层可开启 `-XX:+UseStringDeduplication`；`intern()` 慎用 |

- `-XX:+UseStringDeduplication` 最早只支持 G1，JDK 18 起 Serial、Parallel、ZGC 等收集器也支持；它只让内容相同的 String **共享底层 `byte[]`**，String 对象本身并不合并，`==` 结果不变。
- `intern()` 会把字符串放进 JVM 全局 StringTable，数量大时哈希冲突和 GC 扫描开销明显，且容易误用于用户输入导致表膨胀；确需规范化时更推荐应用层的 `Map` / Guava `Interner`，范围可控。

字符串的内部实现（Compact Strings、常量池）见 [String 专题](/java/11_topic_string)。

---

## 四、避免自动装箱

包装类型对象占用更多内存，装箱/拆箱在大循环中会产生大量临时对象：

```java
// Bad：Long 累加，每次循环都装箱产生新对象
Long sum = 0L;
for (int i = 0; i < 1_000_000; i++) {
    sum += i;
}
Map<Integer, Integer> counter = new HashMap<>();   // 计数场景大量装箱

// Good：使用基本类型
long sum = 0L;
for (int i = 0; i < 1_000_000; i++) {
    sum += i;
}
int[] counter = new int[MAX_KEY];                   // key 范围有限时直接用数组
```

- Stream 中使用 `mapToInt` / `IntStream` / `LongStream` 替代 `Stream<Integer>`。
- 大量基本类型集合可考虑 Eclipse Collections、fastutil 等原生类型集合库。
- 注意 `Integer` 缓存只覆盖 -128～127，超出范围用 `==` 比较会出错，这是正确性问题而不只是性能问题。

---

## 五、锁粒度与无锁化

```java
// Bad：整个方法加锁，把耗时的 IO 也放进临界区
public synchronized void record(String key, Event event) {
    Stats s = statsMap.computeIfAbsent(key, k -> new Stats());
    s.add(event);
    auditLogger.write(event);        // IO 操作在锁内
}

// Good：用并发容器 + 原子类缩小临界区，IO 移出锁
private final ConcurrentHashMap<String, LongAdder> counters = new ConcurrentHashMap<>();

public void record(String key, Event event) {
    counters.computeIfAbsent(key, k -> new LongAdder()).increment();
    auditLogger.write(event);
}
```

| 手段 | 说明 |
|------|------|
| 缩小临界区 | 只把必须互斥的操作放进锁内，IO、RPC、日志移出 |
| 锁分段 / 分片 | 按 key 哈希到多把锁，降低竞争（`ConcurrentHashMap` 的思路） |
| 读写分离 | 读多写少用 `ReadWriteLock` 或 `StampedLock` 的乐观读 |
| 无锁化 | 计数用 `LongAdder`，状态更新用 CAS（`AtomicReference`） |
| 不可变对象 / 线程封闭 | 不共享就不需要锁，如 `ThreadLocal`、每请求独立对象 |

锁与原子类的原理见 [Lock 专题](/java/25_topic_lock)、[原子类专题](/java/26_topic_atomic)。

---

## 六、热点路径上减少异常

创建异常时 `fillInStackTrace()` 需要遍历调用栈，代价远高于普通对象。不要用异常做流程控制：

```java
// Bad：用异常判断是否为数字，非法输入多时开销很大
public boolean isNumber(String s) {
    try {
        Long.parseLong(s);
        return true;
    } catch (NumberFormatException e) {
        return false;
    }
}

// Good：先做廉价校验，只有极少数边界情况才走异常路径
public boolean isNumber(String s) {
    if (s == null || s.isEmpty()) {
        return false;
    }
    char first = s.charAt(0);
    int start = (first == '-' || first == '+') ? 1 : 0;   // 与 Long.parseLong 一致，允许正负号前缀
    if (start == s.length()) {
        return false;
    }
    for (int i = start; i < s.length(); i++) {
        char c = s.charAt(i);
        if (c < '0' || c > '9') {
            return false;
        }
    }
    if (s.length() - start <= 18) {
        return true;              // 18 位以内一定不会溢出 long
    }
    try {                         // 19 位及以上才需要精确判断溢出
        Long.parseLong(s);
        return true;
    } catch (NumberFormatException e) {
        return false;
    }
}
```

- 业务异常若确实高频抛出且不需要栈信息，可以重写 `fillInStackTrace()` 或使用 `super(message, null, false, false)` 关闭栈追踪。
- JVM 的 `-XX:+OmitStackTraceInFastThrow` 会让频繁抛出的内置异常丢失堆栈，排障时注意。异常体系见 [异常专题](/java/10_topic_exception)。

---

## 七、日志开销

```java
// Bad：无论是否输出，字符串拼接和 toString() 都会执行
log.debug("order detail: " + order + ", items: " + JSON.toJSONString(items));

// Good：占位符延迟格式化；昂贵参数用级别判断或 Supplier
log.debug("order detail: {}, items: {}", order, items.size());

if (log.isDebugEnabled()) {
    log.debug("items json: {}", JSON.toJSONString(items));
}
```

| 要点 | 说明 |
|------|------|
| 使用占位符 | SLF4J `{}` 在级别不满足时不做格式化 |
| 昂贵参数加级别判断 | 占位符不能阻止参数本身的计算（如序列化） |
| 异步 Appender | Logback `AsyncAppender`、Log4j2 `AsyncLogger`，避免磁盘 IO 阻塞业务线程 |
| 控制日志量 | 大循环内不逐条打日志；生产避免 DEBUG 全量开启 |
| 慎用位置信息 | `%L`、`%M`、`%C` 需要获取调用栈，开销大 |

日志体系建设见 [日志](/observability/1_logging)。

---

## 八、Stream 与循环

| 场景 | 建议 |
|------|------|
| 普通业务代码、数据量小 | 优先可读性，Stream 与循环性能差异可忽略 |
| 超高频热点、极小集合 | 传统循环略快（无 lambda 和管道对象开销） |
| 基本类型运算 | 用 `IntStream` 等避免装箱 |
| `parallelStream` | 仅适合大数据量、CPU 密集、无共享状态的任务；默认使用公共 `ForkJoinPool`，**不要在 Web 请求中对 IO 任务使用** |
| 多次遍历同一集合 | 合并为一次遍历，避免多个 Stream 管道重复扫描 |

```java
// Bad：两次遍历 + 装箱
long count = orders.stream().filter(o -> o.getAmount() > 100).count();
int total = orders.stream().map(Order::getAmount).reduce(0, Integer::sum);

// Good：一次遍历、基本类型
int total = 0;
long count = 0;
for (Order o : orders) {
    int amount = o.getAmount();
    total += amount;
    if (amount > 100) {
        count++;
    }
}
```

---

## 九、优化清单

| 类别 | 检查项 |
|------|--------|
| 对象 | 热点路径上是否重复创建 `Pattern`、`ObjectMapper`、格式化器 |
| 集合 | 已知大小的集合是否预分配；是否误用 `LinkedList` 做随机访问；`contains` 是否在 `List` 上做 |
| 字符串 | 循环内是否用 `+` 拼接；是否频繁用 `split` / `replaceAll` 正则 |
| 装箱 | 累加、计数、Stream 是否使用了包装类型 |
| 锁 | 锁内是否有 IO、RPC；是否可用并发容器或原子类替代 |
| 异常 | 是否用异常做流程控制 |
| 日志 | 是否使用占位符；昂贵参数是否有级别判断；是否使用异步 Appender |
| 算法 | 是否存在嵌套循环查找（O(n²)），可否用 `Map` 索引降为 O(n) |

---

## 小结

- 先定位后优化：只在 Profiler 确认的热点路径上动手，冷代码优先可读性
- 线程安全的昂贵对象（`Pattern`、`ObjectMapper`、`DateTimeFormatter`）作为常量复用；普通小对象不要池化
- 集合按预期大小预分配，循环内用 `StringBuilder`，大循环避免装箱
- 缩小临界区、把 IO 移出锁；不要用异常做流程控制；日志用占位符 + 异步 Appender
- 每项改动都用 JMH 或压测验证收益

> 下一篇：[池化技术](./7_pooling) —— 连接、线程等昂贵资源如何复用，池子为什么不是越大越好。
