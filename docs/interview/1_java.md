---
description: Lambda 与 Stream、版本特性、异常、String、泛型、反射与代理、IO、序列化、集合
---

# 开发总结 - Java

> 精华提炼，细节详见 [Java 总览](/java/0_overview)；题目清单见 [Java 面试题](/java/99_interview)，本页按清单「综合与版本 / 语言机制 / IO 与数据」三组的分组与顺序作答，「并发」一组见 [开发总结 - Java 并发](/interview/2_concurrent)。
> 版本基线：JDK 21 / 25 LTS（26、27 为非 LTS），与 JDK 8 / 17 行为不同之处在答案中单独标注。类加载与双亲委派见 [开发总结 - JVM](/interview/3_jvm)。

## 一、综合与版本

### Q1：`==` 和 `equals()` 的区别？为什么重写 `equals` 必须重写 `hashCode`？`Integer.valueOf(127) == Integer.valueOf(127)` 为什么是 true？

**核心结论**：`==` 对基本类型比较值、对引用类型比较是否同一个对象；`equals` 比较逻辑相等，`Object` 的默认实现就是 `==`。哈希容器先按 `hashCode` 定位桶、再用 `equals` 判等，两者不一致时「相等的对象」会落进不同的桶，`HashMap` / `HashSet` 就会找不到或存出重复元素。

| 约定 | 说明 |
|------|------|
| `a.equals(b)` 为 true | `a.hashCode() == b.hashCode()` 必须成立 |
| `hashCode` 相等 | 不要求 `equals` 为 true（这就是哈希冲突） |
| 参与 `hashCode` 的字段 | 放进哈希容器后不能再改，否则再也找不到这个元素 |

**Integer 缓存**：`Integer.valueOf` 和自动装箱对 **−128 ~ 127** 返回缓存的同一个对象，所以 127 用 `==` 比较为 true、128 为 false。上界可用 `-XX:AutoBoxCacheMax` 调大，下界固定。

| 包装类 | 缓存范围 |
|-------|---------|
| `Byte` / `Short` / `Integer` / `Long` | −128 ~ 127（只有 `Integer` 上界可调） |
| `Character` | 0 ~ 127 |
| `Boolean` | `TRUE` / `FALSE` 两个常量 |
| `Float` / `Double` | 不缓存 |

- 包装类之间比较一律用 `equals`，或拆箱后比较；`Integer` 为 null 时自动拆箱抛 NPE，三元表达式混用包装类与基本类型也会触发拆箱
- 包装类是值类型类（JEP 390）：构造器 `new Integer(...)` 已标记待移除，不要在它们上 `synchronized`
- 值对象首选 `record`，`equals` / `hashCode` 由编译器按全部组件生成

