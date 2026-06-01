# 协议体系总览

在软件开发中，协议（Protocol）是用于定义通信标准的规则集合。根据应用场景的不同，可以将常见协议分为以下几类：

---

## 官方规范入口

| 分类 | 原始资料 / 官方网站 |
|------|------------------|
| 网络通信 | [IETF RFC Editor](https://www.rfc-editor.org/) / [IETF Datatracker](https://datatracker.ietf.org/) |
| Web 协议 | [HTTP RFC 9110](https://www.rfc-editor.org/rfc/rfc9110.html) / [WHATWG WebSocket](https://websockets.spec.whatwg.org/) |
| IoT 与工业通信 | [MQTT](https://mqtt.org/) / [Modbus](https://www.modbus.org/) / [OPC Foundation](https://opcfoundation.org/) |
| 远程调用与消息 | [gRPC](https://grpc.io/docs/) / [Apache Thrift](https://thrift.apache.org/) / [AMQP](https://www.amqp.org/) |
| 安全与认证 | [TLS 1.3 RFC 8446](https://www.rfc-editor.org/rfc/rfc8446.html) / [OAuth 2.0 RFC 6749](https://www.rfc-editor.org/rfc/rfc6749.html) / [OpenID Connect](https://openid.net/developers/specs/) |
| 数据库访问 | [JDBC](https://docs.oracle.com/javase/8/docs/api/java/sql/package-summary.html) / [ODBC](https://learn.microsoft.com/en-us/sql/odbc/reference/odbc-programmer-s-reference) / [MySQL Internals](https://dev.mysql.com/doc/dev/mysql-server/latest/PAGE_PROTOCOL.html) |

## 模块导航

| 模块 | 覆盖内容 |
|------|----------|
| [网络通信协议](./1_network_communication) | TCP、UDP、IP、HTTP、WebSocket |
| [IoT 与工业通信协议](./2_iot_industrial_communication) | MQTT、CoAP、Modbus、OPC UA、Zigbee |
| [数据交换与远程调用](./3_data_exchange_remote_call) | gRPC、REST、SOAP、Thrift、AMQP |
| [安全协议](./4_security_protocols) | TLS、OAuth2、OIDC、JWT、Kerberos、SAML |
| [文件传输协议](./5_file_transfer_protocols) | FTP、SFTP、TFTP、NFS、SMB |
| [数据库访问协议](./6_database_access_protocols) | JDBC、ODBC、MySQL、PostgreSQL、Redis RESP |
| [邮件通信协议](./7_email_communication_protocols) | SMTP、POP3、IMAP、MIME |
| [分布式系统协议](./8_distributed_system_protocols) | Raft、Paxos、Gossip、ZAB |

---

## **1. 传输层和网络层协议（通信协议）**

这些协议主要用于计算机网络中的数据传输，保证数据能够可靠地在不同设备之间传递。

- **TCP（Transmission Control Protocol，传输控制协议）**：面向连接的可靠传输协议，提供数据流控制和错误检测，常用于 HTTP、FTP
  等应用。  
  [TCP RFC 793](https://tools.ietf.org/html/rfc793)

- **UDP（User Datagram Protocol，用户数据报协议）**：无连接的传输协议，适用于对时延敏感但无需可靠传输的应用，如视频流、DNS
  查询等。  
  [UDP RFC 768](https://tools.ietf.org/html/rfc768)

- **IP（Internet Protocol，互联网协议）**：定义了计算机网络之间的寻址和路由规则，IPv4 和 IPv6 是常见版本。  
  [IP RFC 791](https://tools.ietf.org/html/rfc791)

- **ICMP（Internet Control Message Protocol，互联网控制消息协议）**：用于网络设备发送错误报告和测试，如 `ping` 命令使用 ICMP
  发送回显请求。  
  [ICMP RFC 792](https://tools.ietf.org/html/rfc792)

- **HTTP（HyperText Transfer Protocol，超文本传输协议）**：基于 TCP，用于 Web 浏览器与服务器之间的数据传输。  
  [HTTP RFC 7230](https://tools.ietf.org/html/rfc7230)

- **HTTPS（HTTP Secure，安全超文本传输协议）**：在 HTTP 基础上加密（TLS/SSL）传输，保证数据安全性。  
  [HTTPS RFC 2818](https://tools.ietf.org/html/rfc2818)

- **WebSocket**：基于 TCP 的全双工通信协议，适用于实时通信（如在线聊天、股票推送）。  
  [WebSocket RFC 6455](https://tools.ietf.org/html/rfc6455)

---

## **2. 设备通信协议（物联网与工业通信）**

这些协议用于 IoT 设备、嵌入式系统、传感器网络等设备间的通信。

- **MQTT（Message Queuing Telemetry Transport）**：轻量级、基于发布订阅的协议，适用于物联网（IoT）应用。  
  [MQTT 3.1.1](http://mqtt.org/)

- **CoAP（Constrained Application Protocol）**：专为物联网设计的轻量级协议，类似 HTTP，但更适用于低功耗设备。  
  [CoAP RFC 7252](https://tools.ietf.org/html/rfc7252)

- **Modbus**：用于工业自动化的串行通信协议，如 PLC（可编程逻辑控制器）和传感器通信。  
  [Modbus 规范](https://www.modbus.org/)

- **OPC UA（Open Platform Communications Unified Architecture）**：工业物联网（IIoT）中的常见标准协议。  
  [OPC UA 规范](https://www.opcfoundation.org/)

- **ZigBee**：低功耗无线通信协议，广泛用于智能家居设备。  
  [ZigBee Alliance](https://www.zigbee.org/)

---

## **3. 数据交换协议（消息传输与远程调用）**

这些协议用于不同系统之间的数据传输和远程调用。

- **gRPC（Google Remote Procedure Call）**：基于 HTTP/2 和 Protobuf 的高效 RPC 框架，支持多语言。  
  [gRPC 官方文档](https://grpc.io/docs/)

- **RESTful API（Representational State Transfer）**：基于 HTTP 的无状态 API 设计风格，常用于 Web 服务。  
  [REST API 设计规范](https://restfulapi.net/)

- **SOAP（Simple Object Access Protocol）**：基于 XML 的远程调用协议，常用于企业级 Web 服务。  
  [SOAP 规范](https://www.w3.org/TR/soap/)

- **Thrift**：Facebook 开发的跨语言 RPC 框架，支持高效的二进制数据传输。  
  [Thrift 官方文档](https://thrift.apache.org/)

- **AMQP（Advanced Message Queuing Protocol）**：标准消息队列协议，RabbitMQ 采用 AMQP 进行消息通信。  
  [AMQP 规范](https://www.amqp.org/)

---

## **4. 安全协议（数据加密与身份认证）**

这些协议用于保证数据传输的安全性、完整性以及身份认证。

- **TLS（Transport Layer Security，传输层安全协议）**：用于加密 HTTP（HTTPS），保护数据传输安全。  
  [TLS RFC 5246](https://tools.ietf.org/html/rfc5246)

- **SSL（Secure Sockets Layer）**：TLS 的前身，现已逐步被 TLS 取代。  
  [SSL 规范](https://tools.ietf.org/html/rfc6101)

- **OAuth 2.0**：授权协议，允许第三方应用访问用户数据（如 OAuth 登录 Facebook、Google）。  
  [OAuth 2.0 规范](https://tools.ietf.org/html/rfc6749)

- **JWT（JSON Web Token）**：用于身份验证的轻量级令牌，常用于前后端分离的应用。  
  [JWT 规范](https://jwt.io/introduction/)

- **Kerberos**：一种基于票据的身份认证协议，适用于分布式系统。  
  [Kerberos 规范](https://web.mit.edu/kerberos/)

- **SAML（Security Assertion Markup Language）**：基于 XML 的单点登录（SSO）协议，常用于企业级认证。  
  [SAML 规范](https://www.oasis-open.org/standards#samlv2.0)

---

## **5. 文件传输协议**

这些协议用于跨设备传输文件或数据流。

- **FTP（File Transfer Protocol）**：标准文件传输协议，使用 TCP 进行文件传输。  
  [FTP RFC 959](https://tools.ietf.org/html/rfc959)

- **SFTP（SSH File Transfer Protocol）**：基于 SSH 加密的 FTP 传输方式，安全性更高。  
  [SFTP 规范](https://tools.ietf.org/html/rfc4251)

- **TFTP（Trivial File Transfer Protocol）**：简化版 FTP，适用于网络设备固件升级等轻量级文件传输。  
  [TFTP RFC 1350](https://tools.ietf.org/html/rfc1350)

- **NFS（Network File System）**：网络文件系统协议，支持远程文件共享（Linux/Unix）。  
  [NFS 规范](https://tools.ietf.org/html/rfc1094)

- **SMB（Server Message Block）**：Windows 网络文件共享协议（如 Samba）。  
  [SMB 规范](https://docs.microsoft.com/en-us/openspecs/windows_protocols/ms-smb/)

---

## **6. 数据库访问协议**

这些协议用于数据库的远程访问和数据交互。

- **JDBC（Java Database Connectivity）**：Java 访问数据库的标准 API。  
  [JDBC 官方文档](https://docs.oracle.com/javase/8/docs/api/java/sql/package-summary.html)

- **ODBC（Open Database Connectivity）**：基于 SQL 的数据库访问标准，支持跨平台访问。  
  [ODBC 官方文档](https://docs.microsoft.com/en-us/sql/odbc/?view=sql-server-ver15)

- **MySQL 协议**：MySQL 服务器与客户端之间的通信协议，支持 TCP 和 Unix Socket 连接。  
  [MySQL 协议文档](https://dev.mysql.com/doc/internals/en/)

- **PostgreSQL 协议**：PostgreSQL 数据库的原生通信协议。  
  [PostgreSQL 协议文档](https://wiki.postgresql.org/wiki/Protocol)

- **Redis RESP（Redis Serialization Protocol）**：Redis 使用的请求/响应协议，基于 TCP。  
  [Redis 协议文档](https://redis.io/topics/protocol)

---

## **7. 邮件通信协议**

这些协议用于电子邮件的发送、接收和管理。

- **SMTP（Simple Mail Transfer Protocol）**：邮件发送协议，SMTP 服务器用于发送邮件。  
  [SMTP RFC 5321](https://tools.ietf.org/html/rfc5321)

- **POP3（Post Office Protocol v3）**：邮件接收协议，邮件下载后存储在本地，不保留服务器副本。  
  [POP3 RFC 1939](https://tools.ietf.org/html/rfc1939)

- **IMAP（Internet Message Access Protocol）**：邮件接收协议，支持邮件在服务器端同步，适用于多设备访问。  
  [IMAP RFC 3501](https://tools.ietf.org/html/rfc3501)

---

## **8. 分布式系统协议**

这些协议用于保证分布式系统中的一致性、可靠性和数据同步。

- **Raft**：一致性协议，用于分布式系统的 Leader 选举和日志复制。  
  [Raft 论文](https://raft.github.io/)

- **Paxos**：经典的一致性协议，应用于分布式数据库、Zookeeper 等。  
  [Paxos 论文](https://research.microsoft.com/en-us/um/people/lamport/pubs/paxos.pdf)

- **Gossip Protocol**：用于分布式系统中节点信息传播，如 Cassandra、Consul 采用该协议。  
  [Gossip Protocol 论文](https://dl.acm.org/doi/10.1145/1367682.1367702)

- **ZAB（Zookeeper Atomic Broadcast）**：Zookeeper 使用的一致性协议，保证数据一致性和主从切换。  
  [ZAB 论文](https://www.usenix.org/legacy/event/atc10/tech/full_papers/Zhao.pdf)

---

## **9、总结及其对比**

| **协议分类**    | **示例协议**                       | **主要用途**  |
|-------------|--------------------------------|-----------|
| **传输协议**    | TCP、UDP、IP、ICMP                | 计算机网络通信   |
| **设备通信协议**  | MQTT、CoAP、Modbus、OPC UA、ZigBee | 物联网、工业自动化 |
| **数据交换协议**  | gRPC、RESTful、SOAP、Thrift、AMQP  | 系统间通信     |
| **安全协议**    | TLS、SSL、OAuth2、JWT、Kerberos    | 数据加密、认证   |
| **文件传输协议**  | FTP、SFTP、NFS、SMB               | 远程文件传输    |
| **数据库访问协议** | JDBC、ODBC、MySQL、Redis RESP     | 数据库连接     |
| **邮件协议**    | SMTP、POP3、IMAP                 | 邮件收发      |
| **分布式系统协议** | Raft、Paxos、ZAB、Gossip          | 分布式一致性    |

---
