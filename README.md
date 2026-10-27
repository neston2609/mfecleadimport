# MFEC Lead Import/Export

แอปนี้ติดตั้ง build และรันได้ด้วยตัวเอง ไม่ใช้ package, server, session หรือฐานข้อมูลจากแอปอื่น

## เริ่มใช้งาน

ต้องใช้ Node.js 20.19+ หรือ 22.12+ และ npm

```sh
npm ci
# คัดลอก .env.example เป็น .env และกำหนดค่าตามเครื่อง
npm test
npm run build
npm start
```

เปิด http://localhost:3002/genesys

สำหรับพัฒนา เปิดสอง terminal: `npm run dev:server` และ `npm run dev:client` แล้วเข้า http://localhost:5175/genesys ถ้าเปลี่ยน PORT ให้เปลี่ยน API_PROXY_TARGET ใน .env ตามด้วย

## ล็อกอินและข้อมูล

ในการพัฒนาค่าเริ่มต้นคือ admin / ChangeMe123! สำหรับ production ต้องตั้ง APP_SECRET, SESSION_SECRET และ ADMIN_PASSWORD ที่รัดกุมและแยกจากระบบอื่น Bootstrap password ถูกบันทึกเป็น hash ใน data/.auth/admin.json หลังเริ่มใช้งานครั้งแรก จากนั้นลบ ADMIN_PASSWORD ออกจาก .env และเปลี่ยนรหัสผ่านผ่านหน้า Settings ได้ Session cookie ใช้ชื่อ genesys.sid และข้อมูล session อยู่ใน data/.sessions/ เฉพาะแอปนี้

Routes: /genesys, /genesys/import-leads, /genesys/regions, /genesys/scheduler, /genesys/campaigns, /genesys/customers, /genesys/products, /genesys/policies, /genesys/settings

ตั้งค่า OAuth และ Contact List ใน Integration, ทดสอบการเชื่อมต่อและ Validate Schema แล้วเลือก Source campaigns ใน Import Lead Contact เพื่อ preview และส่ง lead ไป Genesys เลือก Source campaigns / Export เพื่อสร้างแคมเปญและดาวน์โหลด CSV สามารถจัดการข้อมูลต้นทางลูกค้า สินค้า และกรมธรรม์ได้ในแอปนี้เอง Scheduler ทำงานกับแคมเปญและข้อมูลภายในแอปนี้

APP_SECRET ใช้เข้ารหัส Client Secret ต้องเก็บค่าถาวร หากย้าย config จากระบบเดิมต้องใช้ APP_SECRET เดิมหรือกรอก Client Secret ใหม่ ห้ามเปิดให้ scheduler หลาย instance ใช้ DATA_DIR เดียวกัน

## แยกข้อมูลและการย้ายระบบ

ข้อมูลใน data/, backups/, exports/ และ .env ไม่ถูก commit เมื่อ clone repo ใหม่จะสร้างข้อมูลตัวอย่างโดยอัตโนมัติ Local checkout ที่แยกจากระบบเดิมมีสำเนาข้อมูล JSON เดิมเฉพาะส่วนที่ใช้ โดยไม่คัดลอก credentials หรือ sessions

การแก้ข้อมูลในระบบหนึ่งไม่เปลี่ยนข้อมูลอีกระบบหนึ่ง ไม่มีการ sync อัตโนมัติ หากย้ายข้อมูลให้หยุดแอปปลายทาง สำรองข้อมูล แล้วคัดลอก JSON ที่ต้องการเข้า data/ ของปลายทาง ระบบ MFEC ใช้ customers.json, products.json, policies.json และ campaign-lists.json ของตัวเอง; ถ้าคัดลอกกรมธรรม์จากระบบเดิมให้ล้างสถานะ genesys ก่อนเริ่มส่งไป Contact List ใหม่ และตรวจสอบ preview

DATA_DIR และ BACKUPS_DIR, EXPORTS_DIR กำหนดเป็น absolute path เพื่อย้ายข้อมูลได้ แต่ต้องใช้คนละ directory กับแอปอื่น

## Deploy

ตัวอย่าง systemd และ Nginx อยู่ใน deploy/ ใช้ hostname ของแต่ละระบบและเพิ่ม TLS ก่อนใช้งาน production เพราะ admin cookie บังคับ HTTPS ให้สิทธิ์เขียน data/, backups/, exports/ กับ service user และแก้ WorkingDirectory ให้ตรงกับเครื่องจริง

GET /api/health ใช้ตรวจสอบสถานะ ตัวอย่างทั้งหมดใช้ข้อมูลประกันสมมติและไม่ออกกรมธรรม์หรือรับชำระเงินจริง
