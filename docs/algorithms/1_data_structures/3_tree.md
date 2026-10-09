---
description: 二叉树术语与递归 / 迭代遍历、BST 增删查、AVL 旋转、红黑树性质与插入修复、B 树与 B+ 树
---

# 树

> **本篇目标**：掌握二叉树的四种遍历（递归与迭代写法）和 BST 的增删查，理解 AVL 与红黑树如何通过旋转维持平衡、各自的取舍，以及 B 树、B+ 树为什么适合磁盘存储。
>
> **前置阅读**：[栈与队列](./1_stack_queue)（迭代遍历要用栈、层序遍历要用队列）

树是「一对多」的层次结构。二叉搜索树把有序数组的二分查找搬到了动态结构上，平衡树保证它不退化成链表，B / B+ 树再把每个节点做「胖」，让树变矮以减少磁盘 I/O。Java 的 `TreeMap`、`HashMap` 的树化桶和 MySQL 的索引，都是这条演进线上的产物。

---

## 一、二叉树基础

### 1、定义与术语

```java
class TreeNode {
    int val;
    TreeNode left, right;
    TreeNode(int val) { this.val = val; }
}
```

| 术语 | 含义 |
|------|------|
| 深度 | 从根到该节点经过的边数，根的深度为 0 |
| 高度 | 从该节点到最远叶子经过的边数，叶子的高度为 0 |
| 完全二叉树 | 除最后一层外全满，最后一层的节点都靠左排列；堆就是完全二叉树 |
| 完美二叉树 | 所有层都填满，高度为 h 时节点数为 2^(h+1) − 1 |
| 完满二叉树 | 每个节点都有 0 个或 2 个子节点 |

**两个容易混淆的口径**：

- 国内教材（如严蔚敏《数据结构》）中的「满二叉树」指每一层都填满，即上表的完美二叉树；英文的 full binary tree 指每个节点有 0 或 2 个孩子，即完满二叉树。看到「满二叉树」要先确认是哪种定义
- 上表按边数定义深度和高度，而 LeetCode 104「二叉树的最大深度」按**节点数**计算，只有一个根节点时深度为 1。下文的 `maxDepth` 按 LeetCode 的口径实现

### 2、递归遍历

前、中、后序的区别只在「访问根」放在哪一步：

```java
// 前序：根 → 左 → 右
void preorder(TreeNode root, List<Integer> res) {
    if (root == null) return;
    res.add(root.val);
    preorder(root.left, res);
    preorder(root.right, res);
}

// 中序：左 → 根 → 右；BST 的中序结果是升序
void inorder(TreeNode root, List<Integer> res) {
    if (root == null) return;
    inorder(root.left, res);
    res.add(root.val);
    inorder(root.right, res);
}

// 后序：左 → 右 → 根；适合「先算出子树结果再汇总」的问题
void postorder(TreeNode root, List<Integer> res) {
    if (root == null) return;
    postorder(root.left, res);
    postorder(root.right, res);
    res.add(root.val);
}
```

### 3、迭代遍历与层序遍历

递归深度等于树高，退化成链表的树（如有序插入的 BST）可能有上万层，会栈溢出。改成显式栈即可：

```java
// 迭代前序：弹出即访问，先压右再压左，左孩子先出栈
List<Integer> preorderIter(TreeNode root) {
    List<Integer> res = new ArrayList<>();
    Deque<TreeNode> stack = new ArrayDeque<>();
    if (root != null) stack.push(root);
    while (!stack.isEmpty()) {
        TreeNode node = stack.pop();
        res.add(node.val);
        if (node.right != null) stack.push(node.right);
        if (node.left != null) stack.push(node.left);
    }
    return res;
}

// 迭代中序：一路向左压栈，弹出时访问，再转向右子树
List<Integer> inorderIter(TreeNode root) {
    List<Integer> res = new ArrayList<>();
    Deque<TreeNode> stack = new ArrayDeque<>();
    TreeNode cur = root;
    while (cur != null || !stack.isEmpty()) {
        while (cur != null) {
            stack.push(cur);
            cur = cur.left;
        }
        cur = stack.pop();
        res.add(cur.val);
        cur = cur.right;
    }
    return res;
}

// 层序遍历（BFS）：每轮先记下当前层的节点数，一次处理一整层
List<List<Integer>> levelOrder(TreeNode root) {
    List<List<Integer>> res = new ArrayList<>();
    if (root == null) return res;
    Queue<TreeNode> queue = new ArrayDeque<>();
    queue.offer(root);
    while (!queue.isEmpty()) {
        int size = queue.size();
        List<Integer> level = new ArrayList<>(size);
        for (int i = 0; i < size; i++) {
            TreeNode node = queue.poll();
            level.add(node.val);
            if (node.left != null) queue.offer(node.left);
            if (node.right != null) queue.offer(node.right);
        }
        res.add(level);
    }
    return res;
}
```

