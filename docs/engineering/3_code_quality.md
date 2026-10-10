---
description: 质量门禁全景、Spotless 格式化、Checkstyle、SpotBugs / PMD、ArchUnit、JaCoCo、Sonar 质量门禁、技术债
---

# 代码质量

> 前置阅读：[构建工具](./1_build_tools)、[单元测试](/testing/1_unit_test)

代码质量门禁用自动化工具在合并前拦住格式、规范、缺陷与架构问题，本篇是 Sonar、JaCoCo、格式化与静态分析工具配置的主文档。内容包括 Spotless、Checkstyle、SpotBugs / PMD、ArchUnit、JaCoCo 与 Sonar 质量门禁的分层搭建和统一的覆盖率阈值口径，插件版本以 2026 年 10 月 Maven Central 为准，基线 JDK 21、Spring Boot 4。

---

## 一、质量门禁全景

![PR 流水线中的质量门禁](../assets/engineering/code-quality-gate-pipeline.svg)

每个工具管一件事，绑定到 Maven 生命周期的不同阶段，一条 `mvn verify` 全部跑完：

| 工具 | 管什么 | 绑定阶段 | 失败即中断构建 |
|------|--------|----------|----------------|
| **Spotless** | 代码格式（缩进、换行、import 顺序） | `verify`（默认） | 是 |
| **Checkstyle** | 格式化管不到的规范（命名、魔法数字、空 catch） | `validate` | 是 |
| **Error Prone** | 编译期 bug 模式（可选） | `compile` | 是 |
| **ArchUnit** | 分层与依赖规则 | `test`（作为单元测试运行） | 是 |
| **JaCoCo** | 覆盖率采集、报告与整体底线 | `test` 采集，`verify` 出报告 | 只拦整体底线 |
| **SpotBugs / PMD** | 字节码 / 源码级缺陷模式 | `verify` | 是 |
| **Sonar** | 汇总问题与覆盖率，按「新代码」判定质量门禁 | `verify` 之后单独执行 | 由 `sonar.qualitygate.wait` 决定 |

原则有三条：

- **左移**：同样的规则在 IDE 里就能看到（IDEA 格式化配置、SonarQube for IDE 的 Connected Mode），CI 只做兜底
- **只卡新代码**：老项目一次性清零不现实，门禁只要求「这次改动不引入新问题」，存量债务单独排期
- **一个口径**：覆盖率等阈值只在 Sonar 质量门禁里定义一次，其他地方引用，不各写一套

### 覆盖率阈值口径（全站统一）

| 层级 | 阈值 | 作用 |
|------|------|------|
| **Sonar 质量门禁：新代码覆盖率** | **≥ 80%**（Sonar way 默认） | 唯一的合并门槛，PR 不达标不能合并 |
| JaCoCo `check`：整体行覆盖率 | 设为当前实际值附近的底线（如 60%），只升不降 | 防止整体大幅回退，不作为合并依据 |
| 整体覆盖率数值 | 不设硬性目标 | 仪表盘上看趋势，供排期补测试参考 |

---

## 二、格式化：Spotless + EditorConfig

Checkstyle 只会报告格式问题，不会修。格式交给**格式化器自动完成**，CI 只检查「是否已格式化」，评审时就不再讨论空格和换行。

### 1、Spotless

```xml
<plugin>
  <groupId>com.diffplug.spotless</groupId>
  <artifactId>spotless-maven-plugin</artifactId>
  <version>3.10.3</version>
  <configuration>
    <!-- 老项目可只检查相对 main 有改动的文件，CI 中 checkout 需 fetch-depth: 0 -->
    <!-- <ratchetFrom>origin/main</ratchetFrom> -->
    <java>
      <palantirJavaFormat/>
      <removeUnusedImports/>
    </java>
  </configuration>
  <executions>
    <execution>
      <goals>
        <goal>check</goal>
      </goals>
    </execution>
  </executions>
</plugin>
```

