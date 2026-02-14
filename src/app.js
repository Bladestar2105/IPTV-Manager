import express from 'express';
import bodyParser from 'body-parser';
import cors from 'cors';
import morgan from 'morgan';
import path from 'path';
import { fileURLToPath } from 'url';
import { securityHeaders, ipBlocker, apiLimiter } from './middleware/security.js';
import { errorHandler } from './middleware/errorHandler.js';

import authRoutes from './routes/auth.js';
import userRoutes from './routes/users.js';
import providerRoutes from './routes/providers.js';
import channelRoutes from './routes/channels.js';
import streamRoutes from './routes/streams.js';
import xtreamRoutes from './routes/xtream.js';
import epgRoutes from './routes/epg.js';
import systemRoutes from './routes/system.js';
import hdhrRoutes from './routes/hdhr.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// Trust Proxy Configuration
if (process.env.TRUST_PROXY) {
  const trustProxy = process.env.TRUST_PROXY.trim();
  if (trustProxy.toLowerCase() === 'true') {
    app.set('trust proxy', true);
  } else if (trustProxy.toLowerCase() === 'false') {
    app.set('trust proxy', false);
  } else if (/^\d+$/.test(trustProxy)) {
    // Number of hops
    app.set('trust proxy', parseInt(trustProxy, 10));
  } else {
    // IP address, subnet, or comma-separated list
    app.set('trust proxy', trustProxy);
  }
}

// Security Middleware
app.use(securityHeaders);

// Middleware
app.use(bodyParser.json({ limit: '1mb' }));
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS || '*',
  credentials: true
}));

// Logging
morgan.token('url', (req, res) => {
  let url = req.originalUrl || req.url;
  // Redact password in path segments: /live/user/PASS/..., /movie/user/PASS/...,
  // /series/user/PASS/..., /timeshift/user/PASS/..., /live/mpd/user/PASS/...,
  // /live/segment/user/PASS/...
  url = url.replace(/\/(live|movie|series|timeshift)\/((?:mpd|segment)\/)?([^/]+)\/([^/]+)\//, '/$1/$2$3/********/');
  // Redact HDHomeRun token: /hdhr/TOKEN/...
  url = url.replace(/\/hdhr\/([^/]+)/, '/hdhr/********');
  // Redact password in query strings: ?password=xxx or &password=xxx
  url = url.replace(/([?&])password=[^&]*/gi, '$1password=********');
  return url;
});
app.use(morgan(':method :url :status :response-time ms - :res[content-length]'));

// IP Blocking
app.use(ipBlocker);

// Rate Limiting
app.use('/api', apiLimiter);
app.use('/player_api.php', apiLimiter);
app.use('/xmltv.php', apiLimiter);
app.use('/get.php', apiLimiter);

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
app.use('/hdhr', hdhrRoutes);

// Error Handler
app.use(errorHandler);

export default app;
