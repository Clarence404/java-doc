---
description: Hyper-V 与 VMware 共存、网络模式、固定 IP、磁盘扩容、WSL 2、Docker Desktop
---

# 虚拟化工具

> **本篇目标**：在 Windows 上把 Hyper-V、VMware Workstation、VirtualBox、WSL 2 配置好并让它们共存，掌握三种网络模式、固定 IP 和磁盘扩容等日常操作。
>
> **前置阅读**：[虚拟化概览](./3_virtual)

本篇只讲操作。Type-1 / Type-2 的区别、虚拟机与容器的对比见 [虚拟化概览](./3_virtual)。

---

## 一、Windows 虚拟化组件与共存

### 1、三个 Windows 可选功能

Windows 上的虚拟化能力分散在三个可选功能里，它们共用同一个 Windows Hypervisor：

| 功能（中文名 / FeatureName） | 作用 | 谁需要它 | 系统版本 |
|------------------------------|------|---------|---------|
| Hyper-V / `Microsoft-Hyper-V` | 完整的 Hyper-V 管理器与虚拟交换机 | 使用 Hyper-V 虚拟机 | 专业版、企业版、教育版 |
| 虚拟机平台 / `VirtualMachinePlatform` | 轻量的虚拟机基础设施 | WSL 2 | 含家庭版 |
| Windows 虚拟机监控程序平台 / `HypervisorPlatform` | 给第三方软件调用的 Hypervisor API（WHP） | Hyper-V 开启时的 VMware、VirtualBox、Android 模拟器 | 含家庭版 |

在管理员 PowerShell 中启用，完成后重启：

```powershell
# 完整 Hyper-V（家庭版没有此功能）
Enable-WindowsOptionalFeature -Online -FeatureName Microsoft-Hyper-V -All

# 让 VMware / VirtualBox 能在 Hypervisor 开启时运行
Enable-WindowsOptionalFeature -Online -FeatureName HypervisorPlatform

# 查看某个功能的状态
Get-WindowsOptionalFeature -Online -FeatureName VirtualMachinePlatform
```

`wsl --install` 会自动启用「虚拟机平台」，不需要手动开启完整的 Hyper-V。

### 2、共存关系

只要上面任一功能开启，或者开启了基于虚拟化的安全（VBS、内存完整性、Credential Guard），Windows Hypervisor 就会先于系统启动并独占 VT-x / AMD-V。第三方虚拟机软件必须改为通过 WHP API 运行：

| 软件 | Hypervisor 开启时 | 注意事项 |
|------|------------------|---------|
| VMware Workstation | 15.5.5（2020 年）起支持，自动切换到 WHP 模式 | 需开启「Windows 虚拟机监控程序平台」；该模式下不支持把 VT-x 透传给虚拟机（嵌套虚拟化），部分负载性能略低 |
| VirtualBox | 6.0 起能借助 Hyper-V 运行 | 官方标注为实验性，部分主机性能明显下降；性能敏感时关闭 Hypervisor |
| WSL 2、Docker Desktop | 本身就运行在 Windows Hypervisor 上 | 无冲突 |

旧资料里「VMware 与 Hyper-V / WSL 2 不能同时使用、只能在 BIOS 里来回切换」的说法，只适用于 15.5.5 之前的 VMware 版本。

::: tip VMware Workstation Pro 已免费
Broadcom 收购 VMware 后，Workstation Pro 与 Fusion Pro 于 2024 年 5 月对个人用户免费，2024 年 11 月起对商业用户同样免费，不再单独销售付费版，也不再提供工单支持（只保留文档、知识库和社区论坛）。以 Broadcom 官网的最新许可条款为准。
:::

---

## 二、网络模式

三款软件的叫法不同，本质都是下面三种模式：

![本地虚拟机的三种网络模式](../assets/cloud-native/virtual-network-modes.svg)