- 本地执行 `mvn spotless:apply` 一键格式化，`spotless:check` 默认绑定在 `verify` 阶段，未格式化即失败
- 格式化器二选一：**google-java-format**（2 空格缩进、100 列）或 **palantir-java-format**（4 空格、120 列，更接近多数 Java 团队习惯）。本文用 palantir，下面的 EditorConfig 与 Checkstyle 也按 4 空格、120 列配置
- IDEA 安装对应格式化插件（palantir-java-format / google-java-format）后，`Ctrl+Alt+L` 与 CI 结果一致

### 2、EditorConfig

覆盖 Java 以外的文件（YAML、Markdown、SQL），所有主流 IDE 原生识别：

```ini
# .editorconfig（项目根目录）
root = true

[*]
charset = utf-8
end_of_line = lf
indent_style = space
indent_size = 4
max_line_length = 120
trim_trailing_whitespace = true
insert_final_newline = true

[*.{yml,yaml,json}]
indent_size = 2

[*.md]
trim_trailing_whitespace = false
```

---

## 三、Checkstyle：格式化管不到的规范

### 1、插件配置

```xml
<plugin>
  <groupId>org.apache.maven.plugins</groupId>
  <artifactId>maven-checkstyle-plugin</artifactId>
  <version>3.6.0</version>
  <dependencies>
    <!-- 插件默认内置 Checkstyle 9.3，显式升级引擎版本 -->
    <dependency>
      <groupId>com.puppycrawl.tools</groupId>
      <artifactId>checkstyle</artifactId>
      <version>14.3.0</version>
    </dependency>
  </dependencies>
  <configuration>
    <configLocation>config/checkstyle/checkstyle.xml</configLocation>
    <consoleOutput>true</consoleOutput>
    <failOnViolation>true</failOnViolation>
    <violationSeverity>warning</violationSeverity>
  </configuration>
  <executions>
    <execution>
      <id>checkstyle</id>
      <phase>validate</phase>
      <goals>
        <goal>check</goal>
      </goals>
    </execution>
  </executions>
</plugin>
```

几个容易配错的点：

- **`check` 是否失败看 `failOnViolation`（默认 true）+ `violationSeverity`（默认 error）**：只有达到该级别的违规才会让构建失败。旧配置里常见的 `failsOnError` 同样只对 error 级别的违规生效
- 插件自带的 `google_checks.xml` 把所有违规报为 **warning**，配默认的 `violationSeverity=error` 时有违规也照样通过；而且它要求 2 空格缩进、100 列，与 4 空格的 EditorConfig 冲突。直接用 `configLocation` 引用内置文件时写 `google_checks.xml` 即可，不用拷到项目里
- 升级 Checkstyle 引擎后先本地跑一次 `mvn checkstyle:check`，个别检查项在大版本间会改名或移除

### 2、规则文件

格式交给 Spotless 后，Checkstyle 只保留格式化器管不到的规则。`config/checkstyle/checkstyle.xml`：

```xml
<?xml version="1.0"?>
<!DOCTYPE module PUBLIC
    "-//Checkstyle//DTD Checkstyle Configuration 1.3//EN"
    "https://checkstyle.org/dtds/configuration_1_3.dtd">
<module name="Checker">
  <property name="severity" value="error"/>
  <module name="SuppressWarningsFilter"/>
  <module name="LineLength">
    <property name="max" value="120"/>
  </module>
  <module name="TreeWalker">
    <module name="SuppressWarningsHolder"/>
    <module name="AvoidStarImport"/>
    <module name="UnusedImports"/>
    <module name="EmptyCatchBlock"/>
    <module name="MagicNumber"/>
    <module name="VisibilityModifier"/>
    <module name="HideUtilityClassConstructor"/>
    <module name="FinalClass"/>
    <module name="CyclomaticComplexity">
      <property name="max" value="10"/>
    </module>
    <module name="MethodLength">
      <property name="max" value="80"/>
    </module>
  </module>
</module>
```

