---
description: 不可变与 Compact Strings、常量池与 ==、invokedynamic 拼接、文本块、新 API、编码
---

# String

> 前置阅读：[异常体系](./10_topic_exception)

本篇讲 String 的不可变实现与 Compact Strings、`==` 与拼接的编译方式、文本块与 JDK 11–21 新增 API 以及编码问题，以 JDK 21 / 25 为基线，与 JDK 8 / 17 不同之处单独标注。

---

## 一、不可变性与内存布局

### 1、不可变是怎么保证的

JDK 9 起 `String` 的核心字段如下（JDK 8 是 `private final char[] value`）：

```java
public final class String implements java.io.Serializable, Comparable<String>, CharSequence,
        Constable, ConstantDesc {
    @Stable
    private final byte[] value;   // 字符内容
    private final byte coder;     // 编码标识：LATIN1 = 0，UTF16 = 1
    private int hash;             // hashCode 缓存，默认 0
    private boolean hashIsZero;   // JDK 13+：区分「未计算」与「hash 恰好为 0」
    // ...
}
```

不可变由三点共同保证：

- 类声明为 `final`，不能被继承后覆写方法改变行为
- `value` 是 `private final`，且所有「修改」方法（`substring`、`replace`、`toUpperCase` 等）都返回新对象
- 构造时对传入的数组做拷贝，`toCharArray()` 等方法也返回拷贝，外部拿不到内部数组的引用

### 2、不可变带来的好处

- **线程安全**：多线程共享无需同步
- **可缓存 hashCode**：作为 `HashMap` 的 key 时不必每次重新计算，且 key 放入后内容不会再变
- **常量池可行**：内容相同的字面量可以安全地复用同一个对象
- **安全**：类名、文件路径、URL、SQL 参数等经校验后不能被他人篡改，避免「先校验后使用」之间被修改的漏洞

### 3、Compact Strings（JDK 9+）

大部分业务字符串只含 Latin-1 字符（ASCII 加西欧字符），用 UTF-16 的 `char[]` 存储会浪费一半空间。JEP 254 把存储改为 `byte[]` 加 `coder`：

| 内容 | coder | 每字符字节数 | 示例 |
|------|-------|------------|------|
| 全部字符在 Latin-1 范围（U+0000–U+00FF） | `LATIN1` | 1 | `"order-1024"` |
| 含任意其他字符 | `UTF16` | 2 | `"订单-1024"` |

- 判断发生在构造时：只要有一个字符超出 Latin-1，整个字符串都按 UTF-16 存储
- 对 ASCII 为主的服务（JSON、日志、ID），堆中 `byte[]` 占用接近减半，GC 压力相应下降
- `-XX:-CompactStrings` 可关闭该特性，所有字符串都按 UTF-16 存储；只有在字符串几乎全是中文等非 Latin-1 内容、且压测证明 `coder` 分支有开销时才考虑，一般保持默认

### 4、hashCode 的计算与缓存

```java
// s[0]*31^(n-1) + s[1]*31^(n-2) + ... + s[n-1]
```

结果在首次调用时计算并写入 `hash` 字段。如果计算结果恰好是 0，JDK 13 之前每次调用都会重新计算；JDK 13 起用 `hashIsZero` 标记，避免这类字符串反复计算。选 31 是因为它是奇素数，且 `31 * i == (i << 5) - i` 便于优化。

---

## 二、常量池与 ==

### 1、字面量、new 与 intern

```java
String a = "hello";                 // 字面量，指向常量池中的对象
String b = "hello";                 // 复用同一个池对象
String c = new String("hello");     // 在堆上新建对象，内容与池中对象相同

System.out.println(a == b);           // true
System.out.println(a == c);           // false
System.out.println(a == c.intern());  // true，intern 返回池中对象
```

`new String("hello")` 最多涉及两个对象：字面量 `"hello"` 在类首次解析该常量时进入常量池（已存在则复用），`new` 再在堆上创建一个新的 `String`。新对象直接引用池中对象的内部数组，所以只多出一个对象头和几个字段。

