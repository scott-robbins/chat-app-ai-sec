// src/kalshi-auth.ts
// Kalshi API authentication helper
// Reads KALSHI_PROD_PRIVATE_KEY and KALSHI_PROD_KEY_ID from Cloudflare Worker Secrets

export interface KalshiEnv {
  KALSHI_PROD_PRIVATE_KEY: string;
  KALSHI_PROD_KEY_ID: string;
}

export interface KalshiHeaders {
  'KALSHI-ACCESS-KEY': string;
  'KALSHI-ACCESS-TIMESTAMP': string;
  'KALSHI-ACCESS-SIGNATURE': string;
}

/**
 * Signs a Kalshi API request using RSA-PSS SHA256
 * @param env - Cloudflare Worker env with KALSHI secrets
 * @param method - HTTP method (GET, POST, DELETE, etc.)
 * @param path - API path WITHOUT query string (e.g., /trade-api/v2/portfolio/balance)
 * @returns Object with the three required Kalshi headers
 */
export async function signKalshiRequest(
  env: KalshiEnv,
  method: string,
  path: string
): Promise<KalshiHeaders> {
  // Strip query params from path before signing (Kalshi requirement)
  const pathWithoutQuery = path.split('?')[0];

  // Generate timestamp in milliseconds
  const timestamp = Date.now().toString();

  // Build the message to sign: timestamp + method + path
  const message = timestamp + method + pathWithoutQuery;

  // Import the RSA private key using Web Crypto API
  const privateKey = await importPrivateKey(env.KALSHI_PROD_PRIVATE_KEY);

  // Sign the message with RSA-PSS SHA256
  const signature = await signMessage(privateKey, message);

  return {
    'KALSHI-ACCESS-KEY': env.KALSHI_PROD_KEY_ID,
    'KALSHI-ACCESS-TIMESTAMP': timestamp,
    'KALSHI-ACCESS-SIGNATURE': signature,
  };
}

/**
 * Imports a PEM-formatted RSA private key into Web Crypto API
 */
async function importPrivateKey(pem: string): Promise<CryptoKey> {
  // Strip PEM header/footer and whitespace
  const pemContents = pem
    .replace('-----BEGIN RSA PRIVATE KEY-----', '')
    .replace('-----END RSA PRIVATE KEY-----', '')
    .replace('-----BEGIN PRIVATE KEY-----', '')
    .replace('-----END PRIVATE KEY-----', '')
    .replace(/\s/g, '');

  // Decode base64 to binary
  const binaryDer = base64ToArrayBuffer(pemContents);

  // Import as CryptoKey for RSA-PSS signing
  return await crypto.subtle.importKey(
    'pkcs8',
    binaryDer,
    {
      name: 'RSA-PSS',
      hash: 'SHA-256',
    },
    false,
    ['sign']
  );
}

/**
 * Signs a message using RSA-PSS SHA256 with digest-length salt
 */
async function signMessage(privateKey: CryptoKey, message: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(message);

  const signature = await crypto.subtle.sign(
    {
      name: 'RSA-PSS',
      saltLength: 32, // SHA-256 digest length in bytes
    },
    privateKey,
    data
  );

  // Convert signature ArrayBuffer to base64 string
  return arrayBufferToBase64(signature);
}

/**
 * Helper: Convert base64 string to ArrayBuffer
 */
function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes.buffer;
}

/**
 * Helper: Convert ArrayBuffer to base64 string
 */
function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * Convenience wrapper: makes an authenticated GET request to Kalshi
 */
export async function kalshiGet(
  env: KalshiEnv,
  path: string
): Promise<Response> {
  const baseUrl = 'https://api.elections.kalshi.com';
  const headers = await signKalshiRequest(env, 'GET', path);

  return await fetch(baseUrl + path, {
    method: 'GET',
    headers: headers as unknown as HeadersInit,
  });
}