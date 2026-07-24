# 发布策略

---

## 一、四种发布方式对比

| 发布方式 | 停机时间 | 回滚速度 | 资源成本 | 适用场景 |
|---------|---------|---------|---------|---------|
| **停机发布** | 有 | 快 | 低 | 非核心系统、允许维护窗口 |
| **滚动发布** | 无 | 中 | 低（同等资源） | 大多数无状态服务 |
| **蓝绿发布** | 无 | 极快（秒级） | 高（双倍资源） | 核心系统、追求极速回滚 |
| **金丝雀发布** | 无 | 快 | 低 | 新功能灰度验证，降低风险 |

---

## 二、滚动发布（Rolling Update）

逐步替换旧版本实例，全程有存活实例提供服务。

```yaml
# Kubernetes Deployment 滚动发布配置
spec:
  replicas: 6
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxUnavailable: 1    # 最多允许 1 个 Pod 不可用
      maxSurge: 2          # 最多允许额外创建 2 个 Pod
  template:
    spec:
      containers:
        - name: my-app
          image: registry.example.com/my-app:v2.0.0
          readinessProbe:           # 就绪探针，新 Pod 就绪后才切流量
            httpGet:
              path: /actuator/health
              port: 8080
            initialDelaySeconds: 15
            periodSeconds: 5
            failureThreshold: 3
          lifecycle:
            preStop:
              exec:
                command: ["sh", "-c", "sleep 10"]  # 等待连接排空
```

**注意**：滚动过程中新旧版本并存，接口必须前后向兼容（数据库字段不能直接删除、API 不能破坏性变更）。

---

## 三、蓝绿发布（Blue-Green）

同时维护两套环境（蓝=当前生产，绿=新版本），切换流量完成发布。

![蓝绿发布流量切换示意图](../assets/devops/blue-green-deploy.svg)

```bash
# Kubernetes 蓝绿切换（修改 Service selector）
# 部署绿环境
kubectl apply -f deployment-green.yaml

# 验证绿环境正常
kubectl rollout status deployment/my-app-green

# 切换流量（修改 Service 的 selector）
kubectl patch service my-app \
  -p '{"spec":{"selector":{"version":"green"}}}'

# 出问题立即切回蓝环境（秒级回滚）
kubectl patch service my-app \
  -p '{"spec":{"selector":{"version":"blue"}}}'
```

---

## 四、金丝雀发布（Canary Release）

先将少量流量（如 5%）导入新版本，验证无问题后逐步扩大比例。

```yaml
# Kubernetes + Nginx Ingress 金丝雀配置
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: my-app-canary
  annotations:
    nginx.ingress.kubernetes.io/canary: "true"
    nginx.ingress.kubernetes.io/canary-weight: "10"   # 10% 流量到新版本
spec:
  rules:
    - host: app.example.com
      http:
        paths:
          - path: /
            backend:
              service:
                name: my-app-v2
                port:
                  number: 80
```

**灰度策略**：

| 策略 | 实现方式 | 适用场景 |
|------|---------|---------|
| 按流量比例 | Ingress weight / Istio VirtualService | 通用灰度 |
| 按用户 ID | 网关根据 Header/Cookie 路由 | 内测用户、白名单 |
| 按地域 | 网关根据 IP 归属路由 | 分区域灰度 |
| 按租户 | 网关根据 tenantId 路由 | SaaS 产品分租户灰度 |

```yaml
# Istio VirtualService 金丝雀（按流量比例）
apiVersion: networking.istio.io/v1alpha3
kind: VirtualService
metadata:
  name: my-app
spec:
  http:
    - route:
        - destination:
            host: my-app-v1
          weight: 90
        - destination:
            host: my-app-v2
          weight: 10   # 逐步调整：10 → 30 → 50 → 100
```

---

## 五、发布检查单（上线 SOP）

### 发布前（T-1天）

- [ ] 变更内容已完成 Code Review 并合并
- [ ] 测试环境验证通过（功能测试 + 回归测试）
- [ ] 数据库变更脚本已审核（不锁表、可回滚）
- [ ] 配置变更已确认（Nacos/Apollo 已推送到预发）
- [ ] 回滚方案已准备（镜像 Tag、SQL 回滚脚本）
- [ ] 通知关联团队（测试、运维、客服）

### 发布中

- [ ] 在低峰期执行（非业务高峰）
- [ ] 保持监控大盘打开（错误率、P99、QPS）
- [ ] 每批次发布后等待 5 分钟观察指标
- [ ] 关键接口冒烟测试通过

### 发布后（观察 30 分钟）

- [ ] 错误率 < 发布前基线
- [ ] P99 响应时间无明显上升
- [ ] 核心业务链路验证（下单、支付、查询）
- [ ] 无明显告警触发
- [ ] 更新发布记录（版本号、时间、负责人、变更内容）

---

## 六、回滚 SOP

### 代码回滚

```bash
# 方式一：Kubernetes 快速回滚（推荐）
kubectl rollout undo deployment/my-app
kubectl rollout undo deployment/my-app --to-revision=3  # 回滚到指定版本

# 查看历史版本
kubectl rollout history deployment/my-app

# 方式二：指定老镜像 Tag
kubectl set image deployment/my-app my-app=registry.example.com/my-app:v1.9.0
```

### 数据库回滚

数据库变更必须准备回滚脚本，且发布前已验证可执行：

```sql
-- 发布脚本（正向）
ALTER TABLE orders ADD COLUMN extra_fee DECIMAL(10,2) DEFAULT 0 COMMENT '附加费';

-- 回滚脚本（必须准备）
ALTER TABLE orders DROP COLUMN extra_fee;
```

**原则**：
- 新增列：可回滚（DROP COLUMN）
- 删除列：**发布前不要删**，先让代码不再使用，观察一个发布周期后再删
- 修改列类型：高风险，需评估数据迁移方案

### 配置回滚

Nacos / Apollo 均支持版本历史，一键回滚到上一个版本。

---

## 七、发布复盘模板

每次重大故障或高风险发布后填写：

```
发布时间：2024-01-15 22:00
发布人：张三
版本号：v2.3.1
变更内容：订单超时自动取消功能上线

故障描述（如有）：
  22:30 收到告警，订单创建成功率下降至 85%
  定位原因：Redis 连接池配置未同步到生产环境

影响范围：
  持续时间：30 分钟
  影响订单数：约 1200 笔（已补偿）

根因分析（5Why）：
  1. 为什么成功率下降？Redis 连接超时
  2. 为什么连接超时？连接池耗尽
  3. 为什么连接池耗尽？生产配置比测试环境小 10 倍
  4. 为什么配置不一致？发布检查单未包含配置核对步骤
  5. 为什么没有检查单？缺少标准化发布流程

改进动作：
  [P0] 今日完成：补充发布检查单，加入配置核对步骤
  [P1] 本周完成：配置中心增加环境差异对比功能
  [P2] 下月完成：集成自动化发布前置检查
```
