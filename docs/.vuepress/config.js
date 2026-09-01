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
    {text: '开发总结', link: '/interview/0_java'},
    {text: 'Java',    link: '/java/0_base'},
    {text: 'JVM',     link: '/jvm/0_memory'},
    {text: '算法',    link: '/algorithms/0_complexity'},
    {text: '设计模式', link: '/patterns/0_design_intro'},
    {text: 'Spring',  link: '/spring/0_spring_framework'},
    {text: 'Spring Boot', link: '/spring-boot/0_spring_boot'},
    {text: '测试体系', link: '/testing/0_testing_intro'},
    {text: '数据库',  link: '/database/0_overview'},
    {text: '缓存',    link: '/cache/0_redis_base'},
    {text: '消息队列', link: '/messaging/0_mq'},
    {text: '分布式',  link: '/distributed/0_distributed'},
    {text: '高并发',  link: '/high-con/0_juc'},
    {text: '高可用',  link: '/high-avail/0_overview'},
    {text: '微服务',  link: '/microservices/0_overview'},
    {text: '架构',    link: '/architecture/0_overview'},
    {text: '协议体系', link: '/protocols/0_overview'},
    {text: 'Netty',   link: '/netty/0_io_model'},
    {text: '云原生',  link: '/cloud-native/0_linux'},
    {text: 'DevOps',  link: '/devops/0_overview'},
    {text: '工程效率', link: '/engineering/0_overview'},
    {text: '可观测性', link: '/observability/0_observability'},
    {text: '安全',    link: '/security/0_security'},
    {text: 'IoT',     link: '/iot/0_base'},
    {text: 'AI',      link: '/ai/0_overview'},
    {text: '业务场景', link: '/scenario/0_scene'},
];

const navbarDropdown = [
    {text: '开发总结', link: '/interview/0_java'},
    {
        text: '基础体系',
        children: [
            {text: 'Java',    link: '/java/0_base'},
            {text: 'JVM',     link: '/jvm/0_memory'},
            {text: '算法',    link: '/algorithms/0_complexity'},
            {text: '设计模式', link: '/patterns/0_design_intro'},
        ],
    },
    {
        text: '框架生态',
        children: [
            {text: 'Spring',          link: '/spring/0_spring_framework'},
            {text: 'Spring Boot',     link: '/spring-boot/0_spring_boot'},
            {text: 'Spring Cloud',    link: '/spring-cloud/0_overview'},
            {text: 'Dubbo',           link: '/microservices/4_dubbo'},
            {text: 'ORM 框架',        link: '/database/3_relational/2_orm_framework'},
            {text: '任务调度',        link: '/distributed/5_job_scheduler'},
            {text: 'Spring AI',       link: '/ai/2_frameworks/0_spring_ai'},
            {text: 'LangChain4j',     link: '/ai/2_frameworks/1_langchain4j'},
        ],
    },
    {
        text: '数据存储',
        children: [
            {text: '数据库',   link: '/database/0_overview'},
            {text: '缓存',     link: '/cache/0_redis_base'},
            {text: '消息队列', link: '/messaging/0_mq'},
        ],
    },
    {
        text: '分布式架构',
        children: [
            {text: '分布式', link: '/distributed/0_distributed'},
            {text: '高并发', link: '/high-con/0_juc'},
            {text: '高可用', link: '/high-avail/0_overview'},
            {text: '微服务', link: '/microservices/0_overview'},
            {text: '系统架构', link: '/architecture/0_overview'},
            {text: '协议体系', link: '/protocols/0_overview'},
            {text: 'Netty 网络编程', link: '/netty/0_io_model'},
        ],
    },
    {
        text: '工程实践',
        children: [
            {text: '云原生',   link: '/cloud-native/0_linux'},
            {text: 'DevOps',  link: '/devops/0_overview'},
            {text: '工程效率', link: '/engineering/0_overview'},
            {text: '可观测性', link: '/observability/0_observability'},
            {text: '测试体系', link: '/testing/0_testing_intro'},
        ],
    },
    {text: '安全体系', link: '/security/0_security'},
    {
        text: '垂直领域',
        children: [
            {text: 'IoT',     link: '/iot/0_base'},
            {text: 'AI',      link: '/ai/0_overview'},
            {text: '大数据', link: '/scenario/0_scene'},
        ],
    },
];

function getSidebarFromDir(dirPath) {
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
            text: firstHeading,
            link: `/${relativeLink}`,
        };
    });
}

