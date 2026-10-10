---
description: 镜像分层、Dockerfile 与 BuildKit、Java 多阶段镜像、网络、数据卷、Compose v2、镜像加速
---

# Docker

> 前置阅读：[Linux 概览](./1_linux)、[虚拟化概览](./3_virtual)

Docker 把「应用 + 依赖 + 运行环境」打包成镜像，容器则是被 Namespace 隔离视图、被 cgroup 限制资源的普通进程，共享宿主机内核，启动秒级、开销接近原生进程。本篇讲镜像分层、Java 多阶段 Dockerfile、Compose v2 本地多服务环境，以及镜像加速、代理与私有仓库。

---

## 一、核心概念与架构

| 概念 | 说明 |
|------|------|
| **镜像（Image）** | 只读模板，由多层文件系统叠加而成，用 `仓库名:标签` 或 `@sha256:摘要` 引用 |
| **容器（Container）** | 镜像的运行实例：镜像只读层 + 一层可写层 + 隔离的进程 |
| **仓库（Registry）** | 存放和分发镜像的服务，如 Docker Hub、Harbor、各云厂商的镜像仓库 |
| **Dockerfile** | 描述如何一步步构建镜像的脚本 |
| **数据卷（Volume）** | 独立于容器生命周期的持久化存储 |

**组件链路**：`docker` CLI → `dockerd`（Docker Engine，提供 API、构建、网络、卷）→ `containerd`（管理镜像与容器生命周期）→ `runc`（按 OCI 运行时规范创建 Namespace / cgroup 并启动进程）。

- **OCI 标准**：镜像格式和运行时都有开放规范，所以 Docker 构建的镜像可以直接在 containerd、CRI-O、Podman 上运行
- **与 Kubernetes 的关系**：Kubernetes 1.24 起移除 dockershim，节点直接通过 CRI 调用 containerd / CRI-O，不再需要 Docker Engine；但开发者依旧用 Docker 构建镜像，镜像本身完全通用，详见 [Kubernetes](./6_kubernetes)
- **Engine 29 起**：全新安装默认使用 containerd 镜像存储（原生支持多架构镜像、镜像索引和证明），升级安装保持原有的 overlay2 存储驱动

---

## 二、镜像分层

![镜像分层与容器可写层](../assets/cloud-native/docker-image-layers.svg)

Dockerfile 里每条改动文件系统的指令（`RUN`、`COPY`、`ADD`）产生一层。运行时用联合文件系统（overlay2）把这些只读层叠成一个统一视图，再在最上面加一层容器独占的可写层：

- **写时复制（CoW）**：容器修改下层文件时，先把文件复制到可写层再改，镜像层本身永远不变
- **层共享**：多个容器、多个镜像共用相同的层，磁盘和拉取流量只付一次
- **可写层随容器删除**：需要保留的数据必须放数据卷，不要写进容器文件系统
- **删除不会变小**：在后面的层里删除前面层的文件只是加一个「删除标记」，镜像体积不减；要在同一条 `RUN` 里下载、使用并清理

**构建缓存规则**：某一层的指令和输入（`COPY` 的文件内容）没变就复用缓存；一旦某层失效，它之后的所有层都要重建。所以**变化少的放前面，变化多的放后面**——先复制依赖描述文件、下载依赖，再复制源码。

---

## 三、常用命令

### 1、镜像

```bash
docker image ls                       # 本地镜像
docker pull nginx:1.28                # 拉取，生产环境不要用 latest
docker tag nginx:1.28 registry.example.com/base/nginx:1.28
docker login registry.example.com
docker push registry.example.com/base/nginx:1.28
docker image inspect nginx:1.28       # 层、环境变量、入口命令
docker history nginx:1.28             # 每层由哪条指令产生、多大
docker rmi nginx:1.28

# 离线环境：在能联网的机器导出，拷贝后导入
docker save -o nginx-1.28.tar nginx:1.28
docker load -i nginx-1.28.tar
```

### 2、容器

```bash
docker run -d --name web -p 8080:80 --restart unless-stopped \
  --memory 512m --cpus 1 nginx:1.28   # 后台运行，并限制内存与 CPU
docker run -it --rm ubuntu:24.04 bash # 交互式临时容器，退出即删除

docker ps                             # 运行中的容器；-a 包含已停止的
docker logs -f --tail 100 web         # 跟随日志
docker exec -it web sh                # 进入容器（Alpine 等精简镜像没有 bash）
docker inspect web                    # IP、挂载、重启策略等完整信息
docker stats                          # 实时 CPU / 内存 / IO
docker cp web:/etc/nginx/nginx.conf . # 容器与宿主机之间拷文件
docker stop web                       # 先发 SIGTERM，默认 10 秒后 SIGKILL
docker rm web
```

