# 网络协议总览

网络协议模块从 Java 后端的视角讲协议：重点是每天都在用的 TCP、HTTP、TLS、DNS，以及服务间调用用的 RPC 协议；数据库、邮件、文件这几类外围协议只讲对接时需要懂的报文流程和安全要点。IO 模型、Netty 编程、WebSocket、SSE 等「怎么写网络程序」的内容放在 Netty 模块，认证授权放在应用安全模块，本模块只讲协议本身。

版本基线：协议以现行 RFC 为准（TCP RFC 9293、HTTP 语义 RFC 9110、HTTP/2 RFC 9113、HTTP/3 RFC 9114、TLS 1.3 RFC 8446）；示例代码默认 **JDK 21**、**Spring Boot 4**，Linux 行为以 5.x / 6.x 内核为准，与旧版本行为不同的地方在正文中单独标出。

![后端视角的协议分层](../assets/protocols/protocol-layers.svg)

---

## 一、模块导航

<ModuleNav />

---

## 二、推荐阅读路径

1. 先读 [TCP 与 UDP](./1_tcp_udp)，握手挥手、TIME_WAIT、拥塞控制是后面所有协议的底座
2. 再读 [HTTP](./2_http) 和 [HTTPS 与 TLS](./3_https_tls)，覆盖 HTTP/1.1 → HTTP/2 → HTTP/3 的演进、缓存与 TLS 1.3 握手、证书链
3. 然后读 [DNS](./4_dns)，理解域名解析、TTL 与缓存对服务发现和故障切换的影响
4. 服务间调用读 [RPC 协议](./5_rpc_protocols)，gRPC 的帧格式、截止时间、状态码与长连接负载均衡
5. 外围协议按需阅读：[数据库协议](./6_database_protocols)（连接认证类报错时查）、[邮件协议](./7_email_protocols)（发系统通知时查）、[文件协议](./8_file_protocols)（与外部系统做文件交换时查）

[高频面试题](./99_interview) 只列题目，答案在 [网络协议面试题解答](/interview/4_network)。

---

## 三、协议选型速查

| 场景 | 推荐 | 原因 |
|------|------|------|
| 对外开放 API | HTTP + JSON | 生态最广、易调试，规范见 [API 设计规范](/engineering/7_api_design_rule) |
| 服务间高性能调用 | gRPC 或 Dubbo 3 Triple | HTTP/2 + Protobuf，强类型契约，支持流式；选型见 [服务通信](/spring-cloud/3_communication) |
| 服务端向浏览器单向推送 | SSE | 基于普通 HTTP，自动重连，见 [SSE（Server-Sent Events）](/netty/11_sse) |
| 浏览器双向实时通信 | WebSocket | 全双工、低开销，见 [WebSocket](/netty/10_websocket) |
| 传输加密 | TLS 1.3 | 1-RTT 握手，只保留前向安全的密钥交换 |
| 弱网、移动端、连接迁移 | HTTP/3（QUIC） | 基于 UDP，消除 TCP 层队头阻塞，切换网络不断连 |
| 系统通知邮件 | SMTP 587 / 465 + SPF、DKIM、DMARC | 缺少发信认证会被当作垃圾邮件 |
| 与外部系统交换文件 | SFTP | 单端口、SSH 加密、公钥认证 |

---

## 四、关联模块

- IO 模型、Reactor、Netty 编程、粘包拆包、心跳、WebSocket、SSE → [Netty 总览](/netty/0_overview)
- 网络层面的性能优化（零拷贝、连接复用、压缩、序列化选择） → [IO 与网络优化](/high-perf/9_io_network)
- JWT、OAuth2、mTLS 在服务网格中的使用、零信任 → [应用安全总览](/security/0_overview)
- MQTT、CoAP、Modbus 等物联网协议 → [通信协议](/iot/1_protocol)
- Raft、Paxos、ZAB、Gossip 等一致性与集群协议 → [分布式理论](/distributed/2_theorem)
- AMQP 与消息队列协议 → [RabbitMQ](/messaging/4_rabbitmq)
- 服务间调用方式选型、Dubbo → [服务通信](/spring-cloud/3_communication) / [Dubbo](/microservices/4_dubbo)

---

## 参考资料

- IETF RFC Editor：[https://www.rfc-editor.org/](https://www.rfc-editor.org/)
- TCP RFC 9293：[https://www.rfc-editor.org/rfc/rfc9293.html](https://www.rfc-editor.org/rfc/rfc9293.html)
- HTTP Semantics RFC 9110：[https://www.rfc-editor.org/rfc/rfc9110.html](https://www.rfc-editor.org/rfc/rfc9110.html)
- HTTP/2 RFC 9113：[https://www.rfc-editor.org/rfc/rfc9113.html](https://www.rfc-editor.org/rfc/rfc9113.html)
- HTTP/3 RFC 9114：[https://www.rfc-editor.org/rfc/rfc9114.html](https://www.rfc-editor.org/rfc/rfc9114.html)
- TLS 1.3 RFC 8446：[https://www.rfc-editor.org/rfc/rfc8446.html](https://www.rfc-editor.org/rfc/rfc8446.html)
- gRPC：[https://grpc.io/docs/](https://grpc.io/docs/)
- Protocol Buffers：[https://protobuf.dev/](https://protobuf.dev/)
