// 管理员端：订单查询（只读）、全局日结、票种管理、报表统计、账号管理、操作日志、景区信息管理
// （超级管理员无窗口售票、入园出园标记、退票换票审核等现场业务操作权限）

// ============ 订单管理（管理员：全部订单，只读，可按售票员筛选，UC-012）============
Pages.orders = async el => {
  const { list: types } = await api('/ticket-types');
  let sellers = [];
  try { sellers = (await api('/admin/users?role=seller')).list; } catch { /* 忽略 */ }
  el.innerHTML = `
    <div class="card">
      <div class="toolbar">
        <div class="field"><label>开始日期</label><input type="date" id="f-start"></div>
        <div class="field"><label>结束日期</label><input type="date" id="f-end"></div>
        <div class="field"><label>票种</label><select id="f-type">
          <option value="">全部</option>${types.map(t => `<option value="${t.id}">${esc(t.name)}</option>`).join('')}
        </select></div>
        <div class="field"><label>状态</label><select id="f-status">
          <option value="">全部</option>
          ${Object.entries(STATUS_BADGE).map(([k, [v]]) => `<option value="${k}">${v}</option>`).join('')}
        </select></div>
        <div class="field"><label>售票员</label><select id="f-operator">
          <option value="">全部</option>
          ${sellers.map(s => `<option value="${s.id}">${esc(s.username)}${s.real_name ? '（' + esc(s.real_name) + '）' : ''}</option>`).join('')}
        </select></div>
        <div class="field"><label>关键字</label><input id="f-kw" placeholder="订单号/姓名/手机号"></div>
        <button class="btn btn-primary" id="f-search">查 询</button>
      </div>
      <p class="text-muted" style="margin-bottom:10px">超级管理员拥有全部订单与游客信息查询权限，可查看入园/出园标记结果；无窗口售票、标记入园出园、退票换票审核操作权限。</p>
      <div id="order-table"></div>
      <div class="pager">
        <button class="btn btn-sm" id="pg-prev">上一页</button>
        <span id="pg-info"></span>
        <button class="btn btn-sm" id="pg-next">下一页</button>
      </div>
    </div>`;

  let page = 1, total = 0, lastList = [];
  const size = 15;

  async function load() {
    const p = new URLSearchParams({ page, size });
    if (el.querySelector('#f-start').value) p.set('start', el.querySelector('#f-start').value);
    if (el.querySelector('#f-end').value) p.set('end', el.querySelector('#f-end').value);
    if (el.querySelector('#f-type').value) p.set('ticket_type_id', el.querySelector('#f-type').value);
    if (el.querySelector('#f-status').value) p.set('status', el.querySelector('#f-status').value);
    if (el.querySelector('#f-operator').value) p.set('operator_id', el.querySelector('#f-operator').value);
    if (el.querySelector('#f-kw').value.trim()) p.set('keyword', el.querySelector('#f-kw').value.trim());
    const data = await api('/orders?' + p);
    total = data.total; lastList = data.list;
    el.querySelector('#pg-info').textContent = `第 ${page} 页 / 共 ${total} 条`;
    el.querySelector('#pg-prev').disabled = page <= 1;
    el.querySelector('#pg-next').disabled = page * size >= total;

    el.querySelector('#order-table').innerHTML = `
      <table><thead><tr>
        <th>订单编号</th><th>游客</th><th>票种</th><th>票价</th><th>来源</th>
        <th>下单时间</th><th>状态</th><th>售票员</th><th>入园登记</th><th>出园登记</th><th>退票处理</th><th>操作</th>
      </tr></thead><tbody>
      ${data.list.map(o => `<tr>
        <td><a href="javascript:void(0)" class="lnk-detail" data-id="${o.id}" style="color:#2f6fed">${esc(o.order_no)}</a></td>
        <td>${esc(o.visitor_name)}<br><span class="text-muted">${esc(o.visitor_phone) || ''}</span></td>
        <td>${esc(o.ticket_name)}</td><td>${fmtMoney(o.price)}</td>
        <td>${o.source === 'window' ? '窗口' : '线上'}</td>
        <td>${o.created_at}</td><td>${statusBadge(o.status)}</td>
        <td>${esc(o.operator_name) || '-'}</td>
        <td>${esc(o.enter_operator_name) || '-'}<br><span class="text-muted">${o.enter_time || ''}</span></td>
        <td>${esc(o.exit_operator_name) || '-'}<br><span class="text-muted">${o.exit_time || ''}</span></td>
        <td>${esc(o.refund_operator_name) || '-'}<br><span class="text-muted">${o.refund_time || ''}</span></td>
        <td><button class="btn btn-sm btn-detail" data-id="${o.id}">详情</button></td>
      </tr>`).join('') || '<tr><td colspan="12" class="empty">暂无订单</td></tr>'}
      </tbody></table>`;

    el.querySelectorAll('.lnk-detail, .btn-detail').forEach(a => {
      a.onclick = () => showOrderDetail(lastList.find(o => o.id == a.dataset.id));
    });
  }

  el.querySelector('#f-search').onclick = () => { page = 1; load(); };
  el.querySelector('#pg-prev').onclick = () => { if (page > 1) { page--; load(); } };
  el.querySelector('#pg-next').onclick = () => { if (page * size < total) { page++; load(); } };
  load();
};

