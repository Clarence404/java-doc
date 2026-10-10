---
description: 内部状态与外部状态、享元工厂、Integer 缓存与字符串常量池、享元 vs 对象池
---

# 享元模式

> 前置阅读：[外观模式](./10_structural_facade)

享元模式（Flyweight）把对象状态拆成可共享的**内部状态**和调用时传入的**外部状态**，通过共享大量重复的细粒度对象节省内存。本篇讲线程安全、有边界的享元工厂写法、JDK 里的享元，以及享元与对象池的区别。

---

## 一、定义与角色

![享元模式的角色（字体样式）](../assets/patterns/flyweight.svg)

| 角色 | 本篇示例 | 职责 |
|------|----------|------|
| Flyweight（享元） | `FontStyle` | 只保存内部状态，**不可变**，可被很多客户端同时共享 |
| FlyweightFactory（享元工厂） | `FontStyleFactory` | 维护缓存池，相同内部状态只创建一次 |
| Client（客户端） | 文本渲染代码 | 保存外部状态，使用时传给享元 |

| 状态 | 特点 | 本篇示例 |
|------|------|----------|
| 内部状态（Intrinsic） | 存在享元内部，可共享，不随使用场景变化 | 字体名、字号、颜色 |
| 外部状态（Extrinsic） | 由客户端保存，调用时作为参数传入 | 字符所在坐标、字符内容 |

---

## 二、实现

以文本渲染为例：一篇文档几万个字符，但字体样式只有寥寥几种。

```java
// 享元：只有内部状态，record 天然不可变
public record FontStyle(String fontName, int fontSize, String color) {

    // 外部状态（坐标、字符）通过参数传入，不保存在对象里
    public void render(StringBuilder canvas, int x, int y, char ch) {
        canvas.append(ch);   // 演示用；真实场景是按样式绘制到 (x, y)
    }
}

// 享元工厂
public final class FontStyleFactory {
    private static final Map<FontStyle, FontStyle> POOL = new ConcurrentHashMap<>();

    private FontStyleFactory() {}

    public static FontStyle get(String fontName, int fontSize, String color) {
        FontStyle key = new FontStyle(fontName, fontSize, color);
        return POOL.computeIfAbsent(key, k -> k);   // 已有就返回池中实例，没有就放入
    }

    public static int poolSize() {
        return POOL.size();
    }
}
```

```java
StringBuilder canvas = new StringBuilder();
for (int i = 0; i < 10_000; i++) {
    FontStyle font = FontStyleFactory.get("微软雅黑", 14, "#333333");
    font.render(canvas, i * 10, 0, (char) ('A' + i % 26));
}
System.out.println("享元实例数：" + FontStyleFactory.poolSize());   // 1
```

几个实现细节：

- 用 `record` 作为缓存 key，`equals` / `hashCode` 自动按全部字段生成，避免字符串拼接 key（`"a-b" + "-1"` 和 `"a" + "-b-1"`）撞车
- `computeIfAbsent` 保证并发下同一个 key 只放入一个实例
- 这个池没有上限，前提是内部状态的取值组合很少（字体样式只有几十种）。如果 key 的取值空间大，就要给池加上限，例如改用 [Caffeine](/cache/7_caffeine) 并设置 `maximumSize`

---

## 三、JDK 中的应用

```java
// Integer 缓存：默认缓存 -128 ~ 127
Integer x = Integer.valueOf(100);
Integer y = Integer.valueOf(100);
System.out.println(x == y);        // true，同一个缓存实例

Integer p = Integer.valueOf(200);
Integer q = Integer.valueOf(200);
System.out.println(p == q);        // 默认情况下为 false，超出缓存范围，各自新建
System.out.println(p.equals(q));   // true，包装类型比较值永远用 equals

// 字符串字面量：编译期进入字符串常量池，相同字面量共享同一个对象
String a = "hello";
String b = "hello";
System.out.println(a == b);        // true
```

