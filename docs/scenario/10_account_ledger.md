---
description: 账户与余额模型、单边流水与借贷分录、幂等记账、冻结与解冻、热点账户、跨库记账、日切对平与冲正、容量估算
---

# 账户与记账

> 前置阅读：[支付](./8_payment)、[幂等设计](/architecture/3_idempotence)

账户系统记录每个主体有多少钱、这些钱是怎么来的，零钱、红包、积分、商户待结算款都建在它上面。本篇讲账户与流水的模型、一笔账怎么记、冻结、热点账户、跨库记账和每天怎么对平，基线为 MySQL 8.4。

---

## 一、需求与挑战

### 1、哪些东西是账户

| 账户 | 属于谁 | 特点 |
|------|------|------|
| 零钱、红包余额 | 用户 | 数量多（每人一个），单个账户的读写很少 |
| 积分、储值卡、礼品卡 | 用户 | 同上；积分还带有效期，见 [排行榜和积分](./14_rank_system) |
| 待结算款 | 商户 | 大商户入账非常频繁，出账（结算）按天 |
| 渠道应收款、手续费收入、营销补贴 | 平台自己 | 只有几十个，但几乎每笔交易都要记一笔，是热点 |

支付中心怎么收款、退款、和渠道对账见 [支付](./8_payment)；本篇只讲钱进了平台之后怎么记。

### 2、挑战

| 挑战 | 说明 |
|------|------|
| 不能扣成负数 | 同一个账户被多个请求同时扣款，余额只够其中一笔 |
| 不能重复记 | 上游重试、消息重复投递，同一笔业务只能记一次 |
| 说得清每一分钱 | 余额是多少不够，还要能回答「这 3 元是哪一笔业务带来的」 |
| 钱不会凭空多出或消失 | 一边扣了、另一边没加，必须能被发现 |
| 结果不确定的中间态 | 提现已发起、银行还没回话，这笔钱既不能再花，也不能算已经花掉 |
| 热点 | 平台的几个内部账户每笔交易都要更新 |

---

## 二、整体架构

![账户与记账整体架构](../assets/scenario/account-arch.svg)

| 组件 | 职责 |
|------|------|
| 记账服务 | 唯一能改余额的地方。业务方不直接更新账户表，只提交凭证 |
| 账户表 | 每个账户一行：余额、冻结金额 |
| 分录流水 | 每次资金变动的明细，只增不改；余额可以由它重新算出来 |
| 冻结记录 | 每一次冻结一行，记录冻结了多少、最后是扣掉了还是放回了 |
| Outbox 事件 | 入账、扣款的结果和记账同一个事务落库，再投递给业务方 |
| 日终任务 | 每天核对一次：借贷是否相等、余额和流水是否对得上 |

---

## 三、账户模型

### 1、账户表

```sql
CREATE TABLE account (
    account_no    VARCHAR(32)  PRIMARY KEY,
    owner_type    VARCHAR(16)  NOT NULL,              -- USER / MERCHANT / PLATFORM
    owner_id      BIGINT       NOT NULL,
    subject       VARCHAR(32)  NOT NULL,              -- 科目：USER_BALANCE / MERCHANT_PENDING / CHANNEL_RECEIVABLE ...
    normal_side   CHAR(1)      NOT NULL,              -- D：借方记增加（资产类）；C：贷方记增加（负债类）
    balance_cent  BIGINT       NOT NULL DEFAULT 0,
    frozen_cent   BIGINT       NOT NULL DEFAULT 0,
    allow_negative TINYINT     NOT NULL DEFAULT 0,    -- 只有平台内部账户才允许透支
    updated_at    DATETIME(3)  NOT NULL,
    UNIQUE KEY uk_owner (owner_type, owner_id, subject),
    CHECK (frozen_cent >= 0 AND (allow_negative = 1 OR balance_cent >= frozen_cent))
);
```

