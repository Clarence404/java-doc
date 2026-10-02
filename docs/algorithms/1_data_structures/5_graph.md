---
description: 存储方式、BFS / DFS、拓扑排序
---

# 图

---

## 一、图的基本概念

**图 G = (V, E)**：V 是顶点集合，E 是边集合。

| 概念 | 说明 |
|------|------|
| 有向图 / 无向图 | 边是否有方向 |
| 有权图 / 无权图 | 边是否有权重 |
| 度 | 无向图中与顶点相连的边数；有向图分入度/出度 |
| 连通图 | 任意两顶点间都有路径 |
| 强连通分量 | 有向图中任意两点互相可达的最大子图 |

---

## 二、图的存储方式

### 2.1 邻接矩阵

```java
// n 个顶点，matrix[i][j] = 边权（0 表示无边）
int[][] matrix = new int[n][n];
matrix[0][1] = 5; // 顶点0到顶点1，权重5
```

- 优点：O(1) 判断两点是否相连
- 缺点：空间 O(V²)，稀疏图浪费

### 2.2 邻接表（推荐）

```java
// 用 List 数组表示
List<List<Integer>> adj = new ArrayList<>();
for (int i = 0; i < n; i++) adj.add(new ArrayList<>());
adj.get(0).add(1); // 顶点0指向顶点1

// 带权图
List<List<int[]>> adjW = new ArrayList<>();
for (int i = 0; i < n; i++) adjW.add(new ArrayList<>());
adjW.get(0).add(new int[]{1, 5}); // 顶点0→顶点1，权重5
```

- 优点：空间 O(V + E)，适合稀疏图
- 缺点：判断两点相连需遍历

---

## 三、BFS（广度优先搜索）

层层扩展，适合求**最短路径**（无权图）：

```java
int bfs(int[][] grid, int sr, int sc, int er, int ec) {
    int rows = grid.length, cols = grid[0].length;
    boolean[][] visited = new boolean[rows][cols];
    Queue<int[]> queue = new LinkedList<>();
    queue.offer(new int[]{sr, sc});
    visited[sr][sc] = true;
    int steps = 0;
    int[][] dirs = {{0,1},{0,-1},{1,0},{-1,0}};

    while (!queue.isEmpty()) {
        int size = queue.size();
        for (int i = 0; i < size; i++) {
            int[] cur = queue.poll();
            if (cur[0] == er && cur[1] == ec) return steps;
            for (int[] d : dirs) {
                int nr = cur[0] + d[0], nc = cur[1] + d[1];
                if (nr >= 0 && nr < rows && nc >= 0 && nc < cols
                        && grid[nr][nc] != 1 && !visited[nr][nc]) {
                    visited[nr][nc] = true;
                    queue.offer(new int[]{nr, nc});
                }
            }
        }
        steps++;
    }
    return -1; // 不可达
}
```

---

## 四、DFS（深度优先搜索）

一路走到底，回溯继续，适合**连通性判断、路径枚举、拓扑排序**：

```java
// 岛屿数量（LeetCode 200）
int numIslands(char[][] grid) {
    int count = 0;
    for (int r = 0; r < grid.length; r++)
        for (int c = 0; c < grid[0].length; c++)
            if (grid[r][c] == '1') {
                dfs(grid, r, c);
                count++;
            }
    return count;
}

void dfs(char[][] grid, int r, int c) {
    if (r < 0 || r >= grid.length || c < 0 || c >= grid[0].length
            || grid[r][c] != '1') return;
    grid[r][c] = '0'; // 标记已访问（原地修改）
    dfs(grid, r+1, c); dfs(grid, r-1, c);
    dfs(grid, r, c+1); dfs(grid, r, c-1);
}
```

---

## 五、拓扑排序

对**有向无环图（DAG）**按依赖顺序排列顶点，用于任务调度、课程安排等。

### 5.1 BFS（Kahn 算法）

