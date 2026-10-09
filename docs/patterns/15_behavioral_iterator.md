---
description: Iterable 与 Iterator、fail-fast 与 CME、分页迭代器、内部迭代与 Stream、游标查询
---

# 迭代器模式

> **本篇目标**：理解迭代器模式的角色以及 Java `Iterable` / `Iterator` 如何对应它们，能写出可用于 for-each 和 Stream 的自定义迭代器，知道 fail-fast、游标查询等实际使用中的坑。
>
> **前置阅读**：[命令模式](./14_behavioral_command)、[集合框架](/java/21_topic_collection)

迭代器模式（Iterator）提供一种**顺序访问聚合对象中元素**的方式，而不暴露聚合的内部结构。数组、链表、树、分页查询结果，内部结构完全不同，但对外都可以用「还有没有下一个、取下一个」两个操作遍历。Java 把这个模式直接做进了语言：所有集合都实现 `Iterable`，for-each 循环就是迭代器的语法糖。

---

## 一、定义与角色

![迭代器模式的角色](../assets/patterns/iterator.svg)

| 角色 | Java 中的对应 | 职责 |
|------|--------------|------|
| Iterator（迭代器） | `java.util.Iterator<T>` | 声明 `hasNext()`、`next()`，可选 `remove()` |
| ConcreteIterator（具体迭代器） | `ArrayList` 内部类 `Itr`、本篇的 `PagedIterator` | 记录遍历位置（游标） |
| Aggregate（聚合） | `java.lang.Iterable<T>` | 声明 `iterator()`，负责创建迭代器 |
| ConcreteAggregate（具体聚合） | `ArrayList`、`HashSet`、本篇的分页用户集合 | 持有数据，返回对应的具体迭代器 |

遍历状态放在迭代器里而不是聚合里，所以同一个集合可以同时有多个独立的迭代器，互不干扰。

---

## 二、实现

### 1、for-each 背后的迭代器

```java
List<String> list = List.of("A", "B", "C");
for (String s : list) {
    System.out.println(s);
}
```

编译器会把上面的 for-each 展开成：

```java
Iterator<String> it = list.iterator();
while (it.hasNext()) {
    String s = it.next();
    System.out.println(s);
}
```

任何实现了 `Iterable` 的类都能用 for-each 遍历（数组的 for-each 则展开成下标循环）。

### 2、自定义分页迭代器

把「一页页查数据库」包装成迭代器，调用方像遍历普通集合一样遍历全部数据，不感知分页：

```java
public class PagedIterator<T> implements Iterator<T> {
    private final IntFunction<List<T>> pageLoader;   // 页号 → 该页数据
    private final int pageSize;
    private int nextPage = 0;
    private List<T> buffer = List.of();
    private int index = 0;
    private boolean lastPage = false;

    public PagedIterator(IntFunction<List<T>> pageLoader, int pageSize) {
        this.pageLoader = pageLoader;
        this.pageSize = pageSize;
    }

    @Override
    public boolean hasNext() {
        if (index < buffer.size()) {
            return true;
        }
        if (lastPage) {
            return false;
        }
        // 当前页用完才加载下一页；重复调用 hasNext 不会重复加载
        buffer = pageLoader.apply(nextPage++);
        index = 0;
        lastPage = buffer.size() < pageSize;
        return !buffer.isEmpty();
    }

    @Override
    public T next() {
        if (!hasNext()) {
            throw new NoSuchElementException();
        }
        return buffer.get(index++);
    }
}
```

`Iterable` 只有一个抽象方法，可以直接用 Lambda 实现，这样就能用于 for-each，也能转成 Stream：

```java
Iterable<User> allUsers = () -> new PagedIterator<>(
        page -> userRepository.findAll(PageRequest.of(page, 500)).getContent(), 500);

for (User user : allUsers) {          // 每次 for-each 都会新建一个迭代器，从第 0 页开始
    process(user);
}

long active = StreamSupport.stream(allUsers.spliterator(), false)
        .filter(User::isActive)
        .count();
```

按页号翻页时，越往后 `OFFSET` 越大、查询越慢，数据在遍历过程中被增删还会导致漏读或重复。数据量大时改为按主键翻页：记住上一页最后一条的 `id`，下一页查 `WHERE id > ? ORDER BY id LIMIT n`。

### 3、外部迭代与内部迭代

| 方式 | 谁控制遍历 | 写法 | 特点 |
|------|-----------|------|------|
| 外部迭代 | 调用方 | `Iterator`、for-each | 可以随时 `break`、可以同时遍历两个集合 |
| 内部迭代 | 集合或流 | `forEach(...)`、Stream | 只交出「对每个元素做什么」，便于惰性求值、并行化 |

Stream 也是建立在迭代思想上的：它的数据源抽象 `Spliterator` 除了逐个前进（`tryAdvance`），还能把剩余元素一分为二（`trySplit`），供并行流拆分任务。

---

## 三、JDK 与框架中的应用

| 例子 | 说明 |
|------|------|
| `Iterable` / `Iterator` / `ListIterator` | 集合框架的基础，`ListIterator` 还支持双向遍历和插入 |
| `Spliterator` | Stream 的数据源，支持拆分，用于并行流 |
| `Scanner` | 实现 `Iterator<String>`，逐个读取输入中的词元 |
| `DirectoryStream<Path>` | `Files.newDirectoryStream` 返回，实现 `Iterable`，用完必须关闭 |
| Spring Data 返回 `Stream<T>` 的查询方法 | 底层用数据库游标逐行读取，必须在事务中使用并关闭 |
| MyBatis `Cursor<T>` | 继承 `Closeable` 和 `Iterable`，遍历期间 `SqlSession` 必须保持打开 |

