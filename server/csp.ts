/**
 * The Content-Security-Policy sent with the page in production (server/index.ts). The page injects
 * sanitised Wikipedia and web page HTML; this is the second line of defence should anything get
 * past the sanitisers: no scripts, plugins, forms or remote loads but our own. 'wasm-unsafe-eval'
 * lets Loro compile its WebAssembly; inline styles are allowed because Preact sets style attributes.
 * Images come only from the app itself (the media routes proxy every picture in article text).
 *
 * Two things load from elsewhere, and only after the reader clicks a video's play control
 * (src/core/video.ts): the video file itself, straight from its https address (media-src), and
 * the two embedded players this app frames, YouTube's privacy-enhanced one and Vimeo's (frame-src).
 */
export const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src https:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "frame-src https://www.youtube-nocookie.com https://player.vimeo.com",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");