- **金额一律用整数的「分」**，不用浮点数，也不用带小数的金额类型去做加减
- **可用金额 = 余额 − 冻结**，不单独存一列，免得三个数对不上
- `CHECK` 约束是最后一道防线：代码里的条件写错了，数据库也不会让普通账户的余额小于冻结金额

### 2、单边流水还是借贷分录

记账有两种做法，区别在于一笔业务记几条。

| | 单边流水 | 借贷分录 |
|------|------|------|
| 一笔业务记几条 | 1 条：这个账户加了或减了多少 | 至少 2 条：钱从哪个账户出、进了哪个账户，两边金额相等 |
| 能发现什么错 | 余额和流水对不上 | 上一条，再加上「一边记了、另一边没记」 |
| 适合 | 只关心用户这一方的账：积分、站内零钱的简单版本 | 涉及平台自己的钱：收款、结算、手续费、补贴 |
| 例子 | [抢红包](./12_red_packet) 的账户流水、[排行榜和积分](./14_rank_system) 的积分流水 | [支付](./8_payment) 的资金流水 |

单边流水回答不了「用户的零钱多了 100 元，平台的哪个账户相应少了 100 元」。只要钱会在用户、商户、平台之间流转，就用借贷分录。本篇后面都按借贷分录讲，单边流水可以看成只记了其中一边。

借贷分录的规则只有两条：

- **每张凭证借方合计等于贷方合计**
- **账户分两类**：资产类（平台拥有的，如渠道应收款、银行存款）借方记增加；负债类（平台欠别人的，如用户零钱、商户待结算款）贷方记增加。收入类（如手续费收入）和负债类一样，贷方记增加

| 业务 | 借 | 贷 |
|------|----|----|
| 用户充值 100 元 | 渠道应收款 100 | 用户零钱 100 |
| 用零钱支付 80 元 | 用户零钱 80 | 商户待结算 80 |
| 退款 30 元到零钱 | 商户待结算 30 | 用户零钱 30 |
| 提现 50 元，手续费 1 元 | 用户零钱 50 | 银行存款 49、手续费收入 1 |

用户零钱是平台欠用户的钱，所以充值记在贷方（增加），支付和提现记在借方（减少）。

### 3、流水表

```sql
CREATE TABLE account_journal (
    id                 BIGINT       PRIMARY KEY,
    voucher_no         VARCHAR(64)  NOT NULL,          -- 凭证号，由业务单号派生
    line_no            INT          NOT NULL,          -- 凭证内第几行
    account_no         VARCHAR(32)  NOT NULL,
    direction          CHAR(1)      NOT NULL,          -- D 借 / C 贷
    amount_cent        BIGINT       NOT NULL,          -- 永远为正
    balance_after_cent BIGINT       NOT NULL,          -- 记完这一笔之后的余额
    biz_type           VARCHAR(32)  NOT NULL,
    biz_no             VARCHAR(64)  NOT NULL,
    biz_date           DATE         NOT NULL,          -- 会计日，见第八节
    created_at         DATETIME(3)  NOT NULL,
    UNIQUE KEY uk_voucher_line (voucher_no, line_no),
    KEY idx_account (account_no, id),
    KEY idx_date (biz_date, account_no)
);
```

- **凭证号由业务单号派生**（如 `PAY-{交易单号}`、`REFUND-{退款单号}`），同一笔业务重复记账会撞唯一键
- **记后余额**让每个账户的流水能自己验算：相邻两条的记后余额之差，应当等于后一条的金额
- **流水只增不改**。记错了不改不删，用一张反方向的凭证冲掉，见第八节

---

## 四、记一笔账

### 1、凭证：借贷平衡、按固定顺序更新

