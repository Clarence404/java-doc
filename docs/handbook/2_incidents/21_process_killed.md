---
description: 进程无痕退出、退出痕迹对照、dmesg 读 OOM Killer、systemd 线索、SIGKILL 来源、自动拉起
---

# Java 进程突然消失

> 前置阅读：[Linux 概览](/cloud-native/1_linux)、[容器被 OOMKilled](./15_oom_killed)

结算服务凌晨无声退出，没有异常、hs_err 和 dump。本篇按「进程是怎么死的」逐一排除，定位到宿主机的内核 OOM Killer，基线为 JDK 21、Spring Boot 4、Linux 内核 6.x。

---

## 一、现象

settlement-service 部署在一台 16GB 内存的虚拟机上（systemd 托管，`-Xms12g -Xmx12g`，无 swap），每天 02:30 跑商户日结批处理。10 月 12 日：

| 时间 | 现象 |
|------|------|
| 02:10:37 | 应用日志最后一行是定时任务的心跳 INFO，之后再无输出 |
| 02:30 | 日结批处理没有启动，没有任何告警 |
| 07:40 | 运营发现商户结算单未生成，值班同学登录主机，`jps` 里已经没有该进程 |

工作目录下没有 `hs_err_pid*.log`，dump 目录为空，日志里也没有 `OutOfMemoryError` 和 Spring 的优雅停机日志。

---

## 二、影响

- 进程从 02:10 到 07:45 停止约 5.5 小时，当日 1.8 万个商户的结算单推迟约 7 小时生成，打款批次顺延到下午
- 监控只覆盖白天的 HTTP 接口和批处理耗时，进程不在时既没有请求也没有批处理指标，没有任何告警触发
- 无数据错乱：批处理按日期幂等，补跑后结果与预期一致

---

## 三、排查过程

### 1、先列出「进程会怎么死」

Java 进程退出的方式不多，每种都会留下不同的痕迹，按表逐项排除：

| 退出方式 | 典型痕迹 | 退出码 / 信号 |
|----------|----------|---------------|
| JVM 自身崩溃（本地代码段错误、JIT 缺陷等） | 工作目录或 `-XX:ErrorFile` 指定位置有 `hs_err_pid<pid>.log`，可能有 core 文件 | 信号 6（SIGABRT），退出码 134 |
| 堆 OOM 后主动退出 | 日志有 `Terminating due to java.lang.OutOfMemoryError`（启用 `ExitOnOutOfMemoryError` 时） | 退出码 3 |
| 代码调用 `System.exit` | shutdown hook 执行，有 Spring 关闭日志 | 代码指定 |
| 收到 SIGTERM（`kill`、`systemctl stop`） | 有优雅停机日志 `Commencing graceful shutdown` | 信号 15，退出码 143 |
| 收到 SIGKILL | **什么都不留**：JVM 来不及做任何事 | 信号 9，退出码 137 |

现场没有 hs_err、没有关闭日志，最可能是 SIGKILL，接下来要找发信号的是谁。

### 2、看 systemd 记录的退出方式

```bash
journalctl -u settlement --since "2026-10-12 02:00" --until "2026-10-12 02:20" --no-pager
```

示例输出：

```text
Oct 12 02:10:37 settle-01 systemd[1]: settlement.service: A process of this unit has been killed by the OOM killer.
Oct 12 02:10:37 settle-01 systemd[1]: settlement.service: Main process exited, code=killed, status=9/KILL
Oct 12 02:10:37 settle-01 systemd[1]: settlement.service: Failed with result 'oom-kill'.
Oct 12 02:10:37 settle-01 systemd[1]: settlement.service: Consumed 3d 4h 12min CPU time, 13.1G memory peak.
```

`status=9/KILL` 确认是 SIGKILL，systemd 还给出了结果 `oom-kill`。单元文件里是默认的 `Restart=no`，所以没有被拉起。

### 3、读内核 OOM Killer 的记录

```bash
journalctl -k --since "2026-10-12 02:09" --until "2026-10-12 02:12" --no-pager | grep -E 'invoked oom-killer|\] java$|python3$|oom-kill:|Killed process'
```

示例输出（节选）：

