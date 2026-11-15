-- =====================================================================
--  演示数据：让 Web 应用一打开就有内容可看、可改
--  执行顺序严格按外键依赖：family → user/elder → medbox → compartment
--                        → medicine → schedule → schedule_item
--                        → recording → intake_event → alert
-- =====================================================================
USE `smart_medbox`;

SET FOREIGN_KEY_CHECKS = 0;
TRUNCATE TABLE `alert`;
TRUNCATE TABLE `intake_event`;
TRUNCATE TABLE `recording`;
TRUNCATE TABLE `schedule_item`;
TRUNCATE TABLE `schedule`;
TRUNCATE TABLE `medicine`;
TRUNCATE TABLE `compartment`;
TRUNCATE TABLE `medbox`;
TRUNCATE TABLE `elder`;
TRUNCATE TABLE `user`;
TRUNCATE TABLE `family`;
SET FOREIGN_KEY_CHECKS = 1;

-- ---------------- 主体层 ----------------
INSERT INTO `family` (`id`,`name`,`contact_phone`) VALUES
  (1,'王家','13800000001');

-- 密码哈希仅为占位（明文 demo1234 的 bcrypt），生产务必重新生成
INSERT INTO `user` (`id`,`family_id`,`username`,`password_hash`,`real_name`,`phone`,`role`) VALUES
  (1,1,'wangxm','$2b$10$8kQ8Q8Q8Q8Q8Q8Q8Q8Q8uQ8Q8Q8Q8Q8Q8Q8Q8Q8Q8Q8Q8Q8Q8','王小梅','13800000001','owner'),
  (2,1,'wanggg','$2b$10$8kQ8Q8Q8Q8Q8Q8Q8Q8Q8uQ8Q8Q8Q8Q8Q8Q8Q8Q8Q8Q8Q8Q8','王国栋','13800000002','member');

INSERT INTO `elder` (`id`,`family_id`,`name`,`gender`,`birth_date`,`age`,
                     `hearing_level`,`vision_level`,`chronic_diseases`,`allergies`,
                     `sos_contact_user_id`,`remind_30m`,`remind_10m`,`remind_3m`,
                     `volume_level`,`speech_rate`,`repeat_times`,`timeout_minutes`,
                     `duplicate_window_minutes`) VALUES
  (1,1,'王秀英','female','1948-05-12',78,'moderate','mild',
   '高血压,2型糖尿病,高脂血症','青霉素过敏',1,
   0,1,1,4,'slow',2,30,2);

-- ---------------- 配置层 ----------------
INSERT INTO `medbox` (`id`,`family_id`,`elder_id`,`device_code`,`compartment_count`,`status`,`firmware_version`) VALUES
  (1,1,1,'MB-2026-0001',7,'online','v1.2.0');

-- 7 个隔间：前 4 个绑定早/中/晚/睡前，其余备用
INSERT INTO `compartment` (`id`,`medbox_id`,`slot_no`,`label`,`is_locked`) VALUES
  (1,1,1,'早上',1),(2,1,2,'中午',1),(3,1,3,'晚上',1),(4,1,4,'睡前',1),
  (5,1,5,'备用A',1),(6,1,6,'备用B',1),(7,1,7,'备用C',1);

INSERT INTO `medicine` (`id`,`family_id`,`name`,`spec`,`manufacturer`,`unit`,`appearance`,
                        `stock_qty`,`stock_alert_qty`,`contraindication`) VALUES
  (1,1,'苯磺酸氨氯地平片','5mg*28片','辉瑞','片','白色椭圆形片，一面有刻痕',60,14,'服药期间监测血压，避免与葡萄柚汁同服'),
  (2,1,'盐酸二甲双胍缓释片','0.5g*30片','中美华东','片','浅黄色圆形薄膜衣片',45,15,'餐中或餐后服用，肾功能不全者慎用'),
  (3,1,'阿托伐他汀钙片','20mg*7片','北京嘉林','片','白色薄膜衣片',21,7,'睡前服用，定期监测肝功能'),
  (4,1,'阿司匹林肠溶片','100mg*30片','拜耳','片','白色肠溶片，表面光滑',80,20,'空腹服用，有胃溃疡史者慎用'),
  (5,1,'格列美脲片','2mg*15片','赛诺菲','片','粉色小片',10,10,'早餐前即刻服用，注意低血糖');

