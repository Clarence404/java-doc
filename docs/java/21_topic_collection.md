---
description: List/Set/Queue、HashMap/ConcurrentHashMap/TreeMap 原理、线程安全选型
---

# 专项 - 集合框架

> Java 集合框架：Collection 体系（List / Set / Queue）与 Map 体系（HashMap / LinkedHashMap / ConcurrentHashMap / TreeMap）。

## 一、集合体系总览

```
Collection
├── List（有序、可重复）
│   ├── ArrayList
│   ├── LinkedList
│   ├── CopyOnWriteArrayList
│   └── Vector（已过时）
├── Set（无序、不可重复）
│   ├── HashSet（基于 HashMap）
│   ├── LinkedHashSet（插入顺序）
│   └── TreeSet（排序，基于 TreeMap）
└── Queue（队列）
    ├── PriorityQueue（堆，非线程安全）
    ├── ArrayDeque（双端队列）
    └── BlockingQueue（阻塞队列，线程安全）
        ├── ArrayBlockingQueue
        ├── LinkedBlockingQueue
        ├── PriorityBlockingQueue
        ├── SynchronousQueue
        └── DelayQueue

Map（独立体系）
├── HashMap → LinkedHashMap
├── ConcurrentHashMap
├── TreeMap（红黑树）/ ConcurrentSkipListMap（跳表）
└── Hashtable（已过时）
```

---

## 二、List

### ArrayList vs LinkedList

| | `ArrayList` | `LinkedList` |
|--|-------------|--------------|
| 底层结构 | 动态数组 | 双向链表 |
| 随机访问 O(1) | ✅ | ❌ O(n) |
| 头部插入/删除 | O(n)（移位） | O(1) |
| 内存占用 | 紧凑 | 每个节点额外存前后指针 |
| 推荐场景 | 读多写少、随机访问 | 频繁头尾增删（但实际性能未必优于 ArrayList） |

**ArrayList 扩容机制**：初始容量 10，每次扩容为 `oldCapacity * 1.5`，通过 `Arrays.copyOf` 复制。
大量插入前调用 `ensureCapacity(n)` 可避免多次扩容。

### CopyOnWriteArrayList

写时复制：每次修改都拷贝一份新数组，读操作无锁。

```java
CopyOnWriteArrayList<String> list = new CopyOnWriteArrayList<>();
list.add("a");   // 写：加锁，复制数组，修改新数组，替换引用
list.get(0);     // 读：无锁，访问快照
```

**适用场景**：读远多于写、允许读到稍旧数据（弱一致性迭代器）。
**不适合**：写操作频繁（每次复制开销大）、内存敏感。

---

## 三、Set

### HashSet

底层是 `HashMap`，元素存为 key，value 为固定的 `PRESENT` 对象。
`add()` 判重依赖 `hashCode()` + `equals()`，自定义对象需同时覆写两者。

### LinkedHashSet

底层是 `LinkedHashMap`，维护插入顺序，遍历结果与插入顺序一致。

### TreeSet

底层是 `TreeMap`（红黑树），元素按自然顺序或自定义 `Comparator` 排序。
元素必须实现 `Comparable` 或在构造时传入 `Comparator`，否则抛 `ClassCastException`。

```java
TreeSet<String> set = new TreeSet<>(Comparator.reverseOrder());
set.add("banana");
set.add("apple");
System.out.println(set);  // [banana, apple]
```

---

## 四、Queue / Deque

### ArrayDeque

双端队列，可用作栈或队列，**比 Stack 和 LinkedList 更推荐**：
```java
ArrayDeque<Integer> deque = new ArrayDeque<>();
deque.push(1);         // 栈用法：压栈（头部插入）
deque.pop();           // 弹栈（头部删除）
deque.offer(1);        // 队列用法：尾部入队
deque.poll();          // 头部出队
```

### PriorityQueue

最小堆（默认），`offer()` O(log n)，`poll()` O(log n)，`peek()` O(1)。
自定义排序传入 `Comparator`：
```java
PriorityQueue<int[]> pq = new PriorityQueue<>((a, b) -> b[1] - a[1]); // 最大堆按第二个元素
```

---

## 五、BlockingQueue（线程池 / 生产消费核心）

