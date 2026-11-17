---
description: desired / reported / delta、五家平台对照、Topic 与版本冲突、命名影子、Redis 实现
---

# 设备影子

> 前置阅读：[MQTT 客户端](../2_access/3_mqtt_client)、[物模型](./1_thing_model)

设备影子是云端为每台设备保存的一份 JSON 状态文档，应用读写影子，设备上线后再与影子对齐。本篇讲五家平台的影子模型对照、文档模型、Topic 与版本冲突、一种 Redis + Lua 实现，基线为 JDK 21、Spring Boot 4。

---

## 一、为什么需要影子

设备影子（Device Shadow）是设备状态在云端的副本，应用读写影子而不是直接和设备通信。各家的叫法和范围并不相同：AWS、阿里云、华为云叫设备影子；Azure 叫设备孪生（Device Twin），多一段只有后端可见的 `tags`，也不替设备计算差异；阿里云把「设备影子」和按物模型属性工作的「期望属性值」列为两个功能；ThingsBoard 没有影子文档，用共享属性与客户端属性达到同样的效果。逐项对照见本节第 3 小节。

### 1、直接下发的问题

| 场景 | 直接通过 MQTT 下发 | 有影子之后 |
|------|------------------|-----------|
| 查询设备当前状态 | 设备离线时查不到，在线时也要一问一答 | 直接读影子的 `reported`，带每个字段的更新时间 |
| 修改设备配置 | 设备离线时指令丢失，或上线后收到一串过时指令 | 写影子的 `desired`，设备上线后只拿到最终期望值 |
| 多个应用同时改配置 | 后发的覆盖先发的，谁也不知道最终结果 | 版本号乐观锁，冲突方收到明确的失败 |
| 判断配置是否生效 | 要自己维护"已下发、未确认"的状态表 | `delta` 为空即表示设备已达到期望状态 |

### 2、影子不是什么

- **不是遥测存储**：温度曲线这类时间序列写时序数据库，见 [时序数据库](/nosql/4_time_series_db)；影子只保存"当前状态"，比如开关、上报周期、固件版本
- **不是命令队列**：重启、拍照这类一次性动作不是状态，不要写进 `desired`；它们走带过期时间的指令通道，见 [指令下发与服务调用](./4_command)
- **不是数字孪生**：设备影子（设备孪生）是单台设备的状态副本；数字孪生是用模型描述楼宇、产线这样的整个环境，把多个实体和它们之间的关系连成一张图（如 Azure Digital Twins），设备影子只是它的数据来源之一
- **不负责定义字段**：`desired` 里能写哪些属性、类型和取值范围是什么，由物模型约束，见 [物模型](./1_thing_model)

### 3、五家平台的影子模型

