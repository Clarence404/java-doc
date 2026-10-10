---
description: 回溯框架、排列 / 组合 / 子集、去重剪枝、N 皇后、网格 DFS、复杂度
---

# 回溯算法

> 前置阅读：[搜索算法](./0_search)

回溯是在 DFS 中「做选择 → 递归 → 撤销选择」地枚举所有解。本篇讲回溯框架、排列 / 组合 / 子集模板及去重、N 皇后与网格 DFS，以及回溯的复杂度估算。

---

## 一、回溯思想

回溯（Backtracking）是在**决策树**上做深度优先搜索：每一层做一个选择，走到底（找到解或无路可走）就退回上一层，撤销刚才的选择，换下一个选项继续试。

本质是**枚举所有路径**，再用剪枝砍掉不可能产生解的分支。下图是 `[1, 2, 3]` 全排列的决策树：每个节点是当前路径，每条边是一次选择，叶子就是一个排列。

![全排列 [1,2,3] 的回溯决策树](../../assets/algorithms/backtrack_permutation_tree.svg)

---

## 二、通用框架

```text
result = []
backtrack(路径, 选择列表):
    if 满足结束条件:
        result.add(路径的拷贝)
        return
    for 选择 in 选择列表:
        if 选择不合法: continue        // 剪枝
        做选择：路径.add(选择)
        backtrack(路径, 新的选择列表)
        撤销选择：路径.removeLast()
```

两个细节：

- **收集结果时要拷贝**：`result.add(new ArrayList<>(path))`。直接 `add(path)` 存进去的是同一个引用，回溯结束后它会被撤销成空列表
- **路径容器**：JDK 21 起 `List` 实现了 `SequencedCollection`，`ArrayList` 可以直接调用 `removeLast()`，比 `LinkedList` 更省内存、局部性更好

---

## 三、排列、组合与子集

三类问题的区别在于**下一层能选哪些元素**：

| 问题 | 下一层的选择范围 | 去重手段 |
|------|------------------|----------|
| 排列 | 所有未使用的元素（用 `used[]` 标记） | 排序 + 同层跳过相同值 |
| 组合 / 子集 | 当前元素之后的元素（传 `start`） | 排序 + 同层跳过相同值 |
| 可重复选的组合 | 当前元素及之后（递归传 `i` 而不是 `i + 1`） | — |

### 1、全排列

LeetCode 46 全排列（元素不重复）：

```java
List<List<Integer>> permute(int[] nums) {
    List<List<Integer>> res = new ArrayList<>();
    backtrack(nums, new boolean[nums.length], new ArrayList<>(), res);
    return res;
}

void backtrack(int[] nums, boolean[] used, List<Integer> path, List<List<Integer>> res) {
    if (path.size() == nums.length) {
        res.add(new ArrayList<>(path));
        return;
    }
    for (int i = 0; i < nums.length; i++) {
        if (used[i]) continue;
        used[i] = true;
        path.add(nums[i]);
        backtrack(nums, used, path, res);
        path.removeLast();
        used[i] = false;
    }
}
```

### 2、全排列 II（含重复元素）

LeetCode 47：数组里有重复数字，要求结果不重复。做法是**先排序**让相同的数相邻，再规定「相同的数必须按顺序使用」：前一个相同的数还没用时，跳过当前这个。

```java
List<List<Integer>> permuteUnique(int[] nums) {
    Arrays.sort(nums);                     // 必须先排序，下面的剪枝依赖相同值相邻
    List<List<Integer>> res = new ArrayList<>();
    backtrackUnique(nums, new boolean[nums.length], new ArrayList<>(), res);
    return res;
}

void backtrackUnique(int[] nums, boolean[] used, List<Integer> path, List<List<Integer>> res) {
    if (path.size() == nums.length) {
        res.add(new ArrayList<>(path));
        return;
    }
    for (int i = 0; i < nums.length; i++) {
        if (used[i]) continue;
        // 同一层里，值与前一个相同且前一个未被使用：说明前一个已经在这一层试过，跳过
        if (i > 0 && nums[i] == nums[i - 1] && !used[i - 1]) continue;
        used[i] = true;
        path.add(nums[i]);
        backtrackUnique(nums, used, path, res);
        path.removeLast();
        used[i] = false;
    }
}
```

漏掉 `Arrays.sort(nums)` 时，相同的数不相邻，`nums[i] == nums[i - 1]` 判断不到，结果里会出现重复排列。

### 3、组合

LeetCode 77：从 1..n 中选 k 个数。用 `start` 保证只往后选，避免 `[1,2]` 和 `[2,1]` 重复：

