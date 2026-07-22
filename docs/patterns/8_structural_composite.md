# 组合模式

**作用**：将对象组合成**树形结构**，使客户端能以统一方式处理单个对象和组合对象（叶子和容器用相同接口）。

**应用场景**：
- 文件系统（文件是叶子，目录是容器，都实现"获取大小"接口）
- 菜单树（菜单项和子菜单统一处理）
- 部门组织架构（员工和部门都能"计算薪资总额"）
- Spring Security `AuthorizationManager`（单个规则和规则组合统一调用）

---

## 一、实现示例

以「权限菜单树」为例：

```java
// 统一接口
public interface MenuItem {
    String getName();
    void print(String indent);
    List<MenuItem> getChildren();
}

// 叶子节点：具体菜单项
public class MenuLeaf implements MenuItem {
    private final String name;
    private final String url;

    public MenuLeaf(String name, String url) {
        this.name = name;
        this.url  = url;
    }

    @Override
    public String getName() { return name; }

    @Override
    public void print(String indent) {
        System.out.println(indent + "- " + name + " [" + url + "]");
    }

    @Override
    public List<MenuItem> getChildren() { return Collections.emptyList(); }
}

// 容器节点：子菜单
public class MenuGroup implements MenuItem {
    private final String name;
    private final List<MenuItem> children = new ArrayList<>();

    public MenuGroup(String name) { this.name = name; }

    public void add(MenuItem item)    { children.add(item); }
    public void remove(MenuItem item) { children.remove(item); }

    @Override
    public String getName() { return name; }

    @Override
    public void print(String indent) {
        System.out.println(indent + "+ " + name);
        children.forEach(c -> c.print(indent + "  "));
    }

    @Override
    public List<MenuItem> getChildren() { return children; }
}

// 构建树
MenuGroup root   = new MenuGroup("系统管理");
MenuGroup user   = new MenuGroup("用户管理");
user.add(new MenuLeaf("用户列表", "/user/list"));
user.add(new MenuLeaf("新增用户", "/user/add"));

MenuGroup role = new MenuGroup("角色管理");
role.add(new MenuLeaf("角色列表", "/role/list"));

root.add(user);
root.add(role);
root.add(new MenuLeaf("系统日志", "/log"));

root.print("");
```

输出：
```
+ 系统管理
  + 用户管理
    - 用户列表 [/user/list]
    - 新增用户 [/user/add]
  + 角色管理
    - 角色列表 [/role/list]
  - 系统日志 [/log]
```

---

## 二、关键特征

- **透明性**：叶子和容器实现相同接口，客户端无需区分
- **统一操作**：遍历、查找、权限判断等操作可递归统一处理
- **常配合递归**：数据库存树形结构（`parent_id`），查询后构建内存树
