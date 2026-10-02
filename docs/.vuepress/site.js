// 站点目录：模块、分组与命名的唯一数据源（纯数据，config.js 与首页组件共用）
//
// 由这里自动生成：
//   - 导航栏（分组下拉 / 平铺两种风格）
//   - 面包屑名称（模块目录与 subdirs 子目录）
//   - 侧边栏（按目录自动读取；sidebar 按起始编号分组；subdirs 让子目录成为分组）
//   - 首页知识星图与星表（name / desc / stub，分组的 name / tagline），以及首页的推荐路线、跨模块关联、推荐博客
//   - 开发总结：答案页的分组（SUMMARY.sidebar）与「对应题目清单」（模块的 interview 字段）
//
// 新增模块：在所属分组的 modules 中加一项，dir 为 docs/ 下的目录名，入口页为 <dir>/0_overview.md
// 模块字段：
//   name     正式名称（面包屑、首页、平铺导航）
//   nav      导航栏短名，可选，不写则用 name
//   dir      docs/ 下的目录名
//   desc     首页星表中的一行简介
//   stub     首页「编写中」徽标文字，可选
//   sidebar  按起始编号分组的侧边栏，可选：[{text, from, collapsed?}]，编号 ≥ from 的文章归入该组（0_overview 与 90 号以后的附录、99_interview 不分组）
//   interview 本模块 99_interview 题单的答案页（docs/interview/ 下的文件名），用于开发总结导航表的「对应题目清单」列
//   subdirs  子目录分组，可选：{'1_mysql': 'MySQL'} 或 {'1_mysql': {title, collapsed?, sidebar?}}；title 同时用于面包屑

// 开发总结（导航栏第一项，不参与首页星图）
export const SUMMARY = {
    name: '开发总结',
    dir: 'interview',
    stripPrefix: '开发总结 - ',
    sidebar: [
        {text: '基础体系', from: 1},
        {text: '框架生态', from: 5},
        {text: '数据存储', from: 7},
        {text: '分布式架构', from: 10},
        {text: '三高架构', from: 12},
        {text: '架构设计', from: 15},
    ],
};

