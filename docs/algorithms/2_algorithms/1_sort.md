---
description: 常见排序算法与稳定性、复杂度对比
---

# 排序算法

---

## 一、复杂度总览

| 算法 | 平均时间 | 最坏时间 | 空间 | 稳定 |
|------|---------|---------|------|------|
| 冒泡排序 | O(n²) | O(n²) | O(1) | ✅ |
| 选择排序 | O(n²) | O(n²) | O(1) | ❌ |
| 插入排序 | O(n²) | O(n²) | O(1) | ✅ |
| 希尔排序 | O(n log²n) | O(n²) | O(1) | ❌ |
| 归并排序 | O(n log n) | O(n log n) | O(n) | ✅ |
| 快速排序 | O(n log n) | O(n²) | O(log n) | ❌ |
| 堆排序 | O(n log n) | O(n log n) | O(1) | ❌ |
| 计数排序 | O(n + k) | O(n + k) | O(k) | ✅ |
| 桶排序 | O(n + k) | O(n²) | O(n+k) | ✅ |
| 基数排序 | O(nk) | O(nk) | O(n+k) | ✅ |

---

## 二、比较类排序

### 2.1 冒泡排序

相邻元素比较交换，每轮将最大值"冒"到末尾：

```java
void bubbleSort(int[] arr) {
    int n = arr.length;
    for (int i = 0; i < n - 1; i++) {
        boolean swapped = false;
        for (int j = 0; j < n - i - 1; j++) {
            if (arr[j] > arr[j + 1]) {
                swap(arr, j, j + 1);
                swapped = true;
            }
        }
        if (!swapped) break; // 已有序，提前退出
    }
}
```

### 2.2 选择排序

每轮从未排序部分找最小值，放到已排序末尾：

```java
void selectionSort(int[] arr) {
    for (int i = 0; i < arr.length - 1; i++) {
        int minIdx = i;
        for (int j = i + 1; j < arr.length; j++)
            if (arr[j] < arr[minIdx]) minIdx = j;
        swap(arr, i, minIdx);
    }
}
```

### 2.3 插入排序

类似打扑克，将当前元素插入已排序部分的正确位置：

```java
void insertionSort(int[] arr) {
    for (int i = 1; i < arr.length; i++) {
        int key = arr[i], j = i - 1;
        while (j >= 0 && arr[j] > key) {
            arr[j + 1] = arr[j];
            j--;
        }
        arr[j + 1] = key;
    }
}
```

**特点**：近乎有序时效率极高（接近 O(n)），小数组首选。

### 2.4 归并排序

分治：将数组分成两半分别排序，再合并：

```java
void mergeSort(int[] arr, int left, int right) {
    if (left >= right) return;
    int mid = left + (right - left) / 2;
    mergeSort(arr, left, mid);
    mergeSort(arr, mid + 1, right);
    merge(arr, left, mid, right);
}

void merge(int[] arr, int left, int mid, int right) {
    int[] tmp = Arrays.copyOfRange(arr, left, right + 1);
    int i = 0, j = mid - left + 1, k = left;
    while (i <= mid - left && j <= right - left)
        arr[k++] = tmp[i] <= tmp[j] ? tmp[i++] : tmp[j++];
    while (i <= mid - left) arr[k++] = tmp[i++];
    while (j <= right - left) arr[k++] = tmp[j++];
}
```

**特点**：稳定，时间固定 O(n log n)，但需要 O(n) 额外空间。

### 2.5 快速排序

选择基准（pivot），将数组划分为小于/大于 pivot 两部分，递归排序：

```java
void quickSort(int[] arr, int left, int right) {
    if (left >= right) return;
    int pivot = partition(arr, left, right);
    quickSort(arr, left, pivot - 1);
    quickSort(arr, pivot + 1, right);
}

int partition(int[] arr, int left, int right) {
    // 三路取中（避免退化）
    int mid = left + (right - left) / 2;
    if (arr[left] > arr[mid]) swap(arr, left, mid);
    if (arr[left] > arr[right]) swap(arr, left, right);
    if (arr[mid] > arr[right]) swap(arr, mid, right);
    // arr[mid] 是中位数，作为 pivot
    swap(arr, mid, right - 1);
    int pivot = arr[right - 1];

    int i = left, j = right - 1;
    while (true) {
        while (arr[++i] < pivot) {}
        while (arr[--j] > pivot) {}
        if (i >= j) break;
        swap(arr, i, j);
    }
    swap(arr, i, right - 1);
    return i;
}
```

**Java 内置排序**：`Arrays.sort()` 对基本类型用双轴快排，对对象用 TimSort（归并改进）。

---

## 三、非比较类排序

### 3.1 计数排序

适合范围已知的整数，统计每个值出现次数：

```java
void countingSort(int[] arr, int maxVal) {
    int[] count = new int[maxVal + 1];
    for (int x : arr) count[x]++;
    int idx = 0;
    for (int val = 0; val <= maxVal; val++)
        while (count[val]-- > 0) arr[idx++] = val;
}
```

**复杂度**：O(n + k)，k 为值范围。

### 3.2 桶排序

将数据分配到多个桶中，桶内单独排序，再合并：

```java
void bucketSort(double[] arr) {
    int n = arr.length;
    List<List<Double>> buckets = new ArrayList<>();
    for (int i = 0; i < n; i++) buckets.add(new ArrayList<>());

    for (double x : arr)
        buckets.get((int)(x * n)).add(x);

    int idx = 0;
    for (List<Double> bucket : buckets) {
        Collections.sort(bucket);
        for (double x : bucket) arr[idx++] = x;
    }
}
```

**适用**：数据均匀分布时接近 O(n)。

### 3.3 基数排序

按数字的每一位（个位、十位…）分别进行计数排序：

```java
void radixSort(int[] arr) {
    int max = Arrays.stream(arr).max().getAsInt();
    for (int exp = 1; max / exp > 0; exp *= 10)
        countingByDigit(arr, exp);
}

void countingByDigit(int[] arr, int exp) {
    int n = arr.length;
    int[] output = new int[n], count = new int[10];
    for (int x : arr) count[(x / exp) % 10]++;
    for (int i = 1; i < 10; i++) count[i] += count[i-1];
    for (int i = n-1; i >= 0; i--) // 从右到左保证稳定
        output[--count[(arr[i] / exp) % 10]] = arr[i];
    System.arraycopy(output, 0, arr, 0, n);
}
```

---

## 四、排序选型建议

| 场景 | 推荐 |
|------|------|
| 通用排序（Java 内置）| `Arrays.sort()` / `Collections.sort()` |
| 数据量小（n < 20）| 插入排序 |
| 需要稳定且空间允许 | 归并排序 |
| 平均最快，不需稳定 | 快速排序 |
| 整数范围已知 | 计数排序 / 基数排序 |
| 近乎有序 | 插入排序（最优 O(n)）|

---

## 五、经典题目

| 题目 | 考点 |
|------|------|
| LeetCode 912 排序数组 | 手写快排/归并 |
| LeetCode 215 第 K 大元素 | 快速选择（partition）|
| LeetCode 75 颜色分类 | 三路快排思想（荷兰国旗）|
| LeetCode 315 计算右侧小于当前元素个数 | 归并排序 |
| LeetCode 493 翻转对 | 归并排序（分治计数）|
