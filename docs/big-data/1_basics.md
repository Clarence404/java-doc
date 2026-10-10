---
description: 批处理与流处理、MapReduce 思想、HDFS 与 YARN 现状、存算分离、对象存储数据湖、Lambda 与 Kappa
---

# 大数据基础

> 前置阅读：[大数据总览](./0_overview)、[对象存储](/architecture/4_object_storage)

大数据技术要解决的是单机存不下、算不动、跑不完的问题，本篇是整个模块的概念地基。内容涵盖批处理与流处理、MapReduce 思想、HDFS 与 YARN 的现状、存算分离、对象存储数据湖以及 Lambda 与 Kappa 架构，版本基线为 Hadoop 3.5。

---

## 一、大数据要解决什么问题

本篇示例统一使用电商订单数据：业务库 `order_info` 表每天新增数百万行，加上 App 埋点日志每天数十亿条。

一台服务器的磁盘是几 TB 到几十 TB，顺序读带宽在 GB/s 量级。当订单明细累积到数百 TB、需要每天全量重算一遍"各省份各品类的 GMV"时，单机方案会依次遇到三堵墙：

| 问题 | 单机的表现 | 分布式的解法 |
|------|------------|--------------|
| 存不下 | 磁盘装满，RAID 也无济于事 | 把文件切成块，分散存到几十上百台机器 |
| 算不动 | 扫描 100 TB 即使按 1 GB/s 也要一天多 | 每台机器只算本地那一份，几百台并行 |
| 跑不完 / 不可靠 | 跑了 10 小时的任务因一块坏盘前功尽弃 | 数据多副本，任务拆成小块，失败只重跑那一块 |

所有大数据系统都在用不同方式回答同三个问题：**数据怎么切分存储、计算怎么并行、失败怎么恢复**。理解这三点，再看 HDFS、Spark、Flink、Iceberg 时就能迅速抓住它们各自的取舍。

另一个容易被忽略的维度是**数据种类**。业务库只有结构化表，而数据平台要同时处理 binlog 变更流、JSON 埋点、Nginx 访问日志、第三方对账文件，甚至图片和文本。这也是大数据平台普遍以"文件 + 开放格式"而不是某一种数据库作为底座的原因。

::: tip 数据量的直觉
MySQL 单表在合理索引下撑到几千万行没有问题；Doris / ClickHouse 单集群分析几十亿到上千亿行是常态；超过百 TB、数据源多、需要长期保留历史并被多个引擎共享时，才轮到湖仓 + Spark / Flink 这套完整体系。别为了"大数据"三个字提前引入它。
:::

---

## 二、批处理与流处理

### 1、两种处理模型

| 维度 | 批处理（Batch） | 流处理（Streaming） |
|------|-----------------|---------------------|
| 输入 | 有界数据集：某一天的分区、一批文件 | 无界数据流：持续到达的事件 |
| 触发 | 按调度时间或上游就绪触发，跑完即结束 | 作业常驻，事件到达即处理 |
| 时效 | 小时级到天级（T+1） | 秒级到分钟级 |
| 正确性 | 输入固定，重跑结果确定，便于对账 | 要处理乱序、迟到、重复，靠事件时间与 Checkpoint 保证 |
| 资源 | 定时占用，跑完释放，适合错峰 | 长期占用，按峰值预留 |
| 典型引擎 | Spark、Hive | Flink、Kafka Streams、Spark Structured Streaming |
| 典型场景 | 日报、财务对账、用户画像、模型训练样本 | 实时大屏、实时风控、实时推荐特征、CDC 同步 |

流处理把有界数据看作"流的一个特例"：一个有开始有结束的流。Flink 正是基于这个视角用同一套运行时同时支持流和批，概念细节见 [Flink 概览](/flink/1_basics) 第一节。Spark 则相反，Structured Streaming 把流看作"不断追加的表"，以微批（micro-batch）方式反复执行增量查询，延迟一般在百毫秒到秒级。

### 2、按时效需求选择

实际项目里不是"批好还是流好"，而是每个需求要多新鲜的数据：

