# 开发总结 - 高性能

> 精华提炼，细节详见 [高性能模块](/high-perf/0_overview)；题目清单见 [高性能面试题](/high-perf/99_interview)，本页按清单的分组与顺序作答。
> 三高另外两页：[高并发](./13_high_con) · [高可用](./14_high_avail)。


## 一、指标与方法论

### Q1：QPS、TPS、RT、并发数之间是什么关系？如何用 Little 定律估算所需线程数或连接数？

**核心结论**：稳态系统中 `并发数 L = 到达速率 λ × 平均停留时间 W`，即 `并发数 = QPS × RT（秒）`。TPS 是业务事务口径，一笔事务（如"下单"）内部可能包含多次请求。

| 已知 | 推算 |
|------|------|
| QPS = 2000，RT = 50ms | 系统内平均并发 = 2000 × 0.05 = 100 |
| 线程池 200 线程（全阻塞 IO），RT = 100ms | 理论最大 QPS ≈ 200 / 0.1 = 2000 |
| QPS 1000，单次持有连接 20ms | 平均需要 1000 × 0.02 = 20 个连接，再留余量 |

- "系统"可以是任意边界：整个服务、一个线程池、一个连接池
- **RT 上升直接吃掉容量**：线程、连接固定时 RT 翻倍，可承载 QPS 减半；反过来降低 RT 等价于扩容
- 只在稳态成立：到达速率超过处理能力时队列持续增长，出现压测中"QPS 不再上升、RT 陡增"的拐点

→ 详见 [性能指标](/high-perf/1_metrics)

### Q2：为什么不能只看平均响应时间？P99 和 P999 分别意味着什么？

**核心结论**：平均值会把少数极慢请求"摊平"，而用户感知和超时故障恰恰由长尾决定。P99 表示 99% 的请求快于该值，P999 表示 99.9% 的请求快于该值。

| 100 个请求：98 个 10ms、2 个 2000ms | 结果 |
|------|------|
| 平均值 | 49.8ms，看起来很健康 |
| P50 | 10ms |
| P99 | 2000ms，每 100 次就有 1～2 次很慢 |

- P99 是核心接口 SLO 和超时设置的依据；P999 用于金融、交易等长尾敏感场景
- **扇出放大长尾**：并行调用 100 个下游，至少碰上一次 P99 慢请求的概率 `1 - 0.99^100 ≈ 63%`
- 分位数**不能求平均、不能相加**，多实例要基于直方图合并（Prometheus `histogram_quantile`）
- 压测注意**协调遗漏**：闭环工具在服务卡顿时少发请求，长尾被低估，用 wrk2 固定速率或 Gatling 开放模型

→ 详见 [性能指标](/high-perf/1_metrics)

### Q3：USE 方法和 RED 方法分别适合什么场景？

**核心结论**：USE 面向**资源**，回答"哪种资源有问题"；RED 面向**服务 / 接口**，回答"哪个接口有问题"。实践中先用 RED 找到慢接口，再用 USE 查它所在机器与依赖的资源。

| 方法 | 对象 | 三个维度 | 适用场景 |
|------|------|---------|---------|
| USE | CPU、内存、磁盘、网络，以及线程池、连接池等软件资源 | 使用率、饱和度（排队）、错误 | 系统整体变慢但不知道原因时做第一轮全面排查 |
| RED | 服务、接口 | 请求速率、错误、耗时分布 | 监控大盘与告警，定位具体慢接口 |

- **饱和度比使用率更能说明问题**：Load 高于核数、线程池队列堆积、连接池有等待线程
- Spring Boot + Micrometer 的 `http.server.requests` 就是 RED 数据，分位数需开启 `percentiles-histogram`

→ 详见 [性能分析方法论](/high-perf/2_methodology)

### Q4：接口突然变慢，你的排查思路是什么？（系统资源 → JVM → 线程/锁 → 外部依赖）

**核心结论**：自顶向下逐层下钻，每一层用数据排除或确认；最实用的分叉点是"**CPU 忙还是在等**"。

| 步骤 | 要回答的问题 | 手段 |
|------|--------------|------|
| ① 系统资源 | CPU、内存、IO、网络是否打满或饱和 | `top`、`vmstat`、`iostat`、`sar` |
| ② JVM | GC 是否频繁、停顿是否过长、堆是否持续上涨 | GC 日志、`jstat -gcutil`、JFR |
| ③ 线程 / 锁 | 哪些方法耗 CPU、线程卡在哪里、是否有锁竞争 | `jstack`、Arthas `thread` / `trace`、火焰图 |
| ④ 外部依赖 | 时间是否花在等 DB、缓存、RPC、MQ | 链路追踪、慢查询日志、客户端耗时埋点 |

- **CPU 高、RT 高**：计算型瓶颈，看 CPU 火焰图，或确认是否 GC 线程占满 CPU
- **CPU 低、RT 高**：等待型瓶颈（锁、IO、连接池、下游），看 `jstack` 线程状态分布或 wall-clock 火焰图
- 线上"突然"变慢时，先关联最近的发布与配置变更