```java
public record Entry(String accountNo, char direction, long amountCent) {}

@Component
public class Ledger {

    private final AccountMapper accountMapper;             // 构造器注入省略
    private final JournalMapper journalMapper;

    @Transactional(propagation = Propagation.MANDATORY)    // 必须在调用方的业务事务里执行
    public void post(String voucherNo, String bizType, String bizNo, List<Entry> entries) {
        long debit = entries.stream().filter(e -> e.direction() == 'D').mapToLong(Entry::amountCent).sum();
        long credit = entries.stream().filter(e -> e.direction() == 'C').mapToLong(Entry::amountCent).sum();
        if (debit <= 0 || debit != credit) {
            throw new IllegalStateException("借贷不平: " + voucherNo);
        }
        // 按账户号排序后逐个更新：两张凭证涉及相同的两个账户时，加锁顺序一致，不会死锁
        List<Entry> ordered = entries.stream().sorted(Comparator.comparing(Entry::accountNo)).toList();
        int line = 0;
        for (Entry e : ordered) {
            Account a = accountMapper.selectForUpdate(e.accountNo());
            long delta = (e.direction() == a.normalSide()) ? e.amountCent() : -e.amountCent();
            long after = a.balanceCent() + delta;
            if (!a.allowNegative() && after < a.frozenCent()) {
                throw new BizException("余额不足: " + e.accountNo());
            }
            accountMapper.updateBalance(e.accountNo(), after);
            journalMapper.insert(voucherNo, ++line, e, after, bizType, bizNo);   // 重复记账撞 uk_voucher_line，整体回滚
        }
    }
}
```

- **先锁行再算**。这里用 `SELECT ... FOR UPDATE` 而不是一条条件更新，是因为要把记后余额写进流水；锁只持有到事务结束，而用户账户按人分散，不会排队
- **余额够不够的判断在锁内做**，两个并发的扣款只有先拿到锁的那个能成功
- **只扣不记流水的简单场景**可以直接用条件更新，如 [抢红包](./12_red_packet) 的发红包扣款：`balance >= 金额` 才扣，影响 0 行就是余额不足

### 2、和业务单同一个事务

记账不是一个可以单独重试的远程调用，而是业务事务的一部分：

```java
@Transactional
public void onPaid(Trade trade) {
    if (tradeMapper.markSuccess(trade.tradeNo()) == 0) {
        return;                                            // 已处理过
    }
    ledger.post("PAY-" + trade.tradeNo(), "PAY", trade.tradeNo(), List.of(
            new Entry(channelReceivable(trade.channel()), 'D', trade.amountCent()),
            new Entry(merchantPending(trade.merchantId()), 'C', trade.amountCent())));
    outbox.append("PAY_SUCCESS", trade.tradeNo(), PaySuccess.of(trade));
}
```

业务单的状态、分录、余额、对外的事件，要么都有，要么都没有。重复的回调有两道防线：业务单的条件更新影响 0 行直接返回；即使绕过了它，凭证号的唯一键也会让整个事务回滚。

业务单和账户不在同一个库时做不到这一点，见第七节。

---

## 五、冻结与解冻

有些钱的去向要过一会儿才能确定：提现发给银行后要等结果，预授权要等实际消费，退款要等审核。这段时间里钱既不能再花，也不能算已经花掉，办法是先冻结。

![冻结、扣减与解冻](../assets/scenario/account-freeze.svg)

```sql
CREATE TABLE account_freeze (
    freeze_no    VARCHAR(64)  PRIMARY KEY,
    account_no   VARCHAR(32)  NOT NULL,
    amount_cent  BIGINT       NOT NULL,
    status       VARCHAR(16)  NOT NULL,                -- FROZEN / DEDUCTED / UNFROZEN
    biz_type     VARCHAR(32)  NOT NULL,
    biz_no       VARCHAR(64)  NOT NULL,
    created_at   DATETIME(3)  NOT NULL,
    UNIQUE KEY uk_biz (biz_type, biz_no)
);
```

以提现为例：

