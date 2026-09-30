# ByteBuf 与内存管理

> **本篇目标**：掌握 ByteBuf 的结构与 API，理解池化与引用计数，能写出不泄漏内存的 Handler，并能定位泄漏问题。
>
> **前置阅读**：[核心组件：Channel、EventLoop 与 Pipeline](./4_core_components)

Pipeline 中流动的原始数据都是 `ByteBuf`。它是 Netty 高性能的关键之一，也是新手最容易踩坑的地方——**用错一次 `release()`，轻则报错，重则堆外内存慢慢泄漏直到进程崩溃**。

---

## 一、为什么不用 NIO ByteBuffer

**JDK 的 `ByteBuffer` 只有一个 position 指针、容量固定、没有池化，用在高并发网络程序里既难用又低效。** Netty 因此重新设计了 `ByteBuf`：

| 特性 | NIO `ByteBuffer` | Netty `ByteBuf` |
|------|-----------------|----------------|
| 读写切换 | 共用 position，读前必须 `flip()`，忘了就读错 | `readerIndex` / `writerIndex` 双指针，无需切换 |
| 容量 | 创建后固定，写满只能自己新建再拷贝 | 写入时按需**自动扩容** |
| 内存复用 | 不支持池化，频繁分配堆外内存代价高 | 支持池化（`PooledByteBufAllocator`） |
| 生命周期 | 依赖 GC 回收，堆外内存释放时机不可控 | **引用计数**，用完立即归还 |
| 组合与切片 | 能力有限 | `CompositeByteBuf`、`slice`、`wrappedBuffer`，减少拷贝 |
| API 风格 | 普通调用 | 链式调用，`readInt / writeLong` 等方法齐全 |

---

## 二、结构与常用 API

### 1、三个区域、两个指针

**ByteBuf 用 `readerIndex` 和 `writerIndex` 把底层数组分成三段：已读（可丢弃）、可读、可写。**

![ByteBuf 内存布局](../assets/netty/bytebuf-layout.svg)

| 区域 | 范围 | 含义 |
|------|------|------|
| 可丢弃字节 | `[0, readerIndex)` | 已经读过的数据，可通过 `discardReadBytes()` 回收空间 |
| 可读字节 | `[readerIndex, writerIndex)` | 尚未读取的数据，长度 = `readableBytes()` |
| 可写字节 | `[writerIndex, capacity)` | 剩余可写空间，长度 = `writableBytes()` |

`capacity` 是当前容量，`maxCapacity` 是扩容上限（默认 `Integer.MAX_VALUE`）。

### 2、read / write 与 get / set

**`read*` / `write*` 会移动指针，`get*` / `set*` 按绝对位置访问、不移动指针。**

```java
ByteBuf buf = ctx.alloc().buffer(16);

buf.writeShort(0xABCD);       // writerIndex: 0 → 2
buf.writeInt(100);            // writerIndex: 2 → 6

short magic = buf.readShort(); // readerIndex: 0 → 2
int peek = buf.getInt(2);      // 按下标读取，readerIndex 仍为 2
buf.setByte(0, 0x01);          // 按下标修改，指针不动

buf.skipBytes(4);              // 跳过 4 字节，readerIndex: 2 → 6
boolean more = buf.isReadable(); // false，已经没有可读字节
```

常用辅助方法：

| 方法 | 作用 |
|------|------|
| `markReaderIndex()` / `resetReaderIndex()` | 标记读指针，数据不够时回退（手写解码器常用） |
| `readableBytes()` / `writableBytes()` | 可读 / 可写字节数 |
| `readBytes(byte[])` / `readSlice(n)` | 读出到数组（拷贝） / 切出一段视图（不拷贝） |
| `discardReadBytes()` | 把可读数据挪到数组头部，回收已读空间（**会发生内存拷贝**，不要频繁调用） |
| `clear()` | 两个指针归零，数据本身不清除 |

### 3、派生缓冲区：共享还是拷贝

**`slice` / `duplicate` 与原 ByteBuf 共享同一块内存，只是拥有独立的读写指针；`copy` 才是真正复制一份。**

| 方法 | 内存 | 读写指针 | 引用计数 |
|------|------|---------|---------|
| `slice()` / `slice(index, len)` | 共享（可读区域的一段视图） | 独立 | **与原 buf 共用**，不增加计数 |
| `duplicate()` | 共享（整个缓冲区） | 独立（初始值复制自原 buf） | 与原 buf 共用 |
| `retainedSlice()` / `retainedDuplicate()` | 共享 | 独立 | 计数 +1，派生对象需要单独 `release()` |
| `copy()` | **独立的新内存** | 独立 | 独立，从 1 开始 |

