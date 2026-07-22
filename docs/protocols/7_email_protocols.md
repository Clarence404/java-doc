# 邮件协议

> 官方规范：[SMTP RFC 5321](https://www.rfc-editor.org/rfc/rfc5321.html) / [IMAP RFC 9051](https://www.rfc-editor.org/rfc/rfc9051.html) / [MIME RFC 2045](https://www.rfc-editor.org/rfc/rfc2045.html)

---

## 一、邮件协议概览

```
发件人 → MUA（邮件客户端）──SMTP──► MTA（发送邮件服务器）
                                            │
                                    DNS MX 解析目标域
                                            │
                                   ──SMTP──► MTA（收件邮件服务器）
                                            │
收件人 ← MUA（邮件客户端）◄─POP3/IMAP─ 邮件存储服务器
```

| 协议 | 端口 | 职责 | 特点 |
|------|------|------|------|
| **SMTP** | 25（服务器间）/ 587（提交）/ 465（SMTPS）| 邮件发送 | 推送模式，单向发送 |
| **IMAP** | 143 / 993（TLS）| 邮件收取 | 服务端存储，多端同步，支持文件夹 |
| **POP3** | 110 / 995（TLS）| 邮件收取 | 下载到本地后从服务端删除，不支持多端 |

**实际工程**：应用后端用 SMTP 发送系统通知邮件；如需收件解析（如邮件工单系统），用 IMAP 轮询收件箱。

---

## 二、Spring Boot 发送邮件

```xml
<dependency>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-mail</artifactId>
</dependency>
```

```yaml
spring:
  mail:
    host: smtp.qq.com          # 或 smtp.163.com / smtp.gmail.com
    port: 587
    username: your@qq.com
    password: ${MAIL_PASSWORD}  # QQ 邮箱用授权码，不是登录密码
    default-encoding: UTF-8
    properties:
      mail.smtp.auth: true
      mail.smtp.starttls.enable: true    # 587 端口使用 STARTTLS
      mail.smtp.starttls.required: true
      mail.smtp.connectiontimeout: 10000
      mail.smtp.timeout: 10000
```

### 简单文本邮件

```java
@Service
public class EmailService {

    private final JavaMailSender mailSender;
    private final TemplateEngine templateEngine;  // Thymeleaf

    public void sendSimple(String to, String subject, String text) {
        SimpleMailMessage message = new SimpleMailMessage();
        message.setFrom("noreply@yourapp.com");
        message.setTo(to);
        message.setSubject(subject);
        message.setText(text);
        mailSender.send(message);
    }

    public void sendHtml(String to, String subject, String templateName,
                         Map<String, Object> variables) throws MessagingException {
        MimeMessage mimeMessage = mailSender.createMimeMessage();
        MimeMessageHelper helper = new MimeMessageHelper(mimeMessage, true, "UTF-8");
        helper.setFrom("noreply@yourapp.com");
        helper.setTo(to);
        helper.setSubject(subject);

        // Thymeleaf 模板渲染
        Context context = new Context();
        context.setVariables(variables);
        String html = templateEngine.process(templateName, context);
        helper.setText(html, true);

        mailSender.send(mimeMessage);
    }

    public void sendWithAttachment(String to, String subject, String text,
                                   File attachment) throws MessagingException {
        MimeMessage mimeMessage = mailSender.createMimeMessage();
        MimeMessageHelper helper = new MimeMessageHelper(mimeMessage, true);
        helper.setTo(to);
        helper.setSubject(subject);
        helper.setText(text);
        helper.addAttachment(attachment.getName(), attachment);
        mailSender.send(mimeMessage);
    }
}
```

### 异步发送（避免阻塞主线程）

```java
@Async
public CompletableFuture<Void> sendAsync(String to, String subject, String text) {
    sendSimple(to, subject, text);
    return CompletableFuture.completedFuture(null);
}
```

---

## 三、IMAP 收件（JavaMail API）

```java
public List<String> fetchUnreadEmails() throws MessagingException {
    Properties props = new Properties();
    props.put("mail.imap.host", "imap.qq.com");
    props.put("mail.imap.port", "993");
    props.put("mail.imap.ssl.enable", "true");

    Session session = Session.getInstance(props);
    Store store = session.getStore("imap");
    store.connect("imap.qq.com", "your@qq.com", password);

    Folder inbox = store.getFolder("INBOX");
    inbox.open(Folder.READ_ONLY);

    Message[] messages = inbox.search(new FlagTerm(new Flags(Flags.Flag.SEEN), false));
    List<String> subjects = Arrays.stream(messages)
        .map(m -> {
            try { return m.getSubject(); }
            catch (MessagingException e) { return ""; }
        })
        .collect(Collectors.toList());

    inbox.close(false);
    store.close();
    return subjects;
}
```

---

## 四、邮件安全

| 技术 | 用途 | 原理 |
|------|------|------|
| **SPF** | 防止域名被伪造发送 | DNS TXT 记录声明允许发送该域邮件的 IP 段 |
| **DKIM** | 防止邮件内容被篡改 | 发件方用私钥签名邮件头，收件方用 DNS 中的公钥验证 |
| **DMARC** | 综合 SPF + DKIM，声明失败时的处理策略 | DNS TXT 记录，可配置 `none`/`quarantine`/`reject` |
| **TLS（STARTTLS）** | 传输层加密 | SMTP 连接升级为 TLS，防止中间人窃听 |

生产环境发送重要邮件（账号注册、密码重置），SPF + DKIM + DMARC 三者缺一不可，否则会被主流邮件服务商当作垃圾邮件。
