# 解释器模式

**作用**：为一种语言定义其**文法表示**，并提供一个解释器来处理该文法。

**应用场景**：
- Spring EL（SpEL）：`@Value("#{user.age > 18}")`
- Logback 日志格式模板解析
- SQL 解析器
- 正则表达式引擎
- 规则引擎（Drools、Easy Rules）

> 实际项目中极少从零实现解释器，通常使用现成的解析库。了解此模式有助于理解 SpEL、规则引擎等框架的设计原理。

---

## 一、实现示例

以「简单布尔表达式解释器」为例（支持 AND、OR、NOT）：

```java
// 抽象表达式
public interface BooleanExpression {
    boolean interpret(Map<String, Boolean> context);
}

// 终结符：变量
public class VariableExpression implements BooleanExpression {
    private final String name;

    public VariableExpression(String name) { this.name = name; }

    @Override
    public boolean interpret(Map<String, Boolean> context) {
        return Boolean.TRUE.equals(context.get(name));
    }
}

// 非终结符：AND
public class AndExpression implements BooleanExpression {
    private final BooleanExpression left;
    private final BooleanExpression right;

    public AndExpression(BooleanExpression left, BooleanExpression right) {
        this.left  = left;
        this.right = right;
    }

    @Override
    public boolean interpret(Map<String, Boolean> context) {
        return left.interpret(context) && right.interpret(context);
    }
}

// 非终结符：OR
public class OrExpression implements BooleanExpression {
    private final BooleanExpression left;
    private final BooleanExpression right;

    public OrExpression(BooleanExpression left, BooleanExpression right) {
        this.left  = left;
        this.right = right;
    }

    @Override
    public boolean interpret(Map<String, Boolean> context) {
        return left.interpret(context) || right.interpret(context);
    }
}

// 非终结符：NOT
public class NotExpression implements BooleanExpression {
    private final BooleanExpression expr;

    public NotExpression(BooleanExpression expr) { this.expr = expr; }

    @Override
    public boolean interpret(Map<String, Boolean> context) {
        return !expr.interpret(context);
    }
}

// 使用：构建表达式 (isAdmin OR isOwner) AND NOT isBanned
BooleanExpression expr = new AndExpression(
    new OrExpression(
        new VariableExpression("isAdmin"),
        new VariableExpression("isOwner")
    ),
    new NotExpression(
        new VariableExpression("isBanned")
    )
);

Map<String, Boolean> ctx = Map.of(
    "isAdmin",  false,
    "isOwner",  true,
    "isBanned", false
);

System.out.println(expr.interpret(ctx));  // true
```

---

## 二、Spring EL（SpEL）

实际项目中用 SpEL 代替手写解释器：

```java
ExpressionParser parser = new SpelExpressionParser();

// 解析简单表达式
Expression exp = parser.parseExpression("age > 18 and !banned");
EvaluationContext context = new StandardEvaluationContext(user);
boolean result = exp.getValue(context, Boolean.class);

// 用于 @PreAuthorize、@Value、@Cacheable key
@PreAuthorize("hasRole('ADMIN') or #userId == authentication.principal.id")
@GetMapping("/users/{userId}")
public UserVO getUser(@PathVariable Long userId) { ... }
```
