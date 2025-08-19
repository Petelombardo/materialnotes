const express = require('express');
const cors = require('cors');
const passport = require('passport');
const session = require('express-session');
const RedisStore = require('connect-redis').default;
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const http = require('http');
const { Server } = require('socket.io');
const { initializeRedis, getRedisClients, closeRedisConnections } = require('./config/redis');
require('dotenv').config();

const app = express();
const server = http.createServer(app);

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
  
  console.log('⚠️ WEBSOCKET_CORS_ORIGINS not found in environment, using fallback origins:', fallbackOrigins);
  return fallbackOrigins;
};

// Get CORS origins from environment
const corsOrigins = parseWebSocketCorsOrigins();
console.log('🌐 Using CORS origins:', corsOrigins);

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

    console.log('🔌 Socket.IO configured with:');
    console.log('   - CORS origins:', corsOrigins);
    console.log('   - Ping timeout:', io.engine.opts.pingTimeout);
    console.log('   - Ping interval:', io.engine.opts.pingInterval);

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

    console.log('🌐 Express CORS configured with origins:', corsOrigins);

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

    // WebSocket authentication middleware
    io.use(async (socket, next) => {
      try {
        const token = socket.handshake.auth.token || socket.handshake.headers.authorization?.replace('Bearer ', '');
        
        if (!token) {
          return next(new Error('Authentication token required'));
        }

        const jwt = require('jsonwebtoken');
        const decoded = jwt.verify(token, process.env.JWT_SECRET || 'fallback-secret');
        
        // Load user data (you might want to implement a user lookup function)
        socket.userId = decoded.id;
        socket.user = {
          id: decoded.id,
          name: decoded.name,
          email: decoded.email,
          avatar: decoded.avatar
        };
        
        console.log(`🔌 WebSocket authenticated: ${socket.user.name} (${socket.userId})`);
        next();
      } catch (error) {
        console.error('WebSocket authentication failed:', error.message);
        next(new Error('Authentication failed'));
      }
    });

    // WebSocket connection handling
    io.on('connection', (socket) => {
      console.log(`🔌 User connected: ${socket.user.name} (${socket.userId})`);

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
          
          // Add to collaboration manager
          const collaborationManager = require('./utils/collaborationManager');
          await collaborationManager.addActiveEditor(noteId, socket.userId, {
            name: socket.user.name,
            avatar: socket.user.avatar,
            socketId: socket.id
          });

          // Get current active editors
          const activeEditors = await collaborationManager.getActiveEditors(noteId);
          
          // Notify all users in the note about presence change
          io.to(`note:${noteId}`).emit('presence-changed', {
            noteId,
            activeEditors,
            action: 'join',
            user: socket.user
          });

          socket.emit('join-note-success', { 
            noteId, 
            activeEditors,
            message: 'Successfully joined note collaboration' 
          });

          console.log(`👥 User ${socket.user.name} joined note ${noteId} collaboration`);
        } catch (error) {
          console.error('Error joining note:', error);
          socket.emit('error', { message: 'Failed to join note collaboration' });
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
          
          // Remove from collaboration manager
          const collaborationManager = require('./utils/collaborationManager');
          await collaborationManager.removeActiveEditor(noteId, socket.userId);

          // Get updated active editors
          const activeEditors = await collaborationManager.getActiveEditors(noteId);
          
          // Notify remaining users about presence change
          io.to(`note:${noteId}`).emit('presence-changed', {
            noteId,
            activeEditors,
            action: 'leave',
            user: socket.user
          });

          console.log(`👥 User ${socket.user.name} left note ${noteId} collaboration`);
        } catch (error) {
          console.error('Error leaving note:', error);
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

          // Broadcast update to all other users editing this note (except sender)
          socket.to(`note:${noteId}`).emit('note-updated', {
            noteId,
            updates,
            timestamp,
            editor: socket.user,
            updatedAt: new Date().toISOString()
          });

          console.log(`📝 Note ${noteId} updated by ${socket.user.name} - broadcasting to collaborators`);
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
            await collaborationManager.updateEditorLastSeen(noteId, socket.userId);
          }

          socket.emit('heartbeat-ack', { 
            timestamp: new Date().toISOString(),
            status: 'active'
          });
        } catch (error) {
          console.error('Error handling heartbeat:', error);
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

          console.log(`📱 Bulk sync requested by ${socket.user.name} for ${Object.keys(noteTimestamps).length} notes`);
        } catch (error) {
          console.error('Error handling bulk sync:', error);
          socket.emit('error', { message: 'Bulk sync request failed' });
        }
      });

      // Handle disconnection
      socket.on('disconnect', async (reason) => {
        console.log(`🔌 User disconnected: ${socket.user.name} (${socket.userId}) - ${reason}`);
        
        try {
          // Clean up presence from all notes this user was editing
          const collaborationManager = require('./utils/collaborationManager');
          
          // Get all rooms this socket was in
          const rooms = Array.from(socket.rooms);
          const noteRooms = rooms.filter(room => room.startsWith('note:'));
          
          for (const room of noteRooms) {
            const noteId = room.replace('note:', '');
            await collaborationManager.removeActiveEditor(noteId, socket.userId);
            
            // Get updated active editors
            const activeEditors = await collaborationManager.getActiveEditors(noteId);
            
            // Notify remaining users
            socket.to(room).emit('presence-changed', {
              noteId,
              activeEditors,
              action: 'disconnect',
              user: socket.user
            });
          }
        } catch (error) {
          console.error('Error during disconnect cleanup:', error);
        }
      });

      // Handle errors
      socket.on('error', (error) => {
        console.error(`WebSocket error for user ${socket.user.name}:`, error);
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
      
      // Close WebSocket connections
      io.close(() => {
        console.log('WebSocket server closed');
      });
      
      await closeRedisConnections();
      process.exit(0);
    });

    process.on('SIGINT', async () => {
      console.log('SIGINT received, shutting down gracefully');
      
      // Close WebSocket connections
      io.close(() => {
        console.log('WebSocket server closed');
      });
      
      await closeRedisConnections();
      process.exit(0);
    });

    server.listen(PORT, () => {
      console.log(`🚀 Server running on port ${PORT}`);
      console.log(`🔡 WebSocket server enabled: ${process.env.WEBSOCKET_ENABLED === 'true'}`);
      console.log(`🔄 Redis: ${redisClient ? 'Connected' : 'Disconnected'}`);
      console.log(`🌐 CORS origins: ${corsOrigins.join(', ')}`);
      console.log(`📧 Environment: ${process.env.NODE_ENV || 'development'}`);
    });

  } catch (error) {
    console.error('❌ Failed to start server:', error);
    process.exit(1);
  }
};

startServer();