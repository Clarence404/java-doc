---
description: 成员查找、record / sealed 反射、模块强封装、JEP 416、MethodHandle、隐藏类
---

# 反射

> 前置阅读：[泛型](./14_topic_generics)

反射是在运行时以对象形式访问类结构并据此创建实例、读写字段、调用方法的能力，Spring、Jackson、MyBatis、JUnit 都建立在它之上。本篇讲 Class / Field / Method / Constructor 的调用语义、模块系统对反射的限制（JDK 9 → 16 → 17）、JDK 18 之后的实现与性能，以及与 MethodHandle、VarHandle、字节码生成的取舍。

---

## 一、Class 对象

### 1、三种获取方式

```java
Class<String> c1 = String.class;                    // 类字面量：编译期已知，不触发类初始化
Class<?> c2 = "hello".getClass();                   // 运行时类型：已有实例时使用
Class<?> c3 = Class.forName("java.lang.String");    // 按全限定名加载：插件、驱动、配置驱动的场景

System.out.println(c1 == c2 && c2 == c3);           // true：同一类加载器下 Class 对象唯一
```

### 2、Class.forName 与 ClassLoader.loadClass

| 方法 | 是否初始化（执行 static 块） | 使用的类加载器 |
|------|------------------------------|----------------|
| `Class.forName(name)` | 是 | 调用者的类加载器 |
| `Class.forName(name, false, loader)` | 否 | 指定的加载器 |
| `loader.loadClass(name)` | 否，只加载 | 指定的加载器 |

老式 JDBC 写 `Class.forName("com.mysql.cj.jdbc.Driver")` 就是为了触发静态块注册驱动（JDBC 4 起驱动通过 [SPI 机制](./20_topic_spi) 自动注册，已不需要）。加载、链接、初始化的完整过程与双亲委派见 [类加载机制](/jvm/2_class_loading)。

### 3、类型信息

```java
Class<?> clazz = ArrayList.class;

clazz.getName();                 // "java.util.ArrayList"
clazz.getSimpleName();           // "ArrayList"
clazz.getPackageName();          // "java.util"
Modifier.isAbstract(clazz.getModifiers());
clazz.getSuperclass();           // AbstractList.class
clazz.getInterfaces();           // [List, RandomAccess, Cloneable, Serializable]
clazz.getGenericSuperclass();    // java.util.AbstractList<E>：带泛型签名，见泛型篇第七节
```

`getGenericSuperclass()` / `getGenericInterfaces()` / `Field.getGenericType()` 读取的是 class 文件中的 `Signature` 属性，这是运行时还原 `List<User>` 的唯一途径，完整用法与 TypeToken 实现见 [泛型](./14_topic_generics)。

---

## 二、成员查找语义

### 1、get 与 getDeclared 的区别

| 方法 | 范围 | 可见性 |
|------|------|--------|
| `getFields()` | 本类 + 所有父类 + 所有父接口（接口常量） | 仅 public |
| `getDeclaredFields()` | 仅本类声明 | 全部（含 private），不含继承 |
| `getMethods()` | 本类 + 父类 + 父接口（含继承来的 default 方法） | 仅 public |
| `getDeclaredMethods()` | 仅本类声明（含编译器生成的桥方法、合成方法） | 全部，不含继承 |
| `getConstructors()` / `getDeclaredConstructors()` | 仅本类（构造器不继承） | public / 全部 |

框架要拿到「父类的 private 字段」（如实体基类的 `id`），只能沿 `getSuperclass()` 逐级调用 `getDeclaredFields()`，Spring 的 `ReflectionUtils.doWithFields` 就是这样做的。`getDeclaredMethods()` 返回的顺序**没有保证**，不要依赖它。

### 2、字段与方法

```java
Field field = User.class.getDeclaredField("name");
field.setAccessible(true);                      // 绕过 private，受模块规则约束（见第四节）
Object value = field.get(user);
field.set(user, "Alice");

Method setter = User.class.getDeclaredMethod("setName", String.class);
setter.invoke(user, "Bob");                     // 静态方法第一个参数传 null

Constructor<User> ctor = User.class.getDeclaredConstructor(String.class, int.class);
User u = ctor.newInstance("Alice", 25);         // 代替 JDK 9 起废弃的 Class.newInstance()
```

方法参数名默认不进 class 文件，`Parameter.getName()` 只能得到 `arg0`。编译时加 `-parameters` 才能拿到真实名字；使用 `spring-boot-starter-parent` 或 Spring Boot Gradle 插件时默认开启。Spring 6.1 起不再从调试信息推断参数名，没加 `-parameters` 的工程 `@PathVariable` 等不写名字的绑定会失败。

### 3、调用异常要解包

