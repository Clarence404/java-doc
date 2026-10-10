---
description: 按题型分类的 LeetCode 高频题、难度与考点、解题切入点、讲解位置、刷题方法
---

# LeetCode 高频题分类

> 前置阅读：[复杂度分析](../0_complexity)

本页是全站唯一的 LeetCode 分类题单，把本模块讲过的高频题按题型汇总，作为刷题与复习的索引。每类给出解题切入点和讲解位置，题目名称与难度以力扣中国站（leetcode.cn）为准。

---

## 一、数组与字符串

**切入点**：先想能不能排序（排序后用双指针或二分）；不能改变顺序就考虑哈希表或前缀和；原地修改多用快慢指针；矩阵题先找下标变换规律再模拟。

各篇文章只讲解题目本身，不再重复列表；「讲解」一列指向给出解法或思路的文章，标「—」的题目本模块暂未展开。

| 题目 | 难度 | 考点 | 讲解 |
|------|------|------|------|
| LeetCode 1 两数之和 | 简单 | 哈希表 | [哈希表](../1_data_structures/2_hash_table) |
| LeetCode 26 删除有序数组中的重复项 | 简单 | 快慢指针 | [双指针](../3_patterns/1_two_pointers) |
| LeetCode 27 移除元素 | 简单 | 快慢指针 | [双指针](../3_patterns/1_two_pointers) |
| LeetCode 48 旋转图像 | 中等 | 矩阵原地变换 | — |
| LeetCode 54 螺旋矩阵 | 中等 | 模拟 | — |
| LeetCode 238 除了自身以外数组的乘积 | 中等 | 前缀积 + 后缀积 | — |
| LeetCode 128 最长连续序列 | 中等 | 哈希集合 | [哈希表](../1_data_structures/2_hash_table) |

---

## 二、链表

**切入点**：画图模拟指针变化；加哨兵结点（dummy）省去头结点的特判；快慢指针解决判环与找中点；合并多路有序链表用堆或对半分治。

| 题目 | 难度 | 考点 | 讲解 |
|------|------|------|------|
| LeetCode 206 反转链表 | 简单 | 迭代 / 递归 | [数组与链表](../1_data_structures/0_array_list) |
| LeetCode 21 合并两个有序链表 | 简单 | 哨兵结点 | [数组与链表](../1_data_structures/0_array_list) |
| LeetCode 141 环形链表 | 简单 | 快慢指针 | [双指针](../3_patterns/1_two_pointers) |
| LeetCode 142 环形链表 II | 中等 | Floyd 找入口 | [双指针](../3_patterns/1_two_pointers) |
| LeetCode 876 链表的中间结点 | 简单 | 快慢指针 | [双指针](../3_patterns/1_two_pointers) |
| LeetCode 19 删除链表的倒数第 N 个结点 | 中等 | 固定间距指针 | [双指针](../3_patterns/1_two_pointers) |
| LeetCode 148 排序链表 | 中等 | 链表归并排序 | [数组与链表](../1_data_structures/0_array_list) |
| LeetCode 23 合并 K 个升序链表 | 困难 | 对半分治 / 小顶堆 | [分治算法](../2_algorithms/2_divide_conquer) |
| LeetCode 25 K 个一组翻转链表 | 困难 | 分段反转 | — |

---

## 三、栈与队列

**切入点**：括号匹配直接用栈；见到「下一个更大 / 更小元素」想单调栈；滑动窗口最值用单调双端队列；栈和队列都用 `ArrayDeque`。