→ 详见 [性能分析方法论](/high-perf/2_methodology)

### Q5：Amdahl 定律对性能优化有什么指导意义？

**核心结论**：局部优化对整体的加速上限为 `S = 1 / ((1 - p) + p / k)`（p 为被优化部分的耗时占比，k 为该部分自身加速倍数），所以**先优化占比最大的部分**。

| 占比 p | 自身加速 k | 整体加速比 |
|--------|-----------|-----------|
| 5% | ∞ | 1.05 |
| 50% | 10 倍 | 1.82 |
| 90% | 10 倍 | 5.26 |

- 占比 5% 的环节即使降到 0，整体也只快约 5%
- 并行化同样受限：10% 必须串行时，加多少核加速比上限都是 10 倍
- 微基准快 30%，要乘以该方法在接口总耗时中的占比才是真实收益

→ 详见 [性能分析方法论](/high-perf/2_methodology)

---

## 二、分析工具与基准测试

### Q6：火焰图怎么看？CPU 火焰图和 wall-clock 火焰图有什么区别？

**核心结论**：纵轴是调用栈（下层调用上层，顶部是采样时正在执行的方法），**横轴宽度是样本占比、不是时间顺序**；找顶部的"平顶"（自身热点）和中间的"宽塔"（热点子树）。CPU 火焰图宽度代表 CPU 时间，wall-clock 火焰图宽度代表墙钟时间（含阻塞与等待）。

| 事件 | 宽度代表 | 适用 |
|------|----------|------|
| `cpu` | CPU 时间 | CPU 高：计算热点、序列化、正则、GC 线程占比 |
| `wall` | 墙钟时间 | CPU 不高但很慢：等下游、等锁、等连接池 |
| `alloc` | 分配字节数 | GC 频繁的根因 |
| `lock` | 锁等待时间 | 锁竞争 |

- 颜色只区分帧类型（Java、JIT 内联、C++/JVM、内核、native），不表示热度
- wall 模式下 `Unsafe.park`、`epoll_wait` 很宽只说明线程在等，要看**谁在等、等什么**，需配合 `-t` 按线程拆分
- 采样 30～60 秒，且在问题发生期间、高负载下采样

```bash
asprof -d 30 -f /tmp/cpu.html <pid>              # CPU（3.x 为 asprof，2.x 为 profiler.sh）
asprof -e wall -t -d 30 -f /tmp/wall.html <pid>  # wall-clock，按线程拆分
```

→ 详见 [性能分析工具](/high-perf/3_profilers)

### Q7：线上 CPU 使用率飙高，如何定位到具体的代码行？

**核心结论**：先找到高 CPU 的进程和线程，把线程 ID 转成十六进制去线程栈里找对应的 `nid`，栈顶即热点代码；若是 GC 线程则转查 GC 日志。偶发或多个线程分摊时，直接抓 30～60 秒 CPU 火焰图更可靠。

```bash
top                                   # 1. 找到高 CPU 的 Java 进程
top -H -p <pid>                       # 2. 找到高 CPU 的线程 TID
printf "%x\n" <tid>                   # 3. TID 转十六进制，如 12345 → 3039
jstack <pid> | grep -A 30 "nid=0x3039"  # 4. 看该线程栈，定位到类与行号
```

- Arthas 更快：`thread -n 3` 直接列出最忙的 3 个线程及其栈，`profiler start` / `profiler stop` 生成火焰图
- 单次 `jstack` 只是瞬时快照，连续抓 3～5 次对比，栈顶稳定出现的方法才是热点
- 线程名是 `GC Thread` / `G1 Conc` 等时，问题在分配速率或内存泄漏，见 Q12

→ 详见 [JVM 故障排查](/jvm/9_troubleshooting)、[线上诊断](/engineering/4_diagnosis)、[性能分析工具](/high-perf/3_profilers)

### Q8：JFR 能采集哪些信息？适合排查什么问题？

**核心结论**：JFR（JDK Flight Recorder）是 JDK 内置的事件录制器，可采集方法采样热点、对象分配、GC、锁竞争、IO、异常等事件；默认配置开销通常在 1%～2% 以内，**适合生产常驻录制、问题发生后回溯**，尤其是偶发、难复现的问题。

```bash
# 启动即常驻录制，保留最近 6 小时
java -XX:StartFlightRecording=name=bg,settings=default,maxage=6h,dumponexit=true,filename=/data/jfr/app.jfr -jar app.jar
# 问题发生后导出内存中的录制
jcmd <pid> JFR.dump name=bg filename=/tmp/snapshot.jfr
```

- JDK 11 起开源免费，OpenJDK 8u262 起也已包含
- 用 JMC 打开分析，或用 async-profiler 的 `jfrconv` 转成火焰图、`jfr print` 命令行查看
- 局限：CPU 采样粒度较粗；要看精细的 CPU / wall 火焰图仍用 async-profiler