```java
int[] topoSort(int n, int[][] prerequisites) {
    int[] inDegree = new int[n];
    List<List<Integer>> adj = new ArrayList<>();
    for (int i = 0; i < n; i++) adj.add(new ArrayList<>());

    for (int[] pre : prerequisites) {
        adj.get(pre[1]).add(pre[0]);
        inDegree[pre[0]]++;
    }

    Queue<Integer> queue = new LinkedList<>();
    for (int i = 0; i < n; i++)
        if (inDegree[i] == 0) queue.offer(i);

    int[] order = new int[n];
    int idx = 0;
    while (!queue.isEmpty()) {
        int cur = queue.poll();
        order[idx++] = cur;
        for (int next : adj.get(cur))
            if (--inDegree[next] == 0) queue.offer(next);
    }
    return idx == n ? order : new int[0]; // 有环则无法完成
}
```

---

## 六、最短路径

### 6.1 Dijkstra（非负权有向图）

单源最短路径，适合正权图：

```java
int[] dijkstra(int n, int[][] edges, int src) {
    List<List<int[]>> adj = new ArrayList<>();
    for (int i = 0; i < n; i++) adj.add(new ArrayList<>());
    for (int[] e : edges) adj.get(e[0]).add(new int[]{e[1], e[2]});

    int[] dist = new int[n];
    Arrays.fill(dist, Integer.MAX_VALUE);
    dist[src] = 0;

    PriorityQueue<int[]> pq = new PriorityQueue<>((a, b) -> a[1] - b[1]);
    pq.offer(new int[]{src, 0});

    while (!pq.isEmpty()) {
        int[] cur = pq.poll();
        int u = cur[0], d = cur[1];
        if (d > dist[u]) continue; // 已找到更短路径，跳过
        for (int[] next : adj.get(u)) {
            int v = next[0], w = next[1];
            if (dist[u] + w < dist[v]) {
                dist[v] = dist[u] + w;
                pq.offer(new int[]{v, dist[v]});
            }
        }
    }
    return dist;
}
```

**复杂度**：O((V + E) log V)

### 6.2 Bellman-Ford（含负权边）

支持负权边，能检测负权环：

```java
int[] bellmanFord(int n, int[][] edges, int src) {
    int[] dist = new int[n];
    Arrays.fill(dist, Integer.MAX_VALUE);
    dist[src] = 0;

    for (int i = 0; i < n - 1; i++) { // 最多松弛 n-1 轮
        for (int[] e : edges) { // 每轮遍历所有边
            int u = e[0], v = e[1], w = e[2];
            if (dist[u] != Integer.MAX_VALUE && dist[u] + w < dist[v])
                dist[v] = dist[u] + w;
        }
    }
    return dist;
}
```

---

## 七、并查集（Union-Find）

处理**动态连通性**问题，判断两节点是否在同一连通分量：

```java
class UnionFind {
    int[] parent, rank;

    UnionFind(int n) {
        parent = new int[n];
        rank = new int[n];
        for (int i = 0; i < n; i++) parent[i] = i;
    }

    int find(int x) { // 路径压缩
        if (parent[x] != x) parent[x] = find(parent[x]);
        return parent[x];
    }

    boolean union(int x, int y) { // 按秩合并
        int px = find(x), py = find(y);
        if (px == py) return false; // 已经连通
        if (rank[px] < rank[py]) { int t = px; px = py; py = t; }
        parent[py] = px;
        if (rank[px] == rank[py]) rank[px]++;
        return true;
    }

    boolean connected(int x, int y) { return find(x) == find(y); }
}
```

---

## 八、经典题目

| 题目 | 考点 |
|------|------|
| LeetCode 200 岛屿数量 | DFS/BFS |
| LeetCode 207 课程表 | 拓扑排序（检测环）|
| LeetCode 743 网络延迟时间 | Dijkstra |
| LeetCode 547 省份数量 | 并查集 / DFS |
| LeetCode 684 冗余连接 | 并查集 |
| LeetCode 1584 连接所有点最小费用 | Prim / Kruskal（最小生成树）|
