---
description: Pool API、查询与批量、事务、连接池与流水线、Redis 客户端、Kafka 客户端
---

# 响应式数据访问

> **本篇目标**：掌握 Vert.x 5 响应式 SQL 客户端的 Pool API、查询、批量、事务与游标，理解连接池参数与流水线对吞吐的影响；会用 Redis 与 Kafka 客户端，并清楚在什么情况下仍然应该使用 JDBC。
>
> **前置阅读**：[Event Loop 与 Verticle](./2_core)、[池化技术](/high-perf/7_pooling)

---

## 一、为什么需要响应式客户端

### 1、JDBC 在 Event Loop 上的问题

JDBC 是同步 API：`executeQuery` 返回之前，调用线程一直阻塞在 socket 读上。放在 Event Loop 上执行，一次 50 ms 的查询就会让该线程上的其他所有请求等 50 ms。把 JDBC 包进 `executeBlocking` 能解决阻塞，但吞吐上限就变成了 Worker 池大小——又回到了「一个请求一个线程」的模型。

![JDBC 阻塞模型 vs Vert.x 响应式 SQL 客户端](../assets/vertx/sql-pool.svg)

Vert.x 的 SQL 客户端**自己实现了数据库的网络协议**（PostgreSQL、MySQL、SQL Server、Oracle、DB2），直接跑在 Netty 上：发出查询后立即返回，结果到达时在原 Context 上回调。少量 Event Loop 线程就能驱动大量并发查询，同一个连接上还能流水线发送多条语句。

### 2、代价

- **只能用官方客户端**：不能复用 JDBC 驱动、HikariCP、MyBatis、JPA 生态；ORM 层面可以考虑 Hibernate Reactive（它构建在 Vert.x SQL 客户端之上）；
- **数据库本身并不会更快**：响应式解决的是应用侧线程占用，数据库的连接数、慢查询、锁冲突一个都不会少。数据库侧的瓶颈分析见 [数据访问性能](/high-perf/10_db_performance)；
- **调试更难**：异常栈里看不到业务调用链，需要依靠日志里的 traceId。

---

## 二、Pool API

### 1、创建连接池

Vert.x 5 删除了 `PgPool.pool(...)` 等静态工厂，统一用 Builder 构建，返回通用的 `io.vertx.sqlclient.Pool`：

```java
import io.vertx.pgclient.PgBuilder;
import io.vertx.pgclient.PgConnectOptions;
import io.vertx.sqlclient.Pool;
import io.vertx.sqlclient.PoolOptions;

PgConnectOptions connect = new PgConnectOptions()
    .setHost(cfg.getString("db.host"))
    .setPort(5432)
    .setDatabase("orders")
    .setUser(cfg.getString("db.user"))
    .setPassword(cfg.getString("db.password"))
    .setCachePreparedStatements(true)       // 缓存预编译语句
    .setPipeliningLimit(256);               // 单连接流水线上限（PG 默认 256）

PoolOptions poolOptions = new PoolOptions()
    .setMaxSize(20)                         // 默认 4
    .setMaxWaitQueueSize(500)               // 默认 -1，无界
    .setConnectionTimeout(3)                // 获取连接超时，默认 30（秒）
    .setIdleTimeout(300)                    // 默认 0，不回收空闲连接
    .setMaxLifetime(1800)                   // 默认 0，不限制寿命
    .setShared(true)
    .setName("orders-pool");

Pool pool = PgBuilder.pool()
    .with(poolOptions)
    .connectingTo(connect)
    .using(vertx)
    .build();
```

MySQL 只需换成 `MySQLBuilder` 与 `MySQLConnectOptions`，其余 API 完全一致。注意占位符不同：PostgreSQL 用 `$1`、`$2`，MySQL 用 `?`。

### 2、PoolOptions 默认值与调整

| 参数 | 默认值 | 建议 |
|------|--------|------|
| `maxSize` | 4 | 按数据库可承受连接数与实例数反推，一般 10–30 |
| `maxWaitQueueSize` | -1（无界） | **必须设上限**，否则数据库变慢时请求无限堆积直到 OOM |
| `connectionTimeout` | 30 s | 调到 1–3 s，快速失败比排队更好 |
| `idleTimeout` | 0（不回收） | 设置为小于数据库 / 中间件空闲断开时间 |
| `maxLifetime` | 0（不限制） | 经过负载均衡或代理时设置，便于连接重新均衡 |
| `shared` | `false` | 多个 Verticle 实例共用一个池时设为 `true` 并命名 |
| `eventLoopSize` | 0（复用当前 Event Loop） | 池在 Verticle 外创建时，设置后连接分散到多个 Event Loop |

