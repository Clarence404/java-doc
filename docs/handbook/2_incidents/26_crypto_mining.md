---
description: 夜间 CPU 打满、伪装进程、/proc 取证、持久化手段、隔离清理与重建、Redis 加固
---

# 服务器被植入挖矿程序

> 前置阅读：[Linux 概览](/cloud-native/1_linux)、[常见漏洞与防护](/security/8_vulnerabilities)

测试云主机连续几晚 CPU 打满，起初被当成压测没关，最后确认是公网暴露的无认证 Redis 被植入挖矿程序。本篇从防守方视角复盘发现、取证、清理与加固，基线为 Linux 6、Redis 8。

---

## 一、现象

| 时间 | 告警 / 现象 |
|------|-------------|
| 10-08 起 | 测试主机 test-mw-02 每天 01:00–07:00 CPU 持续 100%，白天恢复正常 |
| 10-10 02:13 | `NodeCpuHigh`：test-mw-02 CPU 99.6% 持续 30 分钟（之前的告警被当作压测忽略） |
| 10-10 09:30 | 云厂商安全中心通知：该主机存在"疑似挖矿外连行为" |
| 10-10 09:40 | 同 VPC 的 test-mw-05 也出现夜间 CPU 打满 |

test-mw-02 上跑着测试环境的 Redis、RabbitMQ 和几个 Java 服务，有公网 IP，供外包团队联调使用。

---

## 二、影响

- 两台测试主机被控制，夜间算力被占用，云账单当月多出约 1200 元的出网流量与超配费用
- 测试环境 Redis 中的数据（含脱敏后的测试账号）存在泄露可能；生产环境与测试环境网络隔离、凭据独立，排查后未发现横向进入生产的痕迹
- 两台主机的系统完整性无法保证，最终全部重建

---

## 三、排查过程

::: warning 先隔离，后排查
确认主机被入侵后，先在安全组层面切断该主机的公网出入（保留跳板机的 SSH 访问），并对系统盘打快照留证，再登录排查。不要在被控主机上运行来源不明的"一键清理脚本"，也不要直接执行可疑文件来"看看它做什么"。
:::

### 1、找到占 CPU 的进程

```bash
top -b -n 1 -o %CPU | head -12
```

示例输出：

```text
  PID USER      PR  NI    VIRT    RES    SHR S  %CPU  %MEM     TIME+ COMMAND
28417 redis     20   0 2481216  2.3g   3128 S 795.0  14.6  6400:11 [kworker/u16:2]
 1203 redis     20   0  168544  21412   3920 S   0.7   0.1   2:14.08 redis-server
  ...
```

进程名是 `[kworker/u16:2]`，看起来像内核线程。但真正的内核线程有两个特点：属主是 root、虚拟内存为 0（没有用户态地址空间）。这个进程属主是 `redis`、占用 2.3GB 物理内存、用了 8 核，**是伪装成内核线程的用户态进程**。

这份快照是在 10-10 凌晨 02:20（02:13 `NodeCpuHigh` 告警后）抓的，正是夜间挖矿时段，所以 `top` 里是 795%、8 核满载。累计 CPU 时间 `TIME+` 约 6400 分钟 ≈ 8 核 × 约 13 小时 20 分满载（10-08、10-09 两整晚各挖 6 小时，10-10 凌晨到抓快照又挖了 1 小时 20 分），和它「只在夜间满载、`ELAPSED` 已存活两天多」对得上。这个挖矿程序会按本地时间自行节流，只在 01:00–07:00 全力挖、白天几乎不占 CPU，这正是「白天看着正常、每晚打满」、连续两晚被当成压测忽略的原因。

### 2、用 /proc 看清它是谁

进程名可以随意改，`/proc` 里的信息更可靠：

```bash
ls -l /proc/28417/exe /proc/28417/cwd
tr '\0' ' ' < /proc/28417/cmdline; echo
ps -o pid,ppid,user,lstart,etime -p 28417
```

示例输出：

```text
lrwxrwxrwx 1 redis redis 0 Oct 10 02:20 /proc/28417/exe -> /var/tmp/.ICE-unix/.x/kdevtmpfs (deleted)
lrwxrwxrwx 1 redis redis 0 Oct 10 02:20 /proc/28417/cwd -> /var/tmp/.ICE-unix/.x
[kworker/u16:2]
  PID  PPID USER                      STARTED     ELAPSED
28417     1 redis    Thu Oct  8 01:00:03 2026  2-01:19:57
```

