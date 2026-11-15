-- =====================================================================
-- 12_medicine_barcode.sql —— 药品条码字段
--
-- 目标：拍照识药时视觉模型读取药盒上的条形码/监管码号码，落库到
--   medicine.barcode，为「同条码重复添加去重 / 扫码快速匹配」预留依据。
-- 幂等：用 information_schema 判断字段是否存在，不存在才 ALTER。
-- =====================================================================

SET @has_barcode = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'medicine'
    AND COLUMN_NAME = 'barcode'
);

SET @ddl = IF(@has_barcode = 0,
  'ALTER TABLE `medicine` ADD COLUMN `barcode` VARCHAR(64) DEFAULT NULL COMMENT ''药盒条形码/监管码号码（拍照识药读取，可用于同条码去重）'' AFTER `active_ingredient`',
  'SELECT 1'
);

PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;