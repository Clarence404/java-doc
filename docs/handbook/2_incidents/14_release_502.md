---
description: 滚动发布网关 502、复用长连接被旧 Pod 关闭、POST 不重试、preStop 与空闲超时修复
---

# 发布时 502

> 前置阅读：[优雅上下线与变更](/high-avail/8_graceful_release)、[Kubernetes](/cloud-native/6_kubernetes)

订单服务每次滚动发布，网关都会冒出一小撮几乎全是 `POST` 的 502。本篇复盘一次被用户投诉放大的发布事故：旧 Pod 停机时关掉了网关正在复用的长连接，基线为 Spring Boot 4、Kubernetes 1.37。

---

## 一、现象

2026-08-20（周四）14:30，订单服务 `order-service` 从 v2.30.4 滚动发布到 v2.31.0，8 个副本，Deployment 使用默认滚动参数（`maxSurge` / `maxUnavailable` 均为 25%）。入口是 NGINX Gateway Fabric（NGF，数据面是 nginx），`/api/orders/**` 下午高峰约 900 QPS。

| 时间 | 现象 |
|------|------|
| 14:30:12 | 发布系统触发 `kubectl set image`，滚动开始 |
| 14:30:20 起 | 网关错误日志刷出大量 `connect() failed (111: Connection refused)`；502 面板随每批旧 Pod 下线出现一次尖刺，峰值分钟 0.12%，P99 延迟无明显变化 |
| 14:36:05 | 滚动结束，尖刺消失；告警「5xx 比例 > 2% 持续 2 分钟」始终没有触发 |
| 14:50 | 客服反馈多名用户提交订单提示「系统繁忙，请稍后重试」；支付平台回调订单服务失败，进入对方的重试队列 |
| 15:05 | 值班冻结当天剩余发布，开始排查 |

网关在这 6 分钟里共返回 206 个 502，其中 201 个是 `POST`、5 个是 `PATCH`，`GET` 一个都没有。错误日志里数量最多的 `Connection refused` 却有近 2,900 条，两组数字对不上，是这次排查的突破口。

---

## 二、影响

- **下单失败**：158 次 `POST /api/orders` 返回 502，客户端未自动重试，部分用户放弃下单；按当时客单价估算影响 GMV 约 2 万元
- **支付回调失败**：43 次 `POST /api/orders/pay-callback` 被拒，依赖支付平台 15 分钟后的重试才最终一致，期间订单状态停留在「待支付」，有 3 个用户重复支付，事后退款
- **故障等级**：P3（核心链路少量失败，可自动恢复），因用户投诉升级处理，分级标准见 [故障应急与复盘](/high-avail/11_incident_response)
- **隐性影响**：过去三个月每次发布都有同样的 `POST` 502；平时每天也有十几个零星的 `POST` 502，一直没人追

---

## 三、排查过程

### 1、确认与发布时间线重合

```bash
kubectl -n order rollout history deployment/order-service
kubectl -n order get rs -l app=order-service
```

示例输出：

```text
REVISION  CHANGE-CAUSE
41        release v2.30.4
42        release v2.31.0

NAME                       DESIRED   CURRENT   READY   AGE
order-service-6c9d7f5b8d   8         8         8       2h
order-service-7f4b9c6d5    0         0         0       9d
```

502 尖刺与旧 ReplicaSet 每次缩容的时间点一一对应，先排除下游数据库、Redis 抖动，聚焦发布过程本身。

### 2、看网关错误日志：两类错误，打到两类 Pod

先按错误类型归类：

```bash
kubectl -n nginx-gateway logs deploy/nginx-gateway -c nginx --since=2h | grep '2026/08/20 14:3' \
  | grep -oE 'connect\(\) failed \(111: Connection refused\)|upstream prematurely closed connection|Connection reset by peer' \
  | sort | uniq -c
```

示例输出：

```text
   2873 connect() failed (111: Connection refused)
    171 upstream prematurely closed connection
     73 Connection reset by peer
```

两类原始错误：

