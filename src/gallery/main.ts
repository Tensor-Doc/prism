// gallery/main.ts — the catalog browser.
//
// Fetches catalog/index.json, renders a grid of cards. Cards show the
// thumb JPG; on hover the WebM streams in, plays muted/looped. Click a
// card to load that preset on the live page (/landing.html?preset=<slug>).
//
// Filter row: vibe + technique chips, refik mode toggle, brand-safe toggle.
// Search: free-text across name, author, vibe, techniques.
// Auto-refresh: re-fetches the index every 30s so new entries appear as
// the bulk annotator finishes them.

interface IndexEntry {
  id: string;
  slug: string;
  name: string;
  author?: string;
  blurb?: string;
  vibe: string[];
  motion: number;
  audio_affinity: { bass: number; mid: number; treble: number };
  techniques: string[];
  refik_mode: boolean;
  brand_safe: boolean;
  textures_needed: string[];
  video?: string;
  thumb?: string;
  added_by?: string;
}

interface CatalogIndex {
  schema_version: 2;
  generated_at: string;
  total: number;
  annotated_count: number;
  pending_count: number;
  entries: IndexEntry[];
}

interface ActiveFilters {
  search: string;
  refikOnly: boolean;
  brandSafeOnly: boolean;
  vibes: Set<string>;
  techniques: Set<string>;
}

const INDEX_URL = "/catalog/index.json";
const REFRESH_MS = 30_000;

const state: ActiveFilters = {
  search: "",
  refikOnly: false,
  brandSafeOnly: false,
  vibes: new Set(),
  techniques: new Set(),
};

let catalog: CatalogIndex | null = null;

const $ = <T extends HTMLElement = HTMLElement>(s: string): T => {
  const el = document.querySelector<T>(s);
  if (!el) throw new Error(`gallery: missing ${s}`);
  return el;
};

async function fetchIndex(): Promise<CatalogIndex> {
  const res = await fetch(`${INDEX_URL}?t=${Date.now()}`);
  if (!res.ok) throw new Error(`index fetch ${res.status}`);
  return (await res.json()) as CatalogIndex;
}

