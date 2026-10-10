---
description: JUnit 6 编程模型、参数化与嵌套测试、AssertJ、FIRST 与命名、Clock 注入、测试数据构建器、覆盖率与 PIT
---

# 单元测试

> 前置阅读：[测试工程总览](./0_overview)

单元测试是测试金字塔的底座：不启动 Spring、不连数据库、不发网络请求，毫秒级跑完。本篇围绕订单计价服务 `PriceCalculator`，讲 JUnit 6 与 AssertJ 的用法、可控的时间与随机数、测试数据构建器和覆盖率与变异测试，示例基于 JDK 21、JUnit 6.1.3、AssertJ 3.27.7。

---

## 一、单元测试的边界与被测代码

### 1、什么算一个「单元」

「单元」指**一个可独立验证的行为**，不一定是一个类。计价规则由 `PriceCalculator`、`OrderLine`、`MemberLevel` 几个类协作完成，把它们放在一起测完全没问题，因为它们都是纯内存计算。判断一个测试是不是单元测试，看它碰不碰下面这些东西：

| 碰到了 | 说明 | 处理方式 |
|--------|------|----------|
| 数据库、MQ、Redis、文件系统 | 已经是集成测试 | 换成 Mock / Fake，或挪到 [集成测试](./3_integration_test) |
| Spring 容器 | 启动上下文要几百毫秒到几秒 | 构造器注入的类直接 `new` |
| 网络（HTTP、RPC） | 慢且不稳定 | Mock 客户端接口，HTTP 层交给 WireMock |
| 系统时间、随机数 | 结果不可重复 | 注入 `Clock`、`RandomGenerator`，见第六节 |
| 静态可变状态、单例 | 测试之间互相污染 | 改成依赖注入 |

`@TempDir` 提供的临时目录是个例外：它由 JUnit 创建和清理，速度快且互不干扰，用来测文件导出这类逻辑是可以的。

### 2、被测代码：订单计价

规则：先按会员等级打折，再用满减券（按折后金额判断门槛，最多减到 0，过期抛异常），商品应付满 99 元包邮，否则加 10 元运费。

```java
package com.example.order.pricing;

import java.math.BigDecimal;

public enum MemberLevel {
    NORMAL("1.00"), SILVER("0.95"), GOLD("0.90");

    private final BigDecimal rate;

    MemberLevel(String rate) {
        this.rate = new BigDecimal(rate);
    }

    public BigDecimal rate() {
        return rate;
    }
}
```

```java
package com.example.order.pricing;

import java.math.BigDecimal;
import java.util.Objects;

public record OrderLine(String sku, BigDecimal unitPrice, int quantity) {

    public OrderLine {
        Objects.requireNonNull(sku, "sku");
        Objects.requireNonNull(unitPrice, "unitPrice");
        if (unitPrice.signum() < 0) {
            throw new IllegalArgumentException("unitPrice must not be negative: " + unitPrice);
        }
        if (quantity <= 0) {
            throw new IllegalArgumentException("quantity must be positive: " + quantity);
        }
    }

    public BigDecimal subtotal() {
        return unitPrice.multiply(BigDecimal.valueOf(quantity));
    }
}
```

另外三个类型同包、各占一个文件：

```java
// Coupon.java —— 满减券：金额达到 threshold 时减 amount，expiresAt 起失效
package com.example.order.pricing;

import java.math.BigDecimal;
import java.time.Instant;

public record Coupon(String code, BigDecimal threshold, BigDecimal amount, Instant expiresAt) {
}
```

```java
// PriceQuote.java —— 报价结果
package com.example.order.pricing;

import java.math.BigDecimal;

public record PriceQuote(BigDecimal itemsTotal, BigDecimal memberDiscount, BigDecimal couponDiscount,
                         BigDecimal shippingFee, BigDecimal payable) {
}
```

```java
// CouponExpiredException.java
package com.example.order.pricing;

public class CouponExpiredException extends RuntimeException {

    public CouponExpiredException(String code) {
        super("coupon expired: " + code);
    }
}
```

```java
package com.example.order.pricing;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.time.Clock;
import java.util.List;
import java.util.Objects;

public class PriceCalculator {

    static final BigDecimal FREE_SHIPPING_THRESHOLD = new BigDecimal("99.00");
    static final BigDecimal SHIPPING_FEE = new BigDecimal("10.00");

    private final Clock clock;

    public PriceCalculator(Clock clock) {
        this.clock = Objects.requireNonNull(clock, "clock");
    }

    public PriceQuote quote(List<OrderLine> lines, MemberLevel level) {
        return quote(lines, level, null);
    }

    public PriceQuote quote(List<OrderLine> lines, MemberLevel level, Coupon coupon) {
        if (lines == null || lines.isEmpty()) {
            throw new IllegalArgumentException("order must contain at least one line");
        }
        BigDecimal itemsTotal = lines.stream()
                .map(OrderLine::subtotal)
                .reduce(BigDecimal.ZERO, BigDecimal::add)
                .setScale(2, RoundingMode.HALF_UP);

        // 1. 会员折扣
        BigDecimal afterMember = itemsTotal.multiply(level.rate()).setScale(2, RoundingMode.HALF_UP);
        BigDecimal memberDiscount = itemsTotal.subtract(afterMember);

        // 2. 满减券（按折后金额判断门槛，最多减到 0）
        BigDecimal couponDiscount = couponDiscount(afterMember, coupon);
        BigDecimal goodsAmount = afterMember.subtract(couponDiscount);

        // 3. 运费：商品应付满 99 包邮
        BigDecimal shippingFee = goodsAmount.compareTo(FREE_SHIPPING_THRESHOLD) >= 0
                ? BigDecimal.ZERO.setScale(2)
                : SHIPPING_FEE;

        return new PriceQuote(itemsTotal, memberDiscount, couponDiscount,
                shippingFee, goodsAmount.add(shippingFee));
    }

    private BigDecimal couponDiscount(BigDecimal amount, Coupon coupon) {
        if (coupon == null) {
            return BigDecimal.ZERO.setScale(2);
        }
        if (!clock.instant().isBefore(coupon.expiresAt())) {
            throw new CouponExpiredException(coupon.code());
        }
        if (amount.compareTo(coupon.threshold()) < 0) {
            return BigDecimal.ZERO.setScale(2);
        }
        return coupon.amount().min(amount);
    }
}
```

