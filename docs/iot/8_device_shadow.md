---
description: desired / reported / delta、版本号与乐观锁、Topic 设计、Redis 存储、上线同步
---

# 设备影子

> 前置阅读：[MQTT 客户端](./6_mqtt_client)

设备影子（Device Shadow，也叫设备孪生或期望属性）是云端为每台设备保存的一份 JSON 状态文档，应用读写影子而不是直接和设备通信，设备上线后再与影子对齐。本篇讲影子文档模型（参考 AWS IoT Device Shadow）、Topic 与版本冲突设计，以及用 Redis + Lua 实现带乐观锁的影子服务，代码基线为 JDK 21、Spring Boot 4.x（默认 Jackson 3，包名 `tools.jackson`）。

---

## 一、为什么需要影子

### 1、直接下发的问题

| 场景 | 直接通过 MQTT 下发 | 有影子之后 |
|------|------------------|-----------|
| 查询设备当前状态 | 设备离线时查不到，在线时也要一问一答 | 直接读影子的 `reported`，带每个字段的更新时间 |
| 修改设备配置 | 设备离线时指令丢失，或上线后收到一串过时指令 | 写影子的 `desired`，设备上线后只拿到最终期望值 |
| 多个应用同时改配置 | 后发的覆盖先发的，谁也不知道最终结果 | 版本号乐观锁，冲突方收到明确的失败 |
| 判断配置是否生效 | 要自己维护"已下发、未确认"的状态表 | `delta` 为空即表示设备已达到期望状态 |

### 2、影子不是什么

- **不是遥测存储**：温度曲线这类时间序列写时序数据库，见 [时序数据库](/database/4_nosql/1_time_series_db)；影子只保存"当前状态"，比如开关、上报周期、固件版本
- **不是命令队列**：重启、拍照这类一次性动作不是状态，应当作为带过期时间的指令下发，不要写进 `desired`

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
| `metadata` | 影子服务 | 每个字段最后一次更新的时间戳 |
| `version` | 影子服务 | 文档每更新一次加 1，用于乐观锁和乱序判断 |

### 2、几条约定

- **delta 只看 desired**：`desired` 有而 `reported` 没有或值不同的字段进入 `delta`；`reported` 有而 `desired` 没有的字段（如上面的 `fw`）不进入 `delta`
- **嵌套对象逐层比较**：`light.brightness` 不同时，`delta` 里只出现 `{"light":{"brightness":...}}`
- **数组整体替换**：数组不做逐元素合并，期望值与上报值不同就把整个数组放进 `delta`
- **null 表示删除**：更新请求中把字段设为 `null`，从文档中删掉该字段；设备达到期望后可以把整个 `desired` 置为 `null` 清空
- **局部更新**：每次请求只带变化的字段，影子服务负责合并，设备不需要每次上报全量状态

---

## 三、Topic 设计与同步流程

### 1、Topic

| Topic | 方向 | 用途 |
|-------|------|------|
| `shadow/{deviceId}/update` | 设备 → 云 | 上报 `reported` |
| `shadow/{deviceId}/update/accepted` / `rejected` | 云 → 设备 | 更新结果，带新版本号或错误码 |
| `shadow/{deviceId}/delta` | 云 → 设备 | `desired` 变化后推送差异 |
| `shadow/{deviceId}/get` | 设备 → 云 | 请求全量影子 |
| `shadow/{deviceId}/get/accepted` | 云 → 设备 | 返回全量影子 |

设备只能读写自己的影子 Topic，在 EMQX 中用 `${clientid}` 占位符写 ACL，见 [设备安全](./5_security)。请求里带一个 `clientToken`，响应原样返回，设备据此把响应与请求对应起来。

### 2、同步时序

![设备影子同步时序](../assets/iot/device-shadow-sync.svg)