```text
Oct 12 02:10:37 settle-01 kernel: python3 invoked oom-killer: gfp_mask=0x140cca(GFP_HIGHUSER_MOVABLE|__GFP_COMP), order=0, oom_score_adj=0
Oct 12 02:10:37 settle-01 kernel: [   2143]  1001  2143  4705853  3437080  3436512      568         0 27959296        0             0 java
Oct 12 02:10:37 settle-01 kernel: [  91820]  1002 91820  1012442   941023   940871      152         0  7802880        0             0 python3
Oct 12 02:10:37 settle-01 kernel: oom-kill:constraint=CONSTRAINT_NONE,nodemask=(null),cpuset=/,mems_allowed=0,global_oom,task_memcg=/system.slice/settlement.service,task=java,pid=2143,uid=1001
Oct 12 02:10:37 settle-01 kernel: Out of memory: Killed process 2143 (java) total-vm:18823412kB, anon-rss:13746048kB, file-rss:2272kB, shmem-rss:0kB, UID:1001 pgtables:27304kB oom_score_adj:0
```

几个关键信息：

- **谁触发**：`python3 invoked oom-killer`，是 python3 申请内存时整机内存不足
- **是哪一级的 OOM**：`constraint=CONSTRAINT_NONE` 加 `global_oom` 说明是整机内存耗尽；如果是 cgroup 限额触发，会显示 `CONSTRAINT_MEMCG`（这正是容器 OOMKilled 的情况）
- **杀了谁**：进程表里 `rss` 单位是页（4KB），java 约 13.1GB、python3 约 3.6GB。内核按 `oom_score`（主要看内存占用，再叠加 `oom_score_adj`）选择，占用最大的 java 被杀，尽管它不是这次增长的来源

### 4、python3 是从哪来的

```bash
grep -rn python3 /etc/cron.d/ /var/spool/cron/ 2>/dev/null
```

```text
/etc/cron.d/recon-export:1:0 2 * * * recon /opt/recon/.venv/bin/python3 /opt/recon/export_daily.py
```

数据组 10 月 10 日在这台机器上新增了一个对账导出脚本，用 pandas 一次性把前一天的流水读进内存。前两天流水量小，峰值约 2GB；10 月 11 日是活动日，流水量翻倍，脚本峰值涨到 3.6GB。

整机账目：java 常驻约 13.1GB（12GB 堆因 `-Xms` 等于 `-Xmx` 且运行多日已全部提交，加上元空间、线程栈、代码缓存等约 1.1GB）+ python3 3.6GB + 系统与其他进程约 0.7GB，超过 16GB，且没有 swap 可用。

### 5、如果不是内核杀的

本次证据很完整。若 `dmesg` 里查不到 OOM 记录，SIGKILL 还可能来自：

- **用户态 OOM 守护进程**：部分发行版默认启用 `systemd-oomd`，按内存压力杀整个 cgroup，记录在 `journalctl -u systemd-oomd`
- **systemd 停止超时**：`systemctl stop` 后超过 `TimeoutStopSec` 仍未退出，systemd 会补发 SIGKILL，日志里先有 `Stopping`，再有 `State 'stop-sigterm' timed out. Killing.`
- **人或脚本 `kill -9`**：事后很难追查，可提前用 auditd 记录所有 SIGKILL。注意信号参数的位置不同——`kill` / `tkill` 的信号是第 2 个参数 `a1`，`tgkill` 是第 3 个参数 `a2`，要拆成两条规则：`auditctl -a always,exit -F arch=b64 -S kill,tkill -F a1=9 -k sigkill` 和 `auditctl -a always,exit -F arch=b64 -S tgkill -F a2=9 -k sigkill`，再用 `ausearch -k sigkill` 查发送方

---

## 四、根因

1. **整机内存超卖**：Java 进程常驻 13.1GB，只给系统和其他进程留了不到 3GB；同机新增的导出脚本峰值 3.6GB，叠加后触发整机 OOM
2. **OOM Killer 杀的是最大的进程**：内核挑的是占用最多的 java，而不是引起内存增长的脚本
3. **变更没有经过容量评估**：在生产应用主机上新增定时脚本，没有登记、没有评估内存
4. **进程退出既不拉起也不告警**：systemd 为 `Restart=no`；告警依赖业务流量，夜间进程不在时无指标、无告警

---

## 五、修复

### 1、止血

- 07:45 `systemctl start settlement` 启动服务，暂停 recon-export 的 cron
- 08:10 手动触发 10 月 11 日的日结批处理，09:30 全部商户结算单生成，打款批次在下午补发

### 2、根治

对账脚本迁到数据平台的独立执行节点，不再与应用混部。应用的 systemd 单元补上自动拉起、OOM 优先级和崩溃现场：

