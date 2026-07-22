# 协议体系总览

协议（Protocol）是计算机通信的规则集合。本知识库按场景将常见协议分为 8 类。

---

## 一、分类索引

| # | 模块 | 覆盖协议 | 链接 |
|---|------|---------|------|
| 1 | 网络通信 | TCP、UDP、HTTP/1-3、WebSocket、DNS | [→](./1_network_protocols) |
| 2 | IoT 与工业 | MQTT、CoAP、Modbus、OPC UA、ZigBee | [→](./2_iot_protocols) |
| 3 | 远程调用 | gRPC、REST、SOAP、Thrift、AMQP | [→](./3_rpc_protocols) |
| 4 | 安全协议 | TLS、mTLS、OAuth2、OIDC、JWT、SAML | [→](./4_security_protocols) |
| 5 | 文件传输 | FTP、SFTP、TFTP、NFS、SMB | [→](./5_file_protocols) |
| 6 | 数据库访问 | JDBC、MySQL Wire、PostgreSQL、RESP | [→](./6_database_protocols) |
| 7 | 邮件通信 | SMTP、POP3、IMAP、MIME | [→](./7_email_protocols) |
| 8 | 分布式协议 | Raft、Paxos、ZAB、Gossip | [→](./8_distributed_protocols) |

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
