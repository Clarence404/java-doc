---
description: 哈希函数、链地址法与开放寻址、负载因子与扩容、Map / Set 刷题用法、LRU、TreeMap 范围查询
---

# 哈希表

> 前置阅读：[数组与链表](./0_array_list)

哈希表用哈希函数把 key 映射成数组下标，增删查平均 O(1)，代价是额外空间、元素无序和冲突退化。本篇讲链地址法与开放寻址，以及 `HashMap`、`HashSet`、`LinkedHashMap`、`TreeMap` 的解题用法。

---

## 一、哈希表原理

### 1、从 key 到下标

存取都经过同一条路径：key → `hashCode` → 映射到 `[0, capacity)` 的下标 → 在该位置读写。

```java
// 取模映射：Java 的 % 对负数返回负数，要用 floorMod 保证下标非负
int indexOf(int key, int capacity) {
    return Math.floorMod(key, capacity);
}

// 字符串哈希：与 String.hashCode() 的计算方式相同
// h = s[0]·31^(n-1) + s[1]·31^(n-2) + … + s[n-1]，int 溢出回绕是预期行为
int hash(String s) {
    int h = 0;
    for (int i = 0; i < s.length(); i++) {
        h = 31 * h + s.charAt(i);
    }
    return h;
}
```

**为什么乘 31**：31 是奇素数，乘法溢出时不丢失低位信息，分布较均匀；同时 `31 * h` 等于 `(h << 5) - h`，JIT 能把乘法优化成移位和减法（《Effective Java》对此有说明）。

**`HashMap` 不用取模**：它把容量固定为 2 的幂，用 `(n - 1) & hash` 计算下标，效果等同取模但只需一次位运算；并先用 `h ^ (h >>> 16)` 把高 16 位混入低 16 位，避免只有高位不同的 key 全部挤进同一个桶。

好的哈希函数要满足：

- **确定性**：相同 key 永远得到相同的哈希值，所以作为 key 的对象不能在放入后修改参与哈希的字段
- **均匀性**：不同 key 尽量分散到不同下标
- **高效性**：计算本身要快，否则抵消了 O(1) 的优势

### 2、哈希冲突的两种解法

不同 key 映射到同一个下标叫**哈希冲突**。冲突无法避免（key 的取值空间远大于数组长度），只能处理：

![冲突处理：链地址法把冲突 key 挂成链表，线性探测往后找空槽](../../assets/algorithms/hash_collision.svg)

| 方式 | 做法 | 优点 | 缺点 | JDK 中的例子 |
|------|------|------|------|-------------|
| 链地址法 | 同一下标的元素挂成链表（或树） | 实现简单，负载因子可以超过 1，删除直接摘节点 | 每个节点多一个对象，缓存不友好 | `HashMap`、`ConcurrentHashMap` |
| 开放寻址 | 冲突时按规则找下一个空槽：线性探测、二次探测、双重哈希 | 数据都在一个数组里，缓存友好 | 负载因子必须小于 1；连续占用会形成聚集；删除不能直接清空 | `ThreadLocal.ThreadLocalMap`、`IdentityHashMap`（都用线性探测） |

**开放寻址的删除问题**：查找时遇到空槽就认为 key 不存在。如果直接把被删元素的槽清空，排在它后面、当初因冲突后移的元素就再也找不到了。常见做法是放一个「墓碑」标记表示「这里删过，继续往后找」，或者像 `ThreadLocalMap` 那样删除后把后续元素重新安置。

### 3、负载因子与扩容

**负载因子 = 元素个数 / 数组长度**。负载因子越高，空间越省、冲突越多；越低则反之。超过阈值就扩容：申请更大的数组，把所有元素重新放置，单次 O(n)，但均摊到每次插入仍是 O(1)（见 [复杂度分析](../0_complexity) 的均摊分析）。`HashMap` 默认负载因子 0.75，容量翻倍扩容。

### 4、Java HashMap 的实现要点

`HashMap` 采用「数组 + 链表 + 红黑树」的链地址法：默认容量 16、负载因子 0.75，元素数超过 `容量 × 0.75` 时容量翻倍；JDK 8 起新节点**尾插**到链表（JDK 7 是头插，并发扩容可能成环）；同一个桶的链表超过 8 个节点且数组长度不小于 64 时转成红黑树，数组长度不足 64 时改为扩容，扩容拆分后树桶节点数不超过 6 时退回链表。所以它的查找平均 O(1)，桶内最坏 O(n)，树化后 O(log n)。put 流程、扰动函数、lo / hi 拆分与线程安全问题统一见 [集合框架](/java/21_topic_collection) 的 HashMap 一节。

---

## 二、刷题中的 Map 与 Set

### 1、HashMap 常用写法

```java
Map<String, Integer> map = new HashMap<>();
map.put("a", 1);
map.getOrDefault("b", 0);              // 不存在时返回默认值
map.putIfAbsent("c", 3);               // 不存在时才放入
map.containsKey("a");

for (Map.Entry<String, Integer> e : map.entrySet()) {
    System.out.println(e.getKey() + " -> " + e.getValue());
}
```

计数与分组是最常见的两个套路（片段，`words` 为输入的字符串数组）：

```java
// 词频统计：merge 在 key 不存在时放入 1，存在时累加
Map<String, Integer> freq = new HashMap<>();
for (String w : words) {
    freq.merge(w, 1, Integer::sum);
}

// 字母异位词分组（LeetCode 49）：排序后的字符串作为 key
Map<String, List<String>> groups = new HashMap<>();
for (String w : words) {
    char[] cs = w.toCharArray();
    Arrays.sort(cs);
    groups.computeIfAbsent(new String(cs), k -> new ArrayList<>()).add(w);
}
```

