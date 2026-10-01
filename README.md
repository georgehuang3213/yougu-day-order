# 優穀日・Homemade Yogurt Bowl 線上接單與後台管理系統

專為「優穀日」設計的輕量級即時點餐與接單管理系統，已完整配置 **Vercel 一鍵部署** 架構，支援手機、平板與電腦操作。

---

## 🌟 系統亮點與功能特色

### 📱 1. 顧客點餐前台 (`/` 或 `/index.html`)
- **品牌訂製視覺**：無加糖鮮奶優格專屬質感色調、高清產品實拍圖與自製藍莓果醬介紹。
- **預約制取餐驗證**：平日營業時間 **07:30 - 16:00**（週六、日與例假日公休），支援預約時段防呆機制。
- **加料選單**：支援乾濕分離燕麥脆粒、手工低溫燕麥脆塊、自製綜合莓果醬等加料選項。
- **集點券折抵**：支援「折價 20 元」與「免費折抵乙份」優惠券選填。
- **自備環保袋倡導**：內建自備餐袋／環保袋核取方塊。
- **多元付款方式**：現金支付、LINE Pay Money。
- **一鍵傳送至 LINE 官方帳號**：訂單送出後，可直接在手機上自動帶入 LINE 對話框傳送給官方帳號，雙重確認不漏單！

### 💻 2. 店長接單後台 (`/admin` 或 `/admin.html`)
- **即時接單看板**：新訂單 ➔ 製作中 ➔ 待取餐 ➔ 已完成，一鍵切換狀態。
- **新訂單聲響提示**：顧客下單時自動響起「叮咚」三和弦提示音（免下載任何音效檔）。
- **今日備料自動統計**：自動計算當日所有訂單所需的「無加糖鮮奶優格總杯數」、「各口味杯數」、「各類加料份數」及「自備環保袋顧客數」。
- **一鍵撥號 & 複製訂單**：可直接點擊電話撥打，或一鍵複製格式化訂單傳送給顧客。
- **營運報表匯出**：支援一鍵匯出繁體中文 UTF-8 CSV 訂單報表。

---

## 🚀 3 分鐘部署到 VERCEL 教學

此專案已配置好 `vercel.json` 與 Serverless Function (`api/orders.js`)，不需要任何後端伺服器或資料庫即可上線！

### 方式一：使用 GitHub + Vercel 官網（最推薦、最穩定）

1. **上傳程式碼到 GitHub**：
   - 建立一個新的 GitHub 倉庫（例如 `yougu-day-order`）。
   - 將本資料夾內的所有檔案上傳或 push 到該倉庫。
2. **登入 Vercel**：
   - 前往 [https://vercel.com](https://vercel.com) 並登入（可用 GitHub 帳號登入）。
3. **匯入專案**：
   - 點擊「**Add New...**」➔「**Project**」。
   - 選擇剛剛建立的 GitHub 倉庫，點擊「**Import**」。
   - **Framework Preset** 保持為「**Other**」。
   - **Root Directory** 保持 `./`（根目錄）。
   - 點擊「**Deploy**」！
4. **完成部署**：
   - 約 30 秒後，Vercel 就會給您一個專屬網址（例如：`https://yougu-day-order.vercel.app`）。
   - 顧客點餐前台：`https://yougu-day-order.vercel.app`
   - 店長管理後台：`https://yougu-day-order.vercel.app/admin`

---

### 方式二：使用 Vercel CLI 終端機指令快速上傳

若電腦有安裝 Node.js，可以直接在專案目錄下執行：
```powershell
npx vercel
```
依照畫面提示登入並按 Enter 確認，即可自動完成發布！

---

## 📲 如何設定 LINE 官方帳號圖文選單

1. 前往 **[LINE Official Account Manager](https://manager.line.biz/)**。
2. 進入「**圖文選單** (Rich Menus)」設定。
3. 點選右下角的【**點餐**】區塊：
   - 動作類型選擇：**「連結 (URL)」**。
   - 貼上您在 Vercel 部署後的網址：`https://您的專案名稱.vercel.app`。
4. 點選【**儲存**】即可！顧客點擊圖文選單的「點餐」按鈕就會直接開啟點餐介面。

> 💡 **小叮嚀**：
> 若您要在顧客下單後直接跳轉至您的官方 LINE 帳號，請打開 `public/index.html` 第 522 行左右，將：
> `const LINE_OA_ID = '@yougu_day';`
> 修改為您實際的 LINE 官方帳號 ID（含 `@`），或您在 LINE 後台取得的官方好友加好友/對話連結。

---

---

## 🗄️ Cloudflare R2 資料庫儲存設定

系統已完整串接 **Cloudflare R2**（S3 相容高效物件儲存），所有訂單將永久保存在雲端儲存空間中，不再因伺服器重啟或更換裝置而遺失。

### 如何取得 Cloudflare R2 金鑰並設定：

1. **建立 R2 儲存貯體 (Bucket)**：
   - 登入 [Cloudflare Dashboard](https://dash.cloudflare.com/) ➔ 點擊左側選單 **R2**。
   - 點擊 **Create bucket**，輸入名稱（例如：`yougu-orders`），點擊建立。
2. **建立 API Token (存取金鑰)**：
   - 在 R2 頁面右側點擊 **Manage R2 API Tokens** ➔ **Create API Token**。
   - 權限選擇 **Object Read & Write (讀寫權限)**。
   - 點擊建立後，複製儲存 **Access Key ID** 與 **Secret Access Key**。
3. **在 Vercel 設定環境變數**：
   - 進入 Vercel 專案 ➔ **Settings** ➔ **Environment Variables**。
   - 新增以下 4 個環境變數：
     - `CLOUDFLARE_ACCOUNT_ID`：您的 Cloudflare Account ID（在 Cloudflare 首頁右側或 R2 頁面皆可看到）
     - `R2_ACCESS_KEY_ID`：剛才取得的 Access Key ID
     - `R2_SECRET_ACCESS_KEY`：剛才取得的 Secret Access Key
     - `R2_BUCKET_NAME`：例如 `yougu-orders`
4. **重新部署 (Redeploy)**：
   - 設定完成後在 Vercel 點擊 Redeploy，所有前台下單與後台更新將自動同步寫入 Cloudflare R2！

---

## 📂 專案檔案結構

```
yougu_day_order_system/
├── api/
│   └── orders.js           # Cloudflare R2 雲端訂單 API (支援 GET/POST/PUT/DELETE)
├── public/
│   ├── images/
│   │   ├── logo.png        # 優穀日官方透明 Logo
│   │   ├── hero.jpg        # 品牌形象照片
│   │   └── blueberry_bowl.jpg # 自製藍莓果醬優格碗照片
│   ├── index.html          # 顧客手機點餐前台
│   └── admin.html          # 店長接單與備料管理後台
├── .env.example            # Cloudflare R2 環境變數範例
├── package.json            # 專案套件設定檔 (@aws-sdk/client-s3)
├── vercel.json             # Vercel 路由與靜態重定向配置
└── README.md               # 系統說明與部署手冊
```
