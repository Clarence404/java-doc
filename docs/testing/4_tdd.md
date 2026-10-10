---
description: 红-绿-重构循环、订单计价完整演练、伦敦派与芝加哥派、遗留代码、适用边界、与 AI 编码助手配合
---

# TDD 测试驱动开发

> **本篇目标**：理解红-绿-重构循环和它背后的三条规则，跟着一个 order-service 订单计价的完整演练体会「先写失败的测试 → 写最少的代码 → 重构」的节奏；分清由外而内（伦敦派）与由内而外（芝加哥派）两种做法，知道 TDD 在什么场景下划算、什么场景下不划算，以及用 AI 编码助手时测试先行还剩多少价值。
>
> **前置阅读**：[单元测试](./1_unit_test)、[Mock 测试](./2_mock)

TDD（Test-Driven Development）是一种**设计和编码的节奏**，不是一种测试类型：它产出的测试就是普通的单元测试，区别在于写测试的时机，以及测试反过来对代码设计的约束。示例使用 JDK 21、JUnit 6、AssertJ 和 Mockito，与 [单元测试](./1_unit_test) 一致。

---

## 一、红-绿-重构

### 1、一个循环

![TDD 红-绿-重构循环](../assets/testing/tdd-red-green-refactor.svg)

| 阶段 | 做什么 | 判断标准 |
|------|--------|----------|
| 红 | 为下一个小行为写一个测试，运行它，看它失败 | 失败原因符合预期（断言不通过或尚未实现），而不是拼写错误、空指针 |
| 绿 | 用最快的方式让这个测试通过，允许写死返回值、复制粘贴 | 新测试和所有旧测试全部通过 |
| 重构 | 在测试保护下消除重复、改善命名、提取方法或类 | 只改结构不改行为，每改一步跑一次测试，始终保持全绿 |

每一轮通常只有几分钟。节奏比单轮的代码量更重要：长时间停在红色状态，说明这一步迈得太大，应该退回去拆成更小的测试。

### 2、三条规则

Robert C. Martin 把 TDD 概括成三条规则：

1. 在写出一个失败的单元测试之前，不写任何产品代码
2. 测试只写到刚好失败为止，编译不通过也算失败
3. 产品代码只写到刚好让当前失败的测试通过为止

这三条规则听起来机械，背后的目的有两个：

- **每一行产品代码都有测试要求它存在**：没有测试驱动的代码就是没人验证过的代码
- **先看到测试失败**：一个从来没失败过的测试，可能根本没在测你以为它在测的东西（断言写错、测到了 Mock 本身）。「先红」是对测试本身的测试

### 3、几个常被误解的点

- **「写死返回值」不是偷懒**：它让你先把测试的结构、命名、断言写对；下一个测试会迫使你写出通用实现（这叫三角定位，Triangulation）
- **重构不能长期省略**：Kent Beck 在 Canon TDD 中把单轮的重构列为可选，但长期只做红-绿，得到的是一堆能通过测试的面条代码。设计改进几乎都发生在重构阶段
- **TDD 不追求覆盖率**：高覆盖率是副产品。为了凑覆盖率补写的测试，和 TDD 是两回事

---

## 二、完整演练：订单计价

### 1、需求

order-service 下单时要算出应付金额，规则如下：

1. 小计 = 各行「单价 × 数量」之和
2. 满减：每满 300 元减 30 元（650 元减 60，900 元减 90）
3. 会员在满减之后再打 95 折
4. 结果保留两位小数，四舍五入
5. 每行数量必须大于 0

先列一张测试清单（Kent Beck 的做法），按从简单到复杂的顺序排，做完一项划掉一项，过程中想到的新情况随时追加：

- 空订单应付 0
- 一行商品：单价 × 数量
- 多行商品求和
- 不满 300 不减，正好 300 减 30
- 每满 300 减 30（多档）
- 会员满减后 95 折，四舍五入到分
- 数量为 0 时拒绝

### 2、第一轮：空订单

**红**：先写测试。`OrderPricing` 和 `OrderLine` 都还不存在，测试编译不通过，这就是第一次「红」。

