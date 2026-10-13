---
description: 滚动发布期间网关 502、新 Pod 未就绪先接流量、旧 Pod 停机早于摘流、探针与 preStop 修复
---

# 发布时 502

> 前置阅读：[优雅上下线与变更](/high-avail/8_graceful_release)、[Kubernetes](/cloud-native/6_kubernetes)

订单服务每次滚动发布，网关都会冒出一波 502，几分钟后自动消失，长期被当成「发布正常抖动」。本篇复盘一次被用户投诉放大的发布事故，基线为 Spring Boot 4、JDK 21、Kubernetes 1.37。

---

## 一、现象

2026-08-20（周四）14:30，订单服务 `order-service` 从 v2.30.4 滚动发布到 v2.31.0，8 个副本，Deployment 使用默认滚动参数（`maxSurge` / `maxUnavailable` 均为 25%）。

| 时间 | 现象 |
|------|------|
| 14:30:12 | 发布系统触发 `kubectl set image`，滚动开始 |
| 14:31 起 | 网关 `/api/orders/**` 的 502 比例从 0.01% 升到 4.7%，P99 延迟无明显变化 |
| 14:33:40 | 告警「order-service 网关 5xx 比例 > 2%，持续 2 分钟」触发，值班收到电话 |
| 14:36:05 | 滚动结束，502 比例回落到 0.01% |
| 14:50 | 客服反馈多名用户提交订单提示「系统繁忙，请稍后重试」；支付平台回调订单服务失败，进入对方的重试队列 |

网关（NGINX Gateway Fabric，数据面是 nginx）在这 6 分钟里共返回 3,412 个 502，几乎全是 `POST`：nginx 默认只对幂等请求做 `proxy_next_upstream` 重试，`GET` 失败会自动换一个后端，用户无感。

---

## 二、影响

- **下单失败**：约 1,900 次 `POST /api/orders` 返回 502，客户端未自动重试，部分用户放弃下单；按当时客单价估算影响 GMV 约 30 万元
- **支付回调失败**：约 260 次支付回调被拒，依赖支付平台 15 分钟后的重试才最终一致，期间订单状态停留在「待支付」，有 11 个用户重复支付，事后退款
- **故障等级**：P2（核心链路部分失败，可自动恢复），分级标准见 [故障应急与复盘](/high-avail/11_incident_response)
- **隐性影响**：过去三个月每次发布都有类似波动，只是量小没有触发告警

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

502 的起止时间与新 ReplicaSet 的扩缩时间完全重合，先排除下游数据库、Redis 抖动，聚焦发布过程本身。

### 2、看网关错误日志：502 打到了谁

```bash
kubectl -n nginx-gateway logs deploy/nginx-gateway -c nginx --since=2h \
  | grep -E 'upstream' | grep '14:3' | awk -F'upstream: ' '{print $2}' | cut -d/ -f3 | sort | uniq -c
```

示例输出：

```text
    412 10.244.3.27:8080
    398 10.244.5.14:8080
    ...
     61 10.244.1.83:8080
     57 10.244.2.40:8080
```

再看两类原始错误：

```text
2026/08/20 14:31:02 [error] 31#31: *88213 connect() failed (111: Connection refused) while connecting to upstream, client: 10.0.8.15, server: api.example.com, request: "POST /api/orders HTTP/1.1", upstream: "http://10.244.3.27:8080/api/orders"
2026/08/20 14:31:47 [error] 31#31: *90127 connect() failed (111: Connection refused) while connecting to upstream, client: 10.0.8.22, server: api.example.com, request: "POST /api/orders HTTP/1.1", upstream: "http://10.244.1.83:8080/api/orders"
```

对照 `kubectl get pod -o wide`：数量大的 IP（每个 400 左右）是**新 Pod**，数量小的 IP（每个 60 左右）是**正在下线的旧 Pod**。两类 Pod 都在「端口没在监听」时收到了请求，是两个独立的问题。

### 3、新 Pod：为什么没启动完就有流量

```bash
kubectl -n order get pod -l app=order-service -w \
  -o custom-columns=NAME:.metadata.name,READY:.status.containerStatuses[0].ready,START:.status.startTime
kubectl -n order logs order-service-6c9d7f5b8d-q7m2x | grep -E 'Starting|Started|Tomcat started'
```

示例输出：

```text
NAME                             READY   START
order-service-6c9d7f5b8d-q7m2x   true    2026-08-20T06:30:14Z

2026-08-20T14:30:16.208+08:00  INFO 1 --- [order-service] [main] c.e.order.OrderApplication : Starting OrderApplication v2.31.0 using Java 21.0.8
2026-08-20T14:30:37.105+08:00  INFO 1 --- [order-service] [main] o.s.b.tomcat.TomcatWebServer : Tomcat started on port 8080 (http) with context path '/'
2026-08-20T14:30:37.942+08:00  INFO 1 --- [order-service] [main] c.e.order.OrderApplication : Started OrderApplication in 21.734 seconds
```

