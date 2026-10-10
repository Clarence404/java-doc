---
description: 定义与角色、不透明快照、编辑前保存、撤销 / 重做栈、深拷贝与内存、快照 vs 命令撤销
---

# 备忘录模式

> 前置阅读：[命令模式](./14_behavioral_command)

备忘录模式在不破坏封装的前提下保存并恢复对象状态。本篇讲三个角色与「快照对外不透明」的要求、正确的撤销 / 重做实现，以及快照式撤销与命令式撤销的取舍。

---

## 一、定义与角色

GoF 的定义：在不破坏封装的前提下，捕获一个对象的内部状态并保存在对象之外，以便之后把对象恢复到这个状态。

![备忘录模式：角色与撤销 / 重做栈](../assets/patterns/memento_structure.svg)

| 角色 | 职责 | 示例中的类 |
|------|------|-----------|
| Originator（原发器） | 生成快照、用快照恢复自己，是唯一能读快照内容的一方 | `TextEditor` |
| Memento（备忘录） | 不可变的状态快照 | `TextEditor.Snapshot` |
| Caretaker（负责人） | 保管快照（撤销栈、重做栈），但不读也不改快照内容 | `EditorHistory` |

「不破坏封装」是这个模式和「随手把字段拷一份」的区别：Caretaker 只拿到一个不透明的句柄，看不到也改不了里面的状态。

---

## 二、实现示例：带撤销 / 重做的编辑器

### 1、Originator 与不透明的 Memento

Java 里的做法是：对外只暴露一个空的标记接口，真正的快照用**私有嵌套 record** 实现，只有 `TextEditor` 自己能读：

```java
public final class TextEditor {

    /** 对外的快照句柄：没有任何方法，Caretaker 只能保管 */
    public interface Memento {}

    /** 真正的快照：私有，外部无法读取 content / cursor */
    private record Snapshot(String content, int cursor) implements Memento {}

    private final StringBuilder content = new StringBuilder();
    private int cursor;

    public void type(String text) {
        content.insert(cursor, text);
        cursor += text.length();
    }

    public void delete(int chars) {
        int from = Math.max(0, cursor - chars);
        content.delete(from, cursor);
        cursor = from;
    }

    public String text() { return content.toString(); }

    public Memento save() {
        return new Snapshot(content.toString(), cursor);   // String 不可变，直接存即可
    }

    public void restore(Memento memento) {
        if (!(memento instanceof Snapshot(String text, int pos))) {
            throw new IllegalArgumentException("不是本编辑器生成的快照");
        }
        content.setLength(0);
        content.append(text);
        cursor = pos;
    }
}
```

### 2、Caretaker：撤销栈与重做栈

两个规则决定撤销是否正确：

- **编辑前保存**：快照记录的是「这次编辑之前」的状态，撤销才能回到上一步
- **新编辑清空重做栈**：撤销之后又做了新编辑，之前被撤销的分支就作废了

```java
public final class EditorHistory {
    private final Deque<TextEditor.Memento> undoStack = new ArrayDeque<>();
    private final Deque<TextEditor.Memento> redoStack = new ArrayDeque<>();
    private final int limit;

    public EditorHistory(int limit) { this.limit = limit; }

    /** 每次编辑之前调用 */
    public void beforeEdit(TextEditor editor) {
        undoStack.push(editor.save());
        if (undoStack.size() > limit) {
            undoStack.removeLast();             // 超出上限，丢弃最旧的快照
        }
        redoStack.clear();                      // 新编辑让重做历史失效
    }

    public boolean undo(TextEditor editor) {
        if (undoStack.isEmpty()) return false;
        redoStack.push(editor.save());          // 当前状态留给 redo
        editor.restore(undoStack.pop());
        return true;
    }

    public boolean redo(TextEditor editor) {
        if (redoStack.isEmpty()) return false;
        undoStack.push(editor.save());          // 当前状态留给 undo
        editor.restore(redoStack.pop());
        return true;
    }
}

public class EditorDemo {
    public static void main(String[] args) {
        TextEditor editor = new TextEditor();
        EditorHistory history = new EditorHistory(50);

        history.beforeEdit(editor);
        editor.type("Hello");
        history.beforeEdit(editor);
        editor.type(", World");
        System.out.println(editor.text());   // Hello, World

        history.undo(editor);
        System.out.println(editor.text());   // Hello
        history.undo(editor);
        System.out.println(editor.text());   // （空字符串）

        history.redo(editor);
        System.out.println(editor.text());   // Hello
        history.redo(editor);
        System.out.println(editor.text());   // Hello, World
    }
}
```

