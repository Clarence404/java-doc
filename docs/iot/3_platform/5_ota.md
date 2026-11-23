---
description: 固件签名与清单格式对照、密钥轮换、防回滚与 A/B 分区、断点续传、Job 两层模型与灰度、任务状态机
---

# OTA 升级

> 前置阅读：[设备安全](../2_access/1_security)、[MQTT 客户端](../2_access/3_mqtt_client)

OTA（Over-The-Air）是设备部署后修复漏洞、增加功能的唯一途径，也是风险最高的操作。本篇讲固件签名与清单格式、密钥轮换、防回滚与 A/B 分区、升级任务的两层模型与灰度，基线为 JDK 21、Spring Boot 4。

---

## 一、风险与整体流程

坏固件可能让成千上万台设备同时变砖，被篡改的固件等于给攻击者开了后门。本篇是站内 OTA 安全的主文档，设备侧以 MCUboot 这类 MCU 安全启动方案为参照。跑 Linux 的设备（网关、工控机、摄像头）主流做法是 A/B 双根文件系统加整包签名，现成方案有三个：Mender 内置 A/B 双分区与启动失败回滚，RAUC 采用对称的 A/B 根文件系统并强制要求升级包签名，SWUpdate 支持双副本或「单副本加救援系统」并对描述文件签名、逐镜像校验哈希。它们的原理与本篇一致，下文不分别展开。

### 1、要防住的四类问题

| 风险 | 后果 | 对策 |
|------|------|------|
| 固件被篡改或伪造 | 设备运行恶意代码 | SHA-256 摘要 + 私钥签名，设备用内置公钥验签 |
| 被降级到有漏洞的旧版本 | 已修复的漏洞重新可被利用 | 安全版本计数器，只增不减 |
| 升级中断电、新固件起不来 | 设备变砖，需要现场返修 | A/B 分区 + 试运行确认，失败自动回退 |
| 全量推送出问题 | 大面积故障，带宽被打满 | 分批灰度、失败率熔断、下发限速 |

### 2、流程

![OTA 升级全流程](../../assets/iot/ota-flow.svg)

平台侧：构建产物计算 SHA-256 并签名，上传对象存储，按灰度批次通过 MQTT 下发任务。设备侧：用 HTTP Range 断点续传下载，校验摘要、签名和版本，写入备用分区后切换启动槽，重启试运行，自检通过后确认，否则回滚，最后上报结果。

---

## 二、固件签名

### 1、MD5 不是签名

旧方案常把固件的 MD5 随升级指令一起下发，设备下载后比对 MD5。这只能发现传输损坏，挡不住篡改：能替换固件的人同样能重新计算 MD5，而且 MD5 已经可以构造碰撞。HTTPS 也不能替代签名，它只保护传输过程，挡不住对象存储被入侵、构建机被投毒这类源头问题。

**正确做法：用 SHA-256 计算摘要，用私钥对包含摘要的清单签名；设备出厂时内置公钥，验签通过才安装。** 私钥只存在于签名服务（KMS / HSM）中，不进代码仓库，也不出现在任何设备上。

| 算法 | JDK 中的名称 | 特点 |
|------|------------|------|
| ECDSA P-256 | `SHA256withECDSA` | 工具链支持最广：MCUboot、Mender 的制品签名都支持，FreeRTOS OTA 的 Windows 模拟器要求的也是 ECDSA P-256 加 SHA-256 的代码签名证书；硬件安全芯片、MCU 加速器普遍支持，默认选它 |
| Ed25519 | `Ed25519`（JDK 15 起内置） | 签名 64 字节，实现简单、不依赖随机数质量；MCUboot 支持，但 Mender 的制品签名只列了 RSA 与 ECDSA P-256，设备启动链与打包工具都支持时再选用 |
| RSA 3072 | `RSASSA-PSS` | 签名和公钥较大，资源紧张的设备不推荐；MCUboot 用 RSA-PSS（2048 或 3072 位），Mender 用 PKCS#1 v1.5 并建议密钥不短于 3072 位 |

### 2、清单与签名代码

签名对象是一份固件清单，而不是下载地址。预签名 URL 每次都会变，不能放进签名原文。清单长什么样，业界有几种现成格式：

