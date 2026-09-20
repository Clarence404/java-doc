 专项 - 内部类（Inner Class）

> Java 支持在类内部定义类，分为四种：**成员内部类、静态嵌套类、局部类、匿名类**。合理使用可以增强封装性和逻辑聚合，但滥用会导致内存泄漏。

---

## 一、四种内部类对比

| 类型 | 声明位置 | 能否访问外部类成员 | 能否持有静态成员 | 典型使用场景 |
|------|----------|-------------------|-----------------|-------------|
| 成员内部类 | 类体内（非 static） | ✅ 实例 + 静态 | ❌（Java 16+ ✅） | 与外部类紧密耦合的辅助类 |
| 静态嵌套类 | 类体内（有 static） | ✅ 仅静态成员 | ✅ | Builder、工具类 |
| 局部类 | 方法体内 | ✅（只读 effectively final） | ❌ | 极少使用 |
| 匿名类 | 表达式中 | ✅（只读 effectively final） | ❌ | 单次使用的接口/抽象类实现 |

---

## 二、成员内部类

```java
public class Outer {
    private int x = 10;

    class Inner {
        void show() {
            System.out.println(x);           // 直接访问外部类私有字段
            System.out.println(Outer.this.x);// 明确引用外部类实例
        }
    }
}

// 创建：必须先有外部类实例
Outer outer = new Outer();
Outer.Inner inner = outer.new Inner();
inner.show();
```

**注意**：成员内部类持有外部类的隐式引用，若内部类实例生命周期长于外部类（如作为异步回调），会导致**外部类无法被 GC，造成内存泄漏**。

---

## 三、静态嵌套类（推荐优先使用）

```java
public class LinkedList<E> {
    private Node<E> head;

    static class Node<E> {           // 不持有外部类引用
        E item;
        Node<E> next;
        Node(E item, Node<E> next) {
            this.item = item;
            this.next = next;
        }
    }
}

// 创建：无需外部类实例
LinkedList.Node<String> node = new LinkedList.Node<>("hello", null);
```

**Builder 模式典型用法**：

```java
public class Pizza {
    private final String crust;
    private final String topping;

    private Pizza(Builder builder) {
        this.crust   = builder.crust;
        this.topping = builder.topping;
    }

    public static class Builder {
        private String crust   = "thin";
        private String topping = "cheese";

        public Builder crust(String crust)     { this.crust = crust;     return this; }
        public Builder topping(String topping) { this.topping = topping; return this; }
        public Pizza build() { return new Pizza(this); }
    }
}

Pizza pizza = new Pizza.Builder().crust("thick").topping("pepperoni").build();
```

---

## 四、局部类

定义在方法或代码块内，只在该作用域内可见，极少直接使用（匿名类更简洁）：

```java
void process(List<String> list) {
    final String prefix = "OK";   // effectively final

    class Validator {
        boolean isValid(String s) {
            return s.startsWith(prefix);   // 只能访问 effectively final 局部变量
        }
    }

    list.stream().filter(new Validator()::isValid).forEach(System.out::println);
}
```

---

## 五、匿名类

没有名字，在声明处同时创建实例，适合**一次性使用的简短实现**：

```java
// 接口匿名实现
Comparator<String> byLength = new Comparator<String>() {
    @Override
    public int compare(String a, String b) {
        return Integer.compare(a.length(), b.length());
    }
};
list.sort(byLength);

// 抽象类匿名实现
Thread t = new Thread(new Runnable() {
    @Override
    public void run() { System.out.println("running"); }
});
```

---

## 六、Lambda vs 匿名类

Java 8 的 Lambda 是函数式接口匿名实现的**语法糖**，但两者有本质差异：

| | Lambda | 匿名类 |
|--|--------|--------|
| 适用范围 | 只能实现**函数式接口**（单抽象方法） | 可实现任意接口/抽象类 |
| `this` 指向 | 外围类实例 | 匿名类自身实例 |
| 内存 | 不生成独立 `.class` 文件（invokedynamic） | 生成 `Outer$1.class` |
| 持有外部引用 | 不持有（除非捕获变量） | 非静态匿名类隐式持有外部类引用 |
| 可读性 | 更简洁 | 更显式 |

```java
// Lambda（推荐）
list.sort((a, b) -> Integer.compare(a.length(), b.length()));

// 匿名类（当需要多方法或访问 this 时）
list.sort(new Comparator<String>() {
    @Override
    public int compare(String a, String b) {
        System.out.println(this.getClass().getName()); // 匿名类自身
        return Integer.compare(a.length(), b.length());
    }
});
```

---

## 七、内部类与内存泄漏

**常见泄漏场景**：

```java
public class Activity {
    // ❌ 非静态内部类 Handler 持有 Activity 引用
    Handler handler = new Handler() {
        @Override
        public void handleMessage(Message msg) {
            Activity.this.update();  // Activity 无法被 GC
        }
    };
}

// ✅ 改为静态嵌套类 + WeakReference
static class SafeHandler extends Handler {
    WeakReference<Activity> ref;
    SafeHandler(Activity a) { ref = new WeakReference<>(a); }
    @Override
    public void handleMessage(Message msg) {
        Activity a = ref.get();
        if (a != null) a.update();
    }
}
```

**规则**：生命周期长于外部类的内部类（回调、监听器、异步任务），必须用静态嵌套类或弱引用。

---

## 八、常见面试问题

**Q：为什么局部类/匿名类只能访问 effectively final 的局部变量？**

局部变量存储在栈帧上，方法结束后消失。内部类实例可能在方法返回后继续存活，JVM 将捕获的变量**复制**到内部类实例中。若允许修改，副本与原始值会不一致，因此强制 effectively final。

**Q：静态嵌套类和成员内部类怎么选？**

默认选静态嵌套类，除非确实需要访问外部类实例的非静态成员。静态嵌套类不持有外部类引用，更安全、更轻量。

**Q：匿名类中 `this` 指向谁？**

匿名类自身实例。若要引用外部类，用 `OuterClass.this`。这是 Lambda 与匿名类的核心区别之一。
