---
description: InfluxDB 3 宽表建模与写入、Redis 最新值、历史查询自动聚合、缺测与零值、扫描文件上限、数据新鲜度
---

# 时序存储与历史查询

> 前置阅读：[数据流水线](./16_conduit_pipeline)、[时序数据库](/nosql/4_time_series_db)、[物模型与解码](./14_conduit_thing_model)

流水线把校验过的测点写进两个地方：InfluxDB 3 存全部历史，Redis 存每个测点的最新值。本篇讲宽表建模与写入、最新值的存法、历史查询的原始与自动聚合、缺测与零值约定、扫描文件上限和数据新鲜度，基线为 JDK 21、Spring Boot 3.5。

---

## 一、两个存储各管什么

设备详情页上有两类数据：一张「最新值」表格，每 5 秒刷新；几张「历史」曲线，按选定的时间范围查询。它们的读法完全不同，所以存在两个地方。

| | InfluxDB 3 Core | Redis |
|--|-----------------|-------|
| 存什么 | 每次上报的每个测点，保留 30 天 | 每台设备每个测点的最后一个有效值 |
| 结构 | 一张表 `property`，每个测点一列 | 每台设备一个 hash `conduit:latest:{deviceKey}` |
| 谁来读 | 历史曲线、迷你趋势线 | 最新值表格、设备列表的「最后上报」 |
| 读的方式 | SQL，按时间范围过滤、聚合 | 一次 `HGETALL` |
| 写入顺序 | 先写 | InfluxDB 写成功后才写 |

流水线对两者的写入都成功后才确认消息，顺序与重试见 [数据流水线](./16_conduit_pipeline)。相关的类都在 `conduit-server` 的 `telemetry` 包：

| 类 | 职责 |
|----|------|
| `TelemetryPoint` / `LineProtocol` | 一次上报的结果；转成 InfluxDB 行协议 |
| `TelemetryWriter` | 整批写入、按字节切块、把被拒的行映射回原始下标 |
| `InfluxClient` | 自己写的最小 HTTP 客户端：`/api/v3/write_lp`、`/api/v3/query_sql` |
| `InfluxDatabaseInitializer` | 启动时建库并设置保留期 |
| `LatestValueStore` | 最新值的 Redis 读写 |
| `HistoryRequest` / `HistoryService` | 历史接口的参数校验；选模式、执行查询、组装曲线 |
| `BucketPolicy` / `HistoryQueryBuilder` | 选时间桶；生成计数、原始、聚合三种 SQL |
| `InfluxSchema` | `property` 表的列名与类型缓存 |

时序数据库的通用概念（measurement、tag、field、时间线）与几种产品的对比见 [时序数据库](/nosql/4_time_series_db)，这里只讲 Conduit 的用法。

---

## 二、数据模型：一张宽表

所有租户、所有产品的数据写进同一张表（InfluxDB 里叫 measurement）`property`：

| 行协议里的位置 | 列 | 来源 |
|---------------|----|------|
| measurement | `property` | 固定 |
| tag | `tenant_id` | 设备身份里的租户 id（不取自报文） |
| tag | `product_key` | 设备所属产品 |
| tag | `device_key` | 设备 Key |
| field | 每个测点一列，列名就是测点标识 | 通过物模型校验的测点 |
| 时间戳 | `time` | 报文里的 `ts`（毫秒）；没带则用平台接收时间 |

一次上报变成一行：

```text
property,tenant_id=1,product_key=pk8f3a,device_key=dk01 Ua=220.1,Ia=5.2,st=1i,alarm=false 1760400000000
```

- **tag 只放身份，不放组织**：项目、站点这些归属可以调整，而已经写入的 tag 改不了；需要按组织查时，先在 PostgreSQL 里查出有权限的设备，再按 `device_key` 查
- **`tenant_id` 来自平台，不来自设备**：流水线用设备身份缓存里的租户，设备报文里写什么都影响不了它
- **测点是列而不是行**：一次上报的十几个测点在同一行，查「某设备某几个测点的曲线」时只读这几列

