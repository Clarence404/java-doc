---
description: binlog 前置配置、binlog-connector、Canal、Debezium 3.x、Flink CDC 选型
---

# CDC 工具

> **本篇目标**：知道 CDC 对 MySQL 的前置要求（MySQL 8.4 下的账号与 binlog 配置），能用 mysql-binlog-connector-java、Canal、Debezium 写出可运行的最小接入，读懂 Debezium 的事件结构，并按场景在四类工具之间做选型。
>
> **前置阅读**：[MySQL 主从与高可用](../1_mysql/9_topic_replication)（binlog 格式与 GTID）

CDC（Change Data Capture，变更数据捕获）通过订阅数据库的**变更日志**（MySQL binlog、PostgreSQL WAL 逻辑解码）实时获取 INSERT / UPDATE / DELETE，用于数据同步、缓存刷新、搜索索引更新、Outbox 消息投递与实时数仓。相比定时轮询，它不给业务表加查询压力，也能拿到删除与变更前的值。

---

## 一、工具对比

![主流 CDC 工具对比架构](../../assets/database/cdc-tools-arch.svg)

| 特性 | mysql-binlog-connector-java | Canal | Debezium | Flink CDC |
|------|------|------|------|------|
| 形态 | 嵌入应用的 Java 库 | 独立中间件（Server + Client / Adapter） | Kafka Connect 连接器，也可用 Debezium Server 或嵌入式引擎 | Flink Source 与 YAML 管道 |
| 数据库支持 | MySQL、MariaDB | MySQL、MariaDB | MySQL、MariaDB、PostgreSQL、MongoDB、Oracle、SQL Server、Db2、Informix、Spanner 等 | MySQL、PostgreSQL、Oracle、SQL Server、MongoDB、OceanBase、TiDB 等 |
| 全量快照 | 不支持，只读增量 | 不支持，需另行全量导入 | 支持（初始快照、增量快照） | 支持（无锁增量快照） |
| DDL / 表结构 | 只给原始 SQL 文本，不解析、不维护表结构 | 解析 DDL，维护表结构 | 解析 DDL，记录 schema 历史 | 支持 Schema 演进 |
| 事务边界 | 只给原始 BEGIN / XID 事件，需自行组装 | 输出 TRANSACTIONBEGIN / END | 可开启事务元数据 topic | 由 Checkpoint 保证一致性 |
| 多语言消费 | 否，仅限所在 Java 进程 | 是（TCP 客户端或投递到 MQ） | 是（Kafka 消费者） | 通过 Sink 写到任意下游 |
| 高可用 | 自行实现 | ZooKeeper 协调主备 | Kafka Connect 集群 | Flink 集群 + Checkpoint |
| 部署复杂度 | 低 | 中 | 中高（依赖 Kafka） | 高（依赖 Flink） |

---

## 二、MySQL 前置配置

### 1、binlog 参数

MySQL 8.0 起 binlog 默认开启、默认 ROW 格式，8.4 LTS 下需要确认或调整的是：

```ini
[mysqld]
server_id = 1
# 8.0 起默认 ON；默认 ROW，且 binlog_format 变量自 8.0.34 起已废弃，不要改成其他格式
log_bin = mysql-bin
# 默认 FULL：行事件包含所有列的前后镜像
binlog_row_image = FULL
# 默认 MINIMAL；设为 FULL 后 TABLE_MAP 事件携带列名、主键等元数据（8.0.1+）
binlog_row_metadata = FULL
# 开启 GTID，便于断点续传与主从切换后继续订阅
gtid_mode = ON
enforce_gtid_consistency = ON
# binlog 保留 7 天，必须长于 CDC 可能的最长停机时间
binlog_expire_logs_seconds = 604800
```

### 2、订阅账号

MySQL 8.0 起 `GRANT ... IDENTIFIED BY` 已被移除，必须先建用户再授权；授权立即生效，不需要 `FLUSH PRIVILEGES`：

```sql
CREATE USER 'cdc'@'%' IDENTIFIED BY 'Str0ng#Passw0rd';
GRANT SELECT, RELOAD, SHOW DATABASES, REPLICATION SLAVE, REPLICATION CLIENT ON *.* TO 'cdc'@'%';
```

