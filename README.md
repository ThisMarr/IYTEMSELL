# MM2 Harvester Store + Billplz

Produk: MM2 Harvester
Harga: RM38.00

## 1. Keperluan
- Node.js 18+ (Node 20+ disyorkan)
- Akaun Billplz Sandbox untuk ujian
- Collection ID
- Secret Key
- X Signature Key

## 2. Setup
```bash
npm install
```

Salin `.env.example` kepada `.env`, kemudian isi:
- BILLPLZ_SECRET_KEY
- BILLPLZ_COLLECTION_ID
- BILLPLZ_X_SIGNATURE_KEY
- PUBLIC_BASE_URL

Untuk ujian:
`BILLPLZ_SANDBOX=true`

## 3. Jalankan
```bash
npm start
```

Buka:
http://localhost:3000

## 4. Webhook
Billplz perlu boleh mencapai:
`https://DOMAIN-ANDA/webhook/billplz`

Untuk ujian local, gunakan public HTTPS tunnel seperti ngrok dan set:
`PUBLIC_BASE_URL=https://URL-TUNNEL-ANDA`

## 5. Production
- Guna HTTPS.
- Tukar sandbox credentials kepada production credentials.
- Jangan commit `.env`.
- Simpan order/payment status dalam database.
- Kekalkan X Signature verification.
- Jangan anggap redirect browser sebagai bukti pembayaran; callback server ialah sumber status utama.
