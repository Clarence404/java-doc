---
description: 大 O 表示法、常见时间复杂度、空间复杂度、均摊分析、时空权衡、操作复杂度速查
---

# 复杂度分析

复杂度描述的是规模增长时开销怎么变，让我们写代码前就能判断方案能否扛住数据量。本篇讲大 O 估算、最好 / 平均 / 最坏与均摊复杂度，以及常见数据结构操作的复杂度与前提。

---

## 一、时间复杂度

### 1、大 O 表示法

大 O 描述运行时间随输入规模 n 增长的**上界趋势**，忽略常数系数和低阶项：

- T(n) = 2n² + 3n + 1 → O(n²)
- T(n) = 100n + 50 → O(n)
- T(n) = 5 → O(1)

同一个算法在不同输入下表现不同，分三种情况讨论：

| 情况 | 含义 | 例子（快速排序） |
|------|------|------------------|
| 最坏 | 最不利输入下的开销，工程上最常用，能给出保证 | 每次选到最值做基准，O(n²) |
| 平均 | 所有输入的期望开销 | 随机基准，O(n log n) |
| 最好 | 最有利输入下的开销，参考意义最小 | 每次对半分，O(n log n) |

### 2、常见时间复杂度（由低到高）

O(1) < O(log n) < O(n) < O(n log n) < O(n²) < O(2ⁿ) < O(n!)

| 复杂度 | 名称 | 典型场景 |
|--------|------|---------|
| O(1) | 常数阶 | 数组下标访问、`HashMap.get`（平均） |
| O(log n) | 对数阶 | 二分查找、平衡树查询、堆的插入与删除堆顶 |
| O(n) | 线性阶 | 遍历数组、链表查找 |
| O(n log n) | 线性对数阶 | 归并排序、堆排序、快速排序（平均） |
| O(n²) | 平方阶 | 冒泡排序、双重循环枚举所有数对 |
| O(2ⁿ) | 指数阶 | 枚举全部子集、朴素递归斐波那契 |
| O(n!) | 阶乘阶 | 枚举全排列、旅行商问题暴力解 |

旅行商问题的暴力解要枚举所有城市排列，是 O(n!)；用状态压缩动态规划（Held-Karp）可降到 O(n² · 2ⁿ)，仍是指数级。

按 1 秒约 10⁸ 次简单运算粗估，常见规模上限如下（刷题时据此反推该用什么复杂度）：

| n 的规模 | 可接受的复杂度 |
|----------|----------------|
| ≤ 10 | O(n!) |
| ≤ 20 | O(2ⁿ) |
| ≤ 500 | O(n³) |
| ≤ 5000 | O(n²) |
| ≤ 10⁶ | O(n log n) |
| ≤ 10⁸ | O(n) |

### 3、代码示例

```java
// O(1)：常数时间
int getFirst(int[] arr) {
    return arr[0];
}

// O(n)：循环 n 次
int sum(int[] arr) {
    int s = 0;
    for (int x : arr) s += x;
    return s;
}

// O(n²)：两层循环
void bubbleSort(int[] arr) {
    for (int i = 0; i < arr.length; i++) {
        for (int j = 0; j < arr.length - i - 1; j++) {
            if (arr[j] > arr[j + 1]) swap(arr, j, j + 1);
        }
    }
}

void swap(int[] arr, int i, int j) {
    int t = arr[i];
    arr[i] = arr[j];
    arr[j] = t;
}

// O(log n)：每次把搜索区间减半
int binarySearch(int[] arr, int target) {
    int lo = 0, hi = arr.length - 1;
    while (lo <= hi) {
        int mid = lo + (hi - lo) / 2;   // 不写 (lo + hi) / 2，避免 int 溢出
        if (arr[mid] == target) return mid;
        if (arr[mid] < target) lo = mid + 1;
        else hi = mid - 1;
    }
    return -1;
}

// O(2ⁿ)：每次分裂成两个子问题（紧确界是 O(φⁿ)，φ ≈ 1.618）
int fib(int n) {
    if (n <= 1) return n;
    return fib(n - 1) + fib(n - 2);
}
```

朴素递归斐波那契慢在**重复子问题**：`fib(5)` 会算两次 `fib(3)`、三次 `fib(2)`。用数组记下算过的结果（记忆化）就降到 O(n)，这正是 [动态规划](./2_algorithms/5_dynamic_programming) 的出发点。

---

## 二、空间复杂度

空间复杂度描述算法运行时**额外占用的内存**随 n 的增长趋势。

### 1、计算规则

| 内存类型 | 是否计入 |
|---------|----------|
| 输入空间 | 通常不计入 |
| 暂存空间（变量、辅助数组、递归调用栈） | 计入 |
| 输出空间 | 按题目约定，多数题目不计入返回值 |

递归的空间开销容易被忽略：每层调用都占一个栈帧，**递归深度就是空间复杂度**。递归深度过大还会抛 `StackOverflowError`，原因见 [JVM 总览](/jvm/0_overview) 中的虚拟机栈部分。

### 2、代码示例

