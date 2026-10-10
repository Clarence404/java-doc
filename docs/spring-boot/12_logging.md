---
description: SLF4J 门面与桥接、Boot 日志配置、结构化日志、异步 Appender、MDC 与 traceId、滚动保留
---

# 日志

> 前置阅读：[配置管理](./6_config)

日志是应用排障的第一手资料。本篇讲应用侧的 SLF4J 门面、实现与桥接器，Spring Boot 中的级别、文件、Profile 与结构化 JSON 配置，异步日志取舍、traceId 在线程池与响应式链路中的传递，以及性能与安全上的常见坑。

---

## 一、门面、实现与桥接

### 1、整体链路

![Spring Boot 日志链路：门面、实现、Appender 与桥接](../assets/spring-boot/logging-architecture.svg)

| 角色 | 代表 | 说明 |
|------|------|------|
| 门面（API） | SLF4J | 业务代码只依赖 `org.slf4j.Logger`，不关心底层实现 |
| 实现（Provider） | Logback（Boot 默认）、Log4j2 | 真正负责级别判断、格式化、输出；**运行时只能有一个** |
| 桥接器 | `jul-to-slf4j`、`log4j-to-slf4j` | 把三方库使用的其他日志 API 转发到 SLF4J，统一由一个实现输出 |
| Appender | Console、RollingFile、Async | 决定日志写到哪里；Encoder / Layout 决定写成什么格式 |

Spring Boot 4.0 的两个日志 Starter 依赖如下（取自 4.0.0 源码）：

| Starter | 依赖 | 用途 |
|---------|------|------|
| `spring-boot-starter-logging`（默认，随 web 等 Starter 引入） | `logback-classic`、`log4j-to-slf4j`、`jul-to-slf4j` | Logback 实现 + 把 Log4j API、JUL 桥接到 SLF4J |
| `spring-boot-starter-log4j2` | `log4j-slf4j2-impl`、`log4j-core`、`log4j-jul` | Log4j2 作为 SLF4J 的实现 |

至于 Commons Logging（JCL）：Spring Framework 7.0 移除了 `spring-jcl` 模块，改为依赖 Apache Commons Logging 1.3，它能自动探测 Log4j API / SLF4J 并转发，不再需要 `jcl-over-slf4j` 桥接。

### 2、SLF4J 2.x 的 Provider 机制

- SLF4J 2.x 使用 **`ServiceLoader`** 查找 Provider（`META-INF/services/org.slf4j.spi.SLF4JServiceProvider`），1.7 时代的 `StaticLoggerBinder` 静态绑定已不再生效
- 找不到 Provider：输出 `No SLF4J providers were found` 警告，退化为 NOP Logger，**日志全部静默丢失**
- 只找到面向 1.7 的旧 binding（如老版本 `slf4j-log4j12`）：SLF4J 2.x 会列出它们然后**忽略**，效果等同于没有 Provider
- 找到多个 Provider：输出警告并任选其一，**选中哪个不可控**
- 2.0.9 起可用系统属性 `-Dslf4j.provider=<Provider 全类名>` 显式指定，跳过 ServiceLoader 扫描

### 3、切换到 Log4j2 与排除冲突

切换实现时必须**排除默认的 Logback**，否则类路径上会同时存在两个 Provider：

```xml
<dependency>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-webmvc</artifactId>   <!-- Boot 3.x 为 spring-boot-starter-web -->
    <exclusions>
        <exclusion>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-logging</artifactId>
        </exclusion>
    </exclusions>
</dependency>
<dependency>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-log4j2</artifactId>
</dependency>
```

排查冲突的常用手段：

- `mvn dependency:tree -Dincludes=org.slf4j,ch.qos.logback,org.apache.logging.log4j` 找出谁带进了第二个实现
- **桥接器与方向相反的实现适配器不能共存**：`log4j-to-slf4j`（Log4j API → SLF4J）与 `log4j-slf4j2-impl`（SLF4J → Log4j）同时存在会形成循环；`jul-to-slf4j` 与 `slf4j-jdk14` 同理
- 三方 SDK 自带 `slf4j-simple`、`slf4j-reload4j` 等实现时，在依赖上 `<exclusion>` 掉

> 选型建议：没有明确理由就用默认的 Logback，Spring Boot 的默认配置、扩展标签与文档示例都以它为主；对吞吐有极致要求、想用全异步 Logger 时再考虑 Log4j2。

---

## 二、Spring Boot 日志配置