→ 详见 [集合框架](/java/21_topic_collection#_5、key-的设计)、[享元模式](/patterns/11_structural_flyweight#一、jdk-中的享元)

### Q2：抽象类和接口的区别？Java 为什么不支持类的多继承，接口默认方法冲突怎么解决？

**核心结论**：抽象类表达「是什么」，可以有实例状态、构造器和任意访问级别的方法，只能单继承；接口表达「能做什么」，没有实例状态，一个类可以实现多个。Java 不允许多继承**状态和实现**的类，是为了避开菱形继承的二义性；JDK 8 的默认方法允许多继承**行为**，冲突时按固定规则解决。

| 维度 | 抽象类 | 接口 |
|------|-------|------|
| 字段 | 任意实例字段与静态字段 | 只有 `public static final` 常量 |
| 构造器 | 有 | 无 |
| 方法 | 抽象方法 + 任意具体方法 | 抽象方法；JDK 8 起 `default` / `static` 方法；JDK 9 起 `private` 方法 |
| 继承 | 单继承 | 多实现；JDK 17 起可用 `sealed` 限定实现类 |
| 适用 | 模板方法、共享状态与骨架实现 | 能力契约、回调、多态的类型边界 |

默认方法冲突的三条规则：

1. **类优先**：父类中的同签名方法（含抽象方法）胜过接口的默认方法
2. **更具体的接口优先**：子接口覆盖了父接口的默认方法时，子接口的胜出
3. 仍然无法决定时**编译报错**，实现类必须重写，可用 `A.super.method()` 显式选择某一个接口的实现

- 继承是 is-a，聚合 / 组合是 has-a；复用实现优先用组合，继承会把父类实现细节暴露给子类（脆弱基类问题）
- JDK 17+ 的 `sealed` 接口 + `record` 实现，可以让编译器检查 `switch` 是否覆盖所有子类型（见 Q9）

→ 详见 [版本演进](/java/2_version#_5、sealed-类-java-17)、[模板方法模式](/patterns/21_behavioral_template_method)

### Q3：Lambda 的底层原理是什么？和匿名内部类有什么区别？为什么只能捕获 effectively final 的局部变量？

**核心结论**：javac 把 Lambda 体编译成外部类的私有方法，在调用处生成一条 `invokedynamic`；第一次执行时引导方法 `LambdaMetafactory` 在运行时生成实现函数式接口的**隐藏类**（JDK 15+）并链接调用点。它不是匿名内部类的语法糖，编译期不产生 `Outer$1.class`。

| 维度 | Lambda | 匿名内部类 |
|------|--------|-----------|
| 编译产物 | 私有方法 `lambda$main$0` + `invokedynamic` | 独立的 `Outer$1.class` |
| 运行时类 | 首次执行时生成隐藏类 | 类加载时加载已有的 class |
| `this` | 指向外围实例 | 指向匿名类实例自身 |
| 外部实例引用 | 只在用到 `this` / 实例成员时捕获 | 非静态上下文中总是持有 `this$0`（JDK 18 起未使用时可省略） |
| 实例 | 不捕获变量的 Lambda 通常复用同一实例（实现行为，规范不保证）；捕获变量的每次求值都新建 | 每次 `new` 都新建 |
| 适用 | 函数式接口（只有一个抽象方法） | 任意接口或类，可有状态、多个方法 |

- 引用了 `this` 或实例成员的 Lambda 体编译为**实例**私有方法，否则为**静态**私有方法
- **effectively final 的原因**：捕获的是局部变量的**值的拷贝**（作为参数传给生成类的字段），原变量之后再改，Lambda 内看不到；为避免这种语义歧义和跨线程的数据竞争，语言直接禁止。需要累加时用 `AtomicInteger`、数组单元或改写成 `reduce` / `collect`
- **受检异常**：`Function`、`Consumer` 等接口的抽象方法没有声明 `throws`，Lambda 内抛受检异常无法编译。做法是在 Lambda 内捕获后包装成 `UncheckedIOException` 等非受检异常，或自定义声明了 `throws` 的函数式接口
- 为什么选 `invokedynamic` 而不是编译成内部类，见 [开发总结 - JVM](/interview/3_jvm) Q18

→ 详见 [Lambda、Stream 与注解](/java/1_advanced#_2、底层实现-invokedynamic-lambdametafactory)、[内部类](/java/13_topic_inner_class#七、lambda-与匿名类的区别)

### Q4：Stream 的惰性求值是什么？有状态 / 无状态 / 短路操作有哪些？`Collectors.toMap` 有哪些坑？`Stream.toList()` 与 `Collectors.toList()` 有什么区别？

**核心结论**：中间操作只是在搭流水线，**终结操作**调用时才开始执行，并且元素是**逐个纵向**穿过整条流水线的（不是每一步处理完整个集合再进下一步）。流和数据源的 `Spliterator` 绑定，消费过一次就失效，再用抛 `IllegalStateException`。

| 分类 | 操作 | 特点 |
|------|------|------|
| 无状态中间操作 | `filter`、`map`、`flatMap`、`peek`、`mapMulti` | 处理单个元素不依赖其他元素 |
| 有状态中间操作 | `sorted`、`distinct`、`limit`、`skip` | 需要看到前面的元素，`sorted` 要缓冲全部数据 |
| 短路操作 | `limit`、`takeWhile`、`findFirst`、`findAny`、`anyMatch`、`allMatch`、`noneMatch` | 不必处理完全部元素，可用于无限流 |

`toMap` 的两个坑：

- **重复 key** 抛 `IllegalStateException`，要传第三个参数（合并函数）决定保留哪个值
- **value 为 null** 抛 NPE（内部用 `HashMap.merge`），需要允许 null 时改用 `collect(HashMap::new, (m, e) -> m.put(...), Map::putAll)`

| 收集方式 | 返回 | null 元素 |
|---------|------|-----------|
| `Stream.toList()`（JDK 16） | **不可变** List | 允许 |
| `Collectors.toList()` | 规范不保证可变性（当前实现是 `ArrayList`） | 允许 |
| `Collectors.toUnmodifiableList()`（JDK 10） | 不可变 List | 不允许，抛 NPE |

把 `collect(Collectors.toList())` 批量替换成 `toList()` 前，要确认后续代码没有对结果 `add` / `sort`。

→ 详见 [Lambda、Stream 与注解](/java/1_advanced#_1、流水线与惰性求值)

### Q5：并行流用的是哪个线程池？默认并行度是多少？为什么不能在并行流里做阻塞 IO？

**核心结论**：并行流把任务交给 JVM 全局共享的 `ForkJoinPool.commonPool()`，默认并行度是 **CPU 核数 − 1**（至少 1），发起终结操作的调用线程也会参与计算，所以实际约有核数个线程在跑。在里面做阻塞 IO 会占满这几个线程，所有依赖 `commonPool` 的代码（包括不传执行器的 `CompletableFuture.xxxAsync`）一起变慢。

- 并行度可用 `-Djava.util.concurrent.ForkJoinPool.common.parallelism=N` 调整，但它是**全局**设置；容器中核数取自 cgroup 限额，限额 1～2 核时并行度只有 1
- 适合：数据量大、数据源能均匀拆分（`ArrayList`、数组、`IntStream.range`）、每个元素是纯 CPU 计算且无共享可变状态；`LinkedList`、`Stream.iterate`、`lines()` 拆分效果差
- 在 `forEach` 里写共享的 `ArrayList` / `HashMap` 会丢数据，结果必须用 `collect` 合并
- 有上限地并发执行一批 IO：JDK 24+ 用 `Gatherers.mapConcurrent(n, fn)`（基于虚拟线程），或虚拟线程执行器 + `Semaphore`
- 是否真的变快要用 JMH 验证，数据量小时并行流通常更慢

→ 详见 [Lambda、Stream 与注解](/java/1_advanced#_6、并行流)

### Q6：Optional 的正确用法？`orElse` 和 `orElseGet` 有什么区别？

**核心结论**：`Optional` 设计用途只有一个——作为**可能没有结果的方法返回值**，强迫调用方处理「没有」的情况。不要用作字段、方法参数或集合元素（它也不可序列化）。

| 方法 | 行为 |
|------|------|
| `orElse(value)` | 参数**总是先求值**，即使 Optional 有值 |
| `orElseGet(supplier)` | 只有为空时才调用 supplier |
| `orElseThrow()`（JDK 10） | 为空抛 `NoSuchElementException`，语义比 `get()` 清楚 |
| `or` / `ifPresentOrElse` / `stream`（JDK 9）、`isEmpty`（JDK 11） | 链式回退、分支处理、转成流 |

```java
// 错误：createDefault() 每次都会执行，可能是一次数据库写入
User u1 = findUser(id).orElse(createDefault());
// 正确：只有找不到时才创建
User u2 = findUser(id).orElseGet(this::createDefault);
```

- 用 `ofNullable` 包装可能为 null 的值，`Optional.of(null)` 直接抛 NPE
- 不要写 `if (opt.isPresent()) { opt.get() }`，用 `map` / `orElse*` / `ifPresent`
- 返回集合的方法返回空集合，不要返回 `Optional<List<T>>`

→ 详见 [Lambda、Stream 与注解](/java/1_advanced#四、optional)

### Q7：`@Retention` 三种策略有什么区别？注解处理器的原理是什么？Lombok 为什么特殊，JDK 23 之后为什么可能失效？与 MapStruct 同用要注意什么？

**核心结论**：注解本身只是元数据，必须有人读取才有作用：`SOURCE` 级注解由编译期的注解处理器读取，`RUNTIME` 级注解由运行时反射读取。标准注解处理器（JSR 269）**只能生成新文件**，Lombok 通过 javac 内部 API **直接改写语法树**，所以它是特例，每个新 JDK 都要对应的 Lombok 版本。

| `@Retention` | 保留到 | 读取方式 | 例子 |
|-------------|-------|---------|------|
| `SOURCE` | 源码，编译后丢弃 | 注解处理器 | `@Override`、Lombok 的 `@Getter` |
| `CLASS`（默认） | class 文件，但运行时不可见 | 字节码工具 | 部分字节码增强工具的标记 |
| `RUNTIME` | 运行时 | 反射 | Spring 的 `@Component`、`@Transactional` |

- `@Inherited` 只对**类上的**注解生效，且只从父类继承；接口上的注解、方法上的注解都不继承。Spring 能识别组合注解和接口上的注解，是因为它自己用 `MergedAnnotations` 做了查找
- **JDK 23 起**，javac 默认不再自动运行类路径上发现的注解处理器。Lombok、MapStruct 只放在依赖里而没有声明处理器路径时，编译不报处理器错误，而是报「找不到 getter」。Maven 要在 `maven-compiler-plugin` 的 `annotationProcessorPaths` 里显式声明（Gradle 的 `annotationProcessor` 配置本来就是独立路径）
- Lombok 与 JDK 对应：JDK 21 至少 1.18.30，JDK 25 至少 1.18.40；升级 JDK 前先升 Lombok
- **与 MapStruct 同用**：处理器路径里同时声明 `lombok`、`mapstruct-processor` 和 `lombok-mapstruct-binding`，每项都写版本；否则 MapStruct 可能在 Lombok 生成 getter 之前运行，生成空映射。建议开启 `unmappedTargetPolicy = ReportingPolicy.ERROR`
- **MapStruct vs `BeanUtils.copyProperties`**：前者编译期生成普通 getter / setter 调用，类型不匹配直接编译失败、性能等同手写；后者运行时反射，类型不匹配的字段被静默跳过，只做浅拷贝

→ 详见 [Lambda、Stream 与注解](/java/1_advanced#_4、注解处理器)、[效率工具库](/java/98_dev_tool#_2、原理与-jdk-兼容性)

### Q8：Java 8 → 11 → 17 → 21 升级分别会遇到哪些兼容问题？

**核心结论**：8 → 11 的坑是 **Java EE 模块被移除**；11 → 17 的坑是 **JDK 内部 API 强封装**，这是最大的迁移成本；17 → 21 主要是**默认行为变化**（字符集、反射实现、Agent 警告）。通用做法是先升依赖再升 JDK。

| 升级 | 主要问题 | 处理 |
|------|---------|------|
| 8 → 11 | JAXB、JAX-WS、`javax.annotation` 等 Java EE / CORBA 模块移除（JEP 320）；系统类加载器不再是 `URLClassLoader`；`sun.misc.BASE64Encoder` 等内部类消失 | 单独引入依赖；用 `java.util.Base64`；不要强转类加载器 |
| 11 → 17 | JDK 16 默认拒绝非法反射（JEP 396），17 移除 `--illegal-access`（JEP 403），旧版 Lombok、cglib、Spring 4 等深度反射时报 `InaccessibleObjectException`；CMS、Nashorn 已移除 | 升级库；确实需要时 `--add-opens 模块/包=ALL-UNNAMED`；GC 换 G1 / ZGC |
| 17 → 21 | 默认字符集改为 UTF-8（JDK 18，JEP 400），Windows 上不指定编码的读写行为变化；反射改为基于方法句柄（JEP 416）；`finalize` 弃用（JEP 421）；动态 attach 的 Agent 打印警告（JEP 451） | IO 显式指定编码；APM / Mock Agent 改为 `-javaagent` 启动加载 |
| 21 → 25 | JDK 23 起须显式声明注解处理器路径；24 起 `Unsafe` 内存访问方法告警、Security Manager 永久禁用；偏向锁等老参数已失效 | 构建配置补处理器路径；清理 JVM 参数 |

- Spring Boot 3 要求 JDK 17，同时完成 `javax.*` → `jakarta.*` 的包名迁移，这往往和 11 → 17 一起做
- 升级检查：`jdeps --jdk-internals` 扫描内部 API 依赖；清理已移除的 JVM 参数；对比升级前后的 GC 日志与延迟
- 依赖字节码的库（Lombok、ByteBuddy、ASM、Mockito、Jacoco）要支持目标 class 文件版本

→ 详见 [版本演进](/java/2_version#九、移除与废弃速查)

### Q9：JDK 21 和 JDK 25 各有哪些重要新特性？哪些仍是预览？record、sealed 与 switch 模式匹配配合解决什么问题？

**核心结论**：JDK 21 的标志是**虚拟线程**和**模式匹配**（record 模式 + switch 模式匹配）正式发布；JDK 25 把 `ScopedValue`、灵活构造器体、模块导入、紧凑源文件转正，紧凑对象头成为产品特性。**结构化并发、原始类型模式匹配在 25 仍是预览**，不进生产。

| 版本 | 正式特性（节选） | 仍为预览 / 孵化 |
|------|----------------|---------------|
| 21 | 虚拟线程（444）、record 模式（440）、switch 模式匹配（441）、Sequenced Collections（431）、分代 ZGC（439） | 结构化并发、Scoped Values、String Templates（23 撤回） |
| 22 ~ 24 | FFM API、未命名变量 `_`、Stream Gatherers（24）、Class-File API（24）、AOT 缓存（24，JEP 483）、`synchronized` 不再钉住虚拟线程（24，JEP 491） | — |
| 25 | Scoped Values（506）、灵活构造器体（513）、模块导入（511）、紧凑源文件与实例 main（512）、紧凑对象头（519） | 结构化并发（505，第五次预览）、原始类型模式（507）、Stable Values（502）、Vector API（孵化） |

**record + sealed + 模式匹配**合起来是 Java 版的代数数据类型：`sealed` 声明「只有这几种子类型」，`record` 负责不可变数据载体，`switch` 用 record 模式直接解构，并由编译器做**穷尽检查**。

```java
sealed interface Shape permits Circle, Rect {}
record Circle(double r) implements Shape {}
record Rect(double w, double h) implements Shape {}

static double area(Shape shape) {
    return switch (shape) {
        case Circle(double r) -> Math.PI * r * r;
        case Rect(double w, double h) -> w * h;
    };   // 不需要 default；新增 Shape 子类型时这里编译失败
}
```

- 替代 `instanceof` + 强转链和访问者模式；新增子类型时所有未处理的 `switch` 编译报错，而不是运行时走进 `default`
- JDK 26 / 27 已发布但非 LTS，生产基线选 21 或 25，重度使用虚拟线程选 25

→ 详见 [版本演进](/java/2_version#四、java-21-lts)

### Q10：单例模式有几种写法？DCL 为什么要加 volatile？推荐哪种？

**核心结论**：常见写法有饿汉、懒汉（同步方法）、双重检查锁（DCL）、**静态内部类（Holder）**和**枚举**。推荐 Holder（需要懒加载时）和枚举（需要抵御反射与序列化破坏时）；DCL 能用但必须加 `volatile`，并不是首选。实际项目里单例通常交给 Spring 容器管理。

| 写法 | 懒加载 | 线程安全靠什么 | 反射 / 序列化 |
|------|-------|--------------|--------------|
| 饿汉 | 否 | 类初始化 | 可被破坏 |
| 同步方法懒汉 | 是 | 每次调用都加锁，性能差 | 可被破坏 |
| DCL | 是 | `volatile` + 锁 | 可被破坏 |
| **Holder** | 是（首次访问内部类时初始化） | 类初始化锁（JLS §12.4.2），无需 volatile | 可被破坏 |
| **枚举** | 否 | 类初始化 | **天然防御**：反射创建枚举实例抛异常，序列化只写名字 |

```java
public final class Config {
    private Config() {}
    private static final class Holder {
        static final Config INSTANCE = new Config();   // 首次调用 getInstance 时才初始化
    }
    public static Config getInstance() {
        return Holder.INSTANCE;
    }
}
```

**DCL 为什么要 volatile**：`instance = new Singleton()` 包含分配内存、执行构造器、发布引用三步，没有 happens-before 约束时，其他线程可能先看到非 null 的引用、却读到构造器尚未写完的字段（半初始化对象）。`volatile` 写建立 happens-before，保证读到引用的线程也能看到构造器中的全部写入。

→ 详见 [单例模式](/patterns/1_creational_singleton#四、静态内部类-holder-推荐)、[JMM 内存模型](/java/22_topic_jmm#七、双重检查锁-dcl)

### Q11：`Arrays.sort()` 底层用的什么算法？对基本类型和对象有何不同？

**核心结论**：基本类型数组用**双轴快速排序**（Dual-Pivot Quicksort），不稳定但基本类型不需要稳定性；对象数组用 **TimSort**，是稳定的归并 + 插入排序混合算法。`Collections.sort` → `List.sort` → `Arrays.sort`，最终也是 TimSort。

| 输入 | 算法 | 要点 |
|------|------|------|
| `int[]`、`long[]`、`double[]` 等 | `DualPivotQuicksort`（JDK 7 起） | 小区间改用插入排序；JDK 14 重写后递归过深时退化为堆排序，保证 O(n log n)；`byte[]` / `char[]` / `short[]` 大数组用计数排序 |
| `Object[]`、`T[]` + `Comparator` | TimSort（JDK 7 起） | **稳定**；先找出已有序的 run 再归并，部分有序数据接近 O(n)；短区间用二分插入排序 |
| `List.sort` / `Collections.sort` | 转数组后 TimSort | `ArrayList` 直接排内部数组 |
| `Arrays.parallelSort`（JDK 8） | 大数组在 `commonPool` 中并行归并 | 小数组退回串行排序 |

- 稳定性对对象有意义：先按时间排、再按状态排，同状态的元素仍保持时间顺序
- `Comparator` 违反约定（不满足传递性、用减法比较导致溢出）时，TimSort 可能抛 `IllegalArgumentException: Comparison method violates its general contract!`；比较器用 `Integer.compare` 或 `Comparator.comparing`

→ 详见 [排序算法](/algorithms/2_algorithms/1_sort#四、排序选型建议)

## 二、语言机制

### Q12：Error 和 Exception 的区别？受检与非受检异常如何判定？为什么业务异常通常继承 RuntimeException？异常的开销在哪？

**核心结论**：`Error` 表示 JVM 或环境层面的严重问题（OOM、StackOverflowError），不应捕获后继续运行；`Exception` 是程序可以处理的异常。**受检与非受检按类型判定**：`RuntimeException`、`Error` 及其子类是非受检异常，其余 `Throwable` 子类都是受检异常，必须 `catch` 或在方法上声明 `throws`。

| 类型 | 例子 | 编译器要求 |
|------|------|-----------|
| `Error` | `OutOfMemoryError`、`StackOverflowError`（都在 `VirtualMachineError` 下） | 不检查 |
| 非受检异常（`RuntimeException` 子类） | `NullPointerException`、`IllegalArgumentException` | 不检查 |
| 受检异常 | `IOException`、`SQLException`、`InterruptedException` | 必须处理或声明 |

**业务异常继承 `RuntimeException` 的原因**：

- 业务异常通常在上层统一处理（全局异常处理器转成错误码），受检异常会迫使中间每一层都声明 `throws` 或无意义地 catch
- Lambda 与 Stream 中无法直接抛受检异常
- Spring `@Transactional` **默认只对 `RuntimeException` 和 `Error` 回滚**，受检异常默认提交，要 `rollbackFor` 才回滚

**开销**：主要在构造时 `fillInStackTrace` 采集堆栈，而不是 `throw` 本身。高频且不需要堆栈的业务异常可用四参构造器关闭 `writableStackTrace`。HotSpot 的 `-XX:+OmitStackTraceInFastThrow`（默认开启）会让同一位置频繁抛出的 NPE 等内置异常变成无堆栈的预分配实例，线上日志只剩异常名时要往前翻最早的那条日志。

- 处理原则：要么处理并记录，要么包装（带上 cause）后抛出，不要既打日志又抛出导致重复记录

→ 详见 [异常体系](/java/10_topic_exception#一、异常层次结构)

### Q13：finally 一定会执行吗？finally 里 return 会怎样？try-with-resources 中 `close()` 抛出的异常去哪了？

**核心结论**：正常返回、抛出异常、`break` / `continue` 时 finally 都会执行；但 JVM 停止时不会：`System.exit()` / `Runtime.halt()`、进程被 `kill -9`、JVM 崩溃，以及 JVM 退出时仍在运行的守护线程。无限循环或死锁则是永远走不到 finally。

- **finally 里 `return`**：会覆盖 try 中的返回值，还会**吞掉** try 中抛出的异常；finally 里抛异常同样会覆盖原异常。finally 只做清理，不 return、不抛异常
- try 中 `return x` 时，返回值在执行 finally 之前已经保存；finally 修改基本类型局部变量不影响返回值，修改引用对象的内容则会体现出来
- **try-with-resources**：资源按声明的**相反顺序**关闭；如果 try 块已经抛出异常，`close()` 的异常通过 `addSuppressed` 附加在主异常上，用 `getSuppressed()` 取出，不会覆盖主异常
- JDK 9 起可以直接写 `try (conn)` 管理已有的 effectively final 变量

```java
try (var in = Files.newInputStream(src); var out = Files.newOutputStream(dst)) {
    in.transferTo(out);
}   // 先关 out，再关 in
```

→ 详见 [异常体系](/java/10_topic_exception#三、finally-与-try-with-resources)

### Q14：String 为什么不可变？JDK 9 之后底层结构和 `+` 拼接有什么变化？循环里为什么还要用 StringBuilder？

**核心结论**：不可变由三点共同保证：类是 `final`（不能被继承篡改行为）、内部数组 `private final` 且不对外暴露、所有「修改」方法都返回新对象。光是数组引用 `final` 并不能阻止修改数组内容，关键是没有任何途径拿到这个数组。

不可变带来的好处：

- **常量池共享**：相同字面量可以安全地共享同一个对象
- **缓存 hash**：`hashCode` 计算一次后缓存，适合做 `HashMap` key
- **安全**：类名、文件路径、URL 作为参数传入后不会被调用方改掉
- **线程安全**：无需同步即可在线程间共享

| 变化 | JDK 8 | JDK 9+ |
|------|-------|--------|
| 存储 | `char[]`，每字符 2 字节 | **Compact Strings**（JEP 254）：`byte[]` + `coder`，纯 Latin-1 内容每字符 1 字节，否则 UTF-16 |
| `+` 拼接 | 编译为 `StringBuilder.append` 链 | 编译为 `invokedynamic`，由 `StringConcatFactory` 在运行时生成拼接策略（JEP 280） |

**循环里仍要用 `StringBuilder`**：`invokedynamic` 优化的是**单个表达式**内的拼接；循环中 `s += x` 每次迭代都会创建新的 String 并复制已有内容，总体 O(n²)。循环外创建一个 `StringBuilder` 反复 `append` 才是线性的。`StringBuffer` 每个方法都加锁，属于遗留类。

→ 详见 [String](/java/11_topic_string#一、不可变性与内存布局)

### Q15：`new String("abc")` 创建了几个对象？什么情况下 `==` 比较字符串为 true？`intern()` 有什么风险？

**核心结论**：最多两个——字面量 `"abc"` 在该常量首次被解析时进入字符串常量池（已存在则复用），`new` 再在堆上创建一个新的 `String` 对象，两者内容相同但不是同一个对象。新对象直接引用池中对象的内部数组，只多出一个对象头和几个字段。

`==` 为 true 的三种情况：

| 情况 | 例子 |
|------|------|
| 同一个字面量 | `"ab" == "ab"` |
| 编译期常量折叠 | `"a" + "b" == "ab"`；`final String x = "a"; x + "b" == "ab"` |
| `intern()` 返回池中对象 | `new String("ab").intern() == "ab"` |

非 final 变量或方法返回值参与的拼接在运行时执行，结果是新对象，`==` 为 false。业务代码比较内容一律用 `equals`。

**`intern()` 的风险**：字符串常量池是 JVM 内部的哈希表（JDK 7 起在堆中），对取值不受控的字符串（用户输入、订单号）调用 `intern` 会让表持续膨胀、查找变慢，增加 GC 扫描负担。需要规范化时优先用业务常量、`Map` 或 Guava `Interner`；只为省内存可开启字符串去重 `-XX:+UseStringDeduplication`。

→ 详见 [String](/java/11_topic_string#二、常量池与)、[开发总结 - JVM](/interview/3_jvm)

### Q16：枚举的本质是什么？一定是 final 吗？为什么枚举单例能防反射和序列化破坏？`ordinal()` 能持久化吗？

**核心结论**：枚举编译后是继承 `java.lang.Enum` 的类，每个常量是 `public static final` 字段，在类初始化（`<clinit>`）时创建，由类初始化锁保证线程安全。**没有常量类体时枚举隐式 final；有常量带类体时不是 final**（JDK 17 起隐式 sealed），但无论哪种，用户代码都不能继承枚举。

- `values()` 每次调用都**克隆**数组，热点代码里缓存结果；`valueOf` 找不到名字时抛 `IllegalArgumentException`
- **防反射**：`Constructor.newInstance` 遇到枚举类型直接抛 `IllegalArgumentException`，无法造出第二个实例
- **防序列化**：序列化只写入 `name()`，反序列化通过 `valueOf` 取回已有常量；枚举中自定义的 `readObject` / `readResolve` 都会被忽略
- 普通类单例要靠 `readResolve` 防序列化破坏，且挡不住反射调用私有构造器

**`ordinal()` 不能持久化**：它是声明顺序，在中间插入或调整常量后，库里已存的数字全部错位。持久化与接口传输用显式的业务 `code` 字段或 `name()`。注意 **JPA 的 `@Enumerated` 默认是 `ORDINAL`**，要显式写 `EnumType.STRING` 或用转换器。

- `EnumSet` 是位向量（常量不超过 64 个时用一个 `long`），`EnumMap` 是以 `ordinal()` 为下标的数组，两者都比 `HashSet` / `HashMap` 快且紧凑

→ 详见 [枚举](/java/12_topic_enum#一、枚举的本质)

### Q17：静态嵌套类和内部类的区别？内部类 / 匿名类为什么会导致内存泄漏？

**核心结论**：按 JLS，嵌套类分为**静态嵌套类**和**内部类**（成员内部类、局部类、匿名类），静态嵌套类不属于内部类。区别在于是否绑定外部实例：内部类实例隐式持有外部实例的引用 `this$0`，静态嵌套类没有。不需要访问外部实例时，一律声明为 `static`。

| 维度 | 静态嵌套类 | 内部类 |
|------|-----------|-------|
| 创建 | `new Outer.Nested()` | `outer.new Inner()` |
| 外部实例引用 | 无 | 有 `this$0` |
| 访问外部成员 | 静态成员；拿到 `Outer` 引用后也能访问其 private 成员 | 直接访问外部实例的全部成员 |
| 静态成员 | 可以 | JDK 16 起也可以声明 |

**内存泄漏**的根源是「生命周期长的对象引用了内部类实例，而内部类实例又通过 `this$0` 或捕获的变量拖住了大对象」：

- 匿名监听器 / 回调注册到全局注册表或单例上，却从不注销，整个外部对象无法回收
- 双括号初始化 `new HashMap<>() {{ put(...); }}` 生成匿名子类并持有外部实例，返回出去后外部对象一起被引用
- 异步任务、定时任务捕获了整个请求对象或大集合，任务排队或周期执行期间一直存活
- 内部类实例放进缓存，外部实例随之常驻

解决：注册与注销成对出现、只捕获需要的字段、优先用静态嵌套类或 Lambda（Lambda 只在用到 `this` 时才捕获外部实例）。弱引用不是通用解法，会让回调在不确定的时间消失。

→ 详见 [内部类](/java/13_topic_inner_class#一、嵌套类的分类)

### Q18：泛型的类型擦除是什么？擦除后为什么还能在运行时拿到 `List<User>` 的泛型类型？什么是桥方法？

**核心结论**：泛型只在编译期做类型检查，编译后类型参数被擦除为它的**最左边界**（无界时为 `Object`），并在取值处插入强制转换。擦除的是**对象实例和局部变量**上的类型实参；类、字段、方法**声明处**的泛型签名保存在 class 文件的 `Signature` 属性中，反射可以读到。

```java
// 运行时：new ArrayList<User>() 和 new ArrayList<Order>() 是同一个 Class
List<User> users = new ArrayList<>();

// 但字段声明上的泛型可以读到
Field f = Holder.class.getDeclaredField("users");
ParameterizedType t = (ParameterizedType) f.getGenericType();   // List<User>
```

- **TypeToken 原理**：创建一个匿名子类 `new TypeReference<List<User>>() {}`，把类型实参固化到子类的父类签名里，再用 `getGenericSuperclass()` 读出；Jackson 的 `TypeReference`、Spring 的 `ParameterizedTypeReference` 都是这个做法
- 擦除带来的限制：不能 `new T()`、不能 `T.class`、不能创建泛型数组、不能用基本类型作类型实参、擦除后签名相同的方法不能重载。需要类型时传 `Class<T>` 或 `Supplier<T>`
- **桥方法**：子类覆写泛型父类的方法（如 `compareTo(User)` 覆写擦除后的 `compareTo(Object)`）时，编译器额外生成一个 `compareTo(Object)` 的合成方法转调真正的实现，以维持多态。反射遍历方法时会看到它，`Method.isBridge()` 可以识别；Spring 查找方法上的注解时用 `BridgeMethodResolver` 定位原方法

→ 详见 [泛型](/java/14_topic_generics#二、类型擦除)

### Q19：`List<? extends Number>` 为什么不能 add？PECS 是什么？为什么不能创建泛型数组？

**核心结论**：`List<? extends Number>` 可能实际是 `List<Integer>`，也可能是 `List<Double>`，编译器无法确定往里放什么是安全的，所以只允许读（读出来是 `Number`），不允许写（null 除外）。这是编译期**通配符捕获**的结果，与擦除无关。

**PECS**（Producer Extends, Consumer Super）：

| 角色 | 写法 | 能做什么 |
|------|------|---------|
| 生产者（从中读） | `<? extends T>` | 读出 `T`，不能写 |
| 消费者（往里写） | `<? super T>` | 写入 `T`，读出只能当 `Object` |
| 既读又写 | `<T>` | 都可以 |

```java
// JDK 的 Collections.copy 就是 PECS 的标准写法
public static <T> void copy(List<? super T> dest, List<? extends T> src)
```

**不能创建泛型数组**：数组在运行时记得元素类型并做存储检查（`ArrayStoreException`），而泛型被擦除后运行时无法检查；如果允许 `new List<String>[10]`，就能把 `List<Integer>` 放进去且不报错，取出时才 `ClassCastException`，这就是**堆污染**。泛型可变参数 `T...` 本质也是泛型数组，所以有警告；`@SafeVarargs` 只应标在不存储、不暴露这个数组的方法上。需要集合时用 `List<List<String>>` 代替数组。

→ 详见 [泛型](/java/14_topic_generics#四、pecs-原则)

### Q20：反射有哪些典型应用？`getMethods()` 与 `getDeclaredMethods()`、`Class.forName` 与 `ClassLoader.loadClass` 有什么区别？

**核心结论**：反射是在运行时通过 `Class` 对象读取类的结构（字段、方法、构造器、注解、泛型签名）并调用它们的能力，是框架「按配置或注解驱动代码」的基础：Spring 的依赖注入与注解解析、MyBatis 的结果映射、Jackson 的序列化、JUnit 发现测试方法、动态代理的方法分派。

| 对比 | 返回范围 |
|------|---------|
| `getMethods()` / `getFields()` | 本类及所有父类、父接口的 **public** 成员（含接口的默认方法） |
| `getDeclaredMethods()` / `getDeclaredFields()` | **只有本类声明**的全部成员（含 private），不含继承来的 |

读取父类的私有字段要沿 `getSuperclass()` 逐级调用 `getDeclaredFields()`。

| 对比 | `Class.forName(name)` | `ClassLoader.loadClass(name)` |
|------|----------------------|------------------------------|
| 是否初始化 | **默认初始化**（执行静态代码块） | 只加载，不初始化 |
| 使用的加载器 | 调用者的类加载器（可用三参版本指定） | 指定的加载器 |
| 典型场景 | 老式 JDBC 驱动注册依赖静态块 | 框架按需加载、延迟初始化 |

- 反射调用的业务异常被包在 `InvocationTargetException` 里，必须 `getCause()` 解包再处理
- 类加载的各阶段与双亲委派见 [开发总结 - JVM](/interview/3_jvm) Q10–Q15

→ 详见 [反射](/java/15_topic_reflection#二、成员查找语义)

### Q21：反射为什么慢？JDK 18 之后实现有什么变化？JDK 17 之后反射访问 JDK 内部类报 `InaccessibleObjectException` 怎么处理？

**核心结论**：反射的开销来自方法查找、访问检查、参数装箱与可变参数数组、以及 JIT 难以内联。**JDK 18（JEP 416）起** `Method.invoke`、`Field.get/set` 改为基于方法句柄实现：`Method` / `Field` 对象是常量时（如存在 `static final` 字段里）比旧实现快 43%～57%，非常量的字段访问反而慢 51%～77%。所以「反射慢 10～100 倍」这类说法没有意义，要用 JMH 实测。

- 首要优化是**缓存** `Method` / `Field` 对象，而不是每次 `getMethod`；`setAccessible(true)` 只需调用一次
- `MethodHandle` 只有放在 `static final` 字段并用 `invokeExact` 调用时才接近直接调用；高频场景可以在编译期生成代码（MapStruct、注解处理器）彻底避开反射

**`InaccessibleObjectException`** 是模块系统的强封装：JDK 16（JEP 396）默认拒绝对 JDK 内部包的深度反射，JDK 17（JEP 403）移除了 `--illegal-access` 开关。

| 处理方式 | 说明 |
|---------|------|
| 升级依赖库 | 首选，主流库已改用公开 API |
| `--add-opens java.base/java.lang=ALL-UNNAMED` | 按「模块/包=目标模块」精确开放，写进启动参数，或可执行 jar 清单的 `Add-Opens` 项 |
| `--add-exports` | 只需编译期 / 运行期访问 public 类型时使用 |

JDK 26（JEP 500）起，反射修改 `final` 字段会打印警告，后续版本将默认禁止。

→ 详见 [反射](/java/15_topic_reflection#五、实现与性能)

### Q22：JDK 动态代理和 CGLIB 的区别？Spring / Spring Boot 默认用哪种？CGLIB 的 `invoke` 与 `invokeSuper` 有什么区别？

**核心结论**：JDK 动态代理在运行时生成「继承 `Proxy`、实现目标接口」的类，**只能代理接口**；CGLIB 生成目标类的**子类**，可以代理没有接口的类，但无法拦截 `final` 类和 `final` / `private` / `static` 方法。两者都是运行时生成字节码，性能在现代 JDK 上差别不大，不应作为选型依据。

| 维度 | JDK 动态代理 | CGLIB |
|------|-------------|-------|
| 原理 | 实现接口，方法转发给 `InvocationHandler` | 生成子类，方法转发给 `MethodInterceptor` |
| 要求 | 目标必须有接口，只能按接口类型使用 | 类不能是 `final`，需要可访问的构造器 |
| 不能拦截 | 接口之外的方法 | `final`、`private`、`static` 方法 |
| 依赖 | JDK 内置 | 原版 cglib 已停止维护，Spring 内置 repackage 的分支；新项目可用 ByteBuddy |

**Spring 默认**：Spring Framework 在目标有接口时用 JDK 代理、否则用 CGLIB；**Spring Boot 2.0 起** `spring.aop.proxy-target-class=true`，默认统一用 CGLIB。

**CGLIB 的三种调用**：

- `methodProxy.invokeSuper(proxy, args)`：在代理对象自身上执行父类实现，**自调用也会被拦截**
- `methodProxy.invoke(target, args)`：转发到独立的目标对象，自调用不被拦截（Spring AOP 就是这样，所以有自调用失效问题）
- `methodProxy.invoke(proxy, args)`：再次进入代理，**无限递归**直到栈溢出

- JDK 代理的 handler 里用 `method.invoke` 时要捕获 `InvocationTargetException` 并抛出 `getCause()`；handler 抛出接口未声明的受检异常时，调用方收到 `UndeclaredThrowableException`
- Spring AOP 的自调用失效与解决方式见 [开发总结 - Spring 与 Spring Boot](/interview/5_spring) 的 `@Transactional` 自调用一题

→ 详见 [动态代理](/java/16_topic_proxy#二、cglib-动态代理)

## 三、IO 与数据

### Q23：`SimpleDateFormat` 为什么线程不安全？`LocalDateTime`、`OffsetDateTime`、`ZonedDateTime`、`Instant` 有什么区别？

**核心结论**：`SimpleDateFormat` 把解析中间状态存在共享的成员变量 `Calendar` 里，多线程同时 `parse` / `format` 会互相覆盖，得到错误日期或抛异常。替代是 `java.time` 的 `DateTimeFormatter`：不可变、线程安全，可以声明为 `static final` 常量共享。

| 类型 | 含义 | 能否确定时间线上的时刻 |
|------|------|---------------------|
| `Instant` | 从 1970-01-01T00:00Z 起的秒 + 纳秒 | 能，机器时间 |
| `LocalDate` / `LocalDateTime` | 墙上的日期 / 日期时间，不带时区 | **不能**，同一个值在不同时区是不同时刻 |
| `OffsetDateTime` | `LocalDateTime` + 固定偏移（如 `+08:00`） | 能，但不知道夏令时规则 |
| `ZonedDateTime` | `LocalDateTime` + IANA 时区（如 `Asia/Shanghai`） | 能，并按时区规则处理夏令时 |

- 时区一律用 IANA ID，不用缩写：`ZoneId.SHORT_IDS` 里 `CST` 映射到美国中部时间，`EST` / `MST` / `HST` 是固定偏移
- `java.time` 全部不可变，`plusDays` 返回新对象，忘记接收返回值是常见错误
- 格式模式里 `YYYY` 是周所在年，跨年那几天会出错，年份用 `yyyy` 或 `uuuu`
- 注入 `Clock` 代替直接 `now()`，测试可控

→ 详见 [日期与时间](/java/17_topic_time#二、java-time-类型模型)

### Q24：数据库里时间该怎么存？MySQL `DATETIME` 与 `TIMESTAMP` 有什么区别？夏令时会带来什么问题？

**核心结论**：**已经发生的事件存 UTC 时刻**（`Instant` / `OffsetDateTime`），展示时再按用户时区转换；**未来的本地事件**（如「每天 9 点开会」）存 `LocalDateTime` + IANA 时区，因为时区规则可能在事件发生前调整；纯日期（生日、账期）存 `LocalDate`。

| 对比 | MySQL `DATETIME` | MySQL `TIMESTAMP` |
|------|-----------------|-------------------|
| 存什么 | 字面的日期时间，不做时区转换 | 按连接时区转成 UTC 存储，读取时再转回 |
| 范围 | 1000 ~ 9999 年 | 1970 ~ **2038-01-19**（32 位秒数上限） |
| 适合 | 配合「约定一律存 UTC」使用 | 依赖连接时区配置正确 |

- JDBC 4.2 起可以直接 `setObject` / `getObject(…, LocalDateTime.class)`，不必经过 `java.sql.Timestamp`
- **CST 时差坑**：MySQL 服务器时区显示为 `CST` 时，旧版 Connector/J 可能把它当成美国中部时间，写入或读出的时间差 13 或 14 小时（夏令时不同）。解决：连接串显式配置 `connectionTimeZone` / `serverTimezone=Asia/Shanghai`，服务端也设置明确时区
- PostgreSQL 用 `timestamptz` 存时刻
- **夏令时**：时钟拨快时有一段本地时间不存在（间隙），拨慢时有一段出现两次（重叠）。`plusDays(1)` 按日历加一天，`plusHours(24)` 按物理时长加 24 小时，跨夏令时切换日两者结果不同；按日计费、定时任务要想清楚用哪种语义

→ 详见 [日期与时间](/java/17_topic_time#七、数据库映射)

### Q25：Java IO 流有哪些分类？BIO / NIO / AIO 的区别？有了虚拟线程还需要 NIO / Netty 吗？

**核心结论**：按数据单位分**字节流**（`InputStream` / `OutputStream`）和**字符流**（`Reader` / `Writer`，字符流 = 字节流 + 编解码）；按方向分输入、输出；按角色分**节点流**（直接连数据源，如 `FileInputStream`）和**处理流**（包装其他流增加功能，如 `BufferedReader`，这是装饰器模式）。日常文件读写首选 `java.nio.file.Files`。

| 模型 | Java API | 线程模型 | 现状 |
|------|----------|----------|------|
| BIO | `ServerSocket` / `Socket` | 一连接一线程，读写阻塞 | 平台线程撑不住大量连接；配合虚拟线程重新可用 |
| NIO | `SocketChannel` + `Selector` + `Buffer` | 少量线程轮询就绪事件（Linux 上是 epoll） | 高并发网络框架的基础（Netty） |
| AIO | `AsynchronousSocketChannel` | 发起操作后由回调取结果 | 只有 Windows 上是真异步（IOCP），Linux 上是模拟的，很少使用 |

**虚拟线程之后**：普通的「请求 → 调下游 HTTP / JDBC → 返回」业务，虚拟线程 + 阻塞 API 最简单，Socket 阻塞时虚拟线程卸载，不占平台线程；需要自定义二进制协议、数万长连接、精细背压或零拷贝时，仍用 NIO / Netty。文件 IO 在虚拟线程上仍会占住载体线程。

- JDK 18 起默认字符集是 UTF-8；JDK 17 及以下 `FileReader` / `getBytes()` 不指定编码时用平台编码，必须显式传 `StandardCharsets.UTF_8`
- 五种 IO 模型与 epoll 原理见 [IO 模型](/netty/1_io_model)

→ 详见 [IO 与 NIO](/java/18_topic_io#一、io-体系结构)

### Q26：零拷贝的原理？`transferTo` 与 `mmap` 各有什么限制？直接缓冲区的代价是什么？

**核心结论**：零拷贝是减少数据在内核态与用户态之间的 **CPU 拷贝**和**上下文切换**。传统 `read` + `write` 是 2 次 DMA 拷贝 + 2 次 CPU 拷贝 + 4 次切换；`sendfile`（Java 的 `FileChannel.transferTo`）降到 1 次 CPU 拷贝 + 2 次切换，网卡支持 SG-DMA 时 CPU 拷贝为 0。

| 方案 | CPU 拷贝 | 上下文切换 | Java API | 限制 |
|------|---------|-----------|----------|------|
| `read` + `write` | 2 | 4 | 流 | — |
| `mmap` + `write` | 1 | 4 | `FileChannel.map()` | 单个映射最大约 2 GB；没有公开的 unmap，要等 GC 释放 |
| `sendfile` | 1（SG-DMA 时为 0） | 2 | `FileChannel.transferTo()` | 单次调用可能传不完，要循环；数据不经用户态，**开启 TLS 后失效** |

- JDK 22 的 FFM API 可以把文件映射为 `MemorySegment`，不受 2 GB 限制，`Arena` 关闭即解除映射
- Kafka 消费发送、Netty 的 `FileRegion` 用 `sendfile`；RocketMQ 的 CommitLog 用 mmap

**直接缓冲区**（`ByteBuffer.allocateDirect`）分配在堆外，Socket 读写时省去一次「堆内数组 → 堆外临时缓冲」的拷贝。代价：分配和释放比堆内缓冲区贵得多；释放依赖 GC 触发 `Cleaner`，堆外内存可能在 GC 前就耗尽（`OutOfMemoryError: Direct buffer memory`）；受 `-XX:MaxDirectMemorySize` 限制。所以只适合大块、长期复用的场景，Netty 用池化的直接内存。

→ 详见 [IO 与 NIO](/java/18_topic_io#四、零拷贝)

### Q27：序列化的作用？`serialVersionUID` 有什么用？类新增 / 删除字段后反序列化会怎样？

**核心结论**：序列化把对象转成字节序列，用于网络传输、持久化和进程间通信。`serialVersionUID` 是类的版本号，反序列化时流中的 UID 与本地类不一致就抛 `InvalidClassException`。不显式声明时由编译器按类结构计算，加一个方法都可能变化，所以**必须显式声明**。

| 类变更（UID 不变） | 规范定性 | 实际行为 |
|------------------|---------|---------|
| 新增字段 | 兼容 | 新字段取默认值（null / 0 / false），**字段初始化器和构造器都不会执行** |
| 删除字段 | 不兼容 | 不抛异常，多余的值被忽略；旧版本读新数据时该字段为默认值，可能破坏业务约束 |
| 修改字段类型 | 不兼容 | 抛 `InvalidClassException` 或 `ClassCastException` |

- `transient` 字段和 `static` 字段都不参与序列化，反序列化后 `transient` 字段为默认值
- 反序列化**不调用本类构造器**，而是调用第一个不可序列化父类的无参构造器；`record` 例外，会调用规范构造器并执行其中的校验
- 新增的集合字段在旧数据上反序列化后是 null，需要在 `readObject` 中补默认值
- 普通单例要用 `readResolve` 返回唯一实例，枚举天然安全
- `serialver -classpath . ClassName` 可查看类当前的 UID（JDK 9 起已没有 `-show` 图形界面）

→ 详见 [序列化](/java/19_topic_serialization#一、java-原生序列化)

### Q28：反序列化漏洞的原理？如何用 `ObjectInputFilter` 防护？序列化方案怎么选？

**核心结论**：`ObjectInputStream.readObject` 会按流中指定的类名实例化对象，并调用这些类的 `readObject` 等回调。攻击者构造一串类路径上已有的类（gadget chain，如老版本 Commons Collections），让回调层层触发，最终执行任意命令。**只要反序列化不可信数据，就可能 RCE**，与业务类本身是否安全无关。

| 防护 | 说明 |
|------|------|
| 不用原生序列化处理外部输入 | 根本解法；对外接口用 JSON / Protobuf |
| `ObjectInputFilter`（JEP 290，JDK 9，并回移到 8u121） | 用 `-Djdk.serialFilter=com.example.*;!*` 设置**白名单**，同时限制深度、数组长度、引用数 |
| 过滤器工厂（JEP 415，JDK 17） | 按调用上下文为不同的反序列化点配置不同过滤器 |
| 升级依赖 | 移除或升级已知 gadget 所在的库 |

- Fastjson 1.x 的 `autoType` 漏洞是同一类问题：允许 JSON 指定任意类名；Fastjson2 默认关闭 autoType
- Jackson 不要开启全局默认类型（`activateDefaultTyping`）处理不可信输入

| 场景 | 选型 |
|------|------|
| 对外 HTTP 接口 | JSON（Jackson） |
| 跨语言 RPC | Protobuf（gRPC） |
| Java 内部高性能缓存 / 传输 | Kryo（需注册类，实例非线程安全）、Hessian2 |
| Dubbo | 2.x 默认 hessian2，3.2 默认 fastjson2，3.3 起回到 hessian2 |

→ 详见 [序列化](/java/19_topic_serialization#五、反序列化安全)

### Q29：SPI 是什么，与 API 有何区别？SPI 如何「打破」双亲委派？Dubbo SPI 和 Spring Boot 自动配置做了哪些增强？

**核心结论**：API 是「实现方定义接口并实现，调用方使用」；SPI 是「**框架定义接口，第三方提供实现，框架在运行时发现并加载**」，调用方向相反。Java 原生 SPI 是 `ServiceLoader`：读取 `META-INF/services/接口全名` 文件中的实现类名，懒加载实例化。

- **打破双亲委派**：`java.sql.DriverManager` 由启动类加载器加载，按双亲委派它看不到 classpath 上的 MySQL 驱动。`ServiceLoader.load(Driver.class)` 默认使用**线程上下文类加载器（TCCL）**，由父加载器加载的代码借它反向加载子加载器中的实现
- **JDBC 不再需要 `Class.forName`**：JDBC 4.0 起驱动 jar 都带 `META-INF/services/java.sql.Driver`，`DriverManager` 初始化时通过 SPI 自动注册
- 原生 SPI 的局限：只能遍历全部实现，不能按名字取、不能排序、不能注入依赖、不能按条件激活；任一实现类加载失败抛 `ServiceConfigurationError`

| 机制 | 配置文件 | 增强 |
|------|---------|------|
| Java SPI | `META-INF/services/接口全名`，每行一个类名 | — |
| Dubbo SPI | `META-INF/dubbo/接口全名`，`name=实现类` | 按名获取、`@Adaptive` 按 URL 参数动态选择、`@Activate` 条件激活、Wrapper 自动包装（AOP）、依赖注入 |
| Spring Boot | 2.7 引入 `META-INF/spring/…AutoConfiguration.imports`；**3.0 起自动配置只能在这里登记** | 配合 `@Conditional` 条件装配、排序；`spring.factories` 仍用于其他扩展点 |

→ 详见 [SPI 机制](/java/20_topic_spi#二、java-原生-spi-serviceloader)

### Q30：HashMap 的 put 流程？hash 为什么要 `h ^ (h >>> 16)`？容量为什么是 2 的幂？哈希冲突有哪些解决方式？

**核心结论**：HashMap 是 `Node[]` 数组 + 链表 / 红黑树，下标 `index = (n - 1) & hash`。容量保持 2 的幂，`(n - 1) & hash` 就等价于取模但只用位运算，扩容时元素也只需按一位拆分；扰动函数把 hashCode 的高 16 位混进低 16 位，因为表小时下标只用到低几位，不扰动的话高位不同、低位相同的 key 会全部冲突。

put 流程：

1. 计算扰动后的 hash；table 为空则 `resize()` 初始化（默认容量 16，负载因子 0.75，第一次 put 时才分配）
2. 目标桶为空：直接放入新节点
3. 桶首 key 相同（hash 相等且 `==` 或 `equals`）：覆盖 value
4. 桶首是 `TreeNode`：按红黑树插入
5. 否则遍历链表，找到相同 key 就覆盖，否则**尾插**；链表长度超过 8 时尝试树化
6. `++size > threshold` 时扩容

**哈希冲突的解决方式**：

| 方式 | 做法 | JDK 中的例子 |
|------|------|------------|
| 链地址法（拉链） | 同一个桶挂链表 / 树 | `HashMap`、`ConcurrentHashMap`、`Hashtable` |
| 开放地址法 | 冲突时按规则探测下一个空位（线性探测、二次探测、双重哈希） | `ThreadLocal.ThreadLocalMap`（线性探测）、`IdentityHashMap` |
| 再哈希 | 换一个哈希函数重新计算 | 布隆过滤器等用多个哈希函数 |

链地址法删除简单、负载因子可以接近 1；开放地址法数据连续、缓存友好，但负载因子必须较低，删除要打墓碑标记。同一个 key 重复 `put` 是覆盖，不是冲突。

→ 详见 [集合框架](/java/21_topic_collection#六、hashmap)

### Q31：HashMap 何时树化、何时退化？扩容时元素如何迁移？JDK 7 并发扩容为什么会死循环？

**核心结论**：链表长度超过 8 **且** table 长度 ≥ 64 时树化为红黑树；table 小于 64 时不树化而是扩容。扩容拆分后树桶的节点数 ≤ 6 时退回链表。扩容容量严格翻倍，每个元素按 `hash & oldCap` 那一位决定留在原下标 `i` 还是移到 `i + oldCap`，不需要重新计算 hash。

| 常量 | 值 | 含义 |
|------|----|------|
| `TREEIFY_THRESHOLD` | 8 | 链表长度超过 8 时尝试树化 |
| `MIN_TREEIFY_CAPACITY` | 64 | 表长小于 64 时改为扩容 |
| `UNTREEIFY_THRESHOLD` | 6 | 拆分后 ≤ 6 退回链表，8 和 6 之间留差值避免反复转换 |

- 为什么是 8：hashCode 分布良好时桶内节点数近似泊松分布，达到 8 的概率约千万分之六；真到 8 多半是 hashCode 写得差或遭遇哈希碰撞攻击，红黑树把最坏查找从 O(n) 降到 O(log n)
- 拆分时 lo / hi 两条链保持原有相对顺序
- **JDK 7 死循环**：JDK 7 迁移链表用**头插法**，会把链表顺序反转。两个线程同时扩容时，一个线程反转后的链表被另一个线程按旧顺序继续迁移，可能形成环形链表，之后 `get` 在环上无限循环、CPU 100%。JDK 8 改为尾插并保持顺序，消除了成环，但 HashMap 依然**不是线程安全的**，并发 put 会丢数据
- 已知元素数时用 `HashMap.newHashMap(n)`（JDK 19）预分配；`new HashMap<>(n)` 的参数是桶容量，放 n 个元素仍会因负载因子扩容

→ 详见 [集合框架](/java/21_topic_collection#_3、树化与退化)

### Q32：ArrayList 的扩容机制？ArrayList 与 LinkedList 怎么选？fail-fast 与弱一致迭代器有什么区别？

**核心结论**：`new ArrayList<>()` 初始指向共享的空数组，第一次 `add` 才分配容量 10；容量不够时扩为 `old + (old >> 1)`（1.5 倍）并 `Arrays.copyOf` 复制。几乎所有场景都选 `ArrayList`：连续内存对 CPU 缓存友好，`LinkedList` 每个元素一个节点对象，遍历时缓存命中率低，中间插入也要先 O(n) 定位。需要头尾操作用 `ArrayDeque`。

| 维度 | ArrayList | LinkedList |
|------|-----------|-----------|
| 随机访问 | O(1) | O(n) |
| 尾部追加 | 均摊 O(1) | O(1) |
| 中间插入 / 删除 | O(n) 移位（`System.arraycopy` 很快） | 定位 O(n) + 修改 O(1) |
| 内存 | 紧凑 | 每个元素额外一个节点对象和两个指针 |

| 迭代器 | 行为 | 集合 |
|-------|------|------|
| fail-fast | 迭代器记下 `modCount`，发现结构被修改立即抛 `ConcurrentModificationException`；**单线程在 for-each 中删除也会触发** | `ArrayList`、`HashMap` 等非并发集合 |
| 弱一致 | 不抛异常，可能看到也可能看不到迭代期间的修改 | `ConcurrentHashMap`、`ConcurrentLinkedQueue` |
| 快照 | 遍历创建迭代器时的数组副本 | `CopyOnWriteArrayList` |

- 遍历中删除用 `removeIf` 或 `Iterator.remove()`
- fail-fast 只是尽力检测，不能作为并发正确性的保证

→ 详见 [集合框架](/java/21_topic_collection#_1、arraylist-vs-linkedlist)

### Q33：`List.of`、`Arrays.asList`、`Collections.unmodifiableList` 有什么区别？JDK 21 Sequenced Collections 解决了什么问题？

**核心结论**：`List.of` 是真正不可变的集合；`Arrays.asList` 是固定长度、写穿到原数组的视图；`Collections.unmodifiableList` 是只读视图，底层集合变了它也跟着变。

| API | 版本 | 能否修改 | null | 与源的关系 |
|-----|------|---------|------|-----------|
| `List.of` / `Set.of` / `Map.of` | 9 | 任何修改抛 `UnsupportedOperationException` | **不允许**，连 `contains(null)` 都抛 NPE | 独立 |
| `List.copyOf` | 10 | 不可变 | 不允许 | 源本身不可变时直接返回 |
| `Arrays.asList` | 1.2 | 可 `set`，不可 `add` / `remove` | 允许 | 与原数组共享，互相影响 |
| `Collections.unmodifiableList` | 1.2 | 通过视图不能改 | 允许 | 底层集合的视图 |
| `Stream.toList()` | 16 | 不可变 | 允许 | 独立 |

- `Set.of` / `Map.of` 遇到重复元素直接抛 `IllegalArgumentException`，且遍历顺序每次 JVM 启动都可能不同
- `Arrays.asList(int[])` 得到的是只有一个元素（整个数组）的 List

**Sequenced Collections（JEP 431）**：以前「有确定顺序的集合」没有统一抽象，取首尾元素要写 `list.get(list.size() - 1)`、`deque.peekLast()`、`sortedSet.last()`，`LinkedHashSet` 甚至没有取最后一个元素的方法。JDK 21 新增 `SequencedCollection` / `SequencedSet` / `SequencedMap`，统一提供 `getFirst/getLast`、`addFirst/addLast`、`removeFirst/removeLast` 和返回反向视图的 `reversed()`；`LinkedHashMap` 获得 `firstEntry`、`pollFirstEntry`、`putFirst` 等方法。

→ 详见 [集合框架](/java/21_topic_collection#_2、不可变集合)

### Q34：如何用 LinkedHashMap 实现 LRU？TreeSet / TreeMap 为什么可能「丢」元素？

**核心结论**：`LinkedHashMap` 在 HashMap 之外用一条双向链表串起所有条目；构造时 `accessOrder = true` 让每次访问把条目移到链表尾部，再重写 `removeEldestEntry`，超出容量时删除链表头（最久未访问），就是一个 LRU。

```java
public class LruCache<K, V> extends LinkedHashMap<K, V> {
    private final int capacity;

    public LruCache(int capacity) {
        super(16, 0.75f, true);                 // accessOrder = true
        this.capacity = capacity;
    }

    @Override
    protected boolean removeEldestEntry(Map.Entry<K, V> eldest) {
        return size() > capacity;
    }
}
```

- 它不是线程安全的，访问顺序模式下连 `get` 都会修改链表；生产环境的本地缓存用 Caffeine（W-TinyLFU、并发安全、支持过期）

**TreeSet / TreeMap「丢」元素**：它们用 `compareTo` / `Comparator` 判重，而不是 `equals`。比较器返回 0 的两个元素被当成同一个，后一个加不进去（TreeMap 中是覆盖 value）。例如按年龄排序的 `TreeSet<User>`，同龄的第二个用户会消失。比较器要与业务上的「相等」一致，必要时追加 `thenComparing` 区分。

- `TreeMap` 自然排序时不允许 null key；`subMap(from, to)` 是左闭右开区间

→ 详见 [集合框架](/java/21_topic_collection#七、linkedhashmap)、[Caffeine](/cache/7_caffeine)
