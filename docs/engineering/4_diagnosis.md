# 线上诊断

> JVM 监控工具详见 [jvm/8_monitoring_tools](../jvm/8_monitoring_tools)，按故障类型排查详见 [jvm/9_troubleshooting](../jvm/9_troubleshooting)。
>
> 本文聚焦 Arthas 在线诊断。

---

## 一、Arthas

阿里开源的 Java 诊断工具，**无需重启、无需修改代码**，生产可用。

官网：[arthas.aliyun.com](https://arthas.aliyun.com/) | 源码：[github.com/alibaba/arthas](https://github.com/alibaba/arthas)

### 快速启动

```bash
curl -O https://arthas.aliyun.com/arthas-boot.jar
java -jar arthas-boot.jar           # 列出 JVM 进程，输入序号附着
java -jar arthas-boot.jar <pid>     # 直接指定 PID
```

### dashboard — 实时总览

```bash
dashboard    # 每 5s 刷新一次，展示线程、内存、GC 整体状态
```

输出包含：线程列表（CPU 使用率、状态）、JVM 内存区域使用情况、GC 次数和耗时。

### watch — 观察方法入参 / 返回值 / 异常

```bash
# 观察入参和返回值，展开 3 层
watch com.example.OrderService createOrder "{params, returnObj}" -x 3

# 只在抛异常时打印
watch com.example.OrderService createOrder "{params, throwExp}" -e

# 条件过滤（只看 userId=1001 的请求）
watch com.example.OrderService createOrder "{params, returnObj}" \
  'params[0].userId == "1001"' -x 3 -n 10
# -n 10：只执行 10 次后退出

# 表达式变量说明：
# params: 入参数组
# returnObj: 返回值
# throwExp: 异常对象
# target: 当前对象 (this)
```

### trace — 方法调用链耗时分析

```bash
# 追踪 createOrder 内所有子调用耗时
trace com.example.OrderService createOrder

# 只显示耗时 > 100ms 的调用
trace com.example.OrderService createOrder '#cost > 100'

# 追踪多级调用（-E 正则匹配多个类/方法，展开嵌套调用）
trace -E com.example.OrderService|com.example.InventoryService 'createOrder|deductStock'

# 追踪 Spring MVC 入口定位慢接口
trace org.springframework.web.servlet.DispatcherServlet doDispatch '#cost > 500'
```

输出示例：
```
`---[85ms] com.example.OrderService.createOrder()
    +---[2ms]  validateOrder()
    +---[70ms] inventoryService.deductStock()    ← 瓶颈在这里
    `---[3ms]  orderRepo.save()
```

### tt — 时间隧道（记录调用，事后回放）

```bash
tt -t com.example.OrderService createOrder -n 100   # 记录最近 100 次
tt -l                                                # 列出已记录的调用
tt -i 1003 -w '{params, returnObj}'                 # 查看第 1003 次详情
tt -p -i 1003                                       # 重新执行该次调用
```

### ognl — 动态执行表达式

```bash
# 调用静态方法
ognl "@com.example.utils.DateUtils@format(new java.util.Date())"

# 从 Spring 容器取 Bean 并调用（不重启修改运行时状态）
ognl '#ctx=@org.springframework.web.context.ContextLoader@getCurrentWebApplicationContext(),
      #ctx.getBean("orderService").getOrderById("1001")'

# 修改静态开关（紧急临时关闭功能）
ognl '@com.example.config.FeatureFlag@NEW_PAYMENT_ENABLED = false'
```

### jad — 反编译

查看运行时实际加载的类（排查是否加载了预期版本）：

```bash
jad com.example.OrderService                 # 反编译整个类
jad com.example.OrderService createOrder     # 只反编译指定方法
```

### 其他常用命令

```bash
stack java.lang.System exit          # 查看谁调用了 System.exit
redefine /tmp/OrderService.class     # 热更新 class（只能改方法体）
thread -b                            # 找出阻塞其他线程最多的线程（死锁排查）
```

---

## 二、JDK 自带工具与故障排查

- **JDK 自带工具**（jps / jstack / jmap / jstat / jinfo / MAT / VisualVM / JFR / GC 日志分析）→ [jvm/8_monitoring_tools](../jvm/8_monitoring_tools)
- **按故障类型排查**（各类 OOM / StackOverflowError / CPU 高 / 死锁 / 类加载失败 / 速查表）→ [jvm/9_troubleshooting](../jvm/9_troubleshooting)
- **Profiler**（JProfiler / async-profiler 火焰图）→ [high-perf/3_profilers](../high-perf/3_profilers)
