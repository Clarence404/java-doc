---
description: 二维码状态机、Lua 原子迁移、长轮询 / WebSocket 推送、PC 会话换发、防钓鱼与一次性绑定、容量估算
---

# 扫码登录

> **本篇目标**：设计一个 PC 端扫码登录，做到二维码状态迁移原子且可重复请求、PC 能及时拿到结果而不把轮询压力压到 Redis 上、PC 拿到的是新签发的会话而不是手机令牌，并清楚钓鱼扫码、二维码泄露这些攻击各靠哪一环挡住。
>
> **前置阅读**：[分布式会话](/distributed/5_session)、[JWT 令牌机制](/security/1_jwt)、[WebSocket](/netty/10_websocket)、[Redis 典型应用场景](/cache/4_redis_scenario)

扫码登录把「输入账号密码」换成「用已经登录的手机替 PC 做担保」：PC 展示一个一次性二维码，手机扫码并确认后，服务端给 PC 签发一个新的会话。它本质上是一个**跨设备的授权流程**，核心是三件事：二维码状态怎么安全地流转、PC 怎么知道状态变了、PC 最终拿到什么凭证。

---

## 一、需求与挑战

### 1、需求

| 角色 | 动作 | 要求 |
|------|------|------|
| PC 浏览器 | 申请二维码、等待结果、换取会话 | 未登录；扫码后 1 秒内感知到状态变化 |
| 手机 App | 扫码、确认、取消 | 已登录；确认前能看到是哪台设备、在哪里申请登录 |
| 服务端 | 维护二维码状态、签发 PC 会话 | 状态只能按规定方向前进；一个二维码只能换出一个会话 |

### 2、挑战

| 挑战 | 说明 |
|------|------|
| 状态并发 | 两部手机同时扫同一个码、手机重复点确认、确认与过期同时发生，状态不能错乱 |
| 结果通知 | 大量 PC 同时停在登录页等待，短轮询会把 QPS 放大几十倍 |
| 凭证隔离 | 手机令牌权限大、有效期长，不能交给浏览器 |
| 钓鱼扫码 | 攻击者把自己 PC 上的二维码转发给受害者，受害者一扫一确认，攻击者就登录了 |
| 二维码泄露 | qrId 出现在截图、日志里，别人拿 qrId 抢先换走会话 |

---

## 二、整体架构

![扫码登录整体架构](../assets/scenario/qr-login-arch.svg)

| 组件 | 职责 |
|------|------|
| 接入网关 | HTTPS 终结、按 IP 限流申请二维码、校验手机令牌、透传真实客户端 IP |
| 扫码登录服务 | 生成二维码、Lua 原子迁移状态、维护等待中的 PC 请求、状态变化后通知 |
| Redis | 存二维码状态，TTL 到期自动删除；Pub/Sub 在实例间广播状态变化 |
| 风控服务 | IP 归属地解析、PC 与手机异地判断、扫码频次异常判断 |
| 认证中心 | 为 PC 签发独立的会话令牌，登记到用户的登录设备列表 |

扫码登录服务本身无状态，二维码数据全部在 Redis；它只在内存里保存「哪些 PC 请求正在等待哪个 qrId」，这部分丢了也只是让 PC 晚一点（下一次轮询）拿到结果。

![扫码登录流程](../assets/scenario/qr-login-flow.svg)

1. **PC 申请二维码**：服务端生成 128 位随机 `qrId`，Redis 写入 `WAITING` 状态与 PC 的 IP、User-Agent，TTL 120 秒；同时给 PC 下发一个**绑定 Cookie**，Redis 只存它的 SHA-256
2. **PC 等待结果**：长轮询或 WebSocket 按 `qrId` 等待状态变化，返回值只有状态，不含任何令牌
3. **手机扫码**：App 带着手机令牌调用扫码接口，状态迁移到 `SCANNED` 并记录 `userId`，接口返回 PC 的设备与归属地，App 展示确认页
4. **用户确认**：状态迁移到 `CONFIRMED`，发布状态变化，唤醒等待中的 PC
5. **PC 换发令牌**：PC 带绑定 Cookie 调用换发接口，Lua 校验状态与绑定哈希后**删除 key**，认证中心签发 PC 会话写入 HttpOnly Cookie

