---
description: 按接口与下游逐层拆耗时、订单列表走错索引、每条写语句多一次往返、JFR 采样归层、网关每个请求查配置、尾部来自磁盘卡顿
---

# 耗时定位实验

> 前置阅读：[性能分析方法论](./2_methodology)、[性能分析工具](./3_profilers)、[可观测与发布](/project/9_observability_release)

mall-evolution 的下单、订单列表、订单详情三个接口，在远低于容量的固定流量下，一次请求的时间花在哪。本篇用服务指标、MySQL 语句统计和 JFR 采样逐层拆开，找到三处问题，各改一处再量，基线为 JDK 21、MySQL 8.4。

## 一、现象与假设

高并发的几篇实验回答的是「能扛多少」，这一篇换一个问题：没有任何东西在排队的时候，一个请求为什么是这个耗时。动手之前对这套代码有几条想当然的判断：

| 假设 | 怎么验证 |
|------|---------|
| 订单列表按 `(user_id, id)` 索引取 20 行，一条 SQL 不到 1ms | MySQL 的语句统计：每条语句的次数、耗时、扫描行数 |
| 查询接口的时间主要花在数据库上 | 网关、mall-app、连接池、SQL 各层的计时逐层相减 |
| CPU 主要花在业务代码和 JSON 序列化上 | JFR 方法采样，按调用栈归到各个库 |
| 游标用 JSON + Base64 + 正则编解码，是个热点 | 换成十进制字符串再压一遍 |

四条里只有半条成立。

## 二、实验设置

| 项 | 取值 |
|----|------|
| 拓扑 | 压测 → 网关 → mall-app → 库存服务、支付服务，各 1 个实例；MySQL、Redis、RocketMQ 在一台 4 核 6GB 的虚拟机里 |
| 流量 | 开放模型、固定速率：下单 50 单/秒、订单列表 200 次/秒、订单详情 100 次/秒 |
| 数据 | 4000 个用户每人 200 单，两种查询在这 4000 人里随机挑，订单列表取最近 20 单 |
| 时长 | 预热 60 秒，正式 240 秒；其中第 80–290 秒这 210 秒是「要看的那一段」 |
| 轮数 | 每个变体 2–5 轮，大部分在夜里跑，分散在不同时段；第二天上午又各补了一轮 |

这个流量离任何一处的上限都很远（高并发的实验里下单到过 400 单/秒、查询到过 2700 次/秒），请求不排队，量到的是一次请求自己要多久。

三种数据对着同一段时间取：

| 数据 | 怎么取 | 回答什么 |
|------|-------|---------|
| 各服务的计时指标 | Micrometer 的 `http.server.requests`、`http.client.requests`、HikariCP 的借出时长，每秒采一次 | 每一跳、每个下游各花了多久 |
| MySQL 语句统计 | `performance_schema` 的语句摘要，这一段开始时清零、结束时取回 | 发了哪些语句、各多少次、多久、扫了多少行 |
| JFR 录制 | 流量进来之前开好，方法采样间隔 5ms，线程挂起 1ms 以上都记 | CPU 花在哪些库上，线程在等什么 |

各变体只改一处：

| 变体 | 和正式配置的差别 |
|------|-----------------|
| 不带索引提示 | 订单列表的 SQL 去掉索引提示（这次修复之前的样子） |
| 正式配置 | 无 |
| 驱动连接属性 | 给 MySQL 驱动加 `useLocalSessionState`、`cachePrepStmts` |
| 十进制游标 | 订单列表的游标换成十进制字符串 |
| 管理端口修复之前 | 用修复前的那次提交打的包 |

### 对应的代码

