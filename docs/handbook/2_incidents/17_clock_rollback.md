---
description: 下单主键冲突与支付单号重复、解码雪花 ID 定位节点、chrony 步进回拨、发号器回拨处理与唯一约束
---

# 时钟回拨导致 ID 重复

> 前置阅读：[分布式 ID 生成](/distributed/8_id_generator)

订单服务在两秒内集中报出一批主键冲突，第二天对账又发现几十条支付单号重复，元凶是一台节点的系统时钟被 NTP 往回拨了 1.8 秒。本篇复盘一次雪花算法时钟回拨事故，基线为 JDK 21、Spring Boot 4、MySQL 8.4、chrony 4。

---

## 一、现象

2026-09-17（周四）10:15，`order-service`（16 个副本）使用自研雪花发号器生成订单号与支付请求号，起始时间 2025-01-01，10 位 workerId 由 Pod 启动时从 Redis 领取。

| 时间 | 现象 |
|------|------|
| 10:15:03～10:15:05 | 2 秒内 19 次下单失败，错误为 `DuplicateKeyException`，全部来自同一个 Pod |
| 10:16 | 告警「下单失败数 > 10/min」触发，之后错误自行消失，值班记录为「偶发」 |
| 09-18 09:30 | 财务对账发现 `t_pay_request` 中 41 个 `request_no` 各出现两次，支付平台以「商户订单号重复」拒绝了其中 38 笔 |

下单失败的日志：

```text
2026-09-17T10:15:03.415+08:00 ERROR 1 --- [order-service] [nio-8080-exec-17] c.e.order.web.GlobalExceptionHandler : create order failed
org.springframework.dao.DuplicateKeyException: PreparedStatementCallback; SQL [insert into t_order (id, user_id, ...) values (?, ?, ...)];
Duplicate entry '226164016307834880' for key 't_order.PRIMARY'
```

---

## 二、影响

- **下单失败**：19 笔订单创建失败，用户看到「下单失败，请重试」，重试后成功
- **支付失败**：38 笔支付请求被支付平台拒绝，用户需重新发起支付；其中 6 笔用户放弃
- **数据错误**：3 笔支付回调按 `request_no` 查到两条记录，状态更新到了错误的支付单，人工核对后修正
- **故障等级**：P2（产生错误数据），发现延迟近 24 小时

---

## 三、排查过程

### 1、错误集中在哪里

```bash
kubectl -n order logs -l app=order-service --since=24h --prefix \
  | grep DuplicateKeyException | awk '{print $1, substr($2,1,19)}' | sort | uniq -c
```

示例输出：

```text
     19 [pod/order-service-7d9f8c6b5-xk2pq/order-service] 2026-09-17T10:15:0
```

只有一个 Pod，只有 10:15:03～10:15:05 这 2 秒。排除 workerId 冲突（那会持续出错，且分布在两个 Pod 上）。

### 2、解码冲突的 ID

```text
$ jshell
jshell> long id = 226164016307834880L;
jshell> Instant.ofEpochMilli((id >> 22) + 1735689600000L).atZone(ZoneId.of("Asia/Shanghai"))
$2 ==> 2026-09-17T10:15:03.412+08:00[Asia/Shanghai]
jshell> (id >> 12) & 1023
$3 ==> 17
jshell> id & 4095
$4 ==> 0
```

