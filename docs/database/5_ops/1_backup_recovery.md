# 数据备份与恢复

## 一、核心指标

| 指标 | 全称 | 含义 |
|------|------|------|
| **RPO** | Recovery Point Objective | 最多允许丢失多长时间的数据（0 = 不允许丢）|
| **RTO** | Recovery Time Objective | 最多允许多长时间完成恢复（恢复速度要求）|

```
时间轴：
[最后备份] ←—— RPO ——→ [故障点]（这段数据可能丢失）
                         ↓
              [开始恢复] ←—— RTO ——→ [恢复完成]
```

---

## 二、备份类型

| 类型 | 说明 | 优点 | 缺点 |
|------|------|------|------|
| 全量备份 | 备份全部数据 | 恢复简单、独立 | 耗时长、占空间大 |
| 增量备份 | 备份自上次备份以来的变化 | 快速、省空间 | 恢复依赖备份链，复杂 |
| 差异备份 | 备份自上次**全量**以来的变化 | 恢复比纯增量简单 | 比增量备份大 |

---

## 三、MySQL 备份方案

### 1、逻辑备份：mysqldump

```bash
# 全库逻辑备份（--single-transaction 对 InnoDB 热备，不锁表）
mysqldump -h 127.0.0.1 -u root -p \
  --single-transaction \
  --master-data=2 \        # 记录 binlog 位置，便于后续增量恢复
  --all-databases \
  | gzip > full_$(date +%Y%m%d_%H%M).sql.gz

# 单库备份
mysqldump -u root -p --single-transaction mydb > mydb_backup.sql

# 恢复
mysql -u root -p mydb < mydb_backup.sql
zcat full_20240101.sql.gz | mysql -u root -p
```

**适用场景**：数据量 < 50GB、跨版本迁移、结构迁移  
**缺点**：大库备份/恢复慢，CPU/IO 压力高

### 2、物理备份：XtraBackup（生产推荐）

```bash
# 全量备份（热备，不锁表）
xtrabackup --backup \
  --target-dir=/backup/full \
  --user=root --password=xxx

# 备份完成后 prepare（应用 redo log，使备份达到一致状态）
xtrabackup --prepare --target-dir=/backup/full

# 增量备份（基于全量）
xtrabackup --backup \
  --target-dir=/backup/inc_$(date +%Y%m%d) \
  --incremental-basedir=/backup/full

# 恢复步骤
systemctl stop mysqld
rm -rf /var/lib/mysql/*
xtrabackup --copy-back --target-dir=/backup/full
chown -R mysql:mysql /var/lib/mysql
systemctl start mysqld
```

**优点**：GB 级数据分钟级备份，物理文件级速度快  
**增量备份恢复**：先 prepare 全量，再 apply 增量，再 copy-back

### 3、Binlog 增量备份与 PITR

```bash
# 备份 binlog 文件
mysqlbinlog mysql-bin.000100 mysql-bin.000101 \
  --read-from-remote-server -h 127.0.0.1 -u root -p \
  | gzip > binlog_$(date +%Y%m%d).sql.gz

# 基于时间点恢复（PITR，在全量恢复基础上继续执行）
mysqlbinlog \
  --start-datetime="2024-01-15 00:00:00" \
  --stop-datetime="2024-01-15 10:30:00" \
  mysql-bin.000100 mysql-bin.000101 \
  | mysql -u root -p

# 基于 position 恢复（精确到具体语句）
mysqlbinlog \
  --start-position=123456 \
  --stop-position=987654 \
  mysql-bin.000100 | mysql -u root -p
```

---

## 四、PostgreSQL 备份方案

### 1、pg_dump / pg_dumpall

```bash
# 单库备份（-Fc 自定义格式，支持并行恢复）
pg_dump -U postgres -Fc mydb > mydb_$(date +%Y%m%d).dump

# 全库备份
pg_dumpall -U postgres | gzip > all_$(date +%Y%m%d).sql.gz

# 恢复（自定义格式支持并行 -j）
pg_restore -U postgres -d mydb -j 4 mydb_backup.dump

# 纯 SQL 格式恢复
psql -U postgres -d mydb < mydb_backup.sql
```

### 2、WAL 归档 + PITR

```ini
# postgresql.conf
archive_mode = on
archive_command = 'cp %p /archive/wal/%f && echo "archived %f"'
wal_level = replica
```

```bash
# 基础备份（全量物理备份）
pg_basebackup -U replication \
  -D /backup/base \
  -Ft -z -P \
  --wal-method=stream

# PITR 恢复配置（PG 12+，postgresql.conf 中）
restore_command = 'cp /archive/wal/%f %p'
recovery_target_time = '2024-01-15 11:30:00'
recovery_target_action = 'promote'
```

---

## 五、备份策略设计

### 全量 + Binlog 策略（常用）

```
每周日 02:00  → 全量备份（XtraBackup）→ 上传 OSS/S3
每日   02:00  → Binlog 备份（增量）
故障时         → 最近全量 + 故障前 Binlog → PITR 恢复
```

### 3-2-1 原则（行业最佳实践）

- **3** 份副本（1 份主数据 + 2 份备份）
- **2** 种介质（本地磁盘 + 远程对象存储）
- **1** 份异地（不同机房或云区域）

### 定时任务示例

```bash
# crontab -e
# 每周日 2:00 全量备份
0 2 * * 0 /usr/local/bin/mysql_full_backup.sh

# 每日 2:00 增量（Binlog）
0 2 * * 1-6 /usr/local/bin/mysql_binlog_backup.sh

# 备份完成后上传 OSS（阿里云）
# ossutil cp /backup/ oss://my-bucket/mysql/ -r --update
```

---

## 六、云数据库备份

| 云服务 | 备份能力 | RPO | RTO |
|-------|---------|-----|-----|
| 阿里云 RDS MySQL | 自动快照 + Binlog | 秒级 | 分钟级 |
| AWS Aurora | 连续备份到 S3 | 1秒 | < 1分钟 |
| AWS RDS | 自动快照 + 事务日志 | 5分钟 | 分钟级 |
| 腾讯云 TDSQL | 强同步多副本 + 备份 | 秒级 | 分钟级 |

云数据库通常自动处理备份，重点关注：
- 备份保留周期（建议 ≥ 7 天）
- 跨可用区副本（应对 AZ 级故障）
- 定期测试恢复演练

---

## 七、恢复演练

> 备份的价值在于**能恢复**，未经验证的备份等于没有备份。

**演练检查项**：

| 检查项 | 频率 | 方法 |
|-------|------|------|
| 备份文件完整性 | 每次备份后 | `mysqlcheck` / `pg_restore --list` |
| 全量恢复测试 | 每季度 | 恢复到隔离测试环境 |
| PITR 测试 | 每半年 | 指定时间点恢复，验证数据 |
| 记录实际 RTO | 每次演练 | 对比 SLA 目标 |
| 数据一致性校验 | 恢复后 | 核对业务关键数据（账户余额、订单数量等）|
