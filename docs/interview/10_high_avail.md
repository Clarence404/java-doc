# 开发总结-三高架构

> 精华提炼，细节详见 [高性能](/high-perf/0_overview) / [高并发](/high-con/0_overview) / [高可用](/high-avail/0_overview)
>
> Java 并发基础（线程池参数、锁、volatile、CAS、JUC 工具）见 [开发总结-Java 并发](/interview/9_concurrent)，缓存穿透 / 击穿 / 雪崩见 [开发总结-缓存](/interview/3_cache)

**三者关系**：高性能关注**单次请求有多快**（RT、资源效率）；高并发关注**同时能扛多少**（吞吐、扩展性）；高可用关注**出故障时还能不能用**（冗余、隔离、自愈）。三者互相影响：性能越好，同等资源下可承载的并发越高；过载保护（限流熔断）又是高并发走向高可用的前提。

## 高性能

### 一、如何定位性能瓶颈？USE 和 RED 方法是什么？

**两套方法论，一个看资源，一个看服务**：

| 方法 | 对象 | 三个维度 | 典型问题 |
|------|------|---------|---------|
| **USE** | 资源（CPU、内存、磁盘、网卡、连接池、线程池）| **U**tilization 使用率、**S**aturation 饱和度（排队）、**E**rrors 错误 | "哪个资源不够用？" |
| **RED** | 服务 / 接口 | **R**ate 请求率、**E**rrors 错误率、**D**uration 耗时分布 | "哪个接口慢？慢在哪一段？" |

**排查路径（自顶向下）**：

1. **RED 定位接口**：监控大盘找到 QPS / 错误率 / P99 异常的接口，结合链路追踪找到耗时最长的 Span（DB？下游 RPC？本地计算？）
2. **USE 定位资源**：对该节点逐项检查资源，**饱和度比使用率更能说明问题**（CPU 60% 但 run queue 很长、连接池活跃数打满且有等待线程）
3. **下钻到代码**：CPU 高 → 火焰图找热点方法；等待多 → 线程 Dump 看阻塞在锁 / IO / 连接获取；GC 频繁 → GC 日志 + 堆分析
4. **验证**：修改后压测对比，确认指标改善而不是问题转移

| 层面 | 常用工具 |
|------|---------|
| 系统 | `top` / `vmstat` / `iostat` / `sar` / `ss` |
| JVM | `jstat` / `jstack` / `jcmd` / GC 日志 |
| 应用 | Arthas（`trace` / `watch` / `profiler`）、async-profiler |
| 全链路 | SkyWalking / OpenTelemetry + Prometheus |

详见：<RouteLink to="/high-perf/2_methodology">性能分析方法论</RouteLink>

### 二、为什么看 P99 而不是平均 RT？

- **平均值掩盖长尾**：100 个请求 99 个 10ms、1 个 5s，平均约 60ms 看似健康，但那 1% 用户体验极差。延迟分布通常是右偏长尾，平均值没有代表性
- **扇出放大长尾**：一个请求并行调用 100 个下游，每个下游 P99 = 1s，则该请求**至少遇到一次慢调用的概率 = 1 − 0.99¹⁰⁰ ≈ 63%**。下游的 P99 会变成上游的"常态"
- **分位数不能相加 / 平均**：多实例的 P99 求平均没有意义，应由直方图（Prometheus `histogram_quantile`）聚合后计算

| 指标 | 用途 |
|------|------|
| 平均 RT | 粗略容量估算（配合 Little 定律）|
| P50 | 典型用户体验 |
| **P99 / P999** | SLO 与告警的主要依据，反映长尾 |
| Max | 排查偶发问题，噪声大 |

::: warning 压测陷阱
压测工具如果"等上一个请求返回才发下一个"，系统卡顿期间就少发了请求，测出的延迟被严重低估（Coordinated Omission）。应使用按固定速率发压的工具（如 wrk2、Gatling 开放模型）。
:::

详见：<RouteLink to="/high-perf/1_metrics">性能指标</RouteLink>

### 三、为什么用 JMH 做微基准测试，而不是手写循环计时？

手写 `for` 循环 + `System.nanoTime()` 测出的数据往往不可信，因为 JVM 会"优化掉"你的测试：

