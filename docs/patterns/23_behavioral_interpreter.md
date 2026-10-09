---
description: record 语法树、解析与解释分离、正则与 SpEL、SpEL 注入与 SimpleEvaluationContext
---

# 解释器模式

> **本篇目标**：理解解释器模式「文法规则对应类、语法树递归求值」的结构，用 record 和 sealed 接口写出布尔表达式解释器及配套的小型解析器，认识 `Pattern`、SpEL 等现成的解释器，并知道对不可信输入求值 SpEL 时必须使用 `SimpleEvaluationContext`。
>
> **前置阅读**：[组合模式](./8_structural_composite)、[访问者模式](./22_behavioral_visitor)

---

## 一、定义与角色

GoF 的定义：给定一个语言，定义它的文法的一种表示，并定义一个解释器，用这个表示来解释语言中的句子。

文法里的每条规则对应一个类，一个句子被表示成由这些类的对象组成的语法树（AST），对根节点调用 `interpret` 就会递归地求出整个句子的值。它本质上是[组合模式](./8_structural_composite)加上一个递归求值的操作。

| 角色 | 职责 | 示例中的类型 |
|------|------|-------------|
| AbstractExpression | 声明 `interpret(context)` | `Expr` |
| TerminalExpression | 终结符，语法树的叶子 | `Var` |
| NonterminalExpression | 非终结符，组合子表达式 | `And`、`Or`、`Not` |
| Context | 解释时需要的外部信息 | `Map<String, Boolean>` 变量表 |

以权限规则 `(isAdmin OR isOwner) AND NOT isBanned` 为例，它的语法树如下：

![(isAdmin OR isOwner) AND NOT isBanned 的语法树](../assets/patterns/interpreter_ast.svg)

---

## 二、实现示例：布尔表达式

### 1、经典写法：每个节点自己解释

每种表达式是一个 record，各自实现 `interpret`，非终结符递归调用子表达式：

```java
public sealed interface Expr permits Var, And, Or, Not {
    boolean interpret(Map<String, Boolean> context);
}

public record Var(String name) implements Expr {
    @Override
    public boolean interpret(Map<String, Boolean> context) {
        return Boolean.TRUE.equals(context.get(name));   // 未定义的变量按 false 处理
    }
}

public record And(Expr left, Expr right) implements Expr {
    @Override
    public boolean interpret(Map<String, Boolean> context) {
        return left.interpret(context) && right.interpret(context);
    }
}

public record Or(Expr left, Expr right) implements Expr {
    @Override
    public boolean interpret(Map<String, Boolean> context) {
        return left.interpret(context) || right.interpret(context);
    }
}

public record Not(Expr expr) implements Expr {
    @Override
    public boolean interpret(Map<String, Boolean> context) {
        return !expr.interpret(context);
    }
}

public class InterpreterDemo {
    public static void main(String[] args) {
        // 手工构建 (isAdmin OR isOwner) AND NOT isBanned
        Expr rule = new And(
                new Or(new Var("isAdmin"), new Var("isOwner")),
                new Not(new Var("isBanned")));

        Map<String, Boolean> ctx = Map.of("isAdmin", false, "isOwner", true, "isBanned", false);
        System.out.println(rule.interpret(ctx));   // true
    }
}
```

### 2、JDK 21 写法：解释逻辑集中在 switch

如果节点类型固定、而要对语法树做的操作不止一种（求值、打印、化简），可以让 record 只存数据，把每种操作写成一个对 sealed 接口的 `switch`。这和 [访问者模式](./22_behavioral_visitor) 第五节是同一个思路：

