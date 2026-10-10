---
description: 边缘请求链路、代理模式、缓存规则、WAF 与限流、Workers、R2、Tunnel、Pages、与国内云配合
---

# Cloudflare 边缘服务

> **本篇目标**：理解 Cloudflare 作为流量入口层的工作方式，能正确配置代理模式、缓存规则、WAF 与限流，会用 Workers、R2、Tunnel、Pages 解决常见问题，并清楚它在中国大陆的访问限制与源站保护做法。
>
> **前置阅读**：[国内云平台](./14_cloud_domestic)、[国际云平台](./15_cloud_global)、[DNS](/protocols/4_dns)、[HTTP](/protocols/2_http)

Cloudflare 不卖虚拟机，它是一张覆盖全球数百个城市的边缘网络：把域名的 DNS 交给它并开启代理后，用户请求先到最近的边缘节点，经过防护、规则与缓存处理，必要时才回到源站。因此它通常**叠加在云厂商或 VPS 之上**，作为入口层使用，也可以用 Workers、R2、Pages 独立承载轻量应用。

---

## 一、边缘请求链路

![请求经过 Cloudflare 边缘节点的处理顺序](../assets/cloud-native/cloudflare-edge.svg)

- **DNS 解析**：开启代理的记录返回 Cloudflare 的 Anycast IP，用户被路由到网络上最近的节点，源站 IP 不出现在解析结果中
- **DDoS 防护**：所有套餐默认开启、不计量，覆盖网络层与应用层攻击
- **WAF / 限流**：按托管规则和自定义规则匹配请求，执行拦截、质询或跳过
- **Workers**：如果路由上绑定了 Worker，它在缓存之前运行，可以改写请求、直接响应或决定如何回源
- **缓存**：命中直接返回；未命中或不可缓存的动态请求才回源站

DDoS、WAF 等攻击与防护的概念见 [常见漏洞与防护](/security/8_vulnerabilities) 与 [API 安全](/security/6_api_security)，这里只讲 Cloudflare 上怎么配置。

---

## 二、DNS 与代理模式

Cloudflare 作为**权威 DNS** 免费可用，接入方式是把域名注册商处的 NS 改为 Cloudflare 分配的两个名称服务器。它另外提供的 `1.1.1.1` 是**公共递归解析**服务，供终端用户使用，与托管域名是两回事；二者的区别见 [DNS](/protocols/4_dns)。

每条 A / AAAA / CNAME 记录都有代理状态：

| 模式 | 解析结果 | 效果 |
|------|---------|------|
| 已代理（Proxied，橙色云朵） | Cloudflare 的 Anycast IP | HTTP / HTTPS 流量经过边缘节点，获得缓存、WAF、DDoS 防护，源站 IP 被隐藏 |
| 仅 DNS（DNS only，灰色云朵） | 源站真实 IP | 只做解析，流量直连源站，源站 IP 暴露 |

- 代理只对 HTTP / HTTPS 生效，而且只转发少数标准与备用端口；SSH、数据库、MQTT 等非 HTTP 服务要用仅 DNS 记录，或改走 Tunnel
- MX、TXT 等记录类型始终是仅 DNS
- 同一台服务器的其他域名若是仅 DNS，会把源站 IP 暴露出去，隐藏源站要所有指向它的记录都开代理

---

## 三、CDN 与缓存规则

默认情况下，Cloudflare 只缓存按扩展名识别的静态文件（JS、CSS、图片、字体等），**HTML 和 API 响应默认不缓存**，同时遵循源站的 `Cache-Control`。需要调整时使用 **Cache Rules**：

| 场景 | 匹配表达式 | 设置 |
|------|-----------|------|
| 带指纹的静态资源长缓存 | `http.request.uri.path.extension in {"js" "css" "png" "woff2"}` | Eligible for cache；Edge TTL 选 Ignore cache-control header and use this TTL，设较长时间 |
| API 一律不缓存 | `starts_with(http.request.uri.path, "/api/")` | Bypass cache |

