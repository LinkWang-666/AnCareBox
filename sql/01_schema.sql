-- =====================================================================
--  智能药箱 · 家庭用药协同系统 —— 数据库结构
--  适用：MySQL 8.0+    字符集：utf8mb4
--
--  表分三层，理解这三层就理解了整个系统：
--    【主体层】family / user / elder      —— 谁在用
--    【配置层】medbox / compartment / medicine / schedule / schedule_item / recording
--                                        —— 子女设定的规则
--    【运行层】intake_event / alert       —— 药箱每天产生的流水
--
--  核心设计：一格 = 一次量。
--  schedule（一个服药时间点）绑定 compartment（一个物理隔间），
--  schedule_item 说明这个隔间里放了哪几种药、各几片。
--  于是「到点只解锁对应隔间」在数据库层面就有了明确依据。
-- =====================================================================

SET NAMES utf8mb4;

CREATE DATABASE IF NOT EXISTS `smart_medbox`
  DEFAULT CHARACTER SET utf8mb4
  DEFAULT COLLATE utf8mb4_0900_ai_ci;

USE `smart_medbox`;

SET FOREIGN_KEY_CHECKS = 0;

-- device_session 的定义放在 05_device_session.sql，但它外键引用 medbox。
-- 重建 schema 时必须在这里一并清掉：
--   1. medbox 被 DROP 后 AUTO_INCREMENT 从 1 重新开始，
--      残留的会话行会带着旧的 medbox_id 挂到全新生成的药箱上
--   2. 05 用的是 CREATE TABLE IF NOT EXISTS，不会重建，数据因此悄悄留下来
-- 后果：子女端会看到几条来历不明的设备绑定记录，却说不清是哪来的。
DROP TABLE IF EXISTS `device_session`;

