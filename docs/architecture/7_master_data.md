# 主数据系统设计

> 主数据（Master Data）是企业核心业务实体的权威数据源，如客户、产品、供应商、组织机构。主数据系统（MDM）负责统一管理、分发和治理这些数据。

---

## 一、核心模块架构

![主数据平台架构](../assets/architecture/master-data-arch.svg)

---

## 二、数据建模

### 1. 元数据驱动（动态字段）

主数据字段因业务不同差异大，通常采用**元数据驱动**，支持自定义字段。

```sql
-- 主数据类型定义
CREATE TABLE mdm_object_type (
    id          BIGINT PRIMARY KEY,
    type_code   VARCHAR(64) NOT NULL UNIQUE,  -- 如 customer、product
    type_name   VARCHAR(128) NOT NULL
);

-- 字段定义（元数据）
CREATE TABLE mdm_field_def (
    id          BIGINT PRIMARY KEY,
    type_id     BIGINT NOT NULL,
    field_code  VARCHAR(64) NOT NULL,
    field_name  VARCHAR(128),
    field_type  VARCHAR(32),      -- STRING / NUMBER / DATE / ENUM
    required    TINYINT DEFAULT 0,
    unique_key  TINYINT DEFAULT 0,
    sort_order  INT DEFAULT 0
);

-- 主数据实例（EAV 模型或 JSON 列）
CREATE TABLE mdm_object (
    id          BIGINT PRIMARY KEY,
    type_id     BIGINT NOT NULL,
    object_code VARCHAR(128) NOT NULL UNIQUE,  -- 业务唯一编码
    status      TINYINT DEFAULT 1,             -- 1:有效 2:待审批 3:已删除
    version     INT DEFAULT 1,
    created_at  DATETIME,
    updated_at  DATETIME
);

-- 字段值（JSON 列，兼顾查询性能和扩展性）
ALTER TABLE mdm_object ADD COLUMN ext_data JSON;
```

### 2. 约束与校验规则

```java
@Service
public class MdmFieldValidator {
    public void validate(MdmObject obj, List<FieldDef> fieldDefs) {
        for (FieldDef def : fieldDefs) {
            Object value = obj.getExtData().get(def.getFieldCode());
            // 必填校验
            if (def.isRequired() && (value == null || "".equals(value))) {
                throw new MdmValidationException(def.getFieldName() + " 为必填项");
            }
            // 唯一性校验
            if (def.isUniqueKey() && value != null) {
                boolean exists = mdmRepo.existsByFieldValue(def.getFieldCode(), value, obj.getId());
                if (exists) throw new MdmValidationException(def.getFieldName() + " 值重复");
            }
            // 类型校验
            validateType(def.getFieldType(), value, def.getFieldName());
        }
    }
}
```

---

## 三、数据同步

### 1. 外部同步（导入）

```java
// 定时从上游系统同步（如 ERP → MDM）
@Scheduled(cron = "0 0 1 * * ?")
public void syncFromErp() {
    List<ErpCustomer> erpCustomers = erpClient.queryAllCustomers();
    for (ErpCustomer erp : erpCustomers) {
        MdmObject existing = mdmRepo.findByExternalCode("ERP", erp.getCode());
        if (existing == null) {
            mdmService.create(ErpCustomerConverter.toMdmObject(erp));
        } else if (erp.getUpdateTime().isAfter(existing.getUpdatedAt())) {
            mdmService.update(existing.getId(), ErpCustomerConverter.toMdmObject(erp));
        }
    }
}
```

### 2. 内部同步（下游分发）

主数据变更后，通过 MQ 推送给下游系统（订单、财务、CRM 等）。

```java
@Service
public class MdmEventPublisher {
    @Autowired private RocketMQTemplate rocketMQTemplate;

    public void publishUpdated(MdmObject obj) {
        MdmChangedEvent event = MdmChangedEvent.builder()
            .typeCode(obj.getTypeCode())
            .objectCode(obj.getObjectCode())
            .changeType(ChangeType.UPDATED)
            .snapshot(obj.getExtData())
            .timestamp(Instant.now())
            .build();
        rocketMQTemplate.syncSend("mdm-changed-topic", event);
    }
}

// 下游系统消费
@RocketMQMessageListener(topic = "mdm-changed-topic", consumerGroup = "order-service")
public class MdmChangedConsumer implements RocketMQListener<MdmChangedEvent> {
    @Override
    public void onMessage(MdmChangedEvent event) {
        if ("customer".equals(event.getTypeCode())) {
            customerCacheService.refresh(event.getObjectCode());
        }
    }
}
```

---

## 四、数据审批流

主数据变更通常需要审批，防止脏数据进入生产。

