---
description: 发展脉络、系统 VM 与进程 VM、Type-1 / Type-2、硬件辅助虚拟化、VM 与容器、microVM 与沙箱
---

# 虚拟化概览

> 前置阅读：[Linux 发行版](./2_linux_distros)

虚拟化是在物理资源和使用者之间加一层抽象，把一台机器切成多份或模拟出另一种环境。本篇讲发展脉络、Hypervisor 分类、虚拟机与容器、microVM 与沙箱。

---

## 一、发展脉络

服务器虚拟化、JVM、容器、WebAssembly 的区别在于抽象层放在哪、隔离到什么程度；本篇分清 Type-1 / Type-2 Hypervisor 等分类口径。

### 1、大型机时代（1960s–1970s）

IBM 在 CP-40 / CP-67 上首先实现了虚拟机，1972 年的 VM/370 让一台大型机同时运行多个相互隔离的操作系统实例，目的是分时共享昂贵的硬件。1974 年 Popek 和 Goldberg 提出「可虚拟化」的形式化条件：所有敏感指令都必须是特权指令，这样 Hypervisor 才能用「陷入—模拟」的方式接管它们。

### 2、PC 时代的沉寂（1980s–1990s）

x86 PC 普及后硬件变便宜，「一台机器一个系统」成为常态，虚拟化热度下降。同时，x86 有十几条敏感但非特权的指令，不满足 Popek–Goldberg 条件，无法直接用陷入—模拟实现虚拟化，这是技术上的主要障碍。

### 3、x86 虚拟化复兴（1999–2010）

服务器数量激增、利用率低下，虚拟化重新成为刚需，三条技术路线先后突破 x86 的限制：

- **二进制翻译**：VMware Workstation（1999）在运行时把客户机内核里的敏感指令改写成安全指令序列，客户机系统无需修改
- **半虚拟化**：Xen（2003）修改客户机内核，让它主动调用 Hypervisor（hypercall），省去翻译开销
- **硬件辅助虚拟化**：Intel VT-x（2005）和 AMD-V（2006）在 CPU 中加入新的运行模式，后来又加入 EPT / NPT 加速内存地址转换；KVM 借此在 2007 年进入 Linux 主线内核

### 4、云计算与容器（2006–2019）

- AWS EC2（2006）把虚拟机变成按需租用的商品，虚拟化成为 IaaS 的基础
- Docker（2013）用 Linux namespaces 和 cgroups 做进程级隔离，容器开始与虚拟机并行发展
- SR-IOV、virtio、硬件卸载（如 AWS Nitro）持续压低虚拟化的 IO 开销

### 5、轻量化与强隔离（2018 至今）

函数计算、多租户容器平台既要容器的启动速度，又要虚拟机的隔离强度，催生了一批新形态：

- **microVM**：Firecracker 基于 KVM，只模拟极少的设备，启动在百毫秒级，用于 AWS Lambda 与 Fargate
- **安全容器**：Kata Containers 给每个 Pod 套一个轻量虚拟机，对外仍是标准容器接口
- **用户态内核沙箱**：gVisor 在用户态实现一套 Linux 系统调用，拦截容器的系统调用，不需要完整的客户机内核
- **WebAssembly 运行时**：Wasmtime、WasmEdge 以字节码 + 能力模型提供细粒度沙箱，属于进程级运行时而非系统虚拟机

---

## 二、分类口径

虚拟化有几种互相独立的分类维度，同一个产品在不同维度下各有归属，不要混用。

### 1、系统虚拟机与进程虚拟机

| 维度 | 系统虚拟机（System VM） | 进程虚拟机（Process VM） |
|------|------------------------|------------------------|
| 虚拟的对象 | 整台计算机（CPU、内存、设备） | 单个程序的运行环境（指令集、内存模型、运行时库） |
| 上面运行什么 | 完整操作系统 | 一个应用进程 |
| 生命周期 | 随 VM 开关机 | 随进程启停 |
| 代表 | ESXi、Hyper-V、KVM、Xen、VMware Workstation、VirtualBox | JVM（含 GraalVM）、.NET CLR、CPython 解释器、Wasmtime |

