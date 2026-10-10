---
description: 定义与角色、record 元素示例、双分派、JDK 与框架中的访问者、sealed + switch 替代方案
---

# 访问者模式

> 前置阅读：[组合模式](./8_structural_composite)、[版本演进](/java/2_version)

访问者模式把对元素的操作移到访问者类中，依赖双分派实现。本篇讲可编译的写法、`FileVisitor` / `ElementVisitor` / ASM 等真实用例，以及 JDK 21 sealed 接口 + 模式匹配 `switch` 的替代方案。

---

## 一、定义与角色

GoF 的定义：表示一个作用于某对象结构中各元素的操作，它使你可以在不改变各元素类的前提下，定义作用于这些元素的新操作。

| 角色 | 职责 | 示例中的类 |
|------|------|-----------|
| Visitor | 为每种元素声明一个 `visit` 重载 | `ExpenseVisitor<R>` |
| ConcreteVisitor | 一种具体操作，对每种元素各有实现 | `ReimbursableVisitor`、`AuditLineVisitor` |
| Element | 声明 `accept(visitor)` | `ExpenseItem` |
| ConcreteElement | 在 `accept` 里调用 `visitor.visit(this)` | `TravelExpense`、`MealExpense` |
| ObjectStructure | 元素的集合，负责遍历 | `List<ExpenseItem>`、AST、文件树 |

它适合「元素类型稳定、操作经常增加」的场景：编译器对同一棵语法树做类型检查、优化、代码生成；报表系统对同一份数据导出 Excel、PDF、审计日志。

---

## 二、实现示例：费用报销

元素用 record 实现，`visit` 带泛型返回值，访问者不必把结果存在可变字段里：

```java
public interface ExpenseVisitor<R> {
    R visit(TravelExpense expense);
    R visit(MealExpense expense);
}

public interface ExpenseItem {
    String description();
    BigDecimal amount();
    <R> R accept(ExpenseVisitor<R> visitor);
}

public record TravelExpense(String description, BigDecimal amount, String destination)
        implements ExpenseItem {
    @Override
    public <R> R accept(ExpenseVisitor<R> visitor) { return visitor.visit(this); }
}

public record MealExpense(String description, BigDecimal amount, int headCount)
        implements ExpenseItem {
    @Override
    public <R> R accept(ExpenseVisitor<R> visitor) { return visitor.visit(this); }
}

// 操作一：可报销金额（差旅全额，餐费每人最多 200）
public class ReimbursableVisitor implements ExpenseVisitor<BigDecimal> {
    private static final BigDecimal MEAL_CAP_PER_HEAD = new BigDecimal("200");

    @Override
    public BigDecimal visit(TravelExpense e) { return e.amount(); }

    @Override
    public BigDecimal visit(MealExpense e) {
        return e.amount().min(MEAL_CAP_PER_HEAD.multiply(BigDecimal.valueOf(e.headCount())));
    }
}

// 操作二：审计明细
public class AuditLineVisitor implements ExpenseVisitor<String> {
    @Override
    public String visit(TravelExpense e) {
        return "[差旅] %s -> %s：%s 元".formatted(e.description(), e.destination(), e.amount());
    }

    @Override
    public String visit(MealExpense e) {
        return "[餐费] %s（%d 人）：%s 元".formatted(e.description(), e.headCount(), e.amount());
    }
}

public class VisitorDemo {
    public static void main(String[] args) {
        List<ExpenseItem> items = List.of(
                new TravelExpense("北京出差", new BigDecimal("1200"), "北京"),
                new MealExpense("客户晚宴", new BigDecimal("1500"), 5));

        ReimbursableVisitor reimbursable = new ReimbursableVisitor();
        BigDecimal total = items.stream()
                .map(item -> item.accept(reimbursable))
                .reduce(BigDecimal.ZERO, BigDecimal::add);
        System.out.println("可报销：" + total);          // 1200 + min(1500, 1000) = 2200

        AuditLineVisitor audit = new AuditLineVisitor();
        items.stream().map(item -> item.accept(audit)).forEach(System.out::println);
    }
}
```

新增一种操作（如「按部门汇总」）只需新增一个 `ExpenseVisitor` 实现，元素类不用改。

---

## 三、双分派：为什么需要 accept

Java 的方法调用只有**单分派**：调用哪个对象的方法看运行时类型，但调用哪个**重载**由参数的**静态类型**在编译期决定。所以下面这行代码编译不过：

```java
ExpenseItem item = new TravelExpense("北京出差", new BigDecimal("1200"), "北京");
visitor.visit(item);   // 编译错误：没有 visit(ExpenseItem) 这个重载
```

访问者模式用两次虚方法调用凑出「按两个对象的运行时类型选择代码」的效果：

![访问者模式的双分派](../assets/patterns/visitor_double_dispatch.svg)

1. 第一次分派：`item.accept(visitor)` 是虚方法调用，根据 `item` 的运行时类型进入 `TravelExpense.accept`
2. 第二次分派：在 `TravelExpense.accept` 里，`this` 的静态类型就是 `TravelExpense`，编译期选中 `visit(TravelExpense)` 重载；而 `visitor.visit(...)` 本身又是虚方法调用，根据访问者的运行时类型进入 `ReimbursableVisitor` 或 `AuditLineVisitor` 的实现

