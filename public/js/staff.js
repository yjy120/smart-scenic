// 售票员端：窗口开单售票、入园出园登记、订单管理（退票/换票/审核）、个人日结
// （超级管理员无以上现场业务操作权限，仅后台查询管理）

// ============ 窗口开单售票（仅售票员，UC-008）============
Pages.window = el => renderPurchase(el, true);

// ============ 入园 / 出园登记（仅售票员，UC-010/011）============
Pages.register = async el => {
  el.innerHTML = `
    <div class="card">
      <h3>登记查询（订单编号 / 游客姓名 / 手机号）</h3>
      <div class="toolbar">
        <div class="field" style="width:320px"><input id="rg-keyword" placeholder="输入订单编号 / 姓名 / 手机号 回车查询"></div>
        <button class="btn btn-primary" id="rg-search">查 询</button>
        <span style="margin-left:auto" id="rg-inpark"></span>
      </div>
      <div id="rg-result"><div class="empty">输入关键字查询订单，核验后执行入园 / 出园登记</div></div>
    </div>`;

  async function refreshInPark() {
    const d = await api('/stats/daily');
    el.querySelector('#rg-inpark').innerHTML =
      `今日我登记入园 <b>${d.enter_count}</b> 人 · 出园 <b>${d.exit_count}</b> 人 · 我标记在园 <b style="color:#2f6fed">${d.in_park}</b> 人`;
  }

  async function search() {
    const kw = el.querySelector('#rg-keyword').value.trim();
    if (!kw) return;
    const { list } = await api('/orders/lookup?keyword=' + encodeURIComponent(kw));
    el.querySelector('#rg-result').innerHTML = `
      <table><thead><tr>
        <th>订单编号</th><th>游客</th><th>票种</th><th>票价</th><th>状态</th><th>入园时间</th><th>出园时间</th><th>操作</th>
      </tr></thead><tbody>
      ${list.map(o => `
        <tr>
          <td>${esc(o.order_no)}</td>
          <td>${esc(o.visitor_name)}<br><span class="text-muted">${esc(o.visitor_id_card) || ''}</span></td>
          <td>${esc(o.ticket_name)}${o.cert_tip ? `<br><span class="text-muted" style="color:#d46b08">核验：${esc(o.cert_tip)}</span>` : ''}</td>
          <td>${fmtMoney(o.price)}</td><td>${statusBadge(o.status)}</td>
          <td>${o.enter_time || '-'}</td><td>${o.exit_time || '-'}</td>
          <td>
            ${['pending', 'unused'].includes(o.status)
              ? `<button class="btn btn-sm btn-primary btn-enter" data-id="${o.id}">标记已入园</button>` : ''}
            ${o.status === 'entered'
              ? `<button class="btn btn-sm btn-exit" data-id="${o.id}">标记已出园</button>` : ''}
          </td>
        </tr>`).join('') || '<tr><td colspan="8" class="empty">未查询到订单</td></tr>'}
      </tbody></table>`;

    el.querySelectorAll('.btn-enter').forEach(btn => {
      btn.onclick = () => confirmModal('入园登记', '确认该订单游客已核验通过，标记为【已入园】？', async () => {
        try {
          await api(`/orders/${btn.dataset.id}/enter`, { method: 'POST' });
          toast('已登记入园'); search(); refreshInPark();
        } catch (e) { toast(e.message, 3000); }
      });
    });
    el.querySelectorAll('.btn-exit').forEach(btn => {
      btn.onclick = () => confirmModal('出园登记', '确认标记该订单为【已出园】？', async () => {
        try {
          await api(`/orders/${btn.dataset.id}/exit`, { method: 'POST' });
          toast('已登记出园'); search(); refreshInPark();
        } catch (e) { toast(e.message, 3000); }
      });
    });
  }

  el.querySelector('#rg-search').onclick = search;
  el.querySelector('#rg-keyword').onkeydown = e => { if (e.key === 'Enter') search(); };
  refreshInPark();
};

