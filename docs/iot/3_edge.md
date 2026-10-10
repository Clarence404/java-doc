---
description: 云边分工、EdgeX Foundry 部署、KubeEdge 云边协同与设备管理、ONNX Runtime 边缘推理
---

# 边缘计算

> 前置阅读：[平台选型](./2_platform)、[Kubernetes](/cloud-native/6_kubernetes)

边缘计算把部分计算和决策放到靠近设备的位置完成。本篇讲云边分工、EdgeX Foundry、KubeEdge 云边协同、ONNX Runtime 边缘推理。

---

## 一、边缘计算是什么

版本：EdgeX Foundry 4.0（REST API v3）搭边缘采集栈、KubeEdge 1.23 做云边协同、ONNX Runtime 1.31 在 Java 里做边缘推理与模型更新。

**边缘计算（Edge Computing）**：在靠近数据产生端的位置（设备、网关、厂区或门店的本地服务器）完成计算和决策，而不是把所有原始数据都送到云端处理。

| 问题 | 全部在云端处理 | 在边缘处理 |
|------|---------------|-----------|
| 实时性 | 多一次网络往返，延迟不稳定 | 本地决策，延迟低且稳定 |
| 带宽 | 原始数据全部上传，带宽和流量成本高 | 本地过滤、降采样，只上传关键数据 |
| 可靠性 | 网络中断后现场失控 | 断网时本地仍可运行 |
| 数据合规 | 原始数据离开现场 | 敏感数据可以只留在本地 |

典型场景：

- **工厂车间**：边缘网关采集 PLC 数据，本地实时判断设备告警，云端做历史分析和跨厂对比
- **视频监控**：摄像头接入边缘节点，本地 AI 检测异常，只上传告警片段
- **能源管理**：电表数据在边缘聚合，按分钟或小时上报，减少上云频率
- **零售门店**：门店本地服务器处理收银和库存，断网仍能正常营业

---

## 二、云边端三层架构

![云边端三层架构](../assets/iot/edge-three-layers.svg)

分工的基本原则：需要毫秒级响应、断网也必须工作的逻辑（本地告警、联动控制）放在边缘；需要全局数据、算力或长期存储的工作（模型训练、跨站点分析、设备管理）放在云端。边缘只做必要的事，规则和模型由云端统一下发。

---

## 三、边缘核心能力

| 能力 | 说明 |
|------|------|
| **协议转换** | 把 Modbus、OPC UA、Zigbee 等现场协议统一转成 MQTT 向上对接，协议细节见 [通信协议](./1_protocol) |
| **本地规则引擎** | 在本地执行告警、联动规则，不依赖云端 |
| **数据过滤与聚合** | 对高频原始数据降采样、去噪，减少上云流量 |
| **断网续传** | 云端连接中断时本地缓存数据，恢复后按时间顺序补传 |
| **AI 推理** | 在边缘运行轻量模型，如设备异常检测、视觉质检 |
| **远程运维** | 应用、配置、模型由云端统一下发和升级 |

---

## 四、主流边缘框架

### 1、EdgeX Foundry

- **定位**：LF Edge（Linux 基金会旗下）的开源边缘框架，面向工业 IoT 的数据采集与转发
- **技术栈**：Go 实现的微服务，Docker 部署，服务之间通过消息总线和 REST API v3 通信
- **架构**：南向 Device Service 负责对接设备协议（Modbus、OPC UA、MQTT、BACnet 等），Core Services 负责数据和元数据，北向 Application Service 负责把数据导出到 MQTT、Kafka、HTTP；规则引擎是可选的 LF Edge eKuiper
- **特点**：各服务职责单一，可按需裁剪

### 2、KubeEdge

- **定位**：把 Kubernetes 延伸到边缘节点，2024 年 10 月从 CNCF 毕业
- **适合**：已有 Kubernetes 集群，希望用同一套方式管理云端和边缘应用的团队
- **核心能力**：边缘节点断网自治、云边可靠消息同步、设备管理（DeviceModel / Device CRD 与 Mapper）

### 3、OpenYurt

- **定位**：阿里云开源的云原生边缘计算项目，以非侵入方式把原生 Kubernetes 扩展到边缘
- **特点**：边缘节点自治、节点池（NodePool）按地域分组管理

### 4、其他选择