`docker run` 常用参数：

| 参数 | 作用 |
|------|------|
| `-d` / `--rm` | 后台运行 / 退出后自动删除 |
| `-p 宿主机端口:容器端口` | 端口映射，`-p 127.0.0.1:8080:80` 只监听本机 |
| `-e KEY=VALUE` / `--env-file` | 环境变量 |
| `-v 卷名或路径:容器路径` | 挂载数据卷或宿主机目录 |
| `--network` | 指定网络 |
| `--restart` | 重启策略：`no` / `on-failure` / `always` / `unless-stopped` |
| `--memory` / `--cpus` | 资源限制，超过内存限制的进程会被内核 OOM Kill |

### 3、清理

```bash
docker system df                      # 镜像、容器、卷、构建缓存各占多少空间
docker image prune                    # 删除悬空镜像（无标签的中间产物）
docker builder prune                  # 清理构建缓存
docker system prune                   # 删除已停止容器、未使用网络、悬空镜像
```

> [!warning]
> `docker system prune -a --volumes` 会删除所有未被容器使用的镜像和数据卷，生产机器上执行前务必确认卷里没有要保留的数据。

---

## 四、Dockerfile 与 BuildKit

### 1、常用指令

| 指令 | 作用 | 注意 |
|------|------|------|
| `FROM` | 基础镜像，可多次出现（多阶段） | 固定到具体版本标签，追求可复现时用摘要 |
| `WORKDIR` | 设置工作目录 | 不要用 `RUN cd` |
| `COPY` | 复制构建上下文中的文件 | 优先于 `ADD`，`ADD` 只在需要解压本地 tar 或下载远程文件时用 |
| `RUN` | 执行命令并生成新层 | 相关命令用 `&&` 合并，同一层里清理临时文件 |
| `ENV` / `ARG` | 运行期环境变量 / 构建期参数 | 不要用它们传密码，会留在镜像历史中 |
| `EXPOSE` | 声明端口 | 仅文档作用，真正对外暴露靠 `-p` |
| `USER` | 后续指令和运行时使用的用户 | 运行阶段切到非 root |
| `ENTRYPOINT` / `CMD` | 启动命令 / 默认参数 | 用 exec 形式（JSON 数组），见下文 |

**exec 形式与信号**：`ENTRYPOINT ["java", "-jar", "app.jar"]` 让 java 成为容器内的 1 号进程，能直接收到 `docker stop` 发出的 SIGTERM 并优雅退出；shell 形式 `ENTRYPOINT java -jar app.jar` 由 `/bin/sh -c` 启动，信号不会转发给 java，最终被 SIGKILL 强杀。停机流程与 Kubernetes 配合见 [优雅上下线与变更](/high-avail/8_graceful_release)。

**`.dockerignore`**：构建时整个上下文目录都会发给构建器，`COPY . .` 还会让无关文件变化导致缓存失效。至少排除这些：

```text
target/
build/
.git/
.idea/
*.iml
*.log
```

### 2、BuildKit

Docker Engine 23.0 起 BuildKit 是默认构建器，`docker build` 实际调用的就是 `docker buildx build`。它带来的能力：

- **并行与按需构建**：多阶段中互不依赖的阶段并行执行，最终镜像用不到的阶段直接跳过
- **缓存挂载**：`RUN --mount=type=cache,target=/root/.m2` 把 Maven 本地仓库挂成持久缓存，依赖不进镜像层，下次构建也不用重新下载
- **Secret 挂载**：`RUN --mount=type=secret,id=npmrc,target=/root/.npmrc npm ci` 配合 `docker build --secret id=npmrc,src=$HOME/.npmrc .`，凭据只在这一步可见，不留在任何层里
- **多架构构建**：一次构建同时产出 amd64 与 arm64 镜像

```bash
# 使用 docker-container 驱动的构建器（containerd 镜像存储下默认驱动也支持多平台）
docker buildx create --name multi --driver docker-container --use
docker buildx build --platform linux/amd64,linux/arm64 \
  -t registry.example.com/demo/app:1.0.0 --push .
```