```java
class OrderPricingTest {

    private final OrderPricing pricing = new OrderPricing();

    @Test
    void emptyOrderCostsNothing() {
        assertThat(pricing.payable(List.of())).isEqualByComparingTo("0");
    }
}
```

金额用 `BigDecimal`，断言用 `isEqualByComparingTo`：它按数值比较，`51.0` 和 `51.00` 视为相等；`isEqualTo` 会连精度（scale）一起比较，容易误报。

**绿**：用 IDE 生成类和方法，写最少的代码。

```java
public record OrderLine(String sku, BigDecimal unitPrice, int quantity) {
}

public class OrderPricing {

    public BigDecimal payable(List<OrderLine> lines) {
        return BigDecimal.ZERO;
    }
}
```

**重构**：代码太少，无可重构，进入下一轮。

### 3、第二轮：一行商品

**红**：

```java
@Test
void singleLineCostsUnitPriceTimesQuantity() {
    var lines = List.of(new OrderLine("SKU-1", new BigDecimal("25.50"), 2));

    assertThat(pricing.payable(lines)).isEqualByComparingTo("51.00");
}
```

运行，失败信息是「期望 51.00，实际 0」，失败原因符合预期。

**绿**：只处理当前测试需要的情况：

```java
public BigDecimal payable(List<OrderLine> lines) {
    if (lines.isEmpty()) {
        return BigDecimal.ZERO;
    }
    OrderLine line = lines.get(0);
    return line.unitPrice().multiply(BigDecimal.valueOf(line.quantity()));
}
```

只取第一行显然不对，但目前没有测试能证明它错。下一个测试会。

### 4、第三轮：多行求和

**红**：用第二个例子「三角定位」，迫使实现变通用。

```java
@Test
void multipleLinesAreSummed() {
    var lines = List.of(
            new OrderLine("SKU-1", new BigDecimal("25.50"), 2),
            new OrderLine("SKU-2", new BigDecimal("10.00"), 3));

    assertThat(pricing.payable(lines)).isEqualByComparingTo("81.00");
}
```

**绿**：

```java
public BigDecimal payable(List<OrderLine> lines) {
    BigDecimal total = BigDecimal.ZERO;
    for (OrderLine line : lines) {
        total = total.add(line.unitPrice().multiply(BigDecimal.valueOf(line.quantity())));
    }
    return total;
}
```

`isEmpty()` 的特殊分支自然消失了：空列表循环零次，返回 0。

**重构**：「单价 × 数量」是订单行自己的知识，搬到 `OrderLine` 上；循环改成流。改完跑一遍，三个测试仍然全绿。

```java
public record OrderLine(String sku, BigDecimal unitPrice, int quantity) {

    public BigDecimal subtotal() {
        return unitPrice.multiply(BigDecimal.valueOf(quantity));
    }
}

public BigDecimal payable(List<OrderLine> lines) {
    return lines.stream()
            .map(OrderLine::subtotal)
            .reduce(BigDecimal.ZERO, BigDecimal::add);
}
```

测试里反复出现的 `new OrderLine(...)` 也是重复，顺手提取一个辅助方法 `line(unitPrice, quantity)`，后面的测试都用它。测试代码同样需要重构。

### 5、第四、五轮：满减

**红**：边界值最容易出错，299.99 和 300 各写一个。用参数化测试把同一规则的多个例子放在一起：

```java
@ParameterizedTest(name = "小计 {0} 应付 {1}")
@CsvSource({
    "299.99, 299.99",
    "300.00, 270.00"
})
void fullReductionAtThreshold(String subtotal, String expected) {
    assertThat(pricing.payable(List.of(line(subtotal, 1)))).isEqualByComparingTo(expected);
}
```

**绿**：

```java
public BigDecimal payable(List<OrderLine> lines) {
    BigDecimal subtotal = lines.stream()
            .map(OrderLine::subtotal)
            .reduce(BigDecimal.ZERO, BigDecimal::add);
    if (subtotal.compareTo(new BigDecimal("300")) >= 0) {
        return subtotal.subtract(new BigDecimal("30"));
    }
    return subtotal;
}
```

