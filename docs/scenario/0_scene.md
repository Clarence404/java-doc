# 常见的场景问题

## 一、分布式系统主键如何处理？

### 1、节点生成 or 主键服务？

### 2、主键类型的选择？

## 二、针对于过期的订单，如何处理？

[处理过期订单，Redis不推荐，那如何做呢？](https://mp.weixin.qq.com/s/aHtIW4vmrl-0rUcPI3T7ZQ)

### 1、消息队列

### 2、Redisson DelayedQueue

### 3、Redis 过期监听

### 4、RabbitMQ 死信队列

### 5、时间轮

## 三、如何实现自动登录功能？

[https://docs.pingcode.com/baike/2210471](https://docs.pingcode.com/baike/2210471)

## 四、对外的Api安全问题如何保证？

Todo 按照自己的理解实现：

[Spring Cloud微服务，如何保证对外接口的安全？](https://mp.weixin.qq.com/s/kZZMQcAQh4XLF8sgsxT__g)

## 五、基于阻塞队列实现生产者和消费者模型

>
参考地址：[https://blog.csdn.net/m0_73381672/article/details/133690633](https://blog.csdn.net/m0_73381672/article/details/133690633)

核心方法代码：

[MyBlockingQueue](https://gitee.com/hello0709/clarence-java/raw/master/basic/src/main/java/com/dora/basic/juc/blockqueue/MyBlockingQueue.java)

测试运行代码：

[MyBlockingQueue.Test](https://gitee.com/hello0709/clarence-java/raw/master/basic/src/main/java/com/dora/basic/juc/blockqueue/Test.java)

## 六、如何设计一个高并发系统？

解答：<RouteLink to="/high-con/0_system_design">高并发-如何设计一个高并发系统？</RouteLink>

## 七、分布式场景下是否适用 synchronized 加锁机制？

解答：[分布式场景下是否适用 synchronized 加锁机制？](https://mp.weixin.qq.com/s/IGS_8pIc2wSKN88eMEJmSg)

## 八、100 亿分库分表 如何设计？

解答：[携程面试：100 亿分库分表 如何设计？](https://mp.weixin.qq.com/s/xQtKtaLG8xRMbK-8b3Rzuw)

## 九、说说 布隆过滤器 的实战应用？

todo： 解答

## 十、缓存数据消费模型：服务端推送 vs 客户端拉取，如何选择？

这是一个**经典的推送 vs 拉取**场景问题。在数据做了缓存（例如 Redis、Caffeine
等）以后，如何将缓存中的数据“及时、安全、稳定”地被后台接口消耗，选用“服务端推送”还是“客户端拉取”，需要根据场景进行权衡。

---

### 🎯 一句话结论：

> **如果数据对实时性要求高，推送更优；如果数据处理节奏不一、可容忍延迟，拉取更稳。**

---

### 🧭 两种方式比较

| 维度          | 服务端推送（Push）            | 客户端拉取（Pull）       |
|-------------|------------------------|-------------------|
| **实时性**     | ⭐⭐⭐⭐☆ 高                | ⭐⭐☆☆☆ 低（取决于轮询频率）  |
| **系统压力可控性** | ⭐⭐☆☆☆ 不可控，易突发          | ⭐⭐⭐⭐☆ 主动控制频率      |
| **可靠性**     | ⭐⭐☆☆☆ 需额外处理失败重试        | ⭐⭐⭐⭐☆ 拉不到就下次再拉    |
| **实现复杂度**   | ⭐⭐⭐⭐☆ 较高，需要连接/通道       | ⭐⭐☆☆☆ 简单易用        |
| **典型方案**    | WebSocket、SSE、MQ（间接推送） | HTTP 轮询、定时任务、批量拉取 |

---

### 🛠️ 场景建议

#### ✅ 适合用 **服务端推送** 的场景：

* 数据实时性要求高（如秒级指标、实时告警）
* 接收方处理能力强（不会被大量数据压垮）
* 已经有成熟 MQ 或推送架构（Kafka、RocketMQ、WebSocket）

例如：

```text
- 缓存中是实时统计数据，需立刻展示到前端 → WebSocket 推送
- 数据是任务调度触发的计算结果 → 使用 MQ 推送给消费者接口
```

#### ✅ 适合用 **客户端拉取** 的场景：

* 消费方处理能力不稳定（可能“吃不动”）
* 业务允许分钟级延迟
* 多个消费方需要不同节奏消费（如分页）

例如：

```text
- 缓存中是预加载的账单数据，后台服务每分钟批量拉取 → 安全且压力可控
- 某系统状态缓存更新，但后台服务仅需每 5 秒刷新 UI → 使用拉取
```

---

### 🔁 实践中的混合方式（推荐）

很多系统会结合使用两者：

> **Push for fast, Pull for reliable**
> 推送用于及时通知，拉取用于兜底保障。

比如：

* 缓存更新后通过 MQ 推送通知后台接口
* 后台接口如果错过了 MQ 消息，可以每分钟轮询缓存补救

---

### ✅ 建议总结

如果你是：

* **缓存是主动计算出来的结果** → 推荐客户端拉取，防止重复推送、资源浪费
* **缓存是事件驱动产生的数据** → 推荐服务端推送，保证及时反应
* **稳定性比实时性更重要** → 推荐拉取
* **两者都要求** → 推送通知 + 拉取校验（最佳实践）