```java
public sealed interface Node permits Node.Var, Node.And, Node.Or, Node.Not {
    record Var(String name)            implements Node {}
    record And(Node left, Node right)  implements Node {}
    record Or(Node left, Node right)   implements Node {}
    record Not(Node expr)              implements Node {}
}

static boolean eval(Node node, Map<String, Boolean> ctx) {
    return switch (node) {
        case Node.Var(String name)       -> Boolean.TRUE.equals(ctx.get(name));
        case Node.And(Node l, Node r)    -> eval(l, ctx) && eval(r, ctx);
        case Node.Or(Node l, Node r)     -> eval(l, ctx) || eval(r, ctx);
        case Node.Not(Node e)            -> !eval(e, ctx);
    };
}

static String print(Node node) {
    return switch (node) {
        case Node.Var(String name)       -> name;
        case Node.And(Node l, Node r)    -> "(" + print(l) + " AND " + print(r) + ")";
        case Node.Or(Node l, Node r)     -> "(" + print(l) + " OR " + print(r) + ")";
        case Node.Not(Node e)            -> "NOT " + print(e);
    };
}
```

---

## 三、解析与解释是两件事

解释器模式只负责「语法树怎么求值」，不负责「字符串怎么变成语法树」。上面的例子是手工构建语法树，实际使用时还需要一个解析器。文法如下（优先级 NOT 高于 AND 高于 OR）：

```text
expr   = term   { "OR"  term }
term   = factor { "AND" factor }
factor = "NOT" factor | "(" expr ")" | IDENT
```

小型文法可以手写递归下降解析器，每条文法规则对应一个方法：

```java
public final class ExprParser {
    private static final Pattern TOKEN = Pattern.compile("\\s*(\\(|\\)|[A-Za-z_]\\w*)");

    private final List<String> tokens = new ArrayList<>();
    private int pos;

    private ExprParser(String text) {
        Matcher m = TOKEN.matcher(text);
        int end = 0;
        while (m.lookingAt()) {
            tokens.add(m.group(1));
            end = m.end();
            m.region(end, text.length());
        }
        if (!text.substring(end).isBlank()) {
            throw new IllegalArgumentException("无法识别的输入：" + text.substring(end));
        }
    }

    public static Expr parse(String text) {
        ExprParser p = new ExprParser(text);
        Expr result = p.expr();
        if (p.pos != p.tokens.size()) {
            throw new IllegalArgumentException("多余的输入：" + p.tokens.get(p.pos));
        }
        return result;
    }

    private Expr expr() {                     // expr = term { OR term }
        Expr left = term();
        while (accept("OR")) left = new Or(left, term());
        return left;
    }

    private Expr term() {                     // term = factor { AND factor }
        Expr left = factor();
        while (accept("AND")) left = new And(left, factor());
        return left;
    }

    private Expr factor() {                   // factor = NOT factor | ( expr ) | IDENT
        if (accept("NOT")) return new Not(factor());
        if (accept("(")) {
            Expr inner = expr();
            if (!accept(")")) throw new IllegalArgumentException("缺少右括号");
            return inner;
        }
        if (pos >= tokens.size()) throw new IllegalArgumentException("表达式不完整");
        return new Var(tokens.get(pos++));
    }

    private boolean accept(String token) {
        if (pos < tokens.size() && tokens.get(pos).equals(token)) {
            pos++;
            return true;
        }
        return false;
    }
}

// 使用
Expr rule = ExprParser.parse("(isAdmin OR isOwner) AND NOT isBanned");
```

文法再复杂一些（运算符多、要报告友好的错误位置），就用 ANTLR 这类解析器生成器从文法文件生成解析器，自己只写语法树的解释部分。

---

## 四、JDK 与框架中的解释器

| 例子 | 说明 |
|------|------|
| `java.util.regex.Pattern` | `Pattern.compile` 把正则编译成内部的节点树，`Matcher` 匹配时沿着节点树逐个解释执行 |
| `java.text.MessageFormat` / `SimpleDateFormat` | 把格式模板解析成片段序列，格式化时逐段解释 |
| Logback `PatternLayout` | 把 `%d %-5level %logger - %msg%n` 解析成节点树，再转换成 Converter 链逐个输出 |
| Spring SpEL | `SpelExpressionParser` 把表达式解析成 AST（`SpelNode`），`getValue` 时递归求值 |
| 规则引擎（Drools、Easy Rules 等） | 把规则文本解析后在运行时求值 |