### 3、池放在哪里

| 方式 | 行为 | 适用 |
|------|------|------|
| 每个 Verticle 实例各建一个池 | 连接绑定在该实例的 Event Loop，总连接数 = 实例数 × maxSize | 实例少、需要强隔离 |
| `setShared(true)` + 同名 | 多个实例共享同一个池，所有租约关闭后才释放 | **推荐**，总连接数可控 |
| 在 Verticle 外创建 | 卸载 Verticle 时不会关闭池 | 需要自己管理生命周期 |

一个常见事故：HTTP Verticle 部署 16 个实例，每个实例各建一个 `maxSize=20` 的池，单机就是 320 个连接，扩容到 10 台直接打满数据库的 `max_connections`。连接数规划的通用方法见 [池化技术](/high-perf/7_pooling)。

### 4、流水线

PostgreSQL 客户端支持在**同一个连接**上不等上一个结果就发送下一条语句（pipelining），默认上限 256，设为 1 即关闭。要注意的是：

- 直接在 `Pool` 上执行的操作**不会**流水线，每次操作独占一个连接；
- 通过 `withConnection` / `getConnection` 拿到连接后，在该连接上并发发出的多条语句才会流水线；
- 流水线减少的是往返延迟，数据库仍然串行执行同一连接上的语句，长事务里不要指望它提升并发。

---

## 三、查询

### 1、简单查询与预编译

```java
import io.vertx.sqlclient.Row;
import io.vertx.sqlclient.RowIterator;
import io.vertx.sqlclient.RowSet;
import io.vertx.sqlclient.Tuple;

public Future<Order> findById(long id) {
  return pool.preparedQuery("SELECT id, user_id, amount, status FROM orders WHERE id = $1")
      .execute(Tuple.of(id))
      .map(rows -> {
        RowIterator<Row> it = rows.iterator();
        if (!it.hasNext()) {
          throw new NotFoundException("order " + id);
        }
        Row r = it.next();
        return new Order(r.getLong("id"), r.getLong("user_id"),
            r.getBigDecimal("amount"), r.getString("status"));
      });
}
```

- **永远用 `preparedQuery` + `Tuple` 传参**，`query("... " + id)` 拼接 SQL 等于主动开 SQL 注入口子；
- `map` 中抛出的异常会让 Future 失败，可以利用这一点把「查不到」转成业务异常；
- `rows.rowCount()` 返回影响行数；PostgreSQL 取自增主键用 `INSERT ... RETURNING id`，MySQL 用 `rows.property(MySQLClient.LAST_INSERTED_ID)`。

### 2、批量

```java
List<Tuple> batch = items.stream()
    .map(i -> Tuple.of(orderId, i.skuId(), i.quantity()))
    .toList();

pool.preparedQuery("INSERT INTO order_items (order_id, sku_id, quantity) VALUES ($1, $2, $3)")
    .executeBatch(batch);
```

`executeBatch` 在一次往返中发送多组参数，比循环 `execute` 快得多。单批建议几百到一千条，过大的批会长时间占用连接。

### 3、SqlTemplate

`vertx-sql-client-templates` 提供命名参数与行映射，减少手写 `Tuple` 与 `Row` 转换：

```java
import io.vertx.sqlclient.templates.SqlTemplate;

Future<RowSet<JsonObject>> users = SqlTemplate
    .forQuery(pool, "SELECT id, name, email FROM users WHERE status = #{status} LIMIT #{limit}")
    .mapTo(Row::toJson)
    .execute(Map.of("status", "ACTIVE", "limit", 100));
```

Vert.x 5.1 起 `SqlTemplate` 实例可以在池化连接之间复用，建议定义为字段而非每次创建。

### 4、游标与流式读取

导出、迁移等需要读取大量行的场景，不要一次性 `execute` 拿全量结果：

