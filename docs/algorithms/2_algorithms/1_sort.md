---
description: 排序复杂度与稳定性、快排划分、归并排序、计数 / 基数排序、JDK 内置排序
---

# 排序算法

> 前置阅读：[复杂度分析](../0_complexity)、[搜索算法](./0_search)

排序是最基础的算法题型，也是二分、双指针、贪心等技巧的前提。本篇讲常见排序的复杂度与稳定性、快排与归并的手写、计数 / 基数排序的适用前提，以及 `Arrays.sort` 在不同类型上的实现。

---

## 一、复杂度总览

| 算法 | 平均时间 | 最坏时间 | 额外空间 | 稳定 |
|------|---------|---------|---------|------|
| 冒泡排序 | O(n²) | O(n²) | O(1) | 是 |
| 选择排序 | O(n²) | O(n²) | O(1) | 否 |
| 插入排序 | O(n²) | O(n²) | O(1) | 是 |
| 希尔排序 | 取决于增量序列 | 取决于增量序列 | O(1) | 否 |
| 归并排序 | O(n log n) | O(n log n) | O(n) | 是 |
| 快速排序 | O(n log n) | O(n²) | O(log n)（递归栈） | 否 |
| 堆排序 | O(n log n) | O(n log n) | O(1) | 否 |
| 计数排序 | O(n + k) | O(n + k) | O(n + k) | 是（按下文的前缀和写法） |
| 桶排序 | O(n + k) | O(n²) | O(n + k) | 是（桶内用稳定排序时） |
| 基数排序 | O(d·(n + r)) | O(d·(n + r)) | O(n + r) | 是 |

k 是值域大小，d 是位数，r 是基数（十进制为 10）。

**稳定**指值相等的元素排序后保持原来的相对顺序。对 `int` 数组无所谓，对「先按时间排、再按状态排」这类多关键字的对象排序就很关键。

---

## 二、比较类排序

下面的代码共用一个交换函数：

```java
void swap(int[] a, int i, int j) { int t = a[i]; a[i] = a[j]; a[j] = t; }
```

### 1、冒泡排序

相邻元素两两比较，每轮把最大值「冒」到末尾；某一轮没有交换说明已经有序，可以提前结束：

```java
void bubbleSort(int[] a) {
    for (int i = 0; i < a.length - 1; i++) {
        boolean swapped = false;
        for (int j = 0; j < a.length - 1 - i; j++) {
            if (a[j] > a[j + 1]) { swap(a, j, j + 1); swapped = true; }
        }
        if (!swapped) break;
    }
}
```

### 2、选择排序

每轮从未排序部分选出最小值，放到已排序部分末尾。交换会跨过中间元素，所以不稳定：

```java
void selectionSort(int[] a) {
    for (int i = 0; i < a.length - 1; i++) {
        int minIdx = i;
        for (int j = i + 1; j < a.length; j++) if (a[j] < a[minIdx]) minIdx = j;
        swap(a, i, minIdx);
    }
}
```

### 3、插入排序

像理牌一样，把当前元素插到前面已排好的部分里：

```java
void insertionSort(int[] a) {
    for (int i = 1; i < a.length; i++) {
        int key = a[i], j = i - 1;
        while (j >= 0 && a[j] > key) { a[j + 1] = a[j]; j--; }
        a[j + 1] = key;
    }
}
```

数据近乎有序时接近 O(n)，小数组上常数也小，所以工业级排序都在小区间切换到插入排序。

### 4、希尔排序

按增量 gap 分组做插入排序，gap 逐步缩小到 1。先让元素大步移动，最后一轮插入排序面对的已是近乎有序的数据：

```java
void shellSort(int[] a) {
    for (int gap = a.length / 2; gap > 0; gap /= 2) {   // Shell 原始增量 n/2, n/4, ...
        for (int i = gap; i < a.length; i++) {
            int key = a[i], j = i - gap;
            while (j >= 0 && a[j] > key) { a[j + gap] = a[j]; j -= gap; }
            a[j + gap] = key;
        }
    }
}
```

复杂度取决于增量序列：上面的 Shell 原始序列最坏 O(n²)；Pratt 序列（2^p·3^q）最坏 O(n log²n)。实际工程中很少直接使用，了解思路即可。

### 5、归并排序

分治：把数组对半分开分别排好，再把两个有序段合并。整个过程只分配一次辅助数组：

```java
void mergeSort(int[] a) {
    mergeSort(a, 0, a.length - 1, new int[a.length]);
}

void mergeSort(int[] a, int lo, int hi, int[] tmp) {
    if (lo >= hi) return;
    int mid = lo + (hi - lo) / 2;
    mergeSort(a, lo, mid, tmp);
    mergeSort(a, mid + 1, hi, tmp);
    merge(a, lo, mid, hi, tmp);
}

void merge(int[] a, int lo, int mid, int hi, int[] tmp) {
    System.arraycopy(a, lo, tmp, lo, hi - lo + 1);
    int i = lo, j = mid + 1;
    for (int k = lo; k <= hi; k++) {
        if (i > mid)               a[k] = tmp[j++];
        else if (j > hi)           a[k] = tmp[i++];
        else if (tmp[i] <= tmp[j]) a[k] = tmp[i++];   // <= 保证稳定
        else                       a[k] = tmp[j++];
    }
}
```

