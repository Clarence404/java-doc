---
description: 贪心选择性质、区间调度与交换论证、跳跃游戏、加油站、根据身高重建队列
---

# 贪心算法

> **本篇目标**：理解贪心成立的两个条件，会用交换论证说明「按结束时间排序」为什么正确，掌握区间调度、跳跃游戏、加油站等经典贪心题，并会写不溢出的比较器。
>
> **前置阅读**：[排序算法](./1_sort)、[分治算法](./2_divide_conquer)（分治、动态规划与贪心的对比）

---

## 一、贪心思想

**贪心（Greedy）**：每一步都做当前看起来最优的选择，并且不再回头修改。

贪心能得到全局最优，需要同时满足两个条件：

1. **贪心选择性质**：存在一个最优解，它的第一步就是贪心选择
2. **最优子结构**：做出贪心选择后，剩下的子问题的最优解与这一步合起来，就是原问题的最优解

和动态规划的区别：动态规划在每一步枚举所有选择、比较子问题的结果再取最优；贪心只看当前，每步只留下一个子问题。贪心更快，但只在上面两个条件成立时正确，所以每道贪心题都应该能说出「为什么这样选不会错」，下面第二节用区间调度演示怎么证明。

---

## 二、区间调度与交换论证

### 1、最多不重叠区间

给定若干区间，最多能选出多少个互不重叠的区间？贪心策略：**按结束时间升序，能选就选**。

```java
int maxNonOverlapping(int[][] intervals) {
    if (intervals.length == 0) return 0;
    Arrays.sort(intervals, Comparator.comparingInt(a -> a[1]));   // 按结束时间升序
    int count = 1, end = intervals[0][1];
    for (int i = 1; i < intervals.length; i++) {
        if (intervals[i][0] >= end) {          // 与上一个选中的区间不重叠
            count++;
            end = intervals[i][1];
        }
    }
    return count;
}
```

对应题目：

- LeetCode 435 无重叠区间：求最少删除几个区间才能不重叠，答案是 `n - maxNonOverlapping(intervals)`
- LeetCode 452 用最少数量的箭引爆气球：端点相接也算重叠，判断条件改成 `intervals[i][0] > end`，箭数等于选出的区间数

![按结束时间排序的区间调度](../../assets/algorithms/interval_scheduling.svg)

### 2、为什么按结束时间排序是对的

用**交换论证**：设贪心选出的第一个区间是 g（所有区间里结束最早的）。任取一个最优解 O，设其中结束最早的区间是 o。

- 因为 g 是全局结束最早的，`g.end <= o.end`
- 把 O 里的 o 换成 g：g 结束得不晚于 o，所以不会与 O 中后面的区间重叠，替换后仍是合法解，且区间个数不变
- 于是存在一个以 g 开头的最优解（贪心选择性质）。去掉 g 及与它重叠的区间后，剩下的问题是同类的更小问题，对它继续同样的论证即可

反过来，「按开始时间排序」或「按区间长度排序」都能找到反例：一个很早开始、很晚结束的长区间会挡住中间多个短区间。

### 3、比较器不要用减法

`(a, b) -> a[1] - b[1]` 在两个值异号且绝对值很大时会溢出。LeetCode 452 的端点范围就是 `[-2^31, 2^31 - 1]`：`Integer.MAX_VALUE - (-1)` 溢出成负数，排序结果错误。统一用：

- `Comparator.comparingInt(a -> a[1])`
- 或 `(a, b) -> Integer.compare(a[1], b[1])`

---

## 三、经典问题

### 1、跳跃游戏

LeetCode 55 跳跃游戏：每个位置的值是能跳的最大距离，判断能否到达最后一个位置。维护当前能到达的最远位置：

```java
boolean canJump(int[] nums) {
    int maxReach = 0;
    for (int i = 0; i < nums.length; i++) {
        if (i > maxReach) return false;        // 当前位置已不可达
        maxReach = Math.max(maxReach, i + nums[i]);
    }
    return true;
}
```

### 2、跳跃游戏 II

LeetCode 45 跳跃游戏 II：求到达终点的最少跳跃次数。把「当前这一跳能覆盖的范围」看成一层，走到这层边界时必须再跳一次，下一层的边界是这层里能到达的最远位置（相当于隐式的 BFS）：

```java
int jump(int[] nums) {
    int jumps = 0, curEnd = 0, farthest = 0;
    for (int i = 0; i < nums.length - 1; i++) {
        farthest = Math.max(farthest, i + nums[i]);
        if (i == curEnd) {                     // 走到本层边界，必须再跳一次
            jumps++;
            curEnd = farthest;
        }
    }
    return jumps;
}
```

### 3、分发糖果

LeetCode 135 分发糖果：评分比相邻孩子高的必须多拿糖，求最少总数。左右两个方向的约束分开处理，各扫一遍：

```java
int candy(int[] ratings) {
    int n = ratings.length;
    int[] candies = new int[n];
    Arrays.fill(candies, 1);
    for (int i = 1; i < n; i++)                // 满足「比左边高则多拿」
        if (ratings[i] > ratings[i - 1]) candies[i] = candies[i - 1] + 1;
    for (int i = n - 2; i >= 0; i--)           // 满足「比右边高则多拿」，并保留左边的约束
        if (ratings[i] > ratings[i + 1]) candies[i] = Math.max(candies[i], candies[i + 1] + 1);
    return Arrays.stream(candies).sum();
}
```

