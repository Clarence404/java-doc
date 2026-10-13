---
description: 负载与 CPU、内存与 cgroup、磁盘、网络、进程与 fd、日志检索、Java 进程
---

# Linux 排查命令速查

> 前置阅读：[Linux 概览](/cloud-native/1_linux)、[性能分析方法论](/high-perf/2_methodology)

线上排查最常用的 Linux 命令，按资源分组，复制后替换 `<pid>` 等占位符即可执行。本篇只列命令，排查方法与原理见前置阅读，基线为启用 cgroup v2 的主流发行版。

---

## 一、负载与 CPU

| 场景 | 命令 | 说明 |
|------|------|------|
| 看负载 | `uptime` | 1 / 5 / 15 分钟平均负载，与 `nproc` 的核数对比 |
| 看核数 | `nproc` | 容器内返回的是可用 CPU 数（受 cpuset 限制） |
| 实时总览 | `top -c` | `-c` 显示完整命令行；按 `P` 按 CPU 排序、`M` 按内存排序、`1` 展开每个核 |
| 运行队列与上下文切换 | `vmstat 1 5` | 每秒采样 5 次；看 `r`（运行队列）、`cs`（上下文切换）、`us` / `sy` / `wa` / `st` |
| 每个核的使用率 | `mpstat -P ALL 1 3` | 发现单核打满（单线程瓶颈、软中断集中）；来自 sysstat 包 |
| 按进程看 CPU | `pidstat -u 1 5` | 每秒输出各进程的 `%usr` / `%system`；来自 sysstat 包 |
| CPU 最高的进程 | `ps -eo pid,user,%cpu,%mem,etime,cmd --sort=-%cpu \| head` | 一次性快照，适合贴进工单 |
| 进程内最忙的线程 | `top -Hp <pid>` | 线程 ID 为十进制；JDK 18+ 线程栈的 `nid` 也是十进制，可直接搜 |
| 线程快照排序 | `ps -L -p <pid> -o tid,pcpu,comm --sort=-pcpu \| head` | 不进交互界面，便于脚本采集 |
| 容器 CPU 被限流 | `cat /sys/fs/cgroup/cpu.stat` | `nr_throttled` / `throttled_usec` 持续增长说明 CPU limit 不够 |

---

## 二、内存

| 场景 | 命令 | 说明 |
|------|------|------|
| 内存总览 | `free -h` | 看 `available` 而不是 `free`，buff/cache 可回收 |
| 是否在换页 | `vmstat 1 5` | `si` / `so` 持续非零说明在使用 swap |
| 内存最高的进程 | `ps -eo pid,user,rss,%mem,cmd --sort=-rss \| head` | `rss` 单位 KB |
| 进程常驻内存与线程数 | `grep -E 'VmRSS\|Threads' /proc/<pid>/status` | 线程数异常增长时配合线程栈排查 |
| 进程内存段分布 | `pmap -x <pid> \| sort -k3 -n -r \| head -20` | 第 3 列为 RSS，用于排查堆外内存 |
| 是否被 OOM Killer 杀掉 | `dmesg -T \| grep -i -E 'out of memory\|killed process'` | 主机层面的 OOM 记录 |
| 用 journal 查内核 OOM | `journalctl -k --since "1 hour ago" \| grep -i oom` | `dmesg` 被轮转或无权限时使用 |
| 容器内存上限与当前用量 | `cat /sys/fs/cgroup/memory.max /sys/fs/cgroup/memory.current` | cgroup v2 路径，单位字节；`max` 表示无限制 |
| 容器 OOM 次数 | `cat /sys/fs/cgroup/memory.events` | `oom_kill` 计数大于 0 说明容器内发生过 OOM Kill |

---

## 三、磁盘与文件

| 场景 | 命令 | 说明 |
|------|------|------|
| 磁盘空间 | `df -h` | 各挂载点使用率 |
| inode 是否耗尽 | `df -i` | 空间够但写不进文件时检查，多见于海量小文件 |
| 找大目录 | `du -xh --max-depth=1 /var \| sort -rh \| head` | `-x` 不跨文件系统 |
| 找大文件 | `find /var/log -xdev -type f -size +500M -exec ls -lh {} +` | 只列出，不删除 |
| 已删除但仍被占用的文件 | `lsof +L1` | `df` 满而 `du` 统计不到时的常见原因 |
| 清空日志但保留文件句柄 | `truncate -s 0 /var/log/app/app.log` | 进程继续写同一个文件，空间立即释放；不要直接 `rm` 正在写的日志 |
| 磁盘 IO 繁忙度 | `iostat -xz 1 3` | 看 `%util`、`r_await` / `w_await`、`aqu-sz`；来自 sysstat 包 |
| 哪个进程在读写 | `iotop -o` | 只显示有 IO 的进程，需要 root |
| 按进程看 IO | `pidstat -d -p <pid> 1 5` | 每秒读写 KB 数 |

