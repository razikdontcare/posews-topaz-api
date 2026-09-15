Implementasikan sistem backend API untuk otomasi video upscaling menggunakan custom FFmpeg/FFprobe milik Topaz Video AI pada Windows.

Tujuan utama sistem:

1. User meng-upload video melalui HTTP API.
2. Upload harus dilakukan secara streaming dan memory-efficient.
3. Video disimpan ke temporary directory di PC server.
4. API membuat render job.
5. Job masuk ke persistent queue.
6. Hanya SATU video boleh dirender pada satu waktu karena proses menggunakan GPU Topaz Video AI.
7. Worker menjalankan custom FFmpeg Topaz Video AI secara asynchronous.
8. Worker membaca progress FFmpeg secara real-time.
9. Frontend dapat melakukan polling endpoint progress kapan saja.
10. Browser/frontend tidak boleh menjadi dependency dari proses render.
11. Hasil render disimpan ke folder final:
    `D:\Hasil Render\`
12. Gunakan PM2 ecosystem untuk menjalankan API secara persistent di Windows.
13. Sistem harus mampu melakukan recovery state setelah Node.js/PM2 restart.
14. Gunakan custom FFmpeg dan FFprobe Topaz Video AI:
    `C:\Program Files\Topaz Labs LLC\Topaz Video AI\ffmpeg.exe`

PENTING:
Jangan menggunakan FFmpeg sistem/global jika executable Topaz tersedia di path tersebut. Semua operasi FFmpeg dan FFprobe harus secara eksplisit menggunakan executable Topaz tersebut.

==================================================

1. STACK
   ==================================================

Gunakan stack berikut:

* Node.js
* Express 5
* Busboy untuk streaming multipart upload
* SQLite sebagai persistent job store
* native `child_process.spawn()`
* native `fs/promises` dan streams jika memungkinkan
* PM2
* dotenv
* uuid atau crypto.randomUUID() untuk job ID
* Zod atau library validation yang sudah tersedia di project jika memang sudah digunakan project

Jangan menambahkan dependency besar jika tidak diperlukan.

Jangan menggunakan:

* multer memoryStorage
* menyimpan seluruh upload sebagai Buffer
* `exec()` untuk menjalankan FFmpeg
* command shell string yang berasal dari input user
* Bull/BullMQ/Redis untuk versi ini kecuali project memang sudah menggunakannya

Queue cukup dibuat menggunakan application-level queue + SQLite persistent state karena hanya ada satu renderer/GPU.

==================================================
2. WINDOWS ENVIRONMENT
======================

Target environment adalah Windows.

Default executable:

FFMPEG:
`C:\Program Files\Topaz Labs LLC\Topaz Video AI\ffmpeg.exe`

FFPROBE:
`C:\Program Files\Topaz Labs LLC\Topaz Video AI\ffprobe.exe`

Jangan mengasumsikan `ffmpeg` atau `ffprobe` ada di PATH.

Gunakan environment variables:

```env
PORT=3000

TEMP_DIR=D:\VideoTemp
OUTPUT_DIR=D:\Hasil Render

FFMPEG_PATH=C:\Program Files\Topaz Labs LLC\Topaz Video AI\ffmpeg.exe
FFPROBE_PATH=C:\Program Files\Topaz Labs LLC\Topaz Video AI\ffprobe.exe

MAX_UPLOAD_SIZE_BYTES=53687091200

QUEUE_CONCURRENCY=1

JOB_RETENTION_HOURS=72
FAILED_JOB_RETENTION_HOURS=24
```

Jika environment variable `FFMPEG_PATH` / `FFPROBE_PATH` tidak diberikan, gunakan default Topaz path di atas.

Normalize Windows paths dengan benar.

Jangan hardcode path di business logic.

==================================================
3. PROJECT STRUCTURE
====================

Gunakan struktur modular seperti:

```text
src/
├── app.js
├── server.js
│
├── config/
│   ├── env.js
│   └── paths.js
│
├── routes/
│   └── job.routes.js
│
├── controllers/
│   └── job.controller.js
│
├── services/
│   ├── job.service.js
│   ├── upload.service.js
│   ├── render.service.js
│   ├── probe.service.js
│   └── cleanup.service.js
│
├── queue/
│   └── render.queue.js
│
├── workers/
│   └── render.worker.js
│
├── database/
│   ├── database.js
│   ├── migrations.js
│   └── repositories/
│       └── job.repository.js
│
├── utils/
│   ├── ffmpeg.js
│   ├── process.js
│   ├── filename.js
│   └── errors.js
│
└── middleware/
    ├── error-handler.js
    └── request-id.js

data/
└── jobs.sqlite

logs/