→ 详见 [性能分析工具](/high-perf/3_profilers)

### Q9：为什么用 `System.nanoTime` 循环测性能不可靠？JMH 是如何解决的？

**核心结论**：手写计时循环会被 JIT 预热、死代码消除、常量折叠、循环优化和 Profile 污染干扰，测到的不是真实性能。JMH 把预热、进程隔离、结果消费和统计做成了框架能力。

| 陷阱 | 说明 | JMH 的对策 |
|------|------|-----------|
| JIT 预热 | 解释执行与 C2 编译后性能可差数十倍 | `@Warmup` 预热轮次 |
| 死代码消除 | 结果未被使用，计算被整段删除 | `return` 结果或 `Blackhole.consume()` |
| 常量折叠 | 输入是编译期常量 | 输入放在 `@State` 对象的非 final 字段 |
| 循环优化 | 循环展开、OSR 与真实调用不同 | 由 JMH 控制调用次数 |
| Profile 污染 | 同一 JVM 先后测多个实现互相影响 | `@Fork` 独立 JVM 进程，正式测试至少 2 |
| 统计不足 | 单次测量波动大 | 多轮迭代，输出 `Score ± Error` |

- 解读结果看**误差区间是否重叠**、看随 `@Param` 规模变化的趋势，用 `-prof gc` 解释差异
- JMH 回答"A 写法比 B 快多少"，系统能扛多少仍要靠压测

→ 详见 [基准测试（JMH）](/high-perf/4_benchmark)

---

## 三、JVM 层

### Q10：低延迟和高吞吐场景分别怎么选垃圾收集器？

**核心结论**：通用在线服务默认 G1；P99 敏感、大堆且 CPU 有余量时选分代 ZGC；批处理、离线计算只看总耗时选 Parallel。多数服务用 G1 + 合理堆大小即可。

| 收集器 | 典型停顿 | 吞吐 | 适用场景 | JDK 21 启用方式 |
|--------|----------|------|----------|----------------|
| G1 | 可设目标（默认 `MaxGCPauseMillis=200`） | 中高 | 通用在线服务 | 默认（服务器级机器） |
| 分代 ZGC | 通常亚毫秒级，与堆大小基本无关 | 中高，并发阶段额外占 CPU | P99 敏感、大堆 | `-XX:+UseZGC -XX:+ZGenerational` |
| Parallel | 较长 | 最高 | 批处理、离线计算 | `-XX:+UseParallelGC` |
| Serial | 长 | 低 | 1 核或很小内存的容器 | `-XX:+UseSerialGC` |

- JVM 判断不是"服务器级机器"（CPU 少于 2 或内存小于约 1792MB）时默认选 Serial，容器 CPU limit 为 1 时要**显式指定收集器**
- JDK 23 起分代成为 ZGC 默认模式，JDK 24 移除非分代模式
- 停顿不是 P99 的主要来源时，换收集器收益有限

→ 详见 [JVM 层性能策略](/high-perf/5_jvm_tuning)

### Q11：应用刚启动时 RT 毛刺明显，原因是什么？如何缓解？

**核心结论**：刚启动的 JVM 以解释执行和 C1 为主，热点方法要调用足够多次才由 C2 编译到峰值性能；叠加类加载、懒初始化、连接池和缓存为空，新实例一上来接满流量就会产生 RT 毛刺。缓解靠"**预热流量 + 就绪后置 + 预热权重**"。

| 手段 | 做法 |
|------|------|
| 预热流量 | 启动后、就绪前主动调用核心接口若干轮 |
| 就绪探针后置 | 预热逻辑放在 `ApplicationRunner` 中，完成后 readiness 才通过 |
| 预热权重 | 负载均衡对新实例逐步放量（Dubbo warmup、Envoy slow start） |
| 提前初始化 | 连接池 `minimumIdle`、缓存预加载、单例提前创建 |
| 保证 CPU | CPU limit 过小会显著拉长 JIT 编译时间 |

- AppCDS 只缩短类加载，**解决不了 JIT 预热**；CRaC、Leyden AOT 缓存（JDK 24+）、Native Image 改造成本高，只在启动时间直接影响弹性扩容或 Serverless 时考虑

→ 详见 [JVM 层性能策略](/high-perf/5_jvm_tuning)、[优雅上下线与变更](/high-avail/8_graceful_release)

### Q12：为什么降低对象分配速率往往比调 GC 参数更有效？

**核心结论**：分配速率直接决定 Young GC 的频率和对象过早晋升的压力；调参只能改变"怎么回收"，减少分配才是"少产生垃圾"，而且对所有收集器都成立。

| 测量手段 | 看什么 |
|--------|--------|
| GC 日志 | `分配速率 ≈ Eden 大小 / Young GC 间隔` |
| async-profiler `-e alloc` | 分配最多的调用栈 |
| JFR | 分配采样事件，按类、按栈聚合 |
| JMH `-prof gc` | `gc.alloc.rate.norm`，每次操作分配的字节数 |