---

## 四、网络

| 场景 | 命令 | 说明 |
|------|------|------|
| 监听端口与进程 | `ss -lntp` | 替代已弃用的 `netstat -lntp`；看进程名需要 root |
| 连接状态汇总 | `ss -s` | 各状态 TCP 连接总数 |
| 按状态统计连接数 | `ss -Htan \| awk '{print $1}' \| sort \| uniq -c \| sort -rn` | `TIME-WAIT`、`CLOSE-WAIT` 异常多时深入排查 |
| 到某个端口的连接数 | `ss -Htan state established '( dport = :3306 )' \| wc -l` | 对照连接池上限判断是否打满 |
| 某个进程的连接 | `ss -tnp \| grep "pid=<pid>,"` | 列出该进程的全部 TCP 连接 |
| 端口被谁占用 | `lsof -i :8080` | 启动报 `Address already in use` 时使用 |
| 全连接队列溢出 | `nstat -az TcpExtListenOverflows TcpExtListenDrops` | 计数增长说明 accept 不过来，结合 `ss -lnt` 的 `Recv-Q` 看 |
| 重传 | `nstat -az TcpRetransSegs` | 两次采样的差值即这段时间的重传段数 |
| 网卡丢包与错误 | `ip -s link` | `dropped` / `errors` 持续增长需要排查网卡或驱动 |
| 地址与路由 | `ip addr`、`ip route` | 替代 `ifconfig` / `route` |
| 端口是否可达 | `nc -zv <host> 3306` | 快速区分网络不通与应用不响应 |
| DNS 解析 | `dig +short <domain>` | 容器内没有 `dig` 时用 `getent hosts <domain>` |
| HTTP 分阶段耗时 | `curl -o /dev/null -s -w 'dns:%{time_namelookup} conn:%{time_connect} tls:%{time_appconnect} ttfb:%{time_starttransfer} total:%{time_total}\n' https://<host>/` | 定位慢在 DNS、建连、TLS 还是服务端处理 |
| 查看请求与响应头 | `curl -sv -o /dev/null https://<host>/` | 证书、重定向、响应码一目了然 |
| 链路丢包与延迟 | `mtr -rwc 20 <host>` | 逐跳统计，报告模式输出 20 次采样结果 |
| 抓包 | `tcpdump -i any -nn -c 2000 -w /tmp/cap.pcap port 8080` | 限定包数和端口，抓完用 Wireshark 分析 |

---

## 五、进程、线程与文件描述符

| 场景 | 命令 | 说明 |
|------|------|------|
| 找进程 | `pgrep -af java` | 列出 PID 与完整命令行 |
| 进程树 | `ps -ef --forest` | 看父子关系，排查僵尸进程和重复启动 |
| 已打开的 fd 数 | `ls /proc/<pid>/fd \| wc -l` | 与下一行的上限对比 |
| 进程实际的 fd 上限 | `grep 'open files' /proc/<pid>/limits` | 以进程实际生效值为准，不看 `ulimit -n` |
| 打开的文件与连接 | `lsof -p <pid>` | 输出很长，配合 `grep` 或 `wc -l` |
| 卡在哪个系统调用 | `strace -f -p <pid> -T -e trace=network -o /tmp/strace.log` | 会显著拖慢进程，只短时间采样 |
| 系统调用次数汇总 | `strace -c -f -p <pid>` | 按 Ctrl+C 结束后输出统计 |
| 优雅停止进程 | `kill -15 <pid>` | 先发 SIGTERM，超时仍不退出再 `kill -9` |
| 服务状态 | `systemctl status <service>` | 运行状态、最近日志、主 PID |
| 服务日志 | `journalctl -u <service> --since "10 min ago" -f` | 只看该服务最近 10 分钟并持续跟随 |

---

## 六、日志检索

