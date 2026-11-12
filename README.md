# ShinPo Chat

Aplikasi chat real-time dengan login Google atau kode OTP email, dan notifikasi pesan baru.

## Menjalankan

1. Pasang Node.js 18 atau lebih baru, lalu jalankan `npm install`.
2. Salin `.env.example` menjadi `.env` dan isi nilainya (langkah di bawah).
3. Jalankan `npm start`, lalu buka http://localhost:3000.

## Mengisi .env

**JWT_SECRET**
Jalankan: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` dan tempel hasilnya.

**GMAIL_APP_PASSWORD** (OTP dikirim dari nafasramadhan46@gmail.com)
1. Aktifkan verifikasi 2 langkah di akun Google.
2. Buka https://myaccount.google.com/apppasswords dan buat App Password.
3. Tempel 16 karakter yang muncul.

**GOOGLE_CLIENT_ID**
1. Buka Google Cloud Console, menu APIs and Services, Credentials.
2. Create Credentials, OAuth client ID, tipe Web application.
3. Pada Authorized JavaScript origins, tambahkan `http://localhost:3000` dan alamat domain hosting Anda (contoh `https://chat-anda.onrender.com`).
4. Salin Client ID ke `.env`.

**VAPID_PUBLIC_KEY dan VAPID_PRIVATE_KEY**
Jalankan `npm run keys` dan salin kedua kunci. Kunci ini membuat notifikasi tetap masuk walau tab atau aplikasi ditutup.

## Firebase (Realtime Database)

Semua pengguna, pesan, riwayat panggilan, dan langganan notifikasi disimpan di Realtime Database, jadi data tidak hilang saat server restart.

1. Buka https://console.firebase.google.com dan buat proyek.
2. Menu Build, Realtime Database, Create Database. Pilih lokasi (Singapore) dan mode terkunci (locked mode). Salin alamat databasenya ke `FIREBASE_DATABASE_URL`.
3. Project settings, tab Service accounts, Generate new private key. File JSON akan terunduh.
4. Ubah ke base64: `base64 -w0 serviceAccountKey.json` (macOS: `base64 -i serviceAccountKey.json`), lalu tempel hasilnya ke `FIREBASE_SERVICE_ACCOUNT`.
5. Pasang rules dari `database.rules.json`. Pilih salah satu:
   - Console: Realtime Database, tab Rules, tempel isi file, lalu Publish.
   - CLI: `npm i -g firebase-tools`, `firebase login`, `firebase use --add`, lalu `firebase deploy --only database`.

### Konfigurasi web Firebase

Proyek `shinpo-chat` sudah dipasang di sisi klien lewat `public/firebase-config.js`, dan SDK-nya dimuat di `public/index.html`. Konfigurasi web ini bersifat publik dan aman ada di kode klien. Untuk server tetap wajib mengisi `FIREBASE_SERVICE_ACCOUNT` (dari proyek `shinpo-chat`) dan `FIREBASE_DATABASE_URL`.

Jangan pernah mengunggah file service account ke GitHub. Rules mengunci akses langsung dari klien karena seluruh akses lewat server. Bagian `.indexOn` pada rules dipakai server untuk mengambil pesan terbaru.

Server memuat 20.000 pesan terbaru ke memori saat start. Untuk pengguna dalam jumlah sangat besar, riwayat perlu dipindah ke query per percakapan.

## Owner panel

Panel khusus pemilik untuk melihat statistik, memblokir, dan menghapus pengguna. Tidak ada tombol, tautan, atau teks apa pun tentangnya di halaman publik. Pemilik masuk lewat form login biasa dengan kredensial owner, lalu otomatis diarahkan ke panel. Bagi orang lain, alamat panel dan semua API-nya tampil sebagai halaman tidak ditemukan (404).

Kredensial disimpan di `.env.admin` (sudah masuk `.gitignore`), dengan kata sandi berupa hash. Di hosting, isi `ADMIN_USERNAME`, `ADMIN_EMAIL`, dan `ADMIN_PASSWORD_HASH` sebagai Environment Variables. Untuk mengganti kata sandi: `npm run admin-hash -- "kata-sandi-baru"` lalu tempel hasilnya ke `ADMIN_PASSWORD_HASH`.

Panel tidak menampilkan isi pesan pengguna, hanya jumlahnya.

## Deploy

Gunakan hosting yang menjalankan Node.js terus-menerus (Railway, Render, atau VPS). Isi semua variabel di `.env` sebagai Environment Variables di hosting.

- Alamat harus HTTPS agar notifikasi dan login Google berfungsi.
- Dengan Firebase aktif, tidak perlu disk permanen. Tanpa Firebase, data disimpan di file `DATA_FILE` dan harus diarahkan ke disk permanen.

## Panggilan suara dan video

Memakai WebRTC antar dua pengguna. Wajib HTTPS (kecuali localhost) dan izin mikrofon atau kamera. Agar panggilan tersambung di semua jaringan seluler dan Wi-Fi, isi TURN_URL, TURN_USER, TURN_PASS dengan server TURN (misalnya dari Metered, Twilio, atau coturn di VPS). Tanpa TURN, sebagian panggilan bisa gagal tersambung.

## Notifikasi

Saat pertama masuk, tekan tombol Aktifkan di bagian atas daftar chat dan izinkan notifikasi pada browser. Di iPhone, situs harus ditambahkan ke Layar Utama (Add to Home Screen) lebih dulu.

## Catatan

- Pengguna hanya bisa dicari setelah pernah masuk ke aplikasi ini.
- OTP via WhatsApp (085729910636) belum disertakan karena memerlukan WhatsApp Business Cloud API dari Meta.
