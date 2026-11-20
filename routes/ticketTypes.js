// 票种管理（仅超级管理员可写）+ 售票查询（含当日已售/剩余，用于售罄预警规则提示）
const express = require('express');
const { pool, logAction } = require('../db');
const { requireRole } = require('./middleware');

const router = express.Router();

// 列表：管理员可见全部（票种管理用）；售票员/游客仅见启用票种（停用票种不可选）
// 附带今日已售/剩余数量（规则型智能提示数据）
router.get('/', async (req, res) => {
  const isAdmin = req.session.user.role === 'admin';
  const [rows] = await pool.query(`
    SELECT t.*,
      (SELECT COUNT(*) FROM orders o
        WHERE o.ticket_type_id = t.id AND DATE(o.created_at) = CURDATE() AND o.status <> 'refunded'
      ) AS sold_today
    FROM ticket_types t ${isAdmin ? '' : 'WHERE t.status = 1'}
    ORDER BY t.id`);
  const list = rows.map(t => ({
    ...t,
    remaining_today: t.daily_limit > 0 ? Math.max(0, t.daily_limit - t.sold_today) : null, // null=不限量
  }));
  res.json({ list });
});

// 票种参数校验（UC-005/006 异常流）：票价>0、上限非负、名称唯一、有效期起止合法
async function validateTicket(req, res, excludeId) {
  const { name, price, valid_start, valid_end, daily_limit } = req.body || {};
  if (!name || price === undefined || price === '') { res.status(400).json({ error: '票种名称和票价为必填项' }); return null; }
  const p = Number(price);
  if (!(p > 0)) { res.status(400).json({ error: '票价必须大于 0' }); return null; }
  const limit = Number(daily_limit) || 0;
  if (limit < 0) { res.status(400).json({ error: '单日售票上限不能为负数' }); return null; }
  if (valid_start && valid_end && valid_start > valid_end) {
    res.status(400).json({ error: '有效期开始时间不能晚于结束时间' }); return null;
  }
  const dupSql = excludeId
    ? 'SELECT id FROM ticket_types WHERE name = ? AND id <> ?'
    : 'SELECT id FROM ticket_types WHERE name = ?';
  const [[dup]] = await pool.query(dupSql, excludeId ? [name, excludeId] : [name]);
  if (dup) { res.status(409).json({ error: '票种名称已存在' }); return null; }
  return {
    name, price: p, valid_start: valid_start || null, valid_end: valid_end || null,
    need_real_name: req.body.need_real_name ? 1 : 0,
    cert_tip: (req.body.cert_tip || '').trim() || null, daily_limit: limit,
  };
}

// 新增票种
router.post('/', requireRole('admin'), async (req, res) => {
  const data = await validateTicket(req, res);
  if (!data) return;
  const [r] = await pool.query(
    'INSERT INTO ticket_types (name, price, valid_start, valid_end, need_real_name, cert_tip, daily_limit) VALUES (?,?,?,?,?,?,?)',
    [data.name, data.price, data.valid_start, data.valid_end, data.need_real_name, data.cert_tip, data.daily_limit]);
  await logAction(req, 'ticket_type_add', `新增票种「${data.name}」票价 ¥${data.price}`);
  res.json({ ok: true, id: r.insertId });
});

// 编辑票种
router.put('/:id', requireRole('admin'), async (req, res) => {
  const data = await validateTicket(req, res, req.params.id);
  if (!data) return;
  await pool.query(
    'UPDATE ticket_types SET name=?, price=?, valid_start=?, valid_end=?, need_real_name=?, cert_tip=?, daily_limit=? WHERE id=?',
    [data.name, data.price, data.valid_start, data.valid_end, data.need_real_name, data.cert_tip, data.daily_limit, req.params.id]);
  await logAction(req, 'ticket_type_update', `编辑票种#${req.params.id}「${data.name}」`);
  res.json({ ok: true });
});

// 停用/启用（UC-007）
router.post('/:id/toggle', requireRole('admin'), async (req, res) => {
  const [[t]] = await pool.query('SELECT * FROM ticket_types WHERE id = ?', [req.params.id]);
  if (!t) return res.status(404).json({ error: '票种不存在' });
  await pool.query('UPDATE ticket_types SET status = 1 - status WHERE id = ?', [t.id]);
  await logAction(req, 'ticket_type_toggle', `${t.status === 1 ? '停用' : '启用'}票种「${t.name}」`);
  res.json({ ok: true });
});

module.exports = router;