`Deque` 本身就声明了 `removeLast()`，不需要强转成 `ArrayDeque`。

---

## 三、适用场景与坑

适合：

- 编辑器、绘图工具的撤销 / 重做
- 游戏存档、表单草稿、配置变更前的备份
- 一组操作失败后需要整体回到起点（先存快照，失败就恢复）

坑：

- **浅拷贝陷阱**：快照里如果放了可变对象（`List`、`Map`、可变实体），之后原对象修改它，快照也跟着变。保存时要拷贝（`List.copyOf`、深拷贝），或者只存不可变值
- **内存占用**：大对象频繁全量快照很费内存。设置历史上限；或只存变更的差异（增量快照）
- **封装泄漏**：用 public record 当快照，任何人都能读里面的字段，Caretaker 也可能依赖它。用上面的「私有 record + 标记接口」收住

---

## 四、快照式撤销 vs 命令式撤销

| 维度 | 快照式（备忘录） | 命令式（[命令模式](./14_behavioral_command)） |
|------|------|------|
| 记录什么 | 操作前的完整状态 | 操作本身，以及如何反向执行 |
| 撤销方式 | 直接恢复快照 | 调用命令的 `undo()` |
| 内存 | 状态大时占用高 | 只存操作，通常较小 |
| 实现难度 | 简单，不用写反向逻辑 | 每个命令都要写正确的逆操作 |
| 适合 | 状态小、操作种类多 | 状态大、操作可逆 |

两者也常组合：命令执行前让 Originator 存一份快照，`undo()` 时恢复它，省去为每个命令写逆操作。

数据库里的类似机制：InnoDB 用 undo log 记录修改前的版本来回滚事务；Spring 的 `Propagation.NESTED` 通过 JDBC `Connection.setSavepoint` 设置保存点，嵌套事务失败只回滚到保存点。普通 `@Transactional` 回滚靠的是数据库自身的 undo log，不使用保存点，见 [事务管理](/spring/4_transaction)。

---

## 小结

- 备忘录 = Originator 生成 / 恢复快照，Caretaker 只保管，快照内容只有 Originator 能读
- Java 里用私有嵌套 record 实现快照、对外暴露空接口，就能做到不破坏封装
- 撤销要在编辑前保存快照；重做需要第二个栈，任何新编辑都要清空它
- 快照里的可变对象要拷贝；状态大时考虑历史上限、增量快照或命令式撤销

## 参考资料

- Refactoring.Guru Memento：[https://refactoring.guru/design-patterns/memento](https://refactoring.guru/design-patterns/memento)
- Java SE 21 `Deque`：[https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/Deque.html](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/Deque.html)
- Spring Framework Transaction Propagation：[https://docs.spring.io/spring-framework/reference/data-access/transaction/declarative/tx-propagation.html](https://docs.spring.io/spring-framework/reference/data-access/transaction/declarative/tx-propagation.html)
- Gamma E. 等，《Design Patterns: Elements of Reusable Object-Oriented Software》，Addison-Wesley，1994

> 下一篇：[观察者模式](./18_behavioral_observer) —— 观察者与发布订阅、JDK Flow、PropertyChangeSupport、常见坑。
