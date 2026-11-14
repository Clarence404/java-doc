---
description: 多实例共享状态与 Redis 原子脚本、确认抢占与会话锁、Redis 出错策略、契约与多实例测试、监控落地与告警单测
---

# 生产化：共享状态与监控落地

> 前置阅读：[评估与上线](./9_eval_launch)、[分布式锁](/distributed/3_lock)、[Redis 典型应用场景](/cache/4_redis_scenario)

第 9 章的保护和监控都对，只是停在「单机、纸面」：起两个实例规则就变了，监控文件也从没真正跑过。本篇讲共享状态放进 Redis 的原子做法、Redis 出错时放行还是拒绝、熔断器为什么不共享、契约与多实例测试和监控落地，基线为 JDK 21、Spring Boot 4、Spring AI 2。

---

## 一、本章做什么

第 9 章「离生产还差什么」头一条是「状态都在一个进程里」，最后一条是「可观测只到能看」，这一章把这两条做掉：

| 问题 | 起两个实例时会怎样 | 本章的做法 |
|------|------------------|-----------|
| 每分钟次数 | 每分钟 20 次变成每个实例 20 次 | Redis 有序集合 + Lua 滑动窗口，全部实例合计 |
| 每日预算 | 每个实例一份预算 | 一份账，一轮记账是一段 Lua |
| 并发名额 | 上限 8 变成 16，压在同一台 Ollama 上 | 分布式信号量，名额带租期 |
| 待确认操作 | A 生成的卡片，「确认」落到 B 上是 404；两个实例同时收到确认各执行一次 | 哪个实例都找得到，`SET NX PX` 抢占，最多执行一次 |
| 「会话正在回答」 | 两个标签页落在两个实例上，同时答、互相覆盖记忆 | 经典分布式锁，比较令牌再删 |
| 监控文件 | 第 9 章写了面板和 9 条告警，但没跑过，指标名写错、PromQL 算出空值没人知道 | 独立 compose 跑起 Prometheus + Grafana，告警规则有单元测试，CI 里 `promtool` 校验 |

![第 10 章：两个实例共用一个 Redis，管理端口交给 Prometheus](../../assets/ai/mall-assistant-production-flow.svg)

本章新增 `state/` 包，业务类（`ChatGuard`、`McpRateLimiter`、`UsageLedger`、`ConfirmationService`、`ConversationMemory`、`ConversationOwners`）改成只认接口：

| 接口 | 内存实现（默认，前几章的数据结构原样挪出来） | Redis 实现 |
|------|------------------------------------------|-----------|
| `RateLimiter`（对话与第 8 章 MCP 共用） | `SlidingWindowLimiter` | `RedisRateLimiter` + `sliding-window.lua` |
| `ConcurrencyLimiter` | `SemaphoreConcurrencyLimiter` | `RedisConcurrencyLimiter` + `slot-acquire.lua` |
| `UsageStore` | `MemoryUsageStore` | `RedisUsageStore` + `usage-add.lua` |
| `ConfirmationStore` | `MemoryConfirmationStore` | `RedisConfirmationStore` |
| `ConversationLocks` | `MemoryConversationLocks` | `RedisConversationLocks` + `unlock.lua` |
| `OwnerCache` | `MemoryOwnerCache` | `RedisOwnerCache` |

装配是 `MemoryStateConfig` / `RedisStateConfig` 二选一，出错时的策略与冷却集中在 `StateFailures`。

---

## 二、一个开关切 memory / redis

```yaml
assistant:
  state:
    store: memory              # memory（默认，和第 9 章一样）或 redis
    on-redis-error: allow      # Redis 出错时限流与预算：allow 放行，reject 返回 503
    lease: 5m                  # 并发名额、会话锁的租期，要比一轮对话最长时间（Agent 120 秒）长
    poll-interval: 50ms        # 名额满了多久再试一次
    confirmation-wait: 10s     # 同一个确认正被别的请求执行时，最多等多久它的结果
    redis:
      url: redis://:<口令>@<主机>:6379/<库号>   # 只写进不入库的 config/application-local.yml 或环境变量 REDIS_URL
      key-prefix: "mall-assistant:"
      timeout: 500ms           # 命令超时
      connect-timeout: 1s
      cooldown: 5s             # 出错一次后多久不碰 Redis
```

**为什么一个开关管全部**（而不是像第 4、6、7 章那样每样东西一个 `store`）：这几样要么一起共享、要么一起不共享才说得清。只把确认放进 Redis、限流还在内存里，多实例时一半规则是全局的、一半是每实例的，「现在到底限的是多少」谁也说不清。指标 `assistant_state_store_info{store}` 和告警 `MallAssistantMixedStateStores` 专门抓「有个实例忘了配」。

**哪些不放 Redis**：

- **对话记忆、售后申请单**：第 6、7 章已经可以存 PostgreSQL（`store: jdbc`）。它们是「数据」，要持久、要查询；这里的是「协调用的状态」，短命、要快、要原子
- **「令牌是谁」缓存**：放进 Redis 只是每个实例少问几次商城，不共享也对，只是慢一点
- **熔断器**：有意每实例一份，见第五节

**键的约定**：每个键带前缀 `mall-assistant:`（和别的系统共用一台 Redis 时 `SCAN mall-assistant:*` 只列出自己的），每个键都会过期。一起改的几个键用花括号括出共同部分，如一天的账 `usage:{2026-11-11}:caller`、`usage:{2026-11-11}:intent`：单机 Redis 里花括号只是普通字符，到了 Redis Cluster 只有花括号里的部分参与分片，这些键就落在同一个节点——Lua 脚本要求碰的键在同一个节点，否则报 `CROSSSLOT`，现在写上换集群时不用改。

**连接自己建**：`LettuceConnectionFactory` 一条连接给所有线程共用、不需要连接池，第一次用到才建连接（Redis 没启动应用照样起得来）；命令超时 500 毫秒、连接超时 1 秒、断线立刻拒绝命令。没用 Redisson 这类现成的锁 / 限流库：它们功能更全（看门狗续期、可重入、公平锁），但这一章要讲清楚的正是「几条命令 + 一段 Lua 怎么做到原子」，生产上可以换成它们，见 [Redisson](/cache/6_redisson)。

---

## 三、原子性：一条命令、一段 Lua

