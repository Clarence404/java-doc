---
description: 位运算速查、lowbit、子集枚举、异或技巧、状压 DP、Integer 位工具方法与常见坑
---

# 位运算

> 前置阅读：[动态规划](../2_algorithms/5_dynamic_programming)、[前缀和与差分数组](./3_prefix_sum)

位运算直接操作整数的二进制位，算法题里主要用来把小集合压缩成整数，以及利用异或的抵消性质。本篇讲基本操作与 Java 移位规则、lowbit / 子集枚举 / 异或分组等技巧、状压 DP，以及移位与优先级的常见坑。

---

## 一、基础操作速查

| 运算 | 写法 | 规则 | 示例 |
|------|------|------|------|
| 与 | `a & b` | 两位都为 1 才得 1 | `5 & 3 = 1`（101 & 011 = 001） |
| 或 | `a \| b` | 有一位为 1 就得 1 | `5 \| 3 = 7` |
| 异或 | `a ^ b` | 两位不同得 1 | `5 ^ 3 = 6` |
| 取反 | `~a` | 每一位取反 | `~5 = -6`（补码下 `~a == -a - 1`） |
| 左移 | `a << k` | 低位补 0，不溢出时等于乘 2^k | `3 << 2 = 12` |
| 算术右移 | `a >> k` | 高位补符号位，等于除以 2^k 后**向负无穷取整** | `-5 >> 1 = -3` |
| 逻辑右移 | `a >>> k` | 高位补 0 | `-1 >>> 28 = 15` |

两个容易混淆的点：

- **`>>` 与 `/` 对负数结果不同**：`/` 向零取整，`-5 / 2 == -2`；`>>` 向负无穷取整，`-5 >> 1 == -3`。正数时两者相同
- **为什么 Java 有 `>>>`**：Java 没有无符号整数类型，`>>` 总是补符号位，需要单独的逻辑右移来把 `int` 当成无符号数处理。`>>>` 并非 Java 独有，JavaScript 也有

---

## 二、常用技巧

### 1、判断奇偶与取第 k 位

```java
boolean isEven = (n & 1) == 0;         // 括号不能省，见第五节
int bit = (n >> k) & 1;                // 第 k 位（从 0 开始）的值
```

### 2、设置、清除、翻转第 k 位

```java
n |=  (1 << k);                        // 第 k 位置 1
n &= ~(1 << k);                        // 第 k 位置 0
n ^=  (1 << k);                        // 第 k 位取反
```

### 3、消去最低位的 1

`n & (n - 1)` 把 n 最低位的 1 变成 0：`n - 1` 会把最低位的 1 变成 0、它右边的 0 全变成 1，再与 n 相与就只清掉了这一位。

```java
// 统计二进制中 1 的个数（Brian Kernighan 算法），循环次数等于 1 的个数
int countOnes(int n) {
    int count = 0;
    while (n != 0) {
        n &= n - 1;
        count++;
    }
    return count;
}

// 判断 2 的幂：恰好只有一个 1
boolean isPowerOfTwo(int n) {
    return n > 0 && (n & (n - 1)) == 0;
}
```

### 4、取最低位的 1（lowbit）

`n & -n` 只保留最低位的 1。补码下 `-n == ~n + 1`：取反后最低位的 1 及其右边变成「0 后面跟一串 1」，加 1 后进位恰好回到原来那一位。树状数组（Fenwick Tree）就是靠 lowbit 在 O(log n) 内跳转。

```java
int lowbit = n & -n;                   // 12（1100）→ 4（0100）
```

### 5、异或的性质

- `a ^ a == 0`、`a ^ 0 == a`，且满足交换律和结合律
- **找唯一出现一次的数**（LeetCode 136 只出现一次的数字）：所有数异或起来，成对的数互相抵消
- **找两个只出现一次的数**（LeetCode 260）：全部异或得到 `x ^ y`，取它的 lowbit（x 和 y 在这一位上不同），按这一位把所有数分成两组，各自异或

```java
int[] singleNumber(int[] nums) {
    int xor = 0;
    for (int x : nums) xor ^= x;
    int diff = xor & -xor;                 // x 与 y 不同的最低位
    int a = 0;
    for (int x : nums) if ((x & diff) != 0) a ^= x;
    return new int[]{a, xor ^ a};
}
```

用异或交换两个变量（`a ^= b; b ^= a; a ^= b;`）只是技巧展示：如果 a、b 是同一个变量或同一个数组元素（`arr[i]` 与 `arr[j]` 且 `i == j`），结果会变成 0；它也不比临时变量快。实际代码用临时变量。

### 6、枚举子集

用一个整数的第 i 位表示第 i 个元素选或不选，n 个元素的全部子集就是 `0` 到 `2^n - 1`：

```java
// 枚举 n 个元素的所有子集（LeetCode 78 子集的位运算写法）
for (int mask = 0; mask < (1 << n); mask++) {
    for (int i = 0; i < n; i++) {
        if ((mask >> i & 1) == 1) { /* 选中第 i 个元素 */ }
    }
}

// 枚举某个 mask 的所有非空子集
for (int sub = mask; sub > 0; sub = (sub - 1) & mask) {
    // 处理子集 sub
}
```