---

## 三、二维码与状态机

### 1、二维码里放什么

二维码内容是一个本站域名的 URL，如 `https://login.example.com/qr?id=<qrId>`，**只含 qrId，不含任何用户信息或令牌**：

- `qrId` 用 `SecureRandom` 生成 16 字节随机数，Base64URL 编码约 22 个字符，不可枚举、不可预测；不能用自增 ID 或时间戳
- 用 URL 而不是裸 ID：系统相机扫到时可以跳转到下载页或 App；App 内扫码时只处理本站域名，其他域名的码一律不当作登录码

### 2、状态机

![二维码状态机](../assets/scenario/qr-login-state.svg)

| 状态 | 含义 | 允许的下一步 | PC 页面表现 |
|------|------|--------------|-------------|
| WAITING | 等待扫描 | SCANNED | 展示二维码 |
| SCANNED | 已被某个用户扫描 | CONFIRMED、CANCELLED | 「已扫描，请在手机上确认」，可展示脱敏昵称 |
| CONFIRMED | 用户已确认 | 被 PC 领取（删除 key） | 自动调用换发接口 |
| CANCELLED | 用户在手机上取消 | 无（终态） | 「已取消」，提供刷新按钮 |
| EXPIRED | key 不存在：TTL 到期或已被领取 | 无（终态） | 「二维码已过期」，提供刷新按钮 |

- **过期不需要定时任务**：所有状态共用一个 key 的 TTL，`HSET` 修改字段不会重置 TTL，到期 Redis 自动删除，读不到就是过期
- 一个用户扫码后，二维码就绑定到他的 `userId`，之后的确认、取消必须是同一个用户，另一部手机再扫只会得到「已被扫描」
- 过期后 PC 停止等待并提示手动刷新，**不要无限自动刷新**：无人值守的登录页会一直消耗二维码和连接

### 3、原子状态迁移

「先读状态、判断、再写状态」分成多条命令时，两部手机同时扫码会都读到 `WAITING`、都写成功。所以每次迁移用一个 Lua 脚本完成「比较 + 写入」，Redis 单线程执行脚本，天然原子：

