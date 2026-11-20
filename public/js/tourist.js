// 游客端：在线购票（含规则型智能提示）、我的订单、游玩记录
// 购票页面同时复用于售票员【窗口开单售票】（isWindow=true）

function validRangeText(t) {
  if (t.valid_start && t.valid_end) return `${t.valid_start} ~ ${t.valid_end}`;
  if (t.valid_start) return `${t.valid_start} 起`;
  if (t.valid_end) return `${t.valid_end} 止`;
  return '不限';
}

async function renderPurchase(el, isWindow) {
  const { list } = await api('/ticket-types'); // 售票员/游客接口只返回启用票种，停用票种不可选

  el.innerHTML = `
    ${isWindow ? '<div class="notice">窗口开单售票：录入游客实名信息生成订单，订单绑定当前售票员账号；实名信息将自动生成游客账号（初始密码为证件号后6位）。</div>' : ''}
    <div class="ticket-grid">
      ${list.map(t => `
        <div class="ticket-card">
          <h4>${esc(t.name)}</h4>
          <div class="price">${fmtMoney(t.price)} <small>/ 张</small></div>
          <p>有效期：${validRangeText(t)}　${t.need_real_name ? '需实名' : '无需实名'}</p>
          <p>${t.daily_limit > 0
            ? (t.remaining_today > 0 ? `今日剩余可售：<b>${t.remaining_today}</b> 张` : '<b style="color:#cf1322">今日已售罄</b>')
            : '不限单日售票量'}</p>
          ${t.cert_tip ? `<p class="text-muted">核验提示：${esc(t.cert_tip)}</p>` : ''}
          <button class="btn btn-primary btn-block btn-buy" data-id="${t.id}"
            ${t.remaining_today === 0 ? 'disabled' : ''}>
            ${t.remaining_today === 0 ? '已售罄' : '购 票'}
          </button>
        </div>`).join('') || '<div class="empty">暂无可用票种</div>'}
    </div>`;

  el.querySelectorAll('.btn-buy').forEach(btn => {
    btn.onclick = () => openPurchaseModal(list.find(t => t.id == btn.dataset.id), isWindow);
  });
}

function openPurchaseModal(tt, isWindow) {
  // 规则型智能提示1：优待票等票种的证件核验提示（游客购票页 / 售票员窗口售票页均展示）
  const certTipHtml = tt.cert_tip ? `<div class="notice">证件核验提示：${esc(tt.cert_tip)}</div>` : '';
  // 规则型智能提示2：临近单日售票上限预警 / 售罄禁止下单
  let limitHtml = '';
  if (tt.daily_limit > 0) {
    if (tt.remaining_today <= 0) {
      limitHtml = '<div class="notice notice-danger">该票种今日已达单日售票上限，禁止下单。</div>';
    } else if (tt.remaining_today <= Math.max(10, tt.daily_limit * 0.2)) {
      limitHtml = `<div class="notice">临近单日售票上限，今日剩余可售 <b>${tt.remaining_today}</b> 张，请尽快下单。</div>`;
    } else {
      limitHtml = `<div class="notice">今日剩余可售 <b>${tt.remaining_today}</b> 张。</div>`;
    }
  }

  const body = modal(`购买「${esc(tt.name)}」 ${fmtMoney(tt.price)}/张`, `
    ${certTipHtml}${limitHtml}
    <div id="visitor-list"></div>
    <button class="btn btn-sm mt" id="add-visitor" type="button">+ 添加一位游客</button>
    <div class="modal-actions">
      <span style="margin-right:auto;line-height:32px">合计：<b id="total-price" style="color:#f5222d"></b></span>
      <button class="btn" id="pv-cancel" type="button">取 消</button>
      <button class="btn btn-primary" id="pv-submit" type="button" ${tt.remaining_today === 0 ? 'disabled' : ''}>提交订单</button>
    </div>`);

  const listEl = body.querySelector('#visitor-list');
  const addVisitor = () => {
    const div = document.createElement('div');
    div.className = 'card';
    div.style.padding = '10px 12px';
    div.innerHTML = `
      <div class="row">
        <div><label>姓名 *</label><input class="v-name"></div>
        <div><label>身份证号${tt.need_real_name ? ' *' : ''}</label><input class="v-idcard"></div>
        <div><label>手机号</label><input class="v-phone"></div>
      </div>`;
    listEl.appendChild(div);
    updateTotal();
  };
  const updateTotal = () => {
    body.querySelector('#total-price').textContent =
      fmtMoney(tt.price * listEl.children.length);
  };
  addVisitor();
  body.querySelector('#add-visitor').onclick = () => {
    if (listEl.children.length >= 10) return toast('单次最多购买10张');
    if (tt.daily_limit > 0 && listEl.children.length >= tt.remaining_today) {
      return toast(`售罄预警：今日剩余可售 ${tt.remaining_today} 张`);
    }
    addVisitor();
  };
  body.querySelector('#pv-cancel').onclick = closeModal;
  body.querySelector('#pv-submit').onclick = async () => {
    const visitors = [...listEl.children].map(d => ({
      name: d.querySelector('.v-name').value.trim(),
      id_card: d.querySelector('.v-idcard').value.trim(),
      phone: d.querySelector('.v-phone').value.trim(),
    }));
    if (visitors.some(v => !v.name)) return toast('每位游客均需填写姓名');
    if (tt.need_real_name && visitors.some(v => !v.id_card)) {
      return toast(`「${tt.name}」为实名票，实名信息（身份证号）不能为空`, 3000);
    }
    try {
      const r = await api('/orders/purchase', { method: 'POST', body: { ticket_type_id: tt.id, visitors } });
      closeModal();
      modal('下单成功', `
        <p style="line-height:2">共 ${r.order_nos.length} 张，合计 <b style="color:#f5222d">${fmtMoney(r.total)}</b></p>
        <p class="text-muted" style="word-break:break-all;line-height:1.8">订单号：${r.order_nos.map(esc).join('<br>')}</p>
        <div class="modal-actions"><button class="btn btn-primary" onclick="closeModal()" type="button">好 的</button></div>`);
      route(); // 刷新剩余可售数量
    } catch (e) { toast(e.message, 3500); }
  };
}

