---
description: 简单工厂、工厂方法与 Creator、静态工厂方法、Collection.iterator 与 FactoryBean
---

# 工厂模式

> 前置阅读：[单例模式](./1_creational_singleton)

「工厂」常指简单工厂、工厂方法和静态工厂方法三种不同的东西。本篇分清三者，介绍 JDK 与 Spring 中真正的工厂方法，以及如何消除简单工厂里的 `switch`。

---

## 一、定义与角色

### 1、定义

GoF 工厂方法（Factory Method）的定义：定义一个用于创建对象的接口，**让子类决定实例化哪一个类**，使一个类的实例化延迟到其子类。

![工厂方法模式的角色](../assets/patterns/factory-method-class.svg)

| 角色 | 职责 |
|------|------|
| Product（产品） | 工厂方法所创建对象的接口 |
| ConcreteProduct（具体产品） | 实现 Product |
| Creator（创建者） | 声明工厂方法 `createProduct()`，通常还有自己的业务方法，业务方法内部调用工厂方法拿到产品 |
| ConcreteCreator（具体创建者） | 重写工厂方法，返回某个具体产品 |

关键点：Creator 不只是「造东西的工厂」，它本身有业务逻辑，只把「用哪个产品」这一步留给子类决定。

### 2、三种「工厂」

| 名称 | 是否 GoF 23 种之一 | 形式 |
|------|------------------|------|
| 简单工厂 | 否，是一种编程习惯 | 一个类里用 `switch` / `if` 按参数决定创建哪个产品 |
| 工厂方法 | 是 | 父类定义工厂方法，子类重写决定产品 |
| 静态工厂方法 | 否，《Effective Java》第 1 条 | 用静态方法代替构造方法，如 `List.of`、`Integer.valueOf` |

---

## 二、实现（JDK 21）

### 1、简单工厂

```java
sealed interface Shape permits Circle, Rectangle {
    void draw();
}

record Circle() implements Shape {
    public void draw() { System.out.println("Drawing Circle"); }
}

record Rectangle() implements Shape {
    public void draw() { System.out.println("Drawing Rectangle"); }
}

final class ShapeFactory {
    private ShapeFactory() {}

    static Shape create(String type) {
        return switch (type) {
            case "circle"    -> new Circle();
            case "rectangle" -> new Rectangle();
            default -> throw new IllegalArgumentException("Unknown shape: " + type);
        };
    }
}

// 使用
Shape shape = ShapeFactory.create("circle");
shape.draw();   // Drawing Circle
```

新增一种图形就要改 `switch`，违反开闭原则。改成注册表即可只增不改：

```java
import java.util.Map;
import java.util.function.Supplier;

final class ShapeRegistry {
    private static final Map<String, Supplier<Shape>> CREATORS = Map.of(
            "circle", Circle::new,
            "rectangle", Rectangle::new);

    static Shape create(String type) {
        Supplier<Shape> s = CREATORS.get(type);
        if (s == null) throw new IllegalArgumentException("Unknown shape: " + type);
        return s.get();
    }
}
```

在 Spring 里更常见的做法是让所有实现都成为 Bean，注入 `Map<String, Shape>`（key 是 bean 名），由容器完成注册。

### 2、工厂方法

以「导出报表」为例：导出流程固定（查数据 → 写文件 → 记录日志），写成什么格式由子类决定。

```java
// Product
interface ReportWriter {
    byte[] write(List<String> rows);
}

// ConcreteProduct
final class CsvWriter implements ReportWriter {
    public byte[] write(List<String> rows) {
        return String.join("\n", rows).getBytes(StandardCharsets.UTF_8);
    }
}

final class JsonWriter implements ReportWriter {
    public byte[] write(List<String> rows) {
        String body = rows.stream().map(r -> "\"" + r + "\"").collect(Collectors.joining(",", "[", "]"));
        return body.getBytes(StandardCharsets.UTF_8);
    }
}

// Creator：有自己的业务方法 export()，只把「用哪个 Writer」留给子类
abstract class ReportExporter {
    public final byte[] export(List<String> rows) {
        ReportWriter writer = createWriter();          // 调用工厂方法
        byte[] bytes = writer.write(rows);
        System.out.println("exported " + bytes.length + " bytes");
        return bytes;
    }

    protected abstract ReportWriter createWriter();  // 工厂方法
}

// ConcreteCreator
final class CsvExporter extends ReportExporter {
    protected ReportWriter createWriter() { return new CsvWriter(); }
}

final class JsonExporter extends ReportExporter {
    protected ReportWriter createWriter() { return new JsonWriter(); }
}

// 使用
ReportExporter exporter = new CsvExporter();
exporter.export(List.of("a", "b"));
```

