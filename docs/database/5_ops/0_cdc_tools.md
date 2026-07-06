# CDC 工具

我们把 **MBCJ、Canal、Debezium 和 Flink CDC** 放在同一张表里对比，帮你理解它们的定位、架构和使用场景。

---

## 一、定位和特点

| 特性    | MBCJ                 | Canal                | Debezium                   | Flink CDC                  |
|-------|----------------------|----------------------|----------------------------|----------------------------|
| 类型    | Java 库               | 分布式 Binlog 中间件       | 分布式变更数据捕获（CDC）平台           | 流处理框架插件（Flink CDC）         |
| 目标    | 嵌入 Java 应用，解析 Binlog | 模拟 MySQL slave，跨语言同步 | 基于 Kafka Connect，捕获数据库变更   | 将数据库变更流实时处理和分析             |
| 多语言支持 | ❌（Java）              | ✅（客户端多语言）            | ✅（Kafka Connect 支持多语言消费者）  | ✅（Flink 支持多语言 Sink/Source） |
| 数据库支持 | MySQL                | MySQL、MariaDB        | MySQL、PostgreSQL、MongoDB 等 | MySQL、PostgreSQL、Oracle 等  |

---

## 二、架构对比

### 1、MBCJ

```
MySQL Binlog
    │
BinaryLogClient
    │
EventListener -> 下游应用（JSON/MQ）
```

* 轻量级，直接嵌入应用
* 自行处理事务、表映射、发布

### 2、Canal

```
MySQL (Master)
    │
Canal Server (模拟 Slave)
    │
Canal Connector
    │
客户端 -> MQ / ES / DB
```

* 独立中间件，支持多语言客户端
* 内置批处理、事务分组、容错

### 3、Debezium

```
MySQL/PostgreSQL/Mongo
    │
Debezium Connector (Kafka Connect)
    │
Kafka Topic -> 消费者
```

* 基于 Kafka Connect
* 提供标准化 CDC 流
* 支持事务完整性、重放、偏移管理

### 4、Flink CDC

```
MySQL/PostgreSQL/Oracle
    │
Flink CDC Source
    │
Flink DataStream / Table API
    │
下游 Sink (Kafka/ES/DB)
```

* 直接与 Flink 流处理集成
* 支持事件时间、窗口、状态管理
* 可做复杂实时计算

---

## 三、功能对比

| 功能        | MBCJ | Canal | Debezium | Flink CDC        |
|-----------|------|-------|----------|------------------|
| 监听 Binlog | ✅    | ✅     | ✅        | ✅                |
| DML 解析    | ✅    | ✅     | ✅        | ✅                |
| DDL 解析    | ✅    | ✅     | ✅        | ✅                |
| 事务边界      | ✅    | ✅     | ✅        | ✅                |
| 异构数据库支持   | ❌    | ❌     | ✅        | ✅                |
| 多语言消费     | ❌    | ✅     | ✅        | ✅（通过 Flink Sink） |
| 高可用/集群    | ❌    | ✅     | ✅        | ✅（Flink 集群）      |
| 消息队列集成    | 手动   | 内置    | Kafka 原生 | 自定义 Sink         |
| 实时流计算     | ❌    | ❌     | ❌        | ✅                |

---

## 四、适用场景

* **MBCJ**：微服务内部快速监听 MySQL 变更，直接嵌入 Java 应用。
* **Canal**：企业级多系统同步，跨语言消费 Binlog，适合中间件方案。
* **Debezium**：标准化 CDC 流，强一致性，适合 Kafka 生态。
* **Flink CDC**：实时流处理、复杂事件处理、实时计算场景。

---

💡 **总结**：

* **MBCJ**：轻量级，嵌入式，Java 专用。
* **Canal**：独立中间件，多语言，事务批处理，企业同步。
* **Debezium**：Kafka Connect 生态，异构数据库，标准化 CDC 流。
* **Flink CDC**：流处理框架插件，支持实时计算和复杂业务逻辑。

---
