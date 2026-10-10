---
description: 叶子与容器统一接口、安全组合 vs 透明组合、parent_id 建树、CompositeCacheManager
---

# 组合模式

> 前置阅读：[设计模式总览](./0_overview)

组合模式（Composite）把对象组织成**树形结构**，让叶子和容器实现同一接口，客户端统一调用，文件与目录、菜单与子菜单都是这种「整体与部分」关系。本篇讲三个角色、安全 / 透明两种写法、JDK 21 菜单树与从 `parent_id` 建树，以及 JDK 与 Spring 中的组合结构。

---

## 一、定义与角色

![组合模式的角色（菜单树）](../assets/patterns/composite.svg)

| 角色 | 本篇示例 | 职责 |
|------|----------|------|
| Component（组件） | `MenuItem` | 叶子和容器的统一接口 |
| Leaf（叶子） | `MenuLeaf` | 没有子节点，直接完成操作 |
| Composite（容器） | `MenuGroup` | 持有子节点列表，把操作递归地交给子节点 |
| Client（客户端） | 调用方 | 只依赖 `MenuItem`，不关心节点类型 |

组合模式有两种写法，区别在于「增删子节点」的方法放在哪里：

| 写法 | `add` / `remove` 放在哪 | 优点 | 缺点 |
|------|------------------------|------|------|
| 透明组合 | Component 接口 | 客户端完全不用区分叶子和容器 | 叶子也有 `add`，只能空实现或抛 `UnsupportedOperationException` |
| 安全组合 | 只放在 Composite | 类型安全，叶子不会被误加子节点 | 客户端建树时要知道自己拿的是容器 |

业务代码一般选**安全组合**：建树的代码本来就知道哪些是菜单组，而「叶子上调用 add 抛异常」这种错误只能在运行时发现。本篇示例就是安全组合。

---

## 二、实现

### 1、菜单树

JDK 21 下用 `sealed` 接口限定节点只有两种，叶子没有可变状态，直接写成 `record`（`sealed` 接口与实现类需在同一个包内）：

```java
import java.util.ArrayList;
import java.util.List;

public sealed interface MenuItem permits MenuLeaf, MenuGroup {
    String name();
    void print(String indent);
}

// 叶子：具体菜单项
public record MenuLeaf(String name, String url) implements MenuItem {
    @Override
    public void print(String indent) {
        System.out.println(indent + "- " + name + " [" + url + "]");
    }
}

// 容器：子菜单
public final class MenuGroup implements MenuItem {
    private final String name;
    private final List<MenuItem> children = new ArrayList<>();

    public MenuGroup(String name) {
        this.name = name;
    }

    public MenuGroup add(MenuItem item) {
        children.add(item);
        return this;
    }

    public void remove(MenuItem item) {
        children.remove(item);
    }

    // 返回只读副本，外部不能绕过 add / remove 改树
    public List<MenuItem> children() {
        return List.copyOf(children);
    }

    @Override
    public String name() {
        return name;
    }

    @Override
    public void print(String indent) {
        System.out.println(indent + "+ " + name);
        children.forEach(c -> c.print(indent + "  "));
    }
}
```

客户端统一处理两类节点。新增的递归操作可以写在节点外，用模式匹配 `switch` 按类型分派，`sealed` 保证分支穷尽：

```java
public class MenuDemo {

    static int countLeaves(MenuItem item) {
        return switch (item) {
            case MenuLeaf leaf -> 1;
            case MenuGroup group -> group.children().stream()
                    .mapToInt(MenuDemo::countLeaves)
                    .sum();
        };
    }

    public static void main(String[] args) {
        MenuGroup root = new MenuGroup("系统管理")
                .add(new MenuGroup("用户管理")
                        .add(new MenuLeaf("用户列表", "/user/list"))
                        .add(new MenuLeaf("新增用户", "/user/add")))
                .add(new MenuGroup("角色管理")
                        .add(new MenuLeaf("角色列表", "/role/list")))
                .add(new MenuLeaf("系统日志", "/log"));

        root.print("");
        System.out.println("菜单项数量：" + countLeaves(root));
    }
}
```

输出：

```text
+ 系统管理
  + 用户管理
    - 用户列表 [/user/list]
    - 新增用户 [/user/add]
  + 角色管理
    - 角色列表 [/role/list]
  - 系统日志 [/log]
菜单项数量：4
```

### 2、从 parent_id 建内存树

数据库里的树通常存成 `id + parent_id` 的扁平表。正确做法是**一次查出全部行**，在内存里用 Map 建树，两次遍历即可，时间复杂度 O(n)：