| 模式 | VMware | Hyper-V | VirtualBox | 虚拟机能否出网 | 局域网能否访问虚拟机 |
|------|--------|---------|-----------|--------------|------------------|
| 桥接 | Bridged（VMnet0） | 外部交换机（External） | 桥接网卡 | 能 | 能 |
| NAT | NAT（VMnet8） | Default Switch，或「内部交换机 + NetNat」 | NAT / NAT 网络 | 能 | 不能（需端口转发） |
| 仅主机 | Host-only（VMnet1） | 内部交换机（Internal） | 仅主机网络 | 不能 | 不能，只有宿主机可访问 |
| 仅虚拟机之间 | LAN 区段 | 专用交换机（Private） | 内部网络 | 不能 | 宿主机也不能访问 |

Hyper-V 的「内部交换机」本身不做地址转换，只连通宿主机与虚拟机，对应的是仅主机模式；需要上网时用 Default Switch，或者给内部交换机加一条 NetNat（见下一节）。

选择建议：

- **日常开发**：NAT，虚拟机能上网，不受所在局域网变化影响
- **需要局域网其他设备访问虚拟机**：桥接，但换个网络 IP 就会变，公司网络可能限制一个网口多个 MAC
- **宿主机与虚拟机之间做实验或传文件**：仅主机，与外部网络完全隔离

---

## 三、Hyper-V

### 1、用内部交换机 + NAT 固定 IP

Default Switch 用的是内置 NAT 与 DHCP，它的网段会在宿主机重启后变化，虚拟机无法固定 IP。需要稳定地址时，自建一个内部交换机并加上 NAT（管理员 PowerShell）：

```powershell
# 1. 创建内部交换机，宿主机上会出现网卡 "vEthernet (NATSwitch)"
New-VMSwitch -SwitchName "NATSwitch" -SwitchType Internal

# 2. 给宿主机这块网卡分配网关地址
New-NetIPAddress -IPAddress 192.168.100.1 -PrefixLength 24 -InterfaceAlias "vEthernet (NATSwitch)"

# 3. 为该网段创建 NAT，使虚拟机能经宿主机出网
New-NetNat -Name "NATNetwork" -InternalIPInterfaceAddressPrefix 192.168.100.0/24

# 4. 把虚拟机网卡接到这个交换机（虚拟机名按实际填写）
Connect-VMNetworkAdapter -VMName "ubuntu" -SwitchName "NATSwitch"
```

这个网段没有 DHCP，虚拟机内需手动配置静态 IP。以 Ubuntu Server 为例，新建 `/etc/netplan/99-static.yaml`（网卡名用 `ip link` 确认，Hyper-V 下通常是 `eth0`）：

```yaml
network:
  version: 2
  ethernets:
    eth0:
      dhcp4: false
      addresses: [192.168.100.10/24]
      routes:
        - to: default
          via: 192.168.100.1
      nameservers:
        addresses: [223.5.5.5, 8.8.8.8]   # 宿主机不提供 DNS，填当前网络可用的 DNS
```

```bash
sudo chmod 600 /etc/netplan/99-static.yaml
sudo netplan apply
ip addr show eth0
```

::: warning 每台主机只支持一个 NetNat 网段
Windows 的 WinNAT 每台主机只支持一个内部 NAT 前缀。创建前用 `Get-NetNat` 查看是否已有，Docker 或其他工具可能已经占用；不需要时用 `Remove-NetNat -Name "NATNetwork"` 删除。
:::

### 2、扩容磁盘

虚拟机关机且没有检查点（快照）时，可以在 Hyper-V 管理器的「编辑磁盘」向导里扩展 VHDX，也可以用命令（路径按实际填写）：

```powershell
Resize-VHD -Path "D:\Hyper-V\ubuntu\ubuntu.vhdx" -SizeBytes 80GB
```

扩完后还要在虚拟机内扩分区和文件系统，步骤与 VMware 相同，见下文「扩容磁盘」。

---

## 四、VMware Workstation

### 1、NAT 模式固定 IP

VMware 的 NAT 网络带有 DHCP 和 DNS 转发，固定 IP 只需规划好网段：

