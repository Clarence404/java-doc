---
description: 测试替身分类、Mockito 5 打桩与验证、ArgumentCaptor、严格桩、Spy、静态与构造 Mock、Fake、WireMock
---

# Mock 测试

> 前置阅读：[单元测试](./1_unit_test)

本篇讲 Mockito 本身和测试替身的取舍：打桩、参数捕获、交互验证、严格桩、什么时候不该 Mock、JDK 21+ 挂载 agent，以及用 WireMock 测试外部 HTTP。版本基线（2026 年 10 月）：JDK 21、Spring Boot 4.x、Mockito 5.x（Boot 4.0 管理的是 5.20，Maven Central 上最新为 5.24）、WireMock 3.13。

---

## 一、测试替身：Mock 只是其中一种

### 1、五种替身

「测试替身」（Test Double）是 Gerard Meszaros 在《xUnit Test Patterns》里提出的统称：测试时用来顶替真实依赖的对象。日常说的「Mock 一下」其实混用了好几种：

| 替身 | 行为 | 测试里怎么用 | 订单服务里的例子 |
|------|------|--------------|------------------|
| Dummy | 什么都不做，只为凑参数 | 传进去但永远不会被调用 | 校验失败分支里用不到的 `OrderEventPublisher` |
| Stub | 对调用返回预设值 | 给被测对象喂输入，断言**返回值和状态** | 让 `PaymentClient` 固定返回「支付成功」 |
| Spy | 包住真实对象，记录调用，可局部改写 | 大部分走真实逻辑，个别方法打桩 | 包一层真实的价格计算器，只改其中一个折扣方法 |
| Mock | 预设期望并**验证交互** | 断言「某个调用发生了、参数是什么」 | 验证支付成功后发布了 `OrderPaidEvent` |
| Fake | 有真实逻辑的轻量实现 | 当作真实依赖使用，不关心调用细节 | 用 `HashMap` 实现的 `InMemoryOrderRepository` |

Mockito 的 `mock()` 生成的对象既能当 Stub（`when...thenReturn`）也能当 Mock（`verify`），所以两者常被混为一谈。区分它们的意义在于**断言方式不同**：

- **状态验证**：调用被测方法后检查返回值或对象状态。对查询类依赖（读仓储、查价格、查库存）只需要 Stub，不应该 `verify`
- **行为验证**：检查被测对象对外发出了什么调用。只用在「调用本身就是业务结果」的地方：扣款、发消息、发通知、写审计日志

一条实用规则：**查询打桩，命令验证**。对查询方法 `verify` 只会把测试和实现细节绑死，换一种等价写法测试就红。

### 2、贯穿全文的被测代码

下单服务：先落库拿到订单号，调支付网关扣款，成功则发布事件，最后再保存一次状态。四个依赖分别是仓储、支付客户端、事件发布器和时钟。

```java
public record OrderItem(String skuId, int quantity, BigDecimal unitPrice) {

    public BigDecimal subtotal() {
        return unitPrice.multiply(BigDecimal.valueOf(quantity));
    }
}

public record CreateOrderCommand(String userId, List<OrderItem> items) {}
public record PaymentResult(String paymentId, boolean success) {}
public record OrderPaidEvent(long orderId, BigDecimal amount) {}
public enum OrderStatus { CREATED, PAID, PAYMENT_FAILED }

public interface OrderRepository {
    Order save(Order order);
    Optional<Order> findById(long id);
}

public interface PaymentClient {
    PaymentResult charge(long orderId, BigDecimal amount);
}

public interface OrderEventPublisher {
    void publish(OrderPaidEvent event);
}
```

```java
public class Order {

    private Long id;
    private final String userId;
    private final List<OrderItem> items;
    private final Instant createdAt;
    private OrderStatus status = OrderStatus.CREATED;
    private String paymentId;

    public Order(String userId, List<OrderItem> items, Instant createdAt) {
        this.userId = userId;
        this.items = List.copyOf(items);
        this.createdAt = createdAt;
    }

    public void assignId(long id) {          // 由仓储在首次保存时分配
        if (this.id == null) {
            this.id = id;
        }
    }

    public BigDecimal total() {
        return items.stream().map(OrderItem::subtotal).reduce(BigDecimal.ZERO, BigDecimal::add);
    }

    public void markPaid(String paymentId) {
        this.status = OrderStatus.PAID;
        this.paymentId = paymentId;
    }

    public void markPaymentFailed() {
        this.status = OrderStatus.PAYMENT_FAILED;
    }

    public Long getId() { return id; }
    public String getUserId() { return userId; }
    public List<OrderItem> getItems() { return items; }
    public Instant getCreatedAt() { return createdAt; }
    public OrderStatus getStatus() { return status; }
    public String getPaymentId() { return paymentId; }
}
```

```java
public class OrderService {

    private final OrderRepository repository;
    private final PaymentClient paymentClient;
    private final OrderEventPublisher publisher;
    private final Clock clock;

    public OrderService(OrderRepository repository, PaymentClient paymentClient,
                        OrderEventPublisher publisher, Clock clock) {
        this.repository = repository;
        this.paymentClient = paymentClient;
        this.publisher = publisher;
        this.clock = clock;
    }

    public Order place(CreateOrderCommand command) {
        if (command.items().isEmpty()) {
            throw new IllegalArgumentException("订单至少包含一个商品");
        }
        Order order = repository.save(new Order(command.userId(), command.items(), Instant.now(clock)));

        PaymentResult result = paymentClient.charge(order.getId(), order.total());
        if (result.success()) {
            order.markPaid(result.paymentId());
            publisher.publish(new OrderPaidEvent(order.getId(), order.total()));
        } else {
            order.markPaymentFailed();
        }
        return repository.save(order);
    }
}
```

全部依赖通过构造器注入，时间通过 `Clock` 注入——这是代码「好测」的前提。依赖藏在方法内部 `new` 或静态调用里时，就只能靠第九节的重型手段。