| 规则 | 作用 |
|------|------|
| `LineLength` | 行长不超过 120（自 Checkstyle 8.24 起必须放在 `Checker` 下，不能放进 `TreeWalker`） |
| `MagicNumber` | 禁止魔法数字，默认放过 -1、0、1、2 |
| `EmptyCatchBlock` | 禁止空 catch 块 |
| `VisibilityModifier` | 成员变量必须 private（常量除外） |
| `HideUtilityClassConstructor` | 只有静态方法的工具类必须有私有构造器 |
| `FinalClass` | 只有私有构造器的类必须声明为 final |
| `CyclomaticComplexity` | 单方法圈复杂度不超过 10 |
| `SuppressWarningsHolder` + `SuppressWarningsFilter` | 允许用 `@SuppressWarnings("checkstyle:magicnumber")` 局部豁免 |

团队已采用《阿里巴巴 Java 开发手册》时，可改用 P3C 规则集（基于 PMD），与本节二选一，不要两套命名规则同时开。

---

## 四、缺陷检查：SpotBugs、PMD 与 Error Prone

### 1、SpotBugs

SpotBugs 分析编译后的字节码，找的是「能编译通过但运行时会出错」的模式：

```xml
<plugin>
  <groupId>com.github.spotbugs</groupId>
  <artifactId>spotbugs-maven-plugin</artifactId>
  <version>4.10.4.1</version>
  <configuration>
    <effort>Max</effort>
    <threshold>Medium</threshold>
    <failOnError>true</failOnError>
    <excludeFilterFile>config/spotbugs/exclude.xml</excludeFilterFile>
  </configuration>
  <executions>
    <execution>
      <goals>
        <goal>check</goal>
      </goals>
    </execution>
  </executions>
</plugin>
```

`threshold` 设为 `Low` 会带来大量低价值告警，一般从 `Medium` 起步。下面是它真正能报出的典型模式（括号里是 Bug 类型代码，可在官方 Bug descriptions 里查到）：

```java
class SpotBugsSamples {

    // 反例：用 == 比较字符串内容（ES_COMPARING_PARAMETER_STRING_WITH_EQ）
    boolean isPaidBad(String status) {
        return status == "PAID";
    }

    // 正例
    boolean isPaid(String status) {
        return "PAID".equals(status);
    }

    // 反例：trim() 返回新字符串，结果被丢掉（RV_RETURN_VALUE_IGNORED）
    String normalizeBad(String name) {
        name.trim();
        return name;
    }

    // 正例
    String normalize(String name) {
        return name.trim();
    }

    // 反例：vip 为 false 时 level 为 null，随后被解引用（NP_NULL_ON_SOME_PATH）
    int levelLengthBad(boolean vip) {
        String level = null;
        if (vip) {
            level = "GOLD";
        }
        return level.length();
    }

    // 反例：调用装箱类型构造器（DM_NUMBER_CTOR），new Integer(int) 自 JDK 16 起标记为待移除
    Integer boxBad() {
        return new Integer(42);
    }

    // 正例：Integer.valueOf 会复用 -128~127 的缓存
    Integer box() {
        return Integer.valueOf(42);
    }
}
```

`EI_EXPOSE_REP` / `EI_EXPOSE_REP2`（getter 直接返回可变字段、构造器直接保存外部传入的可变对象）在 Spring Bean、Lombok 实体上误报很多，常见做法是在 `exclude.xml` 里按包排除：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<FindBugsFilter xmlns="https://github.com/spotbugs/filter/3.0.0">
  <Match>
    <Bug pattern="EI_EXPOSE_REP,EI_EXPOSE_REP2"/>
    <Package name="~com\.example\.order\.(dto|entity|config)(\..*)?"/>
  </Match>
</FindBugsFilter>
```

### 2、PMD

PMD 分析源码，规则覆盖最佳实践、易错写法、复杂度和重复代码（CPD）。与 SpotBugs 部分重叠，团队一般选一个为主：

```xml
<plugin>
  <groupId>org.apache.maven.plugins</groupId>
  <artifactId>maven-pmd-plugin</artifactId>
  <version>3.28.0</version>
  <configuration>
    <targetJdk>21</targetJdk>
    <printFailingErrors>true</printFailingErrors>
  </configuration>
  <executions>
    <execution>
      <goals>
        <goal>check</goal>
      </goals>
    </execution>
  </executions>
