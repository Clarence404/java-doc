---
description: 运行架构、DataFrame、Java ETL、Stage 划分、倾斜与 AQE、分区缓存、Spark Connect
---

# Spark

> 前置阅读：[大数据基础](./1_basics)、[数仓分层与建模](./2_data_warehouse)

Spark 是通用的分布式计算引擎，核心思路是把计算描述成一张由算子组成的有向无环图（DAG），由引擎切分成 Stage 和 Task 并行执行，中间结果尽量放在内存里，今天在数据平台里主要承担**离线批处理**：数仓 ODS → DWD → DWS 的加工、湖仓表的写入与合并、特征工程和大规模数据回刷。本篇讲运行架构、DataFrame 与 Spark SQL、Java ETL 实战、Stage 划分、Shuffle 与倾斜、分区缓存与调优、Spark Connect 以及与 Flink 的选型，版本基线为 Spark 4.2.x。

---

## 一、运行架构

![Spark 运行架构：Driver、集群管理器与 Executor](../assets/big-data/spark-architecture.svg)

一个 Spark 应用由一个 Driver 和若干 Executor 组成，资源由外部的集群管理器分配：

| 角色 | 是什么 | 负责什么 |
|------|--------|----------|
| Driver | 运行 `main` 方法的 JVM 进程，持有 `SparkSession` | 解析代码生成逻辑计划，经优化器得到物理计划；DAGScheduler 按 Shuffle 边界切分 Stage；TaskScheduler 把 Task 派发到 Executor；跟踪 Task 状态、失败重试，汇总 `collect()` 等动作的结果 |
| Executor | 在工作节点上运行的 JVM 进程，生命周期与应用相同 | 执行 Task（一个 Task 处理一个分区）；在内存或磁盘中缓存数据；写出 Shuffle 文件并为下游提供读取 |
| 集群管理器 | 外部的资源调度系统 | 按 Driver 的请求启动和回收 Executor。可选 **YARN**、**Kubernetes**、**Standalone**（Spark 自带）；本地调试用 `local[*]` |

几个必须知道的概念：

- **Application → Job → Stage → Task**：一个应用里每触发一次动作（action）产生一个 Job；Job 在 Shuffle 处被切成多个 Stage；每个 Stage 按分区数生成同样多的 Task。Task 是调度的最小单位
- **并行度 = Executor 数 × 每个 Executor 的核数**：`spark.executor.cores=4` 表示一个 Executor 同时跑 4 个 Task。分区数远小于总核数时资源闲置，远大于时调度开销上升
- **部署模式**：`--deploy-mode client` 时 Driver 跑在提交命令的机器上，适合交互调试；`cluster` 时 Driver 也由集群管理器拉起，生产作业一律用 cluster，避免提交机故障或网络抖动拖垮作业
- **Driver 是单点**：Driver 进程挂掉整个应用失败；Executor 挂掉只会让其上的 Task 重新调度。不要在 Driver 上 `collect()` 大结果集，这是 Driver OOM 最常见的原因

**版本基线**：本篇以 **Spark 4.2.x** 为准（2026 年 7 月发布，4.1.x、4.0.x 仍在维护）。Spark 4 只提供 **Scala 2.13** 构建，运行在 **Java 17 / 21 / 25** 上，不再支持 Java 8 / 11；Python 要求 3.10 及以上。

::: tip Spark 4 的几个破坏性变化
- **ANSI SQL 模式默认开启**（`spark.sql.ansi.enabled=true`）：非法类型转换、整数溢出、除以零会直接报错，而不是像 3.x 那样静默返回 `null`。从 3.x 迁移的作业如果依赖旧行为，先用 `try_cast`、`try_divide` 改写，不要简单地把开关关掉
- **只支持 Scala 2.13**：依赖里所有带 Scala 后缀的构件都要换成 `_2.13`
- **Java 17 起步**：依赖 Java 8 / 11 的老 UDF 或第三方 Jar 需要一起升级
:::

---

## 二、RDD、DataFrame 与 Dataset

### 1、三种 API 的定位

| 维度 | RDD | DataFrame | Dataset |
|------|-----|-----------|---------|
| 是什么 | 分布式的对象集合，Spark 最底层的抽象 | 带 Schema 的分布式表，Java 里就是 `Dataset<Row>` | 带 Schema 的强类型对象集合，`Dataset<Order>` |
| 优化 | 无，代码怎么写就怎么执行 | Catalyst 优化器 + Tungsten 执行引擎 | 同 DataFrame，但 Lambda 内部对优化器不透明 |
| 存储 | JVM 对象，序列化开销大 | 堆外二进制行格式，紧凑 | 同 DataFrame，进出 Lambda 时需要编解码 |
| 类型检查 | 编译期 | 运行期（列名写错到执行时才报错） | 编译期 |
| Spark Connect | 不支持 | 支持 | 支持 |
| 适用 | 存量代码、需要精细控制分区的底层逻辑 | **绝大多数 ETL 与分析** | 需要强类型业务对象的复杂转换 |

结论：**新代码优先用 DataFrame + Spark SQL**。优化器能做列裁剪、谓词下推、Join 重排、常量折叠，手写 RDD 很难达到同样效果；Spark Connect 也不支持 RDD。只有确实需要逐对象处理复杂业务逻辑时，才局部转成 Dataset。

