---
description: 类型擦除与 Signature、桥方法、通配符与 PECS、堆污染、TypeToken
---

# 泛型

> 前置阅读：[内部类](./13_topic_inner_class)

泛型让类、接口和方法带上类型参数，在编译期完成类型检查并自动插入强制转换。本篇讲擦除与签名、通配符与 PECS、桥方法与堆污染、TypeToken。

---

## 一、基础语法

泛型在 Java 5 引入，采用「擦除式」实现，但声明处的泛型签名会写进 class 文件，框架靠它在运行时还原 `List<User>` 这样的类型。

### 1、泛型类、接口与方法

```java
// 泛型类
public class Box<T> {
    private T value;
    public Box(T value) { this.value = value; }
    public T get() { return value; }
}

// 泛型接口
public interface Converter<F, T> {
    T convert(F from);
}

// 泛型方法：类型参数声明在返回值前，独立于类的类型参数
public static <T extends Comparable<? super T>> T max(T a, T b) {
    return a.compareTo(b) >= 0 ? a : b;
}

Box<String> box = new Box<>("hello");     // 菱形推断（JDK 7）
String larger = max("apple", "banana");   // 推断 T = String
```

类型参数命名习惯：`T` 类型、`E` 元素、`K` / `V` 键值、`R` 返回值、`?` 通配符（不是类型参数，只能出现在使用处）。

### 2、类型推断的演进

| 版本 | 能力 |
|------|------|
| JDK 7 | 菱形运算符 `new ArrayList<>()` |
| JDK 8 | 目标类型推断：`Collections.emptyList()` 作为方法实参时可按形参推断 |
| JDK 9 | 匿名内部类也能用菱形 `new Comparator<>() { ... }` |
| JDK 10 | `var` 局部变量推断；`var list = new ArrayList<>()` 会推断成 `ArrayList<Object>`，要写明类型实参 |
| JDK 21 | 记录模式可推断类型实参：`if (o instanceof Pair(var a, var b))` 中 `Pair<String,Integer>` 的实参由上下文推出（JEP 440） |

### 3、几条语法限制

- **不支持基本类型实参**：`List<int>` 非法，只能 `List<Integer>`，大量数值时有装箱与内存开销（数值场景用 `IntStream`、`int[]` 或 Eclipse Collections 等原始类型集合）。让泛型支持值类型的工作仍在 Valhalla 项目中推进，尚未成为正式特性。
- **静态上下文不能用类的类型参数**：`static T cache;` 非法，类型参数属于实例，所有 `Box<X>` 共享同一个静态字段。
- **原始类型（raw type）只为兼容保留**：`List list = new ArrayList<String>()` 关闭了全部泛型检查，编译器给出 unchecked 警告，新代码不应出现。

---

## 二、类型擦除

### 1、擦除了什么，保留了什么

编译器在类型检查之后把类型参数替换为其**擦除类型**，并在使用处插入强制转换：

- 无界 `<T>` → `Object`
- 有界 `<T extends Foo>` → `Foo`
- 多界 `<T extends Foo & Bar>` → 第一个边界 `Foo`（所以多界时把类放第一位、接口放后面）

```java
List<String> strings = new ArrayList<>();
List<Integer> ints   = new ArrayList<>();
System.out.println(strings.getClass() == ints.getClass()); // true，运行时都是 ArrayList

String s = strings.get(0);   // 字节码里是 (String) strings.get(0)，checkcast 由编译器插入
```

「擦除」并不意味着字节码里完全没有泛型信息。准确的说法是：

| 位置 | 运行时能否拿到类型实参 | 原因 |
|------|------------------------|------|
| 对象实例（`new ArrayList<String>()`） | 不能 | 实例只记录 `ArrayList.class` |
| 局部变量 | 不能 | 只在编译期存在（调试信息 LocalVariableTypeTable 除外） |
| 类 / 接口的父类型声明 | 能 | 写在 `Signature` 属性中，`getGenericSuperclass()` 读取 |
| 字段、方法参数与返回值的声明 | 能 | 同上，`Field.getGenericType()`、`Method.getGenericReturnType()` |

这正是 Spring、Jackson、MyBatis 能把 `List<User>` 字段反序列化成 `User` 列表的原因，也是第七节 TypeToken 技巧的基础。

### 2、擦除带来的限制

