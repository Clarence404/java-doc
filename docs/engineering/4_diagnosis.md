---
description: Arthas 附着与容器排障、按症状选命令、watch / trace / tt、类加载器、热修复、生产安全
---

# 线上诊断

> 前置阅读：[诊断工具](/jvm/8_monitoring_tools)、[故障排查](/jvm/9_troubleshooting)

Arthas 能在不重启、不改代码的前提下，在方法级别观察和干预线上 JVM。本篇讲它在物理机、容器与 Kubernetes 中的附着、按症状选命令、fat jar 上的类加载器用法、可回滚的热修复和生产诊断的安全边界，版本以 2026 年 10 月为准：Arthas 4.3.5、JDK 21（JDK 25 同样适用）、Spring Boot 4。

---

## 一、Arthas 的附着原理与启动

![Arthas 附着流程](../assets/engineering/diagnosis-arthas-attach.svg)

Arthas 4.x 支持 JDK 8 及以上（含 17 / 21 / 25）。`arthas-boot.jar` 通过 JDK 的 Attach API 把 `arthas-agent` 动态加载进目标 JVM，Agent 在目标进程内启动一个 Arthas Server，之后的 `watch`、`trace` 等命令都是在内存里用 Instrumentation + ASM 改写目标类的字节码，命令结束或执行 `reset` 时再还原。

```bash
curl -O https://arthas.aliyun.com/arthas-boot.jar
java -jar arthas-boot.jar           # 列出本机 JVM 进程，输入序号附着
java -jar arthas-boot.jar <pid>     # 直接指定 PID
```

几个容易被忽略的事实：

- **执行 arthas-boot 的必须是完整 JDK**：Attach 依赖 `jdk.attach` 模块，只含 JRE 或用 jlink 裁掉了该模块的镜像无法发起附着；目标 JVM 本身可以是 JRE
- **同一用户、同一个临时目录**：附着通过目标进程临时目录下的 `/tmp/.java_pid<pid>` 套接字通信，用 root 去附着以 app 用户运行的 JVM、或两边看到的 `/tmp` 不是同一个，都会失败，条件清单见 [诊断工具「容器中使用诊断工具」](/jvm/8_monitoring_tools)
- **JDK 21 起动态加载 Agent 会打印警告**（JEP 451）：附着时目标 JVM 的标准错误会输出 `WARNING: A Java agent has been loaded dynamically (...)`。目前只是警告，JEP 写明未来版本会默认禁止，届时同一个参数会成为允许动态加载的开关，生产 JVM 建议在启动参数中预留 `-XX:+EnableDynamicAgentLoading`。jcmd、jstack 不加载 Agent，不受影响；带了 `-XX:+DisableAttachMechanism` 的 JVM 则完全无法附着
- **监听地址**：Arthas Server 默认只监听 `127.0.0.1`，telnet 端口 3658、HTTP / Web Console 端口 8563
- **`quit` 与 `stop` 不同**：`quit` / `exit` 只断开当前会话，Agent 和已增强的类还在；诊断结束必须执行 `stop`，它会还原所有增强类并关闭 Server

---

## 二、在容器与 Kubernetes 中附着

容器里的应用通常是 PID 1、以非 root 用户运行、镜像里没有 JDK，这正好踩中上一节的三个条件。按侵入程度从低到高有三种做法。

### 1、进入应用容器执行

镜像本身是 JDK 镜像时最简单：以**应用自己的用户**进入容器执行即可。

```bash
kubectl exec -it <pod> -c <container> -- sh -c \
  'curl -sO https://arthas.aliyun.com/arthas-boot.jar && java -jar arthas-boot.jar 1'
```

生产环境通常不能从容器内访问外网，推荐在构建镜像时就把 Arthas 打进去。官方镜像的 `/opt/arthas` 目录就是完整发行包，固定到 Docker Hub 上已发布的版本标签（写作时最新的镜像标签是 4.3.2，发行包已到 4.3.5），用时直接执行：

```dockerfile
COPY --from=hengyunabc/arthas:4.3.2 /opt/arthas /opt/arthas
```

```bash
kubectl exec -it <pod> -c <container> -- java -jar /opt/arthas/arthas-boot.jar 1
```

