---
description: 哈希分桶、堆 Top K、Bitmap 与 2-Bitmap、布隆过滤器、外部排序、九类经典题的思路与内存估算
---

# 海量数据算法题

> **本篇目标**：面对「数据远大于内存」的题目，能先算清内存账，再在哈希分桶、堆、位图、布隆过滤器、Trie、外部排序之间选对工具，并把九类经典题的步骤和内存估算讲清楚。
>
> **前置阅读**：[海量数据架构选型](./2_big_data)、[堆](/algorithms/1_data_structures/4_heap)、[哈希表](/algorithms/1_data_structures/2_hash_table)

这类题的共同点是：数据量是内存的几十到几百倍，只能顺序读磁盘，不能一次装进内存。本篇只讲单机或离线批处理的算法思路；存储扩展、日志链路、UV 统计等系统级方案见 [海量数据架构选型](./2_big_data)。

本文的单位约定：1 亿 = 10⁸；1KB = 1024B，MB、GB 依此类推；int 占 4 字节。

---

## 一、通用套路

### 1、先算内存账

动手之前先算三个数：**数据总量**、**去重后的 key 数量**、**可用内存**。下面几个数值经常用到：

| 对象 | 计算 | 结果 |
|------|------|------|
| 1 亿个 int | 10⁸ × 4B = 4 × 10⁸ B | 约 381MB |
| int 全值域的 Bitmap | 2³² bit = 2²⁹ B | 512MB |
| int 全值域的 2-Bitmap | 2³² × 2 bit = 2³⁰ B | 1GB |
| 50 亿条 64 字节的 URL | 5 × 10⁹ × 64B = 3.2 × 10¹¹ B | 约 298GB |
| Java `HashMap<String, Long>` 每个条目的额外开销 | Node 32B + String 对象 24B + byte[] 头 16B + Long 16B | 约 88B（不含字符串内容） |

最后一行说明：Java 里用 HashMap 计数时，对象开销往往比数据本身还大，估算时要把它算进去。

### 2、分而治之：哈希分桶

![哈希分桶 + 桶内处理 + 归并](../assets/scenario/hash-partition-merge.svg)

做法是顺序扫描一遍数据，按 `hash(key) % N` 把每条记录写进 N 个小文件。**同一个 key 一定落在同一个桶**，所以每个桶可以单独处理，桶与桶之间的 key 互不重叠，结果直接合并即可。

- **桶数怎么定**：N ≥ 数据总量 ÷ 单桶可用内存，再留 2～3 倍余量应对 HashMap 开销和分布不均。例如 298GB 数据、4GB 内存，取 N = 1000，每桶平均约 305MB
- **数据倾斜**：某个 key 特别多时，它所在的桶会远大于平均值。处理方法是换一个哈希种子，只对这个桶再分一次
- **多个文件要对齐**：两个文件求交集时，必须用同一个哈希函数、同一个 N，编号相同的桶才对得上

```java
// 按 hash(line) % buckets 把大文件拆成 buckets 个小文件
static void partition(Path input, Path dir, String prefix, int buckets) throws IOException {
    BufferedWriter[] out = new BufferedWriter[buckets];
    try (BufferedReader in = Files.newBufferedReader(input)) {
        for (int i = 0; i < buckets; i++) {
            out[i] = Files.newBufferedWriter(dir.resolve(prefix + i));   // 每个自带 8192 字符的缓冲，1000 个合计几十 MB
        }
        String line;
        while ((line = in.readLine()) != null) {
            BufferedWriter w = out[Math.floorMod(line.hashCode(), buckets)];
            w.write(line);
            w.newLine();
        }
    } finally {
        for (BufferedWriter w : out) {
            if (w != null) w.close();
        }
    }
}
```

`String.hashCode()` 足够演示；数据可能被人为构造时，换成带随机种子的 MurmurHash 等哈希，避免被打到同一个桶。

### 3、堆求 Top K

