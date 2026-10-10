---
description: 实验原则、ChaosBlade / Chaos Mesh、故障注入实战与检查单
---

# 混沌工程

> 前置阅读：[多活与容灾](./9_multi_active)

**混沌工程（Chaos Engineering）通过在可控范围内主动注入故障，提前发现系统的脆弱点，并验证冗余、熔断、降级、切流等平时不执行的预案确实有效。** 本篇讲实验流程与原则，以及如何用 ChaosBlade 与 Chaos Mesh 注入常见故障。

---

## 一、实验流程

**每次实验都从一个可证伪的稳态假设开始，以修复加固结束，形成闭环。**

| 对比 | 传统测试 | 混沌工程 |
|------|---------|---------|
| 目标 | 验证功能是否符合预期 | 发现系统在异常条件下的未知弱点 |
| 输入 | 构造的正常 / 异常输入 | 真实世界会发生的故障（宕机、延迟、丢包、资源耗尽） |
| 环境 | 测试环境 | 从预发逐步推进到生产 |
| 结果判定 | 用例通过 / 失败 | 稳态指标是否偏离假设 |

![混沌工程实验流程](../assets/high-avail/chaos-engineering-flow.svg)

| 阶段 | 输出物 |
|------|--------|
| ① 建立假设 | 稳态指标与基线，如"下游延迟 +300ms 时，下单成功率仍 > 99.9%、P99 < 500ms" |
| ② 设计实验 | 故障类型、注入目标、爆炸半径、终止条件、回滚方案 |
| ③ 注入故障 | 用 ChaosBlade / Chaos Mesh 执行，设置自动恢复时间 |
| ④ 观察指标 | 对比监控面板与告警，验证假设是否成立 |
| ⑤ 修复加固 | 补充超时、熔断、副本、告警阈值，然后重新实验 |

---

## 二、实验原则

**混沌工程是科学实验，不是随机搞破坏；最重要的是控制爆炸半径。**

- **围绕稳态建立假设**：关注业务指标（成功率、订单量、P99），而不是 CPU、内存这类内部指标
- **模拟真实事件**：注入真实会发生的故障，如实例宕机、网络延迟、依赖超时、磁盘写满
- **最小爆炸半径**：从单实例、小比例流量开始，逐步扩大；每个实验都要有明确的终止条件
- **可随时终止**：实验命令设置超时自动恢复，并准备一键回滚；稳态指标越过阈值立即停止
- **逐步走向生产**：先测试环境，再预发，再生产低峰期；只在预发做的实验发现不了生产特有问题
- **持续自动化**：把验证过的实验纳入例行演练，防止新版本让已修复的弱点复现

---

## 三、ChaosBlade

**ChaosBlade 是阿里开源的故障注入工具，覆盖主机（CPU、内存、网络、磁盘）、JVM 方法级和容器层，无需修改业务代码。**

### 1、安装

```bash
# 版本以 GitHub Release 页为准
wget https://github.com/chaosblade-io/chaosblade/releases/download/v1.7.4/chaosblade-1.7.4-linux-amd64.tar.gz
tar -xzf chaosblade-1.7.4-linux-amd64.tar.gz
cd chaosblade-1.7.4
```

### 2、主机层实验

```bash
# CPU 满载：1 个核跑到 80%，300 秒后自动恢复
./blade create cpu load --cpu-percent 80 --cpu-count 1 --timeout 300

# 网络延迟：访问 10.0.0.1:8080 的出流量增加 200ms
./blade create network delay --time 200 --interface eth0 \
  --remote-port 8080 --destination-ip 10.0.0.1 --timeout 300

# 网络丢包：eth0 丢包 30%（注意别把自己的 SSH 连接也丢掉，可用 --exclude-port 22）
./blade create network loss --percent 30 --interface eth0 --exclude-port 22 --timeout 300

# 磁盘填充：/data 目录写到 90%
./blade create disk fill --path /data --percent 90 --timeout 300
```

### 3、JVM 层实验

**JVM 类实验要先 `prepare` 把 ChaosBlade Agent 挂载到目标 Java 进程，然后才能 `create`。**