容器 14:30:14 启动后 1 秒内就是 `READY true`，而 Tomcat 14:30:37 才开始监听，中间约 22 秒新 Pod 已经在 EndpointSlice 里。检查 Deployment：

```bash
kubectl -n order get deploy order-service -o jsonpath='{.spec.template.spec.containers[0]}' | jq '{readinessProbe, livenessProbe, startupProbe, lifecycle}'
```

示例输出：

```json
{
  "readinessProbe": null,
  "livenessProbe": { "tcpSocket": { "port": 8080 }, "initialDelaySeconds": 60, "periodSeconds": 10 },
  "startupProbe": null,
  "lifecycle": null
}
```

**没有 readinessProbe 时，容器一运行就被视为就绪**，Service 立刻把它加入后端。liveness 那个 60 秒的 `initialDelaySeconds` 只是延后检查，不会阻止接流量。

### 4、旧 Pod：为什么停机时还有流量

`lifecycle` 为空，说明没有 `preStop`。拿一个旧 Pod 的停机日志和网关摘除时间对比：

```bash
kubectl -n order logs order-service-7f4b9c6d5-h2k9w --previous | grep -iE 'graceful|shutdown'
kubectl -n nginx-gateway logs deploy/nginx-gateway -c nginx-gateway --since=2h | grep -E 'order-service.*(Reconcil|Endpoint)' | grep '14:31:0'
```

示例输出：

```text
2026-08-20T14:31:07.102+08:00  INFO 1 --- [order-service] [ionShutdownHook] o.s.b.tomcat.GracefulShutdown : Commencing graceful shutdown. Waiting for active requests to complete
2026-08-20T14:31:07.488+08:00  INFO 1 --- [order-service] [tomcat-shutdown] o.s.b.tomcat.GracefulShutdown : Graceful shutdown complete

{"level":"info","ts":"2026-08-20T06:31:10.913Z","msg":"Reconciling the resource","controller":"endpointslice","namespace":"order","name":"order-service-x8f2k"}
```

SIGTERM 到达后 Spring Boot 立即停止接收新连接（0.4 秒就停完了），而网关在约 3.8 秒后才完成 nginx 配置更新、把该 Pod 移出 upstream。**这 3～4 秒里路由到旧 Pod 的请求全部 Connection refused**。

顺带确认了两件事：Dockerfile 用的是 exec 形式 `ENTRYPOINT ["java", ...]`，SIGTERM 能到达 JVM；`server.shutdown` 走 Boot 默认的 `graceful`，在途请求没有被中断。问题不在应用停机，而在**停机比摘流量早**。

### 5、在预发环境复现

```bash
# 终端 1：持续压测下单接口，统计非 2xx
hey -z 180s -c 20 -m POST -H 'Content-Type: application/json' -D order.json https://staging-api.example.com/api/orders
# 终端 2：触发一次滚动
kubectl -n order rollout restart deployment/order-service
```

示例输出：

```text
Status code distribution:
  [201] 41873 responses
  [502] 196 responses
```

复现稳定，修复后用同一脚本验证。

---

## 四、根因

| 环节 | 缺陷 | 窗口 |
|------|------|------|
| 新 Pod 上线 | 没有 readinessProbe，容器启动即就绪，Spring 上下文还在初始化 | 每个新 Pod 约 22 秒 |
| 旧 Pod 下线 | 没有 preStop，摘除 EndpointSlice 与 SIGTERM 并行，应用先于网关完成变更就停止监听 | 每个旧 Pod 约 3～4 秒 |
| 滚动节奏 | `maxUnavailable: 25%`，一次直接停 2 个旧 Pod，同时新 Pod 又不可用，实际可用实例数降到 6 个以下 | 放大上述两个窗口 |

更深一层：服务模板是两年前从虚拟机部署迁移过来的，当时只加了 liveness 防止进程假死，发布 502 一直被当作「正常抖动」，没有人追问。

---

## 五、修复

### 1、止血

- 14:40 冻结 order-service 当天剩余发布；网关对 `POST /api/orders` 暂不做重试（非幂等，重试会重复下单）
- 拉取 14:30～14:37 支付平台回调失败清单，调用对账补单接口主动查询支付结果，11 笔重复支付走退款
- 客服统一话术，引导用户在「我的订单」中确认后再重新下单

### 2、Kubernetes 侧

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
      terminationGracePeriodSeconds: 45     # ≥ preStop 10s + 停机超时 25s + 余量
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
                seconds: 10                 # 等网关、kube-proxy 完成摘除再发 SIGTERM
