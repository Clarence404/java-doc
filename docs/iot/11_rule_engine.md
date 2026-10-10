---
description: 自研与 EMQX / ThingsBoard / Flink 取舍、规则 DSL、边沿触发、动作幂等、热更新
---

# 规则引擎

> **本篇目标**：判断什么时候用 Broker 或平台自带的规则引擎、什么时候自研；设计规则的数据模型与 DSL，实现条件匹配、边沿触发、动作幂等和规则热更新，并避开在数据库事务里发消息、规则表关联抓取异常这些常见问题。
>
> **前置阅读**：[Netty 设备接入网关](./9_netty_gateway)（统一消息 `TelemetryMessage`）

规则引擎回答的是"数据满足什么条件时自动做什么"：温度超过 80℃ 推送告警，烟雾传感器触发时下发关闭风机的指令，某类设备的数据转发给第三方 Webhook。本篇假设设备数据已经由接入层写入 Kafka，规则引擎作为 Kafka 消费者运行。代码基线为 JDK 21、Spring Boot 4.x。

---

## 一、先选方案

### 1、四种实现位置

| 方案 | 规则写法 | 擅长 | 不擅长 |
|------|---------|------|-------|
| EMQX 规则引擎 | 类 SQL，作用于 MQTT 消息 | 靠近 Broker 的过滤、字段提取、转发到 Kafka 等外部系统（Sink）、重新发布 | 跨消息的状态、复杂业务动作 |
| ThingsBoard 规则链 | 可视化节点 + 脚本 | 平台内的告警、遥测处理、设备联动 | 与自有业务系统深度耦合 |
| Flink（SQL / CEP） | SQL 或模式 API | 时间窗口、连续 N 次、多流关联等有状态计算 | 单条消息的简单判断显得太重 |
| 自研（本篇） | 结构化条件 + 动作 | 与自有设备模型、权限、工单等业务紧密结合 | 复杂窗口计算 |

EMQX 的规则是这样一条 SQL，命中后执行配置的动作：

```sql
SELECT
  clientid,
  payload.temperature AS temperature
FROM
  "devices/+/data"
WHERE
  payload.temperature > 80
```

**组合使用最常见**：EMQX 规则负责把原始消息转发进 Kafka；"连续 5 分钟超温"这类窗口规则交给 Flink，见 [Flink 总览](/flink/0_overview)；与业务相关的单点判断和动作由自研规则引擎完成。ThingsBoard 规则链的用法见 [平台选型](./2_platform)。

### 2、执行链路

![规则引擎执行链路](../assets/iot/rule-engine-pipeline.svg)

设备消息从 Kafka 进入，按设备找到候选规则并匹配条件；命中后交给动作执行层，先做幂等去重，再分别执行告警、指令下发和 Webhook 调用，每类动作有独立的超时与重试策略。

---

## 二、规则模型

### 1、DSL 的三种形态

| 形态 | 示例 | 适合 | 风险 |
|------|------|------|------|
| 结构化条件 | `{"metric":"temperature","op":"GT","threshold":80}` | 运维在页面上配置，覆盖大部分场景 | 表达力有限 |
| 表达式 | `temperature > 80 && humidity < 30` | 需要组合与计算 | 用户输入的表达式会被执行，必须限制能力 |
| 类 SQL | 见上文 EMQX 示例 | 熟悉 SQL 的使用者 | 需要自己实现或依赖平台 |

用 SpEL 这类表达式语言实现时，只能使用 `SimpleEvaluationContext` 并只暴露数据字段；`StandardEvaluationContext` 允许调用任意类和方法，用户填写的表达式等同于远程代码执行，见 [常见漏洞与防护](/security/8_vulnerabilities)。本篇采用结构化条件。

### 2、规则 DTO

