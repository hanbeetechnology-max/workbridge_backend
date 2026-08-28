import { ApiError } from "./ApiError.js";

// Dispute evidence is small proof photos (a screenshot, a delivered file),
// not a document vault — capped hard since these live as base64 JSONB on
// the projects row (no object storage exists yet). 3 images, ~4MB decoded
// each (base64 inflates ~33%, so ~5.5MB string) keeps a fully-loaded
// dispute (both sides, both max) well under a sane row size.
const MAX_EVIDENCE_ITEMS = 3;
const MAX_ITEM_STRING_LENGTH = 5_500_000; // ~4MB decoded
const DATA_URL_RE = /^data:image\/(png|jpe?g|webp);base64,/;

// items: [{ dataUrl, caption? }] from the client. Returns a sanitized array
// ready to store, or throws — never silently drops/truncates a bad item,
// since evidence integrity matters here (see WorkerProfile.jsx/BusinessVerification.jsx
// for the same "reject loudly, don't guess" convention on user-submitted proof).
export function validateDisputeEvidence(items) {
  if (items == null) return [];
  if (!Array.isArray(items)) throw ApiError.badRequest("Evidence must be a list of images.");
  if (items.length > MAX_EVIDENCE_ITEMS) throw ApiError.badRequest(`You can attach at most ${MAX_EVIDENCE_ITEMS} evidence images.`);

  return items.map((item, index) => {
    const dataUrl = item?.dataUrl;
    if (typeof dataUrl !== "string" || !DATA_URL_RE.test(dataUrl)) {
      throw ApiError.badRequest(`Evidence image ${index + 1} must be a PNG, JPG, or WEBP.`);
    }
    if (dataUrl.length > MAX_ITEM_STRING_LENGTH) {
      throw ApiError.badRequest(`Evidence image ${index + 1} is too large — keep each under ~4MB.`);
    }
    const caption = typeof item?.caption === "string" ? item.caption.trim().slice(0, 200) : undefined;
    return { dataUrl, caption, uploadedAt: new Date().toISOString() };
  });
}
