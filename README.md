# YouTube Downloader

Mini app tải video YouTube: dán nhiều link cùng lúc, đặt tên file và chọn thư mục riêng cho từng link. Chất lượng mặc định 1080p, tải full clip. Không có database — reload/restart là mất danh sách.

## Yêu cầu

- Node.js
- `yt-dlp` và `ffmpeg` trong PATH (cài qua winget: `winget install yt-dlp.yt-dlp yt-dlp.FFmpeg`)
- **yt-dlp phải ở kênh nightly** (bản stable cũ bị YouTube chặn 403 với format 1080p):
  ```
  yt-dlp --update-to nightly
  ```
- [bgutil-ytdlp-pot-provider](https://github.com/Brainicism/bgutil-ytdlp-pot-provider) để sinh PO token (đã cài sẵn trên máy này):
  - Plugin zip nằm ở `%APPDATA%\yt-dlp\plugins\bgutil-ytdlp-pot-provider.zip`
  - POT server nằm ở `%USERPROFILE%\bgutil-ytdlp-pot-provider\server` (app tự khởi động nó ở port 4416)

## Chạy app

```
npm install
npm run dev
```

Mở http://localhost:5173

- Backend Express chạy ở port 3001 (gọi yt-dlp, tối đa 2 download song song)
- Frontend Vite chạy ở port 5173 (proxy `/api` sang 3001)

## Khi download bị lỗi 403

YouTube đổi cơ chế chặn thường xuyên. Chạy `yt-dlp --update-to nightly` để cập nhật rồi thử lại.