**红**：需求说的是「每满 300 减 30」，加两个多档的例子，`if` 版本立刻失败（650 只减了 30）。

```java
@CsvSource({
    "299.99, 299.99",
    "300.00, 270.00",
    "650.00, 590.00",
    "900.00, 810.00"
})
```

**绿**：算出满了几个 300：

```java
BigDecimal times = subtotal.divideToIntegralValue(new BigDecimal("300"));
return subtotal.subtract(new BigDecimal("30").multiply(times));
```

`if` 分支又一次自然消失：不满 300 时 `times` 为 0，减 0。

**重构**：魔法数字提成常量，满减逻辑提取成有名字的方法，测试方法改名为 `every300Minus30` 以反映真实规则。

### 6、第六轮：会员折扣

**红**：会员身份是新的输入，测试先决定 API 长什么样。用枚举而不是 `boolean`：调用处 `payable(lines, MEMBER)` 比 `payable(lines, true)` 好读，以后加等级也不用改签名。

```java
@ParameterizedTest(name = "会员小计 {0} 应付 {1}")
@CsvSource({
    "100.00, 95.00",
    "333.33, 288.16"
})
void memberGets5PercentOffAfterReduction(String subtotal, String expected) {
    assertThat(pricing.payable(List.of(line(subtotal, 1)), MEMBER)).isEqualByComparingTo(expected);
}
```

第二个例子同时钉住了两条规则的顺序和舍入：333.33 先减 30 得 303.33，再乘 0.95 得 288.1635，四舍五入为 288.16。如果先打折再满减，结果会是 286.66，测试能区分出来。

签名变了，旧测试无法编译。先给旧测试统一补上 `NORMAL` 参数、让它们重新变绿，再处理新测试。这本身就是一次小重构：**同一时刻只让一个测试处于红色**。

**绿 + 重构**之后的产品代码：

```java
public enum CustomerLevel {
    NORMAL, MEMBER
}

public class OrderPricing {

    private static final BigDecimal REDUCTION_THRESHOLD = new BigDecimal("300");
    private static final BigDecimal REDUCTION_AMOUNT = new BigDecimal("30");
    private static final BigDecimal MEMBER_RATE = new BigDecimal("0.95");

    public BigDecimal payable(List<OrderLine> lines, CustomerLevel level) {
        BigDecimal subtotal = lines.stream()
                .map(OrderLine::subtotal)
                .reduce(BigDecimal.ZERO, BigDecimal::add);
        BigDecimal afterReduction = applyFullReduction(subtotal);
        BigDecimal afterDiscount = applyMemberDiscount(afterReduction, level);
        return afterDiscount.setScale(2, RoundingMode.HALF_UP);
    }

    private BigDecimal applyFullReduction(BigDecimal amount) {
        BigDecimal times = amount.divideToIntegralValue(REDUCTION_THRESHOLD);
        return amount.subtract(REDUCTION_AMOUNT.multiply(times));
    }

    private BigDecimal applyMemberDiscount(BigDecimal amount, CustomerLevel level) {
        return level == CustomerLevel.MEMBER ? amount.multiply(MEMBER_RATE) : amount;
    }
}
```

此时只有两条规则，两个私有方法足够清楚。等到第三条规则（比如优惠券）出现、`payable` 开始堆 `if` 时，再把规则提取成策略列表；**重构由已经出现的重复驱动，而不是由想象中的需求驱动**。

### 7、第七轮：非法数量

**红**：

```java
@Test
void quantityMustBePositive() {
    assertThatThrownBy(() -> line("10.00", 0))
            .isInstanceOf(IllegalArgumentException.class)
            .hasMessageContaining("quantity");
}
```

**绿**：校验放进 record 的紧凑构造器，非法订单行根本创建不出来，`OrderPricing` 无需关心：