字段类型跟着物模型走，见 [`LineProtocol#fieldValue`](https://github.com/Clarence404/conduit-iot/blob/811e441/conduit-server/src/main/java/dev/conduit/server/telemetry/LineProtocol.java)：

| 物模型类型 | Java 值 | 行协议 | InfluxDB 列类型 |
|-----------|--------|--------|----------------|
| `DOUBLE` | `Double`（必须有限） | `220.1` | Float64 |
| `INT` / `ENUM` | `Long` | `1i` | Int64 |
| `BOOL` | `Boolean` | `true` | Boolean |
| `TEXT` | `String` | `"auto"` | Utf8 |

没有物模型的产品，数值一律按浮点写入（`220` 与 `220.0` 等价）。`null`、`NaN`、无穷大在这里直接拒绝，不会被改写成 0。

### 1、共用一张表的代价

**同名测点在全表必须是同一种类型。** InfluxDB 的列类型在第一次写入时确定，之后有人往同一列写别的类型，那一行会被拒绝。产品 A 把 `temp` 定义成浮点、产品 B 定义成整数，后写入的那个就会一直失败，对应的消息进死信 `FIELD_TYPE_CONFLICT`。所以物模型里数据类型定义后不可修改，已经以浮点写过的测点也不能再定义成整数或枚举。

写入用的是「接受部分成功」的方式：一批里被拒的行由 InfluxDB 按行号返回，其余行照常写入。`TelemetryWriter` 把行号映射回这批消息里的原始下标，流水线只让冲突的那几条进死信。

### 2、保留期只能在建库时定

InfluxDB 3 写入一个不存在的库会自动建库，但不带保留期，之后也设不上。所以 [`InfluxDatabaseInitializer`](https://github.com/Clarence404/conduit-iot/blob/811e441/conduit-server/src/main/java/dev/conduit/server/telemetry/InfluxDatabaseInitializer.java) 在启动时先建库（`conduit.influx.retention`，默认 30 天），库已存在就不动。

这里选的扩展点是 `SmartInitializingSingleton` 而不是 `ApplicationRunner`：前者在所有单例创建完、`SmartLifecycle`（也就是流水线的消费线程）启动之前执行；后者晚于消费线程，会和第一批写入抢跑。建库失败则应用启动失败，交给容器的重启策略。

---

## 三、写入：整批、切块、幂等

```java
public WriteResult write(List<TelemetryPoint> points) {
    // 一、逐点转行协议；转不了的（不支持的类型、null）先记为被拒，不发给 InfluxDB
    // 二、按字节切块发送
    for (int from = 0; from < lines.size(); ) {
        int to = chunkEnd(lines, from);                       // 累加到不超过 max-request-bytes
        for (InfluxClient.LineError error : send(lines.subList(from, to))) {
            int line = from + error.lineNumber() - 1;         // 块内行号 → 批内下标
            rejected.add(new WriteResult.Rejected(indexes.get(line), error.message()));
        }
        from = to;
    }
    return new WriteResult(rejected);
}
```

| 情况 | 处理 |
|------|------|
| 全部成功 | 返回空的拒绝列表 |
| 部分行被拒（400 加部分写入的响应体） | 返回被拒行的下标，其余已写入 |
| 连接失败、超时、5xx | `TelemetryUnavailableException`，流水线原地退避重试 |
| 整个请求被拒：400（非逐行拒绝）或 413 | `IllegalStateException`，不原地重试 |

- **按字节切块**：单次请求不超过 `conduit.influx.max-request-bytes`（默认 8 MiB，InfluxDB 的上限是 10 MiB）。单行本身就超限时仍然单独成块，让 InfluxDB 明确拒绝它，好过无声丢弃
- **413 不能当成「下游不可用」**：重发同样的载荷永远不会成功，当成可恢复就是无限重试、流水线停摆。这是一次压测事故之后改的，经过见 [数据流水线](./16_conduit_pipeline)
- **幂等靠时序库自己**：同一组 tag、同一个时间戳的点再写一次，覆盖为相同的值。设备重发、总线重投、遥测重放都靠这一条

### 1、2xx 不等于落盘

2026-10-20 对 InfluxDB 3.12.0 的源码和行为做过一次专项调查，结论分两层：

- **写入会等 WAL**：`no_sync` 默认是 `false`，写入要等下一次 WAL 刷新（默认 1 秒一次）才返回。所以每批写入耗时接近 1 秒，流水线的批处理就是围绕这个周期设计的
- **但 WAL 文件没有 fsync**：底层对象存储的本地文件实现只做写入和改名，没有同步落盘。2xx 的真实含义是「字节已进入操作系统页缓存」，丢数据的窗口是内核回写窗口（Linux 默认约 30 秒）

实测强杀 InfluxDB 进程三轮，2000 条都在（页缓存还在）；改成 `no_sync=true` 则 2000 条只剩 1380 条。所以默认值必须保持，不能为了吞吐去改它。断电这个缺口在应用侧消不掉，补救手段是**遥测重放**：流水线确认消息只是把它移出待确认列表，条目本身还留在 Redis 上行流里（约 100 万条，Redis 配置为每次写入都刷盘），平台管理员可以按时间范围把仍在流里的原始报文重新写一遍，单次最多 6 小时。重放是幂等的，不更新在线状态，也不重复写死信。

---

## 四、最新值

每台设备一个 Redis hash：

```text
conduit:latest:dk01
  Ua      {"v":220.1,"ts":1760400000000}
  Ia      {"v":5.2,"ts":1760400000000}
  st      {"v":1,"ts":1760399990000}
  __last  1760400000000
```

每个测点各带各的时间戳，`__last` 是这台设备见过的最大时间戳，设备列表的「最后上报」读的是它。测点名不能以 `__` 开头，就是为这个保留字段让路。

写入用一段 Lua 脚本（[`latest-update.lua`](https://github.com/Clarence404/conduit-iot/blob/811e441/conduit-server/src/main/resources/redis/latest-update.lua)），核心是**逐测点比较时间戳**：

```lua
local ts = tonumber(ARGV[1])
local last = redis.call('HGET', KEYS[1], '__last')

if last and ts < tonumber(last) then
  -- 慢路径：本条不是最新的（补传、乱序），逐测点比较，旧数据不能盖掉新值
  for i = 2, #ARGV, 2 do
    local current = redis.call('HGET', KEYS[1], ARGV[i])
    if (not current) or ts >= tonumber(cjson.decode(current)['ts']) then
      redis.call('HSET', KEYS[1], ARGV[i], ARGV[i + 1])
    end
  end
  return
end

-- 快路径：ts >= __last，本条就是最新的，全部测点直接覆盖
redis.call('HSET', KEYS[1], unpack(ARGV, 2))
redis.call('HSET', KEYS[1], '__last', ARGV[1])
```

- **为什么按测点比**：设备补传的旧数据、遥测重放、乱序到达，都会带着更早的 `ts` 进来。它们要写进历史，但不能覆盖页面上的最新值
- **快路径为什么等价**：每个测点存的 `ts` 一定不大于 `__last`，所以 `ts >= __last` 时不可能有哪个测点比本条更新，逐个比较纯属多余。顺序到达是绝对主流，这条路径把每测点一次读、一次解析、一次写降成了一次写
- **用 `>=` 而不是 `>`**：同一时间戳的重复写入会覆盖为相同的值，幂等
- **参数很多时逐个写**：`unpack` 受 Lua 栈大小限制，测点极多的设备会报错，所以实际脚本在参数超过 200 个时改为循环 `HSET`（上面是精简后的示意）

读取接口 `GET /api/v1/devices/{deviceKey}/latest` 把 hash 和物模型（经缓存）合并，补上名称、单位、小数位和枚举标签；物模型里没定义的测点照样返回，只是这几项为 null。

::: tip 最新值不代表「现在有上报」
它保留的是最后一次有效上报的值和那次的时间戳。后续报文缺了这个测点，不会刷新它的时间，也不会把它归零。所以最新值表格里每个测点都带自己的时间，是否陈旧要看时间而不是看值。
:::

访问这两个存储之前有一条硬规则：先经受租户过滤的 PostgreSQL 查询拿到设备，再用查出来的 `deviceKey` 去读 Redis 或 InfluxDB，不直接用请求参数里的 `deviceKey`。Redis 的 key 里没有租户维度，隔离靠的就是这一步，见 [多租户与授权](./18_conduit_tenant)。

---

## 五、历史查询：原始还是聚合

```text
GET /api/v1/devices/{deviceKey}/history?properties=Ua,Ia,st&from=<毫秒>&to=<毫秒>
```

| 参数 | 规则 |
|------|------|
| `deviceKey` | 按当前租户与授权范围查设备，查不到返回 404 |
| `properties` | 逗号分隔，去重后 1～8 个；每个须匹配 `^[A-Za-z][A-Za-z0-9_]{0,63}$`，且不能是 `time` 与三个 tag 列名 |
| `from` / `to` | 毫秒，半开区间 `[from, to)`；都不传时取最近 1 小时；只传一个返回 400；跨度 1 分钟～30 天 |

前端只选时间范围，返回原始点还是聚合值由服务端决定。

![历史查询：返回原始点还是聚合](../assets/iot/conduit-history-query.svg)

### 1、先数点数

[`HistoryService#query`](https://github.com/Clarence404/conduit-iot/blob/811e441/conduit-server/src/main/java/dev/conduit/server/telemetry/HistoryService.java) 的第一条 SQL 是计数，一次查出每个测点在范围内的非空点数：

```sql
SELECT COUNT("Ua") AS "n_0", COUNT("Ia") AS "n_1", COUNT("st") AS "n_2"
FROM property
WHERE tenant_id = $tenant AND product_key = $product AND device_key = $device
  AND time >= $from AND time < $to
```

- **所有测点都不超过 1000 点**：原始模式，按时间升序返回原始点
- **任何一个超过**：聚合模式，所有测点一起聚合

同一次请求的所有测点用同一种模式、同一个时间桶，这样几张图的横轴才对得齐。

### 2、桶宽：固定档位里取最小的

```java
public static final int MAX_POINTS = 1000;

public static final List<Duration> LADDER = List.of(
        Duration.ofSeconds(1), Duration.ofSeconds(5), Duration.ofSeconds(10), Duration.ofSeconds(30),
        Duration.ofMinutes(1), Duration.ofMinutes(5), Duration.ofMinutes(15), Duration.ofMinutes(30),
        Duration.ofHours(1), Duration.ofHours(3), Duration.ofHours(6), Duration.ofHours(12));

public static Duration bucketFor(long spanMs) {
    for (Duration bucket : LADDER) {
        if (spanMs <= bucket.toMillis() * MAX_POINTS) {
            return bucket;                // 满足「桶数 ≤ 1000」的最小档
        }
    }
    return LADDER.getLast();
}
```

| 查询跨度 | 桶宽 | 桶数 |
|---------|------|------|
| 1 小时 | 5 秒 | 720 |
| 6 小时 | 30 秒 | 720 |
| 24 小时 | 5 分钟 | 288 |
| 7 天 | 15 分钟 | 672 |
| 30 天 | 1 小时 | 720 |

- **上限 1000 点**：一张几百像素宽的曲线图画不下更多的点，再多只是浪费传输和渲染
- **档位固定而不是「跨度除以 1000」**：再配合分桶原点固定在 1970-01-01，相邻两次请求（比如每 30 秒的自动刷新）的桶边界完全一致，曲线不会来回跳
- **1 小时不一定聚合**：设备 10 秒一报时 1 小时只有 360 个点，走原始模式；上表的桶宽只在点数超过 1000 时才用得上

### 3、数值取均值与范围，状态取最后值

```sql
SELECT date_bin(INTERVAL '300 seconds', time) AS t,
       avg("Ua") AS "avg_0", min("Ua") AS "min_0", max("Ua") AS "max_0",
       selector_last("st", time)['value'] AS "last_1"
FROM property
WHERE tenant_id = $tenant AND product_key = $product AND device_key = $device
  AND time >= $from AND time < $to
GROUP BY 1 ORDER BY 1
```

| 测点类型 | 模式 | 每个点 |
|---------|------|--------|
| 数值（`DOUBLE`、`INT`，以及没有物模型的数值列） | `AGG` | `[桶起点, avg, min, max]` |
| 状态（`BOOL`、`ENUM`） | `LAST` | `[桶起点, 桶内时间最大的那个值]` |
| 原始模式下的所有测点 | `RAW` | `[ts, value]` |

数值曲线画的是平均值折线，外面一圈最小到最大的浅色波动带，尖峰不会被平均掉；状态量求平均没有意义（「运行」和「停机」的平均是什么），所以取桶内最后一个值，画成阶梯线。文本测点不支持历史曲线，返回 400。

测点的类型这样确定：物模型里有定义的按物模型；没有的按 InfluxDB 里实际的列类型；两边都没有（从未上报过）的返回一条空曲线，不报错。

### 4、列名怎么防注入

SQL 里唯一来自请求的可变部分是列名，值都走 `$参数`。列名过三道关：

1. 匹配标识符正则，且不是保留列名
2. 存在于 [`InfluxSchema`](https://github.com/Clarence404/conduit-iot/blob/811e441/conduit-server/src/main/java/dev/conduit/server/telemetry/InfluxSchema.java) 缓存里：它查 `information_schema.columns` 得到 `property` 表的全部列与类型，缓存 60 秒；请求里出现缓存中没有的列时强制刷新一次（可能刚被首次写入），刷新后仍没有就当作从未上报
3. 拼进 SQL 时统一加双引号

第二道关还有一个作用：InfluxDB 对不存在的列返回 500，不查一下就没法区分「这个测点还没数据」和「查询出错」。结果列的别名用位置编号（`n_0`、`avg_1`），和测点名无关。

`tenant_id` 条件是固定写在 SQL 里的，值来自当前登录身份，不来自请求参数。

### 5、错误码

| 情况 | 响应 |
|------|------|
| 参数不合法、文本测点 | 400 |
| 设备不存在、属于其他租户或不在授权范围内 | 404 |
| 扫描文件数超过时序库上限 | 400，`code` 为 `HISTORY_SCAN_LIMIT` |
| InfluxDB 不可达或返回 5xx | 503「时序库暂不可用」 |
| 其他查询错误 | 500，不暴露 SQL |

---

## 六、缺测与零值

这是全项目的一条强制约定，适用于上报、解码、存储、聚合、接口、曲线：缺测是「这个时刻没有上报」，展示为无数据；数值 `0`、布尔 `false`、枚举值 `0` 是有效值，正常显示并参与计算；无效数据拒绝并留记录，不改写成 0；查询失败明确报错，不伪装成无数据或全零。五种情况的对照表与禁止的写法（`value ?? 0`、`COALESCE(value, 0)` 之类）见 [物模型与解码](./14_conduit_thing_model)，原文是仓库的 [遥测值语义](https://github.com/Clarence404/conduit-iot/blob/811e441/docs/telemetry-value-semantics.md)。本节讲它在存储与查询这一段怎么落地。

### 1、聚合：空桶返回 null

`avg` / `min` / `max` 只计算非空样本，0 正常参与。问题在于 `GROUP BY` 只会输出有数据的桶，中间断了的那几个桶在结果里根本不存在，前端把相邻两个点一连，缺口就被抹平了。所以聚合查询之后，服务端按桶宽把 `[from, to)` 覆盖的桶补齐：

```java
long width = bucket.toMillis();
long first = Math.floorDiv(scope.from(), width) * width;      // 首桶按 1970 原点向下对齐，可能早于 from
for (long ts = first; ts < scope.to(); ts += width) {
    List<Object> point = byTime.get(ts);
    aligned.add(point != null ? point : column.state()
            ? Arrays.asList(ts, null)                         // 状态测点的空桶
            : Arrays.asList(ts, null, null, null));           // 数值测点的空桶
}
```

- **补的是返回结果，不是数据**：不往数据库里写任何占位样本
- **前端在 null 处断线**：折线、阶梯线、波动带、迷你趋势线都设置为不连接空点，提示里显示「无数据」；整条都是 null 时显示「该时段没有数据」
- **不前值填充、不插值**：将来要做插值，也得是用户显式选择并标记为估算值

### 2、原始模式不猜

原始模式只返回实际存在的样本。两个点之间隔了 10 分钟，是设备停报了还是它本来就 10 分钟一报，服务端不知道，因为物模型里还没有「采样周期」这个概念。所以原始模式不推测缺失时刻，这一点记为待设计，而不是拿一个经验阈值去猜。

### 3、演示数据

为了让这个约定看得见，演示环境有一台专用设备「缺测与零值对照（演示）」，由脚本写入一段固定的历史：20 分钟正常值、15 分钟不写（缺测）、10 分钟明确写入 0.0、再 15 分钟正常值。1 小时范围按 5 秒桶聚合后，返回 180 个 null 桶和 120 个零值桶：曲线在缺测区间断开，零值区间贴着 0 刻度画。这台设备是禁用的，避免模拟器把缺口填平。

---

## 七、扫描量限制

历史接口对外承诺最长查 30 天。上线后发现默认配置下超过 2 天的查询全部失败，而且失败得很快（0.01 秒），不是超时。

| 事实 | 值 |
|------|----|
| InfluxDB 3 Core 的数据文件按 `--gen1-duration` 切分，默认值 | 10 分钟 |
| 由此每天产生的 Parquet 文件数 | 144 个 |
| 单次查询允许打开的文件数 `--query-file-limit`，默认值 | 432 |
| 432 ÷ 144 | 恰好 3 天 |

两个默认值相乘就是那道墙。更关键的是下面两条：

- **按设备过滤不减少文件数**：Core 版不做文件合并，时间范围内的文件全部要打开，tag 过滤只影响读出多少行。用和历史接口完全相同的条件实测：1 天 0.13 秒返回，3 天、7 天、30 天全部在规划阶段就被拒绝
- **文件粒度调不大**：最初的判断是把 `--gen1-duration` 调到 1 小时，文件数能降到每天 24 个，并且已经写进了编排文件和文档。部署时 InfluxDB 直接起不来，报错说这个参数只接受 1 分钟、5 分钟、10 分钟，默认的 10 分钟已经是最大。帮助信息里只写了默认值，没列取值范围

于是唯一的杠杆是放大文件上限：30 天需要 4320 个文件，取 `INFLUXDB3_QUERY_FILE_LIMIT=5000`。同时给 InfluxDB 容器加了内存上限（默认 2g），因为打开的文件越多内存越高，一次失控的查询不该拖垮同机的其他服务。

| 范围 | 计数查询 | 聚合查询（1 小时桶） | 进程内存 |
|------|---------|---------------------|---------|
| 1 天 | 0.21 秒 | 0.14 秒 | 169 MB |
| 3 天 | 0.24 秒 | 0.18 秒 | 274 MB |
| 7 天 | 1.09 秒 | 1.18 秒 | 431 MB |
| 12 天 | 0.85 秒 | 0.86 秒 | 508 MB |

测试时库里只有 12 天数据，所以 **30 天这一档没有真实数据可测**，按文件数线性外推约 1.4 GB、3 秒，这是推算，报告里没有把它算作通过。

上限仍然可能被撞到（数据更密、上限被改小），所以服务端把这个错误单独分类：

```java
} catch (InfluxHttpException e) {
    if (e.fileLimitExceeded()) {          // 报文同时含 parquet files 与 file limit
        throw new ApiException(HttpStatus.BAD_REQUEST, SCAN_LIMIT, SCAN_LIMIT_CODE);
    }
    if (e.status() >= 500) {
        throw new ApiException(HttpStatus.SERVICE_UNAVAILABLE, UNAVAILABLE);
    }
    …
}
```

- **判定用两个关键词**，不依赖报文里的具体数字和后半段的文案
- **返回 400 而不是 503**：用户缩短范围就能成功，这不是故障；前端按 `code`（`HISTORY_SCAN_LIMIT`）区分，而不是去匹配中文提示
- **前端不弹 toast**：快捷范围每 30 秒自动刷新，持续失败会刷屏。改为保留旧曲线并常驻提示，写明旧曲线对应的真实时间范围；首次加载就失败时显示带「重试」按钮的空状态

::: warning 只做参数调研不够
`--gen1-duration=1h` 这个错误如果不实际部署一次，会随提交进入仓库，而它的后果是 InfluxDB 起不来。编排改动要在真实环境里启动过才算验证。
:::

---

## 八、数据新鲜度

「曲线的最后一个点为什么不是现在」这个问题，拆开看是四段时间相加：

| 环节 | 量级 |
|------|------|
| 设备上报周期 | 演示设备 10 秒一报 |
| 接入：EMQX → transport 微批 → Redis | 毫秒级，微批最多多等 5 毫秒 |
| 流水线：等一批写完 InfluxDB | 约 1 秒，由 WAL 刷新周期决定 |
| 界面刷新 | 最新值 5 秒，历史曲线 30 秒（仅快捷范围、未缩放时） |

所以页面上看到的延迟不是严格的「一个上报周期」，要叠加链路处理和界面刷新。一次链路恢复后的实测里，在线设备的「最后上报」距查询时刻约 0.8～1.6 秒，Redis 消费组的积压只有十条上下。服务端有两个地方可以直接看：

- **`conduit.pipeline.ingest.latency`**：每条成功入库的消息，从 transport 收到到入库完成的耗时
- **设备列表的 `reported` 筛选**：`RECENT`（一小时内有上报）、`STALE`（有上报但超过一小时）、`NEVER`（从未上报），依据就是最新值里的 `__last`

排查「数据不新」时先分清是哪一种：

| 现象 | 多半是 |
|------|--------|
| 只有某一台设备停在固定时间 | 设备自己没报，或它本来就是静态的演示数据（第六节那台禁用的演示设备就被误会过） |
| 所有设备都停在同一时刻 | 链路断了：看 transport 的健康检查与会话指标、Redis 上行流的积压 |
| 最新值是新的，曲线末端旧 | 界面还没刷新，或者 InfluxDB 写入在重试 |

第二种在 2026-10-26 真实发生过：所有设备的最后上报停在同一分钟，根因在 EMQX 的会话，而不在存储。它是后来关闭磁盘持久会话的起因之一，见 [可靠上报与接入层主备](./15_conduit_reliable_uplink) 与 [压测与瓶颈排查](./22_conduit_capacity)。

---

## 九、和 Kafka + Flink + TDengine 路线的关系

站内 [遥测数据链路](./9_data) 讲的是另一条更重的路线：MQTT → Kafka → Flink → TDengine。两条路线不矛盾，适用的阶段不同。

| 维度 | Conduit 当前 | [遥测数据链路](./9_data) 的路线 |
|------|-------------|---------------------------|
| 总线 | Redis Streams | Kafka |
| 计算 | server 进程里的流水线，只做解码、校验、写库 | Flink：窗口聚合、离线检测、CEP |
| 时序库 | InfluxDB 3 Core，单节点 | TDengine，超表 + 每设备一张子表 |
| 建模 | 所有产品一张宽表，测点是列，三个 tag | 每类设备一张超表，设备属性是标签 |
| 降采样 | 没有，查询时按桶现算 | 流计算预聚合，分层保留 |
| 保留 | 统一 30 天 | 原始、分钟、小时各有保留期 |
| 组件数 | Redis + InfluxDB，加上本来就要的 PostgreSQL | 再加 Kafka、Flink 两套集群 |

- **宽表对多租户平台省事**：产品是租户自己建的，随时增加；一张表意味着新增产品、新增测点都不用改表结构，查询条件永远是那三个 tag。代价是第二节说的同名测点必须同类型
- **查询时现算的边界**：单设备、30 天、桶数不超过 1000，现算是够的。要跨设备汇总、要秒级数据留一年，就得有降采样和分层保留，那正是 [遥测数据链路](./9_data) 第五节的内容
- **Core 版的两个硬约束**：不做文件合并（第七节的扫描上限由此而来）、单节点。长跨度查询在路线里的解法是分段查询，还没有做
- **什么时候该换**：规则引擎、数据转发、仪表盘都要读同一份数据流时，总线先换；跨设备聚合和长期保留成为刚需时，再考虑时序库。总线在 `MessageBus` 接口后面，时序库的读写集中在 `telemetry` 包的几个类里，换的时候动的范围是清楚的

时序库选型的通用考量（写入模型、压缩、SQL 能力、许可）见 [时序数据库](/nosql/4_time_series_db)。

---

## 十、验证

| 结论 | 证据 | 类型 |
|------|------|------|
| 各种字段类型的行协议格式、名称转义、非法值拒绝 | [`LineProtocolTest`](https://github.com/Clarence404/conduit-iot/blob/811e441/conduit-server/src/test/java/dev/conduit/server/telemetry/LineProtocolTest.java) | 单元 |
| 同一时间戳重复写入是幂等的；类型冲突只拒绝冲突的那个点；各 Java 类型落成对应的列类型 | [`TelemetryWriterIT`](https://github.com/Clarence404/conduit-iot/blob/811e441/conduit-server/src/test/java/dev/conduit/server/telemetry/TelemetryWriterIT.java) | 集成 |
| 超限批次按字节切块；跨块的拒绝行号映射正确；413 不可恢复 | [`TelemetryWriterTest`](https://github.com/Clarence404/conduit-iot/blob/811e441/conduit-server/src/test/java/dev/conduit/server/telemetry/TelemetryWriterTest.java) | 单元 |
| 最新值按测点比较：新值覆盖、旧值忽略、同时间戳幂等、`__last` 取最大 | [`LatestValueStoreIT`](https://github.com/Clarence404/conduit-iot/blob/811e441/conduit-server/src/test/java/dev/conduit/server/telemetry/LatestValueStoreIT.java) | 集成 |
| 保留名与 null 被拒绝，且 hash 不变 | 同上，`#reservedFieldNameIsRejectedAndHashUnchanged`、`#nullValueIsRejected` | 集成 |
| 桶档位与各跨度选出的桶 | [`BucketPolicyTest`](https://github.com/Clarence404/conduit-iot/blob/811e441/conduit-server/src/test/java/dev/conduit/server/telemetry/BucketPolicyTest.java) | 单元 |
| 三种 SQL 的文本与参数、非法标识符被拒 | [`HistoryQueryBuilderTest`](https://github.com/Clarence404/conduit-iot/blob/811e441/conduit-server/src/test/java/dev/conduit/server/telemetry/HistoryQueryBuilderTest.java) | 单元 |
| 参数校验：测点个数、时间范围、保留列名 | [`HistoryRequestTest`](https://github.com/Clarence404/conduit-iot/blob/811e441/conduit-server/src/test/java/dev/conduit/server/telemetry/HistoryRequestTest.java) | 单元 |
| 点数都不超过上限走原始，任一超过走聚合；不存在的列不计数也不查询 | [`HistoryServiceTest`](https://github.com/Clarence404/conduit-iot/blob/811e441/conduit-server/src/test/java/dev/conduit/server/telemetry/HistoryServiceTest.java) | 单元 |
| 扫描上限 → 400 加稳定的错误码；不可达与 5xx → 503；其他 → 500 且不带 SQL | 同上，`#fileScanLimitIs400WithStableCode`、`#unreachableInfluxIs503`、`#otherInfluxErrorsAre500WithoutSql` | 单元 |
| 真实 InfluxDB 上：原始模式的值、聚合的均值与范围、状态取桶内最后值、无物模型按列类型、其他租户 404 | [`HistoryApiIT`](https://github.com/Clarence404/conduit-iot/blob/811e441/conduit-server/src/test/java/dev/conduit/server/telemetry/HistoryApiIT.java) | 集成 |
| 聚合空桶为 null、0 与 false 保留；演示环境 24 小时查询 289 个桶中 285 个非空、4 个 null、相邻桶间距等于桶宽 | [缺测与零值修复报告](https://github.com/Clarence404/conduit-iot/blob/811e441/docs/test-reports/2026-10-26-history-null-zero.md) | 集成与环境验收 |
| 扫描上限的根因、参数实测、错误分类与前端失败状态 | [历史查询文件扫描上限报告](https://github.com/Clarence404/conduit-iot/blob/811e441/docs/test-reports/2026-10-27-history-scan-limit.md) | 环境实测 |
| 在线设备最后上报距查询约 0.8～1.6 秒 | [遥测新鲜度故障与恢复记录](https://github.com/Clarence404/conduit-iot/blob/811e441/docs/test-reports/2026-10-26-telemetry-freshness.md) | 环境实测 |
| 8 个测点、30 天范围（库中实际约 0.3 天数据）三次耗时 0.119 / 0.097 / 0.066 秒 | [V0.2-B 设计](https://github.com/Clarence404/conduit-iot/blob/811e441/docs/superpowers/specs/2026-10-15-conduit-v0.2b-history-design.md) 第 10 节验收记录 | 环境实测 |

---

## 十一、已知限制

- **真实 30 天数据的查询开销没有测过**：两次实测时库里分别只有约 0.3 天和 12 天的数据，30 天的内存与耗时是外推
- **长跨度靠放大文件上限顶着**：更稳妥的做法是分段查询，排在后面的版本里；上限不宜再往上加，打开数千个文件会明显抬高内存与延迟
- **没有降采样与分层保留**：所有数据统一保留 30 天，聚合在查询时现算
- **原始模式不识别缺测**：没有采样周期的定义，两个样本之间隔得再远也只是两个点
- **InfluxDB 的写入不是严格落盘**：断电会丢内核回写窗口内的数据，只能靠遥测重放从 Redis 上行流补，超出流保留范围的补不回
- **保留期建库后改不了**：`conduit.influx.retention` 只在首次建库时生效
- **同名测点全表同类型**：跨产品也一样，定义物模型时要自己对齐
- **只支持单设备查询**：一次最多 8 个测点，没有多设备对比、导出和文本测点的历史
- **最新值没有过期时间**：设备长期不上报时旧值一直在，是否陈旧靠时间戳判断

---

## 小结

- 历史进 InfluxDB 3、最新值进 Redis，流水线对两者都写成功后才确认消息
- 所有产品共用一张宽表 `property`：tag 是 `tenant_id`、`product_key`、`device_key`，每个测点一列，时间戳取设备的 `ts`；代价是同名测点在全表必须同一类型
- 写入整批提交、按 8 MiB 切块，被拒的行映射回原消息；同设备同时间戳覆盖，重发与重放因此幂等；2xx 不等于落盘，断电后靠遥测重放补
- 最新值是每设备一个 hash，Lua 脚本逐测点比较时间戳，补传和乱序的旧数据不会盖掉新值；它保留最后一次有效上报，不代表当前有上报
- 历史查询先数点数：都不超过 1000 点返回原始点，否则从 12 个固定档位里取使桶数不超过 1000 的最小桶；数值取均值与范围，状态取桶内最后值
- null 是没上报、0 是上报了零：聚合空桶补成 null，曲线在缺口处断开，不补零、不前值填充、不插值；原始模式不猜缺测
- Core 版每天固定 144 个文件且不合并，默认文件上限 432 只够查 3 天；文件粒度调不大，只能把上限放到 5000，超限返回 400 与 `HISTORY_SCAN_LIMIT`
- 页面延迟是上报周期、约 1 秒的流水线和界面刷新相加；实测最后上报距查询约 0.8～1.6 秒
- 相比 Kafka + Flink + TDengine 的路线，这套组件少、建模省事，边界是没有降采样、长跨度与跨设备聚合吃力

## 参考资料

- Conduit IoT · V0.2-B 历史查询与曲线设计：[https://github.com/Clarence404/conduit-iot/blob/811e441/docs/superpowers/specs/2026-10-15-conduit-v0.2b-history-design.md](https://github.com/Clarence404/conduit-iot/blob/811e441/docs/superpowers/specs/2026-10-15-conduit-v0.2b-history-design.md)
- Conduit IoT · 遥测值全局语义（缺测与零值）：[https://github.com/Clarence404/conduit-iot/blob/811e441/docs/telemetry-value-semantics.md](https://github.com/Clarence404/conduit-iot/blob/811e441/docs/telemetry-value-semantics.md)
- Conduit IoT · 历史查询文件扫描上限报告：[https://github.com/Clarence404/conduit-iot/blob/811e441/docs/test-reports/2026-10-27-history-scan-limit.md](https://github.com/Clarence404/conduit-iot/blob/811e441/docs/test-reports/2026-10-27-history-scan-limit.md)
- Conduit IoT · 持久性验证（InfluxDB 写入落盘边界与遥测重放）：[https://github.com/Clarence404/conduit-iot/blob/811e441/docs/durability-validation.md](https://github.com/Clarence404/conduit-iot/blob/811e441/docs/durability-validation.md)
- Conduit IoT · 遥测重放设计：[https://github.com/Clarence404/conduit-iot/blob/811e441/docs/superpowers/specs/2026-10-20-conduit-telemetry-replay-design.md](https://github.com/Clarence404/conduit-iot/blob/811e441/docs/superpowers/specs/2026-10-20-conduit-telemetry-replay-design.md)
- InfluxDB 3 Core 文档：[https://docs.influxdata.com/influxdb3/core/](https://docs.influxdata.com/influxdb3/core/)
- InfluxDB 行协议参考：[https://docs.influxdata.com/influxdb3/core/reference/line-protocol/](https://docs.influxdata.com/influxdb3/core/reference/line-protocol/)
- Apache DataFusion · Scalar Functions（含 date_bin）：[https://datafusion.apache.org/user-guide/sql/scalar_functions.html](https://datafusion.apache.org/user-guide/sql/scalar_functions.html)

> 下一篇：[多租户与授权](./18_conduit_tenant)
