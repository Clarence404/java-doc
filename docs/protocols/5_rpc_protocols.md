---
description: RPC 组成要素、Protobuf 编码、gRPC 帧格式与四种调用、截止时间与状态码、Thrift、SOAP
---

# RPC 协议

> 前置阅读：[HTTP](./2_http)

RPC（Remote Procedure Call）让调用方通过桩（Stub）像调用本地方法一样调用远程服务。本篇讲 RPC 的组成、Protobuf 编码与 gRPC 帧格式、调用方式 / 截止时间 / 状态码 / 负载均衡等要点、Spring Boot 接入 gRPC，以及 Thrift、SOAP 的定位。

---

## 一、RPC 的组成

### 1、五个要素

| 要素 | 解决的问题 | 典型实现 |
|------|-----------|---------|
| 接口契约（IDL） | 双方对方法名、参数、返回值的约定，可生成多语言代码 | `.proto`、`.thrift`、WSDL、OpenAPI |
| 序列化 | 对象与字节之间的转换 | Protobuf、Thrift Compact、Hessian2、JSON、XML |
| 传输 | 字节怎么在网络上走、连接怎么复用 | HTTP/2、HTTP/1.1、自定义 TCP 帧 |
| 服务寻址 | 调用方怎么找到可用实例 | 注册中心、DNS、服务网格 |
| 错误与超时语义 | 失败怎么表达、能不能重试、等多久 | gRPC 状态码 + 截止时间、SOAP Fault |

自研 RPC 框架的帧设计（魔数、长度字段、请求 ID 匹配）见 [自定义私有协议](/netty/8_custom_protocol)。

### 2、常见协议对比

| 维度 | HTTP + JSON | gRPC | Dubbo 3 Triple | Thrift | SOAP |
|------|-------------|------|----------------|--------|------|
| 传输 | HTTP/1.1 或 HTTP/2 | HTTP/2 | HTTP/1.1、HTTP/2、HTTP/3 | 自带传输层（TCP 帧），也可走 HTTP | 通常是 HTTP |
| 序列化 | JSON | Protobuf（也可换 JSON） | Protobuf 或 Hessian2 | Binary / Compact / JSON | XML |
| 接口契约 | OpenAPI（可选） | `.proto` | `.proto` 或 Java 接口 | `.thrift` | WSDL |
| 流式 | 分块传输或 SSE | 服务端流、客户端流、双向流 | 服务端流、客户端流、双向流 | 不支持 | 不支持 |
| 浏览器直接调用 | 可以 | 不行，需 gRPC-Web 或转码 | 可以（HTTP 直接访问） | 不行 | 可以，但很少这么用 |
| 维护方 | IETF（HTTP） | CNCF 托管的开源项目 | Apache | Apache | W3C 标准 |

GraphQL 是一种查询语言而不是 RPC 协议，现由 Linux 基金会下的 GraphQL Foundation 维护，适合前端按需取字段的聚合查询，Spring 生态对应 Spring for GraphQL。

---

## 二、Protobuf

### 1、IDL 示例

```protobuf
// order.proto
syntax = "proto3";
package order;
option java_package = "com.example.grpc.order";
option java_multiple_files = true;

service OrderService {
  rpc GetOrder (GetOrderRequest) returns (OrderReply);                   // 一元调用
  rpc ListOrders (ListOrdersRequest) returns (stream OrderReply);        // 服务端流
  rpc UploadItems (stream OrderItem) returns (UploadSummary);            // 客户端流
  rpc Track (stream TrackRequest) returns (stream TrackEvent);           // 双向流
}

enum OrderStatus {
  ORDER_STATUS_UNSPECIFIED = 0;   // proto3 枚举第一个值必须为 0，留作「未设置」
  ORDER_STATUS_CREATED = 1;
  ORDER_STATUS_PAID = 2;
}

message GetOrderRequest { string order_id = 1; }

message OrderReply {
  string order_id = 1;
  OrderStatus status = 2;
  int64 amount_cents = 3;          // 金额用最小货币单位的整数，不用 double
  repeated OrderItem items = 4;
  reserved 5;                      // 删除过的字段编号保留，防止被复用
}

message OrderItem {
  string product_id = 1;
  int32 quantity = 2;
  int64 price_cents = 3;
}

message ListOrdersRequest { string user_id = 1; int32 page_size = 2; }
message UploadSummary { int32 accepted = 1; }
message TrackRequest { string order_id = 1; }
message TrackEvent { string order_id = 1; OrderStatus status = 2; int64 at_epoch_ms = 3; }
```

