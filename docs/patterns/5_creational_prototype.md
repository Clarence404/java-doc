---
description: 原型角色与注册表、clone 浅拷贝与深拷贝、复制构造方法、scope=prototype 不是原型模式
---

# 原型模式

> 前置阅读：[序列化](/java/19_topic_serialization)

原型模式通过复制已配置好的对象来创建新对象。本篇讲浅拷贝与深拷贝、为何推荐复制构造方法代替 `Cloneable`，以及 Spring `scope=prototype` 与原型模式的区别。

---

## 一、定义与角色

### 1、定义

GoF 的定义：用原型实例指定创建对象的种类，并且**通过复制这些原型**创建新的对象。

![原型模式的角色](../assets/patterns/prototype-class.svg)

| 角色 | 职责 |
|------|------|
| Prototype | 声明复制自身的方法（`copy()` / `clone()`） |
| ConcretePrototype | 实现复制，决定哪些字段共享、哪些字段要复制一份 |
| Client | 持有原型，需要新对象时让原型复制自己，不关心具体类 |

### 2、浅拷贝与深拷贝

- **浅拷贝**：逐字段复制，基本类型复制值，引用类型复制引用；副本和原对象共享引用指向的对象
- **深拷贝**：引用字段指向的可变对象也复制一份，副本和原对象互不影响

![浅拷贝与深拷贝的对象图](../assets/patterns/prototype-shallow-deep.svg)

---

## 二、实现（JDK 21）

### 1、Cloneable + clone()：默认是浅拷贝

```java
import java.util.ArrayList;
import java.util.List;

public class UserConfig implements Cloneable {
    private Long userId;
    private String theme;
    private List<String> permissions;

    public UserConfig(Long userId, String theme, List<String> permissions) {
        this.userId = userId;
        this.theme = theme;
        this.permissions = permissions;
    }

    public List<String> getPermissions() { return permissions; }

    @Override
    public UserConfig clone() {
        try {
            return (UserConfig) super.clone();      // Object.clone()：逐字段复制
        } catch (CloneNotSupportedException e) {
            throw new AssertionError(e);            // 已实现 Cloneable，不会发生
        }
    }
}

// 使用
UserConfig original = new UserConfig(1L, "dark", new ArrayList<>(List.of("read", "write")));
UserConfig copy = original.clone();
copy.getPermissions().add("admin");                // original 的 permissions 也多了 admin
```

### 2、在 clone() 里补上深拷贝

```java
@Override
public UserConfig clone() {
    try {
        UserConfig copy = (UserConfig) super.clone();
        copy.permissions = (permissions == null) ? null : new ArrayList<>(permissions);
        return copy;
    } catch (CloneNotSupportedException e) {
        throw new AssertionError(e);
    }
}
```

这要求 `permissions` 不能是 `final`：`clone()` 不走构造方法，`final` 字段在副本里没法重新赋值。这是 `Cloneable` 的固有缺陷之一。

### 3、复制构造方法 / 复制工厂（推荐）

```java
// 加在 UserConfig 里，不再需要 Cloneable
public UserConfig(UserConfig other) {
    this(other.userId, other.theme,
         other.permissions == null ? null : new ArrayList<>(other.permissions));
}

public static UserConfig copyOf(UserConfig other) {
    return new UserConfig(other);
}
```

《Effective Java》第 13 条的结论：除了数组，优先用复制构造方法或复制工厂。它们走正常的构造方法、可以给 `final` 字段赋值、不需要处理受检异常，也不用强制类型转换。

