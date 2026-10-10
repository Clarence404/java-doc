---
description: 集群架构、核心对象、资源与 QoS、探针与滚动更新、HPA、网络与 DNS、存储、Spring Boot 部署清单
---

# Kubernetes

> 前置阅读：[Docker](./5_docker)

Kubernetes 是声明式容器编排系统，控制器持续把集群实际状态调谐到你提交的期望状态。本篇讲集群架构、核心对象、资源与探针、伸缩、网络与存储，基线为 Kubernetes 1.37。

---

## 一、集群架构

期望状态指要跑几个副本、用哪个镜像、暴露什么端口等。本篇以 Kubernetes 1.37 为基线、containerd 为运行时，最后给出一份可上线的 Spring Boot 部署清单。

![Kubernetes 集群架构](../assets/cloud-native/kubernetes-architecture.svg)

一个集群分为**控制平面**（Control Plane）和**工作节点**（Node）。旧资料里的"Master / Worker"说法已经废弃，控制平面节点的标签是 `node-role.kubernetes.io/control-plane`。

| 组件 | 位置 | 职责 |
|------|------|------|
| `kube-apiserver` | 控制平面 | 集群唯一入口，所有读写都经过它做认证、鉴权、准入校验；其他组件之间不直接通信 |
| `etcd` | 控制平面 | 强一致的键值存储（Raft），保存全部对象；只有 apiserver 直接访问它 |
| `kube-scheduler` | 控制平面 | 给还没分配节点的 Pod 挑节点：先按资源、亲和性、污点过滤，再打分 |
| `kube-controller-manager` | 控制平面 | 运行一组控制器（Deployment、ReplicaSet、Job、Node……），各自 watch 对象并调谐 |
| `cloud-controller-manager` | 控制平面 | 对接云厂商：创建负载均衡、同步节点信息；自建集群可以没有 |
| `kubelet` | 每个节点 | 从 apiserver watch 分配给本节点的 Pod，调用容器运行时启停容器，执行探针，上报状态 |
| `kube-proxy` | 每个节点 | 把 Service 翻译成节点上的转发规则；使用 Cilium 等 eBPF 方案时可以不部署 |
| 容器运行时 | 每个节点 | 通过 CRI 接口被 kubelet 调用，常见为 containerd、CRI-O |

三个插件接口把"可替换的部分"从核心里剥离出去：

- **CRI**（Container Runtime Interface）：容器运行时接口。1.24 起移除了内置的 dockershim，节点上不再需要 Docker Engine；用 `docker build` 构建的镜像是标准 OCI 镜像，照样可以运行
- **CNI**（Container Network Interface）：Pod 网络插件，负责给 Pod 分配 IP、打通跨节点通信，常见的有 Calico、Cilium、Flannel
- **CSI**（Container Storage Interface）：存储驱动，把云盘、NFS、Ceph 等挂载为 Pod 的卷

一个 Deployment 从提交到运行的过程，可以帮助理解组件分工：

1. `kubectl apply` 把清单提交给 apiserver，写入 etcd
2. Deployment 控制器发现新对象，创建 ReplicaSet；ReplicaSet 控制器按副本数创建 Pod（此时 `nodeName` 为空）
3. scheduler 为每个 Pod 选定节点，把结果写回 apiserver
4. 目标节点的 kubelet watch 到这个 Pod，通过 CRI 拉镜像、创建容器，通过 CNI 配置网络，再开始执行探针
5. Pod 就绪后，EndpointSlice 控制器把它的 IP 加入对应 Service 的后端列表

---

## 二、核心对象

所有对象都用同一种结构描述：`apiVersion` + `kind` + `metadata`（名称、命名空间、标签）+ `spec`（期望状态），控制器负责填写 `status`（实际状态）。**标签（label）和选择器（selector）是对象之间关联的唯一纽带**：Deployment 靠选择器认领 Pod，Service 靠选择器找到后端。

### 1、Pod

Pod 是调度的最小单位，里面的一个或多个容器共享网络命名空间（同一个 IP，可以用 `localhost` 互访）和卷。

- **一个 Pod 一个主进程**：Java 服务一个 Pod 只放一个应用容器，扩容靠增加 Pod 数量
- **Init 容器**：在应用容器之前按顺序运行完毕，适合做数据库迁移前置检查、等待依赖
- **原生 Sidecar**（1.33 GA）：写在 `initContainers` 中并设置 `restartPolicy: Always` 的容器，会先于应用容器启动、晚于应用容器退出，适合日志采集、代理等辅助进程
- **Pod 是一次性的**：Pod 被删除或节点故障后不会"复活"，而是由控制器创建一个新 Pod（新名字、新 IP），所以不要直接创建裸 Pod

### 2、工作负载控制器

