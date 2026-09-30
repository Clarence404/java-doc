// 首页（知识星图）的唯一数据源。
// 维护方式：
//   - 新增 / 删除模块：在对应分组的 modules 里加减一项（dir 为 docs/ 下的目录名），星图位置会自动排布
//   - 文章数、题数、答案页数、SVG 数由 plugins/homeStats.js 在构建时统计，这里不写数字
//   - 新增答案页：在 INTERVIEW 对应分组加一项
//   - 推荐路线：改 GOALS，stops 填模块名（须是 GROUPS 中存在的模块）
//   - 新增第 10 个分组时，需在 atlas.scss 中补充 --s10 / --c10 / --t10 配色（目前按品牌渐变取了 9 个色点）

export const GROUPS = [
    {
        name: '基础体系', tagline: '语言、运行时、算法与网络，后端的地基', modules: [
            {name: 'Java', dir: 'java', desc: '语言机制 / 集合 / IO / 并发（JMM、锁、线程池、CompletableFuture）/ 版本特性'},
            {name: 'JVM', dir: 'jvm', desc: '内存结构 / 类加载 / GC 原理与收集器 / JIT / 诊断与故障排查'},
            {name: '算法', dir: 'algorithms', desc: '复杂度 / 数据结构 / 基础算法 / 算法技巧 / 刷题实战'},
            {name: '网络协议', dir: 'protocols', desc: 'TCP/IP / HTTP/2 / gRPC / WebSocket / IoT 协议 / TLS'},
        ],
    },
    {
        name: '框架生态', tagline: 'Spring 全家桶与高性能网络编程', modules: [
            {name: 'Spring', dir: 'spring', desc: 'IoC / AOP / Bean 生命周期 / 事务 / MVC / Security'},
            {name: 'Spring Boot', dir: 'spring-boot', desc: '自动配置 / Web 开发 / 数据访问 / Actuator / 自定义 Starter'},
            {name: 'Netty', dir: 'netty', desc: 'IO 模型 / Reactor / ByteBuf / 私有协议 / 心跳 / WebSocket / SSE / 生产调优'},
        ],
    },
    {
        name: '数据存储', tagline: '关系型、缓存与消息中间件', modules: [
            {name: '数据库', dir: 'database', desc: 'MySQL / PostgreSQL / 分布式数据库 / NoSQL / CDC / 分库分表'},
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
            {name: '设计模式', dir: 'patterns', desc: 'GoF 23 种模式，结合 JDK / Spring 源码'},
            {name: '系统架构', dir: 'architecture', desc: '架构模式 / DDD / 幂等 / 对象存储 / 权限系统'},
            {name: '业务场景', dir: 'scenario', desc: '秒杀 / 订单 / 短链 / 排行榜 / Feed 流 / 搜索 / 红包 / LBS'},
        ],
    },
    {
        name: '研发效能', tagline: '测试、DevOps 与工程效率', modules: [
            {name: '测试体系', dir: 'testing', desc: '测试分层 / 单元与集成测试 / 性能测试（部分篇章仍在编写）', stub: '编写中'},
            {name: 'DevOps', dir: 'devops', desc: 'Git 工作流 / CI/CD / Code Review / 发布策略'},
            {name: '工程效率', dir: 'engineering', desc: '构建工具 / 开发工具 / 代码质量 / Arthas 诊断 / API 规范'},
        ],
    },
    {
        name: '运维保障', tagline: '云原生、可观测性与安全', modules: [
            {name: '云原生', dir: 'cloud-native', desc: 'Linux / Docker / Kubernetes / Helm / Terraform / 云平台'},
            {name: '可观测性', dir: 'observability', desc: '日志 / 指标 / 链路追踪 / 告警 / OpenTelemetry（大纲阶段）', stub: '大纲阶段'},
            {name: '安全', dir: 'security', desc: 'JWT / OAuth2 / OIDC / SSO / RBAC / API 安全 / 零信任'},
        ],
    },
    {
        name: '垂直领域', tagline: 'IoT 与 AI，拓展技术边界', modules: [
            {name: 'IoT', dir: 'iot', desc: '物联网架构 / MQTT / 平台选型 / 边缘计算 / Java 实战'},
            {name: 'AI', dir: 'ai', desc: 'Spring AI / LangChain4j / RAG / Agent / MCP / 本地模型'},
        ],
    },
];