### 2、Catalyst 优化器做了什么

一条 SQL 或一段 DataFrame 代码在执行前会经过四个阶段：

1. **解析**：生成未解析的逻辑计划，此时列名和表名还没校验
2. **分析**：对照 Catalog 解析表和列，确定类型，写错列名在这一步报错
3. **逻辑优化**：基于规则改写，例如把 `filter` 推到数据源、只读用到的列、合并相邻的 `select`
4. **物理计划**：为每个算子挑选实现，例如 Join 选广播哈希还是排序合并，再由全阶段代码生成（whole-stage codegen）把一个 Stage 内的多个算子编译成一段紧凑的 Java 字节码

用 `explain("formatted")` 查看物理计划，是调优的第一步：确认谓词有没有下推到 `PushedFilters`、Join 策略是不是预期的、有几个 `Exchange`（每个 `Exchange` 就是一次 Shuffle）。

### 3、Java 里使用 Dataset

DataFrame 转强类型 Dataset 需要一个 `Encoder`，Java Bean 用 `Encoders.bean`。Java 的 Lambda 在 `map` 上有重载歧义，需要显式转型为 `MapFunction`：

```java
import org.apache.spark.api.java.function.FilterFunction;
import org.apache.spark.api.java.function.MapFunction;
import org.apache.spark.sql.Encoders;

// OrderLine 是普通 Java Bean：无参构造 + getter / setter，字段名与列名一致
Dataset<OrderLine> lines = ordersDf.as(Encoders.bean(OrderLine.class));

Dataset<String> riskyOrderIds = lines
        .filter((FilterFunction<OrderLine>) o -> o.getPayAmount().compareTo(o.getOriginAmount()) > 0)
        .map((MapFunction<OrderLine, String>) OrderLine::getOrderId, Encoders.STRING());
```

Lambda 内部的逻辑对 Catalyst 是黑盒，无法做谓词下推和列裁剪，所以能用列表达式（`col("pay_amount").gt(col("origin_amount"))`）写的就不要写成 Lambda。

---

## 三、Spark SQL

Spark SQL 是 Spark 里使用最广的部分：数仓开发几乎都在写 SQL，DataFrame API 和 SQL 生成的是同一种逻辑计划，性能没有差别，可以按团队习惯混用。

### 1、临时视图与 SQL

```java
ordersDf.createOrReplaceTempView("ods_order_item_inc");

Dataset<Row> topCategory = spark.sql("""
        SELECT category_id,
               SUM(pay_amount)            AS gmv,
               COUNT(DISTINCT user_id)    AS buyer_cnt
        FROM ods_order_item_inc
        WHERE dt = '2026-10-09' AND status = 'PAID'
        GROUP BY category_id
        ORDER BY gmv DESC
        LIMIT 20
        """);
topCategory.show(20, false);
```

临时视图只在当前 `SparkSession` 可见。要让表跨作业复用，需要接入一个持久化 Catalog：传统做法是 Hive Metastore（`enableHiveSupport()`，需额外引入 `spark-hive_2.13`），湖仓场景更常用 Iceberg / Paimon 提供的 Catalog，配置方式见 [数据湖与湖仓](./4_lakehouse)。

### 2、Spark 4 中值得用的 SQL 能力

| 能力 | 版本 | 用途 |
|------|------|------|
| ANSI 模式默认开启 | 4.0 | 类型转换和算术错误显式报错，配合 `try_cast` / `try_divide` 处理脏数据 |
| `VARIANT` 类型 | 4.0 引入，4.1 GA | 存半结构化 JSON（如订单扩展属性），比存字符串再 `from_json` 解析快 |
| SQL 管道语法 `\|>` | 4.0 | `FROM t \|> WHERE ... \|> AGGREGATE ...` 按书写顺序表达处理步骤 |
| `MERGE INTO` | 4.0 | 对支持行级操作的表（Iceberg、Delta 等）做 upsert |
| SQL 脚本 | 4.1 GA，默认开启 | 在一段 SQL 里写变量、`IF`、`WHILE`、异常处理 |
| 递归 CTE | 4.1 | 类目树、组织架构等层级展开 |
| `QUALIFY` 子句 | 4.2 | 直接按窗口函数结果过滤，取"每个用户最近一笔订单"不再需要套子查询 |

例如用 `QUALIFY` 对 ODS 订单按 `order_id` 去重、只保留最后一次更新：

```sql
SELECT *
FROM ods_order_info_inc
WHERE dt = '2026-10-09'
QUALIFY ROW_NUMBER() OVER (PARTITION BY order_id ORDER BY update_time DESC) = 1;
```

---

## 四、实战：订单 GMV 日报的 Java ETL

示例统一用电商订单场景：每天把 ODS 层的订单明细加工成按省份、类目汇总的 GMV 日报。需求：每天凌晨读取前一天的 ODS 订单（Parquet，按 `dt` 分区），关联 MySQL 中的用户维表和类目维表，算出按省份、一级类目汇总的 GMV、订单数、买家数，写到 DWS 层的 Parquet 表；同时把结果写到 MySQL 的中间表，供报表服务查询。

### 1、Maven 依赖