---

## 二、Mockito 5 上手

### 1、依赖

Spring Boot 项目里 `spring-boot-starter-test` 已经带了 `mockito-core` 和 `mockito-junit-jupiter`，版本由 Boot 管理，不需要额外声明。非 Boot 项目单独引入：

```xml
<dependency>
    <groupId>org.mockito</groupId>
    <artifactId>mockito-junit-jupiter</artifactId>
    <version>5.24.0</version>
    <scope>test</scope>
</dependency>
```

`mockito-junit-jupiter` 会传递引入 `mockito-core`。Mockito 5 有两个和老版本不同的地方：

- **默认 mock maker 改为 inline**：基于字节码插桩（Byte Buddy + Java agent），可以直接 Mock `final` 类、`final` 方法、枚举和静态方法，不再需要单独引入 `mockito-inline`，老项目里的这个依赖可以删掉
- **最低 Java 11**：inline mock maker 依赖 agent，在 JDK 21+ 上要显式挂载，见第十节

确实需要老的「生成子类」方式时（例如某些不支持 agent 的运行环境），可以在 `src/test/resources/mockito-extensions/org.mockito.plugins.MockMaker` 文件里写一行 `mock-maker-subclass` 切回去，代价是不能再 Mock `final` 和静态方法。

### 2、第一个测试

```java
import java.math.BigDecimal;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.List;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.ArgumentCaptor;
import org.mockito.Captor;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

@ExtendWith(MockitoExtension.class)
class OrderServiceTest {

    @Mock
    OrderRepository repository;

    @Mock
    PaymentClient paymentClient;

    @Mock
    OrderEventPublisher publisher;

    @Captor
    ArgumentCaptor<OrderPaidEvent> eventCaptor;

    private final Clock clock = Clock.fixed(Instant.parse("2026-10-01T08:00:00Z"), ZoneOffset.UTC);

    private OrderService service;

    @BeforeEach
    void setUp() {
        service = new OrderService(repository, paymentClient, publisher, clock);
    }

    @Test
    void paidOrderPublishesEvent() {
        saveAssignsId(1001L);
        when(paymentClient.charge(eq(1001L), any(BigDecimal.class)))
                .thenReturn(new PaymentResult("pay-1", true));

        Order order = service.place(command());

        assertThat(order.getStatus()).isEqualTo(OrderStatus.PAID);
        assertThat(order.getCreatedAt()).isEqualTo(Instant.parse("2026-10-01T08:00:00Z"));

        verify(publisher).publish(eventCaptor.capture());
        OrderPaidEvent event = eventCaptor.getValue();
        assertThat(event.orderId()).isEqualTo(1001L);
        assertThat(event.amount()).isEqualByComparingTo("59.80");
    }

    private void saveAssignsId(long id) {
        when(repository.save(any(Order.class))).thenAnswer(invocation -> {
            Order order = invocation.getArgument(0);
            order.assignId(id);
            return order;
        });
    }

    private static CreateOrderCommand command() {
        return new CreateOrderCommand("u1", List.of(new OrderItem("sku-1", 2, new BigDecimal("29.90"))));
    }
}
```

几个要点：

- `MockitoExtension` 负责初始化 `@Mock`、`@Spy`、`@Captor`、`@InjectMocks` 字段，每个测试方法拿到的都是全新的 Mock，并在测试结束时检查严格桩（第六节）
- 时钟用 `Clock.fixed` 的真实对象，不 Mock：`Clock` 是值语义的依赖，固定一个时间点比打桩更直接
- 被测对象在 `@BeforeEach` 里手动 `new`：构造器签名一变就编译报错，比 `@InjectMocks` 的静默失败更可靠
- 金额用 `isEqualByComparingTo`：`BigDecimal` 的 `equals` 会比较精度，`59.80` 与 `59.8` 不相等

### 3、@InjectMocks 的规则

`@InjectMocks` 让 Mockito 自动创建被测对象并注入 `@Mock` / `@Spy` 字段，按顺序尝试三种方式：

| 顺序 | 方式 | 规则 |
|------|------|------|
| 1 | 构造器注入 | 选参数最多的构造器，按类型匹配 Mock；**找不到匹配的参数时传 `null`** |
| 2 | Setter 注入 | 只在使用无参构造器时尝试，按类型、再按名称匹配 |
| 3 | 字段注入 | 同上，直接写字段 |

注入失败不会报错，只会留下 `null`，等到运行时才 NPE。所以它适合依赖少、全是接口的简单类：

```java
@ExtendWith(MockitoExtension.class)
class OrderQueryServiceTest {

    @Mock
    OrderRepository repository;

    @InjectMocks
    OrderQueryService queryService;   // 通过构造器把上面的 Mock 注入进去

    @Test
    void throwsWhenMissing() {
        when(repository.findById(404L)).thenReturn(Optional.empty());

        assertThatThrownBy(() -> queryService.statusOf(404L))
                .isInstanceOf(OrderNotFoundException.class);
    }
}
```

`OrderService` 这种还依赖 `Clock` 的类就不适合：没有 `Clock` 类型的 Mock，构造器会收到 `null`。

---

## 三、打桩

### 1、常用写法

| 写法 | 作用 |
|------|------|
| `when(x.m()).thenReturn(v)` | 返回固定值；`thenReturn(a, b)` 或链式 `.thenReturn(a).thenReturn(b)` 依次返回，最后一个值重复 |
| `when(x.m()).thenThrow(e)` | 抛出异常，测异常分支 |
| `when(x.m()).thenAnswer(inv -> ...)` | 根据入参动态计算返回值 |
| `doReturn / doThrow / doAnswer / doNothing().when(x).m()` | 用于 `void` 方法、Spy，以及覆盖已有的桩 |
| 不打桩 | 返回「空值」：`null`、`0`、`false`、空集合、空 `Optional`、空 `Stream` |

异常分支与 `void` 方法：

