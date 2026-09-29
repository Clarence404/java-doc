# 冗余与故障转移

> 相关：[分布式理论（Raft / 选主）](/distributed/2_theorem) · [MySQL 主从复制](/database/1_mysql/9_topic_replication) · [Redis 集群](/cache/3_redis_cluster) · [Kubernetes](/cloud-native/6_kubernetes)

冗余解决"有没有备份"，故障转移解决"备份能不能自动顶上"。二者缺一不可：只有冗余没有自动切换，MTTR 取决于人工响应速度；只有切换没有防脑裂，切换本身会制造更大的故障。

## 一、消除单点

单点（SPOF，Single Point of Failure）是指一旦故障就导致整体不可用的组件。梳理方式：沿请求链路逐层问"这一层只有一个吗？挂了会怎样？"

| 层次 | 常见单点 | 冗余方案 |
|------|---------|---------|
| 接入层 | 单个 DNS 解析、单台 Nginx | 多 DNS 服务商、LVS / Nginx + Keepalived VIP、云 SLB |
| 网关 / 应用 | 单实例部署 | 无状态化 + 多实例 + 负载均衡，跨可用区部署 |
| 注册 / 配置中心 | 单节点 Nacos / ZooKeeper | 3 或 5 节点集群；客户端本地缓存兜底 |
| 数据库 | 单主库 | 主从 + 自动切换、MGR |
| 缓存 | 单 Redis | Sentinel / Cluster；缓存失效时的限流保护 |
| 消息队列 | 单 Broker | 多副本（Kafka ISR、RocketMQ DLedger）|
| 基础设施 | 单机柜、单可用区、单机房 | 跨机架反亲和、多可用区、多活，见 [多活与容灾](/high-avail/8_multi_active) |
| 人与流程 | 只有一个人会操作、预案没人演练 | 值班轮换、Runbook、定期演练 |

**应用无状态化是冗余的前提**：Session 放 Redis 或改用 Token、本地文件改对象存储、本地定时任务改分布式调度，这样任意实例都可被替换。

---

## 二、冷备 / 温备 / 热备

| 类型 | 备用节点状态 | 数据同步 | 切换时间（RTO）| 成本 | 典型场景 |
|------|------------|---------|--------------|------|---------|
| 冷备 | 未运行，只有备份文件 | 定期全量备份 | 小时级 ~ 天级 | 低 | 归档数据、非核心系统 |
| 温备 | 已部署但不承接流量 | 异步复制，可能落后 | 分钟级 | 中 | 容灾机房、报表库 |
| 热备 | 运行中，随时接管 | 实时 / 半同步复制 | 秒级 ~ 分钟级 | 高 | 核心数据库、网关 |
| 多活 | 同时承接流量 | 双向同步或分片隔离 | 秒级（切流即可）| 最高 | 核心交易链路 |

冷备不等于没用：**备份是防误删、防勒索的最后一道防线**，复制无法防止 `DELETE` 被同步到所有副本。备份必须定期做恢复演练，否则等于没有备份。

---

## 三、冗余架构模式

| 模式 | 说明 | 优点 | 缺点 | 示例 |
|------|------|------|------|------|
| **主备（Active-Standby）** | 主节点服务，备节点待命 | 简单，无写冲突 | 备节点资源闲置；切换有中断 | MySQL 主从、Keepalived 双机 |
| **主主（Active-Active）** | 两个节点同时读写 | 资源利用率高 | 写冲突、自增 ID 冲突，需要冲突解决 | MySQL 双主（通常仅单边写）|
| **集群（Cluster）** | N 个对等或分片节点，多数派决策 | 自动选主、可水平扩展 | 实现复杂，需要奇数节点 | Redis Cluster、MGR、etcd、Kafka |

生产中 MySQL "双主"通常配置为**双主单写**：两边互为主从，但同一时刻只有一边接受写入，本质仍是主备，只是切换后无需重建复制关系。

---

## 四、健康检查

### 1、主动检查与被动检查

| 方式 | 原理 | 优点 | 缺点 |
|------|------|------|------|
| 主动检查 | 定时探测 `/health` 端口或接口 | 无流量时也能发现故障 | 探测接口健康不代表业务健康 |
| 被动检查 | 统计真实请求的失败 / 超时 | 反映真实业务状态 | 需要有流量；会牺牲少量请求 |

两者通常组合使用。Nginx 开源版只支持被动检查：