- **在线时**：应用修改 `desired`（①），影子服务算出 `delta` 推给设备（②）；设备执行后上报 `reported`（③），`delta` 随之清空，应用收到"已生效"的通知（④）
- **离线后重新上线**：设备先订阅 `delta` 与 `get/accepted`，再发 `get` 拉取全量影子（⑤⑥），按其中的 `desired` 调整自身后上报 `reported`
- **为什么上线要主动拉取**：MQTT 持久会话能补发短暂断线期间的 `delta`，但会话会过期、设备也可能更换 clientId；影子才是状态的权威来源，拉取一次最稳妥

---

## 四、版本号与冲突处理

### 1、应用侧：乐观锁

应用修改 `desired` 时带上读到的 `version`，影子服务只在版本一致时写入，否则返回冲突，由应用重新读取后再决定是否覆盖：

| 情况 | 结果 |
|------|------|
| 请求 version = 当前 version | 写入成功，version + 1 |
| 请求 version ≠ 当前 version | 返回 409，应用重新读取 |
| 请求不带 version | 跳过校验直接合并，只适合后写者胜也无妨的字段 |

### 2、设备侧：丢弃旧消息

QoS 1 可能重复投递，网络重传也会造成乱序。设备本地记住已处理的最大 `version`，收到 `version` 更小或相等的 `delta` 直接丢弃。

### 3、两边都改了怎么办

| 冲突 | 处理规则 |
|------|---------|
| 设备上报的值与期望值不同 | 正常现象，`delta` 保留，直到设备执行成功 |
| 设备无法执行期望值（超出范围、硬件不支持） | 设备照常上报实际 `reported`，并在 `update` 中附带错误码；由应用决定是否撤回 `desired` |
| 设备在本地被手动修改（面板、按键） | 设备上报新的 `reported`；若业务以现场操作为准，影子服务同时把 `desired` 中对应字段置为 `null` |
| 两个应用同时改同一字段 | 靠 version 乐观锁，后到的请求失败 |

规则要在设计阶段写清楚并对所有接入方统一，否则同一类冲突在不同设备型号上的处理结果会不一样。

---

## 五、存储与实现

### 1、存储分工

| 存储 | 内容 | 作用 |
|------|------|------|
| Redis Hash `shadow:{deviceId}` | `doc`（JSON）、`version` | 热数据，所有读写走这里，Lua 脚本保证比较并写入的原子性 |
| MySQL `device_shadow` | 设备 ID、文档、版本、更新时间 | 持久化，Redis 丢数据时恢复；按设备合并后异步写入 |
| 时序库或日志 | 每次变更的前后值 | 审计与回放，可选 |

### 2、原子更新：Lua 比较并写入

```lua
-- KEYS[1] = shadow:{deviceId}
-- ARGV[1] = 期望版本（-1 表示不校验）  ARGV[2] = 合并后的新文档
local cur = tonumber(redis.call('HGET', KEYS[1], 'version') or '0')
if ARGV[1] ~= '-1' and tonumber(ARGV[1]) ~= cur then
  return -1
end
redis.call('HSET', KEYS[1], 'doc', ARGV[2], 'version', cur + 1)
return cur + 1
```

合并与 `delta` 计算在 Java 中完成，Lua 只负责"版本没变才写"。设备上报 `reported` 时不带版本，冲突时服务端自动重读重试；应用修改 `desired` 时带版本，冲突直接返回 409。

