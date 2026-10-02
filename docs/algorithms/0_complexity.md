---
description: 时间 / 空间复杂度、算法权衡、常见操作复杂度速查
---

# 复杂度分析

> 参考：[Hello 算法](https://www.hello-algo.com/chapter_hello_algo/)

复杂度是衡量算法效率的核心指标，分为**时间复杂度**和**空间复杂度**，均使用大 O 表示法（Big-O）描述。

---

## 一、时间复杂度

### 1.1 大 O 表示法

大 O 描述算法运行时间随输入规模 `n` 增长的**趋势**，忽略常数系数和低阶项：

```
T(n) = 2n² + 3n + 1  →  O(n²)
T(n) = 100n + 50      →  O(n)
```

**三种情况：**
- **最坏复杂度**（通常使用）：最不利输入下的运行时间
- **最好复杂度**：最优输入下的运行时间
- **平均复杂度**：所有输入的期望运行时间

### 1.2 常见时间复杂度（由低到高）

| 复杂度 | 名称 | 典型场景 |
|--------|------|---------|
| O(1) | 常数阶 | 数组下标访问、HashMap get |
| O(log n) | 对数阶 | 二分搜索、平衡树查询 |
| O(n) | 线性阶 | 线性遍历、链表查询 |
| O(n log n) | 线性对数阶 | 归并排序、快速排序（平均） |
| O(n²) | 平方阶 | 冒泡排序、简单双重循环 |
| O(2ⁿ) | 指数阶 | 递归求全子集、旅行商暴力 |
| O(n!) | 阶乘阶 | 全排列暴力枚举 |

```
O(1) < O(log n) < O(n) < O(n log n) < O(n²) < O(2ⁿ) < O(n!)
```

### 1.3 代码示例

```java
// O(1)：常数时间
int getFirst(int[] arr) { return arr[0]; }

// O(n)：线性时间
int sum(int[] arr) {
    int s = 0;
    for (int x : arr) s += x;  // 循环 n 次
    return s;
}

// O(n²)：平方时间
void bubbleSort(int[] arr) {
    for (int i = 0; i < arr.length; i++)       // n 次
        for (int j = 0; j < arr.length - i - 1; j++) // n 次
            if (arr[j] > arr[j+1]) swap(arr, j, j+1);
}

// O(log n)：对数时间（每次问题规模减半）
int binarySearch(int[] arr, int target) {
    int lo = 0, hi = arr.length - 1;
    while (lo <= hi) {
        int mid = lo + (hi - lo) / 2;
        if (arr[mid] == target) return mid;
        else if (arr[mid] < target) lo = mid + 1;
        else hi = mid - 1;
    }
    return -1;
}

// O(2ⁿ)：指数时间（斐波那契递归）
int fib(int n) {
    if (n <= 1) return n;
    return fib(n - 1) + fib(n - 2); // 每次分裂为 2 个子问题
}
```

---

## 二、空间复杂度

描述算法运行过程中**额外占用内存**随输入规模 `n` 的增长趋势。

### 2.1 计算规则

| 内存类型 | 说明 |
|---------|------|
| 输入空间 | 存储输入数据（通常不计入） |
| 暂存空间 | 变量、调用栈、辅助数组等 |
| 输出空间 | 存储输出结果（按题目要求） |

```java
// O(1)：只用几个变量
int findMax(int[] arr) {
    int max = arr[0];
    for (int x : arr) max = Math.max(max, x);
    return max;
}

// O(n)：申请了与输入等大的辅助数组
int[] copyArray(int[] arr) {
    int[] copy = new int[arr.length]; // O(n) 额外空间
    System.arraycopy(arr, 0, copy, 0, arr.length);
    return copy;
}

// O(n)：递归调用栈深度为 n
int factorial(int n) {
    if (n == 1) return 1;
    return n * factorial(n - 1); // 调用栈深度 n
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

## 三、算法权衡

| 策略 | 说明 | 典型例子 |
|------|------|---------|
| 以空间换时间 | 用更多内存减少计算 | HashMap 缓存中间结果、DP 表格 |
| 以时间换空间 | 少用内存多算几遍 | 原地排序代替辅助数组 |

---

## 四、常见数据结构操作复杂度速查

| 数据结构 | 访问 | 搜索 | 插入 | 删除 |
|---------|------|------|------|------|
| 数组 | O(1) | O(n) | O(n) | O(n) |
| 链表 | O(n) | O(n) | O(1) | O(1) |
| 哈希表 | — | O(1) | O(1) | O(1) |
| 二叉搜索树（平衡） | O(log n) | O(log n) | O(log n) | O(log n) |
| 堆 | O(1) 堆顶 | — | O(log n) | O(log n) |

---

## 五、常见排序算法复杂度

| 算法 | 时间（平均） | 时间（最坏） | 空间 | 稳定 |
|------|------------|------------|------|------|
| 冒泡排序 | O(n²) | O(n²) | O(1) | ✅ |
| 选择排序 | O(n²) | O(n²) | O(1) | ❌ |
| 插入排序 | O(n²) | O(n²) | O(1) | ✅ |
| 归并排序 | O(n log n) | O(n log n) | O(n) | ✅ |
| 快速排序 | O(n log n) | O(n²) | O(log n) | ❌ |
| 堆排序 | O(n log n) | O(n log n) | O(1) | ❌ |
| 计数排序 | O(n + k) | O(n + k) | O(k) | ✅ |
