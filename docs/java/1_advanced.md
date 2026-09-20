 Java 高级

## 一、泛型（Generics）

> 详细内容已整理为独立专题，见 [泛型（Generics）](./14_topic_generics.md)，涵盖类型擦除、通配符、PECS 原则、有界类型参数、泛型与数组等核心知识点。

## 二、Lambda与函数式编程

### 1、Lambda 底层原理与 函数式接口

详见：<RouteLink to="/interview/0_java#十五、说说-lambda-表达式的底层原理">
Java 总结-Java：十五、说说lambda表达式的底层原理</RouteLink>

### 2、流式 API（Stream API）与集合框架

Java 8 引入的 **Stream API** 提供了一种 **声明式、函数式风格** 来处理集合数据的方式，使得对集合的操作更加简洁、清晰和易于并行处理。

Stream 支持丰富的链式操作，例如：**`map`、`filter`、`reduce`、`sorted`、`limit`** 等，通过对数据源的流水线处理，简化复杂逻辑的实现。

#### ✅ 惰性求值：中间操作 vs 终结操作

Stream 的操作分为两类，这是理解其性能的核心：

| 类型 | 特点 | 常见操作 |
|------|------|----------|
| **中间操作**（Intermediate） | 惰性执行，返回新 Stream，不触发遍历 | `filter` `map` `flatMap` `sorted` `distinct` `limit` `peek` |
| **终结操作**（Terminal） | 触发整个流水线的实际执行，返回结果 | `collect` `forEach` `count` `reduce` `findFirst` `anyMatch` |

```java
// 中间操作不执行——只有 collect() 触发后，filter 和 map 才实际运行
List<String> result = list.stream()
    .filter(s -> { System.out.println("filter: " + s); return s.length() > 3; })
    .map(String::toUpperCase)
    .collect(Collectors.toList());
```

#### ✅ 常用操作速查

| 操作 | 示例 | 说明 |
|------|------|------|
| 创建流 | `list.stream()` | 从集合创建顺序流 |
| 过滤 | `stream.filter(x -> x > 10)` | 过滤符合条件的元素 |
| 映射 | `stream.map(String::toUpperCase)` | 一对一转换 |
| 扁平映射 | `stream.flatMap(Collection::stream)` | 一对多展开（List<List<T>> → List<T>） |
| 去重 | `stream.distinct()` | 依赖 equals/hashCode |
| 排序 | `stream.sorted(Comparator.reverseOrder())` | 自然序或自定义比较器 |
| 收集为 List | `stream.collect(Collectors.toList())` | 最常用终结操作 |
| 聚合统计 | `stream.count()` / `stream.max(cmp)` | 计数、最大/最小值 |
| 规约 | `stream.reduce(0, Integer::sum)` | 累积计算 |
| 遍历 | `stream.forEach(System.out::println)` | 有副作用，不可并行化时慎用 |

#### ✅ flatMap：一对多展开

```java
List<List<String>> nested = List.of(List.of("a", "b"), List.of("c", "d"));

List<String> flat = nested.stream()
    .flatMap(Collection::stream)
    .collect(Collectors.toList());
// [a, b, c, d]

// 实际场景：将订单列表展开为所有商品
List<Item> allItems = orders.stream()
    .flatMap(order -> order.getItems().stream())
    .collect(Collectors.toList());
```

#### ✅ Collectors 高级收集器

```java
// 假设已有员工列表
List<Employee> employees = getEmployees();

// 按部门分组
Map<String, List<Employee>> byDept =
    employees.stream()
             .collect(Collectors.groupingBy(Employee::getDepartment));

// 按部门统计人数
Map<String, Long> countByDept =
    employees.stream()
             .collect(Collectors.groupingBy(Employee::getDepartment, Collectors.counting()));

// 按部门求平均薪资
Map<String, Double> avgSalaryByDept =
    employees.stream()
             .collect(Collectors.groupingBy(
                 Employee::getDepartment,
                 Collectors.averagingDouble(Employee::getSalary)));

// 按条件二分（工资 >= 10000 / < 10000）
Map<Boolean, List<Employee>> partitioned =
    employees.stream()
             .collect(Collectors.partitioningBy(e -> e.getSalary() >= 10000));

// 拼接字符串
String names = employees.stream()
    .map(Employee::getName)
    .collect(Collectors.joining(", ", "[", "]"));
// [Alice, Bob, Charlie]
```