```xml
<properties>
    <maven.compiler.release>21</maven.compiler.release>
    <spark.version>4.2.0</spark.version>
    <scala.binary.version>2.13</scala.binary.version>
</properties>

<dependencies>
    <!-- spark-sql 已传递依赖 spark-core；集群上已有 Spark，scope 用 provided -->
    <dependency>
        <groupId>org.apache.spark</groupId>
        <artifactId>spark-sql_${scala.binary.version}</artifactId>
        <version>${spark.version}</version>
        <scope>provided</scope>
    </dependency>
    <!-- JDBC 驱动集群上没有，需要打进 Jar -->
    <dependency>
        <groupId>com.mysql</groupId>
        <artifactId>mysql-connector-j</artifactId>
        <version>9.7.0</version>
    </dependency>
</dependencies>

<build>
    <plugins>
        <plugin>
            <groupId>org.apache.maven.plugins</groupId>
            <artifactId>maven-shade-plugin</artifactId>
            <version>3.6.0</version>
            <executions>
                <execution>
                    <phase>package</phase>
                    <goals><goal>shade</goal></goals>
                </execution>
            </executions>
        </plugin>
    </plugins>
</build>
```

要点：

- **构件后缀必须是 `_2.13`**，并且与集群上 Spark 的版本一致；`provided` 依赖不会打进 Jar，避免与集群自带的 Spark 冲突
- 编译目标 `21` 要求集群上运行 Executor 的 JDK 也不低于 21；集群还停留在 Java 17 时，把 `maven.compiler.release` 改成 `17`
- 读写 S3 / OSS 等对象存储需要 `hadoop-aws` 之类的连接器，其版本必须与 Spark 发行包自带的 Hadoop 版本一致（看 `$SPARK_HOME/jars` 下 `hadoop-client-api-*.jar` 的版本号），不一致会出现 `NoSuchMethodError`
- 在 IDE 里直接 `main` 运行时，Java 17+ 的模块封装会导致 `IllegalAccessError`，需要给运行配置加上 `--add-opens=java.base/sun.nio.ch=ALL-UNNAMED` 等 JVM 参数；用 `spark-submit` 提交时脚本会自动添加

### 2、作业代码

```java
package com.example.mall.etl;

import org.apache.spark.sql.Dataset;
import org.apache.spark.sql.Row;
import org.apache.spark.sql.SaveMode;
import org.apache.spark.sql.SparkSession;

import java.util.Properties;

import static org.apache.spark.sql.functions.*;

public class OrderGmvDailyJob {

    public static void main(String[] args) {
        String dt = args[0];                                    // 业务日期，如 2026-10-09，由调度系统传入
        String jdbcUrl = "jdbc:mysql://mysql-ro.mall.internal:3306/mall";
        Properties jdbcProps = new Properties();
        jdbcProps.put("user", System.getenv("MALL_DB_USER"));   // 账号从环境变量 / Secret 注入，不写进代码
        jdbcProps.put("password", System.getenv("MALL_DB_PASSWORD"));

        SparkSession spark = SparkSession.builder()
                .appName("order-gmv-daily-" + dt)
                // 只覆盖本次写入涉及的 dt 分区，其他日期的数据保持不动
                .config("spark.sql.sources.partitionOverwriteMode", "dynamic")
                .getOrCreate();

        // 1. 事实表：按分区目录读取，dt 过滤会变成分区裁剪，只扫一天的数据
        Dataset<Row> orders = spark.read()
                .parquet("s3a://mall-lake/ods/ods_order_item_inc")
                .where(col("dt").equalTo(dt))
                .where(col("status").equalTo("PAID"))
                .select("order_id", "user_id", "category_id", "pay_amount", "dt");

        // 2. 用户维表：数千万行，按主键分 16 段并行读取
        Dataset<Row> users = spark.read()
                .format("jdbc")
                .option("url", jdbcUrl)
                .option("dbtable", "user_info")
                .option("user", jdbcProps.getProperty("user"))
                .option("password", jdbcProps.getProperty("password"))
                .option("partitionColumn", "id")
                .option("lowerBound", "1")
                .option("upperBound", "60000000")
                .option("numPartitions", "16")
                .option("fetchsize", "5000")
                .load()
                .select(col("id").alias("uid"), col("province"));

        // 3. 类目维表：只有几千行，用子查询把字段裁掉，后面广播
        Dataset<Row> categories = spark.read()
                .jdbc(jdbcUrl,
                      "(SELECT id, parent_id, root_name FROM category WHERE deleted = 0) AS c",
                      jdbcProps);

        // 4. 关联与聚合
        Dataset<Row> gmv = orders
                .join(users, orders.col("user_id").equalTo(users.col("uid")), "left")
                .join(broadcast(categories), orders.col("category_id").equalTo(categories.col("id")), "left")
                .groupBy(
                        col("dt"),
                        coalesce(col("province"), lit("未知")).alias("province"),
                        coalesce(col("root_name"), lit("未知")).alias("root_category"))
                .agg(
                        sum("pay_amount").alias("gmv"),
                        count(lit(1)).alias("order_cnt"),
                        countDistinct(col("user_id")).alias("buyer_cnt"));

        // 5. 结果复用两次，先缓存，避免上游重算
        gmv.cache();

        // 6. 写 DWS 层：每个 dt 分区合并成少量文件，避免小文件
        gmv.repartition(4)
                .write()
                .mode(SaveMode.Overwrite)
                .partitionBy("dt")
                .parquet("s3a://mall-lake/dws/dws_trade_province_category_order_1d");

        // 7. 写 MySQL 中间表：Overwrite + truncate 只清空数据、保留表结构和索引
        gmv.write()
                .format("jdbc")
                .option("url", "jdbc:mysql://mysql-report.mall.internal:3306/report")
                .option("dbtable", "ads_trade_gmv_province_category_1d_stage")
                .option("user", System.getenv("REPORT_DB_USER"))
                .option("password", System.getenv("REPORT_DB_PASSWORD"))
                .option("truncate", "true")
                .option("batchsize", "2000")
                .mode(SaveMode.Overwrite)
                .save();

        gmv.unpersist();
        spark.stop();
    }
}
```

