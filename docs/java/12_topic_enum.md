# 枚举（Enum）

> Java 5 引入，本质上是一个继承自 `java.lang.Enum` 的**不可继承的 final 类**，每个枚举常量都是该类的静态 final 实例。

---

## 一、基础用法

```java
public enum Season {
    SPRING, SUMMER, AUTUMN, WINTER;
}

Season s = Season.SUMMER;
System.out.println(s.name());      // "SUMMER"（字符串名称）
System.out.println(s.ordinal());   // 1（从 0 开始的声明顺序）
System.out.println(s.toString());  // "SUMMER"（默认同 name()）

// 从字符串还原
Season s2 = Season.valueOf("AUTUMN");   // Season.AUTUMN

// 遍历所有常量
for (Season season : Season.values()) {
    System.out.println(season);
}
```

---

## 二、枚举字段与构造器

枚举可以携带字段和自定义方法，**构造器必须是 private**（编译器自动处理）：

```java
public enum Planet {
    MERCURY(3.303e+23, 2.4397e6),
    VENUS  (4.869e+24, 6.0518e6),
    EARTH  (5.976e+24, 6.37814e6);

    private final double mass;      // kg
    private final double radius;    // m

    Planet(double mass, double radius) {
        this.mass   = mass;
        this.radius = radius;
    }

    static final double G = 6.67300E-11;

    double surfaceGravity() {
        return G * mass / (radius * radius);
    }

    double surfaceWeight(double otherMass) {
        return otherMass * surfaceGravity();
    }
}

// 调用
double earthWeight = 75.0;
double mass = earthWeight / Planet.EARTH.surfaceGravity();
for (Planet p : Planet.values())
    System.out.printf("Your weight on %s is %6.2f%n", p, p.surfaceWeight(mass));
```

---

## 三、枚举实现接口（抽象方法）

每个枚举常量可以有不同的行为：

```java
public enum Operation {
    PLUS("+") {
        @Override public double apply(double x, double y) { return x + y; }
    },
    MINUS("-") {
        @Override public double apply(double x, double y) { return x - y; }
    },
    TIMES("*") {
        @Override public double apply(double x, double y) { return x * y; }
    };

    private final String symbol;
    Operation(String symbol) { this.symbol = symbol; }

    public abstract double apply(double x, double y);

    @Override public String toString() { return symbol; }
}

// 使用
double result = Operation.PLUS.apply(3, 4);   // 7.0
```

---

## 四、枚举实现单例（最佳方式）

《Effective Java》推荐的单例写法：天然防止反射攻击和序列化破坏。

```java
public enum Singleton {
    INSTANCE;

    private final Connection connection;

    Singleton() {
        // 初始化重量级资源
        connection = createConnection();
    }

    public void doWork() { /* ... */ }

    private Connection createConnection() { return null; }
}

// 使用
Singleton.INSTANCE.doWork();
```

为什么安全：
- JVM 保证枚举常量只初始化一次（类加载时）
- 反射无法通过 `newInstance()` 创建枚举实例（`Constructor.newInstance` 对枚举抛异常）
- 序列化/反序列化自动走 `readResolve()`，返回已有实例

---

## 五、EnumSet 与 EnumMap

替代 `Set<Enum>` 和 `Map<Enum, V>`，内部使用位向量实现，**性能远优于 HashSet/HashMap**。

```java
// EnumSet
EnumSet<Season> warmSeasons = EnumSet.of(Season.SPRING, Season.SUMMER);
EnumSet<Season> all         = EnumSet.allOf(Season.class);
EnumSet<Season> complement  = EnumSet.complementOf(warmSeasons);

// 批量操作
warmSeasons.add(Season.AUTUMN);
warmSeasons.remove(Season.SPRING);
boolean has = warmSeasons.contains(Season.SUMMER);

// EnumMap
EnumMap<Season, String> desc = new EnumMap<>(Season.class);
desc.put(Season.SPRING, "万物复苏");
desc.put(Season.SUMMER, "骄阳似火");
desc.forEach((k, v) -> System.out.println(k + ": " + v));
// 迭代顺序 = 枚举声明顺序，性能优于 HashMap
```

---

## 六、枚举与 switch

Java 14+ switch 表达式与枚举搭配，穷举性检查更安全：

```java
// Java 14+ switch 表达式
String description = switch (season) {
    case SPRING -> "春暖花开";
    case SUMMER -> "夏日炎炎";
    case AUTUMN -> "秋高气爽";
    case WINTER -> "白雪皑皑";
};  // 编译器保证枚举值被穷举，不需要 default

// Java 21+ switch 模式匹配（sealed + enum）
sealed interface Shape permits Circle, Square {}
record Circle(double r) implements Shape {}
record Square(double side) implements Shape {}

double area = switch (shape) {
    case Circle c  -> Math.PI * c.r() * c.r();
    case Square s  -> s.side() * s.side();
};
```

---

## 七、常见面试问题

**Q：枚举的本质是什么？**

编译后是一个继承 `java.lang.Enum<E>` 的 final 类，每个常量都是该类的 `public static final` 实例，由类加载器保证线程安全地只初始化一次。

**Q：枚举比常量类（`public static final int`）好在哪里？**

类型安全（编译期检查）、可以携带方法和字段、`switch` 穷举检查、序列化安全、`toString()` 可读性更高。

**Q：枚举能被继承吗？**

不能。编译器将枚举类标记为 `final`（但枚举本身隐式继承 `java.lang.Enum`，且可以实现接口）。

**Q：枚举序列化安全吗？**

安全。JVM 保证枚举反序列化时返回已存在的实例（通过枚举名称查找），不会创建新对象，单例模式不会被破坏。

**Q：`ordinal()` 可以持久化存储吗？**

强烈不建议。在枚举中间插入新常量会导致原有 ordinal 值错位。建议使用 `name()` 或自定义字段（如 code）作为存储值。
