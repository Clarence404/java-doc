---
description: 主流平台三类规则模型、规则放哪一层、触发-条件-动作引擎、恢复边沿、设备告警模型、动作幂等、热更新
---

# 规则引擎与告警

> 前置阅读：[遥测数据链路](./2_data)、[指令下发与服务调用](./4_command)

规则引擎回答「数据满足什么条件时自动做什么」，各家平台的规则都能拆成数据源、条件、动作三部分，告警是规则最常见的产出。本篇讲主流平台的三类规则模型与分层、自己实现一个触发-条件-动作引擎、设备告警模型，基线为 JDK 21、Spring Boot 4。

---

## 一、主流平台的规则模型

### 1、三类模型

| 类型 | 平台 | 规则怎么写 | 擅长 |
|------|------|-----------|------|
| SQL 式数据流转 | AWS IoT Rules | `SELECT … FROM '主题过滤器' WHERE …`，加一到多个动作和可选的错误动作；动作有 Kinesis、Kafka、Lambda、S3、DynamoDB、SNS、重新发布等 | 把消息过滤、改形后转发到别的系统，无状态，一条消息一次判断 |
| | EMQX 规则引擎 | 规则 SQL 的 `FROM` 是消息主题或 `$events/...` 事件（连接、断开、订阅等）；动作是 Sink、重新发布或控制台输出；另有可视化的 Flow Designer | |
| | 华为云 IoTDA 数据转发 | 选数据来源（设备属性、设备消息、设备状态等）和触发事件，可写 SQL 过滤，再选转发目标（Kafka、OBS、FunctionGraph、HTTP 等）；基础版实例不支持 SQL | |
| | Azure IoT Hub 消息路由 | 数据源是遥测、孪生变更、生命周期等事件；路由查询是对消息属性、消息体与孪生的布尔表达式；端点是 Event Hubs、Service Bus、Storage、Cosmos DB 等 | |
| 流程与脚本式 | ThingsBoard 规则链 | 规则节点连成的有向图，节点分过滤、补充、转换、动作、外部、流程、分析几类，脚本用 TBEL 或 JavaScript | 多步加工、按条件分支、补充上下文，可视化编排 |
| | 阿里云新版云产品流转 | 数据源（Topic）加解析器脚本加数据目的；旧版是 SQL | |
| 触发-条件-动作 | 阿里云场景联动（2023 年 1 月起升级为事件响应） | 触发器是设备触发或定时触发，多个触发器之间为或；执行条件之间为与；再配执行动作 | 设备联动和告警，业务人员在页面上配置 |
| | 华为云 IoTDA 设备联动 | 触发条件是设备属性、定时或设备状态，可选全部满足或任一满足；动作是下发命令、发送通知、上报告警、恢复告警 | |
| | ThingsBoard Alarm Rules（4.3 起的新版告警规则） | 每条规则有若干触发条件（各带一个严重级别）和一个清除条件；条件分简单、持续一段时间、连续若干次三种，可按时间表生效 | |

三类模型可以叠用：SQL 式规则在 Broker 一侧把数据搬进 Kafka，流程式规则在平台内做加工，触发-条件-动作规则面向业务人员配联动与告警。阿里云物联网平台自 2025 年 2 月起停止新购，文档也已标为停止维护（见 [平台选型](../1_basics/2_platform)），表中以它为参照的是规则模型本身，不代表推荐选用。

### 2、共性：数据源、条件、动作

![三类规则模型的共性](../../assets/iot/rule-engine-models.svg)

- **数据源**：设备消息、设备事件（上下线、订阅）、定时；SQL 式写在 `FROM` 里，触发-条件-动作式叫触发器
- **条件**：对当前这条数据的判断（阈值、相等、存在），或对一段时间的判断（持续 5 分钟、连续 3 次）；后者需要状态，SQL 式规则做不了
- **动作**：转发到外部系统、下发指令、产生或清除告警、发通知；动作要能重试，也要能去重

第三节自己实现的引擎属于第三类，数据源是 Kafka 里的统一遥测消息与定时，动作有告警、指令与 Webhook。

---

## 二、先选方案

### 1、规则与告警放在哪一层

| 方案 | 规则写法 | 擅长 | 不擅长 | 典型告警 |
|------|---------|------|-------|---------|
| EMQX 规则引擎 | 类 SQL，作用于 MQTT 消息与 Broker 事件 | 靠近 Broker 的过滤、字段提取、转发到 Kafka 等外部系统（Sink）、重新发布 | 跨消息的状态、复杂业务动作 | 设备连接断开（`$events/client/disconnected`），事件源头就在 Broker |
| ThingsBoard 规则链与告警规则 | 可视化节点 + 脚本；告警规则按条件配置 | 平台内的告警、遥测处理、设备联动 | 与自有业务系统深度耦合 | 整个平台就用 ThingsBoard 时的阈值告警 |
| Flink（SQL / CEP） | SQL 或模式 API | 时间窗口、连续 N 次、多流关联等有状态计算，秒级延迟 | 单条消息的简单判断显得太重 | 离线、连续超温、多条件组合，需要按设备保存状态和定时器 |
| Grafana Alerting | 查询 + Reduce + Threshold，在页面上配置 | 基于已入库数据的阈值与趋势，运维自助配置、不用发版 | 按分钟评估，不适合秒级响应，也不能直接驱动设备动作 | 单指标阈值、趋势类 |
| 触发-条件-动作引擎（本篇第三节） | 结构化条件 + 动作 | 与自有设备模型、权限、工单等业务紧密结合，规则由业务人员配置 | 复杂窗口计算 | 设备联动、需要关联业务数据（工单、设备模型、权限）的单点判断 |