几处容易写错的地方：

- **`lowerBound` / `upperBound` 不是过滤条件**：它们只用来计算每个分区的步长，范围之外的行会全部落进首尾两个分区。主键分布不均匀时（例如大量删除），首尾分区会特别大，此时改用 `predicates` 参数显式给出每个分区的 `WHERE` 条件
- **动态分区覆盖**：不设置 `partitionOverwriteMode=dynamic` 时，`Overwrite` 会先清空整张表的所有分区，重跑一天的数据会把历史全部删掉
- **JDBC 写入是非事务的**：每个分区各自提交，作业中途失败会留下部分数据。所以这里先写中间表，再由一条 SQL 在 MySQL 里按日期替换正式表；对外服务的查询层设计见 [OLAP 查询与数据服务](./7_olap_service)
- **从只读库读取**：分区并行读会同时向 MySQL 发起 `numPartitions` 个连接和大范围扫描，一定要连只读副本，并控制并发

### 3、提交作业

YARN 集群：

```bash
spark-submit \
  --master yarn \
  --deploy-mode cluster \
  --name order-gmv-daily \
  --class com.example.mall.etl.OrderGmvDailyJob \
  --driver-memory 4g \
  --executor-memory 8g \
  --executor-cores 4 \
  --conf spark.dynamicAllocation.enabled=true \
  --conf spark.dynamicAllocation.maxExecutors=50 \
  --conf spark.sql.adaptive.advisoryPartitionSizeInBytes=128m \
  order-etl-1.0.0.jar 2026-10-09
```

Kubernetes 集群：Driver 和 Executor 都以 Pod 运行，Jar 需要预先打进镜像（`local://` 表示镜像内路径），K8s 上没有外部 Shuffle 服务，开启动态分配时必须同时开启 Shuffle 跟踪：

```bash
spark-submit \
  --master k8s://https://k8s-api.mall.internal:6443 \
  --deploy-mode cluster \
  --name order-gmv-daily \
  --class com.example.mall.etl.OrderGmvDailyJob \
  --conf spark.kubernetes.namespace=data-jobs \
  --conf spark.kubernetes.container.image=registry.mall.internal/data/order-etl:1.0.0 \
  --conf spark.kubernetes.authenticate.driver.serviceAccountName=spark \
  --conf spark.executor.instances=10 \
  --conf spark.executor.memory=8g \
  --conf spark.executor.cores=4 \
  --conf spark.dynamicAllocation.enabled=true \
  --conf spark.dynamicAllocation.shuffleTracking.enabled=true \
  local:///opt/spark/app/order-etl-1.0.0.jar 2026-10-09
```

Driver 使用的 ServiceAccount 需要有创建 Pod 和 Service 的权限。生产上更推荐用官方的 Spark Kubernetes Operator（随 Spark 4.0 推出，以 `SparkApplication` 自定义资源声明作业，可通过 Helm 安装）统一管理作业生命周期。Pod、ServiceAccount、资源配额等 Kubernetes 基础见 [Kubernetes](/cloud-native/6_kubernetes)，作业的定时触发与依赖编排见 [任务调度](./6_scheduling)。

---

## 五、惰性求值、DAG 与 Stage

### 1、转换与动作

Spark 的算子分两类：

- **转换（transformation）**：`select`、`filter`、`join`、`groupBy`、`repartition` 等，只记录"要做什么"，返回新的 DataFrame，**不触发计算**
- **动作（action）**：`count`、`show`、`collect`、`write`、`foreach` 等，触发一个 Job，从数据源开始真正执行

上面的 ETL 里，第 1 到第 4 步执行完时集群上什么都没跑，直到第 6 步的 `write` 才提交第一个 Job。惰性求值让优化器能看到完整的计算链：`where` 可以下推到 Parquet 读取层，`select` 只读需要的 5 列，这些都要在知道全貌之后才能决定。

副作用是**同一个 DataFrame 被多次使用时，每个动作都会从头重算一遍**。第 6、7 步各触发一个 Job，如果没有 `cache()`，ODS 订单会被读两遍、Join 和聚合会算两遍。调试时随手加的 `count()` 和 `show()` 也会各触发一次完整计算，上线前要删掉。

### 2、窄依赖、宽依赖与 Stage 划分

![DAG 与 Stage：窄依赖在 Stage 内流水线执行，宽依赖处切分 Stage](../assets/big-data/spark-dag-stages.svg)

