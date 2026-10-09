---
description: Redis GEO、过期成员清理、可见性控制、门店同步、司机派单防并发、Geohash 九宫格、位置隐私
---

# 附近的人

> **本篇目标**：用 Redis GEO 实现附近的人、附近门店与司机匹配，处理过期成员、不可见用户和派单并发，理解 Geohash 的边界问题，并把位置隐私做到不能被反推。
>
> **前置阅读**：[Redis 基础](/cache/1_redis_base)（GEO 一节）

附近的人、附近门店、打车派单的核心都是「存坐标 + 查范围内的点」。Redis GEO 底层是 ZSet：把经纬度编码成 52 位整数作为 score，所以 ZSet 的命令（`ZREM`、`ZSCORE` 等）都能用在 GEO key 上。

---

## 一、技术选型

| 技术 | 原理 | 适用场景 |
|------|------|---------|
| Redis GEO | Geohash 编码 + ZSet | 高频更新、实时查询：附近的人、司机位置 |
| MySQL 空间索引 | `POINT` 列（SRID 4326）+ `SPATIAL` 索引（R 树），`ST_Distance_Sphere` 算球面距离 | 数据量中等、需要和业务表一起查询 |
| Elasticsearch | `geo_point` 字段 + `geo_distance` 过滤与按距离排序 | 附近搜索与全文检索、筛选结合 |
| PostGIS | PostgreSQL 空间扩展 | 地理围栏、路径分析等复杂 GIS |

---

## 二、附近的人

### 1、命令

```bash
GEOADD   nearby:{BJ}:loc 116.404 39.915 "1001"          # 经度在前，纬度在后
GEOSEARCH nearby:{BJ}:loc FROMLONLAT 116.404 39.915 BYRADIUS 1 km ASC COUNT 100 WITHDIST
GEODIST  nearby:{BJ}:loc "1001" "1002" m
GEOPOS   nearby:{BJ}:loc "1001"
GEOHASH  nearby:{BJ}:loc "1001"                          # 返回 11 位标准 Base32 字符串
```

- `GEOSEARCH` 需要 Redis 6.2+，`GEORADIUS` / `GEORADIUSBYMEMBER` 已废弃
- 内部存储是 52 位整数 score，`GEOHASH` 命令返回的是换算后的 11 位标准字符串，可以与 MySQL、ES 中的 Geohash 互通
- key 按城市拆分，单个 key 不至于过大；`{BJ}` 是哈希标签，让同城的几个 key 在 Redis Cluster 中落在同一个槽，便于 Lua 一起操作

### 2、上报位置

每个城市维护两个 key：位置 `nearby:{city}:loc`（GEO）和最近上报时间 `nearby:{city}:ts`（ZSet，score 为毫秒时间戳）。

```java
public void report(long userId, String city, double lng, double lat) {
    if (visibility.isHidden(userId)) {                 // 设置了不可见：不写入
        return;
    }
    Point p = Privacy.snap(lng, lat);                  // 先吸附到网格，见第五节
    String member = String.valueOf(userId);
    redis.executePipelined((RedisCallback<Object>) conn -> {
        conn.geoCommands().geoAdd(bytes("nearby:{" + city + "}:loc"), p, bytes(member));
        conn.zSetCommands().zAdd(bytes("nearby:{" + city + "}:ts"), System.currentTimeMillis(), bytes(member));
        return null;
    });
}

private static byte[] bytes(String s) {
    return s.getBytes(StandardCharsets.UTF_8);
}
```

### 3、查询：多取再过滤

先过滤再截断：`COUNT 20` 直接取 20 条，排除自己、过期用户、不可见用户后可能一条不剩。正确做法是多取一些，再批量过滤：

