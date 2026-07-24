# API 设计规范

---

## 一、URL 与资源命名

```
规则：
  - 资源用名词复数，不用动词：/orders  ✅   /getOrder  ❌
  - 层级关系用路径表达：/users/{userId}/orders（用户的订单列表）
  - 全部小写，多词用连字符：/order-items  ✅   /orderItems  ❌
  - 不超过 3 层：/a/b/c/d 难以维护，超出层级用查询参数

示例：
  GET    /api/orders                   查询订单列表
  GET    /api/orders/{id}              查询单个订单
  POST   /api/orders                   创建订单
  PUT    /api/orders/{id}              全量更新订单
  PATCH  /api/orders/{id}/status       部分更新（仅状态）
  DELETE /api/orders/{id}              删除订单
  POST   /api/orders/{id}/cancel       动词操作（取消，不适合 PATCH 时用此形式）
```

---

## 二、HTTP 方法与状态码

### HTTP 方法语义

| 方法 | 幂等 | 安全 | 用途 |
|------|------|------|------|
| GET | ✅ | ✅ | 查询，不修改资源 |
| POST | ❌ | ❌ | 创建资源，触发操作 |
| PUT | ✅ | ❌ | 全量替换资源 |
| PATCH | ❌ | ❌ | 部分更新资源 |
| DELETE | ✅ | ❌ | 删除资源 |

### 状态码速查

| 状态码 | 场景 |
|--------|------|
| `200 OK` | 查询/更新成功 |
| `201 Created` | 资源创建成功（附 `Location` Header 指向新资源） |
| `204 No Content` | 删除成功，无响应体 |
| `400 Bad Request` | 请求参数错误（格式/必填/范围） |
| `401 Unauthorized` | 未认证（没有或 Token 无效） |
| `403 Forbidden` | 已认证但无权限 |
| `404 Not Found` | 资源不存在 |
| `409 Conflict` | 资源冲突（如重复创建） |
| `422 Unprocessable Entity` | 参数格式正确但业务校验失败 |
| `429 Too Many Requests` | 触发限流 |
| `500 Internal Server Error` | 服务器内部错误 |

---

## 三、统一响应结构

```java
@Data
public class Result<T> {
    private int    code;      // 业务状态码（200=成功，非 HTTP 状态码）
    private String message;
    private T      data;
    private String traceId;   // 链路追踪 ID，方便排查

    public static <T> Result<T> ok(T data) {
        return new Result<>(200, "success", data, MDC.get("traceId"));
    }

    public static <T> Result<T> fail(int code, String message) {
        return new Result<>(code, message, null, MDC.get("traceId"));
    }
}
```

**列表接口响应（带分页元数据）**：

```json
{
  "code": 200,
  "message": "success",
  "data": {
    "list": [...],
    "total": 1024,
    "page": 1,
    "pageSize": 20
  },
  "traceId": "abc123"
}
```

**错误响应（字段错误时附详情）**：

```json
{
  "code": 400,
  "message": "参数校验失败",
  "data": {
    "errors": [
      { "field": "userId",  "message": "不能为空" },
      { "field": "amount",  "message": "必须大于 0" }
    ]
  },
  "traceId": "abc123"
}
```

---

## 四、分页、排序与过滤

```
分页参数（推荐 cursor 分页用于大数据集，offset 分页用于普通场景）：

Offset 分页：
  GET /api/orders?page=1&pageSize=20

Cursor 分页（无跳页，性能更好，适合信息流）：
  GET /api/orders?cursor=eyJpZCI6MTAwMH0&limit=20
  响应带 nextCursor，下一页用它请求

排序：
  GET /api/orders?sort=createdAt,desc&sort=amount,asc
  多字段排序用多个 sort 参数

过滤：
  GET /api/orders?status=PENDING&startDate=2024-01-01&endDate=2024-01-31
  复杂过滤（可用 POST + body，避免 URL 过长）：
  POST /api/orders/search
  Body: { "status": ["PENDING","PAID"], "amountMin": 100, "amountMax": 1000 }

字段裁剪（按需返回，减少传输量）：
  GET /api/orders?fields=id,status,amount
```

---

## 五、幂等设计

对 POST/PATCH 等非幂等接口，需要调用方提供幂等键：

```
Header: Idempotent-Key: {clientGeneratedUUID}
```

```java
@PostMapping("/orders")
public Result<String> createOrder(
    @RequestHeader("Idempotent-Key") String idempotentKey,
    @RequestBody @Valid CreateOrderRequest req) {

    // 检查幂等键是否已处理
    String cached = redis.get("idem:" + idempotentKey);
    if (cached != null) {
        return Result.ok(cached);   // 直接返回已有结果
    }

    String orderId = orderService.create(req);

    // 写入幂等记录（TTL 设为业务合理值，如 24h）
    redis.setex("idem:" + idempotentKey, 86400, orderId);
    return Result.ok(orderId);
}
```

---

## 六、版本管理与废弃策略

### 版本号位置

| 方式 | 示例 | 优缺点 |
|------|------|--------|
| **URL 路径（推荐）** | `/api/v1/orders` | 直观，易缓存 |
| Header | `Accept: application/vnd.example.v1+json` | 符合 REST 规范，实现复杂 |
| 查询参数 | `/api/orders?version=1` | 简单，但污染业务参数 |

### 兼容性原则

```
向后兼容变更（可以直接发布，无需升版本）：
  ✅ 新增字段（客户端应忽略未知字段）
  ✅ 新增可选请求参数
  ✅ 新增枚举值（客户端应处理未知枚举）
  ✅ 扩大字段范围（如 int → long）

破坏性变更（必须新版本）：
  ❌ 删除或重命名字段
  ❌ 修改字段类型（如 string → int）
  ❌ 删除枚举值
  ❌ 修改必填/可选性
  ❌ 修改错误码语义
```

### 废弃流程

```java
// 步骤 1：标记废弃（至少保留一个完整版本周期）
@Deprecated
@Operation(deprecated = true, summary = "【废弃，请使用 v2】创建订单")
@PostMapping("/v1/orders")
public Result<String> createOrderV1(...) { ... }

// 步骤 2：新版本并行运行
@PostMapping("/v2/orders")
public Result<OrderDetail> createOrderV2(...) { ... }

// 步骤 3：在响应 Header 提示废弃
response.addHeader("Deprecation", "version=\"v1\", date=\"2024-06-01\"");
response.addHeader("Sunset", "2025-01-01");  // 实际下线日期

// 步骤 4：到期下线
```

---

## 七、接口评审检查项

提交新接口前自检：

- [ ] URL 使用名词复数，无动词
- [ ] HTTP 方法与语义匹配（查询用 GET，创建用 POST）
- [ ] 状态码选择正确
- [ ] 响应结构符合统一规范（Result 包装）
- [ ] 非幂等接口有幂等设计
- [ ] 分页接口返回 total
- [ ] 敏感字段已脱敏（手机号、身份证等）
- [ ] 有明确的错误码和错误信息
- [ ] OpenAPI 文档注解已填写（description + 示例值）
- [ ] 生产环境不暴露内部实现细节（如堆栈信息）
