---
description: 常用位运算技巧、状态压缩
---

# 位运算

> 直接操作二进制位，绕过乘除、取模等高开销运算，在竞赛和面试中用于状压 DP、集合运算、快速判断奇偶/2 的幂等场景。

---

## 一、基础操作速查

| 运算 | 符号 | 说明 | 示例 |
|------|------|------|------|
| 与 AND | `a & b` | 同 1 才 1 | `5 & 3 = 1`（101 & 011 = 001） |
| 或 OR | `a \| b` | 有 1 则 1 | `5 \| 3 = 7` |
| 异或 XOR | `a ^ b` | 不同则 1 | `5 ^ 3 = 6` |
| 取反 NOT | `~a` | 按位取反 | `~5 = -6`（补码） |
| 左移 | `a << k` | 乘以 2^k | `3 << 2 = 12` |
| 右移（算术） | `a >> k` | 除以 2^k（保留符号位） | `-4 >> 1 = -2` |
| 右移（逻辑） | `a >>> k` | 无符号右移，高位补 0 | Java 专有 |

---

## 二、常用技巧

### 2.1 判断奇偶

```java
(n & 1) == 0   // 偶数
(n & 1) == 1   // 奇数
```

### 2.2 判断是否为 2 的幂

```java
n > 0 && (n & (n - 1)) == 0
// 原理：2 的幂二进制只有一个 1，n-1 将其后所有位置 1，AND 为 0
```

### 2.3 取最低位的 1（lowbit）

```java
int low = n & (-n);    // -n = ~n + 1，AND 后只保留最低位的 1
// 树状数组 BIT 的核心操作
```

### 2.4 消去最低位的 1

```java
n = n & (n - 1);
// 统计 1 的个数（Brian Kernighan 算法）
int countBits(int n) {
    int cnt = 0;
    while (n != 0) { n &= n - 1; cnt++; }
    return cnt;
}
```

### 2.5 异或的性质

```java
a ^ a == 0          // 自身异或为 0
a ^ 0 == a          // 与 0 异或不变
// 交换两数（不用临时变量）
a ^= b; b ^= a; a ^= b;
```

### 2.6 取第 k 位

```java
(n >> k) & 1        // 第 k 位（从 0 开始）的值，0 或 1
```

### 2.7 设置 / 清除 / 翻转第 k 位

```java
n |=  (1 << k);     // 设置第 k 位为 1
n &= ~(1 << k);     // 清除第 k 位（置 0）
n ^=  (1 << k);     // 翻转第 k 位
```

### 2.8 枚举子集

```java
// 枚举整数 mask 的所有非空子集
for (int sub = mask; sub > 0; sub = (sub - 1) & mask) {
    // 处理子集 sub
}
```

---

## 三、状态压缩（状压 DP）

用一个整数的每一位表示一种状态（通常是某元素是否被选取），最多支持 **20–25 个元素**。

```java
// 经典：旅行商问题（TSP）状压 DP
// dp[mask][i] = 经过 mask 中所有城市、最后到达城市 i 的最短路径
int n = cities.length;
int[][] dp = new int[1 << n][n];
// 初始化、转移...
for (int mask = 1; mask < (1 << n); mask++) {
    for (int i = 0; i < n; i++) {
        if ((mask & (1 << i)) == 0) continue;  // i 不在 mask 中
        int prev = mask ^ (1 << i);             // 去掉 i 的前驱状态
        for (int j = 0; j < n; j++) {
            if ((prev & (1 << j)) == 0) continue;
            dp[mask][i] = Math.min(dp[mask][i], dp[prev][j] + dist[j][i]);
        }
    }
}
```

---

## 四、Java 内置工具

```java
Integer.bitCount(n)           // 二进制中 1 的个数（即 popcount）
Integer.highestOneBit(n)      // 最高位的 1
Integer.lowestOneBit(n)       // 最低位的 1（等价 n & -n）
Integer.numberOfLeadingZeros(n)
Integer.numberOfTrailingZeros(n)
Integer.reverse(n)            // 按位反转
Integer.toBinaryString(n)     // 转二进制字符串
```

---

## 五、常见场景总结

| 场景 | 技巧 |
|------|------|
| 统计二进制中 1 的个数 | `n & (n-1)` 循环 / `Integer.bitCount` |
| 判断 2 的幂 | `n > 0 && (n & (n-1)) == 0` |
| 找唯一出现一次的数 | 全部异或，结果即为目标 |
| 找两个只出现一次的数 | 异或 → 取任意不同位分组 → 分别异或 |
| 子集枚举 | `for sub = mask; sub > 0; sub = (sub-1)&mask` |
| 状压 DP | `dp[mask][i]`，枚举 mask 和 mask 子集 |
| 不用加法求和 | `a ^ b`（无进位和）+ `(a & b) << 1`（进位），循环直到进位为 0 |

---

## 六、经典题目

| 题目 | 难度 | 考点 |
|------|------|------|
| LC 191 位 1 的个数 | Easy | bitCount / Kernighan |
| LC 231 2 的幂 | Easy | `n & (n-1)` |
| LC 136 只出现一次的数字 | Easy | 异或消除 |
| LC 137 只出现一次的数字 II | Medium | 位计数取模 |
| LC 260 只出现一次的数字 III | Medium | 异或分组 |
| LC 461 汉明距离 | Easy | 异或 + bitCount |
| LC 78 子集 | Medium | 位掩码枚举 |
| LC 338 比特位计数 | Easy | DP + lowbit |
| LC 421 最大异或值 | Medium | 二进制 Trie |
| LC 847 访问所有节点的最短路径 | Hard | 状压 DP + BFS |
| LC 1986 完成任务的最少工作时间段 | Medium | 状压 DP |