| 控制器 | 适用场景 | 关键特点 |
|--------|---------|---------|
| Deployment | 无状态服务（绝大多数 Spring Boot 应用） | 通过 ReplicaSet 管理副本，支持滚动更新与回滚 |
| StatefulSet | 有状态服务（数据库、ZooKeeper、Kafka） | Pod 名称固定（`name-0`、`name-1`）、按序启停、每个 Pod 独占自己的 PVC |
| DaemonSet | 每个节点跑一份（日志采集、监控 Agent、CNI 组件） | 新节点加入时自动部署 |
| Job | 一次性任务（数据修复、报表生成） | 运行到成功为止，`backoffLimit` 控制失败重试次数 |
| CronJob | 定时任务 | 按 cron 表达式创建 Job，`timeZone` 指定时区 |

StatefulSet 需要配一个 headless Service（`clusterIP: None`），每个 Pod 才会获得稳定的 DNS 名 `<pod>.<service>.<namespace>.svc.cluster.local`：

```yaml
apiVersion: v1
kind: Service
metadata:
  name: redis
  namespace: demo
spec:
  clusterIP: None              # headless：DNS 直接返回各 Pod 的 IP
  selector:
    app: redis
  ports:
    - name: redis
      port: 6379
---
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: redis
  namespace: demo
spec:
  serviceName: redis           # 关联上面的 headless Service
  replicas: 1
  selector:
    matchLabels:
      app: redis
  template:
    metadata:
      labels:
        app: redis
    spec:
      containers:
        - name: redis
          image: redis:8.2
          args: ["--appendonly", "yes"]
          ports:
            - name: redis
              containerPort: 6379
          volumeMounts:
            - name: data
              mountPath: /data
  volumeClaimTemplates:        # 每个 Pod 各自生成一个 PVC：data-redis-0、data-redis-1……
    - metadata:
        name: data
      spec:
        accessModes: ["ReadWriteOnce"]
        resources:
          requests:
            storage: 10Gi
```

::: warning 生产数据库优先用托管服务或 Operator
StatefulSet 只保证"名字和存储固定"，主从切换、备份恢复、扩容时的数据重平衡都要自己处理。MySQL、PostgreSQL、Kafka 等在生产中建议使用云厂商托管服务，或社区成熟的 Operator（如 CloudNativePG、Strimzi）。
:::

CronJob 示例：每天凌晨 2 点（北京时间）跑一次报表任务，上一次没跑完就跳过本次：

```yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: daily-report
  namespace: demo
spec:
  schedule: "0 2 * * *"
  timeZone: "Asia/Shanghai"
  concurrencyPolicy: Forbid          # 上一个 Job 未结束时不启动新的
  successfulJobsHistoryLimit: 3
  failedJobsHistoryLimit: 3
  jobTemplate:
    spec:
      backoffLimit: 2                # 失败最多重试 2 次
      activeDeadlineSeconds: 3600    # 超过 1 小时强制终止
      template:
        spec:
          restartPolicy: Never
          containers:
            - name: report
              image: registry.example.com/demo/report-job:1.0.0
```

### 3、Service

Pod IP 随时会变，Service 提供一个**稳定的虚拟 IP 和 DNS 名**，并在就绪的 Pod 之间做负载均衡。

| 类型 | 访问范围 | 典型用途 |
|------|---------|---------|
| `ClusterIP`（默认） | 仅集群内 | 服务间调用 |
| `NodePort` | 每个节点的固定端口（默认 30000–32767） | 测试环境、无云 LB 的自建集群 |
| `LoadBalancer` | 云厂商分配外部负载均衡 | 直接对外暴露 TCP / UDP 服务 |
| `ExternalName` | 集群内 DNS 别名（CNAME） | 把外部域名映射成集群内服务名 |
| Headless（`clusterIP: None`） | DNS 直接返回 Pod IP | StatefulSet、需要客户端自己做负载均衡的场景 |

HTTP 服务对外暴露一般不直接用 `LoadBalancer`，而是让流量先经过 Ingress 或 Gateway API 做域名、路径路由和 TLS 终止，见 [Nginx、Ingress 与 Gateway API](./7_nginx_ingress)。

### 4、ConfigMap 与 Secret

- **ConfigMap**：非敏感配置，可以作为环境变量注入（`envFrom` / `valueFrom`）或挂载成文件
- **Secret**：敏感配置，用法与 ConfigMap 相同，但 kubelet 只把它下发到用到它的节点，并且挂载在内存文件系统中

::: warning Secret 默认只是 base64 编码
Secret 在 etcd 里默认是明文存储（base64 不是加密），能读 Secret 的人就能拿到原文。生产环境至少要做三件事：用 RBAC 限制 Secret 的读取权限；在 apiserver 开启静态加密（EncryptionConfiguration，最好对接 KMS）；不要把 Secret 清单提交到 Git，改用 External Secrets Operator 从 Vault / 云 KMS 同步。密钥管理的通用做法见 [数据安全](/security/7_data_security)。
:::

**以环境变量注入的配置不会热更新**，修改 ConfigMap 后需要重启 Pod（`kubectl rollout restart`）；以卷挂载的文件会在一段时间（kubelet 同步周期，约 1 分钟）后更新，但使用 `subPath` 挂载的文件不会更新。

### 5、Namespace 与标签

Namespace 用来按团队或环境隔离资源，配额（ResourceQuota）、默认资源限制（LimitRange）和大部分 RBAC 授权都以 Namespace 为边界。推荐给所有对象打上 `app.kubernetes.io/name`、`app.kubernetes.io/version` 等官方推荐标签，便于监控和工具识别。