temp/
```

Jika project sudah memiliki struktur tertentu, pertahankan convention existing project dan integrasikan secara clean. Jangan merombak bagian unrelated.

==================================================
4. JOB MODEL
============

Buat persistent job model.

Setiap job minimal memiliki:

```text
id
status
original_filename
input_path
output_path
temp_output_path
width
height
duration_seconds
progress_percent
frame
fps
speed
elapsed_seconds
total_size
pid
error_code
error_message
created_at
started_at
completed_at
updated_at
```

Status yang diperbolehkan:

```text
queued
probing
processing
completed
failed
cancel_requested
cancelled
```

Gunakan status transition yang valid.

Contoh:

```text
uploaded
   ↓
probing
   ↓
queued
   ↓
processing
   ↓
completed

processing
   ↓
failed

queued
   ↓
cancelled

processing
   ↓
cancel_requested
   ↓
cancelled
```

Jangan menggunakan arbitrary status string tanpa validasi.

==================================================
5. SQLITE
=========

Gunakan SQLite sebagai persistent source of truth.

Buat migration otomatis ketika server pertama kali dijalankan.

Minimal table:

```sql
CREATE TABLE jobs (
    id TEXT PRIMARY KEY,

    status TEXT NOT NULL,

    original_filename TEXT NOT NULL,

    input_path TEXT NOT NULL,
    output_path TEXT,
    temp_output_path TEXT,

    width INTEGER NOT NULL,
    height INTEGER NOT NULL,

    duration_seconds REAL,

    progress_percent REAL NOT NULL DEFAULT 0,

    frame INTEGER,
    fps REAL,
    speed TEXT,
    elapsed_seconds REAL,
    total_size INTEGER,

    pid INTEGER,

    error_code TEXT,
    error_message TEXT,

    created_at TEXT NOT NULL,
    started_at TEXT,
    completed_at TEXT,
    updated_at TEXT NOT NULL
);
```

Tambahkan index yang relevan, misalnya:

```sql
CREATE INDEX idx_jobs_status ON jobs(status);
CREATE INDEX idx_jobs_created_at ON jobs(created_at);
```

Repository harus menyediakan operasi seperti:

```text
create()
findById()
findAll()
findQueued()
findActive()
update()
delete()
```

Gunakan parameterized SQL.

==================================================
6. UPLOAD ENDPOINT
==================

Implementasikan:

```http
POST /api/v1/jobs
Content-Type: multipart/form-data
```

Multipart fields:

```text
video   binary file
width   integer
height  integer
```

Contoh:

```text
video = input.mp4
width = 3840
height = 1620
```

Response harus dikembalikan segera setelah upload berhasil dan job berhasil dibuat.

Jangan menunggu FFmpeg.

Response:

```json
{
  "id": "job-id",
  "status": "queued",
  "position": 2,
  "width": 3840,
  "height": 1620
}
```

HTTP status:

```text
202 Accepted
```

==================================================
7. STREAMING UPLOAD
===================

Ini sangat penting.

Video dapat berukuran beberapa GB.

Jangan pernah membaca seluruh request body ke memory.

Gunakan Busboy streaming.

Flow:

```text
HTTP request
    ↓
Busboy
    ↓
file stream
    ↓
fs.createWriteStream()
    ↓
D:\VideoTemp\<jobId>\input.<ext>
```

Saat multipart parser menerima file:

1. Generate job ID terlebih dahulu.
2. Buat temporary job directory:
   `D:\VideoTemp\<jobId>\`
3. Buat destination file.
4. Pipe stream langsung ke filesystem.
5. Track bytes received.
6. Abort jika melewati `MAX_UPLOAD_SIZE_BYTES`.
7. Handle client disconnect.
8. Handle disk write error.
9. Tunggu stream selesai sebelum membuat job queued.

Gunakan proper backpressure.

Jangan melakukan:

```js
const chunks = [];
```

Jangan melakukan:

```js
Buffer.concat(chunks)
```

Jangan menggunakan memory storage.

==================================================
8. FILE VALIDATION
==================

Validasi:

* video field wajib
* width wajib
* height wajib
* width integer
* height integer
* width > 0
* height > 0
* ukuran file <= MAX_UPLOAD_SIZE_BYTES

Gunakan allowlist extension/video format yang reasonable.

Contoh:

```text
.mp4
.mkv
.mov
.webm
.m4v
.avi
```

Tetapi jangan mempercayai extension sebagai satu-satunya validasi.

Setelah upload selesai, gunakan FFprobe untuk memastikan file dapat dibaca sebagai media/video.

Jangan pernah menggunakan original filename sebagai filesystem path.

Contoh:

```text
User:
../../../../evil.mp4

