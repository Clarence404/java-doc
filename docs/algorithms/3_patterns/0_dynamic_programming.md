---
description: 一维 / 二维 DP、背包问题、区间 DP
---

# 动态规划

---

## 一、动态规划思想

**动态规划（Dynamic Programming，DP）**：将问题分解为**重叠子问题**，通过记录子问题的解（记忆化），避免重复计算。

### 1.1 两个核心性质

1. **最优子结构**：问题的最优解包含子问题的最优解
2. **重叠子问题**：同一子问题会被求解多次（区别于分治的独立子问题）

### 1.2 解题步骤

```
1. 定义状态：dp[i] 或 dp[i][j] 表示什么？
2. 初始化：确定边界值
3. 状态转移方程：dp[i] = f(dp[i-1], ...)
4. 遍历顺序：确保计算 dp[i] 时，所需的子状态已计算
5. 返回结果
```

---

## 二、一维 DP

### 2.1 斐波那契数列（记忆化 vs 递推）

```java
// 递推（自底向上）
int fib(int n) {
    if (n <= 1) return n;
    int[] dp = new int[n + 1];
    dp[0] = 0; dp[1] = 1;
    for (int i = 2; i <= n; i++)
        dp[i] = dp[i-1] + dp[i-2];
    return dp[n];
}

// 空间优化：只需保留前两个值
int fibOpt(int n) {
    if (n <= 1) return n;
    int a = 0, b = 1;
    for (int i = 2; i <= n; i++) { int c = a + b; a = b; b = c; }
    return b;
}
```

### 2.2 爬楼梯（LeetCode 70）

每次可爬 1 或 2 级，爬到 n 级有多少种方法？

```java
int climbStairs(int n) {
    if (n <= 2) return n;
    int a = 1, b = 2;
    for (int i = 3; i <= n; i++) { int c = a + b; a = b; b = c; }
    return b;
}
```

### 2.3 最大子数组和（Kadane 算法，LeetCode 53）

```java
int maxSubArray(int[] nums) {
    int dp = nums[0], ans = nums[0]; // dp[i] = 以 nums[i] 结尾的最大子数组和
    for (int i = 1; i < nums.length; i++) {
        dp = Math.max(nums[i], dp + nums[i]); // 要么自己开始新子数组，要么接在前面
        ans = Math.max(ans, dp);
    }
    return ans;
}
```

### 2.4 打家劫舍（LeetCode 198）

不能抢相邻房子，求最大金额：

```java
int rob(int[] nums) {
    int n = nums.length;
    if (n == 1) return nums[0];
    // dp[i] = 前 i 间房子能抢到的最大金额
    // dp[i] = max(dp[i-1], dp[i-2] + nums[i])
    int prev2 = nums[0], prev1 = Math.max(nums[0], nums[1]);
    for (int i = 2; i < n; i++) {
        int cur = Math.max(prev1, prev2 + nums[i]);
        prev2 = prev1;
        prev1 = cur;
    }
    return prev1;
}
```

---

## 三、二维 DP

### 3.1 最长公共子序列（LCS）

```java
int longestCommonSubsequence(String s1, String s2) {
    int m = s1.length(), n = s2.length();
    // dp[i][j] = s1[0..i-1] 与 s2[0..j-1] 的 LCS 长度
    int[][] dp = new int[m + 1][n + 1];
    for (int i = 1; i <= m; i++) {
        for (int j = 1; j <= n; j++) {
            if (s1.charAt(i-1) == s2.charAt(j-1))
                dp[i][j] = dp[i-1][j-1] + 1;
            else
                dp[i][j] = Math.max(dp[i-1][j], dp[i][j-1]);
        }
    }
    return dp[m][n];
}
```

### 3.2 编辑距离（LeetCode 72）