`PriceCalculator` 通过构造器拿到 `Clock`，而不是在内部调用 `Instant.now()`，这是它能被稳定测试的前提，第六节展开。

---

## 二、JUnit 6 基础

### 1、依赖

Spring Boot 项目引入 `spring-boot-starter-test`（Boot 4 按技术引入 `spring-boot-starter-<技术>-test`，见 [Spring Boot 测试](/spring-boot/13_testing)）即可，JUnit、AssertJ、Mockito 版本都由 Boot 管理。不依赖 Boot 的纯 Java 模块自己导入 BOM：

```xml
<dependencyManagement>
  <dependencies>
    <dependency>
      <groupId>org.junit</groupId>
      <artifactId>junit-bom</artifactId>
      <version>6.1.3</version>
      <type>pom</type>
      <scope>import</scope>
    </dependency>
  </dependencies>
</dependencyManagement>

<dependencies>
  <!-- 聚合了 junit-jupiter-api / -params / -engine -->
  <dependency>
    <groupId>org.junit.jupiter</groupId>
    <artifactId>junit-jupiter</artifactId>
    <scope>test</scope>
  </dependency>
  <dependency>
    <groupId>org.assertj</groupId>
    <artifactId>assertj-core</artifactId>
    <version>3.27.7</version>
    <scope>test</scope>
  </dependency>
</dependencies>

<build>
  <plugins>
    <!-- Surefire 3.x 自动识别 JUnit Platform，并补上版本匹配的 launcher -->
    <plugin>
      <groupId>org.apache.maven.plugins</groupId>
      <artifactId>maven-surefire-plugin</artifactId>
      <version>3.5.6</version>
    </plugin>
  </plugins>
</build>
```

### 2、平台与引擎

![JUnit 6 的三层结构](../assets/testing/unit-test-junit-platform.svg)

JUnit 从 5 开始拆成三部分，6 延续这个结构：

- **JUnit Platform**：在 JVM 上发现和执行测试的基础设施，IDE、Surefire、Gradle 都通过它的 Launcher API 运行测试
- **JUnit Jupiter**：日常写的 `@Test`、`@ParameterizedTest`、扩展模型，以及执行它们的 Jupiter 引擎
- **JUnit Vintage**：在新平台上运行 JUnit 3 / 4 测试的引擎，JUnit 6 起已废弃，只在迁移期使用

因为平台和引擎分离，Cucumber、ArchUnit 这类框架也以引擎的形式接入，同一次 `mvn test` 里统一执行、统一出报告。

### 3、生命周期

```java
package com.example.order.pricing;

import static org.assertj.core.api.Assertions.assertThat;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;

import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class LifecycleDemoTest {

    @BeforeAll
    static void beforeAll() {
        System.out.println("1. 整个类执行一次（static）");
    }

    @BeforeEach
    void beforeEach() {
        System.out.println("2. 每个测试方法之前");
    }

    @Test
    void exportsQuoteToCsv(@TempDir Path dir) throws IOException {
        Path file = dir.resolve("quote.csv");
        Files.writeString(file, "orderNo,payable\nORD1,98.00\n");

        assertThat(file).content().contains("ORD1,98.00");
    }

    @Test
    void onlyOnCi() {
        assumeTrue("true".equals(System.getenv("CI")), "仅在 CI 环境执行");
        // 只有 CI 上才具备的前提，比如特定的 JDK 或时区设置
    }

    @AfterEach
    void afterEach() {
        System.out.println("3. 每个测试方法之后");
    }

    @AfterAll
    static void afterAll() {
        System.out.println("4. 整个类结束后执行一次（static）");
    }
}
```

几个要点：

- **默认每个测试方法都会新建一个测试类实例**，所以实例字段天然隔离，不需要在 `@AfterEach` 里手动清理。`@TestInstance(Lifecycle.PER_CLASS)` 可以改成整个类共用一个实例，此时 `@BeforeAll` 不必是 `static`，但字段状态会在测试之间残留，单元测试里很少需要
- 测试类和测试方法不需要 `public`，包级可见即可
- **假设**（`assumeTrue` / `assumeFalse` / `assumingThat`）不满足时测试被标记为跳过而不是失败；不要用它掩盖本该修复的环境问题
- `@TempDir` 注入的临时目录在测试结束后自动删除，6.1 起还可以配置删除策略

### 4、@DisplayName 与 @Nested

测试类按行为分组，用 `@Nested` 内部类表达「在某个场景下」，用 `@DisplayName` 写给人看的名字，IDE 和测试报告里会显示成一棵树：

