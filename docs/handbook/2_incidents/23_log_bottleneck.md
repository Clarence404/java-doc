---
description: CPU 不高但 P99 飙升、线程卡在 Appender 锁、大对象日志与调用位置采集、磁盘 IO 打满、异步 Appender 与丢弃策略
---

# 日志打印拖慢接口

> 前置阅读：[日志](/spring-boot/9_logging)、[日志体系](/observability/1_logging)

支付回调服务上线一个"加日志方便排查"的小版本后，晚高峰接口 P99 从 80ms 涨到 1.5s，CPU 却只有 30%。本篇复盘日志同步写盘、日志量暴涨与 Appender 锁竞争如何拖慢接口，基线为 JDK 21、Spring Boot 4（Logback 1.5）。

---

## 一、现象

10 月 12 日 19:40 起 pay-callback-service（4 个 Pod，Tomcat 最大 200 线程，日志写本地文件，由节点上的 Agent 采集）告警：

| 时间 | 告警 / 现象 |
|------|-------------|
| 19:42 | `HttpP99High`：支付回调接口 P99 从 80ms 升到 1.5s |
| 19:45 | `TomcatBusyThreadsHigh`：忙线程数 190 / 200 |
| 19:47 | 支付渠道回调重试量上升，渠道侧开始对超时回调做退避重推 |
| 19:48 | 节点告警：日志盘 `%util` 持续 100%，写等待 `w_await` 45ms |

同一时段数据库、Redis、下游订单服务的 RT 都正常，Pod CPU 30% 左右，GC 停顿也没有变化。

---

## 二、影响

- 19:42–20:15 共 33 分钟，约 8% 的支付回调超过渠道 3 秒超时，被渠道重推；回调处理本身幂等，没有重复入账
- 订单状态从"已支付"推送到用户端平均延迟 40 秒，客服收到 60 余起"付了款订单还是待支付"咨询
- 日志采集端积压，19:50–20:30 的日志在 Loki 中晚到约 25 分钟，排查时一度看不到实时日志

---

## 三、排查过程

### 1、CPU 不高、线程却很忙：先看线程在等什么

```bash
kubectl exec pay-callback-7f6d-c9x2p -- jstack 1 > jstack-1.txt
grep -A12 '"http-nio-8080-exec' jstack-1.txt | grep -E "State|parking to wait|at ch.qos" | sort | uniq -c | sort -rn | head
```

示例输出：

```text
    173    java.lang.Thread.State: WAITING (parking)
    173	- parking to wait for  <0x00000006c2a81f40> (a java.util.concurrent.locks.ReentrantLock$NonfairSync)
    173	at ch.qos.logback.core.OutputStreamAppender.writeBytes(OutputStreamAppender.java:261)
     12    java.lang.Thread.State: RUNNABLE
```

200 个 Tomcat 线程里 173 个在等**同一把锁**，等待位置是 Logback 的 `OutputStreamAppender.writeBytes`。找持有锁的线程：

```text
"http-nio-8080-exec-41" #96 daemon prio=5 os_prio=0 cpu=8812.41ms elapsed=5410.27s tid=0x... nid=88 runnable
   java.lang.Thread.State: RUNNABLE
	at java.io.FileOutputStream.writeBytes(java.base@21.0.8/Native Method)
	at java.io.FileOutputStream.write(java.base@21.0.8/FileOutputStream.java:367)
	at ch.qos.logback.core.recovery.ResilientOutputStreamBase.write(ResilientOutputStreamBase.java:54)
	at ch.qos.logback.core.OutputStreamAppender.writeBytes(OutputStreamAppender.java:261)
	...
	at com.example.pay.callback.CallbackController.handle(CallbackController.java:57)
```

持锁线程正在执行 `write` 系统调用，卡在磁盘写入上。同步 Appender 的写入是串行的：一个线程写盘慢，其余所有要打日志的线程都排队。

### 2、确认磁盘是瓶颈

在 Pod 所在节点上：

```bash
iostat -x 5 2 | grep -E "Device|vdb"
```

示例输出：

```text
Device   r/s     w/s    rkB/s     wkB/s  r_await  w_await  aqu-sz  %util
vdb      0.20  2984.60    1.60  97213.40    0.50    45.12   134.7  100.00
```

日志盘是一块按 IOPS 计费的云盘，规格上限约 3000 IOPS / 100MB/s，已经顶满。用 `pidstat -d 5` 看是谁在写，排第一的是这几个 Java 进程，第二是日志采集 Agent 的读。

### 3、日志量为什么暴涨

对比上线前后各 Pod 的日志事件数（Spring Boot 默认注册 Logback 指标）：

```promql
sum by (level) (rate(logback_events_total{app="pay-callback-service"}[5m]))
```