Dockerfile 第一行写 `# syntax=docker/dockerfile:1`，构建器会使用最新的 1.x 版 Dockerfile 语法前端，确保 `--mount` 等语法可用。

---

## 五、Java 镜像实践

![Java 镜像多阶段构建与交付](../assets/cloud-native/docker-java-multistage.svg)

### 1、多阶段 Dockerfile

构建阶段用带 Maven 和 JDK 的镜像编译打包，运行阶段只放 JRE 和解压后的分层产物。Spring Boot 3.3+ 的 `tools` jarmode 把 fat jar 按变化频率解压成 `dependencies`、`spring-boot-loader`、`snapshot-dependencies`、`application` 四个目录，分别 `COPY` 成四层，日常发版只有最上面的 `application` 层变化：

```dockerfile
# syntax=docker/dockerfile:1

FROM maven:3.9-eclipse-temurin-25 AS build
WORKDIR /src
COPY pom.xml .
RUN --mount=type=cache,target=/root/.m2 mvn -B dependency:go-offline
COPY src ./src
RUN --mount=type=cache,target=/root/.m2 mvn -B package -DskipTests \
    && cp target/*.jar application.jar \
    && java -Djarmode=tools -jar application.jar extract --layers --destination extracted

FROM eclipse-temurin:25-jre
RUN groupadd --system app && useradd --system --gid app --no-create-home app
WORKDIR /app
COPY --from=build /src/extracted/dependencies/ ./
COPY --from=build /src/extracted/spring-boot-loader/ ./
COPY --from=build /src/extracted/snapshot-dependencies/ ./
COPY --from=build /src/extracted/application/ ./
USER app
EXPOSE 8080
ENTRYPOINT ["java", "-XX:MaxRAMPercentage=75", "-jar", "application.jar"]
```

```bash
docker build -t demo-app:1.0.0 .
docker run -d --name demo -p 8080:8080 --memory 1g demo-app:1.0.0
```

要点：

- **最终镜像不含 JDK、Maven 和源码**：体积小，攻击面也小
- **非 root 运行**：容器逃逸时影响更小，Kubernetes 的 `runAsNonRoot` 策略也要求这一点
- **`-jar application.jar` 启动的是解压后的瘦 JAR**：它只包含应用代码，依赖通过 classpath 引用旁边的 `lib/` 目录；这种布局同时适合做 CDS / AOT 缓存，见 [启动优化](/spring-boot/14_startup)
- **容器感知**：JDK 10 起 JVM 默认按 cgroup 限制计算堆大小和 CPU 数，用 `-XX:MaxRAMPercentage` 按比例设堆，不要写死 `-Xmx`；比例取多少、堆外内存怎么核算见 [GC 调优](/jvm/6_gc_tuning) 与 [JVM 层性能策略](/high-perf/5_jvm_tuning)
- **JVM 参数可外置**：运行时用 `-e JAVA_TOOL_OPTIONS="-XX:MaxRAMPercentage=70"` 覆盖，JVM 启动时会自动读取这个环境变量

> [!tip]
> 不想维护 Dockerfile 时有两个选择：`mvn spring-boot:build-image` 用 Paketo Buildpacks 直接生成分层镜像（需要本机 Docker），Jib（`mvn compile jib:build`）不依赖 Docker 守护进程就能构建并推送镜像。Buildpacks 的启动优化参数见 [启动优化](/spring-boot/14_startup)。

### 2、基础镜像怎么选

| 类型 | 示例 | 适用 |
|------|------|------|
| 完整 JRE（Ubuntu） | `eclipse-temurin:25-jre` | 默认选择，自带 shell 方便排查 |
| Alpine（musl） | `eclipse-temurin:25-jre-alpine` | 体积更小，注意 musl 与 glibc 的兼容差异 |
| Distroless | `gcr.io/distroless/java25-debian13` | 无 shell、无包管理器，攻击面最小，排查要靠临时调试容器 |

---

## 六、网络

![Docker 四种网络模式](../assets/cloud-native/docker-network-modes.svg)