迭代后序可以按「根 → 右 → 左」做前序再把结果反转得到。若要求 O(1) 额外空间，可用 Morris 遍历：借用叶子节点的空闲右指针临时指回前驱，遍历完再恢复，时间仍是 O(n)。

### 4、常用递归模板

树的递归题大多是「当前节点的答案 = 用左右子树的答案组合出来」：

```java
// 最大深度（LeetCode 104，按节点数计）
int maxDepth(TreeNode root) {
    if (root == null) return 0;
    return 1 + Math.max(maxDepth(root.left), maxDepth(root.right));
}

// 对称二叉树（LeetCode 101）
boolean isSymmetric(TreeNode root) {
    return root == null || isMirror(root.left, root.right);
}

boolean isMirror(TreeNode l, TreeNode r) {
    if (l == null && r == null) return true;
    if (l == null || r == null) return false;
    return l.val == r.val && isMirror(l.left, r.right) && isMirror(l.right, r.left);
}

// 路径总和（LeetCode 112）：把目标值沿路径往下减
boolean hasPathSum(TreeNode root, int target) {
    if (root == null) return false;
    if (root.left == null && root.right == null) return root.val == target;
    return hasPathSum(root.left, target - root.val)
        || hasPathSum(root.right, target - root.val);
}
```

---

## 二、二叉搜索树（BST）

### 1、性质

- 左子树所有节点的值 < 根节点的值 < 右子树所有节点的值
- 左右子树也都是 BST
- **中序遍历结果为升序**

上述定义不允许重复值。需要存重复值时要约定一种策略：统一放到右子树（下文 `insert` 的写法，此时右子树满足 ≥），或者在节点上加计数字段。`TreeMap` 则不存重复 key：key 相同时只覆盖 value，不新增节点。

### 2、查找与插入

```java
TreeNode search(TreeNode root, int val) {
    while (root != null && root.val != val) {
        root = val < root.val ? root.left : root.right;
    }
    return root;
}

// 重复值放到右子树
TreeNode insert(TreeNode root, int val) {
    if (root == null) return new TreeNode(val);
    if (val < root.val) root.left = insert(root.left, val);
    else root.right = insert(root.right, val);
    return root;
}
```

### 3、删除

删除分三种情况，难点在第三种：

| 待删节点 | 处理 |
|----------|------|
| 叶子节点 | 直接删除 |
| 只有一个孩子 | 用这个孩子顶替它的位置 |
| 有两个孩子 | 找右子树的最小节点（中序后继），把值复制过来，再到右子树中删除这个后继 |

```java
// LeetCode 450
TreeNode delete(TreeNode root, int key) {
    if (root == null) return null;
    if (key < root.val) {
        root.left = delete(root.left, key);
    } else if (key > root.val) {
        root.right = delete(root.right, key);
    } else {
        if (root.left == null) return root.right;
        if (root.right == null) return root.left;
        TreeNode succ = root.right;
        while (succ.left != null) succ = succ.left;   // 右子树最小节点
        root.val = succ.val;
        root.right = delete(root.right, succ.val);
    }
    return root;
}
```

### 4、为什么需要平衡

BST 的操作都是 O(h)。随机插入时 h 约为 O(log n)，但**按有序序列插入时树会退化成链表**，h = n，所有操作退化为 O(n)。平衡树在插入和删除后通过旋转把高度控制在 O(log n)。

---

## 三、平衡二叉树（AVL 树）

AVL 树（Adelson-Velsky and Landis Tree）是最早的自平衡 BST。

### 1、平衡因子

**平衡因子 = 左子树高度 − 右子树高度**，AVL 要求每个节点的平衡因子都在 {−1, 0, 1} 之内，因此树高严格控制在约 1.44 log₂n 以内。

### 2、旋转操作

插入或删除后，从变动位置沿路径向上更新高度，找到第一个失衡节点 z，按失衡形态旋转：

| 失衡类型 | 含义 | 修复方式 |
|---------|------|---------|
| LL | z 的左孩子的左子树过高 | 对 z 右旋 |
| RR | z 的右孩子的右子树过高 | 对 z 左旋 |
| LR | z 的左孩子的右子树过高 | 先对左孩子左旋变成 LL，再对 z 右旋 |
| RL | z 的右孩子的左子树过高 | 先对右孩子右旋变成 RR，再对 z 左旋 |

![AVL 旋转：LL 型对 z 右旋，LR 型先左旋再右旋](../../assets/algorithms/avl_rotation.svg)

右旋的代码只改三个指针，旋转前后中序顺序不变，所以 BST 性质保持成立：

