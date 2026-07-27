# 面试高频题

> 汇总 Spring / Spring Boot 核心知识的高频面试问题，完整解答见 <RouteLink to="/interview/4_spring">开发总结-Spring</RouteLink>

## 一、IoC 与 DI

- **IoC 和 DI 的区别？Spring IoC 容器的作用是什么？**
- **Bean 的注入方式有哪些？构造器注入、Setter 注入、字段注入各有什么优缺点？**
- **`@Autowired` 和 `@Resource` 的区别？**
- **Spring 如何解决循环依赖？三级缓存的原理是什么？**

## 二、AOP

- **AOP 的核心概念（切面、切点、通知、连接点）是什么？**
- **Spring AOP 的实现方式？JDK 动态代理和 CGLIB 的选择策略？**
- **`@Transactional` 为什么在同一个类内部调用会失效？**
- **AOP 的通知类型有哪些？执行顺序是什么？**

## 三、Bean 生命周期

- **Spring Bean 的完整生命周期是什么？**
- **`@PostConstruct`、`InitializingBean`、`init-method` 的执行顺序？**
- **`BeanFactory` 和 `ApplicationContext` 的区别？**
- **Bean 的作用域有哪些？`@Scope("prototype")` 和默认单例有什么区别？**

## 四、事务

- **Spring 事务的传播行为有哪几种？`REQUIRED` 和 `REQUIRES_NEW` 的区别？**
- **`@Transactional` 失效的常见场景有哪些？**
- **Spring 声明式事务和编程式事务的区别？**

## 五、Spring Boot

- **Spring Boot 自动配置的原理是什么？`@SpringBootApplication` 做了什么？**
- **`spring.factories` / `AutoConfiguration.imports` 的作用？**
- **如何自定义一个 Spring Boot Starter？**
- **Spring Boot 启动流程是什么？**  
  → 详见 <RouteLink to="/spring-boot/0_spring_boot">Spring Boot</RouteLink>

## 六、Spring MVC

- **Spring MVC 的请求处理流程（DispatcherServlet 工作原理）？**
- **`@Controller` 和 `@RestController` 的区别？**
- **过滤器（Filter）和拦截器（Interceptor）的区别？**

---

::: tip 完整解答
以上问题的详细解答见 <RouteLink to="/interview/4_spring">开发总结-Spring</RouteLink>
:::