```sql
-- 1. 申请提现：冻结。影响 0 行说明可用金额不够
UPDATE account SET frozen_cent = frozen_cent + #{amt}
WHERE account_no = #{acc} AND balance_cent - frozen_cent >= #{amt};
INSERT INTO account_freeze (freeze_no, account_no, amount_cent, status, biz_type, biz_no, created_at)
VALUES (#{freezeNo}, #{acc}, #{amt}, 'FROZEN', 'WITHDRAW', #{withdrawNo}, NOW(3));

-- 2a. 银行打款成功：先把冻结记录改成已扣减，影响 1 行才继续
UPDATE account_freeze SET status = 'DEDUCTED' WHERE freeze_no = #{freezeNo} AND status = 'FROZEN';
UPDATE account SET frozen_cent = frozen_cent - #{amt} WHERE account_no = #{acc};
-- 然后记一张凭证（借 用户零钱，贷 银行存款），余额在这一步才减少

-- 2b. 打款失败或用户取消：解冻
UPDATE account_freeze SET status = 'UNFROZEN' WHERE freeze_no = #{freezeNo} AND status = 'FROZEN';
UPDATE account SET frozen_cent = frozen_cent - #{amt} WHERE account_no = #{acc};
```

- **冻结记录的状态条件更新是闸门**：打款成功的通知重复到达，或者成功和取消同时到达，只有第一个把 `FROZEN` 改掉的能继续，另一个影响 0 行直接结束
- **冻结期间余额没有变**，流水里也没有这笔钱的分录；只有真正扣减时才记账。所以对账时「余额等于流水累计」始终成立，冻结金额另外和冻结记录核对
- **冻结不能无限期挂着**。定时任务扫描长时间停在 `FROZEN` 的记录，向发起它的业务确认结果；不能直接解冻，银行可能已经打款成功。这和 [库存与票务](./6_inventory) 里「预占过期不等于可以释放」是同一个道理

---

## 六、热点账户

用户账户按人分散，不是热点。热点是平台自己的那几个内部账户和大商户的待结算账户：每笔交易都要更新同一行，而一行的更新只能一个一个来。

| 做法 | 怎么做 | 适用 | 代价 |
|------|------|------|------|
| 拆子账户 | 一个账户拆成 N 个子账户，记账时随机选一个；余额是各子账户之和 | 只增不减、或允许透支的内部账户（手续费收入、渠道应收款） | 要减少时，单个子账户可能不够 |
| 流水先落库，余额异步汇总 | 分录同步写入，余额不在交易事务里更新；汇总任务按流水 ID 的游标累加到余额 | 入账远多于出账的账户（商户待结算） | 余额有延迟 |
| 按批合并 | 在内存里把同一账户几百毫秒内的分录攒成一批，一次更新 | 对延迟不敏感的内部账户 | 进程崩溃会丢，必须能从流水重算 |

选哪种取决于一个问题：**这个账户的余额要不要在交易时实时判断够不够**。

- 不需要判断的（允许透支的内部账户）：三种都可以用
- 需要判断的（商户待结算款在结算、退款时要扣）：**入账可以缓冲，出账必须实时**。入账晚一会儿到，可用金额只会被低估，最坏是一笔本来可以的退款被暂时拒绝；出账如果也缓冲，就可能把同一笔钱花两次

异步汇总的做法：

```sql
-- 汇总任务：每个账户记一个已汇总到的流水 ID（以贷方记增加的账户为例）
SELECT COALESCE(SUM(IF(direction = 'C', amount_cent, -amount_cent)), 0), MAX(id)
FROM account_journal
WHERE account_no = #{acc} AND id > #{lastId} AND id <= #{upperId};

-- 同一个事务里更新余额和游标；游标没变才更新，任务重跑不会重复累加
UPDATE account_summary_cursor SET last_id = #{maxId} WHERE account_no = #{acc} AND last_id = #{lastId};
UPDATE account SET balance_cent = balance_cent + #{sum} WHERE account_no = #{acc};
```

