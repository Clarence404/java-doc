---
description: SHA-256 与 Ed25519 / ECDSA 签名、防回滚、A/B 分区与自动回退、断点续传、分批灰度、任务状态机
---

# OTA 升级

> 前置阅读：[设备安全](./5_security)、[MQTT 客户端](./6_mqtt_client)

OTA（Over-The-Air）是设备部署后修复漏洞、增加功能的唯一途径，也是风险最高的操作：坏固件可能让成千上万台设备同时变砖，被篡改的固件等于给攻击者开了后门。本篇是站内 OTA 安全的主文档，讲固件签名、版本防回滚、A/B 分区与分批灰度，代码基线为 JDK 21、Spring Boot 4.x，设备侧以 MCUboot 这类安全启动方案为参照。

---

## 一、风险与整体流程

### 1、要防住的四类问题

| 风险 | 后果 | 对策 |
|------|------|------|
| 固件被篡改或伪造 | 设备运行恶意代码 | SHA-256 摘要 + 私钥签名，设备用内置公钥验签 |
| 被降级到有漏洞的旧版本 | 已修复的漏洞重新可被利用 | 安全版本计数器，只增不减 |
| 升级中断电、新固件起不来 | 设备变砖，需要现场返修 | A/B 分区 + 试运行确认，失败自动回退 |
| 全量推送出问题 | 大面积故障，带宽被打满 | 分批灰度、失败率熔断、下发限速 |

### 2、流程

![OTA 升级全流程](../assets/iot/ota-flow.svg)

平台侧：构建产物计算 SHA-256 并签名，上传对象存储，按灰度批次通过 MQTT 下发任务。设备侧：用 HTTP Range 断点续传下载，校验摘要、签名和版本，写入备用分区后切换启动槽，重启试运行，自检通过后确认，否则回滚，最后上报结果。

---

## 二、固件签名

### 1、MD5 不是签名

旧方案常把固件的 MD5 随升级指令一起下发，设备下载后比对 MD5。这只能发现传输损坏，挡不住篡改：能替换固件的人同样能重新计算 MD5，而且 MD5 已经可以构造碰撞。HTTPS 也不能替代签名，它只保护传输过程，挡不住对象存储被入侵、构建机被投毒这类源头问题。

**正确做法：用 SHA-256 计算摘要，用私钥对包含摘要的清单签名；设备出厂时内置公钥，验签通过才安装。** 私钥只存在于签名服务（KMS / HSM）中，不进代码仓库，也不出现在任何设备上。

| 算法 | JDK 中的名称 | 特点 |
|------|------------|------|
| Ed25519 | `Ed25519`（JDK 15 起内置） | 签名 64 字节，实现简单、不依赖随机数质量，新项目首选 |
| ECDSA P-256 | `SHA256withECDSA` | 硬件安全芯片、MCU 加速器支持最广 |
| RSA-PSS 3072 | `RSASSA-PSS` | 签名和公钥较大，资源紧张的设备不推荐 |

### 2、清单与签名代码

签名对象是一份固件清单，而不是下载地址。预签名 URL 每次都会变，不能放进签名原文。

```java
import java.nio.charset.StandardCharsets;

public record FirmwareManifest(
        String model,            // 适用型号，防止刷到别的硬件上
        String version,          // 展示用版本号，如 2.1.0
        int securityVersion,     // 防回滚计数器，见第三节
        long size,
        String sha256) {

    /** 签名原文：字段顺序固定，避免不同 JSON 序列化方式导致验签失败 */
    public byte[] signingBytes() {
        return String.join("\n", model, version, Integer.toString(securityVersion),
                Long.toString(size), sha256).getBytes(StandardCharsets.UTF_8);
    }
}
```

