---
description: 全量导出产生巨型对象引发 G1 Full GC、GC 日志与 JFR 分配分析、流式导出与并发限制
---

# 频繁 Full GC

> 前置阅读：[GC 调优](/jvm/6_gc_tuning)、[GC 收集器](/jvm/5_gc_collectors)

几次并发的全量对账导出让订单服务每分钟多次 G1 Full GC。本篇复盘从 `Humongous Allocation` 日志到导出接口的定位，以及流式导出改造，基线为 JDK 21、MySQL 8.4。

---

## 一、现象

order-service 6 个 Pod，`-Xms4g -Xmx4g`，默认 G1（堆 4GB 时 Region 为 2MB，≥ 1MB 的对象即为巨型对象）。10 月 8 日：

| 时间 | 告警 / 现象 |
|------|-------------|
| 09:32 | `JvmFullGcFrequent`：order-service-6f4d-k9z2r 5 分钟内 Full GC 11 次 |
| 09:34 | `HttpP99High`：下单接口 P99 从 180ms 升到 3.6s，P999 超过 6s |
| 09:35 | 网关出现少量 504（上游读超时 5s），K8s 就绪探针间歇失败，Pod 在 Ready / NotReady 间抖动 |
| 09:51 | 告警自动恢复，10:20 又出现一轮，持续约 12 分钟 |

`jvm_memory_used_bytes{area="heap"}` 呈锯齿状：几分钟内从 1.3GB 冲到 3.9GB，Full GC 后掉回 1.3GB 左右。`jvm_gc_pause_seconds_count{action="end of major GC", cause="G1 Compaction Pause"}` 只在这两段时间上涨，其余时间为 0。

---

## 二、影响

- 两段共约 30 分钟，下单接口 P99 超过 3s，约 2.1% 的请求超时失败（约 4,700 次），部分用户重复提交
- 就绪探针抖动导致流量在 Pod 间来回漂移，未受影响的 Pod 负载也被推高
- 财务的导出请求本身也有一半以超时告终，于是反复重试，加剧了问题

---

## 三、排查过程

### 1、看 GC 日志：是什么触发了 Full GC

启动参数中已开启 `-Xlog:gc*:file=/data/logs/gc.log:time,level,tags:filecount=10,filesize=50m`：

```bash
kubectl exec order-service-6f4d-k9z2r -- \
  grep -E "Pause (Full|Young)" /data/logs/gc.log | sed -n '/09:33:1/,/09:33:3/p'
```

示例输出：

```text
[2026-10-08T09:33:12.081+0800][info][gc] GC(23410) Pause Young (Concurrent Start) (G1 Humongous Allocation) 3514M->3498M(4096M) 38.912ms
[2026-10-08T09:33:13.604+0800][info][gc] GC(23412) Pause Young (Normal) (G1 Evacuation Pause) (Evacuation Failure) 3901M->3962M(4096M) 412.337ms
[2026-10-08T09:33:16.279+0800][info][gc] GC(23413) Pause Full (G1 Compaction Pause) 3990M->1712M(4096M) 2481.065ms
[2026-10-08T09:33:24.930+0800][info][gc] GC(23415) Pause Young (Concurrent Start) (G1 Humongous Allocation) 3388M->3371M(4096M) 41.208ms
[2026-10-08T09:33:27.512+0800][info][gc] GC(23417) Pause Full (G1 Compaction Pause) 4006M->1690M(4096M) 2397.540ms
```

三个信号：

- 并发标记反复由 `G1 Humongous Allocation` 触发：有大量巨型对象在分配
- 出现 `Evacuation Failure`：年轻代回收时找不到空闲 Region 复制存活对象
- Full GC 后从 4GB 降到 1.7GB，说明大部分对象是**短期存活的大对象**，不是泄漏（泄漏看上一篇 [堆内存溢出](./0_heap_oom)）

### 2、确认巨型 Region 占比

```bash
kubectl exec order-service-6f4d-k9z2r -- grep "Humongous regions" /data/logs/gc.log | tail -3
```

示例输出：

```text
[2026-10-08T09:33:12.120+0800][info][gc,heap] GC(23410) Humongous regions: 1206->1206
[2026-10-08T09:33:13.640+0800][info][gc,heap] GC(23412) Humongous regions: 1311->1311
[2026-10-08T09:33:24.968+0800][info][gc,heap] GC(23415) Humongous regions: 1158->1158
```

4GB 堆一共 2048 个 Region，巨型对象占了 1100 多个（2.2GB 以上），年轻代和老年代被挤得没有空间，G1 只能退化为 Full GC 整理。

### 3、谁在分配大对象：JFR 分配采样

