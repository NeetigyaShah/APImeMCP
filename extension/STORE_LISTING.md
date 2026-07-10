# Chrome Web Store listing — ready to paste at submission time

Not submitted yet. When you're ready: https://chrome.google.com/webstore/devconsole
(one-time $5 USD registration fee, tied to your Google account).

## Short description (max 132 characters)

```
Record clicks, typing, and navigation on a site, then replay the workflow headlessly via your local APImeMCP server.
```
(118 characters)

## Detailed description

```
APImeMCP Recorder captures a browser workflow once — the clicks, form input, and
navigation you do on a site — and turns it into a repeatable, headless script you
can re-run any time via APImeMCP, a local automation server you run on your own
machine.

Click Record. Chrome asks your permission for the one site you're on — nothing is
captured before you approve, and only for that site. Do the workflow once (log in,
fill a form, click through some steps). Click Stop, name it, and it's sent to your
local APImeMCP server, which immediately replays it once to verify it works, then
it's ready to re-run headlessly whenever you need that workflow done again.

Everything stays on your machine. This extension talks to exactly one address:
http://127.0.0.1:3000 — your own local APImeMCP server. Nothing is sent to the
developer, to analytics, or to any third party.

Requires APImeMCP running locally: https://github.com/NeetigyaShah/APImeMCP

Permissions are requested per-site, at the moment you click Record — not declared
for every site up front. See the in-popup disclosure and PRIVACY.md in the repo
for exactly what's captured and why.
```

## Category

Developer Tools

## Language

English

## Privacy policy URL

Point this at the raw/rendered PRIVACY.md once the repo is public, e.g.:
`https://github.com/NeetigyaShah/APImeMCP/blob/master/extension/PRIVACY.md`

## Permission justifications (Chrome Web Store asks for these per sensitive permission)

- **cookies**: "Reads cookies for the specific site the user just granted access to
  (via the Record button's permission prompt), so a recorded workflow can replay
  with the same logged-in session. Never reads cookies for any other site."
- **host permission (optional, requested at runtime)**: "Requested only for the
  single site the user clicks Record on, via chrome.permissions.request() in
  direct response to that click - never declared broadly at install time."
- **scripting**: "Injects the step-capture script into the tab the user is
  actively recording, triggered by their own Record click (activeTab)."
- **webNavigation**: "Detects navigation within the recording tab so it's captured
  as a step in the recorded workflow."

## Screenshots needed (1280x800 or 640x400, at least one required)

Not yet captured - see extension/README.md for how to get real ones (load the
extension, open the popup, screenshot it mid-recording and after a successful
save). Placeholder note: do this once there's a real recorded example to show.

## What's still needed before actually submitting

- [ ] Google Chrome Web Store developer account ($5 one-time fee)
- [ ] At least one real screenshot (see above)
- [ ] Decide if the repo/PRIVACY.md URL should be public before or at submission
      time (Chrome Web Store review will fetch it)
- [ ] Final review of the description/permission justifications above
