---
description: Pod 反复重启退出码 137、堆监控正常但 RSS 超 limit、NMT 核算堆外内存、调整堆比例与直接内存上限
---

# 容器被 OOMKilled

> 前置阅读：[故障排查](/jvm/9_troubleshooting)、[GC 调优](/jvm/6_gc_tuning)

订单服务大促时 Pod 反复重启，堆内存却一直健康。本篇复盘一次容器 OOMKilled，基线为 JDK 21、Spring Boot 4、Kubernetes 1.37（cgroup v2）。

---

## 一、现象

2026-09-03（周四）20:00 秋季大促开场，`order-service` 12 个副本，每个 Pod `requests` / `limits` 均为 2 CPU、2Gi 内存。

| 时间 | 现象 |
|------|------|
| 20:06 | 告警「order-service Pod 重启次数 10 分钟内 > 3」触发 |
| 20:06～20:40 | 12 个 Pod 中 9 个发生重启，单个 Pod 最多重启 4 次；每次重启后约 25 秒不可用 |
| 20:10 | 下单接口错误率 1.8%、P99 从 180ms 升到 1.4s（剩余实例负载升高 + 重启 Pod 冷启动） |
| 同期 | Grafana 上 JVM 堆使用率 55%～65%，老年代曲线平稳，GC 停顿正常；日志里没有 `OutOfMemoryError` |

值班的第一反应是「内存泄漏」，准备导 heap dump，但每次 Pod 都是瞬间消失，dump 文件一个没有。

---

## 二、影响

- **下单错误**：20:06～20:45 约 4,100 次下单失败，大部分是请求打到正在被杀的 Pod 上连接被重置
- **延迟升高**：重启风暴期间可用实例平均只有 9～10 个，其余实例 CPU 打满，下单 P99 最高 1.4s
- **连带影响**：Pod 被杀时 Kafka 消费者来不及提交位点，订单创建事件被重复消费约 2,300 条（下游幂等，未造成重复发货）
- **故障等级**：P1（大促核心链路，持续 40 分钟）

---

## 三、排查过程

### 1、确认是 OOMKilled，而不是应用自己退出

```bash
kubectl -n order get pod -l app=order-service
kubectl -n order describe pod order-service-5b7d9c8f6-tx4vp | sed -n '/Last State/,/Restart Count/p'
```

示例输出：

```text
NAME                            READY   STATUS    RESTARTS      AGE
order-service-5b7d9c8f6-tx4vp   1/1     Running   4 (3m ago)    6h
order-service-5b7d9c8f6-m8z2k   1/1     Running   3 (9m ago)    6h
order-service-5b7d9c8f6-qq7lr   1/1     Running   0             6h
...

    Last State:     Terminated
      Reason:       OOMKilled
      Exit Code:    137
      Started:      Thu, 03 Sep 2026 20:21:44 +0800
      Finished:     Thu, 03 Sep 2026 20:33:09 +0800
    Ready:          True
    Restart Count:  4
```

