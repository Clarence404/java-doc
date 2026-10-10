---
description: 差错类型、摘要比对与排序归并比对、游标分批拉取与断点续跑、在途数据与二次对账、差错处理状态机
---

# 海量数据对账

> 前置阅读：[海量数据算法题](./3_massive_data)、[幂等设计](/architecture/5_idempotence)、[MySQL 索引](/database/1_mysql/4_topic_index)

对账就是拿两份「本应一致」的数据逐条核对，找出不一致的记录并处理掉。本篇讲每天几千万笔时的通用做法：拉取、分片、比对、差错处理，以及断点续跑、跨日在途、差错修复幂等这几个容易出事故的环节。

---

## 一、对账要解决什么

支付渠道对账的业务流程见 [支付系统](./14_payment)。

### 1、常见的对账场景

| 场景 | A 方数据 | B 方数据 | 典型差异原因 |
|------|----------|----------|--------------|
| 支付渠道对账 | 内部支付流水 | 微信、支付宝、银行的日对账单 | 回调丢失、超时后渠道实际成功、跨日 |
| 上下游系统对账 | 订单系统的已支付订单 | 库存扣减记录、积分发放记录、发票记录 | MQ 消息丢失或重复消费、下游处理失败 |
| 主从 / 双写校验 | 主库 | 从库、ES、缓存、新分库 | 复制延迟、双写其中一边失败 |
| 数据迁移校验 | 迁移前的旧库 | 迁移后的新库 | 迁移脚本漏数据、类型或精度转换错误 |

这些场景的结构都一样：**两份数据、一个关联键（交易号 / 订单号 / 主键）、若干要核对的字段**。下文以支付渠道对账为例，其他场景把「渠道账单」换成另一份数据即可。

### 2、差错类型

| 差错 | 含义 | 常见原因 | 一般处理 |
|------|------|----------|----------|
| 长款 | 渠道有、内部没有（或内部未成功） | 支付回调丢失，订单仍是待支付或已关闭 | 查单确认后补单；订单已关闭则退款 |
| 短款 | 内部有、渠道没有 | 跨日在途；内部误把未成功的支付记为成功 | 先当在途，次日二次对账仍没有再定为短款 |
| 金额不一致 | 两边都有，金额不同 | 部分退款未同步、优惠计算口径不同 | 人工复核 |
| 状态不一致 | 两边都有，状态不同 | 退款已到账但内部仍是退款中 | 以渠道为准推进内部状态，或人工复核 |

「长款」「短款」是以内部账为基准说的：渠道那边钱多了是长款，少了是短款。所有差错都要**先登记、再处理**，不能在比对过程中顺手改业务数据，否则对账结果就无法复现了。

---

## 二、整体流程

![海量数据对账流程](../assets/scenario/reconcile-flow.svg)

1. **拉取与标准化**：内部流水从从库或离线库按游标分批拉取；渠道账单下载后流式解析。两边统一成同一种结构：交易号、金额（分）、归一后的状态、对账日期。原始账单文件原样存进对象存储，方便事后追溯，见 [对象存储](/architecture/4_object_storage)
2. **分片**：按「日期 + 商户 + `hash(交易号) % N`」切片。同一笔交易两边一定落在同号分片，原理与 [海量数据算法题](./3_massive_data) 的哈希分桶相同
3. **比对**：先比每个分片的摘要，只对摘要不一致的分片比明细
4. **差错登记**：比出的差异写入差错表，唯一键保证重跑不会重复登记
5. **处理**：能自动处理的走补单、冲正、退款，必须幂等；判断不了的进人工复核队列
6. **报表与告警**：输出对账结果、差错笔数与金额，超过阈值告警

---

## 三、比对方法

下面统一按「一天 2000 万笔交易、交易号 32 个 ASCII 字符」估算，1KB = 1024B，金额以「分」为单位用 long 存储。

### 1、内存 HashMap：小数据量

把一边装进 `HashMap<交易号, 记录>`，顺序扫描另一边逐条查找、查到就移除，扫完后 Map 里剩下的就是「只在这一边」的记录。

每个条目的内存（64 位 JVM，开启压缩指针）：

