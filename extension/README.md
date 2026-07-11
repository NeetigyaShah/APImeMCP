# APImeMCP Recorder

A Chrome MV3 extension that records your clicks, typing, and navigation in a normal browser tab, then sends the recording to a local APImeMCP server to be saved and replayed as an action-sequence template.

## Grab Cookies Only

Sometimes you don't want a full recording - you just want a site's session cookies to
paste somewhere yourself (a template's cookie box, a script, wherever). Click **Grab
Cookies Only** in the popup: it asks the same per-site permission as Record, reads that
site's cookies, and shows them in a copyable text box. **Nothing is sent to the server
or saved automatically** - this is the one action in the extension that stays entirely
local and manual, by design, so you decide where the cookies go.

## While recording

The toolbar popup closes the instant you click anywhere on the page - that's normal
browser behavior for extension popups, not a bug, but it means the popup alone can't
show live progress while you're actually interacting with the page. Instead, clicking
Record injects a small floating panel directly onto the page (bottom-right corner)
showing the live step count and its own **Stop & Save** button, so you never need to
reopen the toolbar popup mid-recording - just watch the panel and click Stop there
when you're done.

## Load it

1. Go to `chrome://extensions`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked**
4. Select this `extension/` folder

## Permissions

- `activeTab` - identify the tab you're recording in and read its current URL.
- `scripting` - inject `content-script.js` into the recording tab (on start and after every navigation).
- `cookies` - read cookies for a domain you've granted access to, at Stop.
- `webNavigation` - detect navigations in the recording tab so they're captured as steps and the content script gets re-injected.
- **Site access is not declared up front.** Clicking Record triggers Chrome's own permission prompt for the one site you're on (`optional_host_permissions` + `chrome.permissions.request()`), not a blanket grant across every site at install. See `PRIVACY.md` for the full data-handling explanation.

## Requirements

Saving a recording requires APImeMCP's dashboard server to be running locally at `http://127.0.0.1:3000` (POST `/api/recordings`). If it isn't running, the popup will show a "Could not reach APImeMCP" error instead of failing silently.

## Publishing to the Chrome Web Store

Not done yet - `PRIVACY.md` and `STORE_LISTING.md` in this folder are prepared and
ready for when you decide to submit (needs a one-time $5 Google developer account
fee and the actual submission through https://chrome.google.com/webstore/devconsole,
both of which only you can do). Before submitting, capture real popup screenshots:

1. Load the extension (steps above).
2. Click the toolbar icon to open the popup, click Record, interact with a page a
   little, click Stop, and screenshot the popup at a couple of these states
   (Windows: `Win+Shift+S` while the popup is open).
3. Crop/save at 1280x800 or 640x400 and drop them in `extension/icons/` or a new
   `extension/screenshots/` folder, then reference them in `STORE_LISTING.md`.