### 2、编译期常量折叠

```java
String s1 = "ab";
String s2 = "a" + "b";              // 编译期折叠为 "ab"
System.out.println(s1 == s2);       // true

final String x = "a";               // final + 字面量初始化 → 编译期常量
String s3 = x + "b";                // 同样折叠为 "ab"
System.out.println(s1 == s3);       // true

String y = "a";                     // 非 final 变量
String s4 = y + "b";                // 运行时拼接，生成新对象
System.out.println(s1 == s4);       // false
System.out.println(s1 == s4.intern()); // true
```

只有操作数全是编译期常量表达式（JLS §15.29）时才会折叠：字面量、用常量表达式初始化的 `final` 基本类型或 `String` 变量。方法返回值、非 final 变量都不算。

业务代码比较字符串内容一律用 `equals`；`==` 只用于理解上面的机制。

### 3、intern 的使用建议

`intern()` 把字符串登记到 JVM 全局的 StringTable：池中已有相等字符串则返回池中引用，否则（JDK 7+）把当前对象的引用登记进去并返回它。

- 不要对用户输入、订单号、日志字段这类取值不受控的字符串 `intern()`，会导致 StringTable 膨胀、哈希冲突增多，并增加 GC 扫描负担
- 需要对少量取值有限的字符串做规范化时，优先在业务层复用常量或枚举，或用应用层的 `Map` / Guava `Interner`，范围可控
- 只想减少重复字符串占用的堆内存，可以开启 `-XX:+UseStringDeduplication`，它让内容相同的 String 共享底层数组，不改变 `==` 语义

StringTable 的位置演进、`-XX:StringTableSize` 与字符串去重的细节见 [运行时内存](/jvm/1_memory)；选型建议见 [代码级优化](/high-perf/6_code_optimization)。

---

## 三、字符串拼接

### 1、`+` 的编译方式：JDK 8 与 JDK 9+

```java
String s = "user=" + name + ", age=" + age;
```

- **JDK 8**：javac 编译为 `new StringBuilder().append("user=").append(name)...toString()`
- **JDK 9+（JEP 280）**：javac 生成一条 `invokedynamic`，引导方法为 `StringConcatFactory.makeConcatWithConstants`，常量部分作为模板（`"user=\u0001, age=\u0001"`）传入。运行时由 JDK 生成最优的拼接策略：先计算总长度和 coder，再一次性分配目标数组，避免 `StringBuilder` 扩容和多余拷贝

```text
$ javap -c Demo.class
  invokedynamic #7,  0  // InvokeDynamic #0:makeConcatWithConstants:(Ljava/lang/String;I)Ljava/lang/String;
```

带来的变化：

- 单个表达式内直接用 `+`，不需要手动改成 `StringBuilder`，后者反而可能更慢
- 拼接策略在 JDK 内部演进，升级 JDK 即可获益，无需重新编译业务代码
- 以 `--release 8` 编译的代码仍是 `StringBuilder` 形式

### 2、循环内拼接仍要用 StringBuilder

```java
// 不推荐：每次迭代都生成一个新 String 并复制已有内容，总复制量 O(n²)
String result = "";
for (String s : list) {
    result += s;
}

// 推荐：一个 StringBuilder，能估算长度时预分配
StringBuilder sb = new StringBuilder(list.size() * 16);
for (String s : list) {
    sb.append(s);
}
String result = sb.toString();

// 有分隔符时更直接
String csv = String.join(",", list);
String csv2 = list.stream().collect(Collectors.joining(",", "[", "]"));
```

indy 只优化单个表达式，解决不了循环中「每轮产生一个中间 String」的问题。

### 3、StringBuilder 与 StringBuffer

| | `StringBuilder` | `StringBuffer` |
|--|-----------------|----------------|
| 线程安全 | 否 | 是（方法级 `synchronized`） |
| 典型用法 | 方法内局部变量构建字符串 | 遗留 API（如 `Matcher.appendReplacement` 的旧重载） |