| 对照项 | AWS IoT Device Shadow | Azure IoT Hub Device Twin | 阿里云设备影子与期望属性值 | 华为云 IoTDA 设备影子 | ThingsBoard 属性 |
|--------|----------------------|---------------------------|--------------------------|---------------------|-----------------|
| 文档分区 | `state.desired`、`state.reported`，另有 `metadata`、`version`、`timestamp` | `tags`（只有后端可见）、`properties.desired`、`properties.reported` | 影子：`state.desired`、`state.reported`、`metadata`、`version`；期望属性值按物模型属性逐个保存 | 按服务（`service_id`）分组，每组有 `desired`、`reported`、`version` | 共享属性（平台写、设备读）、客户端属性（设备写）、服务端属性（设备不可见） |
| 差异由谁算 | 服务端算出 `delta`，只推差异字段 | 不算；推送的是后端本次改动的补丁，设备自己比较 | 影子不单独给差异：`desired` 变更后以 `method: control` 下发，示例载荷同时带 `desired` 与 `reported` | 不单独给差异：把 `desired` 以属性设置的方式下发 | 不算；共享属性变化时只推变化的键 |
| 版本语义 | 整份文档一个 `version`，每次更新加 1；请求带的版本不一致返回 409，不带则不校验 | `desired`、`reported` 各有只增的 `$version`，整份孪生另有 `etag` 用于条件更新 | 影子：设备端更新的 `version` 须大于当前版本，云端接口填 0 表示不校验；期望属性值每设置一次版本加 1 | 修改 `desired` 的接口带 `version` 时须等于当前版本 | JSON 接口里没有版本号，每个属性只有最后更新时间 |
| Topic | `$aws/things/{thingName}/shadow/update`、`…/get` 及各自的 `/accepted`、`/rejected`，另有 `…/update/delta`、`…/update/documents` | `$iothub/twin/GET/?$rid=`、`$iothub/twin/PATCH/properties/reported/?$rid=`、`$iothub/twin/PATCH/properties/desired/#`，响应在 `$iothub/twin/res/#` | 影子：`/shadow/update/${ProductKey}/${DeviceName}`（上行）、`/shadow/get/${ProductKey}/${DeviceName}`（下行）；期望属性值：`/sys/${productKey}/${deviceName}/thing/property/desired/get` | 取影子：`$oc/devices/{device_id}/sys/shadow/get/request_id={request_id}`；下发：`$oc/devices/{device_id}/sys/properties/set/request_id={request_id}` | `v1/devices/me/attributes`（上报客户端属性、订阅共享属性变化）、`v1/devices/me/attributes/request/$request_id` |
| 大小限制 | 默认 8 KB（可申请调高），`desired` / `reported` 内最多 8 层 | `tags` 8 KB，`desired`、`reported` 各 32 KB，最多 10 层 | 影子 16 KB、5 层、128 个属性 | 期望值、上报值文档各 64 KB | 文档未给出 |
| 多影子 | 支持：一台设备一个经典影子加多个命名影子 | 没有命名孪生；设备下的每个模块各有一份模块孪生 | 每台设备一个 | 每台设备一个 | 没有影子文档，属性按键平铺 |
| 离线重连 | 先订阅 `delta` 与响应 Topic，再发 `get` 取全量并上报当前状态 | 平台不为离线设备保留变更通知：连上后先订阅变更、再取全量，忽略 `$version` 不大于全量的通知 | 设备上线后主动发 `method: get` 拉取；期望属性值同样由设备上线后主动获取 | 设备上线或上报数据时平台自动下发 `desired`，设备也可主动取 | 启动时订阅共享属性变化，并用 request 接口读回共享属性 |

表里是两条路线：AWS 由服务端计算差异并只推差异，设备逻辑最简单；Azure、ThingsBoard 只推本次变更，设备（或 SDK）自己比较。无论哪条路线，设备重连后都要主动取一次全量，不能只靠推送。阿里云物联网平台自 2025 年 2 月起停止新购、文档已标为停止维护，表中只作为模型对照。

**本篇示例采用 AWS 模型**（`state.desired` / `reported` / `delta`、`metadata`、`version`、`timestamp`、`clientToken`），Topic 去掉 `$aws/things` 前缀并归到 `devices/{deviceId}/shadow/` 下。与 AWS 的差异只有三处：Topic 前缀不同，没有实现命名影子，没有实现删除影子的 `delete`。

---

## 二、影子文档模型

### 1、文档结构

```json
{
  "state": {
    "desired":  { "reportInterval": 30, "light": { "on": true, "brightness": 80 } },
    "reported": { "reportInterval": 60, "light": { "on": true, "brightness": 80 }, "fw": "2.1.0" },
    "delta":    { "reportInterval": 30 }
  },
  "metadata": {
    "desired":  { "reportInterval": { "timestamp": 1760000000 } },
    "reported": { "reportInterval": { "timestamp": 1759990000 } }
  },
  "version": 42,
  "timestamp": 1760000005
}
```