```java
List<List<Integer>> combine(int n, int k) {
    List<List<Integer>> res = new ArrayList<>();
    backtrack(n, k, 1, new ArrayList<>(), res);
    return res;
}

void backtrack(int n, int k, int start, List<Integer> path, List<List<Integer>> res) {
    if (path.size() == k) {
        res.add(new ArrayList<>(path));
        return;
    }
    // 剪枝：还需要 k - path.size() 个数，i 最大只能到 n - (k - path.size()) + 1
    for (int i = start; i <= n - (k - path.size()) + 1; i++) {
        path.add(i);
        backtrack(n, k, i + 1, path, res);
        path.removeLast();
    }
}
```

### 4、组合总和：可重复与去重

LeetCode 39 组合总和：元素不重复，**每个元素可以重复选**，所以递归传 `i` 而不是 `i + 1`。先排序后，一旦当前元素超过剩余目标值，后面更大的元素也不用试了：

```java
List<List<Integer>> combinationSum(int[] candidates, int target) {
    Arrays.sort(candidates);
    List<List<Integer>> res = new ArrayList<>();
    backtrackSum(candidates, target, 0, new ArrayList<>(), res);
    return res;
}

void backtrackSum(int[] c, int remain, int start, List<Integer> path, List<List<Integer>> res) {
    if (remain == 0) {
        res.add(new ArrayList<>(path));
        return;
    }
    for (int i = start; i < c.length && c[i] <= remain; i++) {   // 有序，超过 remain 直接停
        path.add(c[i]);
        backtrackSum(c, remain - c[i], i, path, res);            // 传 i：可以再选自己
        path.removeLast();
    }
}
```

LeetCode 40 组合总和 II 反过来：元素有重复、**每个只能用一次**。改动两处：递归传 `i + 1`；循环里加同层去重 `if (i > start && c[i] == c[i - 1]) continue;`。

### 5、子集

LeetCode 78：每个节点（不只是叶子）都是一个子集，进入函数就收集：

```java
List<List<Integer>> subsets(int[] nums) {
    List<List<Integer>> res = new ArrayList<>();
    backtrack(nums, 0, new ArrayList<>(), res);
    return res;
}

void backtrack(int[] nums, int start, List<Integer> path, List<List<Integer>> res) {
    res.add(new ArrayList<>(path));
    for (int i = start; i < nums.length; i++) {
        path.add(nums[i]);
        backtrack(nums, i + 1, path, res);
        path.removeLast();
    }
}
```

子集也能用位掩码枚举，见 [位运算](../3_patterns/4_bit_manipulation)。

---

## 四、N 皇后

LeetCode 51：在 n×n 棋盘上放 n 个皇后，任意两个不同行、不同列、不同斜线。逐行放置，所以行天然不冲突；列和两条斜线用布尔数组记录：

- 主对角线（左上到右下）上 `row - col` 相同，加 `n - 1` 后映射到 `[0, 2n-2]`
- 副对角线（右上到左下）上 `row + col` 相同，范围 `[0, 2n-2]`

```java
List<List<String>> solveNQueens(int n) {
    List<List<String>> res = new ArrayList<>();
    int[] queens = new int[n];                 // queens[row] = 该行皇后所在列
    backtrack(n, 0, queens, new boolean[n], new boolean[2 * n - 1], new boolean[2 * n - 1], res);
    return res;
}

void backtrack(int n, int row, int[] queens, boolean[] cols,
               boolean[] diag1, boolean[] diag2, List<List<String>> res) {
    if (row == n) {
        res.add(buildBoard(queens, n));
        return;
    }
    for (int col = 0; col < n; col++) {
        int d1 = row - col + n - 1, d2 = row + col;
        if (cols[col] || diag1[d1] || diag2[d2]) continue;
        queens[row] = col;
        cols[col] = diag1[d1] = diag2[d2] = true;
        backtrack(n, row + 1, queens, cols, diag1, diag2, res);
        cols[col] = diag1[d1] = diag2[d2] = false;
    }
}

List<String> buildBoard(int[] queens, int n) {
    List<String> board = new ArrayList<>(n);
    for (int col : queens) {
        char[] line = new char[n];
        Arrays.fill(line, '.');
        line[col] = 'Q';
        board.add(new String(line));
    }
    return board;
}
```

布尔数组比 `HashSet<Integer>` 少了装箱和哈希计算，判断冲突是 O(1) 的数组访问。

---

## 五、网格 DFS

网格题把每个格子看成图的节点，上下左右四个格子是邻居。根据目的不同，分成两种写法。

### 1、遍历型：岛屿数量

LeetCode 200：统计连通的 `'1'` 区域个数。每个格子**只访问一次**，访问后直接改成 `'0'` 当作标记，**不恢复**，复杂度 O(m·n)：