```java
public record OrderLine(String sku, BigDecimal unitPrice, int quantity) {

    public OrderLine {
        if (quantity <= 0) {
            throw new IllegalArgumentException("quantity must be positive: " + quantity);
        }
    }

    public BigDecimal subtotal() {
        return unitPrice.multiply(BigDecimal.valueOf(quantity));
    }
}
```

### 8、最终的测试类

```java
package com.example.order.pricing;

import java.math.BigDecimal;
import java.util.List;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;

import static com.example.order.pricing.CustomerLevel.MEMBER;
import static com.example.order.pricing.CustomerLevel.NORMAL;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class OrderPricingTest {

    private final OrderPricing pricing = new OrderPricing();

    @Test
    void emptyOrderCostsNothing() {
        assertThat(pricing.payable(List.of(), NORMAL)).isEqualByComparingTo("0");
    }

    @Test
    void singleLineCostsUnitPriceTimesQuantity() {
        assertThat(pricing.payable(List.of(line("25.50", 2)), NORMAL)).isEqualByComparingTo("51.00");
    }

    @Test
    void multipleLinesAreSummed() {
        var lines = List.of(line("25.50", 2), line("10.00", 3));

        assertThat(pricing.payable(lines, NORMAL)).isEqualByComparingTo("81.00");
    }

    @ParameterizedTest(name = "小计 {0} 应付 {1}")
    @CsvSource({
        "299.99, 299.99",
        "300.00, 270.00",
        "650.00, 590.00",
        "900.00, 810.00"
    })
    void every300Minus30(String subtotal, String expected) {
        assertThat(pricing.payable(List.of(line(subtotal, 1)), NORMAL)).isEqualByComparingTo(expected);
    }

    @ParameterizedTest(name = "会员小计 {0} 应付 {1}")
    @CsvSource({
        "100.00, 95.00",
        "333.33, 288.16"
    })
    void memberGets5PercentOffAfterReduction(String subtotal, String expected) {
        assertThat(pricing.payable(List.of(line(subtotal, 1)), MEMBER)).isEqualByComparingTo(expected);
    }

    @Test
    void quantityMustBePositive() {
        assertThatThrownBy(() -> line("10.00", 0))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("quantity");
    }

    private static OrderLine line(String unitPrice, int quantity) {
        return new OrderLine("SKU-" + unitPrice, new BigDecimal(unitPrice), quantity);
    }
}
```

回头看这次演练：

- 测试清单让人始终只想一件事，新想到的边界（负单价？超大数量？）追加到清单里，不打断当前循环
- 两次「`if` 分支自然消失」都来自三角定位：第二个例子迫使实现从特例变成通用规则
- 每个测试名都是一条可读的业务规则，测试类本身就是这段计价逻辑的说明书
- 最终代码没有任何没被测试要求的分支，也没有为「将来可能」预留的抽象

---

## 三、两种流派：由外而内与由内而外

### 1、对比

上面的演练从最底层的计价逻辑开始，逐步向上构建，这是**由内而外**（Inside-Out）。另一种做法从最外层的用例开始，一路向内推进，叫**由外而内**（Outside-In）。

| 维度 | 芝加哥派 / 底特律派（Classicist） | 伦敦派（Mockist） |
|------|-----------------------------------|-------------------|
| 推进方向 | 由内而外：先写领域对象，再组装成服务 | 由外而内：先写入口（Controller / 应用服务），协作者先用 Mock 代替 |
| 验证方式 | 状态验证：调用后检查返回值或对象状态 | 行为验证：检查是否以正确的参数调用了协作者 |
| 替身用法 | 尽量用真实对象，只替换慢的或外部的依赖（常用手写 Fake） | 被测类之外的协作者都用 Mock |
| 设计效果 | 领域模型扎实，接口从实现中长出来 | 协作者的接口由调用方的需要决定，职责划分清晰 |
| 主要风险 | 上层组装时才发现底层接口不好用 | 测试与实现细节耦合，重构时大量测试跟着改 |
| 代表著作 | Kent Beck《Test Driven Development: By Example》 | Freeman & Pryce《Growing Object-Oriented Software, Guided by Tests》 |