被调用方法自己抛出的异常会被包装成 `InvocationTargetException`，日志里只看到这一层很难排查：

```java
try {
    method.invoke(target, args);
} catch (InvocationTargetException e) {
    Throwable cause = e.getCause();             // 真正的业务异常
    if (cause instanceof RuntimeException re) throw re;
    if (cause instanceof Error err) throw err;
    throw new IllegalStateException(cause);     // 受检异常按调用方约定处理
} catch (IllegalAccessException e) {
    throw new IllegalStateException(e);         // 访问控制失败，属于编程错误
}
```

动态代理的 `InvocationHandler` 中同样要做这一步，见 [动态代理](./16_topic_proxy)。

### 4、注解读取

`getAnnotation` 只能读到 `@Retention(RUNTIME)` 的注解。`@Inherited` 只对**类上**的注解生效，接口上的注解、方法上的注解都不会被继承。框架实际使用的是更强的查找逻辑：Spring 的 `AnnotatedElementUtils.findMergedAnnotation` / `MergedAnnotations` 会沿父类、接口、桥方法查找，并支持元注解与 `@AliasFor` 属性合并——这也是 `@GetMapping` 能被识别成 `@RequestMapping` 的原因。

---

## 三、新语言特性的反射 API

| 版本 | API | 用途 |
|------|-----|------|
| JDK 16 | `Class.isRecord()`、`getRecordComponents()`、`RecordComponent.getAccessor()` | 按组件顺序拿到 record 的字段与访问器，Jackson 2.12+ 反序列化 record 依赖它 |
| JDK 17 | `Class.isSealed()`、`getPermittedSubclasses()` | 列出密封类允许的子类，可用于多态序列化类型注册 |
| JDK 15 | `Class.isHidden()`、`MethodHandles.Lookup.defineHiddenClass` | 隐藏类，见第七节 |

```java
record Point(int x, int y) { }

for (RecordComponent rc : Point.class.getRecordComponents()) {
    System.out.println(rc.getName() + " = " + rc.getAccessor().invoke(new Point(1, 2)));
}
// record 只能通过规范构造器创建：
Constructor<Point> canonical = Point.class.getDeclaredConstructor(
        Arrays.stream(Point.class.getRecordComponents()).map(RecordComponent::getType).toArray(Class<?>[]::new));
```

record 与隐藏类的 final 字段即使 `setAccessible(true)` 也**不能**通过 `Field.set` 修改。

---

## 四、模块系统与强封装

### 1、版本演进

| 版本 | 默认行为 | 说明 |
|------|----------|------|
| JDK 8 及以前 | 任意 `setAccessible(true)` | 没有模块边界 |
| JDK 9 – 15 | `--illegal-access=permit` | 对 JDK 内部的非法反射访问仍然成功，首次访问打印警告 |
| JDK 16（JEP 396） | `--illegal-access=deny` | 默认拒绝，抛 `InaccessibleObjectException`，还可手动改回 permit |
| JDK 17（JEP 403） | 移除 `--illegal-access` | 只剩 `--add-opens` / `--add-exports` 或 jar 清单中的 `Add-Opens` 能放开 |

被移除的「历史 workaround」就是 `--illegal-access=permit`：很多老框架在 JDK 16 前靠它静默工作，升级到 17 后必须改为显式的 `--add-opens`：

```bash
java --add-opens java.base/java.lang=ALL-UNNAMED -jar app.jar
```

`sun.misc.Unsafe` 位于 `jdk.unsupported` 模块，仍可访问，但它的内存访问方法在 JDK 23 被标记为待移除（JEP 471），JDK 24 起首次调用打印警告（JEP 498），替代品是 `VarHandle` 与 FFM API。

### 2、正确的打开方式

- **模块化应用**：在 `module-info.java` 里 `opens com.example.entity to com.fasterxml.jackson.databind;`，只对需要的框架开放；
- **类路径应用**（绝大多数 Spring Boot 项目）：应用自己的类都在未命名模块，彼此之间反射不受限，受限的只是对 JDK 内部的访问；
- **跨模块访问私有成员的标准做法**：`MethodHandles.privateLookupIn(Target.class, MethodHandles.lookup())`（JDK 9），前提是目标模块对调用方 open，比 `setAccessible` 更明确。

### 3、修改 final 字段即将被禁止

通过深度反射修改 final 字段（`Field.set`）一直「能用」，但会破坏 JIT 对 final 的常量折叠假设。JDK 26（JEP 500）起这类修改默认打印警告，`--illegal-final-field-mutation=deny` 可以提前验证；JEP 明确未来会默认拒绝。需要保留时用 `--enable-final-field-mutation=ALL-UNNAMED` 显式声明，仅 `--add-opens` 不能消除警告。依赖反射给 final 字段注入值的老代码（部分序列化库、测试工具）应尽早改成构造器注入。