---

## 三、资源模型与 QoS

JVM 容器内存参数见 [GC 调优](/jvm/6_gc_tuning)，这里只讲 Kubernetes 一侧怎么配。

### 1、requests 与 limits

| 字段 | 作用于 | CPU 超出时 | 内存超出时 |
|------|-------|-----------|-----------|
| `requests` | 调度：节点剩余可分配资源 ≥ requests 才能调度上去 | — | — |
| `limits` | 运行时：通过 cgroup 限制 | 被限流（throttling），进程变慢但不会被杀 | 被内核 OOM Killer 杀掉，状态为 `OOMKilled`，退出码 137 |

CPU 单位 `1` = 1 核，`500m` = 0.5 核；内存用 `Mi` / `Gi`（二进制单位，`1Gi` = 1024Mi）。

### 2、QoS 等级

Kubernetes 根据 requests / limits 的写法自动给 Pod 分配 QoS 等级，节点内存不足时按等级决定先驱逐谁：

| QoS | 条件 | 驱逐优先级 |
|-----|------|-----------|
| Guaranteed | 每个容器的 CPU 和内存都设置了 limits，且 requests = limits | 最后被驱逐 |
| Burstable | 至少一个容器设置了 requests 或 limits，但不满足 Guaranteed | 居中 |
| BestEffort | 所有容器都没设 requests 和 limits | 最先被驱逐 |

**核心服务至少做到内存 requests = limits**：内存是不可压缩资源，requests 小于 limits 意味着节点超卖，内存紧张时容易被驱逐。CPU 是否设置 limit 有争议：设了会在突发流量时被限流，导致延迟毛刺；不设则 Pod 可以用满节点空闲 CPU，但需要合理的 requests 保证调度公平。

::: tip 原地调整资源
1.35 起"原地调整 Pod 资源"（In-Place Pod Resize）进入 GA：修改运行中 Pod 的 CPU / 内存不再必须重建 Pod。但 JVM 的堆大小在启动时就确定了，调大内存 limit 并不会让堆变大，Java 服务调整内存规格仍然应该滚动重启。
:::

### 3、JVM 在容器里

容器里的 JVM 最常见的问题不是 GC 慢，而是**进程总内存超过 limit 被 OOMKilled**——此时既没有 Java 的 `OutOfMemoryError` 日志，也没有堆 dump。要点如下，参数的具体取值见 [GC 调优 · 容器环境](/jvm/6_gc_tuning) 与 [JVM 层性能策略](/high-perf/5_jvm_tuning)：

- **堆按比例设置**：用 `-XX:MaxRAMPercentage` 代替固定 `-Xmx`，JVM 会按容器内存 limit 计算堆大小；通常取 50～75，堆外内存（元空间、线程栈、直接内存、Code Cache）多的应用取低值
- **cgroup v2**：新节点基本都是 cgroup v2，JDK 需要 11.0.16+ / 17+ 才能正确识别 v2 的内存与 CPU 限制，否则会按宿主机内存算堆
- **CPU 核数**：JVM 按 CPU limit 计算 `availableProcessors()`，并据此决定 GC 线程数、`ForkJoinPool` 并行度；**不设 CPU limit 时 JVM 会看到整台节点的核数**，GC 线程和线程池都会偏大，此时用 `-XX:ActiveProcessorCount` 显式指定
- **小规格容器**：CPU < 2 或内存 < 1792MB 时 JVM 默认选 Serial GC，生产环境显式指定收集器
- **OOM 后退出**：加 `-XX:+ExitOnOutOfMemoryError`，让 Kubernetes 重启容器，而不是带着残缺状态继续运行

JVM 参数推荐通过 `JAVA_TOOL_OPTIONS` 环境变量传入，JVM 启动时会自动读取，不需要改镜像的启动命令。

---

## 四、探针、滚动更新与优雅终止

探针设计与优雅停机的完整论证在 [冗余与故障转移](/high-avail/2_redundancy_failover) 和 [优雅上下线与变更](/high-avail/8_graceful_release)，这里只讲 Kubernetes 一侧怎么配。

### 1、三种探针

| 探针 | 回答的问题 | 失败后果 |
|------|-----------|---------|
| `startupProbe` | 启动完成了吗 | 超过阈值则重启容器；成功之前不执行另外两个探针 |
| `livenessProbe` | 进程还活着吗 | 重启容器 |
| `readinessProbe` | 现在能接流量吗 | 从 Service 后端摘除，不重启 |

**liveness 绝不能检查数据库、Redis 等外部依赖**：依赖一抖动，所有 Pod 会被同时重启，把局部故障放大成全量重启。readiness 是否包含共享依赖、为什么推荐只看应用自身状态，完整论证见 [冗余与故障转移 · Kubernetes 探针](/high-avail/2_redundancy_failover)。