// 开发总结答案页，g 为 GROUPS 下标
export const INTERVIEW = [
    {g: 0, pages: [
        ['Java', '/interview/1_java', '语言基础、集合、String、类加载、Lambda 等'],
        ['Java 并发', '/interview/2_concurrent', '线程池、synchronized vs ReentrantLock、volatile、CAS、ConcurrentHashMap、死锁'],
        ['JVM', '/interview/3_jvm', '内存结构、类加载、GC 原理与收集器、JIT、调优与排查'],
        ['网络协议', '/interview/4_network', 'TCP / UDP、HTTP、HTTPS / TLS'],
    ]},
    {g: 1, pages: [
        ['Spring', '/interview/5_spring', 'IoC、Bean 生命周期、循环依赖、AOP、事务、MVC、自动配置'],
        ['Netty', '/interview/6_netty', 'IO 模型、Reactor、ByteBuf、粘包拆包、心跳、生产调优'],
    ]},
    {g: 2, pages: [
        ['数据库', '/interview/7_db', 'MySQL 索引、事务与锁、MVCC、分库分表'],
        ['缓存', '/interview/8_cache', 'Redis 数据结构、持久化、集群、缓存三大问题、一致性'],
        ['消息队列', '/interview/9_mq', 'Kafka / RocketMQ / RabbitMQ、可靠性、顺序、幂等'],
    ]},
    {g: 3, pages: [
        ['分布式', '/interview/10_distributed', 'CAP / BASE、共识算法、分布式锁、分布式事务、分布式 ID'],
        ['Spring Cloud', '/interview/11_spring_cloud', '注册中心、网关、OpenFeign、配置中心、Sentinel、Seata'],
    ]},
    {g: 4, pages: [
        ['高性能', '/interview/12_high_perf', '指标与方法论、Profiler、JVM 层、池化、异步批量、数据访问'],
        ['高并发', '/interview/13_high_con', '接入层、水平扩展、缓存架构、削峰、数据层扩展、热点、容量评估'],
        ['高可用', '/interview/14_high_avail', 'SLA、冗余切换、超时重试、熔断降级限流、多活、应急复盘'],
    ]},
    {g: 5, pages: [
        ['系统架构', '/interview/15_architecture', '架构设计、DDD、幂等、权限系统'],
    ]},
];

// 跨模块关联（节选），第三项为弧线向圆心的弯曲程度
export const REL = [
    ['网络协议', 'Netty', .25], ['网络协议', 'IoT', .15], ['JVM', '高性能', .3], ['Java', '设计模式', 0],
    ['Spring Boot', 'Spring Cloud', .2], ['缓存', '高并发', 0], ['消息队列', '高并发', 0],
    ['分布式', '数据库', .1], ['Spring Cloud', '高可用', .1], ['可观测性', '高可用', .15], ['业务场景', '高并发', .15],
    ['云原生', 'DevOps', .1], ['AI', 'Spring Boot', .1], ['工程效率', 'JVM', .1],
];

// 按目标选路径（编辑推荐路线）；pre 表示先读开发总结
export const GOALS = [
    {name: '夯实基础', desc: '先把语言与运行时吃透，再补上算法与网络协议。', stops: ['Java', 'JVM', '数据结构与算法', '网络协议']},
    {name: '面试冲刺', desc: '先用答案页通读一遍，再回到题量最多的核心模块逐题复盘。', pre: true, stops: ['Java', 'JVM', '数据库', '缓存', '高并发']},
    {name: '系统设计', desc: '从分布式理论出发，经过三高策略，落到真实业务场景。', stops: ['分布式', '高并发', '高可用', '系统架构', '业务场景']},
    {name: '微服务落地', desc: '沿 Spring 全家桶走到服务治理，再部署到云原生环境。', stops: ['Spring', 'Spring Boot', 'Spring Cloud', '微服务', '云原生']},
    {name: '性能调优', desc: '先立指标与方法论，再逐层优化 JVM、数据库与缓存，最后借助线上诊断验证。', stops: ['高性能', 'JVM', '数据库', '缓存', '工程效率']},
];

export const REFS = [
    {title: 'Java 全栈知识体系', host: 'pdai.tech', url: 'https://www.pdai.tech', desc: '体系完整，适合系统梳理'},
    {title: '小傅哥 bugstack 虫洞栈', host: 'bugstack.cn', url: 'https://bugstack.cn', desc: '源码解析与实战案例见长'},
    {title: '互联网公司常用框架源码赏析', host: 'doocs.org', url: 'https://schunter.doocs.org', desc: '框架源码深度解读'},
];

export const FOOTER = 'MIT 协议 | 版权所有 © 2025-至今 Clarence';
