---
description: 定义与角色、聊天室示例、JDK 与 Spring MVC 中的中介者、上帝对象风险、中介者 vs 观察者 vs 外观
---

# 中介者模式

> 前置阅读：[外观模式](./10_structural_facade)

中介者模式让一组对象只认识中介者，协作逻辑集中在中介者里。本篇讲它的结构与写法、和观察者（事件总线）及外观模式的边界，以及中介者膨胀成上帝对象的风险。

---

## 一、定义与角色

GoF 的定义：用一个中介对象封装一组对象之间的交互，让这些对象不必显式地互相引用，从而松散耦合，并且可以独立地改变它们之间的交互方式。

N 个对象两两通信时，依赖关系是一张网，任意一个对象改动都可能波及其他对象。引入中介者后，网状依赖变成以中介者为中心的星型：每个同事只认识中介者，「谁该响应、怎么响应」这类协调逻辑全部放在中介者里。

![中介者模式的角色](../assets/patterns/mediator_structure.svg)

| 角色 | 职责 | 示例中的类 |
|------|------|-----------|
| Mediator | 定义同事与中介者通信的接口 | `ChatMediator` |
| ConcreteMediator | 持有所有同事，实现协调逻辑 | `ChatRoom` |
| Colleague | 只持有中介者引用，有事交给中介者 | `ChatUser` |

关键在**双向关系**：同事调用中介者（`send`），中介者再回调同事（`receive`）；同事之间没有任何直接引用。

---

## 二、实现示例：聊天室

聊天室里的用户不直接互发消息，由聊天室决定消息发给谁。协调逻辑（群发、私聊、禁言）全部在 `ChatRoom` 中：

```java
// Mediator：同事只依赖这个接口
public interface ChatMediator {
    void join(ChatUser user);
    void send(String message, ChatUser sender);
}

// Colleague：只持有中介者，不认识其他用户
public class ChatUser {
    private final String name;
    private final ChatMediator mediator;

    public ChatUser(String name, ChatMediator mediator) {
        this.name = name;
        this.mediator = mediator;
    }

    public String name() { return name; }

    public void send(String message) {
        mediator.send(message, this);          // 有事找中介者
    }

    public void receive(String from, String message) {
        System.out.println(name + " 收到 " + from + "：" + message);
    }
}

// ConcreteMediator：协调逻辑集中在这里
public class ChatRoom implements ChatMediator {
    private final Map<String, ChatUser> users = new LinkedHashMap<>();
    private final Set<String> muted = new HashSet<>();

    @Override
    public void join(ChatUser user) { users.put(user.name(), user); }

    public void mute(String name) { muted.add(name); }

    @Override
    public void send(String message, ChatUser sender) {
        if (muted.contains(sender.name())) {
            sender.receive("系统", "你已被禁言");
            return;
        }
        int space = message.indexOf(' ');
        if (message.startsWith("@") && space > 1) {          // 私聊：@Bob 晚上开会
            ChatUser target = users.get(message.substring(1, space));
            if (target != null) {
                target.receive(sender.name(), message.substring(space + 1));
            }
            return;
        }
        users.values().stream()                                // 群发：除自己外都收到
             .filter(u -> u != sender)
             .forEach(u -> u.receive(sender.name(), message));
    }
}

public class ChatDemo {
    public static void main(String[] args) {
        ChatRoom room = new ChatRoom();
        ChatUser alice = new ChatUser("Alice", room);
        ChatUser bob   = new ChatUser("Bob", room);
        ChatUser carol = new ChatUser("Carol", room);
        List.of(alice, bob, carol).forEach(room::join);

        alice.send("大家好");            // Bob、Carol 收到
        alice.send("@Bob 晚上开会");     // 只有 Bob 收到
        room.mute("Carol");
        carol.send("我也说一句");        // Carol 收到「你已被禁言」
    }
}
```

新增「管理员消息置顶」「敏感词过滤」之类的规则，只改 `ChatRoom`，`ChatUser` 不受影响。`join` 放在构造器外部调用，避免在构造器里把未初始化完的 `this` 交给别的对象。

