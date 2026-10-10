# 业务场景总览

本模块以具体业务问题为线索，把缓存、消息、数据库、分布式与三高知识组合成完整方案，适合学完各技术模块后做综合练习。

**版本基线（2026 年 10 月）**：JDK 21、Spring Boot 4、Redis 8.x、RocketMQ 5.x、MySQL 8.4 LTS、ShardingSphere 5.5、Flink 2.x

---

## 一、模块导航

<ModuleNav />

---

## 二、推荐阅读路径

1. 先读 [秒杀](./4_seckill)、[订单](./5_order_system)，这两个场景最能串联三高、缓存、MQ 与分布式事务
2. 再读 [短链接](./6_shorturl)、[排行榜和积分](./7_rank_system)、[Feed 流和消息推送](./8_feed_stream)、[搜索](./9_search_system)，覆盖读多写少、写扩散与检索问题
3. 交易链路的周边：[购物车](./19_cart) → [优惠券和营销](./15_coupon) → [支付系统](./14_payment)，与订单一起串起从加购、用券、下单到支付对账的完整链路
4. 实时与高频写：[即时通讯](./16_im)、[计数系统](./17_counter)、[扫码登录](./18_qr_login)，覆盖长连接与位点同步、计数合并与热点、跨设备授权
5. 然后按需阅读 [海量数据架构选型](./2_big_data)、[海量数据算法题](./3_massive_data)、[海量数据对账](./3_reconcile)、[海量数据导入导出](./3_sheet_export)、[大文件上传](./10_file_upload)、[抢红包](./11_red_packet)、[附近的人](./12_geo_nearby)、[商品详情页](./13_product_detail)
6. 幂等是贯穿所有场景的基础能力，统一看 [幂等设计](/architecture/5_idempotence)

[高频面试题](./99_interview) 只列题目，答案在 [业务场景面试题解答](/interview/16_scenario)。

---

## 三、关联模块

每篇只写方案的组合方式与关键取舍，涉及的单项技术（限流、热点、分库分表、分布式 ID、事务消息、幂等等）都链接到各自的主文档。与旧版本行为不同的地方（如 RocketMQ 4.x 的固定延迟级别）在正文中单独标出。

- 三高方法论 → [高并发总览](/high-con/0_overview) / [高可用总览](/high-avail/0_overview) / [高性能总览](/high-perf/0_overview)
- 缓存一致性、热点与 Redis 用法 → [缓存总览](/cache/0_overview)
- 分布式锁、分布式事务、分布式 ID、分布式调度 → [分布式总览](/distributed/0_overview)
- 事务消息、延迟消息、可靠投递与幂等消费 → [消息队列总览](/messaging/0_overview)
- 分库分表、OLAP、搜索引擎 → [数据库总览](/database/0_overview)
- 架构模式、幂等、冷热分离 → [系统架构总览](/architecture/0_overview)
