# 文件传输协议

> 官方规范：[FTP RFC 959](https://www.rfc-editor.org/rfc/rfc959.html) / [SFTP（SSH-2 子系统）](https://datatracker.ietf.org/doc/html/draft-ietf-secsh-filexfer-13) / [NFS RFC 7530](https://www.rfc-editor.org/rfc/rfc7530.html)

---

## 一、协议对比

| 协议 | 传输层 | 加密 | 认证方式 | 防火墙友好 | 适用场景 |
|------|--------|------|---------|-----------|---------|
| **FTP** | TCP（20/21 端口）| ❌ 明文 | 用户名/密码 | ❌ 主动模式穿透难 | 内网遗留系统 |
| **SFTP** | SSH（22 端口）| ✅ SSH 加密 | 密码 / 公钥 | ✅ 单端口 | 安全文件传输首选 |
| **FTPS** | FTP + TLS | ✅ TLS 加密 | 用户名/密码 + 证书 | ❌ 多端口 | FTP 升级过渡方案 |
| **SCP** | SSH（22 端口）| ✅ SSH 加密 | 密码 / 公钥 | ✅ 单端口 | 命令行快速复制 |
| **TFTP** | UDP（69 端口）| ❌ 明文 | 无 | — | 网络设备固件升级 |
| **NFS** | TCP/UDP | 可选 Kerberos | 主机 IP | — | Unix/Linux 网络共享存储 |
| **SMB/CIFS** | TCP（445 端口）| 可选 | Windows 账号 | — | Windows 文件共享 |

**生产环境首选 SFTP**：单 SSH 端口（22），加密传输，公钥认证，无需额外组件。

---

## 二、SFTP：Java 实现（JSch）

```xml
<dependency>
    <groupId>com.github.mwiede</groupId>
    <artifactId>jsch</artifactId>
    <version>0.2.19</version>
</dependency>
```

```java
@Component
public class SftpService {

    @Value("${sftp.host}")
    private String host;
    @Value("${sftp.port:22}")
    private int port;
    @Value("${sftp.username}")
    private String username;
    @Value("${sftp.private-key-path}")
    private String privateKeyPath;

    private ChannelSftp openChannel() throws JSchException {
        JSch jsch = new JSch();
        jsch.addIdentity(privateKeyPath);          // 公钥认证，不传密码

        Session session = jsch.getSession(username, host, port);
        Properties config = new Properties();
        config.put("StrictHostKeyChecking", "no"); // 生产环境改为 ask + 添加 known_hosts
        session.setConfig(config);
        session.connect(10_000);

        Channel channel = session.openChannel("sftp");
        channel.connect(5_000);
        return (ChannelSftp) channel;
    }

    public void upload(String localPath, String remotePath) throws JSchException, SftpException {
        ChannelSftp sftp = openChannel();
        try {
            sftp.put(localPath, remotePath, ChannelSftp.OVERWRITE);
        } finally {
            sftp.exit();
            sftp.getSession().disconnect();
        }
    }

    public void download(String remotePath, String localPath) throws JSchException, SftpException {
        ChannelSftp sftp = openChannel();
        try {
            sftp.get(remotePath, localPath);
        } finally {
            sftp.exit();
            sftp.getSession().disconnect();
        }
    }

    public List<String> list(String remoteDir) throws JSchException, SftpException {
        ChannelSftp sftp = openChannel();
        try {
            return sftp.ls(remoteDir).stream()
                .map(entry -> ((ChannelSftp.LsEntry) entry).getFilename())
                .filter(name -> !name.startsWith("."))
                .collect(Collectors.toList());
        } finally {
            sftp.exit();
            sftp.getSession().disconnect();
        }
    }
}
```

### 连接池优化

每次操作都新建 SSH Session 开销较大。生产环境中可用 Apache Commons Pool 封装 ChannelSftp 连接池：

```java
// 使用 Apache Commons Pool2 管理 ChannelSftp 对象
GenericObjectPool<ChannelSftp> pool = new GenericObjectPool<>(new SftpPooledObjectFactory());
ChannelSftp channel = pool.borrowObject();
try {
    // 使用 channel
} finally {
    pool.returnObject(channel);
}
```

---

## 三、Spring Integration SFTP（自动化场景）

适合定时从 SFTP 服务器拉取文件并处理：

```xml
<dependency>
    <groupId>org.springframework.integration</groupId>
    <artifactId>spring-integration-sftp</artifactId>
</dependency>
```

```java
@Bean
public IntegrationFlow sftpInboundFlow(DefaultSftpSessionFactory sessionFactory) {
    return IntegrationFlow
        .from(Sftp.inboundAdapter(sessionFactory)
                .remoteDirectory("/data/inbox")
                .localDirectory(new File("/tmp/sftp-download"))
                .deleteRemoteFiles(true),
            e -> e.poller(Pollers.fixedDelay(Duration.ofMinutes(5))))
        .handle(message -> {
            File file = (File) message.getPayload();
            log.info("Downloaded: {}", file.getName());
            processFile(file);
        })
        .get();
}
```

---

## 四、FTP 主动模式 vs 被动模式

```
主动模式（PORT）：客户端开放随机端口，服务端主动连接 → 防火墙常阻断
被动模式（PASV）：服务端开放随机端口，客户端主动连接 → 防火墙友好
```

公网 FTP 服务端必须配置被动模式端口范围（如 50000-51000）并在防火墙开放。这是 FTP 被 SFTP 取代的主要原因之一。
