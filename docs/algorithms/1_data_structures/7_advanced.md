---
description: 并查集路径压缩与按秩合并、单调栈、单调队列、树状数组、线段树与懒标记、选型对比与高频题
---

# 并查集、单调栈与线段树

> 前置阅读：[栈与队列](./1_stack_queue)、[图](./5_graph)、[前缀和与差分数组](../3_patterns/3_prefix_sum)

并查集、单调栈、单调队列、树状数组和线段树都是为一类特定查询设计的专用结构，套上模板就能把暴力解降一个数量级。本篇讲五种结构的原理、Java 模板、选型对比与高频题，基线为 JDK 21。

---

## 一、并查集（Union-Find）

### 1、解决什么问题

并查集处理**动态连通性**：不断把两个集合合并，并随时回答「x 和 y 在不在同一个集合」。每个集合用一棵树表示，`parent[x]` 指向父节点，根节点就是整个集合的代表元。

- `find(x)`：沿 `parent` 一路向上找到根
- `union(x, y)`：分别找到两个根，把一个根挂到另一个根下面
- 判断连通：`find(x) == find(y)`

朴素实现中树可能退化成一条链，`find` 变成 O(n)。两个优化解决这个问题：

- **路径压缩**：`find` 时把沿途每个节点直接挂到根上，下次查找一步到位
- **按秩合并**：秩（rank）近似树高，合并时把矮树挂到高树下，树高最多 O(log n)

![并查集路径压缩前后](../../assets/algorithms/union_find_path_compression.svg)

两者同时使用后，单次操作的均摊复杂度为 O(α(n))。α 是反阿克曼函数，在任何实际数据规模下都不超过 4，可视为常数。只用其中一个时是 O(log n)。

### 2、Java 模板

```java
class UnionFind {
    private final int[] parent, rank;
    private int count;                        // 当前集合个数

    UnionFind(int n) {
        parent = new int[n];
        rank = new int[n];
        count = n;
        for (int i = 0; i < n; i++) parent[i] = i;
    }

    int find(int x) {                         // 路径压缩
        if (parent[x] != x) parent[x] = find(parent[x]);
        return parent[x];
    }

    boolean union(int x, int y) {             // 按秩合并；已连通返回 false
        int px = find(x), py = find(y);
        if (px == py) return false;
        if (rank[px] < rank[py]) { int t = px; px = py; py = t; }
        parent[py] = px;
        if (rank[px] == rank[py]) rank[px]++;
        count--;
        return true;
    }

    boolean connected(int x, int y) { return find(x) == find(y); }

    int count() { return count; }
}
```

**写法要点**：

- 递归的 `find` 在按秩合并下树高不超过 log n，不会栈溢出；只做路径压缩不做按秩合并时，第一次 `find` 可能面对一条长链，n 很大时改成迭代写法更稳
- 也可以按集合大小（size）合并，效果相同，还能顺带回答「x 所在集合有多少个元素」
- 元素不是 0 ~ n−1 的整数（如字符串、坐标）时，先用 `HashMap` 编号，或把网格坐标压成 `r * cols + c`

### 3、典型题