Spring Boot 的 Actuator 直接提供了对应的端点：`/actuator/health/liveness`、`/actuator/health/readiness`，开启 `management.endpoint.health.probes.add-additional-paths=true` 后还会在**业务端口**上暴露 `/livez`、`/readyz`。探针应该走业务端口，否则业务端口卡死时独立管理端口的探针仍可能返回成功。健康分组怎么配见 [Actuator 监控](/spring-boot/7_actuator)。

启动慢的 Java 服务用 `startupProbe` 兜住启动时间，而不是把 liveness 的 `initialDelaySeconds` 设得很大：前者启动一完成就切换到正常的 liveness 检查，后者在整个运行期间都放宽了故障检测。

### 2、滚动更新

![Deployment 滚动更新](../assets/cloud-native/kubernetes-rolling-update.svg)

修改 Deployment 的 Pod 模板（例如换镜像）会触发滚动更新：Deployment 创建一个新的 ReplicaSet，逐步扩容新 ReplicaSet、缩容旧 ReplicaSet。节奏由两个参数控制：

- **`maxSurge`**：更新期间最多比 `replicas` **多**出几个 Pod，决定"先起新的"的速度
- **`maxUnavailable`**：更新期间最多允许几个 Pod **不可用**，决定"先停旧的"的速度

线上服务常用 `maxSurge: 1, maxUnavailable: 0`：每次先起一个新 Pod，**等它通过 readinessProbe** 后再删一个旧 Pod，可用实例数始终不减少。如果新版本一直无法就绪，滚动会停在原地，旧 Pod 继续服务；超过 `progressDeadlineSeconds`（默认 600 秒）后 Deployment 被标记为失败，但**不会自动回滚**，需要执行 `kubectl rollout undo` 或由发布系统处理。`minReadySeconds` 让新 Pod 就绪后再稳定一段时间才计为可用，可以拦住"刚就绪就崩溃"的版本。

旧的 ReplicaSet 会保留（数量由 `revisionHistoryLimit` 控制，默认 10），回滚就是把旧 ReplicaSet 重新扩容。金丝雀、蓝绿等更精细的发布方式见 [发布策略](/devops/5_release_strategy)。

### 3、优雅终止

Pod 被删除时（滚动更新、缩容、节点排空），**从 Service 后端摘除与向容器发送 SIGTERM 是并行发生的**。kube-proxy、Ingress 控制器感知到摘除需要时间，如果应用收到 SIGTERM 立刻停止，这段时间里打过来的请求就会失败。完整的终止顺序：

1. Pod 被标记为 Terminating，EndpointSlice 控制器开始把它从 Service 后端移除（异步传播）
2. kubelet 执行 `preStop` 钩子：**先等待几秒**，让摘除传播到所有节点和网关
3. `preStop` 结束后，kubelet 向容器的 PID 1 发送 SIGTERM，Spring Boot 开始优雅停机：readiness 置为拒绝流量，不再接新请求，等待在途请求处理完
4. 从步骤 1 开始计时，超过 `terminationGracePeriodSeconds`（默认 30 秒）仍未退出，kubelet 发送 SIGKILL

所以 `terminationGracePeriodSeconds` 必须 ≥ `preStop` 等待时间 + 应用停机超时（`spring.lifecycle.timeout-per-shutdown-phase`，默认 30 秒）+ 余量。`preStop` 用内置的 `sleep` 动作即可，不依赖镜像里有 `sh`，distroless 镜像也能用。各参数的取值依据、注册中心下线、PDB 与滚动参数的区别，见 [优雅上下线与变更](/high-avail/8_graceful_release)。

::: warning SIGTERM 必须能到达 JVM
Dockerfile 要用 exec 形式 `ENTRYPOINT ["java", "-jar", "app.jar"]`。如果用 shell 形式或包了一层启动脚本，PID 1 是 `sh`，SIGTERM 不会转发给 JVM，应用直到宽限期结束被 SIGKILL 都不知道自己要停机。
:::

---

## 五、弹性伸缩

### 1、HPA

HorizontalPodAutoscaler 按指标自动调整副本数，默认每 15 秒计算一次：

```text
期望副本数 = ceil(当前副本数 × 当前指标值 / 目标指标值)
```

CPU / 内存利用率指标来自 Metrics API，集群需要部署 metrics-server（托管集群一般已内置）；按 QPS、消息堆积量等自定义指标扩缩，需要 Prometheus Adapter 或 KEDA 提供 custom / external metrics。

```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: order-service
  namespace: demo
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: order-service
  minReplicas: 3
  maxReplicas: 10
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 70     # 相对 requests 的百分比
  behavior:
    scaleDown:
      stabilizationWindowSeconds: 300  # 缩容前观察 5 分钟，避免流量波动时反复伸缩
```

使用 HPA 时要注意：

- **利用率按 requests 计算**：没设 CPU requests 的 Pod，HPA 无法计算 CPU 利用率
- **Java 服务不宜按内存扩容**：JVM 堆涨上去后通常不会归还给操作系统，内存利用率只升不降，HPA 会只扩不缩
- **清单里删掉 `replicas`**：交给 HPA 管理后，如果 Deployment 清单仍写着 `replicas: 3`，每次 `kubectl apply` 或 GitOps 同步都会把副本数改回 3
- **JVM 预热**：新 Pod 刚启动时 JIT 尚未编译热点代码，CPU 偏高、延迟偏大，可能触发连锁扩容；用 `startupProbe` + readiness 预热、`scaleUp` 策略限速来缓解，见 [优雅上下线与变更 · 服务预热](/high-avail/8_graceful_release)