Redis 单线程执行命令，**一条命令**天然原子；但「先删、再数、够了就加」是三条。两个实例同时发：A 数到 19、B 也数到 19，各加一条，变成 21 次。三种办法：

| 办法 | 适合 | 本章用在哪 |
|------|------|-----------|
| 一条命令 | 本身就是「不存在才写」「原子加」 | 确认抢占 `SET NX PX`、会话锁占用、记账里的每个 `HINCRBY` |
| Lua 脚本 | 几步要一起看一起改，执行时不会插进别的命令 | 滑动窗口、分布式名额、一轮记账、比较再删除 |
| `MULTI` / `EXEC` | 一组命令连着执行，但中间拿不到前一条的结果 | 不适合「数完再决定加不加」；`WATCH` 乐观锁冲突要重试，不如脚本直接 |

### 1. 限流：有序集合滑动窗口

算法和第 8 章的 `SlidingWindowLimiter` 一模一样，队列换成有序集合：成员是每一次调用（名字带随机串，同一毫秒的两次不会互相覆盖），分数是调用时间：

```lua
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
-- ① 扔掉窗口外的（两端都包含，和内存版的 !isAfter(cutoff) 一致）
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now - window)
-- ② 数一数，够了就拒（被拒的不记，不占名额）
if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[3]) then
  return 0
end
-- ③ 记下这一次；整个键一个窗口后过期，调用方不再来，键自己消失
redis.call('ZADD', KEYS[1], now, ARGV[4])
redis.call('PEXPIRE', KEYS[1], window)
return 1
```

- **为什么不用 `INCR` + `EXPIRE`**：那是固定窗口，59 秒问 20 次、61 秒再问 20 次，两秒内放行 40 次。第 8 章选滑动窗口就是为了这个，换到 Redis 上算法不变
- **`ARGV` 都是字符串**：比较前要 `tonumber`
- **时间用谁的**：「现在」由应用传进去，测试可以拨时钟；代价是实例之间的时钟要同步（NTP），偏差多少窗口就歪多少。不想依赖实例的时钟，可以在脚本里用 Redis 的 `TIME`

### 2. 并发名额：分布式信号量，带租期

有序集合里每个成员是一个被拿走的名额（随机 ID），分数是租期到期时间。`slot-acquire.lua` 先 `ZREMRANGEBYSCORE` 收回过期的，再数、不满就 `ZADD`；还名额是一条 `ZREM`。和进程内 `Semaphore` 的三个不同：

- **要租期**：进程内拿名额的线程死了，JVM 一起没了；分布式的名额，拿它的实例被 `kill -9` 或断网，没人来还，不设租期名额会一个个漏光。代价是一轮比租期还长时名额提前被收回、多放进一个，所以租期 5 分钟要比最长的一轮长
- **只能轮询**：Redis 没有「阻塞等信号量」的命令，每 50 毫秒试一次直到 2 秒超时；而且不公平，先来的不一定先拿到（内存版是公平信号量）

```java
while (true) {
    try {
        failures.ensureAvailable();                                   // 冷却期里直接按出错处理
        Long got = redis.execute(SCRIPT, List.of(key),
                String.valueOf(clock.millis()), String.valueOf(max.getAsInt()),
                slotId, String.valueOf(lease.toMillis()));
        if (got != null && got == 1L) {
            return () -> release(slotId);                             // ZREM；出错只记录，租期到了自会收回
        }
    } catch (DataAccessException e) {
        failures.allowOrThrow(COMPONENT, e);                          // 拒绝策略在这里抛
        return fallback.tryAcquire(Duration.ofNanos(Math.max(0, deadline - System.nanoTime())));   // 放行：退回本实例信号量
    }
    if (System.nanoTime() >= deadline) return null;
    TimeUnit.MILLISECONDS.sleep(pollInterval.toMillis());
}
```

### 3. Token 账：一轮记账一段脚本

一天的账是几个哈希（`caller` / `intent` / `conversation` / `total`，字段是「成员|turns / in / out / estimated」）加两个有序集合（`caller-rank` / `conversation-rank`，分数是 Token）。每个数字都是 `HINCRBY` / `ZINCRBY`，加法本身不会丢；写成一段 `usage-add.lua` 是因为一轮要改六个键，分开发命令汇总时可能读到「调用方加上了、意图还没加」的半截账，还要好几次网络往返。脚本最后返回这个调用方当天的 Token。

- **预算查的是 `ZSCORE caller-rank 调用方`**：一条命令
- **键里带日期、两天后过期**：不用像内存版那样零点清空
- **排名直接 `ZREVRANGE`**：`/actuator/tokens` 的「用得最多的前 N 个」不用把整张表读回来；会话维度不再有内存版 500 条的上限，靠两天过期兜底

### 4. 确认单：抢占，而不是锁

第 7 章每个确认一把 `ReentrantLock`，锁在一个 JVM 里，两次点击落在两个实例上就会各执行一次。

最直接的改法是分布式锁：`SET lock NX PX 30000`，执行完删掉。问题在过期时间：锁必须会过期（不然拿锁的实例挂了，这个确认永远锁死），而写操作可能比过期时间还慢（商城卡住了），锁一过期，第二个请求进来再执行一次——正是要防的事。

所以这里是**抢占，不释放**。每个确认三个键：`confirm:{ID}`（确认本身，JSON）、`confirm:{ID}:claim`（谁抢到了、决定是什么）、`confirm:{ID}:outcome`（结果）：

```java
String claimKey = key(id) + ":claim";
if (Boolean.TRUE.equals(redis.opsForValue().setIfAbsent(claimKey, decision.name(), ttl))) {   // SET NX PX
    return Optional.empty();                                          // 我抢到了，去执行
}
String other = redis.opsForValue().get(claimKey);                     // 读出别人的决定
return Optional.of(other == null ? decision : ConfirmationOutcome.Decision.valueOf(other));
```

- **后来的怎么办**：决定相同就等结果（每 20 毫秒看一次，最多 10 秒），拿到的是同一个结果；决定不同（一个点确认、一个点取消）就是 409
- **一条 `SET NX` 就够、不用 Lua**：「不存在才写」本身是原子命令；后面那条 `GET` 只读别人的决定，抢占记录写进去以后没人改它
- **`setIfAbsent` 返回 `Boolean`**：可能是 null，用 `Boolean.TRUE.equals`

