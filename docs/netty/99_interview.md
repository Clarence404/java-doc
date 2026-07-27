# 面试高频题

> 汇总 Netty 与 IO 模型的核心面试问题，完整解答见 <RouteLink to="/interview/10_netty">开发总结-Netty</RouteLink>

## 一、IO 模型

- **BIO、NIO、AIO 的区别？各适合什么场景？**
- **Java NIO 的核心组件是什么？（Channel、Buffer、Selector）**
- **`select`、`poll`、`epoll` 的区别？epoll 为什么比 select 高效？**
- **epoll 的 LT（水平触发）和 ET（边缘触发）有什么区别？**  
  → 详见 <RouteLink to="/netty/1_io_model">IO 模型</RouteLink>

## 二、Reactor 模型

- **Reactor 有哪三种模式？各有什么优缺点？**
- **Netty 用的是哪种 Reactor 模式？BossGroup 和 WorkerGroup 各做什么？**
- **EventLoop 是什么？为什么 Channel 要绑定固定的 EventLoop？**

## 三、Netty 核心

- **Netty 的核心组件有哪些？（Channel、EventLoop、Pipeline、Handler、ByteBuf）**
- **ChannelPipeline 的入站和出站事件各是什么方向？**
- **ByteBuf 相比 NIO ByteBuffer 有哪些优势？什么是零拷贝？**
- **Netty 高性能的原因有哪些？**

## 四、粘包拆包

- **什么是 TCP 粘包和拆包？产生原因是什么？**
- **Netty 有哪些解决粘包拆包的解码器？`LengthFieldBasedFrameDecoder` 的参数如何配置？**

## 五、长连接

- **WebSocket、SSE、HTTP 长轮询的区别？各适合什么场景？**
- **Netty 如何实现 WebSocket 握手升级？**
- **如何在 Netty 中实现心跳机制？`IdleStateHandler` 的作用是什么？**  
  → 详见 <RouteLink to="/netty/3_websocket">WebSocket</RouteLink>、<RouteLink to="/netty/4_sse">SSE</RouteLink>

---

::: tip 完整解答
以上问题的详细解答见 <RouteLink to="/interview/10_netty">开发总结-Netty</RouteLink>
:::
