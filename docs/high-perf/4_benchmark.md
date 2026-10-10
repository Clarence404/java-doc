---
description: 微基准的陷阱、JMH 注解与示例、结果解读
---

# 基准测试（JMH）

> 前置阅读：[性能分析工具](./3_profilers)

JMH（Java Microbenchmark Harness）是 OpenJDK 提供的微基准测试框架，用来可靠地测量**方法级、代码片段级**的性能差异：Profiler 告诉你"哪里慢"，JMH 回答"换一种写法能快多少"。本篇讲手写计时循环为什么不可信，以及如何用 JMH 写出可靠的微基准并正确解读结果。

---

## 一、为什么不能用 nanoTime 循环

### 1、朴素写法

**手写 `nanoTime` 循环测出来的数字通常不可信。** 典型的反例：

```java
@Slf4j
public class NaiveBenchmark {
    public static void main(String[] args) {
        long start = System.nanoTime();
        for (int i = 0; i < 1_000_000; i++) {
            String s = "a" + i;        // 结果未被使用，可能被 JIT 整段消除
        }
        long cost = System.nanoTime() - start;
        log.info("cost: {} ms", cost / 1_000_000);
    }
}
```

原因如下：

| 问题 | 说明 | 后果 |
|------|------|------|
| JIT 预热 | 代码先解释执行，达到阈值后才被 C1/C2 编译，前后性能可差数十倍 | 测到的是"解释 + 编译 + 执行"的混合 |
| 死代码消除（DCE） | 结果未被使用时，JIT 可能直接删除整段计算 | 测出"0 耗时"的假象 |
| 常量折叠 | 输入是编译期常量时，JIT 可在编译期算出结果 | 测的不是真实计算 |
| 循环优化 | 循环展开、循环不变量外提、OSR 编译 | 与真实调用场景的优化不同 |
| Profile 污染 | 同一 JVM 中先后测多个实现，前者收集的类型 profile 影响后者 | 测试顺序影响结论 |
| GC 与噪声 | 测量期间偶发 GC、其他进程干扰 | 单次测量波动大 |

JIT 的分层编译与优化手段见 [JIT 即时编译](/jvm/7_jit)。

### 2、JMH 如何解决

**JMH 把预热、进程隔离、结果消费和统计都做成了框架能力：**

- **Warmup**：正式测量前先执行若干轮预热迭代，让 JIT 编译稳定。
- **Fork**：每组测试在独立的 JVM 进程中运行，隔离 profile 污染。
- **Blackhole**：吞掉返回值，阻止死代码消除。
- **@State**：通过状态对象提供输入，避免常量折叠。
- **多轮迭代 + 统计**：给出平均值、误差区间，结果可重复。

---

## 二、工程搭建

### 1、Maven 依赖

```xml
<properties>
    <jmh.version>1.37</jmh.version>
</properties>

<dependencies>
    <dependency>
        <groupId>org.openjdk.jmh</groupId>
        <artifactId>jmh-core</artifactId>
        <version>${jmh.version}</version>
        <scope>test</scope>
    </dependency>
    <dependency>
        <groupId>org.openjdk.jmh</groupId>
        <artifactId>jmh-generator-annprocess</artifactId>
        <version>${jmh.version}</version>
        <scope>test</scope>
    </dependency>
</dependencies>
```

- `jmh-generator-annprocess` 是注解处理器，编译期根据 `@Benchmark` 生成实际的测试代码。
- 放在 `test` 作用域，基准代码写在 `src/test/java`，可以直接在 IDE 中通过 `main` 方法运行。
- 独立的基准工程可用官方 archetype 生成：`mvn archetype:generate -DarchetypeGroupId=org.openjdk.jmh -DarchetypeArtifactId=jmh-java-benchmark-archetype`，打包后以 `java -jar target/benchmarks.jar` 运行。

::: warning 新版 JDK 的注解处理
JDK 23 起 javac 默认不再自动运行 classpath 上的注解处理器。若运行时报 `Unable to find the resource: /META-INF/BenchmarkList`（说明基准代码没有生成），在 `maven-compiler-plugin` 中通过 `annotationProcessorPaths` 显式声明 `jmh-generator-annprocess`，或加编译参数 `-proc:full`。
:::

### 2、核心注解

