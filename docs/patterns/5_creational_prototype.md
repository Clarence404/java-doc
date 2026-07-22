# 原型模式

**作用**：通过**克隆**已有对象来创建新对象，避免重复初始化昂贵的对象。

**应用场景**：
- Spring `scope=prototype`（每次注入都创建新实例）
- 对象创建成本高（含大量计算/IO），但多处需要相似的初始状态
- BeanUtils 属性复制（`BeanUtils.copyProperties`）

---

## 一、浅拷贝（Shallow Copy）

实现 `Cloneable` 接口，`clone()` 方法只复制基本类型和引用地址，**引用类型字段共享同一对象**。

```java
@Data
public class UserConfig implements Cloneable {
    private Long   userId;
    private String theme;
    private List<String> permissions;   // 引用类型：浅拷贝后两者共享同一 List

    @Override
    public UserConfig clone() {
        try {
            return (UserConfig) super.clone();  // 浅拷贝
        } catch (CloneNotSupportedException e) {
            throw new RuntimeException(e);
        }
    }
}

UserConfig original = new UserConfig(1L, "dark", new ArrayList<>(List.of("read", "write")));
UserConfig copy     = original.clone();

copy.getPermissions().add("admin");  // 同时影响 original.permissions（共享引用）
```

---

## 二、深拷贝（Deep Copy）

手动递归拷贝，或通过序列化实现：

```java
// 方式一：手动深拷贝（推荐，性能好）
public UserConfig deepCopy() {
    UserConfig copy = new UserConfig();
    copy.setUserId(this.userId);
    copy.setTheme(this.theme);
    copy.setPermissions(new ArrayList<>(this.permissions));  // 复制 List 内容
    return copy;
}

// 方式二：序列化（适合图结构复杂的对象，但有性能开销）
public static <T extends Serializable> T deepCopy(T obj) throws Exception {
    ByteArrayOutputStream bos = new ByteArrayOutputStream();
    new ObjectOutputStream(bos).writeObject(obj);
    return (T) new ObjectInputStream(
        new ByteArrayInputStream(bos.toByteArray())).readObject();
}
```

---

## 三、注意事项

| 事项 | 说明 |
|------|------|
| 优先复制构造方法 | 比 `Cloneable` 更安全、更可控，Java 推荐 |
| `clone()` 的缺陷 | `Object.clone()` 绕过构造方法，可能破坏不变式 |
| 深拷贝 vs 浅拷贝 | 有嵌套可变对象时必须深拷贝，否则修改副本会影响原对象 |

```java
// 优先用复制构造方法，而不是 Cloneable
public UserConfig(UserConfig other) {
    this.userId      = other.userId;
    this.theme       = other.theme;
    this.permissions = new ArrayList<>(other.permissions);
}
```
