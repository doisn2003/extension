# PROMPT — Phase 0: Backup & Spike kỹ thuật

## Vai trò
Bạn là kỹ sư Electron cấp cao. Nhiệm vụ của phase này là **chứng minh bằng thí nghiệm** các giả định kỹ thuật của hệ thống trước khi xây thật. Code ở phase này là code thí nghiệm, không cần đẹp, nhưng kết quả đo phải trung thực.

## Đọc trước (bắt buộc)
1. `c:\OwnProject\extension\prompt\00_agent_rules.md`
2. `c:\OwnProject\extension\prompt\00_master_plan.md` (đặc biệt §1, §2, §5, §6, §10)
3. `c:\OwnProject\extension\lib\scheduler.js`, `net.js`, `clock.js`, `sites.js` (hàm `computeBarrier`, `loginSite`) — để hiểu yêu cầu về timer, fetch, cookie.

## Bước 1 — Bảo vệ extension dự phòng (làm TRƯỚC mọi thứ)
1. Tạo file zip: `c:\OwnProject\backup\extension-v0.1.2-<yyyyMMdd-HHmm>.zip` chứa toàn bộ `c:\OwnProject\extension\`.
2. Trong `c:\OwnProject\extension\`: `git init`, tạo `.gitignore` (`node_modules/`), commit toàn bộ với message `baseline: extension v0.1.2 (fallback)`, tag `fallback-v0.1.2`.
3. Từ đây **không đụng** vào extension nữa.

## Bước 2 — Khởi tạo dự án desktop
1. Tạo `c:\OwnProject\hotmatch-desktop\`, `git init`, `.gitignore` theo master plan §8.
2. `npm init -y`, đặt `"type": "module"`, `"private": true`, `"main": "main/index.js"`.
3. Cài: `electron` (dev), `proxy-chain`.
4. Script: `"spike": "electron spike/main.js"`, `"test": "node --test test/"` (thư mục `test/` có thể chỉ chứa 1 test giả ở phase này).
5. Tạo `spike/proxies.example.txt` (định dạng `ip:port:user:pass`, dữ liệu giả) và hướng dẫn người dùng tạo `spike/proxies.txt` (gitignored) với **3 proxy thật**. Tạo `spike/config.example.json` với `{ "realSiteDomain": "", "realSiteUsername": "", "realSitePassword": "" }` → người dùng điền vào `spike/config.local.json` (gitignored).

## Bước 3 — Thí nghiệm
Viết `spike/main.js` (+ file phụ nếu cần) mở **1 cửa sổ điều khiển** đơn giản có nút chạy từng thí nghiệm và vùng hiện kết quả JSON. Mỗi thí nghiệm ghi kết quả vào `spike/results/<id>.json`.

Dùng 3 partition `persist:spike-1..3`, mỗi partition 1 proxy từ `proxies.txt`.

| ID | Thí nghiệm | Cách đo | Tiêu chí đạt |
|---|---|---|---|
| E1 | Cô lập cookie | `ses1.cookies.set` cookie `x=1` cho `https://httpbin.org`; đọc ở ses2, ses3. Mở `https://httpbin.org/cookies` trong cửa sổ của từng partition. | Chỉ ses1 thấy cookie. |
| E2 | Proxy + auth cho **cửa sổ** | `setProxy` + xử lý sự kiện `login` (app hoặc webContents, `authInfo.isProxy`). Mở `https://api.ipify.org?format=json`. | IP hiển thị = IP proxy của partition đó, 3 partition 3 IP khác nhau. |
| E3 | Proxy + auth cho **`ses.fetch` từ main** | (a) chỉ dùng sự kiện `login`; (b) dùng `proxy-chain` `anonymizeProxy('http://user:pass@ip:port')` → `setProxy({ proxyRules: '127.0.0.1:<port>' })`. Gọi `ses.fetch('https://api.ipify.org?format=json')`. | Ghi rõ (a) có chạy không, (b) có chạy không. Kết luận dùng cách nào. |
| E4 | `ses.fetch` mang cookie | Đặt cookie trong partition cho `httpbin.org`; gọi `ses.fetch('https://httpbin.org/cookies')` với: không truyền `credentials`, `credentials: 'include'`, `credentials: 'omit'`. Gọi `https://httpbin.org/cookies/set?y=2` rồi kiểm tra `ses.cookies.get` có `y` không. | Xác định tổ hợp tham số khiến cookie được **gửi đi** và **Set-Cookie được lưu lại** trong partition. |
| E5 | Header nhận diện | Từ cửa sổ và từ `ses.fetch`, gọi `https://httpbin.org/headers`. Ghi `User-Agent`, `sec-ch-ua*`. Thử `app.userAgentFallback` và `ses.setUserAgent(...)` với UA Chrome chuẩn (bỏ token `Electron/x` và tên app). | Ghi header trước/sau; xác nhận còn hay hết chữ "Electron". |
| E6 | Độ chính xác timer ở main | Copy `extension/lib/scheduler.js` vào `spike/`, chạy `measurePrecision(30, 400)` ở main process: (i) bình thường, (ii) mọi cửa sổ minimize, (iii) trong lúc 5 cửa sổ đang tải trang nặng. So với `setTimeout` thuần. | Ghi median/worst từng trường hợp. Kỳ vọng worst < 5ms với scheduler. |
| E7 | Kết nối ấm | `ses.fetch` 5 lần liên tiếp tới cùng host thật (`realSiteDomain`) qua proxy; ghi latency từng lần. | Lần 1 chậm hơn rõ (TLS) → xác nhận preflight hâm nóng có tác dụng qua `ses.fetch`. |
| E8 | RAM | Mở 1, 5, 10 cửa sổ trang chủ `realSiteDomain` (mỗi cửa sổ 1 partition, có thể dùng chung proxy). Đo `app.getAppMetrics()` tổng `workingSetSize`. Lặp lại với Lite mode (chặn image/media/font qua `webRequest`). Sau đó huỷ webContents (Sleep) và đo lại. | Bảng RAM theo số cửa sổ, có/không Lite, sau Sleep. Đề xuất giới hạn cửa sổ cho máy 16GB. |
| E9 | Login API thật (tuỳ chọn, chỉ khi người dùng đã điền `config.local.json`) | Port tối thiểu `computeBarrier` + `POST https://<domain>/api/v1/login` qua `ses.fetch` (cookie barrier đặt bằng `ses.cookies.set`). Sau đó `GET /api/v1/refresh`. | Đăng nhập thành công và `/api/v1/refresh` trả user → chứng minh cookie phiên được lưu trong partition. **Không ghi token/mật khẩu ra kết quả**, chỉ ghi `ok`, `status`, `username`. |

