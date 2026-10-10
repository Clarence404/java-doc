---
description: ACM 模式输入输出、BufferedReader 快读、常见题型模板、常用 API 速查、备考建议
---

# 华为 OJ 题型与技巧

> 前置阅读：[LeetCode 高频题分类](./0_leet_code)

华为机试（牛客网华为机试题库同形式）采用 ACM 模式输入输出，输入解析写错是最常见的丢分原因。本篇讲 Java 的 ACM 输入输出写法、机试常见题型模板与常用 API。

---

## 一、输入输出处理

与 LeetCode 只需实现一个函数不同，程序要自己从标准输入读数据、向标准输出打印结果，评测机比对输出内容。题量、分值、时长和计分方式因年份、岗位和考试类型而不同，网上的经验说法互相矛盾，以收到的机试通知为准。

### 1、基本约定

- 类名一般要求是 `Main`，并且是 `public` 的；不要写 `package` 声明
- 读标准输入用 `System.in`，写标准输出用 `System.out`；多余的提示文字（如「请输入」）会导致输出比对失败
- 任何读取方式都可以：`Scanner` 写起来简单但慢；输入达到十万级数字时，用 `BufferedReader` 更稳妥，可以避免超时

### 2、Scanner：简单场景

```java
import java.util.Scanner;

public class Main {
    public static void main(String[] args) {
        Scanner sc = new Scanner(System.in);
        while (sc.hasNextInt()) {              // 多组数据：读到 EOF 为止
            int a = sc.nextInt(), b = sc.nextInt();
            System.out.println(a + b);
        }
    }
}
```

**`nextInt()` 后接 `nextLine()` 的坑**：`nextInt()` 只读走数字，行尾的换行符还留在缓冲区，紧接着的 `nextLine()` 会读到一个空串。要先单独调用一次 `sc.nextLine()` 把换行符消耗掉，或者干脆全部按行读取再自己解析（见下一节）。

### 3、BufferedReader：按行读到 EOF

输入按行组织（一行一个字符串、一行若干个数）时，统一按行读，再用 `trim().split("\\s+")` 切分。`split(" ")` 遇到连续空格会切出空串，`parseInt` 就会抛异常：

```java
import java.io.*;
import java.util.*;

public class Main {
    public static void main(String[] args) throws IOException {
        BufferedReader br = new BufferedReader(new InputStreamReader(System.in));
        StringBuilder out = new StringBuilder();
        String line;
        while ((line = br.readLine()) != null) {   // readLine 在 EOF 时返回 null
            line = line.trim();
            if (line.isEmpty()) continue;          // 跳过空行
            int[] nums = Arrays.stream(line.split("\\s+")).mapToInt(Integer::parseInt).toArray();
            out.append(Arrays.stream(nums).sum()).append('\n');
        }
        System.out.print(out);                     // 一次性输出，比逐行 println 快
    }
}
```

### 4、StringTokenizer：大量整数快读

第一行给出 n，后面跟 n 个整数（可能跨多行）时，用 `StringTokenizer` 按空白切分，不必关心换行位置：

```java
import java.io.*;
import java.util.*;

public class Main {
    static BufferedReader br = new BufferedReader(new InputStreamReader(System.in));
    static StringTokenizer st;

    static String next() throws IOException {
        while (st == null || !st.hasMoreTokens()) {
            String line = br.readLine();
            if (line == null) return null;         // EOF
            st = new StringTokenizer(line);
        }
        return st.nextToken();
    }

    static int nextInt() throws IOException {
        return Integer.parseInt(next());
    }

    public static void main(String[] args) throws IOException {
        int n = nextInt();
        long sum = 0;                              // 累加可能超出 int
        for (int i = 0; i < n; i++) sum += nextInt();
        PrintWriter pw = new PrintWriter(new BufferedWriter(new OutputStreamWriter(System.out)));
        pw.println(sum);
        pw.flush();                                // 忘记 flush 就什么都不输出
    }
}
```

`java.io.StreamTokenizer` 也能快读，但它把数字解析成 `double`，超过 2^53 的整数会丢精度，读含特殊字符的字符串也不方便，一般用上面的写法即可。

---

