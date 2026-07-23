# 性能分析工具

## 一、JVM 内置命令行工具

### jps — 查看 Java 进程

```bash
jps -l       # 显示完整主类名
jps -v       # 显示 JVM 参数
```

### jstack — 线程堆栈

用于排查 **CPU 100%、死锁、线程阻塞**等问题。

```bash
# 打印线程堆栈到文件
jstack <pid> > thread_dump.txt

# 排查 CPU 100% 步骤：
# 1. 找到 Java 进程
jps -l
# 2. 找 CPU 最高的线程（Linux）
top -Hp <pid>
# 3. 将线程 ID 转为十六进制
printf "%x\n" <tid>
# 4. 在 jstack 输出中搜索该十六进制 ID（nid=0x...）
jstack <pid> | grep -A 30 "nid=0x<hex_tid>"
```

**线程状态说明**：

| 状态 | 说明 |
|------|------|
| `RUNNABLE` | 运行中或等待 CPU 调度 |
| `BLOCKED` | 等待进入 synchronized 块 |
| `WAITING` | 无限期等待（`Object.wait()`、`LockSupport.park()`）|
| `TIMED_WAITING` | 有超时的等待（`Thread.sleep()`、`LockSupport.parkNanos()`）|

---

### jmap — 堆内存分析

```bash
# 查看堆使用情况（快速）
jmap -heap <pid>

# 生成堆转储文件（用于 MAT 等工具分析内存泄漏）
jmap -dump:format=b,file=heap.hprof <pid>

# 统计堆中对象数量和大小（前 20 行）
jmap -histo <pid> | head -20
```

**OOM 时自动 dump**：
```bash
# JVM 启动参数：发生 OOM 时自动保存堆文件
-XX:+HeapDumpOnOutOfMemoryError
-XX:HeapDumpPath=/logs/heap_oom.hprof
```

---

### jstat — GC 统计

```bash
# 每 1000ms 输出一次 GC 统计，共 10 次
jstat -gcutil <pid> 1000 10

# 输出列含义：
# S0C/S1C: Survivor 0/1 容量
# EC: Eden 容量
# OC: Old 容量
# YGC: Young GC 次数    YGCT: Young GC 耗时
# FGC: Full GC 次数     FGCT: Full GC 耗时
# GCT: 总 GC 耗时
```

**判断 GC 是否异常**：
- Full GC 频繁（几分钟一次以上）→ 老年代内存不足或内存泄漏
- Young GC 时间过长 → Eden 区过小或大对象分配过多

---

## 二、Arthas

Arthas 是阿里巴巴开源的 Java 诊断工具，**无需重启应用**，支持在线诊断生产问题。

官网：[arthas.aliyun.com](https://arthas.aliyun.com/) | 源码：[github.com/alibaba/arthas](https://github.com/alibaba/arthas)

### 启动

```bash
# 下载并启动
curl -O https://arthas.aliyun.com/arthas-boot.jar
java -jar arthas-boot.jar          # 交互式选择目标进程

# 或直接指定 PID
java -jar arthas-boot.jar <pid>
```

### dashboard — 实时总览

```bash
dashboard    # 每 5s 刷新一次，展示线程、内存、GC 整体状态
```

输出包含：线程列表（CPU 使用率、状态）、JVM 内存区域使用情况、GC 次数和耗时。

---

### trace — 方法耗时追踪

找到方法调用链路中哪一步最慢：

```bash
# 追踪 OrderService.createOrder 方法内部各调用的耗时
trace com.example.OrderService createOrder

# 只追踪耗时超过 100ms 的调用
trace com.example.OrderService createOrder '#cost > 100'

# 追踪多级调用（展开嵌套调用）
trace -E com.example.OrderService|com.example.InventoryService 'createOrder|deductStock'
```

输出示例：
```
`---[85ms] com.example.OrderService.createOrder()
    +---[2ms]  validateOrder()
    +---[70ms] inventoryService.deductStock()    ← 瓶颈在这里
    `---[3ms]  orderRepo.save()
```

---

### watch — 观察方法入参/返回值

排查方法行为异常（参数错误、返回值异常）：

```bash
# 观察方法的入参和返回值（在方法返回时）
watch com.example.OrderService createOrder '{params, returnObj}'

# 观察异常信息
watch com.example.OrderService createOrder '{params, throwExp}' -e

# 观察条件满足时的数据
watch com.example.OrderService createOrder '{params[0], returnObj}' 'params[0].userId == 1001'

# 参数说明：
# params: 入参数组
# returnObj: 返回值
# throwExp: 异常对象
# target: 当前对象 (this)
```

---

### jad — 反编译

查看运行时实际加载的类（排查是否加载了预期版本）：

```bash
jad com.example.OrderService createOrder
```

---

### ognl — 执行表达式

直接在运行中的 JVM 中执行任意 Java 表达式：

```bash
# 查看 Spring Bean 的状态
ognl '@org.springframework.web.context.ContextLoader@getCurrentWebApplicationContext().getBean("orderService")'

# 修改静态变量（调试用）
ognl '@com.example.Config@MAX_RETRY = 5'
```

---

## 三、JProfiler（商业工具）

官网：[ej-technologies.com/jprofiler](https://www.ej-technologies.com/jprofiler)

JProfiler 提供图形界面，适合开发阶段深度分析：

| 功能 | 说明 |
|------|------|
| CPU Profiling | 方法级 CPU 时间采样，生成调用树 |
| 内存分析 | 对象分配堆栈、内存泄漏检测 |
| 线程分析 | 线程时间线、锁竞争热点 |
| JDBC 监控 | SQL 执行时间、慢查询 |

---

## 四、常用排查场景

| 问题 | 推荐工具 | 关键命令 |
|------|---------|---------|
| CPU 100% | jstack + top | `top -Hp <pid>` → `jstack` 找热点线程 |
| 内存泄漏 / OOM | jmap + MAT | `jmap -dump` → 用 Eclipse MAT 分析 |
| GC 频繁 | jstat | `jstat -gcutil <pid> 1000` |
| 接口响应慢 | Arthas trace | `trace <class> <method> '#cost > 100'` |
| 方法行为异常 | Arthas watch | `watch <class> <method> '{params, returnObj}'` |
| 死锁 | jstack | `jstack <pid>` 搜索 `deadlock` 关键字 |
