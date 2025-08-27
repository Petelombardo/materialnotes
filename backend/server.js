const express = require('express');
const cors = require('cors');
const passport = require('passport');
const session = require('express-session');
const RedisStore = require('connect-redis').default;
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const fs = require('fs-extra');
const http = require('http');
const { Server } = require('socket.io');
const { initializeRedis, getRedisClients, closeRedisConnections } = require('./config/redis');
const batchingManager = require('./utils/batchingManager');
const clientSyncTracker = require('./utils/clientSyncTracker');
require('dotenv').config();

// Development logging utility
const isDevelopment = process.env.NODE_ENV !== 'production';
const devLog = (...args) => {
  if (isDevelopment) {
    console.log(...args);
  }
};

const app = express();
const server = http.createServer(app);

// Trust proxy for rate limiting behind nginx
app.set('trust proxy', true);

// PORT with fallback
const PORT = process.env.PORT || 3001;

// Parse CORS origins from environment variable
const parseWebSocketCorsOrigins = () => {
  const envOrigins = process.env.WEBSOCKET_CORS_ORIGINS;
  
  if (envOrigins) {
    // Split by comma and trim whitespace
    return envOrigins.split(',').map(origin => origin.trim()).filter(origin => origin);
  }
  
  // Fallback origins if environment variable is not set
  const fallbackOrigins = [
    'http://localhost:3000',
    'http://localhost:3002', 
    'http://localhost:8080'
  ];
  
  devLog('⚠️ WEBSOCKET_CORS_ORIGINS not found in environment, using fallback origins:', fallbackOrigins);
  return fallbackOrigins;
};

// Get CORS origins from environment
const corsOrigins = parseWebSocketCorsOrigins();
devLog('🌐 Using CORS origins:', corsOrigins);

// Initialize Redis before starting server
let redisClient;
let io;

