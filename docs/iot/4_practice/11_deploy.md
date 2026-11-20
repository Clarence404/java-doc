---
description: Compose 部署包与必填配置、合并与拆分部署、Flyway 迁移与演示数据、健康检查、指标看板与会话监控、发布回滚
---

# 部署与可观测

> 前置阅读：[压测与瓶颈排查](./10_capacity)、[Docker](/cloud-native/5_docker)、[指标监控](/observability/2_metrics)

Conduit 目前的交付形态是一组 Docker Compose 部署包，加一套可选的 Prometheus 与 Grafana 观测栈，编排里的许多取值是压测时一条条换来的。本篇讲部署包的组成与配置、合并与拆分部署、迁移与演示数据、健康检查与指标看板、发布回滚现状，并给全系列做一次小结，基线为 JDK 21、Spring Boot 3.5。

---

## 一、本篇做什么

| 问题 | 做法 |
|------|------|
| 一条命令把整套系统起起来 | 三个 Compose 部署包，后者用 `extends` 引用前者，不复制服务定义 |
| 配置漏填了怎么办 | 必填变量在编排里写成 `${VAR:?}`，没设就拒绝启动 |
| 接入层太吃 CPU | 拆分部署：EMQX 单独一台主机 |
| 表结构怎么升级，新环境有没有东西可看 | Flyway 版本化迁移；演示数据是独立的迁移与脚本 |
| 怎么知道它还活着 | 健康检查区分「进程在」与「在干活」；transport 监控自己的 EMQX 会话 |
| 慢了、丢了去哪看 | 一块按数据流逐跳排布的看板，带守恒差 |
| 怎么发版、怎么退回去 | 按提交打包、按提交建发布目录；备份恢复目前是手工步骤 |

![Compose 部署包：服务组成与两种部署方式](../../assets/iot/conduit-deploy-topology.svg)

Compose 文件的语法、`extends`、健康检查与 profile 的通用用法见 [Docker](/cloud-native/5_docker)。

---

## 二、三个部署包

