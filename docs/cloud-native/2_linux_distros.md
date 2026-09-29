# Linux 发行版

> Linux 内核只是核心，各发行版在其之上封装了包管理器、工具链、默认配置，形成不同的"派系"。同一派系内命令体系、包管理方式基本一致，跨派系差异较大。

## 一、派系全景

```
Linux 内核
├── RHEL 系（Red Hat 派）
│   ├── RHEL（企业付费）
│   ├── CentOS（已停止维护，转为 Stream）
│   ├── Rocky Linux  ←── CentOS 替代首选
│   ├── AlmaLinux    ←── CentOS 替代
│   └── Fedora（RHEL 上游试验田）
│
├── Debian 系
│   ├── Debian（极稳定，社区驱动）
│   └── Ubuntu（最流行，基于 Debian）
│       ├── Ubuntu Server LTS
│       └── Ubuntu Desktop
│
├── SUSE 系
│   ├── openSUSE Leap（稳定版）
│   ├── openSUSE Tumbleweed（滚动更新）
│   └── SLES（SUSE Linux Enterprise Server，付费）
│
├── Arch 系（滚动更新）
│   ├── Arch Linux
│   └── Manjaro（Arch 友好版）
│
├── Alpine Linux（轻量，容器首选）
│
└── 国产发行版
    ├── openEuler / 龙蜥（Anolis OS）
    ├── 统信 UOS
    └── 麒麟 OS（Kylin）
```

---

## 二、RHEL / Red Hat 系

**定位**：企业级服务器首选派系，稳定性最高，发布周期保守，生命周期长（RHEL 10 年支持）。

**包管理**：`RPM` 格式，`yum`（CentOS 7）/ `dnf`（CentOS 8+、Rocky、AlmaLinux）

### 2.1 各发行版定位