求最大的 K 个，维护一个大小为 K 的**小顶堆**：堆顶是当前第 K 大，新元素比堆顶大就替换堆顶。时间 O(N log K)，空间 O(K)，数据只需要顺序读一遍。求最小的 K 个则反过来用大顶堆。堆的原理见 [堆](/algorithms/1_data_structures/4_heap)。

频率 Top K 是先计数、再对计数结果用堆，下面这个方法后文会反复用到：

```java
static List<Map.Entry<String, Long>> topK(Map<String, Long> counts, int k) {
    PriorityQueue<Map.Entry<String, Long>> heap =
            new PriorityQueue<>(Map.Entry.comparingByValue());      // 小顶堆，按次数比较
    for (Map.Entry<String, Long> e : counts.entrySet()) {
        if (heap.size() < k) {
            heap.offer(e);
        } else if (e.getValue() > heap.peek().getValue()) {
            heap.poll();
            heap.offer(e);
        }
    }
    List<Map.Entry<String, Long>> result = new ArrayList<>(heap);
    result.sort(Map.Entry.<String, Long>comparingByValue().reversed());   // 按次数从高到低输出
    return result;
}
```

### 4、Bitmap 与 2-Bitmap

key 是**范围有限的整数**（IP、int、手机号）时，用「值本身」当数组下标，每个值只占 1 bit：

- **Bitmap**：1 bit 表示「出现过 / 没出现过」，内存 = 值域大小 ÷ 8 字节，和数据条数无关
- **2-Bitmap**：2 bit 表示 4 种状态，常用 `00` 没出现、`01` 出现一次、`10` 出现多次，内存翻倍

Bitmap 是精确的；它的代价取决于值域而不是数据量，值域稀疏时（如 64 位 ID）就不合适了。位运算技巧见 [位运算](/algorithms/3_patterns/4_bit_manipulation)，Redis 中的 Bitmap 用法见 [Redis 基础](/cache/1_redis_base)。

### 5、布隆过滤器

key 是字符串、值域无法用下标表示，又只需要回答「在不在」时，用布隆过滤器：k 个哈希函数把元素映射到位数组的 k 个位置。

- 位数组大小 `m = -n·ln p / (ln 2)²`，哈希函数个数 `k = (m / n)·ln 2`。按这两个公式，p = 1% 时每个元素约 9.6 bit，p = 0.1% 时约 14.4 bit
- **误判只有一个方向**：说「不在」一定不在；说「在」可能是误判。所以它适合「先过滤、再精确确认」，或允许少量误差的场景
- 不支持删除；需要删除用计数布隆过滤器或 Cuckoo Filter