| 注解 | 作用 | 常用取值 |
|------|------|----------|
| `@Benchmark` | 标记被测方法 | —— |
| `@BenchmarkMode` | 测量模式 | `Throughput`（ops/时间）、`AverageTime`（时间/op）、`SampleTime`（采样分布）、`SingleShotTime`（单次，测冷启动） |
| `@OutputTimeUnit` | 结果时间单位 | `TimeUnit.NANOSECONDS` / `MICROSECONDS` |
| `@Warmup` | 预热轮次与每轮时长 | `iterations = 3, time = 1` |
| `@Measurement` | 正式测量轮次与每轮时长 | `iterations = 5, time = 1` |
| `@Fork` | 独立 JVM 进程数，可附加 JVM 参数 | `value = 2, jvmArgs = {"-Xms1g", "-Xmx1g"}` |
| `@Threads` | 并发执行线程数 | `1`、`Threads.MAX` |
| `@State` | 状态对象的共享范围 | `Scope.Thread`（每线程一份）、`Scope.Benchmark`（全局共享）、`Scope.Group` |
| `@Setup` / `@TearDown` | 状态初始化与清理 | `Level.Trial` / `Iteration` / `Invocation` |
| `@Param` | 参数化，自动组合多组输入 | `{"10", "100", "1000"}` |

`Blackhole` 作为方法参数注入，调用 `bh.consume(x)` 消费中间结果；只有一个结果时直接 `return` 也能防止 DCE。

---

## 三、完整示例：字符串拼接

**用一个完整示例串起上面的注解**：对比循环中 `+` 拼接、`StringBuilder` 默认容量与预分配容量三种写法：

```java
package com.example.bench;

import org.openjdk.jmh.annotations.*;
import org.openjdk.jmh.infra.Blackhole;
import org.openjdk.jmh.runner.Runner;
import org.openjdk.jmh.runner.RunnerException;
import org.openjdk.jmh.runner.options.Options;
import org.openjdk.jmh.runner.options.OptionsBuilder;

import java.util.concurrent.TimeUnit;

@BenchmarkMode(Mode.AverageTime)
@OutputTimeUnit(TimeUnit.MICROSECONDS)
@Warmup(iterations = 3, time = 1)
@Measurement(iterations = 5, time = 1)
@Fork(2)
@State(Scope.Thread)
public class StringConcatBenchmark {

    @Param({"10", "100", "1000"})
    private int size;

    private String[] parts;

    @Setup(Level.Trial)
    public void setup() {
        parts = new String[size];
        for (int i = 0; i < size; i++) {
            parts[i] = "item-" + i;
        }
    }

    @Benchmark
    public String plusInLoop() {
        String result = "";
        for (String p : parts) {
            result += p;               // 每次循环都生成新 String 并复制已有内容
        }
        return result;                 // 返回值由 JMH 消费，避免 DCE
    }

    @Benchmark
    public String builderDefault() {
        StringBuilder sb = new StringBuilder();
        for (String p : parts) {
            sb.append(p);
        }
        return sb.toString();
    }

    @Benchmark
    public void builderPresized(Blackhole bh) {
        StringBuilder sb = new StringBuilder(size * 10);
        for (String p : parts) {
            sb.append(p);
        }
        bh.consume(sb.toString());     // 等价写法：显式交给 Blackhole
    }

    public static void main(String[] args) throws RunnerException {
        Options opt = new OptionsBuilder()
                .include(StringConcatBenchmark.class.getSimpleName())
                .build();
        new Runner(opt).run();
    }
}
```

---

## 四、运行与解读结果

### 1、运行方式

| 方式 | 命令 | 适用 |
|------|------|------|
| IDE | 直接运行 `main` 方法 | 开发中快速对比 |
| 独立 jar | `java -jar target/benchmarks.jar StringConcat -f 2 -wi 3 -i 5` | 正式测试，结果更稳定 |
| 附加 Profiler | `-prof gc`（分配速率）、`-prof stack`、`-prof async:libPath=<libasyncProfiler.so 路径>` | 解释"为什么快/慢" |
| 输出文件 | `-rf json -rff result.json` | 结果归档、可视化（如 JMH Visualizer） |

### 2、结果示例

**解读结果时看误差区间和趋势，不看单个数字：**