示例省略了 `java.util.*`、`java.util.stream.Collectors`、`java.nio.charset.StandardCharsets` 的 import。还有一种常见变体是「一个产品配一个工厂类」，Creator 只剩一个 `create()` 方法；这时它和 `Supplier<ReportWriter>` 没有区别，可以直接用 `CsvWriter::new` 这样的方法引用代替工厂类。

### 3、静态工厂方法

现代 Java 里最常见的「工厂」：

```java
List<String> names = List.of("a", "b");           // 返回不可变实现，具体类不暴露
Integer n = Integer.valueOf(100);                  // -128~127 返回缓存实例
LocalDate d = LocalDate.of(2026, 10, 9);
Optional<String> o = Optional.ofNullable(System.getenv("APP_ENV"));
EnumSet<DayOfWeek> weekend = EnumSet.of(DayOfWeek.SATURDAY, DayOfWeek.SUNDAY);
```

相比构造方法的好处：有名字（`ofNullable` 比构造方法更能表达意图）、可以返回缓存实例、可以返回子类型（`EnumSet.of` 按元素个数返回 `RegularEnumSet` 或 `JumboEnumSet`）。

---

## 三、JDK 与 Spring 中的应用

| 位置 | 属于 | 说明 |
|------|------|------|
| `Collection.iterator()` | 工厂方法 | `Collection` 声明 `iterator()`，`ArrayList`、`HashSet` 各自返回自己的 `Iterator` 实现 |
| `URLStreamHandlerFactory.createURLStreamHandler(String)` | 工厂方法 | 按协议名创建 `URLStreamHandler` |
| `Calendar.getInstance()`、`NumberFormat.getInstance()` | 静态工厂 | 按 Locale 返回不同子类 |
| `List.of`、`Integer.valueOf`、`EnumSet.of` | 静态工厂 | 见上一节 |
| `DriverManager.getConnection()` | 静态查找 | 遍历已注册的 `Driver` 找能处理该 URL 的那个，不是 GoF 工厂方法 |
| Spring `FactoryBean<T>` | 工厂方法 | 容器调用 `getObject()` 拿到真正的 Bean，如 MyBatis-Spring 的 `SqlSessionFactoryBean` |
| Spring `BeanFactory` / `ApplicationContext` | 容器 | 按名字或类型取 Bean，更接近服务定位器，不是 GoF 工厂方法 |
| SLF4J `LoggerFactory.getLogger()` | 静态工厂 | 委托给绑定的日志实现创建 `Logger` |

---

## 四、适用场景与常见坑

**适用场景**：

- 调用方不应知道具体实现类（返回接口、隐藏实现）
- 父类有固定流程，只有「创建哪个对象」这一步随子类变化
- 创建逻辑需要缓存、池化、按条件返回不同子类

**常见坑**：

- **类爆炸**：每加一个产品就加一个工厂类。产品创建很简单时用 `Supplier` 或方法引用即可
- **简单工厂的 `switch` 越写越长**：改成 `Map<String, Supplier<T>>` 注册表，或在 Spring 里注入 `Map<String, T>`
- **把 Creator 叫成「抽象工厂」**：工厂方法里的抽象角色叫 Creator；抽象工厂是另一种模式，负责一整族产品，见下一篇

---

## 五、与相近模式的区别

| 对比项 | 简单工厂 | 工厂方法 | 抽象工厂 |
|--------|---------|---------|---------|
| 扩展方式 | 改工厂里的分支 | 新增 Creator 子类 | 新增整族工厂 |
| 产品数量 | 一种产品的多个实现 | 一种产品 | 一族相关产品 |
| 依赖继承 | 否 | 是（子类重写工厂方法） | 否（对象组合） |
| 典型例子 | `ShapeFactory.create(type)` | `Collection.iterator()` | JDBC `Connection` |

---

## 小结

- 简单工厂不是 GoF 模式，一个类按参数分支创建；用注册表可去掉 `switch`
- 工厂方法的核心是 Creator：它有自己的业务流程，只把「创建哪个产品」交给子类
- 静态工厂方法（`List.of`、`Integer.valueOf`）是现代 Java 最常见的工厂形式
- 真实例子：`Collection.iterator()`、Spring `FactoryBean`；`DriverManager` 是静态查找，`BeanFactory` 是容器

## 参考资料

- Refactoring.Guru - Factory Method：[https://refactoring.guru/design-patterns/factory-method](https://refactoring.guru/design-patterns/factory-method)
- Spring Framework Reference - Customizing Instantiation Logic with a FactoryBean：[https://docs.spring.io/spring-framework/reference/core/beans/factory-extension.html](https://docs.spring.io/spring-framework/reference/core/beans/factory-extension.html)
- Java SE 21 API - Collection.iterator()：[https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/Collection.html](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/Collection.html)
- 《设计模式：可复用面向对象软件的基础》（GoF）、《Effective Java》第 3 版第 1 条

> 下一篇：[抽象工厂模式](./3_creational_abstract_factory) —— 一次创建一族相关对象，以及与工厂方法的分工。
