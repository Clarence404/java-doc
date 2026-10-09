---
description: BPMN 引擎与持久化执行、Flowable、Camunda 现状、Apache KIE、Temporal、选型
---

# 工作流引擎

> **本篇目标**：分清两类「工作流」：面向人工审批的 BPMN 流程引擎，与面向服务编排的持久化执行引擎；了解 Flowable、Camunda、Activiti、Apache KIE（jBPM）、Temporal 在 2026 年的现状与许可证，能按场景选型。
>
> **前置阅读**：[分布式事务](./4_transaction)（Saga 一节）

---

## 一、两类工作流

| | BPMN 流程引擎 | 持久化执行引擎（Durable Execution） |
|---|---|---|
| 解决的问题 | 人参与的业务流程：请假、报销、采购审批、工单流转 | 跨多个服务的长流程编排：下单 → 支付 → 发货，失败补偿、定时等待 |
| 流程定义 | BPMN 2.0 图形化建模（XML），业务人员可读 | 用代码写流程（Java / Go 等），引擎记录每一步结果 |
| 核心能力 | 用户任务、候选人与委派、会签、表单、流程版本、历史审计 | 断点续跑、自动重试、超时、定时器、Saga 补偿 |
| 代表 | Flowable、Camunda、Activiti、jBPM | Temporal、Seata Saga 状态机、Camunda 8（Zeebe） |

分布式系统里常说的「流程编排」多指第二类，它是 [分布式事务](./4_transaction) 中 Saga 编排器的一种实现方式。OA 审批、工单这类需求用第一类。

---

## 二、BPMN 流程引擎

### 1、Flowable

由 Activiti 的核心开发者在 2016 年分叉而来，Apache 2.0 许可，社区与商业版并行，是目前 Java 开源 BPMN 引擎里活跃度最高的。

- 支持 BPMN 2.0、CMMN（案例管理）、DMN（决策表），可嵌入 Spring Boot 应用
- **Flowable 8** 基于 Spring Framework 7 / Spring Boot 4，默认使用 Jackson 3，不再支持 Spring Boot 3；Spring Boot 3 项目继续用 7.x
- 适合大多数需要内嵌审批流的业务系统

### 2、Camunda

Camunda 有两条完全不同的产品线，选型时必须分清：

- **Camunda 7**：嵌入式 Java 引擎，Activiti 分叉而来。**社区版已于 2025 年 10 月随 7.24 停止维护**，此后不再发布社区版本与安全补丁，仓库归档；企业版支持延长到 2030 年 4 月
- **Camunda 8**：基于 Zeebe 的分布式流程引擎，引擎以独立集群运行，应用通过 gRPC / REST 客户端交互。自 8.6（2024 年 10 月）起，源码采用 Camunda License 1.0，Self-Managed 发行版**在生产环境使用需要购买企业版许可**，开发测试免费

因此 Camunda 已不是可以免费用于生产的开源方案：新项目选 Camunda 8 要先确认采购预算；现有 Camunda 7 社区版项目需要规划迁移（迁到 Camunda 8 企业版、Flowable，或社区维护的分叉）。

### 3、Activiti

最早流行的 Java BPMN 引擎，由 Alfresco 主导。Activiti 7 之后主要面向 Activiti Cloud（云原生部署），社区活跃度明显下降。存量 Activiti 5 / 6 项目可以较平滑地迁到 Flowable（两者 API 同源）。

### 4、Apache KIE（jBPM / Drools）

Red Hat 在 2023 年把 Drools、jBPM、Kogito、OptaPlanner 捐献给 Apache 软件基金会，成立 Apache KIE（孵化中）。2025 年发布 10.1（Spring Boot 3.4 / Quarkus 3.15）与 10.2（新 BPMN 编辑器）。旧的 `kiegroup/jbpm` 仓库不再是主线。

适合的场景是**流程与规则引擎紧密结合**：流程里有大量由 Drools 规则、DMN 决策表驱动的判断（如保险核保、信贷审批）。

---

## 三、持久化执行引擎：Temporal

Temporal（源自 Uber 的 Cadence）把流程写成普通代码，引擎持久化每一次活动调用的结果。进程崩溃后，引擎通过重放事件历史恢复到断点继续执行，重试、超时、定时等待（哪怕是几天）都由引擎负责。MIT 许可，可自托管或使用 Temporal Cloud，Java SDK 为 `io.temporal:temporal-sdk`。