```java
public enum QrStatus { WAITING, SCANNED, CONFIRMED, CANCELLED, EXPIRED }
public record QrTicket(String qrId, String bindToken) {}
public record PcInfo(String userAgent, String location) {}

@Service
public class QrLoginService {

    public static final String CHANNEL = "qr:changed";
    private static final Duration TTL = Duration.ofSeconds(120);

    private static final RedisScript<Long> CREATE = RedisScript.of("""
            redis.call('HSET', KEYS[1], 'status', 'WAITING', 'fp', ARGV[1], 'ip', ARGV[2], 'ua', ARGV[3])
            redis.call('EXPIRE', KEYS[1], ARGV[4])
            return 1
            """, Long.class);

    // 1 成功（含重复请求）；0 当前状态不允许；-1 key 不存在；-2 不是扫码的那个用户
    private static final RedisScript<Long> TRANSIT = RedisScript.of("""
            local st = redis.call('HGET', KEYS[1], 'status')
            if not st then return -1 end
            local uid = redis.call('HGET', KEYS[1], 'uid')
            if st == ARGV[2] and uid == ARGV[3] then return 1 end
            if st ~= ARGV[1] then return 0 end
            if st == 'WAITING' then
              redis.call('HSET', KEYS[1], 'uid', ARGV[3])
            elseif uid ~= ARGV[3] then
              return -2
            end
            redis.call('HSET', KEYS[1], 'status', ARGV[2])
            return 1
            """, Long.class);

    // 只有 CONFIRMED 才能领取；领取即删除，无论绑定校验是否通过
    private static final RedisScript<String> EXCHANGE = RedisScript.of("""
            local h = redis.call('HMGET', KEYS[1], 'status', 'fp', 'uid')
            if not h[1] then return 'EXPIRED' end
            if h[1] ~= 'CONFIRMED' then return h[1] end
            redis.call('DEL', KEYS[1])
            if h[2] ~= ARGV[1] then return 'FP_MISMATCH' end
            return 'OK:' .. h[3]
            """, String.class);

    private final StringRedisTemplate redis;
    private final GeoIpClient geoIp;
    private final SecureRandom random = new SecureRandom();

    public QrLoginService(StringRedisTemplate redis, GeoIpClient geoIp) {
        this.redis = redis;
        this.geoIp = geoIp;
    }

    public QrTicket create(String ip, String userAgent) {
        String qrId = randomToken();
        String bind = randomToken();
        redis.execute(CREATE, List.of(key(qrId)), sha256(bind), ip, userAgent,
                String.valueOf(TTL.toSeconds()));
        return new QrTicket(qrId, bind);
    }

    public long transit(String qrId, QrStatus from, QrStatus to, long userId) {
        Long r = redis.execute(TRANSIT, List.of(key(qrId)), from.name(), to.name(), String.valueOf(userId));
        if (r != null && r == 1) {
            redis.convertAndSend(CHANNEL, qrId);   // 只用来加速通知，丢失时由轮询超时兜底
        }
        return r == null ? -1 : r;
    }

    public Optional<Long> exchange(String qrId, String bindToken) {
        String r = redis.execute(EXCHANGE, List.of(key(qrId)), sha256(bindToken));
        return r != null && r.startsWith("OK:") ? Optional.of(Long.valueOf(r.substring(3))) : Optional.empty();
    }

    public QrStatus status(String qrId) {
        Object st = redis.opsForHash().get(key(qrId), "status");
        return st == null ? QrStatus.EXPIRED : QrStatus.valueOf((String) st);
    }

    public PcInfo pcInfo(String qrId) {
        List<Object> v = redis.opsForHash().multiGet(key(qrId), List.of("ua", "ip"));
        return new PcInfo((String) v.get(0), geoIp.locate((String) v.get(1)));
    }

    private String randomToken() {
        byte[] b = new byte[16];
        random.nextBytes(b);
        return Base64.getUrlEncoder().withoutPadding().encodeToString(b);
    }

    private static String sha256(String s) {
        try {
            byte[] d = MessageDigest.getInstance("SHA-256").digest(s.getBytes(StandardCharsets.UTF_8));
            return HexFormat.of().formatHex(d);
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    private static String key(String qrId) {
        return "qr:" + qrId;
    }
}
```

手机端接口只是把 `transit` 的结果翻译成 HTTP 状态，`userId` 由前置的认证过滤器从手机令牌中解析：

```java
@RestController
@RequestMapping("/api/app/qr")
public class QrAppController {

    private final QrLoginService qr;

    public QrAppController(QrLoginService qr) {
        this.qr = qr;
    }

    @PostMapping("/{qrId}/scan")
    public ResponseEntity<PcInfo> scan(@PathVariable String qrId, @RequestAttribute("userId") long userId) {
        if (qr.transit(qrId, QrStatus.WAITING, QrStatus.SCANNED, userId) != 1) {
            return ResponseEntity.status(HttpStatus.GONE).build();   // 已过期或已被他人扫描
        }
        return ResponseEntity.ok(qr.pcInfo(qrId));                   // 确认页展示 PC 设备与归属地
    }

    @PostMapping("/{qrId}/confirm")
    public ResponseEntity<Void> confirm(@PathVariable String qrId, @RequestAttribute("userId") long userId) {
        long r = qr.transit(qrId, QrStatus.SCANNED, QrStatus.CONFIRMED, userId);
        return r == 1 ? ResponseEntity.noContent().build() : ResponseEntity.status(HttpStatus.GONE).build();
    }
    // cancel 与 confirm 相同，只是目标状态为 CANCELLED
}
```

- **重复请求天然幂等**：手机网络抖动重发确认时，状态已是 `CONFIRMED` 且 `uid` 相同，脚本直接返回成功，不需要额外的去重 key。这是用状态机做幂等的典型写法，通用方案见 [幂等设计](/architecture/5_idempotence)
- **创建也用脚本**：`HSET` 与 `EXPIRE` 分两条命令时，进程在中间崩溃会留下永不过期的 key；所有脚本只操作一个 key，Redis Cluster 下没有跨 slot 问题

