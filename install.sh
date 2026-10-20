#!/usr/bin/env bash
# =====================================================================
#  AVM Panel installer - LXC + KVM virtual machine panel (Incus)
#  Needs a real server or a KVM VPS. Docker / LXC / OpenVZ containers
#  are NOT supported (they cannot run Incus).
#
#  Usage:  sudo bash install.sh              panel + local node
#          sudo bash install.sh --node-only  extra host (node daemon only)
# =====================================================================
set -uo pipefail

REPO_URL="${REPO_URL:-https://github.com/adityazdomainzz-code/AVM.git}"
REPO_BRANCH="${REPO_BRANCH:-main}"
INSTALL_DIR="${INSTALL_DIR:-/opt/avm}"
NODE_PORT="${NODE_PORT:-8090}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd || echo /nonexistent)"
NODE_ONLY=0; [[ "${1:-}" == "--node-only" ]] && NODE_ONLY=1

C=$'\e[38;5;45m'; W=$'\e[97m'; G=$'\e[32m'; Y=$'\e[33m'; R=$'\e[31m'; B=$'\e[1m'; N=$'\e[0m'
step() { echo; echo "${C}${B}❄ $*${N}"; }
ok()   { echo "  ${G}✔${N} $*"; }
warn() { echo "  ${Y}!${N} $*"; }
die()  { echo; echo "  ${R}✘ $*${N}"; exit 1; }
HAS_TTY=0; { : </dev/tty; } 2>/dev/null && HAS_TTY=1
ask()  { local q="$1" def="${2:-}" v=""; if [ "$HAS_TTY" = 1 ]; then read -rp "  ${W}${q}${N}${def:+ [$def]}: " v </dev/tty || true; fi; echo "${v:-$def}"; }
asks() { local q="$1" v=""; if [ "$HAS_TTY" = 1 ]; then read -rsp "  ${W}${q}${N}: " v </dev/tty || true; echo >&2; fi; echo "$v"; }
LOG=/tmp/avm-install.log; : > "$LOG"
apt_i() { DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "$@" >>"$LOG" 2>&1 || { dpkg --configure -a >>"$LOG" 2>&1; DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "$@" >>"$LOG" 2>&1; }; }

cat <<EOF
${C}
     █████╗ ██╗   ██╗███╗   ███╗
    ██╔══██╗██║   ██║████╗ ████║   ${W}Virtual Machine Panel${C}
    ███████║██║   ██║██╔████╔██║   ${W}LXC  ·  KVM  ·  Incus${C}
    ██╔══██║╚██╗ ██╔╝██║╚██╔╝██║
    ██║  ██║ ╚████╔╝ ██║ ╚═╝ ██║
    ╚═╝  ╚═╝  ╚═══╝  ╚═╝     ╚═╝${N}
EOF

[ "$(id -u)" -eq 0 ] || die "Run as root:  sudo bash install.sh"
command -v apt-get >/dev/null || die "AVM supports Debian 12/13 and Ubuntu 22.04/24.04 (apt based)"

# ---------------------------------------------------------------- host checks
step "[1/8] Checking this machine"
VIRT="$(systemd-detect-virt -c 2>/dev/null || echo none)"
if [ -f /.dockerenv ] || grep -qa 'container=' /proc/1/environ 2>/dev/null || { [ -d /proc/vz ] && [ ! -d /proc/bc ]; } || [ "$VIRT" != none ]; then
  die "This is a container (${VIRT}). AVM needs a dedicated server or a KVM VPS - Docker, LXC and OpenVZ containers cannot run virtual machines."
fi
ok "Not a container ($(systemd-detect-virt 2>/dev/null || echo bare-metal))"
KVM=0
if [ -e /dev/kvm ] || grep -Eq '(vmx|svm)' /proc/cpuinfo; then
  modprobe kvm_intel 2>/dev/null || modprobe kvm_amd 2>/dev/null || true
  [ -e /dev/kvm ] && KVM=1
fi
[ "$KVM" = 1 ] && ok "KVM available - LXC containers and KVM VMs" || warn "No /dev/kvm (nested virtualization off?) - only LXC containers will work"
. /etc/os-release
ok "OS: $PRETTY_NAME"

# ---------------------------------------------------------------- packages
step "[2/8] Base packages"
apt-get update -qq >>"$LOG" 2>&1 || warn "apt-get update had errors (continuing)"
apt_i git curl ca-certificates openssl tar gnupg iptables iproute2 || die "Package install failed - see $LOG"
ok "git, curl, iptables ready"

