---
description: 对撞指针、快慢指针、Floyd 判圈与入口证明、固定间距指针、与滑动窗口的区别
---

# 双指针

> 前置阅读：[数组与链表](../1_data_structures/0_array_list)、[排序算法](../2_algorithms/1_sort)

双指针用两个下标或引用协同移动，一次排除一批不可能的组合，把 O(n²) 的枚举降到 O(n)。本篇讲对撞指针、快慢指针（含 Floyd 判圈找入口的证明）与固定间距双指针，以及它和滑动窗口的区别。

---

## 一、对撞指针

按移动方式分三类：

| 类型 | 指针方向 | 数据要求 | 典型问题 |
|------|----------|----------|----------|
| 对撞指针 | 从两端相向移动 | 通常要求有序 | 两数之和 II、三数之和、接雨水 |
| 快慢指针 | 同向、速度不同 | 链表或数组 | 判环、找中点、原地去重 |
| 固定间距 | 同向、速度相同、保持间距 | 链表 | 删除倒数第 N 个结点 |

两个指针同向移动、并且关心两者之间的整段区间时，就是 [滑动窗口](./2_sliding_window)，下一篇单独讲。

链表题目沿用 LeetCode 的结点定义：

```java
class ListNode {
    int val;
    ListNode next;
    ListNode(int val) { this.val = val; }
}
```

### 1、两数之和 II

LeetCode 167 两数之和 II - 输入有序数组：和偏小就右移左指针，偏大就左移右指针。每一步都排除了一整行（或一整列）不可能的组合：

```java
int[] twoSum(int[] numbers, int target) {
    int lo = 0, hi = numbers.length - 1;
    while (lo < hi) {
        int sum = numbers[lo] + numbers[hi];
        if (sum == target) return new int[]{lo + 1, hi + 1};   // 题目要求下标从 1 开始
        if (sum < target) lo++;
        else hi--;
    }
    return new int[]{-1, -1};
}
```

### 2、三数之和

LeetCode 15 三数之和：排序后固定第一个数，剩下两个用对撞指针。三处去重保证结果不重复：

```java
List<List<Integer>> threeSum(int[] nums) {
    Arrays.sort(nums);
    List<List<Integer>> res = new ArrayList<>();
    for (int i = 0; i < nums.length - 2; i++) {
        if (nums[i] > 0) break;                              // 最小的数已大于 0
        if (i > 0 && nums[i] == nums[i - 1]) continue;       // 第一个数去重
        int lo = i + 1, hi = nums.length - 1;
        while (lo < hi) {
            int sum = nums[i] + nums[lo] + nums[hi];
            if (sum == 0) {
                res.add(List.of(nums[i], nums[lo], nums[hi]));
                while (lo < hi && nums[lo] == nums[lo + 1]) lo++;   // 第二个数去重
                while (lo < hi && nums[hi] == nums[hi - 1]) hi--;   // 第三个数去重
                lo++;
                hi--;
            } else if (sum < 0) lo++;
            else hi--;
        }
    }
    return res;
}
```

### 3、盛最多水的容器

LeetCode 11：面积由较矮的一侧决定。移动较高的一侧，宽度变小、高度不会超过矮的一侧，面积只会变小；所以每次移动较矮的一侧：

```java
int maxArea(int[] height) {
    int lo = 0, hi = height.length - 1, best = 0;
    while (lo < hi) {
        best = Math.max(best, Math.min(height[lo], height[hi]) * (hi - lo));
        if (height[lo] < height[hi]) lo++;
        else hi--;
    }
    return best;
}
```

### 4、接雨水

LeetCode 42 接雨水：每格能接的水 = `min(左侧最高, 右侧最高) - 自身高度`。双指针从两端走，哪一侧的最高值更小，那一侧当前格子的水量就已经确定：

```java
int trap(int[] height) {
    int lo = 0, hi = height.length - 1;
    int leftMax = 0, rightMax = 0, water = 0;
    while (lo < hi) {
        leftMax = Math.max(leftMax, height[lo]);
        rightMax = Math.max(rightMax, height[hi]);
        if (leftMax < rightMax) water += leftMax - height[lo++];   // 左侧短板已确定
        else water += rightMax - height[hi--];
    }
    return water;
}
```

这题也可以用单调栈求解，见 [栈与队列](../1_data_structures/1_stack_queue)。

### 5、验证回文串

LeetCode 125 验证回文串：跳过非字母数字字符，忽略大小写比较两端：

```java
boolean isPalindrome(String s) {
    int lo = 0, hi = s.length() - 1;
    while (lo < hi) {
        while (lo < hi && !Character.isLetterOrDigit(s.charAt(lo))) lo++;
        while (lo < hi && !Character.isLetterOrDigit(s.charAt(hi))) hi--;
        if (Character.toLowerCase(s.charAt(lo)) != Character.toLowerCase(s.charAt(hi))) return false;
        lo++;
        hi--;
    }
    return true;
}
```

