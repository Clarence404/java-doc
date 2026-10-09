---
description: Netty 方向题目清单
---

# 面试高频题

> 汇总 Netty 与 IO 模型的核心面试问题，完整解答见 <RouteLink to="/interview/6_netty">开发总结 - Netty</RouteLink>

## 一、IO 模型

- **一次网络读操作分为哪两个阶段？五种 IO 模型的区别在哪里？**
- **BIO、NIO、AIO 的区别？为什么说 Java NIO 是"同步非阻塞"？**
- **`select`、`poll`、`epoll` 的区别？epoll 为什么比 select 高效？**
- **epoll 的 LT（水平触发）和 ET（边缘触发）有什么区别？Netty 用的是哪种？**  
  → 详见 <RouteLink to="/netty/1_io_model">IO 模型</RouteLink>

## 二、Reactor 模型

- **Reactor 有哪三种模式？各有什么优缺点？**
- **Netty 用的是哪种 Reactor 模式？BossGroup 和 WorkerGroup 各做什么？**
- **Reactor 和 Proactor 有什么区别？**  
  → 详见 <RouteLink to="/netty/2_reactor">Reactor 模型</RouteLink>

## 三、Netty 入门与核心组件

- **原生 JDK NIO 有哪些问题？Netty 是如何解决的？**
- **Netty 的核心组件有哪些？一次请求在 Netty 中是如何流动的？**
- **EventLoop 的工作机制是什么？为什么 Channel 要绑定固定的 EventLoop？**
- **ChannelPipeline 中入站和出站事件的传播方向？`ctx.write()` 和 `channel.write()` 有什么区别？**
- **什么样的 Handler 可以加 `@Sharable`？**
- **为什么不能在 EventLoop 线程里执行阻塞操作？业务逻辑应该放在哪里执行？**  
  → 详见 <RouteLink to="/netty/3_netty_desc">Netty 入门</RouteLink>、<RouteLink to="/netty/4_channel_eventloop">Channel 与 EventLoop</RouteLink>、<RouteLink to="/netty/5_pipeline_handler">Pipeline 与 Handler</RouteLink>

## 四、ByteBuf 与内存

- **ByteBuf 相比 NIO ByteBuffer 有哪些优势？**
- **ByteBuf 的引用计数是怎么回事？什么情况下需要手动 `release`？**
- **如何排查 Netty 的内存泄漏？**
- **Netty 的零拷贝体现在哪些地方？和操作系统层面的零拷贝有什么区别？**  
  → 详见 <RouteLink to="/netty/6_bytebuf">ByteBuf 与内存管理</RouteLink>

## 五、粘包拆包与协议设计

- **什么是 TCP 粘包和拆包？产生原因是什么？为什么 UDP 没有这个问题？**
- **Netty 有哪些解决粘包拆包的解码器？`ByteToMessageDecoder` 是如何处理半包的？**
- **`LengthFieldBasedFrameDecoder` 的五个参数如何配置？**
- **设计一个私有协议需要哪些字段？一条连接上如何让请求和响应一一对应？**  
  → 详见 <RouteLink to="/netty/7_stick_split">粘包与拆包</RouteLink>、<RouteLink to="/netty/8_custom_protocol">自定义私有协议</RouteLink>

## 六、长连接与推送

- **有了 TCP keepalive，为什么还需要应用层心跳？`IdleStateHandler` 的作用是什么？**
- **客户端断线重连应该如何实现？**
- **WebSocket、SSE、HTTP 长轮询的区别？各适合什么场景？**
- **WebSocket 服务集群部署时，如何把消息推送到连接在其他节点上的用户？**  
  → 详见 <RouteLink to="/netty/9_heartbeat">心跳与连接管理</RouteLink>、<RouteLink to="/netty/10_websocket">WebSocket</RouteLink>、<RouteLink to="/netty/11_sse">SSE</RouteLink>

## 七、生产实践

- **Netty 服务上线前需要调整哪些参数？**
- **对端消费很慢时，一直 `writeAndFlush` 会有什么问题？如何做背压？**
- **Netty 服务如何优雅停机？**
- **Netty 开发中有哪些常见的坑？**  
  → 详见 <RouteLink to="/netty/12_production">生产实践与调优</RouteLink>

---

::: tip 完整解答
以上问题的详细解答见 <RouteLink to="/interview/6_netty">开发总结 - Netty</RouteLink>
:::
