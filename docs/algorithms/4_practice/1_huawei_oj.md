---
description: 输入输出处理、高频题型、常用 API 速查
---

# 华为 OJ 题型与技巧

> 华为机试（OJ）采用 ACM 赛制，需自行处理输入输出，与 LeetCode 不同。

---

## 一、输入输出处理（Java）

华为 OJ 使用标准输入输出，必须用 Scanner 读取：

```java
import java.util.*;

public class Main {
    public static void main(String[] args) {
        Scanner sc = new Scanner(System.in);

        // 读取单个整数
        int n = sc.nextInt();

        // 读取一行字符串
        String line = sc.nextLine();

        // 读取多行，直到 EOF
        while (sc.hasNextLine()) {
            String row = sc.nextLine();
            // 处理...
        }

        // 读取空格分隔的整数数组
        int[] arr = Arrays.stream(sc.nextLine().split(" "))
                          .mapToInt(Integer::parseInt).toArray();

        System.out.println(result); // 输出结果
    }
}
```

**常见坑：**
- `nextInt()` 后接 `nextLine()` 会读到空行，需先 `sc.nextLine()` 消耗换行符
- 多组测试数据用 `while (sc.hasNextInt())` 循环

---

## 二、高频题型

### 2.1 字符串处理

**字符串分类统计（字母/数字/其他）：**
```java
String s = sc.nextLine();
long letters = s.chars().filter(Character::isLetter).count();
long digits  = s.chars().filter(Character::isDigit).count();
long others  = s.length() - letters - digits;
```

**反转单词顺序：**
```java
String[] words = sc.nextLine().trim().split("\\s+");
StringBuilder sb = new StringBuilder();
for (int i = words.length - 1; i >= 0; i--)
    sb.append(words[i]).append(i > 0 ? " " : "");
System.out.println(sb);
```

**字符串压缩（连续相同字符计数）：**
```java
String s = "aabbbcccc";
StringBuilder res = new StringBuilder();
int i = 0;
while (i < s.length()) {
    char c = s.charAt(i);
    int count = 0;
    while (i < s.length() && s.charAt(i) == c) { count++; i++; }
    res.append(c).append(count > 1 ? count : "");
}
```

---

### 2.2 数学 & 规律

**判断质数：**
```java
boolean isPrime(int n) {
    if (n < 2) return false;
    for (int i = 2; i * i <= n; i++)
        if (n % i == 0) return false;
    return true;
}
```

**最大公约数 & 最小公倍数：**
```java
int gcd(int a, int b) { return b == 0 ? a : gcd(b, a % b); }
int lcm(int a, int b) { return a / gcd(a, b) * b; }
```

**进制转换：**
```java
// 十进制 → 二进制字符串
Integer.toBinaryString(42);
// 十进制 → 十六进制字符串
Integer.toHexString(42);
// 字符串（二进制）→ 十进制
Integer.parseInt("101010", 2);
```

---

### 2.3 排序 & 贪心

**自定义排序（多规则）：**
```java
// 先按长度排，长度相同按字典序
Arrays.sort(words, (a, b) -> a.length() != b.length()
    ? a.length() - b.length() : a.compareTo(b));
```

**找第 K 大（小顶堆）：**
```java
PriorityQueue<Integer> pq = new PriorityQueue<>(k);
for (int num : nums) {
    pq.offer(num);
    if (pq.size() > k) pq.poll();
}
System.out.println(pq.peek()); // 第 k 大
```

---

### 2.4 动态规划

**最长公共子序列：**
```java
int lcs(String s1, String s2) {
    int m = s1.length(), n = s2.length();
    int[][] dp = new int[m+1][n+1];
    for (int i = 1; i <= m; i++)
        for (int j = 1; j <= n; j++)
            dp[i][j] = s1.charAt(i-1) == s2.charAt(j-1)
                ? dp[i-1][j-1] + 1
                : Math.max(dp[i-1][j], dp[i][j-1]);
    return dp[m][n];
}
```

**最大连续子数组和（Kadane）：**
```java
int maxSum(int[] nums) {
    int max = nums[0], cur = nums[0];
    for (int i = 1; i < nums.length; i++) {
        cur = Math.max(nums[i], cur + nums[i]);
        max = Math.max(max, cur);
    }
    return max;
}
```

---

### 2.5 图 & 搜索

**迷宫最短路（BFS）：**
```java
int minPath(int[][] maze, int[] start, int[] end) {
    int rows = maze.length, cols = maze[0].length;
    boolean[][] visited = new boolean[rows][cols];
    Queue<int[]> queue = new LinkedList<>();
    queue.offer(new int[]{start[0], start[1], 0}); // row, col, steps
    visited[start[0]][start[1]] = true;
    int[][] dirs = {{0,1},{0,-1},{1,0},{-1,0}};

    while (!queue.isEmpty()) {
        int[] cur = queue.poll();
        if (cur[0] == end[0] && cur[1] == end[1]) return cur[2];
        for (int[] d : dirs) {
            int nr = cur[0]+d[0], nc = cur[1]+d[1];
            if (nr>=0 && nr<rows && nc>=0 && nc<cols
                && maze[nr][nc] == 0 && !visited[nr][nc]) {
                visited[nr][nc] = true;
                queue.offer(new int[]{nr, nc, cur[2]+1});
            }
        }
    }
    return -1;
}
```

---

## 三、常用 Java API 速查

```java
// 字符串
String.valueOf(42);              // 数字转字符串
Integer.parseInt("42");          // 字符串转整数
str.toCharArray();               // 字符串转字符数组
String.join(",", list);          // 用分隔符拼接
str.split(",");                  // 按分隔符切分
str.trim();                      // 去首尾空格
str.toLowerCase() / toUpperCase();
str.contains("abc");
str.replace("a", "b");

// 数组
Arrays.sort(arr);
Arrays.sort(arr, Comparator.reverseOrder()); // 降序（需包装类型）
Arrays.fill(arr, 0);
Arrays.copyOfRange(arr, 1, 4);  // [1, 4)
Arrays.toString(arr);            // 打印数组

// 集合
Collections.sort(list);
Collections.max(list) / min(list);
Collections.reverse(list);
Collections.frequency(list, target); // 统计出现次数
```

---

## 四、历年高频题目

| 题目类型 | 具体题目 |
|---------|---------|
| 字符串 | 字符串分类统计、最长不含重复字符子串、字符串压缩 |
| 排序 | 排名次、自定义多规则排序 |
| 数学 | 素数判断、最大公约数、进制转换 |
| 数组 | 滑动窗口最大值、最大连续子数组和 |
| 动态规划 | 最长公共子序列、背包问题 |
| 图 | 迷宫BFS最短路、连通块计数 |
| 贪心 | 任务调度、区间选择 |

---

::: tip 华为机试备考建议
1. **一定要练输入输出**：Scanner 的多组输入、EOF 处理，这是与 LeetCode 最大的区别
2. **时间把控**：共 3 题 150 分钟，第一题简单（30分），第二题中等（40分），第三题难（30分）
3. **先保过**：第一题必须 AC，第二题争取 AC，第三题拿到部分分
4. **推荐练习**：HJ 系列华为机试题（牛客网 OJ）
:::
