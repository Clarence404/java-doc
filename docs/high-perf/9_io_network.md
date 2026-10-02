---
description: 零拷贝与 IO 模型的选用、Keep-Alive / HTTP/2、压缩、序列化、CDN
---

# IO 与网络优化

> **本篇目标**：从"少拷贝、少等待、少传输、少往返"四个方向优化 IO 与网络开销，知道每种手段何时值得用。
>
> **前置阅读**：[异步与批量](./8_async_batch)

大部分 Java 后端服务的请求时间主要花在**等待 IO**（磁盘、网络、下游服务）而非 CPU 计算上。本篇讲选型与取舍，零拷贝、IO 模型等原理链接到 java 与 netty 模块。

| 方向 | 手段 | 本篇章节 |
|------|------|---------|
| 少拷贝 | 零拷贝 | 一 |
| 少等待 | 合适的 IO 模型、连接复用 | 二、三 |
| 少传输 | 压缩、序列化、CDN | 四、五、六 |
| 少往返 | 批量接口、聚合、就近部署 | 七 |

---

## 一、零拷贝：何时选用

**零拷贝只在"大块数据原样搬运"时收益明显**：文件下载、日志 / 消息文件发送、大文件读写。普通 JSON 接口的数据要经过业务处理和序列化，用不上零拷贝。

| 方案 | 系统调用 / Java API | 何时选用 | 典型应用 |
|------|--------------------|---------|---------|
| 内存映射 | `mmap` / `FileChannel.map()` | 需要在用户态读写文件内容，且文件可预先映射 | RocketMQ CommitLog |
| 文件直传 | `sendfile` / `FileChannel.transferTo()` | 文件内容不加工、直接发往 Socket | Kafka 消费发送、Nginx 静态文件、Netty `FileRegion` |

- 两种方案都要求数据**不经过用户态加工**。开启 TLS 后数据必须在用户态加密，`sendfile` 失效：**Kafka 开启 TLS 后 Broker 无法用 sendfile 向消费者发送数据**，吞吐会明显下降；Netty 启用 `SslHandler` 后也要改用 `ChunkedWriteHandler` 分块发送。
- 直接内存（`allocateDirect`）和 Netty 的 `CompositeByteBuf` 属于**用户态少拷贝**，不是操作系统零拷贝，两者的区别见 [ByteBuf 与内存管理](/netty/5_bytebuf)。
- 拷贝次数与原理见 [IO / NIO 专题](/java/18_topic_io)。

---

## 二、IO 模型：何时选用

**线程模型决定"等待 IO 时线程在干什么"。** 模型原理见 [IO 模型](/netty/1_io_model)，Reactor 线程模型见 [Reactor](/netty/2_reactor)，这里只给选型结论：

| 场景 | 推荐 | 原因 |
|------|------|------|
| 常规 CRUD 接口，连接数中等 | Tomcat NIO Connector + 阻塞业务线程（Spring MVC） | 生态成熟、写法简单，瓶颈通常不在这里 |
| 大量阻塞 IO、线程数成为瓶颈 | JDK 21 虚拟线程 | 保持同步写法，阻塞时让出载体线程 |
| 海量长连接：网关、IM、推送、RPC 框架 | Netty / WebFlux 等 Reactor 模型 | 少量 IO 线程管理大量连接 |

- Tomcat 默认已使用 NIO Connector，但业务线程仍是"一请求一线程"的阻塞模型；端到端非阻塞需要 WebFlux / Netty + 非阻塞客户端。
- **非阻塞的前提是整条链路都不阻塞**：在 Netty IO 线程或 WebFlux 中调用阻塞的 JDBC，会阻塞事件循环，性能反而更差。

---

## 三、连接复用：Keep-Alive 与 HTTP/2

### 1、建连成本

**复用连接是最便宜的网络优化。** 一次新建的 HTTPS 请求要先付出握手的 RTT：

| 阶段 | 往返次数（RTT） |
|------|-----------------|
| TCP 三次握手 | 1 |
| TLS 1.2 握手 | 2 |
| TLS 1.3 握手 | 1（会话恢复可 0-RTT） |
| HTTP 请求 / 响应 | 1 |

跨地域 RTT 为 30ms 时，一个 HTTPS（TLS 1.2）短连接请求至少 4 × 30 = 120ms，其中 90ms 花在建连上。

### 2、HTTP 版本对比

| 特性 | HTTP/1.1 | HTTP/2 | HTTP/3 |
|------|----------|--------|--------|
| 连接复用 | Keep-Alive，但一个连接同时只能处理一个请求 | 单连接多路复用，多个流并发 | 基于 QUIC（UDP）多路复用 |
| 队头阻塞 | 应用层队头阻塞 | 解决应用层，仍有 TCP 层队头阻塞 | 解决 TCP 层队头阻塞 |
| 头部压缩 | 无 | HPACK | QPACK |
| 典型用途 | 大多数内部 REST 调用 | gRPC、浏览器访问、网关 | 移动端弱网、CDN 边缘 |

