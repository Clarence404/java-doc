# 字节码与执行引擎

## 一、Class 文件结构

`.class` 文件是平台无关的二进制文件，JVM 通过它实现"一次编译，处处运行"。

```
ClassFile {
    u4  magic;                   // 魔数：0xCAFEBABE
    u2  minor_version;           // 次版本号
    u2  major_version;           // 主版本号（JDK 8=52, JDK 11=55, JDK 17=61, JDK 21=65）
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

**常量池**是 Class 文件的核心，存储字面量（字符串、数值）和符号引用（类名、方法名、字段名），解析阶段将符号引用替换为直接引用。

查看字节码：`javap -v -c ClassName.class`

---

## 二、栈帧结构

每次方法调用创建一个**栈帧**压入虚拟机栈，方法返回时弹出。

```
栈帧（Stack Frame）
├── 局部变量表（Local Variable Table）
│   └── 存储方法参数和局部变量（Slot 为基本单位，long/double 占 2 个 Slot）
│       实例方法的 slot[0] 是 this 引用
├── 操作数栈（Operand Stack）
│   └── 字节码指令的工作区，入栈/出栈执行运算
├── 动态链接（Dynamic Linking）
│   └── 指向运行时常量池中该方法的符号引用（运行时解析为直接引用）
└── 方法返回地址（Return Address）
    └── 记录调用者的 PC 值，方法结束后恢复执行
```

---

## 三、常用字节码指令

### 加载与存储

| 指令 | 说明 |
|------|------|
| `iload_0` / `aload_0` | 将局部变量表 slot[0] 的 int / 引用压入操作数栈 |
| `istore_1` / `astore_1` | 将栈顶 int / 引用存入 slot[1] |
| `bipush 10` | 将整数 10 压栈（-128~127）|
| `ldc #2` | 从常量池取常量压栈（字符串、类引用等）|

### 方法调用

| 指令 | 调用对象 |
|------|---------|
| `invokevirtual` | 实例方法（虚方法，多态分派） |
| `invokeinterface` | 接口方法 |
| `invokespecial` | 构造方法、私有方法、父类方法（静态分派）|
| `invokestatic` | 静态方法 |
| `invokedynamic` | 动态调用点（Lambda、方法句柄）|

### 对象操作

| 指令 | 说明 |
|------|------|
| `new` | 创建对象（分配内存 + 零值初始化）|
| `dup` | 复制栈顶引用（new 后调用构造方法前需要 dup）|
| `getfield` / `putfield` | 读写实例字段 |
| `getstatic` / `putstatic` | 读写静态字段 |
| `checkcast` | 类型检查（instanceof + 强转）|

---

## 四、invokedynamic 与 Lambda

`invokedynamic`（JDK 7 引入）在运行时动态确定调用目标，是 Lambda 表达式的底层实现。

```java
// Java 代码
list.stream().filter(x -> x > 10).collect(toList());

// 编译后 filter 的参数 Lambda 被编译为 invokedynamic 指令
// JVM 首次执行时调用 BootstrapMethod（LambdaMetafactory.metafactory）
// 动态生成实现 Predicate 接口的类，后续调用走 invokevirtual
```

优势：相比匿名内部类，不在编译期生成 `$1.class` 文件；JVM 可以选择最优的实现策略（内部类/方法引用/直接调用）。

---

## 五、执行引擎

JVM 执行字节码有两种模式，通常混合使用：

| 模式 | 原理 | 特点 |
|------|------|------|
| **解释执行** | 逐条翻译字节码为机器指令 | 启动快，执行慢 |
| **JIT 编译** | 将热点方法编译为本地机器码缓存 | 启动慢，执行快 |
| **混合模式**（默认）| 解释执行 + 热点方法 JIT 编译 | 平衡启动速度与峰值性能 |

JIT 编译详见 [6_jit](./7_jit)。

---

## 六、常见面试问题

**Q：字节码的执行是基于栈还是基于寄存器？**
JVM 字节码基于**操作数栈**（栈式架构），每条指令从操作数栈取操作数、结果压回栈。Android 的 Dalvik/ART 基于寄存器架构，指令更少但指令长度更长。

**Q：`i++` 和 `++i` 的字节码区别？**
`i++`：先 `iload`（读当前值到栈）再 `iinc`（原地加1），用的是旧值。
`++i`：先 `iinc` 再 `iload`，用的是新值。单独作为语句时两者字节码相同。

**Q：为什么 Lambda 用 `invokedynamic` 而不是匿名内部类？**
匿名内部类每个 Lambda 都生成一个 `$N.class`，增加类加载开销；`invokedynamic` 延迟到运行时生成，JVM 可以选择更高效的内联策略，且不产生额外类文件。