| 实现 | 容量 | 特点 |
|------|------|------|
| `ArrayBlockingQueue` | 有界 | 数组，公平锁可选 |
| `LinkedBlockingQueue` | 可有界可无界（默认 `Integer.MAX_VALUE`） | 链表，生产消费锁分离，吞吐高 |
| `SynchronousQueue` | 0（直接传递） | 每个 put 必须等待 take，`newCachedThreadPool` 使用 |
| `PriorityBlockingQueue` | 无界 | 优先级排序，不阻塞 put |
| `DelayQueue` | 无界 | 元素到期后才能取出，用于延迟任务 |

**put vs offer vs add 区别**：
- `put`：阻塞直到有空间
- `offer(e, timeout, unit)`：超时等待
- `add`：满了直接抛 `IllegalStateException`

## 六、HashMap

HashMap 是一种基于哈希表的数据结构，它实现了 Map 接口，用于存储键值对 (key-value)。其基本原理如下：

### 1、哈希表（Hash Table）

HashMap 是基于哈希表实现的，哈希表的基本思想是通过将数据的键值对映射到一个数组的索引位置上来提高数据查找的效率。具体流程如下：

- **哈希函数**： HashMap 使用哈希函数将键（key）映射到数组的索引位置。哈希函数的目的是通过计算一个值，将不同的键映射到哈希表中的位置。

- **数组**： 哈希表内部使用一个数组来存储数据。数组中的每个元素存储一个链表（或者在 Java 8 后是
  <RouteLink to="/algorithms/1_data_structures/3_tree#四、红黑树-red-black-tree">红黑树</RouteLink>），用于处理哈希冲突。

### 2、哈希冲突

由于哈希函数不可能做到完全唯一的映射，不同的键可能会被映射到相同的索引，这种情况称为哈希冲突。HashMap 通过以下方式解决哈希冲突：

- **链表法（链式哈希）**： 在发生冲突的情况下，HashMap 会将冲突的键值对存储到一个链表中
  （或者 <RouteLink to="/algorithms/1_data_structures/3_tree#四、红黑树-red-black-tree">红黑树</RouteLink>）。
  当多个元素映射到同一个索引位置时，它们会形成一个链表。

- **<RouteLink to="/algorithms/1_data_structures/3_tree#四、红黑树-red-black-tree">红黑树</RouteLink> 法**： 在 Java 8
  及以后的版本中，如果链表的长度超过一定阈值（默认为 8），HashMap
  会将链表转化为 <RouteLink to="/algorithms/1_data_structures/3_tree#四、红黑树-red-black-tree">红黑树</RouteLink>，
  以提高查询效率。

![img.png](../assets/java/hashmap_hash_conflict.png)

### 3、扩容机制

当 HashMap 中的元素过多时，哈希表的负载因子（load factor）可能会达到阈值，导致哈希表的存储效率降低。

- 默认情况下，负载因子为 0.75。**当元素个数超过 (当前容量 * 负载因子) 时，HashMap 会进行扩容（通常是原数组大小的 2 倍）**。

- 扩容过程中，所有元素的哈希值会被重新计算，并重新放置到新的数组位置。因为**哈希表的大小发生变化，导致原先的索引位置不再适用**。

### 4、时间复杂度

- **查找、插入、删除 时间复杂度**：

在理想情况下，哈希表的查找、插入和删除操作的时间复杂度为 O(1)。

但是，如果发生哈希冲突，性能会退化到 O(n)（链表长度为 n 时）。
使用 <RouteLink to="/algorithms/1_data_structures/3_tree#四、红黑树-red-black-tree">红黑树</RouteLink>优化后，最坏情况下时间复杂度为
O(log n)。

- **扩容操作的时间复杂度**：

扩容是一个相对耗时的操作，时间复杂度为 O(n)，但扩容操作是按需进行的，不是频繁发生，因此平均而言，HashMap 的操作仍然是 O(1)。

## 七、LinkedHashMap

### 1、有序性支持

与 `HashMap` 不同，`LinkedHashMap` 保留了元素的顺序特性：

- 默认按照 **插入顺序** 排列。
- 可以选择按照 **访问顺序** 排列（构造函数中设置 `accessOrder=true`）。

### 2、遍历顺序可控

使用 `Iterator` 遍历时，元素的顺序：

- 插入顺序模式下：与插入顺序一致；
- 访问顺序模式下：最近被访问的元素会排在后面。

### 3、应用场景：LRU 缓存

通过设置为访问顺序 + 搭配 `removeEldestEntry` 方法，`LinkedHashMap` 可轻松实现：

