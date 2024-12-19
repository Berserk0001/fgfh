"use strict";
import https from "https";
import sharp from "sharp";
import pick from "./pick.js";
import UserAgent from 'user-agents';

// Configuration constants
const CONFIG = {
  DEFAULT_QUALITY: 40,
  MIN_COMPRESS_LENGTH: 1024,
  MIN_TRANSPARENT_COMPRESS_LENGTH: 1024 * 100,
  MAX_WEBP_HEIGHT: 16383,
  MAX_REDIRECTS: 4,
  MAX_IMAGE_SIZE: 100 * 1024 * 1024, // 100MB max image size
  TIMEOUT: 30000 // 30 seconds timeout
};

/**
 * @typedef {Object} RequestParams
 * @property {string} url - The decoded URL to proxy
 * @property {boolean} webp - Whether to use WebP format
 * @property {boolean} grayscale - Whether to apply grayscale
 * @property {number} quality - Compression quality
 * @property {string} originType - Original content type
 * @property {number} originSize - Original file size
 */

/**
 * Main proxy handler for bandwidth optimization
 * @param {import('http').IncomingMessage} req - The incoming HTTP request
 * @param {import('http').ServerResponse} res - The HTTP response
 * @returns {Promise<void>}
 */
async function hhproxy(req, res) {
  // Input validation
  const url = req.query.url;
  if (!url) {
    res.statusCode = 400;
    return res.end("Missing URL parameter");
  }

  let decodedUrl;
  try {
    decodedUrl = decodeURIComponent(url);
    new URL(decodedUrl); // URL validation
  } catch (err) {
    res.statusCode = 400;
    return res.end("Invalid URL format");
  }

  // Request parameters setup
  const { jpeg, bw, l: quality } = req.query;
  req.params = {
    url: decodedUrl,
    webp: !jpeg,
    grayscale: bw != 0,
    quality: Math.min(Math.max(parseInt(quality, 10) || CONFIG.DEFAULT_QUALITY, 1), 100),
    attempts: 0
  };

  // Request headers setup
  const userAgent = new UserAgent();
  const options = {
    headers: {
      ...pick(req.headers, ["cookie", "dnt", "referer"]),
      "User-Agent": userAgent.toString(),
      "X-Forwarded-For": req.headers["x-forwarded-for"] || req.ip,
      "Via": "1.1 bandwidth-hero",
      "Accept": "image/*,*/*;q=0.8"
    },
    method: 'GET',
    rejectUnauthorized: false,
    timeout: CONFIG.TIMEOUT
  };

  try {
    await makeRequest(req, res, options);
  } catch (err) {
    handleError(req, res, err);
  }
}

/**
 * Makes the HTTP request with proper error handling
 * @param {Object} req - Request object
 * @param {Object} res - Response object
 * @param {Object} options - Request options
 */
function makeRequest(req, res, options) {
  return new Promise((resolve, reject) => {
    const request = https.get(req.params.url, options);

    // Set timeout
    request.setTimeout(CONFIG.TIMEOUT, () => {
      request.destroy();
      reject(new Error('Request timeout'));
    });

    // Handle request error
    request.on('error', (err) => {
      reject(err);
    });

    // Handle response
    request.on('response', (originRes) => {
      handleResponse(originRes, req, res)
        .then(resolve)
        .catch(reject);
    });
  });
}

/**
 * Handles the response from the origin server
 * @param {Object} originRes - Origin response
 * @param {Object} req - Request object
 * @param {Object} res - Response object
 */
async function handleResponse(originRes, req, res) {
  // Handle redirects
  if (originRes.statusCode >= 300 && originRes.statusCode < 400 && originRes.headers.location) {
    if (req.params.attempts >= CONFIG.MAX_REDIRECTS) {
      throw new Error('Too many redirects');
    }
    req.params.attempts++;
    req.params.url = new URL(originRes.headers.location, req.params.url).toString();
    return redirect(req, res);
  }

  // Handle errors
  if (originRes.statusCode >= 400) {
    throw new Error(`Origin server responded with ${originRes.statusCode}`);
  }

  // Setup response headers
  copyHeaders(originRes, res);
  setupResponseHeaders(res);

  // Get content info
  req.params.originType = originRes.headers["content-type"] || "";
  req.params.originSize = parseInt(originRes.headers["content-length"] || "0", 10);

  // Check size limits
  if (req.params.originSize > CONFIG.MAX_IMAGE_SIZE) {
    throw new Error('Image too large');
  }

  // Handle compression
  if (shouldCompress(req)) {
    await compress(req, res, originRes);
  } else {
    bypass(originRes, res);
  }
}

/**
 * Sets up response headers
 * @param {Object} res - Response object
 */
function setupResponseHeaders(res) {
  res.setHeader("Content-Encoding", "identity");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  res.setHeader("Cross-Origin-Embedder-Policy", "unsafe-none");
  res.setHeader("Cache-Control", "public, max-age=31536000");
}

/**
 * Bypasses compression for certain conditions
 * @param {Object} originRes - Origin response
 * @param {Object} res - Response object
 */
function bypass(originRes, res) {
  res.setHeader("X-Proxy-Bypass", "1");
  const headersToKeep = ["accept-ranges", "content-type", "content-length", "content-range"];
  
  headersToKeep.forEach(header => {
    if (originRes.headers[header]) {
      res.setHeader(header, originRes.headers[header]);
    }
  });

  originRes.pipe(res);
}

/**
 * Handles errors in the proxy
 * @param {Object} req - Request object
 * @param {Object} res - Response object
 * @param {Error} err - Error object
 */
function handleError(req, res, err) {
  console.error(`Error processing ${req.params.url}:`, err);

  if (!res.headersSent) {
    if (err.code === "ENOTFOUND" || err.code === "ECONNREFUSED") {
      res.statusCode = 404;
      res.end("Not Found");
    } else if (err.message === 'Request timeout') {
      res.statusCode = 504;
      res.end("Gateway Timeout");
    } else {
      res.statusCode = 500;
      res.end("Internal Server Error");
    }
  }
}

export default hhproxy;