</plugin>
```

不配 `rulesets` 时使用插件自带的默认规则集；要自定义时用 PMD 7 的分类规则，如 `/category/java/bestpractices.xml`、`/category/java/errorprone.xml`，再逐条排除不适用的规则。

### 3、Error Prone

Error Prone 是 Google 的 javac 插件，在**编译期**报错，例如格式化字符串参数个数不符、对 `equals` 参数类型永远不相等的比较、忽略 `Future` 返回值等。它需要配置 `maven-compiler-plugin` 的 `annotationProcessorPaths` 和 `-Xplugin:ErrorProne`，并在 `.mvn/jvm.config` 里为 javac 开放若干内部包；当前版本要求用 JDK 21 及以上运行编译器。配置细节随版本变化，按官方安装文档操作。适合愿意把「编译通过」标准提高的团队，可与 SpotBugs 并用。

---

## 五、ArchUnit：把架构约定写成测试

分层约束只写在文档里，几个月后就会出现 Controller 直接调 Repository。ArchUnit 把这类约定变成普通的 JUnit 测试，随 `mvn test` 执行：

```xml
<dependency>
  <groupId>com.tngtech.archunit</groupId>
  <artifactId>archunit-junit5</artifactId>
  <version>1.5.1</version>
  <scope>test</scope>
</dependency>
```

```java
import com.tngtech.archunit.core.importer.ImportOption;
import com.tngtech.archunit.junit.AnalyzeClasses;
import com.tngtech.archunit.junit.ArchTest;
import com.tngtech.archunit.lang.ArchRule;

import static com.tngtech.archunit.library.Architectures.layeredArchitecture;
import static com.tngtech.archunit.library.GeneralCodingRules.NO_CLASSES_SHOULD_USE_FIELD_INJECTION;
import static com.tngtech.archunit.library.GeneralCodingRules.NO_CLASSES_SHOULD_USE_JAVA_UTIL_LOGGING;

@AnalyzeClasses(packages = "com.example.order", importOptions = ImportOption.DoNotIncludeTests.class)
class ArchitectureTest {

    @ArchTest
    static final ArchRule layers = layeredArchitecture()
            .consideringOnlyDependenciesInLayers()
            .layer("Controller").definedBy("..controller..")
            .layer("Service").definedBy("..service..")
            .layer("Repository").definedBy("..repository..")
            .whereLayer("Controller").mayNotBeAccessedByAnyLayer()
            .whereLayer("Service").mayOnlyBeAccessedByLayers("Controller")
            .whereLayer("Repository").mayOnlyBeAccessedByLayers("Service");

    @ArchTest
    static final ArchRule constructorInjection = NO_CLASSES_SHOULD_USE_FIELD_INJECTION;

    @ArchTest
    static final ArchRule noJul = NO_CLASSES_SHOULD_USE_JAVA_UTIL_LOGGING;
}
```

- `consideringOnlyDependenciesInLayers()` 只检查层与层之间的依赖，不管对 JDK、Spring 等外部类的依赖
- 老项目一次性修不完时，用 `FreezingArchRule.freeze(rule)` 把现有违规记录为基线，只拦新增违规
- DDD / 六边形架构的包结构同样可以描述，见 [DDD](/architecture/3_ddd)

---

## 六、JaCoCo：覆盖率采集

```xml
<plugin>
  <groupId>org.jacoco</groupId>
  <artifactId>jacoco-maven-plugin</artifactId>
  <version>0.8.15</version>
  <executions>
    <execution>
      <id>prepare-agent</id>
      <goals>
        <goal>prepare-agent</goal>
      </goals>
    </execution>
    <execution>
      <id>report</id>
      <phase>verify</phase>
      <goals>
        <goal>report</goal>
      </goals>
      <configuration>
        <excludes>
          <exclude>**/config/**</exclude>
          <exclude>**/*Application.class</exclude>
        </excludes>
      </configuration>
    </execution>
    <execution>
      <id>check</id>
      <goals>
        <goal>check</goal>
      </goals>
      <configuration>
        <excludes>
          <exclude>**/config/**</exclude>
          <exclude>**/*Application.class</exclude>
        </excludes>
        <rules>
          <rule>
            <element>BUNDLE</element>
            <limits>
              <!-- 整体底线：取当前实际值附近，只升不降；合并门槛看 Sonar 新代码覆盖率 -->
              <limit>
                <counter>LINE</counter>
                <value>COVEREDRATIO</value>
                <minimum>0.60</minimum>
              </limit>
            </limits>
          </rule>
        </rules>
      </configuration>
    </execution>
  </executions>