```java
// 审批状态流转
public enum ApprovalStatus { DRAFT, PENDING, APPROVED, REJECTED }

@Service
@Transactional
public class MdmApprovalService {
    // 提交审批
    public void submit(Long objectId, String submitter) {
        MdmObject obj = mdmRepo.findById(objectId);
        obj.setStatus(PENDING);

        ApprovalFlow flow = ApprovalFlow.builder()
            .objectId(objectId)
            .submitter(submitter)
            .status(ApprovalStatus.PENDING)
            .nodes(buildApprovalNodes(obj.getTypeId()))  // 从模板配置审批节点
            .build();
        approvalFlowRepo.save(flow);

        // 通知第一个审批人
        notifyApprover(flow.getCurrentApprover());
    }

    // 审批通过
    public void approve(Long flowId, String approver, String comment) {
        ApprovalFlow flow = approvalFlowRepo.findById(flowId);
        flow.advanceToNext(approver, comment);

        if (flow.isCompleted()) {
            MdmObject obj = mdmRepo.findById(flow.getObjectId());
            obj.setStatus(APPROVED);
            eventPublisher.publishUpdated(obj);  // 审批通过后下发
        }
    }
}
```

---

## 五、数据获取

```java
// REST API
@GetMapping("/api/mdm/{typeCode}/{objectCode}")
public MdmObjectVO getObject(@PathVariable String typeCode,
                              @PathVariable String objectCode) {
    // 先查 Redis 缓存
    String cacheKey = "mdm:" + typeCode + ":" + objectCode;
    MdmObjectVO cached = redisTemplate.opsForValue().get(cacheKey);
    if (cached != null) return cached;

    MdmObject obj = mdmRepo.findByTypeAndCode(typeCode, objectCode);
    MdmObjectVO vo = MdmObjectVO.from(obj);
    redisTemplate.opsForValue().set(cacheKey, vo, Duration.ofHours(1));
    return vo;
}

// 订阅推送（WebSocket / SSE 实时推送变更）
@Scheduled(fixedRate = 5000)
public void pushChanges() {
    List<MdmChangedEvent> pending = eventQueue.drainPending();
    pending.forEach(event -> websocketService.broadcast("/topic/mdm", event));
}
```

---

## 六、数据版本与审计

```sql
-- 变更历史表
CREATE TABLE mdm_change_log (
    id          BIGINT PRIMARY KEY AUTO_INCREMENT,
    object_id   BIGINT NOT NULL,
    operator    VARCHAR(64),
    change_type VARCHAR(16),   -- CREATE / UPDATE / DELETE
    before_data JSON,          -- 变更前快照
    after_data  JSON,          -- 变更后快照
    changed_at  DATETIME NOT NULL
);
```

```java
@Aspect
@Component
public class MdmAuditAspect {
    @Around("@annotation(MdmAudit)")
    public Object audit(ProceedingJoinPoint pjp) throws Throwable {
        Long objectId = extractObjectId(pjp.getArgs());
        MdmObject before = mdmRepo.findById(objectId);

        Object result = pjp.proceed();

        MdmObject after = mdmRepo.findById(objectId);
        changeLogRepo.save(MdmChangeLog.builder()
            .objectId(objectId)
            .operator(SecurityUtils.getCurrentUsername())
            .changeType(detectChangeType(before, after))
            .beforeData(before.getExtData())
            .afterData(after.getExtData())
            .changedAt(LocalDateTime.now())
            .build());
        return result;
    }
}
```

---

## 七、数据质量控制

| 检查类型 | 说明 | 触发时机 |
|---------|------|---------|
| **完整性** | 必填字段不为空 | 提交/导入时 |
| **唯一性** | 业务编码不重复 | 提交/导入时 |
| **格式合规** | 手机号、邮箱等正则校验 | 提交/导入时 |
| **逻辑一致性** | 如省市区三级联动合法性 | 提交时 |
| **重复检测** | 基于相似度识别疑似重复记录 | 定时批量扫描 |

```java
// 定时数据质量扫描
@Scheduled(cron = "0 0 3 * * ?")
public void runQualityCheck() {
    List<MdmObject> allObjects = mdmRepo.findAll();
    List<QualityIssue> issues = new ArrayList<>();

    for (MdmObject obj : allObjects) {
        // 完整性检查
        issues.addAll(completenessChecker.check(obj));
        // 重复检测（编辑距离相似度）
        issues.addAll(duplicateDetector.detect(obj));
    }

    // 生成质量报告，发送给数据管理员
    qualityReportService.generate(issues);
}
```

---

## 八、缓存一致性

主数据变更频率低，但读取量极大，适合强缓存策略。

```java
@Service
public class MdmCacheService {
    private static final String KEY_PREFIX = "mdm:";
    private static final Duration TTL = Duration.ofHours(6);

    // 写穿缓存：更新 DB 同时刷新 Cache
    @Transactional
    public void updateWithCache(Long id, MdmUpdateRequest req) {
        MdmObject obj = mdmRepo.findById(id);
        obj.update(req);
        mdmRepo.save(obj);

        // 主动刷新缓存
        String key = KEY_PREFIX + obj.getTypeCode() + ":" + obj.getObjectCode();
        redisTemplate.delete(key);  // 删除旧缓存，下次查询时重建
    }

    // 批量预热
    @PostConstruct
    public void warmUp() {
        mdmRepo.findHighFrequencyObjects().forEach(obj -> {
            String key = KEY_PREFIX + obj.getTypeCode() + ":" + obj.getObjectCode();
            redisTemplate.opsForValue().set(key, MdmObjectVO.from(obj), TTL);
        });
        log.info("MDM cache warm up completed");
    }
}
```
