# IO 与网络优化

> 对于大部分 Java 后端服务，一个请求的大部分时间花在**等待 IO**（磁盘、网络、下游服务）而非 CPU 计算上。IO 与网络优化的核心是：**少拷贝、少等待、少传输、少往返**。

---

## 一、零拷贝

传统"读文件 → 发送到 Socket"需要 4 次数据拷贝（其中 2 次 CPU 拷贝）和 4 次用户态/内核态切换。零拷贝通过让数据不经过用户空间来减少拷贝：

| 方案 | 系统调用 | Java API | 典型应用 |
|------|----------|----------|----------|
| 内存映射 | `mmap` | `FileChannel.map()` → `MappedByteBuffer` | RocketMQ CommitLog 读写 |
| 文件直传 | `sendfile` | `FileChannel.transferTo()` | Kafka 消费发送、Nginx 静态文件、Netty `FileRegion` |
| 堆外内存 | —— | `ByteBuffer.allocateDirect()` | Netty 网络读写，避免堆内外复制 |

- Java 中通过堆内 `byte[]` 做 Socket 读写时，JDK 内部会先复制到临时堆外缓冲区，这也是 Netty 默认使用直接内存和池化 `ByteBuf` 的原因。
- 原理详见 [IO / NIO 专题](/java/18_topic_io)。

---

## 二、IO 模型：NIO 与 Netty

| 模型 | 线程与连接的关系 | 适用场景 |
|------|------------------|----------|
| BIO（一连接一线程） | 线程数 = 连接数，线程大部分时间阻塞 | 连接数少、实现简单 |
| NIO 多路复用（Reactor） | 少量 IO 线程处理大量连接 | 高连接数的网关、IM、推送、RPC 框架 |
| 虚拟线程（JDK 21） | 同步写法，阻塞时虚拟线程让出载体线程 | 传统阻塞式业务代码的高并发改造 |

- Tomcat 默认已使用 NIO Connector，但业务线程仍然是"一请求一线程"的阻塞模型；真正的端到端非阻塞需要 WebFlux / Netty + 非阻塞客户端。
- **非阻塞的前提是整条链路都不阻塞**：在 Netty IO 线程或 WebFlux 中调用阻塞的 JDBC，会直接阻塞事件循环，性能反而更差。
- IO 模型对比见 [IO 模型](/netty/1_io_model)，Reactor 线程模型见 [Reactor](/netty/2_reactor)。

---

## 三、连接复用：Keep-Alive 与 HTTP/2

### 1、建连成本

| 阶段 | 往返次数（RTT） |
|------|-----------------|
| TCP 三次握手 | 1 |
| TLS 1.2 握手 | 2 |
| TLS 1.3 握手 | 1（会话恢复可 0-RTT） |
| HTTP 请求/响应 | 1 |

跨地域 RTT 为 30ms 时，一个 HTTPS（TLS 1.2）短连接请求至少 4 × 30 = 120ms，其中 90ms 花在建连上。**复用连接是最便宜的网络优化**。

### 2、HTTP 版本对比

| 特性 | HTTP/1.1 | HTTP/2 | HTTP/3 |
|------|----------|--------|--------|
| 连接复用 | Keep-Alive，但一个连接同时只能处理一个请求 | 单连接多路复用，多个流并发 | 基于 QUIC（UDP）多路复用 |
| 队头阻塞 | 应用层队头阻塞 | 解决应用层，仍有 TCP 层队头阻塞 | 解决 TCP 层队头阻塞 |
| 头部压缩 | 无 | HPACK | QPACK |
| 典型用途 | 大多数内部 REST 调用 | gRPC、浏览器访问、网关 | 移动端弱网、CDN 边缘 |

实践建议：

- 服务间 HTTP 调用使用连接池并开启 Keep-Alive，参数见 [池化技术](/high-perf/5_pooling)。
- 服务间高频调用可考虑 gRPC（HTTP/2 + Protobuf）；Spring Boot 开启 HTTP/2：`server.http2.enabled=true`（浏览器访问需要 TLS）。
- 协议细节见 [网络通信协议](/protocols/1_network_protocols)、[远程调用协议](/protocols/3_rpc_protocols)。

---

## 四、数据压缩

| 算法 | 压缩率 | 压缩速度 | 适用场景 |
|------|--------|----------|----------|
| gzip | 中 | 中 | HTTP 响应通用选择，兼容性最好 |
| Brotli | 高（文本比 gzip 小约 15%～25%） | 高压缩级别较慢 | 静态资源预压缩、浏览器访问 |
| zstd | 高 | 快 | Kafka 消息、日志归档、内部传输 |
| LZ4 / Snappy | 低 | 极快 | 对 CPU 敏感的实时场景，如 Kafka、RPC |

