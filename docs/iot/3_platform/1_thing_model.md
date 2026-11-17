---
description: 属性 / 事件 / 服务三要素、主流平台模型对照、三要素与数据通道、数据类型与版本演进、上报校验、按产品缓存
---

# 物模型

> 前置阅读：[通信协议](../1_basics/1_protocol)、[平台选型](../1_basics/2_platform)

物模型用结构化的方式描述「这类设备有哪些数据和能力」，平台据此校验、存储、展示数据，并生成设备端代码。本篇讲主流平台的模型对照、三要素与数据通道的对应、数据类型与版本演进、上报校验的最小实现，基线为 JDK 21、Spring Boot 4、Caffeine 3。

---

## 一、物模型是什么

### 1、没有模型时的问题

| 没有物模型 | 有物模型之后 |
|-----------|-------------|
| 设备报什么平台存什么，`-99999`、`"abc"` 照样入库 | 按类型与范围校验，不合格的测点被拦下并留痕 |
| 页面只能显示 `temperature = 25.3`，不知道单位和小数位 | 名称、单位、精度来自模型，界面自动生成 |
| 应用给设备发指令靠口头约定方法名和参数 | 服务的入参出参有定义，下发前就能校验 |
| 换一款设备，接入代码重写一遍 | 同一套平台代码按模型处理不同型号 |

### 2、产品、物模型、设备

![物模型三要素与数据通道：产品定义一份物模型，属性、事件、服务分别对应遥测上报、设备影子、事件上报与指令下发的 Topic](../../assets/iot/thing-model-elements.svg)

- **产品**是一个型号（如温湿度传感器 `th-sensor`），**设备**是这个型号的一台实物；设备注册时归到某个产品下，见 [设备注册与生命周期](../2_access/2_provisioning)
- **物模型挂在产品上**：同型号的设备共用一份，平台收到某台设备的数据时，先查它属于哪个产品，再取那个产品的物模型
- 物模型由三类功能组成：**属性**（设备有什么数据和配置）、**事件**（设备主动告诉平台发生了什么）、**服务**（平台能让设备做什么）

---

## 二、主流平台怎么建模

### 1、对照表

| 平台 / 标准 | 模型叫什么 | 组成 | 描述格式 | 发布与版本 |
|------------|-----------|------|---------|-----------|
| 阿里云物联网平台 | 物模型（TSL） | 属性（读写 / 只读）、事件（信息 / 告警 / 故障）、服务（同步 / 异步调用，带入参出参）；可以分成默认模块和自定义模块 | JSON | 产品发布后不能编辑物模型，要先撤销发布；每次编辑生成新版本，保留最近 10 个 |
| 华为云 IoTDA | 产品模型 | 先划分服务（service），每个服务下定义属性（可读 / 可写）和命令（下发参数、响应参数） | 控制台在线开发 | — |
| 腾讯云 IoT Explorer | 物模型（JSON 文件叫数据模板） | 属性、事件（告警 / 故障 / 信息）、行为（调用参数、返回参数） | JSON | — |
| Azure | DTDL，配合 IoT Plug and Play 约定 | Interface 下有 Telemetry、Property（可标记 `writable`）、Command（request / response）、Relationship、Component | JSON-LD | 已发布的模型不可变，版本号写在模型 ID 里（如 `dtmi:com:example:Thermostat;2`） |
| OMA LwM2M | 对象模型 | Object / Object Instance / Resource 三层，资源带读（R）、写（W）、执行（E）操作，路径形如 `/3303/0/5700` | XML 注册表 | 对象带版本号，如 `urn:oma:lwm2m:oma:5:1.2` |
| Sparkplug B | metric 与 Template | 上线的 BIRTH 报文必须列出今后会上报的全部 metric（名称、数据类型、当前值）；Template 是自定义类型（UDT） | Protobuf | 模型由设备自己描述，不在平台预先定义 |
| ThingsBoard | 没有强约束的模型 | 遥测（时序键值）、三种属性（客户端 / 共享 / 服务端）、RPC；Device Profile 管协议、规则链与告警规则，每台设备恰好属于一个 Profile | — | — |
| AWS IoT Core | 没有对等的模型 | Thing Type 只是一组注册表属性的模板（有类型的 Thing 最多 50 个属性，没有的 3 个）；设备状态的结构由 Shadow 文档自由决定 | — | — |

