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
        {text: '分布式系统', from: 10},
        {text: '架构设计', from: 15},
        {text: '研发效能', from: 20},
        {text: '运维保障', from: 21},
        {text: '垂直领域', from: 24},
    ],
};

export const GROUPS = [
    {
        name: '基础体系', tagline: '语言、运行时、算法、操作系统与网络，后端的地基', modules: [
            {
                name: 'Java', dir: 'java', interview: ['1_java', '2_concurrent'],
                desc: '语言机制 / 集合 / IO / 并发（JMM、锁、线程池、CompletableFuture）/ 版本特性',
                sidebar: [
                    {text: '综合', from: 1},
                    {text: '语言机制', from: 10},
                    {text: '核心类库', from: 17},
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
            {name: '操作系统', dir: 'os', interview: ['4_computer_os'], desc: '进程线程与协程 / 用户态与系统调用 / 内存与 Page Cache / CPU 缓存与伪共享 / Load / 进程间通信 / 文件与磁盘 IO'},
            {name: '网络协议', dir: 'protocols', interview: ['4_network'], desc: 'TCP/UDP / HTTP / HTTPS 与 TLS / DNS / RPC / 数据库、邮件、文件协议'},
        ],
    },
    {
        name: '框架生态', tagline: 'Spring 全家桶、网络与响应式框架', modules: [
            {
                name: 'Spring', dir: 'spring', interview: ['5_spring'],
                desc: 'IoC / AOP / Bean 生命周期 / 事务 / MVC / Security',
                sidebar: [
                    {text: '核心特性', from: 1},
                    {text: '常用组件', from: 5},
                    {text: '响应式 Web', from: 8},
                    {text: '安全', from: 9},
                    {text: '批处理与集成', from: 12},
                ],
            },
            {
                name: 'Spring Boot', dir: 'spring-boot', interview: ['5_spring_boot'],
                desc: '自动配置 / Web / 数据访问 / 日志 / 测试 / Actuator / 版本演进 / 启动优化',
                sidebar: [
                    {text: '开发基础', from: 1},
                    {text: '功能集成', from: 6},
                    {text: '测试与运维', from: 10},
                    {text: '扩展与演进', from: 12},
                ],
            },
            {name: 'Netty', dir: 'netty', interview: ['6_netty'], desc: 'IO 模型 / Reactor / ByteBuf / 私有协议 / 心跳 / WebSocket / SSE / 生产调优'},
            {name: 'Vert.x', dir: 'vertx', interview: ['6_vertx'], desc: 'Event Loop / Verticle / Event Bus / Web / 响应式数据访问 / 集群'},
            {name: 'Quarkus', dir: 'quarkus', interview: ['6_quarkus'], desc: '构建期增强 / REST 与 Panache / 原生镜像 / 响应式 / Spring 迁移 / 其他框架'},
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
        name: '分布式系统', tagline: '分布式理论、微服务与高性能 · 高并发 · 高可用', modules: [
            {name: '分布式', dir: 'distributed', interview: ['10_distributed'], desc: 'CAP / Raft / 分布式锁 / 分布式事务 / 分布式 ID'},
            {name: '微服务', dir: 'microservices', interview: ['11_microservices'], desc: '服务拆分 / 设计模式 / 服务网格 / Dubbo / 调用顺序'},
            {name: 'Spring Cloud', dir: 'spring-cloud', interview: ['11_spring_cloud'], desc: 'Nacos / Gateway / OpenFeign / Sentinel / Seata'},
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
                name: '业务场景', dir: 'scenario', interview: ['16_scenario', '16_scenario_highlights'],
                desc: '设计方法 / 海量数据 / 秒杀 / 订单 / 短链 / 排行榜 / Feed 流 / 搜索 / 红包 / LBS / 商品详情 / 支付 / 优惠券 / IM / 计数 / 扫码登录 / 购物车 / 通知中心 / 评论 / 库存票务 / 延迟任务',
                sidebar: [
                    {text: '方法论', from: 1},
                    {text: '海量数据', from: 2},
                    {text: '系统设计', from: 4},
                ],
            },
        ],
    },
    {
        name: '研发效能', tagline: '测试工程、DevOps、工程效率与实战手册', modules: [
            {name: '测试工程', dir: 'testing', interview: ['20_testing'], desc: '测试分层 / JUnit 6 / Mockito / 集成测试 / TDD / Testcontainers / 契约测试 / 性能测试 / 接口与 E2E'},
            {name: 'DevOps', dir: 'devops', interview: ['20_devops'], desc: 'Git 工作流 / CI/CD / Code Review / 开发规范 / 发布策略 / 制品与环境'},
            {name: '工程效率', dir: 'engineering', interview: ['20_devops'], desc: '构建工具 / 开发工具 / 代码质量 / Arthas 诊断 / 依赖治理 / API 文档与规范'},
            {
                name: '实战手册', dir: 'handbook', interview: ['20_handbook'],
                desc: '常用命令速查 / 线上故障案例：现象、排查、根因、修复与预防',
                subdirs: {'1_cheatsheet': '速查表', '2_incidents': '故障案例'},
            },
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
            {name: '可观测性', dir: 'observability', interview: ['22_observability'], desc: '日志 / 指标与 PromQL / 链路追踪 / 告警 / OpenTelemetry / 持续剖析'},
            {name: '应用安全', dir: 'security', interview: ['23_security'], desc: 'JWT / OAuth2 / OIDC / SSO / RBAC / API 安全 / 零信任'},
        ],
    },
    {
        name: '垂直领域', tagline: 'IoT、AI、大数据与实时计算、音视频，拓展技术边界', modules: [
            {
                name: 'IoT', dir: 'iot', interview: ['24_iot'],
                desc: '物联网架构 / MQTT / 平台选型 / 边缘计算 / 设备接入 / OTA',
                sidebar: [
                    {text: '原理与选型', from: 1},
                    {text: '接入实战', from: 6},
                ],
            },
            {
                name: 'AI', dir: 'ai', interview: ['25_ai'],
                desc: 'Spring AI / LangChain4j / RAG / Agent / MCP / 本地模型 / 评估上线',
                subdirs: {'1_concepts': '基础概念', '2_frameworks': 'Java 框架', '3_integration': '模型接入', '4_core_tech': '核心技术', '5_advanced': '高阶应用', '6_tools': 'AI 编程工具'},
            },
            {name: '大数据', dir: 'big-data', interview: ['26_bigdata'], desc: '数仓建模 / Spark / 数据湖 / 数据集成 / 调度 / OLAP / 数据治理 / 实时数仓'},
            {name: 'Flink', dir: 'flink', interview: ['26_flink'], desc: 'DataStream / 时间与窗口 / 状态与容错 / Flink SQL / CDC / 部署调优'},
            {name: '音视频', dir: 'media', interview: ['27_media'], desc: '编码与封装 / 流媒体协议 / FFmpeg / 流媒体服务器 / WebRTC / 直播 / 点播 / 监控接入'},
        ],
    },
];

// ---------- 首页 ----------

// 首页「延伸阅读」
// 学习路线（interview/91_routes 页的 <LearningRoutes />）：按目标跨模块挑文章，标题与简介自动取文章的 H1 与 description
// 字段：name 路线名、for 适合谁、time 总用时；stages 为阶段：title、time（可选）、note（可选提示）、items（docs/ 下的文章路径，不带 .md）
export const ROUTES = [
    {
        name: '新人入职', for: '刚加入 Java 后端团队，先能按团队规范写代码、上线，再慢慢深入', time: '约两周',
        stages: [
            {title: '团队规范', time: '第 1–2 天', items: ['devops/1_git_workflow', 'devops/3_dev_standards', 'devops/2_code_review', 'handbook/1_cheatsheet/1_git', 'handbook/1_cheatsheet/7_build']},
            {title: '工程与框架', time: '第 3–5 天', items: ['architecture/2_package_structure', 'spring-boot/1_spring_boot', 'spring-boot/5_config', 'spring-boot/2_web_dev', 'engineering/4_api_design_rule', 'spring-boot/3_data_access', 'spring-boot/9_logging']},
            {title: '数据与缓存', time: '第 6–8 天', items: ['database/1_mysql/3_table_design', 'database/1_mysql/4_topic_index', 'database/1_mysql/5_topic_transaction', 'database/1_mysql/3_fallible_point', 'cache/5_redis_practice', 'cache/10_cache_consistency']},
            {title: '测试与上线', time: '第 9–10 天', items: ['testing/1_unit_test', 'spring-boot/10_testing', 'devops/4_ci_cd', 'devops/7_release_strategy', 'observability/1_logging', 'handbook/1_cheatsheet/0_linux']},
        ],
    },
    {
        name: '面试冲刺', for: '一周后有面试，以答案页为主，配合题单的自测模式', time: '7 天',
        stages: [
            {title: 'Java 与并发', time: 'Day 1', items: ['interview/1_java', 'interview/2_concurrent', 'java/28_topic_thread_pool']},
            {title: 'JVM、操作系统与网络', time: 'Day 2', items: ['interview/3_jvm', 'interview/4_computer_os', 'interview/4_network']},
            {title: 'Spring 全家桶', time: 'Day 3', items: ['interview/5_spring', 'interview/5_spring_boot', 'interview/11_spring_cloud']},
            {title: '数据库、缓存与 MQ', time: 'Day 4', items: ['interview/7_db', 'interview/8_cache', 'interview/9_mq']},
            {title: '分布式系统', time: 'Day 5', items: ['interview/10_distributed', 'interview/11_microservices', 'interview/13_high_con', 'interview/14_high_avail']},
            {title: '系统设计与项目', time: 'Day 6', items: ['scenario/1_design_method', 'interview/16_scenario', 'interview/16_scenario_highlights', 'interview/15_architecture']},
            {title: '查漏补缺', time: 'Day 7', note: '打开各模块的「高频面试题」，切到自测模式、范围选「只看不会」，把标过的题再过一遍', items: ['interview/4_algorithms', 'algorithms/4_practice/2_concurrency_coding', 'interview/90_glossary']},
        ],
    },
    {
        name: '从 CRUD 到架构', for: '做了几年业务开发，想往架构方向走，按系统长大的顺序读', time: '约 1–2 个月',
        stages: [
            {title: '把单体写扎实', items: ['database/1_mysql/3_table_design', 'database/1_mysql/7_topic_explain', 'architecture/3_idempotence', 'cache/10_cache_consistency', 'architecture/2_package_structure']},
            {title: '引入中间件', items: ['messaging/1_basics', 'high-con/4_async_peak_shaving', 'distributed/3_lock', 'distributed/4_transaction', 'distributed/8_id_generator']},
            {title: '拆分与治理', items: ['distributed/2_theorem', 'microservices/1_service_split', 'microservices/2_patterns', 'architecture/2_ddd', 'high-avail/4_timeout_retry_bulkhead', 'high-avail/5_circuit_breaking']},
            {title: '扛住流量', items: ['high-con/3_cache_architecture', 'high-con/5_data_scaling', 'high-con/6_hotspot', 'high-con/8_capacity_planning', 'high-avail/9_multi_active']},
            {title: '系统设计', items: ['scenario/1_design_method', 'scenario/4_seckill', 'scenario/5_order_system', 'scenario/17_counter']},
        ],
    },
    {
        name: '线上问题排查', for: '开始值班、需要处理线上故障，先有工具，再懂原理，最后看真实案例', time: '约 2 周',
        stages: [
            {title: '先把工具备好', items: ['handbook/1_cheatsheet/0_linux', 'handbook/1_cheatsheet/3_arthas', 'handbook/1_cheatsheet/4_jvm', 'engineering/7_diagnosis', 'jvm/8_monitoring_tools']},
            {title: '方法与原理', items: ['high-perf/2_methodology', 'os/5_load_cpu', 'jvm/9_troubleshooting', 'high-perf/3_profilers']},
            {title: '看得见系统', items: ['observability/1_logging', 'observability/2_metrics', 'observability/3_tracing', 'observability/6_profiling']},
            {title: '典型案例', items: ['handbook/2_incidents/3_cpu_high', 'handbook/2_incidents/0_heap_oom', 'handbook/2_incidents/2_full_gc', 'handbook/2_incidents/4_thread_pool_exhausted', 'handbook/2_incidents/6_slow_sql_pool', 'handbook/2_incidents/12_mq_backlog', 'handbook/2_incidents/18_load_high_cpu_low']},
            {title: '应急与复盘', items: ['high-avail/11_incident_response']},
        ],
    },
];

export const REFS = [
    {title: 'Java 全栈知识体系', host: 'pdai.tech', url: 'https://www.pdai.tech', desc: '体系完整，适合系统梳理'},
    {title: '小傅哥 bugstack 虫洞栈', host: 'bugstack.cn', url: 'https://bugstack.cn', desc: '源码解析与实战案例见长'},
    {title: '互联网公司常用框架源码赏析', host: 'doocs.org', url: 'https://schunter.doocs.org', desc: '框架源码深度解读'},
];

// 首页页脚
export const FOOTER = 'MIT 协议 | 版权所有 © 2025-至今 Clarence';

export const overviewLink = (dir) => `/${dir}/0_overview`;
