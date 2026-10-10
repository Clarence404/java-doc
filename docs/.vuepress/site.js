// 站点目录：模块、分组与命名的唯一数据源（纯数据，config.js 与首页组件共用）
//
// 由这里自动生成：
//   - 导航栏（分组下拉 / 平铺两种风格）
//   - 面包屑名称（模块目录与 subdirs 子目录）
//   - 侧边栏（按目录自动读取；sidebar 按起始编号分组；subdirs 让子目录成为分组）
//   - 首页（模块的 name / desc / stub，分组的 name / tagline），以及首页的推荐博客、页脚
//   - 面试题解：答案页的分组（SUMMARY.sidebar）与「对应题目清单」（模块的 interview 字段）
//
// 新增模块：在所属分组的 modules 中加一项，dir 为 docs/ 下的目录名，入口页为 <dir>/0_overview.md
// 模块字段：
//   name     正式名称（面包屑、首页、平铺导航）
//   nav      导航栏短名，可选，不写则用 name
//   dir      docs/ 下的目录名
//   desc     首页星表中的一行简介
//   stub     首页「编写中」徽标文字，可选
//   sidebar  按起始编号分组的侧边栏，可选：[{text, from}]，编号 ≥ from 的文章归入该组（0_overview 与 90 号以后的附录、99_interview 不分组）
//   interview 本模块 99_interview 题单的答案页（docs/interview/ 下的文件名），用于面试题解导航表的「对应题目清单」列；
//            题单页本身写 <InterviewList page="9_mq" />，由答案页自动生成（一页对应多个模块时加 groups="1-10"）
//   subdirs  子目录分组，可选：{'1_mysql': 'MySQL'} 或 {'1_mysql': {title, sidebar?}}；title 同时用于面包屑

