---
description: 文件协议对比、FTP 主动与被动模式、JSch 安全接入 SFTP、Spring Integration
---

# 文件协议

> **本篇目标**：分清常见文件传输与文件共享协议的安全性和适用场景，理解 FTP 主动、被动模式为什么难过防火墙，能用 JSch 写出校验主机公钥、不泄漏连接的 SFTP 客户端，并用 Spring Integration 实现定时拉取文件。
>
> **前置阅读**：[TCP 与 UDP](./1_tcp_udp)、[HTTPS 与 TLS](./3_https_tls)

后端碰到文件协议，多数是和银行、物流、政务等外部系统做批量文件交换（对账单、订单文件），或者挂载共享存储。系统内部的文件存取优先用对象存储（S3 / MinIO），见 [对象存储](/architecture/4_object_storage)，本篇讲的是对接外部系统时绕不开的那些协议。

---

## 一、协议对比

### 1、文件传输类

| 协议 | 传输 | 加密 | 认证 | 防火墙友好度 | 现状 |
|------|------|------|------|-------------|------|
| FTP | TCP 21 控制 + 独立数据连接 | 无，口令明文 | 用户名 + 口令 | 差，需要额外开放数据端口 | 仅剩内网遗留系统 |
| FTPS | FTP + TLS；显式模式在 21 端口用 `AUTH TLS` 升级，隐式模式用 990 端口 | TLS | 口令，可加客户端证书 | 差，数据连接加密后防火墙无法解析端口 | FTP 的过渡升级方案 |
| SFTP | SSH 子系统，TCP 22 | SSH | 口令或公钥 | 好，单端口 | 文件交换首选 |
| SCP | 基于 SSH，TCP 22 | SSH | 口令或公钥 | 好，单端口 | OpenSSH 9.0 起 `scp` 命令默认改用 SFTP 协议传输，旧 SCP 协议需加 `-O`，已不推荐 |
| TFTP | UDP 69 | 无 | 无 | — | 只用于 PXE 网络启动、网络设备固件升级等受控内网 |

SFTP 名字里有 FTP，但与 FTP 毫无关系，是 SSH 协议上的一个子系统；FTPS 才是「FTP + TLS」。对接方说「SFTP」时最好确认一下是哪一种。

### 2、文件共享类

| 协议 | 传输 | 认证与加密 | 适用场景 |
|------|------|-----------|---------|
| NFS | NFSv4 只用 TCP 2049 端口；v3 还要依赖 rpcbind 等辅助服务 | 默认 `AUTH_SYS`：客户端自报 UID / GID，服务端按导出规则限制来源主机，本质上信任客户端；需要强认证时用 Kerberos（`sec=krb5` / `krb5i` / `krb5p`，`krb5p` 才加密传输） | Linux 服务器之间共享目录、Kubernetes 的 NFS 持久卷 |
| SMB | TCP 445 | 域账号或本地账号认证；SMB 3.x 支持传输加密 | Windows 文件共享，Linux 侧用 Samba |

- **NFS 版本**：NFSv4.0 是 RFC 7530，v4.1（RFC 8881）引入会话与 pNFS，v4.2（RFC 7862）增加服务端拷贝、稀疏文件等能力；新部署直接用 v4.1 及以上
- **SMB 版本**：CIFS 就是早已过时的 SMB1，存在 WannaCry 利用过的严重漏洞，服务端和客户端都应禁用，只保留 SMB 2 / 3

---

## 二、FTP 主动模式与被动模式

FTP 用两条 TCP 连接：控制连接（客户端 → 服务端 21 端口）传命令，每次传文件或列目录再另开一条数据连接。两种模式的区别在于数据连接由谁发起：

![FTP 主动模式与被动模式](../assets/protocols/ftp-modes.svg)

| 模式 | 数据连接 | 问题 |
|------|---------|------|
| 主动（PORT） | 客户端用 `PORT` 告诉服务端自己的 IP 和端口，服务端从 20 端口连回来 | 客户端在 NAT 或防火墙后面时，入站连接会被拦截 |
| 被动（PASV / EPSV） | 服务端用 `PASV` 返回一个随机端口，客户端主动去连 | 服务端要开放一段端口范围；服务端在 NAT 后时还要配置对外地址，否则返回的是内网 IP |

公网 FTP 服务端一般配置被动模式端口范围（如 50000–51000）并在防火墙放行。启用 FTPS 后控制连接被加密，防火墙的 FTP 协议辅助模块读不到 `PASV` 返回的端口，只能整段放行，这也是 FTP 系列逐步被 SFTP 取代的原因之一。

---

## 三、Java 接入 SFTP：JSch