金额也可以用 `google.type.Money`（单位 + 纳单位）或字符串十进制，关键是不能用浮点数。

### 2、编码规则

Protobuf 不写字段名，只写「字段编号 + 线类型 + 值」，所以体积小：

- **Tag**：`(字段编号 << 3) | 线类型`，本身用 varint 编码
- **线类型**：0 是 VARINT（int32、int64、bool、enum），1 是 I64（fixed64、double），2 是 LEN（string、bytes、嵌套消息、packed repeated），5 是 I32（fixed32、float）；3、4 是已废弃的 group
- **varint**：每字节低 7 位存数据，最高位为 1 表示后面还有字节；小数字只占 1 字节
- **负数**：`int32` / `int64` 的负数固定占 10 字节，经常为负的字段用 `sint32` / `sint64`，它们先做 ZigZag 编码再写 varint

官方文档里的例子：字段 1 为 `int32`，值 150，编码结果是 3 个字节。

```text
08 96 01
08        tag：字段 1，线类型 0（1 << 3 | 0 = 8）
96 01     varint：0x96 去掉最高位得 0010110，0x01 得 0000001，小端拼接为 10010110 = 150
```

字符串字段 2 值为 `testing`，编码为 `12 07 74 65 73 74 69 6e 67`：`12` 是 tag（2 << 3 | 2），`07` 是长度，后面是 UTF-8 字节。

### 3、兼容性规则

| 改动 | 是否兼容 | 说明 |
|------|---------|------|
| 新增字段 | 兼容 | 旧代码遇到不认识的编号会跳过（并保留为未知字段） |
| 删除字段 | 兼容 | 必须用 `reserved` 保留编号和名字，避免以后被复用 |
| 修改字段编号 | 不兼容 | 编号就是线上的身份 |
| 修改字段类型 | 大多不兼容 | 只有少数同线类型之间可互转（如 int32 与 int64），仍可能截断 |
| 修改字段名 | 二进制兼容 | 但会破坏 JSON 映射和按名字反射的代码 |

proto3 的标量字段默认没有「是否设置」的概念，0 和未设置无法区分；需要区分时给字段加 `optional`，或用 wrapper 类型。

### 4、与 JSON 对比

| 对比 | JSON | Protobuf |
|------|------|---------|
| 格式 | 文本，人可读 | 二进制，需要 `.proto` 才能解读 |
| 体积 | 每条记录重复字段名 | 只写编号，通常明显更小 |
| 编解码 | 需要解析文本、处理转义 | 按 tag 顺序读，通常更快 |
| 契约 | 靠文档或 JSON Schema 约束 | 强类型，编译期生成代码 |
| 调试 | curl、浏览器直接看 | 需要 grpcurl、protoc `--decode` 等工具 |

具体快多少、小多少取决于数据形态，以自己的压测为准，基准测试方法见 [基准测试（JMH）](/high-perf/4_benchmark)。

---

## 三、gRPC 线上格式

### 1、一次调用的帧序列

![gRPC 一元调用在 HTTP/2 上的帧序列](../assets/protocols/grpc-http2-frames.svg)

一次 gRPC 调用就是 HTTP/2 上的一个流（Stream），按官方 PROTOCOL-HTTP2 规范：

