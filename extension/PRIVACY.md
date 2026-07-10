# APImeMCP Recorder — Privacy Policy

_Last updated: 2026-07-10_

## What this extension does

APImeMCP Recorder records your clicks, form input, and navigation on a web page
you choose, then sends that recording to **APImeMCP**, a server that runs
**locally on your own computer** (`http://127.0.0.1:3000`) — not a server operated
by the developer, not a cloud service, not a third party.

## What data is collected, and when

Nothing is collected until you click **Record**, and only for the one site you're
on at that moment:

1. **Permission prompt.** Clicking Record triggers Chrome's own native permission
   dialog, asking whether the extension may read data on the current site. Nothing
   is captured before you approve this, and approval is scoped to that one site —
   not every site you visit.
2. **While recording.** The extension observes clicks and form field changes
   (value typed, option selected) on that site, and records the URLs you navigate
   to. This is limited to element selectors, typed/selected values, and URLs —
   it does not read page content you didn't interact with.
3. **On Stop.** The extension reads cookies (via Chrome's `cookies` API) for the
   domain(s) you were granted permission on during that recording, so the
   recording can reproduce your logged-in session on replay.
4. **Sending.** The recorded steps and cookies are sent, over your local network
   loopback interface, to `http://127.0.0.1:3000/api/recordings` — the APImeMCP
   server you are running on your own machine. If that server isn't running, the
   send fails and nothing is transmitted anywhere.

## Where the data ends up

On your own machine, in the `templates/` folder of your local APImeMCP
installation, as a JSON file. It is used to replay the recorded workflow later
via that same local server. **No data is sent to the extension developer, to any
analytics service, or to any third party.** The extension makes no network
requests other than the one described above, to the address you control.

## Permissions used

| Permission | Why |
|---|---|
| `activeTab` | Identify the tab you're recording and read its current URL. |
| `scripting` | Inject the recording script into that tab. |
| `cookies` | Read cookies for a domain you've granted access to, at Stop. |
| `webNavigation` | Detect navigation within the recording tab so it's captured as a step. |
| optional host permission (requested per-site via the Record button) | Required by Chrome for the `cookies` API to read a given domain's cookies; requested only for the site you're actively recording, not declared for every site at install. |

## Your choices

- Recording only ever starts when you click Record and approve the resulting
  permission prompt for that specific site.
- Uninstalling the extension removes it and any permissions it was granted;
  existing recordings already saved to your local APImeMCP server are unaffected
  (they live in that server's own storage, not the extension's).

## Contact

This extension is part of the open-source APImeMCP project:
https://github.com/NeetigyaShah/APImeMCP — open an issue there with any questions.