-- ---------------------------------------------------------------------
-- 【主体层 1】家庭：所有数据的顶层归属（多家庭共用一套系统时靠它隔离）
-- ---------------------------------------------------------------------
DROP TABLE IF EXISTS `family`;
CREATE TABLE `family` (
  `id`            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '家庭ID',
  `name`          VARCHAR(50)  NOT NULL                COMMENT '家庭名称，如「王家」',
  `contact_phone` VARCHAR(20)  DEFAULT NULL            COMMENT '家庭紧急联系电话',
  `created_at`    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='家庭（租户）：数据隔离的最外层';

-- ---------------------------------------------------------------------
-- 【主体层 2】家庭成员账号：子女 / 照护者。一个家庭多个子女都能管
-- ---------------------------------------------------------------------
DROP TABLE IF EXISTS `user`;
CREATE TABLE `user` (
  `id`            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `family_id`     BIGINT UNSIGNED NOT NULL            COMMENT '所属家庭 → family.id',
  `username`      VARCHAR(50)  NOT NULL                COMMENT '登录名',
  `password_hash` VARCHAR(255) NOT NULL                COMMENT '密码哈希(bcrypt)，任何时候都不得存明文',
  `real_name`     VARCHAR(50)  DEFAULT NULL            COMMENT '真实姓名',
  `phone`         VARCHAR(20)  DEFAULT NULL            COMMENT '接收漏服推送的手机号',
  `role`          ENUM('owner','member','viewer') NOT NULL DEFAULT 'member'
                                                       COMMENT 'owner=主配置人(可改一切) member=可配置 viewer=只读',
  `push_enabled`  TINYINT(1)   NOT NULL DEFAULT 1      COMMENT '是否接收漏服推送',
  `alert_prefs`   VARCHAR(200) DEFAULT NULL            COMMENT '告警订阅偏好（逗号分隔：missed,duplicate,night,offline,stock,conflict,sos,repeat；NULL=全部）',
  `created_at`    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_user_username` (`username`),
  KEY `idx_user_family` (`family_id`),
  CONSTRAINT `fk_user_family` FOREIGN KEY (`family_id`)
    REFERENCES `family`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='家庭成员账号（子女/照护者）';

-- ---------------------------------------------------------------------
-- 【主体层 3】老人档案 + 提醒策略
--   提醒策略直接放这张表（1对1），不再拆表，减少联表查询
-- ---------------------------------------------------------------------
DROP TABLE IF EXISTS `elder`;
CREATE TABLE `elder` (
  `id`                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `family_id`         BIGINT UNSIGNED NOT NULL            COMMENT '所属家庭 → family.id',
  `name`              VARCHAR(50)  NOT NULL               COMMENT '老人姓名',
  `gender`            ENUM('male','female') DEFAULT NULL,
  `birth_date`        DATE         DEFAULT NULL,
  `age`               TINYINT UNSIGNED DEFAULT NULL       COMMENT '冗余年龄，便于列表展示（可由birth_date推算）',
  `hearing_level`     ENUM('normal','mild','moderate','severe') NOT NULL DEFAULT 'normal'
                                                          COMMENT '听力等级 → 决定默认音量档位',
  `vision_level`      ENUM('normal','mild','moderate','severe') NOT NULL DEFAULT 'normal'
                                                          COMMENT '视力等级 → 决定老人端字号',
  `chronic_diseases`  VARCHAR(500) DEFAULT NULL           COMMENT '慢病，逗号分隔，如「高血压,2型糖尿病」',
  `allergies`         VARCHAR(500) DEFAULT NULL           COMMENT '过敏史',
  `sos_contact_user_id` BIGINT UNSIGNED DEFAULT NULL      COMMENT '「我不舒服」按钮优先通知谁 → user.id',
  -- ↓↓↓ 以下为提醒策略（子女在Web端设置，下发给药箱）
  `remind_30m`        TINYINT(1)   NOT NULL DEFAULT 0     COMMENT '服药前30分钟：慢闪提示',
  `remind_10m`        TINYINT(1)   NOT NULL DEFAULT 1     COMMENT '服药前10分钟：柔和常亮',
  `remind_3m`         TINYINT(1)   NOT NULL DEFAULT 1     COMMENT '服药前3分钟：高亮+蜂鸣+语音',
  `volume_level`      TINYINT UNSIGNED NOT NULL DEFAULT 3 COMMENT '音量档位 1-5',
  `speech_rate`       ENUM('slow','normal','fast') NOT NULL DEFAULT 'slow' COMMENT '语速',
  `repeat_times`      TINYINT UNSIGNED NOT NULL DEFAULT 2 COMMENT '播报重复次数（听力下降者调高）',
  `timeout_minutes`   TINYINT UNSIGNED NOT NULL DEFAULT 30 COMMENT '超过此分钟未取药 → 判定漏服',
  `duplicate_window_minutes` TINYINT UNSIGNED NOT NULL DEFAULT 2 COMMENT '此分钟内再次开箱 → 疑似重复服药',
  `status`            ENUM('active','inactive') NOT NULL DEFAULT 'active',
  `created_at`        DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`        DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_elder_family` (`family_id`),
  CONSTRAINT `fk_elder_family` FOREIGN KEY (`family_id`)
    REFERENCES `family`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='老人档案 + 提醒策略';

-- ---------------------------------------------------------------------
-- 【配置层 1】药箱设备
-- ---------------------------------------------------------------------
DROP TABLE IF EXISTS `medbox`;
CREATE TABLE `medbox` (
  `id`                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `family_id`         BIGINT UNSIGNED NOT NULL            COMMENT '所属家庭 → family.id',
  `elder_id`          BIGINT UNSIGNED DEFAULT NULL        COMMENT '绑定的老人 → elder.id（NULL=未分配）',
  `device_code`       VARCHAR(64)  NOT NULL               COMMENT '设备唯一编码，设备上报数据时凭此识别',
  `compartment_count` TINYINT UNSIGNED NOT NULL DEFAULT 7 COMMENT '隔间总数（默认7格：早中晚×2 + 备用）',
  `status`            ENUM('online','offline','maintenance') NOT NULL DEFAULT 'offline',
  `last_heartbeat_at` DATETIME     DEFAULT NULL           COMMENT '最近心跳时间，超阈值判定离线',
  `firmware_version`  VARCHAR(32)  DEFAULT NULL           COMMENT '设备当前固件版本（握手时上报）',
  `hardware_model`    VARCHAR(64)  DEFAULT NULL           COMMENT '硬件型号，如 MB-8L（8格带锁版）——OTA 按型号发版',
  `created_at`        DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_medbox_code` (`device_code`),
  KEY `idx_medbox_elder` (`elder_id`),
  CONSTRAINT `fk_medbox_family` FOREIGN KEY (`family_id`)
    REFERENCES `family`(`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_medbox_elder` FOREIGN KEY (`elder_id`)
    REFERENCES `elder`(`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='智能药箱设备';

-- ---------------------------------------------------------------------
-- 【配置层 2】隔间：一格 = 一次量（本项目的核心设计）
-- ---------------------------------------------------------------------
DROP TABLE IF EXISTS `compartment`;
CREATE TABLE `medbox_elder` (
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

CREATE TABLE `compartment` (
  `id`          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `medbox_id`   BIGINT UNSIGNED NOT NULL                  COMMENT '所属药箱 → medbox.id',
  `slot_no`     TINYINT UNSIGNED NOT NULL                 COMMENT '隔间编号 1..N（同一药箱内唯一）',
  `label`       VARCHAR(50)  DEFAULT NULL                 COMMENT '自定义标签，如「早上」「降压药格」',
  `is_locked`   TINYINT(1)   NOT NULL DEFAULT 1           COMMENT '当前是否电控锁闭：1=锁 0=开',
  -- ↓↓↓ 以下为格位传感器状态，由设备上报（实机未接时保持 NULL，界面按「未知」处理）
  `stock_ratio` TINYINT UNSIGNED DEFAULT NULL             COMMENT '格内余量百分比 0-100（称重/超声估出）',
  `is_empty`    TINYINT(1)   DEFAULT NULL                 COMMENT '1=格内已空（需补药）',
  `sensor_ok`   TINYINT(1)   DEFAULT NULL                 COMMENT '0=该格传感器故障',
  `reported_at` DATETIME     DEFAULT NULL                 COMMENT '该格状态最近上报时间',
  `created_at`  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_compartment_slot` (`medbox_id`,`slot_no`),
  CONSTRAINT `fk_compartment_medbox` FOREIGN KEY (`medbox_id`)
    REFERENCES `medbox`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='药箱隔间：子女把「一顿要吃的全部药」装进同一格';

-- ---------------------------------------------------------------------
-- 【配置层 3】药品字典（家庭级）
-- ---------------------------------------------------------------------
DROP TABLE IF EXISTS `medicine`;
CREATE TABLE `medicine` (
  `id`               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `family_id`        BIGINT UNSIGNED NOT NULL             COMMENT '所属家庭 → family.id（药品库按家庭隔离）',
  `name`             VARCHAR(100) NOT NULL                COMMENT '药品名称',
  `spec`             VARCHAR(100) DEFAULT NULL            COMMENT '规格，如「5mg*28片」',
  `manufacturer`     VARCHAR(100) DEFAULT NULL            COMMENT '生产厂家',
  `unit`             VARCHAR(20)  NOT NULL DEFAULT '片'   COMMENT '剂量单位：片/粒/袋/ml',
  `appearance`       VARCHAR(200) DEFAULT NULL            COMMENT '外观描述（帮老人辨认，如「白色小圆片」）',
  `stock_qty`        INT UNSIGNED NOT NULL DEFAULT 0      COMMENT '剩余库存',
  `stock_alert_qty`  INT UNSIGNED NOT NULL DEFAULT 7      COMMENT '低于此数量 → 提醒子女补药',
  `expiry_date`      DATE         DEFAULT NULL            COMMENT '效期（过期日期，用于临期/过期提醒）',
  `category`         VARCHAR(50)  DEFAULT NULL            COMMENT '功能分类，如「降压/降糖/调脂/心血管/营养补充/其他」',
  `contraindication` VARCHAR(500) DEFAULT NULL            COMMENT '禁忌与注意事项（仅作提示，不构成医疗建议）',
  `active_ingredient` VARCHAR(300) DEFAULT NULL           COMMENT '主要成分（逗号分隔，用于用药相互作用检测，仅作提示不构成医疗建议）',
  `barcode`          VARCHAR(64)  DEFAULT NULL            COMMENT '药盒条形码/监管码号码（拍照识药读取，可用于同条码去重）',
  `status`           ENUM('active','stopped') NOT NULL DEFAULT 'active',
  `created_at`       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_medicine_family` (`family_id`),
  CONSTRAINT `fk_medicine_family` FOREIGN KEY (`family_id`)
    REFERENCES `family`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='药品字典';

-- ---------------------------------------------------------------------
-- 【配置层 4】服药计划：一个时间点 = 一条计划 = 一个隔间
-- ---------------------------------------------------------------------
DROP TABLE IF EXISTS `schedule`;
CREATE TABLE `schedule` (
  `id`               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `elder_id`         BIGINT UNSIGNED NOT NULL             COMMENT '服药的老人 → elder.id',
  `compartment_id`   BIGINT UNSIGNED DEFAULT NULL         COMMENT '绑定的隔间 → compartment.id（时间窗内只解锁这一格）',
  `dose_time`        TIME         NOT NULL                COMMENT '服药时间点，如 08:00:00',
  `time_label`       VARCHAR(20)  DEFAULT NULL            COMMENT '时段标签：早/中/晚/睡前',
  `window_before_min` TINYINT UNSIGNED NOT NULL DEFAULT 10 COMMENT '允许提前取药的分钟数',
  `window_after_min`  TINYINT UNSIGNED NOT NULL DEFAULT 30 COMMENT '允许延后取药的分钟数（超出即漏服）',
  `status`           ENUM('active','paused') NOT NULL DEFAULT 'active',
  `created_at`       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_schedule_elder` (`elder_id`),
  KEY `idx_schedule_time`  (`dose_time`),
  CONSTRAINT `fk_schedule_elder` FOREIGN KEY (`elder_id`)
    REFERENCES `elder`(`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_schedule_compartment` FOREIGN KEY (`compartment_id`)
    REFERENCES `compartment`(`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='服药计划：到点只解锁 compartment_id 对应的那一格';

-- ---------------------------------------------------------------------
-- 【配置层 5】计划明细：这一次要吃哪几种药、各几片
--   schedule : schedule_item = 1 : N
-- ---------------------------------------------------------------------
DROP TABLE IF EXISTS `schedule_item`;
CREATE TABLE `schedule_item` (
  `id`          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `schedule_id` BIGINT UNSIGNED NOT NULL                  COMMENT '所属计划 → schedule.id',
  `medicine_id` BIGINT UNSIGNED NOT NULL                  COMMENT '药品 → medicine.id',
  `dose_qty`    DECIMAL(6,2) NOT NULL DEFAULT 1           COMMENT '本次服用剂量（单位随 medicine.unit）',
  `note`        VARCHAR(200) DEFAULT NULL                 COMMENT '服用提示，如「饭后服」「勿与茶同服」',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_item_sched_med` (`schedule_id`,`medicine_id`) COMMENT '同一计划里同一种药不重复',
  KEY `idx_item_medicine` (`medicine_id`),
  CONSTRAINT `fk_item_schedule` FOREIGN KEY (`schedule_id`)
    REFERENCES `schedule`(`id`) ON DELETE CASCADE,
  -- ON DELETE RESTRICT：药品已被计划引用时不允许删除，防止计划静默失效
  CONSTRAINT `fk_item_medicine` FOREIGN KEY (`medicine_id`)
    REFERENCES `medicine`(`id`) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='计划明细：一个隔间里的具体药品与剂量';

-- ---------------------------------------------------------------------
-- 【配置层 6】子女方言录音
-- ---------------------------------------------------------------------
DROP TABLE IF EXISTS `recording`;
CREATE TABLE `recording` (
  `id`          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `elder_id`    BIGINT UNSIGNED NOT NULL                  COMMENT '给谁听的 → elder.id',
  `schedule_id` BIGINT UNSIGNED DEFAULT NULL              COMMENT '绑定的时段；NULL=通用关怀语/彩蛋',
  `title`       VARCHAR(100) NOT NULL                     COMMENT '录音标题，如「早上吃药提醒」',
  `audio_url`   VARCHAR(500) NOT NULL                     COMMENT '音频访问地址（本项目演示期用本地相对路径）',
  `duration_sec` TINYINT UNSIGNED DEFAULT NULL            COMMENT '时长（秒）',
  `dialect`     VARCHAR(50)  DEFAULT NULL                 COMMENT '方言，如「常州话」「四川话」',
  `play_order`  TINYINT UNSIGNED NOT NULL DEFAULT 0       COMMENT '多条录音轮换顺序',
  `is_birthday_egg` TINYINT(1) NOT NULL DEFAULT 0         COMMENT '1=生日/节日彩蛋录音',
  `enabled`     TINYINT(1)  NOT NULL DEFAULT 1,
  `created_at`  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_rec_elder` (`elder_id`),
  CONSTRAINT `fk_rec_elder` FOREIGN KEY (`elder_id`)
    REFERENCES `elder`(`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_rec_schedule` FOREIGN KEY (`schedule_id`)
    REFERENCES `schedule`(`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='子女方言录音：播报时优先于机器TTS';

-- ---------------------------------------------------------------------
-- 【运行层 1】服药事件流水（只追加，不修改）
--   依从性统计、异常识别、告警判定的唯一数据源
-- ---------------------------------------------------------------------
DROP TABLE IF EXISTS `intake_event`;
CREATE TABLE `intake_event` (
  `id`            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `elder_id`      BIGINT UNSIGNED NOT NULL                COMMENT '老人 → elder.id',
  `medbox_id`     BIGINT UNSIGNED DEFAULT NULL            COMMENT '上报设备 → medbox.id',
  `compartment_id` BIGINT UNSIGNED DEFAULT NULL           COMMENT '被打开的隔间 → compartment.id',
  `schedule_id`   BIGINT UNSIGNED DEFAULT NULL            COMMENT '命中的计划 → schedule.id（NULL=非计划时段开箱）',
  `event_type`    ENUM('open','take','close','duplicate_refused','wrong_time_refused','timeout','offline') NOT NULL
                                                          COMMENT 'open=开箱 take=取药 close=关箱 duplicate_refused=重复服药被拦截 wrong_time_refused=非时段被拒 timeout=超时未取 offline=设备离线',
  `result`        ENUM('on_time','early','late','missed','duplicate','abnormal','unknown') NOT NULL DEFAULT 'unknown'
                                                          COMMENT '本次事件判定结果',
  `dose_qty`      DECIMAL(6,2) DEFAULT NULL               COMMENT '本次取用剂量',
  `occurred_at`   DATETIME     NOT NULL                   COMMENT '事件发生时间（设备侧时间）',
  `source`        ENUM('device','simulator','manual') NOT NULL DEFAULT 'device'
                                                          COMMENT '来源：真实设备 / 比赛演示模拟器 / 子女手动补录',
  `client_event_id` VARCHAR(64) DEFAULT NULL              COMMENT '设备侧事件唯一号：断网补传时靠它去重，同一号只入一条',
  `raw_payload`   JSON         DEFAULT NULL               COMMENT '设备原始上报报文，便于排障',
  `created_at`    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_ev_elder_time` (`elder_id`,`occurred_at`)      COMMENT '按老人+时间查记录（最常用）',
  KEY `idx_ev_schedule`   (`schedule_id`),
  KEY `idx_ev_result`     (`result`),
  -- 幂等键：同一台设备同一个 client_event_id 只能成功入库一次。
  -- 设备离线期间把事件存在本地队列，联网后重发，最怕「重发两次算两次漏服」。
  -- MySQL 的唯一索引允许多个 NULL，所以不传这个字段的旧调用方完全不受影响。
  UNIQUE KEY `uk_ev_client` (`medbox_id`,`client_event_id`),
  CONSTRAINT `fk_ev_elder` FOREIGN KEY (`elder_id`)
    REFERENCES `elder`(`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_ev_compartment` FOREIGN KEY (`compartment_id`)
    REFERENCES `compartment`(`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_ev_schedule` FOREIGN KEY (`schedule_id`)
    REFERENCES `schedule`(`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='服药事件流水：依从性统计的数据源';

-- ---------------------------------------------------------------------
-- 【运行层 2】告警与推送记录
-- ---------------------------------------------------------------------
DROP TABLE IF EXISTS `alert`;
CREATE TABLE `alert` (
  `id`              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `elder_id`        BIGINT UNSIGNED NOT NULL              COMMENT '老人 → elder.id',
  `intake_event_id` BIGINT UNSIGNED DEFAULT NULL          COMMENT '触发告警的事件 → intake_event.id（可空=非事件触发，如库存低）',
  `alert_type`      ENUM('missed','duplicate','night_open','repeat_missed','offline','sos','stock_low','drug_conflict','expiry','fault') NOT NULL
                                                          COMMENT 'missed=漏服 duplicate=重复取药 night_open=夜间开箱 repeat_missed=连续漏服 offline=设备离线 sos=老人求助 stock_low=药品不足 drug_conflict=用药相互作用 expiry=效期预警 fault=设备故障（锁卡死/喇叭故障/传感器异常）',
  `level`           ENUM('info','warning','urgent') NOT NULL DEFAULT 'warning',
  `content`         VARCHAR(500) NOT NULL                 COMMENT '推送正文',
  `channel`         VARCHAR(50)  DEFAULT 'web'            COMMENT 'web / sms / wechat',
  `sent_to_user_id` BIGINT UNSIGNED DEFAULT NULL          COMMENT '推送给哪位子女 → user.id',
  `is_read`         TINYINT(1)   NOT NULL DEFAULT 0,
  `handled_at`      DATETIME     DEFAULT NULL             COMMENT '子女处理时间',
  `handle_note`     VARCHAR(500) DEFAULT NULL             COMMENT '处理备注，如「已电话确认，老人外出」',
  `created_at`      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_alert_elder_time` (`elder_id`,`created_at`),
  KEY `idx_alert_read`       (`is_read`),
  CONSTRAINT `fk_alert_elder` FOREIGN KEY (`elder_id`)
    REFERENCES `elder`(`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_alert_event` FOREIGN KEY (`intake_event_id`)
    REFERENCES `intake_event`(`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='告警与推送记录';

-- ---------------------------------------------------------------------
-- 【设备对接层 1】下行指令队列（云端 → 药箱）
--   云端写一条 pending，设备下次心跳时取走，执行完回执。
--   为什么不做成 WebSocket 直推：
--     药箱是电池设备、网络时好时坏，长连接维持成本高且一断就丢指令。
--     轮询队列 + 回执的组合，断网期间指令只是排队不丢，联网后自动补发。
-- ---------------------------------------------------------------------
DROP TABLE IF EXISTS `device_command`;
CREATE TABLE `device_command` (
  `id`          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `medbox_id`   BIGINT UNSIGNED NOT NULL                 COMMENT '目标药箱 → medbox.id',
  `command`     ENUM('ring','led','unlock','lock','speak','sync','reboot','locate') NOT NULL
                                                          COMMENT 'ring=响铃 led=亮灯 unlock/lock=开关指定格 speak=播报一段话 sync=立即重拉配置 reboot=重启 locate=闪灯蜂鸣找设备',
  `params`      JSON         DEFAULT NULL                 COMMENT '指令参数，如 {"slot_no":4,"seconds":30,"text":"该吃药了"}',
  `status`      ENUM('pending','sent','done','failed','expired') NOT NULL DEFAULT 'pending'
                                                          COMMENT 'pending=待取 sent=设备已取走 done=执行成功 failed=执行失败 expired=过期未执行',
  `priority`    TINYINT UNSIGNED NOT NULL DEFAULT 5       COMMENT '越小越优先：SOS 1 / 远程提醒 3 / 配置同步 8',
  `source`      ENUM('user','system') NOT NULL DEFAULT 'user',
  `created_by`  BIGINT UNSIGNED DEFAULT NULL              COMMENT '哪位子女下发的 → user.id',
  `created_at`  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `picked_at`   DATETIME     DEFAULT NULL                 COMMENT '设备取走时间（取走后状态转 sent，避免多设备重复执行）',
  `acked_at`    DATETIME     DEFAULT NULL                 COMMENT '设备回执时间',
  `result_msg`  VARCHAR(200) DEFAULT NULL                 COMMENT '回执说明，失败时写原因',
  `expires_at`  DATETIME     DEFAULT NULL                 COMMENT '过期时间：过点未执行则作废，避免半夜突然响铃',
  PRIMARY KEY (`id`),
  KEY `idx_cmd_pick` (`medbox_id`,`status`,`priority`,`id`) COMMENT '设备拉取指令的固定查询路径',
  CONSTRAINT `fk_cmd_medbox` FOREIGN KEY (`medbox_id`)
    REFERENCES `medbox`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='下行指令队列：远程响铃/亮灯/解锁/播报';

-- ---------------------------------------------------------------------
-- 【设备对接层 2】设备运行态快照（一台药箱一行，每次心跳覆盖写）
--   与 medbox 表分开：medbox 是「配置」，这里全是「会高频变化的遥测数据」，
--   混在一起会让配置查询被迫扫一堆无关字段，也容易覆盖写打架。
-- ---------------------------------------------------------------------
DROP TABLE IF EXISTS `device_status`;
CREATE TABLE `device_status` (
  `medbox_id`     BIGINT UNSIGNED NOT NULL,
  `api_version`   VARCHAR(16)  DEFAULT NULL              COMMENT '设备当前使用的接口版本，如 v1',
  `battery`       TINYINT UNSIGNED DEFAULT NULL          COMMENT '电量百分比 0-100',
  `charging`      TINYINT(1)   DEFAULT NULL              COMMENT '是否在充电',
  `rssi`          SMALLINT     DEFAULT NULL              COMMENT 'WiFi 信号强度 dBm（-30 强 / -80 弱）',
  `uptime_sec`    INT UNSIGNED DEFAULT NULL              COMMENT '本次开机已运行秒数（判断有没有异常重启）',
  `temperature`   DECIMAL(4,1) DEFAULT NULL              COMMENT '机内温度 ℃',
  `door_open`     TINYINT(1)   DEFAULT NULL              COMMENT '总门磁状态：1=门开着',
  `fault_code`    VARCHAR(32)  DEFAULT NULL              COMMENT '当前故障码，NULL=无故障',
  `fault_msg`     VARCHAR(200) DEFAULT NULL              COMMENT '故障说明（给子女看的人话）',
  `boot_at`       DATETIME     DEFAULT NULL              COMMENT '本次上电时间',
  `last_seen_at`  DATETIME     DEFAULT NULL              COMMENT '最近一次握手或心跳时间',
  `raw`           JSON         DEFAULT NULL              COMMENT '原始上报报文，便于排障',
  `updated_at`    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`medbox_id`),
  CONSTRAINT `fk_status_medbox` FOREIGN KEY (`medbox_id`)
    REFERENCES `medbox`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='设备运行态：电量/信号/门磁/故障码';

-- ---------------------------------------------------------------------
-- 【设备对接层 3】固件版本库（OTA 预留）
--   现在没有真实固件，表先建好、接口先留好：
--   一有固件就往这张表插一行，设备下一次查 OTA 就能收到升级指令。
-- ---------------------------------------------------------------------
DROP TABLE IF EXISTS `device_firmware`;
CREATE TABLE `device_firmware` (
  `id`             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `hardware_model` VARCHAR(64)  NOT NULL                 COMMENT '适用硬件型号（与 medbox.hardware_model 对应）',
  `version`        VARCHAR(32)  NOT NULL                 COMMENT '固件版本号，如 1.2.0',
  `url`            VARCHAR(500) NOT NULL                 COMMENT '固件下载地址（http/https）',
  `sha256`         CHAR(64)     DEFAULT NULL             COMMENT '文件摘要，设备校验用，防止刷坏',
  `size_bytes`     INT UNSIGNED DEFAULT NULL,
  `notes`          VARCHAR(500) DEFAULT NULL             COMMENT '更新说明',
  `is_mandatory`   TINYINT(1)   NOT NULL DEFAULT 0       COMMENT '1=强制升级（安全补丁），设备不得跳过',
  `released_at`    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_fw_model_ver` (`hardware_model`,`version`),
  KEY `idx_fw_model_time` (`hardware_model`,`released_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='固件版本库：设备 OTA 检查用';

-- ---------------------------------------------------------------------
-- 【设备对接层 4】设备诊断日志
--   真机装到用户家里以后，出问题只能靠它自己把日志传上来 ——
--   没有这个接口，售后只能让老人把药箱寄回来，或者教家属「插上串口」。
--   只保留 7 天，由服务端定期清理（见 services/device.js 的 purgeOldLogs）。
-- ---------------------------------------------------------------------
DROP TABLE IF EXISTS `device_log`;
CREATE TABLE `device_log` (
  `id`         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `medbox_id`  BIGINT UNSIGNED NOT NULL,
  `level`      ENUM('debug','info','warn','error') NOT NULL DEFAULT 'info',
  `event`      VARCHAR(64)  DEFAULT NULL               COMMENT '事件名，如 BOOT / LOCK_FAIL / OTA_START',
  `message`    VARCHAR(2000) DEFAULT NULL              COMMENT '日志正文',
  `context`    JSON         DEFAULT NULL               COMMENT '附带上下文：固件版本、电量、当时的任务 id 等',
  `occurred_at` DATETIME    NOT NULL                   COMMENT '设备侧时间',
  `created_at` DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_log_box_time` (`medbox_id`,`occurred_at`),
  CONSTRAINT `fk_log_medbox` FOREIGN KEY (`medbox_id`)
    REFERENCES `medbox`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='设备诊断日志（保留 7 天）';

SET FOREIGN_KEY_CHECKS = 1;

-- =====================================================================
-- 关系速查（→ 表示多对一）
--   user.family_id          → family.id
--   elder.family_id         → family.id
--   elder.sos_contact_user_id → user.id
--   medbox.family_id        → family.id       medbox.elder_id → elder.id
--   compartment.medbox_id   → medbox.id
--   medicine.family_id      → family.id
--   schedule.elder_id       → elder.id        schedule.compartment_id → compartment.id
--   schedule_item.schedule_id → schedule.id   schedule_item.medicine_id → medicine.id
--   recording.elder_id      → elder.id        recording.schedule_id → schedule.id
--   intake_event.elder_id / medbox_id / compartment_id / schedule_id → 各自主键
--   alert.elder_id          → elder.id        alert.intake_event_id → intake_event.id
-- =====================================================================