* **最近最少使用（LRU）缓存淘汰策略**

```java
new LinkedHashMap<>(16,0.75f,true) // accessOrder = true
```

### 4、类关系图

![](../assets/java/LinkedHashMap.png)

## 八、ConcurrentHashMap

### 1、基本特性

| **特性**	             | **描述**                                                                                      |
|---------------------|---------------------------------------------------------------------------------------------|
| **线程安全**            | 	采用 CAS + 自旋锁 替代 synchronized，减少锁竞争                                                         |
| **高并发**	            | 读操作无锁，写操作局部加锁，避免全局锁的性能瓶颈                                                                    |
| **不支持 null**        | 	key 和 value 都 不能为 null，防止 NullPointerException                                             |
| **比 Hashtable 性能高** | 	Hashtable 使用 synchronized 进行全表加锁，而 ConcurrentHashMap 采用 分段锁机制（JDK 1.7）和 CAS + 自旋锁（JDK 1.8） |

### 2、JDK 1.7 和 1.8 对比

| **版本**	    | **JDK 1.7**	                   | **JDK 1.8 及以后**              |
|------------|--------------------------------|------------------------------|
| **底层数据结构** | 	Segment（分段锁） + 数组 + 链表        | 	数组 + 链表 + 红黑树（大于 8 个元素）     |
| **加锁方式**	  | 分段锁（Segment 继承 ReentrantLock）	 | CAS + 自旋锁 + synchronized（局部） |
| **并发控制**	  | 多个 Segment 互不影响                | 	CAS 方式优化，减少锁竞争              |
| **写入性能**	  | 分段锁，性能较好                       | 	CAS + 局部锁，性能更高              |
| **扩容机制**	  | Segment 级别扩容	                  | 无锁扩容，支持并发扩容                  |

### 3、为何放弃分段锁？

#### 3.1 JDK 1.7 分段锁弊端

在 JDK 1.7 之前，`ConcurrentHashMap` 使用 **分段锁（Segment）**，每个 `Segment` 管理独立的 `HashEntry[]`。但存在以下问题：

- **扩容性能差**：扩容时需要对整个 `Segment` 加锁，影响并发。

- **内存浪费**：预先分配多个 `Segment`，即使不使用也占用内存。

- **代码复杂**：锁管理复杂，且 `put()` 需要两次 `hash` 计算，降低性能。

#### 3.2 JDK 1.8 的新方案

JDK 1.8 放弃了 `Segment`，改用 **数组 + 链表 + 红黑树** 结构，结合 **CAS** 和 **synchronized** 局部加锁，提升并发性能。

- **CAS 无锁优化**：避免锁竞争，提高吞吐量。

```java
public V put(K key, V value) {
    // 扰动哈希，减少碰撞
    int hash = spread(key.hashCode());
    // 计算桶索引
    int i = (table.length - 1) & hash;

    // 如果桶是空的，直接 CAS 插入（无锁）
    if (tabAt(table, i) == null) {
        if (casTabAt(table, i, null, new Node<>(hash, key, value, null))) {
            return null;
        }
    }

    // 否则进入加锁流程
    synchronized (table[i]) {
        // 链表插入或树形插入逻辑...
    }
    return null;
}

```

- **synchronized 局部加锁**：只锁定当前桶位，减少锁竞争。

```java
private void putVal(int hash, K key, V value) {
    int i = (n - 1) & hash;
    Node<K, V> f = tabAt(table, i);

    if (f == null) {
        if (casTabAt(table, i, null, new Node<>(hash, key, value, null))) {
            return;
        }
    } else {
        synchronized (f) { // 局部加锁，只锁定当前桶位
            Node<K, V> e = f;
            while (e != null) {
                if (e.hash == hash && Objects.equals(e.key, key)) {
                    e.value = value; // 覆盖已有 key 的值
                    return;
                }
                e = e.next;
            }
            // 插入新节点
            f.next = new Node<>(hash, key, value, null);
        }
    }
}

```

- **红黑树优化**：当链表长度超过 8，转为红黑树，查询效率提高。

```java
private void putVal(int hash, K key, V value) {
    int i = (n - 1) & hash;
    Node<K, V> f = tabAt(table, i);

    if (f != null) {
        int binCount = 1;
        Node<K, V> e = f;
        while (e.next != null) {
            binCount++;
            e = e.next;
        }

        if (binCount >= TREEIFY_THRESHOLD) { // 默认值为8
            treeifyBin(table, i); // 转为红黑树结构
        }
    }
}

```

