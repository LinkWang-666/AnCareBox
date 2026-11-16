-- =====================================================================
-- 07_ingredient.sql —— 药品主要成分字段 + 存量回填
--
-- 目标：让「用药冲突检测」从「药名关键词」升级为「成分级」精准匹配。
--   - medicine 表新增 active_ingredient（主要成分，逗号分隔）
--   - 回填演示数据里已有药品的成分
-- 幂等：可重复执行。
-- =====================================================================

-- 1) 新增字段：用 information_schema 判断，已存在则跳过
--    01_schema.sql 已含该列（新库直接建全），本段只在老库升级时真正执行
SET @has_ing = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'medicine'
    AND COLUMN_NAME = 'active_ingredient'
);
SET @ddl = IF(@has_ing = 0,
  'ALTER TABLE `medicine` ADD COLUMN `active_ingredient` VARCHAR(300) DEFAULT NULL COMMENT ''主要成分（逗号分隔，用于用药相互作用检测，仅作提示不构成医疗建议）'' AFTER `contraindication`',
  'SELECT 1'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 2) 回填现有药品的主要成分（按药名精确匹配，未匹配到的不动）
UPDATE `medicine` SET `active_ingredient` = '氨氯地平'                 WHERE `name` = '苯磺酸氨氯地平片';
UPDATE `medicine` SET `active_ingredient` = '二甲双胍'                 WHERE `name` = '盐酸二甲双胍缓释片';
UPDATE `medicine` SET `active_ingredient` = '阿托伐他汀'               WHERE `name` = '阿托伐他汀钙片';
UPDATE `medicine` SET `active_ingredient` = '阿司匹林'                 WHERE `name` = '阿司匹林肠溶片';
UPDATE `medicine` SET `active_ingredient` = '格列美脲'                 WHERE `name` = '格列美脲片';
UPDATE `medicine` SET `active_ingredient` = '单硝酸异山梨酯'           WHERE `name` = '单硝酸异山梨酯缓释片';
UPDATE `medicine` SET `active_ingredient` = '美托洛尔'                 WHERE `name` = '酒石酸美托洛尔缓释片';
