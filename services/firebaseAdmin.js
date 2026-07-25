import admin from 'firebase-admin';

let isFirebaseAdminInitialized = false;

const initFirebase = () => {
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    try {
      const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
      });
      isFirebaseAdminInitialized = true;
      console.log('☘️ Firebase Admin SDK initialized successfully');
    } catch (e) {
      console.error('Failed to parse FIREBASE_SERVICE_ACCOUNT service account config:', e);
    }
  } else {
    console.warn('⚠️ FIREBASE_SERVICE_ACCOUNT env key is missing. Admin verification is unavailable. Running in local simulation mode.');
  }
};

const verifyIdToken = async (idToken) => {
  if (isFirebaseAdminInitialized) {
    // Verify real Firebase Token
    const decodedToken = await admin.auth().verifyIdToken(idToken);
    return decodedToken;
  } else {
    // Local Simulation Bypass (If no Firebase admin credentials configured)
    console.log('⚠️ Running Firebase verifyIdToken in Local Mock bypass mode.');
    
    // Simulate token payloads for testing
    if (idToken.startsWith('mock-token-')) {
      const phoneNum = idToken.replace('mock-token-', '');
      return {
        phone_number: phoneNum,
        uid: `mock-uid-${phoneNum}`,
        firebase: {
          sign_in_provider: 'phone'
        }
      };
    }
    throw new Error('Firebase Admin SDK is not initialized. Please pass a valid "mock-token-<phone_number>" for local testing.');
  }
};

export { admin, initFirebase, verifyIdToken };
