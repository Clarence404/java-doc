# 线上诊断

> JVM 监控工具详见 [jvm/7_monitoring_tools](../jvm/7_monitoring_tools)，GC 调优详见 [jvm/7_troubleshooting](../jvm/7_troubleshooting)。

---

## 一、Arthas

阿里开源的 Java 诊断工具，**无需重启、无需修改代码**，生产可用。

### 快速启动

```bash
curl -O https://arthas.aliyun.com/arthas-boot.jar
java -jar arthas-boot.jar           # 列出 JVM 进程，输入序号附着
java -jar arthas-boot.jar <pid>     # 直接指定 PID
```

### watch — 观察方法入参 / 返回值 / 异常

```bash
# 观察入参和返回值，展开 3 层
watch com.example.OrderService createOrder "{params, returnObj}" -x 3

# 只在抛异常时打印
watch com.example.OrderService createOrder "{params, throwExp}" -e

# 条件过滤（只看 userId=1001 的请求）
watch com.example.OrderService createOrder "{params, returnObj}" \
  'params[0].userId == "1001"' -x 3 -n 10
# -n 10：只执行 10 次后退出
```

### trace — 方法调用链耗时分析

```bash
# 追踪 createOrder 内所有子调用耗时
trace com.example.OrderService createOrder

# 只显示耗时 > 100ms 的调用
trace com.example.OrderService createOrder '#cost > 100'

# 追踪 Spring MVC 入口定位慢接口
trace org.springframework.web.servlet.DispatcherServlet doDispatch '#cost > 500'
```

### tt — 时间隧道（记录调用，事后回放）

```bash
tt -t com.example.OrderService createOrder -n 100   # 记录最近 100 次
tt -l                                                # 列出已记录的调用
tt -i 1003 -w '{params, returnObj}'                 # 查看第 1003 次详情
tt -p -i 1003                                       # 重新执行该次调用
```

### ognl — 动态执行表达式

```bash
# 调用静态方法
ognl "@com.example.utils.DateUtils@format(new java.util.Date())"

# 从 Spring 容器取 Bean 并调用（不重启修改运行时状态）
ognl '#ctx=@org.springframework.web.context.ContextLoader@getCurrentWebApplicationContext(),
      #ctx.getBean("orderService").getOrderById("1001")'

# 修改静态开关（紧急临时关闭功能）
ognl '@com.example.config.FeatureFlag@NEW_PAYMENT_ENABLED = false'
```

### 其他常用命令

```bash
stack java.lang.System exit          # 查看谁调用了 System.exit
jad com.example.OrderService         # 反编译验证线上代码版本
redefine /tmp/OrderService.class     # 热更新 class（只能改方法体）
thread -b                            # 找出阻塞其他线程最多的线程
dashboard                            # 实时展示系统信息（CPU/内存/线程）
```

---

## 二、线程分析

### jstack 线程快照

```bash
# 导出线程快照
jstack -l <pid> > /tmp/thread_dump.txt

# 定位高 CPU 线程：找到线程 TID → 转十六进制 → 在 dump 中搜索 nid=0x...
top -p <pid> -H                 # 找高 CPU 线程的十进制 TID
printf '%x\n' <tid>             # 转十六进制
grep "nid=0x1a2b" thread_dump.txt -A 20
```

**线程状态速查**：

| 状态 | 含义 | 排查方向 |
|------|------|---------|
| `RUNNABLE` | 执行中或等待 CPU | CPU 高时看具体栈帧 |
| `WAITING` | 等待唤醒（Object.wait） | 是否锁竞争 |
| `TIMED_WAITING` | 有超时的等待（sleep） | 一般正常 |
| `BLOCKED` | 等待 synchronized 锁 | 死锁 / 锁竞争热点 |

### 死锁检测

```bash
jstack -l <pid> | grep -A 20 "deadlock"
# Arthas
thread -b    # 找出阻塞其他线程最多的线程
```

---

## 三、内存分析

### jmap 堆转储

```bash
# 导出完整堆快照（会触发 STW，生产谨慎）
jmap -dump:format=b,file=/tmp/heap.hprof <pid>

# 只导出存活对象（文件更小）
jmap -dump:live,format=b,file=/tmp/heap_live.hprof <pid>

# 快速查看堆内对象分布（不停机）
jmap -histo:live <pid> | head -30
```

### MAT 分析 OOM

```
分析步骤：
  1. File → Open Heap Dump → 选 .hprof 文件
  2. 选 "Leak Suspects Report" 自动识别内存泄漏嫌疑对象
  3. Dominator Tree → 找持有内存最多的对象
  4. 右键大对象 → List Objects → with outgoing references → 看引用链
  5. Path to GC Roots → exclude weak references → 找 GC 无法回收的原因
```

### OOM 类型与排查

```
java.lang.OutOfMemoryError: Java heap space
  → 堆内存不足，jmap -histo 看哪类实例数量异常，MAT 分析引用链

java.lang.OutOfMemoryError: Metaspace
  → 类太多（大量动态代理/CGLib），检查 ClassLoader 是否有泄漏

java.lang.OutOfMemoryError: Direct buffer memory
  → 堆外内存不足（Netty/NIO），检查 ByteBuf 是否释放

java.lang.OutOfMemoryError: unable to create new native thread
  → 线程数超 OS 限制（ulimit -u），排查线程池是否无界增长
```

```bash
# 生产必配：OOM 时自动转储
# JVM 启动参数加入：
-XX:+HeapDumpOnOutOfMemoryError
-XX:HeapDumpPath=/var/log/app/heap.hprof
```

---

## 四、GC 分析

### 开启 GC 日志（JDK 11+）

```bash
# JVM 启动参数
-Xlog:gc*:file=/var/log/app/gc.log:time,uptime,level,tags:filecount=5,filesize=20m
```

### 关键指标

```
关注点：
  Pause 时间：Young GC < 200ms，Full GC < 1s 为健康状态
  触发频率：Young GC 过频 → Eden 太小或对象分配速率过高
  Allocation Failure：Eden 分配失败 → 内存压力大，考虑增大堆
  Evacuation Failure：Old 区不足 → 需增大堆或调优对象晋升策略
```

### 可视化工具

| 工具 | 特点 |
|------|------|
| **GCEasy** (gceasy.io) | 在线上传 GC 日志，自动生成分析报告，免费版足够 |
| **GCViewer** | 开源桌面工具，可视化 GC 活动时间线 |
| **JDK Mission Control** | JDK 自带，结合 JFR 深度分析，开销 < 2% |

```bash
# JFR 录制（生产可用）
jcmd <pid> JFR.start duration=60s filename=/tmp/app.jfr
# 用 JDK Mission Control 打开 .jfr 分析
```
