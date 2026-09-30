# 数据结构与算法总览

算法模块覆盖复杂度分析、常用数据结构、基础算法、算法技巧与刷题实战。阅读时建议先建立复杂度意识，再按“数据结构 → 基础算法 → 解题技巧 → 刷题”的顺序推进。

## 一、模块导航

| 分组 | 文档 | 覆盖内容 |
|------|------|----------|
| 基础 | [复杂度分析](./0_complexity) | 时间 / 空间复杂度、算法权衡、常见操作复杂度速查 |
| 数据结构 | [数组 & 链表](./1_data_structures/0_array_list) | 顺序存储与链式存储 |
| | [栈 & 队列](./1_data_structures/1_stack_queue) | 栈、单调栈、队列、双端队列、优先队列 |
| | [哈希表](./1_data_structures/2_hash_table) | 哈希表原理、HashMap / HashSet / LinkedHashMap / TreeMap |
| | [树](./1_data_structures/3_tree) | 二叉树、BST、AVL、红黑树、B / B+ 树 |
| | [堆](./1_data_structures/4_heap) | 二叉堆、优先队列、Top K |
| | [图](./1_data_structures/5_graph) | 存储方式、BFS / DFS、拓扑排序 |
| | [字典树 Trie](./1_data_structures/6_trie) | 结构原理、Java 实现、应用场景与进阶变体 |
| 基础算法 | [搜索算法](./2_algorithms/0_search) | 二分查找、DFS / BFS |
| | [排序算法](./2_algorithms/1_sort) | 常见排序算法与稳定性、复杂度对比 |
| | [分治算法](./2_algorithms/2_divide_conquer) | 分治思想、主定理、分治 vs 动态规划 |
| | [回溯算法](./2_algorithms/3_backtrack) | 排列、组合、剪枝 |
| | [贪心算法](./2_algorithms/4_greedy) | 局部最优与适用条件 |
| 算法技巧 | [动态规划](./3_patterns/0_dynamic_programming) | 一维 / 二维 DP、背包问题、区间 DP |
| | [双指针](./3_patterns/1_two_pointers) | 对撞指针、快慢指针、与滑动窗口的区别 |
| | [滑动窗口](./3_patterns/2_sliding_window) | 子串 / 子数组问题 |
| | [前缀和 & 差分](./3_patterns/3_prefix_sum) | 区间和与区间修改 |
| | [位运算](./3_patterns/4_bit_manipulation) | 常用位运算技巧、状态压缩 |
| 刷题实战 | [LeetCode](./4_practice/0_leet_code) | 按数据结构分类的高频题 |
| | [HuaWei Code](./4_practice/1_huawei_oj) | 输入输出处理、高频题型、常用 API 速查 |

## 二、推荐阅读路径

1. 先读 [复杂度分析](./0_complexity)，建立评价算法优劣的统一标准。
2. 再按顺序学习数据结构，重点掌握 [哈希表](./1_data_structures/2_hash_table)、[树](./1_data_structures/3_tree)、[堆](./1_data_structures/4_heap)。
3. 然后学习 [搜索](./2_algorithms/0_search)、[排序](./2_algorithms/1_sort) 等基础算法。
4. 最后用 [动态规划](./3_patterns/0_dynamic_programming)、[双指针](./3_patterns/1_two_pointers)、[滑动窗口](./3_patterns/2_sliding_window) 等技巧配合 [LeetCode](./4_practice/0_leet_code) 刷题巩固。

## 三、关联模块

- Java 集合框架中的数据结构实现（HashMap / TreeMap 红黑树）→ [Java 专项 - 集合框架](/java/21_topic_collection)
