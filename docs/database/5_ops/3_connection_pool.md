# 数据库连接池

> 参考资料：
> * HikariCP：[https://github.com/brettwooldridge/HikariCP](https://github.com/brettwooldridge/HikariCP)
> * Druid：[https://github.com/alibaba/druid](https://github.com/alibaba/druid)

---

## 一、为什么需要连接池

数据库连接的建立代价极高（TCP 握手 + 身份认证 + 协议协商），每次请求新建连接会带来数十毫秒的额外延迟并消耗大量资源。连接池通过**预先创建并复用连接**解决此问题：

| 问题 | 连接池方案 |
|------|----------|
| 连接建立慢（~50ms） | 预热连接，请求直接从池中借取 |
| 连接资源泄漏 | 超时强制回收，连接泄漏检测 |
| 并发峰值压垮数据库 | 最大连接数限制，超限排队等待 |
| 连接异常失效 | 健康检查，自动剔除无效连接 |

---

## 二、HikariCP

Spring Boot 2.x+ 默认连接池，以**极低资源占用**和**高吞吐**著称（阿里巴巴等头部公司生产首选）。

### 核心参数

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `maximumPoolSize` | 10 | 最大连接数（含 idle + active）|
| `minimumIdle` | = maximumPoolSize | 最小空闲连接数，建议与 max 相同（固定池） |
| `connectionTimeout` | 30000ms | 等待获取连接的超时时间，超时抛 SQLException |
| `idleTimeout` | 600000ms | 空闲连接在池中存活最长时间（minimumIdle < maximumPoolSize 时生效）|
| `maxLifetime` | 1800000ms | 连接最长存活时间（建议低于数据库 wait_timeout 1分钟）|
| `keepaliveTime` | 0（禁用）| 周期性发送 keepalive 查询，防止连接被防火墙/代理断开 |
| `connectionTestQuery` | 无 | 连接验证 SQL（JDBC4 驱动无需设置，自动使用 `isValid()`）|

### Spring Boot 配置

```yaml
spring:
  datasource:
    url: jdbc:mysql://localhost:3306/mydb?useSSL=false&serverTimezone=Asia/Shanghai
    username: root
    password: secret
    driver-class-name: com.mysql.cj.jdbc.Driver
    hikari:
      maximum-pool-size: 20          # CPU核数 * 2 + 有效磁盘数（经验公式）
      minimum-idle: 20               # 与 max 相同 → 固定池，避免连接频繁回收
      connection-timeout: 3000       # 3秒内获取不到连接直接失败（避免线程堆积）
      max-lifetime: 1800000          # 30分钟，需低于 MySQL wait_timeout（默认8小时）
      keepalive-time: 60000          # 每60秒发一次 keepalive，防中间件断开
      pool-name: OrderServicePool    # 连接池命名，便于监控区分
```

### 监控（Micrometer + Actuator）

HikariCP 原生集成 Micrometer，无需额外配置：

```yaml
management:
  endpoints:
    web:
      exposure:
        include: health,metrics
```

```bash
# 查询连接池指标
GET /actuator/metrics/hikaricp.connections.active
GET /actuator/metrics/hikaricp.connections.pending   # 等待获取连接的请求数，>0 说明池不够用
GET /actuator/metrics/hikaricp.connections.timeout   # 超时次数，生产需告警
```

### 连接数调优经验

```
# 经验公式（PostgreSQL wiki / HikariCP 官方推荐）
maximumPoolSize = CPU核数 * 2 + 有效磁盘数

# 实际调整依据（取较小值）：
# 1. 数据库服务端最大连接数：SHOW VARIABLES LIKE 'max_connections'
# 2. 应用实例数 × 单实例池大小 不超过数据库 max_connections 的 80%
#    例：20个服务实例，每实例 max=20 → 总连接400，需数据库 max_connections ≥ 500
```

---

## 三、Druid

阿里巴巴开源，在高性能连接池基础上增加了**监控统计、SQL 解析防注入、慢 SQL 报警**等企业级能力。

### 核心优势

| 能力 | 说明 |
|------|------|
| **内置监控** | Web 控制台实时查看 SQL 执行统计、连接池状态 |
| **SQL 防火墙** | 拦截 SQL 注入攻击，黑名单过滤危险操作 |
| **慢 SQL 日志** | 记录超阈值的慢查询，辅助性能分析 |
| **Filters** | 插件化扩展：stat（统计）/ wall（防注入）/ log4j2（日志）|

### Spring Boot 配置

```xml
<dependency>
    <groupId>com.alibaba</groupId>
    <artifactId>druid-spring-boot-starter</artifactId>
    <version>1.2.21</version>
</dependency>
```

```yaml
spring:
  datasource:
    type: com.alibaba.druid.pool.DruidDataSource
    url: jdbc:mysql://localhost:3306/mydb
    username: root
    password: secret
    druid:
      initial-size: 5           # 初始化连接数
      min-idle: 10              # 最小空闲连接数
      max-active: 20            # 最大活跃连接数
      max-wait: 3000            # 获取连接等待超时（ms）
      time-between-eviction-runs-millis: 60000   # 检测空闲连接间隔（ms）
      min-evictable-idle-time-millis: 300000      # 连接在池中最小存活时间
      validation-query: SELECT 1                  # 连接验证 SQL
      test-while-idle: true     # 空闲时验证连接有效性
      test-on-borrow: false     # 借出时不验证（影响性能，生产关闭）
      filters: stat,wall        # 开启统计和防火墙 Filter
      # 慢 SQL 日志
      connection-properties: druid.stat.mergeSql=true;druid.stat.slowSqlMillis=1000
      # 监控页面
      stat-view-servlet:
        enabled: true
        url-pattern: /druid/*
        login-username: admin
        login-password: admin123
        allow: 127.0.0.1       # 仅允许本机访问（生产环境应限 IP）
        deny: ""
      web-stat-filter:
        enabled: true
        url-pattern: /*
        exclusions: "*.js,*.gif,*.jpg,*.png,*.css,/druid/*"
```

### 监控页面

访问 `http://localhost:8080/druid/` 可查看：
- **数据源**：连接池状态（活跃数、空闲数、等待数）
- **SQL 监控**：执行次数、平均耗时、最慢 SQL
- **URI 监控**：接口维度的 SQL 调用统计
- **Session 监控**：用户会话信息

---

## 四、选型对比

| 维度 | HikariCP | Druid |
|------|:--------:|:-----:|
| **性能** | ★★★★★（业界最快）| ★★★★☆ |
| **监控能力** | 基础（Micrometer 集成）| ★★★★★（内置 Web 控制台）|
| **SQL 防火墙** | 无 | 支持（wall filter）|
| **慢 SQL 统计** | 无 | 支持 |
| **配置复杂度** | 低 | 中 |
| **Spring Boot 默认** | 是（2.x+）| 否（需手动引入）|
| **适用场景** | 追求极致性能、监控外置（Prometheus）| 需要内置监控、运维可视化、SQL 审计 |

**选型建议：**
- 已有 Prometheus + Grafana 监控体系 → **HikariCP**（轻量 + 快）
- 需要 DBA 实时查看 SQL 统计、慢查询 → **Druid**（监控开箱即用）

---

## 五、连接泄漏排查

连接泄漏（borrowing a connection but never returning）会导致池耗尽，新请求超时。

### HikariCP 开启泄漏检测

```yaml
hikari:
  leak-detection-threshold: 5000  # 连接借出超过5秒未归还，打印警告堆栈
```

日志示例：
```
WARN  HikariPool - Connection leak detection triggered for connection ...,
      stack trace follows: com.example.OrderService.findOrder(OrderService.java:42)
```

### Druid 泄漏检测

```yaml
druid:
  remove-abandoned: true          # 开启泄漏连接回收
  remove-abandoned-timeout: 30    # 超过30秒认为泄漏
  log-abandoned: true             # 打印泄漏连接的堆栈
```

### 常见泄漏原因

| 原因 | 修复方式 |
|------|---------|
| 异常路径未关闭 Connection | 使用 `try-with-resources` 确保关闭 |
| 手动管理事务未提交/回滚 | 交由 Spring `@Transactional` 管理 |
| 长事务 / 事务中做外部调用 | 缩短事务范围，外部调用移到事务外 |
| 测试代码未清理 | 测试用 `@Transactional` + 回滚 |

---

## 六、常见问题

### 连接池耗尽（wait timeout）

```
原因：活跃连接数达到 maximumPoolSize，新请求等待超过 connectionTimeout

排查步骤：
1. 查 /actuator/metrics/hikaricp.connections.pending → 是否持续 > 0
2. 查慢查询：是否有长时间持有连接的 SQL
3. 查线程 Dump：是否有线程阻塞在数据库调用
4. 评估是否需要扩大 maximumPoolSize 或拆分数据源
```

### 连接频繁断开（Communications link failure）

```
原因：数据库 wait_timeout 到期强制关闭空闲连接，池中连接已失效

解决：
- HikariCP：设置 maxLifetime < wait_timeout，开启 keepaliveTime
- Druid：开启 testWhileIdle + keepAlive: true
- MySQL：SHOW VARIABLES LIKE 'wait_timeout'（默认28800s = 8h）
```

### 多数据源配置

```java
@Configuration
public class DataSourceConfig {

    @Bean
    @ConfigurationProperties("spring.datasource.master")
    public DataSource masterDataSource() {
        return DataSourceBuilder.create().build();
    }

    @Bean
    @ConfigurationProperties("spring.datasource.replica")
    public DataSource replicaDataSource() {
        return DataSourceBuilder.create().build();
    }

    @Bean
    @Primary
    public DataSource routingDataSource(
            @Qualifier("masterDataSource") DataSource master,
            @Qualifier("replicaDataSource") DataSource replica) {
        Map<Object, Object> map = new HashMap<>();
        map.put("master", master);
        map.put("replica", replica);
        AbstractRoutingDataSource routing = new ReadWriteRoutingDataSource();
        routing.setDefaultTargetDataSource(master);
        routing.setTargetDataSources(map);
        return routing;
    }
}
```
