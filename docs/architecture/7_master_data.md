---
description: 元数据驱动建模、唯一性约束、草稿与审批、Outbox 可靠分发、版本号防乱序、缓存与数据质量
---

# 主数据系统设计

> **本篇目标**：设计一个可落地的主数据系统（MDM）：用元数据驱动支持动态字段并在数据库层保证唯一性，审批前后的数据分离，变更通过 Outbox 可靠分发、下游按版本号防乱序，缓存在事务提交后失效，批量任务分页处理。
>
> **前置阅读**：[消息队列基础](/messaging/1_basics)（幂等消费与分布式事务中的消息）、[缓存一致性](/cache/10_cache_consistency)

主数据（Master Data）是企业核心业务实体的权威数据源，如客户、产品、供应商、组织机构。它的特点是**变更少、读取多、被很多系统引用**：一条客户信息改错，订单、财务、CRM 都会跟着错。主数据系统负责统一建模、审批、分发和治理这些数据。

---

## 一、核心模块架构

![主数据平台架构](../assets/architecture/master-data-arch.svg)

| 模块 | 职责 |
|------|------|
| 数据建模 | 定义主数据类型、字段、校验规则与唯一键 |
| 审批 | 变更以草稿提交，审批通过后才生效 |
| 同步与集成 | 从上游系统（ERP 等）导入，向下游系统分发变更 |
| 数据获取 | 查询 API + 缓存，支撑高读取量 |
| 版本与审计 | 每次生效都生成新版本并记录前后快照 |
| 数据质量 | 完整性、唯一性、格式与疑似重复检测 |

---

## 二、数据建模

### 1、元数据驱动（动态字段）

不同类型的主数据字段差异很大，通常用**元数据驱动**：类型和字段定义存表，字段值存 JSON 列。

```sql
-- 主数据类型
CREATE TABLE mdm_object_type (
    id          BIGINT       PRIMARY KEY,
    type_code   VARCHAR(64)  NOT NULL UNIQUE,      -- customer、product
    type_name   VARCHAR(128) NOT NULL
);

-- 字段定义（元数据）
CREATE TABLE mdm_field_def (
    id          BIGINT       PRIMARY KEY,
    type_code   VARCHAR(64)  NOT NULL,
    field_code  VARCHAR(64)  NOT NULL,
    field_name  VARCHAR(128) NOT NULL,
    field_type  VARCHAR(32)  NOT NULL,             -- STRING / NUMBER / DATE / ENUM
    required    TINYINT      NOT NULL DEFAULT 0,
    unique_key  TINYINT      NOT NULL DEFAULT 0,
    UNIQUE KEY uk_type_field (type_code, field_code)
);

-- 正式数据：只保存已审批生效的版本
CREATE TABLE mdm_object (
    id          BIGINT       PRIMARY KEY,
    type_code   VARCHAR(64)  NOT NULL,
    object_code VARCHAR(128) NOT NULL,             -- 业务唯一编码
    status      VARCHAR(16)  NOT NULL,             -- ACTIVE / DISABLED / DELETED
    ext_data    JSON         NOT NULL,             -- 动态字段值
    version     INT          NOT NULL DEFAULT 1,   -- 每次生效 +1，下游据此防乱序
    created_at  DATETIME     NOT NULL,
    updated_at  DATETIME     NOT NULL,
    UNIQUE KEY uk_type_code (type_code, object_code)
);

-- 外部系统编码映射：ERP、CRM 的编码对应到同一个主数据
CREATE TABLE mdm_object_mapping (
    source_system VARCHAR(32)  NOT NULL,
    external_code VARCHAR(128) NOT NULL,
    object_id     BIGINT       NOT NULL,
    PRIMARY KEY (source_system, external_code)
);
```

JSON 列只解决「字段可扩展」，不解决查询性能：按 JSON 内的字段过滤会全表扫描，需要为常用字段建**生成列 + 索引**，数组类字段可用 MySQL 8.0.17+ 的多值索引。

### 2、唯一性由数据库保证