::: warning 共享内存的副作用
通过 slice 修改数据，原 buf 中对应位置也会变化；原 buf 被释放后，它的 slice 也随之失效。需要跨 Handler 或跨线程保留一段数据时，用 `retainedSlice()` 或 `copy()`。
:::

### 4、自动扩容

写入超过 `capacity` 时，ByteBuf 会自动扩容，规则大致为：

- 所需容量不超过 **4MB** 阈值时，从 64 字节起**翻倍**增长，直到满足需求
- 超过 4MB 后，每次按 **4MB 步长**增长，避免翻倍造成大量浪费
- 超过 `maxCapacity` 时抛出 `IndexOutOfBoundsException`

扩容意味着重新分配内存和拷贝数据，**能预估大小时，分配时直接指定初始容量**更高效。

---

## 三、ByteBuf 的分类

ByteBuf 可以从"内存放在哪"和"内存是否复用"两个维度分类。

### 1、按内存位置：Heap / Direct / Composite

| 类型 | 内存位置 | 优点 | 缺点 | 适用场景 |
|------|---------|------|------|---------|
| 堆缓冲区（Heap） | JVM 堆，底层是 `byte[]` | 分配快，可直接访问数组，受 GC 管理 | 写 Socket 前 JDK 需要先复制到堆外 | 业务层数据处理、编解码中间结果 |
| 直接缓冲区（Direct） | 堆外内存 | IO 时无需再拷贝，不增加 GC 压力 | 分配和释放成本高（所以要池化） | **网络 IO 读写**（Netty 默认） |
| 复合缓冲区（Composite） | 由多个 ByteBuf 逻辑拼成 | 拼接时不拷贝数据 | 随机访问略慢，结构更复杂 | 协议头 + 协议体组装 |

### 2、按是否复用：Pooled / Unpooled

| 类型 | 分配器 | 特点 |
|------|--------|------|
| 池化 | `PooledByteBufAllocator` | 从内存池取、用完归还，分配快、GC 压力小，**生产推荐** |
| 非池化 | `UnpooledByteBufAllocator` / `Unpooled` 工具类 | 每次新分配，简单直接，适合测试和一次性数据 |

### 3、如何获取 ByteBuf

**在 Handler 里优先用 `ctx.alloc()`**，它返回 Channel 配置的分配器，能和 Netty 内部的池化策略保持一致。

```java
ByteBuf a = ctx.alloc().buffer(256);         // 按分配器偏好（通常为直接内存）
ByteBuf b = ctx.alloc().heapBuffer(256);     // 明确使用堆内存
ByteBuf c = ctx.alloc().directBuffer(256);   // 明确使用直接内存
CompositeByteBuf d = ctx.alloc().compositeBuffer();

ByteBuf e = PooledByteBufAllocator.DEFAULT.buffer(); // 在 Handler 之外使用池化分配器
ByteBuf f = Unpooled.copiedBuffer("hi", CharsetUtil.UTF_8); // 非池化，常用于测试
```

默认分配器由系统属性 `io.netty.allocator.type` 决定：Netty 4.1 中非 Android 平台默认 `pooled`，Android 默认 `unpooled`。

::: tip 版本差异
Netty 4.2 引入了自适应分配器（`AdaptiveByteBufAllocator`）并将其作为新的默认值，可以通过 `-Dio.netty.allocator.type=pooled` 切回。升级大版本时注意核对。
:::

---

## 四、引用计数：谁最后使用，谁负责释放

**池化的 ByteBuf 不能等 GC 回收，否则内存池就失去了意义，因此 Netty 用引用计数（`ReferenceCounted`）显式管理生命周期。**

### 1、基本规则

| 操作 | 效果 |
|------|------|
| 分配后 | `refCnt() == 1` |
| `retain()` | 计数 +1，表示"我也要用它" |
| `release()` | 计数 -1；**归零时内存被回收**（池化的归还内存池） |
| 计数为 0 后再访问 | 抛出 `IllegalReferenceCountException` |

核心原则只有一条：**ByteBuf 在 Handler 之间传递时，所有权随之转移；最后一个使用它的人负责释放。**

### 2、入站：消费了就释放，传下去就不管

**如果你在 `channelRead` 里把消息"吃掉"了（不再往后传），就必须释放它；如果调用了 `fireChannelRead` 把它传给下一个 Handler，就不要再释放。**

