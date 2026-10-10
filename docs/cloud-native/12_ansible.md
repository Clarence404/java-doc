---
description: 无 Agent 架构、Inventory、Playbook、幂等与 Handler、Role、Vault、滚动发布
---

# Ansible

> 前置阅读：[Terraform](./11_terraform)、[Linux 概览](./1_linux)

Ansible 是用 YAML 描述机器应有状态的配置管理与自动化工具。本篇讲无 Agent 架构、Playbook 与 Role、幂等、Vault 和滚动发布，基线为 ansible-core 2.21。

---

## 一、定位：与 Terraform 的分工

Ansible 由 Red Hat 主导；版本基线为 ansible-core 2.21 和社区包 ansible 14，示例为部署 Java 应用。

两者都是「用代码管基础设施」，但管的阶段不同：

| | Terraform | Ansible |
|---|---|---|
| 阶段 | Provision（造机器） | Configure（配机器） |
| 管什么 | VPC、ECS、RDS、负载均衡等云资源 | 机器内部：装软件、改配置、部署应用、批量运维 |
| 模型 | 声明式，State 文件记录现状 | 任务按顺序执行，模块保证幂等，无 State |
| 语言 | HCL | YAML（Playbook） |

**经典组合**：Terraform 创建服务器并输出 IP，Ansible 接手装 JDK、发应用、配 Nginx。

---

## 二、架构：无 Agent

![Ansible 无 Agent 架构](../assets/cloud-native/ansible-architecture.svg)

控制节点通过 SSH 连上目标机器，把模块（一小段 Python 程序）传过去执行，取回结果后清理临时文件。被管节点只需要 **SSH 和 Python 3**，不用常驻任何进程。

| | Ansible | Chef / Puppet / Salt |
|---|---|---|
| 节点侧 | 无 Agent（SSH） | 需安装 Agent / Minion |
| 服务端 | 无，一台装了 Ansible 的机器即可 | 需要 Server / Master |
| 上手成本 | 低 | 高 |
| 超大规模推送 | 一般（SSH 并发有限） | 更好（Agent 长连接） |

**推模式与拉模式**：默认由人或 CI 触发、从控制节点推送。需要节点自主收敛时有三种补充：`ansible-pull`（节点定时从 Git 拉取 Playbook 自己执行）、Event-Driven Ansible（按监控告警等事件触发 Playbook）、以及 AAP（Ansible Automation Platform）这类集中调度平台。

---

## 三、快速上手

下文所有模块都写全限定名（FQCN，如 `ansible.builtin.copy`），这是官方推荐写法，也能避免与第三方集合的同名模块冲突。

### 1、安装

```bash
# 官方推荐用 pipx 安装到隔离环境；--include-deps 让 ansible 包附带的命令也可用
pipx install --include-deps ansible

ansible --version
```

两个包的关系：`ansible-core` 是引擎和 `ansible.builtin` 内置模块；`ansible` 是社区发行包，在 core 之上打包了大量常用集合（`community.general`、`ansible.posix` 等）。ansible-core 2.21 要求控制节点 Python 3.12 及以上；控制节点不支持 Windows，Windows 上可在 WSL 里运行。

### 2、Inventory（主机清单）

```ini
# inventory.ini
[web]
web1 ansible_host=192.168.1.11
web2 ansible_host=192.168.1.12

[db]
db1 ansible_host=192.168.1.21

[all:vars]
ansible_user=deploy
ansible_ssh_private_key_file=~/.ssh/id_ed25519
```

### 3、Ad-hoc 命令（一次性批量操作）

```bash
# 探活所有主机（验证 SSH 与 Python 可用，不是 ICMP ping）
ansible all -i inventory.ini -m ansible.builtin.ping

# web 组批量查看磁盘
ansible web -i inventory.ini -m ansible.builtin.command -a "df -h"

# 批量分发文件（写 /etc 需要提权，加 --become）
ansible web -i inventory.ini --become -m ansible.builtin.copy -a "src=app.conf dest=/etc/app/app.conf mode=0644"
```

---

## 四、Playbook：部署一个 Java 应用

Playbook 是 YAML 编排的任务序列。下例完成「装 JDK、建运行用户、传 jar、配 systemd、启动」，同时兼容 RHEL / Rocky / Alma 9+ 和 Ubuntu 24.04：

