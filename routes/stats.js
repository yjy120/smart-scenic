// 数据统计：日结汇总（个人/全局）、时间段统计、操作员业绩、客流热力图、报表导出(CSV)
const express = require('express');
const { pool } = require('../db');
const { requireRole } = require('./middleware');

const router = express.Router();

// 实时在园人数（全局口径，仅管理员使用）
async function currentInPark() {
  const [[{ c }]] = await pool.query("SELECT COUNT(*) AS c FROM orders WHERE status = 'entered'");
  return c;
}

// ============ 日结汇总（UC-017）
// 售票员：仅本人基础日结（自己窗口售票、自己标记入园出园、自己处理退票）
// 超级管理员：全局完整日结，支持 ?operator_id= 筛选单个售票员；游客无权限
router.get('/daily', requireRole('admin', 'seller'), async (req, res) => {
  const me = req.session.user;
  const { date, start, end, operator_id } = req.query;

  // 支持单日(date)或时间段(start+end)
  let timeWhere, timeParams;
  if (start && end) {
    if (start > end) return res.status(400).json({ error: '时间范围错误：开始时间不能晚于结束时间' });
    timeWhere = 'BETWEEN ? AND ?'; timeParams = [start + ' 00:00:00', end + ' 23:59:59'];
  } else {
    const d = date || new Date().toLocaleDateString('sv');
    timeWhere = 'BETWEEN ? AND ?'; timeParams = [d + ' 00:00:00', d + ' 23:59:59'];
  }

  // 数据范围：售票员强制本人；管理员全局或筛选指定售票员
  let op = null;
  if (me.role === 'seller') op = me.id;
  else if (operator_id) op = Number(operator_id);
  const opAnd = op ? ' AND operator_id = ?' : '';
  const enterAnd = op ? ' AND enter_operator_id = ?' : '';
  const exitAnd = op ? ' AND exit_operator_id = ?' : '';
  const refundAnd = op ? ' AND refund_operator_id = ?' : '';
  const p = op ? [op] : [];

  const [[sales]] = await pool.query(
    `SELECT COUNT(*) AS cnt, IFNULL(SUM(price),0) AS amount FROM orders
     WHERE source = 'window' AND created_at ${timeWhere} AND status <> 'refunded'${opAnd}`,
    [...timeParams, ...p]);
  const [[online]] = await pool.query(
    `SELECT COUNT(*) AS cnt, IFNULL(SUM(price),0) AS amount FROM orders
     WHERE source = 'online' AND created_at ${timeWhere} AND status <> 'refunded'`,
    timeParams);
  const [[enter]] = await pool.query(
    `SELECT COUNT(*) AS c FROM orders WHERE enter_time ${timeWhere}${enterAnd}`, [...timeParams, ...p]);
  const [[exit_]] = await pool.query(
    `SELECT COUNT(*) AS c FROM orders WHERE exit_time ${timeWhere}${exitAnd}`, [...timeParams, ...p]);
  const [[refund]] = await pool.query(
    `SELECT COUNT(*) AS cnt, IFNULL(SUM(price),0) AS amount FROM orders
     WHERE status = 'refunded' AND refund_time ${timeWhere}${refundAnd}`, [...timeParams, ...p]);

  const inPark = op
    ? (await pool.query(
        'SELECT COUNT(*) AS c FROM orders WHERE status = \'entered\' AND enter_operator_id = ?', [op]))[0][0].c
    : await currentInPark();

  res.json({
    scope: op ? (me.role === 'seller' ? 'self' : 'operator') : 'global',
    date: date || null, start: start || null, end: end || null,
    sale_count: sales.cnt, sale_amount: Number(sales.amount),
    online_count: online.cnt, online_amount: Number(online.amount),
    enter_count: enter.c, exit_count: exit_.c,
    in_park: inPark,
    refund_count: refund.cnt, refund_amount: Number(refund.amount),
  });
});

