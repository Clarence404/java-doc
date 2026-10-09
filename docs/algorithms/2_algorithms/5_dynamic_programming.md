---
description: 记忆化与递推、一维 / 二维 DP、LIS、背包问题、区间 DP、空间压缩
---

# 动态规划

> **本篇目标**：按「状态、初始值、转移、顺序」四步写出 DP，分清记忆化搜索与递推，掌握最大子数组和、LIS、LCS、编辑距离、0-1 / 完全背包、区间 DP，并会用滚动数组压缩空间。
>
> **前置阅读**：[分治算法](./2_divide_conquer)、[贪心算法](./4_greedy)

---

## 一、动态规划思想

**动态规划（Dynamic Programming，DP）**：把问题拆成**互相重叠**的子问题，每个子问题只算一次并把结果存下来，后面直接查表。

### 1、两个前提

- **最优子结构**：原问题的最优解可以由子问题的最优解推出
- **重叠子问题**：同一个子问题会被多次用到。子问题互不重叠时用 [分治算法](./2_divide_conquer) 就够了，不需要缓存

### 2、解题步骤

1. **定义状态**：`dp[i]` 或 `dp[i][j]` 具体表示什么，这一步写清楚，后面的转移才不会错
2. **初始化**：边界状态的值（`dp[0]`、第一行、第一列等）
3. **状态转移**：`dp[i]` 如何由更小的状态得到
4. **遍历顺序**：保证计算 `dp[i]` 时，它依赖的状态已经算好
5. **返回结果**：答案是 `dp[n]`、`dp[m][n]`，还是所有状态里的最大值

---

## 二、记忆化搜索与递推

同一个 DP 有两种写法，以斐波那契数（LeetCode 509）为例。直接递归 `fib(n-1) + fib(n-2)` 会重复计算同一个子问题，复杂度是指数级。

**记忆化搜索（自顶向下）**：保留递归写法，算过的结果存进 `memo`：

```java
long[] memo;

long fib(int n) {
    memo = new long[n + 1];
    return fibMemo(n);
}

long fibMemo(int n) {
    if (n <= 1) return n;
    if (memo[n] != 0) return memo[n];          // 已经算过（n >= 2 时 fib(n) > 0）
    return memo[n] = fibMemo(n - 1) + fibMemo(n - 2);
}
```

**递推（自底向上）**：从小到大填表；`dp[i]` 只依赖前两项，可以只用两个变量：

```java
long fibIter(int n) {
    if (n <= 1) return n;
    long a = 0, b = 1;
    for (int i = 2; i <= n; i++) {
        long c = a + b;
        a = b;
        b = c;
    }
    return b;
}
```

| | 记忆化搜索 | 递推 |
|--|-----------|------|
| 写法 | 递归 + 缓存，贴近转移方程 | 循环填表，要自己安排顺序 |
| 计算的状态 | 只算用得到的状态 | 通常算出全部状态 |
| 风险 | 递归太深会栈溢出 | 无递归开销 |
| 空间压缩 | 不方便 | 容易用滚动数组 |

斐波那契增长很快：`int` 在 n = 47 时溢出，`long` 在 n = 93 时溢出。LeetCode 509 的 n ≤ 30，`int` 足够；数据范围更大的题目一般要求对 10^9 + 7 取模，在每次加法后取模即可。

---

## 三、一维 DP

### 1、爬楼梯

LeetCode 70 爬楼梯：每次爬 1 或 2 级。到第 i 级的最后一步要么从 i−1 来，要么从 i−2 来，所以 `dp[i] = dp[i-1] + dp[i-2]`：

```java
int climbStairs(int n) {
    if (n <= 2) return n;
    int a = 1, b = 2;                          // dp[1], dp[2]
    for (int i = 3; i <= n; i++) {
        int c = a + b;
        a = b;
        b = c;
    }
    return b;
}
```

### 2、最大子数组和

