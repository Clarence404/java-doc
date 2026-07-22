# 工厂模式

**作用**：通过工厂创建对象，解耦实例化过程，便于扩展。

**应用场景**：

- Spring BeanFactory / ApplicationContext（Spring IOC 容器）
- JDBC DriverManager.getConnection()
- 日志框架（Logback/SLF4J）

当然，这里给你举两个实际代码示例，分别展示**简单工厂模式**与**工厂方法模式**的应用：

---

## 一、简单工厂模式（Simple Factory）

> 比如你有不同的图形类，希望通过工厂来创建它们，而不用每次都 `new`。

```java
// 产品接口
public interface Shape {
    void draw();
}

// 具体产品
public class Circle implements Shape {
    public void draw() {
        System.out.println("Drawing Circle");
    }
}

public class Rectangle implements Shape {
    public void draw() {
        System.out.println("Drawing Rectangle");
    }
}

// 工厂类
public class ShapeFactory {
    public static Shape createShape(String type) {
        switch (type) {
            case "circle":
                return new Circle();
            case "rectangle":
                return new Rectangle();
            default:
                throw new IllegalArgumentException("Unknown shape type");
        }
    }
}

// 使用示例
public class Main {
    public static void main(String[] args) {
        Shape shape = ShapeFactory.createShape("circle");
        shape.draw(); // 输出：Drawing Circle
    }
}
```

---

## 二、工厂方法模式（Factory Method）

> 比如日志系统，日志类型不同，用不同工厂生产不同的日志记录器。

```java
// 日志产品
public interface Logger {
    void log(String message);
}

// 具体日志类
public class FileLogger implements Logger {
    public void log(String message) {
        System.out.println("Log to file: " + message);
    }
}

public class ConsoleLogger implements Logger {
    public void log(String message) {
        System.out.println("Log to console: " + message);
    }
}

// 抽象工厂
public interface LoggerFactory {
    Logger createLogger();
}

// 具体工厂
public class FileLoggerFactory implements LoggerFactory {
    public Logger createLogger() {
        return new FileLogger();
    }
}

public class ConsoleLoggerFactory implements LoggerFactory {
    public Logger createLogger() {
        return new ConsoleLogger();
    }
}

// 使用示例
public class Main {
    public static void main(String[] args) {
        // 可切换为 FileLoggerFactory
        LoggerFactory factory = new ConsoleLoggerFactory();
        Logger logger = factory.createLogger();
        // 输出：Log to console: Hello Factory!
        logger.log("Hello Factory!");
    }
}
```

---

这两个例子分别展示了：

| 模式类型   | 特点                |
|--------|-------------------|
| 简单工厂模式 | 一个类集中负责所有对象的创建    |
| 工厂方法模式 | 每种产品由不同的工厂创建，便于扩展 |
