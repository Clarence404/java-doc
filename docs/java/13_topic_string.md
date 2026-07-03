# Java 专项-String

## 一、String 不可变性

`String` 底层是 `final char[]`（Java 9 起改为 `byte[]` + 编码标识以节省内存），且类本身用 `final` 修饰，无法被继承。

**不可变的好处：**
- 线程安全，多线程共享无需同步
- 可安全用作 HashMap 的 key（hashCode 缓存不变）
- 字符串池成为可能（相同内容可复用同一对象）

---

## 二、字符串池（String Pool）

JVM 在堆的特殊区域（Java 7 起移到堆中，之前在 PermGen）维护字符串常量池。

```java
String a = "hello";           // 字面量，放入常量池
String b = "hello";           // 复用常量池中的对象
String c = new String("hello"); // 强制在堆上新建对象

System.out.println(a == b);   // true（同一池对象）
System.out.println(a == c);   // false（不同对象）
System.out.println(a == c.intern()); // true（intern 返回池中对象）
```

### intern() 方法

- 若池中已存在内容相同的字符串，返回池中对象的引用
- 否则将当前字符串放入池中，返回该引用
- 大量重复字符串场景（如日志字段）可用 `intern()` 节省内存，但滥用会导致常量池膨胀

---

## 三、StringBuilder vs StringBuffer vs String

| | `String` | `StringBuilder` | `StringBuffer` |
|--|----------|-----------------|----------------|
| 可变性 | 不可变 | 可变 | 可变 |
| 线程安全 | 安全（不可变） | **不安全** | 安全（synchronized） |
| 性能 | 拼接产生大量对象 | **最快** | 比 StringBuilder 慢 |
| 推荐场景 | 常量/少量拼接 | 单线程字符串构建 | 多线程共享（少见） |

**Java 编译器优化**：简单的 `+` 拼接会被编译器自动转为 `StringBuilder`，但**循环内**的 `+` 每次循环都会新建 `StringBuilder`，应手动提到循环外。

```java
// 不推荐：循环内隐式新建 StringBuilder
String result = "";
for (String s : list) {
    result += s;
}

// 推荐
StringBuilder sb = new StringBuilder();
for (String s : list) {
    sb.append(s);
}
String result = sb.toString();
```

---

## 四、常见 API 与陷阱

### equals vs ==

```java
"hello".equals(str)   // 推荐：常量在前，避免 NPE
str.equals("hello")   // 若 str 为 null 则 NPE
```

### compareTo / compareToIgnoreCase

按字典序比较，返回差值（负数/0/正数），常用于排序。

### substring() 的内存问题

Java 6 中 `substring()` 共享底层 `char[]`，大字符串截取小子串会造成内存泄漏。
Java 7+ 已修复，`substring()` 创建独立的新字符串。

### String.format() vs 字符串模板

```java
// 格式化（可读性好但比 StringBuilder 慢）
String msg = String.format("user=%s, age=%d", name, age);

// Java 21 字符串模板（预览特性）
String msg = STR."user=\{name}, age=\{age}";
```

### contains / startsWith / endsWith / matches

```java
str.contains("abc")           // 包含子串
str.startsWith("pre")         // 前缀
str.endsWith(".java")         // 后缀
str.matches("\\d+")           // 正则全匹配
str.replaceAll("\\s+", " ")   // 正则替换
```

---

## 五、字符串与编码

```java
// String → byte[]（指定编码，避免乱码）
byte[] bytes = str.getBytes(StandardCharsets.UTF_8);

// byte[] → String
String str = new String(bytes, StandardCharsets.UTF_8);
```

**常见乱码原因**：
- 写入时用 UTF-8，读取时用 GBK（或平台默认编码）
- HTTP 请求 / 响应未声明 `Content-Type: charset=UTF-8`

---

## 六、常见面试问题

**Q：`String s = new String("abc")` 创建了几个对象？**
最多 2 个：常量池中 `"abc"` 一个（若池中已有则不新建），堆上 `new` 出来的对象一个。

**Q：为什么 String 用 `final` 修饰？**
防止子类修改行为破坏不可变性保证，保证字符串池的语义安全。

**Q：`==` 比较字符串时什么情况返回 true？**
两个引用指向同一个对象，包括：同一字面量（池中复用）、`intern()` 后返回的引用指向相同池对象。

**Q：String 的 hashCode 是怎么计算的？**
`s[0]*31^(n-1) + s[1]*31^(n-2) + ... + s[n-1]`，选 31 是因为它是奇素数，`31*i = 32*i - i = (i<<5) - i` 可被 JIT 优化为位运算。
