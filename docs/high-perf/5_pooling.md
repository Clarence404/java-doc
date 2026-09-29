# 池化技术

> 参考：[HikariCP - About Pool Sizing](https://github.com/brettwooldridge/HikariCP/wiki/About-Pool-Sizing)、[Apache HttpClient 5](https://hc.apache.org/httpcomponents-client-5.4.x/)、[Apache Commons Pool](https://commons.apache.org/proper/commons-pool/)

池化的本质是**用空间换时间**：预先创建一批代价高昂的资源并反复复用，把"创建 + 销毁"的成本从每次请求中移除，同时对资源总量进行上限控制。

---

## 一、为什么需要池化

| 资源 | 单次创建的开销 | 不池化的后果 |
|------|----------------|--------------|
| 数据库连接 | TCP 三次握手 + TLS + 认证 + 会话初始化，通常数毫秒到数十毫秒 | 每个请求多出数十毫秒，数据库被连接风暴打垮 |
| HTTP 连接 | TCP 握手 + TLS 握手（跨公网可达上百毫秒） | 大量 TIME_WAIT，端口耗尽 |
| 线程 | 分配栈内存、内核线程创建 | 无上限创建导致 OOM、上下文切换激增 |
| 大对象/缓冲区 | 大块内存分配与清零、GC 压力 | 频繁 GC、直接内存泄漏 |

池化带来的两个核心收益：

- **降低延迟**：借用现成资源，省去创建开销。
- **保护下游**：池的上限就是对下游的并发上限，天然起到"舱壁"作用。

---

## 二、数据库连接池

Spring Boot 2.0 起默认使用 HikariCP，以轻量、低延迟著称。HikariCP 与 Druid 的选型和完整配置见 [数据库连接池](/database/5_practice/3_connection_pool)，本节只讨论性能相关的参数与容量。

### 1、关键参数

| 参数 | 默认值 | 说明与建议 |
|------|--------|------------|
| `maximumPoolSize` | 10 | 池的最大连接数，包含空闲和使用中的连接，**最关键的参数** |
| `minimumIdle` | 等于 `maximumPoolSize` | 官方建议不设置，保持固定大小的池，避免流量突增时临时建连 |
| `connectionTimeout` | 30000 ms | 获取连接的最长等待时间；线上建议调低（如 2～5 秒），快速失败优于长时间挂起 |
| `idleTimeout` | 600000 ms | 空闲连接回收时间，仅在 `minimumIdle < maximumPoolSize` 时生效 |
| `maxLifetime` | 1800000 ms | 连接最大存活时间，**必须比数据库或中间网络设备（如 MySQL `wait_timeout`、防火墙、LB）的超时短几十秒** |
| `keepaliveTime` | 120000 ms（5.x） | 对空闲连接定期保活探测，防止被网络设备静默断开 |
| `leakDetectionThreshold` | 0（关闭） | 连接被借出超过该时长未归还时打印告警栈，用于排查连接泄漏 |

```yaml
spring:
  datasource:
    hikari:
      maximum-pool-size: 20
      connection-timeout: 3000
      max-lifetime: 1740000          # 29 分钟，小于数据库侧 30 分钟超时
      keepalive-time: 60000
      leak-detection-threshold: 20000
      pool-name: order-db-pool
```

### 2、连接数如何计算

HikariCP Wiki 给出的经验公式：

```text
connections = (core_count * 2) + effective_spindle_count

core_count：数据库服务器的 CPU 核数（不含超线程）
effective_spindle_count：有效磁盘主轴数，数据全部命中内存时为 0，SSD 可视为较小值
```

- 例如 8 核数据库服务器、数据集基本在内存中：约 16～17 个连接即可让数据库达到最佳吞吐。
- **连接池不是越大越好**：数据库的并行能力受 CPU 核数和磁盘限制，连接过多只会增加上下文切换与锁竞争，RT 反而变差。
- 这个数是**数据库侧的总连接数**：如果有 10 个应用实例，每个实例的池应约为总数除以实例数。
- 结合 Little 定律校验：单实例 QPS 500、每次持有连接 10ms，平均只需约 5 个连接。

### 3、连接泄漏检测

泄漏常见原因：手动获取连接未在 `finally` 中关闭、事务未正确结束、长时间持有连接做 RPC 调用。

- 开启 `leakDetectionThreshold`（如设为略大于最长正常 SQL 耗时），日志会输出借出连接时的调用栈。
- 监控 `hikaricp_connections_active`、`hikaricp_connections_pending`（Micrometer 自动暴露）：pending 持续大于 0 说明池不够用或连接被长期占用。
- **不要在持有连接的事务中调用外部服务**，这是连接池被耗尽最常见的原因。

慢 SQL 与连接池的配合见 [数据访问性能](/high-perf/8_db_performance)。

---

## 三、HTTP 连接池

### 1、为什么需要

HTTP/1.1 默认支持 Keep-Alive，但如果每次请求都 `new` 一个客户端或不复用连接，每次调用都要重新握手。服务间调用应**全局复用一个配置好的客户端实例**。

### 2、Apache HttpClient 5

```java
PoolingHttpClientConnectionManager cm = PoolingHttpClientConnectionManagerBuilder.create()
        .setMaxConnTotal(200)                       // 整个池的最大连接数，默认 25
        .setMaxConnPerRoute(50)                     // 每个目标主机的最大连接数，默认 5
        .setDefaultConnectionConfig(ConnectionConfig.custom()
                .setConnectTimeout(Timeout.ofSeconds(1))
                .setSocketTimeout(Timeout.ofSeconds(3))
                .setTimeToLive(TimeValue.ofMinutes(5))          // 连接最大存活时间
                .setValidateAfterInactivity(TimeValue.ofSeconds(10))
                .build())
        .build();

CloseableHttpClient client = HttpClients.custom()
        .setConnectionManager(cm)
        .setDefaultRequestConfig(RequestConfig.custom()
                .setConnectionRequestTimeout(Timeout.ofMillis(500)) // 从池中获取连接的超时
                .setResponseTimeout(Timeout.ofSeconds(3))
                .build())
        .evictIdleConnections(TimeValue.ofSeconds(30))              // 后台清理空闲连接
        .build();
```

- **`MaxConnPerRoute` 默认只有 5**，是服务间调用最常见的隐形瓶颈：调用单一下游时，并发超过 5 就开始排队。
- 三类超时要分别设置：获取连接超时、建连超时、读超时。

### 3、OkHttp

```java
OkHttpClient client = new OkHttpClient.Builder()
        .connectionPool(new ConnectionPool(50, 5, TimeUnit.MINUTES)) // 最大空闲连接数、空闲存活时间
        .connectTimeout(1, TimeUnit.SECONDS)
        .readTimeout(3, TimeUnit.SECONDS)
        .build();
client.dispatcher().setMaxRequestsPerHost(50);   // 仅影响异步调用，默认 5
```

- 默认 `ConnectionPool` 为最多 5 个空闲连接、保持 5 分钟；OkHttp 支持 HTTP/2 时同一主机复用单连接多路传输。
- `OkHttpClient` 实例应全局单例共享，每个实例都有独立的连接池和线程池。

### 4、Keep-Alive 注意事项

- 客户端空闲连接超时应**小于服务端 Keep-Alive 超时**（如 Nginx `keepalive_timeout` 默认 75s、Tomcat `keepAliveTimeout` 默认取 `connectionTimeout` 的值），否则客户端可能拿到已被服务端关闭的连接，出现 `NoHttpResponseException` / `Connection reset`。
- Nginx 作为反向代理时，需配置 `upstream { keepalive 64; }` 并设置 `proxy_http_version 1.1` 和清空 `Connection` 头，才能与后端复用长连接。

更多网络层优化见 [IO 与网络优化](/high-perf/7_io_network)。

---

## 四、线程池

线程池是最常用的池化形式，参数、执行流程和拒绝策略见 [线程池专题](/java/28_topic_thread_pool)。性能视角下需关注：

| 要点 | 说明 |
|------|------|
| 线程数估算 | CPU 密集型 ≈ 核数 + 1；IO 密集型 ≈ 核数 × (1 + 等待时间 / 计算时间) |
| 用 Little 定律校验 | 线程数 ≥ 目标 QPS × 平均 RT |
| 有界队列 | 无界队列会掩盖问题，最终 OOM；队列过长会让 RT 失控 |
| 按业务隔离 | 核心与非核心任务用不同线程池，防止相互拖累 |
| 监控 | 活跃线程数、队列长度、拒绝次数、任务耗时 |

JDK 21 的虚拟线程适合大量阻塞 IO 的场景，**虚拟线程本身不需要池化**，但仍需用信号量或连接池限制对下游的并发。容量与参数调优的系统级讨论见 [并发参数调优](/high-con/6_concurrency_tuning)、[容量评估与规划](/high-con/7_capacity_planning)。

---

## 五、对象池

### 1、Commons Pool2

Apache Commons Pool2 是通用对象池实现，Jedis、Lettuce（可选）、DBCP2 等都基于它构建：

```java
public class ParserFactory extends BasePooledObjectFactory<ExpensiveParser> {
    @Override
    public ExpensiveParser create() {
        return new ExpensiveParser();            // 创建代价高的对象
    }

    @Override
    public PooledObject<ExpensiveParser> wrap(ExpensiveParser parser) {
        return new DefaultPooledObject<>(parser);
    }

    @Override
    public void passivateObject(PooledObject<ExpensiveParser> p) {
        p.getObject().reset();                   // 归还时重置状态，避免脏数据
    }
}

GenericObjectPoolConfig<ExpensiveParser> config = new GenericObjectPoolConfig<>();
config.setMaxTotal(32);
config.setMaxIdle(16);
config.setMinIdle(4);
config.setMaxWait(Duration.ofMillis(200));
config.setTestOnBorrow(true);

GenericObjectPool<ExpensiveParser> pool = new GenericObjectPool<>(new ParserFactory(), config);

ExpensiveParser parser = pool.borrowObject();
try {
    parser.parse(input);
} finally {
    pool.returnObject(parser);                   // 必须归还，否则池会被耗尽
}
```

### 2、什么时候不该池化

| 场景 | 原因 |
|------|------|
| 普通小对象（DTO、集合、StringBuilder） | JVM TLAB 分配极快，年轻代回收几乎零成本；池化反而延长对象生命周期、增加老年代压力和同步开销 |
| 有复杂内部状态、难以可靠重置的对象 | 归还后残留状态会导致难以排查的数据串扰 |
| 并发极高且竞争激烈的场景 | 池本身的锁成为瓶颈，可改用 `ThreadLocal` 缓存每线程一份 |
| 虚拟线程 | 创建成本极低，池化违背设计初衷 |

值得池化的通常只有：**连接、线程、大块缓冲区（如 Netty 的 `PooledByteBufAllocator`）、初始化极慢的对象**。