```bash
kubectl exec order-service-6f4d-k9z2r -- \
  jcmd 1 JFR.start name=alloc settings=profile duration=120s filename=/data/dump/alloc.jfr
# 两分钟后
kubectl cp order-service-6f4d-k9z2r:/data/dump/alloc.jfr ./alloc.jfr
jfr view allocation-by-site alloc.jfr
```

示例输出（节选）：

```text
                               Allocation by Site

Method                                                                 Allocation Pressure
---------------------------------------------------------------------- -------------------
java.util.Arrays.copyOf(byte[], int)                                   58.42%
java.util.Arrays.copyOf(Object[], int)                                 17.95%
com.mysql.cj.protocol.a.NativePacketPayload.<init>(int)                 6.13%
...
```

`Arrays.copyOf(byte[])` 占了近六成分配压力，再看调用栈：

```bash
jfr print --events jdk.ObjectAllocationSample --stack-depth 6 alloc.jfr | grep -A8 "byte\[\]" | head -20
```

示例输出（节选）：

```text
jdk.ObjectAllocationSample {
  objectClass = byte[] (classLoader = null)
  weight = 268.4 MB
  eventThread = "http-nio-8080-exec-23" (javaThreadId = 81)
  stackTrace = [
    java.util.Arrays.copyOf(byte[], int) line: 3541
    java.io.ByteArrayOutputStream.ensureCapacity(int) line: 100
    java.io.ByteArrayOutputStream.write(byte[], int, int) line: 130
    com.example.order.admin.OrderExportService.writeCsv(List) line: 64
    com.example.order.admin.OrderExportController.export(ExportQuery) line: 38
```

Arthas 的 `profiler start --event alloc` 也能得到同样的分配火焰图，适合机器上没法取 JFR 文件的场景。

### 4、与访问日志对照

```bash
kubectl logs order-service-6f4d-k9z2r --since=2h | grep "GET /admin/orders/export" | awk '{print $1, $7, $9, $NF}'
```

示例输出：

```text
2026-10-08T09:31:47 /admin/orders/export?from=2026-09-01&to=2026-09-30 200 48213ms
2026-10-08T09:32:05 /admin/orders/export?from=2026-09-01&to=2026-09-30 200 51877ms
2026-10-08T09:32:40 /admin/orders/export?from=2026-09-01&to=2026-09-30 503 60001ms
2026-10-08T10:19:58 /admin/orders/export?from=2026-09-01&to=2026-09-30 200 46390ms
```

两段 Full GC 风暴的起止时间与导出请求完全重合；同一时间有 3 个导出在跑。

---

## 四、根因

导出接口把整月订单（约 62 万行）一次性查出、在内存里拼成完整 CSV 再返回：

```java
public byte[] export(ExportQuery q) {
    List<OrderExportRow> rows = orderMapper.selectByDateRange(q.from(), q.to());   // 62 万个对象，约 900MB
    ByteArrayOutputStream bos = new ByteArrayOutputStream();                       // 默认 32 字节，满了就翻倍复制
    writeCsv(bos, rows);                                                           // 最终约 190MB 的 CSV
    return bos.toByteArray();                                                      // 再完整复制一份
}
```

- `List` 扩容时的 `Object[]` 和 `ByteArrayOutputStream` 翻倍扩容时的 `byte[]`（64MB、128MB、256MB……）都远超 1MB，直接作为巨型对象分配在连续 Region 中；扩容时新旧数组同时存在，`toByteArray()` 又再复制一次
- 单次导出峰值约 1.2GB，3 个并发导出就逼近 4GB 上限；巨型对象挤占 Region，年轻代复制失败，G1 退化为 Full GC
- 导出与下单共用一个服务和一个堆，后台批量操作直接拖垮了核心链路

---

## 五、修复

### 1、止血

- 09:55 在网关对 `/admin/orders/export` 临时限流为每分钟 1 次（全局），并通知财务按周分段导出
- 10:32 第二轮发生后，改为在配置中心关闭导出入口，财务改用只读从库上的离线报表临时完成对账

### 2、根治：流式导出 + 并发限制

查询改为游标逐行读取（JDBC URL 增加 `useCursorFetch=true`，MySQL Connector/J 才会按 `fetchSize` 分批取），写出改为直接写到响应流，内存中只有一个 64KB 缓冲区：

```java
@GetMapping("/admin/orders/export")
public ResponseEntity<StreamingResponseBody> export(@Valid ExportQuery q) {
    if (!exportPermits.tryAcquire()) {                       // 每个实例同时只允许 1 个导出
        throw new ResponseStatusException(HttpStatus.TOO_MANY_REQUESTS, "已有导出任务在执行，请稍后再试");
    }
    StreamingResponseBody body = out -> {
        try (Writer w = new BufferedWriter(new OutputStreamWriter(out, StandardCharsets.UTF_8), 64 * 1024)) {
            exportDao.streamByDateRange(q.from(), q.to(), row -> writeCsvLine(w, row));
        } finally {
            exportPermits.release();
        }
    };
    return ResponseEntity.ok()
            .header(HttpHeaders.CONTENT_DISPOSITION, "attachment; filename=orders.csv")
            .body(body);
}
```