- **请求头**：`:method POST`，`:path /包名.服务名/方法名`，`content-type: application/grpc`（可带 `+proto` 后缀），`te: trailers`；设置了截止时间时带 `grpc-timeout`，值是正整数加单位（`H` `M` `S` `m` `u` `n`），如 `800m` 表示 800 毫秒
- **消息**：放在 DATA 帧里，每条消息前有 5 字节前缀，1 字节压缩标志 + 4 字节大端长度；一条消息可以跨多个 DATA 帧，一个 DATA 帧也可以装多条消息
- **响应**：先回响应头（`:status 200`），再回若干条消息，最后用 Trailers 带上 `grpc-status` 和 `grpc-message`
- **立即失败**：服务端可以只回一个 Trailers-Only 响应（HTTP 状态、content-type、`grpc-status` 一次发完）

HTTP 状态码恒为 200，调用成败只看 `grpc-status`。这也是普通 HTTP 网关、只看状态码的监控对 gRPC 失效的原因。

### 2、四种调用方式

| 方式 | proto 写法 | 帧上的表现 | 适合场景 |
|------|-----------|-----------|---------|
| 一元调用 | `rpc A (Req) returns (Resp)` | 一条请求消息，一条响应消息 | 绝大多数接口 |
| 服务端流 | `returns (stream Resp)` | 一条请求，响应 DATA 帧持续到达 | 分批返回大结果集、订阅推送 |
| 客户端流 | `rpc A (stream Req)` | 请求 DATA 帧持续发送，最后一条响应 | 批量上传、日志上报 |
| 双向流 | 两侧都是 `stream` | 双方各自独立地读写同一个流 | 实时同步、聊天、在线状态跟踪 |

流式调用依赖 HTTP/2 流的全双工特性，消息顺序在单个流内有保证，跨流没有顺序保证。

### 3、截止时间与取消

- **用截止时间而不是超时**：客户端设置一个绝对时刻，gRPC 发送时换算成剩余时长写进 `grpc-timeout`，不受两端时钟不一致影响
- **自动传播**：官方 Deadlines 指南说明 Java 与 Go 默认把服务端收到的截止时间传给它在同一上下文里发起的下游调用，整条链路共享一个总预算；C++ 需要显式开启
- **超时即取消**：截止时间到了客户端收到 `DEADLINE_EXCEEDED`，同时向服务端发 `RST_STREAM`；服务端应检查 `Context.current().isCancelled()`，尽早停止无用的计算
- **不设截止时间等于无限等待**：每个调用都要设，取值依据下游 P99 延迟和上游给的总预算

### 4、状态码

gRPC 共 17 个状态码（0–16），常用的几个：

| 状态码 | 编号 | 含义 | 客户端怎么处理 |
|--------|------|------|---------------|
| `OK` | 0 | 成功 | — |
| `CANCELLED` | 1 | 调用方取消 | 通常不重试 |
| `INVALID_ARGUMENT` | 3 | 参数不合法，与系统状态无关 | 不重试，修参数 |
| `DEADLINE_EXCEEDED` | 4 | 截止时间到了，服务端可能已经执行成功 | 只有幂等操作才能重试 |
| `NOT_FOUND` | 5 | 资源不存在 | 不重试 |
| `ALREADY_EXISTS` | 6 | 要创建的资源已存在 | 按业务处理 |
| `PERMISSION_DENIED` | 7 | 已认证但无权限 | 不重试 |
| `RESOURCE_EXHAUSTED` | 8 | 限流、配额用完、消息过大 | 退避后重试 |
| `FAILED_PRECONDITION` | 9 | 系统状态不满足（如订单已关闭） | 不重试，先修状态 |
| `UNIMPLEMENTED` | 12 | 方法不存在 | 检查两端版本 |
| `INTERNAL` | 13 | 服务端内部错误 | 记录并告警 |
| `UNAVAILABLE` | 14 | 服务暂不可用、连接断开 | 退避后重试（最典型的可重试错误） |
| `UNAUTHENTICATED` | 16 | 没有有效凭证 | 刷新凭证 |

业务错误优先映射到这些标准状态码，需要更多细节时用 `google.rpc.Status` 的 details 携带结构化信息，不要全都塞进 `INTERNAL` 或 `UNKNOWN`。

