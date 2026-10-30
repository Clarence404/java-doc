---
description: 数组与 ArrayList 扩容、单双循环链表、链表反转与哨兵节点模板
---

# 数组与链表

> 前置阅读：[复杂度分析](../0_complexity)

数组和链表是所有数据结构的基石：数组胜在随机访问和缓存友好，链表胜在已知位置时的 O(1) 插删。本篇讲两者的存储差异、数组与 `ArrayList` 的真实复杂度，以及链表反转、哨兵节点等模板。

---

## 一、数组（Array）

### 1、特性

数组在**连续内存**中存放相同类型的元素，第 i 个元素的地址 = 首地址 + i × 元素大小，所以下标访问是 O(1)。连续存储还让 CPU 缓存行一次能预取多个元素，顺序遍历数组远快于遍历链表。

| 操作 | 复杂度 | 说明 |
|------|--------|------|
| 随机访问 | O(1) | 下标直接算出地址 |
| 头部插入 / 删除 | O(n) | 后续元素整体平移 |
| 中间插入 / 删除 | O(n) | 平均移动一半元素 |
| 尾部插入 / 删除 | O(1) | 前提是还有剩余容量；原生数组长度固定，满了只能新建数组拷贝 |
| 查找 | O(n) | 有序数组可二分，O(log n) |

### 2、Java 中的数组

```java
int[] arr = new int[5];                          // 元素默认值为 0
int[] arr2 = {5, 3, 1, 4, 2};
Arrays.sort(arr2);                               // 原地排序
Arrays.fill(arr, -1);                            // 填充
int[] part = Arrays.copyOfRange(arr2, 1, 4);     // 截取 [1, 4)
int[][] grid = {{1, 2}, {3, 4}, {5, 6}};         // 二维数组本质是「数组的数组」
```

### 3、ArrayList 与原生数组

`ArrayList` 是可自动扩容的数组。从算法视角只需记住三点，扩容源码、`modCount` 与 fail-fast 等细节见 [集合框架](/java/21_topic_collection)：

- **懒分配**：`new ArrayList<>()` 时不分配空间，第一次 `add` 才分配默认容量 10（JDK 8 起）
- **1.5 倍扩容**：容量不够时新容量 = 旧容量 + 旧容量 / 2，并把旧数组整体拷贝过去，单次 O(n)
- **尾部追加均摊 O(1)**：扩容的拷贝代价平摊到后续追加上，分析见 [复杂度分析](../0_complexity) 的均摊分析一节；已知元素个数时用 `new ArrayList<>(n)` 一次分配到位

| 维度 | 原生数组 | ArrayList |
|------|---------|-----------|
| 长度 | 固定 | 自动扩容（约 1.5 倍） |
| 元素类型 | 基本类型或对象 | 只能放对象，`int` 要装箱成 `Integer` |
| 性能 | 更快，无装箱 | 装箱与扩容有额外开销 |
| 功能 | 只有下标读写 | `contains`、`remove`、`sort` 等现成方法 |

```java
List<Integer> list = new ArrayList<>(List.of(3, 1, 2));
list.add(4);                        // 尾部追加，均摊 O(1)
list.remove(Integer.valueOf(2));    // 按值删除；remove(2) 是按下标删除
list.get(0);                        // O(1)
list.sort(null);                    // 自然顺序排序
```

---

## 二、链表（Linked List）

### 1、类型

| 类型 | 节点结构 | 特点 |
|------|---------|------|
| 单链表 | `val` + `next` | 只能从头往后走 |
| 双链表 | `prev` + `val` + `next` | 可双向遍历，已知节点即可 O(1) 删除自身 |
| 循环链表 | 尾节点的 `next` 指回头节点 | 适合环形缓冲、约瑟夫环 |

下面的模板都使用 LeetCode 的单链表节点定义：

```java
class ListNode {
    int val;
    ListNode next;
    ListNode(int val) { this.val = val; }
}
```

### 2、复杂度

| 操作 | 复杂度 | 说明 |
|------|--------|------|
| 头部插入 / 删除 | O(1) | 改头指针即可 |
| 尾部插入 | O(1) | 前提是维护了尾指针 |
| 已知前驱节点的插入 / 删除 | O(1) | 只改两个指针 |
| 按位置插入 / 删除 | O(n) | 先遍历找到前驱节点 |
| 随机访问 | O(n) | 不支持下标，只能从头数 |

![单链表的插入、删除与反转：只改指针，不搬数据](../../assets/algorithms/linked_list_ops.svg)

### 3、常用操作模板

**反转链表**：逐个把 `cur.next` 掉头指向 `prev`，掉头前先用 `next` 记住后继，否则链表就断了：

```java
ListNode reverse(ListNode head) {
    ListNode prev = null, cur = head;
    while (cur != null) {
        ListNode next = cur.next;
        cur.next = prev;
        prev = cur;
        cur = next;
    }
    return prev;
}
```

