# 类加载机制

## 一、类加载过程

`.class` 文件进入 JVM 经历五个阶段（验证/准备/解析合称**链接**）：

```
加载 → 验证 → 准备 → 解析 → 初始化 → 使用 → 卸载
```

### 加载（Loading）

- 通过类全限定名获取 `.class` 二进制字节流（文件/网络/动态生成）
- 字节流转为方法区的运行时数据结构
- 在堆中生成该类的 `Class` 对象作为访问入口

### 验证（Verification）

确保字节流符合 JVM 规范，包含四个检查：
1. **文件格式**：魔数（`0xCAFEBABE`）、版本号
2. **元数据**：语义分析（是否继承 final 类等）
3. **字节码**：操作数栈类型、跳转指令合法性
4. **符号引用**：类/字段/方法可访问性

### 准备（Preparation）

- 为**类变量**（static 字段）分配内存并赋**零值**（0 / null / false）
- `static final` 常量例外，直接赋指定值（编译期常量）

```java
public static int value = 123;       // 准备阶段：value = 0
public static final int MAX = 100;   // 准备阶段：MAX = 100
```

### 解析（Resolution）

将符号引用（字符串描述）替换为直接引用（内存地址/偏移量）：
- 类或接口引用、字段引用、方法引用

### 初始化（Initialization）

执行 `<clinit>` 方法（静态变量赋值 + 静态代码块，父类先于子类）。

**触发初始化的时机（主动引用）：**
1. `new` 实例、读写静态字段、调用静态方法
2. 反射调用
3. 初始化子类时先初始化父类
4. JVM 启动时的主类
5. `invokedynamic` 指令

---

## 二、类加载器体系

```
Bootstrap ClassLoader     加载 JAVA_HOME/lib（rt.jar 等），C++ 实现，Java 层获取为 null
       ↑ 父加载器
Extension/Platform ClassLoader   加载 JAVA_HOME/lib/ext（JDK9+ 改为 Platform ClassLoader）
       ↑ 父加载器
Application ClassLoader   加载 classpath，即用户代码和第三方库
       ↑ 父加载器（可选）
Custom ClassLoader        自定义，继承 ClassLoader，重写 findClass()
```

### 自定义类加载器

```java
public class CustomClassLoader extends ClassLoader {
    private final String classPath;

    public CustomClassLoader(String classPath) {
        this.classPath = classPath;
    }

    @Override
    protected Class<?> findClass(String name) throws ClassNotFoundException {
        try {
            byte[] data = loadClassData(name);
            return defineClass(name, data, 0, data.length);
        } catch (IOException e) {
            throw new ClassNotFoundException(name);
        }
    }

    private byte[] loadClassData(String name) throws IOException {
        String path = classPath + name.replace('.', '/') + ".class";
        try (InputStream in = new FileInputStream(path);
             ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            int b;
            while ((b = in.read()) != -1) out.write(b);
            return out.toByteArray();
        }
    }
}
```

---

## 三、双亲委派模型

### 工作流程

```
收到加载请求
    ↓
检查缓存（findLoadedClass），已加载直接返回
    ↓
委托父加载器（直到 Bootstrap）
    ↓
父加载器无法加载（ClassNotFoundException）
    ↓
自己尝试加载（findClass）
    ↓
仍失败则抛 ClassNotFoundException
```

### 核心实现（ClassLoader.loadClass）

```java
protected Class<?> loadClass(String name, boolean resolve) throws ClassNotFoundException {
    synchronized (getClassLoadingLock(name)) {
        Class<?> c = findLoadedClass(name);
        if (c == null) {
            try {
                c = parent != null ? parent.loadClass(name, false)
                                   : findBootstrapClassOrNull(name);
            } catch (ClassNotFoundException ignored) {}
            if (c == null) {
                c = findClass(name); // 自己加载
            }
        }
        if (resolve) resolveClass(c);
        return c;
    }
}
```

### 优点

1. **避免重复加载**：同一个类只加载一次
2. **保证核心类安全**：`java.lang.String` 永远由 Bootstrap 加载，用户无法替换

---

## 四、打破双亲委派

重写 `loadClass()` 方法（不调用 `super.loadClass()`）即可打破。

### SPI 机制

`java.sql.Driver` 接口由 Bootstrap 加载，但实现类（`com.mysql.cj.jdbc.Driver`）在第三方 jar 中，Bootstrap 无法加载。
解决：使用**线程上下文类加载器**（`Thread.currentThread().getContextClassLoader()`）向下委托加载实现类。

### Tomcat 多应用隔离

每个 Web 应用有独立的 `WebappClassLoader`，优先自己加载应用内的类，实现不同应用间的类隔离（相同类名不冲突）。

```
Bootstrap ClassLoader
    ↑
Common ClassLoader（Tomcat 公共类）
    ↑
WebappClassLoader（每个 Web 应用独立）
```

### OSGi 模块化

每个 Bundle 有独立类加载器，类查找是网状结构（而非树形），根据模块依赖关系决定由哪个 Bundle 的类加载器加载。

### 热部署

创建新的类加载器加载新版本的类，旧类加载器随旧对象回收后被 GC 掉，实现不重启更新代码。

---

## 五、常见面试问题

**Q：如何判断两个类是否相同？**
类全限定名相同 + 加载它的类加载器相同，缺一不可。不同类加载器加载的同名类是两个不同的类，互相不可转型（ClassCastException）。

**Q：为什么 Tomcat 需要打破双亲委派？**
同一 Tomcat 实例可以部署多个 Web 应用，应用间可能依赖同一类库的不同版本；双亲委派会让所有应用共享同一个版本，而 Tomcat 通过独立的 `WebappClassLoader` 实现版本隔离。

**Q：`static final` 字段为什么在准备阶段直接赋值，而不是初始化阶段？**
编译期常量（基本类型 / String 的字面量）在编译时就确定了值，写入了 Class 文件的 ConstantValue 属性；准备阶段直接读取该属性赋值，无需执行 `<clinit>`。若是引用类型（`new Object()`），仍在初始化阶段赋值。
