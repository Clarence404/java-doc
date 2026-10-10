---
description: SMTP 与端口、IMAP / POP3、MIME 结构与编码、SPF / DKIM / DMARC、Spring 发信
---

# 邮件协议

> 前置阅读：[DNS](./4_dns)、[HTTPS 与 TLS](./3_https_tls)

应用后端和邮件打交道通常是用 SMTP 发系统通知、偶尔用 IMAP 收件，能否进收件箱一半看代码、一半看域名 DNS 配置。本篇讲 SMTP 会话、MIME 结构、SPF / DKIM / DMARC，以及在 Spring Boot 4 中发送邮件和用 Jakarta Mail 收件。

---

## 一、邮件投递链路

### 1、角色与流程

![一封邮件从发出到被读取](../assets/protocols/mail-flow.svg)

| 角色 | 全称 | 职责 |
|------|------|------|
| MUA | Mail User Agent | 写信、读信的客户端，后端应用发信时也扮演这个角色 |
| MSA | Mail Submission Agent | 接收 MUA 提交的邮件，要求认证，通常和 MTA 是同一台服务 |
| MTA | Mail Transfer Agent | 服务器之间用 SMTP 转发邮件，按收件域的 MX 记录找下一跳 |
| MDA | Mail Delivery Agent | 把邮件存进收件人的邮箱 |

### 2、协议与端口

| 协议 | 端口 | 用途 | 说明 |
|------|------|------|------|
| SMTP | 25 | 服务器之间转发 | 云厂商普遍封禁出方向 25 端口，应用不要直连收件方 |
| SMTP Submission | 587 | 客户端提交邮件 | 明文连接后用 `STARTTLS` 升级为 TLS，必须认证 |
| SMTPS | 465 | 客户端提交邮件 | 连接即 TLS（隐式 TLS），RFC 8314 推荐优先使用 |
| IMAP | 143 / 993 | 收件 | 邮件留在服务端，支持文件夹、标记、多端同步；当前版本是 IMAP4rev2（RFC 9051） |
| POP3 | 110 / 995 | 收件 | 协议只定义下载与删除；常见用法是下载后从服务端删除，也可配置在服务端保留副本 |

### 3、SMTP 会话

SMTP 是一问一答的文本协议，下面是客户端（C）与服务端（S）在 587 端口上的一次会话：

```text
S: 220 smtp.example.com ESMTP
C: EHLO app.example.com
S: 250-STARTTLS
S: 250 AUTH PLAIN LOGIN
C: STARTTLS
S: 220 Ready to start TLS
   （TLS 握手，之后重新 EHLO，再 AUTH 认证）
C: MAIL FROM:<bounce@mail.example.com>
S: 250 OK
C: RCPT TO:<alice@example.org>
S: 250 OK
C: DATA
S: 354 End data with <CR><LF>.<CR><LF>
C: From: "Example" <noreply@example.com>
C: Subject: ...
C: （空行后是正文，单独一行 "." 结束）
S: 250 Queued
C: QUIT
```

注意这里有两个「发件人」：

- **信封发件人**（`MAIL FROM`，也叫 Return-Path）：退信发往这里，SPF 校验的是它的域名
- **信头发件人**（`From:` 头）：收件人在客户端看到的发件人，DMARC 以它的域名为准

---

## 二、MIME

### 1、为什么需要 MIME

SMTP 最初只能传 7 位 ASCII 文本。MIME（RFC 2045–2049）在不改 SMTP 的前提下，用一组头部让邮件能携带中文、HTML、图片和附件：

- `Content-Type`：内容类型，如 `text/plain; charset=UTF-8`、`multipart/mixed; boundary="..."`
- `Content-Transfer-Encoding`：把二进制或 8 位内容转成可安全传输的 ASCII
- `Content-Disposition`：`inline` 内嵌显示还是 `attachment` 作为附件，附件名放在 `filename` 参数里

### 2、多段结构

| 类型 | 含义 | 典型用法 |
|------|------|---------|
| `multipart/mixed` | 多个互相独立的部分 | 正文 + 附件 |
| `multipart/alternative` | 同一内容的多种表现，客户端挑最后一个能显示的 | 纯文本版 + HTML 版 |
| `multipart/related` | 一个主体加它引用的资源 | HTML 正文 + 通过 `cid:` 引用的内嵌图片 |

一封「HTML 正文 + 纯文本备选 + 内嵌 Logo + PDF 附件」的邮件，结构是三层嵌套：

