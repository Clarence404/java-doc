---
description: 元数据与数据分离、分块与副本、HDFS、Ceph、JuiceFS、FastDFS / NAS、选型与 Java 接入
---

# 分布式文件系统

> 前置阅读：[文件系统与磁盘 IO](/os/7_file_io)、[存储引擎：B+ 树与 LSM-Tree](./1_storage_engine)、[对象存储](/architecture/5_object_storage)

分布式文件系统把多台机器的磁盘拼成一个可共享、可容错的目录树。本篇讲通用架构、HDFS、Ceph、JuiceFS 与选型接入，基线为 Hadoop 3.5、Ceph 20 与 JuiceFS 1。

---

## 一、为什么需要分布式文件系统

### 1、单机文件系统的三个上限

本地文件系统（ext4 / xfs，见 [文件系统与磁盘 IO](/os/7_file_io)）解决的是一块盘上怎么组织文件，规模一大就碰到三个上限：

- **容量**：单机能挂的盘有限，几百 TB 到 PB 级的数据放不进一台机器
- **可靠性**：RAID 只能防磁盘损坏，防不了整机宕机、机架断电；机器挂了，数据就不可访问
- **共享访问**：多台计算节点要读写同一批文件（Spark 作业、训练任务、多副本应用），单机只能靠 NFS 导出，而 NFS 服务器本身又是单点

分布式文件系统的做法是：数据切块分散到多台机器，每块存多份或加校验块，再用一套元数据服务对外呈现成统一的目录树。

### 2、与对象存储的定位差异