function applyFilters(entries: IndexEntry[]): IndexEntry[] {
  const q = state.search.trim().toLowerCase();
  return entries.filter((e) => {
    if (state.refikOnly && !e.refik_mode) return false;
    if (state.brandSafeOnly && !e.brand_safe) return false;
    if (state.vibes.size > 0) {
      const has = e.vibe.some((v) => state.vibes.has(v));
      if (!has) return false;
    }
    if (state.techniques.size > 0) {
      const has = e.techniques.some((t) => state.techniques.has(t));
      if (!has) return false;
    }
    if (q) {
      const hay = (
        e.name + " " +
        (e.author ?? "") + " " +
        e.vibe.join(" ") + " " +
        e.techniques.join(" ") + " " +
        (e.blurb ?? "")
      ).toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

/** Build the card DOM for a single entry. Lazy-loads thumb via
 *  IntersectionObserver; loads video metadata on hover, plays on hover. */
function renderCard(e: IndexEntry): HTMLElement {
  const card = document.createElement("a");
  card.className = "card";
  card.href = `/landing.html?preset=${encodeURIComponent(e.slug)}`;
  card.title = `${e.name}\n${e.blurb ?? ""}`;

  const media = document.createElement("div");
  media.className = "card__media";
  card.appendChild(media);

  // Lazy thumb (data-thumb attr; observer swaps src in when visible)
  const img = document.createElement("img");
  img.className = "card__thumb";
  img.alt = "";
  img.loading = "lazy";
  img.dataset.thumb = e.thumb ?? "";
  media.appendChild(img);

  // Video (only loaded on hover to save bandwidth)
  if (e.video) {
    const vid = document.createElement("video");
    vid.className = "card__video";
    vid.muted = true;
    vid.loop = true;
    vid.playsInline = true;
    vid.preload = "none";
    vid.dataset.src = e.video;
    media.appendChild(vid);
    card.addEventListener("pointerenter", () => {
      if (!vid.src && vid.dataset.src) vid.src = vid.dataset.src;
      void vid.play().catch(() => undefined);
    });
    card.addEventListener("pointerleave", () => {
      vid.pause();
      vid.currentTime = 0;
    });
  }

  // Tag overlays on hover
  if (e.refik_mode) {
    const tag = document.createElement("span");
    tag.className = "card__corner-tag";
    tag.textContent = "refik";
    media.appendChild(tag);
  }

  const meta = document.createElement("div");
  meta.className = "card__meta";
  card.appendChild(meta);

  const name = document.createElement("div");
  name.className = "card__name";
  name.textContent = e.name;
  meta.appendChild(name);

  if (e.author) {
    const auth = document.createElement("div");
    auth.className = "card__author label";
    auth.textContent = e.author;
    meta.appendChild(auth);
  }

  const vibes = document.createElement("div");
  vibes.className = "card__vibes";
  for (const v of e.vibe.slice(0, 3)) {
    const chip = document.createElement("span");
    chip.className = "card__chip";
    chip.textContent = v;
    vibes.appendChild(chip);
  }
  meta.appendChild(vibes);

  return card;
}

let thumbObserver: IntersectionObserver | null = null;
function observeThumbs(): void {
  if (thumbObserver) thumbObserver.disconnect();
  thumbObserver = new IntersectionObserver(
    (entries) => {
      for (const ent of entries) {
        if (!ent.isIntersecting) continue;
        const img = ent.target as HTMLImageElement;
        if (img.dataset.thumb && !img.src) {
          img.src = img.dataset.thumb;
        }
        thumbObserver!.unobserve(img);
      }
    },
    { rootMargin: "200px" },
  );
  for (const img of document.querySelectorAll<HTMLImageElement>(".card__thumb")) {
    if (img.dataset.thumb && !img.src) thumbObserver.observe(img);
  }
}

function renderGrid(): void {
  if (!catalog) return;
  const grid = $("#grid");
  const empty = $("#grid-empty");
  const filtered = applyFilters(catalog.entries);
  // Clear existing cards (keep the empty-state element)
  for (const child of Array.from(grid.children)) {
    if (child.id !== "grid-empty") child.remove();
  }
  for (const entry of filtered) {
    grid.appendChild(renderCard(entry));
  }
  empty.toggleAttribute("data-hidden", filtered.length > 0);
  observeThumbs();
}

/** Collect vibe + technique frequencies across the catalog so the filter
 *  chip row shows the most-common tags first. */
function collectFacets(entries: IndexEntry[]): { vibes: string[]; techniques: string[] } {
  const vibeCounts = new Map<string, number>();
  const techCounts = new Map<string, number>();
  for (const e of entries) {
    for (const v of e.vibe) vibeCounts.set(v, (vibeCounts.get(v) ?? 0) + 1);
    for (const t of e.techniques) techCounts.set(t, (techCounts.get(t) ?? 0) + 1);
  }
  const sortDesc = (a: [string, number], b: [string, number]): number => b[1] - a[1];
  return {
    vibes: [...vibeCounts.entries()].sort(sortDesc).slice(0, 12).map(([v]) => v),
    techniques: [...techCounts.entries()].sort(sortDesc).slice(0, 8).map(([t]) => t),
  };
}

function renderFilters(): void {
  if (!catalog) return;
  const row = $("#filter-row");
  row.innerHTML = "";
  const { vibes, techniques } = collectFacets(catalog.entries);

  const makeToggleChip = (
    label: string,
    title: string,
    isActive: () => boolean,
    onToggle: () => void,
    kind = "toggle",
  ): HTMLElement => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = `chip-fil chip-fil--${kind}`;
    b.textContent = label;
    b.title = title;
    if (isActive()) b.setAttribute("data-on", "");
    b.addEventListener("click", () => {
      onToggle();
      if (isActive()) b.setAttribute("data-on", "");
      else b.removeAttribute("data-on");
      renderGrid();
    });
    return b;
  };

  const addSep = (): void => {
    const s = document.createElement("span");
    s.className = "filter-row__sep";
    s.setAttribute("aria-hidden", "true");
    row.appendChild(s);
  };

  // Mode toggles first
  row.appendChild(
    makeToggleChip(
      "refik mode",
      "Show only the painterly Refik-mode subset",
      () => state.refikOnly,
      () => { state.refikOnly = !state.refikOnly; },
      "mode",
    ),
  );
  row.appendChild(
    makeToggleChip(
      "brand-safe",
      "Hide entries flagged purple-dominant",
      () => state.brandSafeOnly,
      () => { state.brandSafeOnly = !state.brandSafeOnly; },
      "mode",
    ),
  );

  if (vibes.length) {
    addSep();
    const lbl = document.createElement("span");
    lbl.className = "filter-row__label";
    lbl.textContent = "vibe";
    row.appendChild(lbl);
    for (const v of vibes) {
      row.appendChild(
        makeToggleChip(
          v,
          `Filter to entries tagged "${v}"`,
          () => state.vibes.has(v),
          () => { if (state.vibes.has(v)) state.vibes.delete(v); else state.vibes.add(v); },
          "vibe",
        ),
      );
    }
  }

  if (techniques.length) {
    addSep();
    const lbl = document.createElement("span");
    lbl.className = "filter-row__label";
    lbl.textContent = "technique";
    row.appendChild(lbl);
    for (const t of techniques) {
      row.appendChild(
        makeToggleChip(
          t,
          `Filter to entries using technique "${t}"`,
          () => state.techniques.has(t),
          () => { if (state.techniques.has(t)) state.techniques.delete(t); else state.techniques.add(t); },
          "technique",
        ),
      );
    }
  }
}

function renderCounts(): void {
  if (!catalog) return;
  $("#catalog-count").textContent = `${catalog.annotated_count} of ${catalog.total} annotated`;
  $("#pending-line").textContent = catalog.pending_count > 0
    ? `${catalog.pending_count} pending render`
    : "all entries annotated";
}

async function refresh(): Promise<void> {
  try {
    const next = await fetchIndex();
    const prev = catalog;
    catalog = next;
    renderCounts();
    if (!prev || prev.annotated_count !== next.annotated_count) {
      renderFilters();
      renderGrid();
      pulseLive();
    }
  } catch (err) {
    console.warn("[gallery] refresh failed:", err);
  }
}

function pulseLive(): void {
  const pulse = document.getElementById("catalog-pulse");
  if (!pulse) return;
  pulse.classList.remove("is-pulsing");
  void pulse.offsetWidth;
  pulse.classList.add("is-pulsing");
}

async function boot(): Promise<void> {
  // Search wiring
  const input = $<HTMLInputElement>("#search-input");
  input.addEventListener("input", () => {
    state.search = input.value;
    renderGrid();
  });
  window.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) {
      e.preventDefault();
      input.focus();
      input.select();
    }
    if (e.key === "Escape" && document.activeElement === input) {
      input.value = "";
      state.search = "";
      renderGrid();
      input.blur();
    }
  });

  await refresh();
  setInterval(refresh, REFRESH_MS);
}

void boot();