```text
Content-Type: multipart/mixed; boundary="b1"

--b1
Content-Type: multipart/related; boundary="b2"

--b2
Content-Type: multipart/alternative; boundary="b3"

--b3
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: quoted-printable

--b3
Content-Type: text/html; charset=UTF-8
Content-Transfer-Encoding: quoted-printable

--b3--
--b2
Content-Type: image/png
Content-ID: <logo>
Content-Transfer-Encoding: base64

--b2--
--b1
Content-Type: application/pdf
Content-Disposition: attachment; filename*=UTF-8''%E8%B4%A6%E5%8D%95.pdf
Content-Transfer-Encoding: base64

--b1--
```

`MimeMessageHelper` 的 `MULTIPART_MODE_MIXED_RELATED`（构造参数传 `true` 时的默认值）生成的就是这种结构。

### 3、编码

| 编码 | 用在哪 | 特点 |
|------|-------|------|
| `base64` | 正文或附件 | 每 3 字节变 4 个字符，体积增加约三分之一，适合二进制和大段中文 |
| `quoted-printable` | 正文 | ASCII 原样保留，其余字节写成 `=E4` 形式，适合以英文为主的文本 |
| `7bit` / `8bit` | 正文 | 不做转换，`8bit` 需要服务端支持 8BITMIME 扩展 |
| 编码字（RFC 2047） | `Subject`、`From` 显示名等头部 | 形如 `=?UTF-8?B?5L2g5aW9?=`，`B` 为 base64，`Q` 为类 quoted-printable |
| 参数编码（RFC 2231） | 附件文件名等头部参数 | 形如 `filename*=UTF-8''%E8%B4%A6%E5%8D%95.pdf` |

中文主题或附件名在部分客户端里显示成乱码，多半是没有指定 UTF-8 编码，或客户端只认 RFC 2047 而服务端用了 RFC 2231 写法。Jakarta Mail 的 `mail.mime.encodefilename` 属性控制附件名是否用 RFC 2047 编码，兼容老客户端时可以打开。

---

## 三、发信认证：SPF、DKIM、DMARC

### 1、三者分工

| 技术 | 回答的问题 | 原理 | DNS 记录 |
|------|-----------|------|---------|
| SPF | 这台服务器有没有资格替这个域发信 | 收件方取信封发件人的域名，查它声明的合法发信 IP 列表 | `example.com` 的 TXT：`v=spf1 include:_spf.mailer.com -all` |
| DKIM | 邮件在路上有没有被改过，签名属于哪个域 | 发件方用私钥对选定的头部和正文哈希（`bh=`）签名，写进 `DKIM-Signature` 头；收件方按 `d=` 域名和 `s=` 选择器查公钥验证 | `selector._domainkey.example.com` 的 TXT |
| DMARC | SPF、DKIM 的结果和用户看到的发件人是不是同一个域，不通过怎么办 | 要求 SPF 或 DKIM 至少有一个通过，且其域名与 `From:` 头的域名对齐；声明失败时的策略并接收汇总报告 | `_dmarc.example.com` 的 TXT：`v=DMARC1; p=quarantine; rua=mailto:...` |

### 2、对齐

只有 SPF 和 DKIM 时，攻击者可以用自己的域名通过 SPF，同时在 `From:` 头里写你的域名。DMARC 的对齐规则就是堵这个口子：

- **SPF 对齐**：`MAIL FROM` 的域名与 `From:` 的域名一致（默认宽松模式下同一组织域即可，如 `mail.example.com` 与 `example.com`）
- **DKIM 对齐**：签名里的 `d=` 域名与 `From:` 的域名一致
- **策略**：`p=none` 只收报告，`p=quarantine` 进垃圾箱，`p=reject` 直接拒收；一般从 `none` 开始，看报告确认所有合法发信源都对齐后再逐步收紧

用第三方邮件服务（SES、SendGrid 等）发信时，要按服务商文档配置自定义的退信域和 DKIM 签名域，否则 SPF、DKIM 虽然通过，却对齐的是服务商的域名，DMARC 仍然失败。

### 3、为什么三者缺一不可

Gmail 与 Yahoo 自 2024 年 2 月起对发信方提出硬性要求：所有发信方至少配置 SPF 或 DKIM；每天向 Gmail 发送 5000 封以上的批量发信方必须同时配置 SPF、DKIM、DMARC，`From:` 域名要对齐，营销类邮件要支持一键退订（RFC 8058 的 `List-Unsubscribe-Post` 头），并控制投诉率。达不到的邮件会被限流或拒收。

传输层还可以配合 MTA-STS（RFC 8461）要求服务器之间的 SMTP 必须走 TLS，防止 `STARTTLS` 被中间人剥离。

---

## 四、Spring Boot 发送邮件

### 1、依赖与配置