### 2、临时调试容器（kubectl debug）

应用镜像是 JRE 或 distroless、不想改镜像时，用 Kubernetes 的临时容器（Ephemeral Container）带一个 JDK 进去。`--target` 让调试容器共享目标容器的 PID 命名空间，能看到目标 JVM：

```bash
kubectl debug -it <pod> --target=<container> --image=eclipse-temurin:21-jdk -- sh
# 在调试容器内：下载完整的 Arthas 发行包（arthas-packaging-<版本>-bin.zip）并解压，然后
ps -ef                                   # 找到目标 JVM 的 PID
java -jar /path/to/arthas/arthas-boot.jar <pid>
```

- 调试容器与应用容器的文件系统（mount 命名空间）是隔离的，`/tmp` 不共享。**Arthas 4.3.4 起**能识别这种情况，自动把 Arthas Home 复制到目标容器的临时目录再附着，`stop` 时清理；更早的版本在这种场景下会附着失败
- 调试容器的 UID 最好与应用一致；UID 不同时调试容器需要以 root 运行，并能访问 `/proc/<pid>/root`，官方示例用的 `--profile=sysadmin` 会创建特权容器，必须先确认集群策略允许
- 创建临时容器需要对 `pods/ephemeralcontainers` 子资源的 RBAC 权限，临时容器不能删除，只会随 Pod 一起消失

### 3、常驻 Sidecar

需要经常诊断的服务，可以在 Pod 里放一个带 JDK 和 Arthas 的 Sidecar，Pod 设置 `shareProcessNamespace: true`。两个容器用**相同的 UID / GID** 运行时不需要任何额外 Linux capability；UID 不同则需要以 root 运行并添加 `SYS_PTRACE` 等能力，这在 Baseline / Restricted Pod 安全标准下都会被拒绝，需要集群管理员单独豁免。共享 PID 命名空间也意味着 Sidecar 能看到应用进程的命令行和环境变量，不要对不受信任的人开放。

::: tip 只想执行 jcmd 时用 jattach
镜像里没有 JDK、只需要线程栈或堆信息时，不必上 Arthas：独立的小工具 jattach 能直接向目标 JVM 发送 jcmd 命令（如 `jattach 1 jcmd Thread.print`），并自动处理容器命名空间，用法见 [诊断工具](/jvm/8_monitoring_tools)。
:::

---

## 三、按症状选命令

![按症状选 Arthas 命令](../assets/engineering/diagnosis-symptom-command.svg)

附着后先看全局，再根据症状进入方法级命令：

```bash
dashboard -i 2000 -n 5   # 线程 / 内存 / GC 总览，每 2 秒刷新、刷 5 次后退出（默认 5 秒一直刷）
thread -n 3              # 最忙的 3 个线程及其栈
thread --state BLOCKED   # 只看阻塞状态的线程
jvm                      # JVM 版本、启动参数、类加载与 GC 概况
memory                   # 堆、非堆、各内存池使用量
vmoption                 # 查看 / 修改可管理的 VM 选项
```

两条容易用错的结论：

- **`thread -b` 不是通用死锁工具**：它只能找出持有 `synchronized` 监视器、阻塞了其他线程的那一个线程，对 `ReentrantLock` 等 JUC 锁无效。JUC 锁的死锁用 `jstack` / `jcmd Thread.print` 的 `Found one Java-level deadlock` 段落，见 [故障排查「死锁」](/jvm/9_troubleshooting)
- **CPU 高先 `thread -n`，再火焰图**：`thread -n` 能直接看到热点线程的当前栈，偶发或分散的热点用第七节的 `profiler` 采样

---

## 四、方法级观察：watch / trace / stack / monitor / tt

这几个命令都会增强目标类，**一律带 `-n` 限制次数或加条件过滤**，高 QPS 接口上无条件观察会刷屏，也会拖慢业务线程。

### 1、表达式里能用什么

`watch`、`trace`、`tt` 的观察表达式和条件表达式都是 OGNL，围绕一个 Advice 对象展开：

