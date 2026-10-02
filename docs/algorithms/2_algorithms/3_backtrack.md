---
description: 排列、组合、剪枝
---

# 回溯算法

---

## 一、回溯思想

回溯（Backtracking）是一种通过**试探**来搜索所有可能解的算法：
- 每次选择一个选项
- 递归进入下一层
- 若当前路径不满足条件（剪枝）或已到达终止条件，则**撤销**当前选择，回退到上一层继续尝试

**本质**：枚举决策树上的所有路径，在搜索过程中剪枝。

---

## 二、通用框架

```java
List<List<Integer>> result = new ArrayList<>();
LinkedList<Integer> path = new LinkedList<>();

void backtrack(选择列表, 状态) {
    if (满足结束条件) {
        result.add(new ArrayList<>(path)); // 收集结果
        return;
    }

    for (选择 : 选择列表) {
        if (不合法 || 已访问) continue; // 剪枝

        path.add(选择);           // 做选择
        backtrack(更新后的选择列表, 更新后的状态);
        path.removeLast();        // 撤销选择（回溯）
    }
}
```

---

## 三、经典问题

### 3.1 全排列（无重复元素）

```java
List<List<Integer>> permute(int[] nums) {
    List<List<Integer>> res = new ArrayList<>();
    boolean[] used = new boolean[nums.length];
    backtrack(nums, used, new LinkedList<>(), res);
    return res;
}

void backtrack(int[] nums, boolean[] used, LinkedList<Integer> path,
               List<List<Integer>> res) {
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

### 3.2 全排列 II（含重复元素）

```java
void backtrack(int[] nums, boolean[] used, LinkedList<Integer> path,
               List<List<Integer>> res) {
    if (path.size() == nums.length) { res.add(new ArrayList<>(path)); return; }
    for (int i = 0; i < nums.length; i++) {
        if (used[i]) continue;
        // 剪枝：相同数字，必须先用前一个（保证顺序，避免重复结果）
        if (i > 0 && nums[i] == nums[i-1] && !used[i-1]) continue;
        used[i] = true;
        path.add(nums[i]);
        backtrack(nums, used, path, res);
        path.removeLast();
        used[i] = false;
    }
}
```

### 3.3 组合（从 n 个数中选 k 个）

```java
List<List<Integer>> combine(int n, int k) {
    List<List<Integer>> res = new ArrayList<>();
    backtrack(n, k, 1, new LinkedList<>(), res);
    return res;
}

void backtrack(int n, int k, int start, LinkedList<Integer> path,
               List<List<Integer>> res) {
    if (path.size() == k) { res.add(new ArrayList<>(path)); return; }
    // 剪枝：剩余数字不足以凑成 k 个时提前停止
    for (int i = start; i <= n - (k - path.size()) + 1; i++) {
        path.add(i);
        backtrack(n, k, i + 1, path, res);
        path.removeLast();
    }
}
```

### 3.4 子集

```java
List<List<Integer>> subsets(int[] nums) {
    List<List<Integer>> res = new ArrayList<>();
    backtrack(nums, 0, new LinkedList<>(), res);
    return res;
}

void backtrack(int[] nums, int start, LinkedList<Integer> path,
               List<List<Integer>> res) {
    res.add(new ArrayList<>(path)); // 每个状态都是一个子集
    for (int i = start; i < nums.length; i++) {
        path.add(nums[i]);
        backtrack(nums, i + 1, path, res);
        path.removeLast();
    }
}
```

### 3.5 N 皇后

```java
List<List<String>> solveNQueens(int n) {
    List<List<String>> res = new ArrayList<>();
    int[] queens = new int[n]; // queens[i] = 第 i 行皇后的列
    Arrays.fill(queens, -1);
    Set<Integer> cols = new HashSet<>(), diag1 = new HashSet<>(), diag2 = new HashSet<>();
    backtrack(n, 0, queens, cols, diag1, diag2, res);
    return res;
}

void backtrack(int n, int row, int[] queens,
               Set<Integer> cols, Set<Integer> diag1, Set<Integer> diag2,
               List<List<String>> res) {
    if (row == n) { res.add(buildBoard(queens, n)); return; }
    for (int col = 0; col < n; col++) {
        if (cols.contains(col) || diag1.contains(row - col)
                               || diag2.contains(row + col)) continue;
        queens[row] = col;
        cols.add(col); diag1.add(row - col); diag2.add(row + col);
        backtrack(n, row + 1, queens, cols, diag1, diag2, res);
        queens[row] = -1;
        cols.remove(col); diag1.remove(row - col); diag2.remove(row + col);
    }
}
```

### 3.6 单词搜索（矩阵 DFS）

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
    char tmp = board[r][c];
    board[r][c] = '#'; // 标记已用
    boolean found = dfs(board, word, r+1, c, idx+1)
                 || dfs(board, word, r-1, c, idx+1)
                 || dfs(board, word, r, c+1, idx+1)
                 || dfs(board, word, r, c-1, idx+1);
    board[r][c] = tmp; // 回溯
    return found;
}
```

---

## 四、剪枝技巧

| 剪枝类型 | 说明 |
|---------|------|
| 可行性剪枝 | 当前状态已不可能产生合法解，提前返回 |
| 最优性剪枝 | 当前路径已不可能优于已找到的最优解，放弃 |
| 重复剪枝 | 对有序数组跳过相同元素，避免重复结果 |
| 提前终止 | 找到一个解就立即返回（如单词搜索）|

---

## 五、经典题目

| 题目 | 考点 |
|------|------|
| LeetCode 46 全排列 | 基础回溯 |
| LeetCode 47 全排列 II | 去重剪枝 |
| LeetCode 77 组合 | 组合回溯 |
| LeetCode 39 组合总和 | 可重复选取 |
| LeetCode 78 子集 | 子集枚举 |
| LeetCode 51 N 皇后 | 约束回溯 |
| LeetCode 37 解数独 | 复杂约束回溯 |
| LeetCode 79 单词搜索 | 矩阵 DFS 回溯 |