### 1、依赖

原版 JSch（`com.jcraft:jsch`）已多年不维护，不支持新的密钥算法；使用社区维护的分支 `com.github.mwiede:jsch`，包名不变，可直接替换。

```xml
<dependency>
    <groupId>com.github.mwiede</groupId>
    <artifactId>jsch</artifactId>
    <version>2.28.7</version>
</dependency>
```

### 2、主机公钥校验

SSH 的安全前提是客户端确认「连上的确实是那台服务器」。网上大量示例写 `StrictHostKeyChecking=no`，等于接受任何服务器公钥，中间人可以冒充对端拿到上传的文件；改成 `ask` 也不行，服务端程序没有人来回答确认提示。正确做法：

1. 首次对接时用 `ssh-keyscan -t ed25519 sftp.partner.com` 取到对方公钥，并通过电话、邮件等其他渠道与对方核对指纹
2. 写进应用专用的 `known_hosts` 文件，随配置下发
3. 代码里用 `setKnownHosts` 加载该文件，并设置 `StrictHostKeyChecking=yes`，公钥不匹配直接拒绝连接

对方更换主机密钥时要提前通知，同步更新 `known_hosts`。

### 3、客户端代码

```java
// import 省略：com.jcraft.jsch.*、Spring Boot 配置相关注解
@ConfigurationProperties("sftp")
public record SftpProperties(String host,
                             @DefaultValue("22") int port,
                             String username,
                             String privateKeyPath,
                             String knownHostsPath) {}

@Component
public class SftpService {

    private final SftpProperties props;

    public SftpService(SftpProperties props) {   // 需要 @ConfigurationPropertiesScan 或 @EnableConfigurationProperties
        this.props = props;
    }

    /** 同时持有 Session 和 Channel，关闭时一起释放。 */
    record SftpConnection(Session session, ChannelSftp channel) implements AutoCloseable {
        @Override
        public void close() {
            channel.disconnect();
            session.disconnect();
        }
    }

    private SftpConnection open() throws JSchException {
        JSch jsch = new JSch();
        jsch.setKnownHosts(props.knownHostsPath());   // 预先核对过指纹的服务端公钥
        jsch.addIdentity(props.privateKeyPath());     // 公钥认证，不在配置里放口令

        Session session = jsch.getSession(props.username(), props.host(), props.port());
        session.setConfig("StrictHostKeyChecking", "yes");
        try {
            session.connect(10_000);
            ChannelSftp channel = (ChannelSftp) session.openChannel("sftp");
            channel.connect(5_000);
            return new SftpConnection(session, channel);
        } catch (JSchException e) {
            session.disconnect();   // Channel 建立失败时也要释放 Session，否则连接泄漏
            throw e;
        }
    }

    /** 先传临时文件再改名，对方轮询时不会读到传了一半的文件。 */
    public void upload(Path local, String remote) throws JSchException, SftpException {
        try (SftpConnection c = open()) {
            String tmp = remote + ".part";
            c.channel().put(local.toString(), tmp, ChannelSftp.OVERWRITE);
            c.channel().rename(tmp, remote);
        }
    }

    public void download(String remote, Path local) throws JSchException, SftpException {
        try (SftpConnection c = open()) {
            c.channel().get(remote, local.toString());
        }
    }

    public List<String> list(String remoteDir) throws JSchException, SftpException {
        try (SftpConnection c = open()) {
            List<String> names = new ArrayList<>();
            c.channel().ls(remoteDir, entry -> {
                String name = entry.getFilename();
                if (!name.startsWith(".") && !entry.getAttrs().isDir()) {
                    names.add(name);
                }
                return ChannelSftp.LsEntrySelector.CONTINUE;
            });
            return names;
        }
    }
}
```

- **改名的坑**：SFTP v3 的 `rename` 在目标已存在时，很多服务端会直接失败；需要覆盖时先删除目标，或确认服务端支持 `posix-rename` 扩展
- **连接复用**：每次操作都新建 SSH 会话要多花一次 TCP 握手、密钥交换和认证；调用频繁时不要自己用对象池封装 `ChannelSftp`，直接用下面 Spring Integration 自带的会话缓存

---

## 四、Spring Integration SFTP

定时从对方 SFTP 拉取文件并处理，是 Spring Integration 的典型场景。6.0 起它的 SFTP 支持从 JSch 换成了 Apache MINA SSHD，远程文件类型为 `SftpClient.DirEntry`。

```xml
<dependency>
    <groupId>org.springframework.integration</groupId>
    <artifactId>spring-integration-sftp</artifactId>
</dependency>
```

