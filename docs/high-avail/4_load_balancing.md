# 负载均衡

参考链接：
> [microservices/10_service_governance 服务治理](../microservices/10_service_governance)
> [cloud-native/5_kubernetes Kubernetes](../cloud-native/5_kubernetes)

## 一、负载均衡算法

### 轮询（Round Robin）

依次将请求分发到各实例，适合实例配置相同、请求处理时间相近的场景。

```
请求 1 → 实例A
请求 2 → 实例B
请求 3 → 实例C
请求 4 → 实例A（循环）
```

### 加权轮询（Weighted Round Robin）

按权重分配，适合实例性能不一致的场景：

```
实例A（权重3）、实例B（权重1）、实例C（权重1）
→ 每 5 个请求：A 3 次，B 1 次，C 1 次
```

### 最少连接（Least Connections）

优先将请求分发给当前活跃连接数最少的实例，适合请求处理时间差异大的场景（如长短请求混合）。

### 一致性哈希（Consistent Hashing）

根据请求中某个字段（如 userId、IP）计算哈希值，映射到虚拟节点环，保证同一用户始终路由到相同实例。

- **优势**：实例扩缩容时，只有少量请求需要重新路由（而非全量重分布）
- **典型场景**：有状态服务（Session、本地缓存）、分布式存储

---

## 二、负载均衡层次

| 层次 | 工具 | 说明 |
|------|------|------|
| DNS 层 | DNS 轮询 | 成本低，无健康检查，不推荐用于生产 |
| 四层（L4）| LVS、HAProxy | 基于 TCP/UDP 转发，性能高，不解析 HTTP |
| 七层（L7）| Nginx、Spring Cloud LoadBalancer | 基于 HTTP，可按 Header/URL 路由，支持健康检查 |
| 客户端 | Spring Cloud LoadBalancer、Ribbon | 客户端从注册中心拉取实例列表，本地做负载均衡 |

---

## 三、Nginx 负载均衡配置

```nginx
upstream backend {
    # 默认轮询
    server 10.0.0.1:8080;
    server 10.0.0.2:8080;
    server 10.0.0.3:8080;
}

# 加权轮询
upstream backend_weighted {
    server 10.0.0.1:8080 weight=3;
    server 10.0.0.2:8080 weight=1;
    server 10.0.0.3:8080 weight=1;
}

# 最少连接
upstream backend_least {
    least_conn;
    server 10.0.0.1:8080;
    server 10.0.0.2:8080;
}

# IP 哈希（同 IP 路由到相同实例）
upstream backend_hash {
    ip_hash;
    server 10.0.0.1:8080;
    server 10.0.0.2:8080;
}

server {
    listen 80;
    location /api/ {
        proxy_pass http://backend;
        proxy_connect_timeout 3s;
        proxy_read_timeout 10s;
        proxy_next_upstream error timeout;    # 故障转移到下一个实例
    }
}
```

---

## 四、故障转移

### 健康检查

```nginx
# Nginx 主动健康检查（需 nginx_upstream_check_module）
upstream backend {
    server 10.0.0.1:8080;
    server 10.0.0.2:8080;
    check interval=3000 rise=2 fall=3 timeout=1000 type=http;
    check_http_send "GET /actuator/health HTTP/1.0\r\n\r\n";
    check_http_expect_alive http_2xx;
}
```

### Kubernetes 就绪探针（Readiness Probe）

K8s 通过就绪探针判断 Pod 是否可接受流量。未就绪的 Pod 自动从 Service Endpoints 摘除：

```yaml
readinessProbe:
  httpGet:
    path: /actuator/health/readiness
    port: 8080
  initialDelaySeconds: 10
  periodSeconds: 5
  failureThreshold: 3        # 连续 3 次失败则摘除
```

---

## 五、弹性扩缩容（K8s HPA）

HPA（Horizontal Pod Autoscaler）根据 CPU / 内存 / 自定义指标自动扩缩 Pod 数量：

```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: order-service-hpa
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: order-service
  minReplicas: 2
  maxReplicas: 20
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 70    # CPU 平均使用率超过 70% 则扩容
    - type: Resource
      resource:
        name: memory
        target:
          type: Utilization
          averageUtilization: 80
```

配合 `PodDisruptionBudget` 保证滚动更新时始终有足够实例：

```yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: order-service-pdb
spec:
  minAvailable: 2     # 同时至少有 2 个 Pod 可用
  selector:
    matchLabels:
      app: order-service
```

---

## 六、数据高可用

| 方案 | 说明 |
|------|------|
| 主从复制 | 主库写，从库读，主节点故障手动/自动切换 |
| 数据库集群（如 MGR）| 多节点强一致，自动故障转移 |
| 分片 + 副本 | 数据分片水平扩展，每个分片多副本容错 |
| 多活数据同步 | 双向复制，就近写入，依赖幂等和冲突解决 |
