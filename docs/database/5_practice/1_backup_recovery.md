---
description: RTO / RPO、mysqldump、XtraBackup 增量、binlog PITR、PG 增量备份、恢复演练
---

# 数据备份与恢复

> **本篇目标**：能按 RPO / RTO 设计备份策略，写出可直接执行的 MySQL（mysqldump、MySQL Shell、XtraBackup、binlog）与 PostgreSQL（pg_dump、pg_basebackup 增量、WAL 归档）备份恢复命令，并建立恢复演练机制。
>
> **前置阅读**：[MySQL 主从与高可用](../1_mysql/9_topic_replication)（binlog 与 GTID）

复制解决的是「机器坏了还能继续服务」，备份解决的是「数据被删错、被勒索加密之后还能找回来」：`DELETE` 会被同步到所有副本，只有备份能回到误操作之前。本篇以 MySQL 8.4 LTS 与 PostgreSQL 18 为基线；冗余切换、多活与异地容灾的系统级方案见 [冗余与故障转移](/high-avail/2_redundancy_failover) 与 [多活与容灾](/high-avail/9_multi_active)。

---

## 一、核心指标与备份类型

### 1、RPO 与 RTO

| 指标 | 全称 | 含义 |
|------|------|------|
| **RPO** | Recovery Point Objective | 最多允许丢失多长时间的数据（0 表示不允许丢） |
| **RTO** | Recovery Time Objective | 最多允许多长时间完成恢复 |

![RPO / RTO 时间线](../../assets/database/rpo-rto-timeline.svg)

RPO 由「最近一次可用备份 + 日志备份的连续性」决定，RTO 由「恢复数据量、恢复方式与自动化程度」决定。逻辑备份恢复要重放 SQL、重建索引，大库的 RTO 往往以小时计；物理备份直接拷回数据文件，快一个数量级。

### 2、备份类型

| 类型 | 说明 | 优点 | 缺点 |
|------|------|------|------|
| 全量备份 | 备份全部数据 | 恢复简单、独立 | 耗时长、占空间大 |
| 增量备份 | 备份自上次备份（全量或增量）以来的变化 | 快、省空间 | 恢复依赖完整备份链 |
| 差异备份 | 备份自上次**全量**以来的变化 | 恢复只需全量 + 最后一次差异 | 越往后越大 |
| 日志备份 | 持续归档 binlog / WAL | 可恢复到任意时间点（PITR） | 必须配合一个全量基线 |

| 维度 | 逻辑备份 | 物理备份 |
|------|---------|---------|
| 内容 | SQL 语句或数据文件（与存储格式无关） | 数据文件页的拷贝 |
| 代表工具 | mysqldump、MySQL Shell dump、pg_dump | XtraBackup、MySQL Enterprise Backup、CLONE、pg_basebackup |
| 跨版本 / 跨平台 | 可以 | 通常要求同大版本 |
| 速度 | 慢，恢复需重建索引 | 快，接近磁盘带宽 |
| 粒度 | 可按库、表 | 一般是整个实例 |

---

## 二、MySQL 逻辑备份

### 1、mysqldump

```bash
# 全实例逻辑备份：InnoDB 一致性快照 + 记录 binlog 位置 + 存储过程 / 事件 / 触发器
mysqldump -h 127.0.0.1 -u backup -p \
  --single-transaction \
  --source-data=2 \
  --routines --events --triggers \
  --all-databases \
  | gzip > full_$(date +%Y%m%d_%H%M).sql.gz

# 单库备份
mysqldump -u backup -p --single-transaction --routines --events --triggers mydb > mydb.sql

# 恢复
mysql -u root -p mydb < mydb.sql
zcat full_20261001_0200.sql.gz | mysql -u root -p
```

参数要点：

- `--single-transaction`：开启一个 `REPEATABLE READ` 一致性读事务，InnoDB 表不加锁；备份期间不要对被备份的表执行 DDL，否则快照会失效
- `--source-data=2`：以注释形式写入 `CHANGE REPLICATION SOURCE TO ...` 的 binlog 文件与位置，供后续 PITR 或搭建副本；8.0.26 起取代已废弃的 `--master-data`
- `--routines --events --triggers`：触发器默认导出，存储过程与事件默认**不导出**，显式写全更稳妥
- GTID 开启时默认 `--set-gtid-purged=AUTO`，导出文件里会带 `SET @@GLOBAL.gtid_purged`；导入到已有 GTID 的实例时需评估是否改为 `OFF`

适用场景：几十 GB 以内的库、跨版本迁移、只要部分库表。缺点是单线程导出、恢复慢，大库不应作为唯一的备份手段。

