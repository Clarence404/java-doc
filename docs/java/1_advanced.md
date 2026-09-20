# Java 高级

## 一、泛型（Generics）

> 详细内容已整理为独立专题，见 [泛型（Generics）](./23_topic_generics.md)，涵盖类型擦除、通配符、PECS 原则、有界类型参数、泛型与数组等核心知识点。

## 二、Lambda与函数式编程

### 1、Lambda 底层原理与 函数式接口

详见：<RouteLink to="/interview/0_java#十五、说说-lambda-表达式的底层原理">
Java 总结-Java：十五、说说lambda表达式的底层原理</RouteLink>

### 2、流式 API（Stream API）与集合框架

Java 8 引入的 **Stream API** 提供了一种 **声明式、函数式风格** 来处理集合数据的方式，使得对集合的操作更加简洁、清晰和易于并行处理。

Stream 支持丰富的链式操作，例如：**`map`、`filter`、`reduce`、`sorted`、`limit`** 等，通过对数据源的流水线处理，简化复杂逻辑的实现。

#### ✅ 流的类型及其分类

详见：<RouteLink to="/interview/0_java#十六、说说java的stream">Java 总结-Java：说说Java的stream</RouteLink>

#### ✅ 集合框架与 Stream 的常见结合用法

| 操作   | 示例                                    | 说明                |
|------|---------------------------------------|-------------------|
| 创建流  | `list.stream()`                       | 从集合创建顺序流          |
| 遍历操作 | `stream.forEach(System.out::println)` | 对每个元素执行指定操作       |
| 过滤   | `stream.filter(x -> x > 10)`          | 过滤符合条件的元素         |
| 映射转换 | `stream.map(String::toUpperCase)`     | 元素转换成另一种形式        |
| 收集结果 | `stream.collect(Collectors.toList())` | 将流结果收集成列表、集合或 Map |
| 聚合统计 | `stream.count()`, `stream.max()`      | 聚合数据，如求和、计数、最大值等  |

#### ✅ 示例代码片段

```java
List<String> names = Arrays.asList("Alice", "Bob", "Charlie");

List<String> upperNames = names.stream()
        .filter(name -> name.length() > 3)
        .map(String::toUpperCase)
        .collect(Collectors.toList());
```

#### ✅ 小结

- Stream 不存储数据，只是对数据的**操作视图**。
- Stream 操作分为**中间操作（lazy）**与**终结操作（eager）**。
- 利用 Stream 可有效提升集合处理代码的**可读性、可维护性**，同时方便实现**并行化**操作。

## 三、反射机制（Reflection）

> 详细内容已整理为独立专题，见 [反射（Reflection）](./24_topic_reflection.md)，涵盖 Class 对象获取、字段/方法/构造器操作、setAccessible 安全隐患、性能优化（MethodHandle）及主要应用场景。

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
