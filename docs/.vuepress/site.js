// 站点目录：模块、分组与命名的唯一数据源（纯数据，config.js 与首页组件共用）
//
// 由这里自动生成：
//   - 导航栏（分组下拉 / 平铺两种风格）
//   - 面包屑名称（模块目录与 subdirs 子目录）
//   - 侧边栏（默认按目录自动读取；sidebar 为按编号区间分组；结构特殊的模块在 config.js 的 CUSTOM_SIDEBARS 中手写）
//   - 首页知识星图与星表（name / desc / stub，分组的 name / tagline）
//
// 新增模块：在所属分组的 modules 中加一项，dir 为 docs/ 下的目录名，入口页为 <dir>/0_overview.md
// 模块字段：
//   name     正式名称（面包屑、首页、平铺导航）
//   nav      导航栏短名，可选，不写则用 name
//   dir      docs/ 下的目录名
//   desc     首页星表中的一行简介
//   stub     首页「编写中」徽标文字，可选
//   sidebar  按编号区间分组的侧边栏，可选：[{text, from, to, collapsed?}]
//   subdirs  子目录的中文名（面包屑），可选：{'1_mysql': 'MySQL'}

// 开发总结（导航栏第一项，不参与首页星图）
export const SUMMARY = {
    name: '开发总结',
    dir: 'interview',
    stripPrefix: '开发总结 - ',
    sidebar: [
        {text: '基础体系', from: 1, to: 4},
        {text: '框架生态', from: 5, to: 6},
        {text: '数据存储', from: 7, to: 9},
        {text: '分布式架构', from: 10, to: 11},
        {text: '三高架构', from: 12, to: 14},
        {text: '架构设计', from: 15, to: 15},
    ],
};

