#!/usr/bin/env bash
# =============================================================================
#  安心格 AnCareBox · 阿里云 ECS（Ubuntu）一键部署
#
#  用法（在服务器上以 root 执行）：
#     sudo bash deploy.sh                                        # 只跑 HTTP（先用 IP 验证）
#     sudo DOMAIN=medbox.example.com EMAIL=you@example.com bash deploy.sh   # 跑 HTTP + 自动申请证书
#
#  可选环境变量：
#     DOMAIN        你的域名（不填则跳过 HTTPS，nginx 只监听 80）
#     EMAIL         Let's Encrypt 通知邮箱（DOMAIN 必填时才需要）
#     LLM_API_KEY   大模型 Key（不填则自动降级为内置规则引擎，功能仍可用）
#
#  这个脚本可以重复执行：已装的不重装、已有密码不重置、已有数据不覆盖。
# =============================================================================
set -euo pipefail

DOMAIN="${DOMAIN:-}"
# 允许用户误写成 https://xxx.com/ 或带末尾斜杠的形式，这里统一清洗成纯域名
DOMAIN="${DOMAIN#http://}"; DOMAIN="${DOMAIN#https://}"; DOMAIN="${DOMAIN%%/*}"
EMAIL="${EMAIL:-}"
LLM_API_KEY="${LLM_API_KEY:-}"

APP_DIR="/opt/ancarebox"
REPO="https://github.com/LinkWang-666/AnCareBox.git"
DB_NAME="smart_medbox"
DB_USER="ancare"
APP_PORT="3000"

