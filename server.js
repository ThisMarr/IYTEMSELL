import express from "express";
import dotenv from "dotenv";
import crypto from "crypto";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT || 3000);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SECRET_KEY = process.env.BILLPLZ_SECRET_KEY;
const COLLECTION_ID = process.env.BILLPLZ_COLLECTION_ID;
const X_SIGNATURE_KEY = process.env.BILLPLZ_X_SIGNATURE_KEY;
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "");
const SANDBOX = String(process.env.BILLPLZ_SANDBOX).toLowerCase() === "true";

const BILLPLZ_API = SANDBOX
  ? "https://www.billplz-sandbox.com/api/v3"
  : "https://www.billplz.com/api/v3";

const PRODUCT = {
  name: "MM2 Harvester",
  amount: 3800 // RM38.00 in sen
};

// Demo-only idempotency store. Use a real database in production.
const paidBills = new Set();

app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

function requireConfig() {
  const missing = [];
  if (!SECRET_KEY) missing.push("BILLPLZ_SECRET_KEY");
  if (!COLLECTION_ID) missing.push("BILLPLZ_COLLECTION_ID");
  if (!X_SIGNATURE_KEY) missing.push("BILLPLZ_X_SIGNATURE_KEY");
  if (!PUBLIC_BASE_URL) missing.push("PUBLIC_BASE_URL");

  if (missing.length) {
    throw new Error("Missing environment variables: " + missing.join(", "));
  }
}

function hmacSha256(value) {
  return crypto
    .createHmac("sha256", X_SIGNATURE_KEY)
    .update(value, "utf8")
    .digest("hex");
}

// Billplz X-Signature:
// exclude x_signature, sort keys case-insensitively,
// concatenate key+value, join with "|", HMAC-SHA256.
function verifyXSignature(data) {
  if (!data || !data.x_signature || !X_SIGNATURE_KEY) return false;

  const received = String(data.x_signature);

  const source = Object.keys(data)
    .filter((key) => key !== "x_signature")
    .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
    .map((key) => key + (data[key] ?? ""))
    .join("|");

  const expected = hmacSha256(source);

  const a = Buffer.from(received, "utf8");
  const b = Buffer.from(expected, "utf8");

  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function createBill({ name, email }) {
  requireConfig();

  const body = new URLSearchParams({
    collection_id: COLLECTION_ID,
    email,
    name,
    amount: String(PRODUCT.amount),
    description: PRODUCT.name,
    callback_url: `${PUBLIC_BASE_URL}/webhook/billplz`,
    redirect_url: `${PUBLIC_BASE_URL}/payment-complete`
  });

  const response = await fetch(`${BILLPLZ_API}/bills`, {
    method: "POST",
    headers: {
      "Authorization": "Basic " + Buffer.from(`${SECRET_KEY}:`).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body
  });

  const data = await response.json();

  if (!response.ok) {
    console.error("Billplz error:", data);
    throw new Error("Billplz gagal mencipta bill.");
  }

  return data;
}

// Create a RM38 bill.
app.post("/api/create-bill", async (req, res) => {
  try {
    const name = String(req.body.name || "").trim();
    const email = String(req.body.email || "").trim();

    if (name.length < 2 || name.length > 255) {
      return res.status(400).json({ error: "Nama tidak sah." });
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: "Email tidak sah." });
    }

    const bill = await createBill({ name, email });

    // Only send the payment URL to the browser.
    return res.json({
      ok: true,
      billId: bill.id,
      paymentUrl: bill.url,
      amount: PRODUCT.amount
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({
      error: "Tidak dapat mencipta pembayaran sekarang."
    });
  }
});

// Billplz server-to-server callback.
// This should be treated as the source of truth for payment status.
app.post("/webhook/billplz", (req, res) => {
  try {
    if (!verifyXSignature(req.body)) {
      console.warn("Invalid Billplz X-Signature");
      return res.sendStatus(400);
    }

    const bill = req.body;

    if (String(bill.amount) !== String(PRODUCT.amount)) {
      console.warn("Unexpected amount:", bill.amount);
      return res.sendStatus(400);
    }

    if (bill.state === "paid" && String(bill.paid) === "true") {
      if (!paidBills.has(bill.id)) {
        paidBills.add(bill.id);

        console.log(
          `PAID: ${PRODUCT.name} | Bill ${bill.id} | RM38.00 | ${bill.email}`
        );

        // TODO:
        // 1. Save the order in a database.
        // 2. Mark it as paid.
        // 3. Deliver the item using your legitimate fulfillment process.
      }
    }

    return res.sendStatus(200);
  } catch (error) {
    console.error("Webhook error:", error);
    return res.sendStatus(500);
  }
});

// Customer redirect after payment.
// Verify the signature before showing a payment result.
app.get("/payment-complete", (req, res) => {
  const billData = {};

  for (const [key, value] of Object.entries(req.query)) {
    if (key.startsWith("billplz[")) {
      const cleanKey = key.slice(8, -1);
      billData[`billplz${cleanKey}`] = String(value);
    }
  }

  // Billplz redirect parameters arrive as billplz[id], billplz[paid], etc.
  const id = String(req.query["billplz[id]"] || "");
  const paid = String(req.query["billplz[paid]"] || "");
  const paidAt = String(req.query["billplz[paid_at]"] || "");
  const signature = String(req.query["billplz[x_signature]"] || "");

  const redirectPayload = {
    "billplz[id]": id,
    "billplz[paid]": paid
  };

  if (paidAt) redirectPayload["billplz[paid_at]"] = paidAt;

  redirectPayload["billplz[x_signature]"] = signature;

  // Billplz redirect signing uses the parameter names with "billplz"
  // prefix, excluding x_signature.
  let valid = false;
  if (signature && X_SIGNATURE_KEY && id) {
    const source = Object.keys(redirectPayload)
      .filter((key) => key !== "billplz[x_signature]")
      .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
      .map((key) => key.replace(/\[|\]/g, "") + redirectPayload[key])
      .join("|");

    const expected = hmacSha256(source);
    const a = Buffer.from(signature);
    const b = Buffer.from(expected);
    valid = a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  const success = valid && paid === "true";

  res.send(`<!doctype html>
<html lang="ms">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Payment Result</title>
<style>
body{font-family:Arial;background:#090b12;color:white;display:grid;place-items:center;min-height:100vh;margin:0}
.card{background:#111827;padding:30px;border-radius:18px;width:min(90%,480px);text-align:center}
.ok{color:#22c55e}.bad{color:#f87171}a{display:inline-block;margin-top:20px;color:#c4b5fd}
</style>
</head>
<body>
<div class="card">
<h1 class="${success ? "ok" : "bad"}">
${success ? "Payment Berjaya" : "Payment Belum Disahkan"}
</h1>
<p>${success
  ? "Pembayaran RM38.00 telah disahkan oleh tandatangan Billplz."
  : "Jangan anggap pembayaran berjaya hanya berdasarkan redirect. Semak callback/server order status."}</p>
${id ? `<p>Bill ID: ${id}</p>` : ""}
<a href="/">Kembali ke store</a>
</div>
</body>
</html>`);
});

app.listen(PORT, () => {
  console.log(`MM2 Store running on http://localhost:${PORT}`);
  console.log(`Billplz mode: ${SANDBOX ? "SANDBOX" : "PRODUCTION"}`);
});
