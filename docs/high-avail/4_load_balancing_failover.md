# 负载均衡与故障转移

> [!warning] 待补充
> 当前仅保留高可用体系中的负载均衡、故障转移和弹性恢复大纲。

## 学习目标

- 理解负载均衡在高可用架构中的位置
- 掌握故障转移、自动恢复和弹性扩缩容的基本思路
- 能区分服务高可用、数据高可用和基础设施高可用

## 大纲

- 负载均衡：Nginx、LVS、Traefik、F5
- 负载算法：轮询、权重、最少连接、一致性哈希
- 故障转移：主从切换、实例摘除、DNS Failover
- 数据高可用：副本、复制、分片、多活
- 弹性恢复：Kubernetes 自愈、HPA、无状态化设计

## 与其他模块的关系

- API 网关 → [microservices/4_api_gateway](../microservices/4_api_gateway)
- 服务治理 → [microservices/10_service_governance](../microservices/10_service_governance)
- Kubernetes → [cloud-native/5_kubernetes](../cloud-native/5_kubernetes)
