---
description: DEBUG 日志写满磁盘、rm 后空间不释放、lsof 找已删除文件、日志总量上限、容量预测告警
---

# 磁盘写满

> 前置阅读：[日志](/spring-boot/9_logging)、[Linux 排查命令速查](/handbook/1_cheatsheet/0_linux)

临时调成 DEBUG 的日志级别忘了改回，一夜写满系统盘，删掉日志后磁盘依然是 100%。本篇复盘这次磁盘写满，基线为 JDK 21、Spring Boot 4、Linux 内核 6.x。

---

## 一、现象

file-gateway 部署在 3 台虚拟机上（systemd 托管，系统盘 100GB 的 ext4，日志写在同一分区的 `/data/logs`）。10 月 5 日凌晨告警：

| 时间 | 告警 / 现象 |
|------|-------------|
| 03:42 | `NodeFilesystemAlmostFull`：gw-02 的 `/` 可用空间低于 5% |
| 03:51 | `HttpErrorRateHigh`：「上传附件」接口 5xx 比例 100%（gw-02） |
| 04:06 | gw-01、gw-03 相继出现同样告警 |
| 04:20 | 值班同学删除了 `/data/logs/app.log`，`df -h` 仍显示 100% |

应用日志在 03:50 之后不再更新，接口返回的错误来自 Tomcat 处理上传时写临时文件：

```text
java.io.IOException: No space left on device
	at java.base/java.io.FileOutputStream.writeBytes(Native Method)
	at java.base/java.io.FileOutputStream.write(FileOutputStream.java:367)
	at org.apache.tomcat.util.http.fileupload.disk.DiskFileItem.write(...)
```

---

## 二、影响

- 03:51–04:47 共 56 分钟，附件上传全部失败，约 4800 次上传请求报错，主要影响凌晨批量导入的商户
- 下载、查询类接口不写本地磁盘，基本正常
- 磁盘写满期间的应用日志丢失，给后续排查留下约 1 小时的空窗

---

## 三、排查过程

### 1、确认是空间满还是 inode 满

```bash
df -h / ; df -i /
```

示例输出：

```text
Filesystem      Size  Used Avail Use% Mounted on
/dev/vda1        99G   94G     0 100% /
Filesystem      Inodes  IUsed   IFree IUse% Mounted on
/dev/vda1      6553600 182340 6371260    3% /
```

空间满、inode 充足。`Used` 只有 94G 而 `Avail` 为 0，是因为 ext4 默认给 root 预留了 5% 的块：普通用户已经写不进去，以 root 运行的进程还能写一点，这也是 sshd、systemd 等系统服务还能工作的原因。

### 2、空间被谁占了

```bash
du -xh --max-depth=2 / 2>/dev/null | sort -rh | head -5
```

```text
94G	/
86G	/data
86G	/data/logs
4.1G	/usr
1.9G	/var
```

```bash
ls -lhS /data/logs | head -4
```

```text
total 86G
-rw-r----- 1 app app  38G Oct  5 03:50 app.log
-rw-r----- 1 app app 6.2G Oct  5 00:00 app.2026-10-04.log.gz
-rw-r----- 1 app app 1.5G Oct  4 00:00 app.2026-10-03.log.gz
```

当前文件 38G，10 月 4 日的归档压缩后也有 6.2G，是平时的 4 倍；其余 28 个历史归档共约 40G。项目自定义的 `logback-spring.xml` 只按天滚动、保留 30 天，没有单文件大小和总量上限，一天写多少就占多少。

### 3、为什么写这么多

```bash
tail -c 2000 /data/logs/app.log | head -5
curl -s localhost:8081/actuator/loggers/com.example.gateway
```

```text
2026-10-05T03:49:58.102+08:00 DEBUG 2318 --- [nio-8080-exec-9] c.e.gateway.upload.UploadController : upload request: merchantId=M10293, fileName=batch_1005.xlsx, content=UEsDBBQABgAIAAAAIQBi7p1oXgEAAJAEAAATAAgCW0NvbnRlbnRfVHlwZXNdLnhtbCCiBAIooAAC...

{"configuredLevel":"DEBUG","effectiveLevel":"DEBUG"}
```

`com.example.gateway` 被设置成了 DEBUG，上传接口在 DEBUG 级别会把 Base64 编码的整个文件内容打进日志。审计记录显示，10 月 4 日 16:20 有同学通过 Actuator 的 `loggers` 端点调成 DEBUG 排查一个商户问题，之后没有改回；当晚起日志量明显上涨，凌晨批量导入开始后写入速度达到每小时约 15GB。

### 4、删了文件为什么空间不释放

04:20 值班同学执行了 `rm /data/logs/app.log`，空间没有变化：

```bash
lsof +L1 | grep -E 'COMMAND|java'
```

```text
COMMAND  PID USER   FD   TYPE DEVICE    SIZE/OFF NLINK    NODE NAME
java    2318  app  187w   REG  253,1 40802189312     0 1572871 /data/logs/app.log (deleted)
```

`rm` 只删除了目录项，Java 进程还持有这个文件的句柄，`NLINK` 为 0 但数据块要等句柄关闭才会释放。所以 `du` 统计不到，`df` 却依然是满的。

---

## 四、根因

