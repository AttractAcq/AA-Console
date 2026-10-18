export const MAX_CAPTURE_BYTES = 25 * 1024 * 1024;
export function verifyCaptureFile(bytes: Buffer, mime: string): boolean {
  if (!bytes.length || bytes.length > MAX_CAPTURE_BYTES) return false;
  if (mime === "image/png")
    return bytes
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (mime === "image/jpeg")
    return bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if (mime === "image/webp")
    return (
      bytes.toString("ascii", 0, 4) === "RIFF" &&
      bytes.toString("ascii", 8, 12) === "WEBP"
    );
  if (mime === "audio/wav")
    return (
      bytes.toString("ascii", 0, 4) === "RIFF" &&
      bytes.toString("ascii", 8, 12) === "WAVE"
    );
  if (mime === "video/mp4" || mime === "audio/mp4")
    return bytes.toString("ascii", 4, 8) === "ftyp";
  if (mime === "video/webm" || mime === "audio/webm")
    return bytes.subarray(0, 4).equals(Buffer.from([26, 69, 223, 163]));
  if (mime === "audio/mpeg")
    return (
      bytes.toString("ascii", 0, 3) === "ID3" ||
      (bytes[0] === 255 && ((bytes[1] ?? 0) & 224) === 224)
    );
  if (mime === "application/pdf")
    return bytes.toString("ascii", 0, 5) === "%PDF-";
  return false;
}