| 模式 | 说明 | 典型用途 |
|------|------|----------|
| **bridge** | 默认模式。容器通过 veth 接到 `docker0` 网桥，拥有独立 IP，出网经 NAT，入站靠 `-p` 端口映射 | 单机运行大多数服务 |
| **host** | 容器共享宿主机的网络命名空间，没有独立 IP，直接使用宿主机的 IP 和端口，`-p` 被忽略 | 对网络性能极敏感、需要大量端口的场景 |
| **none** | 只有回环网卡，完全不联网 | 离线计算任务 |
| **container:&lt;名称&gt;** | 加入另一个容器的网络命名空间，两者同 IP、通过 localhost 互访 | 调试工具挂到目标容器旁；Kubernetes Pod 就是这个模型 |
| **overlay** | 跨主机的虚拟二层网络（VXLAN） | Docker Swarm 集群 |
| **macvlan** | 容器在物理网络中拥有独立 MAC 和 IP，像一台独立设备 | 需要直接出现在局域网中的遗留应用 |

> [!warning]
> Docker Desktop（Windows / macOS）上容器跑在一台轻量虚拟机里，host 模式要 Docker Desktop 4.34 及以上，并在 Settings → Resources → Network 中手动开启，且只支持 Linux 容器。

### 1、自定义 bridge 网络

默认的 `docker0` 网络里容器只能用 IP 互访，**不能用容器名**；自定义 bridge 网络内置 DNS，容器名就是主机名，还能按网络隔离不同应用。实际使用中应该总是创建自定义网络（Compose 会自动为每个项目创建一个）：

```bash
docker network create app-net
docker run -d --name redis --network app-net redis:8-alpine
docker run --rm --network app-net redis:8-alpine redis-cli -h redis ping   # 输出 PONG

docker network ls
docker network inspect app-net        # 查看网段和接入的容器
docker network connect app-net web    # 运行中的容器加入另一个网络
docker network rm app-net
```

### 2、container 模式示例

`--network container:<名称>` 是正式支持的模式（已废弃的是旧的 `--link` 参数）。常用来把带调试工具的容器挂到目标容器的网络里：

```bash
docker run -d --name web nginx:1.28
docker run --rm --network container:web busybox wget -qO- http://localhost
```

---

## 七、数据持久化

| 类型 | 写法 | 特点 |
|------|------|------|
| **命名卷（Volume）** | `-v mysql-data:/var/lib/mysql` | 由 Docker 管理（`/var/lib/docker/volumes/`），可跨容器共享，生产数据首选 |
| **绑定挂载（Bind mount）** | `-v ./conf/nginx.conf:/etc/nginx/nginx.conf:ro` | 直接映射宿主机路径，适合配置文件和开发时挂源码 |
| **tmpfs** | `--tmpfs /tmp` | 只存在内存中，容器停止即消失，适合临时敏感数据 |

```bash
docker volume create mysql-data
docker volume ls
docker volume inspect mysql-data
docker volume rm mysql-data
```

绑定挂载时注意文件属主：容器内以非 root 用户运行时，宿主机目录需要对该 UID 可写，否则会出现 `Permission denied`。

---

## 八、Docker Compose

Compose 用一个 YAML 文件声明多个服务、网络和数据卷，一条命令拉起整套环境，适合本地开发、集成测试和单机部署。

- **用 v2**：Compose v2 是 Docker CLI 插件，命令是 `docker compose`（空格）；Python 版 `docker-compose` v1 已于 2023 年 7 月停止维护
- **安装**：Docker Desktop 自带；Linux 上配置好 Docker 官方软件源后安装插件，`apt-get install docker-compose-plugin`（Debian / Ubuntu）或 `dnf install docker-compose-plugin`（RHEL 系），用 `docker compose version` 验证
- **文件**：默认文件名 `compose.yaml`（仍兼容 `docker-compose.yml`）；顶层 `version:` 字段已废弃，写了只会得到警告

### 1、示例：Spring Boot + MySQL + Redis

```yaml
services:
  app:
    build: .
    image: demo-app:1.0.0
    ports:
      - "8080:8080"
    environment:
      SPRING_DATASOURCE_URL: jdbc:mysql://mysql:3306/demo
      SPRING_DATASOURCE_USERNAME: demo
      SPRING_DATASOURCE_PASSWORD: ${MYSQL_PASSWORD}
      SPRING_DATA_REDIS_HOST: redis
      JAVA_TOOL_OPTIONS: -XX:MaxRAMPercentage=70
    depends_on:
      mysql:
        condition: service_healthy
      redis:
        condition: service_started
    restart: unless-stopped

  mysql:
    image: mysql:8.4
    environment:
      MYSQL_DATABASE: demo
      MYSQL_USER: demo
      MYSQL_PASSWORD: ${MYSQL_PASSWORD}
      MYSQL_ROOT_PASSWORD: ${MYSQL_ROOT_PASSWORD}
    volumes:
      - mysql-data:/var/lib/mysql
    healthcheck:
      test: ["CMD", "mysqladmin", "ping", "-h", "127.0.0.1"]
      interval: 5s
      timeout: 3s
      retries: 20
      start_period: 30s

  redis:
    image: redis:8-alpine

volumes:
  mysql-data:
```