---

## 四、PC 如何获取结果

### 1、三种方式对比

| 方式 | 做法 | 实时性 | 服务端压力 | 适用 |
|------|------|--------|------------|------|
| 短轮询 | 每 1–2 秒 GET 一次状态 | 取决于间隔，平均延迟半个间隔 | 请求数 = 等待中的 PC 数 ÷ 间隔，每次都读 Redis | 流量小的内部系统，实现最简单 |
| 长轮询 | 请求挂起直到状态变化或 25 秒超时 | 状态变化后立即返回 | 超时重连约为 2 秒短轮询的 1/12，但要挂起大量连接 | 通用首选，穿透代理与防火墙最省心 |
| WebSocket | 建连后服务端主动推送状态 | 立即 | 每个 PC 一条长连接，加心跳 | 页面已有 WebSocket 通道，或还要推送其他消息 |

扫码登录一次只需要等 2–3 次状态变化，**长轮询**性价比最高：不需要额外的协议升级与心跳，又能做到秒级通知。超时取 25 秒，小于网关、Nginx 常见的 60 秒读超时，避免被中间层先断开。

### 2、长轮询实现

难点在于 PC 的请求挂在实例 B 上，而手机的确认请求可能落到实例 A。做法是：状态迁移成功后在 Redis 发布 `qrId`，所有实例订阅该频道，各自唤醒本地挂起的请求。

```java
@RestController
@RequestMapping("/api/qr")
public class QrPcController {

    public record StatusView(QrStatus status) {}

    private final QrLoginService qr;
    private final WebSessionIssuer sessions;   // 认证中心客户端
    private final ConcurrentMap<String, Set<DeferredResult<StatusView>>> waiters = new ConcurrentHashMap<>();

    public QrPcController(QrLoginService qr, WebSessionIssuer sessions) {
        this.qr = qr;
        this.sessions = sessions;
    }

    @PostMapping
    public ResponseEntity<Map<String, String>> create(HttpServletRequest req) {
        String ua = Objects.requireNonNullElse(req.getHeader(HttpHeaders.USER_AGENT), "");
        QrTicket t = qr.create(req.getRemoteAddr(), ua);
        ResponseCookie bind = ResponseCookie.from("qr_bind", t.bindToken())
                .httpOnly(true).secure(true).sameSite("Strict").path("/api/qr").maxAge(Duration.ofMinutes(2)).build();
        return ResponseEntity.ok().header(HttpHeaders.SET_COOKIE, bind.toString())
                .body(Map.of("qrId", t.qrId(), "content", "https://login.example.com/qr?id=" + t.qrId()));
    }

    @GetMapping("/{qrId}/status")
    public DeferredResult<StatusView> poll(@PathVariable String qrId, @RequestParam QrStatus seen) {
        DeferredResult<StatusView> result = new DeferredResult<>(25_000L, () -> new StatusView(qr.status(qrId)));
        waiters.compute(qrId, (k, set) -> {
            Set<DeferredResult<StatusView>> s = set != null ? set : ConcurrentHashMap.newKeySet();
            s.add(result);
            return s;
        });
        result.onCompletion(() -> waiters.computeIfPresent(qrId, (k, s) -> {
            s.remove(result);
            return s.isEmpty() ? null : s;
        }));
        // 先登记再读状态：避免「读完状态、登记之前」发生的变化被漏掉
        QrStatus now = qr.status(qrId);
        if (now != seen) {
            result.setResult(new StatusView(now));
        }
        return result;
    }

    public void onChanged(String qrId) {           // Redis 订阅回调
        Set<DeferredResult<StatusView>> set = waiters.remove(qrId);
        if (set != null) {
            StatusView view = new StatusView(qr.status(qrId));
            set.forEach(r -> r.setResult(view));
        }
    }

    @PostMapping("/{qrId}/exchange")
    public ResponseEntity<Void> exchange(@PathVariable String qrId, @CookieValue("qr_bind") String bind,
                                         HttpServletRequest req) {
        return qr.exchange(qrId, bind)
                .map(userId -> {
                    String sid = sessions.issueWebSession(userId, req.getHeader(HttpHeaders.USER_AGENT));
                    ResponseCookie c = ResponseCookie.from("SID", sid).httpOnly(true).secure(true)
                            .sameSite("Lax").path("/").maxAge(Duration.ofHours(12)).build();
                    return ResponseEntity.noContent().header(HttpHeaders.SET_COOKIE, c.toString()).<Void>build();
                })
                .orElseGet(() -> ResponseEntity.status(HttpStatus.GONE).build());
    }
}

@Configuration
class QrPubSubConfig {

    @Bean
    RedisMessageListenerContainer qrListener(RedisConnectionFactory cf, QrPcController controller) {
        RedisMessageListenerContainer c = new RedisMessageListenerContainer();
        c.setConnectionFactory(cf);
        c.addMessageListener((message, pattern) ->
                controller.onChanged(new String(message.getBody(), StandardCharsets.UTF_8)),
                new ChannelTopic(QrLoginService.CHANNEL));
        return c;
    }
}
```

