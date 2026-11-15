-- ============================================================
-- 04_demo_data.sql —— 李家（李奶奶）演示数据补全
-- ============================================================
-- 作用：
--   王家（王秀英）的数据在 02_seed.sql 里已经齐全；
--   李家只有孤零零 1 种药、1 条计划，子女端登录 li_owner 后
--   界面几乎是空的。本文件把李家补成一套能看的数据。
--
-- 场景设定（与王家形成对比，方便答辩演示）：
--   王秀英：高血压 + 2型糖尿病 + 高脂血症，依从性好（4 条计划）
--   李奶奶：冠心病，依从性一般（3 条计划）—— 视觉上"看板曲线一高一低"
--
-- 幂等性：全部用 NOT EXISTS 判断，重复执行不会插重复数据。
--
-- 冠心病常用药物（均为演示示例，不构成任何用药建议）：
--   阿司匹林肠溶片        —— 抗血小板，早餐前服
--   酒石酸美托洛尔缓释片  —— 控心率控血压，晨起服
--   单硝酸异山梨酯缓释片  —— 扩冠脉，午餐后服
--   阿托伐他汀钙片        —— 调脂，睡前服（已存在，id=10）
-- ============================================================

USE smart_medbox;

-- ------------------------------------------------------------
-- 一、李奶奶的提醒策略（体现"不同老人不同设置"）
--     82 岁中度听损：音量最大、语速最慢、重复播报 3 次
-- ------------------------------------------------------------
UPDATE elder
   SET volume_level = 5,          -- 音量档位 1-5，拉满
       speech_rate  = 'slow',    -- 语速慢
       repeat_times = 3,         -- 同一句话播 3 遍
       timeout_minutes = 25      -- 25 分钟没开箱判漏服
 WHERE id = 2 AND family_id = 2;

-- ------------------------------------------------------------
-- 二、李家药品（3 种新的 + 已有他汀共 4 种）
-- ------------------------------------------------------------
INSERT INTO medicine (family_id, name, spec, unit, manufacturer, stock_qty, stock_alert_qty, contraindication)
SELECT 2, '阿司匹林肠溶片', '100mg*30片', '片', '拜耳医药', 24, 10, '对阿司匹林过敏者禁用；胃溃疡患者慎用'
WHERE NOT EXISTS (SELECT 1 FROM medicine WHERE family_id = 2 AND name = '阿司匹林肠溶片');

INSERT INTO medicine (family_id, name, spec, unit, manufacturer, stock_qty, stock_alert_qty, contraindication)
SELECT 2, '酒石酸美托洛尔缓释片', '47.5mg*7片', '片', '阿斯利康制药', 5, 7, '严重心动过缓者禁用；不可掰开咀嚼'
WHERE NOT EXISTS (SELECT 1 FROM medicine WHERE family_id = 2 AND name = '酒石酸美托洛尔缓释片');

INSERT INTO medicine (family_id, name, spec, unit, manufacturer, stock_qty, stock_alert_qty, contraindication)
SELECT 2, '单硝酸异山梨酯缓释片', '60mg*10片', '片', '鲁南贝特制药', 18, 10, '严重低血压者禁用；避免与西地那非同用'
WHERE NOT EXISTS (SELECT 1 FROM medicine WHERE family_id = 2 AND name = '单硝酸异山梨酯缓释片');

-- 美托洛尔库存 5 片 < 库存警戒 7 片 → 会触发一条 stock_low 告警素材
-- （低库存演示场景，答辩时展示"库存不足提醒"功能）

-- ------------------------------------------------------------
-- 三、修正原有计划：早上 8 点不该吃他汀（他汀应睡前服）
--    原计划 10（早 08:00，隔间 8）保留，把他汀挪到新建的睡前计划
-- ------------------------------------------------------------
INSERT INTO schedule (elder_id, compartment_id, dose_time, time_label, window_before_min, window_after_min)
SELECT 2, 10, '21:00:00', '睡前', 10, 30
WHERE NOT EXISTS (SELECT 1 FROM schedule WHERE elder_id = 2 AND dose_time = '21:00:00');

SET @sched_night = (SELECT id FROM schedule WHERE elder_id = 2 AND dose_time = '21:00:00' LIMIT 1);

-- 原来错绑在早上计划里的他汀明细（schedule_item id=9），改绑到睡前计划
UPDATE schedule_item
   SET schedule_id = @sched_night,
       note = '睡前服用'
 WHERE id = 9;