// 游客：在线购票
Pages.buy = el => renderPurchase(el, false);

// 订单详情弹窗（各角色订单页共用）
function showOrderDetail(o) {
  modal('订单详情 ' + esc(o.order_no), `
    <table style="margin-bottom:6px"><tbody>
      <tr><th style="width:110px">订单编号</th><td>${esc(o.order_no)}</td><th style="width:90px">状态</th><td>${statusBadge(o.status)}</td></tr>
      <tr><th>票种</th><td>${esc(o.ticket_name)}</td><th>票价</th><td>${fmtMoney(o.price)}</td></tr>
      <tr><th>游客姓名</th><td>${esc(o.visitor_name)}</td><th>身份证号</th><td>${esc(o.visitor_id_card) || '-'}</td></tr>
      <tr><th>手机号</th><td>${esc(o.visitor_phone) || '-'}</td><th>来源</th><td>${o.source === 'window' ? '售票员窗口开单' : '游客自主购票'}</td></tr>
      <tr><th>购票时间</th><td>${o.created_at}</td><th>窗口售票员</th><td>${esc(o.operator_name) || '-'}</td></tr>
      <tr><th>入园时间</th><td>${o.enter_time || '-'}</td><th>登记售票员</th><td>${esc(o.enter_operator_name) || '-'}</td></tr>
      <tr><th>出园时间</th><td>${o.exit_time || '-'}</td><th>登记售票员</th><td>${esc(o.exit_operator_name) || '-'}</td></tr>
      <tr><th>退票时间</th><td>${o.refund_time || '-'}</td><th>处理售票员</th><td>${esc(o.refund_operator_name) || '-'}</td></tr>
      <tr><th>退票原因</th><td colspan="3" style="white-space:normal">${esc(o.refund_reason) || '-'}</td></tr>
      ${o.cert_tip ? `<tr><th>证件提示</th><td colspan="3" style="white-space:normal">${esc(o.cert_tip)}</td></tr>` : ''}
    </tbody></table>
    <div class="modal-actions"><button class="btn btn-primary" onclick="closeModal()" type="button">关 闭</button></div>`);
}

