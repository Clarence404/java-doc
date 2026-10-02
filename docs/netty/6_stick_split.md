---
description: 成因与复现、四种界定方案、Netty 内置帧解码器及其工作原理
---

# 粘包与拆包

> **本篇目标**：理解 TCP 粘包 / 拆包的成因，掌握 Netty 内置帧解码器的用法与工作原理。
>
> **前置阅读**：[ByteBuf 与内存管理](./5_bytebuf)

**TCP 是字节流协议，只保证字节有序、可靠地到达，不保证消息边界。** "一条消息"是应用层的概念，TCP 并不知道——所以粘包与拆包是所有基于 TCP 的应用都必须处理的问题，而不是 bug。

---

## 一、现象：读到的和写出的对不上

**发送方调用了几次 write，接收方就读到几条消息——这个假设在 TCP 上不成立。**

| 现象 | 描述 |
|------|------|
| 粘包（Sticky Packet） | 发送方连续发出 A、B 两条消息，接收方一次读到 `A+B` |
| 拆包（Packet Fragmentation） | 一条大消息被切成多段，接收方一次只读到半条 |
| 同时发生 | 一次读到"上一条的尾巴 + 完整的一条 + 下一条的开头"——这才是最常见的情况 |

---

## 二、为什么 TCP 会这样

**根本原因是 TCP 面向字节流，发送与接收之间隔着多层缓冲区，每一层都可能合并或切分数据。**

| 成因 | 位置 | 效果 |
|------|------|------|
| Nagle 算法 | 发送端 | 把多个小包攒成一个大包再发，减少网络上的小报文 |
| 发送缓冲区（`SO_SNDBUF`） | 发送端 | 多次 write 的数据在缓冲区中连成一片，由内核决定何时、按多大发出 |
| MSS / MTU 限制 | 传输层 / 网络层 | 超过 MSS 的数据被 TCP 分段，超过链路 MTU 的被分片 |
| 接收缓冲区（`SO_RCVBUF`） | 接收端 | 应用读取不及时，多条消息在内核中累积，一次被读走 |
| 应用读取粒度 | 接收端 | 每次 read 只取缓冲区当前的内容，与发送端 write 的次数无关 |

::: tip 关掉 Nagle 也解决不了
Netty 默认就开启了 `TCP_NODELAY`（即关闭 Nagle 算法），但粘包照样会发生——接收端缓冲区的累积、MSS 切分都与 Nagle 无关。**唯一可靠的解法是在应用层协议中定义消息边界。**
:::

---

## 三、复现：不做任何处理会怎样

**客户端连续发送 100 条短消息，服务端不加任何帧解码器，直接打印每次读到的内容。**

```java
// 客户端：连接建立后连续发送 100 条消息
public class SenderHandler extends ChannelInboundHandlerAdapter {
    @Override
    public void channelActive(ChannelHandlerContext ctx) {
        for (int i = 0; i < 100; i++) {
            ByteBuf buf = ctx.alloc().buffer();
            buf.writeCharSequence("Hello Netty #" + i + ";", CharsetUtil.UTF_8);
            ctx.writeAndFlush(buf);
        }
    }
}

// 服务端：Pipeline 中只有这一个 Handler，没有帧解码器
public class PrintHandler extends SimpleChannelInboundHandler<ByteBuf> {
    private int count;

    @Override
    protected void channelRead0(ChannelHandlerContext ctx, ByteBuf msg) {
        count++;
        System.out.printf("第 %d 次读取，%d 字节：%s%n",
                count, msg.readableBytes(), msg.toString(CharsetUtil.UTF_8));
    }
}
```

**预期输出**（每次运行都可能不同）：

- 读取次数**远少于 100 次**，在本机回环网络上甚至可能只有一两次
- 单次读取包含多条消息，例如 `Hello Netty #0;Hello Netty #1;Hello Netty #2;...`
- 某次读取的结尾是半条消息，例如 `...Hello Netty #57;Hel`，剩下的 `lo Netty #57;` 出现在下一次读取的开头