```java
// O(1)：只用几个变量
int findMax(int[] arr) {
    int max = arr[0];
    for (int x : arr) max = Math.max(max, x);
    return max;
}

// O(n)：申请与输入等大的辅助数组
int[] copyArray(int[] arr) {
    return Arrays.copyOf(arr, arr.length);
}

// O(n)：递归调用栈深度为 n
long factorial(int n) {
    if (n <= 1) return 1;            // 写成 n == 1 时，传入 0 或负数会无限递归
    return n * factorial(n - 1);
}

// O(log n)：二分递归，调用栈深度 log n
int binarySearch(int[] arr, int lo, int hi, int target) {
    if (lo > hi) return -1;
    int mid = lo + (hi - lo) / 2;
    if (arr[mid] == target) return mid;
    if (arr[mid] < target) return binarySearch(arr, mid + 1, hi, target);
    return binarySearch(arr, lo, mid - 1, target);
}
```

---

## 三、均摊分析

有些操作**偶尔很贵、大多数时候很便宜**，单看最坏情况会高估总开销。均摊分析把一串操作的总代价平摊到每次操作上。

### 1、ArrayList 尾部追加

`ArrayList.add` 在容量够时是 O(1)；容量不够时扩容到约 1.5 倍并拷贝全部元素，这一次是 O(n)。但扩容后要再追加约 n/2 次才会触发下一次扩容，把这次拷贝的 O(n) 平摊到这 n/2 次追加上，每次只多出 O(1)。所以**连续追加 n 个元素总共 O(n)，单次均摊 O(1)**。

| 视角 | `ArrayList.add(e)` |
|------|--------------------|
| 单次最坏 | O(n)（触发扩容） |
| 均摊 | O(1) |

### 2、其他常见例子

- `HashMap.put`：扩容时要把所有节点迁移到新数组，均摊后仍是 O(1)；扩容细节见 [集合框架](/java/21_topic_collection)
- 用两个栈实现队列：每个元素最多进出每个栈各一次，出队均摊 O(1)
- 并查集（路径压缩 + 按秩合并）：单次操作均摊 O(α(n))，α 是增长极慢的反阿克曼函数，实际可视为常数

均摊 O(1) 不等于每次都快：对延迟敏感的场景（如单次请求不能卡顿），应预估容量一次分配到位，避免运行中扩容。

---

## 四、时空权衡

| 策略 | 做法 | 典型例子 |
|------|------|---------|
| 以空间换时间 | 多存数据，少做计算 | 哈希表去重、DP 表记录子问题、前缀和数组 |
| 以时间换空间 | 少存数据，多算几遍 | 原地排序、滚动数组压缩 DP 空间 |

后端开发中内存通常比 CPU 时间便宜，多数场景优先以空间换时间；但数据量大到放不进内存时，就要换成分桶、外部排序这类思路，见 [海量数据算法题](/scenario/3_massive_data)。

---

## 五、常见操作复杂度速查

复杂度都有前提，速查表里写出前提才不会用错：

| 数据结构 | 访问 | 查找 | 插入 | 删除 |
|---------|------|------|------|------|
| 数组 / `ArrayList` | O(1) | O(n)，有序时二分 O(log n) | 尾部均摊 O(1)，其他位置 O(n) | 尾部 O(1)，其他位置 O(n) |
| 链表 | O(n) | O(n) | 已知前驱节点 O(1)，按位置先定位 O(n) | 已知前驱节点 O(1)，按位置先定位 O(n) |
| 哈希表 | — | 平均 O(1)，最坏 O(n)（`HashMap` 树化后 O(log n)） | 平均 O(1) | 平均 O(1) |
| 平衡二叉搜索树 | — | O(log n) | O(log n) | O(log n) |
| 二叉堆 | 堆顶 O(1) | O(n) | O(log n) | 删除堆顶 O(log n)，删除任意元素 O(n) |

各种排序算法的复杂度与稳定性对比集中在 [排序算法](./2_algorithms/1_sort) 一篇，这里不再重复。

---

## 小结

- 大 O 只看增长趋势，忽略常数和低阶项；工程上默认讨论最坏复杂度
- 先看数据规模再选算法：n ≈ 10⁵ 时 O(n²) 必然超时，至少要 O(n log n)
- 空间复杂度要算上递归调用栈，递归深度就是栈空间
- 均摊分析适合「偶尔很贵」的操作，`ArrayList.add`、`HashMap.put` 都是均摊 O(1)
- 复杂度有前提：链表 O(1) 插删要先拿到节点，哈希表 O(1) 是平均值，堆只有删除堆顶是 O(log n)

## 参考资料

- Hello 算法 · 复杂度分析：[https://www.hello-algo.com/chapter_computational_complexity/](https://www.hello-algo.com/chapter_computational_complexity/)
- JDK 21 ArrayList API（均摊常数时间的说明）：[https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/ArrayList.html](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/ArrayList.html)
- JDK 21 PriorityQueue API（各操作的时间复杂度）：[https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/PriorityQueue.html](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/PriorityQueue.html)

> 下一篇：[数组与链表](./1_data_structures/0_array_list) —— 连续存储与链式存储、ArrayList 扩容、链表指针操作模板。