| 时效 | 典型需求 | 推荐做法 |
|------|----------|----------|
| T+1 | 经营日报、财务结算、留存分析 | 离线批处理：Spark SQL 按天分区计算，调度系统驱动 |
| 小时级 | 运营看板、广告消耗 | 小时分区批处理，或湖仓表的增量读取 |
| 分钟级 | 准实时报表、库存预警 | 湖仓流式写入（Paimon / Iceberg + Flink），OLAP 直接查询 |
| 秒级 | 实时大屏 GMV、风控拦截、实时推荐 | Kafka + Flink，结果写 Redis / Doris |

几条经验：

- **能用批不用流**：流作业要处理状态膨胀、乱序、反压，运维成本远高于批；"老板想看实时"之前先确认分钟级是否已经满足
- **对账永远靠批**：即使有实时链路，财务口径的数据通常以 T+1 批处理结果为准，实时结果用于看趋势
- **两条链路的口径必须一致**：同一个"支付 GMV"在实时和离线中用不同 SQL 实现，早晚会出现数字对不上，这正是 Lambda 架构最大的痛点（第七节）

---

## 三、MapReduce：分而治之的计算思想

MapReduce 出自 Google 2004 年的论文，Hadoop MapReduce 是它的开源实现。今天几乎没有新项目直接写 MapReduce 程序，但 Spark、Flink、Hive、各类 MPP 数据库的分布式执行，本质都是它的延伸，理解它就理解了"Shuffle 为什么贵"。

### 1、三个阶段

以"按省份统计已支付订单金额"为例，输入是若干个 CSV 文件，每行一条订单：

- **Map**：每个 Map 任务读取一个输入分片（通常对应一个 HDFS 块），逐行解析，过滤掉未支付订单，输出 `(province, amount)` 键值对。Map 之间完全独立，天然并行
- **Shuffle**：框架按 key 的哈希把所有 Map 的输出分发给 Reduce 任务，保证同一个省份的数据落到同一个 Reduce。这一步要把中间数据排序、落盘、跨网络传输，是整个作业最慢、最容易出问题的环节
- **Reduce**：每个 Reduce 收到某几个省份的全部金额，求和后写出结果

**Combiner** 是一个优化：在 Map 端先对本地数据做一次局部求和，`(广东, 100)`、`(广东, 200)` 合并成 `(广东, 300)` 再发出去，能大幅减少 Shuffle 的数据量。只有满足结合律和交换律的聚合（求和、计数、最大值）才能这样做，求平均值要拆成"和 + 个数"再合并。

### 2、代码示意

下面用 Hadoop MapReduce 的 Java API 实现上述统计。金额以「分」为单位存成 `long`，避免浮点误差：

```java
public class GmvByProvince {

    // 输入行：order_id,user_id,province,status,amount_fen
    public static class GmvMapper extends Mapper<LongWritable, Text, Text, LongWritable> {
        private final Text province = new Text();
        private final LongWritable amount = new LongWritable();

        @Override
        protected void map(LongWritable offset, Text line, Context ctx)
                throws IOException, InterruptedException {
            String[] f = line.toString().split(",");
            if (f.length == 5 && "PAID".equals(f[3])) {
                province.set(f[2]);
                amount.set(Long.parseLong(f[4]));
                ctx.write(province, amount);
            }
        }
    }

    public static class SumReducer extends Reducer<Text, LongWritable, Text, LongWritable> {
        private final LongWritable total = new LongWritable();

        @Override
        protected void reduce(Text key, Iterable<LongWritable> values, Context ctx)
                throws IOException, InterruptedException {
            long sum = 0;
            for (LongWritable v : values) {
                sum += v.get();
            }
            total.set(sum);
            ctx.write(key, total);
        }
    }

    public static void main(String[] args) throws Exception {
        Job job = Job.getInstance(new Configuration(), "gmv-by-province");
        job.setJarByClass(GmvByProvince.class);
        job.setMapperClass(GmvMapper.class);
        job.setCombinerClass(SumReducer.class);   // 求和满足结合律，可直接复用为 Combiner
        job.setReducerClass(SumReducer.class);
        job.setOutputKeyClass(Text.class);
        job.setOutputValueClass(LongWritable.class);
        FileInputFormat.addInputPath(job, new Path(args[0]));
        FileOutputFormat.setOutputPath(job, new Path(args[1]));
        System.exit(job.waitForCompletion(true) ? 0 : 1);
    }
}
```

