---
description: 异步导出任务、主键游标分批读、SXSSF / EasyExcel 流式写、预签名下载、分批导入校验、导入幂等
---

# 海量数据导入导出

> 前置阅读：[MySQL 索引](/database/1_mysql/4_topic_index)、[数据访问性能](/high-perf/10_db_performance)、[对象存储](/architecture/4_object_storage)

后台的「导出 Excel」和「批量导入」在数据量到了百万行时，同步链路的每一环都会出问题。本篇的思路是**同步请求只负责提交任务，数据按批流过内存，结果文件放对象存储**，并讲清导出不 OOM、导入可校验可防重，以及每一步的内存与耗时估算。

---

## 一、问题

本文的估算口径：一行 20 列；1MB = 1024KB；耗时数字只用来说明量级，实际以压测为准。

### 1、百万行导出

最直接的写法是「一次查出全部 → 放进 `XSSFWorkbook` → 写到响应流」，数据一大就会遇到三个问题：

| 问题 | 原因 | 估算 |
|------|------|------|
| OOM | 结果集、Java 对象、Excel 对象模型三份数据同时在堆里 | 见下方内存账 |
| 接口超时 | 查询 + 生成文件 + 传输都在一个 HTTP 请求里 | 网关超时通常 30～60 秒，百万行导出常常要几分钟 |
| 拖垮数据库 | 大结果集长时间占用连接；用 `LIMIT offset, n` 深分页反复扫描 | 见第三节的扫描行数估算 |

**内存账**（100 万行 × 20 列）：

- Java 对象：每列平均是一个约 56B 的短字符串（对象头与字段 24B + byte[] 约 32B），一行约 20 × 56B + 对象头约 100B ≈ 1.2KB，100 万行 ≈ 1.2 × 10⁹ B ≈ 1.1GB
- `XSSFWorkbook`：每个单元格都是一个对象，还挂着 XML 结构。按每个单元格约 300B 的经验值估算，2 × 10⁷ 个单元格 ≈ 6 × 10⁹ B ≈ 5.6GB
- 驱动结果集：MySQL Connector/J 默认把整个结果集读进内存，再多几百 MB

几个导出请求同时进来，4GB 堆的机器必然 Full GC 甚至 OOM，拖累同一实例上的所有接口。

### 2、批量导入

| 问题 | 表现 |
|------|------|
| 校验慢 | 每行查一次库校验唯一性，10 万行 × 2ms = 200 秒 |
| 部分失败 | 第 5 万行格式错误，前面的已经入库，后面的没有；用户不知道哪些成功了 |
| 重复导入 | 用户点了两次、网络超时后重新上传、任务重试，同一批数据被写入两次 |

---

## 二、导出整体方案

![异步导出整体流程](../assets/scenario/sheet-export-flow.svg)

整条链路拆成五步，同步请求只做第一步：

1. **提交任务**：接口校验权限和筛选条件，把条件写进任务表，立即返回 taskId。条件存在服务端，执行时不再信任前端传参
2. **异步执行**：独立线程池从任务表抢任务，和业务接口的线程池隔离
3. **流式读写**：按批从从库读数据、按批写进本地临时文件，内存里任何时刻只有一批数据
4. **上传对象存储**：文件写完后上传，应用实例上不留文件，任何实例都能提供下载
5. **通知与下载**：用户收到通知后点击下载，服务端校验归属后签发预签名 URL

**耗时估算**：100 万行、每批 5000 行，共 1,000,000 ÷ 5,000 = 200 批。每批按主键游标查询约 20ms、写文件约 50ms，合计 200 × 70ms = 14 秒；字段多、行宽大时会到分钟级。这个耗时放在同步请求里不可接受，放在后台任务里完全没问题。

---

## 三、流式读数据

从数据库读百万行有两种思路：**一条 SQL 流式读完**，或者**按主键游标拆成多条短 SQL**。

### 1、流式结果集

MySQL Connector/J 默认把整个结果集一次性拉到客户端内存，`fetchSize` 设成普通正数不起作用。想要流式读取，有两种设置：

