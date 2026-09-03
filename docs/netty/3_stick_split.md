# 粘包与拆包

TCP 是**字节流协议，不保证消息边界**——它只保证字节的顺序与可靠到达，"一条消息"是应用层自己的概念。粘包与拆包因此成为所有 TCP 应用必须解决的问题。

## 一、粘包（Sticky Packet）

**现象**：发送方连续发了 A、B 两条消息，接收方一次 `read` 读到了 `A+B`（或 `A+半个B`），无法区分边界。

**成因**：

- 发送端 Nagle 算法把多个小包攒成一个大包发出
- 接收端读取不及时，多条消息在内核缓冲区中累积，一次被读走

## 二、拆包（Packet Fragmentation）

**现象**：一条大消息被切成多段到达，接收方一次 `read` 只拿到半条消息。

**成因**：

- 消息超过 MSS（TCP 分段）或链路 MTU（IP 分片），传输层自动切分
- 发送/接收缓冲区（SO_SNDBUF / SO_RCVBUF）小于消息长度

> 粘包与拆包通常**同时发生**：一次 read 读到"上一条的尾巴 + 完整的一条 + 下一条的开头"。

## 三、四种解决方案

本质都是**在应用层协议中定义消息边界**：

| 方案 | 做法 | 优缺点 | 典型应用 |
|------|------|--------|---------|
| 定长消息 | 每条消息固定 N 字节，不足补齐 | 简单但浪费带宽、不灵活 | 早期定长指令协议 |
| 分隔符 | 消息尾加特殊分隔符（`\n`、`\r\n` 等）| 简单；但消息体不能含分隔符（需转义）| Redis RESP、SMTP |
| **长度字段 + 消息体（主流）** | 头部固定几字节声明消息体长度，先读头再按长度读体 | 灵活高效，二进制协议标配 | Dubbo、RocketMQ、自定义 IoT 协议 |
| 应用层协议自带边界 | 协议本身有结构化定界 | — | HTTP（Content-Length / chunked）|

## 四、Netty 内置解码器

Netty 把上述方案做成了开箱即用的解码器，加到 Pipeline 最前面即可：

| 解码器 | 对应方案 | 关键参数 |
|---|---|---|
| FixedLengthFrameDecoder | 定长消息 | frameLength |
| DelimiterBasedFrameDecoder | 分隔符消息 | maxFrameLength, delimiter |
| LineBasedFrameDecoder | 按行（`\n` / `\r\n`）| maxLength |
| **LengthFieldBasedFrameDecoder** | 长度字段（最通用）| 见下 |

```java
// 定长解码器
pipeline.addLast(new FixedLengthFrameDecoder(100));

// 分隔符解码器
ByteBuf delimiter = Unpooled.copiedBuffer("\r\n", CharsetUtil.UTF_8);
pipeline.addLast(new DelimiterBasedFrameDecoder(1024, delimiter));

// 长度字段解码器（最常用）
pipeline.addLast(new LengthFieldBasedFrameDecoder(
    65535,  // maxFrameLength
    0,      // lengthFieldOffset
    4,      // lengthFieldLength
    0,      // lengthAdjustment
    4       // initialBytesToStrip
));
```

> `LengthFieldBasedFrameDecoder` 五个参数的完整推导与帧格式设计，见 [自定义私有协议 § 二](6_custom_protocol.md#二lengthfieldbasedframedecoder-参数详解)

## 五、总结

- 粘包/拆包不是 bug，是 TCP 字节流本性的必然结果；UDP 有天然消息边界，不存在此问题
- 解决思路只有一个：**应用层协议自己定义边界**（定长 / 分隔符 / 长度字段）
- 用 Netty 时不要手写缓冲区拼接逻辑，内置 FrameDecoder 已处理了半包缓存与恶意超长帧防护（maxFrameLength）
