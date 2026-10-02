---
description: 局部最优与适用条件
---

# 贪心算法

---

## 一、贪心思想

**贪心（Greedy）**：每步都选择当前看起来最优的选择，期望全局最优。

**适用条件：**
1. **贪心选择性质**：局部最优选择能导出全局最优
2. **最优子结构**：子问题的最优解构成全局最优

**与 DP 的区别：**
- 贪心：当前最优 → 下一步（不回头）
- DP：枚举所有子问题，选最优（可能回头查表）

贪心正确性通常需要**数学证明**（交换论证、归纳法），但面试中通常从直觉出发，验证不同例子。

---

## 二、经典问题

### 2.1 活动选择问题（区间调度）

从若干活动中选最多不重叠的活动，按**结束时间**升序贪心：

```java
int maxActivities(int[][] intervals) {
    // 按结束时间升序排列
    Arrays.sort(intervals, (a, b) -> a[1] - b[1]);
    int count = 1, end = intervals[0][1];
    for (int i = 1; i < intervals.length; i++) {
        if (intervals[i][0] >= end) { // 下一个活动不与当前重叠
            count++;
            end = intervals[i][1];
        }
    }
    return count;
}
```

### 2.2 跳跃游戏（LeetCode 55）

每个位置的值是最大跳跃距离，判断能否到达终点：

```java
boolean canJump(int[] nums) {
    int maxReach = 0; // 当前能到达的最远位置
    for (int i = 0; i < nums.length; i++) {
        if (i > maxReach) return false; // 当前位置不可达
        maxReach = Math.max(maxReach, i + nums[i]);
    }
    return true;
}
```

### 2.3 跳跃游戏 II（LeetCode 45，最少跳跃次数）

```java
int jump(int[] nums) {
    int jumps = 0, curEnd = 0, farthest = 0;
    for (int i = 0; i < nums.length - 1; i++) {
        farthest = Math.max(farthest, i + nums[i]);
        if (i == curEnd) { // 必须跳一次
            jumps++;
            curEnd = farthest;
        }
    }
    return jumps;
}
```

### 2.4 分发糖果（LeetCode 135）

相邻评分高的孩子必须比相邻评分低的孩子多糖，求最少总糖数：

```java
int candy(int[] ratings) {
    int n = ratings.length;
    int[] candies = new int[n];
    Arrays.fill(candies, 1); // 每人至少 1 颗

    // 从左到右：右边评分更高则多一颗
    for (int i = 1; i < n; i++)
        if (ratings[i] > ratings[i-1]) candies[i] = candies[i-1] + 1;

    // 从右到左：左边评分更高则取较大值
    for (int i = n - 2; i >= 0; i--)
        if (ratings[i] > ratings[i+1]) candies[i] = Math.max(candies[i], candies[i+1] + 1);

    return Arrays.stream(candies).sum();
}
```

### 2.5 加油站（LeetCode 134）

```java
int canCompleteCircuit(int[] gas, int[] cost) {
    int totalGas = 0, currentGas = 0, start = 0;
    for (int i = 0; i < gas.length; i++) {
        totalGas  += gas[i] - cost[i];
        currentGas += gas[i] - cost[i];
        if (currentGas < 0) { // 从 start 出发无法到达 i+1
            start = i + 1;    // 重置起点
            currentGas = 0;
        }
    }
    return totalGas >= 0 ? start : -1; // 总油量够则 start 是答案
}
```

### 2.6 买卖股票的最佳时机 II（LeetCode 122）

可多次交易，只要明天涨就今天买：

```java
int maxProfit(int[] prices) {
    int profit = 0;
    for (int i = 1; i < prices.length; i++)
        if (prices[i] > prices[i-1])
            profit += prices[i] - prices[i-1]; // 累加所有上涨收益
    return profit;
}
```

### 2.7 合并区间（LeetCode 56）

按起点排序，贪心合并重叠区间：

```java
int[][] merge(int[][] intervals) {
    Arrays.sort(intervals, (a, b) -> a[0] - b[0]);
    List<int[]> res = new ArrayList<>();
    res.add(intervals[0]);
    for (int i = 1; i < intervals.length; i++) {
        int[] last = res.get(res.size() - 1);
        if (intervals[i][0] <= last[1]) // 有重叠
            last[1] = Math.max(last[1], intervals[i][1]);
        else
            res.add(intervals[i]);
    }
    return res.toArray(new int[0][]);
}
```

### 2.8 任务调度器（LeetCode 621）

```java
int leastInterval(char[] tasks, int n) {
    int[] freq = new int[26];
    for (char t : tasks) freq[t - 'A']++;
    Arrays.sort(freq);
    int maxFreq = freq[25];
    int idleSlots = (maxFreq - 1) * n;
    for (int i = 24; i >= 0 && freq[i] > 0; i--)
        idleSlots -= Math.min(freq[i], maxFreq - 1);
    return tasks.length + Math.max(0, idleSlots);
}
```

---

## 三、贪心证明技巧

**交换论证（Exchange Argument）**：
假设存在一个最优解，如果它不采用贪心策略，那么可以将其中两个元素对调，使结果不变或更优，从而逐步转化为贪心解。

**反证法**：
假设贪心解不是最优的，推导出矛盾。

---

## 四、经典题目

| 题目 | 贪心策略 |
|------|---------|
| LeetCode 55 跳跃游戏 | 维护最远可达位置 |
| LeetCode 45 跳跃游戏 II | 在窗口内取最远 |
| LeetCode 56 合并区间 | 按起点排序合并 |
| LeetCode 135 分发糖果 | 两次扫描（左右各一次）|
| LeetCode 122 买卖股票 II | 累加所有正差值 |
| LeetCode 134 加油站 | 从无法到达处重置起点 |
| LeetCode 621 任务调度器 | 最高频任务决定冷却时间 |
| LeetCode 406 根据身高重建队列 | 按身高降序，k 值插入 |