| 变量 | 含义 |
|------|------|
| `params` | 入参数组，`params[0]` 是第一个参数 |
| `returnObj` | 返回值 |
| `throwExp` | 抛出的异常 |
| `target` | 当前对象（`this`），静态方法为 null |
| `#cost` | 方法耗时（毫秒），只能用在条件表达式里 |

### 2、watch：看入参、返回值、异常

```bash
# 默认在方法结束时观察，-x 3 展开 3 层对象
watch com.example.order.OrderService createOrder '{params, returnObj}' -x 3 -n 5

# 只在抛异常时打印
watch com.example.order.OrderService createOrder '{params, throwExp}' -e -x 2 -n 5

# 条件过滤：只看 userId 为 1001 且耗时超过 200ms 的调用（userId 为 long 类型）
watch com.example.order.OrderService createOrder '{params, returnObj}' \
  'params[0].userId == 1001L && #cost > 200' -x 3 -n 10
```

`-b` 表示在方法调用前观察（看原始入参），与默认的方法结束后观察对比，能发现方法内部修改了入参的情况。

### 3、trace：拆解方法内部耗时

```bash
# 只输出总耗时超过 100ms 的调用，最多 5 次
trace com.example.order.OrderService createOrder '#cost > 100' -n 5

# 同时追踪两个类的多个方法（-E 正则，表达式要加引号）
trace -E 'com\.example\.order\.(OrderService|InventoryService)' 'createOrder|deductStock' -n 5

# 不知道是哪个接口慢：从 Spring MVC 入口抓慢请求
trace org.springframework.web.servlet.DispatcherServlet doDispatch '#cost > 500' -n 3
```

输出形如：

```text
`---ts=2026-10-10 14:03:21.118;thread_name=http-nio-8080-exec-7;id=58;is_daemon=true;priority=5;TCCL=org.springframework.boot.loader.launch.LaunchedClassLoader@5a2e4553
    `---[85.12ms] com.example.order.OrderService:createOrder()
        +---[2.10ms] com.example.order.OrderService:validateOrder() #42
        +---[70.43ms] com.example.order.InventoryService:deductStock() #45
        `---[3.05ms] com.example.order.OrderRepository:save() #48
```

`#45` 是调用所在的源码行号。这里 `deductStock()` 占了大头，但 `trace` **只展开一层**，要继续往下就对 `InventoryService deductStock` 再 trace 一次。默认会跳过 JDK 方法，需要时加 `--skipJDKMethod false`。

### 4、stack 与 monitor

```bash
# 谁调用了这个方法：打印调用栈，可加条件
stack com.example.order.OrderService cancelOrder 'params[0] == 1001L' -n 3

# 每 10 秒统计一次调用次数、成功 / 失败数、平均 RT 和失败率
monitor -c 10 com.example.order.OrderService createOrder
```

`stack` 默认不能增强 `java.*` 等 JDK 系统类，像 `stack java.lang.System exit` 这样排查「谁调用了 System.exit」，需要先执行 `options unsafe true`。官方明确警告这可能把 JVM 搞挂，只在有把握时使用，用完立刻 `options unsafe false`。

### 5、tt：记录现场，事后查看

```bash
tt -t com.example.order.OrderService createOrder -n 50    # 记录接下来的 50 次调用，满了自动停止
tt -l                                                     # 列出记录，INDEX 从 1000 开始编号
tt -i 1003 -w '{params, returnObj, throwExp}' -x 3        # 查看第 1003 次调用的详情
tt -s 'returnObj == null'                                 # 按条件筛选已记录的调用
tt --delete-all                                           # 清空记录，释放内存
```

- `-n 50` 是记录**之后**的 50 次调用，不是「最近 50 次」
- tt 保存的是对象引用，方法执行后又修改了入参或返回值，看到的就不是调用时刻的值
- 记录常驻内存，退出 Arthas 也不会释放，用完必须 `tt --delete-all`

::: warning tt -p 会真实地重新执行
`tt -i 1003 -p` 会用记录的参数**真的再调用一次**方法：下单就再下一单、扣款就再扣一次，生产环境对有副作用的方法禁止使用。重放在 Arthas 内部线程中执行，原调用线程的 ThreadLocal（登录用户、TraceId、事务上下文）全部丢失，结果可能与原调用不同。
:::

---