```java
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.*;
import java.util.HexFormat;

public final class FirmwareSigner {

    /** 流式计算 SHA-256，固件再大也不会整块读进内存 */
    public static String sha256Hex(Path firmware) throws Exception {
        MessageDigest md = MessageDigest.getInstance("SHA-256");
        try (InputStream in = new DigestInputStream(Files.newInputStream(firmware), md)) {
            in.transferTo(OutputStream.nullOutputStream());
        }
        return HexFormat.of().formatHex(md.digest());
    }

    public static byte[] sign(FirmwareManifest manifest, PrivateKey key) throws GeneralSecurityException {
        Signature signer = Signature.getInstance("Ed25519");   // ECDSA 用 "SHA256withECDSA"
        signer.initSign(key);
        signer.update(manifest.signingBytes());
        return signer.sign();
    }

    /** 服务端发布前自检；设备侧用同样的原文和内置公钥验签 */
    public static boolean verify(FirmwareManifest manifest, byte[] signature, PublicKey key)
            throws GeneralSecurityException {
        Signature verifier = Signature.getInstance("Ed25519");
        verifier.initVerify(key);
        verifier.update(manifest.signingBytes());
        return verifier.verify(signature);
    }
}
```

生产环境里 `sign` 这一步交给 KMS 的签名接口或 HSM 完成，CI 流水线只拿到签名结果；上面的代码用于本地测试和发布前自检。

### 3、设备侧校验顺序

1. 检查清单中的 `model` 与本机型号一致
2. 用内置公钥验证清单签名，失败直接丢弃任务
3. 检查 `securityVersion` 不小于设备本地记录的值
4. 下载完成后计算固件 SHA-256，与清单中的 `sha256` 比对，且文件大小一致
5. 全部通过才写入备用分区

公钥本身的可信度依赖安全启动链：Bootloader 也要校验应用固件签名，否则攻击者绕过 OTA 流程直接刷写 Flash 就能跳过校验。证书与密钥的出厂烧录见 [设备安全](./5_security)。

---

## 三、防回滚与 A/B 分区

### 1、防回滚

降级攻击的思路是：把设备刷回一个签名合法、但存在已知漏洞的旧版本。签名挡不住它，因为旧版本当年确实是官方签的。

- **安全版本计数器**：每个固件带一个 `securityVersion`，修复安全漏洞时才递增；设备把已安装的最大值保存在只增不减的存储（eFuse、安全芯片的单调计数器、受保护的 Flash 区）中，低于该值的固件一律拒绝
- **与展示版本分离**：功能版本 2.1.0 → 2.1.1 可以不改计数器，这样业务上仍可回退到同一安全等级的上一个版本
- **计数器何时提升**：在新固件试运行确认成功之后再写入，否则新固件起不来时也无法回退

MCUboot 提供两种实现：软件方式比较镜像版本号，硬件方式比较镜像中受保护的安全计数器与可信存储里的值。

### 2、A/B 分区

| 方案 | 做法 | 升级失败时 |
|------|------|-----------|
| 单分区覆盖 | 新固件直接覆盖当前固件 | 写到一半断电就变砖，只适合有恢复模式的设备 |
| A/B 双分区 | 新固件写入非活动分区，校验后切换启动槽 | Bootloader 回到旧分区启动 |
| 恢复分区 | 保留一个最小可用的恢复系统 | 进入恢复系统重新下载 |

A/B 方案的关键是"试运行 + 确认"：

1. 新固件写入 B 分区，标记为"待测试"，重启
2. Bootloader 从 B 启动；新固件完成自检（能联网、能连上 Broker、关键外设正常）后，主动把自己标记为"已确认"
3. 如果新固件崩溃、看门狗复位或在限定时间内没有确认，下次启动时 Bootloader 自动回到 A 分区
4. 设备回到 A 后上报 `ROLLED_BACK` 和原因

MCUboot 的 swap 模式就是这样工作的：测试性交换后，若新镜像没有被标记为已确认，下次启动会执行回退交换。

---

## 四、下载：预签名 URL 与断点续传

- **预签名 URL**：固件放在对象存储的私有桶里，下发任务时生成有效期较短（如 1 小时）的预签名下载地址，链接泄露也很快失效，见 [对象存储](/architecture/4_object_storage)
- **断点续传**：设备把已下载的字节数持久化，重连后用 `Range: bytes={已下载}-` 继续下载，服务端返回 `206 Partial Content`；蜂窝网络、NB-IoT 场景下这是刚需
- **全部下载完再校验**：分段下载时不能边下边装，必须整包 SHA-256 校验通过后才进入安装
- **差分升级**：带宽昂贵时只下发新旧版本的差分包，设备在本地合成新固件；合成后的结果同样要做整包摘要校验
- **下载限流**：大批设备同时下载会打满源站带宽，固件通过 CDN 分发，并配合第五节的下发限速

