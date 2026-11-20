---
description: 偏移量与延迟关联和游标翻到 19 万行的耗时、逐单查明细与 IN 和 JOIN、四种批量写法与驱动改写
---

# 数据访问实验

> 前置阅读：[数据访问性能](./10_db_performance)、[数据建模](/project/2_data_model)、[接口设计](/project/3_api_design)

mall-evolution 的订单列表用游标翻页、明细用一条多行语句写入、列表不带明细。本篇把正式代码里没有用的那几种写法（偏移量分页、逐单查明细、逐条插入）和它们的对照组放在同一份 100 万订单的数据上实测，基线为 MySQL 8.4。

## 一、现象与假设

[数据访问性能](./10_db_performance) 里的三条规则都是「不要这样写」，但在开发库里这样写并不慢，问题要到数据量和翻页深度上来之后才出现。

| 假设 | 怎么验证 |
|------|---------|
| 偏移量分页越翻越慢，延迟关联能缓解，游标不随深度变化 | 一个有 20 万单的用户，翻到第 0、1000、1 万、10 万、19 万行，三种写法各压一遍 |
| 逐单查明细慢在往返次数，不在 SQL 本身 | 最近 20 单带明细：逐单查、一次 `IN`、一次 `JOIN` |
| 批量写要「批量接口、驱动改写、事务」三样齐全才快 | 逐条、事务里逐条、一条语句多行、JDBC 批量，驱动改写开和关各一遍 |

## 二、实验设置

| 项 | 取值 |
|----|------|
| 数据 | 4000 个普通用户每人 200 单，加一个 20 万单的大客户，共 100 万订单、200 万明细；各用户的行交错写入，同一个用户的订单在表里不挨着 |
| 被测接口 | mall-app 上只在 `demo` profile 下存在的 `/internal/demo/perf/**`，压测直接打 mall-app，不经网关 |
| 深分页 | 4 个虚拟用户闭环，每种写法、每个深度压 20 秒，取后 15 秒 |
| 逐单查明细 | 16 个虚拟用户闭环，每种写法压 60 秒，取后 50 秒；在 100 个普通用户里随机挑 |
| 批量写 | 每种写法、每个批大小写 2 万行，重复 3 遍；写完删掉 |
| 轮数 | 每组 2 轮，两轮相隔约 5 小时，下文按「第一轮 / 第二轮」列出，或写中位数与范围 |

数据库是放在一台 4 核 6GB 虚拟机里的 MySQL 8.4，缓冲池 128MB，放宽了落盘设置；订单与明细两张表加起来比缓冲池大，翻得深了一定会读盘。压测工具和 mall-app 在一台 20 核的开发机上。

### 对应的代码