```text
2026/08/20 14:30:21 [error] 33#33: *87102 connect() failed (111: Connection refused) while connecting to upstream, client: 10.0.8.15, server: api.example.com, request: "POST /api/orders HTTP/1.1", upstream: "http://10.244.3.27:8080/api/orders"
2026/08/20 14:31:07 [error] 31#31: *88213 upstream prematurely closed connection while reading response header from upstream, client: 10.0.8.22, server: api.example.com, request: "POST /api/orders HTTP/1.1", upstream: "http://10.244.1.83:8080/api/orders"
2026/08/20 14:31:07 [error] 32#32: *88240 recv() failed (104: Connection reset by peer) while reading response header from upstream, client: 10.0.8.31, server: api.example.com, request: "POST /api/orders/pay-callback HTTP/1.1", upstream: "http://10.244.1.83:8080/api/orders/pay-callback"
```

再按 upstream IP 对照 `kubectl get pod -o wide`：`connect() failed` 几乎全部落在**新 Pod**（每个 350 条左右）；`prematurely closed` 和 `reset by peer` 全部落在**正在下线的旧 Pod**（每个 30 条左右），而且集中在各自停机后的一两秒内。两者所处的阶段不同：前者是 **while connecting**，连接还没建起来；后者是 **while reading response header**，请求已经写给了上游，等响应时连接没了。

### 3、对照访问日志：哪些真正变成了 502

网关访问日志格式里带了 `$upstream_addr` 和 `$upstream_status`，一次请求换过几个实例、每次的结果都记在里面：

```text
14:30:21.402 POST /api/orders                   201  upstream=10.244.3.27:8080, 10.244.6.11:8080  upstream_status=502, 201
14:31:07.118 GET  /api/orders/2026082014310051  200  upstream=10.244.1.83:8080, 10.244.4.9:8080   upstream_status=502, 200
14:31:07.121 POST /api/orders                   502  upstream=10.244.1.83:8080                     upstream_status=502
```

按错误类型和方法统计最终状态：

| 错误类型 | 方法 | 错误日志条数 | 最终返回 502 |
|---------|------|-------------|-------------|
| `connect() failed (111)` | 全部 | 2,873 | 0，全部换实例后成功 |
| `prematurely closed` / `reset by peer` | `GET` | 38 | 0，换实例后成功 |
| `prematurely closed` / `reset by peer` | `POST` / `PATCH` | 206 | 206 |

再看网关生成的 nginx 配置：

```bash
kubectl -n nginx-gateway exec deploy/nginx-gateway -c nginx -- nginx -T 2>/dev/null \
  | grep -E 'upstream order_order-service|keepalive|proxy_http_version|proxy_next_upstream'
```

示例输出：

```text
upstream order_order-service_8080 {
    keepalive 16;
        proxy_http_version 1.1;
```

NGF 默认给上游开了长连接（`keepalive`），没有写 `proxy_next_upstream`，即默认值 `error timeout`；上游空闲长连接的 `keepalive_timeout` 也是默认的 60 秒。nginx 换实例重试的规则正好解释了上面的表：

- **连接阶段失败**（`connect() failed`）：请求还没发出去，对任何方法都会换下一个实例，所以新 Pod 那 2,873 次全部被吸收，用户无感
- **请求已发出后失败**（连接被关闭或重置）：1.9.13 起，`POST`、`LOCK`、`PATCH` 这类非幂等请求不再转发到下一个实例，除非显式加 `non_idempotent`；`GET` 照常重试。所以 502 几乎全是 `POST`

结论：错误日志里最显眼的 `Connection refused` 是干扰项，真正产生 502 的是旧 Pod 上**复用的长连接在请求发出后被关掉**。以前有人看过一次错误日志，满屏 `connect() failed`，结论是「新 Pod 启动慢，过一会儿就好」，没有对照访问日志里的最终状态码。

### 4、旧 Pod：为什么连接会在请求途中被关

拿一个旧 Pod 的停机日志和网关摘除时间对比：

```bash
kubectl -n order logs order-service-7f4b9c6d5-h2k9w --previous | grep -iE 'graceful|shutdown'
kubectl -n nginx-gateway logs deploy/nginx-gateway -c nginx-gateway --since=2h | grep -E 'order-service.*(Reconcil|Endpoint)' | grep '14:31:'
kubectl -n order get deploy order-service -o jsonpath='{.spec.template.spec.containers[0].lifecycle}'
```

示例输出：

