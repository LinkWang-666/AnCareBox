-- =====================================================================
-- 09_medicine_expiry_category.sql —— 药品效期 + 分类字段
--
-- 目标：支撑「药箱库存与效期」页（队友 UI 的 inventory 视图）：
--   - expiry_date  效期（用于效期时间线 / 临期提醒 / 过期处理）
--   - category     功能分类（用于「在库药品构成」按类别统计）
-- 幂等：用 information_schema 判断字段是否存在，不存在才 ALTER。
-- =====================================================================

-- 1) expiry_date 字段
SET @has_exp = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'medicine'
    AND COLUMN_NAME = 'expiry_date'
);
SET @ddl = IF(@has_exp = 0,
  'ALTER TABLE `medicine` ADD COLUMN `expiry_date` DATE DEFAULT NULL COMMENT ''效期（过期日期，用于临期/过期提醒）'' AFTER `stock_alert_qty`',
  'SELECT 1'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 2) category 字段
SET @has_cat = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'medicine'
    AND COLUMN_NAME = 'category'
);
SET @ddl = IF(@has_cat = 0,
  'ALTER TABLE `medicine` ADD COLUMN `category` VARCHAR(50) DEFAULT NULL COMMENT ''功能分类，如「降压/降糖/调脂/心血管/营养补充/其他」'' AFTER `expiry_date`',
  'SELECT 1'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 3) 回填演示药品的分类与效期（按药名精确匹配，未匹配到的不动）
UPDATE `medicine` SET `category` = '降压',   `expiry_date` = '2026-04-30' WHERE `name` = '苯磺酸氨氯地平片';
UPDATE `medicine` SET `category` = '降糖',   `expiry_date` = '2027-02-28' WHERE `name` = '盐酸二甲双胍缓释片';
UPDATE `medicine` SET `category` = '调脂',   `expiry_date` = '2027-01-31' WHERE `name` = '阿托伐他汀钙片';
UPDATE `medicine` SET `category` = '心血管', `expiry_date` = '2027-06-30' WHERE `name` = '阿司匹林肠溶片';
UPDATE `medicine` SET `category` = '降糖',   `expiry_date` = '2026-11-08' WHERE `name` = '格列美脲片';
UPDATE `medicine` SET `category` = '心血管', `expiry_date` = '2026-09-30' WHERE `name` = '单硝酸异山梨酯缓释片';
UPDATE `medicine` SET `category` = '心血管', `expiry_date` = '2027-05-31' WHERE `name` = '酒石酸美托洛尔缓释片';
