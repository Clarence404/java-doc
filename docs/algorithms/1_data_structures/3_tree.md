---
description: 二叉树、BST、AVL、红黑树、B / B+ 树
---

# 树

---

## 一、二叉树基础

### 1.1 定义与节点

```java
class TreeNode {
    int val;
    TreeNode left, right;
    TreeNode(int val) { this.val = val; }
}
```

**常见术语：**
- **深度**：从根节点到该节点的边数
- **高度**：从该节点到最远叶子节点的边数
- **满二叉树**：每个节点都有 0 或 2 个子节点
- **完全二叉树**：除最后一层外全满，且最后一层靠左

### 1.2 遍历方式

```java
// 前序遍历（根→左→右）
void preorder(TreeNode root, List<Integer> res) {
    if (root == null) return;
    res.add(root.val);
    preorder(root.left, res);
    preorder(root.right, res);
}

// 中序遍历（左→根→右）BST 中序 = 升序
void inorder(TreeNode root, List<Integer> res) {
    if (root == null) return;
    inorder(root.left, res);
    res.add(root.val);
    inorder(root.right, res);
}

// 后序遍历（左→右→根）
void postorder(TreeNode root, List<Integer> res) {
    if (root == null) return;
    postorder(root.left, res);
    postorder(root.right, res);
    res.add(root.val);
}

// 层序遍历（BFS）
List<List<Integer>> levelOrder(TreeNode root) {
    List<List<Integer>> res = new ArrayList<>();
    if (root == null) return res;
    Queue<TreeNode> queue = new LinkedList<>();
    queue.offer(root);
    while (!queue.isEmpty()) {
        int size = queue.size();
        List<Integer> level = new ArrayList<>();
        for (int i = 0; i < size; i++) {
            TreeNode node = queue.poll();
            level.add(node.val);
            if (node.left  != null) queue.offer(node.left);
            if (node.right != null) queue.offer(node.right);
        }
        res.add(level);
    }
    return res;
}
```

### 1.3 常用递归模板

```java
// 求树的最大深度
int maxDepth(TreeNode root) {
    if (root == null) return 0;
    return 1 + Math.max(maxDepth(root.left), maxDepth(root.right));
}

// 判断对称二叉树
boolean isSymmetric(TreeNode root) {
    return isMirror(root.left, root.right);
}
boolean isMirror(TreeNode l, TreeNode r) {
    if (l == null && r == null) return true;
    if (l == null || r == null) return false;
    return l.val == r.val && isMirror(l.left, r.right) && isMirror(l.right, r.left);
}

// 路径总和
boolean hasPathSum(TreeNode root, int target) {
    if (root == null) return false;
    if (root.left == null && root.right == null) return root.val == target;
    return hasPathSum(root.left, target - root.val)
        || hasPathSum(root.right, target - root.val);
}
```

---

## 二、二叉搜索树（BST）

### 2.1 性质

- 左子树所有节点 < 根节点
- 右子树所有节点 > 根节点
- **中序遍历结果为升序**

### 2.2 搜索与插入

```java
// 搜索
TreeNode search(TreeNode root, int val) {
    if (root == null || root.val == val) return root;
    return val < root.val ? search(root.left, val) : search(root.right, val);
}

// 插入
TreeNode insert(TreeNode root, int val) {
    if (root == null) return new TreeNode(val);
    if (val < root.val) root.left  = insert(root.left,  val);
    else                root.right = insert(root.right, val);
    return root;
}
```

---

## 三、平衡二叉树（AVL 树）

Adelson-Velsky and Landis Tree，最早的自平衡 BST。

### 3.1 平衡因子

每个节点的**平衡因子 = 左子树高度 - 右子树高度**，AVL 要求所有节点的平衡因子在 **{-1, 0, 1}** 之间。

### 3.2 旋转操作

插入/删除破坏平衡时，通过旋转恢复：

| 失衡类型 | 修复方式 |
|---------|---------|
| LL（左子树的左侧过重）| 右旋 |
| RR（右子树的右侧过重）| 左旋 |
| LR（左子树的右侧过重）| 先左旋子树，再右旋 |
| RL（右子树的左侧过重）| 先右旋子树，再左旋 |

