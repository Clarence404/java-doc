---
description: 二叉堆与数组映射、上浮与下沉、O(n) 建堆、堆排序、PriorityQueue、Top K、快速选择、双堆求中位数
---

# 堆

> **本篇目标**：理解二叉堆如何用数组存储完全二叉树，能手写上浮、下沉和建堆，熟练使用 `PriorityQueue` 解决 Top K、第 K 大、数据流中位数等问题。
>
> **前置阅读**：[树](./3_tree)（完全二叉树）、[复杂度分析](../0_complexity)

堆专门解决「反复取最值」的问题：取堆顶 O(1)，插入和删除堆顶 O(log n)。它不保证整体有序，只保证堆顶是最值，所以比维护一个完全有序的结构便宜。Java 的 `PriorityQueue`、定时任务调度（`DelayQueue`、`ScheduledThreadPoolExecutor` 的任务队列）底层都是堆。

---

## 一、堆的定义

堆是一棵**完全二叉树**，并满足堆性质：

- **大顶堆（Max-Heap）**：每个节点 ≥ 其子节点，堆顶是最大值
- **小顶堆（Min-Heap）**：每个节点 ≤ 其子节点，堆顶是最小值

完全二叉树按层序编号后没有空位，所以堆直接存在**数组**里，不需要指针，父子关系靠下标计算：

| 关系 | 下标（从 0 开始） |
|------|-------------------|
| 节点 i 的左孩子 | 2i + 1 |
| 节点 i 的右孩子 | 2i + 2 |
| 节点 i 的父节点 | (i − 1) / 2（整除） |
| 最后一个非叶节点 | n / 2 − 1 |

![大顶堆：完全二叉树按层序存进数组](../../assets/algorithms/heap_array.svg)

---

## 二、核心操作

以下代码以大顶堆为例，共用这个交换方法：

```java
void swap(int[] a, int i, int j) {
    int t = a[i];
    a[i] = a[j];
    a[j] = t;
}
```

### 1、上浮（sift up）

插入时把新元素放到数组末尾，然后和父节点比较，比父节点大就交换，直到不再违反堆性质。最多上浮树高次，O(log n)：

```java
void siftUp(int[] heap, int i) {
    while (i > 0) {
        int parent = (i - 1) / 2;
        if (heap[parent] >= heap[i]) break;
        swap(heap, parent, i);
        i = parent;
    }
}
```

### 2、下沉（sift down）

删除堆顶时，把末尾元素移到堆顶，再和**较大的孩子**比较，比它小就交换，一路下沉。同样 O(log n)：

```java
void siftDown(int[] heap, int i, int size) {
    while (true) {
        int largest = i;
        int left = 2 * i + 1, right = 2 * i + 2;
        if (left < size && heap[left] > heap[largest]) largest = left;
        if (right < size && heap[right] > heap[largest]) largest = right;
        if (largest == i) break;
        swap(heap, i, largest);
        i = largest;
    }
}
```

和较大的孩子交换，才能保证换上来的新父节点同时 ≥ 两个孩子。

### 3、建堆：O(n)

把无序数组原地变成堆：从最后一个非叶节点开始，倒序对每个节点下沉。

```java
void buildHeap(int[] arr) {
    int n = arr.length;
    for (int i = n / 2 - 1; i >= 0; i--) {
        siftDown(arr, i, n);
    }
}
```

逐个插入建堆是 O(n log n)，而倒序下沉只要 O(n)。原因是大部分节点都在底层，下沉距离很短：高度为 h 的节点约有 n / 2^(h+1) 个，每个最多下沉 h 层，总代价为 n × Σ h / 2^(h+1)，这个级数收敛到常数 1，所以总共 O(n)。

---

## 三、堆排序

建好大顶堆后，反复把堆顶（当前最大值）和末尾交换，再对缩小后的堆做一次下沉：

```java
void heapSort(int[] arr) {
    buildHeap(arr);
    for (int i = arr.length - 1; i > 0; i--) {
        swap(arr, 0, i);        // 最大值放到末尾
        siftDown(arr, 0, i);    // 堆的范围缩小为 [0, i)
    }
}
```

| 指标 | 值 |
|------|-----|
| 时间复杂度 | O(n log n)，最好最坏都一样 |
| 空间复杂度 | O(1)，原地排序 |
| 稳定性 | 不稳定，堆顶与末尾交换会打乱相等元素的相对顺序 |

