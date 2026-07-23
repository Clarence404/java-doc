# Java 总结-Java

## 一、JAVA 基本数据类型

Java语言中一共提供了8种原始的数据类型（**byte，short，int，long，float，double，char，boolean**），这些数据类型不是对象，
而是Java语言中不同于类的特殊类型，这些基本类型的数据变量在声明之后就会立刻**在栈上被分配内存空间**。

除了这8种基本的数据类型外， 其他类型都是引用类型（例如类、接口、数组等），引用类型类似于C++中的引用或指针的概念，
它以特殊的方式指向对象实体， 此类变量在声明时不会被分配内存空间，只是存储了一个内存地址而已。

| 数据类型    | 字节长度	 | 范围	                | 默认值        | 	包装类       |
|---------|-------|--------------------|------------|------------|
| int     | 	4	   | (-2^31~2^31-1)     | 	0         | 	Integer   |
| short   | 	2	   | [-32768,32767]	    | 0          | 	Short     |            |
| byte    | 	1    | 	[-128,127]        | 	0         | 	Byte      |
| long    | 8	    | (-2^63~2^63-1)     | 	0L或0l     | 	Long      |
| double  | 	8    | 64位IEEE754双精度范围    | 0.0        | 	Double    |
| float   | 	4    | 	32位IEEE754单精度范围   | 	0.0F或0.0f | 	Float     |
| char    | 	2    | 	Unicode [0,65535] | 	u0000     | 	Character |
| boolean | 	1    | 	true和false        | 	false     | 	Boolean   |

::: tip 抖音点赞 负数原因

点赞数通常存储在数据库的 int 或 bigint 类型字段中。如果某条视频的点赞数超出数据存储范围，可能会发生溢出，导致数值变为负数。例如：

- 若点赞数使用 int（最大值约 21 亿），超出范围后可能变成负数；

- 当变成负数时，继续累加，后续可能再次负值，形成int环；

- 处理不当的数据类型转换（如 int 转 short）也可能导致异常。

:::

## 二、String 类能被继承吗，为何不可变？

### 1、String 类不能被继承

- **原因**: `String` 类被声明为 `final`，即：
  ```java
  public final class String { ... }
  ```
    - `final` 修饰的类不能被继承。

    - 这是为了确保 `String` 的不可变性和安全性，防止子类修改其行为。

### 2、String 类的不可变性

`String` 类的不可变性是通过以下设计实现的：

1. **字符数组被声明为 `final`**:
   ```java
   private final byte[] value;
   ``` 
    - `final` 修饰的 `byte[]` 表示引用不可变（即不能指向其他数组），但数组内容本身是可以修改的。

2. **数组内容的保护**:
    - `String` 类没有提供任何方法修改 `value` 数组的内容。

    - 所有修改操作（如 `substring`、`concat`）都会返回一个新的 `String` 对象，而不是修改原对象。

## 三、讲讲类的加载机制

![img.png](../assets/interview/class_init.png)

当 Java 虚拟机（JVM）遇到一个类的引用时，它会按照 “**加载 -> 连接 -> 初始化**” 这三个步骤来加载类：

### 1、加载（Loading）

- 通过类加载器（ClassLoader）找到 .class 文件，并加载进内存。
- 生成 java.lang.Class 对象（即类的元数据）。

### 2、连接（Linking）

连接又包括以下 3 个子阶段：

- **验证（Verify）**：确保类的字节码符合 JVM 规范（如格式检查、安全检查）。

- **准备（Prepare）**：为静态变量分配内存，并初始化默认值（不会执行赋值语句）。

- **解析（Resolve）**：解析符号引用，将其替换为直接引用。

### 3、初始化（Initialization）

- 执行类的 静态变量 和 静态代码块，按它们在代码中的顺序执行。

- 只有在类真正被使用时才会触发初始化，例如：

    - 创建类的实例时 new 类()

    - 调用类的静态方法或访问静态变量

    - 反射调用 Class.forName("类名")

    - 作为父类时，子类初始化会触发父类的初始化

::: important 执行顺序
父类静态变量、父类静态代码块、子类静态变量、子类静态代码块、父类非静态变量（父类实例成员变量）、父类构造函数、子类非静态变量（子类实例成员变量）、子类构造函数。
:::

```java
class Parent {
    static String staticVar = initStaticVar(); // 1. 静态变量

    static {
        System.out.println("1. 父类的静态代码块");
    }

    String instanceVar = initInstanceVar(); // 3. 实例变量

    {
        System.out.println("3. 父类的实例代码块");
    }

    Parent() {
        System.out.println("4. 父类的构造方法");
    }

    static String initStaticVar() {
        System.out.println("0. 父类的静态变量初始化");
        return "staticVar";
    }

    String initInstanceVar() {
        System.out.println("2. 父类的实例变量初始化");
        return "instanceVar";
    }
}

class Child extends Parent {
    static {
        System.out.println("5. 子类的静态代码块");
    }

    {
        System.out.println("7. 子类的实例代码块");
    }

    Child() {
        System.out.println("8. 子类的构造方法");
    }
}

public class ClassLoadOrder {
    public static void main(String[] args) {
        new Child(); // 创建子类对象
    }
}

```

## 四、说说 Synchronized 和 ReentrantLock

