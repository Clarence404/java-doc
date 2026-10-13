---
description: NAS 主备切换卡住 NFS、线程进入 D 状态、Load 计入不可中断等待、导出改异步与对象存储、PSI 告警
---

# Load 高但 CPU 不高

> 前置阅读：[性能分析方法论](/high-perf/2_methodology)、[Linux 概览](/cloud-native/1_linux)

报表服务所在虚拟机 Load 冲到 130，CPU 使用率却只有 6%，导出接口全部卡死。本篇复盘一次 NFS 存储卡顿引发的「Load 高、CPU 低」，基线为 JDK 21、Spring Boot 4、Linux 内核 6.x。

---

## 一、现象

9 月 24 日 10:12 起，report-service（2 台 8 核 16GB 虚拟机，systemd 托管，导出文件写到挂载在 `/mnt/export` 的 NAS 上）陆续告警：

| 时间 | 告警 / 现象 |
|------|-------------|
| 10:12 | `NodeLoadHigh`：report-01 的 `node_load1` 为 42，是核数的 5 倍 |
| 10:15 | `HttpP99High`：「导出订单明细」接口 P99 从 3s 升到 60s（网关超时） |
| 10:18 | `TomcatThreadsBusy`：report-01 的 Tomcat 忙线程 200/200，查询类接口也开始超时 |
| 10:21 | report-02 出现同样的告警，Load 升到 131 |

值班同学登录主机，`top` 里 `%Cpu(s)` 的 `us` 只有 4～6，`id` 在 90 以上，没有任何进程 CPU 高；`df -h` 执行后卡住不返回，只能 Ctrl+C。

---

## 二、影响

- 10:12–10:58 共 46 分钟，导出功能完全不可用，约 2300 个导出任务失败，运营侧当天的对账报表延迟发出
- 10:18 起 Tomcat 线程被导出请求占满，报表查询接口成功率跌到 62%
- 无数据丢失：导出文件可以重新生成，业务库不受影响

---

## 三、排查过程

### 1、Load 到底在数什么

Linux 的平均负载统计的是**可运行（R）+ 不可中断睡眠（D）**的任务数，不只是在用 CPU 的任务。CPU 闲而 Load 高，说明大量任务卡在 D 状态：

```bash
vmstat 1 5
```

示例输出：

```text
procs -----------memory---------- ---swap-- -----io---- -system-- -------cpu-------
 r   b   swpd   free   buff  cache   si   so    bi    bo   in   cs us sy id wa st gu
 1 128      0 5123408 212344 6830112   0    0     2    18  912 1404  5  1 93  1  0  0
 0 129      0 5123120 212344 6830120   0    0     0    12  887 1366  4  1 94  1  0  0
 2 129      0 5122876 212344 6830128   0    0     0     8  903 1391  5  1 93  1  0  0
```

`r`（可运行）只有 0～2，`b`（阻塞在不可中断等待）稳定在 128 以上：Load 几乎全部来自 D 状态。`wa` 也很低，因为本机磁盘没有在忙，任务是在等别的东西。

### 2、谁在 D 状态、卡在哪

```bash
ps -eLo state,pid,tid,wchan:32,comm | awk '$1=="D"' | sort -k4 | uniq -c -f3 | sort -rn | head
```

示例输出（节选）：

```text
    126 D    2214  3871 rpc_wait_bit_killable           http-nio-8080-e
      2 D    5120  5120 rpc_wait_bit_killable           df
      1 D    5302  5302 rpc_wait_bit_killable           ls
```

126 个 Java 线程都在 `rpc_wait_bit_killable`，这是 NFS 客户端在等服务端 RPC 应答。`df`、`ls /mnt/export` 也卡在同一处，所以命令敲不出结果。随便取一个线程看内核栈（需要 root）：

```bash
cat /proc/2214/task/3871/stack
```

```text
[<0>] rpc_wait_bit_killable+0x1e/0xa0 [sunrpc]
[<0>] __rpc_execute+0x10c/0x3a0 [sunrpc]
[<0>] rpc_run_task+0x150/0x1a0 [sunrpc]
[<0>] nfs4_call_sync_sequence+0x6f/0xa0 [nfsv4]
[<0>] nfs_file_write+0x15e/0x300 [nfs]
[<0>] vfs_write+0x23d/0x400
```

### 3、Java 侧：线程栈显示的是 RUNNABLE

```bash
jcmd 2214 Thread.print | grep -A6 '"http-nio-8080-exec-1' | head -8
```

```text
"http-nio-8080-exec-17" #63 daemon prio=5 os_prio=0 cpu=812.44ms elapsed=8231.17s tid=0x00007f3a2c01a000 nid=3871 runnable
   java.lang.Thread.State: RUNNABLE
	at java.io.FileOutputStream.writeBytes(java.base@21.0.8/Native Method)
	at java.io.FileOutputStream.write(java.base@21.0.8/FileOutputStream.java:367)
	at java.io.BufferedOutputStream.flushBuffer(java.base@21.0.8/BufferedOutputStream.java:125)
	at com.example.report.export.CsvExporter.write(CsvExporter.java:96)
```

线程卡在本地方法里时，JVM 不知道它在内核里等什么，状态一律显示为 `RUNNABLE`。只看 Java 线程栈会误以为"线程在干活"，要结合 `nid` 对应的系统线程状态（D）才能看清是在等 IO。

### 4、确认 NFS 服务端

```bash
nfsstat -c -r ; grep /mnt/export /proc/mounts
```

示例输出（节选）：

```text
Client rpc stats:
calls      retrans    authrefrsh
2817341    6721       2817362

nas01:/export /mnt/export nfs4 rw,relatime,vers=4.1,hard,proto=tcp,timeo=600,retrans=2,sec=sys 0 0
```

