#!/usr/bin/env bash
# =============================================================================
#  T-Pic Manager — ตัวติดตั้งอัตโนมัติสำหรับ Ubuntu
#
#  sudo ./install.sh                 ติดตั้ง / อัปเกรด (พอร์ตเริ่มต้น 2681)
#  sudo ./install.sh --port 3000     ติดตั้งโดยใช้พอร์ตอื่น
#
#  สิ่งที่สคริปต์ทำ:
#   1. ตรวจ Node.js >= 22.13 — ถ้าไม่มีหรือเก่าไป จะติดตั้งให้
#      (จากไฟล์ใน ./offline/ ก่อน ถ้าไม่มีจะดาวน์โหลดจาก nodejs.org)
#   2. สร้างผู้ใช้ระบบ t-pic, โฟลเดอร์โปรแกรม /opt/t-pic, ข้อมูล /var/lib/t-pic
#   3. สร้าง systemd service "t-pic" ให้เริ่มเองตอนบูต
#   4. เปิดพอร์ตใน ufw (ถ้าเปิดใช้ ufw อยู่)
#   5. ตรวจว่าระบบทำงานได้จริง แล้วแสดงลิงก์สำหรับเข้าใช้งาน
#
#  รันซ้ำได้เสมอ (ใช้อัปเกรดเวอร์ชัน) — ข้อมูลรูปและผู้ใช้จะไม่หาย
# =============================================================================
set -Eeuo pipefail

APP_NAME="T-Pic Manager"
SERVICE="t-pic"
APP_USER="t-pic"
APP_DIR="/opt/t-pic"
DATA_DIR="/var/lib/t-pic"
CONF_DIR="/etc/t-pic"
ENV_FILE="${CONF_DIR}/t-pic.env"
UNIT_FILE="/etc/systemd/system/${SERVICE}.service"
CLI_FILE="/usr/local/bin/t-pic"
NODE_MAJOR=22
NODE_MIN="22.13.0"          # node:sqlite ใช้ได้โดยไม่ต้องใส่ flag ตั้งแต่เวอร์ชันนี้
NODE_INSTALL_ROOT="/usr/local/lib/nodejs"
DEFAULT_PORT=2681

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT_ARG=""

# ----------------------------------------------------------------- output
if [[ -t 1 ]]; then
  C_B=$'\e[1m'; C_G=$'\e[32m'; C_Y=$'\e[33m'; C_R=$'\e[31m'; C_C=$'\e[36m'; C_0=$'\e[0m'
else
  C_B=""; C_G=""; C_Y=""; C_R=""; C_C=""; C_0=""
fi
step() { echo; echo "${C_B}${C_C}==>${C_0}${C_B} $*${C_0}"; }
ok()   { echo "    ${C_G}✓${C_0} $*"; }
info() { echo "    $*"; }
warn() { echo "    ${C_Y}!${C_0} $*"; }
die()  { echo; echo "${C_R}${C_B}✗ ติดตั้งไม่สำเร็จ:${C_0} $*" >&2; exit 1; }
trap 'die "คำสั่งผิดพลาดที่บรรทัด ${LINENO}: ${BASH_COMMAND}"' ERR

usage() {
  sed -n '3,8p' "$0" | sed 's/^#  \{0,1\}//'
  exit 0
}

# ----------------------------------------------------------------- args
while [[ $# -gt 0 ]]; do
  case "$1" in
    --port) PORT_ARG="${2:-}"; shift 2 ;;
    --port=*) PORT_ARG="${1#*=}"; shift ;;
    -h|--help) usage ;;
    *) die "ไม่รู้จักตัวเลือก: $1 (ดู --help)" ;;
  esac
done
if [[ -n "$PORT_ARG" ]] && ! [[ "$PORT_ARG" =~ ^[0-9]+$ && "$PORT_ARG" -ge 1 && "$PORT_ARG" -le 65535 ]]; then
  die "พอร์ตไม่ถูกต้อง: $PORT_ARG"
fi

# ----------------------------------------------------------------- root
if [[ $EUID -ne 0 ]]; then
  if command -v sudo >/dev/null 2>&1; then
    echo "ต้องใช้สิทธิ์ root — กำลังรันใหม่ด้วย sudo..."
    exec sudo -E bash "$0" "$@"
  fi
  die "กรุณารันด้วย root: sudo ./install.sh"
fi

