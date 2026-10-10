---
description: Lambda 与 Stream、版本特性、异常、String、泛型、反射与代理、IO、序列化、集合
---

# Java 基础面试题解答

> 题目清单见 [Java 面试题](/java/99_interview)；「并发」一组的答案见 [Java 并发面试题解答](/interview/2_concurrent)。
>
> 版本基线：JDK 21 / 25 LTS，与 JDK 8 / 17 不同处单独说明。

## 一、综合与版本

### Q1：`==` 和 `equals()` 的区别？为什么重写 `equals` 必须重写 `hashCode`？`Integer.valueOf(127) == Integer.valueOf(127)` 为什么是 true？

**一句话**：`==` 看是不是同一个对象，`equals` 看内容是否相等。`HashMap` 先用 `hashCode` 找位置、再用 `equals` 比较，两者不一致就会找不到元素或存出重复。

- 基本类型用 `==` 比的是值；对象默认的 `equals` 就是 `==`，要按内容比较必须自己重写
- 规则：`equals` 相等，`hashCode` 一定要相等；反过来不要求（`hashCode` 相同只是「撞位置」）
- `Integer.valueOf` 和自动装箱对 -128 ~ 127 返回缓存好的同一个对象，所以 127 用 `==` 是 true，128 就是 false
- 值对象优先用 `record`，`equals` / `hashCode` 由编译器自动生成

**常见坑**：包装类之间用 `==` 比较（应该用 `equals`）；`Integer` 为 null 时自动拆箱直接 NPE。

