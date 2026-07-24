# 混沌工程

> 参考：[Principles of Chaos Engineering](https://principlesofchaos.org)

混沌工程（Chaos Engineering）通过**主动注入故障**来发现系统脆弱点，在真实故障来临前提升系统韧性。

---

## 一、实验流程

![混沌工程实验流程](../assets/high-avail/chaos-engineering-flow.svg)

| 阶段 | 输出物 |
|------|--------|
| ① 建立假设 | 稳定状态指标基线（成功率 > 99.9%、P99 < 500ms）|
| ② 设计实验 | 故障类型、爆炸半径、回滚方案 |
| ③ 注入故障 | 使用 ChaosBlade / Chaos Mesh 执行 |
| ④ 观察指标 | 对比监控面板与告警，验证假设 |
| ⑤ 修复加固 | 补充限流、熔断、副本、告警阈值 |

**黄金原则**：
- 从最小爆炸半径开始，先在测试环境验证，再逐步推到生产
- 实验前准备好**一键回滚**方案，随时可终止
- 不做"破坏性测试"，做"发现脆弱点的实验"

---

## 二、ChaosBlade（阿里开源）

ChaosBlade 支持 Java / OS / 容器层的故障注入，无需侵入代码。

### 安装

```bash
# 下载 ChaosBlade
wget https://github.com/chaosblade-io/chaosblade/releases/download/v1.7.4/chaosblade-1.7.4-linux-amd64.tar.gz
tar -xzf chaosblade-1.7.4-linux-amd64.tar.gz
cd chaosblade-1.7.4
```

### 常用故障实验

```bash
# 1. CPU 满载（单核 80%）
./blade create cpu load --cpu-percent 80 --cpu-count 1

# 2. 网络延迟（对外访问 order-service 增加 200ms 延迟）
./blade create network delay --time 200 --interface eth0 \
  --remote-port 8080 --destination-ip 10.0.0.1

# 3. 网络丢包（30% 丢包率）
./blade create network loss --percent 30 --interface eth0

# 4. Java 方法延迟（无需改代码，挂载到 JVM）
./blade create jvm methodDelay \
  --classname com.example.OrderService \
  --methodname queryOrder \
  --time 3000   # 注入 3s 延迟

# 5. Java 方法抛出异常
./blade create jvm throwCustomException \
  --classname com.example.OrderService \
  --methodname queryOrder \
  --exception java.lang.RuntimeException \
  --exception-message "chaos inject"

# 6. 查看已创建的实验
./blade status --type create

# 7. 销毁实验（恢复正常）
./blade destroy <experimentId>
```

### 验证 Sentinel 限流是否生效

```bash
# 步骤 1：注入下游延迟，使慢调用比例上升
./blade create jvm methodDelay \
  --classname com.example.InventoryService \
  --methodname checkStock \
  --time 800     # 超过 Sentinel 慢调用阈值 500ms

# 步骤 2：发压（模拟正常流量）
ab -n 1000 -c 20 http://localhost:8080/api/orders/1

# 步骤 3：观察 Sentinel Dashboard → 熔断是否自动触发
# 步骤 4：销毁实验，验证熔断器是否自动恢复
./blade destroy <id>
```

---

## 三、Chaos Mesh（CNCF / Kubernetes 原生）

Chaos Mesh 通过 Kubernetes CRD 管理混沌实验，适合云原生场景。

### 安装

```bash
# Helm 安装
helm repo add chaos-mesh https://charts.chaos-mesh.org
helm install chaos-mesh chaos-mesh/chaos-mesh \
  --namespace=chaos-mesh --create-namespace \
  --version 2.6.3
```

### 故障实验 YAML

```yaml
# 1. Pod 随机终止（模拟实例宕机）
apiVersion: chaos-mesh.org/v1alpha1
kind: PodChaos
metadata:
  name: pod-kill-order
  namespace: production
spec:
  action: pod-kill
  mode: one                       # 每次随机终止 1 个 Pod
  selector:
    namespaces: [production]
    labelSelectors:
      app: order-service
  scheduler:
    cron: "@every 10m"            # 每 10 分钟触发一次
```

```yaml
# 2. 网络延迟（order-service → inventory-service 增加 300ms）
apiVersion: chaos-mesh.org/v1alpha1
kind: NetworkChaos
metadata:
  name: network-delay-order
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
  direction: to                   # 对出流量注入延迟
  target:
    mode: all
    selector:
      labelSelectors:
        app: inventory-service
  duration: "5m"                  # 实验持续 5 分钟
```

```yaml
# 3. CPU 压力（单容器 CPU 使用率 70%）
apiVersion: chaos-mesh.org/v1alpha1
kind: StressChaos
metadata:
  name: cpu-stress-order
spec:
  mode: one
  selector:
    labelSelectors:
      app: order-service
  stressors:
    cpu:
      workers: 2
      load: 70                    # CPU 负载 70%
  duration: "3m"
```

```bash
# 应用实验
kubectl apply -f pod-kill-order.yaml

# 查看实验状态
kubectl get podchaos,networkchaos,stresschaos -n production

# 终止实验（删除 CR 即停止）
kubectl delete podchaos pod-kill-order -n production
```

---

## 四、混沌实验检查单

**实验前**：
- [ ] 已在测试/预发环境验证实验脚本
- [ ] 已通知相关团队（避免误判为真实故障）
- [ ] 有监控面板可实时观察关键指标
- [ ] 有回滚命令随时可执行

**实验中**：
- [ ] 实时观察成功率、延迟、错误率
- [ ] 指标异常超阈值立即终止实验
- [ ] 记录实验过程截图和数据

**实验后**：
- [ ] 恢复并验证系统回到稳定状态
- [ ] 记录发现的脆弱点和改进项
- [ ] 追踪改进项完成情况，闭环后再进行下轮实验

---

## 五、常见实验场景

| 场景 | 故障类型 | 验证目标 |
|------|---------|---------|
| 实例宕机 | Pod Kill | 多副本是否自动故障转移 |
| 慢下游 | 网络延迟注入 | 超时配置 / 熔断是否生效 |
| 依赖不可用 | 网络丢包 100% | 降级 Fallback 是否返回兜底数据 |
| 流量洪峰 | 压测 + CPU 压力 | 限流 / HPA 是否及时扩容 |
| DB 连接池耗尽 | Java 方法延迟 (DB 层) | 连接池超时 / 舱壁隔离是否生效 |
| 磁盘写满 | OS 磁盘填充 | 日志 / 存储告警是否及时触发 |
