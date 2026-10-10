---
description: 纯责任链与管道、审批链、FilterChain 写法、Spring Security 与 Netty Pipeline
---

# 责任链模式

> 前置阅读：[代理模式](./12_structural_proxy)

责任链模式（Chain of Responsibility）把多个处理者串成一条链，请求沿链传递，每个处理者决定自己处理还是交给下一个，发送者只认识链头。本篇讲「纯责任链 / 管道」两种变体、审批链与 Filter 风格链的写法，以及 Servlet、Spring Security、Spring MVC 和 Netty 里的责任链。

---

## 一、定义与角色

### 1、角色

![责任链模式的角色（报销审批）](../assets/patterns/chain_of_responsibility.svg)

| 角色 | 本篇示例 | 职责 |
|------|----------|------|
| Handler（抽象处理者） | `Approver` | 定义处理方法，持有下一个处理者 `next` |
| ConcreteHandler（具体处理者） | `TeamLeaderApprover` 等 | 能处理就处理，否则交给 `next` |
| Client（客户端） | 提交报销的代码 | 组装链，把请求交给链头 |

### 2、两种变体

![纯责任链与管道式责任链](../assets/patterns/chain_pure_vs_pipeline.svg)

| 变体 | 传递规则 | 典型例子 |
|------|----------|----------|
| 纯责任链（GoF 原始定义） | 某个处理者处理后就**结束**，后面的处理者收不到请求 | 审批流、异常处理器查找、按类型找解析器 |
| 管道（Pipeline） | 每个处理者都执行自己的逻辑，再**主动调用**下一个；也可以中途不调用来拦截请求 | Servlet Filter、Spring Security 过滤器链、Netty `ChannelPipeline` |

框架里见到的「责任链」大多是管道式。两者的共同点是：处理者之间只通过「下一个」耦合，彼此不知道对方的存在。

---

## 二、实现

### 1、纯责任链：报销审批

组长、经理、总监的审批额度递增，谁的额度够谁审批，审批完即结束：

```java
public record Expense(String applicant, BigDecimal amount) {}

public abstract class Approver {
    private Approver next;

    // 返回 next，便于链式组装
    public Approver linkWith(Approver next) {
        this.next = next;
        return next;
    }

    public final String approve(Expense expense) {
        if (expense.amount().compareTo(limit()) <= 0) {
            return role() + "审批通过：" + expense.applicant() + " " + expense.amount() + " 元";
        }
        if (next == null) {
            throw new IllegalStateException("超出所有审批人额度：" + expense.amount());
        }
        return next.approve(expense);
    }

    protected abstract String role();
    protected abstract BigDecimal limit();
}

public class TeamLeaderApprover extends Approver {
    @Override protected String role() { return "组长"; }
    @Override protected BigDecimal limit() { return new BigDecimal("1000"); }
}

public class ManagerApprover extends Approver {
    @Override protected String role() { return "经理"; }
    @Override protected BigDecimal limit() { return new BigDecimal("5000"); }
}

public class DirectorApprover extends Approver {
    @Override protected String role() { return "总监"; }
    @Override protected BigDecimal limit() { return new BigDecimal("20000"); }
}
```

```java
Approver chain = new TeamLeaderApprover();
chain.linkWith(new ManagerApprover())
     .linkWith(new DirectorApprover());

System.out.println(chain.approve(new Expense("张三", new BigDecimal("3000"))));
// 经理审批通过：张三 3000 元
```

链尾没人能处理时要有明确结果（这里抛异常），否则请求会被静默丢弃。

### 2、管道：Servlet Filter 风格

管道式的链通常不让处理者互相持有引用，而是把一个「链对象」传给每个处理者，由处理者决定是否调用 `chain.proceed` 继续。Servlet 的 `FilterChain` 和 Spring Security 的 `VirtualFilterChain` 都是这个结构：

```java
public record Request(String path, String token) {}

@FunctionalInterface
public interface Filter {
    void doFilter(Request request, FilterChain chain);
}

public final class FilterChain {
    private final List<Filter> filters;
    private final Consumer<Request> target;   // 链的终点：真正的业务处理
    private int index;

    public FilterChain(List<Filter> filters, Consumer<Request> target) {
        this.filters = List.copyOf(filters);
        this.target = target;
    }

    public void proceed(Request request) {
        if (index < filters.size()) {
            filters.get(index++).doFilter(request, this);
        } else {
            target.accept(request);
        }
    }
}
```

```java
Filter logging = (req, chain) -> {
    System.out.println("请求 " + req.path());
    chain.proceed(req);                          // 放行
    System.out.println("完成 " + req.path());     // proceed 返回后可做后置处理
};
Filter auth = (req, chain) -> {
    if (req.token() == null) {
        System.out.println("401 未登录");          // 不调用 proceed，请求在此被拦截
        return;
    }
    chain.proceed(req);
};

new FilterChain(List.of(logging, auth), req -> System.out.println("执行业务 " + req.path()))
        .proceed(new Request("/orders", "t-123"));
```

`FilterChain` 带有游标状态，每个请求都要新建一个。

### 3、更轻的写法：处理者列表

如果每个处理者都必须执行、也不需要后置处理，直接用列表循环即可，不必建链。Spring 中注入 `List<接口>` 会按 `@Order` 排序：

