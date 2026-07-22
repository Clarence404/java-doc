# 远程调用协议

> 官方规范：[gRPC](https://grpc.io/docs/) / [Protobuf](https://protobuf.dev/) / [OpenAPI 3.1](https://spec.openapis.org/oas/v3.1.0) / [AMQP 1.0](https://www.amqp.org/)

---

## 一、协议对比总览

| 维度 | REST/HTTP | gRPC | Dubbo | GraphQL |
|------|---------|------|-------|---------|
| 传输层 | HTTP/1.1 | HTTP/2 | TCP（私有）| HTTP |
| 序列化 | JSON | Protobuf（二进制）| Hessian2/JSON | JSON |
| IDL | OpenAPI | `.proto` | 接口注解 | Schema |
| 流式支持 | 无 | ✅ 双向流 | 无 | 订阅 |
| 浏览器支持 | ✅ 原生 | 需 grpc-web 代理 | ❌ | ✅ |
| 性能 | 中 | 高 | 高 | 中 |
| 生态 | 最广 | Google 主导，CNCF 标准 | 国内主流 | Facebook 开源 |
| 适合 | 对外 API | 服务间高性能调用 | 国内微服务 | 复杂查询场景 |

---

## 二、gRPC

### Protobuf 定义

```protobuf
// order.proto
syntax = "proto3";
package order;
option java_package = "com.example.grpc.order";
option java_multiple_files = true;

service OrderService {
  rpc GetOrder (GetOrderRequest) returns (OrderResponse);
  rpc ListOrders (ListOrderRequest) returns (stream OrderResponse);    // 服务端流
  rpc PlaceOrder (stream PlaceOrderItem) returns (OrderResponse);     // 客户端流
}

message GetOrderRequest {
  string order_id = 1;
}

message OrderResponse {
  string order_id = 1;
  string status = 2;
  double amount = 3;
  repeated OrderItem items = 4;
}

message OrderItem {
  string product_id = 1;
  int32 quantity = 2;
  double price = 3;
}

message ListOrderRequest {
  string user_id = 1;
  int32 page_size = 2;
}

message PlaceOrderItem {
  string product_id = 1;
  int32 quantity = 2;
}
```

### Spring Boot 接入（grpc-spring-boot-starter）

```xml
<dependency>
    <groupId>net.devh</groupId>
    <artifactId>grpc-server-spring-boot-starter</artifactId>
    <version>3.1.0.RELEASE</version>
</dependency>
```

```yaml
grpc:
  server:
    port: 9090
  client:
    order-service:
      address: 'static://localhost:9090'
      negotiation-type: plaintext   # 生产环境改为 tls
```

```java
// 服务端实现
@GrpcService
public class OrderGrpcService extends OrderServiceGrpc.OrderServiceImplBase {

    @Override
    public void getOrder(GetOrderRequest request, StreamObserver<OrderResponse> responseObserver) {
        Order order = orderService.findById(request.getOrderId());

        OrderResponse response = OrderResponse.newBuilder()
            .setOrderId(order.getId())
            .setStatus(order.getStatus().name())
            .setAmount(order.getAmount().doubleValue())
            .addAllItems(order.getItems().stream()
                .map(this::toProto)
                .collect(Collectors.toList()))
            .build();

        responseObserver.onNext(response);
        responseObserver.onCompleted();
    }

    @Override
    public void listOrders(ListOrderRequest request, StreamObserver<OrderResponse> responseObserver) {
        // 服务端流：逐条返回
        orderService.streamByUserId(request.getUserId()).forEach(order -> {
            responseObserver.onNext(toProto(order));
        });
        responseObserver.onCompleted();
    }
}

// 客户端调用
@GrpcClient("order-service")
private OrderServiceGrpc.OrderServiceBlockingStub orderStub;

public OrderResponse getOrder(String orderId) {
    return orderStub.getOrder(
        GetOrderRequest.newBuilder().setOrderId(orderId).build()
    );
}
```

### Protobuf vs JSON

| 对比 | JSON | Protobuf |
|------|------|---------|
| 编码 | 文本，可读 | 二进制，不可读 |
| 大小 | 大（字段名重复）| 小（字段编号，约小 3-10x）|
| 解析速度 | 慢 | 快（约快 5-10x）|
| 向后兼容 | 弱 | 强（字段编号不变即兼容）|
| 调试 | 容易 | 需 protoc 工具解码 |

---

## 三、REST 最佳实践

### URL 设计规范

```
# 资源型 URL（名词，复数）
GET    /orders              # 列表
GET    /orders/{id}         # 详情
POST   /orders              # 创建
PUT    /orders/{id}         # 全量更新
PATCH  /orders/{id}         # 部分更新
DELETE /orders/{id}         # 删除

# 子资源
GET    /orders/{id}/items
POST   /orders/{id}/cancel  # 动作用子资源表达

# 版本（路径优先于 Header，更直观）
GET    /v1/orders
```

### HTTP 状态码规范

| 场景 | 状态码 |
|------|--------|
| 创建成功 | 201 Created |
| 操作成功无响应体 | 204 No Content |
| 客户端参数错误 | 400 Bad Request |
| 未认证 | 401 Unauthorized |
| 已认证但无权限 | 403 Forbidden |
| 资源不存在 | 404 Not Found |
| 服务端错误 | 500 Internal Server Error |

---

## 四、AMQP（异步消息）

AMQP（Advanced Message Queuing Protocol）是面向消息中间件的开放标准协议，RabbitMQ 的底层协议即 AMQP 0-9-1。

与 REST/gRPC 的核心区别：REST/gRPC 是**同步**调用（等待响应），AMQP 是**异步**消息（发后不等）。

> 详细使用见 [RabbitMQ](../messaging/3_rabbitmq)。