// 游客：我的订单（仅本人订单，可对未入园订单发起退票申请）
Pages['my-orders'] = async el => {
  el.innerHTML = `
    <div class="card">
      <div class="toolbar">
        <div class="field"><label>开始日期</label><input type="date" id="f-start"></div>
        <div class="field"><label>结束日期</label><input type="date" id="f-end"></div>
        <div class="field"><label>状态</label><select id="f-status">
          <option value="">全部</option>
          ${Object.entries(STATUS_BADGE).map(([k, [v]]) => `<option value="${k}">${v}</option>`).join('')}
        </select></div>
        <button class="btn btn-primary" id="f-search">查 询</button>
      </div>
      <div id="order-table"></div>
    </div>`;

  async function load() {
    const p = new URLSearchParams();
    if (el.querySelector('#f-start').value) p.set('start', el.querySelector('#f-start').value);
    if (el.querySelector('#f-end').value) p.set('end', el.querySelector('#f-end').value);
    if (el.querySelector('#f-status').value) p.set('status', el.querySelector('#f-status').value);
    p.set('size', 50);
    const { list } = await api('/orders?' + p);
    el.querySelector('#order-table').innerHTML = `
      <table><thead><tr>
        <th>订单编号</th><th>票种</th><th>票价</th><th>购票时间</th><th>状态</th><th>入园时间</th><th>出园时间</th><th>操作</th>
      </tr></thead><tbody>
      ${list.map(o => `<tr>
        <td><a href="javascript:void(0)" class="lnk-detail" data-id="${o.id}" style="color:#2f6fed">${esc(o.order_no)}</a></td>
        <td>${esc(o.ticket_name)}</td><td>${fmtMoney(o.price)}</td>
        <td>${o.created_at}</td><td>${statusBadge(o.status)}</td>
        <td>${o.enter_time || '-'}</td><td>${o.exit_time || '-'}</td>
        <td>${['pending', 'unused'].includes(o.status)
          ? `<button class="btn btn-sm btn-danger btn-refund" data-id="${o.id}">申请退票</button>` : ''}
          ${o.status === 'refunded' ? `<span class="text-muted">${esc(o.refund_reason) || ''}</span>` : ''}
        </td></tr>`).join('') || '<tr><td colspan="8" class="empty">暂无订单</td></tr>'}
      </tbody></table>`;

    el.querySelectorAll('.lnk-detail').forEach(a => {
      a.onclick = () => showOrderDetail(list.find(o => o.id == a.dataset.id));
    });
    el.querySelectorAll('.btn-refund').forEach(btn => {
      btn.onclick = () => {
        const body = modal('提交退票申请', `
          <p class="text-muted">仅未入园订单可自主申请退票；已入园订单请联系售票员人工处理。</p>
          <label>退票申请理由 *</label><textarea id="rf-reason" rows="3" placeholder="请填写退票申请理由"></textarea>
          <div class="modal-actions">
            <button class="btn" onclick="closeModal()" type="button">取 消</button>
            <button class="btn btn-primary" id="rf-ok" type="button">提交申请</button>
          </div>`);
        body.querySelector('#rf-ok').onclick = async () => {
          const reason = body.querySelector('#rf-reason').value.trim();
          if (!reason) return toast('请填写退票申请理由');
          try {
            await api(`/orders/${btn.dataset.id}/refund-apply`, {
              method: 'POST', body: { reason },
            });
            closeModal(); toast('退票申请已提交，等待售票员审核'); load();
          } catch (e) { toast(e.message, 3000); }
        };
      };
    });
  }
  el.querySelector('#f-search').onclick = load;
  load();
};

// 游客：游玩记录（本人入园/出园记录 + 退票记录）
Pages.records = async el => {
  const { list } = await api('/orders?size=200');
  const entered = list.filter(o => o.enter_time);
  const refunded = list.filter(o => o.status === 'refunded');
  el.innerHTML = `
    <div class="card"><h3>入园 / 出园记录</h3>
      <table><thead><tr><th>订单编号</th><th>票种</th><th>入园时间</th><th>出园时间</th><th>状态</th></tr></thead>
      <tbody>${entered.map(o => `<tr>
        <td>${esc(o.order_no)}</td><td>${esc(o.ticket_name)}</td>
        <td>${o.enter_time}</td><td>${o.exit_time || '<span class="text-muted">在园中</span>'}</td>
        <td>${statusBadge(o.status)}</td></tr>`).join('')
        || '<tr><td colspan="5" class="empty">暂无记录</td></tr>'}</tbody></table>
    </div>
    <div class="card"><h3>退票记录</h3>
      <table><thead><tr><th>订单编号</th><th>票种</th><th>票价</th><th>退票时间</th><th>退票原因</th></tr></thead>
      <tbody>${refunded.map(o => `<tr>
        <td>${esc(o.order_no)}</td><td>${esc(o.ticket_name)}</td><td>${fmtMoney(o.price)}</td>
        <td>${o.refund_time || '-'}</td><td>${esc(o.refund_reason) || '-'}</td></tr>`).join('')
        || '<tr><td colspan="5" class="empty">暂无退票记录</td></tr>'}</tbody></table>
    </div>`;
};