### 3、合并与 delta 计算

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

    /** 应用修改 desired，expectedVersion 为 null 表示不校验 */
    public long updateDesired(String deviceId, JsonNode desiredPatch, Long expectedVersion) {
        return update(deviceId, "desired", desiredPatch, expectedVersion, 1);
    }

    /** 设备上报 reported：不带版本，冲突时重试 */
    public long updateReported(String deviceId, JsonNode reportedPatch) {
        return update(deviceId, "reported", reportedPatch, null, 3);
    }

    private long update(String deviceId, String section, JsonNode patch, Long expected, int attempts) {
        String key = "shadow:" + deviceId;
        for (int i = 0; i < attempts; i++) {
            Shadow current = load(key);                        // 读 doc 与 version
            ObjectNode state = current.state().deepCopy();
            ObjectNode target = state.has(section) ? (ObjectNode) state.get(section) : state.putObject(section);
            ShadowMerger.merge(target, patch);
            ObjectNode delta = ShadowMerger.delta(
                    state.path("desired"), state.path("reported"));

            long checkVersion = expected != null ? expected : current.version();
            Long newVersion = redis.execute(CAS, List.of(key),
                    String.valueOf(checkVersion), json.writeValueAsString(state));
            if (newVersion != null && newVersion > 0) {
                if (!delta.isEmpty() && section.equals("desired")) {
                    pushDelta(deviceId, delta, newVersion);
                }
                events.publishEvent(new ShadowChanged(deviceId, newVersion, state));  // 异步落库、通知应用
                return newVersion;
            }
            if (expected != null) {
                throw new VersionConflictException(deviceId, expected);           // 映射为 409
            }
        }
        throw new VersionConflictException(deviceId, -1);
    }

    private void pushDelta(String deviceId, ObjectNode delta, long version) {
        ObjectNode msg = JsonNodeFactory.instance.objectNode();
        msg.set("state", delta);
        msg.put("version", version);
        mqtt.publish("shadow/" + deviceId + "/delta", 1, json.writeValueAsString(msg));
    }
}
```

- `Shadow` 是 `record Shadow(ObjectNode state, long version)`，`load` 用 `HMGET` 读取两个字段，不存在时返回空文档与版本 0
- MQTT 推送放在 Redis 写入成功之后，不在数据库事务里发消息；`ShadowChanged` 事件由监听器异步合并写入 MySQL
- `delta` 推送失败不影响影子本身，设备上线拉取全量时仍能拿到

---

## 六、常见坑

| 现象 | 原因 | 处理 |
|------|------|------|
| 设备上线后执行了很久以前的指令 | 把一次性命令写进了 `desired`，或 MQTT 消息没设过期 | 命令走带过期时间的指令通道，影子只放状态 |
| 两个运维同时改配置，结果互相覆盖 | 没有版本校验 | 应用侧更新必须带 `version` |
| `delta` 一直不为空 | 数值类型不一致，或设备上报的字段名与期望不同 | 统一字段名与数值类型，在物模型中约束 |
| 设备收到旧的 `delta` 把配置改回去 | 重复投递或乱序 | 设备丢弃 `version` 不大于本地记录的消息 |
| Redis 故障后影子全部丢失 | 只存了 Redis | MySQL 持久化并支持按需回填 |

---

## 小结

- 影子是设备状态的云端副本：应用写 `desired`，设备写 `reported`，服务计算 `delta`；时序数据和一次性命令都不放进影子
- 文档按字段局部合并，`null` 删除字段，数组整体替换，嵌套对象逐层计算 `delta`
- `version` 每次更新加 1：应用侧做乐观锁，设备侧丢弃旧消息
- 设备上线先订阅再拉取全量影子，MQTT 持久会话只是补充，影子才是权威来源
- Redis Hash + Lua 保证比较并写入的原子性，MySQL 异步持久化，消息推送放在写入成功之后

## 参考资料

- AWS IoT Device Shadow 文档结构：[https://docs.aws.amazon.com/iot/latest/developerguide/device-shadow-document.html](https://docs.aws.amazon.com/iot/latest/developerguide/device-shadow-document.html)
- AWS IoT Device Shadow 数据流：[https://docs.aws.amazon.com/iot/latest/developerguide/device-shadow-data-flow.html](https://docs.aws.amazon.com/iot/latest/developerguide/device-shadow-data-flow.html)
- Redis EVAL 与 Lua 脚本：[https://redis.io/docs/latest/develop/programmability/eval-intro/](https://redis.io/docs/latest/develop/programmability/eval-intro/)

> 下一篇：[Netty 接入网关](./9_netty_gateway)
