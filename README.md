# 智慧景区运营管理系统

> Smart Scenic Area Management System · 基于 Express + MySQL 的前后端一体景区运营平台（纯 PC 端）

| Node.js | Express | MySQL | express-session | ECharts |
|---|---|---|---|---|

## 一、项目概述

面向中小型景区的运营管理需求，构建一套覆盖「**票务管理 → 入园核验 → 退换票 → 数据统计 → 账号与景区信息管理**」的 B/S 系统。系统服务三类角色——**超级管理员（admin）/ 售票员（seller）/ 游客（tourist）**，通过严格的权限矩阵实现数据隔离与操作边界，替代人工台账与 Excel 统计。

**项目规模**：5 张数据表、32 个 RESTful 接口、6 个路由模块、22+ 业务用例，配套完整需求/用例/功能文档。

## 二、核心功能

### 游客（tourist）

- 自助注册、登录，连续错误 5 次锁定 15 分钟
- 修改本人手机号/密码（实名信息不可自行修改）
- 自主购票、查看本人订单、对**未入园**订单发起退票申请

### 售票员（seller）

- **窗口售票**：录入实名信息，自动生成/关联游客账号（身份证号/手机号为用户名，证件后 6 位为初始密码）
- **入园/出园登记**：订单查询、核验登记
- **退票/换票**：退票审核（驳回时恢复原状态并记录原因）、直接退票（含已入园订单人工处理）、换票
- **个人日结**：仅统计本人售票、登记、退票业务
- 订单查询严格限定为**本人操作生成**的订单

### 超级管理员（admin）

- **全局票务**：订单多条件查询（可按售票员筛选），但**不具备窗口售票与入园/退票审核能力**（权限最小化）
- **数据统计**：全局日结、时间段售票统计、出入园人次、操作员业绩、客流热力图（天 × 小时）、CSV 报表导出
- **账号管理**：创建/编辑/停用/删除账号；系统内置首个 admin 受保护（禁删、禁停用、禁改角色与用户名）；删除有业务记录的账号需二次确认
- **操作日志**：按时间/操作员/操作类型筛选，全程留痕
- **景区信息维护**：首页展示信息配置，含空值/超长校验

## 三、技术架构

```
浏览器（原生 HTML/CSS/JS + ECharts）
        │  HTTP / JSON
        ▼
Express 服务 (server.js)
  ├─ express-session      # 会话管理（8 小时），登录态校验
  ├─ 路由中间件            # requireLogin / requireRole 权限拦截
  ├─ routes/              # auth / orders / stats / admin / ticketTypes
  ├─ db.js                # mysql2 连接池 + 自动建库建表 + 种子数据
  └─ MySQL                # users / ticket_types / orders / operation_logs / scenic_info
```

预留扩展接口：`/api/hardware`（闸机/客流硬件）、`/api/ai`（大模型能力），一期返回 501，后期可平滑接入而不重构现有模块。

**技术选型**

- **后端**：Node.js、Express 4、express-session、mysql2/promise（连接池）
- **前端**：原生 HTML/CSS/JavaScript、ECharts（统计图表）
- **安全**：scrypt 密码散列 + `timingSafeEqual` 恒定时间比较、会话校验、角色中间件
- **数据**：MySQL 5.7+，5 张表，启动时自动初始化 schema 与种子数据

## 四、技术亮点

**1. 细粒度权限矩阵（RBAC + 操作边界）**
以 `requireLogin` / `requireRole('seller')` 等中间件在路由层拦截，权限设计遵循**最小必要原则**：售票员只能看自己生成的订单；管理员统计全局但**不能**做窗口售票、入园登记、退票审核等业务操作；游客只能操作本人未入园订单。同类系统常把 admin 设为"全能"，此处刻意做了职责分离。

**2. scrypt 密码散列 + 恒定时间比较**
`db.js` 用 Node 内置 `crypto.scryptSync` 加随机 salt 存储密码（`salt:hash` 格式），校验用 `crypto.timingSafeEqual` 避免时序侧信道攻击，**无额外依赖**即实现安全密码存储。

**3. 自动建库与种子数据**
`initDb()` 在启动时自动执行 `CREATE TABLE IF NOT EXISTS` 并灌入种子数据，配置全部可通过环境变量覆盖（`DB_HOST / DB_PORT / DB_USER / DB_PASSWORD / DB_NAME`），开箱即用、便于部署。

**4. 规则型智能提示与业务校验**
购票时校验实名信息完整性、票种单日售票上限（`daily_limit`）；窗口售票自动创建游客账号；退票按入园状态分流；内置超管保护与"有业务记录需 `?force=1` 二次确认"的删除机制，覆盖多条异常流。

**5. 多维度统计与 CSV 导出**
`stats` 路由提供日结（个人/全局）、时间段售票、出入园人次、操作员业绩、天×小时客流热力图，支持按售票员筛选；`GET /api/stats/export` 导出 CSV 报表，无数据时返回空白模板。

**6. 进程稳定性兜底**
`server.js` 监听 `unhandledRejection`，异步路由异常只记录日志而不让服务进程退出；统一错误处理中间件返回规范 JSON。

## 五、目录结构

```
smart-scenic/
├── server.js               # 服务入口：会话、路由挂载、错误处理、启动初始化
├── db.js                   # 连接池、建表、种子数据、密码散列工具
├── routes/
│   ├── middleware.js       # requireLogin / requireRole
│   ├── auth.js             # 登录/注册/登出/个人中心（5 接口）
│   ├── ticketTypes.js      # 票种管理（4 接口）
│   ├── orders.js           # 购票/查询/入园出园/退换票（9 接口）
│   ├── stats.js            # 统计与报表导出（6 接口）
│   └── admin.js            # 账号/日志/景区信息（8 接口）
├── public/                 # 前端页面（登录页、主页、css、js）
├── smoke-test.js           # 端到端冒烟测试
└── 文档（.docx）            # 产品文档、功能角色、用例、领域开发等
```

## 六、快速开始

**环境要求**：Node.js 16+、MySQL 5.7+

**1. 配置数据库**

设置环境变量（或按 `db.js` 本地配置）：

```bash
export DB_HOST=localhost DB_PORT=3306 DB_USER=root DB_PASSWORD=your_password DB_NAME=smart_scenic
```

启动时会自动建库、建表并写入种子数据。

**2. 安装依赖并启动**

```bash
npm install
npm start
```

访问 `http://localhost:3000`（可用 `PORT` 环境变量覆盖）。

**3. 冒烟测试**

```bash
node smoke-test.js
```

> 演示账号密码与 session secret 已从代码中移除，请以占位符或环境变量方式注入后再运行；部署公开环境务必修改默认口令。

## 七、说明

本项目为课程实践作品，配套产品文档、功能角色说明、用例文档等见仓库根目录。所有敏感配置已清理，请以占位符或本地配置方式注入后再运行。
