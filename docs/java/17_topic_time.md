---
description: Date 痛点、类型模型、时区与夏令时、格式化、JDBC / Jackson 映射、存储与迁移
---

# 日期与时间

> **本篇目标**：建立 java.time 的类型模型（墙上时间、偏移、时区、时刻），避开时区缩写、夏令时、格式化模式、JVM 默认时区等常见坑，掌握时间在数据库和 JSON 中的映射方式，并能把遗留的 `Date` / `Calendar` 代码迁移过来。
>
> **前置阅读**：[动态代理](./16_topic_proxy)

> 参考资料：
> * `java.time` 包文档（JDK 21）：[https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/time/package-summary.html](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/time/package-summary.html)
> * Java Tutorials - Date Time（含遗留代码互操作）：[https://docs.oracle.com/javase/tutorial/datetime/](https://docs.oracle.com/javase/tutorial/datetime/)
> * IANA Time Zone Database：[https://www.iana.org/time-zones](https://www.iana.org/time-zones)
> * MySQL 日期时间类型：[https://dev.mysql.com/doc/refman/8.4/en/datetime.html](https://dev.mysql.com/doc/refman/8.4/en/datetime.html)

Java 8 引入的 `java.time`（JSR 310）用一组**不可变、线程安全、语义明确**的类型取代了 `java.util.Date` 和 `Calendar`。真正难的不是 API，而是想清楚每个值表达的是什么：是时间线上的一个时刻，还是某地墙上挂钟显示的时间。

---

## 一、Date / Calendar 的痛点

```java
Date d = new Date(2026, 10, 8);            // 实际是 3926-11-08：年份从 1900 起算，月份从 0 起算
Calendar c = Calendar.getInstance();
c.set(2026, 9, 8);                          // 10 月要写 9

Date start = order.getCreatedAt();
start.setTime(0);                           // Date 可变：任何拿到引用的代码都能改掉订单创建时间

private static final SimpleDateFormat FMT = new SimpleDateFormat("yyyy-MM-dd");
FMT.parse("2026-10-08");                    // 多线程共享时结果错乱或抛 NumberFormatException
```

| 问题 | `Date` / `Calendar` / `SimpleDateFormat` | `java.time` |
|------|------------------------------------------|-------------|
| 可变性 | 可变，需要防御性拷贝 | 不可变，所有修改返回新对象 |
| 线程安全 | `SimpleDateFormat` 内部共享一个可变 `Calendar`，并发解析 / 格式化会互相覆盖 | `DateTimeFormatter` 不可变，可作为常量共享 |
| 语义 | `Date` 实为时刻，`toString()` 却按 JVM 默认时区显示；`java.sql.Date` 继承 `Date` 却表示日期 | 时刻、日期、墙上时间、时区各有类型 |
| 取值 | 年份 1900 起、月份 0 起 | 年月日按自然值，月份可用 `Month` 枚举 |
| 精度 | 毫秒 | 纳秒 |

---

## 二、java.time 类型模型

![java.time 核心类型](../assets/java/time_types.svg)

### 1、核心类型

| 类型 | 表达什么 | 示例 |
|------|----------|------|
| `Instant` | 时间线上的一个时刻：epoch 秒（`long`）+ 纳秒（`int`） | `2026-10-08T06:30:15.123456Z` |
| `LocalDate` / `LocalTime` | 不带时区的日期 / 时间 | `2026-10-08`、`14:30:15` |
| `LocalDateTime` | 不带时区的墙上时间，**不能单独确定一个时刻** | `2026-10-08T14:30:15` |
| `OffsetDateTime` | 墙上时间 + 固定 UTC 偏移，能确定时刻 | `2026-10-08T14:30:15+08:00` |
| `ZonedDateTime` | 墙上时间 + IANA 时区（含夏令时与历史规则） | `2026-10-08T14:30:15+08:00[Asia/Shanghai]` |
| `Duration` | 基于秒和纳秒的时长 | `PT2H30M` |
| `Period` | 基于年月日的日历间隔 | `P1M10D` |
| `YearMonth` / `MonthDay` / `DayOfWeek` | 账期、生日、星期等部分时间 | `2026-10` |

选择原则：表示「某件事发生的时刻」用 `Instant`（或带偏移的 `OffsetDateTime`）；表示「某地的日历规则」（营业时间、每天 9 点提醒）用 `LocalTime` / `LocalDateTime` + `ZoneId`；`LocalDateTime` 单独出现在跨时区系统中通常意味着信息丢失。

### 2、Instant 的精度

`Instant` 本身是纳秒精度，但 `Instant.now()` 的实际分辨率取决于系统时钟：JDK 9 起在主流平台上提升到微秒级（JDK-8068730），JDK 15 起 Linux 上可达纳秒级（JDK-8242504）。而 MySQL `DATETIME(6)`、PostgreSQL `timestamp` 最多存到微秒，写入再读出会被截断或四舍五入，测试中常见「存进去和读出来不相等」。写库前统一截断可以避免：

```java
Instant now = Instant.now().truncatedTo(ChronoUnit.MICROS);
```

### 3、计算与调整

```java
LocalDate today = LocalDate.of(2026, 10, 8);
LocalDate firstOfNextMonth = today.with(TemporalAdjusters.firstDayOfNextMonth());
LocalDate lastFriday = today.with(TemporalAdjusters.lastInMonth(DayOfWeek.FRIDAY));
LocalDate plusOneMonth = LocalDate.of(2026, 1, 31).plusMonths(1);   // 2026-02-28：月末自动收敛

long days  = ChronoUnit.DAYS.between(LocalDate.of(2026, 1, 1), today); // 280：总天数
Period p   = Period.between(LocalDate.of(2026, 1, 1), today);         // P9M7D：年月日分量
Duration d = Duration.between(Instant.EPOCH, Instant.now());          // 精确时长，用于 Instant / 时间
```

`Period.getDays()` 只是「天」这个分量，不是总天数，求总天数用 `ChronoUnit.DAYS.between`。

---

## 三、时区：ZoneId 与 ZoneOffset

### 1、三种时区写法

| 写法 | 示例 | 特点 |
|------|------|------|
| IANA 区域 ID（推荐） | `Asia/Shanghai`、`America/New_York` | 包含夏令时与历史偏移变化，跨语言、跨数据库通用 |
| 固定偏移 `ZoneOffset` | `+08:00`、`UTC`、`Z` | 永不变化、没有夏令时，适合表示「已经发生的那一刻用的偏移」 |
| `Etc/GMT±X` | `Etc/GMT-8` | 符号与直觉相反：`Etc/GMT-8` 是 UTC**+**8，避免使用 |

`ZoneId` 是抽象，`ZoneOffset` 是它的子类；`ZoneId.of("Asia/Shanghai")` 背后是一套随日期变化的 `ZoneRules`，`ZoneOffset.ofHours(8)` 只是一个常数。

### 2、不要用时区缩写

缩写本身有歧义：`CST` 可以是中国标准时间、美国中部时间或古巴标准时间。JDK 提供的 `ZoneId.SHORT_IDS` 映射表也说明了问题：

| 缩写 | `SHORT_IDS` 映射到 | 说明 |
|------|--------------------|------|
| `CST` | `America/Chicago` | 美国中部时间，不是中国 |
| `PST` | `America/Los_Angeles` | 区域 ID，有夏令时 |
| `EST` | `-05:00` | **固定偏移**，没有夏令时；不是 `America/New_York` |
| `MST` | `-07:00` | 固定偏移 |
| `HST` | `-10:00` | 固定偏移 |
| `CTT` | `Asia/Shanghai` | 中国时间对应的是这个，而不是 `CST` |

另外两个坑：`ZoneId.of("CST")` 直接抛 `ZoneRulesException`，而遗留的 `TimeZone.getTimeZone("CST")` 返回美国中部时间；`TimeZone.getTimeZone("Asia/Shangai")`（拼错）**不报错，静默返回 GMT**。Windows 时区名（如 `China Standard Time`）也不能直接用，需要按 CLDR 的 Windows ↔ IANA 映射表转换。

### 3、时区规则会更新

各国会调整夏令时或标准偏移，这些变化通过 tzdata 发布，JDK 自带一份并随 JDK 更新版本升级（老版本可用 Oracle 的 TZUpdater 工具单独更新）。容器镜像中的 OS tzdata、数据库的时区表也各有一份，要一起保持更新。

---

## 四、夏令时陷阱

以 `America/New_York` 为例：2026-03-08 02:00 时钟拨到 03:00（出现「间隙」），2026-11-01 02:00 拨回 01:00（01:00–02:00「重叠」出现两次）。中国自 1991 年起不实行夏令时，但面向海外用户的系统必须处理。

```java
ZoneId ny = ZoneId.of("America/New_York");

// 间隙：02:30 不存在，自动顺延间隙长度
ZonedDateTime gap = ZonedDateTime.of(LocalDateTime.of(2026, 3, 8, 2, 30), ny);
// 2026-03-08T03:30-04:00[America/New_York]

// 重叠：01:30 出现两次，默认取较早的偏移（夏令时 -04:00）
ZonedDateTime overlap = ZonedDateTime.of(LocalDateTime.of(2026, 11, 1, 1, 30), ny);
ZonedDateTime later   = overlap.withLaterOffsetAtOverlap();          // -05:00，晚一小时的那个 01:30

// 「加一天」与「加 24 小时」不同
ZonedDateTime noon = ZonedDateTime.of(LocalDateTime.of(2026, 3, 7, 12, 0), ny);
noon.plusDays(1);    // 2026-03-08T12:00-04:00：日历上的明天同一时间，实际只过了 23 小时
noon.plusHours(24);  // 2026-03-08T13:00-04:00：严格 24 小时之后
```

规则：按日历语义（每天 9 点、每月 1 号）计算用 `ZonedDateTime.plusDays` / `Period`；按物理时长（超时、过期、限流窗口）计算用 `Instant.plus(Duration)`。定时任务避免安排在本地 01:00–03:00，否则可能跳过或执行两次。

---

## 五、格式化与解析

```java
// 可以安全地作为常量在多线程间共享
private static final DateTimeFormatter FMT =
        DateTimeFormatter.ofPattern("uuuu-MM-dd HH:mm:ss", Locale.ROOT)
                         .withResolverStyle(ResolverStyle.STRICT);

LocalDateTime t = LocalDateTime.parse("2026-10-08 14:30:15", FMT);
String iso = Instant.now().toString();                 // ISO-8601，接口传输首选
```

| 坑 | 说明 |
|----|------|
| `YYYY` 与 `yyyy` | `YYYY` 是基于周的年份：`2025-12-29` 用 `YYYY` 格式化会得到 `2026`，年底集中出 bug |
| `DD` 与 `dd` | `DD` 是一年中的第几天 |
| `hh` 与 `HH` | `hh` 是 12 小时制，不带 `a` 时上下午无法区分 |
| 宽松解析 | 默认 `SMART` 会把 `2026-02-30` 调整为 `2026-02-28`；要拒绝非法日期用 `STRICT`，此时年份必须写 `uuuu`（`yyyy` 是纪元年，需配合纪元字段） |
| Locale | 含月份名、星期名的模式依赖 Locale，服务端显式指定，不依赖机器默认值 |
| 带时区解析 | `LocalDateTime.parse` 遇到 `Z` 或 `+08:00` 会失败，这类字符串用 `OffsetDateTime.parse` / `Instant.parse` |

---

## 六、当前时间与可测试性

### 1、JVM 默认时区

`LocalDateTime.now()`、`LocalDate.now()`、`new Date().toString()` 都隐式使用 JVM 默认时区。默认时区来自 `-Duser.timezone`，否则取操作系统设置——容器镜像里通常是 UTC，开发机是 `Asia/Shanghai`，于是「本地正常、上线差 8 小时」。

- 业务代码显式传入时区：`LocalDate.now(ZoneId.of("Asia/Shanghai"))`；
- 启动参数统一 `-Duser.timezone=UTC`（或业务时区），容器同时设置 `TZ` 环境变量，保证日志、JVM、数据库会话一致；
- 不要在运行时调用 `TimeZone.setDefault`，它是全局可变状态，会影响同进程的所有组件。

### 2、注入 Clock

```java
@Configuration
class TimeConfig {
    @Bean
    Clock clock() { return Clock.system(ZoneId.of("Asia/Shanghai")); }
}

@Service
class CouponService {
    private final Clock clock;
    CouponService(Clock clock) { this.clock = clock; }

    boolean expired(Coupon c) {
        return Instant.now(clock).isAfter(c.expireAt());
    }
}

// 测试中固定时间
Clock fixed = Clock.fixed(Instant.parse("2026-10-08T00:00:00Z"), ZoneOffset.UTC);
```

所有 `now()` 都有接受 `Clock` 的重载，注入后过期、跨天、月末等逻辑都能稳定测试。

### 3、测量耗时用 nanoTime

`System.currentTimeMillis()` / `Instant.now()` 是墙上时钟，会被 NTP 校时向前或向后调整；测量耗时、计算超时要用单调递增的 `System.nanoTime()`，它只适合求差值，绝对值没有意义。

---

## 七、数据库映射

### 1、JDBC 4.2 直接支持 java.time

JDBC 4.2（Java 8）起 `setObject` / `getObject(col, Class)` 直接支持 java.time，与数据库交互**不再需要** `java.sql.Date` / `Timestamp`：

| Java 类型 | JDBC 类型 | MySQL | PostgreSQL |
|-----------|-----------|-------|------------|
| `LocalDate` | `DATE` | `DATE` | `date` |
| `LocalTime` | `TIME` | `TIME` | `time` |
| `LocalDateTime` | `TIMESTAMP` | `DATETIME` | `timestamp` |
| `OffsetDateTime` | `TIMESTAMP_WITH_TIMEZONE` | `TIMESTAMP`（驱动换算） | `timestamptz` |
| `Instant` | 规范未定义 | 驱动 / ORM 支持 | 驱动 / ORM 支持 |

```java
ps.setObject(1, OffsetDateTime.now(ZoneOffset.UTC));
OffsetDateTime createdAt = rs.getObject("created_at", OffsetDateTime.class);
```

JPA 3.x / Hibernate 6 直接映射 `LocalDate`、`LocalDateTime`、`OffsetDateTime`、`Instant` 等字段，无需转换器。

### 2、列类型与时区

- **MySQL `DATETIME`**：按字面存储，不做时区换算，范围到 9999 年；存什么取什么，时区由应用约定（建议统一存 UTC）。
- **MySQL `TIMESTAMP`**：写入时按会话 `time_zone` 转为 UTC 存储，读出时再转回会话时区；上限是 `2038-01-19 03:14:07` UTC，新表不建议再用。
- **PostgreSQL `timestamptz`**：存的是 UTC 时刻，按会话 `TimeZone` 显示，是表达「时刻」最合适的列类型；`timestamp`（不带时区）等同于 `LocalDateTime`。
- **MySQL Connector/J**：务必显式配置 `connectionTimeZone`（8.0.23 前叫 `serverTimezone`），否则驱动会根据服务器时区推断；服务器 `time_zone=SYSTEM` 且系统时区缩写为 `CST` 时，会被识别成美国中部时间，读写时间偏差 13 或 14 小时。参数细节见 [MySQL JDBC 驱动](/database/6_reference/2_jdbc_driver)。

---

## 八、JSON 与 Web 层

### 1、Jackson

Jackson 2.x 需要 `jackson-datatype-jsr310` 模块（`JavaTimeModule`）才能序列化 java.time，并且默认把时间写成数字时间戳。Spring Boot 3 会自动注册该模块，并默认关闭 `WRITE_DATES_AS_TIMESTAMPS`，输出 ISO-8601 字符串。自己 `new ObjectMapper()` 时要手动处理：

```java
ObjectMapper mapper = JsonMapper.builder()
        .addModule(new JavaTimeModule())
        .disable(SerializationFeature.WRITE_DATES_AS_TIMESTAMPS)
        .build();
```

Jackson 3（Spring Boot 4 默认使用）把 java.time 支持内置进了 databind，不再需要单独的模块，且默认就输出 ISO-8601 字符串；对应开关移到了 `DateTimeFeature`。

注意 `spring.jackson.time-zone` 设置的是 ObjectMapper 的上下文时区，主要影响 `java.util.Date` 的格式化以及带时区类型的换算，对 `LocalDateTime` 不起作用——`LocalDateTime` 本来就不带时区，写进去什么就输出什么。

### 2、接口约定

- 对外 API 传输**带偏移的 ISO-8601 字符串**（`2026-10-08T06:30:15Z` 或 `2026-10-08T14:30:15+08:00`），或明确约定的 epoch 毫秒；不要传不带时区的 `2026-10-08 14:30:15`，否则调用方只能猜；
- 单个字段需要特殊格式时用 `@JsonFormat(pattern = "uuuu-MM-dd HH:mm:ss")`（JSON 体）或 `@DateTimeFormat(iso = ISO.DATE_TIME)`（请求参数、表单）；两者分别作用于 Jackson 和 Spring 的类型转换，不能互相替代；
- 用户所在时区由前端上报 IANA ID（浏览器 `Intl.DateTimeFormat().resolvedOptions().timeZone`），由服务端或前端统一转换展示。

---

## 九、存储策略

| 数据 | 推荐存储 | 原因 |
|------|----------|------|
| 已发生的事件（下单、支付、日志时间） | UTC 时刻：`Instant` / `OffsetDateTime` → `timestamptz` 或约定为 UTC 的 `DATETIME` | 时刻已确定，与任何时区规则无关 |
| 未来的本地事件（会议、营业时间、每日结算截止点） | `LocalDateTime` + IANA 时区 ID 两列 | 事件发生前时区规则可能改变；若提前换算成 UTC，规则变更后会差一小时 |
| 纯日期（生日、账期、节假日） | `LocalDate` → `DATE` | 生日不随时区漂移，存成时刻反而会在跨时区显示时变成前一天 |
| 用户时区偏好 | IANA ID 字符串，如 `Asia/Shanghai` | 不存偏移、不存缩写 |

一句话：**过去的事存时刻，未来的本地安排存墙上时间加时区，日期就存日期**。在系统边界（API 入参、消息、数据库）统一转换，业务内部尽量只流转 `Instant` 和明确的 `ZoneId`。

---

## 十、从 Date / Calendar 迁移

### 1、类型对应关系

| 旧类型 | 新类型 | 转换方法 |
|--------|--------|----------|
| `java.util.Date` | `Instant` | `date.toInstant()` / `Date.from(instant)` |
| `java.util.Calendar` / `GregorianCalendar` | `ZonedDateTime` | `gc.toZonedDateTime()` / `GregorianCalendar.from(zdt)` |
| `java.util.TimeZone` | `ZoneId` | `tz.toZoneId()` / `TimeZone.getTimeZone(zoneId)` |
| `java.sql.Timestamp` | `LocalDateTime` / `Instant` | `ts.toLocalDateTime()`、`ts.toInstant()` / `Timestamp.valueOf(ldt)`、`Timestamp.from(instant)` |
| `java.sql.Date` | `LocalDate` | `sqlDate.toLocalDate()` / `java.sql.Date.valueOf(localDate)` |
| `java.sql.Time` | `LocalTime` | `time.toLocalTime()` / `Time.valueOf(localTime)` |
| `SimpleDateFormat` | `DateTimeFormatter` | 模式字母基本兼容，注意 `u` / `y` 和严格解析的区别 |
| `System.currentTimeMillis()` | `Instant.now(clock)` | 便于注入 `Clock` 测试 |

### 2、迁移步骤

1. **先改边界**：新代码与新接口一律用 java.time；遗留方法签名暂不动，在调用处用上表方法转换。
2. **去掉共享的 `SimpleDateFormat`**：替换为 `DateTimeFormatter` 常量，这是最先该修的并发 bug。
3. **持久层切换**：实体字段改为 `LocalDate` / `LocalDateTime` / `OffsetDateTime` / `Instant`，确认驱动版本支持 JDBC 4.2，并核对列类型与时区（第七节）。
4. **JSON 层切换**：确认 `JavaTimeModule` 已注册、输出格式与前端约定一致，必要时先用 `@JsonFormat` 保持旧格式兼容。
5. **清理隐式默认时区**：搜索 `LocalDateTime.now()`、`new Date()`、`Calendar.getInstance()`，改为注入 `Clock` 或显式 `ZoneId`。

两个转换陷阱：`java.sql.Date.toInstant()` 和 `java.sql.Time.toInstant()` 会直接抛 `UnsupportedOperationException`，必须走 `toLocalDate()` / `toLocalTime()`；`Date` → `LocalDateTime` 必须指定时区：`LocalDateTime.ofInstant(date.toInstant(), zone)`。

---

## 小结

- `Date` / `Calendar` 可变、月份从 0 起、`SimpleDateFormat` 线程不安全；`java.time` 全部不可变且线程安全
- `Instant` 是 epoch 秒 + 纳秒的时刻；`LocalDateTime` 是墙上时间，加偏移得 `OffsetDateTime`、加 IANA 时区得 `ZonedDateTime`，才能确定时刻
- 时区一律用 IANA ID；`SHORT_IDS` 中 `CST` 是美国中部时间，`EST` / `MST` / `HST` 是固定偏移；`TimeZone.getTimeZone` 拼错 ID 会静默返回 GMT
- 夏令时会产生间隙和重叠，日历语义用 `plusDays`，物理时长用 `Instant.plus(Duration)`
- 格式化用 `DateTimeFormatter` 常量，警惕 `YYYY`，严格解析用 `uuuu` + `ResolverStyle.STRICT`
- 不依赖 JVM 默认时区，注入 `Clock` 提升可测试性；测耗时用 `System.nanoTime()`
- JDBC 4.2 直接支持 java.time；MySQL `TIMESTAMP` 有 2038 上限，驱动要显式配置连接时区；Jackson 2 需要 `JavaTimeModule`，Jackson 3 已内置
- 过去的事件存 UTC 时刻，未来的本地事件存 `LocalDateTime` + IANA 时区，纯日期存 `LocalDate`

> 下一篇：[IO 与 NIO](./18_topic_io) —— 从时间 API 转到 IO：流的分类、NIO 的 Buffer / Channel / Selector，以及零拷贝。
