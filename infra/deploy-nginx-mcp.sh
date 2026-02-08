#!/usr/bin/env bash
set -euo pipefail

NGINX_CONF="/etc/nginx/conf.d/api.conf"

echo "[deploy] backing up nginx config..."
sudo cp "$NGINX_CONF" "$NGINX_CONF.bak.$(date +%Y%m%d_%H%M%S)"

echo "[deploy] patching /mcp proxy_pass -> 3333..."
# Replace only the proxy_pass port inside the /mcp location block
sudo perl -0777 -i -pe 's#(location\s+/mcp\s*\{.*?proxy_pass\s+http://127\.0\.0\.1:)3000#${1}3333#s' "$NGINX_CONF"

echo "[deploy] ensuring auth headers are forwarded..."
# If headers already exist, don't duplicate; otherwise insert right after location /mcp {
if ! sudo perl -0777 -ne 'exit( /location\s+\/mcp\s*\{.*?proxy_set_header\s+x-api-key/s ? 0 : 1 )' "$NGINX_CONF"; then
  echo "[deploy] x-api-key header already present"
else
  sudo perl -0777 -i -pe 's#(location\s+/mcp\s*\{)#$1\n    proxy_set_header x-api-key $http_x_api_key;\n    proxy_set_header Authorization $http_authorization;#s' "$NGINX_CONF"
fi

echo "[deploy] validate + reload nginx..."
sudo nginx -t
sudo systemctl reload nginx

echo "[deploy] done."
