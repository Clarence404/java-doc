---
description: 一维 / 二维前缀和、差分数组与区间更新、前缀和 + 哈希求子数组和
---

# 前缀和与差分数组

> 前置阅读：[滑动窗口](./2_sliding_window)、[哈希表](../1_data_structures/2_hash_table)

前缀和把区间求和变成 O(1) 的两次查表，差分数组把区间加减变成 O(1) 的两次单点修改，两者互为逆运算。本篇讲一维 / 二维前缀和、差分数组、「前缀和 + 哈希表」统计子数组和，以及数组频繁修改时的替代结构。

---

## 一、一维前缀和

### 1、哨兵位与下标对齐

定义 `p[i] = a[0] + a[1] + … + a[i-1]`，即 `p[i]` 是**前 i 个元素**之和，`p[0] = 0` 是哨兵。这样区间 `[l, r]`（闭区间、下标从 0 开始）的和是 `p[r + 1] - p[l]`，`l = 0` 时也不用特判。

![前缀和数组与原数组的下标对齐](../../assets/algorithms/prefix_sum_index.svg)

### 2、模板

LeetCode 303 区域和检索 - 数组不可变：

```java
class NumArray {
    private final long[] p;                    // 累加可能超出 int，用 long

    NumArray(int[] nums) {
        p = new long[nums.length + 1];
        for (int i = 0; i < nums.length; i++) p[i + 1] = p[i] + nums[i];
    }

    long sumRange(int l, int r) {              // [l, r] 闭区间
        return p[r + 1] - p[l];
    }
}
```

预处理 O(n)，每次查询 O(1)。LeetCode 原题的方法签名返回 `int`，题目数据范围不会溢出；工程中累加大量数据时用 `long` 更稳妥。

前缀和适合**静态数组**：一旦某个元素被修改，它后面的所有前缀和都要更新，单次修改 O(n)。修改和查询都频繁时，改用树状数组（Fenwick Tree）或线段树，两者的单点修改、区间查询都是 O(log n)。

---

## 二、二维前缀和

定义 `p[i][j]` = 以 `(0, 0)` 为左上角、`(i-1, j-1)` 为右下角的矩形内元素之和，同样多开一行一列做哨兵。

- **构建**：`p[i+1][j+1] = matrix[i][j] + p[i][j+1] + p[i+1][j] - p[i][j]`，左上角那块被加了两次，减掉一次
- **查询**子矩阵 `(r1, c1)` 到 `(r2, c2)`：`p[r2+1][c2+1] - p[r1][c2+1] - p[r2+1][c1] + p[r1][c1]`，减去上方和左方两块，左上角那块被减了两次，加回一次

LeetCode 304 二维区域和检索 - 矩阵不可变：

```java
class NumMatrix {
    private final int[][] p;

    NumMatrix(int[][] matrix) {
        int m = matrix.length, n = matrix[0].length;
        p = new int[m + 1][n + 1];
        for (int i = 0; i < m; i++)
            for (int j = 0; j < n; j++)
                p[i + 1][j + 1] = matrix[i][j] + p[i][j + 1] + p[i + 1][j] - p[i][j];
    }

    int sumRegion(int r1, int c1, int r2, int c2) {
        return p[r2 + 1][c2 + 1] - p[r1][c2 + 1] - p[r2 + 1][c1] + p[r1][c1];
    }
}
```

构建 O(m·n)，查询 O(1)。

---

## 三、差分数组

### 1、原理

差分数组 `d[0] = a[0]`，`d[i] = a[i] - a[i-1]`。对 d 求前缀和就还原出 a。

给原数组区间 `[l, r]` 每个元素都加上 v，在差分数组上只需改两个位置：`d[l] += v` 让 l 及之后的元素都加 v，`d[r + 1] -= v` 再把 r 之后的抵消掉。

![差分数组的区间加法](../../assets/algorithms/difference_array.svg)

### 2、模板

```java
class Difference {
    private final int[] d;                     // 比原数组多一格，r + 1 不会越界

    Difference(int[] a) {                      // 从已有数组构建：O(n)
        d = new int[a.length + 1];
        if (a.length == 0) return;
        d[0] = a[0];
        for (int i = 1; i < a.length; i++) d[i] = a[i] - a[i - 1];
    }

    void add(int l, int r, int v) {            // [l, r] 每个元素加 v：O(1)
        d[l] += v;
        d[r + 1] -= v;
    }

    int[] result() {                           // 求前缀和还原：O(n)
        int n = d.length - 1;
        int[] a = new int[n];
        if (n == 0) return a;
        a[0] = d[0];
        for (int i = 1; i < n; i++) a[i] = a[i - 1] + d[i];
        return a;
    }
}
```