```java
@WorkflowInterface
public interface OrderWorkflow {
    @WorkflowMethod
    void placeOrder(OrderDTO order);
}

public class OrderWorkflowImpl implements OrderWorkflow {

    private final OrderActivities activities = Workflow.newActivityStub(OrderActivities.class,
            ActivityOptions.newBuilder()
                    .setStartToCloseTimeout(Duration.ofSeconds(30))
                    .setRetryOptions(RetryOptions.newBuilder().setMaximumAttempts(5).build())
                    .build());

    @Override
    public void placeOrder(OrderDTO order) {
        Saga saga = new Saga(new Saga.Options.Builder().build());
        try {
            activities.reserveStock(order);
            saga.addCompensation(activities::releaseStock, order);
            activities.charge(order);
            saga.addCompensation(activities::refund, order);
            activities.ship(order);
        } catch (ActivityFailure e) {
            saga.compensate();          // 逆序执行已登记的补偿
            throw e;
        }
    }
}
```

要点：Workflow 代码必须是确定性的（不能直接读系统时间、随机数、发网络请求，这些都要放进 Activity 或用 `Workflow` 提供的 API）；Activity 要幂等，因为会被重试。

同类方案还有 Seata Saga 状态机（JSON 定义流程，见 [分布式事务](./4_transaction)），以及 Camunda 8（BPMN 建模，同样可以编排服务调用）。

---

## 四、对比与选型

| 引擎 | 许可证 | 部署形态 | 建模 | 现状 | 适合 |
|------|--------|----------|------|------|------|
| Flowable | Apache 2.0 | 嵌入式 | BPMN / CMMN / DMN | 活跃，8.x 支持 Boot 4 | 业务系统内嵌审批流 |
| Camunda 7 | Apache 2.0（社区版） | 嵌入式 | BPMN / DMN | 社区版已停更，企业版到 2030 | 仅限存量系统 |
| Camunda 8 | Camunda License 1.0，生产需企业版许可 | 独立集群（Zeebe） | BPMN / DMN | 活跃，商业产品 | 有预算、需要高吞吐流程编排与完整运维套件 |
| Activiti | Apache 2.0 | 嵌入式 / 云 | BPMN | 活跃度低 | 存量项目 |
| Apache KIE（jBPM） | Apache 2.0 | 嵌入式 / Quarkus / Spring Boot | BPMN + Drools / DMN | 孵化中，持续发布 | 流程与规则深度结合 |
| Temporal | MIT | 独立服务 + SDK | 代码 | 活跃 | 跨服务长流程、Saga、定时等待 |

选型建议：

| 场景 | 推荐 |
|------|------|
| OA、工单、报销等人工审批，Spring Boot 项目 | Flowable |
| 存量 Activiti 5 / 6 | 迁到 Flowable |
| 存量 Camunda 7 社区版 | 评估 Camunda 8 企业版或迁到 Flowable，不要继续在停更版本上新增功能 |
| 审批中有大量规则判断 | Apache KIE（jBPM + Drools） |
| 跨服务的订单、履约、补偿编排 | Temporal，或 Seata Saga 状态机 |

---

## 小结

- 工作流分两类：人工审批的 BPMN 引擎，与服务编排的持久化执行引擎
- Flowable 是当前首选的开源内嵌 BPMN 引擎，8.x 对应 Spring Boot 4
- Camunda 7 社区版 2025 年 10 月停更；Camunda 8 自 8.6 起生产使用需要企业版许可
- jBPM 已归入 Apache KIE（孵化中），适合流程与规则结合
- Temporal 用代码定义流程，引擎负责断点续跑与重试，是 Saga 编排的现代选择

## 参考资料

- Flowable GitHub：[https://github.com/flowable/flowable-engine](https://github.com/flowable/flowable-engine)
- Flowable 8.0.0 发布说明：[https://github.com/flowable/flowable-engine/releases](https://github.com/flowable/flowable-engine/releases)
- Camunda 7 End of Life：[https://camunda.com/platform-7/](https://camunda.com/platform-7/)
- Camunda Licensing: What You Need to Know：[https://camunda.com/blog/2024/10/camunda-licensing-what-you-need-to-know/](https://camunda.com/blog/2024/10/camunda-licensing-what-you-need-to-know/)
- Camunda 8 Licenses：[https://docs.camunda.io/docs/reference/licenses/](https://docs.camunda.io/docs/reference/licenses/)
- Activiti GitHub：[https://github.com/Activiti/Activiti](https://github.com/Activiti/Activiti)
- Apache KIE：[https://kie.apache.org/](https://kie.apache.org/)
- Apache KIE 10.1.0 发布：[https://kie.apache.org/blog/kie_10_1_0_release/](https://kie.apache.org/blog/kie_10_1_0_release/)
- Temporal 文档：[https://docs.temporal.io/](https://docs.temporal.io/)
- Temporal Java SDK：[https://github.com/temporalio/sdk-java](https://github.com/temporalio/sdk-java)

> 下一篇：[分布式 ID 生成](./8_id_generator) —— UUID（含 v7）、数据库自增、雪花算法、号段模式、Leaf 与 UidGenerator 的原理与坑。