```java
import com.fasterxml.jackson.annotation.JsonSubTypes;
import com.fasterxml.jackson.annotation.JsonTypeInfo;

public enum Operator {
    GT, GTE, LT, LTE, EQ, NEQ;

    public boolean test(double value, double threshold) {
        return switch (this) {
            case GT -> value > threshold;
            case GTE -> value >= threshold;
            case LT -> value < threshold;
            case LTE -> value <= threshold;
            case EQ -> Double.compare(value, threshold) == 0;
            case NEQ -> Double.compare(value, threshold) != 0;
        };
    }
}

public record Condition(String metric, Operator op, double threshold) {

    boolean test(Map<String, Object> metrics) {
        return metrics.get(metric) instanceof Number n && op.test(n.doubleValue(), threshold);
    }
}

@JsonTypeInfo(use = JsonTypeInfo.Id.NAME, property = "type")
@JsonSubTypes({
        @JsonSubTypes.Type(value = AlarmAction.class, name = "ALARM"),
        @JsonSubTypes.Type(value = CommandAction.class, name = "COMMAND"),
        @JsonSubTypes.Type(value = WebhookAction.class, name = "WEBHOOK")})
public sealed interface Action permits AlarmAction, CommandAction, WebhookAction {}

public record AlarmAction(String receiver, String template, Duration silence) implements Action {}
public record CommandAction(String targetDeviceId, String command) implements Action {}
public record WebhookAction(URI url) implements Action {}

/** 运行时使用的不可变规则：多线程共享，无需加锁 */
public record CompiledRule(long id, long version, String deviceId,
                           List<Condition> conditions, List<Action> actions) {

    boolean matches(TelemetryMessage msg) {
        return conditions.stream().allMatch(c -> c.test(msg.metrics()));   // 条件之间为 AND
    }
}
```

运算符用枚举而不是字符串，配置错误在加载时就会暴露；`Action` 用密封接口，动作执行处的 `switch` 漏掉某种动作时编译期报错。

### 3、持久化：条件与动作存 JSON 列

```java
@Entity
@Table(name = "iot_rule")
public class RuleEntity {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    private String name;
    private String deviceId;        // 为空表示适用于全部设备
    private boolean enabled;

    @Version
    private long version;           // 乐观锁，同时作为规则版本号

    @Column(columnDefinition = "json")
    private String conditions;      // List<Condition> 的 JSON

    @Column(columnDefinition = "json")
    private String actions;         // List<Action> 的 JSON，带 type 字段

    // getter / setter 省略
}
```

条件和动作总是随规则整体读写，存成 JSON 列最简单，加载时由 `JsonMapper` 反序列化为上面的 DTO。如果坚持用两张关联表，注意两个坑：两个 `List` 集合同时 `EAGER` 抓取会抛 `MultipleBagFetchException`，应改为 `Set` 或懒加载后分两次查询；`@OneToMany` 不写 `@JoinColumn` 时 Hibernate 会生成一张多余的中间表。

---

## 三、匹配与触发

### 1、消费与匹配

```java
@Component
public class RuleEngine {

    private final RuleCache cache;
    private final ActionDispatcher dispatcher;
    // key = ruleId:deviceId，记录上一条消息是否命中，用于边沿触发
    private final ConcurrentHashMap<String, Boolean> lastMatched = new ConcurrentHashMap<>();

    public RuleEngine(RuleCache cache, ActionDispatcher dispatcher) {
        this.cache = cache;
        this.dispatcher = dispatcher;
    }

    @KafkaListener(topics = "iot.telemetry", groupId = "rule-engine")
    public void onMessage(TelemetryMessage msg) {
        for (CompiledRule rule : cache.rulesFor(msg.deviceId())) {
            boolean matched = rule.matches(msg);
            Boolean previous = lastMatched.put(rule.id() + ":" + msg.deviceId(), matched);
            if (matched && !Boolean.TRUE.equals(previous)) {     // 只在"不满足 → 满足"时触发
                dispatcher.dispatch(rule, msg);
            }
        }
    }
}
```

### 2、边沿触发而不是电平触发

温度在 85℃ 停留一小时，设备每 10 秒上报一次；如果每条命中的消息都触发动作，一小时会发出 360 条告警。边沿触发只在条件从"不满足"变为"满足"时执行一次，恢复正常后再次超限才会再触发。

- **状态的归属**：Kafka 消息以设备 ID 为 key，同一设备总是由同一个消费者实例处理，所以 `lastMatched` 放在本地内存即可；分区再均衡后状态丢失，最多多触发一次，由动作层的幂等兜底
- **状态清理**：规则删除或设备注销时清理对应条目，或改用带过期时间的 Caffeine 缓存
- **更复杂的条件**：连续 N 次、持续 T 分钟、多设备联合判断，本质上是窗口计算，交给 Flink 的状态与定时器，而不是在这里手写

---

## 四、动作执行

### 1、幂等与告警收敛

Kafka 是"至少一次"投递，消费者重启、再均衡时同一条消息可能被处理两次。动作执行前先用 Redis 的 `SET NX EX` 占位：

| 动作 | 幂等键 | 过期时间 |
|------|-------|---------|
| 告警 | `rule:alarm:{ruleId}:{deviceId}` | 规则配置的静默期，如 30 分钟，期间同一规则同一设备不重复告警 |
| 指令、Webhook | `rule:act:{ruleId}:{deviceId}:{动作序号}:{消息时间戳}` | 1 小时，覆盖消息重投的时间窗口 |

