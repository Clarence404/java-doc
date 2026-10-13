---
description: 正则回溯爆炸导致 CPU 打满、top -H 与 jstack 定位热点线程、Arthas 抓入参、正则改写与长度限制
---

# CPU 飙高

> 前置阅读：[故障排查](/jvm/9_troubleshooting)、[线上诊断](/engineering/7_diagnosis)

发版后收货地址校验正则遇到特定输入发生回溯爆炸，打满了订单服务的 CPU。本篇演示 `top -H`、线程栈到入参的定位链路与正则改写，基线为 JDK 21、Arthas 4。

---

## 一、现象

order-service 每个 Pod `requests.cpu=2`、`limits.cpu=4`。10 月 12 日 14:00 发布 v2.41.0（加强收货地址格式校验）。

| 时间 | 告警 / 现象 |
|------|-------------|
| 15:38 | `PodCpuHigh`：order-service-8b7c-r5n6d CPU 使用 3.96 核（limit 4 核），持续 5 分钟 |
| 15:40 | `ContainerCpuThrottled`：该 Pod 被 CFS 限流的周期占比 78% |
| 15:42 | `HttpP99High`：下单接口 P99 从 180ms 升到 8.7s；同时另外 2 个 Pod 的 CPU 也升到 3 核以上 |
| 15:45 | 网关 504 比例 6%，客诉"提交订单一直转圈" |

GC 指标正常：`jvm_gc_pause_seconds` 没有变化，堆使用平稳。CPU 高但不是 GC 导致的，问题在业务线程。

---

## 二、影响

- 15:38–16:06 约 28 分钟，3 个 Pod 基本失去处理能力，下单成功率最低跌到 82%，约 6,200 次下单失败
- 被卡住的 Tomcat 线程即使客户端已超时断开也不会停止计算，持续占用 CPU 和线程，扩容新 Pod 后很快也被同类请求拖垮
- 无数据问题：请求卡在参数校验阶段，尚未进入事务

---

## 三、排查过程

### 1、找到最忙的线程

容器内 Java 进程的 PID 通常是 1：

```bash
kubectl exec order-service-8b7c-r5n6d -- top -H -b -n 1 -p 1 | head -12
```

示例输出：

```text
top - 15:46:21 up 21 days,  3:11,  0 users,  load average: 11.87, 9.34, 5.02
Threads: 318 total,   5 running, 313 sleeping,   0 stopped,   0 zombie
%Cpu(s): 97.6 us,  1.7 sy,  0.0 ni,  0.4 id,  0.0 wa,  0.0 hi,  0.3 si,  0.0 st

    PID USER      PR  NI    VIRT    RES    SHR S  %CPU  %MEM     TIME+ COMMAND
    214 app       20   0   10.1g   4.7g  31248 R  99.9   7.4  10:12.43 http-nio-8080-e
    231 app       20   0   10.1g   4.7g  31248 R  99.7   7.4   9:58.10 http-nio-8080-e
    187 app       20   0   10.1g   4.7g  31248 R  99.3   7.4   7:41.66 http-nio-8080-e
    246 app       20   0   10.1g   4.7g  31248 R  98.8   7.4   6:03.29 http-nio-8080-e
     38 app       20   0   10.1g   4.7g  31248 S   0.7   7.4   0:41.02 G1 Conc#0
```

4 个线程各吃满 1 核，线程名被截断为 15 个字符，能看出是 Tomcat 的请求线程（`http-nio-8080-exec-*`），GC 线程几乎空闲。

### 2、在线程栈中找到对应线程

JDK 18 起线程转储里的 `nid` 改为十进制，可以直接拿 `top` 中的线程 ID 搜索；JDK 17 及以前是十六进制，需要先 `printf '%x\n' 214` 转换。

```bash
kubectl exec order-service-8b7c-r5n6d -- jstack 1 > dump-1.txt
grep -A 14 "nid=214 " dump-1.txt
```

示例输出：

```text
"http-nio-8080-exec-37" #128 [214] daemon prio=5 os_prio=0 cpu=612433.18ms elapsed=6312.40s tid=0x00007f3a2c0e1800 nid=214 runnable  [0x00007f39f53fd000]
   java.lang.Thread.State: RUNNABLE
	at java.util.regex.Pattern$CharPropertyGreedy.match(java.base@21.0.8/Pattern.java:4510)
	at java.util.regex.Pattern$GroupHead.match(java.base@21.0.8/Pattern.java:4886)
	at java.util.regex.Pattern$Loop.match(java.base@21.0.8/Pattern.java:5021)
	at java.util.regex.Pattern$GroupTail.match(java.base@21.0.8/Pattern.java:4917)
	at java.util.regex.Pattern$BranchConn.match(java.base@21.0.8/Pattern.java:4797)
	at java.util.regex.Pattern$Ques.match(java.base@21.0.8/Pattern.java:4216)
	at java.util.regex.Pattern$CharPropertyGreedy.match(java.base@21.0.8/Pattern.java:4521)
	...
	at java.util.regex.Matcher.matches(java.base@21.0.8/Matcher.java:729)
	at com.example.order.validation.ReceiverValidator.isValidAddress(ReceiverValidator.java:27)
	at com.example.order.validation.ReceiverValidator.validate(ReceiverValidator.java:18)
	at com.example.order.web.OrderController.create(OrderController.java:54)
```