```text
2026-08-20T14:31:07.102+08:00  INFO 1 --- [order-service] [ionShutdownHook] o.s.b.tomcat.GracefulShutdown : Commencing graceful shutdown. Waiting for active requests to complete
2026-08-20T14:31:07.488+08:00  INFO 1 --- [order-service] [tomcat-shutdown] o.s.b.tomcat.GracefulShutdown : Graceful shutdown complete

{"level":"info","ts":"2026-08-20T06:31:10.913Z","msg":"Reconciling the resource","controller":"endpointslice","namespace":"order","name":"order-service-x8f2k"}
```

`lifecycle` 输出为空，没有 `preStop`。把时间线拼起来：

1. **14:31:07.102**：Pod 进入删除流程，SIGTERM 与「从 EndpointSlice 摘除」**同时**发生。Spring Boot 开始优雅停机，Tomcat 停止接收新连接，已建立的长连接上仍在处理请求
2. **14:31:07.488**：在途请求处理完，优雅停机 0.4 秒就结束，Tomcat 关闭连接器，**所有长连接被关掉**：空闲的发 FIN，接收缓冲区里还有未读请求的直接回 RST，随后 JVM 退出
3. **这时网关还不知道 Pod 要下线**：nginx 仍把它当作正常上游，各 worker 继续从连接池里取出到它的长连接发请求。恰好在关闭瞬间写出去的请求，读响应头时得到 `upstream prematurely closed connection`（对端 FIN）或 `Connection reset by peer`（对端 RST），`GET` 被重试成功，`POST` 直接 502
4. **14:31:10.913**：网关完成配置更新，把该 Pod 移出 upstream。中间这 3～4 秒新建的连接都是 `Connection refused`，会被重试吸收，不产生 502

顺带确认了两件事：Dockerfile 用的是 exec 形式 `ENTRYPOINT ["java", ...]`，SIGTERM 能到达 JVM；`server.shutdown` 走 Boot 默认的 `graceful`，在途请求没有被中断。应用停机本身没问题，问题在**停机比摘流量早**：网关还在往这些连接上发新请求，应用就把连接关了。

每天十几个零星的 `POST` 502 也是同一个机制，只是触发者换成了空闲超时。服务配置里有一行从虚拟机时代模板带过来的 `server.tomcat.keep-alive-timeout: 20s`，比网关上游空闲长连接的 60 秒短：一条连接空闲满 20 秒时由 Tomcat 先关，如果 nginx 恰好在同一时刻复用它发出 `POST`，结果和发布时一样。**谁先关空闲连接，谁就要承担这种竞争**，所以必须让网关侧先关。

### 5、新 Pod：没有 readinessProbe

错误日志里最多的 `Connection refused` 来自新 Pod，虽然被重试吸收了，也是要修的隐患：

```bash
kubectl -n order logs order-service-6c9d7f5b8d-q7m2x | grep -E 'Starting|Tomcat started|Started'
kubectl -n order get deploy order-service -o jsonpath='{.spec.template.spec.containers[0]}' | jq '{readinessProbe, livenessProbe, startupProbe}'
```

示例输出：

```text
2026-08-20T14:30:16.208+08:00  INFO 1 --- [order-service] [main] c.e.order.OrderApplication : Starting OrderApplication v2.31.0 using Java 21.0.8
2026-08-20T14:30:37.105+08:00  INFO 1 --- [order-service] [main] o.s.b.tomcat.TomcatWebServer : Tomcat started on port 8080 (http) with context path '/'
2026-08-20T14:30:37.942+08:00  INFO 1 --- [order-service] [main] c.e.order.OrderApplication : Started OrderApplication in 21.734 seconds

{
  "readinessProbe": null,
  "livenessProbe": { "tcpSocket": { "port": 8080 }, "initialDelaySeconds": 60, "periodSeconds": 10 },
  "startupProbe": null
}
```

**没有 readinessProbe 时，容器一运行就被视为就绪**，约 22 秒里新 Pod 已在 EndpointSlice 中，端口却没在监听；liveness 的 `initialDelaySeconds` 只是延后检查，不会阻止接流量。这次靠 nginx 的连接失败重试兜住了，但每个请求多一次失败连接，还会触发 nginx 的被动健康检查把实例短暂标记为不可用；换成不重试的调用方（如服务间直连），这些就是实打实的错误。