| 部分 | 计算 | 大小 |
|------|------|------|
| HashMap.Node | 对象头 12B + hash 4B + key / value / next 三个引用 12B，对齐到 8 | 32B |
| 交易号 String | String 对象 24B + byte[]（头 16B + 内容 32B） | 72B |
| 记录对象 | 对象头 12B + long 金额 8B + 状态引用 4B，对齐到 8 | 24B |
| 合计 | 32 + 72 + 24 | 128B |

2000 万条：2 × 10⁷ × 128B = 2.56 × 10⁹ B ≈ 2.38GB；再加哈希表数组，2 × 10⁷ ÷ 0.75 ≈ 2667 万，向上取到 2²⁵ 个槽，2²⁵ × 4B = 128MB，合计约 2.5GB。

**结论**：几百万条以内直接用 HashMap 最省事；上千万条一次装入，堆压力和 Full GC 风险都太大。

### 2、哈希分片后逐片比对

两边都按 `hash(交易号) % N` 写成 N 个分片，然后逐对装入 HashMap 比对。取 N = 64：

- 每片条数：2 × 10⁷ ÷ 64 = 312,500 条
- 每片 Map：312,500 × 128B = 4 × 10⁷ B ≈ 38MB；哈希表数组 312,500 ÷ 0.75 ≈ 41.7 万，取 2¹⁹ 个槽，2¹⁹ × 4B = 2MB，合计约 40MB
- 8 个分片并行：约 320MB，普通的对账服务就能承受

分片还有一个好处：**分片是最小的重跑单位**。某个分片失败或数据有误，只重跑这一片，不必把整天重来。

### 3、两边排序后归并比对

如果两边都已按交易号有序，就不需要 Map，用两个指针同步往前走，内存只占两条当前记录：

```java
enum Status { SUCCESS, REFUNDED, CLOSED }
enum DiffType { LONG, SHORT, AMOUNT_MISMATCH, STATUS_MISMATCH }
record Txn(String tradeNo, long amountFen, Status status) {}
record Diff(DiffType type, Txn ours, Txn channel) {}

// ours、channel 都已按 tradeNo 升序且各自无重复，顺序读一遍即可
static void mergeCompare(Iterator<Txn> ours, Iterator<Txn> channel, Consumer<Diff> out) {
    Txn a = next(ours), b = next(channel);
    while (a != null || b != null) {
        int c = a == null ? 1 : b == null ? -1 : a.tradeNo().compareTo(b.tradeNo());
        if (c < 0) {                                   // 只在内部：短款或在途
            out.accept(new Diff(DiffType.SHORT, a, null));
            a = next(ours);
        } else if (c > 0) {                            // 只在渠道：长款
            out.accept(new Diff(DiffType.LONG, null, b));
            b = next(channel);
        } else {
            if (a.amountFen() != b.amountFen()) {
                out.accept(new Diff(DiffType.AMOUNT_MISMATCH, a, b));
            } else if (a.status() != b.status()) {
                out.accept(new Diff(DiffType.STATUS_MISMATCH, a, b));
            }
            a = next(ours);
            b = next(channel);
        }
    }
}

static Txn next(Iterator<Txn> it) {
    return it.hasNext() ? it.next() : null;
}
```

两个前提必须保证：

- **两边排序规则完全一致**：内部侧用 `ORDER BY trade_no` 从数据库读时，MySQL 默认的 `utf8mb4_0900_ai_ci` 不区分大小写，和 Java 的 `String.compareTo` 顺序不同，交易号含大小写字母时会把相同的记录错判成两条单边账。交易号列用 `ascii_bin` / `utf8mb4_bin`，或者两边都在 Java 里用同一个比较器排序
- **每边各自无重复**：渠道账单偶尔会有重复行，标准化时先去重，否则指针会错位

