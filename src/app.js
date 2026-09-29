// app.js
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const compression = require('compression');
const cookieParser = require('cookie-parser');
require('dotenv').config();

const authRoutes = require('./routes/authRoutes');
const invitationRoutes = require("./routes/invitationRoutes");
const accountRoutes = require("./routes/accountRoutes");
const managementRoutes = require("./routes/managementRoutes");
const openingBalanceRoutes = require("./routes/openingBalanceRoutes");
const calendarRoutes = require("./routes/calendarRoutes");
const manageAccountProfileRoutes = require("./routes/manageAccountProfileRoutes");
const billRoutes = require("./routes/billRoutes");
const auditRoutes = require("./routes/auditRoutes");
const notificationsRoutes = require("./routes/notificationsRoutes");
const pushRoutes = require("./routes/pushRoutes");
const subscriptionRoutes = require("./routes/subscriptionRoutes");
const revenueCatWebhookRoutes = require("./routes/revenueCatWebhookRoutes");
const publicPagesRoutes = require("./routes/publicPagesRoutes");

const app = express();

// IMPORTANT: Trust proxy (Render/Railway/Fly/Nginx) so req.ip, secure cookies work correctly
app.set('trust proxy', 1);

const isDevelopment = process.env.NODE_ENV === 'development';
const isProduction = process.env.NODE_ENV === 'production';

/* -----------------------------------------------------------
   SECURITY HEADERS
----------------------------------------------------------- */
app.use(
    helmet({
        crossOriginResourcePolicy: { policy: 'cross-origin' },
        crossOriginEmbedderPolicy: false,
        contentSecurityPolicy: false,
    })
);

/* -----------------------------------------------------------
   CORS
   - Mobile apps (no Origin header) are ALWAYS allowed.
   - Web browsers are only allowed if their Origin matches FRONTEND_URL.
   - In development, all origins are allowed for convenience.
----------------------------------------------------------- */
const allowedOrigins = process.env.FRONTEND_URL
    ? process.env.FRONTEND_URL
          .split(',')
          .map((url) => url.trim())
          .filter(Boolean)
    : [];

app.use(
    cors({
        origin: function (origin, callback) {
            if (!origin) return callback(null, true);
            if (isDevelopment) return callback(null, true);
            if (allowedOrigins.includes(origin)) return callback(null, true);
            console.log('Blocked origin:', origin);
            return callback(new Error('Not allowed by CORS'));
        },
        credentials: true,
        methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
        allowedHeaders: ['Content-Type', 'Authorization', 'Cookie'],
        exposedHeaders: ['Set-Cookie'],
    })
);

/* -----------------------------------------------------------
   BODY PARSING
----------------------------------------------------------- */
app.use(compression());
app.use(morgan(isProduction ? 'combined' : 'dev'));

// RevenueCat webhook needs raw body to verify signatures
app.use(
    '/api/webhooks/revenuecat',
    express.raw({ type: 'application/json' })
);

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(cookieParser());

/* -----------------------------------------------------------
   HEALTH CHECK
----------------------------------------------------------- */
app.get('/health', (req, res) => {
    res.json({
        status: 'OK',
        env: process.env.NODE_ENV,
        timestamp: new Date().toISOString(),
    });
});

/* -----------------------------------------------------------
   PUBLIC PAGES (landing, privacy, terms, refund)
   For Razorpay verification + Google Play privacy URL
   NOTE: Mounted at '/' BEFORE any API routes so it takes precedence.
----------------------------------------------------------- */
app.use('/', publicPagesRoutes);

/* -----------------------------------------------------------
   API ROUTES
----------------------------------------------------------- */
app.use('/api/auth', authRoutes);
app.use('/api', invitationRoutes);
app.use('/api', manageAccountProfileRoutes);
app.use('/api/accounts', accountRoutes);
app.use('/api/management', managementRoutes);
app.use('/api/opening-balance', openingBalanceRoutes);
app.use('/api', calendarRoutes);
app.use('/api/accounts/:accountId/bills', billRoutes);
app.use('/api', auditRoutes);
app.use('/api/notifications', notificationsRoutes);
app.use('/api/push', pushRoutes);
app.use('/api', subscriptionRoutes);
app.use('/api/webhooks', revenueCatWebhookRoutes);

/* -----------------------------------------------------------
   404 HANDLER
   IMPORTANT: must come AFTER public pages, so /privacy etc. work.
----------------------------------------------------------- */
app.use((req, res) => {
    res.status(404).json({ success: false, message: 'Route not found' });
});

/* -----------------------------------------------------------
   GLOBAL ERROR HANDLER
----------------------------------------------------------- */
app.use((err, req, res, next) => {
    console.error('Error:', err.stack);

    if (err.message === 'Not allowed by CORS') {
        return res.status(403).json({ success: false, message: 'CORS blocked' });
    }

    res.status(err.status || 500).json({
        success: false,
        message: isProduction ? 'Something went wrong!' : err.message,
    });
});

module.exports = app;