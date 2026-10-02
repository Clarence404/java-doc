---
description: 加载过程、主动 / 被动引用、类加载器体系（JDK 9+ 模块化）、双亲委派及打破方式
---

# 类加载机制

> **本篇目标**：掌握类从 `.class` 字节流到可用 `Class` 对象的五个阶段、初始化的触发时机，以及类加载器的委派模型和它被打破的典型场景。
>
> **前置阅读**：[内存结构](./1_memory)

---

## 一、类加载过程

**一个类的生命周期是：加载 → 验证 → 准备 → 解析 → 初始化 → 使用 → 卸载，其中验证、准备、解析合称链接（Linking）。** 各阶段按顺序开始，但可以交叉进行；解析可以推迟到初始化之后（用于支持动态绑定）。

| 阶段 | 做什么 | 要点 |
|------|-------|------|
| 加载 | 获取字节流，生成类元数据与 `Class` 对象 | 字节流来源不限（文件、网络、动态生成） |
| 验证 | 确认字节流合法、安全 | 可用 `-XX:-BytecodeVerificationRemote` 等关闭部分验证，生产不建议 |
| 准备 | 为静态变量分配内存并赋零值 | 编译期常量此时直接赋值 |
| 解析 | 符号引用 → 直接引用 | 可延迟到首次使用时（惰性解析） |
| 初始化 | 执行 `<clinit>` | 只有"主动引用"才会触发 |

### 1、加载（Loading）

- 通过类的全限定名获取二进制字节流
- 将字节流代表的静态结构转为方法区（元空间）中的运行时数据结构
- 在堆中生成对应的 `java.lang.Class` 对象，作为访问这些元数据的入口

### 2、验证（Verification）

确保字节流符合 JVM 规范、不会危害虚拟机：

1. **文件格式**：魔数 `0xCAFEBABE`、版本号是否在当前 JVM 支持范围内
2. **元数据**：语义检查，如是否继承了 `final` 类、是否实现了抽象方法
3. **字节码**：借助 `StackMapTable` 校验操作数栈类型、跳转目标是否合法
4. **符号引用**：解析时检查引用的类、字段、方法是否存在且可访问

### 3、准备（Preparation）

- 为**类变量**（`static` 字段）分配内存并赋**零值**（0 / null / false）；实例变量不在此阶段处理
- 编译期常量（`static final` 且值为基本类型或 `String` 字面量）例外：值已写入 Class 文件的 `ConstantValue` 属性，准备阶段直接赋值

```java
public static int value = 123;                  // 准备阶段 value = 0，初始化阶段才赋 123
public static final int MAX = 100;              // 准备阶段直接 MAX = 100
public static final Object LOCK = new Object(); // 不是编译期常量，初始化阶段才赋值
```

### 4、解析（Resolution）

把常量池中的**符号引用**（用字符串描述的类、字段、方法）替换为**直接引用**（指针、偏移量或句柄）。HotSpot 多数采用惰性解析：某条指令第一次用到该引用时才解析。

### 5、初始化（Initialization）

**初始化即执行编译器生成的 `<clinit>` 方法**，它按源码顺序收集静态变量赋值和 `static {}` 块。

- 父类的 `<clinit>` 先于子类执行；接口初始化时不要求先初始化父接口
- JVM 保证 `<clinit>` 在多线程下只执行一次且加锁执行，这是静态内部类单例线程安全的基础；若 `<clinit>` 中阻塞，其他线程也会一直等待

---

## 二、初始化时机：主动引用与被动引用

### 1、主动引用（有且只有 6 种）

JVM 规范规定，以下情况必须立即对类进行初始化：

1. 执行 `new`、`getstatic`、`putstatic`、`invokestatic` 四条指令：创建实例、读写静态字段（编译期常量除外）、调用静态方法
2. 通过 `java.lang.reflect` 反射调用类，如 `Class.forName("X")`（默认初始化）、`Method.invoke`
3. 初始化一个类时，其父类尚未初始化，先初始化父类
4. JVM 启动时，包含 `main` 方法的主类
5. `MethodHandle` 实例解析结果为 `REF_getStatic`、`REF_putStatic`、`REF_invokeStatic`、`REF_newInvokeSpecial` 句柄，且对应类尚未初始化
6. 接口定义了 `default` 方法时，其实现类初始化会先触发该接口初始化

### 2、被动引用（不会触发初始化）