- 旧的 Page Rules 已被拆分为 Cache Rules、Configuration Rules、Redirect Rules、Origin Rules 等专项规则，新配置不要再用 Page Rules 的「Cache Level: Cache Everything」写法
- 静态资源文件名带内容哈希（前端构建工具默认如此），就可以放心设长 TTL，发布新版本时文件名变化，不需要清缓存
- 支持 HTTP/2、HTTP/3（QUIC）与 Brotli 压缩；图片优化 Polish 需要 Pro 及以上套餐

::: warning 中国大陆访问
Cloudflare 在中国大陆的节点（China Network，由京东云运营）只对企业版单独开通，且要求域名完成 ICP 备案。免费版和 Pro 用户的大陆访客由境外节点服务，延迟和稳定性都不如国内 CDN。面向大陆用户的业务应以国内 CDN 为主，Cloudflare 更适合海外用户或作为海外分流。
:::

---

## 四、WAF、DDoS 与限流

| 能力 | 免费版 | 付费套餐 |
|------|--------|----------|
| DDoS 防护 | 默认开启，不计量 | 同左，可调整托管规则的敏感度与动作 |
| 托管规则 | 默认部署 Free Managed Ruleset，覆盖高危、广泛利用的漏洞 | Pro 起可用完整的 Cloudflare Managed Ruleset 与 OWASP Core Ruleset |
| 自定义规则（WAF custom rules） | 少量规则，不支持正则 | 规则数随套餐增加，Business 起支持正则 |
| 限流规则 | 仅基础规则：按 IP 计数，计数周期与封禁时长固定 | 更多规则与计数维度；按 Header、Cookie、ASN 等计数的高级限流为企业版 |
| Bot 防护 | Bot Fight Mode | Super Bot Fight Mode / Bot Management |

原来的 Firewall Rules 已迁移为 **WAF 自定义规则**。规则由表达式和动作组成，动作有 Block、Managed Challenge、JS Challenge、Skip 等。常见场景：

| 场景 | 表达式 | 动作 |
|------|--------|------|
| 封禁特定国家 / 地区 | `(ip.src.country in {"KP" "RU"})` | Block |
| 管理后台只允许办公网 | `(starts_with(http.request.uri.path, "/admin") and not ip.src in {203.0.113.10 198.51.100.0/24})` | Block |
| 拦截扫描工具 | `(http.user_agent contains "sqlmap")` | Block |
| 可疑地区访问登录页先质询 | `(http.request.uri.path eq "/login" and ip.src.country ne "CN")` | Managed Challenge |

- 国家字段用 `ip.src.country`，旧的 `ip.geoip.country` 已废弃
- 免费版的那条限流规则最适合保护登录、短信验证码这类接口：表达式匹配路径，按 IP 计数，超阈值后封禁一段时间
- 边缘限流挡的是粗粒度的流量，按用户、按接口的精细限流仍要在应用侧做，见 [限流与过载保护](/high-avail/7_rate_limiting)

---

## 五、Workers（边缘 Serverless）

Workers 把代码部署到每个边缘节点上运行。它基于 V8 isolate 而不是容器，一个进程里同时运行大量隔离的脚本，启动开销在毫秒以内，加上 Cloudflare 会在 TLS 握手阶段提前加载脚本，冷启动几乎感知不到。支持 JavaScript / TypeScript、Python，以及编译成 WebAssembly 的 Rust 等语言。

| 场景 | 说明 |
|------|------|
| 鉴权前置 | 在边缘校验 Token，非法请求不回源 |
| 请求路由 | 按路径、地区、Header 分发到不同源站，或做灰度 |
| 响应改写 | 注入安全 Header、改写 HTML |
| 轻量 API | 配合 KV、D1（SQLite）、Durable Objects 实现完整的小型后端 |
| 静态站点 | Workers 静态资源托管，见第八节 |

一个在边缘拦截无 `Authorization` 头的 API 请求、其余请求原样回源的 Worker：

