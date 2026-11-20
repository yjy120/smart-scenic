// 管理员功能：账号管理、操作日志、景区基础信息维护
const express = require('express');
const { pool, hashPassword, logAction } = require('../db');
const { requireRole, requireLogin } = require('./middleware');

const router = express.Router();

const PHONE_RE = /^1[3-9]\d{9}$/;
const USERNAME_RE = /^[\u4e00-\u9fa5A-Za-z0-9_]{2,50}$/; // 禁止非法特殊字符

// ============ 景区基础信息（所有登录用户可读，首页展示）============
router.get('/scenic', requireLogin, async (req, res) => {
  const [[info]] = await pool.query('SELECT * FROM scenic_info ORDER BY id LIMIT 1');
  res.json({ info: info || {} });
});

router.put('/scenic', requireRole('admin'), async (req, res) => {
  const { intro, policy, notice, ticket_desc } = req.body || {};
  // UC-022 异常流：全部内容为空拒绝保存；单项超长拒绝保存
  if (![intro, policy, notice, ticket_desc].some(t => t && String(t).trim())) {
    return res.status(400).json({ error: '内容不能为空：至少填写一项再保存发布' });
  }
  for (const [k, v] of Object.entries({ 景区介绍: intro, 优待政策: policy, 游玩须知: notice, 票种说明: ticket_desc })) {
    if (v && String(v).length > 5000) return res.status(400).json({ error: `${k}内容超长，请删减至5000字以内` });
  }
  const [[info]] = await pool.query('SELECT id FROM scenic_info ORDER BY id LIMIT 1');
  if (info) {
    await pool.query('UPDATE scenic_info SET intro=?, policy=?, notice=?, ticket_desc=? WHERE id=?',
      [intro || '', policy || '', notice || '', ticket_desc || '', info.id]);
  } else {
    await pool.query('INSERT INTO scenic_info (intro, policy, notice, ticket_desc) VALUES (?,?,?,?)',
      [intro || '', policy || '', notice || '', ticket_desc || '']);
  }
  await logAction(req, 'scenic_update', '更新景区基础信息并发布到首页');
  res.json({ ok: true });
});

// ============ 账号管理（仅超级管理员）============
// 系统内置超级管理员（首个 admin 账号）受保护：禁删除、禁停用、禁改角色与用户名
async function getBuiltinAdminId() {
  const [[u]] = await pool.query("SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1");
  return u ? u.id : null;
}

router.get('/users', requireRole('admin'), async (req, res) => {
  const { keyword, role } = req.query;
  const where = []; const params = [];
  if (role) { where.push('role = ?'); params.push(role); }
  if (keyword) {
    where.push('(username LIKE ? OR real_name LIKE ? OR phone LIKE ?)');
    const k = `%${keyword}%`; params.push(k, k, k);
  }
  const [rows] = await pool.query(
    `SELECT id, username, role, real_name, id_card, phone, status, created_at
     FROM users ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id`, params);
  const builtinId = await getBuiltinAdminId();
  res.json({ list: rows.map(u => ({ ...u, is_builtin: u.id === builtinId })) });
});

router.post('/users', requireRole('admin'), async (req, res) => {
  const { username, password, role, real_name, id_card, phone } = req.body || {};
  if (!username || !password || !role) return res.status(400).json({ error: '用户名、密码、角色为必填项' });
  if (!['admin', 'seller', 'tourist'].includes(role)) return res.status(400).json({ error: '必须分配合法角色' });
  if (!USERNAME_RE.test(username)) return res.status(400).json({ error: '账号名称包含非法特殊字符' });
  if (String(password).length < 6) return res.status(400).json({ error: '密码格式不符合要求：长度至少6位' });
  if (phone && !PHONE_RE.test(phone)) return res.status(400).json({ error: '手机号格式错误' });
  try {
    const [r] = await pool.query(
      'INSERT INTO users (username, password, role, real_name, id_card, phone) VALUES (?,?,?,?,?,?)',
      [username, hashPassword(password), role, real_name || null, id_card || null, phone || null]);
    await logAction(req, 'user_add', `新增账号 ${username}(${role})`);
    res.json({ ok: true, id: r.insertId });
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: '账号已存在' });
    throw e;
  }
});