- PC 首次请求带 `seen=WAITING`，之后每次带上一次拿到的状态；状态变为 `CONFIRMED` 时前端立刻调用 `exchange`，变为终态时停止轮询
- **Redis 是唯一事实来源，Pub/Sub 只是加速**：Pub/Sub 不持久化，订阅连接断开期间的消息会丢，最坏情况是 PC 等到 25 秒超时后拿到最新状态
- `DeferredResult` 挂起期间不占用 Servlet 线程，但每个请求仍占一条 TCP 连接。Tomcat 的 `server.tomcat.max-connections` 默认 8192，单实例要挂 1 万个请求时需要调大
- 服务在网关之后时 `getRemoteAddr()` 拿到的是网关地址，需要配置 `server.forward-headers-strategy` 并只信任网关写入的转发头

### 3、WebSocket 推送

页面本身已经有 WebSocket 通道（如站内消息）时，可以直接复用：PC 建连后订阅 `qrId`，`onChanged` 改为向该连接推送状态。跨实例广播仍然用同一个 Redis 频道。推送消息里同样只有状态，**令牌仍由 PC 通过 HTTPS 调用 `exchange` 获取**，这样会话可以写进 HttpOnly Cookie，不经过 JavaScript。

WebSocket 的集群推送、连接管理见 [WebSocket](/netty/10_websocket)，心跳与断线检测见 [心跳与连接管理](/netty/9_heartbeat)；只需要服务端单向推送时也可以用 [SSE（Server-Sent Events）](/netty/11_sse)。

---

## 五、令牌签发

### 1、为什么不能把手机令牌给 PC

| 问题 | 说明 |
|------|------|
| 权限与有效期不匹配 | 手机令牌通常带 30 天级别的刷新令牌，PC 浏览器环境更容易被 XSS、恶意插件读取 |
| 无法单独吊销 | PC 与手机共用一个令牌，用户在手机上「下线 PC」会把自己的手机也踢下线 |
| 审计失真 | 日志里分不清操作来自哪台设备，异地登录、设备管理都无从做起 |
| 设备绑定失效 | 手机令牌如果绑定了设备指纹，在 PC 上使用要么失败，要么必须放宽校验 |

### 2、换发 PC 会话

`exchange` 成功后，认证中心按 `userId` 为 PC **新建一个独立会话**：

- 设备类型为 Web，记录 User-Agent、IP 与登录方式「扫码」，出现在用户的「登录设备」列表中，可以单独下线
- 有效期按 Web 端策略设置（如 12 小时，空闲 30 分钟续期），与手机令牌无关
- 每次登录都生成新的会话 ID，不复用登录前的匿名会话，防止会话固定攻击
- 会话写入 `HttpOnly`、`Secure`、`SameSite=Lax` 的 Cookie；采用 JWT 时同样放在 HttpOnly Cookie 里，不放 `localStorage`
- 扫码登录的会话属于「低强度认证」：改密码、修改收货地址、大额支付等敏感操作在 PC 上仍要求二次验证

