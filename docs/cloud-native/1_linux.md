---
description: Unix 渊源与 GPL、常用命令、systemd 与日志、权限、信号、文件描述符、排查命令
---

# Linux 概览

Linux 是后端服务最主要的运行环境。本篇从 Unix、GNU、Minix 的演化讲起，覆盖 systemd 与 journalctl、文件权限、进程信号、文件描述符限制，以及按资源定位问题的排查命令。

---

## 一、从 Unix 到 Linux

![从 Unix 到 GNU/Linux](../assets/cloud-native/linux-lineage.svg)

### 1、Unix 与它的分裂

1969 年，贝尔实验室的 Ken Thompson 和 Dennis Ritchie 开发了 Unix（最初叫 UNICS）。1973 年 Unix 用 C 语言重写，从此可以较低成本地移植到不同硬件上。它奠定的几条设计理念至今仍是 Linux 的底色：

- **多用户、多任务**：多个用户同时登录，多个进程并发运行
- **一切皆文件**：设备、管道、Socket 都通过文件描述符读写
- **小工具组合**：每个程序只做一件事，用管道把它们串起来

Unix 的源码授权给大学和厂商后，分化成两条主线：加州大学伯克利分校的 **BSD**（贡献了 TCP/IP 协议栈、`vi`、`csh`，后代包括 FreeBSD 和 macOS 的内核部分），以及 AT&T 的商业主线 **System V**（Solaris、AIX、HP-UX 等商业 Unix 都与它有渊源）。随着商业化加深，Unix 源码不再能自由获取和修改。

### 2、GNU 计划与 Minix

- **GNU 计划（1983）**：Richard Stallman 发起，目标是做一套完全自由的类 Unix 系统，并为此制定了 GPL 许可证。到 1990 年代初，GNU 已经有了 `gcc`、`glibc`、`bash`、coreutils 等用户态组件，唯独缺一个可用的内核
- **Minix（1987）**：Andrew S. Tanenbaum 为操作系统教学编写的类 Unix 系统，采用微内核架构，源码随教材发布，但当时的许可证不允许自由修改和再分发（MINIX 3 起才改为 BSD 式许可证）

### 3、Linux 的诞生

1991 年 8 月，芬兰大学生 Linus Torvalds 在 comp.os.minix 新闻组宣布自己正在写一个「只是爱好」的内核，同年 9 月发布 0.01 版，运行在 Intel 386 上。最初的许可证禁止商业使用，1992 年的 0.12 版起改用 **GNU GPL v2**，此后吸引了全球开发者参与；今天内核的许可证仍是 GPL-2.0-only。

与前辈相比：

- **与 Unix**：没有使用 Unix 源码，是从零编写的内核，但遵循 Unix 的接口与设计哲学（后来以 POSIX 为兼容目标）
- **与 Minix**：Linux 采用宏内核（Monolithic Kernel），驱动和文件系统运行在内核态，通过可加载模块保持扩展性；Minix 是微内核
- **与 GNU**：Linux 只是内核，Linux 内核 + GNU 工具链才构成一个可用的操作系统，因此也被称为 GNU/Linux

| 系统 | 诞生 | 主要开发者 | 许可证 | 对 Linux 的影响 |
|------|------|-----------|--------|----------------|
| Unix | 1969 | Ken Thompson、Dennis Ritchie | 专有 | 设计理念与系统接口 |
| BSD | 1977 | 加州大学伯克利分校 | BSD 许可证 | TCP/IP、`vi` 等工具 |
| GNU | 1983 | Richard Stallman / FSF | GPL | 编译器、C 库、Shell 等用户态 |
| Minix | 1987 | Andrew S. Tanenbaum | 早期受限，MINIX 3 起为 BSD 式 | 直接启发了 Linux 的诞生 |
| Linux | 1991 | Linus Torvalds | GPL-2.0-only | — |

### 4、关键节点

