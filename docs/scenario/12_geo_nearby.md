# 附近的人 & LBS 地理位置设计

> 附近的人、附近门店、打车匹配等 LBS 场景的核心是：高效存储地理坐标 + 快速查询范围内的点。

---

## 一、核心技术选型

| 技术 | 原理 | 适用场景 |
|------|------|---------|
| Redis GEO | 基于 Geohash + ZSet | 简单附近查询，实时性高 |
| Geohash | 将经纬度编码为字符串 | 前缀匹配查询附近区域 |
| MySQL 空间索引 | R-Tree 空间索引 | 数据量中等，需要复杂空间查询 |
| Elasticsearch geo | geo_point + geo_distance | 附近查询 + 全文检索结合 |
| PostGIS | PostgreSQL 空间扩展 | 复杂 GIS 分析 |

---

## 二、Redis GEO 实现附近的人

### 2.1 核心命令

```bash
# 添加用户位置（经度, 纬度, 成员名）
GEOADD users:loc 116.404 39.915 "user:1001"
GEOADD users:loc 116.408 39.918 "user:1002"

# 查询两点距离
GEODIST users:loc "user:1001" "user:1002" km

# 查询附近成员（以某经纬度为中心，1km 范围内）
GEOSEARCH users:loc FROMMEMBER "user:1001" BYRADIUS 1 km ASC COUNT 20

# 查询某成员的经纬度
GEOPOS users:loc "user:1001"

# 获取 Geohash 编码
GEOHASH users:loc "user:1001"
```

### 2.2 Java 实现

```java
// 上报位置（用户每隔一段时间上报）
public void updateLocation(Long userId, double longitude, double latitude) {
    String key = "users:loc";
    String member = "user:" + userId;

    redisTemplate.opsForGeo().add(key,
        new Point(longitude, latitude), member);

    // 同时更新上报时间（用于判断用户是否在线/活跃）
    redis.set("user:loc:time:" + userId,
        String.valueOf(System.currentTimeMillis()), 10, TimeUnit.MINUTES);
}

// 查询附近用户（1km 内，最多返回 20 个）
public List<NearbyUser> getNearbyUsers(Long userId, double radiusKm) {
    String key = "users:loc";
    String member = "user:" + userId;

    GeoResults<RedisGeoCommands.GeoLocation<String>> results =
        redisTemplate.opsForGeo().search(key,
            GeoReference.fromMember(member),
            new Distance(radiusKm, Metrics.KILOMETERS),
            RedisGeoCommands.GeoSearchCommandArgs.newGeoSearchArgs()
                .includeDistance()
                .includeCoordinates()
                .limit(20)
                .sortAscending()
        );

    return results.getContent().stream()
        .filter(r -> !r.getContent().getName().equals(member)) // 排除自己
        .filter(r -> isUserActive(r.getContent().getName()))   // 只返回活跃用户
        .map(r -> buildNearbyUser(r))
        .collect(Collectors.toList());
}

private boolean isUserActive(String member) {
    Long userId = Long.parseLong(member.replace("user:", ""));
    return redis.hasKey("user:loc:time:" + userId);
}
```

---

## 三、隐私保护

### 3.1 模糊位置

不暴露精确位置，只显示大致距离（如"1公里内"而非"528米"）：

```java
public String formatDistance(double meters) {
    if (meters < 100) return "100米内";
    if (meters < 1000) return (int)(Math.ceil(meters / 100) * 100) + "米";
    return String.format("%.1f公里", meters / 1000);
}
```

### 3.2 坐标偏移

存入 Redis 前对坐标加随机偏移（± 100m 范围），防止精确追踪：

```java
private static final double OFFSET = 0.001; // 约 100 米

public Point addJitter(double lng, double lat) {
    double jitterLng = (Math.random() - 0.5) * 2 * OFFSET;
    double jitterLat = (Math.random() - 0.5) * 2 * OFFSET;
    return new Point(lng + jitterLng, lat + jitterLat);
}
```

### 3.3 用户不可见设置

Redis ZSet + 可见性标记：

```java
// 用户设置不可见时，从 GEO 中移除
public void setInvisible(Long userId) {
    redisTemplate.opsForGeo().remove("users:loc", "user:" + userId);
}
```

---

## 四、附近门店查询

### 4.1 门店静态数据（不频繁变化）

门店位置不像用户位置那样频繁更新，可以在启动时全量加载到 Redis GEO：