**严格说这是「最多执行一次」**：抢到的实例挂在半路，这个确认就停在「处理中」，用户看到 409 `CONFIRMATION_IN_PROGRESS`，过期后重新提。对写操作，办不成比办两次好收拾（和第 7 章「写操作不重试」同一个道理）。真正「恰好一次」要靠下游配合：把确认 ID 当幂等键传给商城，商城那边去重（mall-evolution 下单接口的 `Idempotency-Key` 就是这个），幂等的通用做法见 [幂等设计](/architecture/3_idempotence)。

### 5. 会话锁：比较令牌再删

「同一会话同时只答一个」用的是经典分布式锁，三个要点对应三行代码：

- **占**：`SET conv-busy:记忆键 随机令牌 NX PX 租期`。占和过期必须是**一条**命令，分成 `SETNX` + `EXPIRE` 两条，中间实例挂了就留下一个永不过期的锁
- **租期**：占着的实例挂了，租期到了自动放开，会话不会永远「正在回答」
- **还**：只删自己的，`unlock.lua` 比较令牌再删：

```lua
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
```

不比较的后果：A 占住后卡了很久，标记过了租期自动消失，B 接着占住；A 回来直接 `DEL`，删掉的是 B 的标记，C 又能进来。「比较再删除」分两条命令发，中间同样可能被插进来，所以写成脚本。

它不是绝对安全的锁：持有者卡得比租期还久（长 GC），别人照样能进来。对「尽量别两个一起答」够用；真要严格互斥（扣库存），写入那一侧要再查一次版本号（fencing token）。Redisson 的看门狗会自动续期，减少「还没做完锁就过期」，但同样不是绝对的。原理见 [分布式锁](/distributed/3_lock)。

---

## 四、Redis 出错：放行还是拒绝

把状态挪进 Redis，等于多了一个会挂的依赖。Redis 挂了的那一刻，每个用到它的地方都要回答「现在放不放行」，不事先想好就是一个个 500。策略集中在 `StateFailures#allowOrThrow`：

```java
public boolean allowOrThrow(String component, RuntimeException error) {
    record(component, error);                                         // 指标加一、打日志、进入冷却
    if (policy == StateProperties.OnError.REJECT) {
        throw new StateUnavailableException(component, error);       // 对话接口 503 STATE_UNAVAILABLE
    }
    return true;
}
```

| | 放行（allow，默认） | 拒绝（reject） |
|---|---|---|
| 每分钟次数 | 不计数，放行 | 503 `STATE_UNAVAILABLE` |
| 每日预算 | 当作今天还没用 | 503 |
| 并发名额 | **退回本实例的信号量**（每实例不超过上限） | 503 |
| 会话锁 | 这一轮不加锁 | 503 `MEMORY_UNAVAILABLE` |
| 记账 | 只记指标（回答已经给出去了） | 同左 |
| 归属缓存 | 当作没缓存，多问一次商城 | 同左 |
| 待确认操作 | **一律拒绝**：生成不了卡片，确认 503 `CONFIRMATION_UNAVAILABLE` | 同左 |

- **为什么默认放行**：限流和预算是「保护」，不是业务本身，为了保护而让所有人都问不了，等于自己把自己限流到零；本地模型不按量花钱。按 Token 付费的模型、或者正在被刷的时候，预算失效就是真金白银，选拒绝
- **并发名额是例外**：本地信号量什么都不依赖，放行时退回它，至少每个实例不超过上限，比完全放开安全
- **写操作没得选**：「出错就放行」的后果是执行两次，宁可这次办不了（`StateFailures#fail`，不听开关）
- **冷却 5 秒**：Redis 挂了时每条命令都要等到超时才失败，一轮对话进门要碰三次 Redis（预算、次数、名额），每个用户白等好几秒。出错一次后 5 秒内 `ensureAvailable` 直接抛（它也是 `DataAccessException`，和真的 Redis 异常走同一个 catch），思路和第 9 章的熔断一样，只是简化成「冷却一段时间再试」
- **看得见**：无论哪种策略，放行期间限流和预算都形同虚设，所以每一次出错都计入 `assistant_state_errors_total{component}`，告警 `MallAssistantStateStoreErrors` 会响

---

## 五、熔断器不共享

熔断回答的是「**我**到模型服务这条路通不通」：每个实例到模型的网络、连接池、DNS 可能不一样，A 连不上不代表 B 连不上；共享以后，一个实例的网络抖动会让所有实例一起熔断。

- **代价**：每个实例都要自己失败 5 次才熔断（N 个实例就是 5N 次失败），对客服这点量可以接受
- **业界默认**：Resilience4j、Sentinel 默认也是每实例一个断路器
- **真要全局「一键熔断」**：做成配置中心的开关，由人拍板，而不是让实例互相影响

熔断的通用模型见 [熔断](/high-avail/5_circuit_breaking)。

---

## 六、测试：同一套契约跑两种实现

| 测试 | 跑什么 | 要 Redis |
|------|-------|---------|
| `SharedStateContract` | 抽象类，写一次契约：限流到上限拒绝、窗口滑动、被拒的不占名额、20 个并发恰好放行 5 个；名额上限与归还、等待者拿到归还的名额、12 个并发恰好 3 个；账按三个维度汇总、不同的天分开、20 个并发记账一笔不丢；只有第一个抢占成功（10 个并发恰好一个）；锁互斥、别人的令牌放不开 | — |
| `MemoryStateContractTest`（19 个） | 契约跑内存实现 | 否 |
| `RedisStateContractIT`（23 个） | 契约跑 Redis 实现，外加 Redis 才有的：名额租期到了自动收回、锁过期后旧令牌删不掉新锁、缓存按 TTL 过期、每个键都带前缀而且都会过期 | 是 |
| `RedisMultiInstanceIT`（5 个） | 两个 Redis 客户端当两个实例：合计限流（内存版对照组各算各的）、共享预算、共享名额、A 上生成的确认在 A 和 B 同时点只执行一次（商城只收到一次取消，两边结果相同，之后改主意 409） | 是 |
| `RedisDownTest`（11 个） | 连一个没人监听的端口：两种策略下限流、预算、名额、会话锁各怎样，确认一律拒绝，记账和缓存继续，冷却期里 20 次调用不到 200 毫秒 | 否 |
| `RedisDownApiTest`（4 个） | Redis 连不上时应用照样启动、健康检查 UP；对话 503 `STATE_UNAVAILABLE` 带 `Retry-After`、不调模型；确认 503 `CONFIRMATION_UNAVAILABLE`；指标里有存储类型和出错次数 | 否 |

