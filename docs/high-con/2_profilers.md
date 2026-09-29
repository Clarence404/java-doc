# 性能分析工具

> 本文聚焦图形化 / 采样型 Profiler。命令行诊断工具见：
> - JDK 自带工具（jps / jstack / jmap / jstat / MAT / JFR 等）→ [jvm/7_monitoring_tools](../jvm/7_monitoring_tools)
> - Arthas 在线诊断（dashboard / trace / watch / jad / ognl 等）→ [engineering/4_diagnosis](../engineering/4_diagnosis)
> - 按故障类型排查及常见问题速查表 → [jvm/8_troubleshooting](../jvm/8_troubleshooting)

---

## 一、JProfiler（商业工具）

官网：[ej-technologies.com/jprofiler](https://www.ej-technologies.com/jprofiler)

JProfiler 提供图形界面，适合开发阶段深度分析：

| 功能 | 说明 |
|------|------|
| CPU Profiling | 方法级 CPU 时间采样，生成调用树 |
| 内存分析 | 对象分配堆栈、内存泄漏检测 |
| 线程分析 | 线程时间线、锁竞争热点 |
| JDBC 监控 | SQL 执行时间、慢查询 |

---

## 二、async-profiler 与火焰图

源码：[github.com/async-profiler/async-profiler](https://github.com/async-profiler/async-profiler)

开源低开销采样 Profiler，基于 `AsyncGetCallTrace` + `perf_events`，无 Safepoint 偏差，可生产使用，输出**火焰图**（横轴宽度 = 采样占比，越宽越热；纵轴 = 调用栈深度）。

```bash
# 采样 CPU 30 秒，生成 HTML 火焰图（3.x 为 asprof，2.x 为 profiler.sh）
asprof -d 30 -f /tmp/cpu.html <pid>

# 采样内存分配 / 锁竞争
asprof -e alloc -d 30 -f /tmp/alloc.html <pid>
asprof -e lock  -d 30 -f /tmp/lock.html  <pid>

# Arthas 内置 async-profiler
profiler start
profiler stop --format html
```