EMQX 规则 SQL 的写法见 [遥测数据链路 · 规则 SQL](./2_data#_2、规则-sql)，Flink 的离线检测与 CEP 见 [遥测数据链路 · Flink 2.x 实时处理](./2_data#四、flink-2-x-实时处理)，ThingsBoard 规则链的用法见 [平台选型 · ThingsBoard 规则链](../1_basics/2_platform#五、thingsboard-规则链)，Grafana 告警规则与 Webhook 回调的配置见 [告警体系 · Grafana Alerting 与 Alertmanager](/observability/4_alerting#八、grafana-alerting-与-alertmanager)。

**组合使用最常见**：EMQX 规则负责把原始消息转发进 Kafka；"连续 5 分钟超温"这类窗口规则交给 Flink；与业务相关的单点判断和动作由触发-条件-动作引擎完成。**同一个告警只在一层产生**，各层的告警再统一汇入第五节的告警模型做去重、确认与清除，避免同一故障从多个渠道各报一次。

### 2、执行链路

![规则引擎执行链路](../../assets/iot/rule-engine-pipeline.svg)

设备消息从 Kafka 主题 `iot.telemetry` 进入，形状是 [遥测数据链路 · Topic 与消息约定](./2_data#_1、topic-与消息约定) 里的统一消息（`deviceId`、`protocol`、`timestamp`、`metrics`），下文代码里的 `TelemetryMessage` 就是它。引擎按设备所属的产品、分组找到候选规则并匹配条件；命中后交给动作执行层，告警交给告警模型去重，指令与 Webhook 先做幂等去重再执行，每类动作有独立的超时与重试策略。

---

## 三、自己实现一个触发-条件-动作引擎

本节的引擎对应第一节的第三类：一条规则有作用域、若干触发器（之间为或）、若干条件（之间为与）和若干动作。

### 1、表达式引擎选型

条件怎么写，有三种形态：

| 形态 | 示例 | 适合 | 风险 |
|------|------|------|------|
| 结构化条件 | `{"metric":"temperature","op":"GT","threshold":80}` | 运维在页面上配置，覆盖大部分场景 | 表达力有限 |
| 表达式 | `temperature > 80 && humidity < 30` | 需要组合与计算 | 用户输入的表达式会被执行，必须限制能力 |
| 类 SQL | EMQX 规则 SQL，见 [遥测数据链路 · 规则 SQL](./2_data#_2、规则-sql) | 熟悉 SQL 的使用者 | 需要自己实现或依赖平台 |

要支持表达式时，Java 里常见的选择如下（版本截至 2026-11）：

| 引擎 | 当前版本与状态 | 特点 | 用作规则条件时 |
|------|--------------|------|-------------|
| SpEL | 随 Spring Framework 7 | Spring 自带，零依赖 | 只能用 `SimpleEvaluationContext`，它只支持语法的一个子集，排除了类型引用、构造器和 Bean 引用 |
| AviatorScript | 5.4.4（2026-07） | 编译成字节码执行，快；官方定位可作安全的语言沙箱 | 开启沙箱模式；5.4.4 修复了沙箱模式下 io 模块仍可用的问题，用沙箱的项目要升级 |
| QLExpress | 4.1.4（2026-11） | 阿里开源，面向业务规则 | 4.x 与 3.x 不兼容，新项目直接用 4.x |
| CEL（cel-java） | 0.15.0（2026-10），尚未 1.0 | Google 的表达式语言，线性时间求值、无副作用、非图灵完备 | 天然适合「用户写的条件」：不会死循环，也调不到任意 Java 方法 |
| Drools | 10.2.0（2026-04），Apache KIE 孵化项目 | 完整的规则引擎，Rete 匹配、规则之间可推理 | 规则数多、规则之间互相影响时才值得，单条阈值判断太重 |
| Easy Rules | 4.1.0，2020-12 起进入维护模式，只修缺陷 | 轻量，规则即 Java 对象 | 新项目不推荐 |
| Flink CEP | Flink 自带的库 | 按事件顺序匹配模式，带时间窗口 | 「连续 N 次」「A 之后 T 内出现 B」这类有序模式，放在 Flink 作业里，见 [遥测数据链路 · 连续超温：CEP](./2_data#_4、连续超温-cep) |

`StandardEvaluationContext` 允许调用任意类和方法，用户填写的 SpEL 表达式等同于远程代码执行，见 [常见漏洞与防护](/security/8_vulnerabilities)。本篇采用结构化条件；需要组合表达式时首选 CEL，其次是开启沙箱的 Aviator。

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

/** 作用域：规则绑定到全部设备、某个产品、某个设备分组或单台设备 */
public enum ScopeType { ALL, PRODUCT, GROUP, DEVICE }

public record Scope(ScopeType type, String id) {

    boolean covers(DeviceRef d) {
        return switch (type) {
            case ALL -> true;
            case PRODUCT -> id.equals(d.productKey());
            case GROUP -> d.groups().contains(id);
            case DEVICE -> id.equals(d.deviceId());
        };
    }
}

/** 设备台账的本地缓存：设备属于哪个产品、在哪些分组 */
public record DeviceRef(String deviceId, String productKey, Set<String> groups) {}

/** 触发器：一条规则的多个触发器之间为「或」 */
@JsonTypeInfo(use = JsonTypeInfo.Id.NAME, property = "type")
@JsonSubTypes({
        @JsonSubTypes.Type(value = TelemetryTrigger.class, name = "TELEMETRY"),
        @JsonSubTypes.Type(value = TimerTrigger.class, name = "TIMER")})
public sealed interface Trigger permits TelemetryTrigger, TimerTrigger {}

public record TelemetryTrigger() implements Trigger {}                    // 作用域内的设备上报遥测时求值
public record TimerTrigger(String cron, String zone) implements Trigger {} // 到点时对作用域内每台设备求值

@JsonTypeInfo(use = JsonTypeInfo.Id.NAME, property = "type")
@JsonSubTypes({
        @JsonSubTypes.Type(value = AlarmAction.class, name = "ALARM"),
        @JsonSubTypes.Type(value = CommandAction.class, name = "COMMAND"),
        @JsonSubTypes.Type(value = WebhookAction.class, name = "WEBHOOK")})
public sealed interface Action permits AlarmAction, CommandAction, WebhookAction {}

/** 产生告警；clearOnRecover 为 true 时，条件恢复后自动清除 */
public record AlarmAction(String alarmType, AlarmSeverity severity, boolean clearOnRecover) implements Action {}
/** 下发指令：targetDeviceId 为空表示发给触发规则的那台设备；timeout 是发出后等结果的时长，ttl 是离线时最多等多久 */
public record CommandAction(String targetDeviceId, String method, Map<String, Object> params,
                            Duration timeout, Duration ttl) implements Action {}
public record WebhookAction(URI url) implements Action {}

/** 运行时使用的不可变规则：多线程共享，无需加锁 */
public record CompiledRule(long id, long version, Scope scope, List<Trigger> triggers,
                           List<Condition> conditions, List<Action> actions) {

    boolean matches(Map<String, Object> metrics) {
        return conditions.stream().allMatch(c -> c.test(metrics));        // 条件之间为「与」
    }

    boolean onTelemetry() {
        return triggers.stream().anyMatch(t -> t instanceof TelemetryTrigger);
    }
}
```

- **作用域按产品、分组绑定**：「这个型号的温度超过 80 就告警」应当配一次、对整个产品生效，新设备入网自动适用，而不是逐台设备配一条规则；分组用来做「某个厂区」「某个客户」这类跨产品的范围。ThingsBoard 4.3 的新版告警规则也是这样，可以建在设备、资产、它们的配置模板（profile）或客户上。设备属于哪个产品、哪些分组来自设备台账，见 [设备注册与生命周期](../2_access/2_provisioning)
- 运算符用枚举而不是字符串，配置错误在加载时就会暴露；`Trigger`、`Action` 用密封接口，`switch` 漏掉某种类型时编译期报错
- 条件里的测点名、取值范围应当来自物模型，配置页面据此给出下拉选项并校验阈值，见 [物模型](./1_thing_model)

### 3、持久化：触发器、条件与动作存 JSON 列

```java
@Entity
@Table(name = "iot_rule")
public class RuleEntity {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    private String name;
    @Enumerated(EnumType.STRING)
    private ScopeType scopeType;
    private String scopeId;         // ALL 时为空
    private boolean enabled;

    @Version
    private long version;           // 乐观锁，同时作为规则版本号

    @Column(columnDefinition = "json")
    private String triggers;        // List<Trigger> 的 JSON，带 type 字段

    @Column(columnDefinition = "json")
    private String conditions;      // List<Condition> 的 JSON

    @Column(columnDefinition = "json")
    private String actions;         // List<Action> 的 JSON，带 type 字段

    // getter / setter 省略
}
```

触发器、条件和动作总是随规则整体读写，存成 JSON 列最简单，加载时由 `JsonMapper` 反序列化为上面的 DTO。如果坚持用关联表，注意两个坑：两个 `List` 集合同时 `EAGER` 抓取会抛 `MultipleBagFetchException`，应改为 `Set` 或懒加载后分两次查询；`@OneToMany` 不写 `@JoinColumn` 时 Hibernate 会生成一张多余的中间表。

### 4、消费与匹配

```java
@Component
public class RuleEngine {

    private final RuleCache cache;
    private final DeviceDirectory devices;          // 设备台账的本地缓存，返回 DeviceRef
    private final LatestValues latest;              // 每台设备每个测点的最新值
    private final ActionDispatcher dispatcher;
    // key = ruleId:deviceId，记录上一次求值是否满足，用于边沿触发
    private final ConcurrentHashMap<String, Boolean> lastMatched = new ConcurrentHashMap<>();

    public RuleEngine(RuleCache cache, DeviceDirectory devices, LatestValues latest,
                      ActionDispatcher dispatcher) {
        this.cache = cache;
        this.devices = devices;
        this.latest = latest;
        this.dispatcher = dispatcher;
    }

    @KafkaListener(topics = "iot.telemetry", groupId = "rule-engine")
    public void onMessage(TelemetryMessage msg) {
        Map<String, Object> snapshot = latest.merge(msg.deviceId(), msg.metrics());   // 合并后的最新值
        for (CompiledRule rule : cache.rulesFor(devices.get(msg.deviceId()))) {
            if (rule.onTelemetry()) {
                evaluate(rule, msg.deviceId(), snapshot, msg.timestamp());
            }
        }
    }

    /** 边沿触发：「不满足 → 满足」执行动作，「满足 → 不满足」执行恢复 */
    void evaluate(CompiledRule rule, String deviceId, Map<String, Object> metrics, long ts) {
        boolean matched = rule.matches(metrics);
        Boolean previous = lastMatched.put(rule.id() + ":" + deviceId, matched);
        if (matched && !Boolean.TRUE.equals(previous)) {
            dispatcher.fire(rule, deviceId, metrics, ts);
        } else if (!matched && Boolean.TRUE.equals(previous)) {
            dispatcher.recover(rule, deviceId, ts);
        }
    }
}
```

条件对**合并后的最新值**求值，而不是只看这一条消息：设备分字段上报时，一条只带湿度的消息里没有温度，若只看这条消息，「温度超过 80」会被误判为恢复。

### 5、边沿触发与恢复

温度在 85℃ 停留一小时，设备每 10 秒上报一次；如果每条命中的消息都触发动作，一小时会发出 360 条告警。边沿触发只在条件从"不满足"变为"满足"时执行一次，恢复正常后再次超限才会再触发。

恢复边沿同样重要：「满足 → 不满足」时，告警应当自动清除，否则告警列表里全是早已恢复的条目，值班人员只能逐条手动关闭。`recover` 只处理配置了 `clearOnRecover` 的告警动作，指令与 Webhook 不做「反向动作」：

```java
public void recover(CompiledRule rule, String deviceId, long ts) {
    for (Action action : rule.actions()) {
        if (action instanceof AlarmAction a && a.clearOnRecover()) {
            alarms.clear(deviceId, a.alarmType(), ts);     // 告警模型见第五节
        }
    }
}
```

- **状态的归属**：Kafka 消息以设备 ID 为 key，同一设备总是由同一个消费者实例处理，所以 `lastMatched` 与最新值放在本地内存即可；分区再均衡后状态丢失，最多多触发一次，告警由告警模型去重，指令与 Webhook 由动作层的幂等兜底
- **恢复要防抖**：读数在阈值附近来回跳时，会反复触发、反复恢复。做法是恢复条件比触发条件留一段回差（超过 80 告警、低于 75 才恢复），这需要把恢复条件单独配置，ThingsBoard 告警规则的「清除条件」就是这样设计的
- **状态清理**：规则删除或设备注销时清理对应条目，或改用带过期时间的 Caffeine 缓存
- **更复杂的条件**：持续 T 分钟、连续 N 次、多设备联合判断，本质上是窗口计算，交给 Flink 的状态与定时器，而不是在这里手写

### 6、定时触发

「每天 8 点，电量低于 20% 的设备发一条提醒」由定时触发器驱动。它与遥测触发器写在同一条规则里时是「或」的关系，任一触发器到来都会对条件求值：

```java
@Scheduled(fixedDelay = 60_000)                                // 每分钟检查一次哪些定时规则到点了
public void onTick() {
    long now = System.currentTimeMillis();
    for (CompiledRule rule : cache.timerRulesDue(now)) {        // cron 的下一次时间落在上次检查与现在之间
        for (String deviceId : latest.devices()) {              // 本实例负责的那部分设备
            Map<String, Object> snapshot = latest.snapshot(deviceId);
            if (rule.scope().covers(devices.get(deviceId)) && rule.matches(snapshot)) {
                dispatcher.fire(rule, deviceId, snapshot, now);   // 定时触发每次满足都执行，不走边沿
            }
        }
    }
}
```

- 到点判断用 Spring 的 `CronExpression.parse(cron).next(上次检查时间)`，时区取触发器里的 `zone`
- 每个实例只对自己分区内的设备求值，多实例时不会重复执行；但再均衡后、设备还没上报前，本地没有它的最新值。生产上把最新值放在 Redis（每台设备一个 Hash），由一个实例（分布式锁）统一扫描；影子只放配置类状态，不放遥测读数，见 [设备影子 · 影子不是什么](./3_device_shadow#_2、影子不是什么)
- 定时触发不维护边沿：每天 8 点都满足，就每天提醒一次，这正是定时规则想要的

---

## 四、动作执行

### 1、幂等与告警收敛

Kafka 是"至少一次"投递，消费者重启、再均衡时同一条消息可能被处理两次：

| 动作 | 去重方式 | 过期时间 |
|------|---------|---------|
| 告警 | 不在这里占位：同一设备同一类型只有一条活动告警，重复触发只更新这条（见第五节） | — |
| 指令、Webhook | Redis `SET NX EX` 占位，键为 `rule:act:{请求 ID}`，请求 ID 为 `rule-{ruleId}-{deviceId}-{动作序号}-{消息时间戳}` | 1 小时，覆盖消息重投的时间窗口 |

请求 ID 由规则、设备、动作和消息时间戳确定，同一条消息重投时算出的 ID 不变，占位就能挡住重投。指令本身的 `id` 由下发服务生成、重发沿用同一个，设备再按它去重，见 [指令下发与服务调用 · 幂等：重发不等于重复执行](./4_command#_1、幂等-重发不等于重复执行)。通知的静默与收敛由告警之后的通知路由负责，不在规则里配。更多去重方案见 [幂等设计](/architecture/3_idempotence)。

### 2、执行器

```java
@Component
public class ActionDispatcher {

    private final StringRedisTemplate redis;
    private final AlarmService alarms;
    private final CommandService commands;                       // 指令下发入口，见「指令下发与服务调用」
    private final RestClient webhookClient;
    private final JsonMapper json;
    private final ExecutorService webhookPool = Executors.newVirtualThreadPerTaskExecutor();
    private final Semaphore webhookPermits = new Semaphore(50);    // 隔离：外部系统慢时最多占 50 个并发

    public ActionDispatcher(StringRedisTemplate redis, AlarmService alarms,
                            CommandService commands, RestClient webhookClient, JsonMapper json) {
        this.redis = redis;
        this.alarms = alarms;
        this.commands = commands;
        this.webhookClient = webhookClient;
        this.json = json;
    }

    public void fire(CompiledRule rule, String deviceId, Map<String, Object> metrics, long ts) {
        for (int i = 0; i < rule.actions().size(); i++) {
            String requestId = "rule-" + rule.id() + "-" + deviceId + "-" + i + "-" + ts;
            switch (rule.actions().get(i)) {
                case AlarmAction a -> alarms.open(new AlarmTrigger(
                        deviceId, a.alarmType(), a.severity(), rule.id(), metrics, ts));
                case CommandAction c -> {
                    if (acquire(requestId)) {
                        String target = c.targetDeviceId() != null ? c.targetDeviceId() : deviceId;
                        // 异步下发：命令 id 由下发服务生成，载荷 {"id","method","params"} 发到 devices/{target}/cmd
                        // （挂在网关下的子设备由下发服务改投 gateways/{gatewayId}/cmd）；操作人记为规则，便于审计
                        commands.submit(new CommandRequest(target, c.method(), json.valueToTree(c.params()),
                                c.timeout(), c.ttl()), "rule:" + rule.id());
                    }
                }
                case WebhookAction w -> {
                    if (acquire(requestId)) {
                        webhookPool.submit(() -> callWebhook(w, rule.id(), deviceId, metrics, ts));
                    }
                }
            }
        }
    }

    // recover 见三.5

    private boolean acquire(String requestId) {
        return Boolean.TRUE.equals(redis.opsForValue()
                .setIfAbsent("rule:act:" + requestId, "1", Duration.ofHours(1)));
    }

    private void callWebhook(WebhookAction w, long ruleId, String deviceId, Map<String, Object> metrics, long ts) {
        if (!webhookPermits.tryAcquire()) {
            return;                                                 // 并发已满，记录指标后放弃或进重试队列
        }
        try {
            webhookClient.post().uri(w.url())
                    .body(Map.of("ruleId", ruleId, "deviceId", deviceId, "metrics", metrics, "ts", ts))
                    .retrieve().toBodilessEntity();
        } catch (RestClientException e) {
            // 失败写入重试队列（带退避），多次失败进入死信，不阻塞规则消费
        } finally {
            webhookPermits.release();
        }
    }
}
```

- **指令只负责发出**：调用下发服务的异步接口 `submit`，落库后立即返回；设备是否收到、应答是否超时、离线时何时补发，由指令通道跟踪，见 [指令下发与服务调用](./4_command)。规则引擎不用同步调用等应答，否则一台不在线的设备就会拖住整个消费线程
- **Webhook 地址是用户配置的**：保存时校验协议与域名白名单，拒绝内网地址和元数据服务地址，防止被当作 SSRF 跳板

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

超时、重试与舱壁隔离的系统性做法见 [超时、重试与隔离](/high-avail/4_timeout_retry_bulkhead)。

### 3、消息不放进数据库事务

告警要落库，还要发通知。常见的错误写法是在 `@Transactional` 方法里先插入记录、再发 MQTT 或调用 Webhook：事务最终回滚时，消息已经发出、无法撤回；外部调用变慢时，数据库连接和行锁被一直占住。

正确做法是事务只负责写库并发布进程内事件，提交成功后再通知，五.4 的 `AlarmService` 就是这样写的。`AFTER_COMMIT` 监听器在进程崩溃时可能来不及执行；要求"写库成功就一定发出"时，改用本地消息表，由独立任务扫描投递，见 [分布式事务](/distributed/5_transaction)。

---

## 五、设备告警模型

规则产生的告警不是一条条通知，而是一个有生命周期的对象：会被确认、会被清除、同一个问题只有一条。下面以 ThingsBoard 的告警模型为主要参照。

### 1、告警的字段

| 字段 | 含义 |
|------|------|
| `originator` | 产生告警的实体：设备、网关或资产 |
| `type` | 告警类型，如 `HighTemperature`、`Offline`；与 `originator` 一起标识「同一个问题」 |
| `severity` | 严重级别，从高到低 `CRITICAL`、`MAJOR`、`MINOR`、`WARNING`、`INDETERMINATE` |
| `acknowledged`、`cleared` | 是否已确认、是否已清除，两个独立的布尔值 |
| `startTs`、`endTs` | 首次检测到的时间（取遥测时间而不是服务器处理时间）、最近一次匹配的时间 |
| `ackTs`、`clearTs` | 确认时间、清除时间 |
| `assignee` | 负责处理的人 |
| `details` | 触发时的读数、规则 ID 等，供通知模板与排查使用 |
| `propagate` | 是否沿实体关系向上传播：网关、站点、客户的视图里也能看到子设备的告警 |

华为云设备联动的「上报告警 / 恢复告警」用告警级别、告警名称、告警隔离级别三者组合标识同一条告警，恢复时三者要与上报时一致，思路相同。

### 2、四种状态

确认与清除是两个独立的维度，组合出四种状态：

| 状态 | 含义 | 典型去向 |
|------|------|---------|
| 活动、未确认 | 问题还在，没人处理 | 值班人员确认，或升级通知 |
| 活动、已确认 | 问题还在，已经有人在处理 | 条件恢复后自动清除，或人工清除 |
| 已清除、未确认 | 问题已经恢复（如设备自己好了），但没人看过 | 事后确认，用于复盘 |
| 已清除、已确认 | 闭环 | 归档 |

确认只表示「有人看到了」，不改变问题是否存在；清除表示问题已经不存在，告警记录本身保留，不删除。

### 3、五步：触发、去重、确认、清除、升级

- **触发**：规则的「不满足 → 满足」边沿调用 `open`，没有活动告警时新建一条
- **去重**：同一个 `originator` 加 `type` 任意时刻最多只有一条活动告警，再次触发只更新已有那条的 `endTs` 与 `details`；清除之后再触发，才会新建一条。这比按时间窗口静默更准确：问题没恢复就一直是同一条，恢复后再坏是新的一条
- **确认**：值班人员在页面上确认，记录确认时间和人；确认不清除告警
- **清除**：规则的「满足 → 不满足」边沿或人工调用 `clear`；没有配置自动清除时，告警只能人工清除
- **升级**：两层意思。一是严重级别升级，同一类型被更高级别的条件再次触发时，活动告警的级别只升不降；二是通知升级，活动未确认超过一定时间，通知下一级值班人，这属于通知路由

通知怎么发（按什么分组、哪些告警被根因告警抑制、计划停机时如何静默、找不到人时如何升级），与服务端告警是同一套做法，见 [告警体系](/observability/4_alerting)。告警模型只负责把「同一个问题」收敛成一条有状态的记录，再把状态变化交给通知路由。

### 4、告警表与 AlarmService

```sql
CREATE TABLE iot_alarm (
    id           BIGINT AUTO_INCREMENT PRIMARY KEY,
    originator   VARCHAR(64)  NOT NULL,
    type         VARCHAR(64)  NOT NULL,
    severity     VARCHAR(16)  NOT NULL,
    acknowledged BOOLEAN      NOT NULL DEFAULT FALSE,
    cleared      BOOLEAN      NOT NULL DEFAULT FALSE,
    start_ts     BIGINT       NOT NULL,
    end_ts       BIGINT       NOT NULL,
    ack_ts       BIGINT,
    clear_ts     BIGINT,
    assignee     VARCHAR(64),
    rule_id      BIGINT,
    details      JSON,
    active_key   VARCHAR(140),               -- 活动时为 originator:type，清除后置 NULL
    UNIQUE KEY uk_active (active_key),        -- 唯一索引允许多个 NULL：每个问题只有一条活动告警
    KEY idx_originator (originator, start_ts)
);
```

```java
public record AlarmTrigger(String originator, String type, AlarmSeverity severity,
                           long ruleId, Map<String, Object> details, long ts) {}

@Service
public class AlarmService {

    private static final String SEVERITY_ORDER = "'CRITICAL','MAJOR','MINOR','WARNING','INDETERMINATE'";

    private final JdbcClient jdbc;
    private final JsonMapper json;
    private final ApplicationEventPublisher events;

    public AlarmService(JdbcClient jdbc, JsonMapper json, ApplicationEventPublisher events) {
        this.jdbc = jdbc;
        this.json = json;
        this.events = events;
    }

    /** 触发：没有活动告警就新建；已有就更新最近时间与详情，严重级别只升不降 */
    @Transactional
    public void open(AlarmTrigger t) {
        int rows = jdbc.sql("""
                INSERT INTO iot_alarm (originator, type, severity, start_ts, end_ts, rule_id, details, active_key)
                VALUES (:originator, :type, :severity, :ts, :ts, :ruleId, :details, :activeKey) AS new
                ON DUPLICATE KEY UPDATE
                    end_ts   = GREATEST(iot_alarm.end_ts, new.end_ts),
                    details  = new.details,
                    severity = IF(FIELD(new.severity, %s) < FIELD(iot_alarm.severity, %s),
                                  new.severity, iot_alarm.severity)
                """.formatted(SEVERITY_ORDER, SEVERITY_ORDER))
                .param("originator", t.originator()).param("type", t.type())
                .param("severity", t.severity().name()).param("ts", t.ts())
                .param("ruleId", t.ruleId()).param("details", json.writeValueAsString(t.details()))
                .param("activeKey", t.originator() + ":" + t.type())
                .update();
        // MySQL：新插入返回 1，更新已有行返回 2，值没变返回 0
        if (rows > 0) {
            events.publishEvent(new AlarmChanged(t.originator(), t.type(), rows == 1 ? "CREATED" : "UPDATED"));
        }
    }

    /** 清除：条件恢复或人工操作；没有活动告警时什么也不做 */
    @Transactional
    public void clear(String originator, String type, long ts) {
        int rows = jdbc.sql("""
                UPDATE iot_alarm SET cleared = TRUE, clear_ts = :ts, active_key = NULL
                 WHERE active_key = :activeKey
                """).param("ts", ts).param("activeKey", originator + ":" + type).update();
        if (rows == 1) {
            events.publishEvent(new AlarmChanged(originator, type, "CLEARED"));
        }
    }

    /** 确认：只记录有人看过，不改变是否活动 */
    @Transactional
    public boolean ack(long alarmId, String user, long ts) {
        return jdbc.sql("""
                UPDATE iot_alarm SET acknowledged = TRUE, ack_ts = :ts, assignee = COALESCE(assignee, :user)
                 WHERE id = :id AND acknowledged = FALSE
                """).param("ts", ts).param("user", user).param("id", alarmId).update() == 1;
    }
}

@Component
class AlarmNotifier {

    private final NotificationRouter router;          // 分组、抑制、静默、升级

    AlarmNotifier(NotificationRouter router) {
        this.router = router;
    }

    @TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT)
    void onChanged(AlarmChanged e) {
        router.route(e);                               // 提交成功后才通知
    }
}
```

- **去重靠唯一索引**：`active_key` 在活动时是 `originator:type`、清除后置为 `NULL`，唯一索引保证同一个问题只有一条活动告警，并发触发也不会插出两条；`INSERT … AS new ON DUPLICATE KEY UPDATE` 用行别名引用新值，MySQL 官方已不推荐旧的 `VALUES()` 写法；PostgreSQL 用部分唯一索引（`WHERE NOT cleared`）加 `ON CONFLICT` 实现同样的效果
- **严重级别只升不降**：`FIELD` 返回级别在列表里的位置，位置越靠前越严重；降级只能通过清除后重新触发
- **告警升级的扫描**：另起一个定时任务，找出活动、未确认且 `start_ts` 早于阈值的告警，交给通知路由升级到下一级值班人
- **其他来源的告警也进这张表**：Flink 的离线检测、Grafana 的 Webhook 回调，以及设备自己经 `devices/{deviceId}/event` 上报的告警、故障事件（级别取自物模型，见 [物模型](./1_thing_model)），都调用同一个 `open` / `clear`，`type` 区分来源，这就是第二节说的「各层告警统一汇入」

---

## 六、规则缓存与热更新

每条设备消息都查一次数据库加载规则，消息量一上来数据库就成为瓶颈。规则数量通常只有几千条，适合整体加载到内存，按作用域建索引，变更时通知所有实例重新加载：

```java
@Component
public class RuleCache {

    private final RuleLoader loader;                                   // 读库并反序列化为 CompiledRule
    private volatile Map<ScopeType, Map<String, List<CompiledRule>>> index = Map.of();
    private volatile List<CompiledRule> global = List.of();
    private volatile List<CompiledRule> timerRules = List.of();

    public RuleCache(RuleLoader loader) {
        this.loader = loader;
    }

    /** 启动时立即执行；之后每 5 分钟兜底对齐一次，防止漏掉变更通知 */
    @Scheduled(fixedDelay = 300_000)
    public synchronized void reload() {
        List<CompiledRule> all = loader.loadEnabled();
        global = all.stream().filter(r -> r.scope().type() == ScopeType.ALL).toList();
        index = all.stream().filter(r -> r.scope().type() != ScopeType.ALL)
                .collect(Collectors.groupingBy(r -> r.scope().type(),
                        Collectors.groupingBy(r -> r.scope().id())));
        timerRules = all.stream()
                .filter(r -> r.triggers().stream().anyMatch(t -> t instanceof TimerTrigger)).toList();
    }

    /** 一台设备适用的规则：全局 + 所属产品 + 所在分组 + 绑定到它自己的 */
    public List<CompiledRule> rulesFor(DeviceRef d) {
        Map<ScopeType, Map<String, List<CompiledRule>>> idx = index;   // 读一次引用，避免中途被替换
        List<CompiledRule> out = new ArrayList<>(global);
        out.addAll(idx.getOrDefault(ScopeType.PRODUCT, Map.of()).getOrDefault(d.productKey(), List.of()));
        for (String group : d.groups()) {
            out.addAll(idx.getOrDefault(ScopeType.GROUP, Map.of()).getOrDefault(group, List.of()));
        }
        out.addAll(idx.getOrDefault(ScopeType.DEVICE, Map.of()).getOrDefault(d.deviceId(), List.of()));
        return out;
    }

    // timerRulesDue(now)：从 timerRules 里挑出 cron 到点的规则，见三.6
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
- 一台设备同时属于多个分组时，同一条规则不会被重复返回（一条规则只有一个作用域），但不同作用域的两条规则可能对同一设备产生同类告警，靠告警模型按 `originator` 加 `type` 合并
- Redis Pub/Sub 不保证送达，定时全量对齐作为兜底；本地缓存与通知失效的更多模式见 [两级缓存（L1 + L2）](/cache/8_two_level_cache)

---

## 七、常见坑

| 现象 | 原因 | 处理 |
|------|------|------|
| 同一故障刷出上百条告警 | 电平触发，每条命中消息都执行动作 | 边沿触发 + 同一 `originator` 加 `type` 只有一条活动告警 |
| 告警列表里全是早已恢复的条目 | 只有触发没有清除 | 恢复边沿自动清除，恢复条件留回差 |
| 设备分字段上报时告警反复恢复又触发 | 条件只对当前这条消息求值，缺测点被当成不满足 | 对合并后的最新值求值 |
| 每台新设备都要补配规则 | 规则绑定到单台设备 | 规则按产品、分组绑定 |
| 消费者重启后指令重复下发 | Kafka 至少一次投递 | 动作执行前按请求 ID 占位，设备再按指令 `id` 去重 |
| 规则服务拖垮数据库 | 每条消息都查规则表 | 内存缓存 + 变更通知 + 定时对齐 |
| 启动时报 `MultipleBagFetchException` | 两个 `List` 关联同时 `EAGER` 抓取 | 触发器、条件、动作存 JSON 列，或改 `Set` / 懒加载 |
| 告警记录回滚了，通知却发出去了 | 在事务里发消息 | `AFTER_COMMIT` 或本地消息表 |
| 第三方接口变慢，规则消费积压 | Webhook 同步调用且无超时 | 配置超时，异步执行并限制并发 |
| 用户填写的表达式执行了系统命令 | SpEL 使用了 `StandardEvaluationContext` | 结构化条件，或 CEL、`SimpleEvaluationContext`、开启沙箱的 Aviator |

---

## 小结

- 主流平台的规则分三类：SQL 式数据流转（AWS IoT Rules、EMQX、华为云数据转发、Azure 消息路由）、流程与脚本式（ThingsBoard 规则链、阿里云新版云产品流转）、触发-条件-动作（阿里云场景联动、华为云设备联动、ThingsBoard 告警规则），共性都是数据源、条件、动作
- 简单过滤与转发交给 EMQX 规则，窗口类规则交给 Flink，已入库数据的阈值与趋势交给 Grafana，与业务紧密相关的判断和动作由触发-条件-动作引擎完成；同一个告警只在一层产生
- 自己实现的引擎：规则按产品、分组绑定，触发器之间为或、条件之间为与，支持定时触发；条件对最新值快照求值，「不满足 → 满足」执行动作，「满足 → 不满足」清除告警
- 告警是有状态的对象：同一 `originator` 加 `type` 只有一条活动告警，确认与清除两个维度组合出四种状态，严重级别只升不降；通知的分组、抑制、静默交给告警体系
- 指令与 Webhook 按确定的请求 ID 占位去重，指令的下发结果由指令通道跟踪；Webhook 配超时、限并发、失败重试，地址做 SSRF 校验
- 数据库事务里不发消息，提交后再通知；规则整体缓存在内存并按作用域建索引，变更通过 Redis Pub/Sub 通知并定时兜底对齐
- 本篇讲的是通用设计；配套仓库 Conduit IoT 的实现篇计划在平台实战一组补充，目前见 [平台实战概览](../4_practice/0_intro)

## 参考资料

- AWS IoT 规则（组成与创建）：[https://docs.aws.amazon.com/iot/latest/developerguide/iot-create-rule.html](https://docs.aws.amazon.com/iot/latest/developerguide/iot-create-rule.html)
- AWS IoT 规则动作：[https://docs.aws.amazon.com/iot/latest/developerguide/iot-rule-actions.html](https://docs.aws.amazon.com/iot/latest/developerguide/iot-rule-actions.html)
- EMQX 规则引擎：[https://docs.emqx.com/en/emqx/latest/data-integration/rules.html](https://docs.emqx.com/en/emqx/latest/data-integration/rules.html)
- EMQX 规则 SQL 事件与字段：[https://docs.emqx.com/en/emqx/latest/data-integration/rule-sql-events-and-fields.html](https://docs.emqx.com/en/emqx/latest/data-integration/rule-sql-events-and-fields.html)
- EMQX Flow Designer：[https://docs.emqx.com/en/emqx/latest/flow-designer/introduction.html](https://docs.emqx.com/en/emqx/latest/flow-designer/introduction.html)
- 华为云 IoTDA 规则引擎概述：[https://support.huaweicloud.com/usermanual-iothub/iot_01_0022.html](https://support.huaweicloud.com/usermanual-iothub/iot_01_0022.html)
- 华为云 IoTDA 设备联动：[https://support.huaweicloud.com/usermanual-iothub/iot_01_0023.html](https://support.huaweicloud.com/usermanual-iothub/iot_01_0023.html)
- 华为云 IoTDA 数据转发：[https://support.huaweicloud.com/usermanual-iothub/iot_01_0024.html](https://support.huaweicloud.com/usermanual-iothub/iot_01_0024.html)
- Azure IoT Hub 消息路由：[https://learn.microsoft.com/en-us/azure/iot-hub/iot-hub-devguide-messages-d2c](https://learn.microsoft.com/en-us/azure/iot-hub/iot-hub-devguide-messages-d2c)
- Azure IoT Hub 路由查询语法：[https://learn.microsoft.com/en-us/azure/iot-hub/iot-hub-devguide-routing-query-syntax](https://learn.microsoft.com/en-us/azure/iot-hub/iot-hub-devguide-routing-query-syntax)
- ThingsBoard 规则引擎概览：[https://thingsboard.io/docs/user-guide/rule-engine-2-0/overview/](https://thingsboard.io/docs/user-guide/rule-engine-2-0/overview/)
- ThingsBoard 告警：[https://thingsboard.io/docs/user-guide/alarms/](https://thingsboard.io/docs/user-guide/alarms/)
- ThingsBoard 告警规则：[https://thingsboard.io/docs/user-guide/alarm-rules/](https://thingsboard.io/docs/user-guide/alarm-rules/)
- ThingsBoard 4.3 发布说明：[https://thingsboard.io/docs/releases/releases-table/v4-3-x/](https://thingsboard.io/docs/releases/releases-table/v4-3-x/)
- 阿里云新版云产品流转（文档已标注停止维护，下同）：[https://help.aliyun.com/zh/iot/user-guide/data-forwarding-v2-overview](https://help.aliyun.com/zh/iot/user-guide/data-forwarding-v2-overview)
- 阿里云场景联动：[https://help.aliyun.com/document_detail/102241.html](https://help.aliyun.com/document_detail/102241.html)
- Spring Expression Language（SimpleEvaluationContext）：[https://docs.spring.io/spring-framework/reference/core/expressions/evaluation.html](https://docs.spring.io/spring-framework/reference/core/expressions/evaluation.html)
- AviatorScript：[https://github.com/killme2008/aviatorscript](https://github.com/killme2008/aviatorscript)
- QLExpress：[https://github.com/alibaba/QLExpress](https://github.com/alibaba/QLExpress)
- cel-java：[https://github.com/google/cel-java](https://github.com/google/cel-java)
- CEL 规范：[https://github.com/google/cel-spec](https://github.com/google/cel-spec)
- Apache KIE Drools：[https://github.com/apache/incubator-kie-drools](https://github.com/apache/incubator-kie-drools)
- Easy Rules（维护模式说明）：[https://github.com/j-easy/easy-rules](https://github.com/j-easy/easy-rules)
- Flink CEP：[https://nightlies.apache.org/flink/flink-docs-release-2.2/docs/libs/cep/](https://nightlies.apache.org/flink/flink-docs-release-2.2/docs/libs/cep/)
- MySQL INSERT … ON DUPLICATE KEY UPDATE：[https://dev.mysql.com/doc/refman/8.4/en/insert-on-duplicate.html](https://dev.mysql.com/doc/refman/8.4/en/insert-on-duplicate.html)
- Spring Framework 事务绑定事件：[https://docs.spring.io/spring-framework/reference/data-access/transaction/event.html](https://docs.spring.io/spring-framework/reference/data-access/transaction/event.html)
- Spring Framework REST Clients（RestClient）：[https://docs.spring.io/spring-framework/reference/integration/rest-clients.html](https://docs.spring.io/spring-framework/reference/integration/rest-clients.html)

> 下一篇：[平台实战概览](../4_practice/0_intro)