会话存储与共享见 [分布式会话](/distributed/5_session)，JWT 的签名、刷新与吊销见 [JWT 令牌机制](/security/1_jwt)，Cookie 与 Token 的传输安全见 [API 安全](/security/6_api_security)。这个流程与 OAuth 2.0 的设备授权模式（RFC 8628）思路一致：在受限设备上展示一次性码，在另一台已认证设备上授权，再由受限设备领取自己的令牌，跨站点授权时可以直接采用 [OAuth2](/security/2_oauth2) 体系。

**换发失败**：`exchange` 先删 key 再返回，响应丢失时 PC 重试已拿不到结果，只能重新扫码。这里刻意不做「重试返回同一个会话」，那需要把会话令牌在 Redis 里多存一段时间，扩大泄露窗口，而重新扫码的代价很小。

---

## 六、安全设计

### 1、一次性与绑定 PC

- **一次性**：只有 `CONFIRMED` 状态能领取，领取脚本里直接 `DEL`，同一个二维码不可能换出第二个会话
- **绑定申请者**：PC 申请二维码时拿到随机的 `qr_bind` Cookie，Redis 只存哈希；换发时必须带上它。别人即使从截图、日志里拿到 qrId，也无法在自己的浏览器上完成换发
- 绑定校验失败时同样删除 key：这说明 qrId 已经泄露，宁可让真正的用户重新扫一次
- `qr_bind` 设置 `HttpOnly`、`SameSite=Strict` 且 path 限定在 `/api/qr`，只在扫码登录的接口间传递

### 2、钓鱼扫码（QRLJacking）

绑定 PC 挡不住这种攻击：攻击者在**自己的**浏览器上打开真实登录页，把二维码实时转贴到钓鱼页面（「扫码领红包」），受害者用 App 扫码确认后，登录的是攻击者的浏览器。这类攻击只能靠让用户看清自己在授权什么来防：

| 手段 | 做法 |
|------|------|
| 展示登录设备与位置 | 确认页显示「Windows · Chrome · 广东深圳」与申请时间，并提示「如果不是你本人在电脑上操作，请取消」 |
| 异地判断 | 风控比较 PC 的 IP 归属地与手机当前位置，不一致时加强提示，或要求输入密码、短信验证码后才能确认 |
| 只认 App 内扫码 | 登录码只在本站 App 内扫码有效，App 只处理本站域名的 URL；系统相机或第三方 App 扫到时只跳转到说明页 |
| 确认按钮不预选 | 确认页不能扫完自动确认，取消按钮与确认按钮同样醒目 |
| 登录后通知 | PC 登录成功后向手机推送「你的账号在 Windows · Chrome 登录」，附一键下线 |

### 3、过期与限流

| 项 | 建议 | 原因 |
|----|------|------|
| 二维码 TTL | 120 秒 | 缩短钓鱼页转贴的可用时间，也限制 Redis 中的 key 数量 |
| 申请二维码 | 按 IP 限流，如每分钟 10 次 | 防止脚本批量生成二维码耗尽内存 |
| 扫码 / 确认 | 按 userId 限流，异常频次交给风控 | 同一个账号短时间扫大量不同的码，通常是被诱导或账号被盗 |
| 状态查询 | 按 qrId 限制并发等待数，如每个 qrId 最多 2 个 | 防止拿到 qrId 的人挂大量长轮询 |
| 过期后 | 前端停止轮询，提示手动刷新 | 无人值守的页面不再产生请求 |

限流的实现见 [限流与过载保护](/high-avail/7_rate_limiting)。此外，`qr_bind`、会话 ID 不能写入访问日志，qrId 作为 URL 路径会出现在网关日志里，这也是需要绑定 Cookie 的原因之一。

---

## 七、容量估算

以早高峰上班时段为例：**同时停留在登录页的 PC 20 万个**，平均每个二维码存活 60 秒（被扫码或过期），**峰值扫码登录成功 1,000 次/秒**，扫码登录服务 20 个实例。

**二维码生成与 Redis 内存**（每个 key 含 status、fp、ip、ua、uid 等字段，加上 key 本身与 Hash 开销，按 400 B 估算）：