同样的逻辑在 Spark SQL 中只需要一句：

```sql
SELECT province, SUM(amount_fen) AS gmv_fen
FROM ods_order_info_inc
WHERE dt = '2026-10-09' AND status = 'PAID'
GROUP BY province;
```

### 3、为什么被取代

| 问题 | MapReduce | 后继者的做法 |
|------|-----------|--------------|
| 编程模型 | 只有 Map + Reduce 两段，多步计算要串多个 Job | Spark / Flink 用 DAG 表达任意多个阶段 |
| 中间结果 | 每个 Job 的输出都写回 HDFS，下一个 Job 再读 | 阶段之间尽量在内存或本地磁盘流转 |
| 开发效率 | 手写 Java 类，一个 JOIN 要几十行 | SQL 成为主要接口 |
| 启动开销 | 每个任务启动一个 JVM，秒级启动 | 常驻 Executor，任务以线程运行 |

MapReduce 留下的核心遗产是三个概念：**按数据分片并行**、**按 key 重分区（Shuffle）**、**任务级失败重试**。后面讲 Spark 的宽依赖、数据倾斜，讲 Flink 的 keyBy，都是这三个概念的变体。

---

## 四、Hadoop 的现状：HDFS 与 YARN

Hadoop 由三部分组成：HDFS（分布式文件系统）、YARN（资源调度）、MapReduce（计算）。MapReduce 已基本退出；HDFS 和 YARN 在存量集群中仍大量运行，但新建平台越来越多地用对象存储和 Kubernetes 替代它们。截至 2026 年 10 月最新版本为 Hadoop 3.5.0（2026 年 4 月发布），服务端要求 Java 17，客户端支持 Java 17 和 21，移除了已废弃的 WASB 连接器（改用 ABFS），新增了 Google Cloud Storage 文件系统实现；3.4.x 仍在维护。

### 1、HDFS 的设计

| 组件 | 职责 |
|------|------|
| NameNode | 管理整个文件系统的元数据：目录树、文件到块的映射、块所在的 DataNode。元数据全部常驻内存 |
| DataNode | 存放数据块，定期向 NameNode 汇报心跳和块列表 |
| 块（Block） | 文件切分的单位，默认 128 MB（`dfs.blocksize`），每块默认 3 副本（`dfs.replication`） |
| 副本放置 | 3 副本时：第一副本放在写入方所在节点（或同机架随机节点），第二、三副本放在另一个机架的两台节点上，兼顾机架故障与跨机架带宽 |
| 纠删码（EC） | Hadoop 3.0 引入，默认策略 `RS-6-3-1024k`：6 个数据块 + 3 个校验块，存储开销 1.5 倍（3 副本是 3 倍），适合冷数据 |

几个日常会用到的命令：

```bash
# 上传本地文件到 ODS 目录
hdfs dfs -mkdir -p /warehouse/ods/ods_order_info_inc/dt=2026-10-09
hdfs dfs -put order_info_20261009.csv /warehouse/ods/ods_order_info_inc/dt=2026-10-09/

# 查看目录大小，排查小文件
hdfs dfs -du -s -h /warehouse/ods/ods_order_info_inc
hdfs dfs -count /warehouse/ods/ods_order_info_inc      # 输出：目录数 文件数 字节数 路径

# 检查块与副本健康状况
hdfs fsck /warehouse/ods/ods_order_info_inc -files -blocks -locations

# 冷数据目录改用纠删码（只影响之后写入的文件）
hdfs ec -listPolicies
hdfs ec -setPolicy -path /warehouse/archive -policy RS-6-3-1024k
```

HDFS 最著名的问题是**小文件**：每个文件、目录、块在 NameNode 内存中都是一个对象（社区经验值约 150 字节），1 亿个小文件意味着几十 GB 的 NameNode 堆，而且每个小文件都会生成一个 Map 任务。流式作业每分钟往分区里写文件、Spark 作业并行度过高都会制造小文件，治理办法是写入端控制文件大小、定期合并（湖仓表格式自带 compaction，见 [数据湖与湖仓](./4_lakehouse)）。

### 2、YARN 的设计