```java
@Test
void gatewayTimeoutPropagates() {
    saveAssignsId(1001L);
    when(paymentClient.charge(anyLong(), any()))
            .thenThrow(new IllegalStateException("支付网关超时"));

    assertThatThrownBy(() -> service.place(command()))
            .isInstanceOf(IllegalStateException.class)
            .hasMessage("支付网关超时");
    verify(publisher, never()).publish(any());
}

@Test
void publishFailureAfterCharge() {
    saveAssignsId(1001L);
    when(paymentClient.charge(anyLong(), any())).thenReturn(new PaymentResult("pay-1", true));
    doThrow(new IllegalStateException("MQ 不可用")).when(publisher).publish(any());

    assertThatThrownBy(() -> service.place(command())).hasMessage("MQ 不可用");
}
```

第二个测试把一个真实问题暴露了出来：钱已经扣了，事件却没发出去，订单状态也没保存。Mock 让这种「中途失败」的场景很容易构造，至于怎么修（本地事务 + Outbox、补偿）是设计问题，见 [分布式事务](/distributed/4_transaction)。

### 2、BDDMockito

BDDMockito 只是换了一套和 given / when / then 结构对应的方法名，功能完全相同。Spring 官方示例和 [Spring Boot 测试](/spring-boot/13_testing) 一篇都用这种风格：

```java
import static org.mockito.BDDMockito.given;
import static org.mockito.BDDMockito.then;
import static org.mockito.BDDMockito.willAnswer;

@Test
void paidOrderPublishesEvent() {
    // given
    willAnswer(invocation -> {
        Order order = invocation.getArgument(0);
        order.assignId(1001L);
        return order;
    }).given(repository).save(any(Order.class));
    given(paymentClient.charge(anyLong(), any())).willReturn(new PaymentResult("pay-1", true));

    // when
    Order order = service.place(command());

    // then
    assertThat(order.getStatus()).isEqualTo(OrderStatus.PAID);
    then(publisher).should().publish(any(OrderPaidEvent.class));
}
```

| Mockito | BDDMockito |
|---------|------------|
| `when(x.m()).thenReturn(v)` | `given(x.m()).willReturn(v)` |
| `doThrow(e).when(x).m()` | `willThrow(e).given(x).m()` |
| `verify(x, times(2)).m()` | `then(x).should(times(2)).m()` |
| `verifyNoMoreInteractions(x)` | `then(x).shouldHaveNoMoreInteractions()` |

团队选一种统一即可，不要在同一个测试类里混用。

---

## 四、参数匹配与捕获

### 1、匹配器规则

- 一个调用里**要么全用匹配器，要么全用具体值**。`charge(1001L, any())` 会抛 `InvalidUseOfMatchersException`，要写成 `charge(eq(1001L), any())`
- `any()` 匹配任何值包括 `null`；`any(BigDecimal.class)` 不匹配 `null`，并且检查类型
- 基本类型用 `anyLong()`、`anyInt()`，`any()` 在基本类型参数上会因拆箱 `null` 而 NPE
- 匹配器只能在打桩和 `verify` 里用，不能存到变量里复用，也不能当作普通返回值

自定义条件用 `argThat`。金额要按数值比较，不能用 `eq(new BigDecimal("59.80"))`：

```java
verify(paymentClient).charge(eq(1001L), argThat(amount -> amount.compareTo(new BigDecimal("59.80")) == 0));
```

### 2、ArgumentCaptor 与 assertArg

被测方法内部 `new` 出来的对象（事件、实体、请求体）无法在测试里事先构造，就用 `ArgumentCaptor` 把实参捕获出来再断言，见第二节的 `eventCaptor`。几条用法：

- 用 `@Captor` 字段声明，泛型类型（如 `ArgumentCaptor<List<OrderItem>>`）不会有未检查转换警告
- 多次调用时用 `getAllValues()` 拿全部实参，`getValue()` 只返回最后一次
- 只在 `verify` 里捕获，**不要在打桩时用 `capture()`**：桩命中与否和断言混在一起，失败信息难以理解

Mockito 5.3 起还可以用 `assertArg` 在验证时直接对实参做断言，省掉 Captor 字段：

```java
verify(publisher).publish(assertArg(event -> {
    assertThat(event.orderId()).isEqualTo(1004L);
    assertThat(event.amount()).isEqualByComparingTo("59.80");
}));
```

只断言一次调用时 `assertArg` 更简洁；要比较多次调用的实参顺序时用 `ArgumentCaptor`。

---

## 五、验证交互

| 写法 | 含义 |
|------|------|
| `verify(x).m()` | 恰好调用 1 次，等价 `times(1)` |
| `verify(x, times(2)).m()` | 恰好 2 次 |
| `verify(x, never()).m()` | 从未调用 |
| `verify(x, atLeastOnce()).m()` / `atMost(n)` | 至少 / 至多 |
| `verifyNoInteractions(x, y)` | 这些 Mock 上没有发生任何调用 |
| `verifyNoMoreInteractions(x)` | 除已验证的调用外没有别的调用 |
| `inOrder(x, y).verify(...)` | 按顺序验证 |

```java
@Test
void failedPaymentDoesNotPublish() {
    saveAssignsId(1002L);
    when(paymentClient.charge(anyLong(), any())).thenReturn(new PaymentResult(null, false));

    Order order = service.place(command());

    assertThat(order.getStatus()).isEqualTo(OrderStatus.PAYMENT_FAILED);
    verify(publisher, never()).publish(any());
    verify(repository, times(2)).save(any(Order.class));
}

@Test
void emptyItemsRejectedBeforeAnyCall() {
    assertThatThrownBy(() -> service.place(new CreateOrderCommand("u1", List.of())))
            .isInstanceOf(IllegalArgumentException.class);

    verifyNoInteractions(repository, paymentClient, publisher);
}

@Test
void chargeHappensAfterFirstSaveAndBeforeEvent() {
    saveAssignsId(1003L);
    when(paymentClient.charge(anyLong(), any())).thenReturn(new PaymentResult("pay-3", true));

    service.place(command());

    InOrder inOrder = inOrder(repository, paymentClient, publisher);
    inOrder.verify(repository).save(any(Order.class));
    inOrder.verify(paymentClient).charge(eq(1003L), any());
    inOrder.verify(publisher).publish(any());
    inOrder.verify(repository).save(any(Order.class));
}
```