| 陷阱 | 说明 | JMH 的对策 |
|------|------|-----------|
| JIT 预热 | 前期解释执行、后期编译为机器码，速度差数十倍 | `@Warmup` 预热轮次，只统计稳定期 |
| 死代码消除 | 结果没被使用，计算被 JIT 直接删掉 | 返回结果或写入 `Blackhole` |
| 常量折叠 | 输入是常量，结果在编译期算好 | 输入放在 `@State` 对象字段里 |
| 循环优化 / OSR | 循环展开、栈上替换让测量失真 | 框架控制调用，避免手写循环 |
| 环境干扰 | GC、其他测试的 JIT profile 污染 | `@Fork` 每组测试独立 JVM 进程 |
| 统计不足 | 单次测量无误差范围 | 多轮迭代，输出均值 ± 误差 |

```java
@State(Scope.Thread)
@BenchmarkMode(Mode.AverageTime)
@OutputTimeUnit(TimeUnit.NANOSECONDS)
@Warmup(iterations = 5) @Measurement(iterations = 5) @Fork(2)
public class StringConcatBench {
    String a = "hello", b = "world";

    @Benchmark
    public String builder() {
        return new StringBuilder(a).append(b).toString();  // 返回值防止死代码消除
    }
}
```

**定位**：JMH 回答"两种实现谁更快"；系统整体性能仍要靠全链路压测。

详见：<RouteLink to="/high-perf/3_benchmark">基准测试</RouteLink>

### 四、池化技术的原理是什么？数据库连接池如何设置？

**池化的本质**：复用创建成本高的资源（线程、连接、对象），把"创建 + 销毁"的开销摊薄，同时**限制资源上限**起到保护作用。

| 池 | 省掉的开销 | 代表 |
|----|----------|------|
| 线程池 | 线程创建、栈内存、上下文切换 | `ThreadPoolExecutor` |
| 数据库连接池 | TCP 握手、认证、会话初始化 | HikariCP、Druid |
| HTTP 连接池 | TCP / TLS 握手 | OkHttp、Apache HttpClient |
| 对象池 | 大对象分配与 GC | Netty `ByteBuf` 池 |

**HikariCP 连接数公式**（来自 PostgreSQL 社区经验）：

`connections = (CPU 核心数 × 2) + 有效磁盘数`

例：DB 服务器 8 核 SSD → 约 17 个连接即可。**连接数不是越大越好**：DB 并行执行能力受 CPU 核数限制，连接过多只会增加上下文切换和锁竞争，吞吐反而下降。

**配置要点**：

| 参数 | 建议 |
|------|------|
| `maximumPoolSize` | 按公式起步，压测调整；**所有实例连接总数 ≤ DB `max_connections` 并留余量** |
| `minimumIdle` | 官方建议与 `maximumPoolSize` 相等，做成固定大小池，避免突发时临时建连 |
| `connectionTimeout` | 默认 30s 太长，建议 1~3s 快速失败，防止线程堆积 |
| `maxLifetime` | 比 DB `wait_timeout` 及中间网络设备空闲超时短几十秒 |
| `leakDetectionThreshold` | 开发 / 测试环境开启，定位未归还的连接 |

**判断池子是否太小**：监控 `hikaricp_connections_pending`（等待获取连接的线程数）持续大于 0，且 DB 本身不忙。

详见：<RouteLink to="/high-perf/5_pooling">池化技术</RouteLink>

### 五、如何阅读火焰图？

**读图规则**：

| 维度 | 含义 |
|------|------|
| **Y 轴** | 调用栈深度，下层是调用者，上层是被调用者 |
| **X 轴** | **样本占比**（按字母排序合并），**不是时间顺序** |
| **宽度** | 该函数（含子调用）出现在样本中的比例，越宽耗时越多 |
| 颜色 | 通常只用于区分类型（async-profiler：绿色 Java、黄色 C++/JVM、红色 native / 内核），不代表热度 |

**分析步骤**：

1. 先看**顶部的"平顶"**：栈顶宽的函数是自身消耗 CPU 最多的地方（self time）
2. 顺着平顶往下找到**自己业务代码的第一帧**，判断是谁调用了它
3. 关注常见热点：JSON 序列化、正则、日志格式化、反射、锁自旋、`HashMap` 扩容、大量异常创建
4. 选对**采样模式**：CPU 高看 on-CPU（`cpu`）；RT 高但 CPU 不高要看 wall-clock / lock / alloc 模式，否则等待时间在 CPU 火焰图里是看不到的

```bash
# async-profiler 采样 30 秒生成火焰图（Arthas 中可用 profiler start / stop）
asprof -d 30 -e cpu -f /tmp/cpu.html <pid>
```

