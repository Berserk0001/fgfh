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
  for (const [key, value] of Object.entries(source.headers)) {
    try {
      target.setHeader(key, value);
    } catch (e) {
      console.log(e.message);
    }
  }
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

/**
 * Compresses and transforms the image according to request parameters.
 * @param {http.IncomingMessage} req - The incoming HTTP request.
 * @param {http.ServerResponse} res - The HTTP response.
 * @param {stream.Readable} input - The input image stream.
 */
function compress(req, res, input) {
  const format = req.params.webp ? "webp" : "jpeg";
  const sharpInstance = sharp(input, {
    unlimited: true,
    failOn: "none",
    limitInputPixels: false,
  });

  sharp.cache(false);
  sharp.simd(false);
  sharp.concurrency(availableParallelism());

  sharpInstance
    .metadata()
    .then((metadata) => {
      if (metadata.height > MAX_HEIGHT) {
        sharpInstance.resize({
          width: null,
          height: MAX_HEIGHT,
          withoutEnlargement: true,
        });
      }
      return sharpInstance
        .grayscale(req.params.grayscale)
        .toFormat(format, { quality: req.params.quality, effort: 0 })
        .toBuffer();
    })
    .then((outputBuffer) => {
  res.setHeader('content-type', 'image/' + format);
  res.setHeader('content-length', info.size);
  res.setHeader('x-original-size', req.params.originSize);
  res.setHeader('x-bytes-saved', req.params.originSize - info.size);
  res.status(200);
  res.write(outputBuffer);
  res.end();
    })
    .catch(() => redirect(req, res));
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
    let response = await superagent.get(req.params.url, {
      headers: {
        ...pick(req.headers, ["cookie", "dnt", "referer", "range"]),
        "user-agent": USER_AGENT,
        "x-forwarded-for": req.headers["x-forwarded-for"] || req.ip,
        via: "1.1 bandwidth-hero",
      },
      maxRedirections: 4,
    });

  copyHeaders(response, res);
  res.setHeader("content-encoding", "identity");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  res.setHeader("Cross-Origin-Embedder-Policy", "unsafe-none");
  req.params.originType = response.headers["content-type"] || "";
  req.params.originSize = parseInt(response.headers["content-length"] || "0");

    if (shouldCompress(req)) {
      compress(req, res, response.body);
    } else {
    /*
     * Downloading then uploading the buffer to the client is not a good idea though,
     * It would better if you pipe the incomming buffer to client directly.
     */

    res.setHeader("x-proxy-bypass", 1);

    for (const headerName of ["accept-ranges", "content-type", "content-length", "content-range"]) {
      if (headerName in response.headers)
        res.setHeader(headerName, response.headers[headerName]);
    }

    return response.body.pipe(res);
  }
  } catch (err) {
    if (err.code === "ERR_INVALID_URL") {
    res.statusCode = 400;
    return res.end("Invalid URL");
  }

  redirect(req, res);
  console.error(err);
}
  }

export default hhproxy;