### 4、加油站

LeetCode 134 加油站：环路上每站加油 `gas[i]`、开到下一站耗油 `cost[i]`，求能绕一圈的起点。两个结论：

- 总油量 ≥ 总耗油量时一定有解
- 从 `start` 出发到 `i` 时油量变负，那么 `start..i` 之间任何一站出发也到不了 `i + 1`（它们出发时油量都不比从 `start` 一路开过来时多），所以下一个候选起点直接跳到 `i + 1`

```java
int canCompleteCircuit(int[] gas, int[] cost) {
    int total = 0, tank = 0, start = 0;
    for (int i = 0; i < gas.length; i++) {
        total += gas[i] - cost[i];
        tank  += gas[i] - cost[i];
        if (tank < 0) {                        // 从 start 到不了 i + 1
            start = i + 1;
            tank = 0;
        }
    }
    return total >= 0 ? start : -1;
}
```

### 5、买卖股票的最佳时机 II

LeetCode 122：可以多次买卖（同一时间最多持有一股），把所有上涨的差价都吃下就是最大利润：

```java
int maxProfit(int[] prices) {
    int profit = 0;
    for (int i = 1; i < prices.length; i++)
        profit += Math.max(0, prices[i] - prices[i - 1]);
    return profit;
}
```

### 6、合并区间

LeetCode 56 合并区间：按**开始时间**排序，和结果里最后一个区间重叠就合并，否则新开一个：

```java
int[][] merge(int[][] intervals) {
    if (intervals.length == 0) return new int[0][];
    Arrays.sort(intervals, Comparator.comparingInt(a -> a[0]));
    List<int[]> res = new ArrayList<>();
    res.add(intervals[0]);
    for (int i = 1; i < intervals.length; i++) {
        int[] last = res.getLast();            // JDK 21 SequencedCollection
        if (intervals[i][0] <= last[1]) last[1] = Math.max(last[1], intervals[i][1]);
        else res.add(intervals[i]);
    }
    return res.toArray(new int[0][]);
}
```

### 7、任务调度器

LeetCode 621 任务调度器：同类任务之间至少间隔 n 个时间单位。出现次数最多的任务决定框架：它把时间轴切成 `maxFreq - 1` 段、每段长 `n + 1`，再加上最后一段（出现次数等于 `maxFreq` 的任务个数）。任务种类多到填满所有空位时，答案就是任务总数：

```java
int leastInterval(char[] tasks, int n) {
    int[] freq = new int[26];
    for (char t : tasks) freq[t - 'A']++;
    int maxFreq = Arrays.stream(freq).max().getAsInt();
    int maxCount = (int) Arrays.stream(freq).filter(f -> f == maxFreq).count();
    return Math.max(tasks.length, (maxFreq - 1) * (n + 1) + maxCount);
}
```

### 8、根据身高重建队列

LeetCode 406：每个人是 `[h, k]`，k 表示前面有 k 个身高 ≥ h 的人。**先按身高降序、身高相同按 k 升序**排序，再依次把每个人插到下标 k 的位置。高个子先排好，之后插入的矮个子不会影响他们的 k 值；而轮到某人插入时，队列里都是比他高或一样高的人，插在下标 k 恰好满足条件：

```java
int[][] reconstructQueue(int[][] people) {
    Arrays.sort(people, (a, b) -> a[0] != b[0]
            ? Integer.compare(b[0], a[0])      // 身高降序
            : Integer.compare(a[1], b[1]));    // k 升序
    List<int[]> queue = new ArrayList<>();
    for (int[] p : people) queue.add(p[1], p);
    return queue.toArray(new int[0][]);
}
```

---

## 四、怎么判断能不能用贪心

- 先想一个简单的贪心规则，用几个小例子（尤其是边界和反常的例子）验证
- 能找到反例就放弃贪心，转向 [动态规划](./5_dynamic_programming)：例如硬币面额为 `{1, 3, 4}` 凑 6，贪心先拿 4 得到 4+1+1 共 3 枚，最优是 3+3 共 2 枚
- 找不到反例时，尝试用**交换论证**（把最优解的第一步换成贪心选择，结果不变差）或**反证法**说明正确性

---

## 小结

- 贪心成立需要贪心选择性质和最优子结构；能举出反例就改用动态规划
- 区间调度按结束时间排序，用交换论证证明；LeetCode 435 的答案是 `n - 最多不重叠区间数`
- 合并区间按开始时间排序；根据身高重建队列先按身高降序再按 k 插入
- 比较器用 `Comparator.comparingInt` 或 `Integer.compare`，不要用减法
- 读取 `intervals[0]` 之前先判断空输入

## 参考资料

- OI Wiki 贪心：[https://oi-wiki.org/basic/greedy/](https://oi-wiki.org/basic/greedy/)
- Cormen 等，《算法导论》（第 3 版）第 16 章 贪心算法（活动选择问题）
- Java 21 `Comparator` API：[https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/Comparator.html](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/Comparator.html)

> 下一篇：[动态规划](./5_dynamic_programming) —— 记忆化与递推、一维 / 二维 DP、背包问题、区间 DP、空间压缩。
