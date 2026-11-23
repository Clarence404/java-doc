---
description: MongoDB 定位与版本、文档建模内嵌与引用、CRUD 与操作符、索引与 ESR 规则、聚合 Pipeline
---

# MongoDB 基础

> 前置阅读：[MySQL 索引](/database/1_mysql/3_topic_index)

MongoDB 是以 BSON 存储文档的数据库，Schema 灵活，天然支持嵌套文档与数组。本篇讲文档建模（内嵌还是引用）、基本 CRUD、索引与聚合 Pipeline，基线为 MongoDB 8。

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

表中的副本集、分片、事务与时间序列集合见 [MongoDB 集群与事务](./4_mongodb_cluster)。

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

全文检索方面，传统的 `text` 索引（`$text`）只有基础的词干与权重能力，不支持中文分词；Atlas 上用 Atlas Search（`$search`）和 Atlas Vector Search（`$vectorSearch`），自建版从 8.2 起以公开预览形式提供同样的能力。复杂搜索仍建议同步到 [搜索数据库](./13_search_db)。

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

## 小结

- MongoDB 以 8.x 为基线：8.0 侧重性能与分片改进，8.2 起自建版也能预览 `$search` / `$vectorSearch`；社区版是 SSPL 许可
- 建模原则是一起读的数据放一起：一对少内嵌，一对多 / 多对多引用；警惕 16MB 上限和无界数组
- 单文档写入是原子的，把需要一起更新的数据内嵌到同一文档可以避免多文档事务
- 复合索引按 ESR 规则排列字段；用部分索引代替 sparse 索引；TTL 索引由后台线程定期删除
- 聚合 Pipeline 把 `$match` 放最前才能用上索引；`$lookup` 在分片集群上开销大，高频关联改为内嵌或冗余

## 参考资料

- MongoDB 8.0 发布说明：[https://www.mongodb.com/docs/manual/release-notes/8.0/](https://www.mongodb.com/docs/manual/release-notes/8.0/)
- MongoDB 8.2 发布说明：[https://www.mongodb.com/docs/manual/release-notes/8.2/](https://www.mongodb.com/docs/manual/release-notes/8.2/)
- 数据建模：[https://www.mongodb.com/docs/manual/data-modeling/](https://www.mongodb.com/docs/manual/data-modeling/)
- 部分索引：[https://www.mongodb.com/docs/manual/core/index-partial/](https://www.mongodb.com/docs/manual/core/index-partial/)

> 下一篇：[MongoDB 集群与事务](./4_mongodb_cluster) —— 副本集与读写关注、分片集群与分片键、多文档事务的版本边界与代价、时间序列集合、与 MySQL 选型