</plugin>
```

- **0.8.14 起正式支持 Java 25，0.8.15 支持 Java 26**；用较新 JDK 编译时 JaCoCo 版本过旧会在插桩时报不支持的 class 文件版本
- `prepare-agent` 通过 `argLine` 属性把 agent 传给 Surefire。如果 POM 里自己写了 `<argLine>`，要写成 `<argLine>@{argLine} -Xmx1g</argLine>`，否则 agent 被覆盖，覆盖率为 0
- `excludes` 只放在 `report` / `check` 上，它们匹配的是 class 文件路径；`prepare-agent` 的 `excludes` 语义是类名，混写容易误以为生效
- `report` 产出的 `target/site/jacoco/jacoco.xml` 是 Sonar 默认读取的路径，无需额外配置；多模块项目用 `report-aggregate` 在单独的聚合模块里合并报告
- Lombok 生成的代码不应计入覆盖率，在 `lombok.config` 加 `lombok.addLombokGeneratedAnnotation = true` 即可被 JaCoCo 自动过滤，见 [效率工具库](/java/98_dev_tool)

| 计数器 | 含义 | 怎么看 |
|--------|------|--------|
| **LINE** | 被执行到的行 | 最直观，Sonar 的覆盖率由行和分支综合计算 |
| **BRANCH** | `if` / `switch` / 三目运算的分支 | 比行覆盖更能反映测试是否走到异常路径 |
| **METHOD** / **CLASS** | 至少执行过一次的方法 / 类 | 粒度太粗，只做参考 |

覆盖率高不代表测试有效：没有断言的测试照样能把覆盖率刷到 100%。想衡量断言质量可以引入变异测试工具 PIT（pitest），它会故意修改代码，看测试能否发现。

---

## 七、Sonar：汇总与质量门禁

### 1、产品与模式

2024 年底起 Sonar 产品线更名：

| 现在的名字 | 以前的名字 | 说明 |
|------------|-----------|------|
| **SonarQube Server** | SonarQube（Developer / Enterprise / Data Center） | 自建，商业版支持分支与 PR 分析 |
| **SonarQube Community Build** | SonarQube Community Edition | 自建免费版，只分析主分支 |
| **SonarQube Cloud** | SonarCloud | SaaS，开源项目可免费使用 |
| **SonarQube for IDE** | SonarLint | IDE 插件，Connected Mode 下与服务端规则同步 |

问题分类有两种模式：

- **MQR 模式**（Multi-Quality Rule，新安装默认）：一个问题按影响的软件质量归类为 Security、Reliability、Maintainability，严重度为 Blocker / High / Medium / Low / Info
- **Standard Experience**：沿用 Bug / Vulnerability / Code Smell 三类与 Blocker / Critical / Major / Minor / Info 严重度

两种模式下 **Security Hotspot** 都单独存在：它不是确定的漏洞，而是需要人工确认的敏感代码（如自建加密、关闭 CSRF），评审后标记为 Safe 或 Fixed。

### 2、质量门禁与「新代码」

内置的 **Sonar way** 门禁只看新代码，四个条件：

| 条件 | 阈值 |
|------|------|
| 新代码问题数 | 0（或新代码可靠性 / 安全性 / 可维护性评级均为 A） |
| 新增安全热点 | 100% 已评审 |
| 新代码覆盖率 | ≥ 80% |
| 新代码重复率 | ≤ 3% |

- 新代码改动少于 20 行时，覆盖率和重复率条件不生效（fudge factor，默认开启），避免改一行配置就被覆盖率卡住
- 「新代码」的定义在项目设置里选：主干开发（trunk-based / GitHub Flow）建议设为 **Reference branch = main**，PR 分析时以目标分支为基准
- 建议直接沿用 Sonar way，确需调整时复制一份再改，不要把条件放宽到「允许 N 个新问题」

### 3、Maven 扫描配置

在 `pluginManagement` 固定扫描器版本（不固定会自动用最新版），项目级参数写进 `properties`：

```xml
<properties>
  <sonar.projectKey>order-service</sonar.projectKey>
  <sonar.coverage.exclusions>**/config/**,**/*Application.java</sonar.coverage.exclusions>