验证要克制：

- `never()` 和 `verifyNoInteractions` 适合守住「失败时不能产生副作用」这类业务规则，价值很高
- `inOrder` 只在顺序本身有业务含义时用（先落库拿到订单号才能扣款）
- `verifyNoMoreInteractions` 不要在每个测试末尾例行调用，它会让任何新增的无害调用都打破测试，Mockito 官方文档也明确不推荐这样用
- `verify(repository, times(2)).save(...)` 这类断言已经接近实现细节；能用 Fake 仓储查最终状态时，优先查状态（第八节）

---

## 六、严格桩

`MockitoExtension` 默认使用 `Strictness.STRICT_STUBS`，会把两类问题直接变成测试失败：

| 异常 | 触发条件 | 通常说明 |
|------|----------|----------|
| `UnnecessaryStubbingException` | 打了桩但整个测试都没用上 | 桩是从别的测试复制过来的死代码，或者被测代码已经不走这条路 |
| `PotentialStubbingProblem` | 打桩的参数和实际调用的参数对不上 | 被测代码传错了参数，或测试数据写错，例如桩写 `findById(1001L)` 而实际调用 `findById(1002L)` |

没有严格桩时，参数不匹配的调用会静默返回 `null` / 空值，测试要么莫名 NPE，要么带着错误的前提通过。严格桩让失败信息直接指向桩和调用的位置。

确实需要宽松的地方显式声明，范围越小越好：

```java
@BeforeEach
void setUp() {
    service = new OrderService(repository, paymentClient, publisher, Clock.systemUTC());
    // 公共桩：校验失败的测试不会调用 save，标记为 lenient 避免误报
    lenient().when(repository.save(any(Order.class))).thenAnswer(invocation -> {
        Order order = invocation.getArgument(0);
        order.assignId(1001L);
        return order;
    });
}
```

| 范围 | 写法 |
|------|------|
| 单个桩 | `lenient().when(...)` |
| 单个 Mock | `@Mock(strictness = Mock.Strictness.LENIENT)` |
| 整个测试类 | `@MockitoSettings(strictness = Strictness.LENIENT)` |

把整个类降级为 `LENIENT` 等于关掉了这道检查，一般只在迁移老测试时临时使用。

---

## 七、Spy：部分 Mock

`spy(realObject)` 包住一个真实对象：没打桩的方法走真实逻辑，打了桩的方法返回预设值，同时记录所有调用。

最常见的坑是对 Spy 用 `when(...)`：`when(spy.m())` 会**先真实执行一次** `spy.m()`，真实方法有副作用或会抛异常时就出问题。对 Spy 打桩一律用 `doReturn`：

```java
@Test
void whenOnSpyCallsRealMethod() {
    List<String> skus = spy(new ArrayList<>());

    // when(...) 会先真实调用一次 skus.get(0)，空列表直接抛异常
    assertThatThrownBy(() -> when(skus.get(0)).thenReturn("sku-1"))
            .isInstanceOf(IndexOutOfBoundsException.class);
}

@Test
void doReturnDoesNotCallRealMethod() {
    List<String> skus = spy(new ArrayList<>());

    doReturn("sku-1").when(skus).get(0);   // 不触发真实调用
    skus.add("sku-2");                    // 其余方法仍走真实实现

    assertThat(skus.get(0)).isEqualTo("sku-1");
    assertThat(skus).hasSize(1);
    verify(skus).add("sku-2");
}
```

其他注意点：

- `spy()` 会**复制**传入对象的字段生成新实例，之后对原对象的修改不会反映到 Spy 上，测试里只使用 Spy 引用
- 想对被测类本身打 Spy（让它调用自己的另一个方法时返回假值），说明这个类职责过多，应该把那部分逻辑拆成独立的协作者
- Spy 适合包装难以构造的遗留对象，或者验证「真实逻辑跑完后调用了什么」；新代码很少需要它

---

## 八、Fake 与「什么时候不要 Mock」

### 1、判断流程

![Mock 决策流程](../assets/testing/mock-decision.svg)

Mock 的本质是把测试和「依赖如何被调用」绑定在一起。依赖越稳定、越容易构造，Mock 的收益越低、维护成本越高。

### 2、不要 Mock 的东西

- **值对象和数据载体**：`OrderItem`、`Money`、`LocalDate`、DTO、record。直接 `new` 一个真实值，Mock 它们只会让测试更长、更脆
- **自己写的简单协作者**：纯计算、无 I/O 的类（价格计算器、校验器、映射器）一起参与测试即可。按「类」为单位隔离并不是单元测试的要求，单元指的是一个**行为**
- **不属于你的类型**：`RestClient`、`JdbcTemplate`、`KafkaTemplate`、第三方 SDK。Mock 它们等于在测试里重新猜一遍别人的 API 行为，猜错了测试照样绿。正确做法是在边界上包一层自己的接口（如 `PaymentClient`），业务测试 Mock 这个接口，接口的实现用 WireMock 或 Testcontainers 做集成测试
- **时间、随机数、UUID**：注入 `Clock`、`Supplier<UUID>` 或 `RandomGenerator`，测试里传固定值的真实实现

### 3、仓储优先用 Fake

仓储被 Mock 时，测试要么写一堆 `when(repository.findById(...))`，要么 `verify(repository).save(...)`；被测代码多查一次、少存一次，测试就要跟着改。换成内存实现后，测试只关心最终状态：