- **NanoMQ + Neuron**：EMQ 的边缘组合，NanoMQ 是轻量 MQTT Broker，Neuron 负责工业协议采集，适合网关级设备
- **AWS IoT Greengrass、Azure IoT Edge**：云厂商的边缘运行时，与各自云平台深度集成

### 5、框架对比

| 框架 | 适合场景 | 技术门槛 |
|------|---------|---------|
| EdgeX Foundry | 工业协议采集与转发网关 | 中 |
| KubeEdge | 已有 K8s，云边统一编排 | 高 |
| OpenYurt | 已有 K8s，偏节点池化管理 | 高 |
| NanoMQ + Neuron | 资源受限的网关设备 | 低 |
| Greengrass / Azure IoT Edge | 已深度使用对应云平台 | 中 |

选型主要看两点：边缘节点的资源（能否跑容器和 Kubernetes 节点组件），以及团队是否已经用 Kubernetes 管理应用。

---

## 五、EdgeX Foundry 部署

### 1、用 Docker Compose 启动

`edgex-compose` 仓库按版本提供 Compose 文件。默认的 Compose 文件启用安全模式（API 网关 + 密钥存储），此时直接调用各服务的 REST 端口会返回 401，需要先获取 JWT。本地体验用非安全模式：

```bash
# 下载 4.0 的非安全模式 Compose 文件（ARM 设备用 docker-compose-no-secty-arm64.yml）
curl https://raw.githubusercontent.com/edgexfoundry/edgex-compose/v4.0/docker-compose-no-secty.yml -o docker-compose.yml
docker compose up -d
docker compose ps
```

主要服务：

| 服务 | 职责 |
|------|------|
| `core-data` | 接收并持久化设备上报的事件和读数（Event / Reading），端口 59880 |
| `core-metadata` | 管理设备、设备配置文件（Device Profile）等元数据 |
| `core-command` | 向设备下发读写指令 |
| `device-virtual` | 模拟设备，开发阶段不需要真实硬件 |
| `app-service-configurable` | 北向数据导出，可推送到 MQTT、Kafka、HTTP |

生产环境必须使用安全模式，并把各服务的端口限制在本机或内网。

### 2、用 REST API 查询读数

```bash
# 最近 20 条读数
curl -s "http://localhost:59880/api/v3/reading/all?limit=20"

# 按设备名称过滤
curl -s "http://localhost:59880/api/v3/reading/device/name/Random-Integer-Device?limit=5"

# 按设备查询事件（一个事件包含该次采集的多条读数）
curl -s "http://localhost:59880/api/v3/event/device/name/Random-Integer-Device"
```

典型响应结构（`origin` 为纳秒时间戳）：

```json
{
  "apiVersion": "v3",
  "statusCode": 200,
  "totalCount": 100,
  "readings": [
    {
      "id": "a1b2c3d4-...",
      "deviceName": "Random-Integer-Device",
      "resourceName": "Int32",
      "value": "4217",
      "valueType": "Int32",
      "origin": 1720000000000000000
    }
  ]
}
```

### 3、南向 Device Service 与北向导出

Device Service 是 EdgeX 的南向驱动层，每种协议对应一个独立的微服务（如 `device-modbus`、`device-mqtt`），按 Device Profile 描述的资源去读写设备，采集结果发布到消息总线，由 `core-data` 持久化。

北向导出由 `app-service-configurable` 完成：选择一个导出配置（如 `mqtt-export`），通过环境变量覆盖 Pipeline 参数即可。下面是导出到 MQTT Broker 的关键配置：

```yaml
# app-service-configurable 的环境变量（导出到 MQTT）
environment:
  WRITABLE_PIPELINE_FUNCTIONS_MQTTEXPORT_PARAMETERS_BROKERADDRESS: "tcp://mqtt-broker:1883"
  WRITABLE_PIPELINE_FUNCTIONS_MQTTEXPORT_PARAMETERS_TOPIC: "edgex/events"
  WRITABLE_PIPELINE_FUNCTIONS_MQTTEXPORT_PARAMETERS_CLIENTID: "edgex-export"
```

---

## 六、KubeEdge 云边协同

### 1、架构

![KubeEdge 云边协同架构](../assets/iot/kubeedge-arch.svg)