Spring Boot 4 的 `spring-boot-starter-mail` 基于 Jakarta Mail（包名 `jakarta.mail`，实现为 Eclipse Angus Mail），老代码里的 `javax.mail` 要改包名。

```xml
<dependency>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-mail</artifactId>
</dependency>
```

```yaml
spring:
  mail:
    host: smtp.example.com
    port: 587
    username: noreply@example.com
    password: ${MAIL_PASSWORD}        # 企业邮箱 / QQ 邮箱用授权码，不是登录密码
    default-encoding: UTF-8
    properties:
      mail.smtp.auth: true
      mail.smtp.starttls.enable: true     # 587 端口用 STARTTLS
      mail.smtp.starttls.required: true   # 服务端不支持 STARTTLS 时直接失败，不降级为明文
      mail.smtp.connectiontimeout: 5000   # 不配置时默认无限等待
      mail.smtp.timeout: 10000
      mail.smtp.writetimeout: 10000
```

用 465 端口时改为 `port: 465` 并设置 `mail.smtp.ssl.enable: true`，去掉 STARTTLS 相关配置。

### 2、发送服务

```java
// import 省略：jakarta.mail.*、org.springframework.mail.javamail.*、org.thymeleaf.*
@Service
public class EmailService {

    private static final String FROM = "noreply@example.com";

    private final JavaMailSender mailSender;
    private final ITemplateEngine templateEngine;   // Thymeleaf

    public EmailService(JavaMailSender mailSender, ITemplateEngine templateEngine) {
        this.mailSender = mailSender;
        this.templateEngine = templateEngine;
    }

    public void sendText(String to, String subject, String text) {
        SimpleMailMessage message = new SimpleMailMessage();
        message.setFrom(FROM);
        message.setTo(to);
        message.setSubject(subject);
        message.setText(text);
        mailSender.send(message);
    }

    public void sendHtml(String to, String subject, String template, Map<String, Object> vars,
                         String plainText) throws MessagingException {
        MimeMessage mime = mailSender.createMimeMessage();
        // true 表示 multipart；UTF-8 同时作用于主题、正文与附件名
        MimeMessageHelper helper = new MimeMessageHelper(mime, true, "UTF-8");
        helper.setFrom(FROM);
        helper.setTo(to);
        helper.setSubject(subject);

        String html = templateEngine.process(template, new Context(Locale.CHINA, vars));
        helper.setText(plainText, html);             // 纯文本 + HTML，生成 multipart/alternative
        helper.addInline("logo", new ClassPathResource("mail/logo.png"));   // HTML 中写 cid:logo
        mailSender.send(mime);
    }

    public void sendWithAttachment(String to, String subject, String text, Path file)
            throws MessagingException {
        MimeMessage mime = mailSender.createMimeMessage();
        MimeMessageHelper helper = new MimeMessageHelper(mime, true, "UTF-8");
        helper.setFrom(FROM);
        helper.setTo(to);
        helper.setSubject(subject);
        helper.setText(text);
        helper.addAttachment(file.getFileName().toString(), new FileSystemResource(file));
        mailSender.send(mime);
    }
}
```

`setText(plain, html)` 必须先于 `addInline` 调用，否则内嵌资源可能无法正确关联到 HTML 正文。

### 3、异步与可靠性

SMTP 一次发送要经历建连、TLS、认证、DATA 多轮往返，耗时从几百毫秒到数秒不等，不要放在请求线程里同步执行：

```java
@Service
class MailNotifier {

    private final EmailService emailService;

    MailNotifier(EmailService emailService) {
        this.emailService = emailService;
    }

    @Async("mailExecutor")   // 独立线程池，避免慢邮件占满公共线程池
    public void sendWelcome(String to) {
        emailService.sendText(to, "欢迎注册", "……");
    }
}
```

- **自调用失效**：`@Async` 靠代理生效，同一个类里的方法互相调用会绕过代理变成同步执行，所以异步方法要放在单独的 Bean 里；执行器配置见 [异步任务与定时任务](/spring-boot/9_async_schedule)
- **不丢邮件**：`@Async` 只解决不阻塞，进程重启时内存队列里的邮件会丢。注册验证、账单这类必须送达的邮件，先在业务事务里写一条待发送记录，再由消息队列或定时任务异步发送并按结果重试
- **频率**：批量发信要按服务商的速率限制做限流，被大量退信或投诉会拖累整个域名的信誉

---

## 五、IMAP 收件

