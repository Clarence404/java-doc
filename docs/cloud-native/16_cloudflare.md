# Cloudflare

> Cloudflare 是全球最大的边缘网络平台之一，提供 CDN、DNS、WAF、DDoS 防护、边缘计算等服务。
> 定位不同于传统 IaaS 云厂商——它不提供虚拟机，而是作为**流量入口层**叠加在云厂商之上，也可独立使用。

官网：[https://www.cloudflare.com](https://www.cloudflare.com)

---

## 一、核心产品全景

```
用户请求
    ↓
Cloudflare 边缘节点（全球 300+ PoP）
    ├── DNS 解析
    ├── DDoS 防护 / WAF
    ├── CDN 缓存
    ├── Workers（边缘函数处理）
    └── 回源到云厂商（AWS / 阿里云 等）
```

---

## 二、DNS

Cloudflare DNS 是最常见的入门功能，也是其他服务的基础。

### 1、特点

- 全球解析速度最快之一（1.1.1.1 公共 DNS）
- 免费套餐即可使用，无需付费
- 支持橙云代理（流量过 Cloudflare 节点）和灰云直连（仅 DNS，不走 CDN）

### 2、橙云 vs 灰云

| 模式 | 图标 | 效果 |
|------|------|------|
| 橙云（Proxied）| 🟠 | 流量经 Cloudflare，自动获得 CDN + WAF + DDoS 防护，隐藏源站 IP |
| 灰云（DNS Only）| ⚫ | 仅做 DNS 解析，流量直连源站，源站 IP 暴露 |

> 生产环境建议关键域名开橙云，保护源站 IP 不被直接攻击。

---

## 三、CDN

- 全球 300+ 边缘节点，静态资源自动缓存
- 支持自定义缓存规则（Page Rules / Cache Rules）
- 支持图片压缩（Polish）、HTTP/2、HTTP/3 / QUIC
- 国内访问速度一般（Cloudflare 在中国大陆无节点），通常配合国内 CDN 分流

### 常用缓存规则示例

| 场景 | 配置 |
|------|------|
| 静态资源长缓存 | `*.js` / `*.css` / `*.png` → Cache Level: Cache Everything，Edge TTL: 1 month |
| API 接口不缓存 | `/api/*` → Cache Level: Bypass |
| HTML 不缓存 | `*.html` → Cache Level: Bypass |

---

## 四、WAF / DDoS 防护

| 功能 | 免费版 | Pro 及以上 |
|------|--------|-----------|
| DDoS 防护 | ✅ 无限（L3/L4/L7） | ✅ 同上 + 更细粒度规则 |
| 托管 WAF 规则 | ❌ | ✅ OWASP 规则集 |
| 自定义防火墙规则 | ✅ 5 条 | ✅ 更多 |
| Bot 管理 | 基础 | 高级 |
| Rate Limiting | 付费功能 | ✅ |

### 自定义防火墙规则常用场景

```
# 封禁特定国家/地区
(ip.geoip.country in {"CN" "RU"}) → Block

# 只允许特定 IP 访问管理后台
(http.request.uri.path contains "/admin") and not (ip.src in {1.2.3.4}) → Block

# 拦截常见扫描 UA
(http.user_agent contains "sqlmap") → Block
```

---

## 五、Workers（边缘 Serverless）

Cloudflare Workers 是运行在边缘节点的 Serverless 函数，使用 JavaScript / TypeScript / WASM，延迟极低（无冷启动）。

### 典型使用场景

| 场景 | 说明 |
|------|------|
| A/B 测试 | 在边缘修改响应，无需改源站 |
| 请求路由 | 按路径/地区分发到不同源站 |
| 鉴权前置 | 边缘验证 JWT，合法才回源 |
| 响应改写 | 注入 Header、修改 HTML |
| 静态站点 | 配合 Pages 托管前端项目 |

### 免费额度

- 每日 10 万次请求
- CPU 时间 10ms / 请求
- 付费版 $5/月，无限请求

---

## 六、R2 对象存储

R2 是 Cloudflare 推出的 S3 兼容对象存储，最大优势是**出站流量免费**。

| 对比项 | R2 | AWS S3 |
|-------|-----|--------|
| 存储费 | $0.015/GB·月 | $0.023/GB·月 |
| 出站流量费 | **免费** | $0.09/GB |
| API 调用 | A类免费 100 万次/月 | 按次计费 |
| S3 兼容 | ✅ 兼容 S3 SDK | - |
| 自定义域名 | ✅ | 需配合 CloudFront |

> 大流量文件下载场景（图片、视频、附件）用 R2 比 S3 便宜很多。

### Java 接入 R2（兼容 S3 SDK）

```java
// R2 兼容 AWS S3 SDK，只需修改 endpoint
S3Client s3 = S3Client.builder()
    .endpointOverride(URI.create("https://<ACCOUNT_ID>.r2.cloudflarestorage.com"))
    .credentialsProvider(StaticCredentialsProvider.create(
        AwsBasicCredentials.create(ACCESS_KEY, SECRET_KEY)))
    .region(Region.of("auto"))
    .build();
```

---

## 七、Tunnel（内网穿透）

Cloudflare Tunnel 可以将本地或内网服务暴露到公网，**无需公网 IP，无需开放防火墙端口**，替代 frp / ngrok。

### 工作原理

```
本地服务（localhost:8080）
    ↓
cloudflared 客户端（出站连接）
    ↓
Cloudflare 边缘节点
    ↓
公网域名访问（https://app.yourdomain.com）
```

### 常用场景

- 本地开发环境临时对外暴露（微信回调、Webhook 测试）
- 家庭服务器 / NAS 无公网 IP 时对外提供服务
- 内网管理后台通过 Zero Trust Access 安全暴露

### 快速启动

```bash
# 安装 cloudflared
# https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/

# 登录
cloudflared tunnel login

# 创建 tunnel
cloudflared tunnel create my-tunnel

# 运行（将本地 8080 映射到域名）
cloudflared tunnel --url http://localhost:8080
```

---

## 八、Pages（静态站托管）

- 免费托管静态网站（Vue / React / VuePress 等）
- 绑定 Git 仓库，push 即自动部署
- 全球 CDN 加速，自定义域名 + 免费 SSL
- 免费版无限带宽

> 本文档站（VuePress）可直接部署到 Cloudflare Pages，替代 GitHub Pages，国内访问速度更优。

---

## 九、与国内云配合的常见架构

```
用户
 ↓
Cloudflare（DNS + CDN + WAF + DDoS 防护）
 ↓
阿里云 SLB / 腾讯云 CLB（负载均衡）
 ↓
ECS / K8s 集群（Spring Boot 应用）
 ↓
RDS + Redis + OSS
```

**优势**：
- 阿里云/腾讯云只开 Cloudflare 回源 IP 段，源站 IP 完全隐藏
- Cloudflare 免费 WAF + DDoS 叠加国内云安全组，双重防护
- 静态资源走 Cloudflare CDN，动态请求回源，节省国内流量费

---

## 十、免费套餐总结

| 功能 | 免费额度 |
|------|---------|
| DNS | 无限 |
| CDN | 无限带宽 |
| DDoS 防护 | 无限（L3/L4/L7） |
| 自定义防火墙规则 | 5 条 |
| Workers | 10 万次请求/天 |
| Pages | 无限带宽，500 次构建/月 |
| R2 存储 | 10 GB/月，A类 100 万次操作/月 |
| Tunnel | 免费 |

> [!warning] 待补充：Zero Trust Access 配置、Rate Limiting 实战
