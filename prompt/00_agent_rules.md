# Quy tắc chung cho AI Agent (áp dụng cho MỌI phase)

Đọc file này **trước** khi đọc prompt phase. Vi phạm quy tắc 🔒 là lỗi nghiêm trọng.

## 🔒 Bất khả xâm phạm

1. **Không sửa, xoá, đổi tên bất kỳ file nào trong `c:\OwnProject\extension\`** (extension dự phòng đang đóng băng). Ngoại lệ duy nhất: Phase 0 được `git init` + commit + tag ở đó, và thư mục `prompt\` là tài liệu.
2. **Không đặt `node_modules`, `package-lock.json` của app desktop, hay bất kỳ file build nào bên trong `c:\OwnProject\extension\`.** Mọi code mới ở `c:\OwnProject\hotmatch-desktop\`.
3. Không commit dữ liệu nhạy cảm (proxy thật, mật khẩu, cookie). File chứa chúng phải nằm trong `.gitignore` (`spike/proxies.txt`, `*.local.*`, thư mục `userData`).
4. Không ghi log ra console/file: mật khẩu, token, giá trị cookie, body phản hồi chứa token. Hộp đen chỉ lưu những gì `extension/lib/blackbox.js` đang lưu.
5. Không tự thêm tính năng ngoài phạm vi phase. Ý tưởng hay → ghi vào `docs/DECISIONS.md` mục "Đề xuất".

## Kỹ thuật

- **Stack**: Electron (stable mới nhất, tối thiểu v32), Node ESM (`"type": "module"`), JavaScript thuần, HTML + Vanilla CSS. Không TypeScript, không framework UI, không Tailwind, không bundler.
- **Dependency** được phép: `electron`, `electron-builder` (dev), `proxy-chain`. Thêm gói khác phải ghi lý do vào `docs/DECISIONS.md`.
- **Bảo mật Electron**: `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false` cho mọi renderer. Preload viết **CommonJS** (`.cjs`). Renderer chỉ gọi main qua `window.hm` được expose bằng `contextBridge`, danh sách kênh IPC là whitelist.
- **Site view** (trang nhà cái) **không có preload nào expose API ra trang**. Mọi thao tác lên trang làm từ main qua `webContents.executeJavaScript`.
- **Toolbar Claimer và Father dùng session mặc định**, KHÔNG dùng partition của profile.
- Chú thích code bằng **tiếng Việt**, giải thích *vì sao* chứ không lặp lại *cái gì* — giữ đúng phong cách các file trong `extension/lib/`.
- Khi copy logic từ extension: **giữ nguyên các comment giải thích** (chúng chứa kiến thức đo đạc thực tế: offset, TTL 10 phút, AWM, v.v.).
- Ghi file JSON luôn **atomic** (ghi file tạm rồi `rename`) và **tuần tự** (hàng đợi ghi), vì lỗi đè ghi song song đã từng xảy ra ở extension (xem comment `serialized` trong `extension/lib/sites.js`).
- Mọi hàm mạng **không bao giờ ném lỗi** trong đường bắn (giữ triết lý `timedFetch`: lỗi → `status: 0`).
- Giới hạn song song mặc định khi chạy hàng loạt: 5 (cấu hình được), trừ engine bắn code (song song toàn bộ, như extension).

## Kiểm thử & bàn giao

- Test bằng `node --test`. Lệnh `npm test` ở `hotmatch-desktop` phải xanh khi kết thúc mỗi phase.
- Không mạng thật trong unit test: dùng `fetchImpl` giả.
- Cuối mỗi phase, viết `hotmatch-desktop/docs/phase-N-report.md` gồm:
  1. Việc đã làm (theo checklist của prompt), 2. Việc chưa làm + lý do, 3. Quyết định kỹ thuật mới, 4. Cách chạy/kiểm tra thủ công, 5. Rủi ro còn lại.
- Commit git theo từng bước nhỏ có nghĩa trong repo `hotmatch-desktop` (message tiếng Việt hoặc tiếng Anh, ngắn gọn).
- Nếu gặp điểm mơ hồ có ảnh hưởng kiến trúc → **dừng lại hỏi người dùng**, không đoán.