1.37 中 HPA 缩容到 0 副本的能力进入 Beta，在此之前"闲时缩到 0"一般用 KEDA 实现。

### 2、其他伸缩方式

- **VPA**（Vertical Pod Autoscaler）：根据历史用量推荐或自动调整 requests / limits，适合给不确定规格的服务找基线；不要与基于同一指标的 HPA 同时使用
- **节点伸缩**：Cluster Autoscaler 或 Karpenter 在 Pod 因资源不足 Pending 时加节点、节点空闲时回收，HPA 扩出来的 Pod 才有地方调度

容量规划和压测方法见 [容量评估与规划](/high-con/8_capacity_planning)。

---

## 六、集群网络与 DNS

![一次请求进入集群的路径](../assets/cloud-native/kubernetes-request-path.svg)

### 1、网络模型

Kubernetes 的网络模型只有三条要求，由 CNI 插件实现：

- 每个 Pod 有独立 IP，集群内所有 Pod 之间**不经过 NAT** 直接互通
- 节点与 Pod 之间也能直接互通
- Pod 看到的自己的 IP，与别人访问它用的 IP 相同

### 2、Service 是怎么转发的

Service 的 ClusterIP 是一个虚拟 IP，任何网卡上都没有。真正的转发由每个节点上的 kube-proxy 完成：它 watch Service 和 EndpointSlice，把"ClusterIP:端口 → 一组 Pod IP:端口"翻译成内核规则，连接在**发起方所在节点**上就被改写目标地址并转给某个后端 Pod。

- **EndpointSlice**：记录 Service 背后就绪 Pod 的地址列表，只有 readiness 通过的 Pod 才会被标记为可接收流量。旧的 Endpoints API 在 1.33 已标记弃用
- **kube-proxy 模式**：Linux 上推荐 `nftables` 模式（1.33 GA）；`iptables` 模式仍是默认值，规则多时更新慢；`ipvs` 模式在 1.35 已弃用
- **eBPF 替代**：Cilium 等 CNI 可以完全替代 kube-proxy，在内核中用 eBPF 完成 Service 转发

Service 做的是 **L4 连接级负载均衡**：HTTP/1.1 长连接、gRPC（HTTP/2 多路复用）会一直打在同一个 Pod 上，扩容后新 Pod 分不到流量。gRPC 服务要用客户端负载均衡（headless Service + 客户端解析多个 IP）或服务网格，见 [服务网格](/microservices/3_service_mesh)。

### 3、CoreDNS

集群 DNS 由 CoreDNS 提供，kubelet 会把每个 Pod 的 `/etc/resolv.conf` 指向它。Service 的完整域名是：

```text
<service>.<namespace>.svc.cluster.local
```

同一 Namespace 内直接用 `order-service`，跨 Namespace 用 `order-service.demo`，都能解析，靠的是 `resolv.conf` 里的 search 域。

::: warning ndots:5 带来的额外查询
Pod 默认的 `resolv.conf` 带有 `options ndots:5`：域名中的点少于 5 个时，会先依次拼接各个 search 域去查询，全部失败后才查原始域名。访问 `api.example.com` 这类外部域名，一次解析可能变成 4～5 次 DNS 查询，DNS 压力大时会表现为调用外部接口偶发超时。外部域名可以写成以点结尾的完整形式（`api.example.com.`），或在 Pod 的 `dnsConfig` 里把 `ndots` 调小。
:::

DNS 协议本身、Java 的 DNS 缓存（`networkaddress.cache.ttl`）见 [DNS](/protocols/4_dns)。

### 4、南北向与东西向流量

- **南北向**（集群外 → 集群内）：外部负载均衡 → Ingress 控制器或 Gateway API 实现 → Service → Pod。社区的 ingress-nginx 控制器已于 2026 年 3 月停止维护，新集群推荐使用 Gateway API，见 [Nginx、Ingress 与 Gateway API](./7_nginx_ingress)
- **东西向**（服务之间）：默认直接走 Service；需要 mTLS、细粒度流量治理时引入服务网格，见 [服务网格](/microservices/3_service_mesh)
- **网络隔离**：NetworkPolicy 定义哪些 Pod 可以访问哪些 Pod，默认全部放通；需要 CNI 插件支持（Calico、Cilium 支持，Flannel 不支持）

---

## 七、存储

容器文件系统是临时的，容器重启后写入的内容就丢了。需要保留的数据挂载到卷上：

| 卷类型 | 生命周期 | 用途 |
|--------|---------|------|
| `emptyDir` | 与 Pod 相同，Pod 删除即清空 | 临时文件、同一 Pod 内容器间共享文件；`medium: Memory` 时使用内存 |
| `configMap` / `secret` | 跟随对应对象 | 挂载配置文件、证书 |
| `persistentVolumeClaim` | 独立于 Pod | 数据库数据、上传文件等需要持久化的内容 |

