-- =====================================================================
-- 08_drug_conflict_alert.sql —— 告警中心支持「用药冲突」类型
--
-- alert.alert_type 是 ENUM，需扩展加入 drug_conflict（用药相互作用告警）。
-- 幂等：先查当前 ENUM 是否已含 drug_conflict，没有才 ALTER。
-- =====================================================================

-- 通过 information_schema 判断是否已包含，若已包含则不执行 ALTER。
-- 这里用 SET + 动态 SQL 实现幂等（MySQL 不支持 IF NOT EXISTS 于 ENUM 修改）。
SET @has_type = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'alert'
    AND COLUMN_NAME = 'alert_type'
    AND COLUMN_TYPE LIKE '%drug_conflict%'
);

SET @ddl = IF(@has_type = 0,
  'ALTER TABLE `alert` MODIFY COLUMN `alert_type` ENUM(''missed'',''duplicate'',''night_open'',''repeat_missed'',''offline'',''sos'',''stock_low'',''drug_conflict'') NOT NULL COMMENT ''missed=漏服 duplicate=重复取药 night_open=夜间开箱 repeat_missed=连续漏服 offline=设备离线 sos=老人求助 stock_low=药品不足 drug_conflict=用药相互作用''',
  'SELECT 1'
);

PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