- **连通分量个数**（LeetCode 547 省份数量）：对每条边 `union`，最后的 `count()` 就是答案；LeetCode 200 岛屿数量也可以这样做，把相邻的陆地格子合并
- **冗余连接**（LeetCode 684）：按顺序加边，`union` 返回 `false` 说明两端本来就连通，这条边会成环，就是答案
- **等式方程**（LeetCode 990）：先把所有 `==` 合并，再检查每个 `!=` 两端是否被合到了一起
- **Kruskal 最小生成树**：边按权重排序，用并查集判断加边是否成环，代码见 [图](./5_graph#八、最小生成树)

并查集只能合并，不能高效拆分；需要删边的连通性问题通常倒过来处理（离线逆序加边）。

---

## 二、单调栈

### 1、思想与模板

单调栈让栈内元素保持**单调递增或单调递减**。新元素入栈前，先把破坏单调性的栈顶依次弹出，被弹出的元素恰好在此刻找到了「右边第一个比它大（或小）的元素」。每个元素最多入栈、出栈各一次，整体 O(n)，代替暴力的 O(n²)。

**模板：找右边第一个更大的元素**

```java
int[] nextGreater(int[] nums) {
    int n = nums.length;
    int[] res = new int[n];
    Arrays.fill(res, -1);                      // 找不到时为 -1
    Deque<Integer> stack = new ArrayDeque<>(); // 存下标，栈底到栈顶对应的值非递增
    for (int i = 0; i < n; i++) {
        while (!stack.isEmpty() && nums[i] > nums[stack.peek()]) {
            res[stack.pop()] = nums[i];        // 栈顶找到了右边第一个更大的值
        }
        stack.push(i);
    }
    return res;
}
```

**栈里存下标，不存值**：下标能反查出值，反过来不行。题目要的往往是距离（每日温度）或宽度（柱状图最大矩形），只有下标才能算出来。循环数组（LeetCode 503）遍历两遍，下标取 `i % n` 即可。

### 2、四种变体怎么选

| 要找的 | 栈内单调性（栈底 → 栈顶） | 出栈条件 | 结果在何时记录 |
|--------|--------------------------|----------|----------------|
| 右边第一个更大 | 非递增 | `nums[i] > 栈顶` | 弹出时，答案是 `nums[i]` |
| 右边第一个更小 | 非递减 | `nums[i] < 栈顶` | 弹出时，答案是 `nums[i]` |
| 左边第一个更大 | 严格递减 | `nums[i] >= 栈顶` | 弹完后，答案是新的栈顶 |
| 左边第一个更小 | 严格递增 | `nums[i] <= 栈顶` | 弹完后，答案是新的栈顶 |

**严格还是非严格**：比较用 `>` 还是 `>=` 决定相等元素的去留。用 `>` 时相等元素留在栈里，找到的是「严格更大」；改成 `>=` 则相等元素也会被弹出。题目说「更大」还是「大于等于」，就对应改这一个符号。

### 3、典型题

**每日温度**（LeetCode 739）：就是「右边第一个更大」，答案记下标差。

```java
int[] dailyTemperatures(int[] t) {
    int[] res = new int[t.length];
    Deque<Integer> stack = new ArrayDeque<>();
    for (int i = 0; i < t.length; i++) {
        while (!stack.isEmpty() && t[i] > t[stack.peek()]) {
            int j = stack.pop();
            res[j] = i - j;
        }
        stack.push(i);
    }
    return res;
}
```

**柱状图中最大的矩形**（LeetCode 84）：以每根柱子为高，向左右延伸到第一根更矮的柱子为止。栈内递增，柱子被弹出时，右边界是当前下标 `i`，左边界是弹出后的新栈顶；末尾放一个高度为 0 的哨兵，把栈里剩下的柱子全部结算。

```java
int largestRectangleArea(int[] heights) {
    int n = heights.length, max = 0;
    Deque<Integer> stack = new ArrayDeque<>();
    for (int i = 0; i <= n; i++) {
        int h = i == n ? 0 : heights[i];              // 哨兵：高度 0 清空栈
        while (!stack.isEmpty() && h < heights[stack.peek()]) {
            int height = heights[stack.pop()];
            int left = stack.isEmpty() ? -1 : stack.peek();
            max = Math.max(max, height * (i - left - 1));
        }
        stack.push(i);
    }
    return max;
}
```

**接雨水**（LeetCode 42）：栈内递减，遇到更高的柱子时弹出「坑底」，坑底左边的新栈顶和当前柱子构成左右两壁，按层累加水量。双指针解法空间 O(1)，见 [双指针](../3_patterns/1_two_pointers)。

```java
int trap(int[] height) {
    int water = 0;
    Deque<Integer> stack = new ArrayDeque<>();
    for (int i = 0; i < height.length; i++) {
        while (!stack.isEmpty() && height[i] > height[stack.peek()]) {
            int bottom = stack.pop();
            if (stack.isEmpty()) break;                // 左边没有墙，存不住水
            int left = stack.peek();
            int h = Math.min(height[left], height[i]) - height[bottom];
            water += h * (i - left - 1);
        }
        stack.push(i);
    }
    return water;
}
```

---

## 三、单调队列

### 1、滑动窗口最大值

单调队列是两端都能出的单调栈：队尾按单调栈的规则弹出，队头额外负责弹出「已经滑出窗口」的元素。LeetCode 239 中，队列存下标，对应的值从队头到队尾单调递减，队头就是当前窗口的最大值：

1. 队头下标滑出窗口，就从头部弹出
2. 新元素入队前，从尾部弹出所有比它小的元素：它们比新元素先离开窗口、又比新元素小，不可能再成为最大值
3. 窗口形成后，队头即为答案

```java
int[] maxSlidingWindow(int[] nums, int k) {
    int n = nums.length;
    int[] res = new int[n - k + 1];
    Deque<Integer> deque = new ArrayDeque<>();     // 存下标，对应的值单调递减
    for (int i = 0; i < n; i++) {
        if (!deque.isEmpty() && deque.peekFirst() <= i - k) deque.pollFirst();
        while (!deque.isEmpty() && nums[deque.peekLast()] < nums[i]) deque.pollLast();
        deque.offerLast(i);
        if (i >= k - 1) res[i - k + 1] = nums[deque.peekFirst()];
    }
    return res;
}
```

每个下标最多入队、出队各一次，整体 O(n)；用堆做同一题是 O(n log k)，还要处理堆顶过期的懒删除。求窗口最小值时把比较符号反过来。

### 2、与滑动窗口的分工

[滑动窗口](../3_patterns/2_sliding_window) 讲的是窗口怎么移动（固定窗口进一个出一个、可变窗口何时收缩），单调队列只负责回答「窗口里的最值是多少」，两者是组合关系。不是滑动窗口的题也会用到它：

- **限制差值的最长子数组**（LeetCode 1438）：可变窗口 + 一个递减队列维护最大值 + 一个递增队列维护最小值
- **和至少为 K 的最短子数组**（LeetCode 862）：有负数时滑动窗口失效，改为在前缀和数组上维护递增队列
- **DP 优化**（LeetCode 1696 跳跃游戏 VI）：`dp[i] = max(dp[i-k..i-1]) + nums[i]`，用单调队列取窗口最大值，O(nk) 降到 O(n)

---

## 四、树状数组（Fenwick Tree）

### 1、从前缀和说起

[前缀和](../3_patterns/3_prefix_sum) 能 O(1) 求区间和，但修改一个元素要更新后面所有前缀和，O(n)。树状数组把前缀和拆成 O(log n) 段分别存储，修改和查询都是 O(log n)，适合「单点修改 + 区间求和」交替进行。

核心是 lowbit：`i & -i` 取出 i 的最低位 1（原理见 [位运算](../3_patterns/4_bit_manipulation)）。

- `tree[i]` 存原数组区间 `(i - lowbit(i), i]` 的和，下标从 1 开始
- 求前缀和：`i` 不断减去 lowbit，每步累加一段，最多 log n 步
- 单点修改：`i` 不断加上 lowbit，更新所有覆盖它的段，最多 log n 步

例如 `prefixSum(7)` = `tree[7] + tree[6] + tree[4]`，分别覆盖 `(6,7]`、`(4,6]`、`(0,4]`。

### 2、Java 模板

```java
class Fenwick {
    private final long[] tree;                     // 下标从 1 开始

    Fenwick(int n) { tree = new long[n + 1]; }

    void add(int i, long delta) {                  // a[i] += delta
        for (; i < tree.length; i += i & -i) tree[i] += delta;
    }

    long prefixSum(int i) {                        // a[1] + ... + a[i]
        long s = 0;
        for (; i > 0; i -= i & -i) s += tree[i];
        return s;
    }

    long rangeSum(int l, int r) { return prefixSum(r) - prefixSum(l - 1); }
}
```

LeetCode 307「区域和检索 - 数组可修改」直接套用：初始化时对每个元素 `add` 一次，O(n log n)；`update` 时 `add(i + 1, val - 旧值)`，注意题目下标从 0 开始。

**区间修改 + 单点查询**：在差分数组上建树状数组。区间 `[l, r]` 加 v 就是 `add(l, v)`、`add(r + 1, -v)`，单点的值就是差分的前缀和 `prefixSum(i)`。

### 3、逆序对

逆序对是 `i < j` 且 `nums[i] > nums[j]` 的数对个数（LCR 170）。从右往左遍历，树状数组按「值」计数：查询已出现的、比当前值小的个数，再把当前值计入。值域大时先离散化，把值映射成 1 ~ m 的排名：

```java
long reversePairs(int[] nums) {
    int[] sorted = Arrays.stream(nums).distinct().sorted().toArray();  // 去重后离散化
    Fenwick bit = new Fenwick(sorted.length);
    long count = 0;
    for (int i = nums.length - 1; i >= 0; i--) {
        int rank = Arrays.binarySearch(sorted, nums[i]) + 1;          // 排名从 1 开始
        count += bit.prefixSum(rank - 1);                              // 右边严格更小的个数
        bit.add(rank, 1);
    }
    return count;
}
```

离散化必须先去重，否则相同值的二分结果可能落在不同位置。LeetCode 315「计算右侧小于当前元素的个数」是同一思路，把每一步的 `prefixSum` 记下来即可。逆序对也能用归并排序在合并时统计，见 [分治算法](../2_algorithms/2_divide_conquer)。

---

## 五、线段树（Segment Tree）

### 1、结构

线段树是一棵二叉树，每个节点代表一个区间并保存该区间的聚合值（和、最大值、最小值等）。根节点代表 `[0, n−1]`，节点 `[l, r]` 的左孩子是 `[l, m]`、右孩子是 `[m+1, r]`。用数组存储时，节点 `i` 的孩子是 `2i` 和 `2i+1`，数组开 4n 足够。

任意区间查询最多拆成 O(log n) 个「完全落在查询范围内」的节点，把它们的值合并即可：

![线段树区间查询拆分](../../assets/algorithms/segment_tree_query.svg)

### 2、懒标记

区间修改如果逐个叶子更新，单次就是 O(n)。**懒标记**的做法是：修改走到一个完全被覆盖的节点时，只更新这个节点的聚合值，并在它身上记一笔「子树还欠着 +v」，不再往下走；之后查询或修改需要进入它的孩子时，才把这笔账下传（`pushDown`）。这样区间修改和区间查询都是 O(log n)。

### 3、Java 模板（区间加、区间求和）

```java
class SegmentTree {
    private final int n;                           // 要求 n >= 1
    private final long[] sum, lazy;

    SegmentTree(int[] a) {
        n = a.length;
        sum = new long[4 * n];
        lazy = new long[4 * n];
        build(1, 0, n - 1, a);
    }

    void add(int ql, int qr, long v) { add(1, 0, n - 1, ql, qr, v); }

    long query(int ql, int qr) { return query(1, 0, n - 1, ql, qr); }

    private void build(int node, int l, int r, int[] a) {
        if (l == r) { sum[node] = a[l]; return; }
        int m = (l + r) >>> 1;
        build(node * 2, l, m, a);
        build(node * 2 + 1, m + 1, r, a);
        sum[node] = sum[node * 2] + sum[node * 2 + 1];
    }

    private void apply(int node, int l, int r, long v) {     // 整段加 v：改聚合值，记懒标记
        sum[node] += v * (r - l + 1);
        lazy[node] += v;
    }

    private void pushDown(int node, int l, int r) {          // 把欠账下传给两个孩子
        if (lazy[node] == 0) return;
        int m = (l + r) >>> 1;
        apply(node * 2, l, m, lazy[node]);
        apply(node * 2 + 1, m + 1, r, lazy[node]);
        lazy[node] = 0;
    }

    private void add(int node, int l, int r, int ql, int qr, long v) {
        if (qr < l || r < ql) return;                         // 不相交
        if (ql <= l && r <= qr) { apply(node, l, r, v); return; }   // 完全覆盖
        pushDown(node, l, r);
        int m = (l + r) >>> 1;
        add(node * 2, l, m, ql, qr, v);
        add(node * 2 + 1, m + 1, r, ql, qr, v);
        sum[node] = sum[node * 2] + sum[node * 2 + 1];
    }

    private long query(int node, int l, int r, int ql, int qr) {
        if (qr < l || r < ql) return 0;
        if (ql <= l && r <= qr) return sum[node];
        pushDown(node, l, r);
        int m = (l + r) >>> 1;
        return query(node * 2, l, m, ql, qr) + query(node * 2 + 1, m + 1, r, ql, qr);
    }
}
```

**改造要点**：

- 单点修改就是 `add(i, i, delta)`；只有单点修改时可以去掉 `lazy`
- 维护最大值时，合并改成 `Math.max`，`apply` 改成 `max[node] += v`（区间加对最大值的影响与区间长度无关）
- 区间赋值的懒标记要能区分「没有标记」和「赋值为 0」，通常另用一个 `boolean` 数组
- 值域很大（如 10⁹）而操作次数有限时，用**动态开点**：节点按需创建，用对象或数组模拟左右孩子指针，典型题是 LeetCode 715 Range 模块、729 / 731 我的日程安排表
- 节点保存多个字段即可支持更复杂的合并，例如「区间和、最大前缀和、最大后缀和、最大子段和」支持带修改的最大子数组和，推导见 [分治算法](../2_algorithms/2_divide_conquer)

### 4、线段树、树状数组、前缀和怎么选

- **数组不变，只查询**：前缀和，O(1) 查询；只有批量区间加、最后统一查询时用差分
- **单点修改 + 区间求和**：树状数组，代码短、常数小
- **区间修改 + 区间查询，或要维护最值等不可减的信息**：线段树。树状数组靠「两个前缀和相减」得到区间值，最大值没法相减，所以区间最值基本只能用线段树

---

## 六、怎么选

| 问题特征 | 结构 | 单次复杂度 | 典型题 |
|----------|------|------------|--------|
| 动态合并集合，问两点是否连通、连通块个数 | 并查集 | 均摊 O(α(n)) | 547、684、990 |
| 左 / 右边第一个更大或更小的元素 | 单调栈 | 整体 O(n)，均摊 O(1) | 739、84、42 |
| 滑动窗口内的最大 / 最小值 | 单调队列 | 整体 O(n)，均摊 O(1) | 239、1438、1696 |
| 静态数组的区间和 | 前缀和 | 预处理 O(n)，查询 O(1) | 303、560 |
| 单点修改 + 区间求和、逆序对计数 | 树状数组 | O(log n) | 307、315 |
| 区间修改 + 区间查询、区间最值 | 线段树 | O(log n) | 307、699、715 |

判断顺序：先看数据会不会变。不变的用前缀和或单调栈这种「一次扫描」的结构；会变的，再看修改是单点还是区间、查询能不能相减，决定树状数组还是线段树。

---

## 七、LeetCode 高频题清单

| 题目 | 难度 | 用到的结构 |
|------|------|------------|
| LeetCode 547 省份数量 | 中等 | 并查集 |
| LeetCode 684 冗余连接 | 中等 | 并查集判环 |
| LeetCode 990 等式方程的可满足性 | 中等 | 并查集 |
| LeetCode 1584 连接所有点的最小费用 | 中等 | 并查集 + Kruskal |
| LeetCode 739 每日温度 | 中等 | 单调栈 |
| LeetCode 503 下一个更大元素 II | 中等 | 单调栈（循环数组） |
| LeetCode 84 柱状图中最大的矩形 | 困难 | 单调栈 |
| LeetCode 42 接雨水 | 困难 | 单调栈 / 双指针 |
| LeetCode 239 滑动窗口最大值 | 困难 | 单调队列 |
| LeetCode 1438 绝对差不超过限制的最长连续子数组 | 中等 | 单调队列 × 2 |
| LeetCode 307 区域和检索 - 数组可修改 | 中等 | 树状数组 / 线段树 |
| LeetCode 315 计算右侧小于当前元素的个数 | 困难 | 树状数组 + 离散化 |
| LCR 170 交易逆序对的总数 | 困难 | 树状数组 / 归并排序 |
| LeetCode 715 Range 模块 | 困难 | 动态开点线段树 |

按题型分类的完整刷题清单见 [LeetCode 高频题分类](../4_practice/0_leet_code)，其中「栈与队列」「图与并查集」两类与本篇对应。

---

## 小结

- 并查集管动态连通性，路径压缩 + 按秩合并后均摊 O(α(n))；`union` 返回 `false` 就是成环
- 单调栈找左 / 右第一个更大或更小，栈里存下标，`>` 与 `>=` 决定相等元素的去留
- 单调队列求窗口最值，队头负责过期、队尾负责单调，和滑动窗口是组合关系
- 树状数组靠 lowbit 把前缀和拆成 log n 段，适合单点修改 + 区间求和与逆序对
- 线段树用懒标记支持区间修改，能维护最值等不可相减的信息，代价是代码更长

## 参考资料

- OI Wiki · 并查集：[https://oi-wiki.org/ds/dsu/](https://oi-wiki.org/ds/dsu/)
- OI Wiki · 单调栈：[https://oi-wiki.org/ds/monotonous-stack/](https://oi-wiki.org/ds/monotonous-stack/)
- OI Wiki · 单调队列：[https://oi-wiki.org/ds/monotonous-queue/](https://oi-wiki.org/ds/monotonous-queue/)
- OI Wiki · 树状数组：[https://oi-wiki.org/ds/fenwick/](https://oi-wiki.org/ds/fenwick/)
- OI Wiki · 线段树：[https://oi-wiki.org/ds/seg/](https://oi-wiki.org/ds/seg/)
- Tarjan, R. E. Efficiency of a Good But Not Linear Set Union Algorithm（1975）

> 下一篇：[搜索算法](../2_algorithms/0_search) —— 二分查找模板与边界、二分答案、DFS / BFS 模板。
