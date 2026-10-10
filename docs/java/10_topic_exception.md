---
description: 异常层次、受检与非受检、try-with-resources、中断与异步异常、自定义异常、性能
---

# 异常体系

> 前置阅读：[版本演进](./2_version)

本篇讲异常类层次与受检 / 非受检的判定规则、异常处理与资源关闭的写法，以及中断、线程池与异步任务中的异常处理，以 JDK 21 / 25 为基线，与 JDK 8 / 17 不同之处单独标注。

---

## 一、异常层次结构

![Java 异常类层次](../assets/java/exception-hierarchy.svg)

### 1、受检与非受检按类型判定

「受检异常」不是某个具体的类，而是一条编译期规则（JLS §11.1.1）：

- **非受检异常**：`RuntimeException` 及其子类，加上 `Error` 及其子类
- **受检异常**：其余所有 `Throwable` 子类，实际就是 `Exception` 中不属于 `RuntimeException` 的那部分，例如 `IOException`、`SQLException`、`InterruptedException`

受检异常必须被 `catch` 或在方法签名中 `throws` 声明，否则编译失败；非受检异常不受此约束。这条规则只在 javac 层面生效，字节码层面并不区分。

### 2、Error：不要捕获后继续运行

`Error` 表示 JVM 或运行环境层面的严重问题，如 `OutOfMemoryError`、`StackOverflowError`（二者都是 `VirtualMachineError` 的子类）、类加载阶段的 `NoClassDefFoundError`（`LinkageError` 的子类）。

- 业务代码不应捕获 `Error` 后当作正常情况继续处理：发生 OOM 后堆中对象可能处于半更新状态，继续服务只会产生更隐蔽的错误
- 框架边界（线程池工作线程、请求入口）可以捕获 `Throwable` 用于记录日志，但记录后应让进程按既定策略退出或由健康检查摘除
- OOM 的应对是 `-XX:+HeapDumpOnOutOfMemoryError` 留现场，必要时配合 `-XX:+ExitOnOutOfMemoryError` 让容器重启，排查见 [故障排查](/jvm/9_troubleshooting)

### 3、受检异常的取舍

| | 受检异常 | 非受检异常 |
|--|---------|-----------|
| 编译要求 | 必须 catch 或 throws | 无要求 |
| 适用场景 | 调用方**有能力且应当**恢复的外部失败，如文件不存在、网络超时 | 编程错误（参数非法、状态非法）和调用方无法恢复的失败 |
| 主要问题 | 层层 throws 污染签名；与 Lambda、Stream 等函数式接口不兼容 | 调用方容易忽略 |

函数式接口（`Function`、`Supplier` 等）的方法不声明受检异常，所以 Lambda 里调用抛 `IOException` 的方法只能在内部捕获并包装。JDK 8 为此引入了 `UncheckedIOException`，`Files.lines()` 返回的 Stream 在读取失败时就抛它：

```java
List<String> lines = paths.stream()
    .map(p -> {
        try {
            return Files.readString(p);
        } catch (IOException e) {
            throw new UncheckedIOException(e);   // 保留 cause，不丢堆栈
        }
    })
    .toList();
```

Spring 等主流框架的做法是把底层受检异常统一转换为非受检异常（如 `DataAccessException`），业务代码只处理能处理的那部分。

---

## 二、捕获与抛出

### 1、只捕获能处理的，并且只记录一次

```java
// 不推荐：吞掉异常，问题无法定位
try {
    doSomething();
} catch (Exception e) {
    // 什么都不做
}

// 不推荐：记录后又抛出，同一个异常会在上层再被记录一次
try {
    doSomething();
} catch (IOException e) {
    log.error("处理失败", e);
    throw new BusinessException("SYS_IO", "操作失败", e);
}

// 推荐 A：无法处理，包装后抛出，由最终捕获层统一记录
try {
    doSomething();
} catch (IOException e) {
    throw new BusinessException("SYS_IO", "读取配置失败", e);
}

// 推荐 B：能够处理（降级、重试、返回默认值），就在这里记录并结束
try {
    return remoteClient.query(id);
} catch (TimeoutException e) {
    log.warn("查询超时，返回缓存值 id={}", id, e);
    return cache.get(id);
}
```

原则：**要么处理并记录，要么包装后抛出，不要两件事都做**。包装时一定要把原异常作为 `cause` 传入。

### 2、多重捕获与精确重抛（Java 7+）

```java
// 多重捕获：多个不相关的异常共用一段处理逻辑，e 隐式为 final
try {
    parseAndSave(input);
} catch (JsonProcessingException | SQLException e) {
    throw new BusinessException("IMPORT_FAILED", "导入失败", e);
}

// 精确重抛：catch (Exception e) 后原样 throw e，编译器按 try 块实际可能抛出的类型推断
void load() throws IOException {         // 不需要声明 throws Exception
    try {
        readFile();                       // 只抛 IOException
    } catch (Exception e) {
        cleanup();
        throw e;                          // e 未被重新赋值，编译器知道它只能是 IOException 或非受检异常
    }
}
```

