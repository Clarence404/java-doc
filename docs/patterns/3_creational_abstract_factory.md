# 抽象工厂模式

**作用**：提供一个创建**一族相关对象**的接口，保证同族对象风格一致，无需指定具体类。

**与工厂方法的区别**：工厂方法生产**单一产品**；抽象工厂生产**一组相关产品**（产品族）。

**应用场景**：
- JDBC 多数据库支持（MySQL/PostgreSQL 的 Connection + Statement 由同一工厂创建）
- UI 组件主题（Light/Dark 主题的 Button + TextField 保持风格一致）
- 单元测试中用 MockFactory 替换 RealFactory

---

## 一、实现示例

以「跨数据库工厂」为例：

```java
// 抽象产品
public interface DBConnection {
    void connect(String url);
}
public interface DBStatement {
    void execute(String sql);
}

// 抽象工厂
public interface DatabaseFactory {
    DBConnection createConnection();
    DBStatement  createStatement();
}

// MySQL 产品族
public class MySQLFactory implements DatabaseFactory {
    public DBConnection createConnection() { return url -> System.out.println("MySQL: " + url); }
    public DBStatement  createStatement()  { return sql -> System.out.println("MySQL: " + sql); }
}

// PostgreSQL 产品族
public class PGFactory implements DatabaseFactory {
    public DBConnection createConnection() { return url -> System.out.println("PG: " + url); }
    public DBStatement  createStatement()  { return sql -> System.out.println("PG: " + sql); }
}

// 客户端只依赖抽象，切换数据库只需换工厂
public class DataAccessLayer {
    private final DatabaseFactory factory;

    public DataAccessLayer(DatabaseFactory factory) { this.factory = factory; }

    public void query(String url, String sql) {
        factory.createConnection().connect(url);
        factory.createStatement().execute(sql);
    }
}

// 配置注入（Spring 场景）
@Bean
public DatabaseFactory databaseFactory(@Value("${db.type}") String type) {
    return "mysql".equals(type) ? new MySQLFactory() : new PGFactory();
}
```

---

## 二、优缺点

| 维度 | 说明 |
|------|------|
| 优点 | 保证产品族一致性；客户端与具体类解耦；整体切换产品族只改工厂 |
| 缺点 | 扩展新**产品类型**（如新增 `DBResultSet`）需修改所有工厂接口，违反开闭原则 |
