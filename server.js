import express from 'express';
import bodyParser from 'body-parser';
import cors from 'cors';
import morgan from 'morgan';
import helmet from 'helmet';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

import { initDatabase } from './src/config/database.js';
import { apiLimiter } from './src/middleware/auth.js';
import { startSyncScheduler } from './src/services/syncService.js';
import { startEpgUpdateScheduler } from './src/services/epgService.js';
import { createDefaultAdmin } from './src/services/authService.js';

import authRoutes from './src/routes/auth.js';
import userRoutes from './src/routes/users.js';
import providerRoutes from './src/routes/providers.js';
import categoryRoutes from './src/routes/categories.js';
import syncRoutes from './src/routes/sync.js';
import epgRoutes from './src/routes/epg.js';
import streamingRoutes from './src/routes/streaming.js';

// Load environment variables
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const PORT = process.env.PORT || 3000;

// Init DB
initDatabase();
await createDefaultAdmin();

// Security Middleware
app.use(helmet({
  contentSecurityPolicy: false, // Allow inline scripts for now
  crossOriginEmbedderPolicy: false
}));

// Middleware
app.use(bodyParser.json());
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS || '*',
  credentials: true
}));
app.use(morgan('dev'));

// Static files
app.use(express.static(path.join(__dirname, 'public')));
app.use('/cache', express.static(path.join(__dirname, 'cache')));

// Rate Limiting for API
app.use('/api', apiLimiter);

// Routes
// Streaming routes (not rate limited globally, or handled inside)
app.use('/', streamingRoutes);

// API routes
app.use('/api', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/providers', providerRoutes);
app.use('/api', categoryRoutes); // categoryRoutes handles /user-categories/* and /users/:id/categories/*
app.use('/api', syncRoutes);
app.use('/api', epgRoutes);

// Start Schedulers
startSyncScheduler();
startEpgUpdateScheduler();

// Start Server
app.listen(PORT, () => {
  console.log(`✅ IPTV-Manager: http://localhost:${PORT}`);
});