Server:
D:\VideoTemp\UUID\input.mp4
```

Original filename hanya disimpan sebagai metadata.

==================================================
9. OUTPUT NAMING
================

Output final berada di:

```text
D:\Hasil Render\
```

Gunakan filename yang aman.

Contoh input:

```text
sosul eater rev.mp4
```

Output:

```text
sosul eater rev_prob3_3840x1620.mp4
```

Jika filename mengandung karakter Windows yang invalid, sanitize.

Karakter invalid antara lain:

```text
< > : " / \ | ? *
```

Jangan overwrite file existing secara tidak sengaja.

Jika nama sudah digunakan, tambahkan job ID atau suffix.

Contoh:

```text
sosul eater rev_prob3_3840x1620_769337925.mp4
```

==================================================
10. FFMPEG CONFIGURATION
========================

Buat dedicated FFmpeg argument builder.

Jangan membangun command sebagai satu string.

Gunakan:

```js
spawn(ffmpegPath, args)
```

Dynamic width dan height berasal dari job.

Gunakan baseline command berikut:

```text
ffmpeg "-hide_banner" "-i" INPUT "-sws_flags" "spline+accurate_rnd+full_chroma_int" "-color_trc" "1" "-colorspace" "1" "-color_primaries" "1" "-filter_complex" "tvai_up=model=prob-3:scale=0:w=WIDTH:h=HEIGHT:preblur=-0.100659:noise=0.25:details=0.75:halo=0.05:blur=0.25:compression=0.2:blend=0.6:device=0:vram=1:instances=1,scale=w=WIDTH:h=HEIGHT:flags=lanczos:threads=0,scale=out_color_matrix=bt709" "-c:v" "h264_nvenc" "-profile:v" "high" "-pix_fmt" "yuv420p" "-preset" "p7" "-tune" "hq" "-rc" "constqp" "-qp" "25" "-rc-lookahead" "20" "-spatial_aq" "1" "-temporal_aq" "1" "-aq-strength" "15" "-b:v" "0" "-map" "0:a" "-c:a" "copy" "-bsf:a:0" "aac_adtstoasc" "-map_metadata" "0" "-movflags" "frag_keyframe+empty_moov+delay_moov+use_metadata_tags+write_colr" OUTPUT
```

Tambahkan FFmpeg progress output:

```text
-progress pipe:1
```

atau equivalent yang kompatibel dengan argument ordering.

Jangan mengubah Topaz parameters selain width/height kecuali dibuat sebagai explicit configuration.

==================================================
11. TOPAZ FILTER
================

Default filter:

```text
tvai_up=model=prob-3
```

Parameters:

```text
scale=0
preblur=-0.100659
noise=0.25
details=0.75
halo=0.05
blur=0.25
compression=0.2
blend=0.6
device=0
vram=1
instances=1
```

Kemudian:

```text
scale=w=WIDTH:h=HEIGHT:flags=lanczos:threads=0
```

dan:

```text
scale=out_color_matrix=bt709
```

Jadikan Topaz configuration immutable/default configuration di code/config.

Jangan menerima arbitrary filter string dari API user.

==================================================
12. WIDTH / HEIGHT
==================

Endpoint menerima:

```text
width
height
```

Contoh:

```text
3840x1620
```

Filter harus otomatis menjadi:

```text
tvai_up=...:w=3840:h=1620...
```

dan second scale:

```text
scale=w=3840:h=1620:flags=lanczos:threads=0
```

Jangan melakukan:

```js
command.replace("3840", width)
```

Gunakan proper argument builder.

Validasi agar width/height tidak absurd.

Minimal:

```text
width >= 16
height >= 16
```

Tetapkan configurable maximum jika diperlukan.

==================================================
13. FFPROBE
===========

Sebelum queue processing, jalankan:

```text
C:\Program Files\Topaz Labs LLC\Topaz Video AI\ffprobe.exe
```

Gunakan spawn, bukan shell command.

Ambil minimal:

```text
format.duration
streams
video stream
audio streams
```

Tujuan utama adalah memperoleh duration.

Contoh FFprobe arguments:

```text
-v error
-show_entries format=duration
-of json
INPUT
```

Simpan:

```text
duration_seconds
```

ke database.

Jika FFprobe gagal:

```text
status = failed
```

dan job tidak masuk renderer.

==================================================
14. QUEUE
=========

Implementasikan queue dengan:

```text
QUEUE_CONCURRENCY = 1
```

Queue harus menjamin hanya satu render aktif.

Contoh:

```text
Job A → processing
Job B → queued
Job C → queued
Job D → queued
```

Ketika A selesai:

```text
A → completed
B → processing
C → queued
D → queued
```

Jangan pernah menjalankan dua FFmpeg sekaligus.

Queue harus menggunakan SQLite sebagai source of truth untuk job status.

In-memory queue boleh digunakan sebagai execution mechanism, tetapi persistent state harus berada di SQLite.

==================================================
15. SERVER RESTART / RECOVERY
=============================

Ini wajib.

Ketika Node.js/PM2 restart:

1. Initialize SQLite.
2. Inspect jobs.
3. Cari job dengan status:
   `processing`
4. Karena process lama kemungkinan sudah mati, tandai sebagai:
   `failed`
   dengan error:
   `Renderer interrupted by server restart`
5. Cari jobs:
   `queued`
6. Masukkan kembali ke execution queue.
7. Jangan membuat duplicate rendering.
8. Jangan menjalankan dua worker.

Jika memungkinkan, sebelum menandai processing sebagai failed, cek apakah PID masih hidup. Tetapi jangan mengandalkan PID lama setelah restart.

Prioritaskan correctness daripada mencoba melanjutkan FFmpeg yang terputus.

==================================================
16. RENDER WORKER
=================

Buat dedicated RenderWorker.

Flow:

```text
queue
 ↓