- **1992–1993 年**：SUSE（1992）、Slackware 与 Debian（1993）、Red Hat（1993）相继出现，内核 + GNU + 包管理被整合成发行版
- **2004 年**：Ubuntu 发布，降低了 Linux 的使用门槛
- **2008 年前后**：内核引入 cgroups，配合已有的 namespace，成为后来容器技术的基础（见 [Docker](./5_docker)）
- **2010 年代**：systemd 逐步成为主流发行版的默认 init 系统；Android 让 Linux 内核进入移动设备
- **2020–2021 年**：CentOS 转向 Stream，Rocky Linux、AlmaLinux 成为 RHEL 兼容的免费替代

发行版的派系、差异与选型见下一篇 [Linux 发行版](./2_linux_distros)。

---

## 二、日常命令速查

| 类别 | 命令 | 说明 |
|------|------|------|
| 目录与文件 | `ls -lh`、`cd`、`pwd`、`cp -r`、`mv`、`rm`、`mkdir -p` | 浏览与增删改 |
| 查找 | `find /data/logs -name "*.log" -mtime +7`、`which java` | 按条件找文件、找命令路径 |
| 查看内容 | `cat`、`less`、`head -n 100`、`tail -f app.log` | `less +F` 可在跟踪与翻页之间切换 |
| 文本处理 | `grep -n "ERROR" app.log`、`awk`、`sed`、`sort \| uniq -c`、`wc -l` | 日志统计的主力组合 |
| 磁盘 | `df -h`、`df -i`、`du -sh /var/log/* \| sort -h` | 空间与 inode 用量 |
| 压缩 | `tar -czf logs.tar.gz logs/`、`tar -xzf logs.tar.gz`、`unzip` | 打包与解包 |
| 用户 | `id`、`whoami`、`sudo -u app <cmd>`、`passwd` | 身份与提权 |
| 网络配置 | `ip addr`、`ip route`、`ip link` | iproute2，替代已弃用的 `ifconfig` / `route` |
| 定时任务 | `crontab -e`、`crontab -l`、`systemctl list-timers` | cron 守护进程或 systemd timer |
| 历史 | `history`、`alias ll='ls -lh'` | 写入 `~/.bashrc` 持久生效 |

---

## 三、systemd 与 journalctl

主流发行版（RHEL 系、Debian / Ubuntu、SUSE）都用 **systemd** 作为 1 号进程，负责启动、停止、重启和监管服务，日志由配套的 journald 收集。

### 1、常用命令

```bash
systemctl status order            # 查看状态、主进程 PID 与最近日志
systemctl start|stop|restart order
systemctl enable --now order      # 开机自启并立即启动
systemctl daemon-reload           # 修改 unit 文件后必须执行
systemctl list-units --failed     # 列出启动失败的服务
systemctl cat order               # 查看最终生效的 unit 内容
```

### 2、把 Java 服务注册为 systemd 服务

裸机或虚拟机上部署 Spring Boot jar 时，用 systemd 托管比 `nohup java -jar &` 可靠：崩溃自动拉起、开机自启、日志统一进 journal、停机信号可控。

```ini
# /etc/systemd/system/order.service
[Unit]
Description=Order Service
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=app
Group=app
WorkingDirectory=/opt/order
ExecStart=/usr/bin/java -XX:MaxRAMPercentage=70 -jar /opt/order/order.jar
# JVM 收到 SIGTERM 后以 143（128+15）退出，声明为正常退出
SuccessExitStatus=143
Restart=on-failure
RestartSec=5
# 停机时先发 SIGTERM，40 秒内未退出再发 SIGKILL
TimeoutStopSec=40
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now order
```

- `ExecStart` 中的 `java` 路径按实际 JDK 安装位置填写（可用 `readlink -f "$(which java)"` 查看）
- `TimeoutStopSec` 要大于 Spring Boot 的 `spring.lifecycle.timeout-per-shutdown-phase`，否则优雅停机还没完成就被强杀，见 [优雅上下线与变更](/high-avail/8_graceful_release)
- `LimitNOFILE` 是 systemd 服务的文件描述符上限，`/etc/security/limits.conf` 对它不生效（见下文第六节）