-- ------------------------------------------------------------
-- 四、李家另外两条计划：中午、晚上
--    （早上已有计划 10；药箱 2 的隔间：8=格1 早，9=格2 中，10=格3 睡前）
-- ------------------------------------------------------------
INSERT INTO schedule (elder_id, compartment_id, dose_time, time_label, window_before_min, window_after_min)
SELECT 2, 9, '12:00:00', '中午', 10, 30
WHERE NOT EXISTS (SELECT 1 FROM schedule WHERE elder_id = 2 AND dose_time = '12:00:00');

INSERT INTO schedule (elder_id, compartment_id, dose_time, time_label, window_before_min, window_after_min)
SELECT 2, 11, '18:00:00', '晚上', 10, 30
WHERE NOT EXISTS (SELECT 1 FROM schedule WHERE elder_id = 2 AND dose_time = '18:00:00');

SET @sched_noon   = (SELECT id FROM schedule WHERE elder_id = 2 AND dose_time = '12:00:00' LIMIT 1);
SET @sched_evening = (SELECT id FROM schedule WHERE elder_id = 2 AND dose_time = '18:00:00' LIMIT 1);

-- ------------------------------------------------------------
-- 五、各计划的药品明细（一格 = 一次量的所有药片）
-- ------------------------------------------------------------
-- 早上（计划10）：阿司匹林 + 美托洛尔
INSERT INTO schedule_item (schedule_id, medicine_id, dose_qty, note)
SELECT 10, m.id, 1.00, '早餐前温水送服'
  FROM medicine m
 WHERE m.family_id = 2 AND m.name = '阿司匹林肠溶片'
   AND NOT EXISTS (SELECT 1 FROM schedule_item si WHERE si.schedule_id = 10 AND si.medicine_id = m.id);

INSERT INTO schedule_item (schedule_id, medicine_id, dose_qty, note)
SELECT 10, m.id, 1.00, '晨起服用，不可掰开'
  FROM medicine m
 WHERE m.family_id = 2 AND m.name = '酒石酸美托洛尔缓释片'
   AND NOT EXISTS (SELECT 1 FROM schedule_item si WHERE si.schedule_id = 10 AND si.medicine_id = m.id);

-- 中午（新计划）：单硝酸异山梨酯
INSERT INTO schedule_item (schedule_id, medicine_id, dose_qty, note)
SELECT @sched_noon, m.id, 1.00, '午餐后服用'
  FROM medicine m
 WHERE m.family_id = 2 AND m.name = '单硝酸异山梨酯缓释片'
   AND NOT EXISTS (SELECT 1 FROM schedule_item si WHERE si.schedule_id = @sched_noon AND si.medicine_id = m.id);

-- 晚上（新计划）：单硝酸异山梨酯第二片（按医嘱每日两次）
INSERT INTO schedule_item (schedule_id, medicine_id, dose_qty, note)
SELECT @sched_evening, m.id, 1.00, '晚餐后服用'
  FROM medicine m
 WHERE m.family_id = 2 AND m.name = '单硝酸异山梨酯缓释片'
   AND NOT EXISTS (SELECT 1 FROM schedule_item si WHERE si.schedule_id = @sched_evening AND si.medicine_id = m.id);

-- ------------------------------------------------------------
-- 六、李奶奶的语音录音（她不熟悉常州话，用普通话慢速录制）
-- ------------------------------------------------------------
INSERT INTO recording (elder_id, schedule_id, title, audio_url, duration_sec, dialect, play_order, is_birthday_egg, enabled)
SELECT 2, 10, '早上吃药（普通话·女儿录制）', '/uploads/demo/li_morning.mp3', 8, '普通话', 1, 0, 1
WHERE NOT EXISTS (SELECT 1 FROM recording WHERE elder_id = 2 AND schedule_id = 10);

INSERT INTO recording (elder_id, schedule_id, title, audio_url, duration_sec, dialect, play_order, is_birthday_egg, enabled)
SELECT 2, @sched_night, '睡前吃药（普通话·女儿录制）', '/uploads/demo/li_night.mp3', 7, '普通话', 1, 0, 1
WHERE NOT EXISTS (SELECT 1 FROM recording WHERE elder_id = 2 AND schedule_id = @sched_night);

INSERT INTO recording (elder_id, schedule_id, title, audio_url, duration_sec, dialect, play_order, is_birthday_egg, enabled)
SELECT 2, NULL, '生日彩蛋（女儿录制）', '/uploads/demo/li_birthday.mp3', 15, '普通话', 99, 1, 1
WHERE NOT EXISTS (SELECT 1 FROM recording WHERE elder_id = 2 AND is_birthday_egg = 1);

-- 完成。接下来跑 npm run seed-demo 生成两家近 14 天的服药记录。