1. 「编辑 → 虚拟网络编辑器 → 更改设置」，选中 VMnet8，把子网改成固定值，如 `192.168.88.0 / 255.255.255.0`
2. 点「NAT 设置」查看网关，默认是子网的 `.2`（`192.168.88.2`）；宿主机上的 VMnet8 网卡自动获得 `.1`，不需要手动修改
3. 点「DHCP 设置」把地址池限制在 `.128` 以上，静态 IP 用 `.3`–`.127`，避免冲突
4. 在虚拟机内配置静态 IP，网关和 DNS 都填 `.2`

Ubuntu（netplan，VMware 下网卡名通常是 `ens33`，用 `ip link` 确认）：

```yaml
network:
  version: 2
  ethernets:
    ens33:
      dhcp4: false
      addresses: [192.168.88.10/24]
      routes:
        - to: default
          via: 192.168.88.2
      nameservers:
        addresses: [192.168.88.2]
```

RHEL / Rocky / Alma（NetworkManager，连接名用 `nmcli con show` 查看，常见为 `ens160`）：

```bash
sudo nmcli con mod ens160 ipv4.method manual \
  ipv4.addresses 192.168.88.10/24 ipv4.gateway 192.168.88.2 ipv4.dns 192.168.88.2
sudo nmcli con up ens160
```

### 2、复制粘贴与共享

- 服务器类虚拟机直接用 SSH 客户端连接，最稳定，也便于用 `scp` 传文件
- 桌面类虚拟机安装 open-vm-tools（Linux 发行版仓库自带，桌面环境装 `open-vm-tools-desktop`），即可双向复制粘贴、拖放文件、自动调整分辨率；Windows 客户机安装 VMware Tools

```bash
# Ubuntu 桌面版
sudo apt install -y open-vm-tools-desktop
# RHEL / Rocky / Alma
sudo dnf install -y open-vm-tools
```

### 3、扩容磁盘

**宿主机侧**：虚拟机关机并删除全部快照后，在「虚拟机设置 → 硬盘 → 扩展」里调大容量；有快照时该按钮不可用。也可以用自带的命令行工具（路径按实际填写）：

```powershell
& "C:\Program Files (x86)\VMware\VMware Workstation\vmware-vdiskmanager.exe" -x 80GB "D:\VMs\ubuntu\ubuntu.vmdk"
```

**虚拟机内**：先用 `lsblk` 确认磁盘和分区布局，再扩分区和文件系统。`growpart` 在 Ubuntu 上属于 `cloud-guest-utils` 包，在 RHEL 系属于 `cloud-utils-growpart` 包。

```bash
lsblk

# 情况一：根分区是普通分区（如 /dev/sda2）
sudo growpart /dev/sda 2
sudo resize2fs /dev/sda2      # ext4
# sudo xfs_growfs /           # xfs（RHEL 系默认）

# 情况二：Ubuntu Server 默认的 LVM 布局（/dev/sda3 → ubuntu-vg/ubuntu-lv）
sudo growpart /dev/sda 3
sudo pvresize /dev/sda3
sudo lvextend -r -l +100%FREE /dev/ubuntu-vg/ubuntu-lv   # -r 同时扩文件系统

df -h /
```

内存和 CPU 在关机后直接在虚拟机设置里调整即可。

---

## 五、WSL 2

### 1、定位

WSL 2 在一个由 Windows 托管的轻量级工具虚拟机里运行真正的 Linux 内核，各发行版是这个虚拟机内的隔离环境。它是虚拟机，但不需要手动创建、配置和管理：按需启动，内存随用随还，内核随 Windows 更新。WSL 1 是系统调用翻译层，没有 Linux 内核，如今只在少数场景保留（见下文文件系统）。

### 2、常用命令

在 PowerShell 或 Windows Terminal 中执行：