---

## 二、快慢指针

### 1、判断链表是否有环

LeetCode 141 环形链表（Floyd 判圈）：慢指针每次走一步，快指针每次走两步。有环时快指针进环后每轮追近一步，一定会追上；无环时快指针先走到 `null`：

```java
boolean hasCycle(ListNode head) {
    ListNode slow = head, fast = head;
    while (fast != null && fast.next != null) {
        slow = slow.next;
        fast = fast.next.next;
        if (slow == fast) return true;
    }
    return false;
}
```

### 2、找环的入口

LeetCode 142 环形链表 II：第一次相遇后，让一个指针回到表头，两个指针**都改为每次走一步**，再次相遇的位置就是环的入口：

```java
ListNode detectCycle(ListNode head) {
    ListNode slow = head, fast = head;
    while (fast != null && fast.next != null) {
        slow = slow.next;
        fast = fast.next.next;
        if (slow == fast) {                    // 第一次相遇
            ListNode p = head;
            while (p != slow) {                // 同速前进，相遇点即入口
                p = p.next;
                slow = slow.next;
            }
            return p;
        }
    }
    return null;
}
```

**证明**：设表头到入口的距离为 a，入口到相遇点的距离为 b，环长为 L。

![Floyd 判圈中的 a、b、L](../../assets/algorithms/floyd_cycle.svg)

- 相遇时慢指针走了 `a + b`（慢指针进环后不到一圈就会被追上），快指针走了 `a + b + k·L`（多绕了 k 圈，k ≥ 1）
- 快指针的路程是慢指针的两倍：`2(a + b) = a + b + k·L`，化简得 `a = k·L - b = (k - 1)·L + (L - b)`
- `L - b` 正是从相遇点继续向前走到入口的距离。所以从表头走 a 步，与从相遇点走 a 步（绕 k−1 整圈再走 L−b），会同时到达入口

### 3、链表的中间结点

LeetCode 876 链表的中间结点：快指针走到尾时，慢指针在中间。结点数为偶数时返回第二个中间结点：

```java
ListNode middleNode(ListNode head) {
    ListNode slow = head, fast = head;
    while (fast != null && fast.next != null) {
        slow = slow.next;
        fast = fast.next.next;
    }
    return slow;
}
```

如果要返回第一个中间结点（比如归并排序链表时从中间断开），把循环条件改成 `fast.next != null && fast.next.next != null`。

### 4、数组原地去重与移除

快指针扫描，慢指针指向「下一个保留元素要写入的位置」。

LeetCode 26 删除有序数组中的重复项：

```java
int removeDuplicates(int[] nums) {
    if (nums.length == 0) return 0;
    int slow = 0;
    for (int fast = 1; fast < nums.length; fast++) {
        if (nums[fast] != nums[slow]) nums[++slow] = nums[fast];
    }
    return slow + 1;
}
```

LeetCode 27 移除元素：

```java
int removeElement(int[] nums, int val) {
    int slow = 0;
    for (int fast = 0; fast < nums.length; fast++) {
        if (nums[fast] != val) nums[slow++] = nums[fast];
    }
    return slow;
}
```

---

## 三、固定间距指针

LeetCode 19 删除链表的倒数第 N 个结点：先让 `fast` 领先 `slow` n + 1 步，再同速前进；`fast` 走到 `null` 时，`slow` 正好停在待删结点的**前一个**。用哨兵结点 `dummy` 统一处理「删除的是头结点」的情况：

```java
ListNode removeNthFromEnd(ListNode head, int n) {
    ListNode dummy = new ListNode(0);
    dummy.next = head;
    ListNode fast = dummy, slow = dummy;
    for (int i = 0; i <= n; i++) fast = fast.next;   // 领先 n + 1 步
    while (fast != null) {
        fast = fast.next;
        slow = slow.next;
    }
    slow.next = slow.next.next;                      // 删除 slow 的后继
    return dummy.next;
}
```

一次遍历完成，时间 O(L)，空间 O(1)。

---

## 小结

- 对撞指针依赖有序性：每次移动都排除一批不可能的组合
- 三数之和 = 排序 + 固定一个数 + 对撞指针，三处去重
- Floyd 判圈：快二慢一；找入口时一个回表头、两个同速走，依据是 `a = (k - 1)·L + (L - b)`
- 快慢指针做数组原地去重，慢指针指向下一个写入位置
- 删除倒数第 N 个结点：哨兵结点 + 快指针先走 n + 1 步

## 参考资料

- OI Wiki 双指针：[https://oi-wiki.org/misc/two-pointer/](https://oi-wiki.org/misc/two-pointer/)
- LeetCode 142 环形链表 II：[https://leetcode.cn/problems/linked-list-cycle-ii/](https://leetcode.cn/problems/linked-list-cycle-ii/)

> 下一篇：[滑动窗口](./2_sliding_window) —— 固定窗口与可变窗口模板、单调队列、最小覆盖子串、异位词。
