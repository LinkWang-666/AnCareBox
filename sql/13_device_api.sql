-- =====================================================================
--  13 · 设备对接层（药箱硬件接口预留）
--
--  适用场景：实物药箱还没接电脑，但硬件那边随时会来对接。
--  这个脚本把「设备要用的字段和表」全部提前补齐，接到实物后不用再改库。
--
--  ★ 本脚本幂等：可以重复执行，已经存在的列/索引/表会自动跳过。
--    已经有数据的库直接跑这个文件即可，不需要重建、不会丢数据。
--    新库跑 01_schema.sql 时已经包含这些定义，本脚本会自动全部跳过。
--
--  怎么跑（任选其一）：
--    npm run migrate:device
--    mysql -u root -p smart_medbox < sql/13_device_api.sql
--
--  为什么不用存储过程 / DELIMITER：
--    DELIMITER 是 mysql 命令行客户端的指令，不是 SQL。
--    走 Node 驱动执行时它会被当成 SQL 发给服务器，直接语法报错。
--    所以这里统一用「查 information_schema → 拼 ALTER → PREPARE 执行」，
--    纯 SQL 写法，客户端和 Node 都能跑。
-- =====================================================================

SET NAMES utf8mb4;
USE `smart_medbox`;

-- ---------------------------------------------------------------------
-- 1. medbox：补硬件型号
--    固件版本字段 medbox.firmware_version 早就有了，握手时覆盖写。
--    型号决定 OTA 发哪个包，必须单独存。
-- ---------------------------------------------------------------------
SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'medbox'
              AND COLUMN_NAME = 'hardware_model');
SET @s := IF(@c = 0,
  'ALTER TABLE `medbox` ADD COLUMN `hardware_model` VARCHAR(64) DEFAULT NULL COMMENT ''硬件型号，如 MB-8L（8格带锁版）——OTA 按型号发版''',
  'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- ---------------------------------------------------------------------
-- 2. compartment：补格位传感器状态
--    实机没接时这四列都是 NULL，界面按「未知」显示，不会被当成「空格」误报缺药。
-- ---------------------------------------------------------------------
SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'compartment'
              AND COLUMN_NAME = 'stock_ratio');
SET @s := IF(@c = 0,
  'ALTER TABLE `compartment` ADD COLUMN `stock_ratio` TINYINT UNSIGNED DEFAULT NULL COMMENT ''格内余量百分比 0-100（称重/超声估出）''',
  'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'compartment'
              AND COLUMN_NAME = 'is_empty');
SET @s := IF(@c = 0,
  'ALTER TABLE `compartment` ADD COLUMN `is_empty` TINYINT(1) DEFAULT NULL COMMENT ''1=格内已空（需补药）''',
  'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'compartment'
              AND COLUMN_NAME = 'sensor_ok');
SET @s := IF(@c = 0,
  'ALTER TABLE `compartment` ADD COLUMN `sensor_ok` TINYINT(1) DEFAULT NULL COMMENT ''0=该格传感器故障''',
  'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'compartment'
              AND COLUMN_NAME = 'reported_at');
SET @s := IF(@c = 0,
  'ALTER TABLE `compartment` ADD COLUMN `reported_at` DATETIME DEFAULT NULL COMMENT ''该格状态最近上报时间''',
  'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- ---------------------------------------------------------------------
-- 3. intake_event：补幂等键
--    设备断网时把事件存本地队列，联网后重发。
--    没有幂等键的话「重发一次 = 多算一次漏服」，依从率直接失真。
--    唯一索引 (medbox_id, client_event_id) 保证同一事件只入一条；
--    MySQL 唯一索引允许多个 NULL，所以不传该字段的旧调用方完全不受影响。
-- ---------------------------------------------------------------------
SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'intake_event'
              AND COLUMN_NAME = 'client_event_id');
SET @s := IF(@c = 0,
  'ALTER TABLE `intake_event` ADD COLUMN `client_event_id` VARCHAR(64) DEFAULT NULL COMMENT ''设备侧事件唯一号：断网补传时靠它去重，同一号只入一条''',
  'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @c := (SELECT COUNT(*) FROM information_schema.STATISTICS
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'intake_event'
              AND INDEX_NAME = 'uk_ev_client');