// ============ 订单管理（售票员：仅自己操作的订单；退票/换票/审核）============
Pages.orders = async el => {
  const { list: types } = await api('/ticket-types');
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
        <div class="field"><label>关键字</label><input id="f-kw" placeholder="订单号/姓名/手机号"></div>
        <button class="btn btn-primary" id="f-search">查 询</button>
      </div>
      <p class="text-muted" style="margin-bottom:10px">数据范围：仅展示本人账号操作的订单（窗口售票、入园/出园登记、退票处理）。</p>
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
    if (el.querySelector('#f-kw').value.trim()) p.set('keyword', el.querySelector('#f-kw').value.trim());
    const data = await api('/orders?' + p);
    total = data.total; lastList = data.list;
    el.querySelector('#pg-info').textContent = `第 ${page} 页 / 共 ${total} 条`;
    el.querySelector('#pg-prev').disabled = page <= 1;
    el.querySelector('#pg-next').disabled = page * size >= total;

    el.querySelector('#order-table').innerHTML = `
      <table><thead><tr>
        <th>订单编号</th><th>游客</th><th>票种</th><th>票价</th><th>来源</th><th>下单时间</th><th>状态</th><th>退票原因</th><th>操作</th>
      </tr></thead><tbody>
      ${data.list.map(o => `<tr>
        <td><a href="javascript:void(0)" class="lnk-detail" data-id="${o.id}" style="color:#2f6fed">${esc(o.order_no)}</a></td>
        <td>${esc(o.visitor_name)}<br><span class="text-muted">${esc(o.visitor_phone) || ''}</span></td>
        <td>${esc(o.ticket_name)}</td><td>${fmtMoney(o.price)}</td>
        <td>${o.source === 'window' ? '窗口' : '线上'}</td>
        <td>${o.created_at}</td><td>${statusBadge(o.status)}</td>
        <td class="text-muted">${esc(o.refund_reason) || ''}</td>
        <td>
          ${['pending', 'unused', 'entered'].includes(o.status)
            ? `<button class="btn btn-sm btn-danger btn-refund" data-id="${o.id}">退票</button>` : ''}
          ${['pending', 'unused'].includes(o.status)
            ? `<button class="btn btn-sm btn-exchange" data-id="${o.id}">换票</button>` : ''}
          ${o.status === 'refunding'
            ? `<button class="btn btn-sm btn-primary btn-review" data-id="${o.id}">审核退票</button>` : ''}
        </td></tr>`).join('') || '<tr><td colspan="9" class="empty">暂无订单</td></tr>'}
      </tbody></table>`;

    el.querySelectorAll('.lnk-detail').forEach(a => {
      a.onclick = () => showOrderDetail(lastList.find(o => o.id == a.dataset.id));
    });

    // 直接退票（登记退票实际原因，UC-014）
    el.querySelectorAll('.btn-refund').forEach(btn => {
      btn.onclick = () => {
        const body = modal('退票处理', `
          <label>退票实际原因 *</label><textarea id="rf-reason" rows="3"></textarea>
          <div class="modal-actions">
            <button class="btn" onclick="closeModal()" type="button">取 消</button>
            <button class="btn btn-danger" id="rf-ok" type="button">确认退票</button>
          </div>`);
        body.querySelector('#rf-ok').onclick = async () => {
          const reason = body.querySelector('#rf-reason').value.trim();
          if (!reason) return toast('请登记退票原因');
          try {
            await api(`/orders/${btn.dataset.id}/refund`, { method: 'POST', body: { reason } });
            closeModal(); toast('已退票'); load();
          } catch (e) { toast(e.message, 3000); }
        };
      };
    });

    // 换票（UC-016）
    el.querySelectorAll('.btn-exchange').forEach(btn => {
      btn.onclick = () => {
        const body = modal('换票', `
          <label>换为新票种</label>
          <select id="ex-type">${types.map(t =>
            `<option value="${t.id}">${esc(t.name)}（${fmtMoney(t.price)}）</option>`).join('')}</select>
          <label>换票原因</label><input id="ex-reason">
          <div class="modal-actions">
            <button class="btn" onclick="closeModal()" type="button">取 消</button>
            <button class="btn btn-primary" id="ex-ok" type="button">确认换票</button>
          </div>`);
        body.querySelector('#ex-ok').onclick = async () => {
          try {
            await api(`/orders/${btn.dataset.id}/exchange`, {
              method: 'POST',
              body: {
                new_ticket_type_id: body.querySelector('#ex-type').value,
                reason: body.querySelector('#ex-reason').value.trim(),
              },
            });
            closeModal(); toast('已换票'); load();
          } catch (e) { toast(e.message, 3000); }
        };
      };
    });

    // 审核游客退票申请（UC-014 同意 / UC-015 驳回，均需填写原因）
    el.querySelectorAll('.btn-review').forEach(btn => {
      btn.onclick = () => {
        const target = lastList.find(o => o.id == btn.dataset.id);
        const body = modal('审核退票申请 ' + esc(target.order_no), `
          <p class="text-muted">游客申请理由：${esc(target.refund_reason) || '未填写'}</p>
          <label>${''}<input hidden></label>
          <label>审核意见 / 原因 *</label><input id="rv-note" placeholder="同意时填退票实际原因；驳回时填拒绝原因">
          <div class="modal-actions">
            <button class="btn" id="rv-reject" type="button">驳 回</button>
            <button class="btn btn-primary" id="rv-approve" type="button">同意退票</button>
          </div>`);
        const review = approve => async () => {
          const note = body.querySelector('#rv-note').value.trim();
          if (!note) return toast(approve ? '请填写退票实际原因' : '请填写拒绝退票原因');
          try {
            await api(`/orders/${btn.dataset.id}/refund-review`, {
              method: 'POST', body: { approve, reason: note },
            });
            closeModal(); toast(approve ? '已同意退票' : '已驳回，订单恢复未入园状态'); load();
          } catch (e) { toast(e.message, 3000); }
        };
        body.querySelector('#rv-approve').onclick = review(true);
        body.querySelector('#rv-reject').onclick = review(false);
      };
    });
  }

  el.querySelector('#f-search').onclick = () => { page = 1; load(); };
  el.querySelector('#pg-prev').onclick = () => { if (page > 1) { page--; load(); } };
  el.querySelector('#pg-next').onclick = () => { if (page * size < total) { page++; load(); } };
  load();
};