// ============ 时间段售票统计（仅管理员，支持按售票员筛选）============
router.get('/sales', requireRole('admin'), async (req, res) => {
  const { start, end, operator_id } = rangeCheck(req, res); if (!start) return;
  const opAnd = operator_id ? ' AND o.operator_id = ?' : '';
  const p = operator_id ? [operator_id] : [];
  const [[total]] = await pool.query(
    `SELECT COUNT(*) AS cnt, IFNULL(SUM(o.price),0) AS amount FROM orders o
     WHERE o.source = 'window' AND o.created_at BETWEEN ? AND ? AND o.status <> 'refunded'${opAnd}`,
    [start, end, ...p]);
  const [[online]] = await pool.query(
    `SELECT COUNT(*) AS cnt, IFNULL(SUM(o.price),0) AS amount FROM orders o
     WHERE o.source = 'online' AND o.created_at BETWEEN ? AND ? AND o.status <> 'refunded'`,
    [start, end]);
  const [byType] = await pool.query(
    `SELECT o.ticket_name, COUNT(*) AS cnt, SUM(o.price) AS amount FROM orders o
     WHERE o.created_at BETWEEN ? AND ? AND o.status <> 'refunded'${operator_id ? ' AND o.source = \'window\' AND o.operator_id = ?' : ''}
     GROUP BY o.ticket_type_id, o.ticket_name ORDER BY cnt DESC`,
    [start, end, ...p]);
  const [[refund]] = await pool.query(
    `SELECT COUNT(*) AS cnt, IFNULL(SUM(o.price),0) AS amount FROM orders o
     WHERE o.status = 'refunded' AND o.refund_time BETWEEN ? AND ?${operator_id ? ' AND o.refund_operator_id = ?' : ''}`,
    [start, end, ...p]);
  res.json({
    sale_count: total.cnt, sale_amount: Number(total.amount),
    online_count: online.cnt, online_amount: Number(online.amount),
    by_type: byType, refund_count: refund.cnt, refund_amount: Number(refund.amount),
  });
});

// 入园/出园人次（按天；仅管理员，支持按标记售票员筛选）
router.get('/flow', requireRole('admin'), async (req, res) => {
  const { start, end, operator_id } = rangeCheck(req, res); if (!start) return;
  const enterAnd = operator_id ? ' AND enter_operator_id = ?' : '';
  const exitAnd = operator_id ? ' AND exit_operator_id = ?' : '';
  const pe = operator_id ? [operator_id] : [];
  const px = operator_id ? [operator_id] : [];
  const [rows] = await pool.query(
    `SELECT d.day,
       (SELECT COUNT(*) FROM orders WHERE enter_time BETWEEN d.day AND d.day + INTERVAL 1 DAY${enterAnd}) AS enter_count,
       (SELECT COUNT(*) FROM orders WHERE exit_time  BETWEEN d.day AND d.day + INTERVAL 1 DAY${exitAnd}) AS exit_count
     FROM (
       SELECT DISTINCT DATE(enter_time) AS day FROM orders WHERE enter_time BETWEEN ? AND ?${enterAnd}
       UNION
       SELECT DISTINCT DATE(exit_time) FROM orders WHERE exit_time BETWEEN ? AND ?${exitAnd}
     ) d ORDER BY d.day`, [...(operator_id ? [operator_id, operator_id] : []), start, end, ...pe, start, end, ...px]);
  const [[{ enter_total }]] = await pool.query(
    `SELECT COUNT(*) AS enter_total FROM orders WHERE enter_time BETWEEN ? AND ?${enterAnd}`, [start, end, ...pe]);
  const [[{ exit_total }]] = await pool.query(
    `SELECT COUNT(*) AS exit_total FROM orders WHERE exit_time BETWEEN ? AND ?${exitAnd}`, [start, end, ...px]);
  res.json({
    by_day: rows, enter_total, exit_total,
    range_in_park: enter_total - exit_total, // 时段内：累计入园 - 累计出园
    in_park: operator_id ? null : await currentInPark(),
  });
});

// 操作员业绩（仅统计售票员窗口售票；游客自主购票不计入）
router.get('/operators', requireRole('admin'), async (req, res) => {
  const { start, end } = rangeCheck(req, res); if (!start) return;
  const [rows] = await pool.query(
    `SELECT u.username, u.real_name, COUNT(*) AS cnt, SUM(o.price) AS amount
     FROM orders o JOIN users u ON u.id = o.operator_id
     WHERE o.source = 'window' AND o.created_at BETWEEN ? AND ? AND o.status <> 'refunded'
     GROUP BY o.operator_id ORDER BY amount DESC`, [start, end]);
  res.json({ list: rows });
});

