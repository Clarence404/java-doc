 专项 - 泛型（Generics）

> Java 5 引入，让类、接口、方法支持类型参数，在**编译期**完成类型检查，消除强制类型转换，提高代码复用性和安全性。

---

## 一、基础语法

```java
// 泛型类
public class Box<T> {
    private T value;
    public Box(T value) { this.value = value; }
    public T get() { return value; }
}

Box<String> strBox = new Box<>("hello");
Box<Integer> intBox = new Box<>(42);

// 泛型接口
public interface Converter<F, T> {
    T convert(F from);
}

// 泛型方法（独立于类的类型参数）
public static <T extends Comparable<T>> T max(T a, T b) {
    return a.compareTo(b) >= 0 ? a : b;
}
String larger = max("apple", "banana");   // "banana"
```

---

## 二、类型擦除（Type Erasure）

泛型信息**仅存在于编译期**，运行时被擦除（替换为原始类型或边界类型）。

```java
List<String> strings = new ArrayList<>();
List<Integer> ints   = new ArrayList<>();

// 编译期不同，运行时相同
System.out.println(strings.getClass() == ints.getClass()); // true
System.out.println(strings.getClass());                    // class java.util.ArrayList
```

**类型擦除的规则**：
- 无界类型参数 `<T>` → 擦除为 `Object`
- 有界类型参数 `<T extends Foo>` → 擦除为 `Foo`
- 多界 `<T extends Foo & Bar>` → 擦除为 `Foo`（第一个边界）

**由此引发的限制**：

```java
// ❌ 不能 new T()（擦除后无法知道实际类型）
T t = new T();

// ❌ 不能 new T[]
T[] arr = new T[10];

// ❌ 不能 instanceof 判断
if (obj instanceof List<String>) { }  // 编译报错

// ❌ 不能重载（擦除后签名相同）
void process(List<String> list) { }
void process(List<Integer> list) { }  // 编译报错：方法签名冲突

// ✅ 绕过：传入 Class<T>
public <T> T create(Class<T> clazz) throws Exception {
    return clazz.newInstance();
}
```

---

## 三、通配符

### 3.1 无界通配符 `<?>`

表示"任意类型"，只能读不能写（只能写入 `null`）：

```java
void printList(List<?> list) {
    for (Object obj : list) System.out.println(obj);  // 只读
    // list.add("x");  // ❌ 编译报错
}
```

### 3.2 上界通配符 `<? extends T>`（协变，Producer）

"某个 T 或 T 的子类"，可以安全地**读**，不能写：

```java
void sumList(List<? extends Number> list) {
    double sum = 0;
    for (Number n : list) sum += n.doubleValue();  // ✅ 可以读（返回 Number）
    // list.add(3.14);  // ❌ 编译报错（不知道具体子类型）
}

sumList(new ArrayList<Integer>());
sumList(new ArrayList<Double>());
```

### 3.3 下界通配符 `<? super T>`（逆变，Consumer）

"某个 T 或 T 的超类"，可以安全地**写**，读只能返回 `Object`：

```java
void addNumbers(List<? super Integer> list) {
    list.add(1);   // ✅ Integer 是 ? super Integer 的子类，可以写入
    list.add(2);
    Object obj = list.get(0);  // 读只能返回 Object
}

addNumbers(new ArrayList<Integer>());
addNumbers(new ArrayList<Number>());
addNumbers(new ArrayList<Object>());
```

---

## 四、PECS 原则

**Producer Extends，Consumer Super**：

- 如果集合是数据的**生产者**（只读），用 `<? extends T>`
- 如果集合是数据的**消费者**（只写），用 `<? super T>`
- 如果既读又写，不用通配符

```java
// 经典例子：Collections.copy
public static <T> void copy(List<? super T> dest,    // Consumer：要往 dest 写
                             List<? extends T> src) { // Producer：从 src 读
    for (T t : src) dest.add(t);
}
```

---

## 五、有界类型参数

```java
// 单边界：T 必须是 Number 的子类
public <T extends Number> double sum(List<T> list) {
    return list.stream().mapToDouble(Number::doubleValue).sum();
}

// 多边界：T 必须同时实现 Comparable 和 Serializable
public <T extends Comparable<T> & Serializable> T min(List<T> list) {
    return list.stream().min(Comparator.naturalOrder()).orElseThrow();
}

// 递归边界（自身引用）：Enum 的实际定义
public abstract class Enum<E extends Enum<E>> implements Comparable<E> { }
```

---

## 六、泛型与数组

泛型数组是 Java 设计上的"不安全区域"，不允许直接创建：

```java
// ❌ 不允许：类型安全无法保证
List<String>[] arr = new ArrayList<String>[10];

// ✅ 绕过方式（需 @SuppressWarnings）
@SuppressWarnings("unchecked")
List<String>[] arr = (List<String>[]) new ArrayList[10];
```

**根本原因**：数组是协变的（`String[]` is-a `Object[]`），而泛型是不变的（`List<String>` 不是 `List<Object>`）。两者混用会破坏类型安全。

---

## 七、常见面试问题

**Q：`List<Object>` 和 `List<?>` 有什么区别？**

`List<Object>` 只能传入 `List<Object>`，`List<?>` 可以接收任意 `List<Xxx>`，但 `List<?>` 不能添加元素（除 null）。

**Q：`List<? extends Number>` 和 `List<Number>` 有什么区别？**

`List<Number>` 只接受泛型参数精确为 `Number` 的 List；`List<? extends Number>` 可接受 `List<Integer>`、`List<Double>` 等，但不能写入（类型擦除后无法确定实际子类型）。

**Q：泛型类型在运行时能获取吗？**

直接创建的泛型类实例无法获取。但通过**匿名子类 + `getGenericSuperclass()`** 可以获取：

```java
// 利用匿名类保留泛型信息（TypeToken 技术）
Type type = new TypeToken<List<String>>(){}.getType();  // Gson 的做法
```

**Q：`<T extends Comparable<T>>` 中为什么要这样写？**

称为"递归泛型界"，确保 T 能与自身比较，例如 `String` 实现了 `Comparable<String>`，`Integer` 实现了 `Comparable<Integer>`。