---

## 五、实现与性能

### 1、JDK 18 前后的调用路径

![Method.invoke 的调用路径：JDK 18 前后](../assets/java/reflection_invoke_path.svg)

- **JDK 8 – 17**：`Method.invoke` 先走 `NativeMethodAccessorImpl`（JNI 调用，启动快但慢），同一方法调用超过阈值（`sun.reflect.inflationThreshold`，默认 15）后「膨胀」为运行时生成的 `GeneratedMethodAccessorN` 字节码类，峰值性能更好。线上 dump 中大量 `GeneratedMethodAccessor` 类和元空间增长就来自这里。
- **JDK 18+（JEP 416）**：`Method`、`Constructor`、`Field` 统一改用方法句柄实现，只在 VM 启动早期（方法句柄机制就绪之前）使用 native 反射。

JEP 416 给出的基准数据：`Method` / `Field` 存在 `static final` 字段中（JIT 可常量折叠）时，新实现比旧实现快 43%–57%；不能常量折叠时（存在普通字段、Map、数组中），字段访问比旧实现慢 51%–77%，但 Jackson、XStream、Kryo 的基准没有观察到退化。另外 JDK 24（JEP 486）起 Security Manager 被永久禁用，反射调用不再有安全管理器检查。

### 2、剩下的开销在哪里

不要背「反射比直接调用慢 10–100 倍」这类固定倍数，它取决于 JDK 版本、调用点是否为常量、是否被 JIT 内联。现在真实存在的成本是：

- **查找**：`getDeclaredMethod` 要遍历并复制成员数组，是最贵的一步——必须缓存 `Method` / `Field` 对象；
- **访问检查**：结果会缓存在 `Method` 对象上，`setAccessible(true)` 主要用于绕过 private，不再是主要的性能手段；
- **参数与返回值**：可变参数分配 `Object[]`，基本类型装箱 / 拆箱；
- **异常包装**：每次抛异常都多包一层 `InvocationTargetException`；
- **调用点不是常量**：从 Map 里取出的 `Method` 对 JIT 是不透明的，难以内联，热点路径上是主要差距来源。

结论是：框架式用法（缓存成员对象、每个类只解析一次元数据）在 JDK 21 上通常不是瓶颈；是否需要优化，用 [基准测试（JMH）](/high-perf/4_benchmark) 测量后再决定。

### 3、MethodHandle 与 VarHandle

```java
public final class UserAccessor {
    private static final MethodHandle GET_NAME;
    private static final VarHandle AGE;

    static {
        try {
            MethodHandles.Lookup lookup = MethodHandles.privateLookupIn(User.class, MethodHandles.lookup());
            GET_NAME = lookup.findVirtual(User.class, "getName", MethodType.methodType(String.class));
            AGE = lookup.findVarHandle(User.class, "age", int.class);
        } catch (ReflectiveOperationException e) {
            throw new ExceptionInInitializerError(e);
        }
    }

    public static String name(User u) throws Throwable {
        return (String) GET_NAME.invokeExact(u);     // 签名必须与 MethodType 精确一致，包括返回值强转
    }

    public static boolean casAge(User u, int expect, int update) {
        return AGE.compareAndSet(u, expect, update);  // 原子操作，替代 Unsafe 与 AtomicIntegerFieldUpdater
    }
}
```

MethodHandle「接近直接调用」是**有条件**的：句柄放在 `static final` 字段中（对 JIT 是常量），并用 `invokeExact` 或类型精确匹配的调用。放在实例字段或 Map 里的句柄同样难以内联，用 `invoke`（会做类型适配）也会多一层转换，此时不一定比 JDK 18+ 的 `Method.invoke` 快。`VarHandle`（JDK 9）提供字段与数组元素的普通 / volatile / acquire-release / CAS 访问，是 `java.util.concurrent` 内部替换 `Unsafe` 的方案。

### 4、更进一步：生成代码代替反射

对热点路径，框架会生成直接调用的代码，彻底消除反射：

| 方式 | 典型用户 |
|------|----------|
| 运行时字节码生成（ByteBuddy、ASM） | Hibernate 实体增强（ByteBuddy）、Mockito（ByteBuddy） |
| `LambdaMetafactory` 生成函数式接口实现 | 一些高性能 Bean 拷贝 / 属性访问库 |
| 编译期代码生成（注解处理器） | MapStruct、Lombok、Dagger |
| 构建期 AOT | Spring AOT 生成 Bean 定义代码 |