详情见: <RouteLink to="/java/3_topic_lock">Java 专项-Lock 锁</RouteLink>

## 五、ConcurrentHashMap 为何放弃分段锁？

详情见: <RouteLink to="/java/0_base#四、concurrenthashmap-为何放弃分段锁">Java 基础：ConcurrentHashMap</RouteLink>

## 六、抽象类和接口的区别

### 1、定义和用法

| 特性	    | 抽象类（Abstract Class）                             | 	接口（Interface）                               |
 |--------|-------------------------------------------------|----------------------------------------------|
| 关键字	   | abstract class                                  | 	interface                                   |
| 方法	    | 既可以有抽象方法（无方法体），也可以有普通方法（有方法体）                   | 	只能有抽象方法（Java 8 之后可以有 default 方法和 static 方法） |
| 变量	    | 可以定义变量（实例变量、常量），可以有 private/protected/public 修饰 | 	只能定义 public static final 常量                 |
| 继承关系	  | 只能继承 一个 抽象类（单继承）	                               | 可以实现 多个 接口（多继承）                              |
| 构造方法	  | 可以有构造方法	                                        | 不能有构造方法                                      |
| 访问修饰符	 | 可以有 public、protected、private 方法	                | 方法默认 public abstract，不能 private 或 protected  |
| 适用场景	  | 适用于 父类和子类之间有 is-a 关系，代码复用性较强	                   | 适用于 不同类之间有相同的行为，更注重规范                        |

### 2、什么时候用抽象类或接口？

| 适用场景  | 	选择抽象类	                | 选择接口                               |
|-------|------------------------|------------------------------------|
| 代码复用  | 	适用于有共享代码的情况（比如提供默认实现） | 	不能提供成员变量和普通方法，所以代码复用性低            |
| 继承限制	 | 适用于需要强制单继承的情况          | 	适用于希望支持多继承的情况                     |
| 规范化	  | 适用于相似类型（有 is-a 关系）的类	  | 适用于不同类（没有 is-a 关系）的通用行为(can do 关系) |
| 复杂度   | 	适用于复杂的类层次结构           | 	适用于简单的、行为驱动的设计                    |

## 七、继承和聚合的区别？

### 1、定义对比

- 继承（Inheritance）：继承是一种“**is-a**”关系，表示一个类是另一个类的子类。子类继承父类的属性和方法，并可以扩展或重写它们。

- 聚合（Aggregation）：聚合是一种“**has-a**”关系，表示一个类包含另一个类的实例作为其成员。聚合关系是整体与部分的关系，部分可以独立于整体存在。

### 2、关系类型

- 继承：表示类之间的**层次关系**，子类是父类的一种特殊形式。

- 聚合：表示类之间的**关联关系**，一个类包含另一个类的实例。

### 3、代码示例

- 继承：

```java
class Animal {
    void eat() {
        System.out.println("Animal is eating");
    }
}

class Dog extends Animal {
    void bark() {
        System.out.println("Dog is barking");
    }
}
```

这里，Dog 是 Animal 的子类，继承了 Animal 的 eat 方法。

- 聚合：

```java
class Engine {
    void start() {
        System.out.println("Engine is starting");
    }
}

class Car {
    private Engine engine;

    Car(Engine engine) {
        this.engine = engine;
    }

    void start() {
        engine.start();
        System.out.println("Car is starting");
    }
}
```

这里，Car 类包含一个 Engine 类的实例，Car 和 Engine 是聚合关系。

## 八、说说Java的IO类

### 1、Java的IO分类梳理

![img.png](../assets/java/io.png)

### 2、为什么要进行序列化？

在Java中，**序列化（Serialization）** 是指将对象转换为字节流，以便存储或传输的过程。反序列化（Deserialization）则是将字节流恢复为对象的过程。序列化的主要作用如下：

**远程通信（分布式对象）**

- **对象序列化可以实现分布式对象**，例如 Java RMI（远程方法调用，Remote Method Invocation）。

- RMI 允许在不同的 JVM 之间传输对象，使远程主机上的服务像本地对象一样使用。

**数据持久化（存储与恢复）**

- **对象可以被序列化后存储在文件或数据库中**，方便后续恢复：

    - 例如：某个对象的状态可以被保存到文件，下次程序运行时，可以直接从文件中恢复，而不需要重新创建和初始化对象。

    - 适用于缓存、日志存储、数据备份等场景。

**深拷贝（Deep Copy）**

- **Java 对象序列化不仅保留对象的数据，而且递归保存对象引用的每个对象的数据**。

    - 这样可以将整个对象层次写入字节流，实现对象的 **深复制**（Deep Copy）。

**统一数据格式**

- **对象、文件、数据的格式各不相同，难以统一传输和存储**。

    - 但序列化后，所有数据都转换为字节流，使得不同系统之间能够轻松交换数据。

    - 例如，在网络通信中，可以将复杂对象转换成字节流发送给远程服务端，然后在服务端通过反序列化恢复原始对象。

### 3、serialVersionUID的作用

在Java的**序列化机制**中，`serialVersionUID` 是一个 **用于版本控制** 的唯一标识符，它的作用是确保反序列化时类的兼容性。

**serialVersionUID 的定义**