```java
public class InMemoryOrderRepository implements OrderRepository {

    private final Map<Long, Order> store = new ConcurrentHashMap<>();
    private final AtomicLong sequence = new AtomicLong(1000);

    @Override
    public Order save(Order order) {
        if (order.getId() == null) {
            order.assignId(sequence.incrementAndGet());
        }
        store.put(order.getId(), order);
        return order;
    }

    @Override
    public Optional<Order> findById(long id) {
        return Optional.ofNullable(store.get(id));
    }
}
```

```java
class OrderServiceFakeTest {

    private final InMemoryOrderRepository repository = new InMemoryOrderRepository();
    private final List<OrderPaidEvent> published = new ArrayList<>();
    private final PaymentClient alwaysSuccess = (orderId, amount) -> new PaymentResult("pay-" + orderId, true);

    private final OrderService service =
            new OrderService(repository, alwaysSuccess, published::add, Clock.systemUTC());

    @Test
    void paidOrderIsPersisted() {
        Order order = service.place(new CreateOrderCommand("u1",
                List.of(new OrderItem("sku-1", 2, new BigDecimal("29.90")))));

        assertThat(repository.findById(order.getId()))
                .hasValueSatisfying(saved -> assertThat(saved.getStatus()).isEqualTo(OrderStatus.PAID));
        assertThat(published).singleElement()
                .satisfies(event -> assertThat(event.amount()).isEqualByComparingTo("59.80"));
    }
}
```

这个测试一个 Mockito 调用都没有：单方法接口直接用 lambda 和方法引用当 Stub / 记录器，比 Mock 更短也更好读。

Fake 的前提是它的行为和真实实现一致。Fake 放在测试源码里与生产代码一起维护，真实的 JPA / JDBC 实现另用 [`@DataJpaTest`](/spring-boot/13_testing) + [Testcontainers](./5_testcontainers) 测，两边各管一半。

### 4、过度 Mock 的信号

| 信号 | 说明 |
|------|------|
| 一个测试里 `when` 超过五六个 | 被测类依赖太多，考虑拆分 |
| 测试比被测代码长好几倍，全是打桩 | 测的是调用顺序，不是行为 |
| Mock 返回 Mock（`when(a.getB()).thenReturn(b)`） | 违反迪米特法则，被测代码在「穿透」对象图 |
| 重构不改行为，测试却大面积变红 | 测试绑定在实现细节上 |
| 所有测试都绿，上线后集成出错 | Mock 的行为和真实依赖不一致，缺少集成测试兜底 |

---

## 九、静态方法、构造器与 final 类

inline mock maker 让 Mockito 能够 Mock 静态方法和构造过程。能做到不等于应该做：需要它们，基本都说明依赖没有被注入，而是写死在代码里。

### 1、mockStatic

被测代码直接调用静态工厂：

```java
public final class OrderNumbers {

    private OrderNumbers() {
    }

    public static String next() {
        return "ORD-" + UUID.randomUUID();
    }
}

public class InvoiceService {

    public String newInvoiceNo() {
        return "INV-" + OrderNumbers.next();   // 静态调用写死在方法里
    }
}
```

```java
@Test
void mockStaticFactory() {
    try (MockedStatic<OrderNumbers> mocked = mockStatic(OrderNumbers.class)) {
        mocked.when(OrderNumbers::next).thenReturn("ORD-TEST-1");

        assertThat(new InvoiceService().newInvoiceNo()).isEqualTo("INV-ORD-TEST-1");
        mocked.verify(OrderNumbers::next);
    }
    // 离开 try 块后恢复真实实现
    assertThat(OrderNumbers.next()).startsWith("ORD-").isNotEqualTo("ORD-TEST-1");
}
```

规则：

- **必须用 try-with-resources**（或手动 `close()`）。静态 Mock 不关闭会一直生效，污染同一线程上后续运行的测试
- 只在**当前线程**生效。被测代码把调用丢到线程池或 `CompletableFuture` 里时，那边看到的仍是真实实现
- 同一个类在同一线程上不能同时注册两次静态 Mock
- 不要 Mock `java.lang`、`java.time` 等 JDK 核心类的静态方法（如 `LocalDateTime.now()`），这类场景应注入 `Clock`

重构后完全不需要 `mockStatic`：

```java
public class InvoiceService {

    private final Supplier<String> orderNumbers;

    public InvoiceService(Supplier<String> orderNumbers) {   // 生产传 OrderNumbers::next
        this.orderNumbers = orderNumbers;
    }

    public String newInvoiceNo() {
        return "INV-" + orderNumbers.get();
    }
}

// 测试：new InvoiceService(() -> "ORD-TEST-1")
```

### 2、mockConstruction

依赖在方法内部 `new` 出来，外部无法替换：

```java
public class RefundHttpClient {

    private final String baseUrl;

    public RefundHttpClient(String baseUrl) {
        this.baseUrl = baseUrl;
    }

    public int post(String paymentId) {
        throw new UnsupportedOperationException("真实网络调用：" + baseUrl);
    }
}

public class LegacyRefundService {

    public boolean refund(String paymentId) {
        RefundHttpClient client = new RefundHttpClient("https://pay.example.com");   // 在方法里 new 依赖
        return client.post(paymentId) == 200;
    }
}
```

```java
@Test
void mockConstructedClient() {
    try (MockedConstruction<RefundHttpClient> mocked = mockConstruction(RefundHttpClient.class,
            (mock, context) -> {
                assertThat(context.arguments().get(0)).isEqualTo("https://pay.example.com");
                when(mock.post("pay-1")).thenReturn(200);
            })) {

        assertThat(new LegacyRefundService().refund("pay-1")).isTrue();

        assertThat(mocked.constructed()).hasSize(1);
        verify(mocked.constructed().get(0)).post("pay-1");
    }
}
```

作用域内每次 `new RefundHttpClient(...)` 都会得到一个 Mock，初始化回调里可以读构造参数、给新 Mock 打桩；同样只对当前线程、只在 try 块内生效。

