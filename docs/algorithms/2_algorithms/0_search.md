---
description: 二分查找模板与边界、二分答案、DFS / BFS 遍历模板、双向 BFS
---

# 搜索算法

> **本篇目标**：写对二分查找的三个模板（精确查找、左边界、右边界）并会「二分答案」，分清遍历型 DFS 与回溯型 DFS，掌握层序 BFS 与双向 BFS 的写法。
>
> **前置阅读**：[复杂度分析](../0_complexity)、[图](../1_data_structures/5_graph)

线性搜索逐个比较，O(n)，无序数据只能这么做，不再单独展开。本篇讲有序数据上的二分，以及图、树、网格上的 DFS / BFS 遍历模板；拓扑排序、最短路径、并查集等图算法见 [图](../1_data_structures/5_graph)。

---

## 一、二分查找

### 1、前提与区间写法

二分的前提是**单调性**：数组有序，或者「某个条件对答案来说一旦成立就一直成立」。每轮排除一半，时间 O(log n)。

写二分最容易错的是边界。先选定一种区间写法，再让循环条件和指针移动与之匹配：

| 写法 | 初始值 | 循环条件 | 收缩方式 |
|------|--------|----------|----------|
| 闭区间 `[lo, hi]` | `hi = n - 1` | `lo <= hi` | `lo = mid + 1` / `hi = mid - 1` |
| 左闭右开 `[lo, hi)` | `hi = n` | `lo < hi` | `lo = mid + 1` / `hi = mid` |

`mid` 一律写成 `lo + (hi - lo) / 2`，避免 `lo + hi` 超出 `int` 范围。

### 2、精确查找

```java
// 返回 target 的下标，不存在返回 -1（闭区间写法）
int binarySearch(int[] arr, int target) {
    int lo = 0, hi = arr.length - 1;
    while (lo <= hi) {
        int mid = lo + (hi - lo) / 2;
        if (arr[mid] == target) return mid;
        if (arr[mid] < target) lo = mid + 1;
        else hi = mid - 1;
    }
    return -1;
}
```

### 3、左边界与右边界

有重复元素时，「找到任意一个」不够用，要找边界。下面两个函数都用左闭右开写法，命名沿用 C++ `lower_bound` / `upper_bound` 的约定：

```java
// 第一个 >= target 的下标；全部小于 target 时返回 arr.length
int lowerBound(int[] arr, int target) {
    int lo = 0, hi = arr.length;
    while (lo < hi) {
        int mid = lo + (hi - lo) / 2;
        if (arr[mid] < target) lo = mid + 1;
        else hi = mid;
    }
    return lo;
}

// 第一个 > target 的下标；全部小于等于 target 时返回 arr.length
int upperBound(int[] arr, int target) {
    int lo = 0, hi = arr.length;
    while (lo < hi) {
        int mid = lo + (hi - lo) / 2;
        if (arr[mid] <= target) lo = mid + 1;
        else hi = mid;
    }
    return lo;
}
```

两者只差一个 `<` 与 `<=`。常用组合：

- `target` 第一次出现的位置：`lowerBound(arr, t)`，再判断该下标是否越界、值是否等于 `t`
- `target` 最后一次出现的位置（最后一个 `<= t`）：`upperBound(arr, t) - 1`
- `target` 出现次数：`upperBound(arr, t) - lowerBound(arr, t)`

![lowerBound 与 upperBound 在重复元素上的位置](../../assets/algorithms/binary_search_bounds.svg)

### 4、旋转排序数组

LeetCode 33 搜索旋转排序数组：数组整体不再有序，但从 `mid` 切开后**至少有一半有序**，先判断哪一半有序，再看 `target` 是否落在这一半：

```java
int search(int[] nums, int target) {
    int lo = 0, hi = nums.length - 1;
    while (lo <= hi) {
        int mid = lo + (hi - lo) / 2;
        if (nums[mid] == target) return mid;
        if (nums[lo] <= nums[mid]) {             // 左半有序
            if (nums[lo] <= target && target < nums[mid]) hi = mid - 1;
            else lo = mid + 1;
        } else {                                 // 右半有序
            if (nums[mid] < target && target <= nums[hi]) lo = mid + 1;
            else hi = mid - 1;
        }
    }
    return -1;
}
```