持久化存储由三个对象配合：

- **PersistentVolumeClaim（PVC）**：应用的"存储申请单"，写明需要多大、什么访问模式
- **StorageClass**：存储的"类型模板"，指定由哪个 CSI 驱动、以什么参数创建卷（如云盘类型）
- **PersistentVolume（PV）**：实际的卷；有 StorageClass 时，创建 PVC 后由 CSI 驱动**动态创建** PV，不需要手工准备

访问模式中，`ReadWriteOnce`（RWO）表示只能被一个节点挂载读写，云盘基本都是这种；`ReadWriteMany`（RWX）需要 NFS、CephFS 等共享文件系统；`ReadWriteOncePod`（RWOP，1.29 GA）保证只有一个 Pod 能挂载。

::: tip 无状态服务不要依赖本地存储
Spring Boot 服务的日志写 stdout 由日志采集器收集（见 [日志体系](/observability/1_logging)），上传文件写对象存储，会话放 Redis。只有这样，Pod 才能被随意删除、迁移和扩缩。
:::

---

## 八、实战：部署一个 Spring Boot 服务

下面是一份可以直接 `kubectl apply` 的完整清单，包含 Namespace、ConfigMap、Deployment、Service。把镜像地址换成你自己的镜像即可；镜像的构建（Jib、Buildpacks、分层 Dockerfile）见 [Docker](./5_docker)。

先创建数据库密码 Secret（不要写进清单提交到 Git）：

```bash
kubectl create namespace demo
kubectl -n demo create secret generic order-service-db --from-literal=password='change-me'
```

`order-service.yaml`：

```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: demo
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: order-service
  namespace: demo
data:
  SPRING_PROFILES_ACTIVE: "prod"
  SPRING_DATASOURCE_URL: "jdbc:mysql://mysql.demo.svc.cluster.local:3306/orders"
  SPRING_DATASOURCE_USERNAME: "order"
  # 在业务端口暴露 /livez、/readyz，供探针使用
  MANAGEMENT_ENDPOINT_HEALTH_PROBES_ENABLED: "true"
  MANAGEMENT_ENDPOINT_HEALTH_PROBES_ADDADDITIONALPATHS: "true"
  SPRING_LIFECYCLE_TIMEOUTPERSHUTDOWNPHASE: "30s"
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: order-service
  namespace: demo
  labels:
    app.kubernetes.io/name: order-service
spec:
  replicas: 3                       # 启用 HPA 后删除此行
  revisionHistoryLimit: 5
  minReadySeconds: 10
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 1
      maxUnavailable: 0
  selector:
    matchLabels:
      app.kubernetes.io/name: order-service
  template:
    metadata:
      labels:
        app.kubernetes.io/name: order-service
        app.kubernetes.io/version: "1.5.0"
    spec:
      terminationGracePeriodSeconds: 45   # ≥ preStop 10s + 停机超时 30s + 余量
      securityContext:
        runAsNonRoot: true
        runAsUser: 1000
        seccompProfile:
          type: RuntimeDefault
      topologySpreadConstraints:          # 副本尽量分散到不同节点
        - maxSkew: 1
          topologyKey: kubernetes.io/hostname
          whenUnsatisfiable: ScheduleAnyway
          labelSelector:
            matchLabels:
              app.kubernetes.io/name: order-service
      containers:
        - name: app
          image: registry.example.com/demo/order-service:1.5.0   # 用不可变的版本号，不要用 latest
          ports:
            - name: http
              containerPort: 8080
          envFrom:
            - configMapRef:
                name: order-service
          env:
            - name: SPRING_DATASOURCE_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: order-service-db
                  key: password
            - name: JAVA_TOOL_OPTIONS
              value: "-XX:MaxRAMPercentage=75 -XX:+ExitOnOutOfMemoryError"
          resources:
            requests:
              cpu: "1"
              memory: 1Gi
            limits:
              cpu: "2"
              memory: 1Gi                 # 内存 requests = limits，避免超卖
          startupProbe:
            httpGet: { path: /livez, port: http }
            periodSeconds: 5
            failureThreshold: 30          # 最多给 150s 启动时间
          livenessProbe:
            httpGet: { path: /livez, port: http }
            periodSeconds: 10
            failureThreshold: 3
          readinessProbe:
            httpGet: { path: /readyz, port: http }
            periodSeconds: 5
            failureThreshold: 3
          lifecycle:
            preStop:
              sleep:
                seconds: 10               # 等摘除传播完成再发 SIGTERM
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities:
              drop: ["ALL"]
          volumeMounts:
            - name: tmp
              mountPath: /tmp             # 只读根文件系统下，Tomcat 等仍需要可写的临时目录
      volumes:
        - name: tmp
          emptyDir: {}
---
apiVersion: v1
kind: Service
metadata:
  name: order-service
  namespace: demo
spec:
  type: ClusterIP
  selector:
    app.kubernetes.io/name: order-service
  ports:
    - name: http
      port: 80
      targetPort: http
```

几处取舍说明：