```java
public List<NearbyUser> nearby(long userId, String city, double lng, double lat) {
    String loc = "nearby:{" + city + "}:loc";
    String ts = "nearby:{" + city + "}:ts";
    GeoResults<RedisGeoCommands.GeoLocation<String>> results = redis.opsForGeo().search(loc,
            GeoReference.fromCoordinate(lng, lat),
            new Distance(1, Metrics.KILOMETERS),
            RedisGeoCommands.GeoSearchCommandArgs.newGeoSearchArgs()
                    .includeDistance().sortAscending().limit(100));

    String self = String.valueOf(userId);
    List<GeoResult<RedisGeoCommands.GeoLocation<String>>> candidates = results.getContent().stream()
            .filter(r -> !r.getContent().getName().equals(self))
            .toList();
    if (candidates.isEmpty()) return List.of();

    Object[] members = candidates.stream().map(r -> r.getContent().getName()).toArray();
    List<Double> lastSeen = redis.opsForZSet().score(ts, members);       // ZMSCORE，一次取回，Redis 6.2+
    Set<String> hidden = visibility.hiddenAmong(members);                 // 批量查（本地缓存 + MGET）
    long freshAfter = System.currentTimeMillis() - Duration.ofMinutes(10).toMillis();

    List<NearbyUser> out = new ArrayList<>();
    for (int i = 0; i < candidates.size() && out.size() < 20; i++) {
        Double seen = lastSeen.get(i);
        String member = (String) members[i];
        if (seen != null && seen >= freshAfter && !hidden.contains(member)) {
            out.add(NearbyUser.of(member, Privacy.bucket(candidates.get(i).getDistance())));
        }
    }
    return out;
}
```

### 4、清理过期成员

只给「上报时间」设 TTL 并不会把人从 GEO key 里移走，key 会越来越大，查询也越来越慢。用定时任务按上报时间批量删除：

```lua
-- KEYS[1] nearby:{city}:loc   KEYS[2] nearby:{city}:ts   ARGV[1] 过期时间点（毫秒）
local stale = redis.call('ZRANGE', KEYS[2], '-inf', ARGV[1], 'BYSCORE', 'LIMIT', 0, 500)
if #stale > 0 then
    redis.call('ZREM', KEYS[1], unpack(stale))
    redis.call('ZREM', KEYS[2], unpack(stale))
end
return #stale
```

每次最多删 500 个，返回值等于 500 时继续执行下一批，避免单个脚本阻塞太久。

### 5、不可见设置

只从 GEO 中删掉是不够的：用户下一次上报又会被加回来。不可见是一个持久的用户设置：

- **写入侧**：设置不可见时先落库并刷新缓存，再 `ZREM` 当前城市的两个 key；上报时检查该设置，不可见就不写
- **查询侧**：结果再按可见性批量过滤一次，挡住「读到旧设置的并发上报又把人加回来」的窄窗口
- **用户退出登录、注销账号**时同样删除位置

---

## 三、附近门店

门店位置变化少，但会新增、迁址和关店，不能只在应用启动时 `@PostConstruct` 全量加载：每个实例每次启动都重复写一遍，关掉的门店也永远不会删掉。

- **增量同步**：门店表的变更经 CDC 或业务事件同步，新增和迁址执行 `GEOADD`，关店执行 `ZREM`
- **全量校准**：由分布式调度每天执行一次，把全部门店批量写入一个新 key，再用 `RENAME` 原子替换旧 key

```java
public void rebuildStores(String city) {
    String tmp = "stores:{" + city + "}:loc:tmp";
    redis.delete(tmp);
    storeMapper.streamOpenStores(city, 1000, batch -> {               // 分批读取，每批一次 GEOADD
        Map<String, Point> points = batch.stream().collect(Collectors.toMap(
                s -> String.valueOf(s.getId()), s -> new Point(s.getLongitude(), s.getLatitude())));
        redis.opsForGeo().add(tmp, points);
    });
    redis.rename(tmp, "stores:{" + city + "}:loc");                    // 两个 key 同槽，Cluster 下才能 RENAME
}

public List<StoreVO> nearbyStores(String city, double lng, double lat, double radiusKm) {
    GeoResults<RedisGeoCommands.GeoLocation<String>> results = redis.opsForGeo().search(
            "stores:{" + city + "}:loc",
            GeoReference.fromCoordinate(lng, lat),
            new Distance(radiusKm, Metrics.KILOMETERS),
            RedisGeoCommands.GeoSearchCommandArgs.newGeoSearchArgs().includeDistance().sortAscending().limit(50));
    List<Long> ids = results.getContent().stream()
            .map(r -> Long.parseLong(r.getContent().getName()))
            .toList();
    return storeService.batchGetWithCache(ids);                          // 详情批量读缓存，未命中回源
}
```

