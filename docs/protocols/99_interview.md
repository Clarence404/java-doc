# 面试高频题

> 汇总网络协议核心知识的高频面试问题，完整解答见 <RouteLink to="/interview/11_network">开发总结-网络协议</RouteLink>

## 一、TCP

- **TCP 三次握手的过程？为什么不能是两次？**
- **TCP 四次挥手的过程？为什么挥手是四次而握手是三次？**
- **`TIME_WAIT` 过多的原因和解决方案？**
- **`CLOSE_WAIT` 过多说明了什么问题？如何排查？**
- **TCP 如何保证可靠性？（序列号 + ACK、重传、流量控制、拥塞控制）**
- **TCP 和 UDP 的区别？UDP 适合哪些场景？**

## 二、HTTP

- **HTTP/1.1、HTTP/2、HTTP/3 各有哪些改进？**
- **HTTP/2 的多路复用是如何实现的？什么是 Stream？**
- **HTTPS 握手的完整过程（TLS 1.3）？**
- **证书验证链是什么？如何防止中间人攻击？**
- **HTTP 常见状态码有哪些？502 和 504 的区别？**
- **GET 和 POST 的区别？**

## 三、DNS 与网络基础

- **DNS 解析的完整流程是什么？**
- **DNS 记录类型有哪些？（A、CNAME、MX、TXT）**
- **CDN 的工作原理是什么？**
- **正向代理和反向代理的区别？**

## 四、长连接方案

- **WebSocket 和 HTTP 长轮询有什么区别？**
- **SSE（Server-Sent Events）适合什么场景？**
- **gRPC 基于什么协议？有哪些优势？**  
  → 详见 <RouteLink to="/protocols/0_protocols_base">通信协议基础</RouteLink>

---

::: tip 完整解答
以上问题的详细解答见 <RouteLink to="/interview/11_network">开发总结-网络协议</RouteLink>
:::
