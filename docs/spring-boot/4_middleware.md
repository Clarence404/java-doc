# 中间件集成

> 本章聚焦 Spring Boot 与各中间件的**集成方式**（Starter 引入 / 配置项 / 常见坑），
> 中间件本身的原理详见对应模块：[缓存](/cache/0_redis_base) / [消息队列](/messaging/0_mq) / [数据库](/database/1_mysql/0_overview)

---

## 一、Redis 集成

```xml
<dependency>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-data-redis</artifactId>
</dependency>
```

### 1.1 连接池配置

```yaml
spring:
  data:
    redis:
      host: localhost
      port: 6379
      password: ${REDIS_PASSWORD:}
      database: 0
      lettuce:
        pool:
          max-active: 16
          max-idle: 8
          min-idle: 2
          max-wait: 2000ms
```

### 1.2 RedisTemplate 序列化配置

默认 `RedisTemplate<Object, Object>` 使用 JDK 序列化，key 会出现乱码。**推荐统一配置 JSON 序列化：**

```java
@Configuration
public class RedisConfig {

    @Bean
    public RedisTemplate<String, Object> redisTemplate(RedisConnectionFactory factory) {
        RedisTemplate<String, Object> tpl = new RedisTemplate<>();
        tpl.setConnectionFactory(factory);

        Jackson2JsonRedisSerializer<Object> jsonSerializer =
            new Jackson2JsonRedisSerializer<>(Object.class);
        StringRedisSerializer strSerializer = new StringRedisSerializer();

        tpl.setKeySerializer(strSerializer);        // key: String
        tpl.setHashKeySerializer(strSerializer);
        tpl.setValueSerializer(jsonSerializer);     // value: JSON
        tpl.setHashValueSerializer(jsonSerializer);
        tpl.afterPropertiesSet();
        return tpl;
    }
}
```

### 1.3 常用操作

```java
@Service
@RequiredArgsConstructor
public class CacheService {

    private final RedisTemplate<String, Object> redisTemplate;
    private final StringRedisTemplate stringRedisTemplate;  // 纯 String 场景

    public void set(String key, Object value, Duration ttl) {
        redisTemplate.opsForValue().set(key, value, ttl);
    }

    public Object get(String key) {
        return redisTemplate.opsForValue().get(key);
    }

    // 分布式锁（简单场景）
    public boolean tryLock(String lockKey, String requestId, Duration expire) {
        return Boolean.TRUE.equals(
            redisTemplate.opsForValue().setIfAbsent(lockKey, requestId, expire)
        );
    }
}
```

### 1.4 常见坑

| 问题 | 原因 | 解决 |
|------|------|------|
| key 显示乱码 | 默认 JDK 序列化 | 改用 `StringRedisSerializer` |
| value 反序列化失败 | 类型信息丢失 | Jackson 开启 `activateDefaultTyping` 或用泛型 |
| 连接池耗尽 | 未释放连接 | 用 `try-with-resources` / 检查 Lettuce 配置 |

---

## 二、Kafka 集成

```xml
<dependency>
    <groupId>org.springframework.kafka</groupId>
    <artifactId>spring-kafka</artifactId>
</dependency>
```

### 2.1 配置

```yaml
spring:
  kafka:
    bootstrap-servers: localhost:9092
    producer:
      key-serializer: org.apache.kafka.common.serialization.StringSerializer
      value-serializer: org.springframework.kafka.support.serializer.JsonSerializer
      acks: all
      retries: 3
    consumer:
      group-id: my-service-group
      key-deserializer: org.apache.kafka.common.serialization.StringDeserializer
      value-deserializer: org.springframework.kafka.support.serializer.JsonDeserializer
      auto-offset-reset: earliest
      properties:
        spring.json.trusted.packages: "com.example.*"
```

### 2.2 生产者

```java
@Service
@RequiredArgsConstructor
public class EventProducer {

    private final KafkaTemplate<String, OrderEvent> kafkaTemplate;

    public void sendOrderEvent(OrderEvent event) {
        kafkaTemplate.send("order-events", event.orderId(), event)
            .whenComplete((result, ex) -> {
                if (ex != null) {
                    log.error("发送失败: {}", ex.getMessage());
                } else {
                    log.info("发送成功 offset={}", result.getRecordMetadata().offset());
                }
            });
    }
}
```

### 2.3 消费者

```java
@Component
public class OrderEventConsumer {

    @KafkaListener(topics = "order-events", groupId = "order-processor")
    public void handle(OrderEvent event,
                       @Header(KafkaHeaders.RECEIVED_PARTITION) int partition,
                       Acknowledgment ack) {
        try {
            processOrder(event);
            ack.acknowledge();   // 手动提交 offset
        } catch (Exception e) {
            // 发送到死信队列或记录日志
            log.error("处理失败: orderId={}", event.orderId(), e);
        }
    }
}
```

---

## 三、RabbitMQ 集成