- **窄依赖**：子分区只依赖父 RDD 的一个（或固定几个）分区，例如 `filter`、`select`、`map`。多个窄依赖算子在同一个 Task 内流水线执行，数据不落盘、不走网络
- **宽依赖**：子分区依赖父 RDD 的所有分区，例如 `groupBy`、非广播的 `join`、`repartition`、`distinct`。需要 **Shuffle**：上游每个 Task 把数据按 key 哈希写成本地文件，下游 Task 再从所有上游节点拉取属于自己的那一份

DAGScheduler 从最终的动作往回看，**每遇到一个宽依赖就切出一个新 Stage**。在 Spark UI 的 SQL / DataFrame 页可以看到每个 Stage 的 Task 数、Shuffle 读写量和耗时分布，物理计划里的每个 `Exchange` 节点就是一次 Shuffle。

### 3、容错

RDD 记录了自己由哪些父分区经过什么运算得到（血缘，lineage）。某个 Task 失败时，Spark 只重算这个分区：窄依赖只需重算父分区中对应的一份；宽依赖则需要上游 Stage 的 Shuffle 文件，如果存放 Shuffle 文件的 Executor 已经丢失，会出现 `FetchFailedException`，Spark 会回退重跑上游 Stage。

血缘过长（例如循环迭代上百次）时，失败重算的代价会很高，可以用 `checkpoint()` 把中间结果写到可靠存储并截断血缘；普通 ETL 一般不需要。

---

## 六、Shuffle 与数据倾斜

### 1、减少 Shuffle

Shuffle 涉及磁盘写、网络传输和反序列化，是 Spark 作业里最贵的操作。减少它的常用手段：

- **广播小表**：一侧足够小（默认 `spark.sql.autoBroadcastJoinThreshold=10MB`）时，Spark 把小表复制到每个 Executor，大表原地关联，完全不需要 Shuffle。统计信息不准时用 `broadcast(df)` 或 SQL 提示 `/*+ BROADCAST(c) */` 强制指定，但被广播的表要先发送到 Driver 再分发，几百 MB 以上的表不要广播
- **先过滤、先裁列、先聚合**：把 `where` 和 `select` 尽量放在 Join 之前；能先预聚合再关联的就先聚合，Shuffle 的数据量直接取决于这一步
- **避免多余的重分区**：`repartition` 总会触发 Shuffle；只是减少分区数时用 `coalesce`，它合并相邻分区而不重新分发数据
- **利用表的分区布局**：两张 Iceberg 表按同一个 key 分桶时，Spark 可以走存储分区 Join（Storage Partition Join），计划里 Join 之前不出现 `Exchange`

### 2、识别倾斜

数据倾斜的典型表现：一个 Stage 里绝大多数 Task 几秒完成，少数几个 Task 跑几十分钟甚至 OOM，整个 Stage 被拖住。在 Spark UI 的 Stage 详情页看 Task 耗时和 Shuffle Read Size 的 Max 与 Median，差距在十倍以上就是倾斜。

电商场景里常见的倾斜源：

- **空值或默认值**：大量未登录订单的 `user_id` 为 `null` 或 `0`，Join 和 `groupBy` 时全部落到同一个分区
- **超级大 key**：头部商家、爆款商品、大促期间某个直播间的订单量是普通 key 的成千上万倍
- **业务枚举字段**：按 `status`、`channel` 这种只有几个取值的字段 `groupBy` 或分区

### 3、处理手段

**第一步：交给 AQE**。自适应查询执行（AQE）在每个 Stage 结束后根据实际的 Shuffle 统计重新优化后续计划，Spark 3.2 起默认开启，其中的倾斜 Join 优化会把超大的分区拆成多个 Task，同时复制另一侧对应的分区：

| 配置 | 默认值 | 含义 |
|------|--------|------|
| `spark.sql.adaptive.enabled` | `true` | AQE 总开关 |
| `spark.sql.adaptive.skewJoin.enabled` | `true` | 自动拆分排序合并 Join 中的倾斜分区 |
| `spark.sql.adaptive.skewJoin.skewedPartitionFactor` | `5.0` | 分区大小超过中位数的倍数 |
| `spark.sql.adaptive.skewJoin.skewedPartitionThresholdInBytes` | `256MB` | 同时还要超过这个绝对值才判定为倾斜 |
| `spark.sql.adaptive.forceOptimizeSkewedJoin` | `false` | 即使会引入额外 Shuffle 也强制做倾斜优化 |

AQE 的倾斜处理只覆盖**排序合并 Join**，对 `groupBy` 聚合的倾斜无能为力，也不一定能识别"不够大但明显偏多"的分区。

**第二步：处理空值和大 key**。`null` key 本来就关联不上任何维度，可以先拆出来单独处理，再 `unionByName` 回去：

```java
Dataset<Row> withUser = orders.filter(col("user_id").isNotNull())
        .join(users, orders.col("user_id").equalTo(users.col("uid")), "left");
Dataset<Row> anonymous = orders.filter(col("user_id").isNull())
        .withColumn("uid", lit(null).cast("bigint"))
        .withColumn("province", lit(null).cast("string"));
Dataset<Row> result = withUser.unionByName(anonymous);
```

**第三步：加盐两阶段聚合**。对聚合倾斜，给 key 拼一个随机前缀把一个大 key 打散到 N 个分区，先局部聚合，再去掉前缀做全局聚合：