`REPLICATION SLAVE` 是权限名本身，8.4 中仍然叫这个名字，与复制语句改用 SOURCE / REPLICA 术语无关。`RELOAD`、`SHOW DATABASES` 是 Debezium 做快照时需要的，只用 Canal 或 binlog-connector 时 `SELECT, REPLICATION SLAVE, REPLICATION CLIENT` 就够了。

8.4 默认认证插件是 `caching_sha2_password`，`mysql_native_password` 默认禁用；客户端库版本过旧时会认证失败，优先升级客户端或启用 TLS，而不是把账号退回旧插件。

### 3、server_id 唯一

每个 CDC 客户端都以「副本」身份连接，`server_id` 必须在整个复制拓扑里唯一。两个客户端使用同一个 `server_id` 时，后连上的会把先连上的踢掉，表现为两边交替断线重连。mysql-binlog-connector-java 默认 `serverId` 是 65535，部署多个实例时一定要显式设置。

---

## 三、mysql-binlog-connector-java

轻量级 Java 库，在应用进程内模拟一个副本连接 MySQL，拿到的是**原始 binlog 事件**：不做全量快照、不解析 DDL、不维护表结构，位点持久化与事务组装都由使用方负责。适合单个服务内的轻量订阅，例如本地缓存失效。维护中的版本是 osheroff 的分支，Maven 坐标为 `com.zendesk`：

```xml
<dependency>
  <groupId>com.zendesk</groupId>
  <artifactId>mysql-binlog-connector-java</artifactId>
  <version>0.31.0</version>
</dependency>
```

最小可用示例：缓存 TABLE_MAP 拿到表名与列名（依赖 `binlog_row_metadata=FULL`），处理行事件，并在事务提交（XID）后记录 GTID 位点。

```java
BinaryLogClient client = new BinaryLogClient("127.0.0.1", 3306, "cdc", "Str0ng#Passw0rd");
client.setServerId(10001);                    // 拓扑内唯一
client.setGtidSet(offsetStore.loadGtidSet()); // 从上次提交的位点续传；首次传空字符串，表示从最早可用的 binlog 开始
client.setKeepAliveInterval(30_000);

EventDeserializer deserializer = new EventDeserializer();
deserializer.setCompatibilityMode(
        EventDeserializer.CompatibilityMode.DATE_AND_TIME_AS_LONG,
        EventDeserializer.CompatibilityMode.CHAR_AND_BINARY_AS_BYTE_ARRAY);
client.setEventDeserializer(deserializer);

Map<Long, TableMapEventData> tableMaps = new HashMap<>();

client.registerEventListener(event -> {
    EventData data = event.getData();
    if (data instanceof TableMapEventData tm) {
        tableMaps.put(tm.getTableId(), tm);
    } else if (data instanceof WriteRowsEventData insert) {
        TableMapEventData tm = tableMaps.get(insert.getTableId());
        List<String> columns = tm.getEventMetadata().getColumnNames();
        insert.getRows().forEach(row -> handler.onInsert(tm.getDatabase(), tm.getTable(), columns, row));
    } else if (data instanceof UpdateRowsEventData update) {
        TableMapEventData tm = tableMaps.get(update.getTableId());
        List<String> columns = tm.getEventMetadata().getColumnNames();
        for (Map.Entry<Serializable[], Serializable[]> row : update.getRows()) {
            handler.onUpdate(tm.getDatabase(), tm.getTable(), columns, row.getKey(), row.getValue());
        }
    } else if (data instanceof DeleteRowsEventData delete) {
        TableMapEventData tm = tableMaps.get(delete.getTableId());
        List<String> columns = tm.getEventMetadata().getColumnNames();
        delete.getRows().forEach(row -> handler.onDelete(tm.getDatabase(), tm.getTable(), columns, row));
    } else if (event.getHeader().getEventType() == EventType.XID) {
        // 事务已提交：此时 client.getGtidSet() 已包含刚完成的事务
        offsetStore.saveGtidSet(client.getGtidSet());
    }
});

client.connect(); // 阻塞当前线程；需要后台运行时用 connect(timeout)
```

要点：

- 监听器在 IO 线程里同步执行，耗时处理应投递到队列，否则会阻塞读取并拖慢心跳
- `DATE_AND_TIME_AS_LONG` 下 DATETIME 被当作 UTC 解析成毫秒数，需要按业务时区换算
- 位点保存与业务处理不是原子的，重启后可能重复投递最后一个事务，下游必须幂等

