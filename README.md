# neocities-priestesskaia

Source of [priestesskaia.neocities.org](https://priestesskaia.neocities.org) — the personal site of Priestess Kaia (SF leather community organizer).

## Layout

- `site/` — the entire published site (plain handwritten HTML/CSS, no build step, no frameworks, no trackers)
  - `components/` — vanilla web components, imported via one `<script type="module" src="/components/index.js">` per page:
    - `<gathio-events>` — live event tiles fetched from a Gathio instance over ActivityPub (JSONP, so it passes Neocities' `connect-src 'self'` CSP)
    - `<site-footer>` — shared footer + ecosystem credits
- `scripts/upload.mjs` — deploy: incremental sha1 diff against the Neocities API (token in `~/.neocities_token` or `NEOCITIES_API_TOKEN`); Chrome-CDP fallback if no token
- `.originals/` — unprocessed source images

Gathio (self-hosted, [lowercasename/gathio](https://github.com/lowercasename/gathio)) is the source of truth for all event data; nothing perishable lives in this repo.

## Deploy

```bash
node scripts/upload.mjs           # sync site/ to neocities
node scripts/upload.mjs --dry-run # preview what would change
```
