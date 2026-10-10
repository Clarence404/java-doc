---
description: 定义与角色、Comparator 与 lambda、枚举策略、Spring 注入策略表、策略工厂、适用场景与坑
---

# 策略模式

> 前置阅读：[状态模式](./19_behavioral_state)

策略模式把一组可互换的算法封装起来、由客户端选择。本篇讲 lambda 与枚举写法、Spring 中注入 `List` / `Map` 组装策略表，以及非 Spring 环境下的策略工厂。

---

## 一、定义与角色

GoF 的定义：定义一系列算法，把它们分别封装起来，并且使它们可以相互替换，让算法可以独立于使用它的客户端而变化。

![策略模式的角色](../assets/patterns/strategy_structure.svg)

| 角色 | 职责 | 示例中的类 |
|------|------|-----------|
| Context | 持有策略，对外提供业务方法，不关心具体算法 | `PayService` |
| Strategy | 算法的统一接口 | `PayStrategy` |
| ConcreteStrategy | 某一种具体算法 | `WechatPay`、`AliPay` |

JDK 和框架里的例子：

| 例子 | Strategy 接口 | 谁来选择 |
|------|---------------|----------|
| `List.sort` / `Collections.sort` | `Comparator` | 调用方传入比较器 |
| `ThreadPoolExecutor` 拒绝策略 | `RejectedExecutionHandler` | 构造线程池时指定，见 [线程池](/java/28_topic_thread_pool) |
| Spring Security 认证 | `AuthenticationProvider` | `ProviderManager` 按 `supports()` 找到能处理当前凭证的实现 |
| Spring Bean 实例化 | `InstantiationStrategy` | Bean 工厂持有一个策略实例，可通过 `setInstantiationStrategy` 替换 |

---

## 二、最轻量的策略：Comparator 与 lambda

策略接口如果只有一个方法，它就是函数式接口，每个具体策略就是一个 lambda，不需要单独写类。`Comparator` 是最典型的例子：

```java
record User(String name, int age) {}

List<User> users = new ArrayList<>(List.of(
        new User("Carol", 30), new User("alice", 25), new User("Bob", 30)));

users.sort(Comparator.comparingInt(User::age));                     // 按年龄
users.sort(Comparator.comparingInt(User::age)
                     .thenComparing(User::name));                   // 年龄相同再按姓名
users.sort(Comparator.comparing(User::name, String.CASE_INSENSITIVE_ORDER)
                     .reversed());                                  // 姓名忽略大小写倒序
```

不要手写 `(a, b) -> a.age() - b.age()`，差值可能溢出，用 `Comparator.comparingInt` 或 `Integer.compare`。

---

## 三、枚举 + lambda：固定的一组策略

策略种类固定、不需要依赖注入时，把策略直接写在枚举常量里，取值、遍历、持久化都方便：

```java
public enum LogFormat {
    TEXT((level, msg) -> level + ": " + msg),
    JSON((level, msg) -> "{\"level\":\"" + level + "\",\"message\":\"" + msg + "\"}"),
    XML((level, msg) -> "<log><level>" + level + "</level><message>" + msg + "</message></log>");

    private final BinaryOperator<String> formatter;

    LogFormat(BinaryOperator<String> formatter) {
        this.formatter = formatter;
    }

    public String format(String level, String message) {
        return formatter.apply(level, message);
    }
}

// 使用：配置里存枚举名即可
LogFormat format = LogFormat.valueOf("JSON");
System.out.println(format.format("INFO", "系统启动成功"));
```

示例为了简短直接拼接字符串，消息里有引号、`<` 等字符时会生成非法的 JSON / XML，生产代码用 Jackson 等库序列化。

---

## 四、Spring：注入策略表

Spring 项目里最常用的写法：每个策略是一个 Bean，自己声明处理哪种类型；Context 通过构造器注入 `List<PayStrategy>`，启动时建好查找表。新增支付方式只加一个类，`PayService` 不用改。

```java
public enum PayType { WECHAT, ALIPAY }

public record PayResult(String orderId, String channel, boolean success) {}

public interface PayStrategy {
    PayType type();                                  // 声明自己处理哪种支付方式
    PayResult pay(String orderId, BigDecimal amount);
}

@Component
class WechatPay implements PayStrategy {
    @Override public PayType type() { return PayType.WECHAT; }
    @Override public PayResult pay(String orderId, BigDecimal amount) {
        // … 调用微信支付
        return new PayResult(orderId, "wechat", true);
    }
}

@Component
class AliPay implements PayStrategy {
    @Override public PayType type() { return PayType.ALIPAY; }
    @Override public PayResult pay(String orderId, BigDecimal amount) {
        // … 调用支付宝
        return new PayResult(orderId, "alipay", true);
    }
}

@Service
public class PayService {
    private final Map<PayType, PayStrategy> strategies;

    public PayService(List<PayStrategy> list) {
        this.strategies = list.stream().collect(Collectors.toMap(
                PayStrategy::type,
                Function.identity(),
                (a, b) -> { throw new IllegalStateException("重复的支付策略：" + a.type()); },
                () -> new EnumMap<>(PayType.class)));
    }

    public PayResult pay(PayType type, String orderId, BigDecimal amount) {
        PayStrategy strategy = strategies.get(type);
        if (strategy == null) {
            throw new IllegalArgumentException("不支持的支付方式：" + type);
        }
        return strategy.pay(orderId, amount);
    }
}
```