- 常见手段：避免装箱、集合与 `StringBuilder` 预分配、减少中间对象和多层 DTO 转换、大结果集流式读取、复用 IO 缓冲区、避免 G1 Humongous 大对象
- 逃逸分析效果依赖内联、不稳定，以分配火焰图实测为准
- 老年代 GC 后持续上涨是内存泄漏，调参数无用，要做堆 dump 分析

→ 详见 [JVM 层性能策略](/high-perf/5_jvm_tuning)

---

## 四、代码与池化

### Q13：有哪些常见的代码级性能优化手段？`HashMap` 初始容量应该如何设置？

**核心结论**：先用 Profiler 确认热点再动手，冷代码优先可读性。`HashMap` 按 `预期元素数 / 0.75 + 1` 设置初始容量，或直接用 JDK 19+ 的 `HashMap.newHashMap(n)`、Guava `Maps.newHashMapWithExpectedSize(n)`。

| 类别 | 手段 |
|------|------|
| 对象 | `Pattern`、`ObjectMapper`、`DateTimeFormatter` 等线程安全的昂贵对象作为 `static final` 复用 |
| 集合 | 已知大小时预分配；`List` 上不做高频 `contains` |
| 字符串 | 循环内用 `StringBuilder`；热点路径避免 `split` / `replaceAll` 反复编译正则 |
| 装箱 | 累加、计数用基本类型，Stream 用 `IntStream` / `mapToInt` |
| 锁 | 缩小临界区、IO 移出锁；计数用 `LongAdder` |
| 异常与日志 | 不用异常做流程控制；日志用占位符 + 异步 Appender（见 Q14） |
| 算法 | 嵌套循环查找（O(n²)）改为 `Map` 索引 |

- 误区：`new HashMap<>(n)` 不能保证不扩容，因为扩容阈值是 `容量 × 0.75`

→ 详见 [代码级优化](/high-perf/6_code_optimization)

### Q14：为什么不建议用异常做流程控制？日志有哪些常见的性能坑？

**核心结论**：创建异常时 `fillInStackTrace()` 要遍历调用栈，代价远高于普通对象，高频抛出会成为 CPU 热点；日志的坑主要在"级别不满足时参数照样计算"和"同步写磁盘阻塞业务线程"。

- **异常**：先做廉价校验，只让极少数边界情况走异常；高频业务异常不需要栈时用 `super(message, null, false, false)` 关闭栈追踪；注意 `-XX:+OmitStackTraceInFastThrow` 会让频繁抛出的内置异常丢失堆栈

| 日志坑 | 正确做法 |
|------|---------|
| 字符串拼接、`toString()` 无论是否输出都执行 | 使用 SLF4J `{}` 占位符 |
| 占位符挡不住参数本身的计算（如 JSON 序列化） | 加 `isDebugEnabled()` 判断 |
| 同步 Appender 磁盘 IO 阻塞业务线程 | Logback `AsyncAppender` / Log4j2 `AsyncLogger`，注意队列满时策略 |
| `%L`、`%M`、`%C` 位置信息 | 需要获取调用栈，生产慎用 |
| 大循环逐条打日志、生产全量 DEBUG | 控制日志量 |

→ 详见 [代码级优化](/high-perf/6_code_optimization)

### Q15：数据库连接池的大小如何确定？连接池是不是越大越好？

**核心结论**：不是越大越好。连接池大小由**数据库能并行处理多少**决定，连接超过数据库的并行能力只会增加上下文切换和锁竞争，RT 反而变差。先用经验公式估算，再用 Little 定律校验。

1. **经验公式**（HikariCP Wiki）：`connections = 核数 × 2 + 有效磁盘数`，核数是**数据库服务器**的物理核数，算出的是**数据库侧总连接数**，多个实例要分摊
2. **Little 定律校验**：`所需连接数 = 单实例 QPS × 每次持有连接的时间`；算出的值远大于公式时，**先缩短持有时间**（优化慢 SQL、事务内不做 RPC），而不是加大池子
3. **全局上限**：所有实例 `maximumPoolSize` 之和 ≤ 数据库 `max_connections × 80%`，扩容前重新核算（见 [高并发 Q37](./13_high_con)）

| 参数 | 要点 |
|------|------|
| `maximumPoolSize` | 默认 10，按上面三步确定 |
| `minimumIdle` | 官方建议不设置（等于最大值），固定大小 |
| `connectionTimeout` | 默认 30s，线上建议 2～5s 快速失败 |
| `maxLifetime` | 比数据库 `wait_timeout`、防火墙、LB 空闲超时短几十秒 |
| `keepaliveTime` | HikariCP 5.1.0 起默认 120000ms（2 分钟），更早版本默认 0（禁用） |

- 判断池太小：`hikaricp_connections_pending` 持续大于 0，且数据库本身不忙

→ 详见 [池化技术](/high-perf/7_pooling)、[数据库连接池](/database/5_practice/3_connection_pool)

