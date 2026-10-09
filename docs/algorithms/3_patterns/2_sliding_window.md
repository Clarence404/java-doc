---
description: 固定窗口与可变窗口模板、单调队列、最小覆盖子串、字母异位词、替换后的最长重复字符
---

# 滑动窗口

> **本篇目标**：掌握固定窗口与可变窗口两套模板，会用单调队列求窗口最值，能写对最小覆盖子串、找到字符串中所有字母异位词等字符计数类题目。
>
> **前置阅读**：[双指针](./1_two_pointers)、[哈希表](../1_data_structures/2_hash_table)

---

## 一、核心思想与模板

滑动窗口用 `[left, right]` 两个同向移动的指针维护一段连续区间：右指针不断扩张，窗口不满足条件时左指针收缩。每个元素最多进窗口一次、出窗口一次，嵌套循环的 O(n²) 降为 O(n)。

适用前提：窗口扩大时某个量单调变化（和变大、种类变多），这样收缩左边界的时机才能确定。数组里有负数时「和」不再单调，求「和为 k 的子数组」要改用 [前缀和与差分数组](./3_prefix_sum)。

可变窗口的通用模板（伪代码）：

```text
left = 0
for right in 0 .. n-1:
    把 s[right] 加入窗口，更新窗口状态
    while 窗口不满足条件:
        把 s[left] 移出窗口，更新窗口状态
        left++
    此时 [left, right] 满足条件，更新答案（求最长时在这里更新）
```

求**最短**满足条件的窗口时反过来：`while 窗口满足条件` 时先更新答案再收缩，见最小覆盖子串。

![可变窗口的扩张与收缩](../../assets/algorithms/sliding_window.svg)

---

## 二、固定窗口

窗口大小固定为 k 时，每次右移一格：加入新元素、移出 `right - k` 位置的旧元素。

### 1、子数组最大平均数

LeetCode 643 子数组最大平均数 I：维护窗口和，和用 `long`，避免大数组累加溢出：

```java
double findMaxAverage(int[] nums, int k) {
    long sum = 0;
    for (int i = 0; i < k; i++) sum += nums[i];
    long best = sum;
    for (int i = k; i < nums.length; i++) {
        sum += nums[i] - nums[i - k];          // 进一个，出一个
        best = Math.max(best, sum);
    }
    return (double) best / k;
}
```

### 2、滑动窗口最大值

LeetCode 239 滑动窗口最大值：用**单调递减的双端队列**存下标，队头始终是当前窗口的最大值。新元素入队前，把队尾比它小的元素都弹出——它们比新元素先离开窗口，又比新元素小，不可能再成为最大值：

```java
int[] maxSlidingWindow(int[] nums, int k) {
    int n = nums.length;
    int[] res = new int[n - k + 1];
    Deque<Integer> deque = new ArrayDeque<>();           // 存下标，对应的值单调递减
    for (int i = 0; i < n; i++) {
        if (!deque.isEmpty() && deque.peekFirst() <= i - k) deque.pollFirst();   // 队头已出窗口
        while (!deque.isEmpty() && nums[deque.peekLast()] < nums[i]) deque.pollLast();
        deque.offerLast(i);
        if (i >= k - 1) res[i - k + 1] = nums[deque.peekFirst()];
    }
    return res;
}
```

每个下标最多入队、出队各一次，O(n)。

### 3、找到字符串中所有字母异位词

LeetCode 438：在 s 中找出所有与 p 字母组成相同的子串起点。窗口长度固定为 `p.length()`，用两个长度 26 的计数数组比较：

```java
List<Integer> findAnagrams(String s, String p) {
    List<Integer> res = new ArrayList<>();
    int k = p.length();
    if (s.length() < k) return res;
    int[] need = new int[26], window = new int[26];
    for (char c : p.toCharArray()) need[c - 'a']++;
    for (int right = 0; right < s.length(); right++) {
        window[s.charAt(right) - 'a']++;                   // 进窗口
        if (right >= k) window[s.charAt(right - k) - 'a']--;   // 出窗口
        if (right >= k - 1 && Arrays.equals(need, window)) res.add(right - k + 1);
    }
    return res;
}
```

每步比较 26 个计数，总时间 O(26·n)。如果用「已满足的字符种类数 `valid`」来判断，阈值必须是 **p 中出现的字符种类数**，不能写成固定的 26，否则 p 没有包含全部 26 个字母时永远匹配不上。

LeetCode 567 字符串的排列是同一题的判定版：找到第一个匹配就返回 `true`。

---

## 三、可变窗口

### 1、无重复字符的最长子串

LeetCode 3：窗口内出现重复字符时收缩左边，直到重复消失：