字段级的唯一性不能靠「先查是否存在再写入」：两个并发提交会同时查到不存在。JSON 列不能直接加唯一约束，有两种做法：

```sql
-- 做法一：固定的关键字段用生成列 + 唯一索引（如客户的统一社会信用代码）
ALTER TABLE mdm_object
    ADD COLUMN credit_code VARCHAR(32)
        GENERATED ALWAYS AS (ext_data ->> '$.creditCode') STORED,
    ADD UNIQUE KEY uk_type_credit (type_code, credit_code);   -- NULL 不参与唯一性比较

-- 做法二：元数据里配置的唯一字段写入唯一键表，与正式数据同事务
CREATE TABLE mdm_unique_value (
    type_code   VARCHAR(64)  NOT NULL,
    field_code  VARCHAR(64)  NOT NULL,
    field_value VARCHAR(255) NOT NULL,
    object_id   BIGINT       NOT NULL,
    PRIMARY KEY (type_code, field_code, field_value)
);
```

应用层校验只负责必填、类型、格式这类无并发问题的规则，唯一性冲突以数据库的 `DuplicateKeyException` 为准，再转换成友好的提示。

---

## 三、变更审批：草稿与正式数据分离

待审批的变更**不能直接改正式记录**，否则审批通过前读者就能看到未审批的数据。变更以「变更单」形式保存草稿，审批通过时在一个本地事务里完成：生成新版本、写审计日志、写 Outbox。

```sql
CREATE TABLE mdm_change_request (
    id          BIGINT      PRIMARY KEY,
    object_id   BIGINT      NULL,                  -- 新建时为空
    change_type VARCHAR(16) NOT NULL,              -- CREATE / UPDATE / DELETE
    draft_data  JSON        NOT NULL,              -- 变更后的完整快照
    base_version INT        NULL,                  -- 基于哪个版本修改，生效时校验
    status      VARCHAR(16) NOT NULL,              -- DRAFT / PENDING / APPROVED / REJECTED
    submitter   VARCHAR(64) NOT NULL,
    created_at  DATETIME    NOT NULL
);
```

```java
@Service
public class MdmChangeService {
    private final MdmChangeRequestRepository changeRepo;
    private final MdmObjectRepository objectRepo;
    private final MdmChangeLogRepository changeLogRepo;
    private final OutboxRepository outboxRepo;
    private final ApplicationEventPublisher events;

    public MdmChangeService(MdmChangeRequestRepository changeRepo, MdmObjectRepository objectRepo,
                            MdmChangeLogRepository changeLogRepo, OutboxRepository outboxRepo,
                            ApplicationEventPublisher events) {
        this.changeRepo = changeRepo;
        this.objectRepo = objectRepo;
        this.changeLogRepo = changeLogRepo;
        this.outboxRepo = outboxRepo;
        this.events = events;
    }

    @Transactional
    public void submit(long changeId, String submitter) {
        MdmChangeRequest change = changeRepo.findById(changeId).orElseThrow();
        change.submit(submitter);                               // DRAFT → PENDING，内部校验状态
        changeRepo.save(change);
        events.publishEvent(new ApprovalRequested(changeId));   // 只登记，提交后才通知审批人
    }

    @Transactional
    public void approve(long changeId, String approver) {
        MdmChangeRequest change = changeRepo.findById(changeId).orElseThrow();
        boolean completed = change.approve(approver);           // 推进审批节点
        changeRepo.save(change);
        if (!completed) {
            return;                                             // 多级审批未走完
        }
        MdmObject before = change.objectId() == null
                ? null : objectRepo.findById(change.objectId()).orElseThrow();
        MdmObject after = change.applyTo(before);               // 生成新版本，version + 1
        objectRepo.save(after);                                 // UPDATE ... WHERE version = base_version
        changeLogRepo.save(MdmChangeLog.of(before, after, approver));  // 审计与业务同事务
        outboxRepo.save(OutboxMessage.mdmChanged(after));        // 分发事件同事务写入 Outbox
        events.publishEvent(new MdmChanged(after.getTypeCode(), after.getObjectCode()));
    }
}

@Component
public class MdmAfterCommitListener {
    private final MdmCacheService cacheService;
    private final ApprovalNotifier notifier;

    public MdmAfterCommitListener(MdmCacheService cacheService, ApprovalNotifier notifier) {
        this.cacheService = cacheService;
        this.notifier = notifier;
    }

    @TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT)
    public void onChanged(MdmChanged e) {
        cacheService.evict(e.typeCode(), e.objectCode());       // 提交后再删缓存
    }

    @TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT)
    public void onApprovalRequested(ApprovalRequested e) {
        notifier.notifyCurrentApprover(e.changeId());           // 站内信 / 邮件，失败可重试
    }
}
```

