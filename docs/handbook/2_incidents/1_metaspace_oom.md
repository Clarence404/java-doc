---
description: Groovy 规则逐次编译导致 Metaspace 溢出、类加载器统计、类卸载条件、按版本预编译与告警
---

# Metaspace 溢出

> 前置阅读：[故障排查](/jvm/9_troubleshooting)、[类加载机制](/jvm/2_class_loading)

促销规则引擎每次匹配都重新编译 Groovy 脚本，一天半后撑爆 Metaspace。本篇复盘类加载器统计的定位过程与按版本预编译的修复，基线为 JDK 21、Spring Boot 4。

---

## 一、现象

order-service 的 JVM 参数为 `-Xms4g -Xmx4g -XX:MaxMetaspaceSize=512m`，10 月 3 日 09:00 发布 v2.38.0（新增"满减规则支持 Groovy 表达式"）。

| 时间 | 告警 / 现象 |
|------|-------------|
| 10-04 14:00 起 | GC 日志中 `Metadata GC Threshold` 触发的 GC 越来越频繁，无人关注 |
| 10-04 20:12 | `JvmFullGcFrequent`：5 分钟内 Full GC 9 次，原因 `Metadata GC Clear Soft References` |
| 10-04 20:19 | 日志出现 `java.lang.OutOfMemoryError: Metaspace`，结算、下单接口错误率 64% |
| 10-04 20:25 | 6 个 Pod 中 4 个先后出现同样错误 |

`jvm_classes_loaded_classes` 从发布时的 1.9 万**线性**涨到 12.2 万，`jvm_classes_unloaded_classes_total` 基本为 0；而堆使用正常，老年代 GC 后只有 1.2GB。

---

## 二、影响

- 20:19–20:47 约 28 分钟，涉及满减活动的结算请求大面积失败，约 8,600 笔订单未能提交
- Metaspace 满后，凡是需要加载新类的路径都会失败（包括 Jackson 首次序列化某个类型、异常栈中首次用到的类），错误分散在各个接口，告警噪声很大
- 频繁 Full GC 让未报错的请求 P99 也升到 3s 以上

---

## 三、排查过程

### 1、确认 OOM 类型与 GC 原因

```bash
kubectl logs order-service-5c8b-9tq7w --since=1h | grep -m1 -A6 "OutOfMemoryError"
kubectl exec order-service-5c8b-9tq7w -- grep -E "Metadata GC" /data/logs/gc.log | tail -4
```

示例输出：

```text
java.lang.OutOfMemoryError: Metaspace
	at java.base/java.lang.ClassLoader.defineClass1(Native Method)
	at java.base/java.lang.ClassLoader.defineClass(ClassLoader.java:1027)
	at groovy.lang.GroovyClassLoader$ClassCollector.createClass(GroovyClassLoader.java:...)
	...
[2026-10-04T20:17:41.205+0800][info][gc] GC(9311) Pause Young (Concurrent Start) (Metadata GC Threshold) 1402M->1388M(4096M) 21.784ms
[2026-10-04T20:17:44.912+0800][info][gc] GC(9314) Pause Full (Metadata GC Threshold) 1391M->1205M(4096M) 1312.406ms
[2026-10-04T20:17:46.330+0800][info][gc] GC(9315) Pause Full (Metadata GC Clear Soft References) 1205M->1198M(4096M) 1287.951ms
```

消息是 `Metaspace`，栈里出现 `GroovyClassLoader`；Full GC 后堆有大量空闲，GC 是被元空间阈值逼出来的，而且回收不掉元数据。

### 2、看元空间和类数量趋势

```bash
kubectl exec order-service-5c8b-9tq7w -- jstat -gcutil 1 10000 3
```

示例输出：

```text
  S0     S1     E      O      M     CCS    YGC     YGCT     FGC    FGCT     CGC    CGCT       GCT
  0.00   0.00  31.25  29.40  99.61  98.87  21877  301.442    86  112.376   3984  141.209   555.027
  0.00   0.00   6.25  29.12  99.73  98.92  21878  301.458    87  113.689   3986  141.288   556.435
  0.00   0.00   0.00  29.05  99.82  99.01  21878  301.458    88  114.977   3986  141.288   557.723
```

`M`（元空间）和 `CCS`（压缩类空间）接近 100%，`O` 只有 29%：问题不在堆。

### 3、哪个类加载器加载了这么多类

```bash
kubectl exec order-service-5c8b-9tq7w -- jcmd 1 VM.classloader_stats | sort -k4 -n -r | head -5
kubectl exec order-service-5c8b-9tq7w -- jcmd 1 VM.classloader_stats | tail -3
```