```java
// 写法一：继承 Adapter，手动释放
public class RawHandler extends ChannelInboundHandlerAdapter {
    @Override
    public void channelRead(ChannelHandlerContext ctx, Object msg) {
        ByteBuf buf = (ByteBuf) msg;
        try {
            process(buf);                    // 在这里被消费，不再向后传递
        } finally {
            ReferenceCountUtil.release(msg); // 消费方负责释放
        }
    }
}

// 写法二：继承 SimpleChannelInboundHandler，channelRead0 返回后自动释放
public class AutoReleaseHandler extends SimpleChannelInboundHandler<ByteBuf> {
    @Override
    protected void channelRead0(ChannelHandlerContext ctx, ByteBuf buf) {
        process(buf); // 无需手动 release
    }
}

// 写法三：只是检查一下，然后继续传递，不释放
public class PeekHandler extends ChannelInboundHandlerAdapter {
    @Override
    public void channelRead(ChannelHandlerContext ctx, Object msg) {
        log.debug("收到 {} 字节", ((ByteBuf) msg).readableBytes());
        ctx.fireChannelRead(msg); // 所有权交给下一个 Handler
    }
}
```

消息如果一路没人处理，最终到达 TailContext，它会帮你释放并打印一条 debug 日志——但不要依赖这个兜底。

### 3、出站：write 之后交给 Netty

**把 ByteBuf 交给 `write` / `writeAndFlush` 后，所有权就转移给了 Netty，数据写出（或写失败）后由 Netty 负责释放，调用方不要再 `release()`。**

网上常见的"`writeAndFlush(buf.retain())` + `finally { buf.release() }`"写法虽然计数上能对齐，但既绕又容易写错。正确的最小写法是：

```java
// 正确：分配 → 写入数据 → 交给 Netty，结束
ByteBuf buf = ctx.alloc().buffer();
buf.writeBytes(data);
ctx.writeAndFlush(buf);

// 错误：写完再手动释放，Netty 写出后会再释放一次 → IllegalReferenceCountException
ByteBuf bad = ctx.alloc().buffer();
bad.writeBytes(data);
ctx.writeAndFlush(bad);
bad.release(); // 多释放了一次
```

**只有同一个 ByteBuf 要发给多个 Channel 时才需要 `retain()`**——每多写一次就多一个"使用者"：

```java
ByteBuf msg = ctx.alloc().buffer().writeBytes(data);
for (Channel ch : channels) {
    ch.writeAndFlush(msg.retainedDuplicate()); // 每个 Channel 一个独立指针的视图，计数各 +1
}
msg.release(); // 释放自己持有的那一份
```

::: tip
群发场景可以直接使用 `ChannelGroup.writeAndFlush(msg)`，它内部会为每个 Channel 做 `retainedDuplicate()` 并在最后释放原始消息。
:::

### 4、编解码器帮你做了什么

| 组件 | 自动释放行为 |
|------|------------|
| `SimpleChannelInboundHandler` | `channelRead0` 返回后释放入参 |
| `ByteToMessageDecoder` | 自己管理累积缓冲区，已读完的部分自动释放 |
| `MessageToMessageDecoder` | `decode` 返回后释放入参（需要保留的对象要 `retain()`） |
| `MessageToByteEncoder` | `encode` 返回后释放入参消息 |

---

## 五、内存泄漏检测

**忘记 `release()` 不会立刻报错，而是让池化内存或堆外内存慢慢耗尽。Netty 内置了 `ResourceLeakDetector`，在 ByteBuf 被 GC 回收但计数未归零时打印 `LEAK:` 日志。**

### 1、检测级别

| 级别 | 采样 | 报告内容 | 适用 |
|------|------|---------|------|
| `DISABLED` | 不检测 | 无 | 不推荐 |
| `SIMPLE`（默认） | 抽样（默认约每 128 次分配采样 1 次，不到 1%） | 只报告"有泄漏"及创建位置 | 生产环境 |
| `ADVANCED` | 抽样 | 额外记录最近若干次访问位置 | 线上排查 |
| `PARANOID` | **每次分配都检测** | 同 ADVANCED | 单元测试、集成测试 |

```bash
# 测试环境开启最严格的检测
-Dio.netty.leakDetection.level=paranoid
```

### 2、如何阅读 LEAK 日志

开启 ADVANCED / PARANOID 后，日志结构大致如下：

```text
LEAK: ByteBuf.release() was not called before it's garbage-collected. ...
Recent access records:
#1:
    io.netty.buffer.AdvancedLeakAwareByteBuf.readBytes(...)
    com.example.RawHandler.channelRead(RawHandler.java:25)   ← 最后访问位置
    ...
Created at:
    io.netty.buffer.PooledByteBufAllocator.newDirectBuffer(...)
    ...
```

**排查思路**：从 `Recent access records` 的 `#1`（最后一次访问）开始看，找到你自己的类——泄漏几乎总是发生在"最后访问它的那个 Handler"里，检查它是否既没有释放、也没有向后传递。