- **CloudCore**：部署在云端，CloudHub 维持与边缘节点的连接，EdgeController 同步 Pod、ConfigMap 等资源，DeviceController 同步设备 CRD
- **EdgeCore**：部署在边缘节点，EdgeHub 与云端通信，MetaManager 把元数据持久化到本地，Edged 管理容器，DeviceTwin 维护设备孪生
- **Mapper**：协议适配程序，一种协议一个 Mapper，通过 DMI 接口与 EdgeCore 交互并读写真实设备

云边之间默认通过 WebSocket（也可选 QUIC）通信，CloudHub 端口为 10000。边缘节点不需要安装完整的 Kubernetes，只运行 EdgeCore 和容器运行时。

### 2、云端安装

在已有 Kubernetes 集群的控制节点执行。云端与边缘的 KubeEdge 版本必须一致，Kubernetes 版本需在该 KubeEdge 版本的兼容范围内（见 KubeEdge 仓库 README 的兼容矩阵）：

```bash
KE_VERSION=v1.23.1

# 安装 keadm
wget https://github.com/kubeedge/kubeedge/releases/download/${KE_VERSION}/keadm-${KE_VERSION}-linux-amd64.tar.gz
tar -xzf keadm-${KE_VERSION}-linux-amd64.tar.gz
cp keadm-${KE_VERSION}-linux-amd64/keadm/keadm /usr/local/bin/keadm

# 安装 CloudCore；advertise-address 是边缘节点访问云端的地址，会写入 CloudCore 证书
keadm init --advertise-address=<云端地址> --kubeedge-version=${KE_VERSION} --kube-config=/root/.kube/config

# 生成边缘节点加入用的 token
keadm gettoken
```

### 3、边缘节点加入

```bash
keadm join \
  --cloudcore-ipport=<云端地址>:10000 \
  --token=<keadm gettoken 输出的 token> \
  --kubeedge-version=v1.23.1 \
  --edgenode-name=edge-node-01

# 在云端确认节点已注册
kubectl get nodes
# NAME           STATUS   ROLES           AGE
# master-01      Ready    control-plane   10d
# edge-node-01   Ready    agent,edge      1m
```

### 4、部署边缘应用

用标准的 Deployment 部署，通过 `nodeSelector` 把 Pod 调度到边缘节点：

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: edge-sensor-app
spec:
  replicas: 1
  selector:
    matchLabels:
      app: sensor-collector
  template:
    metadata:
      labels:
        app: sensor-collector
    spec:
      nodeSelector:
        kubernetes.io/hostname: edge-node-01
      containers:
        - name: collector
          image: my-registry/sensor-collector:1.0.0
          resources:
            limits:
              cpu: "500m"
              memory: "256Mi"
```

```bash
kubectl apply -f edge-sensor-app.yaml
kubectl get pods -o wide   # 确认 Pod 运行在 edge-node-01
```

### 5、设备管理：DeviceModel 与 Device

KubeEdge 1.15 起设备 CRD 升级到 `v1beta1`，与旧的 `v1alpha2` 不兼容。DeviceModel 描述一类设备的属性，Device 描述具体设备实例及其协议参数：

```yaml
# DeviceModel：一类设备的属性定义
apiVersion: devices.kubeedge.io/v1beta1
kind: DeviceModel
metadata:
  name: temperature-sensor-model
  namespace: default
spec:
  protocol: modbus
  properties:
    - name: temperature
      description: 当前温度
      type: FLOAT
      accessMode: ReadOnly
      minimum: "-40"
      maximum: "125"
      unit: Celsius
    - name: humidity
      description: 当前湿度
      type: FLOAT
      accessMode: ReadOnly
      minimum: "0"
      maximum: "100"
      unit: "%RH"
```

```yaml
# Device：设备实例，绑定到边缘节点
apiVersion: devices.kubeedge.io/v1beta1
kind: Device
metadata:
  name: temperature-sensor-01
  namespace: default
spec:
  deviceModelRef:
    name: temperature-sensor-model
  nodeName: edge-node-01
  protocol:
    protocolName: modbus
    configData:            # 连接参数，具体字段由所用 Mapper 定义
      ip: 192.168.1.50
      port: 502
      slaveID: 1
  properties:
    - name: temperature
      collectCycle: 10000000000    # 采集周期，单位纳秒（10 秒）
      reportCycle: 10000000000     # 上报周期，单位纳秒
      reportToCloud: true
      visitors:
        protocolName: modbus
        configData:        # 属性在设备上的位置，具体字段由 Mapper 定义
          register: HoldingRegister
          offset: 0
          limit: 1