router.put('/users/:id', requireRole('admin'), async (req, res) => {
  const { role, real_name, id_card, phone, password } = req.body || {};
  const [[u]] = await pool.query('SELECT * FROM users WHERE id = ?', [req.params.id]);
  if (!u) return res.status(404).json({ error: '账号不存在' });
  const builtinId = await getBuiltinAdminId();
  if (u.id === builtinId && role && role !== 'admin') {
    return res.status(400).json({ error: '内置超级管理员为系统关键配置，禁止修改角色' });
  }
  if (role && !['admin', 'seller', 'tourist'].includes(role)) return res.status(400).json({ error: '角色不合法' });
  if (phone && !PHONE_RE.test(phone)) return res.status(400).json({ error: '手机号格式错误' });
  await pool.query('UPDATE users SET role=?, real_name=?, id_card=?, phone=? WHERE id=?',
    [role || u.role, real_name ?? u.real_name, id_card ?? u.id_card, phone ?? u.phone, u.id]);
  if (password) {
    if (String(password).length < 6) return res.status(400).json({ error: '密码格式不符合要求：长度至少6位' });
    await pool.query('UPDATE users SET password=? WHERE id=?', [hashPassword(password), u.id]);
  }
  await logAction(req, 'user_update', `编辑账号 ${u.username}${password ? '（重置密码）' : ''}`);
  res.json({ ok: true });
});

// 停用/启用（内置超级管理员禁止停用）
router.post('/users/:id/toggle', requireRole('admin'), async (req, res) => {
  const [[u]] = await pool.query('SELECT * FROM users WHERE id = ?', [req.params.id]);
  if (!u) return res.status(404).json({ error: '账号不存在' });
  if (Number(req.params.id) === req.session.user.id) {
    return res.status(400).json({ error: '不能停用当前登录账号' });
  }
  const builtinId = await getBuiltinAdminId();
  if (u.id === builtinId) return res.status(400).json({ error: '系统内置超级管理员账号禁止停用' });
  await pool.query('UPDATE users SET status = 1 - status WHERE id = ?', [u.id]);
  await logAction(req, 'user_toggle', `切换账号 ${u.username} 启用状态`);
  res.json({ ok: true });
});

// 删除账号（UC-004）：内置超管禁止删除；存在历史业务记录需二次确认（?force=1）
router.delete('/users/:id', requireRole('admin'), async (req, res) => {
  const [[u]] = await pool.query('SELECT * FROM users WHERE id = ?', [req.params.id]);
  if (!u) return res.status(404).json({ error: '账号不存在' });
  if (Number(req.params.id) === req.session.user.id) {
    return res.status(400).json({ error: '不能删除当前登录账号' });
  }
  const builtinId = await getBuiltinAdminId();
  if (u.id === builtinId) return res.status(400).json({ error: '系统内置超级管理员账号禁止删除' });

  if (req.query.force !== '1') {
    const [[{ c }]] = await pool.query(
      `SELECT COUNT(*) AS c FROM orders
       WHERE operator_id = ? OR enter_operator_id = ? OR exit_operator_id = ? OR refund_operator_id = ? OR tourist_user_id = ?`,
      [u.id, u.id, u.id, u.id, u.id]);
    if (c > 0) {
      return res.status(409).json({
        error: `该账号存在 ${c} 条历史业务操作记录，删除后其历史记录将无法追溯操作人，确认仍要删除吗？`,
        has_history: true, history_count: c,
      });
    }
  }
  await pool.query('DELETE FROM users WHERE id = ?', [u.id]);
  await logAction(req, 'user_delete', `删除账号 ${u.username}`);
  res.json({ ok: true });
});

// ============ 操作日志（仅超级管理员；支持时间/操作员/操作类型筛选，UC-021）============
router.get('/logs', requireRole('admin'), async (req, res) => {
  const { start, end, action, operator, keyword, page = 1, size = 30 } = req.query;
  if (start && end && start > end) {
    return res.status(400).json({ error: '时间参数错误：开始时间不能晚于结束时间' });
  }
  const where = []; const params = [];
  if (start) { where.push('created_at >= ?'); params.push(start + ' 00:00:00'); }
  if (end) { where.push('created_at <= ?'); params.push(end + ' 23:59:59'); }
  if (action) { where.push('action = ?'); params.push(action); }
  if (operator) { where.push('username = ?'); params.push(operator); }
  if (keyword) { where.push('detail LIKE ?'); params.push(`%${keyword}%`); }
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM operation_logs ${whereSql}`, params);
  const [rows] = await pool.query(
    `SELECT * FROM operation_logs ${whereSql} ORDER BY id DESC LIMIT ? OFFSET ?`,
    [...params, Number(size), (Number(page) - 1) * Number(size)]);
  const [actions] = await pool.query('SELECT DISTINCT action FROM operation_logs ORDER BY action');
  const [operators] = await pool.query(
    "SELECT DISTINCT username FROM operation_logs WHERE username IS NOT NULL ORDER BY username");
  res.json({ list: rows, total, actions: actions.map(a => a.action), operators: operators.map(o => o.username) });
});

module.exports = router;