```bash
# 1. 挂载 Agent 到目标 JVM（也可用 --process <进程关键字>），记下返回的 uid
./blade prepare jvm --pid 12345

# 2. 方法延迟：OrderService.queryOrder 每次调用延迟 3s
./blade create jvm delay --time 3000 \
  --classname com.example.OrderService --methodname queryOrder --pid 12345

# 3. 方法抛异常
./blade create jvm throwCustomException \
  --classname com.example.OrderService --methodname queryOrder \
  --exception java.lang.RuntimeException --exception-message "chaos inject" --pid 12345
```

### 4、管理实验

```bash
./blade status --type create     # 查看已创建的实验
./blade destroy <experimentUid>  # 销毁实验，恢复正常
./blade revoke <prepareUid>      # 卸载 JVM Agent（prepare 的逆操作）
```

### 5、示例：验证熔断是否生效

**假设**：库存服务 `checkStock` 变慢到 800ms 时，下单接口的熔断在 10s 内打开，接口走降级返回，整体成功率不下降。

```bash
# 步骤 1：对库存服务注入 800ms 延迟（超过 Sentinel 慢调用阈值 500ms），10 分钟后自动恢复
./blade prepare jvm --pid <inventory-pid>
./blade create jvm delay --time 800 \
  --classname com.example.InventoryService --methodname checkStock \
  --pid <inventory-pid> --timeout 600

# 步骤 2：对下单接口施加正常水平的压力
ab -n 5000 -c 20 http://localhost:8080/api/orders/1

# 步骤 3：观察 Sentinel Dashboard 与监控：熔断是否打开、降级量与成功率是否符合假设
# 步骤 4：销毁实验，确认熔断经半开探测后自动恢复为关闭
./blade destroy <experimentUid>
```

---

## 四、Chaos Mesh

**Chaos Mesh 是 CNCF 项目，用 Kubernetes CRD 声明混沌实验，适合云原生环境。**

### 1、安装

```bash
helm repo add chaos-mesh https://charts.chaos-mesh.org
helm install chaos-mesh chaos-mesh/chaos-mesh \
  --namespace=chaos-mesh --create-namespace \
  --version 2.6.3
```

### 2、一次性实验

```yaml
# Pod 随机终止：模拟实例宕机
apiVersion: chaos-mesh.org/v1alpha1
kind: PodChaos
metadata:
  name: pod-kill-order
  namespace: production
spec:
  action: pod-kill
  mode: one                       # 每次随机选 1 个 Pod
  selector:
    namespaces: [production]
    labelSelectors:
      app: order-service
```

```yaml
# 网络延迟：order-service → inventory-service 增加 300ms
apiVersion: chaos-mesh.org/v1alpha1
kind: NetworkChaos
metadata:
  name: network-delay-order
  namespace: production
spec:
  action: delay
  mode: all
  selector:
    labelSelectors:
      app: order-service
  delay:
    latency: "300ms"
    jitter: "50ms"                # ±50ms 随机抖动
    correlation: "25"
  direction: to                   # 对发往 target 的流量注入
  target:
    mode: all
    selector:
      labelSelectors:
        app: inventory-service
  duration: "5m"                  # 5 分钟后自动恢复
```

```yaml
# CPU 压力：选中 Pod 的 CPU 负载 70%
apiVersion: chaos-mesh.org/v1alpha1
kind: StressChaos
metadata:
  name: cpu-stress-order
  namespace: production
spec:
  mode: one
  selector:
    labelSelectors:
      app: order-service
  stressors:
    cpu:
      workers: 2
      load: 70
  duration: "3m"
```

### 3、周期性实验：Schedule

**Chaos Mesh 2.x 已移除实验对象里的 `scheduler.cron` 字段，周期执行改用独立的 `Schedule` CRD 包裹实验定义。**