</properties>

<build>
  <pluginManagement>
    <plugins>
      <plugin>
        <groupId>org.sonarsource.scanner.maven</groupId>
        <artifactId>sonar-maven-plugin</artifactId>
        <version>5.8.0.7211</version>
      </plugin>
    </plugins>
  </pluginManagement>
</build>
```

当前扫描器要求用 **Java 21+** 运行 Maven（被分析的项目可以编译到更低版本）。`sonar.coverage.exclusions` 只把文件排除在覆盖率统计之外，问题照常检查；要连问题一起排除用 `sonar.exclusions`。

### 4、在 CI 中执行

下面是 GitHub Actions 中构建、测试、分析一步完成的关键步骤，完整工作流（触发、权限、Action 固定到 SHA）见 [CI/CD](/devops/2_ci_cd)：

流水线怎么编排（触发条件、Job 依赖、分支保护）见 [CI/CD](/devops/2_ci_cd)。

```yaml
steps:
  - uses: actions/checkout@v7
    with:
      fetch-depth: 0          # Sonar 需要完整历史来识别新代码和 blame 信息
  - uses: actions/setup-java@v6
    with:
      distribution: temurin
      java-version: '21'
      cache: maven
  - name: Build, test and analyze
    env:
      SONAR_TOKEN: ${{ secrets.SONAR_TOKEN }}
      SONAR_HOST_URL: ${{ vars.SONAR_HOST_URL }}
    run: >-
      mvn -B verify
      org.sonarsource.scanner.maven:sonar-maven-plugin:sonar
      -Dsonar.qualitygate.wait=true