- 生效时按 `base_version` 做乐观锁：审批期间正式数据被别的变更改过，本次生效失败，退回提交人基于最新版本重新修改
- 审计日志与正式数据在同一个事务里写入，不会出现「业务回滚了但日志写进去了」；`MdmChangeLog.of` 要处理新建时 `before` 为空的情况
- 通知审批人、删除缓存都放在**提交后**执行；跨系统的可靠分发走 Outbox，不在事务里直接发 MQ

---

## 四、数据分发

### 1、可靠发布：Outbox

![主数据变更分发链路](../assets/architecture/mdm-distribution.svg)

审批事务里写入的 Outbox 记录，由投递任务（定时轮询或 CDC 订阅 binlog）发送到 MQ，成功后标记已发送；已经在用 RocketMQ 的团队也可以用事务消息替代。两种做法的细节与对比见 [消息队列基础](/messaging/1_basics) 的「分布式事务中的消息」一节。

事件内容的约定：

- 携带 `typeCode`、`objectCode`、`version` 和**变更后的完整快照**，而不是差异：下游重复处理同一事件结果不变
- 以 `objectCode` 作为消息 key，同一主数据的事件进入同一个分区 / 队列（Kafka 按 key 分区、RocketMQ 顺序消息），减少乱序
- 投递可能重复，下游必须幂等

### 2、下游消费：版本号防乱序

顺序消息只能降低乱序概率（重试、重放、多来源时仍可能乱序），可靠的做法是下游按版本号只接受更新的数据：

```sql
-- 下游本地副本表：object_code 唯一，data 赋值写在 version 之前
INSERT INTO local_customer (object_code, version, data)
VALUES (#{objectCode}, #{version}, #{data}) AS incoming
ON DUPLICATE KEY UPDATE
    data    = IF(incoming.version > local_customer.version, incoming.data, local_customer.data),
    version = GREATEST(local_customer.version, incoming.version);
```

- 旧版本、重复版本的事件不会覆盖新数据，天然幂等
- MySQL 按书写顺序计算 `ON DUPLICATE KEY UPDATE` 的赋值，`data` 必须写在 `version` 之前，否则比较时 `version` 已被更新
- 行别名 `AS incoming` 是 MySQL 8.0.19+ 写法，替代已废弃的 `VALUES(col)` 函数
- 消费者要实时推送给前端时，由 MQ 消费后再推送 WebSocket / SSE，见 [WebSocket](/netty/10_websocket) 与 [SSE（Server-Sent Events）](/netty/11_sse)；不要用各实例本地内存队列加定时轮询，多实例下每个实例只拿得到自己的事件

### 3、外部导入：分页拉取

从 ERP 等上游导入时，按更新时间增量、分页拉取，单条一个短事务，不要一次性把全量数据加载进内存：

```java
public void syncFromErp() {
    LocalDateTime startedAt = LocalDateTime.now();
    LocalDateTime since = checkpointRepo.get("ERP_CUSTOMER");
    String cursor = null;
    do {
        ErpPage<ErpCustomer> page = erpClient.queryCustomersUpdatedSince(since, cursor, 500);
        for (ErpCustomer erp : page.items()) {
            importService.importOne("ERP", erp);   // 按 (source_system, external_code) 映射 upsert，单条独立事务
        }
        cursor = page.nextCursor();
    } while (cursor != null);
    checkpointRepo.save("ERP_CUSTOMER", startedAt.minusMinutes(5));   // 留重叠窗口，靠 upsert 幂等去重
}
```

