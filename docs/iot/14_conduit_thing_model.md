---
description: 物模型属性与五种类型、可插拔解码器、逐测点校验与部分剔除、按产品缓存与失效、导入导出、缺测与零值约定
---

# 物模型与解码

> 前置阅读：[平台实战概览](./12_conduit_intro)、[设备接入与鉴权](./13_conduit_access)、[平台选型](./2_platform)

物模型是平台对「这类设备会报哪些测点、各是什么类型」的定义，有了它，平台才分得清一个值是合法数据还是设备报错了。本篇讲 Conduit 的物模型结构、解码器、逐测点校验、缓存、导入导出和缺测与零值的约定，基线为 JDK 21、Spring Boot 3.5。

---

## 一、要解决的问题

V0.1 的流水线对上报内容几乎不设防：`params` 里有什么就存什么，数值一律按浮点数写入。跑通主链路够用，但留下四个问题：

| 问题 | 表现 |
|------|------|
| 测点没有含义 | 页面只能显示 `Ua = 220.1`，不知道它叫「A 相电压」，单位是 V，该保留几位小数 |
| 错值照收不误 | 电压报成 `-99999` 或字符串 `"abc"`，照样入库，曲线上一根尖刺 |
| 类型只有一种 | 开关状态、运行模式这类整数和枚举，被存成 `1.0`、`2.0` |
| 格式只有一种 | 设备固件已经定型，报的是 `{"ts":…,"Ua":220.1}`，为了接入要改固件 |

