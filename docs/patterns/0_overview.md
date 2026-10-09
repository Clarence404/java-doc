# 设计模式总览

GoF（Gang of Four）23 种经典设计模式，出自《设计模式：可复用面向对象软件的基础》，总结了面向对象设计中反复出现的「怎么创建对象、怎么组合对象、对象之间怎么协作」三类问题的成熟解法。本模块每篇按同一结构展开：定义与角色（附类图）→ JDK 21 实现 → JDK 与 Spring 中的真实应用 → 适用场景与常见坑 → 与相近模式的区别。

版本基线：示例代码默认 **JDK 21**（record、sealed、switch 表达式、文本块），Spring 相关类名以 **Spring Framework 6.x / 7.x** 为准。模式本身与语言版本无关，但不少经典写法在现代 Java 中有更简洁的替代（如用 lambda 代替只有一个方法的策略类、用 record 代替简单的建造者），文中会单独说明。

---

## 一、模块导航

<ModuleNav />

---

## 二、推荐阅读路径

1. 先读本页的 [设计原则](#五、设计原则)，后面每个模式都是某几条原则的具体落地
2. 按使用频率优先读这 10 个：[单例模式](./1_creational_singleton) → [工厂模式](./2_creational_factory) → [建造者模式](./4_creational_builder) → [代理模式](./12_structural_proxy) → [装饰器模式](./9_structural_decorator) → [适配器模式](./6_structural_adapter) → [策略模式](./20_behavioral_strategy) → [模板方法模式](./21_behavioral_template_method) → [观察者模式](./18_behavioral_observer) → [责任链模式](./13_behavioral_chain_of_responsibility)
3. 再读容易混淆的几组：[抽象工厂模式](./3_creational_abstract_factory) 与工厂方法、[桥接模式](./7_structural_bridge) 与策略模式、[外观模式](./10_structural_facade) 与 [中介者模式](./16_behavioral_mediator)、[状态模式](./19_behavioral_state) 与策略模式
4. 其余模式按需查阅：[原型模式](./5_creational_prototype)、[组合模式](./8_structural_composite)、[享元模式](./11_structural_flyweight)、[命令模式](./14_behavioral_command)、[迭代器模式](./15_behavioral_iterator)、[备忘录模式](./17_behavioral_memento)、[访问者模式](./22_behavioral_visitor)、[解释器模式](./23_behavioral_interpreter)

[高频面试题](./99_interview) 只列题目，答案在 [设计模式面试题解答](/interview/17_patterns)。

---

## 三、三大分类

![GoF 23 种模式的三大分类](../assets/patterns/pattern-categories.svg)

| 分类 | 解决的问题 | 模式 |
|------|-----------|------|
| 创建型（5 种） | 怎么创建对象，把「创建」与「使用」解耦 | 单例、工厂方法、抽象工厂、建造者、原型 |
| 结构型（7 种） | 怎么把类和对象组合成更大的结构 | 适配器、桥接、组合、装饰器、外观、享元、代理 |
| 行为型（11 种） | 对象之间怎么分配职责、怎么通信 | 责任链、命令、迭代器、中介者、备忘录、观察者、状态、策略、模板方法、访问者、解释器 |

---

## 四、23 种模式索引

| # | 模式 | 分类 | 核心意图 | JDK / Spring 中的例子 |
|---|------|------|---------|---------------------|
| 1 | 单例（Singleton） | 创建型 | 全局唯一实例 | `Runtime.getRuntime()`；Spring 单例 Bean 是「每容器每 bean 名一个」，不是 GoF 单例 |
| 2 | 工厂方法（Factory Method） | 创建型 | 子类决定实例化哪个类 | `Collection.iterator()`、Spring `FactoryBean` |
| 3 | 抽象工厂（Abstract Factory） | 创建型 | 创建一族相关对象 | JDBC `Connection`（`createStatement` 等）、`DocumentBuilderFactory` |
| 4 | 建造者（Builder） | 创建型 | 分步构建复杂对象 | `HttpClient.newBuilder()`、`UriComponentsBuilder` |
| 5 | 原型（Prototype） | 创建型 | 复制已有对象 | `Object.clone()`、`ArrayList.clone()`、复制构造方法 |
| 6 | 适配器（Adapter） | 结构型 | 转换不兼容接口 | `Arrays.asList`、`InputStreamReader`、Spring `HandlerAdapter` |
| 7 | 桥接（Bridge） | 结构型 | 分离两个独立变化的维度 | 无公认 JDK 例子；业务中的「消息类型 × 发送渠道」 |
| 8 | 组合（Composite） | 结构型 | 树形结构统一处理 | `java.awt.Container`、Spring `CompositeCacheManager` |
| 9 | 装饰器（Decorator） | 结构型 | 动态叠加功能 | `BufferedInputStream`、`HttpServletRequestWrapper` |
| 10 | 外观（Facade） | 结构型 | 简化子系统接口 | SLF4J、Service 层聚合多个子系统 |
| 11 | 享元（Flyweight） | 结构型 | 共享细粒度对象节省内存 | `Integer.valueOf` 缓存、字符串常量池 |
| 12 | 代理（Proxy） | 结构型 | 控制对象访问 | `java.lang.reflect.Proxy`、Spring AOP |
| 13 | 责任链（Chain of Responsibility） | 行为型 | 请求沿链处理 | Servlet `FilterChain`、Spring Security 过滤器链、Netty `ChannelPipeline` |
| 14 | 命令（Command） | 行为型 | 请求封装为对象 | `Runnable` / `Callable` 提交给 `Executor` |
| 15 | 迭代器（Iterator） | 行为型 | 顺序遍历不暴露内部 | `Iterator`、`Spliterator` |
| 16 | 中介者（Mediator） | 行为型 | 集中管理对象间通信 | `java.util.Timer`、`ExecutorService`（Refactoring.Guru 列举） |
| 17 | 备忘录（Memento） | 行为型 | 保存 / 恢复对象状态 | 编辑器撤销 / 重做、快照恢复 |
| 18 | 观察者（Observer） | 行为型 | 状态变化自动通知 | Spring 事件（`@EventListener`）、`PropertyChangeListener` |
| 19 | 状态（State） | 行为型 | 状态驱动行为切换 | 订单状态机、Spring Statemachine |
| 20 | 策略（Strategy） | 行为型 | 算法族可互换 | `Comparator`、线程池 `RejectedExecutionHandler` |
| 21 | 模板方法（Template Method） | 行为型 | 固定骨架，子类实现步骤 | `AbstractList`、`AbstractApplicationContext.refresh()` |
| 22 | 访问者（Visitor） | 行为型 | 不修改类增加操作 | `FileVisitor`（`Files.walkFileTree`）、Spring `BeanDefinitionVisitor` |
| 23 | 解释器（Interpreter） | 行为型 | 为语言定义文法并解释 | SpEL、`java.util.regex.Pattern` |

---

## 五、设计原则

### 1、六大原则

| 原则 | 简称 | 核心含义 |
|------|------|---------|
| 单一职责原则（Single Responsibility Principle） | SRP | 一个类只有一个引起它变化的原因，职责混在一起改一处会牵连另一处 |
| 开闭原则（Open/Closed Principle） | OCP | 对扩展开放，对修改关闭：新增功能靠新增代码，而不是改已有代码 |
| 里氏替换原则（Liskov Substitution Principle） | LSP | 子类必须能替换父类使用，不能削弱父类的契约 |
| 接口隔离原则（Interface Segregation Principle） | ISP | 接口要小而专，客户端不应被迫依赖它用不到的方法 |
| 依赖倒置原则（Dependency Inversion Principle） | DIP | 高层与低层都依赖抽象，而不是高层直接依赖具体实现 |
| 迪米特法则（Law of Demeter） | LoD | 最少知道原则：只和直接的朋友通信，不要 `a.getB().getC().doX()` |

前五条的英文首字母即 **SOLID**；国内常说的「六大原则」是 SOLID 再加迪米特法则。

### 2、合成复用原则

**合成复用原则（Composite Reuse Principle，CRP）**：优先使用组合 / 聚合，而不是继承来复用代码。GoF 原书将其表述为「优先使用对象组合，而不是类继承」。它不在六大原则之列，但贯穿了大多数结构型和行为型模式：适配器、桥接、装饰器、代理、策略、状态都是用「持有一个对象」代替「继承一个类」。

---

## 六、关联模块

- 代理模式的底层实现（JDK 动态代理、CGLIB、ByteBuddy） → [动态代理](/java/16_topic_proxy)
- 双重检查锁单例与指令重排 → [JMM 内存模型](/java/22_topic_jmm)
- 枚举单例的序列化与反射防护 → [枚举](/java/12_topic_enum)
- 观察者模式在 Spring 中的落地 → [事件机制](/spring/7_event)
- IoC 容器中的工厂、单例、模板方法 → [Spring 总览](/spring/0_overview)
- 架构层面的模式（分层、CQRS、DDD） → [系统架构总览](/architecture/0_overview)
- 分布式系统层面的模式（熔断、Saga、Sidecar） → [微服务设计模式](/microservices/2_patterns)
- 本模块高频问题的答案汇总 → [设计模式面试题解答](/interview/17_patterns)