```java
int minDistance(String word1, String word2) {
    int m = word1.length(), n = word2.length();
    // dp[i][j] = word1[0..i-1] 转换为 word2[0..j-1] 的最小操作数
    int[][] dp = new int[m + 1][n + 1];
    for (int i = 0; i <= m; i++) dp[i][0] = i; // 删 i 次
    for (int j = 0; j <= n; j++) dp[0][j] = j; // 插 j 次

    for (int i = 1; i <= m; i++) {
        for (int j = 1; j <= n; j++) {
            if (word1.charAt(i-1) == word2.charAt(j-1))
                dp[i][j] = dp[i-1][j-1]; // 字符相同，不用操作
            else
                dp[i][j] = 1 + Math.min(dp[i-1][j-1],   // 替换
                               Math.min(dp[i-1][j],       // 删除
                                        dp[i][j-1]));     // 插入
        }
    }
    return dp[m][n];
}
```

### 3.3 不同路径（LeetCode 62）

```java
int uniquePaths(int m, int n) {
    int[][] dp = new int[m][n];
    Arrays.fill(dp[0], 1);              // 第一行只能向右走
    for (int i = 1; i < m; i++) dp[i][0] = 1; // 第一列只能向下走
    for (int i = 1; i < m; i++)
        for (int j = 1; j < n; j++)
            dp[i][j] = dp[i-1][j] + dp[i][j-1]; // 从上或从左来
    return dp[m-1][n-1];
}
```

---

## 四、背包问题

### 4.1 0-1 背包

每件物品只能取一次：

```java
int knapsack01(int[] weights, int[] values, int capacity) {
    int n = weights.length;
    // dp[j] = 容量为 j 时的最大价值
    int[] dp = new int[capacity + 1];
    for (int i = 0; i < n; i++)
        for (int j = capacity; j >= weights[i]; j--) // 逆序，防止重复选取
            dp[j] = Math.max(dp[j], dp[j - weights[i]] + values[i]);
    return dp[capacity];
}
```

### 4.2 完全背包（每件物品可取无限次）

```java
int knapsackUnbounded(int[] weights, int[] values, int capacity) {
    int[] dp = new int[capacity + 1];
    for (int i = 0; i < weights.length; i++)
        for (int j = weights[i]; j <= capacity; j++) // 正序，允许重复选
            dp[j] = Math.max(dp[j], dp[j - weights[i]] + values[i]);
    return dp[capacity];
}
```

### 4.3 分割等和子集（LeetCode 416）

转化为 0-1 背包：能否凑出 sum/2？

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

---

## 五、区间 DP

```java
// 戳气球（LeetCode 312）
int maxCoins(int[] nums) {
    int n = nums.length;
    int[] arr = new int[n + 2];
    arr[0] = arr[n + 1] = 1;
    for (int i = 0; i < n; i++) arr[i + 1] = nums[i];

    // dp[i][j] = 戳破 (i,j) 之间所有气球的最大金币（不含 i 和 j）
    int[][] dp = new int[n + 2][n + 2];
    for (int len = 2; len <= n + 1; len++) {       // 区间长度
        for (int i = 0; i <= n + 1 - len; i++) {
            int j = i + len;
            for (int k = i + 1; k < j; k++) {      // k 是最后被戳破的气球
                dp[i][j] = Math.max(dp[i][j],
                    dp[i][k] + arr[i] * arr[k] * arr[j] + dp[k][j]);
            }
        }
    }
    return dp[0][n + 1];
}
```

---

## 六、经典题目

| 题目 | 类型 |
|------|------|
| LeetCode 70 爬楼梯 | 一维 DP |
| LeetCode 53 最大子数组和 | Kadane |
| LeetCode 198 打家劫舍 | 一维 DP |
| LeetCode 300 最长递增子序列 | 一维 DP / 二分 |
| LeetCode 1143 最长公共子序列 | 二维 DP |
| LeetCode 72 编辑距离 | 二维 DP |
| LeetCode 416 分割等和子集 | 0-1 背包 |
| LeetCode 322 零钱兑换 | 完全背包 |
| LeetCode 312 戳气球 | 区间 DP |
| LeetCode 10 正则表达式匹配 | 二维 DP |