详见：<RouteLink to="/high-perf/9_profilers">性能剖析工具</RouteLink>

### 六、深分页为什么慢？如何优化？

**原因**：`LIMIT 1000000, 10` 需要先扫描并丢弃前 100 万行（非覆盖索引时还要回表 100 万次），偏移量越大越慢。

| 方案 | 做法 | 适用 |
|------|------|------|
| **游标 / Seek 分页（首选）** | `WHERE id > #{lastId} ORDER BY id LIMIT 10`，走索引直接定位 | 下一页 / 无限滚动、数据导出 |
| **延迟关联** | 先在覆盖索引上查出 id，再关联回表：`JOIN (SELECT id FROM t ORDER BY create_time LIMIT 1000000,10) tmp USING(id)` | 必须支持跳页 |
| 限制最大页数 | 产品上只允许查前 N 页（如 100 页）| 搜索列表 |
| 搜索引擎 | ES `search_after` / Scroll | 复杂条件 + 海量数据 |
| 预计算 | 定期生成分页快照 / 汇总表 | 报表类 |

**游标分页注意**：排序字段不唯一时需用 `(create_time, id)` 组合作为游标，避免翻页重复或遗漏。

详见：<RouteLink to="/high-perf/8_db_performance">数据库性能优化</RouteLink>

### 七、批量处理与请求合并如何提升性能？

**核心思想**：把 N 次网络往返 / 磁盘刷写合并成 1 次，摊薄固定开销（RTT、系统调用、事务提交）。

| 场景 | 手段 |
|------|------|
| MySQL 写入 | 批量 `INSERT`，JDBC 开启 `rewriteBatchedStatements=true`，单批 500~1000 条 |
| Redis | `MGET` / `MSET`、Pipeline（非原子，但减少 RTT）|
| MQ | Kafka `batch.size` + `linger.ms` 攒批发送，消费端批量拉取 |
| RPC 查询 | 列表页 N 次 `getById` 改为一次 `listByIds`，消除 N+1 |
| **请求合并** | 高并发下把同一时间窗口（如 10ms）内的多个单查请求合并成一次批量查询，再按 key 拆分结果分发给各个 `CompletableFuture` |

**权衡**：

- 攒批会**增加单个请求延迟**（最多一个时间窗口），用"数量或时间先到先触发"控制
- 批次过大导致大事务、大包、锁持有时间长，需限制批大小
- 批量中部分失败的处理（整体重试 vs 拆分重试）要提前设计，并保证幂等

详见：<RouteLink to="/high-perf/6_async_batch">异步与批量</RouteLink>

### 八、序列化方式如何选型？

| 方式 | 体积 | 性能 | 跨语言 | 可读性 | Schema 演进 | 典型场景 |
|------|------|------|-------|-------|-----------|---------|
| **JSON（Jackson）** | 大 | 中 | ✅ | ✅ | 宽松 | 对外 HTTP API、配置、日志 |
| **Protobuf** | 小 | 高 | ✅ | ❌ | ✅ 字段编号兼容 | gRPC、内部高性能 RPC、存储 |
| Hessian2 | 中 | 中 | 部分 | ❌ | 一般 | Dubbo 默认（老版本）|
| Kryo / FST | 小 | 很高 | ❌ 仅 Java | ❌ | 较差 | 同构 Java 系统内部缓存 |
| JDK `Serializable` | 大 | 低 | ❌ | ❌ | 差 | ❌ 不推荐，且有反序列化漏洞风险 |

**选型原则**：对外和前端用 JSON；内部高 QPS 服务间通信用 Protobuf；缓存对象序列化注意**版本兼容**（加字段后老数据能否反序列化）；任何格式都要防范反序列化漏洞（Jackson 关闭 default typing、Fastjson 1.x 关闭 autoType）。

详见：<RouteLink to="/high-perf/7_io_network">IO 与网络优化</RouteLink>

## 高并发

### 九、高并发系统的核心手段有哪些？

| 思路 | 手段 | 解决的问题 |
|------|------|-----------|
| **扩展** | 无状态化 + 水平扩容 + 负载均衡 | 单机算力上限 |
| **缓存** | 本地缓存 + Redis + CDN 多级缓存 | 读压力 |
| **异步** | MQ 削峰填谷、非核心链路异步化 | 写压力与瞬时洪峰 |
| **拆分** | 读写分离、分库分表、服务拆分 | 单库单表瓶颈 |
| **热点治理** | 热点发现、本地缓存、分桶打散 | 局部过热 |
| **并发调优** | 线程池、连接池、锁粒度 | 资源利用率 |
| **过载保护** | 限流、熔断、降级（见高可用部分）| 超出容量时不被打垮 |

