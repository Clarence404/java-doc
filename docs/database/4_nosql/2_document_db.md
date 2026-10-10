---
description: MongoDB 8、文档建模、索引、聚合、副本集、分片、多文档事务、时间序列集合、选型
---

# 文档数据库

> 前置阅读：[MySQL 索引](../1_mysql/4_topic_index)、[列式与 OLAP 数据库](./0_column_db)

本篇以 MongoDB 8.x 为基线，讲文档建模（内嵌还是引用）、索引与聚合、副本集与分片集群、多文档事务的版本边界与代价，以及何时该用 MongoDB 而不是 MySQL。

---

## 一、定位与版本

MongoDB 是面向文档的数据库，数据以 **BSON**（Binary JSON）存储：

- **Schema 灵活**：同一集合中的文档可以有不同字段，加字段不需要 DDL；需要约束时可以用 JSON Schema 校验
- **嵌套文档与数组**：天然表达一对多关系，一次读取拿到聚合根的全部数据
- 适合：内容管理、用户画像、商品 SPU / SKU、配置与元数据、IoT 设备数据、日志

| MongoDB 概念 | 类比关系型 |
|-------------|-----------|
| Database | 数据库 |
| Collection | 表 |
| Document | 行（JSON 对象） |
| Field | 列 |
| `_id` | 主键（默认 ObjectId） |

版本基线：

| 版本 | 时间 | 要点 |
|------|------|------|
| 4.0 / 4.2 | 2018 / 2019 | 副本集多文档事务 / 分片集群分布式事务 |
| 5.0 | 2021 | 原生时间序列集合、在线重新分片（resharding）、默认写关注改为 `w: "majority"` |
| 6.0 | 2022 | 分片集合不再需要先 `enableSharding` |
| 8.0 | 2024 年 10 月 | 大幅性能优化、Config Shard（配置服务器兼作分片）、更快的重新分片、Queryable Encryption 支持范围查询 |
| 8.2 | 2025 年 9 月 | 社区版与企业版提供 `$search` / `$vectorSearch`（公开预览，需单独部署 mongot） |

许可：2018 年 10 月起社区版采用 **SSPL**，不是 OSI 认可的开源协议；托管服务为 MongoDB Atlas。

---

## 二、文档建模

文档数据库的建模原则是：**一起读的数据放在一起**。

| 方式 | 做法 | 适用 |
|------|------|------|
| 内嵌（Embed） | 子数据作为嵌套文档或数组放进父文档 | 一对一、一对少量；子数据随父数据一起读写，例如订单与订单项、用户与收货地址 |
| 引用（Reference） | 存对方 `_id`，用 `$lookup` 或应用层再查 | 一对大量、多对多；子数据独立访问或频繁单独更新，例如用户与订单、文章与评论 |

需要注意的限制与反模式：

- **单文档上限 16MB**：评论、日志这类会持续增长的数组不要内嵌（无界数组反模式），改为单独集合引用父 `_id`，或用分桶模式（每个文档存一段时间或固定条数）
- **单文档写入是原子的**：把需要一起更新的数据内嵌到同一文档，可以避免多文档事务
- **适度冗余**：列表页需要的少量字段（如作者昵称）可以冗余到文档里，代价是变更时要同步更新

---

## 三、基本 CRUD

以下在 `mongosh` 中执行：

```javascript
// 插入
db.users.insertOne({ name: "Alice", age: 30, tags: ["vip", "member"] });
db.users.insertMany([
  { name: "Bob",     age: 25 },
  { name: "Charlie", age: 35, address: { city: "Beijing" } }
]);

// 查询
db.users.find({ age: { $gte: 18 } });
db.users.find({ tags: "vip" });                    // 数组元素匹配
db.users.find({ "address.city": "Beijing" });      // 嵌套字段
db.users.find({}, { name: 1, age: 1, _id: 0 });    // 投影

// 更新
db.users.updateOne(
  { name: "Alice" },
  { $set: { age: 31 }, $addToSet: { tags: "gold" } }
);
db.users.updateMany({ age: { $lt: 18 } }, { $set: { status: "minor" } });

// 删除
db.users.deleteOne({ name: "Alice" });
db.users.deleteMany({ status: "inactive", last_login: { $lt: new Date("2023-01-01") } });
```