除上述 6 种之外的引用都是被动引用，典型有三类：

```java
class Parent {
    static { System.out.println("Parent init"); }
    public static int value = 1;
}
class Child extends Parent {
    static { System.out.println("Child init"); }
}
class Const {
    static { System.out.println("Const init"); }
    public static final String HELLO = "hello";
}

// 1. 通过子类引用父类的静态字段：只初始化 Parent，不初始化 Child
System.out.println(Child.value);          // 输出 Parent init、1

// 2. 定义该类的数组：不初始化 Parent，只创建数组类 [LParent;
Parent[] arr = new Parent[10];            // 无输出

// 3. 引用编译期常量：常量在编译时已内联到调用方常量池，不初始化 Const
System.out.println(Const.HELLO);          // 只输出 hello
```

::: tip ClassLoader.loadClass 也不会初始化
`ClassLoader.loadClass(name)` 只加载不初始化；`Class.forName(name)` 默认会初始化，可用 `Class.forName(name, false, loader)` 关闭。JDBC 早期写法 `Class.forName("com.mysql.cj.jdbc.Driver")` 正是依赖初始化来执行驱动的静态注册块。
:::

---

## 三、类加载器体系

**JDK 9 起类加载器按模块划分职责：Bootstrap 加载核心模块，Platform 加载部分平台模块，Application 加载 classpath 与模块路径上的应用类。**

| 加载器 | 加载范围（JDK 9+） | 实现 | JDK 8 对照 |
|--------|-------------------|------|-----------|
| Bootstrap | `java.base`、`java.logging` 等核心模块 | JVM 内部实现，Java 中获取为 `null` | 加载 `jre/lib` 下的 `rt.jar` 等 |
| Platform | `java.sql`、`java.xml.crypto` 等部分平台模块 | `ClassLoader.getPlatformClassLoader()` | Extension ClassLoader，加载 `jre/lib/ext` |
| Application | classpath 与 `--module-path` 上的应用类 | `ClassLoader.getSystemClassLoader()` | 同名，只加载 classpath |
| 自定义 | 开发者指定的来源 | 继承 `ClassLoader`，重写 `findClass()` | 同 |

- 父子关系：Application → Platform → Bootstrap，它是**组合关系**（`parent` 字段），不是继承
- 模块化后的委派调整：加载器收到请求时，先根据包名查找该包属于哪个已命名模块，若该模块归某个加载器负责就**直接交给它**；找不到对应模块，才沿父加载器向上委派
- JDK 9 起 `lib/ext` 与 `-Djava.ext.dirs` 已移除，扩展机制改由模块路径承担

### 1、判断两个类是否相同

**类的唯一性由"全限定名 + 定义它的类加载器"共同确定。** 同一个 `.class` 文件被两个加载器加载，得到的是两个不同的类，相互赋值会抛 `ClassCastException`，`instanceof` 也返回 `false`。

### 2、自定义类加载器

只重写 `findClass()` 即可保留双亲委派；需要打破委派时才重写 `loadClass()`。

```java
public class CustomClassLoader extends ClassLoader {
    private final Path classPath;

    public CustomClassLoader(Path classPath, ClassLoader parent) {
        super(parent);
        this.classPath = classPath;
    }

    @Override
    protected Class<?> findClass(String name) throws ClassNotFoundException {
        Path file = classPath.resolve(name.replace('.', '/') + ".class");
        try {
            byte[] data = Files.readAllBytes(file);
            return defineClass(name, data, 0, data.length);
        } catch (IOException e) {
            throw new ClassNotFoundException(name, e);
        }
    }
}
```

---

## 四、双亲委派模型

**类加载器收到请求时，先交给父加载器处理，父加载器无法完成时才自己加载。**

### 1、工作流程

1. 调用 `findLoadedClass` 检查本加载器是否已加载过，命中直接返回
2. 未命中则委托父加载器的 `loadClass`；父加载器为 `null` 时交给 Bootstrap
3. 父加载器链一直向上，直到 Bootstrap
4. 父加载器都找不到（抛出或返回 `null`），才调用自己的 `findClass` 加载
5. 自己也找不到，抛出 `ClassNotFoundException`

### 2、核心实现（ClassLoader.loadClass，简化）