```java
private static final int[][] DIRS = {{0, 1}, {0, -1}, {1, 0}, {-1, 0}};

int numIslands(char[][] grid) {
    int count = 0;
    for (int r = 0; r < grid.length; r++) {
        for (int c = 0; c < grid[0].length; c++) {
            if (grid[r][c] == '1') {
                count++;
                sink(grid, r, c);              // 把整座岛淹掉
            }
        }
    }
    return count;
}

void sink(char[][] grid, int r, int c) {
    if (r < 0 || r >= grid.length || c < 0 || c >= grid[0].length || grid[r][c] != '1') return;
    grid[r][c] = '0';                          // 标记已访问，不恢复
    for (int[] d : DIRS) sink(grid, r + d[0], c + d[1]);
}
```

网格很大（比如 1000×1000 的全陆地）时递归深度可达 10^6，会栈溢出，改用 BFS 或显式栈。

### 2、回溯型：单词搜索

LeetCode 79：判断单词能否由相邻格子的字母连成，同一格子在一条路径里不能重复用。格子在**当前路径**上被占用，换一条路径时又要能用，所以返回时必须**恢复**：

```java
boolean exist(char[][] board, String word) {
    for (int r = 0; r < board.length; r++)
        for (int c = 0; c < board[0].length; c++)
            if (dfs(board, word, r, c, 0)) return true;
    return false;
}

boolean dfs(char[][] board, String word, int r, int c, int idx) {
    if (idx == word.length()) return true;
    if (r < 0 || r >= board.length || c < 0 || c >= board[0].length
            || board[r][c] != word.charAt(idx)) return false;
    char saved = board[r][c];
    board[r][c] = '#';                         // 占用
    boolean found = false;
    for (int[] d : DIRS) {
        if (dfs(board, word, r + d[0], c + d[1], idx + 1)) { found = true; break; }  // 找到即停
    }
    board[r][c] = saved;                       // 恢复，让其他路径可以使用
    return found;
}
```

两者的区别正是 [搜索算法](./0_search) 里说的遍历型 DFS 与回溯型 DFS：前者问「能到哪些格子」，后者问「有没有一条满足条件的路径」。

---

## 六、复杂度分析

回溯的时间复杂度 ≈ **决策树的节点数 × 每个节点的工作量**。收集结果时拷贝路径需要 O(n)，所以通常会多乘一个 n。

| 问题 | 解的个数 | 时间复杂度 | 说明 |
|------|----------|------------|------|
| 全排列 | n! | O(n · n!) | 每个排列拷贝 O(n) |
| 子集 | 2^n | O(n · 2^n) | 每个子集拷贝 O(n) |
| 组合 C(n, k) | C(n, k) | O(k · C(n, k)) | 每个组合拷贝 O(k) |
| N 皇后 | 远少于 n! | O(n!)（上界） | 第 i 行最多 n − i 个可选列 |
| 单词搜索 | — | O(m·n · 3^L) | L 为单词长度，除第一步外每步最多 3 个方向 |

空间复杂度主要是递归深度（O(n)）加上结果集本身。剪枝不改变最坏情况的量级，但能大幅减少实际访问的节点数。

---

## 七、剪枝技巧

| 剪枝类型 | 做法 | 例子 |
|---------|------|------|
| 可行性剪枝 | 当前状态已不可能产生合法解，直接返回 | N 皇后的列与斜线冲突 |
| 最优性剪枝 | 当前代价已不优于已知最优解，放弃 | 求最小代价时，当前代价 ≥ 最优值 |
| 排序后提前停止 | 排序后一旦超过目标，后面的更大元素也不用试 | 组合总和 `c[i] <= remain` |
| 同层去重 | 排序后同一层跳过相同的值 | 全排列 II、组合总和 II |
| 剩余数量剪枝 | 剩下的元素不够凑满时停止 | 组合的 `i <= n - (k - size) + 1` |
| 找到即停 | 只需判断存在性时，找到一个解就返回 | 单词搜索 |

---

## 小结

- 回溯 = 决策树上的 DFS：做选择、递归、撤销选择；收集结果时要拷贝路径
- 排列用 `used[]`，组合和子集用 `start`；可重复选时递归传 `i`，不可重复选时传 `i + 1`
- 含重复元素要去重：先排序，再在同一层跳过相同的值
- N 皇后用三个布尔数组记录列和两条对角线，下标分别是 `col`、`row - col + n - 1`、`row + col`
- 网格 DFS：岛屿类是遍历，标记不恢复；单词搜索类是回溯，返回时恢复
- 复杂度按「解的个数 × 拷贝代价」估算：排列 O(n · n!)、子集 O(n · 2^n)

## 参考资料

- OI Wiki 回溯法：[https://oi-wiki.org/search/backtracking/](https://oi-wiki.org/search/backtracking/)
- OI Wiki DFS（搜索）：[https://oi-wiki.org/search/dfs/](https://oi-wiki.org/search/dfs/)
- JEP 431 Sequenced Collections：[https://openjdk.org/jeps/431](https://openjdk.org/jeps/431)

> 下一篇：[贪心算法](./4_greedy) —— 贪心选择性质、区间调度、跳跃游戏、加油站、交换论证。
