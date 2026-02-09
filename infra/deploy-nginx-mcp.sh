#!/usr/bin/env bash
set -euo pipefail

NGINX_CONF="/etc/nginx/conf.d/api.conf"

echo "[deploy] backing up nginx config..."
sudo cp "$NGINX_CONF" "$NGINX_CONF.bak.$(date +%Y%m%d_%H%M%S)"

echo "[deploy] patching /mcp proxy_pass -> 3333..."
sudo perl -0777 -i -pe 's#(location\s+/mcp\s*\{.*?proxy_pass\s+http://127\.0\.0\.1:)3000#${1}3333#s' "$NGINX_CONF"

echo "[deploy] ensuring auth headers are forwarded..."
if sudo grep -q "location.*/mcp" "$NGINX_CONF" && sudo awk '/location.*\/mcp/,/^[[:space:]]*\}/ {if (/proxy_set_header.*x-api-key/) {found=1}} END {exit !found}' "$NGINX_CONF"; then
  echo "[deploy] x-api-key header already present"
else
  echo "[deploy] adding auth headers..."
  TMP_HEADERS=$(mktemp)
  cat > "$TMP_HEADERS" << 'EOF'
    proxy_set_header x-api-key $http_x_api_key;
    proxy_set_header Authorization $http_authorization;
EOF
  sudo sed -i '/location.*\/mcp.*{/r '"$TMP_HEADERS" "$NGINX_CONF"
  rm -f "$TMP_HEADERS"
fi

echo "[deploy] validate + reload nginx..."
sudo nginx -t
sudo systemctl reload nginx

echo "[deploy] done."