### 2、MySQL Shell dump 工具

MySQL Shell 的 `util.dumpInstance()` / `util.dumpSchemas()` / `util.dumpTables()` 是多线程、分块、压缩的逻辑备份，配合 `util.loadDump()` 并行导入，速度远超 mysqldump，也是官方推荐的大库逻辑迁移方式：

```bash
# 多线程导出整个实例（zstd 压缩，默认同时导出用户与权限）
mysqlsh backup@127.0.0.1:3306 -- util dump-instance /backup/dump_20261001 --threads=8

# 并行导入；目标实例需允许 local_infile
mysqlsh root@target:3306 -- util load-dump /backup/dump_20261001 --threads=8
```

导出时也会记录 binlog 位置与 GTID 集合（写在 dump 目录的元数据文件里），可用于后续 PITR。

---

## 三、MySQL 物理备份

### 1、XtraBackup 版本匹配

Percona XtraBackup 的大版本必须与服务器对应：XtraBackup 8.0 用于 MySQL 8.0，**8.4 用于 8.4 LTS**，Innovation 版本使用对应的 9.x 版本；8.0 版本的 XtraBackup 不能备份 8.4。MySQL 8.0 已于 2026 年 4 月结束支持，新建实例应直接用 8.4 LTS 及对应的 XtraBackup。

其他物理备份选择：

- **MySQL Enterprise Backup**：Oracle 商业版工具
- **CLONE 插件**（8.0.17+）：`CLONE INSTANCE FROM ...` 在线拷贝整个实例，常用于快速搭建副本，也可以 `CLONE LOCAL DATA DIRECTORY` 生成本地物理快照
- **存储 / 云盘快照**：需配合 `LOCK INSTANCE FOR BACKUP` 或 `FLUSH TABLES WITH READ LOCK` 保证一致性

### 2、全量备份与恢复

```bash
# 全量备份（热备，InnoDB 不锁表）
xtrabackup --backup --user=backup --password=xxx --target-dir=/backup/full

# 只恢复全量时，直接完整 prepare（前滚已提交事务 + 回滚未提交事务）
xtrabackup --prepare --target-dir=/backup/full

# 恢复：数据目录必须为空
systemctl stop mysqld
mv /var/lib/mysql /var/lib/mysql.bak
xtrabackup --copy-back --target-dir=/backup/full
chown -R mysql:mysql /var/lib/mysql
systemctl start mysqld
```

### 3、增量备份与 prepare 顺序

增量备份基于上一次备份的 LSN，只拷贝变化的页：

```bash
# 周日全量
xtrabackup --backup --user=backup --password=xxx --target-dir=/backup/full
# 周一增量：基于全量
xtrabackup --backup --user=backup --password=xxx \
  --target-dir=/backup/inc1 --incremental-basedir=/backup/full
# 周二增量：基于周一增量
xtrabackup --backup --user=backup --password=xxx \
  --target-dir=/backup/inc2 --incremental-basedir=/backup/inc1
```

prepare 时**除最后一个增量外都要加 `--apply-log-only`**，只前滚、不回滚。如果提前执行了回滚阶段，未提交事务被撤销，后续增量的 LSN 就接不上了：

```bash
# 1. 全量：只前滚
xtrabackup --prepare --apply-log-only --target-dir=/backup/full
# 2. 中间的增量：只前滚
xtrabackup --prepare --apply-log-only --target-dir=/backup/full --incremental-dir=/backup/inc1
# 3. 最后一个增量：完整 prepare（包含回滚）
xtrabackup --prepare --target-dir=/backup/full --incremental-dir=/backup/inc2
# 4. copy-back 与全量恢复相同
```

每个备份目录下的 `xtrabackup_checkpoints` 记录了 `from_lsn` / `to_lsn`，校验增量链是否连续就看相邻备份的 LSN 是否首尾相接。

### 4、binlog 备份与 PITR

物理或逻辑全量只能恢复到备份时刻，之后的数据靠 binlog 补齐。binlog 备份应保留**原始二进制文件**，而不是解码成 SQL 文本，这样以后仍能按 GTID 或位置重放：

```bash
# 从服务器实时拉取原始 binlog（类似一个只落盘的副本），保存在当前目录
mysqlbinlog --read-from-remote-server --host=127.0.0.1 --user=backup --password \
  --raw --stop-never mysql-bin.000100
```

恢复到误操作之前的时间点：