堆排序最坏情况也有保证，但访问模式跳跃、缓存不友好，实际通常比快速排序慢。JDK 对基本类型数组的排序在快速排序递归过深时会改用堆排序兜底。各排序算法的整体对比见 [排序算法](../2_algorithms/1_sort)。

---

## 四、Java PriorityQueue

`PriorityQueue` 是基于数组的二叉堆，**默认是小顶堆**。

```java
// 小顶堆
PriorityQueue<Integer> minHeap = new PriorityQueue<>();

// 大顶堆
PriorityQueue<Integer> maxHeap = new PriorityQueue<>(Comparator.reverseOrder());

// 自定义优先级：按 int[] 的第二个元素升序
PriorityQueue<int[]> pq = new PriorityQueue<>(Comparator.comparingInt(a -> a[1]));

// 多关键字：先按频次降序，频次相同按单词字典序
record WordCount(String word, int count) {}
PriorityQueue<WordCount> words = new PriorityQueue<>(
        Comparator.comparingInt(WordCount::count).reversed()
                  .thenComparing(WordCount::word));

minHeap.offer(3);   // 插入 O(log n)
minHeap.peek();     // 查看堆顶 O(1)，空堆返回 null
minHeap.poll();     // 取出堆顶 O(log n)，空堆返回 null
```

**比较器不要写成 `(a, b) -> a[1] - b[1]`**：两数相减可能溢出，例如 `Integer.MIN_VALUE - 1` 会变成正数，排序结果就错了。统一用 `Comparator.comparingInt` 或 `Integer.compare(a[1], b[1])`。

使用时要注意：

| 要点 | 说明 |
|------|------|
| `remove(Object)`、`contains` | O(n)，要线性扫描找到元素；需要频繁删除任意元素时改用 `TreeMap` / `TreeSet` |
| 迭代顺序 | `iterator()`、`toString()`、`stream()` 都**不保证有序**，只有不断 `poll` 才按优先级输出 |
| 初始容量 | `new PriorityQueue<>(k)` 要求 k ≥ 1，传 0 抛 `IllegalArgumentException` |
| 扩容 | 容量小于 64 时约翻倍，之后每次增长 50% |
| 线程安全 | 非线程安全，多线程用 `PriorityBlockingQueue` |
| `null` | 不允许放入 `null` |

---

## 五、Top K 问题

### 1、最大的 K 个数：小顶堆

维护一个大小为 K 的**小顶堆**，堆顶是目前第 K 大的数。新元素比堆顶大就替换堆顶，最后堆里就是最大的 K 个：

```java
int[] topKLargest(int[] nums, int k) {
    if (k <= 0) return new int[0];
    PriorityQueue<Integer> minHeap = new PriorityQueue<>(k);
    for (int num : nums) {
        if (minHeap.size() < k) {
            minHeap.offer(num);
        } else if (num > minHeap.peek()) {
            minHeap.poll();
            minHeap.offer(num);
        }
    }
    // 结果是堆数组的顺序，不是有序的；需要有序时再排序
    return minHeap.stream().mapToInt(Integer::intValue).toArray();
}
```

时间 O(n log k)，空间 O(k)。数据只需顺序读一遍，适合数据量远大于 K、甚至放不进内存的流式场景，海量数据下的用法见 [海量数据算法题](/scenario/3_massive_data)。求最小的 K 个则反过来用大顶堆。

### 2、第 K 大元素：堆与快速选择

用堆的写法：

```java
// LeetCode 215，O(n log k)
int findKthLargest(int[] nums, int k) {
    PriorityQueue<Integer> minHeap = new PriorityQueue<>();
    for (int num : nums) {
        minHeap.offer(num);
        if (minHeap.size() > k) minHeap.poll();
    }
    return minHeap.peek();   // 小顶堆堆顶就是第 K 大
}
```

题目要求 O(n) 时用**快速选择**：借用快速排序的分区，每次只递归进答案所在的一侧，平均 O(n)。随机选基准可以避免有序输入导致的 O(n²) 最坏情况；三路分区把等于基准的元素归到中间段，大量重复值时也不会退化：