# ---------------------------------------------------------------- clone + verify
step "[3/8] Cloning $REPO_URL"
TMP="$(mktemp -d)"; SRC="$TMP/repo"
git clone -q --depth 1 -b "$REPO_BRANCH" "$REPO_URL" "$SRC" 2>>"$LOG" || git clone -q --depth 1 "$REPO_URL" "$SRC" 2>>"$LOG" || { warn "Could not clone the repo"; mkdir -p "$SRC"; }
REQUIRED=(panel/package.json panel/src/server.js panel/src/db.js panel/src/cli.js panel/public/index.html panel/public/css/style.css panel/public/js/app.js panel/public/js/ice.js node/package.json node/src/daemon.js node/src/incus.js node/src/net.js)
BASE=""; found="$(find "$SRC" -maxdepth 4 -path '*/node/src/incus.js' -not -path '*/node_modules/*' 2>/dev/null | head -n1)"; [ -n "$found" ] && BASE="${found%/node/src/incus.js}"
MISSING=0
for f in "${REQUIRED[@]}"; do if [ -n "$BASE" ] && [ -f "$BASE/$f" ]; then echo "    ${G}✔${N} $f"; else echo "    ${R}✘${N} $f"; MISSING=$((MISSING+1)); fi; done
if [ "$MISSING" -gt 0 ]; then
  ALL=1; for f in "${REQUIRED[@]}"; do [ -f "$SCRIPT_DIR/$f" ] || ALL=0; done
  [ "$ALL" = 1 ] || die "$MISSING file(s) missing. Push the AVM zip contents (panel/, node/, install.sh) to the repo root."
  warn "Repo incomplete - using the files next to install.sh"; BASE="$SCRIPT_DIR"
else ok "All ${#REQUIRED[@]} files found"; fi
mkdir -p "$INSTALL_DIR"
tar -C "$BASE" --exclude=node_modules --exclude=panel/data --exclude=node/data --exclude=panel/config.json --exclude=node/config.json -cf - panel node | tar -C "$INSTALL_DIR" -xf - || die "Copy failed"
cp -f "$BASE/install.sh" "$INSTALL_DIR/install.sh" 2>/dev/null || true
ok "Installed to $INSTALL_DIR (data + config kept on re-install)"

# ---------------------------------------------------------------- incus
step "[4/8] Incus (LXC + KVM)"
if ! command -v incus >/dev/null; then
  mkdir -p /etc/apt/keyrings
  if curl -fsSL https://pkgs.zabbly.com/key.asc -o /etc/apt/keyrings/zabbly.asc 2>>"$LOG"; then
    cat > /etc/apt/sources.list.d/zabbly-incus-stable.sources <<EOS
Enabled: yes
Types: deb
URIs: https://pkgs.zabbly.com/incus/stable
Suites: ${VERSION_CODENAME}
Components: main
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/zabbly.asc
EOS
    apt-get update -qq >>"$LOG" 2>&1
  fi
  apt_i incus || { warn "Zabbly repo failed - trying distro package"; rm -f /etc/apt/sources.list.d/zabbly-incus-stable.sources; apt-get update -qq >>"$LOG" 2>&1; apt_i incus qemu-system-x86 ovmf || die "Could not install Incus - see $LOG"; }
fi
systemctl enable --now incus >>"$LOG" 2>&1 || true
for _ in $(seq 1 20); do incus info >/dev/null 2>&1 && break; sleep 1; done
incus info >/dev/null 2>&1 || die "Incus is installed but not responding - see: journalctl -u incus"
if [ -z "$(incus storage list --format csv 2>/dev/null)" ]; then
  incus admin init --auto >>"$LOG" 2>&1 || die "incus admin init failed - see $LOG"
  ok "Incus initialised (storage pool + incusbr0 NAT bridge)"
fi
incus network show incusbr0 >/dev/null 2>&1 || incus network create incusbr0 >>"$LOG" 2>&1
ok "Incus $(incus version 2>/dev/null | tail -n1 | awk '{print $NF}') ready · bridge $(incus network get incusbr0 ipv4.address 2>/dev/null)"
sysctl -w net.ipv4.ip_forward=1 >/dev/null 2>&1; echo 'net.ipv4.ip_forward=1' > /etc/sysctl.d/99-avm.conf
if command -v ufw >/dev/null && ufw status 2>/dev/null | grep -q 'Status: active'; then
  ufw allow in on incusbr0 >/dev/null; ufw route allow in on incusbr0 >/dev/null; ufw route allow out on incusbr0 >/dev/null
  ok "ufw active - bridge traffic allowed (port rules are added per VM)"
fi

# ---------------------------------------------------------------- node.js
step "[5/8] Node.js + pm2"
NODE_MAJOR=0; command -v node >/dev/null && NODE_MAJOR="$(node -v | sed 's/v\([0-9]*\).*/\1/')"
if [ "$NODE_MAJOR" -lt 18 ]; then curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >>"$LOG" 2>&1 && apt_i nodejs; fi
command -v node >/dev/null || die "Node.js install failed"
command -v pm2 >/dev/null || npm install -g pm2 --silent >>"$LOG" 2>&1 || die "pm2 install failed"
ok "Node.js $(node -v) · pm2 $(pm2 -v 2>/dev/null | tail -n1)"

