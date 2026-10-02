---
description: 二叉堆、优先队列、Top K
---

# 堆

---

## 一、堆的定义

堆（Heap）是一棵**完全二叉树**，满足堆性质：

- **大顶堆（Max-Heap）**：每个节点 ≥ 其子节点，堆顶为最大值
- **小顶堆（Min-Heap）**：每个节点 ≤ 其子节点，堆顶为最小值

堆通常用**数组**存储（完全二叉树的天然映射）：
- 节点 `i` 的左子节点：`2i + 1`
- 节点 `i` 的右子节点：`2i + 2`
- 节点 `i` 的父节点：`(i - 1) / 2`

---

## 二、核心操作

### 2.1 上浮（sift up）

新元素插入到末尾，与父节点比较，若违反堆性质则交换，直到满足：

```java
void siftUp(int[] heap, int i) {
    while (i > 0) {
        int parent = (i - 1) / 2;
        if (heap[parent] < heap[i]) { // 大顶堆：父 < 子 则交换
            swap(heap, parent, i);
            i = parent;
        } else break;
    }
}
```

### 2.2 下沉（sift down）

堆顶被移除后，将末尾元素移至堆顶，再与较大子节点比较，违反则交换：

```java
void siftDown(int[] heap, int i, int size) {
    while (true) {
        int largest = i;
        int left = 2 * i + 1, right = 2 * i + 2;
        if (left  < size && heap[left]  > heap[largest]) largest = left;
        if (right < size && heap[right] > heap[largest]) largest = right;
        if (largest == i) break;
        swap(heap, i, largest);
        i = largest;
    }
}
```

### 2.3 建堆（O(n)）

从最后一个非叶节点开始，逐一向下 sift down：

```java
void buildHeap(int[] arr) {
    int n = arr.length;
    for (int i = n / 2 - 1; i >= 0; i--) { // 从最后一个非叶节点开始
        siftDown(arr, i, n);
    }
}
```

**时间复杂度 O(n)**（而非 O(n log n)，因为靠近底部的节点下沉距离短）。

---

## 三、堆排序

```java
void heapSort(int[] arr) {
    int n = arr.length;
    // 1. 建大顶堆
    buildHeap(arr);
    // 2. 依次将堆顶（最大值）放到末尾
    for (int i = n - 1; i > 0; i--) {
        swap(arr, 0, i);        // 堆顶与末尾交换
        siftDown(arr, 0, i);   // 重新调整堆（范围缩小）
    }
}
```

| 指标 | 值 |
|------|-----|
| 时间复杂度 | O(n log n) |
| 空间复杂度 | O(1)（原地） |
| 稳定性 | ❌ 不稳定 |

---

## 四、Java PriorityQueue

```java
// 小顶堆（默认）
PriorityQueue<Integer> minHeap = new PriorityQueue<>();

// 大顶堆
PriorityQueue<Integer> maxHeap = new PriorityQueue<>(Collections.reverseOrder());

// 自定义排序（按 int[] 的第二个元素升序）
PriorityQueue<int[]> pq = new PriorityQueue<>((a, b) -> a[1] - b[1]);

minHeap.offer(3);   // 插入 O(log n)
minHeap.peek();     // 查看堆顶 O(1)
minHeap.poll();     // 取出堆顶 O(log n)
minHeap.size();
```

---

## 五、Top K 问题

### 5.1 找最大的 K 个数（小顶堆）

维护一个大小为 K 的小顶堆，堆顶是第 K 大的数：

```java
int[] topKLargest(int[] nums, int k) {
    PriorityQueue<Integer> minHeap = new PriorityQueue<>(k);
    for (int num : nums) {
        if (minHeap.size() < k) {
            minHeap.offer(num);
        } else if (num > minHeap.peek()) {
            minHeap.poll();
            minHeap.offer(num);
        }
    }
    return minHeap.stream().mapToInt(Integer::intValue).toArray();
}
```

**时间复杂度：O(n log k)**，空间 O(k)，适合 n 很大时。

### 5.2 第 K 大元素（LeetCode 215）

```java
int findKthLargest(int[] nums, int k) {
    PriorityQueue<Integer> minHeap = new PriorityQueue<>(k);
    for (int num : nums) {
        minHeap.offer(num);
        if (minHeap.size() > k) minHeap.poll();
    }
    return minHeap.peek(); // 小顶堆堆顶 = 第 K 大
}
```

### 5.3 数据流中位数（双堆）

用大顶堆存左半部分，小顶堆存右半部分，保持两堆大小相差 ≤ 1：

```java
class MedianFinder {
    PriorityQueue<Integer> lo = new PriorityQueue<>(Collections.reverseOrder()); // 大顶
    PriorityQueue<Integer> hi = new PriorityQueue<>(); // 小顶

    public void addNum(int num) {
        lo.offer(num);
        hi.offer(lo.poll());        // 平衡：lo 最大值移到 hi
        if (lo.size() < hi.size())  // 保持 lo.size >= hi.size
            lo.offer(hi.poll());
    }

    public double findMedian() {
        return lo.size() > hi.size()
            ? lo.peek()
            : (lo.peek() + hi.peek()) / 2.0;
    }
}
```

---

## 六、经典题目

| 题目 | 考点 |
|------|------|
| LeetCode 215 数组中第 K 大元素 | 小顶堆 Top K |
| LeetCode 295 数据流的中位数 | 双堆 |
| LeetCode 23 合并 K 个升序链表 | 小顶堆 |
| LeetCode 347 前 K 个高频元素 | 小顶堆 + 计数 |
| LeetCode 373 查找和最小的 K 对数字 | 小顶堆 |
| LeetCode 264 丑数 II | 小顶堆 / 三指针 |