log()  { printf '\n\033[1;36m==== %s ====\033[0m\n' "$*"; }
ok()   { printf '\033[1;32m  ✓ %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m  ! %s\033[0m\n' "$*"; }
die()  { printf '\n\033[1;31m  ✗ %s\033[0m\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------- 0. 前置检查
log "0/8 环境检查"
[ "$(id -u)" -eq 0 ] || die "请用 root 执行：sudo bash deploy.sh"
. /etc/os-release
[ "${ID:-}" = "ubuntu" ] || warn "当前系统是 ${PRETTY_NAME:-未知}，本脚本按 Ubuntu 编写，其他发行版请勿直接执行"
ok "$PRETTY_NAME / 内核 $(uname -r) / $(nproc) 核 / $(free -m | awk '/Mem:/{print $2}') MB 内存"

# 磁盘空间：node_modules + 数据库至少需要 600 MB
AVAIL=$(df -Pm / | awk 'NR==2{print $4}'); AVAIL="${AVAIL:-0}"
[ "$AVAIL" -ge 600 ] || warn "根分区剩余 ${AVAIL} MB，建议先清理，否则 npm 安装可能失败"

# ---------------------------------------------------------------- 1. 软件源
log "1/8 配置软件源"
if grep -qs "archive.ubuntu.com\|security.ubuntu.com" /etc/apt/sources.list /etc/apt/sources.list.d/*.sources 2>/dev/null; then
  BACKUP="/etc/apt/.sources.bak.$(date +%s)"
  cp -a /etc/apt/sources.list "$BACKUP.list" 2>/dev/null || true
  cp -a /etc/apt/sources.list.d "$BACKUP.d" 2>/dev/null || true
  sed -i 's|http://archive.ubuntu.com/ubuntu|https://mirrors.aliyun.com/ubuntu|g;
          s|http://security.ubuntu.com/ubuntu|https://mirrors.aliyun.com/ubuntu|g;
          s|http://ports.ubuntu.com/ubuntu-ports|https://mirrors.aliyun.com/ubuntu-ports|g' \
      /etc/apt/sources.list /etc/apt/sources.list.d/*.sources 2>/dev/null || true
  ok "已切换到阿里云镜像（原配置备份在 ${BACKUP}*）"
else
  ok "软件源已是国内镜像，无需改动"
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update -qq || die "apt update 失败，请检查网络或软件源"
apt-get install -y -qq ca-certificates curl gnupg git nginx >/dev/null
ok "基础软件包就绪（git / nginx / curl）"

# ---------------------------------------------------------------- 2. MySQL 8
log "2/8 数据库"
if command -v mysql >/dev/null 2>&1 && mysqladmin ping --silent >/dev/null 2>&1; then
  ok "MySQL 已安装并在运行：$(mysql --version | awk '{print $3}')"
else
  if ! command -v mysql >/dev/null 2>&1; then
    warn "未检测到 MySQL，开始安装 mysql-server（约 2-3 分钟）"
    apt-get install -y -qq mysql-server >/dev/null
  fi
  systemctl enable --now mysql >/dev/null 2>&1 || true
  for i in $(seq 1 30); do
    mysqladmin ping --silent >/dev/null 2>&1 && break
    sleep 1
  done
  mysqladmin ping --silent >/dev/null 2>&1 || die "MySQL 启动失败，查看日志：journalctl -u mysql -n 50"
  ok "MySQL 已安装并启动"
fi

VER=$(mysql -N -e "SELECT VERSION()" 2>/dev/null || echo "0")
case "$VER" in
  8.*) ok "版本 $VER（符合项目要求 8.0+）" ;;
  *)   die "当前 MySQL 版本 $VER，项目要求 8.0 及以上（依赖 JSON 函数与 utf8mb4 排序规则）" ;;
esac

# ---------------------------------------------------------------- 3. Node.js
log "3/8 Node.js 运行时"
NODE_MAJOR=$(node -v 2>/dev/null | sed 's/v\([0-9]*\).*/\1/' || echo 0)
if [ "${NODE_MAJOR:-0}" -ge 18 ]; then
  ok "已安装 Node $(node -v)，满足要求"
else
  warn "安装 Node.js 20（NodeSource 源，约 1-2 分钟）"
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null 2>&1 \
    || die "NodeSource 源添加失败，检查网络后重试"
  apt-get install -y -qq nodejs >/dev/null
  ok "已安装 Node $(node -v) / npm $(npm -v)"
fi

# ---------------------------------------------------------------- 4. 取代码
log "4/8 拉取代码到 $APP_DIR"
if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" remote set-url origin "$REPO"
  git -C "$APP_DIR" fetch --depth=1 origin main -q
  git -C "$APP_DIR" reset --hard origin/main -q
  ok "已更新到最新版（.env 与数据不受影响）"
else
  mkdir -p "$APP_DIR"
  git clone --depth=1 "$REPO" "$APP_DIR" -q || die "克隆失败，检查服务器能否访问 GitHub"
  ok "已克隆 $(git -C "$APP_DIR" rev-parse --short HEAD)"
fi
cd "$APP_DIR"

# ---------------------------------------------------------------- 5. 生成配置
log "5/8 生成 .env"
ENV_FILE="$APP_DIR/.env"

# 重复执行时沿用已有密码，避免把正在跑的库改坏
if [ -f "$ENV_FILE" ]; then
  DB_PASS=$(grep -E '^DB_PASSWORD=' "$ENV_FILE" | cut -d= -f2- || true)
  JWT_SECRET=$(grep -E '^JWT_SECRET=' "$ENV_FILE" | cut -d= -f2- || true)
fi
DB_PASS="${DB_PASS:-$(openssl rand -hex 16)}"
JWT_SECRET="${JWT_SECRET:-$(openssl rand -hex 32)}"

umask 077
cat > "$ENV_FILE" <<ENVEOF
# 由 deploy.sh 生成于 $(date '+%Y-%m-%d %H:%M:%S')
# 该文件含数据库密码与 JWT 密钥，权限已设为 600，切勿提交到 Git
DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=${DB_USER}
DB_PASSWORD=${DB_PASS}
DB_NAME=${DB_NAME}

JWT_SECRET=${JWT_SECRET}
JWT_ACCESS_TTL=2h
JWT_REFRESH_TTL=30d
JWT_DEVICE_TTL=180d
BCRYPT_COST=10
RATE_LIMIT_MAX=300

LLM_API_KEY=${LLM_API_KEY}
LLM_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
LLM_MODEL=qwen-plus
LLM_VISION_MODEL=qwen3-vl-plus
LLM_TIMEOUT=15000

PORT=${APP_PORT}
TRUST_PROXY=1
CORS_ORIGINS=${DOMAIN:+https://${DOMAIN}}
ENVEOF
chmod 600 "$ENV_FILE"
ok "已写入 $ENV_FILE（权限 600，含随机生成的数据库密码与 JWT 密钥）"

# ---------------------------------------------------------------- 6. 建库导数据
log "6/8 初始化数据库"
mysql <<SQLEOF || die "数据库或账号创建失败"
CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS '${DB_USER}'@'localhost' IDENTIFIED BY '${DB_PASS}';
CREATE USER IF NOT EXISTS '${DB_USER}'@'127.0.0.1' IDENTIFIED BY '${DB_PASS}';
ALTER USER '${DB_USER}'@'localhost' IDENTIFIED BY '${DB_PASS}';
ALTER USER '${DB_USER}'@'127.0.0.1' IDENTIFIED BY '${DB_PASS}';
GRANT ALL PRIVILEGES ON \`${DB_NAME}\`.* TO '${DB_USER}'@'localhost';
GRANT ALL PRIVILEGES ON \`${DB_NAME}\`.* TO '${DB_USER}'@'127.0.0.1';
FLUSH PRIVILEGES;
SQLEOF
ok "数据库 ${DB_NAME} 与专用账号 ${DB_USER} 就绪"

# 建表与种子数据用 root（socket 免密）执行：01_schema.sql 含 CREATE DATABASE，
# 需要全局 CREATE 权限，专用账号只给了单库权限，故意不给它这个能力。
# 用标记文件判断「导入是否已完成」：种子数据里有不带 IGNORE 的 INSERT，重复执行会主键冲突，
# 所以不能用「库里有表」当依据 —— 那会让中途失败的库永远补不齐。
IMPORT_MARK="$APP_DIR/.db-imported"
TABLES_BEFORE=$(mysql -N -e "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='${DB_NAME}'")
if [ -f "$IMPORT_MARK" ]; then
  ok "数据库此前已完整导入（现有 ${TABLES_BEFORE} 张表），跳过导入"
else
  if [ "${TABLES_BEFORE:-0}" -gt 0 ]; then
    warn "检测到上次导入中断残留的 ${TABLES_BEFORE} 张表，清空后完整重建（此为演示库，无业务数据）"
    mysql -e "DROP DATABASE \`${DB_NAME}\`; CREATE DATABASE \`${DB_NAME}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
  fi
  for f in 01_schema 02_seed 03_auth 04_demo_data 05_device_session 06_shared_medbox \
           07_ingredient 08_drug_conflict_alert 09_medicine_expiry_category \
           10_user_alert_prefs 11_expiry_alert 12_medicine_barcode; do
    # 显式指定库：05/07~12 这几个脚本内部没有 USE 语句（靠 DATABASE() 取当前库）
    mysql --default-character-set=utf8mb4 -D "${DB_NAME}" < "sql/${f}.sql" || die "导入 sql/${f}.sql 失败"
  done
  touch "$IMPORT_MARK"
  ok "12 个基础脚本导入完成"
fi

# 优先走国内镜像，失败再回退官方源（GitHub 克隆慢时往往 npm 也慢）
npm ci --omit=dev --no-audit --no-fund --registry=https://registry.npmmirror.com >/dev/null 2>&1 \
  || npm ci --omit=dev --no-audit --no-fund >/dev/null 2>&1 \
  || die "npm 依赖安装失败，检查网络后重试"
ok "依赖安装完成（9 个生产依赖）"

npm run --silent migrate:device >/dev/null 2>&1 || die "设备对接层迁移失败（sql/13_device_api.sql）"
ok "设备对接层迁移完成（+4 张表）"

npm run --silent seed-auth >/dev/null 2>&1 || die "演示账号生成失败"
git checkout -q README.md 2>/dev/null || true   # seed-auth 会往 README 写账号表，还原掉保持工作区干净
ok "演示账号已写入数据库（账号见 README 3.4 节）"

TABLES=$(mysql -N -e "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='${DB_NAME}'")
USERS=$(mysql -N -e "SELECT COUNT(*) FROM ${DB_NAME}.user" 2>/dev/null || echo 0)
ok "库中共 ${TABLES} 张表、${USERS} 个账号"

# ---------------------------------------------------------------- 7. 守护进程
log "7/8 启动服务（PM2）"
command -v pm2 >/dev/null 2>&1 || npm i -g pm2 --no-audit --no-fund --registry=https://registry.npmmirror.com >/dev/null 2>&1 \
  || npm i -g pm2 --no-audit --no-fund >/dev/null 2>&1
if pm2 describe ancarebox >/dev/null 2>&1; then
  pm2 restart ancarebox --update-env >/dev/null
else
  pm2 start server/app.js --name ancarebox --time >/dev/null
fi
pm2 save >/dev/null
pm2 startup systemd -u root --hp /root >/dev/null 2>&1 || true

# pm2 startup 只负责写 systemd 单元，不会启动它。
# 此时进程仍挂在「手动敲 pm2 start 拉起的那条守护进程」上，
# pm2-root.service 是 inactive —— 机器重启后 systemd 拉起的是空列表，站点不会恢复。
# 这里检测到这种情况就切过去，让 systemd 真正接管。
if systemctl list-unit-files 2>/dev/null | grep -q '^pm2-root\.service'; then
  systemctl enable pm2-root >/dev/null 2>&1 || true
  if ! systemctl is-active --quiet pm2-root; then
    pm2 kill >/dev/null 2>&1 || true
    sleep 1
    systemctl daemon-reload
    systemctl start pm2-root >/dev/null 2>&1 || true
    sleep 2
    # 兜底：万一进程列表没被恢复，别让站点停着
    pm2 describe ancarebox >/dev/null 2>&1 \
      || pm2 start server/app.js --name ancarebox --time >/dev/null
    ok "已切换到 systemd 托管（pm2-root），重启机器后自动恢复"
  fi
fi
ok "PM2 已托管，开机自启已配置"

sleep 3
for i in $(seq 1 15); do
  if curl -fsS "http://127.0.0.1:${APP_PORT}/api/health" >/dev/null 2>&1; then break; fi
  sleep 1
done
if curl -fsS "http://127.0.0.1:${APP_PORT}/api/health" >/dev/null 2>&1; then
  ok "健康检查通过：$(curl -fsS "http://127.0.0.1:${APP_PORT}/api/health")"
else
  pm2 logs ancarebox --lines 30 --nostream || true
  die "服务未起来，请把上面 30 行日志发我"
fi

# ---------------------------------------------------------------- 8. nginx / HTTPS
log "8/8 反向代理与证书"
CONF="/etc/nginx/sites-available/ancarebox"
cat > "$CONF" <<NGINXEOF
server {
    listen 80;
    listen [::]:80;
    server_name ${DOMAIN:-_};

    # 录音以 base64 上传，默认 1m 会直接 413
    client_max_body_size 25m;

    location / {
        proxy_pass http://127.0.0.1:${APP_PORT};
        proxy_http_version 1.1;
        proxy_set_header Host              \$host;
        proxy_set_header X-Real-IP         \$remote_addr;
        proxy_set_header X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header Upgrade           \$http_upgrade;
        proxy_set_header Connection        "upgrade";
        # 大模型调用 + 拍照识药可能耗时较长，默认 60s 容易断
        proxy_read_timeout 120s;
        proxy_send_timeout 120s;
    }
}
NGINXEOF
ln -sf "$CONF" /etc/nginx/sites-enabled/ancarebox
rm -f /etc/nginx/sites-enabled/default
nginx -t >/dev/null 2>&1 || die "nginx 配置有语法错误，执行 nginx -t 查看"
systemctl reload nginx
ok "nginx 已反代 80 → 127.0.0.1:${APP_PORT}"

if [ -n "$DOMAIN" ] && [ -n "$EMAIL" ]; then
  apt-get install -y -qq certbot python3-certbot-nginx >/dev/null
  if certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "$EMAIL" --redirect >/dev/null 2>&1; then
    ok "HTTPS 证书已签发并强制跳转：https://${DOMAIN}"
    ( crontab -l 2>/dev/null | grep -q certbot ) || \
      ( crontab -l 2>/dev/null; echo "0 3 1 * * certbot renew --quiet --deploy-hook 'systemctl reload nginx'" ) | crontab -
    ok "已配置每月自动续期"
  else
    warn "证书申请失败。最常见原因：域名未备案（大陆服务器 80/443 被封）或 DNS 尚未指向本机"
    warn "可稍后手动执行：certbot --nginx -d ${DOMAIN}"
  fi
elif [ -n "$DOMAIN" ]; then
  warn "只给了 DOMAIN 没给 EMAIL，跳过证书申请。稍后可手动执行：certbot --nginx -d ${DOMAIN}"
fi

# ---------------- 完成
# 优先问阿里云元数据服务（内网直达，返回绑定的公网 IP）；
# 退路才用 ipify 与 hostname -I —— 后者在 ECS 上拿到的是内网地址，贴给别人打不开。
PUBIP=$(curl -fsS -m 3 http://100.100.100.200/latest/meta-data/eipv4 2>/dev/null \
     || curl -fsS -m 6 https://api.ipify.org 2>/dev/null \
     || hostname -I | awk '{print $1}')
printf '\n\033[1;32m==================== 部署完成 ====================\033[0m\n\n'
printf '  首页（登录）   http://%s/login.html\n' "$PUBIP"
printf '  子女端         http://%s/index.html\n' "$PUBIP"
printf '  老人端         http://%s/elder.html\n' "$PUBIP"
if [ -n "$DOMAIN" ]; then
  printf '  域名访问       http://%s  /  https://%s\n' "$DOMAIN" "$DOMAIN"
fi
printf '\n  服务管理：pm2 status / pm2 logs ancarebox / pm2 restart ancarebox\n'
printf '  配置文件：%s（改了要 pm2 restart ancarebox）\n' "$ENV_FILE"
printf '  应用目录：%s\n' "$APP_DIR"
printf '  数据库：%s 库，专用账号 %s（密码在 .env 里）\n' "$DB_NAME" "$DB_USER"
printf '\n  \033[1;33m还需要在阿里云控制台做一件事：\033[0m\n'
printf '  安全组入方向放行 22、80、443（若先用 %s 端口验证，再放行 %s）\n' "$APP_PORT" "$APP_PORT"
printf '\n  演示账号见应用目录下 README.md 的 3.4 节\n'
printf '\033[1;32m=================================================\033[0m\n'
