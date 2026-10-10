---
description: Sequenced 集合、不可变集合、HashMap 树化与扩容、ConcurrentHashMap、TreeMap
---

# 集合框架

> 前置阅读：[SPI 机制](./20_topic_spi)、[树 · 红黑树](/algorithms/1_data_structures/3_tree#四、红黑树-red-black-tree)

集合框架分为 Collection 与 Map 两大体系，是日常开发用得最多的 JDK 组件。本篇讲 JDK 9–21 新增的不可变集合与 Sequenced 集合、HashMap 的哈希 / 树化 / 扩容、ConcurrentHashMap（JDK 8+）的 CAS + `synchronized` 桶锁与协作扩容，以及选型与常见坑。

---

## 一、集合体系总览

![Java 集合体系：Collection 与 Map 两大分支，含 JDK 21 Sequenced 接口](../assets/java/collection_hierarchy.svg)

- **Collection** 分为 List（有序可重复）、Set（不重复）、Queue / Deque（队列）；**Map** 是独立体系，存键值对
- `Vector`、`Stack`、`Hashtable` 没有被标记为 `@Deprecated`，但属于**遗留的同步集合**：每个方法都加 `synchronized`，复合操作照样不安全。新代码分别用 `ArrayList`、`ArrayDeque`、`ConcurrentHashMap` 代替
- `Collections.synchronizedList/Map` 只保证单个方法原子，**遍历时必须手动对集合加锁**，否则可能抛 `ConcurrentModificationException`

### 1、Sequenced 集合（JDK 21）

JDK 21（JEP 431）补上了「有确定顺序的集合」这一层抽象，统一了取首尾元素和反向视图的 API：

| 接口 | 新增方法 | 实现者 |
|------|----------|--------|
| `SequencedCollection` | `addFirst / addLast`、`getFirst / getLast`、`removeFirst / removeLast`、`reversed()` | `List`、`Deque` |
| `SequencedSet` | `reversed()` 返回 `SequencedSet` | `LinkedHashSet`、`SortedSet`（`TreeSet`） |
| `SequencedMap` | `firstEntry / lastEntry`、`pollFirstEntry / pollLastEntry`、`putFirst / putLast`、`sequencedKeySet / Values / EntrySet`、`reversed()` | `LinkedHashMap`、`SortedMap`（`TreeMap`） |

```java
List<String> list = new ArrayList<>(List.of("a", "b", "c"));
list.getFirst();                    // "a"，以前要写 list.get(0)
list.getLast();                     // "c"，以前要写 list.get(list.size() - 1)
list.reversed().forEach(System.out::println);   // 反向视图，不复制

LinkedHashMap<String, Integer> map = new LinkedHashMap<>();
map.putFirst("top", 1);             // 插到最前
map.lastEntry();                    // 最后一个条目
```

- 空集合上调用 `getFirst()` / `getLast()` 抛 `NoSuchElementException`
- `TreeSet.addFirst` 等与排序冲突的方法抛 `UnsupportedOperationException`
- `HashSet`、`HashMap` 没有确定顺序，不实现这些接口

更多 JDK 21 特性见 [版本演进](./2_version)。

### 2、不可变集合

| API | 版本 | 特点 |
|-----|------|------|
| `List.of / Set.of / Map.of / Map.ofEntries` | JDK 9 | 真正不可变；元素不允许 null |
| `List.copyOf / Set.copyOf / Map.copyOf` | JDK 10 | 拷贝成不可变集合，源本身不可变时直接返回 |
| `Collectors.toUnmodifiableList / Set / Map` | JDK 10 | 收集为不可变集合，不允许 null |
| `Stream.toList()` | JDK 16 | 返回不可变 List，**允许 null** |
| `Collections.unmodifiableList` | JDK 1.2 | 只读**视图**，底层集合变了视图跟着变 |
| `Arrays.asList` | JDK 1.2 | 固定长度，可 `set` 不可 `add/remove`，写穿到原数组 |

使用 `List.of` 系列时注意：

- 修改方法抛 `UnsupportedOperationException`；传入 null 抛 `NullPointerException`，`List.of(...).contains(null)` 也会抛
- `Set.of` / `Map.of` 遇到重复元素或重复 key 直接抛 `IllegalArgumentException`
- `Set.of` / `Map.of` 的遍历顺序**每次 JVM 启动都可能不同**，测试里不要断言顺序

### 3、fail-fast 与弱一致迭代器

`ArrayList`、`HashMap` 等非并发集合内部维护 `modCount`，迭代器创建时记下它，每次 `next()` 检查是否被改过，改过就抛 `ConcurrentModificationException`。这不只发生在多线程下，单线程在 for-each 里删除元素同样会触发：

```java
for (String s : list) {
    if (s.isEmpty()) list.remove(s);            // 抛 ConcurrentModificationException
}
list.removeIf(String::isEmpty);                 // 正确：removeIf 或 Iterator.remove()
```

fail-fast 只是尽力检测，不能当作并发正确性的保证。并发集合的迭代器不抛这个异常：`ConcurrentHashMap` 是**弱一致**的（能看到迭代开始后的部分修改），`CopyOnWriteArrayList` 迭代的是创建时的**快照**。

---

## 二、List

### 1、ArrayList vs LinkedList

| 维度 | `ArrayList` | `LinkedList` |
|------|-------------|--------------|
| 底层结构 | 动态数组 | 双向链表 |
| 随机访问 | O(1) | O(n) |
| 尾部追加 | 均摊 O(1) | O(1) |
| 中间插入 / 删除 | O(n)，`System.arraycopy` 移位 | 定位 O(n) + 修改 O(1) |
| 内存 | 连续紧凑，CPU 缓存友好 | 每个元素一个节点对象，额外两个指针 |

实际场景几乎总是 `ArrayList` 更快：链表节点分散在堆上，遍历时缓存命中率低。需要头尾操作时用 `ArrayDeque`，而不是 `LinkedList`。

**ArrayList 扩容**：`new ArrayList<>()` 初始指向一个共享的空数组，第一次 `add` 时才分配容量 10；容量不够时新容量为 `old + (old >> 1)`（1.5 倍），再 `Arrays.copyOf` 复制。已知数据量时用 `new ArrayList<>(n)` 或 `ensureCapacity(n)` 预分配。

### 2、CopyOnWriteArrayList

写操作加锁后复制一份新数组，在新数组上修改再替换引用；读操作不加锁，直接读当前数组。

- 适合**读远多于写**的场景：监听器列表、路由表、黑白名单
- 迭代器遍历创建时的快照，不抛 `ConcurrentModificationException`，也不支持 `Iterator.remove()`
- 每次写都复制整个数组，写频繁或数组大时开销与 GC 压力都很大

### 3、线程安全的 List 怎么选

| 方案 | 特点 |
|------|------|
| `CopyOnWriteArrayList` | 读无锁、写复制，读多写少首选 |
| `Collections.synchronizedList` | 所有方法加同一把锁，遍历需手动 `synchronized (list)` |
| `Vector` | 遗留类，与 synchronizedList 类似，不推荐 |
| 不可变 List + 整体替换引用 | 配置类数据：`volatile List<X>` 指向 `List.copyOf(...)`，更新时整体换 |

---

## 三、Set

- **HashSet**：底层是 `HashMap`，元素作 key，value 是共享的占位对象 `PRESENT`。判重依赖 `hashCode()` + `equals()`，自定义对象必须同时重写两者
- **LinkedHashSet**：底层是 `LinkedHashMap`，保持插入顺序，JDK 21 起实现 `SequencedSet`
- **TreeSet**：底层是 `TreeMap`，按自然顺序或 `Comparator` 排序，实现 `NavigableSet`（`floor`、`ceiling`、`headSet`、`tailSet`）

TreeSet / TreeMap **用 `compareTo` / `compare` 判重，而不是 `equals`**。比较器返回 0 的两个元素会被当成同一个：

```java
TreeSet<User> set = new TreeSet<>(Comparator.comparingInt(User::age));
set.add(new User("Tom", 20));
set.add(new User("Amy", 20));   // 年龄相同，compare 返回 0，被当作重复，加不进去
// 正确：比较器要与业务上的「相等」一致
new TreeSet<>(Comparator.comparingInt(User::age).thenComparing(User::name));
```

---

## 四、Queue / Deque

| 操作 | 失败时抛异常 | 失败时返回特殊值 |
|------|--------------|------------------|
| 入队 | `add(e)` | `offer(e)` 返回 false |
| 出队 | `remove()` | `poll()` 返回 null |
| 查看队头 | `element()` | `peek()` 返回 null |

### 1、ArrayDeque

基于循环数组的双端队列，既可当栈也可当队列，**比 `Stack` 和 `LinkedList` 都快**。不允许 null 元素，非线程安全。

```java
Deque<Integer> stack = new ArrayDeque<>();
stack.push(1);          // 栈：头部压入
stack.pop();            // 头部弹出

Deque<Integer> queue = new ArrayDeque<>();
queue.offer(1);         // 队列：尾部入队
queue.poll();           // 头部出队
```

### 2、PriorityQueue

基于二叉堆，默认最小堆；`offer` / `poll` O(log n)，`peek` O(1)。迭代顺序**不是**优先级顺序，只有不断 `poll` 才有序。

```java
// 按第二个元素降序（大顶堆）
PriorityQueue<int[]> pq = new PriorityQueue<>((a, b) -> Integer.compare(b[1], a[1]));
// 不要写 (a, b) -> b[1] - a[1]：两数相减可能溢出，导致顺序错乱
```

---

## 五、BlockingQueue（线程池 / 生产消费核心）

| 实现 | 容量 | 实现要点 |
|------|------|----------|
| `ArrayBlockingQueue` | 有界，构造时指定 | 数组 + 一把 `ReentrantLock` + `notEmpty / notFull` 两个条件，可选公平锁 |
| `LinkedBlockingQueue` | 可选有界，默认 `Integer.MAX_VALUE` | 链表 + `putLock / takeLock` 两把锁，生产消费可并行，吞吐更高 |
| `LinkedBlockingDeque` | 可选有界 | 双端阻塞队列，一把锁，两端都可阻塞存取 |
| `SynchronousQueue` | 0 | 不存元素，每个 `put` 必须等一个 `take`，`newCachedThreadPool` 使用 |
| `LinkedTransferQueue` | 无界 | `transfer(e)` 阻塞到消费者取走为止，`tryTransfer` 无人等待时立即返回；融合了 SynchronousQueue 与 LinkedBlockingQueue 的能力 |
| `PriorityBlockingQueue` | 无界 | 堆排序，`put` 永不阻塞，注意内存 |
| `DelayQueue` | 无界 | 元素实现 `Delayed`，内部是 `PriorityQueue`，到期才能 `take`，用于延迟任务、超时关单 |

阻塞队列在第四节两组方法之外，又多了阻塞和超时两组：

| 操作 | 抛异常 | 返回特殊值 | 阻塞 | 超时 |
|------|--------|------------|------|------|
| 入队 | `add(e)` | `offer(e)` | `put(e)` | `offer(e, timeout, unit)` |
| 出队 | `remove()` | `poll()` | `take()` | `poll(timeout, unit)` |

线程池选哪个队列、为什么默认的无界队列会 OOM，见 [线程池](./28_topic_thread_pool)。

---

## 六、HashMap

### 1、结构与定位

![HashMap 结构：Node 数组、链表桶与红黑树桶，以及 8 / 6 / 64 三个阈值](../assets/java/hashmap_structure.svg)

- 底层是 `Node<K,V>[] table`，**第一次 `put` 时才分配**（默认容量 16，负载因子 0.75）
- 容量始终是 2 的幂：构造器传入的容量经 `tableSizeFor` 向上取到 2 的幂
- 桶下标 `index = (n - 1) & hash`，n 是 2 的幂时等价于取模，但只用位运算
- 扰动函数 `hash = h ^ (h >>> 16)`：把 hashCode 高 16 位混进低 16 位。表小时下标只用到低几位，不扰动的话高位不同、低位相同的 key 会全部冲突
- null key 的 hash 固定为 0，放在 0 号桶；value 也可以是 null
- 每个 Node 缓存了自己的 `hash`，扩容时不需要重新调用 `hashCode()`

### 2、put 流程

1. 计算扰动后的 hash；table 为空则 `resize()` 初始化
2. 目标桶为空：直接放入新节点
3. 桶首节点 key 相同（hash 相等且 `==` 或 `equals`）：覆盖 value
4. 桶首是 `TreeNode`：走红黑树插入 `putTreeVal`
5. 否则遍历链表：找到相同 key 就覆盖；没找到就**尾插**新节点；若桶内原本已有 8 个节点（插入后超过 8），调用 `treeifyBin`
6. `++size > threshold` 时扩容

### 3、树化与退化

| 常量 | 值 | 含义 |
|------|----|------|
| `TREEIFY_THRESHOLD` | 8 | 桶内已有 8 个节点、再插入时（链表长度超过 8）尝试树化 |
| `MIN_TREEIFY_CAPACITY` | 64 | table 长度小于 64 时**不树化，改为扩容** |
| `UNTREEIFY_THRESHOLD` | 6 | 扩容拆分后树桶的节点数 ≤ 6 时退回链表 |

树化的两个条件必须同时满足：链表长度超过 8，**且** table 长度 ≥ 64。表还小时冲突多半是因为桶太少，扩容比建树更划算。

为什么是 8：在 hashCode 分布良好、负载因子 0.75 时，桶内节点数近似服从泊松分布，一个桶达到 8 个节点的概率约为千万分之六（源码注释给出 0.00000006）。真到 8 个，多半是 hashCode 写得差或遭遇哈希碰撞攻击，红黑树把最坏查找从 O(n) 降到 O(log n)。8 和 6 之间留出差值，避免在阈值附近反复树化、退化。

树桶按 hash 排序；hash 相同时，若 key 实现了 `Comparable` 就按 `compareTo` 排，否则按类名和 `System.identityHashCode` 决胜。所以 key 不可比较且大量 hash 完全相同时，查找仍可能退化到接近 O(n)。

### 4、扩容与 lo / hi 拆分

元素数超过 `threshold = capacity × loadFactor` 时，容量**严格翻倍**。因为容量是 2 的幂，新下标只取决于 hash 中新增的那一位 `hash & oldCap`：

![扩容时旧桶 i 按 hash & oldCap 拆成留在 i 的 lo 链与移到 i + oldCap 的 hi 链](../assets/java/hashmap_resize_split.svg)

- `(hash & oldCap) == 0`：留在原下标 i（lo 链）
- `(hash & oldCap) != 0`：移到 `i + oldCap`（hi 链）
- 拆分保持节点原有相对顺序，不重新计算 hash，也不需要取模

**JDK 7 的并发扩容死循环**：JDK 7 迁移链表用头插法，会把链表顺序反转。两个线程同时扩容时，一个线程反转后的链表被另一个线程按旧顺序继续迁移，可能形成环形链表，之后 `get` 在环上无限循环、CPU 100%。JDK 8 改为尾插并保持顺序，消除了成环，但 HashMap 依然**不是线程安全的**：并发 `put` 会丢数据、`size` 不准。多线程场景用 `ConcurrentHashMap`。

**预分配容量**：`new HashMap<>(n)` 的参数是**桶容量**而不是元素数，放 n 个元素还会因 0.75 的负载因子扩容。JDK 19 起用 `HashMap.newHashMap(n)`（以及 `HashSet.newHashSet`、`LinkedHashMap.newLinkedHashMap`）按元素数预分配；JDK 17 及以前手算 `(int) (n / 0.75f) + 1`。

### 5、key 的设计

- 平均 O(1)；树化后最坏 O(log n)（key 可比较时）
- 作为 key 的对象必须**不可变**，或至少参与 `hashCode` 的字段不变：放入后再改字段，hash 变了，再也找不到它，也删不掉
- `equals` 相等的对象 `hashCode` 必须相等；反之不要求，但 hashCode 分布越均匀越好。record 与 `String` 是理想的 key

---

## 七、LinkedHashMap

`LinkedHashMap` 继承 `HashMap`，节点额外带 `before / after` 指针，把所有条目串成一条双向链表，`head` 最老、`tail` 最新：

![LinkedHashMap 结构：HashMap 桶之外，用 before / after 双向链表按插入或访问顺序串起所有条目](../assets/java/linkedhashmap_structure.svg)

- 默认按**插入顺序**遍历；构造器 `accessOrder = true` 时按**访问顺序**，每次 `get` / `put` 把条目移到链表尾部
- 每次插入后调用 `removeEldestEntry(eldest)`，返回 true 就删掉链表头（最久未访问的条目）
- JDK 21 起实现 `SequencedMap`，可用 `firstEntry()`、`pollFirstEntry()`、`putLast()` 等方法

用这两点可以写出一个 LRU 缓存：

```java
public class LruCache<K, V> extends LinkedHashMap<K, V> {
    private final int capacity;

    public LruCache(int capacity) {
        super(16, 0.75f, true);                 // accessOrder = true
        this.capacity = capacity;
    }

    @Override
    protected boolean removeEldestEntry(Map.Entry<K, V> eldest) {
        return size() > capacity;               // 超出容量就淘汰最久未访问的条目
    }
}
```

它不是线程安全的，访问顺序模式下连 `get` 都会修改链表。生产环境的本地缓存用 Caffeine（W-TinyLFU 淘汰、并发安全、支持过期），见 [Caffeine](/cache/7_caffeine)。

---

## 八、ConcurrentHashMap

### 1、JDK 7 与 JDK 8 对比

| 维度 | JDK 7 | JDK 8 及以后 |
|------|-------|--------------|
| 结构 | `Segment[]`，每个 Segment 内含 `HashEntry[]` + 链表 | `Node[]` + 链表 / 红黑树（`TreeBin`），与 HashMap 类似 |
| 锁 | `Segment` 继承 `ReentrantLock`，一个 Segment 一把锁 | 空桶 CAS 插入；非空桶 `synchronized` 锁桶首节点 |
| 并发度 | 构造时由 `concurrencyLevel` 决定（默认 16），之后固定 | 等于桶数量，随扩容增长 |
| 扩容 | 每个 Segment 内部独立扩容 | 多线程协作迁移，每个桶迁移时锁住桶首 |
| `size()` | 先不加锁累加几次，结果不稳定再锁住全部 Segment | `baseCount` + `CounterCell[]` 分散计数，不加锁 |
| 读 | 不加锁，依赖 `volatile` | 不加锁，依赖 `volatile` |

### 2、为什么放弃分段锁

- **并发度固定**：Segment 数在构造时确定，之后无法随数据量增长；数据集中在少数 Segment 时，锁粒度依然很粗
- **锁对象开销**：每个 Segment 都是一个 `ReentrantLock`，带着 AQS 的状态与队列
- **跨段操作昂贵**：`size()`、`containsValue()` 在竞争下需要锁住所有 Segment
- **两次定位**：先定位 Segment，再定位桶
- **synchronized 已足够快**：JDK 6 之后 `synchronized` 有了锁消除、轻量级锁等优化，锁单个桶首节点的竞争很小，直接用它更省内存（JDK 7 的 Segment 除 0 号外是按需创建的，内存浪费并非主要原因）

### 3、put 流程（JDK 8+）

![ConcurrentHashMap put 流程：spread、initTable、CAS 空桶、MOVED 协助扩容、synchronized 桶首、树化检查与 addCount](../assets/java/chm_put_flow.svg)

1. key、value 任一为 null 直接抛 `NullPointerException`；`spread(h)` = `(h ^ (h >>> 16)) & HASH_BITS`（结果非负，负 hash 留给特殊节点）
2. table 为空：`initTable()`。线程 CAS 把 `sizeCtl` 置为 -1 抢到初始化权，其他线程 `Thread.yield()` 自旋等待，这是 CHM 里唯一的「自旋」
3. 目标桶为空：`casTabAt` 用 CAS 放入新节点，失败就重试，**不加锁**
4. 桶首 hash 为 `MOVED`（-1，即 `ForwardingNode`）：说明正在扩容，当前线程先 `helpTransfer` 帮忙迁移，再重试
5. 否则 `synchronized (f)` 锁住桶首节点：链表就遍历覆盖或尾插；`TreeBin` 就走红黑树插入
6. 链表长度超过 8 时 `treeifyBin`：table 长度小于 64 则扩容，否则树化
7. `addCount` 计数，超过 `sizeCtl`（容量的 0.75）就触发扩容

### 4、扩容：多线程协作迁移

扩容并不是「无锁」的，而是**多线程分段协作、逐桶加锁**：

- 发起线程创建 2 倍大小的 `nextTable`，迁移任务按步长（`stride`，至少 16 个桶）从高位往低位分配，线程通过 CAS 修改 `transferIndex` 认领一段
- 每个桶迁移时先 `synchronized` 锁住桶首，按 `hash & n` 拆成 lo / hi 两部分（与 HashMap 相同），放到新表的 i 和 i + n 位置，然后在旧表该位置放一个 `ForwardingNode`
- 其他线程 `put` 时遇到 `ForwardingNode` 会调用 `helpTransfer` 加入迁移；`get` 遇到它则转到 `nextTable` 查找，读操作不被扩容阻塞
- `sizeCtl` 为负数表示正在初始化或扩容，其中编码了参与扩容的线程数；全部桶迁移完后由最后一个线程把 `table` 指向新表

### 5、get 为什么不加锁

- `Node.val` 和 `Node.next` 是 `volatile` 字段，`tabAt` 用带 acquire 语义的读取数组元素，能看到其他线程已完成的写入
- 桶首是 `ForwardingNode` 时去新表查；是 `TreeBin` 时，`TreeBin` 内部用一个轻量的读写状态位，有写线程时读线程改为沿 `next` 链线性查找，不阻塞

### 6、size 与计数

计数采用与 `LongAdder` 相同的思路：无竞争时 CAS 更新 `baseCount`，CAS 失败就按线程探针值分散到 `CounterCell[]` 的不同槽位，`size()` 时把 `baseCount` 与所有槽位相加。

- 并发修改时 `size()` 只是一个**估计值**，不能拿它做精确判断
- 元素可能超过 `int` 范围时用 `mappingCount()`，它返回 `long`

### 7、为什么不允许 null

与 NPE 无关，原因是**并发下的二义性**：`get(key)` 返回 null 时，无法区分「key 不存在」和「key 映射到 null」。HashMap 可以再调 `containsKey` 确认，但在并发 Map 中 `containsKey` 和 `get` 之间别的线程可能已经修改，两次调用的组合不是原子的。禁止 null 后，返回 null 就只有一种含义。

### 8、复合操作与常见坑

单个方法是线程安全的，**多个方法组合起来不是**：

```java
// 错误：检查再写入，两个线程可能都看到 null
if (!map.containsKey(k)) {
    map.put(k, v);
}
// 错误：读改写，会丢失更新
map.put(word, map.getOrDefault(word, 0L) + 1);

// 正确：使用原子的复合方法
map.putIfAbsent(k, v);
map.merge(word, 1L, Long::sum);
map.compute(k, (key, old) -> old == null ? 1 : old + 1);

// 高并发计数：value 用 LongAdder
ConcurrentHashMap<String, LongAdder> counter = new ConcurrentHashMap<>();
counter.computeIfAbsent(word, w -> new LongAdder()).increment();
```

- `compute*` / `merge` 的函数在**持有桶锁**时执行，必须短小，不要在里面做 IO 或远程调用
- 函数里**不要修改同一个 Map**：JDK 8 中 `computeIfAbsent` 递归写入同一个桶可能死循环（JDK-8062841），JDK 9 起会尽力检测并抛 `IllegalStateException: Recursive update`
- 迭代器和 `forEach` 是弱一致的：不抛 `ConcurrentModificationException`，但不保证看到迭代期间的修改

### 9、HashMap / LinkedHashMap / ConcurrentHashMap 对比

| 维度 | HashMap | LinkedHashMap | ConcurrentHashMap |
|------|---------|---------------|-------------------|
| 底层结构 | 数组 + 链表 / 红黑树 | HashMap + 双向链表 | 数组 + 链表 / 红黑树，CAS + 桶锁 |
| 遍历顺序 | 无序 | 插入顺序或访问顺序 | 无序 |
| 时间复杂度 | 平均 O(1)，树化后最坏 O(log n) | 同 HashMap | 同 HashMap |
| null key / value | 允许 | 允许 | 均不允许 |
| 线程安全 | 否 | 否 | 是 |
| 迭代器 | fail-fast | fail-fast | 弱一致 |
| 典型用途 | 单线程映射、方法内局部变量 | 有序输出、简单 LRU | 共享缓存、计数、注册表 |

---

## 九、TreeMap 与 ConcurrentSkipListMap

### 1、TreeMap

基于红黑树的有序 Map，增删查 O(log n)，实现 `NavigableMap`，擅长**排序遍历、范围查询、找最近的 key**：

| 方法 | 作用 |
|------|------|
| `floorKey(k)` / `ceilingKey(k)` | 小于等于 / 大于等于 k 的最大 / 最小 key |
| `lowerKey(k)` / `higherKey(k)` | 严格小于 / 大于 |
| `headMap(to)` / `tailMap(from)` | 前缀 / 后缀视图 |
| `subMap(from, to)` | 区间视图，**左闭右开** `[from, to)` |
| `subMap(from, fromIncl, to, toIncl)` | 自定义开闭区间 |

```java
// 阶梯费率：取不超过金额的最大档位
NavigableMap<Integer, BigDecimal> feeRate = new TreeMap<>(Map.of(
        0, new BigDecimal("0.006"),
        10_000, new BigDecimal("0.004"),
        100_000, new BigDecimal("0.002")));
BigDecimal rate = feeRate.floorEntry(35_000).getValue();     // 0.004

// 按天汇总的订单，查 10 月 1 日到 7 日（两端都包含）
TreeMap<LocalDate, Integer> dailyOrders = new TreeMap<>();
dailyOrders.put(LocalDate.of(2026, 10, 1), 120);
dailyOrders.put(LocalDate.of(2026, 10, 7), 95);
dailyOrders.put(LocalDate.of(2026, 10, 8), 80);
NavigableMap<LocalDate, Integer> week = dailyOrders.subMap(
        LocalDate.of(2026, 10, 1), true, LocalDate.of(2026, 10, 7), true);   // 1 日与 7 日
```

- **null key**：自然排序时放入 null 抛 `NullPointerException`；传入能处理 null 的比较器（如 `Comparator.nullsFirst(Comparator.naturalOrder())`）则允许。null value 始终允许
- 判重用比较器而非 `equals`，比较器必须与业务上的相等一致（见第三节）
- 非线程安全：并发场景用 `ConcurrentSkipListMap`；只是偶尔共享时可用 `Collections.synchronizedNavigableMap`

### 2、TreeMap vs ConcurrentSkipListMap

| 维度 | TreeMap | ConcurrentSkipListMap |
|------|---------|-----------------------|
| 底层结构 | 红黑树 | 跳表 |
| 有序 | 是 | 是 |
| 时间复杂度 | O(log n) | 平均 O(log n) |
| null key | 自然排序时不允许 | 不允许 |
| null value | 允许 | **不允许** |
| 线程安全 | 否 | 是，基于 CAS，无锁 |
| `size()` | O(1) | O(n)，需要遍历，且并发下不精确 |
| 典型用途 | 单线程排序、区间查找 | 并发有序映射：排行榜、按时间排序的本地索引 |

---

## 十、HashMap vs Hashtable

| 维度 | HashMap | Hashtable |
|------|---------|-----------|
| 线程安全 | 否 | 是，每个方法 `synchronized`，整表一把锁 |
| null key / value | 允许 | 均不允许 |
| 结构 | 数组 + 链表 / 红黑树 | 数组 + 链表 |
| 默认容量 | 16，始终为 2 的幂 | 11 |
| 下标计算 | `(n - 1) & hash` | `(hash & 0x7FFFFFFF) % n` |
| 扩容 | `2n` | `2n + 1` |
| 遍历 | fail-fast 的 Iterator | Iterator（fail-fast）与遗留的 Enumeration（不检测并发修改） |

Hashtable 是 JDK 1.0 的遗留类。单线程用 HashMap，多线程用 ConcurrentHashMap，没有再选 Hashtable 的理由。

---

## 十一、选型速查

| 需求 | 推荐 |
|------|------|
| 普通列表 | `ArrayList`（已知大小时预分配） |
| 栈 / 双端队列 | `ArrayDeque` |
| 常量集合、方法返回值 | `List.of` / `Set.of` / `Map.of`、`Stream.toList()` |
| 读多写少的并发列表 | `CopyOnWriteArrayList` |
| 普通 Map | `HashMap`（已知大小用 `HashMap.newHashMap(n)`） |
| 需要保持插入顺序 | `LinkedHashMap` / `LinkedHashSet` |
| 并发 Map、计数 | `ConcurrentHashMap`（计数用 `merge` 或 `LongAdder`） |
| 排序、范围查询 | `TreeMap` / `TreeSet` |
| 并发有序 Map | `ConcurrentSkipListMap` |
| 本地缓存 | Caffeine，不要手写 LinkedHashMap LRU |
| 线程池任务队列 | 有界的 `ArrayBlockingQueue` / `LinkedBlockingQueue(capacity)` |
| 延迟任务 | `DelayQueue` |
| 优先级调度 | `PriorityQueue`（单线程）/ `PriorityBlockingQueue` |

---

## 小结

- 集合分 Collection 与 Map 两支；JDK 21 加入 `SequencedCollection / SequencedSet / SequencedMap`，统一了首尾访问和 `reversed()`
- `List.of` 系列真正不可变、拒绝 null、`Set.of` / `Map.of` 遍历顺序不固定；`Stream.toList()` 不可变但允许 null
- 非并发集合的迭代器是 fail-fast 的，单线程在 for-each 中删除也会抛异常，用 `removeIf`
- HashMap：扰动 hash + `(n - 1) & hash` 定位；链表长度超过 8 且表长 ≥ 64 才树化，否则扩容，≤ 6 退化；扩容严格翻倍，按 `hash & oldCap` 拆成 lo / hi 两条链且保持顺序
- JDK 7 HashMap 头插法在并发扩容时会成环，JDK 8 改尾插，但仍不是线程安全的
- ConcurrentHashMap（JDK 8+）：空桶 CAS、非空桶 `synchronized` 锁桶首，扩容是多线程分段协作、逐桶加锁，并非无锁；计数用 `baseCount + CounterCell`，`size()` 是估计值
- CHM 禁止 null 是为了消除并发下的二义性；复合操作用 `putIfAbsent / compute / merge`，函数里不要改同一个 Map
- TreeMap 适合排序和范围查询，`subMap` 默认左闭右开；并发有序用 `ConcurrentSkipListMap`，它不允许 null value

## 参考资料

- Collections Framework 概览（JDK 25）：[https://docs.oracle.com/en/java/javase/25/docs/api/java.base/java/util/doc-files/coll-overview.html](https://docs.oracle.com/en/java/javase/25/docs/api/java.base/java/util/doc-files/coll-overview.html)
- JEP 431 Sequenced Collections：[https://openjdk.org/jeps/431](https://openjdk.org/jeps/431)
- JEP 269 集合便捷工厂方法：[https://openjdk.org/jeps/269](https://openjdk.org/jeps/269)
- HashMap / ConcurrentHashMap 源码（OpenJDK）：[https://github.com/openjdk/jdk/tree/master/src/java.base/share/classes/java/util](https://github.com/openjdk/jdk/tree/master/src/java.base/share/classes/java/util)

> 下一篇：[JMM 内存模型](./22_topic_jmm) —— 从集合的线程安全问题深入一层：多线程下变量的可见性、有序性由什么规则保证。