- **为什么写成契约**：内存版是前几章验证过的行为，Redis 版只要过同一套断言，业务类换实现就不会变样；以后再加一种实现（比如换 Redisson）也是继承一下
- **集成测试怎么跑**：有 Docker 时 Testcontainers 起 `redis:8.10.3-alpine`；没有 Docker 设 `REDIS_IT_URL` 指向一个现成的 Redis，选一个没人用的库号（测试只删自己前缀下的键）

```bash
REDIS_IT_URL='redis://:<口令>@<主机>:6379/<库号>' \
  ./mvnw verify -Dtest=none -Dsurefire.failIfNoSpecifiedTests=false -Dit.test='Redis*IT'
```

start 时单元测试 724 个里 10 个红（`RedisDownTest` 8 个、`RedisDownApiTest` 2 个），有 Redis 时 `RedisStateContractIT` 23 个里 16 个红、`RedisMultiInstanceIT` 5 个里 4 个红（内存对照组是绿的）；前九章的测试一直是绿的，第 7 章的确认测试现在跑在抢占 + 等待上，「并发点两次只执行一次、拿到同一个对象」照样成立。

---

## 七、监控落地：真的跑起来、真的测过

### 1. 独立 compose：Prometheus + Grafana

`monitoring/docker-compose.yml` 是一个独立的 compose（不和应用一起起），版本写死：`prom/prometheus:v3.5.0`、`grafana/grafana:11.6.1`，和 CI 里校验规则用的 promtool 同一个版本。

```bash
cd monitoring
cp .env.example .env        # 填 GRAFANA_ADMIN_PASSWORD（自己生成，只放部署机器的 .env）
# 改 prometheus/targets/default.json：写上应用的「主机:管理端口」，几个实例写几个，内网地址不要提交
docker compose up -d
```

打开 `<主机>:9090`（Status → Targets 看抓取，Alerts 看告警）和 `<主机>:3000`（匿名只读，首页就是「mall-assistant 智能客服」面板）。改了告警规则 `curl -X POST <主机>:9090/-/reload`（compose 里开了 `--web.enable-lifecycle`），不用重启容器。

- **管理员口令只从 `.env` 读**：compose 里写成 `${GRAFANA_ADMIN_PASSWORD:?}`，没设就拒绝启动；面板开了匿名 Viewer，改面板要登录
- **内网机器上不联网**：关掉使用统计、更新检查和启动时预装插件，否则会卡住
- **数据只留 7 天 / 1 GB**，Prometheus 限 512 MB 内存、Grafana 384 MB，学习用
- **compose 项目名是 `mall-monitoring`**，不带 mall-assistant：同一套 Prometheus + Grafana 也可以顺带监控 [项目演进](/project/0_overview) 的 mall-evolution。仓库里只带了 mall-assistant 的抓取任务与面板，要监控商城就在部署目录的 `prometheus.yml` 里加一个抓取任务，抓它四个服务管理端口上的 `/actuator/prometheus`，再把它 `deploy/observability/grafana/` 下的面板 JSON 挂进 Grafana

### 2. Actuator 只在管理端口暴露

第 9 章提醒过，`/actuator/prometheus` 和 `/actuator/tokens` 里有用户 ID 和 IP，不能对外。启动时加 `--management.server.port=9191`，Actuator 放到单独的端口：业务端口 8091 上 `/actuator/prometheus` 是 404，Prometheus 只抓管理端口；生产上这个端口只开给内网和 Prometheus（防火墙或安全组）。不加 `management.server.port` 时 Actuator 和业务同一个端口，`targets` 里就写业务端口。

**抓谁**：`prometheus.yml` 用 file_sd（`targets/*.json`），改了文件 Prometheus 自己重新读、不用重启，多一个实例就多一行。仓库里的 `default.json` 指向同一台机器的 8088（`host.docker.internal`，compose 里用 `host-gateway` 让 Linux 也认识这个名字）；应用在别的机器上时，应用所在机器的防火墙要放行管理端口。

### 3. Grafana 用 provisioning 自动加载

数据源和面板都放在 `grafana/provisioning/`：数据源固定 `uid: prometheus`、指向 compose 网络里的 `http://prometheus:9090`，`timeInterval` 设成和抓取间隔一样的 15 秒（`$__rate_interval` 至少取 4 倍，`rate()` 才不会算出空值）；面板 JSON 挂进容器，30 秒内自动重读，页面上改的保存不回文件（`allowUiUpdates: false`），要改就改仓库里的 JSON。

面板里加了四个面板（各实例每秒请求数、共享状态出错、各实例的存储、抓取状态 up）和一个「实例」筛选变量，加上第 9 章的一共 18 个。

### 4. 告警规则的单元测试

`promtool check rules` 只查语法：标签名打错、少了 `by`、比较方向反了，语法都对，只是永远不响。`alerts.test.yml` 用 `promtool test rules` 造一段假的时间序列，断言某个时刻哪些告警在 firing：

```yaml
- interval: 15s
  input_series:
    - series: 'up{job="mall-assistant", instance="a:9188"}'
      values: '1 1 0 0 0 0 0 0 0'
  alert_rule_test:
    - eval_time: 45s                 # 挂了 15 秒：还没到 for: 1m
      alertname: MallAssistantDown
      exp_alerts: []
    - eval_time: 2m                  # 挂了一分多钟：响了，标签与注解逐个断言
      alertname: MallAssistantDown
      exp_alerts:
        - exp_labels: { severity: critical, job: mall-assistant, instance: a:9188 }
```

另外几段：错误率一半时 `MallAssistantHighModelErrorRate` 响；共享状态出错时 `MallAssistantStateStoreErrors` 响、不再出错 5 分钟后恢复；两个实例一个 redis 一个 memory 时 `MallAssistantMixedStateStores` 响。这两条是本章新加的告警：

