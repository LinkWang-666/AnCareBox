-- ============================================================
-- 05_device_session.sql  药箱设备会话（服务端持久化）
-- ------------------------------------------------------------
-- 为什么需要这张表：
--   改造前，设备令牌只存在浏览器的 localStorage 里，服务端一行记录都没有。
--   后果是：用户一清理浏览器数据，令牌就消失，老人端立刻失联，
--   必须由子女重新生成绑定码 —— 而现实里老人常常独自在家，做不到这一步。
--
--   改造思路：
--     1. 绑定成功时，除了发令牌，还种一个 httpOnly Cookie（浏览器会持久化保存）
--     2. 令牌本身连同编号 jti 记录在本表（服务端可查、可吊销、可看在线状态）
--     3. localStorage 丢了不要紧，凭 Cookie 能静默换回一张新令牌，老人无感知
--
--   必须如实说明的边界：
--     如果用户执行的是「设置 → 清除浏览数据（含 Cookie）」的完整清理，
--     Cookie 一样会被删掉 —— 这是浏览器沙箱的既定设计，任何纯 Web 方案都无法逾越。
--     真正的产品形态应该是独立 App，或在硬件设备上固化凭证（如安全芯片）。
--     本项目是 Web 演示，此处如实记录该限制，不假装能做到百分之百。
--
-- 顺带带来的能力（答辩可讲）：
--   · last_seen_at 让子女能看到「药箱最后一次联网时间」，是离线告警的基础
--   · revoked_at 让「解绑」真正生效到每一台具体设备，而不是一刀切版本号
-- ============================================================

SET @db = DATABASE();

CREATE TABLE IF NOT EXISTS `device_session` (
  `id`            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '自增主键',
  `medbox_id`     BIGINT UNSIGNED NOT NULL COMMENT '所属药箱，对应 medbox.id',
  `token_jti`     VARCHAR(64)      NOT NULL COMMENT '设备令牌唯一编号，用于精确定位与吊销',
  `issued_at`     DATETIME         NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '签发时间',
  `expires_at`    DATETIME         NOT NULL COMMENT '过期时间，到期后需重新绑定',
  `last_seen_at`  DATETIME         DEFAULT NULL COMMENT '最后在线时间，可用于离线告警',
  `revoked_at`    DATETIME         DEFAULT NULL COMMENT '吊销时间，非空即代表已失效',
  `revoke_reason` VARCHAR(64)      DEFAULT NULL COMMENT '吊销原因：unbind / replaced / logout',
  `user_agent`    VARCHAR(255)     DEFAULT NULL COMMENT '浏览器标识，仅供排障定位',
  `login_ip`      VARCHAR(45)      DEFAULT NULL COMMENT '来源 IP，45 位够存 IPv6',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_token_jti` (`token_jti`),
  KEY `idx_medbox` (`medbox_id`),
  KEY `idx_expires` (`expires_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='药箱设备会话，令牌不再只依赖浏览器存储';

-- ------------------------------------------------------------
-- 外键：药箱被删除时，其会话一并清理。
-- 用 information_schema 先判断，保证脚本可以被重复执行而不报错。
-- ------------------------------------------------------------
SET @fk_exists = (
  SELECT COUNT(*) FROM information_schema.table_constraints
  WHERE constraint_schema = @db
    AND table_name = 'device_session'
    AND constraint_name = 'fk_ds_medbox'
);

SET @ddl = IF(@fk_exists = 0,
  'ALTER TABLE `device_session` ADD CONSTRAINT `fk_ds_medbox` FOREIGN KEY (`medbox_id`) REFERENCES `medbox`(`id`) ON DELETE CASCADE',
  "SELECT 'fk_ds_medbox 已存在，跳过' AS msg");
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