INSERT INTO `schedule` (`id`,`elder_id`,`compartment_id`,`dose_time`,`time_label`,
                        `window_before_min`,`window_after_min`) VALUES
  (1,1,1,'08:00:00','早上',10,30),
  (2,1,2,'12:00:00','中午',10,30),
  (3,1,3,'18:00:00','晚上',10,30),
  (4,1,4,'21:00:00','睡前',10,30);

-- 早上：氨氯地平1片 + 二甲双胍1片 + 格列美脲1片
INSERT INTO `schedule_item` (`schedule_id`,`medicine_id`,`dose_qty`,`note`) VALUES
  (1,1,1.00,'早餐后温水送服'),
  (1,2,1.00,'餐中服用，勿嚼碎'),
  (1,5,1.00,'早餐前即刻服用');
-- 中午：二甲双胍1片
INSERT INTO `schedule_item` (`schedule_id`,`medicine_id`,`dose_qty`,`note`) VALUES
  (2,2,1.00,'餐中服用');
-- 晚上：氨氯地平1片 + 二甲双胍1片
INSERT INTO `schedule_item` (`schedule_id`,`medicine_id`,`dose_qty`,`note`) VALUES
  (3,1,1.00,'晚餐后服用'),
  (3,2,1.00,'餐中服用');
-- 睡前：阿托伐他汀1片 + 阿司匹林1片
INSERT INTO `schedule_item` (`schedule_id`,`medicine_id`,`dose_qty`,`note`) VALUES
  (4,3,1.00,'睡前服用'),
  (4,4,1.00,'空腹服用，与晚餐间隔2小时');

INSERT INTO `recording` (`id`,`elder_id`,`schedule_id`,`title`,`audio_url`,`duration_sec`,`dialect`,`play_order`,`is_birthday_egg`) VALUES
  (1,1,1,'早上吃药（常州话）','/audio/morning_cz.mp3',8,'常州话',1,0),
  (2,1,4,'睡前吃药（常州话）','/audio/night_cz.mp3',7,'常州话',2,0),
  (3,1,NULL,'生日彩蛋','/audio/birthday.mp3',12,'常州话',3,1);

-- ---------------- 运行层：最近几天的流水 ----------------
-- 全部按「相对当前时间往前推」生成，保证无论何时执行都是过去的记录
INSERT INTO `intake_event` (`elder_id`,`medbox_id`,`compartment_id`,`schedule_id`,
                            `event_type`,`result`,`dose_qty`,`occurred_at`,`source`) VALUES
  (1,1,4,4,'take','on_time',             2.00, NOW() - INTERVAL 20 HOUR,   'simulator'),
  (1,1,1,1,'take','on_time',             3.00, NOW() - INTERVAL 4 HOUR,    'simulator'),
  (1,1,2,2,'timeout','missed',           NULL, NOW() - INTERVAL 3 HOUR,    'simulator'),
  (1,1,3,3,'take','on_time',             2.00, NOW() - INTERVAL 100 MINUTE,'simulator'),
  (1,1,3,3,'duplicate_refused','duplicate',NULL, NOW() - INTERVAL 97 MINUTE,'simulator');

INSERT INTO `alert` (`elder_id`,`intake_event_id`,`alert_type`,`level`,`content`,`channel`,`sent_to_user_id`,`is_read`) VALUES
  (1,(SELECT id FROM intake_event WHERE result='missed' LIMIT 1),'missed','warning',
   '王秀英 12:00 中午的药超时未取（已等待30分钟），请及时联系确认。','web',1,0),
  (1,(SELECT id FROM intake_event WHERE result='duplicate' LIMIT 1),'duplicate','urgent',
   '检测到疑似重复取药：18:09 短时间内再次打开晚上隔间，系统已播报拦截话术。','web',1,0);

-- =====================================================================
-- 验证用查询（可直接执行查看关系是否打通）
-- =====================================================================
-- 查看今日各时段计划、隔间、药品：
-- SELECT s.id, s.time_label, s.dose_time, c.slot_no, c.label AS compartment,
--        m.name AS medicine, si.dose_qty, m.unit
-- FROM schedule s
-- LEFT JOIN compartment c ON s.compartment_id = c.id
-- LEFT JOIN schedule_item si ON si.schedule_id = s.id
-- LEFT JOIN medicine m ON si.medicine_id = m.id
-- WHERE s.elder_id = 1 ORDER BY s.dose_time;
--
-- 查看今日依从性：
-- SELECT e.result, COUNT(*) AS cnt FROM intake_event e
-- WHERE e.elder_id = 1 AND DATE(e.occurred_at) = CURDATE()
-- GROUP BY e.result;