```java
private static final long serialVersionUID = 1L;
```

- `serialVersionUID` 是一个 `private static final long` 类型的字段。

- 它用于标识当前类的**版本**，确保序列化对象在不同版本的类中能够正确反序列化。

**serialVersionUID 的作用**

- Java 序列化机制会自动为每个类生成 `serialVersionUID`，但如果类发生改变（如字段增删、方法修改等），默认的 `serialVersionUID`
  可能会变化。

- 当反序列化时，如果 `serialVersionUID` 不匹配，就会抛出 `java.io.InvalidClassException` 异常，导致无法反序列化。

**为什么要手动指定 serialVersionUID**

- **如果不指定**，Java 会自动生成 `serialVersionUID`，但其计算方式依赖于类结构，类的微小修改（比如新增方法）可能会导致
  `serialVersionUID` 变化，从而影响反序列化兼容性。

- **如果手动指定**，则即使类发生了一些不影响反序列化的改动（比如新增方法），仍然可以正确反序列化旧对象，避免
  `InvalidClassException` 异常。

**serialVersionUID 的计算**

- 你可以使用 `serialver` 命令行工具查看某个类的 `serialVersionUID`：
  ```sh
  serialver -show -classpath . YourClassName
  ```

**总结**

- `serialVersionUID` 用于对象的**版本控制**，保证序列化对象在不同版本的类中能够正确反序列化。

- **推荐手动定义 `serialVersionUID`**，避免 Java 自动生成 `serialVersionUID` 带来的兼容性问题。

## 九、IO模型的理解

详情见: <RouteLink to="/netty/1_io_model">Netty-IO模型</RouteLink>

## 十、反射的基本原理

### 1、什么是反射？

反射（Reflection）是 Java 提供的一种强大机制，它允许程序在**运行时动态地获取类的信息**，并对类的成员（方法、字段、构造器）进行操作，
即使这些成员在编译时未知或被`private` 修饰。

> 简而言之：**反射是 Java 在运行时对类结构进行检查和操作的能力**。

### 2、反射的底层机制

反射的核心在于 JVM 中的 `Class` 类。每个被加载的类在内存中都会有一个唯一的 `Class` 对象，保存了该类的所有结构信息：

* 类的基本信息：类名、包名、修饰符、注解
* 成员信息：字段（`Field`）、方法（`Method`）、构造器（`Constructor`）
* 继承结构：父类、实现的接口

#### 常见的反射操作：

| 操作类型  | 方法示例                                   |
|-------|----------------------------------------|
| 获取类信息 | `Class.forName("com.example.Foo")`     |
| 获取字段  | `clazz.getDeclaredField("name")`       |
| 获取方法  | `clazz.getMethod("sayHello")`          |
| 实例化对象 | `clazz.getConstructor().newInstance()` |
| 调用方法  | `method.invoke(obj, args...)`          |
| 访问字段值 | `field.set(obj, "value")`              |

#### 示例代码：

```java
private void test() {
    Class<?> clazz = Class.forName("com.example.MyClass");
    Object instance = clazz.getConstructor().newInstance();

    Field field = clazz.getDeclaredField("name");
    field.setAccessible(true);
    field.set(instance, "Hello");

    Method method = clazz.getMethod("printName");
    method.invoke(instance);
}
```

### 3、反射的典型应用场景

Java 反射被广泛应用于各种框架和中间件的底层实现中，核心目的是**解耦编译时依赖、增强运行时灵活性**。以下是常见的五大场景：

#### 框架核心机制

诸如 Spring、MyBatis、Hibernate 等框架大量依赖反射实现核心功能：

* **依赖注入（DI）**：通过反射获取字段/构造器并注入依赖对象。
* **对象构造**：根据配置或注解动态实例化 Bean。
* **生命周期管理**：扫描注解、调用指定方法（如 `@PostConstruct`）初始化对象。

#### 动态类加载

反射结合 `Class.forName()` 可根据类名字符串动态加载类，典型如 JDBC 加载数据库驱动：

```java
Class<?> driverClass = Class.forName("com.mysql.cj.jdbc.Driver");
```

使得程序在运行时具备更强的适配能力。

#### 通用工具类

反射是许多工具库（如 Jackson、Gson、MapStruct）实现的基础：

* **对象序列化/反序列化**：根据字段名和类型动态转换 JSON、XML 等格式。
* **数据映射**：字段名相同的对象之间实现自动转换。

#### 注解解析与元编程

反射结合注解可以实现元编程能力，广泛用于：

* 框架自动配置（如 Spring Boot）
* 校验逻辑自动化（如 `@NotNull`）
* AOP 实现切面逻辑插入（日志、权限控制等）

示例：

```java
private void test() {
    if (clazz.isAnnotationPresent(Service.class)) {
        // 执行服务类的初始化逻辑
    }
}
```

#### 动态代理实现（AOP 核心）

JDK 动态代理和 CGLIB 代理均基于反射实现方法增强，是实现 AOP 的技术基础：

* **JDK Proxy**：面向接口生成代理对象（通过反射调用方法）
* **CGLIB**：字节码方式扩展类功能（反射实现底层访问与构造）

### 4、优缺点分析