# ---------------------------------------------------------------- config
step "[6/8] Configuration"
port_free() { node -e 'const s=require("net").createServer();s.once("error",()=>process.exit(1));s.listen(+process.argv[1],"0.0.0.0",()=>s.close(()=>process.exit(0)))' "$1" 2>/dev/null; }
next_free() { local p="$1"; for _ in $(seq 1 50); do port_free "$p" && { echo "$p"; return; }; p=$((p+1)); done; echo "$1"; }
PUBLIC_IP="$(curl -4 -fsS --max-time 6 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')"
NODE_CFG="$INSTALL_DIR/node/config.json"; PANEL_CFG="$INSTALL_DIR/panel/config.json"; ENV_FILE="$INSTALL_DIR/.install.env"
[ -f "$ENV_FILE" ] && . "$ENV_FILE"
if [ ! -f "$NODE_CFG" ]; then
  pm2 delete avm-node >/dev/null 2>&1 || true
  FREE="$(next_free "$NODE_PORT")"; [ "$FREE" != "$NODE_PORT" ] && warn "Port $NODE_PORT busy - node uses $FREE"; NODE_PORT="$FREE"
  NH=127.0.0.1; [ "$NODE_ONLY" = 1 ] && NH=0.0.0.0
  T="$(openssl rand -hex 32)" P="$NODE_PORT" H="$NH" CFG="$NODE_CFG" node -e 'const e=process.env;require("fs").writeFileSync(e.CFG,JSON.stringify({port:+e.P,host:e.H,token:e.T,bridge:"incusbr0"},null,2))'
  chmod 600 "$NODE_CFG"; ok "Node config created"
else ok "Keeping node config"; fi
NODE_TOKEN="$(node -e 'console.log(require(process.argv[1]).token)' "$NODE_CFG")"
NODE_PORT="$(node -e 'console.log(require(process.argv[1]).port)' "$NODE_CFG")"

ACCESS_MODE="${ACCESS_MODE:-1}"
if [ "$NODE_ONLY" = 0 ]; then
  if [ ! -f "$PANEL_CFG" ]; then
    echo; echo "  ${B}How should people open the panel?${N}"
    echo "    ${C}1)${N} Public IP          http://${PUBLIC_IP}:PORT"
    echo "    ${C}2)${N} Cloudflare Tunnel  https://panel.yourdomain.com"
    ACCESS_MODE="$(ask 'Choose 1 or 2' 1)"; [[ "$ACCESS_MODE" =~ ^[12]$ ]] || ACCESS_MODE=1
    pm2 delete avm-panel >/dev/null 2>&1 || true
    DP="$(next_free 8000)"; PANEL_PORT="$(ask 'Panel port' "$DP")"
    PUBLIC_IP="$(ask 'Public IP of this server' "$PUBLIC_IP")"
    AU="$(ask 'Admin username' admin)"; AE="$(ask 'Admin email' admin@localhost)"; AP="$(asks 'Admin password (empty = generate)')"
    GEN=0; if [ "${#AP}" -lt 6 ]; then AP="$(openssl rand -base64 12 | tr -dc 'A-Za-z0-9' | head -c 12)"; GEN=1; fi
    PH=0.0.0.0; [ "$ACCESS_MODE" = 2 ] && PH=127.0.0.1
    if [ "$ACCESS_MODE" = 2 ] && [ -z "${CF_TUNNEL_TOKEN:-}" ]; then
      echo "  Cloudflare → Zero Trust → Networks → Tunnels → create tunnel, add Public Hostname → ${B}http://localhost:${PANEL_PORT}${N}"
      CF_TUNNEL_TOKEN="$(ask 'Paste tunnel token' '')"; [ -n "$CF_TUNNEL_TOKEN" ] || { warn "No token - using Public IP mode"; ACCESS_MODE=1; PH=0.0.0.0; }
    fi
    P="$PANEL_PORT" H="$PH" AU="$AU" AE="$AE" AP="$AP" NT="$NODE_TOKEN" NP="$NODE_PORT" IP="$PUBLIC_IP" CFG="$PANEL_CFG" node -e '
      const e=process.env;require("fs").writeFileSync(e.CFG,JSON.stringify({port:+e.P,host:e.H,admin:{username:e.AU,email:e.AE,password:e.AP},localNode:{url:"http://127.0.0.1:"+e.NP,token:e.NT,publicIp:e.IP}},null,2))'
    chmod 600 "$PANEL_CFG"
    printf 'ACCESS_MODE=%q\nCF_TUNNEL_TOKEN=%q\n' "$ACCESS_MODE" "${CF_TUNNEL_TOKEN:-}" > "$ENV_FILE"; chmod 600 "$ENV_FILE"
    ok "Panel config created"
  else ok "Keeping panel config"; fi
  PANEL_PORT="$(node -e 'console.log(require(process.argv[1]).port)' "$PANEL_CFG")"