```java
import io.vertx.core.Promise;
import io.vertx.sqlclient.RowStream;

public Future<Long> exportOrders(LocalDate since, WriteStream<Buffer> out) {
  return pool.withTransaction(conn -> conn
      .prepare("SELECT id, amount FROM orders WHERE created_at >= $1")
      .compose(ps -> {
        Promise<Long> done = Promise.promise();
        long[] count = {0};
        RowStream<Row> stream = ps.createStream(500, Tuple.of(since));   // 每次取 500 行
        stream.exceptionHandler(done::fail);
        stream.endHandler(v -> done.complete(count[0]));
        stream.handler(row -> {
          count[0]++;
          out.write(Buffer.buffer(row.getLong("id") + "," + row.getBigDecimal("amount") + "\n"));
          if (out.writeQueueFull()) {                       // 背压：下游写不动就暂停拉取
            stream.pause();
            out.drainHandler(d -> stream.resume());
          }
        });
        return done.future();
      }));
}
```

PostgreSQL 的游标和流**必须在事务中使用**，否则会遇到 `34000` 错误。`count` 用数组包装是因为 lambda 只能捕获 effectively final 变量，而这里所有回调都在同一个 Context 上执行，不存在并发问题。

---

## 四、事务

### 1、withTransaction

```java
public Future<Long> placeOrder(PlaceOrderCmd cmd) {
  return pool.withTransaction(client -> client
      .preparedQuery("UPDATE stock SET available = available - $1 WHERE sku_id = $2 AND available >= $1")
      .execute(Tuple.of(cmd.quantity(), cmd.skuId()))
      .compose(r -> r.rowCount() == 1
          ? Future.succeededFuture()
          : Future.failedFuture(new BizException("库存不足")))
      .compose(v -> client
          .preparedQuery("INSERT INTO orders (user_id, sku_id, quantity, status) VALUES ($1, $2, $3, 'CREATED') RETURNING id")
          .execute(Tuple.of(cmd.userId(), cmd.skuId(), cmd.quantity())))
      .map(rows -> rows.iterator().next().getLong("id")));
}
```

`withTransaction` 的语义：从池中借连接 → `BEGIN` → 执行函数 → 返回的 Future **成功则提交，失败则回滚** → 归还连接。只要整条链用 `compose` 串起来，任何一步失败都会回滚。

### 2、常见错误

| 错误 | 后果 | 正确做法 |
|------|------|----------|
| 在函数里用 `pool` 而不是参数 `client` 执行 SQL | 这条语句在另一个连接上，不在事务里 | 事务内只用传入的 `client` |
| 发起了异步操作却没有把它的 Future 串进返回值 | 事务提前提交，后续语句在已提交的连接上执行或报错 | 所有操作用 `compose` 串成一条链 |
| 在事务中调用外部 HTTP | 下游变慢时长时间占用连接和行锁 | 外部调用放到事务外，或改为本地消息表 |
| 手动 `begin` 后漏掉 `conn.close()` | 连接泄漏，池被耗尽 | 用 `withTransaction` / `withConnection`，或 `eventually(conn::close)` |

响应式客户端没有 Spring 那样的声明式事务和传播行为，事务边界完全由代码结构决定；跨服务的一致性方案见 [分布式事务](/distributed/4_transaction)。

---

## 五、Redis 客户端

### 1、创建与基本操作

```java
import io.vertx.redis.client.Redis;
import io.vertx.redis.client.RedisAPI;
import io.vertx.redis.client.RedisClientType;
import io.vertx.redis.client.RedisOptions;

Redis redis = Redis.createClient(vertx, new RedisOptions()
    .setType(RedisClientType.CLUSTER)
    .addConnectionString("redis://10.0.0.1:7000")
    .addConnectionString("redis://10.0.0.2:7000")
    .setPassword(cfg.getString("redis.password"))
    .setMaxPoolSize(16)
    .setMaxWaitingHandlers(256));

RedisAPI api = RedisAPI.api(redis);

api.set(List.of("session:" + sid, json.encode(), "EX", "1800"))
    .compose(ok -> api.get("session:" + sid))
    .onSuccess(resp -> log.info("value {}", resp == null ? null : resp.toString()));
```