### 3、journalctl 查日志

```bash
journalctl -u order -f                    # 跟踪某个服务的日志
journalctl -u order --since "1 hour ago"  # 按时间过滤
journalctl -u order -n 200 --no-pager     # 最近 200 行
journalctl -p err -b                      # 本次开机以来的错误级别日志
journalctl -k                             # 内核日志，相当于 dmesg
journalctl --disk-usage                   # journal 占用的磁盘
sudo journalctl --vacuum-time=7d          # 只保留 7 天
```

journal 是否在重启后保留，由 `/etc/systemd/journald.conf` 的 `Storage` 决定：取 `auto` 时，存在 `/var/log/journal` 目录才持久化，否则只写在内存中的 `/run/log/journal`。

> [!tip]
> 应用自身的业务日志仍建议写文件或输出 JSON 到 stdout，再由采集端统一收集，journal 只作为兜底。日志规范见 [可观测性总览](/observability/0_overview)。

---

## 四、用户、权限与 umask

### 1、rwx 与八进制

`ls -l` 第一列如 `-rw-r-----`：第 1 位是类型（`-` 文件、`d` 目录、`l` 链接），后 9 位依次是属主、属组、其他人的读（r=4）、写（w=2）、执行（x=1）权限。

| 写法 | 含义 | 典型用途 |
|------|------|---------|
| `chmod 640 application.yml` | 属主读写、属组只读、其他人无权限 | 含密码的配置文件 |
| `chmod 750 /opt/order` | 属主全部、属组读和进入、其他人无权限 | 应用目录 |
| `chmod 600 ~/.ssh/id_ed25519` | 仅属主读写 | SSH 私钥（权限过宽时 ssh 会拒绝使用） |
| `chown -R app:app /opt/order` | 修改属主与属组 | 部署后交给运行账号 |

目录的 `x` 表示能否进入，`r` 表示能否列出内容。另有三个特殊位：setuid（以文件属主身份执行，如 `passwd`）、setgid、sticky（如 `/tmp`，只有文件属主能删除自己的文件）。

### 2、umask

新建文件的权限 = 默认值（文件 666、目录 777）去掉 umask 中的位。默认 umask `022` 得到文件 644、目录 755；改成 `027` 得到 640 / 750，其他人完全不可读，适合生产主机。systemd 服务可在 `[Service]` 中用 `UMask=0027` 单独指定。

### 3、用专用账号运行服务

```bash
sudo useradd --system --no-create-home --shell /usr/sbin/nologin app
sudo chown -R app:app /opt/order
```

服务不要以 root 运行：一旦应用被攻破，攻击者拿到的就是整台主机。需要监听 1024 以下端口时，优先放在 Nginx 之后，或给进程授予 `CAP_NET_BIND_SERVICE` 能力，而不是改用 root。SELinux / AppArmor 等强制访问控制见 [Linux 发行版](./2_linux_distros)。

---

## 五、进程与信号

### 1、常用信号

| 信号 | 编号 | 能否捕获 | 说明 |
|------|------|---------|------|
| `SIGTERM` | 15 | 能 | `kill` 的默认信号，请求进程退出；JVM 会执行 shutdown hook，Spring Boot 据此优雅停机 |
| `SIGKILL` | 9 | 不能 | 内核直接终止进程，不执行任何清理；处理中的请求、未刷盘的数据都会丢失 |
| `SIGINT` | 2 | 能 | 终端里按 Ctrl+C |
| `SIGHUP` | 1 | 能 | 终端断开；Nginx 等守护进程约定为重新加载配置 |
| `SIGQUIT` | 3 | 能 | HotSpot JVM 收到后把线程栈打印到标准输出，进程不退出 |

### 2、kill -15 与 kill -9