---

## 三、JDK 与框架中的中介者

| 例子 | 中介者 | 被协调的同事 |
|------|--------|-------------|
| Spring MVC `DispatcherServlet` | 前端控制器统一调度一次请求 | `HandlerMapping`、`HandlerAdapter`、`ViewResolver` 等组件互不引用 |
| `java.util.Timer`（`schedule*` 方法） | `Timer` 统一安排执行时机 | 各个 `TimerTask` 与后台线程 |
| `Executor#execute`、`ExecutorService#submit` | 线程池决定任务由哪个线程、何时执行 | 提交任务的代码与工作线程 |

`DispatcherServlet` 最贴近 GoF 的意图：找处理器、适配调用、解析视图这些组件彼此不知道对方存在，由它按固定流程串起来。

Spring 的 `ApplicationEventPublisher` / `@EventListener` 看起来也是「发布方不认识消费方」，但它没有协调逻辑，只按事件类型广播，本质是观察者（发布订阅），见 [观察者模式](./18_behavioral_observer) 与 [事件机制](/spring/7_event)。同理，消息队列 Broker 是发布订阅的基础设施，不是中介者。

---

## 四、适用场景与坑

适合：

- 一组对象之间交互多且杂，改一个对象要连带改好几个（表单联动：选省份刷新城市，勾选协议才启用提交按钮）
- 想复用某个组件，却因为它引用了太多其他组件而拆不出来
- 交互规则经常变，希望集中在一处修改

坑：

- **中介者膨胀成上帝对象**：所有协调逻辑都堆进一个类，几千行无人敢改。按业务场景拆成多个中介者，或者把与协调无关的计算逻辑留在同事里
- **把「只是转发」当成中介者**：如果中介者只是原样广播、没有任何规则，用观察者或事件更简单
- **同事反向依赖具体中介者**：同事应只依赖 `Mediator` 接口，否则换中介者实现时同事也要改

---

## 五、中介者 vs 观察者 vs 外观

| 维度 | 中介者 | 观察者 | 外观 |
|------|--------|--------|------|
| 解决的问题 | 多个对象之间多对多的交互 | 一个对象状态变化时通知多个对象 | 给复杂子系统一个简单入口 |
| 通信方向 | 双向：同事调中介者，中介者回调同事 | 单向：主题通知观察者 | 单向：客户端调外观，子系统不知道外观 |
| 协调逻辑 | 在中介者里（决定谁响应、怎么响应） | 没有，观察者各自处理 | 只编排调用顺序 |
| 典型例子 | `DispatcherServlet`、聊天室 | Spring 事件、`PropertyChangeSupport` | `SLF4J`、各类 `XxxFacade` 服务 |

---

## 小结

- 中介者把网状依赖变成星型：同事只认识中介者，协调规则集中在中介者
- 核心是双向关系：同事通过中介者发出请求，中介者决定回调哪些同事
- `DispatcherServlet` 是框架里最典型的中介者；Spring 事件、MQ 是发布订阅，不是中介者
- 主要风险是中介者变成上帝对象，规则多时按场景拆分

## 参考资料

- Refactoring.Guru Mediator：[https://refactoring.guru/design-patterns/mediator](https://refactoring.guru/design-patterns/mediator)
- Refactoring.Guru Mediator in Java（JDK 中的用例）：[https://refactoring.guru/design-patterns/mediator/java/example](https://refactoring.guru/design-patterns/mediator/java/example)
- Spring Framework DispatcherServlet：[https://docs.spring.io/spring-framework/reference/web/webmvc/mvc-servlet.html](https://docs.spring.io/spring-framework/reference/web/webmvc/mvc-servlet.html)
- Gamma E. 等，《Design Patterns: Elements of Reusable Object-Oriented Software》，Addison-Wesley，1994

> 下一篇：[备忘录模式](./17_behavioral_memento) —— 快照的保存与恢复、撤销 / 重做栈、封装边界。