| 题目 | 难度 | 考点 | 讲解 |
|------|------|------|------|
| LeetCode 20 有效的括号 | 简单 | 栈 | [栈与队列](../1_data_structures/1_stack_queue) |
| LeetCode 232 用栈实现队列 | 简单 | 双栈 | [栈与队列](../1_data_structures/1_stack_queue) |
| LeetCode 739 每日温度 | 中等 | 单调栈 | [栈与队列](../1_data_structures/1_stack_queue) |
| LeetCode 84 柱状图中最大的矩形 | 困难 | 单调栈 | [栈与队列](../1_data_structures/1_stack_queue) |
| LeetCode 42 接雨水 | 困难 | 双指针 / 单调栈 | [双指针](../3_patterns/1_two_pointers) |
| LeetCode 239 滑动窗口最大值 | 困难 | 单调双端队列 | [滑动窗口](../3_patterns/2_sliding_window) |

---

## 四、哈希表与设计

**切入点**：需要 O(1) 查找就上哈希表；设计题先写出每个操作要求的复杂度，再组合数据结构（哈希表 + 双向链表、哈希表 + 动态数组）。

| 题目 | 难度 | 考点 | 讲解 |
|------|------|------|------|
| LeetCode 49 字母异位词分组 | 中等 | 排序后的字符串作 key | [哈希表](../1_data_structures/2_hash_table) |
| LeetCode 146 LRU 缓存 | 中等 | 哈希表 + 双向链表 / `LinkedHashMap` | [哈希表](../1_data_structures/2_hash_table) |
| LeetCode 380 O(1) 时间插入、删除和获取随机元素 | 中等 | 哈希表 + 动态数组，删除时与末尾交换 | [哈希表](../1_data_structures/2_hash_table) |

---

## 五、堆

**切入点**：Top K 用大小为 K 的堆（求最大的 K 个用小顶堆）；动态中位数用大顶堆 + 小顶堆；多路归并每次取最小也用堆。

| 题目 | 难度 | 考点 | 讲解 |
|------|------|------|------|
| LeetCode 215 数组中的第K个最大元素 | 中等 | 小顶堆 / 快速选择 | [堆](../1_data_structures/4_heap) |
| LeetCode 347 前 K 个高频元素 | 中等 | 哈希计数 + 堆 | [堆](../1_data_structures/4_heap) |
| LeetCode 295 数据流的中位数 | 困难 | 双堆 | [堆](../1_data_structures/4_heap) |

---

## 六、树

**切入点**：优先考虑递归；前 / 中 / 后序对应信息传递方向，后序适合自底向上汇总子树结果；层序遍历用 BFS；二叉搜索树利用「中序遍历有序」。

| 题目 | 难度 | 考点 | 讲解 |
|------|------|------|------|
| LeetCode 94 二叉树的中序遍历 | 简单 | 递归 / 迭代 | [树](../1_data_structures/3_tree) |
| LeetCode 102 二叉树的层序遍历 | 中等 | BFS | [树](../1_data_structures/3_tree) |
| LeetCode 104 二叉树的最大深度 | 简单 | 递归 | [树](../1_data_structures/3_tree) |
| LeetCode 226 翻转二叉树 | 简单 | 递归 | [树](../1_data_structures/3_tree) |
| LeetCode 98 验证二叉搜索树 | 中等 | 中序有序 / 上下界递归 | [树](../1_data_structures/3_tree) |
| LeetCode 236 二叉树的最近公共祖先 | 中等 | 后序遍历 | [树](../1_data_structures/3_tree) |
| LeetCode 105 从前序与中序遍历序列构造二叉树 | 中等 | 递归分治 | [树](../1_data_structures/3_tree) |
| LeetCode 124 二叉树中的最大路径和 | 困难 | 后序遍历 | — |
| LeetCode 297 二叉树的序列化与反序列化 | 困难 | BFS / DFS | — |

---

## 七、字典树

**切入点**：大量字符串的前缀查询、自动补全、前缀计数用字典树；按二进制位建字典树可求最大异或值。

| 题目 | 难度 | 考点 | 讲解 |
|------|------|------|------|
| LeetCode 208 实现 Trie (前缀树) | 中等 | 字典树 | [字典树（Trie）](../1_data_structures/6_trie) |
| LeetCode 421 数组中两个数的最大异或值 | 中等 | 二进制字典树 | [字典树（Trie）](../1_data_structures/6_trie) |