const startServer = async () => {
  try {
    // Initialize Redis
    const { redisClient: client } = await initializeRedis();
    redisClient = client;

    // Initialize Socket.IO with environment-based CORS configuration
    io = new Server(server, {
      cors: {
        origin: corsOrigins,
        methods: ['GET', 'POST'],
        credentials: true
      },
      // Enable WebSocket transport and fallbacks
      transports: ['websocket', 'polling'],
      // Use environment variables for ping settings with fallbacks
      pingTimeout: parseInt(process.env.WEBSOCKET_PING_TIMEOUT) || 60000,
      pingInterval: parseInt(process.env.WEBSOCKET_PING_INTERVAL) || 25000
    });

    devLog('🔌 Socket.IO configured with:');
    devLog('   - CORS origins:', corsOrigins);
    devLog('   - Ping timeout:', io.engine.opts.pingTimeout);
    devLog('   - Ping interval:', io.engine.opts.pingInterval);

    // Configure batching manager with Socket.IO instance
    batchingManager.setSocketIO(io);

    // Security middleware
    app.use(helmet({
      contentSecurityPolicy: {
        directives: {
          ...helmet.contentSecurityPolicy.getDefaultDirectives(),
          "connect-src": ["'self'", "ws:", "wss:"],
        },
      },
    }));

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

    // CORS configuration using environment variable
    app.use(cors({
      origin: corsOrigins,
      credentials: true
    }));

    devLog('🌐 Express CORS configured with origins:', corsOrigins);


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
      devLog('✅ Using Redis session store');
    } else {
      devLog('⚠️ Using memory session store (not recommended for production)');
    }

    app.use(session(sessionConfig));

    // Passport middleware
    app.use(passport.initialize());
    app.use(passport.session());

    // Passport configuration
    const configurePassport = require('./config/passport');
    configurePassport(passport);

    // Make io instance available to routes
    app.set('io', io);

    // Routes with rate limiting
    app.use('/auth', require('./routes/auth'));
    app.use('/api/notes', require('./routes/notes'));
    app.use('/api/sharing', require('./routes/sharing'));

    // Apply collaboration rate limiting to specific endpoints
    app.use('/api/notes/:noteId/presence', collaborationLimiter);
    app.use('/api/notes/:noteId/updates', collaborationLimiter);

    // Enhanced health check with environment info
    app.get('/health', (req, res) => {
      res.json({ 
        status: 'OK', 
        timestamp: new Date().toISOString(),
        redis: redisClient ? 'connected' : 'disconnected',
        websocket: process.env.WEBSOCKET_ENABLED === 'true' ? 'enabled' : 'disabled',
        corsOrigins: corsOrigins,
        nodeEnv: process.env.NODE_ENV || 'development',
        port: PORT
      });
    });

    // Enhanced WebSocket authentication middleware with better error handling
    io.use(async (socket, next) => {
      try {
        const token = socket.handshake.auth.token || socket.handshake.headers.authorization?.replace('Bearer ', '');
        
        if (!token) {
          return next(new Error('Authentication token required'));
        }

        const jwt = require('jsonwebtoken');
        let decoded;
        
        try {
          decoded = jwt.verify(token, process.env.JWT_SECRET || 'fallback-secret');
        } catch (jwtError) {
          if (jwtError.name === 'TokenExpiredError') {
            return next(new Error('Token expired'));
          }
          return next(new Error('Invalid token'));
        }
        
        // Validate required user data fields
        if (!decoded.id) {
          return next(new Error('Invalid token: missing user ID'));
        }
        
        
        // Look up full user data from users.json (same as Passport JWT strategy)
        const usersFile = path.join(__dirname, 'data/users.json');
        const users = await fs.readJson(usersFile).catch(() => ({}));
        const fullUser = users[decoded.id];
        
        if (!fullUser) {
          throw new Error(`User ${decoded.id} not found in users database`);
        }
        
        socket.userId = decoded.id;
        socket.user = {
          id: fullUser.id,
          name: fullUser.name || fullUser.email?.split('@')[0] || `User-${decoded.id.slice(-6)}`,
          email: fullUser.email || 'unknown@example.com',
          avatar: fullUser.avatar || null
        };
        
        devLog('👤 WebSocket user authenticated:', socket.user.name);
        
        // Generate unique connection ID to handle multiple devices
        socket.connectionId = `${decoded.id}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        
        next();
      } catch (error) {
        console.error('❌ WebSocket authentication failed:', error.message);
        next(new Error(`Authentication failed: ${error.message}`));
      }
    });

    // Enhanced WebSocket connection handling with better user identity management
    io.on('connection', async (socket) => {
      devLog(`🔌 User connected: ${socket.user.name} (${socket.userId}) [${socket.connectionId}]`);
      
      // CRITICAL FIX: Clean up old connections for this user to prevent standby/resume duplicates
      try {
        const collaborationManager = require('./utils/collaborationManager');
        await collaborationManager.cleanupAllUserConnections(socket.userId, socket.connectionId);
      } catch (error) {
        console.error('❌ Error cleaning up old connections on connect:', error);
      }

      // Handle joining a note for collaboration
      socket.on('join-note', async (data) => {
        try {
          const { noteId } = data;
          
          if (!noteId) {
            socket.emit('error', { message: 'Note ID required' });
            return;
          }

          // Join socket room for the note
          socket.join(`note:${noteId}`);
          
          // Add to collaboration manager with connection-specific data
          const collaborationManager = require('./utils/collaborationManager');
          await collaborationManager.addActiveEditor(noteId, socket.connectionId, {
            userId: socket.userId,
            name: socket.user.name,
            email: socket.user.email,
            avatar: socket.user.avatar,
            socketId: socket.id,
            connectionId: socket.connectionId,
            deviceType: socket.handshake.headers['user-agent']?.includes('Mobile') ? 'mobile' : 'desktop'
          });

          // Get current active editors
          const activeEditors = await collaborationManager.getActiveEditors(noteId);
          
          // Notify all users in the note about presence change
          io.to(`note:${noteId}`).emit('presence-changed', {
            noteId,
            activeEditors,
            action: 'join',
            user: {
              ...socket.user,
              connectionId: socket.connectionId
            }
          });

          socket.emit('join-note-success', { 
            noteId, 
            activeEditors,
            connectionId: socket.connectionId,
            message: 'Successfully joined note collaboration' 
          });

          devLog(`👥 User ${socket.user.name} joined note ${noteId} collaboration`);
        } catch (error) {
          console.error('❌ Error joining note:', error);
          socket.emit('error', { message: 'Failed to join note collaboration', details: error.message });
        }
      });

      // Handle leaving a note
      socket.on('leave-note', async (data) => {
        try {
          const { noteId } = data;
          
          if (!noteId) {
            socket.emit('error', { message: 'Note ID required' });
            return;
          }

          // Leave socket room
          socket.leave(`note:${noteId}`);
          
          // Remove from collaboration manager using connectionId
          const collaborationManager = require('./utils/collaborationManager');
          await collaborationManager.removeActiveEditor(noteId, socket.connectionId);

          // Get updated active editors
          const activeEditors = await collaborationManager.getActiveEditors(noteId);
          
          // Notify remaining users about presence change
          io.to(`note:${noteId}`).emit('presence-changed', {
            noteId,
            activeEditors,
            action: 'leave',
            user: {
              ...socket.user,
              connectionId: socket.connectionId
            }
          });

        } catch (error) {
          console.error('❌ Error leaving note:', error);
        }
      });

      // Handle real-time note updates
      socket.on('note-update', async (data) => {
        try {
          const { noteId, updates, timestamp } = data;
          
          if (!noteId || !updates) {
            socket.emit('error', { message: 'Note ID and updates required' });
            return;
          }

          // Add to server-side batching queue for persistence
          await batchingManager.addUpdate(noteId, updates, socket.user);

          // Broadcast update to all other users editing this note (except sender)
          const updateData = {
            noteId,
            updates,
            timestamp,
            editor: socket.user,
            connectionId: socket.connectionId,
            updatedAt: new Date().toISOString()
          };
          
          
          socket.to(`note:${noteId}`).emit('note-updated', updateData);

        } catch (error) {
          console.error('Error handling note update:', error);
          socket.emit('error', { message: 'Failed to broadcast note update' });
        }
      });

      // Handle heartbeat/presence updates
      socket.on('heartbeat', async (data) => {
        try {
          const { noteId } = data;
          
          if (noteId) {
            const collaborationManager = require('./utils/collaborationManager');
            await collaborationManager.updateEditorLastSeen(noteId, socket.connectionId);
          }

          socket.emit('heartbeat-ack', { 
            timestamp: new Date().toISOString(),
            status: 'active',
            connectionId: socket.connectionId
          });
        } catch (error) {
          console.error('❌ Error handling heartbeat:', error);
        }
      });

      // Handle bulk sync requests (for mobile app resume scenarios)
      socket.on('bulk-sync-request', async (data) => {
        try {
          const { noteTimestamps } = data;
          
          if (!noteTimestamps || typeof noteTimestamps !== 'object') {
            socket.emit('error', { message: 'Invalid noteTimestamps format' });
            return;
          }

          // This would typically trigger the existing bulk sync logic
          // For now, just acknowledge the request
          socket.emit('bulk-sync-response', {
            message: 'Bulk sync request received',
            timestamp: new Date().toISOString(),
            notesCount: Object.keys(noteTimestamps).length
          });

        } catch (error) {
          console.error('Error handling bulk sync:', error);
          socket.emit('error', { message: 'Bulk sync request failed' });
        }
      });

      // Handle disconnection
      socket.on('disconnect', async (reason) => {
        devLog(`🔌 User disconnected: ${socket.user.name} [${socket.connectionId}] - ${reason}`);
        
        try {
          // Clean up presence from all notes this connection was editing
          const collaborationManager = require('./utils/collaborationManager');
          const fileLockManager = require('./utils/fileLock');
          
          // Get all rooms this socket was in
          const rooms = Array.from(socket.rooms);
          const noteRooms = rooms.filter(room => room.startsWith('note:'));
          
          for (const room of noteRooms) {
            const noteId = room.replace('note:', '');
            await collaborationManager.removeActiveEditor(noteId, socket.connectionId);
            
            // CRITICAL: Release file locks when connection is lost to prevent stuck locks
            try {
              const lockStatus = await fileLockManager.checkLock(noteId);
              
              if (lockStatus.locked && lockStatus.userId === socket.userId) {
                await fileLockManager.releaseLock(noteId, socket.userId);
              }
            } catch (lockError) {
              console.error(`❌ Error releasing lock for note ${noteId}:`, lockError);
            }
            
            // Get updated active editors
            const activeEditors = await collaborationManager.getActiveEditors(noteId);
            
            // Notify remaining users
            socket.to(room).emit('presence-changed', {
              noteId,
              activeEditors,
              action: 'disconnect',
              user: {
                ...socket.user,
                connectionId: socket.connectionId
              }
            });
          }
        } catch (error) {
          console.error('❌ Error during disconnect cleanup:', error);
        }
      });

      // Handle errors
      socket.on('error', (error) => {
        console.error(`❌ WebSocket error for user ${socket.user.name} [${socket.connectionId}]:`, error);
      });
      
      // Send connection confirmation with user info (with circuit breaker)
      const connectionConfirmation = {
        user: socket.user,
        connectionId: socket.connectionId,
        timestamp: new Date().toISOString()
      };
      
      // EMERGENCY: Stronger server-side circuit breaker for connection confirmations
      if (socket._connectionConfirmedCount === undefined) {
        socket._connectionConfirmedCount = 0;
        socket._connectionConfirmedStartTime = Date.now();
      }
      
      const now = Date.now();
      const timeWindow = 60000; // 1 minute window
      const maxEventsPerWindow = 2; // Only 2 connection confirmations per minute per socket
      
      // Reset counter if window expired
      if (now - socket._connectionConfirmedStartTime > timeWindow) {
        socket._connectionConfirmedCount = 0;
        socket._connectionConfirmedStartTime = now;
      }
      
      // Block if too many events in current window
      if (socket._connectionConfirmedCount >= maxEventsPerWindow) {
        console.log(`🚫 [SERVER EMERGENCY BREAKER] Blocked connection-confirmed for ${socket.user.name} - limit exceeded (${socket._connectionConfirmedCount}/${maxEventsPerWindow})`);
        return;
      }
      
      // Also check rapid succession (less than 2 seconds)
      if (socket._lastConnectionConfirmed && (now - socket._lastConnectionConfirmed < 2000)) {
        console.log(`🚫 [SERVER CIRCUIT BREAKER] Rapid connection-confirmed blocked for ${socket.user.name} (${now - socket._lastConnectionConfirmed}ms ago)`);
        return;
      }
      
      socket._connectionConfirmedCount++;
      socket._lastConnectionConfirmed = now;
      
      socket.emit('connection-confirmed', connectionConfirmation);
    });

    // Error handling middleware
    app.use((err, req, res, next) => {
      console.error(err.stack);
      res.status(500).json({ error: 'Something went wrong!' });
    });

    // Graceful shutdown
    process.on('SIGTERM', async () => {
      console.log('SIGTERM received, shutting down gracefully');
      
      // Flush all pending batches before shutdown
      await batchingManager.flushAll();
      
      // Close WebSocket connections
      io.close(() => {
        console.log('WebSocket server closed');
      });
      
      await closeRedisConnections();
      process.exit(0);
    });

    process.on('SIGINT', async () => {
      console.log('SIGINT received, shutting down gracefully');
      
      // Flush all pending batches before shutdown
      await batchingManager.flushAll();
      
      // Close WebSocket connections
      io.close(() => {
        console.log('WebSocket server closed');
      });
      
      await closeRedisConnections();
      process.exit(0);
    });

    // Initialize client sync tracker for enhanced conflict detection
    try {
      await clientSyncTracker.initialize();
      devLog('📊 Client sync tracker initialized');
      
      // Set up periodic cleanup (every 24 hours)
      setInterval(async () => {
        try {
          await clientSyncTracker.cleanupOldEntries();
        } catch (error) {
          console.warn('⚠️ Client sync tracker cleanup failed:', error.message);
        }
      }, 24 * 60 * 60 * 1000);
      
    } catch (error) {
      console.warn('⚠️ Client sync tracker initialization failed, continuing without it:', error.message);
    }

    server.listen(PORT, () => {
      console.log(`🚀 Server running on port ${PORT} (${process.env.NODE_ENV || 'development'})`);
      devLog(`🔡 WebSocket server enabled: ${process.env.WEBSOCKET_ENABLED === 'true'}`);
      devLog(`🔄 Redis: ${redisClient ? 'Connected' : 'Disconnected'}`);
      devLog(`🌐 CORS origins: ${corsOrigins.join(', ')}`);
    });

  } catch (error) {
    console.error('❌ Failed to start server:', error);
    process.exit(1);
  }
};

startServer();