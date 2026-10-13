---
description: 多 SKU 加锁顺序不一致、jcmd 线程转储定位死锁、排序加锁与 tryLock、死锁告警
---

# 死锁

> 前置阅读：[故障排查](/jvm/9_troubleshooting)、[显式锁（Lock）](/java/25_topic_lock)

订单服务大促期间两个 Pod 的 Tomcat 线程全部卡死、CPU 却几乎为零，根因是本地库存预扣对多个 SKU 加锁的顺序不一致。本篇按现象、排查、根因、修复、预防完整复盘，基线为 JDK 21、Spring Boot 4。

---

## 一、现象

9 月 26 日 20:00 大促开场，新上了"主机 + 手柄"套餐（SKU 10086 + 10087）。order-service 共 6 个 Pod，Tomcat 默认 `max-threads=200`，平台线程（未开虚拟线程）。

| 时间 | 告警 / 现象 |
|------|-------------|
| 20:12 | `HttpP99High`：Pod order-service-7c9f-x2k4p 下单接口 P99 从 150ms 升到 30s（网关超时上限） |
| 20:15 | `TomcatThreadsExhausted`：同一 Pod `tomcat_threads_busy_threads` = 200 / 200，持续 3 分钟 |
| 20:19 | 第二个 Pod order-service-7c9f-m8q2w 出现同样告警；网关 504 比例 31% |
| 20:20 | 两个 Pod 的 `process_cpu_usage` 只有 0.02，GC 正常，堆使用 40% |

关键信号是**线程满、CPU 低、GC 正常**：线程不是在算，而是在等。等的对象要么是外部资源（数据库、下游 HTTP），要么是锁。同一时间数据库、Redis 和下游指标都正常，嫌疑落在 JVM 内部的锁上。

---

## 二、影响

- 20:12–20:41 共 29 分钟，两个 Pod 不再处理任何请求，网关重试把流量压到其余 4 个 Pod，整体下单 P99 升到 2.8s
- 落在卡死 Pod 上的约 4,600 笔下单请求超时失败；其中 312 笔已在 Redis 预占库存，由 15 分钟的超时释放任务回补
- K8s 存活探针走的是独立的 actuator 端口，探针线程不受影响，Pod 一直显示健康，**没有被自动重启**，这也是持续近半小时的原因

---

## 三、排查过程

### 1、确认线程卡在哪

先打一份线程转储。`jcmd` 是 JDK 推荐的统一入口，容器里 Java 进程通常是 PID 1：

```bash
kubectl exec order-service-7c9f-x2k4p -- jcmd 1 Thread.print -l > td-x2k4p-1.txt
grep -c "java.lang.Thread.State" td-x2k4p-1.txt
grep "java.lang.Thread.State" td-x2k4p-1.txt | sort | uniq -c | sort -rn
```

示例输出：

```text
263
    204 java.lang.Thread.State: WAITING (parking)
     37 java.lang.Thread.State: RUNNABLE
     16 java.lang.Thread.State: TIMED_WAITING (parking)
      6 java.lang.Thread.State: TIMED_WAITING (sleeping)
```

204 个线程处于 `WAITING (parking)`，这是 `LockSupport.park` 的状态，说明在等 `java.util.concurrent` 的锁或条件，而不是 `synchronized`（那会显示 `BLOCKED (on object monitor)`）。

### 2、让 JVM 自己判断有没有死锁

`Thread.print` 的结尾会附带 JVM 的死锁检测结果，覆盖 `synchronized` 监视器和 `ReentrantLock` 这类 ownable synchronizer：

```bash
grep -n -A30 "Found one Java-level deadlock" td-x2k4p-1.txt
```

示例输出（节选）：

