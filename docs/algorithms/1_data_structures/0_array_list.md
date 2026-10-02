---
description: 顺序存储与链式存储
---

# 数组 & 链表

---

## 一、数组（Array）

### 1.1 特性

数组在**连续内存**中存储相同类型元素，通过下标 O(1) 访问。

| 操作 | 复杂度 | 说明 |
|------|--------|------|
| 随机访问 | O(1) | 下标直接计算地址 |
| 头部插入/删除 | O(n) | 需整体平移 |
| 尾部插入/删除 | O(1) | 无需移动 |
| 中间插入/删除 | O(n) | 需移动后续元素 |
| 搜索 | O(n) | 无序；有序可二分 O(log n) |

### 1.2 Java 中的数组

```java
// 基本数组
int[] arr = new int[5];
int[] arr2 = {1, 2, 3, 4, 5};
Arrays.sort(arr2);                    // 排序
Arrays.fill(arr, 0);                  // 填充
int[] copy = Arrays.copyOfRange(arr2, 1, 4); // 截取 [1,4)

// 二维数组
int[][] matrix = new int[3][4];
int[][] grid = {{1,2},{3,4},{5,6}};
```

### 1.3 ArrayList vs 原生数组

| | 原生数组 | ArrayList |
|--|---------|-----------|
| 长度 | 固定 | 动态扩容（1.5倍） |
| 类型 | 基本类型/对象 | 仅对象（装箱） |
| 性能 | 更快 | 稍慢（装箱/扩容） |
| 功能 | 基础 | 丰富（contains/sort等） |

```java
List<Integer> list = new ArrayList<>();
list.add(1); list.add(2); list.add(3);
list.remove(Integer.valueOf(2));  // 按值删除
list.get(0);                      // O(1) 访问
Collections.sort(list);           // 排序
```

---

## 二、链表（Linked List）

### 2.1 类型

**单链表**：每个节点含 `val` 和 `next` 指针。
**双链表**：每个节点含 `prev`、`val`、`next`。
**循环链表**：尾节点的 `next` 指向头节点。

```java
// 单链表节点
class ListNode {
    int val;
    ListNode next;
    ListNode(int val) { this.val = val; }
}
```

### 2.2 复杂度

| 操作 | 复杂度 | 说明 |
|------|--------|------|
| 头部插入/删除 | O(1) | 修改指针即可 |
| 尾部插入（有尾指针）| O(1) | |
| 中间插入/删除 | O(n) | 需先遍历找到位置 |
| 随机访问 | O(n) | 不支持下标 |

### 2.3 常见操作模板

```java
// 反转链表（迭代）
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

// 找中间节点（快慢指针）
ListNode middleNode(ListNode head) {
    ListNode slow = head, fast = head;
    while (fast != null && fast.next != null) {
        slow = slow.next;
        fast = fast.next.next;
    }
    return slow; // slow 停在中间
}

// 检测环（Floyd 判圈）
boolean hasCycle(ListNode head) {
    ListNode slow = head, fast = head;
    while (fast != null && fast.next != null) {
        slow = slow.next;
        fast = fast.next.next;
        if (slow == fast) return true;
    }
    return false;
}

// 带哨兵节点的删除（避免处理头节点特殊情况）
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

// 合并两个有序链表
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

### 2.4 Java LinkedList

```java
LinkedList<Integer> list = new LinkedList<>();
list.addFirst(1);  // 头插 O(1)
list.addLast(2);   // 尾插 O(1)
list.removeFirst();
list.removeLast();
list.peekFirst();  // 查看头元素（不删）
```

---

## 三、数组 vs 链表 总结

| 维度 | 数组 | 链表 |
|------|------|------|
| 内存 | 连续，缓存友好 | 分散，缓存不友好 |
| 随机访问 | O(1) | O(n) |
| 头部插删 | O(n) | O(1) |
| 内存利用 | 可能浪费（预分配）| 精确，但有指针开销 |
| 适用 | 频繁随机访问 | 频繁头尾插删 |

---

## 四、经典题目

| 题目 | 考点 |
|------|------|
| LeetCode 206 反转链表 | 迭代/递归反转 |
| LeetCode 21 合并两个有序链表 | 哨兵节点 |
| LeetCode 141 环形链表 | 快慢指针 |
| LeetCode 142 环形链表 II | 快慢指针找入口 |
| LeetCode 876 链表的中间节点 | 快慢指针 |
| LeetCode 19 删除链表倒数第 N 个节点 | 双指针间距 |
| LeetCode 160 相交链表 | 双指针等长走 |