| 项 | 计算 | 结果 |
|----|------|------|
| 生成 QPS | 200,000 ÷ 60 | 约 3,333 |
| 存活 key 数 | 与等待中的 PC 数相当 | 约 20 万 |
| Redis 内存 | 200,000 × 400 B = 80,000,000 B；÷ 1,048,576 | 约 76 MB |

**三种获取结果方式的压力对比**：

| 方式 | 计算 | 结果 |
|------|------|------|
| 短轮询（2 秒） | 200,000 ÷ 2 | 10 万 QPS，每次读一次 Redis |
| 长轮询（25 秒超时） | 200,000 ÷ 25 | 8,000 QPS 超时重连；另有挂起连接 20 万 |
| 长轮询唤醒 | 1,000 × 2 次状态变化（扫码、确认） | 2,000 QPS 唤醒返回 |
| WebSocket 心跳（30 秒） | 200,000 ÷ 30 | 约 6,667 条/秒；长连接 20 万 |

- 长轮询总请求量约 8,000 + 2,000 = 10,000 QPS，是 2 秒短轮询的 1/10；每个请求登记后读一次状态，超时返回、被唤醒时各再读一次，Redis 总读压力约 10,000 + 8,000 + 2,000 = 2 万 QPS，加 3,333 次生成写入，单个分片即可承担
- 挂起连接：200,000 ÷ 20 = 每实例 1 万条，需要把 `server.tomcat.max-connections` 调到 1 万以上（如 15,000），并相应调大网关与 Nginx 的连接数和文件描述符上限
- Pub/Sub 广播：每次状态变化发布一条消息，每个实例都会收到，2,000 × 20 = 每秒 4 万次投递；消息只有 qrId 约 30 B，带宽可以忽略。实例数继续增多时，可以按 qrId 哈希把 PC 请求路由到固定实例，或改用分片频道

单机连接数与 QPS 以压测为准，估算方法见 [容量评估与规划](/high-con/8_capacity_planning)。

---

## 小结

- 扫码登录是跨设备授权：PC 展示只含随机 qrId 的二维码，已登录的手机扫码确认，服务端给 PC 签发新会话
- 二维码状态存 Redis Hash，一个 TTL 管所有状态的过期；每次迁移用 Lua 完成「比较 + 写入」，重复请求按状态机天然幂等
- PC 获取结果首选长轮询：先登记再读状态防漏通知，Redis Pub/Sub 跨实例唤醒，丢消息由 25 秒超时兜底；已有 WebSocket 通道时可复用推送
- 推送与轮询只返回状态；会话由 PC 通过 `exchange` 领取，领取即删除 key，并校验申请时下发的绑定 Cookie
- 手机令牌不交给 PC：PC 拿独立的 Web 会话，可单独下线、按 Web 策略过期，敏感操作仍要二次验证
- 钓鱼扫码靠确认页展示设备与位置、异地加强校验、只认 App 内扫码和登录通知来防，绑定 Cookie 防的是 qrId 泄露

## 参考资料

- RFC 8628 OAuth 2.0 Device Authorization Grant：[https://www.rfc-editor.org/rfc/rfc8628](https://www.rfc-editor.org/rfc/rfc8628)
- OWASP QRLJacking：[https://owasp.org/www-community/attacks/Qrljacking](https://owasp.org/www-community/attacks/Qrljacking)
- Spring MVC 异步请求（DeferredResult）：[https://docs.spring.io/spring-framework/reference/web/webmvc/mvc-ann-async.html](https://docs.spring.io/spring-framework/reference/web/webmvc/mvc-ann-async.html)
- Redis Scripting with Lua：[https://redis.io/docs/latest/develop/programmability/eval-intro/](https://redis.io/docs/latest/develop/programmability/eval-intro/)
- Redis Pub/Sub：[https://redis.io/docs/latest/develop/interact/pubsub/](https://redis.io/docs/latest/develop/interact/pubsub/)
- MDN Set-Cookie：[https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Set-Cookie](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Set-Cookie)

> 下一篇：[购物车](./19_cart) —— 数据模型、Redis Hash 与异步持久化、临时车与登录合并、实时价格库存、结算校验。
