# 并发参数调优

> 参考链接：[计算线程池场景分析](https://zhuanlan.zhihu.com/p/116426107) · [HikariCP - About Pool Sizing](https://github.com/brettwooldridge/HikariCP/wiki/About-Pool-Sizing) · [Spring Boot 服务器配置项](https://docs.spring.io/spring-boot/appendix/application-properties/index.html#appendix.application-properties.server)

一个请求从进入服务器到返回，要依次经过 **OS 连接队列 → Web 容器线程 → 业务线程池 → 连接池（DB / Redis / HTTP）**。任何一层的参数与流量不匹配，都会成为瓶颈：配小了资源闲置、请求排队；配大了上下文切换、内存暴涨、把下游压垮。调优的目标是让各层容量**逐级匹配**。

---

## 一、线程池参数调优

> `ThreadPoolExecutor` 的构造参数、执行流程、队列与拒绝策略见 [Java 专项 - 线程池](/java/28_topic_thread_pool)。

**CPU 密集型**（大量计算，几乎不阻塞）：
```
线程数 = CPU 核心数 + 1
```
多余 1 个线程是为了应对偶发的线程中断/等待，让 CPU 始终保持满载。

**IO 密集型**（大量等待，如数据库、网络调用）：
```
线程数 = CPU 核心数 × (1 + 等待时间 / 计算时间)
```
若等待时间 / 计算时间 = 9（即 90% 时间在等待），则 8 核 CPU 可设 80 个线程。

**实际推荐做法**：
1. 通过压测找到系统 TPS 和响应时间的最优平衡点
2. 参考 Little's Law：`并发数 = QPS × 平均响应时间`
3. 使用动态线程池（如 [DynamicTP](https://dynamictp.cn/)）在不重启的情况下动态调整参数

```java
// 常见生产配置模板（LoggingRejectionHandler 见 Java 专项 - 线程池 的拒绝策略一节）
ThreadPoolExecutor executor = new ThreadPoolExecutor(
    Runtime.getRuntime().availableProcessors() * 2,  // corePoolSize
    Runtime.getRuntime().availableProcessors() * 4,  // maximumPoolSize
    60L, TimeUnit.SECONDS,
    new ArrayBlockingQueue<>(500),                    // 有界队列，防 OOM
    new ThreadFactoryBuilder()
        .setNameFormat("order-pool-%d")               // 线程名带业务前缀，便于 jstack 排查
        .setDaemon(false)
        .build(),
    new LoggingRejectionHandler()
);
```

**补充：队列长度与超时的关系**。队列不是越大越好：若单任务耗时 100ms、20 个线程，队列 500 意味着最后一个任务要等 `500 / 20 × 100ms = 2.5s` 才开始执行，可能早已超过调用方超时。队列长度应满足 `队列长度 ≤ 线程数 × (可接受排队时间 / 任务耗时)`。

---

## 二、Web 容器参数

### 1、Tomcat

Spring Boot 内嵌 Tomcat（NIO Connector）的请求处理分三段：OS 全连接队列 → Acceptor 接收连接 → Poller 监听可读 → 工作线程处理。

| 参数 | 默认值 | 含义 | 调优建议 |
|------|--------|------|----------|
| `server.tomcat.threads.max` | 200 | 最大工作线程数 | IO 密集型按 Little's Law 估算，通常 200 ~ 800；过大导致上下文切换 |
| `server.tomcat.threads.min-spare` | 10 | 最小空闲线程 | 高峰突发明显时调大，减少线程创建延迟 |
| `server.tomcat.max-connections` | 8192 | 最大连接数（NIO） | 长连接多时调大；超过后新连接进入 accept 队列 |
| `server.tomcat.accept-count` | 100 | 连接数达上限后的等待队列（映射到 `listen` backlog） | 受 `somaxconn` 限制；太大只会让客户端等待更久 |
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

**三者关系**：请求依次被 `threads.max` 处理 → 线程满时连接仍被接收并等待（直到 `max-connections`）→ 连接满时进入 OS 队列（`accept-count`）→ 队列满则客户端连接被拒绝或超时。

### 2、Undertow

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `server.undertow.threads.io` | CPU 核数 | IO 线程（非阻塞），一般不改 |
| `server.undertow.threads.worker` | io × 8 | 阻塞工作线程，对应 Tomcat 的 `threads.max` |
| `server.undertow.buffer-size` | 依内存而定 | 每个缓冲区大小，一般 16KB |
| `server.undertow.direct-buffers` | 依内存而定 | 使用堆外内存，减少拷贝 |

### 3、虚拟线程（JDK 21+）

Spring Boot 3.2+ 配置 `spring.threads.virtual.enabled=true` 后，Tomcat 使用虚拟线程处理请求，`threads.max` 不再是并发上限。此时瓶颈转移到**下游连接池**，必须用连接池大小或信号量限制并发，否则会瞬间耗尽 DB 连接。

---

## 三、数据库连接池

连接池不是越大越好。数据库端每个连接都有内存和上下文开销，并发执行的 SQL 数量受 CPU 核数与磁盘限制，连接数过多反而导致锁竞争与吞吐下降。

**HikariCP 经验公式**（针对单个数据库）：

```
连接数 = (CPU 核心数 × 2) + 有效磁盘数
```

**全局视角**：`所有应用实例连接池 maximumPoolSize 之和 ≤ 数据库 max_connections × 80%`。例如 MySQL `max_connections=2000`，服务 40 个实例，则单实例池最大约 40。水平扩容前必须重新核算。

```yaml
spring:
  datasource:
    hikari:
      maximum-pool-size: 30
      minimum-idle: 30              # 与 max 相同，固定大小，避免高峰临时建连
      connection-timeout: 3000      # 获取连接超时 3s，快速失败优于长时间阻塞
      max-lifetime: 1800000         # 小于 MySQL wait_timeout
      idle-timeout: 600000
```

连接池原理与参数详解见 [池化技术](/high-perf/5_pooling) 与 [数据库连接池](/database/5_practice/3_connection_pool)。

---

## 四、Redis 客户端连接池

| 客户端 | 连接模型 | 调优要点 |
|--------|----------|----------|
| Lettuce（Spring Boot 默认） | 基于 Netty，单连接多路复用，线程安全 | 默认共享单连接即可支撑高 QPS；有阻塞命令（`BLPOP`）或事务时才需要连接池 |
| Jedis | 阻塞 IO，一连接一请求 | 必须用连接池，`maxTotal` ≈ 业务线程并发访问 Redis 的峰值 |
| Redisson | 基于 Netty，内置连接池 | 调整 `connectionPoolSize`、`connectionMinimumIdleSize` |

```yaml
spring:
  data:
    redis:
      timeout: 500ms                  # 命令超时，Redis 应该很快，超时设短
      lettuce:
        pool:                         # 需引入 commons-pool2 才生效
          enabled: true
          max-active: 64
          max-idle: 64
          min-idle: 16
          max-wait: 200ms
```

---

## 五、OS 层参数

| 参数 | 作用 | 常见问题 | 建议值 |
|------|------|----------|--------|
| `ulimit -n`（nofile） | 进程最大文件描述符（每个连接占一个） | `Too many open files` | 65535 ~ 1048576 |
| `net.core.somaxconn` | 全连接队列上限，截断应用的 backlog | `accept-count` 配置不生效，高峰丢连接 | 4096 ~ 65535 |
| `net.ipv4.tcp_max_syn_backlog` | 半连接队列上限 | SYN 洪峰时丢连接 | 8192 以上 |
| `net.ipv4.ip_local_port_range` | 作为客户端时可用的本地端口 | 大量短连接调用下游导致端口耗尽 | `1024 65535` |
| `net.ipv4.tcp_tw_reuse` | 允许复用 TIME_WAIT 连接（仅客户端方向） | TIME_WAIT 过多占满端口 | 1 |
| `net.ipv4.tcp_fin_timeout` | FIN_WAIT_2 超时 | 连接关闭慢 | 15 ~ 30 |

```bash
# 查看全连接队列溢出次数（持续增长说明 accept 队列不够或应用处理不过来）
netstat -s | grep -i "listen"
# 查看各状态连接数
ss -ant | awk '{print $1}' | sort | uniq -c
```

**TIME_WAIT 过多的根因通常是短连接**：调用下游 HTTP 未使用连接池、未开启 Keep-Alive。应优先修复连接复用，而不是只调内核参数。容器环境下部分参数需通过 Pod `securityContext.sysctls` 设置。Linux 运维基础见 [Linux](/cloud-native/1_linux)。

---

## 六、调优流程

调优必须基于数据，不要凭感觉改参数：

| 步骤 | 做法 | 产出 |
|------|------|------|
| 1. 建立基线 | 在与生产一致的环境压测当前配置 | 当前最大 QPS、P99、资源使用率 |
| 2. 阶梯压测 | 逐步增加并发，直到 RT 陡增或错误率上升 | 拐点 QPS（系统最佳容量点） |
| 3. 定位瓶颈 | 观察 CPU、线程池活跃数/队列、连接池等待数、GC、下游 RT | 瓶颈所在层 |
| 4. 单点调整 | **每次只改一个参数**，重新压测对比 | 参数与效果的对应关系 |
| 5. 固化与监控 | 写入配置，上线后监控水位；使用动态线程池以便线上微调 | 可回溯的配置变更 |

**常见瓶颈信号**：

| 现象 | 可能瓶颈 |
|------|----------|
| CPU 低、RT 高、Tomcat 线程全忙 | 下游慢（DB、RPC），线程在等 IO |
| 连接池等待数 > 0 且持续 | 连接池太小，或慢 SQL 长期占用连接 |
| CPU 高、GC 频繁 | 对象分配过多，见 JVM 调优 |
| 线程数很多、CPU sys 态高 | 线程过多，上下文切换开销大 |
| 连接被拒、客户端 connect timeout | accept 队列 / somaxconn 过小 |

压测工具与方法见 [性能测试](/testing/7_performance_test)，JVM 与代码层面的优化见 [高性能](/high-perf/0_overview)。