停服务的正确顺序是先 `kill <pid>`（即 `-15`），等待进程自行退出，超时后才 `kill -9`。systemd 的 `TimeoutStopSec`、Kubernetes 的 `terminationGracePeriodSeconds` 都是同一套逻辑。一上来就 `-9` 相当于直接断电，摘流量、等待在途请求、关闭连接池都来不及做。

进程退出码 = 128 + 信号编号：**143** 表示被 SIGTERM 终止，**137** 表示被 SIGKILL 终止（容器里常见于内存超限被 OOM Killer 杀掉）。

> [!warning]
> 容器中如果用 shell 形式启动 Java（`ENTRYPOINT java -jar app.jar`），SIGTERM 只会发给 `sh`，JVM 收不到，最终被 SIGKILL。完整的停机链路见 [优雅上下线与变更](/high-avail/8_graceful_release)。

### 3、查看与定位进程

```bash
ps -ef | grep java                                      # 找进程
pgrep -f order.jar                                      # 直接拿 PID
ps -eo pid,ppid,stat,%cpu,%mem,cmd --sort=-%cpu | head  # 按 CPU 排序
ps -o nlwp= -p <pid>                                    # 线程数
```

`STAT` 列中 `D` 表示不可中断睡眠（通常在等磁盘或网络存储 IO，`kill -9` 也杀不掉），`Z` 表示僵尸进程（已退出但父进程未回收，需处理父进程）。

---

## 六、文件描述符与 ulimit

Linux 中每个打开的文件、Socket、管道都占一个文件描述符（fd）。高并发服务的连接、连接池、日志文件都会消耗 fd，超过上限会抛出 `java.io.IOException: Too many open files`。

```bash
cat /proc/<pid>/limits | grep "open files"   # 进程实际生效的软 / 硬限制
ls /proc/<pid>/fd | wc -l                     # 进程当前打开的 fd 数
ulimit -n; ulimit -Hn                         # 当前 shell 的软 / 硬限制
cat /proc/sys/fs/file-nr                      # 全系统已分配 fd 数与上限
```

限制在哪里设置，取决于进程是怎么启动的：

| 启动方式 | 设置位置 |
|---------|---------|
| systemd 服务 | unit 文件中的 `LimitNOFILE=65535` |
| 登录 shell 中手动启动 | `/etc/security/limits.conf`（经 PAM 生效，需重新登录） |
| Docker 容器 | `docker run --ulimit nofile=65535:65535`，或 daemon 的 `default-ulimits` |
| 全系统上限 | `fs.file-max`、`fs.nr_open`（sysctl） |

HotSpot JVM 在 Linux 上启动时默认会把软限制提升到硬限制（`-XX:+MaxFDLimit`），所以对 Java 服务真正要调大的是硬限制。连接相关的内核参数（`somaxconn`、端口范围、TIME_WAIT）见 [并发参数调优](/high-con/7_concurrency_tuning)。

---

## 七、常用排查命令

排查时先按资源逐一检查利用率、饱和度和错误（USE 方法，见 [性能分析方法论](/high-perf/2_methodology)），确定瓶颈在 CPU、内存、磁盘还是网络，再深入到进程和代码。

### 1、按资源选命令

