---
description: 哈希表原理、HashMap / HashSet / LinkedHashMap / TreeMap
---

# 哈希表

---

## 一、哈希表原理

哈希表（Hash Table）通过**哈希函数**将 key 映射到数组下标，实现平均 O(1) 的增删查。

```
key → hash(key) % capacity → 数组下标 → 存储 value
```

### 1.1 哈希函数设计

好的哈希函数需满足：
- **确定性**：相同 key 得到相同哈希值
- **均匀性**：尽量均匀分布，减少冲突
- **高效性**：计算速度快

```java
// 常用方式：取模法
int hash(int key, int capacity) {
    return key % capacity;
}

// 字符串哈希（Java String.hashCode() 类似）
int hash(String s) {
    int h = 0;
    for (char c : s.toCharArray()) {
        h = h * 31 + c; // 31 是质数，减少冲突
    }
    return h;
}
```

### 1.2 哈希冲突解决

**链地址法（Java HashMap 使用）：**
同一下标的多个 key 用链表（或红黑树）存储。

```
index 3 → [key1:val1] → [key2:val2] → null
```

**开放寻址法：**
冲突时按规则找下一个空槽（线性探测/二次探测/双重哈希）。

---

## 二、Java HashMap 原理

### 2.1 数据结构

- 底层：数组 + 链表 + 红黑树
- 初始容量：16，负载因子：0.75
- 扩容：容量翻倍，重新哈希（rehash）
- 链表长度 > 8 且数组容量 ≥ 64 → 转红黑树

### 2.2 put 流程

```
1. 计算 key 的 hashCode，再做扰动（高低16位异或）
2. (capacity - 1) & hash 得到数组下标
3. 若该位置为空 → 直接插入
4. 若不为空 → 遍历链表/树：
   - key 相同 → 覆盖旧值
   - key 不同 → 追加到链表尾（或插入红黑树）
5. 若 size > capacity * loadFactor → 扩容
```

### 2.3 常用操作

```java
Map<String, Integer> map = new HashMap<>();
map.put("a", 1);
map.get("a");                          // 1
map.getOrDefault("b", 0);             // 0（不存在时返回默认值）
map.containsKey("a");                  // true
map.remove("a");
map.putIfAbsent("c", 3);              // 不存在时才 put

// 遍历
for (Map.Entry<String, Integer> entry : map.entrySet()) {
    System.out.println(entry.getKey() + " -> " + entry.getValue());
}

// 统计词频（merge 方法）
map.merge(word, 1, Integer::sum);     // 等价于 map.put(word, map.getOrDefault(word, 0) + 1)

// 计数 / 分组
Map<Integer, List<String>> groups = new HashMap<>();
groups.computeIfAbsent(key, k -> new ArrayList<>()).add(value);
```

---

## 三、HashSet

```java
Set<Integer> set = new HashSet<>();
set.add(1); set.add(2); set.add(1); // {1, 2}，自动去重
set.contains(1);  // true
set.remove(1);

// 求交集
Set<Integer> intersection = new HashSet<>(set1);
intersection.retainAll(set2);

// 求并集
Set<Integer> union = new HashSet<>(set1);
union.addAll(set2);
```

---

## 四、LinkedHashMap（有序哈希）

保留插入顺序（或访问顺序），可用来实现 LRU 缓存：

```java
// 按访问顺序排列（LRU）
LinkedHashMap<Integer, Integer> lru = new LinkedHashMap<>(16, 0.75f, true) {
    @Override
    protected boolean removeEldestEntry(Map.Entry<Integer, Integer> eldest) {
        return size() > capacity; // 超过容量时自动淘汰最久未访问的
    }
};
```

---

## 五、TreeMap（有序 Map）

基于红黑树，按 key 自然排序（或自定义比较器），支持范围查询：

```java
TreeMap<Integer, String> treeMap = new TreeMap<>();
treeMap.put(3, "c"); treeMap.put(1, "a"); treeMap.put(2, "b");
treeMap.firstKey();                      // 1（最小 key）
treeMap.lastKey();                        // 3（最大 key）
treeMap.floorKey(2);                      // 2（≤ 2 的最大 key）
treeMap.ceilingKey(2);                    // 2（≥ 2 的最小 key）
treeMap.subMap(1, true, 3, false);       // [1, 3) 的子 map
```

---

## 六、哈希表 vs 其他结构

| | HashMap | TreeMap | LinkedHashMap |
|--|---------|---------|---------------|
| 底层 | 数组+链表+树 | 红黑树 | 数组+链表+树+双向链表 |
| 时间复杂度 | O(1) 平均 | O(log n) | O(1) 平均 |
| 有序 | ❌ | ✅ key 有序 | ✅ 插入/访问顺序 |
| 适用 | 通用高速查找 | 有序/范围查询 | LRU/保序遍历 |

---

## 七、经典题目

| 题目 | 考点 |
|------|------|
| LeetCode 1 两数之和 | HashMap 记录下标 |
| LeetCode 49 字母异位词分组 | 排序后作为 key |
| LeetCode 128 最长连续序列 | HashSet 判断起点 |
| LeetCode 146 LRU 缓存 | LinkedHashMap |
| LeetCode 380 O(1) 时间插删随机获取 | HashMap + 数组 |
| LeetCode 560 和为 K 的子数组 | 前缀和 + HashMap |
