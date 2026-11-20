// 冒烟测试：按用例文档（UC-001~UC-025）与附录A权限矩阵验证主要流程
// 权限矩阵：窗口售票/入园出园登记/退票换票/退票审核 仅售票员；超级管理员仅后台查询管理
const BASE = 'http://localhost:3000/api';
let passed = 0, failed = 0;

function client() {
  let cookie = '';
  return {
    async req(path, opts = {}) {
      const res = await fetch(BASE + path, {
        ...opts,
        headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
        body: opts.body ? JSON.stringify(opts.body) : undefined,
      });
      const setCookie = res.headers.get('set-cookie');
      if (setCookie) cookie = setCookie.split(';')[0];
      let data = {};
      const text = Buffer.from(await res.arrayBuffer()).toString('utf8'); // Buffer解码保留BOM字符
      try { data = JSON.parse(text); } catch { data = { _raw: text }; }
      return { status: res.status, data };
    },
  };
}

function check(name, cond, extra = '') {
  if (cond) { passed++; console.log('  PASS', name); }
  else { failed++; console.log('  FAIL', name, extra); }
}

(async () => {
  // 重置数据库（可重复运行）
  const { pool, initDb } = require('./db');
  for (const t of ['orders', 'operation_logs', 'users', 'ticket_types', 'scenic_info']) {
    await pool.query(`TRUNCATE TABLE ${t}`);
  }
  await initDb();
  await pool.end();

  const admin = client(), seller = client(), tourist = client();
  let r;
  const today = () => new Date().toLocaleDateString('sv');

  console.log('== 登录与账号锁定（UC-001）==');
  const lockCli = client();
  const lockName = 'lock_probe_' + Date.now(); // 每次运行唯一，避免上轮锁定状态影响
  for (let i = 0; i < 5; i++) {
    r = await lockCli.req('/auth/login', { method: 'POST', body: { username: lockName, password: 'bad' } });
    check(`连错第${i + 1}次返回401`, r.status === 401);
  }
  r = await lockCli.req('/auth/login', { method: 'POST', body: { username: lockName, password: 'bad' } });
  check('连错5次后返回423锁定', r.status === 423, JSON.stringify(r.data));

  r = await admin.req('/auth/login', { method: 'POST', body: { username: 'admin', password: 'YOUR_ADMIN_PWD' } });
  const adminId = r.data.user && r.data.user.id;
  check('管理员登录', r.status === 200 && r.data.user.role === 'admin');
  r = await seller.req('/auth/login', { method: 'POST', body: { username: 'seller', password: 'YOUR_PWD_1' } });
  const sellerId = r.data.user && r.data.user.id;
  check('售票员登录', r.status === 200 && r.data.user.role === 'seller');
  r = await tourist.req('/auth/login', { method: 'POST', body: { username: 'tourist', password: 'YOUR_PWD_2' } });
  const touristId = r.data.user && r.data.user.id;
  check('游客登录', r.status === 200 && r.data.user.role === 'tourist');
  r = await client().req('/auth/login', { method: 'POST', body: { username: 'admin', password: 'wrong' } });
  check('错误密码拒绝(401，提示不泄露账号是否存在)', r.status === 401 && r.data.error === '账号或密码错误');

  console.log('== 票种管理（UC-005/006/007）==');
  r = await tourist.req('/ticket-types');
  check('游客查看票种(仅启用)', r.status === 200 && r.data.list.every(t => t.status === 1));
  check('票种含有效期起止字段', r.data.list.every(t => 'valid_start' in t && 'valid_end' in t));
  const preferential = r.data.list.find(t => t.name === '优待票');
  check('优待票带证件提示', !!preferential && !!preferential.cert_tip);
  check('优待票剩余可售=200', preferential && preferential.remaining_today === 200);
  r = await tourist.req('/ticket-types', { method: 'POST', body: { name: 'x', price: 1 } });
  check('游客不可建票种(403)', r.status === 403);
  r = await seller.req('/ticket-types', { method: 'POST', body: { name: 'x', price: 1 } });
  check('售票员不可建票种(403)', r.status === 403);
  r = await admin.req('/ticket-types', { method: 'POST', body: { name: '零价票', price: 0 } });
  check('票价为0拒绝(400)', r.status === 400 && r.data.error.includes('大于 0'));
  r = await admin.req('/ticket-types', { method: 'POST', body: { name: '负上限票', price: 1, daily_limit: -1 } });
  check('单日售票上限为负拒绝(400)', r.status === 400);
  r = await admin.req('/ticket-types', { method: 'POST', body: { name: '成人票', price: 1 } });
  check('票种重名拒绝(409)', r.status === 409);
  r = await admin.req('/ticket-types', { method: 'POST', body: { name: '日期错票', price: 1, valid_start: today(), valid_end: '2020-01-01' } });
  check('有效期起止颠倒拒绝(400)', r.status === 400);
  r = await admin.req('/ticket-types', { method: 'POST', body: { name: '限购票', price: 10, daily_limit: 2 } });
  check('管理员建票种(带单日上限)', r.status === 200);
  const limitId = r.data.id;

  const typeId = async name =>
    (await admin.req('/ticket-types')).data.list.find(t => t.name === name).id;
  const youdaiId = await typeId('优待票');
  const chengrenId = await typeId('成人票');
  const taopiaoId = await typeId('套票');

  console.log('== 购票（UC-009 + 权限矩阵）==');
  r = await admin.req('/orders/purchase', { method: 'POST', body: { ticket_type_id: chengrenId, visitors: [{ name: '管理员客' }] } });
  check('管理员购票被禁止(403，无窗口售票权限)', r.status === 403 && r.data.error.includes('窗口'), JSON.stringify(r.data));
  r = await tourist.req('/orders/purchase', { method: 'POST', body: { ticket_type_id: youdaiId, visitors: [{ name: '无证客' }] } });
  check('实名票缺身份证拒绝(400)', r.status === 400 && r.data.error.includes('实名'));
  r = await tourist.req('/orders/purchase', { method: 'POST', body: { ticket_type_id: youdaiId, visitors: [{ name: '张三', id_card: '110101199001011234', phone: '13800000000' }] } });
  check('游客购优待票', r.status === 200 && r.data.order_nos.length === 1);
  const o1no = r.data.order_nos[0];
  r = await tourist.req('/orders/purchase', { method: 'POST', body: { ticket_type_id: chengrenId, visitors: [{ name: '李四' }] } });
  check('游客购成人票', r.status === 200);
  const o2no = r.data.order_nos[0];
  r = await tourist.req('/orders/purchase', { method: 'POST', body: { ticket_type_id: chengrenId, visitors: [{ name: '王五' }] } });
  const o3no = r.data.order_nos[0];
  check('游客再次购票成功', r.status === 200);

  console.log('== 单日上限与售罄预警（规则型智能提示）==');
  r = await tourist.req('/orders/purchase', { method: 'POST', body: { ticket_type_id: limitId, visitors: [{ name: 'a' }, { name: 'b' }, { name: 'c' }] } });
  check('超剩余数量禁止下单(400)', r.status === 400 && r.data.error.includes('剩余'), JSON.stringify(r.data));
  r = await tourist.req('/orders/purchase', { method: 'POST', body: { ticket_type_id: limitId, visitors: [{ name: 'a' }, { name: 'b' }] } });
  check('购至售罄并返回剩余0', r.status === 200 && r.data.remaining_today === 0);
  r = await tourist.req('/orders/purchase', { method: 'POST', body: { ticket_type_id: limitId, visitors: [{ name: 'c' }] } });
  check('售罄后禁止下单(400)', r.status === 400);

  console.log('== 窗口售票（仅售票员，UC-008）==');
  r = await seller.req('/orders/purchase', { method: 'POST', body: { ticket_type_id: youdaiId, visitors: [{ name: '窗客甲', id_card: '110101199002YOUR_PWD_6', phone: '13811112222' }] } });
  check('售票员窗口售票', r.status === 200 && r.data.order_nos.length === 1);
  const o4no = r.data.order_nos[0];
  r = await seller.req('/orders/purchase', { method: 'POST', body: { ticket_type_id: chengrenId, visitors: [{ name: '窗客乙' }] } });
  check('窗口售票无证件票种正常', r.status === 200);
  const o7no = r.data.order_nos[0];
  r = await admin.req('/admin/users?keyword=110101199002YOUR_PWD_6');
  const autoAcc = r.data.list[0];
  check('窗口购票自动生成游客账号(用户名=身份证号)', r.status === 200 && autoAcc && autoAcc.role === 'tourist');
  const autoCli = client();
  r = await autoCli.req('/auth/login', { method: 'POST', body: { username: '110101199002YOUR_PWD_6', password: 'YOUR_PWD_6' } });
  check('自动账号以证件后6位登录成功', r.status === 200 && r.data.user.role === 'tourist');
  r = await autoCli.req('/orders');
  check('自动账号仅见本人窗口订单', r.status === 200 && r.data.total === 1 && r.data.list[0].order_no === o4no);

  console.log('== 入园/出园登记（仅售票员，UC-010/011）==');
  const oid = async (cli, no) => (await cli.req('/orders?keyword=' + no)).data.list[0].id;
  const o1 = await oid(tourist, o1no), o2 = await oid(tourist, o2no), o3 = await oid(tourist, o3no);
  r = await admin.req(`/orders/${o2}/enter`, { method: 'POST' });
  check('管理员入园登记被禁止(403，只读)', r.status === 403);
  r = await tourist.req(`/orders/${o2}/enter`, { method: 'POST' });
  check('游客入园登记被禁止(403)', r.status === 403);
  r = await admin.req('/orders/lookup?keyword=' + o1no);
  check('管理员登记查询被禁止(403)', r.status === 403);
  r = await seller.req('/orders/lookup?keyword=' + o1no);
  check('售票员按订单号查询(含核验提示)', r.status === 200 && r.data.list[0].cert_tip);
  r = await seller.req(`/orders/${o1}/enter`, { method: 'POST' });
  check('售票员标记入园', r.status === 200);
  r = await seller.req(`/orders/${o1}/enter`, { method: 'POST' });
  check('重复入园拒绝(400)', r.status === 400);
  r = await seller.req(`/orders/${o1}/exit`, { method: 'POST' });
  check('售票员标记出园', r.status === 200);

  console.log('== 退票/审核/换票（仅售票员，UC-013/014/015/016）==');
  r = await tourist.req(`/orders/${o1}/refund-apply`, { method: 'POST', body: { reason: 'x' } });
  check('已出园订单不可申请退票(400)', r.status === 400);
  r = await tourist.req('/orders/purchase', { method: 'POST', body: { ticket_type_id: youdaiId, visitors: [{ name: '赵六', id_card: '110101199001013333' }] } });
  const o5 = await oid(tourist, r.data.order_nos[0]);
  const o5no = r.data.order_nos[0];
  r = await tourist.req(`/orders/${o5}/refund-apply`, { method: 'POST', body: { reason: '行程有变' } });
  check('游客发起退票申请', r.status === 200);
  r = await tourist.req('/orders?status=refunding');
  check('申请后状态为待退票审核', r.status === 200 && r.data.list.some(o => o.id === o5));
  r = await admin.req(`/orders/${o5}/refund-review`, { method: 'POST', body: { approve: true, reason: '同意' } });
  check('管理员审核退票被禁止(403)', r.status === 403);
  r = await seller.req(`/orders/${o5}/refund-review`, { method: 'POST', body: { approve: true } });
  check('审核同意缺退票原因拒绝(400)', r.status === 400);
  r = await seller.req(`/orders/${o5}/refund-review`, { method: 'POST', body: { approve: true, reason: '行程取消属实' } });
  check('售票员审核同意退票', r.status === 200);
  r = await tourist.req('/orders?keyword=' + o5no);
  check('审核同意后状态为已退票', r.data.list[0].status === 'refunded');

  r = await tourist.req('/orders/purchase', { method: 'POST', body: { ticket_type_id: youdaiId, visitors: [{ name: '孙七', id_card: '110101199001014444' }] } });
  const o6 = await oid(tourist, r.data.order_nos[0]);
  await tourist.req(`/orders/${o6}/refund-apply`, { method: 'POST', body: { reason: '不想去了' } });
  r = await seller.req(`/orders/${o6}/refund-review`, { method: 'POST', body: { approve: false } });
  check('驳回缺拒绝原因拒绝(400)', r.status === 400);
  r = await seller.req(`/orders/${o6}/refund-review`, { method: 'POST', body: { approve: false, reason: '证件核验未通过' } });
  check('售票员驳回退票申请', r.status === 200);
  r = await tourist.req('/orders?status=pending');
  check('驳回后恢复待核验状态(实名票)', r.status === 200 && r.data.list.some(o => o.id === o6));

  const o7 = await oid(seller, o7no);
  r = await seller.req(`/orders/${o7}/refund`, { method: 'POST', body: {} });
  check('直接退票缺原因拒绝(400)', r.status === 400);
  r = await seller.req(`/orders/${o7}/refund`, { method: 'POST', body: { reason: '游客现场取消' } });
  check('售票员直接退票(窗口单)', r.status === 200);

  r = await tourist.req('/orders/purchase', { method: 'POST', body: { ticket_type_id: chengrenId, visitors: [{ name: '周八' }] } });
  const o11 = await oid(tourist, r.data.order_nos[0]);
  await seller.req(`/orders/${o11}/enter`, { method: 'POST' });
  r = await seller.req(`/orders/${o11}/refund`, { method: 'POST', body: { reason: '已入园人工退票处理' } });
  check('已入园订单人工退票', r.status === 200);

  r = await admin.req(`/orders/${o3}/exchange`, { method: 'POST', body: { new_ticket_type_id: taopiaoId } });
  check('管理员换票被禁止(403)', r.status === 403);
  r = await seller.req(`/orders/${o3}/exchange`, { method: 'POST', body: { new_ticket_type_id: taopiaoId, reason: '游客要求换票' } });
  check('售票员换票', r.status === 200);
  r = await tourist.req('/orders?keyword=' + o3no);
  check('换票后票种与价格更新', r.data.list[0].ticket_name === '套票' && Number(r.data.list[0].price) === 180);

  console.log('== 数据范围隔离 ==');
  r = await tourist.req('/orders?size=50');
  check('游客仅见本人订单', r.status === 200 && r.data.list.every(o => o.tourist_user_id === touristId));
  r = await seller.req('/orders?size=50');
  check('售票员仅见自己操作的订单', r.status === 200 && r.data.list.every(o =>
    [o.operator_id, o.enter_operator_id, o.exit_operator_id, o.refund_operator_id].includes(sellerId)),
    JSON.stringify(r.data.list.map(o => [o.order_no, o.operator_id, o.enter_operator_id, o.exit_operator_id, o.refund_operator_id])));
  r = await admin.req('/orders?size=50');
  check('管理员可见全部订单', r.status === 200 && r.data.total >= 10, 'total=' + r.data.total);
  r = await admin.req('/orders?operator_id=' + sellerId + '&size=50');
  check('管理员按售票员筛选订单', r.status === 200 && r.data.list.every(o => o.operator_id === sellerId));
  r = await admin.req(`/orders?start=${today()}&end=2020-01-01`);
  check('订单查询起止颠倒拒绝(400)', r.status === 400);

  console.log('== 账号管理（UC-002/003/004）==');
  r = await seller.req('/admin/users');
  check('售票员不可管账号(403)', r.status === 403);
  r = await admin.req('/admin/users', { method: 'POST', body: { username: '非@法#', password: 'YOUR_DB_PASSWORD', role: 'seller' } });
  check('用户名非法字符拒绝(400)', r.status === 400);
  r = await admin.req('/admin/users', { method: 'POST', body: { username: 'u1', password: '123', role: 'seller' } });
  check('密码过短拒绝(400)', r.status === 400);
  r = await admin.req('/admin/users', { method: 'POST', body: { username: 'u2', password: 'YOUR_DB_PASSWORD', role: 'seller', phone: '12345' } });
  check('手机号格式错误拒绝(400)', r.status === 400);
  r = await admin.req('/admin/users', { method: 'POST', body: { username: 'seller2', password: 'YOUR_PWD_5', role: 'seller' } });
  check('新增账号', r.status === 200);
  r = await admin.req('/admin/users', { method: 'POST', body: { username: 'phoneowner', password: 'YOUR_PWD_3', role: 'tourist', phone: '13855554444' } });
  check('新增游客账号(带手机号)', r.status === 200);
  const phoneOwnerId = r.data.id;
  r = await tourist.req('/auth/profile', { method: 'PUT', body: { phone: '13855554444' } });
  check('手机号被占用拒绝(409)', r.status === 409);

  r = await admin.req('/admin/users');
  const builtin = r.data.list.find(u => u.is_builtin);
  check('识别内置超级管理员', !!builtin && builtin.username === 'admin');
  r = await admin.req(`/admin/users/${builtin.id}`, { method: 'PUT', body: { role: 'seller' } });
  check('内置超管禁改角色(400)', r.status === 400);
  r = await admin.req(`/admin/users/${builtin.id}/toggle`, { method: 'POST' });
  check('内置超管禁停用(400)', r.status === 400);
  r = await admin.req(`/admin/users/${builtin.id}`, { method: 'DELETE' });
  check('内置超管禁删除(400)', r.status === 400);

  // phoneowner 产生购票历史后删除 → 二次确认
  const phoneCli = client();
  await phoneCli.req('/auth/login', { method: 'POST', body: { username: 'phoneowner', password: 'YOUR_PWD_3' } });
  await phoneCli.req('/orders/purchase', { method: 'POST', body: { ticket_type_id: chengrenId, visitors: [{ name: '机主' }] } });
  r = await admin.req(`/admin/users/${phoneOwnerId}`, { method: 'DELETE' });
  check('有历史记录删除需二次确认(409)', r.status === 409 && r.data.has_history === true && r.data.history_count >= 1, JSON.stringify(r.data));
  r = await admin.req(`/admin/users/${phoneOwnerId}?force=1`, { method: 'DELETE' });
  check('风险确认后强制删除', r.status === 200);
  r = await client().req('/auth/login', { method: 'POST', body: { username: 'phoneowner', password: 'YOUR_PWD_3' } });
  check('已删账号无法登录(401)', r.status === 401);

  console.log('== 统计报表（UC-017/018/019/020）==');
  r = await seller.req('/stats/daily');
  check('售票员个人日结(scope=self)', r.status === 200 && r.data.scope === 'self', JSON.stringify(r.data));
  check('个人日结：我的窗口售票1单60元', r.data.sale_count === 1 && Number(r.data.sale_amount) === 60, JSON.stringify(r.data));
  check('个人日结：我登记入园2出园1，在园0', r.data.enter_count === 2 && r.data.exit_count === 1 && r.data.in_park === 0);
  check('个人日结：我处理退票3单300元', r.data.refund_count === 3 && Number(r.data.refund_amount) === 300, JSON.stringify(r.data));
  r = await tourist.req('/stats/daily');
  check('游客不可看日结(403)', r.status === 403);
  r = await admin.req('/stats/daily');
  check('管理员全局日结(窗口1单60元)', r.status === 200 && r.data.scope === 'global' && r.data.sale_count === 1 && Number(r.data.sale_amount) === 60, JSON.stringify(r.data));
  check('全局日结：线上7单560元', r.data.online_count === 7 && Number(r.data.online_amount) === 560, JSON.stringify(r.data));
  check('全局日结：退票3单300元', r.data.refund_count === 3 && Number(r.data.refund_amount) === 300);
  r = await admin.req('/stats/daily?operator_id=' + sellerId);
  check('管理员按售票员筛选日结(scope=operator)', r.status === 200 && r.data.scope === 'operator' && r.data.sale_count === 1);
  r = await admin.req('/stats/daily?start=2026-01-02&end=2026-01-01');
  check('日结起止颠倒拒绝(400)', r.status === 400);
  r = await seller.req(`/stats/sales?start=${today()}&end=${today()}`);
  check('售票员不可看全局售票统计(403)', r.status === 403);
  r = await admin.req(`/stats/sales?start=${today()}&end=${today()}`);
  check('售票统计(分票种)', r.status === 200 && r.data.by_type.length >= 1);
  r = await admin.req(`/stats/sales?start=${today()}&end=${today()}&operator_id=${sellerId}`);
  check('售票统计按售票员筛选', r.status === 200 && r.data.sale_count === 1 && Number(r.data.sale_amount) === 60, JSON.stringify(r.data));
  r = await admin.req(`/stats/flow?start=${today()}&end=${today()}`);
  check('客流统计(入园2出园1在园0)', r.status === 200 && r.data.enter_total === 2 && r.data.exit_total === 1 && r.data.in_park === 0, JSON.stringify(r.data));
  r = await admin.req(`/stats/operators?start=${today()}&end=${today()}`);
  check('业绩仅含窗口售票(退票不计)', r.status === 200 && r.data.list.length === 1 && r.data.list[0].username === 'seller' && r.data.list[0].cnt === 1, JSON.stringify(r.data));
  r = await admin.req(`/stats/heatmap?start=${today()}&end=${today()}`);
  check('客流热力图数据', r.status === 200 && r.data.list.length >= 1);
  r = await admin.req(`/stats/export?type=sales&start=${today()}&end=${today()}`);
  check('报表导出CSV(带BOM)', r.status === 200 && r.data._raw.charCodeAt(0) === 0xFEFF && r.data._raw.includes('票种'));
  r = await admin.req(`/stats/export?type=flow&start=${today()}&end=${today()}&operator_id=${sellerId}`);
  check('客流报表按售票员导出', r.status === 200 && r.data._raw.includes('入园人次'));
  r = await admin.req(`/stats/export?type=sales&start=${today()}&end=2020-01-01`);
  check('导出起止颠倒拒绝(400)', r.status === 400);
  r = await seller.req(`/stats/export?type=sales&start=${today()}&end=${today()}`);
  check('售票员不可导出报表(403)', r.status === 403);

  console.log('== 操作日志（UC-021）==');
  r = await tourist.req('/admin/logs');
  check('游客不可看日志(403)', r.status === 403);
  r = await admin.req('/admin/logs');
  check('操作日志留痕', r.status === 200 && r.data.total >= 15, 'total=' + r.data.total);
  check('返回操作员下拉列表', Array.isArray(r.data.operators) && r.data.operators.includes('seller'));
  r = await admin.req('/admin/logs?operator=seller');
  check('日志按操作员筛选', r.status === 200 && r.data.total >= 1 && r.data.list.every(l => l.username === 'seller'));
  r = await admin.req(`/admin/logs?start=${today()}&end=2020-01-01`);
  check('日志起止颠倒拒绝(400)', r.status === 400);

  console.log('== 景区信息（UC-022）==');
  r = await admin.req('/admin/scenic', { method: 'PUT', body: { intro: '', policy: '', notice: '', ticket_desc: '' } });
  check('全空内容拒绝保存(400)', r.status === 400);
  r = await admin.req('/admin/scenic', { method: 'PUT', body: { intro: '测试景区介绍', policy: '测试优待政策', notice: '测试游玩须知', ticket_desc: '测试票种说明' } });
  check('更新景区信息', r.status === 200);
  r = await tourist.req('/admin/scenic');
  check('游客可读首页内容', r.status === 200 && r.data.info.intro === '测试景区介绍');

  console.log('== 个人中心（UC-023/024/025）==');
  r = await tourist.req('/auth/profile', { method: 'PUT', body: { phone: '12345' } });
  check('手机号格式错误拒绝(400)', r.status === 400);
  r = await tourist.req('/auth/profile', { method: 'PUT', body: { old_password: 'wrong', new_password: 'YOUR_PWD_4' } });
  check('原密码错误拒绝(400)', r.status === 400);
  r = await tourist.req('/auth/profile', { method: 'PUT', body: { old_password: 'YOUR_PWD_2', new_password: 'YOUR_PWD_2' } });
  check('修改密码成功', r.status === 200);

  console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('测试异常:', e); process.exit(1); });