### 5、元数据、拦截器、健康检查与反射

- **元数据**：就是 HTTP/2 头部，用来传 trace ID、租户、令牌；键名以 `-bin` 结尾的值会按二进制做 base64 传输
- **拦截器**：`ClientInterceptor` / `ServerInterceptor`，用于统一做鉴权、日志、指标、链路追踪，相当于 HTTP 世界的过滤器
- **健康检查**：标准服务 `grpc.health.v1.Health`，Kubernetes 的 `grpc` 类型探针（1.24 起默认开启，1.27 GA）可以直接探测它
- **反射**：服务端开启反射服务后，`grpcurl` 不需要 `.proto` 文件也能列出服务并调用，适合测试环境

### 6、长连接与负载均衡

HTTP/2 让所有调用复用少量长连接，这对四层负载均衡是个坑：

- **问题**：L4 负载均衡（如 Kubernetes Service 的默认 ClusterIP）只在建连时选一次后端，之后同一条连接上的所有请求都打到同一个 Pod，扩容后新 Pod 也分不到流量
- **方案一，客户端负载均衡**：用 `dns:///` 解析出全部实例地址（配合 Headless Service），再选 `round_robin` 策略，客户端对每个实例各建一条连接
- **方案二，L7 代理**：Envoy、Nginx（`grpc_pass`）或服务网格按请求分发，见 [服务网格](/microservices/3_service_mesh)
- **连接存活**：客户端 `keepAliveTime` 定期发 HTTP/2 PING，防止中间设备悄悄断开空闲连接；服务端要用 `permitKeepAliveTime` 放行，否则过于频繁的 PING 会被服务端以 `GOAWAY` 断开

### 7、浏览器访问

浏览器拿不到 HTTP/2 帧和 Trailers，不能直接发 gRPC 请求，三种办法：

| 方案 | 做法 |
|------|------|
| gRPC-Web | 浏览器发 gRPC-Web 格式，由 Envoy 等代理转成标准 gRPC |
| Connect 协议 | Buf 推出的兼容协议，同一服务可同时接受 gRPC、gRPC-Web 和普通 HTTP + JSON 请求 |
| HTTP/JSON 转码 | 在 proto 上用 `google.api.http` 注解声明 REST 路径，由网关转成 gRPC 调用 |

---

## 四、Spring Boot 接入 gRPC

### 1、选哪个 starter

| 场景 | 选择 |
|------|------|
| Spring Boot 4.1 及以上 | Boot 自带 gRPC 支持：`spring-boot-starter-grpc-server` / `spring-boot-starter-grpc-client`，版本由 Boot 管理 |
| Spring Boot 4.0 | Spring gRPC 1.0（`org.springframework.grpc`），2025 年 12 月 GA |
| Spring Boot 3.x 存量项目 | 社区项目 `net.devh:grpc-spring-boot-starter` |

代码生成需要 protobuf 构建插件，在 Spring Initializr 勾选 gRPC 会自动配好。

### 2、服务端

```yaml
spring:
  grpc:
    server:
      port: 9090             # 默认就是 9090
```

```java
// import 省略；OrderReply、OrderServiceGrpc 等由 order.proto 生成
record Order(String id, OrderStatus status, long amountCents) {}

interface OrderRepository {
    Optional<Order> findById(String id);
    List<Order> findByUserId(String userId);
}

@GrpcService
public class OrderGrpcService extends OrderServiceGrpc.OrderServiceImplBase {

    private final OrderRepository orders;

    public OrderGrpcService(OrderRepository orders) {
        this.orders = orders;
    }

    @Override
    public void getOrder(GetOrderRequest request, StreamObserver<OrderReply> observer) {
        orders.findById(request.getOrderId()).ifPresentOrElse(order -> {
            observer.onNext(toReply(order));
            observer.onCompleted();
        }, () -> observer.onError(Status.NOT_FOUND
                .withDescription("order not found: " + request.getOrderId())
                .asRuntimeException()));
    }

    @Override
    public void listOrders(ListOrdersRequest request, StreamObserver<OrderReply> observer) {
        // 服务端流：一条条推给客户端，最后 onCompleted
        orders.findByUserId(request.getUserId()).forEach(o -> observer.onNext(toReply(o)));
        observer.onCompleted();
    }

    private static OrderReply toReply(Order o) {
        return OrderReply.newBuilder()
                .setOrderId(o.id())
                .setStatus(o.status())
                .setAmountCents(o.amountCents())
                .build();
    }
}
```