```nginx
upstream backend {
    # 10s 内失败 3 次则摘除 10s，之后再试探
    server 10.0.0.1:8080 max_fails=3 fail_timeout=10s;
    server 10.0.0.2:8080 max_fails=3 fail_timeout=10s;
    server 10.0.0.3:8080 backup;          # 其余节点都不可用时才启用
}

location /api/ {
    proxy_pass http://backend;
    proxy_connect_timeout 1s;
    proxy_next_upstream error timeout http_502 http_503;
    proxy_next_upstream_tries 2;          # 最多换 2 个实例，避免重试放大
    # 非幂等请求（POST）默认不会转发到下一个实例，不要随意加 non_idempotent
}
```

主动健康检查需要 Nginx Plus 或第三方模块：

```nginx
# nginx_upstream_check_module（Tengine 内置）
upstream backend {
    server 10.0.0.1:8080;
    server 10.0.0.2:8080;
    check interval=3000 rise=2 fall=3 timeout=1000 type=http;
    check_http_send "GET /actuator/health HTTP/1.0\r\n\r\n";
    check_http_expect_alive http_2xx;
}
```

### 2、Kubernetes 探针

| 探针 | 失败后果 | 应检查什么 | 不应检查什么 |
|------|---------|-----------|------------|
| `startupProbe` | 超过阈值则重启 | 应用是否启动完成 | — |
| `livenessProbe` | 重启容器 | 进程是否卡死（死锁、OOM 前夕）| **下游依赖**（DB 挂了重启也没用，反而全部重启）|
| `readinessProbe` | 从 Service Endpoints 摘除，不重启 | 能否接收流量（预热完成、依赖可用）| — |

Spring Boot 2.3+ 提供可用性状态端点，在 K8s 环境下自动启用：

```yaml
management:
  endpoint:
    health:
      probes:
        enabled: true            # 暴露 /actuator/health/liveness 与 /readiness
      group:
        readiness:
          include: readinessState,db,redis   # 就绪检查可包含关键依赖
```

```yaml
startupProbe:
  httpGet: { path: /actuator/health/liveness, port: 8080 }
  periodSeconds: 5
  failureThreshold: 30           # 最多给 150s 启动时间
livenessProbe:
  httpGet: { path: /actuator/health/liveness, port: 8080 }
  periodSeconds: 10
  failureThreshold: 3
readinessProbe:
  httpGet: { path: /actuator/health/readiness, port: 8080 }
  periodSeconds: 5
  failureThreshold: 3            # 连续 3 次失败则摘除流量
```

---

## 五、故障检测与自动切换

| 机制 | 适用层 | 原理 | 切换时间 |
|------|-------|------|---------|
| VIP 漂移（Keepalived）| LVS / Nginx / 数据库主备 | VRRP 协议选出 Master 持有虚拟 IP，Master 失联后 Backup 接管 VIP | 秒级 |
| 注册中心摘除 | 微服务实例 | 心跳超时后实例被标记不健康或删除，客户端刷新列表 | 秒级 ~ 分钟级 |
| 哨兵选主 | Redis 主从 | 多个 Sentinel 投票判定客观下线，选出新主 | 秒级（取决于 `down-after-milliseconds`）|
| 共识选主 | etcd / MGR / Kafka KRaft | Raft 等共识算法多数派选举 Leader | 秒级 |

### 1、Keepalived VIP

```text
vrrp_script chk_nginx {
    script "/etc/keepalived/check_nginx.sh"   # Nginx 进程不存在时返回非 0
    interval 2
    weight -20                                # 检查失败则降低优先级，触发切换
    fall 3
    rise 2
}

vrrp_instance VI_1 {
    state BACKUP              # 两台都配 BACKUP + nopreempt，避免主恢复后抢回 VIP 造成二次抖动
    nopreempt
    interface eth0
    virtual_router_id 51
    priority 100              # 另一台配 90
    advert_int 1
    virtual_ipaddress {
        10.0.0.100/24
    }
    track_script {
        chk_nginx
    }
}
```

### 2、注册中心摘除的时效

| 注册中心 | 摘除机制 | 最坏感知时间 |
|---------|---------|------------|
| Nacos 2.x 临时实例 | gRPC 长连接断开即摘除；进程假死时依赖连接探活 | 秒级 |
| Nacos 1.x 临时实例 | 5s 心跳，15s 标记不健康，30s 删除 | 15 ~ 30s + 客户端刷新 |
| Eureka | 30s 续约，90s 租约过期；另有服务端 / 客户端多级缓存 | 可达 2 ~ 3 分钟 |