| 场景 | 命令 | 说明 |
|------|------|------|
| 跟随日志 | `tail -F app.log` | `-F` 在日志轮转后自动跟到新文件 |
| 带上下文搜错误 | `grep -n -C 5 'ERROR' app.log` | 前后各 5 行，带行号 |
| 统计错误次数 | `grep -c 'OrderTimeoutException' app.log` | 只输出匹配行数 |
| 搜压缩的历史日志 | `zgrep -n 'traceId=7f3a9c' app.log.*.gz` | 不用先解压 |
| 按 traceId 串起一次请求 | `grep -h 'traceId=7f3a9c' app.log app.log.1 \| sort` | 多个文件合并后按时间排序 |
| 截取时间段 | `sed -n '/2026-10-13 14:00/,/2026-10-13 14:05/p' app.log` | 起止字符串需在日志中真实存在 |
| 错误类型排行 | `grep -o '[A-Za-z.]*Exception' app.log \| sort \| uniq -c \| sort -rn \| head` | 快速判断主要异常 |
| 访问日志状态码分布 | `awk '{print $9}' access.log \| sort \| uniq -c \| sort -rn` | 适用于 Nginx 默认 combined 格式 |
| 访问量最大的 IP | `awk '{print $1}' access.log \| sort \| uniq -c \| sort -rn \| head` | 排查刷接口与爬虫 |
| 分页浏览大文件 | `less +F app.log` | Ctrl+C 停止跟随后可用 `/` 搜索，`F` 恢复跟随 |

---

## 七、Java 进程

| 场景 | 命令 | 说明 |
|------|------|------|
| 列出 JVM 进程 | `jps -lv` | 主类与 JVM 参数；容器内也可用 `jcmd -l` |
| 线程栈 | `jcmd <pid> Thread.print > /tmp/threads.txt` | 间隔几秒连续采 3 次再对比 |
| 线程 ID 转十六进制 | `printf '%x\n' <tid>` | 仅 JDK 17 及更早需要：那时线程栈里的 `nid` 是十六进制 |
| 堆概况 | `jcmd <pid> GC.heap_info` | 各代容量与使用量 |
| GC 实时统计 | `jstat -gcutil <pid> 1000 10` | 每秒一次共 10 次；关注 `O` 与 `FGC` 增长 |
| 堆转储 | `jcmd <pid> GC.heap_dump /tmp/heap.hprof` | 会停顿应用，先摘流量并确认磁盘空间 |
| 实际生效的 JVM 参数 | `jcmd <pid> VM.flags` | 核对堆大小、GC 选择 |
| 堆外内存分布 | `jcmd <pid> VM.native_memory summary` | 需启动时加 `-XX:NativeMemoryTracking=summary` |
| 开启 JFR 录制 | `jcmd <pid> JFR.start duration=60s filename=/tmp/app.jfr` | 低开销，录制结束自动写文件 |

工具的输出怎么读见 [诊断工具](/jvm/8_monitoring_tools)，OOM、CPU 飙高、死锁的完整排查流程见 [故障排查](/jvm/9_troubleshooting)。

---

## 小结

最该记住的 5 条：

- `top -Hp <pid>` + `jcmd <pid> Thread.print`：定位 Java 进程的高 CPU 线程（JDK 18+ 直接按十进制 `nid` 搜）
- `vmstat 1 5`：一条命令同时看运行队列、换页、IO 等待
- `ss -s` 与 `ss -lntp`：连接状态汇总、监听端口与进程
- `df -h` + `lsof +L1`：磁盘满时区分真实占用与已删除未释放的文件
- `dmesg -T | grep -i -E 'out of memory|killed process'`：确认进程是否被 OOM Killer 杀掉

## 参考资料

- 进程与线程信息：[ps(1) - Linux manual page](https://man7.org/linux/man-pages/man1/ps.1.html)
- 套接字统计：[ss(8) - Linux manual page](https://man7.org/linux/man-pages/man8/ss.8.html)
- 网络计数器：[nstat(8) - Linux manual page](https://man7.org/linux/man-pages/man8/nstat.8.html)
- 打开的文件：[lsof(8) - Linux manual page](https://man7.org/linux/man-pages/man8/lsof.8.html)
- 系统调用跟踪：[strace(1) - Linux manual page](https://man7.org/linux/man-pages/man1/strace.1.html)
- proc 文件系统：[proc(5) - Linux manual page](https://man7.org/linux/man-pages/man5/proc.5.html)
- cgroup v2 接口文件：[Control Group v2](https://docs.kernel.org/admin-guide/cgroup-v2.html)
- sysstat 工具集：[sysstat 项目](https://sysstat.github.io/)
- curl 写出变量：[curl --write-out](https://curl.se/docs/manpage.html#-w)
- jcmd 命令：[The jcmd Command（JDK 21）](https://docs.oracle.com/en/java/javase/21/docs/specs/man/jcmd.html)

> 下一篇：[Git 命令速查](./1_git)