| 内容 | 在 mall-evolution 的哪里 |
|------|-------------------------|
| 正式的订单列表查询（游标） | [`OrderMapper#listByUser`](https://github.com/Clarence404/mall-evolution/blob/main/mall-order/src/main/java/io/github/clarence404/mall/order/domain/OrderMapper.java)、[`OrderQueryService`](https://github.com/Clarence404/mall-evolution/blob/main/mall-order/src/main/java/io/github/clarence404/mall/order/query/OrderQueryService.java) |
| 正式的明细写入（一条语句多行） | [`OrderItemMapper#batchInsert`](https://github.com/Clarence404/mall-evolution/blob/main/mall-order/src/main/java/io/github/clarence404/mall/order/domain/OrderItemMapper.java) |
| 实验用的对照写法（偏移量、延迟关联、逐单查、`JOIN`、逐条插入） | [`DemoPerfMapper`](https://github.com/Clarence404/mall-evolution/blob/main/mall-order/src/main/java/io/github/clarence404/mall/order/demo/DemoPerfMapper.java) |
| 灌数据、四种批量写法、三种带明细的查法 | [`DemoPerfService`](https://github.com/Clarence404/mall-evolution/blob/main/mall-order/src/main/java/io/github/clarence404/mall/order/demo/DemoPerfService.java) |
| 压测场景与各变体参数 | [`DataAccessSimulation`](https://github.com/Clarence404/mall-evolution/blob/main/perf/src/test/java/io/github/clarence404/mall/perf/ha/DataAccessSimulation.java)、[`experiments/j-data-access/`](https://github.com/Clarence404/mall-evolution/tree/main/experiments/j-data-access) |

三种翻页的 SQL，都用提示固定在 `idx_user_id (user_id, id)` 上，比的只是翻页方式：

```sql
-- 偏移量：沿索引读出 offset + 20 行，每一行都回表，再丢掉前 offset 行
SELECT /*+ INDEX(t_order idx_user_id) */ id, order_no, status, pay_amount, created_at
FROM t_order WHERE user_id = ? ORDER BY id DESC LIMIT ?, 20;

-- 延迟关联：子查询只在索引上数过 offset 行、拿到这一页的 20 个主键，再回表取这 20 行
SELECT o.id, o.order_no, o.status, o.pay_amount, o.created_at
FROM t_order o
JOIN (SELECT /*+ INDEX(t_order idx_user_id) */ id FROM t_order
      WHERE user_id = ? ORDER BY id DESC LIMIT ?, 20) p ON p.id = o.id
ORDER BY o.id DESC;

-- 游标（正式代码）：从上一页最后一个 id 往后取，不数前面的行
SELECT /*+ INDEX(t_order idx_user_id) */ id, order_no, status, pay_amount, created_at
FROM t_order WHERE user_id = ? AND id < ? ORDER BY id DESC LIMIT 20;
```

为什么要写索引提示，见 [耗时定位实验](./12_exp_locate) 第三节：不写的话优化器会选另一个索引再排序。

## 三、深分页

![订单列表翻到不同深度时一次查询的平均耗时](../assets/high-perf/exp-data-access-paging.svg)

一次查询的平均耗时（第一轮 / 第二轮）：

| 翻到第几行 | 偏移量 | 延迟关联 | 游标 |
|------|------|------|------|
| 0（第一页） | 1.14ms / 1.13ms | 1.34ms / 1.18ms | 1.06ms / 0.92ms |
| 1000 | 3.22ms / 3.00ms | 1.49ms / 1.38ms | 1.13ms / 0.92ms |
| 1 万 | 24.3ms / 19.3ms | 3.49ms / 2.75ms | 1.04ms / 0.94ms |
| 10 万 | 675ms / 157ms | 15.8ms / 12.8ms | 1.21ms / 0.93ms |
| 19 万 | 2230ms / 1049ms | 24.0ms / 22.6ms | 1.00ms / 0.93ms |

4 个虚拟用户能做到的吞吐（次/秒，两轮的中位数）：

| 翻到第几行 | 偏移量 | 延迟关联 | 游标 |
|------|------|------|------|
| 0（第一页） | 3474 | 3152 | 4018 |
| 1000 | 1283 | 2768 | 3895 |
| 1 万 | 186 | 1293 | 3998 |
| 10 万 | 16 | 283 | 3766 |
| 19 万 | 2.8 | 172 | 4093 |

### 1、第一页上三种写法没有差别

翻到第 0 行时三种写法都是 1ms 上下。功能测试、小数据量的联调、只翻前几页的压测，都落在这一行里，所以偏移量分页的问题在上线前通常看不出来。

### 2、偏移量：先是 CPU，再是磁盘

偏移量翻到 1 万行是 20ms 上下，翻到 10 万行是 157–675ms，翻到 19 万行要 1–2 秒，4 个并发每秒只能完成不到 3 次。

它慢在「读出来再丢掉」：`LIMIT 100000, 20` 要沿索引读 100020 行，查询要的 `order_no`、`status` 这几列不在索引里，每一行都得回表。这个用户的订单散在整张表里，10 万次回表落在几乎同样多的不同数据页上。

10 万行那一档两轮差了 4 倍，差别在这些数据页在不在内存里：

| 偏移量，翻到第几行 | 轮次 | 平均耗时 | 数据库虚拟机 CPU | 其中等磁盘（iowait） |
|------|------|------|------|------|
| 1 万 | 第一轮 / 第二轮 | 24.3ms / 19.3ms | 85% / 87% | 0 / 0 |
| 10 万 | 第一轮 | 675ms | 42% | 14.7% |
| 10 万 | 第二轮 | 157ms | 96% | 0 |
| 19 万 | 第一轮 / 第二轮 | 2230ms / 1049ms | 23% / 40% | 19.1% / 14.9% |

第二轮跑的时候这部分数据页还在缓存里，查询只耗 CPU；第一轮和 19 万行的两轮都要读盘，CPU 反而闲着。**翻得越深，查询碰到的数据页越多，迟早会超过内存能装下的量，耗时就从毫秒级的计算变成秒级的读盘**，而且会把别的查询要用的页挤出缓存。

### 3、延迟关联：便宜一到两个数量级，但仍然随深度涨

延迟关联在 10 万行是 13–16ms，19 万行是 23–24ms，分别是偏移量的十分之一到七十分之一。子查询只读索引 `(user_id, id)`，同一个用户的索引项是挨着的，数过 10 万个索引项只碰到几百个索引页，然后只回表 20 次。

它没有消除「数过前面的行」这件事，耗时仍然和深度成正比。翻到 10 万行以后，4 个并发就把 4 核的数据库用到 83%–87%，吞吐只有 172–283 次/秒。延迟关联适合「必须能跳到第 N 页、翻不了太深」的后台列表，不适合当成深分页的通用解法。

### 4、游标：不随深度变化

游标在五个深度上都是 0.9–1.2ms，吞吐 3800–4100 次/秒，和第一页一样。`id < ?` 让查询直接从索引里上一页结束的位置开始读，前面有多少行与它无关。

代价是接口形态变了：不能跳页，不返回总数。mall-evolution 的用户端订单列表是无限下拉，本来就不需要这两样，取舍见 [接口设计](/project/3_api_design)。

## 四、逐单查明细

最近 20 单、每单 2 条明细，三种查法（第一轮 / 第二轮）：

| 查法 | 每个请求几条 SQL | 平均耗时 | P99 | 16 个并发的吞吐（次/秒） |
|------|------|------|------|------|
| 先查 20 单，再逐单查明细 | 21 | 24.6ms / 20.8ms | 45.1ms / 32.2ms | 650 / 770 |
| 先查 20 单，再一次 `IN` 查全部明细 | 2 | 4.29ms / 4.00ms | 7.96ms / 6.92ms | 3712 / 3985 |
| 一条 `JOIN` 把订单和明细一起查出来 | 1 | 3.52ms / 3.11ms | 7.35ms / 5.68ms | 4527 / 5114 |

逐单查的耗时是另外两种的 5–7 倍。MySQL 的语句统计里，每条语句在服务端执行的平均时间是：

| 语句 | 服务端平均执行时间（第一轮 / 第二轮） |
|------|------|
| 查一单的明细（`WHERE order_id = ?`） | 0.18ms / 0.15ms |
| 查 20 单（游标那条） | 0.25ms / 0.23ms |
| `IN` 查 20 单的明细 | 0.55ms / 0.53ms |
| `JOIN` 一次查完 | 0.67ms / 0.60ms |

逐单查的 21 条语句在数据库里加起来只要 3.3–3.8ms，接口却用了 21–25ms。**剩下的时间不在执行 SQL，在 21 次往返上**：每一次都要从连接池借连接、把语句发过去、等响应、把结果映射成对象，服务端每收一条语句也有解析、收发包的固定开销，这些都不算在语句的执行时间里。单条 SQL 再快也省不掉。

三种查法压的时候数据库一样忙，虚拟机的 CPU 都在 67%–74%。同样的数据库开销，逐单查每秒完成 650–770 个请求，`JOIN` 完成 4500–5100 个：逐单查每秒发给数据库 1.4–1.6 万条语句，`JOIN` 只有 5000 条上下。

`JOIN` 比 `IN` 快 20% 左右，少了一次往返。它的代价是订单的列在每条明细行上重复一遍，这里每单只有 2 条明细，重复得不多；一单有几十条明细时返回的数据量会明显变大，那时 `IN` 更合适。

正式代码里没有这个问题：订单列表不带明细，订单详情只查一单。这一组是用 `demo` 接口专门造出来的。

## 五、批量写

![四种批量写法在不同批大小下每秒写入的行数](../assets/high-perf/exp-data-access-batch.svg)

图里的「逐条」和「一条语句」把驱动改写开、关两组合在一起取了中位数，这两种写法不受这个开关影响。下表分开列，每秒写入的行数是两轮共 6 遍的中位数，括号里是最小到最大：

| 写法 | 每批行数 | 驱动不改写（默认） | `rewriteBatchedStatements=true` |
|------|------|------|------|
| 逐条插入，每条自动提交 | 1 | 1848（1535–1972） | 1849（1545–1930） |
| 逐条插入，1000 条一个事务 | 1000 | 2136（1909–2300） | 2166（1934–2329） |
| 一条语句多行（MyBatis `foreach`） | 10 | 12576（11178–13418） | 12152（11382–12856） |
| | 100 | 35276（27796–42394） | 38747（30079–43175） |
| | 1000 | 44533（36966–53700） | 49020（37719–52722） |
| | 5000 | 47316（35819–54774） | 44658（33098–54256） |
| JDBC 批量（`batchUpdate`），一批一个事务 | 10 | 3060（2656–3253） | 7218（6092–8661） |
| | 100 | 4012（3399–4585） | 42091（35813–46230） |
| | 1000 | 4404（3731–4492） | 82338（65599–87807） |
| | 5000 | 4472（3840–4596） | 81683（54428–97254） |

### 1、用了批量接口但驱动不改写，只快一倍多

JDBC 批量在驱动默认设置下是 3060–4472 行/秒，是逐条插入的 1.7–2.4 倍，批大小从 10 加到 5000 只多了四成。`addBatch` / `executeBatch` 只是把语句攒在客户端，Connector/J 默认仍然一条一条发给服务端，往返次数没有变。

加上 `rewriteBatchedStatements=true`，驱动把一批 `INSERT` 改写成一条多行语句：每批 1000 行时 8.2 万行/秒，是不改写的 18 倍、逐条插入的 44 倍。**这个开关不开，批量接口大半是白用的。**

### 2、包进事务只多 16%，这是这台数据库的特例

「逐条插入，1000 条一个事务」比每条自动提交只快 16%（2136 对 1848 行/秒）。通常的说法是每条自动提交要多一次刷盘，包进事务能快很多；这台 MySQL 放宽了落盘设置，提交时不等刷盘，省下来的只有提交本身那一点。

这一行不能拿来说明「事务分批没用」。落盘设置是默认值（每次提交都刷盘）时差别会大得多，这次没有量。

### 3、一条语句多行：不看驱动开关，1000 行一批就够

MyBatis `foreach` 拼出来的多行 `INSERT` 本身就是一条语句，开不开驱动改写结果一样（两列的差别都在各自的波动范围里）。每批 10 行是 1.2 万行/秒，100 行是 3.5–3.9 万，1000 行是 4.5–4.9 万，再加到 5000 行没有更快。

它在每批 1000 行时比改写后的 JDBC 批量慢四成（4.9 万对 8.2 万）。两者发给服务端的语句是同一种形状，差别应该在客户端：`foreach` 每一批都要把 8000 个占位符的动态 SQL 重新拼一遍、解析一遍，JDBC 批量只解析一条单行模板，改写由驱动完成。这一段没有单独采样验证。

正式代码的 [`OrderItemMapper#batchInsert`](https://github.com/Clarence404/mall-evolution/blob/main/mall-order/src/main/java/io/github/clarence404/mall/order/domain/OrderItemMapper.java) 用的就是 `foreach`，一单的明细只有几条到十几条，和下单的其他语句在同一个事务里，这个量级上两种写法没有区别。要一次写几万行的导入、对账类任务才值得换成 JDBC 批量加驱动改写。

## 六、几条可以带走的做法

| 做法 | 依据 |
|------|------|
| 用户端列表用游标翻页 | 五个深度都是 1ms 上下；偏移量翻到 19 万行要 1–2 秒 |
| 必须跳页的后台列表用延迟关联，并限制最大页数 | 10 万行处 13–16ms，是偏移量的十分之一以下；但 4 个并发就能把 4 核的库用到 85% |
| 分页的压测要翻到深处，数据量要比内存大 | 第一页三种写法都是 1ms；同一条查询在数据页进没进缓存时差 4 倍 |
| 一页里要带子表数据时，用一次 `IN` 或 `JOIN`，不在循环里查 | 21 条语句在库里只要 3–4ms，接口要 21–25ms |
| 大批量写入：JDBC 批量、驱动改写、一批一个事务，三样一起上 | 每批 1000 行时 8.2 万行/秒；不开改写只有 4400 |
| 批大小取几百到一千 | 100 行已有 1000 行的一半以上，1000 到 5000 不再增长 |

## 七、复现

```powershell
.\experiments\j-data-access\run.ps1 -Variant j2-deep-paging
.\experiments\j-data-access\run.ps1 -Variant j3-n-plus-one
.\experiments\j-data-access\run.ps1 -Variant j1-batch-write           # 还有 j1-batch-write-rewrite
```

第一次运行会先灌 100 万订单，约两分钟。参数与脚本在 mall-evolution 的 [`experiments/`](https://github.com/Clarence404/mall-evolution/tree/main/experiments) 目录。几点局限：

- 数据库的缓冲池只有 128MB，比数据小得多，深分页读盘来得比生产库早；生产库内存大，同样的现象会出现在更大的数据量和更深的页上
- 大客户的 20 万单是和其他用户的订单交错写入的，回表几乎每次落在不同的页上；如果一个用户的订单在表里挨着（比如按用户分区或批量导入），偏移量分页会没这么慢
- 每单固定 2 条明细，`JOIN` 的重复数据很少；明细多的时候 `JOIN` 和 `IN` 的先后可能反过来
- 数据库放宽了落盘设置，「包进事务」那一行偏低；批量写的绝对数字也会比每次提交都刷盘的库高
- 批量写每种组合只有 6 遍，同一组合里最快和最慢相差两到四成，表里两列相差在这个范围以内的不算差别

## 小结

- 偏移量分页在第一页和游标一样快，翻到 10 万行是 157–675ms，19 万行是 1–2 秒；耗时先花在 CPU 上，数据页装不进内存之后花在磁盘上
- 延迟关联比偏移量便宜一到两个数量级，但耗时仍随深度增长；游标在任何深度都是 1ms 上下
- 逐单查明细的 21 条语句在数据库里只要 3–4ms，接口要 21–25ms，慢在往返；一次 `IN` 或 `JOIN` 是 3–4ms
- 批量写的关键是驱动改写：同样用 JDBC 批量，开了是 8.2 万行/秒，不开是 4400
- 这几种写法在数据量小的时候都不慢，验证要放在够大的数据和够深的页上

## 参考资料

- 批量语句改写与预编译相关的连接属性：[MySQL Connector/J Configuration Properties](https://dev.mysql.com/doc/connector-j/en/connector-j-reference-configuration-properties.html)
- 优化器提示的写法：[MySQL 8.4 Reference Manual: Optimizer Hints](https://dev.mysql.com/doc/refman/8.4/en/optimizer-hints.html)
- 实验方案与参数：[mall-evolution experiments/README](https://github.com/Clarence404/mall-evolution/blob/main/experiments/README.md)

> 下一篇：[收集器与预热实验](./14_exp_jvm) —— 换收集器、换堆大小、换 JDK、不预热就接流量，尾部耗时各差多少。
