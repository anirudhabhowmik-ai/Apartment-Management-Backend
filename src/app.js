// app.js
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const compression = require('compression');
const cookieParser = require('cookie-parser');
require('dotenv').config();

// --- FIREBASE ADMIN INITIALIZATION ---
const { initializeApp, cert } = require('firebase-admin/app');

try {
    let serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    
    // Crucial fix: Replace literal \n with actual line breaks for the private key
    if (serviceAccount.private_key) {
        serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
    }
    
    initializeApp({
        credential: cert(serviceAccount)
    });
    console.log("✅ Firebase Admin initialized successfully");
} catch (error) {
    console.error("❌ Firebase Admin init error:", error.message);
}
// -------------------------------------

const authRoutes = require('./routes/authRoutes');
const firebaseAuthRoutes = require('./routes/firebaseAuthRoutes'); // NEW ROUTE
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
   CORS CONFIGURATION
----------------------------------------------------------- */
const allowedOrigins = process.env.FRONTEND_URL
    ? process.env.FRONTEND_URL
          .split(',')
          .map((url) => url.trim())
          .filter(Boolean)
    : [];

const corsOptions = {
    origin: function (origin, callback) {
        // Allow requests with no origin (like mobile apps, curl, or server-to-server)
        if (!origin) return callback(null, true);
        
        // Allow all in development
        if (isDevelopment) return callback(null, true);
        
        // Check against allowed list
        if (allowedOrigins.includes(origin)) {
            callback(null, true);
        } else {
            console.log('🚫 Blocked origin by CORS:', origin);
            // Do not throw an error, just return false. This prevents the server from crashing
            // and sends a proper CORS rejection header to the browser.
            callback(null, false); 
        }
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Cookie', 'x-app-platform', 'Accept', 'Origin', 'X-Requested-With'],
    exposedHeaders: ['Set-Cookie'],
    optionsSuccessStatus: 200 
};

app.use(cors(corsOptions));

// Explicitly handle preflight requests for all routes (Crucial for POST requests)
app.options('*', cors(corsOptions));

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
----------------------------------------------------------- */
app.use('/', publicPagesRoutes);

/* -----------------------------------------------------------
   API ROUTES
----------------------------------------------------------- */
app.use('/api/auth', authRoutes);
app.use('/api/auth', firebaseAuthRoutes); // NEW FIREBASE ROUTE
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
----------------------------------------------------------- */
app.use((req, res) => {
    res.status(404).json({ success: false, message: 'Route not found' });
});

/* -----------------------------------------------------------
   GLOBAL ERROR HANDLER
----------------------------------------------------------- */
app.use((err, req, res, next) => {
    console.error('Error:', err.stack);

    res.status(err.status || 500).json({
        success: false,
        message: isProduction ? 'Something went wrong!' : err.message,
    });
});

module.exports = app;