如果业务代码按"一次 channelRead = 一条消息"处理，数据就全乱了。

---

## 四、解决思路：在应用层定义边界

**所有方案的本质都一样：让接收方能从字节流中识别出"一条消息在哪里结束"。**

| 方案 | 做法 | 优点 | 缺点 | 典型应用 |
|------|------|------|------|---------|
| 定长消息 | 每条消息固定 N 字节，不足补齐 | 实现最简单 | 浪费带宽，不适合变长数据 | 早期定长指令协议 |
| 分隔符 | 消息末尾追加特殊字符，如 `\n`、`\r\n` | 简单直观，便于调试 | 消息体不能含分隔符（否则要转义），需逐字节扫描 | Redis RESP、SMTP、FTP |
| **长度字段 + 消息体（主流）** | 消息头用固定字节声明消息体长度 | 灵活高效，支持任意二进制 | 需要设计帧格式 | Dubbo、RocketMQ、IoT 私有协议 |
| 协议自带边界 | 直接使用已有协议的定界规则 | 无需自己设计 | 依赖具体协议 | HTTP（`Content-Length` / chunked） |

---

## 五、Netty 内置帧解码器

**Netty 把上述方案都实现成了开箱即用的解码器，放在 Pipeline 最前面，后续 Handler 收到的就是"一条完整的消息"。**

| 解码器 | 对应方案 | 关键参数 |
|--------|---------|---------|
| `FixedLengthFrameDecoder` | 定长消息 | `frameLength` |
| `DelimiterBasedFrameDecoder` | 分隔符 | `maxFrameLength`、`delimiter` |
| `LineBasedFrameDecoder` | 按行（`\n` 或 `\r\n`） | `maxLength` |
| **`LengthFieldBasedFrameDecoder`** | 长度字段（最通用） | 五个参数，见下文 |

```java
// 定长：每 100 字节一条
pipeline.addLast(new FixedLengthFrameDecoder(100));

// 分隔符：以 \r\n 结尾，单条最长 1024 字节
ByteBuf delimiter = Unpooled.copiedBuffer("\r\n", CharsetUtil.UTF_8);
pipeline.addLast(new DelimiterBasedFrameDecoder(1024, delimiter));

// 按行：单行最长 1024 字节
pipeline.addLast(new LineBasedFrameDecoder(1024));

// 长度字段（最常用）：帧头 4 字节长度 + 消息体
pipeline.addLast(new LengthFieldBasedFrameDecoder(
    65535,  // maxFrameLength：单帧最大字节数
    0,      // lengthFieldOffset：长度字段从第 0 字节开始
    4,      // lengthFieldLength：长度字段占 4 字节
    0,      // lengthAdjustment：长度值就是消息体长度，无需修正
    4       // initialBytesToStrip：交给下游前去掉 4 字节长度头，只保留消息体
));
```

对于上面的复现示例，只需在服务端 `PrintHandler` 前加一个分隔符解码器（以 `;` 为分隔符），就能稳定地收到 100 条独立消息。

