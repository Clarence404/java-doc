# 设计模式总览

GoF（Gang of Four）23 种经典设计模式，归纳自《设计模式：可复用面向对象软件的基础》，覆盖面向对象设计中反复出现的结构与行为问题。

---

## 一、三大分类

```
创建型（Creational）          结构型（Structural）          行为型（Behavioral）
─────────────────────        ─────────────────────        ──────────────────────────
解决"怎么创建对象"            解决"怎么组合类与对象"         解决"对象间怎么通信与协作"

单例    Singleton             适配器  Adapter               责任链  Chain of Responsibility
工厂    Factory Method        桥接    Bridge                命令    Command
抽象工厂 Abstract Factory      组合    Composite             迭代器  Iterator
建造者  Builder               装饰器  Decorator             中介者  Mediator
原型    Prototype             外观    Facade                备忘录  Memento
                              享元    Flyweight             观察者  Observer
                              代理    Proxy                 状态    State
                                                           策略    Strategy
                                                           模板方法 Template Method
                                                           访问者  Visitor
                                                           解释器  Interpreter
```

---

## 二、23 种模式索引

| # | 模式 | 分类 | 核心意图 | Java/Spring 典型应用 |
|---|------|------|---------|---------------------|
| 1 | 单例（Singleton）| 创建型 | 全局唯一实例 | Spring Bean（默认）、HikariCP 连接池 |
| 2 | 工厂方法（Factory Method）| 创建型 | 子类决定实例化哪个类 | BeanFactory、DriverManager |
| 3 | 抽象工厂（Abstract Factory）| 创建型 | 创建一族相关对象 | JDBC 多数据库支持 |
| 4 | 建造者（Builder）| 创建型 | 分步构建复杂对象 | Lombok @Builder、UriComponentsBuilder |
| 5 | 原型（Prototype）| 创建型 | 克隆已有对象 | Spring scope=prototype、BeanUtils.copy |
| 6 | 适配器（Adapter）| 结构型 | 转换不兼容接口 | Arrays.asList、InputStreamReader |
| 7 | 桥接（Bridge）| 结构型 | 分离抽象与实现 | JDBC（Connection 抽象 + 各 DB 实现）|
| 8 | 组合（Composite）| 结构型 | 树形结构统一处理 | 菜单树、文件系统、权限树 |
| 9 | 装饰器（Decorator）| 结构型 | 动态增强对象功能 | Java I/O 流、HttpServletRequestWrapper |
| 10 | 外观（Facade）| 结构型 | 简化子系统接口 | Service 层聚合、JdbcTemplate |
| 11 | 享元（Flyweight）| 结构型 | 共享细粒度对象节省内存 | String 常量池、Integer.valueOf 缓存 |
| 12 | 代理（Proxy）| 结构型 | 控制对象访问 | Spring AOP（JDK 动态代理 + CGLIB）|
| 13 | 责任链（Chain of Responsibility）| 行为型 | 请求沿链处理 | Spring Security FilterChain、Netty Pipeline |
| 14 | 命令（Command）| 行为型 | 请求封装为对象 | Spring @Async、CQRS 命令对象 |
| 15 | 迭代器（Iterator）| 行为型 | 顺序遍历不暴露内部 | Java Iterator、Stream API |
| 16 | 中介者（Mediator）| 行为型 | 集中管理对象通信 | Spring ApplicationEventPublisher |
| 17 | 备忘录（Memento）| 行为型 | 保存/恢复对象状态 | 编辑器 Undo/Redo |
| 18 | 观察者（Observer）| 行为型 | 状态变化自动通知 | Spring Events、Guava EventBus |
| 19 | 状态（State）| 行为型 | 状态驱动行为切换 | 订单状态机、Spring StateMachine |
| 20 | 策略（Strategy）| 行为型 | 算法族可互换 | Comparator、支付方式切换 |
| 21 | 模板方法（Template Method）| 行为型 | 固定骨架，子类实现步骤 | JdbcTemplate、AbstractApplicationContext |
| 22 | 访问者（Visitor）| 行为型 | 不修改类增加操作 | AST 处理、Spring BeanDefinitionVisitor |
| 23 | 解释器（Interpreter）| 行为型 | 为语言定义语法解释器 | SpEL、SQL 解析、正则引擎 |

---

## 三、六大设计原则

| 原则 | 简称 | 核心含义 |
|------|------|---------|
| 开闭原则（Open/Closed Principle）| OCP | 对扩展开放，对修改关闭。新增功能通过扩展实现，不改原有代码 |
| 里氏替换原则（Liskov Substitution Principle）| LSP | 子类必须能替换父类。继承要保证行为兼容，不能削弱父类契约 |
| 依赖倒置原则（Dependency Inversion Principle）| DIP | 依赖抽象，不依赖具体实现。高层模块不依赖低层模块 |
| 接口隔离原则（Interface Segregation Principle）| ISP | 接口尽量细化。客户端不应被迫依赖它不使用的方法 |
| 迪米特法则（Law of Demeter）| LoD | 最少知道原则。一个类只与直接朋友通信，减少耦合 |
| 合成复用原则（Composite Reuse Principle）| CRP | 优先用组合/聚合，而非继承。继承是强耦合，组合更灵活 |

> **记忆口诀**：开里依接迪合（谐音"开里椅接地盒"）