对象存储是扁平的 key 空间、整对象覆盖、走 HTTP；分布式文件系统保留目录树和文件内读写语义，部分产品兼容 POSIX，可以直接挂载。块、文件、对象三类存储的完整对比见 [对象存储 · 块存储、文件存储与对象存储](/architecture/5_object_storage#二、块存储、文件存储与对象存储)，本篇只讲文件这一类。

---

## 二、核心架构要素

![分布式文件系统通用架构：元数据与数据分离](../../assets/database/dfs-meta-data-split.svg)

### 1、元数据与数据分离

几乎所有分布式文件系统都把系统分成两个面：

- **元数据（控制面）**：目录树、文件属性、权限，以及「文件由哪些块组成、每块在哪些节点」的映射。操作小而频繁（`ls`、`stat`、`open`、`rename`），要求强一致
- **数据（数据面）**：真正的文件内容，按块存在数据节点上。流量大，但只需要按块寻址

客户端先问元数据服务拿到块位置，再直接连数据节点读写，大流量不经过元数据服务。这样数据面可以加机器线性扩展，而元数据服务就成了整个系统的**扩展瓶颈**：HDFS 把元数据全放 NameNode 内存，Ceph 用 MDS 集群管理文件元数据，JuiceFS 则把元数据交给 Redis、TiKV 或数据库。

### 2、分块、副本与纠删码

- **分块**：大文件切成定长块（HDFS 默认 128 MB），不同块落在不同节点上，读一个大文件可以多节点并行。块越大，元数据越少，但小文件的浪费也越明显
- **多副本**：每块存 3 份，放到不同机器、不同机架（故障域），任意一台机器甚至一个机架故障都不丢数据；代价是 3 倍空间
- **纠删码（EC）**：把 k 个数据块算出 m 个校验块，任意丢 m 块可恢复。例如 6+3 只要 1.5 倍空间就能容忍 3 块丢失，但写入要算校验、修复要读多块，适合冷数据和大文件

### 3、一致性与租约

多个客户端同时写一个文件是分布式文件系统最难处理的情况，主流做法是用**租约（Lease）**保证单写者：

- 客户端打开文件写入前向元数据服务申请租约，租约有过期时间，持有期间其他客户端不能写
- 写者需要定期续约；写者宕机后租约到期，系统做「租约恢复」，把最后一个块的副本对齐后关闭文件
- 读者能看到多少数据取决于语义：HDFS 写入中的数据要等 `hflush` 或 `close` 后才保证可见；JuiceFS 默认提供 close-to-open 一致性，即一个客户端关闭文件后，其他客户端再打开能读到最新内容

### 4、客户端缓存

元数据和数据都离客户端有一次网络往返，缓存是性能的关键：

- **元数据缓存**：缓存目录项和属性，减少 `stat` / `ls` 请求；代价是其他客户端的修改要过一段时间才能看到
- **数据缓存**：读缓存放内存或本地 SSD，对 AI 训练这种「同一批数据反复读多轮」的负载提速明显；写缓存可以合并小写，但掉电或进程崩溃前未上传的数据会丢
- **缓存一致性**：Ceph 的 MDS 通过 capability（能力授权）通知客户端哪些内容可以缓存、何时失效；JuiceFS 的缓存失效靠超时和 close-to-open 语义。业务需要跨节点强一致读时，要查清楚具体产品的缓存参数，不能按本地文件系统的直觉假设

---

## 三、HDFS

HDFS 是 Hadoop 的分布式文件系统，参考 Google GFS 设计，面向「一次写入、多次读取」的大文件批处理。组件职责、常用命令与纠删码配置已在 [大数据基础 · HDFS 的设计](/big-data/1_basics#_1、hdfs-的设计) 列出，这里补充架构上的要点。

### 1、NameNode 与 DataNode

- **NameNode**：维护整个命名空间与块映射，全部常驻内存；命名空间的修改先写 EditLog，定期合并成 FsImage 快照
- **DataNode**：存放块文件，定期发心跳和块报告；NameNode 发现副本不足时会安排复制补齐
- **写入流水线**：客户端从 NameNode 拿到 3 个 DataNode，按 DN1 → DN2 → DN3 串成流水线，数据按包依次转发，全部确认后才算写完
- **只追加**：文件写完后只能追加（append）或整体覆盖，不支持随机修改中间某段，这也是它不适合当通用 POSIX 文件系统的原因

### 2、块、三副本与机架感知

默认块大小 128 MB、3 副本。开启机架感知（配置拓扑脚本，让 NameNode 知道每台机器在哪个机架）后，常见放置策略是：第一副本放写入方所在节点，第二、三副本放在另一个机架的两台节点上。这样既能容忍整个机架故障，又只产生一次跨机架传输。读取时客户端优先读离自己最近的副本。

### 3、NameNode HA 与 Federation

- **HA**：Active 与 Standby 两个（或多个）NameNode 通过 JournalNode 集群（QJM）共享 EditLog，ZKFC 借助 ZooKeeper 做故障检测与自动切换；同时需要隔离（fencing），防止两个 NameNode 同时以为自己是 Active
- **Observer NameNode**：从 JournalNode 同步元数据，专门承接读请求，减轻 Active 压力
- **Federation**：单个 NameNode 的内存决定了文件数上限，Federation 让多个 NameNode 各管一部分命名空间（如 `/user`、`/warehouse`），共享同一批 DataNode；配合 Router-based Federation 对客户端呈现统一视图

### 4、小文件问题

每个文件、目录、块都在 NameNode 内存里占一个对象，大量小文件会耗尽 NameNode 堆、拖慢重启，还会让计算任务数暴增。治理办法是写入端控制文件大小、定期合并，湖仓表格式自带 Compaction，详见 [大数据基础 · HDFS 的设计](/big-data/1_basics#_1、hdfs-的设计) 与 [数据湖与湖仓 · 小文件治理与表维护](/big-data/4_lakehouse#六、小文件治理与表维护)。

### 5、适用场景与趋势

HDFS 仍是存量自建 Hadoop 集群的主力存储，适合大文件顺序读写、对吞吐敏感、计算与存储同机部署（数据本地性）的批处理。新平台的趋势是**存算分离**：数据放对象存储，上面用 Iceberg / Paimon 管理表，计算跑在 Kubernetes 上，原因与代价见 [大数据基础 · 存算分离](/big-data/1_basics#五、存算分离)。从 HDFS 迁移时，代码层面通常只需把 `hdfs://` 换成 `s3a://` 并补齐配置。

---

## 四、Ceph

Ceph 是统一的分布式存储系统，一套集群同时提供块、文件、对象三种接口，常见于私有云和自建 Kubernetes 平台。

### 1、RADOS 与核心组件

Ceph 的底座是 RADOS（可靠自治分布式对象存储），所有接口最终都落成 RADOS 里的对象：

| 组件 | 职责 |
|------|------|
| OSD | 每块盘一个守护进程，负责存对象、复制、恢复与数据均衡，默认使用 BlueStore 直接管理裸盘 |
| MON | 维护集群拓扑图（cluster map），用 Paxos 保证一致，通常部署 3 或 5 个 |
| MGR | 监控指标、Dashboard 与编排模块 |
| MDS | 只给 CephFS 用，管理目录树与文件元数据；块和对象接口不需要 |

数据按存储池（Pool）组织，池内对象先映射到归置组（PG），PG 再映射到一组 OSD；每个池可以独立选择多副本或纠删码。

### 2、CRUSH：算出位置，而不是查表

HDFS 靠 NameNode 记录每个块在哪里；Ceph 的块位置是**算出来的**：客户端拿到集群拓扑图后，用 CRUSH 算法根据对象名、PG 和故障域规则（主机、机架、机房）直接计算出该去哪些 OSD 读写，不需要中心节点逐个查询。好处是没有块映射这个元数据瓶颈；代价是加减盘时 CRUSH 结果变化，会触发数据迁移，扩容要控制节奏。

### 3、三种接口

- **RBD（块）**：把 RADOS 对象拼成虚拟块设备，给虚拟机磁盘、数据库数据盘使用，一般一次只挂给一台主机
- **CephFS（文件）**：POSIX 兼容的共享文件系统，由 MDS 管理元数据，多台主机可同时挂载读写
- **RGW（对象）**：提供 S3 / Swift 兼容的 HTTP 接口，常作为自建对象存储，选型对比见 [对象存储 · 自建选型与 MinIO 现状](/architecture/5_object_storage#六、自建选型与-minio-现状)

### 4、在 Kubernetes 中使用：Rook

Kubernetes 的持久化存储通过 PVC、StorageClass 与 CSI 驱动配合（见 [Kubernetes · 存储](/cloud-native/6_kubernetes#七、存储)）。Rook 是 Ceph 的 Kubernetes Operator，负责在集群内部署和运维 Ceph，并通过 Ceph CSI 提供两类 StorageClass：

- RBD 卷：访问模式 `ReadWriteOnce`，给数据库、中间件等有状态服务
- CephFS 卷：访问模式 `ReadWriteMany`，给需要多 Pod 共享目录的应用

::: tip Ceph 的运维门槛
Ceph 功能全面，但调优、扩容、故障恢复都需要懂存储的人长期维护；没有专职存储团队时，优先考虑云厂商的块存储、NAS 和对象存储。
:::

---

## 五、对象存储 + 元数据引擎：JuiceFS

![HDFS、Ceph、JuiceFS 架构对比](../../assets/database/dfs-arch-compare.svg)

### 1、架构思路

对象存储便宜、可靠、容量近乎无限，但没有目录树、不支持随机写、列目录和重命名慢。JuiceFS 这类新架构的思路是把两者拼起来：

- **元数据引擎**：目录树、文件属性和块映射放在 Redis、TiKV、MySQL、PostgreSQL 等外部数据库里，`rename`、`ls` 都是数据库事务，速度快且原子
- **数据**：文件按 Chunk（64 MB）→ Slice → Block（默认 4 MB）切分，Block 作为对象写进 S3、OSS、Ceph RGW 等对象存储；对象写入后不再修改，文件的修改通过写新 Slice 并更新元数据完成
- **客户端**：通过 FUSE 挂载成 POSIX 文件系统，也提供兼容 HDFS 的 Java SDK、S3 网关和 Kubernetes CSI 驱动

社区版以 Apache 2.0 开源；同类思路的还有 Alluxio（偏缓存加速层）、CubeFS 等，选型时以各项目当前的文档和发布节奏为准。

### 2、POSIX 兼容与缓存

- 兼容大部分 POSIX 语义（随机读写、文件锁、扩展属性），应用可以把挂载点当本地目录用
- 本地缓存目录放在 SSD 上，读缓存命中后不再访问对象存储；写回缓存（writeback）能加速小写，但上传完成前节点故障会丢数据，生产慎开
- 元数据引擎的选择决定上限：Redis 延迟最低，但持久化与容量受单机内存限制；TiKV、MySQL 更可靠、容量更大，延迟略高

### 3、适用场景

- **AI 训练数据**：海量图片、文本样本放对象存储，训练节点通过挂载点读取，多轮 epoch 依赖本地缓存提速
- **大数据存算分离**：用 Java SDK 替换 HDFS，既保留 `rename` 原子性和快速列目录，又享受对象存储的成本
- **Kubernetes 共享存储**：需要 `ReadWriteMany` 但不想自建 Ceph 时，用 JuiceFS CSI 挂到对象存储上

---

## 六、其他方案

- **GlusterFS**：无中心元数据、靠哈希定位文件的分布式文件系统，过去常用于共享存储；近年社区活跃度明显下降，Red Hat 的商业支持也已结束，新项目不建议引入，存量集群宜规划迁移
- **FastDFS**：国内老项目常见的轻量级文件服务（Tracker + Storage），面向图片、附件这类小文件，通过返回的文件 ID 访问，不提供 POSIX 语义；新项目基本被对象存储替代，存量系统迁移时通常写一个按文件 ID 回源的兼容层
- **云上 NAS**：AWS EFS、阿里云 NAS、Azure Files 等托管文件存储，以 NFS / SMB 协议挂载，免运维、按量付费，适合多台机器共享目录、传统应用上云；对单文件高吞吐的 AI 与 HPC 负载，云厂商另有基于 Lustre 等的并行文件系统产品

---

## 七、选型与常见坑

### 1、按场景选型

| 场景 | 推荐 | 说明 |
|------|------|------|
| 图片、视频、附件、备份 | 对象存储 | 走 HTTP 与 CDN，不需要文件系统，见 [对象存储](/architecture/5_object_storage) |
| 存量 Hadoop 批处理 | HDFS | 保持现状，逐步把冷数据和新表迁到对象存储 |
| 新建数据湖、湖仓 | 对象存储 + 表格式 | 存算分离，必要时加 JuiceFS 或缓存层补元数据性能 |
| AI 训练数据集 | JuiceFS / 云上并行文件系统 | 需要 POSIX 挂载与本地缓存 |
| 自建私有云统一存储 | Ceph（Rook） | 块、文件、对象一套集群，需要专职运维 |
| K8s 多 Pod 共享目录 | 云 NAS / CephFS / JuiceFS | 访问模式 `ReadWriteMany` |
| 数据库数据盘 | 块存储（云盘、RBD） | 需要低延迟随机写与 fsync，不要放共享文件系统 |

### 2、常见坑

- **小文件**：HDFS 撑爆 NameNode 内存，对象存储请求次数暴涨，JuiceFS 元数据引擎压力变大；写入端合并成百 MB 级文件是共同的解法
- **元数据瓶颈**：大目录（单目录几百万文件）`ls`、批量 `rename`、频繁 `stat` 都打在元数据服务上；按日期或哈希拆目录，避免在热路径上列目录
- **POSIX 语义差异**：HDFS 不支持随机写；不同产品对文件锁、`mmap`、硬链接、`fsync` 的支持程度不同；对象存储上的「目录」只是前缀，S3A 的 `rename` 是拷贝加删除、非原子。应用把挂载点当本地盘用之前，要按自己的读写方式实测
- **跨机房延迟**：同步多副本跨机房会把每次写的延迟抬到跨机房 RTT 级别；跨地域一般用异步复制，接受少量数据延迟，容灾设计见 [多活与容灾](/high-avail/9_multi_active)

---

## 八、Java 接入

### 1、HDFS Java API

依赖 `hadoop-client-api` 与 `hadoop-client-runtime`（版本与集群保持一致），通过 `FileSystem` 抽象读写：

```java
Configuration conf = new Configuration();
// 通常把集群的 core-site.xml、hdfs-site.xml 放到 classpath，这里只演示关键项
conf.set("fs.defaultFS", "hdfs://nameservice1");

// newInstance 返回独立实例；FileSystem.get 返回全局缓存实例，关闭它会影响同进程其他使用者
try (FileSystem fs = FileSystem.newInstance(URI.create("hdfs://nameservice1"), conf)) {
    Path path = new Path("/data/report/dt=2026-10-28/summary.csv");

    try (FSDataOutputStream out = fs.create(path, true)) {
        out.write("order_id,amount\n1001,99.00\n".getBytes(StandardCharsets.UTF_8));
        out.hsync();   // 刷到 DataNode 磁盘；hflush 只保证对新读者可见
    }

    try (BufferedReader reader = new BufferedReader(
            new InputStreamReader(fs.open(path), StandardCharsets.UTF_8))) {
        reader.lines().forEach(System.out::println);
    }
}
```

- `nameservice1` 是 HA 模式下的逻辑名，由 `hdfs-site.xml` 映射到多个 NameNode，客户端自动故障转移
- 开启 Kerberos 的集群需要先用 `UserGroupInformation` 登录，凭证放 keytab 文件，不要写进代码

### 2、挂载型文件系统：按本地文件用

JuiceFS、CephFS、NAS 挂载后对 Java 就是普通目录，直接用 `java.nio.file.Files` 读写；需要落盘保证时对 `FileChannel` 调 `force(true)`，具体能保证到哪一步取决于产品的 `fsync` 实现与缓存配置。Kubernetes 中通过 PVC 把卷挂进 Pod，应用只看到挂载路径。

### 3、Hadoop S3A

大数据引擎访问对象存储用 Hadoop 的 S3A 连接器，代码仍是 `FileSystem` API，只把路径换成 `s3a://bucket/path` 并配置 endpoint 与凭证，配置示例见 [大数据基础 · 从 Spark 访问对象存储](/big-data/1_basics#_3、从-spark-访问对象存储)。业务服务直接存取文件则用 AWS SDK，见 [对象存储](/architecture/5_object_storage)。

---

## 小结

- 分布式文件系统解决单机容量、可靠性和共享访问的上限，与对象存储的区别在于保留目录树和文件内读写语义
- 通用架构是元数据与数据分离：客户端查元数据后直连数据节点；分块提供并行，多副本或纠删码提供冗余，租约保证单写者
- HDFS 用 NameNode 内存管理元数据，128 MB 块、三副本加机架感知，HA 靠 QJM + ZKFC，扩展靠 Federation；小文件是主要痛点，新平台向对象存储迁移
- Ceph 以 RADOS 为底座，用 CRUSH 计算数据位置，提供 RBD、CephFS、RGW 三种接口，在 Kubernetes 中通过 Rook 提供 RWO 与 RWX 卷
- JuiceFS 把元数据放数据库、数据切块放对象存储，兼顾 POSIX 兼容与对象存储成本，适合 AI 训练和存算分离
- GlusterFS 不再适合新项目，FastDFS 逐步被对象存储替代，云 NAS 是共享目录的省心选择；小文件、元数据瓶颈、POSIX 差异和跨机房延迟是共同的坑

## 参考资料

- Apache Hadoop：[HDFS Architecture](https://hadoop.apache.org/docs/stable/hadoop-project-dist/hadoop-hdfs/HdfsDesign.html)
- Apache Hadoop：[HDFS High Availability Using the Quorum Journal Manager](https://hadoop.apache.org/docs/stable/hadoop-project-dist/hadoop-hdfs/HDFSHighAvailabilityWithQJM.html)、[HDFS Federation](https://hadoop.apache.org/docs/stable/hadoop-project-dist/hadoop-hdfs/Federation.html)
- Sanjay Ghemawat et al.：[The Google File System](https://research.google/pubs/the-google-file-system/)
- Ceph Documentation：[Architecture](https://docs.ceph.com/en/latest/architecture/)、[CRUSH Maps](https://docs.ceph.com/en/latest/rados/operations/crush-map/)
- Rook：[Rook Documentation](https://rook.io/docs/rook/latest/)
- JuiceFS：[Architecture](https://juicefs.com/docs/community/architecture/)、[How to Set Up Metadata Engine](https://juicefs.com/docs/community/databases_for_metadata/)

> 下一篇：[数据库选型参考](./2_selection_guide) —— 全景选型矩阵、按场景选型、经典组合架构、评估维度、常见误区