export const GROUPS = [
    {
        name: '基础体系', tagline: '语言、运行时、算法与网络，后端的地基', modules: [
            {
                name: 'Java', dir: 'java',
                desc: '语言机制 / 集合 / IO / 并发（JMM、锁、线程池、CompletableFuture）/ 版本特性',
                sidebar: [
                    {text: '综合', from: 1, to: 9},
                    {text: '语言机制', from: 10, to: 16},
                    {text: 'IO 与数据', from: 17, to: 21},
                    {text: '并发', from: 22, to: 29},
                ],
            },
            {
                name: 'JVM', dir: 'jvm',
                desc: '内存结构 / 类加载 / GC 原理与收集器 / JIT / 诊断与故障排查',
                sidebar: [
                    {text: '运行时', from: 1, to: 3},
                    {text: '垃圾回收', from: 4, to: 6},
                    {text: '编译与诊断', from: 7, to: 9},
                ],
            },
            {
                name: '数据结构与算法', nav: '算法', dir: 'algorithms',
                desc: '复杂度 / 数据结构 / 基础算法 / 算法技巧 / 刷题实战',
                subdirs: {'1_data_structures': '数据结构', '2_algorithms': '基础算法', '3_patterns': '算法技巧', '4_practice': '刷题实战'},
            },
            {name: '网络协议', dir: 'protocols', desc: 'TCP/IP / HTTP/2 / gRPC / WebSocket / IoT 协议 / TLS'},
        ],
    },
    {
        name: '框架生态', tagline: 'Spring 全家桶与高性能网络编程', modules: [
            {
                name: 'Spring', dir: 'spring',
                desc: 'IoC / AOP / Bean 生命周期 / 事务 / MVC / Security',
                sidebar: [
                    {text: '核心容器', from: 1, to: 4},
                    {text: '常用组件', from: 5, to: 8},
                    {text: '安全', from: 9, to: 11},
                    {text: '批处理与集成', from: 12, to: 13},
                ],
            },
            {name: 'Spring Boot', dir: 'spring-boot', desc: '自动配置 / Web 开发 / 数据访问 / Actuator / 自定义 Starter'},
            {name: 'Netty', dir: 'netty', desc: 'IO 模型 / Reactor / ByteBuf / 私有协议 / 心跳 / WebSocket / SSE / 生产调优'},
        ],
    },
    {
        name: '数据存储', tagline: '关系型、缓存与消息中间件', modules: [
            {
                name: '数据库', dir: 'database',
                desc: 'MySQL / PostgreSQL / 分布式数据库 / NoSQL / CDC / 分库分表',
                subdirs: {'1_mysql': 'MySQL', '2_postgresql': 'PostgreSQL', '3_relational': '关系库', '4_nosql': 'NoSQL', '5_practice': '架构运维', '6_reference': '参考延伸'},
            },
            {name: '缓存', dir: 'cache', desc: 'Redis / Redisson / Caffeine / 两级缓存 / 缓存一致性'},
            {name: '消息队列', dir: 'messaging', desc: 'Kafka / RocketMQ / RabbitMQ 原理与选型'},
        ],
    },
    {
        name: '分布式架构', tagline: '分布式理论到微服务落地', modules: [
            {name: '分布式', dir: 'distributed', desc: 'CAP / Raft / 分布式锁 / 分布式事务 / 分布式 ID'},
            {name: '微服务', dir: 'microservices', desc: '服务拆分 / 设计模式 / 服务网格 / Dubbo'},
            {name: 'Spring Cloud', dir: 'spring-cloud', desc: 'Nacos / Gateway / OpenFeign / Sentinel / Seata'},
        ],
    },
    {
        name: '三高架构', tagline: '高性能 · 高并发 · 高可用，系统级设计策略', modules: [
            {name: '高性能', dir: 'high-perf', desc: '指标 / 方法论 / Profiler / JMH / 池化与异步 / IO 与数据库优化'},
            {name: '高并发', dir: 'high-con', desc: '接入层 / 水平扩展 / 缓存架构 / 削峰 / 数据层扩展 / 热点 / 容量规划'},
            {name: '高可用', dir: 'high-avail', desc: 'SLA / 冗余切换 / 超时重试 / 熔断降级限流 / 多活容灾 / 应急复盘'},
        ],
    },
    {
        name: '架构设计', tagline: '从代码设计到架构落地', modules: [
            {
                name: '设计模式', dir: 'patterns',
                desc: 'GoF 23 种模式，结合 JDK / Spring 源码',
                sidebar: [
                    {text: '创建型', from: 1, to: 5},
                    {text: '结构型', from: 6, to: 12},
                    {text: '行为型', from: 13, to: 23},
                ],
            },
            {name: '系统架构', dir: 'architecture', desc: '架构模式 / DDD / 幂等 / 对象存储 / 权限系统'},
            {
                name: '业务场景', dir: 'scenario',
                desc: '秒杀 / 订单 / 短链 / 排行榜 / Feed 流 / 搜索 / 红包 / LBS',
                sidebar: [
                    {text: '通用问题', from: 1, to: 3},
                    {text: '系统设计案例', from: 4, to: 13},
                ],
            },
        ],
    },
    {
        name: '研发效能', tagline: '测试工程、DevOps 与工程效率', modules: [
            {name: '测试工程', dir: 'testing', desc: '测试分层 / 单元与集成测试 / 性能测试（部分篇章仍在编写）', stub: '编写中'},
            {name: 'DevOps', dir: 'devops', desc: 'Git 工作流 / CI/CD / Code Review / 发布策略'},
            {name: '工程效率', dir: 'engineering', desc: '构建工具 / 开发工具 / 代码质量 / Arthas 诊断 / API 规范'},
        ],
    },
    {
        name: '运维保障', tagline: '云原生、可观测性与安全', modules: [
            {
                name: '云原生', dir: 'cloud-native',
                desc: 'Linux / Docker / Kubernetes / Helm / Terraform / 云平台',
                sidebar: [
                    {text: 'Linux 基础', from: 1, to: 2},
                    {text: '虚拟化', from: 3, to: 4, collapsed: true},
                    {text: '容器与编排', from: 5, to: 10, collapsed: true},
                    {text: '基础设施自动化', from: 11, to: 12, collapsed: true},
                    {text: '云平台与选购', from: 13, to: 17, collapsed: true},
                ],
            },
            {name: '可观测性', dir: 'observability', desc: '日志 / 指标 / 链路追踪 / 告警 / OpenTelemetry（大纲阶段）', stub: '大纲阶段'},
            {name: '安全', dir: 'security', desc: 'JWT / OAuth2 / OIDC / SSO / RBAC / API 安全 / 零信任'},
        ],
    },
    {
        name: '垂直领域', tagline: 'IoT 与 AI，拓展技术边界', modules: [
            {name: 'IoT', dir: 'iot', desc: '物联网架构 / MQTT / 平台选型 / 边缘计算 / Java 实战'},
            {
                name: 'AI', dir: 'ai',
                desc: 'Spring AI / LangChain4j / RAG / Agent / MCP / 本地模型',
                subdirs: {'1_concepts': '基础概念', '2_frameworks': 'Java 框架', '3_integration': '模型接入', '4_core_tech': '核心技术', '5_advanced': '高阶应用', '6_tools': 'AI 工具生态'},
            },
        ],
    },
];

export const overviewLink = (dir) => `/${dir}/0_overview`;