```yaml
# deploy-app.yml
- name: 部署订单服务
  hosts: web
  become: true                          # sudo 提权
  vars:
    app_name: order-service
    app_port: 8080
    jdk_package:                        # 不同发行版的 JDK 21 包名
      RedHat: java-21-openjdk-headless
      Debian: openjdk-21-jre-headless

  tasks:
    - name: 安装 JDK 21
      ansible.builtin.package:          # 自动选择 dnf / apt
        name: "{{ jdk_package[ansible_facts['os_family']] }}"
        state: present                  # 幂等：已装则跳过

    - name: 创建运行用户
      ansible.builtin.user:
        name: "{{ app_name }}"
        system: true
        shell: /sbin/nologin
        create_home: false

    - name: 创建应用目录
      ansible.builtin.file:
        path: /opt/{{ app_name }}
        state: directory
        owner: "{{ app_name }}"
        mode: "0755"

    - name: 上传应用 jar
      ansible.builtin.copy:
        src: build/{{ app_name }}.jar   # 相对 Playbook 所在目录
        dest: /opt/{{ app_name }}/app.jar
        owner: "{{ app_name }}"
        mode: "0644"
      notify: restart app               # 文件有变化才触发 handler

    - name: 渲染 systemd 服务文件
      ansible.builtin.template:
        src: templates/app.service.j2
        dest: /etc/systemd/system/{{ app_name }}.service
        mode: "0644"
      notify: restart app

    - name: 确保服务开机自启并运行
      ansible.builtin.systemd_service:
        name: "{{ app_name }}"
        state: started
        enabled: true
        daemon_reload: true

  handlers:
    - name: restart app
      ansible.builtin.systemd_service:
        name: "{{ app_name }}"
        state: restarted
        daemon_reload: true
```

模板文件用 Jinja2 语法引用变量：

```ini
# templates/app.service.j2
[Unit]
Description={{ app_name }}
After=network-online.target
Wants=network-online.target

[Service]
User={{ app_name }}
ExecStart=/usr/bin/java -jar /opt/{{ app_name }}/app.jar --server.port={{ app_port }}
SuccessExitStatus=143
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

```bash
ansible-playbook -i inventory.ini deploy-app.yml
```

`SuccessExitStatus=143` 让 systemd 把 JVM 收到 SIGTERM 后的退出码视为正常停止。停机时如何让应用先摘流量、处理完在途请求，见 [优雅上下线](/high-avail/8_graceful_release)。

---

## 五、核心机制

### 1、幂等性

模块声明**期望状态**而不是动作：`state: present` 表示「应该装着」，已装就跳过，结果显示 `ok` 而不是 `changed`。这让 Playbook 可以反复执行、失败后重跑。`ansible.builtin.shell` / `ansible.builtin.command` **没有**幂等保证，能用专用模块就不要写裸命令；实在要用，配合 `creates:` 或 `changed_when:` 告诉 Ansible 什么情况算变更。

### 2、Handler：有变更才触发

`notify` + `handlers` 实现「配置文件变了才重启服务」。重复执行 Playbook 时配置没变，服务就不会被无谓重启。Handler 默认在整个 play 的任务都跑完后统一执行一次，多个任务通知同一个 Handler 也只重启一次。

### 3、变量、Facts 与条件

```yaml
# Facts 是 Ansible 自动采集的目标机信息，条件和模板里可以直接用
- name: 只在 RedHat 系（RHEL / Rocky / Alma）上安装 SELinux 管理工具
  ansible.builtin.dnf:
    name: policycoreutils-python-utils
    state: present
  when: ansible_facts['os_family'] == "RedHat"

# 循环
- name: 创建多个运维账号
  ansible.builtin.user:
    name: "{{ item }}"
    state: present
  loop: [deploy, monitor, backup]
```

> [!warning]
> `ansible.builtin.yum` 在 ansible-core 2.17 中已移除，现在只是重定向到 `ansible.builtin.dnf`。RedHat 系一律写 `dnf`；要跨发行版就用 `ansible.builtin.package`。

变量可以写在 Playbook、`group_vars/<组名>/`、`host_vars/<主机名>/` 或命令行 `-e`，优先级从低到高大致是：Role 的 defaults → Inventory / group_vars → Playbook vars → 命令行 `-e`。

### 4、Vault：敏感信息加密

```bash
# 加密变量文件（数据库密码等），密文可以提交到 Git
ansible-vault encrypt group_vars/prod/secrets.yml