![加盐两阶段聚合：随机前缀打散热点 key，局部聚合后再全局聚合](../assets/big-data/spark-skew-salting.svg)

```java
int saltBuckets = 16;
// orders 这里指带 shop_id 列的订单明细

Dataset<Row> partial = orders
        .withColumn("salt", floor(rand().multiply(saltBuckets)).cast("int"))
        .groupBy(col("shop_id"), col("salt"))
        .agg(sum("pay_amount").alias("part_gmv"), count(lit(1)).alias("part_cnt"));

Dataset<Row> shopGmv = partial
        .groupBy(col("shop_id"))
        .agg(sum("part_gmv").alias("gmv"), sum("part_cnt").alias("order_cnt"));
```

加盐只适用于可以分两步合并的聚合（`sum`、`count`、`max`、`min`），`countDistinct` 不能这样拆，需要先按 `(shop_id, user_id)` 去重后再计数。

对 Join 倾斜且 AQE 没有生效时，可以对大表的热点 key 加随机前缀 `0..N-1`，同时把小表中这些 key 的行复制 N 份并带上全部前缀，再按 `(key, salt)` 关联。代价是小表膨胀 N 倍，所以只对识别出的少数热点 key 这样做，其余 key 走普通 Join，最后 `union` 合并。

---

## 七、分区与缓存

### 1、三类分区

| 阶段 | 由什么决定 | 默认值 | 调整方法 |
|------|-----------|--------|----------|
| 读取分区 | 文件大小与 `spark.sql.files.maxPartitionBytes` | `128MB` 一个分区 | 大量小文件时调大，单文件过大时调小；JDBC 由 `numPartitions` 决定 |
| Shuffle 分区 | `spark.sql.shuffle.partitions` | `200` | AQE 会在运行时合并过小的分区；数据量很大时调高初始值，让 AQE 有合并空间 |
| 写出分区 | 最后一个 Stage 的分区数 × `partitionBy` 的取值数 | 跟随上游 | 写之前 `repartition` / `coalesce`，或用 `maxRecordsPerFile` 限制单文件行数 |

**写出分区决定了小文件数量**。`partitionBy("dt", "province")` 时，如果上游有 200 个分区，每个分区里都混着 34 个省份的数据，最坏会写出 200 × 34 个文件。写之前 `repartition(col("dt"), col("province"))` 能让同一目录的数据集中到同一个 Task，每个目录只产生一个文件；单个目录数据量过大时再配合 `maxRecordsPerFile` 拆分。小文件会拖慢 NameNode / 对象存储的列举和下游查询，湖仓表还可以靠定期合并（compaction）收敛，见 [数据湖与湖仓](./4_lakehouse)。

分区列的选择原则：按查询最常用的过滤条件分区（通常是日期），单个分区的数据量在几百 MB 到几 GB 之间；不要按 `user_id` 这种高基数字段分区，否则会产生海量目录。

### 2、缓存

| 方法 | 存储级别 | 说明 |
|------|----------|------|
| `df.cache()` | `MEMORY_AND_DISK` | Dataset 的默认级别，以列式格式缓存，内存放不下的部分溢写到本地磁盘 |
| `df.persist(StorageLevel.MEMORY_ONLY())` | 仅内存 | 放不下的分区不缓存，用到时重算 |
| `df.persist(StorageLevel.DISK_ONLY())` | 仅磁盘 | 重算代价极高、内存又紧张时使用 |
| `spark.catalog().cacheTable("t")` | `MEMORY_AND_DISK` | 缓存已注册的表或视图，SQL 里用 `CACHE TABLE t` |

用缓存的几条原则：

- **只缓存会被多次使用、且重算代价高的结果**，例如 ETL 里同时写两个目标的聚合结果、机器学习里反复迭代的训练集。只用一次的数据缓存只会浪费内存
- **缓存也是惰性的**：`cache()` 本身不触发计算，第一个动作执行时才真正写入缓存
- **用完立即 `unpersist()`**：缓存与 Shuffle、执行算子共享 Executor 内存，长期占用会挤压执行内存，导致更多溢写
- **缓存不是持久化**：Executor 丢失后缓存随之丢失，需要按血缘重算；需要跨作业复用的中间结果应写成表

---

## 八、常用调优

### 1、Executor 内存模型

Executor 的 JVM 堆（`spark.executor.memory`）扣除约 300MB 的保留内存后，按 `spark.memory.fraction`（默认 `0.6`）划出统一内存区，执行内存（Shuffle、Join、排序、聚合的缓冲区）和存储内存（缓存）在其中共享、可以互相借用，`spark.memory.storageFraction`（默认 `0.5`）是存储内存不会被执行内存抢走的保底比例；剩余部分留给用户代码中的对象。

堆外还有一块 `spark.executor.memoryOverhead`（默认是堆大小的 10%，最少 384MB），存放 JVM 自身开销、线程栈、Netty 缓冲区以及 Python Worker 等。YARN 或 Kubernetes 给容器分配的内存是**堆 + overhead**，容器被系统 OOM Killer 杀掉（YARN 日志里的 `exceeding memory limits`、K8s 里的 `OOMKilled`）通常是 overhead 不够，调大的应该是它而不是堆。