```java
public class Repo<T> {
    T create()          { return new T(); }        // 编译错误：擦除后不知道 T 是谁
    T[] array()         { return new T[10]; }      // 编译错误：不能创建泛型数组
    void m(List<String> a)  { }
    void m(List<Integer> a) { }                    // 编译错误：擦除后签名冲突（name clash）
}

// 通用绕法：显式传入 Class<T> 或 Supplier<T>
public static <T> T create(Class<T> clazz) throws ReflectiveOperationException {
    return clazz.getDeclaredConstructor().newInstance();   // 不要用 JDK 9 起废弃的 Class.newInstance()
}
public static <T> T create(Supplier<T> factory) {
    return factory.get();                                  // 更推荐：无反射、无受检异常
}
```

`Class.newInstance()` 自 JDK 9 起被废弃，原因是它会把构造器抛出的受检异常原样抛出而不声明，绕过编译期检查；`getDeclaredConstructor().newInstance()` 会把它包装成 `InvocationTargetException`。

### 3、instanceof 与泛型（JDK 16 起放宽）

只有**可具化类型**（reifiable type：非泛型类型、原始类型、`List<?>` 这类无界通配）在运行时可完整检查。JDK 16（JEP 394）起，只要编译器能证明转换是安全的，`instanceof` 也允许非可具化类型：

```java
Collection<String> c = List.of("a");
if (c instanceof List<String> list) { }    // JDK 16+ 合法：从 Collection<String> 到 List<String> 是安全的向下转型

Object obj = c;
if (obj instanceof List<String>) { }       // 仍然编译错误：Object → List<String> 无法在运行时验证
if (obj instanceof List<?> list) { }       // 合法：只检查是不是 List
```

### 4、桥方法

擦除与覆写放在一起会出问题：子类覆写泛型父类的方法后，两者擦除后的签名不同，JVM 不认为构成覆写。编译器因此生成**桥方法**（bridge method）：

```java
interface Handler<T> { void handle(T msg); }      // 擦除后：handle(Object)

class OrderHandler implements Handler<Order> {
    @Override
    public void handle(Order msg) { }              // 擦除后：handle(Order)
    // 编译器额外生成（ACC_BRIDGE | ACC_SYNTHETIC）：
    // public void handle(Object msg) { handle((Order) msg); }
}
```

需要注意的影响：

- `getDeclaredMethods()` 会同时返回 `handle(Order)` 和桥方法 `handle(Object)`，可用 `Method.isBridge()` 过滤；
- JDK 8 起 javac 会把注解复制到桥方法上，但框架查找注解、做 AOP 匹配时通常仍要先找到被桥接的真实方法，Spring 的 `BridgeMethodResolver.findBridgedMethod` 就是做这件事；
- 协变返回类型（子类覆写时返回更具体的类型）也靠桥方法实现。

---

## 三、通配符

![PECS：extends 只读，super 只写](../assets/java/generics_pecs.svg)

泛型是**不变**的：`List<Integer>` 不是 `List<Number>` 的子类型。通配符在**使用处**引入有限的协变 / 逆变。

### 1、无界通配符 `<?>`

「某个未知类型」。可以读出 `Object`，除了 `null` 不能写入。适合只关心容器本身的方法，如 `size()`、`clear()`：

```java
void printAll(List<?> list) {
    for (Object o : list) System.out.println(o);
    // list.add("x");   编译错误
}
```

`List<Object>` 与 `List<?>` 的区别：前者只能接收实参恰好为 `Object` 的列表，但可以写入任意对象；后者能接收任何 `List<X>`，但不能写入。

### 2、上界通配符 `<? extends T>`：协变，生产者

可以接收 `List<Number>`、`List<Integer>`、`List<Double>`，读出的元素至少是 `Number`：

```java
double sum(List<? extends Number> list) {
    double s = 0;
    for (Number n : list) s += n.doubleValue();
    // list.add(1);   编译错误
    return s;
}
```

不能写入的原因**与擦除无关**，而是编译期的类型检查：编译器会把 `?` 「捕获」成一个具体但未知的类型 `CAP#1 extends Number`（通配符捕获，wildcard capture）。`add` 的形参类型是 `CAP#1`，编译器无法证明 `Integer` 是 `CAP#1` 的子类型——实参可能是 `List<Double>`——所以拒绝。

### 3、下界通配符 `<? super T>`：逆变，消费者

可以接收 `List<Integer>`、`List<Number>`、`List<Object>`：