```ini
[Service]
ExecStart=/usr/bin/java -Xms10g -Xmx10g \
  -XX:ErrorFile=/data/logs/hs_err_pid%p.log \
  -XX:+HeapDumpOnOutOfMemoryError -XX:HeapDumpPath=/data/dump/ \
  -jar /opt/settlement/app.jar
Restart=on-failure
RestartSec=10
# 降低被内核 OOM Killer 选中的优先级（-1000～1000，越小越不容易被杀）
OOMScoreAdjust=-500
```

- 堆从 12GB 降到 10GB，整机留出约 4GB 给系统、页缓存和运维工具；依据是 GC 日志中老年代峰值约 6GB
- 确需在应用主机上执行的临时任务，统一用 `systemd-run -p MemoryMax=1G` 包一层，超限时只杀任务本身

::: tip OOMScoreAdjust 不是免死金牌
调低主服务的 `oom_score_adj` 只是让内核优先杀别的进程；内存真不够时，sshd、监控 agent 也可能被杀。根本手段仍是给每个进程留足预算，并用 cgroup 给非核心任务设上限。
:::

---

## 六、预防

**监控告警**：

```yaml
- alert: NodeOomKillDetected
  # 内核 OOM Killer 每杀一个进程计数加 1
  expr: increase(node_vmstat_oom_kill[5m]) > 0
  labels: {severity: critical}
- alert: NodeMemoryAvailableLow
  expr: node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes < 0.10
  for: 5m
  labels: {severity: warning}
- alert: SettlementDown
  # 不依赖业务流量：抓取失败即说明进程不在
  expr: up{job="settlement"} == 0
  for: 2m
  labels: {severity: critical}
```

- 批处理增加「应该发生却没发生」的告警：日结任务完成后上报时间戳，超过 03:30 未更新即告警

**规范**：

- 生产应用主机禁止随意增加 cron 任务，新增需登记并写明内存与 CPU 预算
- JVM 内存规划按「堆 + 非堆 + 系统预留」整体核算，单机部署时堆不超过物理内存的 60%～65%
- 所有 Java 服务的启动参数统一带 `ErrorFile`、OOM dump 与自动拉起配置

**演练**：在预发环境用 `stress-ng --vm` 制造整机内存压力，验证 OOM 告警、自动拉起和值班手册。

---

## 七、涉及知识点

- 信号、退出码与 `kill -15` / `kill -9`：[Linux 概览](/cloud-native/1_linux#五、进程与信号)
- systemd 托管 Java 服务与 journalctl：[Linux 概览](/cloud-native/1_linux#三、systemd-与-journalctl)
- 内核 OOM 与容器 OOMKilled 的区别：[故障排查](/jvm/9_troubleshooting#八、容器-oomkilled)
- JVM 内存构成与堆外内存核算：[容器被 OOMKilled](./15_oom_killed)
- 堆大小与物理内存的配比：[GC 调优 · 容器环境](/jvm/6_gc_tuning#四、容器环境)
- OOM 查看命令：[Linux 排查命令速查](/handbook/1_cheatsheet/0_linux#二、内存)

---

## 小结

- 进程消失先对照退出痕迹：有 hs_err 是 JVM 崩溃，有关闭日志是 SIGTERM，什么都没有基本是 SIGKILL
- `journalctl -u` 看 systemd 记录的信号和结果，`journalctl -k` / `dmesg` 看内核 OOM Killer 的完整报告
- OOM 报告里 `global_oom` 是整机内存耗尽，`CONSTRAINT_MEMCG` 是 cgroup 限额；被杀的是占用最大的进程，不一定是肇事者
- 单机部署要给系统和其他进程留足内存，并配好自动拉起、OOM 计数告警和「任务未发生」告警

## 参考资料

- 内存超分策略：[The Linux Kernel: Overcommit Accounting](https://docs.kernel.org/mm/overcommit-accounting.html)
- `oom_score` 与 `oom_score_adj`：[The Linux Kernel: The /proc Filesystem](https://docs.kernel.org/filesystems/proc.html)
- cgroup v2 的 `memory.events` 与 `oom_kill`：[The Linux Kernel: Control Group v2](https://docs.kernel.org/admin-guide/cgroup-v2.html)
- `Restart=`、`OOMScoreAdjust=`：[systemd.service(5)](https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html)、[systemd.exec(5)](https://www.freedesktop.org/software/systemd/man/latest/systemd.exec.html)
- `-XX:ErrorFile` 与致命错误日志：[Oracle: Fatal Error Log](https://docs.oracle.com/en/java/javase/21/troubleshoot/fatal-error-log.html)

> 下一篇：[启动后 RT 飙高](./22_warmup_rt)