### Q16：如何发现和排查连接泄漏？

**核心结论**：连接借出后长期不归还，池会逐渐耗尽，典型表现是**获取连接超时而数据库很空闲**。用 `leakDetectionThreshold` 打出借出时的调用栈，配合 `active` / `pending` 指标定位。

| 常见原因 | 处理 |
|---------|------|
| 手动获取连接未在 `finally` / try-with-resources 中关闭 | 统一交给框架管理连接 |
| 异常路径上事务未正确结束 | 检查回滚逻辑 |
| 持有连接期间调用外部服务 | **事务内不做 RPC**，这是连接池耗尽最常见的原因 |

- `leakDetectionThreshold` 默认 0（关闭），排查时设为略大于最长正常 SQL 耗时
- 监控 `hikaricp_connections_active` 长期贴近上限、`pending` 持续大于 0 即告警

→ 详见 [池化技术](/high-perf/7_pooling)

### Q17：HTTP 客户端连接池需要关注哪些参数？为什么会出现 `NoHttpResponseException`？

**核心结论**：关注总连接数、**每路由连接数**、三类超时和连接存活时间，客户端全局单例复用。`NoHttpResponseException` / `Connection reset` 通常是客户端拿到了**已被服务端关闭的空闲连接**：客户端空闲超时大于服务端 Keep-Alive 超时。

| 参数（Apache HttpClient 5） | 默认 | 要点 |
|------|------|------|
| `MaxConnTotal` | 25 | 整个池的上限 |
| `MaxConnPerRoute` | **5** | 调用单一下游时并发超过 5 就排队，最常见的隐形瓶颈 |
| 获取连接 / 建连 / 读超时 | — | 三类分别设置，获取连接超时宜短 |
| `TimeToLive`、`evictIdleConnections` | — | 限制连接寿命，后台清理空闲连接 |
| `ValidateAfterInactivity` | — | 空闲一段时间后借出前先校验 |

- OkHttp 默认 `ConnectionPool` 保留 5 个空闲连接、空闲 5 分钟；`maxRequestsPerHost` 默认 5 且只影响异步调用
- 解决 `NoHttpResponseException`：让客户端空闲超时**小于**服务端 Keep-Alive 超时（Nginx `keepalive_timeout` 默认 75s，Tomcat `keepAliveTimeout` 默认取 `connectionTimeout`），开启空闲清理与借出校验；幂等请求可配合一次重试

→ 详见 [池化技术](/high-perf/7_pooling)

### Q18：什么对象不应该池化？

**核心结论**：只有**创建代价高、可安全复用**的资源才值得池化，通常只有连接、线程、大块缓冲区和初始化极慢的对象；普通小对象池化反而更慢。

| 不该池化的场景 | 原因 |
|------|------|
| 普通小对象（DTO、集合、`StringBuilder`） | TLAB 指针碰撞分配极快，年轻代回收几乎零成本；池化延长生命周期、增加老年代压力和同步开销 |
| 内部状态复杂、难以可靠重置的对象 | 归还后残留状态导致数据串扰 |
| 并发极高、池竞争激烈 | 池本身的锁成为瓶颈，改用 `ThreadLocal` 每线程一份 |
| 虚拟线程 | 创建成本极低，池化违背设计初衷；但仍需信号量或连接池限制下游并发 |

→ 详见 [池化技术](/high-perf/7_pooling)

---

## 五、异步、批量与 IO

### Q19：如何把一个串行调用多个下游的接口优化为并行？需要注意什么？

**核心结论**：相互独立的下游调用用 `CompletableFuture` 在**独立、有界的线程池**中并行发起，RT 从各段之和降为最慢的一段。关键是线程池、超时、异常三件事。

```java
CompletableFuture<Product> productF = CompletableFuture.supplyAsync(() -> productClient.get(id), ioPool);
CompletableFuture<Price> priceF = CompletableFuture.supplyAsync(() -> priceClient.get(id), ioPool);
CompletableFuture<List<Review>> reviewF = CompletableFuture.supplyAsync(() -> reviewClient.top(id, 10), ioPool)
        .exceptionally(ex -> List.of())                              // 非核心数据失败降级
        .completeOnTimeout(List.of(), 200, TimeUnit.MILLISECONDS);
ProductDetailVO vo = CompletableFuture.allOf(productF, priceF, reviewF)
        .thenApply(v -> ProductDetailVO.of(productF.join(), priceF.join(), reviewF.join()))
        .orTimeout(500, TimeUnit.MILLISECONDS)                       // 整体超时预算
        .join();                                                     // 异常包装为 CompletionException
```

- **不要用 `commonPool`**：默认线程数为核数 − 1，被阻塞 IO 占满会拖垮所有使用它的代码
- 核心数据失败整体失败并给出明确异常；非核心数据用 `exceptionally` / `completeOnTimeout` 降级
- `join()` 抛出 `CompletionException`，取 `getCause()` 区分超时与业务失败
- HTTP / RPC 客户端必须自带超时（见 Q20）；ThreadLocal、链路追踪上下文需要显式传递

