/* ============================================================
   <site-footer> — the reusable footer on every page.

   Usage:
     <site-footer></site-footer>

   Attributes (all optional):
     about-href  link for the about page  (default /about.html)
     home-href   link back to the homepage (default /)

   Light DOM: plain elements themed by /style.css, consistent
   with <gathio-events>. Content is built in JS so the ecosystem
   credits live in one place.
   ============================================================ */

class SiteFooter extends HTMLElement {
  connectedCallback() {
    this.textContent = "";

    const footer = document.createElement("footer");
    footer.className = "site-footer";
    footer.appendChild(this.buildNav());
    footer.appendChild(this.buildCredits());
    this.appendChild(footer);
  }

  buildNav() {
    const nav = document.createElement("nav");
    nav.className = "footer-nav";
    const about = this.getAttribute("about-href") || "/about.html";
    const home = this.getAttribute("home-href") || "/";
    nav.append(
      this.link("About", about),
      document.createTextNode(" · "),
      this.link("Home", home),
      document.createTextNode(" · "),
      this.link("Events", "https://gathio.peacock.dev/events"),
    );
    return nav;
  }

  buildCredits() {
    const p = document.createElement("p");
    p.className = "footer-credits";
    p.append("Handmade on ");
    p.append(this.link("Neocities", "https://neocities.org"));
    p.append(". Events via ");
    p.append(this.link("Gathio", "https://gathio.peacock.dev"));
    p.append(" and the open ");
    p.append(this.link("ActivityPub", "https://activitypub.rocks"));
    p.append(" web. No trackers, no cookie banner.");
    return p;
  }

  link(text, href) {
    const a = document.createElement("a");
    a.href = href;
    a.textContent = text;
    if (href.startsWith("http")) {
      a.target = "_blank";
      a.rel = "noopener noreferrer";
    }
    return a;
  }
}

customElements.define("site-footer", SiteFooter);