INFO 从每秒 900 条涨到 4100 条，而且单条体积明显变大。看采集侧每分钟字节数，单 Pod 从 8MB/min 涨到 95MB/min。抽几条日志：

```bash
kubectl exec pay-callback-7f6d-c9x2p -- sh -c 'tail -n 2000 /data/logs/app.log | awk "{print length}" | sort -n | tail -3'
```

示例输出：

```text
18342
21907
26518
```

单条最长 26KB。翻本次上线的 diff，找到新增的两行：

```java
log.info("callback request={}, channelResp={}", JsonUtils.toJson(request), JsonUtils.toJson(channelResp));
// 循环内逐条记录分账明细
splits.forEach(s -> log.info("split item={}", JsonUtils.toJson(s)));
```

完整回调报文和渠道响应被序列化后整体打印，分账明细逐条打印，每个回调平均多出 5 条日志、约 30KB。

### 4、还有哪些额外开销

查看 `logback-spring.xml` 的 pattern：

```xml
<pattern>%d{yyyy-MM-dd HH:mm:ss.SSS} %-5level [%thread] %logger{36}.%method:%line - %msg%n</pattern>
```

`%method`、`%line` 需要在打日志时构造调用栈来获取调用位置，每条日志都有可观的 CPU 和分配开销。用 Arthas 看一次回调里日志相关的耗时占比：

```bash
trace com.example.pay.callback.CallbackService handle -n 5 '#cost > 200'
```

示例输出（节选）：

```text
`---ts=2026-10-12 19:58:12;thread_name=http-nio-8080-exec-77;id=129;is_daemon=true;priority=5;TCCL=...
    `---[1384.62ms] com.example.pay.callback.CallbackService:handle()
        +---[0.92ms] com.example.pay.callback.SignVerifier:verify() #41
        +---[1203.37ms] org.slf4j.Logger:info() #48
        +---[6.15ms] com.example.pay.order.OrderClient:markPaid() #52
        `---[171.88ms] org.slf4j.Logger:info() #61
```

一次回调 1.38s 里 1.37s 花在打日志上，真正的业务处理只有十几毫秒。

---

## 四、根因

1. **日志量和单条体积暴涨**：新增的"全报文 + 循环逐条"日志让单 Pod 写入量涨了 10 倍以上，超过日志盘的 IOPS 和带宽上限
2. **同步 Appender 把磁盘延迟传导给请求线程**：所有线程共用一个文件 Appender，写入串行化，持锁线程卡在 `write` 上，其余线程全部排队，Tomcat 线程被占满
3. **调用位置采集放大了单条成本**：`%method:%line` 让每条日志多一次栈遍历，在高 QPS 下进一步抬高 CPU 与延迟

三者叠加，接口 RT 等于"排队等日志锁 + 写盘"的时间，与业务逻辑本身无关。同类问题在打到 stdout 的容器里同样会发生，只是瓶颈变成容器运行时的日志管道和节点磁盘。

---

## 五、修复

### 1、止血

- 19:55 用 Actuator 的 loggers 端点把 `com.example.pay.callback` 调到 WARN，不用重启（Arthas 的 `logger` 命令也能做到，见 [Arthas 速查](/handbook/1_cheatsheet/3_arthas#四、类与类加载器)）：

```bash
curl -s -X POST http://localhost:8081/actuator/loggers/com.example.pay.callback \
  -H 'Content-Type: application/json' -d '{"configuredLevel":"WARN"}'
```

- 19:58 日志盘 `%util` 降到 35%，20:02 P99 回落到 90ms
- 20:15 渠道重推的回调全部处理完毕

### 2、删掉不该打的日志

- 回调报文只记录关键字段（渠道订单号、金额、状态、签名校验结果），完整报文落到专门的回调记录表，按需查询
- 分账明细改为汇总一条：`log.info("split done, orderNo={}, count={}, total={}", orderNo, splits.size(), total)`
- 需要参数求值的 DEBUG 日志改用 Fluent API 延迟求值，级别关闭时不序列化对象

### 3、去掉调用位置采集

```xml
<pattern>%d{yyyy-MM-dd HH:mm:ss.SSS} %-5level [%thread] %logger{36} [%X{traceId}] - %msg%n</pattern>
```

定位代码靠 logger 名和 traceId，不靠行号。

### 4、业务日志改异步，审计日志保持同步

```xml
<appender name="ASYNC_FILE" class="ch.qos.logback.classic.AsyncAppender">
    <queueSize>8192</queueSize>
    <!-- 队列剩余不足 20% 时丢弃 INFO 及以下，WARN / ERROR 仍保留 -->
    <discardingThreshold>1638</discardingThreshold>
    <!-- 队列满时直接丢弃，不阻塞业务线程 -->
    <neverBlock>true</neverBlock>
    <appender-ref ref="FILE"/>
</appender>