```java
public record MenuRow(long id, Long parentId, String name, String url) {}

public static List<MenuItem> buildTree(List<MenuRow> rows) {
    // 第一遍：先把所有容器节点建出来（url 为空的是菜单组）
    Map<Long, MenuGroup> groups = new HashMap<>();
    for (MenuRow r : rows) {
        if (r.url() == null) {
            groups.put(r.id(), new MenuGroup(r.name()));
        }
    }
    // 第二遍：把每个节点挂到父节点下，找不到父节点的作为根
    List<MenuItem> roots = new ArrayList<>();
    for (MenuRow r : rows) {
        MenuItem node = r.url() == null ? groups.get(r.id()) : new MenuLeaf(r.name(), r.url());
        MenuGroup parent = r.parentId() == null ? null : groups.get(r.parentId());
        if (parent == null) {
            roots.add(node);
        } else {
            parent.add(node);
        }
    }
    return roots;
}
```

子节点顺序取决于 `rows` 的顺序，查询时按排序字段 `ORDER BY sort` 即可。

---

## 三、JDK 与 Spring 中的应用

| 类 | 组件接口 | 组合在做什么 |
|----|----------|--------------|
| `java.awt.Container` | `java.awt.Component` | 容器本身也是组件，可以嵌套放其他组件，布局和绘制递归进行 |
| Spring `CompositeCacheManager` | `CacheManager` | 持有多个 `CacheManager`，按顺序找第一个能提供该缓存的 |
| Spring `CompositePropertySource` | `PropertySource` | 把多个配置源合成一个，按顺序查找属性 |
| Spring MVC `HandlerMethodArgumentResolverComposite` | `HandlerMethodArgumentResolver` | 持有全部参数解析器，对外表现为一个解析器 |
| Spring Security `AuthorizationManagers.allOf(...)` / `anyOf(...)` | `AuthorizationManager` | 5.8 起提供，把多个授权规则组合成一个，全部通过或任一通过 |

Spring 里的 `XxxComposite` 大多只有一层（容器下面直接是叶子），用意是「对外假装只有一个」，让调用方不用写循环。

---

## 四、适用场景与常见坑

适合用组合模式的场景：

- 数据天然是树：菜单、部门、地区、商品类目、文件目录
- 希望对单个对象和一组对象执行同样的操作：求和、渲染、权限判断
- 需要把多个同类组件「合并成一个」对外提供，如上面的 `CompositeCacheManager`

常见坑：

- **环**：把某个节点加到它自己的子孙下面，递归会无限进行直到 `StackOverflowError`。从数据库建树时要校验 `parent_id` 不形成环，`add` 时也可以检查
- **层级过深**：递归深度等于树高，几千层的树可能栈溢出，此时改用显式栈（`ArrayDeque`）做迭代遍历
- **N+1 查询**：按层递归查库（查一次根、再对每个节点查子节点）会产生大量 SQL，应一次查出再在内存建树
- **暴露可变子节点列表**：`getChildren()` 直接返回内部 `ArrayList`，调用方可以绕过 `add` 改树，返回 `List.copyOf` 或只读视图

---

## 五、与相近模式的区别

| 模式 | 结构 | 意图 |
|------|------|------|
| 组合 | 容器持有**多个**同类子节点 | 让整体和部分被统一对待 |
| [装饰器](./9_structural_decorator) | 装饰器持有**一个**同类对象 | 在原对象外面叠加功能 |
| [迭代器](./15_behavioral_iterator) | 独立的遍历对象 | 遍历组合结构而不暴露其内部 |
| [访问者](./22_behavioral_visitor) | 操作与节点分离 | 不改节点类就能给整棵树加新操作 |

组合和装饰器都是「对象里套同类对象」的递归结构，区别在于子节点数量和目的：组合是为了**汇总**，装饰器是为了**增强**。

---

## 小结

- 组合模式让叶子和容器实现同一个接口，客户端统一处理整棵树
- 业务代码优先用安全组合：`add` / `remove` 只放在容器上；JDK 21 可用 `sealed` 接口加 `record` 叶子，再用模式匹配 `switch` 写递归操作
- 从 `parent_id` 建树要一次查出、内存中 O(n) 组装，避免按层递归查库
- 注意环、过深递归和暴露可变子节点列表这三个坑
- JDK 的 `Container` 和 Spring 的 `CompositeXxx`、`AuthorizationManagers.allOf / anyOf` 都是组合模式

## 参考资料

- Refactoring Guru：Composite：[https://refactoring.guru/design-patterns/composite](https://refactoring.guru/design-patterns/composite)
- Erich Gamma 等：《设计模式：可复用面向对象软件的基础》，Composite 一章
- Spring Framework Javadoc：CompositeCacheManager：[https://docs.spring.io/spring-framework/docs/current/javadoc-api/org/springframework/cache/support/CompositeCacheManager.html](https://docs.spring.io/spring-framework/docs/current/javadoc-api/org/springframework/cache/support/CompositeCacheManager.html)
- Spring Security Javadoc：AuthorizationManagers：[https://docs.spring.io/spring-security/reference/api/java/org/springframework/security/authorization/AuthorizationManagers.html](https://docs.spring.io/spring-security/reference/api/java/org/springframework/security/authorization/AuthorizationManagers.html)

> 下一篇：[装饰器模式](./9_structural_decorator) —— 用包装叠加功能、Java I/O 流、装饰器与代理的区别。
