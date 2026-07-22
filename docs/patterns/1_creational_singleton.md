# 单例模式

**作用**：保证类在 JVM 中只有一个实例，提供全局访问点。

**应用场景**：
- Spring Bean 默认单例（由容器保证）
- 数据库连接池（HikariCP、Druid）
- Redis 客户端、线程池、日志管理器

---

## 一、懒汉式（线程不安全）

延迟初始化，但多线程下可能创建多个实例，**仅适合单线程**。

```java
public class SingletonLazy {
    private static SingletonLazy instance;
    private SingletonLazy() {}

    public static SingletonLazy getInstance() {
        if (instance == null) {
            instance = new SingletonLazy();
        }
        return instance;
    }
}
```

## 二、饿汉式（线程安全）

类加载时即创建，线程安全，但无论是否使用都会占用内存。

```java
public class SingletonEager {
    private static final SingletonEager INSTANCE = new SingletonEager();
    private SingletonEager() {}

    public static SingletonEager getInstance() {
        return INSTANCE;
    }
}
```

## 三、双重检查锁（DCL）

懒加载 + 线程安全，`volatile` 防止指令重排导致返回未完全初始化的对象。

```java
public class SingletonDCL {
    private static volatile SingletonDCL instance;
    private SingletonDCL() {}

    public static SingletonDCL getInstance() {
        if (instance == null) {
            synchronized (SingletonDCL.class) {
                if (instance == null) {
                    instance = new SingletonDCL();
                }
            }
        }
        return instance;
    }
}
```

## 四、静态内部类（Holder，推荐）

利用类加载机制保证线程安全，且真正懒加载——`Holder` 类只有在 `getInstance()` 被调用时才加载。

```java
public class SingletonHolder {
    private SingletonHolder() {}

    private static class Holder {
        private static final SingletonHolder INSTANCE = new SingletonHolder();
    }

    public static SingletonHolder getInstance() {
        return Holder.INSTANCE;
    }
}
```

**原理**：JVM 保证类加载是线程安全的，`Holder.INSTANCE` 只初始化一次；调用方不触发 `Holder` 加载，因此实现了懒加载。

## 五、枚举单例（最强防护）

Effective Java 作者 Josh Bloch 推荐：天然线程安全，并且能抵御**序列化攻击**和**反射攻击**（JVM 保证枚举实例唯一）。

```java
public enum SingletonEnum {
    INSTANCE;

    private final SomeService service = new SomeService();

    public SomeService getService() {
        return service;
    }
}

// 使用
SingletonEnum.INSTANCE.getService().doSomething();
```

反序列化时枚举不会重新创建对象；反射调用枚举构造方法会抛出 `IllegalArgumentException`，彻底防止破坏。

---

## 六、五种实现对比

| 方式 | 线程安全 | 懒加载 | 防序列化 | 防反射 | 推荐场景 |
|------|---------|--------|---------|--------|---------|
| 懒汉式 | ❌ | ✅ | ❌ | ❌ | 单线程环境 |
| 饿汉式 | ✅ | ❌ | ❌ | ❌ | 启动即用，资源消耗可接受 |
| DCL | ✅ | ✅ | ❌ | ❌ | 通用方案，兼顾性能与安全 |
| 静态内部类 | ✅ | ✅ | ❌ | ❌ | **推荐**，简洁高效 |
| 枚举 | ✅ | ❌ | ✅ | ✅ | **最强防护**，需防反序列化/反射破坏时 |