---

## 四、司机派单

### 1、状态与位置一起判断

空闲司机放在 `drivers:{city}:available`（GEO），最近心跳放在 `drivers:{city}:ts`，状态放在 `drivers:{city}:status`（Hash，`driverId → AVAILABLE / DISPATCHING:{orderId} / OFFLINE`）。状态以服务端为准，不信任客户端上报的状态。

上报位置时，只有服务端状态仍是 `AVAILABLE` 才写入空闲池，判断和写入在一个脚本里，避免「刚被派单又被上报加回空闲池」：

```lua
-- KEYS[1] available  KEYS[2] ts  KEYS[3] status   ARGV[1] driverId  ARGV[2] lng  ARGV[3] lat  ARGV[4] 当前毫秒
if redis.call('HGET', KEYS[3], ARGV[1]) ~= 'AVAILABLE' then
    return 0
end
redis.call('GEOADD', KEYS[1], ARGV[2], ARGV[3], ARGV[1])
redis.call('ZADD', KEYS[2], ARGV[4], ARGV[1])
return 1
```

### 2、派单：原子占用司机

两个订单同时查到同一个司机是常态。先按距离取候选，再逐个尝试**原子占用**，占用成功才派单：

```lua
-- KEYS 同上   ARGV[1] driverId  ARGV[2] orderId
if redis.call('HGET', KEYS[3], ARGV[1]) ~= 'AVAILABLE' then
    return 0                                    -- 已被其他订单占用或已下线
end
redis.call('HSET', KEYS[3], ARGV[1], 'DISPATCHING:' .. ARGV[2])
redis.call('ZREM', KEYS[1], ARGV[1])
redis.call('ZREM', KEYS[2], ARGV[1])
return 1
```

- 占用成功后，在数据库里用条件更新落地派单关系（`UPDATE driver SET status = 'DISPATCHING', order_id = ? WHERE id = ? AND status = 'AVAILABLE'`），失败就把 Redis 状态改回并尝试下一个候选
- 司机在超时时间内未接单，释放占用：状态改回 `AVAILABLE`，等下一次上报重新进入空闲池
- 完单或取消后由服务端把状态置回 `AVAILABLE`

### 3、下线检测

App 崩溃或断网时不会上报「下线」。定时任务按心跳扫描超过 30 秒未上报的司机：用和上面清理过期用户相同的脚本把他们移出空闲池，并把仍为 `AVAILABLE` 的状态改为 `OFFLINE`。

---

## 五、位置隐私

### 1、对外只给模糊距离

```java
public static String bucket(Distance d) {
    double meters = d.in(Metrics.METERS).getValue();   // 以米为单位
    if (meters < 100) return "100米内";
    if (meters < 1000) return (int) (Math.ceil(meters / 100) * 100) + "米内";   // 向上取整到 100 米
    return String.format("%.1f公里", meters / 1000);
}
```

`Distance.in(Metric)` 换算单位，查询时用的是公里，所以这里先换成米。

### 2、只模糊距离还不够

攻击者可以伪造自己的位置，从多个点查询同一个人的「模糊距离」，用三边定位反推出精确位置；每次上报都加一个新的随机偏移也挡不住，多次查询取平均就把噪声抵消了。可行的组合：

- **存储前吸附到网格**：坐标统一吸附到约 150 米见方的格子中心，同一格子内怎么移动对外都不可见，精度上限由格子大小决定，平均多少次都不会更准
- **稳定偏移**：若使用偏移，对同一用户在一段时间内使用固定偏移（如由用户 ID 与日期派生），不要每次重新随机
- **限制查询方**：查询中心用查询者最近一次真实上报的位置，而不是请求参数里的任意坐标；对位置跳变过大的上报做风控
- **限流**：对附近的人接口按用户限流，见 [限流与过载保护](/high-avail/7_rate_limiting)

