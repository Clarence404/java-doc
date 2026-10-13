---
description: Docker 状态日志与清理、kubectl 上下文、Pod 排查、发布回滚、资源、网络与节点
---

# Docker 与 kubectl 速查

> 前置阅读：[Docker](/cloud-native/5_docker)、[Kubernetes](/cloud-native/6_kubernetes)

容器与 Kubernetes 排障最常用的命令，Docker 部分适用于单机与开发环境，kubectl 部分适用于集群。本篇只列命令，镜像构建、探针与滚动策略见前置阅读，基线为 Kubernetes 1.37。

---

## 一、Docker：容器状态与日志

| 场景 | 命令 | 说明 |
|------|------|------|
| 列出全部容器 | `docker ps -a` | 包括已退出的容器，`STATUS` 中带退出码 |
| 退出原因 | `docker inspect -f '{{.State.Status}} exit={{.State.ExitCode}} oom={{.State.OOMKilled}}' <container>` | 退出码 137 且 `oom=true` 为内存超限被杀 |
| 重启次数 | `docker inspect -f '{{.RestartCount}}' <container>` | 配合 `--restart` 策略判断是否在反复崩溃 |
| 跟随最近日志 | `docker logs -f --tail 200 --since 10m <container>` | 加 `-t` 显示时间戳 |
| 资源用量快照 | `docker stats --no-stream` | CPU、内存与 limit、网络和块 IO |
| 容器内进程 | `docker top <container>` | 不用进入容器 |
| 容器事件 | `docker events --since 30m --filter type=container` | 看 die、oom、restart 等事件 |
| 端口映射 | `docker port <container>` | 核对宿主机端口 |

---

## 二、Docker：进入与调试

| 场景 | 命令 | 说明 |
|------|------|------|
| 进入容器 | `docker exec -it <container> sh` | 镜像有 bash 时可换成 `bash` |
| 以 root 进入 | `docker exec -u 0 -it <container> sh` | 安装排查工具或读受限文件 |
| 容器内执行 jcmd | `docker exec <container> jcmd 1 Thread.print` | Java 进程通常是 PID 1，需要 JDK 镜像 |
| 复制文件出来 | `docker cp <container>:/tmp/heap.hprof ./heap.hprof` | 堆转储、日志等 |
| 共享网络命名空间调试 | `docker run --rm -it --network container:<container> busybox:1.37 sh` | 用调试镜像里的工具访问目标容器的网络 |
| 查看容器网络 | `docker inspect -f '{{json .NetworkSettings.Networks}}' <container>` | IP、网关、所属网络 |
| 查看网络内的容器 | `docker network inspect <network>` | 排查容器间互访不通 |

---

## 三、Docker：镜像与清理

| 场景 | 命令 | 说明 |
|------|------|------|
| 镜像列表与 digest | `docker image ls --digests` | 按 digest 核对部署的是哪个镜像 |
| 镜像分层与大小 | `docker history <image>` | 找出体积大的层 |
| 多架构镜像清单 | `docker buildx imagetools inspect <image>` | 确认镜像是否包含 amd64 / arm64 |
| 构建多架构镜像并推送 | `docker buildx build --platform linux/amd64,linux/arm64 -t <image> --push .` | 需要 buildx 构建器支持多平台 |
| 导出与导入镜像 | `docker save -o app.tar <image>`、`docker load -i app.tar` | 离线环境传输 |
| 磁盘占用 | `docker system df` | 镜像、容器、卷、构建缓存各占多少 |
| 清理悬空镜像与已停止容器 | `docker system prune` | 交互确认；不删除卷 |
| 清理构建缓存 | `docker builder prune` | 构建机磁盘满时常用 |
| 限制日志大小 | `docker run -d --log-opt max-size=100m --log-opt max-file=3 <image>` | 默认 json-file 驱动不限大小，可能写满磁盘 |
| Compose 启动与日志 | `docker compose up -d`、`docker compose logs -f <service>` | 本地联调依赖服务 |

