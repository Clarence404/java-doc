---
description: 栈、单调栈、队列、双端队列、优先队列
---

# 栈 & 队列

---

## 一、栈（Stack）

### 1.1 特性

**后进先出（LIFO）**：只能在栈顶操作，push 入栈，pop 出栈。

| 操作 | 复杂度 |
|------|--------|
| push（入栈） | O(1) |
| pop（出栈） | O(1) |
| peek（查看栈顶）| O(1) |

### 1.2 Java 实现

```java
// 推荐用 Deque 替代 Stack（Stack 继承 Vector，有同步开销）
Deque<Integer> stack = new ArrayDeque<>();
stack.push(1);         // 入栈
stack.push(2);
int top = stack.peek();  // 查看栈顶，不弹出
int val = stack.pop();   // 出栈
boolean empty = stack.isEmpty();
```

### 1.3 经典应用

**括号匹配：**
```java
boolean isValid(String s) {
    Deque<Character> stack = new ArrayDeque<>();
    for (char c : s.toCharArray()) {
        if (c == '(' || c == '[' || c == '{') {
            stack.push(c);
        } else {
            if (stack.isEmpty()) return false;
            char top = stack.pop();
            if (c == ')' && top != '(') return false;
            if (c == ']' && top != '[') return false;
            if (c == '}' && top != '{') return false;
        }
    }
    return stack.isEmpty();
}
```

**用栈实现递归（DFS 迭代化）：**
```java
// 二叉树前序遍历（迭代）
List<Integer> preorder(TreeNode root) {
    List<Integer> res = new ArrayList<>();
    Deque<TreeNode> stack = new ArrayDeque<>();
    if (root != null) stack.push(root);
    while (!stack.isEmpty()) {
        TreeNode node = stack.pop();
        res.add(node.val);
        if (node.right != null) stack.push(node.right); // 先压右
        if (node.left != null)  stack.push(node.left);  // 再压左（先出）
    }
    return res;
}
```

---

## 二、单调栈

### 2.1 思想

维护一个**单调递增或递减**的栈，解决"找左/右第一个更大/更小元素"类问题。

**模板：找右边第一个更大元素**
```java
int[] nextGreater(int[] nums) {
    int n = nums.length;
    int[] res = new int[n];
    Arrays.fill(res, -1);
    Deque<Integer> stack = new ArrayDeque<>(); // 存下标，栈底大栈顶小（单调递减）

    for (int i = 0; i < n; i++) {
        // 当前元素比栈顶大，栈顶元素找到了右边第一个更大值
        while (!stack.isEmpty() && nums[i] > nums[stack.peek()]) {
            res[stack.pop()] = nums[i];
        }
        stack.push(i);
    }
    return res;
}
```

**典型题：** 每日温度（LeetCode 739）、接雨水（LeetCode 42）、柱状图中最大矩形（LeetCode 84）

---

## 三、队列（Queue）

### 3.1 特性

**先进先出（FIFO）**：从队尾入队（offer），从队头出队（poll）。

```java
Queue<Integer> queue = new LinkedList<>();
queue.offer(1);     // 入队（尾部）
queue.offer(2);
int head = queue.peek();  // 查看队头
int val = queue.poll();   // 出队（头部）
```

### 3.2 BFS 场景

队列是 BFS 的核心数据结构：
```java
void bfs(int[][] grid, int startR, int startC) {
    Queue<int[]> queue = new LinkedList<>();
    queue.offer(new int[]{startR, startC});
    boolean[][] visited = new boolean[grid.length][grid[0].length];
    visited[startR][startC] = true;

    int[][] dirs = {{0,1},{0,-1},{1,0},{-1,0}};
    while (!queue.isEmpty()) {
        int[] cur = queue.poll();
        for (int[] d : dirs) {
            int nr = cur[0] + d[0], nc = cur[1] + d[1];
            if (nr >= 0 && nr < grid.length && nc >= 0 && nc < grid[0].length
                && !visited[nr][nc]) {
                visited[nr][nc] = true;
                queue.offer(new int[]{nr, nc});
            }
        }
    }
}
```

---

## 四、双端队列（Deque）

两端均可进出，兼具栈和队列功能：

```java
Deque<Integer> deque = new ArrayDeque<>();
deque.offerFirst(1);  // 头部入
deque.offerLast(2);   // 尾部入
deque.pollFirst();    // 头部出
deque.pollLast();     // 尾部出
deque.peekFirst();    // 查头
deque.peekLast();     // 查尾
```

**单调双端队列（滑动窗口最大值）：**
```java
// LeetCode 239 滑动窗口最大值
int[] maxSlidingWindow(int[] nums, int k) {
    int n = nums.length;
    int[] res = new int[n - k + 1];
    Deque<Integer> deque = new ArrayDeque<>(); // 存下标，队头最大

    for (int i = 0; i < n; i++) {
        // 移除窗口外的元素
        while (!deque.isEmpty() && deque.peekFirst() < i - k + 1)
            deque.pollFirst();
        // 维护单调递减（队尾小的弹出）
        while (!deque.isEmpty() && nums[deque.peekLast()] < nums[i])
            deque.pollLast();
        deque.offerLast(i);
        if (i >= k - 1) res[i - k + 1] = nums[deque.peekFirst()];
    }
    return res;
}
```

---

## 五、优先队列（堆队列）

按优先级出队，底层实现为堆：

```java
// 小顶堆（默认）
PriorityQueue<Integer> minHeap = new PriorityQueue<>();
// 大顶堆
PriorityQueue<Integer> maxHeap = new PriorityQueue<>(Collections.reverseOrder());

minHeap.offer(3);
minHeap.offer(1);
minHeap.offer(2);
minHeap.poll(); // 返回 1（最小）

// 自定义比较：按对象的某字段排序
PriorityQueue<int[]> pq = new PriorityQueue<>((a, b) -> a[1] - b[1]); // 按第二个元素升序
```

---

## 六、经典题目

| 题目 | 考点 |
|------|------|
| LeetCode 20 有效的括号 | 栈匹配 |
| LeetCode 739 每日温度 | 单调栈 |
| LeetCode 84 柱状图中最大矩形 | 单调栈 |
| LeetCode 42 接雨水 | 单调栈 / 双指针 |
| LeetCode 239 滑动窗口最大值 | 单调双端队列 |
| LeetCode 225 用队列实现栈 | 队列模拟 |
| LeetCode 232 用栈实现队列 | 双栈 |
| LeetCode 295 数据流中位数 | 双堆（大顶+小顶） |