### 3、典型泄漏原因

- 继承 `ChannelInboundHandlerAdapter` 消费了消息，却没有 `release()`
- 在某个分支 `return` 提前退出（如校验失败），忘了释放
- 把 ByteBuf 交给业务线程异步处理，异常路径上没有释放
- 使用 `retainedSlice()` / `retain()` 后，没有配对的 `release()`

---

## 六、零拷贝：两个层面要分清

**"零拷贝"在 Netty 语境里有两层含义：操作系统层面的真零拷贝，以及 Netty 在用户态的"少拷贝"优化。**

### 1、操作系统层：FileRegion 与 sendfile

发送文件时，`DefaultFileRegion` 底层调用 `FileChannel.transferTo()`，在 Linux 上对应 `sendfile` 系统调用，**数据直接从页缓存送到 Socket 缓冲区，不经过用户态**。原理见 [IO / NIO 专题 · 零拷贝](/java/18_topic_io#四、零拷贝)。

```java
RandomAccessFile file = new RandomAccessFile("app.log", "r");
ctx.writeAndFlush(new DefaultFileRegion(file.getChannel(), 0, file.length()));
```

::: warning
启用 TLS（`SslHandler`）后数据必须在用户态加密，无法使用 `FileRegion`，需要改用 `ChunkedWriteHandler` + `ChunkedFile` 分块发送。
:::

### 2、Netty 用户态：避免多余的内存复制

| 手段 | 作用 |
|------|------|
| `CompositeByteBuf` | 协议头和协议体各自一个 ByteBuf，逻辑上拼成一个整体，不复制数据 |
| `Unpooled.wrappedBuffer(...)` | 把现有的 `byte[]` 或多个 ByteBuf 包装成一个 ByteBuf，不复制 |
| `slice` / `readSlice` | 从大缓冲区中切出一段视图交给后续处理，不复制 |

```java
// 头和体分别编码后组合发送，全程不拷贝
CompositeByteBuf frame = ctx.alloc().compositeBuffer();
frame.addComponents(true, header, body); // true：同时推进 writerIndex
ctx.writeAndFlush(frame);
```

### 3、直接内存：省掉堆到内核的中转

使用堆内存写 Socket 时，JDK 会先把数据复制到一块临时的堆外内存，再交给内核。**Netty 的 IO 读写默认使用直接内存，省掉了这一次拷贝**——这也是 Direct ByteBuf 需要池化的原因：分配贵，就复用。

---

## 七、内存池原理（简述）

**`PooledByteBufAllocator` 借鉴了 jemalloc 的思想：按大小分级管理，线程优先从本地缓存分配，从而减少锁竞争、内存碎片和 GC。** 以下为结构概览，具体数值随版本有所调整。

| 层级 | 说明 |
|------|------|
| `PoolArena` | 内存分配的"区域"，默认数量与 CPU 核数相关（约 2 × 核数）；线程被分配到不同 Arena，降低竞争 |
| `PoolThreadCache` | 每个线程的本地缓存，释放的小块内存先缓存在线程本地，下次分配直接命中，无需加锁 |
| `PoolChunk` | 向操作系统申请的大块连续内存（默认数 MB 级别：早期 4.1 版本为 16MB，较新的 4.1.x 调整为 4MB） |
| Page | Chunk 内的基本分配单位，默认 **8KB** |
| Subpage | 把 Page 再切成等长小块，服务小对象分配 |

按请求大小，分配走不同路径：

- **小内存**：从 Subpage 中分配固定规格的小块
- **中等内存**：在 Chunk 中分配连续的若干 Page
- **大内存**（超过 Chunk 大小）：不进池，直接单独分配

为什么能提升性能：

- **减少 GC**：内存反复复用，堆外内存不依赖 GC 回收
- **减少碎片**：按规格分级，同规格的内存块集中管理
- **减少竞争**：多 Arena 分散线程 + 线程本地缓存，大部分分配无需加锁

---

## 小结

- ByteBuf 用**读写双指针**替代 `flip()`，支持自动扩容、池化和引用计数
- `read / write` 移动指针，`get / set` 不移动；`slice / duplicate` 共享内存，`copy` 才复制
- **谁最后使用谁释放**：入站消费了就 release，传下去就不管；出站交给 write 后不要再 release
- 测试环境用 `-Dio.netty.leakDetection.level=paranoid` 尽早暴露泄漏，按 `#1` 访问记录定位
- 零拷贝分两层：OS 级 `FileRegion` / sendfile，Netty 用户态的 Composite / wrap / slice

> 下一篇：[粘包与拆包](./6_stick_split) —— TCP 只保证字节流，一条完整的消息从哪开始、到哪结束，要靠我们自己界定。
