# Java 专项-集合框架

> Map 系（HashMap / ConcurrentHashMap 等）详见 [0_base.md](./0_base)，本文补全 List / Set / Queue。

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

Map（独立体系）→ 详见 0_base.md
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

---

## 六、选型速查

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

## 七、常见面试问题

**Q：ArrayList 线程安全吗？有哪些线程安全的 List？**
不安全。线程安全选项：`Collections.synchronizedList()`（粗粒度锁）、`CopyOnWriteArrayList`（读写分离）、`Vector`（已过时）。

**Q：HashSet 如何判断元素重复？**
先比 `hashCode()`，相同再用 `equals()`。所以自定义对象必须同时覆写两者，否则可能存入"重复"元素。

**Q：LinkedBlockingQueue 为什么吞吐比 ArrayBlockingQueue 高？**
LinkedBlockingQueue 使用两把锁（`takeLock` / `putLock`），生产和消费可并发进行；ArrayBlockingQueue 只有一把锁，生产和消费互斥。

**Q：DelayQueue 的应用场景？**
订单超时关闭、缓存过期清理、定时任务调度。底层是 `PriorityQueue`，按剩余延迟时间排序，`take()` 阻塞直到堆顶元素到期。