- 可执行文件在隐藏目录 `/var/tmp/.ICE-unix/.x/` 下，并且**已被删除**（`(deleted)`），进程仍在内存中运行
- 父进程是 1，说明已脱离启动它的进程
- 启动时间是 10 月 8 日 01:00:03，正好是整点，像是定时任务拉起的

文件虽然删了，但只要进程还在，就能从 `/proc/<pid>/exe` 复制出一份留证，只计算哈希，不执行：

```bash
cp /proc/28417/exe /root/evidence/sample.bin
sha256sum /root/evidence/sample.bin
```

把哈希提交给安全团队或威胁情报平台比对，确认是已知的挖矿程序家族。

### 3、看网络连接

```bash
ss -tnp | grep -v "127.0.0.1"
```

示例输出：

```text
State  Recv-Q Send-Q   Local Address:Port      Peer Address:Port   Process
ESTAB  0      0         10.20.1.12:44318    203.0.113.45:3333    users:(("kworker/u16:2",pid=28417,fd=12))
ESTAB  0      0         10.20.1.12:6379     198.51.100.77:51022  users:(("redis-server",pid=1203,fd=9))
```

- 可疑进程长期连着一个外部地址的 3333 端口，这类连接通常指向矿池
- Redis 的 6379 上有来自陌生公网地址的连接，联调团队的出口 IP 里没有它

### 4、找持久化手段

挖矿程序被 kill 后通常会自己"复活"，要把所有拉起它的入口找全：

```bash
# 所有用户的定时任务
for u in $(cut -d: -f1 /etc/passwd); do crontab -l -u "$u" 2>/dev/null | sed "s/^/$u: /"; done
ls -la /etc/cron.d/ /etc/cron.hourly/ /var/spool/cron/ /var/spool/cron/crontabs/ 2>/dev/null

# systemd 服务与定时器：重点看最近新增或修改的单元文件
systemctl list-timers --all
find /etc/systemd/system /usr/lib/systemd/system /etc/init.d -newermt "2026-10-01" -type f 2>/dev/null

# SSH 公钥与启动脚本
find / -name authorized_keys -newermt "2026-10-01" 2>/dev/null
ls -la /etc/rc.local /etc/profile.d/ 2>/dev/null

# 动态链接预加载：常被用来隐藏进程
cat /etc/ld.so.preload 2>/dev/null
```

示例发现：

```text
redis: 0 * * * * /var/tmp/.ICE-unix/.x/.update >/dev/null 2>&1
/etc/systemd/system/kdevtmpfs-sync.service   (10-08 00:41 创建，指向同一目录的脚本)
/root/.ssh/authorized_keys                    (10-08 00:39 修改，多出一行陌生公钥)
```

- `redis` 用户的 crontab 每小时整点执行一次 `.update`，检查进程不在就重新拉起，这就是"每次都在整点启动"的原因
- 一个伪装成系统服务的 systemd 单元，开机自启
- root 的 `authorized_keys` 被追加了陌生公钥：攻击者拿到了 root 权限，之后可以随时登录

查文件属性还发现这些文件被加了不可修改标志：

```bash
lsattr /var/spool/cron/crontabs/redis /root/.ssh/authorized_keys
```

```text
----i---------e------- /var/spool/cron/crontabs/redis
----i---------e------- /root/.ssh/authorized_keys
```

`i` 标志让 root 也无法直接修改或删除，清理前需要先 `chattr -i`。

### 5、找入口

可疑文件最早出现在 10-08 00:39，按这个时间点查日志：

```bash
journalctl --since "2026-10-08 00:20" --until "2026-10-08 00:50" --no-pager
grep -E "00:(2|3|4)[0-9]" /var/log/redis/redis-server.log | head
```

- SSH 日志里该时间段没有成功登录记录，排除弱口令 SSH 入口
- Redis 默认 `loglevel notice` 不会记录客户端连接和 `CONFIG SET`，所以来源 IP 要从 `ss`、云平台 VPC 流日志或安全中心取（198.51.100.77 即来自 `ss` 和流日志）；Redis 自身日志里能看到的是异常痕迹：同步到一个陌生「主」的复制记录、`Module ... loaded` 以及 `DB saved on disk` 等

再看 Redis 本身的配置：

```bash
redis-cli INFO server | grep -E "redis_version|config_file"
grep -E "^(bind|protected-mode|requirepass|port)" /etc/redis/redis.conf
ps -o user= -p 1203
```

```text
redis_version:5.0.7
bind 0.0.0.0
protected-mode no
port 6379
redis
```

