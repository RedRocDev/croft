# Croft Smartlinks

Smartlinks make pasted web addresses into local canvas objects. Current live providers are YouTube videos and public X posts. Other safe HTTP(S) links become local bookmark cards. A Smartlink stores its canonical URL, title, notes and display mode; the original provider content is never copied into the project.

## Create and change a Smartlink

Paste a single YouTube, X or ordinary website URL on the canvas to create an object at the pointer. Use the canvas Add menu or the selected object's Properties panel to enter or edit a URL. Paste into an input, textarea or editor remains ordinary text paste. A multi-URL paste presents a review dialog and creates at most ten objects in one undo step.

Choose one of these modes in Properties or the object menu:

- **Embed** shows the official provider frame for supported YouTube and X URLs. Generic websites cannot use this mode.
- **Preview Card** displays a local card with the saved provider/site label, title, URL and notes.
- **Link Only** displays the saved URL and notes with Copy Link and Open Original.

Modes do not change object identity, geometry, notes, connections or stack membership. A card's Back can hold a separate Smartlink; switching faces does not fetch the hidden link. Stack members keep their own Smartlink data.

## Provider consent and privacy

Croft defaults each provider to **Ask before loading**. No provider iframe is created before consent. In Embed mode, a visible provider card offers:

- **Load Once**: permits that object, face and URL for this open page only.
- **Always Allow This Provider**: stores an origin-scoped provider choice in browser localStorage.
- **Keep as Link**: shows the local link card without contacting the provider.

Manage **Ask**, **Always allow** and **Block** in **Settings → Privacy → External Content**. Ask and Block clear temporary grants and remove active embeds. Settings are stored separately from canvas content and never travel in `.croft`, `.zip` or `.croftbackup` files. Imported, restored and copied projects therefore ask again unless the current browser profile already has a separate provider preference.

The app only mounts an allowed embed when its face is active, it is visible and expanded, it is on screen, the canvas is zoomed enough, the tab is visible and one of four live slots is available. Embeds are torn down when these conditions stop applying. Croft does not autoplay. Provider frames receive only their own cross-origin content; the application window does not load `widgets.js` or any other third-party script. The main document CSP allows only the required YouTube and X frame origins. X embeds set `dnt=true`.

An allowed provider sees the network information required to serve its content, including the requesting IP address. Provider policy, cookies, age and region restrictions, takedowns, network filters and service changes remain outside Croft's control. A successful frame response alone does not prove that all media is playable. Offline and blocked cases keep the local URL and notes available; Retry, Copy Link and Open Original are provided where relevant.

## Storage and exports

Smartlinks use the optional version 5 object/Back schema. Existing versions 1–4 need no database migration. Autosave, manual Save, Save VC, Save As, recovery, object undo/redo, portable packages and workspace backups store the validated URL and notes. Provider preferences remain separate. All face content and hidden stack members are included in editable formats.

Portable package inventory reports Smartlink references. Editable package and workspace backup restore preserves local references, not video or post bytes; restored embeds require current consent and internet access. SVG, PNG, JPG and PDF output contains local labelled Smartlink cards without scripts, iframes, remote images or active links.

## Verification

Deterministic URL, schema, package, stack and backup cases run with `npm test`. The separate real-provider smoke test is `tests/icanvas-smartlinks.browser.mjs`. It uses an isolated Chromium context, inserts the public YouTube video `jNQXAC9IVRw` and X post `20`, verifies that no provider request occurs before consent, and inspects live provider responses/content after the test clicks Load Once. It also checks that Load Once does not persist, Always Allow persists across a new tab, and Settings can return a provider to Ask.

Start Croft at `http://localhost:5173`, then run the browser smoke from `croft-ui` with `CROFT_QA_PLAYWRIGHT` pointing to a Playwright package and `CROFT_QA_CHROME` pointing to Chrome. Set `CROFT_QA_URL` to the exact localhost origin used by the app. The browser check confirms one public sample per provider; it is not a guarantee that every provider URL will work.