GraalVM 是一套 JDK 及多语言运行时（Graal JIT、Native Image），属于进程虚拟机，不是轻量级系统虚拟机。JVM 的内部机制见 [JVM 总览](/jvm/0_overview)。

### 2、Type-1 与 Type-2 Hypervisor

Hypervisor（虚拟机监控器，VMM）是负责创建和调度系统虚拟机的那一层，按它运行的位置分为两类：

![Type-1、Type-2 Hypervisor 与容器的分层对比](../assets/cloud-native/virtual-hypervisor-types.svg)

| 类型 | 运行位置 | 代表产品 | 典型场景 |
|------|---------|---------|---------|
| Type-1（裸金属） | 直接运行在硬件上，自己管理 CPU 和内存 | VMware ESXi、Hyper-V、Xen、KVM | 数据中心、云平台 |
| Type-2（宿主式） | 作为应用运行在宿主操作系统之上 | VMware Workstation / Fusion、VirtualBox、Parallels Desktop | 个人电脑上的开发测试 |

两个容易误解的地方：

- **Hyper-V 是 Type-1**：启用 Hyper-V 后，Hypervisor 先于 Windows 启动，原来的 Windows 变成运行在 Hypervisor 之上的「根分区」，与其他虚拟机平级，只是拥有管理权限
- **KVM 的归类**：KVM 是 Linux 内核模块，加载后让宿主内核本身充当 Hypervisor，虚拟机就是一个普通的 Linux 进程（通常由 QEMU 负责设备模拟）。它有宿主 OS，却由内核直接掌管硬件虚拟化，一般归为 Type-1

::: tip 现代 Type-2 也依赖硬件辅助
Type-1 / Type-2 只说明 Hypervisor 运行的位置，不说明性能高低。VMware Workstation 和 VirtualBox 同样使用 VT-x / AMD-V，CPU 密集型负载的开销都不大；Type-1 的优势主要在于没有宿主 OS 的资源争用，管理能力也更完整。
:::

### 3、全虚拟化、半虚拟化与硬件辅助

| 方式 | 客户机系统是否修改 | 实现手段 | 代表 |
|------|------------------|---------|------|
| 全虚拟化（软件） | 否 | 二进制翻译敏感指令 | 早期 VMware |
| 半虚拟化 | 是，内核改为调用 hypercall | 客户机主动与 Hypervisor 协作 | 早期 Xen PV |
| 硬件辅助虚拟化 | 否 | CPU 提供 VT-x / AMD-V、EPT / NPT | KVM、Hyper-V、现代 VMware |

如今 CPU 与内存基本都靠硬件辅助完成，半虚拟化的思路保留在 IO 上：客户机安装 virtio（KVM）、VMBus 驱动（Hyper-V）或 VMware Tools 这类半虚拟化驱动，绕开对真实网卡、磁盘控制器的低效模拟。

---

## 三、虚拟机与容器

容器不是轻量虚拟机：虚拟机虚拟的是硬件，每个 VM 有自己的内核；容器只是宿主机上的一组进程，用 **namespaces** 隔离视图（进程号、网络、挂载点、主机名），用 **cgroups** 限制资源（CPU、内存、IO），所有容器共享同一个宿主内核。

| 对比项 | 虚拟机 | 容器 |
|-------|-------|------|
| 隔离边界 | 硬件虚拟化，独立内核 | 内核特性，共享宿主内核 |
| 启动速度 | 秒级到分钟级（完整引导系统） | 毫秒到秒级（启动一个进程） |
| 镜像体积 | GB 级，含完整操作系统 | MB 级，只含应用及依赖 |
| 可运行的系统 | 任意操作系统 | 只能与宿主内核兼容（Linux 容器需要 Linux 内核） |
| 安全隔离 | 强，逃逸需突破 Hypervisor | 较弱，内核漏洞可能导致逃逸 |