一台三年前装的 Redis 5，监听所有网卡、关闭了保护模式、没有密码，安全组对公网放开了 6379（当时为了外包团队联调临时放开，之后没收回）。攻击者利用未授权访问，采用 Redis 4/5 时代的主从复制技巧：让目标把一台攻击者控制的「主」同步过来，再借 `MODULE LOAD` 加载恶意模块，从而以 `redis` 用户身份拿到命令执行能力。有了 `redis` 用户的执行权限后，用 `crontab` 命令写该用户自己的定时任务、并落下一个挖矿二进制做持久化；之后再借助系统上一个未修补的本地提权漏洞拿到 root，写入 SSH 公钥和 systemd 单元。

过去流传的「`CONFIG SET dir` 改持久化目录 + 写 root 的 crontab」在这里走不通：Redis 以 `redis` 用户运行，既写不了 `/var/spool/cron` 下 root 的 crontab，也写不进系统目录，所以攻击者改用加载模块拿命令执行、再写 `redis` 用户自己的 crontab。Redis 7 起 `MODULE` 命令默认关闭（`enable-module-command no`），加上默认开启 `protected-mode`、设置 `requirepass`、用 `bind` 收敛监听地址，任意一项都能截断这条链路。

### 6、同网段排查

test-mw-05 上同样有可疑进程，入口不同：它上面没有 Redis，但 root 的 `authorized_keys` 中有和 test-mw-02 相同的陌生公钥，并且 test-mw-02 上有一份可以免密登录 test-mw-05 的私钥。攻击者从 02 横向登录到了 05。

---

## 四、根因

1. **暴露面**：测试 Redis 监听 `0.0.0.0`、关闭保护模式、无认证，安全组临时放开公网 6379 后没有回收
2. **版本过老**：Redis 4/5 对 `MODULE LOAD` 和主从复制都没有限制，攻击者能借「复制一台恶意主 + 加载模块」拿到命令执行；Redis 7 起默认关闭 `MODULE` 命令（`enable-module-command no`）、敏感配置也默认禁止运行时修改（`enable-protected-configs no`），老版本没有这些保护
3. **权限过大**：主机系统多年未打补丁，存在本地提权漏洞；`redis` 用户拥有登录 shell 和 crontab 权限
4. **凭据横向复用**：测试主机之间放置了免密登录私钥，一台失陷就能扩散
5. **告警被忽略**：夜间 CPU 告警持续两天被当作压测处理，云厂商通知才引起重视

---

## 五、修复

### 1、止血与取证

- 10-10 09:45 安全组切断 test-mw-02、test-mw-05 的公网出入，仅保留跳板机 SSH
- 10-10 09:50 对两台主机系统盘打快照，复制样本、可疑脚本、crontab、systemd 单元、相关日志到取证目录并记录哈希
- 10-10 10:05 先 `kill -STOP` 暂停可疑进程（避免它察觉后触发自毁或拉起其他组件），确认持久化项都已记录后再 `kill -9`

### 2、清理（仅作临时措施）

```bash
chattr -i /var/spool/cron/crontabs/redis /root/.ssh/authorized_keys
crontab -r -u redis
systemctl disable --now kdevtmpfs-sync.service && rm -f /etc/systemd/system/kdevtmpfs-sync.service
# 删除陌生公钥（核对每一行的来源）、删除隐藏目录、确认 /etc/ld.so.preload 为空
```

清理后观察 2 小时 CPU 与外连，确认没有复活。但攻击者拿到过 root，被替换的系统命令、内核模块、其他后门不可能保证全部找到：`rpm -Va` / `dpkg --verify` 能发现被篡改的系统文件，却无法证明"没有遗漏"。**清理只用于在重建前让业务继续可用。**

### 3、重建

- 从干净的基础镜像重建两台主机，Redis 升级到 8.x，用配置管理工具（Ansible）按基线部署，不从旧机器拷贝任何脚本和配置
- 测试数据从备份恢复，不复用旧机器上的数据目录
- 轮换所有相关凭据：Redis、RabbitMQ、数据库测试账号、主机 SSH 密钥、部署在这些主机上的 Java 服务配置里的密钥；删除主机间的免密私钥

### 4、加固

Redis：

```text
# redis.conf
bind 10.20.1.12 127.0.0.1        # 只监听内网地址
protected-mode yes
aclfile /etc/redis/users.acl

# /etc/redis/users.acl：关闭无密码的 default 用户，应用用户只能访问自己的 key 前缀，禁止危险命令类别
user default off
user app on #<密码的 SHA-256> ~app:* +@all -@dangerous
```