// ============ 日结汇总（管理员：全局完整日结 + 按售票员筛选，UC-017）============
Pages.daily = async el => {
  let sellers = [];
  try { sellers = (await api('/admin/users?role=seller')).list; } catch { /* 忽略 */ }
  el.innerHTML = `
    <div class="card">
      <div class="toolbar">
        <div class="field"><label>日期</label><input type="date" id="d-date" value="${todayStr()}"></div>
        <div class="field"><label>售票员</label><select id="d-operator">
          <option value="">全局（所有售票员汇总）</option>
          ${sellers.map(s => `<option value="${s.id}">${esc(s.username)}${s.real_name ? '（' + esc(s.real_name) + '）' : ''}</option>`).join('')}
        </select></div>
        <button class="btn btn-primary" id="d-search">查 询</button>
      </div>
      <div class="stat-grid" id="d-stats"><div class="empty">加载中...</div></div>
    </div>`;

  async function load() {
    const p = new URLSearchParams({ date: el.querySelector('#d-date').value });
    if (el.querySelector('#d-operator').value) p.set('operator_id', el.querySelector('#d-operator').value);
    const d = await api('/stats/daily?' + p);
    const isSingle = !!el.querySelector('#d-operator').value;
    el.querySelector('#d-stats').innerHTML = `
      <div class="stat-card"><div class="label">售票总额</div><div class="num">${fmtMoney(d.sale_amount)}</div></div>
      <div class="stat-card"><div class="label">窗口售票张数</div><div class="num">${d.sale_count}</div></div>
      <div class="stat-card"><div class="label">游客自主购票张数</div><div class="num">${d.online_count}</div></div>
      <div class="stat-card"><div class="label">已入园人数</div><div class="num">${d.enter_count}</div></div>
      <div class="stat-card"><div class="label">已出园人数</div><div class="num">${d.exit_count}</div></div>
      <div class="stat-card"><div class="label">当前在园人数</div><div class="num">${d.in_park ?? '-'}</div></div>
      <div class="stat-card"><div class="label">退款金额（${d.refund_count}笔）</div><div class="num">${fmtMoney(d.refund_amount)}</div></div>
      <div class="stat-card"><div class="label">统计口径</div><div style="margin-top:6px" class="badge ${isSingle ? 'badge-blue' : 'badge-green'}">${isSingle ? '单个售票员日结' : '全局完整日结'}</div></div>`;
  }
  el.querySelector('#d-search').onclick = load;
  load();
};

