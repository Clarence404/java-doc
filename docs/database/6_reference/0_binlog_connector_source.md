---
description: BinaryLogClient 连接流程、事件循环、checksum 与 TableMap、GTID 位点、保活重连
---

# mysql-binlog-connector-java 原理

> 前置阅读：[CDC 工具](../5_practice/0_cdc_tools)、[MySQL 主从与高可用](../1_mysql/9_topic_replication)

mysql-binlog-connector-java 在应用进程里扮演一个 MySQL 副本，**只做协议与反序列化**，不做全量快照、不解析 DDL、不维护表结构历史、不持久化位点。本篇按 osheroff 持续维护分支（坐标 `com.zendesk:mysql-binlog-connector-java`，包名仍是 `com.github.shyiko.mysql.binlog`）的当前源码，讲握手与事件循环、有状态的反序列化、GTID 位点推进与保活重连。

---

## 一、连接流程

原作者 shyiko 的仓库已归档；使用示例统一放在 [CDC 工具](../5_practice/0_cdc_tools)。

![BinaryLogClient 连接、事件循环与保活重连](../../assets/database/binlog-client-flow.svg)

`connect()` 的主干（精简）：

```java
public void connect() throws IOException {
    if (!connectLock.tryLock()) {
        throw new IllegalStateException("BinaryLogClient is already connected");
    }
    try {
        channel = openChannel();                          // TCP 连接
        GreetingPacket greeting = receiveGreeting();      // 服务器问候包：版本、认证插件、盐
        resolveDatabaseVersion(greeting);                 // 区分 MySQL / MariaDB
        tryUpgradeToSSL(greeting);                        // 按 SSLMode 升级 TLS
        new Authenticator(greeting, channel, schema, username, password).authenticate();
        setupConnection();                                // checksum、心跳周期、GTID 初始位点
        requestBinaryLogStream();                         // COM_BINLOG_DUMP 或 COM_BINLOG_DUMP_GTID
        connected = true;
        lifecycleListeners.forEach(l -> l.onConnect(this));
        if (keepAlive && !isKeepAliveThreadRunning()) {
            spawnKeepAliveThread();
        }
        listenForEventPackets();                          // 阻塞读取，直到断开
    } finally {
        connectLock.unlock();
    }
}
```

几个容易误解的点：

- `onConnect` 在 dump 请求**发出之后**才触发，此时服务器已经开始推送事件
- `connect()` 会一直阻塞在事件循环里；在 Spring 等容器中要放到独立线程，或使用 `connect(timeout)`，它在后台线程连接并等待连接成功后返回
- `setupConnection` 会查询服务器的 `binlog_checksum` 并执行 `SET @master_binlog_checksum = @@global.binlog_checksum`；设置了 `heartbeatInterval` 时还会设置 `@master_heartbeat_period`，让服务器在空闲时定期发送 HEARTBEAT 事件

### 1、两种订阅方式

| 方式 | 设置 | dump 命令 | 特点 |
|------|------|---------|------|
| 文件名 + 位置 | `setBinlogFilename` + `setBinlogPosition` | `COM_BINLOG_DUMP` | 位置只对当前服务器有效，主从切换后失效 |
| GTID | `setGtidSet(...)` | `COM_BINLOG_DUMP_GTID` | 全局唯一，切换到新的源后仍可续传 |

`setGtidSet` 传入任何非 null 值（包括空字符串）都会进入 GTID 模式；空字符串表示从最早可用的 binlog 开始。两者同时设置时默认以 GTID 为准，开启 `useBinlogFilenamePositionInGtidMode` 才会用文件位置作为起点。`setBlocking(false)` 时 dump 请求不再等待新事件，服务器发完现有 binlog 后返回 EOF 包，客户端随即完整关闭，适合一次性回放。

---

## 二、事件循环

`listenForEventPackets` 的核心逻辑（精简）：

```java
while (inputStream.peek() != -1) {
    int packetLength = inputStream.readInteger(3);
    inputStream.skip(1);                                  // 序列号
    int marker = inputStream.read();
    if (marker == 0xFF) {                                 // ERR 包：抛出 ServerException
        ErrorPacket error = new ErrorPacket(inputStream.read(packetLength - 1));
        throw new ServerException(error.getErrorMessage(), error.getErrorCode(), error.getSqlState());
    }
    if (marker == 0xFE && !blocking) {                    // 非阻塞模式下 binlog 已读完
        completeShutdown = true;
        break;
    }
    Event event;
    try {
        event = eventDeserializer.nextEvent(packetLength == MAX_PACKET_LENGTH
                ? new ByteArrayInputStream(readPacketSplitInChunks(inputStream, packetLength - 1))
                : inputStream);
    } catch (Exception e) {
        // 网络类异常（EOF、Socket）直接抛出；数据类异常通知 onEventDeserializationFailure 后跳过该事件
        ...
    }
    if (isConnected()) {
        eventLastSeen = System.currentTimeMillis();
        handleEvent(event);  // updateGtidSet → notifyEventListeners → updateClientBinlogFilenameAndPosition
    }
}
```

