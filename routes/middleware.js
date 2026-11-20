// 通用中间件：登录校验与角色校验
function requireLogin(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: '未登录或会话已过期' });
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.session.user) return res.status(401).json({ error: '未登录或会话已过期' });
    if (!roles.includes(req.session.user.role)) return res.status(403).json({ error: '无权访问该功能' });
    next();
  };
}

module.exports = { requireLogin, requireRole };