**以空间换时间的典型**：两数之和（LeetCode 1）。暴力枚举所有数对是 O(n²)；边遍历边把「值 → 下标」存进哈希表，每个元素只需 O(1) 查一次「另一半」是否出现过，整体 O(n)：

```java
int[] twoSum(int[] nums, int target) {
    Map<Integer, Integer> seen = new HashMap<>();
    for (int i = 0; i < nums.length; i++) {
        Integer j = seen.get(target - nums[i]);
        if (j != null) return new int[]{j, i};
        seen.put(nums[i], i);
    }
    return new int[0];
}
```

### 2、HashSet

`HashSet` 内部就是一个只用 key 的 `HashMap`，用于去重和判断存在：

```java
Set<Integer> a = new HashSet<>(List.of(1, 2, 3));
Set<Integer> b = new HashSet<>(List.of(2, 3, 4));

Set<Integer> inter = new HashSet<>(a);
inter.retainAll(b);        // 交集 {2, 3}

Set<Integer> union = new HashSet<>(a);
union.addAll(b);           // 并集 {1, 2, 3, 4}

Set<Integer> diff = new HashSet<>(a);
diff.removeAll(b);         // 差集 {1}
```

### 3、LinkedHashMap 实现 LRU

`LinkedHashMap` 在 `HashMap` 的基础上用双向链表串起所有节点。构造时传 `accessOrder = true` 后，`get` 和 `put` 都会把节点移到链表尾部，链表头就是最久未访问的元素；再重写 `removeEldestEntry`，插入后超过容量就淘汰链表头：

```java
// LeetCode 146 LRU 缓存
class LRUCache<K, V> extends LinkedHashMap<K, V> {
    private final int capacity;

    LRUCache(int capacity) {
        super(16, 0.75f, true);      // accessOrder = true：按访问顺序排列
        this.capacity = capacity;
    }

    @Override
    protected boolean removeEldestEntry(Map.Entry<K, V> eldest) {
        return size() > capacity;    // put 之后超过容量就淘汰最久未访问的
    }
}
```

面试中常要求不依赖 `LinkedHashMap`，手写「`HashMap` + 双向链表」：哈希表负责 O(1) 定位节点，双向链表负责 O(1) 移动和删除节点。`LinkedHashMap` 的内部结构见 [集合框架](/java/21_topic_collection)。

### 4、TreeMap：有序与范围查询

`TreeMap` 基于红黑树，key 有序，所有操作 O(log n)。它在刷题中的价值是**找前驱后继和范围查询**，这是哈希表做不到的：

```java
TreeMap<Integer, String> tm = new TreeMap<>(Map.of(1, "a", 3, "c", 5, "e"));
tm.firstKey();                  // 1，最小 key
tm.lastKey();                   // 5，最大 key
tm.floorKey(4);                 // 3，≤ 4 的最大 key
tm.ceilingKey(4);               // 5，≥ 4 的最小 key
tm.subMap(1, true, 5, false);   // [1, 5) 范围内的子视图
```

### 5、三种 Map 怎么选

| | HashMap | LinkedHashMap | TreeMap |
|--|---------|---------------|---------|
| 底层 | 数组 + 链表 + 红黑树 | HashMap + 双向链表 | 红黑树 |
| 查找 | 平均 O(1) | 平均 O(1) | O(log n) |
| 遍历顺序 | 无序 | 插入顺序或访问顺序 | 按 key 排序 |
| 适用 | 通用的计数、去重、索引 | LRU、需要保持插入顺序 | 前驱后继、范围查询、有序输出 |

---

## 三、经典题目

| 题目 | 考点 |
|------|------|
| LeetCode 1 两数之和 | 哈希表记录值到下标 |
| LeetCode 49 字母异位词分组 | 排序后作为 key |
| LeetCode 128 最长连续序列 | HashSet 只从序列起点开始数 |
| LeetCode 146 LRU 缓存 | LinkedHashMap / 哈希表 + 双向链表 |
| LeetCode 380 O(1) 时间插入、删除和获取随机元素 | 哈希表 + 数组，删除时与末尾交换 |
| LeetCode 560 和为 K 的子数组 | 前缀和 + 哈希表计数 |
| LeetCode 220 存在重复元素 III | TreeMap 找前驱后继 |

---

## 小结

- 哈希表把 key 映射成下标，平均 O(1)；最坏情况下所有 key 冲突，退化为 O(n)
- 取模映射要防负数下标，`HashMap` 用 2 的幂容量加 `(n - 1) & hash` 代替取模
- 冲突处理有链地址法和开放寻址两类；开放寻址的删除要用墓碑或重新安置后续元素
- 负载因子决定空间与冲突的平衡，扩容单次 O(n)、均摊 O(1)
- `HashMap` 的树化阈值是 8 / 6 / 64，源码细节集中在集合框架一篇
- 计数用 `merge`，分组用 `computeIfAbsent`，LRU 用 `LinkedHashMap`，范围查询用 `TreeMap`

## 参考资料

- JDK 21 HashMap API：[https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/HashMap.html](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/HashMap.html)
- JDK 21 LinkedHashMap API（`removeEldestEntry` 与访问顺序）：[https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/LinkedHashMap.html](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/LinkedHashMap.html)
- JDK 21 String.hashCode：[https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/lang/String.html#hashCode()](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/lang/String.html#hashCode())
- Hello 算法 · 哈希表：[https://www.hello-algo.com/chapter_hashing/](https://www.hello-algo.com/chapter_hashing/)

> 下一篇：[树](./3_tree) —— 二叉树遍历、BST、AVL、红黑树、B 树与 B+ 树。