### 2、资源配置建议

| 参数 | 建议 | 说明 |
|------|------|------|
| `spark.executor.cores` | 4 到 5 | 太少导致 Executor 数量多、广播变量重复存放；太多则单个 JVM 的 GC 和 IO 争抢严重 |
| `spark.executor.memory` | 每核 2 到 4GB，单个 Executor 不超过约 32GB | 堆太大 GC 停顿变长，并失去压缩指针优化 |
| `spark.executor.memoryOverhead` | 默认值起步，堆外开销大时调高 | PySpark、大量 Shuffle 连接或被容器 OOM 时增加 |
| `spark.driver.memory` | 2 到 8GB | 需要 `collect` 或广播较大的表时适当增加 |
| `spark.dynamicAllocation.enabled` | 共享集群上开启 | 空闲 Executor 自动释放；YARN 需外部 Shuffle 服务，K8s 需开启 Shuffle 跟踪 |
| `spark.sql.shuffle.partitions` | 开启 AQE 时可设高一些 | 让每个 Shuffle 分区在 100 到 200MB 左右，AQE 再自动合并小分区 |
| `spark.sql.adaptive.advisoryPartitionSizeInBytes` | 默认 `64MB`，大作业可设 `128m` 到 `256m` | AQE 合并分区与拆分倾斜分区时的目标大小 |
| `spark.sql.autoBroadcastJoinThreshold` | 默认 `10MB`，可适度提高 | 设为 `-1` 关闭自动广播；提高前确认 Driver 和 Executor 内存足够 |

### 3、排查思路

| 现象 | 常见原因 | 处理 |
|------|----------|------|
| 少数 Task 特别慢 | 数据倾斜 | 按第六节处理：AQE、拆空值、加盐 |
| Executor 被容器 OOM 杀掉 | 堆外内存不足 | 调大 `memoryOverhead`，减少每个 Executor 的核数 |
| `java.lang.OutOfMemoryError: Java heap space` | 单个分区过大、广播表过大、缓存挤占 | 增加 Shuffle 分区数、取消不合理的广播、释放缓存 |
| Driver OOM | `collect()` 大结果、广播大表、分区数极多导致元数据膨胀 | 结果写到存储而不是拉回 Driver |
| `FetchFailedException` | Executor 丢失或 Shuffle 文件过大 | 检查节点稳定性与 OOM，增加分区数降低单个 Shuffle 块的大小 |
| 写出大量小文件 | 写出前分区数过多 | 写之前 `repartition` 或 `coalesce` |
| 任务都很快但作业总时长很长 | 分区过多调度开销大，或 Executor 申请太慢 | 减少分区、预留最小 Executor 数 |

调优的顺序：先看 `explain` 和 Spark UI 找到最慢的 Stage，确认是数据量、倾斜还是资源问题，再动参数。大多数作业靠"先过滤、广播小表、写前重分区、开 AQE"就能解决，只调内存参数往往治标不治本。作业级别的指标采集与告警见 [指标监控](/observability/2_metrics)。

---

## 九、Spark Connect

传统模式下，应用代码和 Driver 跑在同一个 JVM 里：客户端必须带上完整的 Spark 依赖，版本要与集群严格一致，一个用户的代码出问题可能拖垮整个 Driver。Spark Connect（3.4 引入，4.x 成熟）把两者拆开：

- **客户端**只是一个轻量库，把 DataFrame 操作编码成未解析的逻辑计划，通过 gRPC 发送给服务端，结果以 Arrow 格式流式返回
- **服务端**是常驻的 Spark Driver，负责分析、优化和执行；用 `./sbin/start-connect-server.sh` 启动，默认监听 `15002` 端口
- **连接方式**：连接串形如 `sc://host:15002`，Python 用 `SparkSession.builder.remote("sc://host:15002")`，JVM 客户端引入 `spark-connect-client-jvm_2.13`

它带来的好处是客户端可以独立升级、在 IDE 或 Notebook 里直接连远程集群调试，服务端也能隔离不同用户的会话。限制是**不支持 RDD 和 `SparkContext`**，客户端也拿不到静态的 Spark 配置，所以前面提到的"新代码优先用 DataFrame"在这里成了硬性要求。Spark 4.0 新增 `spark.api.mode` 配置，可以在不改代码的情况下让应用在 Classic 和 Connect 两种模式之间切换；4.1 起还提供了基于 Spark Connect 的 JDBC 驱动。

对于定时跑的离线 ETL，传统 `spark-submit` 依旧是主流；Spark Connect 更适合交互式分析、数据应用后端和多语言客户端统一接入。

---

## 十、Spark 与 Flink 怎么选

两者都是"流批一体"的分布式计算引擎，但出发点相反：Spark 以批为本体，流处理（Structured Streaming）默认是微批；Flink 以流为本体，批是有界的流。

| 维度 | Spark | Flink |
|------|-------|-------|
| 擅长 | 离线批处理、大规模 SQL 加工、机器学习与数据科学 | 低延迟流处理、大状态计算、CDC 实时同步 |
| 流处理延迟 | 微批通常为秒级；4.1 起 Structured Streaming 新增实时模式（Real-Time Mode），可达亚秒级 | 毫秒级，逐条处理 |
| 状态与时间语义 | 支持事件时间与水位线，状态能力在追赶 | 状态后端、Checkpoint、事件时间处理都是核心设计 |
| SQL 与生态 | Spark SQL 最成熟，湖仓表格式和数据科学工具（PySpark、MLlib）支持最全 | Flink SQL 流式语义完整，CDC 生态强 |
| 资源模型 | 作业运行完即释放资源 | 常驻作业，长期占用资源 |