上界 `upperId` 取「几秒之前」分配的 ID，而不是当前最大值：流水的 ID 先分配、后提交，刚分配的 ID 可能还有比它小的没提交，直接扫到最大值会漏。[即时通讯](./18_im) 的消息序号有同样的问题。

热点问题的一般做法见 [热点问题](/high-con/6_hotspot)。

---

## 七、跨库记账

账户表按账户号分库之后，一张凭证的两条分录可能落在两个库里：用户零钱在一个库，商户待结算在另一个库，没法放进一个本地事务。

做法是在每个库里各放一个**在途账户**，把一张跨库的凭证拆成两张各自平衡的凭证，中间用可靠消息连接：

| 步骤 | 在哪个库 | 凭证 |
|------|------|------|
| 1. 扣用户的钱 | 用户零钱所在的库 | 借 用户零钱 80，贷 在途资金 80 |
| 2. 给商户加钱 | 商户待结算所在的库 | 借 在途资金 80，贷 商户待结算 80 |

- 第 1 步和一条待发消息在同一个本地事务里提交，消息至少投递一次
- 第 2 步的凭证号由第 1 步的凭证号派生，重复消费会撞唯一键
- 每个库里每张凭证都是借贷相等的，日终的试算平衡可以按库各自做
- **在途账户的余额应该趋近于 0**：两个库的在途资金一正一负，合计不为 0 的部分就是第 1 步做了、第 2 步还没做的钱。超过几分钟还没清零就告警

顺序必须是**先扣后加**。先加后扣时，如果扣款失败（余额不足），已经加给商户的钱要追回来；先扣后加时，加钱这一步没有失败的业务理由，只会延迟。

不用分布式事务框架的原因和 [支付](./8_payment) 一样：记账是最不能丢、也最不能拖慢的一步，本地事务加可靠消息加对账，比跨库的两阶段提交更可控。方案对比见 [分布式事务](/distributed/4_transaction)。

---

## 八、每天怎么对平

### 1、三个恒等式

| 核对 | 恒等式 | 不成立说明什么 |
|------|------|------|
| 试算平衡 | 当天全部分录的借方合计 = 贷方合计 | 有凭证只记了一边（跨库时两边分开验，再看在途账户） |
| 余额核对 | 每个账户：期末余额 = 期初余额 + 当天流水的净额 | 有人绕过记账服务直接改了余额，或流水有丢失 |
| 冻结核对 | 每个账户：冻结金额 = 状态为冻结中的冻结记录之和 | 冻结和解冻有一步没做完 |

```sql
-- 试算平衡
SELECT SUM(IF(direction = 'D', amount_cent, 0)) AS debit, SUM(IF(direction = 'C', amount_cent, 0)) AS credit
FROM account_journal WHERE biz_date = #{date};

-- 余额核对：先把当天每个账户的借贷合计写进日余额表，再和账户表的余额比
INSERT INTO account_daily (account_no, biz_date, debit_cent, credit_cent)
SELECT account_no, biz_date, SUM(IF(direction = 'D', amount_cent, 0)), SUM(IF(direction = 'C', amount_cent, 0))
FROM account_journal WHERE biz_date = #{date} GROUP BY account_no, biz_date;
```

账户很多时，余额核对只需要算当天有流水的账户；全量核对放到离线库里跑。

和外部的核对不在这里做：渠道应收款的余额应当等于「已收款、渠道还没结算给平台」的金额，这一步靠渠道账单，见 [支付](./8_payment) 与 [海量数据对账](./28_reconcile)。

### 2、会计日与日切

流水上的 `biz_date` 是会计日，在记账时确定，之后不变。它和 `created_at` 的日期大多数时候相同，分开存有两个用处：

- **日切不需要停机**。到了日切时刻，新的凭证记到下一个会计日，日终任务只处理已经结束的那一天
- **补记的账可以归到正确的日期**。昨天的一笔业务今天才发现漏记，凭证记在今天，会计日可以按规则归到昨天或今天，但必须有明确的规则，而且已经出过报表的日期不再接受新凭证