```java
@DisplayName("订单计价 PriceCalculator")
class PriceCalculatorTest {

    // 北京时间 2026-10-10 08:00
    static final Instant NOW = Instant.parse("2026-10-10T00:00:00Z");

    PriceCalculator calculator;

    @BeforeEach
    void setUp() {
        calculator = new PriceCalculator(Clock.fixed(NOW, ZoneId.of("Asia/Shanghai")));
    }

    @Nested
    @DisplayName("会员折扣")
    class MemberDiscount { /* 第三节 */ }

    @Nested
    @DisplayName("满减券")
    class CouponDiscount { /* 第三、四节 */ }

    @Nested
    @DisplayName("运费")
    class Shipping { /* 第三节 */ }
}
```

外层的 `@BeforeEach` 会在每个嵌套类的测试之前执行，嵌套类还可以有自己的 `@BeforeEach` 叠加场景准备。JUnit 6 起 `@Nested` 类的执行顺序是确定的，`@TestMethodOrder` 也会被嵌套类继承。

不想逐个写 `@DisplayName` 时，可以在 `src/test/resources/junit-platform.properties` 里设置默认的显示名生成器，把方法名里的下划线替换成空格：

```properties
junit.jupiter.displayname.generator.default = org.junit.jupiter.api.DisplayNameGenerator$ReplaceUnderscores
```

### 5、超时

```java
@Test
@Timeout(value = 500, unit = TimeUnit.MILLISECONDS)
void quotesLargeOrderQuickly() {
    List<OrderLine> lines = IntStream.range(0, 10_000)
            .mapToObj(i -> new OrderLine("SKU-" + i, new BigDecimal("1.00"), 1))
            .toList();

    assertThat(calculator.quote(lines, MemberLevel.NORMAL).itemsTotal())
            .isEqualByComparingTo("10000");
}
```

`@Timeout` 是防止测试卡死的保险丝，不是性能测试：阈值要留足余量（CI 机器比本地慢得多），真正的性能对比用 [JMH](/high-perf/4_benchmark)。

### 6、运行配置与并行执行

Jupiter 的全局配置写在 `src/test/resources/junit-platform.properties`。并行执行默认关闭，开启后推荐「类之间并行、类内部串行」，对共享状态最友好：

```properties
junit.jupiter.execution.parallel.enabled = true
# 类内部的方法默认串行
junit.jupiter.execution.parallel.mode.default = same_thread
# 顶层测试类之间并行
junit.jupiter.execution.parallel.mode.classes.default = concurrent
```

确实要读写系统属性、全局单例的测试，用 `@ResourceLock("名称")` 声明共享资源，或用 `@Isolated` 让整个类独占执行。并行只对真正互相独立的测试有效，先把测试写成 FIRST 的（第五节），再开并行。

### 7、JUnit 6 相对 JUnit 5 的变化

| 变化 | 影响 |
|------|------|
| 最低 Java 17、Kotlin 2.1 | 还在 Java 8 / 11 的项目只能停留在 JUnit 5 |
| Platform、Jupiter、Vintage 版本号统一为 6.x | 不再有 Platform 1.x 与 Jupiter 5.x 两套版本号，用 BOM 管理即可 |
| 包名不变，仍为 `org.junit.jupiter.*` | 测试代码基本不用改，主要是删除已废弃 API 的用法 |
| Vintage 引擎废弃 | JUnit 4 测试应尽快迁移；Spring Framework 7 也废弃了 `SpringRunner` 等 JUnit 4 支持类 |
| 使用 JSpecify 注解标注可空性 | Kotlin 与静态分析工具能识别 API 的空值约定 |
| `@CsvSource` / `@CsvFileSource` 改用 FastCSV 解析 | 极少数依赖旧解析细节的 CSV 用例可能需要调整 |
| ConsoleLauncher 支持 `--fail-fast`，新增 `CancellationToken` 取消执行 | 大型套件可以在首个失败后尽早停止 |
| 移除 `junit-platform-runner`、`junit-platform-jfr` | JFR 支持并入 `junit-platform-launcher` |

6.1 在此基础上新增了 `@DefaultLocale`、`@DefaultTimeZone` 与系统属性的设置 / 恢复扩展，适合测试依赖默认区域设置的格式化逻辑。

---

## 三、参数化测试

同一条规则、多组输入输出，用参数化测试代替复制粘贴。`@ParameterizedTest` 在 `junit-jupiter-params` 里，`junit-jupiter` 聚合包已经包含。

### 1、@CsvSource：表格式用例

```java
@Nested
@DisplayName("会员折扣")
class MemberDiscount {

    @ParameterizedTest(name = "{0} 会员买 {1} 元，应付 {2}")
    @CsvSource(textBlock = """
            # level,  unitPrice, payable
            NORMAL,   200.00,    200.00
            SILVER,   200.00,    190.00
            GOLD,     200.00,    180.00
            SILVER,   33.33,     41.66
            """)
    void appliesRateByLevel(MemberLevel level, String unitPrice, BigDecimal payable) {
        PriceQuote quote = calculator.quote(singleLine(unitPrice, 1), level);

        assertThat(quote.payable()).isEqualByComparingTo(payable);
    }
}

@Nested
@DisplayName("运费")
class Shipping {

    @ParameterizedTest(name = "商品应付 {0} -> 运费 {1}")
    @CsvSource({"98.99, 10", "99.00, 0", "99.01, 0"})
    void freeShippingFrom99(String unitPrice, BigDecimal shippingFee) {
        PriceQuote quote = calculator.quote(singleLine(unitPrice, 1), MemberLevel.NORMAL);

        assertThat(quote.shippingFee()).isEqualByComparingTo(shippingFee);
    }
}
```