### 6、在预发环境复现

```bash
# 终端 1、2：滚动期间分别持续压测写接口和读接口
hey -z 180s -c 20 -m POST -H 'Content-Type: application/json' -D order.json https://staging-api.example.com/api/orders
hey -z 180s -c 20 https://staging-api.example.com/api/orders/2026082014310051
# 终端 3：触发一次滚动
kubectl -n order rollout restart deployment/order-service
```

示例输出：

```text
# POST
Status code distribution:
  [201] 41873 responses
  [502] 63 responses
# GET
Status code distribution:
  [200] 52118 responses
```

对照实验：在预发临时关掉网关到 order-service 的上游长连接，再滚动一次，`POST` 的 502 从 63 降到 2，说明复用长连接是主要路径。关长连接只用来验证，不作为修复手段，原因见 [Nginx、Ingress 与 Gateway API · Nginx 反向代理要点](/cloud-native/7_nginx_ingress#二、nginx-反向代理要点)。

---

## 四、根因

| 环节 | 缺陷 | 后果 |
|------|------|------|
| 旧 Pod 下线 | 没有 preStop，摘除 EndpointSlice 与 SIGTERM 并行；优雅停机 0.4 秒就结束并关闭全部长连接，网关约 3.8 秒后才摘除 | 网关在已被关闭的复用连接上发出请求，每个旧 Pod 约 30 次失败 |
| 网关重试规则 | `proxy_next_upstream` 默认 `error timeout`，请求已发出后不重试 `POST` / `PATCH` | `GET` 被重试成功，非幂等请求直接 502，所以 502 几乎全是 `POST` |
| 空闲超时倒挂 | Tomcat `keep-alive-timeout` 20 秒，短于网关上游空闲长连接的 60 秒 | 日常零星的 `POST` 502 |
| 新 Pod 上线 | 没有 readinessProbe，容器启动即就绪 | 约 22 秒的 `Connection refused`，被重试吸收，不产生 502，但淹没了真正的错误 |
| 滚动节奏 | `maxUnavailable: 25%`，一次直接停 2 个旧 Pod | 同时被切断的长连接翻倍 |

更深一层：服务模板是两年前从虚拟机部署迁移过来的，当时只加了 liveness 防止进程假死，Tomcat 参数原样照搬；发布 502 量小，又被 `Connection refused` 的日志带偏，一直被当作「正常抖动」。

---

## 五、修复

### 1、止血

- 15:05 冻结 order-service 当天剩余发布；网关暂不对 `POST /api/orders` 开 `non_idempotent`（下单接口此时还没有幂等键，换实例重试可能重复下单）
- 拉取 14:30～14:37 支付平台回调失败清单，调用对账补单接口主动查询支付结果，3 笔重复支付走退款
- 客服统一话术，引导用户在「我的订单」中确认后再重新下单

### 2、Kubernetes 侧：先摘流，再停机

```yaml
spec:
  replicas: 8
  minReadySeconds: 10                       # 就绪后稳定 10 秒才计为可用
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 1
      maxUnavailable: 0                     # 先起新的、就绪后再停旧的
  template:
    spec:
      terminationGracePeriodSeconds: 45     # ≥ preStop 15s + 停机超时 25s + 余量
      containers:
        - name: order-service
          ports:
            - containerPort: 8080
          startupProbe:                     # 兜住启动时间，最长 5 分钟
            httpGet: { path: /livez, port: 8080 }
            periodSeconds: 5
            failureThreshold: 60
          readinessProbe:
            httpGet: { path: /readyz, port: 8080 }
            periodSeconds: 5
            failureThreshold: 2
          livenessProbe:
            httpGet: { path: /livez, port: 8080 }
            periodSeconds: 10
            failureThreshold: 3
          lifecycle:
            preStop:
              sleep:
                seconds: 15                 # 等网关摘除、不再复用到本 Pod 的连接，再发 SIGTERM
```

`preStop` 期间应用照常服务，在途和新到的请求都能正常返回；网关在这段时间里完成摘除，不再向这个 Pod 发新请求，到它的长连接随之空闲并被网关回收。15 秒后 SIGTERM 才到达，此时 Tomcat 关闭连接已经不会撞上新请求。`preStop` 使用内置的 `sleep` 动作，不依赖镜像里有 `sh`；时长取值依据见 [优雅上下线与变更 · 优雅停机](/high-avail/8_graceful_release#一、优雅停机)。

### 3、Spring Boot 侧：优雅停机与空闲超时

```yaml
server:
  shutdown: graceful                        # Boot 4 默认值，显式写出防止被覆盖
  tomcat:
    keep-alive-timeout: 75s                 # 删掉模板里的 20s；必须大于网关侧的上游空闲超时
spring:
  lifecycle:
    timeout-per-shutdown-phase: 25s         # 大于下单接口 P99.9（约 3s）并留足余量
management:
  endpoint:
    health:
      probes:
        enabled: true                       # 部署在 K8s 时会自动开启，这里显式声明
        add-additional-paths: true          # 在业务端口暴露 /livez、/readyz
```

readiness 组默认只包含 `readinessState`，**不要**把数据库、Redis 加进 liveness；需要预热的服务在预热完成后再发布 `ReadinessState.ACCEPTING_TRAFFIC`，做法见 [优雅上下线与变更 · 服务预热](/high-avail/8_graceful_release#二、服务预热)。

### 4、网关侧：空闲连接由网关先关

用 NGF 的 `UpstreamSettingsPolicy` 把上游空闲长连接的超时降到应用侧之下，保证空闲连接总是由网关主动关闭：

```yaml
apiVersion: gateway.nginx.org/v1alpha1
kind: UpstreamSettingsPolicy
metadata:
  name: order-service-upstream
  namespace: order
spec:
  targetRefs:
    - group: core
      kind: Service
      name: order-service
  keepAlive:
    connections: 32
    timeout: 30s                            # 对应 keepalive_timeout，小于 Tomcat 的 75s
```

下单接口在后续迭代接入幂等键（服务端按键去重）之后，才对这一条路由开启非幂等重试：对应的 nginx 指令是 `proxy_next_upstream error timeout non_idempotent;` 加 `proxy_next_upstream_tries 2;`，在 NGF 中通过 `SnippetsFilter` 只挂到 `/api/orders` 的路由上。没有幂等保障的 `POST` 不要开，重试规则见 [负载均衡 · 健康检查与故障摘除](/high-avail/3_load_balancing#二、健康检查与故障摘除)。

### 5、验证

预发环境用排查第 6 步的读写压测脚本连续滚动 5 次，`POST` 与 `GET` 的 502 均为 0，访问日志里也不再出现 `upstream_status=502, …` 这种换过实例的记录；生产下一次发布 502 为 0，此后两周日常零星的 `POST` 502 也没有再出现。

---

## 六、预防

### 1、监控与告警

```yaml
# 发布窗口的 502 不再静默：按上游服务统计绝对次数，而不是只看比例
- alert: GatewayUpstream502
  expr: |
    sum by (service) (increase(nginx_gateway_upstream_responses_total{code="502"}[5m])) > 5
  labels: { severity: warning }
  annotations:
    summary: "{{ $labels.service }} 5 分钟内网关 502 超过 5 次，检查是否正在发布"
```

指标名以所用网关的 exporter 为准。这次比例阈值（> 2%）完全没响，所以对非幂等接口按绝对次数告警，并对网关错误日志中的 `prematurely closed` / `reset by peer` 做日志告警；Grafana 上叠加发布事件注解，方便一眼对上时间线。

### 2、准入规则

- 用 Kyverno / OPA Gatekeeper 写准入策略：`Deployment` 必须定义 `readinessProbe`、`lifecycle.preStop`，`maxUnavailable` 不得大于 0（单副本服务除外）
- CI 中加入 kube-linter 等静态检查，`no-readiness-probe` 一类规则失败直接阻断合并
- 服务模板（Helm Chart）统一内置上面的探针、preStop 和宽限期；网关的 `UpstreamSettingsPolicy` 与应用的 `keep-alive-timeout` 成对写进模板，评审清单写明「网关上游空闲超时 < 应用空闲超时」

### 3、发布测试

- 预发环境的发布流水线增加「滚动中压测」步骤：发布期间同时发送读请求和写请求，任何非 2xx 都让流水线失败；只压 `GET` 发现不了这类问题
- 混沌演练定期 `kubectl delete pod` 和 `kubectl drain` 节点，验证摘流与停机顺序，见 [混沌工程](/high-avail/10_chaos_engineering)

### 4、接口层兜底

- 下单接口支持幂等键，客户端对 502/503 可以安全重试，网关也才能放心开非幂等重试，见 [幂等设计](/architecture/3_idempotence)
- 支付回调处理保持幂等，回调失败依赖对方重试与本方对账双保险

---

## 七、涉及知识点

| 知识点 | 文章 |
|--------|------|
| 停机顺序、preStop、PDB 与滚动参数 | [优雅上下线与变更 · 优雅停机](/high-avail/8_graceful_release#一、优雅停机) |
| 三种探针、滚动更新、Pod 终止流程 | [Kubernetes · 探针、滚动更新与优雅终止](/cloud-native/6_kubernetes#四、探针、滚动更新与优雅终止) |
| Actuator 存活 / 就绪探针与健康分组 | [Actuator 监控](/spring-boot/11_actuator#四、存活-就绪探针与健康分组) |
| nginx 上游长连接 | [Nginx、Ingress 与 Gateway API · Nginx 反向代理要点](/cloud-native/7_nginx_ingress#二、nginx-反向代理要点) |
| 失败转移只对幂等请求开启 | [负载均衡 · 健康检查与故障摘除](/high-avail/3_load_balancing#二、健康检查与故障摘除) |
| 滚动、蓝绿、金丝雀与上线检查单 | [发布策略](/devops/7_release_strategy) |
| SIGTERM 与 SIGKILL | [Linux 概览 · 进程与信号](/cloud-native/1_linux#五、进程与信号) |
| 故障分级与复盘 | [故障应急与复盘](/high-avail/11_incident_response) |

---

## 小结

- 发布 502 几乎全是 `POST` 时，先怀疑「请求已发出后连接被关」：连接失败时 nginx 对任何方法都会换实例重试，请求发出后只重试幂等方法
- 错误日志按出错阶段（connecting / reading response header）和 upstream IP 归类，再对照访问日志的 `$upstream_status` 看最终结果，才能分清干扰项和真凶
- 旧 Pod 停机早于摘流，会把网关正在复用的长连接关掉；修复是 `preStop sleep` 先摘流、应用优雅停机、网关上游空闲超时小于应用空闲超时
- 新 Pod 缺 readinessProbe 这次被重试吸收，同样要修：startup / readiness / liveness 三探针 + `maxUnavailable: 0`
- 「发布正常抖动」不存在：用准入策略、读写混合的滚动压测和按次数告警，把零错误发布变成默认值

## 参考资料

- Pod 终止流程与探针：[Kubernetes: Pod Lifecycle](https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/)
- preStop 与 sleep 动作：[Kubernetes: Container Lifecycle Hooks](https://kubernetes.io/docs/concepts/containers/container-lifecycle-hooks/)
- 探针配置：[Kubernetes: Configure Liveness, Readiness and Startup Probes](https://kubernetes.io/docs/tasks/configure-pod-container/configure-liveness-readiness-startup-probes/)
- 滚动更新参数：[Kubernetes: Deployments](https://kubernetes.io/docs/concepts/workloads/controllers/deployment/)
- 优雅停机：[Spring Boot Reference: Graceful Shutdown](https://docs.spring.io/spring-boot/reference/web/graceful-shutdown.html)
- Kubernetes 探针端点：[Spring Boot Reference: Kubernetes Probes](https://docs.spring.io/spring-boot/reference/actuator/endpoints.html#actuator.endpoints.kubernetes-probes)
- nginx 失败重试规则：[nginx: proxy_next_upstream](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_next_upstream)
- nginx 上游空闲长连接超时：[nginx: keepalive_timeout（upstream）](https://nginx.org/en/docs/http/ngx_http_upstream_module.html#keepalive_timeout)
- NGF 文档：[NGINX Gateway Fabric](https://docs.nginx.com/nginx-gateway-fabric/)

> 下一篇：[容器被 OOMKilled](./15_oom_killed)
