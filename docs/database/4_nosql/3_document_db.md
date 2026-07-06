# Document Stores

## 一、MongoDB

### 1、定位与特点

- 面向文档的 NoSQL 数据库，数据以 **BSON**（Binary JSON）格式存储
- **Schema 自由**：同一集合中的文档可以有不同结构，无需 ALTER TABLE
- 支持嵌套文档和数组，天然表达一对多关系
- 适合：内容管理、用户画像、商品 SPU/SKU、IoT 数据、日志

| MongoDB 概念 | 类比关系型 |
|-------------|-----------|
| Database | 数据库 |
| Collection | 表 |
| Document | 行（JSON 对象）|
| Field | 列 |
| `_id` | 主键（默认 ObjectId）|

### 2、基本 CRUD

```javascript
// 插入
db.users.insertOne({ name: "Alice", age: 30, tags: ["vip", "member"] });
db.users.insertMany([
  { name: "Bob",     age: 25 },
  { name: "Charlie", age: 35, address: { city: "Beijing" } }
]);

// 查询
db.users.find({ age: { $gte: 18 } });
db.users.find({ tags: "vip" });                        // 数组元素匹配
db.users.find({ "address.city": "Beijing" });          // 嵌套字段
db.users.find({}, { name: 1, age: 1, _id: 0 });       // 投影（只返回 name 和 age）

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

**常用查询操作符**：

| 操作符 | 含义 | 示例 |
|--------|------|------|
| `$eq` `$ne` | 等于/不等于 | `{ age: { $ne: 18 } }` |
| `$gt` `$gte` `$lt` `$lte` | 大小比较 | `{ age: { $gte: 18 } }` |
| `$in` `$nin` | 包含/不包含 | `{ status: { $in: ["paid","pending"] } }` |
| `$and` `$or` `$not` | 逻辑运算 | `{ $or: [{age: 18}, {vip: true}] }` |
| `$exists` | 字段是否存在 | `{ phone: { $exists: true } }` |
| `$regex` | 正则匹配 | `{ name: { $regex: "^张" } }` |

### 3、索引类型

```javascript
// 单字段索引
db.users.createIndex({ age: 1 });            // 1=升序，-1=降序

// 复合索引（遵守最左前缀原则）
db.orders.createIndex({ user_id: 1, status: 1, created_at: -1 });

// 唯一索引
db.users.createIndex({ email: 1 }, { unique: true });

// 稀疏索引（只索引存在该字段的文档）
db.users.createIndex({ phone: 1 }, { sparse: true });

// TTL 索引（自动过期删除）
db.sessions.createIndex({ created_at: 1 }, { expireAfterSeconds: 86400 });

// 文本索引（全文搜索）
db.articles.createIndex({ title: "text", content: "text" });
db.articles.find({ $text: { $search: "java spring" } });

// 地理空间索引
db.stores.createIndex({ location: "2dsphere" });
db.stores.find({
  location: { $near: { $geometry: { type: "Point", coordinates: [116.4, 39.9] }, $maxDistance: 1000 } }
});

// 查看查询计划
db.orders.find({ user_id: 123 }).explain("executionStats");
```

### 4、聚合 Pipeline

聚合通过管道（Pipeline）处理，每个阶段对文档集合进行转换：

```javascript
db.orders.aggregate([
  // $match：过滤（尽量放最前，利用索引）
  { $match: { status: "paid", created_at: { $gte: ISODate("2024-01-01") } } },

  // $group：分组聚合
  { $group: {
    _id: "$user_id",
    total_amount: { $sum: "$amount" },
    order_count:  { $sum: 1 },
    avg_amount:   { $avg: "$amount" }
  }},

  // $match：聚合后再过滤
  { $match: { total_amount: { $gte: 1000 } } },

  // $lookup：关联查询（类似 LEFT JOIN）
  { $lookup: {
    from:         "users",
    localField:   "_id",
    foreignField: "_id",
    as:           "user_info"
  }},

  // $unwind：展开数组
  { $unwind: "$user_info" },

  // $project：字段选择/计算
  { $project: {
    user_name:    "$user_info.name",
    total_amount: 1,
    order_count:  1,
    _id: 0
  }},

  // $sort + $limit：分页
  { $sort: { total_amount: -1 } },
  { $limit: 10 }
]);
```

### 5、副本集（Replica Set）

```
Primary（主节点）
  ├── Secondary 1（从节点）
  └── Secondary 2（从节点）
        ↑ 自动选举（Raft 协议）
```

- **Primary** 处理所有写操作
- **Secondary** 异步复制，可承担读请求（`readPreference: secondaryPreferred`）
- Primary 宕机：Secondary 自动选举新 Primary（通常 < 10s）

```javascript
// 副本集连接
const client = new MongoClient(
  "mongodb://host1:27017,host2:27017,host3:27017/?replicaSet=myReplSet&readPreference=secondaryPreferred"
);
```

### 6、分片集群（Sharding）

```
Client
  ↓
mongos（路由节点）
  ↓
Config Server（元数据）
  ↓
Shard 1（副本集）  Shard 2（副本集）  Shard 3（副本集）
```

**分片策略**：

| 策略 | 特点 | 适用场景 |
|------|------|---------|
| 哈希分片 | 数据均匀分布，无热点 | 高写入吞吐，user_id 等 |
| 范围分片 | 范围查询高效，可能热点 | 时间序列、有序数据 |
| 区域分片（Zone）| 按地理区域路由 | 数据本地化合规 |

```javascript
sh.enableSharding("mydb");
sh.shardCollection("mydb.orders", { user_id: "hashed" });
```

### 7、多文档事务（4.0+）

```javascript
const session = client.startSession();
session.startTransaction({
  readConcern:  { level: "snapshot" },
  writeConcern: { w: "majority" }
});
try {
  await accounts.updateOne({ _id: fromId }, { $inc: { balance: -100 } }, { session });
  await accounts.updateOne({ _id: toId },   { $inc: { balance: +100 } }, { session });
  await session.commitTransaction();
} catch (e) {
  await session.abortTransaction();
  throw e;
} finally {
  await session.endSession();
}
```

> 注意：MongoDB 事务性能比单文档操作差 3~10 倍，应尽量通过嵌套文档设计避免多文档事务。

### 8、MongoDB vs MySQL 选型

| 维度 | MongoDB | MySQL |
|------|---------|-------|
| 数据模型 | 文档（嵌套、数组、Schema 自由）| 行（强 Schema）|
| Schema 变更 | 无需 DDL，随时添加字段 | ALTER TABLE 可能锁表 |
| 关联查询 | `$lookup`（弱，建议应用层组装）| JOIN（强）|
| 事务 | 4.0+ 多文档事务（有性能损耗）| 完整 ACID |
| 水平扩展 | 原生分片，内置支持 | 需要中间件（ShardingSphere 等）|
| 全文搜索 | 基础文本索引 | 弱（建议用 ES）|
| 适合场景 | 内容、画像、IoT、日志、商品 SKU | 业务核心交易数据 |
| 不适合场景 | 复杂报表、强一致事务 | 超灵活 Schema、海量非结构化 |