```bash
# 1. 先用最近的全量恢复出实例
# 2. 从全量记录的位置开始重放，停在误操作之前
mysqlbinlog --start-position=123456 --stop-datetime="2026-10-08 10:29:59" \
  mysql-bin.000100 mysql-bin.000101 | mysql -u root -p

# 按 GTID 精确跳过误操作的那个事务
mysqlbinlog --exclude-gtids='3E11FA47-71CA-11E1-9E33-C80AA9429562:1001' \
  mysql-bin.000100 mysql-bin.000101 | mysql -u root -p
```

GTID 模式下要注意：恢复出的实例 `gtid_executed` 已包含全量里的事务，`mysqlbinlog` 输出带 GTID，重放时**已执行过的 GTID 会被自动跳过**，因此从稍早的位置开始重放也不会重复执行；但如果目标实例的 `gtid_executed` 与备份不一致（例如手工 `RESET BINARY LOGS AND GTIDS`），就可能整段被跳过或报错，恢复前先核对。

---

## 四、PostgreSQL 备份

### 1、pg_dump / pg_dumpall

```bash
# 单库：-Fc 自定义格式，可选择性恢复、支持并行恢复
pg_dump -U postgres -Fc -f mydb.dump mydb

# 单库并行导出：并行导出只支持目录格式 -Fd
pg_dump -U postgres -Fd -j 4 -f mydb_dir mydb

# 角色、表空间等全局对象 + 所有库
pg_dumpall -U postgres | gzip > all_$(date +%Y%m%d).sql.gz

# 恢复：-Fc / -Fd 用 pg_restore，可并行
pg_restore -U postgres -d mydb -j 4 mydb.dump
# 纯 SQL 格式用 psql
psql -U postgres -d mydb -f mydb.sql
```

### 2、pg_basebackup 与 PG 17 增量备份

```bash
# 全量物理备份（同时流式拉取期间产生的 WAL）
pg_basebackup -U replicator -D /backup/full -Ft -z -P --wal-method=stream
```

PostgreSQL 17 起原生支持**增量物理备份**，前提是开启 WAL 汇总：

```ini
# postgresql.conf
summarize_wal = on
```

```bash
# 全量（目录格式，生成 backup_manifest）
pg_basebackup -U replicator -D /backup/full -P
# 增量：基于上一次备份的 manifest，只拷贝变化的块
pg_basebackup -U replicator -D /backup/inc1 --incremental=/backup/full/backup_manifest
pg_basebackup -U replicator -D /backup/inc2 --incremental=/backup/inc1/backup_manifest

# 恢复前用 pg_combinebackup 合成一个完整的数据目录（按从旧到新的顺序列出）
pg_combinebackup /backup/full /backup/inc1 /backup/inc2 -o /var/lib/postgresql/18/main
```

增量备份不能直接启动，必须先合成。生产环境更常用 **pgBackRest** 或 **Barman**，它们封装了全量 / 增量 / 差异备份、WAL 归档、并行、压缩、加密、保留策略与校验。

### 3、WAL 归档与 PITR

```ini
# postgresql.conf
wal_level = replica
archive_mode = on
archive_command = 'test ! -f /archive/wal/%f && cp %p /archive/wal/%f'
```

`test ! -f` 防止覆盖已归档的同名文件；命令返回非 0 时 PostgreSQL 会重试，不会丢弃 WAL。

PITR 恢复步骤（PG 12+）：

1. 停库，把基础备份恢复到数据目录（增量备份先 `pg_combinebackup`）
2. 在 `postgresql.conf` 中配置恢复参数：

```ini
restore_command = 'cp /archive/wal/%f %p'
recovery_target_time = '2026-10-08 10:29:59+08'
recovery_target_action = 'promote'
```

3. 在数据目录下创建空文件 `recovery.signal`：`touch $PGDATA/recovery.signal`。**没有这个文件，服务器会正常启动并忽略所有 `restore_command` 与 `recovery_target_*`**
4. 启动后回放 WAL 到目标时间点，按 `recovery_target_action` 提升为可读写，`recovery.signal` 会被自动删除

---

## 五、备份策略设计

### 1、全量 + 日志策略

![全量 + binlog 的 PITR 策略](../../assets/database/backup-pitr-strategy.svg)

| 时间 | 动作 | 说明 |
|------|------|------|
| 每周日 02:00 | XtraBackup 全量 | 上传对象存储，保留 4 周 |
| 周一至周六 02:00 | XtraBackup 增量（可选） | 缩短 binlog 重放量，降低 RTO |
| 持续 | `mysqlbinlog --raw --stop-never` 拉取 binlog | RPO 接近秒级 |
| 故障时 | 最近全量 → 增量 → binlog 重放到故障前 | PITR |