```powershell
wsl --install                       # 安装 WSL 与默认发行版（Ubuntu）
wsl --list --online                 # 查看可安装的发行版
wsl --install -d Debian             # 安装指定发行版
wsl --list --verbose                # 查看已安装发行版、状态与 WSL 版本
wsl --set-default Debian            # 设置默认发行版
wsl --set-version Debian 2          # 把 WSL 1 发行版转换为 WSL 2
wsl -d Debian                       # 进入指定发行版
wsl --update                        # 更新 WSL 本体与内核
wsl --shutdown                      # 关闭所有发行版和 WSL 虚拟机
wsl --export Debian D:\backup\debian.tar         # 导出备份
wsl --import Debian2 D:\WSL\Debian2 D:\backup\debian.tar  # 导入为新发行版
```

### 3、文件系统：项目放在 Linux 一侧

WSL 2 的 Linux 文件系统位于 ext4 格式的虚拟磁盘中，`git clone`、`npm install`、Maven 构建等文件密集操作明显快于 WSL 1；但通过 `/mnt/c/...` 跨系统访问 Windows 文件反而比 WSL 1 慢。规则很简单：**工具在哪个系统里运行，文件就放在哪个系统里**。

- Linux 工具链开发：项目放在 `~/projects` 这类 Linux 路径下
- Windows 访问 Linux 文件：资源管理器地址栏输入 `\\wsl$`（或 `\\wsl.localhost`），或者在 WSL 中执行 `explorer.exe .`
- 编辑代码：VS Code 安装「WSL」扩展（`ms-vscode-remote.remote-wsl`），在 WSL 终端里执行 `code .`，编辑器界面在 Windows，文件读写和终端在 Linux 中进行

如果项目文件必须留在 Windows 文件系统，或者同一批文件要同时被 Windows 和 Linux 工具频繁读写，WSL 1 反而更合适。

### 4、网络：NAT 与镜像模式

WSL 2 默认使用 NAT：虚拟机有自己的私有 IP，每次重启都可能变化；Windows 可以通过 `localhost` 访问 WSL 中的服务，但局域网里的其他机器访问不到。

Windows 11 22H2 及以上推荐改用**镜像网络模式**（mirrored），在 `%UserProfile%\.wslconfig` 中配置：

```ini
[wsl2]
networkingMode=mirrored
# 可选：限制 WSL 虚拟机的内存上限与 CPU 核数
memory=8GB
processors=4
```

执行 `wsl --shutdown` 后重新进入即生效。镜像模式把 Windows 的网卡「镜像」进 Linux：WSL 与 Windows 共用 IP，双方互相用 `127.0.0.1` 访问，支持 IPv6 和局域网直连，对 VPN 的兼容性也更好。因此「给 WSL 固定 IP」的需求在镜像模式下不再存在。

局域网访问还需要放行 Hyper-V 防火墙（管理员 PowerShell，GUID 是 WSL 的固定标识）：

```powershell
Set-NetFirewallHyperVVMSetting -Name '{40E0AC32-46A5-438A-A0B2-2B479E8F2E90}' -DefaultInboundAction Allow
```

无法使用镜像模式的系统（Windows 10）只能用端口代理，把宿主机端口转发到 WSL 的当前 IP。WSL 重启后 IP 会变，需要重新执行：

```powershell
# 查看 WSL 当前 IP
wsl hostname -I
# 把宿主机 8080 端口转发到 WSL 的 8080（connectaddress 填上一步得到的 IP）
netsh interface portproxy add v4tov4 listenport=8080 listenaddress=0.0.0.0 connectport=8080 connectaddress=172.30.98.229
```

### 5、Docker Desktop 与替代方案

Windows 上的 Docker Desktop 默认使用 WSL 2 后端：容器运行在 Docker 自带的 `docker-desktop` 发行版中，开启「WSL Integration」后，在 PowerShell 和各个 WSL 发行版里都能直接用 `docker` 命令。

Docker Desktop 对个人、教育、非商业开源项目和小型企业免费，规模较大的企业商用需要付费订阅，具体门槛以 Docker 官方许可条款为准。不使用 Docker Desktop 时有三种替代方案：