worker
 ↓
set status = processing
 ↓
ffprobe information available
 ↓
create temporary output path
 ↓
spawn ffmpeg
 ↓
parse progress
 ↓
update SQLite
 ↓
ffmpeg exits
 ↓
exit code === 0
 ↓
rename temporary output
 ↓
set completed
 ↓
cleanup input
 ↓
next job
```

Worker harus menangani:

* spawn error
* FFmpeg non-zero exit
* SIGTERM
* cancellation
* filesystem errors
* invalid output
* missing executable
* malformed progress output
* process unexpectedly exiting

==================================================
17. TEMPORARY OUTPUT
====================

Jangan menulis langsung ke final filename.

Gunakan:

```text
D:\Hasil Render\.769337925.rendering.mp4
```

atau:

```text
D:\VideoTemp\769337925\output.tmp.mp4
```

Saya lebih memilih temporary output di final output filesystem:

```text
D:\Hasil Render\.769337925.rendering.mp4
```

Setelah FFmpeg exit code `0`:

```text
temporary output
        ↓
rename()
        ↓
final output
```

Contoh:

```text
D:\Hasil Render\.769337925.rendering.mp4

↓

D:\Hasil Render\sosul eater rev_prob3_3840x1620.mp4
```

Jangan menganggap job completed sebelum rename berhasil.

==================================================
18. FFMPEG PROGRESS
===================

Gunakan FFmpeg:

```text
-progress pipe:1
```

Parse key-value output.

Contoh:

```text
frame=12842
fps=31.4
stream_0_0_q=25.0
bitrate=...
total_size=...
out_time_us=513000000
out_time_ms=513000
out_time=00:08:33.00
dup_frames=0
drop_frames=0
speed=0.82x
progress=continue
```

Simpan ke job:

```text
frame
fps
speed
elapsed_seconds
progress_percent
total_size
```

Hitung:

```text
progress_percent =
out_time_seconds / duration_seconds * 100
```

Clamp:

```text
0 <= progress <= 100
```

Jangan percaya progress > 100.

Pada:

```text
progress=end
```

tunggu process benar-benar exit sebelum menentukan completed.

==================================================
19. DATABASE UPDATE FREQUENCY
=============================

Jangan melakukan SQLite write setiap satu byte atau setiap event stdout kecil.

Throttle progress persistence.

Target sekitar:

```text
1 update / 500ms
```

atau:

```text
1 update / 1 second
```

Gunakan in-memory current progress untuk response cepat, kemudian periodically persist ke SQLite.

Namun setelah process selesai, lakukan final persistence secara synchronous/awaited.

==================================================
20. ACTIVE PROCESS
==================

Job harus menyimpan:

```text
pid
```

dan worker harus memiliki reference ke child process.

Misalnya:

```js
activeProcesses.set(job.id, childProcess);
```

Gunakan ini untuk cancellation.

Jangan expose PID sebagai security-sensitive information ke frontend kecuali memang diperlukan.

==================================================
21. CANCEL ENDPOINT
===================

Implementasikan:

```http
POST /api/v1/jobs/:id/cancel
```

Jika:

```text
queued
```

langsung:

```text
cancelled
```

Jika:

```text
processing
```

ubah menjadi:

```text
cancel_requested
```

kemudian terminate FFmpeg.

Target Windows harus diperhatikan.

`child.kill()` saja mungkin tidak cukup untuk process tree.

Implementasikan Windows-aware termination menggunakan `taskkill /PID <pid> /T /F` jika diperlukan.

Setelah FFmpeg berhenti:

```text
cancelled
```

Cleanup temporary output.

Jangan lanjutkan queue sampai process benar-benar berhenti.

==================================================
22. API ENDPOINTS
=================

Implementasikan endpoint:

### Create job

```http
POST /api/v1/jobs
```

Multipart upload.

Response:

```json
{
  "id": "769337925",
  "status": "queued",
  "position": 2,
  "width": 3840,
  "height": 1620
}
```

### List jobs

```http
GET /api/v1/jobs
```

Tambahkan pagination.

Contoh:

```text
?page=1&limit=20
```

Response:

```json
{
  "data": [],
  "pagination": {
    "page": 1,
    "limit": 20,
    "total": 100,
    "totalPages": 5
  }
}
```

### Get job

```http
GET /api/v1/jobs/:id
```

Return complete job information.

### Progress

```http
GET /api/v1/jobs/:id/progress
```

Return lightweight response:

```json
{
  "id": "769337925",
  "status": "processing",
  "progress": 47.82,
  "frame": 12842,
  "fps": 31.4,
  "speed": "0.82x",
  "elapsed": 513,
  "duration": 1072,
  "output": null
}
```

Jika completed:

```json
{
  "id": "769337925",
  "status": "completed",
  "progress": 100,
  "output": {
    "filename": "sosul eater rev_prob3_3840x1620.mp4"
  }
}
```

### Cancel

```http
POST /api/v1/jobs/:id/cancel
```

### Delete

```http
DELETE /api/v1/jobs/:id
```

Deletion harus aman.

Jika job sedang processing, jangan langsung menghapus database record dan meninggalkan FFmpeg orphan.

Tolak deletion atau ubah menjadi cancellation flow terlebih dahulu.

==================================================
23. HEALTH CHECK
================

Implementasikan:

```http
GET /health
```

Response:

```json
{
  "status": "ok",
  "service": "video-upscaler-api"
}
```

Implementasikan:

```http
GET /api/v1/system/status
```

Response kira-kira:

```json
{
  "renderer": {
    "available": true,
    "ffmpeg": true,
    "ffprobe": true
  },
  "queue": {
    "concurrency": 1,
    "queued": 3,
    "processing": true,
    "activeJobId": "769337925"
  }
}
```

==================================================
24. STARTUP VALIDATION
======================

Pada startup lakukan validation:

1. `FFMPEG_PATH` exists.
2. `FFPROBE_PATH` exists.
3. `TEMP_DIR` exists atau buat otomatis.
4. `OUTPUT_DIR` exists atau buat otomatis.
5. SQLite accessible.
6. FFmpeg dapat dieksekusi.
7. FFprobe dapat dieksekusi.
8. Verify Topaz filter `tvai_up` tersedia.
9. Verify `h264_nvenc` tersedia jika memungkinkan.

Gunakan:

```text
ffmpeg -filters
```

untuk memeriksa:

```text
tvai_up
```

dan:

```text
ffmpeg -encoders
```

untuk memeriksa:

```text
h264_nvenc
```

Jika Topaz filter tidak tersedia, tampilkan error startup yang jelas.

Contoh:

```text
Renderer validation failed:
tvai_up filter was not found in:
C:\Program Files\Topaz Labs LLC\Topaz Video AI\ffmpeg.exe
```

Jangan hanya gagal ketika user sudah upload video.

==================================================
25. SECURITY
============

Implementasikan basic API hardening:

* Helmet jika cocok dengan existing stack.
* CORS configurable.
* Request body limits.
* Upload size limit.
* Filename sanitization.
* Path traversal prevention.
* Validate width/height.
* Jangan menerima arbitrary FFmpeg arguments.
* Jangan menerima arbitrary output path.
* Jangan menggunakan shell interpolation.
* Jangan expose filesystem paths unnecessarily.
* Jangan expose raw FFmpeg stderr ke client secara penuh.

FFmpeg stderr boleh disimpan untuk server logs / error diagnostics dengan batas ukuran.

==================================================
26. ERROR HANDLING
==================

Gunakan consistent error format:

```json
{
  "error": {
    "code": "INVALID_VIDEO",
    "message": "Uploaded file could not be read as a video."
  }
}
```

Contoh error codes:

```text
VALIDATION_ERROR
UPLOAD_TOO_LARGE
INVALID_VIDEO
JOB_NOT_FOUND
JOB_ALREADY_COMPLETED
JOB_NOT_CANCELLABLE
RENDERER_UNAVAILABLE
FFMPEG_ERROR
FFPROBE_ERROR
UPLOAD_ERROR
FILESYSTEM_ERROR
INTERNAL_ERROR
```

Jangan mengembalikan stack trace kepada client production.

Log stack trace di server.

==================================================
27. LOGGING
===========

Logging harus jelas dan searchable.

Contoh:

```text
[INFO] Job 769337925 created
[INFO] Job 769337925 queued
[INFO] Job 769337925 started
[INFO] Job 769337925 ffmpeg PID=12345
[INFO] Job 769337925 progress=47.82%
[INFO] Job 769337925 completed
```

Error:

```text
[ERROR] Job 769337925 FFmpeg exited with code 1
```

Tambahkan job ID pada log setiap kali memungkinkan.

Jangan log full user-uploaded binary data.

==================================================
28. CLEANUP
===========

Setelah completed:

Hapus:

```text
D:\VideoTemp\<jobId>\
```

Setelah failed:

gunakan configurable retention.

Jangan menghapus final output saat cleanup temporary files.

Tambahkan cleanup worker/periodic cleanup untuk stale temp directories.

Contoh:

```text
temp directory older than 24h
AND no active job
→ delete
```

Pastikan cleanup tidak pernah menghapus directory job yang sedang processing.

==================================================
29. GRACEFUL SHUTDOWN
=====================

Handle:

```text
SIGINT
SIGTERM
```

Flow:

```text
shutdown signal
       ↓