**哨兵节点**：在头节点前放一个哑节点 `dummy`，删除头节点和删除普通节点就能用同一套代码：

```java
ListNode removeElements(ListNode head, int val) {
    ListNode dummy = new ListNode(-1);
    dummy.next = head;
    ListNode cur = dummy;
    while (cur.next != null) {
        if (cur.next.val == val) cur.next = cur.next.next;
        else cur = cur.next;
    }
    return dummy.next;
}

// 合并两个有序链表（LeetCode 21）
ListNode mergeTwoLists(ListNode l1, ListNode l2) {
    ListNode dummy = new ListNode(-1), cur = dummy;
    while (l1 != null && l2 != null) {
        if (l1.val <= l2.val) { cur.next = l1; l1 = l1.next; }
        else                  { cur.next = l2; l2 = l2.next; }
        cur = cur.next;
    }
    cur.next = (l1 != null) ? l1 : l2;
    return dummy.next;
}
```

### 4、快慢指针与双指针

链表上另一大类模板靠两个指针配合：快慢指针找中点、Floyd 判环并找入口、前后指针保持间距删除倒数第 N 个结点、两指针交替走找相交结点。它们都只是在上面的结点结构上移动引用，代码与 Floyd 入口证明统一见 [双指针 · 快慢指针](../3_patterns/1_two_pointers#二、快慢指针)。

### 5、Java LinkedList

`java.util.LinkedList` 是**双向链表**，同时实现了 `List` 和 `Deque`，所以有 `addFirst`、`pollLast` 这类双端操作。但实际开发中很少是最佳选择：

- 当栈、队列、双端队列用时，**优先用 `ArrayDeque`**：它基于循环数组，没有逐节点分配对象的开销，缓存命中率高，JDK 文档也说明它当队列用时通常比 `LinkedList` 快
- 当列表用时，`get(i)` 要从头或尾遍历，O(n)；中间插入虽然改指针是 O(1)，但先定位就是 O(n)，整体常常不如 `ArrayList`

两者的源码对比见 [集合框架](/java/21_topic_collection) 的 List 一节。

---

## 三、数组与链表对比

| 维度 | 数组 | 链表 |
|------|------|------|
| 内存 | 连续，缓存友好 | 分散，缓存不友好 |
| 随机访问 | O(1) | O(n) |
| 头部插删 | O(n) | O(1) |
| 已知位置的中间插删 | O(n)，要搬元素 | O(1)，只改指针 |
| 额外空间 | 动态数组可能预留空位 | 每个节点多一到两个指针 |
| 适用 | 读多写少、按下标访问 | 频繁在已知位置插删，如 LRU 链表 |

---

## 四、经典题目

| 题目 | 考点 |
|------|------|
| LeetCode 206 反转链表 | 迭代 / 递归反转 |
| LeetCode 21 合并两个有序链表 | 哨兵节点 |
| LeetCode 141 环形链表 | 快慢指针判环 |
| LeetCode 142 环形链表 II | Floyd 找环入口 |
| LeetCode 876 链表的中间结点 | 快慢指针 |
| LeetCode 19 删除链表的倒数第 N 个结点 | 前后指针保持间距 |
| LeetCode 160 相交链表 | 双指针交替走 |
| LeetCode 234 回文链表 | 找第一个中点 + 反转后半段 |

---

## 小结

- 数组靠连续内存实现 O(1) 随机访问，代价是中间插删要搬元素
- `ArrayList` 懒分配、1.5 倍扩容，尾部追加均摊 O(1)；已知大小时预设容量
- 链表的 O(1) 插删有前提：已经拿到前驱节点；按位置操作仍是 O(n)
- 链表题四件套：反转（prev / cur / next）、哨兵节点，以及快慢指针、前后指针保持间距（见 [双指针](../3_patterns/1_two_pointers)）
- 栈和队列用 `ArrayDeque`，列表用 `ArrayList`，`LinkedList` 很少是最优解

## 参考资料

- Hello 算法 · 数组与链表：[https://www.hello-algo.com/chapter_array_and_linkedlist/](https://www.hello-algo.com/chapter_array_and_linkedlist/)
- JDK 21 ArrayList API：[https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/ArrayList.html](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/ArrayList.html)
- JDK 21 ArrayDeque API：[https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/ArrayDeque.html](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/ArrayDeque.html)
- OpenJDK ArrayList 源码：[https://github.com/openjdk/jdk/blob/master/src/java.base/share/classes/java/util/ArrayList.java](https://github.com/openjdk/jdk/blob/master/src/java.base/share/classes/java/util/ArrayList.java)

> 下一篇：[栈与队列](./1_stack_queue) —— 栈与 `ArrayDeque`、括号匹配、队列与 BFS、双端队列。