另一种写法是直接注入 `Map<String, PayStrategy>`，Spring 会以 **Bean 名称**为 key 填充。它更省代码，但 key 依赖 Bean 命名，改类名就会改变 key；用 `type()` 自描述更稳妥，还能在启动时发现重复注册。

策略不是按枚举一一对应、而是按条件匹配时（如按金额区间、按用户等级），把 `type()` 换成 `boolean supports(PayRequest req)`，遍历列表找第一个支持的策略。

---

## 五、非 Spring 环境：策略工厂

没有容器时，用一个工厂类维护注册表。要支持运行时注册，就提供 `register` 方法并使用线程安全的 Map；查不到时抛异常，不要返回 `null` 让调用方在别处 NPE：

```java
public final class PayStrategies {
    private static final Map<PayType, PayStrategy> REGISTRY = new ConcurrentHashMap<>();

    static {
        register(new WechatPay());
        register(new AliPay());
    }

    private PayStrategies() {}

    public static void register(PayStrategy strategy) {
        REGISTRY.put(strategy.type(), strategy);
    }

    public static PayStrategy of(PayType type) {
        PayStrategy strategy = REGISTRY.get(type);
        if (strategy == null) {
            throw new IllegalArgumentException("不支持的支付方式：" + type);
        }
        return strategy;
    }
}
```

几种组织方式对比：

| 方式 | 适合 | 新增策略要改哪里 | 运行时注册 |
|------|------|------------------|-----------|
| lambda 直接传入 | 一次性的算法，如排序规则 | 调用处 | 不涉及 |
| 枚举 + lambda | 种类固定、无外部依赖 | 枚举 | 不支持 |
| Spring 注入策略表 | 策略需要依赖其他 Bean | 只加一个 Bean | 不需要（启动时组装） |
| 策略工厂 | 非 Spring 环境、插件式扩展 | 注册一次 | 支持 |

---

## 六、适用场景与坑

适合：

- 同一件事有多种做法，并且要在运行时根据参数、配置选择（支付渠道、导出格式、计费规则、路由算法）
- 一长串 `if-else` / `switch` 按类型分支，每个分支逻辑都不少

坑：

- **类数量膨胀**：策略只有几行代码时，lambda 或枚举就够了，不必每个都建类
- **客户端仍需知道有哪些策略**：选择逻辑要集中在一处（工厂或注入表），不要在各个调用方重复判断
- **策略之间共享状态**：策略对象通常是单例，不要在字段里存请求级数据
- **分支其实很少变**：只有两三个稳定分支时，一个 `switch` 表达式更直接，不必为了模式而模式

和模板方法的区别见 [模板方法模式](./21_behavioral_template_method)；和状态模式的区别见 [状态模式](./19_behavioral_state)。

---

## 小结

- 策略 = 一组可互换的算法 + 由客户端选择；单方法策略直接用 lambda，`Comparator` 是最典型的例子
- 种类固定用枚举 + lambda；Spring 里让策略 Bean 声明 `type()`，构造器注入 `List` 后组装成 `EnumMap`
- 策略工厂查不到时抛异常；需要运行时注册就提供 `register` 并用线程安全的 Map
- 分支少且稳定时不必引入策略模式

## 参考资料

- Refactoring.Guru Strategy：[https://refactoring.guru/design-patterns/strategy](https://refactoring.guru/design-patterns/strategy)
- Java SE 21 `Comparator`：[https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/Comparator.html](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/Comparator.html)
- Spring Framework Autowiring Collections：[https://docs.spring.io/spring-framework/reference/core/beans/annotation-config/autowired.html](https://docs.spring.io/spring-framework/reference/core/beans/annotation-config/autowired.html)
- Spring Security Authentication Architecture（ProviderManager / AuthenticationProvider）：[https://docs.spring.io/spring-security/reference/servlet/authentication/architecture.html](https://docs.spring.io/spring-security/reference/servlet/authentication/architecture.html)

> 下一篇：[模板方法模式](./21_behavioral_template_method) —— final 模板与钩子、JDK 经典例子、模板 + 回调。