### 5、二分答案

很多题的输入并不有序，但**答案满足单调性**：答案 x 可行，则任何比 x 更宽松的值也可行。这时直接在答案的取值范围上二分，每次用一个 `O(n)` 的判定函数检查 `mid` 是否可行。

LeetCode 875 爱吃香蕉的珂珂：速度越快，吃完所需小时数越少，求能在 `h` 小时内吃完的最小速度：

```java
int minEatingSpeed(int[] piles, int h) {
    int lo = 1, hi = Arrays.stream(piles).max().getAsInt();
    while (lo < hi) {                          // 找第一个可行的速度
        int mid = lo + (hi - lo) / 2;
        if (hoursNeeded(piles, mid) <= h) hi = mid;
        else lo = mid + 1;
    }
    return lo;
}

long hoursNeeded(int[] piles, int speed) {
    long hours = 0;                            // 累加可能超过 int 范围
    for (int p : piles) hours += (p + speed - 1L) / speed; // 向上取整
    return hours;
}
```

套路固定：确定答案上下界 → 写判定函数 → 用「找第一个可行值」的左边界模板。LeetCode 1011 在 D 天内送达包裹的能力是同一个模型。

---

## 二、深度优先搜索（DFS）

### 1、遍历型 DFS

DFS 沿一条路走到底再回退。用来判断**连通性、统计连通块**时，每个节点**只标记一次、永不撤销**，每个点和边各访问一次，复杂度 O(V + E)：

```java
// 邻接表表示的图，统计从 start 出发能到达的节点
void dfs(List<List<Integer>> graph, int node, boolean[] visited) {
    visited[node] = true;                      // 标记后不再撤销
    for (int next : graph.get(node)) {
        if (!visited[next]) dfs(graph, next, visited);
    }
}
```

网格上的 DFS（LeetCode 200 岛屿数量）只是把「邻居」换成上下左右四个格子，代码见 [回溯算法](./3_backtrack) 的网格 DFS 一节。

### 2、遍历 DFS 与回溯 DFS 的区别

DFS 还有一种用法：**枚举所有路径或组合**，比如全排列、单词搜索。这时递归返回后要**撤销标记**，让其他路径还能经过这个节点，这就是回溯：

| | 遍历型 DFS | 回溯型 DFS |
|--|-----------|-----------|
| 目的 | 连通性、能否到达、连通块计数 | 枚举所有路径 / 排列 / 组合 |
| visited | 标记一次，不撤销 | 进入时标记，返回时撤销 |
| 复杂度 | O(V + E) | 指数级，靠剪枝控制 |

把回溯里的「撤销标记」误用到连通性问题上，结果不会错，但同一个节点会被不同路径反复访问，复杂度从线性退化为指数级。回溯的写法见 [回溯算法](./3_backtrack)。

DFS 递归深度等于路径长度，最坏 O(V)。节点数到十万级时，递归可能触发 `StackOverflowError`，可改成显式栈（`ArrayDeque`）迭代。

---

## 三、广度优先搜索（BFS）

### 1、层序 BFS 模板

BFS 按「距离起点的步数」一层一层向外扩展，第一次到达终点时的层数就是**无权图最短路径**。下面的模板对节点类型做了泛化，`neighbors` 给出一个节点的所有相邻节点：

```java
<T> int bfs(T start, T target, Function<T, List<T>> neighbors) {
    Deque<T> queue = new ArrayDeque<>();
    Set<T> visited = new HashSet<>();
    queue.offer(start);
    visited.add(start);                        // 入队即标记，避免重复入队
    int steps = 0;
    while (!queue.isEmpty()) {
        for (int size = queue.size(); size > 0; size--) {   // 处理完整一层
            T cur = queue.poll();
            if (cur.equals(target)) return steps;          // 对象用 equals 比较
            for (T next : neighbors.apply(cur)) {
                if (visited.add(next)) queue.offer(next);  // add 返回 false 表示已访问
            }
        }
        steps++;
    }
    return -1;                                 // 不可达
}
```