stop accepting new requests
       ↓
stop queue from starting new jobs
       ↓
if FFmpeg active:
    wait/terminate according to shutdown policy
       ↓
persist state
       ↓
close SQLite
       ↓
close HTTP server
       ↓
exit
```

Jangan meninggalkan FFmpeg orphan.

Untuk job yang terinterupsi, status setelah restart harus dapat direcover secara deterministic.

==================================================
30. PM2
=======

Buat:

```text
ecosystem.config.js
```

Gunakan:

```js
module.exports = {
  apps: [
    {
      name: "video-upscaler-api",
      script: "./src/server.js",

      instances: 1,
      exec_mode: "fork",

      autorestart: true,
      watch: false,

      max_memory_restart: "512M",

      windowsHide: true,

      env: {
        NODE_ENV: "production"
      }
    }
  ]
};
```

Jangan menggunakan PM2 cluster mode.

Alasan:

```text
1 Node process
+
1 queue
+
1 renderer worker
+
1 GPU
=
predictable concurrency
```

Tambahkan README instructions:

```text
npm install
npm run start
```

dan:

```text
pm2 start ecosystem.config.js
pm2 save
```

Jika diperlukan untuk Windows startup, dokumentasikan konfigurasi PM2 startup Windows yang sesuai.

==================================================
31. PACKAGE SCRIPTS
===================

Tambahkan script yang sesuai:

```json
{
  "scripts": {
    "dev": "node --watch src/server.js",
    "start": "node src/server.js",
    "pm2:start": "pm2 start ecosystem.config.js",
    "pm2:restart": "pm2 restart ecosystem.config.js",
    "pm2:stop": "pm2 stop video-upscaler-api"
  }
}
```

Jika project sudah punya scripts, jangan merusak existing scripts.

==================================================
32. API RESPONSE DESIGN
=======================

Gunakan ISO 8601 untuk timestamp.

Contoh:

```text
2026-09-14T07:30:00.000Z
```

Jangan mengirim Date object mentah jika framework tidak serialize secara konsisten.

Untuk job detail:

```json
{
  "id": "769337925",
  "status": "processing",
  "input": {
    "filename": "sosul eater rev.mp4"
  },
  "output": null,
  "resolution": {
    "width": 3840,
    "height": 1620
  },
  "progress": {
    "percent": 47.82,
    "frame": 12842,
    "fps": 31.4,
    "speed": "0.82x",
    "elapsedSeconds": 513,
    "durationSeconds": 1072
  },
  "timestamps": {
    "createdAt": "...",
    "startedAt": "...",
    "completedAt": null
  },
  "error": null
}
```

==================================================
33. FRONTEND POLLING EXPECTATION
================================

Backend harus mendukung frontend polling setiap sekitar 1 detik.

Polling:

```http
GET /api/v1/jobs/:id/progress
```

harus murah.

Jangan menjalankan FFprobe/FFmpeg setiap request progress.

Jangan melakukan filesystem scan setiap request.

Progress endpoint hanya membaca state dari memory/SQLite.

Browser boleh ditutup.

FFmpeg harus tetap berjalan.

Ketika browser dibuka kembali, frontend dapat mengambil job list dan melanjutkan monitoring.

==================================================
34. IMPORTANT: NO BROWSER DEPENDENCY
====================================

Render lifecycle sepenuhnya berada di backend.

Jangan:

```text
browser open
→ render active