```

`preStop` 使用内置的 `sleep` 动作，不依赖镜像里有 `sh`。探针走业务端口，业务端口卡死时探针能如实失败。

### 3、Spring Boot 侧

```yaml
server:
  shutdown: graceful                        # Boot 4 默认值，显式写出防止被覆盖
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

### 4、验证

预发环境用第三步的压测脚本连续滚动 5 次，`502` 均为 0；生产下一次发布网关 5xx 比例保持在 0.01% 基线。

---

## 六、预防

### 1、监控与告警

```yaml
# 发布窗口的 5xx 不再静默：按上游服务统计网关 502/503/504
- alert: GatewayUpstream5xxDuringRollout
  expr: |
    sum by (service) (rate(nginx_gateway_upstream_responses_total{code=~"50[234]"}[2m]))
      / sum by (service) (rate(nginx_gateway_upstream_responses_total[2m])) > 0.005
  for: 1m
  labels: { severity: warning }
  annotations:
    summary: "{{ $labels.service }} 网关 5xx 比例超过 0.5%，检查是否正在发布"
```

指标名以所用网关的 exporter 为准；关键是告警阈值按「发布也不允许出错」设定，并在 Grafana 上叠加发布事件注解，方便一眼对上时间线。

### 2、准入规则

- 用 Kyverno / OPA Gatekeeper 写准入策略：`Deployment` 必须定义 `readinessProbe`、`lifecycle.preStop`，`maxUnavailable` 不得大于 0（单副本服务除外）
- CI 中加入 kube-linter 等静态检查，`no-readiness-probe` 一类规则失败直接阻断合并
- 服务模板（Helm Chart）统一内置上面的探针、preStop 和宽限期，新服务默认正确

### 3、发布测试

- 预发环境的发布流水线增加「滚动中压测」步骤：发布期间持续发送写请求，任何非 2xx 都让流水线失败
- 混沌演练定期 `kubectl delete pod` 和 `kubectl drain` 节点，验证摘流与停机顺序，见 [混沌工程](/high-avail/10_chaos_engineering)

### 4、接口层兜底

- 下单接口支持幂等 token，客户端对 502/503 可以安全重试，见 [幂等设计](/architecture/3_idempotence)
- 支付回调处理保持幂等，回调失败依赖对方重试与本方对账双保险

---

## 七、涉及知识点

| 知识点 | 文章 |
|--------|------|
| 停机顺序、preStop、PDB 与滚动参数 | [优雅上下线与变更 · 优雅停机](/high-avail/8_graceful_release#一、优雅停机) |
| 三种探针、滚动更新、Pod 终止流程 | [Kubernetes · 探针、滚动更新与优雅终止](/cloud-native/6_kubernetes#四、探针、滚动更新与优雅终止) |
| Actuator 存活 / 就绪探针与健康分组 | [Actuator 监控](/spring-boot/11_actuator#四、存活-就绪探针与健康分组) |
| 滚动、蓝绿、金丝雀与上线检查单 | [发布策略](/devops/7_release_strategy) |
| SIGTERM 与 SIGKILL | [Linux 概览 · 进程与信号](/cloud-native/1_linux#五、进程与信号) |
| 故障分级与复盘 | [故障应急与复盘](/high-avail/11_incident_response) |

---

## 小结

- 发布 502 有两个窗口：新 Pod 没就绪先接流量（缺 readinessProbe），旧 Pod 停机早于摘流（缺 preStop）
- 网关错误日志按 upstream IP 归类，对照新旧 Pod，能很快区分这两个窗口
- 修复组合：startup / readiness / liveness 三探针 + `preStop sleep` + 足够的 `terminationGracePeriodSeconds` + `maxUnavailable: 0`
- 「发布正常抖动」不存在：用准入策略和滚动压测把零错误发布变成默认值

## 参考资料

- Pod 终止流程与探针：[Kubernetes: Pod Lifecycle](https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/)
- preStop 与 sleep 动作：[Kubernetes: Container Lifecycle Hooks](https://kubernetes.io/docs/concepts/containers/container-lifecycle-hooks/)
- 探针配置：[Kubernetes: Configure Liveness, Readiness and Startup Probes](https://kubernetes.io/docs/tasks/configure-pod-container/configure-liveness-readiness-startup-probes/)
- 滚动更新参数：[Kubernetes: Deployments](https://kubernetes.io/docs/concepts/workloads/controllers/deployment/)
- 优雅停机：[Spring Boot Reference: Graceful Shutdown](https://docs.spring.io/spring-boot/reference/web/graceful-shutdown.html)
- Kubernetes 探针端点：[Spring Boot Reference: Kubernetes Probes](https://docs.spring.io/spring-boot/reference/actuator/endpoints.html#actuator.endpoints.kubernetes-probes)
- nginx 失败重试规则：[nginx: proxy_next_upstream](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_next_upstream)

> 下一篇：[容器被 OOMKilled](./15_oom_killed)