这也解释了为什么每个元素都要写一遍看起来一模一样的 `accept`：`this` 的静态类型在每个类里不同，不能提到父类里共用。

---

## 四、JDK 与框架中的访问者

| 例子 | 元素结构 | 说明 |
|------|----------|------|
| `java.nio.file.FileVisitor` + `Files.walkFileTree` | 文件树 | `preVisitDirectory`、`visitFile`、`postVisitDirectory` 等回调 |
| `javax.lang.model.element.ElementVisitor` | 注解处理器看到的源码元素 | 按包、类型、方法、字段等元素种类分别处理 |
| ASM `ClassVisitor` / `MethodVisitor` | 字节码 | 读取或改写类文件，CGLIB 等字节码工具基于它 |
| Spring `BeanDefinitionVisitor` | Bean 定义中的属性值 | `PlaceholderConfigurerSupport` 用它遍历并解析 `${...}` 占位符 |

`FileVisitor` 的用法，统计目录下所有 `.java` 文件：

```java
Path root = Path.of("src");
List<Path> javaFiles = new ArrayList<>();

Files.walkFileTree(root, new SimpleFileVisitor<>() {
    @Override
    public FileVisitResult visitFile(Path file, BasicFileAttributes attrs) {
        if (file.toString().endsWith(".java")) {
            javaFiles.add(file);
        }
        return FileVisitResult.CONTINUE;
    }
});
```

这里的「元素」只有目录和文件两种，算是访问者的简化形式：遍历逻辑在 `Files.walkFileTree` 里，操作由访问者提供。

---

## 五、JDK 21 替代方案：sealed + 模式匹配 switch

访问者要解决的问题是「按元素的具体类型执行不同逻辑，且漏掉某种类型时要能发现」。JDK 21 的 sealed 接口加上 record 模式和 `switch` 模式匹配（JEP 440 / 441）可以直接做到，编译器会检查 `switch` 是否覆盖了所有子类型：

```java
public sealed interface Expense permits Travel, Meal {}
public record Travel(String description, BigDecimal amount, String destination) implements Expense {}
public record Meal(String description, BigDecimal amount, int headCount) implements Expense {}

static final BigDecimal MEAL_CAP_PER_HEAD = new BigDecimal("200");

static BigDecimal reimbursable(Expense e) {
    return switch (e) {
        case Travel t -> t.amount();
        case Meal(String desc, BigDecimal amount, int heads) ->
                amount.min(MEAL_CAP_PER_HEAD.multiply(BigDecimal.valueOf(heads)));
    };   // 没有 default：以后新增子类型，这里会编译失败
}
```

| 维度 | 经典访问者 | sealed + switch |
|------|------------|-----------------|
| 新增操作 | 新增一个访问者类 | 新增一个方法 |
| 新增元素类型 | 改访问者接口和所有实现 | 改所有 `switch`，编译器逐个指出 |
| 样板代码 | 每个元素一个 `accept`，每个访问者一组 `visit` | 几乎没有 |
| 元素层次是否需要封闭 | 不需要 | 需要（sealed），适合自己控制的类型 |
| 适合 | 第三方可扩展的框架 API（ASM、注解处理） | 业务代码、自己定义的 AST |

业务代码里优先用 sealed + switch；需要让外部代码扩展操作、而元素类型由框架定义时（如 ASM、注解处理器），访问者仍是合适的选择。

---

## 小结

- 访问者把「对元素的操作」移到访问者类里，元素类型稳定、操作经常增加时适用
- 核心机制是双分派：`accept` 按元素类型分派，`visit(this)` 再按访问者类型分派，重载由 `this` 的静态类型选定
- 真实用例：`FileVisitor`、`ElementVisitor`、ASM `ClassVisitor`、Spring `BeanDefinitionVisitor`
- JDK 21 下，自己定义的类型层次用 sealed 接口 + record 模式 `switch` 更简洁，编译器同样保证不漏类型

## 参考资料

- Refactoring.Guru Visitor：[https://refactoring.guru/design-patterns/visitor](https://refactoring.guru/design-patterns/visitor)
- JEP 440 Record Patterns：[https://openjdk.org/jeps/440](https://openjdk.org/jeps/440)
- JEP 441 Pattern Matching for switch：[https://openjdk.org/jeps/441](https://openjdk.org/jeps/441)
- Java SE 21 `FileVisitor`：[https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/nio/file/FileVisitor.html](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/nio/file/FileVisitor.html)
- Java SE 21 `ElementVisitor`：[https://docs.oracle.com/en/java/javase/21/docs/api/java.compiler/javax/lang/model/element/ElementVisitor.html](https://docs.oracle.com/en/java/javase/21/docs/api/java.compiler/javax/lang/model/element/ElementVisitor.html)

> 下一篇：[解释器模式](./23_behavioral_interpreter) —— record 语法树、解析与解释分离、正则与 SpEL、SpEL 注入。