```java
class AvlNode {
    int val, height = 1;          // 这里按节点数计高度，空树为 0
    AvlNode left, right;
    AvlNode(int val) { this.val = val; }
}

int height(AvlNode n) { return n == null ? 0 : n.height; }

void update(AvlNode n) {
    n.height = 1 + Math.max(height(n.left), height(n.right));
}

AvlNode rotateRight(AvlNode z) {
    AvlNode y = z.left;
    z.left = y.right;     // y 的右子树 T3 挂到 z 的左边
    y.right = z;          // z 降为 y 的右孩子
    update(z);            // 先更新下层的 z，再更新上层的 y
    update(y);
    return y;             // y 成为这棵子树的新根
}
```

左旋与之镜像对称。

### 3、旋转次数与代价

| 操作 | 旋转次数 | 说明 |
|------|----------|------|
| 插入 | 至多一次单旋或一次双旋 | 旋转后子树高度恢复原值，上层不再失衡 |
| 删除 | 最坏 O(log n) 次 | 旋转可能让子树变矮，失衡沿路径一路向上传递 |

AVL 的主要开销不在旋转本身，而在每次修改后都要沿路径向上更新高度、检查平衡因子。它的树更矮、查找略快，适合查多改少的场景。

---

## 四、红黑树（Red-Black Tree）

### 1、五条性质

1. 每个节点是**红色或黑色**
2. **根节点**是黑色
3. **叶节点**（空的 NIL 节点）是黑色
4. **红节点的两个子节点都是黑色**，即不能有连续两个红节点
5. 从任一节点到其每个叶节点的所有路径上，**黑色节点数量相同**（称为黑高）

性质 4 和 5 合起来保证：最长路径（红黑交替）不超过最短路径（全黑）的 2 倍，所以树高不超过 2 log₂(n + 1)。红黑树用「近似平衡」换来了更少的调整。

### 2、插入修复的思路

新节点总是染成**红色**插入，这样不会改变任何路径的黑高（不破坏性质 5），只可能和红色父节点冲突（破坏性质 4）：

| 情况 | 处理 | 结果 |
|------|------|------|
| 父节点是黑色 | 什么都不用做 | 结束 |
| 父红、叔叔红 | 父和叔叔染黑，祖父染红，把祖父当作新插入节点继续向上检查 | 只变色不旋转，问题上移两层 |
| 父红、叔叔黑 | 按 LL / LR / RR / RL 形态做一次或两次旋转，再交换颜色 | 结束 |

所以插入最多旋转 2 次，删除最多旋转 3 次，其余调整都是变色。`TreeMap` 源码中的 `fixAfterInsertion` 和 `fixAfterDeletion` 就是这两段修复逻辑，对照阅读最直观。

### 3、与 AVL 对比

| | AVL 树 | 红黑树 |
|--|--------|--------|
| 平衡标准 | 严格：任一节点左右子树高度差 ≤ 1 | 近似：最长路径不超过最短路径的 2 倍 |
| 树高上界 | 约 1.44 log₂n | 2 log₂(n + 1) |
| 查找 | 略快（树更矮） | 略慢 |
| 插入 | 至多 2 次旋转，要沿路径更新高度 | 至多 2 次旋转，其余只变色 |
| 删除 | 最坏 O(log n) 次旋转 | 至多 3 次旋转 |
| 适用 | 查多改少 | 读写均衡，通用库的首选 |

### 4、工程应用

- **Java `TreeMap` / `TreeSet`**：底层就是红黑树，提供有序遍历和 `floorKey`、`ceilingKey` 等范围操作
- **Java 8+ `HashMap`**：桶内链表超过 8 个节点且数组长度不小于 64 时转为红黑树，扩容拆分后不超过 6 个节点时退回链表，阈值的来龙去脉见 [集合框架](/java/21_topic_collection)
- **Linux 进程调度**：CFS 调度器用红黑树按虚拟运行时间组织可运行进程；Linux 6.6 起默认调度器换成 EEVDF，仍以红黑树为核心结构
- **Nginx**：定时器事件存放在红黑树中，每次取最早到期的事件

---

## 五、B 树（B-Tree）

二叉树每个节点只有两个分叉，存 10 亿条数据要约 30 层。如果每层都要读一次磁盘，一次查询就是 30 次随机 I/O。B 树让一个节点存**很多个 key、有很多个分叉**，节点大小对齐磁盘页，树高因此只有 3～4 层。

### 1、m 阶 B 树的性质

- 每个节点最多 m 个子节点、m − 1 个 key
- 非根的内部节点至少有 ⌈m/2⌉ 个子节点
- 根节点不是叶子时至少有 2 个子节点
- 所有叶子节点在同一层
- 节点内的 key 有序，key 之间的指针指向值介于两者之间的子树

### 2、特点

