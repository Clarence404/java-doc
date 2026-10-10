# 数据结构与算法总览

本模块从复杂度分析出发，讲常用数据结构、基础算法与解题技巧，最后按题型整理刷题清单。定位是后端基本功：选对集合、估准复杂度。

**版本基线（2026 年 10 月）**：JDK 21

---

## 一、模块导航

<ModuleNav />

---

## 二、推荐阅读路径

1. **复杂度**：先读 [复杂度分析](./0_complexity)，掌握大 O、均摊分析和常见操作的复杂度，后面所有取舍都以它为准
2. **数据结构**：按顺序读 [数组与链表](./1_data_structures/0_array_list) → [栈与队列](./1_data_structures/1_stack_queue) → [哈希表](./1_data_structures/2_hash_table) → [树](./1_data_structures/3_tree) → [堆](./1_data_structures/4_heap) → [图](./1_data_structures/5_graph) → [字典树（Trie）](./1_data_structures/6_trie)
3. **基础算法**：[搜索算法](./2_algorithms/0_search) → [排序算法](./2_algorithms/1_sort) → [分治算法](./2_algorithms/2_divide_conquer) → [回溯算法](./2_algorithms/3_backtrack) → [贪心算法](./2_algorithms/4_greedy) → [动态规划](./2_algorithms/5_dynamic_programming)；动态规划和分治、贪心同属算法思想，已从「算法技巧」移到「基础算法」
4. **算法技巧**：[双指针](./3_patterns/1_two_pointers)、[滑动窗口](./3_patterns/2_sliding_window)、[前缀和与差分数组](./3_patterns/3_prefix_sum)、[位运算](./3_patterns/4_bit_manipulation)，都是把暴力解法降一个数量级的常用套路
5. **刷题实战**：按 [LeetCode 高频题分类](./4_practice/0_leet_code) 逐类刷题，机考前再看 [华为 OJ 题型与技巧](./4_practice/1_huawei_oj)

[高频面试题](./99_interview) 只列题目，答案在 [算法面试题解答](/interview/4_algorithms)。

---

## 三、关联模块

代码方法签名采用 LeetCode 风格（`int[] nums`、`ListNode head`），数据结构优先使用 JDK 自带实现（`ArrayDeque`、`PriorityQueue`、`HashMap`、`TreeMap`）；JDK 集合的源码细节统一放在 [集合框架](/java/21_topic_collection)，本模块只讲算法视角。

- [集合框架](/java/21_topic_collection)：`ArrayList`、`HashMap`、`TreeMap`、`PriorityQueue` 等 JDK 实现的源码细节
- [MySQL 索引](/database/1_mysql/4_topic_index)：B+ 树在 InnoDB 中的落地、聚簇索引与回表
- [海量数据算法题](/scenario/3_massive_data)：哈希分桶、堆求 Top K、Bitmap、Trie、外部排序在大数据量下的组合用法
- [JVM](/jvm/0_overview)：递归深度与栈溢出、对象开销对数据结构内存占用的影响
- [算法面试题解答](/interview/4_algorithms)：本模块高频问题的答案汇总