browser closed
→ render stopped
```

Yang benar:

```text
POST job
→ server owns job
→ queue owns job
→ worker owns FFmpeg
→ browser hanya observer
```

==================================================
35. TESTING
===========

Buat testing untuk:

1. Job creation.
2. Validation width/height.
3. Upload streaming.
4. Upload size limit.
5. Invalid video.
6. Queue ordering.
7. Concurrency = 1.
8. Job status transitions.
9. FFmpeg spawn.
10. FFmpeg progress parsing.
11. FFmpeg success.
12. FFmpeg failure.
13. Cancellation.
14. Cleanup.
15. Server restart recovery.
16. Duplicate job protection.
17. Path traversal prevention.

Untuk unit test FFmpeg worker, gunakan mock spawn jika memungkinkan agar test tidak membutuhkan GPU.

==================================================
36. FFmpeg PROGRESS PARSER
==========================

Pisahkan parser menjadi utility/service tersendiri.

Input:

```text
frame=123
fps=30
out_time_ms=5000000
speed=0.8x
progress=continue
```

Output:

```js
{
  frame: 123,
  fps: 30,
  elapsedSeconds: 5,
  speed: "0.8x",
  progress: "continue"
}
```

Parser harus tolerant terhadap:

* field order berbeda
* missing fields
* empty lines
* malformed lines
* FFmpeg stderr/stdout interleaving jika terjadi

Jangan crash worker hanya karena satu malformed progress line.

==================================================
37. FFMPEG STDERR
=================

FFmpeg biasanya memberikan diagnostic information pada stderr.

Capture stderr untuk logging.

Tetapi jangan mengandalkan stderr untuk menghitung progress.

Progress harus menggunakan:

```text
-progress pipe:1
```

Jika FFmpeg gagal:

* capture last N KB stderr
* simpan error summary
* log detailed stderr server-side

Jangan menyimpan unlimited stderr ke memory.

==================================================
38. PROCESS MANAGEMENT
======================

Gunakan:

```js
spawn(ffmpegPath, args, {
  windowsHide: true,
  stdio: ["ignore", "pipe", "pipe"]
});
```

Jangan:

```js
spawn(commandString, { shell: true })
```

atau:

```js
exec(commandString)
```

Input user hanya boleh memengaruhi validated values:

```text
width
height
input file path yang dibuat server
output file path yang dibuat server
```

==================================================
39. IDEMPOTENCY / DUPLICATE PROTECTION
======================================

Pastikan queue tidak dapat menjalankan job yang sama dua kali.

Misalnya:

```text
queued → processing
```

harus atomic dari perspective queue.

Jangan sampai dua async execution path mengambil job queued yang sama.

Gunakan status update yang aman.

Jika perlu:

```sql
UPDATE jobs
SET status = 'processing'
WHERE id = ?
AND status = 'queued'
```

kemudian cek affected rows.

==================================================
40. QUEUE POSITION
==================

Untuk:

```http
POST /api/v1/jobs
```

response boleh memberikan:

```json
{
  "position": 3
}
```

Hitung berdasarkan jumlah job:

```text
status = queued
```

yang dibuat sebelum job tersebut.

Position hanya informasi UI dan bukan contract yang immutable.

==================================================
41. DOWNLOAD RESULT
===================

Tambahkan endpoint:

```http
GET /api/v1/jobs/:id/download
```

Jika completed, stream output file ke client.

Jangan membaca seluruh output ke memory.

Gunakan filesystem stream.

Set proper:

```text
Content-Type: video/mp4
Content-Disposition: attachment
```

Jika job belum completed:

```text
409 JOB_NOT_COMPLETED
```

Jika file missing:

```text
500 OUTPUT_FILE_MISSING
```

Jangan expose raw `D:\Hasil Render\...` path ke frontend.

==================================================
42. SYSTEM STATUS
=================

Renderer status harus membedakan:

```text
available
busy
unavailable
```

Contoh:

```json
{
  "status": "busy",
  "activeJobId": "769337925"
}
```

Startup validation harus mempengaruhi status ini.

==================================================
43. DOCUMENTATION
=================

Buat README yang menjelaskan:

* prerequisites
* Windows requirements
* Topaz Video AI installation
* FFmpeg path
* FFprobe path
* NVIDIA GPU requirement
* environment variables
* installation
* development
* production
* PM2
* API endpoints
* upload example
* polling example
* cancellation
* output directory
* troubleshooting

Contoh curl harus menggunakan Windows-compatible path jika relevan.

==================================================
44. EXAMPLE API FLOW
====================

Dokumentasikan flow:

```text
1. POST /api/v1/jobs
2. Receive job ID
3. GET /api/v1/jobs/:id/progress every ~1 second
4. status becomes completed
5. GET /api/v1/jobs/:id/download
```

Example:

```text
POST /api/v1/jobs
       ↓
