// 数据库连接与初始化：启动时自动建库、建表、写入种子数据
const mysql = require('mysql2/promise');
const crypto = require('crypto');

// 可通过环境变量覆盖：DB_HOST / DB_PORT / DB_USER / DB_PASSWORD / DB_NAME
const config = {
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || 'YOUR_DB_PASSWORD',
  database: process.env.DB_NAME || 'smart_scenic',
};

// 密码散列（scrypt，无需额外依赖）
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = String(stored || '').split(':');
  if (!salt || !hash) return false;
  const calc = crypto.scryptSync(String(password), salt, 64);
  const expect = Buffer.from(hash, 'hex');
  return calc.length === expect.length && crypto.timingSafeEqual(calc, expect);
}

const pool = mysql.createPool({
  ...config,
  waitForConnections: true,
  connectionLimit: 10,
  dateStrings: true, // DATETIME 直接按字符串返回，避免时区转换问题
});

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  username VARCHAR(50) NOT NULL UNIQUE,
  password VARCHAR(255) NOT NULL,
  role ENUM('admin','seller','tourist') NOT NULL,
  real_name VARCHAR(50) DEFAULT NULL,
  id_card VARCHAR(30) DEFAULT NULL,
  phone VARCHAR(20) DEFAULT NULL,
  status TINYINT NOT NULL DEFAULT 1 COMMENT '1启用 0停用',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS ticket_types (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(50) NOT NULL,
  price DECIMAL(10,2) NOT NULL,
  valid_days INT NOT NULL DEFAULT 1 COMMENT '有效期(天)',
  need_real_name TINYINT NOT NULL DEFAULT 0,
  cert_tip VARCHAR(255) DEFAULT NULL COMMENT '证件核验提示文案',
  daily_limit INT NOT NULL DEFAULT 0 COMMENT '单日售票上限 0=不限',
  status TINYINT NOT NULL DEFAULT 1 COMMENT '1启用 0停用',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS orders (
  id INT AUTO_INCREMENT PRIMARY KEY,
  order_no VARCHAR(32) NOT NULL UNIQUE,
  batch_no VARCHAR(32) DEFAULT NULL COMMENT '同次下单批次号',
  ticket_type_id INT NOT NULL,
  ticket_name VARCHAR(50) NOT NULL,
  price DECIMAL(10,2) NOT NULL COMMENT '成交单价',
  tourist_user_id INT DEFAULT NULL COMMENT '游客账号id，窗口购票为NULL',
  visitor_name VARCHAR(50) NOT NULL,
  visitor_id_card VARCHAR(30) DEFAULT NULL,
  visitor_phone VARCHAR(20) DEFAULT NULL,
  source ENUM('online','window') NOT NULL DEFAULT 'online' COMMENT 'online游客自主 window窗口',
  operator_id INT DEFAULT NULL COMMENT '窗口售票操作员',
  status ENUM('pending','unused','entered','exited','refunding','refunded') NOT NULL DEFAULT 'unused'
    COMMENT 'pending待核验 unused未入园 entered已入园 exited已出园 refunding退票申请中 refunded已退票',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  enter_time DATETIME DEFAULT NULL,
  enter_operator_id INT DEFAULT NULL,
  exit_time DATETIME DEFAULT NULL,
  exit_operator_id INT DEFAULT NULL,
  refund_time DATETIME DEFAULT NULL,
  refund_reason VARCHAR(255) DEFAULT NULL,
  refund_operator_id INT DEFAULT NULL,
  INDEX idx_created (created_at),
  INDEX idx_enter (enter_time),
  INDEX idx_exit (exit_time),
  INDEX idx_status (status),
  INDEX idx_tourist (tourist_user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS operation_logs (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT DEFAULT NULL,
  username VARCHAR(50) DEFAULT NULL,
  role VARCHAR(20) DEFAULT NULL,
  action VARCHAR(50) NOT NULL,
  detail VARCHAR(500) DEFAULT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_created (created_at),
  INDEX idx_action (action)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS scenic_info (
  id INT AUTO_INCREMENT PRIMARY KEY,
  intro TEXT COMMENT '景区介绍',
  policy TEXT COMMENT '优待政策',
  notice TEXT COMMENT '游玩须知',
  ticket_desc TEXT COMMENT '票种说明',
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
`;

async function initDb() {
  // 先不指定数据库连接，建库后再走连接池
  const tmp = await mysql.createConnection({
    host: config.host, port: config.port, user: config.user, password: config.password,
  });
  await tmp.query(`CREATE DATABASE IF NOT EXISTS \`${config.database}\` DEFAULT CHARSET utf8mb4`);
  await tmp.end();

  for (const stmt of SCHEMA.split(';').map(s => s.trim()).filter(Boolean)) {
    await pool.query(stmt);
  }

  // 旧表结构迁移：ticket_types 增加有效期起止日期列
  const [cols] = await pool.query("SHOW COLUMNS FROM ticket_types LIKE 'valid_start'");
  if (cols.length === 0) {
    await pool.query('ALTER TABLE ticket_types ADD COLUMN valid_start DATE DEFAULT NULL COMMENT "有效期起", ADD COLUMN valid_end DATE DEFAULT NULL COMMENT "有效期止" AFTER valid_days');
  }

  // 种子数据：默认账号
  const [[{ c: userCount }]] = await pool.query('SELECT COUNT(*) AS c FROM users');
  if (userCount === 0) {
    const users = [
      ['admin', hashPassword('YOUR_ADMIN_PWD'), 'admin', '系统管理员', null, null],
      ['seller', hashPassword('YOUR_PWD_1'), 'seller', '售票员小张', null, null],
      ['tourist', hashPassword('YOUR_PWD_2'), 'tourist', '张三', '110101199001011234', '13800000000'],
    ];
    for (const u of users) {
      await pool.query(
        'INSERT INTO users (username, password, role, real_name, id_card, phone) VALUES (?,?,?,?,?,?)', u);
    }
    console.log('已创建默认账号: admin/YOUR_ADMIN_PWD, seller/YOUR_PWD_1, tourist/YOUR_PWD_2');
  }

  // 种子数据：票种（有效期起止日期）
  const [[{ c: ttCount }]] = await pool.query('SELECT COUNT(*) AS c FROM ticket_types');
  if (ttCount === 0) {
    const today = new Date().toLocaleDateString('sv');
    const far = (d) => { const t = new Date(); t.setDate(t.getDate() + d); return t.toLocaleDateString('sv'); };
    const types = [
      ['成人票', 120.00, today, far(365), 0, null, 0],
      ['优待票', 60.00, today, far(365), 1, '优待票需现场核验证件：请出示学生证 / 老年证 / 军官证 / 残疾证等有效证件', 200],
      ['团体票', 100.00, today, far(365), 1, '团体票需10人及以上同时入园，请核对带队人身份证件', 0],
      ['套票', 180.00, today, far(180), 0, null, 500],
    ];
    for (const t of types) {
      await pool.query(
        'INSERT INTO ticket_types (name, price, valid_start, valid_end, need_real_name, cert_tip, daily_limit) VALUES (?,?,?,?,?,?,?)', t);
    }
    console.log('已创建示例票种: 成人票/优待票/团体票/套票');
  }

  // 种子数据：景区基础信息（单行）
  const [[{ c: infoCount }]] = await pool.query('SELECT COUNT(*) AS c FROM scenic_info');
  if (infoCount === 0) {
    await pool.query(
      'INSERT INTO scenic_info (intro, policy, notice, ticket_desc) VALUES (?,?,?,?)',
      [
        '欢迎使用智慧景区运营管理系统。此处展示景区介绍，由超级管理员在【景区信息管理】中维护。',
        '优待政策：老人、军人、学生、残疾人等可购买优待票，入园时需出示有效证件。',
        '游玩须知：请遵守景区秩序，爱护环境，注意安全。',
        '票种说明：成人票、优待票、团体票、套票，具体规则以票种管理配置为准。',
      ]);
  }
}

// 操作日志工具
async function logAction(req, action, detail) {
  try {
    const u = (req.session && req.session.user) || {};
    await pool.query(
      'INSERT INTO operation_logs (user_id, username, role, action, detail) VALUES (?,?,?,?,?)',
      [u.id || null, u.username || null, u.role || null, action, String(detail || '').slice(0, 500)]);
  } catch (e) {
    console.error('写操作日志失败:', e.message);
  }
}

module.exports = { pool, initDb, hashPassword, verifyPassword, logAction, dbConfig: config };