V0.2-A 用两样东西回答：**物模型**管「值对不对」，**解码器**管「格式怎么读」。[设计文档](https://github.com/Clarence404/conduit-iot/blob/811e441/docs/superpowers/specs/2026-10-15-conduit-v0.2a-thing-model-design.md) 开头划的范围很克制：只做属性，事件留给告警那一版，服务留给下行命令那一版；不做属性读写权限、结构体与数组、测点分组、物模型版本与发布流程、脚本解码器。

![一条属性上报的解码与逐测点校验：按产品取解码器与属性定义，合格测点入库，被剔除测点写死信记录](../assets/iot/conduit-field-validation.svg)

---

## 二、物模型的数据结构

### 1、一个属性九个字段

物模型挂在产品上，一个产品一组属性，存在表 `product_property` 里（[`V2__thing_model.sql`](https://github.com/Clarence404/conduit-iot/blob/811e441/conduit-server/src/main/resources/db/migration/V2__thing_model.sql)）。导出成 JSON 是这个样子：

```json
{
  "properties": [
    {"identifier": "Ua", "name": "A 相电压", "dataType": "DOUBLE", "unit": "V",
     "minValue": null, "maxValue": null, "decimals": 1, "enumItems": null, "description": null},
    {"identifier": "st", "name": "运行状态", "dataType": "ENUM", "unit": null,
     "minValue": null, "maxValue": null, "decimals": null,
     "enumItems": [{"value": 0, "label": "停机"}, {"value": 1, "label": "运行"}, {"value": 2, "label": "检修"}],
     "description": null}
  ]
}
```

完整示例见 [`demo-meter.thing-model.json`](https://github.com/Clarence404/conduit-iot/blob/811e441/docs/examples/demo-meter.thing-model.json)。

| 字段 | 规则 | 用在哪 |
|------|------|-------|
| `identifier` | 字母开头，只含字母、数字、下划线，最长 64；同一产品内唯一 | 上报报文里的键、时序库的列名 |
| `name` | 非空，最长 64 | 页面显示 |
| `dataType` | `DOUBLE` / `INT` / `BOOL` / `TEXT` / `ENUM`，**创建后不可修改** | 校验与存储类型 |
| `unit` | 可空，最长 16 | 页面显示 |
| `minValue` / `maxValue` | 可空，只有 `DOUBLE`、`INT` 能设；闭区间 | 校验 |
| `decimals` | 可空，0～6 | 只影响显示，不影响存储 |
| `enumItems` | `ENUM` 必填，其他类型必须为空；值为整数且不重复，最多 64 项 | 校验与显示标签 |
| `description` | 可空，最长 256 | 备注 |

每个产品最多 200 个属性。

### 2、五种类型怎么存

| 物模型类型 | 接受的值 | Java 值类型 | InfluxDB 3 字段类型 |
|-----------|---------|------------|-------------------|
| `DOUBLE` | 有限数值 | `Double` | float |
| `INT` | 整数，在 long 范围内；`220.0` 也算 | `Long` | integer |
| `BOOL` | `true` / `false` | `Boolean` | boolean |
| `TEXT` | 字符串，最长 1024 | `String` | string |
| `ENUM` | 已定义的整数枚举值 | `Long` | integer（存枚举值，不存标签） |

枚举存的是整数值，标签只在物模型里。改标签不用动历史数据，查询时按当前物模型翻译。

### 3、为什么数据类型不能改

`dataType` 定下来就不能改，想换类型只能删掉属性、换一个标识重建。原因在时序库：InfluxDB 的一列一旦以某种类型写入过，再写别的类型会被拒绝。如果允许把 `Ua` 从 `DOUBLE` 改成 `INT`，改完之后这个测点的新数据全部写不进去。

这条限制还有两个推论，接入指南里专门提醒了：

- **已经有历史数据的测点，定义物模型时保持「浮点数」**。V0.1 把所有数值写成了 float，给这样的测点定义 `INT` 或 `ENUM`，新数据会因类型冲突进死信 `FIELD_TYPE_CONFLICT`
- **同名测点在不同产品里也要用相同类型**。所有产品共用同一张时序表 `property`，列是按测点标识建的，A 产品的 `status` 是整数、B 产品的 `status` 是字符串就会冲突

另外有四个标识是保留字：`time`、`tenant_id`、`product_key`、`device_key`，它们和时序表的时间列、tag 列同名，写入必然被拒，所以在定义时就拦下。

### 4、同一条规则，查两遍

属性的合法性在两层检查：

| 层 | 在哪 | 查什么 |
|----|------|-------|
| 应用 | [`PropertyRules#check`](https://github.com/Clarence404/conduit-iot/blob/811e441/conduit-server/src/main/java/dev/conduit/server/thingmodel/PropertyRules.java) | 全部规则，一次返回所有错误，错误信息是中文，直接给界面用 |
| 数据库 | `product_property` 上的 CHECK 约束 | 标识正则、类型取值、小数位 0～6、`min ≤ max`、只有数值类型能有范围、只有枚举有枚举项 |

应用层负责给人看得懂的提示，数据库约束负责兜底：将来多出一条不经过 `PropertyRules` 的写入路径时，坏数据也进不了表。新增、修改、导入三个入口共用同一个 `check`，规则只写一处。

---

## 三、解码器：只翻译格式

### 1、接口

```java
public interface PayloadDecoder {
    /** 解码器标识，即产品 codec 字段存储的值；全局唯一，重名使启动失败。 */
    String name();
    /** 下拉框显示名。 */
    String displayName();
    /** 把原始报文解码为时间戳与测点值。应无状态、线程安全，由流水线线程直接调用。 */
    DecodedPayload decode(DecodeContext ctx, byte[] payload);
}

public record DecodeContext(String productKey, String deviceKey, long receivedAt) {}
public record DecodedPayload(long ts, Map<String, Object> values) {}
```

接口见 [`PayloadDecoder`](https://github.com/Clarence404/conduit-iot/blob/811e441/conduit-server/src/main/java/dev/conduit/server/pipeline/codec/PayloadDecoder.java)。解码器的职责被压得很窄：**只做格式翻译，不按物模型转换类型**。它返回报文里的原始类型——整数是 `Long`（超出 long 范围是 `BigInteger`）、小数是 `Double`、文本是 `String`、布尔是 `Boolean`——值合不合法、该转成什么类型，留给下一步的校验。

这样分工的好处是解码器不需要知道物模型，写一个新解码器只要会读那种格式；校验规则也只有一份，不会出现「标准 JSON 的 INT 接受 `220.0`，扁平 JSON 的不接受」这种分叉。

### 2、两个内置解码器

| `name` | 显示名 | 格式 |
|--------|-------|------|
| `standard-json` | 标准 JSON | `{"id":"…","ts":1760400000000,"params":{"Ua":220.1}}`，测点放在 `params` 里 |
| `flat-json` | 扁平 JSON | `{"ts":1760400000000,"Ua":220.1,"Ia":5.2}`，除 `ts`、`id` 外的顶层键都是测点，至少一个 |

产品表上有一列 `codec`，默认 `standard-json`，在「产品详情 → 基本信息」里选。扁平 JSON 的核心就这几行：

```java
public DecodedPayload decode(DecodeContext ctx, byte[] payload) {
    JsonNode root = JsonPayloads.readObject(reader, payload);
    long ts = timestamps.resolve(root.get("ts"), ctx.receivedAt());
    Map<String, Object> values = new LinkedHashMap<>();
    for (Map.Entry<String, JsonNode> field : root.properties()) {
        String name = field.getKey();
        if ("ts".equals(name) || "id".equals(name)) {
            continue;
        }
        JsonPayloads.checkName(name);
        values.put(name, JsonPayloads.rawValue(name, field.getValue()));
    }
    if (values.isEmpty()) {
        throw new DecodeException(DeadReason.INVALID_PARAMS, "payload has no fields besides ts and id");
    }
    return new DecodedPayload(ts, values);
}
```

代码见 [`FlatJsonDecoder`](https://github.com/Clarence404/conduit-iot/blob/811e441/conduit-server/src/main/java/dev/conduit/server/pipeline/codec/FlatJsonDecoder.java)、[`StandardJsonDecoder`](https://github.com/Clarence404/conduit-iot/blob/811e441/conduit-server/src/main/java/dev/conduit/server/pipeline/codec/StandardJsonDecoder.java)。解码器不读 `id`：可靠上报的回执在 transport 那一跳就发了，见 [可靠上报与接入层主备](./15_conduit_reliable_uplink)。

### 3、两个解码器共用的规则

JSON 解析和时间戳是所有 JSON 类解码器都要做的事，抽在 [`JsonPayloads`](https://github.com/Clarence404/conduit-iot/blob/811e441/conduit-server/src/main/java/dev/conduit/server/pipeline/codec/JsonPayloads.java) 与 [`TimestampPolicy`](https://github.com/Clarence404/conduit-iot/blob/811e441/conduit-server/src/main/java/dev/conduit/server/pipeline/codec/TimestampPolicy.java) 里：

| 规则 | 不满足时 |
|------|---------|
| 根节点必须是 JSON 对象 | `MALFORMED_JSON` |
| 拒绝重复键与尾随字符 | `MALFORMED_JSON` |
| 测点名不能为空，不能以 `__` 开头（平台保留） | `INVALID_PARAMS` |
| 值只能是数字、字符串、布尔；null、数组、嵌套对象都不行 | `INVALID_PARAMS` |
| `ts` 是毫秒整数，在「当前时间 − 30 天」到「当前时间 + 5 分钟」之间；缺省取 transport 的接收时间 | `TS_OUT_OF_RANGE` |

有三处是故意严格的：

- **重复键**：`{"Ua":220.1,"Ua":0}` 在多数 JSON 库里是后者覆盖前者，不报错。设备固件拼接报文出 bug 时正是这种形状，宁可拒收也不猜它想报哪个
- **时间窗口**：最常见的错误是报了秒级时间戳，换算成毫秒落在 1970 年，远早于 30 天前，直接拒掉，不会在曲线上画出一个五十多年前的点。往后 5 分钟的余量留给设备时钟偏差
- **错误信息不带原始报文**：Jackson 异常的 `getMessage()` 会附一段出错位置的原文。死信记录和日志里不该出现设备报文的片段，所以取的是 `getOriginalMessage()`

以上任何一条失败都是 `DecodeException`，属于「消息本身有问题」，整条进死信，不重试。

---

## 四、怎么加一种解码器

设计文档给的步骤只有一步：写一个 `@Component` 实现 `PayloadDecoder`，重新部署。不改流水线，不改数据库。实现时守住四条：

- `name()` 是存进 `product.codec` 的值，全局唯一；`displayName()` 是产品页下拉框里的名字
- 解析失败抛 `DecodeException`（`MALFORMED_JSON` 或 `INVALID_PARAMS`），不要抛别的异常
- 时间戳交给 `TimestampPolicy#resolve`，报文没带时取 `ctx.receivedAt()`
- 值保留原始类型（整数 `Long`、小数 `Double`、文本 `String`、布尔 `Boolean`），实现无状态、线程安全

它能自动生效，靠的是三处配合：

| 环节 | 做了什么 |
|------|---------|
| 注册 | [`DecoderRegistry`](https://github.com/Clarence404/conduit-iot/blob/811e441/conduit-server/src/main/java/dev/conduit/server/pipeline/codec/DecoderRegistry.java) 在构造器里收集全部 `PayloadDecoder` Bean，按 `name` 索引；**两个解码器重名时直接抛异常，应用起不来** |
| 界面 | `GET /api/v1/codecs` 列出注册表里的全部解码器，产品页的下拉框从这里取 |
| 保存 | 新建或修改产品时校验 `codec` 已注册，不存在返回 400 |

重名时让启动失败，而不是后注册的覆盖先注册的，是因为这种错误在运行时没法发现：产品明明选了 A 格式，实际执行的是 B 的代码，报文全部进死信，而配置看上去一切正常。

还有一种情况要兜住：产品选了某个解码器，之后部署回退到没有它的版本。这时流水线按产品的 `codec` 找不到解码器，整条消息进死信 `UNKNOWN_CODEC`。不让它悄悄退回默认解码器，是因为用错格式解析出来的可能是一堆看似合法的错值。

`DecodeContext` 里的 `productKey` 和 `deviceKey` 两个内置解码器都没用到，是给将来的脚本解码器留的：凭 `productKey` 找到产品自己的解析脚本。脚本解码器本身没有实现。

---

## 五、逐测点校验

### 1、处理顺序

一条属性消息在 [`TelemetryIngestor#prepare`](https://github.com/Clarence404/conduit-iot/blob/811e441/conduit-server/src/main/java/dev/conduit/server/pipeline/TelemetryIngestor.java) 里依次经过：

| 步 | 检查 | 不通过 |
|----|------|-------|
| 1 | 设备存在 | `UNKNOWN_DEVICE` |
| 2 | 所属租户启用、设备启用 | `TENANT_DISABLED` / `DEVICE_DISABLED` |
| 3 | topic 里的 `productKey` 与设备所属产品一致 | `PRODUCT_MISMATCH` |
| 4 | 从缓存取产品配置（解码器名 + 属性定义） | 产品不存在按 `UNKNOWN_DEVICE` |
| 5 | 按名字找解码器 | `UNKNOWN_CODEC` |
| 6 | 解码 | `MALFORMED_JSON` / `INVALID_PARAMS` / `TS_OUT_OF_RANGE` |
| 7 | 逐测点校验 | 全部被剔除时 `FIELD_REJECTED` |

前六步任何一步失败，整条消息进死信。第七步不一样：它按测点判，一条消息里好的留下、坏的剔除。

### 2、规则

产品**没有**物模型时沿用 V0.1 的行为：数值一律转 `Double`，文本和布尔原样，出现非有限数值则整条 `INVALID_PARAMS`。升级到 V0.2-A 后，没定义物模型的老产品不会突然开始拒收数据。

有物模型时，每个测点独立判断：

| 情况 | 结果 |
|------|------|
| 物模型里没有这个测点 | 剔除 `UNDEFINED` |
| `DOUBLE`：有限数值 | 接受，转 `Double`；否则剔除 `TYPE_MISMATCH` |
| `INT`：整数且在 long 范围内 | 接受，转 `Long`；小数、超范围、非数值剔除 `TYPE_MISMATCH` |
| `BOOL`：布尔 | 接受；否则剔除 `TYPE_MISMATCH` |
| `TEXT`：字符串 | 长度不超过 1024 接受，超长剔除 `TOO_LONG`；非字符串剔除 `TYPE_MISMATCH` |
| `ENUM`：整数 | 是已定义的枚举值则接受，不是则剔除 `ENUM_VALUE`；非整数剔除 `TYPE_MISMATCH` |
| `DOUBLE` / `INT` 超出 `minValue`～`maxValue` | 剔除 `OUT_OF_RANGE`（边界值算在范围内，没设的一侧不限） |

```java
case INT -> {
    Long l = integer(value);
    if (l == null) {
        yield Outcome.reject(RejectReason.TYPE_MISMATCH);
    }
    yield inRange(spec, l.doubleValue()) ? Outcome.accept(l) : Outcome.reject(RejectReason.OUT_OF_RANGE);
}
...
/** 整数判断：Long、long 范围内的 BigInteger、值为整数且在 long 范围内的 Double（如 220.0）。 */
static Long integer(Object value) {
    return switch (value) {
        case Long l -> l;
        case BigInteger b -> b.bitLength() < 64 ? b.longValue() : null;
        case Double d -> Double.isFinite(d) && d == Math.rint(d) && d >= LONG_MIN && d < LONG_MAX_EXCLUSIVE
                ? d.longValue() : null;
        case null, default -> null;
    };
}
```

代码见 [`FieldValidator`](https://github.com/Clarence404/conduit-iot/blob/811e441/conduit-server/src/main/java/dev/conduit/server/pipeline/FieldValidator.java)，一个没有依赖的纯函数。`INT` 接受 `220.0` 是向设备的现实妥协：很多固件的 JSON 库把所有数字都按浮点输出，整数值会带上 `.0`。只要数学上是整数就收，`220.5` 才算类型不符。

类型判断是严格的，不做隐式转换：字符串 `"220"` 报给 `DOUBLE` 测点是 `TYPE_MISMATCH`，数字 `1` 报给 `BOOL` 测点也是。平台不替设备猜它的意思。

---

## 六、部分测点不合格怎么处理

### 1、三种做法

一条消息报了 7 个测点，其中 1 个超出范围，剩下 6 个怎么办？

| 做法 | 问题 |
|------|------|
| 整条拒收 | 一个传感器坏了，整台设备的数据全没了，而另外 6 个值是好的 |
| 整条照收 | 等于没校验 |
| **逐测点剔除** | Conduit 的选择：6 个合格的照常入库，1 个不合格的单独留痕 |

工业现场一台设备挂几十个测点，个别探头失灵是常态，不应该连累其他测点。

### 2、留痕：死信流里的一条记录

| 情况 | 数据 | 原消息 | 死信流 |
|------|------|-------|-------|
| 全部合格 | 入库 | 确认 | 无 |
| 部分被剔除 | 合格的入库 | 确认 | 写一条 `FIELD_REJECTED` 记录，带 `rejected` 详情 |
| 全部被剔除 | 不入库 | 确认 | 整条消息进死信，原因 `FIELD_REJECTED` |

`rejected` 是一个 JSON 数组，列出每个被剔除的测点、原值和原因：

```json
[{"field":"Ua","value":"abc","reason":"TYPE_MISMATCH"},
 {"field":"temp2","value":"35.2","reason":"UNDEFINED"}]
```

原值转成字符串后最多保留 64 个字符，按 Unicode 码点截断（不会把一个表情符号切成两半），避免设备报来一段超长文本把死信记录撑大。

部分剔除时，死信流里的这条记录不是「处理失败的消息」，而是「处理成功的消息的附注」。为此 `MessageBus` 上有两个方法：`deadLetter` 写死信并确认原消息，`recordDead` 只写死信不确认。流水线在这里用的是后者，顺序是先留痕再确认：

```java
if (!item.prepared().rejected().isEmpty()) {
    Map<String, String> details = RejectedFields.details(item.prepared().rejected());
    // 先留痕再 ACK：两步之间崩溃只会产生重复死信记录，不会丢失
    backoff.run("dead record", () -> {
        bus.recordDead(item.delivery(), DeadReason.FIELD_REJECTED.name(), details);
        return null;
    });
}
acks.add(item.delivery().id());
```

代码见 [`PipelineProcessor#writeProperties`](https://github.com/Clarence404/conduit-iot/blob/811e441/conduit-server/src/main/java/dev/conduit/server/pipeline/PipelineProcessor.java)。两步不是原子的，中间崩溃的话消息会被重新投递、再处理一遍：数据重复写入由时序库的覆盖语义吸收，死信记录会多一条。反过来的顺序（先确认再留痕）崩溃时会丢掉这条记录，所以选了「可能重复、不会丢」的那一边。

### 3、指标

每个被剔除的测点计入 `conduit.pipeline.rejected_fields{reason, source}`。`source` 区分实时消费（`live`）与遥测重放（`replay`）：重放的是旧数据，如果物模型后来改过，重放时会有一批测点被新规则剔除，不能让它们污染实时的拒绝率。重放也不写死信记录，只计这个指标。

---

## 七、按产品缓存与失效

流水线每处理一条消息都要用到产品的解码器名和属性定义，每次查 PostgreSQL 不现实。[`ThingModelCache`](https://github.com/Clarence404/conduit-iot/blob/811e441/conduit-server/src/main/java/dev/conduit/server/thingmodel/ThingModelCache.java) 用 Caffeine 在进程内缓存：

| 项 | 取值 |
|----|------|
| 键 | `productKey` |
| 值 | `ProductProfile(codec, properties)`，属性是按标识索引的不可变快照 |
| 过期 | 写入后 60 秒 |
| 容量 | 最多 10,000 项 |
| 产品不存在 | 不缓存 |
| 读库失败 | 异常原样抛出，流水线按「下游不可用」原地退避重试 |

```java
public Optional<ProductProfile> find(String productKey) {
    return Optional.ofNullable(cache.get(productKey, this::load));
}

/** 使该产品的缓存失效。调用方应在修改已提交之后再调用，否则可能被并发读重新缓存旧数据。 */
public void evict(String productKey) {
    cache.invalidate(productKey);
}
```

有几个点值得注意：

- **缓存的是整个产品，不是单个属性**。一个产品最多 200 个属性，一次读出来按标识建好索引，校验时每个测点一次 Map 查找
- **解码器名和属性放在一起**。它们总是一起用，一起失效；改产品的 `codec` 也要清这份缓存
- **清除在事务提交之后**。[`ThingModelService`](https://github.com/Clarence404/conduit-iot/blob/811e441/conduit-server/src/main/java/dev/conduit/server/thingmodel/ThingModelService.java) 的写操作都是先让事务提交，再调 `evict`。顺序反了的话，清完缓存、事务还没提交的那一瞬间，流水线读到旧数据又把它缓存 60 秒
- **加载是跨租户的**。流水线没有登录用户，没有租户上下文，所以先用受控的系统通道按 `productKey` 找到产品，再切到产品所属的租户读属性。这条通道的约束见 [多租户与授权](./18_conduit_tenant)

会触发清除的操作：新增、修改、删除属性，导入物模型，修改产品（含 `codec`），删除产品。

选进程内缓存而不是 Redis，是因为这是流水线上最热的一次读取，本地读取没有网络往返；代价是多实例部署时，清除只在处理那次修改的实例上生效，其他实例最多 60 秒后才看到新规则。Caffeine 的用法见 [Caffeine](/cache/7_caffeine)，本地缓存与分布式缓存怎么配合见 [两级缓存](/cache/8_two_level_cache)。

---

## 八、增删改与导入导出

### 1、接口

| 接口 | 说明 |
|------|------|
| `GET /api/v1/codecs` | 可选的解码器 |
| `GET /api/v1/products/{productKey}/properties` | 属性列表，按创建顺序 |
| `POST /api/v1/products/{productKey}/properties` | 新增；标识重复或超过 200 个返回 409 |
| `PUT /api/v1/products/{productKey}/properties/{identifier}` | 修改；数据类型与现值不同返回 409 |
| `DELETE /api/v1/products/{productKey}/properties/{identifier}` | 删除 |
| `GET /api/v1/products/{productKey}/thing-model` | 导出 |
| `PUT /api/v1/products/{productKey}/thing-model?mode=merge\|replace` | 导入 |

删除属性不删历史数据，之后设备再报这个测点会按 `UNDEFINED` 剔除。物模型没有版本管理，改了立即生效。

### 2、200 个上限怎么守住

「每个产品最多 200 个属性」如果只在代码里先数一下再插入，两个请求同时数到 199 就会都插进去。新增和导入都在事务里先锁住产品行，再检查、再写：

```java
ProductProperty created = tx.execute(status -> {
    productMapper.lockById(product.getId());          // 同一产品的并发新增 / 导入在这里排队
    if (findRow(product.getId(), request.identifier()) != null) {
        throw ApiException.conflict("属性标识已存在: " + request.identifier());
    }
    if (properties.countByProduct(product.getId()) >= PropertyRules.MAX_PROPERTIES) {
        throw ApiException.conflict("每个产品最多 " + PropertyRules.MAX_PROPERTIES + " 个属性");
    }
    ...
});
cache.evict(productKey);
```

标识唯一有数据库的唯一约束兜底，数量上限没有现成的约束可用，靠的是这把行锁。

### 3、导入：两种模式，要么全成要么全不成

| 模式 | 文件里有的 | 文件里没有的已有属性 |
|------|-----------|-------------------|
| `merge` | 新增或更新 | 保留 |
| `replace` | 新增或更新 | 删除 |

导入先校验整个文件，再动数据（[`ThingModelImport#validate`](https://github.com/Clarence404/conduit-iot/blob/811e441/conduit-server/src/main/java/dev/conduit/server/thingmodel/ThingModelImport.java)）：

- 每个属性过一遍 `PropertyRules.check`
- 文件内标识不能重复
- 和已有属性的数据类型不能冲突（类型不可改，导入也绕不过去）
- 导入后的总数不超过 200：`replace` 只数文件里的，`merge` 数已有与文件的并集

任何一项有错，整个导入不生效，返回 400，响应里的 `errors` 列出**全部**错误，每条带上是哪个标识。一次只报第一个错的话，一份 100 个属性的文件可能要来回改十几次。校验和写入在同一个事务、同一把产品行锁里，不会出现导入到一半的状态。

导出的每个属性是上面那 9 个可编辑字段，不含 id 和时间戳，可以直接再导入，也可以导入到另一个产品：这就是把一个型号的物模型复制给另一个型号的办法。模拟器开通演示产品时用的也是这条路：发现产品属性数为 0，就把打包在 jar 里的示例物模型导入。

---

## 九、缺测与零值

### 1、约定

设备没报某个测点，和设备报了 0，是两件不同的事。夜里光伏逆变器的功率是 0，这是真实数据；通信中断那一小时没有功率值，这是不知道。把后者画成 0，运维会以为逆变器停机了；把前者当成没数据，日发电量的平均值就算错了。

Conduit 把它写成了一份全链路的 [约定](https://github.com/Clarence404/conduit-iot/blob/811e441/docs/telemetry-value-semantics.md)：

| 情况 | 语义 | 展示 |
|------|------|------|
| 该测点在该时刻没有上报 | 缺测，不代表设备从未上报 | 无数据，曲线留空 |
| 数值 `0` | 已上报且有效的零值 | 正常显示 0，参与计算和曲线 |
| 布尔 `false`、枚举值 `0` | 有效状态值 | 显示相应状态，不能当缺测 |
| 校验失败、NaN、Infinity | 无效数据 | 拒绝并留痕，不能改写成 0 |
| 查询失败、存储不可用 | 没取到结果 | 明确的错误状态，不能伪装成无数据或全零 |

约定里点名禁止的写法是最容易顺手写出来的那几种：`value || 0`、`value ?? 0`、`Number(null)`、SQL 里的 `COALESCE(value, 0)`，以及用真值判断来检查缺测（会把 `0` 和 `false` 一起丢掉）。

### 2、在解码与校验这一段怎么体现

| 环节 | 行为 |
|------|------|
| 设备要表达「这个测点这次没有值」 | **不报这个键**。报文里省略的测点不产生任何样本 |
| 报文里写了显式的 `null` | 解码器不接受 null，整条消息 `INVALID_PARAMS`。要省略就真的省略 |
| 超出 double 范围的字面量（解析成 Infinity） | 有物模型时该测点 `TYPE_MISMATCH` 被剔除；没有物模型时整条 `INVALID_PARAMS`。两种情况都不会变成 0 |
| 被物模型剔除的测点 | 不写入，这一时刻该测点就是缺测；不会用 0、上一个值或默认值顶替 |
| 值为 `0`、`false`、枚举 `0` | 和其他合法值走完全相同的路径，范围校验时 0 正常参与比较 |

逐测点剔除和这份约定是配套的：正因为「没有值」有明确的含义，剔除一个坏测点才是安全的，它留下的是一个诚实的空缺。

这份约定里没有质量位，采集端读不到值时只能省略该键。另一种做法是随测点带一个质量标记（如 `quality=BAD`），下游能进一步分清「读了但失败」和「根本没上报」，见 [Modbus 采集 · 批量读取与调度](./7_modbus#_3、批量读取与调度)；Conduit 目前没有做。

### 3、往后几跳

这份约定覆盖到存储和展示，细节在 [时序存储与历史查询](./17_conduit_telemetry)，这里只列结论：

- **最新值**保留最后一次有效上报的值和它自己的时间戳；后续报文缺少该测点时，不刷新它的时间戳，也不把它归零
- **聚合查询**只算有效样本，没有样本的时间桶返回 null（包括求和），不返回 0
- **曲线**在已知缺测处断开，不补零、不延续前值、不插值
- **模拟器**夜间上报的光伏功率是明确的 0；模拟断连时停止上报，不发 0 冒充

约定文档里也写了没解决的部分：原始（不聚合）历史只返回实际存在的样本，两个样本之间隔了很久算不算缺测，需要先有采样周期或缺测阈值的定义，目前没有。

---

## 十、验证

| 结论 | 测试 / 报告 | 类型 |
|------|------------|------|
| 两个解码器保留原始类型，不做类型转换 | [`StandardJsonDecoderTest#keepsRawValueTypes`](https://github.com/Clarence404/conduit-iot/blob/811e441/conduit-server/src/test/java/dev/conduit/server/pipeline/codec/StandardJsonDecoderTest.java)、[`FlatJsonDecoderTest#topLevelKeysExceptTsAndIdArePoints`](https://github.com/Clarence404/conduit-iot/blob/811e441/conduit-server/src/test/java/dev/conduit/server/pipeline/codec/FlatJsonDecoderTest.java) | 单元 |
| 拒绝重复键与尾随字符；错误信息不回显报文 | [`StandardJsonDecoderTest#rejectsDuplicateKeysAndTrailingTokens`、`#malformedJsonErrorDoesNotEchoPayload`](https://github.com/Clarence404/conduit-iot/blob/811e441/conduit-server/src/test/java/dev/conduit/server/pipeline/codec/StandardJsonDecoderTest.java) | 单元 |
| 时间戳缺省取接收时间，超出窗口拒绝 | [`TimestampPolicyTest`](https://github.com/Clarence404/conduit-iot/blob/811e441/conduit-server/src/test/java/dev/conduit/server/pipeline/codec/TimestampPolicyTest.java) | 单元 |
| 解码器重名时启动失败 | [`DecoderRegistryTest#duplicateNamesFailStartup`](https://github.com/Clarence404/conduit-iot/blob/811e441/conduit-server/src/test/java/dev/conduit/server/pipeline/codec/DecoderRegistryTest.java) | 单元 |
| 五种类型的接受与各剔除原因，范围含边界，结果保持原顺序 | [`FieldValidatorTest`](https://github.com/Clarence404/conduit-iot/blob/811e441/conduit-server/src/test/java/dev/conduit/server/pipeline/FieldValidatorTest.java) | 单元 |
| 没有物模型时与 V0.1 行为一致 | [`FieldValidatorTest#withoutModelBehavesLikeV01`](https://github.com/Clarence404/conduit-iot/blob/811e441/conduit-server/src/test/java/dev/conduit/server/pipeline/FieldValidatorTest.java) | 单元 |
| 被剔除的原值按码点截断到 64 个字符 | [`RejectedFieldsTest`](https://github.com/Clarence404/conduit-iot/blob/811e441/conduit-server/src/test/java/dev/conduit/server/pipeline/RejectedFieldsTest.java) | 单元 |
| 扁平 JSON 产品按自己的解码器入库 | [`PipelineIT#flatJsonProductIsDecodedWithItsCodec`](https://github.com/Clarence404/conduit-iot/blob/811e441/conduit-server/src/test/java/dev/conduit/server/pipeline/PipelineIT.java) | 集成（真实 Redis、PostgreSQL、InfluxDB） |
| 部分剔除：合格测点入库，另有一条带 `rejected` 的记录 | [`PipelineIT#partiallyRejectedMessageStoresValidFieldsAndRecordsTheRest`](https://github.com/Clarence404/conduit-iot/blob/811e441/conduit-server/src/test/java/dev/conduit/server/pipeline/PipelineIT.java) | 集成 |
| 全部剔除：整条进死信 | [`PipelineIT#fullyRejectedMessageIsDeadLettered`](https://github.com/Clarence404/conduit-iot/blob/811e441/conduit-server/src/test/java/dev/conduit/server/pipeline/PipelineIT.java) | 集成 |
| `INT` 属性在 InfluxDB 里是 integer | [`PipelineIT#intPropertyIsStoredAsInfluxInteger`](https://github.com/Clarence404/conduit-iot/blob/811e441/conduit-server/src/test/java/dev/conduit/server/pipeline/PipelineIT.java) | 集成 |
| 解码器不存在时整条进死信 | [`PipelineIT#unknownCodecDeadLettersWholeMessage`](https://github.com/Clarence404/conduit-iot/blob/811e441/conduit-server/src/test/java/dev/conduit/server/pipeline/PipelineIT.java) | 集成 |
| 通过接口改物模型后，新规则立即生效 | [`PipelineIT#thingModelChangesThroughTheApiTakeEffectImmediately`](https://github.com/Clarence404/conduit-iot/blob/811e441/conduit-server/src/test/java/dev/conduit/server/pipeline/PipelineIT.java) | 集成 |
| 缓存只加载一次、60 秒过期、清除后重新加载、不存在的产品不缓存、读库失败原样抛出 | [`ThingModelCacheTest`](https://github.com/Clarence404/conduit-iot/blob/811e441/conduit-server/src/test/java/dev/conduit/server/thingmodel/ThingModelCacheTest.java) | 单元（可控时钟） |
| 没有租户上下文也能加载任意租户的产品 | [`ThingModelCacheIT#loadsAnyTenantsProductWithoutTenantContext`](https://github.com/Clarence404/conduit-iot/blob/811e441/conduit-server/src/test/java/dev/conduit/server/thingmodel/ThingModelCacheIT.java) | 集成 |
| 导入一次收集全部错误；合并与替换各自的总数算法 | [`ThingModelImportTest`](https://github.com/Clarence404/conduit-iot/blob/811e441/conduit-server/src/test/java/dev/conduit/server/thingmodel/ThingModelImportTest.java) | 单元 |
| 改类型 409、超过 200 个 409、别的租户的产品 404、导出再导入一致、导入失败不改任何数据 | [`ThingModelApiIT`](https://github.com/Clarence404/conduit-iot/blob/811e441/conduit-server/src/test/java/dev/conduit/server/thingmodel/ThingModelApiIT.java) | 集成（HTTP 接口） |
| 聚合空桶返回 null，真实的 0、false、枚举 0 保留 | [历史曲线缺测与零值修复测试报告](https://github.com/Clarence404/conduit-iot/blob/811e441/docs/test-reports/2026-10-26-history-null-zero.md) | 测试报告 |
| 同一条曲线上正常值、缺测、真实零值三段可区分 | [缺测与零值对照演示验收](https://github.com/Clarence404/conduit-iot/blob/811e441/docs/test-reports/2026-10-26-null-zero-demo.md) | 测试报告（演示数据） |

最后一份报告的做法可以借鉴：专门建一个演示设备，写入「20 分钟正常值、15 分钟不写、10 分钟写 0、15 分钟正常值」四段数据，页面上缺测那段曲线断开、零值那段贴着 0 刻度画。语义约定光靠文字说不清，一张对照图比十条规则好懂。

---

## 十一、已知限制

- **只有属性**。事件和服务（下行命令）没有物模型，`up/event` 的消息进死信 `UNSUPPORTED_TYPE`
- **没有结构体和数组**。值只能是标量，嵌套对象直接 `INVALID_PARAMS`；一台设备挂多路同类传感器只能把测点名摊平成 `temp1`、`temp2`
- **没有版本管理**。物模型改了立即对新数据生效，没有草稿、发布和回滚；历史数据是按当时的规则校验的，最新值接口则按当前物模型附上名称、单位与枚举标签
- **所有产品共用一张时序表**。同名测点跨产品必须同类型，否则后写入的一方进 `FIELD_TYPE_CONFLICT`；这个冲突在定义物模型时不检查，要到写入才暴露
- **缓存是进程内的**。多实例部署时修改物模型最多 60 秒后才在其他实例生效，这段时间不同实例用的规则不一样
- **解码器只有两种 JSON**。二进制协议、脚本解码器都没有，加一种格式要写 Java 代码并重新部署
- **被剔除的测点只能用 `redis-cli` 查**。死信流没有界面，首页只有最近 1 小时的死信计数
- **范围校验只有上下限**。没有变化率、死区、跨测点关系这类规则，那属于路线图 V0.5 的规则引擎
- **原始历史的缺测无法识别**。没有采样周期的定义，两个样本间隔多久算缺测没有依据

---

## 小结

- 物模型挂在产品上，一个属性九个字段，五种类型对应 InfluxDB 的四种存储类型；数据类型创建后不可修改，因为时序库的列类型改不了
- 解码器只翻译格式、保留原始类型，校验只有一份；内置标准 JSON 与扁平 JSON，共用严格的 JSON 解析与时间戳窗口
- 新增格式是写一个 `@Component`：注册表自动收集，重名让启动失败，产品保存时校验存在，运行时找不到进 `UNKNOWN_CODEC`
- 校验按测点进行：合格的照常入库，不合格的剔除并在死信流里留一条 `FIELD_REJECTED` 记录，先留痕再确认；全部不合格才整条进死信
- 产品配置用 Caffeine 按 `productKey` 缓存 60 秒，写操作在事务提交之后主动清除；多实例下其他实例最多延迟 60 秒
- 导入分合并与替换，先校验整个文件、一次列出全部错误，任一错误整体不生效；200 个上限靠锁产品行守住
- 缺测与零值全链路区分：设备省略测点表示没有值，显式 null 不接受，被剔除的测点不用 0 顶替，聚合空桶返回 null，曲线在缺测处断开
- 当前只有属性、只有标量、没有版本管理，跨产品同名测点必须同类型

## 参考资料

- Conduit V0.2-A 设计：物模型与编解码：[https://github.com/Clarence404/conduit-iot/blob/811e441/docs/superpowers/specs/2026-10-15-conduit-v0.2a-thing-model-design.md](https://github.com/Clarence404/conduit-iot/blob/811e441/docs/superpowers/specs/2026-10-15-conduit-v0.2a-thing-model-design.md)
- Conduit 遥测值全局语义：缺测与零值：[https://github.com/Clarence404/conduit-iot/blob/811e441/docs/telemetry-value-semantics.md](https://github.com/Clarence404/conduit-iot/blob/811e441/docs/telemetry-value-semantics.md)
- Conduit 设备接入指南：[https://github.com/Clarence404/conduit-iot/blob/811e441/docs/device-integration.md](https://github.com/Clarence404/conduit-iot/blob/811e441/docs/device-integration.md)
- InfluxDB 3 Core 文档：[https://docs.influxdata.com/influxdb3/core/](https://docs.influxdata.com/influxdb3/core/)
- Caffeine Wiki：[https://github.com/ben-manes/caffeine/wiki](https://github.com/ben-manes/caffeine/wiki)

> 下一篇：[可靠上报与接入层主备](./15_conduit_reliable_uplink)