---

## 五、任务编排与灰度

### 1、分批灰度

| 批次 | 范围 | 进入下一批的条件 |
|------|------|----------------|
| 1 | 内部测试设备 + 1% 线上设备 | 成功率 ≥ 99%，观察 24 小时无异常告警 |
| 2 | 10% | 同上 |
| 3 | 50% | 同上 |
| 4 | 全量 | — |

- **失败率熔断**：当前批次失败或回滚比例超过阈值（如 2%）时自动暂停整个升级活动，等人工确认
- **下发限速**：调度器每个周期只下发固定数量的任务（如每分钟 200 台），避免下载洪峰
- **下发前置条件**：设备在线、电量高于阈值、不在业务使用中（如充电桩没有在充电），不满足的跳过，下一轮再试
- **按维度挑选**：先挑固件版本、地区、硬件批次覆盖面广的设备，问题能更早暴露

### 2、任务状态机

```java
public enum OtaStatus {
    PENDING, NOTIFIED, DOWNLOADING, VERIFYING, INSTALLING, SUCCESS, FAILED, ROLLED_BACK, TIMEOUT;

    /** 允许流转到当前状态的前置状态 */
    public Set<OtaStatus> allowedFrom() {
        return switch (this) {
            case PENDING -> Set.of();
            case NOTIFIED -> Set.of(PENDING);
            case DOWNLOADING -> Set.of(NOTIFIED);
            case VERIFYING -> Set.of(DOWNLOADING);
            case INSTALLING -> Set.of(VERIFYING);
            case SUCCESS, ROLLED_BACK -> Set.of(INSTALLING);
            case FAILED, TIMEOUT -> Set.of(NOTIFIED, DOWNLOADING, VERIFYING, INSTALLING);
        };
    }
}
```

状态更新用条件更新一次完成"检查 + 修改"，天然防并发、防乱序、防重复：

```java
public interface OtaTaskRepository extends JpaRepository<OtaTask, Long> {

    @Transactional          // 调度器在事务外调用，修改类查询需要自带事务
    @Modifying
    @Query("""
            update OtaTask t
               set t.status = :to, t.failReason = :reason, t.updatedAt = CURRENT_TIMESTAMP
             where t.id = :id and t.deviceId = :deviceId and t.status in :from
            """)
    int transition(Long id, String deviceId, OtaStatus to, Set<OtaStatus> from, String reason);
}
```

`deviceId` 也作为条件，防止设备伪造别人的 `taskId` 改写任务。上报 `SUCCESS` 时要求设备带上当前运行的版本号，与任务的目标版本比对后才算成功。

### 3、状态上报处理

```java
public record OtaStatusReport(long taskId, OtaStatus status, String runningVersion, String reason) {}

@Component
public class OtaStatusHandler {

    private static final Logger log = LoggerFactory.getLogger(OtaStatusHandler.class);

    private final OtaTaskRepository tasks;
    private final JsonMapper json;

    public OtaStatusHandler(OtaTaskRepository tasks, JsonMapper json) {
        this.tasks = tasks;
        this.json = json;
    }

    @Transactional
    @ServiceActivator(inputChannel = "otaStatusChannel")    // 路由配置见 MQTT 客户端一篇
    public void handle(@Header(MqttHeaders.RECEIVED_TOPIC) String topic, byte[] payload) {
        String deviceId = topic.split("/")[1];              // devices/{deviceId}/ota/status
        OtaStatusReport report = json.readValue(payload, OtaStatusReport.class);
        int updated = tasks.transition(report.taskId(), deviceId, report.status(),
                report.status().allowedFrom(), report.reason());
        if (updated == 0) {
            // 重复上报、乱序到达或非法流转，记录后忽略，不抛异常
            log.info("忽略 OTA 状态 device={} task={} status={}", deviceId, report.taskId(), report.status());
        }
    }
}
```

### 4、调度下发：消息不放进数据库事务