// ============ 票种管理 ============
Pages.tickets = async el => {
  async function load() {
    const { list } = await api('/ticket-types');
    el.innerHTML = `
      <div class="card">
        <div class="toolbar">
          <h3 style="margin:0">票种管理</h3>
          <button class="btn btn-primary" id="tt-add" style="margin-left:auto">+ 新增票种</button>
        </div>
        <table><thead><tr>
          <th>ID</th><th>名称</th><th>票价</th><th>有效期</th><th>需实名</th><th>单日上限</th>
          <th>今日已售</th><th>证件核验提示</th><th>状态</th><th>操作</th>
        </tr></thead><tbody>
        ${list.map(t => `<tr>
          <td>${t.id}</td><td>${esc(t.name)}</td><td>${fmtMoney(t.price)}</td>
          <td>${t.valid_start || t.valid_end ? `${t.valid_start || '…'} ~ ${t.valid_end || '…'}` : '不限'}</td>
          <td>${t.need_real_name ? '是' : '否'}</td>
          <td>${t.daily_limit || '不限'}</td><td>${t.sold_today}</td>
          <td style="white-space:normal;max-width:260px">${esc(t.cert_tip) || '<span class="text-muted">无</span>'}</td>
          <td>${t.status === 1 ? '<span class="badge badge-green">启用</span>' : '<span class="badge badge-red">停用</span>'}</td>
          <td>
            <button class="btn btn-sm btn-edit" data-id="${t.id}">编辑</button>
            <button class="btn btn-sm btn-toggle" data-id="${t.id}" ${t.status !== 1 ? 'disabled title="已停用"' : ''}>停用</button>
          </td></tr>`).join('')}
        </tbody></table>
      </div>`;

    el.querySelector('#tt-add').onclick = () => editModal(null);
    el.querySelectorAll('.btn-edit').forEach(btn => {
      btn.onclick = () => editModal(list.find(t => t.id == btn.dataset.id));
    });
    el.querySelectorAll('.btn-toggle').forEach(btn => {
      btn.onclick = async () => {
        const t = list.find(x => x.id == btn.dataset.id);
        // UC-007：存在未核销历史订单时弹出风险提示
        let pendingTip = '';
        try {
          const r = await api(`/orders?ticket_type_id=${t.id}&status=unused&size=1`);
          const r2 = await api(`/orders?ticket_type_id=${t.id}&status=pending&size=1`);
          const n = r.total + r2.total;
          if (n > 0) pendingTip = `<p class="notice">注意：该票种存在 <b>${n}</b> 笔未入园的历史订单，停用后不可再售，请确认。</p>`;
        } catch { /* 忽略 */ }
        confirmModal('停用票种', `确认停用票种「${esc(t.name)}」？停用后售票窗口与游客购票页不再展示该票种，历史订单仍可查询。${pendingTip}`, async () => {
          try {
            await api(`/ticket-types/${t.id}/toggle`, { method: 'POST' });
            toast('已停用'); load();
          } catch (e) { toast(e.message, 3000); }
        });
      };
    });
  }

  function editModal(t) {
    const body = modal(t ? '编辑票种' : '新增票种', `
      <label>票种名称 *</label><input id="tf-name" value="${esc(t?.name) || ''}" placeholder="如：成人票 / 优待票 / 团体票 / 套票">
      <div class="row">
        <div><label>票价（元）*（必须大于0）</label><input id="tf-price" type="number" min="0.01" step="0.01" value="${t?.price ?? ''}"></div>
        <div><label>单日售票上限（0=不限）</label><input id="tf-limit" type="number" min="0" value="${t?.daily_limit ?? 0}"></div>
      </div>
      <div class="row">
        <div><label>有效期起</label><input id="tf-vstart" type="date" value="${t?.valid_start || ''}"></div>
        <div><label>有效期止</label><input id="tf-vend" type="date" value="${t?.valid_end || ''}"></div>
      </div>
      <div class="row">
        <div><label>是否实名</label><select id="tf-realname">
          <option value="0" ${t && !t.need_real_name ? 'selected' : ''}>否</option>
          <option value="1" ${t && t.need_real_name ? 'selected' : ''}>是（身份证号必填）</option>
        </select></div>
      </div>
      <label>证件核验提示文案（优待票等，购票页与入园登记处展示）</label>
      <textarea id="tf-tip" rows="3">${esc(t?.cert_tip) || ''}</textarea>
      <div class="modal-actions">
        <button class="btn" onclick="closeModal()" type="button">取 消</button>
        <button class="btn btn-primary" id="tf-save" type="button">保 存</button>
      </div>`);
    body.querySelector('#tf-save').onclick = async () => {
      const data = {
        name: body.querySelector('#tf-name').value.trim(),
        price: body.querySelector('#tf-price').value,
        valid_start: body.querySelector('#tf-vstart').value || undefined,
        valid_end: body.querySelector('#tf-vend').value || undefined,
        need_real_name: body.querySelector('#tf-realname').value === '1',
        daily_limit: body.querySelector('#tf-limit').value,
        cert_tip: body.querySelector('#tf-tip').value.trim(),
      };
      if (!data.name || data.price === '') return toast('请填写票种名称和票价');
      try {
        await api(t ? `/ticket-types/${t.id}` : '/ticket-types', { method: t ? 'PUT' : 'POST', body: data });
        closeModal(); toast('已保存'); load();
      } catch (e) { toast(e.message, 3500); }
    };
  }
  load();
};

