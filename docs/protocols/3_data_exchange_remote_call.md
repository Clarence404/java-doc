# 远程调用协议

覆盖系统之间的数据交换、远程调用和消息传输协议。

## 官方规范入口

| 协议 / 风格 | 官方 / 原始规范 |
|-------------|----------------|
| gRPC | [gRPC Documentation](https://grpc.io/docs/) |
| Protocol Buffers | [Protocol Buffers Documentation](https://protobuf.dev/) |
| REST | [Roy Fielding REST Dissertation](https://www.ics.uci.edu/~fielding/pubs/dissertation/rest_arch_style.htm) |
| SOAP | [W3C SOAP](https://www.w3.org/TR/soap/) |
| Apache Thrift | [Apache Thrift](https://thrift.apache.org/) |
| AMQP | [AMQP](https://www.amqp.org/) |

- **gRPC（Google Remote Procedure Call）**：基于 HTTP/2 和 Protobuf 的高效 RPC 框架，支持多语言。
- **RESTful API（Representational State Transfer）**：基于 HTTP 的无状态 API 设计风格，常用于 Web 服务。
- **SOAP（Simple Object Access Protocol）**：基于 XML 的远程调用协议，常用于企业级 Web 服务。
- **Thrift**：Facebook 开发的跨语言 RPC 框架，支持高效的二进制数据传输。
- **AMQP（Advanced Message Queuing Protocol）**：标准消息队列协议，RabbitMQ 采用 AMQP 进行消息通信。
