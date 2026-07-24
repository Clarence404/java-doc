# 代码质量

---

## 一、SonarQube 静态分析

### 与 CI/CD 集成

```yaml
# GitHub Actions
- name: SonarQube 分析
  env:
    SONAR_TOKEN: ${{ secrets.SONAR_TOKEN }}
    SONAR_HOST_URL: ${{ secrets.SONAR_HOST_URL }}
  run: |
    mvn verify sonar:sonar \
      -Dsonar.projectKey=my-project \
      -Dsonar.host.url=$SONAR_HOST_URL \
      -Dsonar.token=$SONAR_TOKEN
```

```xml
<!-- pom.xml -->
<plugin>
  <groupId>org.sonarsource.scanner.maven</groupId>
  <artifactId>sonar-maven-plugin</artifactId>
  <version>3.10.0.2594</version>
</plugin>
```

### Quality Gate 推荐阈值

| 指标 | 建议阈值 | 说明 |
|------|---------|------|
| 新代码覆盖率 | ≥ 80% | 新增代码必须有测试 |
| 新代码重复率 | ≤ 3% | 控制复制粘贴 |
| 新代码 Bug | 0 | 零容忍 |
| 新代码漏洞 | 0 | 零容忍 |
| 新代码 Code Smell | ≤ 10 | 可接受少量 |

### 常见问题类型

| 类型 | 典型示例 | 影响 |
|------|---------|------|
| **Bug** | 空指针未判断、资源未关闭 | 运行时崩溃 |
| **Vulnerability** | SQL 拼接、密码硬编码 | 安全风险 |
| **Code Smell** | 方法超 50 行、圈复杂度 > 10 | 可维护性差 |
| **Security Hotspot** | 随机数、加密算法使用 | 需人工评审 |

---

## 二、代码风格

### Checkstyle

```xml
<!-- pom.xml -->
<plugin>
  <groupId>org.apache.maven.plugins</groupId>
  <artifactId>maven-checkstyle-plugin</artifactId>
  <version>3.3.1</version>
  <configuration>
    <configLocation>checkstyle/google_checks.xml</configLocation>
    <failsOnError>true</failsOnError>
    <includeTestSourceDirectory>true</includeTestSourceDirectory>
  </configuration>
  <executions>
    <execution>
      <id>validate</id>
      <phase>validate</phase>
      <goals><goal>check</goal></goals>
    </execution>
  </executions>
</plugin>
```

常用规则：

| 规则 | 作用 |
|------|------|
| `LineLength` | 限制行长（建议 120 字符） |
| `MagicNumber` | 禁止魔法数字 |
| `EmptyCatchBlock` | 禁止空 catch 块 |
| `VisibilityModifier` | 成员变量必须 private |
| `FinalClass` | 工具类必须 final 且私有构造 |

### EditorConfig（跨 IDE 统一风格）

```ini
# .editorconfig（放项目根目录）
root = true

[*]
charset = utf-8
end_of_line = lf
indent_style = space
indent_size = 4
trim_trailing_whitespace = true
insert_final_newline = true

[*.{yml,yaml}]
indent_size = 2

[*.md]
trim_trailing_whitespace = false
```

---

## 三、SpotBugs（Bug 检查）

```xml
<plugin>
  <groupId>com.github.spotbugs</groupId>
  <artifactId>spotbugs-maven-plugin</artifactId>
  <version>4.8.3.0</version>
  <configuration>
    <effort>Max</effort>
    <threshold>Low</threshold>
    <failOnError>true</failOnError>
  </configuration>
  <executions>
    <execution>
      <phase>verify</phase>
      <goals><goal>check</goal></goals>
    </execution>
  </executions>
</plugin>
```

**常见 Bug 模式**：

```java
// ❌ map.get 可能返回 null 直接调用方法
String value = map.get("key").toString();

// ✅
String value = Optional.ofNullable(map.get("key")).map(Object::toString).orElse("");

// ❌ new Integer()（废弃且不走缓存）
Integer i = new Integer(42);

// ✅ 自动装箱走缓存（-128~127）
Integer i = 42;
```

---

## 四、JaCoCo 代码覆盖率

```xml
<plugin>
  <groupId>org.jacoco</groupId>
  <artifactId>jacoco-maven-plugin</artifactId>
  <version>0.8.11</version>
  <executions>
    <execution>
      <id>prepare-agent</id>
      <goals><goal>prepare-agent</goal></goals>
    </execution>
    <execution>
      <id>report</id>
      <phase>verify</phase>
      <goals><goal>report</goal></goals>
    </execution>
    <execution>
      <id>check</id>
      <goals><goal>check</goal></goals>
      <configuration>
        <rules>
          <rule>
            <element>BUNDLE</element>
            <limits>
              <limit>
                <counter>LINE</counter>
                <value>COVEREDRATIO</value>
                <minimum>0.70</minimum>
              </limit>
              <limit>
                <counter>BRANCH</counter>
                <value>COVEREDRATIO</value>
                <minimum>0.60</minimum>
              </limit>
            </limits>
          </rule>
        </rules>
      </configuration>
    </execution>
  </executions>
  <configuration>
    <excludes>
      <exclude>**/config/**</exclude>
      <exclude>**/dto/**</exclude>
      <exclude>**/*Application.class</exclude>
    </excludes>
  </configuration>
</plugin>
```

**覆盖率指标**：

| 指标 | 含义 |
|------|------|
| **Line** | 有多少行代码被执行 |
| **Branch** | if/switch/三目等分支被覆盖比例 |
| **Method** | 有多少方法被调用 |
| **Class** | 有多少类被加载 |

---

## 五、技术债管理

### 识别与量化

```
SonarQube 视图：Issues → Type=Code Smell → 按 Effort 排序（修复工时估算）
圈复杂度过高方法：Measures → Complexity → Top Files（建议单方法 ≤ 10）
重复代码块：Measures → Duplications → 找到重复率最高的文件
```

### 渐进式重构策略

**Boy Scout Rule**：每次修改代码时顺手让它比修改前更干净，无需专门重构迭代。

```
分阶段策略：
  阶段 1：测试补齐  → 先覆盖再重构，避免无测试改动引入 Bug
  阶段 2：提取函数  → 长方法拆分（每个方法只做一件事，行数 ≤ 30）
  阶段 3：提取类    → 上帝类按单一职责拆分
  阶段 4：接口抽象  → 去掉具体依赖，依赖接口（方便测试 Mock）
```

### TODO 规范

```java
// 统一格式，便于搜索和追踪
// TODO[tech-debt]: 临时方案，需在 v2.0 前改为异步处理 Issue#123
// FIXME[perf]: N+1 查询，待引入批量接口
// HACK[compat]: 兼容旧数据格式，旧数据清理后删除
```

IDEA 中 → View → Tool Windows → TODO，统一查看全项目标记。