两者通常叠加使用：云上的 Kubernetes 节点本身是虚拟机，容器跑在虚拟机里。对隔离要求高的多租户场景，再用以下方案在两者之间折中：

| 方案 | 做法 | 隔离强度 | 代价 |
|------|------|---------|------|
| 普通容器（runc） | namespaces + cgroups | 共享内核 | 几乎无额外开销 |
| gVisor（runsc） | 用户态内核拦截系统调用 | 系统调用面大幅收窄 | 系统调用密集型负载变慢 |
| Kata Containers | 每个 Pod 一个轻量 VM，内含独立内核 | 硬件虚拟化级 | 额外内存与启动时间 |
| Firecracker microVM | 精简设备模型的 KVM 虚拟机 | 硬件虚拟化级 | 需要 KVM，设备支持有限 |

这几种方案都能通过 Kubernetes 的 RuntimeClass 按 Pod 选择。容器的具体用法见后续的 [Docker](./5_docker) 与 [Kubernetes](./6_kubernetes)。

---

## 四、选型参考

| 场景 | 推荐 | 原因 |
|------|------|------|
| Windows 上做 Linux 命令行开发、跑 Docker | WSL 2 | 集成度高，按需启动，资源随用随还 |
| 个人电脑上运行完整的多操作系统环境 | VMware Workstation、VirtualBox、Hyper-V | 完整虚拟机，可快照、可定制网络 |
| 机房或私有云的服务器虚拟化 | ESXi、Hyper-V Server 角色、KVM（Proxmox VE、OpenStack） | Type-1，具备集群、迁移、高可用能力 |
| 函数计算、多租户容器隔离 | Firecracker、Kata Containers、gVisor | 兼顾启动速度和隔离强度 |
| 插件、边缘场景的不可信代码 | WebAssembly 运行时 | 进程内沙箱，启动快、体积小 |

Windows 上 WSL 2、Hyper-V、VMware Workstation、VirtualBox 的安装、网络配置和共存问题，见下一篇 [虚拟化工具](./4_virtual_tools)。

---

## 小结

- 系统虚拟机虚拟整台计算机，进程虚拟机只为单个程序提供运行环境；JVM、GraalVM、Wasm 运行时都属于后者
- Type-1 Hypervisor 直接管理硬件（ESXi、Hyper-V、KVM、Xen），Type-2 运行在宿主 OS 之上（VMware Workstation、VirtualBox）
- 硬件辅助虚拟化已是主流，半虚拟化的思路保留在 virtio 等 IO 驱动上
- 容器共享宿主内核，比虚拟机轻但隔离弱；gVisor、Kata、Firecracker 在两者之间提供不同强度的折中

## 参考资料

- Popek 与 Goldberg 的可虚拟化条件：[Formal Requirements for Virtualizable Third Generation Architectures（CACM 1974）](https://dl.acm.org/doi/10.1145/361011.361073)
- Hyper-V 架构：[Microsoft Learn - Hyper-V Architecture](https://learn.microsoft.com/en-us/virtualization/hyper-v-on-windows/reference/hyper-v-architecture)
- KVM 官方文档：[Linux Kernel - KVM](https://docs.kernel.org/virt/kvm/index.html)
- Firecracker：[Firecracker 官网](https://firecracker-microvm.github.io/)
- Kata Containers：[Kata Containers 文档（GitHub）](https://github.com/kata-containers/kata-containers/tree/main/docs)
- gVisor：[gVisor 架构说明](https://gvisor.dev/docs/)
- Wasmtime：[Wasmtime 文档](https://docs.wasmtime.dev/)
- Kubernetes RuntimeClass：[Kubernetes 文档 - Runtime Class](https://kubernetes.io/docs/concepts/containers/runtime-class/)

> 下一篇：[虚拟化工具](./4_virtual_tools)