# 交互输入密码执行
ansible-playbook -i inventory.ini deploy-app.yml --ask-vault-pass

# CI 中从文件读取密码（文件由 CI 的密钥管理注入，不进仓库）
ansible-playbook -i inventory.ini deploy-app.yml --vault-password-file /run/secrets/vault_pass
```

Vault 解决的是「密钥能安全地放进仓库」，密钥轮换与集中管理的更完整做法见 [数据安全](/security/7_data_security)。

---

## 六、Role：工程化组织

单文件 Playbook 写长了难维护，Role 是标准化的复用单元。用官方命令生成骨架：

```bash
ansible-galaxy role init --init-path roles java-app
```

```text
roles/
└── java-app/
    ├── defaults/main.yml     # 默认变量，优先级最低，供使用方覆盖
    ├── vars/main.yml         # Role 内部固定变量
    ├── tasks/main.yml        # 任务入口
    ├── handlers/main.yml     # handler
    ├── templates/            # Jinja2 模板
    ├── files/                # 原样拷贝的静态文件
    ├── meta/main.yml         # 元信息与依赖的其他 Role
    ├── tests/                # 测试用 inventory 与 Playbook
    └── README.md
```

```yaml
# site.yml：同一个 Role 部署两个服务
- name: 部署 Java 服务
  hosts: web
  become: true
  roles:
    - role: java-app
      vars:
        app_name: order-service
    - role: java-app
      vars:
        app_name: user-service
```

社区内容在 [Ansible Galaxy](https://galaxy.ansible.com/) 分享，现在以**集合（Collection）**为主要分发单位，一个集合打包了模块、插件和 Role。项目依赖写进 `requirements.yml`，用 `ansible-galaxy collection install -r requirements.yml` 安装。

---

## 七、工程实践

- **滚动发布**：play 级别设 `serial: 2` 每批 2 台执行，配合 `max_fail_percentage` 在失败比例超标时停止，控制爆炸半径；发布前后可结合负载均衡摘除与健康检查
- **演练模式**：`ansible-playbook -i inventory.ini deploy-app.yml --check --diff` 只展示将发生的变更，不实际执行，作用类似 `terraform plan`
- **tags**：给任务打标签，`--tags deploy` 只跑发布相关的任务，加速日常发布
- **与 Terraform 衔接**：Terraform 的 `output` 渲染出 inventory 文件，或用 `cloud.terraform` 集合的 inventory 插件直接读取 State；云上也可以用各厂商的动态 inventory 插件按标签分组
- **可复现的控制节点**：用 Execution Environment（打包了 ansible-core、集合与 Python 依赖的容器镜像）配合 `ansible-navigator` 运行，本地和 CI 用同一套依赖
- **容器时代的位置**：应用容器化后，Ansible 退到**虚机层**，负责初始化节点、安装容器运行时和 K8s 本身、管理非容器化中间件；应用发布交给 [Helm](./8_helm) / [Argo CD](./9_argocd)，流水线编排见 [CI/CD](/devops/2_ci_cd)

---

## 小结

- Ansible 负责「配机器」，Terraform 负责「造机器」，常见组合是 Terraform 输出 IP、Ansible 接手配置
- 无 Agent：控制节点经 SSH 推送模块执行，被管节点只需 SSH 和 Python 3
- 模块保证幂等，Handler 实现「有变更才重启」；模块写 FQCN，RedHat 系用 `dnf` 或通用的 `package`，不再用 `yum`
- Role 和集合是复用单位，Vault 让密钥能安全进仓库，`serial` + `--check --diff` 是发布安全的两道闸

## 参考资料

- Ansible 官方文档：[docs.ansible.com](https://docs.ansible.com/)
- Ansible 安装指南（pipx）：[Installing Ansible](https://docs.ansible.com/ansible/latest/installation_guide/intro_installation.html)
- ansible-core 支持矩阵与版本说明：[Releases and maintenance](https://docs.ansible.com/ansible/latest/reference_appendices/release_and_maintenance.html)
- ansible.builtin 模块索引：[Ansible.Builtin](https://docs.ansible.com/ansible/latest/collections/ansible/builtin/index.html)
- Ansible Vault：[Protecting sensitive data with Ansible vault](https://docs.ansible.com/ansible/latest/vault_guide/index.html)
- Ansible Galaxy：[galaxy.ansible.com](https://galaxy.ansible.com/)

> 下一篇：[cloud-init 与 Packer](./12_cloud_init)