- 参数会自动转换：字符串到枚举（`NORMAL` → `MemberLevel.NORMAL`）、到 `BigDecimal`、到 `LocalDate` 等都内置支持
- `textBlock` 里 `#` 开头的行是注释，适合写表头
- 第四行 `33.33 × 0.95 = 31.6635`，舍入为 31.66，不满 99 加运费得 41.66，专门覆盖舍入规则
- 运费用例取 98.99 / 99.00 / 99.01 三个点，正好卡住「大于等于」的边界，这是参数化测试最有价值的用法

CSV 的几条解析规则：默认引号字符是单引号；未加引号的空值转成 `null`，`''` 才是空字符串；`nullValues = "N/A"` 可以把指定文本映射为 `null`；首尾空白默认去除。

### 2、@MethodSource：参数是对象时

参数里有对象（如 `Coupon`）时，用工厂方法提供。`Arguments.argumentSet` 给每组参数起名，报告里一眼能看出哪个场景失败：

```java
@Nested
@DisplayName("满减券")
class CouponDiscount {

    static Stream<Arguments> couponCases() {
        return Stream.of(
                argumentSet("未达门槛不减",
                        MemberLevel.NORMAL, "99.99", aCoupon().build(), "0"),
                argumentSet("恰好达到门槛",
                        MemberLevel.NORMAL, "100.00", aCoupon().build(), "20.00"),
                argumentSet("按会员折后金额判断门槛",
                        MemberLevel.GOLD, "110.00", aCoupon().build(), "0"),
                argumentSet("券面额大于金额时最多减到 0",
                        MemberLevel.NORMAL, "30.00", aCoupon().threshold("0").amount("50").build(), "30.00"));
    }

    @ParameterizedTest
    @MethodSource("couponCases")
    void discountsWhenThresholdReached(MemberLevel level, String unitPrice, Coupon coupon, String expected) {
        PriceQuote quote = calculator.quote(singleLine(unitPrice, 1), level, coupon);

        assertThat(quote.couponDiscount()).isEqualByComparingTo(expected);
    }
}
```

`@Nested` 内部类里可以直接写 `static` 工厂方法（Java 16 起内部类允许静态成员）。`aCoupon()` 是第七节的测试数据构建器。

### 3、其他参数来源

| 注解 | 用途 | 示例 |
|------|------|------|
| `@ValueSource` | 单个参数的一组字面量 | `@ValueSource(ints = {0, -1})` 测非法数量 |
| `@EnumSource` | 遍历枚举，可用 `names` / `mode` 过滤 | `@EnumSource(value = MemberLevel.class, names = {"SILVER", "GOLD"})` |
| `@NullSource` / `@EmptySource` / `@NullAndEmptySource` | 补充 `null` 与空值用例 | 校验 SKU 不能为空 |
| `@CsvFileSource` | 用例多到不适合写在注解里时，放到 CSV 文件 | 几十组费率表 |
| `@FieldSource` | 引用一个静态字段作为参数来源 | 多个测试共用同一组数据 |

显示名占位符：`{index}` 序号，`{0}`、`{1}` 第几个参数，`{arguments}` 全部参数，`{argumentSetName}` 参数组名称。

---

## 四、AssertJ 流式断言

JUnit 自带的 `assertEquals` 够用，但 AssertJ 的链式写法可读性更好、失败信息更具体，IDE 输入 `.` 就能补全可用的断言。统一从 `org.assertj.core.api.Assertions` 静态导入。

### 1、BigDecimal 比较：注意精度

```java
// 失败：BigDecimal.equals 比较精度，20 与 20.00 不相等
assertThat(quote.couponDiscount()).isEqualTo(new BigDecimal("20"));

// 通过：按数值比较
assertThat(quote.couponDiscount()).isEqualByComparingTo("20");
```

金额断言一律用 `isEqualByComparingTo`。record 的 `equals` 同样逐字段调用 `BigDecimal.equals`，整体比较时要换比较器（见下文递归比较）。

### 2、异常断言

```java
@Test
@DisplayName("到期时刻起券失效")
void rejectsCouponAtExpiry() {
    Coupon coupon = aCoupon().code("EXPIRING").expiresAt(NOW).build();

    assertThatThrownBy(() -> calculator.quote(singleLine("150.00", 1), MemberLevel.NORMAL, coupon))
            .isInstanceOf(CouponExpiredException.class)
            .hasMessage("coupon expired: EXPIRING");
}

@Test
void rejectsEmptyOrder() {
    assertThatIllegalArgumentException()
            .isThrownBy(() -> calculator.quote(List.of(), MemberLevel.NORMAL))
            .withMessageContaining("at least one line");
}

@Test
void rejectsNonPositiveQuantity() {
    // 先捕获再断言，适合 given-when-then 结构
    Throwable thrown = catchThrowable(() -> singleLine("10.00", 0));

    assertThat(thrown)
            .isInstanceOf(IllegalArgumentException.class)
            .hasMessage("quantity must be positive: 0");
}
```

三种写法等价，按可读性选择。不要用 `try { ...; fail(); } catch (...) {}` 的老写法，也不要只断言异常类型而不看消息：同一类型的异常可能来自完全不同的分支。

### 3、软断言：一次看到所有失败

一个测试要核对一个对象的多个字段时，普通断言在第一个失败处就停了；软断言收集全部失败一起报告：

