---
description: 副本集与读写关注、分片集群与分片键、多文档事务的版本边界与代价、时间序列集合、与 MySQL 选型
---

# MongoDB 集群与事务

> 前置阅读：[MongoDB 基础](./3_mongodb_basics)

MongoDB 靠副本集做高可用、靠分片集群水平扩展。本篇讲副本集与分片集群、多文档事务的版本边界与代价、时间序列集合，以及何时该用 MongoDB 而不是 MySQL，基线为 MongoDB 8。

---

## 一、副本集（Replica Set）

![MongoDB 副本集（Replica Set）](../assets/nosql/mongodb-replica-set.svg)

- **Primary** 处理所有写操作，写入记录到 oplog
- **Secondary** 异步拉取 oplog 回放，可承担读请求（`readPreference=secondaryPreferred`）
- Primary 不可用时，剩余节点投票选出新 Primary；默认 `electionTimeoutMillis` 为 10 秒，官方给出的选举耗时中位数通常不超过 12 秒
- 节点数建议奇数（3 或 5），保证多数派

**写关注与读关注**：

- `writeConcern: { w: "majority" }`：写入被多数节点确认后才返回，故障切换后不会回滚；5.0 起这是默认值
- `readConcern: "majority"`：只读已被多数节点确认的数据；`"snapshot"` 用于事务
- 从 Secondary 读可能读到旧数据，需要「读自己写」的场景用因果一致性会话（causal consistency）或读 Primary

Java 连接字符串示例：

```text
mongodb://host1:27017,host2:27017,host3:27017/mydb?replicaSet=rs0&readPreference=secondaryPreferred
```

---

## 二、分片集群（Sharding）

![MongoDB 分片集群（Sharding）](../assets/nosql/mongodb-sharding.svg)

- **mongos**：无状态查询路由，可部署多个
- **Config Server**：保存元数据与 chunk 分布，副本集部署；8.0 起可让它同时作为数据分片（Config Shard）
- **Shard**：每个分片都是一个副本集

分片键决定数据分布：

| 策略 | 特点 | 适用场景 |
|------|------|---------|
| 哈希分片 | 分布均匀；但范围查询要广播到所有分片（scatter-gather） | 高写入吞吐、按 user_id 等键点查 |
| 范围分片 | 范围查询只访问少数分片；单调递增的键（ObjectId、时间戳）会让新写入都落在最后一个 chunk，形成热点 | 按范围查询、键本身分布均匀 |
| 区域分片（Zone） | 按标签把键范围固定到指定分片 | 数据本地化合规、冷热分层 |

```javascript
// 6.0 起无需先执行 sh.enableSharding()，数据库不存在时会自动创建
sh.shardCollection("mydb.orders", { user_id: "hashed" });

// 复合分片键：user_id 打散 + created_at 支持范围查询
sh.shardCollection("mydb.events", { user_id: 1, created_at: 1 });

// 分片键选错时，5.0 起可在线重新分片
sh.reshardCollection("mydb.events", { device_id: 1, created_at: 1 });
```

不带分片键的查询会广播到所有分片，分片键要覆盖最主要的查询条件。系统级的分片策略取舍见 [数据层扩展](/high-con/5_data_scaling)。

---

## 三、多文档事务

| 版本 | 支持范围 |
|------|----------|
| 4.0 | 副本集上的多文档事务 |
| 4.2 | 分片集群上的分布式事务 |

使用约束：

