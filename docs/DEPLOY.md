# 部署到云服务器（阿里云 ECS · Ubuntu）

本文记录从零把系统部署到一台公网服务器的完整过程。脚本 `deploy/deploy.sh` 会自动完成其中第 3 步的全部工作，其余步骤需在云控制台操作。

---

## 0. 先确认三件事（不确认会白折腾）

| 项 | 要求 | 不满足的后果 |
|---|---|---|
| 系统 | Ubuntu 20.04 / 22.04 / 24.04 | 脚本按 `apt` 写，CentOS 系需改包管理命令 |
| MySQL | 8.0+ | 项目用到 `JSON_ARRAYAGG` 等 8.0 函数，5.7 会报错 |
| 域名 | **大陆地域的服务器必须先完成 ICP 备案** | 未备案时 80/443 被运营商拦截，浏览器打不开，证书也签不下来 |

### 域名备案的三种处理方式

1. **已备案**：直接按本文走，最后一步自动签 HTTPS 证书
2. **未备案但服务器在大陆**：先用 `http://公网IP` 验证功能（此时跳过 `DOMAIN` 参数），备案下来后再执行一次带域名的部署命令
3. **服务器在香港/海外地域**：无需备案，可直接绑域名签证书

> 备案是域名 + 服务器地域绑定的，换服务器要重新备案。周期一般 7–20 个工作日。

---

## 1. 云控制台准备

### 1.1 拿到公网 IP

```
ECS 控制台 → 实例 → 点开实例名 → 基本信息 → 「公网 IP」
```

### 1.2 设置登录密码

新实例默认没有可用密码，必须重置一次：

```
实例列表 → 目标实例右侧「⋯」→ 密码/密钥 → 重置实例密码
→ 输入新密码 → 重启实例生效
```

> 若实例是「密钥对」方式创建，则不需要密码，登录时用 `.pem` 私钥。
> 但用下文 Workbench 网页终端时，密码方式最省事。

### 1.3 放行端口（最容易漏的一步）

阿里云默认安全组只开 22，Web 端口必须手动加：

```
实例 → 安全组 → 配置规则 → 入方向 → 手动添加
  协议类型 HTTP(80)    授权对象 0.0.0.0/0
  协议类型 HTTPS(443)  授权对象 0.0.0.0/0
  （若先用端口验证，再加一条 自定义 TCP 3000）
```

不放行的话，服务在本机 `curl` 能通、浏览器却打不开——现象是「连接超时」。

### 1.4 连接服务器

不用装 SSH 客户端，控制台自带网页终端：

```
实例右侧「远程连接」→ Workbench 远程连接 → 输入 root 密码
```

会打开一个浏览器里的黑色终端，后续命令都在这里敲。

---

## 2. 域名解析（有域名才需要）

```
云解析 DNS → 域名 → 解析设置 → 添加记录
  记录类型 A    主机记录 @     记录值 <公网IP>    TTL 600
  记录类型 A    主机记录 www   记录值 <公网IP>    TTL 600
```

验证是否生效（在服务器上执行）：

```bash
ping -c 2 your-domain.com     # 应显示你的公网 IP，而不是别的地址
```

> DNS 生效通常 1–10 分钟。没生效就去申请证书，一定失败。

---

## 3. 一键部署

服务器上执行（二选一）：

```bash
# A. 先用 IP 跑通，不签证书
curl -fsSLO https://raw.githubusercontent.com/LinkWang-666/AnCareBox/main/deploy/deploy.sh
sudo bash deploy.sh

# B. 域名已验证可解析，顺带签 HTTPS 证书
curl -fsSLO https://raw.githubusercontent.com/LinkWang-666/AnCareBox/main/deploy/deploy.sh
sudo DOMAIN=your-domain.com EMAIL=you@example.com bash deploy.sh
```

若服务器访问 GitHub 不稳定，可先用 `git clone` 在本地取到脚本，再用 Workbench 的「上传文件」功能传上去。

### 脚本做了什么

