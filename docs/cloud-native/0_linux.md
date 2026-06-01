# Linux 概述

## **一、Linux 前身：Unix 及 Minix**

Linux 不是凭空诞生的，它的核心思想、架构和设计理念都来源于 **Unix**，并受到 **Minix** 的影响。因此，要理解 Linux 的前身，
必须先了解 Unix 和 Minix。

---

### **1、 Unix - Linux 的“祖父”**

#### **Unix 的诞生（1969 年）**

Linux 的前身可以追溯到 1969 年，当时 **贝尔实验室（Bell Labs）** 的 **Ken Thompson** 和 **Dennis Ritchie**
在开发一个新的操作系统。他们的目标是创建一个简单、可移植且适用于多用户、多任务环境的系统，这就是 **Unix**（UNICS，后来改名为
Unix）。

> Unix 的几个重要特点：
> - **多用户、多任务**：支持多个用户同时使用，并能运行多个进程。
> - **模块化设计**：采用“小而精”的哲学，每个程序只做一件事，但做得很好。
> - **C 语言编写**：1973 年，Dennis Ritchie 用 C 语言重写 Unix，使其易于移植到不同的硬件上。

#### **Unix 的分裂**

由于 Unix 设计优秀，各大公司和大学都开始使用，并进行修改。逐渐，Unix 分裂为多个版本：

- **AT&T Unix**（System V）——主要由 AT&T 继续开发，商业化后成为企业市场的主流。
- **BSD（Berkeley Software Distribution）**——加州大学伯克利分校基于 Unix 研发，带来了 `vi`、`csh`、`TCP/IP` 等关键技术。
- **其他商业 Unix 版本**：如 Sun Solaris、IBM AIX、HP-UX 等。

随着 Unix 逐渐商业化，它的源码也变得封闭，普通用户无法免费获得完整的 Unix 系统。这就为后来的 **Minix 和 Linux 的诞生**
埋下了伏笔。

---

### **2、 Minix - Linux 的“父亲”**

#### **Minix 的诞生（1987 年）**

由于 Unix 逐渐商业化，普通用户和学生无法轻易学习 Unix 的源码。荷兰计算机科学家 **Andrew S、 Tanenbaum** 认为 Unix
太昂贵，难以用于教学，所以在 1987 年开发了 **Minix**，这是一个类 Unix 操作系统。

> Minix 的特点：
> - 轻量级，适用于 8086 处理器（早期 PC）。
> - 采用微内核（Microkernel）架构，模块化设计。
> - 用于教学目的，因此是开源的，但受到一定限制。

Minix 被广泛用于计算机科学课程，特别是在操作系统教学中。然而，它有几个限制：

- 不能自由修改或分发（许可证限制）。
- 主要用于教学，不适合实际应用。
- 硬件支持有限，无法满足更复杂的计算需求。

由于这些限制，**Linus Torvalds**（Linux 之父）在学习 Minix 后，决定自己编写一个新的、更加自由和强大的操作系统，这就催生了
Linux。

---

### **3、 Linux 的诞生（1991 年）**

1991 年，芬兰大学生 **Linus Torvalds** 受到 Minix 的启发，开始开发自己的内核。他最初的目标只是做一个类似 Minix
的简单操作系统，运行在自己的 386 计算机上。然而，他选择使用 GNU 通用公共许可证（GPL）发布，使其迅速吸引了全球开发者的关注和贡献。

> **Linux 与 Unix/Minix 的不同点**：
> - **不像 Unix，是从零开发的内核，但遵循 Unix 设计哲学**。
> - **不像 Minix，Linux 采用的是单内核（Monolithic Kernel），不是微内核**。
> - **Linux 采用 GNU 许可证，允许自由修改、分发和商业化**。
> - **快速发展，吸引了大量开发者，成为开源操作系统的领导者**。

---

### **4、 Linux 前身总结**