→ 详见 [异步与批量](/high-perf/8_async_batch)

### Q20：`CompletableFuture.orTimeout` 超时后，底层任务会被取消吗？

**核心结论**：不会。`orTimeout` / `completeOnTimeout` 只是让 **Future 提前完成**，正在执行的下游调用不会被中断，IO 线程和连接仍被占用；`CompletableFuture.cancel(true)` 同样不会中断执行线程。

- 后果：慢下游持续占住线程，`ioPool` 会被逐渐占满
- 解决：HTTP / RPC 客户端本身必须设置连接和读超时，且**不大于**这里的超时预算

→ 详见 [异步与批量](/high-perf/8_async_batch)

### Q21：什么是对冲请求（Hedged Request）？有什么使用前提？

**核心结论**：先向一个副本发请求，超过阈值（常取该接口 P95）仍未返回，就向另一个副本再发一份，取先返回的结果。只额外增加少量请求（阈值取 P95 时理论上约 5%），却能显著削掉长尾，思路来自 Google 的 The Tail at Scale。

| 前提 | 说明 |
|------|------|
| 只用于幂等、无副作用的读 | 写请求重复发送会造成重复副作用 |
| 下游能路由到不同副本 | 两次落到同一台慢节点没有意义 |
| 延迟阈值取 P95 左右 | 太早会成倍放大下游流量，太晚削不掉长尾 |
| 控制总量 | 下游整体过载时对冲加剧拥塞，设对冲比例上限，与重试共用重试预算，配合熔断限流 |

- 优先用框架能力，如 gRPC 的 `hedgingPolicy`

→ 详见 [异步与批量](/high-perf/8_async_batch)、[性能分析方法论](/high-perf/2_methodology)

### Q22：什么是请求合并？适合什么场景，有什么代价？

**核心结论**：把一个短窗口（如 10ms）内的**不同 key** 单查请求收集起来，合并成一次批量查询，再把结果分发回各调用方，下游调用次数从 N 降到 N / 批大小。代价是每个调用方多等"**窗口等待 + 批量加载耗时**"。

| 维度 | 说明 |
|------|------|
| 适用 | QPS 高、下游有批量接口、对几毫秒延迟不敏感 |
| 不适用 | QPS 低（凑不满批，只增加延迟）、强实时场景 |
| 实现要点 | 有界队列、达到 `maxBatch` 立即触发、批量加载放独立线程池、不存在的 key 显式返回空、调用方设超时 |

- 与 SingleFlight 的区别：SingleFlight 合并**相同 key** 的并发请求（防击穿），请求合并针对**不同 key** 的批量化，见 [高并发 Q32](./13_high_con)
- 成熟实现可参考 `java-dataloader`

→ 详见 [异步与批量](/high-perf/8_async_batch)

### Q23：什么是零拷贝？Kafka 为什么吞吐量高？开启 TLS 后有什么影响？

**核心结论**：零拷贝让数据**不经过用户态加工**、减少内核与用户态之间的拷贝，只在"大块数据原样搬运"时收益明显。Kafka 高吞吐来自顺序追加写 + 页缓存 + 批量与压缩 + 分区并行，消费发送时用 `sendfile` 零拷贝。开启 TLS 后数据必须在用户态加密，**Broker 无法再用 sendfile 向消费者发送**，吞吐明显下降。

| 方案 | Java API | 适用 | 典型应用 |
|------|----------|------|---------|
| 内存映射 `mmap` | `FileChannel.map()` | 需要在用户态读写文件内容 | RocketMQ CommitLog |
| 文件直传 `sendfile` | `FileChannel.transferTo()` | 文件内容不加工、直接发往 Socket | Kafka 消费发送、Nginx 静态文件、Netty `FileRegion` |

- Netty 启用 `SslHandler` 后同样要改用 `ChunkedWriteHandler` 分块发送
- 直接内存、`CompositeByteBuf` 属于**用户态少拷贝**，不是操作系统零拷贝
- 普通 JSON 接口要经过业务处理和序列化，用不上零拷贝

→ 详见 [IO 与网络优化](/high-perf/9_io_network)、[IO / NIO 专题](/java/18_topic_io)

### Q24：HTTP/1.1、HTTP/2、HTTP/3 在连接复用上有什么区别？

**核心结论**：HTTP/1.1 靠 Keep-Alive 复用连接，但一个连接同时只能处理一个请求；HTTP/2 单连接多路复用多个流，仍有 TCP 层队头阻塞；HTTP/3 基于 QUIC（UDP）多路复用，解决了 TCP 层队头阻塞。