库的内部机制（协议握手、事件反序列化、GTID 推进、保活重连）见 [mysql-binlog-connector-java 原理](../6_reference/0_binlog_connector_source)。

---

## 四、Canal

阿里巴巴开源的 CDC 中间件，Canal Server 伪装成 MySQL 副本拉取 binlog，解析后通过 TCP 推给客户端，或直接投递到 Kafka / RocketMQ / RabbitMQ。国内存量系统使用广泛，但发布节奏已明显放缓（最新为 1.1.8），对 MySQL 8.4 / 9.x 新特性（例如 binlog 事务压缩）的兼容性需要自行验证，新项目可优先评估 Debezium 或 Flink CDC。

### 1、Server 配置

`conf/example/instance.properties`。`.properties` 文件中 `#` 只有在行首才是注释，写在值后面会成为值的一部分，因此注释要单独成行：

```properties
canal.instance.master.address=127.0.0.1:3306
canal.instance.dbUsername=cdc
canal.instance.dbPassword=Str0ng#Passw0rd
# 只订阅 mydb.orders 表（Perl 正则，多个用逗号分隔）
canal.instance.filter.regex=mydb\\.orders
```

### 2、Java 客户端

```xml
<dependency>
  <groupId>com.alibaba.otter</groupId>
  <artifactId>canal.client</artifactId>
  <version>1.1.8</version>
</dependency>
```

客户端采用「拉取 → 处理 → 确认」模式：空批次要休眠避免空转；处理失败时 `rollback` 让这一批重新投递，而不是让异常打断循环。

```java
public void run() throws InterruptedException {
    CanalConnector connector = CanalConnectors.newSingleConnector(
            new InetSocketAddress("127.0.0.1", 11111), "example", "", "");
    connector.connect();
    connector.subscribe("mydb\\.orders");
    connector.rollback(); // 回到上次 ack 的位置

    while (running) {
        Message message = connector.getWithoutAck(100);
        long batchId = message.getId();
        if (batchId == -1 || message.getEntries().isEmpty()) {
            Thread.sleep(1000);
            continue;
        }
        try {
            for (CanalEntry.Entry entry : message.getEntries()) {
                if (entry.getEntryType() != CanalEntry.EntryType.ROWDATA) {
                    continue;
                }
                CanalEntry.RowChange rowChange = CanalEntry.RowChange.parseFrom(entry.getStoreValue());
                CanalEntry.EventType type = rowChange.getEventType();
                for (CanalEntry.RowData rowData : rowChange.getRowDatasList()) {
                    handler.handle(entry.getHeader().getTableName(), type,
                            rowData.getBeforeColumnsList(), rowData.getAfterColumnsList());
                }
            }
            connector.ack(batchId);
        } catch (Exception e) {
            log.error("canal batch {} failed, rollback", batchId, e);
            connector.rollback(batchId);
        }
    }
    connector.disconnect();
}
```

### 3、Canal Adapter

Canal Adapter 可以不写代码，把变更按 YAML 映射同步到 Elasticsearch、HBase、RDB 等目标。以 ES 为例（`conf/es8/mydb_orders.yml`）：

```yaml
dataSourceKey: defaultDS
destination: example
groupId: g1
esMapping:
  _index: orders
  _id: _id
  sql: "SELECT o.id AS _id, o.user_id, o.amount, o.status FROM orders o"
  etlCondition: "WHERE o.updated_at > {}"
  commitBatch: 3000
```

MySQL 到搜索引擎的同步方案对比见 [搜索数据库](../4_nosql/3_search_db)。

---

## 五、Debezium

Debezium 基于 Kafka Connect，把各种数据库的变更统一成标准事件格式写入 Kafka，是 Kafka 生态下 CDC 的事实标准。3.x 版本要求 Java 17，官方镜像发布在 `quay.io/debezium/*`，Docker Hub 上的 `debezium/*` 镜像已停止更新。不想引入 Kafka 时，可以用 **Debezium Server** 把事件直接投递到 Redis Stream、Pulsar、Kinesis 等，或在应用里使用嵌入式引擎。

### 1、Docker Compose 快速启动