catch 子句按顺序匹配，子类必须写在父类前面，否则子类分支不可达，编译报错；多重捕获中的类型之间也不能有父子关系。

### 3、不要用异常控制流程

```java
// 不推荐：用异常判断边界，既慢又掩盖真实错误
try {
    return list.get(index);
} catch (IndexOutOfBoundsException e) {
    return null;
}

// 推荐：先判断
return (index >= 0 && index < list.size()) ? list.get(index) : null;
```

### 4、InterruptedException：恢复中断或向上传播

`InterruptedException` 意味着有人请求当前线程停止。捕获后清空中断标志却什么都不做，会让线程池关闭、任务取消失效。

```java
// 方式一：能声明就直接向上传播
public Order take() throws InterruptedException {
    return queue.take();
}

// 方式二：签名不允许抛出时，恢复中断标志，让上层感知
public void run() {
    try {
        while (!Thread.currentThread().isInterrupted()) {
            process(queue.take());
        }
    } catch (InterruptedException e) {
        Thread.currentThread().interrupt();   // 抛出 InterruptedException 时标志已被清除，必须恢复
    }
}
```

中断机制本身见 [线程基础](./23_topic_thread_basics)。

### 5、Helpful NullPointerException（JDK 14+）

JEP 358 让 NPE 消息指出具体是哪个表达式为 null，JDK 15 起默认开启：

```text
Exception in thread "main" java.lang.NullPointerException:
  Cannot invoke "String.length()" because the return value of "User.getName()" is null
```

JDK 8 只有一个空的 `NullPointerException`，链式调用 `a.getB().getC().getD()` 无法判断是哪一环为 null。升级 JDK 后不必再把链式调用拆成多行来定位 NPE。

---

## 三、finally 与 try-with-resources

### 1、finally 的执行与例外

`try` 正常结束、`return`、`break`、`continue` 或抛出异常时，`finally` 都会执行。不执行的情况只有「控制流根本没离开 `try`」或「JVM 不再执行 Java 代码」：

- 调用了 `System.exit()` 或 `Runtime.halt()`
- 进程被 `kill -9`、断电，或 JVM 崩溃
- JVM 退出时仍在运行的守护线程被直接终止
- `try` 中死循环或永久阻塞（finally 并没有被跳过，只是永远到达不了）

### 2、不要在 finally 中 return 或抛异常

```java
int f() {
    try {
        throw new IllegalStateException("真正的错误");
    } finally {
        return 2;   // 返回 2，IllegalStateException 被丢弃，调用方毫无感知
    }
}
```

`finally` 中的 `return` 会覆盖 `try` / `catch` 的返回值并丢弃正在传播的异常；`finally` 中抛出新异常同样会丢弃原异常。`finally` 只做清理，清理逻辑本身可能失败时用 try-with-resources。

### 3、try-with-resources（Java 7+）

```java
// 自动关闭实现了 AutoCloseable 的资源，关闭顺序与声明顺序相反
try (Connection conn = dataSource.getConnection();
     PreparedStatement ps = conn.prepareStatement(sql)) {
    ps.executeUpdate();
}

// Java 9+：effectively final 的已有变量可以直接放进 try
Connection conn = dataSource.getConnection();
try (conn) {
    // ...
}
```

如果 `try` 块抛出异常，随后 `close()` 也抛出异常，`close()` 的异常会通过 `Throwable.addSuppressed()` 附加到主异常上，主异常不会被覆盖；用 `e.getSuppressed()` 可以取出。手写 `finally { close(); }` 时，`close()` 的异常会覆盖主异常，这正是 try-with-resources 要解决的问题。

---

## 四、线程池与异步中的异常

异常沿着调用栈传播，一旦任务交给另一个线程执行，调用方的 `try-catch` 就接不住了。

| 场景 | 异常去向 | 处理方式 |
|------|---------|---------|
| `executor.execute(task)` | 交给工作线程的 `UncaughtExceptionHandler`，默认打印到 stderr，该工作线程退出后被替换 | `ThreadFactory` 中设置 `UncaughtExceptionHandler`，或任务内自行 try-catch |
| `executor.submit(task)` | 保存在 `Future` 中，不调用 `get()` 就无声无息 | `get()` 时处理 `ExecutionException`，用 `getCause()` 取原异常 |
| `CompletableFuture` | `join()` 抛 `CompletionException`，`get()` 抛 `ExecutionException`，原异常都在 `getCause()` | `exceptionally` / `handle` 中先剥掉包装层再判断类型 |
| 虚拟线程（JDK 21+） | 与平台线程一致：`Thread` 走 `UncaughtExceptionHandler`，executor 任务走 `Future` | 同上 |

