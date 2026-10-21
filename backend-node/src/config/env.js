require('dotenv').config();

const env = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port: process.env.PORT || 5000,
  mongoUri: process.env.MONGO_URI || 'mongodb://localhost:27017/shop',
  databaseUrl: process.env.DATABASE_URL || 'postgres://shop:shop@localhost:5432/shop',
  jwtSecret: process.env.JWT_SECRET || 'dev-secret',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '7d',
  aiServiceUrl: process.env.AI_SERVICE_URL || 'http://localhost:8000',
  // Comma-separated list, e.g. "http://localhost:5173,http://localhost:8080"
  corsOrigin: process.env.CORS_ORIGIN || 'http://localhost:5173',

  // Google sign-in: OAuth 2.0 "Web application" client ID from Google Cloud Console
  googleClientId: process.env.GOOGLE_CLIENT_ID || '',

  // Outgoing email (payment OTPs). Without SMTP_HOST, emails are printed to the console.
  smtp: {
    host: process.env.SMTP_HOST || '',
    port: Number(process.env.SMTP_PORT) || 587,
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    from: process.env.MAIL_FROM || 'Veyra <no-reply@veyra.example>',
  },
  otpTtlMinutes: Number(process.env.OTP_TTL_MINUTES) || 5,
};

env.isProduction = env.nodeEnv === 'production';

if (env.isProduction && ['dev-secret', 'change-me'].includes(env.jwtSecret)) {
  throw new Error('Set a strong JWT_SECRET before running in production');
}

module.exports = env;