```text
Found one Java-level deadlock:
=============================
"http-nio-8080-exec-17":
  waiting for ownable synchronizer 0x00000007ff3c1a28, (a java.util.concurrent.locks.ReentrantLock$NonfairSync),
  which is held by "http-nio-8080-exec-42"

"http-nio-8080-exec-42":
  waiting for ownable synchronizer 0x00000007ff3c19f0, (a java.util.concurrent.locks.ReentrantLock$NonfairSync),
  which is held by "http-nio-8080-exec-17"

Java stack information for the threads listed above:
===================================================
"http-nio-8080-exec-17":
	at jdk.internal.misc.Unsafe.park(java.base@21.0.8/Native Method)
	- parking to wait for  <0x00000007ff3c1a28> (a java.util.concurrent.locks.ReentrantLock$NonfairSync)
	at java.util.concurrent.locks.LockSupport.park(java.base@21.0.8/LockSupport.java:221)
	at java.util.concurrent.locks.AbstractQueuedSynchronizer.acquire(java.base@21.0.8/AbstractQueuedSynchronizer.java:754)
	at java.util.concurrent.locks.ReentrantLock$Sync.lock(java.base@21.0.8/ReentrantLock.java:153)
	at java.util.concurrent.locks.ReentrantLock.lock(java.base@21.0.8/ReentrantLock.java:322)
	at com.example.order.stock.LocalStockReserver.reserve(LocalStockReserver.java:48)
	at com.example.order.app.PlaceOrderService.place(PlaceOrderService.java:96)
	...
"http-nio-8080-exec-42":
	at jdk.internal.misc.Unsafe.park(java.base@21.0.8/Native Method)
	- parking to wait for  <0x00000007ff3c19f0> (a java.util.concurrent.locks.ReentrantLock$NonfairSync)
	...
	at com.example.order.stock.LocalStockReserver.reserve(LocalStockReserver.java:48)
	...

Found 1 deadlock.
```

结论很直接：exec-17 持有锁 A（`...19f0`）等锁 B（`...1a28`），exec-42 持有锁 B 等锁 A，形成环。两个线程卡在同一行代码 `LocalStockReserver.java:48`，说明是**同一段代码以不同顺序获取了两把锁**。

### 3、确认其余 200 个线程为什么也卡住

```bash
grep -B2 -A12 '"http-nio-8080-exec' td-x2k4p-1.txt | grep "parking to wait for" | sort | uniq -c | sort -rn | head -3
```

示例输出：

```text
    118 - parking to wait for  <0x00000007ff3c19f0> (a java.util.concurrent.locks.ReentrantLock$NonfairSync)
     81 - parking to wait for  <0x00000007ff3c1a28> (a java.util.concurrent.locks.ReentrantLock$NonfairSync)
      3 - parking to wait for  <0x00000007ff2e0b10> (a java.util.concurrent.locks.AbstractQueuedSynchronizer$ConditionObject)
```

其余 199 个请求线程排队在这两把锁上，锁永远不会释放，它们也就永远等下去。死锁本身只涉及 2 个线程，但只要后续请求碰到这两个热门 SKU，就会被逐个"吸"进来，直到线程池耗尽。间隔 10 秒再打一份转储对比，线程与锁地址完全不变，排除"只是锁竞争激烈"的可能。

::: tip 工具选择
Arthas 的 `thread -b` 能一键找出"阻塞了最多线程的那个线程"，但官方文档说明它目前只支持 `synchronized`，不支持 `java.util.concurrent.Lock`，本例这种 `ReentrantLock` 死锁要用 `jcmd Thread.print` 或 `jstack`。如果服务开了虚拟线程，`Thread.print` 不会列出虚拟线程，需要用 `jcmd <pid> Thread.dump_to_file -format=json <file>` 导出。
:::

### 4、对照代码

`LocalStockReserver.java:48` 附近：

```java
public void reserve(List<OrderItem> items) {
    List<Lock> held = new ArrayList<>();
    try {
        for (OrderItem item : items) {                      // 按购物车顺序遍历
            Lock lock = locks.computeIfAbsent(item.skuId(), id -> new ReentrantLock());
            lock.lock();                                    // 第 48 行：无超时
            held.add(lock);
            deduct(item);
        }
    } finally {
        held.forEach(Lock::unlock);
    }
}
```