---

## 四、kubectl：上下文与查看

| 场景 | 命令 | 说明 |
|------|------|------|
| 当前上下文 | `kubectl config current-context` | 操作生产前先确认 |
| 切换上下文 | `kubectl config use-context <context>` | 列出全部用 `kubectl config get-contexts` |
| 设置默认命名空间 | `kubectl config set-context --current --namespace=<ns>` | 之后的命令可省略 `-n` |
| Pod 列表与所在节点 | `kubectl get pods -o wide` | IP、节点、重启次数 |
| 非 Running 的 Pod | `kubectl get pods -A --field-selector=status.phase!=Running` | 快速找出异常 Pod |
| 按重启次数排序 | `kubectl get pods --sort-by='.status.containerStatuses[0].restartCount'` | 找反复崩溃的实例 |
| 一次看多种资源 | `kubectl get deploy,rs,svc,hpa` | 发布前后对照 |
| 查看字段含义 | `kubectl explain deployment.spec.strategy` | 写清单时查字段 |

---

## 五、kubectl：Pod 排查

| 场景 | 命令 | 说明 |
|------|------|------|
| 详情与事件 | `kubectl describe pod <pod>` | 先看末尾的 Events 与 `Last State` |
| 某个对象的事件 | `kubectl events --for pod/<pod>` | 按时间排序输出 |
| 命名空间内的警告事件 | `kubectl events --types=Warning` | 调度失败、拉镜像失败、探针失败 |
| 上次退出原因 | `kubectl get pod <pod> -o jsonpath='{.status.containerStatuses[*].lastState.terminated.reason}'` | `OOMKilled`、`Error`、`Completed` |
| 当前日志 | `kubectl logs <pod> -c <container> -f --since=10m` | 多容器 Pod 必须用 `-c` 指定 |
| 崩溃前的日志 | `kubectl logs <pod> --previous` | `CrashLoopBackOff` 时最关键的一步 |
| 按标签聚合日志 | `kubectl logs -l app.kubernetes.io/name=<app> --all-containers --prefix --since=15m` | 每行带 Pod 名前缀 |
| 进入容器 | `kubectl exec -it <pod> -c <container> -- sh` | 镜像没有 shell 时用下一行 |
| 临时调试容器 | `kubectl debug -it <pod> --target=<container> --image=busybox:1.37 -- sh` | 共享目标容器的进程命名空间 |
| 容器内执行 jcmd | `kubectl exec <pod> -- jcmd 1 Thread.print > threads.txt` | 输出直接保存到本地 |
| 复制文件出来 | `kubectl cp <ns>/<pod>:/tmp/heap.hprof ./heap.hprof -c <container>` | 要求容器内有 `tar` |
| 检查调试权限 | `kubectl auth can-i create pods/ephemeralcontainers` | `kubectl debug` 需要该权限 |

---

## 六、kubectl：发布与回滚

| 场景 | 命令 | 说明 |
|------|------|------|
| 应用前看差异 | `kubectl diff -f app.yaml` | 无差异时退出码为 0 |
| 应用清单 | `kubectl apply -f app.yaml` | 声明式更新 |
| 更新镜像 | `kubectl set image deployment/<app> <container>=<image>:<tag>` | 触发滚动更新 |
| 等待发布完成 | `kubectl rollout status deployment/<app> --timeout=5m` | 超时返回非零退出码，适合放进流水线 |
| 发布历史 | `kubectl rollout history deployment/<app>` | 加 `--revision=<n>` 看某个版本的模板 |
| 回滚到上一版 | `kubectl rollout undo deployment/<app>` | 指定版本用 `--to-revision=<n>` |
| 滚动重启 | `kubectl rollout restart deployment/<app>` | 修改环境变量型 ConfigMap 后需要重启 |
| 暂停与恢复发布 | `kubectl rollout pause deployment/<app>`、`kubectl rollout resume deployment/<app>` | 分批验证时使用 |
| 手动扩缩容 | `kubectl scale deployment/<app> --replicas=5` | 由 HPA 管理时会被改回 |
| 删除单个 Pod | `kubectl delete pod <pod>` | 控制器会立即重建，用于摘除个别异常实例 |