Kafka 4.0 起移除了 ZooKeeper，只能以 KRaft 模式运行。下面是单节点的本地实验环境：

```yaml
services:
  mysql:
    image: mysql:8.4
    environment:
      MYSQL_ROOT_PASSWORD: root
    command: ["--gtid-mode=ON", "--enforce-gtid-consistency=ON", "--binlog-row-metadata=FULL"]
    ports:
      - "3306:3306"

  kafka:
    image: apache/kafka:4.1.0
    environment:
      KAFKA_NODE_ID: 1
      KAFKA_PROCESS_ROLES: broker,controller
      KAFKA_LISTENERS: PLAINTEXT://:9092,CONTROLLER://:9093
      KAFKA_ADVERTISED_LISTENERS: PLAINTEXT://kafka:9092
      KAFKA_CONTROLLER_LISTENER_NAMES: CONTROLLER
      KAFKA_LISTENER_SECURITY_PROTOCOL_MAP: CONTROLLER:PLAINTEXT,PLAINTEXT:PLAINTEXT
      KAFKA_CONTROLLER_QUORUM_VOTERS: 1@kafka:9093
      KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR: 1
      KAFKA_TRANSACTION_STATE_LOG_REPLICATION_FACTOR: 1
      KAFKA_TRANSACTION_STATE_LOG_MIN_ISR: 1

  connect:
    image: quay.io/debezium/connect:3.6.3.Final
    ports:
      - "8083:8083"
    environment:
      BOOTSTRAP_SERVERS: kafka:9092
      GROUP_ID: 1
      CONFIG_STORAGE_TOPIC: connect_configs
      OFFSET_STORAGE_TOPIC: connect_offsets
      STATUS_STORAGE_TOPIC: connect_statuses
    depends_on: [mysql, kafka]
```

单 broker 时必须把 `__consumer_offsets` 与事务日志的副本数设为 1，否则依赖它们的消费组与 Connect 无法正常工作。生产环境至少 3 个 broker，Connect 以分布式模式部署多个 worker。

### 2、注册 MySQL 连接器

```bash
curl -X POST http://localhost:8083/connectors \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "mysql-orders-connector",
    "config": {
      "connector.class": "io.debezium.connector.mysql.MySqlConnector",
      "database.hostname": "mysql",
      "database.port": "3306",
      "database.user": "cdc",
      "database.password": "Str0ng#Passw0rd",
      "database.server.id": "184054",
      "topic.prefix": "mydb",
      "database.include.list": "mydb",
      "table.include.list": "mydb.orders",
      "schema.history.internal.kafka.bootstrap.servers": "kafka:9092",
      "schema.history.internal.kafka.topic": "schema-changes.mydb"
    }
  }'
```

账号按第二节创建；`database.server.id` 同样必须在拓扑内唯一。变更事件写入 topic `<topic.prefix>.<库名>.<表名>`，即 `mydb.mydb.orders`。

### 3、事件结构

默认的 `JsonConverter` 会把每条消息包成 `{"schema": {...}, "payload": {...}}`，`schema` 部分描述字段类型，体积往往比数据本身还大；设置 `value.converter.schemas.enable=false` 或使用 Avro / Protobuf + Schema Registry 可以去掉它。下面是一条 UPDATE 事件的 `payload`：

```json
{
  "before": { "id": 1, "amount": "100.00", "status": "pending" },
  "after":  { "id": 1, "amount": "100.00", "status": "paid" },
  "source": {
    "version": "3.6.3.Final",
    "connector": "mysql",
    "name": "mydb",
    "ts_ms": 1791000000000,
    "snapshot": "false",
    "db": "mydb",
    "table": "orders",
    "server_id": 1,
    "gtid": "3E11FA47-71CA-11E1-9E33-C80AA9429562:23",
    "file": "mysql-bin.000003",
    "pos": 1543,
    "row": 0
  },
  "transaction": null,
  "op": "u",
  "ts_ms": 1791000000123
}
```