// 面试题解（导航栏第一项，不参与首页的分组卡片）
export const SUMMARY = {
    name: '面试题解',
    dir: 'interview',
    stripSuffix: '面试题解答',
    sidebar: [
        {text: '基础体系', from: 1},
        {text: '框架生态', from: 5},
        {text: '数据存储', from: 7},
        {text: '分布式架构', from: 10},
        {text: '三高架构', from: 12},
        {text: '架构设计', from: 15},
        {text: '研发运维', from: 20},
        {text: '垂直领域', from: 24},
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
                name: '数据结构与算法', nav: '算法', dir: 'algorithms', interview: ['4_algorithms'],
                desc: '复杂度 / 数据结构 / 基础算法 / 算法技巧 / 刷题实战',
                subdirs: {'1_data_structures': '数据结构', '2_algorithms': '基础算法', '3_patterns': '算法技巧', '4_practice': '刷题实战'},
            },
            {name: '网络协议', dir: 'protocols', interview: ['4_network'], desc: 'TCP/UDP / HTTP / HTTPS 与 TLS / DNS / RPC / 数据库、邮件、文件协议'},
        ],
    },
    {
        name: '框架生态', tagline: 'Spring 全家桶、网络与响应式框架、实时计算', modules: [
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
            {name: 'Spring Boot', dir: 'spring-boot', interview: ['5_spring_boot'], desc: '自动配置 / Web / 数据访问 / 日志 / 测试 / Actuator / 版本演进 / 启动优化'},
            {name: 'Netty', dir: 'netty', interview: ['6_netty'], desc: 'IO 模型 / Reactor / ByteBuf / 私有协议 / 心跳 / WebSocket / SSE / 生产调优'},
            {name: 'Vert.x', dir: 'vertx', desc: 'Event Loop / Verticle / Event Bus / Web / 响应式数据访问 / 集群'},
            {name: 'Quarkus', dir: 'quarkus', desc: '构建期增强 / REST 与 Panache / 原生镜像 / 响应式 / Spring 迁移 / 其他框架'},
            {name: 'Flink', dir: 'flink', interview: ['6_flink'], desc: 'DataStream / 时间与窗口 / 状态与容错 / Flink SQL / CDC / 部署调优'},
        ],
    },
    {
        name: '数据存储', tagline: '关系型、缓存与消息中间件', modules: [
            {
                name: '数据库', dir: 'database', interview: ['7_db'],
                desc: 'MySQL / PostgreSQL / 分布式数据库 / NoSQL / CDC / 分库分表',
                subdirs: {
                    '1_mysql': {title: 'MySQL', sidebar: [{text: '核心专项', from: 4}]},
                    '2_postgresql': {title: 'PostgreSQL', sidebar: [{text: '核心专项', from: 2}]},
                    '3_relational': '关系库',
                    '4_nosql': 'NoSQL',
                    '5_practice': '架构运维',
                    '6_reference': '参考延伸',
                },
            },
            {name: '缓存', dir: 'cache', interview: ['8_cache'], desc: 'Redis / Redisson / Caffeine / 两级缓存 / 缓存一致性'},
            {name: '消息队列', dir: 'messaging', interview: ['9_mq'], desc: 'Kafka / RocketMQ / RabbitMQ 原理与选型'},
        ],
    },
    {
        name: '分布式架构', tagline: '分布式理论到微服务落地', modules: [
            {name: '分布式', dir: 'distributed', interview: ['10_distributed'], desc: 'CAP / Raft / 分布式锁 / 分布式事务 / 分布式 ID'},
            {name: '微服务', dir: 'microservices', interview: ['11_microservices'], desc: '服务拆分 / 设计模式 / 服务网格 / Dubbo'},
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
                name: '设计模式', dir: 'patterns', interview: ['17_patterns'],
                desc: 'GoF 23 种模式，结合 JDK / Spring 源码',
                sidebar: [
                    {text: '创建型', from: 1},
                    {text: '结构型', from: 6},
                    {text: '行为型', from: 13},
                ],
            },
            {name: '系统架构', dir: 'architecture', interview: ['15_architecture'], desc: '架构模式 / DDD / 幂等 / 对象存储 / 权限系统'},
            {
                name: '业务场景', dir: 'scenario', interview: ['16_scenario'],
                desc: '海量数据 / 秒杀 / 订单 / 短链 / 排行榜 / Feed 流 / 搜索 / 红包 / LBS / 商品详情 / 支付 / 优惠券 / IM / 计数 / 扫码登录 / 购物车',
                sidebar: [
                    {text: '海量数据', from: 1},
                    {text: '系统设计', from: 4},
                ],
            },
        ],
    },
    {
        name: '研发效能', tagline: '测试工程、DevOps 与工程效率', modules: [
            {name: '测试工程', dir: 'testing', interview: ['20_testing'], desc: '测试分层 / JUnit 6 / Mockito / 集成测试 / TDD / Testcontainers / 契约测试 / 性能测试'},
            {name: 'DevOps', dir: 'devops', desc: 'Git 工作流 / CI/CD / Code Review / 开发规范 / 发布策略 / 制品与环境'},
            {name: '工程效率', dir: 'engineering', desc: '构建工具 / 开发工具 / 代码质量 / Arthas 诊断 / 依赖治理 / API 文档与规范'},
        ],
    },
    {
        name: '运维保障', tagline: '云原生、可观测性与安全', modules: [
            {
                name: '云原生', dir: 'cloud-native', interview: ['21_cloud_native'],
                desc: 'Linux / Docker / Kubernetes / Helm / Terraform / 云平台',
                sidebar: [
                    {text: '操作系统', from: 1},
                    {text: '虚拟化', from: 3},
                    {text: '容器编排', from: 5},
                    {text: 'IaC 基建', from: 11},
                    {text: '云平台', from: 13},
                ],
            },
            {name: '可观测性', dir: 'observability', interview: ['22_observability'], desc: '日志 / 指标与 PromQL / 链路追踪 / 告警 / OpenTelemetry'},
            {name: '应用安全', dir: 'security', interview: ['23_security'], desc: 'JWT / OAuth2 / OIDC / SSO / RBAC / API 安全 / 零信任'},
        ],
    },
    {
        name: '垂直领域', tagline: 'IoT 与 AI，拓展技术边界', modules: [
            {name: 'IoT', dir: 'iot', interview: ['24_iot'], desc: '物联网架构 / MQTT / 平台选型 / 边缘计算 / 设备接入 / OTA'},
            {
                name: 'AI', dir: 'ai', interview: ['25_ai'],
                desc: 'Spring AI / LangChain4j / RAG / Agent / MCP / 本地模型',
                subdirs: {'1_concepts': '基础概念', '2_frameworks': 'Java 框架', '3_integration': '模型接入', '4_core_tech': '核心技术', '5_advanced': '高阶应用', '6_tools': 'AI 工具生态'},
            },
        ],
    },
];

// ---------- 首页 ----------

// 首页「延伸阅读」
export const REFS = [
    {title: 'Java 全栈知识体系', host: 'pdai.tech', url: 'https://www.pdai.tech', desc: '体系完整，适合系统梳理'},
    {title: '小傅哥 bugstack 虫洞栈', host: 'bugstack.cn', url: 'https://bugstack.cn', desc: '源码解析与实战案例见长'},
    {title: '互联网公司常用框架源码赏析', host: 'doocs.org', url: 'https://schunter.doocs.org', desc: '框架源码深度解读'},
];

// 首页页脚
export const FOOTER = 'MIT 协议 | 版权所有 © 2025-至今 Clarence';

export const overviewLink = (dir) => `/${dir}/0_overview`;