## 二、常见题型

### 1、字符串处理

**字符分类统计**：

```java
String s = br.readLine();
long letters = s.chars().filter(Character::isLetter).count();
long digits  = s.chars().filter(Character::isDigit).count();
long spaces  = s.chars().filter(c -> c == ' ').count();
long others  = s.length() - letters - digits - spaces;
```

**反转单词顺序**：

```java
List<String> words = Arrays.asList(br.readLine().trim().split("\\s+"));
Collections.reverse(words);
System.out.println(String.join(" ", words));
```

**连续字符压缩**（`aabbbc` → `a2b3c`）：

```java
String compress(String s) {
    StringBuilder res = new StringBuilder();
    int i = 0;
    while (i < s.length()) {
        char c = s.charAt(i);
        int j = i;
        while (j < s.length() && s.charAt(j) == c) j++;
        res.append(c);
        if (j - i > 1) res.append(j - i);
        i = j;
    }
    return res.toString();
}
```

最长无重复字符子串等子串类题目用滑动窗口，见 [滑动窗口](../3_patterns/2_sliding_window)。

### 2、数学

**判断质数**：循环条件写成 `i <= n / i`，不要写 `i * i <= n`——n 接近 `Integer.MAX_VALUE` 时 `i * i` 会溢出成负数，循环不会按预期停止：

```java
boolean isPrime(int n) {
    if (n < 2) return false;
    for (int i = 2; i <= n / i; i++) {
        if (n % i == 0) return false;
    }
    return true;
}
```

需要判断大量数（比如求 1..n 内所有质数）时，改用埃氏筛，复杂度 O(n log log n)。

**最大公约数与最小公倍数**：

```java
long gcd(long a, long b) { return b == 0 ? a : gcd(b, a % b); }
long lcm(long a, long b) { return a / gcd(a, b) * b; }    // 先除后乘，减少溢出
```

**进制转换**：

| 需求 | 写法 |
|------|------|
| 十进制转二进制 / 十六进制字符串 | `Integer.toBinaryString(n)` / `Integer.toHexString(n)` |
| 十进制转任意进制（2~36） | `Integer.toString(n, radix)` |
| 任意进制字符串转十进制 | `Integer.parseInt(s, radix)`；超出 `int` 用 `Long.parseLong(s, radix)` |
| 超大数 | `new BigInteger(s, radix)`，`toString(radix)` |

### 3、排序与 Top K

**多规则排序**（先按长度，长度相同按字典序）：

```java
String[] words = {"banana", "kiwi", "apple", "fig"};
Arrays.sort(words, Comparator.comparingInt(String::length)
        .thenComparing(Comparator.naturalOrder()));
```

数值比较用 `Comparator.comparingInt` 或 `Integer.compare`，不要写 `a - b`，两数异号且很大时会溢出。

**第 K 大**：维护大小为 k 的小顶堆，堆顶就是第 k 大：

```java
int kthLargest(int[] nums, int k) {
    PriorityQueue<Integer> pq = new PriorityQueue<>(k);
    for (int num : nums) {
        pq.offer(num);
        if (pq.size() > k) pq.poll();
    }
    return pq.peek();
}
```

排序算法本身见 [排序算法](../2_algorithms/1_sort)，堆见 [堆](../1_data_structures/4_heap)。

### 4、动态规划

机试常见的最长公共子序列、最大连续子数组和、背包问题，代码见 [动态规划](../2_algorithms/5_dynamic_programming)。写之前先确认状态定义和数据范围：和可能超过 `int` 时，dp 数组用 `long`。

### 5、迷宫最短路

网格上的最短步数用 BFS，队列用 `ArrayDeque`，入队时就标记已访问：

