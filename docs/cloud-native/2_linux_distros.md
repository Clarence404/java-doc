---
description: RHEL / Debian / Alpine / SUSE / 国产发行版、版本基线、容器基础镜像与选型
---

# Linux 发行版

> **本篇目标**：分清主流发行版的派系与现状（以 2026 年 10 月为基线），掌握各派系的包管理、网络与安全配置差异，能为服务器、容器基础镜像和信创场景做出选型。
>
> **前置阅读**：[Linux 概览](./1_linux)

Linux 内核只是核心，发行版在其上封装了包管理器、工具链、默认配置和支持周期。同一派系内命令体系、包管理方式基本一致，跨派系差异较大。

---

## 一、派系全景

![Linux 发行版主要派系](../assets/cloud-native/linux-distros-family.svg)

派系之间真正影响后端工作的差异只有几项：

| 差异点 | 说明 |
|--------|------|
| 包格式与包管理器 | RHEL / SUSE 系用 rpm（`dnf` / `zypper`），Debian 系用 deb（`apt`），Alpine 用 `apk` |
| C 标准库 | 绝大多数发行版用 glibc，Alpine 用 musl，部分二进制和 JNI 库不能通用 |
| 发布模型 | 固定版本 + 长期支持（RHEL、Ubuntu LTS、Debian、SLES）或滚动更新（Arch、Tumbleweed） |
| 默认安全模块 | RHEL 系默认 SELinux，Ubuntu / SUSE 默认 AppArmor |
| init 系统 | 主流服务器发行版都是 systemd，Alpine 用 OpenRC（容器内通常不需要 init） |

---

## 二、RHEL / Red Hat 系

**定位**：企业服务器的主流派系，发布节奏保守。每个大版本的生命周期为 10 年（完全支持与维护支持两个阶段），付费的扩展支持（ELS）可再延长。当前大版本为 **RHEL 10**（2025 年 5 月发布），Rocky Linux 10 与 AlmaLinux 10 随后跟进。

**包管理**：rpm 格式，`dnf`。RHEL 8 起 `yum` 只是指向 `dnf` 的别名。

### 1、各发行版定位

