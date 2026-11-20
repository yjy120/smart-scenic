// API 请求封装 + 通用工具
async function api(path, options = {}) {
  const res = await fetch('/api' + path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  if (res.status === 401 && location.pathname !== '/login.html') {
    location.href = '/login.html';
    throw new Error('未登录');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || '请求失败');
  return data;
}

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtMoney = n => '¥' + Number(n || 0).toFixed(2);
const todayStr = () => new Date().toLocaleDateString('sv');

const STATUS_BADGE = {
  pending: ['待核验', 'badge-orange'], unused: ['未入园', 'badge-blue'],
  entered: ['已入园', 'badge-green'], exited: ['已出园', 'badge-gray'],
  refunding: ['待退票审核', 'badge-orange'], refunded: ['已退票', 'badge-red'],
};
const statusBadge = s => {
  const [text, cls] = STATUS_BADGE[s] || [s, 'badge-gray'];
  return `<span class="badge ${cls}">${text}</span>`;
};
const ROLE_CN = { admin: '超级管理员', seller: '售票员', tourist: '游客' };

function toast(text, ms = 2200) {
  const t = document.getElementById('toast');
  t.textContent = text; t.hidden = false;
  clearTimeout(t._timer);
  t._timer = setTimeout(() => { t.hidden = true; }, ms);
}

// 简单弹窗：modal(title, bodyHtml) -> 返回body元素；调用方自行挂载事件并用 closeModal() 关闭
function modal(title, bodyHtml) {
  document.getElementById('modal-title').textContent = title;
  const body = document.getElementById('modal-body');
  body.innerHTML = bodyHtml;
  document.getElementById('modal-mask').hidden = false;
  return body;
}
function closeModal() { document.getElementById('modal-mask').hidden = true; }

function confirmModal(title, text, onOk, okText = '确 定') {
  const body = modal(title, `<p style="line-height:1.8">${text}</p>
    <div class="modal-actions">
      <button class="btn" id="cf-cancel" type="button">取 消</button>
      <button class="btn btn-primary" id="cf-ok" type="button">${okText}</button>
    </div>`);
  body.querySelector('#cf-cancel').onclick = closeModal;
  body.querySelector('#cf-ok').onclick = async () => { await onOk(); closeModal(); };
}