echo "${C_B}${APP_NAME} — ตัวติดตั้ง${C_0}"
info "ต้นฉบับ: ${SRC_DIR}"

# ----------------------------------------------------------------- checks
step "ตรวจสอบระบบ"
[[ -f "${SRC_DIR}/server.js" && -d "${SRC_DIR}/public" && -d "${SRC_DIR}/lib" ]] \
  || die "ไม่พบไฟล์โปรแกรม — ให้รัน install.sh จากในโฟลเดอร์ที่ clone มา"

if [[ -r /etc/os-release ]]; then
  # shellcheck disable=SC1091
  . /etc/os-release
  if [[ "${ID:-}" == "ubuntu" ]]; then ok "ระบบปฏิบัติการ: ${PRETTY_NAME}"
  else warn "ออกแบบมาสำหรับ Ubuntu แต่เครื่องนี้เป็น ${PRETTY_NAME:-ไม่ทราบ} — จะลองติดตั้งต่อ"; fi
fi

command -v systemctl >/dev/null 2>&1 && [[ -d /run/systemd/system ]] \
  || die "เครื่องนี้ไม่ได้ใช้ systemd (เช่น container/WSL ที่ปิด systemd) — ให้รันเองด้วย: node server.js"
ok "พบ systemd"

case "$(uname -m)" in
  x86_64|amd64) NODE_ARCH="x64" ;;
  aarch64|arm64) NODE_ARCH="arm64" ;;
  armv7l) NODE_ARCH="armv7l" ;;
  *) die "ไม่รองรับสถาปัตยกรรม $(uname -m)" ;;
esac
ok "สถาปัตยกรรม: $(uname -m)"

APT_UPDATED=0
apt_install() {
  command -v apt-get >/dev/null 2>&1 || return 1
  if [[ $APT_UPDATED -eq 0 ]]; then
    DEBIAN_FRONTEND=noninteractive apt-get update -qq >/dev/null 2>&1 || return 1
    APT_UPDATED=1
  fi
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "$@" >/dev/null 2>&1
}

