# 备忘录模式

**作用**：在不暴露对象内部细节的前提下，**保存对象的某个状态快照**，以便之后恢复到该状态。

**应用场景**：
- 编辑器 Undo/Redo（文字、图形编辑器）
- 游戏存档/读档
- 事务回滚（数据库在 Commit 前保存 Undo Log）
- 表单草稿保存

---

## 一、实现示例

三个角色：`Originator`（原发器，被保存状态的对象）、`Memento`（备忘录，状态快照）、`Caretaker`（负责人，管理快照历史）。

```java
// 备忘录：只存状态，不暴露操作
public record TextEditorMemento(String content, int cursorPos) {}

// 原发器：文字编辑器
public class TextEditor {
    private StringBuilder content   = new StringBuilder();
    private int           cursorPos = 0;

    public void type(String text) {
        content.insert(cursorPos, text);
        cursorPos += text.length();
    }

    public void delete(int chars) {
        int from = Math.max(0, cursorPos - chars);
        content.delete(from, cursorPos);
        cursorPos = from;
    }

    public String getContent() { return content.toString(); }

    // 保存快照
    public TextEditorMemento save() {
        return new TextEditorMemento(content.toString(), cursorPos);
    }

    // 恢复快照
    public void restore(TextEditorMemento memento) {
        this.content   = new StringBuilder(memento.content());
        this.cursorPos = memento.cursorPos();
    }
}

// 负责人：管理历史快照
public class EditorHistory {
    private final Deque<TextEditorMemento> history = new ArrayDeque<>();
    private final int maxHistory;

    public EditorHistory(int maxHistory) { this.maxHistory = maxHistory; }

    public void save(TextEditor editor) {
        history.push(editor.save());
        if (history.size() > maxHistory) {
            // 移除最旧的快照
            ((ArrayDeque<TextEditorMemento>) history).removeLast();
        }
    }

    public void undo(TextEditor editor) {
        if (!history.isEmpty()) {
            editor.restore(history.pop());
        }
    }

    public int size() { return history.size(); }
}

// 使用
TextEditor  editor  = new TextEditor();
EditorHistory history = new EditorHistory(50);

editor.type("Hello");
history.save(editor);           // 保存快照 1

editor.type(", World");
history.save(editor);           // 保存快照 2

System.out.println(editor.getContent()); // Hello, World

history.undo(editor);
System.out.println(editor.getContent()); // Hello

history.undo(editor);
System.out.println(editor.getContent()); // （空）
```

---

## 二、注意事项

- 频繁保存大对象快照会消耗大量内存，可用**增量快照**（只保存变更 diff）优化
- `record` 天然不可变，适合作为 Memento 类型
- Spring `@Transactional` 的 Savepoint 本质是数据库层面的备忘录