| 步骤 | 动作 |
|---|---|
| 1 | 软件源切阿里云镜像，安装 git / nginx / curl |
| 2 | 检测 MySQL，没有则装 `mysql-server`（8.0），并校验版本 |
| 3 | 检测 Node，低于 18 则装 20（NodeSource） |
| 4 | 克隆代码到 `/opt/ancarebox`，重复执行则 `fetch + reset` 更新 |
| 5 | 生成 `.env`：随机 32 字节 JWT 密钥、随机数据库密码，权限 600 |
| 6 | 建库建账号（专用账号 `ancare`，只授权单库）、导入 12 个 SQL、跑设备迁移与演示账号 |
| 7 | PM2 托管 + 开机自启 + 健康检查 |
| 8 | nginx 反代 80 → 3000（`client_max_body_size 25m`、超时 120s），有域名则签证书并配自动续期 |

**可重复执行**：已装的不重装、`.env` 里已有的密码不重置、库里已有表则跳过导入（避免覆盖数据）。

---

## 4. 部署后验证

```bash
# 1. 服务活着吗
curl -s http://127.0.0.1:3000/api/health
# 期望：{"ok":true,"mysql":{"version":"8.0.xx"}}

# 2. 表与账号数量
mysql -N -e "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='smart_medbox'"   # 期望 18
mysql -N -e "SELECT COUNT(*) FROM smart_medbox.user"                                              # 期望 5

# 3. 浏览器打开
http://<公网IP>/login.html
```

演示账号见应用目录下 `README.md` 的 3.4 节（`wang_owner / medbox2026` 等）。

---

## 5. 日常运维

```bash
pm2 status                       # 进程状态、内存、重启次数
pm2 logs ancarebox --lines 100   # 实时日志
pm2 restart ancarebox            # 改了 .env 或代码后重启
pm2 monit                        # CPU / 内存面板

sudo nginx -t && sudo systemctl reload nginx    # 改 nginx 配置后
sudo systemctl status mysql                     # 数据库状态

# 更新到仓库最新版
cd /opt/ancarebox && git pull && npm ci --omit=dev && pm2 restart ancarebox
```

数据库备份（建议加进 crontab）：

```bash
mysqldump -u root smart_medbox | gzip > /root/backup-$(date +%F).sql.gz
```

---

## 6. 常见问题

| 现象 | 原因 | 处理 |
|---|---|---|
| 浏览器「连接超时」 | 安全组没放行 80 | 控制台补入方向规则 |
| 浏览器 502 Bad Gateway | Node 服务没起来 | `pm2 logs ancarebox --lines 50` 看报错 |
| `curl` 本机能通、外网不通 | 应用绑了 `127.0.0.1` 或安全组未放行 | 本项目监听 `0.0.0.0`，问题多在安全组 |
| 上传录音报 413 | nginx 请求体上限 | 脚本已设 `client_max_body_size 25m`，自定义配置时别漏 |
| 证书申请失败 | 域名未备案 / DNS 未生效 / 80 被占 | `dig your-domain.com` 确认解析，备案查询用工信部系统 |
| `git clone` 卡住或失败 | 国内访问 GitHub 不稳定 | 改用 Gitee 镜像仓库，或本地打包上传后解压 |
| `npm ci` 卡住 | registry 慢 | 脚本已优先用 `registry.npmmirror.com`，仍慢可手动 `npm config set registry` |
| 登录后立刻掉线 | 反向代理没传 `X-Forwarded-Proto` | 脚本配置已包含；自定义 nginx 时需保留 |
| 限流误伤所有访客 | 没开 `TRUST_PROXY` | `.env` 中设 `TRUST_PROXY=1`（脚本已自动写入） |

---

## 7. 对外暴露后的安全清单

比赛演示可以直接用，但如果长期挂在公网，建议依次做：

1. **改掉演示账号密码**：`wang_owner / medbox2026` 是公开在 README 里的
2. **`.env` 不进 Git**：已在 `.gitignore` 中，服务器上权限 600
3. **数据库不对外**：MySQL 只监听 `127.0.0.1`（默认即是），安全组不要放行 3306
4. **限制 3000 端口**：用 nginx 反代后，安全组不必再放行 3000
5. **开启日志轮转**：`pm2 install pm2-logrotate`
