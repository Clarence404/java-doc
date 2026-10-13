---
description: 启动与附着、全局概览、watch / trace / tt 方法观察、类加载器、热修复、剖析与收尾
---

# Arthas 速查

> 前置阅读：[线上诊断](/engineering/7_diagnosis)、[诊断工具](/jvm/8_monitoring_tools)

Arthas 常用命令按排查步骤分组，示例类名统一用 `com.example.order.OrderService`，替换成实际类名即可。本篇只列命令，附着原理、容器内附着与安全守则见前置阅读，基线为 Arthas 4 与 Spring Boot 4。

---

## 一、启动与附着

| 场景 | 命令 | 说明 |
|------|------|------|
| 下载启动器 | `curl -O https://arthas.aliyun.com/arthas-boot.jar` | 生产环境建议把发行包打进镜像，不临时联网下载 |
| 选择进程附着 | `java -jar arthas-boot.jar` | 列出本机 JVM，输入序号 |
| 指定 PID 附着 | `java -jar arthas-boot.jar <pid>` | 容器内 Java 进程通常是 PID 1 |
| 按进程名附着 | `java -jar arthas-boot.jar --select order-service` | 按主类或 jar 名匹配，适合写进脚本 |
| Pod 内附着 | `kubectl exec -it <pod> -c <container> -- java -jar /opt/arthas/arthas-boot.jar 1` | 以应用用户执行；JRE 镜像改用 `kubectl debug`，见前置阅读 |
| 断开但保留 Server | `quit` | 增强仍在、端口仍开，生产上不要只执行这一步 |
| 还原增强并卸载 | `stop` | 诊断结束必须执行 |

---

## 二、全局概览

| 场景 | 命令 | 说明 |
|------|------|------|
| 线程、内存、GC 总览 | `dashboard -i 2000 -n 5` | 每 2 秒刷新、共 5 次后退出 |
| 最忙的线程 | `thread -n 3` | 直接给出 CPU 最高的 3 个线程栈 |
| 查看指定线程 | `thread <id>` | id 取自 `thread` 或 `dashboard` 的输出 |
| 阻塞的线程 | `thread --state BLOCKED` | 状态还可取 `WAITING`、`TIMED_WAITING` |
| 持有 synchronized 锁阻塞他人的线程 | `thread -b` | 只认 synchronized，对 `ReentrantLock` 无效 |
| JVM 信息 | `jvm` | 版本、启动参数、类加载数、GC 次数 |
| 内存池 | `memory` | 堆、非堆、各内存池使用量 |
| 系统属性与环境变量 | `sysprop user.timezone`、`sysenv JAVA_TOOL_OPTIONS` | 核对时区、启动参数是否生效 |
| 查看与修改 VM 选项 | `vmoption HeapDumpOnOutOfMemoryError true` | 只能改 manageable 类型的选项 |

---

## 三、方法级观察

| 场景 | 命令 | 说明 |
|------|------|------|
| 看入参与返回值 | `watch com.example.order.OrderService createOrder '{params, returnObj}' -x 3 -n 5` | `-x` 展开层数，`-n` 限制次数 |
| 只看抛异常的调用 | `watch com.example.order.OrderService createOrder '{params, throwExp}' -e -x 2 -n 5` | `-e` 仅在抛异常时输出 |
| 看调用前的入参 | `watch com.example.order.OrderService createOrder '{params}' -b -x 2 -n 5` | 与默认的方法结束时对比，发现入参被修改 |
| 按条件过滤 | `watch com.example.order.OrderService createOrder '{params, returnObj}' 'params[0].userId == 1001L && #cost > 200' -x 3 -n 10` | `#cost` 为耗时（毫秒） |
| 拆解方法内部耗时 | `trace com.example.order.OrderService createOrder '#cost > 100' -n 5` | 只展开一层，慢的子方法再单独 trace |
| 追踪多个类与方法 | `trace -E 'com\.example\.order\.(OrderService\|InventoryService)' 'createOrder\|deductStock' -n 5` | `-E` 使用正则 |
| 不知道哪个接口慢 | `trace org.springframework.web.servlet.DispatcherServlet doDispatch '#cost > 500' -n 3` | 从 Spring MVC 入口抓慢请求 |
| 包含 JDK 方法 | `trace com.example.order.OrderService createOrder --skipJDKMethod false -n 3` | 默认跳过 JDK 方法 |
| 谁调用了这个方法 | `stack com.example.order.OrderService cancelOrder -n 3` | 输出完整调用栈 |
| 周期统计成功率与 RT | `monitor -c 10 com.example.order.OrderService createOrder` | 每 10 秒输出一次 |
| 记录调用现场 | `tt -t com.example.order.OrderService createOrder -n 50` | 记录之后的 50 次调用 |
| 列出与查看记录 | `tt -l`、`tt -i 1003 -w '{params, returnObj, throwExp}' -x 3` | INDEX 从 1000 开始 |
| 清空记录 | `tt --delete-all` | 记录常驻内存，用完必须清理 |

::: warning tt -p 会真实执行
`tt -i <index> -p` 会用记录的参数再调用一次方法，下单、扣款等有副作用的方法在生产上禁止使用。
:::

---

## 四、类与类加载器