## 五、类加载器：在 Spring Boot fat jar 上用 ognl / vmtool / logger

`ognl`、`vmtool`、`logger`、`getstatic` 这类命令需要按类名找到类，**默认用的是系统类加载器**。而 `java -jar` 启动的 Spring Boot fat jar 里，业务类和 `BOOT-INF/lib` 下的依赖都由 Spring Boot 的 `LaunchedClassLoader` 加载（Boot 3.2 起为 `org.springframework.boot.loader.launch.LaunchedClassLoader`，此前是 `org.springframework.boot.loader.LaunchedURLClassLoader`），不指定类加载器就会报找不到类。WAR 部署在 Tomcat 里同理，要用 Web 应用自己的类加载器。

先确定类由谁加载：

```bash
sc -d com.example.order.OrderService    # 输出中的 classLoaderHash，以及类来自哪个 jar
classloader -t                          # 类加载器继承树及各自的 hash
```

之后两种指定方式任选：`-c <hash>`（hash 每次启动都会变）或 `--classLoaderClass <类名>`（要求该类型的加载器只有一个实例，fat jar 通常满足）。

### 1、ognl：执行表达式

```bash
# 调用业务工具类的静态方法
ognl --classLoaderClass org.springframework.boot.loader.launch.LaunchedClassLoader \
  '@com.example.common.DateUtils@format(new java.util.Date())'

# 读取静态字段（私有字段也能读）
ognl -c 5a2e4553 '@com.example.order.OrderConfig@MAX_ITEMS'

# 修改功能开关：开关本身是 AtomicBoolean 时调用它的方法
ognl --classLoaderClass org.springframework.boot.loader.launch.LaunchedClassLoader \
  '@com.example.order.FeatureFlags@NEW_PAYMENT.set(false)'
```

`@类@字段` 的写法只适合读取。普通静态字段不要指望用表达式赋值：`static final` 的基本类型和字符串常量在编译期就被内联进调用方，改了也不生效；Arthas 默认的 strict 模式还会拒绝在表达式里修改对象属性。线上开关应该做成可变对象或放进配置中心，而不是靠 ognl 改字段。

### 2、vmtool：直接拿到 Spring Bean

传统的 `ContextLoader.getCurrentWebApplicationContext()` 只在部署到外部 Servlet 容器、配置了 `ContextLoaderListener` 时才有值，内嵌容器的 Spring Boot 应用里返回 null。可靠的做法是用 `vmtool` 从堆里找出 `ApplicationContext` 实例：

```bash
# 先确认有几个容器：Spring Cloud 父子上下文、独立管理端口都会多出实例
vmtool --action getInstances \
  --classLoaderClass org.springframework.boot.loader.launch.LaunchedClassLoader \
  --className org.springframework.context.ApplicationContext \
  --express 'instances.length'

# 取 Bean 并调用只读方法
vmtool --action getInstances \
  --classLoaderClass org.springframework.boot.loader.launch.LaunchedClassLoader \
  --className org.springframework.context.ApplicationContext \
  --express 'instances[0].getBean("orderService").getOrderById(1001L)' -x 2

# 查看生效的配置值
vmtool --action getInstances \
  --classLoaderClass org.springframework.boot.loader.launch.LaunchedClassLoader \
  --className org.springframework.context.ApplicationContext \
  --express 'instances[0].getEnvironment().getProperty("order.pay-timeout")'
```

通过 Bean 调用的方法会真实执行，只调用查询类方法；`getProperty` 能读出数据库密码等敏感配置，输出会留在终端和 Arthas 日志里，按敏感数据对待。`vmtool --action getInstances` 默认最多返回 10 个实例（`--limit` 调整），统计大量对象会遍历堆，对大堆有明显开销。

### 3、logger：临时调整日志级别

线上排查最常用的操作之一：不重启，把某个包的日志临时调到 DEBUG。

```bash
# 查看某个 logger 的当前级别与 appender
logger --classLoaderClass org.springframework.boot.loader.launch.LaunchedClassLoader \
  -n com.example.order

# 调到 DEBUG，问题复现后改回 INFO
logger --classLoaderClass org.springframework.boot.loader.launch.LaunchedClassLoader \
  --name com.example.order --level debug
logger --classLoaderClass org.springframework.boot.loader.launch.LaunchedClassLoader \
  --name com.example.order --level info
```

