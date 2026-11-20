'use strict';
// Detect image type from the file's own bytes (magic numbers), never from the name.
// Supported: JPEG, PNG, GIF, WebP. SVG is intentionally NOT supported (it can carry scripts).

function detectImage(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (buf.readUInt32BE(0) === 0x89504e47 && buf.readUInt32BE(4) === 0x0d0a1a0a) {
    let width = null, height = null;
    if (buf.length >= 24 && buf.toString('ascii', 12, 16) === 'IHDR') {
      width = buf.readUInt32BE(16);
      height = buf.readUInt32BE(20);
    }
    return { mime: 'image/png', ext: 'png', width, height };
  }

  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    const dim = jpegSize(buf);
    return { mime: 'image/jpeg', ext: 'jpg', width: dim ? dim.width : null, height: dim ? dim.height : null };
  }

  // GIF87a / GIF89a
  const head6 = buf.toString('ascii', 0, 6);
  if (head6 === 'GIF87a' || head6 === 'GIF89a') {
    return { mime: 'image/gif', ext: 'gif', width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  }

  // WebP: "RIFF" .... "WEBP"
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    const dim = webpSize(buf);
    return { mime: 'image/webp', ext: 'webp', width: dim ? dim.width : null, height: dim ? dim.height : null };
  }

  return null;
}

function jpegSize(buf) {
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) { i++; continue; }
    const marker = buf[i + 1];
    if (marker === 0xff) { i++; continue; }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
    if (marker === 0xd9 || marker === 0xda) return null; // end / start of scan before a frame header
    const len = buf.readUInt16BE(i + 2);
    const isSOF = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSOF) return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    if (len < 2) return null;
    i += 2 + len;
  }
  return null;
}

function webpSize(buf) {
  if (buf.length < 30) return null;
  const chunk = buf.toString('ascii', 12, 16);
  if (chunk === 'VP8 ') {
    return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
  }
  if (chunk === 'VP8L') {
    const b = buf.readUInt32LE(21);
    return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
  }
  if (chunk === 'VP8X') {
    return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
  }
  return null;
}

module.exports = { detectImage };