线程池参数调优见 <RouteLink to="/high-con/6_concurrency_tuning">并发调优</RouteLink>，读写分离与分库分表见 <RouteLink to="/high-con/4_data_scaling">数据层扩展</RouteLink>，MQ 削峰见 <RouteLink to="/high-con/3_async_peak_shaving">异步削峰</RouteLink>，多级缓存见 <RouteLink to="/high-con/2_cache_architecture">缓存架构</RouteLink>。

详见：<RouteLink to="/high-con/0_overview">高并发总览</RouteLink>

### 十、容量评估如何做？举个例子

**思路**：业务量 → 峰值 QPS → 单机能力（压测）→ 机器数 + 冗余；同时估算存储和带宽。

**示例**：某电商 App，DAU 1000 万，人均每天 20 次请求。

| 步骤 | 计算 | 结果 |
|------|------|------|
| 日请求量 | 1000 万 × 20 | 2 亿次 / 天 |
| 平均 QPS | 2 亿 ÷ 86400 | ≈ 2300 |
| 日常峰值（二八原则：80% 请求集中在 20% 时间）| 2 亿 × 0.8 ÷ (86400 × 0.2) | ≈ 9300 |
| 大促峰值（按日常峰值 3 倍预留）| 9300 × 3 | ≈ **2.8 万** |
| 单机能力（压测：4C8G，P99 < 200ms 时 1000 QPS）| 按 60% 水位使用 | 600 QPS / 台 |
| 实例数 | 2.8 万 ÷ 600 | ≈ 47 台 → 再加 N+1 / 跨可用区冗余，约 **55 台** |
| 并发数（Little 定律：并发 = QPS × RT）| 2.8 万 × 0.1s | ≈ 2800 个在途请求，均摊每台约 50 |
| 存储（订单每天 100 万单 × 1KB）| 1GB / 天 × 365 × 3 年 | ≈ 1.1TB，加索引与副本约 3TB |

**要点**：

- 单机能力必须**实测**（全链路压测），不能拍脑袋；瓶颈常常在 DB、Redis、下游而不在应用层
- 水位留 30%~40% 余量应对突发与单机房故障
- 按链路逐层评估：网关、应用、Redis、MQ、DB 分别核算，**最弱的一层决定整体容量**
- 大促前按容量模型做压测验证，并配好限流阈值（阈值 ≈ 压测容量 × 安全系数）

详见：<RouteLink to="/high-con/7_capacity_planning">容量规划</RouteLink>

### 十一、热点 Key 和热点行（库存扣减）如何解决？

**热点 Key（读热点）**：

| 环节 | 方案 |
|------|------|
| 发现 | 客户端 / 代理层统计访问频次、`redis-cli --hotkeys`（需 LFU 淘汰策略）、京东 hotkey 等热点探测框架 |
| 本地缓存 | 热点 Key 推送到应用本地 Caffeine，短 TTL，请求不再打到 Redis |
| 副本打散 | 一个 Key 复制为 `key_1 ~ key_N` 分布到不同分片，读时随机选一个 |
| 扩展 | 读写分离，增加只读副本 |

**热点行（写热点，如秒杀库存）**：MySQL 同一行更新需要排队获取行锁，单行 TPS 通常只有几百到一两千。

| 方案 | 做法 | 优缺点 |
|------|------|-------|
| **Redis 预扣 + 异步落库（主流）** | Lua 脚本原子判断并扣减库存，成功后发 MQ，消费端异步创建订单、扣 DB 库存 | 吞吐高；需处理 Redis 与 DB 对账、超时未支付回补 |
| **库存分桶** | 总库存拆成 N 行子库存（如 10 行 × 100），请求按用户哈希到某一桶扣减 | 分散行锁；某桶扣完需路由到其他桶 |
| 合并扣减 | 攒一批扣减请求合成一条 `UPDATE stock = stock - n` | 减少锁竞争次数；增加延迟 |
| DB 乐观扣减 | `UPDATE ... SET stock = stock - 1 WHERE id = ? AND stock >= 1` | 简单防超卖；高并发下仍排队 |
| 前置削峰 | 答题 / 验证码、令牌发放、网关限流，只放行与库存量相当的请求 | 从源头减少无效请求 |