```java
@PostConstruct
public void loadStores() {
    List<Store> stores = storeMapper.selectAll();
    stores.forEach(store ->
        redisTemplate.opsForGeo().add(
            "stores:loc",
            new Point(store.getLongitude(), store.getLatitude()),
            "store:" + store.getId()
        )
    );
}

// 查询 3km 内门店，按距离排序
public List<StoreVO> getNearbyStores(double lng, double lat, double radiusKm) {
    GeoResults<RedisGeoCommands.GeoLocation<String>> results =
        redisTemplate.opsForGeo().search("stores:loc",
            GeoReference.fromCoordinate(lng, lat),
            new Distance(radiusKm, Metrics.KILOMETERS),
            RedisGeoCommands.GeoSearchCommandArgs.newGeoSearchArgs()
                .includeDistance().limit(50).sortAscending()
        );

    List<Long> storeIds = results.getContent().stream()
        .map(r -> Long.parseLong(r.getContent().getName().replace("store:", "")))
        .collect(Collectors.toList());

    // 批量查询门店详情（Redis 缓存）
    return storeService.getBatchWithCache(storeIds);
}
```

---

## 五、打车场景——司机匹配

### 5.1 实时更新司机位置

```java
// 司机 App 每 5 秒上报一次位置
public void updateDriverLocation(Long driverId, double lng, double lat, String status) {
    // 更新 GEO（按状态分 key，只在空闲司机 key 里查）
    if ("AVAILABLE".equals(status)) {
        redisTemplate.opsForGeo().add("drivers:available", new Point(lng, lat),
            "driver:" + driverId);
    } else {
        redisTemplate.opsForGeo().remove("drivers:available", "driver:" + driverId);
    }
}

// 乘客下单，查询附近空闲司机
public List<Long> findNearbyDrivers(double lng, double lat) {
    GeoResults<RedisGeoCommands.GeoLocation<String>> results =
        redisTemplate.opsForGeo().search("drivers:available",
            GeoReference.fromCoordinate(lng, lat),
            new Distance(5, Metrics.KILOMETERS),   // 5km 范围
            RedisGeoCommands.GeoSearchCommandArgs.newGeoSearchArgs()
                .includeDistance().limit(10).sortAscending()
        );

    return results.getContent().stream()
        .map(r -> Long.parseLong(r.getContent().getName().replace("driver:", "")))
        .collect(Collectors.toList());
}
```

### 5.2 分城市分 key

全国司机不能放一个 key，按城市分片：

```java
String key = "drivers:available:" + cityCode; // 如 "drivers:available:BJ"
```

---

## 六、Geohash 原理

### 6.1 编码原理

Geohash 将经纬度空间递归二分，编码为 Base32 字符串：
- 字符串越长，精度越高
- 相同前缀的字符串代表相邻区域

| 长度 | 精度 | 误差 |
|------|------|------|
| 4 | 39km × 20km | 约 40km |
| 5 | 4.9km × 4.9km | 约 5km |
| 6 | 1.2km × 0.61km | 约 1km |
| 7 | 153m × 153m | 约 150m |
| 8 | 38m × 19m | 约 40m |

### 6.2 边界问题

Geohash 前缀相同不代表距离近，相邻格子可能前缀不同（尤其在边界）。

**解决方案**：查询时不只查当前 Geohash 格子，还查周围 8 个相邻格子，共 9 个格子的范围。

```java
// 获取某点的 Geohash 及其周围 8 个相邻格子
public List<String> getNeighborHashes(double lat, double lng, int precision) {
    GeoHash center = GeoHash.withCharacterPrecision(lat, lng, precision);
    List<String> hashes = new ArrayList<>();
    hashes.add(center.toBase32());
    Arrays.stream(center.getAdjacent()).forEach(h -> hashes.add(h.toBase32()));
    return hashes;
}
```

---

## 七、方案选型建议

| 场景 | 推荐方案 |
|------|---------|
| 附近的人（实时、高频更新） | Redis GEO |
| 附近门店（静态/低频更新） | Redis GEO 或 MySQL 空间索引 |
| 打车司机匹配（实时、高并发） | Redis GEO + 按城市分片 |
| 复杂地理围栏、路径规划 | PostGIS / 高德/百度地图 API |
| 附近搜索 + 全文检索结合 | Elasticsearch geo_point |