- **`runAsUser: 1000`** 要求镜像里的应用文件对该用户可读；Buildpacks 镜像默认就是非 root 用户，自己写的 Dockerfile 要用 `USER` 指定非 root 用户
- **CPU limit 设为 requests 的 2 倍**：允许启动和 JIT 编译阶段短时突发，同时让 JVM 按 2 核计算 GC 线程数；如果去掉 CPU limit，记得在 `JAVA_TOOL_OPTIONS` 里加 `-XX:ActiveProcessorCount=2`
- **`MaxRAMPercentage=75`** 在 1Gi 下堆约 768MB，给堆外留约 256MB；Netty 等直接内存用得多的应用应调低
- **Spring Boot 3.4 起优雅停机默认开启**，不需要再配 `server.shutdown=graceful`；更早的版本要显式开启
- 节点维护时的可用性还需要一个 PodDisruptionBudget，写法见 [优雅上下线与变更](/high-avail/8_graceful_release)

部署并验证：

```bash
kubectl apply -f order-service.yaml
kubectl -n demo rollout status deployment/order-service --timeout=5m
kubectl -n demo get pods -l app.kubernetes.io/name=order-service -o wide
# 从集群内访问 Service，验证 DNS 与转发
kubectl -n demo run curl --rm -it --restart=Never --image=curlimages/curl:8.16.0 -- \
  curl -s http://order-service/readyz
```

多环境的参数化（镜像版本、副本数、资源规格随环境变化）不建议复制多份 YAML，用 Helm 模板化打包见 [Helm](./8_helm)，用 Git 仓库驱动自动同步见 [Argo CD](./9_argocd)。Quarkus 等框架也可以在构建时生成清单，见 [原生镜像与云原生部署](/quarkus/3_native)。

---

## 九、常用命令与故障排查

### 1、kubectl 常用命令

| 目的 | 命令 |
|------|------|
| 查看资源 | `kubectl -n demo get pods -o wide`、`kubectl get deploy,svc,ingress -A` |
| 查看详情与事件 | `kubectl -n demo describe pod <pod>` |
| 查看日志 | `kubectl -n demo logs <pod> -f`；上一次崩溃的日志加 `--previous` |
| 进入容器 | `kubectl -n demo exec -it <pod> -- sh` |
| 临时调试容器 | `kubectl -n demo debug -it <pod> --image=busybox:1.37 --target=app`（镜像里没有 shell 时使用） |
| 应用清单 | `kubectl apply -f order-service.yaml`；先看差异用 `kubectl diff -f order-service.yaml` |
| 发布与回滚 | `kubectl -n demo rollout status / history / undo deployment/order-service` |
| 重启 | `kubectl -n demo rollout restart deployment/order-service`（按滚动策略逐个重建） |
| 资源用量 | `kubectl -n demo top pod`（依赖 metrics-server） |
| 本地转发 | `kubectl -n demo port-forward svc/order-service 8080:80` |

`rollout history` 里的 CHANGE-CAUSE 取自注解 `kubernetes.io/change-cause`，发布时用 `kubectl annotate` 写上版本说明；旧的 `--record` 参数已弃用。

### 2、常见故障

排查顺序固定为：**`get` 看状态 → `describe` 看 Events → `logs`（必要时 `--previous`）看应用输出**。

| 现象 | 常见原因 | 排查与处理 |
|------|---------|-----------|
| `Pending` | 资源不足、节点选择器 / 污点不匹配、PVC 未绑定 | `describe pod` 看 Events 中的 `FailedScheduling` 原因；调小 requests、扩节点或修正 StorageClass |
| `ImagePullBackOff` / `ErrImagePull` | 镜像名或标签错误、私有仓库缺少 `imagePullSecrets`、镜像已被仓库删除 | `describe pod` 看拉取报错；在节点上用 `crictl pull` 复现 |
| `CrashLoopBackOff` | 应用启动即退出：配置错误、依赖连不上、端口冲突 | `logs --previous` 看崩溃前的日志；`describe` 看退出码 |
| `OOMKilled`（退出码 137） | 进程总内存超过 limit | 检查 `MaxRAMPercentage` 与堆外内存，必要时调大 limit；Java 层的 `OutOfMemoryError` 是另一回事 |
| Running 但 `READY 0/1` | readinessProbe 失败 | `describe` 看探针失败信息；`exec` 进去 `curl localhost:8080/readyz` |
| 反复重启但日志正常 | livenessProbe 误杀（Full GC 停顿、启动慢） | 用 `startupProbe` 兜住启动，适当放宽 liveness 的 `failureThreshold` |
| Service 访问不通 | 选择器与 Pod 标签不匹配、`targetPort` 写错 | `kubectl get endpointslices -l kubernetes.io/service-name=order-service` 看后端列表是否为空 |

Java 进程内部的问题（CPU 飙高、线程阻塞、内存泄漏）用 Arthas、jcmd 等工具在容器内诊断，见 [线上诊断](/engineering/4_diagnosis) 与 [JVM 故障排查](/jvm/9_troubleshooting)。集群和应用的指标、日志、告警体系见 [可观测性总览](/observability/0_overview)。

---