**防超卖的底线**：最终扣减必须是**原子的条件更新**（Lua 或带 `stock >= n` 条件的 SQL），不能"先查再扣"。

详见：<RouteLink to="/high-con/5_hotspot">热点治理</RouteLink> / <RouteLink to="/interview/3_cache">开发总结-缓存</RouteLink>

### 十二、如何做水平扩展？什么是无状态化？

**无状态化**：任何一个实例都能处理任何一个请求，实例之间可随意增减替换。关键是把**状态外置**：

| 状态 | 外置方式 |
|------|---------|
| 登录会话 Session | Redis 集中存储 / JWT 无状态令牌 |
| 上传文件 | 对象存储（OSS / S3 / MinIO）|
| 本地缓存 | 允许短暂不一致 + 广播失效，或改用分布式缓存 |
| 本地锁 `synchronized` | 分布式锁 |
| 本地定时任务 | 分布式调度（XXL-Job），避免多实例重复执行 |
| 自增序列 / 内存计数器 | 分布式 ID、Redis 计数 |

**扩展方式**：

- **应用层**：无状态后通过负载均衡 + K8s HPA 按 CPU / QPS 自动扩缩容
- **有状态层**：按 Key 分片（分库分表、Redis Cluster、Kafka 分区），配合一致性哈希减少扩容时的数据迁移
- **注意**：应用层扩容后压力会转移到共享资源（DB 连接数、Redis、下游），扩容前要确认下游能承接；实例越多，DB 总连接数越大

详见：<RouteLink to="/high-con/1_scale_out">水平扩展</RouteLink>

## 高可用

### 十三、如何设计一个高可用系统？

**核心原则**：

1. **消除单点**（SPoF）：每个组件至少 2 个实例，含数据库、Redis、网关
2. **故障隔离**：线程池隔离（不同业务不同池）、机房级别隔离
3. **快速失败**：超时 + 熔断，避免故障扩散
4. **流量管控**：限流 + 降级，保住核心链路
5. **可观测**：Metrics（Prometheus）+ Tracing（SkyWalking）+ Logging（ELK）

**按故障阶段看手段**：

| 阶段 | 手段 |
|------|------|
| 事前预防 | 冗余部署、容量规划、灰度发布、混沌演练 |
| 事中止损 | 限流、熔断、降级、隔离、故障转移、切流 |
| 事后恢复 | 自动重启 / 自愈、回滚、复盘改进 |

详见：<RouteLink to="/high-avail/0_overview">高可用总览</RouteLink> / <RouteLink to="/high-avail/2_redundancy_failover">冗余与故障转移</RouteLink>

### 十四、SLA、SLO、SLI 是什么？什么是错误预算？

| 概念 | 含义 | 示例 |
|------|------|------|
| **SLI**（指标）| 衡量服务质量的具体指标 | 请求成功率、P99 延迟 |
| **SLO**（目标）| 团队内部对 SLI 设定的目标 | 30 天内成功率 ≥ 99.95%，P99 < 300ms |
| **SLA**（协议）| 对客户的承诺，违约需赔偿 | 月可用性 99.9%，否则补偿服务时长 |

通常 **SLA 比 SLO 宽松**，给内部留缓冲。

**可用性目标参考**：

| SLA | 年故障时间 | 月故障时间 |
|-----|---------|---------|
| 99.9%（三个九）| 8.76 小时 | 43.2 分钟 |
| 99.99%（四个九）| 52.56 分钟 | 4.32 分钟 |
| 99.999%（五个九）| 5.26 分钟 | 26 秒 |

**错误预算 = 1 − SLO**。SLO 为 99.9% 时，30 天错误预算 = 30 × 24 × 60 × 0.1% ≈ **43 分钟**。

- 预算充足：可以大胆发布、做实验
- 预算即将耗尽：冻结功能发布，优先投入稳定性
- 告警基于**燃烧速率**（burn rate）：如 1 小时内消耗掉 2% 月预算即告警，比"错误率 > X%"更贴近用户影响

详见：<RouteLink to="/high-avail/1_sla_slo">SLA 与 SLO</RouteLink>

### 十五、系统可用性如何计算？串联和并联有什么区别？