| 格式 | 载体 | 签名与摘要 | 清单里有什么 |
|------|------|-----------|-------------|
| IETF SUIT | CBOR 编码的清单 | COSE 签名块，签的是清单摘要 | 厂商与型号标识条件、镜像摘要、单调递增的序列号（防回滚）、安装步骤 |
| TUF targets 元数据 | JSON | targets 角色的密钥签名，可要求多把密钥达到门限 | 每个目标文件的长度与哈希、可选的自定义字段；另有 root、snapshot、timestamp 三份元数据 |
| Mender Artifact | tar 归档 | `manifest` 记录头、版本与数据文件的校验和，签名放在 `manifest.sig` | `version`、`manifest`、`manifest.sig`、`header`、`data` |
| MCUboot 镜像 | 镜像头加尾部 TLV 区 | 对镜像哈希签名 | TLV：SHA-256 哈希、公钥哈希、签名（RSA-PSS、ECDSA、Ed25519）、安全计数器 |
| AWS IoT Jobs 加代码签名 | JSON 任务文档 | 文件用 Code Signing for AWS IoT 或自己的签名工具签 | 任务文档内容自定；下载地址写成 `${aws:iot:s3-presigned-url-v2:…}` 占位符，由平台替换成预签名 URL |
| 阿里云 OTA | 升级通知 JSON | 默认只有摘要：`sign` 加 `signMethod`（MD5 或 SHA256）；开启安全升级后多一个 `digestsign`，设备用平台提供的公钥验证 | 版本、大小、下载地址、摘要 |

阿里云物联网平台自 2025 年 2 月起停止新购、文档已标为停止维护，本篇各表里的阿里云只作为国内常见做法的参照。SUIT 的架构（RFC 9019）与信息模型（RFC 9124）已经发布，清单格式本身（draft-ietf-suit-manifest）截至 2026-11 仍在 RFC 编辑队列里，还没有 RFC 编号。