- key 和数据既存在内部节点也存在叶子节点，查找可能在中途命中提前结束
- 查找要访问的节点数等于树高，为 O(logₘn)；每个节点内再做一次二分查找
- 插入时节点满了就分裂，删除时节点过空就向兄弟借 key 或合并，始终保持所有叶子同层
- 应用：MongoDB 的 WiredTiger 引擎、多数文件系统的目录与元数据索引（HFS+、NTFS、XFS、Btrfs 等使用 B 树或 B+ 树变体）

---

## 六、B+ 树（B+ Tree）

B+ 树是 B 树的变种：**数据只存在叶子节点**，内部节点只存 key 作为索引，叶子节点之间用链表相连。

### 1、与 B 树的关键区别

| | B 树 | B+ 树 |
|--|------|-------|
| 数据位置 | 内部节点和叶子节点都有 | 只在叶子节点 |
| 内部节点 | key + 数据 | 只有 key，同样大小能放更多 key，树更矮 |
| 叶子链接 | 无 | 叶子之间有链表 |
| 范围查询 | 要在树上反复回溯 | 找到起点后沿叶子链表顺序扫描 |
| 单次查询 | 可能在内部节点提前命中 | 必须走到叶子，路径长度稳定 |

### 2、为什么数据库索引偏爱 B+ 树

1. **树更矮**：内部节点只存 key，一个页能放上千个分叉，千万级数据只需 3 层
2. **范围查询快**：`BETWEEN`、`ORDER BY` 找到起点后沿叶子链表顺序读即可
3. **查询稳定**：所有查询都走到叶子，耗时可预测

以 InnoDB 的默认参数估算三层 B+ 树的容量，前提是主键为 `BIGINT`、每行约 1 KB：

- 页大小 16 KB，内部节点每项 = 8 字节主键 + 6 字节页指针 = 14 字节
- 每个内部页约 16 × 1024 ÷ 14 ≈ 1170 个分叉
- 每个叶子页放 16 KB ÷ 1 KB = 16 行
- 三层可存 1170 × 1170 × 16 ≈ 2190 万行

行越大，每个叶子页放的行越少，容量随之下降。聚簇索引、二级索引与回表等 InnoDB 细节见 [MySQL 索引](/database/1_mysql/4_topic_index)。

---

## 七、经典题目

| 题目 | 考点 |
|------|------|
| LeetCode 94 二叉树的中序遍历 | 递归 / 迭代 |
| LeetCode 102 二叉树的层序遍历 | BFS + 队列 |
| LeetCode 104 二叉树的最大深度 | 递归 |
| LeetCode 226 翻转二叉树 | 递归 |
| LeetCode 236 二叉树的最近公共祖先 | 后序递归 |
| LeetCode 105 从前序与中序遍历序列构造二叉树 | 分治 + 哈希表定位根 |
| LeetCode 98 验证二叉搜索树 | 中序遍历 / 上下界递归 |
| LeetCode 230 二叉搜索树中第 K 小的元素 | 中序遍历 |
| LeetCode 450 删除二叉搜索树中的节点 | BST 删除三种情况 |

---

## 小结

- 深度、高度按边数还是节点数计要先确认口径；国内「满二叉树」指完美二叉树
- 遍历四件套：前中后序的递归与迭代写法、层序遍历；树高很大时用迭代避免栈溢出
- BST 的增删查都是 O(h)，删除有两个孩子的节点时用中序后继顶替
- AVL 严格平衡，插入至多一次单旋或双旋，删除可能 O(log n) 次旋转
- 红黑树近似平衡，插入至多 2 次、删除至多 3 次旋转，是 `TreeMap` 和 `HashMap` 树化桶的底层结构
- B / B+ 树用多路分叉降低树高以减少磁盘 I/O；B+ 树数据只在叶子且叶子相连，是数据库索引的首选

## 参考资料

- Hello 算法 · 树：[https://www.hello-algo.com/chapter_tree/](https://www.hello-algo.com/chapter_tree/)
- OpenJDK TreeMap 源码（`fixAfterInsertion` / `fixAfterDeletion`）：[https://github.com/openjdk/jdk/blob/master/src/java.base/share/classes/java/util/TreeMap.java](https://github.com/openjdk/jdk/blob/master/src/java.base/share/classes/java/util/TreeMap.java)
- JDK 21 TreeMap API：[https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/TreeMap.html](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/TreeMap.html)
- MySQL 8.0 Reference Manual · The Physical Structure of an InnoDB Index：[https://dev.mysql.com/doc/refman/8.0/en/innodb-physical-structure.html](https://dev.mysql.com/doc/refman/8.0/en/innodb-physical-structure.html)

> 下一篇：[堆](./4_heap) —— 二叉堆、上浮与下沉、建堆、堆排序、优先队列与 Top K。