| 操作系统      | 诞生时间 | 主要开发者                         | 主要用途        | 许可证           | 对 Linux 的影响                |
|-----------|------|-------------------------------|-------------|---------------|----------------------------|
| **Unix**  | 1969 | Ken Thompson & Dennis Ritchie | 服务器、大型机     | 专有（后来分裂出 BSD） | 提供了基础架构和设计理念               |
| **BSD**   | 1977 | 加州大学伯克利分校                     | 服务器、网络      | BSD 许可证       | 提供了 `vi`、TCP/IP 协议等        |
| **Minix** | 1987 | Andrew Tanenbaum              | 教学          | 受限开源          | 启发 Linus Torvalds 开发 Linux |
| **Linux** | 1991 | Linus Torvalds                | 服务器、桌面、移动设备 | GNU GPL       | 成为全球最流行的开源操作系统             |

Linux 继承了 Unix 的设计思想，同时受 Minix 启发成为完全自由的开源系统。如今，它已经发展成为全球服务器、云计算、嵌入式设备、
超级计算机的核心操作系统。

## **二、Linux 的发展历程**

### 1、**Linux 的起源**

Linux 的历史可以追溯到 1991 年，当时芬兰计算机科学家 **Linus Torvalds** 在学习 MINIX（一个教学用的小型 UNIX 类操作系统）时，
觉得 MINIX 受限太多，于是自己从零开始开发了一个新的内核。这个内核就是 Linux，它最初只是一个兴趣项目，但由于 Torvalds 选择了 *
*GPL（GNU General Public License）** 开源许可证，导致 Linux 迅速吸引了一大批开发者的关注和贡献。

### 2、**GNU 计划与 Linux 的结合**

Linux 仅仅是一个内核，而一个完整的操作系统还需要 Shell、编译器、库文件等组件。幸运的是，在 1983 年，**Richard Stallman** 
发起了**GNU 计划**，目标是创建一个完全自由的 UNIX 类操作系统。GNU 计划提供了许多关键组件，如 `gcc`（编译器）、`glibc`（C 语言库）、
`bash`（Shell）等。

Linux 内核 + GNU 工具链 = **完整的 Linux 操作系统**

这使得 Linux 逐渐成为 UNIX 的一种开源替代方案，并得到了越来越广泛的应用。

---

### 3、**Linux 发行版的出现**

由于 Linux 内核本身只是一个核心组件，并不包含 GUI、应用软件、系统管理工具等。因此，各个组织和社区开始基于 Linux 内核，整合 GNU
组件、软件包管理器、桌面环境等，形成了完整的 Linux **发行版（Distribution）**。

不同的发行版有不同的目标和优化方向，比如有的侧重稳定性（如 Debian），有的适用于企业（如 Red Hat），有的专注于桌面用户（如
Ubuntu）。这些发行版主要基于两大流派：

---

### 4、**Linux 的主流发行版**

Linux 发行版大致可以分为以下几个主要家族：

#### **Debian 系**

- **Debian**（1993 年）：以稳定著称，广泛用于服务器环境。
- **Ubuntu**（2004 年）：基于 Debian，优化桌面体验，适合新手，拥有 LTS（长期支持）版本。
- **Kali Linux**：基于 Debian，专注于网络安全与渗透测试。

> **特点**：稳定、APT 包管理器（`.deb`）、社区驱动

#### **Red Hat 系**

- **Red Hat Enterprise Linux（RHEL）**（1995 年）：商业发行版，适用于企业级应用，需要订阅支持。
- **CentOS**（2004 年-2021 年停更）：RHEL 的社区克隆版本，主要用于企业服务器。
- **Rocky Linux / AlmaLinux**（CentOS 停更后）：作为 RHEL 的免费替代方案。
- **Fedora**（2003 年）：Red Hat 赞助的社区版，测试新技术，特性前沿。

> **特点**：稳定性强、适合企业应用、YUM/DNF 包管理器（`.rpm`）

#### **Arch Linux 系**

- **Arch Linux**（2002 年）：极简、滚动更新，适合高级用户，所有软件均需手动安装和配置。
- **Manjaro**：基于 Arch，增强易用性，适合桌面用户。

> **特点**：极简、滚动更新、Pacman 包管理器

#### **SUSE 系**

- **openSUSE**（2004 年）：社区发行版，稳定性强，适合企业开发。
- **SUSE Linux Enterprise Server（SLES）**：企业版，专注于云计算和大规模部署。

> **特点**：适合企业级解决方案、YaST 管理工具

---

### 5、**为什么 Linux 发行版会分裂？**

Linux 发行版的分裂主要源于以下几点：