<!-- 资金相关审计日志单独一个同步 Appender，宁可慢不能丢 -->
<logger name="AUDIT" level="INFO" additivity="false">
    <appender-ref ref="AUDIT_FILE"/>
</logger>

<root level="INFO">
    <appender-ref ref="ASYNC_FILE"/>
</root>
```

丢弃策略要按日志价值分层：

| 日志类别 | 写法 | 队列满时 |
|----------|------|----------|
| 普通业务日志 | AsyncAppender，`neverBlock=true` | 丢弃，保接口可用 |
| WARN / ERROR | 同一 AsyncAppender，`discardingThreshold` 只丢低级别 | 尽量保留，极端情况下也会丢 |
| 资金、审计日志 | 独立同步 Appender，或直接写数据库 / 消息队列 | 阻塞，保完整性 |

::: warning 异步不是根治
异步队列只能削平短时尖峰。写入速度长期超过磁盘能力时，队列一定会满，结果要么阻塞、要么丢日志；根治靠控制日志量。另外进程被 `kill -9` 或 OOM 崩溃时，队列里未落盘的日志会丢失，排查崩溃时要意识到最后几秒的日志可能不全。
:::

AsyncAppender 自身不暴露丢弃计数，可以把 `getRemainingCapacity()` 注册为 Micrometer Gauge 观察队列水位；Log4j2 的 AsyncLogger 吞吐更高，对比见 [异步日志](/spring-boot/9_logging#四、异步日志)。

### 5、磁盘

日志盘从按 IOPS 计费的云盘换成本地 SSD 临时盘，日志采集 Agent 改为读取后按大小滚动清理，保留时间交给日志平台。

---

## 六、预防

**监控告警**：

```yaml
- alert: LogVolumeSurge
  # 单个服务 INFO 日志速率是 1 天前同一时刻的 3 倍以上
  expr: |
    sum by (app) (rate(logback_events_total{level="info"}[10m]))
      > 3 * sum by (app) (rate(logback_events_total{level="info"}[10m] offset 1d))
  for: 10m
  labels: {severity: warning}
- alert: DiskIoSaturated
  expr: rate(node_disk_io_time_seconds_total{device=~"vd.*|nvme.*"}[5m]) > 0.9
  for: 5m
  labels: {severity: warning}
```

**代码规范**：

- 禁止在 INFO 级别打印完整请求 / 响应体和集合，大字段截断到 512 字符以内；禁止循环内逐条 INFO
- 生产 pattern 禁止 `%line`、`%method`、`%class`、`%file`
- 资金、审计类日志使用独立 logger，不与业务日志共用异步队列
- Code Review 清单加一条："新增日志在峰值 QPS 下每秒多少条、每条多大"

**容量**：

- 每个服务在发布评审中给出日志量预算（条 / 秒、MB / 分钟），日志平台按服务做采集限流，超预算先告警再限流

---

## 七、涉及知识点

- 异步 Appender 参数、AsyncLogger 与丢弃策略：[日志](/spring-boot/9_logging#四、异步日志)
- 占位符、参数求值与调用位置采集的开销：[日志](/spring-boot/9_logging#七、性能陷阱)
- 运行时调整日志级别：[日志](/spring-boot/9_logging#六、运行时调整级别)
- 日志级别策略、采集与成本控制：[日志体系](/observability/1_logging)
- `trace` 拆解方法耗时：[线上诊断](/engineering/7_diagnosis)
- 磁盘与 IO 排查命令：[Linux 排查命令速查](/handbook/1_cheatsheet/0_linux#三、磁盘与文件)

---

## 小结

- CPU 不高、线程大量 `WAITING` 在同一把锁上，先看锁在谁手里；锁在 Appender 上就是日志问题
- 同步日志会把磁盘延迟直接传导给请求线程，日志量暴涨时所有接口一起变慢
- 根治靠控量：不打完整报文、不循环逐条打、去掉调用位置采集
- 异步 Appender 按日志价值分层：普通日志可丢不阻塞，审计日志独立同步

## 参考资料

- AsyncAppender 参数：[Logback Manual — Appenders](https://logback.qos.ch/manual/appenders.html)
- Pattern 中各转换符的开销说明：[Logback Manual — Layouts](https://logback.qos.ch/manual/layouts.html)
- Log4j2 异步 Logger：[Apache Log4j — Asynchronous loggers](https://logging.apache.org/log4j/2.x/manual/async.html)
- 运行时调整日志级别：[Spring Boot Reference — Loggers Endpoint](https://docs.spring.io/spring-boot/api/rest/actuator/loggers.html)
- `iostat` 字段说明：[iostat(1) — Linux manual page](https://man7.org/linux/man-pages/man1/iostat.1.html)

> 下一篇：[网络重传与丢包](./24_network_retrans)