```java
// 第 K 大 = 升序排列后下标为 n - k 的元素
int quickSelect(int[] nums, int k) {
    int target = nums.length - k;
    int lo = 0, hi = nums.length - 1;
    var rnd = java.util.concurrent.ThreadLocalRandom.current();
    while (true) {
        int pivot = nums[lo + rnd.nextInt(hi - lo + 1)];
        // 三路分区：[lo, lt) < pivot，[lt, i) == pivot，(gt, hi] > pivot
        int lt = lo, i = lo, gt = hi;
        while (i <= gt) {
            if (nums[i] < pivot) swap(nums, lt++, i++);
            else if (nums[i] > pivot) swap(nums, i, gt--);
            else i++;
        }
        if (target < lt) hi = lt - 1;
        else if (target > gt) lo = gt + 1;
        else return pivot;
    }
}
```

| 方法 | 时间 | 空间 | 适用 |
|------|------|------|------|
| 排序后取下标 | O(n log n) | 取决于排序 | 写起来最简单 |
| 小顶堆 | O(n log k) | O(k) | 数据流、数据放不进内存 |
| 快速选择 | 平均 O(n)，最坏 O(n²) | O(1) | 数据全在内存且允许修改原数组 |

### 3、数据流中位数：双堆

用**大顶堆存较小的一半、小顶堆存较大的一半**，保持大顶堆的元素数等于小顶堆或多一个。中位数就从两个堆顶取：

```java
// LeetCode 295
class MedianFinder {
    private final PriorityQueue<Integer> lo = new PriorityQueue<>(Comparator.reverseOrder()); // 大顶堆
    private final PriorityQueue<Integer> hi = new PriorityQueue<>();                          // 小顶堆

    public void addNum(int num) {
        lo.offer(num);
        hi.offer(lo.poll());              // lo 的最大值移到 hi，保证 lo 中元素都 ≤ hi
        if (lo.size() < hi.size()) {      // 保持 lo.size() >= hi.size()
            lo.offer(hi.poll());
        }
    }

    public double findMedian() {
        return lo.size() > hi.size()
                ? lo.peek()
                : ((long) lo.peek() + hi.peek()) / 2.0;   // 先转 long，避免两个大 int 相加溢出
    }
}
```

每次插入 O(log n)，查询 O(1)。双堆要保存全部数据，只适合内存放得下的情况。

---

## 六、经典题目

| 题目 | 考点 |
|------|------|
| LeetCode 215 数组中的第K个最大元素 | 小顶堆 / 快速选择 |
| LeetCode 295 数据流的中位数 | 双堆 |
| LeetCode 23 合并 K 个升序链表 | 小顶堆多路归并 |
| LeetCode 347 前 K 个高频元素 | 计数 + 小顶堆 |
| LeetCode 373 查找和最小的 K 对数字 | 小顶堆按需扩展 |
| LeetCode 264 丑数 II | 小顶堆 / 三指针 |

---

## 小结

- 堆是用数组存储的完全二叉树，下标 i 的孩子是 2i+1、2i+2，父节点是 (i−1)/2
- 插入靠上浮、删除堆顶靠下沉，都是 O(log n)；倒序下沉建堆是 O(n)
- 堆排序原地、O(n log n)、不稳定
- `PriorityQueue` 默认小顶堆；比较器用 `Comparator.comparingInt`，不要用减法
- `PriorityQueue` 的 `remove(Object)` 和 `contains` 是 O(n)，迭代顺序无序，初始容量必须 ≥ 1
- Top K 用大小为 K 的反向堆，O(n log k)；第 K 大要求 O(n) 时用快速选择；中位数用双堆

## 参考资料

- JDK 21 PriorityQueue API：[https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/PriorityQueue.html](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/PriorityQueue.html)
- OpenJDK PriorityQueue 源码（`grow` 扩容策略）：[https://github.com/openjdk/jdk/blob/master/src/java.base/share/classes/java/util/PriorityQueue.java](https://github.com/openjdk/jdk/blob/master/src/java.base/share/classes/java/util/PriorityQueue.java)
- JDK 21 Comparator API：[https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/Comparator.html](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/Comparator.html)
- Hello 算法 · 堆：[https://www.hello-algo.com/chapter_heap/](https://www.hello-algo.com/chapter_heap/)

> 下一篇：[图](./5_graph) —— 存储方式、BFS / DFS、拓扑排序、最短路径、并查集与最小生成树。