### 2、3-2-1 原则

- **3** 份数据：1 份生产数据 + 2 份备份
- **2** 种介质：本地磁盘 + 远程对象存储
- **1** 份异地：不同机房或云区域；防勒索场景再加一份不可篡改（对象锁 / WORM）的副本

### 3、定时任务

```bash
# crontab -e
0 2 * * 0   /usr/local/bin/mysql_full_backup.sh
0 2 * * 1-6 /usr/local/bin/mysql_incr_backup.sh
```

脚本里备份完成后再上传对象存储（如 `ossutil`、`aws s3 cp`），并在上传后校验文件大小或哈希；binlog 拉取进程用 systemd 常驻，而不是 cron。

---

## 六、云数据库备份

云数据库托管了快照与日志备份，使用方要关注的是配置与边界：

- **区分备份恢复与故障切换**：自动备份 + PITR 的「最新可恢复时间」通常落后几分钟，恢复会生成新实例；秒级 RTO 依赖的是多可用区副本切换，不是备份
- **保留周期**：自动备份默认保留期较短，按合规要求调整，长期保留用手动快照或跨区域备份复制
- **跨区域 / 跨账号副本**：应对区域级故障和账号被入侵
- **定期演练**：按时间点恢复出新实例，验证应用能连上并读到正确数据

具体 RPO / RTO 以各云厂商的服务说明为准。

---

## 七、恢复演练

> 备份的价值在于**能恢复**，未经验证的备份等于没有备份。

| 检查项 | 频率 | 方法 |
|-------|------|------|
| 备份文件完整性 | 每次备份后 | mysqldump：`gzip -t` 且文件末尾有 `-- Dump completed`；XtraBackup：在副本上 `--prepare` 成功；pg_dump：`pg_restore --list`；pg_basebackup：`pg_verifybackup` |
| 全量恢复测试 | 每季度 | 恢复到隔离环境并启动 |
| PITR 测试 | 每半年 | 恢复到指定时间点，验证数据 |
| 记录实际 RTO | 每次演练 | 对比 SLA 目标 |
| 数据一致性校验 | 恢复后 | 核对关键业务数据（账户余额、订单数量等） |

---

## 小结

- 备份按 RPO / RTO 设计：全量提供基线，binlog / WAL 归档把 RPO 压到秒级，物理备份与自动化决定 RTO
- mysqldump 用 `--single-transaction --source-data=2 --routines --events --triggers`；大库逻辑备份用 MySQL Shell `util.dumpInstance` 并行导出
- XtraBackup 大版本必须与 MySQL 对应（8.4 对 8.4）；增量 prepare 除最后一个外都要 `--apply-log-only`
- binlog 用 `mysqlbinlog --raw --stop-never` 保留原始文件；GTID 模式重放会自动跳过已执行事务
- PG 17 起 `summarize_wal` + `pg_basebackup --incremental` + `pg_combinebackup` 支持原生增量；PITR 必须创建 `recovery.signal`
- 3-2-1 原则加不可篡改副本防勒索；没做过恢复演练的备份不算备份

## 参考资料

- mysqldump：[https://dev.mysql.com/doc/refman/8.4/en/mysqldump.html](https://dev.mysql.com/doc/refman/8.4/en/mysqldump.html)
- MySQL Shell 实例与库导出：[https://dev.mysql.com/doc/mysql-shell/8.4/en/mysql-shell-utilities-dump-instance-schema.html](https://dev.mysql.com/doc/mysql-shell/8.4/en/mysql-shell-utilities-dump-instance-schema.html)
- 使用 binlog 做时间点恢复：[https://dev.mysql.com/doc/refman/8.4/en/point-in-time-recovery-binlog.html](https://dev.mysql.com/doc/refman/8.4/en/point-in-time-recovery-binlog.html)
- Percona XtraBackup 8.4 增量备份：[https://docs.percona.com/percona-xtrabackup/8.4/create-incremental-backup.html](https://docs.percona.com/percona-xtrabackup/8.4/create-incremental-backup.html)
- PostgreSQL 连续归档与 PITR：[https://www.postgresql.org/docs/current/continuous-archiving.html](https://www.postgresql.org/docs/current/continuous-archiving.html)
- pg_combinebackup：[https://www.postgresql.org/docs/current/app-pgcombinebackup.html](https://www.postgresql.org/docs/current/app-pgcombinebackup.html)

> 下一篇：[分库分表与中间件](./2_sharding) —— 用 ShardingSphere 5.5 的 JDBC 驱动与 YAML 规则落地分库分表、读写分离与数据迁移。