// 客流热力图（天 × 小时，基于售票员人工登记的入园记录；仅管理员）
router.get('/heatmap', requireRole('admin'), async (req, res) => {
  const { start, end } = rangeCheck(req, res); if (!start) return;
  const [rows] = await pool.query(
    `SELECT DATE(enter_time) AS day, HOUR(enter_time) AS hour, COUNT(*) AS cnt
     FROM orders WHERE enter_time BETWEEN ? AND ?
     GROUP BY DATE(enter_time), HOUR(enter_time) ORDER BY day`, [start, end]);
  res.json({ list: rows });
});

// 报表导出 CSV（仅管理员；可筛选指定售票员导出个人业务报表；无数据导出空白模板）
router.get('/export', requireRole('admin'), async (req, res) => {
  const { type = 'sales', operator_id } = req.query;
  const { start, end } = rangeCheck(req, res); if (!start) return;
  let header, rows, filename;
  if (type === 'sales') {
    const opAnd = operator_id ? ' AND o.source=\'window\' AND o.operator_id = ?' : '';
    const p = operator_id ? [operator_id] : [];
    header = ['票种', '售票张数', '售票金额(元)'];
    const [r] = await pool.query(
      `SELECT o.ticket_name, COUNT(*) AS cnt, SUM(o.price) AS amount FROM orders o
       WHERE o.created_at BETWEEN ? AND ? AND o.status <> 'refunded'${opAnd}
       GROUP BY o.ticket_type_id, o.ticket_name`, [start, end, ...p]);
    rows = r.map(x => [x.ticket_name, x.cnt, Number(x.amount).toFixed(2)]);
    filename = (operator_id ? 'sales_' + operator_id + '_' : 'sales_') + 'report.csv';
  } else if (type === 'flow') {
    const enterAnd = operator_id ? ' AND enter_operator_id = ?' : '';
    const exitAnd = operator_id ? ' AND exit_operator_id = ?' : '';
    header = ['日期', '入园人次', '出园人次'];
    const [r] = await pool.query(
      `SELECT d.day,
         (SELECT COUNT(*) FROM orders WHERE enter_time BETWEEN d.day AND d.day + INTERVAL 1 DAY${enterAnd}) AS ec,
         (SELECT COUNT(*) FROM orders WHERE exit_time  BETWEEN d.day AND d.day + INTERVAL 1 DAY${exitAnd}) AS xc
       FROM (SELECT DISTINCT DATE(enter_time) AS day FROM orders WHERE enter_time BETWEEN ? AND ?${enterAnd}
             UNION SELECT DISTINCT DATE(exit_time) FROM orders WHERE exit_time BETWEEN ? AND ?${exitAnd}) d
       ORDER BY d.day`,
      operator_id
        ? [operator_id, operator_id, start, end, operator_id, start, end, operator_id]
        : [start, end, start, end]);
    rows = r.map(x => [x.day, x.ec, x.xc]);
    filename = (operator_id ? 'flow_' + operator_id + '_' : 'flow_') + 'report.csv';
  } else {
    header = ['售票员账号', '姓名', '窗口售票张数', '窗口售票金额(元)'];
    const [r] = await pool.query(
      `SELECT u.username, u.real_name, COUNT(*) AS cnt, SUM(o.price) AS amount
       FROM orders o JOIN users u ON u.id = o.operator_id
       WHERE o.source = 'window' AND o.created_at BETWEEN ? AND ? AND o.status <> 'refunded'
       GROUP BY o.operator_id`, [start, end]);
    rows = r.map(x => [x.username, x.real_name, x.cnt, Number(x.amount).toFixed(2)]);
    filename = 'operators_report.csv';
  }
  const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const csv = '\ufeff' + [header, ...rows].map(r => r.map(esc).join(',')).join('\r\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(csv);
});

function rangeCheck(req, res) {
  const { start, end } = req.query;
  if (!start || !end) {
    res.status(400).json({ error: '请选择统计时间段（开始日期和结束日期）' });
    return {};
  }
  if (start > end) {
    res.status(400).json({ error: '时间非法：开始时间不能晚于结束时间' });
    return {};
  }
  return { start: start + ' 00:00:00', end: end + ' 23:59:59', operator_id: req.query.operator_id || null };
}

module.exports = router;