- **在 WSL 发行版里直接安装 Docker Engine**：WSL 2 已支持 systemd，安装方式与普通 Linux 服务器相同
- **Rancher Desktop**：开源，可选 containerd 或 dockerd（Moby）作为引擎，自带单节点 Kubernetes
- **Podman Desktop**：基于无守护进程的 Podman，命令行与 Docker 基本兼容

Docker 本身的用法见下一篇 [Docker](./5_docker)。

---

## 小结

- 任一 Windows 虚拟化功能或 VBS 开启后，Hypervisor 独占硬件虚拟化；VMware Workstation 15.5.5+ 通过 WHP 与 Hyper-V / WSL 2 共存，只是失去嵌套虚拟化
- VMware Workstation Pro 自 2024 年 11 月起对个人和商业用户均免费
- 网络模式只有桥接、NAT、仅主机三种；Hyper-V 的内部交换机对应仅主机，需要 NAT 时用 Default Switch 或加 NetNat
- 固定 IP 的思路相同：固定网段、避开 DHCP 地址池、虚拟机内配静态地址；磁盘扩容分宿主机扩虚拟磁盘与客户机扩分区两步
- WSL 2 文件放 Linux 一侧，Windows 11 用镜像网络模式解决 IP 变化和局域网访问

## 参考资料

- Hyper-V 启用：[Microsoft Learn - Install Hyper-V](https://learn.microsoft.com/en-us/virtualization/hyper-v-on-windows/quick-start/enable-hyper-v)
- Hyper-V 虚拟交换机：[Microsoft Learn - Create a virtual switch for Hyper-V virtual machines](https://learn.microsoft.com/en-us/windows-server/virtualization/hyper-v/get-started/create-a-virtual-switch-for-hyper-v-virtual-machines)
- Hyper-V NAT 网络：[Microsoft Learn - Set up a NAT network](https://learn.microsoft.com/en-us/virtualization/hyper-v-on-windows/user-guide/setup-nat-network)
- VMware 与 Hyper-V 共存：[VMware Workstation Blog - VMware Workstation Now Supports Hyper-V Mode](https://blogs.vmware.com/workstation/2020/05/vmware-workstation-now-supports-hyper-v-mode.html)
- Workstation 免费：[VMware Cloud Foundation Blog - VMware Fusion and Workstation are Now Free for All Users](https://blogs.vmware.com/cloud-foundation/2024/11/11/vmware-fusion-and-workstation-are-now-free-for-all-users/)
- VMware Workstation 文档：[Broadcom TechDocs - VMware Workstation Pro](https://techdocs.broadcom.com/us/en/vmware-cis/desktop-hypervisors/workstation-pro/17-0.html)
- VirtualBox 网络模式：[VirtualBox User Manual - Virtual Networking](https://www.virtualbox.org/manual/topics/networkingdetails.html)
- WSL 版本对比：[Microsoft Learn - Comparing WSL Versions](https://learn.microsoft.com/en-us/windows/wsl/compare-versions)
- WSL 命令：[Microsoft Learn - Basic commands for WSL](https://learn.microsoft.com/en-us/windows/wsl/basic-commands)
- WSL 网络：[Microsoft Learn - Accessing network applications with WSL](https://learn.microsoft.com/en-us/windows/wsl/networking)
- `.wslconfig` 配置项：[Microsoft Learn - Advanced settings configuration in WSL](https://learn.microsoft.com/en-us/windows/wsl/wsl-config)
- VS Code WSL 扩展：[VS Code 文档 - Developing in WSL](https://code.visualstudio.com/docs/remote/wsl)
- Docker Desktop WSL 2 后端：[Docker Docs - Docker Desktop WSL 2 backend on Windows](https://docs.docker.com/desktop/features/wsl/)
- Docker Desktop 许可：[Docker Docs - Docker Desktop license agreement](https://docs.docker.com/subscription/desktop-license/)

> 下一篇：[Docker](./5_docker)