几处容易说错的现状：

- **Azure**：DTDL 目前有 v2、v3、v4 三个受支持的版本，v2 用于 Azure Digital Twins、IoT Central 与 IoT Plug and Play，v3 用于 Azure Digital Twins 与 IoT Plug and Play，v4 用于 Azure IoT Operations；IoT Plug and Play 的文档已移入 Microsoft Learn 的归档区（previous-versions）。IoT Plug and Play 不新增通道，只是约定三类功能怎么落到 IoT Hub 已有的能力上：Telemetry 走设备到云消息，Property 走设备孪生的 reported / desired，Command 走直接方法
- **LwM2M**：对象 ID 分段管理，0–1023 归 OMA（如对象 5 Firmware Update：资源 1 Package URI 可读写、资源 2 Update 可执行、资源 3 State 只读），2048–10240 给其他标准组织（如 3303 Temperature，资源 5700 Sensor Value），10241–32768 给厂商。对象是标准化的，同一个 3303 在任何厂商的设备上含义相同
- **Sparkplug B**：Template 的定义只能出现在 Edge Node 的 NBIRTH 报文里；平台写设备就是往 NCMD / DCMD 报文里放要写入的 metric，没有单独的「服务」概念
- **阿里云**：帮助中心已把物联网平台的文档标注为「文档停止维护」，这里仍拿它做参照，是因为属性、事件、服务这种三分法在国内平台里通用，腾讯云的物模型也是属性、事件、行为三类

### 2、有 schema 与无 schema

| | 有 schema（阿里云、华为云、腾讯云、Azure、LwM2M） | 设备自描述（Sparkplug B） | 无 schema（ThingsBoard、AWS IoT Core） |
|--|--|--|--|
| 接入一款新设备 | 先在平台定义模型 | 设备上线时带着模型 | 直接上报 |
| 平台能做什么 | 校验、按类型存储、自动生成界面与设备端代码 | 知道类型，能发现测点，但含义靠命名 | 照单全收，含义靠仪表盘和规则里的配置 |
| 代价 | 改模型有发布流程，固件要和模型对齐 | 设备每次上线都要完整声明，漏报的 metric 之后不能上报 | 脏数据、同名不同义、类型漂移都留给下游 |
| 适合 | 设备型号可控、要对外提供稳定数据的平台 | 工业现场，设备由网关代为描述 | 原型期，或设备种类杂、只做展示 |

**本模块采用有 schema 的做法，三要素的名字与划分对齐阿里云 TSL**。与 Azure 的差异：DTDL 把时序数据（Telemetry）和状态（Property）分成两类，事件也算 Telemetry；这里统一叫属性，用读写类型和上报通道区分，事件单独一类。

---

## 三、三要素与数据通道