`(sub - 1) & mask` 每次得到「比 sub 小的下一个 mask 的子集」。对所有 mask 枚举其子集，总次数是 3^n（每个元素有「不在 mask」「在 mask 不在 sub」「在 sub」三种状态）。

---

## 三、状态压缩 DP

当状态需要记录「哪些元素已经用过」，且元素个数很少时，把这个集合压成一个整数 `mask` 当作 DP 的一维。

以旅行商问题（TSP）为例：从城市 0 出发，每个城市恰好访问一次，最后回到 0，求最短路程。`dp[mask][i]` = 已访问城市集合为 mask、当前停在城市 i 时的最短路程：

```java
int tsp(int[][] dist) {
    int n = dist.length;
    if (n == 1) return 0;
    int full = 1 << n;
    int inf = Integer.MAX_VALUE / 2;           // 两个 inf 相加也不会溢出
    int[][] dp = new int[full][n];
    for (int[] row : dp) Arrays.fill(row, inf);
    dp[1][0] = 0;                              // 只访问了城市 0，停在 0
    for (int mask = 1; mask < full; mask++) {
        for (int i = 0; i < n; i++) {
            if ((mask & (1 << i)) == 0 || dp[mask][i] == inf) continue;   // 状态不合法或不可达
            for (int j = 0; j < n; j++) {
                if ((mask & (1 << j)) != 0) continue;                     // j 已访问
                int next = mask | (1 << j);
                dp[next][j] = Math.min(dp[next][j], dp[mask][i] + dist[i][j]);
            }
        }
    }
    int best = inf;
    for (int i = 1; i < n; i++) best = Math.min(best, dp[full - 1][i] + dist[i][0]);   // 回到起点
    return best;
}
```

- **初始化不能省**：`dp` 默认全是 0，不先填成 `inf`，`Math.min` 永远取到 0
- 复杂度 O(2^n · n²)，空间 O(2^n · n)。n = 16 时约 1.7×10^7 次转移，n = 20 时约 4×10^8 次，已接近时限；状压 DP 一般用于 n ≤ 20 左右的题目

LeetCode 847 访问所有节点的最短路径把 mask 和当前节点一起作为 BFS 的状态，是状压与 BFS 的结合。

---

## 四、Java 内置工具

| 方法 | 作用 |
|------|------|
| `Integer.bitCount(n)` | 二进制中 1 的个数 |
| `Integer.highestOneBit(n)` / `Integer.lowestOneBit(n)` | 只保留最高位 / 最低位的 1 |
| `Integer.numberOfLeadingZeros(n)` / `Integer.numberOfTrailingZeros(n)` | 前导 0 / 末尾 0 的个数 |
| `Integer.reverse(n)` | 按位反转 |
| `Integer.toBinaryString(n)` | 转二进制字符串（负数按补码输出 32 位） |
| `Long` 上的同名方法 | 64 位版本 |
| `java.util.BitSet` | 任意长度的位集合，支持 `and` / `or` / `xor` / `cardinality` |

位集合的工程应用：Redis 的 Bitmap 用一个字符串存海量布尔状态（签到、在线状态），见 [Redis 基础](/cache/1_redis_base)；用位图对 40 亿整数去重、判存在，见 [海量数据算法题](/scenario/3_massive_data)。

---

## 五、常见坑

- **移位距离会被截断**：`int` 的移位只取距离的低 5 位，`1 << 32 == 1`、`1 << 33 == 2`；`long` 只取低 6 位。需要 32 位以上时写 `1L << k`
- **运算符优先级**：`==` 的优先级高于 `&`、`|`、`^`。`n & 1 == 0` 会被解析成 `n & (1 == 0)`，在 Java 中是 `int & boolean`，直接编译失败；位运算参与比较时一律加括号
- **`1 << 31` 是负数**：它等于 `Integer.MIN_VALUE`，用作掩码没问题，当作数值比较大小会出错
- **右移负数**：`>>` 向负无穷取整，不能直接替代 `/ 2`；`>>>` 对负数会得到很大的正数

---

## 小结

- `n & (n - 1)` 消去最低位的 1，`n & -n` 取最低位的 1
- 异或抵消：成对的数异或为 0，可找只出现一次的数，按 lowbit 分组找两个
- 子集枚举用 `0 .. 2^n - 1`，枚举 mask 的子集用 `sub = (sub - 1) & mask`
- 状压 DP 先把 dp 填成安全的无穷大，复杂度 O(2^n · n²)，适合 n ≤ 20 左右
- Java 移位距离按 5 位（`long` 按 6 位）截断，`==` 优先级高于 `&`

## 参考资料

- OI Wiki 位运算：[https://oi-wiki.org/math/bit/](https://oi-wiki.org/math/bit/)
- OI Wiki 状压 DP：[https://oi-wiki.org/dp/state/](https://oi-wiki.org/dp/state/)
- Java 语言规范 15.19 移位运算符：[https://docs.oracle.com/javase/specs/jls/se21/html/jls-15.html#jls-15.19](https://docs.oracle.com/javase/specs/jls/se21/html/jls-15.html#jls-15.19)
- Java 21 `BitSet` API：[https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/BitSet.html](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/BitSet.html)

> 下一篇：[LeetCode 高频题分类](../4_practice/0_leet_code) —— 按题型整理的高频题清单、解题切入点与讲解位置。