// ============ 报表统计（仅管理员）：售票 / 客流 / 业绩 / 热力图 + 导出（支持按售票员筛选）============
Pages.reports = async el => {
  const start = todayStr().slice(0, 8) + '01'; // 本月1号
  let sellers = [];
  try { sellers = (await api('/admin/users?role=seller')).list; } catch { /* 忽略 */ }
  el.innerHTML = `
    <div class="card">
      <div class="toolbar">
        <div class="field"><label>开始日期</label><input type="date" id="rp-start" value="${start}"></div>
        <div class="field"><label>结束日期</label><input type="date" id="rp-end" value="${todayStr()}"></div>
        <div class="field"><label>售票员</label><select id="rp-operator">
          <option value="">全局（全部售票员）</option>
          ${sellers.map(s => `<option value="${s.id}">${esc(s.username)}${s.real_name ? '（' + esc(s.real_name) + '）' : ''}</option>`).join('')}
        </select></div>
        <button class="btn btn-primary" id="rp-run">统 计</button>
        <button class="btn" id="rp-export">导出报表(CSV)</button>
      </div>
      <div class="tabs" style="margin-bottom:14px">
        <button class="tab active" data-tab="sales" type="button">售票统计</button>
        <button class="tab" data-tab="flow" type="button">客流统计</button>
        <button class="tab" data-tab="operators" type="button">操作员业绩</button>
        <button class="tab" data-tab="heatmap" type="button">客流热力图</button>
      </div>
      <div id="rp-result"></div>
    </div>`;

  let tab = 'sales';
  const qs = () => {
    const p = new URLSearchParams({
      start: el.querySelector('#rp-start').value,
      end: el.querySelector('#rp-end').value,
    });
    if (el.querySelector('#rp-operator').value) p.set('operator_id', el.querySelector('#rp-operator').value);
    return p.toString();
  };

  el.querySelectorAll('.tab').forEach(b => {
    b.onclick = () => {
      tab = b.dataset.tab;
      el.querySelectorAll('.tab').forEach(x => x.classList.toggle('active', x === b));
      run();
    };
  });
  el.querySelector('#rp-run').onclick = run;
  el.querySelector('#rp-export').onclick = () => {
    const t = tab === 'heatmap' ? 'flow' : tab;
    location.href = `/api/stats/export?type=${t}&${qs()}`;
  };

  async function run() {
    const box = el.querySelector('#rp-result');
    if (!el.querySelector('#rp-start').value || !el.querySelector('#rp-end').value) {
      box.innerHTML = '<div class="empty">请选择时间段</div>'; return;
    }
    if (tab === 'sales') {
      const d = await api('/stats/sales?' + qs());
      box.innerHTML = `
        <div class="stat-grid">
          <div class="stat-card"><div class="label">窗口售票总张数</div><div class="num">${d.sale_count}</div></div>
          <div class="stat-card"><div class="label">窗口售票总金额</div><div class="num">${fmtMoney(d.sale_amount)}</div></div>
          <div class="stat-card"><div class="label">游客自主购票张数</div><div class="num">${d.online_count}</div></div>
          <div class="stat-card"><div class="label">游客自主购票金额</div><div class="num">${fmtMoney(d.online_amount)}</div></div>
          <div class="stat-card"><div class="label">退款（${d.refund_count}笔）</div><div class="num">${fmtMoney(d.refund_amount)}</div></div>
        </div>
        <div class="card mt"><h3>各票种销量统计（游客自主购票 + 窗口售票）</h3>
          <table><thead><tr><th>票种</th><th>张数</th><th>金额</th></tr></thead><tbody>
          ${d.by_type.map(t => `<tr><td>${esc(t.ticket_name)}</td><td>${t.cnt}</td><td>${fmtMoney(t.amount)}</td></tr>`).join('')
            || '<tr><td colspan="3" class="empty">暂无数据</td></tr>'}</tbody></table></div>`;
    } else if (tab === 'flow') {
      const d = await api('/stats/flow?' + qs());
      box.innerHTML = `
        <div class="stat-grid">
          <div class="stat-card"><div class="label">时段入园总人次</div><div class="num">${d.enter_total}</div></div>
          <div class="stat-card"><div class="label">时段出园总人次</div><div class="num">${d.exit_total}</div></div>
          <div class="stat-card"><div class="label">时段在园（入-出）</div><div class="num">${d.range_in_park}</div></div>
          <div class="stat-card"><div class="label">当前实时在园</div><div class="num">${d.in_park ?? '-'}</div></div>
        </div>
        <div class="card mt"><h3>每日客流</h3>
          <table><thead><tr><th>日期</th><th>入园人次</th><th>出园人次</th></tr></thead><tbody>
          ${d.by_day.map(r => `<tr><td>${r.day}</td><td>${r.enter_count}</td><td>${r.exit_count}</td></tr>`).join('')
            || '<tr><td colspan="3" class="empty">暂无数据</td></tr>'}</tbody></table></div>`;
    } else if (tab === 'operators') {
      const d = await api('/stats/operators?' + qs());
      box.innerHTML = `
        <p class="text-muted" style="margin-bottom:10px">区分各售票员窗口售票业绩；游客自主购票不计入售票员业绩。</p>
        <table><thead><tr><th>售票员账号</th><th>姓名</th><th>窗口售票张数</th><th>窗口售票金额</th></tr></thead><tbody>
        ${d.list.map(r => `<tr><td>${esc(r.username)}</td><td>${esc(r.real_name) || '-'}</td>
          <td>${r.cnt}</td><td>${fmtMoney(r.amount)}</td></tr>`).join('')
          || '<tr><td colspan="4" class="empty">暂无窗口售票数据</td></tr>'}</tbody></table>`;
    } else {
      const d = await api('/stats/heatmap?' + qs());
      box.innerHTML = renderHeatmap(d.list);
    }
  }

  // 天 × 小时 热力图（基于售票员人工登记的入园时间）
  function renderHeatmap(list) {
    if (!list.length) return '<div class="empty">该时间段没有入园记录，热力图无数据展示</div>';
    const days = [...new Set(list.map(r => r.day))];
    const map = {};
    let max = 1;
    list.forEach(r => { map[r.day + '_' + r.hour] = r.cnt; if (r.cnt > max) max = r.cnt; });
    const hours = [...Array(24).keys()];
    return `<div class="heatmap"><table>
      <thead><tr><th>日期</th>${hours.map(h => `<th>${h}</th>`).join('')}</tr></thead>
      <tbody>${days.map(day => `<tr><td class="day-label">${day}</td>${hours.map(h => {
        const c = map[day + '_' + h] || 0;
        const a = c ? 0.15 + 0.85 * c / max : 0;
        return `<td class="hm-cell" title="${day} ${h}:00 入园 ${c} 人"
          style="background:rgba(47,111,237,${a});${c ? 'color:#fff' : 'color:#bbb'}">${c || ''}</td>`;
      }).join('')}</tr>`).join('')}</tbody></table></div>
      <p class="text-muted mt">颜色越深表示该小时入园人次越多（基于售票员人工登记的入园数据聚合生成）</p>`;
  }
  run();
};

