# MariaDB

- 官网：[mariadb.com](https://mariadb.com/)
- GitHub：[MariaDB/server](https://github.com/MariaDB/server)

## 一、起源

MySQL 由瑞典 MySQL AB 公司于 1995 年创建，2008 年 Sun 公司收购，2010 年随 Sun 并入 Oracle。MySQL 创始人 **Michael "Monty" Widenius** 为避免 MySQL 走向封闭，于 2009 年从 MySQL 代码分叉出 **MariaDB**。

名字由来：MySQL 来自 Monty 大女儿 **My**，MariaDB 来自小女儿 **Maria**。

---

## 二、MariaDB vs MySQL 对比

| 对比项 | MySQL | MariaDB |
|-------|-------|---------|
| 维护方 | Oracle（商业主导）| MariaDB Foundation（开源基金会）|
| 协议兼容 | — | 兼容 MySQL 协议，大多数 MySQL 驱动可直接连接 |
| 默认存储引擎 | InnoDB | XtraDB（早期 10.x）/ InnoDB |
| 版本路线 | 5.7 → 8.0 → 8.4 LTS → 9.x | 5.5 → 10.x → 11.x |
| JSON / CTE / 窗口函数 | ✅ 8.0+ 发展较快 | ✅ 各版本陆续支持，部分语法有差异 |
| 存储引擎扩展 | 以 InnoDB 为核心 | 额外支持 MyRocks、ColumnStore 等 |
| Oracle 兼容性 | 弱 | 有限兼容（部分语法）|
| 商业版 | Oracle MySQL Enterprise | MariaDB Enterprise |

---

## 三、选型建议

- **MySQL**：生产首选，生态最成熟，Java 驱动（Connector/J）维护活跃，云托管方案丰富（RDS、Aurora）
- **MariaDB**：偏好完全开源，或已有 MariaDB 技术栈，或部分 Linux 发行版默认内置
- **迁移兼容性**：MariaDB 10.x 与 MySQL 5.7 语法高度兼容；11.x 与 MySQL 8.0 有部分差异，迁移前需逐项验证