| 内容 | 在 mall-evolution 的哪里 |
|------|-------------------------|
| 订单列表的查询与索引提示 | [`OrderMapper#listByUser`](https://github.com/Clarence404/mall-evolution/blob/main/mall-order/src/main/java/io/github/clarence404/mall/order/domain/OrderMapper.java) |
| 实验用的开关（去掉提示、换游标），只在 `demo` profile 下生效 | [`OrderListPolicy`](https://github.com/Clarence404/mall-evolution/blob/main/mall-order/src/main/java/io/github/clarence404/mall/order/query/OrderListPolicy.java)、[`DemoOrderListPolicy`](https://github.com/Clarence404/mall-evolution/blob/main/mall-order/src/main/java/io/github/clarence404/mall/order/demo/DemoOrderListPolicy.java) |
| 管理端口的过滤链 | [`GatewaySecurityConfig`](https://github.com/Clarence404/mall-evolution/blob/main/mall-gateway/src/main/java/io/github/clarence404/mall/gateway/GatewaySecurityConfig.java)、[`ManagementPort`](https://github.com/Clarence404/mall-evolution/blob/main/mall-gateway/src/main/java/io/github/clarence404/mall/gateway/ManagementPort.java) |
| 数据源与驱动的连接属性 | [`mall-app/application.yml`](https://github.com/Clarence404/mall-evolution/blob/main/mall-app/src/main/resources/application.yml) |
| 把 JFR 录制汇总成表的脚本 | [`experiments/tools/hp_jfr.py`](https://github.com/Clarence404/mall-evolution/blob/main/experiments/tools/hp_jfr.py) |
| 压测场景与各变体参数 | [`LocateSimulation`](https://github.com/Clarence404/mall-evolution/blob/main/perf/src/test/java/io/github/clarence404/mall/perf/ha/LocateSimulation.java)、[`experiments/i-locate/`](https://github.com/Clarence404/mall-evolution/tree/main/experiments/i-locate) |

## 三、第一层：按接口拆，订单列表不对劲

先看不带索引提示的那一组，这是这次实验开始时代码的样子。各接口在 mall-app 里的平均耗时（第一轮 / 第二轮）：

| 接口 | 做了什么 | mall-app 里的平均耗时 |
|------|---------|------|
| 订单列表 | 一条 SQL，取 20 行 | 24.2ms / 27.1ms |
| 订单详情 | 两条 SQL（订单、明细） | 4.6ms / 5.3ms |
| 下单 | 调库存服务预占，再写订单、明细、消息 | 26.0ms / 29.8ms |

只查一张表的列表比查两张表的详情慢 5 倍，和下单一样慢。按 RED 的思路，先找到的是「哪个接口不对」。再往下拆，看这一段时间里 MySQL 的语句统计：

| 语句 | 次数 | 平均执行时间 | 平均扫描行数 | 平均返回行数 |
|------|------|------|------|------|
| 订单列表那条 `SELECT` | 4.2 万 / 4.2 万 | 22.5ms / 24.9ms | 221 | 21 |

一条语句 22–25ms，返回 21 行却扫了 221 行。执行计划说明了原因：

```text
-> Limit: 21 row(s)
    -> Sort: t_order.id DESC, limit input to 21 row(s) per chunk
        -> Index lookup on t_order using uk_user_biz (user_id=800001234)  (rows=200)
```

优化器没有用为这条查询建的 `idx_user_id (user_id, id)`，用的是下单幂等的唯一索引 `uk_user_biz (user_id, biz_no)`。两个索引都以 `user_id` 开头，都能定位到这个用户的 200 行；但 `uk_user_biz` 里的行不是按 `id` 排的，于是把 200 行全部回表读出来，排序，再取前 21 行。这个用户的订单散在整张表里，200 次回表落在 200 个不同的数据页上，表比缓冲池大，大部分要读盘。

加上索引提示之后：

```sql
SELECT /*+ INDEX(t_order idx_user_id) */ id, order_no, status, pay_amount, created_at
FROM t_order WHERE user_id = ? ORDER BY id DESC LIMIT ?
```

```text
-> Limit: 21 row(s)
    -> Index lookup on t_order using idx_user_id (user_id=800001234) (reverse)  (rows=21)
```

沿索引倒着读 21 行就结束，没有排序。同一段流量再压：

| 指标 | 不带提示 | 带提示（正式配置） |
|------|------|------|
| 列表语句平均执行时间 | 22.5ms / 24.9ms | 0.30ms |
| 列表语句平均扫描行数 | 221 | 21 |
| 订单列表在 mall-app 里 | 24.2ms / 27.1ms | 1.5ms |
| 订单详情在 mall-app 里 | 4.6ms / 5.3ms | 2.3ms |
| 下单在 mall-app 里 | 26.0ms / 29.8ms | 13.1ms |
| 数据库虚拟机 CPU | 61% / 63% | 31% |
| 其中等磁盘（iowait） | 19.5% / 18.9% | 0.1% |

「带提示」一列取的是没有被磁盘卡顿打扰的一轮（见第八节）。列表快了 16 倍。另外两个接口没有改一行代码，也快了一半：它们和列表共用一个数据库，列表把磁盘和缓冲池占住的时候，谁都快不了。

这个问题一直在，之前没有被发现，有三个原因：

- **功能上完全正确**，结果和走对索引时一模一样
- **数据少的时候不明显**：早先的压测只在 100 个用户里查，他们的订单页全在缓存里，列表接口是 6ms，没有慢到让人去查
- **文档里写的是「走 `idx_user_id`」**。[数据建模](/project/2_data_model) 的索引规划表是从查询形态推出来的，没有人对着真实数据看过执行计划

试过几种不写提示的办法：更新统计信息、换成 `ORDER_INDEX` 提示、在 `ORDER BY` 里多加一列，优化器都还是选 `uk_user_biz`，最后用 `INDEX` 提示把索引钉住。

## 四、第二层：修好之后，一次查询的 5 毫秒

索引修好以后（下面都是正式配置的数字），把每一跳的计时逐层相减。查询请求（列表和详情按 2 比 1 混合）的平均耗时：

| 这一段 | 怎么得到 | 平均耗时 | 占比 |
|------|------|------|------|
| 压测端到网关之间 | 压测端看到的 5.0ms 减去网关记的 4.75ms | 0.2ms | 5% |
| 网关自己 | 网关记的 4.75ms 减去它调 mall-app 的 2.27ms | 2.5ms | 50% |
| 网关到 mall-app 之间 | 网关调 mall-app 的 2.27ms 减去 mall-app 记的 1.78ms | 0.5ms | 10% |
| mall-app 里，SQL 之外 | mall-app 记的 1.78ms 减去 SQL 的执行时间 | 1.4ms | 28% |
| SQL 在 MySQL 里执行 | 语句统计（列表一条 0.30ms，详情两条各 0.2ms 多） | 0.36ms | 7% |

「时间主要花在数据库上」不成立：SQL 的执行只占 7%。一半的时间在网关：验一次 JWT、限流、选实例、转发，一来一回各过一遍过滤器链。mall-app 里的 1.4ms 是另一遍 JWT 校验、Spring MVC、MyBatis、驱动和序列化。

下单的 13.1ms 里，调库存服务预占是 5.4ms（库存服务自己记的是 4.8ms），其余是本地事务里的几条写语句和它们的往返。另有两轮让 JFR 把每一次网络读写都记下来：mall-app 处理请求的线程每秒等 2100 次 MySQL 的响应，每次平均 0.29ms；等库存服务每秒 53 次，每次平均 5.5ms。SQL 在服务端执行只要 0.1–0.3ms，一次往返的时间和它差不多，所以「少发一条语句」和「让一条语句更快」是同样值得的事。

## 五、第三层：每个请求发给 MySQL 几条语句

语句统计除了能找慢语句，还能数条数。正式配置下，这 212 秒里三个库一共收到 80 万条语句，前台的请求是 7.5 万个，平均每个请求 10.7 条（含后台的关单和消息中继）。按种类分：

| 语句 | 条数 | 占比 |
|------|------|------|
| 查询（`SELECT`） | 20.0 万 | 25% |
| 写（`INSERT` / `UPDATE` / `DELETE`） | 15.7 万 | 20% |
| `SELECT @@SESSION.transaction_read_only` | 15.7 万 | 20% |
| `SET autocommit = ?` | 14.8 万 | 18% |
| `COMMIT` | 7.4 万 | 9% |
| 设置、查询隔离级别 | 6.4 万 | 8% |

真正的业务语句只有 45%。排在次数第一位的是 `SELECT @@SESSION.transaction_read_only`，157442 条，而写语句是 157440 条：**每执行一条写语句之前，驱动都先问服务端一次「这个会话是不是只读的」**。这是 Connector/J 的默认行为，它不记自己设过的会话状态，每次都去问。

![平均每个请求发给 MySQL 几条语句](../assets/high-perf/exp-locate-sql-per-request.svg)

给驱动加上连接属性 `useLocalSessionState=true`（让它记住自己设过的状态）和 `cachePrepStmts=true`（缓存预编译语句在客户端的解析结果），不改代码再压：

| 指标 | 驱动默认 | 加连接属性 |
|------|------|------|
| 每秒语句数 | 3780–3786 | 2933–2943 |
| 其中询问会话状态的 | 845 | 0 |
| 下单在 mall-app 里，夜里 | 13.1ms | 10.7ms / 11.1ms |
| 下单在 mall-app 里，第二天上午 | 12.1ms / 12.4ms | 11.1ms |
| 其中调预占，夜里 | 5.4ms | 4.5ms / 5.1ms |
| 其中调预占，第二天上午 | 5.1ms / 5.1ms | 4.7ms |
| 订单列表在 mall-app 里 | 1.54ms，1.45ms / 1.45ms | 1.50ms / 1.48ms，1.53ms |
| mall-app 分配速率 | 94.5MB/秒，94.4MB/秒 / 94.4MB/秒 | 86.0MB/秒 / 88.6MB/秒，87.4MB/秒 |

表里只列没有被磁盘卡顿打扰的轮次；夜里和上午机器的状态不一样（上午整体快半毫秒到一毫秒），所以分开成对地比。语句少了 22%，每一轮都是这个数。下单快了 1–2ms：一笔订单从预占、写单到发消息有十来条写语句，每条省一次往返。只读的订单列表没有变化，它本来就不触发这次询问。mall-app 的分配少了 7%–9%。数据库虚拟机的 CPU 夜里那一对从 30.9% 降到 27%，上午那一对没有差别（30% 对 30%），不能算作结论。

剩下的 `SET autocommit` 和 `COMMIT` 是事务本身的开销，每个事务两条 `SET` 加一条 `COMMIT`，这个属性省不掉。

## 六、第四层：CPU 花在哪

![mall-app 处理请求的线程 CPU 采样落在哪一层](../assets/high-perf/exp-locate-cpu-layers.svg)

JFR 每 5ms 对正在运行的线程采一次调用栈。把每个采样归给调用栈里离栈顶最近的那个库，mall-app 处理请求的线程是这样分的（正式配置，5 轮合计 4645 个采样）：

| 归到哪一层 | 占比 |
|------|------|
| 指标与追踪（Micrometer、Prometheus 客户端） | 25% |
| Spring（MVC、AOP 与容器、Security） | 25% |
| Tomcat 与 Servlet | 14% |
| MySQL 驱动 | 11% |
| JSON（Jackson） | 8% |
| MyBatis | 8% |
| 其余（HTTP 客户端、日志、JWT 验签等） | 8% |
| 业务代码 | 不到 1% |

把四个服务换到 JDK 25 上再录两轮做核对（JDK 25 的采样实现不同，两轮合计 8085 个采样）：各层的次序大体一样，业务代码是 1.9%；差得最多的是 MySQL 驱动，占 20%，是 JDK 21 上的两倍，原因没有细查。两边一致的是结论本身：九成以上的 CPU 在框架和库里。

「CPU 主要花在业务代码和 JSON 上」也不成立。业务代码自己几乎不占 CPU，它做的事就是调库；JSON 占 8%。最大的一块是指标与追踪：每个请求、每次调下游、每次借连接都要记一组计时，其中约 5 个百分点是压测脚本每秒来抓一次全量指标造成的，线上的抓取间隔通常是 15–30 秒，这部分会小得多。

这张表说明的是「这个服务的 CPU 花在框架上」，不等于「这些都该优化」：mall-app 整个进程只用了 1.2 个核，离不够用还远。真正有用的是采样里一个不该出现的东西。

### 网关：每个请求都去翻一遍配置

网关的采样里，有一个业务方法的名字出现在 3%–9% 的调用栈里：`GatewaySecurityConfig.onManagementPort`。它是管理端口那条过滤链的匹配条件，用来判断「这个请求是不是打在管理端口上」，每个请求都要走一次：

```java
// 修复前
static boolean onManagementPort(Environment env, ServerWebExchange exchange) {
    Integer managementPort = env.getProperty("local.management.port", Integer.class);
    Integer serverPort = env.getProperty("local.server.port", Integer.class);
    ...
}
```

`Environment.getProperty` 看起来像读一个字段，实际要把所有配置源挨个翻一遍，还带类型转换。一个请求两次。端口在服务器起来之后不会再变，查到一次记住即可：

```java
// 修复后：mall-gateway/.../ManagementPort.java
boolean matches(ServerWebExchange exchange) {
    Integer port = resolved;
    if (port == null) {
        port = GatewaySecurityConfig.resolveManagementPort(env);
        if (port == null) {
            return false;       // 服务器还没起完，下次再查
        }
        resolved = port;
    }
    InetSocketAddress local = exchange.getRequest().getLocalAddress();
    return local != null && local.getPort() == port;
}
```

| 网关的 CPU 采样 | 修复前（各轮） | 修复后 |
|------|------|------|
| 调用栈里有这个方法的采样占比 | 2.6% / 4.1% / 8.9%，合计 6.2% | 0（18 轮里都是 0） |

mall-app 里是同一种写法，一并改了；它那边修复前的占比只有 0.3%。

这一处在接口耗时和进程 CPU 上量不出差别：修复前后网关记的查询耗时是 4.83ms、4.72ms 对 4.75ms，都在轮与轮的波动里。网关一个请求用 2–3ms 的 CPU，其中的百分之几是一百微秒上下。它值得改，是因为改起来只要十几行、没有风险，而且同样的写法每个服务都有一份；不是因为它让接口变快了。

## 七、没有效果的一项：换游标

订单列表的游标是 `{"id":"..."}` 再做 Base64，解码时用正则取出 id。[微基准实验](./15_exp_microbench) 里它比直接用十进制字符串慢 6 倍。换成十进制字符串再压：

| 订单列表在 mall-app 里的平均耗时 | 各轮 |
|------|------|
| JSON + Base64（正式代码，没被磁盘卡顿打扰的 7 轮） | 1.45ms–1.64ms |
| 十进制字符串（3 轮） | 1.62ms / 1.66ms / 1.58ms |

没有变快。两种写法差 90 纳秒，一次请求是 150 万纳秒，差别比轮与轮之间的波动小两个数量级。这段代码没有改。

## 八、尾部耗时：不是代码，是磁盘

上面比的都是平均值。看 P99.9 的话，各轮之间差得很远，而且和变体无关，只和一件事有关：这一轮里放数据库的虚拟机磁盘有没有卡过。实验脚本每秒在虚拟机上做一次 4KB 的同步写并计时，把每一轮里最慢的那一次和订单列表的 P99.9 放在一起：

| 这一轮里最慢的一次同步写 | 轮数 | 订单列表 P99.9 | 订单列表 P50 |
|------|------|------|------|
| 不超过 30ms | 12 | 18ms–27ms | 3.8ms–4.8ms |
| 160ms–1140ms | 7 | 其中 6 轮 251ms–1137ms，1 轮 21ms | 4.4ms–5.1ms |

P50 两组一样，P99.9 差出一到两个数量级。磁盘卡住的那一两秒里，所有等提交的事务一起停住，后面的请求跟着排队；有一轮卡了 450ms 而查询没有受影响。统计的是带索引提示的 19 轮；卡顿的 7 轮都在夜里，第二天上午的 5 轮一次也没有遇到。这台虚拟机的磁盘每隔一段时间就会这样卡一下，和压的是什么没有关系。

这件事对实验有两个影响：一是比较变体只能用平均值和 P50，或者只用没卡过的那几轮；二是如果只看 P99.9，会以为某个改动让尾部变好或变坏了，其实只是那一轮运气不同。**尾部耗时先要找到它的来源，再谈优化**；来源不在应用里的时候，改应用没有用。

## 九、几条可以带走的做法

| 做法 | 依据 |
|------|------|
| 按接口、按下游、按语句逐层拆，先找到不对劲的那一个 | 列表比详情慢 5 倍，一眼就能看出该查它 |
| 执行计划要在真实数据量上看，不靠推断 | 文档写的是走 `idx_user_id`，实际走的是 `uk_user_biz` 加排序；100 个用户时 6ms，4000 个用户时 22ms |
| 修一个慢查询，要把同库的其他接口一起量 | 只改了列表，详情和下单也快了一半 |
| 数一数每个请求发了几条语句 | 20% 的语句是驱动在问会话状态，一个连接属性省掉，下单快 1–2ms |
| 采样看的是「不该出现的东西」，不是把占比最大的都优化掉 | 框架占九成以上但 CPU 远没用完；有用的发现是一个每个请求都翻配置的方法 |
| 比较变体时把环境的卡顿和代码的差别分开 | 19 轮里 6 轮的 P99.9 由磁盘决定；夜里和上午的基准也差半毫秒到一毫秒 |
| 量不出差别的改动不做 | 游标慢 6 倍，接口上没有差别 |

## 十、复现

```powershell
.\experiments\i-locate\run.ps1 -Variant i1-baseline       # 不带索引提示
.\experiments\i-locate\run.ps1 -Variant i2-index-hint     # 正式配置
.\experiments\i-locate\run.ps1 -Variant i3-jdbc-params    # 加驱动连接属性
.\experiments\i-locate\run.ps1 -Variant i4-plain-cursor   # 十进制游标
python experiments\tools\hp_jfr.py experiments\out\i-locate\<这一轮>\jfr\mall-app-1.jfr
```

参数与脚本在 mall-evolution 的 [`experiments/`](https://github.com/Clarence404/mall-evolution/tree/main/experiments) 目录。几点局限：

- 压测工具、网关和三个服务在同一台开发机上，各层之间的网络耗时比真实部署小；数据库在虚拟机里，缓冲池只有 128MB，「走错索引就读盘」在内存充足的生产库上不会这么明显
- JFR 在这台 Windows 开发机上每轮只能拿到一两千个方法采样，占比小于 1% 的项目不可靠；表里的占比是几轮合计，网关那一处各轮之间从 2.6% 到 8.9%
- 开着 JFR 录制本身有开销，所有变体都开着，互相可比，但绝对耗时比不开时高
- 逐层相减用的是平均值，各层的计时不是同一批请求上的同一个时刻，相减得到的是量级，不是精确值
- 流量固定在很低的水平，结论是「不排队时一次请求的构成」；高负载下排队会成为主要部分，见 [连接池与实例数实验](/high-con/12_exp_pool_sizing)

## 小结

- 订单列表的 SQL 一直走错索引：读出 200 行排序再取 20 行，一条 22.5ms；加索引提示后 0.30ms，同库的另外两个接口也快了一半
- 修好之后一次查询约 5ms，一半在网关，SQL 的执行只占 7%
- 每条写语句之前驱动都多问一次会话状态，占全部语句的 20%；加连接属性后语句少 22%，下单快 1–2ms
- mall-app 的 CPU 九成以上在框架和库里，业务代码只有 1%–2%；采样里找到网关每个请求查两次配置（占网关采样的 3%–9%），改掉后归零，接口耗时没有可见变化
- P99.9 在三分之一的轮次里由虚拟机磁盘的卡顿决定，和代码无关

## 参考资料

- 驱动的会话状态与预编译缓存属性：[MySQL Connector/J Configuration Properties](https://dev.mysql.com/doc/connector-j/en/connector-j-reference-configuration-properties.html)
- 索引提示的写法：[MySQL 8.4 Reference Manual: Optimizer Hints](https://dev.mysql.com/doc/refman/8.4/en/optimizer-hints.html)
- 语句摘要表：[MySQL 8.4 Reference Manual: Statement Summary Tables](https://dev.mysql.com/doc/refman/8.4/en/performance-schema-statement-summary-tables.html)
- JFR 的事件与命令：[Java SE 21: The jfr Command](https://docs.oracle.com/en/java/javase/21/docs/specs/man/jfr.html)
- 实验方案与参数：[mall-evolution experiments/README](https://github.com/Clarence404/mall-evolution/blob/main/experiments/README.md)

> 下一篇：[数据访问实验](./13_exp_data_access) —— 偏移量、延迟关联、游标翻到 19 万行，逐单查明细，四种批量写法，各差多少。