```java
void fill(List<? super Integer> list) {
    list.add(1);                 // 合法：捕获类型 CAP#1 是 Integer 的某个超类型，Integer 一定能赋给它
    Object first = list.get(0);  // 读出的只能当 Object
}
```

### 4、捕获辅助方法

想在 `List<?>` 上做「读出再写回」时，直接写会编译失败，可用一个私有泛型方法把捕获类型命名出来：

```java
public static void swapFirstTwo(List<?> list) {
    swapHelper(list);            // T 被推断为捕获类型
}
private static <T> void swapHelper(List<T> list) {
    T tmp = list.get(0);
    list.set(0, list.get(1));
    list.set(1, tmp);
}
```

---

## 四、PECS 原则

**Producer Extends, Consumer Super**（出自《Effective Java》）：

- 参数只用来**产出**元素（你从中读）→ `<? extends T>`
- 参数只用来**消费**元素（你往里写）→ `<? super T>`
- 既读又写 → 不用通配符，直接 `T`

JDK 中 `Collections.copy` 的签名就是典型写法：

```java
// JDK 实际签名
public static <T> void copy(List<? super T> dest, List<? extends T> src)
```

它的语义是**覆盖**：按下标 `dest.set(i, src.get(i))` 写入，要求 `dest.size() >= src.size()`，否则抛 `IndexOutOfBoundsException`，并不会 `add` 追加。

比较器、函数式参数同理：`Collections.sort(List<T>, Comparator<? super T>)` 允许用 `Comparator<Object>` 排序 `List<String>`；`Stream.map(Function<? super T, ? extends R>)` 入参逆变、出参协变。写公共 API 时按 PECS 放宽参数类型，调用方会舒服很多；返回值则不要用通配符，否则把麻烦转嫁给调用方。

---

## 五、有界类型参数

```java
// 单边界：T 必须是 Number 或其子类，方法体内可直接调 Number 的方法
public static <T extends Number> double sum(List<T> list) {
    return list.stream().mapToDouble(Number::doubleValue).sum();
}

// 多边界：类最多一个，且必须写在第一位
public static <T extends Comparable<? super T> & Serializable> T min(List<T> list) {
    return list.stream().min(Comparator.naturalOrder()).orElseThrow();
}

// 递归边界：Enum 的实际定义，保证 compareTo 只能和同类枚举比较
public abstract class Enum<E extends Enum<E>> implements Comparable<E>, Serializable { }
```

`<T extends Comparable<T>>` 叫递归类型界，表达「T 能和自身比较」。更宽松的 `<T extends Comparable<? super T>>` 让 `java.sql.Timestamp` 这类只从父类继承了 `Comparable<Date>` 的类型也能用。

---

## 六、泛型与数组

### 1、为什么不能 new 泛型数组

数组是**协变且具化**的：`String[]` 是 `Object[]` 的子类型，运行时每次存储都会检查元素类型，不匹配抛 `ArrayStoreException`。泛型是**不变且擦除**的。两者混用时，数组的运行时检查只能看到擦除后的类型，挡不住错误：

```java
Object[] arr = new String[1];
arr[0] = 1;                                   // 运行时 ArrayStoreException：数组能发现

@SuppressWarnings("unchecked")
List<String>[] lists = (List<String>[]) new List[1];
Object[] objs = lists;
objs[0] = List.of(42);                        // 不报错：运行时只看到 List
String s = lists[0].get(0);                   // ClassCastException 出现在远离问题的地方
```

所以泛型容器一律用 `List<List<String>>` 代替 `List<String>[]`；确实需要数组时（如自己实现集合），内部用 `Object[]` 存储、取出时强转，参考 `ArrayList` 的 `elementData`。

### 2、泛型可变参数与堆污染

可变参数本质是数组，`T... args` 会让编译器悄悄创建泛型数组，产生「可能的堆污染」警告：

```java
@SafeVarargs                                   // 只能用于 static / final / private 方法和构造器
static <T> List<T> listOf(T... items) {
    return List.of(items);                     // 只读取、不存储、不暴露数组：安全
}

static <T> T[] toArray(T... items) {
    return items;                              // 危险：把泛型数组暴露给调用方
}
static <T> T[] pickTwo(T a, T b) {
    return toArray(a, b);                      // 此处 T 已擦除，编译器创建的是 Object[]
}
String[] ok  = toArray("a", "b");              // 正常：调用处已知 T = String，创建 String[]
String[] bad = pickTwo("a", "b");              // ClassCastException：Object[] 不能转成 String[]
```