**本篇示例是教学用的简化格式**：只保留型号、版本、安全版本、大小、摘要五个字段，签名原文是按固定顺序拼接的文本。它对应 SUIT 里的型号条件、序列号与镜像摘要，没有 CBOR 编码、多组件、依赖与安装步骤。真做产品时，MCU 直接用 MCUboot 的镜像格式，Linux 设备用 Mender、RAUC 或 SWUpdate 的包格式，需要跨厂商互通再看 SUIT。

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
        Signature signer = Signature.getInstance("SHA256withECDSA");   // P-256 密钥；Ed25519 用 "Ed25519"
        signer.initSign(key);
        signer.update(manifest.signingBytes());
        return signer.sign();
    }

    /** 服务端发布前自检；设备侧用同样的原文和内置公钥验签 */
    public static boolean verify(FirmwareManifest manifest, byte[] signature, PublicKey key)
            throws GeneralSecurityException {
        Signature verifier = Signature.getInstance("SHA256withECDSA");
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

公钥本身的可信度依赖安全启动链：Bootloader 也要校验应用固件签名，否则攻击者绕过 OTA 流程直接刷写 Flash 就能跳过校验。证书与密钥的出厂烧录见 [设备安全](../2_access/1_security)。

### 4、密钥轮换与分权

只有一把签名密钥、公钥又烧死在设备里时，密钥一旦泄露就无法补救：攻击者能签任何固件，设备也没有办法换掉公钥。TUF（The Update Framework）的做法是把一把密钥拆成四个角色，各签各的元数据：

| 角色 | 签什么 | 密钥怎么放 |
|------|--------|-----------|
| root | 其余角色各自信任哪些公钥、要几把签名才算数 | 离线保存，多人分持，极少动用 |
| targets | 哪些文件可信：每个文件的长度与哈希 | 发布流程使用，可以再委托给各产品线 |
| snapshot | 当前所有 targets 元数据的版本，防止新旧元数据被拼在一起 | 在线 |
| timestamp | 带时间戳的 snapshot 哈希，有效期很短，防止设备被「冻」在旧版本 | 在线，自动签发 |

- **门限签名**：一个角色可以要求多把密钥里至少若干把都签了才有效，单把密钥泄露不足以发布固件
- **轮换与吊销**：更换任何角色的密钥，都是由 root 角色发布一份新的 root 元数据。新版本要同时得到旧 root 里达到门限的密钥、和新 root 自己列出的达到门限的密钥签名，设备沿 root 版本逐级验证后切换信任，被吊销的密钥从此不再被接受
- **Uptane**（当前标准 2.1.0）在 TUF 之上为车载场景拆出两个仓库：Image 仓库存放镜像及其元数据，Director 仓库按需为每辆车签发「这一台该装哪些镜像」的元数据；设备两边都要验证
- **落到一般 IoT 项目**：设备里内置的是根公钥，日常签固件的密钥由根密钥授权、可以更换；根密钥离线并多人分持，日常签名密钥放在 KMS / HSM；清单带有效期或由短有效期的在线签名兜住，防止旧清单被重放；上线前把「换一次签名密钥」完整演练一遍

---

## 三、防回滚与 A/B 分区

### 1、防回滚

降级攻击的思路是：把设备刷回一个签名合法、但存在已知漏洞的旧版本。签名挡不住它，因为旧版本当年确实是官方签的。

- **安全版本计数器**：每个固件带一个 `securityVersion`，修复安全漏洞时才递增；设备把已安装的最大值保存在只增不减的存储（eFuse、安全芯片的单调计数器、受保护的 Flash 区）中，低于该值的固件一律拒绝
- **与展示版本分离**：功能版本 2.1.0 → 2.1.1 可以不改计数器，这样业务上仍可回退到同一安全等级的上一个版本
- **计数器何时提升**：在新固件试运行确认成功之后再写入，否则新固件起不来时也无法回退

MCUboot 提供两种实现，适用的升级策略不同：

| 方式 | 配置项 | 比较什么 | 限制 |
|------|--------|---------|------|
| 软件方式 | `MCUBOOT_DOWNGRADE_PREVENTION` | 镜像头里的版本号 | 只在覆盖式升级（`MCUBOOT_OVERWRITE_ONLY`）下可用 |
| 硬件方式 | `MCUBOOT_HW_ROLLBACK_PROT` | 镜像受保护 TLV 区里的安全计数器，与可信非易失存储里的当前值 | 需要硬件提供可信的计数器存储 |

覆盖式升级没有回退，下一小节的「试运行 + 确认」用的是 swap 模式；swap 模式下软件方式不可用，要防回滚只能用硬件安全计数器。

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

- **预签名 URL**：固件放在对象存储的私有桶里，下发任务时生成有效期较短（如 1 小时）的预签名下载地址，链接泄露也很快失效，见 [对象存储](/architecture/5_object_storage)
- **断点续传**：设备把已下载的字节数持久化，重连后用 `Range: bytes={已下载}-` 继续下载，服务端返回 `206 Partial Content`；蜂窝网络、NB-IoT 场景下这是刚需
- **全部下载完再校验**：分段下载时不能边下边装，必须整包 SHA-256 校验通过后才进入安装
- **差分升级**：带宽昂贵时只下发新旧版本的差分包，设备在本地合成新固件；合成后的结果同样要做整包摘要校验
- **下载限流**：大批设备同时下载会打满源站带宽，固件通过 CDN 分发，并配合第五节的下发限速

---

## 五、任务编排与灰度

### 1、两层模型：活动与设备任务

各家平台的升级编排都是两层：上层是一次升级的定义，下层是它在每台设备上的执行记录。

| 层 | 是什么 | 各家叫法 |
|----|--------|---------|
| 活动（Job） | 一次升级的定义：目标固件、目标设备、下发节奏、中止条件 | AWS IoT 的 Job、hawkBit 的 Rollout、阿里云的升级批次 |
| 设备任务（Execution） | 活动落到某一台设备上的执行记录，有自己的状态机 | AWS IoT 的 Job Execution、hawkBit 的 Action |

活动这一层可以抽象成五个要素，换个平台只是参数名不同：

| 要素 | 含义 | 对照 |
|------|------|------|
| 目标选择 | 按分组、标签或查询条件选设备；创建时定死，或之后满足条件的设备自动加入 | AWS 的 snapshot 与 continuous 两种 Job；阿里云的静态升级与动态升级 |
| 下发节奏 | 每分钟通知多少台、是否逐步加速，或分成几组逐组放行 | AWS 的 `maximumPerMinute` 与 `exponentialRate`；hawkBit 按分组级联，前一组成功比例达标才放下一组 |
| 中止条件 | 失败、拒绝、超时的比例超过阈值就取消整个活动 | AWS 的中止配置（`failureType`、`thresholdPercentage`、`minNumberOfExecutedThings`）；hawkBit 的错误阈值触发整个 Rollout 紧急停止 |
| 超时与重试 | 设备任务停在进行中多久算超时，失败或超时后自动重试几次 | AWS 的 `inProgressTimeoutInMinutes`（1 分钟到 7 天），重试最多 10 次 |
| 时间窗口 | 何时开始、何时结束、只在维护窗口内下发 | AWS 的 SchedulingConfig：`startTime`、`endTime`、`endBehavior`、`maintenanceWindows`（维护窗口只对 continuous Job 生效） |

这个模型不只用于 OTA。批量改配置、批量下发指令同样是「选一批设备、按节奏下发、盯失败率、随时能停」，AWS IoT Jobs 的任务文档内容就是自定义的，升级固件只是其中一种用法。单条指令怎么下发、怎么等应答，见 [指令下发与服务调用](./4_command)。

### 2、分批灰度

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

主流平台在这之上还有四种做法，按需补上：

| 做法 | 解决什么 | 对照 |
|------|---------|------|
| 静态与动态批次 | 静态只升级创建时满足条件的设备；动态持续监测目标范围，之后新激活或新满足条件的设备自动升级，适合仓库里带着旧固件出厂的设备 | 阿里云的静态升级与动态升级；AWS 的 snapshot 与 continuous Job |
| 设备拉取模式 | 电池供电、NB-IoT 这类不常在线的设备推送不到，改由设备上线后主动问「有没有我的任务」 | hawkBit 的 DDI 接口基于 HTTP 轮询；AWS 设备向 `$aws/things/{thingName}/jobs/start-next` 发布请求，领取下一个待执行任务 |
| 维护窗口与定时 | 只在夜间或停产时段下发，到点自动停止 | AWS 的 SchedulingConfig |
| 批量前先验证 | 升级包先在少量设备上验证通过，才允许发起批量升级 | 阿里云新增升级包时可以选「需要平台验证」，选了就必须先验证 |

本篇示例是平台推送。要支持拉取，只需让设备上线后发一条查询请求，平台从任务表里取出这台设备处于 `PENDING` 的任务回给它，后面的状态机不变。

### 3、任务状态机

先看各家设备任务有哪些状态、由谁来置：

| 平台 | 状态 | 由谁置 |
|------|------|--------|
| AWS IoT Jobs | `QUEUED`、`IN_PROGRESS`、`SUCCEEDED`、`FAILED`、`REJECTED`、`TIMED_OUT`、`REMOVED`、`CANCELED` | 设备：`IN_PROGRESS`、`SUCCEEDED`、`FAILED`、`REJECTED`；服务：`QUEUED`、`TIMED_OUT`、`REMOVED`、`CANCELED`（用户取消或中止条件触发） |
| ThingsBoard | `QUEUED`、`INITIATED`、`DOWNLOADING`、`DOWNLOADED`、`VERIFIED`、`UPDATING`、`UPDATED`、`FAILED` | 前两个由平台置，其余由设备上报 |
| 阿里云 | 待确认、待推送、已推送、升级中、升级成功、升级失败、已取消 | 「待确认」只在批次开启了 App 确认升级时出现，等用户在手机 App 上确认 |
| hawkBit | `SCHEDULED`、`RUNNING`、`RETRIEVED`、`DOWNLOAD`、`DOWNLOADED`、`WAIT_FOR_CONFIRMATION`、`WARNING`、`FINISHED`、`ERROR`、`CANCELING`、`CANCELED`、`CANCEL_REJECTED` | 设备通过 DDI 反馈执行情况（`proceeding`、`rejected`、`closed` 等）与结果（`success`、`failure`），平台映射成这些状态 |
| 本篇 | `PENDING`、`NOTIFIED`、`DOWNLOADING`、`VERIFYING`、`INSTALLING`、`SUCCESS`、`FAILED`、`ROLLED_BACK`、`REJECTED`、`TIMEOUT`、`CANCELED` | 设备：`DOWNLOADING` 到 `REJECTED`；平台：`PENDING`、`NOTIFIED`、`TIMEOUT`、`CANCELED` |

共同点有三个：终态里除了成功与失败，都有「设备拒绝」（电量低、正在使用、型号不符，设备有权不升）和「平台取消」；超时由平台判定而不是设备上报；进行中的阶段分得多细各家不同。本篇把 AWS 的 `IN_PROGRESS` 细分成了下载、校验、安装三步。

```java
public enum OtaStatus {
    PENDING, NOTIFIED, DOWNLOADING, VERIFYING, INSTALLING,
    SUCCESS, FAILED, ROLLED_BACK, REJECTED, TIMEOUT, CANCELED;

    /** 允许流转到当前状态的前置状态 */
    public Set<OtaStatus> allowedFrom() {
        return switch (this) {
            case PENDING -> Set.of();
            case NOTIFIED -> Set.of(PENDING);
            case DOWNLOADING -> Set.of(PENDING, NOTIFIED);   // 设备上报可能先于 NOTIFIED 落库
            case VERIFYING -> Set.of(DOWNLOADING);
            case INSTALLING -> Set.of(VERIFYING);
            case SUCCESS, ROLLED_BACK -> Set.of(INSTALLING);
            case FAILED, TIMEOUT -> Set.of(NOTIFIED, DOWNLOADING, VERIFYING, INSTALLING);
            case REJECTED -> Set.of(PENDING, NOTIFIED);                  // 设备拒绝：还没开始下载
            case CANCELED -> Set.of(PENDING, NOTIFIED, DOWNLOADING);     // 平台取消：进入校验、安装后不再取消
        };
    }

    /** 设备只能上报这些状态；NOTIFIED、TIMEOUT、CANCELED 由平台置 */
    public boolean reportableByDevice() {
        return switch (this) {
            case DOWNLOADING, VERIFYING, INSTALLING, SUCCESS, FAILED, ROLLED_BACK, REJECTED -> true;
            default -> false;
        };
    }
}
```

状态更新用条件更新一次完成"检查 + 修改"，天然防并发、防重复，乱序到达的倒退上报会被拒绝（不是重排）：

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

取消分两步：平台先把任务条件更新为 `CANCELED`，再向 `devices/{deviceId}/ota/cmd` 发一条带同一个 `taskId` 的取消通知。设备可能已经下载完并开始安装，这时它照常装完并上报，任务状态不再变化（终态不能再流转），设备的实际固件版本以它上报的 `runningVersion` 写入设备台账为准。

### 4、状态上报处理

设备向 `devices/{deviceId}/ota/status` 上报，QoS 1：

```json
{"taskId": 1024, "status": "REJECTED", "runningVersion": "2.0.3", "reason": "电量低于 30%"}
```

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
        if (!report.status().reportableByDevice()) {
            log.warn("设备上报了只能由平台置的状态 device={} status={}", deviceId, report.status());
            return;
        }
        int updated = tasks.transition(report.taskId(), deviceId, report.status(),
                report.status().allowedFrom(), report.reason());
        if (updated == 0) {
            // 重复上报、乱序到达或非法流转，记录后忽略，不抛异常
            log.info("忽略 OTA 状态 device={} task={} status={}", deviceId, report.taskId(), report.status());
        }
    }
}
```

`REJECTED` 不计入失败率熔断，但要单独统计：某一批设备大面积拒绝，通常说明前置条件没选对（比如白天给正在使用的设备推升级）。

### 5、调度下发：消息不放进数据库事务

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
            mqtt.publish("devices/" + task.getDeviceId() + "/ota/cmd", 1, commands.build(task));
            tasks.transition(task.getId(), task.getDeviceId(), OtaStatus.NOTIFIED,
                    OtaStatus.NOTIFIED.allowedFrom(), null);
        }
    }
}
```