- 支持单机、Sentinel、Cluster、Replication 四种模式，用 `setType` 选择；
- Vert.x 5 中 `addEndpoint` / `setEndpoint` 改名为 `addConnectionString` / `setConnectionString`，参数中出现 `null` 会直接抛 `IllegalArgumentException`；
- 客户端工作在流水线模式，单连接可以承载很高的并发；连接池上限与等待队列同样要按压测结果显式设置；
- `RedisAPI` 的每个命令都返回 `Future<Response>`，`Response` 需要按命令语义转换（`toString()`、`toInteger()`、遍历数组）。

### 2、发布订阅

```java
import io.vertx.redis.client.Command;
import io.vertx.redis.client.EventBusHandler;
import io.vertx.redis.client.Request;

redis.connect().onSuccess(conn -> {
  conn.handler(EventBusHandler.create(vertx));      // Vert.x 5 需显式注册，订阅消息不再自动转发到 Event Bus
  conn.send(Request.cmd(Command.SUBSCRIBE).arg("cache.invalidate"));
});
```

`EventBusHandler` 把订阅到的消息转发到 Event Bus，再由本地 consumer 处理（转发地址的前缀规则以所用版本的文档为准）；也可以直接给 `conn.handler(...)` 传自己的 Handler 解析推送消息。

订阅会独占一个连接，这个连接不能再执行普通命令，**不要从池里借连接做订阅后再归还**。Redis Pub/Sub 本身也是至多一次，可靠的缓存失效通知可以改用 Stream。Redis 的数据结构与集群原理见 [Redis 基础](/cache/1_redis_base)。

---

## 六、Kafka 客户端

### 1、消费者

```java
import io.vertx.kafka.client.common.TopicPartition;
import io.vertx.kafka.client.consumer.KafkaConsumer;
import io.vertx.kafka.client.consumer.OffsetAndMetadata;

Map<String, String> config = Map.of(
    "bootstrap.servers", "kafka-1:9092,kafka-2:9092",
    "group.id", "order-projector",
    "key.deserializer", "org.apache.kafka.common.serialization.StringDeserializer",
    "value.deserializer", "org.apache.kafka.common.serialization.StringDeserializer",
    "enable.auto.commit", "false",
    "auto.offset.reset", "earliest");

KafkaConsumer<String, String> consumer = KafkaConsumer.create(vertx, config);

consumer.handler(record -> {
  consumer.pause();                                         // 处理完一条再拉下一条，形成背压
  projector.apply(new JsonObject(record.value()))          // 幂等写入
      .compose(v -> consumer.commit(Map.of(                    // 只提交已处理完的这一条
          new TopicPartition(record.topic(), record.partition()),
          new OffsetAndMetadata(record.offset() + 1, ""))))
      .onFailure(err -> log.error("process failed offset={}", record.offset(), err))
      .onComplete(ar -> consumer.resume());
});

consumer.subscribe("order-events")
    .onFailure(err -> log.error("subscribe failed", err));
```

- 在 Verticle 的 `start()` 中创建消费者，消息就在该 Verticle 的 Event Loop 上回调，Handler 里同样不能阻塞；
- 关闭自动提交、处理成功后再提交，得到的是**至少一次**语义，消费逻辑必须幂等。注意无参 `commit()` 提交的是「当前位置」，即最近一次拉取的整批消息，可能包含尚未处理的记录，逐条处理时应像上面一样提交具体的 `offset + 1`；
- `pause()` 之后已经拉到本地的消息仍可能继续送达 Handler 一小段时间，处理逻辑要能容忍；
- 逐条 `commit` 的开销较大，吞吐要求高时可以按条数或时间间隔批量提交，代价是重启后重复消费的范围变大。

### 2、生产者

```java
import io.vertx.kafka.client.producer.KafkaProducer;
import io.vertx.kafka.client.producer.KafkaProducerRecord;

KafkaProducer<String, String> producer = KafkaProducer.createShared(vertx, "order-producer", Map.of(
    "bootstrap.servers", "kafka-1:9092,kafka-2:9092",
    "key.serializer", "org.apache.kafka.common.serialization.StringSerializer",
    "value.serializer", "org.apache.kafka.common.serialization.StringSerializer",
    "acks", "all",
    "enable.idempotence", "true"));

producer.send(KafkaProducerRecord.create("order-events", String.valueOf(orderId), event.encode()))
    .onSuccess(meta -> log.debug("sent partition={} offset={}", meta.getPartition(), meta.getOffset()))
    .onFailure(err -> log.error("send failed", err));
```