| 组件 | 职责 |
|------|------|
| ResourceManager | 全局资源调度，决定哪个应用在哪台机器上获得多少 CPU 和内存 |
| NodeManager | 每台机器一个，启动和监控 Container，汇报资源使用 |
| ApplicationMaster | 每个应用一个（例如一个 Spark 作业的 Driver 所在的进程），向 RM 申请资源、管理自己的任务 |
| Container | 资源分配单位，一份 CPU + 内存的配额，任务在其中运行 |

调度器常用 Capacity Scheduler：按队列（如 `etl`、`adhoc`、`realtime`）划分资源占比，保证凌晨的 ETL 不会被分析师的临时查询挤占。提交 Spark 作业到 YARN：

```bash
spark-submit \
  --master yarn \
  --deploy-mode cluster \
  --queue etl \
  --num-executors 20 \
  --executor-cores 4 \
  --executor-memory 8g \
  --class com.example.shop.GmvJob \
  order-etl.jar 2026-10-09

# 查看运行中的应用与日志
yarn application -list -appStates RUNNING
yarn logs -applicationId application_1760000000000_0042
```

### 3、哪些仍然重要

| 能力 | 现状 | 对 Java 后端的意义 |
|------|------|--------------------|
| Hadoop `FileSystem` API | 依然是事实标准：Spark、Flink、Hive、Iceberg 都通过它访问 `hdfs://`、`s3a://`、`abfs://`、`gs://` | 代码里换存储只改 URI 和配置，不改读写逻辑 |
| HDFS | 存量自建机房集群的主力存储；新平台多改用对象存储 | 知道块、副本、小文件问题即可 |
| YARN | 存量集群的资源调度；新平台多改用 Kubernetes 运行 Spark / Flink | 能看懂队列、Container、日志查看方式 |
| Hive Metastore | 存量湖仓最常见的元数据目录（Catalog），记录库、表、分区与文件位置；新平台逐步转向 Iceberg REST Catalog 等方案 | 建表、查分区时打交道最多的组件 |
| MapReduce | 基本退出，仍有极少数遗留作业 | 理解思想即可 |

::: tip 新平台要不要部署 HDFS
在公有云或已有对象存储（MinIO、Ceph RGW）的环境下，新建数据平台一般不再部署 HDFS：对象存储按量付费、免运维、天然多副本，配合 Iceberg / Paimon 的元数据管理可以绕开对象存储"列目录慢、没有原子重命名"的短板。自建机房、已有大规模 HDFS 集群、对延迟极度敏感的场景，HDFS 仍是合理选择。
:::

---

## 五、存算分离

![存算一体 vs 存算分离](../assets/big-data/basics-storage-compute.svg)

### 1、从数据本地性到存算分离

Hadoop 时代的核心原则是**移动计算而不是移动数据**：调度器尽量把 Map 任务派到存有对应数据块的节点上，读本地磁盘，避开当时昂贵的网络。代价是每台机器同时承担存储和计算，二者只能一起扩容：存储满了要加机器，CPU 也跟着闲置；大促期间算力不够，加机器又得带上一堆磁盘。

万兆、25G 网络普及和对象存储成熟之后，网络不再是瓶颈，**存算分离**成为主流：

| 维度 | 存算一体（HDFS + YARN） | 存算分离（对象存储 + K8s） |
|------|-------------------------|-----------------------------|
| 扩容 | 存储与计算绑定扩容 | 各自独立扩缩，计算可按小时弹性伸缩 |
| 成本 | 按峰值配置机器，存储 3 副本 | 存储按量付费，计算用完即释放 |
| 多引擎共享 | 多个集群要互相拷贝数据 | Spark、Flink、Trino、Doris 读同一份数据 |
| 读性能 | 本地磁盘，延迟低 | 走网络，首次读较慢，依赖缓存 |
| 元数据操作 | 列目录、重命名是 NameNode 内存操作，很快 | 对象存储列举慢，"重命名"实为拷贝 + 删除 |
| 运维 | 要维护 NameNode HA、磁盘更换、扩容均衡 | 存储交给云厂商或独立团队 |

### 2、存算分离的代价与应对

