---
description: Hyper-V、VMware、WSL
---

# 虚拟化工具

> 三种在 Windows 上常用的本地虚拟化方案，概念对比详见 [VM 概述](3_virtual.md)。

---

## 一、Hyper-V

官网：[Hyper-V 微软官网](https://learn.microsoft.com/zh-cn/windows-server/virtualization/hyper-v/hyper-v-overview)

### 1、网络模式

| 模式 | 类比 VMware | 说明 |
|------|------------|------|
| **外部虚拟网络** | 桥接模式 | 虚拟机与宿主机、外部设备互通，可被局域网访问 |
| **内部虚拟网络** | NAT 模式 | 虚拟机与宿主机互通，但不绑定物理网卡，无法被外部访问 |
| **专用虚拟网络** | 仅主机模式 | 仅虚拟机之间互通，宿主机和外部均无法访问 |

### 2、设置固定 IP

Hyper-V 自带的 Default Switch 每次重启会自动分配不同网段，无法固定 IP。解决方式：

- 创建自定义内部网络交换机，手动指定网段，虚拟机设置静态 IP
- 新增一块仅内网网卡用于宿主机访问，保留 Default Switch 用于上网
- 使用外部虚拟网络，与宿主机处于同一内网（IP 随路由器分配）

参考文章：[https://zahui.fan/posts/6f952944/](https://zahui.fan/posts/6f952944/)

---

## 二、VMware

### 1、网络模式

| 模式 | 说明 | 适用场景 |
|------|------|---------|
| **Bridged（桥接）** | 虚拟机与宿主机同一局域网，可被外部设备访问 | 开发/测试对外服务 |
| **NAT** | 通过宿主机共享网络，外部无法主动访问虚拟机 | 日常上网、软件安装 |
| **Host-only（仅主机）** | 只能与宿主机通信，不能访问外网 | 宿主机与虚拟机内部传输 |

### 2、设置固定 IP（NAT 方式）

1. 虚拟网络编辑器中固定 VMnet8 的子网网段
2. 在 Windows 网络适配器中设置 VMnet8 的网关 IP
3. 虚拟机内配置静态 IP（网关、本机 IP 与上面保持一致）

### 3、与宿主机复制粘贴

- 推荐直接用 SSH 客户端连接，最稳定
- 桌面版虚拟机：安装 VMware Tools 后可直接双向复制粘贴

### 4、虚拟机扩容

- **内存**：关机后在虚拟机设置里直接调整
- **硬盘**：参考 [CSDN 教程](https://blog.csdn.net/weixin_45962133/article/details/140315006)

---

## 三、WSL

### 1、简介

WSL（Windows Subsystem for Linux）是微软推出的兼容层，允许在 Windows 上原生运行 Linux 工具，无需虚拟机或双系统。

**WSL 2 特性（推荐使用）：**

- 基于轻量 Hyper-V，运行完整 Linux 内核
- 文件系统性能大幅提升，支持完整系统调用
- 启动速度快，资源占用低
- 与 Windows 文件系统双向访问（`/mnt/c/...`）

### 2、与 Docker 的关系

Docker Desktop 在 Windows 上默认基于 WSL 2 运行：

- 安装后自动创建 `docker-desktop` WSL 2 发行版
- 所有容器运行在此 WSL 2 环境中
- `docker` 命令可在 CMD / PowerShell / WSL 中直接使用

### 3、常用命令

```bash
wsl --install                        # 安装 WSL（Windows Terminal 执行）
wsl --list --online                  # 查看可用发行版
wsl --install -d Ubuntu              # 安装 Ubuntu
wsl --list --verbose                 # 查看已安装发行版
wsl --set-default Ubuntu             # 设置默认发行版
wsl --set-version Ubuntu 2           # 升级为 WSL 2
wsl -d Ubuntu                        # 打开指定发行版
wsl --shutdown                       # 关闭所有 WSL
```

### 4、实用技巧

- `/mnt/c/...` 在 WSL 中访问 Windows C 盘
- WSL 内执行 `explorer.exe .` 可用资源管理器打开当前目录
- VSCode 安装 Remote - WSL 插件后可直接编辑 Linux 文件
- 固定 IP：`> [!warning] 待补充`

### 5、推荐使用场景

| 场景 | 推荐方案 |
|------|---------|
| 本地 Linux 命令行开发 | WSL 2 |
| Windows 上使用 Docker | Docker Desktop + WSL 2 |
| 前后端开发（Node / Python / Go） | WSL 2 + VSCode Remote |
| 替代传统虚拟机（轻量） | WSL 2 |
