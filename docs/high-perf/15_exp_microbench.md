---
description: 用 JMH 量游标编解码、业务异常、JWT 验签、JSON 序列化与雪花发号、手写计时差在哪、放回一次请求占多少
---

# 微基准实验

> 前置阅读：[基准测试（JMH）](./4_benchmark)、[代码级优化](./6_code_optimization)、[耗时定位实验](./12_exp_locate)

微基准回答的是「这一小段代码哪种写法快、快多少」。本篇用 JMH 量 mall-evolution 里五段每个请求都会走到的纯 CPU 逻辑，再把结果放回一次请求里看占多大比例，基线为 JDK 21、JMH 1.37。

## 一、现象与假设

读代码的时候很容易觉得某一段「肯定慢」：游标用 JSON 加 Base64 再用正则解、每次拒绝请求都抛一个带调用栈的异常、发号器是一个 `synchronized` 方法。动手改之前有两件事要先量：它到底慢多少，以及这点时间在一次请求里占多少。

| 假设 | 怎么验证 |
|------|---------|
| 手写 `nanoTime` 循环量出来的数不可靠 | 同一段代码，手写计时的几种写法和 JMH 对照 |
| 游标的 JSON + Base64 + 正则比直接用十进制字符串慢很多 | 两种写法的编码、解码各一个基准 |
| 业务异常贵在采集调用栈，栈越深越贵 | 在 1、30、120 层调用之下抛异常，对照不采集调用栈、不抛异常 |
| JWT 验签是每个请求的固定成本，不小 | 用正式的解码器校验一个 HS256 令牌 |
| 雪花发号器的 `synchronized` 在多线程下是瓶颈 | 1 个线程和 8 个线程各能发多少 |
| 一页订单序列化成 JSON 是查询接口里最重的一步 | 领域对象转视图、视图转 JSON 分开量 |

## 二、实验设置

| 项 | 取值 |
|----|------|
| 被测代码 | mall-evolution 正式代码里的类，基准放在单独的 `bench` 模块里，依赖 `mall-common` 与 `mall-order` |
| JMH 参数 | 每个基准 2 个子进程，各预热 5 轮、测 5 轮，每轮 1 秒；堆 1GB；带 `-prof gc` 记每次调用分配的字节数 |
| 机器 | 20 核的开发机，跑的时候没有别的负载 |
| 遍数 | 整套完整跑 2 遍，下文按「第一遍 / 第二遍」列出；JMH 给的误差是 99.9% 置信区间的半宽 |

这一组不起服务、不连数据库，量的只是 CPU 上的那一段。

### 对应的代码

