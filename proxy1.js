"use strict";
import https from "https";
import sharp from "sharp";
import pick from "./pick.js";
import UserAgent from 'user-agents';
const DEFAULT_QUALITY = 40;
const MIN_COMPRESS_LENGTH = 1024;
const MIN_TRANSPARENT_COMPRESS_LENGTH = MIN_COMPRESS_LENGTH * 100;

// Helper: Should compress
function shouldCompress(req) {
  const { originType, originSize, webp } = req.params;

  if (!originType.startsWith("image")) return false;
  if (originSize === 0) return false;
  if (req.headers.range) return false;
  if (webp && originSize < MIN_COMPRESS_LENGTH) return false;
  if (
    !webp &&
    (originType.endsWith("png") || originType.endsWith("gif")) &&
    originSize < MIN_TRANSPARENT_COMPRESS_LENGTH
  ) {
    return false;
  }

  return true;
}

// Helper: Copy headers
function copyHeaders(source, target) {
  for (const [key, value] of Object.entries(source.headers)) {
    try {
      target.setHeader(key, value);
    } catch (e) {
      console.log(e.message);
    }
  }
}

// Helper: Redirect
function redirect(req, res) {
  if (res.headersSent) return;

  res.setHeader("content-length", 0);
  res.removeHeader("cache-control");
  res.removeHeader("expires");
  res.removeHeader("date");
  res.removeHeader("etag");
  res.setHeader("location", encodeURI(req.params.url));
  res.statusCode = 302;
  res.end();
}

// Helper: Compress;
function compress(req, res, input) {
    const format = req.params.webp ? 'webp' : 'jpeg';
    const transformer = sharp();
    const bufferChunks = [];
    let bufferSize = 0;

    // Pipe the input through sharp transformation
    input.pipe(transformer);

    // Metadata processing to check resizing constraints
    transformer.metadata()
        .then(metadata => {
            // Resize if height exceeds 16383 pixels
            if (metadata.height > 16383) {
                transformer.resize({ height: 16383, width: null });
            }

            // Apply transformations (grayscale, format, quality)
            transformer.grayscale(req.params.grayscale)
                .toFormat(format, {
                    quality: req.params.quality,
                    progressive: true,
                    optimizeScans: true
                });

            // Pipe the transformed data into a buffer collector
            transformer.on('data', chunk => {
                bufferChunks.push(chunk);
                bufferSize += chunk.length;

                // If buffer reaches 1 MB (1,048,576 bytes), send it
                if (bufferSize >= 1048576) {
                    if (!res.headersSent) {
                        res.setHeader('content-type', `image/${format}`);
                        res.setHeader('x-original-size', req.params.originSize);
                    }
                    res.write(Buffer.concat(bufferChunks));
                    bufferChunks.length = 0; // Reset buffer for more data
                    bufferSize = 0; // Reset buffer size
                }
            });

            // When all data is processed, send the remaining buffer
            transformer.on('end', () => {
                if (bufferChunks.length > 0) {
                    res.write(Buffer.concat(bufferChunks));
                }
                res.end(); // End the response
            });

        })
        .catch(err => {
            console.error('Error processing image:', err);
            redirect(req, res);
        });
}

/**
 * Main proxy handler for bandwidth optimization.
 * @param {http.IncomingMessage} req - The incoming HTTP request.
 * @param {http.ServerResponse} res - The HTTP response.
 */
async function hhproxy(req, res) {
  const url = req.query.url;
  if (!url) {
    return res.end("bandwidth-hero-proxy");
  }

  req.params = {
    url: decodeURIComponent(url),
    webp: !req.query.jpeg,
    grayscale: req.query.bw != 0,
    quality: parseInt(req.query.l, 10) || DEFAULT_QUALITY
  };

  const userAgent = new UserAgent();
  const options = {
    headers: {
      ...pick(req.headers, ["cookie", "dnt", "referer", "range"]),
      "User-Agent": userAgent.toString(),
      "X-Forwarded-For": req.headers["x-forwarded-for"] || req.ip,
      Via: "1.1 bandwidth-hero"
    },
    method: 'GET',
    rejectUnauthorized: false,
    maxRedirects: 4
  };

  try {
    https.get(req.params.url, options, function (originRes) {
      _onRequestResponse(originRes, req, res);
    }).on('error', (err) => {
      _onRequestError(req, res, err);
    });
  } catch (err) {
    _onRequestError(req, res, err);
  }
}

function _onRequestError(req, res, err) {
  if (err.code === "ERR_INVALID_URL") {
    res.statusCode = 400;
    return res.end("Invalid URL");
  }

  redirect(req, res);
  console.error(err);
}

function _onRequestResponse(originRes, req, res) {
  if (originRes.statusCode >= 400) {
    return redirect(req, res);
  }

  if (originRes.statusCode >= 300 && originRes.headers.location) {
    req.params.url = originRes.headers.location;
    return redirect(req, res); // Follow the redirect manually
  }

  copyHeaders(originRes, res);

  res.setHeader("Content-Encoding", "identity");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  res.setHeader("Cross-Origin-Embedder-Policy", "unsafe-none");

  req.params.originType = originRes.headers["content-type"] || "";
  req.params.originSize = parseInt(originRes.headers["content-length"] || "0", 10);

  originRes.on('error', _ => req.socket.destroy());

  if (shouldCompress(req)) {
    return compress(req, res, originRes);
  } else {
    res.setHeader("X-Proxy-Bypass", 1);

    ["accept-ranges", "content-type", "content-length", "content-range"].forEach(header => {
      if (originRes.headers[header]) {
        res.setHeader(header, originRes.headers[header]);
      }
    });

    return originRes.pipe(res);
  }
}

export default hhproxy;
