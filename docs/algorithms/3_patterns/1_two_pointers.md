---
description: 对撞指针、快慢指针、与滑动窗口的区别
---

# 双指针

---

## 一、双指针思想

双指针（Two Pointers）用两个指针在数组/链表上协同移动，将 O(n²) 的暴力解优化到 O(n)。

**分类：**
- **对撞指针**：左右指针向中间靠拢（有序数组、回文判断）
- **快慢指针**：两指针速度不同（链表环检测、找中点）
- **滑动窗口**：固定/可变窗口左右扩缩（详见下一节）

---

## 二、对撞指针

### 2.1 两数之和（有序数组，LeetCode 167）

```java
int[] twoSum(int[] nums, int target) {
    int lo = 0, hi = nums.length - 1;
    while (lo < hi) {
        int sum = nums[lo] + nums[hi];
        if (sum == target) return new int[]{lo + 1, hi + 1};
        else if (sum < target) lo++;
        else hi--;
    }
    return new int[]{-1, -1};
}
```

### 2.2 三数之和（LeetCode 15）

固定一个数，剩余两个用对撞指针：

```java
List<List<Integer>> threeSum(int[] nums) {
    Arrays.sort(nums);
    List<List<Integer>> res = new ArrayList<>();
    for (int i = 0; i < nums.length - 2; i++) {
        if (i > 0 && nums[i] == nums[i-1]) continue; // 去重
        int lo = i + 1, hi = nums.length - 1;
        while (lo < hi) {
            int sum = nums[i] + nums[lo] + nums[hi];
            if (sum == 0) {
                res.add(Arrays.asList(nums[i], nums[lo], nums[hi]));
                while (lo < hi && nums[lo] == nums[lo+1]) lo++; // 去重
                while (lo < hi && nums[hi] == nums[hi-1]) hi--; // 去重
                lo++; hi--;
            } else if (sum < 0) lo++;
            else hi--;
        }
    }
    return res;
}
```

### 2.3 接雨水（LeetCode 42）

```java
int trap(int[] height) {
    int lo = 0, hi = height.length - 1;
    int leftMax = 0, rightMax = 0, water = 0;
    while (lo < hi) {
        leftMax  = Math.max(leftMax,  height[lo]);
        rightMax = Math.max(rightMax, height[hi]);
        // 较小的一侧决定当前格的水量
        if (leftMax < rightMax) water += leftMax  - height[lo++];
        else                    water += rightMax - height[hi--];
    }
    return water;
}
```

### 2.4 验证回文串（LeetCode 125）

```java
boolean isPalindrome(String s) {
    int lo = 0, hi = s.length() - 1;
    while (lo < hi) {
        while (lo < hi && !Character.isLetterOrDigit(s.charAt(lo))) lo++;
        while (lo < hi && !Character.isLetterOrDigit(s.charAt(hi))) hi--;
        if (Character.toLowerCase(s.charAt(lo)) != Character.toLowerCase(s.charAt(hi)))
            return false;
        lo++; hi--;
    }
    return true;
}
```

### 2.5 盛最多水的容器（LeetCode 11）

```java
int maxArea(int[] height) {
    int lo = 0, hi = height.length - 1, maxWater = 0;
    while (lo < hi) {
        maxWater = Math.max(maxWater, Math.min(height[lo], height[hi]) * (hi - lo));
        if (height[lo] < height[hi]) lo++; // 移动较矮的那侧（期望找更高的）
        else hi--;
    }
    return maxWater;
}
```

---

## 三、快慢指针

### 3.1 检测链表环（Floyd 判圈）

```java
boolean hasCycle(ListNode head) {
    ListNode slow = head, fast = head;
    while (fast != null && fast.next != null) {
        slow = slow.next;
        fast = fast.next.next;
        if (slow == fast) return true; // 相遇 → 有环
    }
    return false;
}
```

### 3.2 找环的入口（LeetCode 142）

```java
ListNode detectCycle(ListNode head) {
    ListNode slow = head, fast = head;
    // 第一次相遇
    while (fast != null && fast.next != null) {
        slow = slow.next; fast = fast.next.next;
        if (slow == fast) break;
    }
    if (fast == null || fast.next == null) return null;
    // 一个指针从头，一个从相遇点，同速前进，再次相遇即为入口
    slow = head;
    while (slow != fast) { slow = slow.next; fast = fast.next; }
    return slow;
}
```

### 3.3 找链表中间节点

```java
ListNode middleNode(ListNode head) {
    ListNode slow = head, fast = head;
    while (fast != null && fast.next != null) {
        slow = slow.next; fast = fast.next.next;
    }
    return slow; // 偶数时返回第二个中点
}
```

### 3.4 删除有序数组重复项（LeetCode 26）

```java
int removeDuplicates(int[] nums) {
    int slow = 0;
    for (int fast = 1; fast < nums.length; fast++) {
        if (nums[fast] != nums[slow]) {
            nums[++slow] = nums[fast];
        }
    }
    return slow + 1; // 不重复元素个数
}
```

### 3.5 移除元素（LeetCode 27）

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

## 四、双指针 vs 滑动窗口

| | 对撞指针 | 快慢指针 | 滑动窗口 |
|--|---------|---------|---------|
| 数据要求 | 有序（通常）| 链表或数组 | 数组/字符串 |
| 指针方向 | 相向移动 | 同向不同速 | 同向移动（窗口）|
| 典型问题 | 两数之和、接雨水 | 环检测、中点 | 子串/子数组最值 |

---

## 五、经典题目

| 题目 | 考点 |
|------|------|
| LeetCode 167 两数之和 II | 对撞指针 |
| LeetCode 15 三数之和 | 排序 + 对撞 |
| LeetCode 11 盛最多水 | 对撞指针 |
| LeetCode 42 接雨水 | 对撞指针 / 单调栈 |
| LeetCode 141 环形链表 | 快慢指针 |
| LeetCode 142 环形链表 II | 快慢指针 |
| LeetCode 26 删除有序数组重复项 | 快慢指针 |
| LeetCode 19 删除链表倒数第N个节点 | 双指针间距 |