// ============ 账号管理 ============
Pages.accounts = async el => {
  async function load(keyword = '', role = '') {
    const p = new URLSearchParams();
    if (keyword) p.set('keyword', keyword);
    if (role) p.set('role', role);
    const { list } = await api('/admin/users?' + p);
    el.querySelector('#acc-table').innerHTML = `
      <table><thead><tr>
        <th>ID</th><th>用户名</th><th>角色</th><th>姓名</th><th>身份证号</th><th>手机号</th><th>状态</th><th>创建时间</th><th>操作</th>
      </tr></thead><tbody>
      ${list.map(u => `<tr>
        <td>${u.id}</td><td>${esc(u.username)}${u.is_builtin ? ' <span class="badge badge-red">内置</span>' : ''}</td>
        <td><span class="badge ${u.role === 'admin' ? 'badge-red' : u.role === 'seller' ? 'badge-blue' : 'badge-green'}">${ROLE_CN[u.role]}</span></td>
        <td>${esc(u.real_name) || '-'}</td><td>${esc(u.id_card) || '-'}</td><td>${esc(u.phone) || '-'}</td>
        <td>${u.status === 1 ? '<span class="badge badge-green">启用</span>' : '<span class="badge badge-red">停用</span>'}</td>
        <td>${u.created_at}</td>
        <td>
          <button class="btn btn-sm btn-edit" data-id="${u.id}">编辑</button>
          <button class="btn btn-sm btn-toggle" data-id="${u.id}" ${u.is_builtin ? 'disabled title="内置超级管理员禁止停用"' : ''}>${u.status === 1 ? '停用' : '启用'}</button>
          <button class="btn btn-sm btn-danger btn-del" data-id="${u.id}" ${u.is_builtin ? 'disabled title="内置超级管理员禁止删除"' : ''}>删除</button>
        </td></tr>`).join('')}
      </tbody></table>`;

    el.querySelectorAll('.btn-edit').forEach(btn => {
      btn.onclick = () => editModal(list.find(u => u.id == btn.dataset.id));
    });
    el.querySelectorAll('.btn-toggle').forEach(btn => {
      btn.onclick = () => confirmModal('提示', '确认切换该账号的启用/停用状态？停用后该账号无法登录。', async () => {
        try {
          await api(`/admin/users/${btn.dataset.id}/toggle`, { method: 'POST' });
          toast('已切换'); reload();
        } catch (e) { toast(e.message, 3000); }
      });
    });
    el.querySelectorAll('.btn-del').forEach(btn => {
      btn.onclick = () => confirmModal('删除账号', '确认删除该账号？', async () => {
        try {
          await api(`/admin/users/${btn.dataset.id}`, { method: 'DELETE' });
          toast('已删除'); reload();
        } catch (e) {
          if (e.has_history) {
            // 存在历史业务记录：风险提示，二次确认后才删除
            confirmModal('风险确认', esc(e.message) + '<br><b style="color:#cf1322">此操作不可恢复，请再次确认。</b>', async () => {
              try {
                await api(`/admin/users/${btn.dataset.id}?force=1`, { method: 'DELETE' });
                toast('已删除'); reload();
              } catch (e2) { toast(e2.message, 3000); }
            }, '仍要删除');
          } else { toast(e.message, 3000); }
        }
      }, '确认删除');
    });
  }

  function editModal(u) {
    const isBuiltin = !!u?.is_builtin;
    const body = modal(u ? `编辑账号：${esc(u.username)}` : '新增账号', `
      ${u ? '' : '<label>用户名 *</label><input id="uf-username">'}
      ${u ? '<label>重置密码（留空则不修改，至少6位）</label><input id="uf-password" type="password">' : '<label>初始密码 *（至少6位）</label><input id="uf-password" type="password">'}
      <label>角色 *${isBuiltin ? '（内置超级管理员角色不可修改）' : ''}</label>
      <select id="uf-role" ${isBuiltin ? 'disabled' : ''}>
        ${Object.entries(ROLE_CN).map(([k, v]) =>
          `<option value="${k}" ${u && u.role === k ? 'selected' : ''}>${v}</option>`).join('')}
      </select>
      <label>姓名（实名）</label><input id="uf-realname" value="${esc(u?.real_name) || ''}">
      <label>身份证号</label><input id="uf-idcard" value="${esc(u?.id_card) || ''}">
      <label>手机号</label><input id="uf-phone" value="${esc(u?.phone) || ''}">
      <div class="modal-actions">
        <button class="btn" onclick="closeModal()" type="button">取 消</button>
        <button class="btn btn-primary" id="uf-save" type="button">保 存</button>
      </div>`);
    body.querySelector('#uf-save').onclick = async () => {
      try {
        if (u) {
          await api(`/admin/users/${u.id}`, {
            method: 'PUT',
            body: {
              role: isBuiltin ? undefined : body.querySelector('#uf-role').value,
              real_name: body.querySelector('#uf-realname').value.trim(),
              id_card: body.querySelector('#uf-idcard').value.trim(),
              phone: body.querySelector('#uf-phone').value.trim(),
              password: body.querySelector('#uf-password').value || undefined,
            },
          });
        } else {
          await api('/admin/users', {
            method: 'POST',
            body: {
              username: body.querySelector('#uf-username').value.trim(),
              password: body.querySelector('#uf-password').value,
              role: body.querySelector('#uf-role').value,
              real_name: body.querySelector('#uf-realname').value.trim(),
              id_card: body.querySelector('#uf-idcard').value.trim(),
              phone: body.querySelector('#uf-phone').value.trim(),
            },
          });
        }
        closeModal(); toast('已保存'); reload();
      } catch (e) { toast(e.message, 3500); }
    };
  }

  el.innerHTML = `
    <div class="card">
      <div class="toolbar">
        <div class="field"><label>关键字</label><input id="acc-kw" placeholder="用户名/姓名/手机号"></div>
        <div class="field"><label>角色</label><select id="acc-role">
          <option value="">全部</option>
          ${Object.entries(ROLE_CN).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}
        </select></div>
        <button class="btn btn-primary" id="acc-search">查 询</button>
        <button class="btn btn-primary" id="acc-add" style="margin-left:auto">+ 新增账号</button>
      </div>
      <div id="acc-table"></div>
    </div>`;
  const reload = () => load(el.querySelector('#acc-kw').value.trim(), el.querySelector('#acc-role').value);
  el.querySelector('#acc-search').onclick = reload;
  el.querySelector('#acc-add').onclick = () => editModal(null);
  load();
};