---

## 八、图与并查集

**切入点**：连通性、合并分组用并查集或 DFS；有向图的依赖关系与判环用拓扑排序；无权图最短路用 BFS；非负权图最短路用堆优化的 Dijkstra。

| 题目 | 难度 | 考点 | 讲解 |
|------|------|------|------|
| LeetCode 200 岛屿数量 | 中等 | 网格 DFS / BFS | [回溯算法](../2_algorithms/3_backtrack) |
| LeetCode 994 腐烂的橘子 | 中等 | 多源 BFS | [搜索算法](../2_algorithms/0_search) |
| LeetCode 127 单词接龙 | 困难 | BFS / 双向 BFS | [搜索算法](../2_algorithms/0_search) |
| LeetCode 752 打开转盘锁 | 中等 | BFS / 双向 BFS | [搜索算法](../2_algorithms/0_search) |
| LeetCode 207 课程表 | 中等 | 拓扑排序 | [图](../1_data_structures/5_graph) |
| LeetCode 210 课程表 II | 中等 | 拓扑排序 | [图](../1_data_structures/5_graph) |
| LeetCode 547 省份数量 | 中等 | 并查集 / DFS | [图](../1_data_structures/5_graph) |
| LeetCode 684 冗余连接 | 中等 | 并查集 | [图](../1_data_structures/5_graph) |
| LeetCode 1971 寻找图中是否存在路径 | 简单 | 并查集 / BFS | [图](../1_data_structures/5_graph) |
| LeetCode 743 网络延迟时间 | 中等 | Dijkstra | [图](../1_data_structures/5_graph) |

---

## 九、二分查找

**切入点**：不只用于有序数组，凡是「答案具有单调性」都能二分答案；先定区间写法（闭区间或左闭右开），再区分找左边界还是右边界；`mid = lo + (hi - lo) / 2`。

| 题目 | 难度 | 考点 | 讲解 |
|------|------|------|------|
| LeetCode 704 二分查找 | 简单 | 基础二分 | [搜索算法](../2_algorithms/0_search) |
| LeetCode 35 搜索插入位置 | 简单 | 左边界 | [搜索算法](../2_algorithms/0_search) |
| LeetCode 34 在排序数组中查找元素的第一个和最后一个位置 | 中等 | 左右边界 | [搜索算法](../2_algorithms/0_search) |
| LeetCode 33 搜索旋转排序数组 | 中等 | 判断哪一半有序 | [搜索算法](../2_algorithms/0_search) |
| LeetCode 153 寻找旋转排序数组中的最小值 | 中等 | 与右端点比较 | — |
| LeetCode 74 搜索二维矩阵 | 中等 | 二维下标映射成一维 | — |
| LeetCode 875 爱吃香蕉的珂珂 | 中等 | 二分答案 | [搜索算法](../2_algorithms/0_search) |
| LeetCode 1011 在 D 天内送达包裹的能力 | 中等 | 二分答案 | [搜索算法](../2_algorithms/0_search) |
| LeetCode 4 寻找两个正序数组的中位数 | 困难 | 二分划分位置 | — |

---

## 十、排序与分治

**切入点**：手写排序优先快排（随机基准）和归并；第 K 大用快速选择或堆；「统计满足条件的数对」常在归并的合并步骤里计数。

| 题目 | 难度 | 考点 | 讲解 |
|------|------|------|------|
| LeetCode 912 排序数组 | 中等 | 手写快排 / 归并 | [排序算法](../2_algorithms/1_sort) |
| LeetCode 75 颜色分类 | 中等 | 三路划分（荷兰国旗） | [排序算法](../2_algorithms/1_sort) |
| LeetCode 50 Pow(x, n) | 中等 | 快速幂 | [分治算法](../2_algorithms/2_divide_conquer) |
| LCR 170 交易逆序对的总数 | 困难 | 归并计数 | [分治算法](../2_algorithms/2_divide_conquer) |
| LeetCode 315 计算右侧小于当前元素的个数 | 困难 | 归并计数 | [分治算法](../2_algorithms/2_divide_conquer) |
| LeetCode 493 翻转对 | 困难 | 归并计数 | [分治算法](../2_algorithms/2_divide_conquer) |
| LeetCode 241 为运算表达式设计优先级 | 中等 | 按运算符分治 | — |