```java
int lengthOfLongestSubstring(String s) {
    Map<Character, Integer> window = new HashMap<>();
    int left = 0, best = 0;
    for (int right = 0; right < s.length(); right++) {
        char c = s.charAt(right);
        window.merge(c, 1, Integer::sum);
        while (window.get(c) > 1) {                       // 有重复，收缩
            window.merge(s.charAt(left++), -1, Integer::sum);
        }
        best = Math.max(best, right - left + 1);
    }
    return best;
}
```

### 2、长度最小的子数组

LeetCode 209：数组元素全为正数，窗口和随右扩单调增大。和达到目标后不断收缩，记录最短长度：

```java
int minSubArrayLen(int target, int[] nums) {
    int left = 0, best = Integer.MAX_VALUE;
    long sum = 0;
    for (int right = 0; right < nums.length; right++) {
        sum += nums[right];
        while (sum >= target) {                           // 满足条件，先记录再收缩
            best = Math.min(best, right - left + 1);
            sum -= nums[left++];
        }
    }
    return best == Integer.MAX_VALUE ? 0 : best;
}
```

### 3、最小覆盖子串

LeetCode 76：找 s 中涵盖 t 所有字符（含重复次数）的最短子串。`valid` 记录**已经满足需求的字符种类数**，等于 `need.size()` 时窗口合法：

```java
String minWindow(String s, String t) {
    Map<Character, Integer> need = new HashMap<>(), window = new HashMap<>();
    for (char c : t.toCharArray()) need.merge(c, 1, Integer::sum);
    int left = 0, valid = 0, start = 0, minLen = Integer.MAX_VALUE;
    for (int right = 0; right < s.length(); right++) {
        char c = s.charAt(right);
        if (need.containsKey(c)) {
            window.merge(c, 1, Integer::sum);
            if (window.get(c).equals(need.get(c))) valid++;    // Integer 比较用 equals
        }
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

`window.get(c) == need.get(c)` 比较的是两个 `Integer` 对象的引用，超出 -128~127 的缓存范围就会出错，必须用 `equals`。

### 4、最大连续 1 的个数 III

LeetCode 1004：最多把 k 个 0 翻成 1，求最长的全 1 子数组。等价于「窗口内 0 的个数不超过 k」的最长窗口：

```java
int longestOnes(int[] nums, int k) {
    int left = 0, zeros = 0, best = 0;
    for (int right = 0; right < nums.length; right++) {
        if (nums[right] == 0) zeros++;
        while (zeros > k) {
            if (nums[left++] == 0) zeros--;
        }
        best = Math.max(best, right - left + 1);
    }
    return best;
}
```

### 5、替换后的最长重复字符

LeetCode 424：最多替换 k 个字符，使窗口内字符全部相同。窗口合法的条件是 `窗口长度 - 窗口内最多字符的次数 <= k`。

这题有个技巧：**窗口只扩不缩**。不合法时左指针只右移一格，窗口长度保持不变；`maxCount` 也不随左移减小。因为答案只在 `maxCount` 变大时才可能变长，用一个偏大的历史 `maxCount` 不会产生错误答案：

```java
int characterReplacement(String s, int k) {
    int[] count = new int[26];
    int left = 0, maxCount = 0;
    for (int right = 0; right < s.length(); right++) {
        maxCount = Math.max(maxCount, ++count[s.charAt(right) - 'A']);
        if (right - left + 1 - maxCount > k) {             // 不合法：整体右移一格
            count[s.charAt(left++) - 'A']--;
        }
    }
    return s.length() - left;                              // 窗口长度只增不减，最终即答案
}
```

---

## 小结

- 滑动窗口要求窗口扩大时某个量单调变化；有负数求和时改用前缀和
- 固定窗口：进一个、出一个；窗口最值用单调递减双端队列
- 可变窗口求最长：不满足时收缩，收缩后更新答案；求最短：满足时先更新再收缩
- 字符计数类题目：26 个字母用 `int[26]`，`valid` 的阈值是需要的字符种类数；`Integer` 比较用 `equals`
- LeetCode 424 的窗口只扩不缩，`maxCount` 不必回退

## 参考资料

- OI Wiki 单调队列：[https://oi-wiki.org/ds/monotonous-queue/](https://oi-wiki.org/ds/monotonous-queue/)
- OI Wiki 双指针：[https://oi-wiki.org/misc/two-pointer/](https://oi-wiki.org/misc/two-pointer/)
- Java 21 `Integer.valueOf` 缓存说明：[https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/lang/Integer.html#valueOf(int)](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/lang/Integer.html#valueOf(int))

> 下一篇：[前缀和与差分数组](./3_prefix_sum) —— 一维 / 二维前缀和、差分数组、前缀和 + 哈希求子数组和。
