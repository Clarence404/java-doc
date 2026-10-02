---
description: 子串 / 子数组问题
---

# 滑动窗口

---

## 一、滑动窗口思想

滑动窗口（Sliding Window）用一个**可变大小的窗口**在数组/字符串上滑动，将嵌套循环的 O(n²) 优化到 O(n)。

**核心框架：**
```java
int left = 0, right = 0;
// 窗口内的状态（如字符频次、当前和）
while (right < n) {
    // 1. 扩展窗口：将 arr[right] 加入窗口
    window.add(arr[right]);
    right++;

    // 2. 收缩窗口：当窗口不满足条件时收缩
    while (窗口需要收缩) {
        // 更新结果（满足条件时）
        window.remove(arr[left]);
        left++;
    }
    // 3. 更新结果（或在此处更新）
}
```

---

## 二、固定窗口大小

### 2.1 滑动窗口最大值（LeetCode 239）

维护单调递减的双端队列，队头始终是当前窗口最大值：

```java
int[] maxSlidingWindow(int[] nums, int k) {
    int n = nums.length;
    int[] res = new int[n - k + 1];
    Deque<Integer> deque = new ArrayDeque<>(); // 存下标

    for (int i = 0; i < n; i++) {
        // 移除窗口外的元素（队头过期）
        while (!deque.isEmpty() && deque.peekFirst() < i - k + 1)
            deque.pollFirst();
        // 维护单调递减（弹出比当前小的尾部元素）
        while (!deque.isEmpty() && nums[deque.peekLast()] < nums[i])
            deque.pollLast();
        deque.offerLast(i);
        // 窗口已满，记录结果
        if (i >= k - 1) res[i - k + 1] = nums[deque.peekFirst()];
    }
    return res;
}
```

### 2.2 大小为 K 的子数组平均值

```java
double[] movingAverage(int[] nums, int k) {
    double[] res = new double[nums.length - k + 1];
    int sum = 0;
    for (int i = 0; i < nums.length; i++) {
        sum += nums[i];
        if (i >= k - 1) {
            res[i - k + 1] = (double) sum / k;
            sum -= nums[i - k + 1]; // 滑出左边的元素
        }
    }
    return res;
}
```

---

## 三、可变窗口大小

### 3.1 无重复字符的最长子串（LeetCode 3）

```java
int lengthOfLongestSubstring(String s) {
    Map<Character, Integer> window = new HashMap<>();
    int left = 0, maxLen = 0;
    for (int right = 0; right < s.length(); right++) {
        char c = s.charAt(right);
        window.merge(c, 1, Integer::sum); // 入窗口
        // 有重复字符，收缩左边
        while (window.get(c) > 1) {
            char lc = s.charAt(left++);
            window.merge(lc, -1, Integer::sum);
        }
        maxLen = Math.max(maxLen, right - left + 1);
    }
    return maxLen;
}
```

### 3.2 最小覆盖子串（LeetCode 76）

找 s 中包含 t 所有字符的最小子串：

```java
String minWindow(String s, String t) {
    Map<Character, Integer> need = new HashMap<>(), window = new HashMap<>();
    for (char c : t.toCharArray()) need.merge(c, 1, Integer::sum);

    int left = 0, valid = 0; // valid：窗口中满足条件的字符数
    int start = 0, minLen = Integer.MAX_VALUE;

    for (int right = 0; right < s.length(); right++) {
        char c = s.charAt(right);
        if (need.containsKey(c)) {
            window.merge(c, 1, Integer::sum);
            if (window.get(c).equals(need.get(c))) valid++;
        }
        // 窗口包含所有字符时，收缩左边
        while (valid == need.size()) {
            if (right - left + 1 < minLen) {
                minLen = right - left + 1;
                start = left;
            }
            char lc = s.charAt(left++);
            if (need.containsKey(lc)) {
                if (window.get(lc).equals(need.get(lc))) valid--;
                window.merge(lc, -1, Integer::sum);
            }
        }
    }
    return minLen == Integer.MAX_VALUE ? "" : s.substring(start, start + minLen);
}
```

### 3.3 找所有字母异位词（LeetCode 438）

```java
List<Integer> findAnagrams(String s, String p) {
    List<Integer> res = new ArrayList<>();
    int[] need = new int[26], window = new int[26];
    for (char c : p.toCharArray()) need[c - 'a']++;
    int left = 0, valid = 0;

    for (int right = 0; right < s.length(); right++) {
        int rc = s.charAt(right) - 'a';
        window[rc]++;
        if (window[rc] == need[rc]) valid++;

        if (right - left + 1 == p.length()) { // 窗口大小固定
            if (valid == 26) res.add(left); // 不能用 need.size()，用26
            // 实际上应该计数 need[i] > 0 的字符种数
            int lc = s.charAt(left++) - 'a';
            if (window[lc] == need[lc]) valid--;
            window[lc]--;
        }
    }
    return res;
}
```

### 3.4 长度最小的子数组（LeetCode 209）

```java
int minSubArrayLen(int target, int[] nums) {
    int left = 0, sum = 0, minLen = Integer.MAX_VALUE;
    for (int right = 0; right < nums.length; right++) {
        sum += nums[right];
        while (sum >= target) {
            minLen = Math.min(minLen, right - left + 1);
            sum -= nums[left++];
        }
    }
    return minLen == Integer.MAX_VALUE ? 0 : minLen;
}
```

### 3.5 最长连续 1（含最多 K 个 0，LeetCode 1004）

```java
int longestOnes(int[] nums, int k) {
    int left = 0, zeros = 0, maxLen = 0;
    for (int right = 0; right < nums.length; right++) {
        if (nums[right] == 0) zeros++;
        while (zeros > k) {
            if (nums[left++] == 0) zeros--;
        }
        maxLen = Math.max(maxLen, right - left + 1);
    }
    return maxLen;
}
```

---

## 四、滑动窗口模板总结

```java
// 通用可变窗口模板
int left = 0;
Map<Character, Integer> window = new HashMap<>();
int ans = 0;

for (int right = 0; right < s.length(); right++) {
    // 1. 右指针扩展，更新窗口状态
    char addChar = s.charAt(right);
    window.merge(addChar, 1, Integer::sum);

    // 2. 判断是否需要收缩（不满足条件时）
    while (窗口不满足条件) {
        char removeChar = s.charAt(left++);
        window.merge(removeChar, -1, Integer::sum);
        if (window.get(removeChar) == 0) window.remove(removeChar);
    }

    // 3. 更新结果（窗口满足条件时）
    ans = Math.max(ans, right - left + 1);
}
```

---

## 五、经典题目

| 题目 | 类型 |
|------|------|
| LeetCode 3 无重复字符最长子串 | 可变窗口 |
| LeetCode 76 最小覆盖子串 | 可变窗口（字符覆盖）|
| LeetCode 209 长度最小的子数组 | 可变窗口（数值和）|
| LeetCode 239 滑动窗口最大值 | 固定窗口 + 单调队列 |
| LeetCode 438 找所有字母异位词 | 固定窗口 |
| LeetCode 567 字符串的排列 | 固定窗口 |
| LeetCode 1004 最大连续1的个数III | 可变窗口 |
| LeetCode 424 替换后的最长重复字符 | 可变窗口 |
