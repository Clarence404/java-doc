---
description: MQTT Broker 对比、EMQX 5.9 起的 BSL 许可、版本与镜像选择、单节点部署、三节点集群与四层负载均衡
---

# EMQX 许可与部署

> 前置阅读：[通信协议](./1_protocol)、[平台选型](./2_platform)

自建 IoT 平台的接入层大多选 EMQX，它从 5.9 起改用 BSL 1.1 许可，能不能组集群要先看许可。本篇讲 Broker 对比、许可变化、单节点部署、集群的取舍与三节点集群，基线为 EMQX 5.9+ / 6.x。

---

## 一、Broker 对比

自建接入层常见的 MQTT Broker 有下面五个，差别主要在许可和能不能组集群：

| Broker | 语言 | 许可 | 特点 |
|--------|------|------|------|
| **EMQX** | Erlang | 5.9 起为 BSL 1.1（单节点生产免费，集群需 License），5.8 及以前的开源版为 Apache 2.0（已停止维护） | 功能全（规则引擎、数据集成、多协议网关），性能高 |
| Mosquitto | C | EPL 2.0 / EDL 1.0 | 轻量、单机，适合开发测试和小规模部署 |
| NanoMQ | C | MIT | 面向边缘网关的轻量 Broker，可桥接到云端 Broker |
| VerneMQ | Erlang | 源码 Apache 2.0，官方二进制包与镜像商用需订阅 | 原生分布式集群 |
| HiveMQ | Java | 社区版 Apache 2.0，企业版商业许可 | 企业版集群与运维能力强 |