LeetCode 53 最大子数组和（Kadane 算法）：`dp[i]` = **以 `nums[i]` 结尾**的最大子数组和。要么接在前面的子数组后面，要么从自己重新开始：

```java
int maxSubArray(int[] nums) {
    int cur = nums[0], best = nums[0];         // cur 即 dp[i]
    for (int i = 1; i < nums.length; i++) {
        cur = Math.max(nums[i], cur + nums[i]);
        best = Math.max(best, cur);
    }
    return best;
}
```

时间 O(n)、空间 O(1)。这题的分治解法是 O(n log n)，见 [分治算法](./2_divide_conquer)。

### 3、打家劫舍

LeetCode 198 打家劫舍：不能抢相邻的两间房。`dp[i]` = 只考虑**下标 0..i 的房子**时能抢到的最大金额，第 i 间要么不抢（`dp[i-1]`），要么抢（`dp[i-2] + nums[i]`）：

```java
int rob(int[] nums) {
    int n = nums.length;
    if (n == 1) return nums[0];
    int prev2 = nums[0];                       // dp[0]
    int prev1 = Math.max(nums[0], nums[1]);    // dp[1]
    for (int i = 2; i < n; i++) {
        int cur = Math.max(prev1, prev2 + nums[i]);
        prev2 = prev1;
        prev1 = cur;
    }
    return prev1;
}
```

### 4、最长递增子序列

LeetCode 300 最长递增子序列（LIS）。

**O(n²) 写法**：`dp[i]` = 以 `nums[i]` 结尾的 LIS 长度，`dp[i] = max(dp[j] + 1)`，其中 `j < i` 且 `nums[j] < nums[i]`。

**O(n log n) 写法**：维护数组 `tails`，`tails[k]` 是「长度为 k + 1 的递增子序列的最小结尾值」。`tails` 一定严格递增，所以每来一个数，用二分找第一个 `>= x` 的位置替换它；如果 x 比所有结尾都大，就把序列延长一位：

```java
int lengthOfLIS(int[] nums) {
    int[] tails = new int[nums.length];
    int len = 0;
    for (int x : nums) {
        int lo = 0, hi = len;                  // 在 tails[0..len) 中找第一个 >= x 的位置
        while (lo < hi) {
            int mid = lo + (hi - lo) / 2;
            if (tails[mid] < x) lo = mid + 1;
            else hi = mid;
        }
        tails[lo] = x;                         // 用更小的结尾替换，给后面留更多空间
        if (lo == len) len++;
    }
    return len;
}
```

注意 `tails` 本身不一定是一个真实的递增子序列，它只保证长度正确。二分写法见 [搜索算法](./0_search) 的左边界一节。

---

## 四、二维 DP

### 1、最长公共子序列

LeetCode 1143 最长公共子序列（LCS）：`dp[i][j]` = `s1` 前 i 个字符与 `s2` 前 j 个字符的 LCS 长度。多开一行一列表示空串，省去边界判断：

```java
int longestCommonSubsequence(String s1, String s2) {
    int m = s1.length(), n = s2.length();
    int[][] dp = new int[m + 1][n + 1];
    for (int i = 1; i <= m; i++) {
        for (int j = 1; j <= n; j++) {
            if (s1.charAt(i - 1) == s2.charAt(j - 1)) dp[i][j] = dp[i - 1][j - 1] + 1;
            else dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
        }
    }
    return dp[m][n];
}
```

### 2、编辑距离

LeetCode 72 编辑距离：`dp[i][j]` = `word1` 前 i 个字符变成 `word2` 前 j 个字符的最少操作数。字符相同时不用操作；不同时取替换、删除、插入三者的最小值加 1：

