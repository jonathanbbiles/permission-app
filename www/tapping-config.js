/* ============================================================
   PERMISSION — TAPPING TAB CONFIG
   ------------------------------------------------------------
   ONE knob: FEED_URL — the public JSON feed of tapping videos
   published on Jessica's website. The feed is a JSON array of:

     {
       "title":        "…",
       "description":  "…",
       "videoUrl":     "https://youtu.be/ID  (or a Vimeo URL)",
       "thumbnailUrl": "https://…",
       "publishedAt":  "2026-07-12T14:00:00+00:00"
     }

   The endpoint returns [] until Jessica publishes her first video,
   which the app renders as a friendly empty state.

   The app only READS this public feed — video management lives on
   Jessica's website; the app never writes to it.
   ============================================================ */
window.TAPPING_CONFIG = {
  // LIVE public feed (array, Access-Control-Allow-Origin: *, no-store)
  FEED_URL: "https://jessicaleighbiles.com/wp-json/tapping/v1/feed",

  // Cosmetic copy (safe to tweak)
  TITLE: "Tapping",
  SUBTITLE: "Guided EFT tapping with Jessica",
  EMPTY_HEADLINE: "New tapping videos are on the way",
  EMPTY_SUB: "Jessica is preparing gentle guided tapping sessions for you. Check back soon.",
  ERROR_HEADLINE: "Couldn’t load the videos",
  ERROR_SUB: "Please check your connection and try again."
};