```

```bash
kubectl apply -f device-model.yaml
kubectl apply -f device-instance.yaml

# 查看设备状态，status 中包含设备上报的属性值
kubectl get device temperature-sensor-01 -o yaml
```

可写属性（`accessMode: ReadWrite`）可以在 Device 的 `properties` 中设置 `desired.value`，由 Mapper 下发到设备，这与 [设备影子](./8_device_shadow) 的期望值 / 上报值模型是同一个思路。

### 6、断网自治验证

```bash
# 在边缘节点模拟与云端断网
iptables -I OUTPUT -d <云端地址> -j DROP

# 在边缘节点本地查看，Pod 仍为 Running
crictl pods

# 恢复网络，云端状态重新同步
iptables -D OUTPUT -d <云端地址> -j DROP
kubectl get pods -o wide
```

断网期间，EdgeCore 依靠本地持久化的元数据继续管理 Pod；边缘节点重启后也能从本地元数据恢复应用，不需要等云端重新下发。

---

## 七、边缘 AI 推理

边缘推理只关心「把训练好的模型在边缘稳定地跑起来」：模型导出为 ONNX 格式后，用 ONNX Runtime 在 Java 进程内推理，不依赖 Python 环境。模型训练、选型和大模型接入见 [AI 总览](/ai/0_overview)；需要在边缘服务器上运行小型大模型时，可以参考 [Ollama](/ai/3_integration/0_ollama)。

![边缘 AI 推理流水线](../assets/iot/edge-ai-pipeline.svg)

### 1、依赖

```xml
<dependency>
    <groupId>com.microsoft.onnxruntime</groupId>
    <artifactId>onnxruntime</artifactId>
    <version>1.31.0</version>
</dependency>
```

CPU 推理用 `onnxruntime`；需要 GPU 加速时改用 `onnxruntime_gpu`，并确认边缘设备上的 CUDA 版本与之匹配。

### 2、加载模型并推理

`OrtSession` 创建开销大（要解析和优化整个模型图），应当启动时创建一次、所有请求复用；`run` 方法是线程安全的。`OnnxTensor`、`OrtSession.Result`、`OrtSession` 都持有原生内存，必须关闭。

```java
import ai.onnxruntime.OnnxTensor;
import ai.onnxruntime.OrtEnvironment;
import ai.onnxruntime.OrtException;
import ai.onnxruntime.OrtSession;

import java.nio.FloatBuffer;
import java.util.Map;

/**
 * 设备异常检测。
 * 假设模型输入 shape 为 [1, n] 的 float 特征，输出为 [1, 1] 的异常概率。
 */
public final class AnomalyDetector implements AutoCloseable {

    private final OrtEnvironment env = OrtEnvironment.getEnvironment();   // 进程内单例
    private final OrtSession session;
    private final String inputName;

    public AnomalyDetector(String modelPath, int intraOpThreads) throws OrtException {
        try (OrtSession.SessionOptions opts = new OrtSession.SessionOptions()) {
            // 线程数按边缘设备可分给推理的 CPU 核数设置，而不是固定为 1
            opts.setIntraOpNumThreads(intraOpThreads);
            this.session = env.createSession(modelPath, opts);
        }
        // 输入名从模型读取，不在代码里写死
        this.inputName = session.getInputNames().iterator().next();
    }

    public float score(float[] features) throws OrtException {
        long[] shape = {1, features.length};
        try (OnnxTensor input = OnnxTensor.createTensor(env, FloatBuffer.wrap(features), shape);
             OrtSession.Result result = session.run(Map.of(inputName, input))) {
            float[][] output = (float[][]) result.get(0).getValue();
            return output[0][0];
        }
    }

