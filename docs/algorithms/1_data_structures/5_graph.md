---
description: 邻接矩阵与邻接表、BFS / DFS、拓扑排序、最短路径、并查集、最小生成树
---

# 图

> 前置阅读：[栈与队列](./1_stack_queue)、[堆](./4_heap)

图是最通用的关系模型，与树不同的是可能有环，遍历时必须记录访问状态。本篇讲邻接矩阵与邻接表、BFS / DFS 模板、拓扑排序、Dijkstra、Bellman-Ford、并查集与 Kruskal。

---

## 一、基本概念

**图 G = (V, E)**：V 是顶点集合，E 是边集合，下文用 V、E 同时表示顶点数和边数。

| 概念 | 说明 |
|------|------|
| 有向图 / 无向图 | 边是否有方向 |
| 带权图 / 无权图 | 边是否有权重（距离、耗时、费用） |
| 度 | 无向图中与顶点相连的边数；有向图分入度和出度 |
| 连通图 | 无向图中任意两个顶点之间都有路径 |
| 强连通分量 | 有向图中任意两点互相可达的极大子图 |
| 有向无环图（DAG） | 没有环的有向图，可以做拓扑排序 |
| 稀疏图 / 稠密图 | E 远小于 V² 为稀疏图，接近 V² 为稠密图 |

---

## 二、存储方式

![同一张无向图的邻接矩阵与邻接表](../../assets/algorithms/graph_storage.svg)

### 1、邻接矩阵

用 V × V 的二维数组，`matrix[i][j]` 表示 i 到 j 的边权（无边时用 0 或无穷大）：

```java
int[][] matrix = new int[n][n];
matrix[0][1] = 5;     // 顶点 0 → 顶点 1，权重 5；无向图还要写 matrix[1][0]
```

- 优点：O(1) 判断两点是否相连，实现简单
- 缺点：空间 O(V²)，稀疏图浪费严重；遍历某个顶点的邻居要扫一整行，O(V)

### 2、邻接表（推荐）

每个顶点维护一个邻居列表：

```java
// 无权图
List<List<Integer>> adj = new ArrayList<>();
for (int i = 0; i < n; i++) adj.add(new ArrayList<>());
adj.get(0).add(1);                 // 顶点 0 → 顶点 1

// 带权图：用 record 表示边，比 int[] 可读
record Edge(int to, int weight) {}
List<List<Edge>> adjW = new ArrayList<>();
for (int i = 0; i < n; i++) adjW.add(new ArrayList<>());
adjW.get(0).add(new Edge(1, 5));   // 顶点 0 → 顶点 1，权重 5
```

- 优点：空间 O(V + E)，遍历邻居只花邻居个数的时间
- 缺点：判断两点是否相连要扫描邻居列表

刷题时绝大多数图都是稀疏图，默认用邻接表；顶点数很少（几百以内）且要频繁查边时用邻接矩阵，如 Floyd 算法。

---

## 三、BFS（广度优先搜索）

BFS 由近到远逐层扩展，**在无权图中第一次到达某点时走的就是最短路径**。下面是网格最短路的模板，约定 `grid[r][c] == 1` 表示障碍，起点和终点都不是障碍：

```java
int shortestPath(int[][] grid, int sr, int sc, int er, int ec) {
    int rows = grid.length, cols = grid[0].length;
    boolean[][] visited = new boolean[rows][cols];
    Queue<int[]> queue = new ArrayDeque<>();
    queue.offer(new int[]{sr, sc});
    visited[sr][sc] = true;                         // 入队时就标记，避免重复入队
    int[][] dirs = {{0, 1}, {0, -1}, {1, 0}, {-1, 0}};

    for (int steps = 0; !queue.isEmpty(); steps++) {
        for (int size = queue.size(); size > 0; size--) {   // 一次处理一整层
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
    }
    return -1;   // 不可达
}
```

**入队时标记还是出队时标记**：入队时标记，每个格子只会入队一次；出队时才标记，同一个格子可能被多个邻居重复放入队列，最坏情况队列膨胀很多倍。

边权只有 0 和 1 时，可以用双端队列做「0-1 BFS」：权为 0 的边放队头、权为 1 的放队尾，仍是 O(V + E)。

---

## 四、DFS（深度优先搜索）

DFS 一条路走到底再回头，适合**连通性判断、连通块计数、环检测、拓扑排序**。