### 1、application.yml 常用配置

```yaml
spring:
  application:
    name: order-service

logging:
  level:
    root: info
    com.example.order: debug
    sql: debug                  # 内置分组：Spring JDBC、Hibernate SQL、jOOQ
  group:
    tomcat: org.apache.catalina,org.apache.coyote,org.apache.tomcat
  file:
    name: /var/log/order-service/app.log   # 与 logging.file.path 同时设置时，path 被忽略
  logback:
    rollingpolicy:
      max-file-size: 100MB
      max-history: 14
      total-size-cap: 10GB
  threshold:
    console: warn               # 控制台只输出 WARN 及以上，文件不受影响
```

| 配置 | 说明 |
|------|------|
| `logging.level.<logger>` | 按包或类设置级别：TRACE / DEBUG / INFO / WARN / ERROR / FATAL / OFF（Logback 没有 FATAL，按 ERROR 处理） |
| `logging.group.<name>` | 把多个包归为一组统一调级；内置 `web`、`sql` 两组 |
| `logging.file.name` / `logging.file.path` | 写文件，二选一；`path` 只指定目录，文件名固定为 `spring.log`。Log4j2 写文件需要设置 `logging.file.path` |
| `logging.threshold.console` / `logging.threshold.file` | 按输出目标设置最低级别 |
| `logging.pattern.console` / `logging.pattern.file` / `logging.pattern.level` | 自定义输出格式；`logging.pattern.level` 常用来追加 MDC 字段 |
| `logging.console.enabled` | **Boot 4.0+**，设为 `false` 关闭控制台输出 |
| `logging.include-application-name` | 设置了 `spring.application.name` 时默认在日志中输出应用名，设为 `false` 关闭 |

环境变量覆盖级别：`LOGGING_LEVEL_COM_EXAMPLE_ORDER=DEBUG` 只对包级 logger 有效，类级 logger 需用 `SPRING_APPLICATION_JSON`。配置源优先级见 [配置管理](./6_config)。

### 2、logback-spring.xml

配置复杂到 yml 表达不了时（多 Appender、异步、按环境差异化）再写 XML。**用 `logback-spring.xml` 而不是 `logback.xml`**：后者在 Spring 容器初始化之前就被 Logback 自己加载，无法使用下面的 Spring 扩展标签。

```xml
<configuration>
    <!-- 复用 Boot 默认的 pattern、颜色与 CONSOLE / FILE Appender（同 base.xml，但不带它的 root 定义） -->
    <include resource="org/springframework/boot/logging/logback/defaults.xml"/>
    <property name="LOG_FILE" value="${LOG_FILE:-${LOG_PATH:-${LOG_TEMP:-${java.io.tmpdir:-/tmp}}}/spring.log}"/>
    <include resource="org/springframework/boot/logging/logback/console-appender.xml"/>
    <include resource="org/springframework/boot/logging/logback/file-appender.xml"/>

    <!-- 从 Spring Environment 读取属性，source 必须使用 kebab-case -->
    <springProperty scope="context" name="appName" source="spring.application.name" defaultValue="app"/>

    <springProfile name="dev | local">
        <root level="INFO">
            <appender-ref ref="CONSOLE"/>
        </root>
    </springProfile>

    <springProfile name="prod">
        <logger name="com.example" level="INFO"/>
        <root level="WARN">
            <appender-ref ref="FILE"/>
        </root>
    </springProfile>
</configuration>
```

- `<springProfile>` 支持表达式：`production & (eu-central | eu-west)`、`!production`
- 这些扩展标签**不能与 Logback 的配置扫描（`scan="true"`）同时使用**；运行时调级别用 Actuator，见第六节
- Log4j2 对应文件为 `log4j2-spring.xml`，支持 `<SpringProfile>` 与 `${spring:spring.application.name}` 查找；不要额外引入 `log4j-spring-boot`
- `file-appender.xml` 默认使用 `SizeAndTimeBasedRollingPolicy`：单文件 10MB、保留 7 天、`.gz` 压缩，参数即上面 `logging.logback.rollingpolicy.*` 的值

---

## 三、结构化日志（Boot 3.4+）

文本日志靠正则解析，字段一变采集规则就要跟着改；结构化日志直接输出 JSON，采集端零解析。Spring Boot 3.4 起内置三种格式，无需再引入 `logstash-logback-encoder`：