```java
@Test
@DisplayName("折扣与满减叠加后跌破包邮线，要补运费")
void couponMayCancelFreeShipping() {
    // given：金卡会员，120 元商品，满 100 减 20 的券
    List<OrderLine> lines = singleLine("120.00", 1);
    Coupon coupon = aCoupon().build();

    // when
    PriceQuote quote = calculator.quote(lines, MemberLevel.GOLD, coupon);

    // then：120 -> 9 折 108 -> 减 20 得 88 -> 不满 99，加 10 元运费
    SoftAssertions.assertSoftly(softly -> {
        softly.assertThat(quote.itemsTotal()).isEqualByComparingTo("120.00");
        softly.assertThat(quote.memberDiscount()).isEqualByComparingTo("12.00");
        softly.assertThat(quote.couponDiscount()).isEqualByComparingTo("20.00");
        softly.assertThat(quote.shippingFee()).isEqualByComparingTo("10.00");
        softly.assertThat(quote.payable()).isEqualByComparingTo("98.00");
    });
}
```

这个用例还说明了一个容易漏掉的业务边界：优惠叠加后金额跌破包邮线，运费会重新出现。

### 4、递归比较与集合断言

```java
@Test
void comparesWholeQuoteIgnoringBigDecimalScale() {
    PriceQuote quote = calculator.quote(singleLine("39.90", 2), MemberLevel.NORMAL);

    assertThat(quote)
            .usingRecursiveComparison()
            .withComparatorForType(BigDecimal::compareTo, BigDecimal.class)
            .isEqualTo(new PriceQuote(
                    new BigDecimal("79.8"), BigDecimal.ZERO, BigDecimal.ZERO,
                    BigDecimal.TEN, new BigDecimal("89.8")));
}

@Test
void extractsFieldsFromLines() {
    List<OrderLine> lines = List.of(
            new OrderLine("SKU-1", new BigDecimal("39.90"), 2),
            new OrderLine("SKU-2", new BigDecimal("9.90"), 1));

    assertThat(lines)
            .hasSize(2)
            .extracting(OrderLine::sku, OrderLine::quantity)
            .containsExactly(tuple("SKU-1", 2), tuple("SKU-2", 1));

    assertThat(lines)
            .filteredOn(line -> line.quantity() > 1)
            .singleElement()
            .extracting(OrderLine::sku)
            .isEqualTo("SKU-1");
}
```

- `usingRecursiveComparison()` 逐字段比较，不依赖被测类的 `equals`；`ignoringFields("id", "createdAt")` 可以排除生成值
- `extracting` + `tuple` 一次比较集合里多个字段；`containsExactly` 要求顺序一致，`containsExactlyInAnyOrder` 不要求
- 文件、`Optional`、日期也有专门断言，如 `assertThat(path).content()`、`assertThat(optional).contains(x)`、`assertThat(instant).isBefore(...)`

---

## 五、好的单元测试长什么样

### 1、FIRST 原则

| 原则 | 含义 | 常见违反 |
|------|------|----------|
| **F**ast | 毫秒级，整个模块几秒跑完 | 启动 Spring、`Thread.sleep`、连数据库 |
| **I**ndependent | 测试之间没有顺序依赖，单独跑、乱序跑都通过 | 共享静态字段、依赖上一个测试写入的数据 |
| **R**epeatable | 任何机器、任何时间结果相同 | 读系统时间、随机数、默认时区与区域设置 |
| **S**elf-validating | 由断言判断成败，不需要人看输出 | 只 `System.out.println` 不断言 |
| **T**imely | 和生产代码同时写，最好先写，见 [TDD](./4_tdd) | 上线前集中补测试，只为凑覆盖率 |

### 2、结构：Arrange-Act-Assert

每个测试分三段，空行隔开：准备数据（Arrange / Given）、执行被测行为（Act / When）、验证结果（Assert / Then）。上一节的 `couponMayCancelFreeShipping` 就是标准写法。几条约束：

- **When 只有一行**：一个测试只验证一个行为；需要两次调用才能说清的，通常是两个测试
- **Then 可以有多个断言**，但都在描述同一个行为的结果
- **测试里不写逻辑**：没有 `if`、循环、计算期望值的代码。期望值直接写字面量（`"98.00"`），否则测试会和实现犯同样的错

### 3、命名

测试名要回答「在什么条件下、期望什么结果」，失败时只看名字就知道坏了什么：

| 风格 | 示例 |
|------|------|
| 行为描述（推荐） | `freeShippingFrom99`、`rejectsCouponAtExpiry` |
| should 句式 | `shouldRejectCouponAtExpiry` |
| 场景_期望 | `couponExpired_throwsException`（配合 `ReplaceUnderscores` 显示为句子） |
| 中文 `@DisplayName` | `@DisplayName("到期时刻起券失效")` |

团队选一种统一即可。避免 `test1`、`testQuote` 这类只说明「测了哪个方法」的名字。

### 4、常见反模式

- **测私有方法**：私有方法是实现细节，通过公开行为间接覆盖；如果某个私有方法复杂到必须单独测，说明它该被提取成独立的类
- **过度断言**：把与本测试无关的字段也断言一遍，任何无关改动都会让一堆测试失败
- **Mock 一切**：值对象、纯计算类直接用真实对象，Mock 只用在跨边界的协作者上，见 [Mock 测试](./2_mock)
- **一个测试里测多个场景**：失败时不知道是哪一个场景坏了，拆成参数化测试或多个测试
- **断言写在 `@AfterEach` 里**、**捕获异常后什么也不做**：测试看起来通过，实际什么都没验证

