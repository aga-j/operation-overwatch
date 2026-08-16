#!/bin/bash
set -e

echo "========================================="
echo "  Operation: Overwatch 部署脚本"
echo "========================================="

# 1. 安装 nginx
echo "[1/5] 安装 nginx..."
apt update -qq && apt install -y -qq nginx git

# 2. 拉取游戏代码
echo "[2/5] 拉取游戏代码..."
rm -rf /tmp/operation-overwatch
if ! git clone --depth 1 https://github.com/aga-j/operation-overwatch.git /tmp/operation-overwatch 2>/dev/null; then
  echo "  GitHub 直连失败，尝试镜像..."
  git clone --depth 1 https://ghfast.top/https://github.com/aga-j/operation-overwatch.git /tmp/operation-overwatch
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
rm -rf /tmp/operation-overwatch

# 4. 配置 nginx
echo "[4/5] 配置 nginx..."
cat > /etc/nginx/sites-available/operation-overwatch << 'EOF'
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name _;
    root /var/www/operation-overwatch;
    index index.html;

    # ES Module 必须正确的 MIME 类型
    location ~ \.(js|mjs)$ {
        default_type text/javascript;
        add_header Cache-Control "no-cache";
    }

    # 字体
    location ~ \.woff2$ {
        default_type font/woff2;
        add_header Cache-Control "public, max-age=31536000, immutable";
    }

    # 静态资源缓存
    location /vendor/ {
        add_header Cache-Control "public, max-age=31536000, immutable";
    }

    location / {
        try_files $uri $uri/ =404;
    }
}
EOF

ln -sf /etc/nginx/sites-available/operation-overwatch /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default

# 5. 启动
echo "[5/5] 启动 nginx..."
nginx -t
systemctl restart nginx
systemctl enable nginx

# 获取公网 IP
PUBLIC_IP=$(curl -s ifconfig.me || curl -s ip.sb || echo "YOUR_SERVER_IP")

echo ""
echo "========================================="
echo "  部署完成!"
echo "  游戏地址: http://${PUBLIC_IP}/"
echo "========================================="
echo ""
echo "提示: 确保腾讯云控制台的防火墙已开放 80 端口"
echo "      (轻量服务器 → 防火墙 → 添加规则 → TCP:80 允许)"