```java
// 岛屿数量（LeetCode 200）
int numIslands(char[][] grid) {
    int count = 0;
    for (int r = 0; r < grid.length; r++) {
        for (int c = 0; c < grid[0].length; c++) {
            if (grid[r][c] == '1') {
                dfs(grid, r, c);
                count++;
            }
        }
    }
    return count;
}

void dfs(char[][] grid, int r, int c) {
    if (r < 0 || r >= grid.length || c < 0 || c >= grid[0].length
            || grid[r][c] != '1') return;
    grid[r][c] = '0';            // 原地改成 '0' 作为已访问标记
    dfs(grid, r + 1, c);
    dfs(grid, r - 1, c);
    dfs(grid, r, c + 1);
    dfs(grid, r, c - 1);
}
```

**递归深度风险**：最坏情况下递归深度等于连通块大小。1000 × 1000 的全陆地网格，递归可能达到百万层，远超默认线程栈的容量，会抛 `StackOverflowError`。数据规模大时改用 BFS，或用显式栈写迭代版 DFS。

图的遍历中，访问标记一旦设置就不撤销，每个顶点只访问一次，O(V + E)；回溯算法则会在返回时撤销标记以枚举所有路径，复杂度是指数级，见 [回溯算法](../2_algorithms/3_backtrack)。

---

## 五、拓扑排序

对**有向无环图**按依赖顺序排列顶点：若有边 u → v，则 u 排在 v 前面。用于任务调度、课程安排、构建系统的模块编译顺序等。图中有环时不存在拓扑序，所以拓扑排序也是有向图判环的标准方法。

### 1、BFS 写法（Kahn 算法）

反复取出入度为 0 的顶点，并把它指向的顶点入度减一：

```java
// LeetCode 210 课程表 II：prerequisites[i] = [a, b] 表示学 a 之前要先学 b，即边 b → a
int[] findOrder(int n, int[][] prerequisites) {
    int[] inDegree = new int[n];
    List<List<Integer>> adj = new ArrayList<>();
    for (int i = 0; i < n; i++) adj.add(new ArrayList<>());
    for (int[] p : prerequisites) {
        adj.get(p[1]).add(p[0]);
        inDegree[p[0]]++;
    }

    Queue<Integer> queue = new ArrayDeque<>();
    for (int i = 0; i < n; i++) {
        if (inDegree[i] == 0) queue.offer(i);
    }

    int[] order = new int[n];
    int idx = 0;
    while (!queue.isEmpty()) {
        int cur = queue.poll();
        order[idx++] = cur;
        for (int next : adj.get(cur)) {
            if (--inDegree[next] == 0) queue.offer(next);
        }
    }
    return idx == n ? order : new int[0];   // 有环时总有顶点入度降不到 0
}
```

### 2、DFS 写法（三色标记）

每个顶点有三种状态：0 未访问、1 访问中（在当前递归路径上）、2 已完成。DFS 中遇到「访问中」的顶点说明有环；顶点完成时加入结果，最后把结果反转就是拓扑序：

```java
int[] state;
List<Integer> post;
List<List<Integer>> graph;

int[] topoSortDfs(int n, List<List<Integer>> adj) {
    state = new int[n];
    post = new ArrayList<>();
    graph = adj;
    for (int i = 0; i < n; i++) {
        if (state[i] == 0 && !visit(i)) return new int[0];   // 有环
    }
    Collections.reverse(post);
    return post.stream().mapToInt(Integer::intValue).toArray();
}

boolean visit(int u) {
    state[u] = 1;
    for (int v : graph.get(u)) {
        if (state[v] == 1) return false;              // 回到当前路径上的顶点：有环
        if (state[v] == 0 && !visit(v)) return false;
    }
    state[u] = 2;
    post.add(u);                                      // 后序加入
    return true;
}
```

---

## 六、最短路径

### 1、Dijkstra：非负权图的单源最短路

适用于**边权非负**的有向图或无向图。思路是贪心：每次从未确定的顶点中取出当前距离最小的那个，它的最短距离就此确定，再用它去松弛邻居。