示例输出（节选）：

```text
0x0000000801b3c2a8  0x0000000801b30c10  0x00007f2a9c4e1d30   18412  98566144  97821312  org.springframework.boot.loader.launch.LaunchedClassLoader
0x0000000800a1f6d8  0x0000000000000000  0x00007f2a9c0f2e10   11       45056     40448  jdk.internal.reflect.DelegatingClassLoader
...
Total = 98661                                                122123  498073600  490217472
ChunkSz: Total size of all allocated metaspace chunks
BlockSz: Total size of all allocated metaspace blocks (each chunk has several blocks)
```

加载器总数近 10 万，远超正常应用的几十个。用 Arthas 按类型汇总更直观：

```bash
[arthas@1]$ classloader
```

示例输出（节选）：

```text
 name                                                         numberOfInstances  loadedCountTotal
 groovy.lang.GroovyClassLoader$InnerLoader                    98412              98412
 org.springframework.boot.loader.launch.LaunchedClassLoader   1                  18412
 BootstrapClassLoader                                         1                  4987
 jdk.internal.loader.ClassLoaders$PlatformClassLoader         1                  312
```

9.8 万个 `GroovyClassLoader$InnerLoader`，每个加载 1 个类：每编译一次 Groovy 脚本就产生一个新加载器和一个新类。

### 4、定位调用点

```bash
[arthas@1]$ stack groovy.lang.GroovyShell parse -n 1
```

示例输出（节选）：

```text
ts=2026-10-04 20:31:08.117;thread_name=http-nio-8080-exec-12;id=94;is_daemon=true;priority=5;TCCL=...LaunchedClassLoader@6d4a1f2e
    @groovy.lang.GroovyShell.parse()
        at com.example.order.promotion.GroovyRuleEvaluator.match(GroovyRuleEvaluator.java:41)
        at com.example.order.promotion.PromotionEngine.applicableRules(PromotionEngine.java:77)
        at com.example.order.checkout.CheckoutService.calculate(CheckoutService.java:132)
```

再用 `monitor -c 60 groovy.lang.GroovyShell parse` 统计，晚高峰每分钟约 60 次，与命中 Groovy 满减规则的结算请求数吻合。

---

## 四、根因

```java
@Component
public class GroovyRuleEvaluator {
    private final GroovyShell shell = new GroovyShell();   // 单例，背后是一个长期存活的 GroovyClassLoader

    public boolean match(PromotionRule rule, OrderContext ctx) {
        Script script = shell.parse(rule.getExpression());  // 每次调用都编译出一个新类
        script.setBinding(new Binding(Map.of("order", ctx)));
        return (Boolean) script.run();
    }
}
```

- 每次 `parse` 都会生成一个新的脚本类（类名形如 `Script12345`），由新的 `InnerLoader` 定义，元数据放在 Metaspace
- 类只有在**它的类加载器不可达**时才能卸载；这些类都挂在单例 `GroovyShell` 的 `GroovyClassLoader` 之下，加载器一直存活，类就一个也卸载不掉
- Groovy 规则只有 3 条，却在一天半里被编译了 9.8 万次；`MaxMetaspaceSize=512m` 让问题以 OOM 暴露出来，没设上限时则会表现为容器 RSS 持续上涨直至 OOMKilled

---

## 五、修复

### 1、止血

- 20:33 回滚到 v2.37.2（规则仍按旧的固定类型匹配），滚动重启后 Metaspace 回到约 110MB
- 回滚前对一个 Pod 执行 `jcmd 1 VM.classloader_stats > /data/dump/cls.txt` 并拷出，保留证据

### 2、根治：按规则版本预编译

规则变更走"发布版本"，每个版本只编译一次，旧版本整体丢弃，让旧的类加载器可回收：