| 操作符 | 含义 | 示例 |
|--------|------|------|
| `$eq` `$ne` | 等于 / 不等于 | `{ age: { $ne: 18 } }` |
| `$gt` `$gte` `$lt` `$lte` | 大小比较 | `{ age: { $gte: 18 } }` |
| `$in` `$nin` | 包含 / 不包含 | `{ status: { $in: ["paid", "pending"] } }` |
| `$and` `$or` `$not` | 逻辑运算 | `{ $or: [{ age: 18 }, { vip: true }] }` |
| `$exists` | 字段是否存在 | `{ phone: { $exists: true } }` |
| `$regex` | 正则匹配 | `{ name: { $regex: "^张" } }` |

---

## 四、索引

```javascript
// 单字段索引：1 升序，-1 降序
db.users.createIndex({ age: 1 });

// 复合索引：同样遵守最左前缀；字段顺序按 ESR 规则排（等值 Equality → 排序 Sort → 范围 Range）
db.orders.createIndex({ user_id: 1, created_at: -1, amount: 1 });

// 唯一索引
db.users.createIndex({ email: 1 }, { unique: true });

// 部分索引：只索引满足条件的文档（官方推荐用它代替 sparse 索引）
db.users.createIndex(
  { phone: 1 },
  { partialFilterExpression: { phone: { $exists: true } } }
);

// TTL 索引：created_at 超过 1 天的文档由后台线程自动删除（约每 60 秒扫描一次）
db.sessions.createIndex({ created_at: 1 }, { expireAfterSeconds: 86400 });

// 地理空间索引
db.stores.createIndex({ location: "2dsphere" });
db.stores.find({
  location: {
    $near: { $geometry: { type: "Point", coordinates: [116.4, 39.9] }, $maxDistance: 1000 }
  }
});

// 查看执行计划
db.orders.find({ user_id: 123 }).explain("executionStats");
```

全文检索方面，传统的 `text` 索引（`$text`）只有基础的词干与权重能力，不支持中文分词；Atlas 上用 Atlas Search（`$search`）和 Atlas Vector Search（`$vectorSearch`），自建版从 8.2 起以公开预览形式提供同样的能力。复杂搜索仍建议同步到 [搜索数据库](./3_search_db)。

---

## 五、聚合 Pipeline

聚合由多个阶段组成，前一阶段的输出是后一阶段的输入：

```javascript
db.orders.aggregate([
  // $match 放最前，才能用上索引
  { $match: { status: "paid", created_at: { $gte: ISODate("2024-01-01") } } },

  { $group: {
      _id: "$user_id",
      total_amount: { $sum: "$amount" },
      order_count:  { $sum: 1 },
      avg_amount:   { $avg: "$amount" }
  } },

  { $match: { total_amount: { $gte: 1000 } } },

  // $lookup：关联 users 集合（类似 LEFT JOIN）
  { $lookup: { from: "users", localField: "_id", foreignField: "_id", as: "user_info" } },
  { $unwind: "$user_info" },

  { $project: { _id: 0, user_name: "$user_info.name", total_amount: 1, order_count: 1 } },

  { $sort: { total_amount: -1 } },
  { $limit: 10 }
]);
```

单个阶段默认最多使用 100MB 内存，超出时会自动落盘（6.0 起 `allowDiskUseByDefault` 默认开启）。`$lookup` 在分片集群上开销较大，高频关联建议改为内嵌或冗余字段。

---

## 六、副本集（Replica Set）

![MongoDB 副本集（Replica Set）](../../assets/database/mongodb-replica-set.svg)

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

## 七、分片集群（Sharding）

![MongoDB 分片集群（Sharding）](../../assets/database/mongodb-sharding.svg)

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

## 八、多文档事务

| 版本 | 支持范围 |
|------|----------|
| 4.0 | 副本集上的多文档事务 |
| 4.2 | 分片集群上的分布式事务 |

使用约束：

- 事务默认必须在 60 秒内完成（`transactionLifetimeLimitSeconds`），超时自动中止
- 官方建议单个事务修改的文档不超过 1000 个，大批量修改要拆分
- 事务会持有 WiredTiger 快照、增加缓存压力并可能产生写冲突需要重试，单文档操作本身已经是原子的，**优先通过内嵌建模避免多文档事务**

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

Spring Data MongoDB 中注册 `MongoTransactionManager` 后即可用 `@Transactional`，Spring Boot 的连接配置见 [中间件集成](/spring-boot/5_middleware)，`@Transactional` 本身的机制见 [事务管理](/spring/4_transaction)。

---