```java
// edges[i] = [u, v, w] 表示有向边 u → v，权重 w ≥ 0
int[] dijkstra(int n, int[][] edges, int src) {
    List<List<int[]>> adj = new ArrayList<>();
    for (int i = 0; i < n; i++) adj.add(new ArrayList<>());
    for (int[] e : edges) adj.get(e[0]).add(new int[]{e[1], e[2]});

    int[] dist = new int[n];
    Arrays.fill(dist, Integer.MAX_VALUE);
    dist[src] = 0;

    // 队列元素为 {顶点, 入队时的距离}，按距离升序
    PriorityQueue<int[]> pq = new PriorityQueue<>(Comparator.comparingInt(a -> a[1]));
    pq.offer(new int[]{src, 0});

    while (!pq.isEmpty()) {
        int[] cur = pq.poll();
        int u = cur[0], d = cur[1];
        if (d > dist[u]) continue;     // 过期记录：u 已经以更短的距离出过队
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

**为什么要 `if (d > dist[u]) continue`**：`PriorityQueue` 不支持高效地修改已有元素的优先级，所以距离变短时直接再放一条新记录（懒删除）。同一个顶点可能在队列里有多条记录，只有距离等于 `dist[u]` 的那条有效，其余出队时跳过，否则会用过期距离重复松弛。

队列中最多有 E 条记录，复杂度 O(E log E)，由于 E ≤ V²，log E ≤ 2 log V，所以也写作 O(E log V)。

**为什么不能有负权边**：Dijkstra 认定「出队即确定」，负权边可能让一个已确定的顶点在之后被更短的路径更新，结论就错了。

### 2、Bellman-Ford：支持负权边与负环检测

对所有边做 V − 1 轮松弛：最短路径最多含 V − 1 条边，第 k 轮结束后，最多用 k 条边的最短路径都已求出。再做第 V 轮，如果还有边能松弛，说明存在从起点可达的负权环：

```java
// 返回 null 表示存在从 src 可达的负权环
int[] bellmanFord(int n, int[][] edges, int src) {
    int[] dist = new int[n];
    Arrays.fill(dist, Integer.MAX_VALUE);
    dist[src] = 0;

    for (int round = 1; round <= n; round++) {
        boolean updated = false;
        for (int[] e : edges) {
            int u = e[0], v = e[1], w = e[2];
            if (dist[u] != Integer.MAX_VALUE && dist[u] + w < dist[v]) {
                dist[v] = dist[u] + w;
                updated = true;
            }
        }
        if (!updated) return dist;     // 本轮没有任何更新，提前结束
        if (round == n) return null;   // 第 n 轮仍能松弛：有负权环
    }
    return dist;
}
```

`dist[u] != Integer.MAX_VALUE` 的判断不能省：未到达的顶点距离是 `MAX_VALUE`，加上正权会溢出成负数。复杂度 O(V × E)。SPFA 是它的队列优化版，只松弛上一轮距离变化过的顶点的出边，平均更快，但最坏仍是 O(V × E)。

### 3、Floyd-Warshall：所有点对之间的最短路

用邻接矩阵，三重循环枚举中转点 k：如果经过 k 中转更短就更新。

```java
static final int INF = Integer.MAX_VALUE / 2;   // 取一半，两个 INF 相加也不溢出

// dist 初始为邻接矩阵：dist[i][i] = 0，有边为边权，无边为 INF
void floyd(int[][] dist) {
    int n = dist.length;
    for (int k = 0; k < n; k++) {            // 中转点必须在最外层
        for (int i = 0; i < n; i++) {
            if (dist[i][k] >= INF) continue;
            for (int j = 0; j < n; j++) {
                if (dist[i][k] + dist[k][j] < dist[i][j]) {
                    dist[i][j] = dist[i][k] + dist[k][j];
                }
            }
        }
    }
}
```

本质是动态规划：第 k 轮结束后，`dist[i][j]` 是只允许经过前 k 个顶点中转时的最短路。复杂度 O(V³)，适合顶点数在几百以内的稠密图。

### 4、怎么选

| 算法 | 问题 | 负权边 | 时间复杂度 | 适用 |
|------|------|--------|------------|------|
| BFS | 单源 | 仅无权图 | O(V + E) | 边权都相同 |
| Dijkstra（堆优化） | 单源 | 不支持 | O(E log V) | 非负权图，最常用 |
| Bellman-Ford | 单源 | 支持，能检测负环 | O(V × E) | 有负权边，或限制最多经过 k 条边（LeetCode 787） |
| SPFA | 单源 | 支持 | 平均较快，最坏 O(V × E) | 有负权边的稀疏图 |
| Floyd-Warshall | 全源 | 支持（不能有负环） | O(V³) | 顶点少，要求任意两点间距离 |

---

## 七、并查集（Union-Find）

并查集处理**动态连通性**：不断合并集合，并随时查询两个元素是否属于同一集合。每个集合用一棵树表示，根节点就是集合的代表元：

```java
class UnionFind {
    private final int[] parent, rank;
    private int count;                    // 当前集合个数

