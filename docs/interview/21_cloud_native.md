---
description: Linux 信号与排查、容器原理与 Java 镜像、Kubernetes 资源探针与发布、Helm 与 GitOps、IaC、云平台
---

# 云原生面试题解答

> 题目清单见 [云原生面试题](/cloud-native/99_interview)；细节见 [云原生总览](/cloud-native/0_overview)。
>
> 版本基线：Kubernetes 1.37（containerd）、Docker Engine + Compose v2、Helm 4、Argo CD 3.x、Gateway API、Terraform 1.16 / OpenTofu 1.13、JDK 21 / 25。

## 一、Linux 与排查

### Q1：kill -15 和 kill -9 有什么区别？停服务该怎么做？

**一句话**：`-15`（SIGTERM）是「请你退出」，进程可以收尾；`-9`（SIGKILL）是内核直接掐断，相当于拔电源，所以要先 15、等超时再 9。

- SIGTERM 能被捕获：JVM 会跑 shutdown hook，Spring Boot 借此优雅停机（不接新请求、等在途请求处理完）
- SIGKILL 不能捕获：处理中的请求、没刷盘的数据都会丢
- 退出码 = 128 + 信号编号：143 是被 SIGTERM 停的，137 是被 SIGKILL 杀的（容器里多半是内存超限）
- systemd 的 `TimeoutStopSec`、K8s 的 `terminationGracePeriodSeconds` 都是「先 15，超时再 9」这套逻辑

**常见坑**：容器里用 shell 形式 `ENTRYPOINT java -jar app.jar`，SIGTERM 只发给 `sh`，JVM 收不到，最后被 SIGKILL。