- 服务间 HTTP 调用使用连接池并开启 Keep-Alive，参数见 [池化技术](./7_pooling)。
- 服务间高频调用可考虑 gRPC（HTTP/2 + Protobuf）；Spring Boot 开启 HTTP/2：`server.http2.enabled=true`（浏览器访问需要 TLS）。
- 协议细节见 [网络通信协议](/protocols/1_network_protocols)、[远程调用协议](/protocols/3_rpc_protocols)。

---

## 四、数据压缩

**压缩是用 CPU 换带宽，只在带宽或传输时间是瓶颈时划算。**

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
    min-response-size: 2KB     # 默认即 2KB，小于该大小不压缩
```

`mime-types` 的默认值已包含 `text/html`、`text/css`、`text/plain`、`text/xml`、`text/javascript`、`application/javascript`、`application/json`、`application/xml`，通常只需 `enabled: true`；有其他类型时再显式覆盖（覆盖会替换整个默认列表）。

何时**不应**压缩：

- **小响应**（< 1～2KB）：压缩收益小于 CPU 开销与头部成本。
- **已压缩的内容**：图片（JPEG/PNG/WebP）、视频、zip 文件，再压缩几乎无收益。
- **内网高带宽、CPU 紧张**：带宽不是瓶颈时，压缩只是把网络耗时换成 CPU 耗时。
- 压缩通常在网关 / Nginx 层统一处理，避免应用与网关重复压缩。

---

## 五、序列化选择

**序列化同时影响 CPU 耗时和传输体积**，在高频 RPC、缓存、MQ 场景中影响显著。

| 格式 | 体积 | 编解码速度 | 跨语言 | 可读性 | 典型场景 |
|------|------|------------|--------|--------|----------|
| JSON（Jackson） | 大 | 中 | 是 | 可读 | 对外 HTTP API、调试友好的场景 |
| Protobuf | 小 | 快 | 是（需 .proto） | 不可读 | gRPC、跨语言服务间通信、高频消息 |
| Hessian2 | 中 | 中 | 有限 | 不可读 | Dubbo 传统默认序列化 |
| Kryo | 小 | 极快 | 否（仅 Java） | 不可读 | Spark/Flink 内部、Java 内部缓存 |
| Java 原生 | 大 | 慢 | 否 | 不可读 | 不推荐，且有反序列化安全风险 |

- 对外接口用 JSON，保证兼容与可调试性；内部高频调用可选 Protobuf。
- JSON 优化：复用 `ObjectMapper`、避免序列化无用字段（`@JsonIgnore`、DTO 裁剪）、大对象用流式 API。
- 缓存中的对象要考虑**向前兼容**：字段增删后旧数据能否反序列化。
- 各框架原理与坑见 [序列化专题](/java/19_topic_serialization)。

---

## 六、CDN 与静态资源

**静态资源不应经过应用服务器。** 接入层与 CDN 的整体架构见 [接入层架构](/high-con/1_access_layer)。

| 手段 | 说明 |
|------|------|
| CDN 分发 | 静态资源（JS/CSS/图片/视频）就近访问，减少源站带宽与 RTT |
| 缓存头 | 带 hash 的文件名 + `Cache-Control: max-age=31536000, immutable`；HTML 使用协商缓存（`ETag`） |
| 动静分离 | 静态资源由 Nginx / 对象存储 + CDN 提供 |
| 图片优化 | WebP/AVIF 格式、按尺寸裁剪、懒加载 |
| 对象存储直传 | 上传下载通过预签名 URL 直连对象存储，不经应用中转，见 [对象存储](/architecture/4_object_storage) |

---

## 七、减少往返次数

**一次 10ms 的调用做 20 次，就是 200ms。** 这是网络优化中最常被忽视的一点。

| 问题 | 优化方式 |
|------|----------|
| 前端一个页面调用十几个接口 | BFF（Backend For Frontend）层聚合，服务端内网并行调用后一次返回 |
| 循环调用单条查询接口 | 提供批量接口 `batchGet(List<Long> ids)` |
| 循环读写 Redis | `MGET` / Pipeline / Lua 脚本 |
| 循环执行 SQL（N+1） | `IN` 查询或 JOIN，见 [数据访问性能](./10_db_performance) |
| 接口返回过多无用字段 | 按场景裁剪 DTO、字段选择（GraphQL、`fields` 参数） |
| 跨地域调用 | 同机房 / 同可用区部署依赖服务，就近读取 |

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

批量接口与请求合并见 [异步与批量](./8_async_batch)。

---

## 小结

- 零拷贝只适合大块数据原样搬运，开启 TLS 后 sendfile 失效；直接内存属于用户态少拷贝
- IO 模型按场景选：常规接口用 Spring MVC，阻塞 IO 多用虚拟线程，海量长连接用 Reactor
- 复用连接是最便宜的优化：连接池 + Keep-Alive，高频内部调用考虑 HTTP/2 / gRPC
- 压缩和序列化都是 CPU 与带宽的交换，小响应和已压缩内容不压缩
- 减少往返次数往往比优化单次调用收益更大

> 下一篇：[数据访问性能](./10_db_performance) —— 慢 SQL 治理闭环、深分页、批量写与 N+1。
