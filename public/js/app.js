// 应用外壳：会话加载、角色菜单、Hash 路由、首页与个人中心
const Pages = {}; // 各页面渲染函数注册表（tourist.js / staff.js / admin.js 中注册）

const MENUS = {
  tourist: [
    ['home', '首页'], ['buy', '在线购票'], ['my-orders', '我的订单'],
    ['records', '游玩记录'], ['profile', '个人中心'],
  ],
  seller: [
    ['home', '首页'], ['window', '窗口售票'], ['register', '入园/出园登记'],
    ['orders', '订单管理'], ['daily', '我的日结'], ['profile', '个人中心'],
  ],
  admin: [
    ['home', '首页'], ['orders', '订单管理'], ['daily', '日结汇总'],
    ['tickets', '票种管理'], ['reports', '报表统计'], ['accounts', '账号管理'],
    ['logs', '操作日志'], ['scenic', '景区信息管理'], ['profile', '个人中心'],
  ],
};

let ME = null;

async function boot() {
  try {
    const { user } = await api('/auth/me');
    ME = user;
  } catch { return; } // api 内部已跳转登录页
  document.getElementById('user-info').textContent =
    `${ME.real_name || ME.username}（${ROLE_CN[ME.role]}）`;
  renderMenu();
  document.getElementById('btn-logout').onclick = async () => {
    await api('/auth/logout', { method: 'POST' });
    location.href = '/login.html';
  };
  document.getElementById('modal-close').onclick = closeModal;
  document.getElementById('modal-mask').onclick = e => {
    if (e.target.id === 'modal-mask') closeModal();
  };
  window.addEventListener('hashchange', route);
  route();
}

function renderMenu() {
  const menu = MENUS[ME.role] || MENUS.tourist;
  document.getElementById('menu').innerHTML = menu
    .map(([key, name]) => `<a href="#/${key}" data-key="${key}">${name}</a>`).join('');
}

function route() {
  const key = (location.hash.replace('#/', '') || 'home').split('?')[0];
  const valid = (MENUS[ME.role] || []).some(([k]) => k === key);
  const target = valid ? key : 'home';
  document.querySelectorAll('#menu a').forEach(a =>
    a.classList.toggle('active', a.dataset.key === target));
  const menuItem = (MENUS[ME.role] || []).find(([k]) => k === target);
  document.getElementById('page-title').textContent = menuItem ? menuItem[1] : '首页';
  const content = document.getElementById('content');
  content.innerHTML = '';
  (Pages[target] || Pages.home)(content);
}

// ============ 首页：景区介绍/优待政策/游玩须知/票种说明（管理员维护，全员可浏览）============
Pages.home = async el => {
  const { info } = await api('/admin/scenic');
  el.innerHTML = `
    <div class="card home-section"><h3>景区介绍</h3><div>${esc(info.intro) || '<span class="text-muted">暂无内容</span>'}</div></div>
    <div class="card home-section"><h3>优待政策</h3><div>${esc(info.policy)}</div></div>
    <div class="card home-section"><h3>游玩须知</h3><div>${esc(info.notice)}</div></div>
    <div class="card home-section"><h3>票种说明</h3><div>${esc(info.ticket_desc)}</div></div>`;
};

// ============ 个人中心：修改手机号/密码；游客实名信息只读 ============
Pages.profile = async el => {
  el.innerHTML = `
    <div class="card" style="max-width:480px">
      <h3>个人信息</h3>
      <p style="line-height:2">账号：${esc(ME.username)}　角色：${ROLE_CN[ME.role]}</p>
      <p style="line-height:2">姓名：${esc(ME.real_name) || '<span class="text-muted">未填写</span>'}
        ${ME.role === 'tourist' ? '<span class="text-muted">（实名信息不可自行修改，如需变更请联系售票员处理）</span>' : ''}</p>
      <p style="line-height:2">身份证号：${esc(ME.id_card) || '<span class="text-muted">未填写</span>'}</p>
      <label>手机号</label>
      <input id="pf-phone" value="${esc(ME.phone) || ''}">
      <hr style="margin:18px 0;border:none;border-top:1px solid #eee">
      <h3>修改密码</h3>
      <label>原密码</label><input id="pf-old" type="password">
      <label>新密码（至少6位）</label><input id="pf-new" type="password">
      <label>确认新密码</label><input id="pf-new2" type="password">
      <button class="btn btn-primary btn-block" id="pf-save">保 存</button>
    </div>`;
  el.querySelector('#pf-save').onclick = async () => {
    try {
      const newPwd = el.querySelector('#pf-new').value;
      const newPwd2 = el.querySelector('#pf-new2').value;
      if (newPwd && newPwd !== newPwd2) return toast('两次输入的新密码不一致', 3000);
      const { user } = await api('/auth/profile', {
        method: 'PUT',
        body: {
          phone: el.querySelector('#pf-phone').value.trim(),
          old_password: el.querySelector('#pf-old').value || undefined,
          new_password: newPwd || undefined,
        },
      });
      ME = user;
      toast('已保存');
    } catch (e) { toast(e.message, 3000); }
  };
};

boot();