`Reason: OOMKilled` + `Exit Code: 137`（128 + SIGKILL 9）：**进程总内存超过 cgroup 的 `memory.max`，被内核直接杀掉**。这不是 JVM 的 `OutOfMemoryError`，所以不会有异常日志、heap dump 和 hs_err 文件，见 [故障排查 · 容器 OOMKilled](/jvm/9_troubleshooting#八、容器-oomkilled)。

### 2、对比容器内存与堆内存

```promql
# 容器工作集（kubelet 判断内存压力和 kubectl top 用的口径）
container_memory_working_set_bytes{namespace="order", container="order-service"}
# JVM 堆已提交与已使用
sum by (pod) (jvm_memory_committed_bytes{area="heap", application="order-service"})
sum by (pod) (jvm_memory_used_bytes{area="heap", application="order-service"})
```

示例读数（被杀前 1 分钟，同一个 Pod）：

| 指标 | 数值 |
|------|------|
| 容器工作集 | 1.98 GiB（limit 2 GiB） |
| 堆已提交 | 1.60 GiB |
| 堆已使用 | 0.98 GiB |

堆**使用率**只有 60%，但堆**已提交**有 1.6 GiB：G1 已经把堆扩到最大值，这部分物理内存不会还给系统。容器剩下的 0.4 GiB 要装下堆外的全部东西。

### 3、看 JVM 实际生效的参数

```bash
kubectl -n order exec order-service-5b7d9c8f6-qq7lr -- jcmd 1 VM.flags | tr ' ' '\n' | grep -E 'MaxHeapSize|MaxRAMPercentage|MaxDirectMemorySize|MaxMetaspaceSize|UseG1GC'
kubectl -n order exec order-service-5b7d9c8f6-qq7lr -- sh -c 'cat /sys/fs/cgroup/memory.max /sys/fs/cgroup/memory.current'
```

示例输出：

```text
-XX:MaxHeapSize=1719664640
-XX:MaxRAMPercentage=80.000000
-XX:+UseG1GC

2147483648
2071228416
```

- `MaxRAMPercentage=80`：最大堆 = 2 GiB × 80% ≈ 1.6 GiB，这是半年前为了「减少 Full GC」调上去的
- 没有 `MaxDirectMemorySize`：直接内存上限默认约等于最大堆，等于没有上限
- 没有 `MaxMetaspaceSize`：元空间也不封顶
- `memory.current` 已经 1.93 GiB，离 `memory.max` 只差约 76 MiB

### 4、用 NMT 核算堆外内存

NMT 只能在启动时开启，所以单独起 1 个副本，加上 `-XX:NativeMemoryTracking=summary` 启动（NMT 有约 5%～10% 的额外开销，只开在 1 个副本上），流量正常后执行：

```bash
kubectl -n order exec order-service-5b7d9c8f6-nmt01 -- jcmd 1 VM.native_memory summary scale=MB
```

示例输出（节选）：

```text
Native Memory Tracking:

Total: reserved=3412MB, committed=2042MB
       malloc: 236MB #1876543
       mmap:   reserved=3176MB, committed=1806MB

-                 Java Heap (reserved=1640MB, committed=1640MB)
-                     Class (reserved=1044MB, committed=120MB)
-                    Thread (reserved=231MB, committed=28MB)
                            (threads #224)
-                      Code (reserved=245MB, committed=60MB)
-                        GC (reserved=118MB, committed=70MB)
-                     Other (reserved=96MB, committed=96MB)
-                    Symbol (reserved=22MB, committed=22MB)
-    Shared class space (reserved=16MB, committed=6MB)
```

NMT 统计到的已提交内存合计约 2,042 MB，已经贴着 2,048 MiB 的 limit；RSS 里还有 NMT 统计不到的部分（glibc malloc arena 碎片、动态库），所以平时就在 limit 边缘。`Other` 主要是 NIO 直接缓冲区，是波动最大的一项：

```bash
kubectl -n order exec order-service-5b7d9c8f6-nmt01 -- jcmd 1 VM.native_memory summary.diff scale=MB
```

先执行一次 `jcmd 1 VM.native_memory baseline` 建立基线，大促高峰 5 分钟后执行 `summary.diff`，示例输出：

```text
-                     Other (reserved=212MB +116MB, committed=212MB +116MB)
-                    Thread (reserved=262MB +31MB, committed=33MB +5MB)
```

高峰期 `Other` 增长了 116 MB。用 Micrometer 的缓冲池指标确认来源：

```promql
jvm_buffer_memory_used_bytes{id="direct", application="order-service"}
```

直接内存在 20:00 后从 90 MB 爬到 210 MB，与「大促订单导出」定时任务（每 5 分钟一次）的执行时间吻合：导出用 WebClient（Reactor Netty）拉取商品服务数据，把整页响应聚合到一个大 `DataBuffer` 里再处理，并发 8 页时直接内存冲高。

### 5、结论

堆被设到 limit 的 80% 且已全部提交，元空间、线程栈、代码缓存、GC 结构加起来占掉剩下的空间，**大促时直接内存再冲高 100 MB 左右，进程总内存就越过 2 GiB，被内核杀掉**。堆监控只看「使用率」，看不到这个问题。

---

## 四、根因

| 层面 | 问题 |
|------|------|
| 内存规划 | `MaxRAMPercentage=80`，只给堆外留 0.4 GiB，而该服务实测堆外常驻约 0.4 GiB |
| 参数缺失 | 直接内存、元空间不封顶，堆外增长时不会先在 JVM 内部报错，而是直接撞 cgroup 上限 |
| 代码 | 订单导出把整页远端响应聚合进内存，大促数据量是平时的 6 倍 |
| 监控 | 只有堆使用率告警，没有「容器工作集 / limit」告警，也没有直接内存指标面板 |

---

## 五、修复

### 1、止血

- 20:25 暂停「大促订单导出」定时任务（配置中心开关），重启频率立刻下降
- 20:30 临时把 limit 调到 3Gi、副本扩到 16 个，JVM 参数暂不动（堆仍按 80% 计算，但 limit 变大后堆外空间翻倍）
- 20:45 重启停止，错误率回到基线；导出任务改到凌晨低峰手工执行

### 2、JVM 参数

```yaml
# Deployment 片段：limits 回到 2.5Gi，按比例算堆并给堆外封顶
resources:
  requests: { cpu: "2", memory: 2560Mi }
  limits:   { cpu: "2", memory: 2560Mi }
env:
  - name: JAVA_TOOL_OPTIONS
    value: >-
      -XX:InitialRAMPercentage=60 -XX:MaxRAMPercentage=60
      -XX:MaxDirectMemorySize=256m
      -XX:MaxMetaspaceSize=256m
      -XX:ReservedCodeCacheSize=128m
      -XX:+HeapDumpOnOutOfMemoryError -XX:HeapDumpPath=/data/dump
      -XX:+ExitOnOutOfMemoryError
```

预算核对（2,560 MiB）：

| 区域 | 预算 |
|------|------|
| 堆（60%） | 1,536 MiB |
| 元空间 + 类 | ≤ 256 MiB（实测 120） |
| 直接内存 | ≤ 256 MiB |
| 代码缓存 | ≤ 128 MiB（实测 60） |
| 线程栈 + GC + 其他 native | 约 250 MiB |
| 余量 | 约 130 MiB |

封顶之后，直接内存超限会在 JVM 内抛 `OutOfMemoryError: Direct buffer memory`，有堆栈可查，不再是无声的 SIGKILL。`InitialRAMPercentage` 与 `MaxRAMPercentage` 相同，启动即提交全部堆，内存超配问题在启动阶段就会暴露。

### 3、代码

订单导出改为流式处理，不再聚合整页响应：

```java
// 修改前：bodyToMono(String.class) 把整个响应体聚合到内存
// 修改后：按行流式解码，背压控制并发，处理完一批写一批
webClient.get()
        .uri("/internal/products/export?date={date}", date)
        .retrieve()
        .bodyToFlux(ProductLine.class)          // application/x-ndjson 按行解码
        .buffer(500)
        .concatMap(batch -> Mono.fromRunnable(() -> exportWriter.write(batch))
                .subscribeOn(Schedulers.boundedElastic()), 1)
        .blockLast(Duration.ofMinutes(10));
```

同时把 `spring.codec.max-in-memory-size` 从 64 MB 恢复到 2 MB（默认 256 KB，当初为了整页聚合才调大），避免单个响应在内存里攒成大块缓冲区。

### 4、验证

压测环境按大促峰值的 1.5 倍回放 2 小时，导出任务每 5 分钟运行一次：容器工作集稳定在 2.1～2.2 GiB（limit 2.5 GiB），直接内存峰值 140 MB，零重启。

---

## 六、预防

### 1、监控与告警

```yaml
- alert: ContainerMemoryNearLimit
  expr: |
    max by (namespace, pod, container) (container_memory_working_set_bytes{container!=""})
      / max by (namespace, pod, container) (kube_pod_container_resource_limits{resource="memory"}) > 0.9
  for: 5m
  labels: { severity: warning }
  annotations:
    summary: "{{ $labels.pod }} 内存达到 limit 的 90%，有 OOMKilled 风险"

- alert: ContainerOOMKilled
  expr: |
    increase(kube_pod_container_status_restarts_total[10m]) > 0
      and on (namespace, pod, container)
    kube_pod_container_status_last_terminated_reason{reason="OOMKilled"} == 1
  labels: { severity: critical }
  annotations:
    summary: "{{ $labels.pod }} 被 OOMKilled，检查堆外内存与 limit"
```

JVM 面板补充：堆**已提交**、元空间、直接内存（`jvm_buffer_memory_used_bytes{id="direct"}`）、线程数，与容器工作集画在同一张图上。

### 2、规范

- 服务模板默认 `MaxRAMPercentage=60`，堆外重的服务（Netty、大量线程）取 50；改成 70 以上必须附 NMT 实测数据
- `MaxDirectMemorySize`、`MaxMetaspaceSize` 必须显式设置；`requests` 与 `limits` 内存相等（Guaranteed QoS），避免节点内存压力时被优先驱逐
- 禁止把远端大响应、大文件整体读入内存，导出类功能一律流式处理
- `-XX:+ExitOnOutOfMemoryError` + 堆 dump 挂载持久卷，JVM 内 OOM 时能留下现场

### 3、测试

- 容量压测必须覆盖定时任务、导出等「低频大内存」场景，并观察容器工作集而不只是堆
- 预发环境常驻 1 个开启 NMT 的副本，发布前后对比 `summary.diff`，堆外增长超过 50 MB 需要说明原因

---

## 七、涉及知识点

| 知识点 | 文章 |
|--------|------|
| OOM 类型与容器 OOMKilled 的区别 | [故障排查 · 容器 OOMKilled](/jvm/9_troubleshooting#八、容器-oomkilled) |
| 直接内存 OOM | [故障排查 · Direct buffer memory](/jvm/9_troubleshooting#六、outofmemoryerror-direct-buffer-memory) |
| 容器感知、堆外内存构成与推荐参数 | [GC 调优 · 容器环境](/jvm/6_gc_tuning#四、容器环境) |
| NMT 与 jcmd | [诊断工具 · NMT](/jvm/8_monitoring_tools#七、nmt-native-memory-tracking) |
| 运行时内存区域 | [内存结构](/jvm/1_memory) |
| requests / limits 与 QoS | [Kubernetes · 资源模型与 QoS](/cloud-native/6_kubernetes#三、资源模型与-qos) |

---

## 小结

- `OOMKilled` + 退出码 137 是内核杀进程，没有 Java 异常和 dump，不要按堆泄漏去查
- 判断依据是容器工作集与 limit，而不是堆使用率；堆**已提交**才是堆实际占用的物理内存
- 用 NMT 的 `summary` 和 `summary.diff` 核算堆外各区域，找到增长项再对照业务时间线
- 修复组合：堆比例降到 50%～65%，直接内存、元空间显式封顶，大响应流式处理，加「工作集 / limit」告警

## 参考资料

- 容器内存限制与 OOMKilled：[Kubernetes: Assign Memory Resources to Containers and Pods](https://kubernetes.io/docs/tasks/configure-pod-container/assign-memory-resource/)
- NMT 使用方法：[Oracle: Native Memory Tracking](https://docs.oracle.com/en/java/javase/21/vm/native-memory-tracking.html)
- jcmd 命令参考：[Oracle: The jcmd Command](https://docs.oracle.com/en/java/javase/21/docs/specs/man/jcmd.html)
- JVM 参数（MaxRAMPercentage 等）：[Oracle: The java Command](https://docs.oracle.com/en/java/javase/21/docs/specs/man/java.html)
- cgroup v2 内存接口：[Linux Kernel: Control Group v2](https://docs.kernel.org/admin-guide/cgroup-v2.html)
- kube-state-metrics Pod 指标：[kube-state-metrics: Pod Metrics](https://github.com/kubernetes/kube-state-metrics/blob/main/docs/metrics/workload/pod-metrics.md)

> 下一篇：[DNS 解析超时](./16_dns_timeout)
