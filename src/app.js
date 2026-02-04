import express from 'express';
import bodyParser from 'body-parser';
import cors from 'cors';
import morgan from 'morgan';
import path from 'path';
import { fileURLToPath } from 'url';
import { securityHeaders, ipBlocker, apiLimiter } from './middleware/security.js';

import authRoutes from './routes/auth.js';
import userRoutes from './routes/users.js';
import providerRoutes from './routes/providers.js';
import channelRoutes from './routes/channels.js';
import streamRoutes from './routes/streams.js';
import xtreamRoutes from './routes/xtream.js';
import epgRoutes from './routes/epg.js';
import systemRoutes from './routes/system.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// Trust Proxy Configuration
if (process.env.TRUST_PROXY) {
  const trustProxy = process.env.TRUST_PROXY;
  if (trustProxy.toLowerCase() === 'true') {
    app.set('trust proxy', true);
  } else if (trustProxy.toLowerCase() === 'false') {
    app.set('trust proxy', false);
  } else if (!isNaN(trustProxy)) {
    app.set('trust proxy', parseInt(trustProxy));
  } else {
    app.set('trust proxy', trustProxy);
  }
}

// Security Middleware
app.use(securityHeaders);

// Middleware
app.use(bodyParser.json());
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS || '*',
  credentials: true
}));

// Logging
morgan.token('url', (req, res) => {
  let url = req.originalUrl || req.url;
  url = url.replace(/\/live\/([^/]+)\/([^/]+)\//, '/live/$1/********.redacted/');
  url = url.replace(/([?&])password=[^&]*/i, '$1password=********');
  return url;
});
app.use(morgan(':method :url :status :response-time ms - :res[content-length]'));

// IP Blocking
app.use(ipBlocker);

// Rate Limiting
app.use('/api', apiLimiter);

// Static Files
app.use(express.static(path.join(__dirname, '../public')));

// Routes
app.use('/api', authRoutes);
app.use('/api', userRoutes);
app.use('/api', providerRoutes);
app.use('/api', channelRoutes);
app.use('/api', epgRoutes);
app.use('/api', systemRoutes);
app.use('/', streamRoutes);
app.use('/', xtreamRoutes);

export default app;
