# AURA card reference

The voice persona keeps only the common `status` card inline. This file holds the full card catalogue, the update/dismiss/clear + thread-label endpoints, and how card taps return to you.

Post every card to YOUR OWN talk session id (`<YOUR_OWN_SESSION_ID>` from your "Current session" context) — the card surface belongs to the voice session the operator is watching, NOT the COO child.

## Pushing & updating
- Push: `POST <GATEWAY_URL>/api/talk/card` with body `{"sessionId":"<YOUR_OWN_SESSION_ID>","card":{…}}`. Every card needs a stable string `id` and a `type`. Re-post the SAME id to update it in place (e.g. bump a status from running to done).
- Patch one card: `POST <GATEWAY_URL>/api/talk/card/update` body `{"sessionId":"<YOUR_OWN_SESSION_ID>","cardId":"<id>","patch":{…}}`.
- Drop one card: `POST <GATEWAY_URL>/api/talk/card/dismiss` body `{"sessionId":"<YOUR_OWN_SESSION_ID>","cardId":"<id>"}`.
- Wipe the surface for a fresh topic: `POST <GATEWAY_URL>/api/talk/card/clear` body `{"sessionId":"<YOUR_OWN_SESSION_ID>"}`.

## Content card types
- **status** — a delegated job in flight: `{"id":"…","type":"status","label":"Content pipeline","progress":0.4,"state":"running","chips":["phase 2"]}` (`state`: queued|running|done|error, `progress` 0..1).
- **agent-activity** — several employees working at once: `{"id":"…","type":"agent-activity","title":"…","agents":[{"id":"a1","name":"content-lead","role":"writer","status":"running","detail":"drafting","progress":0.5}]}`.
- **list** — an enumeration: `{"id":"…","type":"list","title":"…","ordered":false,"items":[{"text":"item","done":false}]}`.
- **stat** — a single metric: `{"id":"…","type":"stat","value":"$3.4K","label":"MRR","delta":{"dir":"up","value":"+12%"}}` (`dir`: up|down|flat).
- **link** — a URL: `{"id":"…","type":"link","url":"https://…","label":"Open dashboard","source":"optional host"}`.
- **text** — a short explanation easier read than heard: `{"id":"…","type":"text","title":"OPTIONAL EYEBROW","body":"prose","tldr":"optional one-liner"}`.
- **image** / **image-grid** — visuals: `{"id":"…","type":"image","src":"https://…","alt":"…","caption":"…"}` and `{"id":"…","type":"image-grid","images":[{"src":"https://…","alt":"…"}]}`.

## Decision card types (interactive — the operator taps; the tap returns to you as a message)
- **choice** — two or more viable paths: `{"id":"deploy-where","type":"choice","prompt":"Where to deploy?","options":[{"id":"prod","label":"Production","detail":"live users","badge":"RISKY"},{"id":"staging","label":"Staging","detail":"safe"}]}`
- **approval** — ALWAYS for a side-effectful or irreversible action (send, deploy, payment, delete, publish); never act on voice alone: `{"id":"send-email","type":"approval","summary":"Send the draft email?","details":[{"k":"To","v":"client@example.com"},{"k":"Subject","v":"Proposal v2"}],"confirmLabel":"Send it","rejectLabel":"Hold","danger":true}`
- **comparison** — the call hinges on a few attributes side by side: `{"id":"plans","type":"comparison","columns":["Free","Pro"],"rows":[{"label":"Price","cells":["$0","$12"]},{"label":"Seats","cells":["1","5"],"highlight":1}]}`
- **keyvalue** — a compact readout: `{"id":"health","type":"keyvalue","rows":[{"k":"Uptime","v":"99.9%","tone":"good"},{"k":"Errors","v":"3","tone":"bad"}]}`
- **diff** — a before/after change: `{"id":"cfg","type":"diff","hunks":[{"label":"config value","before":"old value","after":"new value"}]}`

## Reading a tap back
A tap arrives as a normal user message you must interpret, then act on in one short spoken line:
- `[card-action card=<id> action=approve] …` → approved → proceed with / tell the COO to execute the prepared action.
- `[card-action card=<id> action=reject] …` → declined → do NOT execute; acknowledge and stop.
- `[card-action card=<id> action=choose option=<optionId>] …` → he picked that option → continue down that path (route the follow-up to the right COO thread).

Once acted on, update or clear the card (re-post the same `id`, or clear the surface).

## Naming a thread
Give a COO child a clean 1–3 word topic so it's recognisable on screen:
`POST <GATEWAY_URL>/api/talk/thread/label` body `{"sessionId":"<YOUR_OWN_SESSION_ID>","threadId":"<COO_SESSION_ID>","label":"Research"}` — `sessionId` is your own (the surface); `threadId` is the COO child's id.

## List your threads
`GET <GATEWAY_URL>/api/sessions/<YOUR_OWN_SESSION_ID>/children`.
