# Java 专项-异常体系

## 一、异常层次结构

```
Throwable
├── Error（严重错误，不应捕获）
│   ├── OutOfMemoryError
│   ├── StackOverflowError
│   └── VirtualMachineError
└── Exception
    ├── RuntimeException（非检查异常，Unchecked）
    │   ├── NullPointerException
    │   ├── IllegalArgumentException
    │   ├── IllegalStateException
    │   ├── IndexOutOfBoundsException
    │   ├── ClassCastException
    │   └── ArithmeticException
    └── 检查异常（Checked，必须处理）
        ├── IOException
        ├── SQLException
        └── InterruptedException
```

### Checked vs Unchecked

| | Checked | Unchecked（RuntimeException） |
|--|---------|-------------------------------|
| 编译要求 | 必须 try-catch 或 throws 声明 | 无要求 |
| 典型场景 | IO、网络、数据库等外部操作 | 编程错误（空指针、越界等） |
| 争议 | 强制处理提高健壮性 vs 代码臃肿 | 现代框架（Spring）倾向封装为 Unchecked |

---

## 二、最佳实践

### 只捕获你能处理的

```java
// 不推荐：吞掉异常，问题无法定位
try {
    doSomething();
} catch (Exception e) {
    // 什么都不做
}

// 推荐：处理 + 记录
try {
    doSomething();
} catch (SpecificException e) {
    log.error("处理 xxx 失败，原因：{}", e.getMessage(), e);
    throw new BusinessException("操作失败", e); // 包装后重新抛出
}
```

### 不要用异常控制流程

```java
// 不推荐：性能差，语义不清
try {
    return list.get(index);
} catch (IndexOutOfBoundsException e) {
    return null;
}

// 推荐
if (index >= 0 && index < list.size()) {
    return list.get(index);
}
return null;
```

### finally 的陷阱

```java
// finally 中 return 会覆盖 try/catch 中的 return，且会吞掉异常
try {
    return 1;
} finally {
    return 2; // 实际返回 2，原异常也会被吞！不要在 finally 中 return
}
```

### try-with-resources（Java 7+）

```java
// 自动关闭实现了 AutoCloseable 的资源，即使抛出异常
try (Connection conn = dataSource.getConnection();
     PreparedStatement ps = conn.prepareStatement(sql)) {
    // 使用资源
} // 自动调用 close()，顺序与声明相反
```

若 `try` 块和 `close()` 都抛出异常，`close()` 的异常被抑制（Suppressed），可通过 `e.getSuppressed()` 获取。

---

## 三、自定义异常

```java
// 业务异常基类（继承 RuntimeException，不强制调用方处理）
public class BusinessException extends RuntimeException {
    private final String code;

    public BusinessException(String code, String message) {
        super(message);
        this.code = code;
    }

    public BusinessException(String code, String message, Throwable cause) {
        super(message, cause); // 保留原始异常，不丢失堆栈
        this.code = code;
    }

    public String getCode() { return code; }
}

// 具体业务异常
public class OrderNotFoundException extends BusinessException {
    public OrderNotFoundException(Long orderId) {
        super("ORDER_NOT_FOUND", "订单不存在: " + orderId);
    }
}
```

### 异常设计原则

- 业务异常继承 `RuntimeException`，不强迫调用方处理
- 保留原始异常（`cause`），不丢失堆栈信息
- 携带业务错误码，方便 API 返回和日志定位
- 不在构造方法中打日志，由最终捕获层统一记录

---

## 四、Spring 中的异常处理

### @ExceptionHandler + @RestControllerAdvice

```java
@RestControllerAdvice
public class GlobalExceptionHandler {

    @ExceptionHandler(BusinessException.class)
    public Result<Void> handleBusiness(BusinessException e) {
        log.warn("业务异常: code={}, msg={}", e.getCode(), e.getMessage());
        return Result.fail(e.getCode(), e.getMessage());
    }

    @ExceptionHandler(MethodArgumentNotValidException.class)
    public Result<Void> handleValidation(MethodArgumentNotValidException e) {
        String msg = e.getBindingResult().getFieldErrors().stream()
            .map(fe -> fe.getField() + ": " + fe.getDefaultMessage())
            .collect(Collectors.joining(", "));
        return Result.fail("PARAM_INVALID", msg);
    }

    @ExceptionHandler(Exception.class)
    public Result<Void> handleUnknown(Exception e) {
        log.error("未知异常", e);
        return Result.fail("SYSTEM_ERROR", "系统繁忙，请稍后重试");
    }
}
```

---

## 五、常见面试问题

**Q：Error 和 Exception 的区别？**
Error 表示 JVM 级别的严重错误（内存溢出、栈溢出），通常不可恢复，不应捕获；Exception 是程序可以处理的异常。

**Q：finally 块一定会执行吗？**
基本是，但例外：`System.exit()` 调用、JVM 崩溃、死循环（未到达 finally）。

**Q：catch 子句顺序有何要求？**
子类异常必须在父类前面，否则编译错误（父类会把子类的 catch 覆盖，子类 catch 永远不可达）。

**Q：异常对性能有多大影响？**
创建异常对象时填充堆栈（`fillInStackTrace`）是主要开销，与调用深度成正比。高频热路径不应用异常控制流程；若必须，可覆写 `fillInStackTrace()` 返回 `this` 来禁用堆栈填充。