- **网络读延迟**：引擎普遍在计算节点本地加缓存，例如 Doris / StarRocks 的存算分离模式会把热数据缓存在本地磁盘，Trino 等引擎也提供本地文件缓存；也可以部署 Alluxio 一类的独立缓存层
- **列目录慢、重命名非原子**：传统做法是"写临时目录再 rename 到正式目录"，在对象存储上既慢又不安全。Spark 官方文档建议写 S3 时改用 S3A 的零重命名提交器（committer），更彻底的方案是使用 Iceberg / Paimon 这类表格式：文件写到最终位置，通过一次原子的元数据提交让它们可见，查询时从元数据文件拿到文件清单而不是列目录
- **请求次数与小文件**：对象存储按请求计费且有每秒请求数上限，大量小文件既慢又贵，写入端需要控制文件大小（Parquet 文件通常建议 128 MB 到 1 GB 量级），并定期合并
- **一致性**：AWS S3 自 2020 年 12 月起提供强一致的读写语义，主流云对象存储也已一致；Spark 文档仍提醒不要覆盖正在被其他客户端读取的文件，这正是表格式"只追加新文件、不改旧文件"的设计所规避的

---

## 六、对象存储作为数据湖底座

### 1、数据湖的三层结构

数据湖（Data Lake）指以原始、开放格式集中存放全部数据的存储，和数据库"先建表再写入"不同，它允许先存下来再决定怎么用。一个可用的数据湖由三层叠起来：

| 层 | 作用 | 常见选择 |
|----|------|----------|
| 存储层 | 保存字节，提供高可靠、低成本、无限容量 | S3、阿里云 OSS、腾讯云 COS、MinIO、HDFS |
| 文件格式层 | 决定一个文件内部怎样组织数据 | 列存：Parquet、ORC（分析首选）；行存：Avro（适合写入密集和 Schema 演进的交换场景）；JSON / CSV 只用于接入层 |
| 表格式层 | 把一堆文件组织成"一张表"：Schema、分区、快照、ACID 提交、时间旅行 | Iceberg、Paimon、Hudi、Delta Lake；存量系统是 Hive 表（只靠目录约定，没有事务） |

只有前两层时，数据湖很容易变成"数据沼泽"：没有人知道某个目录下的文件是什么 Schema、哪些是写了一半的、能不能删。表格式层加上元数据目录，再加上 [数据治理](./8_governance)，数据湖才具备数仓的可管理性，这就是**湖仓（Lakehouse）**，详见 [数据湖与湖仓](./4_lakehouse)。

### 2、目录与分区组织

即使最终使用表格式，理解底层的目录组织仍然重要。按 Hive 风格的分区目录，电商订单数据大致是这样：

```text
s3a://shop-lake/warehouse/ods.db/ods_order_info_inc/dt=2026-10-09/part-00000-*.parquet
s3a://shop-lake/warehouse/dwd.db/dwd_trade_order_detail_inc/dt=2026-10-09/part-00000-*.parquet
s3a://shop-lake/warehouse/dws.db/dws_trade_user_order_1d/dt=2026-10-09/part-00000-*.parquet
```

- **按时间分区**是最基本的做法，查询带上 `dt` 条件时引擎只扫描对应目录（分区裁剪）
- 分区不能过细：按 `dt` + `hour` + `province` 三级分区，每天就是几百个目录，每个目录下的文件都很小。经验上单个分区的数据量不宜低于几百 MB
- 冷数据可以转到对象存储的低频 / 归档存储类型，与 [数据冷热分离](/architecture/1_cold_hot_data) 中的思路一致

### 3、从 Spark 访问对象存储

Hadoop 的 S3A 连接器让引擎以 `s3a://` 访问 S3 兼容存储（包括 MinIO 和大多数云厂商的 S3 兼容接口）。Hadoop 3.4 起 S3A 基于 AWS SDK for Java v2，需要 `hadoop-aws` 与对应版本的 AWS SDK bundle 同时在类路径上。以 MinIO 为例的 Spark 配置：