SET @s := IF(@c = 0,
  'ALTER TABLE `intake_event` ADD UNIQUE KEY `uk_ev_client` (`medbox_id`,`client_event_id`)',
  'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- ---------------------------------------------------------------------
-- 4. alert：告警类型补 fault（设备故障）
--    MODIFY 天然幂等，重复执行只是把 ENUM 再设一遍同样的值。
-- ---------------------------------------------------------------------
ALTER TABLE `alert` MODIFY COLUMN `alert_type`
  ENUM('missed','duplicate','night_open','repeat_missed','offline','sos','stock_low','drug_conflict','expiry','fault') NOT NULL
  COMMENT 'missed=漏服 duplicate=重复取药 night_open=夜间开箱 repeat_missed=连续漏服 offline=设备离线 sos=老人求助 stock_low=药品不足 drug_conflict=用药相互作用 expiry=效期预警 fault=设备故障（锁卡死/喇叭故障/传感器异常）';

-- ---------------------------------------------------------------------
-- 5. 下行指令队列（云端 → 药箱）
--    云端写一条 pending，设备下次心跳取走，执行完回执。
--    为什么不做 WebSocket 直推：药箱是电池设备、网络时好时坏，
--    长连接维护成本高且一断就丢指令；队列 + 回执的组合断网期间只是排队，不丢。
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `device_command` (
  `id`          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `medbox_id`   BIGINT UNSIGNED NOT NULL,
  `command`     ENUM('ring','led','unlock','lock','speak','sync','reboot','locate') NOT NULL
                COMMENT 'ring=响铃 led=亮灯 unlock/lock=开关指定格 speak=播报一段话 sync=立即重拉配置 reboot=重启 locate=闪灯蜂鸣找设备',
  `params`      JSON         DEFAULT NULL,
  `status`      ENUM('pending','sent','done','failed','expired') NOT NULL DEFAULT 'pending',
  `priority`    TINYINT UNSIGNED NOT NULL DEFAULT 5,
  `source`      ENUM('user','system') NOT NULL DEFAULT 'user',
  `created_by`  BIGINT UNSIGNED DEFAULT NULL,
  `created_at`  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `picked_at`   DATETIME     DEFAULT NULL,
  `acked_at`    DATETIME     DEFAULT NULL,
  `result_msg`  VARCHAR(200) DEFAULT NULL,
  `expires_at`  DATETIME     DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_cmd_pick` (`medbox_id`,`status`,`priority`,`id`),
  CONSTRAINT `fk_cmd_medbox` FOREIGN KEY (`medbox_id`)
    REFERENCES `medbox`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='下行指令队列：远程响铃/亮灯/解锁/播报';

-- ---------------------------------------------------------------------
-- 6. 设备运行态（一箱一行，心跳覆盖写）
--    与 medbox 分开：medbox 存「配置」，这里存「会高频变化的遥测」。
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `device_status` (
  `medbox_id`     BIGINT UNSIGNED NOT NULL,
  `api_version`   VARCHAR(16)  DEFAULT NULL,
  `battery`       TINYINT UNSIGNED DEFAULT NULL,
  `charging`      TINYINT(1)   DEFAULT NULL,
  `rssi`          SMALLINT     DEFAULT NULL,
  `uptime_sec`    INT UNSIGNED DEFAULT NULL,
  `temperature`   DECIMAL(4,1) DEFAULT NULL,
  `door_open`     TINYINT(1)   DEFAULT NULL,
  `fault_code`    VARCHAR(32)  DEFAULT NULL,
  `fault_msg`     VARCHAR(200) DEFAULT NULL,
  `boot_at`       DATETIME     DEFAULT NULL,
  `last_seen_at`  DATETIME     DEFAULT NULL,
  `raw`           JSON         DEFAULT NULL,
  `updated_at`    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`medbox_id`),
  CONSTRAINT `fk_status_medbox` FOREIGN KEY (`medbox_id`)
    REFERENCES `medbox`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='设备运行态：电量/信号/门磁/故障码';

-- ---------------------------------------------------------------------
-- 7. 固件版本库（OTA 预留：先建表，一有固件插一行就能发版）
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `device_firmware` (
  `id`             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `hardware_model` VARCHAR(64)  NOT NULL,
  `version`        VARCHAR(32)  NOT NULL,
  `url`            VARCHAR(500) NOT NULL,
  `sha256`         CHAR(64)     DEFAULT NULL,
  `size_bytes`     INT UNSIGNED DEFAULT NULL,
  `notes`          VARCHAR(500) DEFAULT NULL,
  `is_mandatory`   TINYINT(1)   NOT NULL DEFAULT 0,
  `released_at`    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_fw_model_ver` (`hardware_model`,`version`),
  KEY `idx_fw_model_time` (`hardware_model`,`released_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='固件版本库：设备 OTA 检查用';

-- ---------------------------------------------------------------------
-- 8. 设备诊断日志（保留 7 天，服务端定期清理）
--    真机装到用户家里以后，出问题只能靠它自己把日志传上来。
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `device_log` (
  `id`         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `medbox_id`  BIGINT UNSIGNED NOT NULL,
  `level`      ENUM('debug','info','warn','error') NOT NULL DEFAULT 'info',
  `event`      VARCHAR(64)  DEFAULT NULL,
  `message`    VARCHAR(2000) DEFAULT NULL,
  `context`    JSON         DEFAULT NULL,
  `occurred_at` DATETIME    NOT NULL,
  `created_at` DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_log_box_time` (`medbox_id`,`occurred_at`),
  CONSTRAINT `fk_log_medbox` FOREIGN KEY (`medbox_id`)
    REFERENCES `medbox`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='设备诊断日志（保留 7 天）';

-- =====================================================================
-- 验收（执行完可以手动跑这几句看结果）
--   SHOW COLUMNS FROM medbox LIKE 'hardware_model';
--   SHOW COLUMNS FROM compartment LIKE 'stock_ratio';
--   SHOW COLUMNS FROM intake_event LIKE 'client_event_id';
--   SHOW INDEX FROM intake_event WHERE Key_name = 'uk_ev_client';
--   SHOW TABLES LIKE 'device_%';
-- =====================================================================