```
右旋示例：
    z                 y
   / \              /   \
  y   T4    →     x      z
 / \            / \    /   \
x   T3         T1 T2  T3   T4
```

### 3.3 特点

| 特性 | 说明 |
|------|------|
| 查找 | O(log n)，严格平衡，最快 |
| 插入/删除 | O(log n)，但旋转次数多（维护代价高） |
| 适用 | 查多写少场景 |

---

## 四、红黑树（Red-Black Tree）

### 4.1 五条性质

1. 每个节点是**红色或黑色**
2. **根节点**是黑色
3. **叶节点**（NIL 节点）是黑色
4. **红节点**的两个子节点都是黑色（不能有连续两个红节点）
5. 从任意节点到其叶节点的所有路径，**黑色节点数量相同**（黑高相同）

### 4.2 与 AVL 对比

| | AVL 树 | 红黑树 |
|--|--------|--------|
| 平衡性 | 严格（高度差 ≤ 1）| 近似（黑高相等）|
| 查找 | 略快（更矮）| 略慢 |
| 插入/删除 | 旋转更多 | 旋转更少，代价更低 |
| 适用 | 查多写少 | 读写均衡（Java TreeMap/HashMap 用红黑树）|

### 4.3 工程应用

- **Java TreeMap / TreeSet**：底层红黑树
- **Java 8+ HashMap**：链表退化后转红黑树（长度 > 8）
- **Linux CFS 调度器**：用红黑树管理进程
- **Nginx**：定时器管理

---

## 五、B 树（B Tree）

多路平衡搜索树，专为**磁盘 I/O 优化**设计，一个节点存多个 key，减少磁盘访问次数。

### 5.1 M 阶 B 树性质

- 每个节点最多 M 个子节点，M-1 个 key
- 非根非叶节点至少有 ⌈M/2⌉ 个子节点
- 所有叶节点在同一层
- 根节点至少 2 个子节点（除非是叶节点）

### 5.2 特点

- 数据既存在内部节点也存在叶节点
- 适合文件系统（HFS+、ext4）
- 查找 O(log n)，但最坏情况下需访问多个节点

---

## 六、B+ 树（B+ Tree）

B 树的变种，**数据只存在叶节点**，内部节点只存 key（索引）。

### 6.1 与 B 树的关键区别

| | B 树 | B+ 树 |
|--|------|-------|
| 数据位置 | 内部节点 + 叶节点 | 只在叶节点 |
| 叶节点链接 | 无 | 双向链表相连 |
| 范围查询 | 需回溯 | 遍历叶节点链表，高效 |
| 单次查询 | 可能更快（数据在上层）| 必须到叶节点 |

### 6.2 为什么 MySQL InnoDB 用 B+ 树？

1. **叶节点链表**：支持高效范围查询（`BETWEEN`、`ORDER BY`）
2. **内部节点只存 key**：同样页大小能存更多 key，树更矮，I/O 次数更少
3. **查询路径稳定**：所有查询都到叶节点，性能更可预测

```
InnoDB 页大小 16KB，一个 key 约 8B + 指针 6B = 14B
每页约 16*1024/14 ≈ 1170 个 key
三层 B+ 树可存：1170 × 1170 × 16 ≈ 2200 万行数据
```

---

## 七、经典题目

| 题目 | 考点 |
|------|------|
| LeetCode 94 二叉树中序遍历 | 递归/迭代 |
| LeetCode 102 二叉树层序遍历 | BFS + 队列 |
| LeetCode 104 二叉树最大深度 | 递归 |
| LeetCode 226 翻转二叉树 | 递归 |
| LeetCode 236 二叉树最近公共祖先 | 递归回溯 |
| LeetCode 105 从前序与中序构造二叉树 | 递归 |
| LeetCode 98 验证二叉搜索树 | 中序遍历 |
| LeetCode 230 BST 中第 K 小的元素 | 中序遍历 |