`onError` 必须传 `StatusRuntimeException`（由 `Status` 构造），直接抛普通异常客户端只会收到 `UNKNOWN`。

### 3、客户端

```yaml
spring:
  grpc:
    client:
      channel:
        order:
          target: static://order-service:9090   # 生产环境配 ssl.bundle 走 TLS
```

```java
// import 省略
@SpringBootApplication(proxyBeanMethods = false)
@ImportGrpcClients(target = "order", types = OrderServiceGrpc.OrderServiceBlockingStub.class)
public class App {
    public static void main(String[] args) {
        SpringApplication.run(App.class, args);
    }
}

@Service
class OrderQueryService {

    private final OrderServiceGrpc.OrderServiceBlockingStub stub;

    OrderQueryService(OrderServiceGrpc.OrderServiceBlockingStub stub) {
        this.stub = stub;
    }

    Optional<OrderReply> find(String orderId) {
        try {
            return Optional.of(stub
                    .withDeadlineAfter(800, TimeUnit.MILLISECONDS)   // 每次调用都设截止时间
                    .getOrder(GetOrderRequest.newBuilder().setOrderId(orderId).build()));
        } catch (StatusRuntimeException e) {
            return switch (e.getStatus().getCode()) {
                case NOT_FOUND -> Optional.empty();
                default -> throw e;   // DEADLINE_EXCEEDED、UNAVAILABLE 等交给上层的重试与降级
            };
        }
    }
}
```

存根是线程安全的，复用同一个 Channel；`withDeadlineAfter` 每次返回新的存根副本，不影响共享实例。

---

## 五、Thrift

Apache Thrift 由 Facebook 开源，后捐给 Apache，是 Protobuf + gRPC 之前最常见的跨语言 RPC 方案。它把协议栈拆成可替换的三层：

| 层 | 作用 | 常用实现 |
|----|------|---------|
| Protocol | 序列化格式 | `TBinaryProtocol`、`TCompactProtocol`（varint，体积更小）、`TJSONProtocol` |
| Transport | 字节怎么传 | `TSocket`、`TFramedTransport`（带 4 字节长度前缀，非阻塞服务端必须用）、`THttpClient` |
| Server | 线程模型 | `TSimpleServer`、`TThreadPoolServer`、`TNonblockingServer`、`THsHaServer` |

```thrift
// order.thrift
namespace java com.example.thrift.order

struct OrderReply {
  1: required string orderId
  2: optional i64 amountCents
}

exception OrderNotFound { 1: string orderId }

service OrderService {
  OrderReply getOrder(1: string orderId) throws (1: OrderNotFound e)
}
```

与 gRPC 相比，Thrift 没有流式调用，也没有截止时间、状态码、健康检查这些标准化约定，各家用法差异大。现在主要出现在存量大数据组件里（如 Hive Metastore、HBase Thrift Server；Cassandra 4.0 已移除 Thrift 接口），新项目一般选 gRPC。

---

## 六、SOAP

SOAP 是 W3C 标准的 XML 消息协议，配套用 WSDL 描述接口，通常走 HTTP POST。一条 SOAP 消息由信封（Envelope）、可选的头（Header，放 WS-Security 等扩展）和体（Body）组成，出错时 Body 里是 `Fault`：

```xml
<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope">
  <soap:Header/>
  <soap:Body>
    <ord:GetOrder xmlns:ord="http://example.com/order">
      <ord:orderId>1001</ord:orderId>
    </ord:GetOrder>
  </soap:Body>
</soap:Envelope>
```

