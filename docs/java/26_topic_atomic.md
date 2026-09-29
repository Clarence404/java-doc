# 专项 - Atomic 原子类

> `java.util.concurrent.atomic` 包提供了一组**原子变量类**，基于 CAS 实现**无锁编程**，比 `synchronized` 在低中度竞争下有更高的吞吐量。

## 一、核心思想：CAS

CAS（Compare-And-Swap）是实现原子操作的核心思想，其工作原理如下：

- **比较内存中的值与预期值**，如果一致，则将其更新为新的值。
- 它是一种**乐观锁机制**，通过尝试修改共享数据并检查是否发生了冲突来保证线程安全。

## 二、常用分类

### 1、基本类型原子类

| 类名              | 对应类型    |
|-----------------|---------|
| `AtomicInteger` | int     |
| `AtomicLong`    | long    |
| `AtomicBoolean` | boolean |

**示例：**

```java
private void test() {
    AtomicInteger counter = new AtomicInteger(0);
    counter.incrementAndGet();  // +1
    counter.addAndGet(5);       // +5
}
```

### 2、引用类型原子类

| 类名                           | 说明           |
|------------------------------|--------------|
| `AtomicReference<T>`         | 原子更新引用       |
| `AtomicStampedReference<T>`  | 带版本戳，解决ABA问题 |
| `AtomicMarkableReference<T>` | 带布尔标记        |

**ABA问题解决示例：**

```java
private void test() {
    AtomicStampedReference<Integer> ref = new AtomicStampedReference<>(1, 0);
    int[] stampHolder = new int[1];
    Integer value = ref.get(stampHolder);
    ref.compareAndSet(value, 2, stampHolder[0], stampHolder[0] + 1);
}
```

### 3、数组原子类

| 类名                        | 说明        |
|---------------------------|-----------|
| `AtomicIntegerArray`      | 原子更新整型数组  |
| `AtomicLongArray`         | 原子更新长整型数组 |
| `AtomicReferenceArray<T>` | 原子更新引用数组  |

### 4、高级类：`LongAdder` / `LongAccumulator`

为了解决高并发下 `AtomicLong` 的热点问题，引入了分段累加器：

```java
LongAdder adder = new LongAdder();
adder.increment(); // 内部分段，高并发下效率远高于 AtomicLong
long sum = adder.sum();
```

`LongAdder` 将计数分散到多个 Cell，减少 CAS 竞争；`sum()` 时汇总所有 Cell。适合**只需最终汇总、不需要实时精确值**的高并发计数场景。

## 三、与 synchronized 对比

| 特点   | Atomic 原子类 | synchronized |
|------|------------|--------------|
| 是否阻塞 | 否（非阻塞）     | 是            |
| 性能   | 高          | 中            |
| 是否公平 | 否          | 是            |
| 可读性  | 一般         | 高            |
