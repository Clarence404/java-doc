---
description: 注解定义与属性限制、元注解与保留策略、反射读取与 Spring 组合注解、APT / JSR 269、Lombok 与 MapStruct、JDK 23 处理器变化
---

# 注解与注解处理器

> 前置阅读：[泛型](./14_topic_generics)

注解是附加在声明或类型上的元数据，要由编译器、注解处理器或运行时框架读取才产生作用。本篇讲注解定义与元注解、运行时反射读取与 Spring 组合注解、编译期注解处理器（JSR 269）以及 Lombok / MapStruct 的实现方式，基线为 JDK 21。

---

## 一、定义与属性限制

注解（JDK 5）是附加在声明或类型上的元数据，本身不包含行为，需要由编译器、注解处理器或运行时框架读取后才产生作用。

```java
@Documented
@Retention(RetentionPolicy.RUNTIME)
@Target({ElementType.METHOD, ElementType.TYPE})
public @interface RateLimit {
    String key() default "";
    int permitsPerSecond() default 100;
    TimeUnit unit() default TimeUnit.SECONDS;
}
```

属性的限制：

- 类型只能是：基本类型、`String`、`Class`、枚举、其他注解，以及它们的一维数组
- 值必须是**编译期常量**（字面量、`static final` 常量表达式、枚举常量、类字面量），不能是方法调用结果
- 默认值不能是 `null`；需要「未设置」语义时用空串、`-1` 或专门的哨兵值
- 只有一个名为 `value` 的属性时，使用时可省略属性名：`@RateLimit("login")`（前提是该注解声明了 `value`）

## 二、元注解

| 元注解 | 作用 | 要点 |
|--------|------|------|
| `@Retention` | 保留到哪个阶段 | `SOURCE`：编译后丢弃（`@Override`、Lombok 注解）；`CLASS`：写入 class 文件但运行时不可见，**这是默认值**；`RUNTIME`：运行时可通过反射读取。自定义注解要被 Spring 等框架读取，必须是 `RUNTIME` |
| `@Target` | 能标注在哪里 | `TYPE`、`METHOD`、`FIELD`、`PARAMETER` 等；JDK 8 新增 `TYPE_PARAMETER` / `TYPE_USE`（可标注在任何使用类型的位置，如 `List<@NonNull String>`），JDK 9 新增 `MODULE`，JDK 16 新增 `RECORD_COMPONENT` |
| `@Inherited` | 子类继承父类上的注解 | 只对**类上的注解**、只沿**父类**生效；接口上的注解、方法上的注解都不会被继承 |
| `@Repeatable` | 同一位置可重复标注（JDK 8） | 需要一个容器注解；读取时用 `getAnnotationsByType`，`getAnnotation` 拿不到重复的注解 |
| `@Documented` | 出现在 Javadoc 中 | 仅影响文档 |

## 三、运行时读取

```java
Method method = OrderController.class.getMethod("create", OrderRequest.class);
RateLimit limit = method.getAnnotation(RateLimit.class);   // RUNTIME 保留才非 null
if (limit != null) {
    rateLimiter.acquire(limit.key(), limit.permitsPerSecond());
}
```

JDK 的 `getAnnotation` 只看直接标注的注解（加上 `@Inherited` 规则），**不识别元注解组合**：方法上标了 `@GetMapping`，用 `getAnnotation(RequestMapping.class)` 拿到的是 `null`。Spring 通过 `MergedAnnotations` / `AnnotatedElementUtils` 递归解析元注解，并用 `@AliasFor` 把组合注解的属性映射到元注解属性，这才有了 `@RestController`、`@GetMapping` 这类组合注解。业务中用注解驱动横切逻辑（限流、审计、幂等）通常借助切面实现，见 [AOP](/spring/2_aop)。反射 API 本身见 [反射](./15_topic_reflection)。

## 四、注解处理器

注解处理器（JSR 269，`javax.annotation.processing`）在**编译期**运行：javac 解析源码后，按轮次（round）把标注了目标注解的元素交给处理器；处理器生成的新源文件会进入下一轮继续编译，直到没有新文件产生。