| 优点           | 缺点                       |
|--------------|--------------------------|
| 运行时灵活性高      | 性能开销大（反射比直接调用慢）          |
| 可用于框架、通用工具开发 | 安全性较低，可绕过访问控制（如 private） |
| 支持解耦与动态行为    | 不利于重构，代码可读性差             |

### 5、注意事项与最佳实践

* 尽量避免在高频方法中频繁使用反射
* 反射对象（如 `Method`）可进行缓存提升性能
* 对私有成员设置 `setAccessible(true)` 时需谨慎，可能破坏封装性
* JDK 17+ 对反射访问做了更严格的模块限制（需加 VM 参数开启）

## 十一、除了反射，还有哪些动态代理？

### 1、常用的动态代理

| 动态代理方式     | 	是否依赖反射	 | 性能	 | 适用场景     | 	缺点          |
|------------|----------|-----|----------|--------------|
| JDK动态代理	   | 是	       | 慢	  | 接口代理	    | 依赖反射，性能较低    |
| CGLIB动态代理	 | 否	       | 快	  | 无接口代理	   | 不能代理 final 类 |
| Javassist  | 	否	      | 更快	 | 需要更高性能代理 | 	代码复杂，维护难    |
| ASM        | 	否       | 	最高 | 	框架底层优化  | 	代码复杂，难维护    |

### 2、何为静态代理？

实例代码：

```java
// 1. 定义接口
interface Subject {
    void request();
}

// 2. 真实对象
class RealSubject implements Subject {
    public void request() {
        System.out.println("真实对象的请求");
    }
}

// 3. 代理类
class Proxy implements Subject {
    private RealSubject realSubject;

    public Proxy(RealSubject realSubject) {
        this.realSubject = realSubject;
    }

    public void request() {
        preRequest();
        realSubject.request(); // 调用真实对象的方法
        postRequest();
    }

    private void preRequest() {
        System.out.println("代理前置处理");
    }

    private void postRequest() {
        System.out.println("代理后置处理");
    }
}

// 使用
public class Client {
    public static void main(String[] args) {
        RealSubject real = new RealSubject();
        Proxy proxy = new Proxy(real);
        proxy.request();
    }
}
```

## 十二、写出几种单例模式实现

### 1、懒汉式（线程不安全）

- 特点： 延迟初始化，调用 getInstance() 时才创建实例，但线程不安全。

```java
public class SingletonLazy {
    // 静态实例变量，初始为 null
    private static SingletonLazy instance;

    // 私有构造方法，防止外部实例化
    private SingletonLazy() {
    }

    public static SingletonLazy getInstance() {
        // 只有在需要时才创建
        if (instance == null) {
            instance = new SingletonLazy();
        }
        return instance;
    }
}
```

- 缺点： 多线程环境下，可能会出现多个线程同时进入 if (instance == null)，导致创建多个实例，线程不安全。

### 2、饿汉式（线程安全）

- 特点： 类加载时就创建实例，线程安全，但可能造成资源浪费。

```java
public class SingletonEager {
    // 直接初始化
    private static final SingletonEager instance = new SingletonEager();

    // 私有构造方法
    private SingletonEager() {
    }

    public static SingletonEager getInstance() {
        // 直接返回实例
        return instance;
    }
}
```

- 缺点： 类加载时即创建实例，即使从未使用，也会占用内存。

### 3、双重检查锁（DCL，推荐）

- 特点： 线程安全，且避免了资源浪费，是常见的最佳实践。

```java
public class SingletonDCL {
    // `volatile` 防止指令重排序
    private static volatile SingletonDCL instance;

    private SingletonDCL() {
    }

    public static SingletonDCL getInstance() {
        // 先检查实例是否存在
        if (instance == null) {
            // 线程同步
            synchronized (SingletonDCL.class) {
                // 二次检查
                if (instance == null) {
                    instance = new SingletonDCL();
                }
            }
        }
        return instance;
    }
}
```

- 优点：
    - 线程安全，只在第一次创建实例时加锁，提高性能。
    - 使用 volatile 防止指令重排，确保 instance 被正确初始化。

### 4、单例的几种实现对比总结

| 方式         | 	线程安全 | 	是否懒加载 | 	性能	             | 适用场景      |
|------------|-------|--------|------------------|-----------|
| 懒汉式        | 	❌ 否  | 	✅ 是   | 	⭐⭐⭐⭐（快但线程不安全）   | 	单线程环境    |
| 饿汉式        | 	✅ 是	 | ❌ 否    | 	⭐⭐⭐（加载即创建，资源浪费） | 	类加载后立即使用 |
| 双重检查锁（DCL） | 	✅ 是  | 	✅ 是   | 	⭐⭐⭐⭐⭐（高效安全）     | 	推荐，通用方案  |

如果你在实际开发中使用单例，DCL（双重检查锁）是最推荐的方式，因为它既保证了线程安全，又避免了资源浪费。

## 十三、类加载器机制

