const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const compression = require('compression');
const cookieParser = require('cookie-parser');
require('dotenv').config();

// ============================================================
// ROUTE IMPORTS
// ============================================================
const authRoutes = require('./routes/authRoutes');
const accountRoutes = require("./routes/accountRoutes");
const managementRoutes = require("./routes/managementRoutes");
const openingBalanceRoutes = require("./routes/openingBalanceRoutes");
const calendarRoutes = require("./routes/calendarRoutes");

const app = express();

// ============================================================
// ENVIRONMENT
// ============================================================
const isDevelopment = process.env.NODE_ENV === 'development';

// ============================================================
// MIDDLEWARE
// ============================================================

// Helmet — relaxed for development so Expo web / mobile
// can talk to the API without cross-origin blocking.
app.use(
    helmet({
        crossOriginResourcePolicy: { policy: 'cross-origin' },
        crossOriginEmbedderPolicy: false,
        contentSecurityPolicy: false,
    })
);

// ------------------------------------------------------------
// CORS
// ------------------------------------------------------------
const allowedOrigins = process.env.FRONTEND_URL
    ? process.env.FRONTEND_URL.split(',').map((url) => url.trim())
    : ['http://localhost:8081'];

app.use(
    cors({
        origin: function (origin, callback) {
            // Allow requests with no origin (mobile apps, curl, Postman)
            if (!origin) return callback(null, true);

            // In development, allow all origins
            if (isDevelopment) {
                return callback(null, true);
            }

            if (allowedOrigins.indexOf(origin) !== -1) {
                return callback(null, true);
            }

            console.log('Blocked origin:', origin);
            return callback(new Error('Not allowed by CORS'));
        },
        credentials: true,
        methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
        allowedHeaders: ['Content-Type', 'Authorization', 'Cookie'],
    })
);

app.use(compression());
app.use(morgan('dev'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// ============================================================
// HEALTH CHECK
// ============================================================
app.get('/health', (req, res) => {
    res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// ============================================================
// ROUTES
// ============================================================
app.use('/api/auth', authRoutes);
app.use("/api/accounts", accountRoutes);
app.use("/api/management", managementRoutes);
app.use("/api/opening-balance", openingBalanceRoutes);
app.use("/api", calendarRoutes);

// ============================================================
// 404 HANDLER
// ============================================================
app.use((req, res) => {
    res.status(404).json({ success: false, message: 'Route not found' });
});

// ============================================================
// GLOBAL ERROR HANDLER
// ============================================================
app.use((err, req, res, next) => {
    console.error('Error:', err.stack);
    res.status(500).json({ success: false, message: 'Something went wrong!' });
});

module.exports = app;