---

## 七、kubectl：资源、网络与节点

| 场景 | 命令 | 说明 |
|------|------|------|
| Pod 资源用量 | `kubectl top pod --containers --sort-by=memory` | 依赖 metrics-server |
| 节点资源用量 | `kubectl top node` | 与节点可分配量对照 |
| 节点已分配的 requests / limits | `kubectl describe node <node> \| grep -A 8 'Allocated resources'` | 判断 Pending 是不是资源不足 |
| HPA 状态 | `kubectl get hpa` | 当前与目标指标、副本数 |
| Service 后端是否为空 | `kubectl get endpointslices -l kubernetes.io/service-name=<svc>` | 为空说明选择器与 Pod 标签不匹配或 Pod 未就绪 |
| 本地访问集群内服务 | `kubectl port-forward svc/<svc> 8080:80` | 绕过网关直接验证服务 |
| 集群内 DNS 解析 | `kubectl run dns-test --rm -it --restart=Never --image=busybox:1.37 -- nslookup <svc>.<ns>.svc.cluster.local` | 用完自动删除 |
| 集群内请求接口 | `kubectl run curl-test --rm -it --restart=Never --image=curlimages/curl:8.16.0 -- curl -sv http://<svc>.<ns>:80/actuator/health` | 区分网络问题与应用问题 |
| 节点停止调度 | `kubectl cordon <node>` | 恢复用 `kubectl uncordon <node>` |
| 驱逐节点上的 Pod | `kubectl drain <node> --ignore-daemonsets --delete-emptydir-data` | 维护节点前执行，受 PDB 约束 |
| 登录节点调试 | `kubectl debug node/<node> -it --image=busybox:1.37` | 节点根文件系统挂载在 `/host` |

---

## 小结

最该记住的 5 条：

- `kubectl describe pod <pod>`：Events 和 `Last State` 能回答大部分「为什么起不来」
- `kubectl logs <pod> --previous`：看崩溃前最后的日志
- `kubectl rollout undo deployment/<app>`：发布出问题时先回滚再排查
- `kubectl get endpointslices -l kubernetes.io/service-name=<svc>`：Service 不通时先看后端列表
- `docker inspect -f '{{.State.ExitCode}} {{.State.OOMKilled}}' <container>`：区分应用异常退出与内存超限

## 参考资料

- Docker CLI 参考：[Docker CLI reference](https://docs.docker.com/reference/cli/docker/)
- 格式化输出：[Format command and log output](https://docs.docker.com/engine/cli/formatting/)
- json-file 日志驱动：[JSON File logging driver](https://docs.docker.com/engine/logging/drivers/json-file/)
- 清理资源：[Prune unused Docker objects](https://docs.docker.com/engine/manage-resources/pruning/)
- kubectl 速查：[kubectl Quick Reference](https://kubernetes.io/docs/reference/kubectl/quick-reference/)
- kubectl 命令参考：[kubectl reference](https://kubernetes.io/docs/reference/kubectl/generated/)
- 调试运行中的 Pod：[Debug Running Pods](https://kubernetes.io/docs/tasks/debug/debug-application/debug-running-pod/)
- 调试节点：[Debugging Kubernetes Nodes With Kubectl](https://kubernetes.io/docs/tasks/debug/debug-cluster/kubectl-node-debug/)
- 安全地排空节点：[Safely Drain a Node](https://kubernetes.io/docs/tasks/administer-cluster/safely-drain-node/)

> 下一篇：[Arthas 速查](./3_arthas)