```yaml
- alert: MallAssistantStateStoreErrors
  expr: sum by (instance, component) (increase(assistant_state_errors_total[5m])) > 0
  for: 1m
- alert: MallAssistantMixedStateStores
  expr: count(count by (store) (assistant_state_store_info)) > 1
  for: 5m
```

### 5. 两头都查：CI 与 MonitoringFilesTest

- **CI**：`.github/workflows/verify.yml` 在 `verify` 之前用和 compose 同一个 `prom/prometheus:v3.5.0` 镜像跑 `promtool check config prometheus.yml`（连带检查规则语法）和 `promtool test rules alerts.test.yml`
- **`MonitoringFilesTest`（4 个）**：从应用这一头查——面板和告警里写的每个 `assistant_*`，应用真的会输出；面板能被 provisioning 加载；provisioning 的数据源 uid 正是面板变量选的那个

告警的 `for`、分级与降噪见 [告警体系](/observability/4_alerting)，`rate` / `increase` 与服务发现见 [指标监控](/observability/2_metrics)。

### 6. 流量模拟器：让面板一直有数据

面板跑起来之后，没人提问时每条线都是平的。仓库 `main` 上另带一个流量模拟器，它是工具，不属于任何一章，也不在练习的 TODO 里：

| 项 | 取值 |
|----|------|
| 位置 | `src/test/java/.../assistant/simulator/`，入口 `AssistantSimulator`；放在 `src/test` 下，不进应用的 jar |
| 配置 | `src/test/resources/simulator/assistant-simulator.yml`，每项都能用环境变量（如 `SIMULATOR_ASKERS=1`）或 `-Dsimulator.askers=1` 覆盖 |
| 启动 | 智能客服和 mall-evolution 都起来之后，在 IDEA 里选运行配置「智能客服流量模拟（演示账号）」，停止按钮即退出 |
| 实现 | 不起 Spring 容器，只用 JDK 的 `HttpClient` 调和页面一样的接口，不往任何地方写数据 |

- **默认速率**：2 个虚拟用户，每人问完等 40～80 秒，高峰时合计约 30 秒一问；其他时段按 24 个整点的流量曲线拉长间隔，夜里最低到 0.3 倍
- **问什么**：六成先用演示账号登录、其余匿名；规则类（走 RAG）约 42%、查订单 23%、闲聊 15%、查商品 13%、Agent 办事 4%、超出范围 3%，三成在同一个会话里追问一句；流式与阻塞各一半，Agent 办事一律流式
- **按每日 Token 预算节流**：第 9 章给每个调用方每天 10 万 Token。模拟器读回答里的 `usage`，把每个调用方的额度按时间均匀摊开并留一成给真人在页面上用，到线就换一个调用方或暂停，不会上午用光、下午全是 429；真收到 `TOKEN_BUDGET_EXCEEDED`，当天不再用这个调用方
- **退避**：遇到限流、太忙、模型熔断或连不上时指数退避，30 秒起翻倍、最多 10 分钟
- **Agent 只提议不确认**：「帮我取消订单」这类请求停在确认卡片，模拟器默认不点确认（`simulator.agent.confirm-cancel-probability: 0`）；调大后也只会确认「取消自己的待支付订单」
- **少量异常**：1% 空消息、0.5% 超长消息（都是 400，不花 Token）、1% 登录输错密码（401），不触发模型错误类告警

默认预算下 9 个调用方（8 个演示账号加匿名）一天合计约 80 万 Token，一问约 1500～2000 Token，所以全天平均 3～4 分钟一问，比配置的间隔慢；想按 30 秒一问跑满一天，在 `config/application-local.yml` 里调大 `assistant.usage.daily-token-budget`。mall-evolution 那边也有一个商城的流量模拟器（`simulator` 模块），两个一起跑，商城和客服的面板都有数据。

---

## 八、真实环境冒烟

本机起两个 `ch10-done` 的实例（8091 / 8092，管理端口 9191 / 9192，`store=redis`，连共享开发机上 Redis 的一个空库，键前缀 `mall-assistant:`；每分钟 5 次、每日预算 3000；Ollama 是 qwen2.5:1.5b + bge-m3），Prometheus + Grafana 跑在共享开发机上，商城是本机的 mall-evolution（演示账号，只动它自己新下的一笔订单）：

```bash
./mvnw -q package -DskipTests
java -jar target/mall-assistant-1.0.0-SNAPSHOT.jar --spring.profiles.active=ollama,local \
  --server.port=8091 --management.server.port=9191 --assistant.mcp.confirm-url=http://localhost:8091/
java -jar target/mall-assistant-1.0.0-SNAPSHOT.jar --spring.profiles.active=ollama,local \
  --server.port=8092 --management.server.port=9192 --assistant.mcp.confirm-url=http://localhost:8092/
```

| 场景 | 结果 |
|------|------|
| 匿名（同一个 IP）在 A、B 上交替问「你好」7 次 | 前 5 次 200（A 3 次、B 2 次），第 6、7 次 429 `RATE_LIMITED`，`Retry-After` 53 秒——**两个实例合计 5 次** |
| 登录演示账号，A、B 交替问规则类问题 | A 上一问后两边 `/api/usage/me` 都是 1380 / 3000；B 上一问后两边都是 2741——**预算共享**；第三问（A，「退货的运费谁出」登录后走了 Agent）一轮用掉 5182，到 7923；第四问在 B 上 429 `TOKEN_BUDGET_EXCEEDED`，`Retry-After` 到零点 |
| 新下一笔待支付订单，用 MCP 在 **A** 上 `proposeCancelOrder` | 返回确认 ID 与 A 的确认链接；在 **B** 上 `GET /api/agent/confirmations/{ID}` 是 PENDING |
| A、B **同时** `POST` 确认 | 两边都是 200 EXECUTED、同样的话术（0.54 / 0.57 秒）；A 的日志「APPROVE → EXECUTED」，B 的日志「正在由另一个请求处理（APPROVE），等它的结果」「重复提交，返回原来的结果」；商城订单「已取消」，**只执行了一次** |
| 之后在 A 上点「取消」 | 409 `CONFIRMATION_ALREADY_DECIDED` |
| 业务端口 8091 上 `/actuator/prometheus` | 404（Actuator 只在管理端口） |
| Prometheus Targets | 9191、9192 两个都是 up |
| Grafana | provisioning 自动加载；18 个面板的表达式逐个在 Prometheus 上查，除了「提示注入拦截」「共享状态出错」（冒烟期间没发生）都有数据；「模型错误率」修正前 No data、修正后 0%；「各实例的共享状态存储」两行都是 redis |
| 停掉 B | 23 秒后 `MallAssistantDown{instance=…:9192}` **pending**，再过 1 分钟 **firing**（`for: 1m`）；Grafana「抓取状态」里 B 变成 DOWN |

