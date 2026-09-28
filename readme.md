Run the server:
node scripts/migrate.js
npm run dev

Database:
https://console.neon.tech/app/projects/delicate-frog-70318827/branches/br-shy-frog-b3vbizun/tables?database=neondb

OTP:
https://control.msg91.com/app/m/l/otp/widgets/update/366966727762363938373131?step=4




In Railway Production env

# ==========================================
# SERVER
# ==========================================
PORT=5000
NODE_ENV=production

# ==========================================
# DATABASE (Neon PostgreSQL — same DB is fine)
# ==========================================
DATABASE_URL="postgresql://neondb_owner:npg_FkKiOsGo3p9L@ep-withered-forest-b33csics-pooler.c-4.ap-southeast-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require"

# ==========================================
# JWT — MUST BE A FRESH STRONG SECRET
# Generate with:
# node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
# ==========================================
JWT_SECRET=68434be4c4d349d3938427b18ddb194a9c2b563c4e6545bb5ee25ab65ffe750d300c2f4b091fccf865aaa93a0befb974
JWT_EXPIRES_IN=7d

# ==========================================
# MSG91 (OTP) — live key
# ==========================================
MSG91_AUTHKEY=568397T7nV94F0eX6a9db9a8P1
OTP_EXPIRY_MINUTES=15
OTP_MAX_ATTEMPTS=3

# ==========================================
# FRONTEND URLS
# Mobile apps DON'T send Origin → this can be EMPTY.
# Only fill this if you have a WEB frontend.
# Example: https://app.yourdomain.com,https://admin.yourdomain.com
# ==========================================
FRONTEND_URL=

# ==========================================
# RAZORPAY — LIVE KEYS (from Razorpay dashboard)
# ==========================================
RAZORPAY_KEY_ID=rzp_live_XXXXXXXXXXXXXX
RAZORPAY_KEY_SECRET=YYYYYYYYYYYYYYYYYYYYYYYY

# ==========================================
# REVENUECAT — production webhook secret
# ==========================================
REVENUECAT_WEBHOOK_SECRET=c036e9a73f28f0a79f9478a07448076921e36350af1d447ed587efb6f787a288


