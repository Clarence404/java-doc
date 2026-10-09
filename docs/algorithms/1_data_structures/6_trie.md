---
description: 前缀树结构、数组 / Map 实现、删除与剪枝、前缀计数、AC 自动机、压缩前缀树、最大异或
---

# 字典树（Trie）

> **本篇目标**：理解字典树如何用共享前缀组织字符串，能写出插入、查找、前缀匹配和删除，并会用二进制 Trie 求最大异或值。
>
> **前置阅读**：[树](./3_tree)、[哈希表](./2_hash_table)

字典树又称前缀树，是专门处理**字符串前缀匹配**的多叉树。每条边代表一个字符，从根到某个节点的路径拼出一个前缀；节点上的 `isEnd` 标记表示「有单词恰好在这里结束」。单词不一定结束在叶子上：插入 `app` 和 `apple` 后，`app` 结束在一个内部节点。

哈希表也能 O(L) 判断一个单词是否存在，但回答不了「有哪些单词以 `ap` 开头」。字典树把公共前缀只存一份，前缀查询只需沿路径走 L 步，与字典里有多少单词无关。

---

## 一、结构与原理

![字典树：插入 app、apple、bat、ban 之后，绿色节点 isEnd = true](../../assets/algorithms/trie_structure.svg)

- 每个节点包含：子节点映射（`children[26]` 或 `Map<Character, TrieNode>`）和 `isEnd` 标记
- 字符记在边上（实现时就是 `children` 的下标或 key），根节点不对应任何字符
- 公共前缀共享节点：图中 `app` 与 `apple` 共用 a-p-p，`bat` 与 `ban` 共用 b-a
- 插入、查找、前缀匹配都是 **O(L)**，L 为字符串长度

---

## 二、Java 实现

### 1、基于 Map：字符集不固定时使用

```java
class Trie {
    private final TrieNode root = new TrieNode();

    private static class TrieNode {
        final Map<Character, TrieNode> children = new HashMap<>();
        boolean isEnd;
    }

    /** 插入单词：沿路径走，缺的节点就新建 */
    public void insert(String word) {
        TrieNode node = root;
        for (char c : word.toCharArray()) {
            node = node.children.computeIfAbsent(c, k -> new TrieNode());
        }
        node.isEnd = true;
    }

    /** 精确查找：路径走完且终点 isEnd = true */
    public boolean search(String word) {
        TrieNode node = findNode(word);
        return node != null && node.isEnd;
    }

    /** 前缀查找：路径能走完即可，不看 isEnd */
    public boolean startsWith(String prefix) {
        return findNode(prefix) != null;
    }

    private TrieNode findNode(String s) {
        TrieNode node = root;
        for (char c : s.toCharArray()) {
            node = node.children.get(c);
            if (node == null) return null;
        }
        return node;
    }
}
```

`computeIfAbsent` 只在子节点不存在时才创建新节点；写成 `putIfAbsent(c, new TrieNode())` 则每个字符都会先 `new` 一个节点再决定是否放入，已有路径上的字符白白创建了对象。

### 2、基于数组：字符集固定且较小时更快

只含小写字母时，用长度 26 的数组代替 `HashMap`，省去哈希计算和装箱：

```java
private static class TrieNode {
    final TrieNode[] children = new TrieNode[26];
    boolean isEnd;
}

// 访问子节点：node.children[c - 'a']
```

代价是每个节点固定占 26 个引用，字符集大（如中文）或数据稀疏时浪费严重，这时用 `Map` 版本。

### 3、删除

删除先取消终点的 `isEnd`，再从下往上回收**既不是单词结尾、也没有孩子**的节点。只取消标记不回收也能保证正确性，但会留下无用节点：

```java
// 加在 Map 版本的 Trie 中；返回值表示调用方是否应该删掉 node
public void delete(String word) {
    delete(root, word, 0);
}

private boolean delete(TrieNode node, String word, int depth) {
    if (depth == word.length()) {
        if (!node.isEnd) return false;            // 单词不存在
        node.isEnd = false;
        return node.children.isEmpty();
    }
    char c = word.charAt(depth);
    TrieNode child = node.children.get(c);
    if (child == null) return false;              // 单词不存在
    if (delete(child, word, depth + 1)) {
        node.children.remove(c);                  // 子节点已无用，剪掉
    }
    return node != root && !node.isEnd && node.children.isEmpty();
}
```

例如在上图中删除 `apple`：先取消 e 的 `isEnd`，e 没有孩子被剪掉，l 随之变空也被剪掉；p（`app` 的结尾）`isEnd` 为真，保留，回收到此为止。

### 4、复杂度

| 操作 | 时间 | 说明 |
|------|------|------|
| 插入 | O(L) | 逐字符走路径，缺节点就建 |
| 精确查找 | O(L) | 路径走完且 `isEnd = true` |
| 前缀查找 | O(L) | 路径能走完即可 |
| 删除 | O(L) | 取消 `isEnd` 后自底向上剪掉无用节点 |

空间最坏为所有单词长度之和乘以每个节点的大小。前缀重复度低时，Java 中每个节点的对象头和 `children` 开销会让字典树比直接存 `HashSet<String>` 更占内存。

---

## 三、应用场景

| 场景 | 做法 |
|------|------|
| 自动补全 / 搜索提示 | 走到前缀对应的节点，再 DFS 收集其下所有 `isEnd` 节点；工程实现见 [搜索](/scenario/9_search_system) |
| 词频与前缀统计 | 节点上记计数，见下文计数 Trie；海量词频场景见 [海量数据算法题](/scenario/3_massive_data) |
| 敏感词过滤 | 用全部敏感词建 Trie，再加失配指针构成 AC 自动机，一次扫描文本就能找出所有命中的词 |
| 单词搜索（网格 DFS + Trie） | 所有目标词建成一棵 Trie，DFS 时同步沿 Trie 走，前缀不存在立刻剪枝 |
| 最长前缀匹配 | IP 路由表按二进制位建 Trie，查找时记录沿途最后一个有效前缀 |
| 最大异或 | 二进制 Trie，逐位贪心选相反的位 |

