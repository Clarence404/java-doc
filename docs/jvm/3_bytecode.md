# 字节码执行

> **本篇目标**：能读懂 `javap` 输出，理解栈帧结构、五条方法调用指令与分派机制，以及 Lambda 背后的 `invokedynamic`。
>
> **前置阅读**：[类加载机制](./2_class_loading)

---

## 一、Class 文件结构

**`.class` 文件是与平台无关的二进制格式，JVM 只认它而不关心源语言，这是"一次编译，处处运行"和多语言共用 JVM 的基础。**

```c
ClassFile {
    u4  magic;                   // 魔数：0xCAFEBABE
    u2  minor_version;           // 次版本号
    u2  major_version;           // 主版本号，见下表
    u2  constant_pool_count;     // 常量池大小
    cp_info constant_pool[];     // 常量池（字面量 + 符号引用）
    u2  access_flags;            // 类访问标志（public/final/abstract 等）
    u2  this_class;              // 本类索引
    u2  super_class;             // 父类索引
    u2  interfaces_count;
    u2  interfaces[];
    u2  fields_count;
    field_info fields[];
    u2  methods_count;
    method_info methods[];       // 方法表（含 Code 属性，即字节码指令）
    u2  attributes_count;
    attribute_info attributes[];
}
```

| JDK | 8 | 11 | 17 | 21 | 25 |
|-----|---|----|----|----|----|
| major_version | 52 | 55 | 61 | 65 | 69 |

- 主版本号 = JDK 版本 + 44；JVM 拒绝加载高于自身版本的 Class 文件，报 `UnsupportedClassVersionError`
- **常量池**是 Class 文件的核心，存储字面量（字符串、数值）和符号引用（类名、方法名、字段名与描述符），类加载的解析阶段把符号引用替换为直接引用
- 查看字节码：`javap -v -p ClassName.class`（`-v` 输出常量池与字节码，`-p` 包含私有成员）

---

## 二、栈帧结构

**每次方法调用都会创建一个栈帧压入当前线程的虚拟机栈，方法返回时弹出；栈帧大小在编译期就已确定，写在 Code 属性的 `max_locals` 与 `max_stack` 中。**

| 组成 | 作用 | 要点 |
|------|------|------|
| 局部变量表 | 存放方法参数和局部变量 | 以 Slot 为单位，`long` / `double` 占 2 个；实例方法的 slot 0 是 `this` |
| 操作数栈 | 字节码指令的工作区 | 指令从栈顶取操作数，结果压回栈顶 |
| 动态链接 | 指向运行时常量池中该栈帧所属方法的引用 | 支持调用过程中把符号引用解析为直接引用 |
| 方法返回地址 | 方法结束后回到调用者的位置 | 正常返回取调用者的 PC；异常退出由异常表决定 |

以一个简单方法为例，看操作数栈如何工作：

```java
int add(int a, int b) {
    return a + b;
}
```

```text
0: iload_1      // 局部变量表 slot 1（a）压栈
1: iload_2      // slot 2（b）压栈
2: iadd         // 弹出两个 int，相加后结果压栈
3: ireturn      // 返回栈顶 int
```

JVM 字节码是**基于栈的指令集**：指令短、不依赖具体硬件寄存器，便于移植；代价是完成同样的计算需要更多条指令。Android 的 Dalvik / ART 则采用基于寄存器的指令集。

---

## 三、常用字节码指令

### 1、加载与存储

| 指令 | 说明 |
|------|------|
| `iload_0` / `aload_0` | 将局部变量表 slot 0 的 int / 引用压入操作数栈 |
| `istore_1` / `astore_1` | 将栈顶 int / 引用存入 slot 1 |
| `iconst_0` ~ `iconst_5` | 将 0~5 的 int 常量压栈（另有 `iconst_m1` 表示 -1） |
| `bipush 10` / `sipush 1000` | 将 byte（-128~127）/ short 范围的整数压栈 |
| `ldc #2` | 从常量池取常量压栈（int、float、字符串、类引用等） |
| `iinc 1, 1` | 直接把 slot 1 的 int 加 1，不经过操作数栈 |

### 2、对象操作

| 指令 | 说明 |
|------|------|
| `new` | 分配对象内存并赋零值，把引用压栈（尚未执行构造方法） |
| `dup` | 复制栈顶引用：一份给 `invokespecial <init>` 消耗，一份留给后续赋值 |
| `getfield` / `putfield` | 读写实例字段 |
| `getstatic` / `putstatic` | 读写静态字段 |
| `checkcast` | 强制类型转换检查，失败抛 `ClassCastException` |
| `instanceof` | 类型判断，结果 0 / 1 压栈 |

### 3、方法调用

| 指令 | 调用目标 | 目标何时确定 |
|------|---------|-------------|
| `invokestatic` | 静态方法 | 编译期（非虚调用） |
| `invokespecial` | 构造方法 `<init>`、私有方法、`super.method()` | 编译期（非虚调用） |
| `invokevirtual` | 普通实例方法（含 `final` 方法） | 运行期按实际类型查虚方法表；`final` 方法例外，也是非虚调用 |
| `invokeinterface` | 接口方法 | 运行期按实际类型查找（接口方法表） |
| `invokedynamic` | 由引导方法在运行期决定 | 首次执行时链接调用点 |

