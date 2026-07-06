# MariaDB

- 官网地址：[MariaDB](https://mariadb.com/)
- Github：[MariaDB](https://github.com/MariaDB/server)

## 🔹 起源

* **MySQL** 是瑞典公司 MySQL AB 在 1995 年发布的关系型数据库。
* 2008 年 Sun 公司收购 MySQL AB，后来 Sun 被 Oracle 收购，所以 MySQL 落到了 **Oracle** 手里。
* 为了避免 MySQL 以后被 Oracle 封闭或改变，**MySQL 的创始人 Michael “Monty” Widenius** 在 2009 年从 MySQL 源码分支出 *
  *MariaDB**。

MariaDB 的名字来自 Monty 的小女儿 **Maria**，而 MySQL 来自他的大女儿 **My**。

---

## 🔹 联系与兼容性

1. **代码基因相同**

    * MariaDB 最初就是从 MySQL **完全 fork** 出来的。
    * 前几个大版本（5.x ~ 10.x 初期）和 MySQL 语法、协议、工具几乎 100% 兼容。

2. **协议兼容**

    * MariaDB 和 MySQL 使用的 **通信协议相同**，所以大多数 MySQL 驱动（如 JDBC、Python 的 PyMySQL、PHP 的 PDO）都能直接连
      MariaDB。

3. **存储引擎**

    * 两者都支持 InnoDB（MariaDB 里叫 XtraDB/Aria 等扩展）。
    * MariaDB 新增了一些引擎（ColumnStore、MyRocks），而 MySQL 保持 InnoDB 为核心。

4. **功能差异**

    * MySQL 在 **JSON、CTE、窗口函数** 等功能上发展较快（尤其 8.0）。
    * MariaDB 在 **插件式存储引擎、开源工具链** 方面更开放。

5. **社区与商业化**

    * MySQL 由 **Oracle 主导**（社区版 + 商业版）。
    * MariaDB 由 **MariaDB Foundation** 维护，开源路线更纯粹，同时也有企业版。

---

## 🔹 总结一句话

> **MariaDB 是 MySQL 的“开源分支兄弟”，起源相同，协议兼容，但在 Oracle 和开源基金会的不同路线下逐渐分化。**

---

👌 明白，你可能是要个 **MariaDB vs MySQL 的简洁对比表**。我给你整理一个核心对照表：

| 对比项    | **MySQL**                     | **MariaDB**                            |
|--------|-------------------------------|----------------------------------------|
| 起源     | 1995 年，MySQL AB 开发，后归属 Oracle | 2009 年从 MySQL Fork，由创始人 Monty 主导       |
| 组织     | Oracle 公司主导，闭源功能较多            | MariaDB Foundation 主导，完全开源             |
| 协议兼容   | 是（与 MariaDB 互通）               | 是（与 MySQL 互通）                          |
| 默认存储引擎 | InnoDB                        | XtraDB（早期）、Aria（后期）、也支持 InnoDB         |
| 特性     | JSON 类型、窗口函数、CTE、GIS、强大的企业支持  | 更多存储引擎（MyRocks、ColumnStore）、更快的复制、多源复制 |
| 版本演进   | 8.0 是核心版本（弃用 5.x 跳到 8.0）      | 版本号走自己的路线（5.5 → 10.x → 11.x）           |
| 社区生态   | 驱动、工具成熟度高                     | 保持兼容，驱动多数可直接用                          |
| 商业化    | 社区版 + 商业版（企业功能付费）             | 社区完全开源 + MariaDB 企业版                   |

👉 简单一句话：

* **想要稳定、生态丰富 → 用 MySQL（尤其 8.0）**
* **想要开源自由、更多实验性功能 → 用 MariaDB**
