# 享元模式

**作用**：通过**共享细粒度对象**减少内存消耗，将对象的可共享状态（内部状态）与不可共享状态（外部状态）分离。

**应用场景**：
- JDK `String` 常量池（字面量字符串自动共享）
- `Integer.valueOf(-128~127)` 缓存（频繁使用的小整数共享实例）
- `Character.valueOf(0~127)` 字符缓存
- 数据库连接池、线程池（复用昂贵的连接/线程对象）

---

## 一、JDK 中的享元

```java
// String 常量池
String a = "hello";
String b = "hello";
System.out.println(a == b);  // true（共享同一对象）

// Integer 缓存（-128 ~ 127）
Integer x = Integer.valueOf(100);
Integer y = Integer.valueOf(100);
System.out.println(x == y);  // true（缓存命中）

Integer p = Integer.valueOf(200);
Integer q = Integer.valueOf(200);
System.out.println(p == q);  // false（超出缓存范围，新建对象）
```

---

## 二、手写享元工厂

以「字体对象池」为例（字体样式相同时共享，仅坐标不同）：

```java
// 享元对象：内部状态（可共享）= 字体名 + 大小 + 颜色
public class FontStyle {
    private final String fontName;
    private final int    fontSize;
    private final String color;

    public FontStyle(String fontName, int fontSize, String color) {
        this.fontName = fontName;
        this.fontSize = fontSize;
        this.color    = color;
    }

    public void render(int x, int y, String text) {
        System.out.printf("[%s %dpx %s] \"%s\" at (%d,%d)%n",
            fontName, fontSize, color, text, x, y);
    }
}

// 享元工厂：缓存已创建的字体对象
public class FontStyleFactory {
    private static final Map<String, FontStyle> cache = new ConcurrentHashMap<>();

    public static FontStyle getFont(String name, int size, String color) {
        String key = name + "-" + size + "-" + color;
        return cache.computeIfAbsent(key, k -> {
            System.out.println("Creating new FontStyle: " + k);
            return new FontStyle(name, size, color);
        });
    }

    public static int poolSize() { return cache.size(); }
}

// 使用：渲染 10000 个字符，字体样式只有几种，对象共享
for (int i = 0; i < 10_000; i++) {
    FontStyle font = FontStyleFactory.getFont("微软雅黑", 14, "#333333");
    font.render(i * 10, 0, String.valueOf((char)('A' + i % 26)));
}
System.out.println("Font objects created: " + FontStyleFactory.poolSize()); // 1
```

---

## 三、内部状态 vs 外部状态

| 类型 | 说明 | 示例 |
|------|------|------|
| 内部状态（Intrinsic）| 对象内部，可共享，不随环境变化 | 字体名、大小、颜色 |
| 外部状态（Extrinsic）| 随场景变化，由调用方传入 | 字符位置 (x, y)、文字内容 |
