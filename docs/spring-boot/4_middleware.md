# 中间件集成

> 本章聚焦 Spring Boot 与各中间件的**集成方式**（Starter 引入 / 配置项 / 常见坑），
> 中间件本身的原理详见对应模块：[缓存](/cache/0_redis_base) / [消息队列](/messaging/0_mq) / [数据库](/database/0_mysql)

## 一、Redis 集成

> 依赖：`spring-boot-starter-data-redis`

- `RedisTemplate` vs `StringRedisTemplate`
- 序列化配置（`Jackson2JsonRedisSerializer`）
- 连接池配置（Lettuce / Jedis）
- 常见坑：key 乱码、序列化不一致

## 二、Kafka / RabbitMQ 集成

> 依赖：`spring-kafka` / `spring-boot-starter-amqp`

- `@KafkaListener` / `@RabbitListener` 消费者配置
- 生产者 `KafkaTemplate` / `RabbitTemplate`
- 消息确认机制配置

## 三、Elasticsearch 集成

> 依赖：`spring-boot-starter-data-elasticsearch`

- `ElasticsearchRepository` 基础用法
- `ElasticsearchRestTemplate` 复杂查询
- 版本兼容问题注意事项

## 四、MongoDB 集成

> 依赖：`spring-boot-starter-data-mongodb`

- `MongoRepository` 基础用法
- `MongoTemplate` 复杂操作

> [!warning]
> 待补充