```java
// import 省略：jakarta.mail.*、jakarta.mail.search.FlagTerm
public List<String> fetchUnreadSubjects(String user, String password) throws MessagingException {
    Properties props = new Properties();
    props.put("mail.imap.ssl.enable", "true");
    props.put("mail.imap.connectiontimeout", "5000");
    props.put("mail.imap.timeout", "10000");

    Session session = Session.getInstance(props);
    try (Store store = session.getStore("imap")) {           // Store 实现了 AutoCloseable
        store.connect("imap.example.com", 993, user, password);
        Folder inbox = store.getFolder("INBOX");
        inbox.open(Folder.READ_ONLY);
        try {
            Message[] unread = inbox.search(new FlagTerm(new Flags(Flags.Flag.SEEN), false));
            List<String> subjects = new ArrayList<>(unread.length);
            for (Message m : unread) {
                subjects.add(Objects.requireNonNullElse(m.getSubject(), ""));
            }
            return subjects;
        } finally {
            inbox.close(false);   // false：不删除标记为已删除的邮件
        }
    }
}
```

- **增量拉取**：不要每次都全量搜索，用 `UIDFolder` 记录处理到的最大 UID，下次只取更大的 UID
- **实时性**：轮询之外可以用 IMAP IDLE 让服务端在新邮件到达时主动通知，Spring Integration 的 Mail 模块已封装好，见 [Spring Integration](/spring/13_integration)
- **认证**：Gmail、Microsoft 365 等已逐步停用账号密码直接登录 IMAP，需要改用 OAuth 2.0（`XOAUTH2` 机制）

---

## 小结

- 应用用 587（STARTTLS）或 465（隐式 TLS）向邮件服务商提交邮件，服务器之间走 25 端口；收件用 IMAP 993，POP3 只适合单端下载
- SMTP 有信封发件人和信头发件人两个概念，SPF 看前者，DMARC 以后者为准
- MIME 用 `multipart/mixed`、`alternative`、`related` 组织附件、多版本正文和内嵌图片；头部中文用 RFC 2047 编码字，附件名用 RFC 2231 参数编码
- SPF 声明合法发信 IP，DKIM 对头部和正文哈希签名，DMARC 要求两者之一通过且与 `From:` 域名对齐；2024 年起 Gmail、Yahoo 对批量发信方强制要求三者齐全
- Spring Boot 4 用 Jakarta Mail，`MimeMessageHelper` 统一传 `"UTF-8"`；`@Async` 方法放在独立 Bean 中，必须送达的邮件先落库再异步重试

## 参考资料

- SMTP RFC 5321：[https://www.rfc-editor.org/rfc/rfc5321.html](https://www.rfc-editor.org/rfc/rfc5321.html)
- Message Submission RFC 6409：[https://www.rfc-editor.org/rfc/rfc6409.html](https://www.rfc-editor.org/rfc/rfc6409.html)
- Cleartext Considered Obsolete RFC 8314：[https://www.rfc-editor.org/rfc/rfc8314.html](https://www.rfc-editor.org/rfc/rfc8314.html)
- IMAP4rev2 RFC 9051：[https://www.rfc-editor.org/rfc/rfc9051.html](https://www.rfc-editor.org/rfc/rfc9051.html)
- POP3 RFC 1939：[https://www.rfc-editor.org/rfc/rfc1939.html](https://www.rfc-editor.org/rfc/rfc1939.html)
- MIME RFC 2045：[https://www.rfc-editor.org/rfc/rfc2045.html](https://www.rfc-editor.org/rfc/rfc2045.html)
- MIME 头部编码 RFC 2047：[https://www.rfc-editor.org/rfc/rfc2047.html](https://www.rfc-editor.org/rfc/rfc2047.html)
- SPF RFC 7208：[https://www.rfc-editor.org/rfc/rfc7208.html](https://www.rfc-editor.org/rfc/rfc7208.html)
- DKIM RFC 6376：[https://www.rfc-editor.org/rfc/rfc6376.html](https://www.rfc-editor.org/rfc/rfc6376.html)
- DMARC RFC 7489：[https://www.rfc-editor.org/rfc/rfc7489.html](https://www.rfc-editor.org/rfc/rfc7489.html)
- Google 邮件发件人指南：[https://support.google.com/a/answer/81126](https://support.google.com/a/answer/81126)
- Spring Boot Sending Email：[https://docs.spring.io/spring-boot/reference/io/email.html](https://docs.spring.io/spring-boot/reference/io/email.html)
- Jakarta Mail：[https://jakarta.ee/specifications/mail/](https://jakarta.ee/specifications/mail/)

> 下一篇：[文件协议](./8_file_protocols) —— FTP / SFTP / FTPS / SCP / NFS / SMB 对比、FTP 主动与被动模式、Java 安全接入 SFTP。