- 导入的数据同样走校验与变更单，可以对可信来源配置自动审批
- 多实例部署时用分布式调度（XXL-JOB 3.x 等）或 ShedLock 保证同一时刻只有一个实例执行，见 [分布式调度](/distributed/6_job_scheduler)

---

## 五、数据获取与缓存

主数据读多写少，适合长 TTL 缓存；它特有的缓存策略是：**提交后删除 + 版本号 + 长 TTL 兜底**。Cache Aside 的一致性原理、延迟双删与基于 binlog 的失效见 [缓存一致性](/cache/10_cache_consistency)。

```java
@Configuration
public class MdmRedisConfig {
    @Bean
    RedisTemplate<String, MdmObjectVO> mdmRedisTemplate(RedisConnectionFactory factory) {
        RedisTemplate<String, MdmObjectVO> template = new RedisTemplate<>();
        template.setConnectionFactory(factory);
        template.setKeySerializer(RedisSerializer.string());
        template.setValueSerializer(new JacksonJsonRedisSerializer<>(MdmObjectVO.class)); // Spring Data Redis 4，基于 Jackson 3
        return template;
    }
}

@Service
public class MdmCacheService {
    private static final String KEY_PREFIX = "mdm:";
    private static final Duration TTL = Duration.ofHours(6);
    private static final Duration NULL_TTL = Duration.ofMinutes(5);

    private final RedisTemplate<String, MdmObjectVO> redis;
    private final MdmObjectRepository objectRepo;

    public MdmCacheService(RedisTemplate<String, MdmObjectVO> redis, MdmObjectRepository objectRepo) {
        this.redis = redis;
        this.objectRepo = objectRepo;
    }

    public Optional<MdmObjectVO> get(String typeCode, String objectCode) {
        String key = KEY_PREFIX + typeCode + ":" + objectCode;
        MdmObjectVO cached = redis.opsForValue().get(key);
        if (cached != null) {
            return cached.exists() ? Optional.of(cached) : Optional.empty();
        }
        Optional<MdmObjectVO> found = objectRepo.findActive(typeCode, objectCode).map(MdmObjectVO::from);
        if (found.isPresent()) {
            Duration jitter = Duration.ofMinutes(ThreadLocalRandom.current().nextInt(30));
            redis.opsForValue().set(key, found.get(), TTL.plus(jitter));    // 随机过期，避免集中失效
        } else {
            redis.opsForValue().set(key, MdmObjectVO.notFound(typeCode, objectCode), NULL_TTL);  // 缓存空值防穿透
        }
        return found;
    }

    public void evict(String typeCode, String objectCode) {
        redis.delete(KEY_PREFIX + typeCode + ":" + objectCode);
    }
}
```

- 删除缓存在事务提交后执行（第三节的 `AFTER_COMMIT` 监听器）：提交前删除，并发读请求会在提交前读到旧值并回填，旧数据要等 6 小时 TTL 才消失
- 提交后进程崩溃会漏删：用 TTL 兜底；要求更高时由 CDC 订阅 binlog 统一失效缓存
- 预热放在 `ApplicationReadyEvent` 之后异步、分页执行，不要写在 `@PostConstruct` 里阻塞启动（此时连接池、事务代理也未必就绪）
- 下游系统本地缓存主数据时，同样以 MQ 事件中的 `version` 判断是否需要刷新

---

## 六、版本与审计

```sql
CREATE TABLE mdm_change_log (
    id          BIGINT      PRIMARY KEY AUTO_INCREMENT,
    object_id   BIGINT      NOT NULL,
    version     INT         NOT NULL,
    operator    VARCHAR(64) NOT NULL,
    change_type VARCHAR(16) NOT NULL,   -- CREATE / UPDATE / DELETE
    before_data JSON        NULL,       -- 新建时为空
    after_data  JSON        NULL,       -- 删除时为空
    changed_at  DATETIME    NOT NULL,
    UNIQUE KEY uk_object_version (object_id, version)
);
```

