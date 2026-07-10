# APImeMCP Recorder

A Chrome MV3 extension that records your clicks, typing, and navigation in a normal browser tab, then sends the recording to a local APImeMCP server to be saved and replayed as an action-sequence template.

## Load it

1. Go to `chrome://extensions`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked**
4. Select this `extension/` folder

## Permissions

- `activeTab` - identify the tab you're recording in and read its current URL.
- `scripting` - inject `content-script.js` into the recording tab (on start and after every navigation).
- `cookies` - read cookies for visited domains when a recording is stopped, so replay can reuse the session.
- `webNavigation` - detect navigations in the recording tab so they're captured as steps and the content script gets re-injected.
- `host_permissions` (`http://*/*`, `https://*/*`) - recording can be started on any site.

## Requirements

Saving a recording requires APImeMCP's dashboard server to be running locally at `http://127.0.0.1:3000` (POST `/api/recordings`). If it isn't running, the popup will show a "Could not reach APImeMCP" error instead of failing silently.
