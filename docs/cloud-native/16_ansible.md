# Ansible

- 官网：[https://www.ansible.com](https://www.ansible.com/)
- 文档：[https://docs.ansible.com](https://docs.ansible.com/)

## 一、定位：与 Terraform 的分工

两者都是"用代码管基础设施"，但管的阶段不同：

| | Terraform | Ansible |
|---|---|---|
| 阶段 | **Provision（造机器）** | **Configure（配机器）** |
| 管什么 | VPC / ECS / RDS / 负载均衡等云资源 | 机器内部：装软件、改配置、部署应用、批量运维 |
| 模型 | 声明式 + State 文件记录现状 | 声明式任务 + 幂等模块，无 State |
| 语言 | HCL | YAML（Playbook）|

**经典组合**：Terraform 把服务器创建出来 → 输出 IP 清单 → Ansible 接手装 JDK、发应用、配 Nginx。

---

## 二、架构：无 Agent

![Ansible 无 Agent 架构](../assets/cloud-native/ansible-architecture.svg)

Ansible 最大的特点是**无 Agent**：控制节点通过 SSH 连接目标机器，把模块（小段 Python 脚本）推过去执行、拿回结果、删除现场。被管节点只需要 SSH 和 Python，**不用安装任何东西**。

| | Ansible | Chef / Puppet / SaltStack |
|---|---|---|
| 节点侧 | 无 Agent（SSH）| 需安装 Agent / Minion |
| 服务端 | 无（一台装了 ansible 的机器即可）| 需 Server 端 |
| 上手成本 | 低 | 高 |
| 超大规模推送性能 | 一般（SSH 逐台）| 更好（Agent 长连接）|

> 也正因为无 Agent，Ansible 适合"人或 CI 触发"的推模式；需要节点自主收敛的拉模式场景（数千台持续合规）才考虑 Agent 系。

---

## 三、快速上手

```bash
# 控制节点安装（仅控制节点，目标机器什么都不用装）
pip install ansible
```

**Inventory（主机清单）**：

```ini
# inventory.ini
[web]
web1 ansible_host=192.168.1.11
web2 ansible_host=192.168.1.12

[db]
db1 ansible_host=192.168.1.21

[all:vars]
ansible_user=deploy
ansible_ssh_private_key_file=~/.ssh/id_rsa
```

**Ad-hoc 命令（一次性批量操作）**：

```bash
# 探活所有主机
ansible all -i inventory.ini -m ping

# web 组批量查看磁盘
ansible web -i inventory.ini -m shell -a "df -h"

# 批量分发文件
ansible web -i inventory.ini -m copy -a "src=app.conf dest=/etc/app/app.conf"
```

---

## 四、Playbook：部署一个 Java 应用

Playbook 是 YAML 编排的任务序列，下例完成 装 JDK → 传 jar → 配 systemd → 启动：

```yaml
# deploy-app.yml
- name: 部署订单服务
  hosts: web
  become: true                         # sudo 提权
  vars:
    app_name: order-service
    app_port: 8080

  tasks:
    - name: 安装 JDK 17
      ansible.builtin.yum:
        name: java-17-openjdk
        state: present                 # 幂等：已装则跳过

    - name: 创建应用目录
      ansible.builtin.file:
        path: /opt/{{ app_name }}
        state: directory
        mode: '0755'

    - name: 上传应用 jar
      ansible.builtin.copy:
        src: build/{{ app_name }}.jar
        dest: /opt/{{ app_name }}/app.jar
      notify: restart app              # 文件有变化才触发 handler

    - name: 渲染 systemd 服务文件（Jinja2 模板）
      ansible.builtin.template:
        src: app.service.j2
        dest: /etc/systemd/system/{{ app_name }}.service
      notify: restart app

    - name: 确保服务开机自启并运行
      ansible.builtin.systemd:
        name: "{{ app_name }}"
        state: started
        enabled: true
        daemon_reload: true

  handlers:
    - name: restart app
      ansible.builtin.systemd:
        name: "{{ app_name }}"
        state: restarted
```

```bash
ansible-playbook -i inventory.ini deploy-app.yml
```

---

## 五、核心机制

### 1、幂等性

模块声明**期望状态**而非动作：`state: present` 表示"应该装着"，已装就跳过（结果显示 `ok` 而非 `changed`）。这让 Playbook 可以反复执行、失败重跑，是 Ansible 的立身之本。`shell`/`command` 模块**没有**幂等保证，能用专用模块就不要写裸命令。

### 2、Handler：变更才触发

`notify` + `handlers` 实现"配置文件变了才重启服务"——重复执行 Playbook 时配置没变化，服务就不会被无谓重启。

### 3、变量与 Facts

```yaml
# facts：Ansible 自动采集的目标机信息，模板和条件里直接用
- name: 只在 CentOS 上执行
  ansible.builtin.yum: {name: xxx, state: present}
  when: ansible_facts['os_family'] == "RedHat"

# 循环
- name: 创建多个用户
  ansible.builtin.user: {name: "{{ item }}", state: present}
  loop: [deploy, monitor, backup]
```

### 4、Vault：敏感信息加密

```bash
# 加密变量文件（数据库密码等），密文可安全提交 git
ansible-vault encrypt group_vars/prod/secrets.yml
ansible-playbook deploy-app.yml --ask-vault-pass
```

---

## 六、Role：工程化组织

单文件 Playbook 长了难维护，Role 是标准化的复用单元：

```
roles/
└── java-app/
    ├── tasks/main.yml        # 任务
    ├── handlers/main.yml     # handler
    ├── templates/            # Jinja2 模板
    ├── defaults/main.yml     # 默认变量（可被覆盖）
    └── vars/main.yml         # 固定变量
```

```yaml
- hosts: web
  roles:
    - role: java-app
      vars: {app_name: order-service}
    - role: java-app
      vars: {app_name: user-service}
```

社区 Role 仓库 [Ansible Galaxy](https://galaxy.ansible.com/)：nginx、mysql、docker 等常见组件都有现成 Role。

---

## 七、工程实践

- **滚动发布**：`serial: 2` 每批 2 台执行，配合 `max_fail_percentage` 控制爆炸半径
- **演练模式**：`ansible-playbook --check --diff` 只显示将发生的变更，不实际执行（类似 `terraform plan`）
- **tags**：`--tags deploy` 只跑打了标签的任务，加速日常发布
- **与 Terraform 衔接**：Terraform `output` 生成主机 IP → 动态 Inventory（或模板渲染 inventory 文件）→ Ansible 接管
- **容器时代的位置**：应用已容器化（K8s）后，Ansible 退到**虚机层**——初始化节点、装 Docker/K8s 本身、管理非容器化中间件；应用发布交给 [Helm](./7_helm) / [Argo CD](./8_argocd)

---

## 八、相关文档

- [Terraform](./10_terraform)：先造机器，再用 Ansible 配置
- [Docker](./4_docker) / [Kubernetes](./5_kubernetes)：容器化后的应用交付主路径
- [CI/CD](../devops/2_ci_cd)：Ansible 常作为流水线的部署执行器