```js
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/") && !request.headers.has("Authorization")) {
      return new Response("Unauthorized", { status: 401 });
    }
    return fetch(request);
  },
};
```

```bash
npm create cloudflare@latest -- my-worker   # 用模板创建项目
cd my-worker
npx wrangler dev                             # 本地运行
npx wrangler deploy                          # 部署到边缘
```

计费方面，免费版有每日请求额度和单请求 CPU 时间上限，适合个人项目与低流量场景；付费版按月最低消费包含一定请求量与 CPU 时间，超出部分按量计费。具体额度以官方定价页为准。

---

## 六、R2 对象存储

R2 是兼容 S3 API 的对象存储，最大特点是**不收取出口流量费**，只按存储量和操作次数计费（写类为 Class A，读类为 Class B）。图片、附件、安装包这类下载量大的场景，与按流量收费的对象存储相比成本差异明显。存储桶可以直接绑定自定义域名，经由 Cloudflare 缓存对外提供访问。

对象存储的通用概念、预签名直传与工程实践见 [对象存储](/architecture/4_object_storage)，下面只列接入 R2 时与标准 S3 不同的配置。

### Java 接入（AWS SDK for Java v2）

```java
import java.net.URI;
import software.amazon.awssdk.auth.credentials.AwsBasicCredentials;
import software.amazon.awssdk.auth.credentials.StaticCredentialsProvider;
import software.amazon.awssdk.regions.Region;
import software.amazon.awssdk.services.s3.S3Client;
import software.amazon.awssdk.services.s3.S3Configuration;

public final class R2ClientFactory {

    public static S3Client create(String accountId, String accessKeyId, String secretAccessKey) {
        return S3Client.builder()
                .endpointOverride(URI.create("https://" + accountId + ".r2.cloudflarestorage.com"))
                .region(Region.of("auto"))                      // SDK 要求填写，R2 不使用
                .credentialsProvider(StaticCredentialsProvider.create(
                        AwsBasicCredentials.create(accessKeyId, secretAccessKey)))
                .serviceConfiguration(S3Configuration.builder()
                        .pathStyleAccessEnabled(true)
                        .chunkedEncodingEnabled(false)          // 否则 putObject 返回 403 签名不匹配
                        .build())
                .build();
    }
}
```

- `chunkedEncodingEnabled(false)` 是 R2 官方示例要求的配置：SDK 默认对 `putObject` 使用分块编码签名，R2 不接受，会报 `SignatureDoesNotMatch`
- 预签名用的 `S3Presigner` 同样设置 endpoint、`Region.of("auto")` 与 `pathStyleAccessEnabled(true)`
- 较新版本的 SDK 默认为每个请求计算并校验校验和，若遇到与 checksum 相关的报错，可在 builder 上加 `.requestChecksumCalculation(RequestChecksumCalculation.WHEN_REQUIRED)` 与 `.responseChecksumValidation(ResponseChecksumValidation.WHEN_REQUIRED)`（位于 `software.amazon.awssdk.core.checksums` 包）
- Access Key 在 R2 控制台按存储桶授权创建，通过环境变量或密钥管理注入，不要写进代码仓库

---

## 七、Tunnel

Cloudflare Tunnel 让内网服务在**没有公网 IP、不开放任何入站端口**的情况下对外提供访问：内网运行的 `cloudflared` 主动向 Cloudflare 边缘建立出站连接，用户访问域名时，请求沿这条连接反向送达。

![Cloudflare Tunnel：由内网主动向外建立连接](../assets/cloud-native/cloudflare-tunnel.svg)

常见用途：本地开发时接收 Webhook / 支付回调、无公网 IP 的家庭服务器或 NAS 对外服务、源站完全不暴露公网端口。

### 1、临时隧道（Quick Tunnel）

```bash
cloudflared tunnel --url http://localhost:8080
```

这条命令不需要登录，会分配一个随机的 `*.trycloudflare.com` 地址，进程退出即失效，只适合临时测试，不能绑定自己的域名。