const aiSidebar = [
    {text: 'AI 开发总览', link: '/ai/0_overview'},
    {
        text: '基础概念',
        collapsible: true,
        collapsed: false,
        children: [
            {text: '大语言模型', link: '/ai/1_concepts/0_model'},
            {text: 'Prompt 工程',   link: '/ai/1_concepts/1_prompt'},
        ],
    },
    {
        text: 'Java 框架',
        collapsible: true,
        collapsed: false,
        children: [
            {text: 'Spring AI',    link: '/ai/2_frameworks/0_spring_ai'},
            {text: 'LangChain4j', link: '/ai/2_frameworks/1_langchain4j'},
        ],
    },
    {
        text: '模型接入',
        collapsible: true,
        collapsed: false,
        children: [
            {text: 'Ollama（本地部署）', link: '/ai/3_integration/0_ollama'},
            {text: '主流 API 接入',      link: '/ai/3_integration/1_api_access'},
        ],
    },
    {
        text: '核心技术',
        collapsible: true,
        collapsed: false,
        children: [
            {text: 'Embedding',  link: '/ai/4_core_tech/0_embedding'},
            {text: '向量数据库', link: '/ai/4_core_tech/1_vector_db'},
            {text: 'RAG 检索增强',        link: '/ai/4_core_tech/2_rag'},
        ],
    },
    {
        text: '高阶应用',
        collapsible: true,
        collapsed: false,
        children: [
            {text: 'AI Agent', link: '/ai/5_advanced/0_agent'},
            {text: 'MCP 协议', link: '/ai/5_advanced/1_mcp'},
            {text: '模型微调', link: '/ai/5_advanced/2_fine_tuning'},
        ],
    },
    {
        text: 'AI 工具生态',
        collapsible: true,
        collapsed: true,
        children: [
            {text: 'AI 工具总览', link: '/ai/6_tools/0_ai_tools'},
        ],
    },
];

const databaseSidebar = [
    {text: '数据库总览', link: '/database/0_overview'},
    {
        text: 'MySQL 专题',
        link: '/database/1_mysql/0_overview',
        collapsible: true,
        collapsed: false,
        children: [
            {text: '概览', link: '/database/1_mysql/0_overview'},
            {text: '版本特性', link: '/database/1_mysql/1_feature'},
            {text: 'MariaDB', link: '/database/1_mysql/2_maria_db'},
            {text: '避坑指南', link: '/database/1_mysql/3_fallible_point'},
            {
                text: '核心专项',
                collapsible: true,
                collapsed: false,
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
        text: 'PG 专题',
        link: '/database/2_postgresql/0_overview',
        collapsible: true,
        collapsed: true,
        children: [
            {text: '概览', link: '/database/2_postgresql/0_overview'},
            {text: '特性', link: '/database/2_postgresql/1_feature'},
            {
                text: '核心专项',
                collapsible: true,
                collapsed: false,
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
        text: '关系库生态',
        link: '/database/3_relational/0_other_rdbms',
        collapsible: true,
        collapsed: true,
        children: [
            {text: '其他 RDBMS', link: '/database/3_relational/0_other_rdbms'},
            {text: '分布式', link: '/database/3_relational/1_distributed_db'},
            {text: 'ORM 框架', link: '/database/3_relational/2_orm_framework'},
        ],
    },
    {
        text: 'NoSQL 生态',
        link: '/database/4_nosql/0_column_db',
        collapsible: true,
        collapsed: true,
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
        collapsed: true,
        children: [
            {text: 'CDC 工具', link: '/database/5_practice/0_cdc_tools'},
            {text: '备份恢复', link: '/database/5_practice/1_backup_recovery'},
            {text: '分库分表', link: '/database/5_practice/2_sharding'},
            {text: '连接池', link: '/database/5_practice/3_connection_pool'},
        ],
    },
    {
        text: '源码及选型',
        link: '/database/6_reference/0_binlog_connector_source',
        collapsible: true,
        collapsed: true,
        children: [
            {text: 'Mbcj 源码', link: '/database/6_reference/0_binlog_connector_source'},
            {text: '数据库选型', link: '/database/6_reference/1_selection_guide'},
        ],
    },
    {text: '面试专题', link: '/database/99_interview'},
];

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
            '/interview/': getSidebarFromDir(path.resolve(__dirname, '../interview')),
            '/java/': getSidebarFromDir(path.resolve(__dirname, '../java')),
            '/database/': databaseSidebar,
            '/cache/': getSidebarFromDir(path.resolve(__dirname, '../cache')),
            '/jvm/': getSidebarFromDir(path.resolve(__dirname, '../jvm')),
            '/spring/': getSidebarFromDir(path.resolve(__dirname, '../spring')),
            '/spring-boot/': getSidebarFromDir(path.resolve(__dirname, '../spring-boot')),
            '/spring-cloud/': getSidebarFromDir(path.resolve(__dirname, '../spring-cloud')),
            '/microservices/': getSidebarFromDir(path.resolve(__dirname, '../microservices')),
            '/messaging/': getSidebarFromDir(path.resolve(__dirname, '../messaging')),
            '/high-con/': getSidebarFromDir(path.resolve(__dirname, '../high-con')),
            '/distributed/': getSidebarFromDir(path.resolve(__dirname, '../distributed')),
            '/high-avail/': getSidebarFromDir(path.resolve(__dirname, '../high-avail')),
            '/patterns/': getSidebarFromDir(path.resolve(__dirname, '../patterns')),
            '/scenario/': getSidebarFromDir(path.resolve(__dirname, '../scenario')),
            '/netty/': getSidebarFromDir(path.resolve(__dirname, '../netty')),
            '/cloud-native/': getSidebarFromDir(path.resolve(__dirname, '../cloud-native')),
            '/algorithms/': getSidebarFromDir(path.resolve(__dirname, '../algorithms')),
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