::: tip
`LengthFieldBasedFrameDecoder` 五个参数的完整推导与帧格式设计，见 [自定义私有协议 · 二、LengthFieldBasedFrameDecoder 参数详解](./7_custom_protocol#二、lengthfieldbasedframedecoder-参数详解)。
:::

---

## 六、FrameDecoder 是如何工作的

**所有帧解码器都继承自 `ByteToMessageDecoder`：它维护一个累积缓冲区，把每次读到的数据追加进去，然后反复尝试解码，直到剩余数据不足一帧为止。**

### 1、处理流程

每次 `channelRead` 收到一段新数据时：

1. **累积**：把新数据追加到内部的累积缓冲区（cumulation）
2. **循环解码**：只要还有可读字节，就调用子类的 `decode(ctx, in, out)`
   - 数据足够一帧：子类读出一帧并放入 `out`，继续循环尝试下一帧
   - 数据不够一帧：子类什么都不读、直接返回，循环结束，**半包留在缓冲区等下次数据到达**
3. **向后传递**：把 `out` 中解出的每一帧依次 `fireChannelRead` 给下一个 Handler
4. **清理**：累积缓冲区读完就释放；有残留则保留，并定期丢弃已读部分回收空间

::: warning 自己写 decode 时的约定
数据不够时**必须不读取任何字节就返回**（或读之前 `markReaderIndex`、不够时 `resetReaderIndex`），否则框架无法判断"需要更多数据"。反过来，如果产出了消息却一个字节都没读，Netty 会抛出 `DecoderException` 防止死循环。
:::

### 2、两种累积策略

| 策略 | 做法 | 特点 |
|------|------|------|
| `MERGE_CUMULATOR`（默认） | 把新数据**复制**到一块连续的缓冲区中，不够时扩容 | 连续内存，解码时访问快；数据会被复制 |
| `COMPOSITE_CUMULATOR` | 用 `CompositeByteBuf` 把新数据作为组件**挂上去** | 避免复制；但索引计算更复杂，部分场景反而更慢 |

可通过 `decoder.setCumulator(ByteToMessageDecoder.COMPOSITE_CUMULATOR)` 切换，一般保持默认即可。

### 3、防御超长帧：maxFrameLength

**帧解码器的最大长度参数不是可选项，而是安全防线。** 恶意客户端只要在长度字段里填一个巨大的值，解码器就会一直累积数据等待"完整帧"，最终撑爆内存。

- 超过 `maxFrameLength`（或 `maxLength`）时，解码器会丢弃该帧并抛出 `TooLongFrameException`
- 建议按业务真实上限设置，并在异常处理 Handler 中**直接关闭连接**

---

## 七、发送端配套：LengthFieldPrepender

**接收端用长度字段解码，发送端就要在每条消息前写入长度。** 手动计算容易出错，Netty 提供了 `LengthFieldPrepender` 自动完成：

```java
@Override
protected void initChannel(SocketChannel ch) {
    ch.pipeline()
      // 入站：按 2 字节长度头拆帧，并去掉长度头
      .addLast(new LengthFieldBasedFrameDecoder(65535, 0, 2, 0, 2))
      // 出站：自动在消息前加 2 字节长度头（值 = 消息体长度）
      .addLast(new LengthFieldPrepender(2))
      // 字符串编解码
      .addLast(new StringDecoder(CharsetUtil.UTF_8))
      .addLast(new StringEncoder(CharsetUtil.UTF_8))
      .addLast(new ChatHandler());
}
```

两端使用同样的配置后，业务 Handler 直接收发 `String`，完全不用关心边界。出站方向的执行顺序是 `StringEncoder → LengthFieldPrepender`（Tail → Head），原因见 [核心组件 · Pipeline](./4_core_components)。

::: tip UDP 为什么没有这个问题
UDP 是面向数据报的协议，每个数据报都有天然边界：发送方发一个，接收方就收到一个完整的（或者丢失）。所以帧解码器只存在于 TCP 场景。
:::

---

## 小结

- 粘包 / 拆包是 TCP **字节流**本性的必然结果，关闭 Nagle 也无法避免
- 解决思路只有一个：**在应用层定义消息边界**——定长、分隔符、长度字段（主流）
- Netty 内置 `FixedLength` / `Delimiter` / `Line` / `LengthField` 四种帧解码器，放在 Pipeline 最前面
- 帧解码器基于 `ByteToMessageDecoder` 的累积缓冲区：追加 → 循环解码 → 半包留待下次
- 一定要设置合理的 `maxFrameLength` 防御恶意超长帧；发送端用 `LengthFieldPrepender` 配套

> 下一篇：[自定义私有协议](./7_custom_protocol) —— 从零设计一个带魔数、版本、类型和长度字段的二进制协议，并实现完整的编解码。
