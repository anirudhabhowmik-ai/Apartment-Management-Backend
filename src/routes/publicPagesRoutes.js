const express = require('express');
const router = express.Router();

router.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Apartment Management</title>
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <style>
        body { font-family: -apple-system, sans-serif; max-width: 720px; margin: 40px auto; padding: 20px; line-height: 1.6; color: #222; }
        h1 { color: #1a3d7c; }
        h2 { color: #1a3d7c; margin-top: 32px; }
        a { color: #1a3d7c; }
        nav a { margin-right: 16px; }
      </style>
    </head>
    <body>
      <h1>Apartment Management</h1>
      <p>Apartment Management is a mobile application for landlords, apartment owners, and housing societies in India. Track tenants, generate rent bills, record payments, and manage maintenance — all from your phone.</p>

      <h2>Our Plans</h2>
      <ul>
        <li><b>Free</b> — up to 10 properties</li>
        <li><b>Pro</b> — ₹249/month or ₹2,490/year</li>
        <li><b>Business</b> — ₹1,049/month or ₹9,490/year</li>
      </ul>

      <h2>Contact</h2>
      <p>Email: <a href="mailto:anirudhabhowmikbuba123@gmail.com">anirudhabhowmikbuba123@gmail.com</a></p>
      <p>Developer: Anirudha Bhowmik</p>

      <nav>
        <a href="/privacy">Privacy Policy</a>
        <a href="/terms">Terms of Service</a>
        <a href="/refund">Refund Policy</a>
      </nav>

      <hr />
      <p><small>© 2026 Apartment Management. All rights reserved.</small></p>
    </body>
    </html>
  `);
});

router.get('/privacy', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head><title>Privacy Policy</title><meta name="viewport" content="width=device-width, initial-scale=1" /></head>
    <body style="font-family:-apple-system, sans-serif; max-width:720px; margin:40px auto; padding:20px; line-height:1.6;">
      <h1>Privacy Policy</h1>
      <p>Last updated: ${new Date().toLocaleDateString()}</p>
      <h2>1. Information We Collect</h2>
      <ul>
        <li>Phone number (for authentication via OTP)</li>
        <li>Name and email address</li>
        <li>Property, tenant, and maintenance records you add</li>
        <li>Device and usage data for diagnostics</li>
      </ul>
      <h2>2. How We Use Your Information</h2>
      <p>We use your data solely to provide and improve the app. We do not sell your personal data.</p>
      <h2>3. Data Storage</h2>
      <p>Your data is stored securely on encrypted servers.</p>
      <h2>4. Third-Party Services</h2>
      <p>We use Google Play Billing for payments and RevenueCat for subscription management.</p>
      <h2>5. Your Rights</h2>
      <p>Contact <a href="mailto:anirudhabhowmikbuba123@gmail.com">anirudhabhowmikbuba123@gmail.com</a> to request data deletion.</p>
      <p><a href="/">← Back to home</a></p>
    </body>
    </html>
  `);
});

router.get('/terms', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head><title>Terms of Service</title><meta name="viewport" content="width=device-width, initial-scale=1" /></head>
    <body style="font-family:-apple-system, sans-serif; max-width:720px; margin:40px auto; padding:20px; line-height:1.6;">
      <h1>Terms of Service</h1>
      <p>Last updated: ${new Date().toLocaleDateString()}</p>
      <h2>1. Acceptance</h2>
      <p>By using Apartment Management, you agree to these Terms.</p>
      <h2>2. Use of Service</h2>
      <p>Use the app only for lawful property management purposes.</p>
      <h2>3. Subscriptions</h2>
      <p>Paid plans (Pro, Business) are billed through Google Play.</p>
      <h2>4. Limitation of Liability</h2>
      <p>The app is provided "as is" without warranty.</p>
      <p><a href="/">← Back to home</a></p>
    </body>
    </html>
  `);
});

router.get('/refund', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head><title>Refund Policy</title><meta name="viewport" content="width=device-width, initial-scale=1" /></head>
    <body style="font-family:-apple-system, sans-serif; max-width:720px; margin:40px auto; padding:20px; line-height:1.6;">
      <h1>Refund Policy</h1>
      <p>Last updated: ${new Date().toLocaleDateString()}</p>
      <p>All subscriptions are purchased through Google Play. Refunds are subject to Google Play's refund policy.</p>
      <p>Email <a href="mailto:anirudhabhowmikbuba123@gmail.com">anirudhabhowmikbuba123@gmail.com</a> for refund questions.</p>
      <p><a href="/">← Back to home</a></p>
    </body>
    </html>
  `);
});

module.exports = router;