---

## 十一、回溯

**切入点**：套路固定（做选择 → 递归 → 撤销）；排列用 `used[]`，组合和子集用 `start`；有重复元素时先排序再同层去重；排序后超过目标值提前停止。

| 题目 | 难度 | 考点 | 讲解 |
|------|------|------|------|
| LeetCode 46 全排列 | 中等 | 排列 | [回溯算法](../2_algorithms/3_backtrack) |
| LeetCode 47 全排列 II | 中等 | 排序 + 同层去重 | [回溯算法](../2_algorithms/3_backtrack) |
| LeetCode 77 组合 | 中等 | 组合 + 剩余数量剪枝 | [回溯算法](../2_algorithms/3_backtrack) |
| LeetCode 39 组合总和 | 中等 | 可重复选 | [回溯算法](../2_algorithms/3_backtrack) |
| LeetCode 40 组合总和 II | 中等 | 不可重复选 + 去重 | [回溯算法](../2_algorithms/3_backtrack) |
| LeetCode 78 子集 | 中等 | 子集 / 位掩码 | [回溯算法](../2_algorithms/3_backtrack) |
| LeetCode 51 N 皇后 | 困难 | 列与对角线标记 | [回溯算法](../2_algorithms/3_backtrack) |
| LeetCode 79 单词搜索 | 中等 | 网格回溯 | [回溯算法](../2_algorithms/3_backtrack) |
| LeetCode 37 解数独 | 困难 | 约束回溯 | — |

---

## 十二、贪心

**切入点**：先用小例子找反例，找不到再用交换论证说明正确性；区间类题目先想清楚按开始还是结束时间排序；比较器用 `Integer.compare`。

| 题目 | 难度 | 考点 | 讲解 |
|------|------|------|------|
| LeetCode 435 无重叠区间 | 中等 | 按结束时间排序 | [贪心算法](../2_algorithms/4_greedy) |
| LeetCode 452 用最少数量的箭引爆气球 | 中等 | 按结束时间排序 | [贪心算法](../2_algorithms/4_greedy) |
| LeetCode 56 合并区间 | 中等 | 按开始时间排序 | [贪心算法](../2_algorithms/4_greedy) |
| LeetCode 55 跳跃游戏 | 中等 | 最远可达位置 | [贪心算法](../2_algorithms/4_greedy) |
| LeetCode 45 跳跃游戏 II | 中等 | 按层扩展边界 | [贪心算法](../2_algorithms/4_greedy) |
| LeetCode 135 分发糖果 | 困难 | 左右两次扫描 | [贪心算法](../2_algorithms/4_greedy) |
| LeetCode 134 加油站 | 中等 | 油量为负时重置起点 | [贪心算法](../2_algorithms/4_greedy) |
| LeetCode 122 买卖股票的最佳时机 II | 中等 | 累加正差价 | [贪心算法](../2_algorithms/4_greedy) |
| LeetCode 621 任务调度器 | 中等 | 最高频任务定框架 | [贪心算法](../2_algorithms/4_greedy) |
| LeetCode 406 根据身高重建队列 | 中等 | 降序排序 + 按 k 插入 | [贪心算法](../2_algorithms/4_greedy) |

---

## 十三、动态规划

**切入点**：先写清状态 `dp[i]` 的含义，再找转移、定初始值和遍历顺序；背包问题区分 0-1（容量倒序）与完全（容量正序）；区间 DP 按长度从小到大。

