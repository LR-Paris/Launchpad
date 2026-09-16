// ---------------------------------------------------------------------------
// safe-zip.js — read a zip entry without believing what the zip says about it.
//
// Every size in a zip's central directory is written by whoever made the zip.
// adm-zip sizes its output buffer from that number (Buffer.alloc(header.size))
// and inflates with no output cap, so an entry that declares "I unpack to 0
// bytes" while carrying a megabyte of deflated zeros still inflates to a
// gigabyte in memory. The entry-count, per-entry and ratio caps in staging.js
// and files.js were all being fed that lie.
//
// The fix is the same in both places: inflate the entry here, with a hard
// maxOutputLength, so the number that decides is the one we measure while
// writing rather than the one the uploader declared.
// ---------------------------------------------------------------------------
const zlib = require('zlib');

const STORED = 0;
const DEFLATED = 8;

class ZipEntryError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'ZipEntryError';
    this.code = code || 'ZIP_ENTRY_REJECTED';
  }
}

// adm-zip keeps the zip "external file attributes". Unix-made zips put st_mode
// in the high 16 bits; Windows-made zips leave them zero. A symlink or a device
// node written out as a regular file is a way out of the folder we are writing
// into, so both extract paths refuse them.
function entryUnixMode(entry) {
  const attr = (entry.header && entry.header.attr) || 0;
  return (attr >>> 16) & 0xffff;
}

function entryFileType(entry) {
  const mode = entryUnixMode(entry);
  if (!mode) return 'regular'; // no unix mode recorded
  const type = mode & 0xF000;
  if (type === 0xA000) return 'symlink';
  if (type === 0x8000) return 'regular';
  if (type === 0x4000) return 'directory';
  if (type === 0x6000 || type === 0x2000) return 'device';
  if (type === 0x1000) return 'fifo';
  if (type === 0xC000) return 'socket';
  if (type === 0) return 'regular';
  return 'special';
}

// Returns the entry's real bytes, or throws ZipEntryError with code
// ZIP_ENTRY_TOO_LARGE the moment the inflated length passes maxBytes. maxBytes
// is what is LEFT of the caller's budget, not the whole budget, so one zip
// cannot spend the same allowance twice.
function readEntryData(entry, maxBytes) {
  const name = entry.entryName;
  const limit = Math.max(0, Number(maxBytes) || 0);

  if (entry.header.encrypted) {
    throw new ZipEntryError(`The zip entry "${name}" is password protected.`, 'ZIP_ENTRY_ENCRYPTED');
  }

  let compressed;
  try {
    compressed = entry.getCompressedData();
  } catch (err) {
    throw new ZipEntryError(`The zip entry "${name}" could not be read (${err.message}).`, 'ZIP_ENTRY_UNREADABLE');
  }

  const method = entry.header.method;
  let data;
  if (method === STORED) {
    // Stored data is its own uncompressed length, so the cap is a comparison.
    if (compressed.length > limit) {
      throw new ZipEntryError(`The zip entry "${name}" is bigger than the size allowance left for this upload.`, 'ZIP_ENTRY_TOO_LARGE');
    }
    data = Buffer.from(compressed);
  } else if (method === DEFLATED) {
    if (compressed.length === 0) {
      data = Buffer.alloc(0);
    } else {
      try {
        data = zlib.inflateRawSync(compressed, { maxOutputLength: limit });
      } catch (err) {
        // zlib stops and raises ERR_BUFFER_TOO_LARGE as soon as the output
        // passes the cap, which is the point: the rest is never allocated.
        if (err && (err.code === 'ERR_BUFFER_TOO_LARGE' || /maxOutputLength|memory|exceed/i.test(err.message || ''))) {
          throw new ZipEntryError(
            `The zip entry "${name}" unpacks to more than the size allowance, which looks like a zip bomb rather than shop content.`,
            'ZIP_ENTRY_TOO_LARGE');
        }
        throw new ZipEntryError(`The zip entry "${name}" is not readable zip data (${err.message}).`, 'ZIP_ENTRY_UNREADABLE');
      }
    }
  } else {
    throw new ZipEntryError(`The zip entry "${name}" uses a compression method this server cannot read.`, 'ZIP_ENTRY_UNREADABLE');
  }

  // adm-zip verified the CRC inside getData(). Reading the entry ourselves
  // would otherwise drop that check, so it is done here against the central
  // directory's value. A zero CRC over no bytes is the ordinary empty file.
  const declaredCrc = entry.header.crc >>> 0;
  if (!(declaredCrc === 0 && data.length === 0)) {
    const actual = zlib.crc32(data) >>> 0;
    if (actual !== declaredCrc) {
      throw new ZipEntryError(`The zip entry "${name}" is damaged: its checksum does not match its contents.`, 'ZIP_ENTRY_CORRUPT');
    }
  }

  return data;
}

module.exports = { readEntryData, entryFileType, entryUnixMode, ZipEntryError, STORED, DEFLATED };