```properties
# spark-defaults.conf
spark.hadoop.fs.s3a.endpoint                 http://minio.data.svc:9000
spark.hadoop.fs.s3a.path.style.access        true
# 凭证从环境变量 AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY 读取，不要写进配置文件
spark.hadoop.fs.s3a.aws.credentials.provider software.amazon.awssdk.auth.credentials.EnvironmentVariableCredentialsProvider
# 写 Parquet 时使用零重命名提交器，需要 spark-hadoop-cloud 模块
spark.hadoop.fs.s3a.committer.name           directory
spark.sql.sources.commitProtocolClass        org.apache.spark.internal.io.cloud.PathOutputCommitProtocol
spark.sql.parquet.output.committer.class     org.apache.spark.internal.io.cloud.BindingParquetOutputCommitter
```

Java 代码读写对象存储与读写 HDFS 没有区别，只是路径换成 `s3a://`：

```java
SparkSession spark = SparkSession.builder().appName("gmv-by-province").getOrCreate();

Dataset<Row> orders = spark.read()
        .parquet("s3a://shop-lake/warehouse/ods.db/ods_order_info_inc/dt=2026-10-09/");

orders.filter(col("status").equalTo("PAID"))
      .groupBy(col("province"))
      .agg(sum("amount_fen").alias("gmv_fen"))
      .write()
      .mode(SaveMode.Overwrite)
      .parquet("s3a://shop-lake/warehouse/ads.db/ads_trade_gmv_province_1d/dt=2026-10-09/");
```

（`col`、`sum` 来自 `import static org.apache.spark.sql.functions.*;`。）直接按路径读写文件只适合演示，生产中应通过 Catalog 以表名访问 Iceberg / Paimon 表，由表格式负责提交与并发控制，写法见 [Spark](./3_spark) 与 [数据湖与湖仓](./4_lakehouse)。

---

## 七、Lambda 与 Kappa 架构

![Lambda 与 Kappa 架构对比](../assets/big-data/basics-lambda-kappa.svg)

### 1、Lambda：批流两套链路

Lambda 架构由 Storm 作者 Nathan Marz 提出，把系统分成三层：

- **批处理层（Batch Layer）**：保存全量不可变的原始数据，定期（通常每天）用批处理全量重算，结果准确但有延迟
- **速度层（Speed Layer）**：只处理批处理还没覆盖到的最近数据，用流处理增量计算，结果实时但可能有误差
- **服务层（Serving Layer）**：合并批视图和实时视图对外提供查询；第二天批处理结果出来后，覆盖掉前一天的实时结果

它的出发点是早期流处理不可靠（没有精确一次语义、难以处理乱序），所以用批处理兜底正确性。代价是**同一套业务逻辑要实现两遍**：Spark SQL 一套、Flink 一套，口径稍有差异，大屏上的实时 GMV 就会和第二天日报对不上，排查极其痛苦。

### 2、Kappa：只保留流

Kafka 作者之一 Jay Kreps 在 2014 年的文章《Questioning the Lambda Architecture》中提出 Kappa 架构：既然流处理已经足够可靠，就**只保留一条流处理链路**。需要修正逻辑或重算历史时，让 Kafka 保留足够长的数据，启动新版本的作业从最早的位点重新消费，追上之后把下游切换到新结果，再下掉旧作业。

### 3、对比与现状

| 维度 | Lambda | Kappa |
|------|--------|-------|
| 链路 | 批 + 流两套 | 只有流 |
| 代码 | 同一逻辑两套实现，口径易不一致 | 一套代码 |
| 历史重算 | 批处理层天然支持 | 依赖消息队列长期保留与重放，数据量大时重放慢、成本高 |
| 复杂分析 | 批处理擅长大范围关联、全量去重 | 流处理做全历史关联代价高 |
| 运维 | 两套系统 | 一套系统，但流作业运维要求高 |
| 适用 | 存量离线数仓叠加实时需求 | 数据可重放、逻辑以增量为主的场景 |

纯粹的 Kappa 在实践中很少见：Kafka 保留几个月的全量数据成本太高，用流重放一年的订单也远不如批处理快。2026 年更常见的是**基于湖仓的流批一体**：

- 存储统一：数据以 Paimon / Iceberg 表的形式落在对象存储上，既能被 Flink 流式写入和流式读取（增量消费变更），也能被 Spark 批量读取和重算
- 逻辑尽量统一：用 Flink SQL 或 Spark SQL 表达，同一张表在流模式下增量刷新、在批模式下全量回刷，减少两套实现
- 延迟分级：秒级需求仍然走 Kafka + Flink 直出，分钟级需求走湖仓流式链路，T+1 对账走批处理