---

## 六、时间与随机数

### 1、注入 Clock

依赖系统时间的代码（券过期、订单超时、按日期生成编号）是单元测试最常见的不确定性来源。做法是把「现在」变成依赖注入进来：

- 生产代码只通过注入的 `java.time.Clock` 获取时间：`clock.instant()`、`LocalDateTime.now(clock)`，不直接调用 `Instant.now()`、`System.currentTimeMillis()`
- 测试里用 `Clock.fixed(instant, zone)` 固定时刻，用 `Clock.offset(base, duration)` 构造相对时刻
- Spring 应用里把 `Clock` 声明成 Bean，业务类通过构造器注入：

```java
@Configuration
class ClockConfig {

    @Bean
    Clock clock() {
        return Clock.system(ZoneId.of("Asia/Shanghai"));
    }
}
```

有了固定时钟，就能精确测试边界：第四节的 `rejectsCouponAtExpiry` 把过期时刻设为「现在」，验证「到期时刻起失效」；再加一个「到期前一秒仍可使用」，两个用例夹住 `isBefore` 这条判断：

```java
@Test
@DisplayName("到期前一秒仍可使用")
void acceptsCouponOneSecondBeforeExpiry() {
    Coupon coupon = aCoupon().expiresAt(NOW.plusSeconds(1)).build();

    PriceQuote quote = calculator.quote(singleLine("150.00", 1), MemberLevel.NORMAL, coupon);

    assertThat(quote.couponDiscount()).isEqualByComparingTo("20");
}
```

### 2、注入随机数

订单号生成器同时依赖时间和随机数，两者都注入：

```java
package com.example.order.pricing;

import java.time.Clock;
import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;
import java.util.random.RandomGenerator;

/** 订单号：ORD + 下单时刻（yyyyMMddHHmmss，按 Clock 的时区） + 4 位随机数 */
public class OrderNoGenerator {

    private static final DateTimeFormatter FORMAT = DateTimeFormatter.ofPattern("yyyyMMddHHmmss");

    private final Clock clock;
    private final RandomGenerator random;

    public OrderNoGenerator(Clock clock, RandomGenerator random) {
        this.clock = clock;
        this.random = random;
    }

    public String next() {
        return "ORD" + LocalDateTime.now(clock).format(FORMAT)
                + String.format("%04d", random.nextInt(10_000));
    }
}
```

```java
package com.example.order.pricing;

import static org.assertj.core.api.Assertions.assertThat;

import java.time.Clock;
import java.time.Instant;
import java.time.ZoneId;
import java.util.SplittableRandom;
import java.util.random.RandomGenerator;

import org.junit.jupiter.api.Test;

class OrderNoGeneratorTest {

    // UTC 00:30 = 北京时间 08:30，订单号按 Clock 的时区格式化
    final Clock clock = Clock.fixed(Instant.parse("2026-10-10T00:30:00Z"), ZoneId.of("Asia/Shanghai"));

    @Test
    void composesTimestampAndRandomSuffix() {
        RandomGenerator fixedRandom = new RandomGenerator() {
            @Override
            public long nextLong() {
                return 0L;
            }

            @Override
            public int nextInt(int bound) {
                return 42;
            }
        };

        String orderNo = new OrderNoGenerator(clock, fixedRandom).next();

        assertThat(orderNo).isEqualTo("ORD202610100830000042");
    }

    @Test
    void sameSeedProducesSameSequence() {
        OrderNoGenerator first = new OrderNoGenerator(clock, new SplittableRandom(7));
        OrderNoGenerator second = new OrderNoGenerator(clock, new SplittableRandom(7));

        assertThat(first.next()).isEqualTo(second.next())
                .matches("ORD20261010083000\\d{4}");
    }
}
```

- `java.util.random.RandomGenerator`（Java 17）是所有随机数实现的公共接口，生产代码注入它，测试里换成返回固定值的实现，或固定种子的 `SplittableRandom`
- 第一个测试同时验证了时区：固定时刻是 UTC 00:30，按 `Asia/Shanghai` 格式化成 08:30。依赖 JVM 默认时区的代码在本地和 CI（通常是 UTC）上会得到不同结果

### 3、用扩展把固定时钟变成注解

多个测试类都要固定时钟时，可以写一个 JUnit 扩展，把时刻声明在注解上。JUnit Jupiter 的扩展点主要有这几类：

| 扩展点 | 用途 | 典型实现 |
|--------|------|----------|
| `BeforeEachCallback` / `AfterEachCallback` 等 | 在生命周期前后插入逻辑 | 清理数据、记录耗时 |
| `ParameterResolver` | 给测试方法、构造器注入参数 | `@TempDir`、`MockitoExtension` 注入 `@Mock` 参数 |
| `TestExecutionExceptionHandler` | 处理测试抛出的异常 | 失败时打印诊断信息 |
| `ExecutionCondition` | 决定是否执行 | `@EnabledOnOs`、`@EnabledIfEnvironmentVariable` |
| `TestInstancePostProcessor` | 测试实例创建后处理 | `SpringExtension` 给测试类注入 Bean |

固定时钟用 `ParameterResolver` 实现：