1. **需求不同**
    - 服务器用户希望稳定性（如 Debian、RHEL）。
    - 桌面用户希望易用性（如 Ubuntu、Fedora）。
    - 高级用户希望可定制性（如 Arch Linux）。

2. **商业利益**
    - Red Hat、SUSE 等公司希望提供商业支持，形成企业级 Linux 发行版（如 RHEL、SLES）。
    - 社区则需要免费替代品（如 CentOS、AlmaLinux、Rocky Linux）。

3. **技术理念不同**
    - Debian 追求自由软件，而 Ubuntu 更注重用户体验（如包含专有驱动）。
    - Arch 采用滚动更新，而 RHEL 采用长期支持版本。

---

### 6、**Linux 发展总结**

Linux 从最初的一个内核发展到如今的众多发行版，主要经历了以下阶段：

1. **1991 年**：Linus Torvalds 发布 Linux 内核。
2. **1993 年**：Debian、Slackware 等早期发行版出现。
3. **1995-2000 年**：Red Hat、SUSE 成立，开始进入企业市场。
4. **2004 年**：Ubuntu 发布，使 Linux 变得更加易用。
5. **2010 年后**：云计算、容器化（如 Docker）、嵌入式（如 Android）推动 Linux 发展。
6. **2021 年**：CentOS 停更，AlmaLinux、Rocky Linux 作为替代。

如今，Linux 已经广泛应用于服务器、云计算、嵌入式设备（如 Android）、超级计算机、甚至个人桌面，成为全球最重要的操作系统之一。

## 三、**Linux 通用核心命令**

### 1、📁文件系统相关

| 命令                                     | 说明              |
|----------------------------------------|-----------------|
| `ls`, `cd`, `pwd`                      | 列目录，切换目录，显示当前目录 |
| `cp`, `mv`, `rm`                       | 复制、移动、删除        |
| `mkdir`, `rmdir`                       | 创建/删除目录         |
| `find`, `locate`                       | 查找文件            |
| `du`, `df`                             | 查看磁盘使用          |
| `chmod`, `chown`                       | 修改权限、属主属组       |
| `touch`, `cat`, `less`, `head`, `tail` | 操作文件内容          |

---

### 2、🧠系统监控与性能

| 命令                        | 说明                    |
|---------------------------|-----------------------|
| `top`, `htop`             | 实时查看系统资源（htop 更美观）    |
| `free -h`                 | 查看内存                  |
| `uptime`, `vmstat`        | 查看负载、内存               |
| `ps aux`, `kill`, `xargs` | 查看/杀进程                |
| `iostat`, `iotop`         | 查看 IO 情况（需安装 sysstat） |

---

### 3、🌐网络命令

| 命令                          | 说明                |
|-----------------------------|-------------------|
| `ping`, `traceroute`, `dig` | 网络连通性/路由/DNS      |
| `netstat`, `ss`             | 查看端口、连接           |
| `curl`, `wget`              | 请求/下载资源           |
| `telnet`, `nc`              | 测试端口连通性           |
| `ip a`, `ip r`, `ip link`   | 网络配置（替代 ifconfig） |

---

### 4、🔒权限管理

| 命令                               | 说明     |
|----------------------------------|--------|
| `sudo`, `passwd`                 | 提权、改密码 |
| `useradd`, `usermod`, `groupadd` | 用户组管理  |
| `id`, `who`, `whoami`            | 当前用户信息 |

---

### 5、🔧常用管理工具

| 命令                           | 说明         |
|------------------------------|------------|
| `tar`, `gzip`, `unzip`       | 解压压缩       |
| `date`, `cal`                | 查看时间、日历    |
| `history`, `alias`           | 历史命令、自定义命令 |
| `cron`, `crontab`            | 定时任务       |
| `journalctl`, `dmesg`, `log` | 查看日志（系统）   |

## 四、后续补充专题

- [Nginx 与 Ingress](./11_nginx_ingress)：反向代理、负载均衡、Kubernetes 入口流量
- [Helm、Argo CD 与 Terraform](./12_helm_argocd_terraform)：应用部署、GitOps、基础设施即代码
- [Service Mesh](./13_service_mesh)：Sidecar、流量治理、mTLS、可观测性