# ----------------------------------------------------------------- node
version_ge() { # version_ge 22.14.0 22.13.0
  [[ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -n1)" == "$2" ]]
}

# node ที่ใช้ได้: เวอร์ชันพอ, มี node:sqlite, และ user ระบบเข้าถึงได้ (ไม่อยู่ใน /root หรือ /home)
node_usable() {
  local bin="$1" real ver
  [[ -x "$bin" ]] || return 1
  real="$(readlink -f "$bin")"
  if [[ "$real" == /root/* || "$real" == /home/* ]]; then return 1; fi
  ver="$("$bin" -v 2>/dev/null | sed 's/^v//')" || return 1
  version_ge "$ver" "$NODE_MIN" || return 1
  "$bin" --disable-warning=ExperimentalWarning -e "require('node:sqlite')" >/dev/null 2>&1 || return 1
  return 0
}

find_node() {
  local c
  for c in "$(command -v node 2>/dev/null || true)" /usr/bin/node /usr/local/bin/node; do
    if [[ -n "$c" ]] && node_usable "$c"; then readlink -f "$c"; return 0; fi
  done
  return 1
}

install_node_tarball() {
  local tarball="$1" name dest
  name="$(basename "$tarball")"; name="${name%.tar.xz}"; name="${name%.tar.gz}"
  dest="${NODE_INSTALL_ROOT}/${name}"
  info "แตกไฟล์ ${name} ไปที่ ${dest}"
  if [[ "$tarball" == *.tar.xz ]] && ! command -v xz >/dev/null 2>&1; then
    apt_install xz-utils || die "ต้องใช้ xz-utils ในการแตกไฟล์ .tar.xz — ให้ใช้ไฟล์ .tar.gz แทน หรือติดตั้ง xz-utils"
  fi
  mkdir -p "$NODE_INSTALL_ROOT"
  rm -rf "$dest"
  tar -xf "$tarball" -C "$NODE_INSTALL_ROOT"
  [[ -x "${dest}/bin/node" ]] || die "ไฟล์ Node.js ไม่ถูกต้อง: $tarball"
  chmod -R a+rX "$dest"
  ln -sfn "${dest}/bin/node" /usr/local/bin/node
  ln -sfn "${dest}/bin/npm" /usr/local/bin/npm
  ln -sfn "${dest}/bin/npx" /usr/local/bin/npx
  hash -r
}

download_node() {
  command -v curl >/dev/null 2>&1 || apt_install curl ca-certificates || return 1
  local base="https://nodejs.org/dist/latest-v${NODE_MAJOR}.x" tmp file sum
  tmp="$(mktemp -d)"
  info "ดาวน์โหลดรายการไฟล์จาก ${base}"
  curl -fsSL --max-time 30 "${base}/SHASUMS256.txt" -o "${tmp}/SHASUMS256.txt" || { rm -rf "$tmp"; return 1; }
  file="$(awk -v a="linux-${NODE_ARCH}.tar.gz" '$2 ~ a"$" {print $2; exit}' "${tmp}/SHASUMS256.txt")"
  [[ -n "$file" ]] || { rm -rf "$tmp"; return 1; }
  sum="$(awk -v f="$file" '$2 == f {print $1}' "${tmp}/SHASUMS256.txt")"
  info "ดาวน์โหลด ${file}"
  curl -fSL --progress-bar --max-time 600 "${base}/${file}" -o "${tmp}/${file}" || { rm -rf "$tmp"; return 1; }
  echo "${sum}  ${tmp}/${file}" | sha256sum -c --quiet - || { rm -rf "$tmp"; die "checksum ของไฟล์ Node.js ไม่ตรง"; }
  ok "ตรวจ checksum ผ่าน"
  install_node_tarball "${tmp}/${file}"
  rm -rf "$tmp"
}

step "ตรวจ Node.js (ต้องการ >= ${NODE_MIN})"
NODE_BIN="$(find_node || true)"
if [[ -n "$NODE_BIN" ]]; then
  ok "ใช้ Node.js $("$NODE_BIN" -v) ที่ ${NODE_BIN}"
else
  existing="$(command -v node 2>/dev/null || true)"
  if [[ -n "$existing" ]]; then
    warn "พบ node $("$existing" -v 2>/dev/null || echo '?') ที่ ${existing} แต่ใช้ไม่ได้ (เวอร์ชันต่ำกว่า ${NODE_MIN} หรืออยู่ใน /root, /home เช่นติดตั้งด้วย nvm)"
  else
    warn "ไม่พบ Node.js"
  fi
  # 1) ไฟล์ offline ที่เตรียมไว้
  offline_file="$(ls -1 "${SRC_DIR}"/offline/node-v*-linux-"${NODE_ARCH}".tar.{xz,gz} 2>/dev/null | sort -V | tail -n1 || true)"
  if [[ -n "$offline_file" ]]; then
    info "ติดตั้งจากไฟล์ offline: $(basename "$offline_file")"
    install_node_tarball "$offline_file"
  else
    info "ไม่มีไฟล์ใน ./offline/ — ลองดาวน์โหลดจากอินเทอร์เน็ต"
    download_node || die "ติดตั้ง Node.js ไม่ได้ (เครื่องไม่ได้ต่ออินเทอร์เน็ต?)
    วิธีแก้: ดาวน์โหลด node-v${NODE_MAJOR}.x-linux-${NODE_ARCH}.tar.xz จาก https://nodejs.org/dist/latest-v${NODE_MAJOR}.x/
    จากเครื่องที่มีเน็ต แล้ววางไว้ในโฟลเดอร์ ${SRC_DIR}/offline/ จากนั้นรัน install.sh อีกครั้ง"
  fi
  NODE_BIN="$(find_node || true)"
  [[ -n "$NODE_BIN" ]] || die "ติดตั้ง Node.js แล้วแต่ยังใช้งานไม่ได้"
  ok "ติดตั้ง Node.js $("$NODE_BIN" -v) แล้ว"
fi

# ----------------------------------------------------------------- port
step "ตั้งค่าพอร์ต"
CURRENT_PORT=""
if [[ -f "$ENV_FILE" ]]; then
  CURRENT_PORT="$(sed -n 's/^PORT=\([0-9]\+\).*/\1/p' "$ENV_FILE" | tail -n1)"
fi
PORT="${PORT_ARG:-${CURRENT_PORT:-$DEFAULT_PORT}}"

port_in_use_by_other() {
  local p="$1"
  command -v ss >/dev/null 2>&1 || return 1
  if ss -ltnH "( sport = :${p} )" 2>/dev/null | grep -q .; then
    # ถ้าเป็น service ของเราเองอยู่แล้ว ถือว่าไม่ชน
    if systemctl is-active --quiet "$SERVICE" && [[ "$p" == "$CURRENT_PORT" ]]; then return 1; fi
    return 0
  fi
  return 1
}
if port_in_use_by_other "$PORT"; then
  die "พอร์ต ${PORT} ถูกโปรแกรมอื่นใช้อยู่:
$(ss -ltnpH "( sport = :${PORT} )" 2>/dev/null || true)
    เลือกพอร์ตอื่นด้วย: sudo ./install.sh --port <พอร์ต>"
fi
ok "ใช้พอร์ต ${PORT}"

# ----------------------------------------------------------------- user & files
step "ติดตั้งไฟล์โปรแกรม"
if ! id -u "$APP_USER" >/dev/null 2>&1; then
  useradd --system --home-dir "$DATA_DIR" --no-create-home --shell /usr/sbin/nologin "$APP_USER"
  ok "สร้างผู้ใช้ระบบ ${APP_USER}"
else
  ok "มีผู้ใช้ระบบ ${APP_USER} อยู่แล้ว"
fi

WAS_RUNNING=0
if systemctl is-active --quiet "$SERVICE"; then
  WAS_RUNNING=1
  systemctl stop "$SERVICE"
  info "หยุด service เดิมชั่วคราวเพื่ออัปเกรด"
fi

if [[ "$(readlink -f "$SRC_DIR")" != "$(readlink -f "$APP_DIR")" ]]; then
  mkdir -p "$APP_DIR"
  rm -rf "${APP_DIR:?}/lib" "${APP_DIR:?}/public"
  cp -r "${SRC_DIR}/lib" "${SRC_DIR}/public" "$APP_DIR/"
  cp "${SRC_DIR}/server.js" "${SRC_DIR}/package.json" "$APP_DIR/"
  for f in uninstall.sh README.md INSTALL.md; do
    if [[ -f "${SRC_DIR}/${f}" ]]; then cp "${SRC_DIR}/${f}" "$APP_DIR/"; fi
  done
fi
chown -R root:root "$APP_DIR"
chmod -R u=rwX,go=rX "$APP_DIR"
if [[ -f "${APP_DIR}/uninstall.sh" ]]; then chmod 755 "${APP_DIR}/uninstall.sh"; fi
ok "โปรแกรม: ${APP_DIR} (เวอร์ชัน $(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "${APP_DIR}/package.json"))"

install -d -o "$APP_USER" -g "$APP_USER" -m 750 "$DATA_DIR"
chown -R "$APP_USER:$APP_USER" "$DATA_DIR"
ok "ข้อมูลและรูปภาพ: ${DATA_DIR}"

install -d -m 755 "$CONF_DIR"
if [[ ! -f "$ENV_FILE" ]]; then
  cat > "$ENV_FILE" <<EOF
# T-Pic Manager — ค่าตั้งของ service (แก้แล้วสั่ง: sudo t-pic restart)
PORT=${PORT}
# 0.0.0.0 = รับจากทุกเครื่องในวง LAN, 127.0.0.1 = เฉพาะเครื่องนี้ (เช่นเมื่อมี Nginx อยู่ด้านหน้า)
HOST=0.0.0.0
DATA_DIR=${DATA_DIR}
# ตั้งเป็น 1 เมื่อวางหลัง reverse proxy (Nginx) ที่ส่ง X-Forwarded-* มา
TRUST_PROXY=0
# จำนวนวันที่ล็อกอินค้างไว้ได้
SESSION_DAYS=7
EOF
  ok "สร้างไฟล์ตั้งค่า ${ENV_FILE}"
else
  if grep -q '^PORT=' "$ENV_FILE"; then sed -i "s/^PORT=.*/PORT=${PORT}/" "$ENV_FILE"
  else echo "PORT=${PORT}" >> "$ENV_FILE"; fi
  ok "ใช้ไฟล์ตั้งค่าเดิม ${ENV_FILE}"
fi
chmod 644 "$ENV_FILE"

# ----------------------------------------------------------------- systemd
step "ตั้งค่า systemd service"
CAPS=""
if [[ "$PORT" -lt 1024 ]]; then
  CAPS=$'AmbientCapabilities=CAP_NET_BIND_SERVICE\nCapabilityBoundingSet=CAP_NET_BIND_SERVICE'
fi
cat > "$UNIT_FILE" <<EOF
[Unit]
Description=${APP_NAME} (image storage)
Documentation=file://${APP_DIR}/INSTALL.md
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${APP_USER}
Group=${APP_USER}
EnvironmentFile=${ENV_FILE}
WorkingDirectory=${APP_DIR}
ExecStart=${NODE_BIN} --disable-warning=ExperimentalWarning ${APP_DIR}/server.js
Restart=on-failure
RestartSec=3
${CAPS}
# ความปลอดภัย: เขียนได้เฉพาะโฟลเดอร์ข้อมูล
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
PrivateDevices=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
ReadWritePaths=${DATA_DIR}
UMask=0027
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
EOF
ok "สร้าง ${UNIT_FILE}"

# คำสั่งช่วยจัดการ: t-pic status / logs / restart / backup / reset-password ...
if [[ -f "${SRC_DIR}/scripts/t-pic" ]]; then
  sed -e "s#@NODE_BIN@#${NODE_BIN}#g" "${SRC_DIR}/scripts/t-pic" > "$CLI_FILE"
  chmod 755 "$CLI_FILE"
  ok "ติดตั้งคำสั่ง t-pic ที่ ${CLI_FILE}"
fi

systemctl daemon-reload
systemctl enable "$SERVICE" >/dev/null 2>&1
systemctl restart "$SERVICE"
ok "เปิด service ${SERVICE} และตั้งให้เริ่มเองตอนบูต"

# ----------------------------------------------------------------- firewall
step "ไฟร์วอลล์"
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
  if [[ -n "$CURRENT_PORT" && "$CURRENT_PORT" != "$PORT" ]]; then
    ufw delete allow "${CURRENT_PORT}/tcp" >/dev/null 2>&1 || true
  fi
  ufw allow "${PORT}/tcp" comment "${APP_NAME}" >/dev/null
  ok "เปิดพอร์ต ${PORT}/tcp ใน ufw แล้ว"
else
  info "ไม่ได้เปิดใช้ ufw — ข้ามขั้นตอนนี้"
fi

# ----------------------------------------------------------------- health check
step "ตรวจว่าระบบทำงาน"
healthy=0
for _ in $(seq 1 30); do
  if "$NODE_BIN" -e "fetch('http://127.0.0.1:${PORT}/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" 2>/dev/null; then
    healthy=1; break
  fi
  sleep 0.5
done
if [[ $healthy -ne 1 ]]; then
  echo
  journalctl -u "$SERVICE" -n 30 --no-pager || true
  die "service เริ่มทำงานไม่สำเร็จ — ดู log ด้านบน หรือสั่ง: journalctl -u ${SERVICE} -e"
fi
ok "service ทำงานปกติ"

SETUP_PENDING="$("$NODE_BIN" -e "fetch('http://127.0.0.1:${PORT}/api/info').then(r=>r.json()).then(j=>console.log(j.setup_pending?1:0)).catch(()=>console.log(0))" 2>/dev/null || echo 0)"

# ----------------------------------------------------------------- done
trap - ERR
echo
echo "${C_G}${C_B}✓ ติดตั้ง ${APP_NAME} เรียบร้อย${C_0}"
echo
echo "  เปิดใช้งานจากเครื่องในวง LAN:"
IPS="$(hostname -I 2>/dev/null || true)"
shown=0
for ip in $IPS; do
  if [[ "$ip" == *:* ]]; then continue; fi   # ข้าม IPv6
  echo "    ${C_B}http://${ip}:${PORT}${C_0}"
  shown=1
done
[[ $shown -eq 1 ]] || echo "    ${C_B}http://<IP-ของเครื่องนี้>:${PORT}${C_0}"
echo "    (บนเครื่องนี้: http://localhost:${PORT})"
echo
if [[ "$SETUP_PENDING" == "1" ]]; then
  echo "  ผู้ใช้เริ่มต้น:  ${C_B}admin${C_0}  รหัสผ่าน: ${C_B}admin${C_0}  (ระบบจะให้เปลี่ยนรหัสตอนล็อกอินครั้งแรก)"
  echo
fi
echo "  คำสั่งที่ใช้บ่อย:"
echo "    t-pic status            ดูสถานะ"
echo "    t-pic logs              ดู log แบบสด"
echo "    sudo t-pic restart      รีสตาร์ต"
echo "    sudo t-pic backup       สำรองข้อมูล"
echo "    sudo t-pic reset-password admin   รีเซ็ตรหัสผ่าน"
if [[ $WAS_RUNNING -eq 1 ]]; then echo; echo "  (อัปเกรดจากเวอร์ชันเดิม — ข้อมูลเดิมยังอยู่ครบ)"; fi
echo