审计日志在审批生效的同一事务中写入（见第三节），比用切面在方法前后各查一次数据库更可靠，也不会多出两次查询。需要覆盖「绕过系统直接改库」的情况时，再加一层基于 binlog 的审计。

---

## 七、数据质量控制

| 检查类型 | 说明 | 触发时机 |
|---------|------|---------|
| 完整性 | 必填字段不为空 | 提交 / 导入时 |
| 唯一性 | 业务编码与唯一字段不重复（数据库约束） | 生效时 |
| 格式合规 | 手机号、邮箱、信用代码等规则校验 | 提交 / 导入时 |
| 逻辑一致性 | 如省市区层级关系合法 | 提交时 |
| 疑似重复 | 名称相似、地址相近的记录 | 定时批量扫描 |

批量扫描按主键游标分页，疑似重复检测先**分桶**（按标准化后的名称前缀、税号、电话等分组）再在桶内计算相似度，避免全量两两比对的 O(n²)：

```java
public void runQualityCheck() {
    long lastId = 0;
    List<MdmObject> batch;
    do {
        batch = objectRepo.findActiveAfterId(lastId, 1000);       // WHERE id > ? ORDER BY id LIMIT 1000
        for (MdmObject obj : batch) {
            issueRepo.saveAll(completenessChecker.check(obj));
            duplicateBuckets.add(obj);                             // 只记录 分桶键 → (id, 标准化名称)
        }
        if (!batch.isEmpty()) {
            lastId = batch.get(batch.size() - 1).getId();
        }
    } while (batch.size() == 1000);
    issueRepo.saveAll(duplicateBuckets.findSimilarWithinBuckets(0.9));
}
```

定时扫描同样需要分布式调度保证单实例执行；数据量更大时把检测下沉到离线计算平台。

---

## 小结

- 元数据驱动建模：类型与字段定义存表、字段值存 JSON；常用查询字段建生成列索引
- 唯一性靠数据库约束（生成列唯一索引或唯一值表），应用层先查后写有并发窗口
- 草稿与正式数据分离：审批通过时在一个事务里生成新版本、写审计、写 Outbox
- 分发用 Outbox 或事务消息，事件带版本号与完整快照；下游按版本号条件更新，天然幂等、防乱序
- 缓存在提交后删除，长 TTL 兜底，空值短 TTL 防穿透；预热在启动完成后异步执行
- 导入、质量扫描按游标分页，多实例由分布式调度保证单点执行

## 参考资料

- MySQL Generated Columns：[https://dev.mysql.com/doc/refman/8.4/en/create-table-generated-columns.html](https://dev.mysql.com/doc/refman/8.4/en/create-table-generated-columns.html)
- MySQL Multi-Valued Indexes：[https://dev.mysql.com/doc/refman/8.4/en/create-index.html#create-index-multi-valued](https://dev.mysql.com/doc/refman/8.4/en/create-index.html#create-index-multi-valued)
- MySQL INSERT ... ON DUPLICATE KEY UPDATE：[https://dev.mysql.com/doc/refman/8.4/en/insert-on-duplicate.html](https://dev.mysql.com/doc/refman/8.4/en/insert-on-duplicate.html)
- Spring Framework · Transaction-bound Events：[https://docs.spring.io/spring-framework/reference/data-access/transaction/event.html](https://docs.spring.io/spring-framework/reference/data-access/transaction/event.html)
- Spring Data Redis · Working with Objects through RedisTemplate：[https://docs.spring.io/spring-data/redis/reference/redis/template.html](https://docs.spring.io/spring-data/redis/reference/redis/template.html)
- Debezium · Outbox Event Router：[https://debezium.io/documentation/reference/stable/transformations/outbox-event-router.html](https://debezium.io/documentation/reference/stable/transformations/outbox-event-router.html)
- RocketMQ · Transaction Message：[https://rocketmq.apache.org/docs/featureBehavior/04transactionmessage/](https://rocketmq.apache.org/docs/featureBehavior/04transactionmessage/)

> 返回：[系统架构总览](./0_overview)