| 场景 | 命令 | 说明 |
|------|------|------|
| 类来自哪个 jar | `sc -d com.example.order.OrderService` | 看 `code-source` 与 `classLoaderHash` |
| 模糊搜索已加载的类 | `sc 'com.example.order.*'` | 确认类是否已加载 |
| 类有哪些方法 | `sm -d com.example.order.OrderService createOrder` | 方法签名与注解 |
| 类加载器树 | `classloader -t` | 各加载器的继承关系与 hash |
| 反编译方法 | `jad com.example.order.OrderService createOrder` | 确认线上运行的是哪份代码 |
| 读静态字段 | `ognl --classLoaderClass org.springframework.boot.loader.launch.LaunchedClassLoader '@com.example.order.OrderConfig@MAX_ITEMS'` | fat jar 中必须指定类加载器 |
| 统计 Spring 容器数 | `vmtool --action getInstances --classLoaderClass org.springframework.boot.loader.launch.LaunchedClassLoader --className org.springframework.context.ApplicationContext --express 'instances.length'` | 父子上下文会有多个实例 |
| 读生效的配置值 | `vmtool --action getInstances --classLoaderClass org.springframework.boot.loader.launch.LaunchedClassLoader --className org.springframework.context.ApplicationContext --express 'instances[0].getEnvironment().getProperty("order.pay-timeout")'` | 输出可能含敏感配置，注意保管 |
| 查看日志级别 | `logger --classLoaderClass org.springframework.boot.loader.launch.LaunchedClassLoader -n com.example.order` | 当前级别与 appender |
| 临时调到 DEBUG | `logger --classLoaderClass org.springframework.boot.loader.launch.LaunchedClassLoader --name com.example.order --level debug` | 复现后改回 `info`；不加类加载器参数不会生效 |

---

## 五、热修复

| 场景 | 命令 | 说明 |
|------|------|------|
| 导出源码 | `jad --source-only com.example.order.OrderService > /tmp/OrderService.java` | 修改后再编译 |
| 编译 | `mc -c <classLoaderHash> /tmp/OrderService.java -d /tmp` | hash 取自 `sc -d`；失败时在本地用相同 JDK 编译后上传 |
| 加载新字节码 | `retransform /tmp/com/example/order/OrderService.class` | 只能改方法体，不能增删字段和方法 |
| 查看已生效的修改 | `retransform -l` | 列出 retransform 条目 |
| 回滚热修复 | `retransform --deleteAll && retransform --classPattern com.example.order.OrderService` | 删除条目后再显式触发一次才恢复原字节码 |

---

## 六、性能剖析与内存

| 场景 | 命令 | 说明 |
|------|------|------|
| 开始 CPU 采样 | `profiler start` | 内置 async-profiler，默认 `cpu` 事件 |
| 输出火焰图 | `profiler stop --file /tmp/cpu.html` | `.html` 后缀自动按火焰图输出 |
| 慢但 CPU 不高 | `profiler start --event wall --duration 30` | wall-clock 采样，30 秒后自动停止 |
| 内存分配热点 | `profiler start --event alloc` | 找频繁分配对象的代码 |
| 容器内 cpu 事件不可用 | `profiler start --event itimer` | `perf_events` 被安全策略限制时使用 |
| 堆转储 | `heapdump --live /tmp/heap.hprof` | 先触发 Full GC，会停顿应用 |
| JFR 录制 | `jfr start -n order --duration 60s -f /tmp/order.jfr` | `jfr status` 查看录制状态 |

---

## 七、会话技巧与收尾

| 场景 | 命令 | 说明 |
|------|------|------|
| 过滤输出 | `thread \| grep http-nio` | 结果可用管道接 `grep` 过滤，`grep -c` 只输出匹配行数 |
| 后台执行并写文件 | `trace com.example.order.OrderService createOrder '#cost > 200' >> /tmp/trace.log &` | 断开连接后仍在后台记录 |
| 查看与结束后台任务 | `jobs`、`kill <job-id>` | 后台任务也要及时结束 |
| 还原全部增强类 | `reset` | 不卸载 Arthas，`watch` 等增强全部撤销 |
| 卸载 Arthas | `stop` | 还原增强并关闭 Server；热修复需先按第五节回滚 |

---

## 小结

最该记住的 5 条：

- `thread -n 3`：CPU 高时直接看最忙的线程栈
- `trace <类> <方法> '#cost > 100' -n 5`：逐层拆解慢方法
- `watch <类> <方法> '{params, returnObj, throwExp}' -x 3 -n 5`：不改代码看入参、返回值和异常
- `sc -d <类>` + `jad <类>`：确认线上加载的类来自哪个 jar、代码是哪个版本
- `stop`：诊断结束还原增强并卸载，不要只 `quit`

## 参考资料

- Arthas 命令列表：[Arthas 命令列表](https://arthas.aliyun.com/doc/commands.html)
- 快速入门与启动：[启动 Arthas](https://arthas.aliyun.com/doc/start-arthas.html)
- watch 命令：[watch](https://arthas.aliyun.com/doc/watch.html)
- trace 命令：[trace](https://arthas.aliyun.com/doc/trace.html)
- tt 命令：[tt](https://arthas.aliyun.com/doc/tt.html)
- vmtool 命令：[vmtool](https://arthas.aliyun.com/doc/vmtool.html)
- retransform 命令：[retransform](https://arthas.aliyun.com/doc/retransform.html)
- profiler 命令：[profiler](https://arthas.aliyun.com/doc/profiler.html)
- jfr 命令：[jfr](https://arthas.aliyun.com/doc/jfr.html)
- 后台异步任务：[异步任务](https://arthas.aliyun.com/doc/async.html)

> 下一篇：[JVM 参数与 GC 日志速查](./4_jvm)
