// Moviebrain demo: answers the app's /api requests with built-in sample data, so the real
// pages run on a static site (GitHub Pages) with no server, Plex or Jellyfin.
//
// Everything here is copyright-free: public-domain titles, facts written for this demo
// in our own words, and public-domain artwork. Goofs are marked as made-up examples.
"use strict";

(() => {
  const DEMO = true;
  const loadedAt = Date.now();
  const params = new URLSearchParams(location.search);
  const idle = params.has("idle"); // show the "Nothing playing" page

  // ---- Titles ---------------------------------------------------------------

  const NOTLD = {
    key: "plex:48:alex", source: "plex", kind: "movie", item_id: "48", media_id: "48",
    title: "Night of the Living Dead", year: 1968, episode: null, tagline: null,
    imdb_id: "tt0063350", tmdb_id: null, user: "alex", device: "Living Room TV",
    state: "playing", position_ms: 2460000, duration_ms: 5760000,
  };
  const ONE_STEP = {
    key: "plex:91:jordan", source: "plex", kind: "episode", item_id: "90", media_id: "91",
    title: "One Step Beyond", year: 1959, tagline: null,
    episode: { title: "The Bride Possessed", season: 1, number: 1, imdb_id: "tt0507807" },
    imdb_id: "tt0052442", tmdb_id: null, user: "jordan", device: "Bedroom TV",
    state: "playing", position_ms: 540000, duration_ms: 1500000,
  };

  const fact = (id, text, extra = {}) => ({ id, text, spoiler: false, category: "Uncategorized", interested: 0, voted: 0, ...extra });
  const demoGoof = (id, category, text, extra = {}) => fact(id, `Demo example, not a real goof: ${text}`, { category, ...extra });

  const TRIVIA = {
    tt0063350: {
      imdb: [
        fact("n1", "George A. Romero shot it in and around Pittsburgh, Pennsylvania, on a budget of roughly $114,000."),
        fact("n2", "Its working title was Night of the Flesh Eaters. When the title changed, the copyright notice was left off the prints, which is why the film is in the public domain."),
        fact("n3", "Romero said he cast Duane Jones as Ben simply because he gave the best audition."),
        fact("n4", "The film never uses the word \"zombie\". The dead are called \"ghouls\"."),
        fact("n5", "Chocolate syrup stood in for blood, which reads convincingly in black and white."),
        fact("n6", "Many of the ghouls were played by Pittsburgh locals and friends of the filmmakers."),
        fact("n7", "Karl Hardman and Marilyn Eastman, who play the Coopers, also helped produce the film and handled much of the makeup."),
        fact("n8", "Ben survives the night, only to be shot by a posse that mistakes him for a ghoul.", { spoiler: true }),
        fact("n9", "It was remade in 1990, directed by makeup artist Tom Savini."),
        fact("n10", "In 1999 it was selected for preservation in the U.S. National Film Registry."),
      ],
      goofs: [
        demoGoof("ng1", "Continuity", "a boarded-up window has one plank fewer in the next shot."),
        demoGoof("ng2", "Crew or equipment visible", "a light stand is reflected in a car window."),
        demoGoof("ng3", "Revealing mistakes", "a ghoul blinks while lying still."),
      ],
      wikipedia: {
        title: "Night of the Living Dead",
        url: "https://en.wikipedia.org/wiki/Night_of_the_Living_Dead",
        intro: ["Night of the Living Dead is a 1968 American independent horror film directed by George A. Romero and written by Romero and John A. Russo, starring Duane Jones and Judith O'Dea. (Demo text written for Moviebrain; see the full article on Wikipedia.)"],
        sections: [
          { title: "Production", paragraphs: ["The film was made by a small group of Pittsburgh filmmakers on a very low budget, shooting on black-and-white film with a cast of local actors and friends."] },
          { title: "Release", paragraphs: ["It premiered in Pittsburgh in October 1968 and became a long-running hit on the midnight-movie circuit."] },
          { title: "Legacy", paragraphs: ["It is widely credited with creating the modern zombie film. Romero followed it with Dawn of the Dead (1978), and the 1968 film was added to the National Film Registry in 1999."] },
        ],
      },
      omdb: [{
        scope: null, type: "movie", ratings: [], imdb_votes: null, awards: null, box_office: null,
        facts: ["Released 1 Oct 1968 · 96 min.", "Directed by George A. Romero; written by John A. Russo and George A. Romero."],
      }],
    },
    tt0052442: {
      imdb: [
        fact("e1", "This is the series premiere, first broadcast on ABC on January 20, 1959.", { scope: "episode" }),
        fact("e2", "Like most of the series, it is widely considered public domain because its copyright wasn't renewed.", { scope: "episode" }),
        fact("e3", "John Newland introduces the story and returns at the end to talk about it.", { scope: "episode" }),
        fact("s1", "Each episode dramatizes a story presented as a true account of the paranormal.", { scope: "series" }),
        fact("s2", "John Newland hosted every episode and directed most of them.", { scope: "series" }),
        fact("s3", "It aired on ABC from 1959 to 1961, sponsored by Alcoa, under the title Alcoa Presents: One Step Beyond.", { scope: "series" }),
        fact("s4", "A revival, The Next Step Beyond, aired in 1978 with Newland back as host.", { scope: "series" }),
      ],
      goofs: [
        demoGoof("og1", "Continuity", "a candle is taller in the close-up than in the wide shot.", { scope: "episode" }),
        demoGoof("og2", "Revealing mistakes", "a painted backdrop shows a seam.", { scope: "series" }),
      ],
      wikipedia: {
        title: "One Step Beyond (TV series)",
        url: "https://en.wikipedia.org/wiki/One_Step_Beyond_(TV_series)",
        intro: ["One Step Beyond is an American anthology series of supposedly true stories of the paranormal, hosted by John Newland. It aired on ABC from 1959 to 1961. (Demo text written for Moviebrain; see the full article on Wikipedia.)"],
        sections: [{ title: "Production", paragraphs: ["Each half-hour episode is introduced by Newland, who also directed most of the series."] }],
      },
      episode_wikipedia: null,
      omdb: [],
    },
    tt0056923: {
      imdb: [
        fact("c1", "Cary Grant and Audrey Hepburn made only one film together, and this is it."),
        fact("c2", "Henry Mancini wrote the score. The title song, with lyrics by Johnny Mercer, was nominated for the Academy Award for Best Original Song."),
        fact("c3", "The film was released without a proper copyright notice, which is why it is in the public domain in the United States."),
      ],
      goofs: [], wikipedia: null, episode_wikipedia: null, omdb: [],
    },
  };

  const OTHER = (title) => ({
    imdb: [fact("o1", `The demo has full facts only for Night of the Living Dead and One Step Beyond. Install Moviebrain to see trivia for ${title || "anything"} in your own library.`)],
    goofs: [], wikipedia: null, episode_wikipedia: null, omdb: [],
  });

  // ---- People ---------------------------------------------------------------

  const CAST = {
    48: [
      ["p1", "Duane Jones", "Ben"], ["p2", "Judith O'Dea", "Barbra"], ["p3", "Karl Hardman", "Harry Cooper"],
      ["p4", "Marilyn Eastman", "Helen Cooper"], ["p5", "Keith Wayne", "Tom"], ["p6", "Judith Ridley", "Judy"],
      ["p7", "Kyra Schon", "Karen Cooper"], ["p8", "Russell Streiner", "Johnny"],
    ],
    91: [["p9", "John Newland", "Host"]],
    42: [["p10", "Cary Grant", "Peter Joshua"], ["p11", "Audrey Hepburn", "Regina Lampert"]],
  };
  const LIBRARY = {
    "Charade": { item_id: "42", title: "Charade", year: 1963, kind: "movie", episodes: [] },
    "His Girl Friday": { item_id: "43", title: "His Girl Friday", year: 1940, kind: "movie", episodes: [] },
    "Ganja & Hess": { item_id: "50", title: "Ganja & Hess", year: 1973, kind: "movie", episodes: [] },
    "One Step Beyond": { item_id: "90", title: "One Step Beyond", year: 1959, kind: "show", episodes: ["S01E01 · The Bride Possessed"] },
  };
  const PEOPLE = {
    p1: { born: "April 11, 1937", died: "July 22, 1988", library: ["Ganja & Hess"],
      bio: "Ben was his first major film role. He worked mostly in theater afterwards, as an actor, teacher and director.",
      trivia: ["Romero said he got the part simply by giving the best audition."] },
    p2: { born: "April 20, 1945", died: null, library: [], bio: "", trivia: ["Johnny's teasing line to her in the cemetery became one of horror's most quoted."] },
    p3: { born: "March 22, 1927", died: "September 22, 2007", library: [], bio: "", trivia: ["He also co-produced the film and helped with the makeup."] },
    p4: { born: "December 17, 1933", died: "August 22, 2021", library: [], bio: "", trivia: ["She also helped with the film's makeup."] },
    p5: { born: "January 16, 1945", died: "September 9, 1995", library: [], bio: "", trivia: [] },
    p6: { born: "September 15, 1946", died: null, library: [], bio: "", trivia: [] },
    p7: { born: "October 4, 1957", died: null, library: [], bio: "", trivia: ["Her father, Karl Hardman, plays her on-screen father, Harry Cooper."] },
    p8: { born: "February 6, 1940", died: null, library: [], bio: "", trivia: ["He was also one of the film's producers."] },
    p9: { born: "November 23, 1917", died: "January 10, 2000", library: [], bio: "", trivia: ["He returned as host for the 1978 revival, The Next Step Beyond."] },
    p10: { egot: ["Oscar"], born: "January 18, 1904", died: "November 29, 1986", library: ["His Girl Friday"], bio: "", trivia: ["He starred in four films for Alfred Hitchcock."] },
    p11: { egot: ["Emmy", "Grammy", "Oscar", "Tony"], born: "May 4, 1929", died: "January 20, 1993", library: [], bio: "", trivia: [] },
  };

  // ---- Search ---------------------------------------------------------------

  const CATALOG = [
    { imdb_id: "tt0063350", title: "Night of the Living Dead", year: 1968, kind: "movie", stars: "Duane Jones, Judith O'Dea" },
    { imdb_id: "tt0052442", title: "One Step Beyond", year: 1959, kind: "tv", stars: "John Newland" },
    { imdb_id: "tt0056923", title: "Charade", year: 1963, kind: "movie", stars: "Cary Grant, Audrey Hepburn" },
    { imdb_id: "tt0032599", title: "His Girl Friday", year: 1940, kind: "movie", stars: "Cary Grant, Rosalind Russell" },
    { imdb_id: "tt0017925", title: "The General", year: 1926, kind: "movie", stars: "Buster Keaton, Marion Mack" },
    { imdb_id: "tt0013442", title: "Nosferatu", year: 1922, kind: "movie", stars: "Max Schreck, Gustav von Wangenheim" },
  ];
  const RECENT = [
    { source: "plex", item_id: "48", media_id: "48", title: "Night of the Living Dead", year: 1968, imdb_id: "tt0063350", tmdb_id: null },
    { source: "plex", item_id: "42", media_id: "42", title: "Charade", year: 1963, imdb_id: "tt0056923", tmdb_id: null },
    { source: "plex", item_id: "43", media_id: "43", title: "His Girl Friday", year: 1940, imdb_id: "tt0032599", tmdb_id: null },
    { source: "plex", item_id: "49", media_id: "49", title: "The General", year: 1926, imdb_id: "tt0017925", tmdb_id: null },
  ];
  // Tonight's pick: "another" takes the next one.
  const PICKS = [
    { ...RECENT[1], tagline: null, teaser: "It's in the public domain because the studio left out a valid copyright notice." },
    { ...RECENT[0], tagline: null, teaser: "It was shot in black and white around Pittsburgh on a very small budget." },
  ];
  let pickIndex = 0;

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
    return { sessions: idle ? [] : [advance(NOTLD), advance(ONE_STEP)], errors: {}, configured: { plex: true, jellyfin: false } };
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
      episode_imdb_id: q.get("season") ? ONE_STEP.episode.imdb_id : null,
    };
  }

  // Facts about each person, as IMDb lists them.
  const DETAILS = {
    p1: {"birthplace": "New York City, New York, USA", "death_place": "Mineola, Long Island, New York, USA", "death_cause": "cardiopulmonary arrest", "height": "6′ 2″ (1.88 m)", "known_for": [{"title": "Night of the Living Dead", "year": 1968}, {"title": "Ganja & Hess", "year": 1973}, {"title": "To Die For", "year": 1988}, {"title": "Losing Ground", "year": 1982}], "imdb_id": "nm0427977"},
    p2: {"birthplace": "Pittsburgh, Pennsylvania, USA", "height": "5′ 6″ (1.68 m)", "known_for": [{"title": "Night of the Living Dead", "year": 1968}, {"title": "Vampire Zombies... From Space!", "year": 2024}, {"title": "Night of the Living Dead: Genesis", "year": null}, {"title": "October Moon 2: November Son", "year": 2008}], "awards": {"summary": null, "wins": 2, "nominations": 5, "highlights": []}, "imdb_id": "nm0640621"},
    p3: {"birthplace": "Pittsburgh, Pennsylvania, USA", "death_place": "Pittsburgh, Pennsylvania, USA", "death_cause": "pancreatic cancer", "height": "5′ 9″ (1.75 m)", "known_for": [{"title": "Night of the Living Dead", "year": 1968}, {"title": "Night of the Living Dead: 30th Anniversary Edition", "year": 1999}, {"title": "Laugh Track: Night of the Living Dead", "year": 2003}, {"title": "Santa Claws", "year": 1996}], "imdb_id": "nm0362457"},
    p4: {"birthplace": "Beaver, Iowa, USA", "death_place": "Tampa, Florida, USA", "height": "5′ 10″ (1.78 m)", "known_for": [{"title": "Night of the Living Dead", "year": 1968}, {"title": "Chiller Theater", "year": 1963}, {"title": "Perry Mason", "year": 1957}, {"title": "Houseguest", "year": 1995}], "imdb_id": "nm0247659"},
    p5: {"birthplace": "Washington, Pennsylvania, USA", "death_place": "Cary, North Carolina, USA", "death_cause": "undisclosed", "height": "5′ 9¼″ (1.76 m)", "known_for": [{"title": "Night of the Living Dead", "year": 1968}, {"title": "Night of the Living Dead: audio commentary with Russell Streiner, Bill Hinzman, Judith O'Dea, Keith Wayne, Kyra Schon and Vincent D. Survinski", "year": 1994}], "imdb_id": "nm0915593"},
    p6: {"birthplace": "Pittsburgh, Pennsylvania, USA", "height": "5′ 8½″ (1.74 m)", "known_for": [{"title": "Night of the Living Dead", "year": 1968}, {"title": "The Affair", "year": 1971}, {"title": "The Living Dead Reunion (Evans City)", "year": 2024}], "imdb_id": "nm0725985"},
    p7: {"birthplace": "Pittsburgh, Pennsylvania, USA", "height": "5′ 9″ (1.75 m)", "known_for": [{"title": "Night of the Living Dead", "year": 1968}, {"title": "The Greenman", "year": 2011}, {"title": "Tortured Soul II: Ike and Mike", "year": 1994}, {"title": "Dayplanner of the Dead", "year": 2013}], "imdb_id": "nm0774736"},
    p8: {"birthplace": "Pittsburgh, Pennsylvania, USA", "known_for": [{"title": "Night of the Living Dead", "year": 1968}, {"title": "Night of the Living Dead", "year": 1990}, {"title": "The Return of the Living Dead", "year": 1985}, {"title": "The Devil and Sam Silverstein", "year": 1976}], "imdb_id": "nm0834183"},
    p9: {"birthplace": "Cincinnati, Ohio, USA", "death_place": "Los Angeles, California, USA", "death_cause": "stroke", "known_for": [{"title": "The Man Who Never Was", "year": 1966}, {"title": "One Step Beyond", "year": 1959}, {"title": "Star Trek", "year": 1966}, {"title": "Tales of Tomorrow", "year": 1951}], "awards": {"summary": "Nominated for 1 Primetime Emmy", "wins": 0, "nominations": 1, "highlights": []}, "imdb_id": "nm0627950"},
    p10: {"birthplace": "Horfield, Bristol, England, UK", "death_place": "Davenport, Iowa, USA", "death_cause": "cerebral hemorrhage", "height": "6′ 2″ (1.88 m)", "known_for": [{"title": "Arsenic and Old Lace", "year": 1944}, {"title": "North by Northwest", "year": 1959}, {"title": "The Philadelphia Story", "year": 1940}, {"title": "His Girl Friday", "year": 1940}], "awards": {"summary": "Nominated for 2 Oscars", "wins": 35, "nominations": 58, "highlights": [{"event": "Academy Awards", "award": "Honorary Award", "year": 1970, "category": null, "title": null}]}, "imdb_id": "nm0000026"},
    p11: {"birthplace": "Ixelles, Brussels, Belgium", "death_place": "Tolochenaz, Vaud, Switzerland", "death_cause": "appendiceal cancer", "height": "5′ 6¾″ (1.70 m)", "known_for": [{"title": "Breakfast at Tiffany's", "year": 1961}, {"title": "Roman Holiday", "year": 1953}, {"title": "My Fair Lady", "year": 1964}, {"title": "Charade", "year": 1963}], "awards": {"summary": "Won 1 Oscar from 4 nominations", "wins": 25, "nominations": 74, "highlights": [{"event": "Academy Awards", "award": "Oscar", "year": 1954, "category": "Best Actress in a Leading Role", "title": "Roman Holiday"}, {"event": "Academy Awards", "award": "Jean Hersholt Humanitarian Award", "year": 1993, "category": null, "title": null}, {"event": "Golden Globes", "award": "Golden Globe", "year": 1954, "category": "Best Actress - Drama", "title": "Roman Holiday"}, {"event": "Golden Globes", "award": "Henrietta Award", "year": 1955, "category": "World Film Favorite - Female", "title": null}, {"event": "Golden Globes", "award": "Cecil B. DeMille Award", "year": 1990, "category": null, "title": null}, {"event": "BAFTA Awards", "award": "BAFTA Film Award", "year": 1954, "category": "Best British Actress", "title": "Roman Holiday"}]}, "imdb_id": "nm0000030"},
  };

  function person(q) {
    const p = PEOPLE[q.get("id")] || { library: [], trivia: [] };
    const d = DETAILS[q.get("id")] || {};
    return {
      name: q.get("name"), errors: {},
      library: p.library.map((t) => LIBRARY[t]),
      imdb: { ...d, url: `https://www.imdb.com/name/${d.imdb_id}/`, born: p.born, died: p.died, bio: p.bio, trivia: p.trivia },
    };
  }

  function route(method, path, q, body) {
    switch (path) {
      case "/api/auth/status": return { mode: "none", user: null, admin: true, oidc_name: "Pocket ID" };
      case "/api/display": return display();
      case "/api/now-playing": return nowPlaying();
      case "/api/trivia": return trivia(q);
      case "/api/cast": return { cast: (CAST[q.get("item")] || []).map(([id, name, role]) => ({ id, name, role, photo: null, guest: false, died: PEOPLE[id].died, egot: PEOPLE[id].egot })) };
      case "/api/person": return person(q);
      case "/api/recent": return { movies: RECENT };
      case "/api/pick":
        if (q.get("another")) pickIndex = (pickIndex + 1) % PICKS.length;
        return { movie: PICKS[pickIndex] };
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
      // Public-domain artwork for two titles; "data:," fails without a request, so the app shows its fallback.
      if (id === "48") return kind === "poster" ? "static/demo/notld-poster.jpg" : "static/demo/notld-backdrop.jpg";
      if (id === "42") return "static/demo/charade.jpg";
      return "data:,";
    },
  };
})();