**AC 自动机**：在 Trie 上为每个节点加一条失配指针（fail 指针），指向「当前路径的最长真后缀」在 Trie 中对应的节点，思路与 KMP 的 next 数组相同。匹配失败时沿 fail 指针跳转，文本中的每个字符只扫描一次，就能同时匹配所有模式串，复杂度与文本长度加匹配次数成线性。

**压缩前缀树（Radix Tree / Patricia Trie）**：把只有一个孩子的链状节点合并成一个节点，边上存字符串而不是单个字符，大幅减少节点数。路由器的最长前缀匹配、许多 Web 框架的 URL 路由匹配都使用这种压缩形式。

---

## 四、进阶变体

### 1、计数 Trie

在节点上记录经过该节点的单词数和以它结尾的单词数，就能 O(L) 回答「以某前缀开头的单词有几个」「某单词插入了几次」：

```java
private static class TrieNode {
    final TrieNode[] children = new TrieNode[26];
    int pass;    // 经过该节点的单词数，即以该前缀开头的单词数
    int end;     // 恰好在该节点结束的单词数
}

void insert(TrieNode root, String word) {
    TrieNode node = root;
    node.pass++;
    for (char c : word.toCharArray()) {
        int i = c - 'a';
        if (node.children[i] == null) node.children[i] = new TrieNode();
        node = node.children[i];
        node.pass++;
    }
    node.end++;
}
```

### 2、二进制 Trie：最大异或值

把每个整数按二进制位**从高到低**插入 Trie，每个节点只有 0、1 两个孩子。查询某个数 x 能得到的最大异或值时，从最高位开始贪心：x 当前位是 b，就优先走 1 − b 的分支，这一位异或结果为 1；高位的 1 比后面所有低位加起来都大，所以逐位贪心就是最优解。

```java
// LeetCode 421 数组中两个数的最大异或值，nums[i] ≥ 0
int findMaximumXOR(int[] nums) {
    final int HIGH_BIT = 30;               // 0 ≤ nums[i] ≤ 2^31 - 1，最高位是第 30 位
    // 一维数组模拟节点：节点 node 的 0 / 1 孩子编号存在 next[2 * node] 和 next[2 * node + 1]，0 号为根
    int[] next = new int[2 * (nums.length * (HIGH_BIT + 1) + 1)];
    int nodeCount = 1;
    int best = 0;

    for (int num : nums) {
        // 插入 num
        int node = 0;
        for (int bit = HIGH_BIT; bit >= 0; bit--) {
            int b = (num >> bit) & 1;
            if (next[2 * node + b] == 0) next[2 * node + b] = nodeCount++;
            node = next[2 * node + b];
        }
        // 查询 num 与已插入的数（包括自身，自身异或为 0 不影响结果）能得到的最大异或
        node = 0;
        int xor = 0;
        for (int bit = HIGH_BIT; bit >= 0; bit--) {
            int b = (num >> bit) & 1;
            if (next[2 * node + (1 - b)] != 0) {   // 相反的位存在：这一位能得到 1
                xor |= 1 << bit;
                node = next[2 * node + (1 - b)];
            } else {
                node = next[2 * node + b];
            }
        }
        best = Math.max(best, xor);
    }
    return best;
}
```

每个数插入和查询都是 31 步，总复杂度 O(31 × n)。用一维数组模拟节点（存子节点编号，0 表示不存在）比创建大量节点对象或 `int[][]` 小数组更省内存，这是竞赛和刷题中常见的写法。

---

## 五、经典题目

| 题目 | 考点 |
|------|------|
| LeetCode 208 实现 Trie (前缀树) | 基础实现 |
| LeetCode 211 添加与搜索单词 - 数据结构设计 | Trie + DFS 处理通配符 `.` |
| LeetCode 212 单词搜索 II | 网格 DFS + Trie 剪枝 |
| LeetCode 421 数组中两个数的最大异或值 | 二进制 Trie |
| LeetCode 1268 搜索推荐系统 | Trie / 排序 + 二分 |
| LeetCode 336 回文对 | Trie + 回文判断 |

---

## 小结

- 字典树把公共前缀只存一份，插入、查找、前缀匹配都是 O(L)，与字典大小无关
- 单词可以结束在内部节点，靠 `isEnd` 区分「是单词」和「只是前缀」
- 插入用 `computeIfAbsent`；小写字母用数组节点，字符集大用 `Map` 节点
- 删除时取消 `isEnd`，再自底向上剪掉既非结尾又无孩子的节点
- AC 自动机 = Trie + 失配指针，用于多模式匹配；压缩前缀树合并单链节点，用于路由匹配
- 二进制 Trie 从高位到低位贪心选相反位，求最大异或值

## 参考资料

- Hello 算法：[https://www.hello-algo.com/](https://www.hello-algo.com/)
- OI Wiki · 字典树：[https://oi-wiki.org/string/trie/](https://oi-wiki.org/string/trie/)
- OI Wiki · AC 自动机：[https://oi-wiki.org/string/ac-automaton/](https://oi-wiki.org/string/ac-automaton/)
- LeetCode 208 实现 Trie (前缀树)：[https://leetcode.cn/problems/implement-trie-prefix-tree/](https://leetcode.cn/problems/implement-trie-prefix-tree/)

> 下一篇：[搜索算法](../2_algorithms/0_search) —— 二分查找模板与边界、二分答案、DFS / BFS 模板。