| 结构 | 公式 | 示例 |
|------|------|------|
| **串联**（强依赖链路，任一挂则整体挂）| A = A₁ × A₂ × … × Aₙ | 网关、应用、DB 各 99.9% → 99.9%³ ≈ **99.7%** |
| **并联**（冗余，全挂才挂）| A = 1 − (1 − A₁)(1 − A₂)…(1 − Aₙ) | 两个 99% 的实例互备 → 1 − 0.01² = **99.99%** |

**推论**：

- **依赖链越长，可用性越低**：一个接口强依赖 10 个 99.9% 的服务，整体只剩约 99%。要减少强依赖，把非核心依赖改为弱依赖（异步、可降级）
- **冗余是提升可用性最有效的手段**，但公式假设故障相互独立；同机房、同版本、同配置的实例会一起挂，所以要跨可用区部署、灰度发布
- 系统可用性的上限由最薄弱的串联环节决定

详见：<RouteLink to="/high-avail/2_redundancy_failover">冗余与故障转移</RouteLink>

### 十六、限流算法有哪些？令牌桶和漏桶的区别？

**四种常见算法**：

| 算法 | 原理 | 能否处理突发 | 典型实现 |
|------|------|------------|---------|
| 固定窗口 | 统计固定时间窗口内请求数 | ❌ 窗口边界有突刺 | Redis INCR + EXPIRE |
| 滑动窗口 | 多个小窗口，精细化统计 | ✅ 较平滑 | Redis ZSet + Lua |
| 漏桶 | 固定速率流出，超出丢弃 | ❌ 不允许突发 | — |
| **令牌桶** | 固定速率生成令牌，有令牌才放行 | ✅ 允许一定突发 | Guava `RateLimiter` |

**令牌桶 vs 漏桶核心区别**：漏桶强制匀速输出，适合流量整形；令牌桶允许积累令牌消费突发流量，更适合限流场景。

**Redis + Lua 滑动窗口实现**：

```lua
local key = KEYS[1]
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])  -- 窗口大小(ms)
local limit = tonumber(ARGV[3])   -- 限制次数

redis.call('ZREMRANGEBYSCORE', key, 0, now - window)  -- 移除窗口外记录
local count = redis.call('ZCARD', key)
if count < limit then
    redis.call('ZADD', key, now, now)
    redis.call('PEXPIRE', key, window)
    return 1  -- 放行
end
return 0  -- 限流
```

**热点参数限流**：按请求参数值（如商品 ID、用户 ID）分别计数限流，防止单个热点商品或恶意用户耗尽整体配额（Sentinel `ParamFlowRule`）。

详见：<RouteLink to="/high-avail/3_rate_limiting">限流</RouteLink>

### 十七、熔断器的三种状态是什么？如何切换？

| 当前状态 | 行为 | 切换条件 | 下一状态 |
|---------|------|---------|---------|
| **Closed**（关闭，正常）| 请求正常通过，统计错误率 / 慢调用比例 | 错误率或慢调用比例超过阈值 | Open |
| **Open**（打开，熔断）| 直接失败或走降级，不调用下游 | 经过 `waitDurationInOpenState` | Half-Open |
| **Half-Open**（半开）| 放行少量探测请求 | 探测成功率达标 → Closed；探测失败 → Open | Closed / Open |

**Resilience4j 配置示例**：

```yaml
resilience4j:
  circuitbreaker:
    instances:
      orderService:
        failure-rate-threshold: 50          # 错误率超 50% 触发熔断
        slow-call-rate-threshold: 80        # 慢调用超 80% 触发熔断
        slow-call-duration-threshold: 2s    # 超过 2s 算慢调用
        wait-duration-in-open-state: 10s    # 熔断等待时间
        permitted-calls-in-half-open-state: 5  # 半开时允许的探测请求数
```

详见：<RouteLink to="/high-avail/4_circuit_breaking">熔断</RouteLink>

### 十八、Sentinel 和 Hystrix 的区别？

| 对比项 | Sentinel | Hystrix |
|--------|---------|---------|
| 来源 | 阿里开源 | Netflix（已停止维护）|
| 隔离方式 | 信号量（轻量，无额外线程）| 线程池隔离 + 信号量 |
| 熔断策略 | 错误率 / 慢调用比例 / 异常数 | 错误率 |
| 规则配置 | 控制台动态推送（Nacos / ZK）| 配置文件 / 代码 |
| 流量控制 | QPS / 并发数 / 热点参数 | 并发线程数 |
| 可视化 | ✅ 实时 Dashboard | ✅ Turbine Dashboard |
| 生态 | Spring Cloud Alibaba | Spring Cloud Netflix（过时）|