| 特性 | HTTP/1.1 | HTTP/2 | HTTP/3 |
|------|----------|--------|--------|
| 连接复用 | Keep-Alive，串行 | 单连接多路复用 | QUIC 多路复用 |
| 队头阻塞 | 应用层 | 解决应用层，仍有 TCP 层 | 解决 TCP 层 |
| 头部压缩 | 无 | HPACK | QPACK |
| 典型用途 | 大多数内部 REST | gRPC、浏览器、网关 | 移动端弱网、CDN 边缘 |

- 复用连接是最便宜的网络优化：TLS 1.2 短连接每次多 3 个 RTT 握手，跨地域 RTT 30ms 时仅建连就 90ms
- 服务间 HTTP/1.1 调用用连接池 + Keep-Alive；高频内部调用可考虑 gRPC（HTTP/2 + Protobuf）

→ 详见 [IO 与网络优化](/high-perf/9_io_network)

---

## 六、数据访问

### Q25：慢 SQL 如何发现、分析和优化？为什么要按总耗时排序？

**核心结论**：慢 SQL 治理是"发现 → 聚合排序 → 分析 → 优化 → 验证 → 预防"的闭环。按**总耗时（次数 × 单次耗时）**排序，是因为数据库压力由总消耗决定，高频的中等慢 SQL 往往比偶发的极慢 SQL 危害更大。

| 阶段 | 手段 |
|------|------|
| 发现 | `slow_query_log=ON`、`long_query_time=0.5`；APM 中的 SQL 耗时 |
| 聚合排序 | `pt-query-digest` 按总耗时排序 |
| 分析 | `EXPLAIN` / `EXPLAIN ANALYZE`（8.0.18+）：访问类型、索引、扫描行数、filesort / 临时表 |
| 优化 | 加索引、调整联合索引顺序、消除函数与隐式转换、改写或拆分 SQL |
| 验证与预防 | 对比执行计划与耗时；上线前 SQL 审核、慢 SQL 告警 |

- 例：单次 2 秒、每天 10 次的报表 SQL，远不如单次 20ms、每秒 500 次的列表查询压力大
- 高频 N+1 查询单次很快，调低 `long_query_time` 采样后按总耗时才能发现

→ 详见 [数据访问性能](/high-perf/10_db_performance)

### Q26：深分页为什么慢？有哪些优化方案？游标分页需要什么索引？

**核心结论**：`LIMIT offset, n` 要先读出 offset + n 行再丢弃前 offset 行（非覆盖索引时还要回表），偏移越大越慢。首选游标（Seek）分页；必须跳页时用延迟关联。

| 方案 | 做法 | 局限 |
|------|------|------|
| 游标 / Seek 分页 | 记录上一页最后一条的排序值和 id，`(create_time, id) < (?, ?)` 语义的条件 + `LIMIT n` | 不支持随机跳页 |
| 延迟关联 | 子查询先在覆盖索引上查出 n 个主键，再关联回表 | 仍要扫描 offset 行索引，只省掉回表 |
| 限制最大页数 | 产品只允许翻前 N 页 | 需要产品配合 |
| 搜索引擎 | ES `search_after` | 引入数据同步 |

- **索引**：过滤列 + 排序列的联合索引即可，如 `WHERE user_id = ? ORDER BY create_time DESC` 建 `(user_id, create_time)`；InnoDB 二级索引叶子节点自带主键 id 且作为最后一个排序维度，复合游标可直接利用
- 排序值不唯一时必须带上 id 组成复合游标，否则翻页重复或遗漏
- 批量导出、数据迁移等全量遍历一律按主键游标：`WHERE id > ? ORDER BY id LIMIT 1000`

→ 详见 [数据访问性能](/high-perf/10_db_performance)、[MySQL 索引](/database/1_mysql/4_topic_index)

### Q27：JDBC 批量插入为什么没有变快？`rewriteBatchedStatements` 的作用是什么？

**核心结论**：真正的批量写入要同时满足三个条件：**批量 API + 驱动改写 + 分批提交事务**。MySQL 驱动默认即使调用 `executeBatch()` 也逐条发送，`rewriteBatchedStatements=true` 让驱动把一批 `INSERT` 改写成多值 `INSERT` 一次发送，才真正省掉 N 次网络往返。

| 条件 | 说明 |
|------|------|
| 批量 API | `addBatch()` / `executeBatch()`、MyBatis `ExecutorType.BATCH`、JPA `hibernate.jdbc.batch_size` |
| 驱动改写 | URL 加 `rewriteBatchedStatements=true` |
| 事务分批 | 关闭自动提交，每 500～1000 行提交一次 |

- 改写后的语句总长受 `max_allowed_packet` 限制；一次提交几十万行会导致长时间锁、主从延迟
- Hibernate 使用 `GenerationType.IDENTITY` 主键时无法批量插入
- MyBatis `foreach` 拼超长 SQL 解析开销大，大批量优先用 BATCH 执行器

→ 详见 [数据访问性能](/high-perf/10_db_performance)、[MySQL JDBC 驱动要点](/database/6_reference/2_jdbc_driver)

### Q28：什么是 N+1 查询问题？如何发现和解决？

