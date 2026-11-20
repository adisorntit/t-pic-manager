#!/usr/bin/env bash
# =============================================================================
#  T-Pic Manager — ถอนการติดตั้ง
#
#  sudo ./uninstall.sh            ลบโปรแกรมและ service แต่ "เก็บรูปและฐานข้อมูลไว้"
#  sudo ./uninstall.sh --purge    ลบทุกอย่าง รวมถึงรูปทั้งหมด ฐานข้อมูล และไฟล์ตั้งค่า
# =============================================================================
set -Eeuo pipefail

SERVICE="t-pic"
APP_USER="t-pic"
APP_DIR="/opt/t-pic"
DATA_DIR="/var/lib/t-pic"
CONF_DIR="/etc/t-pic"
UNIT_FILE="/etc/systemd/system/${SERVICE}.service"
CLI_FILE="/usr/local/bin/t-pic"

PURGE=0
YES=0
for a in "$@"; do
  case "$a" in
    --purge) PURGE=1 ;;
    -y|--yes) YES=1 ;;
    -h|--help) sed -n '3,6p' "$0" | sed 's/^#  \{0,1\}//'; exit 0 ;;
    *) echo "ไม่รู้จักตัวเลือก: $a"; exit 2 ;;
  esac
done

if [[ $EUID -ne 0 ]]; then exec sudo bash "$0" "$@"; fi

if [[ $PURGE -eq 1 && $YES -eq 0 ]]; then
  echo "คำเตือน: --purge จะลบรูปทั้งหมดใน ${DATA_DIR} และฐานข้อมูลผู้ใช้อย่างถาวร"
  read -r -p "พิมพ์ DELETE เพื่อยืนยัน: " ans
  [[ "$ans" == "DELETE" ]] || { echo "ยกเลิก"; exit 0; }
fi

PORT="$(sed -n 's/^PORT=\([0-9]\+\).*/\1/p' "${CONF_DIR}/t-pic.env" 2>/dev/null | tail -n1 || true)"

systemctl disable --now "$SERVICE" >/dev/null 2>&1 || true
rm -f "$UNIT_FILE"
systemctl daemon-reload || true
echo "✓ ลบ service ${SERVICE}"

rm -rf "$APP_DIR"
rm -f "$CLI_FILE"
echo "✓ ลบโปรแกรม ${APP_DIR} และคำสั่ง t-pic"

if [[ -n "$PORT" ]] && command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
  ufw delete allow "${PORT}/tcp" >/dev/null 2>&1 || true
  echo "✓ ปิดพอร์ต ${PORT}/tcp ใน ufw"
fi

if [[ $PURGE -eq 1 ]]; then
  rm -rf "$DATA_DIR" "$CONF_DIR"
  userdel "$APP_USER" >/dev/null 2>&1 || true
  echo "✓ ลบข้อมูล ${DATA_DIR}, ไฟล์ตั้งค่า ${CONF_DIR} และผู้ใช้ระบบ ${APP_USER}"
else
  echo
  echo "เก็บข้อมูลไว้ที่ ${DATA_DIR} และไฟล์ตั้งค่าที่ ${CONF_DIR}"
  echo "ถ้าติดตั้งใหม่ด้วย install.sh ระบบจะใช้ข้อมูลเดิมต่อได้ทันที"
fi
echo
echo "หมายเหตุ: Node.js ที่ติดตั้งไว้ไม่ได้ถูกลบ เพราะโปรแกรมอื่นอาจใช้อยู่"
