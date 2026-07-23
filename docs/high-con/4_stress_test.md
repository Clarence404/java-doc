# 压力测试

## 一、压测目标

压力测试（Stress Test）通过模拟大量并发请求，找出系统的**性能瓶颈和容量上限**，为容量规划和限流阈值设置提供依据。

**核心指标**：
- **TPS / QPS**：每秒事务 / 请求数
- **P50 / P95 / P99 响应时间**：百分位延迟（P99 代表 99% 的请求响应时间）
- **错误率**：请求失败 / 超时比例
- **系统资源**：CPU、内存、网络 IO、线程池积压

---

## 二、JMeter

JMeter 是 Apache 开源的压测工具，支持 HTTP / gRPC / Dubbo 等多种协议，提供 GUI 和命令行两种模式。

### 线程组配置

| 参数 | 说明 |
|------|------|
| 线程数 | 模拟的并发用户数 |
| Ramp-Up 时间 | 从 0 爬升到目标线程数所用的时间（避免瞬时压力）|
| 循环次数 | 每个线程执行的请求次数 |
| 持续时间 | 以时间控制压测时长（优先于循环次数）|

**典型场景：阶梯加压**

```
阶段 1：50 并发，持续 2 分钟（热身）
阶段 2：100 并发，持续 3 分钟（正常压力）
阶段 3：200 并发，持续 3 分钟（峰值压力）
阶段 4：500 并发，持续 2 分钟（极限探测）
```

### 命令行执行（无 GUI，适合 CI/CD）

```bash
# 执行压测并生成报告
jmeter -n -t test_plan.jmx -l results.jtl -e -o ./report

# 参数说明
# -n: 非 GUI 模式
# -t: 测试计划文件
# -l: 结果文件
# -e: 生成 HTML 报告
# -o: 报告输出目录
```

### 关键断言

```
响应断言：HTTP 状态码为 200
响应时间断言：P99 < 500ms
```

---

## 三、k6

k6 是现代化压测工具，使用 JavaScript 编写测试脚本，天然支持 Docker / CI/CD，输出结构化指标。

### 基础脚本示例

```javascript
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate } from 'k6/metrics';

// 自定义指标：错误率
const errorRate = new Rate('error_rate');

// 压测配置
export const options = {
  stages: [
    { duration: '1m', target: 50 },   // 1 分钟内爬升到 50 并发
    { duration: '3m', target: 100 },  // 保持 100 并发 3 分钟
    { duration: '2m', target: 200 },  // 爬升到 200 并发
    { duration: '1m', target: 0 },    // 1 分钟内降到 0
  ],
  thresholds: {
    http_req_duration: ['p(99)<500'],  // P99 必须 < 500ms
    error_rate: ['rate<0.01'],         // 错误率必须 < 1%
  },
};

export default function () {
  const payload = JSON.stringify({ userId: 1001, productId: 2001, quantity: 1 });
  const headers = { 'Content-Type': 'application/json' };

  const res = http.post('http://api.example.com/order', payload, { headers });

  check(res, {
    'status is 200': (r) => r.status === 200,
    'response time < 200ms': (r) => r.timings.duration < 200,
  });

  errorRate.add(res.status !== 200);
  sleep(0.1);
}
```

### 运行与结果分析

```bash
# 本地运行
k6 run script.js

# Docker 运行
docker run --rm -i grafana/k6 run - < script.js

# 输出到 InfluxDB（配合 Grafana 可视化）
k6 run --out influxdb=http://localhost:8086/k6 script.js
```

**输出示例关键指标**：
```
http_req_duration   avg=45ms  min=5ms  med=30ms  max=1.2s  p(90)=120ms  p(99)=450ms
http_req_failed     0.23%
http_reqs           12345  (68.5/s)
```

---

## 四、压测指标分析

### 吞吐量 vs 响应时间曲线

```
响应时间
    ↑
    │               ╭─────  崩溃点
    │          ╭────╯
    │    ╭─────╯
    │────╯
    └─────────────────────→ QPS
         └─────┘└───┘
           线性区  拐点区
```

| 区域 | 特征 | 判断 |
|------|------|------|
| 线性区 | 响应时间平稳，QPS 随并发线性增长 | 系统正常工作范围 |
| 拐点区 | 响应时间开始抬升，错误率开始出现 | 接近系统容量上限 |
| 崩溃点 | 错误率飙升，响应时间急剧恶化 | 超过系统承载能力 |

### 常见瓶颈定位

| 现象 | 可能原因 | 排查工具 |
|------|---------|---------|
| CPU 100% | 计算密集或 GC 频繁 | `top`、`jstack`、Arthas `dashboard` |
| 响应慢，CPU 低 | DB 慢查询、锁等待、IO 阻塞 | 慢查询日志、`jstack` 找 BLOCKED 线程 |
| 连接超时 | 线程池耗尽或网络带宽打满 | 线程池监控、`netstat -an` |
| 内存增长 | 内存泄漏或 Full GC 频繁 | `jmap -heap`、GC 日志 |

---

## 五、压测最佳实践

1. **隔离测试环境**：避免在生产环境压测影响真实用户
2. **准备足够的测试数据**：避免测试数据量不足导致缓存命中率虚高
3. **逐步加压**：先小流量验证脚本正确性，再阶梯加压找拐点
4. **同步观测监控**：压测期间实时观察 Grafana / Prometheus 指标，及时发现异常
5. **压测结束后分析**：关注 GC 日志、慢查询、线程 dump，而不只看压测报告
6. **建立性能基线**：每次重大发布前后对比，检测性能回退