间隔 5 秒再抓两次，4 个热点线程始终停在 `Pattern$Loop` / `GroupTail` 的反复调用中，栈底都是 `ReceiverValidator.isValidAddress`。单次转储只是一个瞬间，多次抓取都在同一位置，才能确认是热点。

用 Arthas 可以一步完成上面两步，并给出采样区间内的 CPU 占比：

```bash
[arthas@1]$ thread -n 3 -i 5000
```

示例输出（节选）：

```text
"http-nio-8080-exec-37" Id=128 cpuUsage=99.62% deltaTime=4981ms time=612433ms RUNNABLE
    at java.util.regex.Pattern$CharPropertyGreedy.match(Pattern.java:4510)
    at java.util.regex.Pattern$GroupHead.match(Pattern.java:4886)
    at java.util.regex.Pattern$Loop.match(Pattern.java:5021)
    ...
"http-nio-8080-exec-52" Id=143 cpuUsage=99.48% deltaTime=4974ms time=598101ms RUNNABLE
    ...
```

### 3、抓到触发问题的入参

方法卡在执行中不会返回，所以要在**方法入口**观察（`-b`）：

```bash
[arthas@1]$ watch com.example.order.validation.ReceiverValidator isValidAddress \
  '{params[0].length(), params[0]}' -b -n 3
```

示例输出（节选）：

```text
method=com.example.order.validation.ReceiverValidator.isValidAddress location=AtEnter
ts=2026-10-12 15:51:07.332; [cost=0.012ms] result=@ArrayList[
    @Integer[61],
    @String[上海市浦东新区张江镇 博云路2号 浦软大厦501室 前台代收 联系人王先生 工作日送达＃],
]
```

地址很长、由多段空格分隔，末尾带一个全角符号 `＃`（不在允许的字符集里）。后续确认这些请求都来自某企业客户的批量下单工具。

### 4、本地复现

```java
Pattern p = Pattern.compile("^([\\u4e00-\\u9fa5A-Za-z0-9]+[\\s-]?){1,20}$");
for (int n = 18; n <= 28; n += 2) {
    String s = "浦".repeat(n) + "＃";              // n 个合法字符 + 1 个非法字符
    long t = System.nanoTime();
    p.matcher(s).matches();
    System.out.printf("len=%d cost=%dms%n", s.length(), (System.nanoTime() - t) / 1_000_000);
}
```

示例输出：

```text
len=19 cost=48ms
len=21 cost=170ms
len=23 cost=590ms
len=25 cost=2110ms
len=27 cost=7420ms
len=29 cost=26530ms
```

长度每增加 2 个字符耗时约增长 3～4 倍，61 个字符的地址在理论上需要计算数年，线程等于永久卡死。

---

## 四、根因

v2.41.0 新增的校验正则：

```java
private static final Pattern ADDRESS = Pattern.compile("^([\\u4e00-\\u9fa5A-Za-z0-9]+[\\s-]?){1,20}$");
```

- 外层 `(...){1,20}`（「地址最多 20 段」）里套着内层 `[...]+`，分隔符 `[\s-]?` 又是可选的，于是同一段连续汉字可以被切分成任意多种"组"的组合
- 末尾的 `＃` 让整体匹配必然失败，回溯引擎会把所有切分方式都尝试一遍，组合数随长度指数增长（典型的 ReDoS）
- 如果外层写成不限次数的 `(...)+`，JDK 9 起 `java.util.regex` 会记住「某位置已经匹配失败」而跳过重复尝试，这个例子不会爆炸；但带上限的 `{m,n}` 不走这项优化，换一种结构的嵌套量词同样会爆炸，不能依赖 JDK 兜底
- 校验之前没有长度限制，`java.util.regex` 在匹配过程中也不响应线程中断，请求超时后线程仍在计算

---

## 五、修复

### 1、止血

- 15:52 确认根因前先尝试扩容到 10 个 Pod，新 Pod 几分钟内同样被打满，说明扩容无效
- 15:58 回滚到 v2.40.3；回滚的滚动重启同时杀掉了卡死的线程，16:06 各 Pod CPU 回到 0.6 核左右，错误率恢复