1. **临时调高日志级别没有回收**：通过 Actuator 调成 DEBUG 后没有自动还原机制，也没人记得改回
2. **DEBUG 日志打印了文件内容**：上传接口在 DEBUG 下输出整个请求体，量级比正常日志高三个数量级
3. **日志没有总量上限**：只按天滚动并保留 30 天，没有单文件大小和 `totalSizeCap`，日志量暴涨时可以无限占用磁盘
4. **日志与系统共用分区**：日志写满直接影响 Tomcat 临时目录和系统盘

---

## 五、修复

### 1、止血

- 04:26 把日志级别改回默认（`configuredLevel` 传 `null` 即恢复继承）：

```bash
curl -s -X POST localhost:8081/actuator/loggers/com.example.gateway \
     -H 'Content-Type: application/json' -d '{"configuredLevel": null}'
```

- 04:28 通过进程的文件句柄清空已删除的文件，空间立即释放，不需要重启进程：

```bash
: > /proc/2318/fd/187
```

- 04:35 删除 DEBUG 期间产生的归档，确认无排查价值后保留最近 2 个；另两台按同样步骤处理，04:47 上传恢复

::: tip 正在写的日志不要 rm
需要释放正在写入的日志文件时，用 `truncate -s 0 文件` 或 `: > 文件` 清空内容；已经 `rm` 掉的，用 `lsof +L1` 找到进程和句柄号，再清空 `/proc/<pid>/fd/<fd>`。
:::

### 2、根治

去掉自定义的滚动策略，改用 Spring Boot 内置的按天 + 按大小滚动，并设置总量上限：

```yaml
logging:
  file:
    name: /data/logs/app.log
  logback:
    rollingpolicy:
      max-file-size: 200MB
      max-history: 7
      total-size-cap: 20GB          # 归档总量上限，超过后删除最旧的
      clean-history-on-start: true
```

- 上传接口的日志只记录文件名、大小和摘要，删除打印请求体的代码；日志规范补充「禁止打印文件内容、Base64 与二进制」
- 日志目录挂独立的数据盘 `/data/logs`，Tomcat 临时目录（`server.tomcat.basedir`）放在另一块盘上，日志写满不再影响上传
- `loggers` 端点只开放给运维网关，并加一个定时任务：被调成 DEBUG / TRACE 的 logger 30 分钟后自动恢复，恢复动作记录到审计日志

---

## 六、预防

**监控告警**：除了使用率阈值，再加一条按增长速度预测的告警，提前几个小时发现：

```yaml
- alert: NodeFilesystemAlmostFull
  expr: |
    node_filesystem_avail_bytes{fstype=~"ext4|xfs"}
      / node_filesystem_size_bytes{fstype=~"ext4|xfs"} < 0.10
  for: 5m
  labels: {severity: critical}
- alert: NodeFilesystemFillingUp
  # 按最近 6 小时的趋势，4 小时内会写满
  expr: predict_linear(node_filesystem_avail_bytes{fstype=~"ext4|xfs"}[6h], 4 * 3600) < 0
  for: 30m
  labels: {severity: warning}
- alert: NodeInodesAlmostExhausted
  expr: node_filesystem_files_free / node_filesystem_files < 0.10
  for: 10m
  labels: {severity: warning}
```

**规范**：

- 所有写本地文件的服务必须配置日志总量上限；容器环境日志只输出到 stdout，由运行时和采集平台负责轮转
- 线上调日志级别必须在值班群登记，并说明恢复时间
- 运维手册写明「先 `lsof +L1`、再清空句柄」的处理步骤，禁止直接 `rm` 正在写的日志

**巡检**：每周检查各主机磁盘的日增长量，增长异常的目录在周会上说明原因。

---

## 七、涉及知识点

- 日志滚动、保留与 `total-size-cap`：[日志](/spring-boot/9_logging#九、滚动与保留)
- 运行时调整日志级别：[日志](/spring-boot/9_logging#六、运行时调整级别)
- `df`、`du`、`lsof +L1` 等磁盘命令：[Linux 排查命令速查](/handbook/1_cheatsheet/0_linux#三、磁盘与文件)
- 日志级别策略与源头控量：[日志体系](/observability/1_logging#二、日志级别策略)
- Actuator 端点的暴露与鉴权：[Actuator 监控](/spring-boot/11_actuator)
- 告警规则编写与分级：[告警体系](/observability/4_alerting)

---

## 小结

- 磁盘写满先分清空间满还是 inode 满，再用 `du -x` 逐层找大目录
- `df` 满而 `du` 统计不到，多半是文件已删除但仍被进程持有，用 `lsof +L1` 定位、清空句柄释放
- 日志必须有总量上限，打印请求体、文件内容这类日志在任何级别都不应出现
- 临时调高的日志级别要有自动恢复；告警除了阈值，还要用 `predict_linear` 提前预测

## 参考资料

- 日志滚动配置：[Spring Boot Reference: Logging](https://docs.spring.io/spring-boot/reference/features/logging.html)
- `loggers` 端点：[Spring Boot Actuator API: Loggers](https://docs.spring.io/spring-boot/api/rest/actuator/loggers.html)
- `lsof` 的 `+L1` 选项：[lsof(8) — Linux manual page](https://man7.org/linux/man-pages/man8/lsof.8.html)
- ext4 预留块：[tune2fs(8) — Linux manual page](https://man7.org/linux/man-pages/man8/tune2fs.8.html)
- `predict_linear` 函数：[Prometheus: Query functions](https://prometheus.io/docs/prometheus/latest/querying/functions/)

> 下一篇：[Java 进程突然消失](./21_process_killed)