| 方式 | 设置 | 原理 | 注意 |
|------|------|------|------|
| 逐行流式 | `fetchSize = Integer.MIN_VALUE`，且语句为 `FORWARD_ONLY` + `READ_ONLY` | 服务端持续推送，客户端读一行取一行 | 读完之前这条连接不能执行其他语句；客户端处理太慢会触发服务端 `net_write_timeout`（默认 60 秒） |
| 服务端游标 | URL 加 `useCursorFetch=true`，`fetchSize` 设正数（如 1000） | 服务端先把结果物化到临时表，客户端每次取 1000 行 | 大结果集会在服务端产生大临时表，占用磁盘和 IO |

MyBatis 用 `Cursor` 配合逐行流式：

```java
@Mapper
public interface OrderExportMapper {

    @Select("""
            SELECT id, order_no, user_id, amount, status, created_at
            FROM t_order
            WHERE created_at >= #{start} AND created_at < #{end}
            """)
    @Options(resultSetType = ResultSetType.FORWARD_ONLY, fetchSize = Integer.MIN_VALUE)
    Cursor<OrderExportRow> streamByTime(@Param("start") LocalDateTime start,
                                        @Param("end") LocalDateTime end);
}

// Cursor 依赖 SqlSession 不被关闭，所以要在事务内遍历
@Transactional(readOnly = true)
public void export(LocalDateTime start, LocalDateTime end, Consumer<OrderExportRow> sink) {
    try (Cursor<OrderExportRow> cursor = mapper.streamByTime(start, end)) {
        cursor.forEach(sink);
    } catch (IOException e) {
        throw new UncheckedIOException(e);
    }
}
```

JdbcTemplate 同理：`setFetchSize(Integer.MIN_VALUE)` 后用 `RowCallbackHandler` 或 `queryForStream`（Stream 必须关闭）逐行处理。流式结果集的问题是一条连接要占用整个导出过程，失败也只能从头再来。

### 2、按主键游标分批（推荐）

更稳妥的做法是用主键做游标，每次只查一批：

```sql
SELECT id, order_no, user_id, amount, status, created_at
FROM t_order
WHERE created_at >= ? AND created_at < ?
  AND id > ?          -- 上一批最后一行的 id
  AND id <= ?         -- 任务开始时记录的 maxId，之后新写入的数据不导出
ORDER BY id
LIMIT 5000;
```

和 `LIMIT offset, n` 深分页对比扫描行数（100 万行，每页 5000）：

- 深分页：第 k 页要先扫过 5000 × k 行再丢掉，200 页合计扫描 5000 × (0 + 1 + … + 199) = 5000 × 19,900 ≈ 1 × 10⁸ 行，是数据量的 100 倍
- 主键游标：每页从上一页的 id 往后定位，合计只扫描约 10⁶ 行