时间固定 O(n log n)，稳定，代价是 O(n) 额外空间。复杂度的推导（递归树、主定理）见 [分治算法](./2_divide_conquer)。归并排序还是**外部排序**的基础：数据放不进内存时，先分块排序写盘，再多路归并，见 [海量数据算法题](/scenario/3_massive_data)。

### 6、快速排序

选一个基准（pivot），把数组划分成「小于等于 pivot」和「大于等于 pivot」两段，再递归处理两段：

```java
void quickSort(int[] a, int lo, int hi) {
    if (lo >= hi) return;
    int p = partition(a, lo, hi);
    quickSort(a, lo, p - 1);
    quickSort(a, p + 1, hi);
}

int partition(int[] a, int lo, int hi) {
    // 随机选基准并换到最左边，避免有序输入退化到 O(n²)
    swap(a, lo, ThreadLocalRandom.current().nextInt(lo, hi + 1));
    int pivot = a[lo], i = lo + 1, j = hi;
    while (true) {
        while (i <= j && a[i] < pivot) i++;   // 左边找 >= pivot 的
        while (i <= j && a[j] > pivot) j--;   // 右边找 <= pivot 的
        if (i >= j) break;
        swap(a, i++, j--);
    }
    swap(a, lo, j);                           // 基准归位
    return j;
}
```

几个要点：

- **两个内层循环都带 `i <= j` 边界检查**，任何长度（包括 2 个元素）都不会越界
- **遇到等于 pivot 的元素两边都停下交换**，大量重复值时两段依然均衡；如果只在一边停，全相同的数组会退化成 O(n²)
- **选基准**：固定取第一个元素，遇到有序输入就退化；随机选或「三数取中」（取首、中、尾三个数的中位数）都能避免。注意「三数取中」和「三路快排」不是一回事：三路快排是把数组划分成 `< pivot`、`= pivot`、`> pivot` 三段，专门应对大量重复值，LeetCode 75 颜色分类就是这个思路
- 平均 O(n log n)，最坏 O(n²)；递归栈平均 O(log n)

### 7、堆排序

先把数组建成大顶堆，再反复把堆顶（最大值）换到末尾、缩小堆并下沉。时间 O(n log n)、空间 O(1)、不稳定。建堆与下沉的代码见 [堆](../1_data_structures/4_heap)。

---

## 三、非比较类排序

比较类排序的下界是 O(n log n)。非比较类排序利用值本身的信息（值域、位数）突破这个下界，代价是对数据有前提要求。

### 1、计数排序

适合**值域不大**的整数：统计每个值出现的次数，再用前缀和算出每个值在结果中的位置，**从后往前**回填保证稳定。下面用 `min` 做偏移，负数也能处理：

```java
int[] countingSort(int[] a) {
    if (a.length == 0) return a;
    int min = Arrays.stream(a).min().getAsInt();
    int max = Arrays.stream(a).max().getAsInt();
    int[] count = new int[max - min + 1];              // 值域 k = max - min + 1
    for (int x : a) count[x - min]++;
    for (int i = 1; i < count.length; i++) count[i] += count[i - 1];  // 前缀和：<= 该值的元素个数
    int[] out = new int[a.length];
    for (int i = a.length - 1; i >= 0; i--) {          // 从后往前，相等元素保持原顺序
        out[--count[a[i] - min]] = a[i];
    }
    return out;
}
```

时间、空间都是 O(n + k)。值域很大时（比如 `max - min` 接近 2^31）计数数组放不下，不适用。

只统计次数、再按值依次写回（`while (count[v]-- > 0) a[idx++] = v`）的简化写法也能把 `int` 排好序，但它是「重新生成值」，无法携带记录，谈不上稳定，也不能用作基数排序的子过程。

### 2、桶排序

把值域切成若干个桶，每个元素按值放进对应的桶，桶内分别排序后依次拼接。下面的写法**假设输入均匀分布在 `[0, 1)`**，值为 1.0 或负数时下标会越界：

```java
void bucketSort(double[] a) {
    int n = a.length;
    List<List<Double>> buckets = new ArrayList<>();
    for (int i = 0; i < n; i++) buckets.add(new ArrayList<>());
    for (double x : a) buckets.get((int) (x * n)).add(x);   // 要求 0 <= x < 1
    int idx = 0;
    for (List<Double> bucket : buckets) {
        Collections.sort(bucket);                            // 稳定排序
        for (double x : bucket) a[idx++] = x;
    }
}
```

分布均匀时接近 O(n)；所有元素落进同一个桶时退化为桶内排序的复杂度。

### 3、基数排序

从最低位到最高位，每一位做一次稳定的计数排序。下面先减去最小值把所有数映射成非负的 `long`，负数也能排；位权 `exp` 用 `long`，避免 `int` 在 10^10 处溢出：

