/**
 * Videos shown in article text (a web page's, Wikipedia's) as a still with a play control: what
 * the server writes into the sanitised HTML and what the browser builds from it when the reader
 * clicks. Shared by server/pageHtml.ts and server/wikiHtml.ts, which emit the facade, and by
 * src/ui/wiki.ts and src/ui/Wiki.tsx, which admit it and play it.
 *
 * The facade is fixed markup, nothing of the page's own:
 *
 *   <figure class="video" data-video="https://…/clip.mp4" data-width="640" data-height="360">
 *     <img src="/api/page/media?u=…" alt="" …>          the still, through the app's image proxy (optional)
 *     <figcaption>…</figcaption>
 *   </figure>
 *
 * or, for an embedded player, `data-embed="youtube" data-id="dQw4w9WgXcQ"` (or vimeo and its
 * digits) in place of data-video; on Wikipedia, `data-file` names the File page that credits it.
 * Nothing in it loads anything from elsewhere: the still comes through the app's own route. Only
 * a click makes a <video controls preload="none"> with that source, or an iframe to the one
 * player address below for that id, built from these checked values and never from page HTML.
 */

export type Embed = "youtube" | "vimeo";

const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;
const VIMEO_ID = /^\d{1,12}$/;
const YOUTUBE_HOSTS = new Set(["www.youtube.com", "youtube.com", "m.youtube.com", "www.youtube-nocookie.com", "youtube-nocookie.com"]);

/** Whether an id is one this player's ids look like (YouTube: 11 of A–Z a–z 0–9 _ -; Vimeo: digits). */
export function validId(embed: string, id: string): embed is Embed {
  return (embed === "youtube" && YOUTUBE_ID.test(id)) || (embed === "vimeo" && VIMEO_ID.test(id));
}

/**
 * The player and the id an embed's address names, or null: youtube.com/embed/ID,
 * youtube-nocookie.com/embed/ID, youtu.be/ID and youtube.com/watch?v=ID; player.vimeo.com/video/ID.
 * An id that does not look like one is no embed at all.
 */
export function embedOf(address: string): { embed: Embed; id: string } | null {
  let u: URL;
  try {
    u = new URL(address);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  const host = u.hostname.toLowerCase();
  const parts = u.pathname.split("/").filter(Boolean);
  let found: { embed: Embed; id: string } | null = null;
  if (YOUTUBE_HOSTS.has(host)) {
    if (parts.length === 2 && parts[0] === "embed") found = { embed: "youtube", id: parts[1] };
    else if (parts.length === 1 && parts[0] === "watch" && u.searchParams.get("v")) found = { embed: "youtube", id: u.searchParams.get("v")! };
  } else if (host === "youtu.be" && parts.length === 1) found = { embed: "youtube", id: parts[0] };
  else if (host === "player.vimeo.com" && parts.length === 2 && parts[0] === "video") found = { embed: "vimeo", id: parts[1] };
  return found && validId(found.embed, found.id) ? found : null;
}

/** The only address a player is ever framed from: YouTube's privacy-enhanced one, or Vimeo's player. */
export function embedSrc(embed: string, id: string): string | null {
  if (!validId(embed, id)) return null;
  return embed === "youtube" ? `https://www.youtube-nocookie.com/embed/${id}` : `https://player.vimeo.com/video/${id}`;
}

/** A YouTube video's still (480×360), shown through the app's image proxy before anything plays. */
export const youtubeStill = (id: string) => `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;

/** The sandbox and permissions an embedded player gets: scripts, its own origin, fullscreen. Nothing else. */
export const PLAYER_SANDBOX = "allow-scripts allow-same-origin allow-presentation";
export const PLAYER_ALLOW = "fullscreen; picture-in-picture";
