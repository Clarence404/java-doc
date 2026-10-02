---
description: 区间和与区间修改
---

# 前缀和 & 差分数组

> **前缀和**用 O(1) 时间回答区间求和查询；**差分数组**用 O(1) 时间完成区间更新，两者互为逆运算，是处理区间问题的核心预处理技巧。

---

## 一、一维前缀和

### 原理

```
原数组：  a[0]  a[1]  a[2]  a[3]  a[4]
前缀和：  p[0]  p[1]  p[2]  p[3]  p[4]  p[5]
         (哨兵0)
p[i] = a[0] + a[1] + ... + a[i-1]
区间 [l, r] 之和 = p[r+1] - p[l]
```

### Java 模板

```java
int n = a.length;
int[] p = new int[n + 1];          // 多一个哨兵位，避免边界判断
for (int i = 0; i < n; i++) {
    p[i + 1] = p[i] + a[i];
}

// 查询 [l, r] 区间和（0-indexed）
int rangeSum(int l, int r) {
    return p[r + 1] - p[l];
}
```

- 预处理：O(n)，查询：O(1)
- 适用于**静态数组**（不频繁修改）

---

## 二、二维前缀和

### 原理

```
p[i][j] = 以 (0,0) 为左上角、(i-1,j-1) 为右下角的矩形元素之和

子矩阵 (r1,c1) → (r2,c2) 之和：
  p[r2+1][c2+1] - p[r1][c2+1] - p[r2+1][c1] + p[r1][c1]
```

### Java 模板

```java
int[][] p = new int[m + 1][n + 1];
for (int i = 0; i < m; i++) {
    for (int j = 0; j < n; j++) {
        p[i+1][j+1] = matrix[i][j]
                    + p[i][j+1] + p[i+1][j] - p[i][j];
    }
}

// 查询子矩阵 (r1,c1)→(r2,c2)
int query(int r1, int c1, int r2, int c2) {
    return p[r2+1][c2+1] - p[r1][c2+1] - p[r2+1][c1] + p[r1][c1];
}
```

---

## 三、差分数组（区间更新）

### 原理

差分数组 `d[i] = a[i] - a[i-1]`，对原数组区间 `[l, r]` 统一加 `v`，等价于：

```
d[l]   += v
d[r+1] -= v
```

最后对 d 求前缀和还原得到更新后的数组。

### Java 模板

```java
int[] d = new int[n + 1];          // 差分数组（末尾多一格防越界）

// 区间 [l, r] 加 v（0-indexed）
void update(int l, int r, int v) {
    d[l]     += v;
    d[r + 1] -= v;
}

// 还原数组
int[] result() {
    int[] a = new int[n];
    a[0] = d[0];
    for (int i = 1; i < n; i++) {
        a[i] = a[i - 1] + d[i];
    }
    return a;
}
```

- 预处理：O(1)，批量 k 次区间更新 + 一次还原：O(n + k)

---

## 四、前缀和 + 哈希（子数组和问题）

经典套路：**边遍历边用 Map 存前缀和出现次数**，O(n) 解决"和为 k 的子数组个数"。

```java
// LC 560：和为 k 的子数组
int subarraySum(int[] nums, int k) {
    Map<Integer, Integer> map = new HashMap<>();
    map.put(0, 1);          // 空前缀
    int sum = 0, count = 0;
    for (int x : nums) {
        sum += x;
        count += map.getOrDefault(sum - k, 0);
        map.merge(sum, 1, Integer::sum);
    }
    return count;
}
```

推广：前缀 XOR + Map 可解"异或和为 k 的子数组"。

---

## 五、对比总览

| 技巧 | 预处理 | 查询/更新 | 适用场景 |
|------|--------|-----------|----------|
| 一维前缀和 | O(n) | 查询 O(1) | 静态数组区间求和 |
| 二维前缀和 | O(mn) | 查询 O(1) | 矩阵子矩阵求和 |
| 差分数组 | O(1) | 更新 O(1)，还原 O(n) | 批量区间加减 |
| 前缀和 + Map | O(n) | — | 连续子数组和等于目标值 |

---

## 六、经典题目

| 题目 | 难度 | 考点 |
|------|------|------|
| LC 303 区域和检索（数组不可变） | Easy | 一维前缀和基础 |
| LC 304 二维区域和检索 | Medium | 二维前缀和 |
| LC 560 和为 K 的子数组 | Medium | 前缀和 + HashMap |
| LC 974 和可被 K 整除的子数组 | Medium | 前缀和取模 + HashMap |
| LC 1109 航班预订统计 | Medium | 差分数组 |
| LC 1094 拼车 | Medium | 差分数组 |
| LC 525 连续数组（0/1 → -1/1 转换） | Medium | 前缀和 + HashMap |
| LC 1248 统计「优美子数组」 | Medium | 前缀和计数 |
