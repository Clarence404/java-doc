---
description: 线程池、Web 容器、数据库 / Redis 连接池、OS 参数、调优流程
---

# 并发参数调优

> 前置阅读：[热点问题](./6_hotspot)

一个请求依次经过 **OS 连接队列 → Web 容器线程 → 业务线程池 → 连接池（DB / Redis / HTTP）**，任何一层与流量不匹配都会成为瓶颈，**调优的目标是让各层容量逐级匹配，并且每一层都有上限**。本篇讲线程数估算、Web 容器与客户端连接池配置、OS 参数调整，以及数据驱动的调优流程。

---

## 一、线程池参数调优

**线程数先用公式估一个起点，再用压测找到最优点，上线后用动态线程池微调。** `ThreadPoolExecutor` 的构造参数、执行流程、队列与拒绝策略见 [线程池](/java/28_topic_thread_pool)。

各层的关键参数与本篇位置：

| 层 | 关键参数 | 本篇位置 |
|----|---------|---------|
| 业务线程池 | core / max / 队列长度 | 第一节 |
| Web 容器 | `threads.max`、`max-connections`、`accept-count` | 第二节 |
| 数据库连接池 | 全局连接数上限 | 第三节 |
| Redis 客户端 | 连接模型与池 | 第四节 |
| OS | 文件描述符、连接队列、本地端口 | 第五节 |

### 1、线程数估算

| 任务类型 | 估算公式 | 说明 |
|---------|---------|------|
| CPU 密集型 | `线程数 = CPU 核数 + 1` | 多 1 个线程应对偶发的缺页、中断，让 CPU 保持满载 |
| IO 密集型 | `线程数 = CPU 核数 × (1 + 等待时间 / 计算时间)` | 等待 / 计算 = 9 时，8 核约 80 个线程 |
| 按流量反推 | `线程数 ≈ 目标 QPS × 单任务平均耗时` | Little 定律，如 1000 QPS × 50ms ≈ 50 个线程 |

