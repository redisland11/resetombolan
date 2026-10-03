#!/usr/bin/env bash
# Resetombolan – installerar eller uppdaterar tombolan på en Linux-server.
# Kör som root:  curl -fsSL <raw-url>/install.sh | bash
set -euo pipefail

RAW="${RAW:-https://raw.githubusercontent.com/redisland11/resetombolan/main}"
DIR=/opt/resetombolan
PORT="${PORT:-8080}"
SERVICE=resetombolan

[ "$(id -u)" -eq 0 ] || { echo "Kör som root, till exempel: curl -fsSL $RAW/install.sh | sudo bash"; exit 1; }
command -v curl >/dev/null || { echo "curl saknas: installera med apt install curl"; exit 1; }
command -v systemctl >/dev/null || { echo "Servern saknar systemd, starta i stället med: node $DIR/server.js"; exit 1; }

# --- Node.js 18 eller senare ---
node_ok() { command -v node >/dev/null 2>&1 && [ "$(node -p 'process.versions.node.split(".")[0]')" -ge 18 ]; }
if ! node_ok; then
  echo "→ Installerar Node.js 22 i /opt/node"
  case "$(uname -m)" in x86_64) A=x64 ;; aarch64) A=arm64 ;; *) echo "Okänd processor: $(uname -m)"; exit 1 ;; esac
  BASE=https://nodejs.org/dist/latest-v22.x
  SUMS=$(curl -fsSL "$BASE/SHASUMS256.txt")
  FILE=$(printf '%s\n' "$SUMS" | grep -o "node-v[0-9.]*-linux-$A\.tar\.xz" | head -1)
  TMP=$(mktemp -d)
  curl -fsSL "$BASE/$FILE" -o "$TMP/$FILE"
  (cd "$TMP" && printf '%s\n' "$SUMS" | grep " $FILE\$" | sha256sum -c - >/dev/null) || { echo "Kontrollsumman för Node stämmer inte"; exit 1; }
  command -v xz >/dev/null || { command -v apt-get >/dev/null && apt-get install -y -qq xz-utils >/dev/null; }
  rm -rf /opt/node && mkdir -p /opt/node && tar -xJf "$TMP/$FILE" -C /opt/node --strip-components=1
  ln -sf /opt/node/bin/node /usr/local/bin/node
  rm -rf "$TMP"
fi
NODE=$(command -v node)
echo "→ Node $($NODE -v)"

# --- filer ---
mkdir -p "$DIR"
curl -fsSL "$RAW/index.html" -o "$DIR/index.html.new" && mv "$DIR/index.html.new" "$DIR/index.html"
curl -fsSL "$RAW/server.js" -o "$DIR/server.js.new" && mv "$DIR/server.js.new" "$DIR/server.js"
id -u tombola >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin tombola
chown -R tombola:tombola "$DIR"

# --- ledig port (behåll den som redan används vid uppdatering) ---
if [ -f /etc/systemd/system/$SERVICE.service ]; then
  OLD=$(grep -o 'PORT=[0-9]*' /etc/systemd/system/$SERVICE.service | cut -d= -f2 || true)
  [ -n "${OLD:-}" ] && PORT=$OLD
  systemctl stop $SERVICE 2>/dev/null || true
fi
in_use() { ss -ltnH 2>/dev/null | awk '{print $4}' | grep -qE "[:.]$1\$"; }
while in_use "$PORT"; do PORT=$((PORT + 1)); done

# --- tjänst ---
cat > /etc/systemd/system/$SERVICE.service <<EOF
[Unit]
Description=Resetombolan
After=network.target

[Service]
WorkingDirectory=$DIR
ExecStart=$NODE $DIR/server.js
Environment=PORT=$PORT
Restart=always
User=tombola
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=$DIR

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now $SERVICE >/dev/null 2>&1
systemctl restart $SERVICE

# --- brandvägg ---
if command -v ufw >/dev/null && ufw status 2>/dev/null | grep -q "Status: active"; then ufw allow "$PORT/tcp" >/dev/null; echo "→ Öppnade port $PORT i ufw"; fi
if command -v firewall-cmd >/dev/null && firewall-cmd --state >/dev/null 2>&1; then firewall-cmd -q --add-port="$PORT/tcp" --permanent && firewall-cmd -q --reload; echo "→ Öppnade port $PORT i firewalld"; fi

# --- klart ---
for _ in $(seq 1 20); do [ -s "$DIR/admin-key.txt" ] && break; sleep 0.5; done
if ! systemctl is-active --quiet $SERVICE; then echo "Tjänsten startade inte. Se: journalctl -u $SERVICE -n 30"; exit 1; fi
IP=$(curl -fsS4 --max-time 4 https://ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}')
echo
echo "  Tombolan är igång."
echo "  Deltagare:   http://$IP:$PORT/"
echo "  Admin:       http://$IP:$PORT/admin"
echo "  Adminnyckel: $(cat "$DIR/admin-key.txt" 2>/dev/null || echo 'se /opt/resetombolan/admin-key.txt')"
echo
