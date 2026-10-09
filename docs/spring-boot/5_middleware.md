---
description: Redis、Kafka、RabbitMQ、ES、MongoDB 的 Starter 与配置、Jackson 3 序列化
---

# 中间件集成

> **本篇目标**：掌握 Spring Boot 接入常见中间件的「胶水层」：用哪个 Starter、哪些配置项必须写、Boot 4 / Jackson 3 带来了哪些类名与配置变化，以及各自最容易踩的集成坑。中间件本身的原理、可靠性与调优在对应模块展开，本篇只给链接。
>
> **前置阅读**：[启动流程与自动配置](./1_spring_boot)

> 参考资料：
> * Spring Boot NoSQL：[https://docs.spring.io/spring-boot/reference/data/nosql.html](https://docs.spring.io/spring-boot/reference/data/nosql.html)
> * Spring Boot Messaging：[https://docs.spring.io/spring-boot/reference/messaging/index.html](https://docs.spring.io/spring-boot/reference/messaging/index.html)
> * Spring Data Redis 4.0 升级说明：[https://docs.spring.io/spring-data/redis/reference/upgrading.html](https://docs.spring.io/spring-data/redis/reference/upgrading.html)
> * Spring for Apache Kafka：[https://docs.spring.io/spring-kafka/reference/](https://docs.spring.io/spring-kafka/reference/)
> * Spring AMQP：[https://docs.spring.io/spring-amqp/reference/](https://docs.spring.io/spring-amqp/reference/)
> * Spring Data Elasticsearch：[https://docs.spring.io/spring-data/elasticsearch/reference/](https://docs.spring.io/spring-data/elasticsearch/reference/)
> * Spring Data MongoDB：[https://docs.spring.io/spring-data/mongodb/reference/](https://docs.spring.io/spring-data/mongodb/reference/)

---

## 一、总览

| 中间件 | Boot 4 Starter | 配置前缀 | Boot 4 主要变化 | 深入阅读 |
|--------|---------------|---------|----------------|---------|
| Redis | `spring-boot-starter-data-redis` | `spring.data.redis.*` | JSON 序列化器换成 Jackson 3 版本 | [Redis 实战](/cache/5_redis_practice) |
| Kafka | `spring-boot-starter-kafka` | `spring.kafka.*` | 新增 starter；JSON 序列化器换成 `JacksonJson*` | [Kafka](/messaging/2_kafka) |
| RabbitMQ | `spring-boot-starter-amqp` | `spring.rabbitmq.*` | 消息转换器换成 `JacksonJsonMessageConverter` | [RabbitMQ](/messaging/4_rabbitmq) |
| Elasticsearch | `spring-boot-starter-data-elasticsearch` | `spring.elasticsearch.*` | elasticsearch-java 9.x，底层改用 `Rest5Client` | [搜索数据库](/database/4_nosql/3_search_db) |
| MongoDB | `spring-boot-starter-data-mongodb` | `spring.mongodb.*` | 连接配置从 `spring.data.mongodb.*` 改名 | [文档数据库](/database/4_nosql/2_document_db) |

几条共性：

- **Jackson 3 是 Boot 4 的默认 JSON 库**，各项目的 Jackson 2 版序列化器都被标记为废弃，新旧格式的输出可能不同，升级时要考虑已写入的存量数据能否读回
- 版本全部由 Boot 依赖管理，不要自己写版本号
- 集成测试用 Testcontainers + `@ServiceConnection` 自动注入连接信息，见 [Spring Boot 测试](./13_testing)
- 密码一律用 `${ENV_VAR}` 占位，密钥管理见 [数据安全](/security/7_data_security)

---

## 二、Redis

### 1、连接配置

```yaml
spring:
  data:
    redis:
      host: localhost
      port: 6379
      password: ${REDIS_PASSWORD:}
      database: 0
      timeout: 2s                 # 命令超时，一定要设
      lettuce:
        pool:                     # 只有 classpath 上有 commons-pool2 时才生效
          max-active: 16
          max-idle: 8
          min-idle: 2
          max-wait: 1s
```

Boot 默认使用 Lettuce。Lettuce 的连接是线程安全的，默认所有线程**共享一个连接**，普通命令不需要连接池；只有阻塞命令（`BLPOP` 等）和事务（`MULTI`）需要独占连接，这时连接池才有意义。**连接池生效需要额外引入 `org.apache.commons:commons-pool2`**，否则上面的 `pool` 配置被静默忽略。

### 2、序列化（Jackson 3）

Boot 自动配置的 `RedisTemplate<Object, Object>` 使用 JDK 序列化，Redis 里看到的是不可读的字节；`StringRedisTemplate` 读写纯字符串。存对象时自定义模板：

```java
@Configuration
public class RedisConfig {

    @Bean
    public RedisTemplate<String, Object> redisTemplate(RedisConnectionFactory factory) {
        // 只允许反序列化本项目和 JDK 常用包下的类型，防止反序列化攻击
        PolymorphicTypeValidator validator = BasicPolymorphicTypeValidator.builder()
            .allowIfSubType("com.example.")
            .allowIfSubType("java.util.")
            .allowIfSubType("java.math.")
            .build();

        GenericJacksonJsonRedisSerializer json = GenericJacksonJsonRedisSerializer.builder()
            .enableDefaultTyping(validator)     // 写入类型信息，读回时还原为原类型
            .build();

        RedisTemplate<String, Object> tpl = new RedisTemplate<>();
        tpl.setConnectionFactory(factory);
        tpl.setKeySerializer(RedisSerializer.string());
        tpl.setHashKeySerializer(RedisSerializer.string());
        tpl.setValueSerializer(json);
        tpl.setHashValueSerializer(json);
        return tpl;
    }
}
```

`PolymorphicTypeValidator` 与 `BasicPolymorphicTypeValidator` 来自 `tools.jackson.databind.jsontype` 包。

| Spring Data Redis 4（Boot 4，Jackson 3） | Spring Data Redis 3（Boot 3，Jackson 2，已废弃） |
|-----------------------------------------|----------------------------------------------|
| `GenericJacksonJsonRedisSerializer` | `GenericJackson2JsonRedisSerializer` |
| `JacksonJsonRedisSerializer<T>` | `Jackson2JsonRedisSerializer<T>` |
| `JacksonHashMapper` | `Jackson2HashMapper` |

- **新的 `GenericJacksonJsonRedisSerializer` 默认不开启 default typing**，旧版默认开启；不开启时读回的对象是 `LinkedHashMap`，需要类型信息就像上面一样显式开启并配校验器
- 只存一种类型时，用 `new JacksonJsonRedisSerializer<>(OrderVO.class)` 建专用模板，不写类型信息，JSON 更干净，也没有多态反序列化风险
- 不要用 `enableUnsafeDefaultTyping()`，它允许反序列化任意类型，Redis 数据被篡改即可触发远程代码执行
- 升级时 Jackson 3 写出的 JSON 可能与旧格式不同。过渡期可以继续用已废弃的 `GenericJackson2JsonRedisSerializer` 读旧数据，或者给新格式的 key 换前缀，等旧 key 过期

### 3、常见坑

| 问题 | 原因 | 解决 |
|------|------|------|
| key 显示为乱码 | 默认模板用 JDK 序列化 | key 用 `RedisSerializer.string()`，或直接用 `StringRedisTemplate` |
| value 读回是 `LinkedHashMap` | 没有类型信息 | 按类型建专用模板，或开启 default typing 并配置校验器 |
| `pool` 配置不生效 | 缺少 `commons-pool2` | 引入依赖；普通命令场景其实不需要连接池 |
| 命令超时、连接卡住 | `KEYS`、大 key、`HGETALL` 大哈希等慢命令阻塞单线程的 Redis | 用 `SCAN` 替代 `KEYS`，拆分大 key，见 [Redis 实战](/cache/5_redis_practice) |

缓存注解（`@Cacheable`）的配置见 [Redis 实战](/cache/5_redis_practice)，分布式锁用 [Redisson](/cache/6_redisson)，不要用 `setIfAbsent` 手写，原因见 [分布式锁](/distributed/3_lock)。

---

## 三、Kafka

### 1、依赖与配置

```xml
<!-- Boot 4；Boot 3.x 直接引入 org.springframework.kafka:spring-kafka -->
<dependency>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-kafka</artifactId>
</dependency>
```

```yaml
spring:
  kafka:
    bootstrap-servers: localhost:9092
    producer:
      key-serializer: org.apache.kafka.common.serialization.StringSerializer
      value-serializer: org.springframework.kafka.support.serializer.JacksonJsonSerializer
      acks: all
    consumer:
      group-id: order-processor
      auto-offset-reset: earliest
      enable-auto-commit: false          # 由监听容器在处理成功后提交 offset
      key-deserializer: org.apache.kafka.common.serialization.StringDeserializer
      # 反序列化失败不会让消费者陷入死循环，而是交给错误处理器
      value-deserializer: org.springframework.kafka.support.serializer.ErrorHandlingDeserializer
      properties:
        spring.deserializer.value.delegate.class: org.springframework.kafka.support.serializer.JacksonJsonDeserializer
        spring.json.trusted.packages: "com.example.order.event"
    listener:
      ack-mode: record                   # 每条处理成功后提交
```

- Spring for Apache Kafka 4.0（Boot 4）中，Jackson 2 版的 `JsonSerializer` / `JsonDeserializer` / `JsonSerde` 被标记为待移除，换成 `JacksonJsonSerializer` / `JacksonJsonDeserializer` / `JacksonJsonSerde`；Boot 3.x 继续用前者
- `trusted.packages` 只写事件类所在的包，不要写 `*`
- 用 `ErrorHandlingDeserializer` 包一层：消息格式错误时，直接用 `JacksonJsonDeserializer` 会在每次 poll 时反复失败，分区永远卡住

### 2、生产者与消费者

```java
public record OrderEvent(String orderId, String status, Instant occurredAt) {}

@Slf4j
@Service
@RequiredArgsConstructor
public class OrderEventProducer {

    private final KafkaTemplate<String, OrderEvent> kafkaTemplate;

    public void send(OrderEvent event) {
        // key = orderId：同一订单的消息落到同一分区，保证分区内有序
        kafkaTemplate.send("order-events", event.orderId(), event)
            .whenComplete((result, ex) -> {
                if (ex != null) {
                    log.error("发送失败 orderId={}", event.orderId(), ex);
                }
            });
    }
}

@Slf4j
@Component
@RequiredArgsConstructor
public class OrderEventConsumer {

    private final OrderService orderService;

    @KafkaListener(topics = "order-events")
    public void handle(OrderEvent event) {
        // 抛出异常即交给 DefaultErrorHandler：退避重试，耗尽后发到死信 Topic
        orderService.onOrderEvent(event);
    }
}
```

**不要在监听方法里 catch 异常后只打日志**：offset 照常提交，消息就此丢失。也不要在默认的 `record` / `batch` 模式下声明 `Acknowledgment` 参数，它只在 `ack-mode: manual` / `manual_immediate` 下可用。

失败处理只需声明一个 `CommonErrorHandler` Bean（`DefaultErrorHandler` + `DeadLetterPublishingRecoverer`），Boot 会自动把它装配到监听容器工厂。重试策略、死信、幂等消费、Outbox 的完整写法见 [Kafka](/messaging/2_kafka)。

---

## 四、RabbitMQ

### 1、配置

```yaml
spring:
  rabbitmq:
    host: localhost
    port: 5672
    username: ${RABBIT_USER}
    password: ${RABBIT_PASSWORD}
    virtual-host: /
    publisher-confirm-type: correlated   # 发布确认：消息到达 Exchange
    publisher-returns: true              # 路由失败时回退
    template:
      mandatory: true
    listener:
      simple:
        acknowledge-mode: auto           # 方法正常返回即 ACK，抛异常则 NACK
        prefetch: 10
        default-requeue-rejected: false  # 拒绝的消息不重回队列，进入死信
        retry:
          enabled: true                  # 本地重试，耗尽后拒绝消息
          max-attempts: 3
          initial-interval: 1s
          multiplier: 2
```

### 2、声明与消息转换

```java
@Configuration
public class RabbitConfig {

    // Boot 会把唯一的 MessageConverter Bean 装配到 RabbitTemplate 与监听容器
    @Bean
    public MessageConverter messageConverter() {
        return new JacksonJsonMessageConverter();   // Spring AMQP 4.0；3.x 为 Jackson2JsonMessageConverter
    }

    @Bean
    public DirectExchange orderExchange() {
        return new DirectExchange("order.exchange");
    }

    @Bean
    public DirectExchange orderDeadLetterExchange() {
        return new DirectExchange("order.dlx");
    }

    @Bean
    public Queue orderQueue() {
        return QueueBuilder.durable("order.queue")
            .quorum()                                   // 仲裁队列，RabbitMQ 4.x 的推荐队列类型
            .deadLetterExchange("order.dlx")
            .deadLetterRoutingKey("order.dead")
            .build();
    }

    @Bean
    public Queue orderDeadQueue() {
        return QueueBuilder.durable("order.dead.queue").quorum().build();
    }

    @Bean
    public Binding orderBinding() {
        return BindingBuilder.bind(orderQueue()).to(orderExchange()).with("order.created");
    }

    @Bean
    public Binding orderDeadBinding() {
        return BindingBuilder.bind(orderDeadQueue()).to(orderDeadLetterExchange()).with("order.dead");
    }
}
```

**死信交换机和死信队列必须同样声明并绑定**，只在业务队列上写 `x-dead-letter-exchange` 而不声明交换机，被拒绝的消息会被静默丢弃。

### 3、生产者与消费者

```java
@Service
@RequiredArgsConstructor
public class OrderPublisher {

    private final RabbitTemplate rabbitTemplate;

    public void publish(OrderEvent event) {
        rabbitTemplate.convertAndSend("order.exchange", "order.created", event);
    }
}

@Component
@RequiredArgsConstructor
public class OrderConsumer {

    private final OrderService orderService;

    @RabbitListener(queues = "order.queue")
    public void consume(OrderEvent event) {
        // 抛异常：本地重试 3 次，仍失败则拒绝，进入 order.dead.queue
        orderService.onOrderEvent(event);
    }
}
```

自动 ACK + 重试 + 死信是推荐组合；需要手动 ACK、发布确认回调、延迟消息时见 [RabbitMQ](/messaging/4_rabbitmq)。

---

## 五、Elasticsearch

### 1、版本对应与配置

| Spring Boot | Spring Data Elasticsearch | Java 客户端 | 底层 HTTP 客户端 |
|-------------|--------------------------|-------------|-----------------|
| 4.x | 6.x | elasticsearch-java 9.x | `Rest5Client` |
| 3.x | 5.x | elasticsearch-java 8.x | 低级 `RestClient` |
| 2.7.x | 4.4 | `RestHighLevelClient`（已移除） | 低级 `RestClient` |

客户端主版本应与服务端主版本保持一致。Boot 4 自动配置 `Rest5Client` 与基于它的 `ElasticsearchClient`，原来的 `RestClientBuilderCustomizer` 换成 `Rest5ClientBuilderCustomizer`。

```yaml
spring:
  elasticsearch:
    uris: https://es.example.com:9200
    username: ${ES_USER}
    password: ${ES_PASSWORD}
    connection-timeout: 1s
    socket-timeout: 10s
```

### 2、Repository 与复杂查询

```java
@Getter
@Setter
@Document(indexName = "products")
public class Product {

    @Id
    private String id;

    @Field(type = FieldType.Text, analyzer = "ik_max_word", searchAnalyzer = "ik_smart")
    private String name;

    @Field(type = FieldType.Double)
    private Double price;
}

public interface ProductRepository extends ElasticsearchRepository<Product, String> {
    List<Product> findByNameContaining(String keyword);
}

@Service
@RequiredArgsConstructor
public class ProductSearchService {

    private final ElasticsearchOperations esOps;

    public SearchHits<Product> search(String keyword, double maxPrice) {
        Query query = NativeQuery.builder()
            .withQuery(q -> q.bool(b -> b
                .must(m -> m.match(mt -> mt.field("name").query(keyword)))
                // 8.15 起 range 查询按字段类型区分：数值用 number，日期用 date
                .filter(f -> f.range(r -> r.number(n -> n.field("price").lte(maxPrice))))))
            .withPageable(PageRequest.of(0, 20))
            .build();
        return esOps.search(query, Product.class);
    }
}
```

- `Query` 为 `org.springframework.data.elasticsearch.core.query.Query`，`NativeQuery` 位于 `org.springframework.data.elasticsearch.client.elc`
- `ik_max_word` / `ik_smart` 需要服务端安装 IK 分词插件，否则创建索引失败
- 生产环境建议关闭自动建索引，索引与 mapping 由脚本或索引模板管理，避免字段类型被自动推断错误

---

## 六、MongoDB

### 1、配置

```yaml
spring:
  mongodb:                               # Boot 4；3.x 为 spring.data.mongodb
    uri: mongodb://${MONGO_USER}:${MONGO_PASSWORD}@localhost:27017/shop?authSource=admin
    representation:
      uuid: standard                     # BSON binary subtype 4；旧数据按 subtype 3 存储时用 java-legacy
  data:
    mongodb:                             # Spring Data 专属配置仍在 spring.data.mongodb 下
      auto-index-creation: false
      representation:
        big-decimal: decimal128          # Spring Data MongoDB 5 的默认值；按字符串存储时聚合无法求和
```

Spring Data MongoDB 5（Boot 4）改变了 UUID 与 BigDecimal 的存储格式默认值（UUID 不再提供默认格式，BigDecimal 默认改为 Decimal128），升级时要显式配置并与存量数据保持一致，否则旧数据读不回来。

Boot 4 把连接相关的配置（`uri`、`host`、`port`、`database`、`username`、`password`、`ssl.*`）从 `spring.data.mongodb.*` 移到了 `spring.mongodb.*`；`auto-index-creation`、`field-naming-strategy`、`gridfs.*`、`repositories.type` 等 Spring Data 专属配置仍保留原前缀；健康检查开关改为 `management.health.mongodb.enabled`。

### 2、Repository 与聚合

```java
@Getter
@Setter
@Document(collection = "orders")         // org.springframework.data.mongodb.core.mapping.Document
public class OrderDoc {

    @Id
    private String id;
    private String userId;
    private BigDecimal totalAmount;
    private Instant createdAt;
}

public interface OrderDocRepository extends MongoRepository<OrderDoc, String> {
    List<OrderDoc> findByUserId(String userId);
    List<OrderDoc> findByCreatedAtBetween(Instant start, Instant end);
}

public record DailyRevenue(String id, BigDecimal revenue) {}   // id 对应分组键 _id，即日期

@Service
@RequiredArgsConstructor
public class OrderAnalyticsService {

    private final MongoTemplate mongoTemplate;

    public List<DailyRevenue> dailyRevenue(Instant start, Instant end) {
        Aggregation agg = Aggregation.newAggregation(
            Aggregation.match(Criteria.where("createdAt").gte(start).lt(end)),
            Aggregation.project("totalAmount")
                .and(DateOperators.DateToString.dateOf("createdAt")
                    .toString("%Y-%m-%d")
                    .withTimezone(DateOperators.Timezone.valueOf("Asia/Shanghai")))   // 默认按 UTC 切日
                .as("day"),
            Aggregation.group("day").sum("totalAmount").as("revenue"),
            Aggregation.sort(Sort.by("_id"))
        );
        return mongoTemplate.aggregate(agg, OrderDoc.class, DailyRevenue.class).getMappedResults();
    }
}
```

- 实体上的 `@Document` 是 Spring Data 的注解，不要与驱动的 `org.bson.Document` 混在同一个文件里，否则必须写全限定名
- 关闭 `auto-index-creation` 后，索引由运维脚本或 `MongoTemplate#indexOps` 在发布时创建，避免应用启动时在大集合上建索引

---

## 小结

- 每个中间件在 Boot 4 都有对应的 `spring-boot-starter-*`，Kafka 新增了 `spring-boot-starter-kafka`；版本交给 Boot 管理
- Jackson 3 是默认 JSON 库：Redis 用 `GenericJacksonJsonRedisSerializer` / `JacksonJsonRedisSerializer`，Kafka 用 `JacksonJsonSerializer` / `JacksonJsonDeserializer`，RabbitMQ 用 `JacksonJsonMessageConverter`；Jackson 2 版本均已废弃
- Redis：新序列化器默认不写类型信息，需要时配合 `PolymorphicTypeValidator` 开启；连接池依赖 `commons-pool2`，普通命令并不需要池
- Kafka：用 `ErrorHandlingDeserializer` 包装反序列化器，异常交给 `DefaultErrorHandler` 与死信 Topic，不要在监听方法里吞异常
- RabbitMQ：自动 ACK + 本地重试 + 死信，死信交换机与队列必须声明
- Elasticsearch：Boot 4 使用 elasticsearch-java 9.x 与 `Rest5Client`，range 查询按字段类型写 `number` / `date`
- MongoDB：Boot 4 连接配置改为 `spring.mongodb.*`，Spring Data 专属配置仍在 `spring.data.mongodb.*`；按日聚合注意时区

> 下一篇：[配置管理](./6_config) —— 配置源优先级、Profile、属性绑定与配置加密。
