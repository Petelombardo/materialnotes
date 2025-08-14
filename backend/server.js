const express = require('express');
const cors = require('cors');
const passport = require('passport');
const session = require('express-session');
const RedisStore = require('connect-redis').default;
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const { initializeRedis, getRedisClients, closeRedisConnections } = require('./config/redis');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3001;

// Initialize Redis before starting server
let redisClient;

const startServer = async () => {
  try {
    // Initialize Redis
    const { redisClient: client } = await initializeRedis();
    redisClient = client;

    // Security middleware
    app.use(helmet());

    // Enhanced rate limiting with Redis backing
    const limiter = rateLimit({
      windowMs: 15 * 60 * 1000, // 15 minutes
      max: 1000, // Increased limit
      standardHeaders: true,
      legacyHeaders: false,
      // Use Redis for distributed rate limiting if available
      store: redisClient ? undefined : 'memory', // Redis store auto-configured if available
      message: {
        error: 'Too many requests, please try again later.',
        retryAfter: '15 minutes'
      }
    });

    app.use(limiter);

    // Collaboration-specific rate limiting
    const collaborationLimiter = rateLimit({
      windowMs: 1 * 60 * 1000, // 1 minute
      max: 60, // 60 requests per minute for collaboration endpoints
      standardHeaders: true,
      legacyHeaders: false,
      keyGenerator: (req) => {
        // Rate limit per user for collaboration endpoints
        return req.user?.id || req.ip;
      }
    });

    // CORS configuration
    app.use(cors({
      origin: ['http://localhost:3000', 'http://localhost:8080'],
      credentials: true
    }));

    // Body parsing middleware
    app.use(express.json({ limit: '10mb' }));
    app.use(express.urlencoded({ extended: true }));

    // Session configuration with Redis store
    const sessionConfig = {
      secret: process.env.JWT_SECRET || 'fallback-secret',
      resave: false,
      saveUninitialized: false,
      cookie: {
        secure: process.env.NODE_ENV === 'production',
        httpOnly: true,
        maxAge: 24 * 60 * 60 * 1000 // 24 hours
      }
    };

    // Use Redis store if available, otherwise fall back to memory store
    if (redisClient) {
      sessionConfig.store = new RedisStore({
        client: redisClient,
        prefix: 'notes-session:',
        ttl: 24 * 60 * 60 // 24 hours in seconds
      });
      console.log('✅ Using Redis session store');
    } else {
      console.log('⚠️ Using memory session store (not recommended for production)');
    }

    app.use(session(sessionConfig));

    // Passport middleware
    app.use(passport.initialize());
    app.use(passport.session());

    // Passport configuration
    const configurePassport = require('./config/passport');
    configurePassport(passport);

    // Routes with rate limiting
    app.use('/auth', require('./routes/auth'));
    app.use('/api/notes', require('./routes/notes'));
    app.use('/api/sharing', require('./routes/sharing'));

    // Apply collaboration rate limiting to specific endpoints
    app.use('/api/notes/:noteId/presence', collaborationLimiter);
    app.use('/api/notes/:noteId/updates', collaborationLimiter);

    // Health check
    app.get('/health', (req, res) => {
      res.json({ 
        status: 'OK', 
        timestamp: new Date().toISOString(),
        redis: redisClient ? 'connected' : 'disconnected'
      });
    });

    // Error handling middleware
    app.use((err, req, res, next) => {
      console.error(err.stack);
      res.status(500).json({ error: 'Something went wrong!' });
    });

    // Graceful shutdown
    process.on('SIGTERM', async () => {
      console.log('SIGTERM received, shutting down gracefully');
      await closeRedisConnections();
      process.exit(0);
    });

    process.on('SIGINT', async () => {
      console.log('SIGINT received, shutting down gracefully');
      await closeRedisConnections();
      process.exit(0);
    });

    app.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
      console.log(`Redis: ${redisClient ? 'Connected' : 'Disconnected'}`);
    });

  } catch (error) {
    console.error('❌ Failed to start server:', error);
    process.exit(1);
  }
};

startServer();
