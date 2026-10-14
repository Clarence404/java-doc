---
description: 多渠道统一发送、模板与多语言、优先级隔离、频控与免打扰、去重幂等、重试与供应商切换、回执状态机、站内信存储、容量估算
---

# 消息通知中心

> 前置阅读：[Feed 流和消息推送](./8_feed_stream)、[即时通讯](./16_im)、[消息队列基础](/messaging/1_basics)

通知中心把站内信、短信、邮件、App 推送和企业 IM 收拢成一个服务，业务方只说「给谁发什么」，渠道、限速、重试和回执都由它负责。本篇讲发送链路、优先级与频控、去重与供应商切换、回执状态机和站内信存储，基线为 Spring Boot 4、RocketMQ 5。

---

## 一、需求与挑战

### 1、功能范围

| 渠道 | 典型内容 | 特点 |
|------|----------|------|
| 站内信 | 系统通知、互动提醒、全员公告 | 自己存储，要有未读数和列表；在线时经长连接实时提醒 |
| 短信 | 验证码、支付提醒、营销短信 | 按条计费，内容要先在服务商报备模板与签名，到达率受运营商影响 |
| 邮件 | 账单、注册确认、周报、营销邮件 | 便宜，但会进垃圾箱、会退信，批量发送有信誉要求 |
| App 推送 | 订单状态、互动、活动 | iOS 走 APNs；Android 海外走 FCM，国内走各手机厂商通道 |
| 企业 IM Webhook | 告警、审批、内部运营通知 | 飞书、钉钉、企业微信机器人，单个机器人限速很低 |

业务方的诉求可以归成一句话：调一个接口（或发一个事件），带上模板编码、接收人和变量，剩下的交给通知中心。

### 2、挑战

| 挑战 | 说明 |
|------|------|
| 渠道差异大 | 每个渠道的协议、限速、回执、失败码都不同，业务方不应关心 |
| 轻重缓急不同 | 验证码要求秒级到达，营销消息一次几千万条，不能互相拖累 |
| 打扰用户 | 发多了用户会关通知、卸载 App、投诉，营销短信还有合规要求 |
| 不重不漏 | 上游重复投递、自己重试、供应商超时都可能重复；丢了验证码用户就登录不了 |
| 外部依赖不稳定 | 短信、推送服务商会限流、抖动、整体故障 |
| 送没送到 | 「接口返回成功」不等于用户收到，要靠异步回执，回执还会乱序、重复、缺失 |
| 公告放大 | 一条全员公告如果给每个用户写一行，就是上亿次写入 |

---

## 二、整体架构

![消息通知中心整体架构](../assets/scenario/notification-arch.svg)

