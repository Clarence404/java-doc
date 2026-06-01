# Spring Cache 抽象

> 参考资料：
> * Spring 官方文档 - Cache：[https://docs.spring.io/spring-framework/reference/integration/cache.html](https://docs.spring.io/spring-framework/reference/integration/cache.html)
> * Spring Cache + Redis：[https://www.baeldung.com/spring-cache-tutorial](https://www.baeldung.com/spring-cache-tutorial)

## 一、核心注解

| 注解 | 作用 |
|------|------|
| `@Cacheable` | 查询时先查缓存，缓存未命中才执行方法，结果存入缓存 |
| `@CachePut` | 每次都执行方法，结果更新到缓存（用于更新操作） |
| `@CacheEvict` | 执行后清除缓存（用于删除操作） |
| `@Caching` | 组合多个缓存操作 |
| `@EnableCaching` | 启用缓存功能（启动类或配置类上） |

```java
@Cacheable(value = "users", key = "#id", unless = "#result == null")
public User getById(Long id) { ... }

@CacheEvict(value = "users", key = "#id")
public void deleteById(Long id) { ... }
```

## 二、接入 Redis

```yaml
spring:
  cache:
    type: redis
    redis:
      time-to-live: 3600000  # 过期时间 ms
```

## 三、接入 Caffeine（本地缓存）

```yaml
spring:
  cache:
    type: caffeine
    caffeine:
      spec: maximumSize=1000,expireAfterWrite=600s
```

## 四、两级缓存架构

本地缓存（Caffeine）+ 分布式缓存（Redis）组合，兼顾性能与一致性。

> 详见：[两级缓存架构](/cache/0_redis_base)

> [!warning]
> 待补充