### 2、同一个用例，两种测法

用例：下单时先锁库存，再按计价结果保存订单。协作者都是领域层定义的接口：

```java
public interface InventoryClient {
    void reserve(String orderNo, List<OrderLine> lines);
}

public interface OrderStore {
    void save(Order order);
    Optional<Order> findByOrderNo(String orderNo);
}
```

**伦敦派**：`PlaceOrderService` 还没写之前，先用 Mock 描述它应该如何与协作者交互（Mockito 用法见 [Mock 测试](./2_mock)）：

```java
@ExtendWith(MockitoExtension.class)
class PlaceOrderServiceTest {

    @Mock
    InventoryClient inventory;

    @Mock
    OrderStore orders;

    @Mock
    OrderPricing pricing;

    @InjectMocks
    PlaceOrderService service;

    @Test
    void reservesStockBeforeSavingOrder() {
        var lines = List.of(new OrderLine("SKU-1", new BigDecimal("25.50"), 2));
        when(pricing.payable(lines, CustomerLevel.NORMAL)).thenReturn(new BigDecimal("51.00"));

        service.place("ORD-1", lines, CustomerLevel.NORMAL);

        InOrder inOrder = inOrder(inventory, orders);
        inOrder.verify(inventory).reserve("ORD-1", lines);
        inOrder.verify(orders).save(argThat(o -> o.getPayable().compareTo(new BigDecimal("51.00")) == 0));
    }
}
```

这个测试驱动出了 `InventoryClient` 和 `OrderStore` 两个接口的形状，而它们的实现可以以后再写。

**芝加哥派**：用真实的 `OrderPricing` 和手写的内存 Fake，只检查最终状态：

```java
class PlaceOrderServiceClassicTest {

    private final InMemoryOrderStore orders = new InMemoryOrderStore();
    private final FakeInventoryClient inventory = new FakeInventoryClient();
    private final PlaceOrderService service =
            new PlaceOrderService(inventory, orders, new OrderPricing());

    @Test
    void placedOrderHasPayableAndReservedStock() {
        var lines = List.of(new OrderLine("SKU-1", new BigDecimal("25.50"), 2));

        service.place("ORD-1", lines, CustomerLevel.NORMAL);

        assertThat(orders.findByOrderNo("ORD-1"))
                .hasValueSatisfying(o -> assertThat(o.getPayable()).isEqualByComparingTo("51.00"));
        assertThat(inventory.reservedFor("ORD-1")).isEqualTo(lines);
    }
}
```

把 `PlaceOrderService` 内部改成先算价再锁库存，芝加哥派测试不受影响，伦敦派测试会失败。这既是伦敦派的代价（与实现耦合），也是它的用途（「先锁库存」如果真是业务要求，就该被测试钉住）。

### 3、实践中怎么选

多数团队混合使用：

- **领域逻辑**（计价、状态机、规则校验）用芝加哥派，状态验证，不 Mock
- **应用服务的编排**（调谁、按什么顺序、失败时补偿什么）用伦敦派，交互本身就是要验证的行为
- **Mock 只用在自己拥有的接口上**：不要直接 Mock `RestClient`、`KafkaTemplate` 这类第三方类型，而是在它们外面包一层自己的接口（如 `InventoryClient`），Mock 这层接口；包装层本身用 [集成测试](./3_integration_test) 验证
- 一个功能从外到内推进时，外层用一个验收级测试（如 `@SpringBootTest` 驱动的下单用例）兜底，内层再用快速的单元测试逐个驱动，这就是 GOOS 一书中的「双循环」

---

## 四、BDD 与验收测试

BDD（Behavior-Driven Development）是 TDD 在需求层面的延伸：用业务人员也能读懂的 Given-When-Then 格式描述行为，再把它变成可执行的验收测试。Java 生态的常见实现是 Cucumber-JVM，场景写在 `.feature` 文件中：

```gherkin
Feature: 订单满减

  Scenario: 每满 300 减 30
    Given 购物车小计为 650.00 元
    When 普通用户下单
    Then 应付金额为 590.00 元
```

