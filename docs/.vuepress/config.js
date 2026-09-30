import {defineUserConfig} from 'vuepress';
import {hopeTheme} from 'vuepress-theme-hope';
import {viteBundler} from '@vuepress/bundler-vite';
import fs from 'fs';
import path from 'path';
import 'dotenv/config';

// 导航栏风格：统一读 .env 里的 NAVBAR_STYLE
//   flat      → 所有模块平铺展开
//   dropdown  → 分组下拉菜单
// 本地：改 .env 文件即可；CI/CD：workflow env 里覆盖
const NAVBAR_STYLE = process.env.NAVBAR_STYLE ?? 'dropdown';

const navbarFlat = [
    {text: '开发总结', link: '/interview/0_overview'},
    {text: 'Java',    link: '/java/0_overview'},
    {text: 'JVM',     link: '/jvm/0_overview'},
    {text: '算法',    link: '/algorithms/0_overview'},
    {text: '网络协议', link: '/protocols/0_overview'},
    {text: 'Spring',  link: '/spring/0_overview'},
    {text: 'Spring Boot', link: '/spring-boot/0_overview'},
    {text: 'Netty',   link: '/netty/0_overview'},
    {text: '数据库',  link: '/database/0_overview'},
    {text: '缓存',    link: '/cache/0_overview'},
    {text: '消息队列', link: '/messaging/0_overview'},
    {text: '分布式',  link: '/distributed/0_overview'},
    {text: '微服务',  link: '/microservices/0_overview'},
    {text: 'Spring Cloud', link: '/spring-cloud/0_overview'},
    {text: '高性能',  link: '/high-perf/0_overview'},
    {text: '高并发',  link: '/high-con/0_overview'},
    {text: '高可用',  link: '/high-avail/0_overview'},
    {text: '设计模式', link: '/patterns/0_overview'},
    {text: '架构',    link: '/architecture/0_overview'},
    {text: '业务场景', link: '/scenario/0_overview'},
    {text: '测试',    link: '/testing/0_overview'},
    {text: 'DevOps',  link: '/devops/0_overview'},
    {text: '工程效率', link: '/engineering/0_overview'},
    {text: '云原生',  link: '/cloud-native/0_overview'},
    {text: '可观测性', link: '/observability/0_overview'},
    {text: '安全',    link: '/security/0_overview'},
    {text: 'IoT',     link: '/iot/0_overview'},
    {text: 'AI',      link: '/ai/0_overview'},
];

const navbarDropdown = [
    {text: '开发总结', link: '/interview/0_overview'},
    {
        text: '基础体系',
        children: [
            {text: 'Java',    link: '/java/0_overview'},
            {text: 'JVM',     link: '/jvm/0_overview'},
            {text: '算法',    link: '/algorithms/0_overview'},
            {text: '网络协议', link: '/protocols/0_overview'},
        ],
    },
    {
        text: '框架生态',
        children: [
            {text: 'Spring',          link: '/spring/0_overview'},
            {text: 'Spring Boot',     link: '/spring-boot/0_overview'},
            {text: 'Netty',           link: '/netty/0_overview'},
        ],
    },
    {
        text: '数据存储',
        children: [
            {text: '数据库',   link: '/database/0_overview'},
            {text: '缓存',     link: '/cache/0_overview'},
            {text: '消息队列', link: '/messaging/0_overview'},
        ],
    },
    {
        text: '分布式架构',
        children: [
            {text: '分布式',       link: '/distributed/0_overview'},
            {text: '微服务',       link: '/microservices/0_overview'},
            {text: 'Spring Cloud', link: '/spring-cloud/0_overview'},
        ],
    },
    {
        text: '三高架构',
        children: [
            {text: '高性能', link: '/high-perf/0_overview'},
            {text: '高并发', link: '/high-con/0_overview'},
            {text: '高可用', link: '/high-avail/0_overview'},
        ],
    },
    {
        text: '架构设计',
        children: [
            {text: '设计模式', link: '/patterns/0_overview'},
            {text: '系统架构', link: '/architecture/0_overview'},
            {text: '业务场景', link: '/scenario/0_overview'},
        ],
    },
    {
        text: '研发效能',
        children: [
            {text: '测试',    link: '/testing/0_overview'},
            {text: 'DevOps',  link: '/devops/0_overview'},
            {text: '工程效率', link: '/engineering/0_overview'},
        ],
    },
    {
        text: '运维保障',
        children: [
            {text: '云原生',   link: '/cloud-native/0_overview'},
            {text: '可观测性', link: '/observability/0_overview'},
            {text: '安全',    link: '/security/0_overview'},
        ],
    },
    {
        text: '垂直领域',
        children: [
            {text: 'IoT',     link: '/iot/0_overview'},
            {text: 'AI',      link: '/ai/0_overview'},
        ],
    },
];