| 字段 | 含义 |
|------|------|
| `before` / `after` | 变更前后的行；INSERT 的 `before` 与 DELETE 的 `after` 为 `null` |
| `source` | 来源元数据：库表、binlog 文件与位置、GTID、是否快照、数据库侧时间 |
| `op` | `c` 插入、`u` 更新、`d` 删除、`r` 快照读取、`t` 截断（TRUNCATE） |
| `ts_ms` | Debezium 处理该事件的时间；与 `source.ts_ms` 的差就是采集延迟 |
| `transaction` | 开启 `provide.transaction.metadata` 后包含事务 id 与事务内序号 |

DECIMAL 默认按 `decimal.handling.mode=precise` 编码成 Base64 字节，示例中显示为字符串是设置了 `decimal.handling.mode=string` 的结果。删除事件之后默认还会跟一条 value 为 `null` 的墓碑消息，供 Kafka 日志压缩清理该 key。

---

## 六、Flink CDC

Flink CDC 不需要额外部署 Canal Server 或 Kafka Connect，直接在 Flink 作业内以无锁增量快照完成「全量 + binlog 增量」读取，既可接 Flink SQL 做实时计算，也可用 YAML 管道整库同步到 Doris、StarRocks、Paimon、Kafka。源配置、管道定义、Schema 演进与精确一次详见 [Flink CDC](/flink/6_cdc)。

---

## 七、选型建议

| 场景 | 推荐工具 |
|------|---------|
| 单个服务内监听少量表、逻辑简单 | mysql-binlog-connector-java |
| 已有 Canal 体系、只同步 MySQL | Canal（新项目注意其维护节奏） |
| 已有 Kafka，需要多种数据库、多下游订阅、Outbox 投递 | Debezium |
| 不想引入 Kafka，但需要 Debezium 的标准事件 | Debezium Server |
| 需要在变更流上做实时计算、整库同步到数仓 | Flink CDC |
| 缓存与数据库一致性（删除缓存的补偿） | Canal 或 Debezium，见 [缓存一致性](/cache/10_cache_consistency) |
| 实时入湖（Paimon / Iceberg / Hudi） | Flink CDC |

---

## 小结

- CDC 前置条件：ROW 格式 binlog（8.0 起默认）、`binlog_row_image=FULL`、`binlog_row_metadata=FULL`、GTID、足够长的 binlog 保留期
- MySQL 8.0 起用 `CREATE USER` + `GRANT` 建订阅账号，权限是 `SELECT, REPLICATION SLAVE, REPLICATION CLIENT`（Debezium 快照再加 `RELOAD, SHOW DATABASES`）；每个客户端的 `server_id` 必须唯一
- mysql-binlog-connector-java 只给原始事件，表结构、事务组装、位点持久化都要自己做，下游必须幂等
- Canal 客户端要处理空批次与失败 `rollback`；`.properties` 的注释必须单独成行；新项目注意其维护放缓
- Debezium 3.x 跑在 Kafka 4（KRaft）上，镜像在 quay.io；事件包含 `before` / `after` / `source` / `op` / `ts_ms` / `transaction`，`op` 有 `c` / `u` / `d` / `r` / `t`
- 需要实时计算或整库入湖时用 Flink CDC

## 参考资料

- mysql-binlog-connector-java：[https://github.com/osheroff/mysql-binlog-connector-java](https://github.com/osheroff/mysql-binlog-connector-java)
- Canal：[https://github.com/alibaba/canal](https://github.com/alibaba/canal)
- Debezium MySQL 连接器：[https://debezium.io/documentation/reference/stable/connectors/mysql.html](https://debezium.io/documentation/reference/stable/connectors/mysql.html)
- Debezium Server：[https://debezium.io/documentation/reference/stable/operations/debezium-server.html](https://debezium.io/documentation/reference/stable/operations/debezium-server.html)
- Kafka KRaft 运维：[https://kafka.apache.org/documentation/#kraft](https://kafka.apache.org/documentation/#kraft)
- MySQL binlog_row_metadata：[https://dev.mysql.com/doc/refman/8.4/en/replication-options-binary-log.html](https://dev.mysql.com/doc/refman/8.4/en/replication-options-binary-log.html)
- Flink CDC：[https://nightlies.apache.org/flink/flink-cdc-docs-stable/](https://nightlies.apache.org/flink/flink-cdc-docs-stable/)

> 下一篇：[数据备份与恢复](./1_backup_recovery) —— 按 RPO / RTO 设计备份策略，MySQL 与 PostgreSQL 的全量、增量与时间点恢复。
