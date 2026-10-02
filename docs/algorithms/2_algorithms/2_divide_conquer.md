---
description: 分治思想、主定理、分治 vs 动态规划
---

# 分治算法

---

## 一、分治思想

**分而治之（Divide and Conquer）**：将大问题分解为若干**同类子问题**，递归求解，再合并结果。

三个步骤：
1. **Divide**：将问题分解为规模更小的子问题
2. **Conquer**：递归求解子问题（足够小时直接解决）
3. **Combine**：将子问题的解合并为原问题的解

**适用条件**：
- 问题可以分解为规模更小的相同类型子问题
- 子问题相互独立（无重叠，否则用 DP）
- 子问题的解可以合并

---

## 二、主定理（Master Theorem）

分治算法的时间复杂度通常满足递推关系：

```
T(n) = aT(n/b) + f(n)
```

- a：子问题数量
- b：问题规模缩小比例
- f(n)：分解和合并的代价

| 情况 | 条件 | 复杂度 |
|------|------|--------|
| 1 | f(n) = O(n^(log_b a - ε)) | T(n) = O(n^(log_b a)) |
| 2 | f(n) = Θ(n^(log_b a)) | T(n) = O(n^(log_b a) log n) |
| 3 | f(n) = Ω(n^(log_b a + ε)) | T(n) = O(f(n)) |

**归并排序**：T(n) = 2T(n/2) + O(n) → O(n log n)（情况 2）

---

## 三、经典应用

### 3.1 归并排序

```java
int[] mergeSort(int[] arr) {
    if (arr.length <= 1) return arr;
    int mid = arr.length / 2;
    int[] left  = mergeSort(Arrays.copyOfRange(arr, 0, mid));
    int[] right = mergeSort(Arrays.copyOfRange(arr, mid, arr.length));
    return merge(left, right);
}

int[] merge(int[] l, int[] r) {
    int[] res = new int[l.length + r.length];
    int i = 0, j = 0, k = 0;
    while (i < l.length && j < r.length)
        res[k++] = l[i] <= r[j] ? l[i++] : r[j++];
    while (i < l.length) res[k++] = l[i++];
    while (j < r.length) res[k++] = r[j++];
    return res;
}
```

### 3.2 快速幂（O(log n)）

```java
// 计算 base^exp % mod
long fastPow(long base, long exp, long mod) {
    long result = 1;
    base %= mod;
    while (exp > 0) {
        if ((exp & 1) == 1) result = result * base % mod; // 奇数次
        base = base * base % mod; // 平方
        exp >>= 1;
    }
    return result;
}
```

### 3.3 最大子数组和（Kadane 变体分治版）

```java
int maxSubArray(int[] nums) {
    return divide(nums, 0, nums.length - 1);
}

int divide(int[] nums, int left, int right) {
    if (left == right) return nums[left];
    int mid = left + (right - left) / 2;
    int leftMax  = divide(nums, left, mid);
    int rightMax = divide(nums, mid + 1, right);
    int crossMax = crossSum(nums, left, mid, right); // 跨越中点的最大和
    return Math.max(Math.max(leftMax, rightMax), crossMax);
}

int crossSum(int[] nums, int left, int mid, int right) {
    int leftSum = Integer.MIN_VALUE, sum = 0;
    for (int i = mid; i >= left; i--) {
        sum += nums[i];
        leftSum = Math.max(leftSum, sum);
    }
    int rightSum = Integer.MIN_VALUE; sum = 0;
    for (int i = mid + 1; i <= right; i++) {
        sum += nums[i];
        rightSum = Math.max(rightSum, sum);
    }
    return leftSum + rightSum;
}
```

### 3.4 逆序对计数（归并排序）

```java
int mergeCount(int[] arr, int left, int right) {
    if (left >= right) return 0;
    int mid = left + (right - left) / 2;
    int count = mergeCount(arr, left, mid) + mergeCount(arr, mid + 1, right);

    // 合并时统计跨区间的逆序对
    int i = left, j = mid + 1, k = 0;
    int[] tmp = new int[right - left + 1];
    while (i <= mid && j <= right) {
        if (arr[i] <= arr[j]) {
            tmp[k++] = arr[i++];
        } else {
            count += mid - i + 1; // arr[i..mid] 都比 arr[j] 大
            tmp[k++] = arr[j++];
        }
    }
    while (i <= mid)  tmp[k++] = arr[i++];
    while (j <= right) tmp[k++] = arr[j++];
    System.arraycopy(tmp, 0, arr, left, tmp.length);
    return count;
}
```

### 3.5 二分搜索

本质是分治，每次将搜索空间缩小一半（详见搜索算法章节）。

---

## 四、分治 vs 动态规划

| | 分治 | 动态规划 |
|--|------|---------|
| 子问题重叠 | ❌ 子问题独立 | ✅ 子问题重叠 |
| 结果缓存 | 不需要 | 需要（记忆化）|
| 典型例子 | 归并排序、快排 | 背包、LCS |

---

## 五、经典题目

| 题目 | 考点 |
|------|------|
| LeetCode 53 最大子数组和 | 分治 / Kadane |
| LeetCode 23 合并 K 个升序链表 | 分治归并 |
| LeetCode 241 为运算表达式设计优先级 | 分治枚举 |
| LeetCode 50 Pow(x, n) | 快速幂 |
| LeetCode 315 计算右侧小于当前元素的个数 | 归并排序 |
| LeetCode 912 排序数组 | 归并 / 快排实现 |