## 十、集群的获取方式

| 类别 | 代表 | 适用场景 |
|------|------|---------|
| 本地开发集群 | kind（容器里跑节点）、minikube、k3d | 本机调试清单、CI 中跑集成测试 |
| 轻量发行版 | k3s | 边缘节点、小规格 VPS、资源受限的环境 |
| 自建工具 | kubeadm（官方）、Sealos | 自有机房或云主机上自建集群，需要自己维护升级和 etcd 备份 |
| 托管服务 | EKS、GKE、AKS、阿里云 ACK、腾讯云 TKE | 生产首选，控制平面由云厂商维护，见 [云计算概览](./13_cloud_overview) |
| 多集群管理平台 | Rancher | 统一管理多个集群的权限、监控和应用分发 |

::: tip 版本节奏
Kubernetes 每年发布 3 个小版本，每个小版本约有 14 个月补丁支持（1 年 + 2 个月升级缓冲）。托管集群（EKS / GKE / AKS / ACK / TKE）通常滞后上游 1～2 个小版本，写清单前先用 `kubectl version` 确认服务端版本。
:::

::: warning KubeSphere 开源版已停止分发
KubeSphere 于 2025 年 8 月宣布停止开源版的下载分发与免费技术支持，转向商业版本，部分社区镜像仓库也随之下线。新项目不建议再基于其开源版搭建平台，已有部署需要评估迁移。
:::

---

## 小结

- 集群由控制平面（apiserver、etcd、scheduler、controller-manager）和节点（kubelet、kube-proxy、容器运行时）组成，所有组件只通过 apiserver 交互；1.24 起移除 dockershim，运行时走 CRI
- 无状态服务用 Deployment，有状态用 StatefulSet + headless Service，任务用 Job / CronJob；Service 提供稳定的虚拟 IP 与 DNS 名，Secret 默认不加密
- requests 决定调度，limits 决定运行时上限；内存超限 OOMKilled，CPU 超限被限流；JVM 用 `MaxRAMPercentage` 按容器内存算堆，并注意 CPU limit 对 GC 线程数的影响
- 探针分工：startup 兜启动、liveness 只看自身、readiness 控制流量；滚动更新用 `maxSurge: 1, maxUnavailable: 0`，配合 `preStop` 等待与足够的 `terminationGracePeriodSeconds` 做到无损发布
- HPA 按相对 requests 的利用率扩缩，Java 服务不要按内存扩；Service 是 L4 负载均衡，长连接与 gRPC 需要额外处理；注意 `ndots:5` 对外部域名解析的影响
- 生产优先用托管集群，部署清单用 Helm / GitOps 管理，排查按 get → describe → logs 的顺序

## 参考资料

- Kubernetes 官方文档：[Kubernetes Documentation](https://kubernetes.io/docs/home/)
- Kubernetes 组件：[Kubernetes Components](https://kubernetes.io/docs/concepts/overview/components/)
- Kubernetes v1.37 发布说明：[Kubernetes v1.37 Release](https://kubernetes.io/blog/2026/08/26/kubernetes-v1-37-release/)
- dockershim 移除说明：[Dockershim Removal FAQ](https://kubernetes.io/blog/2022/02/17/dockershim-faq/)
- 资源管理与 QoS：[Resource Management for Pods and Containers](https://kubernetes.io/docs/concepts/configuration/manage-resources-containers/)、[Pod Quality of Service Classes](https://kubernetes.io/docs/concepts/workloads/pods/pod-qos/)
- 探针：[Configure Liveness, Readiness and Startup Probes](https://kubernetes.io/docs/tasks/configure-pod-container/configure-liveness-readiness-startup-probes/)
- Pod 终止流程：[Pod Lifecycle - Termination of Pods](https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/#pod-termination)
- 滚动更新：[Deployments](https://kubernetes.io/docs/concepts/workloads/controllers/deployment/)
- HPA：[Horizontal Pod Autoscaling](https://kubernetes.io/docs/tasks/run-application/horizontal-pod-autoscale/)
- Service 与 kube-proxy：[Service](https://kubernetes.io/docs/concepts/services-networking/service/)、[Virtual IPs and Service Proxies](https://kubernetes.io/docs/reference/networking/virtual-ips/)
- 集群 DNS：[DNS for Services and Pods](https://kubernetes.io/docs/concepts/services-networking/dns-pod-service/)
- 存储：[Persistent Volumes](https://kubernetes.io/docs/concepts/storage/persistent-volumes/)
- Secret 静态加密：[Encrypting Confidential Data at Rest](https://kubernetes.io/docs/tasks/administer-cluster/encrypt-data/)
- 版本支持策略：[Kubernetes Releases](https://kubernetes.io/releases/)
- Spring Boot 部署到 Kubernetes：[Spring Boot - Deploying to Kubernetes](https://docs.spring.io/spring-boot/how-to/deployment/cloud.html#howto.deployment.cloud.kubernetes)

> 下一篇：[Nginx、Ingress 与 Gateway API](./7_nginx_ingress) —— 反向代理、Ingress 与 Gateway API，把集群内的服务暴露给外部流量。