主键游标的其他好处：每条 SQL 都很短，连接用完即还；任务表里记下 `lastId`，既能显示进度，按分片文件导出时也能从断点继续（见第五节故障恢复）。深分页的原理和其他优化方式见 [MySQL 索引 - 深度分页优化](/database/1_mysql/4_topic_index#九、深度分页优化)。

- **索引要匹配**：上面的 SQL 走主键范围扫描再过滤 `created_at`。如果筛选条件只命中很少的行，主键扫描会读大量无用数据，这时改用 `(created_at, id)` 联合索引，游标也换成 `(created_at, id) > (?, ?)` 两列
- **一致性口径**：分批读不是同一个快照，导出过程中被修改的行可能读到新值。报表一般能接受，在文件里标注「数据截至任务开始时间」；要求严格快照的，改用流式结果集在一个可重复读事务里读完
- **读从库**：导出统一路由到从库或报表库，不和线上交易争抢 Buffer Pool 和 IO；从库有复制延迟，刚写入的数据可能导不出来

---

## 四、流式写文件

### 1、SXSSFWorkbook：滑动窗口

Apache POI 的 `SXSSFWorkbook` 只在内存里保留最近的 N 行（窗口），超出窗口的行刷到临时文件，最后再拼成 xlsx：

```java
SXSSFWorkbook wb = new SXSSFWorkbook(100);   // 内存只保留 100 行
wb.setCompressTempFiles(true);               // 临时 XML 用 gzip 压缩，体积会小很多
try (OutputStream out = Files.newOutputStream(file)) {
    SXSSFSheet sheet = wb.createSheet("订单");
    // ... 逐行 createRow / createCell
    wb.write(out);
} finally {
    wb.dispose();                            // 删除临时文件
    wb.close();
}
```

临时文件写在 `java.io.tmpdir`，体积可能是数据本身的数倍，容器里要给足临时盘；刷出窗口的行不能再修改，不能写完后回头改前面的单元格（如自动调整列宽）。

### 2、EasyExcel：按批写入

EasyExcel 底层同样使用 SXSSF，封装了注解映射和按批写入，代码更短。EasyExcel 目前已停止维护，原作者维护的 FastExcel 分支 API 基本兼容，新项目可以直接用后者。

```java
static final int BATCH = 5_000;
static final int ROWS_PER_SHEET = 1_000_000;   // 单 sheet 上限 1,048,576 行（含表头），取整留余量

void writeExcel(Path file, ExportQuery q, ExportTask task) {
    try (ExcelWriter writer = EasyExcel.write(file.toFile(), OrderExportRow.class).build()) {
        long lastId = 0;                                   // 单个 xlsx 不能续写，每次执行都从头开始
        int sheetNo = 0, rowsInSheet = 0;
        WriteSheet sheet = EasyExcel.writerSheet(sheetNo, "订单-1").build();
        while (true) {
            List<OrderExportRow> batch = mapper.scanAfter(q, lastId, task.maxId(), BATCH);
            if (batch.isEmpty()) break;
            if (rowsInSheet >= ROWS_PER_SHEET) {           // 5000 整除 100 万，一批不会跨 sheet
                sheetNo++;
                rowsInSheet = 0;
                sheet = EasyExcel.writerSheet(sheetNo, "订单-" + (sheetNo + 1)).build();
            }
            writer.write(desensitize(batch), sheet);
            rowsInSheet += batch.size();
            lastId = batch.getLast().getId();
            progress.report(task.id(), batch.size());   // 每批更新一次进度
        }
    }
}
```

### 3、行数上限与 CSV

xlsx 单个 sheet 最多 1,048,576 行、16,384 列。超过 100 万行要么分 sheet，要么拆成多个文件；超过几百万行时 Excel 打开本身就很慢，不如改用 CSV。

| 格式 | 优点 | 缺点 |
|------|------|------|
| xlsx | 用户直接打开，有样式、多 sheet | 行数上限；生成慢；文件本身是 zip，再压缩收益很小 |
| CSV | 无行数上限，生成最快，内存最小 | 无样式；中文要写 UTF-8 BOM，否则 Excel 打开乱码 |

CSV 体积估算：每列平均 10 字节 + 分隔符，一行约 220B，100 万行 ≈ 2.2 × 10⁸ B ≈ 210MB；文本 gzip 压缩比通常在 5～10 倍，压缩后约 20～40MB。

两个格式都要注意：

- **长数字**：Excel 数字只有 15 位有效精度，超过 15 位的订单号、身份证号（18 位）要按文本写出，否则末尾变成 0
- **公式注入**：以 `=`、`+`、`-`、`@` 开头的单元格会被 Excel 当作公式执行，导出用户输入的内容时在前面加 `'` 转义

### 4、内存估算

| 方案 | 常驻内存 | 计算 |
|------|----------|------|
| 全量查询 + XSSF | 约 6.7GB | 对象 1.1GB + 单元格 5.6GB，见第一节 |
| 主键游标 + EasyExcel | 约 6MB 级 | 一批 5000 行 × 1.2KB ≈ 5.9MB，SXSSF 窗口 100 行可忽略 |
| 主键游标 + CSV | 约 6MB 级 | 同上，写出时没有额外对象模型 |

单个任务的内存与总行数无关，只与批大小有关；再用线程池限制同时执行的任务数，整体内存就有了上限。

---

## 五、异步任务与下载

### 1、任务表与状态

```sql
CREATE TABLE export_task (
    id          BIGINT       PRIMARY KEY,
    user_id     BIGINT       NOT NULL,
    biz_type    VARCHAR(32)  NOT NULL,          -- 导出类型：订单、流水……
    query_json  JSON         NOT NULL,          -- 服务端保存的筛选条件
    status      VARCHAR(16)  NOT NULL,          -- PENDING / RUNNING / SUCCESS / FAILED / EXPIRED
    last_id     BIGINT       NOT NULL DEFAULT 0,
    max_id      BIGINT       NULL,
    done_rows   INT          NOT NULL DEFAULT 0,
    object_key  VARCHAR(256) NULL,
    error_msg   VARCHAR(512) NULL,
    heartbeat_at DATETIME    NULL,
    created_at  DATETIME     NOT NULL,
    -- 进行中的任务才有值，其余为 NULL；唯一索引允许多个 NULL
    active_user BIGINT AS (IF(status IN ('PENDING', 'RUNNING'), user_id, NULL)) STORED,
    UNIQUE KEY uk_active_user (active_user)
);
```

- **每人同时一个**：`active_user` 生成列加唯一索引，同一用户第二个进行中的任务插入时直接报唯一键冲突，提示「已有导出任务在执行」。不用先查再插，并发提交也挡得住
- **抢任务**：多个实例轮询 PENDING 任务，用 `UPDATE export_task SET status='RUNNING', heartbeat_at=NOW() WHERE id=? AND status='PENDING'` 抢占，影响行数为 1 才执行
- **进度**：`done_rows` 每批更新，前端轮询显示；大表 `COUNT(*)` 很慢，总数用 `max_id - min_id` 估算或只显示「已导出 N 行」
- **故障恢复**：执行中每批刷新 `heartbeat_at` 和 `last_id`；心跳超过 5 分钟未更新的 RUNNING 任务视为实例已宕机，改回 PENDING 重新执行。单个 xlsx 文件不能续写，宕机实例上的临时文件也已丢失，所以从头导出；数据量特别大时按 50 万行拆成多个分片文件，每片写完即上传并记下已完成的片号和 `last_id`，恢复时只重跑未完成的片
- **全局并发**：执行线程池核心数等于最大并发数（如 4），任务本身排在表里，线程池不需要大队列。线程池参数与隔离见 [线程池](/java/28_topic_thread_pool)，Spring 中的异步与定时任务见 [异步任务与定时任务](/spring-boot/9_async_schedule)

任务完成后要通知用户（站内信、IM 消息）。通知必须在状态更新提交之后发送：写 outbox 表或在事务提交回调里发，不要在事务里直接发消息，否则事务回滚了消息却已经发出。

### 2、下载：对象存储 + 预签名 URL

- 文件按 `export/{日期}/{taskId}.xlsx` 存放，任务表只记 `object_key`
- 用户点击下载时，服务端先校验 `task.user_id` 与当前用户一致，再签发有效期 10～15 分钟的预签名 GET URL，浏览器直接从对象存储下载，不经过应用服务器
- 过期清理：在 `export/` 前缀上配生命周期规则，7 天后自动删除对象；定时任务把对应任务改为 EXPIRED，页面不再展示下载按钮

预签名 URL 的生成与生命周期规则配置见 [对象存储](/architecture/4_object_storage)。

### 3、大文件压缩

CSV 压缩效果明显（见上一节，210MB 压到几十 MB），先压缩再上传，上传超过 100MB 走分片上传。xlsx 本身就是 zip 格式，再压一次几乎不变小；多个文件（分文件导出）才需要打成一个 zip 包。

---

## 六、导入方案

![异步导入整体流程](../assets/scenario/sheet-import-flow.svg)

### 1、先上传，再异步解析

导入同样不在一个请求里同步完成：

1. 前端把文件上传到对象存储，服务端校验大小（如 ≤ 50MB）和扩展名
2. 创建导入批次，生成批次号 `batch_no`，计算文件 SHA-256 存入批次表，返回批次号
3. 后台任务拉取文件、逐批解析、校验、入库，最后生成结果

### 2、监听器分批读

EasyExcel 读 xlsx 使用 SAX 事件模型，逐行回调，不会把整个文件加载进内存。在监听器里攒满 1000 行处理一批：

```java
// 每次导入 new 一个，不能注册成 Spring 单例：buffer 是有状态的
public class OrderImportListener implements ReadListener<OrderImportRow> {

    private static final int BATCH = 1_000;
    private final List<RowWithNo> buffer = new ArrayList<>(BATCH);
    private final ImportBatchProcessor processor;
    private final String batchNo;
    private final int skipUntil;                         // 断点：已处理到的行号

    public OrderImportListener(ImportBatchProcessor processor, String batchNo, int skipUntil) {
        this.processor = processor; this.batchNo = batchNo; this.skipUntil = skipUntil;
    }

    @Override
    public void invoke(OrderImportRow row, AnalysisContext ctx) {
        int rowNo = ctx.readRowHolder().getRowIndex() + 1;   // Excel 行号，从 1 开始
        if (rowNo <= skipUntil) return;                      // 重启后跳过已提交的行
        buffer.add(new RowWithNo(rowNo, row));
        if (buffer.size() >= BATCH) flush();
    }

    @Override
    public void doAfterAllAnalysed(AnalysisContext ctx) {
        flush();
    }

    private void flush() {
        if (buffer.isEmpty()) return;
        processor.process(batchNo, List.copyOf(buffer));
        buffer.clear();
    }
}

record RowWithNo(int rowNo, OrderImportRow row) {}
```

批大小取 500～1000：太小则事务和网络往返次数多，太大则单个事务持锁时间长，一批失败的影响面也大。

### 3、逐批校验

校验分两层，顺序很重要：

1. **内存校验**：必填、长度、格式、日期、金额精度、枚举值、批内重复，全部在内存完成，不碰数据库
2. **数据库校验**：业务唯一键是否已存在、关联数据是否存在，**整批用一条 `IN` 查询**，不逐行查

10 万行数据，逐行查库是 10 万 × 2ms = 200 秒；每批 1000 个 key 用 `IN` 查一次，是 100 次 × 约 10ms = 1 秒。字典类数据（地区、类目）在任务开始时一次性加载到内存。

### 4、批量插入与断点

合法行用批量插入写入，JDBC URL 要加 `rewriteBatchedStatements=true` 才会合并成多值 INSERT，原理和条件见 [数据访问性能 - 批量写入](/high-perf/10_db_performance#三、批量写入)。

每一批在**同一个事务**里完成三件事：推进批次的断点行号、插入合法行、写入错误行：

```java
@Transactional
public void saveBatch(String batchNo, int lastRowNo, List<Order> valid, List<ImportError> errors) {
    // UPDATE import_batch SET processed_row = ?, success_count = success_count + ?, fail_count = fail_count + ?
    // WHERE batch_no = ? AND processed_row < ?   —— 断点只能前进，同一批重复执行时影响 0 行
    // 先推进断点：同时锁住批次行，同一批次的并发执行在这里排队
    int n = batchMapper.advance(batchNo, lastRowNo, valid.size(), errors.size());
    if (n == 0) return;                                     // 这一批已提交过，重复执行直接跳过
    if (!valid.isEmpty()) orderMapper.insertBatch(valid);   // t_order 上有 uk(tenant_id, order_no)
    if (!errors.isEmpty()) errorMapper.insertBatch(errors); // import_error(batch_no, row_no, reason)
}
```

数据和断点在同一个事务里提交，任务在任意位置中断，重启后从 `processed_row` 之后继续，不会重复写入也不会漏行。

错误行写进 `import_error` 表而不是放在内存里，全部处理完后再按行号顺序流式生成错误报告文件（原始列 + 错误原因列）上传对象存储，用户改完错误行后只需重新导入报告里的这些行。

### 5、重复导入的幂等

重复导入分三种情况，各自用不同手段：

| 场景 | 手段 |
|------|------|
| 同一个任务重试、多实例重复执行 | 断点行号与数据同事务提交，`processed_row < ?` 条件保证每批只生效一次（上一小节） |
| 用户把同一个文件又传了一遍 | 文件 SHA-256 已有成功批次时提示「该文件已于某时导入」，由用户确认是否继续；它只是提醒，不作为最终保证 |
| 不同文件包含相同业务数据 | 业务唯一键 + 数据库唯一约束是最终保证；校验阶段查出的重复行进错误报告 |

校验查询和插入之间有时间差，两个导入任务可能同时写入同一个业务键。这时批量插入会抛 `DuplicateKeyException` 并整批回滚，处理方式是：重新查一次这批的业务键，把已存在的行改记为错误，剩余的行再执行一次 `saveBatch`。

每行数据带上 `batch_no`，导错了还能按批次号分批 `DELETE` 整批撤销。幂等的通用做法见 [幂等设计](/architecture/5_idempotence)。

### 6、部分成功还是整体回滚

| 方式 | 做法 | 适用 |
|------|------|------|
| 部分成功（默认） | 每批独立事务，合法行入库，错误行进报告 | 商品、客户、库存初始化等行之间相互独立的数据 |
| 全部成功才生效 | 先全部写入暂存表并校验，零错误时再分批搬到正式表，或把暂存数据的状态统一改为生效 | 财务凭证、价格表等必须整体一致的数据 |

不要用「一个大事务包住十万行」来实现全部成功才生效：undo log 膨胀、长时间持锁、主从复制延迟飙升，回滚本身也可能要几分钟。

---

## 七、工程要点

| 方面 | 要点 |
|------|------|
| 限流 | 每人同时一个任务（唯一索引）；全局执行并发由线程池控制；单次导出设行数上限（如 100 万行），超过要求缩小时间范围 |
| 超时 | 单个任务设最长执行时间（如 30 分钟），超时标记 FAILED；单批 SQL 设查询超时；流式结果集注意 `net_write_timeout` |
| 监控 | 任务排队数、执行时长、失败率、单任务行数；从库复制延迟；临时盘使用率 |
| 脱敏 | 手机号、身份证、银行卡号在写文件前脱敏（如 `138****1234`）；导出明文需要单独权限，并记录审计日志 |
| 权限 | 导出复用列表查询的数据权限条件（本人、本部门、本租户），条件由服务端拼装；下载前校验任务归属，预签名 URL 短有效期 |
| 导入安全 | 限制文件大小与行数；POI 对压缩比异常的文件会拒绝解析（`ZipSecureFile`），不要关闭这项检查 |

---

## 小结

- 百万行导出的三个问题是 OOM、超时、拖垮数据库，根源都在「一个同步请求里全量处理」；改成提交任务 → 异步执行 → 流式读写 → 对象存储 → 预签名下载
- 读数据优先用主键游标分批查从库：SQL 短、连接用完即还、可断点续传；流式结果集需要 `Integer.MIN_VALUE` 或 `useCursorFetch`，并且整个过程占用一条连接
- 写文件用 SXSSF 或 EasyExcel 按批写，单任务内存只取决于批大小；单 sheet 上限 1,048,576 行，量更大时用 CSV 并压缩
- 任务表用生成列 + 唯一索引限制每人同时一个任务，心跳超时的任务改回待执行重跑（单文件从头、分片文件按片续传）；完成通知在事务提交后发送
- 导入先上传再异步解析：监听器每 1000 行一批，内存校验在前、批量查库在后，合法行批量插入，错误行记表并生成错误报告
- 导入幂等靠三层：断点行号与数据同事务提交、文件哈希提醒、业务唯一键加唯一约束兜底；需要整体生效的数据用暂存表，不用超大事务

导入重复提交不重复入库的通用做法见 [幂等设计](/architecture/5_idempotence)。

## 参考资料

- 选题参考：doocs/advanced-java：[https://github.com/doocs/advanced-java](https://github.com/doocs/advanced-java)
- Apache POI SXSSF：[https://poi.apache.org/components/spreadsheet/how-to.html#sxssf](https://poi.apache.org/components/spreadsheet/how-to.html#sxssf)
- MySQL Connector/J ResultSet（流式读取）：[https://dev.mysql.com/doc/connector-j/en/connector-j-reference-implementation-notes.html](https://dev.mysql.com/doc/connector-j/en/connector-j-reference-implementation-notes.html)
- MyBatis Java API（Cursor）：[https://mybatis.org/mybatis-3/java-api.html](https://mybatis.org/mybatis-3/java-api.html)
- Excel specifications and limits：[https://support.microsoft.com/en-us/office/excel-specifications-and-limits-1672b34d-7043-467e-8e27-269d656771c3](https://support.microsoft.com/en-us/office/excel-specifications-and-limits-1672b34d-7043-467e-8e27-269d656771c3)
- FastExcel：[https://github.com/fast-excel/fastexcel](https://github.com/fast-excel/fastexcel)

> 下一篇：[秒杀](./4_seckill) —— 分层限流、Redis 原子预扣、MQ 异步下单与超时关单的完整链路。
