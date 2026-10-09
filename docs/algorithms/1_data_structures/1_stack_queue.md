---
description: 栈与 ArrayDeque、括号匹配、单调栈四种变体、队列与 BFS、双端队列、单调队列
---

# 栈与队列

> **本篇目标**：掌握栈和队列在 Java 中的正确写法（统一用 `ArrayDeque`），能用单调栈解决「下一个更大 / 更小元素」类问题，用单调队列解决滑动窗口最值问题。
>
> **前置阅读**：[数组与链表](./0_array_list)

栈和队列都是**操作受限的线性表**：栈只在一端进出（后进先出），队列一端进、另一端出（先进先出）。限制换来的是 O(1) 的进出操作和清晰的语义——栈天然对应递归与括号嵌套，队列天然对应按层扩展的 BFS。

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

### 1、思想

单调栈让栈内元素保持**单调递增或单调递减**。新元素入栈前，先把破坏单调性的栈顶元素依次弹出——被弹出的元素恰好在此刻找到了「右边第一个比它大（或小）的元素」。每个元素最多入栈、出栈各一次，整体 O(n)。

**模板：找右边第一个更大的元素**

```java
int[] nextGreater(int[] nums) {
    int n = nums.length;
    int[] res = new int[n];
    Arrays.fill(res, -1);                      // 找不到时为 -1
    Deque<Integer> stack = new ArrayDeque<>(); // 存下标，从栈底到栈顶对应的值非递增

    for (int i = 0; i < n; i++) {
        // 当前元素比栈顶大：栈顶找到了右边第一个更大的值
        while (!stack.isEmpty() && nums[i] > nums[stack.peek()]) {
            res[stack.pop()] = nums[i];
        }
        stack.push(i);
    }
    return res;
}
```

### 2、四种变体怎么选

| 要找的 | 栈内单调性（栈底 → 栈顶） | 出栈条件 | 结果在何时记录 |
|--------|--------------------------|----------|----------------|
| 右边第一个更大 | 非递增 | `nums[i] > 栈顶` | 弹出时，答案是 `nums[i]` |
| 右边第一个更小 | 非递减 | `nums[i] < 栈顶` | 弹出时，答案是 `nums[i]` |
| 左边第一个更大 | 严格递减 | `nums[i] >= 栈顶` | 弹完后，答案是新的栈顶 |
| 左边第一个更小 | 严格递增 | `nums[i] <= 栈顶` | 弹完后，答案是新的栈顶 |

**严格还是非严格**：比较时用 `>` 还是 `>=` 决定相等元素的去留。用 `>` 时相等元素留在栈里，找到的是「严格更大」；改成 `>=` 则相等元素也会被弹出。题目说「更大」还是「大于等于」，就对应改这一个符号。

**典型题**：每日温度（LeetCode 739）、接雨水（LeetCode 42）、柱状图中最大的矩形（LeetCode 84）。

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

队列里存下标，对应的值从队头到队尾单调递减，队头就是当前窗口的最大值：

1. 队头下标滑出窗口就从头部弹出
2. 新元素入队前，从尾部弹出所有比它小的元素——它们在新元素离开窗口前都不可能成为最大值
3. 窗口形成后，队头即为答案

```java
// LeetCode 239
int[] maxSlidingWindow(int[] nums, int k) {
    int n = nums.length;
    int[] res = new int[n - k + 1];
    Deque<Integer> deque = new ArrayDeque<>();

    for (int i = 0; i < n; i++) {
        if (!deque.isEmpty() && deque.peekFirst() <= i - k) {
            deque.pollFirst();                     // 1. 移除窗口外的队头
        }
        while (!deque.isEmpty() && nums[deque.peekLast()] < nums[i]) {
            deque.pollLast();                      // 2. 维护单调递减
        }
        deque.offerLast(i);
        if (i >= k - 1) res[i - k + 1] = nums[deque.peekFirst()];  // 3. 记录答案
    }
    return res;
}
```

每个下标最多入队、出队各一次，整体 O(n)；用堆做同一题是 O(n log k)。

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
- 单调栈解决「左 / 右第一个更大 / 更小」问题，出栈条件的 `>` 与 `>=` 决定相等元素怎么处理
- 单调队列解决滑动窗口最值，每个元素进出一次，整体 O(n)
- 队列是 BFS 的核心，优先队列见堆一篇

## 参考资料

- JDK 21 ArrayDeque API：[https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/ArrayDeque.html](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/ArrayDeque.html)
- JDK 21 Stack API：[https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/Stack.html](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/Stack.html)
- JDK 21 Deque API：[https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/Deque.html](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/Deque.html)
- Hello 算法 · 栈与队列：[https://www.hello-algo.com/chapter_stack_and_queue/](https://www.hello-algo.com/chapter_stack_and_queue/)

> 下一篇：[哈希表](./2_hash_table) —— 哈希函数、冲突处理、负载因子与 Java Map / Set 的算法用法。