```yaml
logging:
  structured:
    format:
      console: ecs        # 可选 ecs / gelf / logstash，或自定义 StructuredLogFormatter 的全类名
      file: logstash
    ecs:
      service:
        name: order-service          # 默认取 spring.application.name
        environment: prod
```

| 格式 | 适配 | 特有配置 |
|------|------|----------|
| `ecs` | Elastic Common Schema，Elasticsearch / Kibana | `logging.structured.ecs.service.name` / `version` / `environment` / `node-name` |
| `gelf` | Graylog Extended Log Format，Graylog | `logging.structured.gelf.host`、`logging.structured.gelf.service.version` |
| `logstash` | Logstash JSON 格式；Marker 输出为 `tags` 数组 | 无 |

ECS 格式一行输出形如（官方文档示例，有删减）：

```json
{"@timestamp":"2024-01-01T10:15:00.067462556Z","log":{"level":"INFO","logger":"org.example.Application"},"process":{"pid":39599,"thread":{"name":"main"}},"service":{"name":"simple"},"message":"...","ecs":{"version":"8.11"}}
```

要点：

- 三种格式都会把 **MDC 中的所有键值对**写进 JSON，所以 traceId、userId 等放进 MDC 即可成为可检索字段
- SLF4J 2.x 的 Fluent API 也能为单条日志附加字段，比拼进 message 更利于检索：

```java
log.atInfo()
   .setMessage("订单支付成功")
   .addKeyValue("orderId", orderId)
   .addKeyValue("amount", amount)
   .log();
```

- Boot 4.x 文档还提供了 JSON 定制项：`logging.structured.json.include` / `exclude` / `rename.<path>` / `add.<name>`，以及异常栈裁剪 `logging.structured.json.stacktrace.max-length`、`max-throwable-depth` 等
- 自定义格式实现 `StructuredLogFormatter<ILoggingEvent>`（Logback）或 `StructuredLogFormatter<LogEvent>`（Log4j2），再把全类名填到 `logging.structured.format.*`
- 常见组合：**本地开发控制台用文本，生产控制台用 JSON**（容器场景只输出 stdout，由采集 Agent 收走），用 Profile 区分即可

---

## 四、异步日志

同步日志在业务线程里完成格式化与 IO，磁盘抖动、网络盘卡顿会直接拖慢接口。异步日志把「生成事件」与「写出」解耦，代价是**可能丢日志**以及**进程崩溃时队列中的日志来不及落盘**。

### 1、Logback AsyncAppender

```xml
<appender name="ASYNC_FILE" class="ch.qos.logback.classic.AsyncAppender">
    <queueSize>8192</queueSize>
    <discardingThreshold>0</discardingThreshold>
    <neverBlock>true</neverBlock>
    <appender-ref ref="FILE"/>
</appender>
```

| 参数 | 默认值 | 含义 |
|------|--------|------|
| `queueSize` | 256 | 阻塞队列容量，生产环境通常调大 |
| `discardingThreshold` | 剩余容量 20% | 队列剩余不足阈值时**丢弃 TRACE / DEBUG / INFO**，只保留 WARN / ERROR；设为 0 表示不按级别丢弃 |
| `neverBlock` | false | 队列满时默认**阻塞业务线程**；设为 true 则直接丢弃，不阻塞 |
| `includeCallerData` | false | 默认不采集调用者类名 / 行号（采集代价高），`%line`、`%method` 会输出 `?` |
| `maxFlushTime` | — | 停止时等待队列刷完的最长毫秒数，超时剩余事件丢弃 |

取舍：

- **保可用性**：`neverBlock=true`，队列满时丢日志也不拖慢请求，适合普通业务日志
- **保完整性**：保持默认阻塞，或把审计日志单独走同步 Appender，宁可慢不能丢
- 异步队列只是削峰，持续写入速度超过磁盘能力时，阻塞或丢弃必然发生，根因要靠降级日志量解决
- Spring Boot 默认注册关停钩子（`logging.register-shutdown-hook`，WAR 部署除外），正常停机时会停止 LoggerContext 并刷出队列；`kill -9` 或 OOM 崩溃时队列内日志会丢失

### 2、Log4j2 AsyncLogger

Log4j2 的异步 Logger 基于 **LMAX Disruptor** 无锁环形队列，需额外引入 `com.lmax:disruptor`（runtime 依赖），吞吐通常高于基于阻塞队列的 AsyncAppender。