更多去重方案见 [幂等设计](/architecture/5_idempotence)。

### 2、执行器

```java
@Component
public class ActionDispatcher {

    private final StringRedisTemplate redis;
    private final AlarmNotifier notifier;
    private final MqttGateway mqtt;
    private final RestClient webhookClient;
    private final ExecutorService webhookPool = Executors.newVirtualThreadPerTaskExecutor();
    private final Semaphore webhookPermits = new Semaphore(50);    // 隔离：外部系统慢时最多占 50 个并发

    public ActionDispatcher(StringRedisTemplate redis, AlarmNotifier notifier,
                            MqttGateway mqtt, RestClient webhookClient) {
        this.redis = redis;
        this.notifier = notifier;
        this.mqtt = mqtt;
        this.webhookClient = webhookClient;
    }

    public void dispatch(CompiledRule rule, TelemetryMessage msg) {
        for (int i = 0; i < rule.actions().size(); i++) {
            Action action = rule.actions().get(i);
            if (!acquire(rule, msg, i, action)) {
                continue;                                           // 已执行过或处于静默期
            }
            switch (action) {
                case AlarmAction a -> notifier.send(a.receiver(), Templates.render(a.template(), msg));
                case CommandAction c -> mqtt.publish("devices/" + c.targetDeviceId() + "/command", 1, c.command());
                case WebhookAction w -> webhookPool.submit(() -> callWebhook(w, msg));
            }
        }
    }

    private boolean acquire(CompiledRule rule, TelemetryMessage msg, int index, Action action) {
        String key;
        Duration ttl;
        if (action instanceof AlarmAction a) {
            key = "rule:alarm:" + rule.id() + ":" + msg.deviceId();
            ttl = a.silence();
        } else {
            key = "rule:act:" + rule.id() + ":" + msg.deviceId() + ":" + index + ":" + msg.timestamp().toEpochMilli();
            ttl = Duration.ofHours(1);
        }
        return Boolean.TRUE.equals(redis.opsForValue().setIfAbsent(key, "1", ttl));
    }

    private void callWebhook(WebhookAction w, TelemetryMessage msg) {
        if (!webhookPermits.tryAcquire()) {
            return;                                                 // 并发已满，记录指标后放弃或进重试队列
        }
        try {
            webhookClient.post().uri(w.url()).body(msg).retrieve().toBodilessEntity();
        } catch (RestClientException e) {
            // 失败写入重试队列（带退避），多次失败进入死信，不阻塞规则消费
        } finally {
            webhookPermits.release();
        }
    }
}
```

`RestClient` 必须配置超时，否则一个挂起的第三方接口会耗尽线程：

```java
@Bean
public RestClient webhookClient(RestClient.Builder builder) {
    HttpClient httpClient = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(2))
            .build();
    var factory = new JdkClientHttpRequestFactory(httpClient);
    factory.setReadTimeout(Duration.ofSeconds(3));
    return builder.requestFactory(factory).build();
}
```

- **Webhook 地址是用户配置的**：保存时校验协议与域名白名单，拒绝内网地址和元数据服务地址，防止被当作 SSRF 跳板
- 超时、重试与舱壁隔离的系统性做法见 [超时、重试与隔离](/high-avail/4_timeout_retry_bulkhead)

### 3、消息不放进数据库事务

告警通常还要落一条告警记录。常见的错误写法是在 `@Transactional` 方法里先插入记录、再发 MQTT 或调用 Webhook：事务最终回滚时，消息已经发出、无法撤回；外部调用变慢时，数据库连接和行锁被一直占住。

正确做法是事务只负责写库，提交成功后再发消息：

```java
@Transactional
public void raiseAlarm(AlarmRecord record) {
    alarmRepository.save(record);
    events.publishEvent(new AlarmRaised(record.id()));      // 只发布进程内事件
}

@TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT)
public void onAlarmRaised(AlarmRaised event) {
    notifier.sendFor(event.alarmId());                       // 提交成功后才通知
}
```

`AFTER_COMMIT` 监听器在进程崩溃时可能来不及执行；要求"写库成功就一定发出"时，改用本地消息表，由独立任务扫描投递，见 [分布式事务](/distributed/4_transaction)。

---

## 五、规则缓存与热更新

每条设备消息都查一次数据库加载规则，消息量一上来数据库就成为瓶颈。规则数量通常只有几千条，适合整体加载到内存，变更时通知所有实例重新加载：

