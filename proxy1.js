"use strict";

import sharp from "sharp";
import pick from "./pick.js";
import superagent from "superagent";
import { availableParallelism } from "os";

// Constants
const DEFAULT_QUALITY = 40;
const MIN_COMPRESS_LENGTH = 1024;
const MIN_TRANSPARENT_COMPRESS_LENGTH = MIN_COMPRESS_LENGTH * 100;
const MAX_HEIGHT = 16383;
const USER_AGENT = "Bandwidth-Hero Compressor";

/**
 * Copies headers from the source response to the target response, logging errors if any.
 * @param {Object} sourceHeaders - The headers from the source response.
 * @param {http.ServerResponse} target - The target response object.
 */
function copyHeaders(source, target) {
  Object.entries(source.headers).forEach(([key, value]) => {
    try {
      target.setHeader(key, value);
    } catch (e) {
      console.error(`Error setting header ${key}: ${e.message}`);
    }
  });
}

/**
 * Determines if image compression should be applied based on request parameters.
 * @param {http.IncomingMessage} req - The incoming HTTP request.
 * @returns {boolean} - Whether compression should be performed.
 */
function shouldCompress(req) {
  const { originType, originSize, webp } = req.params;
  return (
    originType.startsWith("image") &&
    originSize > 0 &&
    !req.headers.range &&
    !(webp && originSize < MIN_COMPRESS_LENGTH) &&
    !(!webp && (originType.endsWith("png") || originType.endsWith("gif")) && originSize < MIN_TRANSPARENT_COMPRESS_LENGTH)
  );
}

/**
 * Redirects the request to the original URL with proper headers.
 * @param {http.IncomingMessage} req - The incoming HTTP request.
 * @param {http.ServerResponse} res - The HTTP response.
 */
function redirect(req, res) {
  if (!res.headersSent) {
    res.writeHead(302, {
      Location: encodeURI(req.params.url),
      "Content-Length": "0",
    });
    ["cache-control", "expires", "date", "etag"].forEach((header) => res.removeHeader(header));
    res.end();
  }
}

/**
 * Compresses and transforms the image according to request parameters.
 * @param {http.IncomingMessage} req - The incoming HTTP request.
 * @param {http.ServerResponse} res - The HTTP response.
 * @param {stream.Readable} input - The input image stream.
 */
/**
 * Compresses and transforms the image according to request parameters.
 * @param {http.IncomingMessage} req - The incoming HTTP request.
 * @param {http.ServerResponse} res - The HTTP response.
 * @param {stream.Readable} input - The input image stream.
 */

const sharpStream = _ => sharp({ animated: false, unlimited: true});
function compress(req, res, input) {
  const format = req.params.webp ? "webp" : "jpeg";
  const sharpInstance = sharpStream();

  // Error handling for the input stream
  input.body.on("error", () => redirect(req, res));

  // Write chunks to the sharp instance
  input.body.on("data", (chunk) => sharpInstance.write(chunk));

  // Process the image after the input stream ends
  input.body.on("end", () => {
    sharpInstance.end();

    // Get metadata and apply transformations
    sharpInstance
      .metadata()
      .then((metadata) => {
        if (metadata.height > 16383) {
          sharpInstance.resize({
            height: 16383,
            withoutEnlargement: true,
          });
        }

        sharpInstance
          .grayscale(req.params.grayscale)
          .toFormat(format, {
            quality: req.params.quality,
            effort: 0,
          });

        setupResponseHeaders(sharpInstance, res, format, req.params.originSize);
        streamToResponse(sharpInstance, res);
      })
      .catch(() => redirect(req, res));
  });


  // Helper to set up response headers
function setupResponseHeaders(sharpInstance, res, format, originSize) {
  sharpInstance.on("info", (info) => {
    res.setHeader("Content-Type", `image/${format}`);
    res.setHeader("Content-Length", info.size);
    res.setHeader("X-Original-Size", originSize);
    res.setHeader("X-Bytes-Saved", originSize - info.size);
    res.statusCode = 200;
  });
}

// Helper to handle streaming data to the response
function streamToResponse(sharpInstance, res) {
  sharpInstance.on("data", (chunk) => {
    if (!res.write(chunk)) {
      sharpInstance.pause();
      res.once("drain", () => sharpInstance.resume());
    }
  });

  sharpInstance.on("end", () => res.end());
  sharpInstance.on("error", () => redirect(req, res));
}
}


/**
 * Main proxy handler for bandwidth optimization.
 * @param {http.IncomingMessage} req - The incoming HTTP request.
 * @param {http.ServerResponse} res - The HTTP response.
 */
async function hhproxy(req, res) {
  let url = req.query.url;
  if (!url) return res.end("bandwidth-hero-proxy");

  req.params = {
    url: decodeURIComponent(url),
    webp: !req.query.jpeg,
    grayscale: req.query.bw != 0,
    quality: parseInt(req.query.l, 10) || DEFAULT_QUALITY,
  };

  if (
    req.headers["via"] === "1.1 bandwidth-hero" &&
    ["127.0.0.1", "::1"].includes(req.headers["x-forwarded-for"] || req.ip)
  ) {
    return redirect(req, res);
  }

  try {
    const response = await superagent.get(req.params.url, {
      headers: {
        ...pick(req.headers, ["cookie", "dnt", "referer", "range"]),
        "user-agent": USER_AGENT,
        "x-forwarded-for": req.headers["x-forwarded-for"] || req.ip,
        via: "1.1 bandwidth-hero",
      },
      maxRedirections: 4,
    });

    copyHeaders(response, res);

  res.setHeader("Content-Encoding", "identity");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  res.setHeader("Cross-Origin-Embedder-Policy", "unsafe-none");

    req.params.originType = response.headers["content-type"] || "";
    req.params.originSize = parseInt(response.headers["content-length"] || "0");

    if (shouldCompress(req)) {
      compress(req, res, response);
    } else {
    res.setHeader("X-Proxy-Bypass", 1);

    ["accept-ranges", "content-type", "content-length", "content-range"].forEach(header => {
      if (response.headers[header]) {
        res.setHeader(header, response.headers[header]);
      }
    });

   return response.body.pipe(res);
  }
  } catch (err) {
    if (err.status === 404 || err.response?.headers?.location) {
      redirect(req, res);
    } else {
      res.status(400).send("Invalid URL");
      console.error(err);
    }
  }
}

export default hhproxy;