```java
protected Class<?> loadClass(String name, boolean resolve) throws ClassNotFoundException {
    synchronized (getClassLoadingLock(name)) {
        Class<?> c = findLoadedClass(name);
        if (c == null) {
            try {
                c = parent != null ? parent.loadClass(name, false)
                                   : findBootstrapClassOrNull(name);
            } catch (ClassNotFoundException ignored) {
                // 父加载器找不到，交给自己
            }
            if (c == null) {
                c = findClass(name);
            }
        }
        if (resolve) resolveClass(c);
        return c;
    }
}
```

### 3、为什么需要双亲委派

- **避免重复加载**：同一个类由固定的加载器加载一次，保证全局唯一
- **保护核心类库**：`java.lang.String` 永远由 Bootstrap 加载，用户自定义的同名类无法替换它；即使自定义加载器绕过委派，`defineClass` 也会拒绝定义 `java.*` 包下的类（`SecurityException: Prohibited package name`）

---

## 五、打破双亲委派

**重写 `loadClass()` 改变委派顺序，或者让父加载器反过来借用子加载器，都属于打破双亲委派。** 常见场景有 SPI、Web 容器隔离、OSGi 和热部署。

### 1、SPI 与线程上下文类加载器

`java.sql.Driver`、`DriverManager` 由上层加载器加载（JDK 8 为 Bootstrap，JDK 9+ 为 Platform），而驱动实现（如 `com.mysql.cj.jdbc.Driver`）在 classpath 的第三方 jar 里，上层加载器看不到。

解决办法是**线程上下文类加载器**（TCCL）：`ServiceLoader.load(Driver.class)` 内部取 `Thread.currentThread().getContextClassLoader()`（默认为 Application ClassLoader），由它加载实现类，相当于父加载器"向下"请求子加载器。SPI 机制本身详见 [Java SPI 机制](/java/20_topic_spi)。

### 2、Tomcat 多应用隔离

**Tomcat 为每个 Web 应用创建独立的 WebApp ClassLoader，优先加载应用自己的类，从而让不同应用使用同一类库的不同版本而互不干扰。**

![Tomcat 类加载器层级](../assets/jvm/tomcat-classloader.svg)

| 加载器 | 加载内容 | 可见范围 |
|--------|---------|---------|
| Bootstrap / System | JDK 类库、Tomcat 启动类 | 所有 |
| Common | `$CATALINA_HOME/lib` | Tomcat 与所有 Web 应用 |
| Catalina / Shared | 由 `server.loader` / `shared.loader` 配置，默认为空（即合并到 Common） | 仅 Tomcat 内部 / 所有 Web 应用 |
| WebApp | `WEB-INF/classes`、`WEB-INF/lib` | 仅本应用 |

WebApp ClassLoader 的查找顺序：JDK 类先交给上层加载，防止应用覆盖核心类；其余类**先在本应用内查找**，找不到再委派 Common。这一"先自己后父亲"的顺序正是对双亲委派的打破。

### 3、OSGi 模块化

每个 Bundle 有独立的类加载器，类查找是网状结构而非树形：按 `Import-Package` / `Export-Package` 声明，把请求委派给导出该包的 Bundle 的加载器。

### 4、热部署与类卸载

创建新的类加载器加载新版本类，旧加载器被丢弃后连同其加载的类一起被回收，实现不重启更新代码。类被卸载需要同时满足：

- 该类的所有实例都已被回收
- 加载该类的类加载器已被回收
- 该类的 `Class` 对象没有被任何地方引用

由 Bootstrap / Platform / Application 加载的类在 JVM 运行期间基本不会被卸载；热部署频繁时若旧加载器被静态字段、线程、`ThreadLocal` 等持有，会导致元空间泄漏，排查方法见 [故障排查](./9_troubleshooting)。

---

## 小结

- 类加载分加载、验证、准备、解析、初始化五个阶段；准备阶段赋零值，编译期常量例外
- 初始化只由 6 种主动引用触发；子类引用父类静态字段、定义数组、引用编译期常量都是被动引用
- JDK 9+ 加载器为 Bootstrap / Platform / Application，委派前先按模块定位加载器；类的唯一性 = 全限定名 + 类加载器
- 双亲委派保证核心类安全与唯一；SPI 借 TCCL 反向加载，Tomcat 以"先自己后父亲"实现应用隔离

> 下一篇：[字节码执行](./3_bytecode) —— 类加载完成后，方法里的字节码长什么样、JVM 又是如何执行它的。