| 题目 | 难度 | 考点 | 讲解 |
|------|------|------|------|
| LeetCode 509 斐波那契数 | 简单 | 记忆化 / 递推 | [动态规划](../2_algorithms/5_dynamic_programming) |
| LeetCode 70 爬楼梯 | 简单 | 一维 DP | [动态规划](../2_algorithms/5_dynamic_programming) |
| LeetCode 53 最大子数组和 | 中等 | Kadane | [动态规划](../2_algorithms/5_dynamic_programming) |
| LeetCode 198 打家劫舍 | 中等 | 一维 DP | [动态规划](../2_algorithms/5_dynamic_programming) |
| LeetCode 300 最长递增子序列 | 中等 | DP / 贪心 + 二分 | [动态规划](../2_algorithms/5_dynamic_programming) |
| LeetCode 1143 最长公共子序列 | 中等 | 二维 DP | [动态规划](../2_algorithms/5_dynamic_programming) |
| LeetCode 72 编辑距离 | 中等 | 二维 DP | [动态规划](../2_algorithms/5_dynamic_programming) |
| LeetCode 62 不同路径 | 中等 | 二维 DP / 滚动数组 | [动态规划](../2_algorithms/5_dynamic_programming) |
| LeetCode 416 分割等和子集 | 中等 | 0-1 背包 | [动态规划](../2_algorithms/5_dynamic_programming) |
| LeetCode 322 零钱兑换 | 中等 | 完全背包求最小值 | [动态规划](../2_algorithms/5_dynamic_programming) |
| LeetCode 312 戳气球 | 困难 | 区间 DP | [动态规划](../2_algorithms/5_dynamic_programming) |
| LeetCode 5 最长回文子串 | 中等 | 区间 DP / 中心扩展 | — |
| LeetCode 10 正则表达式匹配 | 困难 | 二维 DP | — |

---

## 十四、双指针

**切入点**：有序数组找数对用对撞指针；链表判环、找中点用快慢指针；删除倒数第 N 个用固定间距指针。

| 题目 | 难度 | 考点 | 讲解 |
|------|------|------|------|
| LeetCode 167 两数之和 II - 输入有序数组 | 中等 | 对撞指针 | [双指针](../3_patterns/1_two_pointers) |
| LeetCode 15 三数之和 | 中等 | 排序 + 对撞指针 + 去重 | [双指针](../3_patterns/1_two_pointers) |
| LeetCode 11 盛最多水的容器 | 中等 | 移动较矮一侧 | [双指针](../3_patterns/1_two_pointers) |
| LeetCode 125 验证回文串 | 简单 | 对撞指针 | [双指针](../3_patterns/1_two_pointers) |

链表上的快慢指针题见第二节。

---

## 十五、滑动窗口

**切入点**：窗口扩大时某个量单调变化才能用；求最长在收缩后更新，求最短在收缩前更新；字符计数用 `int[26]`。

| 题目 | 难度 | 考点 | 讲解 |
|------|------|------|------|
| LeetCode 643 子数组最大平均数 I | 简单 | 固定窗口 | [滑动窗口](../3_patterns/2_sliding_window) |
| LeetCode 438 找到字符串中所有字母异位词 | 中等 | 固定窗口 + 计数 | [滑动窗口](../3_patterns/2_sliding_window) |
| LeetCode 567 字符串的排列 | 中等 | 固定窗口 + 计数 | [滑动窗口](../3_patterns/2_sliding_window) |
| LeetCode 3 无重复字符的最长子串 | 中等 | 可变窗口 | [滑动窗口](../3_patterns/2_sliding_window) |
| LeetCode 209 长度最小的子数组 | 中等 | 可变窗口求最短 | [滑动窗口](../3_patterns/2_sliding_window) |
| LeetCode 76 最小覆盖子串 | 困难 | 可变窗口 + 字符覆盖 | [滑动窗口](../3_patterns/2_sliding_window) |
| LeetCode 1004 最大连续1的个数 III | 中等 | 可变窗口 | [滑动窗口](../3_patterns/2_sliding_window) |
| LeetCode 424 替换后的最长重复字符 | 中等 | 只扩不缩的窗口 | [滑动窗口](../3_patterns/2_sliding_window) |