原数组全为 0 时（如 LeetCode 1109 航班预订统计、LeetCode 1094 拼车），差分数组也全为 0，直接 `new int[n + 1]` 就是构建好的状态，不需要 O(n) 初始化。

k 次区间更新 + 一次还原，总复杂度 O(n + k)；直接逐个元素加则是 O(n·k)。差分只适合「先批量更新、最后统一查询」的离线场景，更新与查询交替进行时要用树状数组或线段树。

**二维差分**同理：给子矩阵 `(r1, c1)` 到 `(r2, c2)` 加 v，改四个角：`d[r1][c1] += v`、`d[r1][c2+1] -= v`、`d[r2+1][c1] -= v`、`d[r2+1][c2+1] += v`，最后对 d 做二维前缀和还原。

---

## 四、前缀和 + 哈希表

子数组 `[j, i]` 的和等于 `p[i+1] - p[j]`。要统计「和为 k 的子数组个数」，就是对每个 i，问之前有多少个前缀和等于 `p[i+1] - k`。边遍历边用哈希表记录每个前缀和出现的次数，一遍 O(n) 完成。

LeetCode 560 和为 K 的子数组：

```java
int subarraySum(int[] nums, int k) {
    Map<Integer, Integer> count = new HashMap<>();
    count.put(0, 1);                           // 空前缀：和为 0 出现 1 次
    int sum = 0, res = 0;
    for (int x : nums) {
        sum += x;
        res += count.getOrDefault(sum - k, 0);
        count.merge(sum, 1, Integer::sum);
    }
    return res;
}
```

这题数组里有负数，窗口和不单调，[滑动窗口](./2_sliding_window) 用不了，这正是前缀和 + 哈希的用武之地。

同一套路的变形：

| 题目 | 哈希表的 key | 要点 |
|------|--------------|------|
| LeetCode 974 和可被 K 整除的子数组 | 前缀和对 k 取模 | Java 中负数取模为负，用 `((sum % k) + k) % k` 修正 |
| LeetCode 525 连续数组 | 把 0 看成 −1 后的前缀和 | 求最长：key 存前缀和**第一次出现的下标** |
| LeetCode 1248 统计「优美子数组」 | 奇数个数的前缀计数 | 把奇数看成 1、偶数看成 0 |

把「和」换成「异或」也成立：前缀异或 + 哈希表能统计「异或和为 k 的子数组」。

---

## 五、对比总览

| 技巧 | 预处理 | 单次操作 | 适用场景 |
|------|--------|----------|----------|
| 一维前缀和 | O(n) | 区间查询 O(1) | 静态数组区间求和 |
| 二维前缀和 | O(m·n) | 子矩阵查询 O(1) | 静态矩阵子矩阵求和 |
| 差分数组 | O(n)（原数组全 0 时直接开数组） | 区间更新 O(1)，还原 O(n) | 批量区间加减后统一查询 |
| 前缀和 + 哈希表 | — | 一遍扫描 O(n) | 连续子数组和等于 / 整除目标值 |
| 树状数组 / 线段树 | O(n) | 修改、查询 O(log n) | 修改与查询交替进行 |

---

## 小结

- 前缀和多开一个哨兵位：`p[i]` 是前 i 个元素之和，区间 `[l, r]` 的和是 `p[r+1] - p[l]`
- 二维前缀和构建与查询都按容斥原理：加两块、减重叠
- 差分数组 `d[l] += v`、`d[r+1] -= v`，还原时求前缀和；从已有数组构建是 O(n)
- 有负数时求子数组和用前缀和 + 哈希表，先放入「空前缀」`(0, 1)`
- 数组频繁修改又频繁查询时，换树状数组或线段树

## 参考资料

- OI Wiki 前缀和与差分：[https://oi-wiki.org/basic/prefix-sum/](https://oi-wiki.org/basic/prefix-sum/)
- OI Wiki 树状数组：[https://oi-wiki.org/ds/fenwick/](https://oi-wiki.org/ds/fenwick/)
- OI Wiki 线段树：[https://oi-wiki.org/ds/seg/](https://oi-wiki.org/ds/seg/)

> 下一篇：[位运算](./4_bit_manipulation) —— 位运算速查、lowbit、子集枚举、异或技巧、状压 DP、`Integer` 位工具方法。