需要深拷贝复杂对象图时，「序列化再反序列化」能做但慢，且要求整棵对象图可序列化，取舍见 [序列化](/java/19_topic_serialization#六、序列化与深拷贝)。

### 4、原型注册表

原型模式真正有价值的场景：预先配置好若干「模板对象」，按 key 取出后复制一份再改。

```java
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

final class ReportTemplate {
    private final String title;
    private final List<String> columns;

    ReportTemplate(String title, List<String> columns) {
        this.title = title;
        this.columns = new ArrayList<>(columns);   // 构造时就复制，原型与副本互不影响
    }

    ReportTemplate copy() {
        return new ReportTemplate(title, columns);
    }

    ReportTemplate addColumn(String column) {
        columns.add(column);
        return this;
    }
}

final class TemplateRegistry {
    private final Map<String, ReportTemplate> prototypes = new HashMap<>();

    void register(String key, ReportTemplate prototype) {
        prototypes.put(key, prototype);
    }

    ReportTemplate create(String key) {
        ReportTemplate p = prototypes.get(key);
        if (p == null) throw new IllegalArgumentException("Unknown template: " + key);
        return p.copy();
    }
}

// 使用
TemplateRegistry registry = new TemplateRegistry();
registry.register("sales", new ReportTemplate("销售日报", List.of("日期", "订单数", "金额")));
ReportTemplate mine = registry.create("sales").addColumn("退款金额");   // 不影响原型
```

对于**不可变对象**（record、`List.copyOf` 的结果、`String`），根本不需要复制，直接共享同一个实例即可。

---

## 三、JDK 与 Spring 中的应用

| 位置 | 说明 |
|------|------|
| `Object.clone()` + `Cloneable` | JDK 提供的原型机制，默认浅拷贝 |
| `ArrayList.clone()`、`HashMap.clone()` | 返回浅拷贝：新容器，元素仍是同一批对象 |
| 数组 `clone()` | 复制数组最简洁的写法，《Effective Java》认为数组是 `clone()` 唯一适合的场景 |
| `new ArrayList<>(other)` 等复制构造方法 | 集合框架的通用复制方式 |
| Spring `AbstractBeanDefinition.cloneBeanDefinition()` | 复制一份 Bean 定义，`RootBeanDefinition` 中通过复制构造方法实现 |

两个常被误认为原型模式的例子：

- **Spring `scope=prototype`**：每次 `getBean` 都通过构造方法新建实例并重新做依赖注入，并没有复制谁，只是名字相同
- **`BeanUtils.copyProperties`**：在两个（可以不同类型的）对象之间做浅层属性复制，常用于 DTO 转换，不是复制原型

---

## 四、适用场景与常见坑

**适用场景**：

- 对象初始化代价高（要查库、解析配置），而多个对象只在少数字段上不同
- 需要一组预设模板（报表模板、邮件模板、游戏中的怪物配置），按模板派生新对象
- 运行时才知道要创建哪种对象，手里只有一个现成实例

**常见坑**：

- **以为 `clone()` 是深拷贝**：默认只复制引用，修改副本中的集合会影响原对象
- **复制时没处理 `null`**：`new ArrayList<>(null)` 直接抛 `NullPointerException`
- **`clone()` 与 `final` 字段冲突**：深拷贝需要给引用字段重新赋值，`final` 字段做不到
- **滥用序列化做深拷贝**：慢，且 Java 原生反序列化有安全风险；优先复制构造方法

---

## 五、与相近模式的区别

| 对比项 | 原型 | 工厂方法 | 建造者 |
|--------|------|---------|-------|
| 新对象从哪来 | 复制一个已有实例 | 子类 `new` 一个具体类 | 分步设置后 `build()` |
| 需要的类层次 | 不需要平行的工厂类 | 需要 Creator 层次 | 需要 Builder 类 |
| 适合 | 初始化昂贵、模板派生 | 隐藏具体类 | 参数多、可选项多 |

---

## 小结

- 原型模式通过复制已配置好的实例来创建对象，常配合原型注册表使用
- `Object.clone()` 默认浅拷贝；深拷贝要手动复制可变的引用字段，且与 `final` 字段冲突
- 优先用复制构造方法 / 复制工厂；不可变对象直接共享，不需要复制
- Spring `scope=prototype` 和 `BeanUtils.copyProperties` 都不是原型模式

## 参考资料

- Refactoring.Guru - Prototype：[https://refactoring.guru/design-patterns/prototype](https://refactoring.guru/design-patterns/prototype)
- Java SE 21 API - Object.clone()：[https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/lang/Object.html#clone()](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/lang/Object.html#clone())
- Spring Framework Reference - Bean Scopes：[https://docs.spring.io/spring-framework/reference/core/beans/factory-scopes.html](https://docs.spring.io/spring-framework/reference/core/beans/factory-scopes.html)
- 《设计模式：可复用面向对象软件的基础》（GoF）、《Effective Java》第 3 版第 13 条

> 下一篇：[适配器模式](./6_structural_adapter) —— 把不兼容的接口转换成客户端期望的接口。