MyBatis 的 `Reflector` 不属于这一类：它是按类缓存的反射元数据（getter / setter 对应的 `Invoker`），底层仍然是 `Method` / `Field` 调用，优化思路是「只解析一次」。

---

## 六、隐藏类

隐藏类（JDK 15，JEP 371）是通过 `Lookup.defineHiddenClass` 定义、**不能被其他类按名字引用或被类加载器查找到**的类，可以随宿主一起卸载。JDK 内部用它实现 Lambda 表达式（`LambdaMetafactory` 生成的类）和字符串拼接等，取代了此前非公开的 `Unsafe.defineAnonymousClass`（已在 JDK 17 移除）。对使用者的影响：

- 隐藏类 `Class.forName` 找不到，`isHidden()` 返回 true，类名中带 `/`（如 `Foo$$Lambda/0x...`）；
- 它的 final 字段不能被反射修改；
- 框架在运行时生成类时也应优先用 `defineHiddenClass` 或 `Lookup.defineClass`，而不是反射调用 `ClassLoader.defineClass`（后者需要 `--add-opens java.base/java.lang`）。

---

## 七、应用场景与生产注意事项

### 1、主要应用场景

| 场景 | 框架 | 反射做了什么 |
|------|------|--------------|
| 依赖注入 | Spring | 扫描注解、调用构造器、注入字段 / setter，见 [IoC 容器](/spring/1_ioc) |
| 结果映射 | MyBatis / Hibernate | 把列值写入实体属性 |
| 序列化 | Jackson / Gson | 读取属性、泛型签名与 record 组件 |
| 动态代理 | JDK Proxy / Spring AOP | 代理把调用分派为 `Method` 对象，见 [动态代理](./16_topic_proxy) |
| 测试 | JUnit / Mockito | 发现测试方法、注入 Mock |

### 2、GraalVM Native Image 与 AOT

Native Image 在构建期做封闭世界分析，运行时**只能**反射构建期登记过的类和成员，否则抛 `ClassNotFoundException` / `NoSuchMethodException` 或静默拿不到成员。Spring Boot 3 的 AOT 引擎会为自己知道的 Bean 自动生成 reflect-config；业务代码中按字符串拼类名、自己反射的地方，要通过 `RuntimeHintsRegistrar`（或 `@RegisterReflectionForBinding`）补登记。详见 [启动与部署优化](/spring-boot/14_startup)。

### 3、安全

- 不要把外部输入直接当作类名或方法名反射调用，这等同于任意代码执行入口；反序列化漏洞（见 [序列化](./19_topic_serialization)）本质就是让反序列化器反射实例化了攻击者指定的类；
- `setAccessible(true)` 只在必要的框架边界使用，业务代码应通过公开 API 访问。

---

## 小结

- 获取 `Class` 有字面量、`getClass()`、`Class.forName` 三种；`forName` 默认触发初始化，`loadClass` 不会
- `getXxx()` 返回含继承（包括父接口）的 public 成员，`getDeclaredXxx()` 只返回本类声明的全部成员；父类私有字段要逐级查找
- 反射调用的业务异常包在 `InvocationTargetException` 中，必须 `getCause()` 解包
- JDK 16 默认拒绝对 JDK 内部的非法反射，JDK 17 移除 `--illegal-access`，只能用 `--add-opens`；JDK 26 起反射修改 final 字段会警告
- JDK 18（JEP 416）起反射基于方法句柄实现：常量调用点更快，非常量的字段访问反而变慢；性能问题用 JMH 量化，首要手段是缓存成员对象
- MethodHandle 只有在 `static final` + `invokeExact` 时才接近直接调用；VarHandle 取代 `Unsafe` 做字段的原子访问
- 隐藏类承载 Lambda 等运行时生成的类；Native Image 下所有反射目标都要在构建期登记

## 参考资料

- `java.lang.reflect` API（JDK 21）：[https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/lang/reflect/package-summary.html](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/lang/reflect/package-summary.html)
- JEP 416 用方法句柄重新实现核心反射：[https://openjdk.org/jeps/416](https://openjdk.org/jeps/416)
- JEP 396 / JEP 403 强封装 JDK 内部：[https://openjdk.org/jeps/396](https://openjdk.org/jeps/396) / [https://openjdk.org/jeps/403](https://openjdk.org/jeps/403)
- JEP 371 隐藏类：[https://openjdk.org/jeps/371](https://openjdk.org/jeps/371)
- JEP 500 让 final 名副其实（准备阶段）：[https://openjdk.org/jeps/500](https://openjdk.org/jeps/500)

> 下一篇：[动态代理](./16_topic_proxy) —— 反射加上运行时生成类，就得到了 AOP、RPC 客户端、Mapper 接口背后的动态代理。