```java
@Component
public class OtaDispatcher {

    private final OtaTaskRepository tasks;
    private final OtaCommandFactory commands;   // 组装清单、签名、预签名 URL
    private final MqttGateway mqtt;

    public OtaDispatcher(OtaTaskRepository tasks, OtaCommandFactory commands, MqttGateway mqtt) {
        this.tasks = tasks;
        this.commands = commands;
        this.mqtt = mqtt;
    }

    @Scheduled(fixedDelay = 10_000)
    public void dispatch() {
        // 只取正在进行的批次中、满足前置条件的设备，每轮最多 50 台（限速）
        for (OtaTask task : tasks.findDispatchable(50)) {
            mqtt.publish("devices/" + task.getDeviceId() + "/ota/command", 1, commands.build(task));
            tasks.transition(task.getId(), task.getDeviceId(), OtaStatus.NOTIFIED,
                    OtaStatus.NOTIFIED.allowedFrom(), null);
        }
    }
}
```

- 创建升级活动的接口只写库（活动 + 批次 + 任务，同一事务），立刻返回；真正下发由调度器异步完成，HTTP 请求不会因为设备数量多而超时
- MQTT 发送不放在数据库事务里：事务回滚时消息已经发出、无法撤回；这里先发消息再条件更新，进程在两步之间崩溃时下一轮会重发，设备按 `taskId` 去重即可。需要严格保证"写库与发消息一致"时用本地消息表，见 [分布式事务](/distributed/4_transaction)
- 另起一个定时任务扫描长时间停在中间状态的任务，标记为 `TIMEOUT`，计入批次失败率
- 多实例部署时调度器只能有一个在跑，用分布式锁或调度框架保证，见 [分布式调度](/distributed/6_job_scheduler)

---

## 六、常见坑

| 现象 | 原因 | 处理 |
|------|------|------|
| 被替换的固件也通过了校验 | 只校验 MD5 或只依赖 HTTPS | 摘要 + 私钥签名，设备内置公钥验签 |
| 设备被刷回旧漏洞版本 | 只比较展示版本号，或根本不比较 | 安全版本计数器写入只增不减的存储 |
| 升级后大量设备离线 | 单分区覆盖，新固件起不来 | A/B 分区 + 试运行确认 + 自动回退 |
| 升级一开始源站带宽打满 | 全量同时下发 | 分批灰度、下发限速、CDN 分发 |
| 任务状态错乱 | 先查再改，乱序上报覆盖了终态 | 条件更新，非法流转直接忽略 |
| 下发失败但任务显示已通知 | 先改状态后发消息，或在事务里发消息 | 发送成功后再条件更新，设备按 `taskId` 去重 |

---

## 小结

- 固件安全的基础是 SHA-256 摘要 + Ed25519 / ECDSA 签名，私钥放在 KMS / HSM，设备内置公钥并由安全启动链保护；MD5 和 HTTPS 都不能替代签名
- 防回滚靠只增不减的安全版本计数器，确认新固件运行正常后才提升
- A/B 分区 + 试运行确认让升级失败时自动回退，设备回到旧分区后上报原因
- 下载用短时效预签名 URL 和 HTTP Range 断点续传，整包校验通过才安装
- 升级活动按批次灰度，失败率超阈值自动暂停；任务状态用条件更新推进，MQTT 发送不放进数据库事务

## 参考资料

- MCUboot 设计文档（签名、防降级、swap 与回退）：[https://docs.mcuboot.com/design.html](https://docs.mcuboot.com/design.html)
- Java Security Standard Algorithm Names（Ed25519、SHA256withECDSA）：[https://docs.oracle.com/en/java/javase/21/docs/specs/security/standard-names.html](https://docs.oracle.com/en/java/javase/21/docs/specs/security/standard-names.html)
- RFC 8032 Edwards-Curve Digital Signature Algorithm (EdDSA)：[https://www.rfc-editor.org/rfc/rfc8032](https://www.rfc-editor.org/rfc/rfc8032)
- RFC 9110 HTTP Semantics（Range 请求）：[https://www.rfc-editor.org/rfc/rfc9110#name-range-requests](https://www.rfc-editor.org/rfc/rfc9110#name-range-requests)

> 下一篇：[规则引擎](./11_rule_engine)
