# 模板方法模式

**作用**：在父类中定义算法的**骨架（步骤顺序）**，将某些步骤的具体实现延迟到子类，子类在不改变算法结构的前提下重定义特定步骤。

**应用场景**：
- Spring `JdbcTemplate`：固定了获取连接→执行→处理结果→关闭连接的流程，业务只需实现 SQL 和结果映射
- `AbstractApplicationContext.refresh()`：Spring 容器启动流程骨架
- Spring Security `AbstractAuthenticationProcessingFilter`
- 各种 `AbstractXxxProcessor` 基类

---

## 一、实现示例

以「数据导入」为例，流程固定（读取→校验→转换→持久化），格式（CSV/JSON）不同：

```java
// 抽象模板
public abstract class DataImporter<T> {

    // 模板方法：固定流程，final 防止子类改变顺序
    public final ImportResult importData(InputStream input) {
        log.info("Starting import...");

        List<String> rawLines = readLines(input);   // 步骤1：读取原始数据

        List<T> records = parse(rawLines);           // 步骤2：解析

        List<String> errors = validate(records);     // 步骤3：校验
        if (!errors.isEmpty()) {
            return ImportResult.failed(errors);
        }

        int saved = persist(records);                // 步骤4：持久化

        afterImport(saved);                          // 步骤5：钩子（可选覆盖）

        log.info("Imported {} records", saved);
        return ImportResult.success(saved);
    }

    // 子类必须实现
    protected abstract List<T> parse(List<String> lines);
    protected abstract int persist(List<T> records);

    // 子类可覆盖（默认实现）
    protected List<String> readLines(InputStream input) {
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(input))) {
            return reader.lines().toList();
        } catch (IOException e) {
            throw new RuntimeException(e);
        }
    }

    protected List<String> validate(List<T> records) {
        return Collections.emptyList();  // 默认不校验，子类按需覆盖
    }

    // 钩子方法（Hook）：默认空实现，子类可选择性覆盖
    protected void afterImport(int count) {}
}

// CSV 实现
public class CsvUserImporter extends DataImporter<UserDTO> {

    @Override
    protected List<UserDTO> parse(List<String> lines) {
        return lines.stream()
            .skip(1)  // 跳过表头
            .map(line -> {
                String[] parts = line.split(",");
                return new UserDTO(parts[0], parts[1], parts[2]);
            })
            .toList();
    }

    @Override
    protected List<String> validate(List<UserDTO> records) {
        return records.stream()
            .filter(u -> u.getEmail() == null || !u.getEmail().contains("@"))
            .map(u -> "Invalid email: " + u.getEmail())
            .toList();
    }

    @Override
    protected int persist(List<UserDTO> records) {
        return userRepository.batchInsert(records);
    }

    @Override
    protected void afterImport(int count) {
        cacheService.evict("user-list");  // 导入后清除缓存
    }
}

// JSON 实现
public class JsonUserImporter extends DataImporter<UserDTO> {
    private final ObjectMapper mapper;

    @Override
    protected List<UserDTO> parse(List<String> lines) {
        String json = String.join("", lines);
        return mapper.readValue(json, new TypeReference<List<UserDTO>>() {});
    }

    @Override
    protected int persist(List<UserDTO> records) {
        return userRepository.batchInsert(records);
    }
}
```

---

## 二、钩子方法（Hook）

钩子是父类中提供**默认空实现**的方法，子类可覆盖以介入算法的特定点，但不是必须的：

```java
// 在模板方法中调用钩子
protected void beforePersist(List<T> records) {}   // 子类可覆盖：持久化前脱敏
protected void afterImport(int count) {}            // 子类可覆盖：清缓存/发通知
```

---

## 三、与策略模式的区别

| 维度 | 模板方法 | 策略 |
|------|---------|------|
| 复用机制 | 继承 | 组合 |
| 变化粒度 | 步骤实现 | 整个算法 |
| 适用 | 流程固定，步骤可变 | 算法整体可互换 |
