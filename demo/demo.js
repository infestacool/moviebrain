// Moviebrain demo: answers the app's /api requests with built-in sample data, so the real
// pages run on a static site (GitHub Pages) with no server, Plex or Jellyfin.
//
// Everything here is copyright-free: public-domain titles, facts written for this demo
// in our own words, and a public-domain poster. Goofs are marked as made-up examples.
"use strict";

(() => {
  const DEMO = true;
  const loadedAt = Date.now();
  const params = new URLSearchParams(location.search);
  const idle = params.has("idle"); // show the "Nothing playing" page

  // ---- Titles ---------------------------------------------------------------

  const CHARADE = {
    key: "plex:42:alex", source: "plex", kind: "movie", item_id: "42", media_id: "42",
    title: "Charade", year: 1963, episode: null,
    tagline: "You can expect the unexpected when they get together!",
    imdb_id: "tt0056923", tmdb_id: null, user: "alex", device: "Living Room TV",
    state: "playing", position_ms: 3060000, duration_ms: 6780000,
  };
  const HILLBILLIES = {
    key: "plex:78:jordan", source: "plex", kind: "episode", item_id: "77", media_id: "78",
    title: "The Beverly Hillbillies", year: 1962, tagline: null,
    episode: { title: "The Clampetts Strike Oil", season: 1, number: 1, imdb_id: "tt0522598" },
    imdb_id: "tt0055662", tmdb_id: null, user: "jordan", device: "Bedroom TV",
    state: "playing", position_ms: 1200000, duration_ms: 1560000,
  };

  const fact = (id, text, extra = {}) => ({ id, text, spoiler: false, category: "Uncategorized", interested: 0, voted: 0, ...extra });
  const demoGoof = (id, category, text) => fact(id, `Demo example, not a real goof: ${text}`, { category });

  const TRIVIA = {
    tt0056923: {
      imdb: [
        fact("c1", "Cary Grant and Audrey Hepburn made only one film together, and this is it."),
        fact("c2", "Grant was in his late fifties during filming and worried about romancing a much younger co-star, so the script has Hepburn's character do the pursuing."),
        fact("c3", "Henry Mancini wrote the score. The title song, with lyrics by Johnny Mercer, was nominated for the Academy Award for Best Original Song."),
        fact("c4", "The film was released without a proper copyright notice, which is why it is in the public domain in the United States."),
        fact("c5", "It opened shortly after President Kennedy was assassinated, and lines using the word \"assassinate\" were reportedly re-dubbed."),
        fact("c6", "Much of it was shot on location in Paris, and the opening scenes at a ski resort in the French Alps."),
        fact("c7", "The animated opening titles are by Maurice Binder, best known for the gun-barrel openings of the James Bond films."),
        fact("c8", "It was remade in 2002 as The Truth About Charlie, directed by Jonathan Demme."),
        fact("c9", "The man Regina knows by several names turns out to be a U.S. Treasury agent.", { spoiler: true }),
        fact("c10", "In 2022 it was selected for preservation in the U.S. National Film Registry."),
      ],
      goofs: [
        demoGoof("g1", "Continuity", "a coffee cup is full in one shot and empty in the next."),
        demoGoof("g2", "Crew or equipment visible", "a boom microphone dips into the top of the frame."),
        demoGoof("g3", "Factual errors", "a sign uses a spelling that wasn't in use at the time."),
      ],
      wikipedia: {
        title: "Charade (1963 film)",
        url: "https://en.wikipedia.org/wiki/Charade_(1963_film)",
        intro: ["Charade is a 1963 American romantic comedy thriller directed by Stanley Donen and written by Peter Stone, starring Cary Grant and Audrey Hepburn. (Demo text written for Moviebrain; see the full article on Wikipedia.)"],
        sections: [
          { title: "Production", paragraphs: ["Stanley Donen produced as well as directed. Filming took place largely on location in Paris, with the opening scenes at a ski resort in the French Alps."] },
          { title: "Music", paragraphs: ["Henry Mancini composed the score, and his title song with lyrics by Johnny Mercer earned an Academy Award nomination."] },
          { title: "Legacy", paragraphs: ["Because it was released without a valid copyright notice, the film is in the public domain in the United States. It was remade in 2002 and added to the National Film Registry in 2022."] },
        ],
      },
      omdb: [{
        scope: null, type: "movie", ratings: [], imdb_votes: null,
        awards: "Nominated for 1 Oscar. Won 1 BAFTA Award", box_office: null,
        facts: ["Audrey Hepburn won the BAFTA Award for Best British Actress for this film.", "Directed by Stanley Donen; written by Peter Stone."],
      }],
    },
    tt0055662: {
      imdb: [
        fact("e1", "This is the pilot. It first aired on CBS on September 26, 1962.", { scope: "episode" }),
        fact("e2", "Many first-season episodes, including this one, are in the public domain because their copyrights weren't renewed.", { scope: "episode" }),
        fact("e3", "The episode sets up the whole series: oil is found on the Clampetts' land and the family moves to Beverly Hills.", { scope: "episode" }),
        fact("s1", "The theme, \"The Ballad of Jed Clampett\", was performed by the bluegrass duo Flatt and Scruggs.", { scope: "series" }),
        fact("s2", "The series ran for nine seasons on CBS, from 1962 to 1971.", { scope: "series" }),
        fact("s3", "Buddy Ebsen, who plays Jed, had been cast as the Tin Man in The Wizard of Oz until a reaction to the makeup forced him out.", { scope: "series" }),
        fact("s4", "It was created by Paul Henning, who went on to create Petticoat Junction and Green Acres.", { scope: "series" }),
      ],
      goofs: [
        { ...demoGoof("h1", "Continuity", "a hat changes hands between two shots."), scope: "episode" },
        { ...demoGoof("h2", "Revealing mistakes", "a painted backdrop shows a seam."), scope: "series" },
      ],
      wikipedia: {
        title: "The Beverly Hillbillies",
        url: "https://en.wikipedia.org/wiki/The_Beverly_Hillbillies",
        intro: ["The Beverly Hillbillies is an American sitcom about a rural family who strike oil and move to Beverly Hills. It aired on CBS from 1962 to 1971. (Demo text written for Moviebrain; see the full article on Wikipedia.)"],
        sections: [{ title: "Production", paragraphs: ["Paul Henning created the show, which was among the most-watched programs on American television in its early seasons."] }],
      },
      episode_wikipedia: null,
      omdb: [],
    },
  };

  const OTHER = (title) => ({
    imdb: [fact("o1", `The demo has full facts only for Charade and The Beverly Hillbillies. Install Moviebrain to see trivia for ${title || "anything"} in your own library.`)],
    goofs: [], wikipedia: null, episode_wikipedia: null, omdb: [],
  });

  // ---- People ---------------------------------------------------------------

  const CAST = {
    42: [
      ["p1", "Cary Grant", "Peter Joshua"], ["p2", "Audrey Hepburn", "Regina Lampert"],
      ["p3", "Walter Matthau", "Hamilton Bartholomew"], ["p4", "James Coburn", "Tex Panthollow"],
      ["p5", "George Kennedy", "Herman Scobie"],
    ],
    78: [
      ["p6", "Buddy Ebsen", "Jed Clampett"], ["p7", "Irene Ryan", "Granny"],
      ["p8", "Donna Douglas", "Elly May Clampett"], ["p9", "Max Baer Jr.", "Jethro Bodine"],
    ],
  };
  const LIBRARY = {
    "His Girl Friday": { item_id: "43", title: "His Girl Friday", year: 1940, kind: "movie", episodes: [] },
    "Breakfast at Tiffany's": { item_id: "47", title: "Breakfast at Tiffany's", year: 1961, kind: "movie", episodes: [] },
    "Roman Holiday": { item_id: "46", title: "Roman Holiday", year: 1953, kind: "movie", episodes: [] },
  };
  const PEOPLE = {
    p1: { born: "January 18, 1904", died: "November 29, 1986", library: ["His Girl Friday"],
      bio: "Born Archibald Leach in Bristol, England, he toured as an acrobat and stage performer before moving into films in the 1930s and becoming one of Hollywood's biggest stars.",
      trivia: ["He starred in four films for Alfred Hitchcock, including North by Northwest.", "He received an honorary Academy Award in 1970."] },
    p2: { born: "May 4, 1929", died: "January 20, 1993", library: ["Roman Holiday", "Breakfast at Tiffany's"],
      bio: "A Belgian-born British actress, she won the Academy Award for Best Actress for Roman Holiday and later devoted much of her life to work for UNICEF.",
      trivia: ["She is one of the few people to have won an Emmy, a Grammy, an Oscar and a Tony."] },
    p3: { born: "October 1, 1920", died: "July 1, 2000", library: [], bio: "", trivia: ["He won the Academy Award for Best Supporting Actor for The Fortune Cookie (1966)."] },
    p4: { born: "August 31, 1928", died: "November 18, 2002", library: [], bio: "", trivia: ["He won the Academy Award for Best Supporting Actor for Affliction (1997)."] },
    p5: { born: "February 18, 1925", died: "February 28, 2016", library: [], bio: "", trivia: ["He won the Academy Award for Best Supporting Actor for Cool Hand Luke (1967)."] },
    p6: { born: "April 2, 1908", died: "July 6, 2003", library: ["Breakfast at Tiffany's"], bio: "", trivia: ["He also played Doc Golightly in Breakfast at Tiffany's."] },
    p7: { born: "October 17, 1902", died: "April 26, 1973", library: [], bio: "", trivia: [] },
    p8: { born: "September 26, 1932", died: "January 1, 2015", library: [], bio: "", trivia: ["The pilot first aired on her 30th birthday."] },
    p9: { born: "December 4, 1937", died: null, library: [], bio: "", trivia: [] },
  };

  // ---- Search ---------------------------------------------------------------

  const CATALOG = [
    { imdb_id: "tt0056923", title: "Charade", year: 1963, kind: "movie", stars: "Cary Grant, Audrey Hepburn" },
    { imdb_id: "tt0055662", title: "The Beverly Hillbillies", year: 1962, kind: "tv", stars: "Buddy Ebsen, Irene Ryan" },
    { imdb_id: "tt0032599", title: "His Girl Friday", year: 1940, kind: "movie", stars: "Cary Grant, Rosalind Russell" },
    { imdb_id: "tt0063350", title: "Night of the Living Dead", year: 1968, kind: "movie", stars: "Duane Jones, Judith O'Dea" },
    { imdb_id: "tt0017925", title: "The General", year: 1926, kind: "movie", stars: "Buster Keaton, Marion Mack" },
    { imdb_id: "tt0013442", title: "Nosferatu", year: 1922, kind: "movie", stars: "Max Schreck, Gustav von Wangenheim" },
  ];
  const RECENT = [
    { source: "plex", item_id: "42", media_id: "42", title: "Charade", year: 1963, imdb_id: "tt0056923", tmdb_id: null },
    { source: "plex", item_id: "43", media_id: "43", title: "His Girl Friday", year: 1940, imdb_id: "tt0032599", tmdb_id: null },
    { source: "plex", item_id: "48", media_id: "48", title: "Night of the Living Dead", year: 1968, imdb_id: "tt0063350", tmdb_id: null },
    { source: "plex", item_id: "49", media_id: "49", title: "The General", year: 1926, imdb_id: "tt0017925", tmdb_id: null },
  ];

  // ---- Settings (kept in memory; nothing is saved in the demo) ---------------

  const settings = {
    plex_url: "http://0.0.0.0:32400", plex_token: "", plex_token_set: true,
    jellyfin_url: "", jellyfin_api_key: "", jellyfin_api_key_set: false, users: "",
    include_imdb: true, include_goofs: true, include_wikipedia: true,
    omdb_api_key: "", omdb_api_key_set: true, include_omdb: true,
    tv_episode_facts: true, tv_series_facts: false, hidden_wiki_sections: "", hidden_goof_kinds: "",
    wiki_lang: "en", verify_ssl: true, auth_mode: "none", allowed_users: "", admin_users: "",
    oidc_issuer: "", oidc_client_id: "", oidc_client_secret: "", oidc_client_secret_set: false,
    oidc_name: "Pocket ID", public_url: "",
  };
  const GROUPS = {
    wiki: [["overview", "Overview"], ["production", "Production"], ["music", "Music"], ["release", "Release"], ["reception", "Reception"], ["awards", "Awards"], ["themes", "Themes & analysis"], ["legacy", "Legacy"], ["other", "Other"]],
    goofs: [["continuity", "Continuity"], ["factual", "Factual errors"], ["revealing", "Revealing mistakes"], ["crew", "Crew or equipment visible"], ["plot", "Plot holes"], ["character", "Character errors"], ["notgoofs", "Not really goofs"], ["other", "Other"]],
  };

  function display() {
    const hiddenWiki = settings.hidden_wiki_sections.split(","), hiddenGoofs = settings.hidden_goof_kinds.split(",");
    return {
      sources: { imdb: settings.include_imdb, goofs: settings.include_goofs, wiki: settings.include_wikipedia, omdb: settings.include_omdb },
      scopes: { episode: settings.tv_episode_facts, series: settings.tv_series_facts },
      wiki: Object.fromEntries(GROUPS.wiki.map(([k]) => [k, !hiddenWiki.includes(k)])),
      goofs: Object.fromEntries(GROUPS.goofs.map(([k]) => [k, !hiddenGoofs.includes(k)])),
    };
  }

  // ---- Request handling -----------------------------------------------------

  function nowPlaying() {
    const elapsed = Date.now() - loadedAt;
    const advance = (s) => ({ ...s, position_ms: (s.position_ms + elapsed) % s.duration_ms });
    return { sessions: idle ? [] : [advance(CHARADE), advance(HILLBILLIES)], errors: {}, configured: { plex: true, jellyfin: false } };
  }

  function trivia(q) {
    const id = q.get("imdb");
    const data = TRIVIA[id] || OTHER(q.get("title"));
    const tvShowAlone = q.get("kind") === "tv" && !q.get("season");
    // A show looked up on its own shows its series facts like a movie's.
    const unscope = (items) => (tvShowAlone ? items.filter((i) => i.scope === "series").map(({ scope, ...i }) => i) : items);
    return {
      imdb_id: id, imdb: unscope(data.imdb), goofs: unscope(data.goofs || []), wikipedia: data.wikipedia,
      episode_wikipedia: data.episode_wikipedia || null, omdb: data.omdb, errors: {},
      episode_imdb_id: q.get("season") ? HILLBILLIES.episode.imdb_id : null,
    };
  }

  function person(q) {
    const p = PEOPLE[q.get("id")] || { library: [], trivia: [] };
    return {
      name: q.get("name"), errors: {},
      library: p.library.map((t) => LIBRARY[t]),
      imdb: { imdb_id: null, url: "https://www.imdb.com/find/?q=" + encodeURIComponent(q.get("name") || ""), born: p.born, died: p.died, bio: p.bio, trivia: p.trivia },
    };
  }

  function route(method, path, q, body) {
    switch (path) {
      case "/api/auth/status": return { mode: "none", user: null, admin: true, oidc_name: "Pocket ID" };
      case "/api/display": return display();
      case "/api/now-playing": return nowPlaying();
      case "/api/trivia": return trivia(q);
      case "/api/cast": return { cast: (CAST[q.get("item")] || []).map(([id, name, role]) => ({ id, name, role, photo: null, guest: false })) };
      case "/api/person": return person(q);
      case "/api/recent": return { movies: RECENT };
      case "/api/suggest": {
        const term = (q.get("q") || "").toLowerCase();
        return { results: CATALOG.filter((t) => t.title.toLowerCase().includes(term)) };
      }
      case "/api/settings":
        if (method === "POST") Object.assign(settings, Object.fromEntries(Object.entries(body).filter(([, v]) => v !== "")));
        return method === "POST" ? { ok: true, settings, cleared: [] }
          : { settings, groups: GROUPS, auth_disabled_by_env: false, callback_urls: { plex: location.origin + "/auth/plex/callback", oidc: location.origin + "/auth/oidc/callback" } };
      case "/api/settings/cache": case "/api/settings/cache/clear":
        return { entries: path.endsWith("clear") ? 0 : 24, bytes: path.endsWith("clear") ? 0 : 1468000, max_bytes: 209715200, days: 7 };
      default:
        if (path.startsWith("/api/settings/test/")) return { ok: true, server: "the demo (nothing is really contacted)" };
        return null;
    }
  }

  const realFetch = window.fetch.bind(window);
  window.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url, location.origin);
    if (!url.pathname.startsWith("/api/") && !url.pathname.startsWith("/auth/")) return realFetch(input, init);
    const body = init.body ? JSON.parse(init.body) : {};
    const data = route((init.method || "GET").toUpperCase(), url.pathname, url.searchParams, body);
    await new Promise((r) => setTimeout(r, 120)); // feel like a real request
    return new Response(JSON.stringify(data ?? { detail: "Not in the demo" }), {
      status: data ? 200 : 404, headers: { "content-type": "application/json" },
    });
  };

  window.moviebrainDemo = {
    demo: DEMO,
    image(source, id, kind) {
      // Only Charade has artwork; "data:," fails without a request, so the app shows its fallback.
      return id === "42" ? "static/demo/charade.jpg" : "data:,";
    },
  };
})();
