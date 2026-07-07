# CDC 工具

CDC（Change Data Capture，变更数据捕获）通过监听数据库的**变更日志**（MySQL Binlog、PG WAL）实时捕获 INSERT / UPDATE / DELETE 事件，用于数据同步、缓存刷新、审计、实时计算等场景。

常见工具：**mysql-binlog-connector-java**（嵌入式）、**Canal**（独立中间件）、**Debezium**（Kafka 生态）、**Flink CDC**（流计算）。

---

## 一、工具对比

| 特性 | mysql-binlog-connector-java | Canal | Debezium | Flink CDC |
|------|:---:|:---:|:---:|:---:|
| 类型 | 嵌入式 Java 库 | 独立中间件 | Kafka Connect 插件 | Flink Source 插件 |
| 数据库支持 | MySQL | MySQL、MariaDB | MySQL、PG、MongoDB 等 | MySQL、PG、Oracle 等 |
| 多语言消费 | ❌ | ✅ | ✅（Kafka 消费者） | ✅（Flink Sink） |
| 高可用 / 集群 | ❌ | ✅ | ✅ | ✅（Flink 集群）|
| 消息队列集成 | 手动 | 内置（RocketMQ / Kafka）| Kafka 原生 | 自定义 Sink |
| DDL 解析 | ✅ | ✅ | ✅ | ✅ |
| 事务边界 | ✅ | ✅ | ✅ | ✅ |
| 实时流计算 | ❌ | ❌ | ❌ | ✅ |
| 部署复杂度 | 低（引包即用） | 中（独立进程） | 中高（依赖 Kafka）| 高（Flink 集群）|

---

## 二、架构

```
mysql-binlog-connector-java
  MySQL Binlog → BinaryLogClient → EventListener → 应用内处理

Canal
  MySQL Master → Canal Server（模拟 Slave）→ Canal Adapter → MQ / ES / DB

Debezium
  MySQL/PG/Mongo → Debezium Connector（Kafka Connect）→ Kafka Topic → 消费者

Flink CDC
  MySQL/PG/Oracle → Flink CDC Source → DataStream / Table API → Sink（Kafka/ES/DB）
```

---

## 三、mysql-binlog-connector-java

轻量级 Java 库，直接嵌入应用监听 MySQL Binlog，适合单服务场景。

```xml
<dependency>
  <groupId>com.zendesk</groupId>
  <artifactId>mysql-binlog-connector-java</artifactId>
  <version>0.29.2</version>
</dependency>
```

```java
BinaryLogClient client = new BinaryLogClient("localhost", 3306, "root", "123456");

client.registerEventListener(event -> {
    EventData data = event.getData();

    if (data instanceof UpdateRowsEventData update) {
        for (Map.Entry<Serializable[], Serializable[]> row : update.getRows()) {
            Serializable[] before = row.getKey();
            Serializable[] after  = row.getValue();
            // 处理变更...
        }
    } else if (data instanceof WriteRowsEventData insert) {
        insert.getRows().forEach(row -> { /* 处理新增 */ });
    } else if (data instanceof DeleteRowsEventData delete) {
        delete.getRows().forEach(row -> { /* 处理删除 */ });
    }
});

client.connect();
```

**注意**：需要 MySQL 账号具备 `REPLICATION SLAVE` 权限：

```sql
GRANT REPLICATION SLAVE, REPLICATION CLIENT ON *.* TO 'cdc_user'@'%';
```

---

## 四、Canal

阿里巴巴开源，模拟 MySQL Slave 接收 Binlog，是国内企业使用最广的 CDC 中间件。

### 前置：MySQL 开启 Binlog

```ini
[mysqld]
log-bin = mysql-bin
binlog-format = ROW
server-id = 1
```

```sql
GRANT SELECT, REPLICATION SLAVE, REPLICATION CLIENT ON *.* TO 'canal'@'%' IDENTIFIED BY 'canal';
FLUSH PRIVILEGES;
```

### Canal Server 配置

`conf/example/instance.properties`：

```properties
canal.instance.master.address=127.0.0.1:3306
canal.instance.dbUsername=canal
canal.instance.dbPassword=canal
canal.instance.filter.regex=mydb\\.orders   # 只监听 mydb.orders 表
```

### Java 客户端

```xml
<dependency>
  <groupId>com.alibaba.otter</groupId>
  <artifactId>canal.client</artifactId>
  <version>1.1.7</version>
</dependency>
```

```java
CanalConnector connector = CanalConnectors.newSingleConnector(
    new InetSocketAddress("127.0.0.1", 11111), "example", "", "");

connector.connect();
connector.subscribe("mydb\\.orders");
connector.rollback();

while (true) {
    Message message = connector.getWithoutAck(100);
    long batchId = message.getId();

    for (CanalEntry.Entry entry : message.getEntries()) {
        if (entry.getEntryType() != CanalEntry.EntryType.ROWDATA) continue;

        CanalEntry.RowChange rowChange = CanalEntry.RowChange.parseFrom(
            entry.getStoreValue());

        for (CanalEntry.RowData rowData : rowChange.getRowDatasList()) {
            if (rowChange.getEventType() == CanalEntry.EventType.UPDATE) {
                rowData.getAfterColumnsList().forEach(col ->
                    System.out.println(col.getName() + " = " + col.getValue()));
            }
        }
    }

    connector.ack(batchId);
}
```

