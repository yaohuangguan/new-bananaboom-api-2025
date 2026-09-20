// Never load application .env files or connect to external services in tests.
process.env.NODE_ENV = 'test';
process.env.MONGO_URI = 'mongodb://127.0.0.1:27017/orion_test_unused';
process.env.SECRET_JWT = 'orion-test-only-jwt-secret';
process.env.ADMIN_RESET_SECRET = 'orion-test-only-reset-secret';
process.env.GEMINI_API_KEY = 'test-placeholder';
delete process.env.PROXY_URL;