- 事务默认必须在 60 秒内完成（`transactionLifetimeLimitSeconds`），超时自动中止
- 官方建议单个事务修改的文档不超过 1000 个，大批量修改要拆分
- 事务会持有 WiredTiger 快照、增加缓存压力并可能产生写冲突需要重试，单文档操作本身已经是原子的，**优先通过内嵌建模避免多文档事务**（建模方法见 [MongoDB 基础](./3_mongodb_basics#二、文档建模)）

Java 同步驱动（`org.mongodb:mongodb-driver-sync` 5.x）示例，`withTransaction` 会在遇到临时错误时自动重试：

```java
import com.mongodb.ReadConcern;
import com.mongodb.TransactionOptions;
import com.mongodb.WriteConcern;
import com.mongodb.client.ClientSession;
import com.mongodb.client.MongoClient;
import com.mongodb.client.MongoClients;
import com.mongodb.client.MongoCollection;
import com.mongodb.client.model.Filters;
import com.mongodb.client.model.Updates;
import org.bson.Document;

public class TransferService {

    public static void main(String[] args) {
        String uri = "mongodb://host1:27017,host2:27017,host3:27017/?replicaSet=rs0";
        try (MongoClient client = MongoClients.create(uri);
             ClientSession session = client.startSession()) {

            MongoCollection<Document> accounts =
                    client.getDatabase("bank").getCollection("accounts");

            TransactionOptions options = TransactionOptions.builder()
                    .readConcern(ReadConcern.SNAPSHOT)
                    .writeConcern(WriteConcern.MAJORITY)
                    .build();

            session.withTransaction(() -> {
                accounts.updateOne(session, Filters.eq("_id", "A"), Updates.inc("balance", -100));
                accounts.updateOne(session, Filters.eq("_id", "B"), Updates.inc("balance", 100));
                return null;
            }, options);
        }
    }
}
```

Spring Data MongoDB 中注册 `MongoTransactionManager` 后即可用 `@Transactional`，Spring Boot 的连接配置见 [中间件集成](/spring-boot/6_middleware)，`@Transactional` 本身的机制见 [事务管理](/spring/4_transaction)。

---

## 四、时间序列集合

5.0 起 MongoDB 原生支持时间序列集合，内部按时间与 meta 字段分桶列式压缩，适合已经使用 MongoDB、数据量中等的监控或设备数据：

```javascript
db.createCollection("sensor_readings", {
  timeseries: { timeField: "ts", metaField: "meta", granularity: "minutes" },
  expireAfterSeconds: 2592000          // 30 天后自动过期
});

db.sensor_readings.insertOne({
  ts: new Date(),
  meta: { device_id: "d1001", site: "beijing" },
  temperature: 23.5
});
```

数据量和写入速率更高时，选专用的 [时序数据库概览](./8_tsdb)。

---

## 五、MongoDB 与 MySQL 选型

| 维度 | MongoDB | MySQL |
|------|---------|-------|
| 数据模型 | 文档（嵌套、数组、Schema 灵活） | 行（强 Schema） |
| Schema 变更 | 不需要 DDL，应用兼容新旧结构即可 | 加列多为 INSTANT，大表其他 DDL 需 Online DDL / gh-ost 规划，见 [Schema 变更与数据迁移](/database/4_practice/5_schema_migration) |
| 关联查询 | `$lookup`（能力弱，建议建模时内嵌或应用层组装） | JOIN（成熟） |
| 事务 | 单文档原子；多文档事务 4.0（副本集）/ 4.2（分片），有 60 秒与规模限制 | 完整 ACID |
| 一致性 | 依赖写关注 / 读关注配置，默认 `w: "majority"` | 主库强一致，从库异步复制有延迟 |
| 水平扩展 | 原生分片 | 需要中间件或分布式数据库，见 [分库分表与中间件](/database/4_practice/4_sharding) |
| 全文搜索 | 基础 `text` 索引；`$search` 需 Atlas 或 8.2 预览 | 弱，建议用 ES |
| 适合场景 | 内容、画像、商品 SKU、配置元数据、IoT | 交易、账务等核心业务数据 |
| 不适合场景 | 复杂报表、多表强一致事务 | 结构频繁变化、深层嵌套的数据 |

---

## 小结

- 副本集默认写关注是 `w: "majority"`；选举耗时中位数通常不超过 12 秒；从库读要接受旧数据
- 分片键决定一切：单调递增键会造成写热点，哈希分片会让范围查询广播；6.0 起不需要 `enableSharding`，5.0 起可在线重新分片
- 多文档事务：4.0 副本集、4.2 分片集群；默认 60 秒上限，建议不超过 1000 个文档，优先用内嵌避免事务
- 已有 MongoDB 的中等规模时序数据可用时间序列集合
- 结构灵活、深层嵌套、需要原生分片的数据适合 MongoDB；交易、账务等需要完整 ACID 与复杂 JOIN 的核心数据留在 MySQL

## 参考资料

- MongoDB 8.0 发布说明：[https://www.mongodb.com/docs/manual/release-notes/8.0/](https://www.mongodb.com/docs/manual/release-notes/8.0/)
- 副本集选举：[https://www.mongodb.com/docs/manual/core/replica-set-elections/](https://www.mongodb.com/docs/manual/core/replica-set-elections/)
- sh.enableSharding()：[https://www.mongodb.com/docs/manual/reference/method/sh.enableSharding/](https://www.mongodb.com/docs/manual/reference/method/sh.enableSharding/)
- 分片键选择：[https://www.mongodb.com/docs/manual/core/sharding-choose-a-shard-key/](https://www.mongodb.com/docs/manual/core/sharding-choose-a-shard-key/)
- 事务生产注意事项：[https://www.mongodb.com/docs/manual/core/transactions-production-consideration/](https://www.mongodb.com/docs/manual/core/transactions-production-consideration/)
- 时间序列集合：[https://www.mongodb.com/docs/manual/core/timeseries-collections/](https://www.mongodb.com/docs/manual/core/timeseries-collections/)
- Java 同步驱动事务：[https://www.mongodb.com/docs/drivers/java/sync/current/crud/transactions/](https://www.mongodb.com/docs/drivers/java/sync/current/crud/transactions/)

> 下一篇：[HBase](./5_hbase) —— 宽列与列式 OLAP 的区别、HBase 数据模型与架构、LSM 读写流程、RowKey 设计与预分区、适用场景