```java
public static Point snap(double lng, double lat) {
    double latStep = 0.0015;                                           // 纬度 0.0015° 约 167 米
    double snappedLat = Math.floor(lat / latStep) * latStep + latStep / 2;
    double lngStep = latStep / Math.cos(Math.toRadians(snappedLat));   // 经度步长按纬度放大，格子近似正方形
    double snappedLng = Math.floor(lng / lngStep) * lngStep + lngStep / 2;
    return new Point(snappedLng, snappedLat);
}
```

经度 1° 对应的距离随纬度变化：赤道约 111 公里，北京（北纬约 40°）约 111 × cos 40° ≈ 85 公里，所以「0.001° 约 100 米」只对纬度成立，经度方向要按纬度换算。

---

## 六、Geohash 原理

### 1、编码

Geohash 把经度、纬度区间反复二分，交替取经度位和纬度位，每 5 位编成一个 Base32 字符。字符串越长，格子越小；**前缀相同的点一定落在同一个格子里**，距离不会超过格子大小。

| 长度 | 格子大小（约） |
|------|--------------|
| 4 | 39 km × 19.5 km |
| 5 | 4.9 km × 4.9 km |
| 6 | 1.2 km × 0.61 km |
| 7 | 153 m × 153 m |
| 8 | 38 m × 19 m |

### 2、边界问题

反过来却不成立：**距离很近的两个点，可能分属相邻的两个格子，前缀完全不同**。只按前缀查当前格子，就会漏掉格子边界另一侧的点。

![Geohash 边界问题与九宫格查询](../assets/scenario/geohash-neighbors.svg)

解决办法：

1. 选择格子边长不小于查询半径的精度
2. 查询中心格和周围 8 个邻居格（九宫格）
3. 对候选点按实际距离再过滤一次，九宫格的覆盖范围比圆大

在 MySQL、ES 中自己维护 Geohash 列时用得到这一点；Redis 的 `GEOSEARCH` 内部已经做了邻居格搜索与距离过滤。Java 中可以用 geohash-java（Maven 坐标 `ch.hsr:geohash`）计算邻居：

```java
public List<String> nineCells(double lat, double lng, int precision) {
    GeoHash center = GeoHash.withCharacterPrecision(lat, lng, precision);
    List<String> cells = new ArrayList<>(9);
    cells.add(center.toBase32());
    for (GeoHash h : center.getAdjacent()) {          // 8 个邻居
        cells.add(h.toBase32());
    }
    return cells;
}
```

---

## 小结

| 场景 | 方案 |
|------|------|
| 附近的人 | Redis GEO 按城市分 key + 上报时间 ZSet；多取再过滤，定时清理过期成员 |
| 不可见 | 持久的用户设置，上报时检查、查询时再过滤 |
| 附近门店 | Redis GEO 或 MySQL 空间索引；增量同步 + 每日全量重建后 `RENAME` |
| 司机派单 | 状态与位置在同一个 Lua 中判断；原子占用司机，数据库条件更新落地；心跳检测下线 |
| 复杂地理围栏、路径规划 | PostGIS 或地图服务商 API |
| 附近搜索 + 全文检索 | Elasticsearch `geo_point` |
| 位置隐私 | 网格吸附 + 模糊距离 + 限制查询中心 + 限流 |
| Geohash 自建索引 | 九宫格查询 + 实际距离过滤 |

## 参考资料

- GEOSEARCH：[https://redis.io/docs/latest/commands/geosearch/](https://redis.io/docs/latest/commands/geosearch/)
- GEOADD：[https://redis.io/docs/latest/commands/geoadd/](https://redis.io/docs/latest/commands/geoadd/)
- Redis 地理空间数据类型：[https://redis.io/docs/latest/develop/data-types/geospatial/](https://redis.io/docs/latest/develop/data-types/geospatial/)
- MySQL 空间便捷函数（ST_Distance_Sphere）：[https://dev.mysql.com/doc/refman/8.4/en/spatial-convenience-functions.html](https://dev.mysql.com/doc/refman/8.4/en/spatial-convenience-functions.html)
- geohash-java：[https://github.com/kungfoo/geohash-java](https://github.com/kungfoo/geohash-java)

> 下一篇：[商品详情页](./13_product_detail) —— 静动分离、三级缓存、变更消息重建、热点预热与降级兜底。
