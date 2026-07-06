# Java Doc

**Java Backend Technology Knowledge Base**

A personal technical documentation site built with [VuePress](https://vuepress.vuejs.org/) + [vuepress-theme-hope](https://theme-hope.vuejs.press/), systematically covering backend development, distributed systems, cloud-native, and emerging technologies.

🌐 **Live Site**: [java-doc on GitHub Pages](https://clarence404.github.io/java-doc/)

---

## Coverage

| Nav Group | Modules |
|-----------|---------|
| **开发总结** | Java / DB / Cache / JVM / Spring / MQ 高频题 |
| **基础体系** | Java 8–21 / JVM / Algorithms / Design Patterns |
| **框架生态** | Spring / Spring Boot / Netty / Testing |
| **数据存储** | MySQL / Redis / Kafka / RocketMQ / RabbitMQ |
| **分布式架构** | CAP / Raft / Distributed Lock / High Concurrency / High Availability / Microservices |
| **架构设计** | System Architecture / DDD / Business Scenarios |
| **工程运维** | Cloud Native / DevOps / Protocols |
| **新兴技术** | IoT / AI (Spring AI / LangChain4j / RAG) |

---

## Project Structure

```
java-doc/
├── docs/
│   ├── .vuepress/          # VuePress config, theme, SCSS styles
│   │   ├── config.js       # Navbar, sidebar, plugins
│   │   └── styles/         # Custom SCSS (hero gradient, card hover, etc.)
│   ├── ai/                 # AI：frameworks / RAG / Agent / MCP / tools
│   ├── algorithms/         # Algorithms & data structures
│   ├── architecture/       # System architecture / DDD / idempotency
│   ├── cache/              # Redis / Caffeine / two-level cache
│   ├── cloud-native/       # Linux / Docker / Kubernetes / VPS
│   ├── database/           # MySQL / NoSQL / time-series / search
│   ├── devops/             # Git workflow / CI/CD / Code Review
│   ├── distributed/        # CAP / Raft / lock / transaction / session
│   ├── high-avail/         # Rate limiting / circuit breaker / degradation
│   ├── high-con/           # JUC / thread pool / concurrency design
│   ├── interview/          # High-frequency interview topics
│   ├── iot/                # IoT architecture / MQTT / OPC-UA / ThingsBoard
│   ├── java/               # Java 8–21 core features
│   ├── jvm/                # Memory / GC / class loading / tuning
│   ├── messaging/          # Kafka / RocketMQ / RabbitMQ
│   ├── microservices/      # Service registry / API gateway / tracing / patterns
│   ├── netty/              # IO model / Reactor / WebSocket / SSE
│   ├── patterns/           # 23 GoF design patterns
│   ├── protocols/          # TCP/IP / HTTP / gRPC / IoT protocols
│   ├── scenario/           # Big data business scenarios
│   ├── spring/             # Spring Framework / AOP / WebFlux / Security
│   ├── spring-boot/        # Auto-config / Actuator / Flyway
│   └── testing/            # JUnit 5 / Mockito / TestContainers / TDD
├── .env                    # Local config (NAVBAR_STYLE=flat|dropdown)
├── .github/
│   └── workflows/
│       └── deploy-docs.yml # GitHub Pages auto-deploy
├── CLAUDE.md               # AI assistant context & project conventions
└── package.json
```

---

## Getting Started

**Requirements:** Node.js >= 18.20.5

```bash
# Install dependencies
npm install --legacy-peer-deps

# Start dev server
npm run docs:dev
```

Visit [http://localhost:1000/java-doc/](http://localhost:1000/java-doc/)

---

## Navbar Style Toggle

Switch between flat and dropdown navigation by editing `.env`:

```bash
# .env
NAVBAR_STYLE=dropdown   # grouped dropdown (default)
NAVBAR_STYLE=flat       # all modules expanded flat
```

The CI/CD build always reads from `.env`, no extra config needed.

---

## Build & Deploy

```bash
# Production build
npm run docs:build

# Output: docs/.vuepress/dist/
```

Deployment is automated via GitHub Actions on every push to `main` → deploys to `gh-pages` branch.

---

> "Practice is the sole criterion for testing truth."
