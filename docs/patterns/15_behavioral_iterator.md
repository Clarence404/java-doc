# 迭代器模式

**作用**：提供一种方式**顺序访问聚合对象**中的元素，而不暴露其内部表示。

**应用场景**：
- Java `Iterator` / `Iterable` 接口（所有集合类的基础）
- `for-each` 循环（底层调用 `iterator()`）
- `Stream` API（惰性迭代器）
- MyBatis `Cursor`（大数据量游标查询，避免 OOM）

---

## 一、Java 内置迭代器

```java
// for-each 本质是 Iterator
List<String> list = List.of("A", "B", "C");
for (String s : list) {               // 编译器展开为：
    System.out.println(s);            // Iterator<String> it = list.iterator();
}                                     // while (it.hasNext()) { String s = it.next(); ... }

// 使用 Iterator 安全删除元素
List<String> mutable = new ArrayList<>(List.of("A", "B", "C", "D"));
Iterator<String> it = mutable.iterator();
while (it.hasNext()) {
    if ("B".equals(it.next())) {
        it.remove();  // 安全删除，避免 ConcurrentModificationException
    }
}
```

---

## 二、自定义迭代器

以「分页数据迭代器」为例，透明地将分页请求包装成流式迭代：

```java
public class PagedIterator<T> implements Iterator<T> {
    private final Function<Integer, List<T>> pageLoader;
    private final int pageSize;
    private int currentPage = 0;
    private List<T> buffer = Collections.emptyList();
    private int bufferIndex = 0;
    private boolean done = false;

    public PagedIterator(Function<Integer, List<T>> pageLoader, int pageSize) {
        this.pageLoader = pageLoader;
        this.pageSize   = pageSize;
    }

    @Override
    public boolean hasNext() {
        if (bufferIndex < buffer.size()) return true;
        if (done) return false;

        buffer = pageLoader.apply(currentPage++);
        bufferIndex = 0;

        if (buffer.size() < pageSize) done = true;
        return !buffer.isEmpty();
    }

    @Override
    public T next() {
        if (!hasNext()) throw new NoSuchElementException();
        return buffer.get(bufferIndex++);
    }
}

// 使用：迭代所有用户，底层自动分页查询
Iterator<User> users = new PagedIterator<>(
    page -> userRepository.findAll(PageRequest.of(page, 100)).getContent(), 100);

while (users.hasNext()) {
    process(users.next());  // 调用方无感知分页逻辑
}
```

---

## 三、Stream API（现代推荐）

```java
// Stream 是更强大的惰性迭代器
userRepository.findAll().stream()
    .filter(u -> u.isActive())
    .map(User::getEmail)
    .forEach(email -> sendEmail(email));

// 大数据量用 Spliterator + parallel
Stream<User> parallelStream = StreamSupport.stream(
    userSpliterator, true);  // true = parallel
```
