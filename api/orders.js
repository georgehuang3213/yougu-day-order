import crypto from "crypto";
import { requireAdmin } from "./_auth.js";

// 記憶體資料：僅在「未設定 R2」時作為儲存，或 R2 讀取失敗時作為唯讀快取。
// 注意：絕不可再合併回 R2，否則已刪除的訂單會在其他 Vercel 實例「復活」。
let memoryOrders = [];

// 折扣規則（必須與前端 index.html 的 discount-select 一致）
const MAX_ITEM_DISCOUNT = 140;
const MAX_QTY_PER_ITEM = 50;

// 台灣時區日期字串（MMDD），避免早上 8 點前訂單編號變成前一天
function taiwanMMDD(date = new Date()) {
  return new Date(date.getTime() + 8 * 60 * 60 * 1000).toISOString().slice(5, 10).replace("-", "");
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ─────────────────────────────────────────────────────────
// R2 設定
// ─────────────────────────────────────────────────────────
function getR2Config() {
  const CORRECT_ACCOUNT_ID = "8487a37db0822819e2e9a080ed2d437b";
  const accountId = (process.env.CLOUDFLARE_ACCOUNT_ID || CORRECT_ACCOUNT_ID).trim().replace(/^["']|["']$/g, "");
  const accessKeyId = (process.env.R2_ACCESS_KEY_ID || "").trim().replace(/^["']|["']$/g, "");
  const secretAccessKey = (process.env.R2_SECRET_ACCESS_KEY || "").trim().replace(/^["']|["']$/g, "");
  let endpoint = (process.env.R2_ENDPOINT || "").trim().replace(/^["']|["']$/g, "");


  if (!endpoint && accountId) {
    endpoint = `https://${accountId}.r2.cloudflarestorage.com`;
  }
  if (!accessKeyId || !secretAccessKey || !endpoint) return null;
  endpoint = endpoint.replace(/\/+$/, "");
  return { accessKeyId, secretAccessKey, endpoint };
}

const BUCKET_NAME = (process.env.R2_BUCKET_NAME || "yougu-orders").trim().replace(/^["']|["']$/g, "");

// ─────────────────────────────────────────────────────────
// AWS Signature V4 實作
// ─────────────────────────────────────────────────────────
function hmacSHA256(key, data) {
  return crypto.createHmac("sha256", key).update(data, "utf8").digest();
}
function sha256Hex(data) {
  return crypto.createHash("sha256").update(data, "utf8").digest("hex");
}
function getSigningKey(secretKey, dateStamp) {
  const kDate    = hmacSHA256("AWS4" + secretKey, dateStamp);
  const kRegion  = hmacSHA256(kDate, "auto");
  const kService = hmacSHA256(kRegion, "s3");
  return hmacSHA256(kService, "aws4_request");
}

async function r2Fetch(r2Config, method, key, body, extraHeaders = {}) {
  const { endpoint, accessKeyId, secretAccessKey } = r2Config;
  const host = new URL(endpoint).host;
  const url  = `${endpoint}/${BUCKET_NAME}/${key}`;

  const now       = new Date();
  const amzDate   = now.toISOString().replace(/[:\-]|\.\d{3}/g, "").slice(0, 15) + "Z";
  const dateStamp = amzDate.slice(0, 8);

  const bodyStr     = body != null ? (typeof body === "string" ? body : JSON.stringify(body, null, 2)) : "";
  const bodyHash    = sha256Hex(bodyStr);
  const contentType = body != null ? "application/json" : "";

  const canonHeaders = contentType
    ? `content-type:${contentType}\nhost:${host}\nx-amz-content-sha256:${bodyHash}\nx-amz-date:${amzDate}\n`
    : `host:${host}\nx-amz-content-sha256:${bodyHash}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = contentType
    ? "content-type;host;x-amz-content-sha256;x-amz-date"
    : "host;x-amz-content-sha256;x-amz-date";

  const canonRequest = [method, `/${BUCKET_NAME}/${key}`, "", canonHeaders, signedHeaders, bodyHash].join("\n");
  const canonRequestHash = sha256Hex(canonRequest);
  const credScope    = `${dateStamp}/auto/s3/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, credScope, canonRequestHash].join("\n");

  const signingKey = getSigningKey(secretAccessKey, dateStamp);
  const signature  = hmacSHA256(signingKey, stringToSign).toString("hex");
  const authHeader = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const headers = {
    Authorization: authHeader,
    "x-amz-date": amzDate,
    "x-amz-content-sha256": bodyHash,
  };
  if (contentType) headers["content-type"] = contentType;
  Object.assign(headers, extraHeaders);

  return fetch(url, {
    method,
    headers,
    body: bodyStr || undefined,
  });
}

// ─────────────────────────────────────────────────────────
// 列出 R2 指定前綴之物件鍵值
// ─────────────────────────────────────────────────────────
async function listR2Keys(r2Config, prefix) {
  if (!r2Config) return [];
  try {
    const { endpoint, accessKeyId, secretAccessKey } = r2Config;
    const host = new URL(endpoint).host;
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:\-]|\.\d{3}/g, "").slice(0, 15) + "Z";
    const dateStamp = amzDate.slice(0, 8);
    const bodyHash = sha256Hex("");
    const canonHeaders = `host:${host}\nx-amz-content-sha256:${bodyHash}\nx-amz-date:${amzDate}\n`;
    const signedHeaders = "host;x-amz-content-sha256;x-amz-date";
    const query = `list-type=2&prefix=${encodeURIComponent(prefix)}`;
    const canonRequest = ["GET", `/${BUCKET_NAME}`, query, canonHeaders, signedHeaders, bodyHash].join("\n");
    const credScope = `${dateStamp}/auto/s3/aws4_request`;
    const stringToSign = ["AWS4-HMAC-SHA256", amzDate, credScope, sha256Hex(canonRequest)].join("\n");
    const signingKey = getSigningKey(secretAccessKey, dateStamp);
    const signature = hmacSHA256(signingKey, stringToSign).toString("hex");
    const authHeader = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

    const res = await fetch(`${endpoint}/${BUCKET_NAME}?${query}`, {
      headers: {
        Authorization: authHeader,
        "x-amz-date": amzDate,
        "x-amz-content-sha256": bodyHash
      }
    });
    if (res.ok) {
      const xml = await res.text();
      return [...xml.matchAll(/<Key>(.*?)<\/Key>/g)].map(m => m[1]);
    }
  } catch (err) {
    console.warn("listR2Keys 讀取異常:", err.message);
  }
  return [];
}

// ─────────────────────────────────────────────────────────
// 訂單 CRUD
// - orders.json 為總表；orders/{id}.json 為每筆訂單的獨立備份（下單時先寫，避免並發遺失）
// - 寫入總表使用 ETag 條件寫入 (If-Match)，衝突時自動重讀重試，避免互相覆蓋
// - R2 讀取失敗時「丟出錯誤」，絕不以空資料覆寫總表
// ─────────────────────────────────────────────────────────

// 讀取總表＋合併尚未進總表的獨立訂單檔；回傳 { orders, etag, merged }
async function readOrdersState(r2Config) {
  const map = new Map();
  let etag = null;

  const res = await r2Fetch(r2Config, "GET", "orders.json");
  if (res.ok) {
    etag = (res.headers.get("etag") || "").replace(/^W\//, "") || null;
    const parsed = await res.json();
    if (Array.isArray(parsed)) {
      parsed.forEach(o => { const id = o && (o.orderId || o.id); if (id) map.set(id, o); });
    }
  } else if (res.status !== 404) {
    throw new Error(`R2 GET orders.json 失敗: ${res.status}`);
  }

  let merged = false;
  const singleKeys = await listR2Keys(r2Config, "orders/");
  const missingKeys = singleKeys.filter(k => {
    const m = k.match(/^orders\/(.+)\.json$/);
    return m && !map.has(m[1]);
  });
  if (missingKeys.length > 0) {
    const fetched = await Promise.all(missingKeys.map(async (k) => {
      try {
        const r = await r2Fetch(r2Config, "GET", k);
        return r.ok ? await r.json() : null;
      } catch { return null; }
    }));
    fetched.forEach(o => {
      const id = o && (o.orderId || o.id);
      if (id) { map.set(id, o); merged = true; }
    });
  }

  const orders = Array.from(map.values())
    .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
  return { orders, etag, merged };
}

async function loadOrders(r2Config) {
  if (!r2Config) return memoryOrders;
  const { orders, merged } = await readOrdersState(r2Config);
  memoryOrders = orders; // 僅作唯讀快取
  if (merged) {
    // 把獨立訂單檔合併回總表（條件寫入，失敗無妨，下次會再合併）
    await mutateOrders(r2Config, list => list).catch(e => console.warn("合併總表略過:", e.message));
  }
  return orders;
}

// 以「讀取 → 修改 → 條件寫入」方式安全更新總表；衝突 (412) 時重試
async function mutateOrders(r2Config, mutator) {
  if (!r2Config) {
    memoryOrders = mutator([...memoryOrders]);
    return memoryOrders;
  }
  for (let attempt = 0; attempt < 5; attempt++) {
    const { orders, etag } = await readOrdersState(r2Config);
    const next = mutator(orders);
    const cond = etag ? { "If-Match": etag } : {};
    const res = await r2Fetch(r2Config, "PUT", "orders.json", next, cond);
    if (res.ok) { memoryOrders = next; return next; }
    if (res.status === 412) { await sleep(80 + Math.random() * 220); continue; }
    throw new Error(`R2 PUT orders.json 失敗: ${res.status}`);
  }
  throw new Error("訂單同時被多人修改，請稍後再試");
}

// 寫入獨立訂單檔；失敗會丟出錯誤
async function saveSingleOrder(r2Config, order) {
  if (!r2Config) return;
  const orderId = order.orderId || order.id;
  const res = await r2Fetch(r2Config, "PUT", `orders/${orderId}.json`, order);
  if (!res.ok) throw new Error(`R2 PUT orders/${orderId}.json 失敗: ${res.status}`);
}

async function deleteSingleOrder(r2Config, orderId) {
  if (!r2Config) return;
  try {
    await r2Fetch(r2Config, "DELETE", `orders/${orderId}.json`);
  } catch (err) {
    console.warn("deleteSingleOrder 雲端通知:", err.message);
  }
}

// ─────────────────────────────────────────────────────────
// 格式化訂單結構
// ─────────────────────────────────────────────────────────
function normalizeOrder(data, customId = null) {
  const orderId = customId || data.orderId || data.id || `YG-${Date.now().toString().slice(-4)}`;
  const formattedItems = (data.items || []).map(item => ({
    id: item.id || "",
    name: item.name || "優格碗",
    price: Number(item.price) || 0,
    qty: Number(item.qty || item.quantity) || 1,
    quantity: Number(item.quantity || item.qty) || 1,
    options: item.options || [],
    addOns: item.addOns || (item.options ? item.options.map(opt => ({ name: opt })) : [])
  }));

  // 伺服器端依品項重新計算金額，避免前端漏傳或竄改
  const itemsSubtotal = formattedItems.reduce((s, it) => s + it.price * it.qty, 0);
  const subtotal = itemsSubtotal || Number(data.subtotal) || 0;
  const discountAmount = Math.min(Math.max(Number(data.discountAmount) || 0, 0), subtotal);
  const total = Math.max(0, subtotal - discountAmount);

  return {
    id: orderId,
    orderId: orderId,
    customerName: data.customerName || "",
    phone: data.phone || data.customerPhone || "",
    customerPhone: data.customerPhone || data.phone || "",
    pickupDate: data.pickupDate || "",
    pickupTime: data.pickupTime || "",
    paymentMethod: data.paymentMethod || "",
    bringEcoBag: data.bringEcoBag !== undefined ? !!data.bringEcoBag : !!data.needBag,
    needBag: data.needBag !== undefined ? !!data.needBag : !!data.bringEcoBag,
    discountCode: data.discountCode || data.couponApplied || "",
    couponApplied: data.couponApplied || data.discountCode || "",
    discountAmount: discountAmount,
    items: formattedItems,
    subtotal: subtotal,
    total: total,
    finalTotal: total,
    totalAmount: total,
    note: data.note || data.notes || "",
    notes: data.notes || data.note || "",
    status: data.status || "new",
    createdAt: data.createdAt || new Date().toISOString(),
    updatedAt: data.updatedAt || new Date().toISOString(),
  };
}

// ─────────────────────────────────────────────────────────
// 發送 Telegram 通知給店家（顧客下單自動即時推播）
// ─────────────────────────────────────────────────────────
async function sendTelegramNotification(order) {
  const tgToken  = (process.env.TELEGRAM_BOT_TOKEN || "").trim();
  const tgChatId = (process.env.TELEGRAM_CHAT_ID || "").trim();
  if (!tgToken || !tgChatId) {
    console.warn("Telegram Token 或 Chat ID 未設定，略過推播");
    return;
  }

  const itemsText = (order.items || []).map((item, idx) =>
    `  ${idx + 1}. ${item.name} × ${item.quantity || item.qty || 1} (NT$${(item.price || 0) * (item.quantity || item.qty || 1)})`
  ).join("\n");

  const phoneStr = order.customerPhone || order.phone || "未留";
  const text =
`🔔【優穀日・新訂單即時通知】

單號：#${order.orderId || order.id}
訂購人：${order.customerName}
聯絡電話：${phoneStr}
📞 點擊通話：tel:${phoneStr}
取餐時間：${order.pickupDate || "今日"} ${order.pickupTime || "盡速"}
付款方式：${order.paymentMethod === "linepay" || order.paymentMethod === "LINE Pay Money" ? "LINE Pay Money" : "現場現金付款"}
${order.bringEcoBag || order.needBag ? "自備餐袋：✅ 是\n" : ""}${order.discountAmount > 0 ? `優惠折抵：-NT$ ${order.discountAmount} (${order.discountCode || ""})\n` : ""}合計金額：NT$ ${order.finalTotal || order.total || 0}

📋 訂購品項：
${itemsText}
${(order.notes || order.note) ? `\n備註：${order.notes || order.note}\n` : ""}
👉 點擊開啟後台接單：
https://yougu-day-order.vercel.app/admin`;

  // 支援多個 Chat ID 或群組 ID（逗號分隔）
  const chatIds = tgChatId.split(/[,;\s]+/).map(s => s.trim()).filter(Boolean);

  await Promise.all(
    chatIds.map(async (cid) => {
      try {
        const res = await fetch(`https://api.telegram.org/bot${tgToken}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: cid, text })
        });
        if (!res.ok) {
          console.warn(`Telegram 推播至 ${cid} 狀態非 200:`, res.status, await res.text());
        } else {
          console.log(`✅ Telegram 成功推播至 ${cid}！`);
        }
      } catch (err) {
        console.warn(`Telegram 推播至 ${cid} 網路錯誤:`, err.message);
      }
    })
  );
}

// ─────────────────────────────────────────────────────────
// 主要 API Handler
// ─────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS,PATCH,DELETE,POST,PUT");
  res.setHeader("Access-Control-Allow-Headers",
    "X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, Authorization");

  if (req.method === "OPTIONS") return res.status(200).end();

  // 顧客只能新增訂單；讀取／修改／刪除須管理員登入
  if (req.method !== "POST" && !requireAdmin(req, res)) return;

  const r2Config   = getR2Config();
  const isR2Active = !!r2Config;

  // ── GET: 取得所有訂單 ──────────────────────────────────
  if (req.method === "GET") {
    try {
      const orders = await loadOrders(r2Config);
      return res.status(200).json({
        success: true,
        count: orders.length,
        orders,
        storage: isR2Active ? "cloudflare-r2" : "memory-fallback"
      });
    } catch (err) {
      console.error("GET 訂單失敗:", err);
      return res.status(503).json({
        success: false,
        message: "雲端訂單暫時無法讀取，請稍後重新整理",
        count: memoryOrders.length,
        orders: memoryOrders,
        storage: "memory-fallback"
      });
    }
  }

  // ── POST: 顧客提交新訂單 ────────────────────────────────
  if (req.method === "POST") {
    const data = req.body;
    if (!data || !data.customerName || !Array.isArray(data.items) || data.items.length === 0) {
      return res.status(400).json({ success: false, message: "請提供完整的顧客資訊與訂單項目" });
    }

    // 數量驗證：必須為 1 ~ MAX_QTY_PER_ITEM 的整數
    for (const it of data.items) {
      const q = Number(it.qty ?? it.quantity);
      if (!Number.isInteger(q) || q < 1 || q > MAX_QTY_PER_ITEM) {
        return res.status(400).json({ success: false, message: `餐點數量不正確（每項 1～${MAX_QTY_PER_ITEM} 份）` });
      }
      it.qty = q;
      it.quantity = q;
    }

    // 以雲端菜單核對品項、價格、是否售完（防止前端竄改）；菜單讀取失敗時不阻擋點餐
    let menuById = null;
    if (r2Config) {
      try {
        const mr = await r2Fetch(r2Config, "GET", "menu.json");
        if (mr.ok) {
          const menu = await mr.json();
          if (Array.isArray(menu) && menu.length > 0) menuById = new Map(menu.map(m => [m.id, m]));
        }
      } catch (e) {
        console.warn("菜單價格核對略過:", e.message);
      }
    }
    if (menuById) {
      for (const it of data.items) {
        const m = menuById.get(it.id);
        if (!m) {
          return res.status(400).json({ success: false, message: `餐點「${it.name || it.id}」已下架或不存在，請重新整理頁面` });
        }
        if (m.available === false) {
          return res.status(400).json({ success: false, message: `餐點「${m.name}」今日已售完，請重新整理頁面` });
        }
        it.price = Number(m.price) || 0;
        it.name = m.name || it.name;
        it.category = m.category;
      }
    }

    // 伺服器端重新計算折扣（不信任前端傳來的 discountAmount）
    const subtotal = data.items.reduce((s, it) => s + (Number(it.price) || 0) * it.qty, 0);
    let discountType = String(data.discountType ?? "");
    if (!discountType) {
      // 相容舊版前端：從優惠名稱推斷
      const code = String(data.discountCode || data.couponApplied || "");
      if (code.includes("20 元") || code.includes("20元")) discountType = "20";
      else if (code.includes("免費")) discountType = "item";
      else discountType = "0";
    }
    let discountAmount = 0;
    if (discountType === "20") {
      discountAmount = 20;
    } else if (discountType === "item") {
      const bowls = data.items.filter(it => menuById ? it.category === "bowls" : true);
      const maxBowl = bowls.reduce((mx, it) => Math.max(mx, Number(it.price) || 0), 0);
      discountAmount = Math.min(maxBowl, MAX_ITEM_DISCOUNT);
    }
    data.discountAmount = Math.min(discountAmount, subtotal);
    data.items.forEach(it => { delete it.category; });

    // 生成防碰撞唯一訂單編號（台灣日期）
    const now        = new Date();
    const timeMs     = now.getTime().toString().slice(-4);
    const randSuffix = Math.random().toString(36).substring(2, 5).toUpperCase();
    const generatedId = `YG-${taiwanMMDD(now)}-${timeMs}${randSuffix}`;
    const newOrder = normalizeOrder(data, generatedId);

    // 1. 寫入獨立訂單檔（必須成功，否則回報失敗，不假裝成功）
    try {
      if (r2Config) await saveSingleOrder(r2Config, newOrder);
      else memoryOrders = [newOrder, ...memoryOrders];
    } catch (err) {
      console.error("POST 訂單儲存失敗:", err);
      return res.status(503).json({ success: false, message: "訂單暫時無法儲存，請稍後再試或直接透過 LINE 訂購" });
    }

    // 2. 合併進總表（失敗無妨：獨立檔已存在，下次讀取時會自動合併）
    if (r2Config) {
      try {
        await mutateOrders(r2Config, list => {
          if (!list.some(o => (o.orderId || o.id) === newOrder.orderId)) list.unshift(newOrder);
          return list;
        });
      } catch (err) {
        console.warn("合併總表失敗（獨立檔已保存）:", err.message);
      }
    }

    // 3. Telegram 通知（await 確保 Vercel 容器釋放前完成發送）
    await sendTelegramNotification(newOrder);

    return res.status(201).json({
      success: true,
      message: "訂單建立成功！已同步至後台與 Telegram",
      order: newOrder,
      storage: isR2Active ? "cloudflare-r2" : "memory-fallback"
    });
  }

  // ── PUT / PATCH: 更新訂單狀態 ────────────────────────────
  if (req.method === "PUT" || req.method === "PATCH") {
    try {
      const { id, orderId, status } = req.body || {};
      const targetId = orderId || id;
      if (!targetId) return res.status(400).json({ success: false, message: "缺少訂單編號" });

      const VALID_STATUSES = ['new', 'preparing', 'ready', 'completed', 'cancelled'];
      if (!status) return res.status(400).json({ success: false, message: '缺少訂單狀態' });
      if (!VALID_STATUSES.includes(status)) {
        return res.status(400).json({ success: false, message: `無效的狀態值：${status}` });
      }

      let updated = null;
      await mutateOrders(r2Config, list => {
        updated = null;
        const o = list.find(x => x.orderId === targetId || x.id === targetId);
        if (o) {
          o.status = status;
          o.updatedAt = new Date().toISOString();
          updated = o;
        }
        return list;
      });
      if (!updated) return res.status(404).json({ success: false, message: `找不到訂單 #${targetId}` });

      try { await saveSingleOrder(r2Config, updated); } catch (e) { console.warn(e.message); }

      return res.status(200).json({
        success: true,
        message: `訂單 #${targetId} 狀態已更新為：${status}`,
        order: updated,
        storage: isR2Active ? "cloudflare-r2" : "memory-fallback"
      });
    } catch (err) {
      console.error("PUT 訂單失敗:", err);
      return res.status(500).json({ success: false, message: "更新訂單失敗", error: err.message });
    }
  }

  // ── DELETE: 刪除訂單 ─────────────────────────────────────
  if (req.method === "DELETE") {
    try {
      const parsedUrl = new URL(req.url || "", "http://localhost");
      const isClearAll = req.query?.all === "true" || parsedUrl.searchParams.get("all") === "true";
      const targetId   = req.query?.id || parsedUrl.searchParams.get("id") ||
        parsedUrl.searchParams.get("orderId") || req.body?.orderId || req.body?.id;

      if (isClearAll) {
        // 先刪獨立檔，再清總表，避免被讀取時合併回來
        if (r2Config) {
          const singleKeys = await listR2Keys(r2Config, "orders/");
          await Promise.all(singleKeys.map(k => r2Fetch(r2Config, "DELETE", k).catch(() => {})));
          const r = await r2Fetch(r2Config, "PUT", "orders.json", []);
          if (!r.ok) throw new Error(`R2 PUT orders.json 失敗: ${r.status}`);
        }
        memoryOrders = [];
        return res.status(200).json({
          success: true, message: "已成功清空所有訂單",
          storage: isR2Active ? "cloudflare-r2" : "memory-fallback"
        });
      }

      if (!targetId) return res.status(400).json({ success: false, message: "缺少欲刪除的訂單編號" });

      // 先刪獨立檔，再從總表移除
      await deleteSingleOrder(r2Config, targetId);
      await mutateOrders(r2Config, list => list.filter(o => o.orderId !== targetId && o.id !== targetId));

      return res.status(200).json({
        success: true, message: `訂單 #${targetId} 已成功刪除`,
        storage: isR2Active ? "cloudflare-r2" : "memory-fallback"
      });
    } catch (err) {
      console.error("DELETE 訂單失敗:", err);
      return res.status(500).json({ success: false, message: "刪除訂單失敗", error: err.message });
    }
  }

  return res.status(405).json({ success: false, message: "Method Not Allowed" });
}