| 发行版 | 官网 | 定位 | 现状 |
|--------|------|------|------|
| **RHEL** | [redhat.com](https://www.redhat.com/en/technologies/linux-platforms/enterprise-linux) | Red Hat 官方企业版，付费订阅 | 活跃，企业生产主流 |
| **CentOS 7** | [centos.org](https://www.centos.org/) | RHEL 免费克隆，2024-06-30 EOL | ⚠️ 已停止维护，勿用于新项目 |
| **CentOS Stream** | [centos.org](https://www.centos.org/) | RHEL 上游滚动版，非稳定克隆 | 定位尴尬，不推荐生产 |
| **Rocky Linux** | [rockylinux.org](https://rockylinux.org/) | CentOS 原班人马打造，1:1 兼容 RHEL | ✅ 推荐，CentOS 最佳替代 |
| **AlmaLinux** | [almalinux.org](https://almalinux.org/) | CloudLinux 出品，1:1 兼容 RHEL | ✅ 推荐，稳定可靠 |
| **Fedora** | [fedoraproject.org](https://fedoraproject.org/) | RHEL 新特性试验田，更新激进 | 开发者桌面，不适合生产 |

> **CentOS 7 迁移方向**：生产环境优先选 Rocky Linux 或 AlmaLinux，两者与 RHEL 二进制兼容，迁移成本极低。

### 2.2 常用工具

| 工具 | 说明 |
|------|------|
| `yum` / `dnf` | 包管理（7 用 yum，8+ 用 dnf） |
| `rpm` | 底层包操作（查询、安装 .rpm 文件） |
| `systemctl` | 服务管理 |
| `firewalld` / `firewall-cmd` | 默认防火墙 |
| `nmcli` / `nmtui` | 网络管理 |
| `SELinux` | 安全增强模块（默认开启，运维需熟悉） |
| `/etc/sysconfig/` | 系统配置集中目录 |

### 2.3 CentOS 7 设置固定 IP

```bash
# 编辑网卡配置
vi /etc/sysconfig/network-scripts/ifcfg-ens33
```

```ini
TYPE="Ethernet"
NAME="ens33"
DEVICE="ens33"
ONBOOT="yes"
BOOTPROTO="static"

IPADDR="192.168.2.3"
PREFIX="24"
GATEWAY="192.168.2.2"
DNS1="192.168.2.2"
```

```bash
# 重启网络
systemctl restart network
```

### 2.4 Rocky Linux / AlmaLinux 设置固定 IP（nmcli 方式）

```bash
# 查看连接名
nmcli connection show

# 设置静态 IP
nmcli connection modify ens33 \
  ipv4.method manual \
  ipv4.addresses 192.168.2.3/24 \
  ipv4.gateway 192.168.2.2 \
  ipv4.dns 192.168.2.2

# 重新激活
nmcli connection up ens33
```

---

## 三、Debian / Ubuntu 系

**定位**：最广泛使用的 Linux 派系，Ubuntu Server 是云主机和开发环境的默认选择。

**包管理**：`dpkg` 格式，`apt` / `apt-get`

### 3.1 各发行版定位

| 发行版 | 官网 | 定位 | 适合场景 |
|--------|------|------|---------|
| **Debian** | [debian.org](https://www.debian.org/) | 极稳定，纯社区，发布保守 | 追求极简稳定的服务器 |
| **Ubuntu LTS** | [ubuntu.com](https://ubuntu.com/) | 每 2 年一个 LTS 版，5 年支持 | 云主机、开发环境、Docker 宿主机 |
| **Ubuntu Server** | [ubuntu.com/server](https://ubuntu.com/server) | 无 GUI 的服务器版 | 生产服务器首选 |
| **Linux Mint** | [linuxmint.com](https://linuxmint.com/) | 基于 Ubuntu，面向桌面用户 | 不适合服务器 |

**Ubuntu LTS 版本参考：**

| 版本 | 代号 | 支持到 |
|------|------|--------|
| 20.04 LTS | Focal Fossa | 2025-04 |
| 22.04 LTS | Jammy Jellyfish | 2027-04 |
| **24.04 LTS** | Noble Numbat | 2029-04 ← 当前推荐 |

### 3.2 常用工具

| 工具 | 说明 |
|------|------|
| `apt update && apt upgrade` | 更新软件源和已装包 |
| `apt install / remove` | 安装 / 卸载 |
| `dpkg -l` | 列出已安装包 |
| `ufw` | Ubuntu 简化防火墙 |
| `netplan` | Ubuntu 18.04+ 的网络配置（YAML 格式） |
| `snap` | 通用包格式（Ubuntu 特有） |
| `update-alternatives` | 多版本管理（如同时装多个 JDK） |

### 3.3 Ubuntu 22.04+ 设置固定 IP（Netplan）

```bash
# 编辑 netplan 配置
vi /etc/netplan/00-installer-config.yaml
```

```yaml
network:
  version: 2
  ethernets:
    ens33:
      dhcp4: no
      addresses:
        - 192.168.2.3/24
      routes:
        - to: default
          via: 192.168.2.2
      nameservers:
        addresses: [192.168.2.2, 8.8.8.8]
```

```bash
# 应用配置
netplan apply
```

### 3.4 Debian vs Ubuntu

| 对比项 | Debian | Ubuntu |
|--------|--------|--------|
| 更新节奏 | 稳定优先，周期长 | 每 6 月版本，LTS 每 2 年 |
| 专有驱动 | 默认不含 | 默认包含（GPU 驱动等） |
| 软件新旧 | 偏旧但稳定 | 相对较新 |
| 云主机默认 | 较少 | 绝大多数云厂商默认选项 |
| 适合场景 | 极简稳定服务器 | 开发环境、云主机、容器宿主机 |

---

## 四、Alpine Linux

**定位**：极度轻量（基础镜像仅 ~5 MB），Docker 容器内的首选基础镜像。

官网：[alpinelinux.org](https://www.alpinelinux.org/)

**包管理**：`apk`

| 特点 | 说明 |
|------|------|
| 体积极小 | 基础镜像 ~5 MB，Ubuntu 约 70 MB |
| 安全 | 默认使用 musl libc + busybox，攻击面小 |
| 包管理 | `apk add / del / update` |
| 适合场景 | Docker 镜像基础层，微服务容器 |
| 不适合 | 直接作为服务器 OS（glibc 兼容性问题） |

```dockerfile
# Docker 多阶段构建常见用法
FROM eclipse-temurin:21-jdk AS build
# ... 编译

FROM alpine:3.19
RUN apk add --no-cache openjdk21-jre
COPY --from=build /app/app.jar /app.jar
ENTRYPOINT ["java", "-jar", "/app.jar"]
```

---

## 五、SUSE 系

**定位**：欧洲企业市场主流，国内使用较少，部分银行/电信有采购。

| 发行版 | 官网 | 说明 |
|--------|------|------|
| **openSUSE Leap** | [opensuse.org](https://www.opensuse.org/) | 对应 SLES 的社区稳定版 |
| **openSUSE Tumbleweed** | [opensuse.org](https://www.opensuse.org/) | 滚动更新，软件最新 |
| **SLES** | [suse.com](https://www.suse.com/products/server/) | SUSE 企业版，付费，金融/电信场景 |

**包管理**：`zypper`（底层 RPM），`YaST`（图形化管理工具）

---

## 六、国产 Linux

在信创（信息技术应用创新）背景下，国产 Linux 在政府、央企、金融领域加速落地。

| 发行版 | 官网 | 背后机构 | 内核基础 | 特点 |
|--------|------|---------|---------|------|
| **openEuler** | [openeuler.org](https://www.openeuler.org/) | 华为开源 | 上游 Linux | 华为生态，鸿蒙兼容方向 |
| **龙蜥（Anolis OS）** | [openanolis.cn](https://openanolis.cn/) | 阿里开源 | CentOS 兼容 | 阿里云默认系统，CentOS 平替 |
| **统信 UOS** | [chinauos.com](https://www.chinauos.com/) | 统信软件 | Debian | 桌面 + 服务器，最广泛的信创选择 |
| **麒麟 OS（Kylin）** | [kylinos.cn](https://www.kylinos.cn/) | 国防科大 / 麒麟软件 | Ubuntu | 政府/军工场景，有安全认证 |

> 对于需要做信创适配的 Java 后端项目，优先关注**龙蜥（Anolis）** 和**统信 UOS**：
> - 龙蜥与 CentOS 7/8 高度兼容，Java 应用迁移几乎无感
> - 统信 UOS 基于 Debian，apt 体系，使用习惯接近 Ubuntu

---

## 七、选型建议

| 场景 | 推荐发行版 |
|------|----------|
| 新建生产服务器（替代 CentOS 7） | Rocky Linux / AlmaLinux |
| 云主机 / 开发环境 | Ubuntu Server 22.04 / 24.04 LTS |
| Docker 容器基础镜像 | Alpine Linux |
| 信创 / 国产化适配 | 龙蜥（Anolis OS）/ 统信 UOS |
| 学习 Linux 原理 | Debian |
| 激进尝鲜 / 个人开发桌面 | Fedora / openSUSE Tumbleweed |

> [!warning]
> 待补充：各发行版 JDK 安装最佳实践、Docker 安装步骤差异、SELinux 常见配置问题