    @Override
    public void close() throws OrtException {
        session.close();
    }
}
```

调用方按阈值判定，例如分数不低于 0.5 时触发本地告警并上报事件：

```java
try (AnomalyDetector detector = new AnomalyDetector("/models/anomaly_detector.onnx", 2)) {
    // 特征：温度、振动 X / Y / Z 轴加速度
    float score = detector.score(new float[]{85.3f, 0.12f, 0.09f, 2.45f});
    boolean anomaly = score >= 0.5f;
}
```

阈值不是固定值，要在验证集上按误报率和漏报率权衡后确定，并随模型版本一起下发。

### 3、模型下发到边缘节点

| 方式 | 适用 | 说明 |
|------|------|------|
| ConfigMap 挂载 | 很小的模型 | ConfigMap 整体不能超过 1 MiB；用 `kubectl create configmap onnx-model --from-file=anomaly_detector.onnx` 创建，模型文件放进 `binaryData` |
| 持久卷或宿主机目录 | 常规模型 | 模型由下载程序或运维工具写入，应用以只读方式挂载 |
| 打进镜像 | 模型与代码同步发布 | 换模型就是发新版本镜像，回滚最简单，但镜像体积大 |
| 模型管理服务 / OTA | 大量边缘节点、需要灰度 | 按批次下发、校验、回滚，与固件升级共用一套机制 |

KubeEdge 会把 ConfigMap 等资源的变更可靠地同步到边缘节点，所以 ConfigMap 和镜像两种方式在断网恢复后都能自动追上最新版本。

### 4、模型热更新

热更新最容易出的问题是「加载了一个写到一半的文件」，以及新模型有问题却无法回退。做法：

- **原子发布**：下载到临时文件，校验 SHA-256 和签名后，再用原子重命名（同一文件系统内的 `Files.move` 加 `ATOMIC_MOVE`）放到正式位置，或者按版本号建目录、最后切换软链接。不要监听 `ENTRY_MODIFY` 后立即加载，文件写入过程中会多次触发该事件
- **ConfigMap 挂载的特殊性**：Kubelet 更新 ConfigMap 时通过替换 `..data` 软链接完成切换，产生的是创建、删除事件而不是对模型文件的修改事件；更稳妥的做法是定时检查模型文件的哈希是否变化
- **先建后换**：新 `AnomalyDetector` 创建成功后，再用 `AtomicReference` 替换旧实例，旧实例等进行中的推理结束后再关闭；新模型加载失败时继续使用旧模型
- **可回退**：保留上一个版本的模型文件，新模型上线后监控告警率，异常时切回

模型文件的签名校验、防回滚和灰度发布与固件升级是同一套机制，见 [OTA 升级](./10_ota)。

---

## 小结

- 边缘负责低延迟、断网也要工作的逻辑，云端负责全局数据、训练和统一管理，规则和模型由云端下发
- EdgeX Foundry 适合工业协议采集网关，默认安全模式下 REST 调用需要 JWT，本地体验用非安全模式
- KubeEdge 已从 CNCF 毕业，用 CloudCore / EdgeCore 把 Kubernetes 延伸到边缘，云边版本必须一致；设备 CRD 从 1.15 起为 `v1beta1`
- ONNX Runtime 的 Session 要创建一次、全局复用，张量和结果都要关闭；输入名从模型读取，线程数按核数设置
- 模型更新要原子发布、先建后换、可回退，签名与灰度机制与 OTA 共用

## 参考资料

- EdgeX Foundry 文档：[https://docs.edgexfoundry.org/](https://docs.edgexfoundry.org/)
- EdgeX Compose：[https://github.com/edgexfoundry/edgex-compose](https://github.com/edgexfoundry/edgex-compose)
- KubeEdge：用 keadm 安装：[https://kubeedge.io/docs/setup/install-with-keadm](https://kubeedge.io/docs/setup/install-with-keadm)
- KubeEdge：Device CRD：[https://kubeedge.io/docs/concept/device/device_crds](https://kubeedge.io/docs/concept/device/device_crds)
- CNCF 宣布 KubeEdge 毕业：[https://www.cncf.io/announcements/2024/10/15/cloud-native-computing-foundation-announces-kubeedge-graduation/](https://www.cncf.io/announcements/2024/10/15/cloud-native-computing-foundation-announces-kubeedge-graduation/)
- OpenYurt：[https://github.com/openyurtio/openyurt](https://github.com/openyurtio/openyurt)
- ONNX Runtime Java API：[https://onnxruntime.ai/docs/get-started/with-java.html](https://onnxruntime.ai/docs/get-started/with-java.html)
- ONNX Runtime Releases：[https://github.com/microsoft/onnxruntime/releases](https://github.com/microsoft/onnxruntime/releases)

> 下一篇：[数据处理](./4_data) —— 时序数据落库、流式计算与告警。