同目录下的 `.env` 文件会被自动读取，用来替换 `${...}` 变量（该文件不要提交到 Git）：

```text
MYSQL_PASSWORD=change-me
MYSQL_ROOT_PASSWORD=change-me-too
```

- **服务名即主机名**：Compose 为项目创建一个自定义 bridge 网络，`app` 里直接用 `mysql:3306`、`redis` 访问
- **`depends_on` 默认只保证启动顺序**：加上 `condition: service_healthy` 才会等 MySQL 健康检查通过后再启动 `app`
- **环境变量覆盖配置**：Spring Boot 的宽松绑定把 `SPRING_DATASOURCE_URL` 映射到 `spring.datasource.url`

### 2、常用命令

| 命令 | 说明 |
|------|------|
| `docker compose up -d` | 后台启动所有服务；本地没有的镜像才会构建 |
| `docker compose up -d --build` | 强制重新构建镜像再启动 |
| `docker compose up -d app` | 只启动指定服务（及其依赖） |
| `docker compose ps` | 服务状态 |
| `docker compose logs -f app` | 跟随某个服务的日志 |
| `docker compose exec redis sh` | 进入服务容器 |
| `docker compose down` | 停止并删除容器和网络，保留数据卷 |
| `docker compose down -v` | 连同命名卷一起删除 |
| `docker compose config` | 输出变量替换、文件合并后的最终配置，排错必备 |
| `docker compose -f compose.yaml -f compose.prod.yaml up -d` | 多文件合并，后面的覆盖前面的 |

**适用边界**：Compose 适合单机；需要多副本、滚动发布、自愈和跨主机调度时用 [Kubernetes](./6_kubernetes)。集成测试中按需拉起依赖更推荐 [Testcontainers](/testing/5_testcontainers)，流水线中的镜像构建与推送见 [CI/CD](/devops/2_ci_cd)。

---

## 九、镜像加速、代理与私有仓库

拉取 Docker Hub 镜像慢或失败时，按网络环境选择下面的做法。以下配置均来自 Docker 官方文档，修改 `/etc/docker/daemon.json` 后都需要执行 `sudo systemctl restart docker`。

### 1、Registry Mirror

```json
{
  "registry-mirrors": ["https://mirror.example.com"]
}
```

- 只对 **Docker Hub** 镜像生效，无法为其他仓库（如 `ghcr.io`、私有仓库）配置镜像
- 地址填所在单位或云厂商提供的镜像加速服务，也可以用 Harbor 的代理缓存项目自建
- 生效后用 `docker info` 查看 `Registry Mirrors` 一项确认

### 2、为 Docker 守护进程配置代理

镜像是 `dockerd` 拉取的，不是 CLI，所以在终端里 `export HTTP_PROXY` 对 `docker pull` 无效，要给守护进程配置代理。两种方式任选其一：

**方式一：`daemon.json`**

```json
{
  "proxies": {
    "http-proxy": "http://proxy.example.com:3128",
    "https-proxy": "http://proxy.example.com:3128",
    "no-proxy": "localhost,127.0.0.1,registry.example.com"
  }
}
```

**方式二：systemd drop-in**，新建 `/etc/systemd/system/docker.service.d/http-proxy.conf`：

```ini
[Service]
Environment="HTTP_PROXY=http://proxy.example.com:3128"
Environment="HTTPS_PROXY=http://proxy.example.com:3128"
Environment="NO_PROXY=localhost,127.0.0.1,registry.example.com"
```

```bash
sudo systemctl daemon-reload
sudo systemctl restart docker
```

> [!tip]
> - 守护进程的代理只影响拉取和推送镜像。构建过程中 `RUN` 访问外网、容器运行时访问外网，需要在 `~/.docker/config.json` 中配置客户端代理（见下），CLI 会自动把它注入到构建和新建的容器中
> - Docker Desktop 会忽略 `daemon.json` 里的代理配置，在 Settings → Resources → Proxies 中设置
> - 虚拟机中的 Docker 使用宿主机上的代理时，代理地址要填虚拟机能访问到的宿主机 IP（如 NAT 网关地址），而且宿主机上的代理程序要允许局域网连接

