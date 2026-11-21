# T-Pic Manager

ระบบเก็บรูปภาพสำหรับวง LAN อัปโหลด ลบ และแทนที่รูปได้ แล้วคัดลอกลิงก์ไปฝังในเว็บแอปอื่นได้ทันที
เขียนด้วย Node.js ล้วน ไม่ต้อง `npm install` ติดตั้งบน Ubuntu ได้ด้วยคำสั่งเดียว

## ความสามารถ

- อัปโหลดหลายไฟล์พร้อมกัน ทั้งลากวาง เลือกไฟล์ และวางจากคลิปบอร์ด (Ctrl+V)
- รองรับ JPG, PNG, GIF, WebP โดยตรวจชนิดจากเนื้อไฟล์จริง
- คัดลอกลิงก์ได้ 3 แบบ: URL, `<img>` และ Markdown
- **แก้ไขชื่อรูปได้** เพื่อให้ค้นหาง่ายขึ้น โดยลิงก์ไม่เปลี่ยน
- **แทนที่รูปได้โดยลิงก์เดิมไม่เปลี่ยน** หน้าที่ฝังรูปไว้จะเห็นรูปใหม่ทันที
- ค้นหาจากชื่อ เรียงลำดับ และกรองตามผู้อัปโหลด
- ผู้ใช้หลายคน 2 ระดับสิทธิ์ (admin / user) บังคับเปลี่ยนรหัสผ่านเมื่อล็อกอินครั้งแรก
- ลิงก์รูปเปิดได้โดยไม่ต้องล็อกอิน และเปิด CORS ให้ฝังข้ามระบบได้
- สำรองและกู้คืนข้อมูลด้วยคำสั่งเดียว (`t-pic backup` / `t-pic restore`)
- ใช้งานแบบ offline ได้ 100% (ไม่โหลดฟอนต์หรือไฟล์จากภายนอก)

## ติดตั้งเร็ว

```bash
git clone https://github.com/adisorntit/t-pic-manager.git
cd t-pic-manager
sudo ./install.sh
```

จากนั้นเปิด `http://<IP-เครื่อง>:2681` แล้วล็อกอินด้วย `admin` / `admin`

รายละเอียดทั้งหมด (ติดตั้งแบบ offline, อัปเกรด, backup, Nginx/HTTPS, แก้ปัญหา) อยู่ใน **[INSTALL.md](INSTALL.md)**

## โครงสร้างโปรเจกต์

```
t-pic-manager/
├── server.js          # เซิร์ฟเวอร์ HTTP + API + CLI (reset-password, backup-db)
├── lib/
│   ├── db.js          # SQLite schema (node:sqlite)
│   ├── auth.js        # hash รหัสผ่าน (scrypt), session, จำกัดการล็อกอินผิด
│   ├── http.js        # helper: JSON, อ่าน body, cookie, ไฟล์ static
│   └── imageinfo.js   # ตรวจชนิดและขนาดรูปจาก magic bytes
├── public/            # หน้าเว็บ (HTML/CSS/JS ล้วน ไม่มี build step)
├── scripts/t-pic      # คำสั่งจัดการระบบ (ติดตั้งไปที่ /usr/local/bin/t-pic)
├── offline/           # วางไฟล์ Node.js สำหรับติดตั้งแบบไม่มีเน็ต
├── install.sh         # ตัวติดตั้งอัตโนมัติ
├── uninstall.sh       # ถอนการติดตั้ง
└── INSTALL.md         # คู่มือติดตั้ง
```

## พัฒนาบนเครื่องตัวเอง

ต้องการ Node.js 22.13 ขึ้นไป

```bash
npm run dev     # หรือ: node server.js  → http://localhost:2681 (ข้อมูลอยู่ใน ./data)
```

ตัวแปรสภาพแวดล้อม: `PORT` (2681), `HOST` (0.0.0.0), `DATA_DIR` (./data), `TRUST_PROXY` (0), `SESSION_DAYS` (7)

## ความปลอดภัย

- รหัสผ่านเก็บแบบ scrypt + salt
- session cookie เป็นแบบ HttpOnly และ SameSite=Lax (และ Secure เมื่อใช้ HTTPS)
- ทุกคำขอที่แก้ไขข้อมูลต้องมี header `X-Requested-With` เพื่อกัน CSRF
- จำกัดการล็อกอินผิดไว้ที่ 10 ครั้งต่อ 15 นาทีต่อ IP
- หน้าเว็บตั้ง Content-Security-Policy แบบเข้มงวด
- ไม่รับ SVG และตรวจชนิดไฟล์จากเนื้อไฟล์จริง
- service รันด้วยผู้ใช้ระบบ `t-pic` (ไม่ใช่ root) ภายใต้ systemd sandbox ที่เขียนได้เฉพาะ `/var/lib/t-pic`