**推荐**：新项目用 Sentinel（国内）或 Resilience4j（替代 Hystrix）。

**`@SentinelResource` 的 `blockHandler` vs `fallback`**：`blockHandler` 只处理 Sentinel 规则触发的 `BlockException`（限流、熔断、系统保护）；`fallback` 处理业务代码抛出的异常。两者都配置时，被限流熔断走 `blockHandler`。

Sentinel 内部原理（Slot 链、滑动窗口）见 <RouteLink to="/interview/6_spring_cloud">开发总结-Spring Cloud</RouteLink>。

### 十九、服务降级有哪些策略？

降级的本质是**牺牲非核心功能，保住核心链路**。

| 级别 | 降级措施 | 示例 |
|------|---------|------|
| 轻微 | 关闭非核心功能 | 关闭推荐、广告、积分 |
| 中等 | 简化业务流程 | 秒杀时跳过风控、关闭退款 |
| 严重 | 只保留核心交易 | 只允许下单+支付，关闭其他接口 |

**代码实现（Sentinel fallback）**：

```java
@SentinelResource(
    value = "queryRecommend",
    blockHandler = "blockHandler",    // 限流/熔断触发
    fallback = "fallbackHandler"      // 业务异常触发
)
public List<Item> queryRecommend(Long userId) {
    return remoteService.getRecommend(userId);
}

public List<Item> fallbackHandler(Long userId, Throwable e) {
    return Collections.emptyList();   // 返回兜底空列表
}
```

详见：<RouteLink to="/high-avail/5_degradation">降级</RouteLink>

### 二十、如何实现超时控制和重试？

**超时设置原则**：每一层都要设超时，不能依赖下层兜底。

```yaml
# Feign 客户端超时配置
feign:
  client:
    config:
      default:
        connect-timeout: 1000   # 连接超时 1s
        read-timeout: 3000      # 读超时 3s
```

**重试策略**（仅适用于幂等操作）：

```java
@Retryable(
    value = {RemoteCallException.class},
    maxAttempts = 3,
    backoff = @Backoff(delay = 500, multiplier = 2)  // 500ms, 1s, 2s 指数退避
)
public Result callRemoteService() {
    return remoteService.call();
}

@Recover
public Result recover(RemoteCallException e) {
    return Result.fail("服务暂不可用，请稍后重试");
}
```

::: warning 注意
非幂等操作（如扣库存、发消息）**不能**直接加重试，否则会重复执行。需要先保证接口幂等性，再考虑重试。
:::

**防止重试风暴**：只在一层重试（通常是离故障最近的一层），多层都重试 3 次时流量会放大 3³ = 27 倍；退避加随机抖动（jitter）避免同时重试；配合重试预算（重试请求占比上限）。

详见：<RouteLink to="/high-avail/6_bulkhead_retry">隔离与重试</RouteLink>

### 二十一、同城双活、异地多活和单元化是什么？

| 方案 | 部署 | 特点 | 解决 |
|------|------|------|------|
| 同城双活 | 同城两个机房，延迟约 1ms | 数据库可同步复制，切换快（RTO 分钟级甚至秒级）| 机房级故障 |
| 两地三中心 | 同城双中心 + 异地灾备 | 灾备中心平时不承载流量，切换慢、资源浪费 | 城市级灾难（数据不丢）|
| **异地多活** | 多个城市同时承载流量 | 跨城延迟数十 ms，只能异步复制，**数据最终一致** | 城市级故障，同时就近访问 |

**单元化（异地多活的主流落地方式）**：

1. **按用户维度切分**（如 userId 取模 / 号段）为多个单元（Unit / Cell），每个单元部署完整的应用 + 数据分片
2. **单元内闭环**：一个用户的请求在接入层（网关 / DNS）就被路由到所属单元，读写都在本单元完成，避免跨城调用
3. **全局数据**（如商品、配置）放在中心单元，其他单元只读同步
4. **数据双向同步**：通过 DTS / Otter 等在单元间异步复制，需要防回环、处理冲突
5. **故障切流**：某单元故障时，把该单元用户的路由规则切到其他单元

**难点**：不是所有业务都能按用户切分（如库存是全局的）；切流时存在未同步数据导致的短暂不一致（RPO > 0），需要业务容忍或做补偿对账。