**核心结论**：先查出 N 条主记录，再对每条单独查一次关联数据，共 1 + N 次查询。最通用的解法是**先收集 id，用 `IN` 批量查询后在内存中组装**，查询次数降为 2。

| 解法 | 适用 |
|------|------|
| `IN` 批量查询 + 内存组装 | 最通用，适合跨表、跨服务 |
| JOIN 一次查出 | 一对一或一对少 |
| JPA `JOIN FETCH` / `@EntityGraph` | JPA 项目；一对多 fetch 与分页同时用会在内存中分页 |
| Hibernate `@BatchSize` | 懒加载时按批加载关联集合 |

- 隐蔽来源：JPA `@OneToMany` 懒加载在循环中访问、MyBatis 嵌套 `select` 关联、循环调用单条 RPC
- 发现：统计单请求 SQL 条数、APM 链路中观察重复 SQL、Hibernate Statistics

→ 详见 [数据访问性能](/high-perf/10_db_performance)

### Q29：`IN` 列表过长会带来什么问题？

**核心结论**：SQL 变长、解析与传输开销上升，更关键的是**执行计划可能变差**：值个数超过阈值后优化器改用统计信息估算，甚至放弃 range 访问退化为全表扫描。按几百个一批分批查询。

- 超过 `eq_range_index_dive_limit`（默认 200）后，优化器不再逐个 index dive，改用索引统计估算行数，估算偏差可能选错索引
- 范围分析所需内存超过 `range_optimizer_max_mem_size`（默认 8MB）时放弃 range 访问
- 批量接口、请求合并同样要限制单批上限

→ 详见 [数据访问性能](/high-perf/10_db_performance)

---

## 七、综合案例

### Q30：讲一次你做过的接口性能优化：如何定目标、建基线、定位和验证？

**核心结论**：按"**定 SLO → 建基线 → 自顶向下定位 → 一次只改一项 → 压测验证 → 灰度与防回归**"讲，每一步都有数据。以下单接口为例（示例数据）：P99 800ms，目标单实例 300 QPS 下 P99 ≤ 250ms、错误率 < 0.1%。

| 阶段 | 做法与发现 |
|------|-----------|
| 基线 | 固定脚本、数据量、环境，预热后取稳态：P99 800ms，错误全是获取连接超时，单请求 26 条 SQL |
| 定位 | Trace 看时间分布（三段 RPC 串行、逐条查 SKU）→ wall 火焰图显示在等 Socket 与 `getConnection` → 慢日志按总耗时发现 N+1 → Little 定律：300 × 0.11s ≈ 33 个连接 > 池 20 |
| 优化 | N+1 批量化 → 事务内 RPC 移出（改可靠消息）→ 独立调用并行化 → 读多写少数据本地缓存 → 日志瘦身与异步 |
| 结果 | P99 800ms → 195ms，错误率 0.3% → 0.02%，pending 峰值 15 → 0 |

- 收益最大的是"减少等待"类改动（批量化、RPC 移出事务），而不是调 GC 或加大连接池
- 讲清"没做什么"同样加分：JFR 显示 GC 不是瓶颈，所以没调 GC；Little 定律说明问题在持有时间，所以没加大池子

→ 详见 [端到端优化案例](/high-perf/11_case_study)

### Q31：如何证明一项优化确实有效，而不是环境波动？

**核心结论**：**控制变量 + 看分布 + 看误差**。同一环境、同一脚本、同一数据量，预热后取稳态，一次只改一个变量，并确认差异大于测量波动。

- **压测对比**：对比 P50 / P99 / P999 与资源使用率，而不是只看平均值；多次重复，逐步加压看拐点是否右移
- **微基准**：纯 CPU 改动用 JMH 单独验证，两组 `Score ± Error` 区间重叠说明差异不显著
- **归因**：每项改动单独压测，收益才能对应到具体改动
- **看副作用**：数据库 CPU、下游 QPS、缓存命中率、错误率有没有被转移或恶化
- **线上验证**：先灰度 1 个实例，与其他实例的 P99、错误率同时段对比

→ 详见 [端到端优化案例](/high-perf/11_case_study)、[性能分析方法论](/high-perf/2_methodology)

### Q32：优化上线后，如何防止性能回归？

**核心结论**：把性能基线纳入流程，让回归**在发布前被拦住、在上线后被及时发现**。

| 手段 | 做法 |
|------|------|
| 发布前检查 | 核心接口压测结果作为发布检查项，P99 劣化超过阈值阻断 |
| CI 基准 | 关键热点方法的 JMH 基准纳入 CI，对比历史结果 |
| 灰度对比 | 灰度实例与基线版本对比 P99、错误率，异常自动暂停 |
| 持续监控 | P99 超出 SLO、连接池 pending > 0 等持续 1 分钟即告警 |
| 记录沉淀 | 记录每次实验（包括无效尝试），复盘清单纳入评审 |

→ 详见 [端到端优化案例](/high-perf/11_case_study)
