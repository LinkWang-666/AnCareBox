-- =====================================================================
-- 11_expiry_alert.sql —— 告警中心支持「效期预警」类型
--
-- alert.alert_type 是 ENUM，需扩展加入 expiry（效期临近/过期主动告警）。
-- 幂等：先查当前 ENUM 是否已含 expiry，没有才 ALTER。
-- =====================================================================

SET @has_type = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'alert'
    AND COLUMN_NAME = 'alert_type'
    AND COLUMN_TYPE LIKE '%expiry%'
);

SET @ddl = IF(@has_type = 0,
  'ALTER TABLE `alert` MODIFY COLUMN `alert_type` ENUM(''missed'',''duplicate'',''night_open'',''repeat_missed'',''offline'',''sos'',''stock_low'',''drug_conflict'',''expiry'') NOT NULL COMMENT ''missed=漏服 duplicate=重复取药 night_open=夜间开箱 repeat_missed=连续漏服 offline=设备离线 sos=老人求助 stock_low=药品不足 drug_conflict=用药相互作用 expiry=效期预警''',
  'SELECT 1'
);

PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;