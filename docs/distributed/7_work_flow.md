# 工作流（Workflow）

## Activiti

Flowable 的前身，由 Alfresco 团队发起。
社区成熟、API 简单，适合快速构建审批流程。

🔗 **GitHub:** [https://github.com/Activiti/Activiti](https://github.com/Activiti/Activiti)

---

## Flowable

轻量级的 BPMN 2.0 工作流引擎，适合与 Spring Boot 深度集成。
支持任务、表单、网关、定时器、事件等完整流程控制。

🔗 **GitHub:** [https://github.com/flowable/flowable-engine](https://github.com/flowable/flowable-engine)

---

## Camunda

企业级 BPM 平台，提供 Web 管理控制台、流程监控、任务分配等功能。
支持 Java、REST、Kafka 等多种接入方式。

🔗 **GitHub:** [https://github.com/camunda/camunda](https://github.com/camunda/camunda)

---

## jBPM

RedHat 主导的老牌工作流引擎，功能齐全但较重，适合大型系统。

🔗 **GitHub:** [https://github.com/kiegroup/jbpm](https://github.com/kiegroup/jbpm)

---

## 常见比较

| 特性             | Flowable | Activiti | Camunda | jBPM |
|----------------|----------|----------|---------|------|
| 轻量性            | ✅✅✅      | ✅✅       | ❌       | ❌    |
| 企业支持           | ⚪        | ⚪        | ✅✅✅     | ✅✅   |
| 可视化建模          | ✅        | ✅        | ✅✅✅     | ✅    |
| Spring Boot 集成 | ✅✅✅      | ✅✅       | ✅✅      | ⚪    |
| 社区活跃度          | ✅✅       | ⚪        | ✅✅✅     | ⚪    |

---

## 典型使用场景

* OA 办公系统（请假、报销、采购审批）
* ERP 流程审批
* IoT 平台事件流转（设备告警处理流程）
* SaaS 系统中的多租户审批引擎

---

## 选型建议

| 场景                                | 推荐引擎                     | 原因                         |
|-----------------------------------|--------------------------|----------------------------|
| **中小型项目 / 快速集成 Spring Boot**      | **Flowable**             | 轻量、开箱即用、社区活跃，文档完善          |
| **已有 Activiti 系统或遗留流程迁移**         | **Activiti / Flowable**  | 二者兼容性高，可平滑迁移               |
| **企业级项目 / 多系统集成需求（Kafka、REST 等）** | **Camunda**              | 提供完善的监控、可视化和管理控制台          |
| **国企或传统大型系统**                     | **jBPM**                 | 功能齐全，支持规则引擎（Drools）和复杂业务逻辑 |
| **云原生微服务架构**                      | **Flowable / Camunda 8** | 支持容器化与分布式流程执行（基于 Zeebe）    |

---