| 发行版 | 定位 | 现状 |
|--------|------|------|
| [RHEL](https://www.redhat.com/en/technologies/linux-platforms/enterprise-linux) | Red Hat 官方企业版，付费订阅（开发者订阅可免费用于个人开发） | 活跃，企业生产主流 |
| [CentOS Linux](https://www.centos.org/) | 过去的 RHEL 免费重建版 | **已 EOL**：CentOS 8 于 2021-12-31、CentOS 7 于 2024-06-30 停止维护，勿用于新项目 |
| [CentOS Stream](https://www.centos.org/centos-stream/) | RHEL 的上游开发分支，先于 RHEL 获得更新 | 适合提前验证下一个 RHEL 小版本，不建议作为稳定生产系统 |
| [Rocky Linux](https://rockylinux.org/) | CentOS 创始人发起，以与 RHEL **bug-for-bug 兼容**为目标 | 推荐，CentOS 的直接替代 |
| [AlmaLinux](https://almalinux.org/) | AlmaLinux OS 基金会维护，2023 年起改为与 RHEL **ABI 兼容** | 推荐，二进制层面兼容，允许在 RHEL 之外修复问题 |
| [Fedora](https://fedoraproject.org/) | CentOS Stream 与 RHEL 的上游试验田，约半年一个版本 | 开发者桌面，不适合生产 |

上下游关系：Fedora → CentOS Stream → RHEL → Rocky / AlmaLinux 等重建版。

> [!tip]
> CentOS 7 迁移：优先迁到 Rocky Linux 或 AlmaLinux 的当前大版本。跨大版本无法原地升级时，按「新建主机 + 部署应用 + 切流量」处理更稳妥；两者都提供从其他 RHEL 系发行版切换的迁移脚本，适用范围以官方文档为准。

### 2、常用工具

| 工具 | 说明 |
|------|------|
| `dnf install / remove / update` | 包管理 |
| `rpm -qa`、`rpm -qf /usr/bin/java` | 查询已安装的包、查询文件属于哪个包 |
| `firewall-cmd` | 默认防火墙 firewalld 的命令行 |
| `nmcli` / `nmtui` | NetworkManager 网络配置 |
| `getenforce`、`semanage`、`restorecon` | SELinux 状态与策略管理 |

### 3、设置固定 IP（nmcli）

RHEL 9 起网络配置以 NetworkManager 的 keyfile 格式保存，旧的 `/etc/sysconfig/network-scripts/ifcfg-*` 方式已弃用，统一用 `nmcli` 修改：

```bash
# 查看连接名（可能是网卡名 ens33，也可能是 "Wired connection 1"）
nmcli connection show

# 设置静态 IP
sudo nmcli connection modify ens33 \
  ipv4.method manual \
  ipv4.addresses 192.168.2.3/24 \
  ipv4.gateway 192.168.2.2 \
  ipv4.dns 192.168.2.2

# 重新激活使其生效
sudo nmcli connection up ens33
```

### 4、SELinux 与 firewalld

RHEL 系默认开启 SELinux（Enforcing 模式）。服务「权限都对却访问不了文件或端口」时，先看是不是 SELinux 拦截，而不是直接关掉它：

```bash
getenforce                                    # Enforcing / Permissive / Disabled
sudo ausearch -m avc -ts recent               # 查看最近被拒绝的访问
sudo restorecon -Rv /var/www/html             # 文件复制或移动后恢复默认安全上下文
sudo semanage port -a -t http_port_t -p tcp 8081   # 允许 Web 类服务监听 8081
```

`semanage` 由 `policycoreutils-python-utils` 包提供；若该端口已被定义为其他类型，`-a` 会报错，改用 `-m` 修改。防火墙放行端口：

```bash
sudo firewall-cmd --permanent --add-port=8080/tcp
sudo firewall-cmd --reload
```

---

## 三、Debian / Ubuntu 系

**定位**：使用最广泛的派系，Ubuntu Server 是云主机与开发环境的常见默认选项。

**包管理**：deb 格式，底层 `dpkg`，日常用 `apt`。

### 1、各发行版定位

| 发行版 | 定位 | 适合场景 |
|--------|------|---------|
| [Debian](https://www.debian.org/) | 纯社区驱动，发布保守；当前稳定版为 Debian 13 | 追求精简稳定的服务器、容器基础镜像 |
| [Ubuntu LTS](https://ubuntu.com/) | Canonical 维护，每 2 年一个 LTS，标准支持 5 年，Ubuntu Pro 的 ESM 再延长 5 年 | 云主机、开发环境、Docker 宿主机 |
| [Linux Mint](https://linuxmint.com/) 等 | 基于 Ubuntu 的桌面发行版 | 个人桌面，不用于服务器 |

**Ubuntu LTS 版本：**

| 版本 | 代号 | 标准支持至 | ESM 至 | 状态 |
|------|------|-----------|--------|------|
| 20.04 LTS | Focal Fossa | 2025-05 | 2030-05 | 标准支持已结束，仅 Ubuntu Pro 提供安全更新 |
| 22.04 LTS | Jammy Jellyfish | 2027-05 | 2032-05 | 维护中，规划升级 |
| 24.04 LTS | Noble Numbat | 2029-05 | 2034-05 | 维护中 |
| **26.04 LTS** | Resolute Raccoon | 2031-05 | 2036-05 | **当前 LTS，新建主机首选** |

LTS 之间可用 `sudo do-release-upgrade` 升级，官方通常在新 LTS 的第一个小版本（如 26.04.1）发布后才开放 LTS 到 LTS 的升级路径。

### 2、常用工具

| 工具 | 说明 |
|------|------|
| `apt update && apt upgrade` | 刷新软件源索引并升级已装包 |
| `apt install / remove` | 安装 / 卸载 |
| `dpkg -l`、`dpkg -S /usr/bin/java` | 列出已安装包、查询文件属于哪个包 |
| `ufw` | Ubuntu 的简化防火墙 |
| `netplan` | Ubuntu 的网络配置（YAML） |
| `update-alternatives --config java` | 多个 JDK 之间切换默认版本 |

### 3、设置固定 IP（Netplan）

配置文件在 `/etc/netplan/` 下，文件名因安装方式而异：服务器安装镜像多为 `00-installer-config.yaml` 或 `50-cloud-init.yaml`，云主机由 cloud-init 生成 `50-cloud-init.yaml`。

```yaml
# /etc/netplan/01-static.yaml
network:
  version: 2
  ethernets:
    ens33:
      dhcp4: false
      addresses:
        - 192.168.2.3/24
      routes:
        - to: default
          via: 192.168.2.2
      nameservers:
        addresses: [192.168.2.2, 8.8.8.8]
```

```bash
sudo chmod 600 /etc/netplan/01-static.yaml   # 权限过宽时 netplan 会告警
sudo netplan try                              # 试用配置，120 秒内不确认自动回滚
sudo netplan apply
```

- 同一网卡不要在多个文件里重复配置，netplan 会按文件名顺序合并，后者覆盖前者
- 云主机上手动修改时，cloud-init 可能在重启后重新生成网络配置；需要固定时在 `/etc/cloud/cloud.cfg.d/99-disable-network-config.cfg` 写入 `network: {config: disabled}`

### 4、Debian 与 Ubuntu

| 对比项 | Debian | Ubuntu |
|--------|--------|--------|
| 发布节奏 | 约 2 年一个稳定版，不定期 | 每半年一个版本，LTS 每 2 年（偶数年 4 月） |
| 支持周期 | 常规支持约 3 年 + 社区 LTS 共约 5 年 | 标准 5 年，ESM 再 5 年 |
| 软件版本 | 偏旧但稳定 | 相对较新 |
| 商业支持 | 无官方商业实体 | Canonical 提供 |
| 适合场景 | 精简稳定的服务器、容器基础镜像 | 开发环境、云主机、容器宿主机 |

---

## 四、Alpine 与容器基础镜像

[Alpine Linux](https://www.alpinelinux.org/) 使用 musl libc + BusyBox，基础镜像压缩后只有几 MB，包管理为 `apk add / del`。它是常见的容器基础镜像，但不适合直接作为服务器操作系统。

### 1、Java 应用选 Alpine 要注意的地方

- **glibc 与 musl 不兼容**：依赖 glibc 编译的 native 库（部分 JNI 库、某些 Netty native transport 构建、厂商 SDK 自带的 `.so`）在 Alpine 上无法加载，运行时报 `UnsatisfiedLinkError`
- **JDK 必须是 musl 构建**：要用 `eclipse-temurin:21-jre-alpine` 这类专门为 Alpine 构建的镜像，不要把 glibc 版 JDK 拷进 Alpine
- **DNS 行为有差异**：musl 的解析器与 glibc 实现不同，早期版本不支持 DNS 响应过大时回退到 TCP（musl 1.2.4 起支持），排查 Kubernetes 中的解析问题时要考虑这一点
- **体积优势有限**：Java 镜像的大头是 JRE 和应用 jar，Alpine 与 Ubuntu 基础层的差距在整体中占比不大

没有特殊体积要求时，`eclipse-temurin:21-jre`（基于 Ubuntu，glibc）更省心；追求最小攻击面可以考虑 distroless 等只含运行时的镜像。

### 2、多阶段构建示例

以 Maven Wrapper 项目为例，构建阶段用 JDK 镜像编译打包，运行阶段只保留 JRE 和 jar：

```dockerfile
# 构建阶段
FROM eclipse-temurin:21-jdk AS build
WORKDIR /workspace
COPY .mvn/ .mvn/
COPY mvnw pom.xml ./
RUN chmod +x mvnw && ./mvnw -B dependency:go-offline
COPY src/ src/
RUN ./mvnw -B package -DskipTests && cp target/*.jar app.jar

# 运行阶段
FROM eclipse-temurin:21-jre
RUN groupadd --system app && useradd --system --gid app --no-create-home app
WORKDIR /app
COPY --from=build /workspace/app.jar app.jar
USER app
EXPOSE 8080
ENTRYPOINT ["java", "-XX:MaxRAMPercentage=70", "-jar", "app.jar"]
```

```bash
docker build -t order-service:1.0.0 .
docker run --rm -p 8080:8080 order-service:1.0.0
```

- 先复制 `pom.xml` 下载依赖、再复制源码，源码变更时可复用依赖层缓存
- `cp target/*.jar` 依赖 Spring Boot 打包后 `target/` 下只有一个可执行 jar（原始 jar 被重命名为 `.original`）
- 运行阶段换成 Alpine 时，基础镜像改为 `eclipse-temurin:21-jre-alpine`，建用户改为 `addgroup -S app && adduser -S -G app app`
- `ENTRYPOINT` 用 exec 形式，SIGTERM 才能直接到达 JVM；堆比例的取值依据见 [JVM 层性能策略](/high-perf/5_jvm_tuning)，镜像分层与构建细节见 [Docker](./5_docker)

---

## 五、SUSE 系

**定位**：欧洲企业市场的主流之一，国内使用较少，SAP 等场景常见。

| 发行版 | 说明 |
|--------|------|
| [SLES](https://www.suse.com/products/server/) | SUSE Linux Enterprise Server，付费订阅，长周期支持 |
| [openSUSE Leap](https://www.opensuse.org/) | 与 SLES 共享代码基础的社区稳定版 |
| [openSUSE Tumbleweed](https://www.opensuse.org/) | 滚动更新，软件最新 |

**包管理**：`zypper`（底层 rpm），图形化 / 文本界面的系统管理工具 YaST。

---

## 六、国产发行版

在信创（信息技术应用创新）背景下，国产发行版在政府、央企、金融领域加速落地。它们大多源自 openEuler 或龙蜥社区，选型时先弄清**社区版与商业版**、**上游是谁**。

| 发行版 | 背后机构 | 上游与包体系 | 说明 |
|--------|---------|-------------|------|
| [openEuler](https://www.openeuler.org/) | 华为发起，已捐赠给开放原子开源基金会 | 独立社区发行版，rpm / dnf | 每 2 年一个 LTS（如 24.03 LTS），支持 x86_64、aarch64（鲲鹏）、RISC-V、LoongArch 等多架构；是多家商业发行版的上游 |
| [龙蜥 Anolis OS](https://openanolis.cn/) | OpenAnolis 社区（阿里云等发起） | rpm / dnf | Anolis OS 8 与 RHEL 8 兼容，可作为 CentOS 8 平替；Anolis OS 23 为社区自主演进版本 |
| [Alibaba Cloud Linux](https://help.aliyun.com/zh/alinux/) | 阿里云 | 3 代基于 Anolis OS 8，4 代基于 Anolis OS 23 | 阿里云 ECS 提供的自研镜像，针对云上场景优化 |
| [统信 UOS](https://www.chinauos.com/) | 统信软件 | 服务器版分多个分支：基于 openEuler、龙蜥或 Debian | 桌面 + 服务器；不同分支的包体系不同（rpm 或 deb），部署前确认具体版本 |
| [银河麒麟](https://www.kylinos.cn/) | 麒麟软件 | 高级服务器版为 rpm 体系，与 openEuler / CentOS 生态兼容 | 政府、军工、金融场景常见；**优麒麟（Ubuntu Kylin）** 是另一条桌面产品线，基于 Ubuntu，不要混淆 |

> [!tip]
> Java 后端做信创适配时，JDK 和应用本身通常无需改动，工作量主要在：CPU 架构（鲲鹏 / 飞腾为 aarch64，龙芯为 LoongArch，需要对应架构的 JDK 与 native 库）、中间件与数据库的国产化替换、以及按目标发行版的包体系重写安装脚本。

---

## 七、选型建议

| 场景 | 推荐 |
|------|------|
| 新建企业生产服务器（替代 CentOS） | Rocky Linux 10 / AlmaLinux 10，或有订阅预算时用 RHEL 10 |
| 云主机 / 开发环境 / 容器宿主机 | Ubuntu Server 26.04 LTS（存量 22.04 / 24.04 规划升级） |
| Java 容器基础镜像 | `eclipse-temurin:21-jre`；追求体积用 `-alpine` 变体并先验证 native 依赖 |
| 信创 / 国产化适配 | openEuler 及其商业发行版、龙蜥、统信 UOS、银河麒麟（以客户指定为准） |
| 学习 Linux 原理 | Debian |
| 尝鲜新特性 / 个人开发桌面 | Fedora / openSUSE Tumbleweed |

JDK 安装：RHEL 系用 `sudo dnf install java-21-openjdk-headless`，Ubuntu 用 `sudo apt install openjdk-21-jre-headless`；需要统一版本时也可从 Adoptium 等发行方下载 tar 包。Docker 的安装方式见 [Docker](./5_docker)。

---

## 小结

- 派系差异主要在包管理（rpm / deb / apk）、C 库（glibc / musl）、发布模型和默认安全模块（SELinux / AppArmor）
- RHEL 系当前大版本为 10，CentOS Linux 已全部 EOL；Rocky 追求 bug-for-bug 兼容，AlmaLinux 为 ABI 兼容
- Ubuntu 26.04 LTS 是当前 LTS，20.04 标准支持已结束；Netplan 配置文件要设为 600 权限并用 `netplan try` 验证
- RHEL 系网络用 `nmcli` 配置，遇到访问被拒先查 SELinux 的 AVC 日志，不要直接关闭
- Java 容器优先用 `eclipse-temurin:21-jre`；选 Alpine 要确认 native 库兼容并使用 musl 构建的 JDK
- 国产发行版多以 openEuler 或龙蜥为上游，适配工作集中在 CPU 架构与中间件替换

## 参考资料

- RHEL 生命周期：[Red Hat Enterprise Linux Life Cycle](https://access.redhat.com/support/policy/updates/errata)
- Rocky Linux 文档：[Rocky Linux Documentation](https://docs.rockylinux.org/)
- AlmaLinux 兼容性说明：[AlmaLinux OS FAQ](https://wiki.almalinux.org/FAQ.html)
- Ubuntu 发布周期：[Ubuntu release cycle](https://ubuntu.com/about/release-cycle)
- Netplan 配置：[Netplan documentation](https://netplan.readthedocs.io/)
- Debian 发布信息：[Debian Releases](https://www.debian.org/releases/)
- Alpine 官方文档：[Alpine Linux Wiki](https://wiki.alpinelinux.org/)
- Eclipse Temurin 镜像：[eclipse-temurin - Docker Official Image](https://hub.docker.com/_/eclipse-temurin)
- openEuler 社区：[openEuler 官网](https://www.openeuler.org/)
- Alibaba Cloud Linux 与 Anolis OS 的关系：[Alibaba Cloud Linux 文档](https://help.aliyun.com/zh/alinux/)

> 下一篇：[虚拟化概览](./3_virtual) —— 虚拟化的发展与分类，以及在本地搭建 Linux 实验环境的常用方案。