- **无锁扩容**：多个线程并行迁移数据，提升扩容效率。

```java
private void resize() {
    Node<K, V>[] oldTab = table;
    int oldCap = oldTab.length;
    int newCap = oldCap << 1;
    Node<K, V>[] newTab = new Node[newCap];

    for (int i = 0; i < oldCap; ++i) {
        Node<K, V> e = oldTab[i];
        if (e != null) {
            transferNode(e, newTab); // 将链表或树迁移到新表
        }
    }

    table = newTab;
}

```

#### 3.3 两句话总结

- JDK 1.7 分段锁的性能差、空间浪费和复杂性问题。

- JDK 1.8 改用 CAS、synchronized 和红黑树，提升了并发性能和查询效率，支持无锁扩容。

> **提示**：JDK 1.8 的 `ConcurrentHashMap` 在高并发下表现更优，避免了分段锁带来的性能瓶颈。

### 4、HashMap / LinkedHashMap / ConcurrentHashMap 对比

| **对比项**             | **HashMap**      | **LinkedHashMap** | **ConcurrentHashMap** |
|---------------------|------------------|-------------------|-----------------------|
| **底层数据结构**          | 哈希表（数组 + 链表/红黑树） | 哈希表 + 双向链表        | 哈希表（分段锁、CAS 机制）       |
| **key 是否有序**        | ❌ 无序             | ✅ 按插入顺序排序         | ❌ 无序                  |
| **时间复杂度**           | O(1) 平均，O(n) 最坏  | O(1) 平均，O(n) 最坏   | O(1) 平均，O(n) 最坏       |
| **是否允许 null key**   | ✅ 允许             | ✅ 允许              | ❌ 不允许                 |
| **是否允许 null value** | ✅ 允许             | ✅ 允许              | ❌ 不允许                 |
| **线程安全**            | ❌ 非线程安全          | ❌ 非线程安全           | ✅ 线程安全                |
| **适用场景**            | 快速查找、无序存储、大量数据   | 需要按插入顺序遍历的场景      | 并发环境下的高效哈希映射          |
| **主要应用**            | 缓存、映射查找、对象存储     | LRU 缓存、访问顺序存储     | 高并发场景，如缓存、线程池         |

## 九、TreeMap

### 1、源码分析

- 类关联图如下所示：

![image.png](../assets/java/TreeMap.png)

- TreeMap 的核心特点

| 特性              | 	说明                                                                                                                              |
|-----------------|----------------------------------------------------------------------------------------------------------------------------------|
| 底层实现            | 	 <RouteLink to="/algorithms/1_data_structures/3_tree#四、红黑树-red-black-tree">红黑树</RouteLink>（Red-Black Tree），是一种自平衡二叉搜索树（BST） |
| 排序方式            | 	默认按 key 的 自然顺序（Comparable） 排序，也可以传入 自定义 Comparator                                                                              |
| 时间复杂度           | 	O(log n)（增、删、查）                                                                                                                 |
| 是否允许 null key   | 	❌ 不允许 null key（会抛 NullPointerException）                                                                                         |
| 是否允许 null value | 	✅ 允许 null value                                                                                                                 |
| 是否线程安全          | 	❌ 非线程安全（需要 Collections.synchronizedMap() 保护）                                                                                    |

::: important 使用途径
适用于需要 "**自动排序**" 和 "**范围查询**" 的场景。
:::

1、适用场景：数据存储时要求按照 key 进行排序，方便后续查询和展示

```java
private void test() {
    TreeMap<Integer, String> productMap = new TreeMap<>();
    productMap.put(102, "iPhone");
    productMap.put(101, "Samsung");
    productMap.put(103, "Huawei");

// 遍历时 key 是按顺序排序的（101, 102, 103）
    for (Map.Entry<Integer, String> entry : productMap.entrySet()) {
        System.out.println(entry.getKey() + " -> " + entry.getValue());
    }
}
```

2、需要 "范围查询" 或 "区间搜索"

