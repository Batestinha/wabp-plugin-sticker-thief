# Sticker Thief (`official.sticker-thief`)

A WABP plugin that quietly saves every new sticker shared in managed groups and
sends them privately to members who ask for them, either on a daily or weekly
subscription or on demand.

Requires WABP core API `^0.3.15` (the `message.sendSticker` action).

## Commands

All commands work in the group or in a private chat with the bot. In a private
chat the bot works out which of your groups you mean (and asks if there is more
than one); add `--chat <name>` to pick one directly.

| Command | Who | What it does |
| --- | --- | --- |
| `/stickers subscribe [daily\|weekly]` | any current member | Private digest of new stickers on that cadence (default from config). |
| `/stickers unsubscribe` | any current member | Stop the digest. |
| `/stickers status` | any current member | Stickers collected, how many are new for you, next digest. |
| `/stickers send [n]` | any current member | Send the next *n* stickers you have not had yet, privately. |
| `/stickers random [n]` | any current member | Send *n* random stickers from the collection, privately. |
| `/stickers resend [n]` | any current member | Send again the *n* stickers you most recently received (all of them without a number), e.g. when a delivery did not come through. |
| `/stickers forget` (as a reply to a sticker) | `sticker-thief.manage` | Remove that sticker here and never collect it again. |

## Behaviour

- **Collection** is silent. Only live group stickers in WebP format are kept;
  the bot's own stickers, history replays, Lottie stickers and files above
  `maxStickerBytes` are skipped. Files are stored once by SHA-256 in the plugin
  media store, however many groups share them.
- **Privacy boundary**: stickers are delivered only to current members of the
  scope they were collected in. A subscriber who leaves is unsubscribed at the
  next digest.
- **Digests** are self-rescheduling `sticker-thief.digest` jobs that keep their
  time of day and skip slots missed while the bot was down. Each sends a short
  header plus up to `digestSize` stickers the member has not received yet.
  Nothing is sent when the scope is in `OBSERVE` mode.
- Deliveries arrive as native sticker packs of up to 60 (still and animated apart). Stickers outside WhatsApp's pack rules are resized and recompressed by the bot to fit them (512×512, at most 100 KB still or 500 KB animated; animated ones may lose some frames). Leftovers of 1–2 are sent individually. Turn `deliverAsPacks` off to send everything individually.
- Every send carries a per-request idempotency key, so repeated requests always deliver.
- **Bot favourites**: every collected sticker (including archive imports) is added to the bot account's favourite stickers, 20 at a time, so it shows under Favourites on the bot account's phone and linked devices. WhatsApp syncs favourites, not installed packs, across an account's devices. `/stickers forget` removes the sticker from the favourites too. When WhatsApp refuses a favourite write (typically while it waits for the phone to repair the favourites list), the plugin retries with doubling delays from 5 minutes up to an hour instead of failing the job. Needs WABP core API 0.3.20.
- **Console gallery**: the Sticker Thief settings page in the operator console shows every collected sticker as its image or animation, which ones are favourited or still waiting, why favourites are waiting (and when the next retry is), and the favourites switch. Needs WABP core API 0.3.21 (plugin console operations `stickerGallery` and `stickerImage`).

## Configuration (per scope)

| Path | Default | |
| --- | --- | --- |
| `enabled` | `false` | Master switch. |
| `collect` | `true` | Save new stickers. |
| `includeAnimated` | `true` | Also send animated stickers. |
| `maxStickerBytes` | `1048576` | Larger stickers are not collected. |
| `digestSize` | `0` | Most stickers per digest; `0` sends every new sticker. |
| `manualSendLimit` | `0` | Stickers per `send`/`random` without a number; `0` sends all of them. |
| `deliverAsPacks` | `true` | Send deliveries as native sticker packs of up to 60. |
| `backfillArchive` | `true` | Also import stickers already stored in the chat archive. |
| `favoriteOnBotAccount` | `true` | Add collected stickers to the bot account's favourite stickers. |
| `defaultCadence` | `daily` | Cadence when `subscribe` has no argument. |

## Development

```sh
npm ci --ignore-scripts
npm test              # build + node:test suites
npm run metadata      # regenerate wa-plugin.json from the compiled manifest
npm run release:archive
```

`vendor/` pins the WABS SDK built from `packages/plugin-sdk` of the WABP commit
recorded in `provenance.json`.
