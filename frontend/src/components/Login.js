import React, { useEffect, useState } from 'react';
import {
  Box,
  Paper,
  Typography,
  Button,
  Container,
  Stack,
  Alert
} from '@mui/material';
import { Google, Microsoft, WifiOff } from '@mui/icons-material';
import api from '../utils/api';
import offlineStorage from '../utils/offlineStorage';

const Login = () => {
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  const [hasOfflineData, setHasOfflineData] = useState(false);

  useEffect(() => {
    // Check if we have any cached user data or notes
    checkOfflineData();
    
    // Listen for online/offline events
    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);
    
    api.addEventListener('online', handleOnline);
    api.addEventListener('offline', handleOffline);
    
    return () => {
      api.removeEventListener('online', handleOnline);
      api.removeEventListener('offline', handleOffline);
    };
  }, []);

  const checkOfflineData = async () => {
    try {
      const cachedUser = await offlineStorage.getUserData('currentUser');
      const cacheStats = await offlineStorage.getCacheStats();
      
      if (cachedUser && cacheStats.cachedNotes > 0) {
        setHasOfflineData(true);
      }
    } catch (error) {
      console.error('Failed to check offline data:', error);
    }
  };

  const handleGoogleLogin = () => {
    if (!isOnline) {
      alert('You need an internet connection to sign in.');
      return;
    }
    window.location.href = '/auth/google';
  };

  const handleMicrosoftLogin = () => {
    if (!isOnline) {
      alert('You need an internet connection to sign in.');
      return;
    }
    window.location.href = '/auth/microsoft';
  };

  const handleOfflineAccess = async () => {
    try {
      // Try to validate cached token and user data
      const token = localStorage.getItem('token');
      const cachedUser = await offlineStorage.getUserData('currentUser');
      
      if (token && cachedUser && api.isTokenValid(token)) {
        // Force app to recognize the cached user
        api.api.defaults.headers.common['Authorization'] = `Bearer ${token}`;
        window.location.reload();
      } else {
        alert('No valid offline authentication found. Please connect to the internet to sign in.');
      }
    } catch (error) {
      console.error('Offline access failed:', error);
      alert('Failed to access offline data. Please connect to the internet to sign in.');
    }
  };

  return (
    <Container maxWidth="sm">
      <Box
        sx={{
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Paper
          elevation={3}
          sx={{
            p: 4,
            width: '100%',
            maxWidth: 400,
            textAlign: 'center',
          }}
        >
          <Typography variant="h4" component="h1" gutterBottom color="primary">
            Material Notes
          </Typography>
          <Typography variant="subtitle1" color="text.secondary" sx={{ mb: 4 }}>
            Sign in to access your notes
          </Typography>

          {!isOnline && (
            <Alert severity="warning" sx={{ mb: 3 }}>
              <Typography variant="body2">
                You're currently offline. Authentication requires an internet connection.
              </Typography>
            </Alert>
          )}

          <Stack spacing={2}>
            <Button
              variant="outlined"
              size="large"
              startIcon={<Google />}
              onClick={handleGoogleLogin}
              disabled={!isOnline}
              sx={{
                borderColor: '#4285f4',
                color: isOnline ? '#4285f4' : 'text.disabled',
                '&:hover': isOnline ? {
                  borderColor: '#3367d6',
                  backgroundColor: 'rgba(66, 133, 244, 0.04)',
                } : {},
              }}
            >
              Continue with Google
            </Button>

            <Button
              variant="outlined"
              size="large"
              startIcon={<Microsoft />}
              onClick={handleMicrosoftLogin}
              disabled={!isOnline}
              sx={{
                borderColor: '#00a1f1',
                color: isOnline ? '#00a1f1' : 'text.disabled',
                '&:hover': isOnline ? {
                  borderColor: '#0078d4',
                  backgroundColor: 'rgba(0, 161, 241, 0.04)',
                } : {},
              }}
            >
              Continue with Microsoft
            </Button>

            {!isOnline && hasOfflineData && (
              <>
                <Typography variant="body2" color="text.secondary" sx={{ mt: 2, mb: 1 }}>
                  or
                </Typography>
                <Button
                  variant="contained"
                  size="large"
                  startIcon={<WifiOff />}
                  onClick={handleOfflineAccess}
                  color="secondary"
                  sx={{ mt: 1 }}
                >
                  Access Offline Notes
                </Button>
                <Typography variant="caption" color="text.secondary">
                  Use previously cached notes and data
                </Typography>
              </>
            )}
          </Stack>

          <Typography variant="caption" color="text.secondary" sx={{ mt: 3, display: 'block' }}>
            {isOnline ? 
              'Secure authentication powered by OAuth 2.0' :
              'Connect to the internet to sign in or access cached notes offline'
            }
          </Typography>
        </Paper>
      </Box>
    </Container>
  );
};

export default Login;