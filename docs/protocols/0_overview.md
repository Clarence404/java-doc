# 网络协议总览

协议（Protocol）是计算机通信的规则集合。本知识库按场景将常见协议分为 8 类。

---

## 一、分类索引

<ModuleNav />

---

## 二、官方规范入口

| 分类 | 规范来源 |
|------|---------|
| 网络通信 | [IETF RFC Editor](https://www.rfc-editor.org/) |
| HTTP | [RFC 9110](https://www.rfc-editor.org/rfc/rfc9110.html) / [HTTP/2 RFC 9113](https://www.rfc-editor.org/rfc/rfc9113.html) / [HTTP/3 RFC 9114](https://www.rfc-editor.org/rfc/rfc9114.html) |
| IoT | [MQTT](https://mqtt.org/) / [Modbus](https://www.modbus.org/) / [OPC Foundation](https://opcfoundation.org/) |
| 远程调用 | [gRPC](https://grpc.io/docs/) / [Protobuf](https://protobuf.dev/) / [AMQP](https://www.amqp.org/) |
| 安全 | [TLS 1.3 RFC 8446](https://www.rfc-editor.org/rfc/rfc8446.html) / [OAuth 2.0 RFC 6749](https://www.rfc-editor.org/rfc/rfc6749.html) |
| 分布式 | [Raft](https://raft.github.io/) / [ZooKeeper ZAB](https://zookeeper.apache.org/doc/current/) |

---

## 三、协议选型速查

| 场景 | 推荐协议 | 原因 |
|------|---------|------|
| 服务间高性能 RPC | **gRPC** | HTTP/2 + Protobuf，强类型，流式支持 |
| 对外开放 API | **REST/HTTP** | 无状态，生态最广，易调试 |
| 实时双向推送 | **WebSocket** | 全双工，低延迟，浏览器原生支持 |
| 物联网设备上报 | **MQTT** | 轻量，QoS 可配，带宽友好 |
| 传输层加密 | **TLS 1.3** | 最新标准，1-RTT 握手，Forward Secrecy |
| 分布式一致性 | **Raft** | 工程可理解，etcd/Kafka KRaft 采用 |
| 大规模事件传播 | **Gossip** | 去中心化，Cassandra/Consul 采用 |
| 企业邮件集成 | **SMTP + IMAP** | SMTP 发，IMAP 多端同步收 |