Spring Boot 开启响应压缩：

```yaml
server:
  compression:
    enabled: true
    mime-types: application/json,text/html,text/css,application/javascript
    min-response-size: 2KB     # 小于该大小不压缩
```

何时**不应**压缩：

- **小响应**（< 1～2KB）：压缩收益小于 CPU 开销与头部成本。
- **已压缩的内容**：图片（JPEG/PNG/WebP）、视频、zip 文件，再压缩几乎无收益。
- **内网高带宽、CPU 紧张**：带宽不是瓶颈时，压缩只是把网络耗时换成 CPU 耗时。
- 压缩通常在网关 / Nginx 层统一处理，避免应用与网关重复压缩。

---

## 五、序列化选择

序列化影响**CPU 耗时**和**传输体积**两个方面，在高频 RPC、缓存、MQ 场景中影响显著。

| 格式 | 体积 | 编解码速度 | 跨语言 | 可读性 | 典型场景 |
|------|------|------------|--------|--------|----------|
| JSON（Jackson） | 大 | 中 | 是 | 可读 | 对外 HTTP API、配置、调试友好的场景 |
| Protobuf | 小 | 快 | 是（需 .proto） | 不可读 | gRPC、跨语言服务间通信、高频消息 |
| Hessian2 | 中 | 中 | 有限 | 不可读 | Dubbo 传统默认序列化 |
| Kryo | 小 | 极快 | 否（仅 Java） | 不可读 | Spark/Flink 内部、Java 内部缓存 |
| Java 原生 | 大 | 慢 | 否 | 不可读 | 不推荐，且有反序列化安全风险 |

选择建议：

- 对外接口用 JSON，保证兼容与可调试性；内部高频调用可选 Protobuf。
- JSON 性能优化：复用 `ObjectMapper`、避免序列化无用字段（`@JsonIgnore`、DTO 裁剪）、大对象用流式 API。
- 缓存中存储的对象要考虑**向前兼容**：字段增删后旧数据能否反序列化。
- 各框架原理与坑见 [序列化专题](/java/19_topic_serialization)。

---

## 六、CDN 与静态资源

| 手段 | 说明 |
|------|------|
| CDN 分发 | 静态资源（JS/CSS/图片/视频）就近访问，减少源站带宽与 RTT |
| 缓存头 | 带 hash 的文件名 + `Cache-Control: max-age=31536000, immutable`；HTML 使用协商缓存（`ETag`） |
| 动静分离 | 静态资源由 Nginx / 对象存储 + CDN 提供，不经过应用服务器 |
| 图片优化 | WebP/AVIF 格式、按尺寸裁剪、懒加载 |
| 对象存储直传 | 文件上传下载通过预签名 URL 直连对象存储，不经应用中转，见 [对象存储](/architecture/4_object_storage) |

---

## 七、减少往返次数

网络优化中最常被忽视的一点：**一次 10ms 的调用做 20 次，就是 200ms**。

| 问题 | 优化方式 |
|------|----------|
| 前端一个页面调用十几个接口 | BFF（Backend For Frontend）层聚合，服务端内网并行调用后一次返回 |
| 循环调用单条查询接口 | 提供批量接口 `batchGet(List<Long> ids)` |
| 循环读写 Redis | `MGET` / Pipeline / Lua 脚本 |
| 循环执行 SQL（N+1） | `IN` 查询或 JOIN，见 [数据访问性能](/high-perf/8_db_performance) |
| 接口返回过多无用字段 | 按场景裁剪 DTO、字段选择（GraphQL、`fields` 参数） |
| 跨地域调用 | 同机房/同可用区部署依赖服务，就近读取 |

```java
// Bad：循环中逐个调用用户服务，N 次 RPC
List<OrderVO> vos = orders.stream()
        .map(o -> OrderVO.of(o, userClient.getUser(o.getUserId())))
        .toList();

// Good：先收集 id，一次批量调用
Set<Long> userIds = orders.stream().map(Order::getUserId).collect(Collectors.toSet());
Map<Long, User> users = userClient.batchGet(userIds);
List<OrderVO> vos = orders.stream()
        .map(o -> OrderVO.of(o, users.get(o.getUserId())))
        .toList();
```

批量接口与请求合并的更多讨论见 [异步与批量](/high-perf/6_async_batch)。