> 参考链接：[类加载器详解](https://javaguide.cn/java/jvm/classloader.html#%E7%B1%BB%E5%8A%A0%E8%BD%BD%E5%99%A8)

### 1、类加载器

![img.png](../assets/java/class_load.png)

### 2、双亲委派模型

上图展示的**各种类加载器之间的层次关系被称为类加载器的**“**双亲委派模型(Parents Delegation Model)**”。

双亲委派模型保证了 Java 程序的稳定运行:

- 可以**避免类的重复加载**（JVM 区分不同类的方式不仅仅根据类名，相同的类文件被不同的类加载器加载产生的是两个不同的类）
- 也保证了 **Java 的核心 API 不被篡改**。

::: tip

如果没有使用双亲委派模型，而是每个类加载器加载自己的话就会出现一些问题:

- 比如我们编写一个称为 java.lang.Object 类的话，那么程序运行的时候，系统就会出现两个不同的 Object 类。 双亲委派模型可以保证加载的是
  JRE 里的那个 Object 类，而不是你写的 Object 类。

- 这是因为 AppClassLoader 在加载你的 Object 类时，会委托给 ExtClassLoader 去加载，而 ExtClassLoader 又会委托给
  BootstrapClassLoader，BootstrapClassLoader 发现自己已经加载过了 Object 类，会直接返回，不会去加载你写的 Object 类。
  :::

## 十四、说说你对泛型的理解？

### 1、泛型定义

泛型的本质是参数化类型，也就是说所操作的数据类型被指定为一个参数，能够**解决代码复用**的问题。

常见的一种情况是，你有一个函数，它带有一个参数，参数类型是A，然而当参数类型改变成 B的时候，你不得不复制这个函数。

除此之外泛型的好处是在编译的时候检查类型安全，并且所有的强制转换都是自动和隐式的，消除显示的类型强制转换，以提高代码的重用率。使用方法：

```java
public class Stack<T> {
    private T[] m_item;

    public T Pop() {...}

    public void Push(T item) {...}

    public Stack(int i) {
        this.m_item = new T[i];
    }
}
```

类的写法不变，只是引入了通用数据类型T就可以适用于任何数据类型，并且类型安全的。如下这个类的调用方法：

```java
public void test() {

    //实例化只能保存int类型的类
    Stack<int> a = new Stack<int>(100);

    a.Push(10);

    //这一行编译不通过，因为类a只接收int类型的数据
    a.Push("8888");
    ...
}
```

### 2、`T、E、K、V、? `的含义

#### 2.1、`T - Type`

**含义**：T 通常用于表示一个 类型，在泛型类、泛型接口和泛型方法中作为类型参数使用。它是 "Type" 的缩写，表示该位置可以被替换为任何具体的类型。

**常见用法**：当你定义一个泛型类或方法时，通常会使用 T 来表示类或方法中的类型参数。

```java
public class Box<T> {
    private T value;

    public Box(T value) {
        this.value = value;
    }

    public T getValue() {
        return value;
    }
}
```

在这个例子中，T 可以是任何类型，创建 Box 时会指定具体类型。

#### 2.2、`E - Element`

**含义**：E 通常用于表示一个 元素类型，尤其是在集合类（如 List、Set、Map）中，表示集合的元素类型。E 是 "Element" 的缩写。

**常见用法**：当你定义集合类（例如 ```List<E>```）时，E 表示集合中每个元素的类型。

```java
public class ListWrapper<E> {
    private List<E> list;

    public void addElement(E element) {
        list.add(element);
    }

    public E getElement(int index) {
        return list.get(index);
    }
}
```

在这个例子中，E 代表集合 List 中的元素类型。

#### 2.3、 `K - Key`

**含义**：K 通常用于表示 键类型，尤其是在 Map 中，表示键的类型。K 是 "Key" 的缩写。

**常见用法**：当你定义 Map 或类似的键值对数据结构时，K 用于表示键的类型。

```java
public class MyMap<K, V> {
    private Map<K, V> map;

    public void put(K key, V value) {
        map.put(key, value);
    }

    public V get(K key) {
        return map.get(key);
    }
}
```

在这个例子中，K 代表键的类型，V 代表值的类型。

#### 2.4、 `V - Value`

**含义**：V 通常用于表示 值类型，特别是在 Map 这样的集合类中，表示值的类型。V 是 "Value" 的缩写。

**常见用法**：与 K 配对使用，在 Map 中用于表示键值对的值的类型。

示例：

```java
//（同上，V 已在 MyMap<K, V> 中解释）
```

#### 2.5、 `? - Wildcard (通配符)`

**含义**：? 是 通配符，用于表示一个未知类型。在泛型中，它通常表示一个不确定的类型，可以用作类型的占位符。
? 常用于方法、类或者集合的声明中，当你不关心类型具体是什么，只是想表明它是某种类型的子类或者父类时使用。

**常见用法**：? 常常出现在泛型的边界声明中，表示任意类型。常见的有 ? extends T 或 ? super T，表示可以接受某个类型的子类或父类。

```java
public void printList(List<?> list) {
    for (Object item : list) {
        System.out.println(item);
    }
}
```

这里的 List<?> 表示可以接受任意类型的 List，但无法修改该 List，只能读取其中的元素。

::: tip 总结

- T：表示一个类型，通常用于泛型类和方法的类型参数。
- E：表示元素类型，常用于表示集合中的元素类型。
- K：表示键类型，常用于表示 Map 中的键。
- V：表示值类型，常用于表示 Map 中的值。
- ?：表示通配符，表示不确定的类型，常用于方法参数、集合类型的限制等。
  :::

### 3、`其他通配符`

**`? extends T`**：表示某个类型是 T 的子类（包括 T 本身）。

**`? super T`**：表示某个类型是 T 的父类（包括 T 本身）。

示例：

```java
public void processNumbers(List<? extends Number> list) {
    for (Number num : list) {
        System.out.println(num);
    }
}

public void addIntegerToList(List<? super Integer> list) {
    list.add(42);  // 可以添加 Integer 或其父类类型的元素
}
```

### 4、 **Class&lt;T&gt;** 与 **Class&lt;?&gt;** 

- **Class&lt;T&gt;** 表示 **确定的类型**，T 是一个具体的泛型参数，使用时必须指定具体类型，例如 Class&lt;String&gt;。

- **Class&lt;?&gt;** 表示 **未知类型**，适用于不确定类型的情况，例如泛型方法或反射中，能够处理任何类型的 Class。

Class&lt;T&gt; 和 Class&lt;?&gt;

```java
public class ClassTypeDemo {

    public static void main(String[] args) {
        // Class<T> 用于已知类型
        Class<String> stringClass = String.class;
        // java.lang.String
        System.out.println("stringClass: " + stringClass.getName());

        // Class<?> 适用于未知类型
        // 传入 Integer
        Class<?> unknownClass = getClassType(42);
        // java.lang.Integer
        System.out.println("unknownClass: " + unknownClass.getName());
    }

    // 使用 Class<?> 处理不确定的类型
    public static Class<?> getClassType(Object obj) {
        return obj.getClass();
    }

}
```

泛型类示例

```java
// 定义泛型类
public static class MyObject<T> {
    private T value;

    public MyObject(T value) {
        this.value = value;
    }

    public T getValue() {
        return value;
    }
}

public class GenericExample {
    public static void main(String[] args) {
        // 使用 Class<T>，类型已知
        MyObject<String> obj = new MyObject<>("Hello");
        System.out.println("Value: " + obj.getValue());

        // 使用 Class<?>，可以处理任何类型
        MyObject<?> unknownObj = new MyObject<>(123);
        System.out.println("Unknown Value: " + unknownObj.getValue());
    }
}
```

### 5、类型擦除

Java 泛型是编译时的特性，在运行时，Java 会移除（擦除）泛型的类型信息，这称为 **类型擦除（Type Erasure）**。

**原因**： Java 的泛型是为了**向后兼容**（Generics 是 JDK 1.5 引入的，而 Java 需要兼容早期版本）。
**JVM 并不支持真正的泛型**，所有泛型信息在编译阶段就被擦除，JVM 看到的只有原始类型（Raw Type）。

**示例（泛型擦除前 vs. 擦除后）：**

```java
// 泛型代码
public class Box<T> {
    private T value;

    public void setValue(T value) {
        this.value = value;
    }

    public T getValue() {
        return value;
    }
}
```

**编译后（擦除后的字节码）：**

```java
// 擦除泛型后的代码
public class Box {
    // 泛型 T 变成 Object
    private Object value;

    public void setValue(Object value) {
        this.value = value;
    }

    public Object getValue() {
        return value;
    }
}
```

## 十五、说说 Lambda 表达式的底层原理

### 1、`@FunctionalInterface` 注解

`@FunctionalInterface` 是 Java 8 引入的注解，用于标识 **函数式接口**。

> **函数式接口**：只包含**一个抽象方法**的接口，常用于支持 **Lambda 表达式**。

#### 作用：

- ✅ **编译检查**：确保接口中只包含一个抽象方法，多个抽象方法会导致编译失败；
- ✅ **提高可读性**：即使不加注解，只要满足条件就是函数式接口，但加上注解更清晰直观；
- ✅ **启用 Lambda 支持**：Lambda 表达式可以赋值给任何函数式接口。

#### 示例：

```java

@FunctionalInterface
interface Greeting {
    void sayHello(String name);
}

public class LambdaTest {
    public static void main(String[] args) {
        // Lambda 表达式实现接口
        Greeting greeting = name -> System.out.println("Hello, " + name);
        greeting.sayHello("Tom");
    }
}
```

### 2、Lambda 的底层原理

> Lambda 表达式 **不是匿名内部类**，它们底层实现机制不同：  
> Lambda 是 Java 编译器配合 JVM 动态生成的一种“语法糖”，运行时由 JVM **动态创建函数对象**。

#### 2.1、Lambda 表达式的处理流程

**编译阶段**：编译器会把 Lambda 表达式的代码块提取成一个私有的 **静态方法**，名字类似 `lambda$main$0`。

**运行阶段**：使用 `invokedynamic` 字节码指令调用 **`LambdaMetafactory`**，由 JVM 动态生成一个实现目标函数式接口的实例。

**最终效果**：Lambda 表达式会变成一个调用静态方法的“函数对象”，并且只在运行时创建，不生成额外的 class 文件。

#### 2.2、Lambda 示例拆解

```java
Greeting greeting = name -> System.out.println("Hello, " + name);
```

编译后效果近似于：

```text
private static void lambda$main$0(String name) {
  System.out.println("Hello, " + name);
}

Greeting greeting = LambdaMetafactory.metafactory(
    ...,
            (String name) -> lambda$main$0(name)
);

```

注意：这里的 `LambdaMetafactory` 是 JVM 提供的工具类，用来动态生成类实现接口。

### 3、反编译验证

你可以使用 `javap -c` 命令来反编译字节码，观察编译器生成的结构：

```bash
javac LambdaTest.java
javap -c -p LambdaTest.class
```

会看到如下结果：

```text
Compiled from "LambdaTest.java"
public class com.dora.basic.LambdaTest {
  public com.dora.basic.LambdaTest();
  Code:
  0: aload_0
  1: invokespecial #1                  // Method java/lang/Object."<init>":()V
  4: return

  public static void main(java.lang.String[]);
  Code:
  0: invokedynamic #7,  0              // InvokeDynamic #0:sayHello:()Lcom/dora/basic/Greeting;
  5: astore_1
  6: aload_1
  7: ldc           #11                 // String Tom
  9: invokeinterface #13,  2           // InterfaceMethod com/dora/basic/Greeting.sayHello:(Ljava/lang/String;)V
  14: return

  private static void lambda$main$0(java.lang.String);
  Code:
  0: getstatic     #18                 // Field java/lang/System.out:Ljava/io/PrintStream;
  3: aload_0
  4: invokedynamic #24,  0             // InvokeDynamic #1:makeConcatWithConstants:(Ljava/lang/String;)Ljava/lang/String;
  9: invokevirtual #28                 // Method java/io/PrintStream.println:(Ljava/lang/String;)V
  12: return
}

```

::: tip
可以看到 `lambda$main$0` 是一个静态私有方法，代码就是 Lambda 里的逻辑。
:::

### 4、Lambda 表达式 VS 匿名内部类

| 对比项          | Lambda 表达式                                    | 匿名内部类                                       |
|--------------|-----------------------------------------------|---------------------------------------------|
| 是否生成新类       | ❌ 不生成类文件，由 JVM 动态生成函数对象                       | ✅ 编译时生成 `.class` 文件（如 `OuterClass$1.class`） |
| 编译原理         | 使用 `invokedynamic` + `LambdaMetafactory` 动态生成 | 使用 `new` 实例化一个匿名类                           |
| 写法简洁性        | ✅ 极简，函数式风格                                    | ❌ 冗长，需要写类体和方法重写                             |
| 性能           | ✅ 性能更优，JVM 可进行内联优化等                           | ❌ 每次创建新实例，略有性能开销                            |
| `this` 关键字指向 | 外部类的实例                                        | 当前匿名类的实例                                    |
| 使用限制         | 只能用于函数式接口                                     | 可实现多个方法、访问更多上下文信息                           |

## 十六、说说Java的Stream

### 1、Stream 流

- **Stream** 是 Java 8 引入的一个抽象，用于**声明式地操作集合**（如 `List`、`Set` 等）。
- **特点**：
    - 支持 **中间操作**（`filter()`、`map()`、`sorted()` 等）。
    - 支持 **终端操作**（`collect()`、`reduce()`、`forEach()` 等）。
    - **不会修改原始数据**，而是通过**流水线式转换**，且 **延迟执行**（懒加载）。

**示例**：

```java
private void test() {
    List<Integer> numbers = Arrays.asList(1, 2, 3, 4, 5);

    List<Integer> evenNumbers = numbers.stream()
            .filter(n -> n % 2 == 0)
            .collect(Collectors.toList());

    System.out.println(evenNumbers); // 输出 [2, 4]
}
```

### 2、Optional 类

`Optional` 是 Java 8 引入的类，**用来避免 `NullPointerException`**。

**创建方式**：

- `Optional.of()`：创建非空对象（`null` 会抛异常）。

- `Optional.ofNullable()`：创建可为空对象（`null` 返回空 Optional）。

- `Optional.empty()`：创建一个空 Optional。

#### **未使用 Optional（嵌套 if 判断）**

```java
public void test() {
    if (user != null) {
        if (user.getDept() != null) {
            String deptName = user.getDept().getName();
            if (StrUtil.isBlank(deptName)) {
                System.out.println("未指定部门");
            } else {
                System.out.println(deptName);
            }
        } else {
            System.out.println("未指定部门");
        }
    }
}
```

#### **使用 Optional（优雅流式写法）**

```java
private void test() {
    String deptName = Optional.ofNullable(user)           // 创建 Optional
            .map(User::getDept)                            // 提取 Dept
            .map(Dept::getName)                             // 提取 Dept 的名字
            .filter(StrUtil::isNotBlank)                   // 判断是否为空
            .orElse("未指定部门");                          // 终结操作（默认值）

    System.out.println(deptName);
}
```

### 3、Parallel Stream

#### **3.1、并行流的启动**

- **`parallel()` 方法**：将**顺序流**转换成**并行流**。

```java
private void test() {
    List<Integer> numbers = Arrays.asList(1, 2, 3, 4, 5);

    numbers.parallelStream().forEach(n -> {
        System.out.println(n + " - " + Thread.currentThread().getName());
    });
}
```

#### **3.2、并行流的底层原理**

- **数据分割**：通过 **`ForkJoinPool`**（分叉-合并框架）拆分成多个子任务，每个线程处理一部分数据。

- **结果合并**：归约（Reduction）采用 **分治法**，最终将各线程的部分结果合并成最终结果。

- **终止操作**（`reduce()`、`collect()`）会触发 **归约合并**。

- **底层原理**：详细原理见：<RouteLink to="/high-con/0_juc#fork-join-框架">Fork/Join框架</RouteLink>

### **4、并行流 vs 顺序流**

| 特点   | 顺序流 (Stream) | 并行流 (ParallelStream) |
|------|--------------|----------------------|
| 执行方式 | 单线程依次执行      | 多线程并行执行              |
| 性能   | 数据量大时性能低     | 数据量大时性能提升明显          |
| 线程安全 | 线程安全         | 需考虑线程安全问题            |
| 底层实现 | 普通迭代器        | ForkJoinPool 分治合并    |

::: tip

- 并行流虽然性能提升，但**不适合所有场景**，比如**需要有序输出**的情况就不推荐使用。

- 多线程带来的开销（线程创建、上下文切换等）在小数据集上反而会变慢。
  :::

## 十七、sort() 的底层算法

![img.png](../assets/java/sort_algorithm.png)

## 十八、常见算法的复杂度是多少？

更多详情，请查看: <RouteLink to="/algorithm/0_base_8_sort">算法-排序</RouteLink>

## 十九、Servlet 的生命周期

### 1、加载和实例化（Loading and Instantiation）

- 在这个阶段，类被加载到内存中并实例化。对于 Spring 容器来说，它会通过配置文件或注解扫描来加载和实例化 bean。
- Spring 容器会根据定义的 bean 配置（如 XML 或 Java Config）来创建对象实例。

### 2、初始化（Initialization）

- 在实例化之后，Spring 会处理初始化步骤，这通常包括依赖注入（DI）和 bean 的属性设置。
- 如果 bean 实现了 `InitializingBean` 接口或者在配置中定义了 `@PostConstruct` 注解的方法，Spring 会在初始化期间调用这些方法。

### 3、请求处理（Service）

- 这个阶段是对象发挥其主要功能的阶段，通常是处理业务逻辑或者响应外部请求。
- 对于 Web 应用来说，这个阶段通常与请求的处理和响应的生成有关。Spring MVC 中的控制器（controller）会处理 HTTP
  请求，执行业务操作，并返回相应的视图或数据。

### 4、销毁（Destruction）

- 当容器关闭或 bean 被销毁时，销毁方法会被调用。这通常是清理资源、关闭连接等操作的阶段。
- 如果 bean 实现了 `DisposableBean` 接口，或者通过 `@PreDestroy` 注解标记了销毁方法，Spring 会在销毁时调用这些方法。

### 5、图解生命周期

![img.png](../assets/java/servlet_cycle.png)

## 二十、如何解决哈希冲突？

- 定义：哈希冲突是指在哈希表中，两个或多个元素被映射到了同一个位置的情况。

### 1、 链式哈希法（Separate Chaining）

链式哈希是最常见的哈希冲突解决方法之一，它的基本思想是：每个哈希桶存储一个链表（或其他数据结构），如果多个元素有相同的哈希值，它们就会被存储在同一个链表中。

实现方式：

- 当发生哈希冲突时，所有具有相同哈希值的元素都会放入链表中，这样就能避免覆盖现有的数据。
- HashMap 中使用的是这种方法：当多个元素具有相同的哈希值时，它们会被存储在同一个桶（bucket）中，该桶会维护一个链表（或者更高效的树结构）。
- 当链表长度超过一定阈值时，HashMap 会将链表转换为红黑树，以提高查询效率。
  示例：
  假设我们有一个 HashMap，它使用链式哈希来解决冲突：

```java
import java.util.*;

public class HashMapExample {
    public static void main(String[] args) {
        Map<String, Integer> map = new HashMap<>();

        map.put("Apple", 1);
        map.put("Banana", 2);
        map.put("Orange", 3);
        map.put("Grapes", 4);
        // 发生哈希冲突，替换原有值
        map.put("Banana", 5);

        // 输出: {Apple=1, Banana=5, Orange=3, Grapes=4}
        System.out.println(map);
    }
}
```

在这个例子中，HashMap 可能会将 Apple 和 Banana 存储在相同的桶中，但它们会通过链表的形式来存储。

### 2、 开放地址法（Open Addressing）

开放地址法解决哈希冲突的方式是，当发生冲突时，系统会寻找其他空闲位置来存储元素。开放地址法通过探测方式找到合适的槽位置，它包括线性探测、二次探测和双重哈希等方法。

- 线性探测：当发生冲突时，按照线性顺序检查下一个槽位（即当前位置 + 1），直到找到空槽。
- 二次探测：根据某个二次函数来确定下一个槽位位置，以减少冲突。
- 双重哈希：使用第二个哈希函数来计算下一个槽位的偏移量。
  示例：
  Hashtable 是一个基于开放地址法的哈希集合，它使用开放地址法来解决哈希冲突：

```java
import java.util.Hashtable;

public class OpenAddressingExample {
    public static void main(String[] args) {
        Hashtable<Integer, String> table = new Hashtable<>();

        // 插入元素
        table.put(1, "One");
        table.put(2, "Two");
        table.put(3, "Three");
        table.put(4, "Four");

        // 打印元素
        System.out.println(table);
    }
}
```