客户端代理配置 `~/.docker/config.json`：

```json
{
  "proxies": {
    "default": {
      "httpProxy": "http://proxy.example.com:3128",
      "httpsProxy": "http://proxy.example.com:3128",
      "noProxy": "localhost,127.0.0.1"
    }
  }
}
```

### 3、私有仓库与离线环境

- **Harbor**：CNCF 毕业项目，提供项目级权限、漏洞扫描、镜像签名、复制和对 Docker Hub 的代理缓存，是企业私有仓库的常用选择；制品版本与保留策略见 [制品与版本管理](/devops/6_artifact_version)
- **完全离线**：在能联网的机器上 `docker save`，拷贝后 `docker load`（见第三节），或把镜像推送到内网 Harbor 后统一分发

---

## 十、镜像安全

- **最小化**：多阶段构建，运行镜像只放 JRE 和应用；能用 Distroless 就不带 shell
- **非 root**：Dockerfile 里 `USER` 切换，配合 Kubernetes 的 `runAsNonRoot`、只读根文件系统
- **固定版本**：基础镜像用具体标签，发布按摘要（`@sha256:...`）部署，杜绝「同一个标签内容变了」
- **不放密钥**：密码、令牌不写进 `ENV` / `ARG` / 镜像文件，构建期用 `--mount=type=secret`，运行期由编排平台注入
- **扫描与 SBOM**：CI 中扫描镜像漏洞（如 `docker scout cves demo-app:1.0.0`、Trivy），`docker buildx build --sbom=true --provenance=mode=max --push` 随镜像生成 SBOM 与构建来源证明
- **签名**：用 Sigstore cosign 对镜像摘要签名，集群准入时验签；漏洞防护的整体思路见 [常见漏洞与防护](/security/8_vulnerabilities)

---

## 小结

- 容器是被 Namespace 隔离、被 cgroup 限制的宿主机进程；链路是 CLI → dockerd → containerd → runc，镜像遵循 OCI 标准，Kubernetes 不依赖 Docker 也能运行它
- 镜像由只读层叠加，容器多一层可写层（写时复制）；缓存从第一个失效层起全部重建，所以变化少的指令放前面
- BuildKit 是默认构建器：缓存挂载加速依赖下载，secret 挂载不留凭据，buildx 一次产出多架构镜像
- Java 镜像：多阶段构建 + `tools` jarmode 分层 + JRE 基础镜像 + 非 root + exec 形式 ENTRYPOINT + `MaxRAMPercentage`
- 网络总是用自定义 bridge（内置容器名 DNS）；host 模式没有独立 IP、`-p` 无效；container 模式共享网络命名空间，是 Pod 的原型
- 持久数据放命名卷；Compose 用 v2 的 `docker compose` 和不带 `version:` 的 `compose.yaml`，`depends_on` 配合健康检查才能等依赖就绪
- 拉取问题按官方方式处理：`registry-mirrors` 只加速 Docker Hub，代理要配给守护进程（拉取）和客户端（构建与运行），企业环境用 Harbor

## 参考资料

- Docker 官方文档：[Docker Docs](https://docs.docker.com/)
- 镜像分层与存储驱动：[Storage drivers](https://docs.docker.com/engine/storage/drivers/)、[containerd image store](https://docs.docker.com/engine/storage/containerd/)
- Dockerfile 与构建：[Dockerfile reference](https://docs.docker.com/reference/dockerfile/)、[Building best practices](https://docs.docker.com/build/building/best-practices/)、[Multi-stage builds](https://docs.docker.com/build/building/multi-stage/)、[BuildKit](https://docs.docker.com/build/buildkit/)
- 网络：[Networking overview](https://docs.docker.com/engine/network/)、[Host network driver](https://docs.docker.com/engine/network/drivers/host/)
- Compose：[Docker Compose](https://docs.docker.com/compose/)、[Compose Specification](https://compose-spec.io/)
- 镜像加速与代理：[Registry mirror](https://docs.docker.com/docker-hub/image-library/mirror/)、[Daemon proxy configuration](https://docs.docker.com/engine/daemon/proxy/)、[CLI proxy configuration](https://docs.docker.com/engine/cli/proxy/)
- Spring Boot 容器镜像：[Dockerfiles](https://docs.spring.io/spring-boot/reference/packaging/container-images/dockerfiles.html)
- OCI 规范：[Open Container Initiative](https://opencontainers.org/)

> 下一篇：[Kubernetes](./6_kubernetes)