两个 Redis 集成测试连同一台 Redis 的另一个库跑完，按前缀删干净，库里不留键。

结论：**规则写在代码里，状态放在进程外**——同一份 `ChatGuard`、`ConfirmationService`，接口后面换成 Redis，两个实例就像一个；监控文件跑过、测过，停一个实例告警真的会响。

---

## 九、实测踩到的坑

- **没用 Redis 的 Spring Boot Starter**：`spring-boot-starter-data-redis` 会自动配置连接工厂**和 Redis 健康检查**。默认 memory 模式下根本没有 Redis，`/actuator/health` 就成了 DOWN；redis 模式下 Redis 一抖，健康检查 DOWN，编排系统把所有实例摘掉——而本来打算的是「Redis 挂了限流放行、照常服务」。所以只引 `spring-data-redis` + `lettuce-core`，连接自己建（同第 6 章 JDBC 记忆只引非 Starter 模块的做法），`RedisDownApiTest` 断言 Redis 连不上时健康检查是 UP
- **Lettuce 默认把命令攒着等重连**：断线时命令不会立刻失败，而是排队等到命令超时。配 `DisconnectedBehavior.REJECT_COMMANDS` 立刻失败，再加 5 秒冷却
- **Lettuce 7 的 `RedisURI` 没有 `getPassword()` 了**：凭据换成了 `RedisCredentialsProvider`。为了从 `redis://:口令@主机:6379/库号` 取出口令和库号，干脆用 JDK 的 `URI` 自己解析（`RedisStateConfig#server`）；日志里只打主机、端口和库号
- **限流窗口跨过了重启**：冒烟时先跑了一轮，换个配置重启两个实例再跑，第 4 次就 429 了——上一轮的 3 次还在 Redis 的窗口里。内存版重启就清零，Redis 版不会：这正是共享的意义，但调试时会让人以为限流算错了
- **共享 Redis 上的契约测试互相污染**：Token 账按天分键，同一个测试类里几个测试都往同一天记账，「合计」把别的测试也加进去了，「用得最多的调用方」也换了人。每个测试用自己的随机后缀，还要用自己的「那一天」
- **`allkeys-lfu` 会删待确认操作**：开发机上那台 Redis 是给缓存用的 `allkeys-lfu`，内存满了会挑不常用的键删，不管有没有过期时间。限流窗口被删了顶多多放几次，**待确认操作被删了就是 404**。生产上共享状态要放在 `maxmemory-policy noeviction` 的实例里（满了写入报错、按策略处理，而不是悄悄丢数据），或者和缓存用的 Redis 分开，见 [Redis 核心原理](/cache/2_redis_core) 的淘汰策略一节
- **面板数据源要用变量**：第 9 章的面板是「导出给别人 Import」的格式，数据源写成 `${DS_PROMETHEUS}`，Import 时才替换；provisioning 不替换，加载出来每个面板都是「找不到数据源」。改成数据源模板变量 `${datasource}`，两种方式都能用
- **空向量要 `or vector(0)`**：「模型错误率」显示 No data 而不是 0%——没有任何 `MODEL_*` 错误时，分子 `sum(rate(...{outcome=~"MODEL_.*"}...))` 是**空向量**（不是 0），空向量除以任何东西还是空。分子补 `or vector(0)`；告警规则里同样的式子不用改，没有错误时本来就不该告警
- **多实例要 `sum by (instance)`**：「正在处理的对话」原来是 `max(...)`，多实例时只看得到最忙的那个，改成每个实例一条线
- **预算按轮检查会超**：进门时查一次，一件 Agent 的事一轮用掉 5182，3000 的预算到了 7923。把检查挪到每次模型调用之前（`UsageAdvisor`）能卡得更严，但共享账以后两个实例可能同时检查、同时放行，Agent 也会办到一半被打断
- **`assistant_guard_rejections_total` 没有 `endpoint` 标签**：第 9 章只给它打了 `reason`，写测试断言时想当然加了 `endpoint`，没匹配上

---

## 十、与需求的差异

| 需求 | 实际 | 原因 / 影响 |
|------|------|-------------|
| 告警发到值班 | 没部署 Alertmanager，告警只在 Prometheus 的 Alerts 页面上看得到 pending / firing | 接钉钉 / 企业微信 / 邮件的接收人和静默规则是团队流程的事；接值班要再起一个 Alertmanager |
| 确认「只执行一次」 | 最多执行一次：抢到的实例挂在半路，确认停在「处理中」（409），过期后重提 | 恰好一次要商城按确认 ID 幂等去重；没做后台任务去商城查真实状态补结果 |
| 并发名额排队 | 轮询，不公平 | Redis 没有阻塞等信号量的命令；要公平可以按到达时间排进有序集合、只放前 N 个 |
| 熔断共享 | 每实例一份 | 一个实例的网络抖动不该让所有实例熔断；代价是 N 个实例要 5N 次失败 |
| Redis 挂了时限流 | 放行或拒绝二选一 | 没做「退回本实例限流、每实例分 1/N 额度」的折中，只有并发名额退回本地信号量 |
| Redis 高可用 | 单机 Redis | 键已带花括号，换 Cluster 不用改键；哨兵 / 集群的部署不在本章范围 |
| 面板「表达式有数据」的自动检查 | 只查指标名存在（`MonitoringFilesTest`），表达式靠冒烟时逐个在 Prometheus 上查 | 查空向量需要一个有数据的 Prometheus，CI 里没有 |
| 链路追踪 | 仍没接 exporter | 和第 9 章一样，traceId 只进日志与响应头 |

---

## 十一、常见坑