`StringBuffer` 已基本是遗留类：多个线程往同一个缓冲区追加内容，本身就意味着内容顺序不可控，正确做法是各线程各自构建再汇总。新代码一律用 `StringBuilder`。

两者内部都是 `byte[]` + `coder`，默认容量 16，不够时扩容为 `(旧容量 << 1) + 2`；追加了非 Latin-1 字符时会把整个缓冲区膨胀为 UTF-16。

---

## 四、文本块与格式化

### 1、文本块（JDK 15+）

```java
String json = """
        {
          "orderId": %d,
          "status": "%s"
        }
        """.formatted(orderId, status);

String sql = """
        SELECT id, name
        FROM t_user
        WHERE status = ? \
        AND deleted = 0
        """;
```

- 开头的 `"""` 后必须换行；公共缩进由内容行和结尾 `"""` 中最靠左的一行决定，会被自动去除
- 行尾空格被去掉，需要保留时用 `\s`；行尾的 `\` 表示不换行（JDK 15 新增的转义）
- 换行统一为 `\n`，与源文件的换行符无关
- 编译后就是普通的 `String` 常量，没有运行时开销

### 2、格式化

```java
String a = String.format("user=%s, age=%d", name, age);
String b = "user=%s, age=%d".formatted(name, age);         // JDK 15+，等价写法
String c = MessageFormat.format("user={0}, age={1}", name, age);
```

`String.format` 每次都要解析格式串，比 `+` 慢，热点路径上（如高频日志）应改用 `+` 或日志框架的 `{}` 占位符。

字符串模板（String Templates，`STR."..."` 语法）曾在 JDK 21、22 作为预览特性出现，已于 JDK 23 撤回，当前 JDK 中不存在该语法，见 [版本演进](./2_version)。

---

## 五、常用 API 与陷阱

### 1、比较

```java
"hello".equals(str);                 // 常量在前，str 为 null 时返回 false
Objects.equals(a, b);                // 两边都可能为 null 时使用
str.equalsIgnoreCase("HELLO");
a.compareTo(b);                      // 按 UTF-16 码元字典序，返回负数 / 0 / 正数
```

`compareTo` 不考虑语言习惯，中文按拼音排序要用 `Collator.getInstance(Locale.CHINA)`。

`switch` 可以直接作用于 `String`（Java 7+），编译后先比 `hashCode()` 再用 `equals()` 确认；选择子为 null 时抛 NPE。

### 2、JDK 11–21 新增的常用方法

| 版本 | 方法 | 说明 |
|------|------|------|
| 11 | `isBlank()` | 空串或只含空白字符 |
| 11 | `strip()` / `stripLeading()` / `stripTrailing()` | 去除 Unicode 空白；`trim()` 只去除 `<= U+0020` 的字符，对全角空格等无效 |
| 11 | `lines()` | 按行拆成 `Stream<String>`，识别 `\n`、`\r`、`\r\n` |
| 11 | `repeat(n)` | 重复 n 次 |
| 12 | `indent(n)` / `transform(f)` | 调整缩进 / 把字符串交给函数做链式转换 |
| 15 | `formatted(...)` / `stripIndent()` / `translateEscapes()` | 配合文本块使用 |
| 21 | `indexOf(ch, beginIndex, endIndex)` | 在指定区间内查找 |
| 21 | `splitWithDelimiters(regex, limit)` | 拆分时保留分隔符 |
| 21 | `StringBuilder.repeat(...)` | 追加重复内容 |

```java
"  　 ".isBlank();           // true（　 是全角空格）
" 　abc　 ".trim();      // "　abc　"，全角空格没被去掉
" 　abc　 ".strip();     // "abc"

