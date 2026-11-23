---
description: 宽列与列式 OLAP 的区别、HBase 数据模型与架构、LSM 读写流程、RowKey 设计与预分区、适用场景
---

# HBase

> 前置阅读：[存储引擎：B+ 树与 LSM-Tree](/database/0_fundamentals/1_storage_engine)、[数据库选型参考](/database/0_fundamentals/2_selection_guide)

HBase 是构建在 HDFS 上的分布式宽列存储，擅长百亿行级数据的按 RowKey 随机实时读写。本篇讲 HBase 的数据模型、架构与读写流程、RowKey 设计和适用场景，基线为 HBase 2。

---

## 一、宽列存储与列式 OLAP

| 类别 | 代表 | 存储方式 | 擅长 |
|------|------|----------|------|
| 宽列存储（Wide-Column / 列族） | HBase、Cassandra | 按 RowKey 有序的 KV，列族内仍按行组织 | 海量数据的按键随机读写 |
| 列式 OLAP | ClickHouse、Apache Doris、StarRocks | 每列单独存储、压缩，向量化执行 | 大范围扫描与聚合分析 |

HBase 的「列族」只决定哪些列放进同一组文件，每个列族内部仍是按行键排列的 KV，它并不是分析型列存。两者解决的问题完全不同，列式 OLAP 见 [ClickHouse](./6_clickhouse) 和 [Doris 与 StarRocks](./7_doris_starrocks)。

---

## 二、定位与版本

- Apache HBase 是构建在 HDFS 上的分布式宽列存储，参考 Google Bigtable 设计
- 设计目标：百亿行级数据的**按 RowKey 随机实时读写**
- 适合：用户行为明细、消息存储、Feed、画像宽表、设备明细等「按键查」的海量数据
- 不适合：多表 JOIN、频繁的大范围聚合分析、数据量不大（千万行以内用 MySQL 即可）
- 版本：2.5 / 2.6 仍是存量主力，3.0 已于 2026 年 8 月发布首个 GA 版本（要求 JDK 17+），新集群可评估 3.x

同属宽列存储的 **Apache Cassandra** 采用无中心的对等架构（无 Master、无 HDFS 依赖），可调一致性级别，适合多数据中心写入；国内大数据生态里 HBase 更常见，本篇不展开 Cassandra。

---

## 三、数据模型

![HBase 数据模型](../assets/nosql/hbase-data-model.svg)

- **Table** 按 RowKey 范围水平切分成多个 Region
- **RowKey** 是唯一主键，数据按 RowKey 字典序存放
- **Column Family（列族）** 建表时定义，同一列族的数据存放在同一组 HFile 中，列族数量宜少（1~3 个）
- **Qualifier（列名）** 写入时可动态增加，不同行可以有不同的列
- **Timestamp** 是版本号，一个 Cell 可保留多个版本
- **Value** 是字节数组，HBase 不理解数据类型

示例：存储用户行为

| RowKey | cf:event | cf:device | cf:location |
|--------|----------|-----------|-------------|
| user_001_1700000000 | click | iPhone | Beijing |
| user_001_1700001000 | purchase | iPhone | Beijing |

---

## 四、架构组件

![HBase 架构](../assets/nosql/hbase-architecture.svg)

| 组件 | 职责 |
|------|------|
| HMaster | DDL 操作、Region 分配、RegionServer 故障转移 |
| RegionServer | 承载 Region，处理读写请求，管理 MemStore / HFile |
| Region | 数据水平分片，按 RowKey 范围分割 |
| ZooKeeper | 集群状态管理、HMaster 选主 |

---

## 五、读写流程（LSM 树）

![HBase LSM 写入与读取流程](../assets/nosql/hbase-lsm-flow.svg)

写入先追加 WAL 再写 MemStore，MemStore 满后 Flush 成 HFile，后台 Compaction 合并文件；读取依次查 BlockCache、MemStore 和多个 HFile 并合并版本，BloomFilter 用来跳过不含该行的文件。

---

## 六、RowKey 设计