```java
package com.example.order.pricing;

import java.lang.annotation.ElementType;
import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import java.lang.annotation.Target;

import org.junit.jupiter.api.extension.ExtendWith;

/** 给测试方法注入一个固定时刻的 Clock 参数 */
@Target({ElementType.TYPE, ElementType.METHOD})
@Retention(RetentionPolicy.RUNTIME)
@ExtendWith(FixedClockExtension.class)
public @interface FixedClock {

    /** ISO-8601 时刻，如 2026-10-10T00:00:00Z */
    String value();

    String zone() default "Asia/Shanghai";
}
```

```java
package com.example.order.pricing;

import java.time.Clock;
import java.time.Instant;
import java.time.ZoneId;

import org.junit.jupiter.api.extension.ExtensionContext;
import org.junit.jupiter.api.extension.ParameterContext;
import org.junit.jupiter.api.extension.ParameterResolutionException;
import org.junit.jupiter.api.extension.ParameterResolver;
import org.junit.platform.commons.support.AnnotationSupport;

public class FixedClockExtension implements ParameterResolver {

    @Override
    public boolean supportsParameter(ParameterContext parameterContext, ExtensionContext extensionContext) {
        return parameterContext.getParameter().getType() == Clock.class;
    }

    @Override
    public Object resolveParameter(ParameterContext parameterContext, ExtensionContext extensionContext) {
        // 方法上的注解优先，其次是类上的
        FixedClock config = extensionContext.getTestMethod()
                .flatMap(m -> AnnotationSupport.findAnnotation(m, FixedClock.class))
                .or(() -> AnnotationSupport.findAnnotation(extensionContext.getRequiredTestClass(), FixedClock.class))
                .orElseThrow(() -> new ParameterResolutionException("missing @FixedClock"));
        return Clock.fixed(Instant.parse(config.value()), ZoneId.of(config.zone()));
    }
}
```

`@FixedClock` 上标注了 `@ExtendWith`，所以它是一个组合注解：用到它的地方自动注册扩展，测试里直接声明 `Clock` 参数：

```java
class CouponExpiryTest {

    final Coupon coupon = aCoupon().expiresAt(Instant.parse("2026-12-31T16:00:00Z")).build();

    @Test
    @FixedClock("2026-12-31T15:59:59Z")
    void usableBeforeExpiry(Clock clock) {
        PriceQuote quote = new PriceCalculator(clock).quote(singleLine("150.00", 1), MemberLevel.NORMAL, coupon);

        assertThat(quote.couponDiscount()).isEqualByComparingTo("20");
    }

    @Test
    @FixedClock("2026-12-31T16:00:00Z")
    void expiredAtDeadline(Clock clock) {
        PriceCalculator calculator = new PriceCalculator(clock);

        assertThatExceptionOfType(CouponExpiredException.class)
                .isThrownBy(() -> calculator.quote(singleLine("150.00", 1), MemberLevel.NORMAL, coupon));
    }
}
```

---

## 七、测试数据构建器

### 1、问题：准备数据的代码比断言还长

直接 `new Coupon("FULL100-20", new BigDecimal("100.00"), new BigDecimal("20.00"), Instant.parse(...))` 有两个问题：每个测试都要写全所有字段，读者分不清哪个字段才是这个测试关心的；构造器一加字段，所有测试都要改。

### 2、Builder：默认值有效，测试只改关心的字段

```java
package com.example.order.pricing;

import java.math.BigDecimal;
import java.time.Instant;

/** 测试数据构建器：默认值是一张「有效、满 100 减 20」的券，测试只改自己关心的字段 */
public final class CouponBuilder {

    private String code = "FULL100-20";
    private BigDecimal threshold = new BigDecimal("100.00");
    private BigDecimal amount = new BigDecimal("20.00");
    private Instant expiresAt = Instant.parse("2026-12-31T16:00:00Z");

    private CouponBuilder() {
    }

    public static CouponBuilder aCoupon() {
        return new CouponBuilder();
    }

    public CouponBuilder code(String code) {
        this.code = code;
        return this;
    }

    public CouponBuilder threshold(String threshold) {
        this.threshold = new BigDecimal(threshold);
        return this;
    }

    public CouponBuilder amount(String amount) {
        this.amount = new BigDecimal(amount);
        return this;
    }

    public CouponBuilder expiresAt(Instant expiresAt) {
        this.expiresAt = expiresAt;
        return this;
    }

    public Coupon build() {
        return new Coupon(code, threshold, amount, expiresAt);
    }
}
```

```java
package com.example.order.pricing;

import java.math.BigDecimal;
import java.util.List;

public final class TestOrders {

    private TestOrders() {
    }

    /** 单行订单：sku 与测试无关，固定即可 */
    public static List<OrderLine> singleLine(String unitPrice, int quantity) {
        return List.of(new OrderLine("SKU-1", new BigDecimal(unitPrice), quantity));
    }
}
```

于是 `aCoupon().threshold("0").amount("50").build()` 一眼就能看出：这个测试只关心门槛和面额。几条约定：

- **默认值必须构成合法对象**，并且尽量「无聊」：不触发任何特殊分支，特殊情况由测试显式设置
- **金额参数用字符串**，避免 `new BigDecimal(0.1)` 这类浮点误差，也让测试更短
- Builder 放在 `src/test/java`，与被测类同包；多个模块共用时可以打成 `test-jar` 或独立的测试夹具模块
- 与之相对的 **Object Mother**（`TestCoupons.expired()`、`TestCoupons.full100minus20()`）适合少数固定场景，场景一多就会膨胀，两者可以结合：Mother 返回预设好的 Builder

建造者模式本身见 [建造者模式](/patterns/4_creational_builder)。

---

## 八、覆盖率与变异测试

### 1、覆盖率能说明什么