```java
public void streamByDateRange(LocalDate from, LocalDate to, Consumer<OrderExportRow> sink) {
    jdbcTemplate.query(con -> {
        PreparedStatement ps = con.prepareStatement(EXPORT_SQL,
                ResultSet.TYPE_FORWARD_ONLY, ResultSet.CONCUR_READ_ONLY);
        ps.setFetchSize(1000);                               // 每批 1000 行，读完一批再取下一批
        ps.setObject(1, from);
        ps.setObject(2, to);
        return ps;
    }, (RowCallbackHandler) rs -> sink.accept(mapRow(rs)));
}
```

`StreamingResponseBody` 在 MVC 异步线程中执行，同时调整 `spring.mvc.async.request-timeout=10m`，并为它配置独立的有界执行器。

后续迭代把"大范围导出"改为异步任务：提交后后台生成文件上传对象存储，完成后发下载链接；导出功能整体迁到独立的 order-admin 服务，与下单链路隔离。

上线后用同样的整月范围压测 3 个并发（其中 2 个被限流），堆峰值 1.6GB，Full GC 为 0，巨型 Region 数稳定在个位数。

---

## 六、预防

**监控告警**：

```yaml
- alert: JvmFullGcFrequent
  expr: increase(jvm_gc_pause_seconds_count{action="end of major GC"}[5m]) > 3
  for: 2m
  labels: {severity: critical}
- alert: JvmGcPauseLong
  # 单次停顿最大值超过 1s
  expr: jvm_gc_pause_seconds_max > 1
  for: 1m
  labels: {severity: warning}
```

日志侧对 `gc.log` 中的 `Evacuation Failure`、`Pause Full` 做关键字告警，作为指标之外的第二道防线。

**代码规范**：

- 导出、报表、批量同步等可能超过 1 万行的场景，必须流式读写或改为异步任务，禁止 `List` 全量加载 + 内存拼装
- 后台批量能力不与核心交易链路共用实例；确需共用时用信号量限制并发
- 对未知大小的数据不用 `ByteArrayOutputStream` / `StringBuilder` 累积后一次性返回

**测试**：

- 集成测试用 Testcontainers 灌入 100 万行数据，以 `-Xmx512m` 运行导出用例，断言能完成且无 OOM
- 压测场景加入"下单 + 后台导出"混合流量，观察下单 P99 与 Full GC 次数

---

## 七、涉及知识点

- GC 日志开启与关键字段：[GC 调优](/jvm/6_gc_tuning#二、gc-日志分析)
- Full GC 频繁的常见原因：[GC 调优](/jvm/6_gc_tuning#_1、full-gc-频繁)
- G1 的 Region 与巨型对象：[GC 收集器](/jvm/5_gc_collectors#_1、region-布局)
- JFR 录制与 `jfr` 命令：[诊断工具](/jvm/8_monitoring_tools#八、jfr-与-jmc)
- 核心与非核心能力的隔离：[超时、重试与隔离](/high-avail/4_timeout_retry_bulkhead#三、隔离)

---

## 小结

- Full GC 后内存大幅回落是"短期大对象"，降不下来才是泄漏，两者处理方向完全不同
- G1 日志里的 `Humongous Allocation`、`Evacuation Failure` 是巨型对象挤占堆空间的典型信号
- 用 JFR 分配采样或 Arthas `profiler --event alloc` 找分配热点，再与访问日志按时间对齐
- 大数据量导出必须流式处理并限制并发，最好与核心链路分开部署

## 参考资料

- G1 巨型对象与调优建议：[Garbage-First Garbage Collector Tuning](https://docs.oracle.com/en/java/javase/21/gctuning/garbage-first-garbage-collector-tuning.html)
- 统一 GC 日志 `-Xlog`：[The java Command](https://docs.oracle.com/en/java/javase/21/docs/specs/man/java.html)
- `jfr view` / `jfr print`：[The jfr Command](https://docs.oracle.com/en/java/javase/21/docs/specs/man/jfr.html)
- 游标读取与 `useCursorFetch`：[MySQL Connector/J — Configuration Properties](https://dev.mysql.com/doc/connector-j/en/connector-j-reference-configuration-properties.html)
- `StreamingResponseBody` 与异步请求：[Spring MVC — Asynchronous Requests](https://docs.spring.io/spring-framework/reference/web/webmvc/mvc-ann-async.html)

> 下一篇：[CPU 飙高](./3_cpu_high)