```java
try {
    return future.get(2, TimeUnit.SECONDS);
} catch (ExecutionException e) {
    Throwable cause = e.getCause();              // 真正的业务异常在这里
    if (cause instanceof BusinessException be) {
        throw be;
    }
    throw new IllegalStateException("下游调用失败", cause);
} catch (InterruptedException e) {
    Thread.currentThread().interrupt();
    throw new IllegalStateException("等待被中断", e);
} catch (TimeoutException e) {
    future.cancel(true);
    throw new BusinessException("DOWNSTREAM_TIMEOUT", "下游超时", e);
}
```

线程池异常处理的四种方式见 [线程池](./28_topic_thread_pool)，`CompletableFuture` 的异常传播规则见 [CompletableFuture](./29_topic_completable_future)。

---

## 五、自定义异常

```java
// 业务异常基类：继承 RuntimeException，不强制调用方处理
public class BusinessException extends RuntimeException {
    private final String code;

    public BusinessException(String code, String message) {
        super(message);
        this.code = code;
    }

    public BusinessException(String code, String message, Throwable cause) {
        super(message, cause);              // 保留原始异常，不丢失堆栈
        this.code = code;
    }

    public String getCode() { return code; }
}

public class OrderNotFoundException extends BusinessException {
    public OrderNotFoundException(long orderId) {
        super("ORDER_NOT_FOUND", "订单不存在: " + orderId);
    }
}
```

设计原则：

- 业务异常继承 `RuntimeException`。Spring `@Transactional` 默认只在 `RuntimeException` 和 `Error` 时回滚，受检异常会照常提交，除非配置 `rollbackFor`，详见 [事务管理](/spring/4_transaction)
- 包装时保留原始异常（`cause`），不丢失根因堆栈
- 携带业务错误码，方便接口返回与日志检索；异常消息中带上关键业务 ID
- 不在构造方法中打日志，由最终捕获层统一记录
- 异常层次保持扁平：一个业务异常基类加少量按处理方式区分的子类（如「客户端错误」与「可重试错误」），而不是每个场景一个类

Web 层把异常统一转换为接口响应的做法（`@RestControllerAdvice`、`ProblemDetail`）见 [MVC](/spring/3_mvc)。

---

## 六、异常的性能开销

创建异常对象时，`Throwable` 构造器会调用 `fillInStackTrace()` 遍历当前调用栈，开销与栈深度成正比；`throw` / `catch` 本身相对便宜。因此：

- 正常业务分支不要用异常表达，例如「库存不足」若是高频且预期内的结果，用返回值或结果对象更合适
- 确实需要高频抛出、又不需要堆栈的业务异常，可以用 JDK 7 起的受保护构造器关闭堆栈采集，比覆写 `fillInStackTrace()` 更清晰：

```java
public class FastFailException extends RuntimeException {
    public FastFailException(String message) {
        // enableSuppression=false, writableStackTrace=false
        super(message, null, false, false);
    }
}
```

- HotSpot 默认开启 `-XX:+OmitStackTraceInFastThrow`：同一位置的 NPE、`ArithmeticException`、`ArrayIndexOutOfBoundsException` 等隐式异常被 JIT 编译后频繁抛出时，会改为抛出预分配的、没有堆栈和消息的实例。线上日志里只看到 `java.lang.NullPointerException` 却没有堆栈时，往前翻找第一次出现的完整堆栈，或临时加 `-XX:-OmitStackTraceInFastThrow` 复现

---

## 小结

- 受检 / 非受检按类型判定：`RuntimeException` 与 `Error` 及其子类为非受检，其余为受检；`Error` 不应捕获后继续运行
- 要么处理并记录，要么包装（带 cause）后抛出，不要既记录又抛出；finally 中不 return、不抛异常
- 资源一律用 try-with-resources，`close()` 的异常作为 suppressed 附加，不覆盖主异常
- `InterruptedException` 要么向上传播，要么 `Thread.currentThread().interrupt()` 恢复中断
- 跨线程异常不会自动回到调用方：`submit` 的异常在 `Future` 里，`CompletableFuture` 的异常被 `CompletionException` 包装
- 业务异常继承 `RuntimeException`，`@Transactional` 默认只对它和 `Error` 回滚
- 堆栈采集是主要开销；高频无堆栈异常用四参构造器关闭 `writableStackTrace`，注意 `OmitStackTraceInFastThrow` 导致的堆栈丢失

## 参考资料

- JLS §11 Exceptions：[https://docs.oracle.com/javase/specs/jls/se21/html/jls-11.html](https://docs.oracle.com/javase/specs/jls/se21/html/jls-11.html)
- Java Tutorials - Exceptions：[https://docs.oracle.com/javase/tutorial/essential/exceptions/](https://docs.oracle.com/javase/tutorial/essential/exceptions/)
- JEP 358 Helpful NullPointerExceptions：[https://openjdk.org/jeps/358](https://openjdk.org/jeps/358)

> 下一篇：[String](./11_topic_string) —— 最常用的类：不可变的实现、Compact Strings、拼接的编译方式与常用 API。