| 目录 | 用途 | 内容 |
|------|------|------|
| [`deploy/dev`](https://github.com/Clarence404/conduit-iot/tree/811e441/deploy/dev) | 开发环境：只起基础服务，应用在 IDE 里跑 | PostgreSQL、Redis、InfluxDB、InfluxDB Explorer、EMQX；可选观测栈 |
| [`deploy/standalone`](https://github.com/Clarence404/conduit-iot/tree/811e441/deploy/standalone) | 独立部署：全部服务在一台主机 | `extends` dev 的全部服务，再加 server、两个 transport、web、模拟器、Mailpit |
| [`deploy/split`](https://github.com/Clarence404/conduit-iot/tree/811e441/deploy/split) | 拆分部署：EMQX 一台，其余一台 | `split/emqx` extends dev 的 emqx；`split/app` 逐个 extends standalone 的服务 |

**服务定义只写一份**。基础服务只在 dev 的编排里定义，其余两个包用 `extends` 引用，只写不同的部分：

```yaml
# deploy/standalone/docker-compose.yml（节选）
name: conduit

services:
  emqx:
    extends:
      file: ../dev/docker-compose.yml
      service: emqx
    environment:
      # 独立部署包中鉴权回调固定指向容器内的 conduit-server
      CONDUIT_AUTH_URL: http://conduit-server:8080
```

由此带来两条使用上的约束：

- **目录的相对位置不能变**。`deploy/dev` 与 `deploy/standalone` 必须同时存在；`extends` 不带入顶层数据卷，引用方要按同名重新声明
- **项目名与数据卷相同，同一台宿主机上二选一**。三个包的项目名都是 `conduit`（拆分部署的 EMQX 主机是 `conduit-emqx`），数据卷都是 `conduit_pg-data` 等。好处是从开发环境包切到独立部署包时数据沿用；切换时先在旧包目录 `docker compose down`（**不加 `-v`**），并在新包的 `.env` 里沿用相同的口令与密钥——PostgreSQL 与 InfluxDB 只在数据卷首次初始化时应用口令和令牌，换成新值会连不上已有数据

---

## 三、服务组成

| 服务 | 镜像 | 作用 | 健康检查 |
|------|------|------|---------|
| `postgres` | `postgres:16.8` | 租户、用户、组织、产品、设备、邀请、会话 | `pg_isready` |
| `redis` | `redis:7.4.2` | 上行总线（Streams）、最新值、在线状态、身份缓存、transport 选主 | `redis-cli ping` |
| `influxdb` | `influxdb:3.12.0-core` | 时序数据，保留 30 天 | `GET /health` |
| `influxdb-explorer` | `influxdata/influxdb3-ui:1.11.0` | 时序库的浏览器界面 | 无 |
| `emqx` | `emqx/emqx:5.10.5` | MQTT 接入，连接鉴权回调 server | `emqx ctl status` |
| `conduit-server` | 自建（`eclipse-temurin:21.0.6_7-jre`） | 鉴权回调、流水线、REST API | readiness 探针 |
| `conduit-transport` ×2 | 同上 | 协议接入，一主一备 | 无容器级检查，看 `/actuator/health` |
| `conduit-web` | 自建（`nginx:1.27.4-alpine`） | 前端静态资源与 API 转发 | 无 |
| `simulator` | 自建 | 演示设备模拟器，默认启动 | 无，`restart: on-failure` |
| `mailpit` | `axllent/mailpit:v1.27.4` | 演示收件箱，接收邀请邮件 | 无 |

几条编排上的事实：

- **镜像版本全部写死到补丁号**，不用 `latest`
- **端口默认只绑本机**。所有 `ports` 都写成 `${BIND_ADDR:-127.0.0.1}:...`，要从别的机器访问得显式改成 `0.0.0.0`；Redis 没有设口令，只应在受信网络内暴露
- **启动顺序靠 `depends_on` + `condition: service_healthy`**。server 等三个存储健康后才启动，transport 等 Redis、EMQX 和 server 都健康后才启动——EMQX 的连接鉴权要回调 server，server 没起来 transport 连不上
- **Redis 用 AOF 且每次写入刷盘**：`--appendonly yes --appendfsync always`。transport 是写入 Redis 成功后才向设备回确认的，[压测与瓶颈排查](./10_capacity) 解释过为什么不为了 32% 的吞吐把它放宽

---

## 四、.env：必填项的类别

每个包带一份 [`.env.example`](https://github.com/Clarence404/conduit-iot/blob/811e441/deploy/standalone/.env.example)，复制为 `.env` 后按组修改。必填项在编排里用 `:?` 声明，缺了直接报错退出，而不是带着空口令启动：

```yaml
environment:
  POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is required}
  CONDUIT_JWT_SECRET: ${CONDUIT_JWT_SECRET:?CONDUIT_JWT_SECRET is required}
```

按用途分成几类（这里只列类别，不列值）：

| 类别 | 变量 | 说明 |
|------|------|------|
| 存储口令 | `POSTGRES_PASSWORD`、`INFLUX_TOKEN`、`INFLUX_EXPLORER_SESSION_KEY` | InfluxDB 令牌必须以 `apiv3_` 开头，启动脚本会检查；首次初始化后不能随便换 |
| 控制台账号 | `CONDUIT_ADMIN_PASSWORD`、`CONDUIT_PLATFORM_ADMIN_PASSWORD`、`EMQX_DASHBOARD_PASSWORD` | 租户管理员与平台管理员只在库里还没有对应角色时按这里创建，之后改这里不会改已有账号的口令；平台管理员密码为空则不创建，只记一条 WARN |
| 平台内部凭据 | `CONDUIT_INTERNAL_TOKEN`、`CONDUIT_JWT_SECRET`、`TRANSPORT_MQTT_PASSWORD` | 不是给人用的，务必随机。内部令牌用于 EMQX 回调 server 与 Prometheus 抓 server 指标；JWT 密钥至少 32 字节，改它会让所有已登录会话失效 |
| EMQX 只读 API key | `CONDUIT_EMQX_API_KEY`、`CONDUIT_EMQX_API_SECRET` | 给 transport 的会话监控和 Prometheus 用；EMQX 5 的 REST API 只认 API key，不认控制台账号 |
| 对外地址 | `CONDUIT_PUBLIC_URL`、`SMTP_*` | 邀请邮件里的链接与发信服务器；演示环境默认指向 Mailpit |
| 容量参数 | `EMQX_MAX_INFLIGHT`、`EMQX_MAX_MQUEUE_LEN`、`TRANSPORT_BUS_BATCH_SIZE`、`TRANSPORT_MQTT_CONNECTIONS` | 有默认值；彼此有约束，见 [压测与瓶颈排查](./10_capacity) |
| 内存上限 | `SERVER_MEM_LIMIT`、`TRANSPORT_MEM_LIMIT`、`SIMULATOR_MEM_LIMIT`、`INFLUX_MEM_LIMIT` | 有默认值，不要设得过小 |
| 开关 | `BUILD_FROM`、`CONDUIT_AUTHORIZATION_MODE`、`BIND_ADDR` | 构建方式、授权模式、端口绑定地址 |
| 观测栈 | `GRAFANA_ADMIN_PASSWORD` | 只在启用观测栈时需要；留空时 Grafana 容器拒绝启动 |

口令不进镜像也不进部署包：`.env` 在 `.gitignore` 里，打包脚本生成的包里没有它，升级时解压新包不会覆盖。带口令的配置文件（EMQX 的鉴权配置、Prometheus 的抓取配置）用模板加启动时渲染：模板以只读方式挂载，仓库里只有 `__CONDUIT_INTERNAL_TOKEN__` 这样的占位符，容器启动命令用 `sed` 把占位符换成环境变量，渲染结果只存在于容器内。

---

## 五、几处有来历的编排细节

编排里有些行看上去只是普通配置，其实每一行背后都有一次事故或一次实测。来历在 [可靠上报与接入层主备](./3_reliable_uplink) 与 [压测与瓶颈排查](./10_capacity)，这里只列结论。

| 配置 | 取值 | 不这样会怎样 |
|------|------|-------------|
| transport 的 `stop_grace_period` | 20 秒（Compose 默认 10 秒） | 主实例来不及断开 MQTT、释放选主锁就被强杀，备实例只能等锁过期（15 秒）才接管；有了它，日常发版走的是「立即交接」而不是「崩溃切换」 |
| Java 服务的 `mem_limit` | server 1500m、每个 transport 512m、模拟器 384m；InfluxDB 2g | 镜像入口是 `-XX:MaxRAMPercentage=75`，容器没有上限时 JVM 按宿主机总内存取堆，压测后宿主机满 swap |
| EMQX 的 `ulimits.nofile` | 软硬均 1048576 | Docker 默认软限制 1024，每条 MQTT 连接占一个描述符，约 1,000 台设备时 EMQX 因 `emfile` 进入崩溃循环 |
| `EMQX_DURABLE_SESSIONS__ENABLE` | `false` | 磁盘持久会话在积压下静默楔死 |
| `EMQX_MQTT__SHARED_SUBSCRIPTION_STRATEGY` | `hash_clientid` | 同一设备的消息分到不同连接，单设备内不再保序 |
| 鉴权回调 | EMQX 端超时 10 秒；server 端 Tomcat keep-alive 30 分钟、不限单连接请求数 | 一次丢包重传就超时；长连接被 Tomcat 先关掉时偶发鉴权被拒 |

另有三处和排查习惯有关：

- **第二个 transport 用 YAML 锚点**（`<<: *transport`）复用同一份定义，只改容器名和日志目录，避免两个进程滚动同一个日志文件
- **EMQX 节点名固定**（`emqx@127.0.0.1`，单节点发现）。副作用是运行时数据按节点名存放，在控制台里改过的密码会在重建后恢复成 `.env` 里的值。Conduit 的 EMQX 一直是单节点，单节点与集群怎么取舍、集群的编排怎么写见 [EMQX 许可与部署](../1_basics/3_emqx_deploy)
- **容器名固定**：单实例服务不带 `-1` 后缀（`conduit-server`、`conduit-emqx`、`conduit-redis`），transport 是 `conduit-transport-1` / `-2`，排查命令在各部署包里通用；容器名和 MQTT 的 clientId 是两套命名，别混

停机时先摘流量再退出的通用做法见 [优雅上下线与变更](/high-avail/8_graceful_release)。

---

## 六、镜像与打包

应用镜像的产物有两种来源，由 `.env` 的 `BUILD_FROM` 选择：

| 取值 | 做法 | 适用 |
|------|------|------|
| `prebuilt`（默认） | 用 `deploy/standalone/artifacts/` 里的预编译产物 | 宿主机没有外网 |
| `source` | 在镜像构建阶段用 Maven 与 Node.js 从源码编译 | 宿主机能联网 |

同一个 Dockerfile 用多阶段构建实现二选一，BuildKit 只构建被选中的阶段：

```dockerfile
ARG BUILD_FROM=prebuilt
FROM scratch AS prebuilt                      # 直接复制 artifacts/ 里的 jar 到 /out/app.jar
FROM maven:3.9.9-eclipse-temurin-21 AS source # 复制源码并 mvn package，产物同样放到 /out/app.jar
FROM ${BUILD_FROM} AS app

FROM eclipse-temurin:21.0.6_7-jre
COPY --from=app /out/app.jar app.jar
ENTRYPOINT ["java", "-XX:MaxRAMPercentage=75", "-jar", "/app/app.jar"]
```

预编译包由 [`deploy/package.sh`](https://github.com/Clarence404/conduit-iot/blob/811e441/deploy/package.sh) 在开发机上生成，产物是 `target/conduit-standalone-<短提交>.tar.gz`。脚本里有几处防呆：

- **从当前提交的干净检出编译**（临时 `git worktree`），未提交的修改不会进包，包名里的短提交就是包的真实内容
- **检查本地配置没有被 Git 跟踪**。`application-local.yml` 之类一旦被误提交，干净检出也会带上它，脚本发现就直接报错退出
- **先写临时文件再改名**，打包失败不会留下一个看似完整的包

这里踩过一个部署上的坑：`BUILD_FROM=prebuilt` 时更新了 `artifacts/` 却只执行 `docker compose up -d`，容器沿用旧镜像。**要带 `--build`**，而且「容器已启动」不等于「部署了预期的版本」，起来之后要看一眼版本特有的东西在不在。

---

## 七、合并部署与拆分部署

独立部署是全部服务在一台主机上。[压测与瓶颈排查](./10_capacity) 的 CPU 拆解显示，高负载时 EMQX 与内核网络处理占忙碌 CPU 的约 70%，于是有了拆分部署：把设备接入层的 CPU 与网络开销从应用主机上拆走。

| 主机 | 目录 | 服务 |
|------|------|------|
| EMQX 主机 | `deploy/split/emqx` | EMQX；可选 node-exporter |
| 应用主机 | `deploy/split/app` | PostgreSQL、Redis、InfluxDB、server、两个 transport、web、模拟器、Mailpit；可选观测栈 |

**网络方向**是拆分后最容易漏的：

| 方向 | 用途 |
|------|------|
| 设备 → EMQX 主机 | MQTT 接入 |
| 应用主机 → EMQX 主机 | transport 连 EMQX；会话监控与 Prometheus 访问 EMQX 的 REST API |
| **EMQX 主机 → 应用主机** | **每次设备连接的鉴权回调**，同步调用，不通则设备全部连不上 |

应用主机的编排逐个 `extends` 独立部署包的服务，只改连接地址（`EMQX_REMOTE_HOST` 必填），并用 `depends_on: !override` 去掉对本机 emqx 的依赖（需要 Compose 2.24.4 及以上）。其他要点：

- **两边四个口令必须相同**：内部令牌、EMQX API key 与 secret、控制台密码
- **两台主机上都要有完整的 `deploy/` 目录**，因为两边都在 `extends`
- **从独立部署切过来数据沿用**：项目名与数据卷相同，`up -d --remove-orphans` 会把本机原来的 EMQX 当作孤儿移除
- **一台 EMQX 只对应一套 Conduit**。Conduit 用的 EMQX 5.10 默认没有 RabbitMQ vhost 那样的命名空间：几套环境共用一台 EMQX 时，transport 的 clientId 相同会互相挤掉会话，共享订阅组同名会把消息分到别人的 transport 上，鉴权回调也只能配一个地址

拆分部署包里 EMQX 的容量参数取的是它接受的最大值（在途窗口 65535、会话队列不限、关闭按信箱与堆强杀单个连接）。**代价要清楚**：过载不再表现为「单条连接被杀、丢一部分」，而是积压一直涨到 EMQX 整个节点内存耗尽、所有设备一起断开；队列不限时会话监控的「队列水位」告警也不会触发。这是为压测取的值，不是给生产的建议。

部署验证见 [拆分部署报告](https://github.com/Clarence404/conduit-iot/blob/811e441/docs/test-reports/2026-10-30-split-deployment.md)：主实例 4 条连接全部连上远端 EMQX，Prometheus 抓到远端 EMQX，入库速率等于 EMQX 接收速率。

---

## 八、Flyway 迁移与演示数据

### 1、版本化迁移

表结构由 Flyway 管，server 启动时自动执行。到本篇依据的提交一共 10 个版本：

| 版本 | 内容 |
|------|------|
| V1 / V2 | 初始表、物模型 |
| V3 | 租户与用户 |
| V4 | 演示数据种子 |
| V5 | 租户组合外键 |
| V6 | 组织模型（客户、项目、站点、资产） |
| V7 | 演示租户的组织种子 |
| V8 | 授权（角色定义、角色权限、角色绑定） |
| V9 / V10 | 会话与授权版本、邮件邀请 |

几条从这些迁移里能看出来的习惯：

- **只扩展，不破坏**。V8 加表加列，保留旧的 `app_user.role`；没有破坏性的回退迁移。应用回滚靠「新列旧代码不读」，而不是把表结构退回去
- **改约束前先查真实库**。V5 要删旧外键，约束名是到真实库的系统表里查出来的；迁移前先跑脏数据查询，是 0 行才继续
- **存量数据在迁移里补齐**。V6 给每个存量租户建默认项目与默认站点，并把存量设备归进去，迁移完不会有「没有站点的设备」

Flyway 的通用用法（命名、校验和、基线）见 [数据库版本迁移](/spring-boot/4_flyway)。

### 2、演示数据

新环境起来后应该马上有东西可看。演示数据分三层，各用各的办法：

| 数据 | 放在哪 | 理由 |
|------|-------|------|
| 关系数据：4 个租户、8 个产品、174 台设备、36 个物模型属性 | Flyway V4；组织归属在 V7 | 稳定，适合版本化 |
| 需要账号的演示（权限演示、邀请演示） | [`deploy/demo/*.py`](https://github.com/Clarence404/conduit-iot/tree/811e441/deploy/demo)，通过正式 API 创建 | 不在迁移里嵌入可登录的账号，也不绕过首次改密 |
| 动态数据：在线状态、最新值、历史曲线 | 模拟器持续生成 | 会过期，不该伪造成初始化那一刻的「实时」数据 |

安全与幂等上的几条约束：

- **种子设备的密钥是不可用的占位哈希**，没有对应的明文，不能直接接入；模拟器通过受保护的 API 重置密钥后才连 MQTT
- **迁移里不写任何账号密码**，管理员仍由启动时按环境变量创建
- **重复执行不重复插入**：租户按编码、产品按名称复用；V7 只给演示租户补组织，不向普通新租户灌演示数据，不覆盖人工调整过的设备归属
- **演示脚本要显式的 `--demo` 才执行**，只动默认演示租户，口令从环境变量读、不打印

### 3、演示数据与生产基线：原则与现状

路线图的原则写得很明确：**演示数据不得进入生产租户**，首次正式生产发布前要建立没有演示种子的生产基线，演示数据改由显式的启动模式或初始化任务创建。

现状是还没做到。V4 是一个普通的迁移，**任何执行迁移的环境都会得到这批演示数据**；迁移一旦执行就不能再改（校验和会对不上），日后要去掉只能另写一个删除迁移。[设计文档](https://github.com/Clarence404/conduit-iot/blob/811e441/docs/superpowers/specs/2026-10-20-conduit-demo-seed-design.md) 里记着这次取舍：当前用途是研究与演示，演示数据出现在每个环境正是想要的效果，真要部署不含演示数据的环境时再重新评估。把它从生产初始化链路里剥离，是路线图 V0.3-C 的一项。

---

## 九、健康检查

健康检查要回答的不是「进程在不在」，而是「它在不在干活」。

**server：readiness 探针**。镜像里没有 `curl`，用 bash 的 `/dev/tcp` 请求：

```yaml
healthcheck:
  test:
    - CMD
    - bash
    - -c
    - >-
      exec 3<>/dev/tcp/127.0.0.1/8080
      && printf 'GET /actuator/health/readiness HTTP/1.0\r\nHost: localhost\r\n\r\n' >&3
      && grep -q '"UP"' <&3
  interval: 5s
  start_period: 30s
  retries: 30
```

用 readiness 而不是普通的 health：只有启动任务（包括创建初始管理员）全部执行完才返回 UP，依赖它的 transport 和模拟器不会在 server「半起」时就连上来。

**transport：角色与会话**。`/actuator/health` 的 `components.leader.details` 给出 `role`（主或备）、`instanceId`、`connected`。`connected` 只在已连接且订阅获批后才是 true；主实例还会带上会话监控的明细（队列长度、信箱长度、投递总数、最近一次成功采样的时刻），备实例明确标示「不监控本会话」。

**那次所有信号都是绿的事故**。磁盘持久会话楔死时，transport 健康 UP、主实例已连接、EMQX 显示已连接、两侧日志零错误，而投递已经完全停止。连接级的健康检查发现不了「连着但不投递」。于是 transport 现在自己去看 EMQX 眼里的那个会话，见第十一节。

Spring Boot Actuator 的探针与端点见 [Actuator 监控](/spring-boot/11_actuator)。

---

## 十、指标与看板

### 1、观测栈

放在 Compose 的 `metrics` profile 下，**默认不启动**：

```bash
docker compose --profile metrics up -d
```

| 组件 | 版本 | 说明 |
|------|------|------|
| Prometheus | v3.5.0 | 抓取间隔 15 秒；数据保留 7 天且不超过 2 GB；端口默认只绑本机 |
| Grafana | 11.6.1 | 不开匿名访问；数据源与看板用 provisioning 预置 |
| node-exporter | v1.9.1 | 宿主机 CPU、内存、磁盘、网络 |
| redis-exporter | v1.74.0 | 另外单独检查上行流与死信流两个 Stream |
| cadvisor | v0.52.1 | 每容器的 CPU 与内存；单独放在 `metrics-cadvisor` profile |

每个组件都设了内存上限，四个默认组件合计约 896 MB。cadvisor 单独一个 profile 的原因很实际：它的镜像托管在部分网络访问不到的仓库，而同一个 profile 里任何一个镜像拉不下来，整组都起不来。

### 2、怎么抓：三种鉴权

| 目标 | 路径 | 凭据 |
|------|------|------|
| server | `/internal/metrics` | 请求头带内部令牌，与 EMQX 鉴权回调同一个 |
| transport | `/actuator/prometheus` | 无；端口只在 Compose 网络内，不映射到宿主机 |
| EMQX | `/api/v5/prometheus/stats` | 只读 API key |
| InfluxDB | `/metrics` | 无；启动参数里只对 health、ping、metrics 三个端点免鉴权 |

server 为什么不直接抓 `/actuator/prometheus`：这个路径只有平台管理员能访问，凭据是 15 分钟过期、依赖数据库会话的 JWT，Prometheus 拿不到稳定的凭据；又不能为了抓取把 `/actuator/**` 放开。于是另开一个内部端点，由控制器自己校验内部令牌。InfluxDB 那边同理：只对指标端点免鉴权，而不是把能写能删整个库的管理员令牌发给 Prometheus。

内部端点对指标注册表是弱依赖：注册表不存在时启动只记一条 WARN，端点返回 503，Prometheus 上表现为该目标 `up` 为 0。这个写法来自一次教训——最初写成构造器强依赖，测试环境里指标导出默认关闭，结果 268 个集成测试全部因为上下文起不来而报错。一个诊断端点不应当有能力阻止应用启动。

### 3、看板：按数据流逐跳排

看板 [`conduit-bottleneck.json`](https://github.com/Clarence404/conduit-iot/blob/811e441/deploy/dev/grafana/dashboards/conduit-bottleneck.json)（「Conduit 性能瓶颈观测」）共 52 个面板，按消息走过的路径分组：

| 分组 | 看什么 |
|------|-------|
| 0. 总览 | 入库 TPS、接入 QPS、端到端延迟、守恒差、EMQX 丢弃、死信、当前积压、整机 CPU、Redis 单线程 CPU、连接信箱占强杀线的比例、连接进程忙碌度 |
| 1. 链路各跳速率 | 从接入到入库六跳画在一张图上：哪一跳先掉下来，瓶颈就在它前面 |
| 2. 接入：EMQX | 连接与订阅、丢弃、设备鉴权（按拒绝原因）、鉴权回调耗时、共享订阅数 |
| 3. transport：按连接 | 各连接的收取速率、会话队列、在途窗口、会话进程堆、信箱、忙碌度 |
| 4. Redis 总线 | 上行流与消费组积压、单线程 CPU、命令吞吐与耗时、内存与 AOF |
| 5. 流水线 | 每批各阶段耗时、每批条数、端到端延迟、死信与测点拒绝 |
| 6. InfluxDB | 写入请求与耗时、CPU、落盘耗时、查询耗时 |
| 7 / 8. 资源与 JVM | 各服务 CPU 与内存、磁盘、堆、GC、线程数 |

总览一行回答三个问题：吞吐多少、有没有丢、还剩多少余量。几个面板带颜色阈值（黄 / 红）：当前积压 1 万条 / 5 万条，持续增长即过载；端到端延迟 3 秒 / 10 秒；守恒差（EMQX 收到、却没写进总线的条数，应为 0）500 条 / 2,000 条；连接信箱占强杀线的比例 30% / 80%，到 100% 该连接即被强杀。

另有三类事件标注画在所有时间序列上：服务重启、EMQX 重启、transport 主备切换。

### 4、守恒差：一个指标校准了两版

「有没有丢」这个格子最能说明看板不是把指标摆上去就行（[看板重排报告](https://github.com/Clarence404/conduit-iot/blob/811e441/docs/test-reports/2026-10-29-grafana-dashboard-regroup.md)）：

- **第一版被实验否定**。用 `increase()` 和 server 进程内的入库计数相减。受控实验里，一轮确认没丢的负载中途停 server 40 秒，它报出 3.3%～15.6% 的「丢失」——`increase()` 在速率陡变时会外推偏几个百分点，进程内计数在重启时会丢掉最后一截。而真实丢失（1.55%～4.8%）恰好落在这个误差里，分不出来
- **定稿口径**。全部改用 EMQX 与 Redis 里重启不归零的计数器，两端原始值相减：设备上行 + 上下线事件 − 消费组已读出 − 积压变化。并且**只在时间范围两端都空闲时出数**，负载中各组件抓取时刻不一致，会整体平移约 9 秒的流量
- **校准过程中发现 EMQX 的丢弃计数漏掉了绝大部分丢失**。一次过载实际少了约 40.7 万条，而 `emqx_messages_dropped` 的增量是 0：随被强杀的连接进程一起丢掉的消息，EMQX 不计数。所以「EMQX 丢弃」这个格子旁边必须有守恒差

还有两处口径修正：接入 QPS 要用 QoS 1 的接收计数，总接收数里含 transport 发给设备的 QoS 0 回执，实测恰好是入库数的 2 倍；鉴权拒绝要看 EMQX 的鉴权失败计数，因为 server 按 EMQX 的 HTTP 鉴权协议对拒绝也回 200，HTTP 指标分不出放行与拒绝。

指标类型与 PromQL 的 `rate`、`increase` 见 [指标监控](/observability/2_metrics)。

---

## 十一、会话监控与告警

### 1、transport 监控自己的 EMQX 会话

主实例每 30 秒经 EMQX 的 REST API（只读 API key）按连接轮询自己的会话，同时把采样值发布为指标 `conduit.transport.session.*`——EMQX 自带的 Prometheus 端点不提供单会话的队列深度。六项判断：

| 项 | 条件 | 结果 |
|----|------|------|
| 丢弃 | 队列丢弃计数比上次增长 | WARN |
| 队列水位 | 队列长度达到容量的 80% | WARN |
| 会话内存 | 会话进程堆达到实际强杀值的 70% | WARN |
| **投递停滞** | 在途窗口占满、队列非空，且投递总数连续 6 次采样不变 | **健康检查 DOWN** |
| 磁盘持久会话被意外启用 | 会话是持久类型 | WARN |
| 批大于窗口 | transport 批大小超过 EMQX 在途窗口 | WARN |

几处细节：

- **只有「投递停滞」把健康检查置为 DOWN**，任一条连接停滞即判 DOWN。其余五项只告警，避免一个容量预警把实例摘掉
- **从首次异常采样到 DOWN 是 150 秒**（6 次采样之间有 5 个间隔），算上采样相位最长约 3 分钟
- **堆的阈值按实际触发值算**。EMQX 实际触发强杀的堆大小是配置值的 1.5 倍；按配置值算会在真实上限的 47% 处就告警，是典型的告警疲劳来源
- **采样失败不等于会话有问题**。偶发失败保留上一次的结论；仪表在采样失败或本实例不再是主实例时置为「无数据」，绝不停在旧值上——一条陈旧的平线会被误读成一切正常
- **信箱长度与进程忙碌度只暴露、不参与判定**。阈值要先用过载与健康两组历史数据验证能区分，才有资格标红

源码：[`SessionMonitor`](https://github.com/Clarence404/conduit-iot/blob/811e441/conduit-transport/src/main/java/dev/conduit/transport/monitor/SessionMonitor.java)。本地开发没有 EMQX API key 时要把监控关掉（`conduit.transport.monitor.enabled: false`），否则 transport 启动失败。

### 2、告警的现状

要直说：**仓库里没有 Prometheus 告警规则，也没有部署 Alertmanager**。现在的「告警」只有三种形态：健康检查（投递停滞时 transport 变 DOWN，编排系统和探活能看到）、日志（会话监控的 WARN / ERROR、死信原因、`Authorization shadow denied`，要有人看日志）、看板阈值（积压、端到端延迟、守恒差、信箱占比的黄线与红线，要有人打开看板）。

路线图 V0.3-F 运维基线里列的「服务与租户维度指标、队列积压与**最老消息年龄**、处理延迟和错误告警」还没做：积压有面板，最老消息年龄连指标都还没有，规则与通知渠道都是空的。告警的分级、`for` 与降噪见 [告警体系](/observability/4_alerting)。

---

## 十二、日志

- **位置**：Java 服务除控制台外都写文件，目录由 `CONDUIT_LOG_DIR` 指定，每个服务一个 `<服务名>.log`。Docker 里共用命名卷 `conduit-logs`，第二个 transport 写到它的 `transport-2` 子目录
- **滚动**：按天并按大小，单文件 50 MB、保留 14 天、总量上限 1 GB
- **级别约定**：消息链路上 DEBUG 每条消息或每批一行，逐字段的细节放 TRACE；重试类日志首次失败 WARN、后续重试 DEBUG、恢复与角色变化 INFO，避免一次故障刷出几千行相同的 WARN
- **不记什么**：设备密钥、口令、JWT、内部令牌一律不记；报文内容只在 TRACE 输出并截断到 256 字符；管理操作各记一行 INFO，不记请求体
- **没有集中采集**：日志在卷里，要到宿主机上看。没有接 Loki 或 ELK，也没有链路追踪

结构化日志与集中采集见 [日志体系](/observability/1_logging)。

---

## 十三、发布、回滚与备份恢复

这一节大部分是「现在怎么手工做」，离自动化还远。

**发布**。测试报告里实际用的流程：

1. 开发机 `deploy/package.sh` 打包，包名带短提交
2. 复制到宿主机，解压到按提交命名的发布目录，再把「当前版本」链接指过去；旧的发布目录保留
3. 沿用原来的 `.env` 与全部数据卷，`docker compose config --quiet` 先校验编排
4. `docker compose up -d --build --remove-orphans --wait`，等带健康检查的服务全部 healthy
5. 烟测：readiness、登录、Flyway 版本、Redis 里的最新值与在线状态键数、应用日志里有没有 ERROR

**升级前的数据库备份**。涉及迁移的发布，先 `pg_dump -Fc` 备份 PostgreSQL，并在容器里用 `pg_restore --list` 确认备份文件能枚举出目录。这只证明备份文件可读，不等于做过恢复演练。

**回滚**的边界：

- **应用可以退**：切回旧的发布目录重新 `up -d --build`。迁移只扩展不破坏，旧代码读不到新列也能跑
- **有的开关退不回去**：授权切到 `enforce` 并且已经依赖范围授权之后，禁止回退旧版本，否则项目成员会恢复全租户权限。出问题时应切 `read-only`，见 [多租户与授权](./6_tenant)
- **数据库没有回退迁移**，退表结构只能靠恢复备份
- **InfluxDB 的令牌在首次启动时写入库里**，之后要换只能删数据卷，时序数据随之丢失

**各存储的恢复手段**：

| 存储 | 现状 |
|------|------|
| PostgreSQL | 手工 `pg_dump`；没有定时备份，没有恢复演练，没有时间点恢复 |
| InfluxDB | 没有备份。非正常断电会丢内核回写窗口内的数据，可以用遥测重放从 Redis 上行流里找回，但只能回溯到流里还保留的那一段（上限约 100 万条，单次任务最多 6 小时），见 [时序存储与历史查询](./5_telemetry) |
| Redis | AOF 每次写入刷盘；单实例，没有副本 |
| EMQX | 内存会话，重启即丢未投递的消息；带 `id` 的设备靠重发覆盖 |

备份策略、恢复点与恢复时间目标的通用讨论见 [数据备份与恢复](/database/6_sync_backup/2_backup_recovery)。

---

## 十四、验证

| 结论 | 测试 / 报告 | 类型 |
|------|------------|------|
| 全新库迁移后恰有 4 租户、8 产品、174 设备、36 属性；升级时复用同名对象不重复 | [`DemoSeedMigrationIT#seedsTheCompleteDemoInventoryOnAFreshDatabase`、`#reusesExistingNamedDemoAssetsDuringUpgrade`](https://github.com/Clarence404/conduit-iot/blob/811e441/conduit-server/src/test/java/dev/conduit/server/tenant/DemoSeedMigrationIT.java) | 集成 |
| 组织种子不覆盖人工归属，不向普通租户灌数据 | [`DemoSeedMigrationIT#organizationSeedPreservesManualAssignmentsAndOrdinaryTenants`](https://github.com/Clarence404/conduit-iot/blob/811e441/conduit-server/src/test/java/dev/conduit/server/tenant/DemoSeedMigrationIT.java) | 集成 |
| 部署包里没有本地配置；全部服务 healthy；174 台设备都有最新值与在线状态 | [demo-release](https://github.com/Clarence404/conduit-iot/blob/811e441/docs/test-reports/2026-10-20-demo-release.md) | 发布烟测 |
| readiness 探针无需登录即可访问 | [`HealthProbeIT`](https://github.com/Clarence404/conduit-iot/blob/811e441/conduit-server/src/test/java/dev/conduit/server/support/HealthProbeIT.java) | 集成 |
| 内部指标端点：没有或错误的令牌被拒，注册表缺失返回 503 | [`InternalMetricsControllerTest#rejectsMissingToken`、`#rejectsWrongToken`、`#returnsServiceUnavailableWhenTheRegistryIsMissing`](https://github.com/Clarence404/conduit-iot/blob/811e441/conduit-server/src/test/java/dev/conduit/server/metrics/InternalMetricsControllerTest.java) | 单元 |
| 连续多次采样投递不变才判停滞；投递有进展不判 | [`SessionMonitorTest#reportsStalledDeliveryAfterEnoughUnchangedSamples`、`#doesNotReportStallWhenDeliveryIsProgressing`](https://github.com/Clarence404/conduit-iot/blob/811e441/conduit-transport/src/test/java/dev/conduit/transport/monitor/SessionMonitorTest.java) | 单元 |
| 堆按实际强杀值的 70% 预警；采样失败保留上次结论；只有批大于窗口才告警 | [`SessionMonitorTest#warnsWhenSessionHeapApproachesTheActualKillThreshold`、`#keepsThePreviousVerdictWhenPollingFails`、`#warnsOnlyWhenBatchSizeExceedsTheInflightWindow`](https://github.com/Clarence404/conduit-iot/blob/811e441/conduit-transport/src/test/java/dev/conduit/transport/monitor/SessionMonitorTest.java) | 单元 |
| 会话监控在真实部署中端到端可用；主实例轮询成功，备实例标示不监控 | [session-wedge-fix-verification](https://github.com/Clarence404/conduit-iot/blob/811e441/docs/test-reports/2026-10-28-session-wedge-fix-verification.md) | 实机验证 |
| 看板 97 条查询逐条有数据；守恒差两版口径的受控实验 | [grafana-dashboard-regroup](https://github.com/Clarence404/conduit-iot/blob/811e441/docs/test-reports/2026-10-29-grafana-dashboard-regroup.md) | 看板校准 |
| 平台首页实时吞吐：没采样是未知而不是零 | [platform-throughput-overview](https://github.com/Clarence404/conduit-iot/blob/811e441/docs/test-reports/2026-10-29-platform-throughput-overview.md)、[`ThroughputSamplerTest`](https://github.com/Clarence404/conduit-iot/blob/811e441/conduit-server/src/test/java/dev/conduit/server/metrics/ThroughputSamplerTest.java) | 单元 |
| 拆分部署端到端可用，容量参数逐项回读 | [split-deployment](https://github.com/Clarence404/conduit-iot/blob/811e441/docs/test-reports/2026-10-30-split-deployment.md) | 部署验证 |
| 五个故障场景（杀 server、杀主 transport、杀全部 transport、重启与强杀 EMQX）不丢数据 | [`ReliabilityE2EIT`](https://github.com/Clarence404/conduit-iot/blob/811e441/conduit-e2e/src/test/java/dev/conduit/e2e/ReliabilityE2EIT.java) | e2e |

---

## 十五、已知限制与还没做的

**现状的限制**：

- **单机 Compose，每个存储都是单实例**。PostgreSQL、Redis、InfluxDB、EMQX 任何一个挂了都是整体不可用；高可用只做到了 transport 一主一备和 server 重启不丢消息
- **部署包里 server 只有一个实例**。物模型缓存是进程内缓存（多实例时修改最多 60 秒后在其他实例生效），遥测重放的任务状态只在单进程内存里
- **没有 CI**。合并前的全量测试靠流程保证。这是评估后的决定：没有团队协作、没有外部使用者消费构建产物时收益有限；约定遇到「本该拦住却没拦住」的情况再重新评估
- **没有告警规则与通知渠道**，见第十一节
- **没有备份自动化与恢复演练**，见第十三节
- **没有 TLS**。部署包只暴露明文的 MQTT 1883 与 HTTP 的 Web，登录 Cookie 默认没有开 `Secure`；公网部署前必须在前面加 TLS 终结
- **Redis 没有口令**，靠端口只绑本机与受信网络
- **看板的整机面板只反映应用主机**，拆分部署时 EMQX 主机的资源要另看
- **仓库默认的容量参数与压测机上测出 11,500 条/秒的那组不同**，按默认值部署复现不出那个数字

**路线图里云原生的部分（V0.8）全部还没开始**：Kubernetes / Helm 部署与无状态服务水平扩展、可水平扩展的消息与时序存储、各存储的备份恢复与灾备演练、OpenTelemetry 与 SLO、TLS / mTLS 与密钥托管。Kubernetes 上怎么部署有状态服务见 [Kubernetes](/cloud-native/6_kubernetes)。

---

## 十六、全系列小结

平台实战这一组目前已完成的九篇，把一个 IoT 平台从设备连上来讲到了部署出去：

| 篇 | 学到的 |
|----|-------|
| [平台实战概览](./0_intro) | 项目定位与版本进度、一条上报的全过程、接入与业务为什么分两个进程 |
| [设备接入与鉴权](./1_access) | topic 与一机一密、Broker 同步回调平台鉴权、ACL、在线状态 |
| [物模型与解码](./2_thing_model) | 用物模型逐测点校验上报，解码器按产品选择，缺测与零值分开 |
| [可靠上报与接入层主备](./3_reliable_uplink) | PUBACK 不等于平台收下了；业务回执、Redis 锁单活多备与共享订阅 |
| [数据流水线](./4_pipeline) | 消息总线、至少一次、退避重试与死信、批处理 |
| [时序存储与历史查询](./5_telemetry) | 宽表建模、最新值、查询时自动聚合、缺测不补零、遥测重放 |
| [多租户与授权](./6_tenant) | 强制过滤、组合外键、范围授权写进 SQL、会话可吊销 |
| [压测与瓶颈排查](./10_capacity) | 计数守恒、瓶颈迁移、先怀疑环境与发压器 |
| 部署与可观测（本篇） | 部署包、迁移与演示数据、看板与会话监控 |

**学完能做什么**：从零搭一个「设备能接、数据不丢、查得出来、租户分得开、压得出数、部署得出去」的 IoT 平台骨架，并且知道每一处取舍的代价。贯穿这九篇的几条做法比代码更值得带走：

- **确认不等于收下，收下不等于入库**。每一跳的确认只对这一跳负责，端到端的保证要自己补
- **失败关闭**。没有租户上下文就不查，没登记的入口就拒绝，配置非法就不启动
- **约定要有东西守**。数据库约束、架构测试、启动检查，比写在文档里的「不要这样做」可靠
- **速率证明不了不丢，计数才行**
- **命令成功不等于生效**，以回读为准
- **没执行的测试不写成通过**，失败和无效的尝试照实留在报告里；被推翻的结论标注作废而不是删掉

**计划中的三项功能**。设备影子、OTA 升级、规则引擎都还没有在 Conduit 里实现，落地后会在本系列补上对应的实现篇（文件编号 7–9 留给它们）。在那之前先读站内的通用设计文章：[设备影子](../3_platform/3_device_shadow)、[OTA 升级](../3_platform/5_ota)、[规则引擎与告警](../3_platform/6_rule_engine)。

**离生产级 SaaS 还差什么**。对照 [roadmap](https://github.com/Clarence404/conduit-iot/blob/811e441/docs/roadmap-saas.md)，当前处在 V0.3 的中段：租户隔离、组织与授权、会话与邀请已做；持久化审计、租户生命周期、计量与配额、资源治理、生产基线、备份恢复实测与告警未做。往后的 V0.4 设备生命周期与控制、V0.5 规则引擎与告警、V0.6 资产与仪表盘、V0.7 开放平台、V0.8 云原生与高可用、V0.9 商业化都还没开始，逐项现状见 [平台实战概览](./0_intro) 的「还没做的」与 [多租户与授权](./6_tenant) 的「已知限制」。

路线图给 V1.0 写的参考容量是「单集群 100 个活跃租户、10 万注册设备、2 万并发连接、持续 5,000 条消息/秒」，并且明确标注这是待验证的目标，不是当前能力；现在的数字离它有多远、是在什么环境下测的，见 [压测与瓶颈排查](./10_capacity)。

---

## 小结

- 三个 Compose 部署包用 `extends` 层层引用，服务定义只写一份；项目名与数据卷相同，同一台宿主机上二选一，切换时数据沿用
- 必填配置在编排里写成 `${VAR:?}`，缺了拒绝启动；口令不进镜像不进包，带口令的配置文件用只读模板在容器启动时渲染
- 编排里的 `stop_grace_period: 20s`、Java 服务的 `mem_limit`、EMQX 的 `nofile`、关闭磁盘持久会话，每一行都对应一次实测或事故
- 拆分部署把 EMQX 单独放一台主机，最容易漏的是 EMQX 主机到应用主机的同步鉴权回调；一台 EMQX 只对应一套环境
- Flyway 迁移只扩展不破坏；演示数据分三层——关系数据进迁移、要账号的走正式 API 的脚本、动态数据由模拟器生成。演示种子目前会进入每一个执行迁移的环境，生产基线还没有剥离
- server 用 readiness 探针；transport 经 EMQX REST API 监控自己的会话，六项判断里只有「投递停滞」把健康检查置为 DOWN，这是唯一能发现「连着但不投递」的信号
- 看板按数据流逐跳排布，总览回答吞吐、有没有丢、余量三个问题；守恒差校准了两版，过程中发现 EMQX 的丢弃计数不含随强杀进程丢失的消息
- 没有告警规则、没有 CI、没有备份自动化、没有 TLS、存储都是单实例；云原生部分整体未开始
- 平台实战目前已完成九篇；设备影子、OTA 升级、规则引擎在计划中，落地后补实现篇

## 参考资料

- Conduit IoT 独立部署包说明：[https://github.com/Clarence404/conduit-iot/blob/811e441/deploy/standalone/README.md](https://github.com/Clarence404/conduit-iot/blob/811e441/deploy/standalone/README.md)
- Conduit IoT 拆分部署说明：[https://github.com/Clarence404/conduit-iot/blob/811e441/deploy/split/README.md](https://github.com/Clarence404/conduit-iot/blob/811e441/deploy/split/README.md)
- Conduit IoT Roadmap：[https://github.com/Clarence404/conduit-iot/blob/811e441/docs/roadmap-saas.md](https://github.com/Clarence404/conduit-iot/blob/811e441/docs/roadmap-saas.md)
- Docker Compose · Extend your Compose file：[https://docs.docker.com/compose/how-tos/multiple-compose-files/extends/](https://docs.docker.com/compose/how-tos/multiple-compose-files/extends/)
- Docker Compose · Using profiles with Compose：[https://docs.docker.com/compose/how-tos/profiles/](https://docs.docker.com/compose/how-tos/profiles/)
- Flyway 文档：[https://documentation.red-gate.com/fd](https://documentation.red-gate.com/fd)
- Spring Boot · Actuator Endpoints（含 Kubernetes Probes）：[https://docs.spring.io/spring-boot/reference/actuator/endpoints.html](https://docs.spring.io/spring-boot/reference/actuator/endpoints.html)
- EMQX 文档 · REST API：[https://docs.emqx.com/zh/emqx/latest/guides/api.html](https://docs.emqx.com/zh/emqx/latest/guides/api.html)
- Grafana · Provisioning：[https://grafana.com/docs/grafana/latest/administration/provisioning/](https://grafana.com/docs/grafana/latest/administration/provisioning/)

> 返回：[IoT 总览](../0_overview)