```xml
<dependency>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-amqp</artifactId>
</dependency>
```

### 3.1 配置

```yaml
spring:
  rabbitmq:
    host: localhost
    port: 5672
    username: guest
    password: guest
    virtual-host: /
    listener:
      simple:
        acknowledge-mode: manual   # 手动确认
        prefetch: 10               # 每次拉取 10 条
```

### 3.2 声明 Exchange + Queue

```java
@Configuration
public class RabbitConfig {

    @Bean
    public DirectExchange orderExchange() {
        return new DirectExchange("order.exchange");
    }

    @Bean
    public Queue orderQueue() {
        return QueueBuilder.durable("order.queue")
            .withArgument("x-dead-letter-exchange", "dlx.exchange")  // 死信队列
            .build();
    }

    @Bean
    public Binding orderBinding(Queue orderQueue, DirectExchange orderExchange) {
        return BindingBuilder.bind(orderQueue)
            .to(orderExchange)
            .with("order.created");
    }
}
```

### 3.3 生产者 / 消费者

```java
// 生产者
@Service
@RequiredArgsConstructor
public class OrderPublisher {
    private final RabbitTemplate rabbitTemplate;

    public void publish(OrderEvent event) {
        rabbitTemplate.convertAndSend("order.exchange", "order.created", event);
    }
}

// 消费者
@Component
public class OrderConsumer {

    @RabbitListener(queues = "order.queue")
    public void consume(OrderEvent event, Channel channel,
                        @Header(AmqpHeaders.DELIVERY_TAG) long tag) throws IOException {
        try {
            handleOrder(event);
            channel.basicAck(tag, false);       // 确认
        } catch (Exception e) {
            channel.basicNack(tag, false, false); // 拒绝，进死信队列
        }
    }
}
```

---

## 四、Elasticsearch 集成

```xml
<dependency>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-data-elasticsearch</artifactId>
</dependency>
```

### 4.1 配置

```yaml
spring:
  elasticsearch:
    uris: http://localhost:9200
    username: elastic
    password: ${ES_PASSWORD}
```

### 4.2 Repository + Template

```java
// 文档实体
@Document(indexName = "products")
public class Product {
    @Id
    private String id;

    @Field(type = FieldType.Text, analyzer = "ik_max_word")
    private String name;

    @Field(type = FieldType.Double)
    private Double price;
}

// Repository 接口（基础 CRUD）
public interface ProductRepository extends ElasticsearchRepository<Product, String> {
    List<Product> findByNameContaining(String keyword);
}

// ElasticsearchOperations（复杂查询）
@Service
@RequiredArgsConstructor
public class ProductSearchService {

    private final ElasticsearchOperations esOps;

    public SearchHits<Product> search(String keyword, double maxPrice) {
        Query query = NativeQuery.builder()
            .withQuery(q -> q.bool(b -> b
                .must(m -> m.match(mt -> mt.field("name").query(keyword)))
                .filter(f -> f.range(r -> r.field("price").lte(JsonData.of(maxPrice))))
            ))
            .withPageable(PageRequest.of(0, 20))
            .build();
        return esOps.search(query, Product.class);
    }
}
```

### 4.3 版本兼容

| Spring Boot | Elasticsearch 客户端 | ES 服务端 |
|-------------|---------------------|----------|
| 3.x | elasticsearch-java 8.x | ES 8.x |
| 2.7.x | RestHighLevelClient | ES 7.x |

> Boot 3.x 已移除 `RestHighLevelClient`，迁移到 `ElasticsearchOperations` / `ElasticsearchClient`。

---

## 五、MongoDB 集成

```xml
<dependency>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-data-mongodb</artifactId>
</dependency>
```

### 5.1 配置

```yaml
spring:
  data:
    mongodb:
      uri: mongodb://user:pass@localhost:27017/mydb?authSource=admin
```

### 5.2 Repository + Template

```java
@Document(collection = "orders")
public class Order {
    @Id
    private String id;
    private String userId;
    private List<OrderItem> items;
    private LocalDateTime createdAt;
}

// 基础 CRUD
public interface OrderRepository extends MongoRepository<Order, String> {
    List<Order> findByUserId(String userId);
    List<Order> findByCreatedAtBetween(LocalDateTime start, LocalDateTime end);
}

// MongoTemplate（聚合 / 复杂查询）
@Service
@RequiredArgsConstructor
public class OrderAnalyticsService {

    private final MongoTemplate mongoTemplate;

    public List<Document> dailyRevenue(LocalDateTime start, LocalDateTime end) {
        Aggregation agg = Aggregation.newAggregation(
            Aggregation.match(Criteria.where("createdAt").gte(start).lte(end)),
            Aggregation.group("$dateToString.date").sum("totalAmount").as("revenue"),
            Aggregation.sort(Sort.by("_id"))
        );
        return mongoTemplate.aggregate(agg, "orders", Document.class).getMappedResults();
    }
}
```