```java
@Component
public class RuleCache {

    private final RuleLoader loader;                                   // 读库并反序列化为 CompiledRule
    private volatile Map<String, List<CompiledRule>> byDevice = Map.of();
    private volatile List<CompiledRule> global = List.of();

    public RuleCache(RuleLoader loader) {
        this.loader = loader;
    }

    /** 启动时立即执行；之后每 5 分钟兜底对齐一次，防止漏掉变更通知 */
    @Scheduled(fixedDelay = 300_000)
    public synchronized void reload() {
        List<CompiledRule> all = loader.loadEnabled();
        global = all.stream().filter(r -> r.deviceId() == null).toList();
        byDevice = all.stream().filter(r -> r.deviceId() != null)
                .collect(Collectors.groupingBy(CompiledRule::deviceId));
    }

    public List<CompiledRule> rulesFor(String deviceId) {
        List<CompiledRule> own = byDevice.getOrDefault(deviceId, List.of());
        return own.isEmpty() ? global : Stream.concat(global.stream(), own.stream()).toList();
    }
}
```

```java
@Bean
public RedisMessageListenerContainer ruleChangeListener(RedisConnectionFactory factory, RuleCache cache) {
    var container = new RedisMessageListenerContainer();
    container.setConnectionFactory(factory);
    container.addMessageListener((message, pattern) -> cache.reload(), new ChannelTopic("iot:rules:changed"));
    return container;
}
```

- 规则管理服务保存成功后，在 `AFTER_COMMIT` 监听器里执行 `redis.convertAndSend("iot:rules:changed", ruleId)`，与上一节同理，不在事务里发通知
- 新的规则集整体构建好后一次性替换引用，读线程看到的要么是旧版本、要么是新版本，不会读到一半
- Redis Pub/Sub 不保证送达，定时全量对齐作为兜底；本地缓存与通知失效的更多模式见 [两级缓存（L1 + L2）](/cache/8_two_level_cache)

---

## 六、常见坑

| 现象 | 原因 | 处理 |
|------|------|------|
| 同一故障刷出上百条告警 | 电平触发，每条命中消息都执行动作 | 边沿触发 + 告警静默期 |
| 消费者重启后指令重复下发 | Kafka 至少一次投递 | 动作执行前按幂等键占位 |
| 规则服务拖垮数据库 | 每条消息都查规则表 | 内存缓存 + 变更通知 + 定时对齐 |
| 启动时报 `MultipleBagFetchException` | 两个 `List` 关联同时 `EAGER` 抓取 | 条件、动作存 JSON 列，或改 `Set` / 懒加载 |
| 告警记录回滚了，通知却发出去了 | 在事务里发消息 | `AFTER_COMMIT` 或本地消息表 |
| 第三方接口变慢，规则消费积压 | Webhook 同步调用且无超时 | 配置超时，异步执行并限制并发 |
| 用户填写的表达式执行了系统命令 | SpEL 使用了 `StandardEvaluationContext` | 只用 `SimpleEvaluationContext` 或结构化条件 |

---

## 小结

- 简单过滤与转发交给 EMQX 规则，窗口类规则交给 Flink，与业务紧密相关的判断和动作再自研
- 规则用结构化条件 + 密封接口动作建模，运算符用枚举；条件与动作存 JSON 列，避免关联表的抓取问题
- 匹配采用边沿触发，状态依赖 Kafka 按设备分区保持在同一实例
- 动作执行前按幂等键占位，告警配静默期；Webhook 配超时、限并发、失败重试，地址做 SSRF 校验
- 数据库事务里不发消息，提交后再通知；规则整体缓存在内存，变更通过 Redis Pub/Sub 通知并定时兜底对齐

## 参考资料

- EMQX 规则引擎入门：[https://docs.emqx.com/en/emqx/latest/data-integration/rule-get-started.html](https://docs.emqx.com/en/emqx/latest/data-integration/rule-get-started.html)
- Spring Framework 事务绑定事件：[https://docs.spring.io/spring-framework/reference/data-access/transaction/event.html](https://docs.spring.io/spring-framework/reference/data-access/transaction/event.html)
- Spring Framework REST Clients（RestClient）：[https://docs.spring.io/spring-framework/reference/integration/rest-clients.html](https://docs.spring.io/spring-framework/reference/integration/rest-clients.html)
- Spring Expression Language（SimpleEvaluationContext）：[https://docs.spring.io/spring-framework/reference/core/expressions/evaluation.html](https://docs.spring.io/spring-framework/reference/core/expressions/evaluation.html)

> 返回：[IoT 总览](./0_overview)