![MySQL 协议包格式](../../assets/database/mysql-packet-format.svg)

- **分片包**：MySQL 协议单个包最大 16MB - 1，长度等于该值说明后面还有续包，`readPacketSplitInChunks` 把它们拼成一个完整事件
- **事务压缩**：开启 `binlog_transaction_compression` 时，一个 TRANSACTION_PAYLOAD 事件里压着整个事务的事件，反序列化器解压后逐个吐出，循环会把它们依次处理完
- **反序列化失败不中断循环**：异常包装为 `EventDataDeserializationException`（携带事件头便于定位位点），通知监听器后跳过；跳过意味着丢了这条事件，生产中应在 `onEventDeserializationFailure` 里告警甚至停止消费
- **监听器同步执行**：`notifyEventListeners` 在读取线程里依次调用所有监听器，慢处理会直接拖慢读取，并让服务器端的发送缓冲堆积；重活应投递到队列
- **退出时的清理**：`completeShutdown` 为真时调用 `disconnect()` 连同保活线程一起关闭；通信异常时只关闭网络通道，保活线程仍在，会在下一个检查周期发起重连

---

## 三、反序列化中的状态

`EventDeserializer.nextEvent` 先解析 19 字节的事件头（时间戳、类型、serverId、长度、下一事件位置、标志），再按事件类型选择对应的 `EventDataDeserializer` 解析事件体。它不是无状态的：

### 1、checksum

每个 binlog 文件开头的 FORMAT_DESCRIPTION 事件声明了 checksum 算法。反序列化器据此决定后续事件末尾是否有 4 字节 CRC32 需要剥掉。漏掉这个事件，后面的事件体长度就全部错位。

### 2、TABLE_MAP 缓存

ROWS 事件（WRITE / UPDATE / DELETE_ROWS）只带 `tableId` 和按列类型编码的裸数据，列类型、长度、精度都在它前面的 TABLE_MAP 事件里。反序列化器内部按 `tableId` 缓存 TABLE_MAP，解析行数据时查表。因此：

- 从事务中间某个位置开始订阅、跳过了 TABLE_MAP，后续 ROWS 事件就无法解析
- `tableId` 不是永久不变的，表被重新打开或 DDL 后会变化，应用层缓存要以最新的 TABLE_MAP 为准

### 3、列名

行数据是按列序号排列的数组，不带列名。MySQL 8.0.1 起设置 `binlog_row_metadata=FULL` 后，TABLE_MAP 事件会附带列名、主键、有无符号、字符集等元数据，库通过 `TableMapEventData.getEventMetadata().getColumnNames()` 暴露。默认的 `MINIMAL` 下没有列名，只能去 `information_schema.columns` 查询；但这样查到的是**当前**表结构，处理积压的旧事件时如果中间发生过加列、调整列顺序的 DDL，列就会对错位置，而且查询结果被缓存后不会随 DDL 失效。能开 `FULL` 就开 `FULL`。

### 4、兼容模式

```java
EventDeserializer deserializer = new EventDeserializer();
deserializer.setCompatibilityMode(
        EventDeserializer.CompatibilityMode.DATE_AND_TIME_AS_LONG,
        EventDeserializer.CompatibilityMode.CHAR_AND_BINARY_AS_BYTE_ARRAY);
client.setEventDeserializer(deserializer);
```

- `DATE_AND_TIME_AS_LONG`：日期时间解析为毫秒数，避免默认的 `java.util.Date` 受 JVM 时区影响；注意 DATETIME 本身不带时区，会被**当作 UTC** 换算成毫秒数，应用层要按业务时区还原，TIMESTAMP 则是真正的 UTC 时间点
- `CHAR_AND_BINARY_AS_BYTE_ARRAY`：字符串列以字节数组返回，由应用按列字符集解码，避免默认按平台编码解码导致乱码
- 不关心的事件类型可以用 `setEventDataDeserializer(type, new NullEventDataDeserializer())` 跳过解析；但 GTID、XID、QUERY 参与位点推进，不要跳过

---

## 四、GTID 位点推进

`handleEvent` 先调用 `updateGtidSet`，再通知监听器，所以监听器在收到 XID 事件时，`client.getGtidSet()` 已经包含了刚提交的事务。推进规则（精简）：

```java
protected void updateGtidSet(Event event) {
    if (gtidSet == null) {
        return;                                    // 未启用 GTID 模式
    }
    switch (event.getHeader().getEventType()) {
        case GTID -> gtid = ((GtidEventData) event.getData()).getMySqlGtid();     // 暂存，不入集合
        case XID -> { commitGtid(); tx = false; }                                // DML 事务提交
        case QUERY -> commitGtid(((QueryEventData) event.getData()).getSql());
        case ANNOTATE_ROWS -> commitGtid(((AnnotateRowsEventData) event.getData()).getRowsQuery());
        case MARIADB_GTID -> gtid = event.getData().toString();                  // MariaDB 的 GTID 格式
        case MARIADB_GTID_LIST -> gtid = ((MariadbGtidListEventData) event.getData()).getMariaGTIDSet().toString();
        default -> { }
    }
}
```