    UnionFind(int n) {
        parent = new int[n];
        rank = new int[n];
        count = n;
        for (int i = 0; i < n; i++) parent[i] = i;
    }

    int find(int x) {                     // 路径压缩：查找时让路径上的节点直接指向根
        if (parent[x] != x) parent[x] = find(parent[x]);
        return parent[x];
    }

    boolean union(int x, int y) {         // 按秩合并：矮树挂到高树下面
        int px = find(x), py = find(y);
        if (px == py) return false;       // 已经在同一集合
        if (rank[px] < rank[py]) { int t = px; px = py; py = t; }
        parent[py] = px;
        if (rank[px] == rank[py]) rank[px]++;
        count--;
        return true;
    }

    boolean connected(int x, int y) { return find(x) == find(y); }

    int count() { return count; }
}
```

同时使用路径压缩和按秩合并后，单次操作的均摊复杂度为 O(α(n))。α 是反阿克曼函数，增长极慢，在任何实际数据规模下都不超过 4，可视为常数。`union` 返回 `false` 意味着两点本来就连通，再加这条边就会成环，这正是 LeetCode 684「冗余连接」的解法。

---

## 八、最小生成树

连通无向带权图的**最小生成树**是连接所有顶点、边权总和最小的树，恰好有 V − 1 条边。

**Kruskal 算法**：把所有边按权重从小到大排序，依次尝试加入；用并查集判断，加入这条边不会成环（两端不在同一集合）就保留：

```java
// edges[i] = [u, v, w]；图不连通时返回 -1
long kruskal(int n, int[][] edges) {
    int[][] sorted = edges.clone();
    Arrays.sort(sorted, Comparator.comparingInt(e -> e[2]));
    UnionFind uf = new UnionFind(n);
    long total = 0;
    int used = 0;
    for (int[] e : sorted) {
        if (uf.union(e[0], e[1])) {
            total += e[2];
            if (++used == n - 1) return total;
        }
    }
    return n <= 1 ? 0 : -1;
}
```

复杂度由排序决定，O(E log E)，适合稀疏图。**Prim 算法**则从一个顶点出发，每次用优先队列取出连接「已选集合」与「未选集合」的最短边，思路和 Dijkstra 很像，适合稠密图。

---

## 九、经典题目

| 题目 | 考点 |
|------|------|
| LeetCode 200 岛屿数量 | DFS / BFS / 并查集 |
| LeetCode 1091 二进制矩阵中的最短路径 | 网格 BFS |
| LeetCode 207 课程表 | 拓扑排序判环 |
| LeetCode 210 课程表 II | 拓扑排序输出顺序 |
| LeetCode 743 网络延迟时间 | Dijkstra |
| LeetCode 787 K 站中转内最便宜的航班 | Bellman-Ford 限制轮数 |
| LeetCode 547 省份数量 | 并查集 / DFS |
| LeetCode 684 冗余连接 | 并查集判环 |
| LeetCode 1584 连接所有点的最小费用 | Kruskal / Prim |

---

## 小结

- 稀疏图用邻接表，空间 O(V + E)；顶点少且要频繁查边时用邻接矩阵
- BFS 求无权图最短路，入队时就标记已访问；DFS 递归过深会栈溢出，大网格改用 BFS 或显式栈
- 拓扑排序有 Kahn（入度）和 DFS 三色标记两种写法，都能顺带判环
- Dijkstra 只适用于非负权，懒删除需要 `if (d > dist[u]) continue`；有负权用 Bellman-Ford，第 V 轮仍能松弛说明有负环；全源最短路用 Floyd
- 并查集用路径压缩 + 按秩合并，均摊 O(α(n))；Kruskal = 边排序 + 并查集

## 参考资料

- Hello 算法 · 图：[https://www.hello-algo.com/chapter_graph/](https://www.hello-algo.com/chapter_graph/)
- OI Wiki · 最短路：[https://oi-wiki.org/graph/shortest-path/](https://oi-wiki.org/graph/shortest-path/)
- OI Wiki · 并查集：[https://oi-wiki.org/ds/dsu/](https://oi-wiki.org/ds/dsu/)
- OI Wiki · 最小生成树：[https://oi-wiki.org/graph/mst/](https://oi-wiki.org/graph/mst/)

> 下一篇：[字典树（Trie）](./6_trie) —— 前缀树结构、数组与 Map 实现、前缀统计、二进制 Trie 最大异或。