```java
public record PlaceOrderRequest(long userId, long productId, int qty) {}

public interface OrderValidator {
    void validate(PlaceOrderRequest req);   // 不通过就抛异常
}

@Service
public class OrderValidationService {
    private final List<OrderValidator> validators;

    public OrderValidationService(List<OrderValidator> validators) {
        this.validators = validators;
    }

    public void validate(PlaceOrderRequest req) {
        validators.forEach(v -> v.validate(req));
    }
}
```

新增一条校验规则只需要新增一个 `OrderValidator` Bean。

---

## 三、JDK 与 Spring 中的应用

| 例子 | 所属 | 链怎么传递 |
|------|------|-----------|
| `FilterChain.doFilter` | Servlet API（`jakarta.servlet`） | 每个 `Filter` 调用 `chain.doFilter(req, resp)` 放行，不调用即拦截 |
| `FilterChainProxy` → `SecurityFilterChain` | Spring Security | `FilterChainProxy` 作为一个 Servlet Filter 挂进容器，按请求匹配一条 `SecurityFilterChain`，再用内部的 `VirtualFilterChain` 依次执行其中的安全过滤器，见 [Spring Security](/spring/9_security#_1、过滤器链) |
| `HandlerExecutionChain` | Spring MVC | 依次调用拦截器的 `preHandle`，任何一个返回 `false` 就中断，见 [MVC](/spring/3_mvc#_3、filter-与-handlerinterceptor) |
| `ChannelPipeline` | Netty | 每个 `ChannelHandler` 处理完后调用 `ctx.fireChannelRead(msg)` 交给下一个入站处理器，见 [Pipeline 与 Handler](/netty/5_pipeline_handler) |
| `HandlerExceptionResolverComposite` | Spring MVC | 依次询问异常解析器，第一个返回非空结果的负责处理，属于纯责任链 |

---

## 四、适用场景与常见坑

适合用责任链的场景：

- 多个对象都可能处理同一个请求，具体由谁处理在运行时决定（审批、异常处理）
- 请求要经过一系列可插拔的步骤（鉴权、限流、日志、参数校验）
- 希望新增或调整处理步骤时不改调用方代码

常见坑：

- **请求无人处理**：纯责任链走到链尾仍没人处理，要么抛异常，要么有兜底处理者，不能静默返回
- **忘记放行**：管道式过滤器忘了调用 `chain.doFilter`，请求既不报错也到不了业务代码，表现为空响应
- **顺序依赖**：鉴权必须在业务日志之前、解码必须在业务处理器之前，顺序要显式声明（`@Order`、`addLast` 的顺序），不要依赖 Bean 的加载顺序
- **链成环**：手动 `setNext` 组装时把后面的节点又指回前面，会无限递归
- **调用栈很深**：管道式链是一层层嵌套调用，过滤器多时异常栈很长，排查时要从栈底往上看

---

## 五、与相近模式的区别

| 模式 | 请求交给谁 | 能否中途停止 | 典型场景 |
|------|-----------|-------------|----------|
| 责任链 | 按顺序逐个传递 | 能，处理者可以不传给下一个 | 审批、过滤器、拦截器 |
| [装饰器](./9_structural_decorator) | 层层包装，总是转发给内层 | 一般不会 | 叠加功能 |
| [观察者](./18_behavioral_observer) | 广播给所有订阅者，彼此独立 | 不能，一个订阅者无法阻止其他订阅者 | 事件通知 |
| [命令](./14_behavioral_command) | 封装成对象交给调用者执行 | 不涉及 | 排队、撤销、异步执行 |

管道式责任链和装饰器在代码上很像：每层都可以在调用下一层前后做事。区别在于链里的节点可以**拦截**请求不往下传，而装饰器的目的是增强，正常情况下总会调用被装饰对象。

---

## 小结

- 责任链把处理者串成链，发送者只认识链头，处理者只认识下一个
- 纯责任链是「谁能处理谁处理，处理完即结束」；管道是「每个处理者都执行，再决定是否放行」，框架中大多是管道
- 管道式的标准写法是把链对象传给处理者，由它调用 `proceed` / `doFilter` 放行；只需逐个执行时，用 `List` 循环最简单
- Servlet `FilterChain`、Spring Security `FilterChainProxy`、Spring MVC `HandlerExecutionChain`、Netty `ChannelPipeline` 都是责任链
- 注意链尾无人处理、忘记放行、顺序依赖和成环

## 参考资料

- Refactoring Guru：Chain of Responsibility：[https://refactoring.guru/design-patterns/chain-of-responsibility](https://refactoring.guru/design-patterns/chain-of-responsibility)
- Erich Gamma 等：《设计模式：可复用面向对象软件的基础》，Chain of Responsibility 一章
- Spring Security Reference：Architecture：[https://docs.spring.io/spring-security/reference/servlet/architecture.html](https://docs.spring.io/spring-security/reference/servlet/architecture.html)
- Netty API：ChannelPipeline：[https://netty.io/4.1/api/io/netty/channel/ChannelPipeline.html](https://netty.io/4.1/api/io/netty/channel/ChannelPipeline.html)

> 下一篇：[命令模式](./14_behavioral_command) —— 把请求封装成对象、撤销与补偿、Runnable 与线程池、命令与策略的区别。
