---
description: 结构原理、Java 实现、应用场景与进阶变体
---

# 字典树（Trie）

> 又称前缀树、单词查找树，是专门处理**字符串前缀匹配**的树形数据结构，每条边代表一个字符，根到叶路径拼出一个完整单词。

---

## 一、结构与原理

```
         root
        /    \
       a      b
      /         \
     p            a
    /               \
   p                 t
  /
 l
 e
```

- 每个节点包含：子节点映射（`children[26]` 或 `Map<Character, TrieNode>`）+ `isEnd` 标志
- 公共前缀共享节点，空间换时间
- 插入/查找时间复杂度：**O(L)**，L 为字符串长度，与字典大小无关

---

## 二、Java 实现

```java
class Trie {
    private TrieNode root;

    public Trie() {
        root = new TrieNode();
    }

    /** 插入单词 */
    public void insert(String word) {
        TrieNode node = root;
        for (char c : word.toCharArray()) {
            node.children.putIfAbsent(c, new TrieNode());
            node = node.children.get(c);
        }
        node.isEnd = true;
    }

    /** 精确查找 */
    public boolean search(String word) {
        TrieNode node = searchPrefix(word);
        return node != null && node.isEnd;
    }

    /** 前缀查找 */
    public boolean startsWith(String prefix) {
        return searchPrefix(prefix) != null;
    }

    private TrieNode searchPrefix(String s) {
        TrieNode node = root;
        for (char c : s.toCharArray()) {
            node = node.children.get(c);
            if (node == null) return null;
        }
        return node;
    }

    static class TrieNode {
        Map<Character, TrieNode> children = new HashMap<>();
        boolean isEnd;
    }
}
```

固定字母表（只含小写字母）时用数组更快：

```java
static class TrieNode {
    TrieNode[] children = new TrieNode[26];
    boolean isEnd;
}
// 访问：node.children[c - 'a']
```

---

## 三、核心操作

| 操作 | 时间 | 说明 |
|------|------|------|
| 插入 | O(L) | 逐字符建路径，末尾标 isEnd |
| 精确查找 | O(L) | 路径走完且 isEnd = true |
| 前缀查找 | O(L) | 路径能走完即可，不看 isEnd |
| 删除 | O(L) | 递归回溯清空无引用节点 |

---

## 四、应用场景

| 场景 | 说明 |
|------|------|
| 自动补全 / 搜索提示 | 查找所有以输入为前缀的单词 |
| 拼写检查 | 精确查找 + 编辑距离 |
| 敏感词过滤 | AC 自动机（Trie + KMP 失配指针） |
| 单词搜索（DFS + Trie） | 矩阵中同时搜索多个单词，比逐个 DFS 快 |
| IP 路由最长前缀匹配 | 二进制 Trie，每位是 0/1 |
| 位运算最大异或 | 二进制 Trie，贪心选异位 |

---

## 五、进阶变体

### 5.1 计数 Trie（统计前缀出现次数）

```java
static class TrieNode {
    TrieNode[] children = new TrieNode[26];
    int count;      // 经过该节点的单词数
    int endCount;   // 以该节点结尾的单词数
}
```

### 5.2 二进制 Trie（最大异或值）

```java
// 将整数按位（从高位到低位）插入 Trie
// 查询时贪心选择与当前位相反的子节点
int maxXor(int[] nums) {
    // 建 binary trie，对每个 num 查询能取得的最大异或
}
```

---

## 六、经典题目

| 题目 | 难度 | 考点 |
|------|------|------|
| LC 208 实现 Trie | Medium | 基础实现 |
| LC 211 添加与搜索单词（含通配符 `.`） | Medium | DFS + Trie |
| LC 212 单词搜索 II | Hard | 矩阵 DFS + Trie 剪枝 |
| LC 421 数组中两个数最大异或值 | Medium | 二进制 Trie |
| LC 336 回文对 | Hard | Trie + 回文判断 |
| LC 1268 搜索推荐系统 | Medium | 排序 + 前缀查找 |