| 方式 | 配置 | 说明 |
|------|------|------|
| 全异步 | 系统属性 `log4j2.contextSelector=org.apache.logging.log4j.core.async.AsyncLoggerContextSelector` | 所有 Logger 异步；此时配置里只用普通 `Root` / `Logger`，再用 `AsyncRoot` / `AsyncLogger` 会多一层异步屏障 |
| 混合 | 默认 selector + 配置文件中用 `<AsyncLogger>` / `<AsyncRoot>` | 只让部分 Logger 异步，审计类 Logger 保持同步 |

- 环形队列满时默认**阻塞**调用线程；设 `log4j2.asyncQueueFullPolicy=Discard` 后丢弃 `log4j2.discardThreshold`（默认 INFO）及以下级别
- 位置信息（`includeLocation`）在异步 Logger 中默认关闭，开启会显著降低性能

---

## 五、MDC 与 traceId 传递

### 1、MDC 基本用法

MDC（Mapped Diagnostic Context）是绑定在**当前线程**上的键值对，Pattern 中用 `%X{key}` 输出，结构化日志会自动带上全部 MDC。典型用法是在入口 Filter 中放入请求级字段，**finally 中清理**，否则线程复用会把上一个请求的值带给下一个请求：

```java
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.slf4j.MDC;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;
import java.io.IOException;

@Component
public class MdcFilter extends OncePerRequestFilter {

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response,
                                    FilterChain chain) throws ServletException, IOException {
        String tenantId = request.getHeader("X-Tenant-Id");
        if (tenantId != null) {
            MDC.put("tenantId", tenantId);
        }
        try {
            chain.doFilter(request, response);
        } finally {
            MDC.remove("tenantId");
        }
    }
}
```

```yaml
logging:
  pattern:
    level: "%5p [tenant:%X{tenantId:-}]"
```

### 2、traceId：交给 Micrometer Tracing

引入 Micrometer Tracing（Brave 或 OpenTelemetry bridge）后，Spring Boot 默认就会在日志中输出关联 ID，**无需自己生成 traceId 放进 MDC**：

- Micrometer Tracing 把当前 Span 的 `traceId`、`spanId` 写入 MDC，Boot 默认格式输出为 `[traceId-spanId]`
- 用 `logging.pattern.correlation` 自定义格式，例如 `[${spring.application.name:},%X{traceId:-},%X{spanId:-}] `（末尾空格用于与 logger 名分隔）
- 采样率 `management.tracing.sampling.probability` 默认 0.1，控制的是 Span 上报到追踪后端的比例，开发环境可设为 1.0
- Boot 4.0 起 `management.tracing.enabled` 更名为 `management.tracing.export.enabled`，新增 `spring-boot-starter-opentelemetry`

链路追踪原理与平台见 [链路追踪](/observability/3_tracing) 与 [OpenTelemetry](/observability/5_opentelemetry)。

### 3、跨线程：线程池与 @Async

MDC 基于 ThreadLocal，任务提交到线程池后，工作线程拿不到提交方的 MDC，日志中的 traceId 就断了。

| 场景 | 做法 |
|------|------|
| 自己配置的 `ThreadPoolTaskExecutor` / `AsyncTaskExecutor` | 设置 `ContextPropagatingTaskDecorator`（基于 Context Propagation 库，传递已注册的 ThreadLocal，如当前 Observation，Tracing 在工作线程中据此把 traceId 写回 MDC） |
| Boot 自动配置的 `@Async` 执行器 | Boot 4.1+ 设置 `spring.task.execution.propagate-context=true` 开启；之前的版本注册一个 `ContextPropagatingTaskDecorator` Bean |
| 只需复制 MDC，或要传递自己放入的 MDC 字段（如 tenantId） | 自定义 `TaskDecorator`：提交时 `MDC.getCopyOfContextMap()`，执行前 `setContextMap`，finally 中恢复执行线程原有的 MDC（不要直接 `clear`），示例见 [线程池](/java/28_topic_thread_pool) |

```java
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.task.support.ContextPropagatingTaskDecorator;

@Configuration(proxyBeanMethods = false)
class ContextPropagationConfiguration {

    @Bean
    ContextPropagatingTaskDecorator contextPropagatingTaskDecorator() {
        return new ContextPropagatingTaskDecorator();
    }
}
```

Boot 4.0 起容器中有多个 `TaskDecorator` Bean 时会组合成 `CompositeTaskDecorator` 依次应用，不必再手工合并。`@Async` 与线程池配置见 [异步与定时任务](./9_async_schedule)。

### 4、响应式链路