RowKey 决定数据分布和查询方式，设计不当会导致**热点**：单调递增的 RowKey（如时间戳开头）会让所有新写入落在最后一个 Region 上。

常见的打散方法：

```java
import java.time.Instant;

public final class RowKeys {

    private static final int BUCKETS = 16;

    // 方案 1：Hash 前缀，前缀取值 0~15
    static String hashPrefixed(String userId, long timestamp) {
        int bucket = Math.floorMod(userId.hashCode(), BUCKETS);   // floorMod 保证非负
        return String.format("%02d_%s_%d", bucket, userId, timestamp);
    }

    // 方案 2：反转（手机号等前缀集中、尾部离散的字段）
    static String reversed(String phone, long timestamp) {
        return new StringBuilder(phone).reverse() + "_" + timestamp;
    }

    // 方案 3：对已有 RowKey 加盐
    static String salted(String rowKey, int saltBuckets) {
        int salt = Math.floorMod(rowKey.hashCode(), saltBuckets);
        return String.format("%02d_%s", salt, rowKey);
    }

    public static void main(String[] args) {
        long ts = Instant.now().getEpochSecond();
        System.out.println(hashPrefixed("user_001", ts));
        System.out.println(reversed("13800138000", ts));
        System.out.println(salted("order_20240101_0001", 32));
    }
}
```

注意两点：

- **要配合预分区**：新表默认只有一个 Region，前缀打散了也仍写在同一个 Region 上，建表时要按前缀预分区，如 `create 't', 'cf', SPLITS => ['01_', '02_', ..., '15_']`，或用 `NUMREGIONS` + `SPLITALGO`
- **范围扫描变成 N 路扫描**：加了 Hash / 盐前缀后，原本连续的 RowKey 范围被拆到 N 个桶里，客户端要分别 Scan N 次再合并；需要按时间范围扫描的场景，前缀用业务维度（如 userId 的 hash）而不是全局盐值

设计原则：

- **唯一性**：RowKey 全局唯一
- **散列性**：避免单调递增前缀
- **尽量短**：RowKey 存在每个 Cell 中，越长越费空间
- **查询友好**：最常用的查询维度放在前缀，便于前缀 Scan

---

## 七、适用场景

| 场景 | HBase 是否合适 | 替代方案 |
|------|----------------|----------|
| 按 RowKey 点查 / 前缀扫描 | 适合，毫秒级 | — |
| 海量明细写入（十亿行以上） | 适合 | — |
| 时序数据 | 可以，但专用 TSDB 更省心 | [时序数据库概览](./8_tsdb) |
| 复杂 SQL 查询 | 不适合 | Phoenix 或导入 OLAP 引擎 |
| 多表 JOIN、聚合报表 | 不适合 | ClickHouse / Doris / StarRocks |
| 数据量在千万行以内 | 不必要 | MySQL |

HBase 与 ClickHouse、Doris / StarRocks 的横向对比见 [Doris 与 StarRocks](./7_doris_starrocks#四、选型对比)。

---

## 小结

- 「列式数据库」包含两类：HBase / Cassandra 是宽列 KV 存储，擅长按键随机读写；ClickHouse / Doris / StarRocks 是列式 OLAP，擅长扫描聚合
- HBase 按 RowKey 范围切成 Region，由 HMaster、RegionServer、ZooKeeper 协作；列族建表时定义且宜少，列名可动态增加
- 读写走 LSM：WAL + MemStore 写入、Flush 成 HFile、后台 Compaction，读取合并 BlockCache、MemStore 与多个 HFile
- RowKey 设计决定一切：打散前缀要配合预分区，Hash 前缀会把范围扫描变成 N 路扫描；取模用 `Math.floorMod` 避免负数
- 适合按键查的海量明细；复杂 SQL、多表 JOIN 和千万行以内的数据不要用 HBase

## 参考资料

- Apache HBase Reference Guide：[https://hbase.apache.org/book.html](https://hbase.apache.org/book.html)

> 下一篇：[ClickHouse](./6_clickhouse) —— 列存原理、MergeTree 引擎家族、跳数索引、分布式表与副本、轻量级删除与更新、写入建议