// ============ 操作日志（支持时间/操作员/操作类型筛选，UC-021）============
Pages.logs = async el => {
  el.innerHTML = `
    <div class="card">
      <div class="toolbar">
        <div class="field"><label>开始日期</label><input type="date" id="lg-start"></div>
        <div class="field"><label>结束日期</label><input type="date" id="lg-end"></div>
        <div class="field"><label>操作员</label><select id="lg-operator"><option value="">全部</option></select></div>
        <div class="field"><label>操作类型</label><select id="lg-action"><option value="">全部</option></select></div>
        <div class="field"><label>内容关键字</label><input id="lg-kw" placeholder="操作内容"></div>
        <button class="btn btn-primary" id="lg-search">查 询</button>
      </div>
      <div id="lg-table"></div>
      <div class="pager">
        <button class="btn btn-sm" id="pg-prev">上一页</button>
        <span id="pg-info"></span>
        <button class="btn btn-sm" id="pg-next">下一页</button>
      </div>
    </div>`;

  let page = 1, total = 0, loaded = false;
  const size = 30;

  async function load() {
    const p = new URLSearchParams({ page, size });
    if (el.querySelector('#lg-start').value) p.set('start', el.querySelector('#lg-start').value);
    if (el.querySelector('#lg-end').value) p.set('end', el.querySelector('#lg-end').value);
    if (el.querySelector('#lg-operator').value) p.set('operator', el.querySelector('#lg-operator').value);
    if (el.querySelector('#lg-action').value) p.set('action', el.querySelector('#lg-action').value);
    if (el.querySelector('#lg-kw').value.trim()) p.set('keyword', el.querySelector('#lg-kw').value.trim());
    const data = await api('/admin/logs?' + p);
    total = data.total;
    if (!loaded) {
      loaded = true;
      el.querySelector('#lg-action').innerHTML =
        '<option value="">全部</option>' + data.actions.map(a => `<option value="${a}">${a}</option>`).join('');
      el.querySelector('#lg-operator').innerHTML =
        '<option value="">全部</option>' + data.operators.map(o => `<option value="${esc(o)}">${esc(o)}</option>`).join('');
    }
    el.querySelector('#pg-info').textContent = `第 ${page} 页 / 共 ${total} 条`;
    el.querySelector('#pg-prev').disabled = page <= 1;
    el.querySelector('#pg-next').disabled = page * size >= total;
    el.querySelector('#lg-table').innerHTML = `
      <table><thead><tr><th>时间</th><th>操作员账号</th><th>角色</th><th>操作</th><th>详情</th></tr></thead><tbody>
      ${data.list.map(l => `<tr>
        <td>${l.created_at}</td><td>${esc(l.username) || '-'}</td>
        <td>${ROLE_CN[l.role] || esc(l.role) || '-'}</td>
        <td><span class="badge badge-blue">${esc(l.action)}</span></td>
        <td style="white-space:normal;max-width:520px">${esc(l.detail) || ''}</td></tr>`).join('')
        || '<tr><td colspan="5" class="empty">系统暂无操作记录</td></tr>'}
      </tbody></table>`;
  }
  el.querySelector('#lg-search').onclick = () => { page = 1; load(); };
  el.querySelector('#pg-prev').onclick = () => { if (page > 1) { page--; load(); } };
  el.querySelector('#pg-next').onclick = () => { if (page * size < total) { page++; load(); } };
  load();
};

