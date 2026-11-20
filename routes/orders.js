// 订单：购票（游客自主/售票员窗口开单）、查询、入园/出园登记（仅售票员）、退票/换票（仅售票员）
const express = require('express');
const crypto = require('crypto');
const { pool, hashPassword, logAction } = require('../db');
const { requireRole } = require('./middleware');

const router = express.Router();

const STATUS_CN = {
  pending: '待核验', unused: '未入园', entered: '已入园',
  exited: '已出园', refunding: '待退票审核', refunded: '已退票',
};

function genNo(prefix) {
  return prefix + Date.now().toString(36).toUpperCase() + crypto.randomBytes(3).toString('hex').toUpperCase();
}

// UC-008 后置条件：窗口售票录入实名信息自动生成游客账号（以身份证号/手机号为用户名，证件后6位为初始密码）
async function upsertTouristByRealName(conn, v) {
  const username = v.id_card || v.phone;
  if (!username) return null;
  const [[exist]] = await conn.query('SELECT id FROM users WHERE username = ?', [username]);
  if (exist) return exist.id;
  const rawPwd = (v.id_card || v.phone || '').slice(-6);
  const initPwd = rawPwd.length >= 6 ? rawPwd : 'YOUR_DB_PASSWORD';
  const [r] = await conn.query(
    "INSERT INTO users (username, password, role, real_name, id_card, phone) VALUES (?,?, 'tourist', ?,?,?)",
    [username, hashPassword(initPwd), v.name, v.id_card || null, v.phone || null]);
  return r.insertId;
}