202 Accepted
       ↓
{
  id: "abc",
  status: "queued"
}
       ↓
GET /api/v1/jobs/abc/progress
       ↓
queued
       ↓
processing 12%
       ↓
processing 42%
       ↓
processing 88%
       ↓
completed 100%
       ↓
download
```

==================================================
45. IMPORTANT ARCHITECTURAL PRINCIPLES
======================================

Ikuti prinsip berikut:

1. HTTP layer tidak menjalankan render langsung.
2. Upload layer hanya menangani upload.
3. Job service menangani lifecycle.
4. Queue menangani ordering/concurrency.
5. Worker menangani FFmpeg.
6. SQLite menangani persistence.
7. Frontend hanya observer/controller.
8. FFmpeg selalu dijalankan menggunakan absolute Topaz executable path.
9. Input video selalu streaming ke disk.
10. Output selalu ditulis melalui temporary output lalu atomic rename.
11. Tidak ada arbitrary shell command.
12. Tidak ada arbitrary FFmpeg parameters dari user.
13. Hanya satu GPU render aktif.
14. Render tidak bergantung pada browser.
15. Server restart harus predictable.
16. Failed/interrupted jobs harus memiliki state yang jelas.
17. Progress harus real-time tetapi database writes harus throttled.
18. Semua filesystem operations harus Windows-safe.
19. Semua resource harus dibersihkan setelah selesai.
20. Error harus observable melalui logs dan API state.

==================================================
46. IMPLEMENTATION ORDER
========================

Implementasikan secara bertahap:

Phase 1:

* config
* SQLite
* migrations
* job repository

Phase 2:

* upload streaming
* job creation
* validation

Phase 3:

* FFprobe service

Phase 4:

* FFmpeg argument builder

Phase 5:

* FFmpeg progress parser

Phase 6:

* render worker

Phase 7:

* queue concurrency 1

Phase 8:

* cancellation

Phase 9:

* cleanup

Phase 10:

* restart recovery

Phase 11:

* REST endpoints

Phase 12:

* health/system status

Phase 13:

* PM2

Phase 14:

* tests

Phase 15:

* README

==================================================
47. FINAL ACCEPTANCE CRITERIA
=============================

Implementasi dianggap selesai hanya jika:

[ ] User dapat upload video berukuran besar tanpa seluruh video masuk memory.

[ ] Video disimpan ke:
`D:\VideoTemp\<jobId>\input.<ext>`

[ ] FFprobe menggunakan:
`C:\Program Files\Topaz Labs LLC\Topaz Video AI\ffprobe.exe`

[ ] FFmpeg menggunakan:
`C:\Program Files\Topaz Labs LLC\Topaz Video AI\ffmpeg.exe`

[ ] Tidak menggunakan global/system FFmpeg.

[ ] `tvai_up=model=prob-3` digunakan.

[ ] Width dan height dapat dikirim dari API.

[ ] Width dan height masuk ke kedua scale operation yang relevan.

[ ] FFmpeg berjalan asynchronous.

[ ] HTTP request upload tidak menunggu render selesai.

[ ] Queue hanya mengizinkan satu FFmpeg aktif.

[ ] Dua job tidak pernah menggunakan GPU bersamaan.

[ ] Progress FFmpeg dapat dibaca secara real-time.

[ ] Progress tersedia melalui REST endpoint.

[ ] Browser dapat ditutup tanpa menghentikan render.

[ ] Browser dapat dibuka kembali dan melihat status job.

[ ] Job state tersimpan di SQLite.

[ ] PM2 dapat restart Node tanpa kehilangan queued jobs.

[ ] Processing job saat crash/restart ditangani dengan benar.

[ ] FFmpeg tidak menjadi orphan process.

[ ] Cancel dapat menghentikan queued job.

[ ] Cancel dapat menghentikan active FFmpeg job pada Windows.

[ ] Output menggunakan temporary file terlebih dahulu.

[ ] Final output berada di:
`D:\Hasil Render\`

[ ] Output hanya dianggap completed setelah FFmpeg sukses dan rename berhasil.

[ ] Temporary files dibersihkan.

[ ] Output dapat di-download melalui streaming endpoint.

[ ] Path traversal dicegah.

[ ] Arbitrary FFmpeg command injection dicegah.

[ ] Error handling konsisten.

[ ] Logging memiliki job ID.

[ ] Health endpoint tersedia.

[ ] System status endpoint tersedia.

[ ] PM2 ecosystem tersedia.

[ ] README lengkap.

[ ] Tests untuk queue, progress parser, upload validation, cancellation, dan worker lifecycle tersedia.

Setelah implementasi selesai, review seluruh codebase untuk mencari:

* race conditions
* memory leaks
* orphan FFmpeg processes
* duplicate job execution
* path traversal
* unbounded memory usage
* unhandled promise rejection
* SQLite locking problems
* Windows path issues
* graceful shutdown problems

Kemudian perbaiki masalah yang ditemukan.

Jangan hanya membuat skeleton. Implementasikan fitur sampai dapat dijalankan secara nyata pada Windows dengan Topaz Video AI FFmpeg.