物模型只定义「有什么」，数据走哪个 Topic 是另一件事。本模块的 Topic 约定见 [通信协议 · Topic 约定](../1_basics/1_protocol#_7、topic-约定)，三要素落在其中四条通道上：

| 要素 | 示例 | 方向 | Topic | 载荷 | 主文档 |
|------|------|------|-------|------|-------|
| 属性 · 只读（时序测点） | `temperature`、`humidity` | 设备 → 平台 | `devices/{deviceId}/telemetry` | `{"ts":…,"values":{"temperature":25.3}}` | [遥测数据链路](./2_data) |
| 属性 · 读写（配置） | `reportInterval` | 双向 | `devices/{deviceId}/shadow/update`、`…/shadow/update/delta` | 应用写 `desired`，设备写 `reported` | [设备影子](./3_device_shadow) |
| 事件 | `highTemperature` | 设备 → 平台 | `devices/{deviceId}/event` | `{"ts":…,"event":"highTemperature","params":{…}}` | 本节 |
| 服务 | `reboot` | 平台 → 设备，设备应答 | `devices/{deviceId}/cmd`、`devices/{deviceId}/response` | `{"id":"…","method":"reboot","params":{…}}` | [指令下发与服务调用](./4_command) |

- **只读属性分两种**：要看历史曲线的测点走遥测；只关心当前值的状态（固件版本、信号强度）由设备直接写进影子的 `reported`
- **读写属性不直接下发**：应用改的是影子里的期望值，设备离线也不丢，上线后拿到最终值；「设置属性」因此不占用指令通道
- **事件与平台侧告警是两个来源**：事件由设备自己判断后上报（设备本地就能发现的故障、越限），事件级别（信息 / 告警 / 故障）写在模型里，不放进载荷；平台根据遥测算出来的告警见 [规则引擎与告警](./6_rule_engine)，两者汇入同一个告警服务
- **事件标识放载荷**：阿里云把事件标识写进 Topic（`…/thing/event/${tsl.event.identifier}/post`），这里 Topic 固定、标识放在载荷的 `event` 字段，设备的 ACL 只需要一条规则

各家把同一件事放在哪条通道上：

| 平台 | 时序测点 | 可写配置 | 服务 |
|------|---------|---------|------|
| 阿里云 | 属性上报 `…/thing/event/property/post` | 属性设置 `…/thing/service/property/set` | `…/thing/service/${tsl.service.identifier}` |
| Azure IoT Plug and Play | Telemetry | 可写 Property：孪生 `desired` 下发，设备在 `reported` 里带 `ac`（状态码）、`av`（版本）回执 | Command（直接方法） |
| ThingsBoard | 遥测 `v1/devices/me/telemetry` | 共享属性：平台写，设备只读 | RPC `v1/devices/me/rpc/request/+` |
| 腾讯云 | `$thing/up/property/{ProductID}/{DeviceName}` | `$thing/down/property/…`，`method` 为 `control` | `$thing/down/action/…` |

---

## 四、数据类型、分组与版本

### 1、数据类型

| 类型 | 约束 | 例子 |
|------|------|------|
| `INT` / `FLOAT` | 取值范围 `min`、`max`，步长 `step`，单位 `unit` | 温度 −40～85 ℃，步长 0.1 |
| `BOOL` | — | 开关 |
| `ENUM` | 整数值到标签的映射 | 0 停机、1 运行、2 检修 |
| `STRING` | 最大长度 | 序列号 |
| `STRUCT` | 字段列表，每个字段有自己的类型 | 颜色 `{r, g, b}` |
| `ARRAY` | 元素类型 | 多路温度探头 |

- **各家的基本类型大同小异**：阿里云是 int32、float、double、enum、bool、text、date、struct、array；华为云是 int、long、decimal、string、dateTime、jsonObject、enum、boolean、stringList；DTDL 另有 duration、map 和地理类型
- **嵌套要克制**：阿里云的 struct 不支持再嵌套 struct，DTDL v3 的复杂类型最多 5 层（v4 放宽到 8 层）。时序库的列是标量，结构体要么摊平成多列、要么存成 JSON，能用标量就不用结构体
- **单位写进模型，不写进标识**：标识叫 `temperature`、单位字段写 ℃，而不是叫 `temp_c`；换算和展示由平台按单位处理
- **步长描述精度**：给界面的调节控件和显示小数位用，上报校验不查步长，浮点数很难精确落在步长的整数倍上

### 2、设备分组与标签

物模型回答「这类设备能做什么」，分组和标签回答「这一批设备是哪些」：批量下发指令、灰度升级、按区域授权都靠它。

| 方式 | 成员怎么定 | 主流做法 |
|------|-----------|---------|
| 静态分组 | 人工或接口逐台加入，可以分层 | AWS 的 static thing group 可以建层级，挂在父组上的策略由子组和组内设备继承 |
| 动态分组 | 保存一条查询，满足条件的设备自动进出 | AWS 的 dynamic thing group 建立在 Fleet Indexing 的查询之上（注册表属性、影子、连接状态都能做条件），不能分层、不能挂策略，成员是最终一致的 |
| 标签 | 设备上的键值对，用到时按条件过滤 | Azure 设备孪生的 `tags` 只有后端能读写，设备端看不到，后端用查询语言按 tags 选设备 |

自己实现时，标签存成设备表的 JSON 列，动态分组存成一条查询条件；创建批量任务时把当时的成员快照下来，任务执行期间成员变化不影响已创建的任务。

### 3、版本与发布

模型发布后会有三方依赖它：已出厂的固件、平台里的历史数据、下游应用。演进规则只有一条——**只增不改**：

| 改动 | 是否兼容 | 怎么处理 |
|------|---------|---------|
| 新增属性、事件、服务 | 兼容 | 发布新版本；旧固件不上报新测点，就是缺测 |
| 服务新增带默认值的可选入参 | 兼容 | 旧调用方不传也能用 |
| 放宽取值范围、增加枚举项 | 对上报兼容 | 下游要能处理没见过的值 |
| 改标识、改数据类型、改单位 | 不兼容 | 不改；新增一个标识，旧的标记为废弃 |
| 收窄取值范围、删除枚举项 | 不兼容 | 旧固件的合法值会被拒收 |
| 删除属性 | 不兼容 | 标记为废弃并停止展示，不物理删除 |

- **主流平台都把「已发布」当作一道闸**：阿里云的产品发布后不能编辑物模型；DTDL 规定已发布的模型不可变，新版本用新的模型 ID，并建议只升小版本时改动严格限于新增
- **数据类型不能改的根源在存储**：时序库的一列写入过某种类型后，不能再写别的类型
- **真要做不兼容的改动，就新建一个产品**：把它当成新型号，而不是让同一个产品同时存在两种互不兼容的设备

---

## 五、最小实现

### 1、模型定义

一个温湿度传感器：两个只读测点、一个可写的上报周期、一个高温事件、一个重启服务。

```json
{
  "productKey": "th-sensor",
  "version": 2,
  "properties": {
    "temperature":    {"name": "温度", "type": "FLOAT", "access": "R", "unit": "℃", "min": -40, "max": 85, "step": 0.1},
    "humidity":       {"name": "湿度", "type": "FLOAT", "access": "R", "unit": "%RH", "min": 0, "max": 100, "step": 0.1},
    "reportInterval": {"name": "上报周期", "type": "INT", "access": "RW", "unit": "s", "min": 5, "max": 3600, "step": 1}
  },
  "events": {
    "highTemperature": {"name": "高温告警", "level": "ALERT",
                        "outputs": {"temperature": {"name": "触发时温度", "type": "FLOAT", "unit": "℃"}}}
  },
  "services": {
    "reboot": {"name": "重启", "callType": "ASYNC",
               "inputs": {"delaySeconds": {"name": "延迟秒数", "type": "INT", "min": 0, "max": 60}},
               "outputs": {}}
  }
}
```

TSL 与 DTDL 用数组加标识字段，这里用标识做键，反序列化后直接是按标识索引的 Map，校验时不用再建索引。

```java
public enum DataType { INT, FLOAT, BOOL, ENUM, STRING, STRUCT, ARRAY }
public enum Access { R, RW }
public enum EventLevel { INFO, ALERT, ERROR }
public enum CallType { SYNC, ASYNC }

/** 一个带类型的数据项：属性、事件出参、服务入参出参共用；access 只对属性有意义 */
public record DataSpec(String name, DataType type, Access access, String unit,
                       Double min, Double max, Double step,
                       Map<String, String> enumItems,     // ENUM：值 → 标签
                       Map<String, DataSpec> fields,      // STRUCT：字段
                       DataSpec item) {}                  // ARRAY：元素类型

public record EventDef(String name, EventLevel level, Map<String, DataSpec> outputs) {}

public record ServiceDef(String name, CallType callType,
                         Map<String, DataSpec> inputs, Map<String, DataSpec> outputs) {}

public record ThingModel(String productKey, int version,
                         Map<String, DataSpec> properties,
                         Map<String, EventDef> events,
                         Map<String, ServiceDef> services) {}
```

### 2、上报校验

一条遥测报了 7 个测点，其中 1 个不合格，其余 6 个怎么办？先看主流平台：

| 平台 | 上报与模型不符时 |
|------|----------------|
| 阿里云 | 产品可选弱校验或免校验。弱校验只查标识和数据类型，不查取值范围；不通过的数据不在控制台展示，但全量数据照常流转，并用 `checkFailedData` 标出不通过的部分 |
| Azure IoT Central | 不拒收。设备模板里没定义的数据归为未建模数据（unmodeled data），在 Raw data 视图里能看到；类型不符由诊断命令报出 |
| ThingsBoard、AWS IoT Core | 没有模型，不校验 |

结论是**主流平台都不会因为个别测点不合格而拒收整条**，做法是合格的照常处理，不合格的单独标出来。下面的校验器照此实现，并比阿里云的弱校验多查一项取值范围：超范围的值多半是传感器的故障码（−127、65535），进了曲线就是一根尖刺。

```java
public final class TelemetryValidator {

    public enum Reason { UNDEFINED, TYPE_MISMATCH, OUT_OF_RANGE, ENUM_VALUE }
    public record Rejected(String identifier, Object value, Reason reason) {}
    public record Result(Map<String, Object> accepted, List<Rejected> rejected) {}

    /** 逐点校验：合格的留下，不合格的记入 rejected，由调用方留痕 */
    public static Result validate(ThingModel model, Map<String, Object> values) {
        Map<String, Object> accepted = new LinkedHashMap<>();
        List<Rejected> rejected = new ArrayList<>();
        values.forEach((id, value) -> {
            DataSpec spec = model.properties().get(id);
            Reason reason = spec == null ? Reason.UNDEFINED : check(spec, value);
            if (reason == null) {
                accepted.put(id, value);
            } else {
                rejected.add(new Rejected(id, value, reason));
            }
        });
        return new Result(accepted, rejected);
    }

    /** 返回 null 表示合格；类型判断不做隐式转换，字符串 "25.3" 报给 FLOAT 属于类型不符 */
    static Reason check(DataSpec spec, Object value) {
        Double num = value instanceof Number n && Double.isFinite(n.doubleValue()) ? n.doubleValue() : null;
        return switch (spec.type()) {
            case FLOAT -> num == null ? Reason.TYPE_MISMATCH : range(spec, num);
            case INT -> num == null || num != Math.rint(num) ? Reason.TYPE_MISMATCH : range(spec, num);
            case ENUM -> num == null || num != Math.rint(num) ? Reason.TYPE_MISMATCH
                    : spec.enumItems().containsKey(Long.toString(num.longValue())) ? null : Reason.ENUM_VALUE;
            case BOOL -> value instanceof Boolean ? null : Reason.TYPE_MISMATCH;
            case STRING -> value instanceof String ? null : Reason.TYPE_MISMATCH;
            case STRUCT -> value instanceof Map<?, ?> map && map.entrySet().stream().allMatch(e ->
                    spec.fields().get(e.getKey()) instanceof DataSpec field && check(field, e.getValue()) == null)
                    ? null : Reason.TYPE_MISMATCH;
            case ARRAY -> value instanceof List<?> list && list.stream().allMatch(v -> check(spec.item(), v) == null)
                    ? null : Reason.TYPE_MISMATCH;
        };
    }

    private static Reason range(DataSpec spec, double v) {
        boolean ok = (spec.min() == null || v >= spec.min()) && (spec.max() == null || v <= spec.max());
        return ok ? null : Reason.OUT_OF_RANGE;
    }
}
```

几个要事先定下来的策略：

- **未定义的测点**：默认剔除（`UNDEFINED`），因为没有类型就不知道该怎么存；灰度期可以按产品配置成放行，等同于阿里云的免校验
- **部分不合格**：合格的入库，不合格的剔除并留痕（死信、日志或指标），不用 0 或上一个值顶替；全部不合格才把整条当作坏消息
- **`INT` 接受 `220.0`**：不少固件的 JSON 库把数字一律按浮点输出，数学上是整数就收
- **校验放在入库之前**：接入层写 Kafka 之前，或下游的第一个消费者里都可以，但只做一次
- **事件出参、服务入参复用同一个 `check`**：下发指令前按 `ServiceDef.inputs` 校验参数，不合法的请求不出平台

### 3、按产品缓存

每条消息都要用模型，每次查库不现实。模型按产品缓存在进程内，一个产品一份不可变快照：

```java
@Component
public class ThingModelCache {

    private final ThingModelRepository repository;       // 读库并反序列化当前已发布的版本
    private final Cache<String, ThingModel> cache = Caffeine.newBuilder()
            .maximumSize(10_000)
            .expireAfterWrite(Duration.ofMinutes(1))     // 兜底：漏掉失效通知时最多旧 1 分钟
            .build();

    public ThingModelCache(ThingModelRepository repository) {
        this.repository = repository;
    }

    public ThingModel get(String productKey) {
        return cache.get(productKey, repository::findPublished);
    }

    /** 发布新版本的事务提交之后调用 */
    public void evict(String productKey) {
        cache.invalidate(productKey);
    }
}
```

- **先找产品再找模型**：本模块的 Topic 里只有 `deviceId`，校验前要先由设备查到 `productKey`，这一步同样要缓存
- **失效放在事务提交之后**：先清缓存再提交，中间的读请求会把旧模型重新缓存一轮
- **多实例**：发布时用 Redis 发布订阅通知各实例清除，过期时间兜底，写法见 [规则引擎与告警 · 规则缓存与热更新](./6_rule_engine#六、规则缓存与热更新)；Caffeine 的用法见 [Caffeine](/cache/7_caffeine)

---

## 六、常见坑

| 现象 | 原因 | 处理 |
|------|------|------|
| 一个探头坏了，整台设备的数据全没了 | 一个测点不合格就拒收整条 | 逐点校验，合格的照常入库 |
| 曲线上出现 −127、65535 这样的尖刺 | 只校验类型，不校验范围 | 模型里写取值范围，超范围的剔除并留痕 |
| 改了属性类型后新数据写不进时序库 | 已发布的模型被原地修改 | 类型与标识发布后不改，新增标识 |
| 旧固件的数据突然大量被拒 | 收窄了范围或删了枚举项 | 模型只增不改，不兼容的改动新建产品 |
| 影子的 `delta` 一直不为空 | 设备上报的字段名或数值类型与期望值不一致 | 读写属性的标识和类型以物模型为准，两端共用 |
| 标识里带单位或序号，越加越乱 | 没有单位字段，没有数组与结构体 | 单位进模型；同类多路测点用数组或带序号的固定命名 |
| 发布后各实例校验结果不一致 | 进程内缓存没有通知失效 | 发布后广播清除，并设较短的过期时间兜底 |

---

## 小结

- 物模型挂在产品上，由属性、事件、服务三类功能组成；有了它平台才能校验数据、按类型存储、自动生成界面
- 阿里云、华为云、腾讯云、Azure DTDL、LwM2M 属于先定义后接入，Sparkplug B 由设备上线时自描述，ThingsBoard 与 AWS IoT Core 没有强约束的模型；本模块采用有 schema 的做法，三要素对齐 TSL
- 只读测点走遥测，读写属性走设备影子，事件走 `devices/{deviceId}/event`，服务走 `devices/{deviceId}/cmd` 与 `devices/{deviceId}/response`
- 已发布的模型只增不改：标识、类型、单位不动，不兼容的改动新建产品；分组和标签解决「选哪一批设备」
- 上报按测点校验，个别不合格不拒收整条，被剔除的测点留痕且不用 0 顶替；模型按产品缓存，发布后主动失效
- 本篇讲的是通用设计；配套仓库 Conduit IoT 目前只实现了属性，它的解码器、死信留痕与缺测约定见 [物模型与解码](../4_practice/2_thing_model)

## 参考资料

- 阿里云物联网平台 · 什么是物模型：[https://help.aliyun.com/zh/iot/user-guide/what-is-a-tsl-model](https://help.aliyun.com/zh/iot/user-guide/what-is-a-tsl-model)
- 阿里云物联网平台 · 单个添加物模型（数据类型、事件类型、发布与版本）：[https://help.aliyun.com/zh/iot/user-guide/add-a-tsl-feature](https://help.aliyun.com/zh/iot/user-guide/add-a-tsl-feature)
- 阿里云物联网平台 · 创建产品（校验类型）：[https://help.aliyun.com/zh/iot/user-guide/create-a-product](https://help.aliyun.com/zh/iot/user-guide/create-a-product)
- 阿里云物联网平台 · 设备属性、事件、服务（Alink Topic）：[https://help.aliyun.com/zh/iot/user-guide/device-properties-events-and-services](https://help.aliyun.com/zh/iot/user-guide/device-properties-events-and-services)
- 华为云 IoTDA · 什么是产品模型：[https://support.huaweicloud.com/devg-iothub/iot_01_0017.html](https://support.huaweicloud.com/devg-iothub/iot_01_0017.html)
- 华为云 IoTDA · 在线开发产品模型：[https://support.huaweicloud.com/devg-iothub/iot_02_0005.html](https://support.huaweicloud.com/devg-iothub/iot_02_0005.html)
- 腾讯云物联网开发平台 · 物模型：[https://cloud.tencent.com/document/product/1081/44921](https://cloud.tencent.com/document/product/1081/44921)
- 腾讯云物联网开发平台 · 物模型协议：[https://cloud.tencent.com/document/product/1081/34916](https://cloud.tencent.com/document/product/1081/34916)
- Digital Twins Definition Language（各版本与支持的服务）：[https://github.com/Azure/opendigitaltwins-dtdl](https://github.com/Azure/opendigitaltwins-dtdl)
- DTDL v4 语言规范：[https://github.com/Azure/opendigitaltwins-dtdl/blob/master/DTDL/v4/DTDL.v4.md](https://github.com/Azure/opendigitaltwins-dtdl/blob/master/DTDL/v4/DTDL.v4.md)
- IoT Plug and Play 建模指南（已归档）：[https://learn.microsoft.com/en-us/previous-versions/azure/iot/concepts-modeling-guide](https://learn.microsoft.com/en-us/previous-versions/azure/iot/concepts-modeling-guide)
- IoT Plug and Play 约定（已归档）：[https://learn.microsoft.com/en-us/previous-versions/azure/iot/concepts-convention](https://learn.microsoft.com/en-us/previous-versions/azure/iot/concepts-convention)
- Azure IoT Central 故障排查（未建模数据）：[https://learn.microsoft.com/en-us/azure/iot-central/core/troubleshooting](https://learn.microsoft.com/en-us/azure/iot-central/core/troubleshooting)
- Azure IoT Hub 设备孪生（tags）：[https://learn.microsoft.com/en-us/azure/iot-hub/iot-hub-devguide-device-twins](https://learn.microsoft.com/en-us/azure/iot-hub/iot-hub-devguide-device-twins)
- OMA LwM2M 1.2 核心规范（资源模型）：[https://www.openmobilealliance.org/release/LightweightM2M/V1_2-20201110-A/HTML-Version/OMA-TS-LightweightM2M_Core-V1_2-20201110-A.html](https://www.openmobilealliance.org/release/LightweightM2M/V1_2-20201110-A/HTML-Version/OMA-TS-LightweightM2M_Core-V1_2-20201110-A.html)
- OMA LwM2M 对象注册表（ID 分段）：[https://www.openmobilealliance.org/specifications/registries/objects](https://www.openmobilealliance.org/specifications/registries/objects)
- OMA LwM2M 注册表仓库（对象 5、3303 的定义文件）：[https://github.com/OpenMobileAlliance/lwm2m-registry](https://github.com/OpenMobileAlliance/lwm2m-registry)
- Sparkplug 3.0 规范：[https://sparkplug.eclipse.org/specification/version/3.0/documents/sparkplug-specification-3.0.0.pdf](https://sparkplug.eclipse.org/specification/version/3.0/documents/sparkplug-specification-3.0.0.pdf)
- ThingsBoard · Attributes：[https://thingsboard.io/docs/user-guide/attributes/](https://thingsboard.io/docs/user-guide/attributes/)
- ThingsBoard · Device Profiles：[https://thingsboard.io/docs/user-guide/device-profiles/](https://thingsboard.io/docs/user-guide/device-profiles/)
- ThingsBoard · MQTT Device API：[https://thingsboard.io/docs/reference/mqtt-api/](https://thingsboard.io/docs/reference/mqtt-api/)
- AWS IoT · Thing types：[https://docs.aws.amazon.com/iot/latest/developerguide/thing-types.html](https://docs.aws.amazon.com/iot/latest/developerguide/thing-types.html)
- AWS IoT · Static thing groups：[https://docs.aws.amazon.com/iot/latest/developerguide/thing-groups.html](https://docs.aws.amazon.com/iot/latest/developerguide/thing-groups.html)
- AWS IoT · Dynamic thing groups：[https://docs.aws.amazon.com/iot/latest/developerguide/dynamic-thing-groups.html](https://docs.aws.amazon.com/iot/latest/developerguide/dynamic-thing-groups.html)

> 下一篇：[遥测数据链路](./2_data)