- **只把一部分状态放进 Redis**：一半规则全局、一半每实例，没人说得清限的是多少；一个开关管全部，再用告警抓漏配的实例
- **限流分三条命令发**：两个实例同时数到 19，变成 21 次；要一起看一起改的写成 Lua
- **分布式锁占和过期分两条**：`SETNX` 之后挂了就是永不过期的锁；必须 `SET NX PX` 一条
- **释放锁直接 `DEL`**：可能删掉别人的锁；比较令牌再删，而且写成脚本
- **拿分布式锁保护写操作**：锁会过期、写操作可能更慢，过期后第二个请求再执行一次；用抢占不释放，下游再按幂等键去重
- **分布式名额不设租期**：拿名额的实例挂了没人还，名额漏光
- **Redis 出错时没想好**：每个用到它的地方都 500；限流和预算放行或拒绝，写操作一律拒绝，加冷却
- **共享状态和缓存放在 `allkeys-lfu` 的 Redis 上**：内存满了待确认操作被悄悄删掉
- **引 Redis Starter**：自带的健康检查让 Redis 一抖所有实例都被摘掉
- **监控文件只写不跑**：数据源占位符、空向量、`max` 代替 `sum by (instance)`，都是跑起来才看得到；告警规则要有单元测试

---

## 十二、验证