### 2、根治

改写正则，让每一段输入只有一种匹配方式；并在正则之前先做长度检查：

```java
// 一段字符 + 若干个"分隔符 + 一段字符"，分隔符必须出现，不存在多种切分
private static final Pattern ADDRESS =
        Pattern.compile("^[\\u4e00-\\u9fa5A-Za-z0-9]+(?:[\\s-][\\u4e00-\\u9fa5A-Za-z0-9]+)*$");
private static final int MAX_ADDRESS_LENGTH = 120;

public boolean isValidAddress(String address) {
    if (address == null || address.isBlank() || address.length() > MAX_ADDRESS_LENGTH) {
        return false;                                   // 先挡住超长输入，再进正则
    }
    return ADDRESS.matcher(address).matches();
}
```

修复后同样的 61 字符输入耗时 0.02ms。另外两点：

- 网关层对下单接口请求体设置大小上限（如 64KB），从入口限制异常输入
- 需要对用户输入执行复杂正则的场景，可以评估线性时间的正则引擎（如 RE2/J），它不支持反向引用，但不会出现回溯爆炸

---

## 六、预防

**监控告警**：

```yaml
- alert: PodCpuHigh
  # 容器 CPU 使用超过 limit 的 90%
  expr: |
    sum by (pod) (rate(container_cpu_usage_seconds_total{container="order-service"}[5m]))
      / sum by (pod) (kube_pod_container_resource_limits{container="order-service", resource="cpu"}) > 0.9
  for: 5m
  labels: {severity: critical}
- alert: ContainerCpuThrottled
  expr: |
    rate(container_cpu_cfs_throttled_periods_total{container="order-service"}[5m])
      / rate(container_cpu_cfs_periods_total{container="order-service"}[5m]) > 0.5
  for: 5m
  labels: {severity: warning}
```

CPU 告警触发时自动执行一次 `thread -n 5` 或三次间隔 5 秒的 `jstack` 并保存，事后不必再等问题复现。

**代码规范**：

- 正则禁止"量词嵌套 + 可选分隔"的写法（如 `(a+)+`、`(a+b?)+`、`(a|aa)+`）；用于用户输入的正则必须经过 Code Review 并附测试
- 对用户输入执行正则前先限制长度；`Pattern` 预编译为静态常量
- CI 中接入正则静态检查工具，扫描可能发生指数回溯的模式

**测试**：

用对抗性输入做超时断言，任何校验正则都要带这样一条用例：

```java
@Test
void addressRegexShouldNotBacktrack() {
    String evil = "上海市 浦东新区 张江镇 博云路2号 浦软大厦501室".repeat(3) + "＃";
    assertTimeoutPreemptively(Duration.ofMillis(50), () -> validator.isValidAddress(evil));
}
```

---

## 七、涉及知识点

- CPU 飙高的排查步骤与可能原因：[故障排查](/jvm/9_troubleshooting#十、cpu-使用率高)
- `top`、`jstack` 等 Linux 侧排查命令：[Linux 概览](/cloud-native/1_linux#七、常用排查命令)
- `jstack` 与线程转储的读法：[诊断工具](/jvm/8_monitoring_tools#四、jstack-线程分析)
- Arthas `thread` / `watch` 的用法：[线上诊断](/engineering/7_diagnosis#三、按症状选命令)
- 容器 CPU limit 与限流：[Kubernetes](/cloud-native/6_kubernetes)
- 回滚等止血手段：[故障应急与复盘](/high-avail/11_incident_response#四、止血手段清单)

---

## 小结

- CPU 高先分清是业务线程还是 GC 线程：GC 指标正常时直接看 `top -H` 中最忙的线程
- JDK 18 起 `nid` 为十进制，可直接拿线程 ID 搜索线程栈；多抓几次确认始终停在同一位置
- 方法卡住不返回时，用 Arthas `watch -b` 在入口抓入参
- 用户输入的正则要避免嵌套量词、先限长，并用对抗性输入做超时测试

## 参考资料

- CPU 与挂起问题排查：[General Java Troubleshooting](https://docs.oracle.com/en/java/javase/21/troubleshoot/general-java-troubleshooting.html)
- 线程转储：[The jstack Command](https://docs.oracle.com/en/java/javase/21/docs/specs/man/jstack.html)
- 正则语法与量词：[java.util.regex.Pattern](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/regex/Pattern.html)
- 正则拒绝服务：[OWASP — Regular expression Denial of Service (ReDoS)](https://owasp.org/www-community/attacks/Regular_expression_Denial_of_Service_-_ReDoS)
- Arthas `thread` 命令：[Arthas thread](https://arthas.aliyun.com/en/doc/thread.html)

> 下一篇：[线程池耗尽](./4_thread_pool_exhausted)