```java
@Component
public class GroovyRuleEvaluator {

    private volatile CompiledRules current = CompiledRules.EMPTY;

    /** 规则发布（或启动加载）时调用，一个版本只编译一次 */
    public void publish(long version, List<PromotionRule> rules) {
        CompilerConfiguration config = new CompilerConfiguration();
        config.addCompilationCustomizers(new SecureASTCustomizer());   // 限制脚本能力，按需配置白名单
        GroovyClassLoader loader = new GroovyClassLoader(getClass().getClassLoader(), config);

        Map<Long, Class<? extends Script>> classes = new HashMap<>();
        for (PromotionRule r : rules) {
            classes.put(r.getId(), loader.parseClass(r.getExpression(), "Rule_" + r.getId() + "_v" + version + ".groovy")
                    .asSubclass(Script.class));
        }
        current = new CompiledRules(version, Map.copyOf(classes));
        // 旧的 CompiledRules 不再被引用 → 旧 loader 不可达 → 下次 GC 可卸载旧版本的全部类
    }

    public boolean match(PromotionRule rule, OrderContext ctx) {
        Class<? extends Script> clazz = current.classes().get(rule.getId());
        Script script = InvokerHelper.createScript(clazz, new Binding(Map.of("order", ctx)));  // Script 实例非线程安全，每次新建
        return (Boolean) script.run();
    }

    record CompiledRules(long version, Map<Long, Class<? extends Script>> classes) {
        static final CompiledRules EMPTY = new CompiledRules(0, Map.of());
    }
}
```

上线后压测 2 小时：`jvm_classes_loaded_classes` 稳定在 1.95 万左右，每发布一次规则版本只增加几个，随后 `jvm_classes_unloaded_classes_total` 同步增加。

JVM 参数保持 `-XX:MaxMetaspaceSize=512m`（元空间问题以 OOM 暴露，比容器被杀更容易定位），并补充 `-XX:+ExitOnOutOfMemoryError`。

---

## 六、预防

**监控告警**：

```yaml
- alert: JvmClassesLoadedGrowing
  # 类数量 1 小时内增长超过 5000，且不是刚启动
  expr: delta(jvm_classes_loaded_classes[1h]) > 5000 and process_uptime_seconds > 3600
  for: 30m
  labels: {severity: warning}
- alert: JvmMetaspaceHigh
  expr: |
    jvm_memory_used_bytes{id="Metaspace"} / jvm_memory_max_bytes{id="Metaspace"} > 0.85
  for: 10m
  labels: {severity: critical}
```

**代码规范**：

- 动态生成类的代码（Groovy、Janino、ByteBuddy、CGLIB、`Proxy`、JAXB / 序列化框架的上下文）只能在初始化或配置变更时执行，禁止出现在请求路径上
- 生成的类必须有明确的生命周期：要么全局缓存且数量有界，要么和一个可丢弃的类加载器绑定

**测试**：

- 对规则引擎写一个"重复执行 10 万次"的测试，断言前后 `ClassLoadingMXBean.getLoadedClassCount()` 增长小于固定阈值
- 稳定性压测的看板加入 `jvm_classes_loaded_classes`，曲线必须在启动后走平

---

## 七、涉及知识点

- Metaspace OOM 的排查命令：[故障排查](/jvm/9_troubleshooting#五、outofmemoryerror-metaspace)
- 元空间与压缩类空间：[内存结构](/jvm/1_memory#_5、方法区-元空间)
- 类加载器与类卸载条件：[类加载机制](/jvm/2_class_loading#_4、热部署与类卸载)
- 动态代理与生成类的常见问题：[动态代理](/java/16_topic_proxy)
- Arthas `classloader` / `stack` / `monitor`：[线上诊断](/engineering/7_diagnosis)
- `VM.classloader_stats` 等 jcmd 命令：[诊断工具](/jvm/8_monitoring_tools#二、jcmd-诊断命令总入口)

---

## 小结

- `Metaspace` OOM 的典型画像：堆不高、类数量线性增长、卸载数为 0、GC 原因是 `Metadata GC Threshold`
- 先看类加载器统计：某类加载器实例数异常多，就是动态生成类的源头
- 类能否卸载取决于它的类加载器是否可达；生成类要么有界缓存，要么绑定可丢弃的加载器
- 保留 `MaxMetaspaceSize` 上限，让问题以明确的 OOM 暴露，而不是容器被杀

## 参考资料

- 元空间与类元数据：[Other Considerations — HotSpot GC Tuning Guide](https://docs.oracle.com/en/java/javase/21/gctuning/other-considerations.html)
- `VM.classloader_stats`、`VM.metaspace`：[The jcmd Command](https://docs.oracle.com/en/java/javase/21/docs/specs/man/jcmd.html)
- `-XX:MaxMetaspaceSize`：[The java Command](https://docs.oracle.com/en/java/javase/21/docs/specs/man/java.html)
- Groovy 集成方式与 GroovyClassLoader：[Integrating Groovy into applications](https://groovy-lang.org/integrating.html)
- Arthas `classloader` 命令：[Arthas classloader](https://arthas.aliyun.com/en/doc/classloader.html)

> 下一篇：[频繁 Full GC](./2_full_gc)
