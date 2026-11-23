# 业务场景总览

本模块以具体业务问题为线索，把缓存、消息、数据库、分布式与三高知识组合成完整方案，适合学完各技术模块后做综合练习。

**版本基线（2026 年 10 月）**：JDK 21、Spring Boot 4、Redis 8、RocketMQ 5、MySQL 8.4 LTS、ShardingSphere 5.5、Flink 2.2

---

## 一、模块导航

<ModuleNav />

---

## 二、分组与阅读顺序

侧边栏的分组顺序就是建议的阅读顺序，组内的文章也按先后排好了。先读 [系统设计方法论](./1_design_method)，掌握从需求澄清到取舍的推进方式，后面每个场景都是它的一次实例。读过几个场景之后回头看 [同类问题横向对照](./2_cross_scenario)，它把同一个问题在各场景里的做法放在一起比。

| 分组 | 这一组在练什么 | 怎么读 |
|------|------|------|
| 交易与资金 | 状态机、幂等、一致性：钱和货不能错 | 按一次购买的流程排：[商品详情页](./3_product_detail) → [购物车](./4_cart) → [优惠券和营销](./5_coupon) → [库存与票务](./6_inventory) → [订单](./7_order_system) → [支付](./8_payment) → [售后与退款](./9_after_sale) → [账户与记账](./10_account_ledger)，顺着读就是从浏览、加购、用券、扣库存、下单、支付、退款到记账对平的完整链路 |
| 营销活动 | 瞬时高并发下，有限的东西怎么分：不超发、扛得住、防得住刷 | [秒杀](./11_seckill) 最能串联三高、缓存与消息队列，先读它，再读 [抢红包](./12_red_packet)、[抽奖](./13_lottery)、[排行榜和积分](./14_rank_system) |
| 内容与社交 | 读写比悬殊时的扩散模型、计数与实时触达 | [Feed 流和消息推送](./15_feed_stream) → [评论系统](./16_comment) → [计数服务](./17_counter) 是内容平台的一条线，[即时通讯](./18_im)、[消息通知中心](./19_notification) 讲长连接与多渠道触达，[附近的人](./20_geo_nearby) 讲位置检索 |
| 通用能力 | 多个业务都会用到的平台组件 | [短链接](./21_shorturl)、[搜索](./22_search_system)、[大文件上传](./23_file_upload)、[扫码登录](./24_qr_login)、[延迟任务](./25_delay_task) 彼此独立，按需读；关单、提醒、退避重试等「到点执行一次」的需求都归到延迟任务 |
| 海量数据 | 单机放不下、一次读不完时怎么拆 | 先读 [海量数据架构选型](./26_big_data)，[海量数据算法题](./27_massive_data) 偏面试，[海量数据对账](./28_reconcile)、[海量数据导入导出](./29_sheet_export) 是两个最常见的落地场景 |

幂等贯穿多个场景，统一看 [幂等设计](/architecture/3_idempotence)。[高频面试题](./99_interview) 只列题目，答案在 [业务场景面试题解答](/interview/21_scenario)。

---

## 三、按问题找场景

同一个问题在不同场景里的解法并不一样。带着问题来的话，按下表找到讲得最细的几篇；其中七个问题的做法已经并排整理在 [同类问题横向对照](./2_cross_scenario) 里：

| 要解决的问题 | 讲到它的场景 |
|------|------|
| 不能超发、不能超卖 | [秒杀](./11_seckill)、[抢红包](./12_red_packet)、[抽奖](./13_lottery)、[优惠券和营销](./5_coupon)、[库存与票务](./6_inventory) |
| 幂等与防重 | [订单](./7_order_system)、[支付](./8_payment)、[优惠券和营销](./5_coupon)、[计数服务](./17_counter)、[消息通知中心](./19_notification) |
| 状态机与条件更新 | [订单](./7_order_system)、[支付](./8_payment)、[优惠券和营销](./5_coupon)、[库存与票务](./6_inventory)、[扫码登录](./24_qr_login) |
| 热点 | [商品详情页](./3_product_detail)、[秒杀](./11_seckill)、[库存与票务](./6_inventory)、[计数服务](./17_counter)、[评论系统](./16_comment) |
| 多级缓存与缓存一致性 | [商品详情页](./3_product_detail)、[短链接](./21_shorturl)、[评论系统](./16_comment)、[计数服务](./17_counter) |
| 削峰与异步落库 | [秒杀](./11_seckill)、[优惠券和营销](./5_coupon)、[计数服务](./17_counter)、[购物车](./4_cart) |
| 限流与防刷 | [秒杀](./11_seckill)、[优惠券和营销](./5_coupon)、[消息通知中心](./19_notification)、[扫码登录](./24_qr_login) |
| 读扩散与写扩散 | [Feed 流和消息推送](./15_feed_stream)、[即时通讯](./18_im)、[消息通知中心](./19_notification) |
| 游标分页与分批读取 | [Feed 流和消息推送](./15_feed_stream)、[评论系统](./16_comment)、[海量数据对账](./28_reconcile)、[海量数据导入导出](./29_sheet_export) |
| 到点执行（关单、过期、退回） | [延迟任务](./25_delay_task)、[订单](./7_order_system)、[支付](./8_payment)、[售后与退款](./9_after_sale)、[抢红包](./12_red_packet)、[优惠券和营销](./5_coupon) |
| 对账与校准 | [海量数据对账](./28_reconcile)、[支付](./8_payment)、[账户与记账](./10_account_ledger)、[库存与票务](./6_inventory)、[抢红包](./12_red_packet)、[计数服务](./17_counter) |
| 长连接与实时推送 | [即时通讯](./18_im)、[扫码登录](./24_qr_login)、[Feed 流和消息推送](./15_feed_stream) |

---

## 四、关联模块

每篇只写方案的组合方式与关键取舍，涉及的单项技术（限流、热点、分库分表、分布式 ID、事务消息、幂等等）都链接到各自的主文档。与旧版本行为不同的地方（如 RocketMQ 4.x 的固定延迟级别）在正文中单独标出。

- 三高方法论 → [高并发总览](/high-con/0_overview) / [高可用总览](/high-avail/0_overview) / [高性能总览](/high-perf/0_overview)
- 缓存一致性、热点与 Redis 用法 → [Redis 与缓存总览](/cache/0_overview)
- 分布式锁、分布式事务、分布式 ID、分布式调度 → [分布式基础总览](/distributed/0_overview)
- 事务消息、延迟消息、可靠投递与幂等消费 → [消息队列总览](/messaging/0_overview)
- 分库分表 → [关系数据库总览](/database/0_overview)
- OLAP、搜索 → [NoSQL 数据库总览](/nosql/0_overview)
- 架构模式、幂等、冷热分离 → [系统架构总览](/architecture/0_overview)
- 数仓、湖仓、离线批处理与实时数仓 → [大数据总览](/big-data/0_overview)
- 音视频上传与转码、直播、通话信令 → [音视频总览](/media/0_overview)
