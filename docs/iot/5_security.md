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

```
设备 ──── TLS 加密 ────► MQTT Broker（EMQX）
          ↑
    服务端证书验证
    （可选：客户端证书双向认证）
```

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

> [!warning]
> 待补充：X.509 证书生成与设备烧录流程、EMQX ACL 规则详细配置、零信任在 IoT 中的应用