在线使用（Redis 8 的 `BF.*`、Redisson）见 [Redis 典型应用场景](/cache/4_redis_scenario#二、布隆过滤器)。

### 6、Trie 字典树

字符串之间共享前缀时，Trie 把公共前缀只存一份，节点上挂计数就能统计词频，还能顺带做前缀查询（如搜索提示）。它省不省内存取决于前缀重复度：前缀重复少时，Java 中每个节点的对象开销会让它比 HashMap 更占内存。实现见 [字典树（Trie）](/algorithms/1_data_structures/6_trie)。

### 7、外部排序与多路归并

需要全局有序、或分桶后仍要按某个字段整体排序时，用外部排序：

1. **生成有序段**：每次读入内存能放下的一块（例如 4GB 内存读 2GB，留出排序和 IO 缓冲的空间），排序后写成一个有序段文件。100GB 数据就是 100 ÷ 2 = 50 个段
2. **多路归并**：每个段各开一个读取器，把每段的第一条放进小顶堆，每次弹出最小的一条写出，再从它所在的段补一条。50 路归并时堆里只有 50 个元素

整个过程只读写磁盘两遍，内存占用是「段数 × 读缓冲」加一个很小的堆。

```java
record Head(String line, int src) {}

// 把若干个已按 order 排好序的文件归并成一个有序文件
static void mergeSorted(List<Path> runs, Path output, Comparator<String> order) throws IOException {
    List<BufferedReader> readers = new ArrayList<>();
    PriorityQueue<Head> heap = new PriorityQueue<>((a, b) -> order.compare(a.line(), b.line()));
    try (BufferedWriter out = Files.newBufferedWriter(output)) {
        for (Path run : runs) {
            BufferedReader r = Files.newBufferedReader(run);
            readers.add(r);
            String first = r.readLine();
            if (first != null) heap.offer(new Head(first, readers.size() - 1));
        }
        while (!heap.isEmpty()) {
            Head h = heap.poll();
            out.write(h.line());
            out.newLine();
            String next = readers.get(h.src()).readLine();
            if (next != null) heap.offer(new Head(next, h.src()));
        }
    } finally {
        for (BufferedReader r : readers) r.close();
    }
}
```

归并排序本身见 [排序算法](/algorithms/2_algorithms/1_sort)。

### 8、按条件选方法

| 条件 | 首选方法 |
|------|----------|
| 去重后的 key 放得进内存 | 直接 HashMap / HashSet，再配合堆 |
| key 是范围有限的整数 | Bitmap / 2-Bitmap，内存 = 值域 × 每个值的位数 |
| 只问「在不在」，允许少量误判 | 布隆过滤器 |
| 只问「有多少个不同」，允许约 1% 误差 | HyperLogLog，见 [海量数据架构选型](./2_big_data#五、经典海量数据问题) |
| key 放不下，又要求精确 | 哈希分桶，分到每个桶放得下为止 |
| 结果要求全局有序 | 外部排序 + 多路归并 |
| 数据已分散在多台机器 | 先按 key 重新分区（shuffle），再各机处理、最后汇总 |

---

## 二、两个大文件找相同的 URL

### 1、题目

文件 a、b 各存 50 亿个 URL，每个 URL 平均 64 字节，内存限制 4GB，找出两个文件共有的 URL。

### 2、思路

单个文件约 298GB，HashSet 放不下，用**哈希分桶**：两个文件用同一个哈希函数、同一个桶数各拆成 1000 份。相同的 URL 一定落在编号相同的一对桶 aᵢ、bᵢ 里，所以只需要逐对求交集。

### 3、内存估算

- 每个文件：5 × 10⁹ × 64B = 3.2 × 10¹¹ B ≈ 298GB
- 分 1000 个桶：每桶平均 3.2 × 10¹¹ ÷ 1000 = 3.2 × 10⁸ B ≈ 305MB
- 把 aᵢ 装进 `HashSet<String>`：内容 305MB，加上每条约 80B 的对象开销（Node、String、byte[] 头；HashSet 不存 Long），约 5 × 10⁶ 条 × 80B ≈ 381MB，合计约 700MB，在 4GB 以内，还能容忍 3～4 倍的分布不均

### 4、关键步骤

1. 用上面的 `partition` 把 a 拆成 `a0`～`a999`，b 拆成 `b0`～`b999`
2. 对每个 i：把 aᵢ 读入 HashSet，顺序扫描 bᵢ，命中的 URL 写入结果
3. 某个桶超过内存时，用另一个哈希种子把这一对桶再各拆一次

**允许少量误差时**可以用布隆过滤器：4GB = 2³⁵ bit ≈ 343.6 亿 bit，平均每个 URL 343.6 ÷ 50 ≈ 6.87 bit，取 k = 5 个哈希函数，误判率约 3.7%。把 a 全部放进过滤器，再扫描 b，判「在」的输出。误差方向是**多报**：大约 3.7% 不在 a 里的 URL 会被当成共有。

如果两个文件已经各自有序（或先做外部排序），也可以用双指针同步扫描，相等就输出，几乎不占内存。

---

## 三、海量文本中找高频词

### 1、题目

一个 1GB 的文件，每行一个词，每个词不超过 16 字节，内存限制 1MB，返回出现次数最多的 100 个词。

### 2、思路

**分桶计数 + 堆**。1MB 装不下整个词表，先按 `hash(word) % 5000` 拆成 5000 个小文件，每个桶用 HashMap 计数并求本桶的 Top 100，最后把各桶的结果用大小为 100 的小顶堆合并。

因为同一个词只会出现在一个桶里，桶内计数就是这个词的全局次数，合并各桶 Top 100 得到的结果是精确的。

### 3、内存估算

- 每桶平均：2³⁰ B ÷ 5000 ≈ 214,748B ≈ 210KB
- 即使桶内的词全不相同，计数表里存的也只是「词 + 4 字节计数」，原始数据量和桶文件同一量级，能放进 1MB
- 合并阶段：堆里 100 个元素，每个约 16 + 4 = 20B，共约 2KB

1MB 是面试题的极限设定：Java 对象开销下（见第一节），1MB 只能放几千个 HashMap 条目。实际做法是把桶分得更细，或者放宽内存限制，思路不变。

### 4、关键步骤

1. 顺序读一遍，按 `hash(word) % 5000` 写入 5000 个小文件
2. 逐个桶：HashMap 计数 → 用 `topK(counts, 100)` 求本桶前 100 → 追加写入一个结果文件，每行「词 + 次数」，最多 5000 × 100 = 50 万行
3. 扫描结果文件，用大小为 100 的小顶堆选出全局前 100
4. 某个桶大于 1MB 时，换一个哈希种子对它再分

词的前缀重复度高（如英文文本）时，桶内也可以用 Trie 计数代替 HashMap。

---

## 四、一天日志中访问次数最多的 IP

### 1、题目

一天的访问日志有 100 亿行，每行带一个 IPv4 地址，找出访问次数最多的 IP。

### 2、思路

IPv4 只有 2³² 种取值，可以直接用「IP 当下标」的计数数组代替 HashMap。全值域的 `int[2³²]` 要 16GB，太大，Java 数组长度也只能到 2³¹ - 1。于是**按 IP 的高 8 位分成 256 个桶**，每个桶内只剩低 24 位，计数数组只需要 2²⁴ 个元素。

这里分桶用的是高位而不是哈希：计数数组大小固定为 2²⁴，与桶内数据量无关，即使某个网段的流量特别集中也不会撑爆内存。

### 3、内存估算

- 先从日志中抽出 IP，按 4 字节二进制写入：10¹⁰ × 4B = 4 × 10¹⁰ B ≈ 37GB
- 每个桶的计数数组：2²⁴ × 4B = 64MB，一次只处理一个桶
- 单个 IP 一天的次数实际上远小于 2³¹ - 1（约 21 亿），用 int 计数即可；不放心可以改用 `long[]`，每桶 128MB

### 4、关键步骤

1. 扫描日志，把每个 IP 以 `int` 写入编号为 `ip >>> 24` 的桶文件（共 256 个）
2. 逐个桶计数，记下本桶次数最多的 IP
3. 256 个候选里取最大值

```java
record IpCount(int ip, int count) {}

// high8：桶编号，即 IP 的高 8 位；桶文件里每 4 字节是一个 IP
static IpCount maxInBucket(Path bucketFile, int high8) throws IOException {
    int[] counts = new int[1 << 24];                       // 2^24 × 4B = 64MB
    long n = Files.size(bucketFile) / 4;
    try (DataInputStream in = new DataInputStream(
            new BufferedInputStream(Files.newInputStream(bucketFile), 1 << 16))) {
        for (long i = 0; i < n; i++) {
            counts[in.readInt() & 0xFFFFFF]++;             // 低 24 位作下标
        }
    }
    int best = 0;
    for (int low = 1; low < counts.length; low++) {
        if (counts[low] > counts[best]) best = low;
    }
    return new IpCount((high8 << 24) | best, counts[best]);
}
```

求的是「次数最多的前 K 个 IP」时，把第 2 步换成每桶取 Top K，再用堆合并即可。

---

## 五、海量整数中找不重复的整数

### 1、题目

2.5 亿个 int，找出其中只出现过一次的整数。

### 2、思路

**2-Bitmap**：给 int 全值域的每个值分配 2 bit，`00` 表示没出现，`01` 表示出现一次，`10` 表示出现多次。扫描一遍更新状态，再遍历位图，输出状态为 `01` 的值。

### 3、内存估算

- 原始数据：2.5 × 10⁸ × 4B = 10⁹ B ≈ 954MB
- 2-Bitmap：2³² × 2 bit = 2³³ bit = 2³⁰ B = 1GB，与数据条数无关
- 内存不到 1GB（例如 600MB）时，按符号位分两轮：第一轮只处理非负数，第二轮只处理负数，每轮的值域是 2³¹，位图 2³¹ × 2 bit = 512MB，代价是数据多读一遍

### 4、关键步骤

```java
// 2^33 bit = 2^27 个 long = 1GB；每个值占相邻 2 bit，不会跨 long
static final long[] BITS = new long[1 << 27];

static void add(int x) {
    long pos = Integer.toUnsignedLong(x) * 2;      // 把 int 映射到 0 ~ 2^32-1
    int word = (int) (pos >>> 6);
    int shift = (int) (pos & 63);
    long state = (BITS[word] >>> shift) & 3;
    if (state == 0) {
        BITS[word] |= 1L << shift;                  // 00 -> 01
    } else if (state == 1) {
        BITS[word] ^= 3L << shift;                  // 01 -> 10
    }                                               // 10 保持不变
}
```

最后按下标遍历 `BITS`，状态为 `01` 的位置 `pos / 2` 就是只出现一次的值，用 `(int) (pos / 2)` 还原成 int。

另一种做法是哈希分桶后每桶用 HashMap 计数，适合值域大（如 long）而位图放不下的情况。

---

## 六、判断一个数是否在 40 亿个整数中

### 1、题目

给定 40 亿个不重复的无符号 int（未排序），之后会有大量查询，每次问某个数是否在其中。

### 2、思路

先看查询次数：

- **只查一次**：直接顺序扫描文件比对，O(N) 时间、几乎不占内存，不需要任何数据结构
- **查询很多次**：建一个覆盖 int 全值域的 Bitmap，之后每次查询 O(1)

为什么不用布隆过滤器：它的内存按元素个数算，这里元素多、值域小，反而比位图更大，而且还有误判。

### 3、内存估算

| 方案 | 计算 | 内存 | 结果 |
|------|------|------|------|
| Bitmap | 2³² bit = 2²⁹ B | 512MB | 精确 |
| 布隆过滤器，p = 1% | 4 × 10⁹ × 9.59 bit ≈ 3.83 × 10¹⁰ bit | 约 4.46GB | 有 1% 误判 |
| 布隆过滤器，p = 0.1% | 4 × 10⁹ × 14.38 bit ≈ 5.75 × 10¹⁰ bit | 约 6.70GB | 有 0.1% 误判 |

**结论**：值域固定且不大（≤ 2³²）时用 Bitmap；key 是 URL、字符串这类无法当下标的数据时才用布隆过滤器。

### 4、关键步骤

1. 扫描一遍，对每个数 x 置位：`bits[x >>> 6] |= 1L << (x & 63)`（x 先转成 long 型的无符号值）
2. 查询时检查对应的 bit

内存不足 512MB 时，按高 8 位把数据拆成 256 个桶文件，每桶建一个 2²⁴ bit = 2MB 的小位图并存盘；查询 x 时只加载编号为 `x >>> 24` 的那个小位图，按需缓存常用的几个。

---

## 七、最热门的查询串与按频度排序

### 1、题目

- **题 A**：搜索日志中有 1000 万条查询记录，去重后不超过 300 万个，每条不超过 255 字节，内存 1GB，找出最热门的 10 个查询串
- **题 B**：10 个文件，每个 1GB，每行一个查询串，同一个查询串可能出现在多个文件里，要求把所有查询串按出现次数从高到低排序

### 2、思路

**题 A**：去重后的数据量能装进内存，直接 HashMap 计数，再用大小为 10 的小顶堆求 Top 10，不需要分桶。

**题 B**：同一个查询串分散在多个文件里，先**按查询串重新分桶**，让同一个查询串集中到同一个文件；然后每个文件各自计数、按次数排序；最后对这些有序文件做多路归并。

### 3、内存估算

**题 A**：

- 最坏情况，300 万个都是 255 字节：3 × 10⁶ × 255B ≈ 730MB，加上每条约 88B 的 HashMap 开销 3 × 10⁶ × 88B ≈ 252MB，合计约 982MB，紧贴 1GB 的上限
- 按平均 50 字节估算：3 × 10⁶ × (50 + 88)B ≈ 395MB，宽裕

所以平均长度不大时直接计数；如果确实都很长，就先按 `hash(query) % 10` 分 10 个桶，每桶求 Top 10 再合并。查询串前缀重复度高时，也可以用 Trie 计数。

**题 B**：

- 重新分桶：`hash(query) % 10`，每个新文件平均 1GB
- 每个新文件用 HashMap 计数；放不下时把桶数调大（例如 % 20）
- 归并阶段：10 个有序文件，堆里只有 10 个元素，内存可以忽略

### 4、关键步骤（题 B）

1. 顺序读 10 个原始文件，按 `hash(query) % 10` 写入 10 个新文件
2. 对每个新文件：HashMap 计数 → 按次数降序排序 → 写成「次数 + 查询串」的有序文件
3. 用 `mergeSorted` 对 10 个有序文件做 10 路归并，比较器按次数降序

也可以全程用外部排序：先按查询串字典序外排，相同的串就排在相邻位置，顺序扫描一遍得到每个串的次数；再按次数外排一次。这样不依赖 HashMap，但要多读写几遍磁盘。

---

## 八、统计不同电话号码的个数

### 1、题目

一个文件里有 50 亿条通话记录，每条带一个 11 位手机号，统计其中有多少个不同的号码。

### 2、思路

手机号是**范围有限的整数**：第一位固定是 1，后面 10 位最多 10¹⁰ 种取值。用 Bitmap，每个号码占 1 bit，出现就置位，最后统计 1 的个数。

### 3、内存估算

- 覆盖 10000000000～19999999999：10¹⁰ bit = 1.25 × 10⁹ B ≈ 1.16GB
- 只考虑 13～19 开头的号段：7 × 10⁹ bit = 8.75 × 10⁸ B ≈ 834MB
- 对比 HashSet：即使只有 10 亿个不同号码，`Long` 加上 Node 的开销每条约 48B，也要约 45GB
- 8 位的座机号：10⁸ bit ≈ 11.9MB

### 4、关键步骤

```java
static final long BASE = 10_000_000_000L;
static final long[] BITS = new long[(int) (BASE / 64)];   // 156,250,000 个 long ≈ 1.16GB

static void add(long phone) {                 // phone 范围 [10000000000, 19999999999]
    long i = phone - BASE;
    BITS[(int) (i >>> 6)] |= 1L << (i & 63);
}

static long distinct() {
    long n = 0;
    for (long w : BITS) n += Long.bitCount(w);
    return n;
}
```

只需要大致数量、能接受约 1% 的误差时，用 HyperLogLog 只要 12KB，见 [海量数据架构选型](./2_big_data#五、经典海量数据问题)。

---

## 九、5 亿个数找中位数

### 1、题目

5 亿个 int 存在文件里，内存远小于数据量，求它们的中位数。

### 2、思路

**分桶计数，两轮定位**。中位数就是第 k 小的数，不需要排序，只需要知道它落在哪个区间：

1. 第一轮：按高 16 位把值域分成 65536 个区间，只计数不存数据，累加计数找到第 k 小落在哪个区间
2. 第二轮：只看落在这个区间里的数，按低 16 位再计数一次，直接得到第 k 小的值

两轮都只用固定大小的计数数组，即使所有数都挤在同一个区间也不会爆内存。

5 亿是偶数，中位数是第 2.5 亿和第 2.5 亿 + 1 小的两个数的平均值，调用两次即可（两者通常在同一个区间，可以合并成一趟）。

### 3、内存估算

- 原始数据：5 × 10⁸ × 4B = 2 × 10⁹ B ≈ 1.86GB
- 计数数组：2 × 65536 × 8B（long）= 1MB
- 磁盘读：每求一个第 k 小读两遍文件

### 4、关键步骤

```java
// 每次调用 forEach 都会把数据文件从头顺序读一遍
interface IntSource {
    void forEach(IntConsumer action);
}

// 求第 k 小（k 从 1 开始）
static int kth(IntSource src, long k) {
    long[] high = new long[1 << 16];
    // 翻转符号位，让有符号 int 的大小顺序与无符号顺序一致
    src.forEach(x -> high[(x ^ Integer.MIN_VALUE) >>> 16]++);
    int h = 0;
    while (k > high[h]) {
        k -= high[h];
        h++;
    }
    final int target = h;
    long[] low = new long[1 << 16];
    src.forEach(x -> {
        int u = x ^ Integer.MIN_VALUE;
        if (u >>> 16 == target) low[u & 0xFFFF]++;
    });
    int l = 0;
    while (k > low[l]) {
        k -= low[l];
        l++;
    }
    return ((target << 16) | l) ^ Integer.MIN_VALUE;
}

static double median(IntSource src, long n) {
    if (n % 2 == 1) return kth(src, n / 2 + 1);
    return ((long) kth(src, n / 2) + kth(src, n / 2 + 1)) / 2.0;   // 先转 long 防止相加溢出
}
```

**能装进内存时**：数据能放进一个 `int[]`（这里约 1.86GB）时，用快速选择 O(N) 找第 k 小即可，不必排序。

**数据是持续到来的流**：要随时给出当前中位数时，用双堆——大顶堆存较小的一半，小顶堆存较大的一半，两边数量差不超过 1，中位数取自堆顶，见 [堆](/algorithms/1_data_structures/4_heap)。双堆要存下全部数据，所以只适合数据量能放进内存的情况。

---

## 十、Top K 的通用套路

### 1、题目

从海量数据中找最大的 K 个数（例如 1 亿个数中找最大的 500 个），或出现频率最高的 K 个元素。

### 2、思路

先分清是求**数值** Top K 还是**频率** Top K：

| 场景 | 方法 | 复杂度 |
|------|------|--------|
| 数值 Top K，数据顺序读一遍 | 大小为 K 的小顶堆 | 时间 O(N log K)，空间 O(K) |
| 数值 Top K，数据能全部装进内存 | 快速选择找到第 K 大，再取它左边的部分 | 平均 O(N) |
| 频率 Top K，去重后放得下 | HashMap 计数 + 小顶堆 | 计数 O(N)，选取 O(M log K)，M 为不同元素数 |
| 频率 Top K，去重后放不下 | 哈希分桶 → 每桶计数并求 Top K → 合并 | 磁盘多读写一遍 |
| 数据分布在多台机器 | 按 key 重新分区 → 各机 Top K → 汇总 | 多一次网络传输 |

### 3、内存估算

以 1 亿个数找最大的 500 个为例：堆里只有 500 个元素，内存可以忽略；每个数最多做一次 log₂500 ≈ 9 层的堆调整，最坏约 10⁸ × 9 = 9 × 10⁸ 次比较。实际上堆填满以后，大部分数比堆顶小，只需比较一次就跳过。

### 4、关键步骤：多机时的陷阱

**数值 Top K** 可以直接合并：每个数只在一台机器上出现一次，各机本地 Top K 的并集一定包含全局 Top K，汇总时从 机器数 × K 个候选里再选一次即可。

**频率 Top K** 不能直接合并各机的本地结果。反例：两台机器，K = 1，

| 机器 | 计数 | 本地 Top 1 |
|------|------|-----------|
| 机器 1 | X = 10，A = 9 | X |
| 机器 2 | Y = 10，A = 9 | Y |

汇总本地结果会得到 X 或 Y（10 次），但全局 A 出现了 18 次，才是真正的 Top 1。正确做法是先按 `hash(key)` 重新分区（MapReduce 的 shuffle），让同一个 key 的记录集中到同一台机器，再求本地 Top K 并汇总。这与第二节单机分桶的原理相同。

实时场景（如秒级热点 key 发现）用 Count-Min Sketch 加堆近似统计，热点探测与应对见 [热点问题](/high-con/6_hotspot)。

---

## 十一、方法速查

| 问题 | 方法 | 关键数据结构 |
|------|------|--------------|
| 两个大文件找相同 URL | 同一哈希函数分桶，逐对求交集；允许误差用布隆过滤器 | HashSet、布隆过滤器 |
| 海量文本找高频词 | 哈希分桶计数，各桶 Top K 再合并 | HashMap、小顶堆、Trie |
| 访问次数最多的 IP | 按高 8 位分桶，桶内用低 24 位作下标计数 | int 计数数组 |
| 找不重复的整数 | 2 bit 记录三种状态 | 2-Bitmap |
| 判断数是否在 40 亿个整数中 | 一次查询直接扫描；多次查询建位图 | Bitmap |
| 最热门查询串 / 按频度排序 | 放得下直接计数；放不下按 query 重新分桶，计数排序后多路归并 | HashMap、小顶堆、外部排序 |
| 不同电话号码个数 | 号码减去基数作下标，统计 1 的个数 | Bitmap |
| 5 亿个数的中位数 | 高 16 位、低 16 位两轮计数定位第 k 小 | 计数数组；数据流用双堆 |
| Top K | 小顶堆；频率类先计数；多机先 shuffle | 小顶堆、HashMap |

---

## 小结

- 先算内存账：数据总量、去重后 key 数、可用内存；Java 中 HashMap 每个条目额外约 88B，常常比数据本身还大
- 哈希分桶保证同一个 key 落在同一个桶，桶间结果直接合并；多个文件必须用同一个哈希函数和桶数，倾斜的桶换种子再分
- key 是范围有限的整数时用 Bitmap，内存只和值域有关：int 全值域 512MB，2-Bitmap 1GB，手机号约 1.16GB
- 布隆过滤器的内存按元素个数算，p = 1% 约每个元素 9.6 bit；值域小而元素多时它比 Bitmap 更大，且误判方向是「多报」
- 求第 k 小不必排序：高 16 位、低 16 位两轮计数，1MB 内存即可定位 5 亿个数的中位数
- 频率 Top K 在多机或随机分片时不能直接合并本地 Top K，必须先按 key 重新分区

## 参考资料

- 选题参考：doocs/advanced-java：[https://github.com/doocs/advanced-java](https://github.com/doocs/advanced-java)
- Bloom filter（误判率与参数公式）：[https://en.wikipedia.org/wiki/Bloom_filter](https://en.wikipedia.org/wiki/Bloom_filter)
- External sorting：[https://en.wikipedia.org/wiki/External_sorting](https://en.wikipedia.org/wiki/External_sorting)
- Count–min sketch：[https://en.wikipedia.org/wiki/Count%E2%80%93min_sketch](https://en.wikipedia.org/wiki/Count%E2%80%93min_sketch)
- JDK 21 API：[PriorityQueue](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/PriorityQueue.html)

> 下一篇：[秒杀](./4_seckill) —— 分层限流、Redis 原子预扣、MQ 异步下单与超时关单的完整链路。
