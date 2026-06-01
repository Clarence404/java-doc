# 网络通信协议

覆盖传输层、网络层和常见 Web 通信协议，主要用于计算机网络中的数据传输。

## 官方规范入口

| 协议 | 官方 / 原始规范 |
|------|----------------|
| TCP | [RFC 9293](https://www.rfc-editor.org/rfc/rfc9293.html) |
| UDP | [RFC 768](https://www.rfc-editor.org/rfc/rfc768.html) |
| IPv4 | [RFC 791](https://www.rfc-editor.org/rfc/rfc791.html) |
| IPv6 | [RFC 8200](https://www.rfc-editor.org/rfc/rfc8200.html) |
| ICMP | [RFC 792](https://www.rfc-editor.org/rfc/rfc792.html) |
| HTTP | [RFC 9110](https://www.rfc-editor.org/rfc/rfc9110.html) / [HTTP/1.1 RFC 9112](https://www.rfc-editor.org/rfc/rfc9112.html) / [HTTP/2 RFC 9113](https://www.rfc-editor.org/rfc/rfc9113.html) / [HTTP/3 RFC 9114](https://www.rfc-editor.org/rfc/rfc9114.html) |
| WebSocket | [RFC 6455](https://www.rfc-editor.org/rfc/rfc6455.html) |

- **TCP（Transmission Control Protocol，传输控制协议）**：面向连接的可靠传输协议，提供数据流控制和错误检测，常用于 HTTP、FTP 等应用。
- **UDP（User Datagram Protocol，用户数据报协议）**：无连接的传输协议，适用于对时延敏感但无需可靠传输的应用，如视频流、DNS 查询等。
- **IP（Internet Protocol，互联网协议）**：定义了计算机网络之间的寻址和路由规则，IPv4 和 IPv6 是常见版本。
- **ICMP（Internet Control Message Protocol，互联网控制消息协议）**：用于网络设备发送错误报告和测试，如 `ping` 命令使用 ICMP 发送回显请求。
- **HTTP（HyperText Transfer Protocol，超文本传输协议）**：基于 TCP，用于 Web 浏览器与服务器之间的数据传输。
- **HTTPS（HTTP Secure，安全超文本传输协议）**：在 HTTP 基础上加密（TLS/SSL）传输，保证数据安全性。
- **WebSocket**：基于 TCP 的全双工通信协议，适用于实时通信（如在线聊天、股票推送）。