下表列出本篇关键结论与证明它的测试；本章代码在 `ch10-done` 上跑完整构建的结果见 [测试报告](https://clarence404.github.io/mall-assistant/reports/ch10-done/)。

| 结论 | 测试 | 类型 |
|------|------|------|
| 限流到上限后拒绝、窗口滑动、被拒的不占名额，并发下不超限 | [`SharedStateContract#rateLimiterAllowsUpToTheLimitThenRejects`、`#rateLimiterWindowSlides`、`#rejectedCallsDoNotTakeASlot`、`#concurrentCallersNeverExceedTheLimit`](https://github.com/Clarence404/mall-assistant/blob/ch10-done/src/test/java/io/github/clarence404/assistant/state/SharedStateContract.java) | 契约 |
| 名额有上限、会归还，等待者拿到归还的名额，并发下不超过上限 | [`SharedStateContract#slotsAreLimitedAndReleased`、`#waitingCallerGetsAReleasedSlot`、`#concurrentAcquirersNeverExceedTheMax`](https://github.com/Clarence404/mall-assistant/blob/ch10-done/src/test/java/io/github/clarence404/assistant/state/SharedStateContract.java) | 契约 |
| 账按调用方、意图、会话汇总，不同的天分开，并发记账一笔不丢 | [`SharedStateContract#usageStoreAggregatesByCallerIntentAndConversation`、`#usageStoreKeepsDaysApart`、`#concurrentAddsAreNotLost`](https://github.com/Clarence404/mall-assistant/blob/ch10-done/src/test/java/io/github/clarence404/assistant/state/SharedStateContract.java) | 契约 |
| 只有第一个抢占成功，10 个并发恰好一个，结果可见 | [`SharedStateContract#onlyTheFirstClaimWins`、`#concurrentClaimsHaveExactlyOneWinner`、`#completedOutcomeIsVisible`](https://github.com/Clarence404/mall-assistant/blob/ch10-done/src/test/java/io/github/clarence404/assistant/state/SharedStateContract.java) | 契约 |
| 会话锁互斥，别人的令牌放不开，并发下恰好一个 | [`SharedStateContract#conversationLockIsExclusiveAndOnlyItsOwnerCanUnlock`、`#concurrentLockersHaveExactlyOneWinner`](https://github.com/Clarence404/mall-assistant/blob/ch10-done/src/test/java/io/github/clarence404/assistant/state/SharedStateContract.java) | 契约 |
| 名额租期到了自动收回，锁过期后旧令牌删不掉新锁，每个键带前缀且会过期 | [`RedisStateContractIT#expiredSlotLeaseIsReclaimed`、`#expiredLockFreesItselfAndOldTokenCannotDeleteTheNewOne`、`#everyKeyHasThePrefixAndExpires`](https://github.com/Clarence404/mall-assistant/blob/ch10-done/src/test/java/io/github/clarence404/assistant/state/RedisStateContractIT.java) | 集成 |
| 两个实例合计限流，内存版各算各的 | [`RedisMultiInstanceIT#twoInstancesShareTheChatRateLimit`、`#memoryInstancesDoNotShare`](https://github.com/Clarence404/mall-assistant/blob/ch10-done/src/test/java/io/github/clarence404/assistant/state/RedisMultiInstanceIT.java) | 集成 |
| 两个实例共享预算与并发名额 | [`RedisMultiInstanceIT#twoInstancesShareTheDailyBudget`、`#twoInstancesShareTheConcurrencySlots`](https://github.com/Clarence404/mall-assistant/blob/ch10-done/src/test/java/io/github/clarence404/assistant/state/RedisMultiInstanceIT.java) | 集成 |
| A 上生成的确认在 A、B 同时点只执行一次 | [`RedisMultiInstanceIT#confirmationFromInstanceAIsExecutedOnceWhenBothInstancesAreClicked`](https://github.com/Clarence404/mall-assistant/blob/ch10-done/src/test/java/io/github/clarence404/assistant/state/RedisMultiInstanceIT.java) | 集成 |
| 放行策略下限流和预算放行，拒绝策略下都抛 | [`RedisDownTest#allowPolicyLetsRateLimitAndBudgetThrough`、`#rejectPolicyRefusesRateLimitAndBudget`](https://github.com/Clarence404/mall-assistant/blob/ch10-done/src/test/java/io/github/clarence404/assistant/state/RedisDownTest.java) | 单元 |
| 放行时名额退回本地信号量（仍有上限），确认一律拒绝 | [`RedisDownTest#slotsFallBackToTheLocalSemaphoreWhenAllowed`、`#confirmationsAlwaysFailClosed`](https://github.com/Clarence404/mall-assistant/blob/ch10-done/src/test/java/io/github/clarence404/assistant/state/RedisDownTest.java) | 单元 |
| 冷却期里不碰 Redis | [`RedisDownTest#cooldownSkipsRedisAfterAnError`](https://github.com/Clarence404/mall-assistant/blob/ch10-done/src/test/java/io/github/clarence404/assistant/state/RedisDownTest.java) | 单元 |
| Redis 连不上时应用照样启动、健康检查 UP，对话 503、确认 503 | [`RedisDownApiTest#applicationStartsAndReportsHealthy`、`#chatIsRefusedWithStateUnavailable`、`#confirmationsFailClosed`](https://github.com/Clarence404/mall-assistant/blob/ch10-done/src/test/java/io/github/clarence404/assistant/chat/RedisDownApiTest.java) | 接口 |
| 面板与告警里的每个指标应用都会输出，面板能被 provisioning 加载 | [`MonitoringFilesTest#everyMetricInTheDashboardIsExported`、`#everyMetricInTheAlertRulesIsExported`、`#dashboardLoadsThroughProvisioning`](https://github.com/Clarence404/mall-assistant/blob/ch10-done/src/test/java/io/github/clarence404/assistant/ops/MonitoringFilesTest.java) | 单元 |
| 告警在该响的时候响、不该响的时候不响 | [`monitoring/prometheus/alerts.test.yml`](https://github.com/Clarence404/mall-assistant/blob/ch10-done/monitoring/prometheus/alerts.test.yml)（CI 里 `promtool test rules`） | 告警单测 |

---

## 十三、全系列收尾

十章走下来，这个智能客服从「能聊天」长到了「敢上线」，再到「起两个实例也不变样」：

| 章 | 学到的 | 落在代码里 |
|----|-------|-----------|
| 1 | 接模型、流式、超时与错误分类 | `ChatClient`、SSE、`ModelCallException` |
| 2 | 提示词模板与版本、结构化输出、拒答 | `IntentService`、`prompts/` |
| 3 | 工具调用、令牌只走 ToolContext、查不到不编 | `MallTools`、`ToolCallRecorder` |
| 4 | 切块、向量化、增量入库 | `knowledge/` |
| 5 | 混合检索、引用、检索不到不调模型 | `rag/` |
| 6 | 记忆、窗口裁剪、追问改写、会话归属 | `memory/` |
| 7 | Agent 循环与刹车、写操作人工确认 | `agent/` |
| 8 | MCP Server 与 Client、只提议不执行 | `mcp/` |
| 9 | 评测与门禁、Token、限流熔断降级、监控、注入过滤 | `eval/`、`ops/`、`guard/` |
| 10 | 共享状态与 Lua 原子脚本、抢占与分布式锁、Redis 出错策略、监控落地与告警单测 | `state/`、`monitoring/` |

**学完能做什么**：给一个已有的 Java 业务系统加一个「懂业务、查得到真数据、按规则回答、会办事但不乱办」的 AI 助手，并且知道怎么证明它没有变差、怎么看它花了多少、出了事怎么查、哪里会被攻击。贯穿十章的几条原则比代码更值得带走：

- **模型负责理解和措辞，代码负责事实、规则和执行**
- **外来的文字都是数据，不是指令**
- **宁可说不知道，也不要说错**
- **改数据的事，人来拍板**
- **能观测的才能评测，能评测的才敢上线**

**还差什么**：[评估与上线 · 离生产还差什么](./9_eval_launch#十八、离生产还差什么) 列的九项里，本章做掉了头尾两条（状态共享、监控跑起来），认证、更强的模型、真实评测集、知识库审核、输出侧护栏、灰度与成本优化仍然没做；本章自己留下的见上文「与需求的差异」。每一项都可以是下一个项目的起点。

---

## 小结

- 起两个实例时，进程内的限流、预算、并发名额、确认单和会话标记都会失效；`assistant.state.store` 一个开关把它们一起切到 Redis，记忆与售后单仍是 PostgreSQL 里的「数据」
- 一条命令能原子的用一条命令，几步要一起看一起改的写成 Lua：有序集合滑动窗口、带租期的分布式名额、一轮六个键的记账、比较令牌再删的解锁
- 确认单是 `SET NX PX` 抢占、不释放，严格说是最多执行一次，恰好一次要下游按确认 ID 幂等；会话锁是经典分布式锁，长 GC 下仍不绝对安全
- Redis 出错时限流与预算按 `on-redis-error` 放行或 503，并发名额放行时退回本实例信号量，待确认操作一律 503，出错后冷却 5 秒并计入指标与告警；熔断器有意每实例一份
- 同一套契约测试跑内存与 Redis 两种实现，两个 Redis 客户端证明共享生效，连不上的端口证明两种策略
- 监控用独立 compose 跑起 Prometheus 3.5 + Grafana 11.6：Actuator 只在管理端口、file_sd 抓取、provisioning 加载面板，告警规则有 `alerts.test.yml` 单元测试并在 CI 里 `promtool` 校验；冒烟验证了合计限流、共享预算、跨实例确认只执行一次和停实例后告警 pending → firing
- 流量模拟器（`main` 上的工具，不属于任何一章）按每日 Token 预算配速、出错退避、Agent 只提议不确认，让面板长期有数据；同一套 `mall-monitoring` 也可以顺带监控 mall-evolution

> 本篇代码：[ch10-done](https://github.com/Clarence404/mall-assistant/tree/ch10-done) · 练习起点：[ch10-start](https://github.com/Clarence404/mall-assistant/tree/ch10-start)

## 参考资料

- Redis · Scripting with Lua：[https://redis.io/docs/latest/develop/interact/programmability/eval-intro/](https://redis.io/docs/latest/develop/interact/programmability/eval-intro/)
- Redis · Distributed Locks with Redis：[https://redis.io/docs/latest/develop/use/patterns/distributed-locks/](https://redis.io/docs/latest/develop/use/patterns/distributed-locks/)
- Martin Kleppmann, How to do distributed locking：[https://martin.kleppmann.com/2016/02/08/how-to-do-distributed-locking.html](https://martin.kleppmann.com/2016/02/08/how-to-do-distributed-locking.html)
- Spring Data Redis Reference：[https://docs.spring.io/spring-data/redis/reference/](https://docs.spring.io/spring-data/redis/reference/)
- Prometheus · Unit testing for rules：[https://prometheus.io/docs/prometheus/latest/configuration/unit_testing_rules/](https://prometheus.io/docs/prometheus/latest/configuration/unit_testing_rules/)
- Grafana · Provisioning：[https://grafana.com/docs/grafana/latest/administration/provisioning/](https://grafana.com/docs/grafana/latest/administration/provisioning/)

> 返回：[AI 总览](../0_overview)