实践中两者通常是互补关系，而不是二选一：

- **T+1 离线数仓、历史数据回刷、复杂多表加工、特征工程**：Spark
- **秒级以内的实时指标、实时风控、数据库变更实时入湖**：Flink
- **已有 Spark 体系、能接受分钟级延迟的准实时任务**：Spark Structured Streaming，复用技术栈
- **湖仓架构**：常见组合是 Flink 负责实时写入 Iceberg / Paimon，Spark 负责离线合并、批量回刷和重度分析，两者读写同一份表

更细的对比（包括 Kafka Streams）见 [Flink 概览](/flink/1_basics) 第一节；Flink 的部署与调优见 [部署与运维](/flink/7_deployment)；把两者组合成实时数仓的完整方案见 [实时数仓实战](./9_realtime_dw)。

---

## 小结

- Spark 应用 = 一个 Driver + 若干 Executor，资源由 YARN / Kubernetes / Standalone 分配；Driver 负责计划与调度，Executor 执行 Task 并保存缓存和 Shuffle 文件，生产作业用 cluster 模式
- Spark 4 只支持 Scala 2.13、运行在 Java 17 及以上，ANSI SQL 默认开启；新代码优先用 DataFrame + Spark SQL，Catalyst 负责谓词下推、列裁剪和 Join 策略选择，Spark Connect 不支持 RDD
- 转换是惰性的，动作才触发 Job；Job 在宽依赖处切分 Stage，每个分区一个 Task；同一个 DataFrame 用多次要缓存，用完 `unpersist`
- Shuffle 最贵：先过滤裁列、广播小表、避免多余的 `repartition`；倾斜先交给 AQE，再拆空值、对聚合加盐两阶段处理
- 读取分区看 `maxPartitionBytes`，Shuffle 分区看 `spark.sql.shuffle.partitions` 加 AQE 合并，写出前重分区控制小文件，覆盖分区表要开动态分区覆盖
- 容器被杀先调 `memoryOverhead`，堆 OOM 先查分区大小与广播；调参前先用 `explain` 和 Spark UI 定位最慢的 Stage
- 离线批处理与大规模 SQL 加工选 Spark，低延迟流处理与 CDC 选 Flink，湖仓架构里两者读写同一份表
- 本篇只讲 Spark 自身：流处理、CDC 入湖与 Flink SQL 见 [Flink 总览](/flink/0_overview)；Doris / StarRocks 等 OLAP 引擎见 [列式与 OLAP 数据库](/database/4_nosql/0_column_db)；Iceberg / Paimon 表格式见 [数据湖与湖仓](./4_lakehouse)；作业编排见 [任务调度](./6_scheduling)

## 参考资料

- Spark 官方文档首页（运行环境要求）：[Spark Overview](https://spark.apache.org/docs/latest/)
- 版本发布说明：[Spark Release 4.0.0](https://spark.apache.org/releases/spark-release-4-0-0.html)、[Spark Release 4.1.0](https://spark.apache.org/releases/spark-release-4.1.0.html)、[Spark Release 4.2.0](https://spark.apache.org/releases/spark-release-4-2-0.html)
- 集群架构：[Cluster Mode Overview](https://spark.apache.org/docs/latest/cluster-overview.html)
- Spark SQL 与 DataFrame：[Spark SQL, DataFrames and Datasets Guide](https://spark.apache.org/docs/latest/sql-programming-guide.html)
- JDBC 数据源：[JDBC To Other Databases](https://spark.apache.org/docs/latest/sql-data-sources-jdbc.html)
- ANSI 模式：[ANSI Compliance](https://spark.apache.org/docs/latest/sql-ref-ansi-compliance.html)
- 性能调优与 AQE：[Performance Tuning](https://spark.apache.org/docs/latest/sql-performance-tuning.html)、[Tuning Spark](https://spark.apache.org/docs/latest/tuning.html)
- 配置项：[Spark Configuration](https://spark.apache.org/docs/latest/configuration.html)
- RDD 与持久化：[RDD Programming Guide](https://spark.apache.org/docs/latest/rdd-programming-guide.html)
- 提交作业：[Submitting Applications](https://spark.apache.org/docs/latest/submitting-applications.html)
- 运行在 Kubernetes：[Running Spark on Kubernetes](https://spark.apache.org/docs/latest/running-on-kubernetes.html)、[Spark Kubernetes Operator](https://github.com/apache/spark-kubernetes-operator)
- 运行在 YARN：[Running Spark on YARN](https://spark.apache.org/docs/latest/running-on-yarn.html)
- Spark Connect：[Spark Connect Overview](https://spark.apache.org/docs/latest/spark-connect-overview.html)
- 监控与 Spark UI：[Monitoring and Instrumentation](https://spark.apache.org/docs/latest/monitoring.html)

> 下一篇：[数据湖与湖仓](./4_lakehouse)