- **接入**：同步接口用于验证码这类调用方要立即知道结果的场景；其余通知由业务方在本地事务里写 Outbox，提交后投递「订单已支付」之类的业务事件，通知服务订阅后按规则决定发什么，可靠投递见 [消息队列基础](/messaging/1_basics#_1、本地消息表-transactional-outbox)
- **编排**：先按幂等键落任务表去重，再依次过订阅偏好、频控、免打扰，最后渲染模板、选渠道，结果投到对应优先级的队列
- **执行**：发送执行器按优先级分组消费，调用渠道适配器；限速、重试、熔断、供应商切换都在这一层
- **回执**：服务商的状态报告、退信、无效 token 通知回调进来，推进任务状态，并汇总成送达率与延迟指标

通知中心只负责「把这条消息送到」，**不负责业务判断**：订单要不要提醒、提醒谁，由业务方决定后告诉通知中心。规则引擎做得太重，会把通知中心变成另一个业务系统。

---

## 三、发送请求、模板与渠道选择

### 1、统一发送请求

```java
public enum Priority { P0, P1, P2, P3 }          // 验证码 / 交易 / 系统互动 / 营销

public record NotifyRequest(
        String bizType,                          // 业务类型，如 ORDER_PAID
        String bizId,                            // 业务主键，如订单号
        String templateCode,                     // 模板编码，决定内容、渠道和默认优先级
        List<Long> userIds,                      // 接收人；验证码这类无账号场景用 targets 传手机号
        List<String> targets,
        Map<String, String> params,              // 模板变量
        Priority priority,                       // 为空时取模板默认值
        Instant notBefore) {                     // 定时发送，可为空
}
```

- 幂等键由通知中心按 `bizType + bizId + templateCode + 接收人 + 渠道` 拼出来，**不让调用方自己生成随机 ID**：随机 ID 在调用方重试时会变，就起不到去重作用
- 变量只传原始值（金额、单号、时间戳），格式化交给模板，这样多语言下的金额、日期格式才能统一

### 2、模板与变量渲染

| 字段 | 说明 |
|------|------|
| templateCode + channel + locale | 唯一键，同一个模板在每个渠道、每种语言各有一份内容 |
| 标题 / 正文 | 正文里用 `{orderNo}` 这类占位符 |
| 变量声明 | 变量名、类型、是否必填、最大长度 |
| 服务商模板 ID | 短信要先在服务商报备模板和签名，审核通过后拿到对应 ID |
| 版本与状态 | 草稿、审核中、生效；修改生成新版本，已生成的任务按当时版本渲染 |
| 默认优先级与渠道 | 发送请求不传时使用 |

- **只做占位符替换，不用表达式引擎**：模板由运营在后台编辑，若用 SpEL、OGNL 这类能执行代码的引擎，后台账号失守就等于服务器失守，相关漏洞见 [常见漏洞](/security/8_vulnerabilities)
- **按渠道转义**：邮件正文是 HTML，变量要做 HTML 转义，否则用户昵称里的脚本会进到邮件里；短信、推送是纯文本，要去掉换行与控制字符
- **长度校验**：国内短信单条 70 个字，超出按长短信拆分计费，每条 67 个字；推送标题过长会被系统截断。渲染后超长就按变量的截断规则截，截不下来直接拒绝，不要发出去才发现
- **多语言回退**：按 `zh-Hant-TW → zh-Hant → 默认语言` 的顺序找模板，用户语言取自账号设置，没有再取设备语言；金额、日期按用户的地区与时区格式化

### 3、渠道选择

一个模板可以配置多个渠道，常见三种策略：

| 策略 | 做法 | 适合 |
|------|------|------|
| 全部发送 | 每个配置的渠道各发一份 | 资金变动（站内信 + 推送 + 短信） |
| 按序降级 | 先推送，推送失败或用户没有可用设备 token 时再发短信 | 重要但不想每次都花短信费的通知 |
| 二选一 | 用户在线就只走站内信长连接，离线才发推送 | 互动提醒 |

渠道选好后还要和用户的订阅偏好求交集（见第十一节），交集为空就记为「已过滤」，不再往下走。

---

## 四、发送链路

### 1、从业务事件到渠道

1. **接入**：通知服务消费业务事件，或接收同步请求
2. **去重落任务**：每个接收人、每个渠道生成一条 `notify_task`，唯一键冲突说明已经处理过，直接跳过（见第七节）
3. **过滤**：订阅偏好、退订、黑名单、频控、免打扰依次判断；不发的记为「已过滤」并写明原因，需要推迟的记下推迟到的时间
4. **渲染与投递**：渲染模板，按优先级投到对应的 Topic，消息里只带任务 ID 和渲染结果
5. **执行**：执行器消费后调用渠道适配器，服务商受理即进入「已提交」
6. **回执**：服务商异步回调或定时拉取状态报告，推进到「已送达」或「失败」

任务表在第 2 步就落库，之后每一步都只推进状态，所以任何一步失败都能从任务表找回来：定时任务扫描长时间停在「待处理」「发送中」的任务重新投递，与消息队列的重试互为兜底。

### 2、渠道适配器

```java
public sealed interface SendResult {
    record Accepted(String supplierMsgId) implements SendResult {}          // 服务商已受理
    record Retryable(String code, Duration retryAfter) implements SendResult {}
    record Rejected(String code) implements SendResult {}                  // 不可重试
}

public interface ChannelSender {
    Channel channel();
    SendResult send(RenderedMessage msg, String supplier);
}
```

| 渠道 | 接入要点 |
|------|----------|
| 站内信 | 写收件箱、加未读数，在线用户经长连接推一条「有新消息」，连接与路由见 [即时通讯](./16_im#_1、路由层) |
| 短信 | 至少接两家服务商；发送时把 notifyId 作为外部流水号透传，回执按它定位任务 |
| 邮件 | 自建 SMTP 或用邮件服务商 API；配置 SPF、DKIM、DMARC，营销邮件带一键退订头 |
| APNs | HTTP/2 长连接，基于 token 的鉴权；返回 410 表示设备 token 已失效，要删除 |
| FCM | HTTP v1 接口，OAuth2 访问令牌；返回 `UNREGISTERED` 同样删除 token |
| 国内厂商通道 | 华为、小米、OPPO、vivo、荣耀各接一套；消息要按厂商规则区分服务类和营销类，营销类有每设备每日条数限制 |
| 企业 IM Webhook | 请求要签名；单个机器人通常每分钟只允许几十条，告警要先聚合再发 |

推送的设备 token 由客户端启动时上报，按 `userId → 设备列表` 存储，一个用户多台设备时每台都发。适配器只做协议转换和错误码归类，**重试、切换、限速都不在适配器里做**，否则每个渠道各写一套，行为不一致。

---

## 五、优先级与隔离

| 级别 | 内容 | 时效要求 | 失败处理 |
|------|------|----------|----------|
| P0 | 验证码、登录与安全提醒 | 秒级 | 立即切换服务商，不排队等重试 |
| P1 | 支付、订单、物流 | 分钟级 | 退避重试，必要时降级到其他渠道 |
| P2 | 评论、关注、系统公告 | 分钟到小时级 | 退避重试，次数较少 |
| P3 | 营销、召回 | 小时级，可推迟 | 少量重试，失败即放弃 |

- **每个级别一个 Topic、一个消费组、一组线程池**。Kafka 和 RocketMQ 都没有单条消息优先级，混在一个 Topic 里，一次几千万条的营销任务会把验证码堵在后面；RabbitMQ 虽然支持优先级队列，但积压时仍共享消费者，物理隔离更可靠，思路见 [超时、重试与隔离](/high-avail/4_timeout_retry_bulkhead#三、隔离)
- **服务商账号也要隔离**：验证码和营销短信用不同的通道与签名，营销量大被运营商限速时不影响验证码；很多服务商本身就要求两类短信分开报备
- **营销任务匀速放量**：一次面向几千万人的推送，先按人群包分批生成任务，再用令牌桶控制每秒投递量，不在一分钟内全部压给推送平台，令牌桶见 [限流与过载保护](/high-avail/7_rate_limiting#_3、令牌桶-token-bucket)
- **过载时按级别卸载**：执行器压力大时先暂停 P3 的消费，再暂停 P2，P0 始终保留资源

---

## 六、频控与免打扰

### 1、四个层级的频控

| 层级 | 例子 | 目的 |
|------|------|------|
| 用户 × 渠道 | 同一手机号验证码 1 分钟 1 条、1 小时 5 条、1 天 10 条 | 防短信轰炸，控制成本 |
| 用户 × 类别 | 每人每天营销推送最多 3 条 | 防打扰 |
| 模板 / 业务 | 同一条营销活动同一用户只发一次 | 防运营误操作重复发 |
| 全局 / 服务商 | 某服务商最多 2,000 条/秒；某机器人每分钟 20 条 | 不超服务商限额，超了会被拒绝甚至封号 |

前三类按用户计数，在编排阶段判断；第四类是吞吐量控制，在执行器里用令牌桶。用户级的多个窗口要**一次性原子判断**，否则「1 分钟」通过、「1 小时」超限时，1 分钟的计数已经被加上了：

```lua
-- KEYS[i] 第 i 个窗口的计数 key，带用户 hash tag 和窗口编号，如 freq:{13800000000}:sms:h:487213
-- ARGV[2i-1] 第 i 个窗口的上限  ARGV[2i] 第 i 个窗口的 TTL（秒）
-- 返回 0 表示通过；返回 i 表示被第 i 个窗口拦截，所有计数都不增加
for i = 1, #KEYS do
  local n = tonumber(redis.call('GET', KEYS[i]) or '0')
  if n >= tonumber(ARGV[2 * i - 1]) then
    return i
  end
end
for i = 1, #KEYS do
  if redis.call('INCR', KEYS[i]) == 1 then
    redis.call('EXPIRE', KEYS[i], ARGV[2 * i])
  end
end
return 0
```

- 这里用的是固定窗口，边界处可能短时间内发出两倍条数；验证码这类要求严格的场景可以改成滑动窗口，几种算法的差别见 [限流与过载保护](/high-avail/7_rate_limiting)
- 验证码的频控要同时按手机号、设备、IP 三个维度计，只按手机号拦不住换号刷接口的攻击，图形验证与风控见 [API 安全](/security/6_api_security)
- 被频控拦下的营销消息直接丢弃，不要攒到下个窗口补发；交易类通知原则上不做用户级频控

### 2、免打扰与静默时段

免打扰按**用户所在时区**计算，默认如 22:00 到次日 08:00，用户可以自己设置。P0、P1 不受影响，P2、P3 推迟到静默结束后再发：

```java
public Optional<Instant> deferUntil(Priority priority, UserPref pref, Instant now) {
    if (priority.compareTo(Priority.P1) <= 0) {
        return Optional.empty();                          // 验证码、交易通知不受免打扰限制
    }
    ZonedDateTime local = now.atZone(pref.zoneId());
    QuietWindow w = pref.quietWindow();                   // 如 22:00–08:00，可以跨零点
    if (!w.contains(local.toLocalTime())) {
        return Optional.empty();
    }
    ZonedDateTime end = local.with(w.end());
    if (!end.isAfter(local)) {
        end = end.plusDays(1);
    }
    // 加随机打散：几百万条推迟的消息不能在 8:00 整同时发出
    return Optional.of(end.toInstant().plusSeconds(ThreadLocalRandom.current().nextLong(3600)));
}
```

- 推迟的任务用 RocketMQ 5 的定时消息投递，或写入任务表的 `next_retry_at` 由调度扫描，后者不受 Broker 最大延迟配置的限制，两者对比见 [RocketMQ](/messaging/3_rocketmq)
- 有时效的消息（「直播 10 分钟后开始」）设置过期时间，推迟后已过期的直接丢弃，而不是第二天早上再发
- 系统级也可以有静默时段，比如夜间整体暂停营销推送，与用户设置取并集

---

## 七、去重与幂等

重复来自三处，分别处理：

| 来源 | 例子 | 处理 |
|------|------|------|
| 上游重复 | 业务事件重复投递、调用方超时重试 | 任务表唯一键 `dedup_key`，插入冲突即已处理 |
| 自己重复 | 消息队列重复消费、补偿任务和正常消费同时执行 | 状态机 CAS：只有把状态从「待处理」改成「发送中」成功的那个线程才真正发送 |
| 服务商重复 | 调用超时，实际已受理，再发一次用户收到两条 | 无法完全避免，见下文 |

```sql
CREATE TABLE notify_task (
    id              BIGINT       PRIMARY KEY,         -- notifyId，分布式 ID，内嵌分片位
    dedup_key       VARCHAR(160) NOT NULL,            -- bizType:bizId:templateCode:接收人:渠道
    user_id         BIGINT       NOT NULL,
    channel         TINYINT      NOT NULL,
    template_code   VARCHAR(64)  NOT NULL,
    priority        TINYINT      NOT NULL,
    status          TINYINT      NOT NULL,            -- 见第九节
    reason          VARCHAR(64),                      -- 过滤或失败原因
    supplier        VARCHAR(32),
    supplier_msg_id VARCHAR(64),
    attempts        TINYINT      NOT NULL DEFAULT 0,
    next_retry_at   DATETIME(3),
    created_at      DATETIME(3)  NOT NULL,
    updated_at      DATETIME(3)  NOT NULL,
    UNIQUE KEY uk_dedup (dedup_key),
    KEY idx_user_time (user_id, created_at),
    KEY idx_retry (status, next_retry_at)
);
```

- 表按 `user_id` 分库分表，`dedup_key` 里包含接收人，同一个幂等键一定落在同一个分片，唯一约束有效；无账号的验证码按手机号哈希路由
- **服务商超时的处理**：先按 notifyId 查询服务商的发送状态，查到已受理就不重发；查不到时，验证码直接重新生成一个新码再发（两条都能用，或旧码作废），营销消息宁可少发也不重发
- **内容聚合**：同一用户短时间内的同类互动通知，可以在发送前合并成「你收到了 5 条新评论」，减少打扰，这是去重的业务版本
- 幂等的通用做法见 [幂等设计](/architecture/3_idempotence) 与 [幂等消费](/messaging/1_basics#四、幂等消费)

---

## 八、失败重试、降级与多供应商切换

### 1、错误分类

| 类型 | 例子 | 处理 |
|------|------|------|
| 可重试 | 连接超时、5xx、服务商限流（429） | 退避重试，限流按服务商返回的等待时间 |
| 不可重试：接收方问题 | 空号、停机、设备 token 失效、邮箱不存在 | 直接失败；token 失效要删除，硬退信的邮箱加入抑制名单 |
| 不可重试：自身问题 | 模板未审核、签名不匹配、参数超长 | 直接失败并告警，这是配置错误，重试没有意义 |
| 合规拦截 | 用户已退订、命中黑名单 | 记为已过滤 |

错误码归类在适配器里完成，每家服务商一张映射表；不认识的错误码按可重试处理，同时告警，便于补全映射。

### 2、退避重试

- 指数退避加随机抖动，如 10 秒、30 秒、2 分钟、10 分钟；P0 不做时间上的退避，而是马上换下一家服务商，原因见 [超时、重试与隔离](/high-avail/4_timeout_retry_bulkhead#_2、指数退避与随机抖动)
- 重试次数和最长重试时间按级别设定，超过时效的消息（验证码有效期 5 分钟）不再重试
- 重试通过任务表的 `next_retry_at` 或延迟消息实现，不要在消费线程里 `sleep`

### 3、多供应商路由与熔断

```java
public SendResult sendWithFailover(RenderedMessage msg, NotifyTask task) {
    // 按权重排序，跳过已熔断的，以及本任务已经试过的服务商
    for (String supplier : router.candidates(task.channel(), task.triedSuppliers())) {
        SendResult r = senders.get(task.channel()).send(msg, supplier);
        router.record(supplier, r);                       // 计入该服务商的成功率窗口
        if (!(r instanceof SendResult.Retryable)) {
            return r;                                     // 受理或不可重试，都不再换
        }
        task.markTried(supplier);
        if (task.priority() != Priority.P0) {
            return r;                                     // 非 P0 交给退避重试，下次再换
        }
    }
    return new SendResult.Retryable("ALL_SUPPLIERS_FAILED", Duration.ofSeconds(30));
}
```

- **健康度不只看接口成功率**：短信服务商接口返回成功，但运营商侧大面积失败的情况很常见，所以要同时看最近几分钟的回执成功率；回执成功率明显下降就降低权重或摘除
- 熔断按「服务商 × 渠道 × 运营商」粒度，某家服务商只是移动号段出问题时，不必整体摘除，熔断参数见 [熔断](/high-avail/5_circuit_breaking)
- 切换服务商时注意模板：每家服务商的模板 ID 不同，模板表要为每家各存一份，且都要审核通过，否则故障时切过去才发现发不出去

### 4、渠道降级

| 情况 | 降级 |
|------|------|
| 推送失败或用户没有可用设备 | 重要通知改发短信；互动、营销只保留站内信 |
| 短信全部服务商不可用 | 验证码改为语音验证码或邮件验证码，由业务侧提示用户 |
| 邮件服务商故障 | 账单类延后重发，不降级到短信（成本与内容长度都不合适） |

降级规则配置在模板上，执行器只按配置执行，不写在代码里。

---

## 九、送达回执与状态机

![通知任务状态机](../assets/scenario/notification-state.svg)

| 渠道 | 能拿到什么 | 怎么拿 |
|------|------------|--------|
| 短信 | 运营商状态报告：成功、空号、停机、拦截等 | 服务商回调，或定时批量拉取 |
| 邮件 | 退信（硬退、软退）、投诉、打开与点击 | 服务商回调；打开率靠图片像素，只能作参考 |
| APNs / FCM | 接口只告诉你「已受理」，不保证到达设备 | 客户端 SDK 收到推送后上报到达，点击时上报点击 |
| 国内厂商通道 | 多数提供送达与点击回执 | 回调 |
| 站内信 | 写入即送达；用户打开记为已读 | 自己记录 |

- **两段推进**：发送阶段由执行器用 CAS 推进（`WHERE status = 原状态`），保证同一任务只有一个线程在发；回执阶段按状态序号条件更新，`UPDATE ... SET status = ? WHERE id = ? AND status < ?`，「已送达」回执先到、「已提交」后写入时，后者不会把状态改回去
- **回执按 notifyId 定位**：发送时把 notifyId 透传给服务商作为外部流水号，回调带回来后直接路由到分片；不支持透传的服务商才按 `supplier_msg_id` 查映射
- **回执会缺失**：提交后 72 小时还没有回执，标记为回执超时，统计送达率时单独列出，不算成功也不算失败
- 回执回调接口要验签，并且自己先落库再异步处理，尽快返回成功，否则服务商会反复重推

---

## 十、站内信存储模型

### 1、个人消息写扩散，全员公告读扩散

| 类型 | 接收人数 | 存储方式 | 原因 |
|------|----------|----------|------|
| 个人消息 | 1 人或少量 | 写扩散：每个接收人收件箱一行 | 读取简单，可以单条标记已读、删除 |
| 人群定向通知 | 几万到几十万 | 写扩散，批量匀速写入 | 人群固定、量可控 |
| 全员公告 | 全部用户 | 读扩散：只存一份，读取时合并 | 写扩散一次就是上亿行，大部分用户根本不会看 |

这和 Feed 流的推拉结合是同一个取舍，思路见 [Feed 流和消息推送](./8_feed_stream#五、推拉结合)。

```sql
CREATE TABLE inbox_message (                  -- 个人消息：按 user_id 分库分表
    user_id    BIGINT        NOT NULL,
    msg_id     BIGINT        NOT NULL,        -- 趋势递增的分布式 ID，兼做翻页游标
    category   TINYINT       NOT NULL,        -- 1 系统 2 交易 3 互动
    title      VARCHAR(128)  NOT NULL,
    body       VARCHAR(1024) NOT NULL,
    link       VARCHAR(512),
    is_read    TINYINT       NOT NULL DEFAULT 0,
    created_at DATETIME(3)   NOT NULL,
    PRIMARY KEY (user_id, msg_id),
    KEY idx_user_cat (user_id, category, msg_id)
);

CREATE TABLE announcement (                   -- 全员公告：只存一份
    id         BIGINT        PRIMARY KEY,     -- 递增
    audience   VARCHAR(256)  NOT NULL,        -- ALL、平台、版本范围等简单条件
    title      VARCHAR(128)  NOT NULL,
    body       TEXT          NOT NULL,
    publish_at DATETIME(3)   NOT NULL,
    expire_at  DATETIME(3)   NOT NULL,
    status     TINYINT       NOT NULL
);

CREATE TABLE user_announce_cursor (           -- 每个用户读到哪条公告
    user_id    BIGINT        PRIMARY KEY,
    read_upto  BIGINT        NOT NULL
);
```

- 有效期内的公告通常只有几十条，整表放在本地缓存里；用户打开公告页时，取 `id > read_upto` 且符合 `audience` 条件的公告就是未读，打开后把 `read_upto` 更新为最新的公告 ID
- 需要逐条已读状态时，只为「已读」建稀疏记录 `(user_id, announcement_id)`，没读的不存
- 收件箱按 `msg_id` 游标翻页，不用 offset；超过 90 天的消息迁到归档库或直接删除，冷热分离见 [即时通讯](./16_im#_2、冷热分离)

### 2、未读数

每个用户一个 Redis Hash `unread:{userId}`，field 是消息类别，value 是未读条数：

- **写入**：消费者写入收件箱成功后 `HINCRBY +1`，插入冲突（重复消费）时不加
- **单条已读**：`UPDATE inbox_message SET is_read = 1 WHERE user_id = ? AND msg_id = ? AND is_read = 0`，影响行数为 1 才 `HINCRBY -1`，重复点击不会减成负数
- **全部已读**：更新该类别所有未读行后，把 field 直接置 0
- **公告未读**不存计数，按上一小节现算，结果与个人消息的未读数相加后展示
- **偏差收敛**：Redis 丢数据或计数不准时，以数据库 `COUNT` 重建；界面显示「99+」，不需要精确到个位。更大规模下计数的合并写与校准见 [计数服务](./17_counter)

### 3、在线实时提醒

用户在线时，站内信写入后经长连接推一条只含类别和未读数的轻量通知，客户端收到后再拉列表；推送丢了，用户下次打开页面时拉取也能补上，**推送只是加速，拉取才是兜底**。长连接路由与断线补齐见 [即时通讯](./16_im#五、离线消息与多端同步)。

---

## 十一、用户订阅偏好

| 维度 | 例子 | 是否允许关闭 |
|------|------|--------------|
| 类别 × 渠道 | 「互动提醒」不要推送，只要站内信 | 互动、营销可以关；安全、交易类不可关闭 |
| 营销总开关 | 不接收任何营销消息 | 必须提供，短信回复退订、邮件一键退订都要生效 |
| 静默时段与时区 | 23:00–07:00 | 可设置 |
| 系统权限 | 用户在手机系统设置里关掉了 App 通知 | 不归我们管，但推送会发不出去，应在 App 内提示 |

```sql
CREATE TABLE user_notify_pref (
    user_id   BIGINT   NOT NULL,
    category  TINYINT  NOT NULL,
    channel   TINYINT  NOT NULL,
    enabled   TINYINT  NOT NULL,
    PRIMARY KEY (user_id, category, channel)
);
```

- **只存与默认值不同的设置**：绝大多数用户从不修改，没有记录就取类别的默认值，表的数据量与修改过设置的人数成正比
- 偏好读多写少，放 Redis 并在本地做短时间缓存；用户修改后删除缓存
- 退订必须在全部服务商、全部渠道一致生效：短信退订回执、邮件退订链接都回写到同一张偏好表，而不是各家服务商各自维护

---

## 十二、可观测

| 指标 | 计算 | 用途 |
|------|------|------|
| 过滤率 | 已过滤数 ÷ 任务数，按原因拆分 | 频控阈值是否过严，退订是否突增 |
| 提交成功率 | 已提交 ÷ 进入发送的任务数，按服务商 | 服务商接口是否异常 |
| 送达率 | 已送达 ÷ 已提交，按渠道、服务商、运营商、模板 | 核心质量指标，验证码送达率下降要立即告警 |
| 端到端延迟 | 回执时间 − 业务事件时间的 P50、P99 | 验证码 P99 超过 10 秒说明链路有问题 |
| 队列积压 | 各优先级 Topic 的消费延迟 | P0 有积压就告警 |
| 点击率、退订率 | 点击数 ÷ 送达数 | 衡量营销效果与打扰程度 |

- 指标标签控制基数：按服务商、渠道、模板打标签可以，**不能按用户 ID 打标签**，指标设计见 [指标](/observability/2_metrics)
- notifyId 贯穿接入、编排、发送、回执的全部日志，并与业务方的 traceId 关联，链路追踪见 [链路追踪](/observability/3_tracing)
- 给客服提供「按手机号或用户查最近通知」的工具，能看到每条消息停在哪个状态、为什么被过滤，「我没收到验证码」这类问题大部分能当场定位
- 告警规则：验证码送达率、P0 队列积压、单个服务商错误率三项要分钟级告警，告警设计见 [告警](/observability/4_alerting)

---

## 十三、容量估算

假设注册用户 2 亿、DAU 5,000 万，每天：站内信 2 亿条，App 推送 1 亿条，短信 500 万条（其中验证码 300 万），邮件 1,000 万封。峰值按均值的 3 倍，存储按 1 KB ≈ 1,000 B 估算。

**发送吞吐**：

| 项 | 计算 | 结果 |
|----|------|------|
| 日总量 | 2 亿 + 1 亿 + 0.05 亿 + 0.1 亿 | 3.15 亿条 |
| 平均 | 315,000,000 ÷ 86,400 | 约 3,646 条/秒 |
| 日常峰值 | 3,646 × 3 | 约 1.1 万条/秒 |
| 营销推送 | 全量 5,000 万人在 30 分钟内发完：50,000,000 ÷ 1,800 | 约 2.8 万条/秒 |
| 验证码 | 3,000,000 ÷ 86,400 × 5（登录高峰按 5 倍） | 约 174 条/秒 |

营销推送是吞吐的上限，执行器按单实例 2,000 次/秒估算，27,778 ÷ 2,000 ≈ 14 个，按 1.5 倍冗余取 21 个；验证码的量很小，瓶颈不在吞吐而在服务商的限速与稳定性，所以要多家服务商、单独通道。

**存储**：

| 项 | 计算 | 结果 |
|----|------|------|
| 发送任务（不含站内信） | (1 亿 + 0.05 亿 + 0.1 亿) × 500 B | 每天约 57.5 GB |
| 任务热数据 | 57.5 GB × 7 天 | 约 403 GB，更早的转到列存或对象存储供查询 |
| 站内信 | 2 亿 × 300 B | 每天约 60 GB，保留 90 天约 5.4 TB |
| 站内信分片 | 5.4 TB ÷ 16 个库 | 每库约 338 GB |
| 未读数 | 5,000 万活跃用户 × 约 100 B | 约 5 GB |

**全员公告用写扩散的代价**：2 亿 × 300 B = 60 GB，与一整天的个人站内信相当；按 5 万行/秒批量写入要 200,000,000 ÷ 50,000 = 4,000 秒，约 67 分钟。读扩散只写 1 行，这就是公告必须读扩散的原因。

**站内信写入**：2 亿 ÷ 86,400 ≈ 2,315 条/秒，峰值约 6,944 条/秒，分到 16 个库每库约 434 条/秒，压力不大。以上单机数值都要以压测为准，估算方法见 [容量评估与规划](/high-con/8_capacity_planning)。

---

## 小结

- 通知中心统一接入站内信、短信、邮件、推送和企业 IM，业务方只给模板编码、接收人和变量；它只负责送达，不做业务判断
- 发送链路：去重落任务 → 偏好、频控、免打扰过滤 → 渲染与选渠道 → 按优先级入队 → 执行器发送 → 回执推进状态；任务表在第一步落库，每一步都可以补偿
- 验证码、交易、互动、营销分 Topic、分消费组、分服务商通道隔离，营销任务用令牌桶匀速放量
- 频控分用户、类别、模板、服务商四层，用户级多个窗口用一个 Lua 脚本原子判断；免打扰按用户时区推迟并随机打散
- 幂等键由通知中心按业务字段拼出，配合唯一约束和状态机 CAS；服务商超时先查状态，验证码宁可重发新码
- 错误先分类再决定重试、失败或告警；多服务商按回执成功率调权重与熔断，P0 失败立即切换
- 状态只前进，乱序回执不回退；回执缺失单独统计
- 站内信个人消息写扩散、全员公告读扩散，未读数存 Redis Hash，按影响行数增减，偏差以数据库重建

## 参考资料

- Apple：Sending notification requests to APNs：[https://developer.apple.com/documentation/usernotifications/sending-notification-requests-to-apns](https://developer.apple.com/documentation/usernotifications/sending-notification-requests-to-apns)
- Firebase Cloud Messaging HTTP v1 API：[https://firebase.google.com/docs/reference/fcm/rest/v1/projects.messages](https://firebase.google.com/docs/reference/fcm/rest/v1/projects.messages)
- RFC 8058：Signaling One-Click Functionality for List Email Headers：[https://www.rfc-editor.org/rfc/rfc8058](https://www.rfc-editor.org/rfc/rfc8058)
- RocketMQ 定时 / 延时消息：[https://rocketmq.apache.org/docs/featureBehavior/02delaymessage/](https://rocketmq.apache.org/docs/featureBehavior/02delaymessage/)
- Redis EVAL 与脚本：[https://redis.io/docs/latest/develop/interact/programmability/eval-intro/](https://redis.io/docs/latest/develop/interact/programmability/eval-intro/)

> 下一篇：[评论系统](./21_comment) —— 楼中楼、热评排序、审核与计数。