时间戳 10:15:03.412、workerId 17、序列号 0。按雪花的结构，同一 workerId 生成完全相同的 ID，**只能是同一毫秒被用了两次**，结构说明见 [分布式 ID 生成 · 雪花算法](/distributed/8_id_generator#四、雪花算法-snowflake)。

### 3、对比应用时间与数据库时间

`t_order` 有两个时间列：`created_at` 由应用写入，`db_created_at` 是 `DEFAULT CURRENT_TIMESTAMP(3)`，取数据库服务器时间。

```sql
SELECT id, created_at, db_created_at,
       TIMESTAMPDIFF(MICROSECOND, db_created_at, created_at) / 1000 AS app_ahead_ms
FROM t_order
WHERE id = 226164016307834880
   OR (created_at BETWEEN '2026-09-17 10:14:50' AND '2026-09-17 10:15:10' AND id >> 12 & 1023 = 17)
ORDER BY db_created_at
LIMIT 6;
```

示例输出：

```text
+--------------------+-------------------------+-------------------------+--------------+
| id                 | created_at              | db_created_at           | app_ahead_ms |
+--------------------+-------------------------+-------------------------+--------------+
| 226163995655081984 | 2026-09-17 10:14:58.488 | 2026-09-17 10:14:56.655 |    1833.0000 |
| 226164016307834880 | 2026-09-17 10:15:03.412 | 2026-09-17 10:15:01.579 |    1833.0000 |
| 226164023442345984 | 2026-09-17 10:15:05.113 | 2026-09-17 10:15:03.280 |    1833.0000 |
| 226164016345583616 | 2026-09-17 10:15:03.421 | 2026-09-17 10:15:03.420 |       1.0000 |
| 226164016798568448 | 2026-09-17 10:15:03.529 | 2026-09-17 10:15:03.528 |       1.0000 |
| 226164025468194816 | 2026-09-17 10:15:05.596 | 2026-09-17 10:15:05.595 |       1.0000 |
+--------------------+-------------------------+-------------------------+--------------+
```

10:15:03.3 之前，该 Pod 的时钟比数据库**快约 1.83 秒**；之后差值回到 1ms 左右。也就是说，这个 Pod 所在节点的时钟在 10:15:03 附近被往回拨了约 1.83 秒，回拨之后的 1.83 秒里，时间戳把之前用过的毫秒重新走了一遍，凡是两次落在同一毫秒且序列号相同的 ID 都重复了。

### 4、定位节点与时钟事件

```bash
kubectl -n order get pod order-service-7d9f8c6b5-xk2pq -o wide | awk '{print $1, $7}'
ssh node-07 'journalctl -u chronyd --since "2026-09-16 19:00" --no-pager | grep -vi "^--"'
```

示例输出：

```text
NAME                            NODE
order-service-7d9f8c6b5-xk2pq   node-07

Sep 16 20:03:41 node-07 chronyd[812]: Can't synchronise: no selectable sources
Sep 17 10:15:05 node-07 chronyd[812]: Selected source 10.0.10.1 (ntp1.internal)
Sep 17 10:15:05 node-07 chronyd[812]: System clock wrong by -1.834012 seconds
Sep 17 10:15:03 node-07 chronyd[812]: System clock was stepped by -1.834012 seconds
```

日志的时间戳本身就从 10:15:05 倒退回 10:15:03。时间线串起来：

- 9 月 16 日 20:00 网络组调整防火墙，node-07 所在网段到内部 NTP 的 UDP 123 被误拦，chrony 失去全部时间源
- 失去同步后时钟按晶振误差自由漂移，该节点频率误差约 +36.4 ppm，14 小时累计快了约 1.83 秒（36.4 × 10⁻⁶ × 50,400 秒）
- 9 月 17 日 10:15 防火墙规则回滚，chrony 恢复同步，发现偏差 1.83 秒，**直接步进（step）回拨**而不是平滑调整

### 5、为什么会步进

```bash
ssh node-07 'grep -E "^(makestep|maxslewrate|server|pool)" /etc/chrony/chrony.conf; chronyc tracking | grep -E "System time|Frequency"'
```

示例输出：

```text
makestep 1 -1
server 10.0.10.1 iburst

System time     : 0.000004127 seconds fast of NTP time
Frequency       : 36.402 ppm fast
```

- `makestep 1 -1`：偏差超过 1 秒就步进，`-1` 表示不限次数，运行期间任何时候都可能跳变。常见的发行版默认值是 `makestep 1 3`，只在启动后的前 3 次更新内允许步进
- 这一行来自三年前的 Ansible 角色，当时为了「虚拟机挂起恢复后快速对时」而改，所有节点都是这个配置
- 只配了 1 个时间源，防火墙一拦就全部失联

### 6、发号器为什么没拦住

```java
// 旧实现（节选）：没有任何时钟回拨检查
public synchronized long nextId() {
    long now = System.currentTimeMillis();
    if (now == lastTimestamp) {
        sequence = (sequence + 1) & SEQUENCE_MASK;
        if (sequence == 0) {
            now = waitNextMillis(lastTimestamp);
        }
    } else {
        sequence = 0L;                      // now < lastTimestamp 也走到这里，直接复用旧毫秒
    }
    lastTimestamp = now;
    return ((now - EPOCH) << 22) | (workerId << 12) | sequence;
}
```

`now < lastTimestamp` 时被当成「新的一毫秒」，序列号归零后直接发号。

### 7、圈定受影响数据

```sql
SELECT request_no, COUNT(*) AS cnt, MIN(id) AS first_id, MAX(id) AS second_id
FROM t_pay_request
WHERE db_created_at BETWEEN '2026-09-17 10:14:55' AND '2026-09-17 10:15:10'
GROUP BY request_no
HAVING cnt > 1;
```

结果 41 行。`t_pay_request` 的主键是自增列，`request_no` 只有普通索引，所以重复数据被静默写入；`t_order` 以雪花 ID 为主键，重复时直接报错，反而只是 19 笔失败。

---

## 四、根因

| 层面 | 问题 |
|------|------|
| 时钟 | chrony 配置 `makestep 1 -1`，允许运行期随时步进；只有 1 个时间源，失联 14 小时后一次性回拨 1.83 秒 |
| 代码 | 自研雪花发号器没有时钟回拨检查，回拨后复用已用过的毫秒 |
| 数据约束 | 支付请求号没有唯一索引，重复数据被静默写入，直到对账才发现 |
| 监控 | 没有节点时钟偏差与同步状态告警，chrony 失联 14 小时无人知晓 |

---

## 五、修复

### 1、止血

- 9 月 18 日 10:00 排查确认后，用 Ansible 巡检全部节点 `chronyc tracking`，另有 2 台节点偏差超过 200ms，先 `kubectl cordon` 并迁走发号相关服务
- 41 条重复的支付请求重新生成 `request_no` 并与支付平台核对状态，3 笔错误回调人工修正，38 笔被拒的支付通知用户重新发起
- `t_pay_request.request_no` 补唯一索引（先清理重复数据，再用 Online DDL 添加）

### 2、chrony 配置

```text
# /etc/chrony/chrony.conf
server 10.0.10.1 iburst
server 10.0.10.2 iburst
server 10.0.20.1 iburst          # 至少 3 个时间源，分布在不同网段
makestep 1 3                     # 只在启动后的前 3 次更新允许步进，运行期一律平滑调整
maxslewrate 500                  # 平滑调整速率上限（ppm），1.8 秒偏差约 1 小时追平
```

运行期只做平滑调整（slew），时钟变快变慢但不会倒退。节点启动时允许步进，此时业务进程还没启动。

### 3、发号器

自研发号器下线，改用平台统一的雪花组件，回拨处理采用「借用后续毫秒」，结构与代码见 [分布式 ID 生成 · 时钟回拨](/distributed/8_id_generator#_3、时钟回拨)。与主文档默认的「≤5ms 等时钟追上」相比，这次的差异是：

- **为什么借用而不是等待**：这次回拨 1.83 秒，等待意味着发号线程整整卡 1.8 秒，下单、支付接口会成片超时；借用只让 ID 时间戳暂时超前，不阻塞发号
- **阈值取 3 秒**：覆盖本次 1.83 秒并留余量；chrony 改为运行期只平滑调整后，秒级回拨只可能来自节点启动或虚拟机迁移，超过 3 秒仍拒绝发号（抛出 `ClockBackwardException`），由调用方重试到其他实例
- **重启校验**：workerId 租约每秒续期时把 `lastTimestamp` 一并写回 Redis，新进程领取同一 workerId 时读出并校验，防止「回拨后重启」绕过内存里的检查；组件构造参数为 `(InstantSource clock, long workerId, long persistedLastTimestamp)`，时钟可注入，便于下面的测试
- **指标**：借用时长注册为 Micrometer Gauge `id.generator.borrowed.ms`

---

## 六、预防

### 1、监控与告警

```yaml
- alert: NodeClockOffsetHigh
  expr: abs(node_timex_offset_seconds) > 0.05
  for: 5m
  labels: { severity: warning }
  annotations:
    summary: "{{ $labels.instance }} 时钟偏差超过 50ms"

- alert: NodeClockNotSynchronising
  expr: min_over_time(node_timex_sync_status[10m]) == 0
  labels: { severity: critical }
  annotations:
    summary: "{{ $labels.instance }} 已 10 分钟未与 NTP 同步"
```

这次事故中，`NodeClockNotSynchronising` 会在 9 月 16 日 20:13 就触发，比回拨早 14 小时。

### 2、规范

- 业务唯一编号（订单号、支付请求号、流水号）**必须有唯一索引**，数据库是最后一道防线
- 发号器只用平台统一的组件，禁止各服务自写雪花；组件必须处理时钟回拨，并有单元测试覆盖
- 节点时间同步配置纳入基线管理，`makestep` 的限制次数不得为负数，时间源不少于 3 个
- 对时钟敏感的场景（发号、分布式锁过期、令牌有效期）不依赖单机时钟的绝对值，必要时用号段模式或中心化发号

### 3、测试

```java
class SnowflakeIdGeneratorTest {

    static final class SteppableClock implements InstantSource {
        private long millis;
        SteppableClock(long start) { this.millis = start; }
        void advance(long ms) { millis += ms; }
        @Override public long millis() { return millis; }
        @Override public Instant instant() { return Instant.ofEpochMilli(millis); }
    }

    @Test
    void idsStayUniqueAndIncreasingWhenClockStepsBack() {
        var clock = new SteppableClock(1_789_611_303_412L);         // 2026-09-17T10:15:03.412+08:00
        var generator = new SnowflakeIdGenerator(clock, 17, 0L);
        var ids = new HashSet<Long>();
        long previous = Long.MIN_VALUE;
        for (int round = 0; round < 2; round++) {
            for (int i = 0; i < 2_000; i++) {
                long id = generator.nextId();
                assertThat(id).isGreaterThan(previous);
                previous = id;
                ids.add(id);
                clock.advance(1);
            }
            clock.advance(-1_834);                                  // 复现这次的 1.834 秒回拨
        }
        assertThat(ids).hasSize(4_000);
    }
}
```

再补一条用例：回拨 5 秒时 `nextId()` 抛出 `ClockBackwardException`。应用侧对 `id_generator_borrowed_ms` 持续大于 100 告警。预发环境的混沌演练中加入「节点时钟回拨 2 秒」场景，验证发号、分布式锁与 Token 校验的行为，见 [混沌工程](/high-avail/10_chaos_engineering)。

---

## 七、涉及知识点

| 知识点 | 文章 |
|--------|------|
| 雪花算法结构与实现 | [分布式 ID 生成 · 雪花算法](/distributed/8_id_generator#四、雪花算法-snowflake) |
| 时钟回拨的应对思路、workerId 分配 | [分布式 ID 生成 · 时钟回拨](/distributed/8_id_generator#_3、时钟回拨) |
| 号段模式、Leaf、UidGenerator 选型 | [分布式 ID 生成 · 方案对比与选型](/distributed/8_id_generator#八、方案对比与选型) |
| 幂等与唯一约束 | [幂等设计](/architecture/3_idempotence) |
| 支付单与对账 | [支付系统](/scenario/14_payment)、[海量数据对账](/scenario/3_reconcile) |
| systemd 与 journalctl | [Linux 概览 · systemd 与 journalctl](/cloud-native/1_linux#三、systemd-与-journalctl) |

---

## 小结

- 同一 workerId 出现相同 ID，只能是同一毫秒被用了两次：解码 ID、对比应用与数据库时间，就能确认时钟回拨
- 回拨来自 NTP 步进：`makestep` 不限次数 + 单一时间源失联，长时间漂移后一次性跳回
- 修复分三层：chrony 运行期只平滑调整、发号器检测回拨（小幅借用、大幅拒绝、重启校验）、业务编号加唯一索引
- 时钟偏差与同步状态必须有告警，这次本可以提前 14 小时发现

## 参考资料

- chrony 的 makestep / maxslewrate：[chrony: chrony.conf(5)](https://chrony-project.org/doc/4.6/chrony.conf.html)
- chronyc tracking 字段说明：[chrony: chronyc(1)](https://chrony-project.org/doc/4.6/chronyc.html)
- 节点时间指标：[Prometheus node_exporter](https://github.com/prometheus/node_exporter)
- InstantSource 接口：[Oracle: InstantSource (Java SE 21)](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/time/InstantSource.html)
- 重复键错误码 1062：[MySQL 8.4 Reference Manual: Server Error Message Reference](https://dev.mysql.com/doc/mysql-errors/8.4/en/server-error-reference.html)
- 雪花算法原始设计：[Twitter Engineering: Announcing Snowflake](https://blog.x.com/engineering/en_us/a/2010/announcing-snowflake)

> 下一篇：[Load 高但 CPU 不高](./18_load_high_cpu_low)
