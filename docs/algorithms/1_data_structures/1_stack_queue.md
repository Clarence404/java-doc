---
description: 栈与 ArrayDeque、括号匹配、递归改迭代、队列与 BFS、双端队列、单调栈与单调队列入门
---

# 栈与队列

> 前置阅读：[数组与链表](./0_array_list)

栈和队列是操作受限的线性表，栈后进先出、队列先进先出。本篇讲 Java 中统一用 `ArrayDeque` 的写法、栈与队列的经典应用，以及它们延伸出的单调栈、单调队列。

---

## 一、栈（Stack）

### 1、特性

**后进先出（LIFO）**：只能在栈顶操作，`push` 入栈，`pop` 出栈，`peek` 查看栈顶，三者都是 O(1)。

### 2、Java 实现

```java
Deque<Integer> stack = new ArrayDeque<>();
stack.push(1);
stack.push(2);
int top = stack.peek();          // 查看栈顶，不弹出
int val = stack.pop();           // 弹出栈顶
boolean empty = stack.isEmpty();
```

**为什么不用 `java.util.Stack`**：

- `Stack` 继承自 `Vector`，每个方法都加了 `synchronized`，单线程下白白付出同步开销
- 继承还暴露了 `get(i)`、`insertElementAt` 等 `Vector` 方法，可以绕过栈顶随意读写，破坏了后进先出的约束
- `Stack` 的 JDK 文档本身就建议优先使用 `Deque` 接口及其实现

**使用 `ArrayDeque` 的注意点**：

- **不允许放 `null`**，`push(null)` 直接抛 `NullPointerException`
- 空栈时 `pop()` 抛 `NoSuchElementException`，`peek()` 返回 `null`；用 `int top = stack.peek()` 接收时，`null` 拆箱会抛 `NullPointerException`，所以取值前先判 `isEmpty()`
- 非线程安全，多线程场景改用 `ConcurrentLinkedDeque` 或 `LinkedBlockingDeque`

### 3、经典应用

**括号匹配**：遇到左括号入栈，遇到右括号就和栈顶配对。

```java
// LeetCode 20
boolean isValid(String s) {
    Deque<Character> stack = new ArrayDeque<>();
    for (char c : s.toCharArray()) {
        switch (c) {
            case '(' -> stack.push(')');      // 压入期望的右括号，配对时直接比较
            case '[' -> stack.push(']');
            case '{' -> stack.push('}');
            default -> {
                if (stack.isEmpty() || stack.pop() != c) return false;
            }
        }
    }
    return stack.isEmpty();
}
```

**用栈把递归改成迭代**：递归本质是系统调用栈，显式维护一个栈就能改写成循环，避免递归过深导致 `StackOverflowError`。二叉树的迭代遍历模板见 [树](./3_tree)。

---

## 二、单调栈

单调栈是栈最常见的算法用法：栈内保持单调，新元素入栈前弹出破坏单调性的栈顶，被弹出的元素就找到了「右边第一个更大（或小）的元素」，整体 O(n)。四种变体的出栈条件、`>` 与 `>=` 的取舍，以及每日温度、柱状图最大矩形、接雨水的完整解法见 [并查集、单调栈与线段树](./7_advanced#二、单调栈)。

---

## 三、队列（Queue）

### 1、特性

**先进先出（FIFO）**：从队尾入队（`offer`），从队头出队（`poll`），都是 O(1)。

```java
Queue<Integer> queue = new ArrayDeque<>();
queue.offer(1);                 // 队尾入队
queue.offer(2);
Integer head = queue.peek();    // 查看队头，空队列返回 null
Integer val = queue.poll();     // 队头出队，空队列返回 null
```

`Queue` 的每个操作都有两种版本：`add` / `remove` / `element` 失败时抛异常，`offer` / `poll` / `peek` 失败时返回特殊值。刷题和业务代码一般用后一组。

### 2、BFS 中的队列

队列是广度优先搜索的核心：先入队的节点先展开，保证按「距离起点由近到远」的顺序访问，所以无权图中 BFS 第一次到达终点时走的就是最短路径。网格 BFS 与按层计步的完整模板见 [图](./5_graph)，二叉树层序遍历见 [树](./3_tree)。

---

## 四、双端队列（Deque）

### 1、基本操作

两端都能进出，兼具栈和队列的功能：

```java
Deque<Integer> deque = new ArrayDeque<>();
deque.offerFirst(1);   // 头部入
deque.offerLast(2);    // 尾部入
deque.pollFirst();     // 头部出
deque.pollLast();      // 尾部出
deque.peekFirst();     // 查看头部
deque.peekLast();      // 查看尾部
```

### 2、单调队列：滑动窗口最大值

双端队列的典型算法用法是单调队列：队尾像单调栈一样维护单调性，队头弹出滑出窗口的元素，O(n) 求出每个滑动窗口的最大值（LeetCode 239）。模板与扩展题见 [并查集、单调栈与线段树](./7_advanced#三、单调队列)。

---

## 五、优先队列

优先队列按优先级而不是入队顺序出队，Java 中对应 `PriorityQueue`，底层是二叉堆，入队和出队都是 O(log n)。它的原理、比较器写法与 Top K 等应用统一在 [堆](./4_heap) 一篇讲解。

---

## 六、经典题目

| 题目 | 考点 |
|------|------|
| LeetCode 20 有效的括号 | 栈匹配 |
| LeetCode 155 最小栈 | 辅助栈同步记录最小值 |
| LeetCode 739 每日温度 | 单调栈 |
| LeetCode 84 柱状图中最大的矩形 | 单调栈求左右边界 |
| LeetCode 42 接雨水 | 单调栈 / 双指针 |
| LeetCode 239 滑动窗口最大值 | 单调队列 |
| LeetCode 225 用队列实现栈 | 队列模拟 |
| LeetCode 232 用栈实现队列 | 双栈，出队均摊 O(1) |

---

## 小结

- 栈、队列、双端队列在 Java 中统一用 `ArrayDeque`，不用 `Stack`，也不用 `LinkedList`
- `ArrayDeque` 不允许 `null`；空栈 `peek()` 返回 `null`，直接拆箱成 `int` 会抛空指针
- 单调栈解决「左 / 右第一个更大 / 更小」问题，单调队列解决滑动窗口最值，详见 [并查集、单调栈与线段树](./7_advanced)
- 队列是 BFS 的核心，优先队列见堆一篇

## 参考资料

- JDK 21 ArrayDeque API：[https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/ArrayDeque.html](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/ArrayDeque.html)
- JDK 21 Stack API：[https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/Stack.html](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/Stack.html)
- JDK 21 Deque API：[https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/Deque.html](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/Deque.html)
- Hello 算法 · 栈与队列：[https://www.hello-algo.com/chapter_stack_and_queue/](https://www.hello-algo.com/chapter_stack_and_queue/)

> 下一篇：[哈希表](./2_hash_table) —— 哈希函数、冲突处理、负载因子与 Java Map / Set 的算法用法。
