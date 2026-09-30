// 首页（知识星图）独有的内容。模块、分组、名称与简介统一在 ../../site.js 维护，这里直接复用。
// 维护方式：
//   - 新增 / 删除 / 改名模块：改 site.js（导航栏、侧边栏、面包屑与首页同步生效），星图位置会自动排布
//   - 文章数、题数、答案页数、SVG 数由 plugins/homeStats.js 在构建时统计，这里不写数字
//   - 新增答案页：在 INTERVIEW 对应分组加一项
//   - 推荐路线：改 GOALS，stops 填模块名（须是 site.js 中存在的模块）
//   - 新增第 10 个分组时，需在 atlas.scss 中补充 --s10 / --c10 / --t10 配色（目前按品牌渐变取了 9 个色点）

export {GROUPS} from '../../site.js';

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