| 字段 | 谁写 | 含义 |
|------|------|------|
| `desired` | 应用、规则引擎 | 期望设备达到的状态 |
| `reported` | 设备 | 设备当前实际状态 |
| `delta` | 影子服务计算 | `desired` 中与 `reported` 不一致的字段，只读 |
| `metadata` | 影子服务 | 每个字段最后一次更新的时间戳（秒） |
| `version` | 影子服务 | 文档每更新一次加 1，用于乐观锁和乱序判断 |
| `timestamp` | 影子服务 | 这条消息的生成时间；设备没有时钟时，可以用它和 `metadata` 相减算出某个字段有多旧 |
| `clientToken` | 请求方 | 只出现在请求与应答里：请求带上，应答原样返回，用来把应答和请求对上 |

### 2、几条约定

- **delta 只看 desired**：`desired` 有而 `reported` 没有或值不同的字段进入 `delta`；`reported` 有而 `desired` 没有的字段（如上面的 `fw`）不进入 `delta`
- **嵌套对象逐层比较**：`light.brightness` 不同时，`delta` 里只出现 `{"light":{"brightness":...}}`
- **数组整体替换**：数组不做逐元素合并，期望值与上报值不同就把整个数组放进 `delta`
- **null 表示删除**：更新请求中把字段设为 `null`，从文档中删掉该字段；设备达到期望后可以把整个 `desired` 置为 `null` 清空
- **局部更新**：每次请求只带变化的字段，影子服务负责合并，设备不需要每次上报全量状态

### 3、大小限制与命名影子

影子是「一台设备一份小文档」，各家都给了上限，自建时也要定一个，否则迟早有人把日志或遥测塞进来：

| 平台 | 文档大小 | 嵌套层数 | 其他 |
|------|---------|---------|------|
| AWS | 默认 8 KB，可申请调高，`metadata` 不计入 | `desired` / `reported` 内最多 8 层 | 影子名最长 64 字节，`clientToken` 最长 64 字节，每个影子每秒 20 次请求 |
| Azure | `tags` 8 KB，`desired`、`reported` 各 32 KB | 10 层 | 每台设备最多 50 个模块（各有一份模块孪生） |
| 阿里云 | 16 KB | 5 层 | 最多 128 个属性，每台设备每秒 20 次请求 |
| 华为云 | 期望值、上报值文档各 64 KB | — | 属性要先在产品模型里定义 |

- **自建时的取法**：文档上限取 8 KB 到 32 KB、嵌套不超过 5 到 8 层，超限的更新直接拒绝并发到 `update/rejected`；再给每台设备的更新频率设个上限，影子不是用来每秒刷新的
- **命名影子（Named Shadow）**：AWS 允许一台设备除了一个经典影子外再有多个带名字的影子，Topic 前缀由 `$aws/things/{thingName}/shadow` 变成 `$aws/things/{thingName}/shadow/name/{shadowName}`。适合三种情况：状态按功能拆开（配置、固件、位置各一份），单份文档就不容易顶到上限；不同应用只授权读写其中一份；更新频率差别大的状态互不影响版本号
- **本篇示例只有一份影子**：要支持命名影子时，按同样的规则把 Topic 扩成 `devices/{deviceId}/shadow/name/{shadowName}/update`，存储键里加上影子名即可

---

## 三、Topic 设计与同步流程

### 1、Topic

以下 Topic 都以 `devices/{deviceId}/shadow` 开头，表中省略这段前缀：

| Topic | 方向 | 用途 |
|-------|------|------|
| `…/update` | 设备、应用 → 云 | 更新影子：设备写 `reported`，应用写 `desired`（应用更常走 HTTP 接口） |
| `…/update/accepted` | 云 → 请求方 | 更新被接受，带新的 `version` 与请求里的 `clientToken` |
| `…/update/rejected` | 云 → 请求方 | 更新被拒绝，带错误码与原因：格式错误 400、版本冲突 409 |
| `…/update/delta` | 云 → 设备 | 更新被接受后，只要 `desired` 与 `reported` 仍有差异就发布，内容是全部差异字段 |
| `…/update/documents` | 云 → 应用 | 每次更新成功后发布，含更新前后两份完整文档（`previous`、`current`） |
| `…/get` | 设备、应用 → 云 | 请求全量影子，消息体为空 |
| `…/get/accepted` | 云 → 请求方 | 返回全量影子，含 `delta` |
| `…/get/rejected` | 云 → 请求方 | 取不到影子时返回错误 |

