---
description: 预配模型与主流平台对照、一型一密动态注册的最小实现、生命周期状态机、禁用与踢线、凭据轮换与设备转移
---

# 设备注册与生命周期

> 前置阅读：[设备安全](./1_security)、[通信协议](../1_basics/1_protocol)

出厂时给每台设备逐台配凭据不现实，设备从出厂到报废的每个状态平台也都要管得住。本篇讲主流平台的预配模型、动态注册的最小实现、生命周期与禁用踢线、凭据轮换与设备转移，基线为 JDK 21、Spring Boot 4、EMQX 5.9+ / 6.x。

---

## 一、要解决的问题

[设备安全](./1_security#_2、一机一密与一型一密) 要求每台设备有自己的凭据，难处在「怎么让它拿到」：

| 环节 | 难点 |
|------|------|
| 产线 | 逐台烧录唯一密钥或证书要改产线工装，代工厂还可能接触到明文 |
| 首次上线 | 设备要证明「我是这家厂商造的、还没注册过的那台」，平台要据此发放唯一凭据 |
| 运行期 | 设备被盗、被转卖、疑似泄露时要能立刻让它下线并拒绝再连 |
| 凭据到期或泄露 | 换新凭据的过程中设备不能掉线 |
| 转手与报废 | 换主人、换租户时要重置；报废时凭据作废、数据按约定擦除 |

前两行叫**预配**（provisioning），后三行是**生命周期管理**。下面先看主流平台怎么做预配，再给一套与它们同构的最小实现。

---

## 二、预配：主流平台怎么做

各家的名字不同，模型是同一个：**设备出厂只带一份共享的引导凭据，平台侧预先登记白名单或模板，设备首次上线时用引导凭据换出每台唯一的凭据**。

### 1、各家对照

| 平台 | 引导凭据 | 平台侧预置 | 换出什么 | 关键约束 |
|------|---------|-----------|---------|---------|
| 阿里云物联网平台 · 一机一密 | 无，出厂直接烧录 ProductKey、DeviceName、DeviceSecret | 逐台添加设备 | — | 官方称安全性较高、推荐使用 |
| 阿里云 · 一型一密预注册 | 同产品共用 ProductKey + ProductSecret | 产品开启动态注册开关，预先添加 DeviceName | DeviceSecret | 同一组设备证书只能激活一台物理设备；设备丢了 DeviceSecret 要调用 ResetThing 重置为未注册后重新激活，下发的 DeviceSecret 不变；动态注册必须走 TLS |
| 阿里云 · 一型一密免预注册 | 同上 | 只开动态注册开关，不登记 DeviceName | ClientID + DeviceToken | 仅 MQTT、仅企业版实例、仅华东 2 与华北 2；最多 5 台物理设备可以用同一组 ProductKey、ProductSecret、DeviceName 激活 |
| AWS IoT · JITP / JITR | 设备出厂已带自有 CA 签发的唯一证书 | 把 CA 注册到 AWS 并开启自动注册 | 不换凭据，首连时登记证书 | JITP 按 CA 上挂的预配模板建 thing、挂策略、把证书置为 ACTIVE；JITR 只把证书登记为 `PENDING_ACTIVATION` 并发到 `$aws/events/certificates/registered/{caCertificateId}`，由规则加 Lambda 校验后激活 |
| AWS IoT · Fleet Provisioning by claim | 全批设备共用的 claim 证书 | 预配模板，可挂 pre-provisioning hook（Lambda 返回 `allowProvisioning` 决定放不放行） | 设备证书：`CreateKeysAndCertificate` 由 AWS 生成密钥对，`CreateCertificateFromCsr` 由设备提交 CSR；再调 `RegisterThing` 建资源 | 两个创建接口返回的 `certificateOwnershipToken` 1 小时内不调 `RegisterThing` 证书就被删除；拿到证书后设备要断开 claim 会话、用新证书重连 |
| AWS IoT · trusted user | 安装人员的 App 调 `CreateProvisioningClaim` 拿到的临时 claim 证书 | 同上 | 同上 | 临时 claim 证书 5 分钟有效，用于设备出厂前装不了证书、但有人现场配网的场景 |
| Azure IoT Hub DPS | 个人注册（individual enrollment）：X.509 叶证书、TPM 或对称密钥；注册组（enrollment group）：同一 CA 签的证书或组对称密钥 | 注册表加分配策略：均匀加权、最低延迟、静态指定、自定义（Azure Function） | 把设备登记到某个已关联的 IoT Hub，返回 Hub 地址 | 组对称密钥不直接给设备：设备密钥 = HMAC-SHA256(组密钥, registration ID)，官方建议在工厂里派生好再写入，组密钥不进设备 |
| 华为云 IoTDA · 设备发放 | 设备证书（注册组绑定 CA 证书） | 注册组加发放策略（证书策略、自定义策略） | 分配到某个接入实例并返回接入地址 | 设备出厂统一烧录发放服务地址，引导完成后断开发放连接、改连返回的地址 |
| ThingsBoard | 设备配置（device profile）上的 provision device key / secret | 三种策略：允许创建新设备、只接受预先建好的设备、X.509 证书链 | ACCESS_TOKEN、MQTT_BASIC 或 X.509 凭据 | 用户名 `provision` 连接，发 `/provision/request`、收 `/provision/response`；成功后设备的 `provisionState` 属性置为 `provisioned`，再次请求被拒，删掉这个属性才能重新预配 |

::: info 阿里云的现状
阿里云物联网平台自 2025 年 2 月起停止新购，上表引用的几篇产品文档也已标为停止维护（见 [平台选型](../1_basics/2_platform)）。它的「一机一密 / 一型一密」叫法在国内流传最广，这里作为模型对照保留。
:::

### 2、两个维度与各自的风险

把上表拆开，其实只有两个维度：

| 维度 | 选项 | 引导凭据泄露后 |
|------|------|---------------|
| 平台侧是否预登记 | **预注册**：白名单里有这个序列号才放行（阿里云预注册、ThingsBoard 只接受预建设备、Azure 个人注册） | 攻击者只能抢注白名单里还没激活的序列号；真设备随后注册失败，本身就是告警信号 |
| | **免预注册**：引导凭据对就放行（阿里云免预注册、ThingsBoard 允许创建、AWS claim） | 攻击者可以无限造新设备，影响面是整个产品；只能靠配额、pre-provisioning hook 之类的二次校验兜住 |
| 最终凭据形态 | **密钥**：平台生成并下发 | 下发过程必须走 TLS；平台要保存密钥（可逆存储或只存哈希，取决于认证方式） |
| | **证书**：设备生成密钥对、提交 CSR | 私钥从不离开设备，平台只签名；证书签发与吊销见 [设备安全 · X.509 证书签发](./1_security#_4、x-509-证书签发) |

几条共识：白名单是把「产品级泄露」压回「单台抢注」的关键；引导凭据只用来换凭据，换完立刻弃用，它的权限只够调注册接口（AWS 给 claim 证书的策略只放行 `$aws/certificates/create/*` 和预配模板的 Topic）；发现引导凭据泄露时停用它，只会挡住之后的注册，已经换到唯一凭据的设备不受影响——AWS 的文档对 claim 证书就是这么写的。

**本模块的示例采用「预注册 + 密钥」**：最接近阿里云一型一密预注册与 ThingsBoard 只接受预建设备，对设备要求最低；与它们的差别是注册走一个 HTTPS 接口，而不是专用的 MQTT Topic，这样注册服务与 Broker 解耦，Broker 只认最终凭据。

---

## 三、最小实现：动态注册

![动态注册时序与设备生命周期](../../assets/iot/device-provisioning-lifecycle.svg)

### 1、产线导入白名单

产线只导入序列号，不接触任何设备密钥：

```sql
CREATE TABLE device (
    device_id     VARCHAR(64) PRIMARY KEY,           -- 即 MQTT clientid，这里直接用序列号
    product_key   VARCHAR(32) NOT NULL,
    status        VARCHAR(16) NOT NULL,              -- INACTIVE / ACTIVE / DISABLED / DELETED
    secret_enc    BYTEA,                             -- 加密后的 DeviceSecret，未激活时为空
    registered_at TIMESTAMPTZ,
    CHECK (device_id ~ '^[A-Za-z0-9_-]{1,64}$')      -- 不允许 / + #，它会被代入 ACL 的 Topic 模板
);
-- 产线导入：一批序列号写成 INACTIVE
INSERT INTO device (device_id, product_key, status) VALUES ('SN20260001', 'pk-meter', 'INACTIVE');
```

设备 ID 的字符集要在这一步卡死：它就是 `clientid`，会被代进 `devices/${clientid}/…`，带 `/` 或 `+` 的 ID 在 EMQX 6.3 起默认匹配不上 ACL，原因见 [设备安全 · 文件规则](./1_security#_3、文件规则-acl-conf)。

### 2、注册接口

设备首次上电，用烧录在固件里的产品级 ProductSecret 对请求签名：

```java
public record RegisterRequest(String productKey, String serialNumber, long ts, String sign) {}
public record RegisterResponse(String deviceId, String deviceSecret, String mqttUri) {}

@RestController
public class ProvisioningController {

    private static final long MAX_SKEW_MS = Duration.ofMinutes(5).toMillis();
    private final ProductSecretStore products;      // 按 productKey 取 ProductSecret（KMS 解密后）
    private final DeviceRepository devices;
    private final SecretCipher cipher;              // 用 KMS 托管的数据密钥加解密 DeviceSecret
    private final SecureRandom random = new SecureRandom();
    private final Clock clock;
    // 构造器省略

    @PostMapping("/provisioning/register")
    @Transactional
    public ResponseEntity<RegisterResponse> register(@RequestBody RegisterRequest req)
            throws GeneralSecurityException {
        if (Math.abs(clock.millis() - req.ts()) > MAX_SKEW_MS) {
            return ResponseEntity.status(401).build();               // 时间窗外，疑似重放
        }
        byte[] productSecret = products.find(req.productKey()).orElse(null);
        if (productSecret == null || !validSign(productSecret, req)) {
            return ResponseEntity.status(401).build();               // 引导凭据不对
        }
        // 白名单里 INACTIVE 的才放行，UPDATE 的条件保证并发下也只有一个请求能换到
        byte[] secret = new byte[32];
        random.nextBytes(secret);
        int updated = devices.activate(req.productKey(), req.serialNumber(), cipher.encrypt(secret));
        if (updated == 0) {
            return ResponseEntity.status(409).build();               // 不在白名单、已注册或已禁用
        }
        return ResponseEntity.ok(new RegisterResponse(req.serialNumber(),
                HexFormat.of().formatHex(secret), "ssl://mqtt.example.com:8883"));
    }

    private boolean validSign(byte[] key, RegisterRequest req) throws GeneralSecurityException {
        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(key, "HmacSHA256"));
        byte[] expected = mac.doFinal(("productKey=" + req.productKey() + "&serialNumber="
                + req.serialNumber() + "&ts=" + req.ts()).getBytes(StandardCharsets.UTF_8));
        try {
            return MessageDigest.isEqual(expected, HexFormat.of().parseHex(req.sign()));
        } catch (IllegalArgumentException | NullPointerException e) {
            return false;
        }
    }
}
```

`DeviceRepository.activate` 就是一条带条件的更新，「只能换一次」靠的是 `status = 'INACTIVE'` 这个条件，而不是先查后改：

```sql
UPDATE device SET status = 'ACTIVE', secret_enc = :secret, registered_at = now()
 WHERE product_key = :productKey AND device_id = :serialNumber AND status = 'INACTIVE';
```

几个取舍：

- **只能换一次，丢了要人工重置**：与阿里云预注册一致。设备如果没收到响应（断网、掉电），序列号已是 ACTIVE，再请求会得到 409，只能由运维调重置接口把它改回 INACTIVE。另一种做法是「凭据发出后限时确认」：先发凭据、状态记为待确认，设备用新凭据第一次连上才转 ACTIVE，超时没连上就作废、允许重领。AWS Fleet Provisioning 是同一个思路：证书创建后 1 小时内没有调 `RegisterThing` 完成登记，证书被删除，设备可以重新申请。体验更好，代价是多一个状态和一个定时清理
- **DeviceSecret 可逆存储还是只存哈希**：取决于设备之后怎么认证。走 [设备安全 · HMAC 签名](./1_security#_3、hmac-签名-emqx-http-认证) 时认证服务要拿原始密钥算签名，只能像上面这样用 KMS 加密存储；如果设备直接把密钥当 password 发（必须 TLS），台账可以只存加盐哈希，Conduit 就是这么做的，见 [设备接入与鉴权 · 设备凭据](../4_practice/1_access#三、设备凭据-生成与哈希)
- **响应只出现一次**：明文 DeviceSecret 不落日志、不进审计记录，网关与 WAF 的请求响应日志也要排除这个接口
- **注册接口也要限流**：它和 MQTT 认证一样会在批量上电时被集中调用，按 productKey 与来源 IP 限速，策略同 [海量连接与连接风暴](./7_connection_storm)

设备拿到 DeviceSecret 后写入加密存储区，之后每次都用一机一密连接 EMQX，ProductSecret 在固件里不再被使用。用证书时流程相同，只是第 2 步改为提交 CSR、第 3 步返回签好的证书，私钥不出设备，见 [设备安全 · X.509 证书签发](./1_security#_4、x-509-证书签发)。

### 3、认证回调查状态

EMQX 的 HTTP 认证回调除了验签名，还要看 `status`：只有 ACTIVE 放行，INACTIVE、DISABLED、DELETED 一律 `deny`。拒绝原因只进平台日志和指标，不回给设备，按原因计数的做法见 [设备接入与鉴权 · 拒绝原因](../4_practice/1_access#六、拒绝原因-让「连不上」看得见)。

---

## 四、生命周期状态机

### 1、状态与各家的叫法

| 状态 | 含义 | 阿里云 | Azure IoT Hub | AWS IoT | 华为云 IoTDA |
|------|------|--------|---------------|---------|-------------|
| 未激活 | 在白名单里，还没换到凭据 | `UNACTIVE` | 只在 DPS 注册表里，Hub 里还没有设备 | 证书 `PENDING_ACTIVATION`（JITR） | 未激活：已注册但从未连接 |
| 已激活 | 有凭据，可以连接；在线、离线是它的子状态 | `ONLINE` / `OFFLINE` | `status = Enabled` | 证书 `ACTIVE` | 在线 / 离线（短连接设备另有「异常」） |
| 已禁用 | 凭据还在，但拒绝连接，可恢复 | `DISABLE`，接口 `DisableThing` / `EnableThing`，设备信息保留 | `status = Disabled`：设备访问不了任何面向设备的端点 | 证书 `INACTIVE`，可改回 `ACTIVE` | `FreezeDevice` / `UnfreezeDevice`：冻结后不能再连接上线，目前只支持直连设备 |
| 已注销 | 凭据作废，不可恢复 | `DeleteDevice` | 删除设备身份 | 证书 `REVOKED`，此后状态不能再改 | 删除设备 |

在线 / 离线不要和生命周期状态存在同一列：前者由连接事件驱动、一天变很多次，后者由运维操作驱动、要审计。在线状态的几种做法见 [设备接入与鉴权 · 上下线事件与在线状态](../4_practice/1_access#九、上下线事件与在线状态)。

AWS 没有设备级的启用开关，停用落在证书上；Azure 与 DPS 是两层，在 DPS 里禁用注册项只挡住以后的注册，不会删掉设备在 IoT Hub 里已有的登记，要停用还得改 Hub 里的 `status`。

### 2、禁用要做三件事

认证只发生在建连那一刻。只把台账里的状态改成 DISABLED，已经连着的设备照样收发，直到它下次重连——Conduit 现在就有这个限制，见 [设备接入与鉴权 · 已知限制](../4_practice/1_access#十三、已知限制)。禁用必须同时做三件事，顺序不能反：

| 顺序 | 动作 | EMQX 上怎么做 |
|------|------|--------------|
| 1 | 拒绝新连接：台账状态改为 DISABLED，清掉认证服务自己的身份缓存 | 认证回调对它返回 `deny`；认证走 MySQL、Redis 等外部数据源并开了外部资源缓存时，缓存按节点保存、默认 1 分钟过期，期间旧结果仍可能命中 |
| 2 | 踢掉现有连接 | `DELETE /api/v5/clients/{clientid}`；EMQX Cloud 的接口文档写明踢线会同时结束连接和会话 |
| 3 | 让授权缓存失效 | 授权缓存跟着客户端会话，断开或重连即清空，第 2 步已经顺带解决；不踢线只改 ACL 时，用 `DELETE /api/v5/clients/{clientid}/authorization/cache` 清单个客户端 |

先改状态再踢线：反过来的话，设备被踢后立刻重连，认证服务还没看到 DISABLED，又放它进来了。

```java
@Service
public class DeviceLifecycleService {

    private final DeviceRepository devices;
    private final IdentityCache identityCache;      // 认证服务的身份缓存
    private final RestClient emqx;                  // baseUrl = http://emqx-host:18083/api/v5，带 API Key 的 Basic 认证

    @Transactional
    public void disable(String deviceId, String reason) {
        devices.updateStatus(deviceId, DeviceStatus.DISABLED, reason);   // 1. 先让认证拒绝
        identityCache.evict(deviceId);
        TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization() {
            @Override
            public void afterCommit() {                                   // 2. 事务提交后再踢线
                emqx.delete().uri("/clients/{id}", deviceId).retrieve()
                    .onStatus(s -> s.value() == 404, (rq, rs) -> { })     // 不在线，忽略
                    .toBodilessEntity();
            }
        });
    }
}
```

两个补充：

- **被禁用的设备会不停重连**。阿里云的文档特意提醒，禁用前最好先让真实设备离线，否则它持续建连可能触发限流、影响账号下其他设备。平台侧的对策是 EMQX 的抖动检测和黑名单：`POST /api/v5/banned` 写入 `{"as": "clientid", "who": "SN20260001", "until": …}` 后，这个 clientid 在认证之前就被拒，不再打到认证服务；按 clientid 封禁时 EMQX 还会顺带踢掉它现有的会话（按用户名、IP 封禁不会）。黑名单官方定位是只适合少量条目，大批设备的禁用仍然靠认证，限速与抖动检测见 [海量连接与连接风暴](./7_connection_storm)
- **禁用优先于证书吊销**。证书设备疑似泄露时，第一步也是在台账禁用并踢线，CRL 是第二道：EMQX 的 CRL 有缓存刷新周期，且只在握手时检查，已连着的设备要靠踢线断开，见 [设备安全 · 证书轮换与吊销](./1_security#_5、证书轮换与吊销)

注销（DELETED）在禁用的基础上再清掉 `secret_enc`、删除内置数据库里的 ACL 规则，设备 ID 保留在表里不复用，避免新设备继承旧设备的历史数据与权限。

---

## 五、凭据轮换、转移与退役

### 1、DeviceSecret 轮换：双密钥窗口

直接把旧密钥换成新密钥，下发与设备落盘之间只要出一次错设备就再也连不上。通行做法是**新旧两把同时有效一段时间**，Azure IoT Hub 给对称密钥设备的就是主、次两把密钥，自签证书设备也登记主、次两个指纹：

| 步骤 | 平台 | 设备 |
|------|------|------|
| 1 | 生成新密钥写入「次密钥」槽，认证时两把都接受 | — |
| 2 | 经已认证的连接往 `devices/{deviceId}/cmd` 下发 `{"id": "…", "method": "rotateSecret", "params": {"secret": "…"}}`（指令通道见 [指令下发与服务调用](../3_platform/4_command)） | 把新密钥写入加密存储区，回应答 |
| 3 | — | 断开，用新密钥重连 |
| 4 | 看到新密钥认证成功，把它提升为主密钥，旧密钥作废 | — |

设备在第 2、3 步之间掉电，重启后仍可用旧密钥连上，平台下次再推一遍；窗口要设上限（例如 7 天），到期仍未切换的设备进人工处理清单。证书的轮换思路相同：设备生成新密钥对、经现有连接提交 CSR，拿到新证书后切换，见 [设备安全 · 证书轮换与吊销](./1_security#_5、证书轮换与吊销)。

### 2、转移与重新绑定

设备转卖、换租户、换项目时，上一任主人的东西不能跟过去：

- **重置凭据**：走一次轮换，或把状态改回 INACTIVE 让设备重新注册；旧主人手里可能留着设备凭据的副本
- **清空归属数据**：用户绑定、影子里的 `desired`、未执行的指令与 OTA 任务
- **历史遥测不迁移**：留在原租户名下按原约定保留或删除，新租户从转移时刻开始

Azure DPS 把这件事做成了注册项上的重新预配策略：「重新预配并迁移数据」（默认）、「重新预配并重置为初始配置」、「从不重新预配」，场景里就写了多租户下设备换客户。ThingsBoard 的做法是删掉设备的 `provisionState` 属性，设备即可重新预配。

### 3、退役

报废、返厂时按注销处理：台账状态改为 DELETED、踢线、作废凭据；设备侧恢复出厂要清掉凭据与本地缓存，平台侧按约定删除或匿名化它的遥测与影子。这一条在欧盟 CRA、ETSI EN 303 645 里都有明确要求，见 [设备安全 · 标准与合规对照](./1_security#八、标准与合规对照)。

---

## 六、常见坑

- **引导凭据权限过大**：ProductSecret 或 claim 证书能直接连 Broker 收发业务 Topic。它的权限只应该够调注册接口
- **免预注册又不设上限**：引导凭据一旦从固件里被提取，攻击者能造出任意多台「合法」设备。至少按产品设注册配额，或者像 AWS 那样挂一个 hook 做二次校验
- **「只能注册一次」用先查后改实现**：并发的两个请求都查到 INACTIVE，各拿走一把密钥。用带状态条件的 UPDATE 或唯一约束
- **禁用只改了状态**：已在线的设备不受影响；先改状态、再踢线
- **踢线后不管重连**：被禁用的设备按固定间隔重连，持续消耗认证服务。用黑名单或抖动检测在认证之前挡住
- **设备 ID 字符集不受控**：序列号里带 `/`，ACL 的 `${clientid}` 模板渲染出错

---

## 小结

- 预配的通行模型是「共享的引导凭据 + 平台侧白名单或模板 → 换出每台唯一的凭据」，阿里云一型一密、AWS Fleet Provisioning、Azure DPS、华为云设备发放、ThingsBoard 都是这一个思路
- 两个维度决定风险：预注册把引导凭据泄露的影响压到「抢注未激活的序列号」，免预注册则波及整个产品；证书方案私钥不出设备，密钥方案要保证下发走 TLS
- 最小实现是一个签名校验的 HTTPS 注册接口，靠带状态条件的 UPDATE 保证每个序列号只换一次，DeviceSecret 只返回一次；存储方式取决于设备之后用 HMAC 签名还是直接传密钥
- 生命周期是未激活、已激活（在线 / 离线）、已禁用、已注销四个状态；禁用要先改状态、再踢线、让授权缓存失效，被禁用设备的反复重连用黑名单挡在认证之前
- 凭据轮换用新旧两把同时有效的窗口；转移时重置凭据、清空归属数据；退役时作废凭据并按约定擦除数据

## 参考资料

- 阿里云物联网平台 · 一机一密：[https://help.aliyun.com/zh/iot/user-guide/unique-certificate-per-device-verification](https://help.aliyun.com/zh/iot/user-guide/unique-certificate-per-device-verification)
- 阿里云物联网平台 · 一型一密动态注册：[https://help.aliyun.com/zh/iot/user-guide/unique-certificate-per-product-verification](https://help.aliyun.com/zh/iot/user-guide/unique-certificate-per-product-verification)
- 阿里云物联网平台 · 基于 MQTT 的动态注册：[https://help.aliyun.com/zh/iot/user-guide/mqtt-based-dynamic-registration](https://help.aliyun.com/zh/iot/user-guide/mqtt-based-dynamic-registration)
- 阿里云物联网平台 · 禁用与启用设备：[https://help.aliyun.com/zh/iot/user-guide/disable-and-enable-a-device](https://help.aliyun.com/zh/iot/user-guide/disable-and-enable-a-device)
- 阿里云物联网平台 · GetDeviceStatus：[https://help.aliyun.com/zh/iot/developer-reference/api-f67546](https://help.aliyun.com/zh/iot/developer-reference/api-f67546)
- Alibaba Cloud IoT Platform · DisableThing：[https://www.alibabacloud.com/help/en/iot/developer-reference/api-fe5a76](https://www.alibabacloud.com/help/en/iot/developer-reference/api-fe5a76)
- AWS IoT · Device provisioning：[https://docs.aws.amazon.com/iot/latest/developerguide/iot-provision.html](https://docs.aws.amazon.com/iot/latest/developerguide/iot-provision.html)
- AWS IoT · Fleet provisioning（by claim / by trusted user）：[https://docs.aws.amazon.com/iot/latest/developerguide/provision-wo-cert.html](https://docs.aws.amazon.com/iot/latest/developerguide/provision-wo-cert.html)
- AWS IoT · Just-in-time provisioning：[https://docs.aws.amazon.com/iot/latest/developerguide/jit-provisioning.html](https://docs.aws.amazon.com/iot/latest/developerguide/jit-provisioning.html)
- AWS IoT · Just-in-time registration：[https://docs.aws.amazon.com/iot/latest/developerguide/auto-register-device-cert.html](https://docs.aws.amazon.com/iot/latest/developerguide/auto-register-device-cert.html)
- AWS IoT · Activate or deactivate a client certificate：[https://docs.aws.amazon.com/iot/latest/developerguide/activate-or-deactivate-device-cert.html](https://docs.aws.amazon.com/iot/latest/developerguide/activate-or-deactivate-device-cert.html)
- AWS IoT · Revoke a client certificate：[https://docs.aws.amazon.com/iot/latest/developerguide/revoke-ca-cert.html](https://docs.aws.amazon.com/iot/latest/developerguide/revoke-ca-cert.html)
- Azure DPS · Terminology（enrollment、attestation、allocation policy）：[https://learn.microsoft.com/en-us/azure/iot-dps/concepts-service](https://learn.microsoft.com/en-us/azure/iot-dps/concepts-service)
- Azure DPS · Symmetric key attestation：[https://learn.microsoft.com/en-us/azure/iot-dps/concepts-symmetric-key-attestation](https://learn.microsoft.com/en-us/azure/iot-dps/concepts-symmetric-key-attestation)
- Azure DPS · Disenroll or revoke device：[https://learn.microsoft.com/en-us/azure/iot-dps/how-to-revoke-device-access-portal](https://learn.microsoft.com/en-us/azure/iot-dps/how-to-revoke-device-access-portal)
- Azure DPS · Device lifecycle and reprovisioning：[https://learn.microsoft.com/en-us/azure/iot-dps/concepts-device-reprovision](https://learn.microsoft.com/en-us/azure/iot-dps/concepts-device-reprovision)
- Azure IoT Hub · Identity registry（status、disable devices）：[https://learn.microsoft.com/en-us/azure/iot-hub/iot-hub-devguide-identity-registry](https://learn.microsoft.com/en-us/azure/iot-hub/iot-hub-devguide-identity-registry)
- Azure IoT Hub · Register and connect a device（primary / secondary key）：[https://learn.microsoft.com/en-us/azure/iot-hub/create-connect-device](https://learn.microsoft.com/en-us/azure/iot-hub/create-connect-device)
- 华为云 IoTDA · 设备自动注册安全接入示例：[https://support.huaweicloud.com/bestpractice-iothub/iot_bp_0042.html](https://support.huaweicloud.com/bestpractice-iothub/iot_bp_0042.html)
- 华为云 IoTDA · MQTT 注册组自定义策略发放示例：[https://support.huaweicloud.com/usermanual-iothub/iot_03_0008.html](https://support.huaweicloud.com/usermanual-iothub/iot_03_0008.html)
- Huawei Cloud IoTDA · Device Management（device status）：[https://support.huaweicloud.com/intl/en-us/usermanual-iothub/iot_01_0065.html](https://support.huaweicloud.com/intl/en-us/usermanual-iothub/iot_01_0065.html)
- 华为云 IoTDA · 冻结设备 FreezeDevice：[https://support.huaweicloud.com/api-iothub/iot_06_v5_0094.html](https://support.huaweicloud.com/api-iothub/iot_06_v5_0094.html)
- ThingsBoard · Device provisioning：[https://thingsboard.io/docs/user-guide/device-provisioning/](https://thingsboard.io/docs/user-guide/device-provisioning/)
- ThingsBoard · MQTT provisioning API：[https://thingsboard.io/docs/reference/mqtt-api/provisioning/](https://thingsboard.io/docs/reference/mqtt-api/provisioning/)
- EMQX · Banned Clients：[https://docs.emqx.com/en/emqx/latest/access-control/blacklist.html](https://docs.emqx.com/en/emqx/latest/access-control/blacklist.html)
- EMQX · Authentication（External Resource Cache）：[https://docs.emqx.com/en/emqx/latest/access-control/authn/authn.html](https://docs.emqx.com/en/emqx/latest/access-control/authn/authn.html)
- EMQX · Authorization（cache）：[https://docs.emqx.com/en/emqx/latest/access-control/authz/authz.html](https://docs.emqx.com/en/emqx/latest/access-control/authz/authz.html)
- EMQX Cloud · Clients API（kick a client）：[https://docs.emqx.com/en/cloud/latest/api/clients_v5.html](https://docs.emqx.com/en/cloud/latest/api/clients_v5.html)

> 下一篇：[MQTT 客户端](./3_mqtt_client)