```java
int minDistance(String word1, String word2) {
    int m = word1.length(), n = word2.length();
    int[][] dp = new int[m + 1][n + 1];
    for (int i = 0; i <= m; i++) dp[i][0] = i;   // 删掉 i 个字符
    for (int j = 0; j <= n; j++) dp[0][j] = j;   // 插入 j 个字符
    for (int i = 1; i <= m; i++) {
        for (int j = 1; j <= n; j++) {
            if (word1.charAt(i - 1) == word2.charAt(j - 1)) {
                dp[i][j] = dp[i - 1][j - 1];
            } else {
                dp[i][j] = 1 + Math.min(dp[i - 1][j - 1],              // 替换
                               Math.min(dp[i - 1][j], dp[i][j - 1]));   // 删除 / 插入
            }
        }
    }
    return dp[m][n];
}
```

### 3、不同路径

LeetCode 62 不同路径：只能向右或向下走，`dp[i][j] = dp[i-1][j] + dp[i][j-1]`，第一行和第一列都是 1。下一节用它演示空间压缩。

---

## 五、空间压缩

很多二维 DP 的第 i 行只依赖第 i−1 行（甚至只依赖同一行左边的值），这时不必保留整张表，只用一行反复覆盖，这叫**滚动数组**，空间从 O(m·n) 降到 O(n)。

不同路径的一维写法：`dp[j]` 在被覆盖前存的是「上一行」的值，`dp[j - 1]` 已经被更新为「本行」的值：

```java
int uniquePaths(int m, int n) {
    int[] dp = new int[n];
    Arrays.fill(dp, 1);                        // 第一行全是 1
    for (int i = 1; i < m; i++)
        for (int j = 1; j < n; j++)
            dp[j] += dp[j - 1];                // 上方 + 左方
    return dp[n - 1];
}
```

压缩时要看依赖的是「旧值」还是「新值」，这决定了内层循环的方向：

- 只依赖上方和左方（不同路径）：正序遍历即可
- 还依赖左上方 `dp[i-1][j-1]`（LCS、编辑距离）：正序遍历时左上方已被覆盖，要先用一个临时变量保存
- 0-1 背包依赖上一行左侧的旧值，所以要**倒序**，见下一节

---

## 六、背包问题

### 1、0-1 背包

每件物品最多选一次。二维定义是 `dp[i][j]` = 前 i 件物品、容量 j 时的最大价值；压缩成一维后，`dp[j - w]` 必须还是「上一件物品」时的旧值，所以容量**从大到小**遍历：

```java
int knapsack01(int[] weights, int[] values, int capacity) {
    int[] dp = new int[capacity + 1];          // dp[j] = 容量为 j 时的最大价值
    for (int i = 0; i < weights.length; i++)
        for (int j = capacity; j >= weights[i]; j--)   // 倒序：每件物品只用一次
            dp[j] = Math.max(dp[j], dp[j - weights[i]] + values[i]);
    return dp[capacity];
}
```

LeetCode 416 分割等和子集可以转化成 0-1 背包：能否从数组里选出一些数，和恰好为 `sum / 2`：

```java
boolean canPartition(int[] nums) {
    int sum = Arrays.stream(nums).sum();
    if (sum % 2 != 0) return false;
    int target = sum / 2;
    boolean[] dp = new boolean[target + 1];
    dp[0] = true;
    for (int num : nums)
        for (int j = target; j >= num; j--)
            dp[j] = dp[j] || dp[j - num];
    return dp[target];
}
```

### 2、完全背包

每件物品可以选无限次。容量**从小到大**遍历，这样 `dp[j - w]` 可能已经包含了当前物品，相当于允许重复选：

```java
int knapsackUnbounded(int[] weights, int[] values, int capacity) {
    int[] dp = new int[capacity + 1];
    for (int i = 0; i < weights.length; i++)
        for (int j = weights[i]; j <= capacity; j++)   // 正序：允许重复选
            dp[j] = Math.max(dp[j], dp[j - weights[i]] + values[i]);
    return dp[capacity];
}
```