→ 详见 [Linux 概览](/cloud-native/1_linux#_2、kill-15-与-kill-9)

### Q2：线上 Java 进程 CPU 飙高，怎么定位到具体代码？

**一句话**：先用 `top -Hp` 找到最吃 CPU 的线程，把线程 ID 转成十六进制，再到 `jstack` 输出里按 `nid` 找到这个线程的调用栈。

- `top` 或 `ps --sort=-%cpu` 先确认是哪个 Java 进程
- `top -Hp <pid>`：按线程看 CPU，记下最高的线程 ID（十进制）
- `printf '%x\n' <tid>` 转十六进制，`jstack <pid> | grep -A 20 'nid=0x...'` 看栈
- 多抓几次栈对比，同一位置反复出现才是热点；常见是死循环、正则回溯、频繁 GC
- 嫌手工麻烦就用 Arthas 的 `thread -n 3` 一步出结果

**常见坑**：最热的线程是 GC 线程时，问题在内存（对象分配太多或堆太小），应该转去看 GC 日志。

→ 详见 [Linux 概览](/cloud-native/1_linux#_2、定位-java-进程的高-cpu-线程)

### Q3：报 Too many open files 怎么排查和解决？

**一句话**：Linux 里文件、Socket、管道都占一个文件描述符（fd），进程用的 fd 超过上限就报这个错；先看是不是泄漏，再按进程的启动方式调大限制。

- 看上限：`cat /proc/<pid>/limits` 里的 open files 才是进程实际生效的值
- 看用量：`ls /proc/<pid>/fd | wc -l`，`lsof -p <pid>` 看都开了些什么，数量持续上涨多半是连接或流没关
- systemd 服务改 unit 里的 `LimitNOFILE`；手工启动改 `limits.conf`；容器用 `--ulimit nofile=...`
- HotSpot 启动时会把软限制自动提到硬限制，所以 Java 服务真正要调的是硬限制

**常见坑**：改了 `limits.conf` 却对 systemd 服务无效，因为它不走 PAM 登录流程。

→ 详见 [Linux 概览](/cloud-native/1_linux#六、文件描述符与-ulimit)

### Q4：load average 是什么？多高算高？

**一句话**：load 是 1 / 5 / 15 分钟内「正在跑 + 排队等 CPU + 卡在不可中断 IO」的平均进程数，要和 CPU 核数比着看，持续超过核数才说明忙不过来。

- 8 核机器 load 8 刚好跑满，持续 16 就是每个任务都在排队
- Linux 的 load 把 `D` 状态（不可中断睡眠，通常在等磁盘或网络存储）也算进去，所以 load 高不一定是 CPU 忙
- 配合 `top` 的 `us` / `sy` / `wa` 判断：`wa` 高是 IO 瓶颈，`us` 高是应用算得多
- `vmstat 1` 的 `r` 列是运行队列长度，比 load 更实时
- 看三个数的趋势：1 分钟远大于 15 分钟说明负载正在上升

→ 详见 [Linux 概览](/cloud-native/1_linux#_1、按资源选命令)

## 二、容器

### Q5：容器和虚拟机有什么区别？容器的隔离靠什么实现？

**一句话**：虚拟机虚拟的是硬件，每台有自己的内核；容器只是宿主机上的一组普通进程，用 namespaces 隔离「看得到什么」，用 cgroups 限制「能用多少」，大家共用一个内核。

| 对比项 | 虚拟机 | 容器 |
|-------|-------|------|
| 隔离边界 | 独立内核 | 共享宿主内核 |
| 启动 | 秒到分钟级 | 毫秒到秒级 |
| 体积 | GB 级 | MB 级 |
| 安全隔离 | 强 | 较弱，内核漏洞可能逃逸 |

- namespaces：隔离进程号、网络、挂载点、主机名，容器里只看到自己的进程
- cgroups：限制 CPU、内存、IO 用量，K8s 的 limits 就是落到 cgroup 上
- 云上通常叠加用：K8s 节点本身是虚拟机；隔离要求高时用 gVisor、Kata 这类折中方案

→ 详见 [虚拟化概览](/cloud-native/3_virtual#三、虚拟机与容器)

### Q6：Docker 镜像分层是怎么回事？怎么让构建缓存更有效？

**一句话**：Dockerfile 里每条 `RUN` / `COPY` / `ADD` 产生一个只读层，运行时叠成一个视图，再在最上面加一层容器自己的可写层；某层变了，它后面的层都要重建。

- 写时复制：容器改下层文件时先复制到可写层再改，镜像层永远不变
- 层共享：多个镜像共用相同的层，磁盘和拉取流量只付一次
- 缓存顺序：变化少的放前面，先 `COPY pom.xml` 下载依赖，再 `COPY src`
- 可写层随容器删除，要保留的数据放数据卷

**常见坑**：在后一层删掉前一层的文件，镜像不会变小；下载、使用、清理要写在同一条 `RUN` 里。

→ 详见 [Docker](/cloud-native/5_docker#二、镜像分层)

### Q7：Java 服务的 Dockerfile 怎么写才算合格？

**一句话**：多阶段构建——第一阶段用 Maven + JDK 编译打包，第二阶段只放 JRE 和解压分层后的产物，用非 root 用户、exec 形式启动。

- 最终镜像不含 JDK、Maven 和源码：体积小、攻击面小
- Spring Boot 的 `jarmode=tools` 把 jar 拆成依赖、loader、快照依赖、应用代码四层，平时发版只变最上面一层
- 非 root 运行：容器逃逸时影响更小，K8s 的 `runAsNonRoot` 也要求
- `ENTRYPOINT ["java", ...]` 用 exec 形式，保证 JVM 是 PID 1，收得到 SIGTERM
- 堆用 `-XX:MaxRAMPercentage` 按比例设，参数可以用 `JAVA_TOOL_OPTIONS` 外置

→ 详见 [Docker](/cloud-native/5_docker#_1、多阶段-dockerfile)

### Q8：JVM 跑在容器里要注意什么？为什么会被 OOMKilled 却没有 OOM 日志？

**一句话**：被杀是因为 JVM 进程**总内存**（堆 + 堆外）超过了容器 limit，内核 OOM Killer 直接下手，JVM 来不及打日志和 dump；关键是按比例设堆、给堆外留余量。

- 堆用 `-XX:MaxRAMPercentage`（常取 50～75），别写死 `-Xmx`；堆外多的应用取低值
- 堆外包括元空间、线程栈、直接内存、Code Cache，都算进容器内存
- cgroup v2 需要 JDK 11.0.16+ / 17+ 才能正确识别限制，否则按宿主机内存算堆
- 不设 CPU limit 时 JVM 看到整台节点的核数，GC 线程和线程池偏大，用 `-XX:ActiveProcessorCount` 指定
- 加 `-XX:+ExitOnOutOfMemoryError`，堆溢出时直接退出让 K8s 重启

→ 详见 [Kubernetes](/cloud-native/6_kubernetes#_3、jvm-在容器里)

## 三、Kubernetes

### Q9：Kubernetes 由哪些组件组成？一个 Deployment 是怎么跑起来的？

**一句话**：控制平面负责「决定」（apiserver、etcd、scheduler、controller-manager），每个节点负责「执行」（kubelet、kube-proxy、容器运行时），所有组件都只和 apiserver 打交道。

- apiserver：唯一入口，做认证、鉴权、准入；etcd：存全部对象，只有 apiserver 能直接访问
- scheduler：给 Pod 挑节点；controller-manager：一堆控制器持续把实际状态调成期望状态
- kubelet：在节点上拉镜像、起容器、跑探针；kube-proxy：把 Service 翻译成转发规则
- 流程：`kubectl apply` 写入 etcd → Deployment 控制器建 ReplicaSet → 建 Pod → scheduler 选节点 → kubelet 启动 → 就绪后加入 Service 后端
- CRI / CNI / CSI 三个接口把运行时、网络、存储做成可替换插件

→ 详见 [Kubernetes](/cloud-native/6_kubernetes#一、集群架构)

### Q10：Pod、Deployment、Service 是什么关系？Service 有哪几种类型？

**一句话**：Pod 是跑容器的最小单位，Deployment 管「跑几个、怎么升级」，Service 给一组会变的 Pod 一个稳定的地址和 DNS 名；三者靠标签和选择器关联。

| 类型 | 访问范围 | 用途 |
|------|---------|------|
| ClusterIP（默认） | 仅集群内 | 服务间调用 |
| NodePort | 每个节点的固定端口 | 测试、自建集群 |
| LoadBalancer | 云厂商外部负载均衡 | 直接对外暴露 TCP / UDP |
| Headless | DNS 直接返回 Pod IP | StatefulSet、客户端负载均衡 |

- Pod 是一次性的：挂了由控制器新建一个（新名字、新 IP），不要建裸 Pod
- 集群内 DNS 由 CoreDNS 提供，完整域名 `<service>.<namespace>.svc.cluster.local`，同命名空间直接写服务名
- Service 是 L4 连接级负载均衡，gRPC 这类长连接会一直打在同一个 Pod 上

**常见坑**：Pod 默认 `ndots:5`，访问外部域名会先拼 search 域查好几次，DNS 压力大时表现为偶发超时。

→ 详见 [Kubernetes](/cloud-native/6_kubernetes#_3、service)

### Q11：requests 和 limits 有什么区别？QoS 等级怎么划分？

**一句话**：requests 用来调度（节点剩余资源够才放上去），limits 用来运行时封顶；CPU 超了只是变慢，内存超了直接被杀。

- CPU 超 limit：被限流（throttling），延迟变高但不会死
- 内存超 limit：OOMKilled，退出码 137
- QoS 自动判定：requests = limits 是 Guaranteed（最后被驱逐）；只设部分是 Burstable；都不设是 BestEffort（最先被驱逐）
- 核心服务至少做到内存 requests = limits，内存是不可压缩资源，超卖就容易被驱逐
- CPU limit 设不设有争议：设了突发时有延迟毛刺，不设要靠合理的 requests 保公平

→ 详见 [Kubernetes](/cloud-native/6_kubernetes#三、资源模型与-qos)

### Q12：三种探针分别干什么？liveness 能检查数据库吗？

**一句话**：startup 管「启动完了没」，liveness 管「还活着没」（失败就重启），readiness 管「能不能接流量」（失败就摘流量但不重启）；liveness 绝不能查数据库这类外部依赖。

- startupProbe：成功之前另外两个探针不执行，专门兜住 Java 慢启动
- livenessProbe 查外部依赖的后果：数据库一抖，所有 Pod 同时重启，小故障放大成全量故障
- Spring Boot Actuator 直接提供 `/actuator/health/liveness`、`/readiness`，还能在业务端口暴露 `/livez`、`/readyz`
- 探针走业务端口，否则业务端口卡死时管理端口还在返回成功

**常见坑**：靠把 liveness 的 `initialDelaySeconds` 设很大来等启动，结果整个运行期的故障检测都被放宽了。

→ 详见 [Kubernetes](/cloud-native/6_kubernetes#_1、三种探针)

### Q13：滚动更新怎么做到不中断？Pod 下线时怎么优雅终止？

**一句话**：滚动时用 `maxSurge: 1, maxUnavailable: 0`，新 Pod 就绪了才删旧的；下线时摘流量和发 SIGTERM 是并行的，所以要用 `preStop` 先等几秒，再让应用优雅停机。

- `maxSurge`：最多多出几个 Pod；`maxUnavailable`：最多几个不可用
- 新版本一直不就绪，滚动会卡住，旧 Pod 继续服务；超时只标记失败，**不会自动回滚**，要 `kubectl rollout undo`
- 终止顺序：标记 Terminating 并开始摘流量 → `preStop` sleep 几秒 → SIGTERM → 超过宽限期 SIGKILL
- `terminationGracePeriodSeconds` ≥ preStop 等待 + 应用停机超时 + 余量

**常见坑**：shell 形式启动导致 SIGTERM 到不了 JVM，应用一直不知道要停，宽限期一到被强杀。

→ 详见 [Kubernetes](/cloud-native/6_kubernetes#_3、优雅终止)

### Q14：HPA 是怎么扩缩容的？Java 服务用 HPA 要注意什么？

**一句话**：HPA 每 15 秒按「期望副本数 = 当前副本数 × 当前指标 / 目标指标」算一次，CPU 利用率是相对 requests 算的。

- CPU / 内存指标要装 metrics-server；按 QPS、消息堆积扩缩要用 Prometheus Adapter 或 KEDA
- 没设 CPU requests 的 Pod，HPA 算不出利用率
- Java 不宜按内存扩：堆涨上去一般不还给系统，只扩不缩
- 用 `behavior.scaleDown` 的稳定窗口防止抖动；JVM 预热期 CPU 高，可能触发连锁扩容

**常见坑**：交给 HPA 后清单里还写着 `replicas`，每次 apply 或 GitOps 同步都把副本数改回去。

→ 详见 [Kubernetes](/cloud-native/6_kubernetes#_1、hpa)

### Q15：Ingress 和 Gateway API 有什么区别？新集群选哪个？

**一句话**：两者都是「域名 + 路径转给哪个 Service」的声明标准；Ingress 已冻结、高级能力全靠私有注解，Gateway API 把能力做成标准字段并按角色拆分，新集群直接上 Gateway API。

| 维度 | Ingress | Gateway API |
|------|---------|-------------|
| 状态 | 冻结，不再演进 | 持续迭代，官方推荐 |
| 资源 | Ingress 一个对象 | GatewayClass / Gateway / Route 三层 |
| 灰度、改写 | 私有注解 | 标准字段（如 `weight`） |
| 可移植性 | 差 | 好 |

- 三层分工：基础设施方管 GatewayClass，运维管 Gateway（端口、证书），开发管 HTTPRoute（业务路由）
- 社区版 ingress-nginx 已于 2026 年 3 月停止维护，不再有安全补丁，要排期迁移
- 别和 F5 的 NGINX Ingress Controller 搞混，后者仍在维护

→ 详见 [Nginx、Ingress 与 Gateway API](/cloud-native/7_nginx_ingress#六、ingress-与-gateway-api-对比)

### Q16：Helm 解决什么问题？Chart、Release、revision 是什么？

**一句话**：Helm 是 K8s 的包管理器，把一组 YAML 写成带参数的模板（Chart），一条命令安装、升级、回滚，不同环境只换 values。

- Chart：模板 + 默认 values + 元信息，可以推到 OCI 镜像仓库分发
- Release：Chart 在集群里的一次安装实例；revision：每次 install / upgrade / rollback 生成一个新版本号
- 纯客户端：本地渲染成普通清单提交给 apiserver，历史以 Secret 存在命名空间里，回滚就是取旧版本重新提交
- 和 Kustomize 的区别：Helm 是「模板 + 参数」，Kustomize 是「原始 YAML + 补丁」，没有包和历史

**常见坑**：`helm upgrade` 时 values 合并规则不清楚，漏传 `-f` 导致参数回到默认值。

→ 详见 [Helm](/cloud-native/8_helm#二、核心概念)

### Q17：什么是 GitOps？Argo CD 和在 CI 里直接 kubectl apply 有什么不同？

**一句话**：GitOps 把集群的期望状态放在 Git 里，由集群内的 Argo CD 持续拉取、对比、同步；CI 只负责构建镜像并把新 tag 提交到配置仓库，不再直接碰集群。

| 对比项 | 推送式（CI 部署） | 拉取式（Argo CD） |
|------|------|------|
| 集群凭证 | 在 CI 手里 | 只在集群内 |
| 部署记录 | 流水线日志 | Git 提交历史 |
| 回滚 | 重跑旧流水线 | `git revert` |
| 漂移 | 发现不了 | 持续对比，可自动纠正 |

- 同步状态（Synced / OutOfSync）和健康状态（Healthy / Degraded）是两回事
- 开了自动同步后不能直接 rollback，要改 Git；HPA 改副本这类合理漂移用 `ignoreDifferences` 排除

→ 详见 [Argo CD](/cloud-native/9_argocd#一、gitops-与拉取模型)

## 四、IaC

### Q18：Terraform 的 State 是什么？为什么必须用远程 State 加锁？

**一句话**：State 记录「代码里的资源」对应「云上哪个真实资源 ID」，是 Terraform 算差异的唯一依据；多人协作时必须放远程并加锁，否则会重复建资源或互相覆盖。

- 放本地：别人拿不到，各自 apply 会重复创建
- 远程不加锁：两人同时 apply 互相覆盖 State，资源「失联」（云上有、State 里没有）
- 锁的实现：阿里云 OSS 配 Tablestore；AWS S3 用 `use_lockfile` 原生锁
- State 里有密码等明文：桶要加密、开版本、收紧权限，绝不提交到 Git

**常见坑**：以为 `sensitive = true` 就安全了，它只是让命令行输出打码，值仍以明文写进 State。

→ 详见 [Terraform](/cloud-native/11_terraform#五、state-与状态锁)

### Q19：Terraform 和 Ansible 有什么区别？怎么配合？

**一句话**：Terraform 负责「造机器」（云资源），Ansible 负责「配机器」（机器内部装软件、发应用）；经典组合是 Terraform 建好服务器输出 IP，Ansible 接手部署。

| | Terraform | Ansible |
|---|---|---|
| 阶段 | Provision | Configure |
| 模型 | 声明式，有 State | 按顺序执行任务，模块保证幂等，无 State |
| 语言 | HCL | YAML |

- Ansible 无 Agent：通过 SSH 把模块推到目标机执行，目标机只要 SSH 和 Python
- 幂等：模块描述「应该是什么状态」，已满足就跳过，可以反复执行
- `shell` / `command` 没有幂等保证，能用专用模块就不写裸命令

→ 详见 [Ansible](/cloud-native/12_ansible#一、定位-与-terraform-的分工)

### Q20：「烘焙镜像」和「启动时初始化」怎么选？

**一句话**：烘焙（Bake）是构建期用 Packer 把 JDK、Agent 装进镜像，开机即用；现炸（Fry）是用公共镜像开机后由 cloud-init 现场安装。实践里多用半烘焙：慢变通用的进镜像，每台不同的开机注入。

- 烘焙：启动快、一致性高，适合弹性伸缩；代价是改一行也要重建镜像
- 现炸：改脚本就生效，但每台都要下载安装，受软件源和外网影响
- 进镜像：系统补丁、JDK、监控 Agent、安全基线；开机注入：环境名、配置中心地址、应用版本
- 不可变基础设施：要改就出新镜像滚动替换，不登上去改，避免配置漂移

**常见坑**：把密钥、证书烘焙进镜像，镜像被复制共享后就收不回来，应在运行时从 KMS 读取。

→ 详见 [cloud-init 与 Packer](/cloud-native/12_cloud_init#一、烘焙还是现炸-两种初始化思路)

## 五、云平台

### Q21：IaaS、PaaS、SaaS 的区别是什么？云上安全谁负责？

**一句话**：区别在于「哪几层归你管」：IaaS 你管操作系统往上，PaaS 你只管代码和数据，SaaS 整个软件都是厂商的；但数据、账号和权限永远是你的责任。

| 模型 | 你管的 | 例子 |
|------|------|------|
| IaaS | 操作系统、运行时、应用、数据 | EC2、ECS |
| PaaS | 应用代码、数据、配置 | SAE、App Engine |
| FaaS | 函数代码、数据 | Lambda、函数计算 |
| SaaS | 数据、账号与权限配置 | Microsoft 365、飞书 |

- 托管 K8s 介于 IaaS 和 PaaS 之间：控制面归厂商，节点和应用归你
- 责任共担：桶设成公共读、AccessKey 泄露、安全组放开 22 端口，都是用户侧事故，厂商不兜底

→ 详见 [云计算概览](/cloud-native/13_cloud_overview#_2、服务模型与责任划分)

### Q22：Region、可用区、边缘节点分别是什么？CDN 怎么用？

**一句话**：Region 是地理区域，可用区（AZ）是同一 Region 内电力网络独立的机房，边缘节点是离用户最近的 CDN / DNS 接入点；生产至少跨两个 AZ，静态资源和 TLS 终止下沉到边缘。

- 同 Region 跨 AZ 延迟在毫秒内，适合同步复制；跨 Region 延迟高、流量贵，一般只做异步复制和容灾
- Region 按用户位置和数据合规要求选
- CDN 默认只缓存静态文件，HTML 和 API 默认不缓存；静态资源文件名带内容哈希就能放心设长 TTL
- 开启代理后解析返回边缘节点 IP，顺带获得 DDoS 防护、WAF，源站 IP 被隐藏

**常见坑**：同一台源站还有别的域名没开代理，源站 IP 照样暴露；面向大陆用户时海外 CDN 延迟不稳，应以国内 CDN 为主。

→ 详见 [云计算概览](/cloud-native/13_cloud_overview#二、region-与可用区)
