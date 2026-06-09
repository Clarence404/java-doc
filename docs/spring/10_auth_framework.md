# 安全框架横向对比

> 参考资料：
> * Sa-Token 官方文档：[https://sa-token.cc/doc.html](https://sa-token.cc/doc.html)
> * Apache Shiro：[https://shiro.apache.org/documentation.html](https://shiro.apache.org/documentation.html)
> * Spring Security：[https://docs.spring.io/spring-security/reference/](https://docs.spring.io/spring-security/reference/)

> 本文聚焦框架选型与 API 使用。认证授权基础概念（RBAC / ABAC / OAuth2 / JWT）见 → [认证与授权](/security/1_authentication)

## 一、三大框架对比

| 对比项 | Spring Security | Sa-Token | Apache Shiro |
|--------|----------------|----------|-------------|
| 定位 | Spring 官方安全框架 | 轻量级 Java 权限框架 | 通用 Java 安全框架 |
| 集成难度 | 中（需理解过滤器链） | 低（开箱即用） | 低 |
| 功能完整度 | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐ | ⭐⭐⭐ |
| 与 Spring Boot 集成 | 原生，无缝 | 良好 | 需手动配置 |
| 微服务 / 分布式支持 | 需配合 OAuth2 | 内置 Redis 分布式 Session | 需自行扩展 |
| 响应式支持 | ✅ WebFlux | ❌ | ❌ |
| 学习曲线 | 高 | 低 | 中 |
| 社区活跃度 | 高（Spring 生态） | 高（国内活跃） | 中（趋于维护态） |

## 二、Sa-Token 核心功能

Sa-Token 专为国内项目设计，API 极简，内置大量开箱即用功能：

| 功能 | 说明 |
|------|------|
| 登录认证 | `StpUtil.login(userId)` |
| 权限校验 | `StpUtil.checkPermission("user:add")` |
| 角色校验 | `StpUtil.checkRole("admin")` |
| 踢人下线 | `StpUtil.kickout(userId)` |
| 账号封禁 | `StpUtil.disable(userId, 86400)` |
| 二级认证 | 敏感操作二次验证 |
| 分布式 Session | 内置 Redis 集成 |

## 三、选型建议

| 场景 | 推荐 |
|------|------|
| Spring Boot 单体 / 标准企业项目 | Spring Security |
| 快速开发、不想深入安全框架 | Sa-Token |
| 非 Spring 的 Java 项目 | Shiro |
| 微服务 + OAuth2 / OIDC | Spring Security + Spring Authorization Server |
| 国内中小项目，需要分布式 Session | Sa-Token + Redis |

> [!warning]
> 待补充
