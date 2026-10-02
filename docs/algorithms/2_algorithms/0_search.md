---
description: 二分查找、DFS / BFS
---

# 搜索算法

---

## 一、线性搜索

逐一检查每个元素，时间复杂度 O(n)，适用于无序数据。

```java
int linearSearch(int[] arr, int target) {
    for (int i = 0; i < arr.length; i++)
        if (arr[i] == target) return i;
    return -1;
}
```

---

## 二、二分搜索（Binary Search）

**前提**：数组有序。每次将搜索范围缩小一半，时间复杂度 O(log n)。

### 2.1 基本模板

```java
// 查找 target，返回下标；不存在返回 -1
int binarySearch(int[] arr, int target) {
    int lo = 0, hi = arr.length - 1;
    while (lo <= hi) {
        int mid = lo + (hi - lo) / 2; // 防止 lo+hi 溢出
        if (arr[mid] == target) return mid;
        else if (arr[mid] < target) lo = mid + 1;
        else                        hi = mid - 1;
    }
    return -1;
}
```

### 2.2 找左边界（第一个 ≥ target 的位置）

```java
int lowerBound(int[] arr, int target) {
    int lo = 0, hi = arr.length; // hi 取 length（开区间）
    while (lo < hi) {
        int mid = lo + (hi - lo) / 2;
        if (arr[mid] < target) lo = mid + 1;
        else                   hi = mid;
    }
    return lo; // lo == hi，即第一个 >= target 的下标
}
```

### 2.3 找右边界（最后一个 ≤ target 的位置）

```java
int upperBound(int[] arr, int target) {
    int lo = 0, hi = arr.length;
    while (lo < hi) {
        int mid = lo + (hi - lo) / 2;
        if (arr[mid] <= target) lo = mid + 1;
        else                    hi = mid;
    }
    return lo - 1; // 最后一个 <= target 的下标
}
```

### 2.4 二分搜索变形

```java
// 搜索旋转排序数组（LeetCode 33）
int search(int[] nums, int target) {
    int lo = 0, hi = nums.length - 1;
    while (lo <= hi) {
        int mid = lo + (hi - lo) / 2;
        if (nums[mid] == target) return mid;
        if (nums[lo] <= nums[mid]) { // 左半有序
            if (nums[lo] <= target && target < nums[mid]) hi = mid - 1;
            else lo = mid + 1;
        } else { // 右半有序
            if (nums[mid] < target && target <= nums[hi]) lo = mid + 1;
            else hi = mid - 1;
        }
    }
    return -1;
}

// 在答案上二分（求最小值满足条件）
int binaryOnAnswer(int lo, int hi) {
    while (lo < hi) {
        int mid = lo + (hi - lo) / 2;
        if (check(mid)) hi = mid;   // mid 满足，缩小右边界
        else            lo = mid + 1;
    }
    return lo;
}
```

---

## 三、深度优先搜索（DFS）

> 本节聚焦 DFS/BFS 的**通用遍历模板**。图结构上的具体应用（拓扑排序、最短路径、并查集）详见 [图](../1_data_structures/5_graph.md)。

### 3.1 递归模板

```java
// 通用 DFS 框架
void dfs(状态, 已访问集合) {
    if (满足终止条件) {
        记录结果;
        return;
    }
    for (下一个状态 : 可选列表) {
        if (!已访问) {
            标记已访问;
            dfs(下一个状态, 已访问集合);
            撤销标记; // 回溯
        }
    }
}
```

### 3.2 矩阵 DFS

```java
int[][] dirs = {{0,1},{0,-1},{1,0},{-1,0}};
boolean[][] visited;

void dfs(char[][] grid, int r, int c) {
    if (r < 0 || r >= grid.length || c < 0 || c >= grid[0].length
            || visited[r][c] || grid[r][c] == '0') return;
    visited[r][c] = true;
    for (int[] d : dirs) dfs(grid, r + d[0], c + d[1]);
}
```

---

## 四、广度优先搜索（BFS）

### 4.1 最短路径模板

```java
int bfs(起点, 终点) {
    Queue<节点> queue = new LinkedList<>();
    Set<节点> visited = new HashSet<>();
    queue.offer(起点);
    visited.add(起点);
    int steps = 0;

    while (!queue.isEmpty()) {
        int size = queue.size();
        for (int i = 0; i < size; i++) {
            节点 cur = queue.poll();
            if (cur == 终点) return steps;
            for (节点 next : 邻居(cur)) {
                if (!visited.contains(next)) {
                    visited.add(next);
                    queue.offer(next);
                }
            }
        }
        steps++;
    }
    return -1;
}
```

### 4.2 双向 BFS（优化）

从起点和终点同时搜索，相遇即找到最短路径，时间复杂度从 O(b^d) 降到 O(b^(d/2))：

```java
int doubleBFS(String start, String end) {
    Set<String> beginSet = new HashSet<>(), endSet = new HashSet<>();
    Set<String> visited = new HashSet<>();
    beginSet.add(start); endSet.add(end);
    int steps = 0;

    while (!beginSet.isEmpty()) {
        steps++;
        Set<String> nextSet = new HashSet<>();
        for (String cur : beginSet) {
            // 枚举所有变换
            for (String next : getNeighbors(cur)) {
                if (endSet.contains(next)) return steps; // 两端相遇
                if (!visited.contains(next)) {
                    visited.add(next);
                    nextSet.add(next);
                }
            }
        }
        beginSet = nextSet;
        if (beginSet.size() > endSet.size())  // 始终从小的一端扩展
            { beginSet = endSet; endSet = nextSet; }
    }
    return -1;
}
```

---

## 五、二分 vs BFS vs DFS

| | 二分搜索 | BFS | DFS |
|--|---------|-----|-----|
| 适用数据 | 有序数组 | 图/树/矩阵 | 图/树/矩阵 |
| 最短路径 | — | ✅（无权图）| ❌ |
| 连通性 | — | ✅ | ✅ |
| 全路径枚举 | — | ❌ | ✅ |
| 空间复杂度 | O(1) | O(V)（队列）| O(V)（调用栈）|

---

## 六、经典题目

| 题目 | 考点 |
|------|------|
| LeetCode 704 二分查找 | 基础二分 |
| LeetCode 35 搜索插入位置 | 左边界二分 |
| LeetCode 33 搜索旋转排序数组 | 二分变形 |
| LeetCode 74 搜索二维矩阵 | 二分 |
| LeetCode 200 岛屿数量 | DFS/BFS |
| LeetCode 127 单词接龙 | BFS 最短路 |
| LeetCode 752 打开转盘锁 | BFS + 双向 BFS |
| LeetCode 994 腐烂的橘子 | 多源 BFS |