`@dangerous` 类别包含 `CONFIG`、`DEBUG`、`MODULE` 等命令，应用账号用不到；管理操作用单独的运维账号，只从跳板机访问。

- Redis 以专用、无登录 shell 的用户运行（`/usr/sbin/nologin`），数据目录只对该用户可写
- 安全组：中间件端口一律不对公网开放；外部联调改走 VPN 或零信任接入，临时放开的规则必须带过期时间
- 主机：开启自动安全更新；SSH 只允许密钥登录、禁止 root 直接登录；`/tmp`、`/var/tmp` 挂载 `noexec`
- 出网：测试 VPC 出网走 NAT 网关并配置白名单，只允许访问制品仓库、镜像仓库等必要地址

---

## 六、预防

**监控告警**：

```yaml
- alert: NodeCpuHighOffHours
  # 非工作时间 CPU 持续高于 80%，测试环境同样要处理，不能默认当压测
  expr: |
    (1 - avg by (instance) (rate(node_cpu_seconds_total{mode="idle"}[10m]))) > 0.8
    and on () (hour() >= 17 or hour() < 1)   # UTC 17:00–次日 01:00 即北京时间 01:00–09:00
  for: 30m
  labels: {severity: warning}
```

- 云厂商安全中心（主机入侵检测）在测试环境同样开启，告警接入值班
- 主机部署文件完整性监控（如 AIDE）和 `auditd`，对 `crontab`、`authorized_keys`、`/etc/systemd/system` 的修改记录审计日志
- 容器环境：Pod 以非 root 运行、根文件系统只读，NetworkPolicy 默认禁止出网，减少被利用后的可操作空间

**流程**：

- 每周扫描公网暴露端口（云厂商安全组审计或外部扫描），对 Redis、MySQL、Elasticsearch、Nacos、Jenkins 等管理端口暴露立即告警
- 测试环境与生产环境同等对待凭据：不复用、不放免密私钥、定期轮换
- 主机入侵按安全事件流程处理：隔离、取证、通报、重建、复盘，不以"进程杀掉了"作为结束

---

## 七、涉及知识点

- 进程、信号与 `/proc` 定位：[Linux 概览](/cloud-native/1_linux#五、进程与信号)
- systemd 单元与 journalctl：[Linux 概览](/cloud-native/1_linux#三、systemd-与-journalctl)
- 排查命令速查：[Linux 排查命令速查](/handbook/1_cheatsheet/0_linux)
- 漏洞与供应链风险：[常见漏洞与防护](/security/8_vulnerabilities)
- 不以网络位置作为信任依据：[零信任架构](/security/9_zero_trust)
- 安全事件的响应流程：[故障应急与复盘](/high-avail/11_incident_response)
- Redis 配置与运维：[Redis 实战](/cache/5_redis_practice)

---

## 小结

- 夜间 CPU 打满、整点启动、进程名像内核线程但属主是普通用户，都是挖矿程序的典型特征
- 进程名不可信，看 `/proc/<pid>/exe`、`cwd`、`cmdline` 和父进程；文件被删也能从 `/proc` 复制样本留证
- 持久化要查全：所有用户的 crontab、systemd 单元与定时器、`authorized_keys`、`ld.so.preload`，注意 `chattr +i`
- 拿到过 root 的主机不能靠清理恢复信任，正确做法是隔离、取证、重建、轮换凭据，再收紧暴露面

## 参考资料

- Redis 安全建议：[Redis Docs — Redis security](https://redis.io/docs/latest/operate/oss_and_stack/management/security/)
- Redis ACL：[Redis Docs — ACL](https://redis.io/docs/latest/operate/oss_and_stack/management/security/acl/)
- `/proc/<pid>` 各文件说明：[proc_pid_exe(5) — Linux manual page](https://man7.org/linux/man-pages/man5/proc_pid_exe.5.html)
- 不可修改标志：[chattr(1) — Linux manual page](https://man7.org/linux/man-pages/man1/chattr.1.html)
- 事件响应流程：[NIST SP 800-61 Rev. 3: Incident Response Recommendations and Considerations for Cybersecurity Risk Management](https://csrc.nist.gov/pubs/sp/800/61/r3/final)
- 挖矿类攻击技术描述：[MITRE ATT&CK — Resource Hijacking (T1496)](https://attack.mitre.org/techniques/T1496/)