JaCoCo 统计测试执行到了哪些行、哪些分支。它擅长回答**哪些代码从未被执行**，比如没人测过的异常分支；但不能回答**执行过的代码有没有被正确验证**：删掉上面所有测试里的断言，覆盖率一点都不会变。

全站覆盖率口径：合并门槛只看 Sonar 质量门禁的新代码覆盖率（≥ 80%），JaCoCo `check` 只做只升不降的整体底线。插件配置、`argLine` 的坑与 Sonar 集成见 [代码质量](/engineering/3_code_quality)，这里不重复。

### 2、PIT：测试能不能发现 Bug

变异测试反过来检验测试：PIT 把生产代码改出一个个小 Bug（变异体），比如把 `<` 改成 `<=`、把条件取反、把返回值换成 `null`，然后运行测试。测试失败说明变异体被「杀死」，测试仍然通过说明变异体「存活」，即这里的 Bug 测试发现不了。

```xml
<plugin>
  <groupId>org.pitest</groupId>
  <artifactId>pitest-maven</artifactId>
  <version>1.30.0</version>
  <dependencies>
    <!-- JUnit Platform 支持；在 JUnit 6 下同样可用 -->
    <dependency>
      <groupId>org.pitest</groupId>
      <artifactId>pitest-junit5-plugin</artifactId>
      <version>1.2.3</version>
    </dependency>
  </dependencies>
  <configuration>
    <targetClasses>
      <param>com.example.order.pricing.*</param>
    </targetClasses>
    <targetTests>
      <param>com.example.order.pricing.*</param>
    </targetTests>
    <!-- 变异杀死率低于 80% 时构建失败 -->
    <mutationThreshold>80</mutationThreshold>
  </configuration>
</plugin>
```

```bash
mvn test-compile org.pitest:pitest-maven:mutationCoverage
# 报告在 target/pit-reports/index.html
```

对本篇的计价代码运行 PIT，行覆盖率 98%，20 个变异体杀死了 19 个，存活的那个在 `OrderLine` 构造器里：把 `unitPrice.signum() < 0` 改成 `<= 0` 之后所有测试依然通过。也就是说，如果有人误把单价校验写成「必须大于 0」，0 元赠品就下不了单，而现有测试发现不了。补一个用例即可杀死它：

```java
@Test
void allowsZeroPriceGiftLine() {
    assertThatNoException().isThrownBy(() -> new OrderLine("GIFT-1", BigDecimal.ZERO, 1));
}
```

这正是覆盖率看不出来的问题：这行代码早已被执行过，覆盖率是满的，缺的是对边界值的断言。

### 3、怎么用才划算

- 变异测试的耗时是普通测试的数倍到数十倍，**只对核心领域模块开启**（计价、库存、风控），用 `targetClasses` 限定范围
- 放在夜间流水线或手动执行，不进入 PR 必过门禁；增量分析（`withHistory`）可以只重算改动部分
- 存活的变异体不一定都要处理：有些是等价变异（改了也不影响结果），看报告时关注边界条件和异常分支
- 杀死率阈值和覆盖率一样只是信号，不设成团队 KPI

---

## 小结

- 单元测试只测纯内存的行为：不碰数据库、网络、Spring 容器，时间和随机数通过 `Clock`、`RandomGenerator` 注入
- JUnit 6 延续「平台 + 引擎」结构，Java 17 基线、版本号统一、包名不变、Vintage 废弃；Boot 项目由依赖管理决定版本
- `@Nested` + `@DisplayName` 按场景组织用例，`@CsvSource` 用表格覆盖规则与边界，`@MethodSource` + `argumentSet` 处理对象参数
- AssertJ：金额用 `isEqualByComparingTo`，异常用 `assertThatThrownBy`，多字段用软断言或递归比较
- 好测试遵循 FIRST 与 AAA，名字说清条件和期望，测试里不写逻辑，不测私有方法
- 测试数据构建器让每个测试只出现它关心的字段
- 覆盖率只说明哪些代码没被执行；PIT 能揪出「执行了但没验证」的边界，适合在核心模块上定期运行

Mockito 的用法在 [Mock 测试](./2_mock)，Spring 的切片测试在 [Spring Boot 测试](/spring-boot/13_testing)。

---

## 参考资料

- JUnit 6 用户指南：[JUnit User Guide](https://docs.junit.org/current/user-guide/)
- JUnit 参数化测试：[Parameterized Classes and Tests](https://docs.junit.org/current/writing-tests/parameterized-classes-and-tests.html)
- JUnit 并行执行：[Parallel Execution](https://docs.junit.org/current/writing-tests/parallel-execution.html)
- JUnit 发布说明（6.0 / 6.1 变化）：[JUnit Release Notes](https://docs.junit.org/current/release-notes/)
- AssertJ 核心断言：[AssertJ Core](https://assertj.github.io/doc/#assertj-core)
- Maven Surefire 使用 JUnit Platform：[Using JUnit 5 Platform](https://maven.apache.org/surefire/maven-surefire-plugin/examples/junit-platform.html)
- java.time.Clock：[Clock (Java SE 21)](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/time/Clock.html)
- RandomGenerator：[RandomGenerator (Java SE 21)](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/random/RandomGenerator.html)
- PIT 快速上手：[PIT Quickstart for Maven](https://pitest.org/quickstart/maven/)
- PIT JUnit 5 插件：[pitest-junit5-plugin](https://github.com/pitest/pitest-junit5-plugin)

> 下一篇：[Mock 测试](./2_mock)