| 例子 | 共享的实例 | 说明 |
|------|-----------|------|
| `Integer.valueOf` | 默认 -128 ~ 127 | 上界可用 `-XX:AutoBoxCacheMax=<size>` 调大，所以「200 不相等」只在默认配置下成立 |
| `Long`、`Short`、`Byte` 的 `valueOf` | -128 ~ 127 | 固定范围，不可配置 |
| `Character.valueOf` | 0 ~ 127 | ASCII 范围 |
| `Boolean.valueOf` | `TRUE` / `FALSE` 两个实例 | 不要 `new Boolean(...)`（已废弃） |
| 枚举常量 | 每个常量全局唯一 | 可以直接用 `==` 比较 |
| 字符串字面量 / `String.intern()` | 字符串常量池中的实例 | JDK 7 起常量池位于堆中，细节见 [String](/java/11_topic_string) 与 [内存结构](/jvm/1_memory) |

自动装箱（`Integer i = 100;`）调用的就是 `Integer.valueOf`，所以同样命中缓存。这些例子共同的前提是：**被共享的对象都不可变**。

---

## 四、适用场景与常见坑

适合用享元的场景：

- 系统中存在**大量**相似对象，内存占用已经成为问题
- 对象的大部分状态可以抽出来共享，剩下的少量状态能由调用方保存
- 例如：文本编辑器的字符样式、游戏地图里的树木和子弹贴图、棋盘上的棋子类型、商品的规格模板

常见坑：

- **享元可变**：共享对象一旦有 setter，一个客户端改了样式，所有使用者都受影响。享元必须不可变
- **池无上限**：key 的取值空间大时，池会无限增长，变成内存泄漏
- **用 `==` 比较包装类型**：小数值碰巧命中缓存时 `==` 返回 `true`，数值变大后结果就变了，线上才暴露。包装类型比较值一律用 `equals`
- **滥用 `intern()`**：对大量不重复的字符串调用 `intern()` 只会让常量池变大，没有节省效果

---

## 五、与相近模式的区别

### 1、享元 vs 对象池

两者都是「复用对象」，但复用方式完全不同。数据库连接池、线程池是**对象池**，不是享元：

| 维度 | 享元 | 对象池 |
|------|------|--------|
| 复用方式 | **同时共享**：多个客户端在同一时刻用同一个实例 | **独占借还**：借出期间只归一个使用者，用完归还 |
| 对象状态 | 不可变 | 可变，使用期间持有会话、事务等状态，归还前要重置 |
| 为了省什么 | 内存（对象数量） | 创建成本（建连接、建线程很贵） |
| 数量 | 等于内部状态的取值组合数 | 由池大小配置，与并发量相关 |
| 例子 | `Integer` 缓存、字符串常量池、枚举 | HikariCP 连接池、`ThreadPoolExecutor` |

连接池的原理见 [连接池](/database/5_practice/3_connection_pool)，线程池见 [线程池](/java/28_topic_thread_pool)。

### 2、享元 vs 单例

单例保证某个类**只有一个**实例；享元是按内部状态区分，**每种状态一个**实例，一个享元类可以有很多实例。

---

## 小结

- 享元把状态拆成可共享的内部状态和由调用方传入的外部状态，用工厂缓存并复用享元实例
- 享元必须不可变；缓存池要考虑并发安全和容量上限
- `Integer` 等包装类缓存、`Boolean.TRUE / FALSE`、枚举、字符串常量池都是享元；`Integer` 缓存上界可配置，包装类型比较值要用 `equals`
- 连接池、线程池是对象池：独占借还、对象可变，目的是省创建成本，与享元不同

## 参考资料

- Refactoring Guru：Flyweight：[https://refactoring.guru/design-patterns/flyweight](https://refactoring.guru/design-patterns/flyweight)
- Erich Gamma 等：《设计模式：可复用面向对象软件的基础》，Flyweight 一章
- Java SE 21 API：Integer.valueOf(int)：[https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/lang/Integer.html#valueOf(int)](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/lang/Integer.html#valueOf(int))
- Java SE 21 API：String.intern()：[https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/lang/String.html#intern()](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/lang/String.html#intern())

> 下一篇：[代理模式](./12_structural_proxy) —— 控制对目标对象的访问、静态代理、代理的种类、Spring 代理的常见坑。