这种架构的落地细节见 [实时数仓实战](./9_realtime_dw)，Flink 侧的 Kafka 分层与 Paimon 分层对比见 [实战场景](/flink/8_scenarios) 第三节。

---

## 小结

- 大数据系统都在回答三件事：数据怎么切分存储、计算怎么并行、失败怎么恢复
- 批处理处理有界数据、结果确定、适合 T+1 与对账；流处理处理无界数据、延迟低但运维复杂。按需求的时效分级选择，能用批就不用流
- MapReduce 的遗产是分片并行、按 key Shuffle、任务级重试；Shuffle 要排序、落盘、跨网络，是分布式计算最贵的一步，Combiner 能在 Map 端预聚合减少传输
- Hadoop 3.5 服务端要求 Java 17；HDFS 默认 128 MB 块、3 副本，冷数据可用纠删码降到 1.5 倍开销，小文件是 NameNode 的大敌；YARN 按队列隔离资源。新平台多用对象存储 + Kubernetes 替代二者，但 `FileSystem` API 与 Hive Metastore 依然是生态的公共接口
- 存算分离换来独立扩缩、多引擎共享和更低成本，代价是网络延迟、列目录慢、重命名非原子，靠本地缓存、零重命名提交器和表格式的原子元数据提交来弥补
- 数据湖 = 对象存储 + 列存文件格式 + 表格式；只有存储和文件格式时容易沦为数据沼泽
- Lambda 用批兜底正确性但要维护两套逻辑，Kappa 只保留流但重放成本高；当前主流是以湖仓表为统一存储的流批一体
- 本篇只讲共同依赖的基本思想：流计算引擎本身（Flink 的运行时、状态、窗口）见 [Flink 概览](/flink/1_basics)，Spark 的执行模型见 [Spark](./3_spark)，Iceberg / Paimon 等表格式的内部原理见 [数据湖与湖仓](./4_lakehouse)

## 参考资料

- MapReduce 原始论文：[MapReduce: Simplified Data Processing on Large Clusters](https://research.google/pubs/mapreduce-simplified-data-processing-on-large-clusters/)
- Hadoop 版本发布：[Apache Hadoop Releases](https://hadoop.apache.org/releases.html)、[Hadoop 3.5.0 主要变化](https://hadoop.apache.org/docs/r3.5.0/index.html)
- HDFS 架构设计：[HDFS Architecture](https://hadoop.apache.org/docs/stable/hadoop-project-dist/hadoop-hdfs/HdfsDesign.html)
- HDFS 纠删码：[HDFS Erasure Coding](https://hadoop.apache.org/docs/stable/hadoop-project-dist/hadoop-hdfs/HDFSErasureCoding.html)
- HDFS 命令：[HDFS Commands Guide](https://hadoop.apache.org/docs/stable/hadoop-project-dist/hadoop-hdfs/HDFSCommands.html)
- YARN 架构：[Apache Hadoop YARN](https://hadoop.apache.org/docs/stable/hadoop-yarn/hadoop-yarn-site/YARN.html)、[Capacity Scheduler](https://hadoop.apache.org/docs/stable/hadoop-yarn/hadoop-yarn-site/CapacityScheduler.html)
- S3A 连接器：[Hadoop-AWS module: Integration with Amazon Web Services](https://hadoop.apache.org/docs/stable/hadoop-aws/tools/hadoop-aws/index.html)
- Spark 云存储集成与提交器：[Integration with Cloud Infrastructures](https://spark.apache.org/docs/latest/cloud-integration.html)
- Spark 作业提交：[Running Spark on YARN](https://spark.apache.org/docs/latest/running-on-yarn.html)
- S3 强一致性说明：[Amazon S3 Strong Consistency](https://aws.amazon.com/s3/consistency/)
- Kappa 架构原文：[Questioning the Lambda Architecture](https://www.oreilly.com/radar/questioning-the-lambda-architecture/)

> 下一篇：[数仓分层与建模](./2_data_warehouse)
