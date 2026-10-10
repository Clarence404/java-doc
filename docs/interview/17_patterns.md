---
description: 设计原则、单例与工厂、代理与装饰器、策略与模板方法、观察者与责任链、状态机、模式在 JDK / Spring 中的应用
---

# 设计模式面试题解答

> 题目清单见 [设计模式面试题](/patterns/99_interview)；细节见 [设计模式总览](/patterns/0_overview)。JDK 动态代理与 CGLIB 的实现差异见 [Java 基础面试题解答](/interview/1_java)，Spring AOP 与事务失效见 [Spring 面试题解答](/interview/5_spring)。
>
> 版本基线：示例代码默认 JDK 21（record、sealed、switch 模式匹配），Spring 类名以 Spring Framework 6.x / 7.x 为准；模式定义以 GoF 原书与 Refactoring.Guru 为准。

## 一、设计原则

### Q1：设计模式的六大原则是什么？和 SOLID 是什么关系？

**一句话**：六大原则 = SOLID 五条 + 迪米特法则。它们的共同目标是让代码「改一处不牵连一片」，每个设计模式都是其中几条原则的具体落地。

| 原则 | 一句话 |
|------|--------|
| 单一职责（SRP） | 一个类只有一个引起它变化的原因 |
| 开闭（OCP） | 新增功能靠加代码，不靠改已有代码 |
| 里氏替换（LSP） | 子类必须能替换父类，不能削弱父类的契约 |
| 接口隔离（ISP） | 接口小而专，不强迫调用方依赖用不到的方法 |
| 依赖倒置（DIP） | 高层和低层都依赖抽象，不直接依赖具体实现 |
| 迪米特（LoD） | 只和直接的朋友通信，不要 `a.getB().getC().doX()` |

- 开闭原则是目标，其他几条是手段；Spring 注入 `List<Strategy>` 加新实现不改调用方，就是开闭原则的典型