"a,b;c".splitWithDelimiters("[,;]", 0);   // ["a", ",", "b", ";", "c"]
```

### 3、split 的坑

```java
"a,b,,".split(",");          // ["a", "b"]，末尾空串被丢弃
"a,b,,".split(",", -1);      // ["a", "b", "", ""]，保留末尾空串
"1.2.3".split(".");          // []，"." 是正则元字符，要写 "\\."
```

`split` 的参数是正则；单个非元字符的分隔符有快速路径，复杂分隔符在循环中使用时应预编译 `Pattern`。

### 4、码点与 emoji

`length()` 和 `charAt()` 以 UTF-16 码元为单位。BMP 之外的字符（大部分 emoji、部分生僻字）占两个码元（代理对）：

```java
String s = "赞👍";
s.length();                         // 3
s.codePointCount(0, s.length());    // 2
s.codePoints().count();             // 2
s.substring(0, 2);                  // "赞" 加半个代理对，输出乱码
```

按「字符数」截断昵称、校验长度时，用 `codePoints()` 或 `offsetByCodePoints()`，否则会截出半个 emoji。

### 5、substring 的历史问题

JDK 7u6 之前，`substring()` 与原字符串共享底层 `char[]`，从一个大字符串截取一小段并长期持有，会导致整个大数组无法回收。JDK 7u6 起 `substring()` 总是复制所需区间，不再有这个问题。

---

## 六、字符串与编码

```java
// 始终显式指定字符集
byte[] bytes = str.getBytes(StandardCharsets.UTF_8);
String back  = new String(bytes, StandardCharsets.UTF_8);

Files.readString(path);                              // JDK 11+，默认 UTF-8
Files.readString(path, Charset.forName("GBK"));
```

- **JDK 18+（JEP 400）**：所有平台的默认字符集都是 UTF-8，`new FileReader(file)`、`getBytes()` 等未指定字符集的 API 也按 UTF-8 处理。只有设置 `-Dfile.encoding=COMPAT` 时才回退到操作系统的编码
- **JDK 17 及以前**：默认字符集取决于操作系统，中文 Windows 上通常是 GBK，同一份代码在 Linux 和 Windows 上读写结果不同，这是「平台默认编码」乱码的主要来源
- 控制台输出编码（JDK 19+ 由 `stdout.encoding` 决定）与默认字符集是两回事

常见乱码原因：

- 写入方用 UTF-8，读取方用 GBK（或 JDK 17 及以前的平台默认编码）
- HTTP 响应没有声明字符集，应写成 `Content-Type: application/json; charset=UTF-8`
- 数据库连接或表的字符集不是 `utf8mb4`，存入 emoji 时报错或变成问号

---

## 小结

- JDK 9 起 String 由 `byte[]` + `coder` 存储（Compact Strings），Latin-1 内容每字符 1 字节；不可变由 final 类、私有 final 数组和防御性拷贝保证
- `==` 为 true 的情况：同一字面量、编译期常量折叠（含 final 常量）、`intern()` 返回的池对象；比较内容一律用 `equals`
- `intern()` 不用于取值不受控的字符串，规范化优先用业务常量、`Map` 或 `Interner`，省内存可用字符串去重
- JDK 9 起单表达式 `+` 编译为 `invokedynamic`（StringConcatFactory），直接用 `+` 即可；循环内拼接仍用 `StringBuilder`，`StringBuffer` 属于遗留类
- 文本块（15）、`strip` / `isBlank` / `lines` / `repeat`（11）、`formatted`（15）、`splitWithDelimiters`（21）是日常常用的新 API；字符串模板已撤回
- JDK 18 起默认字符集为 UTF-8，但读写字节时仍应显式指定字符集

## 参考资料

- String API（Java SE 21）：[https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/lang/String.html](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/lang/String.html)
- JEP 254 Compact Strings：[https://openjdk.org/jeps/254](https://openjdk.org/jeps/254)
- JEP 280 Indify String Concatenation：[https://openjdk.org/jeps/280](https://openjdk.org/jeps/280)
- JEP 378 Text Blocks：[https://openjdk.org/jeps/378](https://openjdk.org/jeps/378)
- JEP 400 UTF-8 by Default：[https://openjdk.org/jeps/400](https://openjdk.org/jeps/400)

> 下一篇：[枚举](./12_topic_enum) —— 带字段与行为的类型安全常量，以及它在序列化、持久化和 switch 中的特殊规则。
