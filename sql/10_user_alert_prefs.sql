-- =====================================================================
-- 10_user_alert_prefs.sql —— 家庭成员告警订阅偏好
--
-- 目标：支撑「家庭成员」页（队友 UI 的 family 视图）里每个成员的
--   「订阅哪些告警类型」设置。存逗号分隔的告警类型列表，空 = 全部。
-- 幂等：用 information_schema 判断字段是否存在，不存在才 ALTER。
-- =====================================================================

SET @has_pref = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'user'
    AND COLUMN_NAME = 'alert_prefs'
);
SET @ddl = IF(@has_pref = 0,
  'ALTER TABLE `user` ADD COLUMN `alert_prefs` VARCHAR(200) DEFAULT NULL COMMENT ''告警订阅偏好（逗号分隔：missed,duplicate,night,offline,stock,conflict,sos,repeat；NULL=全部）'' AFTER `push_enabled`',
  'SELECT 1'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