```java
void radixSort(int[] a) {
    if (a.length == 0) return;
    int min = Arrays.stream(a).min().getAsInt();
    long[] keys = new long[a.length];
    long maxKey = 0;
    for (int i = 0; i < a.length; i++) {
        keys[i] = (long) a[i] - min;                  // 映射到 [0, 2^32)，不会溢出
        maxKey = Math.max(maxKey, keys[i]);
    }
    long[] out = new long[a.length];
    for (long exp = 1; maxKey / exp > 0; exp *= 10) {
        int[] count = new int[10];
        for (long k : keys) count[(int) (k / exp % 10)]++;
        for (int d = 1; d < 10; d++) count[d] += count[d - 1];
        for (int i = keys.length - 1; i >= 0; i--) {  // 从后往前保证稳定
            out[--count[(int) (keys[i] / exp % 10)]] = keys[i];
        }
        System.arraycopy(out, 0, keys, 0, keys.length);
    }
    for (int i = 0; i < a.length; i++) a[i] = (int) (keys[i] + min);
}
```

每一位都依赖上一轮的稳定性：低位排好的相对顺序，在高位相同时必须保留下来。

---

## 四、内置排序的实现

| API | 算法 | 稳定 |
|-----|------|------|
| `Arrays.sort(int[])` 等基本类型 | 双轴快排（Dual-Pivot Quicksort） | 不需要 |
| `Arrays.sort(Object[])`、`List.sort`、`Collections.sort` | TimSort | 是 |
| `Arrays.parallelSort` | 并行归并（数组较小时退回串行排序） | 对象版本稳定 |

- **双轴快排**：JDK 7 引入，用两个基准把数组分成三段。JDK 14（JDK-8226297）重写后，小区间用插入排序的变体，检测到数组由少量有序段组成时改走归并，递归过深时退回堆排序，最坏情况也是 O(n log n)
- **TimSort**：归并排序与插入排序的结合，会识别数据里本来就有序的片段（run）再合并，部分有序时接近 O(n)
- 基本类型不需要稳定（相等的 `int` 无法区分），对象需要，这是两者算法不同的原因

比较器不要写成 `(a, b) -> a - b`：两个 `int` 相减可能溢出，得到相反的符号，TimSort 检测到比较结果前后矛盾时会抛 `IllegalArgumentException: Comparison method violates its general contract!`。用 `Integer.compare(a, b)` 或 `Comparator.comparingInt(...)`。集合框架的其他细节见 [集合框架](/java/21_topic_collection)。

---

## 五、排序选型建议

| 场景 | 推荐 |
|------|------|
| 日常业务代码 | 直接用 `Arrays.sort` / `List.sort`，不要手写 |
| 数据量很小（几十个以内） | 插入排序 |
| 需要稳定、空间允许 | 归并排序（对象排序的 TimSort 已经稳定） |
| 平均最快、不要求稳定 | 快速排序（随机基准） |
| 只要第 K 大 / 前 K 个 | 快速选择或堆，不必全排序 |
| 整数且值域小 | 计数排序 |
| 整数位数少、数据量大 | 基数排序 |
| 数据放不进内存 | 外部排序（分块排序 + 多路归并） |

本篇完整实现的题目：LeetCode 912 排序数组（快排 / 归并）。其他排序相关题目见 [LeetCode 高频题分类](../4_practice/0_leet_code)。

---

## 小结

- 稳定的：冒泡、插入、归并、计数、基数；不稳定的：选择、希尔、快排、堆排
- 快排要点：随机基准、内层循环带边界检查、等于 pivot 时两边都停下交换
- 归并排序 O(n log n) 稳定，需要 O(n) 辅助空间，也是外部排序的基础
- 计数排序要用前缀和 + 从后往前回填才稳定；基数排序处理负数先减最小值，位权用 `long`
- `Arrays.sort` 基本类型用双轴快排（JDK 14 起有堆排序兜底），对象用 TimSort；比较器用 `Integer.compare`

## 参考资料

- Java 21 `Arrays` API：[https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/Arrays.html](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/Arrays.html)
- JDK-8226297 Dual-Pivot Quicksort improvements：[https://bugs.openjdk.org/browse/JDK-8226297](https://bugs.openjdk.org/browse/JDK-8226297)
- OI Wiki 快速排序：[https://oi-wiki.org/basic/quick-sort/](https://oi-wiki.org/basic/quick-sort/)
- OI Wiki 计数排序：[https://oi-wiki.org/basic/counting-sort/](https://oi-wiki.org/basic/counting-sort/)
- OI Wiki 基数排序：[https://oi-wiki.org/basic/radix-sort/](https://oi-wiki.org/basic/radix-sort/)
- OI Wiki 希尔排序：[https://oi-wiki.org/basic/shell-sort/](https://oi-wiki.org/basic/shell-sort/)

> 下一篇：[分治算法](./2_divide_conquer) —— 分治三步、主定理、快速幂、逆序对、合并 K 个有序链表。