- 队列用 `ArrayDeque`，比 `LinkedList` 少一层节点对象，速度更快
- 「入队时标记」而不是「出队时标记」，否则同一个节点会被多个前驱重复入队
- **多源 BFS**（LeetCode 994 腐烂的橘子）：把所有起点一次性放进队列作为第 0 层，其余写法不变

### 2、双向 BFS

单向 BFS 每层按分支因子 b 膨胀，搜索 d 层约访问 b^d 个节点。从起点和终点**同时**向中间搜索，每边只需约 d/2 层，节点数降到约 2·b^(d/2)。前提是终点已知，并且边可以反向走（无向图，或能求出前驱）：

```java
<T> int biBfs(T start, T target, Function<T, List<T>> neighbors) {
    if (start.equals(target)) return 0;
    Set<T> front = new HashSet<>(Set.of(start)), back = new HashSet<>(Set.of(target));
    Set<T> visited = new HashSet<>(Set.of(start, target));
    int steps = 0;                             // 返回值是「边数」
    while (!front.isEmpty() && !back.isEmpty()) {
        if (front.size() > back.size()) {      // 总是扩展较小的一端
            Set<T> tmp = front; front = back; back = tmp;
        }
        steps++;
        Set<T> next = new HashSet<>();
        for (T cur : front) {
            for (T nb : neighbors.apply(cur)) {
                if (back.contains(nb)) return steps;       // 两端相遇
                if (visited.add(nb)) next.add(nb);
            }
        }
        front = next;
    }
    return -1;
}
```

返回值是变换次数（边数）。LeetCode 127 单词接龙要的是「序列中的单词数」，等于边数 + 1；LeetCode 752 打开转盘锁要的就是边数。

![单向 BFS 与双向 BFS 的搜索范围](../../assets/algorithms/bidirectional_bfs.svg)

---

## 四、搜索方式对比

| | 线性搜索 | 二分查找 | BFS | DFS |
|--|---------|---------|-----|-----|
| 适用数据 | 任意序列 | 有序数组 / 单调答案 | 图、树、网格 | 图、树、网格 |
| 时间复杂度 | O(n) | O(log n) | O(V + E) | O(V + E)（遍历型） |
| 无权图最短路 | — | — | 支持 | 不支持 |
| 连通性判断 | — | — | 支持 | 支持 |
| 枚举全部路径 | — | — | 不适合 | 支持（回溯） |
| 额外空间 | O(1) | O(1) | O(V)（队列） | O(V)（调用栈） |

---

## 小结

- 二分先定区间写法：闭区间配 `lo <= hi`，左闭右开配 `lo < hi`；`mid = lo + (hi - lo) / 2`
- `lowerBound` 找第一个 `>= target`，`upperBound` 找第一个 `> target`，最后一个 `<= target` 是 `upperBound - 1`
- 答案有单调性就能二分答案：定上下界、写判定函数、套左边界模板
- 遍历型 DFS 标记不撤销，复杂度 O(V + E)；回溯型 DFS 返回时撤销标记，用于枚举
- BFS 入队即标记、队列用 `ArrayDeque`；双向 BFS 每次扩展较小的一端，注意返回值是边数还是节点数

## 参考资料

- OI Wiki 二分：[https://oi-wiki.org/basic/binary/](https://oi-wiki.org/basic/binary/)
- OI Wiki DFS（搜索）：[https://oi-wiki.org/search/dfs/](https://oi-wiki.org/search/dfs/)
- OI Wiki BFS（搜索）：[https://oi-wiki.org/search/bfs/](https://oi-wiki.org/search/bfs/)
- Java 21 `Arrays.binarySearch`：[https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/Arrays.html](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/Arrays.html)

> 下一篇：[排序算法](./1_sort) —— 比较类与非比较类排序、稳定性、快排划分、JDK 内置排序的实现。