不加类加载器参数时修改的是系统类加载器里的 Logback 实例，命令提示成功但应用日志毫无变化，这是最常见的误用。已暴露 Actuator 的应用也可以通过 `loggers` 端点调整，见 [Actuator 监控](/spring-boot/7_actuator)。

---

## 六、反编译与热修复：jad / mc / retransform

### 1、jad：确认运行的是哪份代码

「本地没问题、线上有问题」时，先确认线上加载的类是不是你以为的版本：

```bash
sc -d com.example.order.OrderService            # 类来自哪个 jar（code-source）
jad com.example.order.OrderService createOrder  # 反编译指定方法
```

依赖冲突导致加载了旧版本类时，`sc -d` 的 code-source 会直接指出是哪个 jar，依赖仲裁规则见 [构建工具](./1_build_tools)。

### 2、mc + retransform：紧急热修复

```bash
# 1. 反编译出源码，修改后重新编译（-c 指定加载该类的类加载器，保证依赖可见）
jad --source-only com.example.order.OrderService > /tmp/OrderService.java
mc -c 5a2e4553 /tmp/OrderService.java -d /tmp

# 2. 加载新字节码
retransform /tmp/com/example/order/OrderService.class

# 3. 回滚：删除所有 retransform 条目，再显式触发一次，类恢复为原始字节码
retransform -l
retransform --deleteAll
retransform --classPattern com.example.order.OrderService
```

- 只能改方法体，**不能增删字段和方法**；正在执行的方法（比如一个 while 循环）要等它返回后下次调用才生效
- `mc` 编译反编译出来的源码经常失败（Lambda、Lombok、内部类），更稳妥的做法是在本地用相同 JDK 版本编译好 `.class` 再上传
- **retransform 的效果在 `stop` 之后依然保留**，不按第 3 步回滚，修改会一直存在到进程重启；多个 Pod 要逐个处理，新扩容的 Pod 不会带上修改
- 官方推荐用 `retransform` 而不是 `redefine`：`redefine` 与 `watch`、`trace`、`jad`、`tt` 等命令冲突，执行这些命令后被 redefine 的字节码会被重置，`reset` 也对它无效

热修复只是止血手段，同一修复必须走正常的提交与发布流程尽快替换。

---

## 七、性能剖析与内存

### 1、profiler：内置 async-profiler

Arthas 内置了 async-profiler，附着后即可采样火焰图，不用单独部署：

火焰图与 Profiler 选型见 [性能分析工具](/high-perf/3_profilers)。

```bash
profiler start                                   # 默认采样 CPU
profiler stop --file /tmp/cpu.html               # 停止并输出 HTML 火焰图

profiler start --event wall --duration 30        # wall-clock：CPU 不高但很慢时用，30 秒后自动停止
profiler start --event alloc                     # 内存分配热点
profiler list                                    # 当前环境支持的事件
```

`--format` 的取值是 `flamegraph`、`collapsed`、`jfr` 等，给 `--file` 一个 `.html` 后缀会自动按火焰图输出。容器里 `cpu` 事件依赖 `perf_events`，被安全策略限制时改用 `--event itimer`。火焰图的读法、各事件的适用场景以及 async-profiler / JFR / JProfiler 的选型见 [性能分析工具](/high-perf/3_profilers)，先定位瓶颈类型再选工具的思路见 [性能分析方法论](/high-perf/2_methodology)。

### 2、heapdump 与 JFR

```bash
heapdump --live /tmp/heap.hprof    # 只导出存活对象，会先触发一次 Full GC
```

导出堆转储会让应用停顿，堆越大停得越久（数 GB 的堆可达秒级甚至更长），还要确认磁盘空间足够。线上更推荐先把实例从负载均衡摘掉再导出；用 MAT 分析 dump、以及低开销常开的 JFR（`jcmd <pid> JFR.start ...`）都见 [诊断工具](/jvm/8_monitoring_tools)。

---

## 八、生产诊断安全守则

Arthas 能读任意对象、调用任意方法、替换字节码，本质上是一个进程内的远程执行入口。把它当作生产变更来管：

