# 观察者模式

**作用**：定义对象间的**一对多依赖**，当一个对象（主题）状态变化时，所有依赖它的对象（观察者）自动收到通知。

**应用场景**：
- Spring `ApplicationEvent` + `@EventListener`（最常用）
- Guava `EventBus`（轻量级进程内事件总线）
- JDK `java.util.Observable`（已废弃，了解即可）
- RxJava / Project Reactor 响应式流

---

## 一、Spring ApplicationEvent（推荐）

```java
// 1. 事件类
public class UserRegisteredEvent extends ApplicationEvent {
    private final String email;
    private final Long   userId;

    public UserRegisteredEvent(Object source, Long userId, String email) {
        super(source);
        this.userId = userId;
        this.email  = email;
    }
    public Long   getUserId() { return userId; }
    public String getEmail()  { return email; }
}

// 2. 发布方
@Service
public class UserService {
    @Autowired
    private ApplicationEventPublisher publisher;

    @Transactional
    public Long register(RegisterRequest req) {
        User user = userRepository.save(new User(req));
        publisher.publishEvent(new UserRegisteredEvent(this, user.getId(), user.getEmail()));
        return user.getId();
    }
}

// 3. 观察者：发送欢迎邮件
@Component
public class WelcomeEmailListener {
    @Async
    @TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT)
    public void onUserRegistered(UserRegisteredEvent event) {
        emailService.sendWelcome(event.getEmail());
    }
}

// 4. 观察者：初始化用户积分
@Component
public class PointsInitListener {
    @EventListener
    public void onUserRegistered(UserRegisteredEvent event) {
        pointsService.initPoints(event.getUserId(), 100);
    }
}
```

---

## 二、Guava EventBus

```java
// 注册事件总线
EventBus eventBus = new EventBus("user-events");

// 观察者：只需 @Subscribe 注解
public class AuditLogger {
    @Subscribe
    public void log(UserRegisteredEvent event) {
        auditLog.record("USER_REGISTER", event.getUserId());
    }
}

// 注册并发布
eventBus.register(new AuditLogger());
eventBus.post(new UserRegisteredEvent(this, 1L, "user@example.com"));

// 异步版本
AsyncEventBus asyncBus = new AsyncEventBus("async", Executors.newFixedThreadPool(4));
```

---

## 三、手写观察者（了解原理）

```java
public interface UserObserver {
    void onUserRegistered(Long userId, String email);
}

@Service
public class UserService {
    private final List<UserObserver> observers = new CopyOnWriteArrayList<>();

    public void addObserver(UserObserver o)    { observers.add(o); }
    public void removeObserver(UserObserver o) { observers.remove(o); }

    public void register(String email) {
        Long userId = doRegister(email);
        observers.forEach(o -> o.onUserRegistered(userId, email));
    }
}
```

---

## 四、推模式 vs 拉模式

| 模式 | 说明 | 示例 |
|------|------|------|
| 推模式（Push）| 主题主动把数据推给观察者 | Spring Event 携带完整 Event 对象 |
| 拉模式（Pull）| 观察者收到通知后自行拉取数据 | 只传主题引用，观察者调 `getXxx()` |