| 内容 | 在 mall-evolution 的哪里 |
|------|-------------------------|
| 订单列表游标的编解码 | [`OrderCursor`](https://github.com/Clarence404/mall-evolution/blob/main/mall-order/src/main/java/io/github/clarence404/mall/order/query/OrderCursor.java)、[`OrderCursorBenchmark`](https://github.com/Clarence404/mall-evolution/blob/main/bench/src/main/java/io/github/clarence404/mall/order/query/OrderCursorBenchmark.java) |
| 业务异常 | [`BizException`](https://github.com/Clarence404/mall-evolution/blob/main/mall-common/src/main/java/io/github/clarence404/mall/common/error/BizException.java)、[`BizExceptionBenchmark`](https://github.com/Clarence404/mall-evolution/blob/main/bench/src/main/java/io/github/clarence404/mall/common/error/BizExceptionBenchmark.java) |
| JWT 校验 | [`SecurityConfig#jwtDecoder`](https://github.com/Clarence404/mall-evolution/blob/main/mall-common/src/main/java/io/github/clarence404/mall/common/security/SecurityConfig.java)、[`JwtDecodeBenchmark`](https://github.com/Clarence404/mall-evolution/blob/main/bench/src/main/java/io/github/clarence404/mall/common/security/JwtDecodeBenchmark.java) |
| 订单视图与 JSON | [`OrderView`](https://github.com/Clarence404/mall-evolution/blob/main/mall-order/src/main/java/io/github/clarence404/mall/order/query/OrderView.java)、[`OrderViewJsonBenchmark`](https://github.com/Clarence404/mall-evolution/blob/main/bench/src/main/java/io/github/clarence404/mall/order/query/OrderViewJsonBenchmark.java) |
| 雪花发号 | [`SnowflakeIdGenerator`](https://github.com/Clarence404/mall-evolution/blob/main/mall-common/src/main/java/io/github/clarence404/mall/common/id/SnowflakeIdGenerator.java)、[`SnowflakeBenchmark`](https://github.com/Clarence404/mall-evolution/blob/main/bench/src/main/java/io/github/clarence404/mall/common/id/SnowflakeBenchmark.java) |
| 手写计时的反面例子 | [`NaiveTimingDemo`](https://github.com/Clarence404/mall-evolution/blob/main/bench/src/main/java/io/github/clarence404/mall/order/query/NaiveTimingDemo.java) |
| 运行脚本 | [`experiments/l-jmh/run.ps1`](https://github.com/Clarence404/mall-evolution/blob/main/experiments/l-jmh/run.ps1) |

基准直接调正式代码，对照写法写在基准类里。以游标为例：

```java
// bench/.../OrderCursorBenchmark.java（节选）
@State(Scope.Thread)
@BenchmarkMode(Mode.AverageTime)
@OutputTimeUnit(TimeUnit.NANOSECONDS)
@Warmup(iterations = 5, time = 1)
@Measurement(iterations = 5, time = 1)
@Fork(2)
public class OrderCursorBenchmark {

    private long id = 1_987_654_321_098_765_432L;
    private String cursor = OrderCursor.encode(id);
    private String plain = Long.toString(id);

    @Benchmark
    public Long decodeJsonBase64() {
        return OrderCursor.decode(cursor);      // 正式代码：Base64 解码，再用正则取出 id
    }

    @Benchmark
    public long decodePlain() {
        return Long.parseLong(plain);           // 对照：游标就是 id 的十进制字符串
    }
}
```

## 三、手写计时差在哪

先用最常见的办法量一遍游标解码：`System.nanoTime()` 套一个循环（[`NaiveTimingDemo`](https://github.com/Clarence404/mall-evolution/blob/main/bench/src/main/java/io/github/clarence404/mall/order/query/NaiveTimingDemo.java)）。

| 量法 | 每次调用（第一遍 / 第二遍） |
|------|------|
| 只调一次 | 426100ns / 185300ns |
| 连调 1000 次取平均 | 4593ns / 4455ns |
| 先预热 20 万次，再循环 100 万次取平均，连量 5 回，返回值不用 | 121–157ns |
| 同上，返回值累加起来最后用掉 | 122–139ns |
| JMH | 105ns ± 9 / 104ns ± 5 |

同一段代码，量法不同，结果从 0.4 毫秒到 104 纳秒，差出三个数量级：

- **只调一次**量到的是类加载、正则第一次编译和解释执行，和这段代码稳定下来的速度没有关系；两遍之间自己就差了一倍多
- **连调 1000 次**时代码还在解释器和第一层编译器里，比稳定值高 40 倍。写一个 `main` 方法循环一千次打印耗时，得到的就是这个数
- **预热之后**的手写循环是 121–157ns，比 JMH 高两到五成，5 回里的第 1 回总是最慢的那个（157ns、136ns）。这一段返回值用不用没有差别，JIT 没有把它当成死代码删掉

预热充分的手写计时在这个例子里没有错得离谱，差的是「怎么知道已经预热够了、这个数的波动有多大」。JMH 把预热、多个子进程、多轮测量和误差范围都做成了默认行为，结果自带「± 多少」，两遍之间能不能对上一眼就能看出来。死代码消除、常量折叠这些陷阱在 [基准测试（JMH）](./4_benchmark) 里有例子，这段代码恰好没有踩到，换一段就未必。

## 四、结果

每次调用的平均耗时与分配的内存（第一遍 / 第二遍）：

| 基准 | 耗时 | 每次调用分配 |
|------|------|------|
| 游标解码：JSON + Base64 + 正则（正式代码） | 105ns / 104ns | 480 字节 |
| 游标解码：十进制字符串 | 16.5ns / 17.1ns | 0 |
| 游标编码：JSON + Base64（正式代码） | 49.2ns / 47.7ns | 256 字节 |
| 游标编码：十进制字符串 | 16.9ns / 16.0ns | 64 字节 |
| JWT 校验（HS256 验签、校验签发者与有效期） | 6.77µs / 6.59µs | 19.0KB |
| JWT 校验并转成登录用户 | 6.93µs / 6.83µs | 20.0KB |
| 订单详情（1 单 2 条明细）：领域对象转视图 | 0.23µs / 0.23µs | 1.6KB |
| 订单详情：视图转 JSON | 0.84µs / 0.82µs | 2.4KB |
| 订单列表（一页 20 单）：领域对象转视图 | 0.70µs / 0.67µs | 4.2–4.4KB |
| 订单列表：视图转 JSON | 4.36µs / 4.33µs | 6.4KB |

![在不同深度的调用栈下抛一次业务异常的耗时](../assets/high-perf/exp-micro-exception.svg)

在不同深度的调用之下抛出、在最外层接住（第一遍 / 第二遍）：

| 调用深度 | 抛 `BizException`（正式代码） | 抛异常但不采集调用栈 | 不抛，逐层返回错误码 |
|------|------|------|------|
| 1 层 | 637ns / 632ns，728 字节 | 15.7ns / 15.8ns，40 字节 | 0.3ns |
| 30 层 | 2157ns / 2213ns，1.4KB | 812ns / 801ns，40 字节 | 10ns |
| 120 层 | 7656ns / 7489ns，3.5KB | 3380ns / 3391ns，40 字节 | 203ns / 200ns |

雪花发号（每毫秒发出的 ID 数，第一遍 / 第二遍）：

| 线程数 | 吞吐 |
|------|------|
| 1 | 3885 / 3872 |
| 8（合计） | 3885 / 3885 |

两遍的结果都落在彼此的误差范围里。

## 五、逐组分析

### 1、游标：慢 6 倍，但只有 90 纳秒

现在的写法解码比十进制字符串慢 6 倍，编码慢 3 倍，每次还多分配几百字节。假设成立。

但差出来的是 90 纳秒。一次订单列表请求在 mall-app 里要 1.5 毫秒，90 纳秒是它的十万分之六。[耗时定位实验](./12_exp_locate) 里专门把游标换成十进制字符串压了几轮，接口耗时和没换的落在同一个范围里，量不出差别。

游标写成 JSON 是有意的：客户端把它当不透明的字符串原样回传，以后换排序字段只改编解码（见 [接口设计](/project/3_api_design)）。**为十万分之六的耗时放弃这个扩展点不划算，这段代码不用改。**

### 2、业务异常：一半花在采集调用栈上，一半花在逐层退出上

在 120 层调用之下抛一个 `BizException` 是 7.5µs。这个深度不是随便取的：一个请求从 Tomcat 进到业务代码，中间隔着过滤器链、Spring MVC 和几层代理，通常有一百多层。

关掉调用栈采集之后是 3.4µs，省掉 55%。剩下的 3.4µs 是异常从 120 层里一层层退出来的成本，同样深度下逐层返回错误码只要 0.2µs。所以「重写 `fillInStackTrace` 就没有成本了」不对，只省一半多一点。

熔断或舱壁拒绝下单时走的就是这条路径。按过载时每秒拒绝 5000 次算，是每秒 38 毫秒的 CPU，不到一个核的 4%；被拒绝的请求本来就不再做别的事。换成不带调用栈的异常，日志里就少了出错位置，这个代价比 4% 的 CPU 大。**这一处也不改**；只有异常被当成正常流程、每个请求都要抛几次的代码，才值得动。

### 3、JWT 校验：时间不多，分配不少

校验一个 HS256 令牌是 6.6–6.8µs，转成登录用户再加 0.2µs。放在 1.5 毫秒的列表请求里不到 0.5%。

值得注意的是分配：每次 19–20KB，是这一组里最大的。网关和 mall-app 各校验一次，一个请求就是 40KB。[耗时定位实验](./12_exp_locate) 的分配采样里，mall-app 处理请求的线程有 13% 的分配落在验签的库里，网关是 13%，对得上。它不慢，但在给垃圾回收添工作量。

### 4、JSON：一页 20 单 4.3 微秒

订单列表一页 20 单，转视图 0.7µs，转 JSON 4.3µs，合计 5µs，占列表请求的 0.3%。「序列化是查询接口里最重的一步」不成立：最重的是 SQL 往返和框架，见 [耗时定位实验](./12_exp_locate)。

### 5、雪花发号：上限是算法定的，不是锁

1 个线程和 8 个线程的总吞吐一样，都是每毫秒 3880 个上下。看上去像是 `synchronized` 把 8 个线程串行化了，其实是算法自己的上限：序列号 12 位，一毫秒最多发 4096 个，发完就原地等到下一毫秒。量到的是这个上限的 95%。

换成无锁实现也不会超过 4096。下一单用 4 个 ID，压测里下单最高 400 单/秒，每秒 1600 个，离每秒 388 万的上限差三个数量级。

## 六、放回一次请求里

把上面几项放进一次订单列表请求（mall-app 里 1.5 毫秒，客户端看到的是 4.5 毫秒）：

| 这一步 | 耗时 | 占 mall-app 里的 1.5 毫秒 |
|------|------|------|
| JWT 校验并转成登录用户 | 6.9µs | 0.46% |
| 一页 20 单转视图、转 JSON | 5.0µs | 0.33% |
| 游标解码 + 编码 | 0.15µs | 0.01% |
| 生成一个雪花 ID（列表不用，下单用 4 个） | 0.26µs | — |
| 合计 | 约 12µs | 0.8% |

五段「看起来可能慢」的代码加起来不到一次请求的 1%。把它们全部优化到零，接口也只快 12 微秒。**微基准能说清哪种写法快，说不清值不值得改；值不值得要看它在整条链路里的占比**，这个占比来自压测和采样，不来自 JMH。

## 七、几条可以带走的做法

| 做法 | 依据 |
|------|------|
| 比较两种写法用 JMH，不用手写循环 | 同一段代码手写计时从 426µs 到 121ns 都量得出来；JMH 两遍之间差 1% |
| 先看占比再决定改不改 | 游标慢 6 倍，在请求里占十万分之六；五段代码合计不到 1% |
| 量耗时的同时量分配 | JWT 校验只占 0.5% 的时间，却是每个请求 40KB 的分配 |
| 异常不要用在每个请求都会走的正常流程上 | 120 层深度下一次 7.5µs；不采集调用栈也还要 3.4µs |
| 「多线程吞吐不涨」先看是不是算法自己有上限 | 发号器 1 线程和 8 线程都是每毫秒 3880 个，上限是 4096 |

## 八、复现

```powershell
.\experiments\l-jmh\run.ps1                              # 全部基准，约 8 分钟
.\experiments\l-jmh\run.ps1 -Include OrderCursor -Quick  # 只跑一组，少跑几轮先看个大概
```

结果在 `experiments/out/l-jmh/<时间>/` 下：`jmh.json` 是原始结果，`naive.csv` 是手写计时量出来的数。几点局限：

- 微基准里被测代码独占 CPU 缓存、分支预测也被反复训练过，放在真实请求里同一段代码会慢一些；这里的数是下限，占比的数量级不受影响
- 只在 JDK 21 上量过；JDK 25 没有跑
- 机器是开发机，没有关睿频、没有绑核；两遍之间的差别在 5% 以内，够用来比 3 倍、6 倍的差距，不够用来比百分之几的差距
- 异常基准的调用栈是同一个方法递归出来的，真实的调用栈每一层是不同的方法，采集的成本可能略有不同
- 第六节的 1.5 毫秒来自 [耗时定位实验](./12_exp_locate) 的服务端指标，是平均值

## 小结

- 手写计时的结果取决于量法：只调一次是 0.2–0.4 毫秒，循环一千次是 4.5 微秒，预热后是 121–157 纳秒，JMH 是 104 纳秒
- 游标的 JSON 写法比十进制字符串慢 6 倍，差 90 纳秒，在接口上量不出来，不改
- 120 层深度下抛一次业务异常 7.5 微秒，采集调用栈占 55%，其余是逐层退出的成本
- JWT 校验 6.8 微秒、每次分配 20KB；一页 20 单转 JSON 4.3 微秒
- 五段代码合计不到一次请求的 1%：微基准比的是写法，改不改要看占比

## 参考资料

- JMH 的用法与示例：[OpenJDK Code Tools: JMH](https://github.com/openjdk/jmh)
- 实验方案与参数：[mall-evolution experiments/README](https://github.com/Clarence404/mall-evolution/blob/main/experiments/README.md)

> 下一篇：[高并发总览](/high-con/0_overview) —— 单个请求够快之后，接下来解决流量大时系统如何扛得住。