| 资源 | 命令 | 重点看 |
|------|------|--------|
| 负载 / CPU | `uptime`、`top`、`vmstat 1 5`、`mpstat -P ALL 1` | load 与 CPU 核数之比；`us` / `sy` / `wa` / `st`；`vmstat` 的 `r`（运行队列）与 `cs`（上下文切换） |
| 内存 | `free -h`、`vmstat 1 5` | 看 `available` 而不是 `free`；`si` / `so` 持续非零说明在换页 |
| 磁盘 | `df -h`、`df -i`、`iostat -x 1`、`iotop` | 空间与 inode；`%util`、`r_await` / `w_await`、`aqu-sz` |
| 网络 | `ss -lntp`、`ss -s`、`ss -Htan state time-wait \| wc -l`、`ip -s link` | 监听端口与进程；各状态连接数；网卡丢包与错误 |
| 连通性 | `ping`、`mtr`、`dig`、`curl -v`、`nc -zv host 3306` | 路由、DNS 解析、TLS 握手、端口可达 |
| 进程级 | `pidstat -u -r -d -p <pid> 1`、`lsof -p <pid>`、`lsof -i :8080` | 单进程的 CPU / 内存 / IO；打开的文件与连接 |
| 系统调用 | `strace -f -p <pid> -T -e trace=network`、`strace -c -p <pid>` | 卡在哪个系统调用、耗时多少；`-c` 汇总调用次数 |
| 内核事件 | `dmesg -T \| grep -i -E "out of memory\|killed process"` | OOM Killer、磁盘与网卡报错 |

几个容易踩的坑：

- `netstat` 属于已弃用的 net-tools，新系统默认不装，统一用 `ss`
- `iostat`、`mpstat`、`pidstat`、`sar` 来自 **sysstat** 包；`iotop` 是独立的包（`iotop` 或 `iotop-c`）；`strace`、`lsof` 也通常需要单独安装
- `df` 显示磁盘满、`du` 却统计不出来时，多半是日志文件被删除但仍被进程打开，用 `lsof +L1` 找出来，重启进程或清空文件即可释放
- `strace` 会显著拖慢被跟踪的进程，生产环境只做短时间采样

### 2、定位 Java 进程的高 CPU 线程

```bash
top -Hp <pid>                               # 找到 CPU 最高的线程 ID（十进制）
printf '%x\n' <tid>                         # 转成十六进制，如 3e8
jstack <pid> | grep -A 20 'nid=0x3e8'       # 在线程栈中找到对应线程
```

更完整的 JVM 排障流程见 [故障排查](/jvm/9_troubleshooting)，在线诊断工具 Arthas 见 [线上诊断](/engineering/4_diagnosis)。

---

## 小结

- Linux 内核从零编写，继承 Unix 的设计哲学，受 Minix 启发，与 GNU 用户态组合成完整系统；内核许可证为 GPL-2.0-only
- 服务用 systemd 托管：`Restart` 负责崩溃拉起，`TimeoutStopSec` 要大于应用的优雅停机时间，`LimitNOFILE` 设置 fd 上限，日志用 `journalctl -u` 查看
- 服务使用专用的非 root 账号运行，配置文件 640、目录 750，生产主机 umask 取 027
- 停服务先 SIGTERM，超时再 SIGKILL；退出码 143 / 137 分别对应这两个信号
- fd 上限在哪里设置取决于启动方式，systemd 服务不读 `limits.conf`
- 排查按 USE 方法逐个资源检查，`ss` 替代 `netstat`，`iostat` 来自 sysstat

## 参考资料

- Linux 内核文档：[The Linux Kernel documentation](https://docs.kernel.org/)
- 内核许可证说明：[Linux kernel licensing rules](https://docs.kernel.org/process/license-rules.html)
- GNU 计划：[About the GNU Project](https://www.gnu.org/gnu/thegnuproject.html)
- systemd 服务配置：[systemd.service 手册](https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html)
- 资源限制配置：[systemd.exec 手册](https://www.freedesktop.org/software/systemd/man/latest/systemd.exec.html)
- journal 查询：[journalctl 手册](https://www.freedesktop.org/software/systemd/man/latest/journalctl.html)
- 信号说明：[signal(7) - Linux manual page](https://man7.org/linux/man-pages/man7/signal.7.html)
- 套接字统计：[ss(8) - Linux manual page](https://man7.org/linux/man-pages/man8/ss.8.html)
- 系统调用跟踪：[strace(1) - Linux manual page](https://man7.org/linux/man-pages/man1/strace.1.html)

> 下一篇：[Linux 发行版](./2_linux_distros) —— RHEL 系、Debian 系、Alpine 与国产发行版的差异和选型。