正则就是一个典型的解释器：同一个 `Pattern` 应编译一次后复用；某些写法（如 `(a+)+$`）在不匹配时会大量回溯，对用户输入的正则或长文本要警惕这类性能问题。

---

## 五、SpEL 与表达式注入

业务里需要可配置的规则时，通常直接用 SpEL 而不是手写解释器：

```java
ExpressionParser parser = new SpelExpressionParser();
Expression rule = parser.parseExpression("age >= 18 and !banned");

// 只读数据绑定：只能读取根对象的属性，不能调用任意方法、不能引用类型、不能 new 对象
EvaluationContext context = SimpleEvaluationContext.forReadOnlyDataBinding().build();
Boolean allowed = rule.getValue(context, user, Boolean.class);   // user 带 getAge() / isBanned()

if (Boolean.TRUE.equals(allowed)) {
    // … 放行
}
```

**安全警告**：`StandardEvaluationContext` 支持类型引用（`T(java.lang.Runtime)`）、构造对象、调用任意方法和引用 Bean。如果表达式内容来自用户输入（请求参数、请求头、可在后台编辑的规则），用它求值等于允许远程执行任意代码。Spring Cloud Function 的 CVE-2022-22963 就是把请求头里的路由表达式交给 `StandardEvaluationContext` 求值导致的。

- 表达式来自不可信来源时，只用 `SimpleEvaluationContext`
- 表达式由开发者写在代码或注解里（`@Value`、`@PreAuthorize`、`@Cacheable(key = ...)`）时，框架内部使用完整的上下文，这是可控的
- 返回值用 `Boolean` 接收，表达式结果为 `null` 时直接拆箱成 `boolean` 会抛 NPE

---

## 六、适用场景与坑

适合：

- 文法简单、规则需要由配置或运营人员维护的小型 DSL：权限规则、营销活动条件、告警条件
- 同一类表达式要被反复求值，且希望规则与代码解耦

坑：

- **文法复杂时类爆炸**：每条文法规则一个类，几十条规则就难以维护；复杂语言用 ANTLR 生成解析器，或直接嵌入现成的表达式语言
- **性能**：递归解释比编译后执行慢；热点路径上把解析结果（语法树、`Expression`、`Pattern`）缓存起来，不要每次都解析
- **安全**：对外开放的表达式能力要限制在只读、白名单范围内，见上一节

---

## 小结

- 解释器 = 文法规则对应类型 + 语法树递归求值，结构上是组合模式加一个解释操作
- JDK 21 下用 sealed 接口 + record 表示语法树；操作多时把求值、打印写成模式匹配 `switch`
- 解释器模式不包括解析，小文法手写递归下降，大文法用 ANTLR
- `Pattern`、`MessageFormat`、Logback `PatternLayout`、SpEL 都是解释器
- 对不可信输入求值 SpEL 必须用 `SimpleEvaluationContext`，否则会造成表达式注入

## 参考资料

- Gamma E. 等，《Design Patterns: Elements of Reusable Object-Oriented Software》，Addison-Wesley，1994
- Java SE 21 `Pattern`：[https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/regex/Pattern.html](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/regex/Pattern.html)
- Spring Framework SpEL Evaluation（SimpleEvaluationContext）：[https://docs.spring.io/spring-framework/reference/core/expressions/evaluation.html](https://docs.spring.io/spring-framework/reference/core/expressions/evaluation.html)
- CVE-2022-22963：[https://spring.io/security/cve-2022-22963](https://spring.io/security/cve-2022-22963)
- ANTLR：[https://www.antlr.org/](https://www.antlr.org/)

> 返回：[设计模式总览](./0_overview)