大数据量查询时，Spring Data 的流式查询写法如下：

```java
public interface UserRepository extends JpaRepository<User, Long> {

    @Query("select u from User u where u.active = true")
    Stream<User> streamActive();
}

@Transactional(readOnly = true)
public void sendNewsletter() {
    try (Stream<User> users = userRepository.streamActive()) {   // 关闭流才会释放游标和连接资源
        users.map(User::getEmail).forEach(mailService::send);
    }
}
```

不要写成 `userRepository.findAll().stream()`：`findAll()` 已经把整张表加载进内存，后面的 `stream()` 只是在内存列表上遍历。流式查询在不同数据库驱动上的行为（如 MySQL 需要设置 fetch size 才会真正逐行读取）要实测确认。

---

## 四、适用场景与常见坑

适合用迭代器的场景：

- 想让调用方遍历一个结构，又不想暴露它是数组、链表、树还是远程分页
- 同一个结构需要多种遍历方式（前序、中序、按层），每种方式一个迭代器
- 数据量大或来自 I/O，需要按需加载而不是一次全部读入

常见坑：

- **遍历时修改集合**：用 for-each 遍历 `ArrayList` 时调用 `list.remove(...)`，下一次 `next()` 会抛 `ConcurrentModificationException`。原因是 `ArrayList` 的迭代器是 fail-fast 的：创建时记下 `modCount`，每次 `next()` 检查是否被迭代器之外的操作修改过。要删除元素用 `it.remove()`，或直接 `list.removeIf("B"::equals)`
- **以为 fail-fast 能保证并发安全**：它只是尽力检测，多线程下不保证一定抛异常。并发场景用 `ConcurrentHashMap`（弱一致迭代器，不抛 CME，能看到部分并发修改）或 `CopyOnWriteArrayList`（快照迭代器，看不到迭代开始后的修改），细节见 [集合框架](/java/21_topic_collection#_3、fail-fast-与弱一致迭代器)
- **不可变集合上调用 `remove`**：`List.of(...)` 返回的集合，其迭代器的 `remove()` 抛 `UnsupportedOperationException`
- **迭代器只能用一次**：`Iterator` 和 `Stream` 遍历完就耗尽了，需要重复遍历时保存 `Iterable`，每次取新的迭代器
- **游标没关闭**：`Stream<T>` 查询、MyBatis `Cursor`、`DirectoryStream` 都持有底层资源，必须用 try-with-resources
- **对 I/O 数据源用并行流**：并行流使用公共 `ForkJoinPool`，数据源是数据库或远程分页时无法有效拆分，通常更慢还会占满公共线程池

---

## 五、与相近模式的区别

| 模式 | 关注点 | 关系 |
|------|--------|------|
| 迭代器 | **怎么遍历**：按什么顺序逐个访问元素 | 遍历逻辑从聚合中分离出来 |
| [组合](./8_structural_composite) | **结构**：树形的整体与部分 | 组合结构常配一个迭代器来遍历整棵树 |
| [访问者](./22_behavioral_visitor) | **对每个元素做什么**，且按元素类型做不同操作 | 迭代器负责走到每个元素，访问者负责处理它 |

迭代器回答「下一个是谁」，访问者回答「遇到这种节点做什么」，两者经常一起使用。

---

## 小结

- 迭代器把遍历状态和遍历逻辑从聚合中分离，Java 中 `Iterable` 是聚合、`Iterator` 是迭代器，for-each 是它的语法糖
- 自定义迭代器时同时提供 `Iterable`（可用 Lambda 实现），就能用于 for-each，并通过 `StreamSupport` 转成 Stream
- `ArrayList` 等集合的迭代器是 fail-fast 的，遍历中删除要用 `it.remove()` 或 `removeIf`；并发容器的迭代器是弱一致或快照的
- 大数据量用 Spring Data 的 `Stream<T>` 查询或 MyBatis `Cursor`，在事务内用 try-with-resources 关闭，不要用 `findAll().stream()`
- 迭代器负责「下一个是谁」，访问者负责「对它做什么」

## 参考资料

- Refactoring Guru：Iterator：[https://refactoring.guru/design-patterns/iterator](https://refactoring.guru/design-patterns/iterator)
- Erich Gamma 等：《设计模式：可复用面向对象软件的基础》，Iterator 一章
- Java SE 21 API：java.util.Iterator：[https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/Iterator.html](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/Iterator.html)
- Java SE 21 API：java.util.ArrayList（fail-fast 说明）：[https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/ArrayList.html](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/ArrayList.html)
- Spring Data JPA Reference：Query Methods（Streaming Query Results）：[https://docs.spring.io/spring-data/jpa/reference/repositories/query-methods-details.html](https://docs.spring.io/spring-data/jpa/reference/repositories/query-methods-details.html)
- MyBatis 3 Java API：[https://mybatis.org/mybatis-3/java-api.html](https://mybatis.org/mybatis-3/java-api.html)

> 下一篇：[中介者模式](./16_behavioral_mediator) —— 用中介对象集中管理多个对象之间的交互、中介者与观察者的区别。