`retrans` 在持续增长，挂载选项是 `hard`：服务端不应答时，客户端会一直重试而不是报错。与存储团队确认，10:10 NAS 做了计划内的控制器主备切换，备控制器接管 NFS 服务时卡住，直到 10:52 手动重启服务才恢复。

---

## 四、根因

1. **存储侧**：NAS 主备切换未按预期在秒级完成，NFS 服务停止应答约 42 分钟
2. **挂载方式**：`hard` 挂载下所有访问该目录的进程都会进入 D 状态一直等待，Load 随卡住的线程数线性上涨
3. **导出同步写共享存储**：导出接口在 Tomcat 请求线程里直接写 NAS，一个导出卡住就占住一个请求线程，最终把查询接口也拖垮
4. **告警只看 CPU 使用率**：CPU 告警没有触发，Load 告警阈值又按"CPU 高"的思路解读，前 10 分钟方向跑偏

---

## 五、修复

### 1、止血

- 10:25 在网关上对导出接口返回「导出功能维护中」，阻止新请求继续堆积在 NAS 上
- 10:31 两台机器滚动重启 report-service，释放被占住的 Tomcat 线程；重启前已取线程栈。`rpc_wait_bit_killable` 是可被 `SIGKILL` 打断的等待，进程能正常退出，但新进程一碰 `/mnt/export` 仍会卡住，所以先摘了导出入口再重启
- 10:52 存储团队重启 NAS 的 NFS 服务，D 状态线程陆续返回，Load 回落到 1 以下；10:58 恢复导出入口

### 2、根治

导出改为异步任务，结果写对象存储，请求线程只负责登记任务：

```java
@PostMapping("/exports")
public ExportTicket submit(@RequestBody ExportRequest req) {
    ExportTask task = exportTaskRepository.save(ExportTask.pending(req));
    exportExecutor.execute(() -> exportService.run(task.getId()));   // 独立线程池，与 Tomcat 线程隔离
    return new ExportTicket(task.getId());
}
```

- `exportExecutor` 为有界线程池（核心 8、队列 200，拒绝时返回「导出排队中，请稍后」），存储再卡住也只会占满导出池，不影响查询接口
- 文件生成后通过 S3 协议上传对象存储，SDK 设置连接、读、整体调用超时，失败按任务重试，不再依赖 NFS
- 暂时还要读 NAS 的历史文件下载接口，单独放到另一个线程池，并在调用前检查挂载点可用性

---

## 六、预防

**监控告警**：Load 告警按核数归一，并同时看 D 状态任务数与 IO 压力（PSI），而不是只看 CPU 使用率：

```yaml
- alert: NodeBlockedTasksHigh
  # 处于 D 状态的任务数，持续偏高说明在等 IO / 存储
  expr: node_procs_blocked > 20
  for: 3m
  labels: {severity: warning}
- alert: NodeIoPressureHigh
  # PSI：过去 1 分钟里有任务因等 IO 而停顿的时间占比
  expr: rate(node_pressure_io_waiting_seconds_total[1m]) > 0.3
  for: 5m
  labels: {severity: warning}
- alert: NodeLoadPerCoreHigh
  expr: node_load5 / count without (cpu, mode) (node_cpu_seconds_total{mode="idle"}) > 2
  for: 10m
  labels: {severity: warning}
```

**规范**：

- 请求线程里禁止同步访问共享文件系统；必须访问时放独立线程池并设超时
- 新服务优先用对象存储代替 NFS 共享目录；确需 NFS 的挂载清单登记到 CMDB，存储变更前通知使用方

**演练**：每季度在预发环境用 `iptables` 丢弃到 NAS 的流量，验证导出降级、告警和值班手册是否有效。

---

## 七、涉及知识点

- CPU 忙还是在等的判断：[性能分析方法论](/high-perf/2_methodology#_2、快速判断-cpu-忙还是在等)
- `vmstat`、`iostat`、`pidstat` 等命令：[Linux 排查命令速查](/handbook/1_cheatsheet/0_linux#一、负载与-cpu)
- 线程栈的读法与 `nid`：[诊断工具](/jvm/8_monitoring_tools#四、jstack-线程分析)
- 线程池隔离与有界队列：[线程池耗尽](./4_thread_pool_exhausted)
- 对象存储选型与上传：[对象存储](/architecture/5_object_storage)
- 告警规则编写与分级：[告警体系](/observability/4_alerting)

---

## 小结

- Linux 的 Load 包含 D 状态任务，「Load 高、CPU 低」先看 `vmstat` 的 `b` 列和 `ps` 里的 D 状态线程
- 用 `wchan` 和 `/proc/<pid>/task/<tid>/stack` 看任务卡在内核哪里，NFS、磁盘、内存回收各有不同的等待点
- 卡在本地 IO 的 Java 线程在线程栈里显示为 `RUNNABLE`，要结合系统线程状态判断
- 外部存储的访问要与请求线程隔离，并用 PSI、D 状态任务数补齐 CPU 之外的告警

## 参考资料

- 平均负载与 `/proc/loadavg`：[The Linux Kernel: The /proc Filesystem](https://docs.kernel.org/filesystems/proc.html)
- PSI 压力指标：[The Linux Kernel: PSI - Pressure Stall Information](https://docs.kernel.org/accounting/psi.html)
- NFS 挂载选项 `hard` / `soft` / `timeo`：[nfs(5) — Linux manual page](https://man7.org/linux/man-pages/man5/nfs.5.html)
- `vmstat` 字段说明：[vmstat(8) — Linux manual page](https://man7.org/linux/man-pages/man8/vmstat.8.html)
- 节点指标：[Prometheus node_exporter](https://github.com/prometheus/node_exporter)

> 下一篇：[数据库 CPU 被打满](./19_db_cpu_full)
