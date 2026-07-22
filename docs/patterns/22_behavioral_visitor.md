# 访问者模式

**作用**：在**不修改元素类**的前提下，定义作用于这些元素的新操作（将操作与数据结构分离）。

**应用场景**：
- AST（抽象语法树）处理：编译器对各种节点类型执行不同操作（类型检查、代码生成）
- XML/JSON 文档遍历处理
- Spring `BeanDefinitionVisitor`：遍历 BeanDefinition 进行属性替换
- 报表导出：对同一份数据结构生成 Excel、PDF 等不同格式

---

## 一、实现示例

以「费用报告导出」为例：

```java
// 元素接口：接受访问者
public interface ExpenseItem {
    void accept(ExpenseVisitor visitor);
    String getDescription();
    BigDecimal getAmount();
}

// 具体元素
public class TravelExpense implements ExpenseItem {
    private final String description;
    private final BigDecimal amount;
    private final String destination;

    // constructor + getters...

    @Override
    public void accept(ExpenseVisitor visitor) {
        visitor.visit(this);
    }
    public String getDestination() { return destination; }
}

public class MealExpense implements ExpenseItem {
    private final String description;
    private final BigDecimal amount;
    private final int headCount;

    @Override
    public void accept(ExpenseVisitor visitor) { visitor.visit(this); }
    public int getHeadCount() { return headCount; }
}

// 访问者接口：对每种元素定义操作
public interface ExpenseVisitor {
    void visit(TravelExpense expense);
    void visit(MealExpense expense);
}

// 具体访问者 1：汇总金额
public class TotalCalculator implements ExpenseVisitor {
    private BigDecimal total = BigDecimal.ZERO;

    @Override
    public void visit(TravelExpense e) { total = total.add(e.getAmount()); }

    @Override
    public void visit(MealExpense e)   { total = total.add(e.getAmount()); }

    public BigDecimal getTotal() { return total; }
}

// 具体访问者 2：导出审计报告
public class AuditReportVisitor implements ExpenseVisitor {
    private final StringBuilder report = new StringBuilder();

    @Override
    public void visit(TravelExpense e) {
        report.append(String.format("[差旅] %s → %s: ¥%.2f%n",
            e.getDescription(), e.getDestination(), e.getAmount()));
    }

    @Override
    public void visit(MealExpense e) {
        report.append(String.format("[餐费] %s（%d人）: ¥%.2f%n",
            e.getDescription(), e.getHeadCount(), e.getAmount()));
    }

    public String getReport() { return report.toString(); }
}

// 使用：同一数据，两个访问者各自处理
List<ExpenseItem> items = List.of(
    new TravelExpense("北京出差", new BigDecimal("1200"), "北京"),
    new MealExpense("客户晚宴", new BigDecimal("800"), 5)
);

TotalCalculator calculator = new TotalCalculator();
AuditReportVisitor auditor = new AuditReportVisitor();

items.forEach(item -> {
    item.accept(calculator);
    item.accept(auditor);
});

System.out.println("总金额: " + calculator.getTotal());
System.out.println(auditor.getReport());
```

---

## 二、优缺点

| 维度 | 说明 |
|------|------|
| 优点 | 新增操作只需新增访问者类，不改元素；操作集中，逻辑清晰 |
| 缺点 | 新增元素类型需修改所有访问者接口，不适合元素类型频繁变化 |
| 适用场景 | 元素类型**稳定**、操作**多变**的场景 |