→ 详见 [设计模式总览](/patterns/0_overview#_1、六大原则)

### Q2：为什么说要优先使用组合，而不是继承？

**一句话**：继承在编译期就把父子类绑死了，父类一改所有子类都受影响，还受单继承限制；组合在运行时把对象拼起来，可以随时替换、自由搭配。

- 继承的问题：脆弱基类（父类改步骤顺序会破坏子类）、子类暴露了父类的所有方法（`Stack` 继承 `Vector` 就是反例）、多个维度一起扩展时类数量爆炸
- 组合的好处：依赖的是接口，换实现不用改代码；多个维度可以独立变化
- 策略、装饰器、桥接、代理本质上都是「用组合代替继承」
- 继承仍然适合真正的「is-a」关系和稳定的骨架，例如模板方法

→ 详见 [设计模式总览](/patterns/0_overview#_2、合成复用原则)

## 二、创建型模式

### Q3：单例模式有几种写法？推荐哪种？

**一句话**：常见五种：懒汉、饿汉、双重检查锁（DCL）、静态内部类（Holder）、枚举。普通懒加载用 Holder，需要防反射和反序列化破坏时用枚举。

| 写法 | 线程安全 | 懒加载 | 防反射 / 反序列化 |
|------|---------|--------|------------------|
| 懒汉式 | 否 | 是 | 否 |
| 饿汉式 | 是 | 否 | 要手动加 |
| DCL | 是（必须 `volatile`） | 是 | 要手动加 |
| 静态内部类 | 是 | 是 | 要手动加 |
| 枚举 | 是 | 否 | 天然防 |

- Holder 的原理：内部类在第一次被访问时才加载，类初始化由 JVM 保证线程安全
- DCL 不加 `volatile`，其他线程可能拿到「已分配但还没初始化完」的对象，细节见 Java 面试题
- 在 Spring 项目里几乎不用手写单例，声明成 Bean 再构造器注入即可，测试时还能换成 Mock

→ 详见 [单例模式](/patterns/1_creational_singleton#_7、五种实现对比)

### Q4：枚举单例为什么能防反射和反序列化？普通单例怎么防？

**一句话**：枚举反序列化时只按常量名查回原来的对象，不会新建；反射也不允许创建枚举实例。普通单例要自己加两处代码：`readResolve` 和构造方法里的检查。

- 反序列化：枚举只写出常量名，读回时按名字找到原常量
- 反射：枚举没有无参构造方法，拿到 `(String, int)` 构造方法再 `newInstance` 也会被 JDK 拒绝
- 普通类防反序列化：加 `readResolve()` 返回唯一实例，替换掉反序列化新建的对象
- 普通类防反射：构造方法里发现实例已存在就抛异常；但 `Unsafe` 之类的手段仍能绕过，严格场景直接用枚举

**常见坑**：枚举的构造方法里做重操作，一旦抛异常就变成 `ExceptionInInitializerError`，之后每次访问都是 `NoClassDefFoundError`，无法重试。

→ 详见 [单例模式](/patterns/1_creational_singleton#_5、枚举单例)

### Q5：Spring 的单例 Bean 和 GoF 单例模式有什么区别？

**一句话**：GoF 单例是「每个 ClassLoader 一个」，由类自己保证；Spring 单例是「每个容器、每个 bean 名一个」，由容器管理，类本身只是普通类。

- 同一个类配了两个 `@Bean` 方法，就是两个实例，类本身并不阻止你 `new`
- 实例缓存在 `DefaultSingletonBeanRegistry` 的单例注册表里
- GoF 单例在多个 ClassLoader 下也不唯一：Tomcat 多个 webapp、热部署时会出现多份
- 两者都要注意：单例被所有线程共享，内部有可变字段就必须自己保证线程安全

→ 详见 [单例模式](/patterns/1_creational_singleton#_2、「唯一」的范围)

### Q6：简单工厂、工厂方法、抽象工厂有什么区别？

**一句话**：简单工厂是一个类按参数分支创建（不是 GoF 模式）；工厂方法让子类决定创建哪种产品；抽象工厂创建「一族」必须搭配使用的相关产品。

| 对比 | 简单工厂 | 工厂方法 | 抽象工厂 |
|------|---------|---------|---------|
| 扩展方式 | 改工厂里的分支 | 新增 Creator 子类 | 新增整族工厂 |
| 产品 | 一种产品的多个实现 | 一种产品 | 一族相关产品 |
| 例子 | `ShapeFactory.create(type)` | `Collection.iterator()` | JDBC `Connection` |

- 抽象工厂新增产品族容易，新增产品种类难（所有工厂都要改）
- 现代 Java 最常见的其实是静态工厂方法：`List.of`、`Integer.valueOf`；Spring 的 `FactoryBean` 是工厂方法的例子

→ 详见 [工厂模式](/patterns/2_creational_factory#五、与相近模式的区别)、[抽象工厂模式](/patterns/3_creational_abstract_factory#五、与相近模式的区别)

### Q7：什么时候用建造者模式？Lombok `@Builder` 有哪些坑？

**一句话**：参数多（四五个以上）且大部分可选、又希望对象不可变时用建造者，避免一长串重叠构造方法；只有两三个字段时，构造方法、静态工厂或 record 就够了。

- 跨字段的校验要放在 `build()` 里；集合字段要做防御性复制，否则对象并不真正不可变
- Lombok 推荐 `@Value @Builder @Jacksonized`：不可变，Jackson 反序列化也走 Builder
- 字段初始值要加 `@Builder.Default`，否则通过 `builder()` 构建时这个字段是 `null` / 0

**常见坑**：`@Builder` + `@Data` 一起用：`@Data` 生成了 setter，对象不再不可变，而且没有无参构造方法，Jackson 反序列化会失败。

→ 详见 [建造者模式](/patterns/4_creational_builder#四、适用场景与常见坑)

### Q8：深拷贝和浅拷贝有什么区别？为什么不推荐用 `Cloneable`？

**一句话**：浅拷贝只复制引用，副本和原对象共享里面的可变对象；深拷贝把引用的可变对象也复制一份，两边互不影响。`Object.clone()` 默认是浅拷贝，深拷贝要自己补，而且和 `final` 字段冲突。

- `Cloneable` 是个没有方法的标记接口，`clone()` 绕过构造方法创建对象，返回值还要强转
- 深拷贝要给引用字段重新赋值，`final` 字段做不到
- 推荐：复制构造方法或复制工厂（`new Order(other)`）；不可变对象直接共享，不用复制
- 用序列化做深拷贝慢，原生反序列化还有安全风险

**常见坑**：把 Spring `scope=prototype` 或 `BeanUtils.copyProperties` 当成原型模式。前者每次 new 一个新实例，后者只是浅层属性复制。

→ 详见 [原型模式](/patterns/5_creational_prototype#_2、浅拷贝与深拷贝)

## 三、结构型模式

### Q9：代理模式和装饰器模式有什么区别？

**一句话**：两者代码结构几乎一样（实现同一接口、持有目标对象），区别在意图：代理是**控制访问**，可以决定不调用目标；装饰器是**增强功能**，总会调用被装饰对象，并且常常多层叠加。

| 维度 | 装饰器 | 代理 |
|------|--------|------|
| 意图 | 叠加新行为 | 延迟加载、权限、远程调用、缓存 |
| 谁来组装 | 调用方显式一层层包装 | 框架或工厂创建，调用方通常无感知 |
| 层数 | 常常多层嵌套 | 一般一层 |
| 例子 | `BufferedInputStream` | Spring AOP 代理、MyBatis Mapper |

- 缓存代理（`@Cacheable`）命中时根本不调用目标，这是装饰器不会做的事

→ 详见 [装饰器模式](/patterns/9_structural_decorator#_1、装饰器-vs-代理)

### Q10：适配器、装饰器、代理、外观都是「包一层」，怎么区分？

**一句话**：看包这一层的目的和接口变没变：适配器把不兼容的接口转成需要的接口；装饰器和代理接口不变，一个增强、一个控制访问；外观给一组子系统提供一个新的、更简单的接口。

| 模式 | 接口是否改变 | 目的 | 例子 |
|------|------------|------|------|
| 适配器 | 改变 | 让不兼容的接口能一起工作 | `InputStreamReader`、Spring MVC `HandlerAdapter` |
| 装饰器 | 不变 | 动态叠加功能 | `BufferedInputStream` |
| 代理 | 不变 | 控制访问 | Spring AOP 代理 |
| 外观 | 新的简单接口 | 简化一组子系统 | SLF4J |

- 外观和中介者也容易混：外观是单向的（子系统不知道外观），中介者是双向的（同事对象主动通知中介者）

→ 详见 [适配器模式](/patterns/6_structural_adapter#五、与相近模式的区别)

### Q11：Spring 里哪些地方用了代理？使用时有哪些坑？

**一句话**：`@Transactional`、`@Cacheable`、`@Async`、`@PreAuthorize`、OpenFeign 客户端、MyBatis Mapper、Spring Data Repository 背后都是代理，容器在 Bean 初始化后用 AOP 把它们包成代理对象。

- 增强代理：事务、异步；保护代理：方法级权限；缓存代理：`@Cacheable`
- 远程代理：OpenFeign、Dubbo / gRPC stub；接口实现代理：Mapper 接口根本没有实现类，由代理直接实现
- `final` / `private` 方法：CGLIB 靠生成子类覆盖方法，覆盖不了的方法加注解不生效
- 用 JDK 代理时按实现类类型注入会报类型不匹配

**常见坑**：同一个类里 `this.methodB()` 调用带 `@Transactional` 的方法，走的是目标对象本身，事务不生效。

→ 详见 [代理模式](/patterns/12_structural_proxy#三、jdk-与-spring-中的应用)、[代理模式](/patterns/12_structural_proxy#四、适用场景与常见坑)

### Q12：享元模式和对象池有什么区别？`Integer` 缓存为什么 `==` 有时为 true？

**一句话**：享元是多个使用者**同时共享**同一个不可变对象，为了省内存；对象池是借出期间**独占**、用完归还，为了省创建成本。连接池、线程池是对象池，不是享元。

| 维度 | 享元 | 对象池 |
|------|------|--------|
| 复用方式 | 同时共享 | 独占借还 |
| 对象状态 | 不可变 | 可变，归还前要重置 |
| 例子 | `Integer` 缓存、字符串常量池 | HikariCP、`ThreadPoolExecutor` |

- `Integer.valueOf` 和自动装箱默认缓存 -128 ~ 127，范围内返回同一个对象，所以 `==` 为 true；上限可以用 `-XX:AutoBoxCacheMax` 调大

**常见坑**：包装类型之间用 `==` 比较，换一个数值结果就变了，一律用 `equals`。

→ 详见 [享元模式](/patterns/11_structural_flyweight#_1、享元-vs-对象池)

### Q13：桥接模式和策略模式有什么区别？组合模式的透明式和安全式有什么区别？

**一句话**：桥接和策略都持有一个接口引用，区别在变化的维度：策略只有「算法」一个维度在变，桥接是两个维度（如消息类型 × 发送渠道）各自独立扩展，把 n×m 个类降到 n+m 个。

- 桥接是设计阶段主动拆维度；适配器是事后补救，让已有的不兼容接口能用
- 组合模式把树形结构的叶子和容器统一成一个接口，客户端递归处理时不用区分
- 透明组合：`add` / `remove` 放在公共接口上，客户端完全不用区分，但叶子只能空实现或抛异常
- 安全组合：`add` / `remove` 只放在容器上，类型安全；业务代码一般选这种，因为建树的代码本来就知道谁是容器

→ 详见 [桥接模式](/patterns/7_structural_bridge#五、与相近模式的区别)、[组合模式](/patterns/8_structural_composite#一、定义与角色)

## 四、行为型模式

### Q14：Spring 项目里怎么用策略模式消除一长串 if-else？

**一句话**：每种策略是一个 Bean，自己声明处理哪种类型；调用方构造器注入 `List<策略接口>`，启动时转成 `EnumMap` 查找表，按类型取出策略执行。新增一种类型只加一个类，调用方不用改。

- 策略接口带一个 `type()` 方法声明自己负责的类型，启动时发现重复类型直接报错
- 找不到策略时抛异常，不要返回 `null`
- 策略很轻时不必建类：`Comparator`、枚举里放 lambda 就是最简单的策略
- 注入 `Map<String, 策略接口>` 也行，key 是 bean 名，但依赖命名约定，不如显式的 `type()` 稳

**常见坑**：只有两三个稳定分支也硬上策略模式。分支很少变化时一个 `switch` 表达式更直接。

→ 详见 [策略模式](/patterns/20_behavioral_strategy#四、spring-注入策略表)

### Q15：模板方法和策略有什么区别？`JdbcTemplate` 属于哪种？

**一句话**：模板方法靠继承：父类用 `final` 方法固定流程骨架，子类填其中几个步骤；策略靠组合：整个算法可以替换。`JdbcTemplate` 是「模板 + 回调」，固定流程，变化的步骤以回调参数传进来。

| 维度 | 模板方法 | 模板 + 回调 | 策略 |
|------|---------|-------------|------|
| 复用机制 | 继承 | 组合，回调作为参数 | 组合 |
| 变化粒度 | 流程中的几步 | 流程中的几步 | 整个算法 |
| 例子 | `AbstractList`、`HttpServlet`、AQS | `JdbcTemplate`、`TransactionTemplate` | `Comparator` |

- 模板方法本身要声明成 `final`，否则子类覆盖后可以跳过校验等关键步骤
- 可变步骤只有一两个时，lambda 回调通常比新建子类简单

→ 详见 [模板方法模式](/patterns/21_behavioral_template_method#四、模板-回调-spring-的-xxxtemplate)

### Q16：观察者模式和发布订阅有什么区别？生产中有哪些坑？

**一句话**：观察者是主题直接持有观察者列表并逐个回调，通常同步、同进程；发布订阅中间多了一个事件通道，发布者连有哪些订阅者都不知道，可以异步、跨进程。

- 观察者的例子：`PropertyChangeSupport`、GUI 监听器；`java.util.Observable` 已废弃
- 发布订阅的例子：Spring `ApplicationEvent`（进程内）、Kafka / RocketMQ（跨进程）
- 坑一：同步通知时一个观察者慢，主流程就慢；一个观察者抛异常可能打断后续通知
- 坑二：只订阅不取消导致监听器泄漏；业务依赖通知顺序；回调里又修改主题引起循环通知

→ 详见 [观察者模式](/patterns/18_behavioral_observer#二、观察者-vs-发布订阅)、[观察者模式](/patterns/18_behavioral_observer#六、常见坑)

### Q17：责任链模式在框架中是怎么用的？纯责任链和管道有什么区别？

**一句话**：纯责任链是「找到一个能处理的就结束」，像审批流；框架里常见的是管道式：每个处理者都执行自己的逻辑，再主动调用下一个，也可以不调用来拦截请求。

- Servlet `FilterChain`：每个 Filter 调 `chain.doFilter()` 放行，不调就拦截
- Spring Security：`FilterChainProxy` 挂进 Servlet 容器，按请求匹配一条 `SecurityFilterChain` 依次执行
- Spring MVC 拦截器：任何一个 `preHandle` 返回 `false` 就中断
- Netty `ChannelPipeline`：每个入站处理器处理完调用 `ctx.fireChannelRead(msg)` 交给下一个

**常见坑**：管道式过滤器忘了调用 `chain.doFilter`，请求既不报错也到不了业务代码；纯责任链走到链尾没人处理时要有兜底，不能静默返回。

→ 详见 [责任链模式](/patterns/13_behavioral_chain_of_responsibility#_2、两种变体)、[责任链模式](/patterns/13_behavioral_chain_of_responsibility#三、jdk-与-spring-中的应用)

### Q18：订单状态机怎么实现？状态模式和策略模式有什么区别？

**一句话**：状态少时用「枚举 + 转换表」最简单；每个状态行为差异大时用状态模式，JDK 21 可以写成 sealed 接口 + record 状态。真正的难点在落库：改状态要用带当前状态条件的 UPDATE 保证并发安全。

- 条件更新：`UPDATE ... SET status = 'PAID' WHERE id = ? AND status = 'PENDING'`，影响 0 行说明已被别人改过，按幂等处理
- 状态更新成功之后才发消息、扣库存；每次转换记一条状态流水
- 状态 vs 策略：状态对象自己决定下一个状态、彼此知道对方；策略由客户端选，互不相识
- Spring Statemachine 已于 2025 年停止开源维护，新项目用转换表、COLA StateMachine，或在有人工审批时用工作流引擎

→ 详见 [状态模式](/patterns/19_behavioral_state#四、持久化与并发)、[状态模式](/patterns/19_behavioral_state#六、状态-vs-策略)

### Q19：命令模式解决什么问题？撤销 / 重做有哪两种实现方式？

**一句话**：命令模式把「一次请求」（接收者 + 动作 + 参数）封装成对象，调用者只管什么时候执行，从而能排队、记日志、异步执行和撤销。撤销可以靠命令自己的 `undo()`，也可以靠备忘录快照。

| 维度 | 命令式撤销 | 快照式撤销（备忘录） |
|------|-----------|---------------------|
| 记录什么 | 操作本身及其逆操作 | 操作前的完整状态 |
| 内存 | 通常较小 | 状态大时占用高 |
| 实现难度 | 每个命令都要写正确的逆操作 | 简单，直接恢复 |

- 重做：再用一个栈记录被撤销的操作，任何新操作都要清空它
- 命令和策略常常都写成 lambda：策略是拿来算结果、立即用返回值；命令是交出去让别人执行，比如提交给线程池的 `Runnable`

→ 详见 [命令模式](/patterns/14_behavioral_command#五、与相近模式的区别)、[备忘录模式](/patterns/17_behavioral_memento#四、快照式撤销-vs-命令式撤销)

### Q20：中介者和观察者有什么区别？

**一句话**：中介者把多个对象之间网状的多对多调用收拢成星型，协调规则写在中介者里，通信是双向的；观察者只是一个主题变化时通知多个观察者，没有协调逻辑。

| 维度 | 中介者 | 观察者 |
|------|--------|--------|
| 解决的问题 | 多对多的交互 | 一对多的通知 |
| 通信方向 | 双向 | 单向 |
| 协调逻辑 | 集中在中介者 | 没有，观察者各自处理 |
| 例子 | Spring MVC `DispatcherServlet`、聊天室 | Spring 事件、`PropertyChangeSupport` |

- 中介者的主要风险是变成什么都管的上帝对象，规则多时按场景拆分
- 消息队列和 Spring 事件是发布订阅，不是中介者

→ 详见 [中介者模式](/patterns/16_behavioral_mediator#五、中介者-vs-观察者-vs-外观)

### Q21：什么是双分派？访问者模式为什么需要 `accept`？JDK 21 有替代方案吗？

**一句话**：Java 只有单分派：调用哪个对象的方法看运行时类型，但选哪个重载看参数的静态类型。访问者用 `element.accept(visitor)` 再回调 `visitor.visit(this)` 两次虚调用，凑出「按两个对象的运行时类型选代码」的效果。

- `accept` 每个元素类都要写一遍，因为 `this` 的静态类型在每个类里不同，不能提到父类共用
- 访问者适合元素类型稳定、操作经常增加的场景；新增元素类型要改所有访问者
- JDK 21 替代：sealed 接口 + record + 模式匹配 `switch`，不写 `default` 时漏掉某种类型会编译失败
- 真实例子：`Files.walkFileTree` 的 `FileVisitor`、ASM 字节码库、Spring `BeanDefinitionVisitor`

→ 详见 [访问者模式](/patterns/22_behavioral_visitor#三、双分派-为什么需要-accept)、[访问者模式](/patterns/22_behavioral_visitor#五、jdk-21-替代方案-sealed-模式匹配-switch)

### Q22：什么是 fail-fast？遍历集合时怎么安全地删除元素？

**一句话**：`ArrayList`、`HashMap` 的迭代器是 fail-fast 的：创建时记下修改次数，遍历中发现集合被迭代器以外的方式改了，就抛 `ConcurrentModificationException`。删除要用迭代器自己的 `remove()` 或 `removeIf`。

- 安全删除：`list.removeIf(x -> ...)` 最简洁；或显式用 `Iterator` 的 `remove()`
- fail-fast 只是尽力检测，不保证并发安全；并发场景用 `ConcurrentHashMap`（弱一致迭代器）或 `CopyOnWriteArrayList`（快照迭代器）
- `List.of(...)` 返回的不可变集合，迭代器的 `remove()` 抛 `UnsupportedOperationException`
- `Iterator` 和 `Stream` 只能用一次；持有资源的游标（`Stream<T>` 查询、MyBatis `Cursor`）要用 try-with-resources

→ 详见 [迭代器模式](/patterns/15_behavioral_iterator#四、适用场景与常见坑)

## 五、模式在 JDK / Spring 中的应用

### Q23：Spring 框架里用到了哪些设计模式？

**一句话**：Spring 几乎是设计模式的样板间：IoC 容器是工厂，Bean 默认是单例，AOP 是代理，事件是观察者（发布订阅），各种 `XxxTemplate` 是模板 + 回调，MVC 里有适配器和责任链。

| 模式 | Spring 中的例子 |
|------|----------------|
| 工厂 | `BeanFactory`、`FactoryBean` |
| 代理 | AOP、`@Transactional`、`@Async` |
| 模板方法 | `AbstractApplicationContext.refresh()`、`JdbcTemplate`（模板 + 回调） |
| 观察者 | `ApplicationEvent` / `@EventListener` |
| 适配器 | Spring MVC `HandlerAdapter` |
| 责任链 | `HandlerExecutionChain` 拦截器、Spring Security 过滤器链 |
| 策略 | Spring Security `AuthenticationProvider`、`ProviderManager` 依次尝试 |
| 建造者 | `UriComponentsBuilder`、`RestClient.builder()` |

- 回答时挑两三个讲清楚「它解决了什么问题」，比报一长串名字更有说服力

→ 详见 [设计模式总览](/patterns/0_overview#四、23-种模式索引)

### Q24：JDK 里有哪些设计模式的例子？

**一句话**：JDK 源码里随处可见：IO 流是装饰器，`Integer` 缓存是享元，`Iterator` 是迭代器，`Comparator` 是策略，`AbstractList` 和 AQS 是模板方法，`Runtime` 是单例。

| 模式 | JDK 中的例子 |
|------|-------------|
| 单例 | `Runtime.getRuntime()` |
| 工厂方法 / 静态工厂 | `Collection.iterator()`、`List.of`、`Integer.valueOf` |
| 建造者 | `HttpClient.newBuilder()`、`Stream.builder()` |
| 适配器 | `InputStreamReader`、`Arrays.asList` |
| 装饰器 | `BufferedInputStream`、`Collections.unmodifiableList` |
| 代理 | `java.lang.reflect.Proxy` |
| 模板方法 | `AbstractList`、`InputStream.read`、AQS |
| 命令 | 提交给 `Executor` 的 `Runnable` / `Callable` |

**常见坑**：把 `StringBuilder` 当成标准的建造者。它是可变的字符累加器，`toString()` 才得到不可变的 `String`，只能算宽泛意义上的建造者。

→ 详见 [设计模式总览](/patterns/0_overview#四、23-种模式索引)

### Q25：解释器模式在实际项目里怎么用？SpEL 注入是什么，怎么防范？

**一句话**：业务里需要可配置的规则（如「年龄 ≥ 18 且未封禁」）时，一般不手写解释器，而是直接用 SpEL 这类现成的表达式语言。危险在于表达式来自用户输入时，完整的求值上下文能调用任意方法，等于远程代码执行。

- 解释器模式：把文法的每条规则表示成一个类，组成语法树后递归求值；`java.util.regex.Pattern` 也是解释器
- `StandardEvaluationContext` 支持类型引用（`T(java.lang.Runtime)`）、构造对象、调用任意方法
- 表达式来自不可信来源时，只用 `SimpleEvaluationContext`（只读数据绑定）
- 写在代码或注解里的表达式（`@Value`、`@PreAuthorize`）由开发者控制，是安全的

**常见坑**：用 `boolean` 接收求值结果，表达式结果为 `null` 时拆箱 NPE，要用 `Boolean` 接收。

→ 详见 [解释器模式](/patterns/23_behavioral_interpreter#五、spel-与表达式注入)