`createShared` 按名字在多个 Verticle 实例之间共享同一个生产者（配置以第一次创建为准），避免每个实例各开一套连接与缓冲区。`acks`、幂等生产者、分区与顺序、Rebalance 等 Kafka 自身的可靠性话题见 [Kafka](/messaging/2_kafka)。

---

## 七、仍然需要 JDBC 怎么办

Vert.x 5 中旧版 JDBC API 已进入日落状态（5.x 可用、6.x 移除），`vertx-jdbc-client` 保留的是 SQL Client API 的实现（`JDBCPool`），它在 Worker 线程上执行阻塞的 JDBC 调用。下面这些情况仍然绕不开 JDBC：

- 数据库没有 Vert.x 响应式客户端（ClickHouse、达梦等国产库、各类云数仓）；
- 依赖存储过程、特殊类型或驱动扩展；
- 已有大量 MyBatis / JPA 代码需要复用。

推荐做法：

| 方案 | 说明 |
|------|------|
| `JDBCPool`（`vertx-jdbc-client`） | 与响应式客户端相同的 `Pool` / `Tuple` API，阻塞调用由 Worker 线程承担，吞吐受 Worker 池大小限制 |
| 虚拟线程 Verticle + HikariCP | 同步代码直接写，阻塞只挂起虚拟线程；连接池大小仍然是并发上限 |
| 命名 `WorkerExecutor` + HikariCP | JDK 21 之前的做法，Worker 池大小与连接池大小保持一致 |
| 拆成独立服务 | 重度 JDBC 的模块用 Spring Boot 实现，Vert.x 服务通过 HTTP 调用 |

无论哪种方式，都要保证**阻塞调用不会出现在 Event Loop 上**，并给阻塞池设置独立的名字，方便在线程 dump 中定位问题。

---

## 小结

- 响应式 SQL 客户端自己实现数据库协议，查询不占线程；代价是放弃 JDBC 生态，数据库本身不会更快
- Vert.x 5 用 `PgBuilder` / `MySQLBuilder` 构建通用 `Pool`；`maxSize` 默认 4、等待队列默认无界、获取连接超时默认 30s，生产都要显式调整
- 多实例 Verticle 用 `setShared(true)` 共享连接池，避免连接数按实例数倍增
- 只有从池中借出的连接才会流水线（PG 默认 256）；批量用 `executeBatch`，大结果集在事务内用游标流并处理背压
- `withTransaction` 按返回 Future 成败提交或回滚，事务内只用传入的 client，所有操作必须串进同一条 Future 链
- Redis 客户端支持四种部署模式，Vert.x 5 订阅需显式注册 `EventBusHandler`；订阅连接独占
- Kafka 消费关闭自动提交、处理成功再提交，得到至少一次语义；生产者用 `createShared` 复用
- 必须用 JDBC 时用 `JDBCPool`、虚拟线程或命名 Worker 池，绝不放在 Event Loop

## 参考资料

- Reactive PostgreSQL Client：[https://vertx.io/docs/vertx-pg-client/java/](https://vertx.io/docs/vertx-pg-client/java/)
- Reactive MySQL Client：[https://vertx.io/docs/vertx-mysql-client/java/](https://vertx.io/docs/vertx-mysql-client/java/)
- `PoolOptions` API：[https://vertx.io/docs/apidocs/io/vertx/sqlclient/PoolOptions.html](https://vertx.io/docs/apidocs/io/vertx/sqlclient/PoolOptions.html)
- Vert.x Redis Client：[https://vertx.io/docs/vertx-redis-client/java/](https://vertx.io/docs/vertx-redis-client/java/)
- Vert.x Kafka Client：[https://vertx.io/docs/vertx-kafka-client/java/](https://vertx.io/docs/vertx-kafka-client/java/)

> 下一篇：[集群与生产实践](./6_production) —— 集群、配置、指标、链路、测试、打包与调优，把 Vert.x 服务稳定地跑在生产环境。