// ============ 景区基础信息管理 ============
Pages.scenic = async el => {
  const { info } = await api('/admin/scenic');
  el.innerHTML = `
    <div class="card">
      <h3>景区基础信息管理（发布后展示在系统首页，游客/售票员登录后可浏览）</h3>
      <label>景区介绍</label><textarea id="sc-intro" rows="5">${esc(info.intro) || ''}</textarea>
      <label>优待政策</label><textarea id="sc-policy" rows="5">${esc(info.policy) || ''}</textarea>
      <label>游玩须知</label><textarea id="sc-notice" rows="5">${esc(info.notice) || ''}</textarea>
      <label>票种说明</label><textarea id="sc-desc" rows="5">${esc(info.ticket_desc) || ''}</textarea>
      <button class="btn btn-primary mt" id="sc-save">保存并发布到首页</button>
    </div>`;
  el.querySelector('#sc-save').onclick = async () => {
    try {
      await api('/admin/scenic', {
        method: 'PUT',
        body: {
          intro: el.querySelector('#sc-intro').value,
          policy: el.querySelector('#sc-policy').value,
          notice: el.querySelector('#sc-notice').value,
          ticket_desc: el.querySelector('#sc-desc').value,
        },
      });
      toast('已发布到首页');
    } catch (e) { toast(e.message, 3500); }
  };
};