// stripPrefix：侧边栏去掉标题中重复的模块前缀（页面 H1 保持完整）
function getSidebarFromDir(dirPath, {stripPrefix} = {}) {
    if (!fs.existsSync(dirPath)) {
        console.warn(`Warning: Directory ${dirPath} does not exist. Skipping sidebar generation.`);
        return [];
    }
    const files = fs.readdirSync(dirPath)
        .filter(file => file.endsWith('.md'))
        .sort((a, b) => {
            const na = parseInt(a.match(/^(\d+)/)?.[1] ?? '0');
            const nb = parseInt(b.match(/^(\d+)/)?.[1] ?? '0');
            return na - nb;
        });
    return files.map(file => {
        const filePath = path.join(dirPath, file);
        const content = fs.readFileSync(filePath, 'utf-8').replace(/^﻿/, '');
        const firstHeadingMatch = content.match(/^# (.+)/m);
        const firstHeading = firstHeadingMatch ? firstHeadingMatch[1] : file;
        const relativeLink = path.relative(path.resolve(__dirname, '../'), filePath)
            .replace(/\\/g, '/')
            .replace('.md', '');
        return {
            text: stripPrefix && firstHeading.startsWith(stripPrefix) ? firstHeading.slice(stripPrefix.length) : firstHeading,
            link: `/${relativeLink}`,
        };
    });
}

// 按文件编号区间分组：组内文件仍自动读取目录，新增文件只要编号落在区间内即自动归组
function getGroupedSidebar(dirPath, groups, options = {}) {
    const num = item => parseInt(item.link.split('/').pop().match(/^(\d+)/)?.[1] ?? '0');
    const result = [];
    const emitted = new Map();
    for (const item of getSidebarFromDir(dirPath, options)) {
        const n = num(item);
        const group = groups.find(g => n >= g.from && n <= g.to);
        if (!group) {
            result.push(item);
            continue;
        }
        if (!emitted.has(group)) {
            const node = {text: group.text, collapsible: true, expanded: !group.collapsed, children: []};
            emitted.set(group, node);
            result.push(node);
        }
        emitted.get(group).children.push(item);
    }
    return result;
}

const dirOf = name => path.resolve(__dirname, `../${name}`);

const javaSidebar = getGroupedSidebar(dirOf('java'), [
    {text: '综合', from: 1, to: 9},
    {text: '语言机制', from: 10, to: 16},
    {text: 'IO 与数据', from: 17, to: 21},
    {text: '并发', from: 22, to: 29},
]);

const interviewSidebar = getGroupedSidebar(dirOf('interview'), [
    {text: '基础体系', from: 1, to: 4},
    {text: '框架生态', from: 5, to: 6},
    {text: '数据存储', from: 7, to: 9},
    {text: '分布式架构', from: 10, to: 11},
    {text: '三高架构', from: 12, to: 14},
    {text: '架构设计', from: 15, to: 15},
], {stripPrefix: '开发总结 - '});

const jvmSidebar = getGroupedSidebar(dirOf('jvm'), [
    {text: '运行时', from: 1, to: 3},
    {text: '垃圾回收', from: 4, to: 6},
    {text: '编译与诊断', from: 7, to: 9},
]);

const springSidebar = getGroupedSidebar(dirOf('spring'), [
    {text: '核心容器', from: 1, to: 4},
    {text: '常用组件', from: 5, to: 8},
    {text: '安全', from: 9, to: 11},
    {text: '批处理与集成', from: 12, to: 13},
]);

const scenarioSidebar = getGroupedSidebar(dirOf('scenario'), [
    {text: '通用问题', from: 1, to: 3},
    {text: '系统设计案例', from: 4, to: 13},
]);

const patternsSidebar = getGroupedSidebar(dirOf('patterns'), [
    {text: '创建型', from: 1, to: 5},
    {text: '结构型', from: 6, to: 12},
    {text: '行为型', from: 13, to: 23},
]);

const cloudNativeSidebar = getGroupedSidebar(dirOf('cloud-native'), [
    {text: 'Linux 基础', from: 1, to: 2},
    {text: '虚拟化', from: 3, to: 4, collapsed: true},
    {text: '容器与编排', from: 5, to: 10, collapsed: true},
    {text: '基础设施自动化', from: 11, to: 12, collapsed: true},
    {text: '云平台与选购', from: 13, to: 17, collapsed: true},
]);

const aiSidebar = [
    {text: 'AI 开发总览', link: '/ai/0_overview'},
    {
        text: '基础概念',
        collapsible: true,
        expanded: true,
        children: [
            {text: '大语言模型', link: '/ai/1_concepts/0_model'},
            {text: 'Prompt 工程',   link: '/ai/1_concepts/1_prompt'},
            {text: 'Function Calling', link: '/ai/1_concepts/2_function_calling'},
        ],
    },
    {
        text: 'Java 框架',
        collapsible: true,
        expanded: true,
        children: [
            {text: 'Spring AI',    link: '/ai/2_frameworks/0_spring_ai'},
            {text: 'LangChain4j', link: '/ai/2_frameworks/1_langchain4j'},
        ],
    },
    {
        text: '模型接入',
        collapsible: true,
        expanded: true,
        children: [
            {text: 'Ollama（本地部署）', link: '/ai/3_integration/0_ollama'},
            {text: '主流 API 接入',      link: '/ai/3_integration/1_api_access'},
        ],
    },
    {
        text: '核心技术',
        collapsible: true,
        expanded: true,
        children: [
            {text: 'Embedding',  link: '/ai/4_core_tech/0_embedding'},
            {text: '向量数据库', link: '/ai/4_core_tech/1_vector_db'},
            {text: 'RAG 检索增强',        link: '/ai/4_core_tech/2_rag'},
        ],
    },
    {
        text: '高阶应用',
        collapsible: true,
        expanded: true,
        children: [
            {text: 'AI Agent', link: '/ai/5_advanced/0_agent'},
            {text: 'MCP 协议', link: '/ai/5_advanced/1_mcp'},
            {text: '模型微调', link: '/ai/5_advanced/2_fine_tuning'},
        ],
    },
    {
        text: 'AI 工具生态',
        collapsible: true,
        expanded: false,
        children: [
            {text: 'AI 工具总览', link: '/ai/6_tools/0_ai_tools'},
        ],
    },
];

const algorithmsSidebar = [
    {text: '数据结构与算法总览', link: '/algorithms/0_overview'},
    {text: '复杂度分析', link: '/algorithms/0_complexity'},
    {
        text: '数据结构',
        link: '/algorithms/1_data_structures/0_array_list',
        collapsible: true,
        expanded: true,
        children: [
            {text: '数组 & 链表', link: '/algorithms/1_data_structures/0_array_list'},
            {text: '栈 & 队列',   link: '/algorithms/1_data_structures/1_stack_queue'},
            {text: '哈希表',      link: '/algorithms/1_data_structures/2_hash_table'},
            {text: '树',          link: '/algorithms/1_data_structures/3_tree'},
            {text: '堆',          link: '/algorithms/1_data_structures/4_heap'},
            {text: '图',          link: '/algorithms/1_data_structures/5_graph'},
            {text: '字典树 Trie', link: '/algorithms/1_data_structures/6_trie'},
        ],
    },
    {
        text: '基础算法',
        link: '/algorithms/2_algorithms/0_search',
        collapsible: true,
        expanded: true,
        children: [
            {text: '搜索算法', link: '/algorithms/2_algorithms/0_search'},
            {text: '排序算法', link: '/algorithms/2_algorithms/1_sort'},
            {text: '分治算法', link: '/algorithms/2_algorithms/2_divide_conquer'},
            {text: '回溯算法', link: '/algorithms/2_algorithms/3_backtrack'},
            {text: '贪心算法', link: '/algorithms/2_algorithms/4_greedy'},
        ],
    },
    {
        text: '算法技巧',
        link: '/algorithms/3_patterns/0_dynamic_programming',
        collapsible: true,
        expanded: true,
        children: [
            {text: '动态规划',      link: '/algorithms/3_patterns/0_dynamic_programming'},
            {text: '双指针',        link: '/algorithms/3_patterns/1_two_pointers'},
            {text: '滑动窗口',      link: '/algorithms/3_patterns/2_sliding_window'},
            {text: '前缀和 & 差分', link: '/algorithms/3_patterns/3_prefix_sum'},
            {text: '位运算',        link: '/algorithms/3_patterns/4_bit_manipulation'},
        ],
    },
    {
        text: '刷题实战',
        link: '/algorithms/4_practice/0_leet_code',
        collapsible: true,
        expanded: false,
        children: [
            {text: 'LeetCode', link: '/algorithms/4_practice/0_leet_code'},
            {text: 'HuaWei Code',  link: '/algorithms/4_practice/1_huawei_oj'},
        ],
    },
];

const databaseSidebar = [
    {text: '数据库总览', link: '/database/0_overview'},
    {
        text: 'MySQL',
        link: '/database/1_mysql/0_overview',
        collapsible: true,
        expanded: true,
        children: [
            {text: '概览', link: '/database/1_mysql/0_overview'},
            {text: '版本特性', link: '/database/1_mysql/1_feature'},
            {text: 'MariaDB', link: '/database/1_mysql/2_maria_db'},
            {text: '避坑指南', link: '/database/1_mysql/3_fallible_point'},
            {
                text: '核心专项',
                collapsible: true,
                expanded: true,
                children: [
                    {text: 'MySQL 索引', link: '/database/1_mysql/4_topic_index'},
                    {text: '事务与锁', link: '/database/1_mysql/5_topic_transaction'},
                    {text: '执行流程', link: '/database/1_mysql/6_topic_execution'},
                    {text: 'EXPLAIN 优化', link: '/database/1_mysql/7_topic_explain'},
                    {text: 'InnoDB 存储', link: '/database/1_mysql/8_topic_innodb'},
                    {text: '主从与高可用', link: '/database/1_mysql/9_topic_replication'},
                ],
            },
        ],
    },
    {
        text: 'PostgreSQL',
        link: '/database/2_postgresql/0_overview',
        collapsible: true,
        expanded: false,
        children: [
            {text: '概览', link: '/database/2_postgresql/0_overview'},
            {text: '特性', link: '/database/2_postgresql/1_feature'},
            {
                text: '核心专项',
                collapsible: true,
                expanded: true,
                children: [
                    {text: 'MVCC 与 VACUUM', link: '/database/2_postgresql/2_topic_mvcc'},
                    {text: '索引类型', link: '/database/2_postgresql/3_topic_index'},
                    {text: '高级 SQL', link: '/database/2_postgresql/4_topic_advanced_sql'},
                    {text: '复制与高可用', link: '/database/2_postgresql/5_topic_replication'},
                ],
            },
        ],
    },
    {
        text: '关系库',
        link: '/database/3_relational/0_other_rdbms',
        collapsible: true,
        expanded: false,
        children: [
            {text: '其他 RDBMS', link: '/database/3_relational/0_other_rdbms'},
            {text: '分布式', link: '/database/3_relational/1_distributed_db'},
            {text: 'ORM 框架', link: '/database/3_relational/2_orm_framework'},
        ],
    },
    {
        text: 'NoSQL',
        link: '/database/4_nosql/0_column_db',
        collapsible: true,
        expanded: false,
        children: [
            {text: '列式库', link: '/database/4_nosql/0_column_db'},
            {text: '时序库', link: '/database/4_nosql/1_time_series_db'},
            {text: '文档库', link: '/database/4_nosql/2_document_db'},
            {text: '搜索库', link: '/database/4_nosql/3_search_db'},
            {text: '图数据库',   link: '/database/4_nosql/4_graph_db'},
        ],
    },
    {
        text: '架构运维',
        link: '/database/5_practice/0_cdc_tools',
        collapsible: true,
        expanded: false,
        children: [
            {text: 'CDC 工具', link: '/database/5_practice/0_cdc_tools'},
            {text: '备份恢复', link: '/database/5_practice/1_backup_recovery'},
            {text: '分库分表', link: '/database/5_practice/2_sharding'},
            {text: '连接池', link: '/database/5_practice/3_connection_pool'},
        ],
    },
    {
        text: '参考延伸',
        link: '/database/6_reference/0_binlog_connector_source',
        collapsible: true,
        expanded: false,
        children: [
            {text: 'Binlog 源码', link: '/database/6_reference/0_binlog_connector_source'},
            {text: '选型指南', link: '/database/6_reference/1_selection_guide'},
            {text: 'JDBC 驱动', link: '/database/6_reference/2_jdbc_driver'},
        ],
    },
    {text: '面试专题', link: '/database/99_interview'},
];

// 目录页（面包屑中间层级）标题：主题会为没有 README 的目录自动生成目录页，默认用目录名首字母大写
const DIR_TITLES = {
    '/interview/': '开发总结',
    '/java/': 'Java',
    '/jvm/': 'JVM',
    '/algorithms/': '数据结构与算法',
    '/algorithms/1_data_structures/': '数据结构',
    '/algorithms/2_algorithms/': '基础算法',
    '/algorithms/3_patterns/': '算法技巧',
    '/algorithms/4_practice/': '刷题实战',
    '/protocols/': '网络协议',
    '/spring/': 'Spring',
    '/spring-boot/': 'Spring Boot',
    '/spring-cloud/': 'Spring Cloud',
    '/netty/': 'Netty',
    '/database/': '数据库',
    '/database/1_mysql/': 'MySQL',
    '/database/2_postgresql/': 'PostgreSQL',
    '/database/3_relational/': '关系库',
    '/database/4_nosql/': 'NoSQL',
    '/database/5_practice/': '架构运维',
    '/database/6_reference/': '参考延伸',
    '/cache/': '缓存',
    '/messaging/': '消息队列',
    '/distributed/': '分布式',
    '/microservices/': '微服务',
    '/high-perf/': '高性能',
    '/high-con/': '高并发',
    '/high-avail/': '高可用',
    '/patterns/': '设计模式',
    '/architecture/': '系统架构',
    '/scenario/': '业务场景',
    '/testing/': '测试',
    '/devops/': 'DevOps',
    '/engineering/': '工程效率',
    '/cloud-native/': '云原生',
    '/observability/': '可观测性',
    '/security/': '安全',
    '/iot/': 'IoT',
    '/ai/': 'AI',
    '/ai/1_concepts/': '基础概念',
    '/ai/2_frameworks/': 'Java 框架',
    '/ai/3_integration/': '模型接入',
    '/ai/4_core_tech/': '核心技术',
    '/ai/5_advanced/': '高阶应用',
    '/ai/6_tools/': 'AI 工具生态',
};

export default defineUserConfig({
    head: [
        ['link', {rel: 'icon', href: 'images/logo.png'}]
    ],
    base: '/java-doc/',
    lang: 'zh-CN',
    port: 1000,
    title: 'Java Doc',
    description: '实践是检验真理的唯一标准',
    // 处理vite 打包警告
    bundler: viteBundler({
        viteOptions: {
            build: {
                rollupOptions: {
                    onwarn(warning, warn) {
                        if (warning.code === 'INVALID_ANNOTATION') return;
                        if (warning.code === 'PLUGIN_TIMINGS') return;
                        warn(warning);
                    },
                },
            },
        },
    }),
    theme: hopeTheme({
        logo: '/images/logo.png',
        navbar: NAVBAR_STYLE === 'dropdown' ? navbarDropdown : navbarFlat,
        sidebar: {
            '/interview/': interviewSidebar,
            '/java/': javaSidebar,
            '/database/': databaseSidebar,
            '/cache/': getSidebarFromDir(path.resolve(__dirname, '../cache')),
            '/jvm/': jvmSidebar,
            '/spring/': springSidebar,
            '/spring-boot/': getSidebarFromDir(path.resolve(__dirname, '../spring-boot')),
            '/spring-cloud/': getSidebarFromDir(path.resolve(__dirname, '../spring-cloud')),
            '/microservices/': getSidebarFromDir(path.resolve(__dirname, '../microservices')),
            '/messaging/': getSidebarFromDir(path.resolve(__dirname, '../messaging')),
            '/high-con/': getSidebarFromDir(path.resolve(__dirname, '../high-con')),
            '/distributed/': getSidebarFromDir(path.resolve(__dirname, '../distributed')),
            '/high-avail/': getSidebarFromDir(path.resolve(__dirname, '../high-avail')),
            '/high-perf/': getSidebarFromDir(path.resolve(__dirname, '../high-perf')),
            '/patterns/': patternsSidebar,
            '/scenario/': scenarioSidebar,
            '/netty/': getSidebarFromDir(path.resolve(__dirname, '../netty')),
            '/cloud-native/': cloudNativeSidebar,
            '/algorithms/': algorithmsSidebar,
            '/architecture/': getSidebarFromDir(path.resolve(__dirname, '../architecture')),
            '/protocols/': getSidebarFromDir(path.resolve(__dirname, '../protocols')),
            '/iot/': getSidebarFromDir(path.resolve(__dirname, '../iot')),
            '/ai/': aiSidebar,
            '/testing/': getSidebarFromDir(path.resolve(__dirname, '../testing')),
            '/devops/': getSidebarFromDir(path.resolve(__dirname, '../devops')),
            '/engineering/': getSidebarFromDir(path.resolve(__dirname, '../engineering')),
            '/observability/': getSidebarFromDir(path.resolve(__dirname, '../observability')),
            '/security/': getSidebarFromDir(path.resolve(__dirname, '../security')),
        },
        markdown: {
            hint: true,
            alert: true,
        },
        plugins: {
            // 保留主题默认的 frontmatter，再补上中文目录标题
            catalog: {
                frontmatter: (pagePath) => ({
                    article: false,
                    feed: false,
                    sitemap: false,
                    ...(DIR_TITLES[pagePath] ? {title: DIR_TITLES[pagePath]} : {}),
                }),
            },
            copyCode: {
                showInMobile: true,
            },
            slimsearch: {
                locales: {
                    '/': {placeholder: '搜索'},
                },
                isSearchable: (page) => page.path !== '/',
            },
        },
    }),
});
