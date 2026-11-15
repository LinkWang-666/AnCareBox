-- ============================================================
-- 03_auth.sql —— 身份认证与授权相关的表结构变更
-- 执行顺序：01_schema.sql → 02_seed.sql → 本文件 → 脚本生成账号
--
-- 说明：MySQL 不支持 "ADD COLUMN IF NOT EXISTS"，
--       下面的 ALTER 用 information_schema 先判断再执行，因此可重复运行不会报错。
-- ============================================================

USE `smart_medbox`;

-- ============================================================
-- 1. user 表：加令牌版本号
--    用途：JWT 签发后无法主动收回，靠这个字段实现「登出 / 改密后旧令牌立即失效」
--    做法：令牌里带上 token_version，校验时与库中比对；改密或登出时 +1
-- ============================================================
SET @db = DATABASE();
SET @has_col = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'user' AND COLUMN_NAME = 'token_version'
);
SET @s = IF(@has_col = 0,
  'ALTER TABLE `user` ADD COLUMN `token_version` INT UNSIGNED NOT NULL DEFAULT 0 COMMENT ''令牌版本号：登出/改密时+1，使旧JWT立即失效''',
  'SELECT ''token_version 已存在，跳过'' AS msg');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- ============================================================
-- 2. medbox 表：加绑定码与设备令牌版本
--    bind_code          子女在控制台生成的 6 位码，药箱凭它换取长期令牌
--    bind_code_expires   5 分钟有效，过期作废
--    token_version      子女「解绑此设备」时 +1，设备令牌立即失效
-- ============================================================
SET @has_col = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'medbox' AND COLUMN_NAME = 'bind_code'
);
SET @s = IF(@has_col = 0,
  'ALTER TABLE `medbox`
     ADD COLUMN `bind_code`          VARCHAR(10)  DEFAULT NULL COMMENT ''6位绑定码，药箱凭此换取设备令牌'',
     ADD COLUMN `bind_code_expires_at` DATETIME   DEFAULT NULL COMMENT ''绑定码过期时间（生成后5分钟）'',
     ADD COLUMN `token_version`      INT UNSIGNED NOT NULL DEFAULT 0 COMMENT ''设备令牌版本号：解绑时+1，旧令牌立即失效''',
  'SELECT ''bind_code 已存在，跳过'' AS msg');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- ============================================================
-- 3. 审计日志表：配置变更留痕
--    为什么必须留痕：改错剂量是要出事的，必须能追溯「谁、何时、把什么改成了什么」
-- ============================================================
CREATE TABLE IF NOT EXISTS `audit_log` (
  `id`          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `user_id`     BIGINT UNSIGNED DEFAULT NULL COMMENT '操作人 → user.id（NULL=系统或设备）',
  `family_id`   BIGINT UNSIGNED DEFAULT NULL COMMENT '所属家庭 → family.id',
  `action`      VARCHAR(50)  NOT NULL          COMMENT '动作：create/update/delete/login/bind/sos ...',
  `target_type` VARCHAR(50)  NOT NULL          COMMENT '对象类型：medicine/schedule/elder/medbox ...',
  `target_id`   BIGINT UNSIGNED DEFAULT NULL   COMMENT '对象ID',
  `before_json` JSON         DEFAULT NULL      COMMENT '变更前快照',
  `after_json`  JSON         DEFAULT NULL      COMMENT '变更后快照',
  `ip`          VARCHAR(45)  DEFAULT NULL      COMMENT '来源IP',
  `created_at`  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_audit_family` (`family_id`, `created_at`),
  KEY `idx_audit_target` (`target_type`, `target_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='审计日志：配置变更留痕，便于追溯误操作';

-- ============================================================
-- 4. 第二个演示家庭（李家）
--    用途：验证「横向越权」防护 —— 用王家的账号访问李家的数据，应当被拦截
--    注意：账号不在这里创建，密码需要 bcrypt 哈希，由 scripts/seed-auth.js 生成
-- ============================================================
INSERT IGNORE INTO `family` (`id`, `name`, `contact_phone`) VALUES
  (2, '李家', '13900000002');

INSERT IGNORE INTO `elder` (`id`, `family_id`, `name`, `gender`, `birth_date`, `age`,
                            `hearing_level`, `vision_level`, `chronic_diseases`,
                            `volume_level`, `speech_rate`, `timeout_minutes`)
  VALUES (2, 2, '李奶奶', 'female', '1946-05-12', 80, 'moderate', 'mild', '冠心病', 4, 'slow', 25);

INSERT IGNORE INTO `medbox` (`id`, `family_id`, `elder_id`, `device_code`, `compartment_count`, `status`)
  VALUES (2, 2, 2, 'MB-2026-0002', 7, 'offline');

-- 李家的药箱隔间
INSERT IGNORE INTO `compartment` (`medbox_id`, `slot_no`, `label`, `is_locked`) VALUES
  (2,1,'第1格',1),(2,2,'第2格',1),(2,3,'第3格',1),(2,4,'第4格',1),
  (2,5,'第5格',1),(2,6,'第6格',1),(2,7,'第7格',1);

-- 李家的药品（ID 从 10 起，避免与王家的 1-6 冲突）
INSERT IGNORE INTO `medicine` (`id`, `family_id`, `name`, `spec`, `unit`, `stock_qty`, `stock_alert_qty`)
  VALUES (10, 2, '阿托伐他汀钙片', '20mg*7片', '片', 20, 7);

-- 李家的服药计划：早上 8 点吃阿托伐他汀，放第 1 格
INSERT IGNORE INTO `schedule` (`id`, `elder_id`, `compartment_id`, `dose_time`, `time_label`,
                               `window_before_min`, `window_after_min`)
  VALUES (10, 2, 8, '08:00:00', '早上', 10, 30);

INSERT IGNORE INTO `schedule_item` (`schedule_id`, `medicine_id`, `dose_qty`, `note`)
  VALUES (10, 10, 1, '睡前服用');

-- ============================================================
-- 执行完成提示
-- ============================================================
SELECT '03_auth.sql 执行完成' AS result,
       (SELECT COUNT(*) FROM `family`)   AS 家庭数,
       (SELECT COUNT(*) FROM `elder`)    AS 老人数,
       (SELECT COUNT(*) FROM `medbox`)   AS 药箱数;