Ghi chú kỹ thuật:
- Bật switches theo master plan §6 ngay đầu `spike/main.js`.
- Sau mỗi lần `setProxy`, gọi `ses.closeAllConnections()`.
- Site view: `setWebRTCIPHandlingPolicy('disable_non_proxied_udp')`.

## Bước 4 — Báo cáo
Viết `hotmatch-desktop/docs/phase-0-report.md`:
1. Bảng kết quả E1–E9 (đạt/không, số liệu).
2. **Quyết định chốt** (ghi đồng thời vào `docs/DECISIONS.md`):
   - Proxy auth cho `ses.fetch`: `login event` hay `proxy-chain`.
   - Tham số `credentials` bắt buộc cho `ses.fetch`.
   - Cách chuẩn hoá User-Agent.
   - Giới hạn cửa sổ mặc định (đề xuất từ E8).
   - Có cần giữ vòng quay của `scheduler.js` ở main không (từ E6).
3. Nếu E3 hoặc E4 **thất bại hoàn toàn**: đề xuất phương án dự phòng `executeJavaScript('fetch')` và **dừng lại báo người dùng** trước khi sang Phase 1.

## Ngoài phạm vi
Không làm UI thật, không fork `lib/`, không tạo data model.

## Checklist nghiệm thu
- [ ] Có file zip backup + git tag `fallback-v0.1.2` trong extension.
- [ ] `hotmatch-desktop` khởi tạo, `npm run spike` chạy được.
- [ ] E1–E8 có kết quả trong `spike/results/` (E9 nếu có dữ liệu).
- [ ] `docs/phase-0-report.md` và `docs/DECISIONS.md` đã viết.
- [ ] `git status` trong extension sạch (không có thay đổi sau tag).