公式只是起点：等待时间与计算时间的比例很难准确测量，且下游（DB、RPC）的承载能力往往先于 CPU 到顶。**最终以阶梯压测的拐点为准**，线上用动态线程池（如 [DynamicTP](https://dynamictp.cn/)）在不重启的情况下调整。Little 定律的推导见 [性能指标](/high-perf/1_metrics)。

### 2、生产配置模板

```java
// ThreadFactoryBuilder 来自 Guava；LoggingRejectionHandler 见「线程池」一文的拒绝策略一节
int cpu = Runtime.getRuntime().availableProcessors();
ThreadPoolExecutor executor = new ThreadPoolExecutor(
        cpu * 2,                                      // corePoolSize
        cpu * 4,                                      // maximumPoolSize
        60L, TimeUnit.SECONDS,
        new ArrayBlockingQueue<>(500),                // 有界队列，防 OOM
        new ThreadFactoryBuilder()
                .setNameFormat("order-pool-%d")       // 线程名带业务前缀，便于 jstack 排查
                .build(),
        new LoggingRejectionHandler());
```

::: warning 队列满了才会扩到 max
JDK 线程池的顺序是：核心线程满 → **任务进队列** → 队列满 → 才创建非核心线程直到 max → 仍满则拒绝。上面的模板中，只有 500 个任务排满后线程数才会从 `2N` 增长到 `4N`，此时排队延迟往往已经超过调用方超时。

- 希望"先加线程再排队"：调小队列，或令 `core = max` 并开启 `allowCoreThreadTimeOut(true)` 回收空闲线程
- Tomcat 的工作线程池使用自定义的 `TaskQueue`，行为相反：线程数未到 `threads.max` 时优先创建线程，而不是先排队
:::

### 3、队列长度与超时

**队列不是越大越好，排队时间必须小于调用方超时。** 单任务耗时 100ms、20 个线程、队列 500 时，队尾任务要等 `500 / 20 × 100ms = 2.5s` 才开始执行，可能早已超时，执行了也是白做。

队列长度的上限可按 `队列长度 ≤ 线程数 × (可接受排队时间 / 单任务耗时)` 估算：上例若只能接受 500ms 排队，队列应 ≤ `20 × 500 / 100 = 100`。

---

## 二、Web 容器参数

**Web 容器决定"同时处理多少请求"和"还能排多少队"，两者都要有上限。**

### 1、Tomcat

Spring Boot 内嵌 Tomcat（NIO Connector）的请求处理分四段：OS 全连接队列 → Acceptor 接收连接 → Poller 监听可读事件 → 工作线程处理请求。

| 参数 | 默认值 | 含义 | 调优建议 |
|------|--------|------|----------|
| `server.tomcat.threads.max` | 200 | 最大工作线程数 | IO 密集型按 Little 定律估算，通常 200 ~ 800；过大导致上下文切换 |
| `server.tomcat.threads.min-spare` | 10 | 最小空闲线程 | 高峰突发明显时调大，减少线程创建延迟 |
| `server.tomcat.max-connections` | 8192 | 最大连接数（NIO） | 长连接多时调大；达到上限后新连接停留在 OS 队列 |
| `server.tomcat.accept-count` | 100 | OS 全连接队列长度（映射到 `listen` backlog） | 受 `somaxconn` 截断；太大只会让客户端等更久 |
| `server.tomcat.connection-timeout` | 60s（Connector 默认） | 建立连接后等待请求数据的超时 | 建议 5 ~ 10s，防慢连接占用 |
| `server.tomcat.keep-alive-timeout` | 同 connection-timeout | Keep-Alive 空闲超时 | 网关后面可适当调大，复用连接 |
| `server.tomcat.max-keep-alive-requests` | 100 | 单个长连接最多处理的请求数 | 高 QPS 下调大（如 1000）减少重建 |

```yaml
server:
  tomcat:
    threads:
      max: 400
      min-spare: 50
    max-connections: 10000
    accept-count: 500
    connection-timeout: 5s
    keep-alive-timeout: 30s
    max-keep-alive-requests: 1000
```

**三者关系**：请求由最多 `threads.max` 个线程处理 → 线程全忙时连接仍被接收并等待，直到连接数达到 `max-connections` → 之后新连接停留在 OS 全连接队列（长度 `accept-count`）→ 队列也满则客户端连接被拒绝或超时。

### 2、Undertow（仅 Spring Boot 3.x）

::: warning
Spring Boot 4.0 已移除内嵌 Undertow 支持，以下参数只适用于 Spring Boot 3.x；新项目建议使用 Tomcat 或 Jetty。
:::

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `server.undertow.threads.io` | CPU 核数（至少 2） | 非阻塞 IO 线程，一般不改 |
| `server.undertow.threads.worker` | io × 8 | 阻塞工作线程，对应 Tomcat 的 `threads.max` |
| `server.undertow.buffer-size` | 依 JVM 可用内存而定 | 每个缓冲区大小，建议显式设置（如 16KB） |
| `server.undertow.direct-buffers` | 依 JVM 可用内存而定 | 是否使用堆外缓冲区 |

### 3、虚拟线程（JDK 21+）

Spring Boot 3.2+ 配置 `spring.threads.virtual.enabled=true` 后，Tomcat 为每个请求使用虚拟线程，`threads.max` 不再是并发上限。

- **`max-connections` 仍然生效**，它成为容器层唯一的并发闸门
- 瓶颈转移到**下游连接池**：必须用连接池大小或信号量限制对下游的并发，否则会瞬间耗尽 DB 连接
- JDK 21–23 中虚拟线程在 `synchronized` 块内阻塞会钉住载体线程，这些版本的热点路径改用 `ReentrantLock`；JDK 24（JEP 491）起不再钉住，详见 [虚拟线程](/java/30_topic_virtual_thread)

---

## 三、数据库连接池

**扩容时必须核算的是全局上限：`所有应用实例 maximumPoolSize 之和 ≤ 数据库 max_connections × 80%`。** 剩下 20% 留给 DBA 运维、监控、定时任务与故障时的连接重建。

- 这是**上限，不是目标值**：MySQL `max_connections=2000`、服务 40 个实例时，单实例池**最多** 40；实际大小应按 Little 定律与压测确定，通常远小于上限（单实例 QPS 500、每次持有连接 10ms，平均只需约 5 个连接）
- **水平扩容前重新核算**：实例数从 40 扩到 80，单实例池不调小就会超过上限，新实例启动即报 `Too many connections`
- 多个服务共用一个库时，上限要在各服务之间分配，而不是每个服务都按全量计算

连接池为什么不是越大越好、HikariCP 经验公式（公式中的核数是**数据库服务器**的核数，算出的是数据库侧总连接数）、泄漏检测见 [池化技术](/high-perf/7_pooling)；Hikari 参数表与完整配置见 [数据库连接池](/database/5_practice/3_connection_pool)。

---

## 四、Redis 客户端连接池

**先看客户端的连接模型，再决定要不要池：Lettuce 共享连接即可扛高 QPS，Jedis 必须用池。**

| 客户端 | 连接模型 | 调优要点 |
|--------|----------|----------|
| Lettuce（Spring Boot 默认） | 基于 Netty，单连接多路复用，线程安全 | 默认共享一条连接；阻塞命令、事务才需要池 |
| Jedis | 阻塞 IO，一个连接同时只能处理一个请求 | 必须用连接池，`maxTotal` ≈ 并发访问 Redis 的线程峰值 |
| Redisson | 基于 Netty，内置连接池 | 调整 `connectionPoolSize`、`connectionMinimumIdleSize` |

```yaml
spring:
  data:
    redis:
      timeout: 500ms                  # 命令超时：Redis 应该很快，超时设短
      lettuce:
        pool:                         # 需引入 commons-pool2 才生效
          enabled: true
          max-active: 16
          max-idle: 16
          min-idle: 4
          max-wait: 200ms
```

::: warning Lettuce 开了池，普通命令也不走池
Spring Data Redis 的 `LettuceConnectionFactory` 默认 `shareNativeConnection = true`：即使配置了连接池，普通的 `GET` / `SET` 等非阻塞、非事务命令**仍然走同一条共享连接**，`max-active` 对它们基本不起作用。池只在以下情况被使用：

- 阻塞命令（`BLPOP`、`BRPOP`、`XREAD BLOCK` 等），避免阻塞共享连接
- 事务（`MULTI` / `EXEC`、`WATCH`），需要独占连接
- 显式调用 `setShareNativeConnection(false)` 后，所有操作都从池中借连接

因此排查 Redis 慢时，先看共享连接上的命令延迟与大 key，而不是一味调大 `max-active`。
:::

---

## 五、OS 层参数

**高并发下 OS 默认值往往先成为瓶颈：文件描述符、连接队列、本地端口。**

| 参数 | 作用 | 常见问题 | 建议值 |
|------|------|----------|--------|
| `ulimit -n`（nofile） | 进程最大文件描述符（每个连接占一个） | `Too many open files` | 65535 ~ 1048576 |
| `net.core.somaxconn` | 全连接队列上限，截断应用的 backlog | `accept-count` 配置不生效，高峰丢连接 | 4096 ~ 65535（Linux 5.4 起默认 4096，之前为 128） |
| `net.ipv4.tcp_max_syn_backlog` | 半连接队列上限 | SYN 洪峰时丢连接 | 8192 以上 |
| `net.ipv4.ip_local_port_range` | 作为客户端时可用的本地端口 | 大量短连接调用下游导致端口耗尽 | `10000 65535` |
| `net.ipv4.ip_local_reserved_ports` | 从本地端口范围中排除的端口 | 本机监听端口被出站连接占用，服务启动失败 | 列出本机监听端口，如 `18080,30000-32767` |
| `net.ipv4.tcp_tw_reuse` | 出站连接复用 TIME_WAIT 端口（依赖 `tcp_timestamps`） | TIME_WAIT 过多占满端口 | 1（较新内核默认 2，仅对回环生效） |
| `net.ipv4.tcp_fin_timeout` | FIN_WAIT_2 超时 | 连接关闭慢 | 15 ~ 30 |

::: tip
端口范围不要从 1024 开始：本机服务监听的端口一旦落在范围内，就可能被出站连接先占用。把范围起点提到 10000，并用 `ip_local_reserved_ports` 保留范围内仍需监听的端口。`tcp_tw_recycle` 在 NAT 环境下会导致丢包，Linux 4.12 已移除，不要再配置。
:::

```bash
# 查看全连接队列溢出次数（持续增长说明 accept 队列不够或应用处理不过来）
netstat -s | grep -i "listen"
# 查看各状态连接数
ss -ant | awk '{print $1}' | sort | uniq -c
```

**TIME_WAIT 过多的根因通常是短连接**：调用下游 HTTP 未使用连接池、未开启 Keep-Alive。应优先修复连接复用，而不是只调内核参数。容器环境下部分参数需通过 Pod `securityContext.sysctls` 设置。Linux 运维基础见 [Linux](/cloud-native/1_linux)。

---

## 六、调优流程

**调优必须基于数据：建基线、阶梯压测、定位瓶颈、每次只改一个参数。**

| 步骤 | 做法 | 产出 |
|------|------|------|
| 1. 建立基线 | 在与生产一致的环境压测当前配置 | 当前最大 QPS、P99、资源使用率 |
| 2. 阶梯压测 | 逐步增加并发，直到 RT 陡增或错误率上升 | 拐点 QPS（系统最佳容量点） |
| 3. 定位瓶颈 | 观察 CPU、线程池活跃数 / 队列、连接池等待数、GC、下游 RT | 瓶颈所在层 |
| 4. 单点调整 | **每次只改一个参数**，重新压测对比 | 参数与效果的对应关系 |
| 5. 固化与监控 | 写入配置，上线后监控水位；使用动态线程池以便线上微调 | 可回溯的配置变更 |

**常见瓶颈信号**：

| 现象 | 可能瓶颈 |
|------|----------|
| CPU 低、RT 高、Tomcat 线程全忙 | 下游慢（DB、RPC），线程在等 IO |
| 连接池等待数持续 > 0 | 连接池太小，或慢 SQL 长期占用连接 |
| CPU 高、GC 频繁 | 对象分配过多，见 [JVM 层性能策略](/high-perf/5_jvm_tuning) |
| 线程数很多、CPU sys 态高 | 线程过多，上下文切换开销大 |
| 连接被拒、客户端 connect timeout | accept 队列 / `somaxconn` 过小 |

压测工具与方法见 [性能测试](/testing/7_performance_test)，定位瓶颈的工具见 [性能分析工具](/high-perf/3_profilers)。

---

## 小结

- 请求依次经过 OS 队列 → Web 容器 → 业务线程池 → 连接池，各层容量要**逐级匹配且都有上限**
- 线程数公式只是起点，以阶梯压测拐点为准；JDK 线程池**队列满了才扩到 max**，队列长度要小于调用方可接受的排队时间
- Tomcat 看 `threads.max`、`max-connections`、`accept-count` 三道闸；开启虚拟线程后 `max-connections` 仍生效，并发要靠下游池限制
- 数据库连接池只需守住全局上限 `Σ maximumPoolSize ≤ max_connections × 80%`，扩容前重新核算；Lettuce 默认共享连接，池只服务阻塞命令与事务
- OS 层重点是 nofile、`somaxconn`、本地端口范围（`10000 65535` + 保留端口）；TIME_WAIT 多先修连接复用

## 参考资料

- [HikariCP - About Pool Sizing](https://github.com/brettwooldridge/HikariCP/wiki/About-Pool-Sizing)
- [Spring Boot 服务器配置项](https://docs.spring.io/spring-boot/appendix/application-properties/index.html#appendix.application-properties.server)

> 下一篇：[容量评估与规划](./8_capacity_planning) —— 各层参数确定之后，回答"要扛多少流量、需要多少机器、如何验证与守住水位"。