// ============ 我的日结（售票员个人基础日结，UC-017/018：仅本人数据）============
Pages.daily = async el => {
  el.innerHTML = `
    <div class="card">
      <div class="toolbar">
        <div class="field"><label>日期</label><input type="date" id="d-date" value="${todayStr()}"></div>
        <button class="btn btn-primary" id="d-search">查询当日</button>
        <div class="field"><label>时间段起</label><input type="date" id="d-start"></div>
        <div class="field"><label>时间段止</label><input type="date" id="d-end"></div>
        <button class="btn" id="d-range">按时间段统计</button>
      </div>
      <p class="text-muted" style="margin-bottom:10px">数据范围：仅本人账号业务数据（自己窗口售票、自己标记入园出园、自己处理退票），不含其他售票员数据。</p>
      <div class="stat-grid" id="d-stats"></div>
    </div>`;

  function renderCards(d) {
    el.querySelector('#d-stats').innerHTML = `
      <div class="stat-card"><div class="label">我的窗口售票总额</div><div class="num">${fmtMoney(d.sale_amount)}</div></div>
      <div class="stat-card"><div class="label">我的窗口售票张数</div><div class="num">${d.sale_count}</div></div>
      <div class="stat-card"><div class="label">我标记入园人数</div><div class="num">${d.enter_count}</div></div>
      <div class="stat-card"><div class="label">我标记出园人数</div><div class="num">${d.exit_count}</div></div>
      <div class="stat-card"><div class="label">我标记在园人数</div><div class="num">${d.in_park}</div></div>
      <div class="stat-card"><div class="label">我处理退款（${d.refund_count}笔）</div><div class="num">${fmtMoney(d.refund_amount)}</div></div>`;
  }
  async function loadDate() {
    try {
      const d = await api('/stats/daily?date=' + el.querySelector('#d-date').value);
      renderCards(d);
    } catch (e) { toast(e.message, 3000); }
  }
  async function loadRange() {
    const s = el.querySelector('#d-start').value, e2 = el.querySelector('#d-end').value;
    if (!s || !e2) return toast('请选择统计时间段');
    try {
      const d = await api(`/stats/daily?start=${s}&end=${e2}`);
      renderCards(d);
    } catch (e) { toast(e.message, 3000); }
  }
  el.querySelector('#d-search').onclick = loadDate;
  el.querySelector('#d-range').onclick = loadRange;
  loadDate();
};