### 3、为什么是坏味道

| 手段 | 暴露的问题 | 正确的改法 |
|------|------------|------------|
| `mockStatic` | 依赖通过静态方法隐式获取，调用方无法替换 | 把静态调用包成接口或 `Supplier` / `Function` 注入 |
| `mockConstruction` | 依赖在方法内部创建，生命周期和配置写死 | 构造器注入依赖或注入工厂 |
| Mock `final` 第三方类 | 业务代码直接依赖第三方 SDK | 包一层自己的接口（防腐层） |

`mockStatic` / `mockConstruction` 的合理用途是**给遗留代码加护栏**：先用它们写测试把现有行为锁住，然后重构成可注入的结构，最后删掉这些测试里的静态 / 构造 Mock。

### 4、final 类

Mockito 5 默认就能 Mock `final` 类和方法，Kotlin 的类默认都是 `final`，这一点对 Kotlin 项目尤其有用：

```java
class FinalClassTest {

    static final class SmsSdk {                 // 模拟第三方 SDK 里的 final 类
        String send(String phone, String text) {
            throw new IllegalStateException("真实发送");
        }
    }

    @Test
    void mockFinalClass() {
        SmsSdk sdk = mock();                    // 4.10+：类型从变量声明推断
        when(sdk.send("13800000000", "已支付")).thenReturn("msg-1");

        assertThat(sdk.send("13800000000", "已支付")).isEqualTo("msg-1");
    }
}
```

技术上可行，但上面「不要 Mock 不属于你的类型」的原则依然适用：业务代码应该依赖自己的 `SmsSender` 接口，SDK 只出现在接口实现里。

---

## 十、JDK 21+：显式挂载 Mockito agent

### 1、为什么会有警告