### 2、命名隧道（绑定自己的域名）

前提是域名已托管在 Cloudflare。

```bash
cloudflared tunnel login                                   # 浏览器授权，生成证书 cert.pem
cloudflared tunnel create my-tunnel                        # 创建隧道，生成 <Tunnel-UUID>.json 凭据
cloudflared tunnel route dns my-tunnel app.example.com     # 创建指向 <Tunnel-UUID>.cfargotunnel.com 的 CNAME
```

在 `~/.cloudflared/config.yml` 中写入口规则：

```yaml
tunnel: <Tunnel-UUID>
credentials-file: /home/<user>/.cloudflared/<Tunnel-UUID>.json

ingress:
  - hostname: app.example.com
    service: http://localhost:8080
  - service: http_status:404     # 必须以兜底规则结尾
```

```bash
cloudflared tunnel ingress validate    # 校验配置
cloudflared tunnel run my-tunnel       # 启动隧道
```

服务器上长期运行时，也可以在 Zero Trust 控制台创建远程管理的隧道，按页面给出的命令执行 `sudo cloudflared service install <TOKEN>` 安装为系统服务，入口规则在控制台维护。

::: tip 内网后台的访问控制
Tunnel 只解决「连得进来」，不解决「谁能进来」。管理后台、内部工具对外暴露时，应在前面加 Cloudflare Access，按身份提供商登录与设备状态做访问控制，这正是零信任「不信任网络位置、每次访问都验证身份」的思路，见 [零信任架构](/security/9_zero_trust)。
:::

---

## 八、Pages 与 Workers 静态资源

Pages 是 Cloudflare 的静态站托管：绑定 Git 仓库，push 后自动构建部署，每个分支和 PR 生成预览地址，自定义域名自动签发证书。VuePress、Vite、Next.js 静态导出等都可以直接部署，构建命令与输出目录按项目填写。

Cloudflare 现在把新功能都放在 Workers 上，Workers 也能托管静态资源（配合 `wrangler.jsonc` 中的 `assets` 配置），并额外支持 Durable Objects、Cron Triggers、渐进式发布等。官方提供 Pages 与 Workers 的功能对照和迁移指南：Pages 继续可用，新项目可以直接从 Workers 开始。

与 GitHub Pages 一样，免费版的 Pages / Workers 在大陆没有节点，国内访问速度取决于境外线路，不应作为面向大陆用户的主站方案。

---

## 九、与国内云配合

![Cloudflare 叠加在国内云之前](../assets/cloud-native/cloudflare-domestic-arch.svg)

这种架构适合**用户主要在海外、或海内外都有**而源站在国内云的场景。如果用户主要在大陆，按第三节的说明，应优先使用国内 CDN + 国内云的 WAF。

配置要点：

- **加密模式用 Full (strict)**：Cloudflare 到源站也走 HTTPS 并校验源站证书。源站证书可以用公网 CA 签发的证书，或 Cloudflare 免费签发的 Origin CA 证书（只被 Cloudflare 信任）。不要用 Flexible，它让回源走明文 HTTP，源站再强制跳转 HTTPS 时还会造成重定向循环。证书与握手原理见 [HTTPS 与 TLS](/protocols/3_https_tls)
- **源站只接受 Cloudflare 的流量**，由弱到强有三种做法：
  - 安全组只放行 Cloudflare 公布的回源 IP 段：最简单，但其他 Cloudflare 用户的流量理论上也来自这些 IP
  - 开启 Authenticated Origin Pulls：Cloudflare 回源时出示客户端证书，源站（Nginx / 负载均衡）做 mTLS 校验，只认 Cloudflare 的证书，mTLS 见 [HTTPS 与 TLS](/protocols/3_https_tls)
  - 改用 Tunnel：源站不开放任何入站端口，从根本上不暴露