按场景怎么选见 [平台选型 · 选型建议](./2_platform#四、选型建议)：单节点够用时选 EMQX 单节点或 Mosquitto；需要集群又不打算采购 License 时，从源码构建 VerneMQ，EMQX 5.8 开源版已停止维护、只适合内网或过渡期；边缘网关上用 NanoMQ。本篇后面只讲 EMQX。

---

## 二、许可变化

EMQX 从 **5.9.0** 起把开源版和企业版合并为一个版本，统一采用 **BSL 1.1**（Business Source License，源码可见但不是 OSI 意义上的开源）：

- **单节点生产使用免费**，不限连接规模，但不能把 EMQX 作为托管服务对外提供，也不能嵌入到销售给第三方的产品中
- **多节点集群需要商业 License**（或使用 EMQX Cloud）；没有 License 时只能以单节点运行
- 开发、测试等非生产用途免费；经认证的教育机构和非营利组织在非商业用途下不限节点数
- 每个版本在发布 4 年后自动转为 Apache 2.0
- 5.8.x 及以前的开源版仍然是 Apache 2.0，企业版从 5.0 起就是 BSL 1.1

合并也带来一个好处：5.9 之前，Kafka 等数据集成只有企业版才有，现在单节点就能用，用法见 [遥测数据链路](../3_platform/2_data)。

**5.8 开源版的维护状态**：许可没变，但 EMQ 在 2025 年 8 月公告，5.8 开源版于 2026 年 2 月 28 日结束生命周期，此后不再提供缺陷修复和安全补丁，Docker Hub 上 `emqx/emqx` 的最后一个 5.8 标签是 5.8.9。所以「停在 5.8 开源版免费组集群」现在意味着运行一个没有安全更新的 Broker，只适合不暴露公网的内网环境或迁移前的过渡期。仍在维护的 5.8 是企业版的 LTS（到 2027 年 8 月），它适用 BSL。

**版本怎么选**：5.9、5.10 是功能版本，各维护 18 个月，5.9 已在 2026 年 11 月到期，5.10 到 2026 年 12 月到期；6.3 是当前的 LTS（2026 年 9 月发布，维护 3 年）。新部署直接用 6.3，并把镜像固定到具体的补丁版本。

**镜像用哪个**：5.9 合并之后，官方安装文档的示例统一写 `emqx/emqx-enterprise`。这里的 enterprise 只是沿用下来的镜像名，不代表要付费，单节点不填 License 就能运行。Docker Hub 上的 `emqx/emqx` 仍在同步发布相同版本号的标签，存量部署不必急着改名，新部署跟着官方文档用 `emqx/emqx-enterprise`。Docker 官方库中不带命名空间的 `emqx` 镜像不再跟进新版本。

License 可在 Dashboard「System → License」中更新，也可以执行 `emqx ctl license update <License Key>`。

---

## 三、单节点部署

```yaml
# docker-compose.yml
services:
  emqx:
    image: emqx/emqx-enterprise:6.3.3   # 镜像名里的 enterprise 不代表收费，见第二节
    container_name: emqx
    hostname: node1.emqx.local
    environment:
      # 节点名的 host 部分需要是 IP 或 FQDN，重建容器后保持不变，数据目录才能复用
      - EMQX_NODE_NAME=emqx@node1.emqx.local
    ports:
      - "1883:1883"     # MQTT TCP
      - "8083:8083"     # MQTT over WebSocket
      - "8084:8084"     # MQTT over WSS
      - "8883:8883"     # MQTT over TLS
      - "18083:18083"   # Dashboard
    ulimits:
      nofile:           # Docker 默认软限制 1024，每条 MQTT 连接占一个文件描述符
        soft: 1048576
        hard: 1048576
    volumes:
      - emqx-data:/opt/emqx/data
      - emqx-log:/opt/emqx/log

volumes:
  emqx-data:
  emqx-log:
```

```bash
docker compose up -d
docker exec -it emqx emqx ctl status
```

Dashboard 地址是 `http://<主机>:18083`，首次登录后必须修改默认密码。生产环境只对外开放 8883（TLS），1883 和 18083 限制在内网，证书配置见 [HTTPS 与 TLS](/protocols/3_https_tls)，设备认证与 ACL 见 [设备安全](../2_access/1_security)。

许可不限连接规模，不等于默认配置就接得住：去掉上面的 `ulimits.nofile`，配套仓库 Conduit 实测约 1,000 台设备就让 EMQX 因打开文件数超限反复崩溃，见 [部署与可观测 · 几处有来历的编排细节](../4_practice/11_deploy#五、几处有来历的编排细节)，排查过程在 [压测与瓶颈排查](../4_practice/10_capacity)；离线消息队列、在途窗口这些会话参数怎么取，见 [可靠上报与接入层主备 · EMQX 会话怎么选](../4_practice/3_reliable_uplink#五、emqx-会话怎么选)。

文件描述符只是第一道限制。连接数再往上，宿主机的内核参数、Broker 的监听器与限速、设备集中重连时的退避都要一起考虑，这些由 [海量连接与连接风暴](../2_access/7_connection_storm) 统一讲，本篇的样例只保留 `ulimits` 这一项。

---

## 四、何时需要集群

| 模式 | 适用场景 |
|------|---------|
| **单节点** | 开发测试；连接数在单机容量内、能接受分钟级故障恢复（容器自动拉起 + 设备自动重连） |
| **集群** | 需要节点故障时业务不中断、连接数超出单机容量、需要滚动升级 |

集群节点之间通过 Erlang 分布式协议同步路由表；客户端断线后重连到任意节点，只有使用持久会话（Clean Start 为 false 且 Session Expiry Interval 大于 0）时，订阅和离线消息才会随会话接管一起恢复，否则需要客户端重新订阅；能恢复多少离线消息还受会话队列上限约束，节点自身崩溃时内存会话里未投递的消息不保留，见 [可靠上报与接入层主备 · EMQX 会话怎么选](../4_practice/3_reliable_uplink#五、emqx-会话怎么选)。

---

## 五、三节点集群（需 License）

下面的配置演示集群拓扑。License 要在启动之前给每个节点都配好（官方文档的要求：5.9 及以后的节点加入集群前必须已经带着 License），这里用环境变量传入；只想验证拓扑时，把镜像换成 5.8 开源版的 `emqx/emqx:5.8.9`（Apache 2.0，已停止维护）并去掉 License 那一行，也能跑通同样的配置。

![EMQX 三节点集群与四层负载均衡](../../assets/iot/emqx-cluster.svg)

```yaml
# docker-compose.yml
x-emqx: &emqx
  image: emqx/emqx-enterprise:6.3.3
  ulimits:
    nofile: {soft: 1048576, hard: 1048576}   # 与单节点相同，见第三节

services:
  emqx1:
    <<: *emqx
    container_name: emqx1
    hostname: node1.emqx.local
    # Docker 内置 DNS 不解析 hostname，节点名要配成网络别名才能互相解析
    networks:
      emqx-net:
        aliases: [node1.emqx.local]
    environment: &emqx-env
      EMQX_NODE_NAME: emqx@node1.emqx.local
      # 三个节点都带 License（值放在 .env 里，不写进仓库）；节点启动时没有 License 就组不成集群
      EMQX_LICENSE__KEY: ${EMQX_LICENSE_KEY}
      EMQX_CLUSTER__DISCOVERY_STRATEGY: static
      EMQX_CLUSTER__STATIC__SEEDS: "[emqx@node1.emqx.local,emqx@node2.emqx.local,emqx@node3.emqx.local]"
      # 负载均衡器开启了 PROXY protocol，EMQX 监听器也要开启，才能拿到设备真实 IP
      EMQX_LISTENERS__TCP__DEFAULT__PROXY_PROTOCOL: "true"
    ports:
      - "18083:18083"   # 只暴露一个节点的 Dashboard
    volumes:
      - emqx1-data:/opt/emqx/data

  emqx2:
    <<: *emqx
    container_name: emqx2
    hostname: node2.emqx.local
    networks:
      emqx-net:
        aliases: [node2.emqx.local]
    environment:
      <<: *emqx-env
      EMQX_NODE_NAME: emqx@node2.emqx.local
    volumes:
      - emqx2-data:/opt/emqx/data

  emqx3:
    <<: *emqx
    container_name: emqx3
    hostname: node3.emqx.local
    networks:
      emqx-net:
        aliases: [node3.emqx.local]
    environment:
      <<: *emqx-env
      EMQX_NODE_NAME: emqx@node3.emqx.local
    volumes:
      - emqx3-data:/opt/emqx/data

  lb:
    image: nginx:stable-alpine   # 示例用浮动标签，生产环境和 EMQX 一样固定到具体版本
    container_name: mqtt-lb
    volumes:
      - ./nginx.conf:/etc/nginx/nginx.conf:ro
    ports:
      - "1883:1883"     # 设备只连负载均衡器，EMQX 节点不直接暴露 1883
    networks: [emqx-net]
    depends_on: [emqx1, emqx2, emqx3]

networks:
  emqx-net:
    driver: bridge

volumes:
  emqx1-data:
  emqx2-data:
  emqx3-data:
```

Nginx 用 `stream` 模块做四层转发（官方镜像已包含该模块）：

```nginx
# nginx.conf
events {}

stream {
    upstream emqx_cluster {
        least_conn;               # 按当前连接数最少分配，长连接场景比轮询更均衡
        server emqx1:1883;
        server emqx2:1883;
        server emqx3:1883;
    }

    server {
        listen 1883;
        proxy_pass emqx_cluster;
        proxy_protocol on;        # 把设备真实 IP 传给 EMQX
        proxy_connect_timeout 5s;
        proxy_timeout 300s;       # 要大于 1.5 倍 Keep Alive（和 Broker 判定超时的口径对齐），否则空闲设备会被 Nginx 断开
    }
}
```

`proxy_timeout` 是两次读写之间的最长空闲时间。设备 Keep Alive 设为 60 秒时，Broker 允许 90 秒无报文，这里设成 300 秒留足余量；如果设成 30 秒，所有空闲设备都会被周期性断开重连。TLS 可以在 Nginx 终结，也可以透传给 EMQX，需要做双向证书认证时一般透传，由 EMQX 校验客户端证书。

启动后查看集群状态：

```bash
docker compose up -d
docker exec -it emqx1 emqx ctl cluster status
# 正常时 running_nodes 包含三个节点，stopped_nodes 为空
```

生产环境的 EMQX 集群通常部署在 Kubernetes 上（EMQX Operator），节点发现改用 `k8s` 或 `dns` 策略。

---

## 小结

- 常见 Broker 里 EMQX 功能最全，Mosquitto 与 NanoMQ 轻量，VerneMQ 原生集群，HiveMQ 的集群能力在企业版
- EMQX 从 5.9 起统一为 BSL 1.1：单节点生产免费，集群需要 License，不能作为托管服务对外提供或嵌入产品销售；5.8 开源版仍是 Apache 2.0 但已在 2026 年 2 月停止维护，需要免费集群时换用其他 Broker 更稳妥
- 新部署用 6.3 LTS，镜像跟官方文档写 `emqx/emqx-enterprise` 并固定补丁版本
- 单节点部署要给容器配 `ulimits.nofile`，否则约 1,000 条连接就会耗尽文件描述符；只对外开放 8883，1883 和 18083 留在内网
- 集群解决的是节点故障不中断、容量和滚动升级；断线重连到其他节点后能否恢复订阅，取决于是否使用持久会话
- 集群的 License 要在启动前给每个节点配好；四层负载均衡的空闲超时要大于 1.5 倍 Keep Alive，并用 PROXY protocol 保留设备真实 IP

## 参考资料

- EMQX License FAQ：[https://www.emqx.com/en/content/license-faq](https://www.emqx.com/en/content/license-faq)
- EMQX 文档：Docker 部署：[https://docs.emqx.com/en/emqx/latest/deploy/install-docker.html](https://docs.emqx.com/en/emqx/latest/deploy/install-docker.html)
- EMQX 文档：License 管理：[https://docs.emqx.com/en/emqx/latest/deploy/license.html](https://docs.emqx.com/en/emqx/latest/deploy/license.html)
- EMQX 文档：版本生命周期与 EOL 日期：[https://docs.emqx.com/en/emqx/latest/changes/eol-ee.html](https://docs.emqx.com/en/emqx/latest/changes/eol-ee.html)
- EMQ 公告：EMQX 5.8 开源版生命周期结束：[https://www.emqx.com/en/news/a-notice-on-the-emqx-5-8-open-source-version](https://www.emqx.com/en/news/a-notice-on-the-emqx-5-8-open-source-version)
- Docker Hub：emqx/emqx-enterprise：[https://hub.docker.com/r/emqx/emqx-enterprise](https://hub.docker.com/r/emqx/emqx-enterprise)
- NGINX stream proxy 模块：[https://nginx.org/en/docs/stream/ngx_stream_proxy_module.html](https://nginx.org/en/docs/stream/ngx_stream_proxy_module.html)

> 下一篇：[边缘计算](./4_edge) —— 云边端分工、EdgeX Foundry、KubeEdge 云边协同、边缘 AI 推理。