每一行由 Java 的步骤定义方法实现。它的价值在于让产品、测试和开发对同一份示例达成一致；代价是多了一层需要维护的映射。如果业务方并不会阅读 `.feature` 文件，在 JUnit 测试里用 `// given // when // then` 注释组织结构、用 `@DisplayName` 写业务语言，能拿到大部分好处。

---

## 五、什么时候用 TDD

### 1、划算与不划算

| 场景 | 是否适合 | 原因 |
|------|----------|------|
| 业务规则、计算逻辑（计价、风控规则、状态机） | 非常适合 | 输入输出明确，例子容易列举，回归价值高 |
| 修复缺陷 | 非常适合 | 先写一个复现缺陷的失败测试，修好后它永久防止回归 |
| 公共库、SDK 的 API 设计 | 适合 | 测试即第一个调用方，能尽早暴露难用的接口 |
| 探索性原型、技术验证（Spike） | 不适合 | 目标是学习而非交付，代码大概率扔掉；验证完再用 TDD 重写 |
| UI 布局与视觉效果 | 不适合 | 「看起来对不对」难以断言，用视觉回归或人工评审 |
| 很薄的胶水代码（配置、简单 CRUD 透传） | 收益低 | 逻辑少，集成测试一次覆盖更划算 |
| 需求本身还不清楚 | 先澄清 | 写不出测试往往说明还不知道要什么，这正是 TDD 暴露出的问题 |

### 2、常见的失败方式

- **步子太大**：一个测试覆盖一整个功能，长时间红着，退化成「先写代码再补测试」
- **测试实现而非行为**：测私有方法、断言内部调用细节，导致每次重构都要改一堆测试，团队最终放弃
- **跳过重构**：测试都绿了，但代码越来越乱，测试本身也越来越难写
- **为了 TDD 而 TDD**：对配置类、DTO 机械地先写测试，消耗团队对这套方法的耐心

TDD 的成本主要在前期：学习曲线、写测试的时间。收益在后期：更少的缺陷、敢重构、可读的规格。对生命周期长、规则复杂的核心业务代码，这笔账通常是划算的。

---

## 六、遗留代码：先写特征测试

没有测试的遗留代码无法直接 TDD，因为改动之前没有安全网。Michael Feathers 在《Working Effectively with Legacy Code》中给出的做法是先把现状钉住：

1. **找接缝（Seam）**：找到可以在不改调用方的情况下替换依赖的位置，例如把方法内部 `new PaymentClient()` 改为构造器注入，或提取一个可覆盖的受保护方法。这一步的改动要尽可能小、尽可能机械（用 IDE 的自动重构）
2. **写特征测试（Characterization Test）**：不关心代码「应该」做什么，只记录它「实际」做什么。调用方法，把实际输出原样写进断言。即使输出看起来有 bug，也先照实记录，单独提缺陷
3. **在测试保护下重构**：特征测试全绿后，开始拆分、改名、提取，每一步都跑测试
4. **新需求用 TDD**：在整理好的代码上，按红-绿-重构添加新行为

```java
@Test
void characterizeLegacyPriceCalculation() {
    LegacyPriceCalculator calculator = new LegacyPriceCalculator();

    // 实际运行一次后，把输出原样写进断言，而不是按需求推算
    assertThat(calculator.calc(650.0, "VIP")).isEqualTo(560.5);
}
```

特征测试的目的是在重构过程中发现「行为变了」，而不是证明行为正确。重构完成、行为确认后，可以把它们改写成表达业务意图的正常测试。

---

## 七、TDD 与 AI 编码助手

AI 编码助手（IDE 补全、编程 Agent）能在几秒内生成实现和测试，这让「先写测试」的意义受到质疑，也让它以另一种方式变得重要。下面是几种常见的看法与做法，团队可以按自己的情况取舍。

### 1、测试作为给 AI 的规格

