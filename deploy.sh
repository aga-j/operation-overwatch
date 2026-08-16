#!/bin/bash
set -e

PORT=${1:-8080}

echo "========================================="
echo "  Operation: Overwatch 部署脚本 (端口: ${PORT})"
echo "========================================="

# 1. 安装 nginx + git + unzip
echo "[1/5] 安装依赖..."
if command -v apt &>/dev/null; then
    apt update -qq && apt install -y -qq nginx git unzip
elif command -v dnf &>/dev/null; then
    dnf install -y nginx git unzip || {
        dnf install -y epel-release
        dnf install -y nginx git unzip
    }
elif command -v yum &>/dev/null; then
    yum install -y nginx git unzip || {
        yum install -y epel-release
        yum install -y nginx git unzip
    }
else
    echo "ERROR: 未识别的操作系统（无 apt/dnf/yum）"
    exit 1
fi

# 2. 拉取游戏代码
echo "[2/5] 拉取游戏代码..."
rm -rf /tmp/operation-overwatch /tmp/overwatch.zip
if git clone --depth 1 https://github.com/aga-j/operation-overwatch.git /tmp/operation-overwatch 2>/dev/null; then
    echo "  GitHub 直连成功"
elif git clone --depth 1 https://ghfast.top/https://github.com/aga-j/operation-overwatch.git /tmp/operation-overwatch 2>/dev/null; then
    echo "  通过镜像拉取成功"
else
    echo "  git clone 失败，尝试下载 zip..."
    curl -sL https://github.com/aga-j/operation-overwatch/archive/refs/heads/main.zip -o /tmp/overwatch.zip || \
    curl -sL https://ghfast.top/https://github.com/aga-j/operation-overwatch/archive/refs/heads/main.zip -o /tmp/overwatch.zip
    cd /tmp && unzip -q overwatch.zip && mv operation-overwatch-main operation-overwatch && cd /
fi

# 3. 部署文件
echo "[3/5] 部署文件到 /var/www/operation-overwatch..."
rm -rf /var/www/operation-overwatch
mkdir -p /var/www/operation-overwatch
cp -r /tmp/operation-overwatch/index.html \
      /tmp/operation-overwatch/src \
      /tmp/operation-overwatch/vendor \
      /tmp/operation-overwatch/fonts \
      /var/www/operation-overwatch/
rm -rf /tmp/operation-overwatch /tmp/overwatch.zip

# 4. 配置 nginx（写入完整 nginx.conf，兼容所有发行版）
echo "[4/5] 配置 nginx..."
NGINX_USER=$(awk '/^user /{print $2}' /etc/nginx/nginx.conf 2>/dev/null | tr -d ';' || echo "nginx")

cat > /etc/nginx/nginx.conf << NGINXEOF
user ${NGINX_USER};
worker_processes auto;
error_log /var/log/nginx/error.log;
pid /run/nginx.pid;

events {
    worker_connections 1024;
}

http {
    include /etc/nginx/mime.types;
    default_type application/octet-stream;
    sendfile on;
    keepalive_timeout 65;

    server {
        listen ${PORT} default_server;
        listen [::]:${PORT} default_server;
        server_name _;
        root /var/www/operation-overwatch;
        index index.html;

        location ~ \.(js|mjs)\$ {
            default_type text/javascript;
            add_header Cache-Control "no-cache";
        }

        location ~ \.woff2\$ {
            default_type font/woff2;
            add_header Cache-Control "public, max-age=31536000, immutable";
        }

        location /vendor/ {
            add_header Cache-Control "public, max-age=31536000, immutable";
        }

        location / {
            try_files \$uri \$uri/ =404;
        }
    }
}
NGINXEOF

# 5. 启动
echo "[5/5] 启动 nginx..."
nginx -t
systemctl restart nginx
systemctl enable nginx

PUBLIC_IP=$(curl -s ifconfig.me || curl -s ip.sb || echo "YOUR_SERVER_IP")

echo ""
echo "========================================="
echo "  部署完成!"
echo "  游戏地址: http://${PUBLIC_IP}:${PORT}/"
echo "========================================="
echo ""
echo "提示: 确保腾讯云控制台的防火墙已开放 ${PORT} 端口"
echo "      (轻量服务器 -> 防火墙 -> 添加规则 -> TCP:${PORT} 允许)"