fi

# ---------------------------------------------------------------- deps
step "[7/8] Installing dependencies"
( cd "$INSTALL_DIR/node" && npm install --omit=dev --no-audit --no-fund --silent >>"$LOG" 2>&1 ) || die "npm install failed (node) - see $LOG"
ok "node daemon (incl. web terminal)"
if [ "$NODE_ONLY" = 0 ]; then ( cd "$INSTALL_DIR/panel" && npm install --omit=dev --no-audit --no-fund --silent >>"$LOG" 2>&1 ) || die "npm install failed (panel)"; ok "panel"; fi

# ---------------------------------------------------------------- start
step "[8/8] Starting services one by one"
wait_http() { for _ in $(seq 1 30); do curl -fsS "$1" >/dev/null 2>&1 && return 0; sleep 1; done; return 1; }
pm2 delete avm-node >/dev/null 2>&1 || true
pm2 start "$INSTALL_DIR/node/src/daemon.js" --name avm-node --cwd "$INSTALL_DIR/node" >/dev/null || die "Could not start node"
wait_http "http://127.0.0.1:${NODE_PORT}/health" && ok "Node daemon online   :${NODE_PORT}" || die "Node did not start - pm2 logs avm-node"
if [ "$NODE_ONLY" = 0 ]; then
  pm2 delete avm-panel >/dev/null 2>&1 || true
  pm2 start "$INSTALL_DIR/panel/src/server.js" --name avm-panel --cwd "$INSTALL_DIR/panel" >/dev/null || die "Could not start panel"
  wait_http "http://127.0.0.1:${PANEL_PORT}/health" && ok "Panel online         :${PANEL_PORT}" || die "Panel did not start - pm2 logs avm-panel"
  if [ "${ACCESS_MODE:-1}" = 2 ] && [ -n "${CF_TUNNEL_TOKEN:-}" ]; then
    if ! command -v cloudflared >/dev/null; then
      case "$(uname -m)" in x86_64) CA=amd64;; aarch64|arm64) CA=arm64;; *) CA=amd64;; esac
      curl -fsSL -o /usr/local/bin/cloudflared "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-$CA" && chmod +x /usr/local/bin/cloudflared
    fi
    pm2 delete avm-tunnel >/dev/null 2>&1 || true
    pm2 start "$(command -v cloudflared)" --name avm-tunnel -- tunnel --no-autoupdate run --token "$CF_TUNNEL_TOKEN" >/dev/null && ok "Cloudflare tunnel started" || warn "Tunnel failed - pm2 logs avm-tunnel"
  fi
fi
pm2 save >/dev/null 2>&1
pm2 startup systemd -u root --hp /root >/dev/null 2>&1 && ok "Auto-start on boot enabled"
rm -rf "$TMP"

echo; echo "${C}${B}  ❄ ═══════════════════════════════════════════════ ❄${N}"
if [ "$NODE_ONLY" = 1 ]; then
  echo "  ${G}${B}Node ready!${N} Add it in Admin area → Nodes:"
  echo "    Daemon URL : ${B}http://${PUBLIC_IP}:${NODE_PORT}${N}"
  echo "    Token      : ${B}${NODE_TOKEN}${N}"
  echo "    Public IP  : ${B}${PUBLIC_IP}${N}"
  echo "  Allow TCP ${NODE_PORT} from the panel server, and the VM port range (default 20000-30000)."
else
  echo "  ${G}${B}AVM Panel is ready!${N}"
  [ "${ACCESS_MODE:-1}" = 2 ] && [ -n "${CF_TUNNEL_TOKEN:-}" ] && echo "    Panel : ${B}https://<your tunnel hostname>${N}" || echo "    Panel : ${B}http://${PUBLIC_IP}:${PANEL_PORT}${N}"
  [ -n "${AU:-}" ] && echo "    Login : ${B}${AU}${N}"
  [ "${GEN:-0}" = 1 ] && echo "    Pass  : ${B}${AP}${N}   (generated - change it in Account)"
  echo "    KVM   : $([ "$KVM" = 1 ] && echo yes || echo 'no - LXC only')"
  echo "    Open the VM port range 20000-30000 (TCP/UDP) in your provider firewall."
  echo "    Logs  : pm2 logs avm-panel | pm2 logs avm-node      Install log: $LOG"
fi
echo "${C}${B}  ❄ ═══════════════════════════════════════════════ ❄${N}"