```

- `SONAR_TOKEN`、`SONAR_HOST_URL` 环境变量会被扫描器直接读取，不必再用 `-D` 重复传一遍；不设 `SONAR_HOST_URL` 时默认连 SonarQube Cloud
- `sonar.qualitygate.wait=true` 让扫描器等待服务端计算出门禁结果，**门禁失败则这一步失败**，再配合分支保护的必需检查项阻断合并
- 用商业版或 SonarQube Cloud 时，PR 分析结果会回写到 PR 页面，评审人可以直接看到新问题列表

---

## 八、技术债管理

### 1、识别与量化

| 想找什么 | 在 Sonar 里怎么看 |
|----------|-------------------|
| 修复成本最高的问题 | Issues → 按 Software Quality = Maintainability 过滤，按 Effort 排序 |
| 复杂度最高的方法 | Measures → Complexity → 按文件排序，单方法圈复杂度超过 10 的优先拆 |
| 重复最多的文件 | Measures → Duplications → 重复率最高的文件 |
| 整体趋势 | Activity 页看技术债、覆盖率、问题数随版本的变化 |

### 2、渐进式偿还

- **童子军规则（Boy Scout Rule）**：每次修改代码时顺手让它比改之前更干净；质量门禁只卡新代码，正好与之配合
- **按顺序重构**：先补测试再重构（没有测试的重构就是在赌）→ 拆长方法（一个方法只做一件事）→ 按单一职责拆上帝类 → 抽出接口隔离外部依赖，方便测试替身
- **单独排期**：在迭代中固定留出一部分容量还债，从「改动频繁 + 复杂度高」的文件开始，收益最大
- **冻结基线**：ArchUnit 的 `FreezingArchRule`、Spotless 的 `ratchetFrom`、Sonar 的「新代码」都是同一个思路：存量不追究，增量不放过

### 3、TODO 规范

```java
// 统一格式：类型[分类]: 说明 + 跟踪单号，便于搜索和统计
// TODO[tech-debt]: 临时同步调用，v2.0 前改为异步处理 ORDER-123
// FIXME[perf]: N+1 查询，待引入批量接口 ORDER-145
// HACK[compat]: 兼容旧数据格式，历史数据清理后删除 ORDER-160
```

- 没有跟踪单号的 TODO 很快变成永久代码；Sonar 默认规则也会把 TODO 标记为问题提醒处理
- IDEA 的 TODO 工具窗口（View → Tool Windows → TODO）可按自定义模式过滤，提交时勾选 Check TODO 会在提交前列出新增的 TODO

---

## 小结

- 质量门禁分层：Spotless 管格式、Checkstyle 管规范、SpotBugs / PMD / Error Prone 找缺陷、ArchUnit 守架构、JaCoCo 采覆盖率，Sonar 统一判定
- 覆盖率口径：合并门槛只有一个，即 Sonar 质量门禁的新代码覆盖率 ≥ 80%；JaCoCo `check` 只做只升不降的整体底线，整体覆盖率看趋势
- 格式交给格式化器自动完成，Checkstyle 只留格式化器管不到的规则；`google_checks.xml` 默认 warning 级别，配 `violationSeverity` 才会失败
- SpotBugs 从 `Medium` 阈值起步，误报多的 `EI_EXPOSE_REP` 按包排除；PMD 与 SpotBugs 二选一为主
- JaCoCo 用 0.8.14+ 以支持 Java 25，自定义 `argLine` 时保留 `@{argLine}`
- Sonar 产品已更名为 SonarQube Server / Community Build / Cloud / for IDE；CI 中 `fetch-depth: 0` 加 `sonar.qualitygate.wait=true`，再用分支保护阻断合并
- 技术债的核心思路是冻结存量、卡住增量，再按「改动频繁 + 复杂度高」排期偿还

评审清单见 [Code Review](/devops/3_code_review)，代码坏味道示例见 [开发规范](/devops/4_dev_standards)，依赖漏洞与许可证扫描见 [依赖治理](./6_dependency_governance)。

## 参考资料

- Sonar 质量门禁：[Introduction to quality gates](https://docs.sonarsource.com/sonarqube-server/latest/quality-standards-administration/managing-quality-gates/introduction-to-quality-gates/)
- SonarScanner for Maven：[SonarScanner for Maven](https://docs.sonarsource.com/sonarqube-server/latest/analyzing-source-code/scanners/sonarscanner-for-maven/)
- Sonar 新代码定义：[About new code](https://docs.sonarsource.com/sonarqube-server/latest/user-guide/about-new-code/)
- Sonar CI 中等待门禁结果：[CI integration overview](https://docs.sonarsource.com/sonarqube-server/latest/analyzing-source-code/ci-integration/overview/)
- Spotless Maven 插件：[spotless-maven-plugin](https://github.com/diffplug/spotless/tree/main/plugin-maven)
- Maven Checkstyle 插件：[check 目标参数](https://maven.apache.org/plugins/maven-checkstyle-plugin/check-mojo.html)
- Maven Checkstyle 插件升级引擎版本：[Upgrading Checkstyle at Runtime](https://maven.apache.org/plugins/maven-checkstyle-plugin/examples/upgrading-checkstyle.html)
- Checkstyle 检查项列表：[Checks](https://checkstyle.org/checks.html)
- SpotBugs Maven 插件：[spotbugs-maven-plugin](https://spotbugs.github.io/spotbugs-maven-plugin/)
- SpotBugs Bug 类型说明：[Bug descriptions](https://spotbugs.readthedocs.io/en/latest/bugDescriptions.html)
- SpotBugs 过滤文件：[Filter file](https://spotbugs.readthedocs.io/en/latest/filter.html)
- Maven PMD 插件：[maven-pmd-plugin](https://maven.apache.org/plugins/maven-pmd-plugin/)
- Error Prone 安装：[Error Prone Installation](https://errorprone.info/docs/installation)
- ArchUnit 用户指南：[ArchUnit User Guide](https://www.archunit.org/userguide/html/000_Index.html)
- JaCoCo Maven 插件：[JaCoCo Maven Plug-in](https://www.jacoco.org/jacoco/trunk/doc/maven.html)
- JaCoCo 版本变更：[Change History](https://www.jacoco.org/jacoco/trunk/doc/changes.html)
- EditorConfig：[editorconfig.org](https://editorconfig.org/)

> 下一篇：[线上诊断](./4_diagnosis)
