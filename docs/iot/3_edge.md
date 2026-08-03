# 边缘计算

> 参考资料：
> * EdgeX Foundry：[https://www.edgexfoundry.org/](https://www.edgexfoundry.org/)
> * KubeEdge：[https://kubeedge.io/](https://kubeedge.io/)

## 一、是什么

**边缘计算（Edge Computing）**：在靠近数据产生端（设备、网关、本地服务器）进行计算和处理，而不是将所有数据发往云端。

**解决的问题：**

| 问题 | 云端处理 | 边缘处理 |
|------|---------|---------|
| 实时性 | 延迟高（网络往返） | 延迟低（本地决策） |
| 带宽 | 所有数据上传，带宽压力大 | 本地过滤，只上传关键数据 |
| 可靠性 | 网络中断则失控 | 断网仍可本地运行 |
| 数据安全 | 原始数据离开本地 | 敏感数据可留在本地 |

## 二、云边端三层架构

![云边端三层架构](../assets/iot/edge-three-layers.svg)

## 三、边缘计算核心能力

| 能力 | 说明 |
|------|------|
| **协议转换** | 将 Modbus / OPC-UA / Zigbee 等协议统一转为 MQTT，向上对接云平台 |
| **本地规则引擎** | 在本地执行告警、联动等规则，无需云端参与 |
| **数据过滤与聚合** | 对原始高频数据降采样、去噪，减少上云流量 |
| **断网续传** | 云端连接中断时本地缓存数据，恢复后补传 |
| **AI 推理** | 在边缘侧执行轻量 AI 模型（如设备异常检测） |

## 四、主流边缘框架

### EdgeX Foundry

- **定位**：Linux 基金会主导的开源边缘计算框架，专为工业 IoT 设计
- **技术栈**：Go（核心服务） + Docker 容器化部署
- **架构**：微服务，每个服务职责单一（Device Service / Core Data / Rules Engine）
- **特点**：南向支持 Modbus / OPC-UA / MQTT，北向对接云平台；模块可按需裁剪
- GitHub：[https://github.com/edgexfoundry/edgex-go](https://github.com/edgexfoundry/edgex-go)

### KubeEdge

- **定位**：将 Kubernetes 延伸到边缘节点，CNCF 孵化项目
- **适合**：已有 K8s 集群，希望统一管理云端和边缘应用的团队
- **核心能力**：边缘节点断网自治、云边消息同步、设备孪生
- GitHub：[https://github.com/kubeedge/kubeedge](https://github.com/kubeedge/kubeedge)

### OpenYurt

- **定位**：阿里开源，将 K8s 扩展到边缘场景
- **特点**：对原生 K8s 零侵入改造，边缘节点自治能力强
- GitHub：[https://github.com/openyurtio/openyurt](https://github.com/openyurtio/openyurt)

### 框架对比

| 框架 | 适合场景 | 技术门槛 |
|------|---------|---------|
| EdgeX Foundry | 工业 IoT、协议转换网关 | 中 |
| KubeEdge | 已有 K8s 集群，云边统一管理 | 高 |
| OpenYurt | 阿里云用户，边缘 K8s 扩展 | 高 |

## 五、典型应用场景

- **工厂车间**：边缘网关采集 PLC 数据，本地实时判断设备告警，云端做历史分析
- **视频监控**：摄像头接入边缘节点，本地 AI 检测异常，只上传告警片段
- **能源管理**：智能电表数据在边缘聚合，减少上云频率
- **零售门店**：门店本地服务器处理收银、库存数据，断网仍能正常营业

## 六、EdgeX Foundry 实战部署

### 6.1 Docker Compose 快速启动

EdgeX Foundry 官方提供 `edgex-compose` 项目，包含所有核心服务的 Compose 文件。

```bash
# 克隆 edgex-compose
git clone https://github.com/edgexfoundry/edgex-compose.git
cd edgex-compose

# 启动核心服务（包含 device-virtual 虚拟设备和 app-service-configurable）
docker compose -f docker-compose.yml up -d

# 查看所有服务状态
docker compose ps
```

核心服务说明：

| 服务 | 职责 |
|------|------|
| `core-data` | 接收并持久化设备上报的读数（Reading） |
| `core-command` | 向设备发送控制指令 |
| `core-metadata` | 管理设备、设备配置文件的元数据 |
| `device-virtual` | 模拟虚拟设备，开发阶段无需真实硬件 |
| `app-service-configurable` | 北向数据导出，支持推送到 MQTT / Kafka / HTTP |

### 6.2 访问管理 UI

服务启动后，EdgeX UI 默认监听 4000 端口：

```
http://localhost:4000
```

在 UI 中可以查看已注册设备列表、设备配置文件以及实时上报的读数数据。

### 6.3 REST API 查询设备读数

EdgeX 所有服务均暴露 REST API（v3），以下示例查询最近上报的所有读数：

```bash
# 查询所有设备的读数（最多返回 20 条）
curl -s "http://localhost:59880/api/v3/reading/all?limit=20" | python3 -m json.tool

# 按设备名称过滤
curl -s "http://localhost:59880/api/v3/reading/device/name/Random-Integer-Device?limit=5"

# 查询指定资源名称的读数
curl -s "http://localhost:59880/api/v3/reading/resourceName/Int32?limit=10"
```

典型响应结构：

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

### 6.4 自定义 Device Service 说明

Device Service 是 EdgeX 的**南向驱动层**，负责对接真实硬件（Modbus、OPC-UA、BACnet 等）：

- 每种协议对应一个独立的 Device Service 微服务
- 设备采集的数据通过 `core-data` 存储，并可触发规则引擎
- **北向导出**通过 `app-service-configurable` 配置 Pipeline，将数据推送至 MQTT Broker 或 Kafka：

```yaml
# app-service-configurable 环境变量示例（导出到 MQTT）
WRITABLE_PIPELINE_FUNCTIONS_MQTTEXPORT_PARAMETERS_BROKERADDRESS: "tcp://mqtt-broker:1883"
WRITABLE_PIPELINE_FUNCTIONS_MQTTEXPORT_PARAMETERS_TOPIC: "edgex/events"
WRITABLE_PIPELINE_FUNCTIONS_MQTTEXPORT_PARAMETERS_CLIENTID: "edgex-export"
```

---

## 七、KubeEdge 云边协同配置

### 7.1 云端安装（keadm init）

在**云端 Master 节点**执行：

```bash
# 下载并安装 keadm（以 v1.17.0 为例）
wget https://github.com/kubeedge/kubeedge/releases/download/v1.17.0/keadm-v1.17.0-linux-amd64.tar.gz
tar -xvf keadm-v1.17.0-linux-amd64.tar.gz
cp keadm-v1.17.0-linux-amd64/keadm /usr/local/bin/keadm

# 初始化 CloudCore（需要已有 K8s 集群）
keadm init --advertise-address=<云端公网IP> --kubeedge-version=1.17.0

# 生成边缘节点加入 token
keadm gettoken
# 输出示例：
# 27a37ef16159f7d3...b2bae779952bcde56...@<云端IP>:10000
```

### 7.2 边缘节点加入

在**边缘节点**执行（边缘节点无需安装完整 K8s）：

```bash
# 安装 keadm（同上步骤）

# 加入边缘集群
keadm join \
  --cloudcore-ipport=<云端IP>:10000 \
  --token=<上一步获取的token> \
  --kubeedge-version=1.17.0 \
  --edgenode-name=edge-node-01

# 验证节点已注册（在云端执行）
kubectl get nodes
# NAME            STATUS   ROLES        AGE
# master-01       Ready    control-plane  10d
# edge-node-01    Ready    agent,edge     1m
```

### 7.3 边缘应用部署

通过标准 `kubectl apply` 部署，使用 `nodeSelector` 将 Pod 调度到边缘节点：

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: edge-sensor-app
  namespace: default
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
      # 指定调度到边缘节点
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

### 7.4 设备孪生（Device Twin）

KubeEdge 通过 **DeviceModel** 和 **Device** 两个 CRD 描述边缘设备：

```yaml
# DeviceModel：定义设备属性模板
apiVersion: devices.kubeedge.io/v1beta1
kind: DeviceModel
metadata:
  name: temperature-sensor-model
  namespace: default
spec:
  properties:
    - name: temperature
      description: "当前温度（摄氏度）"
      type:
        float:
          accessMode: ReadOnly
          defaultValue: 0.0
    - name: humidity
      description: "当前湿度（%RH）"
      type:
        float:
          accessMode: ReadOnly
          defaultValue: 0.0
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
  # 绑定到指定边缘节点
  nodeName: edge-node-01
  properties:
    - name: temperature
      desired:
        value: "25.0"
      visitors:
        protocolName: modbus
        configData:
          register: "HoldingRegister"
          offset: 0
          limit: 1
```

```bash
kubectl apply -f device-model.yaml
kubectl apply -f device-instance.yaml

# 查看设备孪生状态（reported 为设备上报值）
kubectl get device temperature-sensor-01 -o yaml | grep -A 10 "reported"
```

### 7.5 断网自治验证

KubeEdge 边缘节点支持断网后本地 Pod 继续运行：

```bash
# 在边缘节点模拟断网
iptables -I OUTPUT -d <云端IP> -j DROP

# 验证 Pod 仍在运行（在边缘节点本地查询）
crictl pods
# Pod 依然处于 Running 状态，业务不中断

# 恢复网络后，云边状态自动同步
iptables -D OUTPUT -d <云端IP> -j DROP
kubectl get pods -o wide   # Pod 状态重新可见于云端
```

---

## 八、边缘 AI 推理（ONNX Runtime）

### 8.1 Maven 依赖

```xml
<dependency>
    <groupId>com.microsoft.onnxruntime</groupId>
    <artifactId>onnxruntime</artifactId>
    <version>1.19.2</version>
</dependency>
```

> ONNX Runtime 1.19.x 支持 Java 8+，提供 CPU 推理；如需 GPU 加速，引入 `onnxruntime_gpu` artifact。

### 8.2 加载模型并推理（完整示例）

以下示例演示：加载 ONNX 模型 → 构造输入张量 → 执行推理 → 读取输出。

```java
import ai.onnxruntime.*;

import java.nio.FloatBuffer;
import java.util.Map;

public class EdgeAIInference {

    /**
     * 设备异常检测推理
     *
     * @param modelPath  ONNX 模型文件路径（如 /models/anomaly_detector.onnx）
     * @param sensorData 传感器输入数据：[温度, 振动_X, 振动_Y, 振动_Z]（4 维特征）
     * @return 0 = 正常，1 = 异常
     */
    public static int detectAnomaly(String modelPath, float[] sensorData) throws OrtException {
        // 1. 创建 OrtEnvironment（进程内单例）
        OrtEnvironment env = OrtEnvironment.getEnvironment();

        // 2. 创建推理会话，加载模型文件
        OrtSession.SessionOptions opts = new OrtSession.SessionOptions();
        opts.setIntraOpNumThreads(1);   // 边缘设备通常单核推理
        OrtSession session = env.createSession(modelPath, opts);

        // 3. 构造输入张量（shape: [1, 4]，即 batch=1，特征维度=4）
        long[] shape = {1, sensorData.length};
        OnnxTensor inputTensor = OnnxTensor.createTensor(
                env,
                FloatBuffer.wrap(sensorData),
                shape
        );

        // 4. 执行推理
        Map<String, OnnxTensor> inputs = Map.of("input", inputTensor);
        OrtSession.Result result = session.run(inputs);

        // 5. 解析输出（模型输出 shape: [1, 1]，浮点概率值）
        float[][] output = (float[][]) result.get(0).getValue();
        float anomalyScore = output[0][0];

        // 6. 释放资源
        inputTensor.close();
        result.close();
        session.close();

        // 阈值 0.5：高于则判定为异常
        return anomalyScore >= 0.5f ? 1 : 0;
    }

    public static void main(String[] args) throws OrtException {
        // 模拟传感器读数：温度=85.3℃（偏高），振动加速度 x/y/z
        float[] sensorData = {85.3f, 0.12f, 0.09f, 2.45f};

        int result = detectAnomaly("/models/anomaly_detector.onnx", sensorData);
        System.out.println("检测结果：" + (result == 1 ? "异常" : "正常"));
        // 输出示例：检测结果：异常
    }
}
```

### 8.3 典型 IoT 场景：异常检测

| 输入特征 | 说明 | 示例值 |
|----------|------|--------|
| 温度（℃） | 设备运行温度 | 85.3 |
| 振动 X 轴（g） | 水平方向加速度 | 0.12 |
| 振动 Y 轴（g） | 纵向加速度 | 0.09 |
| 振动 Z 轴（g） | 垂直方向加速度（异常时偏大） | 2.45 |
| **输出** | 异常概率分数 | 0.87 → 判定为异常 |

推理流水线示意：

```
MQTT 采集 → sensorData[] → ONNX Runtime 推理 → anomalyScore
    ↓ score ≥ 0.5
本地告警 + 上报云端
```

### 8.4 模型部署到边缘节点

**方式一：挂载 ConfigMap（小模型，< 1MB）**

```yaml
# 将模型文件以 binaryData 存入 ConfigMap（base64 编码）
apiVersion: v1
kind: ConfigMap
metadata:
  name: onnx-model-config
  namespace: default
binaryData:
  anomaly_detector.onnx: <base64编码的模型内容>
```

```yaml
# Deployment 中挂载 ConfigMap 为文件
volumes:
  - name: model-volume
    configMap:
      name: onnx-model-config
containers:
  - name: inference-app
    volumeMounts:
      - name: model-volume
        mountPath: /models
```

**方式二：挂载 PersistentVolume（大模型，推荐）**

```yaml
volumes:
  - name: model-volume
    persistentVolumeClaim:
      claimName: edge-model-pvc
containers:
  - name: inference-app
    volumeMounts:
      - name: model-volume
        mountPath: /models
        readOnly: true
```

**方式三：OTA 更新模型文件**

通过 KubeEdge 的 `ObjectSync` 机制或自定义的模型管理服务，将新版 ONNX 文件推送至边缘节点指定目录，应用通过文件监听（`WatchService`）热加载新模型：

```java
// 监听模型文件变更，热加载新版本
WatchService watchService = FileSystems.getDefault().newWatchService();
Path modelDir = Paths.get("/models");
modelDir.register(watchService, StandardWatchEventKinds.ENTRY_MODIFY);

WatchKey key;
while ((key = watchService.take()) != null) {
    for (WatchEvent<?> event : key.pollEvents()) {
        if (event.context().toString().endsWith(".onnx")) {
            System.out.println("检测到模型更新，重新加载：" + event.context());
            // 重新创建 OrtSession，完成热加载
            reloadModel("/models/" + event.context());
        }
    }
    key.reset();
}
```