用户 A 先加主机再加手柄，请求按 10086 → 10087 加锁；用户 B 先加手柄再加主机，按 10087 → 10086 加锁。两个请求恰好交错时，各拿一把、互等另一把。

---

## 四、根因

大促前为减轻 Redis 压力，热点 SKU 的库存改为在 Pod 内本地预扣，每个 SKU 一把 `ReentrantLock`。三个条件同时满足才触发死锁：

1. **加锁顺序不一致**：多把锁按购物车顺序获取，而购物车顺序由用户决定
2. **无超时等待**：`lock()` 永久阻塞，死锁一旦形成无法自行解开
3. **新套餐带来大量"同时含两个热点 SKU"的订单**：此前单 SKU 订单占 97%，问题一直没暴露；套餐上线后两个 SKU 高频同时出现，交错概率陡增

另外，存活探针只检查 actuator 线程是否能响应，检测不到业务线程死锁，放大了影响时长。

---

## 五、修复

### 1、止血

- 20:31 线程转储已保存，对两个卡死 Pod 逐个执行 `kubectl delete pod`（死锁不会自愈，只能重启释放）
- 20:34 配置中心关闭"热点 SKU 本地预扣"开关，下单回到 Redis Lua 扣减路径，不再走本地锁
- 20:41 新 Pod 就绪，P99 恢复到 160ms

### 2、根治

核心是**统一加锁顺序**，再加一层**超时兜底**：

```java
public void reserve(List<OrderItem> items) {
    // 1. 固定全局顺序：按 skuId 升序，任何请求都以相同顺序加锁
    List<OrderItem> sorted = items.stream()
            .sorted(Comparator.comparingLong(OrderItem::skuId))
            .toList();
    List<Lock> held = new ArrayList<>(sorted.size());
    try {
        for (OrderItem item : sorted) {
            Lock lock = locks.computeIfAbsent(item.skuId(), id -> new ReentrantLock());
            // 2. 超时兜底：拿不到就整体放弃，返回"库存繁忙"由前端重试
            if (!lock.tryLock(200, TimeUnit.MILLISECONDS)) {
                throw new StockBusyException(item.skuId());
            }
            held.add(lock);
        }
        sorted.forEach(this::deduct);
    } catch (InterruptedException e) {
        Thread.currentThread().interrupt();
        throw new StockBusyException(-1);
    } finally {
        for (int i = held.size() - 1; i >= 0; i--) {       // 逆序释放
            held.get(i).unlock();
        }
    }
}
```

复盘会上进一步决定：本地预扣只用于单 SKU 订单，多 SKU 订单直接走 Redis Lua 脚本一次性扣减多个 key，从设计上去掉"同时持有多把 JVM 锁"。

---

## 六、预防

**监控告警**：Micrometer 的 `JvmThreadDeadlockMetrics` 提供死锁线程数 gauge，默认不自动注册，需要手动绑定：

```java
@Bean
MeterBinder jvmThreadDeadlockMetrics() {
    return new JvmThreadDeadlockMetrics();
}
```

```yaml
- alert: JvmThreadDeadlock
  # 指标名以 /actuator/prometheus 实际导出为准
  expr: max by (pod) (jvm_threads_deadlocked) > 0
  for: 1m
  labels: {severity: critical}
- alert: TomcatThreadsExhausted
  expr: tomcat_threads_busy_threads / tomcat_threads_config_max_threads > 0.9 and on(pod) process_cpu_usage < 0.1
  for: 2m
  labels: {severity: critical}
```

第二条"线程满且 CPU 低"能同时覆盖死锁、连接池耗尽、下游卡死等"在等"的故障。

**探针**：死锁属于进程内部不可恢复状态，适合纳入存活探针。自定义一个 `HealthIndicator`，调用 `ThreadMXBean.findDeadlockedThreads()` 非空即返回 DOWN，并加入 `management.endpoint.health.group.liveness.include`，让 K8s 自动重启。