- 创建升级活动的接口只写库（活动 + 批次 + 设备任务，同一事务），立刻返回；真正下发由调度器异步完成，HTTP 请求不会因为设备数量多而超时
- MQTT 发送不放在数据库事务里：事务回滚时消息已经发出、无法撤回；这里先发消息再条件更新，进程在两步之间崩溃时下一轮会重发，设备按 `taskId` 去重即可。设备的 `DOWNLOADING` 上报可能比 `NOTIFIED` 先落库，所以状态机允许从 `PENDING` 直接进入 `DOWNLOADING`，随后那次 `NOTIFIED` 更新因来源状态不符自然失败，任务不会卡到超时。需要严格保证"写库与发消息一致"时用本地消息表，见 [分布式事务](/distributed/5_transaction)
- 另起一个定时任务扫描长时间停在中间状态的任务，标记为 `TIMEOUT`，计入批次失败率
- 多实例部署时调度器只能有一个在跑，用分布式锁或调度框架保证，见 [分布式调度](/distributed/7_job_scheduler)

---

## 六、常见坑

| 现象 | 原因 | 处理 |
|------|------|------|
| 被替换的固件也通过了校验 | 只校验 MD5 或只依赖 HTTPS | 摘要 + 私钥签名，设备内置公钥验签 |
| 签名密钥泄露后所有设备都要召回 | 只有一把密钥，公钥烧死在设备里 | 根密钥与日常签名密钥分开，根密钥离线，能通过新的根元数据轮换 |
| 设备被刷回旧漏洞版本 | 只比较展示版本号，或根本不比较 | 安全版本计数器写入只增不减的存储 |
| MCUboot 开了降级防护却不生效 | 软件方式只在覆盖式升级下可用，项目用的是 swap 模式 | swap 模式改用硬件安全计数器 |
| 升级后大量设备离线 | 单分区覆盖，新固件起不来 | A/B 分区 + 试运行确认 + 自动回退 |
| 升级一开始源站带宽打满 | 全量同时下发 | 分批灰度、下发限速、CDN 分发 |
| 活动结束后新上线的设备还是旧固件 | 目标设备在创建活动时定死 | 用动态批次，持续把新满足条件的设备纳入 |
| 任务状态错乱 | 先查再改，乱序上报覆盖了终态 | 条件更新，非法流转直接忽略 |
| 下发失败但任务显示已通知 | 先改状态后发消息，或在事务里发消息 | 发送成功后再条件更新，设备按 `taskId` 去重 |

