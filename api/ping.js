export default function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "no-store");
  return res.status(200).json({
    status: "ok",
    message: "優穀日系統正常運行中",
    timestamp: new Date().toISOString()
  });
}
