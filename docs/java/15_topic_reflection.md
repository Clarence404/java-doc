 专项 - 反射（Reflection）

> 运行时检查、修改类的结构和行为的能力。Spring IoC、MyBatis、Jackson 等主流框架的核心机制，同时也是安全审计和性能优化的关注点。

---

## 一、Class 对象的三种获取方式

```java
// 1. 类字面量（编译期已知类型，最安全、最高效）
Class<String> c1 = String.class;

// 2. 对象的 getClass()（运行时获取，已有实例时使用）
String s = "hello";
Class<?> c2 = s.getClass();

// 3. Class.forName()（类名字符串，动态加载，可能抛 ClassNotFoundException）
Class<?> c3 = Class.forName("java.lang.String");

System.out.println(c1 == c2);  // true（同一个 Class 对象）
```

---

## 二、获取类信息

```java
Class<?> clazz = ArrayList.class;

// 类名
clazz.getName();          // "java.util.ArrayList"（全限定名）
clazz.getSimpleName();    // "ArrayList"
clazz.getPackageName();   // "java.util"

// 修饰符
Modifier.isPublic(clazz.getModifiers());
Modifier.isAbstract(clazz.getModifiers());

// 继承关系
clazz.getSuperclass();                // AbstractList.class
clazz.getInterfaces();                // [List, RandomAccess, Cloneable, Serializable]
clazz.isInterface();
clazz.isEnum();
clazz.isAnnotation();
clazz.isArray();

// 泛型父类（保留泛型信息）
Type genericSuper = clazz.getGenericSuperclass();
```

---

## 三、字段操作

```java
Class<?> clazz = User.class;

// getField / getDeclaredField 的区别：
// getFields()         → 当前类 + 父类的 public 字段
// getDeclaredFields() → 当前类所有字段（包括 private），不含父类
Field[] fields = clazz.getDeclaredFields();

for (Field field : fields) {
    field.setAccessible(true);         // 绕过访问控制（见安全警告）
    Object value = field.get(instance);
    field.set(instance, newValue);
}

// 获取字段上的注解
if (field.isAnnotationPresent(Column.class)) {
    Column col = field.getAnnotation(Column.class);
    System.out.println(col.name());
}
```

---

## 四、方法操作

```java
// 获取方法
Method method = clazz.getDeclaredMethod("setName", String.class);
method.setAccessible(true);

// 调用方法
Object result = method.invoke(instance, "Alice");

// 获取方法参数信息（需要编译时加 -parameters 参数）
for (Parameter param : method.getParameters()) {
    System.out.println(param.getName() + ": " + param.getType());
}

// 获取方法上的注解
RequestMapping rm = method.getAnnotation(RequestMapping.class);
```

---

## 五、构造器与实例化

```java
// 无参构造（Java 9+ 不推荐 Class.newInstance，用 getDeclaredConstructor().newInstance()）
Object obj = clazz.getDeclaredConstructor().newInstance();

// 有参构造
Constructor<?> ctor = clazz.getDeclaredConstructor(String.class, int.class);
ctor.setAccessible(true);
Object user = ctor.newInstance("Alice", 25);
```

---

## 六、`setAccessible` 的安全隐患

```java
// ⚠️ 可以访问私有字段，破坏封装性
Field secretField = SensitiveClass.class.getDeclaredField("secret");
secretField.setAccessible(true);
String secret = (String) secretField.get(null);

// Java 9+ 模块系统限制：
// 跨模块访问需要 --add-opens 或模块显式 open
// java.base 内部类（如 String.value[]）默认拒绝
```

**Java 9+ 模块化的影响**：
- 强封装：`jdk.internal.*` 等包默认不可反射访问
- 框架迁移需要添加 `--add-opens java.base/java.lang=ALL-UNNAMED` 等 JVM 参数
- JEP 403（Java 17+）进一步收紧，部分历史 workaround 失效

---

## 七、性能代价与优化

反射调用比直接调用慢约 **10–100 倍**（主要开销：安全检查、方法查找、参数封箱）。

```java
// 性能优化手段

// 1. 缓存 Method / Field / Constructor 对象（避免重复 getDeclaredMethod）
private static final Map<String, Method> METHOD_CACHE = new ConcurrentHashMap<>();

// 2. setAccessible(true) 后缓存（跳过每次调用时的权限检查）
method.setAccessible(true);

// 3. 使用 MethodHandle（Java 7+）——更接近直接调用的性能
MethodHandles.Lookup lookup = MethodHandles.lookup();
MethodHandle mh = lookup.findVirtual(String.class, "length", MethodType.methodType(int.class));
int len = (int) mh.invoke("hello");

// 4. 框架级优化：字节码生成（ASM/ByteBuddy）替代反射
// MyBatis 的 Reflector、Hibernate 的 ByteBuddy 增强均采用此思路
```

---

## 八、主要应用场景

| 场景 | 框架 | 说明 |
|------|------|------|
| IoC 容器 | Spring | 扫描 `@Component`，通过反射创建 Bean、注入依赖 |
| ORM 映射 | MyBatis / JPA | 将 ResultSet 列映射到实体类字段 |
| JSON 序列化 | Jackson / Gson | 动态读写对象字段，生成/解析 JSON |
| 动态代理 | JDK Proxy | `InvocationHandler.invoke()` 拦截方法调用 |
| 注解处理（运行时） | 各种框架 | 读取 `@Transactional`、`@Cacheable` 等运行时注解 |
| 测试框架 | JUnit / Mockito | 访问私有方法，注入 Mock 对象 |

---

## 九、常见面试问题

**Q：反射能访问 private 方法吗？**

可以，通过 `setAccessible(true)` 绕过访问控制。但在 Java 9+ 的模块系统中，跨模块访问受 `--add-opens` 控制。

**Q：反射为什么慢？**

主要原因：① 每次调用需要安全权限检查；② 参数需要装箱为 `Object[]`；③ 无法 JIT 内联优化（无法确定目标方法）。缓存 `Method` 对象 + `setAccessible(true)` 可以大幅改善。

**Q：`getDeclaredMethods()` 和 `getMethods()` 的区别？**

`getMethods()` 返回当前类及**所有父类**的 public 方法；`getDeclaredMethods()` 返回**当前类**声明的所有方法（含 private/protected），不包含继承来的。

**Q：如何在运行时获取泛型的实际类型参数？**

通过 `getGenericSuperclass()` / `getGenericInterfaces()` 配合 `ParameterizedType`：

```java
// 典型：实现 TypeToken
class TypeToken<T> {
    final Type type;
    TypeToken() {
        type = ((ParameterizedType) getClass()
                    .getGenericSuperclass())
                    .getActualTypeArguments()[0];
    }
}
Type listStringType = new TypeToken<List<String>>(){}.type;
// java.util.List<java.lang.String>
```