export const GROUPS = [
    {
        name: '基础体系', tagline: '语言、运行时、算法与网络，后端的地基', modules: [
            {
                name: 'Java', dir: 'java', interview: ['1_java', '2_concurrent'],
                desc: '语言机制 / 集合 / IO / 并发（JMM、锁、线程池、CompletableFuture）/ 版本特性',
                sidebar: [
                    {text: '综合', from: 1},
                    {text: '语言机制', from: 10},
                    {text: 'IO 与数据', from: 17},
                    {text: '并发', from: 22},
                ],
            },
            {
                name: 'JVM', dir: 'jvm', interview: ['3_jvm'],
                desc: '内存结构 / 类加载 / GC 原理与收集器 / JIT / 诊断与故障排查',
                sidebar: [
                    {text: '运行时', from: 1},
                    {text: '垃圾回收', from: 4},
                    {text: '编译与诊断', from: 7},
                ],
            },
            {
                name: '数据结构与算法', nav: 'DSA', dir: 'algorithms',
                desc: '复杂度 / 数据结构 / 基础算法 / 算法技巧 / 刷题实战',
                subdirs: {'1_data_structures': '数据结构', '2_algorithms': '基础算法', '3_patterns': '算法技巧', '4_practice': {title: '刷题实战', collapsed: true}},
            },
            {name: '网络协议', dir: 'protocols', interview: ['4_network'], desc: 'TCP/IP / HTTP/2 / gRPC / WebSocket / IoT 协议 / TLS'},
        ],
    },
    {
        name: '框架生态', tagline: 'Spring 全家桶与高性能网络编程', modules: [
            {
                name: 'Spring', dir: 'spring', interview: ['5_spring'],
                desc: 'IoC / AOP / Bean 生命周期 / 事务 / MVC / Security',
                sidebar: [
                    {text: '核心容器', from: 1},
                    {text: '常用组件', from: 5},
                    {text: '安全', from: 9},
                    {text: '批处理与集成', from: 12},
                ],
            },
            {name: 'Spring Boot', dir: 'spring-boot', desc: '自动配置 / Web 开发 / 数据访问 / Actuator / 自定义 Starter'},
            {name: 'Netty', dir: 'netty', interview: ['6_netty'], desc: 'IO 模型 / Reactor / ByteBuf / 私有协议 / 心跳 / WebSocket / SSE / 生产调优'},
        ],
    },
    {
        name: '数据存储', tagline: '关系型、缓存与消息中间件', modules: [
            {
                name: '数据库', dir: 'database', interview: ['7_db'],
                desc: 'MySQL / PostgreSQL / 分布式数据库 / NoSQL / CDC / 分库分表',
                subdirs: {
                    '1_mysql': {title: 'MySQL', sidebar: [{text: '核心专项', from: 4}]},
                    '2_postgresql': {title: 'PostgreSQL', collapsed: true, sidebar: [{text: '核心专项', from: 2}]},
                    '3_relational': {title: '关系库', collapsed: true},
                    '4_nosql': {title: 'NoSQL', collapsed: true},
                    '5_practice': {title: '架构运维', collapsed: true},
                    '6_reference': {title: '参考延伸', collapsed: true},
                },
            },
            {name: '缓存', dir: 'cache', interview: ['8_cache'], desc: 'Redis / Redisson / Caffeine / 两级缓存 / 缓存一致性'},
            {name: '消息队列', dir: 'messaging', interview: ['9_mq'], desc: 'Kafka / RocketMQ / RabbitMQ 原理与选型'},
        ],
    },
    {
        name: '分布式架构', tagline: '分布式理论到微服务落地', modules: [
            {name: '分布式', dir: 'distributed', interview: ['10_distributed'], desc: 'CAP / Raft / 分布式锁 / 分布式事务 / 分布式 ID'},
            {name: '微服务', dir: 'microservices', interview: ['11_spring_cloud'], desc: '服务拆分 / 设计模式 / 服务网格 / Dubbo'},
            {name: 'Spring Cloud', dir: 'spring-cloud', interview: ['11_spring_cloud'], desc: 'Nacos / Gateway / OpenFeign / Sentinel / Seata'},
        ],
    },
    {
        name: '三高架构', tagline: '高性能 · 高并发 · 高可用，系统级设计策略', modules: [
            {name: '高性能', dir: 'high-perf', interview: ['12_high_perf'], desc: '指标 / 方法论 / Profiler / JMH / 池化与异步 / IO 与数据库优化'},
            {name: '高并发', dir: 'high-con', interview: ['13_high_con'], desc: '接入层 / 水平扩展 / 缓存架构 / 削峰 / 数据层扩展 / 热点 / 容量规划'},
            {name: '高可用', dir: 'high-avail', interview: ['14_high_avail'], desc: 'SLA / 冗余切换 / 超时重试 / 熔断降级限流 / 多活容灾 / 应急复盘'},
        ],
    },
    {
        name: '架构设计', tagline: '从代码设计到架构落地', modules: [
            {
                name: '设计模式', dir: 'patterns',
                desc: 'GoF 23 种模式，结合 JDK / Spring 源码',
                sidebar: [
                    {text: '创建型', from: 1},
                    {text: '结构型', from: 6},
                    {text: '行为型', from: 13},
                ],
            },
            {name: '系统架构', dir: 'architecture', interview: ['15_architecture'], desc: '架构模式 / DDD / 幂等 / 对象存储 / 权限系统'},
            {
                name: '业务场景', dir: 'scenario',
                desc: '秒杀 / 订单 / 短链 / 排行榜 / Feed 流 / 搜索 / 红包 / LBS',
                sidebar: [
                    {text: '通用问题', from: 1},
                    {text: '系统设计案例', from: 4},
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
                    {text: 'Linux 基础', from: 1},
                    {text: '虚拟化', from: 3, collapsed: true},
                    {text: '容器与编排', from: 5, collapsed: true},
                    {text: '基础设施自动化', from: 11, collapsed: true},
                    {text: '云平台与选购', from: 13, collapsed: true},
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
                subdirs: {'1_concepts': '基础概念', '2_frameworks': 'Java 框架', '3_integration': '模型接入', '4_core_tech': '核心技术', '5_advanced': '高阶应用', '6_tools': {title: 'AI 工具生态', collapsed: true}},
            },
        ],
    },
];

// ---------- 首页 ----------

// 首页星图的跨模块关联（节选），第三项为弧线向圆心的弯曲程度
export const REL = [
    ['网络协议', 'Netty', .25], ['网络协议', 'IoT', .15], ['JVM', '高性能', .3], ['Java', '设计模式', 0],
    ['Spring Boot', 'Spring Cloud', .2], ['缓存', '高并发', 0], ['消息队列', '高并发', 0],
    ['分布式', '数据库', .1], ['Spring Cloud', '高可用', .1], ['可观测性', '高可用', .15], ['业务场景', '高并发', .15],
    ['云原生', 'DevOps', .1], ['AI', 'Spring Boot', .1], ['工程效率', 'JVM', .1],
];

// 首页「按目标选路径」（编辑推荐路线），stops 填上面已有的模块名；pre 表示先读开发总结
export const GOALS = [
    {name: '夯实基础', desc: '先把语言与运行时吃透，再补上算法与网络协议。', stops: ['Java', 'JVM', '数据结构与算法', '网络协议']},
    {name: '面试冲刺', desc: '先用答案页通读一遍，再回到题量最多的核心模块逐题复盘。', pre: true, stops: ['Java', 'JVM', '数据库', '缓存', '高并发']},
    {name: '系统设计', desc: '从分布式理论出发，经过三高策略，落到真实业务场景。', stops: ['分布式', '高并发', '高可用', '系统架构', '业务场景']},
    {name: '微服务落地', desc: '沿 Spring 全家桶走到服务治理，再部署到云原生环境。', stops: ['Spring', 'Spring Boot', 'Spring Cloud', '微服务', '云原生']},
    {name: '性能调优', desc: '先立指标与方法论，再逐层优化 JVM、数据库与缓存，最后借助线上诊断验证。', stops: ['高性能', 'JVM', '数据库', '缓存', '工程效率']},
];

// 首页「延伸阅读」
export const REFS = [
    {title: 'Java 全栈知识体系', host: 'pdai.tech', url: 'https://www.pdai.tech', desc: '体系完整，适合系统梳理'},
    {title: '小傅哥 bugstack 虫洞栈', host: 'bugstack.cn', url: 'https://bugstack.cn', desc: '源码解析与实战案例见长'},
    {title: '互联网公司常用框架源码赏析', host: 'doocs.org', url: 'https://schunter.doocs.org', desc: '框架源码深度解读'},
];

// 首页页脚
export const FOOTER = 'MIT 协议 | 版权所有 © 2025-至今 Clarence';

export const overviewLink = (dir) => `/${dir}/0_overview`;