### 3、冲正

记错了不改流水、不直接改余额，而是再记两张凭证：

| 凭证 | 借 | 贷 | 说明 |
|------|----|----|------|
| 原凭证（记错了，应该是 80） | 用户零钱 100 | 商户待结算 100 | 保持原样 |
| 冲正凭证 | 商户待结算 100 | 用户零钱 100 | 和原凭证方向相反、金额相同，凭证号是 `REV-原凭证号` |
| 更正凭证 | 用户零钱 80 | 商户待结算 80 | 正确的那一笔 |

这样任何时候翻流水，都能看到当时记了什么、后来为什么改、是谁改的。冲正凭证的凭证号由原凭证号派生，同一张凭证只能被冲正一次。

---

## 九、容量估算

沿用 [支付](./8_payment) 的假设：**日成功支付 500 万笔**，峰值 3,000 笔/秒；另有 5% 的退款，1 KB = 1024 B。

**流水行数**：每笔支付 2 条分录，退款 5,000,000 × 5% = 250,000 笔、每笔 2 条，合计 (5,000,000 + 250,000) × 2 = 10,500,000 行/天。

**存储**：每行按 200 B 算，索引放大 1.5 倍为 300 B。每天 10,500,000 × 300 B = 3,150,000,000 B ≈ 2.9 GB，每年约 1,070 GB。流水按会计日分区，在线库保留一年，更早的归档。

**热点行**：峰值 3,000 笔/秒时，同一渠道的应收款账户每秒要更新 3,000 次，而一行的更新是串行的，通常只有几百次/秒。按 500 次/秒算，需要 3,000 ÷ 500 = 6 个子账户，留一倍余量取 16 个；或者不在交易事务里更新它的余额，改为异步汇总。

**用户账户**：按 2,000 万个活跃账户算，账户表每行约 150 B，共 20,000,000 × 150 B = 3,000,000,000 B ≈ 2.8 GB，单库放得下。分库是为了分散写入，不是因为放不下。

---

## 小结

- 改余额只有一个入口：记账服务。业务方提交凭证，不直接更新账户表
- 钱在多个主体之间流转就用借贷分录：每张凭证借贷相等，能发现「一边记了、另一边没记」
- 凭证号由业务单号派生并建唯一键，记账和业务单的状态变更在同一个事务里
- 去向没确定的钱先冻结：冻结期间余额不变，结果确定后再扣减或解冻，冻结记录的条件更新是闸门
- 热点账户入账可以缓冲、出账必须实时；跨库时用在途账户把一张凭证拆成两张各自平衡的
- 每天验三个恒等式：借贷相等、余额等于期初加净额、冻结金额等于冻结记录之和；记错了用反向凭证冲正

## 参考资料

- MySQL 8.4 CHECK 约束：[https://dev.mysql.com/doc/refman/8.4/en/create-table-check-constraints.html](https://dev.mysql.com/doc/refman/8.4/en/create-table-check-constraints.html)
- MySQL 8.4 InnoDB 死锁的处理：[https://dev.mysql.com/doc/refman/8.4/en/innodb-deadlocks-handling.html](https://dev.mysql.com/doc/refman/8.4/en/innodb-deadlocks-handling.html)
- Martin Fowler, Accounting Entry：[https://martinfowler.com/eaaDev/AccountingEntry.html](https://martinfowler.com/eaaDev/AccountingEntry.html)
- Martin Fowler, Reversal Adjustment：[https://martinfowler.com/eaaDev/ReversalAdjustment.html](https://martinfowler.com/eaaDev/ReversalAdjustment.html)

> 下一篇：[秒杀](./11_seckill) —— 分层限流、Redis 原子预扣、MQ 异步下单与超时关单的完整链路。
