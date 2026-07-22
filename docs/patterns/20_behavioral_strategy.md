# 策略模式

**作用**：定义一组算法，让它们可以相互替换，提高代码灵活性。

**应用场景**：

- Spring Security 认证策略
- 支付方式选择（支付宝/微信支付）
- 日志格式化策略（JSON/XML）

下面是两个结合 **策略模式** 与 **枚举**（一个配合工厂，一个不配合工厂）的典型示例



## 一、枚举 + 策略模式

**场景**：日志格式化策略（JSON / XML / TEXT）

### 1. 定义策略接口：

```java
public interface LogFormatter {
    String format(String level, String message);
}
```

### 2. 实现具体策略类：

```java
public class JsonLogFormatter implements LogFormatter {
    @Override
    public String format(String level, String message) {
        return String.format("{\"level\":\"%s\",\"message\":\"%s\"}", level, message);
    }
}

public class XmlLogFormatter implements LogFormatter {
    @Override
    public String format(String level, String message) {
        return String.format("<log><level>%s</level><message>%s</message></log>", level, message);
    }
}

public class TextLogFormatter implements LogFormatter {
    @Override
    public String format(String level, String message) {
        return level + ": " + message;
    }
}
```

### 3. 枚举中持有策略实现：

```java
public enum LogFormatStrategy {
    JSON(new JsonLogFormatter()),
    XML(new XmlLogFormatter()),
    TEXT(new TextLogFormatter());

    private final LogFormatter formatter;

    LogFormatStrategy(LogFormatter formatter) {
        this.formatter = formatter;
    }

    public String format(String level, String message) {
        return formatter.format(level, message);
    }
}
```

### 4. 使用示例：

```java
public static void main(String[] args) {
    String result = LogFormatStrategy.JSON.format("INFO", "系统启动成功");
    System.out.println(result);  // 输出 JSON 格式的日志
}
```



## 二、枚举 + 工厂模式 + 策略模式

**场景**：支付策略（微信 / 支付宝）

### 1. 定义支付策略接口：

```java
public interface PayStrategy {
    String pay(String orderId, BigDecimal amount);
}
```

### 2. 实现策略类：

```java
public class WechatPay implements PayStrategy {
    @Override
    public String pay(String orderId, BigDecimal amount) {
        return "使用微信支付：" + orderId + ", 金额：" + amount;
    }
}

public class AliPay implements PayStrategy {
    @Override
    public String pay(String orderId, BigDecimal amount) {
        return "使用支付宝支付：" + orderId + ", 金额：" + amount;
    }
}
```

### 3. 支付类型枚举：

```java
public enum PayType {
    WECHAT, ALIPAY
}
```

### 4. 策略工厂（注册表）：

```java
public class PayStrategyFactory {
    private static final Map<PayType, PayStrategy> STRATEGY_MAP = new HashMap<>();

    static {
        STRATEGY_MAP.put(PayType.WECHAT, new WechatPay());
        STRATEGY_MAP.put(PayType.ALIPAY, new AliPay());
    }

    public static PayStrategy getStrategy(PayType type) {
        return STRATEGY_MAP.get(type);
    }
}
```

### 5. 使用方式：

```java
public static void main(String[] args) {
    PayStrategy strategy = PayStrategyFactory.getStrategy(PayType.WECHAT);
    String result = strategy.pay("ORDER123", new BigDecimal("99.99"));
    System.out.println(result);
}
```



## 三、总结对比

| 示例  | 枚举持有策略 | 工厂注册策略 | 优点              |
|-----|--------|--------|-----------------|
| 示例一 | ✅      | ❌      | 简单直接，适合枚举固定策略   |
| 示例二 | ❌      | ✅      | 支持运行时动态注册、扩展更灵活 |