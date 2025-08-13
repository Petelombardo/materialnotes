const GoogleStrategy = require('passport-google-oauth20').Strategy;
const MicrosoftStrategy = require('passport-microsoft').Strategy;
const JwtStrategy = require('passport-jwt').Strategy;
const ExtractJwt = require('passport-jwt').ExtractJwt;
const fs = require('fs-extra');
const path = require('path');

module.exports = (passport) => {
  // Serialize user
  passport.serializeUser((user, done) => {
    done(null, user.id);
  });

  passport.deserializeUser(async (id, done) => {
    try {
      const usersFile = path.join(__dirname, '../data/users.json');
      const users = await fs.readJson(usersFile).catch(() => ({}));
      const user = Object.values(users).find(u => u.id === id);
      done(null, user);
    } catch (error) {
      done(error, null);
    }
  });

  // Google OAuth Strategy
  passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL: process.env.GOOGLE_CALLBACK_URL || "http://localhost:3000/auth/google/callback"
  }, async (accessToken, refreshToken, profile, done) => {
    try {
      const usersFile = path.join(__dirname, '../data/users.json');
      const users = await fs.readJson(usersFile).catch(() => ({}));
      
      let user = users[profile.id];
      if (!user) {
        user = {
          id: profile.id,
          name: profile.displayName,
          email: profile.emails[0].value,
          provider: 'google',
          avatar: profile.photos[0].value
        };
        users[profile.id] = user;
        await fs.ensureDir(path.dirname(usersFile));
        await fs.writeJson(usersFile, users);
        
        // Create user notes directory
        await fs.ensureDir(path.join(__dirname, '../data/notes', user.id));
      }
      
      return done(null, user);
    } catch (error) {
      return done(error, null);
    }
  }));

  // Microsoft OAuth Strategy
  passport.use(new MicrosoftStrategy({
    clientID: process.env.MICROSOFT_CLIENT_ID,
    clientSecret: process.env.MICROSOFT_CLIENT_SECRET,
    callbackURL: process.env.MICROSOFT_CALLBACK_URL || "http://localhost:3000/auth/microsoft/callback",
    scope: ['user.read']
  }, async (accessToken, refreshToken, profile, done) => {
    try {
      const usersFile = path.join(__dirname, '../data/users.json');
      const users = await fs.readJson(usersFile).catch(() => ({}));
      
      let user = users[profile.id];
      if (!user) {
        user = {
          id: profile.id,
          name: profile.displayName,
          email: profile.emails[0].value,
          provider: 'microsoft',
          avatar: profile.photos?.[0]?.value || null
        };
        users[profile.id] = user;
        await fs.ensureDir(path.dirname(usersFile));
        await fs.writeJson(usersFile, users);
        
        // Create user notes directory
        await fs.ensureDir(path.join(__dirname, '../data/notes', user.id));
      }
      
      return done(null, user);
    } catch (error) {
      return done(error, null);
    }
  }));

  // JWT Strategy
  passport.use(new JwtStrategy({
    jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
    secretOrKey: process.env.JWT_SECRET
  }, async (payload, done) => {
    try {
      const usersFile = path.join(__dirname, '../data/users.json');
      const users = await fs.readJson(usersFile).catch(() => ({}));
      const user = users[payload.id];
      
      if (user) {
        return done(null, user);
      }
      return done(null, false);
    } catch (error) {
      return done(error, false);
    }
  }));
};