---

## 十六、前缀和与差分

**切入点**：静态区间求和用前缀和；批量区间加减用差分；子数组和等于目标且有负数时，用前缀和 + 哈希表。

| 题目 | 难度 | 考点 | 讲解 |
|------|------|------|------|
| LeetCode 303 区域和检索 - 数组不可变 | 简单 | 一维前缀和 | [前缀和与差分数组](../3_patterns/3_prefix_sum) |
| LeetCode 304 二维区域和检索 - 矩阵不可变 | 中等 | 二维前缀和 | [前缀和与差分数组](../3_patterns/3_prefix_sum) |
| LeetCode 560 和为 K 的子数组 | 中等 | 前缀和 + 哈希表 | [前缀和与差分数组](../3_patterns/3_prefix_sum) |
| LeetCode 974 和可被 K 整除的子数组 | 中等 | 前缀和取模 + 哈希表 | [前缀和与差分数组](../3_patterns/3_prefix_sum) |
| LeetCode 525 连续数组 | 中等 | 0 看成 −1 + 首次下标 | [前缀和与差分数组](../3_patterns/3_prefix_sum) |
| LeetCode 1248 统计「优美子数组」 | 中等 | 奇数计数的前缀和 | [前缀和与差分数组](../3_patterns/3_prefix_sum) |
| LeetCode 1109 航班预订统计 | 中等 | 差分数组 | [前缀和与差分数组](../3_patterns/3_prefix_sum) |
| LeetCode 1094 拼车 | 中等 | 差分数组 | [前缀和与差分数组](../3_patterns/3_prefix_sum) |

---

## 十七、位运算

**切入点**：成对抵消用异或；统计 1 的个数用 `n & (n - 1)`；元素个数在 20 左右且要记录「用过哪些」时考虑状压。

| 题目 | 难度 | 考点 | 讲解 |
|------|------|------|------|
| LeetCode 136 只出现一次的数字 | 简单 | 异或抵消 | [位运算](../3_patterns/4_bit_manipulation) |
| LeetCode 260 只出现一次的数字 III | 中等 | 异或 + lowbit 分组 | [位运算](../3_patterns/4_bit_manipulation) |
| LeetCode 137 只出现一次的数字 II | 中等 | 按位计数取模 | — |
| LeetCode 191 位1的个数 | 简单 | `n & (n - 1)` | [位运算](../3_patterns/4_bit_manipulation) |
| LeetCode 231 2 的幂 | 简单 | `n & (n - 1)` | [位运算](../3_patterns/4_bit_manipulation) |
| LeetCode 338 比特位计数 | 简单 | DP + 位运算 | — |
| LeetCode 461 汉明距离 | 简单 | 异或 + `bitCount` | — |
| LeetCode 847 访问所有节点的最短路径 | 困难 | 状压 + BFS | [位运算](../3_patterns/4_bit_manipulation) |
| LeetCode 1986 完成任务的最少工作时间段 | 中等 | 状压 DP | — |

---

## 小结

- 按题型集中刷，同一类题连着做，先吃透切入点再追求数量
- 每道题先独立思考一段时间，卡住再看题解；看完后隔天不看答案重写一遍
- 刷完一轮回头重做错题，直到能在限定时间内独立写出并说清复杂度
- 手写高频：反转链表、LRU 缓存、快排 / 归并、二分边界、三数之和、最大子数组和，要能直接写对

## 参考资料

- 力扣中国站题库：[https://leetcode.cn/problemset/](https://leetcode.cn/problemset/)
- OI Wiki：[https://oi-wiki.org/](https://oi-wiki.org/)

> 下一篇：[华为 OJ 题型与技巧](./1_huawei_oj) —— ACM 模式输入输出、`BufferedReader` 读法、常见题型与 API 速查。