注册中心总有感知延迟，**调用方必须配合超时 + 重试其他实例 + 熔断**，才能覆盖这段时间窗口，见 [隔离、重试与超时](/high-avail/6_bulkhead_retry)。主动下线应先从注册中心注销再停进程，见 [优雅上下线与变更](/high-avail/9_graceful_release)。

### 3、选主

自动选主的关键是**多数派（Quorum）**：N 个节点至少 ⌊N/2⌋ + 1 个同意才能产生新主，所以集群取奇数节点（3 节点容忍 1 个故障，5 节点容忍 2 个）。Raft 的选举与任期机制见 [分布式理论](/distributed/2_theorem)。

---

## 六、脑裂与 fencing

**脑裂（Split-Brain）**：网络分区导致两侧都认为对方故障，同时存在两个"主"并各自接受写入，恢复后数据冲突甚至无法合并。

| 场景 | 表现 |
|------|------|
| Keepalived 心跳线中断 | 两台都持有 VIP，ARP 表来回跳 |
| Redis Sentinel 分区 | 旧主在少数派一侧继续接受写入，恢复后被降级为从，期间写入丢失 |
| 数据库主备误切换 | 旧主未真正宕机，应用仍有连接写入旧主 |

| 防护手段 | 原理 | 示例 |
|---------|------|------|
| 多数派仲裁 | 只有拿到多数票的一方可以成为主 | Raft、Sentinel quorum、MGR |
| Fencing Token | 每次选主递增任期号，存储层拒绝旧任期的写入 | Raft term、ZooKeeper zxid、分布式锁的递增 token |
| STONITH | "爆头"：切换前强制隔离旧主（断电、摘网卡、撤销权限）| Pacemaker、云厂商 API 关停实例 |
| 旧主自我降级 | 旧主无法与足够多的副本通信时拒绝写入 | Redis `min-replicas-to-write` |
| 第三方仲裁 | 引入仲裁节点 / 仲裁机房判断谁存活 | 两地三中心的仲裁点、Keepalived 检测网关连通性 |

```text
# redis.conf：从库少于 1 个或延迟超过 10s 时，主库拒绝写入，限制分区期间的数据丢失
min-replicas-to-write 1
min-replicas-max-lag 10
```

---

## 七、数据层高可用

| 方案 | 说明 | 切换方式 | 数据一致性 |
|------|------|---------|-----------|
| 主从复制 + 半同步 | 主库写，从库读；至少一个从库收到 binlog 才返回 | 需配合 MHA / Orchestrator | 半同步下基本不丢，退化为异步时可能丢 |
| MHA | 监控主库，故障时从最新从库补齐差异 binlog 并提升 | 自动，30s 左右 | 尽力补齐；项目已多年未维护 |
| Orchestrator | 识别复制拓扑，自动提升并重建拓扑，自身基于 Raft 高可用 | 自动，秒级 | 依赖复制模式 |
| MGR / InnoDB Cluster | 基于 Paxos 的组复制，单主模式自动选主 | 自动，秒级；需多数派存活 | 强一致（多数派确认）|
| Redis Sentinel | 哨兵监控主从，客观下线后选新主并通知客户端 | 自动，秒级 | 异步复制，切换可能丢少量写 |
| Redis Cluster | 16384 槽分片，每分片主从，节点间 Gossip 判定故障 | 自动，秒级 | 同上 |
| 分片 + 多副本 | 数据水平分片，每个分片多副本容错 | 依赖具体中间件 | 依赖具体中间件 |
| 多活数据同步 | 双向复制，就近写入，依赖幂等与冲突解决 | 切流 | 最终一致，见 [多活与容灾](/high-avail/8_multi_active) |

应用侧同样要配合切换：

- **连接串不写死主库 IP**：使用 VIP、DNS 域名、中间件代理（ProxySQL / MySQL Router）或 Sentinel 客户端
- **连接池能感知切换**：设置合理的 `maxLifetime`、连接校验，避免切换后长时间持有指向旧主的连接
- **读写分离注意复制延迟**：写后立即读的场景强制走主库

复制原理与延迟排查见 [MySQL 主从复制](/database/1_mysql/9_topic_replication)，Sentinel 与 Cluster 的配置见 [Redis 集群](/cache/3_redis_cluster)。
