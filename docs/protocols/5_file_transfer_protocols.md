# 文件传输协议

这些协议用于跨设备传输文件或数据流。

## 官方规范入口

| 协议 | 官方 / 原始规范 |
|------|----------------|
| FTP | [RFC 959](https://www.rfc-editor.org/rfc/rfc959.html) |
| SFTP / SSH | [SSH Architecture RFC 4251](https://www.rfc-editor.org/rfc/rfc4251.html) |
| TFTP | [RFC 1350](https://www.rfc-editor.org/rfc/rfc1350.html) |
| NFSv4 | [RFC 8881](https://www.rfc-editor.org/rfc/rfc8881.html) |
| SMB | [Microsoft MS-SMB2](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-smb2/) |

- **FTP（File Transfer Protocol）**：标准文件传输协议，使用 TCP 进行文件传输。
- **SFTP（SSH File Transfer Protocol）**：基于 SSH 加密的 FTP 传输方式，安全性更高。
- **TFTP（Trivial File Transfer Protocol）**：简化版 FTP，适用于网络设备固件升级等轻量级文件传输。
- **NFS（Network File System）**：网络文件系统协议，支持远程文件共享（Linux/Unix）。
- **SMB（Server Message Block）**：Windows 网络文件共享协议（如 Samba）。