**非虚调用**指目标方法在编译期就唯一确定、运行期不会因接收者类型而改变，包括静态方法、私有方法、构造方法、父类方法和 `final` 方法。

### 4、静态分派与动态分派

两者描述的是"选哪个方法版本"，与上面的指令名称不是一回事：

| 对比项 | 静态分派 | 动态分派 |
|--------|---------|---------|
| 典型体现 | 方法**重载**（Overload） | 方法**重写**（Override） |
| 依据 | 参数的**静态类型**（声明类型） | 接收者的**实际类型** |
| 发生时机 | 编译期，由 javac 选定方法符号引用 | 运行期，由 `invokevirtual` / `invokeinterface` 查找 |

```java
Animal a = new Dog();
feed(a);      // 静态分派：按声明类型 Animal 选中 feed(Animal)，而非 feed(Dog)
a.speak();    // 动态分派：运行期按实际类型 Dog 调用 Dog.speak()
```

HotSpot 为每个类维护**虚方法表（vtable）**和**接口方法表（itable）**，动态分派时按索引查表，避免逐级搜索父类；JIT 还会借助类型 profiling 做内联缓存与去虚化，详见 [JIT 编译](./7_jit)。

---

## 四、invokedynamic 与 Lambda

**`invokedynamic`（JDK 7 引入）把"调用哪个方法"推迟到运行期由用户指定的引导方法决定；Lambda、JDK 9+ 的字符串拼接（`StringConcatFactory`）都建立在它之上。**

```java
list.stream().filter(x -> x > 10).collect(toList());
```

javac 编译时做两件事：把 Lambda 体生成为本类的私有方法（如 `lambda$main$0`），并在使用处生成一条 `invokedynamic` 指令，其引导方法为 `LambdaMetafactory.metafactory`。运行期流程：

1. **首次执行**该 `invokedynamic`：调用引导方法 `LambdaMetafactory`，在内存中生成实现 `Predicate` 接口的类（JDK 15+ 为隐藏类 Hidden Class，JEP 371），返回一个 `CallSite` 并与这条指令**链接**
2. **后续执行**同一条 `invokedynamic`：直接走已链接的 `CallSite` 拿到函数式接口实例，不再调用引导方法；不捕获变量的 Lambda 通常每次返回同一个实例
3. `filter` 内部调用 `Predicate.test()` 时，走的是普通的 **`invokeinterface`**，最终委托到 `lambda$main$0`

与匿名内部类相比：

| 对比项 | 匿名内部类 | Lambda |
|--------|-----------|--------|
| 编译产物 | 每个匿名类生成一个磁盘 `Outer$1.class` | 不生成额外的磁盘 `.class`，实现类在运行期于内存中生成 |
| 类加载 | 启动时按需加载每个 `$N.class` | 首次执行时生成，之后复用调用点 |
| 实现策略 | 编译期固定 | 由 JDK 的 `LambdaMetafactory` 决定，升级 JDK 即可改进，无需重新编译 |
| `this` 含义 | 匿名类实例 | 外围类实例 |

---

## 五、执行引擎

**HotSpot 默认采用混合模式：先解释执行，热点代码再交给 JIT 编译为本地机器码。**

| 模式 | 原理 | 特点 | 参数 |
|------|------|------|------|
| 解释执行 | 模板解释器逐条执行字节码 | 启动快，无需等待编译，执行慢 | `-Xint` 强制纯解释 |
| JIT 编译 | 把热点方法 / 循环编译为本地机器码并缓存到 Code Cache | 编译有开销，峰值性能高 | `-Xcomp` 强制优先编译 |
| 混合模式（默认） | 解释执行 + 分层编译热点代码 | 兼顾启动速度与峰值性能 | `-Xmixed` |

热点探测、分层编译与各项优化详见 [JIT 编译](./7_jit)。

---

## 小结

- Class 文件以 `0xCAFEBABE` 开头，主版本号 = JDK 版本 + 44（JDK 8=52、17=61、21=65、25=69），常量池是核心
- 栈帧由局部变量表、操作数栈、动态链接、返回地址组成，大小编译期确定；JVM 是基于栈的指令集
- `invokestatic` / `invokespecial`（以及 `final` 方法）是非虚调用；静态分派对应重载，动态分派对应重写
- Lambda 首次执行 `invokedynamic` 时由 `LambdaMetafactory` 生成实现类并链接调用点，之后直接复用；函数式方法本身经 `invokeinterface` 调用
- 执行引擎默认混合模式：解释器保证启动，JIT 负责峰值性能

> 下一篇：[GC 原理](./4_gc_theory) —— 对象不再被使用后，JVM 如何判断它已死亡、又用哪些算法回收内存。
