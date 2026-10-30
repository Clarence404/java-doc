---
description: CPU 飙高、OOM 与 Full GC、线程卡死、慢 SQL 与锁表、主从延迟、缓存雪崩与热 Key、MQ 积压与重复消费、发布与容器故障
---

# 实战手册面试题解答

> 题目清单见 [实战手册面试题](/handbook/99_interview)；细节见 [实战手册总览](/handbook/0_overview)。
>
> 版本基线：JDK 21 / 25、Spring Boot 4、MySQL 8.4、Redis 8、Kafka 4、Kubernetes 1.37、Arthas 4。

## 一、JVM 与线程

### Q1：线上 CPU 飙高怎么排查？

**一句话**：先分清是 GC 线程还是业务线程在忙，再用 `top -H` 找到最忙的线程，拿线程 ID 去线程栈里看它在执行什么，多抓几次确认停在同一位置。

→ 完整答案见 [JVM 面试题解答](/interview/3_jvm) Q38；正文详见 [CPU 飙高 · 排查过程](/handbook/2_incidents/3_cpu_high#三、排查过程)

### Q2：OOM 了怎么定位？堆溢出和 Metaspace 溢出查法有什么不同？

**一句话**：先看报错消息分清哪块内存，再看 GC 后的低点：降不下来是泄漏，加内存只能推迟；泄漏点靠 heap dump 的引用链或类加载器统计找，不靠 OOM 栈顶。

| 类型 | 典型画像 | 关键命令 |
|------|----------|----------|
| `Java heap space` | GC 后老年代台阶式上涨 | `jstat -gcutil`、`jcmd GC.class_histogram`、MAT 看 Dominator Tree |
| `Metaspace` | 堆不高、类数量线性增长、卸载数为 0 | `jcmd VM.classloader_stats`、Arthas `classloader` |

- OOM 栈顶只是最后一次分配失败的地方，不一定是泄漏点
- 现场先保：`-XX:+HeapDumpOnOutOfMemoryError` + 持久卷 + `ExitOnOutOfMemoryError`
- 类只有在它的类加载器不可达时才能卸载，动态编译脚本要按版本缓存

**常见坑**：本地缓存不设上限，或缓存 key 里混入请求时间，命中率为 0、只进不出。

→ 详见 [堆内存溢出 · 排查过程](/handbook/2_incidents/0_heap_oom#三、排查过程)、[Metaspace 溢出 · 排查过程](/handbook/2_incidents/1_metaspace_oom#三、排查过程)

### Q3：频繁 Full GC 怎么排查？

**一句话**：先看 GC 日志里 Full GC 的触发原因，再看 Full GC 后内存回不回落：大幅回落是短期大对象，降不下来才是泄漏，两者处理方向完全不同。

- G1 日志里的 `Humongous Allocation`、`Evacuation Failure` 是巨型对象（超过半个 Region 的大数组）挤占堆的信号
- 用 JFR 分配采样（`jcmd JFR.start` + `jfr view allocation-by-site`）或 Arthas `profiler --event alloc` 找分配热点
- 把 Full GC 时间点和访问日志对齐，找到是哪个接口在分配
- 修复：大数据量导出改流式写出 + 限制并发，最好与核心链路分开部署

**常见坑**：把整月数据查进 `List` 再拼成 `byte[]` 返回，扩容时新旧数组同时存在，峰值是数据量的好几倍。

→ 详见 [频繁 Full GC · 排查过程](/handbook/2_incidents/2_full_gc#三、排查过程)

### Q4：接口全面超时、线程全占满但 CPU 很低，怎么排查？

**一句话**：线程满、CPU 低、GC 正常，说明线程都在「等」；把线程栈按线程池归类，看大家共同在等什么：等下游是线程池耗尽，互等锁是死锁。

| 情况 | 线程栈特征 | 根治 |
|------|------------|------|
| 线程池耗尽 | 大量 `WAITING`，栈顶都在读下游 socket 或 `join()` | 出站调用加超时、按下游隔离线程池、拒绝即降级 |
| 死锁 | `jcmd Thread.print` 末尾出现 `Found one Java-level deadlock` | 固定加锁顺序 + `tryLock` 超时 |

- `jstack` 后用 `grep | sort | uniq -c` 统计各线程池线程数和栈顶分布
- 死锁只涉及少数线程，但会把后续请求逐个吸进来，最终耗尽线程池
- 存活探针和业务共用线程时会把「忙」误判成「死」，引发重启风暴

**常见坑**：请求链路用 `CallerRunsPolicy`，拒绝时把压力转给 Tomcat 线程；Arthas `thread -b` 查不出 `ReentrantLock` 这类死锁。

→ 详见 [线程池耗尽 · 排查过程](/handbook/2_incidents/4_thread_pool_exhausted#三、排查过程)、[死锁 · 排查过程](/handbook/2_incidents/5_deadlock#三、排查过程)

## 二、数据库

### Q5：慢 SQL 把连接池打满了，怎么定位和止血？

**一句话**：先分清连接是「借了不还」还是「借得太久」，再在线程转储里找正在读 socket 的线程，它们执行的 SQL 才是元凶，卡在 `getConnection` 的只是受害者。

- 看 HikariCP 连接持有时间（usage）：P99 暴涨说明是慢 SQL，不是连接泄漏
- 数据库侧用 `sys` 库或慢查询日志按语句汇总耗时，`EXPLAIN` 看 `rows`
- 算一笔账：所需连接数 ≈ QPS × 单次耗时（利特尔法则），超过池大小就会排队
- 三道防线：语句超时、获取连接超时、核心与后台查询分开数据源

**常见坑**：只在大租户数据量下才慢，测试数据测不出来；存活探针包含 `db` 检查，把一次慢查询放大成全量重启。

→ 详见 [慢 SQL 拖垮连接池 · 排查过程](/handbook/2_incidents/6_slow_sql_pool#三、排查过程)

### Q6：大批量 UPDATE 后大量「Lock wait timeout」，怎么排查？

**一句话**：CPU 不高、SQL 很简单、RT 正好卡在锁等待超时上，就是锁等待；用 `sys.innodb_lock_waits` 找阻塞方，再看它的事务有多大、开了多久。

- `sys.innodb_lock_waits`：谁在等谁，并给出现成的 `KILL` 语句
- `information_schema.innodb_trx`：事务开始时间、锁住的行数；`blocking_query` 为空说明事务开着却在做别的事
- 无索引的 `UPDATE` 在 REPEATABLE READ 下会锁住扫描过的所有行，等同锁表
- 根治：条件走索引 + 分批短事务 + 远程调用移出事务

**常见坑**：`KILL` 大事务要等回滚完成才释放锁，回滚可能和执行一样久，重启数据库不会更快。

→ 详见 [大事务锁表 · 排查过程](/handbook/2_incidents/7_big_transaction#三、排查过程)

### Q7：支付成功后页面还显示「待支付」，怎么排查主从延迟？

**一句话**：接口都成功、数据却是旧的，先怀疑读到了从库或缓存；对比主从数据后用 `SHOW REPLICA STATUS` 判断卡在拉取还是回放。

- 看 IO / SQL 线程是否运行，对比已接收与已执行的 GTID，判断卡在哪一端
- `performance_schema.replication_applier_status_by_worker` 能看到哪个 worker 在回放哪个事务
- 单个大事务（如一条语句删几百万行）无法并行回放，延迟会一路涨
- 修复：写后读走主库、按真实延迟摘除从库，批量删除分批提交并以从库延迟节流

**常见坑**：读写分离默认假设「从库是实时的」，平时延迟不到 1 秒，问题一直被掩盖。

→ 详见 [主从延迟读到旧数据 · 排查过程](/handbook/2_incidents/8_replica_lag#三、排查过程)

### Q8：深分页为什么会拖垮整个数据库？

**一句话**：`LIMIT 1999950, 50` 要先扫描并回表前面 200 万行再丢掉，成本与页码成正比；大量冷数据被读进 Buffer Pool，还会把热点页冲掉，全站一起变慢。

- 慢查询日志里「`Rows_sent: 50`、`Rows_examined: 2000000`」是典型特征
- 对外接口用游标分页（`WHERE id < 上一页最后一条`），排序键带唯一列兜底
- 必须跳页时用延迟关联（先只查主键再回表），并限制最大页深
- 每页 `COUNT(*)` 同样昂贵，能去掉就去掉，去不掉就缓存

**常见坑**：调用方把翻页当全量同步用；全量同步应提供导出或增量接口。

→ 详见 [深分页拖垮数据库 · 排查过程](/handbook/2_incidents/9_deep_paging#三、排查过程)

## 三、缓存与消息

### Q9：缓存雪崩、击穿、穿透在线上怎么区分？

**一句话**：流量没变而数据库 QPS 暴涨，先看 Redis 的 `keyspace_misses` 和 `expired_keys`：大批 key 同时过期是雪崩，同一个热点 key 被大量并发回源是击穿，查的是根本不存在的数据是穿透。

| 类型 | 线上信号 | 对策 |
|------|----------|------|
| 雪崩 | `expired_keys` 突增，抽样 TTL 集中在同一时刻 | TTL 加随机抖动，预热与回填用同一套 TTL 逻辑 |
| 击穿 | 同一参数的查库 SQL 并发几十上百条 | 回源合并（单飞 / 互斥重建）、本地缓存兜底 |
| 穿透 | 未命中的 key 在库里也查不到 | 缓存空值、布隆过滤器、参数校验 |

- 雪崩和击穿常常同时发生，读和写最好分开连接池，避免读查询拖慢支付回调

**常见坑**：压测时缓存逐步预热，从未模拟「大批 key 同时冷启动」。

→ 详见 [缓存雪崩与击穿 · 排查过程](/handbook/2_incidents/10_cache_avalanche#三、排查过程)、[缓存最佳实践 · 缓存穿透防护](/cache/11_cache_rule#四、缓存穿透防护)

### Q10：Redis 集群只有一个分片 CPU 打满，怎么找热 Key？

**一句话**：集群整体正常、单节点 CPU 或带宽打满，先用 `INFO commandstats` 和慢日志排除慢命令，再用 `--hotkeys` 或 `OBJECT FREQ` 找出被高频读取的 key。

- `--hotkeys` 和 `OBJECT FREQ` 依赖 LFU 淘汰策略，纯缓存集群建议常态用 `allkeys-lfu`
- 一个 key 只落在一个分片上，加分片无效
- 治理：本地缓存挡住大部分读、消除一次请求内的重复读、Value 只存需要的字段、多副本 key 打散到多个分片
- 告警看节点之间的倾斜度，大促和直播排期要提前进入热点名单

**常见坑**：上层超时后自动重试，热点节点的压力又翻一倍。

→ 详见 [热 Key · 排查过程](/handbook/2_incidents/11_hot_key#三、排查过程)

### Q11：Kafka 消息积压了，加消费者有用吗？

**一句话**：先看 lag 分布再动手；同一消费组里一个分区同一时刻只能被一个消费者消费，消费者数超过分区数只会空转，要先把单条处理耗时降下来。

- `kafka-consumer-groups.sh --describe`：所有分区均匀上涨是整体消费能力不足，个别分区上涨是热点或毒丸消息
- `--describe --state` 看组状态是否反复变动；日志出现 `poll timeout has expired`，说明单批处理超过 `max.poll.interval.ms`，消费者被移出组、整批重做
- 用 Arthas `trace` 看单条消息慢在哪，通常是同步调用了慢下游
- 修复：远程调用加超时、非必要逻辑移出消费链路、调小 `max.poll.records`，最后才考虑扩分区

**常见坑**：lag 告警只看绝对值，不看增长趋势，发现时已经积压上百万条。

→ 详见 [MQ 消息积压 · 排查过程](/handbook/2_incidents/12_mq_backlog#三、排查过程)

### Q12：发布后积分重复发放，怎么排查重复消费？

**一句话**：消息队列只保证至少投递一次，重投是常态；先用业务数据圈定范围，再用日志比对 partition、offset 区分「消费端重投」还是「上游重发」，根治靠消费端幂等。

- 常见重投来源：发布时消费者被强杀、offset 没提交，Rebalance，上游重发
- 停机宽限期要大于一批消息的处理时间，但这只能减少重投，不能消除
- 幂等写法：去重记录与业务写入放同一个本地事务、业务唯一键兜底、状态条件更新（`WHERE status = 待支付`）
- 短信这类外部副作用用发件箱表（Outbox，先落库再异步发）去重

**常见坑**：以为开了生产者幂等就不会重复消费；它只保证单分区内发送不重复，管不了消费端。

→ 详见 [重复消费 · 排查过程](/handbook/2_incidents/13_duplicate_consume#三、排查过程)

## 四、发布与基础设施

### Q13：每次滚动发布网关都会冒一波 502，原因是什么？

**一句话**：发布 502 有两个窗口：新 Pod 还没启动完就被加进 Service（缺 readinessProbe），旧 Pod 停止监听早于网关把它摘掉（缺 preStop）。

- 网关错误日志按 upstream IP 归类，对照新旧 Pod 列表，就能分清是哪个窗口
- 没有 readinessProbe 时容器一运行就算就绪；liveness 的 `initialDelaySeconds` 只延后检查，不挡流量
- SIGTERM 与摘除 EndpointSlice 是并行的，`preStop` 里 sleep 几秒让摘流先完成
- 修复组合：startup / readiness / liveness 三探针 + `preStop` + 足够的 `terminationGracePeriodSeconds` + `maxUnavailable: 0`

**常见坑**：把发布 502 当成「正常抖动」，长期没人追问。

→ 详见 [发布时 502 · 排查过程](/handbook/2_incidents/14_release_502#三、排查过程)

### Q14：容器被 OOMKilled 和 Java OOM 有什么区别？

**一句话**：Java OOM 是 JVM 自己在某块内存里申请不到空间抛的异常，进程还活着；OOMKilled 是容器总内存超过 limit 被内核直接杀掉，退出码 137，没有 Java 异常也没有 dump。

→ 完整答案见 [操作系统面试题解答](/interview/4_computer_os) Q10；正文详见 [容器被 OOMKilled · 排查过程](/handbook/2_incidents/15_oom_killed#三、排查过程)

### Q15：Kubernetes 里调用外部接口偶发「恰好慢 5 秒」，怎么查？

**一句话**：恰好 5 秒、10 秒是 DNS 解析超时的签名，对应 glibc 解析器默认的 `timeout:5`；时间花在建连之前，要去查 DNS 而不是对方接口。

- 链路追踪确认耗时在建连之前；Pod 里循环 `getent ahosts` 复现慢解析
- 抓包看同一源端口的 A / AAAA 查询是否有一个没回应，节点上看 `conntrack -S` 的 `insert_failed`
- 默认 `ndots:5` 让外部域名先拼集群后缀，一次解析变成多次查询，放大了冲突概率
- 止血用 Pod 的 `dnsConfig`（调小 `ndots`、`single-request-reopen`、调小 `timeout`），根治用 NodeLocal DNSCache

**常见坑**：CoreDNS 扩副本反而让 A / AAAA 被分到不同后端的概率变高，冲突更多。

→ 详见 [DNS 解析超时 · 排查过程](/handbook/2_incidents/16_dns_timeout#三、排查过程)

### Q16：雪花 ID 出现重复，怎么确认是时钟回拨？

**一句话**：同一个 workerId 生成了相同 ID，只能是同一毫秒被用了两次；把冲突 ID 解码出时间戳和 workerId，再对比应用时间与数据库时间，就能确认节点时钟被往回拨了。

- 解码 ID 定位到节点，查 chrony 日志看有没有时钟步进（step）事件
- 回拨来源：`makestep` 不限次数，加上单一时间源失联，长时间漂移后一次性跳回
- chrony 运行期只允许平滑调整（如 `makestep 1 3` 只在启动后前 3 次步进），时间源不少于 3 个
- 发号器要检测回拨：小幅回拨等待或借用、大幅回拨拒绝发号，重启时校验上次时间戳

**常见坑**：业务编号只有普通索引，重复数据被静默写入，直到对账才发现；关键编号要加唯一索引。

→ 详见 [时钟回拨导致 ID 重复 · 排查过程](/handbook/2_incidents/17_clock_rollback#三、排查过程)

## 五、进阶排查

### Q17：Load 很高但 CPU 很闲，问题出在哪？

**一句话**：Linux 的 Load 不只数在跑的任务，还数卡在不可中断等待（D 状态）里的任务；CPU 闲而 Load 高，多半是一批线程卡在 IO 上，比如 NFS 不响应。

→ 完整答案见 [操作系统面试题解答](/interview/4_computer_os) Q14；正文详见 [Load 高但 CPU 不高 · 排查过程](/handbook/2_incidents/18_load_high_cpu_low#三、排查过程)

### Q18：发版后 MySQL CPU 打满，怎么找到是哪条 SQL？

**一句话**：先确认是在算而不是在等（没有锁等待、IO 不高、扫描行数暴涨），再从最忙的系统线程或 digest 统计找到头号 SQL，最后对照发版内容找原因。

- `top -H` 找最忙的 mysqld 线程，用 `performance_schema.threads` 的 `THREAD_OS_ID` 对回正在执行的 SQL
- `events_statements_summary_by_digest` 按总耗时排序，看「检查行数 / 返回行数」和 `SUM_NO_INDEX_USED`
- `EXPLAIN` 后 `SHOW WARNINGS` 出现 1739 警告，就是参数类型和列类型不一致导致索引失效
- 止血靠回滚加批量终止该类语句，根治是参数类型与列类型保持一致

**常见坑**：测试库数据量太小，全表扫描也只要 1ms，类型改错了测试照样通过。

→ 详见 [数据库 CPU 被打满 · 排查过程](/handbook/2_incidents/19_db_cpu_full#三、排查过程)

### Q19：磁盘满了，删掉大日志文件后空间为什么没释放？

**一句话**：文件被删了但进程还开着它，inode 和数据块要等最后一个句柄关闭才回收；所以 `df` 显示满、`du` 却统计不到。

- 先用 `df -h` 和 `df -i` 分清是空间满还是 inode 满，再用 `du -x` 逐层找大目录
- `lsof +L1` 列出已删除仍被占用的文件，通过 `/proc/<pid>/fd/<n>` 清空句柄就能立即释放，不用重启
- 这次的根源是线上临时调成 DEBUG 后忘了恢复，还打印了上传文件内容
- 修复：日志设总量上限、日志放独立数据盘，临时调高的日志级别定时自动恢复

**常见坑**：直接 `rm` 正在写的日志，空间不释放；应该用 `truncate -s 0` 或清空句柄。

→ 详见 [磁盘写满 · 排查过程](/handbook/2_incidents/20_disk_full#三、排查过程)

### Q20：Java 进程突然没了，没有 hs_err 也没有 OOM 日志，怎么查？

**一句话**：什么痕迹都不留的退出基本是收到了 SIGKILL，最常见的发送方是内核的 OOM Killer；去 systemd 和内核日志里找证据。

| 退出痕迹 | 大概率原因 |
|----------|------------|
| 有 `hs_err_pid*.log` | JVM 自身崩溃 |
| 有优雅停机日志 | 收到 SIGTERM |
| 什么都没有 | 收到 SIGKILL |

- `journalctl -u <服务>` 看 systemd 记录的信号，`journalctl -k` / `dmesg` 看 OOM Killer 报告
- 报告里 `global_oom` 表示整机内存耗尽，`CONSTRAINT_MEMCG` 表示 cgroup 限额；被杀的是占用最大的进程，不一定是肇事者
- 修复：堆给系统和其他进程留足余量，配置自动拉起、OOM 计数告警和「任务该发生却没发生」告警

→ 详见 [Java 进程突然消失 · 排查过程](/handbook/2_incidents/21_process_killed#三、排查过程)

### Q21：新 Pod 刚上线的几分钟 RT 很高，之后自己好了，为什么？

**一句话**：这是冷启动：热点代码还没被 JIT 编译成机器码、类和连接池按需初始化、本地缓存是空的，实例一就绪就接满流量，前几分钟自然慢。

→ 完整答案见 [高可用面试题解答](/interview/14_high_avail) Q45；正文详见 [启动后 RT 飙高 · 排查过程](/handbook/2_incidents/22_warmup_rt#三、排查过程)

### Q22：CPU 不高、下游都正常，接口却变慢，会不会是日志的问题？

**一句话**：会。同步日志要先拿到 Appender 的锁再写盘，日志量暴涨把磁盘 IO 打满后，请求线程就排队等这把锁，所有接口一起变慢。

- 线程栈里大量线程 `WAITING` 在同一把锁上，顺着锁的持有者找到 Appender
- `iostat -x` 看日志盘 `%util` 和写等待，确认磁盘是瓶颈
- 根治靠控量：不打完整报文、不在循环里逐条打、生产 pattern 不采集行号和方法名
- 普通日志改异步且队列满时丢弃，资金和审计日志单独同步写，保证完整

**常见坑**：异步 Appender 默认队列满时会阻塞，不改丢弃策略照样拖慢接口。

→ 详见 [日志打印拖慢接口 · 排查过程](/handbook/2_incidents/23_log_bottleneck#三、排查过程)

### Q23：调用耗时出现 200ms、400ms 的台阶，怎么排查？

**一句话**：约 200ms 的台阶是 TCP 超时重传的特征：最小 RTO 是 200ms，一次丢包多出约一个 RTO，同一个包再超时则翻倍；要查的是丢包，而不是对方接口慢。

- 服务端自身耗时正常、调用方慢，问题在中间的网络
- 重传率 = `TcpRetransSegs` 增量 / `TcpOutSegs` 增量，各节点对比，先定位到单个节点
- `ss -ti` 看单连接的 rtt、rto、retrans，两端 `tcpdump` 对照确认在哪一侧丢的包
- 网卡层丢包看 `ethtool -S` 的 missed，内核层看 `softnet_stat`；这次是新镜像缺了 irqbalance，中断全挤在一个核上

**常见坑**：先去扩容被调用服务，结果毫无作用。

→ 详见 [网络重传与丢包 · 排查过程](/handbook/2_incidents/24_network_retrans#三、排查过程)

### Q24：升级 SDK 后线上报 NoSuchMethodError，怎么定位？

**一句话**：编译时用的依赖版本和运行时加载的不一致，基本是 Maven 传递依赖冲突，低版本的 jar 胜出了。

- 线上用 Arthas `sc -d` 看类来自哪个 jar，`sm` / `jad` 确认方法是否存在；没有 Arthas 就加 `-Xlog:class+load`
- 构建期用 `mvn dependency:tree -Dverbose` 找被省略的冲突版本
- Maven 规则：路径最近者优先，深度相同时先声明者优先，所以低版本可能压过高版本
- 修复用 `dependencyManagement` 统一版本，并用 enforcer 的 `requireUpperBoundDeps` 在构建期拦截

**常见坑**：启动成功、健康检查通过不代表依赖一致，执行到那行代码才会报错。

→ 详见 [依赖冲突导致 NoSuchMethodError · 排查过程](/handbook/2_incidents/25_dependency_conflict#三、排查过程)

### Q25：服务器夜间 CPU 打满，怀疑被植入挖矿程序，怎么处理？

**一句话**：先隔离再取证，查清进程、持久化手段和入侵入口；拿到过 root 的主机不能靠清理恢复信任，要重建并轮换凭据。

- 进程名会伪装成内核线程，看 `/proc/<pid>/exe`、`cwd`、`cmdline` 和父进程；文件被删了也能从 `/proc` 复制样本
- 持久化要查全：所有用户的 crontab、systemd 单元与定时器、`authorized_keys`
- 这次的入口是对公网开放、没有认证的 Redis
- 加固：中间件端口不对公网开放，Redis 用专用无登录用户运行，主机及时打补丁

**常见坑**：直接 `kill -9` 进程就算结束，持久化项还在，整点又被拉起来。

→ 详见 [服务器被植入挖矿程序 · 排查过程](/handbook/2_incidents/26_crypto_mining#三、排查过程)