- **最小暴露**：保持默认的 `127.0.0.1` 监听，不要用 `--target-ip 0.0.0.0` 把端口开到网络上；需要集中接入多台实例时用 Arthas Tunnel Server（Agent 主动外连，`--tunnel-server 'ws://<host>:7777/ws'`），并对 Tunnel Server 本身做访问控制
- **鉴权**：远程连接必须配置用户名和密码（`--username` / `--password`，或 `arthas.properties`）；密码不要写进命令历史和工单，本机连接默认免鉴权
- **限流**：所有增强命令带 `-n` 或条件表达式，避免在核心链路上做大范围 `-E` 正则匹配；`options unsafe true` 用完立即关闭
- **数据**：`watch`、`tt`、`vmtool` 的输出可能包含手机号、令牌、密码，不要截图贴到公共群，诊断记录按敏感数据保存
- **收尾**：`tt --delete-all` 释放记录，`retransform --deleteAll` 加显式触发撤销热修复，最后 `stop` 还原增强类并卸下 Server；只 `quit` 等于把一个开着的诊断端口留在生产进程里
- **审计**：谁、何时、对哪个实例执行了什么命令要能追溯，Kubernetes 上 `exec` / `debug` 权限只授予值班人员并开启 API 审计

---

## 小结

- Arthas 通过 Attach API 动态加载 Agent，发起端需要完整 JDK、与目标同用户、共享 `/tmp`；JDK 21 起会打印动态加载警告，生产 JVM 预留 `-XX:+EnableDynamicAgentLoading`
- 容器里优先以应用用户 `kubectl exec`；JRE / distroless 镜像用 `kubectl debug --target` 带 JDK 进去，Arthas 4.3.4 起支持跨 mount 命名空间附着
- 慢用 `trace` + `monitor`，错用 `watch` + `tt`，版本问题用 `sc -d` + `jad`，CPU 用 `thread -n` + `profiler`；`thread -b` 只认 synchronized，`tt -p` 会真实重放
- Spring Boot fat jar 上 `ognl`、`vmtool`、`logger` 必须用 `-c` 或 `--classLoaderClass` 指定 `LaunchedClassLoader`；拿 Bean 用 `vmtool`，不要用 `ContextLoader`
- 热修复用 `mc` + `retransform`，效果在 `stop` 后仍保留，要用 `--deleteAll` 加显式触发回滚；诊断结束一定 `stop`

## 参考资料

- Arthas 官方文档：[Arthas 用户文档](https://arthas.aliyun.com/doc/)
- Arthas 发行说明：[alibaba/arthas Releases](https://github.com/alibaba/arthas/releases)
- 在 Docker 与 Kubernetes 中使用 Arthas（临时容器、Sidecar）：[Docker 与 Kubernetes](https://arthas.aliyun.com/doc/docker.html)
- vmtool 命令：[vmtool](https://arthas.aliyun.com/doc/vmtool.html)
- ognl 命令与类加载器参数：[ognl](https://arthas.aliyun.com/doc/ognl.html)
- logger 命令：[logger](https://arthas.aliyun.com/doc/logger.html)
- tt 命令：[tt](https://arthas.aliyun.com/doc/tt.html)
- retransform 命令：[retransform](https://arthas.aliyun.com/doc/retransform.html)
- redefine 与 retransform 的冲突说明：[redefine](https://arthas.aliyun.com/doc/redefine.html)
- profiler 命令：[profiler](https://arthas.aliyun.com/doc/profiler.html)
- options（unsafe、strict）：[options](https://arthas.aliyun.com/doc/options.html)
- 鉴权：[auth](https://arthas.aliyun.com/doc/auth.html)
- JEP 451 动态加载 Agent 的警告：[JEP 451: Prepare to Disallow the Dynamic Loading of Agents](https://openjdk.org/jeps/451)
- Kubernetes 临时容器调试：[Debug Running Pods](https://kubernetes.io/docs/tasks/debug/debug-application/debug-running-pod/)
- Spring Boot 可执行 jar 的启动器：[Launching Executable Jars](https://docs.spring.io/spring-boot/specification/executable-jar/launching.html)

> 下一篇：[API 文档](./5_api_doc)