```java
// import 省略；SftpClient 为 org.apache.sshd.sftp.client.SftpClient
@Configuration(proxyBeanMethods = false)
class SftpInboundConfig {

    @Bean
    SessionFactory<SftpClient.DirEntry> sftpSessionFactory(SftpProperties props) {
        DefaultSftpSessionFactory factory = new DefaultSftpSessionFactory(true);
        factory.setHost(props.host());
        factory.setPort(props.port());
        factory.setUser(props.username());
        factory.setPrivateKey(new FileSystemResource(props.privateKeyPath()));
        factory.setKnownHostsResource(new FileSystemResource(props.knownHostsPath()));
        // allowUnknownKeys 默认 false：未知或变更的主机公钥直接拒绝，不要改成 true
        return new CachingSessionFactory<>(factory, 10);   // 会话缓存，最多 10 个
    }

    @Bean
    IntegrationFlow sftpInboundFlow(SessionFactory<SftpClient.DirEntry> sessionFactory,
                                    StatementFileProcessor processor) {
        return IntegrationFlow
                .from(Sftp.inboundAdapter(sessionFactory)
                                .remoteDirectory("/data/outbox")
                                .patternFilter("*.csv")
                                .localDirectory(new File("/var/app/sftp-inbox"))
                                .deleteRemoteFiles(false),
                        e -> e.poller(Pollers.fixedDelay(Duration.ofMinutes(5))))
                .handle(File.class, (file, headers) -> {
                    processor.process(file);   // 业务处理，需幂等
                    return null;               // 返回 null 表示流程到此结束
                })
                .get();
    }
}
```

- **防重复处理**：入站适配器默认用内存里的「只接受一次」过滤器记录已拉取的文件，应用重启后记录丢失，可能重复拉取；多实例部署或要求重启不重复时，换成基于 Redis、JDBC 的共享 `MetadataStore`，业务处理本身也要按文件名或文件内容做幂等
- **上传**：反方向用 `Sftp.outboundAdapter`，它默认先写 `.writing` 后缀的临时文件再改名，和上面手写的做法一致

---

## 小结

- 对外文件交换首选 SFTP：单 22 端口、SSH 加密、公钥认证；FTP 明文且难过防火墙，FTPS 只是过渡方案
- SFTP 是 SSH 子系统，FTPS 才是 FTP + TLS；OpenSSH 9.0 起 `scp` 命令默认也走 SFTP 协议
- NFS 默认 `AUTH_SYS` 信任客户端自报的 UID，只适合可信内网；SMB 禁用 SMB1（CIFS），使用 SMB 3.x
- FTP 主动模式由服务端连回客户端，被动模式由客户端连服务端的随机端口，公网场景只能用被动模式
- JSch 用 `com.github.mwiede` 维护分支；必须加载 `known_hosts` 并开启 `StrictHostKeyChecking=yes`，Channel 建立失败时也要释放 Session
- Spring Integration 6 起 SFTP 基于 Apache MINA SSHD，用 `CachingSessionFactory` 复用会话，多实例部署要换共享的 `MetadataStore` 防止重复处理

## 参考资料

- FTP RFC 959：[https://www.rfc-editor.org/rfc/rfc959.html](https://www.rfc-editor.org/rfc/rfc959.html)
- Securing FTP with TLS（FTPS）RFC 4217：[https://www.rfc-editor.org/rfc/rfc4217.html](https://www.rfc-editor.org/rfc/rfc4217.html)
- SSH File Transfer Protocol draft：[https://datatracker.ietf.org/doc/html/draft-ietf-secsh-filexfer-02](https://datatracker.ietf.org/doc/html/draft-ietf-secsh-filexfer-02)
- OpenSSH 9.0 Release Notes：[https://www.openssh.com/txt/release-9.0](https://www.openssh.com/txt/release-9.0)
- NFSv4.0 RFC 7530：[https://www.rfc-editor.org/rfc/rfc7530.html](https://www.rfc-editor.org/rfc/rfc7530.html)
- NFSv4.1 RFC 8881：[https://www.rfc-editor.org/rfc/rfc8881.html](https://www.rfc-editor.org/rfc/rfc8881.html)
- NFSv4.2 RFC 7862：[https://www.rfc-editor.org/rfc/rfc7862.html](https://www.rfc-editor.org/rfc/rfc7862.html)
- mwiede/jsch：[https://github.com/mwiede/jsch](https://github.com/mwiede/jsch)
- Spring Integration SFTP：[https://docs.spring.io/spring-integration/reference/sftp.html](https://docs.spring.io/spring-integration/reference/sftp.html)

> 返回：[网络协议总览](./0_overview)