渠道账单通常不保证按交易号有序，文件太大时先做外部排序，做法见 [海量数据算法题](./3_massive_data#一、通用套路)。

### 4、先比分片摘要，再比明细

绝大多数分片两边是一致的，没必要逐条比。标准化时顺手给每个分片算一个摘要，先比摘要，只有摘要不一致的分片才比明细：

![先比分片摘要，再比明细](../assets/scenario/reconcile-summary.svg)

摘要由三项组成：**笔数 count、金额合计 sum、记录哈希之和**。前两项能发现漏单和金额差，第三项能发现「笔数和金额都对上、但交易号或状态不同」的情况。

```java
// 每个分片一个累加器；两边用同样的方式计算
final class ShardSummary {
    long count;
    long sumFen;
    long hashSum;                                       // 64 位求和，溢出回绕，与顺序无关

    void add(Txn t) {
        count++;
        sumFen += t.amountFen();
        String row = t.tradeNo() + '|' + t.amountFen() + '|' + t.status();
        hashSum += hash64(row.getBytes(StandardCharsets.UTF_8));
    }

    boolean sameAs(ShardSummary o) {
        return count == o.count && sumFen == o.sumFen && hashSum == o.hashSum;
    }

    static long hash64(byte[] b) {                      // FNV-1a 64 位，演示用
        long h = 0xcbf29ce484222325L;
        for (byte x : b) {
            h ^= (x & 0xff);
            h *= 0x100000001b3L;
        }
        return h;
    }
}
```

- 用「哈希之和」而不是「哈希异或」：异或时同一条记录出现两次会互相抵消，重复记录就查不出来了
- 摘要也可以落成摘要表，例如 `recon_summary(bill_date, merchant_id, shard, side, cnt, sum_fen, hash_sum)`，按天、按商户留存。1 万个商户 × 64 片 × 2 边 ≈ 128 万行，一天的摘要很小，之后重跑、追查都先看这张表

### 5、数据库内 FULL OUTER JOIN

两边数据已经在同一个库里（例如渠道账单导入了对账库的临时表），可以直接用 SQL 比对。MySQL 不支持 `FULL OUTER JOIN`，用「左连接 + 反向反连接」拼出来：

```sql
-- 内部有：渠道没有，或金额 / 状态不同
SELECT o.trade_no, o.amount_fen AS our_fen, c.amount_fen AS ch_fen, o.status AS our_st, c.status AS ch_st
FROM recon_ours o
LEFT JOIN recon_channel c ON c.trade_no = o.trade_no AND c.bill_date = o.bill_date
WHERE o.bill_date = '2026-10-08'
  AND (c.trade_no IS NULL OR c.amount_fen <> o.amount_fen OR c.status <> o.status)
UNION ALL
-- 只在渠道有
SELECT c.trade_no, NULL, c.amount_fen, NULL, c.status
FROM recon_channel c
LEFT JOIN recon_ours o ON o.trade_no = c.trade_no AND o.bill_date = c.bill_date
WHERE c.bill_date = '2026-10-08' AND o.trade_no IS NULL;
```

- **适用**：几百万条以内、两张表都有 `(bill_date, trade_no)` 索引、在独立的对账库或分析库里执行；ClickHouse、Hive、Spark SQL 原生支持 `FULL OUTER JOIN`，更大的量交给它们
- **代价**：两次大表连接，会占满 IO 和 Buffer Pool；**绝不能在业务主库上跑**。另外一条大 SQL 失败只能整体重来，没有分片那样的局部重跑能力

### 6、方法对比

| 方法 | 内存 | 适用数据量 | 说明 |
|------|------|------------|------|
| 内存 HashMap | 每条约 128B，2000 万条约 2.5GB | 几百万以内 | 实现最简单 |
| 哈希分片 + HashMap | 单片约 40MB（N = 64） | 千万到亿级 | 可并行、可按片重跑 |
| 排序后归并 | 只有两条当前记录 | 任意，两边需有序 | 要保证排序规则一致 |
| 摘要 + 明细 | 摘要表很小 | 任意，差异集中时收益最大 | 和前三种组合使用 |
| 库内 FULL OUTER JOIN | 由数据库承担 | 几百万以内（MySQL） | 只能在对账库或分析库执行 |

实际系统一般是**分片 + 摘要 + 片内 HashMap 或归并**的组合。

---

## 四、游标分批拉取与断点续跑

### 1、按主键范围分批，不用深分页

`LIMIT offset, size` 在 offset 很大时要先扫过前面所有行，越往后越慢，原因与改法见 [MySQL 索引](/database/1_mysql/4_topic_index#九、深度分页优化) 和 [数据访问性能](/high-perf/10_db_performance#二、深分页)。对账拉数据按主键游标走：

1. 先用 `pay_time` 索引查出当天的 `MIN(id)`、`MAX(id)`
2. 把 `[minId, maxId]` 按区间切成若干段，每段一个子任务，可以并行
3. 段内每次取 `id > lastId ORDER BY id LIMIT 2000`，取完把最后一条的 id 记为新的 lastId

```java
record PayFlow(long id, String tradeNo, long amountFen, String status, LocalDateTime payTime) {}

interface Checkpoints {                       // 位点存在对账库的任务表里
    long load(long taskId, int segment);
    void save(long taskId, int segment, long lastId);
}

interface SegmentWriter {                     // 标准化后写入分片；同一批重复写入必须幂等
    void write(List<PayFlow> batch);
}

void pullSegment(JdbcClient replica, Checkpoints cp, SegmentWriter writer,
                 long taskId, int segment, long endId, LocalDate billDate) {
    long lastId = cp.load(taskId, segment);   // 首次为该段起点 - 1，续跑时为上次的位点
    while (lastId < endId) {
        List<PayFlow> batch = replica.sql("""
                SELECT id, trade_no, amount_fen, status, pay_time FROM pay_flow
                WHERE id > :lastId AND id <= :endId
                  AND pay_time >= :from AND pay_time < :to
                ORDER BY id LIMIT 2000""")
            .param("lastId", lastId).param("endId", endId)
            .param("from", billDate.atStartOfDay()).param("to", billDate.plusDays(1).atStartOfDay())
            .query(PayFlow.class).list();
        if (batch.isEmpty()) break;
        writer.write(batch);
        lastId = batch.getLast().id();
        cp.save(taskId, segment, lastId);     // 先写数据、再存位点
    }
}
```

### 2、任务可重入

「先写数据、再存位点」意味着进程在两步之间挂掉时，下次会把最后一批**再写一遍**。所以写入必须本身幂等，常见两种做法：

- **写中间表**：对账中间表建唯一键 `(bill_date, side, trade_no)`，用 `INSERT ... ON DUPLICATE KEY UPDATE` 或 `INSERT IGNORE`，重复写入不产生重复行；位点和这批数据也可以放在同一个事务里提交。批量写入的参数（`rewriteBatchedStatements` 等）见 [数据访问性能](/high-perf/10_db_performance#三、批量写入)
- **写分片文件**：以分片为单位，分片失败就删掉该片的输出文件整片重跑；位点只记录「哪些分片已完成」

任务本身也要能重入：用一张任务表记录 `(channel, bill_date)` 的批次和每个分片的状态（待执行 / 执行中 / 完成 / 失败），重启后只捡起未完成的分片；同一天的任务用唯一键或分布式调度保证只有一个实例在跑，见 [异步任务与定时任务](/spring-boot/9_async_schedule#三、多实例下的定时任务)。

---

## 五、时间窗口与在途数据

### 1、T+1 与准实时对账

| 方式 | 时机 | 数据来源 | 用途 |
|------|------|----------|------|
| T+1 对账 | 次日渠道账单出来后（通常上午） | 渠道日对账单 | 资金核对的依据，结果用于清结算 |
| 准实时对账 | 每 5～15 分钟一个窗口 | 渠道查单接口、回调记录 | 尽早发现掉单，缩短用户「付了钱订单没变」的时间 |

准实时对账只是 T+1 的补充：它用的查单接口有频率限制，覆盖不了全量，最终以日对账单为准。

### 2、跨日交易与在途

用户 23:59:58 发起支付，渠道 00:00:03 才完成，这笔交易在内部可能记在 10-08，在渠道账单里却在 10-09。直接比对，10-08 会多一条「短款」，10-09 会多一条「长款」，都是误报。

- **统一口径**：内部侧按渠道的完成时间（而不是下单时间）归入对账日；有的银行在 23:00 日切，日切时间按渠道单独配置，时间带上时区
- **在途**：只在内部有、且时间靠近日切点或渠道状态尚未终态的记录，先登记为「在途」，不算差错
- **二次对账**：次日的账单到了以后，把前一天的在途记录再比一次。对上了就关闭；连续两个账期都对不上才转成真正的短款并告警
- **从库延迟**：从从库拉取时，如果主从延迟还没追上，会把刚成功的交易漏掉，误报成长款。拉取前检查复制延迟，或者把拉取时间安排在日切后足够久

---

## 六、差错处理

### 1、差错表

```sql
CREATE TABLE recon_diff (
    id           BIGINT PRIMARY KEY AUTO_INCREMENT,
    batch_id     BIGINT      NOT NULL,              -- 哪个对账批次发现的
    channel      VARCHAR(16) NOT NULL,
    bill_date    DATE        NOT NULL,
    trade_no     VARCHAR(64) NOT NULL,
    diff_type    VARCHAR(20) NOT NULL,              -- LONG / SHORT / AMOUNT_MISMATCH / STATUS_MISMATCH
    our_fen      BIGINT NULL,
    channel_fen  BIGINT NULL,
    status       VARCHAR(20) NOT NULL,              -- 处理状态，见下方状态机
    handle_type  VARCHAR(20) NULL,                  -- SUPPLEMENT / REFUND / ADJUST / HANG
    handler      VARCHAR(32) NULL,                  -- 人工处理人
    remark       VARCHAR(255) NULL,
    updated_at   DATETIME    NOT NULL,
    UNIQUE KEY uk_diff (channel, bill_date, trade_no, diff_type)
);
```

唯一键保证同一天重跑对账不会重复登记；重跑时发现差错已经消失（例如二次对账对上了），把对应记录推进到「已解决」，而不是删除。

### 2、处理状态机

| 当前状态 | 事件 | 下一状态 |
|----------|------|----------|
| 在途 IN_TRANSIT | 二次对账对上 | 已解决 RESOLVED |
| 在途 IN_TRANSIT | 二次对账仍对不上 | 待处理 NEW |
| 待处理 NEW | 规则可自动处理 | 处理中 PROCESSING |
| 待处理 NEW | 规则判断不了 | 待复核 MANUAL |
| 处理中 PROCESSING | 补单 / 退款成功 | 已解决 RESOLVED |
| 处理中 PROCESSING | 自动处理失败 | 待复核 MANUAL |
| 待复核 MANUAL | 复核通过，调账或补单 | 已解决 RESOLVED |
| 待复核 MANUAL | 暂时无法处理 | 挂账 HANG |

每次状态迁移都用条件更新：`UPDATE recon_diff SET status = ? WHERE id = ? AND status = ?`，影响行数为 0 说明已被别人处理过，直接放弃。原理见 [幂等设计](/architecture/5_idempotence#四、条件更新-状态机与版本号)。

### 3、自动处理必须幂等

对账任务会重跑、处理任务会重试，自动处理一定会被执行多次。

**补单（长款，订单仍是待支付）**：认领差错（直接推进到已解决）、改订单、写发件箱放在**同一个本地事务**里，靠条件更新保证只成功一次；要发的 MQ 消息先写进 outbox 表，提交后由投递器发送，不在事务里直接发：

```java
class ManualReviewException extends RuntimeException {
    ManualReviewException(long diffId) { super("diff " + diffId + " needs manual review"); }
}

@Transactional
public void supplement(long diffId, String orderNo, String tradeNo, long amountFen) {
    int claimed = jdbc.sql("UPDATE recon_diff SET status = 'RESOLVED', handle_type = 'SUPPLEMENT', updated_at = NOW() "
                    + "WHERE id = ? AND status IN ('NEW', 'PROCESSING')")
            .param(diffId).update();
    if (claimed == 0) return;                            // 已处理过，重复执行直接返回
    int paid = jdbc.sql("UPDATE t_order SET status = 'PAID', pay_trade_no = ? "
                    + "WHERE order_no = ? AND status = 'WAIT_PAY' AND pay_amount_fen = ?")
            .param(tradeNo).param(orderNo).param(amountFen).update();
    if (paid == 0) throw new ManualReviewException(diffId); // 订单已关闭或金额不符：整体回滚，由调用方转人工
    jdbc.sql("INSERT INTO outbox (topic, biz_key, payload) VALUES ('order-paid', ?, ?)")
            .param(orderNo).param(tradeNo).update();
}
```

**退款（长款，订单已关闭）**：调用渠道退款是外部调用，不能放在数据库事务里。分三步：条件更新 `NEW → PROCESSING` 认领 → 用**固定的退款单号**（例如 `"RC" + diffId`）调渠道退款，渠道按退款单号去重 → 成功后 `PROCESSING → RESOLVED`。中途进程挂掉，补偿任务捞出长时间停在 PROCESSING 的记录重试，因为退款单号不变，重复调用也只会退一次。状态不一致时的冲正或状态推进，同样以渠道终态为准、用 `WHERE status = 旧状态` 的条件更新。

### 4、人工复核

复核页面展示两边的原始记录（含账单原文件中的行）和历史处理记录；调账、补单等资金操作走「一人提交、另一人审批」，操作人和时间写进差错表与审计日志；挂账超过约定期限仍未处理的升级告警。

---

## 七、工程要点

### 1、分片并行

分片之间互不依赖，用有界线程池并行处理，线程数按源库能承受的并发和对账机器的内存（单片约 40MB）来定，不要用无界队列。线程池参数与拒绝策略见 [线程池](/java/28_topic_thread_pool)，Spring 中的配置见 [异步任务与定时任务](/spring-boot/9_async_schedule)。

### 2、限速，别压垮源库

- **只读从库或离线库**（数仓、Binlog 同步出来的对账库），不碰业务主库
- 每个子任务按批限速（例如每秒不超过 N 批），总并发设上限；业务高峰时段自动降速或暂停
- 监控源库的 QPS、从库复制延迟，超过阈值就暂停拉取

### 3、结果可追溯

每次对账是一个**批次**：记录渠道、对账日、账单文件的存储路径与文件哈希、开始结束时间、各分片摘要。同一天重跑生成新批次，旧批次保留；差错记录带上 `batch_id`，任何一条差错都能追到当时用的账单和摘要。原始账单文件保留到审计要求的期限。

### 4、告警

| 告警项 | 触发条件示例 |
|--------|--------------|
| 账单未就绪 | 约定时间后仍下载不到渠道账单 |
| 任务超时 | 对账未在上午 10 点前完成 |
| 差错率 | 差错笔数 / 总笔数超过 0.01% |
| 差错金额 | 单日长款或短款合计超过阈值 |
| 积压 | 待复核、挂账记录超过约定天数未处理 |

---

## 小结

- 对账的本质是两份数据按关联键逐条核对，差错分为长款、短款、金额不一致、状态不一致，先登记、再处理
- 2000 万条一次装入 HashMap 约 2.5GB；按 `hash(交易号) % 64` 分片后单片约 40MB，还能按片并行、按片重跑
- 两边有序时用双指针归并，内存只占两条记录，但排序规则必须一致；先比分片摘要（count + sum + 哈希之和），只对不一致的分片比明细
- 拉取按主键游标分批，先写数据再存位点，写入本身要幂等，任务按分片重入
- 跨日交易按渠道完成时间归日，靠近日切点的单边记录先记为在途，次日二次对账仍对不上才算短款
- 自动补单在一个本地事务里完成认领、改单、写 outbox；退款用固定退款单号保证重试只退一次
- 只读从库或离线库并限速，每个批次保留账单原文件与摘要，差错率和差错金额超阈值告警

## 参考资料

- 微信支付 APIv3：申请交易账单：[https://pay.weixin.qq.com/wiki/doc/apiv3/apis/chapter3_1_6.shtml](https://pay.weixin.qq.com/wiki/doc/apiv3/apis/chapter3_1_6.shtml)
- Fowler–Noll–Vo hash function：[https://en.wikipedia.org/wiki/Fowler%E2%80%93Noll%E2%80%93Vo_hash_function](https://en.wikipedia.org/wiki/Fowler%E2%80%93Noll%E2%80%93Vo_hash_function)
- Spring Framework：JdbcClient：[https://docs.spring.io/spring-framework/reference/data-access/jdbc/core.html#jdbc-JdbcClient](https://docs.spring.io/spring-framework/reference/data-access/jdbc/core.html#jdbc-JdbcClient)
- Transactional outbox：[https://microservices.io/patterns/data/transactional-outbox.html](https://microservices.io/patterns/data/transactional-outbox.html)

> 下一篇：[海量数据导入导出](./3_sheet_export) —— 百万行 Excel / CSV 的流式读写、分批入库、异步任务与文件下载。