### Canal Adapter（零代码同步）

Canal 提供 Adapter 组件，无需写代码即可将变更同步到 ES / HBase / RDB，通过 YAML 配置映射关系：

```yaml
# conf/es7/mydb_orders.yml
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

---

## 五、Debezium

基于 Kafka Connect，标准化 CDC 流，天然融入 Kafka 生态，适合异构数据库同步和严格事件顺序场景。

### Docker Compose 快速启动

```yaml
services:
  zookeeper:
    image: confluentinc/cp-zookeeper:7.6.0
    environment:
      ZOOKEEPER_CLIENT_PORT: 2181

  kafka:
    image: confluentinc/cp-kafka:7.6.0
    environment:
      KAFKA_ZOOKEEPER_CONNECT: zookeeper:2181
      KAFKA_ADVERTISED_LISTENERS: PLAINTEXT://kafka:9092
    depends_on: [zookeeper]

  kafka-connect:
    image: debezium/connect:2.7
    ports:
      - "8083:8083"
    environment:
      BOOTSTRAP_SERVERS: kafka:9092
      GROUP_ID: 1
      CONFIG_STORAGE_TOPIC: connect-configs
      OFFSET_STORAGE_TOPIC: connect-offsets
      STATUS_STORAGE_TOPIC: connect-status
    depends_on: [kafka]
```

### 注册 MySQL Connector

```bash
curl -X POST http://localhost:8083/connectors \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "mysql-orders-connector",
    "config": {
      "connector.class": "io.debezium.connector.mysql.MySqlConnector",
      "database.hostname": "mysql",
      "database.port": "3306",
      "database.user": "debezium",
      "database.password": "dbz",
      "database.server.id": "184054",
      "topic.prefix": "mydb",
      "database.include.list": "mydb",
      "table.include.list": "mydb.orders",
      "schema.history.internal.kafka.bootstrap.servers": "kafka:9092",
      "schema.history.internal.kafka.topic": "schema-changes.mydb"
    }
  }'
```

变更事件写入 Kafka Topic `mydb.mydb.orders`，消息格式：

```json
{
  "before": { "id": 1, "amount": 100.00, "status": "pending" },
  "after":  { "id": 1, "amount": 100.00, "status": "paid" },
  "op": "u",
  "ts_ms": 1720000000000
}
```

> `op` 字段：`c`=insert，`u`=update，`d`=delete，`r`=snapshot read

---

## 六、Flink CDC

不需要额外部署 Canal Server 或 Kafka Connect，直接在 Flink 作业内读取数据库变更并进行流式计算。

```xml
<dependency>
  <groupId>com.ververica</groupId>
  <artifactId>flink-connector-mysql-cdc</artifactId>
  <version>3.1.0</version>
</dependency>
```

```java
MySqlSource<String> source = MySqlSource.<String>builder()
    .hostname("localhost")
    .port(3306)
    .databaseList("mydb")
    .tableList("mydb.orders")
    .username("root")
    .password("123456")
    .deserializer(new JsonDebeziumDeserializationSchema())
    .build();

StreamExecutionEnvironment env = StreamExecutionEnvironment.getExecutionEnvironment();
env.addSource(source)
   .filter(row -> row.contains("\"op\":\"u\""))  // 只处理 UPDATE
   .print();
env.execute("orders-cdc");
```

也可用 Flink SQL（更简洁）：

```sql
CREATE TABLE orders_cdc (
  id         BIGINT,
  user_id    BIGINT,
  amount     DECIMAL(10, 2),
  status     STRING,
  PRIMARY KEY (id) NOT ENFORCED
) WITH (
  'connector'  = 'mysql-cdc',
  'hostname'   = 'localhost',
  'port'       = '3306',
  'username'   = 'root',
  'password'   = '123456',
  'database-name' = 'mydb',
  'table-name'    = 'orders'
);

-- 实时同步到 Kafka
INSERT INTO orders_kafka SELECT * FROM orders_cdc;
```

---

## 七、选型建议

| 场景 | 推荐工具 |
|------|---------|
| 单服务内监听 MySQL 变更，逻辑简单 | mysql-binlog-connector-java |
| 企业级多系统数据同步，国内环境 | **Canal**（生态成熟，文档丰富）|
| 已有 Kafka 体系，需要异构数据库支持 | **Debezium** |
| 需要在 CDC 事件上做实时计算、窗口聚合 | **Flink CDC** |
| 双写缓存一致性（DB + Redis 同步）| Canal 或 Debezium，消费端刷新缓存 |
| 数据湖实时入湖（Hudi / Iceberg）| Flink CDC |