→ 详见 [集合框架](/java/21_topic_collection#_5、key-的设计)、[享元模式](/patterns/11_structural_flyweight#三、jdk-中的应用)

### Q2：抽象类和接口的区别？Java 为什么不支持类的多继承，接口默认方法冲突怎么解决？

**一句话**：抽象类说明「它是什么」，可以有字段和构造器，只能继承一个；接口说明「它能做什么」，没有实例字段，可以实现多个。

| 对比 | 抽象类 | 接口 |
|------|-------|------|
| 字段 | 任意字段 | 只有常量 |
| 构造器 | 有 | 无 |
| 方法 | 抽象 + 具体方法 | 抽象方法；JDK 8 起可有 `default` / `static` 方法 |
| 继承 | 只能继承一个 | 可实现多个 |

- 不允许多继承类：两个父类有同名方法或字段时，子类不知道用哪个（菱形继承问题）
- 默认方法冲突时：父类的方法优先；其次是更具体的子接口优先；还分不出来就编译报错，实现类必须自己重写，可用 `A.super.method()` 指定用哪个
- 复用代码优先用组合而不是继承

→ 详见 [版本演进](/java/2_version#_5、sealed-类-java-17)、[模板方法模式](/patterns/21_behavioral_template_method)

### Q3：Lambda 的底层原理是什么？和匿名内部类有什么区别？为什么只能捕获 effectively final 的局部变量？

**一句话**：Lambda 不是匿名内部类的简写。编译时只变成一个私有方法，第一次运行时 JVM 才临时生成实现类。

- 编译后：Lambda 体变成当前类里的一个私有方法，不会多出 `Outer$1.class` 文件
- 运行时：第一次执行到这一行时，JVM 动态生成一个实现类（`invokedynamic` 指令负责这件事），之后直接复用
- 和匿名内部类的区别：Lambda 里的 `this` 指外面的对象，匿名类里的 `this` 指它自己；Lambda 只能用于只有一个抽象方法的接口
- 为什么变量必须不变：Lambda 拿到的是变量值的一份拷贝，外面改了它看不到，所以干脆禁止修改；要累加就用 `AtomicInteger`

**常见坑**：`Function`、`Consumer` 等接口不能抛受检异常，Lambda 内要捕获后包装成非受检异常再抛。

→ 详见 [Lambda、Stream 与注解](/java/1_advanced#_2、底层实现-invokedynamic-lambdametafactory)、[内部类](/java/13_topic_inner_class#七、lambda-与匿名类的区别)

### Q4：Stream 的惰性求值是什么？有状态 / 无状态 / 短路操作有哪些？`Collectors.toMap` 有哪些坑？`Stream.toList()` 与 `Collectors.toList()` 有什么区别？

**一句话**：`filter`、`map` 这些中间操作只是在搭流水线，等调用 `collect`、`forEach` 这类终结操作时才真正执行，而且元素是一个一个走完整条流水线的。

- 无状态操作：`filter`、`map`、`flatMap`，处理一个元素不用看别的元素
- 有状态操作：`sorted`、`distinct`、`limit`、`skip`，要看前面的元素，`sorted` 甚至要先把数据全部收齐
- 短路操作：`limit`、`findFirst`、`anyMatch` 等，不用处理完所有元素就能出结果，所以能用在无限流上
- 一个流只能用一次，再用抛 `IllegalStateException`

| 收集方式 | 结果能否修改 | 允许 null |
|---------|------------|----------|
| `Stream.toList()`（JDK 16） | 不能 | 允许 |
| `Collectors.toList()` | 规范不保证（目前是 `ArrayList`） | 允许 |

**常见坑**：`toMap` 遇到重复 key 抛异常，要传第三个参数决定保留哪个；value 为 null 直接 NPE。

→ 详见 [Lambda、Stream 与注解](/java/1_advanced#_1、流水线与惰性求值)

### Q5：并行流用的是哪个线程池？默认并行度是多少？为什么不能在并行流里做阻塞 IO？

**一句话**：并行流用的是 JVM 全局共享的 `ForkJoinPool.commonPool()`，默认线程数是 CPU 核数减 1（调用线程自己也会参与）。在里面做阻塞 IO 会把这几个线程占满，全局都跟着变慢。

- 「全局共享」意味着：不传线程池的 `CompletableFuture.xxxAsync` 也用这个池，会被一起拖慢
- 容器里核数按 CPU 限额算，限额 1～2 核时并行度只有 1
- 适合：数据量大、能均匀切分（数组、`ArrayList`）、纯 CPU 计算；`LinkedList` 切分效果差
- 要限量并发地做 IO：用虚拟线程 + `Semaphore`，或 JDK 24 起的 `Gatherers.mapConcurrent`

**常见坑**：在并行流的 `forEach` 里往共享的 `ArrayList` 写数据会丢数据，结果要用 `collect` 收集。

→ 详见 [Lambda、Stream 与注解](/java/1_advanced#_6、并行流)

### Q6：Optional 的正确用法？`orElse` 和 `orElseGet` 有什么区别？

**一句话**：`Optional` 只用来做「可能没有结果」的方法返回值，提醒调用方处理空的情况；不要拿它当字段、参数或放进集合。

- `orElse(x)`：不管有没有值，`x` 都会先算出来
- `orElseGet(supplier)`：只有为空时才调用 `supplier`，默认值代价大（比如要查库）时用它
- 包装可能为 null 的值用 `ofNullable`，`Optional.of(null)` 直接 NPE
- 不要写 `if (opt.isPresent()) opt.get()`，用 `map`、`orElse*`、`ifPresent`；取值优先用语义更清楚的 `orElseThrow()`

```java
User u = findUser(id).orElseGet(this::createDefault);   // 找不到时才创建
```

**常见坑**：返回集合的方法直接返回空集合，不要返回 `Optional<List<T>>`。

→ 详见 [Lambda、Stream 与注解](/java/1_advanced#四、optional)

### Q7：`@Retention` 三种策略有什么区别？注解处理器的原理是什么？Lombok 为什么特殊，JDK 23 之后为什么可能失效？与 MapStruct 同用要注意什么？

**一句话**：注解只是一个标记，得有人读它才起作用：`SOURCE` 注解由编译器里的注解处理器读，`RUNTIME` 注解在运行时通过反射读。

- `SOURCE`：编译完就丢掉，如 `@Override`、Lombok 的 `@Getter`；`CLASS`（默认）：留在 class 文件里但运行时读不到；`RUNTIME`：运行时能读到，如 Spring 的 `@Component`
- 注解处理器在编译时运行，正规做法只能生成新文件；Lombok 特殊在它直接改编译器内部的语法树，所以每个新 JDK 都要配新版 Lombok
- JDK 23 起，编译器不再自动运行依赖里的注解处理器；Maven 要在 `annotationProcessorPaths` 里显式声明，否则会报「找不到 getter」
- MapStruct 编译期生成普通 getter / setter 调用，比运行时反射的 `BeanUtils.copyProperties` 更快，类型不对直接编译失败

**常见坑**：Lombok 与 MapStruct 同用时，处理器路径要同时写上 `lombok`、`mapstruct-processor`、`lombok-mapstruct-binding`，否则可能生成空映射。

→ 详见 [Lambda、Stream 与注解](/java/1_advanced#_4、注解处理器)、[效率工具库](/java/98_dev_tool#_2、原理与-jdk-兼容性)

### Q8：Java 8 → 11 → 17 → 21 升级分别会遇到哪些兼容问题？

**一句话**：8 → 11 是 Java EE 相关模块被删了；11 → 17 是 JDK 内部 API 不让随便反射了，这是最大的坑；17 → 21 主要是一些默认行为变了。通用做法是先升依赖库，再升 JDK。

- 8 → 11：JAXB、`javax.annotation` 等被移出 JDK，单独加依赖
- 11 → 17：反射访问 JDK 内部类报 `InaccessibleObjectException`，升级库或加 `--add-opens`；CMS 被移除，换 G1 / ZGC
- 17 → 21：默认字符集改为 UTF-8，IO 要显式指定编码；动态加载的 Agent 会打印警告，改用 `-javaagent` 启动
- Spring Boot 3 要求 JDK 17，还要把 `javax.*` 包名改成 `jakarta.*`，通常和 11 → 17 一起做
- 用 `jdeps --jdk-internals` 扫出用到的内部 API；Lombok、Mockito 这类操作字节码的库先升级

→ 详见 [版本演进](/java/2_version#九、移除与废弃速查)

### Q9：JDK 21 和 JDK 25 各有哪些重要新特性？哪些仍是预览？record、sealed 与 switch 模式匹配配合解决什么问题？

**一句话**：JDK 21 最重要的是虚拟线程和 switch 模式匹配转正；JDK 25 把 `ScopedValue`、灵活构造器等转正。结构化并发在 25 仍是预览，不要用在生产。

- JDK 21：虚拟线程、record 模式、switch 模式匹配、有序集合统一接口（Sequenced Collections）、分代 ZGC
- JDK 22～24：FFM API（替代 JNI 调本地代码）、未命名变量 `_`、Stream Gatherers；24 起 `synchronized` 不再把虚拟线程卡在平台线程上
- JDK 25：`ScopedValue`、灵活构造器体、模块导入、紧凑对象头（对象头变小，省内存）
- 三者配合：`sealed` 限定「只有这几种子类」，`record` 装数据，`switch` 直接拆出字段，编译器检查有没有漏掉哪种子类

```java
return switch (shape) { case Circle(double r) -> Math.PI * r * r; case Rect(double w, double h) -> w * h; };
```

→ 详见 [版本演进](/java/2_version#四、java-21-lts)

### Q10：单例模式有几种写法？DCL 为什么要加 volatile？推荐哪种？

**一句话**：常见有饿汉、懒汉、双重检查锁（DCL）、静态内部类、枚举五种；要懒加载用静态内部类，要防反射和序列化用枚举，实际项目里一般交给 Spring 管。

- DCL 必须加 `volatile`：`new` 对象的「分配内存、执行构造器、赋值给变量」三步可能被重排序，别的线程会拿到还没构造完的对象
- 五种写法的完整对比、防反射与反序列化的做法，统一在设计模式答案页

→ 详见 [设计模式面试题解答](/interview/17_patterns#q3-单例模式有几种写法-推荐哪种)、[JMM 内存模型](/java/22_topic_jmm#七、双重检查锁-dcl)

### Q11：`Arrays.sort()` 底层用的什么算法？对基本类型和对象有何不同？

**一句话**：基本类型数组用双轴快速排序，对象数组用 TimSort。区别在于对象排序需要「稳定」，基本类型不需要。

- 稳定的意思：值相等的元素排完后保持原来的先后顺序；对 `int` 无所谓，对对象有意义（比如先按时间排、再按状态排）
- 双轴快排：快排的改进版，用两个基准值分三段，小区间改用插入排序
- TimSort：归并 + 插入排序的组合，会利用数据里已经有序的片段，部分有序时接近 O(n)
- `Collections.sort`、`List.sort` 最后也走 TimSort

**常见坑**：比较器写成 `a - b` 可能溢出、违反比较规则，TimSort 会抛 `Comparison method violates its general contract!`；用 `Integer.compare` 或 `Comparator.comparing`。

→ 详见 [排序算法](/algorithms/2_algorithms/1_sort#四、内置排序的实现)

## 二、语言机制

### Q12：Error 和 Exception 的区别？受检与非受检异常如何判定？为什么业务异常通常继承 RuntimeException？异常的开销在哪？

**一句话**：`Error` 是 JVM 级的严重问题（如 OOM），程序不该处理；`Exception` 是程序能处理的异常。`RuntimeException` 和 `Error` 及其子类是非受检的，其他都是受检的，必须 catch 或声明 `throws`。

- 受检异常例子：`IOException`、`SQLException`；非受检例子：`NullPointerException`、`IllegalArgumentException`
- 业务异常继承 `RuntimeException`：一般由全局异常处理器统一转成错误码，不用每层都写 `throws`；Lambda 里也能直接抛
- Spring `@Transactional` 默认只对 `RuntimeException` 和 `Error` 回滚，受检异常要配 `rollbackFor`
- 开销主要在创建异常时收集调用栈，不在 `throw` 本身；高频业务异常可以关掉收集调用栈

**常见坑**：既打日志又往外抛，会重复记录；要么处理并记录，要么带上 cause 包装后抛出。

→ 详见 [异常体系](/java/10_topic_exception#一、异常层次结构)

### Q13：finally 一定会执行吗？finally 里 return 会怎样？try-with-resources 中 `close()` 抛出的异常去哪了？

**一句话**：正常返回、抛异常、`break` / `continue` 时 finally 都会执行；只有 JVM 停了才不执行，比如 `System.exit()`、`kill -9`、JVM 崩溃。

- finally 里写 `return` 会覆盖 try 的返回值，还会把 try 里的异常吞掉，所以 finally 只做清理
- try 里 `return x` 时返回值已经先存好了，finally 再改基本类型变量不影响结果；改的是对象内容则会体现
- try-with-resources：资源按声明的反顺序关闭；如果 try 里已经抛了异常，`close()` 的异常挂在主异常上（`getSuppressed()` 能取到），不会覆盖主异常

→ 详见 [异常体系](/java/10_topic_exception#三、finally-与-try-with-resources)

### Q14：String 为什么不可变？JDK 9 之后底层结构和 `+` 拼接有什么变化？循环里为什么还要用 StringBuilder？

**一句话**：String 类是 `final` 的，内部数组是私有的且不对外暴露，所有「修改」方法都返回新对象，所以外面没有办法改它。

- 不可变的好处：相同字面量可以共享一个对象；`hashCode` 算一次就能缓存，适合当 `HashMap` 的 key；多线程共享不用加锁
- JDK 9 起内部从 `char[]` 改成 `byte[]`，纯英文字符每个只占 1 字节，省一半内存
- JDK 9 起 `+` 拼接不再编译成 `StringBuilder`，而是运行时再决定怎么拼（又是 `invokedynamic`）
- 循环里 `s += x` 每次都新建字符串并复制前面的内容，整体是 O(n²)；在循环外建一个 `StringBuilder` 反复 `append` 才是线性的

→ 详见 [String](/java/11_topic_string#一、不可变性与内存布局)

### Q15：`new String("abc")` 创建了几个对象？什么情况下 `==` 比较字符串为 true？`intern()` 有什么风险？

**一句话**：最多两个：字面量 `"abc"` 放在字符串常量池里（已有就复用），`new` 再在堆上建一个新对象，内容一样但不是同一个对象。

- `==` 为 true 的情况：同一个字面量 `"ab" == "ab"`；编译期就能算出的拼接 `"a" + "b" == "ab"`；`intern()` 返回的池中对象
- 拼接里有普通变量或方法返回值时，是运行时拼接，得到新对象，`==` 为 false
- 业务代码比较字符串一律用 `equals`

**常见坑**：对用户输入、订单号这种数量不受控的字符串调 `intern()`，常量池会越来越大、查找变慢、GC 负担加重。

→ 详见 [String](/java/11_topic_string#二、常量池与)、[JVM 面试题解答](/interview/3_jvm)

### Q16：枚举的本质是什么？一定是 final 吗？为什么枚举单例能防反射和序列化破坏？`ordinal()` 能持久化吗？

**一句话**：枚举编译后就是一个继承 `java.lang.Enum` 的类，每个常量是它的 `static final` 实例，类加载时创建好。

- 一定是 final 吗：常量都不带类体时是 final；有常量带类体（`{...}`）时不是，但用户代码依然不能继承它
- 防反射：反射调用枚举的构造器直接抛异常，造不出第二个实例
- 防序列化：序列化只写常量名，反序列化按名字找回已有的常量
- `values()` 每次都复制一份数组，热点代码里要缓存

**常见坑**：`ordinal()` 是声明顺序，中间插一个常量，库里存的数字就全错了；持久化用业务 code 或 `name()`。JPA `@Enumerated` 默认存 ordinal，要写 `EnumType.STRING`。

→ 详见 [枚举](/java/12_topic_enum#一、枚举的本质)

### Q17：静态嵌套类和内部类的区别？内部类 / 匿名类为什么会导致内存泄漏？

**一句话**：区别在于是否带着外部对象：内部类实例偷偷持有外部对象的引用，静态嵌套类没有。不需要访问外部对象时，一律加 `static`。

- 创建方式：静态嵌套类 `new Outer.Nested()`；内部类要先有外部对象 `outer.new Inner()`
- 内存泄漏的原因：一个长期存活的对象引用了内部类实例，内部类实例又拖着整个外部对象，导致外部对象回收不了
- 常见场景：匿名监听器注册到全局后从不注销；双括号初始化 `new HashMap<>() {{ put(...); }}` 返回出去；异步任务捕获了整个大对象
- 解决：注册和注销成对出现；只捕获需要的字段；优先用静态嵌套类或 Lambda（Lambda 只有用到 `this` 时才持有外部对象）

→ 详见 [内部类](/java/13_topic_inner_class#一、嵌套类的分类)

### Q18：泛型的类型擦除是什么？擦除后为什么还能在运行时拿到 `List<User>` 的泛型类型？什么是桥方法？

**一句话**：泛型只在编译时检查类型，编译后类型参数被「擦掉」换成 `Object`（或上界），取值时自动插入强转。

- 擦掉的是对象实例上的类型：运行时 `new ArrayList<User>()` 和 `new ArrayList<Order>()` 是同一个类
- 但字段、方法、父类声明里写的泛型会保存在 class 文件中，反射能读到
- TypeToken 技巧：写 `new TypeReference<List<User>>() {}` 生成一个匿名子类，把泛型写进父类声明里，再用反射读出来；Jackson、Spring 都这么做
- 桥方法：子类覆写泛型父类方法时，编译器自动补一个参数为 `Object` 的方法，转调真正的实现，保证多态正常

**常见坑**：不能 `new T()`、不能写 `T.class`，需要类型时传 `Class<T>` 进来。

→ 详见 [泛型](/java/14_topic_generics#二、类型擦除)

### Q19：`List<? extends Number>` 为什么不能 add？PECS 是什么？为什么不能创建泛型数组？

**一句话**：`List<? extends Number>` 实际可能是 `List<Integer>`，也可能是 `List<Double>`，编译器不知道放什么才安全，所以只能读不能写。

- PECS：只往外读（生产者）用 `<? extends T>`，只往里写（消费者）用 `<? super T>`，又读又写就直接用 `<T>`
- 标准例子：`Collections.copy(List<? super T> dest, List<? extends T> src)`
- 不能建泛型数组：数组运行时会检查放进去的类型，但泛型被擦除后检查不了；如果允许，`List<Integer>` 能混进 `List<String>[]` 里，取出时才报 `ClassCastException`
- 需要「泛型数组」时用 `List<List<String>>` 代替

→ 详见 [泛型](/java/14_topic_generics#四、pecs-原则)

### Q20：反射有哪些典型应用？`getMethods()` 与 `getDeclaredMethods()`、`Class.forName` 与 `ClassLoader.loadClass` 有什么区别？

**一句话**：反射就是程序运行时查看并调用一个类的字段、方法、注解。Spring 依赖注入、MyBatis 结果映射、Jackson 序列化、JUnit 找测试方法都靠它。

| 对比 | 返回什么 |
|------|---------|
| `getMethods()` | 本类和所有父类、接口的 public 方法 |
| `getDeclaredMethods()` | 只有本类自己声明的方法，包括 private |
| `Class.forName(name)` | 加载类并初始化（会执行静态代码块） |
| `ClassLoader.loadClass(name)` | 只加载，不初始化 |

- 拿父类的私有字段，要沿 `getSuperclass()` 一级级往上找
- 反射调用的方法抛的业务异常被包在 `InvocationTargetException` 里，要用 `getCause()` 取出来

→ 详见 [反射](/java/15_topic_reflection#二、成员查找语义)

### Q21：反射为什么慢？JDK 18 之后实现有什么变化？JDK 17 之后反射访问 JDK 内部类报 `InaccessibleObjectException` 怎么处理？

**一句话**：反射慢在每次都要查找方法、做权限检查、参数装箱，而且 JIT 不好优化。但具体慢多少要实测，不能一概而论。

- JDK 18 起反射改用方法句柄实现：`Method` 对象存在 `static final` 字段里时更快，否则某些场景反而更慢
- 最有效的优化是把 `Method` / `Field` 缓存起来，别每次都 `getMethod`
- 调用特别频繁的地方，可以改成编译期生成代码（如 MapStruct），彻底不用反射
- `InaccessibleObjectException`：JDK 16 / 17 起默认禁止反射访问 JDK 内部包；首选升级依赖库，实在需要就加启动参数 `--add-opens java.base/java.lang=ALL-UNNAMED`

→ 详见 [反射](/java/15_topic_reflection#五、实现与性能)

### Q22：JDK 动态代理和 CGLIB 的区别？Spring / Spring Boot 默认用哪种？CGLIB 的 `invoke` 与 `invokeSuper` 有什么区别？

**一句话**：JDK 动态代理通过实现接口来代理，只能代理接口；CGLIB 通过生成子类来代理，没有接口也行，但 `final` 类和 `final` / `private` / `static` 方法拦截不了。

| 对比 | JDK 动态代理 | CGLIB |
|------|-------------|-------|
| 原理 | 实现目标接口 | 继承目标类 |
| 要求 | 必须有接口 | 类不能是 `final` |
| 拦截不了 | 接口以外的方法 | `final` / `private` / `static` 方法 |

- Spring 默认：有接口用 JDK 代理，没有用 CGLIB；Spring Boot 2.0 起默认统一用 CGLIB
- `invokeSuper(proxy, args)`：在代理对象上调父类方法，类内部自己调自己也会被拦截
- `invoke(target, args)`：转给另一个目标对象，类内部自己调自己不会被拦截，这就是 Spring AOP 自调用失效的原因
- 两者性能在现代 JDK 上差不多，不是选型依据

→ 详见 [动态代理](/java/16_topic_proxy#二、cglib-动态代理)

## 三、IO 与数据

### Q23：`SimpleDateFormat` 为什么线程不安全？`LocalDateTime`、`OffsetDateTime`、`ZonedDateTime`、`Instant` 有什么区别？

**一句话**：`SimpleDateFormat` 把解析过程的中间结果存在一个共享的成员变量里，多线程同时用会互相覆盖。改用 `DateTimeFormatter`，它不可变，可以做成全局常量。

| 类型 | 含义 | 能否确定唯一时刻 |
|------|------|---------------|
| `Instant` | 从 1970 年起的秒数，机器时间 | 能 |
| `LocalDateTime` | 墙上的日期时间，不带时区 | 不能 |
| `OffsetDateTime` | 加上固定偏移，如 `+08:00` | 能，但不懂夏令时 |
| `ZonedDateTime` | 加上时区，如 `Asia/Shanghai` | 能，会处理夏令时 |

- 时区用 `Asia/Shanghai` 这种完整 ID，不用 `CST` 这类缩写（`CST` 可能被当成美国中部时间）
- `java.time` 的对象都不可变，`plusDays` 返回新对象，忘了接收返回值是常见错误

**常见坑**：格式里 `YYYY` 是「周所在的年」，跨年那几天会错，年份用 `yyyy`。

→ 详见 [日期与时间](/java/17_topic_time#二、java-time-类型模型)

### Q24：数据库里时间该怎么存？MySQL `DATETIME` 与 `TIMESTAMP` 有什么区别？夏令时会带来什么问题？

**一句话**：已经发生的事存 UTC 时刻，展示时再转成用户时区；未来的本地事件（如「每天 9 点开会」）存本地时间 + 时区；生日这种纯日期存 `LocalDate`。

| 对比 | `DATETIME` | `TIMESTAMP` |
|------|-----------|-------------|
| 存什么 | 写什么存什么，不转时区 | 按连接时区转成 UTC 存，读时再转回 |
| 范围 | 1000 ~ 9999 年 | 1970 ~ 2038 年 |

- 驱动连接串显式写 `serverTimezone=Asia/Shanghai`，否则 MySQL 显示 `CST` 时，旧驱动可能当成美国时间，差 13 或 14 小时
- 夏令时：拨快时有一段本地时间不存在，拨慢时有一段出现两次；`plusDays(1)` 和 `plusHours(24)` 在切换那天结果不同

→ 详见 [日期与时间](/java/17_topic_time#七、数据库映射)

### Q25：Java IO 流有哪些分类？BIO / NIO / AIO 的区别？有了虚拟线程还需要 NIO / Netty 吗？

**一句话**：按数据单位分字节流（`InputStream` / `OutputStream`）和字符流（`Reader` / `Writer`，就是字节流加上编解码）；日常读写文件首选 `Files` 工具类。

| 模型 | 做法 | 现状 |
|------|------|------|
| BIO | 一个连接一个线程，读写时阻塞等待 | 配合虚拟线程又能用了 |
| NIO | 少量线程盯着很多连接，谁有数据处理谁 | Netty 的基础 |
| AIO | 发起操作后等回调 | Linux 上不是真异步，很少用 |

- 普通「接请求 → 调下游 HTTP / 数据库 → 返回」的业务：虚拟线程 + 阻塞写法最简单
- 自定义二进制协议、几万长连接、零拷贝这类场景，仍然用 NIO / Netty
- `BufferedReader` 包装 `FileReader` 这种层层包装是装饰器模式

**常见坑**：JDK 17 及以前不指定编码时用系统编码（Windows 上不是 UTF-8），要显式传 `StandardCharsets.UTF_8`。

→ 详见 [IO 与 NIO](/java/18_topic_io#一、io-体系结构)

### Q26：零拷贝的原理？`transferTo` 与 `mmap` 各有什么限制？直接缓冲区的代价是什么？

**一句话**：零拷贝就是少让 CPU 在内核和应用之间搬数据。普通的读再写要 CPU 拷 2 次；`transferTo`（底层是 Linux 的 `sendfile`）只拷 1 次，网卡支持时 0 次。

| 方案 | CPU 拷贝次数 | Java API | 限制 |
|------|------------|----------|------|
| `read` + `write` | 2 | 普通流 | 无 |
| `mmap` | 1 | `FileChannel.map()` | 单次最多约 2 GB，释放要等 GC |
| `sendfile` | 1 或 0 | `FileChannel.transferTo()` | 一次可能传不完要循环；开了 TLS 用不上 |

- 应用：Kafka 发送消息、Netty 发文件用 `sendfile`；RocketMQ 存消息用 mmap
- 直接缓冲区（`allocateDirect`）在堆外，网络读写少一次拷贝；但分配贵，释放要靠 GC，可能堆外先满报 `Direct buffer memory`
- 所以直接缓冲区适合大块、反复复用的场景，Netty 会做池化

→ 详见 [IO 与 NIO](/java/18_topic_io#四、零拷贝)

### Q27：序列化的作用？`serialVersionUID` 有什么用？类新增 / 删除字段后反序列化会怎样？

**一句话**：序列化是把对象转成字节，用来网络传输或存盘。`serialVersionUID` 是类的版本号，读的时候版本对不上就抛 `InvalidClassException`。

- 不写版本号时编译器按类结构自动算，加个方法都可能变，所以一定要显式写死
- 版本号不变时：新增字段读旧数据得到默认值（null / 0），而且字段初始值和构造器都不会执行；删除字段多出来的值被忽略；改字段类型则报错
- `transient` 和 `static` 字段不参与序列化
- 反序列化不调用本类构造器（`record` 例外，会走构造器校验）

→ 详见 [序列化](/java/19_topic_serialization#一、java-原生序列化)

### Q28：反序列化漏洞的原理？如何用 `ObjectInputFilter` 防护？序列化方案怎么选？

**一句话**：`ObjectInputStream` 会按数据里写的类名创建对象并执行它的回调方法。攻击者拼出一串项目里已有的类，让回调层层触发，最后执行任意命令。只要反序列化不可信的数据，就有风险。

- 根本解法：对外接口不用 Java 原生序列化，改用 JSON 或 Protobuf
- `ObjectInputFilter`（JDK 9 起，8u121 也有）：用 `-Djdk.serialFilter=com.example.*;!*` 配白名单，只允许自己的类
- 同类问题：Fastjson 1.x 的 `autoType` 允许 JSON 指定类名；Jackson 不要对外部输入开启全局默认类型
- 选型：对外 HTTP 接口用 JSON（Jackson）；跨语言 RPC 用 Protobuf（gRPC）；Java 内部高性能传输用 Kryo、Hessian2

→ 详见 [序列化](/java/19_topic_serialization#五、反序列化安全)

### Q29：SPI 是什么，与 API 有何区别？SPI 如何「打破」双亲委派？Dubbo SPI 和 Spring Boot 自动配置做了哪些增强？

**一句话**：API 是别人写好实现给你调用；SPI 反过来，框架定好接口，由第三方提供实现，框架运行时自动发现并加载。Java 自带的 SPI 是 `ServiceLoader`，读 `META-INF/services/接口全名` 里写的实现类。

- 打破双亲委派：`DriverManager` 由最顶层的类加载器加载，按规则看不到应用里的 MySQL 驱动；`ServiceLoader` 借用当前线程的类加载器去加载，绕过了这个限制
- 所以 JDBC 4.0 起不用再写 `Class.forName` 注册驱动
- 原生 SPI 的不足：只能全部加载遍历，不能按名字取、不能排序、不能按条件启用
- Dubbo SPI：可以按名字取、按参数动态选实现、自动包装和注入依赖；Spring Boot 3 起自动配置类登记在 `META-INF/spring/…AutoConfiguration.imports`，再配合 `@Conditional` 按条件装配

→ 详见 [SPI 机制](/java/20_topic_spi#二、java-原生-spi-serviceloader)

### Q30：HashMap 的 put 流程？hash 为什么要 `h ^ (h >>> 16)`？容量为什么是 2 的幂？哈希冲突有哪些解决方式？

**一句话**：HashMap 是数组 + 链表 / 红黑树。put 时先算 hash 定位到数组下标，没人就直接放，有人就比较 key，相同则覆盖，不同就挂到链表尾部。

- 容量是 2 的幂：这样 `(n - 1) & hash` 就等于取模，只用位运算更快，扩容时也好拆分
- `h ^ (h >>> 16)`：表小时下标只用到 hash 的低几位，把高 16 位混进来，避免高位不同、低位相同的 key 全挤在一起
- 默认容量 16、负载因子 0.75，第一次 put 才真正分配数组；元素数超过 容量 × 0.75 就扩容
- 解决冲突的办法：拉链法（同一位置挂链表，HashMap 用这个）；开放地址法（冲突就往后找空位，`ThreadLocalMap` 用这个）；再哈希（换个哈希函数）

→ 详见 [集合框架](/java/21_topic_collection#六、hashmap)

### Q31：HashMap 何时树化、何时退化？扩容时元素如何迁移？JDK 7 并发扩容为什么会死循环？

**一句话**：链表长度超过 8 且数组长度至少 64 时转成红黑树；数组不到 64 时先扩容。树上节点减到 6 个及以下时退回链表。

- 为什么是 8：hash 分布正常时一个位置堆到 8 个的概率极低（约千万分之六），真到了多半是 `hashCode` 写得差，转红黑树把查找从 O(n) 降到 O(log n)
- 扩容：容量翻倍，每个元素看 hash 的某一位，要么留在原位置 `i`，要么移到 `i + 旧容量`，不用重新算 hash
- JDK 7 死循环：迁移时用头插法，会把链表顺序反过来；两个线程同时扩容可能形成环形链表，之后 `get` 一直转圈，CPU 100%
- JDK 8 改成尾插不再成环，但 HashMap 仍然不是线程安全的，并发 put 会丢数据

**常见坑**：`new HashMap<>(n)` 的 n 是容量不是元素数，放 n 个元素仍可能扩容；JDK 19 起用 `HashMap.newHashMap(n)`。

→ 详见 [集合框架](/java/21_topic_collection#_3、树化与退化)

### Q32：ArrayList 的扩容机制？ArrayList 与 LinkedList 怎么选？fail-fast 与弱一致迭代器有什么区别？

**一句话**：`ArrayList` 第一次 `add` 时分配容量 10，不够时扩成原来的 1.5 倍并复制数组。几乎所有场景都选 `ArrayList`，`LinkedList` 很少有优势。

| 对比 | ArrayList | LinkedList |
|------|-----------|-----------|
| 按下标访问 | O(1) | O(n) |
| 中间插入 | 要移动元素，但复制很快 | 要先 O(n) 找到位置 |
| 内存 | 连续紧凑，CPU 缓存友好 | 每个元素多一个节点对象 |

- 需要头尾操作（队列 / 栈）用 `ArrayDeque`
- fail-fast：迭代时发现集合被改了，立即抛 `ConcurrentModificationException`，`ArrayList`、`HashMap` 都是这样
- 弱一致：`ConcurrentHashMap` 等并发集合迭代时不抛异常，可能看到也可能看不到迭代中的修改

**常见坑**：单线程在 for-each 里删除元素也会触发 fail-fast，要用 `removeIf` 或 `Iterator.remove()`。

→ 详见 [集合框架](/java/21_topic_collection#_1、arraylist-vs-linkedlist)

### Q33：`List.of`、`Arrays.asList`、`Collections.unmodifiableList` 有什么区别？JDK 21 Sequenced Collections 解决了什么问题？

**一句话**：`List.of` 是真正不可变的；`Arrays.asList` 长度固定、和原数组共享数据；`Collections.unmodifiableList` 只是只读的「窗口」，底层集合变了它也跟着变。

| API | 能否修改 | 允许 null | 和源数据的关系 |
|-----|---------|----------|-------------|
| `List.of` | 不能 | 不允许 | 独立 |
| `Arrays.asList` | 能 `set`，不能 `add` / `remove` | 允许 | 和原数组互相影响 |
| `Collections.unmodifiableList` | 通过它改不了 | 允许 | 跟着底层集合变 |

- Sequenced Collections：以前取最后一个元素，List、Deque、SortedSet 各有各的写法，`LinkedHashSet` 甚至没法取；JDK 21 统一加了 `getFirst` / `getLast`、`addFirst` / `addLast`、`reversed()` 等方法

**常见坑**：`Arrays.asList(int[])` 得到的是只有一个元素（整个数组）的 List。

→ 详见 [集合框架](/java/21_topic_collection#_2、不可变集合)

### Q34：如何用 LinkedHashMap 实现 LRU？TreeSet / TreeMap 为什么可能「丢」元素？

**一句话**：`LinkedHashMap` 构造时传 `accessOrder = true`，每次访问会把元素移到末尾；再重写 `removeEldestEntry`，超出容量就删掉最前面（最久没用）的那个，就是 LRU。

```java
super(16, 0.75f, true);   // 构造器里：按访问顺序排列
protected boolean removeEldestEntry(Map.Entry<K, V> eldest) { return size() > capacity; }
```

- 它不是线程安全的，连 `get` 都会改链表；生产环境的本地缓存用 Caffeine
- TreeSet / TreeMap 用比较器判断「是否同一个元素」，而不是 `equals`；比较结果为 0 就当作重复
- 例子：按年龄排序的 `TreeSet<User>`，同龄的第二个用户加不进去；要用 `thenComparing` 再加一个区分字段

→ 详见 [集合框架](/java/21_topic_collection#七、linkedhashmap)、[Caffeine](/cache/7_caffeine)；不借助 LinkedHashMap 手写 LRU 见 [算法面试题解答](/interview/4_algorithms#q8-如何手写一个-lru-缓存)