---

## 小结

- 固件安全的基础是 SHA-256 摘要加私钥签名：算法默认选工具链支持最广的 ECDSA P-256，启动链与工具都支持时可用 Ed25519；私钥放在 KMS / HSM，设备内置公钥并由安全启动链保护；MD5 和 HTTPS 都不能替代签名
- 清单格式有 SUIT、TUF、Mender Artifact、MCUboot 镜像等现成方案，本篇示例是教学用的简化格式；密钥按 TUF 的思路分成离线的根密钥与可轮换的签名密钥
- 防回滚靠只增不减的安全版本计数器，确认新固件运行正常后才提升；MCUboot 的软件降级防护只在覆盖式升级下可用
- A/B 分区 + 试运行确认让升级失败时自动回退，设备回到旧分区后上报原因
- 下载用短时效预签名 URL 和 HTTP Range 断点续传，整包校验通过才安装
- 编排是两层：活动定义目标、节奏、中止条件与时间窗口，设备任务记录每台设备的状态；状态机除成功、失败外要有设备拒绝与平台取消，状态用条件更新推进，MQTT 发送不放进数据库事务
- 本篇讲的是通用设计；配套仓库 Conduit IoT 的实现篇计划在平台实战一组补充，目前见 [平台实战概览](../4_practice/0_intro)