```java
@SupportedAnnotationTypes("com.example.Descriptor")
public class DescriptorProcessor extends AbstractProcessor {

    @Override
    public SourceVersion getSupportedSourceVersion() {
        return SourceVersion.latestSupported();     // 不要硬编码 RELEASE_17，否则新 JDK 上会报警告
    }

    @Override
    public boolean process(Set<? extends TypeElement> annotations, RoundEnvironment roundEnv) {
        for (Element element : roundEnv.getElementsAnnotatedWith(Descriptor.class)) {
            if (element.getKind() != ElementKind.CLASS) {
                processingEnv.getMessager().printMessage(
                    Diagnostic.Kind.ERROR, "@Descriptor 只能标注在类上", element);   // 直接让编译失败
                continue;
            }
            TypeElement type = (TypeElement) element;
            String pkg = processingEnv.getElementUtils().getPackageOf(type).getQualifiedName().toString();
            String name = type.getSimpleName() + "Descriptor";
            try (Writer writer = processingEnv.getFiler()
                    .createSourceFile(pkg + "." + name, type).openWriter()) {
                writer.write("package " + pkg + ";\n\n"
                    + "public final class " + name + " {\n"
                    + "    public static final String TYPE = \"" + type.getQualifiedName() + "\";\n"
                    + "}\n");
            } catch (IOException e) {
                processingEnv.getMessager().printMessage(Diagnostic.Kind.ERROR, e.getMessage(), element);
            }
        }
        return true;
    }
}
```

要点：

- **只能生成新文件，不能修改已有类**。标准处理器（MapStruct、Dagger、AutoValue、Spring 的 `spring-context-indexer` 等）都是「读注解 → 生成新类」
- **Lombok 是例外**：它借用注解处理器的入口，却直接修改 javac 内部的语法树（AST），往原有类里塞 getter / 构造器。这依赖 javac 的内部 API，所以每个新 JDK 都要等 Lombok 发布适配版本，详见 [效率工具库](./98_dev_tool)
- **注册方式**：在处理器 jar 的 `META-INF/services/javax.annotation.processing.Processor` 中列出类名（可用 Google AutoService 自动生成）
- **生成源码**：手写字符串容易出错，可用 JavaPoet。原 `square/javapoet` 已归档，维护中的分支是 `com.palantir.javapoet:javapoet`

**JDK 23 的默认行为变化**：从 JDK 23 起，javac **不再自动运行类路径上发现的注解处理器**，除非显式指定处理器（`-processor`、`--processor-path` / `-processorpath`、`--processor-module-path`）或使用 `-proc:full`。JDK 21 起在隐式运行处理器时会给出提示。升级到 JDK 23+ 后最典型的症状是「Lombok 的 getter 突然找不到」「MapStruct 的实现类没有生成」。正确做法是在构建工具中显式声明处理器路径：

```xml
<plugin>
    <groupId>org.apache.maven.plugins</groupId>
    <artifactId>maven-compiler-plugin</artifactId>
    <configuration>
        <annotationProcessorPaths>
            <path>
                <groupId>com.example</groupId>
                <artifactId>descriptor-processor</artifactId>
                <version>1.0.0</version>
            </path>
        </annotationProcessorPaths>
    </configuration>
</plugin>
```

Gradle 的 `annotationProcessor` 依赖配置本来就走处理器路径，不受影响。Lombok + MapStruct 的完整配置见 [效率工具库](./98_dev_tool)，构建工具本身见 [构建工具](/engineering/1_build_tools)。

---

## 小结

- 注解属性只能是基本类型、`String`、`Class`、枚举、注解及其一维数组，值必须是编译期常量，默认值不能是 `null`
- 元注解决定保留期与位置：`@Retention` 默认 `CLASS`，要被框架在运行时读取必须是 `RUNTIME`；`@Inherited` 只对类上的注解、只沿父类生效
- JDK 反射不识别元注解组合，Spring 用 `MergedAnnotations` + `@AliasFor` 实现 `@GetMapping` 这类组合注解
- 注解处理器在编译期按轮次运行，只能生成新文件；MapStruct 等都是「读注解 → 生成新类」，Lombok 修改 javac AST 是特例
- JDK 23 起 javac 不再自动运行类路径上的处理器，必须显式声明处理器路径

## 参考资料

- JLS §9.6 Annotation Interfaces：[https://docs.oracle.com/javase/specs/jls/se25/html/jls-9.html#jls-9.6](https://docs.oracle.com/javase/specs/jls/se25/html/jls-9.html#jls-9.6)
- `javax.annotation.processing` 包文档：[https://docs.oracle.com/en/java/javase/25/docs/api/java.compiler/javax/annotation/processing/package-summary.html](https://docs.oracle.com/en/java/javase/25/docs/api/java.compiler/javax/annotation/processing/package-summary.html)
- javac 文档（`-proc` 与注解处理）：[https://docs.oracle.com/en/java/javase/25/docs/specs/man/javac.html](https://docs.oracle.com/en/java/javase/25/docs/specs/man/javac.html)

> 下一篇：[反射](./15_topic_reflection) —— 注解要在运行时生效离不开反射：看运行时如何读取和调用类的全部成员，以及 JDK 18 后反射的实现变化。