WebFlux / Reactor 中一个请求会在多个线程间切换，ThreadLocal 默认不会在操作符中恢复。设置：

```yaml
spring:
  reactor:
    context-propagation: auto
```

开启后 Reactor 会在操作符执行时自动从 Reactor Context 恢复已注册的 ThreadLocal（如当前 Observation），Tracing 随之把 traceId 写入 MDC，日志中即可拿到。自己放入 MDC 的业务字段不会自动传递，需要为其注册 `ThreadLocalAccessor` 或改用 Reactor Context。

---

## 六、运行时调整级别

线上排障需要临时打开某个包的 DEBUG 时，不要改配置重启，用 Actuator 的 `/actuator/loggers` 端点动态调整，排查完立即恢复：

```bash
curl -X POST http://localhost:8080/actuator/loggers/com.example.order \
     -H 'Content-Type: application/json' -d '{"configuredLevel":"DEBUG"}'
```

- 同样支持对日志分组（`logging.group`）调级
- 修改只在当前实例内存中生效，重启失效；多实例需逐个调用或借助配置中心
- 该端点可写，**必须做鉴权**并限制在管理端口

端点开放与安全配置见 [Actuator](./7_actuator)。

---

## 七、性能陷阱

| 写法 | 问题 | 正确做法 |
|------|------|----------|
| `log.debug("user=" + user)` | 级别关闭时字符串拼接与 `toString()` 依然执行 | 占位符 `log.debug("user={}", user)`，级别关闭时不格式化 |
| `log.debug("data={}", buildReport())` | 占位符只延迟格式化，**参数表达式仍会求值** | `if (log.isDebugEnabled())` 包裹，或 Fluent API `log.atDebug().setMessage("data={}").addArgument(() -> buildReport()).log()` 延迟求值 |
| 打印整个对象 / 集合 / 请求响应体 | 序列化开销大，单条日志数 MB，磁盘与采集成本暴涨 | 只打关键字段与数量，大字段截断 |
| `log.error(e.getMessage())` | 丢失异常栈，无法定位 | `log.error("扣减库存失败, orderId={}", orderId, e)`，异常作为**最后一个参数**单独传入 |
| 异常既打日志又抛出，层层重复 | 同一异常栈打印 N 次 | 要么处理并记录，要么包装后抛出，在统一异常处理处记录一次 |
| 循环内逐条 INFO | 高 QPS 下日志量与锁竞争放大 | 汇总后打一条，或降为 DEBUG |
| Pattern 中 `%line`、`%method`、`%class` | 需要构造栈来获取调用位置，开销大 | 生产环境去掉，用 logger 名定位 |

> 占位符规则：最后一个参数是 `Throwable` 时，SLF4J 把它当作异常输出完整栈，不要为它预留 `{}`，所以 `log.error("msg {}", id, e)` 是正确写法。

---

## 八、安全

### 1、Log4Shell 的教训

CVE-2021-44228（Log4Shell）：Log4j2 的 `log4j-core` 会解析日志消息中的 `${jndi:ldap://...}` 查找表达式并发起 JNDI 加载，攻击者只要让一个可控字符串（User-Agent、用户名）被打印，就能远程执行代码。

- 影响的是 `log4j-core`；Spring Boot 默认使用 Logback，只引入 `log4j-to-slf4j`（只有 API），**只有切换到 Log4j2 的应用受影响**
- 修复需升级 Log4j2 到修复版本（后续又陆续披露了 CVE-2021-45046 等关联漏洞，应使用 2.17.1 及以上），并持续用依赖扫描工具跟踪
- 普适教训：**日志框架会处理不可信输入**，任何「对日志内容做解析/求值」的特性都是攻击面；依赖要有 SBOM 与漏洞扫描，能在一天内完成全量升级

漏洞分类与防护见 [漏洞防护](/security/8_vulnerabilities)。

### 2、敏感信息与日志注入

- **永远不打**：密码、Token、密钥、完整银行卡号 / 身份证号；手机号、邮箱、地址等 PII 必须脱敏
- 从源头控制：DTO 的 `toString()` 排除敏感字段（Lombok `@ToString.Exclude`），不要直接打印请求体
- 兜底脱敏：Logback 的 `%replace` 转换词可以在输出前用正则替换，例如 `%replace(%msg){'(\d{3})\d{4}(\d{4})', '$1****$2'}`；正则对每条日志执行，有性能成本，只作为兜底
- 日志注入：用户输入中的换行符可伪造日志行，文本格式下应转义 `\r\n`；结构化 JSON 输出天然转义，不存在此问题
- 日志文件本身是敏感数据：限制目录权限，采集链路加密，按合规要求设定保留期