## 参考资料

- MCUboot 设计文档（镜像 TLV、防降级、swap 与回退）：[https://docs.mcuboot.com/design.html](https://docs.mcuboot.com/design.html)
- MCUboot imgtool（支持的签名密钥类型）：[https://github.com/mcu-tools/mcuboot/blob/main/docs/imgtool.md](https://github.com/mcu-tools/mcuboot/blob/main/docs/imgtool.md)
- RFC 9019 A Firmware Update Architecture for Internet of Things：[https://www.rfc-editor.org/rfc/rfc9019.html](https://www.rfc-editor.org/rfc/rfc9019.html)
- RFC 9124 A Manifest Information Model for Firmware Updates in IoT Devices：[https://www.rfc-editor.org/rfc/rfc9124.html](https://www.rfc-editor.org/rfc/rfc9124.html)
- SUIT 清单格式草案（draft-ietf-suit-manifest）：[https://datatracker.ietf.org/doc/draft-ietf-suit-manifest/](https://datatracker.ietf.org/doc/draft-ietf-suit-manifest/)
- TUF 规范（角色、targets 元数据、密钥轮换）：[https://theupdateframework.github.io/specification/latest/](https://theupdateframework.github.io/specification/latest/)
- Uptane 标准：[https://uptane.org/docs/latest/standard/uptane-standard](https://uptane.org/docs/latest/standard/uptane-standard)
- Mender Artifact 格式：[https://docs.mender.io/architecture/mender-artifacts](https://docs.mender.io/architecture/mender-artifacts)
- Mender 制品签名与验证：[https://docs.mender.io/artifact-creation/sign-and-verify](https://docs.mender.io/artifact-creation/sign-and-verify)
- RAUC 文档：[https://rauc.readthedocs.io/en/latest/](https://rauc.readthedocs.io/en/latest/)
- SWUpdate 升级策略概览：[https://sbabic.github.io/swupdate/overview.html](https://sbabic.github.io/swupdate/overview.html)
- FreeRTOS OTA 代码签名证书：[https://docs.aws.amazon.com/freertos/latest/userguide/ota-code-sign-cert.html](https://docs.aws.amazon.com/freertos/latest/userguide/ota-code-sign-cert.html)
- AWS IoT Jobs 的任务与执行状态：[https://docs.aws.amazon.com/iot/latest/developerguide/iot-jobs-lifecycle.html](https://docs.aws.amazon.com/iot/latest/developerguide/iot-jobs-lifecycle.html)
- AWS IoT Jobs 配置项（下发节奏、中止、超时、重试、定时）：[https://docs.aws.amazon.com/iot/latest/developerguide/jobs-configurations-details.html](https://docs.aws.amazon.com/iot/latest/developerguide/jobs-configurations-details.html)
- AWS IoT Jobs 设备侧 MQTT 接口：[https://docs.aws.amazon.com/iot/latest/developerguide/jobs-mqtt-api.html](https://docs.aws.amazon.com/iot/latest/developerguide/jobs-mqtt-api.html)
- AWS IoT Jobs 创建与预签名 URL 占位符：[https://docs.aws.amazon.com/iot/latest/developerguide/create-manage-jobs.html](https://docs.aws.amazon.com/iot/latest/developerguide/create-manage-jobs.html)
- ThingsBoard OTA 升级：[https://thingsboard.io/docs/user-guide/ota-updates/](https://thingsboard.io/docs/user-guide/ota-updates/)
- Eclipse hawkBit DDI 接口：[https://github.com/eclipse-hawkbit/hawkbit/blob/master/docs/direct-device-integration-api.md](https://github.com/eclipse-hawkbit/hawkbit/blob/master/docs/direct-device-integration-api.md)
- Eclipse hawkBit Rollout 管理：[https://github.com/eclipse-hawkbit/hawkbit/blob/master/docs/rollout-management.md](https://github.com/eclipse-hawkbit/hawkbit/blob/master/docs/rollout-management.md)
- 阿里云 OTA 升级包与签名算法（文档已标注停止维护，下同）：[https://help.aliyun.com/zh/iot/user-guide/add-an-update-package](https://help.aliyun.com/zh/iot/user-guide/add-an-update-package)
- 阿里云 OTA 设备端升级与安全升级：[https://help.aliyun.com/zh/iot/user-guide/perform-ota-updates](https://help.aliyun.com/zh/iot/user-guide/perform-ota-updates)
- 阿里云 OTA 批量升级（静态与动态）：[https://help.aliyun.com/zh/iot/user-guide/initiate-a-batch-update](https://help.aliyun.com/zh/iot/user-guide/initiate-a-batch-update)
- 阿里云 OTA 升级状态：[https://help.aliyun.com/zh/iot/user-guide/view-update-status](https://help.aliyun.com/zh/iot/user-guide/view-update-status)
- Java Security Standard Algorithm Names（Ed25519、SHA256withECDSA）：[https://docs.oracle.com/en/java/javase/21/docs/specs/security/standard-names.html](https://docs.oracle.com/en/java/javase/21/docs/specs/security/standard-names.html)
- RFC 8032 Edwards-Curve Digital Signature Algorithm (EdDSA)：[https://www.rfc-editor.org/rfc/rfc8032](https://www.rfc-editor.org/rfc/rfc8032)
- RFC 9110 HTTP Semantics（Range 请求）：[https://www.rfc-editor.org/rfc/rfc9110#name-range-requests](https://www.rfc-editor.org/rfc/rfc9110#name-range-requests)

> 下一篇：[规则引擎与告警](./6_rule_engine)