- **`update/documents` 给应用用**：应用订阅它就能知道「配置何时生效」，比较 `previous` 与 `current` 还能知道这次改了什么，不用轮询影子；设备不需要订阅
- **`get/rejected` 不能不订阅**：新设备第一次上线时影子还不存在，`get` 会落到这里；设备收到后上报一份初始 `reported`，影子随之创建。只订阅 `get/accepted` 的设备在这种情况下会一直等下去
- **先订阅再请求**：应答 Topic 要在发布请求之前订阅好，否则应答可能先于订阅到达而丢失
- **应答按 `clientToken` 认领**：同一台设备的影子，设备和应用都可能订阅了 `update/accepted`，各自只处理 `clientToken` 是自己发出的那条

设备只能读写自己的影子 Topic，在 EMQX 中用 `${clientid}` 占位符写 ACL，见 [设备安全](../2_access/1_security)；影子之外的 Topic 与整套命名约定见 [通信协议 · Topic 约定](../1_basics/1_protocol#_7、topic-约定)。

### 2、同步时序

![设备影子同步时序](../../assets/iot/device-shadow-sync.svg)

- **在线时**：应用修改 `desired`（①，走 HTTP 接口或发布到 `update`），影子服务算出差异发到 `update/delta`（②）；设备执行后向 `update` 上报 `reported`（③），差异清空，应用从 `update/documents` 收到"已生效"的通知（④）
- **离线后重新上线**：设备先订阅 `update/delta`、`get/accepted` 与 `get/rejected`，再向 `get` 发一条空消息拉取全量影子（⑤⑥），按其中的 `desired` 调整自身后上报 `reported`
- **为什么上线要主动拉取**：MQTT 持久会话能补发短暂断线期间的 `delta`，但会话会过期、设备也可能更换 clientId；影子才是状态的权威来源，拉取一次最稳妥
- **delta 什么时候发**：不只是 `desired` 被修改的那一刻。任何一次被接受的更新之后，只要两边还有差异就会再发一次，设备上报了别的字段、但期望值还没执行完时也会收到，所以设备处理 `delta` 要幂等

---

## 四、版本号与冲突处理

### 1、应用侧：乐观锁

应用修改 `desired` 时带上读到的 `version`，影子服务只在版本一致时写入，否则返回冲突，由应用重新读取后再决定是否覆盖：

| 情况 | 结果 |
|------|------|
| 请求 version = 当前 version | 写入成功，version + 1 |
| 请求 version ≠ 当前 version | 返回 409，应用重新读取 |
| 请求不带 version | 跳过校验直接合并，只适合后写者胜也无妨的字段 |

不带 `version` 并不等于盲写：合并是「读出文档、合并、写回」三步，服务端仍然以读到的版本做比较并写入，并发下撞上了就重读、重新合并，对调用方表现为总能合并成功，见五.4 的代码。

### 2、设备侧：丢弃旧消息

QoS 1 可能重复投递，网络重传也会造成乱序。设备本地记住已处理的最大 `version`，收到 `version` 更小或相等的 `delta` 直接丢弃。

### 3、两边都改了怎么办

| 冲突 | 处理规则 |
|------|---------|
| 设备上报的值与期望值不同 | 正常现象，`delta` 保留，直到设备执行成功 |
| 设备无法执行期望值（超出范围、硬件不支持） | 设备照常上报实际 `reported`，并附带确认信息（见下）；由应用决定是否撤回 `desired` |
| 设备在本地被手动修改（面板、按键） | 设备上报新的 `reported`；若业务以现场操作为准，影子服务同时把 `desired` 中对应字段置为 `null` |
| 两个应用同时改同一字段 | 靠 version 乐观锁，后到的请求失败 |

**设备怎么说「我做不到」**：AWS 的影子模型没有规定这件事，各家自定。现成可参照的是 Azure IoT Plug and Play 的可写属性确认约定：设备在 `reported` 里把该属性写成一个对象，`value` 是设备实际采用的值，`ac` 是 HTTP 状态码风格的确认码（200 已生效、202 已接受处理中、400 不接受、500 执行出错），`av` 是所确认的那次 `desired` 的版本号，`ad` 是可选的文字说明。

本篇示例借用这三个字段，但不把属性值包成对象（包了以后 `reported` 与 `desired` 的形状不同，服务端的差异计算要跟着改）：属性仍然上报裸值，确认信息放在 `reported.ack` 下以属性名为键。`ack` 不在 `desired` 里，不会进入 `delta`：

```json
{
  "state": {
    "reported": {
      "reportInterval": 60,
      "ack": { "reportInterval": { "ac": 400, "av": 43, "ad": "取值范围 10 到 3600" } }
    }
  }
}
```

应用从 `update/documents` 或影子的 `reported.ack` 看到 400，决定改一个合法的期望值，还是把 `desired.reportInterval` 置为 `null` 撤回。规则要在设计阶段写清楚并对所有接入方统一，否则同一类冲突在不同设备型号上的处理结果会不一样。

---

## 五、存储与实现

AWS、Azure 等云厂商不公开影子服务的存储实现，本节是自建时的**一种实现**：Redis 做热存储，MySQL 做持久化。设备量不大时，只用一张带版本列的关系表、以 `UPDATE … WHERE version = ?` 做乐观锁也够用。

### 1、存储分工

| 存储 | 内容 | 作用 |
|------|------|------|
| Redis Hash `shadow:{deviceId}` | `doc`（JSON）、`version` | 热数据，所有读写走这里，Lua 脚本保证比较并写入的原子性 |
| MySQL `device_shadow` | 设备 ID、文档、版本、更新时间 | 持久化，Redis 丢数据时恢复；按设备合并后异步写入 |
| 时序库或日志 | 每次变更的前后值 | 审计与回放，可选 |

### 2、原子更新：Lua 比较并写入

```lua
-- KEYS[1] = shadow:{deviceId}
-- ARGV[1] = 合并时读到的版本  ARGV[2] = 合并后的新文档
local cur = tonumber(redis.call('HGET', KEYS[1], 'version') or '0')
if tonumber(ARGV[1]) ~= cur then
  return -1
end
redis.call('HSET', KEYS[1], 'doc', ARGV[2], 'version', cur + 1)
return cur + 1
```

合并与 `delta` 计算在 Java 中完成，Lua 只负责"读到的版本没变才写"。请求带了版本（应用修改 `desired`）时，冲突直接返回 409；请求没带版本（设备上报 `reported`，或应用不要求校验）时，冲突由服务端重读、重新合并后再试。

### 3、合并与 delta 计算

下面的代码使用 Jackson 3（Spring Boot 4.x 默认），包名为 `tools.jackson`。

```java
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.JsonNodeFactory;
import tools.jackson.databind.node.ObjectNode;

import java.util.Map;

public final class ShadowMerger {

    /** 把局部更新合并进当前状态：null 删除字段，对象逐层合并，其余（含数组）整体替换 */
    public static void merge(ObjectNode target, JsonNode patch) {
        for (Map.Entry<String, JsonNode> e : patch.properties()) {
            JsonNode value = e.getValue();
            JsonNode existing = target.get(e.getKey());
            if (value.isNull()) {
                target.remove(e.getKey());
            } else if (value.isObject() && existing instanceof ObjectNode child) {
                merge(child, value);
            } else {
                target.set(e.getKey(), value.deepCopy());
            }
        }
    }

    /** desired 中与 reported 不一致的字段 */
    public static ObjectNode delta(JsonNode desired, JsonNode reported) {
        ObjectNode out = JsonNodeFactory.instance.objectNode();
        for (Map.Entry<String, JsonNode> e : desired.properties()) {
            JsonNode d = e.getValue();
            JsonNode r = reported == null ? null : reported.get(e.getKey());
            if (d.isObject() && r != null && r.isObject()) {
                ObjectNode sub = delta(d, r);
                if (!sub.isEmpty()) {
                    out.set(e.getKey(), sub);
                }
            } else if (r == null || !d.equals(r)) {
                out.set(e.getKey(), d.deepCopy());
            }
        }
        return out;
    }
}
```

`JsonNode.equals` 区分数值类型，`30` 与 `30.0` 被视为不同；约定好数值字段的类型（整数还是小数），或在比较前统一转换。

### 4、影子服务

```java
@Service
public class ShadowService {

    private static final int MAX_ATTEMPTS = 3;
    private static final DefaultRedisScript<Long> CAS =
            new DefaultRedisScript<>(Scripts.SHADOW_CAS, Long.class);   // 上面的 Lua 脚本

    private final StringRedisTemplate redis;
    private final JsonMapper json;
    private final MqttGateway mqtt;
    private final ApplicationEventPublisher events;

    public ShadowService(StringRedisTemplate redis, JsonMapper json,
                         MqttGateway mqtt, ApplicationEventPublisher events) {
        this.redis = redis;
        this.json = json;
        this.mqtt = mqtt;
        this.events = events;
    }

    /** 应用修改 desired：带版本时冲突直接失败；expectedVersion 为 null 表示不校验，冲突时重读重试 */
    public long updateDesired(String deviceId, JsonNode desiredPatch, Long expectedVersion) {
        return update(deviceId, "desired", desiredPatch, expectedVersion);
    }

    /** 设备上报 reported：不带版本，冲突时重读重试 */
    public long updateReported(String deviceId, JsonNode reportedPatch) {
        return update(deviceId, "reported", reportedPatch, null);
    }

    private long update(String deviceId, String section, JsonNode patch, Long expected) {
        String key = "shadow:" + deviceId;
        // 带版本的请求只试一次，冲突交给调用方；不带版本的请求由服务端重读、重新合并
        int attempts = expected != null ? 1 : MAX_ATTEMPTS;
        for (int i = 0; i < attempts; i++) {
            Shadow current = load(key);                        // 读 doc 与 version
            if (expected != null && expected != current.version()) {
                break;                                         // 版本已经不对，不必再合并
            }
            ObjectNode state = current.state().deepCopy();
            if (patch.isNull()) {
                state.remove(section);                         // 整段置为 null：清空 desired 或 reported
            } else {
                ObjectNode target = state.has(section) ? (ObjectNode) state.get(section) : state.putObject(section);
                ShadowMerger.merge(target, patch);
            }
            ObjectNode delta = ShadowMerger.delta(state.path("desired"), state.path("reported"));

            Long newVersion = redis.execute(CAS, List.of(key),
                    String.valueOf(current.version()), json.writeValueAsString(state));
            if (newVersion != null && newVersion > 0) {
                if (!delta.isEmpty()) {
                    pushDelta(deviceId, delta, newVersion);    // 谁更新的都一样：仍有差异就发
                }
                // 监听器异步落库，并把 previous / current 发布到 update/documents
                events.publishEvent(new ShadowChanged(deviceId, newVersion, current.state(), state));
                return newVersion;
            }
        }
        throw new VersionConflictException(deviceId, expected);    // 映射为 409，发到 update/rejected
    }

    private void pushDelta(String deviceId, ObjectNode delta, long version) {
        ObjectNode msg = JsonNodeFactory.instance.objectNode();
        msg.set("state", delta);
        msg.put("version", version);
        msg.put("timestamp", Instant.now().getEpochSecond());
        mqtt.publish("devices/" + deviceId + "/shadow/update/delta", 1, json.writeValueAsString(msg));
    }
}
```

- `Shadow` 是 `record Shadow(ObjectNode state, long version)`，`load` 用 `HMGET` 读取两个字段，不存在时返回空文档与版本 0
- **不带版本也会重试**：`updateDesired` 的 `expectedVersion` 为 `null` 时与设备上报走同一条路，最多重读重试 3 次；3 次都撞上说明这台设备的影子被异常高频地更新，抛出冲突让调用方知道
- **delta 的发送条件**：不区分这次更新的是 `desired` 还是 `reported`，写入成功后只要差异不为空就发，与三.1 表里的语义一致
- MQTT 推送放在 Redis 写入成功之后，不在数据库事务里发消息；`ShadowChanged` 事件由监听器异步合并写入 MySQL，并发布 `update/documents`
- `update/accepted` 与 `update/rejected`（带请求里的 `clientToken`）由接收 MQTT 请求的入口处理器按返回值或异常发布，这里省略
- 示例没有维护 `metadata`：需要每个字段的更新时间时，在合并的同时写一棵与 `state` 同形状的时间戳树
- `delta` 推送失败不影响影子本身，设备上线拉取全量时仍能拿到

---

## 六、常见坑

| 现象 | 原因 | 处理 |
|------|------|------|
| 设备上线后执行了很久以前的指令 | 把一次性命令写进了 `desired`，或 MQTT 消息没设过期 | 命令走带过期时间的指令通道（见 [指令下发与服务调用](./4_command)），影子只放状态 |
| 两个运维同时改配置，结果互相覆盖 | 没有版本校验 | 应用侧更新必须带 `version` |
| `delta` 一直不为空 | 数值类型不一致，或设备上报的字段名与期望不同 | 统一字段名与数值类型，在 [物模型](./1_thing_model) 中约束 |
| 设备收到旧的 `delta` 把配置改回去 | 重复投递或乱序 | 设备丢弃 `version` 不大于本地记录的消息 |
| 新设备上线后一直拿不到影子 | 影子还不存在，应答落在没订阅的 `get/rejected` | 订阅 `get/rejected`，收到后上报初始 `reported` |
| 影子文档越来越大 | 把日志、遥测或历史记录写进了影子 | 设大小上限并拒绝超限更新；按功能拆成命名影子 |
| Redis 故障后影子全部丢失 | 只存了 Redis | MySQL 持久化并支持按需回填 |

---

## 小结

- 影子是设备状态的云端副本：应用写 `desired`，设备写 `reported`，服务计算 `delta`；时序数据和一次性命令都不放进影子，它也不等于描述多实体关系的数字孪生
- 五家平台分两条路线：AWS 由服务端算差异，Azure、ThingsBoard 只推变更；本篇示例采用 AWS 模型，Topic 归到 `devices/{deviceId}/shadow/` 下
- 文档按字段局部合并，`null` 删除字段，数组整体替换，嵌套对象逐层计算 `delta`；文档要有大小上限，状态多了按功能拆成命名影子
- `version` 每次更新加 1：应用侧做乐观锁，设备侧丢弃旧消息；任何被接受的更新之后只要仍有差异就发 `delta`
- 设备上线先订阅（含 `get/rejected`）再拉取全量影子，MQTT 持久会话只是补充，影子才是权威来源
- 存储是自建时的一种实现：Redis Hash + Lua 保证比较并写入的原子性，MySQL 异步持久化，消息推送放在写入成功之后
- 本篇讲的是通用设计；配套仓库 Conduit IoT 的实现篇计划在平台实战一组补充，目前见 [平台实战概览](../4_practice/0_intro)

## 参考资料

- AWS IoT Device Shadow 文档结构：[https://docs.aws.amazon.com/iot/latest/developerguide/device-shadow-document.html](https://docs.aws.amazon.com/iot/latest/developerguide/device-shadow-document.html)
- AWS IoT Device Shadow MQTT Topic：[https://docs.aws.amazon.com/iot/latest/developerguide/device-shadow-mqtt.html](https://docs.aws.amazon.com/iot/latest/developerguide/device-shadow-mqtt.html)
- AWS IoT Device Shadow 数据流：[https://docs.aws.amazon.com/iot/latest/developerguide/device-shadow-data-flow.html](https://docs.aws.amazon.com/iot/latest/developerguide/device-shadow-data-flow.html)
- AWS IoT 设备侧使用影子（先订阅再请求、重连流程）：[https://docs.aws.amazon.com/iot/latest/developerguide/device-shadow-comms-device.html](https://docs.aws.amazon.com/iot/latest/developerguide/device-shadow-comms-device.html)
- AWS IoT Core 配额（影子大小、层数、影子名长度）：[https://docs.aws.amazon.com/general/latest/gr/iot-core.html](https://docs.aws.amazon.com/general/latest/gr/iot-core.html)
- Azure IoT Hub 设备孪生（分区、大小限制、重连流程）：[https://learn.microsoft.com/en-us/azure/iot-hub/iot-hub-devguide-device-twins](https://learn.microsoft.com/en-us/azure/iot-hub/iot-hub-devguide-device-twins)
- Azure IoT Hub 的 MQTT Topic（孪生读取、上报与变更通知）：[https://learn.microsoft.com/en-us/azure/iot/iot-mqtt-connect-to-iot-hub](https://learn.microsoft.com/en-us/azure/iot/iot-mqtt-connect-to-iot-hub)
- Azure IoT Hub 模块孪生：[https://learn.microsoft.com/en-us/azure/iot-hub/iot-hub-devguide-module-twins](https://learn.microsoft.com/en-us/azure/iot-hub/iot-hub-devguide-module-twins)
- Azure IoT Plug and Play 约定（可写属性的 ac / av / ad 确认，现位于微软归档文档）：[https://learn.microsoft.com/en-us/previous-versions/azure/iot/concepts-convention](https://learn.microsoft.com/en-us/previous-versions/azure/iot/concepts-convention)
- Azure Digital Twins 概览：[https://learn.microsoft.com/en-us/azure/digital-twins/overview](https://learn.microsoft.com/en-us/azure/digital-twins/overview)
- 阿里云物联网平台设备影子概览（文档已标注停止维护，下同）：[https://help.aliyun.com/zh/iot/user-guide/overview-2](https://help.aliyun.com/zh/iot/user-guide/overview-2)
- 阿里云设备影子数据流（Topic、method、version）：[https://help.aliyun.com/zh/iot/user-guide/forwarding-of-device-shadow-data](https://help.aliyun.com/zh/iot/user-guide/forwarding-of-device-shadow-data)
- 阿里云期望属性值：[https://help.aliyun.com/zh/iot/user-guide/desired-device-property-values](https://help.aliyun.com/zh/iot/user-guide/desired-device-property-values)
- 阿里云物联网平台使用限制：[https://help.aliyun.com/zh/iot/product-overview/limits](https://help.aliyun.com/zh/iot/product-overview/limits)
- 华为云 IoTDA 设备影子：[https://support.huaweicloud.com/usermanual-iothub/iot_01_0049.html](https://support.huaweicloud.com/usermanual-iothub/iot_01_0049.html)
- 华为云 IoTDA 设备侧获取影子的 Topic：[https://support.huaweicloud.com/api-iothub/iot_06_v5_3012.html](https://support.huaweicloud.com/api-iothub/iot_06_v5_3012.html)
- 华为云 IoTDA 约束与限制：[https://support.huaweicloud.com/productdesc-iothub/iot_04_0010.html](https://support.huaweicloud.com/productdesc-iothub/iot_04_0010.html)
- ThingsBoard 属性：[https://thingsboard.io/docs/user-guide/attributes/](https://thingsboard.io/docs/user-guide/attributes/)
- ThingsBoard MQTT 属性接口：[https://thingsboard.io/docs/reference/mqtt-api/attributes/](https://thingsboard.io/docs/reference/mqtt-api/attributes/)
- Redis EVAL 与 Lua 脚本：[https://redis.io/docs/latest/develop/programmability/eval-intro/](https://redis.io/docs/latest/develop/programmability/eval-intro/)

> 下一篇：[指令下发与服务调用](./4_command)