inline mock maker 需要一个 Java agent 来改写字节码。Mockito 默认在运行时把 Byte Buddy agent 动态附加到当前 JVM。JDK 21 的 [JEP 451](https://openjdk.org/jeps/451) 开始对「运行时动态加载 agent」打印警告，并计划在未来版本默认禁止。于是在 JDK 21+ 上跑测试时会看到两类输出：

- JVM 的警告：提示有 agent 被动态加载，未来版本将默认禁止
- Mockito 自己的提示：说明它正在自附加（self-attaching），未来 JDK 上将失效，建议按文档把 Mockito 配置成 agent

现在测试仍然能通过，但应趁早改成启动时用 `-javaagent` 挂载。启动参数加载的 agent 不受 JEP 451 影响。

### 2、Maven

```xml
<properties>
    <!-- 没有 JaCoCo 等插件设置 argLine 时，给一个空值，避免 @{argLine} 无法替换 -->
    <argLine></argLine>
</properties>

<build>
    <plugins>
        <plugin>
            <groupId>org.apache.maven.plugins</groupId>
            <artifactId>maven-dependency-plugin</artifactId>
            <executions>
                <execution>
                    <goals>
                        <goal>properties</goal>
                    </goals>
                </execution>
            </executions>
        </plugin>
        <plugin>
            <groupId>org.apache.maven.plugins</groupId>
            <artifactId>maven-surefire-plugin</artifactId>
            <configuration>
                <argLine>@{argLine} -javaagent:${org.mockito:mockito-core:jar}</argLine>
            </configuration>
        </plugin>
    </plugins>
</build>
```

- `maven-dependency-plugin` 的 `properties` 目标会为每个依赖生成一个指向本地 jar 的属性，`${org.mockito:mockito-core:jar}` 就是 Mockito jar 的路径
- `@{argLine}` 是 Surefire 的延迟替换语法，用来保留 JaCoCo 等插件追加的参数。如果项目里没有任何插件设置 `argLine`，`@{argLine}` 会原样传给 JVM 导致启动失败，所以要像上面那样声明一个空的 `argLine` 属性
- 集成测试由 Failsafe 运行时，在 `maven-failsafe-plugin` 里做同样的配置
- Spring Boot 父 POM 已经管理了这两个插件的版本，不用写 `<version>`

### 3、Gradle（Kotlin DSL）

```kotlin
val mockitoAgent = configurations.create("mockitoAgent")

dependencies {
    testImplementation("org.mockito:mockito-core")
    mockitoAgent("org.mockito:mockito-core") { isTransitive = false }
}

tasks.test {
    jvmArgumentProviders.add(CommandLineArgumentProvider {
        listOf("-javaagent:${mockitoAgent.asPath}")
    })
}
```

不写版本号依赖 `io.spring.dependency-management` 插件为所有配置提供版本；如果用 Gradle 平台（`platform(...)`）管理版本，需要给 `mockitoAgent` 配置也加上同一个平台，或者写明版本，保证 agent 和测试类路径上的 Mockito 是同一个版本。

---

## 十一、外部 HTTP：WireMock

### 1、Mockito 和 WireMock 的分工

业务测试里 Mock 的是 `PaymentClient` 接口；但 `PaymentClient` 的 HTTP 实现本身也需要测：URL、请求头、JSON 字段名、超时、4xx / 5xx 的处理。这一层用 Mockito Mock `RestClient` 毫无意义，要用一个真实的 HTTP 服务端来顶替支付网关。

| 工具 | 层次 | 适用 |
|------|------|------|
| Mockito | 进程内对象 | 业务逻辑测试，Mock 自己的接口 |
| `MockRestServiceServer` | 拦截 Spring 的 `RestClient` / `RestTemplate` | 只测 Spring HTTP 客户端代码，不走真实网络，见 [Spring Boot 测试](/spring-boot/13_testing) 的 `@RestClientTest` |
| WireMock | 真实 HTTP 服务端（本地端口） | 与客户端实现无关，覆盖真实网络栈：序列化、超时、连接错误、延迟 |

### 2、被测适配器

```java
public class HttpPaymentClient implements PaymentClient {

    private final RestClient restClient;

    public HttpPaymentClient(RestClient.Builder builder, String baseUrl) {
        this.restClient = builder.baseUrl(baseUrl).build();
    }

    @Override
    public PaymentResult charge(long orderId, BigDecimal amount) {
        ChargeResponse response = restClient.post()
                .uri("/payments")
                .contentType(MediaType.APPLICATION_JSON)
                .body(new ChargeRequest(orderId, amount))
                .retrieve()
                .body(ChargeResponse.class);
        return new PaymentResult(response.paymentId(), "SUCCESS".equals(response.status()));
    }

    public record ChargeRequest(long orderId, BigDecimal amount) {
    }

    public record ChargeResponse(String paymentId, String status) {
    }
}
```

### 3、依赖

```xml
<dependency>
    <groupId>org.wiremock</groupId>
    <artifactId>wiremock-standalone</artifactId>
    <version>3.13.2</version>
    <scope>test</scope>
</dependency>
```

WireMock 3 的 groupId 是 `org.wiremock`（2.x 是 `com.github.tomakehurst`），要求 Java 11+，JUnit Jupiter 扩展 `WireMockExtension` / `@WireMockTest` 已包含在内。主构件 `wiremock` 依赖 Jetty 11，另有 `wiremock-jetty12` 变体；Spring Boot 4 通过依赖管理把 Jetty 统一到自己的版本，两者容易出现 Jetty 类版本不一致（`NoSuchMethodError`）。在 Boot 项目里推荐用 `wiremock-standalone`：它把 Jetty 等依赖打包并重定位到 WireMock 自己的包名下，不和应用的依赖冲突。

3.x 从 3.13.1 起进入维护模式，WireMock 团队的开发重心在 4.x（仍是 beta，默认 Jetty 12）。

### 4、测试

```java
import java.math.BigDecimal;
import java.net.http.HttpClient;
import java.time.Duration;

import com.github.tomakehurst.wiremock.junit5.WireMockExtension;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.RegisterExtension;
import org.springframework.http.client.JdkClientHttpRequestFactory;
import org.springframework.web.client.HttpServerErrorException;
import org.springframework.web.client.ResourceAccessException;
import org.springframework.web.client.RestClient;

import static com.github.tomakehurst.wiremock.client.WireMock.aResponse;
import static com.github.tomakehurst.wiremock.client.WireMock.containing;
import static com.github.tomakehurst.wiremock.client.WireMock.equalTo;
import static com.github.tomakehurst.wiremock.client.WireMock.equalToJson;
import static com.github.tomakehurst.wiremock.client.WireMock.matchingJsonPath;
import static com.github.tomakehurst.wiremock.client.WireMock.okJson;
import static com.github.tomakehurst.wiremock.client.WireMock.post;
import static com.github.tomakehurst.wiremock.client.WireMock.postRequestedFor;
import static com.github.tomakehurst.wiremock.client.WireMock.serviceUnavailable;
import static com.github.tomakehurst.wiremock.client.WireMock.urlEqualTo;
import static com.github.tomakehurst.wiremock.core.WireMockConfiguration.wireMockConfig;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class HttpPaymentClientTest {

    @RegisterExtension
    static WireMockExtension wm = WireMockExtension.newInstance()
            .options(wireMockConfig().dynamicPort())
            .build();

    private HttpPaymentClient client;

    @BeforeEach
    void setUp() {
        // 本地明文 HTTP 上固定 HTTP/1.1，避免 JDK HttpClient 发起 h2c 升级
        var httpClient = HttpClient.newBuilder().version(HttpClient.Version.HTTP_1_1).build();
        var requestFactory = new JdkClientHttpRequestFactory(httpClient);
        requestFactory.setReadTimeout(Duration.ofMillis(500));
        client = new HttpPaymentClient(RestClient.builder().requestFactory(requestFactory), wm.baseUrl());
    }

    @Test
    void chargeSuccess() {
        wm.stubFor(post(urlEqualTo("/payments"))
                .withHeader("Content-Type", containing("application/json"))
                .withRequestBody(matchingJsonPath("$.orderId", equalTo("1001")))
                .willReturn(okJson("""
                        {"paymentId":"pay-1","status":"SUCCESS"}
                        """)));

        PaymentResult result = client.charge(1001L, new BigDecimal("59.80"));

        assertThat(result).isEqualTo(new PaymentResult("pay-1", true));
        wm.verify(1, postRequestedFor(urlEqualTo("/payments"))
                .withRequestBody(equalToJson("""
                        {"orderId": 1001, "amount": 59.80}
                        """)));
    }

    @Test
    void serverErrorSurfacesAsException() {
        wm.stubFor(post(urlEqualTo("/payments")).willReturn(serviceUnavailable()));

        assertThatThrownBy(() -> client.charge(1001L, new BigDecimal("59.80")))
                .isInstanceOf(HttpServerErrorException.class);
    }

    @Test
    void slowResponseTimesOut() {
        wm.stubFor(post(urlEqualTo("/payments"))
                .willReturn(aResponse().withFixedDelay(2_000).withStatus(200)));

        assertThatThrownBy(() -> client.charge(1001L, new BigDecimal("59.80")))
                .isInstanceOf(ResourceAccessException.class);
    }
}
```

要点：

- `dynamicPort()` 每次启动随机端口，避免 CI 上端口冲突；`static` 字段让整个测试类共用一个服务端，每个测试方法之间 WireMock 会自动清空桩和请求记录
- 匹配 JSON 金额时注意数值语义：`matchingJsonPath("$.amount", equalTo("59.80"))` 会失败，因为 JSONPath 取出的数值会被规范成 `59.8`；整体比较请求体用 `equalToJson`，按 JSON 语义比较
- 超时与 5xx 是 WireMock 相比 Mockito 最有价值的地方：`withFixedDelay` 模拟慢响应、`serviceUnavailable()` 模拟网关故障，`aResponse().withFault(Fault.CONNECTION_RESET_BY_PEER)` 还能模拟连接被重置。超时、重试该怎么配见 [超时、重试与隔离](/high-avail/4_timeout_retry_bulkhead)
- 测试用的 `HttpClient` 固定 HTTP/1.1：JDK `HttpClient` 默认尝试 HTTP/2，在明文 HTTP 上会发起 h2c 升级，带请求体的 POST 与 WireMock 3 的 Jetty 配合时可能出现连接被重置

### 5、在 Spring 测试中使用

在 `@SpringBootTest` 里，用 `@DynamicPropertySource` 把 `wm.baseUrl()` 写进支付网关地址属性即可，写法见 [Spring Boot 测试](/spring-boot/13_testing) 第二节的「测试专用属性」。WireMock 官方也提供 Spring Boot 集成（`org.wiremock.integrations:wiremock-spring-boot`，`@EnableWireMock` 自动启动服务端并注入属性），使用前在其发布说明里确认支持的 Boot 版本。

WireMock 只能证明「客户端按我理解的协议工作」。对方接口改了字段，WireMock 桩不会知道；服务双方都在团队内时，用 [契约测试](./6_contract_test) 让桩由提供方的契约生成。

---

## 十二、Spring 中的 Mock

Spring 上下文里替换 Bean 用 Spring Framework 的 `@MockitoBean` / `@MockitoSpyBean`（`org.springframework.test.context.bean.override.mockito` 包）。Spring Boot 的 `@MockBean` / `@SpyBean` 在 Boot 3.4 废弃、**Boot 4.0 已删除**，升级时改注解和 import 即可。

使用原则只有一条：**能不用就不用**。上面所有测试都没有启动 Spring，直接 `new` 被测对象并传入 `@Mock`，毫秒级完成。只有在切片测试（`@WebMvcTest` 里 Mock Controller 依赖的 Service）或必须启动上下文的集成测试里才用 `@MockitoBean`，而且它会参与上下文缓存键，Mock 组合不统一会让测试套件反复启动上下文。具体用法、共享 Mock 的组合注解、缓存问题都在 [Spring Boot 测试](/spring-boot/13_testing) 第三、四、八节，这里不重复。

Spring 上下文里的 `@MockitoBean`、切片测试和上下文缓存见 [Spring Boot 测试](/spring-boot/13_testing)，真实数据库与中间件的集成测试见 [集成测试](./3_integration_test) 和 [Testcontainers](./5_testcontainers)。

---

## 小结

- 测试替身分 Dummy / Stub / Spy / Mock / Fake；查询依赖打桩、断言状态，命令依赖才 `verify`
- Mockito 5 默认 inline mock maker，能 Mock `final` 类、静态方法和构造过程，`mockito-inline` 依赖可以删除；JDK 21+ 上用 `-javaagent` 显式挂载，避免依赖即将被禁止的动态附加
- `MockitoExtension` + `@Mock` + 手动构造被测对象是最稳的组合；`@InjectMocks` 注入失败会静默留下 `null`
- 匹配器全有或全无；被测代码内部创建的对象用 `ArgumentCaptor` 或 `assertArg` 断言；金额用 `compareTo` 语义比较
- 严格桩（默认开启）会把多余的桩和参数不匹配变成失败，需要宽松时用最小范围的 `lenient()`
- Spy 打桩用 `doReturn`；对被测类自身打 Spy 说明该拆类了
- 值对象、自己的简单协作者不 Mock；仓储优先用 Fake；第三方类型包一层自己的接口再 Mock
- `mockStatic` / `mockConstruction` 必须放在 try-with-resources 里，只对当前线程生效；它们是给遗留代码加护栏的工具，最终目标是重构成可注入
- 调用外部 HTTP 的适配器用 WireMock 3（Boot 项目选 `wiremock-standalone`）测序列化、超时和故障；Spring 上下文里的替身用 `@MockitoBean`，细节见 Spring Boot 测试

## 参考资料

- Mockito 类文档（各特性的权威说明，含 inline mock maker、静态与构造 Mock、Java 21+ agent 配置）：[Mockito Javadoc](https://javadoc.io/doc/org.mockito/mockito-core/latest/org/mockito/Mockito.html)
- Mockito 5 发布说明（默认 inline mock maker、最低 Java 11）：[Mockito v5.0.0 Release](https://github.com/mockito/mockito/releases/tag/v5.0.0)
- 严格桩：[Strictness Javadoc](https://javadoc.io/doc/org.mockito/mockito-core/latest/org/mockito/quality/Strictness.html)
- JUnit Jupiter 扩展：[MockitoExtension Javadoc](https://javadoc.io/doc/org.mockito/mockito-junit-jupiter/latest/org/mockito/junit/jupiter/MockitoExtension.html)
- 动态加载 agent 的限制：[JEP 451: Prepare to Disallow the Dynamic Loading of Agents](https://openjdk.org/jeps/451)
- 测试替身分类：[Martin Fowler - Mocks Aren't Stubs](https://martinfowler.com/articles/mocksArentStubs.html)
- WireMock JUnit Jupiter 集成：[WireMock JUnit 5+ Jupiter](https://wiremock.org/docs/junit-jupiter/)
- WireMock 请求匹配：[Request Matching](https://wiremock.org/docs/request-matching/)
- WireMock 故障与延迟模拟：[Simulating Faults](https://wiremock.org/docs/simulating-faults/)
- WireMock 与 Jetty 12：[Using WireMock with Jetty 12](https://wiremock.org/docs/jetty-12/)
- WireMock Spring Boot 集成：[WireMock Spring Boot Integration](https://wiremock.org/docs/spring-boot/)
- Spring Framework Bean 覆盖（`@MockitoBean`）：[Bean Overriding in Tests](https://docs.spring.io/spring-framework/reference/testing/testcontext-framework/bean-overriding.html)

> 下一篇：[集成测试](./3_integration_test)