- 先写好失败的测试（或让 AI 根据需求起草、由人审阅后定稿），再让 AI 写实现、直到测试通过。测试比自然语言描述更精确，也能自动判断「做完了没有」
- 编程 Agent 能自己运行测试、读失败信息、继续修改，红-绿循环可以由它闭环完成；人把精力放在测试清单和重构质量上
- 对于计价这类规则密集的代码，测试清单（第二节）本身就是最好的提示词

### 2、需要注意的风险

- **测试镜像实现**：先生成实现再让 AI「补测试」，得到的往往是把实现逻辑再抄一遍的测试，代码错了测试也跟着错。这正是「先红」要防止的问题
- **为了变绿而改测试**：Agent 在测试失败时可能修改断言或删除测试来「通过」。审查时把测试文件的改动单独看，或在提示与项目规则文件中明确禁止修改既有测试
- **数量代替质量**：生成大量测试很容易，覆盖率数字会很好看，但断言是否有意义需要人判断；变异测试工具（如 PIT）可以帮助检查测试能否发现被故意改错的代码，见 [代码质量](/engineering/3_code_quality)
- **跳过重构**：AI 写出的「能通过」的代码不一定是好结构，重构阶段仍然需要人的判断

### 3、一种可行的分工

| 步骤 | 主要由谁完成 |
|------|--------------|
| 拆需求、列测试清单、确定边界例子 | 人（可让 AI 补充遗漏的边界） |
| 写或审定失败的测试，确认失败原因 | 人审定 |
| 写最少实现，让测试通过 | AI |
| 重构 | AI 提方案，人判断取舍 |
| 审查测试与实现的改动 | 人 |

团队层面的 AI 工具使用规范（审查、测试、权限）见 [AI 编程工具怎么选](/ai/6_tools/0_ai_tools)。

---

## 小结

- TDD 是设计和编码的节奏：红（写一个失败的测试）→ 绿（最少代码让它通过）→ 重构（测试保护下改善结构），每轮几分钟
- 「先看到测试失败」是对测试本身的检验；写死返回值配合三角定位，让通用实现由例子逼出来
- 用测试清单管理思路，一次只让一个测试处于红色；重构由已出现的重复驱动，不为想象中的需求预留抽象
- 芝加哥派由内而外、状态验证、少用 Mock；伦敦派由外而内、行为验证、用 Mock 驱动出协作者接口；领域逻辑用前者，服务编排用后者，只 Mock 自己拥有的接口
- BDD 用 Given-When-Then 让业务方参与示例，业务方不读 `.feature` 时，结构清晰的 JUnit 测试就够了
- 规则密集的业务逻辑、缺陷修复最适合 TDD；探索原型、UI、薄胶水代码不适合
- 遗留代码先找接缝、写特征测试钉住现状，再重构，再用 TDD 加新功能
- 与 AI 编码助手配合时，测试是精确的规格和完成判据；要防止测试镜像实现、为变绿而改测试，测试改动必须由人审查

## 参考资料

- Kent Beck《Test Driven Development: By Example》：[Addison-Wesley 图书页](https://www.oreilly.com/library/view/test-driven-development/0321146530/)
- Martin Fowler 对 TDD 的概述：[TestDrivenDevelopment](https://martinfowler.com/bliki/TestDrivenDevelopment.html)
- Kent Beck 测试清单的写法：[Canon TDD](https://tidyfirst.substack.com/p/canon-tdd)
- 两种流派的对比：[Mocks Aren't Stubs](https://martinfowler.com/articles/mocksArentStubs.html)
- Freeman & Pryce《Growing Object-Oriented Software, Guided by Tests》：[图书官网](http://www.growing-object-oriented-software.com/)
- Michael Feathers《Working Effectively with Legacy Code》：[O'Reilly 图书页](https://www.oreilly.com/library/view/working-effectively-with/0131177052/)
- JUnit 参数化测试：[Parameterized Tests](https://docs.junit.org/current/writing-tests/parameterized-classes-and-tests.html)
- Cucumber-JVM：[Cucumber 文档](https://cucumber.io/docs/installation/java)
- PIT 变异测试：[PIT 官网](https://pitest.org/)

> 下一篇：[Testcontainers](./5_testcontainers)