```java
private void test() {
    TreeMap<Long, String> transactionMap = new TreeMap<>();
    transactionMap.put(1707052800000L, "订单 A");  // 2024-02-05 00:00:00
    transactionMap.put(1707139200000L, "订单 B");  // 2024-02-06 00:00:00
    transactionMap.put(1707225600000L, "订单 C");  // 2024-02-07 00:00:00

    // 获取 2 月 5 日到 2 月 6 日之间的交易
    Map<Long, String> result = transactionMap.subMap(1707052800000L, 1707139200000L);
    System.out.println(result);
}
```

### 2、TreeMap vs ConcurrentSkipListMap

| **对比项**             | **TreeMap**         | **ConcurrentSkipListMap** |
|---------------------|---------------------|---------------------------|
| **底层数据结构**          | 红黑树（Red-Black Tree） | 跳表（Skip List）             |
| **key 是否有序**        | ✅ 有序（按 key 排序）      | ✅ 有序（按 key 排序）            |
| **时间复杂度**           | O(log n)            | O(log n)                  |
| **是否允许 null key**   | ❌ 不允许               | ❌ 不允许                     |
| **是否允许 null value** | ✅ 允许                | ✅ 允许                      |
| **线程安全**            | ❌ 非线程安全             | ✅ 线程安全                    |
| **适用场景**            | 需要排序、范围查询、导航结构      | 并发环境下的有序映射                |
| **主要应用**            | 排名、日志存储、区间查找        | 线程安全的排序映射结构               |

## 十、HashMap vs Hashtable

### 1、经典对比

| 对比项	           | HashMap	                    | Hashtable                  |
|----------------|-----------------------------|----------------------------|
| **线程安全**	      | ❌ 非线程安全                     | 	✅ 线程安全（方法加锁 synchronized） |
| **性能**	        | 🚀 性能更高（无锁）	                | 🐌 性能较低（加锁导致开销大）           |
| **是否允许 null**	 | ✅ null key/value 允许	        | ❌ null key/value 不允许       |
| **数据结构**       | 	JDK 1.8+: 数组 + 链表/红黑树	     | 数组 + 链表                    |
| **默认初始容量**     | 	16                         | 	11                        |
| **扩容方式**	      | 容量翻倍（2^n 结构优化）              | 	容量翻倍 + 1                  |
| **遍历方式**	      | 迭代器 Iterator（fail-fast 机制）	 | Enumeration（旧版方式）          |
| **适用场景**	      | 适用于 单线程、高性能场景	              | 适用于 历史遗留代码、并发场景（已被淘汰）      |

### 2、推荐 ConcurrentHashMap

::: tip
✅ 用 HashMap

- 大多数场景 推荐使用 HashMap，只在单线程环境下使用。

✅ 用 ConcurrentHashMap（代替 Hashtable）

- 如果需要线程安全，**请用 ConcurrentHashMap，不要用 Hashtable！**

- ConcurrentHashMap 在 **高并发 场景下比 Hashtable 性能更优（局部加锁，甚至无锁）**。

:::

---

## 十一、选型速查

| 需求 | 推荐 |
|------|------|
| 普通列表 | `ArrayList` |
| 高并发读、低频写 | `CopyOnWriteArrayList` |
| 高并发 Map | `ConcurrentHashMap` |
| 排序不重复集合 | `TreeSet` |
| 线程池任务队列（有界） | `ArrayBlockingQueue` |
| 线程池任务队列（无界） | `LinkedBlockingQueue`（小心 OOM） |
| 延迟任务 | `DelayQueue` |
| 优先级调度 | `PriorityQueue` / `PriorityBlockingQueue` |

---

## 十二、常见面试问题

**Q：ArrayList 线程安全吗？有哪些线程安全的 List？**
不安全。线程安全选项：`Collections.synchronizedList()`（粗粒度锁）、`CopyOnWriteArrayList`（读写分离）、`Vector`（已过时）。

**Q：HashSet 如何判断元素重复？**
先比 `hashCode()`，相同再用 `equals()`。所以自定义对象必须同时覆写两者，否则可能存入"重复"元素。

**Q：LinkedBlockingQueue 为什么吞吐比 ArrayBlockingQueue 高？**
LinkedBlockingQueue 使用两把锁（`takeLock` / `putLock`），生产和消费可并发进行；ArrayBlockingQueue 只有一把锁，生产和消费互斥。

**Q：DelayQueue 的应用场景？**
订单超时关闭、缓存过期清理、定时任务调度。底层是 `PriorityQueue`，按剩余延迟时间排序，`take()` 阻塞直到堆顶元素到期。
