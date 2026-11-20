// 认证与个人中心：登录（连错5次锁定15分钟）、登出、游客注册、修改密码/手机号
const express = require('express');
const { pool, hashPassword, verifyPassword, logAction } = require('../db');

const router = express.Router();

// 登录失败锁定（UC-001）：连续错误5次锁定15分钟（内存实现，重启后清零）
const loginLocks = new Map(); // username -> { fails, lockUntil }
const MAX_FAILS = 5, LOCK_MS = 15 * 60 * 1000;

const PHONE_RE = /^1[3-9]\d{9}$/;

// 登录（三类角色统一入口）
router.post('/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: '请输入用户名和密码' });

  const lock = loginLocks.get(username);
  if (lock && lock.lockUntil > Date.now()) {
    const min = Math.ceil((lock.lockUntil - Date.now()) / 60000);
    return res.status(423).json({ error: `密码连续错误次数过多，账号已锁定，请约 ${min} 分钟后再试` });
  }

  try {
    const [rows] = await pool.query('SELECT * FROM users WHERE username = ?', [username]);
    const user = rows[0];
    if (!user || !verifyPassword(password, user.password)) {
      // 记录失败次数
      const cur = loginLocks.get(username) || { fails: 0, lockUntil: 0 };
      cur.fails += 1;
      if (cur.fails >= MAX_FAILS) {
        cur.lockUntil = Date.now() + LOCK_MS;
        cur.fails = 0;
      }
      loginLocks.set(username, cur);
      return res.status(401).json({ error: '账号或密码错误' });
    }
    if (user.status !== 1) return res.status(403).json({ error: '账号已停用，请联系系统管理员' });

    loginLocks.delete(username); // 登录成功清零
    req.session.user = {
      id: user.id, username: user.username, role: user.role,
      real_name: user.real_name, phone: user.phone, id_card: user.id_card,
    };
    await logAction(req, 'login', `用户 ${user.username}(${user.role}) 登录系统`);
    res.json({ user: req.session.user });
  } catch (e) {
    // UC-001 6a 系统异常
    console.error('登录异常:', e);
    return res.status(500).json({ error: '登录失败，请稍后重试' });
  }
});

// 游客自助注册
router.post('/register', async (req, res) => {
  const { username, password, real_name, id_card, phone } = req.body || {};
  if (!username || !password || !real_name) {
    return res.status(400).json({ error: '用户名、密码、姓名为必填项' });
  }
  if (String(password).length < 6) return res.status(400).json({ error: '密码长度至少6位' });
  if (phone && !PHONE_RE.test(phone)) return res.status(400).json({ error: '手机号格式错误' });
  if (phone) {
    const [[dup]] = await pool.query('SELECT id FROM users WHERE phone = ?', [phone]);
    if (dup) return res.status(409).json({ error: '手机号已被占用' });
  }
  try {
    const [r] = await pool.query(
      "INSERT INTO users (username, password, role, real_name, id_card, phone) VALUES (?,?, 'tourist', ?,?,?)",
      [username, hashPassword(password), real_name, id_card || null, phone || null]);
    res.json({ ok: true, id: r.insertId });
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: '用户名已存在' });
    throw e;
  }
});

router.post('/logout', async (req, res) => {
  await logAction(req, 'logout', '退出登录');
  req.session.destroy(() => res.json({ ok: true }));
});

// 当前登录人信息
router.get('/me', (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: '未登录' });
  res.json({ user: req.session.user });
});

// 修改本人手机号 / 密码（实名信息游客不可自行修改）
router.put('/profile', async (req, res) => {
  const me = req.session.user;
  const { phone, old_password, new_password } = req.body || {};
  if (new_password) {
    if (String(new_password).length < 6) return res.status(400).json({ error: '密码格式不符合要求：长度至少6位' });
    const [[u]] = await pool.query('SELECT password FROM users WHERE id = ?', [me.id]);
    if (!verifyPassword(old_password || '', u.password)) {
      return res.status(400).json({ error: '旧密码不正确' });
    }
    await pool.query('UPDATE users SET password = ? WHERE id = ?', [hashPassword(new_password), me.id]);
  }
  if (phone !== undefined && phone !== null && phone !== '') {
    if (!PHONE_RE.test(phone)) return res.status(400).json({ error: '手机号格式错误' });
    const [[dup]] = await pool.query('SELECT id FROM users WHERE phone = ? AND id <> ?', [phone, me.id]);
    if (dup) return res.status(409).json({ error: '手机号已被其他账号占用' });
  }
  if (phone !== undefined) {
    await pool.query('UPDATE users SET phone = ? WHERE id = ?', [phone || null, me.id]);
    me.phone = phone || null;
  }
  await logAction(req, 'profile_update', '修改个人资料/密码');
  res.json({ ok: true, user: me });
});

module.exports = router;
