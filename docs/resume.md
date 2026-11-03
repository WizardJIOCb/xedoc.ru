# Public resume

The public Russian resume is at `https://xedoc.ru/resume` (both `/resume` and
`/resume/` work). Its static source is `apps/web/public/resume/`; Vite copies
the directory to `apps/web/dist/resume/` on every web build.

The page contains the complete employment and technology information from
`https://rodion.pro/ru/resume`, plus leadership from its linked published
Google document. Public contact links come from `https://rodion.pro/ru/contact`.
Imported on 2026-11-03. This is an independent snapshot: changes to rodion.pro
are not imported automatically. Employment dates, performance metrics,
education and extra employers were not invented.

Codex is the primary AI development tool. The own-projects section and the
dark approach statement are currently omitted at the owner's request.
The accent palette is forest green (`#2f6b4f`), dark green hover (`#24533d`),
and pale sage on graphite (`#9cc9aa`), including favicon and social preview.
Layout uses equal desktop columns with a shared 24 px gutter, uniform card
padding and consistent section spacing. Experience is a two-by-two card
grid, technology tags align along the card bottoms, and mobile uses one
column. The hero metric and print layout keep the experience number intact.

## Motion direction

The page uses a custom adaptation of a minimal editorial portfolio direction:
large kinetic type, a balanced card grid, subtle depth and green pointer light.
Research references:

| Reference | Design idea |
| --- | --- |
| [PortfolioZ / Framer](https://www.framer.com/marketplace/templates/portfolioz/) | Strong typography and staged entrances |
| [indie / Webflow](https://webflow.com/made-in-webflow/website/mark-indie) | Minimal layout with restrained transitions |
| [Eduard Bodak / Codrops](https://tympanus.net/codrops/2025/07/29/built-to-move-a-closer-look-at-the-animations-behind-eduard-bodaks-portfolio/) | Depth and pointer-responsive cards |
| [Spotlight Card / React Bits](https://reactbits.dev/components/spotlight-card) | A soft light following the pointer |

The implementation is original, framework-free JavaScript and CSS. No template
code, new packages, external scripts, or external runtime assets are included.
Entrances run once using the Web Animations API and IntersectionObserver.
Scroll progress and active navigation share one requestAnimationFrame callback;
pointer work is also limited to one callback per frame while the pointer moves.
There is no repeating animation loop or custom scroll controller. Touch devices
skip hover effects. Reduced motion and printing show the complete static page.
The orbital drawing is decorative SVG and is excluded from accessibility and
print output. All resume text remains live HTML.

## Serving

Include `infra/resume.nginx.conf` inside the HTTPS `server_name xedoc.ru`
block as `/etc/nginx/snippets/xedoc-resume.conf`. It serves only the exact
resume route and its directory from `apps/web/dist/resume/`. The private
controller continues to use its existing reverse proxy. No API or auth
changes and no controller restart are required.

Before changing production, back up the vhost, existing snippet and both
resume directories. Run `nginx -t` before reloading. Verify the public HTML,
CSS, JavaScript, fonts, social image, `/api/health` and the existing homepage.
Deploy only the resume directories and snippet; do not replace the entire
application build or overwrite the existing server source changes.

The CSP script hash in the snippet matches the inline JSON-LD content in
`index.html`. Regenerate its SHA-256 base64 value when changing that JSON.
JavaScript runs from an external local file; there are no external runtime
dependencies or analytics on this page. Manrope is self-hosted under its
bundled SIL Open Font License (`resume/OFL.txt`).

## Interaction and printing

The stack can be filtered by development, infrastructure or tools. Printing
always includes every stack card, even when a filter is active. The PDF
button opens the browser print dialog, where the visitor can save as PDF.
All resume text is in the HTML and remains readable without JavaScript.
Page metadata includes a local 1200×630 social image, canonical URL and
ProfilePage structured data.

Validation: `corepack pnpm typecheck`, `corepack pnpm build`, browser checks
at 320, 360, 390, 699, 768, 1024, 1280 and 1440 px; filters, anchors, print button,
print media, JavaScript disabled and reduced motion.