`@SafeVarargs` 是开发者对编译器的承诺：方法体不会往数组里写入错误类型，也不会把数组引用泄露出去。`List.of`、`Arrays.asList`、`Stream.of` 都标注了它。

---

## 七、运行时获取泛型类型：TypeToken

### 1、原理

实例上的类型实参被擦除，但**类声明**中的父类型签名会保留。创建一个匿名子类，就把 `List<String>` 固化到了这个匿名类的 `Signature` 属性中：

```java
public abstract class TypeToken<T> {
    private final Type type;

    protected TypeToken() {
        Type superType = getClass().getGenericSuperclass();
        if (!(superType instanceof ParameterizedType pt)) {
            throw new IllegalStateException("必须以匿名子类形式创建：new TypeToken<...>() {}");
        }
        this.type = pt.getActualTypeArguments()[0];
    }

    public Type getType() { return type; }
}

Type t = new TypeToken<Map<String, List<Integer>>>() {}.getType();
System.out.println(t);   // java.util.Map<java.lang.String, java.util.List<java.lang.Integer>>
```

注意两个坑：直接 `new TypeToken<T>(){}` 写在泛型方法里时，拿到的是类型变量 `T` 而不是具体类型；匿名内部类会持有外部实例引用（见 [内部类](./13_topic_inner_class)），不要在长生命周期对象里大量创建。

### 2、各框架的现成实现

| 场景 | API |
|------|-----|
| Jackson 反序列化 | `mapper.readValue(json, new TypeReference<List<User>>() {})`；动态拼装用 `TypeFactory.constructCollectionType(List.class, User.class)` |
| Spring `RestClient` / `RestTemplate` / `WebClient` | `new ParameterizedTypeReference<List<User>>() {}` |
| Spring 内部解析泛型 | `ResolvableType.forField(field).resolveGeneric(0)`，可以沿继承链解析类型变量 |
| Gson | `new TypeToken<List<User>>() {}.getType()`；动态拼装用 `TypeToken.getParameterized(List.class, User.class)` |

自己写通用 DAO、消息反序列化器时，优先复用 `ResolvableType` 或 Jackson `JavaType`，它们处理了类型变量、通配符、嵌套泛型等边界情况，比手写 `ParameterizedType` 解析稳妥得多。反射读取泛型签名的 API 见 [反射](./15_topic_reflection)。

---

## 小结

- 擦除的是实例与局部变量上的类型实参；类、字段、方法声明处的泛型签名保存在 `Signature` 属性中，反射可以读到
- 擦除带来不能 `new T()`、不能建泛型数组、擦除后签名冲突不能重载等限制；用 `Class<T>` 或 `Supplier<T>` 绕开，不要用废弃的 `Class.newInstance()`
- JDK 16 起 `instanceof` 允许编译器可证明安全的泛型类型检查，`Object instanceof List<String>` 仍非法
- 覆写泛型方法时编译器生成桥方法，反射与框架查找注解时要用 `isBridge()` / `BridgeMethodResolver` 处理
- 通配符不能写入的根因是编译期的通配符捕获，不是擦除；PECS：读用 extends，写用 super，既读又写用 T
- 泛型数组与泛型可变参数会导致堆污染，`@SafeVarargs` 只在方法不存储、不暴露数组时使用
- 运行时拿完整泛型类型靠匿名子类固化签名，生产中直接用 Jackson `TypeReference`、Spring `ParameterizedTypeReference` / `ResolvableType`

## 参考资料

- JLS 第 4.5–4.8 节（参数化类型、类型擦除、可具化类型）：[https://docs.oracle.com/javase/specs/jls/se21/html/jls-4.html](https://docs.oracle.com/javase/specs/jls/se21/html/jls-4.html)
- Java Tutorials - Generics：[https://docs.oracle.com/javase/tutorial/java/generics/](https://docs.oracle.com/javase/tutorial/java/generics/)
- JVMS 4.7.9 Signature 属性：[https://docs.oracle.com/javase/specs/jvms/se21/html/jvms-4.html#jvms-4.7.9](https://docs.oracle.com/javase/specs/jvms/se21/html/jvms-4.html#jvms-4.7.9)
- JEP 394 instanceof 模式匹配：[https://openjdk.org/jeps/394](https://openjdk.org/jeps/394)

> 下一篇：[反射](./15_topic_reflection) —— 泛型签名之外，看运行时如何读取和调用类的全部成员，以及 JDK 18 后反射的实现变化。