**代码规范**：

- 同一段代码需要多把锁时，必须按固定全局顺序（如 ID 升序）获取，逆序释放
- 请求链路禁止无超时的 `lock()`，统一用 `tryLock(timeout)`；`synchronized` 嵌套另一把锁需在 Code Review 中说明理由
- 优先缩小锁的范围或换成无锁方案（单 key 原子操作、Lua 脚本），而不是叠加锁

**测试**：增加并发单测，两组线程以相反顺序提交相同两个 SKU，跑完后断言无死锁：

```java
@Test
void reverseOrderShouldNotDeadlock() throws Exception {
    var pool = Executors.newFixedThreadPool(16);
    for (int i = 0; i < 10_000; i++) {
        boolean flip = i % 2 == 0;
        pool.submit(() -> reserver.reserve(flip ? List.of(a, b) : List.of(b, a)));
    }
    pool.shutdown();
    assertThat(pool.awaitTermination(10, TimeUnit.SECONDS)).isTrue();
    assertThat(ManagementFactory.getThreadMXBean().findDeadlockedThreads()).isNull();
}
```

修复前这个测试在本地几秒内就会卡住超时，修复后稳定通过。

---

## 七、涉及知识点

- 死锁的四个必要条件与排查方法：[故障排查](/jvm/9_troubleshooting#十一、死锁)
- `jcmd`、`jstack` 线程转储解读：[诊断工具](/jvm/8_monitoring_tools)
- `ReentrantLock`、`tryLock` 与 AQS：[显式锁（Lock）](/java/25_topic_lock)
- `synchronized` 的 monitor 与线程状态：[synchronized](/java/24_topic_synchronized)
- Arthas `thread` 命令与生产诊断：[线上诊断](/engineering/7_diagnosis)
- 存活与就绪探针的分工：[优雅上下线](/high-avail/8_graceful_release)
- 热点库存的整体方案：[热点问题](/high-con/6_hotspot)

---

## 小结

- "线程满、CPU 低、GC 正常"说明线程在等，先排外部依赖，再看 JVM 内部的锁
- `jcmd Thread.print` 末尾的 `Found one Java-level deadlock` 能直接给出环上的线程和锁；Arthas `thread -b` 不支持 `Lock` 类死锁
- 死锁只涉及少数线程，但会把后续请求逐个吸进来，最终耗尽线程池
- 根治靠固定加锁顺序 + `tryLock` 超时；能用单 key 原子操作就不要同时持有多把锁
- 死锁不会自愈，要有死锁指标告警，并让存活探针能感知它

## 参考资料

- 线程转储与挂起排查：[Java Platform, Standard Edition Troubleshooting Guide](https://docs.oracle.com/en/java/javase/21/troubleshoot/general-java-troubleshooting.html)
- `Thread.print`、`Thread.dump_to_file`：[The jcmd Command](https://docs.oracle.com/en/java/javase/21/docs/specs/man/jcmd.html)
- `findDeadlockedThreads`：[ThreadMXBean (Java SE 21)](https://docs.oracle.com/en/java/javase/21/docs/api/java.management/java/lang/management/ThreadMXBean.html)
- `tryLock` 语义：[ReentrantLock (Java SE 21)](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/concurrent/locks/ReentrantLock.html)
- `thread -b` 的适用范围：[Arthas thread 命令](https://arthas.aliyun.com/doc/thread.html)
- `JvmThreadDeadlockMetrics`：[Micrometer JVM Metrics](https://docs.micrometer.io/micrometer/reference/reference/jvm.html)
- 存活探针不应依赖外部系统：[Spring Boot Actuator — Kubernetes Probes](https://docs.spring.io/spring-boot/reference/actuator/endpoints.html#actuator.endpoints.kubernetes-probes)

> 下一篇：[慢 SQL 拖垮连接池](./6_slow_sql_pool)