// ============ 购票：游客自主购票 / 售票员窗口开单（UC-008/009）============
router.post('/purchase', async (req, res) => {
  const me = req.session.user;
  // 权限矩阵：窗口开单售票仅售票员拥有，超级管理员无窗口售票能力
  if (me.role === 'admin') {
    return res.status(403).json({ error: '超级管理员无窗口开单售票权限，购票由售票员窗口开单或游客自主下单' });
  }
  const isWindow = me.role === 'seller';
  const { ticket_type_id, visitors } = req.body || {};
  if (!ticket_type_id || !Array.isArray(visitors) || visitors.length === 0) {
    return res.status(400).json({ error: '请选择票种并填写游客信息' });
  }
  if (visitors.length > 10) return res.status(400).json({ error: '单次最多购买10张' });
  for (const v of visitors) {
    if (!v.name || !String(v.name).trim()) return res.status(400).json({ error: '每位游客均需填写姓名' });
    if (!Number.isInteger(Number(visitors.length)) || visitors.length <= 0) {
      return res.status(400).json({ error: '购票数量必须大于 0' });
    }
  }

  const [[tt]] = await pool.query('SELECT * FROM ticket_types WHERE id = ? AND status = 1', [ticket_type_id]);
  if (!tt) return res.status(404).json({ error: '票种不存在或已停用，无法选择' });

  // UC-008/009 6b：实名票实名信息为空禁止提交
  if (tt.need_real_name) {
    for (const v of visitors) {
      if (!v.id_card || !String(v.id_card).trim()) {
        return res.status(400).json({ error: `「${tt.name}」为实名票，每位游客的实名信息（身份证号）不能为空` });
      }
    }
  }

  // 规则型智能提示2：单日售票上限校验，达到上限禁止下单
  let remaining = null;
  if (tt.daily_limit > 0) {
    const [[{ c }]] = await pool.query(
      "SELECT COUNT(*) AS c FROM orders WHERE ticket_type_id = ? AND DATE(created_at) = CURDATE() AND status <> 'refunded'",
      [tt.id]);
    remaining = tt.daily_limit - c;
    if (visitors.length > remaining) {
      return res.status(400).json({
        error: `售罄预警：「${tt.name}」今日剩余可售 ${Math.max(0, remaining)} 张，无法购买 ${visitors.length} 张`,
        remaining_today: Math.max(0, remaining),
      });
    }
  }

  const batchNo = genNo('B');
  const initStatus = (tt.need_real_name || tt.cert_tip) ? 'pending' : 'unused';
  const orderNos = [];
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    for (const v of visitors) {
      // 窗口售票：录入实名信息自动生成/关联游客账号；游客自主购票：绑定本人账号
      const touristId = isWindow ? await upsertTouristByRealName(conn, v) : me.id;
      const orderNo = genNo('D');
      orderNos.push(orderNo);
      await conn.query(
        `INSERT INTO orders (order_no, batch_no, ticket_type_id, ticket_name, price,
          tourist_user_id, visitor_name, visitor_id_card, visitor_phone, source, operator_id, status)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        [orderNo, batchNo, tt.id, tt.name, tt.price,
          touristId, v.name.trim(), v.id_card || null, v.phone || null,
          isWindow ? 'window' : 'online', isWindow ? me.id : null, initStatus]);
    }
    await conn.commit();
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }

  await logAction(req, isWindow ? 'window_purchase' : 'purchase',
    `${isWindow ? '窗口售票' : '游客自主购票'}「${tt.name}」x${visitors.length}，金额 ¥${(tt.price * visitors.length).toFixed(2)}，订单号：${orderNos.join(',')}`);
  res.json({
    ok: true, order_nos: orderNos, total: (tt.price * visitors.length).toFixed(2),
    remaining_today: remaining === null ? null : remaining - visitors.length,
  });
});

// ============ 订单多条件查询（UC-012，按角色隔离数据范围）============
router.get('/', async (req, res) => {
  const me = req.session.user;
  const { start, end, ticket_type_id, status, keyword, operator_id, page = 1, size = 20 } = req.query;
  if (start && end && start > end) {
    return res.status(400).json({ error: '时间范围错误：开始时间不能晚于结束时间' });
  }
  const where = [];
  const params = [];

  if (me.role === 'tourist') {
    where.push('o.tourist_user_id = ?'); params.push(me.id);
  } else if (me.role === 'seller') {
    // 售票员仅查看自己账号操作生成的订单（售票/入园/出园/退票）
    where.push('(o.operator_id = ? OR o.enter_operator_id = ? OR o.exit_operator_id = ? OR o.refund_operator_id = ?)');
    params.push(me.id, me.id, me.id, me.id);
  } else if (operator_id) {
    // 超级管理员：可按售票员账号筛选订单
    where.push('o.operator_id = ?'); params.push(operator_id);
  }
  if (start) { where.push('o.created_at >= ?'); params.push(start + ' 00:00:00'); }
  if (end) { where.push('o.created_at <= ?'); params.push(end + ' 23:59:59'); }
  if (ticket_type_id) { where.push('o.ticket_type_id = ?'); params.push(ticket_type_id); }
  if (status) { where.push('o.status = ?'); params.push(status); }
  if (keyword) {
    where.push('(o.order_no LIKE ? OR o.visitor_name LIKE ? OR o.visitor_phone LIKE ?)');
    const k = `%${keyword}%`; params.push(k, k, k);
  }
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';

  const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM orders o ${whereSql}`, params);
  const [rows] = await pool.query(
    `SELECT o.*, t.cert_tip,
       op.username AS operator_name, op.real_name AS operator_real_name,
       ep.username AS enter_operator_name, xp.username AS exit_operator_name,
       rp.username AS refund_operator_name, tu.username AS tourist_username
     FROM orders o
     LEFT JOIN ticket_types t ON t.id = o.ticket_type_id
     LEFT JOIN users op ON op.id = o.operator_id
     LEFT JOIN users ep ON ep.id = o.enter_operator_id
     LEFT JOIN users xp ON xp.id = o.exit_operator_id
     LEFT JOIN users rp ON rp.id = o.refund_operator_id
     LEFT JOIN users tu ON tu.id = o.tourist_user_id
     ${whereSql} ORDER BY o.id DESC LIMIT ? OFFSET ?`,
    [...params, Number(size), (Number(page) - 1) * Number(size)]);
  res.json({ list: rows.map(o => ({ ...o, status_cn: STATUS_CN[o.status] })), total });
});

// ============ 登记查询（仅售票员，入园/出园登记用）============
router.get('/lookup', requireRole('seller'), async (req, res) => {
  const { keyword } = req.query;
  if (!keyword) return res.json({ list: [] });
  const k = `%${keyword}%`;
  const [rows] = await pool.query(
    `SELECT o.id, o.order_no, o.ticket_name, o.price, o.visitor_name, o.visitor_id_card,
            o.visitor_phone, o.status, o.created_at, o.enter_time, o.exit_time, t.cert_tip
     FROM orders o LEFT JOIN ticket_types t ON t.id = o.ticket_type_id
     WHERE o.order_no LIKE ? OR o.visitor_name LIKE ? OR o.visitor_phone LIKE ?
     ORDER BY o.id DESC LIMIT 20`, [k, k, k]);
  res.json({ list: rows.map(o => ({ ...o, status_cn: STATUS_CN[o.status] })) });
});

// ============ 入园登记（仅售票员；管理员只可查看结果）============
router.post('/:id/enter', requireRole('seller'), async (req, res) => {
  const [[o]] = await pool.query('SELECT * FROM orders WHERE id = ?', [req.params.id]);
  if (!o) return res.status(404).json({ error: '未查询到订单' });
  if (['entered', 'exited'].includes(o.status)) {
    return res.status(400).json({ error: o.status === 'entered' ? '不可重复入园登记' : '游客已出园，禁止入园登记' });
  }
  if (o.status === 'refunded') return res.status(400).json({ error: '退票订单不能执行入园登记' });
  if (!['pending', 'unused'].includes(o.status)) {
    return res.status(400).json({ error: `当前状态为「${STATUS_CN[o.status]}」，不能登记入园` });
  }
  await pool.query(
    "UPDATE orders SET status = 'entered', enter_time = NOW(), enter_operator_id = ? WHERE id = ?",
    [req.session.user.id, o.id]);
  await logAction(req, 'enter', `入园登记：订单 ${o.order_no}（${o.visitor_name}）标记已入园，绑定售票员 ${req.session.user.username}`);
  res.json({ ok: true });
});

// ============ 出园登记（仅售票员；管理员只可查看结果）============
router.post('/:id/exit', requireRole('seller'), async (req, res) => {
  const [[o]] = await pool.query('SELECT * FROM orders WHERE id = ?', [req.params.id]);
  if (!o) return res.status(404).json({ error: '无匹配订单' });
  if (o.status === 'refunded') return res.status(400).json({ error: '退票订单不能执行出园登记' });
  if (!['entered'].includes(o.status)) {
    return res.status(400).json({
      error: o.status === 'exited' ? '禁止重复出园登记' : '该订单未做入园登记，禁止登记出园',
    });
  }
  await pool.query(
    "UPDATE orders SET status = 'exited', exit_time = NOW(), exit_operator_id = ? WHERE id = ?",
    [req.session.user.id, o.id]);
  await logAction(req, 'exit', `出园登记：订单 ${o.order_no}（${o.visitor_name}）标记已出园，绑定售票员 ${req.session.user.username}`);
  res.json({ ok: true });
});

// ============ 游客退票申请（仅本人未入园订单，UC-013）============
router.post('/:id/refund-apply', requireRole('tourist'), async (req, res) => {
  const { reason } = req.body || {};
  const [[o]] = await pool.query('SELECT * FROM orders WHERE id = ?', [req.params.id]);
  if (!o) return res.status(404).json({ error: '订单不存在' });
  if (o.tourist_user_id !== req.session.user.id) return res.status(403).json({ error: '只能操作本人订单' });
  if (o.status === 'entered' || o.status === 'exited') {
    return res.status(400).json({ error: '已入园订单不允许提交退票申请，请联系售票员人工处理' });
  }
  if (o.status === 'refunded') return res.status(400).json({ error: '订单已退票，不支持退票申请' });
  if (!['pending', 'unused'].includes(o.status)) {
    return res.status(400).json({ error: `订单状态为「${STATUS_CN[o.status]}」，不支持退票申请` });
  }
  await pool.query("UPDATE orders SET status = 'refunding', refund_reason = ? WHERE id = ?",
    [reason || '游客自主申请退票', o.id]);
  await logAction(req, 'refund_apply', `游客退票申请：订单 ${o.order_no}，申请理由：${reason || '未填写'}（待售票员审核）`);
  res.json({ ok: true });
});

// ============ 退票审核（仅售票员；管理员不能审核，UC-014/015）============
router.post('/:id/refund-review', requireRole('seller'), async (req, res) => {
  const { approve, reason } = req.body || {};
  const [[o]] = await pool.query('SELECT * FROM orders WHERE id = ?', [req.params.id]);
  if (!o) return res.status(404).json({ error: '订单不存在' });
  if (o.status !== 'refunding') return res.status(400).json({ error: '该订单已处理完毕或状态已变更，无法审核' });
  if (approve) {
    if (!reason) return res.status(400).json({ error: '请填写退票实际原因' });
    await pool.query(
      "UPDATE orders SET status = 'refunded', refund_time = NOW(), refund_reason = ?, refund_operator_id = ? WHERE id = ?",
      [reason, req.session.user.id, o.id]);
    await logAction(req, 'refund_review',
      `退票审核同意：订单 ${o.order_no}，游客申请理由「${o.refund_reason || ''}」，退票实际原因「${reason}」，绑定售票员 ${req.session.user.username}`);
  } else {
    if (!reason) return res.status(400).json({ error: '请填写拒绝退票原因' });
    // 驳回：恢复原有未入园状态（按票种实名要求回到待核验/未入园），拒绝原因记录于操作日志
    const [[tt]] = await pool.query('SELECT need_real_name, cert_tip FROM ticket_types WHERE id = ?', [o.ticket_type_id]);
    const restore = tt && (tt.need_real_name || tt.cert_tip) ? 'pending' : 'unused';
    await pool.query("UPDATE orders SET status = ?, refund_reason = NULL WHERE id = ?", [restore, o.id]);
    await logAction(req, 'refund_review',
      `退票审核驳回：订单 ${o.order_no}，拒绝原因「${reason}」，订单恢复「${restore === 'pending' ? '待核验' : '未入园'}」状态，绑定售票员 ${req.session.user.username}`);
  }
  res.json({ ok: true });
});

// ============ 直接退票（仅售票员，UC-014，含已入园订单人工处理）============
router.post('/:id/refund', requireRole('seller'), async (req, res) => {
  const { reason } = req.body || {};
  if (!reason) return res.status(400).json({ error: '请登记退票原因' });
  const [[o]] = await pool.query('SELECT * FROM orders WHERE id = ?', [req.params.id]);
  if (!o) return res.status(404).json({ error: '订单不存在' });
  if (!['pending', 'unused', 'entered'].includes(o.status)) {
    return res.status(400).json({ error: `当前状态为「${STATUS_CN[o.status]}」，不能退票` });
  }
  await pool.query(
    "UPDATE orders SET status = 'refunded', refund_time = NOW(), refund_reason = ?, refund_operator_id = ? WHERE id = ?",
    [reason, req.session.user.id, o.id]);
  await logAction(req, 'refund',
    `退票：订单 ${o.order_no}（${o.visitor_name}）¥${o.price}，原因：${reason}，绑定售票员 ${req.session.user.username}`);
  res.json({ ok: true });
});

// ============ 换票（仅售票员，UC-016）============
router.post('/:id/exchange', requireRole('seller'), async (req, res) => {
  const { new_ticket_type_id, reason } = req.body || {};
  const [[o]] = await pool.query('SELECT * FROM orders WHERE id = ?', [req.params.id]);
  if (!o) return res.status(404).json({ error: '订单不存在' });
  if (['entered', 'exited', 'refunded'].includes(o.status)) {
    return res.status(400).json({ error: '订单已入园/已出园/已退票，禁止执行换票操作' });
  }
  if (!['pending', 'unused'].includes(o.status)) {
    return res.status(400).json({ error: `当前状态为「${STATUS_CN[o.status]}」，不能换票` });
  }
  const [[tt]] = await pool.query('SELECT * FROM ticket_types WHERE id = ? AND status = 1', [new_ticket_type_id]);
  if (!tt) return res.status(400).json({ error: '目标票种已停用，无法换票' });
  const newStatus = (tt.need_real_name || tt.cert_tip) ? 'pending' : 'unused';
  await pool.query('UPDATE orders SET ticket_type_id = ?, ticket_name = ?, price = ?, status = ? WHERE id = ?',
    [tt.id, tt.name, tt.price, newStatus, o.id]);
  await logAction(req, 'exchange',
    `换票：订单 ${o.order_no} 由「${o.ticket_name}」换为「${tt.name}」（¥${o.price}→¥${tt.price}）${reason ? '，原因：' + reason : ''}，绑定售票员 ${req.session.user.username}`);
  res.json({ ok: true });
});

module.exports = router;
