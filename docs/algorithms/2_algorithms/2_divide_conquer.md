---
description: 分治三步、主定理与正则条件、快速幂、逆序对、合并 K 个升序链表
---

# 分治算法

> 前置阅读：[排序算法](./1_sort)

分治把大问题拆成独立子问题分别求解再合并。本篇讲分治的三个步骤与适用条件、主定理估算复杂度、快速幂 / 逆序对 / 合并 K 个升序链表，以及分治、动态规划与贪心的区别。

---

## 一、分治思想

**分而治之（Divide and Conquer）**：把大问题拆成若干个**同类、规模更小**的子问题，递归求解后再合并结果。

1. **分解（Divide）**：把问题拆成规模更小的子问题
2. **解决（Conquer）**：递归求解子问题，规模足够小时直接求解
3. **合并（Combine）**：把子问题的解合并成原问题的解

适用条件：

- 问题能拆成规模更小的同类子问题
- 子问题之间相互独立；如果子问题大量重叠，应该改用 [动态规划](./5_dynamic_programming) 缓存结果
- 子问题的解能高效合并

---

## 二、主定理

分治算法的运行时间通常写成递推式 `T(n) = a·T(n/b) + f(n)`，其中 a ≥ 1 是子问题个数，b > 1 是规模缩小的倍数，f(n) 是分解与合并的代价。

记 `c* = log_b a`，比较 f(n) 与 n^c* 的增长速度：

| 情况 | 条件 | 结论 |
|------|------|------|
| 1 | 存在 ε > 0，使 f(n) = O(n^(c* − ε)) | T(n) = Θ(n^c*) |
| 2 | f(n) = Θ(n^c*) | T(n) = Θ(n^c* · log n) |
| 3 | 存在 ε > 0，使 f(n) = Ω(n^(c* + ε))，**且**存在常数 c < 1，对足够大的 n 有 a·f(n/b) ≤ c·f(n) | T(n) = Θ(f(n)) |

直观理解：把递归展开成一棵树，情况 1 是叶子层的工作量占主导，情况 2 是每层工作量相同、共 log n 层，情况 3 是根节点的合并代价占主导。情况 3 多出来的「正则条件」保证每往下一层工作量按比例减少；常见的多项式 f(n) 都满足它。

常见例子：

| 算法 | 递推式 | a, b, c* | 情况 | 结果 |
|------|--------|----------|------|------|
| 二分查找 | T(n) = T(n/2) + Θ(1) | 1, 2, 0 | 2 | Θ(log n) |
| 归并排序 | T(n) = 2T(n/2) + Θ(n) | 2, 2, 1 | 2 | Θ(n log n) |
| 二叉树遍历 | T(n) = 2T(n/2) + Θ(1) | 2, 2, 1 | 1 | Θ(n) |
| 最大子数组和（分治） | T(n) = 2T(n/2) + Θ(n) | 2, 2, 1 | 2 | Θ(n log n) |

主定理不覆盖所有递推式：子问题规模不相等（如快排最坏情况的 T(n) = T(n−1) + Θ(n)），或 f(n) 落在几种情况的缝隙里（如 2T(n/2) + n/log n），都需要用递归树或代入法单独分析。

---

## 三、经典应用

### 1、归并排序

归并排序是分治的标准范例，代码见 [排序算法](./1_sort) 的归并排序一节。从递归树看：每层把所有子数组合并一遍，总代价 Θ(n)；每层规模减半，共 log₂n 层，所以总复杂度 Θ(n log n)。

### 2、快速幂

求 `base^exp`：指数为偶数时 `base^exp = (base²)^(exp/2)`，为奇数时再多乘一个 `base`。每轮指数减半，O(log exp) 次乘法：

```java
// 计算 base^exp % mod，要求 1 <= mod < 2^31，保证 (mod-1)² 不超出 long
long fastPow(long base, long exp, long mod) {
    long result = 1 % mod;
    base %= mod;
    while (exp > 0) {
        if ((exp & 1) == 1) result = result * base % mod;  // 当前二进制位为 1
        base = base * base % mod;
        exp >>= 1;
    }
    return result;
}
```

`mod` 超过约 3.04×10^9 时，两个余数相乘会溢出 `long`，需要改用 `Math.multiplyHigh` 拼出 128 位乘积或 `BigInteger.modPow`。

LeetCode 50 Pow(x, n) 是浮点版本，没有取模，但 n 可能是负数。`n = Integer.MIN_VALUE` 时直接 `-n` 会溢出（结果还是它自己），所以先转成 `long`：

```java
double myPow(double x, int n) {
    long e = n;                       // 先转 long，再取反
    if (e < 0) { x = 1 / x; e = -e; }
    double result = 1;
    while (e > 0) {
        if ((e & 1) == 1) result *= x;
        x *= x;
        e >>= 1;
    }
    return result;
}
```

### 3、逆序对计数

逆序对是满足 `i < j` 且 `a[i] > a[j]` 的下标对，对应题目 LCR 170 交易逆序对的总数（原剑指 Offer 51）。在归并排序的合并步骤里顺手统计：右半的 `a[j]` 先于左半的 `a[i]` 放入结果时，左半剩下的 `a[i..mid]` 都比它大，一次贡献 `mid - i + 1` 个逆序对。

