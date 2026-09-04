/* ============================================================
   <gathio-events> — lists upcoming events from a Gathio
   instance's ActivityPub OrderedCollection.

   Usage:
     <gathio-events src="https://gathio.peacock.dev/events"></gathio-events>

   Attributes:
     src     the OrderedCollection endpoint
     match   case-insensitive substring; only show events whose title
             OR event group name contains it (e.g. match="Puddle")
     limit   max tiles to show (default: all upcoming)
     past    "true" to also show recent past events, greyed out

   Loading uses JSONP (<script> + ?callback=) rather than fetch():
   Neocities pages ship a CSP with connect-src 'self', which blocks
   cross-origin fetch, while script-src permits any https source.
   No shadow DOM: tiles are plain elements so /style.css themes
   them like the rest of the site.
   ============================================================ */

class GathioEvents extends HTMLElement {
  connectedCallback() {
    this.render({ state: "loading" });
    this.load();
  }

  get src() {
    return this.getAttribute("src");
  }

  async load() {
    if (!this.src) return this.render({ state: "error" });
    try {
      const data = await this.fetchJSONP(this.src);
      const events = (data.orderedItems || [])
        .map(e => ({
          name: e.name || "(untitled event)",
          url: e.url || e.id || this.src,
          location: typeof e.location === "string" ? e.location : "",
          image: typeof e.image === "string" ? e.image : "",
          group: e.eventGroup && typeof e.eventGroup.name === "string"
            ? e.eventGroup.name
            : "",
          start: new Date(e.startTime),
          end: new Date(e.endTime),
        }))
        .filter(e => !isNaN(e.start))
        .sort((a, b) => a.start - b.start);

      const match = (this.getAttribute("match") || "").toLowerCase().trim();
      const scoped = match
        ? events.filter(e =>
            e.name.toLowerCase().includes(match) ||
            e.group.toLowerCase().includes(match))
        : events;

      const now = Date.now();
      const upcoming = scoped.filter(e => e.end >= now);
      let shown = upcoming;
      if (this.getAttribute("past") === "true") {
        const past = scoped.filter(e => e.end < now).slice(-3);
        shown = [...past, ...upcoming];
      }
      const limit = Number(this.getAttribute("limit"));
      if (limit > 0) shown = shown.slice(0, limit); // keep the *nearest* N
      this.render({ state: shown.length ? "ok" : "empty", events: shown, upcomingCount: upcoming.length });
    } catch (err) {
      console.warn("gathio-events: load failed:", err);
      this.render({ state: "error" });
    }
  }

  /* JSONP loader: the gathio /events endpoint wraps its collection in
     callback(json) when given ?callback=NAME. Runs as a plain script
     load, so Neocities' connect-src CSP does not apply. */
  fetchJSONP(url) {
    return new Promise((resolve, reject) => {
      const name = "__gathioEvents_" + Math.random().toString(36).slice(2, 10);
      const script = document.createElement("script");
      const cleanup = () => {
        clearTimeout(timer);
        delete window[name];
        script.remove();
      };
      const timer = setTimeout(
        () => { cleanup(); reject(new Error("timeout")); }, 8000);
      window[name] = data => { cleanup(); resolve(data); };
      script.onerror = () => { cleanup(); reject(new Error("script load failed")); };
      script.src = url + (url.includes("?") ? "&" : "?") + "callback=" + name;
      document.head.appendChild(script);
    });
  }

  fmtDate(d) {
    return new Intl.DateTimeFormat(undefined, {
      weekday: "short", month: "short", day: "numeric",
    }).format(d);
  }

  fmtTime(d) {
    return new Intl.DateTimeFormat(undefined, {
      hour: "numeric", minute: "2-digit",
    }).format(d);
  }

  render(view) {
    this.textContent = ""; // reset
    const el = (tag, cls, text) => {
      const n = document.createElement(tag);
      if (cls) n.className = cls;
      if (text != null) n.textContent = text;
      return n;
    };

    if (view.state === "loading") {
      this.appendChild(el("p", "events-status", "Loading events…"));
      return;
    }
    if (view.state === "error") {
      const p = el("p", "events-status");
      p.append("Events are unavailable right now. ", this.link("Try Gathio", this.src || "#"));
      this.appendChild(p);
      return;
    }
    if (view.state === "empty") {
      const p = el("p", "events-status");
      p.append("No upcoming events. ", this.link("Past events", this.src));
      this.appendChild(p);
      return;
    }

    const list = el("ul", "event-list");
    for (const ev of view.events) {
      const li = el("li", "event-item");
      const a = this.link(null, ev.url);
      if (ev.image) {
        const img = document.createElement("img");
        img.src = ev.image;
        img.alt = ev.name;
        img.loading = "lazy";
        img.addEventListener("error", () => img.remove());
        a.appendChild(img);
      }
      const date = el("div", "event-date", this.fmtDate(ev.start));
      date.appendChild(el("span", "event-time", " · " + this.fmtTime(ev.start)));
      const body = el("div", "event-body");
      body.appendChild(el("div", "event-name", ev.name));
      if (ev.location) body.appendChild(el("div", "event-location", ev.location));
      a.appendChild(date);
      a.appendChild(body);
      li.appendChild(a);
      list.appendChild(li);
    }
    this.appendChild(list);
  }

  link(text, href) {
    const a = document.createElement("a");
    a.href = href;
    if (text != null) a.textContent = text;
    return a;
  }
}

customElements.define("gathio-events", GathioEvents);