`commitGtid(sql)` 对 QUERY 事件的判断是：`BEGIN` 标记事务开始；`COMMIT` / `ROLLBACK` 提交暂存的 GTID；事务之外的其他语句视为自动提交的 DDL，直接提交。

这个设计保证 **GTID 只在事务完成时计入位点**：如果在事务中途断线，重连后从该事务开头重新投递，事务不会被截断，但已处理过的前半部分会**重复投递**。文件名与位置则按每个事件头的 `nextPosition` 推进，遇到 ROTATE 事件切换文件，两套位点并行维护。

### 1、位点持久化由使用方负责

库只在内存中维护位点，进程重启后从哪里继续，完全取决于 `connect()` 前设置了什么。没有设置时，文件模式从服务器当前最新位置开始，中间的变更就丢了。正确做法是在事务边界（XID 或 DDL 对应的 QUERY）处把 `getGtidSet()` 写入外部存储，并让下游按主键或业务键幂等。完整写法见 [CDC 工具](../5_practice/0_cdc_tools) 的示例。

---

## 五、保活与断线重连

`keepAlive` 默认开启，`connect()` 成功后会拉起一个保活线程，每隔 `keepAliveInterval`（默认 1 分钟）检查一次：

```java
// 精简逻辑
while (!keepAliveThreadExecutor.isShutdown()) {
    Thread.sleep(keepAliveInterval);
    boolean connectionLost;
    if (heartbeatInterval > 0) {
        // 开了服务器心跳：超过 keepAliveInterval 没收到任何事件（包括 HEARTBEAT）就判定断线
        connectionLost = System.currentTimeMillis() - eventLastSeen > keepAliveInterval;
    } else {
        // 没开心跳：每个周期发一次 PING，写失败才判定断线
        try {
            channel.write(new PingCommand());
            connectionLost = false;
        } catch (IOException e) {
            connectionLost = true;
        }
    }
    if (connectionLost) {
        terminateConnect(useNonGracefulDisconnect);
        connect(connectTimeout);       // 失败则等下一个周期再试
    }
}
```

| 配置 | 默认值 | 说明 |
|------|------|------|
| `keepAlive` | `true` | 是否启动保活线程 |
| `keepAliveInterval` | 60000 ms | 检查周期；开启心跳时也是「多久没事件算断线」的阈值 |
| `heartbeatInterval` | 0（不开启） | 开启后服务器空闲时按此周期发 HEARTBEAT；必须**小于** `keepAliveInterval`，否则空闲的库会被误判为断线而反复重连 |
| `connectTimeout` | 3000 ms | 重连时 `connect(timeout)` 的等待时间 |
| `serverId` | 65535 | 必须在复制拓扑内唯一，见下文 |

重连用的是**内存中**最新的 GTID 集合或文件位置，所以单纯的网络闪断不会丢位点；进程重启则依赖自己持久化的位点。

### 1、serverId 冲突

每个客户端都以副本身份注册，`serverId` 必须与所有真实副本和其他 CDC 客户端都不同。默认值是 65535，同一个库上部署两个都不设置 `serverId` 的实例，服务器会让后连接的那个顶掉先连接的；两边的保活线程又会各自重连，表现为周期性的断线重连和重复投递。

---

## 小结

- 库只负责协议与反序列化：快照、DDL 解析、表结构历史、位点持久化、事务组装都要使用方自己做，或者直接用 Canal / Debezium 这类上层工具
- `connect()` 依次完成握手认证、`setupConnection`、dump 请求，然后才触发 `onConnect` 并阻塞在事件循环里
- 反序列化依赖 FORMAT_DESCRIPTION（checksum）与 TABLE_MAP（列类型）两份状态；列名需要 `binlog_row_metadata=FULL`
- GTID 在 XID、COMMIT 或自动提交的 DDL 处才计入集合，断线重连会从未完成事务的开头重放，下游必须幂等
- 保活线程开心跳时按「超时无事件」判定，未开时按 PING 失败判定；`heartbeatInterval` 要小于 `keepAliveInterval`
- `serverId` 默认 65535，多个实例必须显式设置不同的值

## 参考资料

- mysql-binlog-connector-java：[https://github.com/osheroff/mysql-binlog-connector-java](https://github.com/osheroff/mysql-binlog-connector-java)
- MySQL 源码文档：复制协议：[https://dev.mysql.com/doc/dev/mysql-server/latest/page_protocol_replication.html](https://dev.mysql.com/doc/dev/mysql-server/latest/page_protocol_replication.html)
- MySQL binlog 事件格式：[https://dev.mysql.com/doc/dev/mysql-server/latest/page_protocol_replication_binlog_event.html](https://dev.mysql.com/doc/dev/mysql-server/latest/page_protocol_replication_binlog_event.html)
- binlog_row_metadata：[https://dev.mysql.com/doc/refman/8.4/en/replication-options-binary-log.html](https://dev.mysql.com/doc/refman/8.4/en/replication-options-binary-log.html)

> 下一篇：[数据库选型参考](./1_selection_guide) —— 按场景对比关系型、分析型、搜索、时序、文档、向量等存储，给出常见组合与选型误区。
