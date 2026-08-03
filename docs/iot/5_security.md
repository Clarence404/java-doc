# IoT 安全

> 参考资料：
> * OWASP IoT Top 10：[https://owasp.org/www-project-internet-of-things/](https://owasp.org/www-project-internet-of-things/)
> * EMQX 安全文档：[https://www.emqx.io/docs/zh/latest/access-control/overview.html](https://www.emqx.io/docs/zh/latest/access-control/overview.html)

## 一、IoT 安全的特殊性

与普通 Web 安全相比，IoT 安全面临更多挑战：

| 挑战 | 说明 |
|------|------|
| 设备资源受限 | MCU 内存 / CPU 有限，无法运行重型加密算法 |
| 设备数量庞大 | 数万台设备，统一管理认证复杂 |
| 长期部署无人值守 | 设备部署后难以物理接触，漏洞修复靠 OTA |
| 通信环境复杂 | 无线信道易被监听、伪造 |
| 供应链风险 | 硬件固件可能被篡改 |

---

## 二、设备认证

### 认证方式对比

| 方式 | 说明 | 适用场景 |
|------|------|---------|
| **用户名/密码** | MQTT 连接时携带 username + password | 简单场景，安全性低 |
| **Token** | 设备携带平台颁发的 Token，定期刷新 | 互联网 IoT 平台 |
| **PSK（预共享密钥）** | 设备出厂烧录唯一密钥，握手时验证 | 资源受限设备 |
| **X.509 证书** | 设备持有客户端证书，双向 TLS 认证 | 安全要求高的工业场景 |

### 一机一密 vs 一型一密

| 模式 | 说明 | 安全性 |
|------|------|--------|
| **一机一密** | 每台设备有唯一的 DeviceSecret，出厂预烧录 | 高，单设备泄露不影响其他 |
| **一型一密** | 同型号设备共用 ProductSecret，首次连接后动态获取设备密钥 | 中，适合量产激活 |

---

## 三、传输加密

### TLS / DTLS

- **TLS（Transport Layer Security）**：基于 TCP，保护 MQTT / HTTP / OPC-UA 通信
- **DTLS（Datagram TLS）**：基于 UDP，保护 CoAP 通信
- 作用：防止中间人监听、篡改数据

设备通过 TLS 加密连接到 MQTT Broker（EMQX），Broker 验证服务端证书；开启双向认证时设备也需提供客户端证书。

**MQTT over TLS 配置要点（EMQX）：**

```yaml
listeners.ssl.default {
  bind = "0.0.0.0:8883"
  ssl_options {
    cacertfile = "/etc/emqx/certs/ca.pem"
    certfile   = "/etc/emqx/certs/server.pem"
    keyfile    = "/etc/emqx/certs/server.key"
    verify     = verify_peer      # 开启双向认证
  }
}
```

---

## 四、访问控制

### Topic 级别权限控制

MQTT 中每个设备只应能发布/订阅属于自己的 Topic，防止越权操作：

```
# 规则示例：设备只能操作自己 ID 对应的 Topic
设备 device-001 允许发布：devices/device-001/data
设备 device-001 禁止发布：devices/device-002/data
```

EMQX 支持通过 ACL 规则（文件 / 数据库 / HTTP 回调）实现 Topic 粒度权限控制。

---

## 五、常见攻击与防护

| 攻击类型 | 说明 | 防护措施 |
|---------|------|---------|
| **重放攻击** | 截获合法消息重复发送 | 消息加时间戳 + Nonce，服务端去重 |
| **中间人攻击** | 劫持通信，篡改数据 | TLS 双向证书认证 |
| **暴力破解** | 枚举猜测设备密码 | 限制连接频率，强密码策略 |
| **DDoS / 连接风暴** | 大量设备同时重连压垮 Broker | 退避重连策略，连接速率限制 |
| **固件篡改** | 替换设备固件植入后门 | OTA 固件签名验证 |

### OTA 安全升级流程

```
1. 厂商对固件包进行数字签名（私钥）
2. 平台下发升级指令 + 固件下载地址 + 签名
3. 设备下载固件
4. 设备用内置公钥验证签名
5. 签名合法 → 安装；不合法 → 拒绝，告警
```

---

## 六、安全检查清单

- [ ] 设备连接使用 TLS 加密（端口 8883 而非 1883）
- [ ] 禁用 MQTT 匿名连接
- [ ] 每台设备使用唯一的 Client ID + 认证凭证
- [ ] Topic 设置 ACL，设备只能访问自己的 Topic
- [ ] OTA 固件包验证签名
- [ ] 定期轮换设备证书 / Token
- [ ] Broker 开启连接速率限制，防止连接风暴
- [ ] 生产环境禁用调试接口和测试账号

## 七、X.509 证书生成与设备烧录

### 完整 openssl 命令流程

**第一步：生成 CA 私钥和自签名根证书**

```bash
# 生成 CA 私钥（4096 位 RSA）
openssl genrsa -out ca.key 4096

# 用 CA 私钥自签名根证书，有效期 10 年
openssl req -new -x509 -days 3650 \
  -key ca.key \
  -out ca.pem \
  -subj "/C=CN/ST=Shanghai/O=MyCompany/CN=IoT-Root-CA"
```

**第二步：为单台设备生成私钥**

```bash
# 设备私钥（2048 位即可满足大多数 IoT 场景）
openssl genrsa -out device-001.key 2048
```

**第三步：生成 CSR（证书签名请求）**

```bash
# CN 字段填写设备唯一标识（与 MQTT Client ID 保持一致，便于 Broker 识别）
openssl req -new \
  -key device-001.key \
  -out device-001.csr \
  -subj "/C=CN/ST=Shanghai/O=MyCompany/CN=device-001"
```

**第四步：用 CA 签发设备证书，有效期 2 年**

```bash
openssl x509 -req -days 730 \
  -in device-001.csr \
  -CA ca.pem \
  -CAkey ca.key \
  -CAcreateserial \
  -out device-001.pem

# 验证证书内容
openssl x509 -in device-001.pem -noout -text
```

### 批量设备证书生成脚本

```bash
#!/bin/bash
# batch_gen_certs.sh
# 用法：./batch_gen_certs.sh device-001 device-002 device-003 ...

CA_KEY="ca.key"
CA_PEM="ca.pem"
CERT_DIR="./certs"
DAYS=730  # 证书有效期 2 年

mkdir -p "$CERT_DIR"

for DEVICE_ID in "$@"; do
  echo ">>> 生成设备证书：$DEVICE_ID"

  # 生成设备私钥
  openssl genrsa -out "$CERT_DIR/$DEVICE_ID.key" 2048

  # 生成 CSR
  openssl req -new \
    -key "$CERT_DIR/$DEVICE_ID.key" \
    -out "$CERT_DIR/$DEVICE_ID.csr" \
    -subj "/C=CN/O=MyCompany/CN=$DEVICE_ID"

  # CA 签发证书
  openssl x509 -req -days $DAYS \
    -in "$CERT_DIR/$DEVICE_ID.csr" \
    -CA "$CA_PEM" \
    -CAkey "$CA_KEY" \
    -CAcreateserial \
    -out "$CERT_DIR/$DEVICE_ID.pem"

  # 清理 CSR（不需要保留）
  rm "$CERT_DIR/$DEVICE_ID.csr"

  echo "    完成：$CERT_DIR/$DEVICE_ID.key / $DEVICE_ID.pem"
done

echo "=== 批量生成完毕，共 $# 台设备 ==="
```

调用示例：

```bash
chmod +x batch_gen_certs.sh
./batch_gen_certs.sh device-001 device-002 device-003
```

### 设备烧录要点

每台设备固件中需烧录以下三个文件：

| 文件 | 作用 | 保密性 |
|------|------|--------|
| `ca.pem` | 根证书（信任链），设备用它验证 Broker 身份 | 公开 |
| `device-xxx.pem` | 设备证书，Broker 用它验证设备身份 | 公开 |
| `device-xxx.key` | 设备私钥，TLS 握手时使用 | **严格保密，不可泄露** |

**烧录注意事项：**

- 私钥应存储在设备的安全存储区（如 MCU 的 Flash 加密区、TPM 芯片），防止物理读取
- 生产线烧录流程需在离线内网环境中进行，防止证书文件在传输过程中被截获
- 烧录完成后记录设备 ID 与证书序列号的对应关系，方便日后吊销管理

### 证书有效期管理

- **推荐有效期：1~2 年**，过短会增加 OTA 更新频率，过长会增加证书泄露的风险窗口
- **到期前提醒**：平台应在证书到期前 30 天推送告警，触发 OTA 更新流程
- **更新流程**：平台下发新证书文件 → 设备通过当前有效的 TLS 连接下载 → 安装并重启连接
- **证书吊销**：设备报废或密钥泄露时，在 CA 吊销列表（CRL）或 OCSP 中记录，Broker 定期同步

---

## 八、EMQX ACL 规则详细配置

### ACL 三种配置方式

| 方式 | 文件/接口 | 适用场景 |
|------|---------|---------|
| **文件（acl.conf）** | `etc/acl.conf` | 规则固定、数量少，适合小规模部署 |
| **内置数据库（Mnesia）** | EMQX Dashboard / HTTP API | 规则动态变更，无需重启 |
| **外部数据库（MySQL / PostgreSQL）** | 配置 EMQX 插件连接外部 DB | 规则量大，与业务系统集成 |

### acl.conf 文件语法

```erlang
%% 格式：{allow | deny, 匹配条件, 操作, [Topic 列表]}
%%
%% 匹配条件：
%%   all                  — 所有客户端
%%   {user, "username"}   — 指定用户名
%%   {clientid, "id"}     — 指定 Client ID
%%   {ipaddr, "ip/cidr"}  — 指定 IP 地址段

%% 1. 设备只能发布/订阅自己 clientid 对应的 Topic
%%    %c 是 Client ID 占位符，%u 是 username 占位符
{allow, all, pubsub, ["devices/%c/data", "devices/%c/cmd"]}.

%% 2. 服务端账号（username = "server"）可以订阅所有设备 Topic
{allow, {user, "server"}, subscribe, ["devices/#"]}.

%% 3. 服务端账号可以向任意设备下发命令
{allow, {user, "server"}, publish, ["devices/+/cmd"]}.

%% 4. 拒绝所有匿名客户端（username 为空）
{deny, {user, ""}, all, ["#"]}.

%% 5. 默认规则：拒绝所有（放在文件末尾）
{deny, all}.
```

### 常用规则场景示例

**场景 1：设备只能操作自己的 Topic（%c 占位符）**

```erlang
%% device-001 连接后，%c 替换为 device-001
%% 该设备只能发布 devices/device-001/data，无法发布 devices/device-002/data
{allow, all, pubsub, ["devices/%c/#"]}.
```

**场景 2：后台服务订阅所有设备上报数据**

```erlang
{allow, {user, "backend-service"}, subscribe, ["devices/#", "$SYS/#"]}.
```

**场景 3：拒绝所有匿名客户端**

```erlang
{deny, {user, ""}, all, ["#"]}.
{deny, {clientid, ""}, all, ["#"]}.
```

### 通过 EMQX HTTP API 动态管理 ACL 规则

EMQX 5.x 支持通过 REST API 对内置数据库中的 ACL 规则进行 CRUD 操作，无需重启服务。

**为指定客户端添加 ACL 规则：**

```bash
# 允许 device-001 发布到自己的数据 Topic
curl -X POST "http://emqx-host:18083/api/v5/authorization/sources/built_in_database/rules/clients" \
  -H "Content-Type: application/json" \
  -u "admin:your_password" \
  -d '{
    "clientid": "device-001",
    "rules": [
      {
        "action": "publish",
        "topic": "devices/device-001/data",
        "permission": "allow"
      },
      {
        "action": "subscribe",
        "topic": "devices/device-001/cmd",
        "permission": "allow"
      }
    ]
  }'
```

**查询指定客户端的 ACL 规则：**

```bash
curl -X GET "http://emqx-host:18083/api/v5/authorization/sources/built_in_database/rules/clients/device-001" \
  -u "admin:your_password"
```

**删除指定客户端的 ACL 规则：**

```bash
curl -X DELETE "http://emqx-host:18083/api/v5/authorization/sources/built_in_database/rules/clients/device-001" \
  -u "admin:your_password"
```

**批量导入 ACL 规则（从 JSON 文件）：**

```bash
# rules.json 格式参考 EMQX 文档，内容为规则数组
curl -X POST "http://emqx-host:18083/api/v5/authorization/sources/built_in_database/rules/clients" \
  -H "Content-Type: application/json" \
  -u "admin:your_password" \
  -d @rules.json
```

---

## 九、零信任在 IoT 中的应用

### 核心原则：永不信任，始终验证

传统网络安全依赖"边界防护"：防火墙隔离外部，内网默认可信。这一模型在 IoT 场景中彻底失效——设备分布在工厂、户外、用户家中，根本没有统一的"内网边界"。

**零信任的核心理念**：无论连接来自内网还是外网，无论设备是否曾经认证过，每次访问请求都必须重新验证身份和权限。

| 对比维度 | 传统边界安全 | 零信任安全 |
|---------|------------|----------|
| 信任模型 | 内网默认可信，外网不可信 | 所有网络默认不可信 |
| 认证时机 | 一次登录后长期信任 | 每次请求持续验证 |
| 横向移动风险 | 一台设备被攻破可横向扩散 | 每台设备独立隔离，限制扩散范围 |
| 适合场景 | 集中式办公内网 | 分布式 IoT / 云原生 / 远程办公 |

### IoT 零信任关键措施

**1. 设备身份：每台设备唯一证书/密钥，禁止共享凭证**

```yaml
# 错误做法：所有同型号设备共用同一套凭证（一旦泄露全线沦陷）
device_id: "device-type-A"
username: "shared_user"
password: "shared_password"

# 正确做法：每台设备独立的 X.509 证书或唯一 DeviceSecret
device_id: "device-001"          # 全局唯一
cert_file: "/certs/device-001.pem"
key_file:  "/certs/device-001.key"
```

**2. 最小权限：设备只能访问自己的 Topic，服务间通信最小化授权**

```
# ACL 规则示例（EMQX）
device-001 → 仅允许 publish: devices/device-001/data
device-001 → 仅允许 subscribe: devices/device-001/cmd
device-001 → 禁止访问: devices/device-002/#（其他设备 Topic）
```

**3. 持续验证：连接建立后定期重新验证（Token 刷新）**

```java
// 设备端伪代码：定期刷新连接 Token
@Scheduled(fixedDelay = 3600_000) // 每小时刷新
public void refreshDeviceToken() {
    String newToken = authService.refreshToken(deviceId, currentToken);
    mqttClient.disconnect();
    mqttClient.reconnectWithToken(newToken);
    log.info("设备 {} Token 刷新完成", deviceId);
}
```

**4. 微隔离：不同区域设备网络隔离，内网设备不直接暴露到公网**

```
                 ┌─────────────────────┐
  工厂车间 A      │ 设备网段 192.168.1.0/24 │  ──►  Edge Gateway A  ──►  EMQX Cluster
                 └─────────────────────┘         （仅开放 8883 端口，双向 TLS）
                 ┌─────────────────────┐
  工厂车间 B      │ 设备网段 192.168.2.0/24 │  ──►  Edge Gateway B  ──►  EMQX Cluster
                 └─────────────────────┘         （车间 A 与 B 网络完全隔离）
```

- 车间 A 的设备无法直接访问车间 B 的设备
- Edge Gateway 作为区域出口，统一管理本区域设备的认证和流量
- EMQX Cluster 不直接暴露在公网，通过负载均衡/API Gateway 对外提供服务

**5. 可观测：所有连接、断开、认证事件记录审计日志**

EMQX 支持将认证和连接事件写入日志，或通过 Webhook/规则引擎转发到外部审计系统：

```yaml
# emqx.conf：开启审计日志
log.audit {
  enable = true
  path   = "/var/log/emqx/audit.log"
  level  = info
}
```

关键审计事件清单：

| 事件 | 说明 |
|------|------|
| `client.connected` | 设备连接成功，记录 IP、Client ID、时间戳 |
| `client.disconnected` | 设备断开，记录原因（主动/异常/认证失败） |
| `client.auth.failed` | 认证失败，记录失败原因和来源 IP（用于检测暴力破解） |
| `acl.deny` | ACL 拒绝的操作，记录 Topic 和操作类型（用于检测越权尝试） |

### 零信任实施路线建议

```
阶段一（基础）：启用 TLS + 禁用匿名连接 + 每台设备独立凭证
    ↓
阶段二（权限）：部署 ACL 规则，限制设备只能访问自己的 Topic
    ↓
阶段三（隔离）：网络微分段，不同区域设备走独立网关
    ↓
阶段四（持续验证）：Token 定期刷新机制 + 证书轮换 OTA
    ↓
阶段五（可观测）：审计日志接入 SIEM，异常行为实时告警
```
