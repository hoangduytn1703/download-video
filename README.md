# Youtube Download Tool

Mini app tải video YouTube: dán nhiều link cùng lúc, đặt tên file và chọn thư mục riêng cho từng link. Chất lượng mặc định 1080p, tải full clip. Không có database — đóng app là danh sách job mất hết.

## Dành cho người dùng (không cần cài gì)

Tải file cài đặt ở mục [Releases](https://github.com/hoangduytn1703/download-video/releases) rồi chạy:

| File | Dùng khi |
| --- | --- |
| `YoutubeDownloadTool-Setup-x.y.z.exe` | Cài đặt bình thường, có shortcut ngoài desktop + tự cập nhật bản mới |
| `YoutubeDownloadTool-portable-x.y.z.exe` | Không muốn cài — chép vào USB/ổ chung, double-click là chạy |

Đã đóng gói sẵn `yt-dlp` và `ffmpeg` bên trong, **không cần cài Node.js hay gõ lệnh gì cả**.

> **Windows báo "Windows protected your PC"?** Do file chưa mua chứng chỉ ký số (~$300/năm), không phải virus. Bấm **More info → Run anyway**.

## Dành cho người phát triển

```
npm install
npm run dev      # giao diện localhost:5173 + backend localhost:3001
npm test         # chạy unit test
```

Yêu cầu khi chạy dạng dev: `yt-dlp` và `ffmpeg` có trong PATH.

```
winget install yt-dlp.yt-dlp yt-dlp.FFmpeg
yt-dlp --update-to nightly
```

### Đóng gói app desktop

Chép binary vào `resources/bin/` (thư mục này không đưa lên git vì file rất nặng):

```
resources/bin/yt-dlp.exe
resources/bin/ffmpeg.exe
```

Rồi chạy:

```
npm run app         # chạy thử app desktop
npm run app:build   # xuất file cài đặt vào release/
```

### Bản web trên GitHub Pages

Giao diện được deploy tự động lên https://hoangduytn1703.github.io/download-video/ mỗi lần push lên `master`.

Lưu ý: trang Pages **chỉ là giao diện** — nó gọi backend chạy ở `localhost:3001` trên máy người xem, nên phải `npm run server` trước. Với người dùng thường thì nên dùng bản app desktop ở trên cho tiện.

## 🔍 Phân tích & ✂️ Cắt clip AI

App có 2 tab dùng chung một danh sách link (tối đa 40, tự phát hiện link trùng):

- **🔍 Phân tích** (tab mặc định): dán link → Gemini đọc video (~5–10 giây/video) và trả về các đoạn hay nhất dạng text `Name: ... | start_1: ... | end_1: ... | title_bottom_1: ...` → bấm 📋 Copy kết quả (hoặc 🔗 copy riêng link video). Bấm **✏️ Sửa** để chỉnh tên video, mốc thời gian, tiêu đề từng đoạn, bỏ/thêm đoạn — text kết quả cập nhật ngay theo bản đã sửa. Kết quả nào không vừa ý thì bấm **🔄 Phân tích lại** để chạy lại riêng video đó (chỉ tốn 1 lượt AI). Tab này chỉ trả text, không tải/không cắt gì cả.
- **✂️ Cắt clip**: chọn nguồn mốc cắt — *dùng kết quả đã phân tích* (không tốn token) / *phân tích bằng prompt trong Cài đặt* / *prompt mới nhập tay* — bấm Phân tích để xem/sửa mốc, hoặc bấm Cắt: app tải bản 1080p rồi cắt thành từng clip (`Ten_P1.mp4`, `Ten_P2.mp4`...) kèm file `Ten_titles.txt` chứa tiêu đề AI đặt. Có nút ⬇ tải nguyên video (bản full, không cắt) cho từng link hoặc tất cả. Chạy được nhiều link song song.

Cần **Gemini API key** (lấy miễn phí/trả phí tại aistudio.google.com/apikey) — nhập một lần trong Cài đặt (⚙️), key chỉ lưu trên máy đó (`%USERPROFILE%\.youtube-download-tool\config.json`), không lên git. Prompt phân tích cũng sửa được trong Cài đặt.

Lưu ý kỹ thuật: cắt bằng `-c copy` (không re-encode) nên điểm bắt đầu clip bám theo keyframe gần nhất — có thể sớm hơn mốc yêu cầu vài giây, đổi lại tốc độ cắt gần như tức thì và giữ nguyên chất lượng.

## Khi download bị lỗi 403

YouTube thay đổi cơ chế chặn thường xuyên. Trong app có sẵn nút **🔄 Reset bộ tải** — bấm là app tự cập nhật yt-dlp lên bản mới nhất rồi thử lại các video lỗi.

Nếu chạy dạng dev thì chạy tay: `yt-dlp --update-to nightly`.

> Bản portable giải nén ra thư mục tạm mỗi lần chạy nên bản cập nhật không được giữ lại — dùng bản Setup nếu muốn cập nhật giữ lâu dài.

---

© 2026 - code by Nguyễn Hoàng Duy