```text
Benchmark                              (size)  Mode  Cnt    Score    Error  Units
StringConcatBenchmark.builderDefault       10  avgt   10    0.085 ±  0.002  us/op
StringConcatBenchmark.builderDefault     1000  avgt   10    9.812 ±  0.301  us/op
StringConcatBenchmark.builderPresized    1000  avgt   10    7.604 ±  0.215  us/op
StringConcatBenchmark.plusInLoop           10  avgt   10    0.190 ±  0.006  us/op
StringConcatBenchmark.plusInLoop         1000  avgt   10  812.447 ± 20.513  us/op
```

> 以上为示意数据，实际数值取决于硬件与 JDK 版本。

| 列 | 含义 |
|----|------|
| `(size)` | `@Param` 参数值 |
| `Mode` | `avgt` 平均时间，`thrpt` 吞吐量 |
| `Cnt` | 测量样本数 = Fork 数 × Measurement 轮数 |
| `Score ± Error` | 得分与 99.9% 置信区间误差 |

解读要点：

- **看误差区间是否重叠**：两组结果的 `Score ± Error` 区间重叠，说明差异不显著，不能下结论。
- **看趋势而非单点**：`plusInLoop` 随 size 增长呈平方级恶化（每次拼接都复制已有内容），而 `StringBuilder` 近似线性——这比某一个具体数字更有价值。
- **结合 `-prof gc`**：`gc.alloc.rate.norm`（每次操作分配字节数）常常能直接解释性能差异。

---

## 五、常见陷阱

**大部分错误结论都来自下面几类问题：**

| 陷阱 | 错误做法 | 正确做法 |
|------|----------|----------|
| 死代码消除 | 计算结果不返回也不消费 | `return` 结果或 `bh.consume()` |
| 常量折叠 | 在方法内使用字面量常量作为输入 | 输入放在 `@State` 对象的非 final 字段中 |
| 在 @Benchmark 中循环 | 自己写 `for` 循环重复调用被测代码 | 让 JMH 控制调用次数；确需批量时用 `@OperationsPerInvocation` |
| `Level.Invocation` 滥用 | 每次调用都执行 `@Setup` | 仅在必要时使用，其自身开销会污染纳秒级测量 |
| Fork 为 0 | `@Fork(0)` 在当前 JVM 运行 | 至少 `@Fork(1)`，正式测试用 2 以上 |
| 忽略参数规模 | 只测一个输入规模 | 用 `@Param` 覆盖小、中、大规模 |
| 笔记本测试 | 在开启睿频、节能模式、运行其他程序的机器上测 | 固定 CPU 频率、关闭干扰进程，或在专用机器上测 |
| 结论外推 | 微基准快 30%，就认为接口会快 30% | 按 [Amdahl 定律](./2_methodology) 乘以该方法的耗时占比，再用压测验证 |

---

## 六、JMH 与压测的分工

**两者粒度不同、不能相互替代：**

| 对比项 | JMH 基准测试 | 压测 |
|--------|--------------|------|
| 粒度 | 方法、代码片段、数据结构 | 接口、服务、整条链路 |
| 目的 | 比较实现方案、验证微优化、防止性能回退 | 评估容量、找拐点、验证 SLA |
| 环境 | 单 JVM，无网络、无外部依赖 | 接近线上的完整环境 |
| 指标 | ns/op、ops/s、分配字节数 | QPS、P99、错误率、资源使用率 |
| 工具 | JMH | JMeter、k6、Gatling、wrk |

JMH 回答"**A 写法比 B 写法快多少**"，压测回答"**系统能扛多少流量**"。压测方法与工具见 [性能测试](/testing/7_performance_test)，容量评估见 [容量评估与规划](/high-con/8_capacity_planning)。

---

## 小结

- 手写计时循环会被 JIT 预热、死代码消除、常量折叠、Profile 污染干扰，结论不可信
- JMH 用 Warmup、Fork、Blackhole、`@State` 解决这些问题，正式测试至少 `@Fork(2)`
- 解读结果看误差区间是否重叠、看随 `@Param` 规模变化的趋势，用 `-prof gc` 解释差异
- 微基准收益要按耗时占比折算，系统级结论以压测为准

## 参考资料

- [OpenJDK JMH](https://github.com/openjdk/jmh)
- [JMH Samples](https://github.com/openjdk/jmh/tree/master/jmh-samples/src/main/java/org/openjdk/jmh/samples)

> 下一篇：[JVM 层性能策略](./5_jvm_tuning) —— 从代码片段上升到运行时：收集器、分配速率、容器内存与 JIT 预热。