详见：<RouteLink to="/high-avail/8_multi_active">多活架构</RouteLink>

### 二十二、什么是优雅停机？如何实现？

**为什么需要优雅停机**：直接 kill 进程会中断正在处理的请求，导致数据不一致或请求报错。

**优雅停机流程**：
1. 停止接受新请求（从注册中心下线，Nginx 摘除）
2. 等待当前请求处理完毕
3. 关闭资源（数据库连接、MQ 连接）
4. 进程退出

**Spring Boot 配置**：

```yaml
server:
  shutdown: graceful          # 不再接受新请求，处理完存量请求再关闭
spring:
  lifecycle:
    timeout-per-shutdown-phase: 30s  # 最多等 30s，超时强制关闭
```

**K8s 配合**：配置 `preStop` 钩子，让 Pod 先从 Service 摘除，再等待请求处理完毕：

```yaml
lifecycle:
  preStop:
    exec:
      command: ["/bin/sh", "-c", "sleep 10"]  # 等待 Nginx/网关感知下线
```

**为什么需要 `preStop` 等待**：K8s 删除 Pod 时，"发送 SIGTERM"和"从 Endpoints 摘除"是**并行**发生的，kube-proxy / Ingress / 注册中心客户端感知摘除需要时间。不等待的话，应用已开始关闭，仍会有流量打进来。

**完整要点**：

- 微服务场景在 `preStop` 中**主动从注册中心注销**（如调用 Nacos 下线接口），因为调用方有本地实例缓存
- `terminationGracePeriodSeconds`（默认 30s）必须大于 `preStop` 时长 + 应用关闭超时，否则会被 SIGKILL
- MQ 消费者先停止拉取，处理完已拉取的消息并提交位点
- 自定义线程池要 `shutdown()` + `awaitTermination()`，否则异步任务丢失
- 禁止 `kill -9`，它不会触发 JVM Shutdown Hook
- **优雅上线同样重要**：就绪探针（readiness）通过后才接流量，JIT 未预热时按权重逐步放量

详见：<RouteLink to="/high-avail/9_graceful_release">优雅发布</RouteLink>

### 二十三、混沌工程是什么？有哪些工具？

**定义**：在生产（或准生产）环境中**主动注入故障**，验证系统在异常条件下是否仍能保持稳态，从而在真实故障发生前发现弱点。

**实施步骤**：

1. **定义稳态**：用业务指标描述"正常"（如下单成功率 ≥ 99.9%）
2. **提出假设**：如"一台 Redis 宕机，下单成功率不受影响"
3. **注入故障**：实例宕机、网络延迟 / 丢包、CPU / 内存 / 磁盘打满、依赖服务返回异常
4. **控制爆炸半径**：从测试环境开始，生产先小流量、单实例，准备一键终止
5. **观察与改进**：假设不成立即发现了问题，修复后纳入常规演练

| 工具 | 特点 |
|------|------|
| **ChaosBlade**（阿里）| 支持主机、容器、K8s、JVM 方法级故障注入 |
| **Chaos Mesh**（CNCF）| K8s 原生，CRD 定义实验 |
| Chaos Monkey（Netflix）| 随机终止实例，混沌工程鼻祖 |
| Litmus | K8s 原生，实验市场丰富 |

详见：<RouteLink to="/high-avail/10_chaos_engineering">混沌工程</RouteLink>

### 二十四、负载均衡有哪些算法？如何做健康检查与故障摘除？

| 算法 | 特点 | 适用 |
|------|------|------|
| 轮询 / 加权轮询 | 简单均匀；加权适配不同机型 | 实例同质 |
| 随机 / 加权随机 | 无状态 | 通用 |
| 最少连接 / 最短响应 | 感知实时负载 | 请求耗时差异大 |
| 一致性哈希 | 同 Key 固定落到同一实例 | 有本地缓存、会话粘滞 |
| P2C（Power of Two Choices）| 随机挑两个，选负载低的 | 大规模集群，兼顾均衡与开销 |

**健康检查**：

- **主动探测**：负载均衡器定期请求 `/actuator/health`，连续失败 N 次摘除
- **被动检测**（异常剔除）：根据真实请求的失败率 / 超时临时摘除实例，一段时间后再放回尝试
- 注意健康检查接口不要依赖过多下游，否则下游抖动会导致全部实例被摘除

详见：<RouteLink to="/high-avail/7_load_balancing">负载均衡</RouteLink>
