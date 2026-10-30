---
description: 连接池原理、HTTP 连接池、对象池
---

# 池化技术

> 前置阅读：[代码级优化](./6_code_optimization)

池化的本质是**用空间换时间**：预先创建一批代价高昂的资源并反复复用，同时给资源总量设上限。本篇讲池化的收益与代价、连接池为什么不是越大越好、HTTP 连接池配置，以及什么对象不该池化。

---

## 一、为什么需要池化

**只有创建代价高、可安全复用的资源才值得池化。** 池化带来两个收益：借用现成资源省去创建开销（降低延迟）；池的上限就是对下游的并发上限（保护下游，天然起到舱壁作用）。

| 资源 | 单次创建的开销 | 不池化的后果 |
|------|----------------|--------------|
| 数据库连接 | TCP 握手 + TLS + 认证 + 会话初始化，通常数毫秒到数十毫秒 | 每个请求多出数十毫秒，数据库被连接风暴打垮 |
| HTTP 连接 | TCP 握手 + TLS 握手（跨公网可达上百毫秒） | 大量 TIME_WAIT，端口耗尽 |
| 线程 | 分配栈内存、创建内核线程 | 无上限创建导致 OOM、上下文切换激增 |
| 大对象 / 缓冲区 | 大块内存分配与清零、GC 压力 | 频繁 GC、直接内存泄漏 |

---

## 二、连接池原理：为什么不是越大越好

**连接池大小应由"下游能并行处理多少"决定，而不是由"上游有多少请求"决定。** 下游（数据库、被调服务）的并行能力是有限的，连接超过这个量只会让下游忙于上下文切换、锁竞争和资源争用，RT 反而变差；池的上限同时也是对下游的保护。

落到数据库连接池，容量按两步定：先用 `数据库服务器核数 × 2 + 有效磁盘数` 估出**数据库侧的总连接数**再分摊到各实例，再用 Little 定律（所需连接数 = QPS × 持有连接时间）校验；算出的值远大于经验公式时，**先缩短持有时间**（优化慢 SQL、事务内不做 RPC），而不是加大池子。公式变量、校验示例、全局上限核算、HikariCP 参数表与泄漏排查统一见 [数据库连接池 · 池大小估算](/database/4_access/2_connection_pool#_4、池大小估算) 与 [数据库连接池 · 连接泄漏排查](/database/4_access/2_connection_pool#六、连接泄漏排查)，慢 SQL 与连接池的配合见 [数据访问性能](./10_db_performance)。

---

## 三、HTTP 连接池

**服务间 HTTP 调用应全局复用一个配置好的客户端实例。** HTTP/1.1 默认支持 Keep-Alive，但每次 `new` 客户端或不复用连接时，每次调用都要重新握手。

### 1、Apache HttpClient 5

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
- 三类超时分别设置：获取连接超时、建连超时、读超时。

### 2、OkHttp

```java
OkHttpClient client = new OkHttpClient.Builder()
        .connectionPool(new ConnectionPool(50, 5, TimeUnit.MINUTES)) // 最大空闲连接数、空闲存活时间
        .connectTimeout(1, TimeUnit.SECONDS)
        .readTimeout(3, TimeUnit.SECONDS)
        .build();
client.dispatcher().setMaxRequestsPerHost(50);   // 仅影响异步调用，默认 5
```

- 默认 `ConnectionPool` 最多保留 5 个空闲连接、空闲 5 分钟；支持 HTTP/2 时同一主机复用单连接多路传输。
- `OkHttpClient` 应全局单例共享，每个实例都有独立的连接池和线程池。

### 3、Keep-Alive 注意事项

- 客户端空闲连接超时应**小于服务端 Keep-Alive 超时**（如 Nginx `keepalive_timeout` 默认 75s；Tomcat `keepAliveTimeout` 默认取 `connectionTimeout` 的值），否则客户端可能拿到已被服务端关闭的连接，出现 `NoHttpResponseException` / `Connection reset`。
- Nginx 作为反向代理时，需配置 `upstream { keepalive 64; }`，并设置 `proxy_http_version 1.1` 和清空 `Connection` 头，才能与后端复用长连接。

更多网络层优化见 [IO 与网络优化](./9_io_network)。

---

## 四、线程池与 Redis 客户端池

**线程池的收益同样来自"复用 + 限流"：复用省去线程创建销毁开销，有界池和有界队列给并发设上限。** 线程数公式、Tomcat 等容器线程参数、见 [并发参数调优](/high-con/7_concurrency_tuning)，Redis 客户端池（含 Lettuce 共享连接的说明）见 [Redis 实战 · 依赖与配置](/cache/5_redis_practice#_1、依赖与配置)；线程池的执行流程、拒绝策略与监控见 [线程池](/java/28_topic_thread_pool)。

::: tip 虚拟线程不需要池化
JDK 21 的虚拟线程创建成本极低，不应放进池里复用；但它不限制并发，仍需用信号量或连接池限制对下游的并发量。
:::

---

## 五、对象池

### 1、Commons Pool2

**Apache Commons Pool2 是通用对象池实现，Jedis、DBCP2 等都基于它构建。** 自定义对象池时，关键是归还时可靠地重置状态：

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
| 普通小对象（DTO、集合、StringBuilder） | TLAB 分配极快，年轻代回收几乎零成本；池化反而延长对象生命周期、增加老年代压力和同步开销 |
| 内部状态复杂、难以可靠重置的对象 | 归还后残留状态会导致难以排查的数据串扰 |
| 并发极高且竞争激烈 | 池本身的锁成为瓶颈，可改用 `ThreadLocal` 每线程缓存一份 |
| 虚拟线程 | 创建成本极低，池化违背设计初衷 |

值得池化的通常只有：**连接、线程、大块缓冲区（如 Netty 的 `PooledByteBufAllocator`）、初始化极慢的对象**。

---

## 小结

- 池化 = 复用 + 限流，只对创建代价高、可安全复用的资源使用
- 连接池大小由下游并行能力决定：先用 `核数 × 2 + 有效磁盘数` 估算，再用 Little 定律校验，持有时间过长时先缩短持有时间；参数与泄漏排查见数据库连接池一篇
- HTTP 客户端全局单例，注意 `MaxConnPerRoute` 默认 5 和 Keep-Alive 超时的大小关系
- 线程池参数见 high-con，Redis 客户端池见 cache；普通小对象不要池化

## 参考资料

- [HikariCP - About Pool Sizing](https://github.com/brettwooldridge/HikariCP/wiki/About-Pool-Sizing)
- [Apache HttpClient 5](https://hc.apache.org/httpcomponents-client-5.4.x/)
- [Apache Commons Pool](https://commons.apache.org/proper/commons-pool/)

> 下一篇：[异步与批量](./8_async_batch) —— 缩短关键路径、摊薄固定开销的两类手段。
