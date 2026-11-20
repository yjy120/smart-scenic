// 智慧景区运营管理系统 - 服务端入口
const path = require('path');
const express = require('express');
const session = require('express-session');
const { initDb } = require('./db');
const { requireLogin } = require('./routes/middleware');

const app = express();
const PORT = process.env.PORT || 3000;

// 兜底：异步路由中的意外异常只记录日志，不让整个服务进程退出
process.on('unhandledRejection', err => {
  console.error('未捕获的异步异常:', err);
});

app.use(express.json());
app.use(session({
  secret: 'YOUR_SESSION_SECRET',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 8 * 60 * 60 * 1000 }, // 8小时
}));

// 静态页面（登录页公开，主页面由前端校验会话）
app.use(express.static(path.join(__dirname, 'public')));

// API 路由
app.use('/api/auth', require('./routes/auth'));
app.use('/api/ticket-types', requireLogin, require('./routes/ticketTypes'));
app.use('/api/orders', requireLogin, require('./routes/orders'));
app.use('/api/stats', requireLogin, require('./routes/stats'));
app.use('/api/admin', requireLogin, require('./routes/admin'));

// 预留扩展接口：后期对接闸机/客流采集等硬件时在此挂载，无需重构现有模块
app.use('/api/hardware', (req, res) => {
  res.status(501).json({ error: '硬件对接接口预留，一期不启用（闸机接入后可在此扩展）' });
});
// 预留扩展接口：后期接入 AI 大模型（自然语言问数/日志摘要/文案辅助）时在此挂载
app.use('/api/ai', (req, res) => {
  res.status(501).json({ error: 'AI 大模型能力接口预留，一期不启用' });
});

// 统一错误处理
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: '服务器内部错误：' + err.message });
});

initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`智慧景区运营管理系统已启动: http://localhost:${PORT}`);
    });
  })
  .catch(err => {
    console.error('数据库初始化失败，请检查 MySQL 连接配置（db.js 或环境变量 DB_HOST/DB_USER/DB_PASSWORD）:');
    console.error(err.message);
    process.exit(1);
  });