```java
int minSteps(int[][] maze, int sr, int sc, int er, int ec) {
    int rows = maze.length, cols = maze[0].length;
    int[][] dist = new int[rows][cols];
    for (int[] row : dist) Arrays.fill(row, -1);          // -1 表示未访问
    int[][] dirs = {{0, 1}, {0, -1}, {1, 0}, {-1, 0}};
    Deque<int[]> queue = new ArrayDeque<>();
    queue.offer(new int[]{sr, sc});
    dist[sr][sc] = 0;
    while (!queue.isEmpty()) {
        int[] cur = queue.poll();
        if (cur[0] == er && cur[1] == ec) return dist[er][ec];
        for (int[] d : dirs) {
            int nr = cur[0] + d[0], nc = cur[1] + d[1];
            if (nr >= 0 && nr < rows && nc >= 0 && nc < cols
                    && maze[nr][nc] == 0 && dist[nr][nc] == -1) {
                dist[nr][nc] = dist[cur[0]][cur[1]] + 1;
                queue.offer(new int[]{nr, nc});
            }
        }
    }
    return -1;
}
```

BFS 模板和双向 BFS 见 [搜索算法](../2_algorithms/0_search)，连通块计数见 [回溯算法](../2_algorithms/3_backtrack) 的网格 DFS 一节。

---

## 三、常用 API 速查

**字符串**

| API | 作用 |
|-----|------|
| `String.valueOf(x)` / `Integer.parseInt(s)` | 数字与字符串互转 |
| `s.toCharArray()` / `new String(chars)` | 字符串与字符数组互转 |
| `s.trim().split("\\s+")` | 按任意空白切分 |
| `String.join(",", list)` | 用分隔符拼接 |
| `s.toLowerCase()`、`s.toUpperCase()` | 大小写转换 |
| `s.contains(t)`、`s.indexOf(t)` | 子串判断与查找 |
| `s.replace(a, b)` | 替换全部字面量子串（`replaceAll` 按正则） |
| `new StringBuilder(s).reverse().toString()` | 反转字符串 |
| `Character.isLetter(c)`、`isDigit(c)`、`isLetterOrDigit(c)` | 字符分类 |

**数组**

| API | 作用 |
|-----|------|
| `Arrays.sort(arr)` | 升序排序 |
| `Arrays.sort(boxed, Comparator.reverseOrder())` | 降序（只能用于 `Integer[]` 等包装类型数组） |
| `Arrays.fill(arr, v)` | 填充 |
| `Arrays.copyOfRange(arr, from, to)` | 复制 `[from, to)` |
| `Arrays.toString(arr)` | 打印一维数组 |
| `Arrays.stream(arr).sum()` / `.max().getAsInt()` | 求和、最大值 |

**集合**

| API | 作用 |
|-----|------|
| `Collections.sort(list)` / `list.sort(cmp)` | 排序 |
| `Collections.max(list)`、`Collections.min(list)` | 最值 |
| `Collections.reverse(list)` | 反转 |
| `Collections.frequency(list, x)` | 统计出现次数 |
| `map.merge(key, 1, Integer::sum)` | 计数 |
| `map.getOrDefault(key, 0)` | 带默认值读取 |
| `new TreeMap<>()` | 按 key 有序遍历（如按字典序输出统计结果） |

---

## 小结

- ACM 模式要自己处理输入输出：类名 `Main`、不输出多余文字、读到 EOF 为止
- 小数据用 `Scanner`，注意 `nextInt()` 后接 `nextLine()` 的空串问题；大数据用 `BufferedReader` + `StringTokenizer`
- 按行切分用 `trim().split("\\s+")`；大量输出用 `StringBuilder` 或 `PrintWriter`，最后记得 `flush`
- 质数判断写 `i <= n / i`；求和、乘积、最小公倍数注意 `int` 溢出
- 题量、分值和时长以机试通知为准；牛客网的华为机试题库（HJ 系列）适合练手感

## 参考资料

- 牛客网华为机试 HJ1 字符串最后一个单词的长度（题库第一题，可由此进入 HJ 系列）：[https://www.nowcoder.com/practice/8c949ea5f36f422594b306a2300315da](https://www.nowcoder.com/practice/8c949ea5f36f422594b306a2300315da)
- Java 21 `BufferedReader` API：[https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/io/BufferedReader.html](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/io/BufferedReader.html)
- Java 21 `StringTokenizer` API：[https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/StringTokenizer.html](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/StringTokenizer.html)
- Java 21 `Scanner` API：[https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/Scanner.html](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/Scanner.html)

> 返回：[数据结构与算法总览](../0_overview)