#### ✅ reduce：自定义规约

```java
// 求和（等价于 mapToInt(...).sum()，但 reduce 更通用）
int total = IntStream.rangeClosed(1, 100).reduce(0, Integer::sum); // 5050

// 求最大值
Optional<Integer> max = Stream.of(3, 1, 4, 1, 5, 9).reduce(Integer::max);

// 字符串拼接（适合演示，实际用 joining）
String joined = Stream.of("a", "b", "c").reduce("", (a, b) -> a + b);
```

#### ✅ 并行流（parallelStream）

```java
// 大数据量时可提速，小数据量时反而因线程调度开销而变慢
long count = bigList.parallelStream()
    .filter(s -> s.startsWith("A"))
    .count();
```

**注意事项**：
- 并行流使用公共 ForkJoinPool，默认并行度 = CPU 核数 - 1。
- 有状态操作（`sorted`、`distinct`）在并行流下需要合并步骤，性能提升有限。
- 避免在并行流中修改共享可变状态（线程不安全）。
- `forEach` 在并行流下顺序不保证；需要有序结果用 `forEachOrdered`。

#### ✅ Optional：安全的空值处理

```java
Optional<String> opt = Optional.ofNullable(getName());

// 取值或默认值
String name = opt.orElse("unknown");
String name = opt.orElseGet(() -> fetchDefaultName());

// 抛出自定义异常
String name = opt.orElseThrow(() -> new NotFoundException("name not found"));

// 链式转换（map 不解包，flatMap 用于返回 Optional 的函数）
Optional<Integer> len = opt.map(String::length);
```

#### ✅ 小结

- Stream **不存储数据**，只是对数据源的操作视图。
- **中间操作惰性**，终结操作触发整个流水线执行——合理安排操作顺序可减少遍历次数。
- `flatMap` 解决嵌套集合展开；`Collectors.groupingBy` 是分组统计的首选。
- 并行流适合 CPU 密集型、无状态、数据量大的场景；IO 密集型或小数据量慎用。

## 三、反射机制（Reflection）

> 详细内容已整理为独立专题，见 [反射（Reflection）](./15_topic_reflection.md)，涵盖 Class 对象获取、字段/方法/构造器操作、setAccessible 安全隐患、性能优化（MethodHandle）及主要应用场景。

## 四、注解与元编程

### 1、注解的定义与使用

注解是 Java 5 引入的一种元数据机制，用于修饰类、方法、字段等，常用于配置和标记。

```java
@Retention(RetentionPolicy.RUNTIME)
@Target(ElementType.METHOD)
public @interface MyAnnotation {
    String value() default "default";
}
```

使用：

```java
@MyAnnotation("example")
public void doSomething() { }
```

### 2、自定义注解与反射结合

结合反射获取注解信息，实现动态行为：

```java
private void test() {
  Method method = MyClass.class.getMethod("doSomething");
  if (method.isAnnotationPresent(MyAnnotation.class)) {
    MyAnnotation annotation = method.getAnnotation(MyAnnotation.class);
    System.out.println("注解值: " + annotation.value());
  }
}
```

### 3、注解处理器（Annotation Processor）

用于在编译期处理注解，生成代码或校验逻辑，广泛应用于 **Lombok、Dagger、AutoValue** 等库。

* 基于 `javax.annotation.processing.AbstractProcessor`
* 通过 `@SupportedAnnotationTypes`、`@SupportedSourceVersion` 指定处理器信息

```java
@SupportedAnnotationTypes("com.example.MyAnnotation")
@SupportedSourceVersion(SourceVersion.RELEASE_17)
public class MyAnnotationProcessor extends AbstractProcessor {
    @Override
    public boolean process(Set<? extends TypeElement> annotations, RoundEnvironment roundEnv) {
        for (Element element : roundEnv.getElementsAnnotatedWith(MyAnnotation.class)) {
            processingEnv.getMessager().printMessage(Diagnostic.Kind.NOTE, "处理了: " + element);
        }
        return true;
    }
}
```

**使用工具**：JavaPoet 可用于生成类、方法、字段等源码结构。
