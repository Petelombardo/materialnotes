const Redis = require('ioredis');

let redisClient;
let redisSubscriber;
let redisPublisher;

const createRedisClient = () => {
  const config = {
    host: process.env.REDIS_HOST || 'localhost',
    port: process.env.REDIS_PORT || 6379,
    password: process.env.REDIS_PASSWORD || undefined,
    db: process.env.REDIS_DB || 0,
    retryDelayOnFailover: 100,
    maxRetriesPerRequest: 3,
    lazyConnect: true,
    keepAlive: 30000,
    family: 4,
    connectTimeout: 10000,
    commandTimeout: 5000
  };

  if (process.env.REDIS_URL) {
    return new Redis(process.env.REDIS_URL);
  }

  return new Redis(config);
};

const initializeRedis = async () => {
  try {
    // Main client for general operations
    redisClient = createRedisClient();
    
    // Separate clients for pub/sub (Redis requirement)
    redisSubscriber = createRedisClient();
    redisPublisher = createRedisClient();

    // Connect all clients
    await Promise.all([
      redisClient.connect(),
      redisSubscriber.connect(),
      redisPublisher.connect()
    ]);

    console.log('✅ Redis clients connected successfully');

    // Handle connection events
    redisClient.on('error', (err) => console.error('Redis Client Error:', err));
    redisSubscriber.on('error', (err) => console.error('Redis Subscriber Error:', err));
    redisPublisher.on('error', (err) => console.error('Redis Publisher Error:', err));

    redisClient.on('connect', () => console.log('Redis client connected'));
    redisClient.on('ready', () => console.log('Redis client ready'));

    return { redisClient, redisSubscriber, redisPublisher };
  } catch (error) {
    console.error('❌ Failed to initialize Redis:', error);
    // Fallback to memory-based operations for development
    console.log('⚠️ Falling back to memory-based operations');
    return { redisClient: null, redisSubscriber: null, redisPublisher: null };
  }
};

const getRedisClients = () => ({
  redisClient,
  redisSubscriber,
  redisPublisher
});

const closeRedisConnections = async () => {
  try {
    await Promise.all([
      redisClient?.disconnect(),
      redisSubscriber?.disconnect(),
      redisPublisher?.disconnect()
    ]);
    console.log('✅ Redis connections closed');
  } catch (error) {
    console.error('❌ Error closing Redis connections:', error);
  }
};

module.exports = {
  initializeRedis,
  getRedisClients,
  closeRedisConnections
};