- **获取真实客户端 IP**：经过代理后，应用看到的对端地址是 Cloudflare 节点，真实 IP 在请求头 `CF-Connecting-IP`（同时会追加到 `X-Forwarded-For`）；只有在源站已限制为仅接受 Cloudflare 流量时，这个头才可信

---

## 十、免费版能力边界

| 能力 | 免费版 | 需要付费的部分 |
|------|--------|---------------|
| DNS、CDN | 可用，CDN 不按流量计费 | 更细的缓存控制、图片优化 Polish（Pro 起） |
| DDoS 防护 | 默认开启，不计量 | — |
| WAF | Free Managed Ruleset + 少量自定义规则 | 完整托管规则集、OWASP 规则集、正则表达式 |
| 限流 | 一条基础规则 | 更多规则；高级限流为企业版 |
| Workers | 每日有请求额度 | 更高额度与 CPU 时间，超出按量 |
| R2 | 有小额免费存储与操作次数，出口流量免费 | 超出免费额度的存储与操作 |
| Tunnel | 可用 | Access 超出免费用户数后收费 |
| Pages | 可用，每月构建次数有限 | 更多并发构建 |
| 中国大陆节点 | 无 | 企业版单独订阅，且需要 ICP 备案 |

各项具体额度以 Cloudflare 官方的套餐与定价页为准。

::: warning 待补充
Cloudflare Access 配置实战、限流规则保护登录接口的完整示例。
:::

---

## 小结

- Cloudflare 是入口层而非 IaaS：开启代理的 DNS 记录让流量先经过边缘节点，依次经过 DDoS 防护、WAF / 限流、Workers 与缓存，未命中才回源
- 代理只对 HTTP / HTTPS 生效，非 HTTP 服务用仅 DNS 或 Tunnel；隐藏源站要求所有指向它的记录都开代理
- 缓存用 Cache Rules 配置，HTML 与 API 默认不缓存；Page Rules 与 `ip.geoip.country` 都是旧写法
- 免费版也有托管规则、少量自定义规则和一条基础限流规则；完整的 OWASP 规则集需要付费
- R2 不收出口流量费，Java 接入要设置 `pathStyleAccessEnabled(true)` 与 `chunkedEncodingEnabled(false)`
- Tunnel 的 `--url` 一行命令只是临时隧道，绑定自己的域名要用命名隧道或控制台托管隧道，对外暴露后台时配合 Access
- 免费版在大陆没有节点；源站在国内云时，用 Full (strict) 加 IP 白名单、Authenticated Origin Pulls 或 Tunnel 保护源站

## 参考资料

- [Cloudflare 网络与节点分布](https://www.cloudflare.com/network/)
- [代理状态：Proxied 与 DNS only](https://developers.cloudflare.com/dns/proxy-status/)
- [Cache Rules](https://developers.cloudflare.com/cache/how-to/cache-rules/)
- [WAF 托管规则](https://developers.cloudflare.com/waf/managed-rules/)
- [WAF 自定义规则](https://developers.cloudflare.com/waf/custom-rules/)
- [限流规则](https://developers.cloudflare.com/waf/rate-limiting-rules/)
- [规则语言字段 ip.src.country](https://developers.cloudflare.com/ruleset-engine/rules-language/fields/reference/ip.src.country/)
- [Cloudflare Workers 文档](https://developers.cloudflare.com/workers/)
- [Workers 与 Pages 功能对照](https://developers.cloudflare.com/workers/static-assets/compatibility-matrix/)
- [R2：AWS SDK for Java 接入示例](https://developers.cloudflare.com/r2/examples/aws/aws-sdk-java/)
- [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/)
- [SSL/TLS 加密模式](https://developers.cloudflare.com/ssl/origin-configuration/ssl-modes/)
- [Authenticated Origin Pulls](https://developers.cloudflare.com/ssl/origin-configuration/authenticated-origin-pull/)
- [Cloudflare 回源 IP 段](https://www.cloudflare.com/ips/)
- [China Network](https://developers.cloudflare.com/china-network/)

> 下一篇：[VPS 选购](./17_vps_intro)
