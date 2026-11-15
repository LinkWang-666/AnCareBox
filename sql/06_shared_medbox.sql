-- ============================================================
-- 06_shared_medbox.sql —— 一箱多老人共用升级
-- ============================================================
-- 需求：一台安心格药箱可由多位老人共用（典型场景：老两口合用一台）。
--
-- 设计：
--   1. 新增 medbox_elder 关联表（多对多）；
--   2. medbox.elder_id 保留，含义收窄为「主老人」：
--      设备上报的事件在匹配不到具体老人计划时，默认记到主老人名下；
--   3. 存量数据自动迁移：每个已绑定老人的药箱，其原 elder_id 迁为
--      关联表中的主老人，行为与升级前完全一致。
--
-- 幂等性：可重复执行，不会产生重复数据。
-- ============================================================

USE smart_medbox;

-- ------------------------------------------------------------
-- 一、药箱-老人 关联表
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `medbox_elder` (
  `id`         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `medbox_id`  BIGINT UNSIGNED NOT NULL                COMMENT '药箱 → medbox.id',
  `elder_id`   BIGINT UNSIGNED NOT NULL                COMMENT '使用该药箱的老人 → elder.id',
  `is_primary` TINYINT(1)     NOT NULL DEFAULT 0       COMMENT '是否主老人：上报事件匹配不到计划时的默认归属',
  `created_at` DATETIME       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_me` (`medbox_id`, `elder_id`),
  KEY `idx_me_elder` (`elder_id`),
  CONSTRAINT `fk_me_medbox` FOREIGN KEY (`medbox_id`)
    REFERENCES `medbox`(`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_me_elder` FOREIGN KEY (`elder_id`)
    REFERENCES `elder`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  COMMENT='药箱-老人多对多：一台药箱可由多位老人共用（如老两口）';

-- ------------------------------------------------------------
-- 二、存量迁移：medbox.elder_id → 关联表（升级后行为不变）
-- ------------------------------------------------------------
INSERT IGNORE INTO medbox_elder (medbox_id, elder_id, is_primary)
SELECT id, elder_id, 1
  FROM medbox
 WHERE elder_id IS NOT NULL;

-- ------------------------------------------------------------
-- 三、演示数据：王家药箱1 由「王秀英 + 老伴王守业」共用
--    王秀英用格1-4（早中晚睡前），王守业用格5-6（早/晚，时间错开半小时，
--    避免同一时刻两位老人的服药窗口重叠，方便答辩演示自动匹配）
-- ------------------------------------------------------------
INSERT INTO elder (family_id, name, gender, birth_date, age,
                   chronic_diseases, allergies, hearing_level, vision_level)
SELECT 1, '王守业', 'male', '1947-03-12', 79, '高血压', NULL, 'mild', 'normal'
WHERE NOT EXISTS (SELECT 1 FROM elder WHERE family_id = 1 AND name = '王守业');

SET @ye = (SELECT id FROM elder WHERE family_id = 1 AND name = '王守业' LIMIT 1);

INSERT IGNORE INTO medbox_elder (medbox_id, elder_id, is_primary)
VALUES (1, @ye, 0);

-- 早上 08:30（格5）：氨氯地平 1 片（与王秀英的 08:00 错开）
INSERT INTO schedule (elder_id, compartment_id, dose_time, time_label, window_before_min, window_after_min)
SELECT @ye, 5, '08:30:00', '早上', 10, 30
WHERE NOT EXISTS (SELECT 1 FROM schedule WHERE elder_id = @ye AND dose_time = '08:30:00');
SET @s1 = (SELECT id FROM schedule WHERE elder_id = @ye AND dose_time = '08:30:00' LIMIT 1);

-- 晚上 18:30（格6）：氨氯地平 1 片
INSERT INTO schedule (elder_id, compartment_id, dose_time, time_label, window_before_min, window_after_min)
SELECT @ye, 6, '18:30:00', '晚上', 10, 30
WHERE NOT EXISTS (SELECT 1 FROM schedule WHERE elder_id = @ye AND dose_time = '18:30:00');
SET @s2 = (SELECT id FROM schedule WHERE elder_id = @ye AND dose_time = '18:30:00' LIMIT 1);

INSERT INTO schedule_item (schedule_id, medicine_id, dose_qty, note)
SELECT @s1, 1, 1.00, '早餐后温水送服（王守业）'
WHERE NOT EXISTS (SELECT 1 FROM schedule_item WHERE schedule_id = @s1);

INSERT INTO schedule_item (schedule_id, medicine_id, dose_qty, note)
SELECT @s2, 1, 1.00, '晚餐后服用（王守业）'
WHERE NOT EXISTS (SELECT 1 FROM schedule_item WHERE schedule_id = @s2);