- **现状**：银行、政务、医保、老 ERP 的对外接口仍在用，新系统基本不再选它
- **Java 侧**：JAX-WS 从 JDK 11 起移出 JDK（JEP 320），需要单独引入 Jakarta XML Web Services 实现；Spring 生态用 Spring Web Services，提倡先写 XSD / WSDL 的契约优先方式
- **对接要点**：WSDL 生成客户端代码，签名、加密按对方要求配置 WS-Security，抓包排查时注意 XML 命名空间和 SOAP 1.1 / 1.2 的版本差异（1.1 的 Content-Type 是 `text/xml` 并带 `SOAPAction` 头，1.2 是 `application/soap+xml`）

---

## 小结

- RPC 由接口契约、序列化、传输、服务寻址、错误与超时语义五部分组成，选协议就是在这五点上做取舍
- Protobuf 只写「字段编号 + 线类型 + 值」，字段编号就是兼容性的根本：不改编号、删字段用 `reserved`、金额用整数
- gRPC 一次调用就是一个 HTTP/2 流，消息带 5 字节长度前缀，结果在 Trailers 的 `grpc-status` 里，HTTP 状态恒为 200
- 每个调用都要设截止时间；Java 会把截止时间自动传给下游，`DEADLINE_EXCEEDED` 时服务端可能已执行成功，只有幂等操作才能重试
- HTTP/2 长连接会让 L4 负载均衡失效，用客户端负载均衡或 L7 代理按请求分发
- Spring Boot 4.1 起自带 gRPC starter，4.0 用 Spring gRPC 1.0，3.x 存量项目可用社区 starter
- Thrift 主要存在于存量大数据组件，SOAP 主要用于对接银行、政务等老系统
- REST 风格的 URL、状态码、版本约定见 [API 设计规范](/engineering/7_api_design_rule)
- 服务间调用怎么选（HTTP Service Clients / OpenFeign / gRPC / Dubbo / 异步消息）见 [服务通信](/spring-cloud/3_communication)
- Dubbo 与 Triple 协议见 [Dubbo](/microservices/4_dubbo)
- AMQP 是消息协议而不是 RPC：RabbitMQ 经典用法是 AMQP 0-9-1，AMQP 1.0 是另一套协议，见 [RabbitMQ](/messaging/4_rabbitmq)

## 参考资料

- gRPC 官方文档：[https://grpc.io/docs/](https://grpc.io/docs/)
- gRPC over HTTP/2 协议规范：[https://github.com/grpc/grpc/blob/master/doc/PROTOCOL-HTTP2.md](https://github.com/grpc/grpc/blob/master/doc/PROTOCOL-HTTP2.md)
- gRPC Deadlines：[https://grpc.io/docs/guides/deadlines/](https://grpc.io/docs/guides/deadlines/)
- gRPC 状态码：[https://grpc.io/docs/guides/status-codes/](https://grpc.io/docs/guides/status-codes/)
- Protobuf Encoding：[https://protobuf.dev/programming-guides/encoding/](https://protobuf.dev/programming-guides/encoding/)
- Protobuf 语言指南（proto3）：[https://protobuf.dev/programming-guides/proto3/](https://protobuf.dev/programming-guides/proto3/)
- Spring Boot gRPC：[https://docs.spring.io/spring-boot/reference/io/grpc.html](https://docs.spring.io/spring-boot/reference/io/grpc.html)
- Spring gRPC 1.0.0 GA：[https://spring.io/blog/2025/12/04/spring-grpc-1/](https://spring.io/blog/2025/12/04/spring-grpc-1/)
- Apache Thrift：[https://thrift.apache.org/](https://thrift.apache.org/)
- SOAP 1.2（W3C）：[https://www.w3.org/TR/soap12/](https://www.w3.org/TR/soap12/)

> 下一篇：[数据库协议](./6_database_protocols) —— JDBC 分层、MySQL 握手与认证、PostgreSQL 消息格式、Redis RESP2 / RESP3。