LeetCode 322 零钱兑换：求凑出金额的**最少**硬币数，是求最小值的完全背包。初始值要设成「不可达」：用 `amount + 1` 表示无穷大（硬币数不可能超过 amount），比 `Integer.MAX_VALUE` 安全，`+ 1` 后不会溢出：

```java
int coinChange(int[] coins, int amount) {
    int inf = amount + 1;
    int[] dp = new int[amount + 1];
    Arrays.fill(dp, inf);
    dp[0] = 0;                                 // 凑 0 元需要 0 枚
    for (int coin : coins)
        for (int j = coin; j <= amount; j++)
            dp[j] = Math.min(dp[j], dp[j - coin] + 1);
    return dp[amount] == inf ? -1 : dp[amount];
}
```

| | 0-1 背包 | 完全背包 |
|--|---------|---------|
| 每件物品 | 最多一次 | 无限次 |
| 一维写法的容量循环 | 倒序 | 正序 |
| 典型题 | LeetCode 416 分割等和子集 | LeetCode 322 零钱兑换 |

---

## 七、区间 DP

区间 DP 的状态是一段区间 `dp[i][j]`，由更短的区间合并而来，所以**按区间长度从小到大**遍历。

LeetCode 312 戳气球：在两端补上值为 1 的虚拟气球。`dp[i][j]` = 戳破开区间 `(i, j)` 内所有气球能得到的最多硬币。枚举 `(i, j)` 里**最后一个**被戳破的气球 k：此时它的左右邻居正好是 i 和 j，左右两段互不影响：

```java
int maxCoins(int[] nums) {
    int n = nums.length;
    int[] arr = new int[n + 2];
    arr[0] = arr[n + 1] = 1;
    System.arraycopy(nums, 0, arr, 1, n);
    int[][] dp = new int[n + 2][n + 2];
    for (int len = 2; len <= n + 1; len++) {           // 区间长度 j - i
        for (int i = 0; i + len <= n + 1; i++) {
            int j = i + len;
            for (int k = i + 1; k < j; k++) {          // k 是 (i, j) 内最后戳破的气球
                dp[i][j] = Math.max(dp[i][j],
                        dp[i][k] + arr[i] * arr[k] * arr[j] + dp[k][j]);
            }
        }
    }
    return dp[0][n + 1];
}
```

时间 O(n³)。「枚举最后一步」是区间 DP 的常见切入点：如果枚举第一个被戳破的气球，它的邻居在之后会变化，子问题就不独立了。

---

## 小结

- DP 四步：定义状态、初始化、转移、遍历顺序；状态定义要精确到「下标 0..i」还是「前 i 个」
- 记忆化搜索与递推等价，前者贴近递归思路，后者便于压缩空间
- 最大子数组和 `dp[i]` 以 `nums[i]` 结尾；LIS 的 O(n log n) 写法维护「各长度的最小结尾」并二分
- 滚动数组：只依赖上一行时压成一维，注意依赖的是旧值还是新值
- 0-1 背包容量倒序，完全背包正序；求最小值时用 `amount + 1` 之类的安全无穷大
- 区间 DP 按长度从小到大遍历，常枚举「最后一步」

## 参考资料

- OI Wiki 动态规划基础：[https://oi-wiki.org/dp/basic/](https://oi-wiki.org/dp/basic/)
- OI Wiki 记忆化搜索：[https://oi-wiki.org/dp/memo/](https://oi-wiki.org/dp/memo/)
- OI Wiki 背包 DP：[https://oi-wiki.org/dp/knapsack/](https://oi-wiki.org/dp/knapsack/)
- OI Wiki 区间 DP：[https://oi-wiki.org/dp/interval/](https://oi-wiki.org/dp/interval/)

> 下一篇：[双指针](../3_patterns/1_two_pointers) —— 对撞指针、快慢指针、Floyd 判圈与入口证明、固定间距指针。