```yaml
apiVersion: chaos-mesh.org/v1alpha1
kind: Schedule
metadata:
  name: pod-kill-order-every-10m
  namespace: production
spec:
  schedule: "@every 10m"          # 支持 cron 表达式
  type: PodChaos                  # 被调度的实验类型
  historyLimit: 5                 # 保留最近 5 次实验记录
  concurrencyPolicy: Forbid       # 上一次未结束时不启动新实验
  podChaos:                       # 字段名为实验类型的小驼峰形式
    action: pod-kill
    mode: one
    selector:
      namespaces: [production]
      labelSelectors:
        app: order-service
```

```bash
kubectl apply -f pod-kill-order.yaml                          # 创建实验
kubectl get podchaos,networkchaos,stresschaos,schedule -n production
kubectl delete schedule pod-kill-order-every-10m -n production  # 删除 CR 即停止
```

多个实验按顺序或并行编排（如"先注入延迟，再杀 Pod"）可用 `Workflow` CRD。

---

## 五、常见实验场景

| 场景 | 故障类型 | 验证目标 |
|------|---------|---------|
| 实例宕机 | Pod Kill / 进程终止 | 健康检查摘除与故障转移是否及时，见 [冗余与故障转移](./2_redundancy_failover) |
| 慢下游 | 网络延迟、JVM 方法延迟 | 超时与熔断是否生效，见 [熔断](./5_circuit_breaking) |
| 依赖不可用 | 网络丢包 100%、方法抛异常 | 降级是否返回有意义的兜底数据，见 [降级](./6_degradation) |
| 流量洪峰 | 压测 + CPU 压力 | 限流与过载保护是否生效、扩容是否及时，见 [限流与过载保护](./7_rate_limiting) |
| 连接池耗尽 | DB 访问方法延迟 | 获取连接超时与舱壁隔离是否生效，见 [超时、重试与隔离](./4_timeout_retry_bulkhead) |
| 发布中断 | 滚动发布期间杀 Pod | 优雅停机与重试是否做到无损，见 [优雅上下线与变更](./8_graceful_release) |
| 磁盘写满 | 磁盘填充 | 日志滚动与磁盘告警是否及时触发 |
| 机房故障 | 整个可用区网络隔离 | 切流预案与 RTO 是否达标，见 [多活与容灾](./9_multi_active) |

---

## 六、实验检查单

**实验前**：

- [ ] 已在测试 / 预发环境验证过实验脚本
- [ ] 已通知相关团队与值班人员，避免误判为真实故障
- [ ] 稳态指标有实时监控面板，终止条件已写明（如成功率 < 99.5% 立即停止）
- [ ] 实验命令设置了自动恢复时间，回滚命令随时可执行

**实验中**：

- [ ] 实时观察成功率、延迟、错误率
- [ ] 指标越过终止条件立即停止实验
- [ ] 记录关键时间点、截图与数据

**实验后**：

- [ ] 确认系统回到稳态，残留的实验对象已清理（`blade status`、`kubectl get`）
- [ ] 记录发现的脆弱点，建立改进项并指定负责人
- [ ] 改进项完成后重跑同一实验，验证修复有效

---

## 小结

- 混沌工程通过可控的故障注入验证高可用措施，核心是"稳态假设 + 最小爆炸半径 + 可随时终止"
- ChaosBlade 覆盖主机与 JVM 层，JVM 实验前必须 `blade prepare jvm --pid` 挂载 Agent，实验建议加 `--timeout` 自动恢复
- Chaos Mesh 用 CRD 声明实验，2.x 起周期性实验使用 `Schedule` CRD，编排用 `Workflow`
- 实验场景应覆盖实例宕机、慢下游、依赖不可用、流量洪峰、发布中断和机房故障
- 每个发现的弱点都要形成改进项并重跑验证，演练常态化后才能真正降低故障影响

## 参考资料

- [Principles of Chaos Engineering](https://principlesofchaos.org)
- [ChaosBlade](https://github.com/chaosblade-io/chaosblade)
- [Chaos Mesh](https://chaos-mesh.org/docs/)

> 下一篇：[故障应急与复盘](./11_incident_response) —— 故障真的发生时，如何快速止血、恢复，并通过复盘避免再次发生。