## 九、时间序列集合

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

数据量和写入速率更高时，选专用的 [时序数据库](./1_time_series_db)。

---

## 十、MongoDB 与 MySQL 选型

| 维度 | MongoDB | MySQL |
|------|---------|-------|
| 数据模型 | 文档（嵌套、数组、Schema 灵活） | 行（强 Schema） |
| Schema 变更 | 不需要 DDL，应用兼容新旧结构即可 | 加列多为 INSTANT，大表其他 DDL 需 Online DDL / gh-ost 规划，见 [MySQL 避坑指南](../1_mysql/3_fallible_point) |
| 关联查询 | `$lookup`（能力弱，建议建模时内嵌或应用层组装） | JOIN（成熟） |
| 事务 | 单文档原子；多文档事务 4.0（副本集）/ 4.2（分片），有 60 秒与规模限制 | 完整 ACID |
| 一致性 | 依赖写关注 / 读关注配置，默认 `w: "majority"` | 主库强一致，从库异步复制有延迟 |
| 水平扩展 | 原生分片 | 需要中间件或分布式数据库，见 [分库分表与中间件](../5_practice/2_sharding) |
| 全文搜索 | 基础 `text` 索引；`$search` 需 Atlas 或 8.2 预览 | 弱，建议用 ES |
| 适合场景 | 内容、画像、商品 SKU、配置元数据、IoT | 交易、账务等核心业务数据 |
| 不适合场景 | 复杂报表、多表强一致事务 | 结构频繁变化、深层嵌套的数据 |

---

## 小结

- MongoDB 以 8.x 为基线：8.0 侧重性能与分片改进，8.2 起自建版也能预览 `$search` / `$vectorSearch`；社区版是 SSPL 许可
- 建模原则是一起读的数据放一起：一对少内嵌，一对多 / 多对多引用；警惕 16MB 上限和无界数组
- 复合索引按 ESR 规则排列字段；用部分索引代替 sparse 索引；TTL 索引由后台线程定期删除
- 副本集默认写关注是 `w: "majority"`；选举耗时中位数通常不超过 12 秒；从库读要接受旧数据
- 分片键决定一切：单调递增键会造成写热点，哈希分片会让范围查询广播；6.0 起不需要 `enableSharding`，5.0 起可在线重新分片
- 多文档事务：4.0 副本集、4.2 分片集群；默认 60 秒上限，建议不超过 1000 个文档，优先用内嵌避免事务
- 已有 MongoDB 的中等规模时序数据可用时间序列集合

## 参考资料

- MongoDB 8.0 发布说明：[https://www.mongodb.com/docs/manual/release-notes/8.0/](https://www.mongodb.com/docs/manual/release-notes/8.0/)
- MongoDB 8.2 发布说明：[https://www.mongodb.com/docs/manual/release-notes/8.2/](https://www.mongodb.com/docs/manual/release-notes/8.2/)
- 数据建模：[https://www.mongodb.com/docs/manual/data-modeling/](https://www.mongodb.com/docs/manual/data-modeling/)
- 部分索引：[https://www.mongodb.com/docs/manual/core/index-partial/](https://www.mongodb.com/docs/manual/core/index-partial/)
- 副本集选举：[https://www.mongodb.com/docs/manual/core/replica-set-elections/](https://www.mongodb.com/docs/manual/core/replica-set-elections/)
- sh.enableSharding()：[https://www.mongodb.com/docs/manual/reference/method/sh.enableSharding/](https://www.mongodb.com/docs/manual/reference/method/sh.enableSharding/)
- 分片键选择：[https://www.mongodb.com/docs/manual/core/sharding-choose-a-shard-key/](https://www.mongodb.com/docs/manual/core/sharding-choose-a-shard-key/)
- 事务生产注意事项：[https://www.mongodb.com/docs/manual/core/transactions-production-consideration/](https://www.mongodb.com/docs/manual/core/transactions-production-consideration/)
- 时间序列集合：[https://www.mongodb.com/docs/manual/core/timeseries-collections/](https://www.mongodb.com/docs/manual/core/timeseries-collections/)
- Java 同步驱动事务：[https://www.mongodb.com/docs/drivers/java/sync/current/crud/transactions/](https://www.mongodb.com/docs/drivers/java/sync/current/crud/transactions/)

> 下一篇：[搜索数据库](./3_search_db) —— 倒排索引、分析器与 Elasticsearch / OpenSearch 的使用与选型
