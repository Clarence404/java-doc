# 数据库中间件

## 一、ShardingSphere 概述

Apache ShardingSphere 是开源的分布式数据库中间件生态，核心功能：
- **分库分表**：水平拆分，突破单库性能瓶颈
- **读写分离**：主写从读，提升读性能
- **数据加密**：字段级透明加密
- **影子库**：压测流量隔离

---

## 二、两种接入形态

| 特性 | Sharding-JDBC | ShardingSphere-Proxy |
|------|:------------:|:-------------------:|
| 接入方式 | 应用内 JAR，增强 JDBC | 独立部署数据库代理进程 |
| 协议 | Java JDBC | MySQL / PostgreSQL 协议 |
| 性能损耗 | 极低（无额外网络跳转）| 有额外一跳 |
| 语言限制 | 仅 Java | 任意语言 |
| 运维复杂度 | 低（随应用部署）| 中（需独立运维进程）|
| DBA 管控 | ❌ 分散在各应用中 | ✅ 统一管控入口 |
| 适用场景 | Java 微服务 | 多语言团队、统一管控 |

---

## 三、Sharding-JDBC 分库分表配置

### 场景：2 库 × 4 表（t_order_0~3，每库各 4 张）

```yaml
# application.yml（Spring Boot）
spring:
  shardingsphere:
    datasource:
      names: ds0, ds1
      ds0:
        type: com.zaxxer.hikari.HikariDataSource
        driver-class-name: com.mysql.cj.jdbc.Driver
        jdbc-url: jdbc:mysql://db0:3306/orders?serverTimezone=Asia/Shanghai
        username: root
        password: xxx
      ds1:
        jdbc-url: jdbc:mysql://db1:3306/orders?serverTimezone=Asia/Shanghai
        username: root
        password: xxx

    rules:
      sharding:
        tables:
          t_order:
            # 物理节点：ds0.t_order_0, ds0.t_order_1 ... ds1.t_order_3
            actual-data-nodes: ds$->{0..1}.t_order_$->{0..3}
            database-strategy:
              standard:
                sharding-column: user_id
                sharding-algorithm-name: db-inline
            table-strategy:
              standard:
                sharding-column: order_id
                sharding-algorithm-name: table-inline
            key-generate-strategy:
              column: order_id
              key-generator-name: snowflake

        sharding-algorithms:
          db-inline:
            type: INLINE
            props:
              algorithm-expression: ds$->{user_id % 2}    # user_id 取模选库
          table-inline:
            type: INLINE
            props:
              algorithm-expression: t_order_$->{order_id % 4}  # order_id 取模选表

        key-generators:
          snowflake:
            type: SNOWFLAKE

    props:
      sql-show: true    # 打印路由后的真实 SQL（开发调试用）
```

### 绑定表（避免跨分片 JOIN）

```yaml
# t_order 和 t_order_item 使用相同分片键 order_id，保证在同一分片
sharding:
  binding-tables:
    - t_order, t_order_item
```

### 广播表（字典表全量同步到所有分片）

```yaml
sharding:
  broadcast-tables:
    - t_dict_status
    - t_dict_category
```

---

## 四、读写分离配置

```yaml
rules:
  readwrite-splitting:
    data-sources:
      rw_ds:
        static-strategy:
          write-data-source-name: primary_ds
          read-data-source-names:
            - replica_ds_0
            - replica_ds_1
        load-balancer-name: round_robin    # 读请求轮询
    load-balancers:
      round_robin:
        type: ROUND_ROBIN
```

**强制走主库**（写完立即读，避免主从延迟）：

```java
// Hint 方式强制路由到主库
try (HintManager hintManager = HintManager.getInstance()) {
    hintManager.setWriteRouteOnly();
    // 此处查询强制走主库
    return orderMapper.selectById(orderId);
}
```

---

## 五、常用分片算法

| 算法类型 | type | 特点 | 示例 |
|---------|------|------|------|
| 行表达式 | `INLINE` | Groovy 表达式，灵活 | `ds$->{user_id % 2}` |
| 哈希取模 | `MOD` | 均匀分布 | — |
| 时间范围 | `INTERVAL` | 按时间间隔自动分表 | 按月/季度建表 |
| 范围 | `RANGE` | 按数值范围路由 | — |
| 复合 | `COMPLEX` | 多列联合分片 | — |
| Hint | `HINT` | 强制路由，不依赖分片列 | 特殊路由场景 |

---

## 六、分布式主键策略

| 类型 | 特点 | 推荐场景 |
|------|------|---------|
| **Snowflake**（默认）| 64位，时间戳+机器ID+序列，趋势递增 | 大多数场景 |
| UUID | 128位，全局唯一，无序 | 不要求有序时 |
| 自定义 | 实现 `KeyGenerateAlgorithm` 接口 | 特殊需求 |

Snowflake 结构：
```
63         22       12      0
|  时间戳(41位) | 机器ID(10位) | 序列(12位) |
```

---

## 七、分库分表核心问题

### 1、分片键选择

| 原则 | 说明 |
|------|------|
| 散列均匀 | 避免数据热点（如不要用时间戳做分片键）|
| 查询必带 | 核心查询 WHERE 条件必须包含分片键，否则全路由 |
| 不可变 | 分片键一旦写入不能修改（改了需数据迁移）|
| 业务语义 | 优先选 user_id、tenant_id 等业务核心维度 |

### 2、跨分片查询

```sql
-- 跨分片 ORDER BY + LIMIT：ShardingSphere 会在每个分片各取 N 条，内存合并后再取 TOP N
-- 性能差，分片越多越慢
SELECT * FROM t_order ORDER BY created_at DESC LIMIT 10000, 10;  -- ❌ 深分页跨分片

-- 解决方案：游标翻页，不用 OFFSET
SELECT * FROM t_order WHERE id > :last_id ORDER BY id LIMIT 10;  -- ✅
```

### 3、分布式事务

```java
// 集成 Seata AT 模式
@ShardingTransactionType(TransactionType.BASE)  // Seata 最终一致性
@Transactional
public void placeOrder(OrderDTO dto) {
    orderMapper.insert(dto.toOrder());           // 路由到订单分片
    inventoryMapper.decreaseStock(dto.getSkuId()); // 路由到库存库
    // 由 Seata 协调跨分片事务
}
```

### 4、数据迁移（5.x 内置工具）

```sql
-- ShardingSphere DistSQL
-- 创建迁移作业
MIGRATE TABLE ds.t_order INTO sharding_db.t_order;

-- 查看进度
SHOW MIGRATION STATUS;

-- 数据校验（全量 + 增量一致性校验）
CHECK MIGRATION JOB 'job_id';

-- 切流
COMMIT MIGRATION 'job_id';
```

---

## 八、选型建议

| 场景 | 推荐方案 |
|------|---------|
| Java 应用，分片逻辑简单 | Sharding-JDBC（低延迟，零运维）|
| 多语言团队，DBA 统一管控 | ShardingSphere-Proxy |
| 数据量 < 5000 万，单库可承受 | 先优化索引和缓存，暂不分库分表 |
| 需要强 ACID + 水平扩展 | TiDB / OceanBase（替代分库分表中间件）|
| 需要读写分离 + 分库分表 | ShardingSphere（两者皆支持）|