脱敏规则与审计日志见 [数据安全](/security/7_data_security)。

---

## 九、滚动与保留

| 部署方式 | 推荐做法 |
|----------|----------|
| 容器 / Kubernetes | **只输出 stdout**（生产用 JSON），不在容器内写文件；滚动与保留交给容器运行时和采集平台 |
| 物理机 / 虚拟机 | 写滚动文件，由 Filebeat / Fluent Bit 采集；本地只保留短期，长期存储在日志平台 |

Logback 滚动参数（`logging.logback.rollingpolicy.*`）：

| 属性 | 默认值 | 建议 |
|------|--------|------|
| `file-name-pattern` | `${LOG_FILE}.%d{yyyy-MM-dd}.%i.gz` | 按天 + 序号切分并压缩 |
| `max-file-size` | 10MB | 调到 100MB～500MB，避免文件过碎 |
| `max-history` | 7 | 按合规与排障需要设置天数 |
| `total-size-cap` | 0（不限制） | **一定要设置**，防止日志打满磁盘导致应用异常 |
| `clean-history-on-start` | false | 启动时清理过期归档 |

Log4j2 对应属性为 `logging.log4j2.rollingpolicy.*`（`max-file-size`、`max-history`、`strategy`、`cron` 等），可配置的轮转策略（size / time / size-and-time / cron）是 **Boot 4.1+** 新增的。

---

## 小结

- 业务代码只依赖 SLF4J；Boot 默认实现是 Logback，桥接器把 JUL、Log4j API 统一转到 SLF4J；Framework 7 起 JCL 由 Commons Logging 1.3 自动转发
- SLF4J 2.x 用 ServiceLoader 找 Provider，没有 Provider 会静默丢日志，多个 Provider 选择不可控；切 Log4j2 时排除 `spring-boot-starter-logging`
- 简单配置写 yml（级别、分组、文件、滚动、阈值）；需要 Profile 差异化或异步时写 `logback-spring.xml`，用 `<springProfile>` / `<springProperty>`
- Boot 3.4+ 内置 `ecs` / `gelf` / `logstash` 结构化日志，MDC 与 Fluent API 的键值对会自动成为 JSON 字段
- 异步日志是「性能 vs 完整性」的取舍：AsyncAppender 默认队列 256、剩余 20% 时丢 INFO 及以下、满时阻塞；`neverBlock=true` 改为丢弃；Log4j2 全异步依赖 Disruptor
- traceId 交给 Micrometer Tracing 写入 MDC；跨线程用 `ContextPropagatingTaskDecorator`（Boot 4.1+ 可用 `spring.task.execution.propagate-context`），响应式设 `spring.reactor.context-propagation=auto`
- 运行时调级别用 `/actuator/loggers`，用完恢复，端点必须鉴权
- 用占位符而非拼接，昂贵参数加级别判断，异常对象作为最后一个参数，避免重复打印与大对象日志
- Log4Shell 说明日志框架是攻击面；密码、Token 不入日志，PII 先脱敏；容器只输出 stdout，文件部署务必设置 `total-size-cap`

日志被采集之后的 Fluent Bit / Filebeat、Elasticsearch、Loki 等平台侧内容见 [可观测性](/observability/0_overview) 与 [日志体系](/observability/1_logging)。

## 参考资料

- Spring Boot Logging：[https://docs.spring.io/spring-boot/reference/features/logging.html](https://docs.spring.io/spring-boot/reference/features/logging.html)
- Spring Boot Tracing（日志关联 ID）：[https://docs.spring.io/spring-boot/reference/actuator/tracing.html](https://docs.spring.io/spring-boot/reference/actuator/tracing.html)
- SLF4J 手册：[https://www.slf4j.org/manual.html](https://www.slf4j.org/manual.html)
- Logback AsyncAppender：[https://logback.qos.ch/manual/appenders-async-sift.html](https://logback.qos.ch/manual/appenders-async-sift.html)
- Log4j2 异步日志：[https://logging.apache.org/log4j/2.x/manual/async.html](https://logging.apache.org/log4j/2.x/manual/async.html)

> 下一篇：[Spring Boot 测试](./13_testing) —— 切片测试、Mock 与 Testcontainers，让 Boot 应用的每一层都能被快速、可靠地验证。