逆序对最多有 n(n−1)/2 个，n 约 6.6 万时就会超出 `int`，计数用 `long`：

```java
long countInversions(int[] a) {
    return sortAndCount(a, 0, a.length - 1, new int[a.length]);
}

long sortAndCount(int[] a, int lo, int hi, int[] tmp) {
    if (lo >= hi) return 0;
    int mid = lo + (hi - lo) / 2;
    long count = sortAndCount(a, lo, mid, tmp) + sortAndCount(a, mid + 1, hi, tmp);
    System.arraycopy(a, lo, tmp, lo, hi - lo + 1);
    int i = lo, j = mid + 1;
    for (int k = lo; k <= hi; k++) {
        if (i > mid)               a[k] = tmp[j++];
        else if (j > hi)           a[k] = tmp[i++];
        else if (tmp[i] <= tmp[j]) a[k] = tmp[i++];
        else {
            count += mid - i + 1;  // tmp[i..mid] 都比 tmp[j] 大
            a[k] = tmp[j++];
        }
    }
    return count;
}
```

LeetCode 315 计算右侧小于当前元素的个数、LeetCode 493 翻转对都是同一思路：在合并时统计跨左右两半的数对。

### 4、合并 K 个升序链表

LeetCode 23：K 个链表两两合并。如果从头到尾逐个合并，第 i 次合并要遍历前面累积的 i 个链表，总复杂度 O(N·K)（N 为节点总数）。改成**对半分治**：先把 K 个链表分成两半各自合并，再合并两个结果，每个节点只参与 log K 次合并，总复杂度 O(N log K)：

```java
class ListNode {
    int val;
    ListNode next;
    ListNode(int val) { this.val = val; }
}

ListNode mergeKLists(ListNode[] lists) {
    if (lists.length == 0) return null;
    return mergeRange(lists, 0, lists.length - 1);
}

ListNode mergeRange(ListNode[] lists, int lo, int hi) {
    if (lo == hi) return lists[lo];
    int mid = lo + (hi - lo) / 2;
    return mergeTwo(mergeRange(lists, lo, mid), mergeRange(lists, mid + 1, hi));
}

ListNode mergeTwo(ListNode a, ListNode b) {
    ListNode dummy = new ListNode(0), tail = dummy;   // 哨兵节点省去头节点判断
    while (a != null && b != null) {
        if (a.val <= b.val) { tail.next = a; a = a.next; }
        else                { tail.next = b; b = b.next; }
        tail = tail.next;
    }
    tail.next = (a != null) ? a : b;
    return dummy.next;
}
```

另一种做法是把 K 个链表头放进小顶堆，每次弹出最小的节点，复杂度同样是 O(N log K)，见 [堆](../1_data_structures/4_heap)。

### 5、最大子数组和的分治解法

LeetCode 53 也能用分治求解：最大子数组要么完全在左半，要么完全在右半，要么跨过中点；跨中点的部分从中点向两边各扫一遍求出。递推式 T(n) = 2T(n/2) + Θ(n)，总复杂度 Θ(n log n)。

这道题更优的解法是 O(n) 的 Kadane 算法（动态规划），见 [动态规划](./5_dynamic_programming) 的最大子数组和一节。分治版的价值在于它能扩展到线段树：每个节点保存区间和、最大前缀和、最大后缀和、最大子段和，就能支持带修改的区间查询。

### 6、二分查找

二分查找每次只进入一个子问题，是 a = 1 的分治，T(n) = T(n/2) + Θ(1) = Θ(log n)，模板见 [搜索算法](./0_search)。

---

## 四、分治、动态规划与贪心

| | 分治 | 动态规划 | 贪心 |
|--|------|---------|------|
| 子问题关系 | 相互独立 | 大量重叠 | 每步只留一个子问题 |
| 是否缓存子问题结果 | 不需要 | 需要（记忆化或递推表） | 不需要 |
| 决策方式 | 拆分后合并 | 枚举所有选择取最优 | 只做当前最优的选择 |
| 典型例子 | 归并排序、快排、快速幂 | 背包、LCS、编辑距离 | 区间调度、跳跃游戏 |

---

## 小结

- 分治三步：分解、解决、合并；子问题重叠时改用动态规划
- 主定理三种情况的结论都是 Θ；情况 3 还要满足正则条件 a·f(n/b) ≤ c·f(n)
- 快速幂取模版要求 mod < 2^31；LeetCode 50 先把 n 转成 `long` 再取反
- 逆序对数量可达 n(n−1)/2，计数用 `long`
- 合并 K 个链表用对半分治或小顶堆，都是 O(N log K)

## 参考资料

- Cormen 等，《算法导论》（第 3 版）第 4.5 节 主方法
- OI Wiki 递归与分治：[https://oi-wiki.org/basic/divide-and-conquer/](https://oi-wiki.org/basic/divide-and-conquer/)
- OI Wiki 归并排序（含逆序对）：[https://oi-wiki.org/basic/merge-sort/](https://oi-wiki.org/basic/merge-sort/)

> 下一篇：[回溯算法](./3_backtrack) —— 回溯框架、排列 / 组合 / 子集、N 皇后、网格 DFS、剪枝与复杂度。
